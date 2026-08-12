/**
 * The player's current run build: which upgrades are owned, the aggregated
 * stat modifiers, and the behaviour tags gameplay code queries.
 *
 * Pure - no engine imports - so stacking, incompatibility and synergy rules
 * are all directly testable.
 */

import type { ElementId } from '../elements/affinity';
import {
  BASE_MODIFIERS, UPGRADES, accumulateStats, cappedStats, clampStats, upgradeById,
  type StatModifiers, type UpgradeDef, type UpgradeHook,
} from './upgrades';

export interface SynergyMatch {
  tag: string;
  members: string[];
}

export class BuildState {
  /** upgrade id -> stacks owned. */
  private owned = new Map<string, number>();
  private stats: StatModifiers = { ...BASE_MODIFIERS };
  /** The same totals before clamping, so a ceiling in force can be shown. */
  private raw: StatModifiers = { ...BASE_MODIFIERS };
  /** behaviour tag -> total stacks granting it. */
  private grants = new Map<string, number>();
  /** hook -> upgrade defs that declare it. */
  private hookIndex = new Map<UpgradeHook, UpgradeDef[]>();
  private dirty = true;

  constructor(owned?: Record<string, number>) {
    if (owned) this.load(owned);
  }

  load(data: unknown): void {
    this.owned.clear();
    if (data && typeof data === 'object') {
      for (const [id, raw] of Object.entries(data as Record<string, unknown>)) {
        const def = upgradeById(id);
        if (!def) continue;
        const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
        if (n > 0) this.owned.set(id, Math.min(def.maxStacks, n));
      }
    }
    this.dirty = true;
    this.recompute();
  }

  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.owned) if (n > 0) out[id] = n;
    return out;
  }

  clear(): void {
    this.owned.clear();
    this.dirty = true;
    this.recompute();
  }

  // ------------------------------------------------------------ queries

  stacksOf(id: string): number {
    return this.owned.get(id) ?? 0;
  }

  has(id: string): boolean {
    return this.stacksOf(id) > 0;
  }

  /** Total stacks across every owned upgrade that grants this behaviour. */
  grant(tag: string): number {
    return this.grants.get(tag) ?? 0;
  }

  hasGrant(tag: string): boolean {
    return this.grant(tag) > 0;
  }

  get modifiers(): Readonly<StatModifiers> {
    return this.stats;
  }

  /** Totals before clamping. Only the pause screen needs these. */
  get rawModifiers(): Readonly<StatModifiers> {
    return this.raw;
  }

  /**
   * Multipliers currently pinned at their ceiling.
   *
   * A build that has stacked past a cap is told so, rather than quietly
   * receiving less than its cards promised.
   */
  caps(): { label: string; value: string }[] {
    return cappedStats(this.raw);
  }

  get size(): number {
    let n = 0;
    for (const v of this.owned.values()) n += v;
    return n;
  }

  /** Every owned upgrade, most recently interesting first. */
  list(): { def: UpgradeDef; stacks: number }[] {
    const out: { def: UpgradeDef; stacks: number }[] = [];
    for (const [id, stacks] of this.owned) {
      const def = upgradeById(id);
      if (def) out.push({ def, stacks });
    }
    out.sort((a, b) => {
      const order = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
      return order.indexOf(a.def.rarity) - order.indexOf(b.def.rarity);
    });
    return out;
  }

  /** Defs declaring a hook, so callers can iterate without scanning the pool. */
  hooked(hook: UpgradeHook): readonly UpgradeDef[] {
    return this.hookIndex.get(hook) ?? EMPTY_DEFS;
  }

  /** Which build paths this run is leaning into, strongest first. */
  buildPaths(): { tag: string; weight: number }[] {
    const counts = new Map<string, number>();
    for (const [id, stacks] of this.owned) {
      const def = upgradeById(id);
      if (!def) continue;
      for (const tag of def.tags) counts.set(tag, (counts.get(tag) ?? 0) + stacks);
    }
    return [...counts.entries()]
      .map(([tag, weight]) => ({ tag, weight }))
      .sort((a, b) => b.weight - a.weight);
  }

  /** Synergy labels shared by two or more owned upgrades. */
  synergies(): SynergyMatch[] {
    const groups = new Map<string, string[]>();
    for (const id of this.owned.keys()) {
      const def = upgradeById(id);
      if (!def?.synergy) continue;
      for (const tag of def.synergy) {
        const list = groups.get(tag) ?? [];
        list.push(def.name);
        groups.set(tag, list);
      }
    }
    const out: SynergyMatch[] = [];
    for (const [tag, members] of groups) {
      if (members.length >= 2) out.push({ tag, members });
    }
    out.sort((a, b) => b.members.length - a.members.length);
    return out;
  }

  // --------------------------------------------------------- offer rules

  /**
   * Can this upgrade be offered right now?
   *
   * Checks stacking room, element compatibility, prerequisites, mutual
   * exclusions and meta unlocks.
   */
  canOffer(def: UpgradeDef, elements: readonly ElementId[], unlocked: ReadonlySet<string>): boolean {
    if (this.stacksOf(def.id) >= def.maxStacks) return false;
    if (def.element !== 'any' && !elements.includes(def.element)) return false;
    if (def.unlock && !unlocked.has(def.unlock)) return false;
    for (const req of def.requires ?? []) {
      if (!this.has(req)) return false;
    }
    for (const bad of def.incompatible ?? []) {
      if (this.has(bad)) return false;
    }
    // Exclusions are symmetric: an owned upgrade may forbid this one too.
    for (const ownedId of this.owned.keys()) {
      const ownedDef = upgradeById(ownedId);
      if (ownedDef?.incompatible?.includes(def.id)) return false;
    }
    return true;
  }

  /** Add one stack. Returns false when it was not legal to take. */
  add(id: string): boolean {
    const def = upgradeById(id);
    if (!def) return false;
    const current = this.stacksOf(id);
    if (current >= def.maxStacks) return false;
    this.owned.set(id, current + 1);
    this.dirty = true;
    this.recompute();
    return true;
  }

  // -------------------------------------------------------------- internal

  private recompute(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const stats: StatModifiers = { ...BASE_MODIFIERS };
    this.grants.clear();
    this.hookIndex.clear();

    for (const [id, stacks] of this.owned) {
      const def = upgradeById(id);
      if (!def) continue;
      accumulateStats(stats, def, stacks);
      for (const tag of def.grants ?? []) {
        this.grants.set(tag, (this.grants.get(tag) ?? 0) + stacks);
      }
      for (const hook of def.hooks ?? []) {
        const list = this.hookIndex.get(hook) ?? [];
        list.push(def);
        this.hookIndex.set(hook, list);
      }
    }

    this.raw = { ...stats };
    this.stats = clampStats(stats);
  }
}

const EMPTY_DEFS: readonly UpgradeDef[] = Object.freeze([]);

/** Total number of registered upgrades, handy for the meta screen. */
export const TOTAL_UPGRADES = UPGRADES.length;
