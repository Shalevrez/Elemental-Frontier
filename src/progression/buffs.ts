/**
 * Timed buffs and penalties.
 *
 * Chests, shrines and world events can hand out effects that last for a while
 * rather than forever. They contribute stat modifiers and behaviour grants
 * exactly like permanent upgrades do, so the rest of the game never has to
 * care which kind it is looking at.
 *
 * Pure - the HUD reads `list()` and the combat code reads `modifiers`.
 */

import {
  BASE_MODIFIERS, accumulateStats, clampStats,
  type StatModifiers, type UpgradeDef,
} from './upgrades';

export interface BuffDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Accent colour used by the HUD chip. */
  readonly color: number;
  readonly seconds: number;
  readonly stats?: Partial<StatModifiers>;
  readonly grants?: readonly string[];
  /** True when this is a downside rather than a benefit. */
  readonly penalty?: boolean;
}

export interface ActiveBuff {
  def: BuffDef;
  timeLeft: number;
  duration: number;
}

export interface SerialisedBuff {
  id: string;
  timeLeft: number;
}

export class BuffTracker {
  private readonly active: ActiveBuff[] = [];
  private stats: StatModifiers = { ...BASE_MODIFIERS };
  private grants = new Map<string, number>();
  private dirty = true;

  constructor(private readonly registry: Readonly<Record<string, BuffDef>>) {}

  get modifiers(): Readonly<StatModifiers> {
    this.recompute();
    return this.stats;
  }

  grant(tag: string): number {
    this.recompute();
    return this.grants.get(tag) ?? 0;
  }

  hasGrant(tag: string): boolean {
    return this.grant(tag) > 0;
  }

  list(): readonly ActiveBuff[] {
    return this.active;
  }

  has(id: string): boolean {
    return this.active.some((b) => b.def.id === id);
  }

  /** Apply a buff, refreshing rather than stacking a duplicate. */
  apply(def: BuffDef, secondsOverride?: number): ActiveBuff {
    const seconds = secondsOverride ?? def.seconds;
    const existing = this.active.find((b) => b.def.id === def.id);
    if (existing) {
      existing.timeLeft = Math.max(existing.timeLeft, seconds);
      existing.duration = Math.max(existing.duration, seconds);
      this.dirty = true;
      return existing;
    }
    const entry: ActiveBuff = { def, timeLeft: seconds, duration: seconds };
    this.active.push(entry);
    this.dirty = true;
    return entry;
  }

  /** Advance every timer. Returns the buffs that expired this frame. */
  tick(dt: number): BuffDef[] {
    if (this.active.length === 0) return EMPTY;
    const expired: BuffDef[] = [];
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i]!;
      entry.timeLeft -= dt;
      if (entry.timeLeft <= 0) {
        this.active.splice(i, 1);
        expired.push(entry.def);
        this.dirty = true;
      }
    }
    return expired;
  }

  clear(): void {
    this.active.length = 0;
    this.dirty = true;
  }

  toJSON(): SerialisedBuff[] {
    return this.active.map((b) => ({ id: b.def.id, timeLeft: Math.round(b.timeLeft * 10) / 10 }));
  }

  load(data: unknown): void {
    this.clear();
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const id = (raw as { id?: unknown }).id;
      const timeLeft = (raw as { timeLeft?: unknown }).timeLeft;
      if (typeof id !== 'string') continue;
      const def = this.registry[id];
      if (!def) continue;
      const seconds = typeof timeLeft === 'number' && Number.isFinite(timeLeft)
        ? Math.min(def.seconds, Math.max(0, timeLeft))
        : def.seconds;
      if (seconds > 0.05) this.apply(def, seconds);
    }
  }

  private recompute(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const stats: StatModifiers = { ...BASE_MODIFIERS };
    this.grants.clear();
    for (const entry of this.active) {
      accumulateStats(stats, buffAsUpgrade(entry.def), 1);
      for (const tag of entry.def.grants ?? []) {
        this.grants.set(tag, (this.grants.get(tag) ?? 0) + 1);
      }
    }
    this.stats = clampStats(stats);
  }
}

const EMPTY: BuffDef[] = [];

/** Adapter so buffs can reuse the upgrade stat accumulator. */
function buffAsUpgrade(def: BuffDef): UpgradeDef {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    rarity: 'common',
    element: 'any',
    tags: [],
    maxStacks: 1,
    stats: def.stats,
  };
}

/**
 * Combine two independently-clamped modifier sets.
 *
 * Multiplicative fields multiply, additive fields add, and the result is
 * clamped once more so the combination cannot escape the safe ranges.
 */
export function combineModifiers(a: Readonly<StatModifiers>, b: Readonly<StatModifiers>): StatModifiers {
  const out: StatModifiers = { ...BASE_MODIFIERS };
  for (const key of Object.keys(BASE_MODIFIERS) as (keyof StatModifiers)[]) {
    const base = BASE_MODIFIERS[key];
    if (base === 1) out[key] = a[key] * b[key];
    else out[key] = a[key] + b[key];
  }
  // critScale's neutral value is 1.8, not 0 or 1: recombine it explicitly.
  out.critScale = BASE_MODIFIERS.critScale
    + (a.critScale - BASE_MODIFIERS.critScale)
    + (b.critScale - BASE_MODIFIERS.critScale);
  return clampStats(out);
}
