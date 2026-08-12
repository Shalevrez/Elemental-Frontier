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
  // Air trades raw single-target damage for reach, control and mobility, but
  // it still has to be able to finish a heavy on its own, so the floor sits
  // close enough to the other primaries that no mandatory creature becomes a
  // sponge for a focused Gale adept.
  gust: Object.freeze({
    damage: 13, range: 11, radius: 1.0, knockback: 15, stagger: 0.35,
    coneHalfAngle: 0.62,
  }),
  'air-dash': Object.freeze({
    damage: 10, range: 3.2, radius: 1.6, knockback: 6, stagger: 0.2,
  }),

  // ---- Techniques (Q)
  'tidal-pull': Object.freeze({
    damage: 9, range: 18, radius: 7, knockback: 0, stagger: 0.5, splash: 7,
  }),
  'flame-dash': Object.freeze({
    damage: 22, range: 12, radius: 1.5, knockback: 6, stagger: 0.3, speed: 30,
  }),
  'seismic-slam': Object.freeze({
    damage: 24, range: 14, radius: 2.4, knockback: 7, stagger: 0.9, splash: 3,
  }),
  'air-blades': Object.freeze({
    damage: 14, range: 26, radius: 0.5, speed: 44, knockback: 4, stagger: 0.15,
  }),

  // ---- Ultimates (middle mouse / R)
  maelstrom: Object.freeze({
    damage: 16, range: 20, radius: 11, knockback: 0, stagger: 0.3, splash: 11,
    castTime: 6, damageInterval: 0.5,
  }),
  inferno: Object.freeze({
    damage: 20, range: 20, radius: 12, knockback: 4, stagger: 0.2, splash: 12,
    castTime: 6, damageInterval: 0.5,
  }),
  'tectonic-rupture': Object.freeze({
    damage: 46, range: 18, radius: 12, knockback: 16, stagger: 1.4, splash: 12,
    castTime: 1.2,
  }),
  cyclone: Object.freeze({
    damage: 14, range: 24, radius: 7.5, knockback: 9, stagger: 0.4, splash: 7.5,
    castTime: 7, damageInterval: 0.45, speed: 6,
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
  globalCooldown: 0.6,
  minTelegraph: 0.35,
  minRearTelegraph: 0.85,
  rearTelegraphScale: 1.6,
  /** Nothing hostile may appear closer than this behind the player. */
  minRearSpawnDistance: 26,
  minFrontSpawnDistance: 16,
});

/**
 * Attack-token budget.
 *
 * Tokens are spent by *weight*, not by head count, because a slow overhead
 * slam and a pot-shot are not the same amount of pressure on a first-person
 * player. A heavy telegraphed area attack costs two, an ordinary swing one,
 * and ranged fire draws from its own small pool so a line of spitters cannot
 * put four projectiles in the air at once while something is already swinging.
 */
export const TOKENS = Object.freeze({
  /** Weight budget by run depth. Early / mid / late-game. */
  earlyBudget: 2,
  midBudget: 3,
  lateBudget: 4,
  /** Depth at which the budget steps up. */
  midDepth: 6,
  lateDepth: 15,
  /** Weight of an ordinary melee swing. */
  weightLight: 1,
  /** Weight of a heavy area / cone attack with a large ground marker. */
  weightHeavy: 2,
  /** Weight of a ranged volley. */
  weightRanged: 1,
  /** A ground marker at least this wide counts as a heavy attack. */
  heavyMarkerRadius: 3,
  /** Simultaneous ranged attackers, by the same depth bands. */
  earlyRanged: 1,
  midRanged: 2,
  lateRanged: 2,
  /** Only ever one large area attack committed at a time. */
  maxSimultaneousArea: 1,
});

/**
 * Encounter pacing.
 *
 * The cycle the director drives is: explore -> buildup -> active -> peak ->
 * resolve -> recover, and back to explore. These numbers are what make that
 * cycle feel like a rhythm rather than a faucet.
 */
export const ENCOUNTER = Object.freeze({
  /** While exploring, something should turn up inside this window. */
  discoveryMin: 30,
  discoveryMax: 60,
  /** How long a standard encounter should run for. */
  targetMin: 25,
  targetMax: 75,
  /** Quiet seconds granted after a meaningful encounter resolves. */
  recoverySeconds: 9,
  /** Seconds between the first spawn and the creatures being allowed to engage. */
  buildupSeconds: 2.2,
  /** Threat budget for one encounter, before depth scaling. */
  baseBudget: 5,
  budgetPerDepth: 0.45,
  maxBudget: 10,
  /** Extra threat reinforcements may add, as a fraction of the base budget. */
  reinforcementFraction: 0.6,
  /** No reinforcements after this fraction of the maximum encounter length. */
  reinforcementWindow: 0.65,
  /** Never force a fight on a player below this fraction of maximum health. */
  lowHealthFraction: 0.25,
  /** Hard ceiling on live wandering creatures, whatever the budget says. */
  maxWanderers: 9,
  /** An encounter that outlives this is closed out so pacing can restart. */
  hardTimeout: 110,
  /**
   * How much longer an encounter runs than the time spent purely dealing
   * damage: closing distance, reading telegraphs, dodging and repositioning.
   * Used by the balance tests to turn a damage-per-second model into an
   * encounter length that can be compared against the pacing targets.
   */
  combatOverhead: 2.5,
  /** Recent-intensity decay: how fast the "we just fought" memory fades. */
  intensityDecay: 0.12,
  /** Above this residual intensity the director will not open a new encounter. */
  intensityCeiling: 0.6,
});

/**
 * Spawn placement rules.
 *
 * A creature may never simply appear in the player's view at conversational
 * range, and it may never appear inside the world, on a hazard, or somewhere
 * it cannot walk out of.
 */
export const SPAWN = Object.freeze({
  /** Minimum distance when the spawn point is visible from the player's eye. */
  minVisibleDistance: 28,
  /** Minimum distance when it is in the view cone but behind cover. */
  minOccludedFrontDistance: 16,
  /** Minimum distance when it is outside the view cone. */
  minRearDistance: 26,
  /** Nothing spawns further out than this - it would never find the player. */
  maxDistance: 46,
  /** Clear vertical space a creature needs above the ground it stands on. */
  headroom: 2.2,
  /** Ground-height difference across the footprint that counts as unreachable. */
  maxSlope: 3,
  /** How far above the fluid surface solid ground must sit. */
  waterClearance: 0.6,
  /** Keep-out radius around shrines and other protected structures. */
  protectedRadius: 12,
  /** Placement attempts before the director gives up for this tick. */
  attempts: 18,
  /** A creature stuck this long with no path to the player is recovered. */
  stuckSeconds: 12,
  /** Distance beyond which a creature is considered lost and is despawned. */
  abandonDistance: 95,
});

/**
 * Incoming damage.
 *
 * Enemy health may climb steeply with depth; enemy *damage* may not, because a
 * first-person player cannot out-read a hit that removes half their bar.
 */
export const INCOMING = Object.freeze({
  /** Difficulty applied to enemy health: 1 + min(cap, depth * rate). */
  healthPerDepth: 0.055,
  healthCap: 1.6,
  /** Difficulty applied to enemy damage - deliberately much flatter. */
  damagePerDepth: 0.03,
  damageCap: 0.6,
  /** Ceiling on a single non-boss hit, as a fraction of maximum health. */
  maxHitFraction: 0.32,
  /** Bosses may hit harder, because their telegraphs are longer and clearer. */
  maxBossHitFraction: 0.45,
  /** Ceiling on stacked environmental damage-over-time, in points per second. */
  maxEnvironmentDps: 14,
  /** Seconds of immunity after taking a hit, which is what stops stagger locks. */
  postHitInvuln: 0.6,
  /** Seconds of immunity after a hit that a shield fully absorbed. */
  postShieldInvuln: 0.4,
});

/**
 * Elemental resistance limits.
 *
 * A resistance of 0.25 reads on paper as "fire is a bad idea here" and reads
 * in play as "this creature is a sponge and my whole build is wrong". Every
 * multiplier is clamped into this band, which keeps the identities - fire
 * really is the wrong answer to an Obsidian-Clad - without ever making a
 * focused adept unable to finish a creature the game requires them to fight.
 */
export const RESISTANCE = Object.freeze({
  floor: 0.55,
  ceiling: 1.8,
});

/** Clamp a raw resistance multiplier into the playable band. */
export function clampResistance(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(RESISTANCE.ceiling, Math.max(RESISTANCE.floor, value));
}

/**
 * Time-to-kill bands, in seconds, using an unupgraded focused adept's primary.
 *
 * The ceilings are the important half: they are what "normal enemies must not
 * feel like damage sponges" means as a number. The floors keep the tiers
 * distinguishable from one another.
 */
export const TIME_TO_KILL = Object.freeze({
  small: { min: 0.5, max: 3 },
  standard: { min: 1.2, max: 6.5 },
  heavy: { min: 3, max: 14 },
  guardian: { min: 8, max: 60 },
});

/**
 * A deterministic model of what the player actually does per second.
 *
 * This is not used by the running game - the real numbers come from the
 * ability code - but it is the same arithmetic, so the balance tests can
 * assert time-to-kill without a renderer. Keeping it beside the values it
 * models is what stops it from drifting.
 */
export const REFERENCE = Object.freeze({
  /** Damage multiplier a focused single-element adept enjoys. */
  focusedAffinity: 1.15,
  /** Damage multiplier for Elemental Convergence. */
  convergenceAffinity: 1.0,
  /** Seconds of burning a fresh application is worth. */
  burnSeconds: 4,
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
 * real numbers land inside them. `medium` is the old name for `standard` and
 * is kept so nothing that reads it has to change.
 */
export const PACING = Object.freeze({
  small: { minHits: 2, maxHits: 4 },
  standard: { minHits: 4, maxHits: 7 },
  medium: { minHits: 4, maxHits: 8 },
  heavy: { minHits: 7, maxHits: 15 },
  /** Bosses are paced by phases and mechanics, so only a ceiling applies. */
  guardian: { minHits: 8, maxHits: 42 },
});

/**
 * Damage one cast of an ability actually delivers to a single target.
 *
 * Continuous casts (the Water Whip) split their damage across a fixed number
 * of interval-protected ticks, so the number on the tin is not what one target
 * takes. This reproduces that arithmetic exactly, which is what lets the
 * balance tests reason about time-to-kill without running the game.
 */
export function damagePerCast(id: string): number {
  const def = abilityCombat(id);
  if (!def.castTime || !def.damageInterval) return def.damage;
  const ticks = Math.floor(def.castTime / def.damageInterval) + 1;
  return def.damage * ticks * (def.damageInterval / def.castTime);
}

/** The primary attack each element opens with. */
export const PRIMARY_ABILITY: Readonly<Record<string, string>> = Object.freeze({
  air: 'gust',
  water: 'water-whip',
  earth: 'rock-shot',
  fire: 'fireball',
});

/**
 * Single-target damage per second of an element's primary, before upgrades.
 *
 * Cooldown-bound, since every primary is gated by its own cooldown rather than
 * by how fast the player can click. Burning is folded in for Fire because a
 * Fireball that does not burn is not what a Fireball is.
 */
export function primaryDps(element: string, affinity = REFERENCE.focusedAffinity): number {
  const id = PRIMARY_ABILITY[element] ?? 'gust';
  const perCast = damagePerCast(id) * affinity;
  const cooldown = PRIMARY_COOLDOWN[element] ?? 0.6;
  const burn = element === 'fire' ? STATUS_TUNING.burnDps : 0;
  return perCast / cooldown + burn;
}

/**
 * Primary cooldowns, mirrored from the ability definitions.
 *
 * Duplicated here rather than imported so this module stays pure data with no
 * dependency on the element registry; the tests assert the two agree.
 */
export const PRIMARY_COOLDOWN: Readonly<Record<string, number>> = Object.freeze({
  air: 0.6,
  water: 0.55,
  earth: 0.9,
  fire: 0.8,
});
