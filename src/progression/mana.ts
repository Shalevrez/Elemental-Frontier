/**
 * Mana (aether) economy.
 *
 * The goal is that a player is never reduced to running in circles waiting for
 * a bar. So:
 *   - regeneration continues during combat, just more slowly,
 *   - out-of-combat regeneration is much faster after a short lull,
 *   - an expensive cast briefly pauses regeneration instead of gating it,
 *   - the primary attack has a low-cost fallback that always works, so there is
 *     always *something* to do,
 *   - pickups, refunds and element-terrain bonuses top the bar up in play.
 *
 * Pure state, so all of the rates are testable.
 */

import type { ElementId } from '../elements/affinity';

/** Regeneration multiplier while something hostile is nearby. */
export const IN_COMBAT_REGEN_SCALE = 0.55;
/** Regeneration multiplier once the fight has been over for a moment. */
export const OUT_OF_COMBAT_REGEN_SCALE = 2.1;
/** Seconds without combat before the faster regeneration kicks in. */
export const OUT_OF_COMBAT_DELAY = 3.5;
/** A cast costing at least this fraction of the pool pauses regeneration. */
export const EXPENSIVE_FRACTION = 0.28;
/** How long regeneration pauses after an expensive cast. */
export const CAST_PAUSE = 1.1;
/** Below this fraction the HUD shows the low-mana warning. */
export const LOW_MANA_FRACTION = 0.22;
/** Fraction of maximum mana the free fallback attack needs. */
export const FALLBACK_COST_FRACTION = 0.04;

/** Terrain affinity bonus: extra regeneration per second when it applies. */
export const TERRAIN_BONUS_REGEN = 3.2;

export interface ManaState {
  /** Seconds left of the post-cast regeneration pause. */
  castPause: number;
  /** Seconds since the last combat event. */
  sinceCombat: number;
  /** Seconds of "free cast" left, from the temporary-free-cast upgrade. */
  freeCast: number;
  /** Overflow banked from excess pickups, spent as a small temporary boost. */
  overflow: number;
  overflowTimer: number;
}

export function createManaState(): ManaState {
  return { castPause: 0, sinceCombat: 99, freeCast: 0, overflow: 0, overflowTimer: 0 };
}

export interface ManaContext {
  maxMana: number;
  /** Base regeneration per second from stats and upgrades. */
  baseRegen: number;
  /** True while creatures are actively engaging the player. */
  inCombat: boolean;
  /** The element currently held. */
  element: ElementId;
  /** True when the player is standing on / near the element's terrain. */
  onAffinityTerrain: boolean;
}

export interface ManaTick {
  /** Mana to add this frame. */
  regen: number;
  /** True while regeneration is paused by a recent expensive cast. */
  paused: boolean;
  /** True once the faster out-of-combat regeneration is running. */
  resting: boolean;
  /** Extra regeneration coming from the element's terrain affinity. */
  terrainBonus: number;
}

export function tickMana(state: ManaState, dt: number, ctx: ManaContext): ManaTick {
  if (state.castPause > 0) state.castPause = Math.max(0, state.castPause - dt);
  if (state.freeCast > 0) state.freeCast = Math.max(0, state.freeCast - dt);
  if (state.overflowTimer > 0) {
    state.overflowTimer = Math.max(0, state.overflowTimer - dt);
    if (state.overflowTimer === 0) state.overflow = 0;
  }
  state.sinceCombat = ctx.inCombat ? 0 : state.sinceCombat + dt;

  const resting = state.sinceCombat >= OUT_OF_COMBAT_DELAY;
  const paused = state.castPause > 0;
  const scale = paused ? 0 : resting ? OUT_OF_COMBAT_REGEN_SCALE : IN_COMBAT_REGEN_SCALE;
  const terrainBonus = ctx.onAffinityTerrain && !paused ? TERRAIN_BONUS_REGEN : 0;

  return {
    regen: (ctx.baseRegen * scale + terrainBonus) * dt,
    paused,
    resting,
    terrainBonus,
  };
}

/** Record a cast so regeneration knows whether to pause. */
export function notifyCast(state: ManaState, cost: number, maxMana: number): void {
  if (maxMana <= 0) return;
  if (cost / maxMana >= EXPENSIVE_FRACTION) state.castPause = CAST_PAUSE;
}

export function notifyCombat(state: ManaState): void {
  state.sinceCombat = 0;
}

/** Grant a window during which abilities cost nothing. */
export function grantFreeCast(state: ManaState, seconds: number): void {
  state.freeCast = Math.max(state.freeCast, seconds);
}

export function isFreeCast(state: ManaState): boolean {
  return state.freeCast > 0;
}

/**
 * Absorb a Mana pickup.
 *
 * Anything that would be wasted becomes a small, brief regeneration bonus
 * instead of vanishing.
 */
export function absorbPickup(
  state: ManaState,
  amount: number,
  current: number,
  maxMana: number,
): { mana: number; overflow: number } {
  const room = Math.max(0, maxMana - current);
  const mana = Math.min(room, amount);
  const overflow = amount - mana;
  if (overflow > 0) {
    state.overflow = Math.min(maxMana * 0.25, state.overflow + overflow);
    state.overflowTimer = 8;
  }
  return { mana, overflow };
}

/** Which state the mana bar should be showing. */
export type ManaFeedback = 'normal' | 'low' | 'empty' | 'paused' | 'resting' | 'free';

export function manaFeedback(current: number, maxMana: number, tick: ManaTick, state: ManaState): ManaFeedback {
  if (state.freeCast > 0) return 'free';
  if (current <= 0.01) return 'empty';
  if (tick.paused) return 'paused';
  if (maxMana > 0 && current / maxMana < LOW_MANA_FRACTION) return 'low';
  if (tick.resting) return 'resting';
  return 'normal';
}

/**
 * The always-available fallback for a primary attack.
 *
 * When the player cannot afford the real cost, the primary still fires at
 * reduced power for a token amount of Mana, which is what stops a fight from
 * degenerating into running away.
 */
export interface FallbackResolution {
  /** Mana actually charged. */
  cost: number;
  /** Damage multiplier for the weakened cast. */
  power: number;
  /** True when the fallback was used rather than the full-strength cast. */
  weakened: boolean;
}

export const FALLBACK_POWER = 0.45;

export function resolvePrimaryCost(
  fullCost: number,
  current: number,
  maxMana: number,
  freeCast: boolean,
): FallbackResolution | null {
  if (freeCast) return { cost: 0, power: 1, weakened: false };
  if (current >= fullCost) return { cost: fullCost, power: 1, weakened: false };
  const fallback = maxMana * FALLBACK_COST_FRACTION;
  if (current >= fallback) return { cost: fallback, power: FALLBACK_POWER, weakened: true };
  return null;
}

/** Is the player standing somewhere their element draws strength from? */
export interface TerrainAffinityProbe {
  nearWater: boolean;
  onStone: boolean;
  nearFire: boolean;
  airborneOrFast: boolean;
}

export function onAffinityTerrain(element: ElementId, probe: TerrainAffinityProbe): boolean {
  switch (element) {
    case 'water': return probe.nearWater;
    case 'earth': return probe.onStone;
    case 'fire': return probe.nearFire;
    default: return probe.airborneOrFast;
  }
}
