/**
 * Permanent progression that survives between runs.
 *
 * Deliberately light on raw stats: almost everything it buys *widens* the
 * game (new upgrades, enemies, scenarios, worlds) rather than making the
 * player numerically stronger, so the run rewards stay the main source of
 * power. Pure and testable.
 */

export type UnlockKind = 'upgrade-pool' | 'enemy' | 'scenario' | 'world' | 'cosmetic' | 'modifier';

export interface UnlockDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: UnlockKind;
  readonly cost: number;
  readonly requires?: readonly string[];
}

function u(d: UnlockDef): UnlockDef {
  return Object.freeze(d);
}

/** Permanent currency earned by making progress in a run. */
export const CURRENCY_NAME = 'Echoes';

export const UNLOCKS: readonly UnlockDef[] = Object.freeze([
  u({
    id: 'world-depths', name: 'Tidal Archipelago', kind: 'world', cost: 30,
    description: 'Opens the broken sea of islands: deep water, drowned ruins and air pockets.',
  }),
  u({
    id: 'world-peaks', name: 'Frozen Expanse', kind: 'world', cost: 55,
    requires: ['world-ashen'],
    description: 'Opens the high snowfields: blizzards, slick ice and breakable frozen lakes.',
  }),
  u({
    id: 'world-ashen', name: 'Ember Caldera', kind: 'world', cost: 55,
    requires: ['world-depths'],
    description: 'Opens the volcanic basin: lava rivers, heat vents and things that do not burn.',
  }),
  u({
    id: 'pool-legendary', name: 'Echoing Legends', kind: 'upgrade-pool', cost: 45,
    description: 'Legendary rewards begin appearing in the reward pool.',
  }),
  u({
    id: 'enemy-summoner', name: 'Blight Wardens', kind: 'enemy', cost: 20,
    description: 'Wardens that call reinforcements start appearing in the Verdance.',
  }),
  u({
    id: 'enemy-burrower', name: 'Burrowers', kind: 'enemy', cost: 25,
    description: 'Ambushers that travel underground join the roster.',
  }),
  u({
    id: 'scenario-siege', name: 'Siege Doctrine', kind: 'scenario', cost: 25,
    description: 'Adds defence and escort scenarios to the rotation.',
  }),
  u({
    id: 'scenario-puzzle', name: 'Old Rites', kind: 'scenario', cost: 20,
    description: 'Adds elemental puzzle and hidden-exit scenarios.',
  }),
  u({
    id: 'modifier-harder', name: 'Deeper Blight', kind: 'modifier', cost: 40,
    description: 'Optional difficulty modifier: tougher elites, richer rewards.',
  }),
  u({
    id: 'cosmetic-aura', name: 'Adept’s Aura', kind: 'cosmetic', cost: 15,
    description: 'Your affinity trails a faint elemental aura.',
  }),
]);

const BY_ID = new Map(UNLOCKS.map((x) => [x.id, x]));

export function unlockById(id: string): UnlockDef | null {
  return BY_ID.get(id) ?? null;
}

export interface MetaState {
  /** Unspent permanent currency. */
  echoes: number;
  /** Purchased unlock ids. */
  unlocked: string[];
  /** Lifetime statistics. */
  runs: number;
  bestDepth: number;
  bossesFelled: number;
}

export function createMeta(): MetaState {
  return { echoes: 0, unlocked: [], runs: 0, bestDepth: 0, bossesFelled: 0 };
}

export function sanitiseMeta(raw: unknown): MetaState {
  const meta = createMeta();
  if (!raw || typeof raw !== 'object') return meta;
  const src = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo;
  };
  meta.echoes = num(src.echoes, 0, 1e7);
  meta.runs = num(src.runs, 0, 1e6);
  meta.bestDepth = num(src.bestDepth, 0, 1000);
  meta.bossesFelled = num(src.bossesFelled, 0, 1e6);
  if (Array.isArray(src.unlocked)) {
    for (const id of src.unlocked) {
      if (typeof id === 'string' && BY_ID.has(id) && !meta.unlocked.includes(id)) {
        meta.unlocked.push(id);
      }
    }
  }
  return meta;
}

export function unlockedSet(meta: MetaState): Set<string> {
  return new Set(meta.unlocked);
}

export type PurchaseResult =
  | { ok: true; spent: number }
  | { ok: false; reason: 'unknown' | 'owned' | 'locked' | 'poor' };

export function purchase(meta: MetaState, id: string): PurchaseResult {
  const def = unlockById(id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (meta.unlocked.includes(id)) return { ok: false, reason: 'owned' };
  for (const req of def.requires ?? []) {
    if (!meta.unlocked.includes(req)) return { ok: false, reason: 'locked' };
  }
  if (meta.echoes < def.cost) return { ok: false, reason: 'poor' };
  meta.echoes -= def.cost;
  meta.unlocked.push(id);
  return { ok: true, spent: def.cost };
}

export interface RunSummary {
  depth: number;
  enemiesFelled: number;
  elitesFelled: number;
  bossesFelled: number;
  scenariosCompleted: number;
  shrinesCleansed: number;
  upgradesTaken: number;
  worldsReached: number;
}

/**
 * Convert a finished run into permanent currency.
 *
 * Weighted toward *doing interesting things* rather than time spent, so
 * grinding trash is never the efficient path.
 */
export function echoesForRun(summary: RunSummary): number {
  const s = summary;
  return Math.max(
    1,
    Math.round(
      s.depth * 3
      + s.enemiesFelled * 0.35
      + s.elitesFelled * 4
      + s.bossesFelled * 18
      + s.scenariosCompleted * 6
      + s.shrinesCleansed * 10
      + s.worldsReached * 5,
    ),
  );
}

/** Apply a finished run to the meta state and return the reward. */
export function bankRun(meta: MetaState, summary: RunSummary): number {
  const earned = echoesForRun(summary);
  meta.echoes += earned;
  meta.runs += 1;
  meta.bestDepth = Math.max(meta.bestDepth, summary.depth);
  meta.bossesFelled += summary.bossesFelled;
  return earned;
}
