/**
 * Reward economy and player growth.
 *
 * Deterministic assertions about the half of the game that decides what the
 * player becomes: how often a choice is offered, what rarities it draws from,
 * whether a card does what it says, what a stack of them adds up to, and what
 * survives a world transition or a death.
 *
 * Every module under test is pure, and every roll is driven by a seeded
 * generator, so the distributions below are exact rather than flaky.
 */

import { describe, expect, it } from 'vitest';
import {
  CADENCE, CREDIT, LUCK, consumeOffer, createCadenceState, currentGates,
  expectedOfferMinutes, offerLuck, recordAccomplishment, shouldOffer, tickCadence,
  type Accomplishment,
} from '../src/progression/cadence';
import {
  PITY, createRewardLuck, eligibleUpgrades, noteOffers, offerSubtitle, permanenceLabel,
  pityPush, previewOffer, rarityWeightAt, rollRewards,
} from '../src/progression/rewards';
import {
  BASE_MODIFIERS, CHEST_ONLY_UPGRADES, DAMAGE_CAPS, DECLARATIVE_BEHAVIOURS,
  IMPLEMENTED_BEHAVIOURS, RARITY_BUDGET, RARITY_ORDER, REWARD_UPGRADES, SAFE_MINIMUMS,
  UPGRADES, accumulateStats, behaviourCount, budgetProblems, cappedStats, clampStats,
  describeUpgrade, upgradeById, upgradeStatPower,
  type Rarity, type StatModifiers,
} from '../src/progression/upgrades';
import { BuildState } from '../src/progression/BuildState';
import { RunState, CONVERGENCE_ELEMENT_CAP } from '../src/progression/RunState';
import { rollChestOutcome, rollChestRarity, chestRarityFromRoll } from '../src/progression/chests';
import { mulberry32 } from '../src/core/rng';
import { ELEMENT_ORDER } from '../src/elements/elements';
import type { ElementId } from '../src/elements/affinity';

const ALL_ELEMENTS: ElementId[] = [...ELEMENT_ORDER];
const NO_UNLOCKS = new Set<string>();

/** A seeded generator, so every distribution below is reproducible. */
function rng(seed: number): () => number {
  return mulberry32(seed);
}

// =====================================================================
//  Reward cadence
// =====================================================================

describe('reward cadence', () => {
  /** Past the opening grace, so the steady-state gates apply. */
  function settled(): ReturnType<typeof createCadenceState> {
    return createCadenceState(CADENCE.openingOffers);
  }

  it('never offers a card for a single small skirmish', () => {
    const state = settled();
    // Well past the minimum gap, but nowhere near the maximum: one encounter
    // on its own is not a decision worth stopping the game for.
    tickCadence(state, CADENCE.minGap * 2);
    recordAccomplishment(state, 'encounter');
    expect(shouldOffer(state)).toBe(false);
  });

  it('offers one once enough has actually been achieved', () => {
    const state = settled();
    tickCadence(state, CADENCE.minGap);
    for (let i = 0; i < CADENCE.threshold; i++) recordAccomplishment(state, 'encounter');
    expect(shouldOffer(state)).toBe(true);
  });

  it('holds a card back until the minimum gap has passed', () => {
    const state = settled();
    for (let i = 0; i < 5; i++) recordAccomplishment(state, 'encounter');
    state.since = 0;
    expect(shouldOffer(state)).toBe(false);
    tickCadence(state, CADENCE.minGap);
    expect(shouldOffer(state)).toBe(true);
  });

  it('stops for a guardian or a boss immediately', () => {
    for (const what of ['guardian', 'boss'] as Accomplishment[]) {
      const state = settled();
      state.since = 0;
      recordAccomplishment(state, what);
      expect(shouldOffer(state), what).toBe(true);
    }
  });

  it('pays out eventually even when nothing dramatic happens', () => {
    const state = settled();
    recordAccomplishment(state, 'discovery');
    expect(shouldOffer(state)).toBe(false);
    tickCadence(state, CADENCE.maxGap);
    expect(shouldOffer(state)).toBe(true);
  });

  it('never offers a card for having achieved nothing at all', () => {
    const state = settled();
    tickCadence(state, CADENCE.maxGap * 5);
    expect(shouldOffer(state)).toBe(false);
  });

  it('hands out the first few cards sooner, so a build direction can form', () => {
    const fresh = createCadenceState(0);
    const later = createCadenceState(CADENCE.openingOffers);
    expect(currentGates(fresh).threshold).toBeLessThan(currentGates(later).threshold);
    expect(currentGates(fresh).minGap).toBeLessThan(currentGates(later).minGap);
  });

  it('lands inside the two-to-five minute target for a normal rate of play', () => {
    // One encounter cycle every 45 seconds - explore, fight, recover.
    const minutes = expectedOfferMinutes(45, 0.3);
    expect(minutes).toBeGreaterThanOrEqual(2);
    expect(minutes).toBeLessThanOrEqual(5);
  });

  it('still lands inside the window for a slow, careful player', () => {
    const minutes = expectedOfferMinutes(90, 0);
    expect(minutes).toBeGreaterThanOrEqual(2);
    expect(minutes).toBeLessThanOrEqual(5);
  });

  it('carries the richest accomplishment through as rarity luck', () => {
    const state = settled();
    recordAccomplishment(state, 'encounter');
    recordAccomplishment(state, 'elite');
    expect(offerLuck(state)).toBe(LUCK.elite);
    expect(LUCK.boss).toBeGreaterThan(LUCK.elite);
    expect(LUCK.elite).toBeGreaterThan(LUCK.encounter);
  });

  it('clears the ledger once a card has been shown', () => {
    const state = settled();
    recordAccomplishment(state, 'boss');
    consumeOffer(state);
    expect(state.credit).toBe(0);
    expect(state.luck).toBe(0);
    expect(state.since).toBe(0);
    expect(shouldOffer(state)).toBe(false);
  });

  it('prices a guardian above an elite above an ordinary encounter', () => {
    expect(CREDIT.boss).toBeGreaterThan(CREDIT.guardian);
    expect(CREDIT.guardian).toBeGreaterThan(CREDIT.elite);
    expect(CREDIT.elite).toBeGreaterThan(CREDIT.encounter);
  });
});

// =====================================================================
//  Rarity distribution and unlucky-streak protection
// =====================================================================

/** Roll many screens and count what came out, by rarity. */
function sampleRarities(
  count: number, depth: number, luck = 0, pity = 0, seed = 1234,
): Record<Rarity, number> {
  const random = rng(seed);
  const tally: Record<Rarity, number> = {
    common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0,
  };
  for (let i = 0; i < count; i++) {
    const build = new BuildState();
    const offers = rollRewards(
      build, { elements: ALL_ELEMENTS, unlocked: NO_UNLOCKS, depth, luck, pity }, random, 3,
    );
    for (const o of offers) tally[o.def.rarity] += 1;
  }
  return tally;
}

describe('rarity distribution', () => {
  it('is dominated by the lower rarities at the start of a run', () => {
    const tally = sampleRarities(2000, 0);
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    expect(total).toBe(6000);
    expect(tally.common / total).toBeGreaterThan(0.3);
    expect(tally.legendary / total).toBeLessThan(0.06);
    // Every rarity is reachable from the very first screen.
    for (const r of RARITY_ORDER) expect(tally[r], r).toBeGreaterThan(0);
  });

  it('shifts toward the higher rarities as a run deepens', () => {
    const early = sampleRarities(2000, 0);
    const late = sampleRarities(2000, 20);
    const share = (t: Record<Rarity, number>): number =>
      (t.rare + t.epic + t.legendary) / Object.values(t).reduce((a, b) => a + b, 0);
    expect(share(late)).toBeGreaterThan(share(early) * 1.5);
    expect(late.common).toBeLessThan(early.common);
  });

  it('never makes a legendary common, however deep the run goes', () => {
    const tally = sampleRarities(2000, 999);
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    expect(tally.legendary / total).toBeLessThan(0.35);
  });

  it('weights every rarity above zero at every depth', () => {
    for (const depth of [0, 5, 20, 100]) {
      for (const r of RARITY_ORDER) {
        expect(rarityWeightAt(r, depth), `${r}@${depth}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the rarity order monotonic in draw weight at depth zero', () => {
    let previous = Infinity;
    for (const r of RARITY_ORDER) {
      const w = rarityWeightAt(r, 0);
      expect(w, r).toBeLessThan(previous);
      previous = w;
    }
  });
});

describe('unlucky-streak protection', () => {
  it('does nothing at all for the first few screens', () => {
    const luck = createRewardLuck();
    for (let i = 0; i < PITY.grace; i++) {
      noteOffers(luck, [{ def: upgradeById('any-hardy')!, owned: 0, synergyHit: null }]);
    }
    expect(pityPush(luck)).toBe(0);
  });

  it('builds a push as poor screens accumulate, and caps it', () => {
    const luck = createRewardLuck();
    let previous = 0;
    for (let i = 0; i < 20; i++) {
      noteOffers(luck, [{ def: upgradeById('any-hardy')!, owned: 0, synergyHit: null }]);
      const push = pityPush(luck);
      expect(push).toBeGreaterThanOrEqual(previous);
      previous = push;
    }
    expect(previous).toBe(PITY.max);
  });

  it('resets the moment a Rare or better turns up', () => {
    const luck = createRewardLuck();
    for (let i = 0; i < 8; i++) {
      noteOffers(luck, [{ def: upgradeById('any-hardy')!, owned: 0, synergyHit: null }]);
    }
    expect(pityPush(luck)).toBeGreaterThan(0);
    noteOffers(luck, [{ def: upgradeById('any-siphon')!, owned: 0, synergyHit: null }]);
    expect(pityPush(luck)).toBe(0);
  });

  it('improves the odds without ever guaranteeing a Rare', () => {
    const without = sampleRarities(1500, 0, 0, 0, 99);
    const withPity = sampleRarities(1500, 0, 0, PITY.max, 99);
    const share = (t: Record<Rarity, number>): number =>
      (t.rare + t.epic + t.legendary) / Object.values(t).reduce((a, b) => a + b, 0);
    expect(share(withPity)).toBeGreaterThan(share(without));
    // Still not a guarantee: Commons keep appearing.
    expect(withPity.common).toBeGreaterThan(0);
  });
});

// =====================================================================
//  Rarity power budgets
// =====================================================================

describe('rarity power budgets', () => {
  it('prices every card in the pool correctly for its rarity', () => {
    const problems = UPGRADES
      .map((d) => ({ id: d.id, problems: budgetProblems(d) }))
      .filter((x) => x.problems.length > 0)
      .map((x) => `${x.id}: ${x.problems.join('; ')}`);
    expect(problems).toEqual([]);
  });

  it('raises the stat ceiling with every step of rarity', () => {
    let previous = 0;
    for (const r of RARITY_ORDER) {
      expect(RARITY_BUDGET[r].maxStat, r).toBeGreaterThan(previous);
      previous = RARITY_BUDGET[r].maxStat;
    }
  });

  it('makes the higher rarities carry a mechanic rather than a bigger number', () => {
    for (const r of ['rare', 'epic', 'legendary'] as const) {
      const cards = UPGRADES.filter((d) => d.rarity === r);
      expect(cards.length, r).toBeGreaterThan(0);
      const withBehaviour = cards.filter((d) => behaviourCount(d) > 0).length;
      expect(withBehaviour / cards.length, r).toBeGreaterThan(0.35);
    }
    // Every legendary without exception.
    for (const d of UPGRADES.filter((x) => x.rarity === 'legendary')) {
      expect(behaviourCount(d), d.id).toBeGreaterThan(0);
    }
  });

  it('implements every behaviour a card promises', () => {
    const broken: string[] = [];
    for (const def of UPGRADES) {
      for (const tag of def.grants ?? []) {
        if (IMPLEMENTED_BEHAVIOURS.has(tag) || DECLARATIVE_BEHAVIOURS.has(tag)) continue;
        broken.push(`${def.id} grants '${tag}', which nothing reads`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('gives every card a description that names a real effect', () => {
    const vague = /\b(greatly|far more|much more|a little|noticeably|big|small share)\b/i;
    for (const def of UPGRADES) {
      expect(def.description.length, def.id).toBeGreaterThan(8);
      expect(vague.test(def.description), `${def.id}: "${def.description}"`).toBe(false);
    }
  });

  it('describes every stat a card actually moves', () => {
    for (const def of UPGRADES) {
      const { benefits, penalties } = describeUpgrade(def, 1);
      const moved = Object.keys(def.stats ?? {}).length;
      if (moved === 0) continue;
      expect(benefits.length + penalties.length, def.id).toBeGreaterThan(0);
    }
  });

  it('shows a penalty for every card that carries one', () => {
    for (const def of UPGRADES.filter((d) => d.tradeoff)) {
      const { penalties } = describeUpgrade(def, 1);
      expect(penalties.length, def.id).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
//  Tradeoffs and safe minimums
// =====================================================================

describe('tradeoffs', () => {
  const tradeoffs = UPGRADES.filter((d) => d.tradeoff);

  it('never hides a penalty behind a benefit', () => {
    for (const def of tradeoffs) {
      const { benefits, penalties } = describeUpgrade(def, 1);
      expect(benefits.length, def.id).toBeGreaterThan(0);
      expect(penalties.length, def.id).toBeGreaterThan(0);
    }
  });

  it('makes the penalty a real fraction of the benefit, not a token', () => {
    for (const def of tradeoffs) {
      let good = 0;
      let bad = 0;
      for (const [key, value] of Object.entries(def.stats ?? {}) as [keyof StatModifiers, number][]) {
        const base = BASE_MODIFIERS[key];
        const magnitude = Math.abs(value - (typeof base === 'number' ? base : 0));
        // Whether a change helps depends on the stat; describeUpgrade knows.
        const line = describeUpgrade({ ...def, stats: { [key]: value } }, 1);
        if (line.penalties.length > 0) bad += magnitude;
        else good += magnitude;
      }
      expect(bad, `${def.id} has no measurable cost`).toBeGreaterThan(0);
      expect(good, `${def.id} has no measurable benefit`).toBeGreaterThan(0);
    }
  });

  it('cannot push a critical stat below its safe minimum', () => {
    const build = new BuildState();
    // Take every penalty-bearing card the build will accept, repeatedly.
    for (let pass = 0; pass < 6; pass++) {
      for (const def of tradeoffs) build.add(def.id);
    }
    const m = build.modifiers;
    expect(m.maxHealthScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.maxHealthScale);
    expect(m.maxEnergyScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.maxEnergyScale);
    expect(m.regenScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.regenScale);
    expect(m.rangeScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.rangeScale);
    expect(m.normalHitScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.normalHitScale);
    expect(m.ultimateGain).toBeGreaterThanOrEqual(SAFE_MINIMUMS.ultimateGain);
    expect(m.sprintScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.sprintScale);
    // And nothing essential is switched off entirely.
    expect(m.moveScale).toBeGreaterThan(0);
    expect(m.costScale).toBeLessThan(3);
  });

  it('never offers two mutually exclusive tradeoffs together', () => {
    const build = new BuildState();
    build.add('trade-swift-well');
    expect(build.canOffer(upgradeById('trade-deep-reserve')!, ALL_ELEMENTS, NO_UNLOCKS)).toBe(false);
    const other = new BuildState();
    other.add('trade-deep-reserve');
    expect(other.canOffer(upgradeById('trade-swift-well')!, ALL_ELEMENTS, NO_UNLOCKS)).toBe(false);
  });
});

describe('Double Damage', () => {
  const doubleDamage = upgradeById('chest-double-damage')!;

  it('stays legendary, unique and chest-only', () => {
    expect(doubleDamage.rarity).toBe('legendary');
    expect(doubleDamage.maxStacks).toBe(1);
    expect(doubleDamage.source).toBe('chest');
    expect(REWARD_UPGRADES.some((d) => d.id === doubleDamage.id)).toBe(false);
  });

  it('keeps its real downside', () => {
    const { penalties } = describeUpgrade(doubleDamage, 1);
    expect(penalties.length).toBeGreaterThan(0);
    expect(doubleDamage.stats?.maxEnergyScale).toBeLessThan(1);
  });

  it('cannot be combined with Glass Cannon in either order', () => {
    const a = new BuildState();
    a.add('chest-double-damage');
    expect(a.canOffer(upgradeById('trade-glass-cannon')!, ALL_ELEMENTS, NO_UNLOCKS)).toBe(false);
    const b = new BuildState();
    b.add('trade-glass-cannon');
    expect(b.canOffer(doubleDamage, ALL_ELEMENTS, NO_UNLOCKS)).toBe(false);
  });

  it('cannot be taken twice', () => {
    const build = new BuildState();
    expect(build.add('chest-double-damage')).toBe(true);
    expect(build.add('chest-double-damage')).toBe(false);
    expect(build.stacksOf('chest-double-damage')).toBe(1);
  });

  it('is never offered by a chest once it is owned', () => {
    const build = new BuildState();
    build.add('chest-double-damage');
    const ctx = {
      elements: ALL_ELEMENTS, unlocked: NO_UNLOCKS, depth: 30,
      maxHealth: 100, maxMana: 100,
    };
    for (let i = 0; i < 200; i++) {
      const outcome = rollChestOutcome(build, ctx, rng(i + 1), 'legendary');
      expect(outcome.upgradeId).not.toBe('chest-double-damage');
    }
  });
});

// =====================================================================
//  Upgrade stacking
// =====================================================================

describe('upgrade stacking', () => {
  it('makes one upgrade noticeable on its own', () => {
    for (const def of REWARD_UPGRADES) {
      const build = new BuildState();
      const before = { ...build.modifiers };
      build.add(def.id);
      const after = build.modifiers;
      const moved = (Object.keys(before) as (keyof StatModifiers)[])
        .some((k) => Math.abs(after[k] - before[k]) > 1e-9);
      // A pure-behaviour card moves no stat, and that is the point of it.
      expect(moved || behaviourCount(def) > 0, def.id).toBe(true);
    }
  });

  it('rewards several compatible upgrades with a genuinely strong build', () => {
    const build = new BuildState();
    for (let i = 0; i < 5; i++) build.add('any-honed');
    expect(build.modifiers.damageScale).toBeGreaterThan(1.7);
    build.add('any-overcharge');
    expect(build.modifiers.damageScale).toBeGreaterThan(2.5);
  });

  it('caps the multipliers that used to have no ceiling', () => {
    const build = new BuildState();
    for (let i = 0; i < 5; i++) build.add('any-honed');
    build.add('any-overcharge');
    build.add('chest-double-damage');
    expect(build.rawModifiers.damageScale).toBeGreaterThan(DAMAGE_CAPS.damageScale);
    expect(build.modifiers.damageScale).toBe(DAMAGE_CAPS.damageScale);

    const crit = new BuildState();
    crit.add('any-keen-edge');
    for (let i = 0; i < 3; i++) crit.add('any-cruel-edge');
    for (let i = 0; i < 3; i++) crit.add('chest-brutal');
    expect(crit.modifiers.critScale).toBeLessThanOrEqual(DAMAGE_CAPS.critScale);
  });

  it('tells the player which ceilings are in force', () => {
    const build = new BuildState();
    for (let i = 0; i < 5; i++) build.add('any-honed');
    build.add('any-overcharge');
    build.add('chest-double-damage');
    const caps = build.caps();
    expect(caps.some((c) => c.label === 'All elemental damage')).toBe(true);
    // A modest build reports nothing, because nothing is capped.
    expect(new BuildState().caps()).toEqual([]);
  });

  it('never lets any stacked stat run away, however extreme the build', () => {
    const build = new BuildState();
    for (let pass = 0; pass < 8; pass++) {
      for (const def of UPGRADES) build.add(def.id);
    }
    const m = build.modifiers;
    expect(m.damageScale).toBeLessThanOrEqual(DAMAGE_CAPS.damageScale);
    expect(m.fireScale).toBeLessThanOrEqual(DAMAGE_CAPS.elementScale);
    expect(m.waterScale).toBeLessThanOrEqual(DAMAGE_CAPS.elementScale);
    expect(m.earthScale).toBeLessThanOrEqual(DAMAGE_CAPS.elementScale);
    expect(m.airScale).toBeLessThanOrEqual(DAMAGE_CAPS.elementScale);
    expect(m.critScale).toBeLessThanOrEqual(DAMAGE_CAPS.critScale);
    expect(m.critChance).toBeLessThanOrEqual(0.85);
    expect(m.cooldownScale).toBeGreaterThanOrEqual(0.25);
    expect(m.costScale).toBeGreaterThanOrEqual(0.35);
    expect(m.armor).toBeLessThanOrEqual(0.75);
    expect(m.lifesteal).toBeLessThanOrEqual(0.4);
    expect(m.statusDuration).toBeLessThanOrEqual(2.5);
    expect(m.maxHealth).toBeLessThanOrEqual(420);
    expect(m.maxEnergy).toBeLessThanOrEqual(350);
    expect(m.energyRegen).toBeLessThanOrEqual(25);
    for (const value of Object.values(m)) expect(Number.isFinite(value)).toBe(true);
  });

  it('honours every declared stack limit', () => {
    for (const def of UPGRADES) {
      const build = new BuildState();
      for (let i = 0; i < def.maxStacks + 4; i++) build.add(def.id);
      expect(build.stacksOf(def.id), def.id).toBe(def.maxStacks);
    }
  });

  it('respects prerequisites in both directions', () => {
    const build = new BuildState();
    const cruel = upgradeById('any-cruel-edge')!;
    expect(cruel.requires).toContain('any-keen-edge');
    expect(build.canOffer(cruel, ALL_ELEMENTS, NO_UNLOCKS)).toBe(false);
    build.add('any-keen-edge');
    expect(build.canOffer(cruel, ALL_ELEMENTS, NO_UNLOCKS)).toBe(true);
  });

  it('applies each modifier exactly once per stack', () => {
    const stats: StatModifiers = { ...BASE_MODIFIERS };
    const honed = upgradeById('any-honed')!;
    accumulateStats(stats, honed, 3);
    clampStats(stats);
    expect(stats.damageScale).toBeCloseTo(1.12 ** 3, 6);

    const build = new BuildState();
    for (let i = 0; i < 3; i++) build.add('any-honed');
    expect(build.modifiers.damageScale).toBeCloseTo(1.12 ** 3, 6);
  });
});

// =====================================================================
//  Card previews
// =====================================================================

describe('selection card previews', () => {
  it('uses the same calculation path the game applies', () => {
    for (const def of REWARD_UPGRADES) {
      const build = new BuildState();
      const preview = previewOffer(build, def);
      // Apply it for real and compare against what the card promised.
      build.add(def.id);
      const actual = build.modifiers;
      const expected: StatModifiers = { ...BASE_MODIFIERS };
      accumulateStats(expected, def, 1);
      clampStats(expected);
      for (const key of Object.keys(actual) as (keyof StatModifiers)[]) {
        expect(actual[key], `${def.id}.${key}`).toBeCloseTo(expected[key], 9);
      }
      expect(preview.stacks).toBe(0);
      expect(preview.maxStacks).toBe(def.maxStacks);
    }
  });

  it('shows a before and after for every stat the card moves', () => {
    const build = new BuildState();
    const preview = previewOffer(build, upgradeById('trade-glass-cannon')!);
    const labels = preview.deltas.map((d) => d.label);
    expect(labels).toContain('Damage');
    expect(labels).toContain('Health scale');
    const damage = preview.deltas.find((d) => d.label === 'Damage')!;
    expect(damage.before).toBe('×1.00');
    expect(damage.after).toBe('×2.00');
    expect(damage.better).toBe(true);
    const health = preview.deltas.find((d) => d.label === 'Health scale')!;
    expect(health.better).toBe(false);
  });

  it('separates benefits from penalties and never leaves a cost unstated', () => {
    for (const def of UPGRADES.filter((d) => d.tradeoff)) {
      const preview = previewOffer(new BuildState(), def);
      expect(preview.penalties.length, def.id).toBeGreaterThan(0);
      expect(preview.tradeoff, def.id).toBe(true);
      expect(preview.warning, def.id).toBeTruthy();
      for (const line of preview.penalties) expect(line.tone).toBe('bad');
      for (const line of preview.benefits) expect(line.tone).not.toBe('bad');
    }
  });

  it('states the duration in plain language', () => {
    expect(permanenceLabel('save')).toMatch(/permanent/i);
    expect(permanenceLabel('temporary', 60)).toMatch(/60/);
    expect(permanenceLabel('world')).toMatch(/world/i);
    for (const def of REWARD_UPGRADES) {
      expect(previewOffer(new BuildState(), def).duration.length, def.id).toBeGreaterThan(4);
    }
  });

  it('names requirements and exclusions on the card itself', () => {
    const build = new BuildState();
    build.add('any-keen-edge');
    const cruel = previewOffer(build, upgradeById('any-cruel-edge')!);
    expect(cruel.requires).toContain('Keen Edge');

    const glass = previewOffer(new BuildState(), upgradeById('trade-glass-cannon')!);
    expect(glass.incompatible).toContain('Double Damage');
  });

  it('reports the stacks already owned', () => {
    const build = new BuildState();
    build.add('any-hardy');
    build.add('any-hardy');
    const preview = previewOffer(build, upgradeById('any-hardy')!);
    expect(preview.stacks).toBe(2);
    expect(preview.maxStacks).toBe(upgradeById('any-hardy')!.maxStacks);
  });

  it('gives every offer a readable subtitle naming its rarity and element', () => {
    for (const def of REWARD_UPGRADES.slice(0, 30)) {
      const subtitle = offerSubtitle({ def, owned: 0, synergyHit: null });
      expect(subtitle.toLowerCase()).toContain(def.rarity);
    }
  });
});

// =====================================================================
//  Element compatibility and Convergence
// =====================================================================

describe('element compatibility', () => {
  it('never offers a focused player a card they cannot use', () => {
    for (const element of ALL_ELEMENTS) {
      const build = new BuildState();
      const pool = eligibleUpgrades(build, {
        elements: [element], unlocked: NO_UNLOCKS, depth: 0,
      });
      expect(pool.length, element).toBeGreaterThan(20);
      for (const def of pool) {
        expect(def.element === 'any' || def.element === element, `${element}: ${def.id}`).toBe(true);
      }
    }
  });

  it('gives every element at least three build directions with real support', () => {
    const directions: Record<ElementId, string[][]> = {
      water: [['freezing'], ['sustain', 'healing', 'shield'], ['control', 'multi-target']],
      fire: [['burning'], ['explosions'], ['rapid', 'critical', 'speed']],
      earth: [['armor'], ['impact', 'heavy', 'stagger'], ['terrain']],
      air: [['mobility', 'speed'], ['knockback', 'impact'], ['multi-hit', 'deflect', 'multi-projectile']],
    };
    for (const element of ALL_ELEMENTS) {
      const own = REWARD_UPGRADES.filter((d) => d.element === element);
      expect(own.length, element).toBeGreaterThanOrEqual(10);
      for (const direction of directions[element]) {
        const support = own.filter((d) =>
          d.tags.some((t) => direction.includes(t)) || (d.synergy ?? []).some((t) => direction.includes(t)));
        expect(support.length, `${element} / ${direction.join('|')}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('offers a focused player enough early choice to pick a direction', () => {
    for (const element of ALL_ELEMENTS) {
      const build = new BuildState();
      const random = rng(7);
      const seen = new Set<string>();
      // The first three screens of a first world.
      for (let screen = 0; screen < 3; screen++) {
        const offers = rollRewards(
          build, { elements: [element], unlocked: NO_UNLOCKS, depth: screen }, random, 3,
        );
        for (const o of offers) seen.add(o.def.id);
      }
      expect(seen.size, element).toBeGreaterThanOrEqual(6);
    }
  });

  it('keeps every element supported at depth, not just at the start', () => {
    for (const element of ALL_ELEMENTS) {
      const build = new BuildState();
      // Take twenty rewards and check the pool never runs dry.
      const random = rng(11);
      for (let i = 0; i < 20; i++) {
        const offers = rollRewards(
          build, { elements: [element], unlocked: NO_UNLOCKS, depth: i }, random, 3,
        );
        expect(offers.length, `${element} at ${i}`).toBeGreaterThan(0);
        build.add(offers[0]!.def.id);
      }
    }
  });
});

describe('elemental convergence', () => {
  it('draws on a broader pool than a focused adept', () => {
    const build = new BuildState();
    const convergence = eligibleUpgrades(build, {
      elements: ALL_ELEMENTS, unlocked: NO_UNLOCKS, depth: 0,
    });
    const focused = eligibleUpgrades(build, {
      elements: ['fire'], unlocked: NO_UNLOCKS, depth: 0,
    });
    expect(convergence.length).toBeGreaterThan(focused.length);
  });

  it('still only ever offers cards it can use', () => {
    const build = new BuildState();
    for (const def of eligibleUpgrades(build, {
      elements: ALL_ELEMENTS, unlocked: NO_UNLOCKS, depth: 0,
    })) {
      expect(def.element === 'any' || ALL_ELEMENTS.includes(def.element as ElementId), def.id).toBe(true);
    }
  });

  it('holds Convergence to its per-element cap', () => {
    const run = new RunState();
    run.load({ affinity: 'convergence' });
    for (let i = 0; i < CONVERGENCE_ELEMENT_CAP; i++) {
      run.build.add(REWARD_UPGRADES.find((d) => d.element === 'fire' && d.maxStacks > i)!.id);
    }
    // Once the cap is reached, no further Fire card is offered.
    const offers = run.offerRewards(rng(3), 0, 3);
    for (const offer of offers) {
      if (offer.def.element === 'fire') expect(run.elementCapReached('fire')).toBe(false);
    }
  });

  it('never returns an empty screen to Convergence', () => {
    const run = new RunState();
    run.load({ affinity: 'convergence' });
    const random = rng(21);
    for (let i = 0; i < 30; i++) {
      const offers = run.offerRewards(random, 0, 3);
      expect(offers.length, `screen ${i}`).toBeGreaterThan(0);
      if (offers[0]) run.takeReward(offers[0].def.id);
    }
  });

  it('leaves a focused adept its specialization advantage', () => {
    const focused = new RunState();
    focused.load({ affinity: 'fire' });
    const convergence = new RunState();
    convergence.load({ affinity: 'convergence' });
    expect(focused.affinityBonus).toBeGreaterThan(convergence.affinityBonus);
  });
});

// =====================================================================
//  Chests
// =====================================================================

describe('chest rewards', () => {
  const ctx = {
    elements: ALL_ELEMENTS, unlocked: NO_UNLOCKS, depth: 5,
    maxHealth: 100, maxMana: 100,
  };

  it('always produces a valid, fully described outcome', () => {
    for (let i = 0; i < 400; i++) {
      const outcome = rollChestOutcome(new BuildState(), ctx, rng(i + 1));
      expect(outcome.name.length, `roll ${i}`).toBeGreaterThan(0);
      expect(outcome.summary.length).toBeGreaterThan(0);
      expect(RARITY_ORDER).toContain(outcome.rarity);
      expect(['upgrade', 'blessing', 'recovery']).toContain(outcome.kind);
      // Something of value, every time.
      const gives = outcome.upgradeId !== null || outcome.buffId !== null || outcome.instant !== null;
      expect(gives, `roll ${i} gave nothing`).toBe(true);
      expect(outcome.benefits.length).toBeGreaterThan(0);
    }
  });

  it('gives the same chest the same contents however often it is reloaded', () => {
    const build = new BuildState();
    for (const propId of [1, 17, 204]) {
      const seeded = (): (() => number) => mulberry32(((12345) ^ (propId * 2654435761)) >>> 0);
      const first = rollChestOutcome(build, ctx, seeded(), 'rare');
      for (let repeat = 0; repeat < 5; repeat++) {
        const again = rollChestOutcome(build, ctx, seeded(), 'rare');
        expect(again.name, `prop ${propId}`).toBe(first.name);
        expect(again.upgradeId).toBe(first.upgradeId);
        expect(again.buffId).toBe(first.buffId);
        expect(again.kind).toBe(first.kind);
      }
    }
  });

  it('gives different chests different contents', () => {
    const build = new BuildState();
    const names = new Set<string>();
    for (let propId = 0; propId < 40; propId++) {
      const random = mulberry32(((999) ^ (propId * 2654435761)) >>> 0);
      names.add(rollChestOutcome(build, ctx, random, 'rare').name);
    }
    expect(names.size).toBeGreaterThan(1);
  });

  it('falls back rather than failing when the permanent pool is exhausted', () => {
    const build = new BuildState();
    // Max out every chest upgrade there is.
    for (const def of CHEST_ONLY_UPGRADES) {
      for (let i = 0; i < def.maxStacks; i++) build.add(def.id);
    }
    for (const rarity of RARITY_ORDER) {
      for (let i = 0; i < 40; i++) {
        const outcome = rollChestOutcome(build, ctx, rng(i + 1), rarity);
        expect(outcome.kind, rarity).not.toBe('upgrade');
        const gives = outcome.buffId !== null || outcome.instant !== null;
        expect(gives, `${rarity} roll ${i}`).toBe(true);
      }
    }
  });

  it('never hands out a permanent upgrade already at its maximum', () => {
    const build = new BuildState();
    for (const def of CHEST_ONLY_UPGRADES) {
      for (let i = 0; i < def.maxStacks; i++) build.add(def.id);
    }
    for (let i = 0; i < 200; i++) {
      const outcome = rollChestOutcome(build, ctx, rng(i + 1));
      if (!outcome.upgradeId) continue;
      const def = upgradeById(outcome.upgradeId)!;
      expect(build.stacksOf(def.id)).toBeLessThan(def.maxStacks);
    }
  });

  it('marks permanent and temporary rewards distinctly', () => {
    for (let i = 0; i < 300; i++) {
      const outcome = rollChestOutcome(new BuildState(), ctx, rng(i + 1));
      if (outcome.kind === 'upgrade') {
        expect(outcome.permanence).toBe('save');
        expect(outcome.seconds).toBe(0);
      } else {
        expect(outcome.permanence).toBe('temporary');
      }
      if (outcome.kind === 'blessing') expect(outcome.seconds).toBeGreaterThan(0);
    }
  });

  it('keeps the rarity of a chest stable for a given position roll', () => {
    for (let i = 0; i <= 100; i++) {
      const roll = i / 100;
      expect(chestRarityFromRoll(roll)).toBe(chestRarityFromRoll(roll));
    }
    expect(chestRarityFromRoll(0)).toBe('legendary');
    expect(chestRarityFromRoll(0.99)).toBe('common');
    // Out-of-range input never throws or returns nothing.
    expect(RARITY_ORDER).toContain(chestRarityFromRoll(-5));
    expect(RARITY_ORDER).toContain(chestRarityFromRoll(Number.NaN));
  });

  it('keeps legendary chests scarce and every rarity reachable', () => {
    const tally: Record<Rarity, number> = {
      common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0,
    };
    const random = rng(4242);
    for (let i = 0; i < 5000; i++) tally[rollChestRarity(3, 0, random)] += 1;
    for (const r of RARITY_ORDER) expect(tally[r], r).toBeGreaterThan(0);
    expect(tally.legendary / 5000).toBeLessThan(0.05);
    expect(tally.common).toBeGreaterThan(tally.epic);
  });
});

// =====================================================================
//  Persistence
// =====================================================================

describe('build persistence', () => {
  /** A build with a bit of everything: stacks, a tradeoff, a chest reward. */
  function richBuild(): BuildState {
    const build = new BuildState();
    build.add('any-hardy');
    build.add('any-hardy');
    build.add('any-keen-edge');
    build.add('any-cruel-edge');
    build.add('trade-precision');
    build.add('chest-double-damage');
    build.add('fire-split');
    return build;
  }

  it('round-trips a whole build through the save shape', () => {
    const build = richBuild();
    const json = build.toJSON();
    const restored = new BuildState(json);
    expect(restored.toJSON()).toEqual(json);
    for (const key of Object.keys(build.modifiers) as (keyof StatModifiers)[]) {
      expect(restored.modifiers[key], key).toBeCloseTo(build.modifiers[key], 9);
    }
  });

  it('keeps stack counts, tradeoffs and chest rewards exactly', () => {
    const restored = new BuildState(richBuild().toJSON());
    expect(restored.stacksOf('any-hardy')).toBe(2);
    expect(restored.stacksOf('trade-precision')).toBe(1);
    expect(restored.stacksOf('chest-double-damage')).toBe(1);
    expect(restored.hasGrant('split')).toBe(true);
  });

  it('survives a world transition, a death and a Continue unchanged', () => {
    const run = new RunState();
    run.load({ affinity: 'fire' });
    for (const id of ['any-hardy', 'fire-split', 'trade-precision']) run.build.add(id);
    const saved = run.toJSON();

    // A world transition reloads the run layer from the same payload.
    const afterTransition = new RunState();
    afterTransition.load({ ...saved, affinity: 'fire' });
    expect(afterTransition.build.toJSON()).toEqual(saved.build);
    expect(afterTransition.depth).toBe(saved.depth);

    // Death does not clear the build: only an explicit reset does.
    const afterDeath = new RunState();
    afterDeath.load({ ...saved, affinity: 'fire' });
    expect(afterDeath.build.toJSON()).toEqual(saved.build);

    // And a deliberate new run is the one thing that does.
    afterDeath.resetRun();
    expect(afterDeath.build.toJSON()).toEqual({});
  });

  it('ignores unknown or corrupt entries instead of failing to load', () => {
    const build = new BuildState({
      'any-hardy': 2,
      'no-such-upgrade': 4,
      'any-honed': -3,
      'any-quickstep': Number.NaN,
    } as unknown as Record<string, number>);
    expect(build.stacksOf('any-hardy')).toBe(2);
    expect(build.stacksOf('no-such-upgrade')).toBe(0);
    expect(build.stacksOf('any-honed')).toBe(0);
    expect(build.stacksOf('any-quickstep')).toBe(0);
  });

  it('clamps a saved stack count that exceeds the current maximum', () => {
    // An older save could hold more stacks than the card now allows; loading
    // must clamp rather than carry the excess forward.
    const build = new BuildState({ 'any-hardy': 99 });
    expect(build.stacksOf('any-hardy')).toBe(upgradeById('any-hardy')!.maxStacks);
  });

  it('keeps every reward in an existing save loadable after the rebalance', () => {
    // Every id the pool has ever offered must still resolve, so no acquired
    // reward can be orphaned by a rarity move or a description change.
    const everything: Record<string, number> = {};
    for (const def of UPGRADES) everything[def.id] = def.maxStacks;
    const build = new BuildState(everything);
    for (const def of UPGRADES) {
      expect(build.stacksOf(def.id), def.id).toBe(def.maxStacks);
      expect(upgradeById(def.id), def.id).toBeDefined();
    }
  });

  it('reports capped totals rather than silently applying less', () => {
    const everything: Record<string, number> = {};
    for (const def of UPGRADES) everything[def.id] = def.maxStacks;
    const build = new BuildState(everything);
    const caps = cappedStats(build.rawModifiers);
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(cap.label.length).toBeGreaterThan(0);
      expect(cap.value).toMatch(/^x\d/);
    }
  });
});

// =====================================================================
//  Progression curve
// =====================================================================

describe('progression curve', () => {
  /** Simulate a player taking one reward per screen at a given depth. */
  function powerAfter(screens: number, element: ElementId, seed = 5): number {
    const build = new BuildState();
    const random = rng(seed);
    for (let i = 0; i < screens; i++) {
      const offers = rollRewards(
        build, { elements: [element], unlocked: NO_UNLOCKS, depth: i }, random, 3,
      );
      if (offers.length === 0) break;
      // Take the strongest thing on offer, as a focused player would.
      const best = offers.reduce((a, b) => (upgradeStatPower(a.def) >= upgradeStatPower(b.def) ? a : b));
      build.add(best.def.id);
    }
    const m = build.modifiers;
    // A crude standing: offensive multiplier times survivability.
    return m.damageScale * m.critScale * (1 + m.maxHealth / 100) / m.cooldownScale;
  }

  it('rises clearly across the campaign rather than plateauing', () => {
    const marks = [3, 8, 16, 26, 38].map((n) => powerAfter(n, 'fire'));
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!, `mark ${i}`).toBeGreaterThan(marks[i - 1]!);
    }
    // And the first world is not flat: three rewards already move the needle.
    expect(marks[0]!).toBeGreaterThan(powerAfter(0, 'fire'));
  });

  it('does not reach its ceiling in the first world', () => {
    const early = powerAfter(6, 'fire');
    const late = powerAfter(38, 'fire');
    expect(early).toBeLessThan(late * 0.75);
  });

  it('keeps late rewards meaningful rather than rounding errors', () => {
    const build = new BuildState();
    const random = rng(9);
    for (let i = 0; i < 24; i++) {
      const offers = rollRewards(
        build, { elements: ['water'], unlocked: NO_UNLOCKS, depth: i }, random, 3,
      );
      if (offers.length > 0) build.add(offers[0]!.def.id);
    }
    // One more reward on a deep build still changes something.
    const before = { ...build.modifiers };
    const late = rollRewards(
      build, { elements: ['water'], unlocked: NO_UNLOCKS, depth: 30 }, random, 3,
    );
    expect(late.length).toBeGreaterThan(0);
    build.add(late[0]!.def.id);
    const moved = (Object.keys(before) as (keyof StatModifiers)[])
      .some((k) => Math.abs(build.modifiers[k] - before[k]) > 1e-9);
    expect(moved || behaviourCount(late[0]!.def) > 0).toBe(true);
  });

  it('leaves permanent progression expanding choice rather than raw power', () => {
    // Meta unlocks gate which cards exist, not how strong they are.
    const gated = UPGRADES.filter((d) => d.unlock);
    for (const def of gated) {
      expect(budgetProblems(def), def.id).toEqual([]);
    }
  });
});
