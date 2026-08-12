/**
 * Corrupted creatures: sculpted bodies, finite-state AI, damage and drops.
 *
 * Three originals, none of them made of cubes:
 *   - Corrupted Crawler : low rounded quadruped, melee, hunts in small packs
 *   - Corrupted Wisp    : floating core wrapped in orbiting shards, ranged
 *   - Shrine Guardian   : large sculpted figure with a floating crown
 *
 * Collision is continuous against the density field rather than a voxel grid,
 * so creatures walk over smooth hills and can be trapped by a raised ridge.
 */

import * as THREE from 'three';
import type { World } from '../world/World';
import type { Particles } from '../fx/Particles';
import type { Projectiles } from './Projectiles';
import type { AudioEngine } from '../audio/AudioEngine';
import type { ElementId } from '../elements/affinity';
import { ELEMENTS } from '../elements/elements';
import { SHRINE_SITES, type WorldMode } from '../world/shrineData';
import {
  ENEMY_TYPES, ELITE_MODIFIERS, attackCategoryOf, effectiveResistance, eliteName,
  eliteStats, rollElites,
  type EliteId, type EnemyKind as TypeKind, type EnemyTypeDef,
} from './enemyTypes';
import { StatusSet, type StatusId } from './status';
import { CombatDirector, DEFAULT_DIRECTOR } from './CombatDirector';
import { bodyCapsule, sphereVsCapsule, type Capsule, type Vec3 } from './hitVolumes';
import { AIM, ENCOUNTER, INCOMING, REACTION, SPAWN } from './combatConfig';
import { EncounterDirector, type EncounterSignals, type EncounterStatus } from './encounter';
import { isStranded, validateSpawn, type SpawnWorldProbe } from './spawnRules';
import { WORLD_CENTER, WORLD_SIZE } from '../world/coords';
import { SPAWN_PLAZA_RADIUS } from '../world/density';
import {
  buildBurrower, buildCrawler, buildGuardian, buildRootHunter, buildShellback,
  buildSpirit, buildSpitter, buildStoneBeast, buildWisp, geoPickup,
  type CreatureBuild,
} from '../render/models';
import type { BodyPlan } from './enemyTypes';

/** Build the sculpted body for a plan. */
function buildBody(plan: BodyPlan, accent: number, body: number): CreatureBuild {
  switch (plan) {
    case 'wisp': return buildWisp(accent);
    case 'guardian': return buildGuardian(accent);
    case 'root-hunter': return buildRootHunter(accent, body);
    case 'stone-beast': return buildStoneBeast(accent, body);
    case 'spitter': return buildSpitter(accent, body);
    case 'shellback': return buildShellback(accent, body);
    case 'spirit': return buildSpirit(accent, body);
    case 'burrower': return buildBurrower(accent, body);
    default: return buildCrawler(accent);
  }
}

/**
 * Height each body plan is modelled at, so a creature's declared height scales
 * it correctly instead of every plan sharing one fudge factor.
 */
const BODY_REFERENCE_HEIGHT: Record<BodyPlan, number> = {
  crawler: 1.0,
  wisp: 1.4,
  guardian: 4.0,
  'root-hunter': 1.5,
  'stone-beast': 1.5,
  spitter: 1.85,
  shellback: 1.25,
  spirit: 1.3,
  burrower: 1.1,
};

export type EnemyKind = TypeKind;
export type EnemyState = 'idle' | 'detect' | 'chase' | 'telegraph' | 'attack' | 'hurt' | 'dead';

/** Back-compat shim: the old shape used by existing callers. */
export interface EnemyDef {
  readonly kind: EnemyKind;
  readonly name: string;
  readonly maxHealth: number;
  readonly speed: number;
  readonly damage: number;
  readonly attackRange: number;
  readonly attackCooldown: number;
  readonly detectRange: number;
  readonly loseRange: number;
  readonly radius: number;
  readonly height: number;
  readonly knockbackResist: number;
  readonly energyDrop: number;
}

function toLegacyDef(t: EnemyTypeDef): EnemyDef {
  const first = t.attacks[0];
  return {
    kind: t.kind, name: t.name, maxHealth: t.maxHealth, speed: t.speed,
    damage: first ? first.damage : 0,
    attackRange: first ? first.range : 2,
    attackCooldown: first ? first.cooldown : 2,
    detectRange: t.detectRange, loseRange: t.loseRange,
    radius: t.radius, height: t.height,
    knockbackResist: t.knockbackResist, energyDrop: t.energyDrop,
  };
}

export interface EnemyContext {
  world: World;
  particles: Particles;
  projectiles: Projectiles;
  audio: AudioEngine;
  camera: THREE.Camera;
  getPlayerPosition(): THREE.Vector3;
  isPlayerAlive(): boolean;
  damagePlayer(amount: number, from: THREE.Vector3, knockback: number): void;
  onGuardianDefeated(shrineIndex: number): void;
  onEnergyPickup(amount: number): void;
  /** Player facing, used for the fairness rules. */
  getPlayerForward(): THREE.Vector3;
  /** Show a ground warning marker for a telegraphed attack. */
  telegraph(x: number, y: number, z: number, radius: number, seconds: number, color: number): void;
  /** Warn about an attack starting outside the player's view. */
  offscreenWarning(fromX: number, fromZ: number): void;
  /**
   * A telegraphed attack resolved and just missed the player.
   *
   * "Just" means inside half again the radius that would have connected, so
   * this fires for a real dodge and not for standing across the arena.
   */
  onNearMiss?(): void;
  /** A creature died; lets the run layer count kills and offer rewards. */
  onEnemyKilled(kind: EnemyKind, elites: readonly EliteId[]): void;
  /** Current run difficulty multiplier. */
  difficulty(): number;

  // ---- pacing inputs. All optional, so a test harness can omit them.
  /** Player health as a fraction of maximum, for the low-health spawn guard. */
  playerHealthFraction?(): number;
  /** Player maximum health, so a single hit can be capped against it. */
  playerMaxHealth?(): number;
  /** False while a story beat, reward screen or transition owns the screen. */
  isPlaying?(): boolean;
  /** True while the player is inside post-respawn protection. */
  isProtected?(): boolean;
  /** True when a scenario is running its own spawns. */
  scenarioDriven?(): boolean;
  /** Non-terrain solids, so nothing is placed inside a prop or a boulder. */
  isObstacle?(x: number, y: number, z: number, radius: number, height: number): boolean;
}

const barBgGeo = new THREE.PlaneGeometry(1, 0.11);
const barFgGeo = new THREE.PlaneGeometry(1, 0.085);
barBgGeo.translate(0.5, 0, 0);
barFgGeo.translate(0.5, 0, 0.001);
const barBgMaterial = new THREE.MeshBasicMaterial({ color: 0x0b0f18, transparent: true, opacity: 0.8, depthTest: true });
const barFgMaterial = new THREE.MeshBasicMaterial({ color: 0xff5f6d, depthTest: true });

const _center = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _expired: StatusId[] = [];
let nextEnemyUid = 1;
const _probe: Vec3 = { x: 0, y: 0, z: 0 };
const _weak = new THREE.Vector3();
const _losOrigin = new THREE.Vector3();

export class Enemy {
  readonly def: EnemyDef;
  readonly kind: EnemyKind;
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();

  health: number;
  maxHealth: number;
  state: EnemyState = 'idle';
  stateTime = 0;
  alive = true;
  onGround = false;
  attackTimer = 0;
  hurtFlash = 0;
  staggerTimer = 0;
  slowTimer = 0;
  slowFactor = 1;
  burnTimer = 0;
  burnDps = 0;
  freezeTimer = 0;
  shrineIndex = -1;
  awake = true;
  deathTimer = 0;
  attackPhase = 0;
  /** True while the creature has been refused an attack and is repositioning. */
  seekingPosition = false;
  /** Which way it circles while it waits for an opening: +1 or -1. */
  circleSign = 1;
  /** Reinforcement waves a summoner has left, so support is never endless. */
  summonsLeft = 3;
  /** Seconds spent chasing without getting meaningfully closer. */
  noProgressTimer = 0;
  /** Best distance to the player this creature has managed while chasing. */
  bestApproach = Infinity;

  /** Shared archetype data. */
  readonly type: EnemyTypeDef;
  /** Elite modifiers applied to this individual. */
  readonly elites: readonly EliteId[];
  readonly displayName: string;
  /** Active status effects. */
  readonly status = new StatusSet();
  /** Regenerating barrier from the `shielded` modifier. */
  shield = 0;
  maxShield = 0;
  /** Attack wind-up state. */
  telegraphTimer = 0;
  telegraphTotal = 0;
  /** Directional flinch: seconds remaining and the push direction. */
  flinchTimer = 0;
  private flinchX = 0;
  private flinchZ = 0;
  /** Set for one frame when a hit landed, so the manager can react. */
  lastHitWasBig = false;
  /** The last hit was entirely soaked by a shield. */
  lastHitBlocked = false;
  pendingAttack: number = -1;
  attackToken = -1;
  /** Unique id used by the combat director. */
  readonly uid: number;
  private damageScale = 1;
  private speedScale = 1;
  /** Set when the creature is being removed peacefully rather than killed. */
  dissolving = false;

  private build: CreatureBuild;
  /** Which sculpted silhouette this creature was built from. */
  bodyPlan: BodyPlan = 'crawler';
  private bar: THREE.Group | null = null;
  private barFg: THREE.Mesh | null = null;
  private barTimer = 0;
  private phase = Math.random() * Math.PI * 2;
  private accent: number;
  private baseColors: number[] = [];

  constructor(
    kind: EnemyKind, position: THREE.Vector3, accentColor: number, healthScale = 1,
    elites: readonly EliteId[] = [],
  ) {
    this.kind = kind;
    this.type = ENEMY_TYPES[kind];
    this.def = toLegacyDef(this.type);
    this.uid = nextEnemyUid++;
    // Alternate which way each creature circles, so a denied pack fans out
    // around the player instead of all sliding the same way.
    this.circleSign = (this.uid & 1) === 0 ? 1 : -1;
    this.elites = elites;
    this.displayName = eliteName(kind, elites);
    const es = eliteStats(elites);
    this.damageScale = es.damageScale;
    this.speedScale = es.speedScale;
    this.maxHealth = this.type.maxHealth * healthScale * es.healthScale;
    this.health = this.maxHealth;
    if (elites.includes('shielded')) {
      this.maxShield = this.maxHealth * 0.4;
      this.shield = this.maxShield;
    }
    this.accent = elites.length > 0 ? ELITE_MODIFIERS[elites[0]!].color : accentColor;
    this.pos.copy(position);
    this.group.position.copy(position);

    // Silhouette by body plan: each world's creatures are built from different
    // geometry, not tinted copies of one another.
    const loco = this.type.locomotion;
    const plan: BodyPlan = this.type.bodyPlan
      ?? (loco === 'hover'
        ? 'wisp'
        : this.type.role === 'tank' || this.type.role === 'boss' || kind === 'guardian'
          ? 'guardian'
          : 'crawler');
    this.bodyPlan = plan;
    this.build = buildBody(plan, this.accent, this.type.body);

    const referenceHeight = BODY_REFERENCE_HEIGHT[plan];
    const scale = this.type.height / referenceHeight;
    this.build.group.scale.setScalar(Math.max(0.55, scale));
    this.group.add(this.build.group);
    for (const mat of this.build.materials) this.baseColors.push(mat.color.getHex());
  }

  /**
   * World-space position of this creature's weak point, or null when it has
   * none. Hits landing near it deal `weakPointMultiplier` times damage.
   */
  weakPointAt(out: THREE.Vector3): THREE.Vector3 | null {
    const local = this.build.weakPoint;
    if (!local || !this.type.weakPointMultiplier) return null;
    const scale = this.build.group.scale.x;
    return out.set(
      this.pos.x + local.x * scale,
      this.pos.y + local.y * scale,
      this.pos.z + local.z * scale,
    );
  }

  /** Damage multiplier for a hit landing at this world position. */
  weakPointBonus(x: number, y: number, z: number): number {
    const multiplier = this.type.weakPointMultiplier;
    if (!multiplier) return 1;
    const point = this.weakPointAt(_weak);
    if (!point) return 1;
    const reach = Math.max(0.32, this.def.radius * 0.62);
    const dx = point.x - x;
    const dy = point.y - y;
    const dz = point.z - z;
    return dx * dx + dy * dy + dz * dz <= reach * reach ? multiplier : 1;
  }

  private ensureBar(): void {
    if (this.bar) return;
    const bar = new THREE.Group();
    const width = this.kind === 'guardian' ? 2.6 : 1.1;
    const bg = new THREE.Mesh(barBgGeo, barBgMaterial);
    bg.scale.set(width, 1, 1);
    bg.position.x = -width / 2;
    const fg = new THREE.Mesh(barFgGeo, barFgMaterial);
    fg.scale.set(width, 1, 1);
    fg.position.x = -width / 2;
    bar.add(bg, fg);
    bar.position.y = this.def.height + (this.kind === 'guardian' ? 1.4 : 0.7);
    bar.renderOrder = 2;
    this.group.add(bar);
    this.bar = bar;
    this.barFg = fg;
  }

  showBar(seconds = 3): void {
    this.ensureBar();
    this.barTimer = Math.max(this.barTimer, seconds);
  }

  /** How hard this creature is to move. Light ones are dragged by wind. */
  get knockbackResist(): number {
    return this.type.knockbackResist;
  }

  /**
   * Cancel an attack that is still winding up.
   *
   * Control abilities - Tidal Pull, a stun, a heavy stagger - use this so
   * interrupting a telegraphed swing is a real, visible outcome rather than
   * merely delaying it. Returns true when something was actually interrupted.
   */
  interrupt(): boolean {
    if (this.state !== 'telegraph') return false;
    this.telegraphTimer = 0;
    this.telegraphTotal = 0;
    this.pendingAttack = -1;
    this.state = 'hurt';
    this.stateTime = 0;
    return true;
  }

  damage(amount: number, element: ElementId | null, knockback: THREE.Vector3 | null, stagger = 0): number {
    if (!this.alive || this.state === 'dead') return 0;
    const mult = this.resistanceTo(element);
    this.lastHitBlocked = false;
    let dealt = Math.max(1, amount * mult * this.status.damageTakenScale);
    // A shielded elite soaks damage until its barrier breaks.
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, dealt);
      this.shield -= soaked;
      dealt -= soaked;
      if (dealt <= 0.01) {
        this.hurtFlash = 0.12;
        this.lastHitBlocked = true;
        this.showBar();
        return soaked;
      }
    }
    this.health -= dealt;
    this.hurtFlash = 0.16;
    this.showBar();
    this.awake = true;
    this.state = 'hurt';
    this.stateTime = 0;
    if (stagger > 0) this.staggerTimer = Math.max(this.staggerTimer, stagger * (1 - this.type.knockbackResist * 0.6));

    // Every creature acknowledges a hit, even armoured ones that shrug off the
    // push: a heavy enemy flinches less, but it always flinches.
    this.lastHitWasBig = dealt >= this.maxHealth * REACTION.bigHitFraction;
    this.flinchTimer = REACTION.flinchSeconds * (this.lastHitWasBig ? 1.5 : 1);
    if (knockback) {
      const len = Math.hypot(knockback.x, knockback.z) || 1;
      this.flinchX = knockback.x / len;
      this.flinchZ = knockback.z / len;
    }

    if (knockback) {
      const scale = 1 - this.type.knockbackResist;
      this.vel.addScaledVector(knockback, scale);
      if (this.kind !== 'wisp') this.vel.y = Math.max(this.vel.y, knockback.length() * 0.22 * scale);
    }
    if (this.health <= 0) {
      this.health = 0;
      this.state = 'dead';
      this.alive = false;
      this.deathTimer = 0.55;
    }
    return dealt;
  }

  /**
   * Damage multiplier this creature applies to an element.
   * 1 = normal, below 1 = resistant, near 0 = effectively immune.
   */
  resistanceTo(element: ElementId | null): number {
    // Clamped rather than raw: a creature may be a bad match for an element,
    // but it may never be something a focused adept simply cannot finish.
    return element ? effectiveResistance(this.kind, element) : 1;
  }

  applySlow(factor: number, seconds: number): void {
    this.slowFactor = Math.min(this.slowFactor, factor);
    this.slowTimer = Math.max(this.slowTimer, seconds);
    // Mirror it into the status set purely so the effect is named and visible;
    // the movement maths still comes from `slowFactor`.
    if (factor < 0.95) this.status.apply('slowed', seconds);
  }

  applyBurn(dps: number, seconds: number): void {
    this.burnDps = Math.max(this.burnDps, dps);
    this.burnTimer = Math.max(this.burnTimer, seconds);
  }

  applyFreeze(seconds: number): void {
    this.freezeTimer = Math.max(this.freezeTimer, seconds);
  }

  get center(): THREE.Vector3 {
    return _center.set(this.pos.x, this.pos.y + this.type.height * 0.55, this.pos.z);
  }

  /**
   * The volume attacks actually test against.
   *
   * A full-body vertical capsule, not a point at the middle of the creature -
   * that is what lets the player hit a brute's head or a crawler's feet
   * instead of only its exact centre.
   *
   * @param padding extra forgiveness for player attacks; enemy attacks pass 0.
   */
  hitCapsule(padding = AIM.hitboxPadding): Capsule {
    return bodyCapsule(
      this.pos.x, this.pos.y, this.pos.z,
      this.type.height, this.type.radius, padding,
    );
  }

  /** Body centre as a plain vector, for the aiming code. */
  centreVec(out: Vec3): Vec3 {
    out.x = this.pos.x;
    out.y = this.pos.y + this.type.height * 0.55;
    out.z = this.pos.z;
    return out;
  }

  /** True when a sphere of `radius` at `point` overlaps this creature. */
  overlapsSphere(point: Vec3, radius: number, padding = AIM.hitboxPadding): boolean {
    return sphereVsCapsule(point, radius, this.hitCapsule(padding));
  }

  /** Movement speed after elites and statuses. */
  get effectiveSpeed(): number {
    return this.type.speed * this.speedScale * this.slowFactor * this.status.moveScale;
  }

  /** Damage this creature deals after elites. */
  /**
   * What one of this creature's attacks actually deals.
   *
   * Capped as a fraction of the player's maximum health. Difficulty and elite
   * modifiers multiply together, and at depth an elite heavy could otherwise
   * take two thirds of the bar in a single swing - which is not difficulty,
   * it is a coin flip. Bosses are allowed a higher ceiling because their
   * wind-ups are longer and their markers are bigger.
   */
  attackDamage(base: number, difficulty: number, playerMaxHealth = 0): number {
    const raw = base * this.damageScale * difficulty;
    if (playerMaxHealth <= 0) return raw;
    const fraction = this.type.role === 'boss'
      ? INCOMING.maxBossHitFraction
      : INCOMING.maxHitFraction;
    return Math.min(raw, playerMaxHealth * fraction);
  }

  /** True when it cannot act right now. */
  get incapacitated(): boolean {
    return this.freezeTimer > 0 || this.staggerTimer > 0 || this.status.disabled;
  }

  updateVisual(dt: number, camera: THREE.Camera): void {
    this.phase += dt;
    this.group.position.set(this.pos.x, this.pos.y, this.pos.z);

    // Directional flinch: the body is visibly shoved along the hit direction
    // and springs back, so damage reads even when knockback is resisted.
    if (this.flinchTimer > 0) {
      this.flinchTimer = Math.max(0, this.flinchTimer - dt);
      const f = this.flinchTimer / REACTION.flinchSeconds;
      const push = Math.sin(Math.min(1, f) * Math.PI) * REACTION.flinchOffset
        * (this.lastHitWasBig ? 1.6 : 1);
      this.group.position.x += this.flinchX * push;
      this.group.position.z += this.flinchZ * push;
      // Heavy creatures rock rather than slide.
      this.build.group.rotation.z = this.flinchX * push * 0.5;
      this.build.group.rotation.x = this.flinchZ * push * 0.5;
    } else if (this.build.group.rotation.z !== 0 || this.build.group.rotation.x !== 0) {
      this.build.group.rotation.z *= 0.8;
      this.build.group.rotation.x *= 0.8;
      if (Math.abs(this.build.group.rotation.z) < 0.001) this.build.group.rotation.z = 0;
      if (Math.abs(this.build.group.rotation.x) < 0.001) this.build.group.rotation.x = 0;
    }

    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      const on = this.hurtFlash > 0;
      this.build.materials.forEach((m, i) => {
        m.emissiveIntensity = on ? 2.6 : (m === this.build.glow ? 2.8 : 0);
        if (on) m.emissive.setHex(0xffffff);
        else if (m === this.build.glow) m.emissive.setHex(this.accent);
        else { m.emissive.setHex(0x000000); m.color.setHex(this.baseColors[i] ?? m.color.getHex()); }
      });
    }

    // Status materials: frozen bodies go pale blue and glassy, wet ones darken
    // and gain a sheen, burning ones glow. The player can read the state from
    // the creature itself, not only from an icon.
    if (this.status.has('frozen') || this.freezeTimer > 0) {
      for (const m of this.build.materials) {
        m.color.lerp(_frozen, 0.12);
        m.roughness = Math.max(0.08, m.roughness * 0.9);
      }
    } else if (this.status.has('wet')) {
      for (const m of this.build.materials) {
        m.color.lerp(_wetTint, 0.05);
        m.roughness = Math.max(0.18, m.roughness * 0.95);
      }
    } else if (this.status.has('burning')) {
      for (const m of this.build.materials) m.emissive.lerp(_burnTint, 0.08);
    } else if (this.hurtFlash <= 0) {
      // Drift back to the resting look once nothing is affecting it.
      this.build.materials.forEach((m, i) => {
        const base = this.baseColors[i];
        if (base !== undefined) m.color.lerp(_restore.setHex(base), 0.06);
      });
    }

    const animated = this.build.animated;
    if (this.kind === 'crawler') {
      const speed = Math.min(1, Math.hypot(this.vel.x, this.vel.z) / this.def.speed);
      for (let i = 0; i < animated.length; i++) {
        animated[i]!.position.y = 0.26 + Math.sin(this.phase * 11 + i * 1.7) * 0.1 * speed;
      }
    } else if (this.kind === 'wisp') {
      const bob = Math.sin(this.phase * 1.9) * 0.18;
      this.group.position.y = this.pos.y + bob;
      for (const part of animated) {
        const orbit = part.userData.orbit as number | undefined;
        if (orbit === undefined) {
          part.rotation.y += dt * 1.3;
          part.rotation.x += dt * 0.8;
        } else {
          const a = orbit + this.phase * 2.1;
          part.position.set(Math.cos(a) * 0.66, 0.9 + Math.sin(a * 1.5) * 0.2, Math.sin(a) * 0.66);
          part.rotation.set(Math.cos(a) * 0.9, a, Math.sin(a) * 0.9);
        }
      }
    } else {
      for (let i = 0; i < animated.length; i++) {
        const part = animated[i]!;
        if (i < 2) {
          const swing = this.state === 'attack' ? Math.sin(this.stateTime * 14) * 0.95 : Math.sin(this.phase * 2 + i * 3) * 0.16;
          part.rotation.x = swing;
        } else {
          part.rotation.z += dt * (0.5 + i * 0.15);
          part.position.y = (i === 2 ? 4.3 : 4.05) + Math.sin(this.phase * 1.4 + i) * 0.14;
        }
      }
    }

    if (this.state === 'dead' || this.dissolving) {
      const t = Math.max(0, this.deathTimer / 0.55);
      this.group.scale.setScalar(Math.max(0.01, t));
      this.group.rotation.y += dt * 5;
    }

    if (this.bar) {
      this.barTimer -= dt;
      const visible = this.barTimer > 0 && this.state !== 'dead';
      this.bar.visible = visible;
      if (visible) {
        this.bar.quaternion.copy(camera.quaternion);
        const frac = Math.max(0, this.health / this.maxHealth);
        const width = this.kind === 'guardian' ? 2.6 : 1.1;
        this.barFg!.scale.x = width * frac;
      }
    }
  }

  faceTowards(x: number, z: number): void {
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    if (dx * dx + dz * dz < 0.0004) return;
    const target = Math.atan2(dx, dz) + Math.PI;
    let diff = target - this.group.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.group.rotation.y += diff * 0.2;
  }

  dispose(): void {
    for (const m of this.build.materials) m.dispose();
    this.group.clear();
  }
}

const _frozen = new THREE.Color(0x9fd8ff);
const _wetTint = new THREE.Color(0x2f6f9c);
const _burnTint = new THREE.Color(0xff6a1a);
const _restore = new THREE.Color();

interface Pickup {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  amount: number;
  life: number;
}

export class EnemyManager {
  readonly group = new THREE.Group();
  readonly enemies: Enemy[] = [];
  private pickups: Pickup[] = [];
  private spawnTimer = 3;
  private pickupGeo = geoPickup();
  private pickupMat = new THREE.MeshStandardMaterial({
    color: 0x63e6d2,
    emissive: new THREE.Color(0x2ea391),
    emissiveIntensity: 2.4,
    roughness: 0.3,
  });
  private cleansed: readonly boolean[] = [false, false, false, false];
  private mode: WorldMode = 'normal';
  /** Ramps back up after leaving Peaceful Mode so nothing appears on top of the player. */
  private resumeGrace = 0;
  /** Creature kinds the current world may spawn. */
  private roster: EnemyKind[] = ['crawler', 'wisp'];
  /** Chance a spawn is promoted to an elite. */
  eliteChance = 0.08;
  /** Difficulty health multiplier. */
  healthScale = 1;

  maxEnemies = ENCOUNTER.maxWanderers;
  kills = 0;
  /** Fairness rules: attack tokens, rear telegraphs, safe spawn distance. */
  readonly director = new CombatDirector();
  /** Pacing: when an encounter opens, how big it is, and when the world rests. */
  readonly encounter = new EncounterDirector();
  /** Why the last spawn attempt was refused. Debug overlay only. */
  private lastRefusal: string | null = null;
  /** Why the last candidate point was rejected. Debug overlay only. */
  private lastSpawnRejection: string | null = null;

  constructor(private readonly ctx: EnemyContext) {
    this.group.name = 'enemies';
  }

  setCleansed(flags: readonly boolean[]): void {
    this.cleansed = flags;
  }

  /** Configure the spawn table for the current world and run depth. */
  setRoster(kinds: readonly EnemyKind[], unlocked: ReadonlySet<string>): void {
    const legal = kinds.filter((k) => {
      const u = ENEMY_TYPES[k].unlock;
      return !u || unlocked.has(u);
    });
    this.roster = legal.length > 0 ? [...legal] : ['crawler', 'wisp'];
  }

  setDifficulty(healthScale: number, eliteChance: number, depth: number): void {
    this.healthScale = healthScale;
    this.eliteChance = eliteChance;
    this.director.setDepth(depth);
    this.encounter.setDepth(depth);
  }

  /** Pacing state, for the HUD-free debug overlay and the tests. */
  get encounterStatus(): EncounterStatus {
    return this.encounter.status;
  }

  /** Why nothing spawned last tick. Debug overlay only; never player-facing. */
  get spawnDiagnostics(): { refusal: string | null; rejection: string | null } {
    return { refusal: this.lastRefusal, rejection: this.lastSpawnRejection };
  }

  /**
   * Hold the world quiet for a while.
   *
   * Used by story beats, reward screens and world transitions, so combat can
   * never start on top of a screen the player is reading.
   */
  holdSpawning(seconds: number): void {
    this.encounter.hold(seconds);
    this.resumeGrace = Math.max(this.resumeGrace, seconds);
  }

  get worldMode(): WorldMode {
    return this.mode;
  }

  get peaceful(): boolean {
    return this.mode === 'peaceful';
  }

  /**
   * Switch world mode.
   *
   * Turning Peaceful on dissolves every hostile creature and cancels their
   * projectiles. Turning it off resumes spawning only after a grace period, so
   * the player is never instantly surrounded.
   */
  setMode(mode: WorldMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'peaceful') {
      this.dissolveAll();
      this.ctx.projectiles.clearOwner('enemy');
      this.encounter.reset();
    } else {
      this.resumeGrace = 6;
      this.spawnTimer = 4;
      // Leaving Peaceful Mode starts from a clean exploration phase rather
      // than resuming whatever encounter was open before.
      this.encounter.reset();
      this.encounter.hold(6);
    }
  }

  /** Fade every hostile creature out safely, without granting kills or drops. */
  dissolveAll(): void {
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.alive = false;
      enemy.dissolving = true;
      enemy.state = 'dead';
      enemy.deathTimer = 0.45;
      // Mark harvested so no loot, kill credit or guardian event fires.
      enemy.group.userData.harvested = true;
      this.ctx.particles.spark({
        count: 20, x: enemy.pos.x, y: enemy.pos.y + enemy.def.height * 0.5, z: enemy.pos.z,
        spread: 0.6, jitter: 2.4, color: 0xbfe8ff, color2: 0xffffff,
        size: 0.34, life: 0.8, gravity: 1.2, drag: 0.8,
      });
    }
  }

  spawn(
    kind: EnemyKind, position: THREE.Vector3, accent: number, healthScale = 1,
    elites: readonly EliteId[] = [],
  ): Enemy {
    const enemy = new Enemy(kind, position, accent, healthScale, elites);
    this.enemies.push(enemy);
    this.group.add(enemy.group);
    return enemy;
  }

  /** Spawn a creature and possibly promote it to an elite. */
  spawnMaybeElite(
    kind: EnemyKind, position: THREE.Vector3, eliteChance: number, healthScale = 1,
  ): Enemy {
    const type = ENEMY_TYPES[kind];
    const elites = Math.random() < eliteChance
      ? rollElites(kind, Math.random() < 0.25 ? 2 : 1)
      : [];
    return this.spawn(kind, position, type.accent, healthScale, elites);
  }

  spawnGuardian(shrineIndex: number, position: THREE.Vector3): Enemy | null {
    if (this.peaceful) return null;
    const site = SHRINE_SITES[shrineIndex]!;
    const guardian = this.spawn('guardian', position, ELEMENTS[site.element].color, 1);
    guardian.shrineIndex = shrineIndex;
    guardian.showBar(6);
    return guardian;
  }

  hasGuardian(shrineIndex: number): boolean {
    return this.enemies.some((e) => e.shrineIndex === shrineIndex && e.alive);
  }

  get liveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  /** True when a live hostile is close enough to count as combat pressure. */
  hostilePressure(point: THREE.Vector3, radius = 26): boolean {
    if (this.peaceful) return false;
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.state === 'idle') continue;
      if (e.pos.distanceToSquared(point) <= r2) return true;
    }
    return false;
  }

  /** Nearest creature whose body is within `range` of a point. */
  nearest(point: THREE.Vector3, range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestD = Infinity;
    _probe.x = point.x; _probe.y = point.y; _probe.z = point.z;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (!e.overlapsSphere(_probe, range)) continue;
      const d = e.center.distanceToSquared(point);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /**
   * Creatures whose *body* overlaps a sphere.
   *
   * Tests the full capsule rather than the centre point, so an area effect
   * catches anything it visually covers.
   */
  within(point: THREE.Vector3, radius: number, out: Enemy[]): Enemy[] {
    out.length = 0;
    _probe.x = point.x; _probe.y = point.y; _probe.z = point.z;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.overlapsSphere(_probe, radius)) out.push(e);
    }
    return out;
  }

  /** Every live creature, for the aiming and debug layers. */
  get live(): readonly Enemy[] {
    return this.enemies;
  }

  /** Attack-token state, surfaced for the HUD and the combat debug overlay. */
  get tokens(): { used: number; max: number } {
    return { used: this.director.activeAttackers, max: this.director.maxTokens };
  }

  update(dt: number, playerPos: THREE.Vector3, playerAlive: boolean): void {
    this.director.update(dt);
    if (this.resumeGrace > 0) this.resumeGrace = Math.max(0, this.resumeGrace - dt);
    this.updateSpawning(dt, playerPos, playerAlive);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]!;

      if (e.state === 'dead') {
        e.deathTimer -= dt;
        e.updateVisual(dt, this.ctx.camera);
        if (e.deathTimer <= 0) {
          this.group.remove(e.group);
          e.dispose();
          this.enemies.splice(i, 1);
        }
        continue;
      }

      this.updateStatus(e, dt);
      if (playerAlive) this.updateAI(e, dt, playerPos);
      else e.state = 'idle';
      this.updatePhysics(e, dt);
      e.updateVisual(dt, this.ctx.camera);

      if (e.shrineIndex < 0 && this.recoverIfStranded(e, dt, playerPos)) {
        this.group.remove(e.group);
        e.dispose();
        this.enemies.splice(i, 1);
      }
    }

    this.updatePickups(dt, playerPos);
  }

  /**
   * Remove a creature that can no longer take part in the fight.
   *
   * Terrain is destructible, so a creature can end up walled into a pit it
   * cannot climb, or on the wrong side of a ridge, chasing a player it will
   * never reach. Rather than leave it grinding against a rock forever it is
   * quietly removed - without kill credit, without loot and without touching
   * the encounter budget, so there is nothing here to farm.
   *
   * Returns true when the creature should be taken out of the world.
   */
  private recoverIfStranded(e: Enemy, dt: number, playerPos: THREE.Vector3): boolean {
    const distance = e.pos.distanceTo(playerPos);
    const chasing = e.alive && (e.state === 'chase' || e.state === 'detect');
    if (chasing) {
      // "Progress" is the closest this creature has ever managed to get. A
      // creature that is genuinely circling keeps beating its own record; one
      // stuck behind terrain never does.
      if (distance < e.bestApproach - 0.75) {
        e.bestApproach = distance;
        e.noProgressTimer = 0;
      } else {
        e.noProgressTimer += dt;
      }
    } else {
      e.noProgressTimer = 0;
      e.bestApproach = Math.min(e.bestApproach, distance);
    }
    if (!isStranded(e.noProgressTimer, distance, chasing)) return false;
    // Anything that is still alive is marked harvested first, so removal can
    // never pay out a kill, a drop or an encounter credit.
    if (e.alive) {
      e.alive = false;
      e.state = 'dead';
      e.group.userData.harvested = true;
      this.director.releaseOwner(e.uid);
    }
    return true;
  }

  private updateStatus(e: Enemy, dt: number): void {
    if (e.slowTimer > 0) {
      e.slowTimer -= dt;
      if (e.slowTimer <= 0) e.slowFactor = 1;
    }
    if (e.freezeTimer > 0) {
      e.freezeTimer -= dt;
      if (e.freezeTimer > 0 && Math.random() < dt * 6) {
        this.ctx.particles.spark({
          count: 1, x: e.pos.x, y: e.pos.y + e.def.height * 0.6, z: e.pos.z,
          spread: 0.4, jitter: 0.3, color: 0xbfe8ff, size: 0.2, life: 0.5, gravity: -1,
        });
      }
    }
    if (e.burnTimer > 0) {
      e.burnTimer -= dt;
      e.health -= e.burnDps * dt;
      if (Math.random() < dt * 9) {
        this.ctx.particles.spark({
          count: 1, x: e.pos.x, y: e.pos.y + e.def.height * 0.5, z: e.pos.z,
          spread: 0.35, vy: 1.4, jitter: 0.4, color: 0xff9b3d, color2: 0xffe08a,
          size: 0.24, life: 0.45, gravity: 1.2,
        });
      }
      if (e.health <= 0) this.kill(e);
      if (e.burnTimer <= 0) e.burnDps = 0;
    }
    if (e.staggerTimer > 0) e.staggerTimer -= dt;
    if (e.attackTimer > 0) e.attackTimer -= dt;
    e.stateTime += dt;

    // ---- status effects
    e.status.tick(dt, _expired);
    const dot = e.status.damageOverTime;
    if (dot > 0) {
      e.health -= dot * dt;
      if (e.health <= 0) this.kill(e);
    }

    // ---- elite behaviours
    if (e.elites.includes('regenerating') && e.alive && e.health < e.maxHealth) {
      e.health = Math.min(e.maxHealth, e.health + e.maxHealth * 0.035 * dt);
    }
    if (e.shield < e.maxShield && e.alive) {
      e.shield = Math.min(e.maxShield, e.shield + e.maxShield * 0.08 * dt);
    }
  }

  /**
   * Ask the director for permission and start a wind-up.
   *
   * Returns true when the attack was committed. The hit itself lands later, in
   * `resolveTelegraph`, once the player has had time to react.
   */
  private beginAttack(e: Enemy, attackIndex: number, playerPos: THREE.Vector3): boolean {
    const attack = e.type.attacks[attackIndex];
    if (!attack) return false;

    _tmpA.set(e.pos.x - playerPos.x, 0, e.pos.z - playerPos.z);
    const len = _tmpA.length() || 1;
    _tmpA.divideScalar(len);
    const fwd = this.ctx.getPlayerForward();
    const inFront = this.director.isInFront(_tmpA.x, _tmpA.z, fwd.x, fwd.z);

    const category = attackCategoryOf(attack, e.type.role);
    const grant = category === null
      ? this.director.requestUncontested(attack.telegraph, inFront)
      : this.director.request(e.uid, attack.telegraph, inFront, category);
    if (!grant.granted) {
      // Denied attackers do not stand and stare: they go and make themselves a
      // problem somewhere else while they wait for an opening.
      e.seekingPosition = true;
      return false;
    }
    e.seekingPosition = false;

    e.pendingAttack = attackIndex;
    e.telegraphTotal = grant.telegraph;
    e.telegraphTimer = grant.telegraph;
    e.attackToken = grant.token;
    e.state = 'telegraph';
    e.stateTime = 0;
    e.attackTimer = attack.cooldown + grant.telegraph;

    // The audio cue always plays; it is the fallback warning when off-screen.
    this.ctx.audio.play('enemy-attack', 40);
    if (grant.needsWarning) this.ctx.offscreenWarning(e.pos.x, e.pos.z);

    if (attack.markerRadius > 0) {
      const target = attack.shape === 'projectile'
        ? _tmpB.copy(playerPos)
        : _tmpB.copy(e.pos).addScaledVector(_tmpA, -attack.range * 0.5);
      this.ctx.telegraph(
        target.x, this.ctx.world.groundHeight(target.x, target.z) + 0.05, target.z,
        attack.markerRadius, grant.telegraph, e.type.accent,
      );
    }
    return true;
  }

  /** Land a telegraphed attack once its wind-up has elapsed. */
  private resolveTelegraph(e: Enemy, playerPos: THREE.Vector3): void {
    const attack = e.type.attacks[e.pendingAttack];
    e.pendingAttack = -1;
    this.director.release(e.attackToken);
    e.attackToken = -1;
    e.state = 'attack';
    e.stateTime = 0;
    if (!attack) return;

    const difficulty = this.ctx.difficulty();
    const maxHealth = this.ctx.playerMaxHealth?.() ?? 0;
    const dist = e.pos.distanceTo(playerPos);
    _dir.set(playerPos.x - e.pos.x, 0, playerPos.z - e.pos.z);
    const flat = _dir.length() || 1;
    _dir.divideScalar(flat);

    switch (attack.shape) {
      case 'projectile': {
        _tmpA.set(e.pos.x, e.pos.y + e.type.height * 0.7, e.pos.z);
        _tmpB.copy(this.ctx.getPlayerPosition()).sub(_tmpA).normalize();
        const shots = e.kind === 'boss-maw' ? 5 : 1;
        for (let i = 0; i < shots; i++) {
          const spread = shots === 1 ? 0 : (i - (shots - 1) / 2) * 0.14;
          const dir = _tmpB.clone().applyAxisAngle(_up, spread);
          this.ctx.projectiles.spawn({
            kind: e.kind === 'slinger' ? 'orb' : 'bolt', owner: 'enemy',
            origin: _tmpA.clone(), direction: dir,
            speed: e.kind === 'slinger' ? 15 : 11,
            damage: e.attackDamage(attack.damage, difficulty, maxHealth),
            radius: 0.5, life: 3.4, color: e.type.accent,
          });
        }
        this.ctx.audio.play('enemy-shoot', 60);
        break;
      }
      case 'area': {
        if (e.kind === 'warden') { this.summonFor(e); break; }
        if (e.kind === 'mender') { this.mendAround(e); break; }
        this.ctx.particles.debris({
          count: 40, x: e.pos.x, y: e.pos.y + 0.25, z: e.pos.z, spread: attack.markerRadius * 0.5,
          jitter: 7, vy: 3.4, color: 0x7a5a36, color2: e.type.accent,
          size: 0.26, life: 0.9, gravity: -13, drag: 0.55,
        });
        if (dist < attack.markerRadius) {
          this.ctx.damagePlayer(e.attackDamage(attack.damage, difficulty, maxHealth), e.pos, attack.knockback);
          this.director.notifyLanded();
        } else if (dist < attack.markerRadius * 1.5) {
          this.ctx.onNearMiss?.();
        }
        if (e.kind === 'sapper') this.kill(e);
        break;
      }
      case 'cone': {
        if (dist < attack.range) {
          this.ctx.damagePlayer(e.attackDamage(attack.damage, difficulty, maxHealth), e.pos, attack.knockback);
          this.director.notifyLanded();
        } else if (dist < attack.range * 1.5) {
          this.ctx.onNearMiss?.();
        }
        this.ctx.particles.spark({
          count: 30, x: e.pos.x + _dir.x * 2, y: e.pos.y + e.type.height * 0.5, z: e.pos.z + _dir.z * 2,
          spread: 1.4, jitter: 4.5, color: e.type.accent, color2: 0xffffff,
          size: 0.4, life: 0.5, gravity: -2,
        });
        break;
      }
      default: {
        if (dist < attack.range + 0.6) {
          this.ctx.damagePlayer(e.attackDamage(attack.damage, difficulty, maxHealth), e.pos, attack.knockback);
          this.director.notifyLanded();
        } else if (dist < (attack.range + 0.6) * 1.5) {
          this.ctx.onNearMiss?.();
        }
        this.ctx.particles.spark({
          count: 12, x: e.pos.x + _dir.x, y: e.pos.y + 0.7, z: e.pos.z + _dir.z, spread: 0.5,
          jitter: 2.6, color: e.type.accent, size: 0.26, life: 0.35, gravity: -2,
        });
        break;
      }
    }
  }

  /** Warden behaviour: call reinforcements to its side. */
  private summonFor(e: Enemy): void {
    // Reinforcements are finite. A Warden left alone used to call crawlers
    // forever, which is the single easiest way to turn an encounter into an
    // endless one: each Warden now has a fixed allowance, and the population
    // ceiling applies to summons exactly as it does to spawns.
    if (e.summonsLeft <= 0) return;
    if (this.wandererCount() >= ENCOUNTER.maxWanderers) return;
    e.summonsLeft -= 1;
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2;
      const x = e.pos.x + Math.cos(a) * 3;
      const z = e.pos.z + Math.sin(a) * 3;
      const y = this.ctx.world.groundHeight(x, z) + 0.3;
      this.spawn('crawler', _tmpA.set(x, y, z), ENEMY_TYPES.crawler.accent);
    }
    this.ctx.particles.spark({
      count: 40, x: e.pos.x, y: e.pos.y + 1.4, z: e.pos.z, spread: 1.4, jitter: 4,
      color: e.type.accent, color2: 0xffffff, size: 0.4, life: 1, gravity: 1.6,
    });
  }

  /** Mender behaviour: knit nearby allies back together. */
  private mendAround(e: Enemy): void {
    for (const other of this.enemies) {
      if (!other.alive || other === e) continue;
      if (other.pos.distanceTo(e.pos) > 14) continue;
      other.health = Math.min(other.maxHealth, other.health + other.maxHealth * 0.22);
      other.showBar(2);
      this.ctx.particles.spark({
        count: 12, x: other.pos.x, y: other.pos.y + other.type.height * 0.6, z: other.pos.z,
        spread: 0.5, jitter: 1.6, vy: 2, color: 0x63e6d2, size: 0.3, life: 0.8, gravity: 1,
      });
    }
  }

  private updateAI(e: Enemy, dt: number, playerPos: THREE.Vector3): void {
    // Wind-ups resolve regardless of what else the creature wants to do.
    if (e.state === 'telegraph') {
      e.telegraphTimer -= dt;
      e.faceTowards(playerPos.x, playerPos.z);
      // Being frozen or stunned mid-wind-up cancels the attack entirely.
      if (e.incapacitated) {
        e.state = 'hurt';
        e.pendingAttack = -1;
        this.director.release(e.attackToken);
        e.attackToken = -1;
        return;
      }
      if (e.telegraphTimer <= 0) this.resolveTelegraph(e, playerPos);
      return;
    }

    const dist = e.pos.distanceTo(playerPos);
    const frozen = e.freezeTimer > 0;
    const staggered = e.staggerTimer > 0;

    if (e.kind === 'guardian' && !e.awake) {
      if (dist < e.def.detectRange) {
        e.awake = true;
        e.state = 'detect';
        e.stateTime = 0;
        this.ctx.audio.play('shrine-wake');
      } else {
        return;
      }
    }

    switch (e.state) {
      case 'idle': if (dist < e.def.detectRange) { e.state = 'detect'; e.stateTime = 0; } break;
      case 'detect': if (e.stateTime > 0.35) { e.state = 'chase'; e.stateTime = 0; } break;
      case 'hurt': if (e.stateTime > 0.22) { e.state = 'chase'; e.stateTime = 0; } break;
      case 'attack': if (e.stateTime > 0.45) { e.state = 'chase'; e.stateTime = 0; } break;
      case 'chase': if (dist > e.def.loseRange && e.shrineIndex < 0) { e.state = 'idle'; e.stateTime = 0; } break;
      default: break;
    }

    if (frozen || staggered) {
      e.vel.x *= 0.82;
      e.vel.z *= 0.82;
      return;
    }

    const speed = e.effectiveSpeed;
    e.faceTowards(playerPos.x, playerPos.z);

    if (e.state === 'idle') {
      e.vel.x += Math.sin(e.stateTime * 0.6 + e.pos.x) * 0.4 * dt;
      e.vel.z += Math.cos(e.stateTime * 0.5 + e.pos.z) * 0.4 * dt;
      return;
    }
    if (e.state === 'detect') return;

    _dir.set(playerPos.x - e.pos.x, 0, playerPos.z - e.pos.z);
    const flat = _dir.length();
    if (flat > 0.001) _dir.divideScalar(flat);

    switch (e.kind) {
      case 'crawler': {
        if (dist > e.def.attackRange * 0.85) {
          e.vel.x += _dir.x * speed * 9 * dt;
          e.vel.z += _dir.z * speed * 9 * dt;
          this.tryHop(e);
        } else if (e.seekingPosition || e.attackTimer > 0) {
          // Denied a token, or between swings: keep working the angle rather
          // than standing in place looking broken.
          this.pressureMove(e, dt, speed, dist);
        }
        if (dist < e.def.attackRange && e.attackTimer <= 0) {
          this.beginAttack(e, 0, playerPos);
        }
        break;
      }
      case 'wisp': {
        const desired = 9;
        const hoverY = this.ctx.world.groundHeight(e.pos.x, e.pos.z) + 3.4;
        e.vel.y += (hoverY - e.pos.y) * 2.4 * dt;
        e.vel.y *= 0.92;
        const push = dist > desired + 1.5 ? 1 : dist < desired - 1.5 ? -1 : 0;
        e.vel.x += _dir.x * speed * push * 6 * dt;
        e.vel.z += _dir.z * speed * push * 6 * dt;
        e.vel.x += -_dir.z * speed * 1.6 * dt * Math.sin(e.stateTime * 0.9);
        e.vel.z += _dir.x * speed * 1.6 * dt * Math.sin(e.stateTime * 0.9);

        if (dist < e.def.attackRange && e.attackTimer <= 0) {
          this.beginAttack(e, 0, playerPos);
        }
        break;
      }
      default: {
        // Everything else: close to its preferred standoff, then commit to a
        // telegraphed attack chosen from its own move list.
        const standoff = e.type.standoff;
        if (standoff > 0) {
          const push = dist > standoff + 2 ? 1 : dist < standoff - 2 ? -1 : 0;
          e.vel.x += _dir.x * speed * push * 6 * dt;
          e.vel.z += _dir.z * speed * push * 6 * dt;
          if ((e.seekingPosition || e.attackTimer > 0) && push === 0) {
            this.pressureMove(e, dt, speed, dist);
          }
        } else if (dist > e.def.attackRange * 0.8) {
          e.vel.x += _dir.x * speed * 7 * dt;
          e.vel.z += _dir.z * speed * 7 * dt;
          this.tryHop(e);
        } else if (e.seekingPosition || e.attackTimer > 0) {
          this.pressureMove(e, dt, speed, dist);
        }

        if (e.attackTimer <= 0) {
          // Pick an attack that is actually in range, cycling for variety.
          const attacks = e.type.attacks;
          let chosen = -1;
          for (let i = 0; i < attacks.length; i++) {
            const idx = (e.attackPhase + i) % attacks.length;
            const a = attacks[idx]!;
            if (dist <= a.range + (a.shape === 'melee' ? 0.8 : 0)) { chosen = idx; break; }
          }
          if (chosen >= 0) {
            e.attackPhase = (chosen + 1) % attacks.length;
            this.beginAttack(e, chosen, playerPos);
          }
        }
        break;
      }
    }
  }

  /**
   * What a creature does while the director is refusing it an attack.
   *
   * The attack-token rule is what keeps a first-person fight fair, but a
   * creature that simply freezes while it waits for a token reads as broken.
   * Instead it keeps working: it circles for a flank, drifts in and out of its
   * own reach, and stays visibly interested in the player. It is still a
   * threat to walk backwards into - it just is not swinging yet.
   *
   * `_dir` is the normalised direction from the creature to the player, set by
   * the caller, so this adds no square roots of its own.
   */
  private pressureMove(e: Enemy, dt: number, speed: number, dist: number): void {
    // Strafe around the player, perpendicular to the line between them.
    const sideX = -_dir.z * e.circleSign;
    const sideZ = _dir.x * e.circleSign;
    e.vel.x += sideX * speed * 4.5 * dt;
    e.vel.z += sideZ * speed * 4.5 * dt;

    // Hold a comfortable ring: press in when it drifts wide, give ground when
    // it is close enough to be crowding, so the player is never boxed in by
    // creatures that cannot act.
    const ring = Math.max(2.2, e.def.attackRange * 0.95);
    const radial = dist > ring + 1.2 ? 1 : dist < ring - 0.8 ? -1 : 0;
    if (radial !== 0) {
      e.vel.x += _dir.x * speed * radial * 3 * dt;
      e.vel.z += _dir.z * speed * radial * 3 * dt;
    }

    // Occasionally switch which way it circles, so a denied creature does not
    // orbit forever in one direction.
    if (e.stateTime > 2.6) {
      e.circleSign = -e.circleSign;
      e.stateTime = 0;
    }
  }

  /** Hop when a slope or ridge is too steep to walk up. */
  private tryHop(e: Enemy): void {
    if (!e.onGround || e.kind === 'wisp') return;
    _tmpA.set(e.vel.x, 0, e.vel.z);
    if (_tmpA.lengthSq() < 0.2) return;
    _tmpA.normalize().multiplyScalar(e.def.radius + 0.6);
    const fx = e.pos.x + _tmpA.x;
    const fz = e.pos.z + _tmpA.z;
    if (this.ctx.world.isSolid(fx, e.pos.y + 0.6, fz) && !this.ctx.world.isSolid(fx, e.pos.y + 1.8, fz)) {
      e.vel.y = 7.4;
    }
  }

  /**
   * Continuous collision against the density field: integrate, then push out
   * of any penetration along the surface normal.
   */
  private updatePhysics(e: Enemy, dt: number): void {
    const world = this.ctx.world;
    const drag = e.kind === 'wisp' ? 2.6 : 9;
    e.vel.x -= e.vel.x * Math.min(1, drag * dt);
    e.vel.z -= e.vel.z * Math.min(1, drag * dt);

    if (e.kind !== 'wisp') {
      e.vel.y -= 26 * dt;
      if (e.vel.y < -45) e.vel.y = -45;
    }

    e.pos.addScaledVector(e.vel, dt);

    e.onGround = false;
    const r = e.def.radius;
    const samples: [number, number][] = [[0.25, r * 0.8], [e.def.height * 0.55, r], [e.def.height * 0.95, r * 0.7]];
    for (let iter = 0; iter < 4; iter++) {
      let deepest = 0;
      let hitY = 0;
      let found = false;
      for (const [oy] of samples) {
        const d = world.densityAt(e.pos.x, e.pos.y + oy, e.pos.z);
        if (d > deepest) { deepest = d; hitY = oy; found = true; }
      }
      if (!found || deepest <= 0) break;
      world.normalAt(e.pos.x, e.pos.y + hitY, e.pos.z, _normal);
      e.pos.addScaledVector(_normal, Math.min(0.6, deepest * 0.5 + 0.05));
      if (_normal.y > 0.4) {
        e.onGround = true;
        if (e.vel.y < 0) e.vel.y = 0;
      }
      const into = e.vel.dot(_normal);
      if (into < 0) e.vel.addScaledVector(_normal, -into);
    }

    // Ground probe for creatures that walk.
    if (e.kind !== 'wisp' && !e.onGround) {
      if (world.isSolid(e.pos.x, e.pos.y - 0.12, e.pos.z)) {
        e.onGround = true;
        if (e.vel.y < 0) e.vel.y = 0;
      }
    }

    e.pos.x = Math.min(WORLD_SIZE - 2, Math.max(2, e.pos.x));
    e.pos.z = Math.min(WORLD_SIZE - 2, Math.max(2, e.pos.z));
    if (e.pos.y < 1) {
      e.pos.y = world.groundHeight(e.pos.x, e.pos.z) + 0.5;
      e.vel.y = 0;
    }
  }

  // ------------------------------------------------------------ spawning

  private updateSpawning(dt: number, playerPos: THREE.Vector3, playerAlive: boolean): void {
    // Peaceful Mode never spawns anything hostile, and the director is held in
    // its quiet state so nothing can be mid-encounter when the mode flips.
    const peaceful = this.peaceful;
    const wanderers = this.wandererCount();

    this.encounter.update(dt, this.signals(playerPos, playerAlive, wanderers, peaceful));
    if (peaceful || !playerAlive) return;
    if (this.resumeGrace > 0) return;

    // A short cadence between attempts: the director decides *whether*, this
    // decides how often it is asked.
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.75;

    const signals = this.signals(playerPos, playerAlive, wanderers, peaceful);
    const verdict = this.encounter.requestSpawn(signals);
    this.lastRefusal = verdict.allowed ? null : (verdict.reason ?? null);
    if (!verdict.allowed || verdict.threat <= 0) return;

    const fromReinforcement = this.encounter.status.budgetLeft <= 0;
    const placed = this.placeGroup(playerPos, verdict.threat);
    if (placed > 0) this.encounter.spend(placed, fromReinforcement);
  }

  /** Live creatures that belong to the wandering population, not to a shrine. */
  private wandererCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive && e.shrineIndex < 0) n++;
    return n;
  }

  /** Assemble the pacing inputs the encounter director reasons about. */
  private signals(
    playerPos: THREE.Vector3, playerAlive: boolean, wanderers: number, peaceful: boolean,
  ): EncounterSignals {
    return {
      liveEnemies: wanderers,
      engaged: this.hostilePressure(playerPos, 26),
      healthFraction: this.ctx.playerHealthFraction?.() ?? 1,
      playing: this.ctx.isPlaying?.() ?? true,
      playerReady: playerAlive && !(this.ctx.isProtected?.() ?? false),
      peaceful,
      scenarioDriven: this.ctx.scenarioDriven?.() ?? false,
      locationPressure: this.locationPressure(playerPos),
    };
  }

  /**
   * How much the surroundings want a fight to happen here.
   *
   * Standing near an uncleansed shrine is the game telling the player where
   * the trouble is, so the exploration timer is allowed to run short there and
   * long out in the open. That is the difference between "an encounter every
   * 30-60 seconds" and "an encounter every 30-60 seconds *for a reason*".
   */
  private locationPressure(playerPos: THREE.Vector3): number {
    let pressure = 0;
    for (const site of SHRINE_SITES) {
      if (this.cleansed[site.index]) continue;
      const d = Math.hypot(playerPos.x - site.x, playerPos.z - site.z);
      if (d < 70) pressure = Math.max(pressure, 1 - d / 70);
    }
    return pressure;
  }

  /**
   * Place a group worth roughly `threat` points of creatures.
   *
   * Returns the threat actually placed, which may be less than requested when
   * no valid ground could be found - the budget is only charged for creatures
   * that really exist.
   */
  private placeGroup(playerPos: THREE.Vector3, threat: number): number {
    const roster = this.roster.length > 0 ? this.roster : (['crawler', 'wisp'] as EnemyKind[]);
    // Prefer a creature the budget can actually afford; fall back to the
    // cheapest in the roster rather than overspending on a single heavy.
    const affordable = roster.filter((k) => ENEMY_TYPES[k].threat <= threat + 0.01);
    const pool = affordable.length > 0 ? affordable : [
      roster.reduce((a, b) => (ENEMY_TYPES[a].threat <= ENEMY_TYPES[b].threat ? a : b)),
    ];
    const kind = pool[Math.floor(Math.random() * pool.length)]!;
    const type = ENEMY_TYPES[kind];

    const point = this.findSpawnPoint(playerPos, type);
    if (!point) return 0;

    // Only light skirmishers travel in packs, and never more of them than the
    // remaining budget pays for.
    const maxPack = Math.max(1, Math.floor(threat / Math.max(0.5, type.threat)));
    const packSize = type.threat <= 1.2 && maxPack > 1 && Math.random() < 0.4
      ? Math.min(maxPack, 2 + Math.floor(Math.random() * 2))
      : 1;

    let spent = 0;
    for (let i = 0; i < packSize; i++) {
      if (this.wandererCount() >= ENCOUNTER.maxWanderers) break;
      _tmpA.copy(point);
      _tmpA.x += (Math.random() - 0.5) * 3;
      _tmpA.z += (Math.random() - 0.5) * 3;
      _tmpA.y = this.ctx.world.groundHeight(_tmpA.x, _tmpA.z) + 0.3;
      if (type.locomotion === 'hover') _tmpA.y += 2.6;
      this.spawnMaybeElite(kind, _tmpA, this.eliteChance, this.healthScale);
      spent += type.threat;
    }
    return spent;
  }

  /** A probe over the live world, used by the spawn validator. */
  private spawnProbe(): SpawnWorldProbe {
    const world = this.ctx.world;
    const eye = this.ctx.getPlayerPosition();
    return {
      groundHeight: (x, z) => world.groundHeight(x, z),
      isSolid: (x, y, z) => world.isSolid(x, y, z),
      hasLineOfSight: (x, y, z) => {
        _tmpB.set(x - eye.x, y - (eye.y + 1.6), z - eye.z);
        const distance = _tmpB.length();
        if (distance < 0.001) return true;
        _tmpB.divideScalar(distance);
        _losOrigin.set(eye.x, eye.y + 1.6, eye.z);
        // No hit along the segment means nothing is in the way.
        return world.raycast(_losOrigin, _tmpB, distance - 0.5) === null;
      },
      fluidLevel: world.fluidLevel,
      fluidIsHazard: world.fluidIsHazard,
      isObstacle: (x, y, z) => this.ctx.isObstacle?.(x, y, z, 0.6, 1.8) ?? false,
      distanceToProtected: (x, z) => {
        // The starting plaza and every shrine are kept clear.
        let best = Math.max(0, Math.hypot(x - WORLD_CENTER, z - WORLD_CENTER) - SPAWN_PLAZA_RADIUS);
        for (const site of SHRINE_SITES) {
          best = Math.min(best, Math.hypot(x - site.x, z - site.z));
        }
        return best;
      },
    };
  }

  /**
   * Somewhere a creature can legitimately have walked out of.
   *
   * Every candidate goes through the full validator: distance, view cone, line
   * of sight, terrain clearance, water, lava, obstacles, protected structures
   * and reachability. Nothing is placed that fails any one of them.
   */
  private findSpawnPoint(playerPos: THREE.Vector3, type: EnemyTypeDef): THREE.Vector3 | null {
    const probe = this.spawnProbe();
    const fwd = this.ctx.getPlayerForward();
    const flying = type.locomotion === 'hover';
    for (let attempt = 0; attempt < SPAWN.attempts; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = SPAWN.minOccludedFrontDistance
        + Math.random() * (SPAWN.maxDistance - SPAWN.minOccludedFrontDistance);
      const x = playerPos.x + Math.cos(angle) * radius;
      const z = playerPos.z + Math.sin(angle) * radius;
      const check = validateSpawn(
        {
          x,
          z,
          playerX: playerPos.x,
          playerY: playerPos.y,
          playerZ: playerPos.z,
          forwardX: fwd.x,
          forwardZ: fwd.z,
          frontHalfAngle: DEFAULT_DIRECTOR.frontHalfAngle,
          flying,
        },
        probe,
        WORLD_SIZE,
      );
      if (!check.ok) {
        this.lastSpawnRejection = check.reason ?? null;
        continue;
      }
      this.lastSpawnRejection = null;
      return _tmpB.set(x, check.y, z).clone();
    }
    return null;
  }

  // ------------------------------------------------------- death & drops

  kill(e: Enemy): void {
    if (e.state === 'dead') return;
    e.health = 0;
    e.alive = false;
    e.state = 'dead';
    e.deathTimer = 0.55;
  }

  harvestDeaths(): void {
    for (const e of this.enemies) {
      if (e.alive || e.state !== 'dead') continue;
      if (e.group.userData.harvested) continue;
      e.group.userData.harvested = true;
      this.kills++;

      this.ctx.audio.play('enemy-die', 40);
      this.ctx.particles.debris({
        count: e.kind === 'guardian' ? 90 : 22,
        x: e.pos.x, y: e.pos.y + e.def.height * 0.5, z: e.pos.z,
        spread: e.def.radius * 1.4, jitter: e.kind === 'guardian' ? 7 : 4.2,
        color: 0x4a2769, color2: 0xb96bff,
        size: e.kind === 'guardian' ? 0.4 : 0.24, life: 1.1, gravity: -14, drag: 0.5,
      });
      this.ctx.particles.spark({
        count: e.kind === 'guardian' ? 120 : 28,
        x: e.pos.x, y: e.pos.y + e.def.height * 0.5, z: e.pos.z,
        spread: e.def.radius, jitter: e.kind === 'guardian' ? 6 : 3,
        color: 0xd6a7ff, color2: 0xffffff, size: 0.45, life: 0.9, gravity: 1.5,
      });

      this.dropEnergy(e);
      this.director.releaseOwner(e.uid);
      this.ctx.onEnemyKilled(e.kind, e.elites);

      // `volatile` elites burst; `splitting` elites leave two smaller copies.
      if (e.elites.includes('volatile')) {
        this.ctx.particles.spark({
          count: 60, x: e.pos.x, y: e.pos.y + 1, z: e.pos.z, spread: 0.8, jitter: 8,
          color: 0xff8a2a, color2: 0xffe08a, size: 0.5, life: 0.7, gravity: 2, drag: 1.4,
        });
        this.ctx.damagePlayer(0, e.pos, 0);
        for (const other of this.enemies) {
          if (!other.alive || other === e) continue;
          if (other.pos.distanceTo(e.pos) < 5) other.damage(e.maxHealth * 0.25, 'fire', null, 0.2);
        }
      }
      if (e.elites.includes('splitting') && e.maxHealth > 12) {
        for (let i = 0; i < 2; i++) {
          const a = (i / 2) * Math.PI * 2;
          _tmpA.set(e.pos.x + Math.cos(a) * 1.2, e.pos.y + 0.3, e.pos.z + Math.sin(a) * 1.2);
          const child = this.spawn(e.kind, _tmpA, e.type.accent, 0.4);
          child.group.scale.multiplyScalar(0.7);
        }
      }

      if (e.shrineIndex >= 0) this.ctx.onGuardianDefeated(e.shrineIndex);
    }
  }

  private dropEnergy(e: Enemy): void {
    const drops = e.kind === 'guardian' ? 6 : 1;
    for (let i = 0; i < drops; i++) {
      const mesh = new THREE.Mesh(this.pickupGeo, this.pickupMat);
      mesh.position.set(e.pos.x, e.pos.y + 0.8, e.pos.z);
      this.group.add(mesh);
      this.pickups.push({
        mesh,
        pos: mesh.position.clone(),
        vel: new THREE.Vector3((Math.random() - 0.5) * 4, 4 + Math.random() * 2, (Math.random() - 0.5) * 4),
        amount: e.def.energyDrop / drops,
        life: 22,
      });
    }
  }

  private updatePickups(dt: number, playerPos: THREE.Vector3): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i]!;
      p.life -= dt;
      p.vel.y -= 18 * dt;
      p.pos.addScaledVector(p.vel, dt);

      const gy = this.ctx.world.groundHeight(p.pos.x, p.pos.z) + 0.5;
      if (p.pos.y < gy) { p.pos.y = gy; p.vel.y = 0; p.vel.x *= 0.7; p.vel.z *= 0.7; }

      const d = p.pos.distanceTo(playerPos);
      if (d < 4.5) {
        _tmpA.copy(playerPos).sub(p.pos).normalize().multiplyScalar(16 * dt);
        p.pos.add(_tmpA);
      }
      p.mesh.position.copy(p.pos);
      p.mesh.position.y += Math.sin(p.life * 4) * 0.08;
      p.mesh.rotation.y += dt * 3;
      p.mesh.rotation.x += dt * 1.6;

      if (d < 1.5 || p.life <= 0) {
        if (d < 1.5) {
          this.ctx.onEnergyPickup(p.amount);
          this.ctx.audio.play('pickup', 60);
          this.ctx.particles.spark({
            count: 8, x: p.pos.x, y: p.pos.y, z: p.pos.z, spread: 0.2, jitter: 2,
            color: 0x63e6d2, size: 0.24, life: 0.4, gravity: 2,
          });
        }
        this.group.remove(p.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const e of this.enemies) {
      this.group.remove(e.group);
      e.dispose();
    }
    this.enemies.length = 0;
    for (const p of this.pickups) this.group.remove(p.mesh);
    this.pickups.length = 0;
  }

  dispose(): void {
    this.clear();
    this.pickupGeo.dispose();
    this.pickupMat.dispose();
    this.group.clear();
  }
}
