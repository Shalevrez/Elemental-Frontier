/**
 * First-person player: movement, continuous terrain collision, camera, vitals.
 *
 * Collision is a stack of spheres resolved against the density field. Because
 * the field is roughly a signed distance near the surface, a sphere of radius
 * r penetrates when `density > -r`, and pushing back along the surface normal
 * resolves it. That handles smooth slopes, craters, tunnels and overhangs
 * without any of the axis-by-axis special cases a voxel grid needs.
 */

import * as THREE from 'three';
import type { World } from '../world/World';
import { SEA_LEVEL, WORLD_HEIGHT, WORLD_SIZE } from '../world/coords';
import { Mat } from '../world/materials';
import type { ElementId } from '../elements/affinity';
import type { UpgradeTotals } from '../world/shrineData';

export const PLAYER_HEIGHT = 1.78;
export const PLAYER_RADIUS = 0.35;
export const EYE_HEIGHT = 1.6;

const GRAVITY = 28;
const JUMP_SPEED = 9.2;
const WALK_SPEED = 4.9;
const SPRINT_SPEED = 7.4;
const SWIM_SPEED = 3.1;
const AIR_CONTROL = 0.45;
const MAX_FALL = 55;
const FALL_DAMAGE_THRESHOLD = 5;
/** Seconds the player can stay submerged before drowning starts. */
export const BREATH_SECONDS = 14;

export type PlayMode = 'element' | 'terrain';

export interface PlayerStats extends UpgradeTotals {}

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _eye = new THREE.Vector3();

/** Sphere stack approximating the player's body, as [heightOffset, radius]. */
const BODY_SPHERES: readonly (readonly [number, number])[] = [
  [0.36, 0.35],
  [0.95, 0.35],
  [1.5, 0.32],
];

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
  fallStartY = 0;
  falling = false;
  airDashAvailable = true;
  dashGrace = 0;
  alive = true;

  /** Remaining breath, seconds. Drowning damage starts when it hits zero. */
  breath = BREATH_SECONDS;
  /** Temporary flat damage reduction from upgrades, 0..0.75. */
  tempArmor = 0;
  private tempArmorTimer = 0;
  /** Flat damage reduction from the run build. */
  buildArmor = 0;
  /** Temporary absorb shield from upgrades. */
  shield = 0;
  /** True while the player is taking continuing environmental damage. */
  takingDamageOverTime = false;

  stats: PlayerStats = {
    maxHealth: 100, maxEnergy: 100, energyRegen: 7,
    cooldownScale: 1, moveScale: 1, powerScale: 1,
  };

  activeElement: ElementId = 'air';

  private bobPhase = 0;
  private shake = 0;
  private shakeDecay = 6;
  private wasInWater = false;
  private drownTick = 0;

  onLand: ((impactSpeed: number) => void) | null = null;
  onSplash: (() => void) | null = null;
  /** Fired when drowning deals a tick of damage. */
  onDrown: ((amount: number) => void) | null = null;

  constructor(private readonly world: World) {}

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
    this.breath = BREATH_SECONDS;
  }

  get eyePosition(): THREE.Vector3 {
    return _eye.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
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
    let speed = this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    if (this.activeElement === 'air' && this.sprinting) speed *= 1.12;
    if (this.inWater) speed = SWIM_SPEED;
    speed *= this.stats.moveScale;

    const control = this.onGround || this.inWater ? 1 : AIR_CONTROL;
    const accel = (this.inWater ? 12 : 55) * control;
    const targetX = _wish.x * speed * Math.min(1, wishLen);
    const targetZ = _wish.z * speed * Math.min(1, wishLen);
    this.velocity.x += (targetX - this.velocity.x) * Math.min(1, accel * dt);
    this.velocity.z += (targetZ - this.velocity.z) * Math.min(1, accel * dt);

    if (wishLen < 0.01 && (this.onGround || this.inWater)) {
      const friction = Math.max(0, 1 - (this.inWater ? 4 : 13) * dt);
      this.velocity.x *= friction;
      this.velocity.z *= friction;
    }

    if (jump) {
      if (this.inWater) {
        this.velocity.y = Math.min(this.velocity.y + 32 * dt, 4.6);
      } else if (this.onGround) {
        this.velocity.y = JUMP_SPEED * (this.activeElement === 'air' ? 1.18 : 1);
        this.onGround = false;
        this.falling = true;
        this.fallStartY = this.position.y;
      }
    }

    if (this.inWater) {
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

    const regenScale = this.inWater ? 0.7 : 1;
    this.energy = Math.min(this.maxEnergy, this.energy + this.energyRegen * regenScale * dt);

    if (this.shake > 0) this.shake = Math.max(0, this.shake - this.shakeDecay * dt);
    const planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && planarSpeed > 0.6) this.bobPhase += dt * planarSpeed * 1.5;

    const margin = 2;
    this.position.x = Math.min(WORLD_SIZE - margin, Math.max(margin, this.position.x));
    this.position.z = Math.min(WORLD_SIZE - margin, Math.max(margin, this.position.z));
    if (this.position.y < -8) {
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
    return this.position.y < SEA_LEVEL + 2.5
      && this.world.groundHeight(this.position.x, this.position.z) < SEA_LEVEL + 1.5;
  }

  private updateFluidState(dt: number): void {
    const feetY = this.position.y + 0.2;
    const headY = this.position.y + EYE_HEIGHT;
    // Water is the sea plane: anything below sea level that is not inside rock.
    this.inWater = feetY < SEA_LEVEL && !this.world.isSolid(this.position.x, feetY, this.position.z);
    this.headInWater = headY < SEA_LEVEL && !this.world.isSolid(this.position.x, headY, this.position.z);

    if (this.inWater && !this.wasInWater) {
      if (this.velocity.y < -6) this.onSplash?.();
      this.falling = false;
    }
    this.wasInWater = this.inWater;

    // --------------------------------------------------------- breath
    this.takingDamageOverTime = false;
    if (this.headInWater) {
      this.breath = Math.max(0, this.breath - dt);
      if (this.breath <= 0) {
        this.takingDamageOverTime = true;
        this.drownTick += dt;
        if (this.drownTick >= 1) {
          this.drownTick = 0;
          const amount = Math.max(4, this.maxHealth * 0.06);
          this.applyDamage(amount, null, 0, true);
          this.onDrown?.(amount);
        }
      }
    } else {
      this.breath = Math.min(BREATH_SECONDS, this.breath + dt * 4);
      this.drownTick = 0;
    }
  }

  /** Integrate motion then resolve terrain penetration. */
  private integrate(dt: number): void {
    const wasFalling = this.falling;
    this.position.addScaledVector(this.velocity, dt);

    const grounded = this.resolvePenetration();
    const wasOnGround = this.onGround;
    this.onGround = grounded || this.probeGround();

    if (this.onGround && !wasOnGround && wasFalling) this.handleLanding();
    if (this.onGround && this.velocity.y < 0) this.velocity.y = 0;
  }

  /**
   * Push the body out of solid terrain. Returns true when a contact normal was
   * facing up enough to count as standing on the ground.
   */
  private resolvePenetration(): boolean {
    let grounded = false;
    for (let iteration = 0; iteration < 5; iteration++) {
      let worst = 0;
      let worstOffset = 0;
      for (const [oy, radius] of BODY_SPHERES) {
        const d = this.world.densityAt(this.position.x, this.position.y + oy, this.position.z);
        const penetration = d + radius;
        if (penetration > worst) {
          worst = penetration;
          worstOffset = oy;
        }
      }
      if (worst <= 0.001) break;

      this.world.normalAt(this.position.x, this.position.y + worstOffset, this.position.z, _normal);
      if (_normal.lengthSq() < 0.0001) _normal.set(0, 1, 0);
      this.position.addScaledVector(_normal, Math.min(0.5, worst));

      if (_normal.y > 0.45) grounded = true;
      const into = this.velocity.dot(_normal);
      if (into < 0) this.velocity.addScaledVector(_normal, -into);
    }
    return grounded;
  }

  /** Cheap downward probe so standing exactly on the surface still counts. */
  private probeGround(): boolean {
    if (this.velocity.y > 0.5) return false;
    return this.world.densityAt(this.position.x, this.position.y - 0.14, this.position.z) > -0.05;
  }

  private handleLanding(): void {
    this.falling = false;
    const drop = this.fallStartY - this.position.y;
    const impact = Math.abs(this.velocity.y);
    this.airDashAvailable = true;
    this.onLand?.(impact);

    if (this.inWater || this.dashGrace > 0) return;
    if (drop > FALL_DAMAGE_THRESHOLD) {
      let damage = (drop - FALL_DAMAGE_THRESHOLD) * 6.5;
      if (this.activeElement === 'air') damage *= 0.35;
      if (damage >= 1) this.applyDamage(damage, null, 0, true);
    }
  }

  /** True when the body overlaps solid terrain right now. */
  isStuck(): boolean {
    for (const [oy, radius] of BODY_SPHERES) {
      if (this.world.densityAt(this.position.x, this.position.y + oy, this.position.z) + radius > 0.12) return true;
    }
    return false;
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
   * Lift the player free of solid terrain. Used after Raise Wall and whenever
   * an edit or a stale saved position leaves the body inside the ground, so
   * terrain shaping can never permanently trap anyone.
   */
  unstick(): boolean {
    if (!this.isStuck()) return false;
    for (let up = 0.25; up <= 8; up += 0.25) {
      this.position.y += 0.25;
      if (!this.isStuck()) {
        this.velocity.set(0, 0, 0);
        return true;
      }
      void up;
    }
    const gy = this.world.groundHeight(this.position.x, this.position.z);
    this.position.y = gy + 0.3;
    this.velocity.set(0, 0, 0);
    return true;
  }

  // -------------------------------------------------------------- damage

  applyDamage(amount: number, from: THREE.Vector3 | null, knockback: number, ignoreInvuln = false): number {
    if (!this.alive) return 0;
    if (!ignoreInvuln && this.invulnTimer > 0) return 0;

    let dmg = amount;
    if (this.activeElement === 'earth' && this.standingOnFirmGround()) dmg *= 0.82;
    // Build armor and temporary armor both cut incoming damage.
    const armor = Math.min(0.8, this.buildArmor + this.tempArmor);
    dmg *= 1 - armor;
    // A shield soaks damage before health does.
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, dmg);
      this.shield -= soaked;
      dmg -= soaked;
      if (dmg <= 0.01) {
        if (!ignoreInvuln) this.invulnTimer = 0.4;
        return 0;
      }
    }

    this.health -= dmg;
    if (!ignoreInvuln) this.invulnTimer = 0.55;
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
    this.health = Math.min(this.maxHealth, this.health + amount);
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

  applyToCamera(camera: THREE.PerspectiveCamera): void {
    const bob = this.onGround ? Math.sin(this.bobPhase * 2) * 0.042 * (this.sprinting ? 1.5 : 1) : 0;
    const sway = this.onGround ? Math.cos(this.bobPhase) * 0.028 * (this.sprinting ? 1.4 : 1) : 0;
    const shakeX = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.22 : 0;
    const shakeY = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.22 : 0;

    camera.position.set(
      this.position.x + sway * 0.5 + shakeX,
      this.position.y + EYE_HEIGHT + bob + shakeY,
      this.position.z + shakeX * 0.5,
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw + shakeX * 0.4;
    camera.rotation.x = this.pitch + shakeY * 0.4;
    camera.rotation.z = sway * 0.12 + (this.shake > 0 ? (Math.random() - 0.5) * this.shake * 0.05 : 0);
  }

  /** Clamp the player inside the vertical bounds of the world. */
  clampToWorld(): void {
    if (this.position.y > WORLD_HEIGHT + 20) this.position.y = WORLD_HEIGHT + 20;
  }
}
