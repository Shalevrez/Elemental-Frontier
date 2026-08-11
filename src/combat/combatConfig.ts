/**
 * Central combat tuning.
 *
 * Every number that decides whether an attack connects, how much it hurts and
 * how long the player has to react lives here rather than being scattered
 * through the ability and enemy code. Pure data - no engine imports - so the
 * tests can assert against the same constants the game uses.
 */

export interface AbilityCombatDef {
  /** Base damage before element, build and affinity multipliers. */
  readonly damage: number;
  /** Maximum distance the attack can reach. */
  readonly range: number;
  /** Radius of the collision volume. Matches the visual width. */
  readonly radius: number;
  /** Projectile speed, where relevant. */
  readonly speed?: number;
  /** Explosion / splash radius. */
  readonly splash?: number;
  /** Knockback impulse applied to the victim. */
  readonly knockback: number;
  /** Seconds the victim is staggered. */
  readonly stagger: number;
  /** Seconds a continuous cast lasts (0 = instant). */
  readonly castTime?: number;
  /** Minimum seconds between damage ticks on the same target. */
  readonly damageInterval?: number;
  /** Half-angle of a cone attack, in radians. */
  readonly coneHalfAngle?: number;
}

export const ABILITY_COMBAT: Readonly<Record<string, AbilityCombatDef>> = Object.freeze({
  // ---- Water
  'water-whip': Object.freeze({
    damage: 13, range: 9, radius: 0.85, knockback: 5, stagger: 0.15,
    // A short controlled stream rather than a single instant bullet.
    castTime: 0.32, damageInterval: 0.12,
  }),
  freeze: Object.freeze({
    damage: 7, range: 14, radius: 5.4, knockback: 0, stagger: 0.2, splash: 5.4,
  }),
  // ---- Fire
  fireball: Object.freeze({
    damage: 18, range: 90, radius: 0.55, speed: 36, splash: 3.4,
    knockback: 5, stagger: 0,
  }),
  'flame-wave': Object.freeze({
    damage: 15, range: 12, radius: 2.0, knockback: 5, stagger: 0.25,
    coneHalfAngle: 0.63,
  }),
  // ---- Earth
  'rock-shot': Object.freeze({
    damage: 26, range: 80, radius: 0.7, speed: 27, splash: 2.2,
    knockback: 11, stagger: 0.55,
  }),
  'raise-wall': Object.freeze({
    damage: 0, range: 4, radius: 1.6, knockback: 0, stagger: 0,
  }),
  // ---- Air
  gust: Object.freeze({
    damage: 11, range: 11, radius: 1.0, knockback: 15, stagger: 0.35,
    coneHalfAngle: 0.62,
  }),
  'air-dash': Object.freeze({
    damage: 9, range: 3.2, radius: 1.6, knockback: 6, stagger: 0.2,
  }),
});

export function abilityCombat(id: string): AbilityCombatDef {
  return ABILITY_COMBAT[id] ?? ABILITY_COMBAT.gust!;
}

/**
 * First-person aim forgiveness.
 *
 * Deliberately gentle: it widens the shot slightly and nudges the direction
 * toward an enemy the crosshair is already nearly on. It never snaps the
 * camera and never reaches an enemy the player could not see.
 */
export const AIM = Object.freeze({
  /** Enemy hit capsules are inflated by this much for player attacks. */
  hitboxPadding: 0.28,
  /** Maximum angle, in radians, the aim may be nudged (~3.4 degrees). */
  assistHalfAngle: 0.06,
  /** Aim assist is only considered within this distance. */
  assistRange: 45,
  /** Fraction of the way the direction is bent toward the target. */
  assistStrength: 0.85,
  /** Below this screen-space angle the target counts as "already aimed at". */
  targetHighlightAngle: 0.075,
  /** Extra radius added to instant (non-projectile) volume tests. */
  volumePadding: 0.15,
});

/** Enemy reaction feel, keyed by how heavy the creature is. */
export const REACTION = Object.freeze({
  /** Knockback multiplier by knockbackResist tier. */
  lightKnockback: 1.0,
  heavyKnockback: 0.35,
  /** Seconds of visible flinch. */
  flinchSeconds: 0.18,
  /** How far a light enemy is visibly pushed back during a flinch. */
  flinchOffset: 0.22,
  /** Material flash length. */
  flashSeconds: 0.16,
  /** Damage as a fraction of max health that counts as a "big" hit. */
  bigHitFraction: 0.12,
});

/** Combat director limits. Mirrors the defaults in CombatDirector. */
export const DIRECTOR = Object.freeze({
  maxTokens: 2,
  globalCooldown: 0.55,
  minTelegraph: 0.35,
  minRearTelegraph: 0.85,
  rearTelegraphScale: 1.6,
  /** Nothing hostile may appear closer than this behind the player. */
  minRearSpawnDistance: 26,
  minFrontSpawnDistance: 14,
});

/** Status effect tuning that combat reads directly. */
export const STATUS_TUNING = Object.freeze({
  /** Water Whip soak duration. */
  wetSeconds: 6,
  /** Slow multiplier and duration applied by Water Whip. */
  whipSlowFactor: 0.5,
  whipSlowSeconds: 2.6,
  /** Freeze duration on a dry target. */
  freezeSeconds: 2.4,
  /** Freeze duration on an already-wet target - the payoff of the combo. */
  freezeSecondsWhenWet: 4.2,
  /** Burning damage-per-second baseline. */
  burnDps: 5.5,
  burnSeconds: 4,
});

/**
 * Reference hit counts used to sanity-check pacing.
 *
 * These are assertions about how the game should feel, and the tests check the
 * real numbers land inside them.
 */
export const PACING = Object.freeze({
  small: { minHits: 2, maxHits: 4 },
  medium: { minHits: 5, maxHits: 8 },
  heavy: { minHits: 7, maxHits: 14 },
});
