/**
 * World transitions.
 *
 * Travelling between worlds used to be an unguarded sequence of calls: the
 * destination save was written, the loader was started, and everything after
 * that was assumed to work. It mostly did - but nothing owned the *failure*
 * cases, and a transition that stopped halfway left the game with the
 * transition flag stuck on, the previous save already overwritten, and no way
 * back to a playable world.
 *
 * This module is the engine-free half of the fix. It owns exactly one thing:
 * how far through a transition the game is, and what is still owed if it
 * stops. There is no Three.js, no DOM and no clock of its own here - the caller
 * supplies the time - so the whole lifecycle can be driven deterministically in
 * a test.
 *
 * The renderer half (tearing the world down, building the next one, placing the
 * player) stays in `Game`, which reports progress to this state machine and
 * asks it what to do when something goes wrong.
 */

/** Where a transition currently is. */
export type TransitionPhase =
  /** No transition in flight. */
  | 'idle'
  /** The destination save is being written. Nothing has been torn down yet. */
  | 'commit'
  /** The destination world is being built. */
  | 'load'
  /** Built; the player is being placed and the world handed over. */
  | 'enter';

/** Why a transition stopped short. */
export type TransitionFailure = 'write' | 'error' | 'stalled' | 'abandoned';

export const TRANSITION = Object.freeze({
  /**
   * Wall-clock seconds a transition may take before it is treated as stalled.
   *
   * Deliberately generous: a cold, low-powered machine really can spend the
   * better part of a minute meshing a world, and a recoverable transition that
   * gives up too early is its own bug. This is a backstop for a transition that
   * has genuinely stopped advancing, not a substitute for one that is merely
   * slow - progress resets the clock.
   */
  stallSeconds: 45,
});

export interface TransitionState {
  phase: TransitionPhase;
  /** World left behind. Empty while idle. */
  from: string;
  /** World being travelled to. Empty while idle. */
  to: string;
  /** Serialised save from *before* the destination was committed. */
  rollback: string | null;
  /** Wall-clock milliseconds at the last observed progress. */
  lastProgressMs: number;
  /** Highest 0..1 load progress seen so far. -1 before anything is reported. */
  progress: number;
  /** How the last transition ended, for the message the player is shown. */
  failure: TransitionFailure | null;
}

export function createTransition(): TransitionState {
  return {
    phase: 'idle', from: '', to: '', rollback: null,
    lastProgressMs: 0, progress: -1, failure: null,
  };
}

/** Is a transition in flight? While one is, another may not start. */
export function isTransitionActive(state: TransitionState): boolean {
  return state.phase !== 'idle';
}

/**
 * Claim the transition.
 *
 * Returns false when one is already running, which is what makes Beacon
 * activation idempotent: a second commit - a repeated hold, a queued input, a
 * debug call - is refused rather than stacking a second world load on top of
 * the first.
 */
export function beginTransition(
  state: TransitionState,
  from: string,
  to: string,
  rollback: string,
  nowMs: number,
): boolean {
  if (state.phase !== 'idle') return false;
  state.phase = 'commit';
  state.from = from;
  state.to = to;
  state.rollback = rollback;
  state.lastProgressMs = nowMs;
  state.progress = -1;
  state.failure = null;
  return true;
}

/**
 * Record that the transition has actually moved forward.
 *
 * The clock is reset by *advancing*, not by being called: a loader that runs
 * every frame while sitting at the same percentage is exactly the stall this
 * needs to catch, and one that reports in without getting anywhere would
 * otherwise hold the backstop off for ever. A slow world that keeps climbing
 * still finishes, however long it takes.
 */
export function noteTransitionProgress(
  state: TransitionState,
  phase: Exclude<TransitionPhase, 'idle'>,
  nowMs: number,
  progress = 1,
): void {
  if (state.phase === 'idle') return;
  const advanced = phase !== state.phase || progress > state.progress;
  state.phase = phase;
  if (progress > state.progress) state.progress = progress;
  if (advanced) state.lastProgressMs = nowMs;
}

/** Has the transition stopped advancing for longer than the backstop allows? */
export function transitionStalled(state: TransitionState, nowMs: number): boolean {
  if (state.phase === 'idle') return false;
  const elapsed = (nowMs - state.lastProgressMs) / 1000;
  if (!Number.isFinite(elapsed)) return false;
  return elapsed > TRANSITION.stallSeconds;
}

/** Seconds since the transition last made progress. Zero while idle. */
export function transitionSilence(state: TransitionState, nowMs: number): number {
  if (state.phase === 'idle') return 0;
  return Math.max(0, (nowMs - state.lastProgressMs) / 1000);
}

/**
 * End a transition that failed, handing back the save to restore.
 *
 * The snapshot is always returned - and always cleared - so the caller cannot
 * fail to roll back and cannot roll back twice.
 */
export function failTransition(
  state: TransitionState,
  reason: TransitionFailure,
): string | null {
  const rollback = state.rollback;
  state.phase = 'idle';
  state.from = '';
  state.to = '';
  state.rollback = null;
  state.lastProgressMs = 0;
  state.progress = -1;
  state.failure = reason;
  return rollback;
}

/**
 * The destination is built and playable. The previous save is no longer needed.
 */
export function completeTransition(state: TransitionState): void {
  state.phase = 'idle';
  state.from = '';
  state.to = '';
  state.rollback = null;
  state.lastProgressMs = 0;
  state.progress = -1;
  state.failure = null;
}

/** The message a player is shown when a transition could not be finished. */
export function transitionMessage(reason: TransitionFailure, world: string): string {
  switch (reason) {
    case 'write':
      return 'Could not write the save - staying in this world. Your progress is intact.';
    case 'stalled':
      return `${world} stopped building - you are back at your last checkpoint, with nothing lost.`;
    case 'abandoned':
      return `The way to ${world} closed - you are back at your last checkpoint, with nothing lost.`;
    default:
      return `${world} could not be opened - you are back at your last checkpoint, with nothing lost.`;
  }
}

/**
 * Everything a transition must hand back before the game is playable again.
 *
 * Listed rather than implied so the cleanup cannot quietly lose an entry: the
 * game asserts against this list, and so does the test suite. Each name is a
 * piece of state that, left set, is enough on its own to leave the player
 * looking at a black or frozen screen.
 */
export const TRANSITION_CLEANUP: readonly string[] = Object.freeze([
  'transition-flag',
  'loading-state',
  'fade-overlay',
  'pause-state',
  'input-lock',
  'story-lock',
  'interact-holds',
  'hit-stop',
]);
