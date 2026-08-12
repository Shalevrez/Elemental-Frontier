/**
 * Combat director.
 *
 * First-person combat is only fair if the player can see (or hear) an attack
 * coming and if the world does not swing at them from six directions at once.
 * This module owns both rules:
 *
 *  - **Attack tokens** cap how many creatures may be committed to a telegraphed
 *    attack simultaneously.
 *  - **The rear rule** stretches the telegraph, and forces an audio/visual
 *    warning, for anything attacking from outside the player's view.
 *
 * Pure logic, no engine imports.
 */

import { SPAWN, TOKENS } from './combatConfig';

export type AttackDenial =
  | 'no-token' | 'too-soon' | 'crowded' | 'ranged-full' | 'area-busy' | 'unfair-combo';

/**
 * What kind of pressure an attack puts on the player.
 *
 * The distinction matters because these are not interchangeable: two melee
 * swings can be side-stepped, two ground slams cannot, and an off-screen
 * projectile arriving during either is simply unfair.
 */
export type AttackCategory = 'melee' | 'heavy' | 'ranged';

export interface DirectorConfig {
  /** Total attack *weight* that may be committed at once. */
  maxTokens: number;
  /** Minimum gap between any two attacks landing on the player. */
  globalCooldown: number;
  /** Half-angle, in radians, of what counts as "in front of" the player. */
  frontHalfAngle: number;
  /** Telegraph multiplier for attacks starting outside the player's view. */
  rearTelegraphScale: number;
  /** Absolute minimum reaction window for any attack, in seconds. */
  minTelegraph: number;
  /** Minimum reaction window for attacks from behind. */
  minRearTelegraph: number;
  /** Simultaneous ranged attackers allowed. */
  maxRanged: number;
  /** Simultaneous large area attacks allowed. */
  maxArea: number;
}

export const DEFAULT_DIRECTOR: Readonly<DirectorConfig> = Object.freeze({
  maxTokens: TOKENS.earlyBudget,
  globalCooldown: 0.6,
  frontHalfAngle: 1.05, // ~60 degrees each side
  rearTelegraphScale: 1.6,
  minTelegraph: 0.35,
  minRearTelegraph: 0.85,
  maxRanged: TOKENS.earlyRanged,
  maxArea: TOKENS.maxSimultaneousArea,
});

/** The token weight an attack of this shape costs. */
export function attackWeight(category: AttackCategory): number {
  switch (category) {
    case 'heavy': return TOKENS.weightHeavy;
    case 'ranged': return TOKENS.weightRanged;
    default: return TOKENS.weightLight;
  }
}

/**
 * Simultaneous-attacker budget for a run depth.
 *
 * Early encounters allow one or two dangerous attackers, mid-game three, and
 * only a late-game or New Game Plus arena is given four.
 */
export function tokenBudgetForDepth(depth: number): number {
  const d = Math.max(0, depth);
  if (d >= TOKENS.lateDepth) return TOKENS.lateBudget;
  if (d >= TOKENS.midDepth) return TOKENS.midBudget;
  return TOKENS.earlyBudget;
}

/** Simultaneous *ranged* attackers for a run depth. */
export function rangedBudgetForDepth(depth: number): number {
  const d = Math.max(0, depth);
  if (d >= TOKENS.lateDepth) return TOKENS.lateRanged;
  if (d >= TOKENS.midDepth) return TOKENS.midRanged;
  return TOKENS.earlyRanged;
}

export interface AttackGrant {
  granted: boolean;
  reason?: AttackDenial;
  /** Telegraph the attacker must actually play, after fairness adjustments. */
  telegraph: number;
  /** True when the attacker is outside the player's view and needs a warning. */
  needsWarning: boolean;
  /** Token handle to release when the attack finishes or is interrupted. */
  token: number;
}

const DENIED: AttackGrant = Object.freeze({
  granted: false, telegraph: 0, needsWarning: false, token: -1,
});

interface HeldToken {
  id: number;
  owner: number;
  expires: number;
  weight: number;
  category: AttackCategory;
  /** True while this attack is winding up from outside the player's view. */
  fromBehind: boolean;
}

export class CombatDirector {
  private config: DirectorConfig;
  private tokens: HeldToken[] = [];
  private nextToken = 1;
  private clock = 0;
  private lastLanded = -99;
  /** Budget derived from the run depth, replacing the base cap when set. */
  private depthBudget = 0;
  private depthRanged = 0;
  /** Extra weight the current world is allowed, on top of the depth budget. */
  private worldBonus = 0;

  constructor(config: Partial<DirectorConfig> = {}) {
    this.config = { ...DEFAULT_DIRECTOR, ...config };
  }

  configure(patch: Partial<DirectorConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Raise the simultaneous-attacker cap as difficulty climbs. */
  setDepth(depth: number): void {
    this.depthBudget = tokenBudgetForDepth(depth);
    this.depthRanged = rangedBudgetForDepth(depth);
  }

  /**
   * Extra simultaneous-attacker weight granted by the world.
   *
   * Only the later worlds and New Game Plus cycles get any, and the total is
   * still held under the combat pass's hard ceiling of four - a first-person
   * player cannot read more than that however deep the run goes.
   */
  setWorldBonus(bonus: number): void {
    this.worldBonus = Math.max(0, bonus);
  }

  /** Total attack weight that may be committed at once. */
  get maxTokens(): number {
    return Math.min(
      TOKENS.lateBudget,
      Math.max(this.config.maxTokens, this.depthBudget) + this.worldBonus,
    );
  }

  get maxRanged(): number {
    return Math.max(this.config.maxRanged, this.depthRanged);
  }

  /** Weight currently committed, which is what the HUD and debug view show. */
  get activeAttackers(): number {
    let weight = 0;
    for (const t of this.tokens) weight += t.weight;
    return weight;
  }

  /** Head count of committed attackers, regardless of weight. */
  get committedCount(): number {
    return this.tokens.length;
  }

  private countOf(category: AttackCategory): number {
    let n = 0;
    for (const t of this.tokens) if (t.category === category) n++;
    return n;
  }

  update(dt: number): void {
    this.clock += dt;
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      if (this.tokens[i]!.expires <= this.clock) this.tokens.splice(i, 1);
    }
  }

  /**
   * Is this direction inside the player's forward cone?
   *
   * @param toEnemy normalised horizontal vector from player to enemy
   * @param forward normalised horizontal facing vector
   */
  isInFront(toEnemyX: number, toEnemyZ: number, forwardX: number, forwardZ: number): boolean {
    const dot = toEnemyX * forwardX + toEnemyZ * forwardZ;
    return dot >= Math.cos(this.config.frontHalfAngle);
  }

  /**
   * Ask permission to begin a telegraphed attack.
   *
   * Everything that can hurt the player now asks - including ranged fire,
   * which used to bypass the director entirely and let four archers put four
   * projectiles in the air while a brute was already mid-swing.
   *
   * @param owner stable id of the attacker
   * @param baseTelegraph the attack's designed wind-up
   * @param inFront whether the attacker is inside the player's view cone
   * @param category what kind of pressure this attack applies
   */
  request(
    owner: number,
    baseTelegraph: number,
    inFront: boolean,
    category: AttackCategory,
  ): AttackGrant {
    // Never let two hits land back to back.
    if (this.clock - this.lastLanded < this.config.globalCooldown) {
      return { ...DENIED, reason: 'too-soon' };
    }

    let telegraph = Math.max(this.config.minTelegraph, baseTelegraph);
    let needsWarning = false;
    if (!inFront) {
      // Attacks from outside the view get a longer wind-up and a warning, so
      // nothing can ever hit the player from behind without notice.
      telegraph = Math.max(this.config.minRearTelegraph, telegraph * this.config.rearTelegraphScale);
      needsWarning = true;
    }

    if (this.tokens.some((t) => t.owner === owner)) {
      return { ...DENIED, reason: 'crowded' };
    }

    // ---- combinations the player cannot answer.
    // One large area attack at a time: two overlapping ground slams leave
    // nowhere to stand, which is not a decision, it is a tax.
    if (category === 'heavy' && this.countOf('heavy') >= this.config.maxArea) {
      return { ...DENIED, reason: 'area-busy' };
    }
    // Nothing may open fire from off-screen while a heavy attack is already
    // committed: the player is being asked to dodge one thing, not two.
    if (!inFront && category === 'ranged' && this.countOf('heavy') > 0) {
      return { ...DENIED, reason: 'unfair-combo' };
    }
    // And a heavy attack never starts behind the player while ranged fire is
    // already in the air, which is the same trap from the other direction.
    if (!inFront && category === 'heavy' && this.countOf('ranged') > 0) {
      return { ...DENIED, reason: 'unfair-combo' };
    }
    // Only one attack at a time may come from outside the view.
    if (!inFront && this.tokens.some((t) => t.fromBehind)) {
      return { ...DENIED, reason: 'unfair-combo' };
    }

    if (category === 'ranged' && this.countOf('ranged') >= this.maxRanged) {
      return { ...DENIED, reason: 'ranged-full' };
    }

    const weight = attackWeight(category);
    if (this.activeAttackers + weight > this.maxTokens) {
      return { ...DENIED, reason: 'no-token' };
    }

    const token = this.nextToken++;
    this.tokens.push({
      id: token, owner, expires: this.clock + telegraph + 1.2,
      weight, category, fromBehind: !inFront,
    });
    return { granted: true, telegraph, needsWarning, token };
  }

  /**
   * Permission for an attack that never draws on the budget.
   *
   * Support actions and boss moves still obey the global cooldown and the rear
   * telegraph rules - a boss may own the arena, but it may not hit the player
   * from behind without a warning.
   */
  requestUncontested(baseTelegraph: number, inFront: boolean): AttackGrant {
    if (this.clock - this.lastLanded < this.config.globalCooldown) {
      return { ...DENIED, reason: 'too-soon' };
    }
    let telegraph = Math.max(this.config.minTelegraph, baseTelegraph);
    let needsWarning = false;
    if (!inFront) {
      telegraph = Math.max(this.config.minRearTelegraph, telegraph * this.config.rearTelegraphScale);
      needsWarning = true;
    }
    return { granted: true, telegraph, needsWarning, token: -1 };
  }

  /** Release a token when the attack resolves or the attacker is interrupted. */
  release(token: number): void {
    if (token < 0) return;
    const i = this.tokens.findIndex((t) => t.id === token);
    if (i >= 0) this.tokens.splice(i, 1);
  }

  /** Release every token an attacker holds (e.g. when it dies). */
  releaseOwner(owner: number): void {
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      if (this.tokens[i]!.owner === owner) this.tokens.splice(i, 1);
    }
  }

  /** Record that an attack actually connected, starting the global cooldown. */
  notifyLanded(): void {
    this.lastLanded = this.clock;
  }

  reset(): void {
    this.tokens.length = 0;
    this.lastLanded = -99;
  }
}

/**
 * Is a spawn position acceptable?
 *
 * Nothing hostile may appear close behind the player: a creature that pops in
 * outside the view cone must be far enough away that the player has time to
 * turn, hear it and react.
 */
export function isFairSpawn(
  toSpawnX: number, toSpawnZ: number,
  forwardX: number, forwardZ: number,
  distance: number,
  frontHalfAngle = DEFAULT_DIRECTOR.frontHalfAngle,
  minRearDistance = SPAWN.minRearDistance,
  minFrontDistance = SPAWN.minOccludedFrontDistance,
): boolean {
  const len = Math.hypot(toSpawnX, toSpawnZ) || 1;
  const dot = (toSpawnX / len) * forwardX + (toSpawnZ / len) * forwardZ;
  const inFront = dot >= Math.cos(frontHalfAngle);
  return distance >= (inFront ? minFrontDistance : minRearDistance);
}

/**
 * Direction of an incoming hit relative to where the player is looking, as a
 * value in [-PI, PI] where 0 is straight ahead. Drives the directional damage
 * indicator.
 */
export function relativeBearing(
  fromX: number, fromZ: number,
  playerX: number, playerZ: number,
  yaw: number,
): number {
  const dx = fromX - playerX;
  const dz = fromZ - playerZ;
  const angle = Math.atan2(dx, -dz);
  let rel = angle + yaw;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  return rel;
}
