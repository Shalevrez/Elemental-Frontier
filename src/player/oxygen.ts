/**
 * Swimming and oxygen.
 *
 * The player can no longer sit underwater forever. Oxygen drains while the
 * head is submerged, refills quickly at the surface or inside an air pocket,
 * and once it is gone the player takes periodic drowning damage rather than
 * dying outright - always with enough time to reach air.
 *
 * Pure state machine so drain rates, recovery and drowning cadence are all
 * directly testable.
 */

import type { ElementId } from '../elements/affinity';

/** Seconds of oxygen at full lungs, before upgrades. */
export const BASE_OXYGEN = 22;
/** Seconds between drowning ticks once oxygen is gone. */
export const DROWN_INTERVAL = 1.4;
/** Fraction of maximum health each drowning tick costs. */
export const DROWN_FRACTION = 0.055;
/** Minimum drowning damage, so it still bites on a small health pool. */
export const DROWN_MINIMUM = 4;
/** Oxygen restored per second while breathing. */
export const REFILL_RATE = 7;
/** Water adepts hold their breath longer - but never indefinitely. */
export const WATER_DRAIN_SCALE = 0.6;
export const WATER_SWIM_SCALE = 1.3;
export const WATER_VISION_SCALE = 1.55;

export interface OxygenState {
  /** Seconds of air left. */
  oxygen: number;
  /** Seconds of air at full lungs, including upgrades. */
  maxOxygen: number;
  /** True while the head is under a fluid surface. */
  submerged: boolean;
  /** Accumulator between drowning ticks. */
  drownTimer: number;
  /** Seconds since the last breath, used for audio and screen effects. */
  sinceBreath: number;
  /** Set for one tick when drowning damage lands. */
  drowningTick: boolean;
}

export function createOxygenState(maxOxygen = BASE_OXYGEN): OxygenState {
  return {
    oxygen: maxOxygen,
    maxOxygen,
    submerged: false,
    drownTimer: 0,
    sinceBreath: 0,
    drowningTick: false,
  };
}

export interface OxygenContext {
  /** Head is under water / lava. */
  headSubmerged: boolean;
  /** Standing in an air pocket counts as breathing even while submerged. */
  inAirPocket: boolean;
  /** The element currently held. */
  element: ElementId;
  /** Extra seconds of lung capacity from upgrades. */
  bonusCapacity: number;
  /** Multiplier on the drain rate from upgrades (lower is better). */
  drainScale: number;
  maxHealth: number;
}

export interface OxygenTick {
  /** Damage to apply this frame, 0 when not drowning. */
  damage: number;
  /** True on the frame the player runs out of air. */
  justEmptied: boolean;
  /** True on the frame the player surfaces. */
  justSurfaced: boolean;
  /** 0..1 fraction remaining, for the HUD. */
  fraction: number;
}

/**
 * Advance the oxygen state.
 *
 * Water affinity slows the drain and nothing else: no element gets unlimited
 * oxygen, so a flooded world is a real constraint for everybody.
 */
export function tickOxygen(state: OxygenState, dt: number, ctx: OxygenContext): OxygenTick {
  const max = Math.max(4, BASE_OXYGEN + ctx.bonusCapacity);
  if (state.maxOxygen !== max) {
    const ratio = state.maxOxygen > 0 ? state.oxygen / state.maxOxygen : 1;
    state.maxOxygen = max;
    state.oxygen = Math.min(max, ratio * max);
  }

  const wasSubmerged = state.submerged;
  const breathing = !ctx.headSubmerged || ctx.inAirPocket;
  state.submerged = ctx.headSubmerged && !ctx.inAirPocket;
  state.drowningTick = false;

  let damage = 0;
  let justEmptied = false;

  if (breathing) {
    state.oxygen = Math.min(state.maxOxygen, state.oxygen + REFILL_RATE * dt);
    state.drownTimer = 0;
    state.sinceBreath = 0;
  } else {
    const drain = dt * (ctx.element === 'water' ? WATER_DRAIN_SCALE : 1) * Math.max(0.25, ctx.drainScale);
    const before = state.oxygen;
    state.oxygen = Math.max(0, state.oxygen - drain);
    state.sinceBreath += dt;
    if (before > 0 && state.oxygen <= 0) justEmptied = true;

    if (state.oxygen <= 0) {
      // Clamp the accumulator: a single very long frame (a stall, or a save
      // being replayed) must not bank up several drowning ticks at once.
      state.drownTimer = Math.min(DROWN_INTERVAL, state.drownTimer + dt);
      if (state.drownTimer >= DROWN_INTERVAL) {
        state.drownTimer = 0;
        damage = Math.max(DROWN_MINIMUM, ctx.maxHealth * DROWN_FRACTION);
        state.drowningTick = true;
      }
    }
  }

  return {
    damage,
    justEmptied,
    justSurfaced: wasSubmerged && !state.submerged,
    fraction: state.maxOxygen > 0 ? state.oxygen / state.maxOxygen : 1,
  };
}

/** Swim speed multiplier for the held element. */
export function swimSpeedScale(element: ElementId): number {
  return element === 'water' ? WATER_SWIM_SCALE : 1;
}

/** Underwater view distance multiplier for the held element. */
export function underwaterVisionScale(element: ElementId): number {
  return element === 'water' ? WATER_VISION_SCALE : 1;
}

/**
 * Sanitise a loaded oxygen value.
 *
 * A save is never allowed to drop the player straight back into a drowning
 * death: loading always grants at least a few seconds of air.
 */
export function sanitiseOxygen(value: unknown, maxOxygen = BASE_OXYGEN): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : maxOxygen;
  return Math.min(maxOxygen, Math.max(maxOxygen * 0.35, n));
}
