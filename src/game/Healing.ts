/**
 * Health recovery: passive regeneration, food, potions and resting.
 *
 * Pure state machine with no engine dependencies, so all the timing rules can
 * be unit-tested directly.
 */

import { CONSUMABLES, type ConsumableId } from '../player/inventory';
import type { ElementId } from '../elements/affinity';

/** Seconds out of combat before passive regeneration starts. */
export const REGEN_DELAY = 8;
/** Fraction of maximum health restored per second while regenerating. */
export const REGEN_RATE = 0.015;
/** Water's passive shaves this many seconds off the delay near water. */
export const WATER_REGEN_DELAY_BONUS = 3;
/** Water's passive multiplies the regeneration rate near water. */
export const WATER_REGEN_RATE_BONUS = 1.35;
/** Water's passive multiplies food and potion healing. */
export const WATER_CONSUMABLE_BONUS = 1.2;

/** Seconds a rest takes to complete. */
export const REST_DURATION = 3.2;

export interface ActiveEffect {
  id: ConsumableId;
  /** Health still to be delivered. */
  remaining: number;
  /** Seconds left in the effect. */
  timeLeft: number;
  /** Original duration, used for the HUD bar. */
  duration: number;
}

export interface HealingState {
  /** Seconds since the player last took damage. */
  sinceDamaged: number;
  /** Seconds since the player last dealt damage. */
  sinceDealt: number;
  /** Active food / potion effects. */
  effects: ActiveEffect[];
  /** Shared potion cooldown. */
  potionCooldown: number;
  /** Shared food cooldown, stops accidental spam. */
  foodCooldown: number;
  /** True while a rest is being held. */
  resting: boolean;
  restProgress: number;
  /** Set for one frame when regeneration ticked, for HUD feedback. */
  regenActive: boolean;
}

export function createHealingState(): HealingState {
  return {
    sinceDamaged: REGEN_DELAY,
    sinceDealt: REGEN_DELAY,
    effects: [],
    potionCooldown: 0,
    foodCooldown: 0,
    resting: false,
    restProgress: 0,
    regenActive: false,
  };
}

export interface CombatContext {
  /** A hostile creature is nearby and actively hunting the player. */
  hostilePressure: boolean;
  /** The player is taking continuing damage (drowning, burning, ...). */
  takingDamageOverTime: boolean;
  /** The active element, for the Water passive. */
  element: ElementId;
  /** The player is standing in or beside water. */
  nearWater: boolean;
}

/** Effective delay before regeneration begins, given the active element. */
export function regenDelayFor(ctx: CombatContext): number {
  if (ctx.element === 'water' && ctx.nearWater) {
    return Math.max(2, REGEN_DELAY - WATER_REGEN_DELAY_BONUS);
  }
  return REGEN_DELAY;
}

/** Effective regeneration rate per second as a fraction of maximum health. */
export function regenRateFor(ctx: CombatContext): number {
  if (ctx.element === 'water' && ctx.nearWater) return REGEN_RATE * WATER_REGEN_RATE_BONUS;
  return REGEN_RATE;
}

/**
 * True when the player counts as "in combat" and therefore may not regenerate.
 *
 * Combat is a combination of recent damage taken, recent damage dealt, a
 * hostile creature currently hunting the player, and any damage-over-time.
 */
export function inCombat(state: HealingState, ctx: CombatContext, delay: number): boolean {
  if (ctx.takingDamageOverTime) return true;
  if (ctx.hostilePressure) return true;
  if (state.sinceDamaged < delay) return true;
  if (state.sinceDealt < delay) return true;
  return false;
}

export interface HealingTick {
  /** Health restored this frame from passive regeneration. */
  regen: number;
  /** Health restored this frame from food and potions. */
  fromEffects: number;
  /** Effects that finished this frame. */
  finished: ConsumableId[];
}

/**
 * Advance every recovery source by dt.
 *
 * @param health current health BEFORE this tick
 * @returns the health delta split by source, already clamped so the player can
 *          never exceed maximum health.
 */
export function tickHealing(
  state: HealingState,
  dt: number,
  health: number,
  maxHealth: number,
  ctx: CombatContext,
): HealingTick {
  const result: HealingTick = { regen: 0, fromEffects: 0, finished: [] };
  const step = Math.max(0, dt);

  state.sinceDamaged += step;
  state.sinceDealt += step;
  if (state.potionCooldown > 0) state.potionCooldown = Math.max(0, state.potionCooldown - step);
  if (state.foodCooldown > 0) state.foodCooldown = Math.max(0, state.foodCooldown - step);

  let room = Math.max(0, maxHealth - health);

  // ---------------------------------------------------------- effects
  for (let i = state.effects.length - 1; i >= 0; i--) {
    const effect = state.effects[i]!;
    if (effect.timeLeft <= 0 || effect.remaining <= 0) {
      result.finished.push(effect.id);
      state.effects.splice(i, 1);
      continue;
    }
    const portion = effect.duration <= 0
      ? effect.remaining
      : Math.min(effect.remaining, (effect.remaining / Math.max(0.0001, effect.timeLeft)) * step);
    const applied = Math.min(portion, room);
    effect.remaining -= portion;
    effect.timeLeft -= step;
    result.fromEffects += applied;
    room -= applied;
    if (effect.timeLeft <= 0 || effect.remaining <= 0.001) {
      result.finished.push(effect.id);
      state.effects.splice(i, 1);
    }
  }

  // ------------------------------------------------------ regeneration
  const delay = regenDelayFor(ctx);
  state.regenActive = false;
  if (!inCombat(state, ctx, delay) && room > 0) {
    state.regenActive = true;
    const amount = Math.min(room, maxHealth * regenRateFor(ctx) * step);
    result.regen = amount;
    room -= amount;
  }

  return result;
}

/** Record that the player took damage: stops regeneration and blunts food. */
export function notifyDamaged(state: HealingState): void {
  state.sinceDamaged = 0;
  state.regenActive = false;
  state.resting = false;
  state.restProgress = 0;
  // Being hit interrupts most of a food effect, but potions are quick enough
  // to survive it.
  for (let i = state.effects.length - 1; i >= 0; i--) {
    const effect = state.effects[i]!;
    const def = CONSUMABLES[effect.id];
    if (def.interruptRetention >= 1) continue;
    effect.remaining *= def.interruptRetention;
    if (effect.remaining <= 0.5) state.effects.splice(i, 1);
  }
}

/** Record that the player dealt damage, which also counts as combat. */
export function notifyDealtDamage(state: HealingState): void {
  state.sinceDealt = 0;
}

export type ConsumeResult =
  | { ok: true; id: ConsumableId; heal: number }
  | { ok: false; reason: 'cooldown' | 'full' | 'none' | 'duplicate' };

/**
 * Begin a food or potion effect.
 *
 * @param takeItem removes one from the satchel; only called once every other
 *                 check has passed, so a failed use never costs an item.
 */
export function consume(
  state: HealingState,
  id: ConsumableId,
  health: number,
  maxHealth: number,
  ctx: CombatContext,
  takeItem: (id: ConsumableId) => boolean,
): ConsumeResult {
  const def = CONSUMABLES[id];
  if (!def) return { ok: false, reason: 'none' };
  if (health >= maxHealth - 0.01) return { ok: false, reason: 'full' };
  // Report the most specific reason first: already-working beats cooling-down.
  if (state.effects.some((e) => e.id === id)) return { ok: false, reason: 'duplicate' };
  const cooldown = def.kind === 'potion' ? state.potionCooldown : state.foodCooldown;
  if (cooldown > 0) return { ok: false, reason: 'cooldown' };
  if (!takeItem(id)) return { ok: false, reason: 'none' };

  const bonus = ctx.element === 'water' ? WATER_CONSUMABLE_BONUS : 1;
  const heal = def.heal * bonus;
  state.effects.push({
    id,
    remaining: heal,
    timeLeft: Math.max(0.05, def.duration),
    duration: Math.max(0.05, def.duration),
  });
  if (def.kind === 'potion') state.potionCooldown = def.cooldown;
  else state.foodCooldown = def.cooldown;
  return { ok: true, id, heal };
}

export interface RestContext {
  /** The player is standing at a campfire or cleansed shrine. */
  atRestSite: boolean;
  /** A hostile creature is close enough to make resting unsafe. */
  hostileNearby: boolean;
  peaceful: boolean;
}

export type RestCheck = { ok: true } | { ok: false; reason: 'no-site' | 'hostiles' };

/**
 * Resting is always available in Peaceful Mode at a valid site; in Normal Mode
 * a hostile creature nearby prevents it.
 */
export function canRest(ctx: RestContext): RestCheck {
  if (!ctx.atRestSite) return { ok: false, reason: 'no-site' };
  if (!ctx.peaceful && ctx.hostileNearby) return { ok: false, reason: 'hostiles' };
  return { ok: true };
}

/**
 * Advance a rest hold. Returns true on the frame the rest completes.
 */
export function tickRest(state: HealingState, dt: number, holding: boolean, ctx: RestContext): boolean {
  const allowed = canRest(ctx).ok;
  if (!holding || !allowed) {
    state.resting = false;
    state.restProgress = 0;
    return false;
  }
  state.resting = true;
  state.restProgress += Math.max(0, dt);
  if (state.restProgress >= REST_DURATION) {
    state.resting = false;
    state.restProgress = 0;
    return true;
  }
  return false;
}

/** Clear every effect, used when the player dies or a rest completes. */
export function clearEffects(state: HealingState): void {
  state.effects.length = 0;
  state.resting = false;
  state.restProgress = 0;
}
