/**
 * Shrine placement, objective progress, the peaceful ritual and the blessing
 * table. Pure and testable.
 */

import type { ElementId } from '../elements/affinity';
import { SHRINE_RADIUS, WORLD_CENTER } from './coords';

export interface ShrineSite {
  readonly index: number;
  readonly element: ElementId;
  readonly x: number;
  readonly z: number;
  readonly bearing: string;
}

/**
 * Four shrines at the compass points, far enough apart that reaching each one
 * is a journey. Their positions are seed-independent; the terrain around them
 * is not.
 */
export const SHRINE_SITES: readonly ShrineSite[] = Object.freeze([
  Object.freeze({ index: 0, element: 'air' as ElementId, x: WORLD_CENTER, z: WORLD_CENTER - SHRINE_RADIUS, bearing: 'north' }),
  Object.freeze({ index: 1, element: 'water' as ElementId, x: WORLD_CENTER + SHRINE_RADIUS, z: WORLD_CENTER, bearing: 'east' }),
  Object.freeze({ index: 2, element: 'earth' as ElementId, x: WORLD_CENTER, z: WORLD_CENTER + SHRINE_RADIUS, bearing: 'south' }),
  Object.freeze({ index: 3, element: 'fire' as ElementId, x: WORLD_CENTER - SHRINE_RADIUS, z: WORLD_CENTER, bearing: 'west' }),
]);

export const SHRINE_COUNT = SHRINE_SITES.length;

/** Radius over which terrain is levelled into the shrine plateau. */
export const SHRINE_FIELD_RADIUS = 28;
/** Radius of the blight scoured away on cleansing. */
export const SHRINE_CLEANSE_RADIUS = 24;
/** Distance at which a guardian wakes (Normal Mode). */
export const GUARDIAN_WAKE_RADIUS = 34;
/** Distance at which the player may interact with the shrine core. */
export const SHRINE_INTERACT_RADIUS = 7;
/** Distance at which a ritual mote can be gathered (Peaceful Mode). */
export const MOTE_INTERACT_RADIUS = 3.2;
/** How many motes a peaceful ritual requires. */
export const MOTES_PER_SHRINE = 3;

/**
 * Where the three ritual motes sit relative to a shrine. Fixed offsets keep
 * them findable without a quest marker, while still requiring a short walk in
 * three different directions.
 */
export const MOTE_OFFSETS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([26, -14] as const),
  Object.freeze([-24, -18] as const),
  Object.freeze([2, 30] as const),
]);

export type WorldMode = 'normal' | 'peaceful';

export function isWorldMode(value: unknown): value is WorldMode {
  return value === 'normal' || value === 'peaceful';
}

/** Normalise arbitrary stored data into a 4-entry boolean array. */
export function normaliseShrineFlags(value: unknown): boolean[] {
  const out = [false, false, false, false];
  if (Array.isArray(value)) {
    for (let i = 0; i < SHRINE_COUNT; i++) out[i] = value[i] === true;
  }
  return out;
}

/** Normalise stored mote state into a 4 x 3 boolean grid. */
export function normaliseMotes(value: unknown): boolean[][] {
  const out: boolean[][] = [];
  for (let i = 0; i < SHRINE_COUNT; i++) {
    const row: boolean[] = [];
    const src = Array.isArray(value) && Array.isArray(value[i]) ? (value[i] as unknown[]) : [];
    for (let m = 0; m < MOTES_PER_SHRINE; m++) row.push(src[m] === true);
    out.push(row);
  }
  return out;
}

export function motesGathered(motes: readonly boolean[]): number {
  let n = 0;
  for (const m of motes) if (m) n++;
  return n;
}

export function ritualComplete(motes: readonly boolean[]): boolean {
  return motesGathered(motes) >= MOTES_PER_SHRINE;
}

export function shrineProgress(flags: readonly boolean[]): number {
  let n = 0;
  for (let i = 0; i < SHRINE_COUNT; i++) if (flags[i]) n++;
  return n;
}

export function allShrinesCleansed(flags: readonly boolean[]): boolean {
  return shrineProgress(flags) >= SHRINE_COUNT;
}

export function pendingShrines(flags: readonly boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < SHRINE_COUNT; i++) if (!flags[i]) out.push(i);
  return out;
}

/**
 * Can the player begin the cleansing hold?
 *
 * Normal Mode gates on the guardian; Peaceful Mode gates on the three motes.
 * Neither gate ever depends on the player's element, so every affinity can
 * finish every shrine in either mode.
 */
export function canCleanse(
  mode: WorldMode,
  guardianDefeated: boolean,
  motes: readonly boolean[],
): boolean {
  return mode === 'peaceful' ? ritualComplete(motes) : guardianDefeated;
}

export interface UpgradeDef {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly maxHealth: number;
  readonly maxEnergy: number;
  readonly energyRegen: number;
  readonly cooldownScale: number;
  readonly moveScale: number;
  readonly powerScale: number;
}

/**
 * Blessings are granted in cleansing order, so the reward is identical no
 * matter which shrine is tackled first or which mode the world is in. No
 * blessing ever grants another element.
 */
export const SHRINE_UPGRADES: readonly UpgradeDef[] = Object.freeze([
  Object.freeze({
    id: 'vitality',
    title: 'Blessing of Vitality',
    lines: ['+30 maximum health', 'Fully restored', 'Elemental power +8%'],
    maxHealth: 30, maxEnergy: 0, energyRegen: 0, cooldownScale: 1, moveScale: 1, powerScale: 1.08,
  }),
  Object.freeze({
    id: 'wellspring',
    title: 'Blessing of the Wellspring',
    lines: ['+35 maximum aether', '+2.5 aether regeneration', 'Elemental power +8%'],
    maxHealth: 0, maxEnergy: 35, energyRegen: 2.5, cooldownScale: 1, moveScale: 1, powerScale: 1.08,
  }),
  Object.freeze({
    id: 'quickening',
    title: 'Blessing of Quickening',
    lines: ['All cooldowns -20%', '+10 maximum health', 'Elemental power +8%'],
    maxHealth: 10, maxEnergy: 0, energyRegen: 0, cooldownScale: 0.8, moveScale: 1, powerScale: 1.08,
  }),
  Object.freeze({
    id: 'striding',
    title: 'Blessing of Striding',
    lines: ['+14% movement speed', '+15 maximum aether', 'Elemental power +10%'],
    maxHealth: 0, maxEnergy: 15, energyRegen: 0.5, cooldownScale: 1, moveScale: 1.14, powerScale: 1.1,
  }),
]);

export interface UpgradeTotals {
  maxHealth: number;
  maxEnergy: number;
  energyRegen: number;
  cooldownScale: number;
  moveScale: number;
  powerScale: number;
}

export const BASE_STATS: Readonly<UpgradeTotals> = Object.freeze({
  maxHealth: 100,
  maxEnergy: 100,
  energyRegen: 7,
  cooldownScale: 1,
  moveScale: 1,
  powerScale: 1,
});

export function accumulateUpgrades(count: number, convergence: boolean): UpgradeTotals {
  const n = Math.max(0, Math.min(SHRINE_UPGRADES.length, Math.floor(count) || 0));
  const totals: UpgradeTotals = { ...BASE_STATS };
  for (let i = 0; i < n; i++) {
    const up = SHRINE_UPGRADES[i]!;
    totals.maxHealth += up.maxHealth;
    totals.maxEnergy += up.maxEnergy;
    totals.energyRegen += up.energyRegen;
    totals.cooldownScale *= up.cooldownScale;
    totals.moveScale *= up.moveScale;
    totals.powerScale *= convergence ? 1 + (up.powerScale - 1) * 0.6 : up.powerScale;
  }
  return totals;
}
