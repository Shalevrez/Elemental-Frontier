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

export type AttackDenial = 'no-token' | 'too-soon' | 'crowded';

export interface DirectorConfig {
  /** How many creatures may be mid-attack at once. */
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
}

export const DEFAULT_DIRECTOR: Readonly<DirectorConfig> = Object.freeze({
  maxTokens: 2,
  globalCooldown: 0.55,
  frontHalfAngle: 1.05, // ~60 degrees each side
  rearTelegraphScale: 1.6,
  minTelegraph: 0.35,
  minRearTelegraph: 0.85,
});

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
}

export class CombatDirector {
  private config: DirectorConfig;
  private tokens: HeldToken[] = [];
  private nextToken = 1;
  private clock = 0;
  private lastLanded = -99;
  /** Difficulty scaling raises the cap slightly as a run progresses. */
  private extraTokens = 0;

  constructor(config: Partial<DirectorConfig> = {}) {
    this.config = { ...DEFAULT_DIRECTOR, ...config };
  }

  configure(patch: Partial<DirectorConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Raise the simultaneous-attacker cap as difficulty climbs. */
  setDepth(depth: number): void {
    this.extraTokens = Math.min(2, Math.floor(Math.max(0, depth) / 3));
  }

  get maxTokens(): number {
    return this.config.maxTokens + this.extraTokens;
  }

  get activeAttackers(): number {
    return this.tokens.length;
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
   * @param owner stable id of the attacker
   * @param baseTelegraph the attack's designed wind-up
   * @param inFront whether the attacker is inside the player's view cone
   * @param needsToken false for ranged pot-shots that never crowd the player
   */
  request(owner: number, baseTelegraph: number, inFront: boolean, needsToken: boolean): AttackGrant {
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

    if (!needsToken) {
      return { granted: true, telegraph, needsWarning, token: -1 };
    }

    if (this.tokens.length >= this.maxTokens) {
      return { ...DENIED, reason: 'no-token' };
    }
    if (this.tokens.some((t) => t.owner === owner)) {
      return { ...DENIED, reason: 'crowded' };
    }

    const token = this.nextToken++;
    this.tokens.push({ id: token, owner, expires: this.clock + telegraph + 1.2 });
    return { granted: true, telegraph, needsWarning, token };
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
  minRearDistance = 26,
  minFrontDistance = 14,
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
