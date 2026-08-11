/**
 * Elemental affinity assignment.
 *
 * The affinity is rolled exactly once, when a brand new world is created, and
 * is then permanent for that world. This module is deliberately pure and free
 * of engine dependencies so the weighted selection can be tested exhaustively.
 */

export type ElementId = 'air' | 'water' | 'earth' | 'fire';
export type AffinityId = ElementId | 'convergence';

export interface AffinityWeight {
  readonly id: AffinityId;
  readonly weight: number;
}

/**
 * Exact integer weights required by the design.
 * Earth 3, Fire 3, Water 2, Air 2, Convergence (all four) 1 -> total 11.
 *
 * Order matters: it defines the cumulative boundaries used by
 * `affinityFromRoll`, and the tests assert those boundaries.
 */
export const AFFINITY_WEIGHTS: readonly AffinityWeight[] = Object.freeze([
  Object.freeze({ id: 'earth' as const, weight: 3 }),
  Object.freeze({ id: 'fire' as const, weight: 3 }),
  Object.freeze({ id: 'water' as const, weight: 2 }),
  Object.freeze({ id: 'air' as const, weight: 2 }),
  Object.freeze({ id: 'convergence' as const, weight: 1 }),
]);

/** Sum of all affinity weights. Must be 11. */
export const TOTAL_AFFINITY_WEIGHT: number = AFFINITY_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);

export const ALL_AFFINITIES: readonly AffinityId[] = Object.freeze(
  AFFINITY_WEIGHTS.map((w) => w.id),
);

/**
 * Map an integer roll in [0, TOTAL_AFFINITY_WEIGHT) onto an affinity.
 *
 * Boundaries with the weights above:
 *   0,1,2      -> earth
 *   3,4,5      -> fire
 *   6,7        -> water
 *   8,9        -> air
 *   10         -> convergence
 *
 * Rolls outside the range are clamped so the function can never throw.
 */
export function affinityFromRoll(roll: number): AffinityId {
  const r = Math.floor(Number.isFinite(roll) ? roll : 0);
  const bounded = r < 0 ? 0 : r >= TOTAL_AFFINITY_WEIGHT ? TOTAL_AFFINITY_WEIGHT - 1 : r;
  let acc = 0;
  for (const entry of AFFINITY_WEIGHTS) {
    acc += entry.weight;
    if (bounded < acc) return entry.id;
  }
  // Unreachable with valid weights; keeps the function total.
  return AFFINITY_WEIGHTS[AFFINITY_WEIGHTS.length - 1]!.id;
}

/**
 * Roll a brand new affinity.
 *
 * @param random injectable [0,1) source, defaults to Math.random.
 *               The roll is never biased or overridden anywhere in the game.
 */
export function rollAffinity(random: () => number = Math.random): AffinityId {
  const raw = random();
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.9999999999) : 0;
  return affinityFromRoll(Math.floor(unit * TOTAL_AFFINITY_WEIGHT));
}

/** Type guard for values loaded from LocalStorage. */
export function isAffinityId(value: unknown): value is AffinityId {
  return typeof value === 'string' && (ALL_AFFINITIES as readonly string[]).includes(value);
}

/** True when the affinity grants access to all four elements. */
export function isConvergence(affinity: AffinityId): boolean {
  return affinity === 'convergence';
}

/** Elements the given affinity may ever use. */
export function elementsFor(affinity: AffinityId): ElementId[] {
  return affinity === 'convergence' ? ['air', 'water', 'earth', 'fire'] : [affinity];
}

/**
 * Resolve which element is actually active.
 *
 * Single-element players are always locked to their own element regardless of
 * what a (possibly tampered) save file claims.
 */
export function resolveActiveElement(affinity: AffinityId, stored: unknown): ElementId {
  if (affinity !== 'convergence') return affinity;
  const allowed: ElementId[] = ['air', 'water', 'earth', 'fire'];
  if (typeof stored === 'string' && (allowed as string[]).includes(stored)) {
    return stored as ElementId;
  }
  return 'air';
}

/** Human readable probability table, used by the UI and the README. */
export function affinityOdds(): { id: AffinityId; weight: number; percent: number }[] {
  return AFFINITY_WEIGHTS.map((w) => ({
    id: w.id,
    weight: w.weight,
    percent: (w.weight / TOTAL_AFFINITY_WEIGHT) * 100,
  }));
}
