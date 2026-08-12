/**
 * First-person player: movement, capsule collision, swimming, camera, vitals.
 *
 * Collision is a vertical capsule resolved against two things:
 *   - the smooth density field, which is roughly a signed distance near the
 *     surface, so a sphere of radius r penetrates when `density > -r` and
 *     pushing back along the gradient resolves it, and
 *   - the obstacle field, which holds every solid that is *not* terrain: tree
 *     trunks, boulders, ruins, chests, portals and raised earth walls.
 *
 * Motion is swept in substeps, so nothing thin can be crossed between frames,
 * and the resolver reports ground, ceiling and slope contacts separately so
 * step-ups, slope limits and wall sliding all behave.
 */

import * as THREE from 'three';
import type { World } from '../world/World';
import { WORLD_HEIGHT, WORLD_SIZE } from '../world/coords';
import { Mat } from '../world/materials';
import type { ElementId } from '../elements/affinity';
import type { UpgradeTotals } from '../world/shrineData';
import type { ObstacleField } from '../world/Obstacles';
import { INCOMING } from '../combat/combatConfig';
import {
  BODY_SPHERES, EYE_HEIGHT, MAX_WALKABLE_NORMAL_Y, PLAYER_HEIGHT, PLAYER_RADIUS,
  createContactReport, depenetrate, probeGround, sweepMove,
  type ContactReport, type DensityField, type Vec3Like,
} from './collision';
import {
  BASE_OXYGEN, createOxygenState, swimSpeedScale, tickOxygen,
  type OxygenState,
} from './oxygen';

export { PLAYER_HEIGHT, PLAYER_RADIUS, EYE_HEIGHT };

const GRAVITY = 28;
const JUMP_SPEED = 9.2;
const WALK_SPEED = 4.9;
const SPRINT_SPEED = 7.4;
const SWIM_SPEED = 3.1;
const AIR_CONTROL = 0.45;
const MAX_FALL = 55;
const FALL_DAMAGE_THRESHOLD = 5;

/**
 * Seconds of air. Kept as the old export name so existing callers do not have
 * to change; the real capacity now lives in the oxygen state and can be raised
 * by upgrades.
 */
export const BREATH_SECONDS = BASE_OXYGEN;

/** Seconds of damage immunity granted immediately after a respawn. */
export const RESPAWN_PROTECTION = 3;

export type PlayMode = 'element' | 'terrain';

export interface PlayerStats extends UpgradeTotals {}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _delta: Vec3Like = { x: 0, y: 0, z: 0 };

export class Player {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  health = 100;
  maxHealth = 100;
  energy = 100;
  maxEnergy = 100;
  energyRegen = 7;

  onGround = false;
  inWater = false;
  headInWater = false;
  sprinting = false;
  mode: PlayMode = 'element';

  invulnTimer = 0;
  /** Longer, explicitly-signalled immunity after respawning. */
  respawnProtection = 0;
  fallStartY = 0;
  falling = false;
  airDashAvailable = true;
  /** Extra mid-air dashes from `extra-dash`, refilled on landing. */
  bonusAirDashes = 0;
  private bonusDashesLeft = 0;
  /** Fraction of any healing that is also granted as a shield (`heal-shield`). */
  healShieldFraction = 0;
  /** Armour from standing on firm ground (`ground-armor`). */
  groundArmor = 0;
  /** Armour that builds while standing still and is spent by moving (`unmoved`). */
  unmovedArmor = 0;
  private unmovedStacks = 0;
  dashGrace = 0;
  alive = true;

  /** Oxygen while submerged. Drowning damage starts when it hits zero. */
  readonly oxygen: OxygenState = createOxygenState();
  /** Extra lung capacity, in seconds, from upgrades and blessings. */
  bonusOxygen = 0;
  /** Multiplier on the oxygen drain rate; lower is better. */
  oxygenDrainScale = 1;
  /** True when the player's head is inside an air pocket while submerged. */
  inAirPocket = false;

  /** Temporary flat damage reduction from upgrades, 0..0.75. */
  tempArmor = 0;
  private tempArmorTimer = 0;
  /** Flat damage reduction from the run build. */
  buildArmor = 0;
  /** Temporary absorb shield from upgrades. */
  shield = 0;
  /** True while the player is taking continuing environmental damage. */
  takingDamageOverTime = false;

  /** Set by the game when the ground underfoot has been made slippery. */
  onSlipperyGround = false;
  /** Multiplier on sprint speed only, from tradeoff cards. */
  sprintScale = 1;

  /** The last collision contact, exposed for the collision debug overlay. */
  readonly contact: ContactReport = createContactReport();
  /** Set when the last frame's motion was blocked by an obstacle. */
  lastBlockedByObstacle = false;

  stats: PlayerStats = {
    maxHealth: 100, maxEnergy: 100, energyRegen: 7,
    cooldownScale: 1, moveScale: 1, powerScale: 1,
  };

  activeElement: ElementId = 'air';

  /** Solid volumes that are not terrain. Assigned by the game on load. */
  obstacles: ObstacleField | null = null;

  private bobPhase = 0;
  private shake = 0;
  private shakeDecay = 6;
  private wasInWater = false;

  onLand: ((impactSpeed: number) => void) | null = null;
  onSplash: (() => void) | null = null;
  /** Fired when drowning deals a tick of damage. */
  onDrown: ((amount: number) => void) | null = null;

  constructor(private readonly world: World) {}

  /**
   * The density field the collision core works against.
   *
   * Deliberately *not* a cast: `World` has to structurally satisfy
   * `DensityField`, so a signature drift between the two is a compile error
   * rather than a runtime crash inside the movement loop.
   */
  private get field(): DensityField {
    return this.world;
  }

  applyStats(stats: PlayerStats, keepRatios: boolean): void {
    const healthRatio = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    const energyRatio = this.maxEnergy > 0 ? this.energy / this.maxEnergy : 1;
    this.stats = stats;
    this.maxHealth = stats.maxHealth;
    this.maxEnergy = stats.maxEnergy;
    this.energyRegen = stats.energyRegen;
    if (keepRatios) {
      this.health = Math.min(this.maxHealth, healthRatio * this.maxHealth);
      this.energy = Math.min(this.maxEnergy, energyRatio * this.maxEnergy);
    } else {
      this.health = this.maxHealth;
      this.energy = this.maxEnergy;
    }
  }

  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.falling = false;
    this.fallStartY = y;
    this.airDashAvailable = true;
    this.bonusDashesLeft = this.bonusAirDashes;
    this.oxygen.oxygen = this.oxygen.maxOxygen;
    this.oxygen.drownTimer = 0;
  }

  /** True when another mid-air dash is available. */
  canAirDash(): boolean {
    return this.onGround || this.airDashAvailable || this.bonusDashesLeft > 0;
  }

  /**
   * Spend one mid-air dash.
   *
   * `extra-dash` charges are spent first, so the base dash is still there when
   * the extras run out - which is what "an extra air dash" has to mean.
   */
  consumeAirDash(): void {
    if (this.onGround) return;
    if (this.bonusDashesLeft > 0) this.bonusDashesLeft -= 1;
    else this.airDashAvailable = false;
  }

  /** Grant the post-respawn grace period. */
  protectAfterRespawn(seconds = RESPAWN_PROTECTION): void {
    this.respawnProtection = Math.max(this.respawnProtection, seconds);
    this.invulnTimer = Math.max(this.invulnTimer, seconds);
  }

  get eyePosition(): THREE.Vector3 {
    return _eye.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
  }

  /** Remaining oxygen in seconds, kept under the old name for the HUD. */
  get breath(): number {
    return this.oxygen.oxygen;
  }

  set breath(value: number) {
    this.oxygen.oxygen = Math.max(0, Math.min(this.oxygen.maxOxygen, value));
  }

  get maxBreath(): number {
    return this.oxygen.maxOxygen;
  }

  getForward(target: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return target.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  addShake(amount: number, decay = 6): void {
    this.shake = Math.min(1.4, this.shake + amount);
    this.shakeDecay = decay;
  }

  // -------------------------------------------------------------- update

  update(dt: number, moveX: number, moveZ: number, jump: boolean, sprint: boolean): void {
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.respawnProtection > 0) this.respawnProtection -= dt;
    if (this.dashGrace > 0) this.dashGrace -= dt;
    if (this.tempArmorTimer > 0) {
      this.tempArmorTimer -= dt;
      if (this.tempArmorTimer <= 0) this.tempArmor = 0;
    }

    this.updateFluidState(dt);

    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _wish.set(0, 0, 0).addScaledVector(_forward, moveZ).addScaledVector(_right, moveX);
    const wishLen = _wish.length();
    if (wishLen > 0.001) _wish.divideScalar(wishLen);

    this.sprinting = sprint && moveZ > 0.1 && !this.inWater;
    let speed = this.sprinting ? SPRINT_SPEED * this.sprintScale : WALK_SPEED;
    if (this.activeElement === 'air' && this.sprinting) speed *= 1.12;
    if (this.inWater) speed = SWIM_SPEED * swimSpeedScale(this.activeElement);
    speed *= this.stats.moveScale;

    const control = this.onGround || this.inWater ? 1 : AIR_CONTROL;
    // Ice gives the player far less purchase, which is what makes the frozen
    // world handle differently rather than just look different.
    const grip = this.onSlipperyGround && !this.inWater ? 0.22 : 1;
    const accel = (this.inWater ? 12 : 55) * control * grip;
    const targetX = _wish.x * speed * Math.min(1, wishLen);
    const targetZ = _wish.z * speed * Math.min(1, wishLen);
    this.velocity.x += (targetX - this.velocity.x) * Math.min(1, accel * dt);
    this.velocity.z += (targetZ - this.velocity.z) * Math.min(1, accel * dt);

    if (wishLen < 0.01 && (this.onGround || this.inWater)) {
      const drag = this.inWater ? 4 : this.onSlipperyGround ? 1.4 : 13;
      const friction = Math.max(0, 1 - drag * dt);
      this.velocity.x *= friction;
      this.velocity.z *= friction;
    }

    if (jump) {
      if (this.inWater) {
        // Controlled ascent while swimming.
        this.velocity.y = Math.min(this.velocity.y + 32 * dt, 4.6);
      } else if (this.onGround) {
        this.velocity.y = JUMP_SPEED * (this.activeElement === 'air' ? 1.18 : 1);
        this.onGround = false;
        this.falling = true;
        this.fallStartY = this.position.y;
      }
    }

    if (this.inWater) {
      // Sinking is slow and controllable; crouch dives, jump climbs.
      this.velocity.y -= 9 * dt;
      this.velocity.y = Math.max(this.velocity.y, -3.4);
      if (!jump) this.velocity.y *= 0.94;
    } else {
      this.velocity.y -= GRAVITY * dt;
      if (this.velocity.y < -MAX_FALL) this.velocity.y = -MAX_FALL;
    }

    if (!this.onGround && this.velocity.y < 0 && !this.falling) {
      this.falling = true;
      this.fallStartY = this.position.y;
    }
    if (this.position.y > this.fallStartY) this.fallStartY = this.position.y;

    this.integrate(dt);

    if (this.shake > 0) this.shake = Math.max(0, this.shake - this.shakeDecay * dt);
    const planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && planarSpeed > 0.6) this.bobPhase += dt * planarSpeed * 1.5;

    const margin = 2;
    this.position.x = Math.min(WORLD_SIZE - margin, Math.max(margin, this.position.x));
    this.position.z = Math.min(WORLD_SIZE - margin, Math.max(margin, this.position.z));
    if (this.position.y < -8) {
      // Fell out of the world: put the body back on the surface rather than
      // letting it keep falling forever.
      this.position.y = this.world.groundHeight(this.position.x, this.position.z) + 0.2;
      this.velocity.set(0, 0, 0);
      this.falling = false;
    }
  }

  nearWorldEdge(): boolean {
    const d = Math.min(this.position.x, this.position.z, WORLD_SIZE - this.position.x, WORLD_SIZE - this.position.z);
    return d < 14;
  }

  /** True when open water is within a couple of metres (Water's passive). */
  nearWater(): boolean {
    if (this.inWater) return true;
    const level = this.world.fluidLevel;
    return this.position.y < level + 2.5
      && this.world.groundHeight(this.position.x, this.position.z) < level + 1.5;
  }

  private updateFluidState(dt: number): void {
    const level = this.world.fluidLevel;
    const feetY = this.position.y + 0.2;
    const headY = this.position.y + EYE_HEIGHT;
    // The fluid is a plane: anything below it that is not inside rock.
    this.inWater = feetY < level && !this.world.isSolid(this.position.x, feetY, this.position.z);
    this.headInWater = headY < level && !this.world.isSolid(this.position.x, headY, this.position.z);

    if (this.inWater && !this.wasInWater) {
      if (this.velocity.y < -6) this.onSplash?.();
      this.falling = false;
    }
    this.wasInWater = this.inWater;

    // --------------------------------------------------------- oxygen
    this.takingDamageOverTime = false;
    // Lava is not breathable and is not swimmable either: a hazard fluid never
    // counts as an air pocket.
    const tick = tickOxygen(this.oxygen, dt, {
      headSubmerged: this.headInWater,
      inAirPocket: this.inAirPocket && !this.world.fluidIsHazard,
      element: this.activeElement,
      bonusCapacity: this.bonusOxygen,
      drainScale: this.oxygenDrainScale,
      maxHealth: this.maxHealth,
    });
    if (this.headInWater && this.oxygen.oxygen <= 0) this.takingDamageOverTime = true;
    if (tick.damage > 0) {
      this.applyDamage(tick.damage, null, 0, true);
      this.onDrown?.(tick.damage);
    }
  }

  /** Integrate motion with swept collision, then settle ground state. */
  private integrate(dt: number): void {
    const wasFalling = this.falling;
    _delta.x = this.velocity.x * dt;
    _delta.y = this.velocity.y * dt;
    _delta.z = this.velocity.z * dt;

    sweepMove(this.field, this.position, this.velocity, _delta, this.obstacles, this.contact);
    this.lastBlockedByObstacle = this.contact.corrections > 0 && this.contact.ny === 0;

    const probe = probeGround(this.field, this.position, this.velocity.y, this.obstacles);
    const wasOnGround = this.onGround;
    this.onGround = this.contact.grounded || probe.grounded;

    // Standing on an obstacle top (a chest, a ledge of ruin) is real ground.
    if (!this.onGround && this.obstacles && this.velocity.y <= 0.5) {
      const support = this.obstacles.supportHeight(
        this.position.x, this.position.z, this.position.y + 0.35, PLAYER_RADIUS,
      );
      if (support !== null && this.position.y - support <= 0.35 && this.position.y >= support - 0.35) {
        this.position.y = support;
        this.onGround = true;
      }
    }

    if (this.contact.ceiling && this.velocity.y > 0) this.velocity.y = 0;
    if (this.onGround && !wasOnGround && wasFalling) this.handleLanding();
    if (this.onGround && this.velocity.y < 0) this.velocity.y = 0;
  }

  private handleLanding(): void {
    this.falling = false;
    const drop = this.fallStartY - this.position.y;
    const impact = Math.abs(this.velocity.y);
    this.airDashAvailable = true;
    this.bonusDashesLeft = this.bonusAirDashes;
    this.onLand?.(impact);

    if (this.inWater || this.dashGrace > 0) return;
    if (drop > FALL_DAMAGE_THRESHOLD) {
      let damage = (drop - FALL_DAMAGE_THRESHOLD) * 6.5;
      if (this.activeElement === 'air') damage *= 0.35;
      if (damage >= 1) this.applyDamage(damage, null, 0, true);
    }
  }

  /** True when the body overlaps solid terrain or a solid obstacle right now. */
  isStuck(): boolean {
    for (const [oy, radius] of BODY_SPHERES) {
      if (this.world.densityAt(this.position.x, this.position.y + oy, this.position.z) + radius > 0.12) return true;
    }
    return this.obstacles?.overlaps(
      this.position.x, this.position.y, this.position.z, PLAYER_RADIUS, PLAYER_HEIGHT,
    ) ?? false;
  }

  /** True when a sphere would intersect the player's body. */
  intersectsSphere(x: number, y: number, z: number, radius: number): boolean {
    for (const [oy, r] of BODY_SPHERES) {
      const dx = this.position.x - x;
      const dy = this.position.y + oy - y;
      const dz = this.position.z - z;
      const rr = radius + r;
      if (dx * dx + dy * dy + dz * dz < rr * rr) return true;
    }
    return false;
  }

  /**
   * Lift the player free of anything solid.
   *
   * Used after Raise Wall and whenever an edit or a stale saved position leaves
   * the body inside the ground, so terrain shaping can never permanently trap
   * anyone. Depenetration is tried first, because pushing sideways out of a
   * wall is far less jarring than being lifted through it.
   */
  unstick(): boolean {
    if (!this.isStuck()) return false;

    depenetrate(this.field, this.position, this.velocity, this.obstacles, this.contact, 8);
    if (!this.isStuck()) {
      this.velocity.set(0, 0, 0);
      return true;
    }

    for (let up = 0.25; up <= 8; up += 0.25) {
      this.position.y += 0.25;
      if (!this.isStuck()) {
        this.velocity.set(0, 0, 0);
        return true;
      }
    }
    const gy = this.world.groundHeight(this.position.x, this.position.z);
    this.position.y = gy + 0.3;
    this.velocity.set(0, 0, 0);
    return true;
  }

  /** Slope of the ground under the player, as the normal's upward component. */
  groundNormalY(): number {
    const probe = probeGround(this.field, this.position, 0, this.obstacles);
    return probe.normalY;
  }

  /** True when the ground under the player is too steep to walk on. */
  onSteepGround(): boolean {
    const ny = this.groundNormalY();
    return ny > 0 && ny < MAX_WALKABLE_NORMAL_Y;
  }

  // -------------------------------------------------------------- damage

  applyDamage(amount: number, from: THREE.Vector3 | null, knockback: number, ignoreInvuln = false): number {
    if (!this.alive) return 0;
    // Respawn protection stops *everything*, including environmental damage,
    // so a respawn next to a hazard is survivable.
    if (this.respawnProtection > 0) return 0;
    if (!ignoreInvuln && this.invulnTimer > 0) return 0;

    let dmg = amount;
    if (this.activeElement === 'earth' && this.standingOnFirmGround()) dmg *= 0.82;
    // Build armor and temporary armor both cut incoming damage.
    const armor = Math.min(0.8, this.buildArmor + this.tempArmor + this.stanceArmor());
    dmg *= 1 - armor;
    // A shield soaks damage before health does.
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, dmg);
      this.shield -= soaked;
      dmg -= soaked;
      if (dmg <= 0.01) {
        if (!ignoreInvuln) this.invulnTimer = INCOMING.postShieldInvuln;
        return 0;
      }
    }

    this.health -= dmg;
    // The window that stops a stagger lock: a second attack cannot land inside
    // it, so control always comes back between hits.
    if (!ignoreInvuln) this.invulnTimer = INCOMING.postHitInvuln;
    this.addShake(Math.min(0.7, 0.18 + dmg * 0.012), 5);

    if (from && knockback > 0) {
      _wish.set(this.position.x - from.x, 0, this.position.z - from.z);
      if (_wish.lengthSq() > 0.0001) {
        _wish.normalize();
        let k = knockback;
        if (this.activeElement === 'earth' && this.standingOnFirmGround()) k *= 0.45;
        this.velocity.x += _wish.x * k;
        this.velocity.z += _wish.z * k;
        this.velocity.y = Math.max(this.velocity.y, k * 0.3);
      }
    }

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
    return dmg;
  }

  standingOnFirmGround(): boolean {
    if (!this.onGround) return false;
    const m = this.world.materialAt(this.position.x, this.position.y - 0.4, this.position.z);
    return m === Mat.STONE || m === Mat.SOIL || m === Mat.GRASS || m === Mat.CLAY;
  }

  firePassiveMultiplier(): number {
    if (this.activeElement !== 'fire') return 1;
    const frac = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    if (frac > 0.55) return 1;
    return 1 + (0.55 - frac) * 0.9;
  }

  firePassiveActive(): boolean {
    return this.activeElement === 'fire' && this.health / this.maxHealth <= 0.55;
  }

  spend(amount: number): boolean {
    if (this.energy < amount) return false;
    this.energy -= amount;
    return true;
  }

  addEnergy(amount: number): void {
    this.energy = Math.min(this.maxEnergy, this.energy + amount);
  }

  heal(amount: number): void {
    if (amount <= 0) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
    // `heal-shield` (Tideguard): every point of healing also lays down a
    // fraction of itself as absorb, so a healing build is also a durable one.
    if (this.healShieldFraction > 0) this.grantShield(amount * this.healShieldFraction);
  }

  /**
   * Armour the build earns from how the player is standing.
   *
   * `ground-armor` pays for holding firm ground; `unmoved` pays for holding
   * still and is spent the moment the player moves. Both are folded into the
   * same reduction the HUD already shows, and the total is still capped by
   * `applyDamage`.
   */
  stanceArmor(): number {
    let armor = 0;
    if (this.groundArmor > 0 && this.standingOnFirmGround()) armor += this.groundArmor;
    if (this.unmovedArmor > 0) armor += this.unmovedArmor * this.unmovedStacks;
    return armor;
  }

  /** Advance the stand-still armour. Called once per frame from the game loop. */
  tickStance(dt: number, moving: boolean): void {
    if (this.unmovedArmor <= 0) { this.unmovedStacks = 0; return; }
    if (moving) this.unmovedStacks = 0;
    else this.unmovedStacks = Math.min(3, this.unmovedStacks + dt * 0.9);
  }

  /** How much stand-still armour has been built, 0..3 stacks. */
  get unmovedProgress(): number {
    return this.unmovedStacks / 3;
  }

  /** Temporary flat damage reduction, e.g. from Stonehide. */
  grantArmor(amount: number, seconds: number): void {
    this.tempArmor = Math.min(0.6, Math.max(this.tempArmor, amount));
    this.tempArmorTimer = Math.max(this.tempArmorTimer, seconds);
  }

  /** Temporary absorb shield, e.g. from Tideguard. */
  grantShield(amount: number): void {
    this.shield = Math.min(this.maxHealth * 0.6, this.shield + amount);
  }

  // -------------------------------------------------------------- camera

  applyToCamera(camera: THREE.PerspectiveCamera, shakeScale = 1): void {
    const bob = this.onGround ? Math.sin(this.bobPhase * 2) * 0.042 * (this.sprinting ? 1.5 : 1) : 0;
    const sway = this.onGround ? Math.cos(this.bobPhase) * 0.028 * (this.sprinting ? 1.4 : 1) : 0;
    const s = this.shake * shakeScale;
    const shakeX = s > 0 ? (Math.random() - 0.5) * s * 0.22 : 0;
    const shakeY = s > 0 ? (Math.random() - 0.5) * s * 0.22 : 0;

    camera.position.set(
      this.position.x + sway * 0.5 + shakeX,
      this.position.y + EYE_HEIGHT + bob + shakeY,
      this.position.z + shakeX * 0.5,
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw + shakeX * 0.4;
    camera.rotation.x = this.pitch + shakeY * 0.4;
    camera.rotation.z = sway * 0.12 + (s > 0 ? (Math.random() - 0.5) * s * 0.05 : 0);
  }

  /** Clamp the player inside the vertical bounds of the world. */
  clampToWorld(): void {
    if (this.position.y > WORLD_HEIGHT + 20) this.position.y = WORLD_HEIGHT + 20;
  }
}
