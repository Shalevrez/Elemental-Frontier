/**
 * Scenarios: the bounded objectives that structure a run.
 *
 * Every scenario is a small state machine with entry logic, a readable
 * objective, progress feedback, completion and (where it makes sense) failure.
 * The logic is pure so it can be driven and tested without a world; the game
 * layer supplies the events.
 *
 * Every scenario is also guarded against becoming impossible: each one either
 * has no fail state, or exposes `recover()` so a stuck objective can be
 * rescued rather than soft-locking the run.
 */

export type ScenarioKind =
  | 'clear-all'
  | 'survive-waves'
  | 'defend-crystal'
  | 'destroy-nodes'
  | 'defeat-elite'
  | 'defend-shrine'
  | 'escape-collapse'
  | 'cross-hazard'
  | 'elemental-puzzle'
  | 'hidden-exit'
  | 'boss';

export type ScenarioPhase = 'idle' | 'active' | 'complete' | 'failed';

export interface ScenarioDef {
  readonly kind: ScenarioKind;
  readonly name: string;
  /** Objective line shown in the HUD. */
  readonly objective: string;
  /** One-line explanation on the entry banner. */
  readonly brief: string;
  /** Target count: enemies, waves, nodes, seconds - depends on the kind. */
  readonly target: number;
  /** Seconds allowed, or 0 for untimed. */
  readonly timeLimit: number;
  /** Can this scenario be failed? */
  readonly failable: boolean;
  /** Reward weight: how good the reward roll is on completion. */
  readonly rewardLuck: number;
  /** Meta unlock required for this scenario to enter the rotation. */
  readonly unlock?: string;
}

function s(d: ScenarioDef): ScenarioDef {
  return Object.freeze(d);
}

export const SCENARIOS: Readonly<Record<ScenarioKind, ScenarioDef>> = Object.freeze({
  'clear-all': s({
    kind: 'clear-all', name: 'Cleansing Sweep', target: 8, timeLimit: 0, failable: false,
    objective: 'Destroy the corrupted', brief: 'The blight has gathered here. Put every last one of them down.',
    rewardLuck: 0,
  }),
  'survive-waves': s({
    kind: 'survive-waves', name: 'Hold the Line', target: 3, timeLimit: 0, failable: false,
    objective: 'Survive the waves', brief: 'They come in waves. Outlast all three.',
    rewardLuck: 0.6,
  }),
  'defend-crystal': s({
    kind: 'defend-crystal', name: 'Warding Vigil', target: 45, timeLimit: 45, failable: true,
    objective: 'Protect the elemental crystal', brief: 'The crystal must survive. Keep them off it.',
    rewardLuck: 1.1, unlock: 'scenario-siege',
  }),
  'destroy-nodes': s({
    kind: 'destroy-nodes', name: 'Rootwork', target: 4, timeLimit: 0, failable: false,
    objective: 'Destroy the corruption nodes', brief: 'Blight nodes feed this place. Break all of them.',
    rewardLuck: 0.4,
  }),
  'defeat-elite': s({
    kind: 'defeat-elite', name: 'Champion of the Blight', target: 1, timeLimit: 0, failable: false,
    objective: 'Defeat the elite', brief: 'Something bigger has taken root. Kill it.',
    rewardLuck: 1.4,
  }),
  'defend-shrine': s({
    kind: 'defend-shrine', name: 'Shrine Watch', target: 40, timeLimit: 40, failable: true,
    objective: 'Defend the shrine', brief: 'The blight wants the shrine back. Do not let them have it.',
    rewardLuck: 1.1, unlock: 'scenario-siege',
  }),
  'escape-collapse': s({
    kind: 'escape-collapse', name: 'Collapse', target: 60, timeLimit: 60, failable: true,
    objective: 'Escape before the ground gives way', brief: 'This place is coming down. Get out.',
    rewardLuck: 1.2,
  }),
  'cross-hazard': s({
    kind: 'cross-hazard', name: 'The Crossing', target: 1, timeLimit: 0, failable: false,
    objective: 'Reach the far side', brief: 'The ground between you and the marker will try to kill you.',
    rewardLuck: 0.8,
  }),
  'elemental-puzzle': s({
    kind: 'elemental-puzzle', name: 'Old Rite', target: 3, timeLimit: 0, failable: false,
    objective: 'Awaken the elemental seals', brief: 'Three seals. Strike each with any element to wake it.',
    rewardLuck: 0.9, unlock: 'scenario-puzzle',
  }),
  'hidden-exit': s({
    kind: 'hidden-exit', name: 'Buried Way', target: 1, timeLimit: 0, failable: false,
    objective: 'Find the buried way', brief: 'There is a way through here. It is under something.',
    rewardLuck: 0.7, unlock: 'scenario-puzzle',
  }),
  boss: s({
    kind: 'boss', name: 'The Sundering', target: 1, timeLimit: 0, failable: false,
    objective: 'Defeat the boss', brief: 'It knows you are here.',
    rewardLuck: 2.2,
  }),
});

export const SCENARIO_KINDS: readonly ScenarioKind[] = Object.freeze(
  Object.keys(SCENARIOS) as ScenarioKind[],
);

export function scenarioDef(kind: ScenarioKind): ScenarioDef {
  return SCENARIOS[kind];
}

export function isScenarioKind(value: unknown): value is ScenarioKind {
  return typeof value === 'string' && (SCENARIO_KINDS as readonly string[]).includes(value);
}

export interface ScenarioState {
  kind: ScenarioKind;
  phase: ScenarioPhase;
  /** Progress toward `target`. */
  progress: number;
  target: number;
  /** Seconds elapsed since it became active. */
  elapsed: number;
  /** Seconds remaining, or -1 when untimed. */
  remaining: number;
  /** Anchor position for defended objects and markers. */
  anchor: [number, number, number];
  /** Health of a defended object, 0..1. Unused by other kinds. */
  wardHealth: number;
  /** Wave index for wave scenarios. */
  wave: number;
  /** Set when the game should spawn a new wave this frame. */
  spawnRequested: boolean;
}

export function createScenario(kind: ScenarioKind, anchor: [number, number, number], depth = 0): ScenarioState {
  const def = SCENARIOS[kind];
  // Later scenarios ask a little more of the player.
  const scale = 1 + Math.min(1.2, Math.max(0, depth) * 0.12);
  const target = def.kind === 'survive-waves'
    ? Math.round(def.target + Math.min(3, Math.floor(depth / 2)))
    : def.kind === 'clear-all'
      ? Math.round(def.target * scale)
      : def.target;
  return {
    kind,
    phase: 'idle',
    progress: 0,
    target,
    elapsed: 0,
    remaining: def.timeLimit > 0 ? def.timeLimit : -1,
    anchor: [...anchor] as [number, number, number],
    wardHealth: 1,
    wave: 0,
    spawnRequested: false,
  };
}

export function beginScenario(state: ScenarioState): void {
  state.phase = 'active';
  state.elapsed = 0;
  state.progress = 0;
  state.wave = 0;
  state.wardHealth = 1;
  const def = SCENARIOS[state.kind];
  state.remaining = def.timeLimit > 0 ? def.timeLimit : -1;
  // Wave and defence scenarios want an immediate first spawn.
  state.spawnRequested = state.kind === 'survive-waves'
    || state.kind === 'defend-crystal'
    || state.kind === 'defend-shrine';
}

export interface ScenarioTick {
  completed: boolean;
  failed: boolean;
  /** True when the game should spawn the next wave. */
  spawn: boolean;
}

/**
 * Advance the scenario clock.
 *
 * Timed *defence* scenarios complete when the clock runs out; timed *escape*
 * scenarios fail when it does. `failable` marks which is which.
 */
export function tickScenario(state: ScenarioState, dt: number, liveEnemies: number): ScenarioTick {
  const result: ScenarioTick = { completed: false, failed: false, spawn: false };
  if (state.phase !== 'active') return result;

  state.elapsed += dt;
  if (state.remaining >= 0) {
    state.remaining = Math.max(0, state.remaining - dt);
  }

  if (state.spawnRequested) {
    state.spawnRequested = false;
    result.spawn = true;
  }

  switch (state.kind) {
    case 'survive-waves': {
      state.progress = state.wave;
      // A wave is cleared when nothing is left standing.
      if (liveEnemies === 0 && state.elapsed > 1.5) {
        if (state.wave >= state.target) {
          state.phase = 'complete';
          result.completed = true;
        } else {
          state.wave += 1;
          result.spawn = true;
        }
      }
      break;
    }
    case 'defend-crystal':
    case 'defend-shrine': {
      state.progress = state.target - Math.max(0, state.remaining);
      if (state.wardHealth <= 0) {
        state.phase = 'failed';
        result.failed = true;
      } else if (state.remaining === 0) {
        state.phase = 'complete';
        result.completed = true;
      } else if (liveEnemies === 0 && state.elapsed > 3) {
        // Keep the pressure on for the whole timer.
        result.spawn = true;
      }
      break;
    }
    case 'escape-collapse': {
      state.progress = state.target - Math.max(0, state.remaining);
      if (state.remaining === 0) {
        state.phase = 'failed';
        result.failed = true;
      }
      break;
    }
    default:
      break;
  }

  return result;
}

/** Report an event the scenario cares about. Returns true when it completed. */
export function reportProgress(state: ScenarioState, kind: ScenarioKind, amount = 1): boolean {
  if (state.phase !== 'active' || state.kind !== kind) return false;
  state.progress = Math.min(state.target, state.progress + amount);
  if (state.progress >= state.target) {
    state.phase = 'complete';
    return true;
  }
  return false;
}

/** Damage a defended crystal or shrine. Returns true when it has fallen. */
export function damageWard(state: ScenarioState, fraction: number): boolean {
  if (state.phase !== 'active') return false;
  if (state.kind !== 'defend-crystal' && state.kind !== 'defend-shrine') return false;
  state.wardHealth = Math.max(0, state.wardHealth - Math.max(0, fraction));
  return state.wardHealth <= 0;
}

/** Progress text for the HUD, e.g. "3 / 8" or "0:24 left". */
export function progressLabel(state: ScenarioState): string {
  const def = SCENARIOS[state.kind];
  if (def.timeLimit > 0 && state.remaining >= 0) {
    const secs = Math.ceil(state.remaining);
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} left`;
  }
  if (state.kind === 'survive-waves') return `Wave ${Math.min(state.target, state.wave + 1)} / ${state.target}`;
  return `${Math.floor(state.progress)} / ${state.target}`;
}

/** Fraction complete, for the HUD bar. */
export function progressFraction(state: ScenarioState): number {
  if (state.target <= 0) return 0;
  return Math.max(0, Math.min(1, state.progress / state.target));
}

/**
 * Rescue a scenario that can no longer be finished.
 *
 * The game calls this if, for example, a "clear all" objective outlives its
 * enemies because they despawned. Rather than soft-locking the run the
 * objective is simply granted.
 */
export function recover(state: ScenarioState): void {
  if (state.phase !== 'active') return;
  state.progress = state.target;
  state.phase = 'complete';
}

/** Choose a scenario for a world, respecting meta unlocks. */
export function pickScenario(
  pool: readonly ScenarioKind[],
  unlocked: ReadonlySet<string>,
  random: () => number = Math.random,
): ScenarioKind {
  const legal = pool.filter((k) => {
    const def = SCENARIOS[k];
    return !def.unlock || unlocked.has(def.unlock);
  });
  const list = legal.length > 0 ? legal : ['clear-all' as ScenarioKind];
  const i = Math.min(list.length - 1, Math.floor(Math.max(0, random()) * list.length));
  return list[i]!;
}
