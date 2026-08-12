/**
 * The run controller: build, depth, encounters, scenarios and meta banking.
 *
 * Sits between the save file and the game loop. Pure enough to test: the only
 * thing it needs from outside is a random source.
 */

import type { ElementId, AffinityId } from '../elements/affinity';
import { elementsFor, isConvergence } from '../elements/affinity';
import { BuildState } from './BuildState';
import { rollRewards, type RewardContext, type RewardOffer } from './rewards';
import {
  bankRun, createMeta, sanitiseMeta, unlockedSet, type MetaState, type RunSummary,
} from './meta';
import {
  beginScenario, createScenario, pickScenario, tickScenario,
  type ScenarioKind, type ScenarioState,
} from '../game/scenarios';
import { worldDef, type WorldDef, type WorldId } from '../world/worlds';
import { INCOMING } from '../combat/combatConfig';

/** How many encounters between reward offers. */
export const ENCOUNTERS_PER_REWARD = 1;

/**
 * Elemental Convergence trades power for flexibility: it may hold fewer
 * upgrades of any single element and switches more slowly, while a focused
 * single-element build gets a straight affinity bonus.
 */
export const CONVERGENCE_ELEMENT_CAP = 3;
export const FOCUSED_AFFINITY_BONUS = 1.15;
export const CONVERGENCE_AFFINITY_BONUS = 1.0;

export interface RunStats {
  enemiesFelled: number;
  elitesFelled: number;
  bossesFelled: number;
  scenariosCompleted: number;
  worldsReached: number;
}

export function createRunStats(): RunStats {
  return {
    enemiesFelled: 0, elitesFelled: 0, bossesFelled: 0,
    scenariosCompleted: 0, worldsReached: 1,
  };
}

export class RunState {
  readonly build = new BuildState();
  meta: MetaState = createMeta();
  stats: RunStats = createRunStats();
  depth = 0;
  encounters = 0;
  worldTheme: WorldId = 'wilds';
  scenario: ScenarioState | null = null;
  /** Offers currently on screen, if any. */
  pendingOffers: RewardOffer[] = [];

  private affinity: AffinityId = 'air';

  load(data: {
    build?: unknown; meta?: unknown; depth?: number; encounters?: number;
    worldTheme?: WorldId; runStats?: Partial<RunStats>; affinity: AffinityId;
  }): void {
    this.affinity = data.affinity;
    this.build.load(data.build ?? {});
    this.meta = sanitiseMeta(data.meta);
    this.depth = Math.max(0, Math.floor(data.depth ?? 0));
    this.encounters = Math.max(0, Math.floor(data.encounters ?? 0));
    this.worldTheme = data.worldTheme ?? 'wilds';
    this.stats = { ...createRunStats(), ...(data.runStats ?? {}) };
    this.scenario = null;
    this.pendingOffers = [];
  }

  get world(): WorldDef {
    return worldDef(this.worldTheme);
  }

  get unlocked(): Set<string> {
    return unlockedSet(this.meta);
  }

  /** Which elements this run may draw upgrades for. */
  get elements(): ElementId[] {
    return elementsFor(this.affinity);
  }

  /**
   * Damage multiplier from the affinity itself.
   *
   * A focused single-element adept hits harder; Convergence trades that for
   * being able to answer any situation.
   */
  get affinityBonus(): number {
    return isConvergence(this.affinity) ? CONVERGENCE_AFFINITY_BONUS : FOCUSED_AFFINITY_BONUS;
  }

  /** Convergence may not stack more than this many upgrades of one element. */
  elementCapReached(element: ElementId): boolean {
    if (!isConvergence(this.affinity)) return false;
    let n = 0;
    for (const entry of this.build.list()) {
      if (entry.def.element === element) n += entry.stacks;
    }
    return n >= CONVERGENCE_ELEMENT_CAP;
  }

  // ------------------------------------------------------------ rewards

  /** Roll a fresh set of offers. `luck` biases toward higher rarity. */
  offerRewards(random: () => number = Math.random, luck = 0, count = 3): RewardOffer[] {
    const ctx: RewardContext = {
      elements: this.elements,
      unlocked: this.unlocked,
      depth: this.depth,
      luck,
    };
    let offers = rollRewards(this.build, ctx, random, count);
    // Respect the Convergence element cap by filtering and re-rolling once.
    if (isConvergence(this.affinity)) {
      offers = offers.filter((o) => o.def.element === 'any' || !this.elementCapReached(o.def.element));
      if (offers.length < count) {
        const extra = rollRewards(this.build, { ...ctx }, random, count * 2)
          .filter((o) => !offers.some((x) => x.def.id === o.def.id))
          .filter((o) => o.def.element === 'any' || !this.elementCapReached(o.def.element));
        offers = offers.concat(extra).slice(0, count);
      }
    }
    this.pendingOffers = offers;
    return offers;
  }

  /** Take one of the pending offers. Returns false when it was not on offer. */
  takeReward(id: string): boolean {
    if (!this.pendingOffers.some((o) => o.def.id === id)) return false;
    const ok = this.build.add(id);
    this.pendingOffers = [];
    return ok;
  }

  dismissRewards(): void {
    this.pendingOffers = [];
  }

  // --------------------------------------------------------- encounters

  /** Record a finished encounter. Returns true when a reward is due. */
  completeEncounter(): boolean {
    this.encounters += 1;
    this.depth += 1;
    return this.encounters % ENCOUNTERS_PER_REWARD === 0;
  }

  recordKill(elite: boolean, boss: boolean): void {
    this.stats.enemiesFelled += 1;
    if (elite) this.stats.elitesFelled += 1;
    if (boss) this.stats.bossesFelled += 1;
  }

  // ---------------------------------------------------------- scenarios

  startScenario(anchor: [number, number, number], random: () => number = Math.random): ScenarioState {
    const kind = pickScenario(this.world.scenarios, this.unlocked, random);
    return this.startScenarioOfKind(kind, anchor);
  }

  startScenarioOfKind(kind: ScenarioKind, anchor: [number, number, number]): ScenarioState {
    const state = createScenario(kind, anchor, this.depth);
    beginScenario(state);
    this.scenario = state;
    return state;
  }

  tickScenario(dt: number, liveEnemies: number): { completed: boolean; failed: boolean; spawn: boolean } {
    if (!this.scenario) return { completed: false, failed: false, spawn: false };
    const result = tickScenario(this.scenario, dt, liveEnemies);
    if (result.completed) this.stats.scenariosCompleted += 1;
    return result;
  }

  clearScenario(): void {
    this.scenario = null;
  }

  // -------------------------------------------------------------- meta

  /** Difficulty scalar applied to enemy health. */
  get difficulty(): number {
    return 1 + Math.min(INCOMING.healthCap, this.depth * INCOMING.healthPerDepth);
  }

  /**
   * Difficulty scalar applied to enemy *damage*.
   *
   * Deliberately much flatter than the health curve. Health climbing makes a
   * fight longer, which the player can answer with better play; damage
   * climbing at the same rate makes a fight shorter in a way they cannot,
   * because a first-person player cannot read their way out of a hit that
   * removes half the bar. Depth is meant to be tested by endurance, not by
   * one-shot kills.
   */
  get damageDifficulty(): number {
    return 1 + Math.min(INCOMING.damageCap, this.depth * INCOMING.damagePerDepth);
  }

  /** Chance that a spawned creature is promoted to an elite. */
  get eliteChance(): number {
    const base = 0.06 + Math.min(0.3, this.depth * 0.02);
    return this.meta.unlocked.includes('modifier-harder') ? base * 1.4 : base;
  }

  summary(): RunSummary {
    return {
      depth: this.depth,
      enemiesFelled: this.stats.enemiesFelled,
      elitesFelled: this.stats.elitesFelled,
      bossesFelled: this.stats.bossesFelled,
      scenariosCompleted: this.stats.scenariosCompleted,
      shrinesCleansed: 0,
      upgradesTaken: this.build.size,
      worldsReached: this.stats.worldsReached,
    };
  }

  /** Bank the run into permanent progression and return the currency earned. */
  finish(shrinesCleansed: number): number {
    const summary = this.summary();
    summary.shrinesCleansed = shrinesCleansed;
    return bankRun(this.meta, summary);
  }

  /** Start a fresh run, keeping meta progression. */
  resetRun(): void {
    this.build.clear();
    this.stats = createRunStats();
    this.depth = 0;
    this.encounters = 0;
    this.scenario = null;
    this.pendingOffers = [];
  }

  toJSON(): {
    build: Record<string, number>; meta: MetaState; depth: number;
    encounters: number; worldTheme: WorldId; runStats: RunStats;
  } {
    return {
      build: this.build.toJSON(),
      meta: this.meta,
      depth: this.depth,
      encounters: this.encounters,
      worldTheme: this.worldTheme,
      runStats: this.stats,
    };
  }
}
