/**
 * World difficulty progression.
 *
 * The four worlds were structurally different - real islands, a real lava
 * basin, a real snowfield - but they fought identically. Every world drew from
 * its roster at random, every world used the same elite chance, every shrine
 * was held by the same guardian with the same three attacks, and New Game Plus
 * incremented a counter that nothing read.
 *
 * This module is what makes the campaign a curve. Each world declares how it
 * wants to be fought rather than how much health to add:
 *
 *   Verdant Ruins    teaches - few roles at once, generous space, no hazard
 *   Tidal Archipelago tests movement and resources - amphibious, spread out
 *   Ember Caldera    applies positional pressure - armour, ranged, lava
 *   Frozen Expanse   combines everything - mobility, control, poor visibility
 *
 * Numerical scaling exists, but it is the support act: the profile mostly
 * changes *composition* - how many things shoot at you at once, how much of the
 * budget goes to heavies, how willing the world is to promote an elite.
 *
 * Pure data and arithmetic, so the whole curve is testable without a world.
 */

import type { EnemyKind, EnemyRole } from '../combat/enemyTypes';
import { ENEMY_TYPES } from '../combat/enemyTypes';
import type { WorldId } from './worlds';
import { WORLD_ORDER, worldIndex } from './worlds';

/**
 * How a world wants its fights to feel.
 *
 * Every field is a *composition* control except the two clearly-labelled
 * numeric ones, and even those are deliberately gentle.
 */
export interface WorldProfile {
  /** One line, for the codex and for whoever reads this file next. */
  readonly intent: string;
  /**
   * Largest share of an encounter's threat budget that may go to creatures
   * which attack from range. This is the single most important difficulty
   * control in a first-person game: three archers is a different fight from
   * three brawlers, whatever their health says.
   */
  readonly rangedShare: number;
  /** Largest share of the budget that may go to heavy, armoured creatures. */
  readonly heavyShare: number;
  /** Multiplier on the run's elite promotion chance. */
  readonly eliteScale: number;
  /** Extra threat budget, as a multiplier on the encounter budget. */
  readonly budgetScale: number;
  /**
   * How often the world's signature creature is favoured over the rest of the
   * roster, 0..1. This is what makes a world's fights recognisable.
   */
  readonly signatureBias: number;
  /** Multiplier on the world's environmental hazard damage. */
  readonly hazardScale: number;
  /**
   * Extra simultaneous-attacker weight this world is allowed, on top of the
   * depth-derived budget. Only the later worlds get any, and never more than
   * the combat pass's ceiling of four.
   */
  readonly tokenBonus: number;
  /** Roles this world leans on, used to bias composition. */
  readonly favouredRoles: readonly EnemyRole[];
}

export const WORLD_PROFILES: Readonly<Record<WorldId, WorldProfile>> = Object.freeze({
  // Teaches. One idea at a time: a melee role, a ranged role, and enough room
  // to see both. No hazard, few elites, and the smallest budget in the game.
  wilds: Object.freeze({
    intent: 'Teaches the fundamentals with readable, separable roles.',
    rangedShare: 0.3,
    heavyShare: 0.35,
    eliteScale: 0.6,
    budgetScale: 0.85,
    signatureBias: 0.3,
    hazardScale: 0,
    tokenBonus: 0,
    favouredRoles: ['melee', 'ranged'] as EnemyRole[],
  }),

  // Tests movement and resource awareness. Ambushers that come up out of the
  // silt and support that has to be chased down, so standing still is the
  // wrong answer and Mana spent on the wrong target is Mana gone.
  depths: Object.freeze({
    intent: 'Tests movement and resource awareness with ambush and support.',
    rangedShare: 0.4,
    heavyShare: 0.4,
    eliteScale: 0.9,
    budgetScale: 1,
    signatureBias: 0.45,
    hazardScale: 0,
    tokenBonus: 0,
    favouredRoles: ['ambush', 'support', 'ranged'] as EnemyRole[],
  }),

  // Applies positional pressure. Armour that has to be broken and ranged fire
  // that punishes standing still, over a floor that is actively dangerous.
  ashen: Object.freeze({
    intent: 'Applies positional pressure: armour, ranged fire and a lethal floor.',
    rangedShare: 0.5,
    heavyShare: 0.55,
    eliteScale: 1.15,
    budgetScale: 1.1,
    signatureBias: 0.4,
    hazardScale: 1,
    tokenBonus: 0,
    favouredRoles: ['tank', 'ranged', 'suicide'] as EnemyRole[],
  }),

  // Combines everything already mastered, and takes away the visibility that
  // made it easy. One extra attacker's worth of pressure, and the roster with
  // the most mobility in it.
  peaks: Object.freeze({
    intent: 'Combines mastered systems under poor visibility and slick ground.',
    rangedShare: 0.45,
    heavyShare: 0.5,
    eliteScale: 1.35,
    budgetScale: 1.2,
    signatureBias: 0.35,
    hazardScale: 1,
    tokenBonus: 1,
    favouredRoles: ['melee', 'ranged', 'tank'] as EnemyRole[],
  }),
});

/**
 * New Game Plus scaling.
 *
 * Difficulty here comes from *combination*, not from arithmetic: more elites,
 * more of the budget allowed to be ranged or heavy, one more attacker at the
 * top end. The numeric part is deliberately small and hard-capped, because a
 * cycle that multiplies health without limit stops being a harder game and
 * starts being an impossible one.
 */
export const NG_PLUS = Object.freeze({
  /** Cycles beyond which nothing further scales. */
  maxCycles: 5,
  /** Added to the elite multiplier per cycle. */
  elitePerCycle: 0.25,
  eliteCap: 2.4,
  /** Added to the encounter threat budget per cycle. */
  budgetPerCycle: 0.12,
  budgetCap: 1.6,
  /** Added to the ranged and heavy budget shares per cycle. */
  sharePerCycle: 0.04,
  shareCap: 0.6,
  /** Extra simultaneous-attacker weight, reached only in the late cycles. */
  tokenPerCycle: 0.4,
  tokenCap: 1,
  /** Multiplier on enemy health per cycle - the support act, not the point. */
  healthPerCycle: 0.15,
  healthCap: 1.75,
  /** Multiplier on hazard damage per cycle. */
  hazardPerCycle: 0.12,
  hazardCap: 1.5,
});

/** Clamp a New Game Plus level into the range the scaling is defined over. */
export function ngCycles(newGamePlus: number): number {
  if (!Number.isFinite(newGamePlus)) return 0;
  return Math.min(NG_PLUS.maxCycles, Math.max(0, Math.floor(newGamePlus)));
}

/** The concrete difficulty controls for a world at a New Game Plus level. */
export interface WorldDifficulty {
  readonly world: WorldId;
  readonly cycles: number;
  /** Multiplier applied to the run's elite promotion chance. */
  readonly eliteScale: number;
  /** Multiplier applied to the encounter threat budget. */
  readonly budgetScale: number;
  /** Multiplier applied to enemy health, on top of the run's depth curve. */
  readonly healthScale: number;
  /** Multiplier applied to environmental hazard damage. */
  readonly hazardScale: number;
  /** Largest share of the budget that may be spent on ranged creatures. */
  readonly rangedShare: number;
  /** Largest share of the budget that may be spent on heavies. */
  readonly heavyShare: number;
  /** Extra simultaneous-attacker weight. */
  readonly tokenBonus: number;
  /** How strongly the world's signature creature is favoured. */
  readonly signatureBias: number;
}

/**
 * Resolve a world's difficulty.
 *
 * Everything is clamped: no combination of world, depth and New Game Plus
 * cycle can produce a value outside the bands declared above.
 */
export function worldDifficulty(world: WorldId, newGamePlus = 0): WorldDifficulty {
  const profile = WORLD_PROFILES[world];
  const cycles = ngCycles(newGamePlus);
  return {
    world,
    cycles,
    eliteScale: Math.min(
      NG_PLUS.eliteCap,
      profile.eliteScale + cycles * NG_PLUS.elitePerCycle,
    ),
    budgetScale: Math.min(
      NG_PLUS.budgetCap,
      profile.budgetScale + cycles * NG_PLUS.budgetPerCycle,
    ),
    healthScale: Math.min(
      NG_PLUS.healthCap,
      1 + cycles * NG_PLUS.healthPerCycle,
    ),
    hazardScale: profile.hazardScale === 0 ? 0 : Math.min(
      NG_PLUS.hazardCap,
      profile.hazardScale + cycles * NG_PLUS.hazardPerCycle,
    ),
    rangedShare: Math.min(
      NG_PLUS.shareCap,
      profile.rangedShare + cycles * NG_PLUS.sharePerCycle,
    ),
    heavyShare: Math.min(
      NG_PLUS.shareCap,
      profile.heavyShare + cycles * NG_PLUS.sharePerCycle,
    ),
    tokenBonus: Math.min(
      profile.tokenBonus + NG_PLUS.tokenCap,
      profile.tokenBonus + cycles * NG_PLUS.tokenPerCycle,
    ),
    signatureBias: profile.signatureBias,
  };
}

// =====================================================================
//  Encounter composition
// =====================================================================

/** Does this creature attack from range? */
export function isRanged(kind: EnemyKind): boolean {
  const type = ENEMY_TYPES[kind];
  if (type.role === 'ranged') return true;
  return type.attacks.some((a) => a.shape === 'projectile' && a.damage > 0);
}

/** Is this creature a heavy the player has to commit to? */
export function isHeavy(kind: EnemyKind): boolean {
  return ENEMY_TYPES[kind].tier === 'heavy';
}

/** What the composition rules already know about the creatures in play. */
export interface CompositionState {
  /** Threat already committed to ranged creatures this encounter. */
  rangedThreat: number;
  /** Threat already committed to heavies. */
  heavyThreat: number;
  /** Total threat committed. */
  totalThreat: number;
}

export function createComposition(): CompositionState {
  return { rangedThreat: 0, heavyThreat: 0, totalThreat: 0 };
}

/** Record a placed creature against the composition budget. */
export function notePlacement(state: CompositionState, kind: EnemyKind): void {
  const threat = ENEMY_TYPES[kind].threat;
  state.totalThreat += threat;
  if (isRanged(kind)) state.rangedThreat += threat;
  if (isHeavy(kind)) state.heavyThreat += threat;
}

/**
 * May this creature be added to the encounter?
 *
 * The shares are measured against the encounter's *whole* budget rather than
 * what has been placed so far, so the first creature cannot claim the entire
 * ranged allowance simply by arriving first.
 */
export function allowsKind(
  state: CompositionState,
  kind: EnemyKind,
  budget: number,
  difficulty: WorldDifficulty,
): boolean {
  const threat = ENEMY_TYPES[kind].threat;
  const total = Math.max(threat, budget);
  if (isRanged(kind) && state.rangedThreat + threat > total * difficulty.rangedShare + 0.001) {
    return false;
  }
  if (isHeavy(kind) && state.heavyThreat + threat > total * difficulty.heavyShare + 0.001) {
    return false;
  }
  return true;
}

/**
 * Choose what to place next.
 *
 * Filters the roster to what the budget can afford and what the composition
 * rules still allow, biases toward the world's signature creature and its
 * favoured roles, and falls back to the cheapest legal creature rather than
 * returning nothing - an encounter that cannot place anything is a silent
 * pacing failure.
 */
export function chooseKind(
  roster: readonly EnemyKind[],
  state: CompositionState,
  budget: number,
  remaining: number,
  difficulty: WorldDifficulty,
  signature: EnemyKind,
  random: () => number = Math.random,
): EnemyKind | null {
  if (roster.length === 0) return null;
  const affordable = roster.filter((k) => ENEMY_TYPES[k].threat <= remaining + 0.01);
  const pool = affordable.length > 0 ? affordable : [cheapest(roster)];
  const legal = pool.filter((k) => allowsKind(state, k, budget, difficulty));
  // If composition has closed every door, fall back to the cheapest melee
  // creature the budget can afford rather than placing nothing at all.
  const candidates = legal.length > 0
    ? legal
    : pool.filter((k) => !isRanged(k) && !isHeavy(k));
  if (candidates.length === 0) return null;

  // The signature creature gets first refusal, at the world's bias.
  if (candidates.includes(signature) && random() < difficulty.signatureBias) {
    return signature;
  }
  const profile = WORLD_PROFILES[difficulty.world];
  const favoured = candidates.filter((k) => profile.favouredRoles.includes(ENEMY_TYPES[k].role));
  const from = favoured.length > 0 && random() < 0.65 ? favoured : candidates;
  return from[Math.min(from.length - 1, Math.floor(Math.max(0, random()) * from.length))]!;
}

function cheapest(roster: readonly EnemyKind[]): EnemyKind {
  return roster.reduce((a, b) => (ENEMY_TYPES[a].threat <= ENEMY_TYPES[b].threat ? a : b));
}

// =====================================================================
//  Guardians
// =====================================================================

/**
 * One phase of a major fight.
 *
 * A guardian used to be the same three attacks at the same cadence until its
 * bar emptied. Phases give the fight a shape: a readable opening, an
 * escalation, a distinct peak, and a breathing space between each where the
 * creature is briefly vulnerable and the player can commit.
 */
export interface BossPhase {
  /** Health fraction at or below which this phase begins. */
  readonly below: number;
  /** Multiplier on attack cooldowns. Lower is faster. */
  readonly cadence: number;
  /**
   * Multiplier on telegraph length. Never below 1 in the later phases without
   * a matching drop in how much is happening at once - a fight that speeds up
   * by shortening its warnings is not harder, it is less readable.
   */
  readonly telegraph: number;
  /** Seconds the guardian is staggered and open when it enters this phase. */
  readonly recovery: number;
  /** Short line shown when the phase begins. */
  readonly note: string;
}

/**
 * A world's guardian.
 *
 * The creature is the same sculpted guardian everywhere - this is what makes
 * each one that world's guardian rather than a recolour: how much it can take,
 * how fast it moves, how long it telegraphs, and how its fight escalates.
 */
export interface GuardianProfile {
  readonly name: string;
  readonly healthScale: number;
  readonly speedScale: number;
  /** Baseline telegraph multiplier. The teaching world reads slowest. */
  readonly telegraph: number;
  readonly phases: readonly BossPhase[];
}

/** Phases shared by every guardian, scaled per world by the profile. */
function phases(openNote: string, peakNote: string, cadence: [number, number, number]): BossPhase[] {
  return [
    {
      below: 1, cadence: cadence[0], telegraph: 1.15, recovery: 0,
      note: openNote,
    },
    {
      below: 0.65, cadence: cadence[1], telegraph: 1, recovery: 1.6,
      note: 'The guardian shifts its stance.',
    },
    {
      below: 0.3, cadence: cadence[2], telegraph: 1.05, recovery: 2.2,
      note: peakNote,
    },
  ];
}

export const GUARDIAN_PROFILES: Readonly<Record<WorldId, GuardianProfile>> = Object.freeze({
  wilds: Object.freeze({
    name: 'The Rootwarden',
    healthScale: 0.82,
    speedScale: 0.92,
    // The first guardian is the tutorial's exam: it telegraphs generously and
    // never speeds up past the point where its wind-ups can be read.
    telegraph: 1.25,
    phases: Object.freeze(phases(
      'The Rootwarden wakes.',
      'The Rootwarden tears itself free of the soil.',
      [1.15, 1, 0.9],
    )),
  }),
  depths: Object.freeze({
    name: 'The Drowned Chorus',
    healthScale: 0.95,
    speedScale: 1,
    telegraph: 1.1,
    phases: Object.freeze(phases(
      'The Drowned Chorus rises.',
      'The Chorus finds its voice.',
      [1.05, 0.92, 0.84],
    )),
  }),
  ashen: Object.freeze({
    name: 'The Cinderbound',
    healthScale: 1.08,
    speedScale: 1.04,
    telegraph: 1,
    phases: Object.freeze(phases(
      'The Cinderbound stirs in the ash.',
      'Its shell cracks, and the fire underneath shows.',
      [1, 0.88, 0.8],
    )),
  }),
  peaks: Object.freeze({
    name: 'The Rimebound',
    healthScale: 1.18,
    speedScale: 1.08,
    // Even the last guardian keeps a real reaction window: the Frozen Expanse
    // already takes visibility away, and taking the telegraph too would make
    // the fight unreadable rather than hard.
    telegraph: 1,
    phases: Object.freeze(phases(
      'The Rimebound opens its eyes.',
      'The ice around it shatters outward.',
      [0.96, 0.86, 0.78],
    )),
  }),
});

/** Which phase a guardian is in, given how much of its bar is left. */
export function phaseAt(profile: GuardianProfile, healthFraction: number): number {
  const f = Math.max(0, Math.min(1, healthFraction));
  let index = 0;
  for (let i = 0; i < profile.phases.length; i++) {
    if (f <= profile.phases[i]!.below) index = i;
  }
  return index;
}

/** A guardian's health multiplier for a world at a New Game Plus level. */
export function guardianHealthScale(world: WorldId, newGamePlus = 0): number {
  const cycles = ngCycles(newGamePlus);
  return GUARDIAN_PROFILES[world].healthScale
    * Math.min(NG_PLUS.healthCap, 1 + cycles * NG_PLUS.healthPerCycle);
}

// =====================================================================
//  Curve sanity
// =====================================================================

/**
 * A single number standing for "how hard is this world".
 *
 * Only used by the tests, to assert the campaign actually climbs. It weights
 * composition far above raw numbers, which is the whole thesis of this module.
 */
export function difficultyIndex(world: WorldId, newGamePlus = 0): number {
  const d = worldDifficulty(world, newGamePlus);
  return d.rangedShare * 3
    + d.heavyShare * 3
    + d.eliteScale * 2
    + d.budgetScale * 1.5
    + d.tokenBonus * 2
    + d.hazardScale
    + d.healthScale * 0.5
    + worldIndex(world) * 0.35;
}

/** The campaign order, with each world's resolved difficulty. */
export function campaignCurve(newGamePlus = 0): { world: WorldId; index: number }[] {
  return WORLD_ORDER.map((world) => ({ world, index: difficultyIndex(world, newGamePlus) }));
}
