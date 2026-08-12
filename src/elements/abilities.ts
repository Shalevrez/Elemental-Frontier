/**
 * Runtime behaviour for all eight active abilities.
 *
 * Abilities no longer hardcode their own upgrades. Instead they ask the build
 * for *behaviour grants* (`split`, `gust-double`, `dash-tornado`, ...) and for
 * stat modifiers, so a new reward that grants an existing behaviour needs no
 * change here. Statuses and elemental reactions are applied centrally in
 * `damageEnemy`, which keeps every source of damage consistent.
 */

import * as THREE from 'three';
import type { ElementId } from './affinity';
import { ELEMENTS, abilitiesOf, abilityForSlot } from './elements';
import type { Player } from '../player/Player';
import type { World } from '../world/World';
import type { EnemyManager, Enemy } from '../combat/Enemies';
import type { Projectiles } from '../combat/Projectiles';
import type { Particles } from '../fx/Particles';
import type { Decals } from '../fx/Decals';
import type { AudioEngine } from '../audio/AudioEngine';
import type { BuildState } from '../progression/BuildState';
import type { StatModifiers } from '../progression/upgrades';
import type { TerrainEffects } from '../world/deformation';
import type { ChargeSource } from '../progression/ultimate';
import { durationModifier, resolveReaction, type ReactionElement, type StatusId } from '../combat/status';
import { Mat } from '../world/materials';
import { abilityCombat, STATUS_TUNING } from '../combat/combatConfig';
import {
  DamageIntervalTracker, hasLineOfSight, resolveAim,
  type AimCandidate, type AimSolution, type AimWorld,
} from '../combat/aiming';
import {
  capsuleVsCapsule, coneVsCapsule, vec, type Capsule, type Vec3,
} from '../combat/hitVolumes';
import { SEA_LEVEL } from '../world/coords';
import {
  cooldownFraction, createCooldown, effectiveCooldown, isReady, startCooldown, tickCooldown,
  type CooldownState,
} from '../core/cooldown';

/**
 * What a hit actually did, so the crosshair can say something more useful than
 * "you hit it".
 */
export type HitOutcome =
  | 'normal' | 'crit' | 'status' | 'blocked' | 'resist' | 'immune' | 'kill';

/** Below this damage multiplier a creature counts as resistant. */
const RESIST_THRESHOLD = 0.85;
/** Below this it is effectively immune and the player should be told plainly. */
const IMMUNE_THRESHOLD = 0.2;

/** Slots that spend Mana. The Ultimate spends the Ultimate meter instead. */
export type AbilitySlot = 'primary' | 'secondary' | 'technique';
export type UseResult = 'ok' | 'cooldown' | 'energy' | 'blocked';

export interface AbilityContext {
  player: Player;
  world: World;
  enemies: EnemyManager;
  projectiles: Projectiles;
  particles: Particles;
  decals: Decals;
  audio: AudioEngine;
  build: BuildState;
  /**
   * Aggregated stat modifiers: the permanent build combined with whatever
   * timed blessings are running. Falls back to the build alone when absent.
   */
  modifiers?(): Readonly<StatModifiers>;
  /** Behaviour-grant lookup across the build and any timed blessings. */
  grant?(tag: string): number;
  /** Ground effects created by combat - burning ground, ice, steam, smoke. */
  effects?: TerrainEffects;
  /** Feed the Ultimate meter. */
  charge?(source: ChargeSource, magnitude?: number): void;
  /** Register a hit for the Ultimate combo counter. */
  comboHit?(): void;
  /** Return Mana to the player, e.g. from a terrain-ability refund. */
  refundMana?(amount: number): void;
  /** Damage multiplier from the affinity itself (focused builds hit harder). */
  affinityBonus(): number;
  flash(color: number, strength: number): void;
  hitMarker(crit: boolean): void;
  /** Immediate, differentiated confirmation of what a hit did. */
  confirmHit(outcome: HitOutcome): void;
  toast(message: string, tone?: 'good' | 'warn' | 'bad'): void;
  dealtDamage(): void;
  /** Freeze the frame briefly for weighty impacts. */
  hitStop(seconds: number): void;
  /** Spawn a short-lived dynamic light. */
  pulseLight(x: number, y: number, z: number, color: number, intensity: number, seconds: number): void;
  /** Heal the player from lifesteal. */
  lifesteal(amount: number): void;
  /** Report a combat event to the debug overlay (no-op when disabled). */
  debug?(event: CombatDebugEvent): void;
}

/** One line of combat-debug telemetry. */
export interface CombatDebugEvent {
  kind: 'aim' | 'hit' | 'miss' | 'volume';
  ability: string;
  origin?: Vec3;
  target?: Vec3;
  radius?: number;
  damage?: number;
  status?: string;
  reason?: string;
  enemyId?: number;
}

const ICE_SECONDS = 18;
const WALL_SECONDS = 11;

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3();
const _scratch: Enemy[] = [];
const _scratch2: Enemy[] = [];

export class AbilitySystem {
  private readonly cooldowns = new Map<string, CooldownState>();
  /** Rampage stacks from the `rampage` grant. */
  private rampage = 0;
  private rampageTimer = 0;
  /** Pending delayed casts, used by `gust-double` and `whip-return`. */
  private delayed: { at: number; run: () => void }[] = [];
  private clock = 0;
  /** Power multiplier for the cast in flight (a weakened fallback primary). */
  private castPower = 1;
  /** Mana charged for the last successful cast. */
  private lastCost = 0;

  /**
   * Sustained Ultimate fields: Maelstrom, Inferno and Cyclone all persist for a
   * few seconds, damaging and controlling on a fixed interval rather than in a
   * single frame. They are advanced by `update`, so they keep running while the
   * player moves and fights.
   */
  private fields: UltimateField[] = [];

  /** The Water Whip stream while it is being held out. */
  private stream: {
    elapsed: number;
    duration: number;
    scale: number;
    boost: number;
  } | null = null;
  /** Stops a continuous attack from damaging the same target every frame. */
  private readonly ticks = new DamageIntervalTracker();
  /** Adapter that lets the aiming code query terrain. */
  private readonly aimWorld: AimWorld;
  /** Reusable candidate list so aiming allocates nothing per frame. */
  private candidates: AimCandidate[] = [];
  /** Last resolved aim, exposed for the crosshair and the debug overlay. */
  lastAim: AimSolution | null = null;

  constructor(private readonly ctx: AbilityContext) {
    this.aimWorld = {
      raycastDistance: (origin, direction, maxDistance) => {
        _rayOrigin.set(origin.x, origin.y, origin.z);
        _rayDir.set(direction.x, direction.y, direction.z);
        const hit = this.ctx.world.raycast(_rayOrigin, _rayDir, maxDistance);
        return hit ? hit.distance : null;
      },
    };
    for (const el of Object.values(ELEMENTS)) {
      for (const ability of abilitiesOf(el.id)) {
        this.cooldowns.set(ability.id, createCooldown());
      }
    }
  }

  // -------------------------------------------------- modifier accessors

  /** Build modifiers combined with any timed blessings. */
  private get mods(): Readonly<StatModifiers> {
    return this.ctx.modifiers?.() ?? this.ctx.build.modifiers;
  }

  /** Total stacks of a behaviour grant, across the build and active buffs. */
  private g(tag: string): number {
    return this.ctx.grant?.(tag) ?? this.ctx.build.grant(tag);
  }

  private hasG(tag: string): boolean {
    return this.g(tag) > 0;
  }

  /** Feed the Ultimate meter, when the game wired one up. */
  private charge(source: ChargeSource, magnitude = 1): void {
    this.ctx.charge?.(source, magnitude);
  }

  update(dt: number): void {
    this.clock += dt;
    for (const cd of this.cooldowns.values()) tickCooldown(cd, dt);
    if (this.stream) this.tickStream(dt);
    if (this.fields.length > 0) this.tickFields(dt);

    if (this.rampageTimer > 0) {
      this.rampageTimer -= dt;
      if (this.rampageTimer <= 0) this.rampage = 0;
    }

    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const entry = this.delayed[i]!;
      if (entry.at <= this.clock) {
        this.delayed.splice(i, 1);
        entry.run();
      }
    }
  }

  reset(): void {
    for (const cd of this.cooldowns.values()) {
      cd.remaining = 0;
      cd.duration = 0;
    }
    this.rampage = 0;
    this.rampageTimer = 0;
    this.delayed.length = 0;
    this.stream = null;
    this.fields.length = 0;
    this.ticks.clear();
  }

  /** True while a continuous cast is in progress. */
  get casting(): boolean {
    return this.stream !== null;
  }

  // ------------------------------------------------------------- aiming

  /**
   * Where the effect visually leaves the player: slightly forward, to the
   * casting side and a little below the eye, so abilities read as coming from
   * a hand rather than from the middle of the screen.
   */
  private castOrigin(out: THREE.Vector3): THREE.Vector3 {
    const p = this.ctx.player;
    p.getForward(_fwd);
    _side.crossVectors(_fwd, _up).normalize();
    return out.copy(p.eyePosition)
      .addScaledVector(_fwd, 0.35)
      .addScaledVector(_side, 0.26)
      .addScaledVector(_up, -0.16);
  }

  /** Live creatures the aim assist may consider. */
  private aimCandidates(): AimCandidate[] {
    this.candidates.length = 0;
    for (const e of this.ctx.enemies.live) {
      if (!e.alive) continue;
      this.candidates.push({
        id: e.uid,
        capsule: e.hitCapsule(),
        centre: e.centreVec(vec()),
      });
    }
    return this.candidates;
  }

  /**
   * Resolve the shot.
   *
   * The direction always ends up pointing from the casting hand to whatever
   * the *crosshair* selected, which is what makes "it looked like a hit" and
   * "it was a hit" the same thing.
   */
  private aim(range: number, assist = true): AimSolution {
    const p = this.ctx.player;
    p.getForward(_fwd);
    this.castOrigin(_origin);
    const eye = p.eyePosition;
    const solution = resolveAim(
      { x: eye.x, y: eye.y, z: eye.z },
      { x: _fwd.x, y: _fwd.y, z: _fwd.z },
      range,
      this.aimWorld,
      this.aimCandidates(),
      { x: _origin.x, y: _origin.y, z: _origin.z },
      assist,
    );
    this.lastAim = solution;
    return solution;
  }

  /**
   * Resolve the crosshair without firing anything.
   *
   * The HUD calls this every frame so the aim state shown to the player is
   * produced by exactly the same code that decides where a shot goes.
   */
  probeAim(range: number): AimSolution {
    const p = this.ctx.player;
    p.getForward(_fwd);
    const eye = p.eyePosition;
    return resolveAim(
      { x: eye.x, y: eye.y, z: eye.z },
      { x: _fwd.x, y: _fwd.y, z: _fwd.z },
      range, this.aimWorld, this.aimCandidates(),
      { x: eye.x, y: eye.y, z: eye.z }, false,
    );
  }

  /** Body capsules plus whether each is in line of sight, for the debug view. */
  debugHitboxes(out: { id: number; capsule: Capsule; visible: boolean }[]):
  { id: number; capsule: Capsule; visible: boolean }[] {
    out.length = 0;
    const eye = this.ctx.player.eyePosition;
    for (const e of this.ctx.enemies.live) {
      if (!e.alive) continue;
      out.push({ id: e.uid, capsule: e.hitCapsule(), visible: this.visible(e, eye) });
    }
    return out;
  }

  /** Can this attack legally reach the creature? Used by the crosshair. */
  private visible(e: Enemy, from: THREE.Vector3): boolean {
    e.centreVec(_probeA);
    return hasLineOfSight({ x: from.x, y: from.y, z: from.z }, _probeA, this.aimWorld);
  }

  get rampageStacks(): number {
    return this.rampage;
  }

  private later(seconds: number, run: () => void): void {
    this.delayed.push({ at: this.clock + seconds, run });
  }

  // ------------------------------------------------------------- queries

  fraction(element: ElementId, slot: AbilitySlot): number {
    const cd = this.cooldowns.get(abilityForSlot(element, slot).id);
    return cd ? cooldownFraction(cd) : 0;
  }

  /** Seconds of cooldown left, for the HUD readout. */
  remaining(element: ElementId, slot: AbilitySlot): number {
    const cd = this.cooldowns.get(abilityForSlot(element, slot).id);
    return cd ? Math.max(0, cd.remaining) : 0;
  }

  ready(element: ElementId, slot: AbilitySlot): boolean {
    const cd = this.cooldowns.get(abilityForSlot(element, slot).id);
    return cd ? isReady(cd) : true;
  }

  costOf(element: ElementId, slot: AbilitySlot): number {
    return abilityForSlot(element, slot).cost * this.mods.costScale;
  }

  affordable(element: ElementId, slot: AbilitySlot): boolean {
    return this.ctx.player.energy >= this.costOf(element, slot);
  }

  /**
   * Fire an ability.
   *
   * `costOverride` lets the Mana system charge a reduced fallback price for a
   * weakened primary, and `powerScale` weakens the cast to match, so a player
   * who is nearly out of Mana still has something to do.
   */
  use(element: ElementId, slot: AbilitySlot, costOverride?: number, powerScale = 1): UseResult {
    const def = abilityForSlot(element, slot);
    const cd = this.cooldowns.get(def.id)!;
    if (!isReady(cd)) return 'cooldown';
    const cost = costOverride ?? this.costOf(element, slot);
    if (this.ctx.player.energy < cost) return 'energy';

    this.castPower = powerScale;
    const result = this.cast(def.id);
    this.castPower = 1;
    if (result !== 'ok') return result;

    this.ctx.player.spend(cost);
    this.lastCost = cost;

    // Rampage: repeated fire hits shorten the next cooldown.
    const speed = 1 - Math.min(0.4, this.rampage * 0.08);
    const scale = this.ctx.player.stats.cooldownScale
      * this.mods.cooldownScale
      * speed;
    startCooldown(cd, effectiveCooldown(def.cooldown, scale));

    // `echo-cast`: a chance to fire the same ability again for free.
    const echo = this.g('echo-cast');
    if (echo > 0 && Math.random() < 0.18 * echo) {
      this.later(0.12, () => { this.cast(def.id); });
    }
    return 'ok';
  }

  /** Mana actually charged for the last successful cast. */
  get lastCastCost(): number {
    return this.lastCost;
  }

  /**
   * Fire the element's Ultimate.
   *
   * The caller is responsible for the meter: this only refuses when the
   * ability itself cannot run (no ground under a Tectonic Rupture, say).
   */
  useUltimate(element: ElementId): UseResult {
    const def = ELEMENTS[element].ultimate;
    switch (def.id) {
      case 'maelstrom': return this.maelstrom();
      case 'inferno': return this.inferno();
      case 'tectonic-rupture': return this.tectonicRupture();
      case 'cyclone': return this.cyclone();
      default: return 'blocked';
    }
  }

  /** True while an Ultimate field is still running. */
  get ultimateActive(): boolean {
    return this.fields.length > 0;
  }

  private cast(id: string): UseResult {
    switch (id) {
      case 'gust': this.gust(); return 'ok';
      case 'air-dash': return this.airDash();
      case 'air-blades': this.airBlades(); return 'ok';
      case 'water-whip': this.waterWhip(); return 'ok';
      case 'freeze': this.freeze(); return 'ok';
      case 'tidal-pull': this.tidalPull(); return 'ok';
      case 'rock-shot': this.rockShot(); return 'ok';
      case 'raise-wall': return this.raiseWall();
      case 'seismic-slam': return this.seismicSlam();
      case 'fireball': this.fireball(); return 'ok';
      case 'flame-wave': this.flameWave(); return 'ok';
      case 'flame-dash': this.flameDash(); return 'ok';
      default: return 'blocked';
    }
  }

  // ------------------------------------------------------------- damage

  /** Element-specific damage after every multiplier. */
  private power(base: number, element: ElementId): number {
    const p = this.ctx.player;
    const m = this.mods;
    const perElement = element === 'fire' ? m.fireScale
      : element === 'water' ? m.waterScale
        : element === 'earth' ? m.earthScale : m.airScale;

    let value = base
      * p.stats.powerScale
      * p.firePassiveMultiplier()
      * m.damageScale
      * perElement
      * this.castPower
      * this.ctx.affinityBonus();

    // `last-stand`: fire builds get fiercer as health drops.
    if (element === 'fire' && this.hasG('last-stand')) {
      const frac = p.maxHealth > 0 ? p.health / p.maxHealth : 1;
      if (frac < 0.5) value *= 1 + (0.5 - frac) * 1.2;
    }
    // `speed-damage`: air scales with how fast the player is moving.
    if (element === 'air' && this.hasG('speed-damage')) {
      const speed = Math.hypot(p.velocity.x, p.velocity.z);
      value *= 1 + Math.min(0.6, speed / 18) * this.g('speed-damage');
    }
    return value;
  }

  private rollCrit(): boolean {
    const chance = this.mods.critChance;
    return chance > 0 && Math.random() < chance;
  }

  /**
   * The single funnel every player-sourced hit goes through - including
   * projectile impacts, which the game routes here so a Fireball landing on a
   * frozen target melts it exactly like a Flame Wave would.
   *
   * Handles crits, elemental reactions, status application, lifesteal, hit
   * feedback and the behaviour grants that key off damage.
   */
  hitEnemy(
    e: Enemy,
    amount: number,
    element: ElementId,
    kb: THREE.Vector3 | null,
    stagger = 0,
    status?: { id: StatusId; seconds: number; magnitude?: number },
    hitPoint?: THREE.Vector3 | null,
  ): number {
    const m = this.mods;
    const crit = this.rollCrit();
    // Executioner-style tradeoffs cut the damage of a *normal* hit only, so a
    // crit build keeps its ceiling while its floor drops.
    let value = amount * (crit ? m.critScale : m.normalHitScale);

    // Weak points: a shot into an exposed core, a cracked seam or a soft
    // underside is worth far more than one into the armour.
    let weakPoint = false;
    if (hitPoint) {
      const bonus = e.weakPointBonus(hitPoint.x, hitPoint.y, hitPoint.z);
      if (bonus > 1) {
        value *= bonus;
        weakPoint = true;
      }
    }

    // `deep-current`: wet targets are far more fragile.
    if (this.hasG('deep-current') && e.status.has('wet')) value *= 1.35;

    // Elemental reaction, if the target already carries a matching status.
    const reaction = resolveReaction(element as ReactionElement, e.status);
    if (reaction) {
      value *= 1 + reaction.bonusDamage;
      for (const id of reaction.removes) e.status.remove(id);
      for (const add of reaction.adds) {
        e.status.apply(add.id, (add.seconds ?? undefined), add.magnitude ?? 0);
      }
      this.reactionEffect(reaction.id, e, value);
    }

    const resistance = e.resistanceTo(element);
    if (kb) kb.multiplyScalar(m.knockback);
    const wasAlive = e.alive;
    const dealt = e.damage(value, element, kb, stagger);
    if (dealt <= 0) {
      // Nothing got through at all - say so instead of staying silent.
      this.ctx.confirmHit('immune');
      return 0;
    }
    if (e.lastHitBlocked) {
      this.ctx.confirmHit('blocked');
      this.ctx.dealtDamage();
      return dealt;
    }

    // Status the attack itself applies.
    if (status) {
      const seconds = status.seconds * m.statusDuration * durationModifier(status.id, e.status);
      e.status.apply(status.id, seconds, (status.magnitude ?? 0) * m.statusPower);
      this.charge('status-applied');
    }

    // ---- Ultimate charge and Mana economy, fed only by real combat.
    this.charge('damage-dealt', dealt);
    this.ctx.comboHit?.();
    this.charge('combo');
    if (m.manaOnHit > 0) this.ctx.refundMana?.(m.manaOnHit);
    if (wasAlive && !e.alive) {
      this.charge('enemy-defeated');
      if (m.manaOnKill > 0) this.ctx.refundMana?.(m.manaOnKill);
    }

    // `rampage`: fire hits stack attack speed briefly.
    if (element === 'fire' && this.hasG('rampage')) {
      this.rampage = Math.min(5, this.rampage + 1);
      this.rampageTimer = 3;
    }

    // `crit-spread`: crits smear Burning onto the neighbours.
    if (crit && this.hasG('crit-spread')) {
      for (const other of this.ctx.enemies.within(e.center, 6, _scratch2)) {
        if (other === e) continue;
        other.status.apply('burning', 3 * m.statusDuration, dealt * 0.12);
      }
    }

    // `bounce`: water attacks leap onward.
    if (element === 'water' && this.hasG('bounce') && !kb) {
      const hops = this.g('bounce');
      let hopped = 0;
      for (const other of this.ctx.enemies.within(e.center, 7, _scratch2)) {
        if (other === e || hopped >= hops) continue;
        hopped++;
        other.damage(dealt * 0.5, 'water', null, 0);
      }
    }

    // `wall-slam-stun`: enemies driven into terrain are stunned and hurt.
    if (kb && this.hasG('wall-slam-stun')) {
      _to.copy(e.pos).addScaledVector(kb, 0.12);
      if (this.ctx.world.isSolid(_to.x, _to.y + 0.8, _to.z)) {
        e.status.apply('stunned', 1.2 * m.statusDuration);
        e.damage(dealt * 0.4, element, null, 0);
        this.ctx.particles.debris({
          count: 12, x: e.pos.x, y: e.pos.y + 0.8, z: e.pos.z, spread: 0.5,
          jitter: 4, color: 0x8a6440, size: 0.2, life: 0.7, gravity: -12, drag: 0.7,
        });
      }
    }

    const steal = m.lifesteal;
    if (steal > 0) this.ctx.lifesteal(dealt * steal);

    // One confirmation per hit, ranked most-informative first.
    const outcome: HitOutcome = wasAlive && !e.alive ? 'kill'
      : resistance <= IMMUNE_THRESHOLD ? 'immune'
        : resistance < RESIST_THRESHOLD ? 'resist'
          : (crit || weakPoint) ? 'crit'
            : (status || reaction) ? 'status'
              : 'normal';
    this.ctx.confirmHit(outcome);
    this.ctx.dealtDamage();
    if (weakPoint) {
      this.ctx.toast(`Weak point · ${e.type.weakPointName ?? 'exposed'}`, 'good');
      this.ctx.hitStop(0.05);
    }
    if (crit) this.ctx.hitStop(0.045);
    return dealt;
  }

  /** Internal alias kept for readability at the ability call sites. */
  private damageEnemy(
    e: Enemy,
    amount: number,
    element: ElementId,
    kb: THREE.Vector3 | null,
    stagger = 0,
    status?: { id: StatusId; seconds: number; magnitude?: number },
  ): number {
    return this.hitEnemy(e, amount, element, kb, stagger, status);
  }

  /** Visual and mechanical payload of an elemental reaction. */
  private reactionEffect(id: string, e: Enemy, damage: number): void {
    const c = e.center;
    switch (id) {
      case 'steam':
      case 'melt':
        this.ctx.particles.spark({
          count: 34, x: c.x, y: c.y, z: c.z, spread: 0.7, jitter: 3.2, vy: 2.6,
          color: 0xe8f4ff, color2: 0xffffff, size: 0.45, life: 1.2, gravity: 1.6, drag: 1.2,
        });
        this.ctx.toast('Steam', 'good');
        break;
      case 'extinguish':
        this.ctx.particles.spark({
          count: 22, x: c.x, y: c.y, z: c.z, spread: 0.6, jitter: 2.4, vy: 2,
          color: 0xd8e8f0, size: 0.4, life: 0.9, gravity: 1.4, drag: 1.3,
        });
        break;
      case 'shatter': {
        this.ctx.audio.play('impact', 40);
        this.ctx.hitStop(0.07);
        this.ctx.particles.debris({
          count: 34, x: c.x, y: c.y, z: c.z, spread: 0.6, jitter: 7,
          color: 0xbfe8ff, color2: 0xffffff, size: 0.24, life: 1, gravity: -12, drag: 0.5,
        });
        // `shatter-nova`: breaking ice hurts everything nearby.
        const nova = this.g('shatter-nova');
        if (nova > 0) {
          for (const other of this.ctx.enemies.within(c, 5 + nova, _scratch2)) {
            if (other === e) continue;
            other.damage(damage * 0.4 * nova, 'water', null, 0.2);
          }
        }
        break;
      }
      case 'spread-fire': {
        for (const other of this.ctx.enemies.within(c, 6, _scratch2)) {
          if (other === e) continue;
          other.status.apply('burning', 3, damage * 0.1);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- AIR

  private gust(): void {
    this.gustBurst();
    // `gust-double`: a second clap follows a beat later.
    if (this.g('gust-double') > 0) this.later(0.22, () => this.gustBurst(0.7));
  }

  private gustBurst(scale = 1): void {
    const { player, enemies, particles, projectiles, audio } = this.ctx;
    const cfg = abilityCombat('gust');
    const tempest = this.hasG('tempest');
    const range = (tempest ? cfg.range * 1.3 : cfg.range) * scale;
    const halfAngle = tempest ? cfg.coneHalfAngle! * 1.3 : cfg.coneHalfAngle!;
    const cosHalf = Math.cos(halfAngle);

    const solution = this.aim(range, false);
    this.castOrigin(_origin);
    _dir.set(solution.direction.x, solution.direction.y, solution.direction.z);

    audio.play('gust');
    this.ctx.flash(ELEMENTS.air.color, 0.16 * scale);
    player.addShake(0.1 * scale, 9);
    this.ctx.pulseLight(
      _origin.x + _dir.x * 3, _origin.y + _dir.y * 3, _origin.z + _dir.z * 3,
      ELEMENTS.air.color, 4, 0.18,
    );

    // Curved wind ribbons that fan along the real cone.
    for (let i = 0; i < 52; i++) {
      const t = i / 52;
      const swirl = t * Math.PI * 3.4;
      const radius = 0.3 + t * 2.8;
      const ox = Math.cos(swirl) * radius;
      const oy = Math.sin(swirl) * radius * 0.6;
      const rx = ox * Math.cos(player.yaw);
      const rz = -ox * Math.sin(player.yaw);
      particles.spark({
        count: 1,
        x: _origin.x + _dir.x * (t * range * 0.8) + rx,
        y: _origin.y + _dir.y * (t * range * 0.8) + oy,
        z: _origin.z + _dir.z * (t * range * 0.8) + rz,
        vx: _dir.x * 15 + rx * 1.6, vy: _dir.y * 15 + oy * 1.6, vz: _dir.z * 15 + rz * 1.6,
        jitter: 1.4, color: 0xffffff, color2: ELEMENTS.air.color,
        size: 0.32, life: 0.45, lifeJitter: 0.4, gravity: 1.2, drag: 1.6,
      });
    }

    // Cone test against each body capsule, with line of sight.
    _originV.x = _origin.x; _originV.y = _origin.y; _originV.z = _origin.z;
    _dirV.x = _dir.x; _dirV.y = _dir.y; _dirV.z = _dir.z;
    let struck = 0;
    for (const e of enemies.live) {
      if (!e.alive) continue;
      if (!coneVsCapsule(_originV, _dirV, range, cosHalf, e.hitCapsule())) continue;
      if (!this.visible(e, _origin)) {
        this.ctx.debug?.({ kind: 'miss', ability: 'gust', reason: 'blocked', enemyId: e.uid });
        continue;
      }
      _kb.copy(e.center).sub(_origin).normalize()
        .multiplyScalar(this.power(cfg.knockback, 'air') * (1 - e.pos.distanceTo(_origin) / range * 0.5));
      this.damageEnemy(e, this.power(cfg.damage, 'air') * scale, 'air', _kb, cfg.stagger);
      struck++;
      particles.spark({
        count: 12, x: e.center.x, y: e.center.y, z: e.center.z, spread: 0.5,
        jitter: 3.4, color: 0xffffff, color2: ELEMENTS.air.color, size: 0.3, life: 0.4, gravity: 1,
      });
    }
    if (struck > 0) audio.play('impact', 60);

    // Air moves the world as well as the creatures in it: smoke and steam are
    // blown clear, and any fire it passes over is fanned wider.
    const ahead = _origin.clone().addScaledVector(_dir, range * 0.6);
    if (this.ctx.effects) {
      const cleared = this.ctx.effects.clearObscurants(ahead.x, ahead.z, range * 0.5);
      const fanned = this.ctx.effects.fanFlames(ahead.x, ahead.z, range * 0.5);
      if (cleared > 0 || fanned > 0) this.charge('terrain');
      if (fanned > 0) this.ctx.toast('The wind spreads the fire', 'warn');
    }

    const reflectToSource = this.hasG('gust-reflect-source');
    const deflected = projectiles.deflect(_origin, _dir, range, cosHalf, 22, reflectToSource);
    if (deflected > 0) {
      this.charge('deflect');
      this.ctx.toast(`Deflected ${deflected} projectile${deflected === 1 ? '' : 's'}`, 'good');
      this.ctx.hitMarker(true);
      audio.play('impact', 40);
    }
    this.ctx.debug?.({
      kind: 'volume', ability: 'gust', origin: { ..._originV }, target: solution.target,
      radius: range, damage: struck,
    });
  }

  private airDash(): UseResult {
    const { player, particles, audio, enemies } = this.ctx;
    const cfg = abilityCombat('air-dash');
    if (!player.onGround && !player.airDashAvailable) return 'blocked';

    player.getForward(_fwd);
    const planar = new THREE.Vector3(player.velocity.x, 0, player.velocity.z);
    const dir = planar.lengthSq() > 1 ? planar.normalize() : new THREE.Vector3(_fwd.x, 0, _fwd.z).normalize();

    const start = player.position.clone();
    player.velocity.x = dir.x * 19;
    player.velocity.z = dir.z * 19;
    player.velocity.y = Math.max(player.velocity.y, player.onGround ? 4.2 : 3.2);
    if (!player.onGround) player.airDashAvailable = false;
    player.dashGrace = 1.6;
    player.falling = false;
    player.fallStartY = player.position.y;
    player.addShake(0.22, 8);

    audio.play('dash');
    this.ctx.flash(ELEMENTS.air.color, 0.24);

    for (let i = 0; i < 36; i++) {
      const t = i / 36;
      particles.spark({
        count: 1,
        x: start.x - dir.x * t * 3.5,
        y: start.y + 0.9 + Math.sin(t * 6) * 0.3,
        z: start.z - dir.z * t * 3.5,
        vx: -dir.x * 5, vy: 0.6, vz: -dir.z * 5, jitter: 1.6,
        color: 0xffffff, color2: ELEMENTS.air.color,
        size: 0.3, life: 0.5, gravity: 0.6, drag: 1.4,
      });
    }

    // `dash-damage`: sweep a capsule along the dash line rather than testing a
    // single point at the end, so nothing is passed straight through.
    const shear = this.g('dash-damage');
    if (shear > 0) {
      this.later(0.08, () => {
        _probeA.x = start.x; _probeA.y = start.y + 0.9; _probeA.z = start.z;
        _probeB.x = player.position.x; _probeB.y = player.position.y + 0.9; _probeB.z = player.position.z;
        const sweep = { a: _probeA, b: _probeB, radius: cfg.radius };
        for (const e of enemies.live) {
          if (!e.alive) continue;
          if (!capsuleVsCapsule(sweep, e.hitCapsule())) continue;
          _kb.copy(dir).multiplyScalar(this.power(cfg.knockback, 'air'));
          this.damageEnemy(e, this.power(cfg.damage * shear, 'air'), 'air', _kb, cfg.stagger);
        }
      });
    }

    const tornado = this.g('dash-tornado');
    if (tornado > 0) {
      const centre = start.clone();
      for (let step = 0; step < 6; step++) {
        this.later(step * 0.35, () => {
          particles.spark({
            count: 14, x: centre.x, y: centre.y + 0.8, z: centre.z, spread: 1.6,
            jitter: 2.4, vy: 3.2, color: 0xffffff, color2: ELEMENTS.air.color,
            size: 0.34, life: 0.7, gravity: 1.4, drag: 0.9,
          });
          for (const e of this.ctx.enemies.within(centre, 4.5, _scratch)) {
            _kb.copy(centre).sub(e.pos).setY(0).normalize().multiplyScalar(5);
            this.damageEnemy(e, this.power(3.5 * tornado, 'air'), 'air', _kb, 0);
          }
        });
      }
    }
    return 'ok';
  }

  // -------------------------------------------------------------- WATER

  /**
   * Water Whip is a short controlled stream, not a bullet.
   *
   * Pressing the button opens a cast that lives for ~0.32s. Every frame the
   * stream is a capsule from the casting hand to the crosshair target, tested
   * against full body capsules; each creature can only be damaged once per
   * `damageInterval`, so the stream deals a predictable amount rather than
   * melting whatever it grazes.
   */
  private waterWhip(): void {
    const cfg = abilityCombat('water-whip');
    const nearWater = this.ctx.player.nearWater();
    this.ticks.clear();
    this.stream = {
      elapsed: 0,
      duration: cfg.castTime ?? 0.32,
      scale: 1,
      boost: nearWater ? 1.3 : 1,
    };
    this.ctx.audio.play('whip');
    this.ctx.flash(ELEMENTS.water.color, 0.14);
    // Run the first slice immediately so the very first frame can connect.
    this.tickStream(0);

    if (this.hasG('whip-return')) {
      this.later(cfg.castTime ?? 0.32, () => {
        this.ticks.clear();
        this.stream = {
          elapsed: 0, duration: (cfg.castTime ?? 0.32) * 0.7,
          scale: 0.65, boost: nearWater ? 1.3 : 1,
        };
        this.ctx.audio.play('whip', 40);
      });
    }
  }

  /** Advance the water stream: aim, draw, sweep, damage. */
  private tickStream(dt: number): void {
    const stream = this.stream;
    if (!stream) return;
    const { particles, audio, decals, enemies } = this.ctx;
    const cfg = abilityCombat('water-whip');

    stream.elapsed += dt;
    if (stream.elapsed > stream.duration) {
      this.stream = null;
      return;
    }

    // Re-aim every frame so the stream tracks where the player is looking.
    const solution = this.aim(cfg.range);
    this.castOrigin(_origin);
    _target.set(solution.target.x, solution.target.y, solution.target.z);

    // The stream visually bows, but the *collision* capsule runs straight from
    // the hand to the crosshair target. The bow is a render-only flourish, so
    // what the player aims at is what the stream hits.
    const phase = stream.elapsed / stream.duration;
    _dir.copy(_target).sub(_origin);
    const reach = Math.min(_dir.length(), cfg.range);
    _dir.normalize();
    _side.crossVectors(_dir, _up).normalize();

    const tipDistance = reach * Math.min(1, 0.35 + phase * 1.6);
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const along = t * tipDistance;
      // Bow that flattens as the stream extends toward the target.
      const bow = Math.sin(t * Math.PI) * 0.55 * (1 - phase) * stream.scale;
      particles.spark({
        count: 1,
        x: _origin.x + _dir.x * along + _side.x * bow,
        y: _origin.y + _dir.y * along + _side.y * bow - bow * 0.25,
        z: _origin.z + _dir.z * along + _side.z * bow,
        vx: _dir.x * 4, vy: -1.2, vz: _dir.z * 4, jitter: 0.9,
        color: ELEMENTS.water.color, color2: 0xcbe9ff,
        size: 0.32, life: 0.22, gravity: -3, drag: 1.6,
      });
    }

    // ---- collision: a capsule from the hand to the current stream tip
    _probeA.x = _origin.x; _probeA.y = _origin.y; _probeA.z = _origin.z;
    _probeB.x = _origin.x + _dir.x * tipDistance;
    _probeB.y = _origin.y + _dir.y * tipDistance;
    _probeB.z = _origin.z + _dir.z * tipDistance;
    const volume = { a: _probeA, b: _probeB, radius: cfg.radius };

    const interval = cfg.damageInterval ?? 0.12;
    let struck = 0;
    for (const e of enemies.live) {
      if (!e.alive) continue;
      if (!capsuleVsCapsule(volume, e.hitCapsule())) continue;
      if (!this.visible(e, _origin)) continue;
      // Damage interval protection: never once per frame.
      if (!this.ticks.tryTick(e.uid, this.clock, interval)) continue;

      _kb.copy(e.center).sub(_origin).normalize()
        .multiplyScalar(this.power(cfg.knockback, 'water') * stream.boost);
      this.damageEnemy(
        e,
        this.power(cfg.damage, 'water') * stream.boost * stream.scale * (interval / stream.duration),
        'water', _kb, cfg.stagger,
        { id: 'wet', seconds: STATUS_TUNING.wetSeconds },
      );
      e.applySlow(STATUS_TUNING.whipSlowFactor, STATUS_TUNING.whipSlowSeconds);
      struck++;

      // Splash and droplets on the body itself.
      particles.spark({
        count: 14, x: e.center.x, y: e.center.y, z: e.center.z, spread: 0.45,
        jitter: 3.6, color: ELEMENTS.water.color, color2: 0xffffff,
        size: 0.3, life: 0.5, gravity: -4,
      });
      particles.debris({
        count: 6, x: e.center.x, y: e.center.y, z: e.center.z, spread: 0.4,
        jitter: 3.2, vy: 2.2, color: 0x9fd8ff, size: 0.1, life: 0.5, gravity: -9, drag: 0.9,
      });
      this.ctx.debug?.({
        kind: 'hit', ability: 'water-whip', enemyId: e.uid, status: 'wet',
        damage: this.power(cfg.damage, 'water'),
      });

      // Optional reduced splash onto one neighbour.
      const splashed = enemies.within(e.center, 3, _scratch2);
      for (const other of splashed) {
        if (other === e) continue;
        if (!this.ticks.tryTick(other.uid, this.clock, interval * 2)) continue;
        this.damageEnemy(other, this.power(cfg.damage * 0.3, 'water'), 'water', null, 0,
          { id: 'wet', seconds: STATUS_TUNING.wetSeconds * 0.6 });
        break;
      }
    }
    if (struck > 0) audio.play('splash', 70);

    // Wet the ground where the stream lands.
    if (phase > 0.5 && phase < 0.6) {
      const ground = this.ctx.world.raycast(_target, _down, 6);
      if (ground) {
        decals.add('wet', ground.point.x, ground.point.y, ground.point.z, ground.normal, 2.2, 9, 0.5);
        // Wet ground puts out burning ground and gives Freeze something to
        // work with, which is the two-step Water combo made physical.
        this.ctx.effects?.add(
          'wet', ground.point.x, ground.point.y, ground.point.z,
          2.2 * this.mods.areaScale, 9, 0, 'player',
        );
        // Water meeting lava crusts the surface over into temporary stone.
        if (this.ctx.world.inHazardFluid(ground.point.y)) {
          this.ctx.effects?.quenchLava(ground.point.x, ground.point.z, this.ctx.world.fluidLevel, 2.6);
          this.charge('terrain');
        }
        particles.spark({
          count: 10, x: ground.point.x, y: ground.point.y + 0.2, z: ground.point.z,
          spread: 0.5, vy: 2.4, jitter: 2, color: ELEMENTS.water.color, color2: 0xffffff,
          size: 0.28, life: 0.5, gravity: -5, drag: 1.2,
        });
      }
    }
  }

  private freeze(): void {
    const { world, enemies, particles, audio, decals } = this.ctx;
    const cfg = abilityCombat('freeze');
    // Assist is on here: pointing at a creature must place the burst *on* that
    // creature, not at the maximum range behind it.
    const solution = this.aim(cfg.range);
    _target.set(solution.target.x, solution.target.y, solution.target.z);

    audio.play('freeze');
    this.ctx.flash(0xbfe8ff, 0.3);
    this.ctx.pulseLight(_target.x, _target.y, _target.z, 0xbfe8ff, 6, 0.4);

    let froze = false;
    const groundUnder = world.groundHeight(_target.x, _target.z);
    const overWater = groundUnder < SEA_LEVEL - 0.3 && _target.y < SEA_LEVEL + 2.5;
    if (overWater) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const r = i === 0 ? 0 : 1.7;
        const ok = world.addTemporary({
          x: _target.x + Math.cos(a) * r, y: SEA_LEVEL - 0.35, z: _target.z + Math.sin(a) * r,
          radius: 2.4, strength: 2.6, material: Mat.ICE,
        }, ICE_SECONDS);
        froze = froze || ok;
      }
      if (froze) this.ctx.toast('Ice path formed', 'good');
    }

    // Make the area of effect unmistakable: a ring of frost on the ground plus
    // a burst at the centre. The frost is a real ground effect - it puts out
    // burning ground and makes the surface slippery until it thaws.
    const ground = world.raycast(_target, _down, 8);
    if (ground) {
      decals.add('ice', ground.point.x, ground.point.y, ground.point.z, ground.normal, cfg.radius, 10, 0.75);
      this.ctx.effects?.add(
        'ice', ground.point.x, ground.point.y, ground.point.z,
        cfg.radius * this.mods.areaScale, 12, 0, 'player',
      );
      this.charge('terrain');
    }
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      particles.spark({
        count: 1,
        x: _target.x + Math.cos(a) * cfg.radius, y: _target.y - 0.4, z: _target.z + Math.sin(a) * cfg.radius,
        vy: 2.4, jitter: 0.6, color: 0xbfe8ff, color2: 0xffffff,
        size: 0.34, life: 0.8, gravity: -1.5, drag: 1.2,
      });
    }
    particles.spark({
      count: 52, x: _target.x, y: _target.y, z: _target.z, spread: 1.5,
      jitter: 3.6, color: 0xbfe8ff, color2: 0xffffff, size: 0.4, life: 0.9, gravity: -2, drag: 1.5,
    });

    const glacier = this.hasG('glacier');
    let caught = 0;
    let wetCaught = 0;
    const frozen: Enemy[] = [];
    for (const e of enemies.within(_target, cfg.radius, _scratch)) {
      if (!this.visible(e, _target)) continue;
      // The two-step combo: a soaked target locks up much harder.
      const wasWet = e.status.has('wet');
      if (wasWet) wetCaught++;
      const seconds = (wasWet ? STATUS_TUNING.freezeSecondsWhenWet : STATUS_TUNING.freezeSeconds)
        * (glacier ? 1.7 : 1) * this.mods.statusDuration;

      this.damageEnemy(
        e, this.power(cfg.damage, 'water'), 'water', null, cfg.stagger,
        { id: 'frozen', seconds },
      );
      e.applyFreeze(seconds);
      e.applySlow(0.35, seconds + 2);
      frozen.push(e);
      caught++;
      particles.spark({
        count: 22, x: e.center.x, y: e.center.y, z: e.center.z, spread: 0.6,
        jitter: 1.6, color: 0xbfe8ff, color2: 0xffffff, size: 0.34, life: 1, gravity: -1,
      });
      this.ctx.debug?.({ kind: 'hit', ability: 'freeze', enemyId: e.uid, status: 'frozen' });
    }

    const spread = this.g('freeze-spread');
    if (spread > 0) {
      for (const e of frozen) {
        for (const other of enemies.within(e.center, 4 + spread, _scratch2)) {
          if (frozen.includes(other)) continue;
          other.status.apply('frozen', STATUS_TUNING.freezeSeconds * 0.6);
          other.applyFreeze(STATUS_TUNING.freezeSeconds * 0.6);
        }
      }
    }

    // Freeze must never fail silently: say what happened either way.
    if (caught > 0) {
      audio.play('impact', 60);
      this.ctx.hitMarker(wetCaught > 0);
      this.ctx.toast(
        wetCaught > 0 ? `Flash-froze ${wetCaught} soaked target${wetCaught === 1 ? '' : 's'}` : `Froze ${caught}`,
        'good',
      );
    } else if (!froze) {
      this.ctx.toast('Nothing in the frost', 'warn');
      this.ctx.debug?.({ kind: 'miss', ability: 'freeze', reason: 'no-target', target: solution.target });
    }
  }

  // -------------------------------------------------------------- EARTH

  private rockShot(): void {
    const { player, projectiles, particles, audio } = this.ctx;
    const cfg = abilityCombat('rock-shot');
    const m = this.mods;
    const solution = this.aim(cfg.range);
    this.castOrigin(_origin);

    audio.play('rock');
    player.addShake(0.24, 7);
    this.ctx.flash(ELEMENTS.earth.color, 0.12);
    this.ctx.hitStop(0.03);

    // The ground heaves before the throw: dust, grit and a low rumble.
    player.getForward(_fwd);
    particles.debris({
      count: 22,
      x: player.position.x + _fwd.x * 1.4, y: player.position.y + 0.3, z: player.position.z + _fwd.z * 1.4,
      spread: 0.7, vy: 4.2, jitter: 3.8,
      color: 0x8a6440, color2: 0x503a24, size: 0.22, life: 1, gravity: -14, drag: 0.6,
    });
    particles.spark({
      count: 12,
      x: player.position.x + _fwd.x * 1.4, y: player.position.y + 0.5, z: player.position.z + _fwd.z * 1.4,
      spread: 0.8, jitter: 2.2, color: 0xd9c08a, size: 0.28, life: 0.55, gravity: -2, drag: 1.4,
    });

    projectiles.spawn({
      kind: 'rock', owner: 'player',
      origin: _origin.clone(),
      direction: new THREE.Vector3(solution.direction.x, solution.direction.y, solution.direction.z),
      speed: (cfg.speed ?? 27) * m.projectileSpeed,
      damage: this.power(cfg.damage, 'earth'),
      radius: cfg.radius * m.projectileSize,
      blast: (cfg.splash ?? 2) * m.projectileSize,
      life: 3, gravity: 11,
      knockback: cfg.knockback, stagger: cfg.stagger, color: 0x8b7d68,
      bounces: this.g('rock-bounce'),
      fragments: this.g('rock-fragment'),
      element: 'earth',
    });
    this.ctx.debug?.({
      kind: 'aim', ability: 'rock-shot',
      origin: { x: _origin.x, y: _origin.y, z: _origin.z },
      target: solution.target, radius: cfg.radius,
    });
  }

  private raiseWall(): UseResult {
    const { player, world, particles, audio } = this.ctx;
    player.getForward(_fwd);
    const flat = new THREE.Vector3(_fwd.x, 0, _fwd.z);
    if (flat.lengthSq() < 0.0001) flat.set(0, 0, -1);
    flat.normalize();
    const side = new THREE.Vector3().crossVectors(flat, _up).normalize();

    const originX = player.position.x + flat.x * 3.4;
    const originZ = player.position.z + flat.z * 3.4;
    const tectonic = this.hasG('tectonic');
    const duration = WALL_SECONDS * (tectonic ? 1.9 : 1);

    let placed = 0;
    const segments = 5;
    for (let s = 0; s < segments; s++) {
      const offset = (s - (segments - 1) / 2) * 1.5;
      const bx = originX + side.x * offset;
      const bz = originZ + side.z * offset;
      const ground = world.groundHeight(bx, bz);
      if (ground <= 0) continue;
      const taper = 1 - Math.abs(offset) / (segments * 0.95);

      // The ridge visibly heaves out of the ground in stages.
      for (let h = 0; h < 3; h++) {
        const by = ground + 0.4 + h * 0.85;
        if (player.intersectsSphere(bx, by, bz, 1.5)) continue;
        const ok = world.addTemporary({
          x: bx, y: by, z: bz,
          radius: 1.55 + taper * 0.35,
          strength: 2.2 + taper * 0.9,
          material: Mat.SOIL,
        }, duration + h * 0.4);
        if (ok) placed++;
      }

      particles.debris({
        count: 16, x: bx, y: ground + 1.2, z: bz, spread: 0.8,
        vy: 6, jitter: 2.8, color: 0x8a6440, color2: 0x503a24,
        size: 0.28, life: 1, gravity: -13, drag: 0.7,
      });
      particles.spark({
        count: 8, x: bx, y: ground + 1, z: bz, spread: 0.9, vy: 2.4, jitter: 1.8,
        color: 0xd9c08a, size: 0.26, life: 0.65, gravity: -3, drag: 1.3,
      });
    }

    if (placed === 0) {
      this.ctx.toast('No ground to raise', 'warn');
      return 'blocked';
    }

    audio.play('wall');
    player.addShake(0.36, 6);
    this.ctx.flash(ELEMENTS.earth.color, 0.2);
    this.ctx.hitStop(0.05);

    const armor = this.g('wall-armor');
    if (armor > 0) player.grantArmor(0.12 * armor, 6);

    player.unstick();
    return 'ok';
  }

  // --------------------------------------------------------------- FIRE

  private fireball(): void {
    const { player, projectiles, particles, audio } = this.ctx;
    const cfg = abilityCombat('fireball');
    const m = this.mods;
    const solution = this.aim(cfg.range);
    this.castOrigin(_origin);

    audio.play('fireball');
    this.ctx.flash(ELEMENTS.fire.color, 0.18);
    player.addShake(0.08, 9);
    this.ctx.pulseLight(_origin.x, _origin.y, _origin.z, 0xff9b3d, 8, 0.16);

    const splits = this.g('split');
    const shots = splits > 0 ? 1 + splits * 2 : 1;
    const spread = splits > 0 ? 0.13 : 0;
    _dir.set(solution.direction.x, solution.direction.y, solution.direction.z);

    for (let i = 0; i < shots; i++) {
      const offset = shots === 1 ? 0 : (i - (shots - 1) / 2) * spread;
      const dir = _dir.clone().applyAxisAngle(_up, offset);
      projectiles.spawn({
        kind: 'fireball', owner: 'player',
        origin: _origin.clone(),
        direction: dir,
        speed: (cfg.speed ?? 36) * m.projectileSpeed,
        damage: this.power(cfg.damage, 'fire') / (shots === 1 ? 1 : shots * 0.62),
        radius: cfg.radius * m.projectileSize,
        blast: (cfg.splash ?? 3.4) * m.projectileSize,
        life: 2.6, gravity: 0, knockback: cfg.knockback,
        burn: this.power(STATUS_TUNING.burnDps, 'fire'),
        color: 0xffb04d,
        element: 'fire',
      });
    }

    particles.spark({
      count: 16, x: _origin.x + _dir.x, y: _origin.y + _dir.y, z: _origin.z + _dir.z,
      spread: 0.25, vx: _dir.x * 6, vy: _dir.y * 6 + 1, vz: _dir.z * 6, jitter: 2,
      color: 0xffe08a, color2: 0xd43f1a, size: 0.3, life: 0.4, gravity: 2.4, drag: 1.6,
    });
    this.ctx.debug?.({
      kind: 'aim', ability: 'fireball',
      origin: { x: _origin.x, y: _origin.y, z: _origin.z },
      target: solution.target, radius: cfg.radius,
    });
  }

  private flameWave(): void {
    const { player, world, enemies, particles, audio, decals } = this.ctx;
    const cfg = abilityCombat('flame-wave');
    player.getForward(_fwd);
    const flat = new THREE.Vector3(_fwd.x, 0, _fwd.z);
    if (flat.lengthSq() < 0.0001) flat.set(0, 0, -1);
    flat.normalize();
    this.castOrigin(_origin);

    audio.play('flamewave');
    this.ctx.flash(ELEMENTS.fire.color, 0.34);
    player.addShake(0.34, 5);
    this.ctx.hitStop(0.04);

    const burningGround = this.g('burning-ground');

    // Visual fan, drawn along the ground.
    const rays = 7;
    for (let r = 0; r < rays; r++) {
      const angle = ((r / (rays - 1)) - 0.5) * cfg.coneHalfAngle! * 2;
      const dir = flat.clone().applyAxisAngle(_up, angle);
      let x = player.position.x;
      let z = player.position.z;
      let y = player.position.y;
      for (let step = 0; step < 26; step++) {
        x += dir.x * 0.5;
        z += dir.z * 0.5;
        const ground = world.groundHeight(x, z);
        if (ground > y + 1.5) break;
        y = Math.min(y + 1, Math.max(ground + 0.2, y - 1.2));
        particles.spark({
          count: 2, x, y: y + 0.35, z, spread: 0.32,
          vx: dir.x * 3, vy: 2.4, vz: dir.z * 3, jitter: 1.2,
          color: 0xffb04d, color2: 0xd43f1a, size: 0.42, life: 0.5, lifeJitter: 0.5,
          gravity: 3.2, drag: 1.5,
        });
        if (step % 6 === 0) {
          world.normalAt(x, ground + 0.2, z, _normal);
          decals.add('scorch', x, ground + 0.02, z, _normal, 2, burningGround > 0 ? 10 : 5, 0.7);
        }
      }
    }

    // One cone test against the body capsules - the visual fan and the hit
    // volume are the same shape.
    _originV.x = player.position.x; _originV.y = player.position.y + 0.6; _originV.z = player.position.z;
    _dirV.x = flat.x; _dirV.y = 0; _dirV.z = flat.z;
    const cosHalf = Math.cos(cfg.coneHalfAngle!);
    let struck = 0;
    for (const e of enemies.live) {
      if (!e.alive) continue;
      if (!coneVsCapsule(_originV, _dirV, cfg.range, cosHalf, e.hitCapsule())) continue;
      // Probe from chest height: a ray starting at the feet clips the ground.
      _chest.copy(player.position).setY(player.position.y + 0.6);
      if (!this.visible(e, _chest)) continue;
      _kb.copy(e.center).sub(player.position).setY(0).normalize()
        .multiplyScalar(this.power(cfg.knockback, 'fire'));
      this.damageEnemy(
        e, this.power(cfg.damage, 'fire'), 'fire', _kb, cfg.stagger,
        { id: 'burning', seconds: STATUS_TUNING.burnSeconds, magnitude: this.power(STATUS_TUNING.burnDps, 'fire') },
      );
      e.applyBurn(this.power(STATUS_TUNING.burnDps, 'fire'), STATUS_TUNING.burnSeconds);
      struck++;
      particles.spark({
        count: 18, x: e.center.x, y: e.center.y, z: e.center.z, spread: 0.5,
        jitter: 3.2, color: 0xffb04d, color2: 0xffe08a, size: 0.34, life: 0.6, gravity: 2.4,
      });
    }
    if (struck > 0) audio.play('impact', 60);

    // Fire changes the ground it sweeps: a burning zone that hurts anything
    // standing in it, and which water can put out again.
    const zoneSeconds = 6 + burningGround * 3;
    this.ctx.effects?.add(
      'burning',
      player.position.x + flat.x * 6, world.groundHeight(player.position.x + flat.x * 6, player.position.z + flat.z * 6),
      player.position.z + flat.z * 6,
      cfg.radius * 2.2 * this.mods.areaScale, zoneSeconds,
      this.power(STATUS_TUNING.burnDps * 0.7, 'fire'), 'player',
    );
    this.charge('terrain');
  }

  // =====================================================================
  //  Techniques (Q)
  // =====================================================================

  /**
   * Water · Tidal Pull.
   *
   * Drags creatures toward a point, hardest on the ones already soaked, and
   * interrupts a wind-up in progress so it also answers a telegraphed attack.
   */
  private tidalPull(): void {
    const { enemies, particles, audio, world } = this.ctx;
    const cfg = abilityCombat('tidal-pull');
    const radius = cfg.radius * this.mods.areaScale;
    const solution = this.aim(cfg.range * this.mods.rangeScale);
    _target.set(solution.target.x, solution.target.y, solution.target.z);

    audio.play('whip', 60);
    this.ctx.flash(ELEMENTS.water.color, 0.2);
    this.ctx.pulseLight(_target.x, _target.y, _target.z, ELEMENTS.water.color, 7, 0.4);

    // A visible ring of water pulled inward, so the volume is unmistakable.
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      particles.spark({
        count: 1,
        x: _target.x + Math.cos(a) * radius, y: _target.y - 0.2, z: _target.z + Math.sin(a) * radius,
        vx: -Math.cos(a) * 9, vy: 1.6, vz: -Math.sin(a) * 9, jitter: 1,
        color: ELEMENTS.water.color, color2: 0xffffff, size: 0.34, life: 0.6, gravity: -2, drag: 1.2,
      });
    }

    const strength = 1 + this.g('pull-strength') * 0.35;
    let pulled = 0;
    let interrupted = 0;
    for (const e of enemies.within(_target, radius, _scratch)) {
      const wet = e.status.has('wet');
      // Soaked creatures are dragged much harder - the technique rewards the
      // Water Whip that came before it.
      _kb.copy(_target).sub(e.center).setY(0);
      const distance = _kb.length();
      if (distance > 0.001) _kb.normalize();
      _kb.multiplyScalar((wet ? 13 : 6) * strength);
      this.damageEnemy(
        e, this.power(cfg.damage, 'water') * (wet ? 1.5 : 1), 'water', _kb, cfg.stagger,
        { id: 'wet', seconds: STATUS_TUNING.wetSeconds },
      );
      e.applySlow(0.55, 2.4 * strength);
      if (e.interrupt?.()) interrupted++;
      pulled++;
    }

    // Wet the ground it lands on, which is also what lets Freeze pay off here.
    const ground = world.groundHeight(_target.x, _target.z);
    this.ctx.effects?.add('wet', _target.x, ground, _target.z, radius, 10, 0, 'player');
    this.ctx.decals.add('wet', _target.x, ground + 0.02, _target.z, _up, radius, 9, 0.55);
    this.charge('terrain');

    this.ctx.toast(
      pulled > 0
        ? `Tidal Pull dragged ${pulled} in${interrupted > 0 ? `, interrupting ${interrupted}` : ''}`
        : 'Tidal Pull found nothing',
      pulled > 0 ? 'good' : 'warn',
    );
  }

  /**
   * Fire · Flame Dash.
   *
   * An aggressive gap-closer: the player lunges inside a lance of fire, burning
   * everything on the way through and leaving the ground alight behind them.
   */
  private flameDash(): void {
    const { player, particles, audio, enemies, world } = this.ctx;
    const cfg = abilityCombat('flame-dash');
    player.getForward(_fwd);
    const dir = new THREE.Vector3(_fwd.x, 0, _fwd.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();

    const start = player.position.clone();
    player.velocity.x = dir.x * (cfg.speed ?? 30);
    player.velocity.z = dir.z * (cfg.speed ?? 30);
    player.velocity.y = Math.max(player.velocity.y, 2.4);
    player.dashGrace = 1.2;
    player.addShake(0.24, 8);
    audio.play('flamewave', 40);
    this.ctx.flash(ELEMENTS.fire.color, 0.3);

    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      particles.spark({
        count: 1,
        x: start.x + dir.x * t * cfg.range, y: start.y + 0.9, z: start.z + dir.z * t * cfg.range,
        vx: dir.x * 4, vy: 2.2, vz: dir.z * 4, jitter: 1.6,
        color: 0xffb04d, color2: 0xd43f1a, size: 0.4, life: 0.5, gravity: 2.6, drag: 1.4,
      });
    }

    // Sweep a capsule along the whole lunge so nothing is passed through.
    _probeA.x = start.x; _probeA.y = start.y + 0.9; _probeA.z = start.z;
    _probeB.x = start.x + dir.x * cfg.range;
    _probeB.y = start.y + 0.9;
    _probeB.z = start.z + dir.z * cfg.range;
    const volume = { a: _probeA, b: _probeB, radius: cfg.radius * this.mods.areaScale };
    let struck = 0;
    for (const e of enemies.live) {
      if (!e.alive) continue;
      if (!capsuleVsCapsule(volume, e.hitCapsule())) continue;
      _kb.copy(dir).multiplyScalar(this.power(cfg.knockback, 'fire'));
      this.damageEnemy(
        e, this.power(cfg.damage, 'fire'), 'fire', _kb, cfg.stagger,
        { id: 'burning', seconds: STATUS_TUNING.burnSeconds, magnitude: this.power(STATUS_TUNING.burnDps, 'fire') },
      );
      struck++;
    }

    // A burning trail along the lunge line.
    for (let i = 1; i <= 3; i++) {
      const t = i / 3;
      const x = start.x + dir.x * cfg.range * t;
      const z = start.z + dir.z * cfg.range * t;
      const ground = world.groundHeight(x, z);
      this.ctx.effects?.add(
        'burning', x, ground, z, 2.2 * this.mods.areaScale, 7,
        this.power(STATUS_TUNING.burnDps * 0.6, 'fire'), 'player',
      );
      this.ctx.decals.add('scorch', x, ground + 0.02, z, _up, 2.4, 9, 0.7);
    }
    this.charge('terrain');
    if (struck > 0) audio.play('impact', 60);
  }

  /**
   * Earth · Seismic Slam.
   *
   * Cracks race away from the player along the ground, damaging and staggering
   * anything standing on the affected terrain and leaving real craters behind.
   */
  private seismicSlam(): UseResult {
    const { player, world, enemies, particles, audio, decals } = this.ctx;
    const cfg = abilityCombat('seismic-slam');
    player.getForward(_fwd);
    const dir = new THREE.Vector3(_fwd.x, 0, _fwd.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();

    const originGround = world.groundHeight(player.position.x, player.position.z);
    if (originGround <= 0) {
      this.ctx.toast('No ground to break', 'warn');
      return 'blocked';
    }

    audio.play('wall');
    player.addShake(0.5, 5);
    this.ctx.hitStop(0.06);
    this.ctx.flash(ELEMENTS.earth.color, 0.26);

    const width = this.g('slam-wide') > 0 ? 3 : 1;
    const reach = cfg.range * this.mods.rangeScale;
    const struck = new Set<number>();

    for (let lane = 0; lane < width; lane++) {
      const angle = (lane - (width - 1) / 2) * 0.42;
      const laneDir = dir.clone().applyAxisAngle(_up, angle);
      for (let step = 1; step <= 7; step++) {
        const t = step / 7;
        const x = player.position.x + laneDir.x * reach * t;
        const z = player.position.z + laneDir.z * reach * t;
        const ground = world.groundHeight(x, z);
        if (ground <= 0) break;

        particles.debris({
          count: 10, x, y: ground + 0.5, z, spread: 0.8, vy: 5.4, jitter: 3,
          color: 0x8a6440, color2: 0x503a24, size: 0.24, life: 0.9, gravity: -13, drag: 0.7,
        });
        world.normalAt(x, ground + 0.2, z, _normal);
        decals.add('crack', x, ground + 0.02, z, _normal, 2.6, 16, 0.85);

        // A real crack in the terrain, size-limited and never on protected ground.
        this.ctx.effects?.deform(x, ground - 0.2, z, 1.6 * this.mods.areaScale, -1.5, Mat.SOIL, 22);

        _v.set(x, ground + 0.8, z);
        for (const e of enemies.within(_v, cfg.radius * this.mods.areaScale, _scratch)) {
          if (struck.has(e.uid)) continue;
          struck.add(e.uid);
          _kb.copy(e.center).sub(_v).setY(0.35).normalize()
            .multiplyScalar(this.power(cfg.knockback, 'earth'));
          this.damageEnemy(
            e, this.power(cfg.damage, 'earth'), 'earth', _kb,
            cfg.stagger * (1 + this.g('slam-wide') * 0.2),
            { id: 'stunned', seconds: 0.9 },
          );
        }
      }
    }

    // Earth's terrain refund: reshaping the ground pays a little Mana back when
    // it actually connects with something.
    if (struck.size > 0) this.ctx.refundMana?.(4 + struck.size * 2);
    this.charge('terrain');
    this.ctx.toast(
      struck.size > 0 ? `Seismic Slam staggered ${struck.size}` : 'The ground cracks',
      struck.size > 0 ? 'good' : 'plain' as 'good',
    );
    return 'ok';
  }

  /**
   * Air · Air Blades.
   *
   * Several fast wind blades. They pierce light creatures outright and bounce
   * off terrain, so they keep working in a corridor.
   */
  private airBlades(): void {
    const { projectiles, audio, player } = this.ctx;
    const cfg = abilityCombat('air-blades');
    const solution = this.aim(cfg.range * this.mods.rangeScale);
    this.castOrigin(_origin);
    _dir.set(solution.direction.x, solution.direction.y, solution.direction.z);

    audio.play('gust', 40);
    this.ctx.flash(ELEMENTS.air.color, 0.16);
    player.addShake(0.1, 9);

    const blades = 3 + this.g('extra-blade') * 2 + this.g('extra-projectile');
    const spread = 0.1;
    for (let i = 0; i < blades; i++) {
      const offset = blades === 1 ? 0 : (i - (blades - 1) / 2) * spread;
      const dir = _dir.clone().applyAxisAngle(_up, offset);
      projectiles.spawn({
        kind: 'bolt', owner: 'player',
        origin: _origin.clone(),
        direction: dir,
        speed: (cfg.speed ?? 44) * this.mods.projectileSpeed,
        damage: this.power(cfg.damage, 'air'),
        radius: cfg.radius * this.mods.projectileSize,
        blast: 0.9 * this.mods.areaScale,
        life: 1.6, gravity: 0,
        knockback: cfg.knockback, stagger: cfg.stagger,
        color: ELEMENTS.air.color,
        bounces: 1 + this.g('extra-blade'),
        element: 'air',
      });
    }
    this.ctx.debug?.({
      kind: 'aim', ability: 'air-blades',
      origin: { x: _origin.x, y: _origin.y, z: _origin.z },
      target: solution.target, radius: cfg.radius,
    });
  }

  // =====================================================================
  //  Ultimates (middle mouse / R)
  // =====================================================================

  /** Advance every sustained Ultimate field. */
  private tickFields(dt: number): void {
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const field = this.fields[i]!;
      field.elapsed += dt;
      if (field.elapsed >= field.duration) {
        this.fields.splice(i, 1);
        continue;
      }
      // A travelling field (Cyclone) walks forward on its own.
      if (field.speed > 0) {
        field.x += field.dirX * field.speed * dt;
        field.z += field.dirZ * field.speed * dt;
        field.y = this.ctx.world.groundHeight(field.x, field.z);
      }
      field.sinceTick += dt;
      if (field.sinceTick < field.interval) {
        this.fieldVisuals(field, dt);
        continue;
      }
      field.sinceTick = 0;
      this.fieldVisuals(field, dt);
      field.pulse(field);
    }
  }

  private fieldVisuals(field: UltimateField, dt: number): void {
    const { particles } = this.ctx;
    const spin = field.elapsed * 3.2;
    const count = Math.max(1, Math.round(14 * Math.min(1, dt * 60)));
    for (let i = 0; i < count; i++) {
      const a = spin + (i / count) * Math.PI * 2;
      const r = field.radius * (0.35 + 0.65 * ((i % 3) / 2));
      particles.spark({
        count: 1,
        x: field.x + Math.cos(a) * r,
        y: field.y + 0.4 + (i % 4) * 0.8,
        z: field.z + Math.sin(a) * r,
        vx: -Math.sin(a) * 7, vy: field.rise, vz: Math.cos(a) * 7, jitter: 1.2,
        color: field.color, color2: 0xffffff,
        size: 0.42, life: 0.5, gravity: field.rise * 0.4, drag: 1.1,
      });
    }
  }

  private beginField(init: Omit<UltimateField, 'elapsed' | 'sinceTick'>): UltimateField {
    const field: UltimateField = { ...init, elapsed: 0, sinceTick: init.interval };
    this.fields.push(field);
    return field;
  }

  /** Where an Ultimate is centred: the aimed point, clamped to solid ground. */
  private ultimateAnchor(range: number): THREE.Vector3 {
    const solution = this.aim(range, false);
    _target.set(solution.target.x, solution.target.y, solution.target.z);
    const ground = this.ctx.world.groundHeight(_target.x, _target.z);
    if (ground > 0) _target.y = ground;
    return _target;
  }

  /**
   * Water · Maelstrom.
   *
   * A rotating water field that pulls, soaks, grinds - and flash-freezes
   * anything that has taken enough Freeze buildup while inside it.
   */
  private maelstrom(): UseResult {
    const cfg = abilityCombat('maelstrom');
    const anchor = this.ultimateAnchor(cfg.range).clone();
    const radius = cfg.radius * this.mods.areaScale;
    const dps = this.power(cfg.damage, 'water') * this.mods.ultimateDamage;
    const boosted = this.hasG('ultimate-water');

    this.ctx.audio.play('freeze');
    this.ctx.flash(ELEMENTS.water.color, 0.45);
    this.ctx.player.addShake(0.4, 4);
    this.ctx.pulseLight(anchor.x, anchor.y + 3, anchor.z, ELEMENTS.water.color, 22, 1.2);
    this.ctx.effects?.add('wet', anchor.x, anchor.y, anchor.z, radius, cfg.castTime! + 6, 0, 'player');
    this.ctx.decals.add('wet', anchor.x, anchor.y + 0.02, anchor.z, _up, radius, cfg.castTime! + 6, 0.6);

    const buildup = new Map<number, number>();
    this.beginField({
      x: anchor.x, y: anchor.y, z: anchor.z,
      dirX: 0, dirZ: 0, speed: 0, rise: 3.4,
      radius, duration: (cfg.castTime ?? 6) * (boosted ? 1.35 : 1),
      interval: cfg.damageInterval ?? 0.5,
      color: ELEMENTS.water.color,
      pulse: (field) => {
        _v.set(field.x, field.y + 1, field.z);
        for (const e of this.ctx.enemies.within(_v, field.radius, _scratch)) {
          _kb.copy(_v).sub(e.center).setY(0);
          if (_kb.lengthSq() > 1e-4) _kb.normalize().multiplyScalar(7);
          this.damageEnemy(
            e, dps * field.interval, 'water', _kb, 0,
            { id: 'wet', seconds: STATUS_TUNING.wetSeconds },
          );
          const stacks = (buildup.get(e.uid) ?? 0) + 1;
          buildup.set(e.uid, stacks);
          // Enough soaking inside the vortex and the water locks solid.
          if (stacks >= 3 && !e.status.has('frozen')) {
            const seconds = STATUS_TUNING.freezeSecondsWhenWet * this.mods.statusDuration;
            e.status.apply('frozen', seconds);
            e.applyFreeze(seconds);
            this.ctx.confirmHit('status');
          }
        }
      },
    });

    this.ctx.toast('Maelstrom', 'good');
    return 'ok';
  }

  /**
   * Fire · Inferno.
   *
   * A firestorm that ignites the arena for its whole duration. Burning
   * creatures that fall inside it detonate, which is what makes it a finisher
   * rather than just a large damage field.
   */
  private inferno(): UseResult {
    const cfg = abilityCombat('inferno');
    const anchor = this.ultimateAnchor(cfg.range).clone();
    const radius = cfg.radius * this.mods.areaScale;
    const dps = this.power(cfg.damage, 'fire') * this.mods.ultimateDamage;
    const boosted = this.hasG('ultimate-fire');
    const duration = (cfg.castTime ?? 6) * (boosted ? 1.4 : 1);

    this.ctx.audio.play('flamewave');
    this.ctx.flash(ELEMENTS.fire.color, 0.5);
    this.ctx.player.addShake(0.5, 4);
    this.ctx.pulseLight(anchor.x, anchor.y + 3, anchor.z, 0xff7a1a, 26, 1.4);

    // The arena itself changes for the duration: burning ground, scorch marks,
    // and any ice in the area melts.
    this.ctx.effects?.add('burning', anchor.x, anchor.y, anchor.z, radius, duration + 4, dps * 0.35, 'player');
    this.ctx.decals.add('scorch', anchor.x, anchor.y + 0.02, anchor.z, _up, radius, duration + 8, 0.85);

    this.beginField({
      x: anchor.x, y: anchor.y, z: anchor.z,
      dirX: 0, dirZ: 0, speed: 0, rise: 4.4,
      radius, duration,
      interval: cfg.damageInterval ?? 0.5,
      color: 0xffb04d,
      pulse: (field) => {
        _v.set(field.x, field.y + 1, field.z);
        for (const e of this.ctx.enemies.within(_v, field.radius, _scratch)) {
          const wasBurning = e.status.has('burning');
          const alive = e.alive;
          this.damageEnemy(
            e, dps * field.interval, 'fire', null, 0,
            { id: 'burning', seconds: STATUS_TUNING.burnSeconds, magnitude: this.power(STATUS_TUNING.burnDps, 'fire') },
          );
          // A burning creature that dies in the storm goes off.
          if (wasBurning && alive && !e.alive) this.detonate(e.center, dps * 1.6, field.radius * 0.35);
        }
      },
    });

    this.ctx.toast('Inferno', 'good');
    return 'ok';
  }

  /** Shared explosion used by Inferno and by corpse detonations. */
  private detonate(centre: THREE.Vector3, damage: number, radius: number): void {
    const point = centre.clone();
    this.ctx.particles.spark({
      count: 48, x: point.x, y: point.y, z: point.z, spread: 0.6, jitter: 9,
      color: 0xffb04d, color2: 0xffe08a, size: 0.5, life: 0.6, gravity: 3, drag: 1.5,
    });
    this.ctx.pulseLight(point.x, point.y, point.z, 0xff8a2a, 16, 0.4);
    for (const other of this.ctx.enemies.within(point, radius, _scratch2)) {
      this.damageEnemy(other, damage, 'fire', null, 0.2);
    }
  }

  /**
   * Earth · Tectonic Rupture.
   *
   * One heavy strike that reshapes the arena: a shockwave, ground fractures,
   * and a ring of raised cover the player can then fight from.
   */
  private tectonicRupture(): UseResult {
    const { world, enemies, particles, audio, player, decals } = this.ctx;
    const cfg = abilityCombat('tectonic-rupture');
    const anchor = this.ultimateAnchor(cfg.range).clone();
    if (world.groundHeight(anchor.x, anchor.z) <= 0) {
      this.ctx.toast('Tectonic Rupture needs ground', 'warn');
      return 'blocked';
    }
    const radius = cfg.radius * this.mods.areaScale;
    const boosted = this.hasG('ultimate-earth');

    audio.play('wall');
    player.addShake(0.9, 3);
    this.ctx.hitStop(0.1);
    this.ctx.flash(ELEMENTS.earth.color, 0.5);
    this.ctx.pulseLight(anchor.x, anchor.y + 2, anchor.z, ELEMENTS.earth.color, 18, 0.8);

    // ---- shockwave
    let struck = 0;
    for (const e of enemies.within(anchor, radius, _scratch)) {
      _kb.copy(e.center).sub(anchor).setY(0.5).normalize()
        .multiplyScalar(this.power(cfg.knockback, 'earth'));
      this.damageEnemy(
        e, this.power(cfg.damage, 'earth') * this.mods.ultimateDamage, 'earth', _kb, cfg.stagger,
        { id: 'stunned', seconds: 1.6 },
      );
      struck++;
    }

    // ---- fractures and craters, all inside the deformation budget
    const spokes = boosted ? 10 : 7;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      for (let step = 1; step <= 4; step++) {
        const r = (radius / 4) * step;
        const x = anchor.x + Math.cos(a) * r;
        const z = anchor.z + Math.sin(a) * r;
        const ground = world.groundHeight(x, z);
        if (ground <= 0) continue;
        world.normalAt(x, ground + 0.2, z, _normal);
        decals.add('crack', x, ground + 0.02, z, _normal, 3, 30, 0.9);
        this.ctx.effects?.deform(x, ground - 0.3, z, 1.8, -1.4, Mat.SOIL, 30);
        particles.debris({
          count: 10, x, y: ground + 0.8, z, spread: 1, vy: 7, jitter: 4,
          color: 0x8a6440, color2: 0x503a24, size: 0.3, life: 1.2, gravity: -13, drag: 0.6,
        });
      }
    }

    // ---- a ring of defensive cover left standing around the player
    const coverSeconds = boosted ? 26 : 18;
    const pillars = boosted ? 8 : 6;
    for (let i = 0; i < pillars; i++) {
      const a = (i / pillars) * Math.PI * 2;
      const x = player.position.x + Math.cos(a) * 4.6;
      const z = player.position.z + Math.sin(a) * 4.6;
      const ground = world.groundHeight(x, z);
      if (ground <= 0) continue;
      for (let h = 0; h < 3; h++) {
        if (player.intersectsSphere(x, ground + 0.5 + h * 0.85, z, 1.5)) continue;
        this.ctx.effects?.deform(x, ground + 0.5 + h * 0.85, z, 1.5, 2.4, Mat.STONE, coverSeconds);
      }
    }

    player.unstick();
    this.charge('terrain');
    this.ctx.toast(struck > 0 ? `Tectonic Rupture struck ${struck}` : 'The arena breaks open', 'good');
    return 'ok';
  }

  /**
   * Air · Cyclone.
   *
   * A tornado that walks forward under its own power, dragging light creatures
   * along, grinding heavy ones, and turning hostile projectiles around.
   */
  private cyclone(): UseResult {
    const cfg = abilityCombat('cyclone');
    const { player, projectiles, audio } = this.ctx;
    player.getForward(_fwd);
    const dir = new THREE.Vector3(_fwd.x, 0, _fwd.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();

    const start = player.position.clone().addScaledVector(dir, 5);
    const radius = cfg.radius * this.mods.areaScale;
    const dps = this.power(cfg.damage, 'air') * this.mods.ultimateDamage;
    const boosted = this.hasG('ultimate-air');

    audio.play('gust');
    this.ctx.flash(ELEMENTS.air.color, 0.4);
    player.addShake(0.36, 5);

    this.beginField({
      x: start.x, y: this.ctx.world.groundHeight(start.x, start.z), z: start.z,
      dirX: dir.x, dirZ: dir.z,
      speed: (cfg.speed ?? 6) * (boosted ? 1.3 : 1),
      rise: 6,
      radius: radius * (boosted ? 1.2 : 1),
      duration: (cfg.castTime ?? 7) * (boosted ? 1.25 : 1),
      interval: cfg.damageInterval ?? 0.45,
      color: ELEMENTS.air.color,
      pulse: (field) => {
        _v.set(field.x, field.y + 1.5, field.z);
        for (const e of this.ctx.enemies.within(_v, field.radius, _scratch)) {
          // Light creatures are dragged into the funnel; heavy ones are ground
          // down where they stand.
          const light = e.knockbackResist < 0.5;
          _kb.copy(_v).sub(e.center).setY(light ? 1.4 : 0);
          if (_kb.lengthSq() > 1e-4) _kb.normalize().multiplyScalar(light ? 9 : 2.5);
          this.damageEnemy(e, dps * field.interval * (light ? 1 : 1.35), 'air', _kb, 0.2);
        }
        // Projectiles entering the funnel are thrown back at their owners.
        _dirV.x = 0; _dirV.y = 1; _dirV.z = 0;
        _originV.x = field.x; _originV.y = field.y + 1.5; _originV.z = field.z;
        const turned = projectiles.deflect(
          new THREE.Vector3(field.x, field.y + 1.5, field.z),
          new THREE.Vector3(field.dirX, 0, field.dirZ),
          field.radius, -1, 26, true,
        );
        if (turned > 0) this.charge('deflect');
        // Loose environmental effects are swept clear as it passes.
        this.ctx.effects?.clearObscurants(field.x, field.z, field.radius);
      },
    });

    this.ctx.toast('Cyclone', 'good');
    return 'ok';
  }
}

/** One sustained Ultimate field. */
interface UltimateField {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** Metres per second the field travels; 0 for a stationary field. */
  speed: number;
  /** Upward drift of the field's particles. */
  rise: number;
  radius: number;
  duration: number;
  elapsed: number;
  /** Seconds between damage pulses. */
  interval: number;
  sinceTick: number;
  color: number;
  pulse: (field: UltimateField) => void;
}

const _v = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _target = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _originV: Vec3 = { x: 0, y: 0, z: 0 };
const _dirV: Vec3 = { x: 0, y: 0, z: 0 };
const _probeA: Vec3 = { x: 0, y: 0, z: 0 };
const _probeB: Vec3 = { x: 0, y: 0, z: 0 };
