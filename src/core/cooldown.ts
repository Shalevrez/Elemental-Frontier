/**
 * Cooldown bookkeeping. Pure timing maths, no engine dependencies.
 */

export interface CooldownState {
  /** Seconds remaining. */
  remaining: number;
  /** Full duration of the cooldown currently running. */
  duration: number;
}

export function createCooldown(): CooldownState {
  return { remaining: 0, duration: 0 };
}

/** Effective cooldown length after upgrade scaling. Never below 0.05s. */
export function effectiveCooldown(base: number, scale: number): number {
  const b = Number.isFinite(base) ? Math.max(0, base) : 0;
  const s = Number.isFinite(scale) ? Math.max(0.1, scale) : 1;
  return Math.max(0.05, b * s);
}

/** Advance a cooldown by dt seconds. */
export function tickCooldown(state: CooldownState, dt: number): void {
  if (state.remaining > 0) {
    state.remaining = Math.max(0, state.remaining - Math.max(0, dt));
    if (state.remaining === 0) state.duration = 0;
  }
}

export function isReady(state: CooldownState): boolean {
  return state.remaining <= 0;
}

/** Start a cooldown of `duration` seconds. */
export function startCooldown(state: CooldownState, duration: number): void {
  const d = Math.max(0, Number.isFinite(duration) ? duration : 0);
  state.remaining = d;
  state.duration = d;
}

/** 0 when ready, 1 when just triggered. Used to drive the HUD sweep. */
export function cooldownFraction(state: CooldownState): number {
  if (state.duration <= 0) return 0;
  const f = state.remaining / state.duration;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
