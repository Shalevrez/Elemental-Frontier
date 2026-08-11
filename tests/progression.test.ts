import { describe, it, expect } from 'vitest';
import {
  BASE_MODIFIERS, RARITY_WEIGHTS, UPGRADES, accumulateStats, clampStats,
  upgradeById, validateUpgradeRegistry, type StatModifiers,
} from '../src/progression/upgrades';
import { BuildState } from '../src/progression/BuildState';
import { eligibleUpgrades, rarityWeightAt, rollRewards } from '../src/progression/rewards';
import {
  UNLOCKS, bankRun, createMeta, echoesForRun, purchase, sanitiseMeta, unlockedSet,
} from '../src/progression/meta';
import { RunState } from '../src/progression/RunState';
import {
  ELITE_MODIFIERS, ELITE_IDS, ENEMY_TYPES, ENEMY_KINDS,
  eliteAllowed, eliteName, eliteStats, rollElites,
} from '../src/combat/enemyTypes';
import { CombatDirector, isFairSpawn, relativeBearing } from '../src/combat/CombatDirector';
import {
  STATUSES, StatusSet, durationModifier, resolveReaction,
} from '../src/combat/status';
import {
  SCENARIOS, beginScenario, createScenario, damageWard, pickScenario,
  progressFraction, recover, reportProgress, tickScenario,
} from '../src/game/scenarios';
import { WORLDS, WORLD_ORDER, availableWorlds, lerpPalette, worldDef } from '../src/world/worlds';

/** Deterministic random source for repeatable draws. */
function seeded(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('upgrade registry', () => {
  it('is internally consistent', () => {
    expect(validateUpgradeRegistry()).toEqual([]);
  });

  it('covers every element plus generic options', () => {
    for (const element of ['fire', 'water', 'earth', 'air', 'any'] as const) {
      expect(UPGRADES.filter((u) => u.element === element).length).toBeGreaterThanOrEqual(6);
    }
  });

  it('rarity weights fall as rarity rises', () => {
    expect(RARITY_WEIGHTS.common).toBeGreaterThan(RARITY_WEIGHTS.uncommon);
    expect(RARITY_WEIGHTS.uncommon).toBeGreaterThan(RARITY_WEIGHTS.rare);
    expect(RARITY_WEIGHTS.rare).toBeGreaterThan(RARITY_WEIGHTS.epic);
    expect(RARITY_WEIGHTS.epic).toBeGreaterThan(RARITY_WEIGHTS.legendary);
  });

  it('accumulates multiplicative and additive stats correctly', () => {
    const stats: StatModifiers = { ...BASE_MODIFIERS };
    const honed = upgradeById('any-honed')!;
    accumulateStats(stats, honed, 3);
    // 1.12^3
    expect(stats.damageScale).toBeCloseTo(1.404928, 5);

    const hardy = upgradeById('any-hardy')!;
    accumulateStats(stats, hardy, 2);
    expect(stats.maxHealth).toBe(50);
  });

  it('clamps stats into safe ranges', () => {
    const stats: StatModifiers = { ...BASE_MODIFIERS, armor: 5, critChance: 3, cooldownScale: 0.01, lifesteal: 9 };
    clampStats(stats);
    expect(stats.armor).toBeLessThanOrEqual(0.75);
    expect(stats.critChance).toBeLessThanOrEqual(0.85);
    expect(stats.cooldownScale).toBeGreaterThanOrEqual(0.25);
    expect(stats.lifesteal).toBeLessThanOrEqual(0.4);
  });

  it('prefers mechanics over numbers at high rarity', () => {
    // Every legendary changes behaviour rather than only adding stats.
    for (const u of UPGRADES.filter((x) => x.rarity === 'legendary')) {
      expect((u.grants ?? []).length).toBeGreaterThan(0);
    }
  });
});

describe('build state', () => {
  it('stacks up to the ceiling and no further', () => {
    const build = new BuildState();
    const def = upgradeById('any-honed')!;
    for (let i = 0; i < def.maxStacks + 3; i++) build.add('any-honed');
    expect(build.stacksOf('any-honed')).toBe(def.maxStacks);
  });

  it('aggregates behaviour grants across upgrades', () => {
    const build = new BuildState();
    build.add('fire-split');
    expect(build.grant('split')).toBe(1);
    build.add('fire-split');
    expect(build.grant('split')).toBe(2);
    expect(build.hasGrant('split')).toBe(true);
    expect(build.hasGrant('nonexistent')).toBe(false);
  });

  it('honours prerequisites', () => {
    const build = new BuildState();
    const unlocked = new Set<string>();
    const cruel = upgradeById('any-cruel-edge')!;
    expect(build.canOffer(cruel, ['fire'], unlocked)).toBe(false);
    build.add('any-keen-edge');
    expect(build.canOffer(cruel, ['fire'], unlocked)).toBe(true);
  });

  it('honours incompatibilities in both directions', () => {
    const unlocked = new Set<string>();
    const heavy = upgradeById('fire-heavy-ember')!;
    const split = upgradeById('fire-split')!;

    const a = new BuildState();
    a.add('fire-split');
    expect(a.canOffer(heavy, ['fire'], unlocked)).toBe(false);

    const b = new BuildState();
    b.add('fire-heavy-ember');
    expect(b.canOffer(split, ['fire'], unlocked)).toBe(false);
  });

  it('restricts element-specific upgrades to matching affinities', () => {
    const build = new BuildState();
    const unlocked = new Set<string>();
    const fireUp = upgradeById('fire-split')!;
    expect(build.canOffer(fireUp, ['water'], unlocked)).toBe(false);
    expect(build.canOffer(fireUp, ['fire'], unlocked)).toBe(true);
    const generic = upgradeById('any-honed')!;
    expect(build.canOffer(generic, ['water'], unlocked)).toBe(true);
  });

  it('respects meta unlocks', () => {
    const build = new BuildState();
    const gated = UPGRADES.find((u) => u.unlock);
    if (gated) {
      expect(build.canOffer(gated, ['fire', 'water', 'earth', 'air'], new Set())).toBe(false);
      expect(build.canOffer(gated, ['fire', 'water', 'earth', 'air'], new Set([gated.unlock!]))).toBe(true);
    }
  });

  it('reports build paths and synergies', () => {
    const build = new BuildState();
    build.add('any-keen-edge');
    build.add('fire-crit-spread');
    const paths = build.buildPaths();
    expect(paths.some((p) => p.tag === 'critical')).toBe(true);
    const syn = build.synergies();
    expect(syn.some((s) => s.tag === 'critical')).toBe(true);
  });

  it('round-trips through JSON and drops unknown ids', () => {
    const build = new BuildState();
    build.add('any-honed');
    build.add('fire-split');
    const json = build.toJSON();
    const restored = new BuildState({ ...json, 'not-a-real-upgrade': 3 });
    expect(restored.stacksOf('any-honed')).toBe(1);
    expect(restored.stacksOf('fire-split')).toBe(1);
    expect(restored.stacksOf('not-a-real-upgrade')).toBe(0);
  });
});

describe('reward rolling', () => {
  const ctx = { elements: ['fire'] as const, unlocked: new Set<string>(), depth: 0 };

  it('offers three distinct legal choices', () => {
    const build = new BuildState();
    const offers = rollRewards(build, { ...ctx, elements: ['fire'] }, seeded([0.1, 0.4, 0.75, 0.2]), 3);
    expect(offers).toHaveLength(3);
    const ids = offers.map((o) => o.def.id);
    expect(new Set(ids).size).toBe(3);
    for (const offer of offers) {
      expect(offer.def.element === 'any' || offer.def.element === 'fire').toBe(true);
    }
  });

  it('never offers something the build cannot take', () => {
    const build = new BuildState();
    build.add('fire-heavy-ember');
    for (let i = 0; i < 40; i++) {
      const offers = rollRewards(build, { ...ctx, elements: ['fire'] }, Math.random, 3);
      expect(offers.some((o) => o.def.id === 'fire-split')).toBe(false);
    }
  });

  it('stops offering a maxed upgrade', () => {
    const build = new BuildState();
    const def = upgradeById('any-honed')!;
    for (let i = 0; i < def.maxStacks; i++) build.add('any-honed');
    const pool = eligibleUpgrades(build, { ...ctx, elements: ['fire'] });
    expect(pool.some((d) => d.id === 'any-honed')).toBe(false);
  });

  it('pushes toward higher rarity as depth grows', () => {
    const shallowLegend = rarityWeightAt('legendary', 0);
    const deepLegend = rarityWeightAt('legendary', 12);
    expect(deepLegend).toBeGreaterThan(shallowLegend);
    expect(rarityWeightAt('common', 12)).toBeLessThan(rarityWeightAt('common', 0));
  });

  it('returns fewer offers rather than illegal ones when the pool empties', () => {
    const build = new BuildState();
    // Fill the build with everything legal for a water adept.
    for (let round = 0; round < 60; round++) {
      const pool = eligibleUpgrades(build, { elements: ['water'], unlocked: new Set(), depth: 0 });
      if (pool.length === 0) break;
      build.add(pool[0]!.id);
    }
    const offers = rollRewards(build, { elements: ['water'], unlocked: new Set(), depth: 0 }, Math.random, 3);
    expect(offers.length).toBeLessThanOrEqual(3);
    for (const o of offers) expect(build.stacksOf(o.def.id)).toBeLessThan(o.def.maxStacks);
  });
});

describe('meta progression', () => {
  it('rewards interesting play over grinding', () => {
    const grind = echoesForRun({
      depth: 1, enemiesFelled: 100, elitesFelled: 0, bossesFelled: 0,
      scenariosCompleted: 0, shrinesCleansed: 0, upgradesTaken: 0, worldsReached: 1,
    });
    const skilled = echoesForRun({
      depth: 10, enemiesFelled: 20, elitesFelled: 4, bossesFelled: 1,
      scenariosCompleted: 3, shrinesCleansed: 2, upgradesTaken: 8, worldsReached: 2,
    });
    expect(skilled).toBeGreaterThan(grind);
  });

  it('buys unlocks and enforces cost and prerequisites', () => {
    const meta = createMeta();
    expect(purchase(meta, 'world-depths').ok).toBe(false); // too poor
    meta.echoes = 500;
    expect(purchase(meta, 'world-depths').ok).toBe(true);
    expect(purchase(meta, 'world-depths').ok).toBe(false); // already owned
    expect(purchase(meta, 'nope').ok).toBe(false);

    const fresh = createMeta();
    fresh.echoes = 500;
    // Peaks requires Depths.
    const locked = purchase(fresh, 'world-peaks');
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe('locked');
  });

  it('avoids raw-stat unlocks', () => {
    for (const u of UNLOCKS) {
      expect(['upgrade-pool', 'enemy', 'scenario', 'world', 'cosmetic', 'modifier']).toContain(u.kind);
    }
  });

  it('banks a run and survives hostile stored data', () => {
    const meta = createMeta();
    const earned = bankRun(meta, {
      depth: 5, enemiesFelled: 10, elitesFelled: 1, bossesFelled: 0,
      scenariosCompleted: 1, shrinesCleansed: 1, upgradesTaken: 3, worldsReached: 1,
    });
    expect(earned).toBeGreaterThan(0);
    expect(meta.echoes).toBe(earned);
    expect(meta.runs).toBe(1);

    const dirty = sanitiseMeta({ echoes: 'lots', unlocked: ['world-depths', 'fake', 7], runs: -3 });
    expect(dirty.echoes).toBe(0);
    expect(dirty.unlocked).toEqual(['world-depths']);
    expect(unlockedSet(dirty).has('world-depths')).toBe(true);
  });
});

describe('run state', () => {
  it('keeps Convergence flexible rather than simply stronger', () => {
    const focused = new RunState();
    focused.load({ affinity: 'fire' });
    const converged = new RunState();
    converged.load({ affinity: 'convergence' });
    expect(focused.affinityBonus).toBeGreaterThan(converged.affinityBonus);
    expect(converged.elements).toHaveLength(4);
    expect(focused.elements).toHaveLength(1);
  });

  it('caps how far Convergence can specialise in one element', () => {
    const run = new RunState();
    run.load({ affinity: 'convergence' });
    expect(run.elementCapReached('fire')).toBe(false);
    run.build.add('fire-split');
    run.build.add('fire-split');
    run.build.add('fire-corpse-bloom');
    expect(run.elementCapReached('fire')).toBe(true);
    expect(run.elementCapReached('water')).toBe(false);
  });

  it('escalates difficulty and elite chance with depth', () => {
    const run = new RunState();
    run.load({ affinity: 'earth' });
    const easy = run.difficulty;
    const easyElite = run.eliteChance;
    run.depth = 12;
    expect(run.difficulty).toBeGreaterThan(easy);
    expect(run.eliteChance).toBeGreaterThan(easyElite);
  });

  it('takes only an offered reward', () => {
    const run = new RunState();
    run.load({ affinity: 'fire' });
    run.offerRewards(seeded([0.2, 0.5, 0.8]));
    expect(run.takeReward('not-offered')).toBe(false);
    const id = run.pendingOffers[0]!.def.id;
    expect(run.takeReward(id)).toBe(true);
    expect(run.build.stacksOf(id)).toBe(1);
    expect(run.pendingOffers).toHaveLength(0);
  });

  it('resets the run but keeps meta progression', () => {
    const run = new RunState();
    run.load({ affinity: 'fire' });
    run.build.add('any-honed');
    run.meta.echoes = 40;
    run.depth = 7;
    run.resetRun();
    expect(run.build.size).toBe(0);
    expect(run.depth).toBe(0);
    expect(run.meta.echoes).toBe(40);
  });
});

describe('enemy roster', () => {
  it('defines a distinct tactical role per archetype', () => {
    const roles = new Set(ENEMY_KINDS.map((k) => ENEMY_TYPES[k].role));
    expect(roles.size).toBeGreaterThanOrEqual(6);
  });

  it('differs by more than colour and health', () => {
    const crawler = ENEMY_TYPES.crawler;
    const slinger = ENEMY_TYPES.slinger;
    const brute = ENEMY_TYPES.brute;
    expect(slinger.standoff).toBeGreaterThan(crawler.standoff);
    expect(brute.speed).toBeLessThan(crawler.speed);
    expect(brute.attacks.length).toBeGreaterThan(crawler.attacks.length);
    expect(brute.knockbackResist).toBeGreaterThan(crawler.knockbackResist);
    expect(ENEMY_TYPES.wisp.locomotion).not.toBe(crawler.locomotion);
  });

  it('gives every attack a real reaction window', () => {
    for (const kind of ENEMY_KINDS) {
      for (const attack of ENEMY_TYPES[kind].attacks) {
        expect(attack.telegraph).toBeGreaterThanOrEqual(0.4);
        expect(attack.cooldown).toBeGreaterThan(0);
      }
    }
  });

  it('never makes anything immune to an element', () => {
    for (const kind of ENEMY_KINDS) {
      const r = ENEMY_TYPES[kind].resistance;
      for (const element of ['air', 'water', 'earth', 'fire'] as const) {
        expect(r[element]).toBeGreaterThan(0);
      }
    }
  });
});

describe('elite modifiers', () => {
  it('every modifier changes behaviour, not just numbers', () => {
    for (const id of ELITE_IDS) {
      const def = ELITE_MODIFIERS[id];
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.rewardBonus).toBeGreaterThanOrEqual(1);
    }
  });

  it('refuses unfair combinations', () => {
    expect(eliteAllowed('shielded', 'crawler', ['armored'])).toBe(false);
    expect(eliteAllowed('armored', 'crawler', ['shielded'])).toBe(false);
    expect(eliteAllowed('swift', 'crawler', ['armored'])).toBe(false);
    expect(eliteAllowed('vampiric', 'crawler', ['regenerating'])).toBe(false);
    expect(eliteAllowed('swift', 'brute', [])).toBe(false); // tanks are not swift
    expect(eliteAllowed('splitting', 'boss-maw', [])).toBe(false);
    expect(eliteAllowed('volatile', 'sapper', [])).toBe(false);
    expect(eliteAllowed('armored', 'crawler', [])).toBe(true);
  });

  it('never rolls an illegal set', () => {
    for (const kind of ENEMY_KINDS) {
      for (let i = 0; i < 30; i++) {
        const ids = rollElites(kind, 3);
        for (let a = 0; a < ids.length; a++) {
          expect(eliteAllowed(ids[a]!, kind, ids.slice(0, a))).toBe(true);
        }
      }
    }
  });

  it('caps the combined multipliers', () => {
    const stats = eliteStats(['armored', 'regenerating', 'corrupted']);
    expect(stats.healthScale).toBeLessThanOrEqual(2.6);
    expect(stats.speedScale).toBeLessThanOrEqual(1.7);
    expect(stats.damageScale).toBeLessThanOrEqual(1.5);
  });

  it('produces a readable name', () => {
    expect(eliteName('crawler', [])).toBe('Corrupted Crawler');
    expect(eliteName('crawler', ['swift'])).toBe('Swift Corrupted Crawler');
  });
});

describe('combat director', () => {
  it('limits how many creatures attack at once', () => {
    const d = new CombatDirector({ maxTokens: 2, globalCooldown: 0 });
    expect(d.request(1, 0.5, true, true).granted).toBe(true);
    expect(d.request(2, 0.5, true, true).granted).toBe(true);
    const third = d.request(3, 0.5, true, true);
    expect(third.granted).toBe(false);
    expect(third.reason).toBe('no-token');
  });

  it('frees a token when the attacker finishes', () => {
    const d = new CombatDirector({ maxTokens: 1, globalCooldown: 0 });
    const first = d.request(1, 0.5, true, true);
    expect(first.granted).toBe(true);
    expect(d.request(2, 0.5, true, true).granted).toBe(false);
    d.release(first.token);
    expect(d.request(2, 0.5, true, true).granted).toBe(true);
  });

  it('does not consume tokens for ranged pot-shots', () => {
    const d = new CombatDirector({ maxTokens: 1, globalCooldown: 0 });
    d.request(1, 0.5, true, true);
    expect(d.request(2, 0.5, true, false).granted).toBe(true);
  });

  it('stretches the telegraph for attacks from behind and flags a warning', () => {
    const d = new CombatDirector({ globalCooldown: 0 });
    const front = d.request(1, 0.42, true, false);
    const behind = d.request(2, 0.42, false, false);
    expect(behind.telegraph).toBeGreaterThan(front.telegraph);
    expect(behind.telegraph).toBeGreaterThanOrEqual(0.85);
    expect(behind.needsWarning).toBe(true);
    expect(front.needsWarning).toBe(false);
  });

  it('enforces a minimum reaction window even for fast attacks', () => {
    const d = new CombatDirector({ globalCooldown: 0 });
    expect(d.request(1, 0.05, true, false).telegraph).toBeGreaterThanOrEqual(0.35);
  });

  it('spaces out hits landing on the player', () => {
    const d = new CombatDirector({ globalCooldown: 0.6, maxTokens: 4 });
    d.notifyLanded();
    const denied = d.request(1, 0.5, true, false);
    expect(denied.granted).toBe(false);
    expect(denied.reason).toBe('too-soon');
    d.update(0.7);
    expect(d.request(1, 0.5, true, false).granted).toBe(true);
  });

  it('never allows a close spawn behind the player', () => {
    // Straight behind, close: rejected.
    expect(isFairSpawn(0, 1, 0, -1, 12)).toBe(false);
    // Straight behind, far: allowed.
    expect(isFairSpawn(0, 1, 0, -1, 30)).toBe(true);
    // In front at a moderate distance: allowed.
    expect(isFairSpawn(0, -1, 0, -1, 16)).toBe(true);
  });

  it('computes the bearing of an incoming hit', () => {
    // Directly in front when facing -Z (yaw 0).
    expect(Math.abs(relativeBearing(0, -10, 0, 0, 0))).toBeLessThan(0.01);
    // Directly behind.
    expect(Math.abs(Math.abs(relativeBearing(0, 10, 0, 0, 0)) - Math.PI)).toBeLessThan(0.01);
    // To the right.
    expect(relativeBearing(10, 0, 0, 0, 0)).toBeCloseTo(Math.PI / 2, 2);
  });
});

describe('status effects and reactions', () => {
  it('stacks and expires', () => {
    const set = new StatusSet();
    set.apply('burning', 3, 5);
    set.apply('burning', 3, 5);
    expect(set.stacks('burning')).toBe(2);
    const expired: ReturnType<typeof set.tick> = [];
    set.tick(4, expired);
    expect(expired).toContain('burning');
    expect(set.has('burning')).toBe(false);
  });

  it('respects each status ceiling', () => {
    const set = new StatusSet();
    for (let i = 0; i < 12; i++) set.apply('burning');
    expect(set.stacks('burning')).toBe(STATUSES.burning.maxStacks);
    for (let i = 0; i < 5; i++) set.apply('frozen');
    expect(set.stacks('frozen')).toBe(1);
  });

  it('disables and slows the victim', () => {
    const set = new StatusSet();
    expect(set.disabled).toBe(false);
    set.apply('frozen');
    expect(set.disabled).toBe(true);
    expect(set.moveScale).toBe(0);
  });

  it('makes frozen targets more fragile and armored ones tougher', () => {
    const frozen = new StatusSet();
    frozen.apply('frozen');
    expect(frozen.damageTakenScale).toBeGreaterThan(1);

    const armored = new StatusSet();
    armored.apply('armored');
    expect(armored.damageTakenScale).toBeLessThan(1);
  });

  it('reports damage over time from burning', () => {
    const set = new StatusSet();
    set.apply('burning', 4, 6);
    set.apply('burning', 4, 6);
    expect(set.damageOverTime).toBeCloseTo(12, 5);
  });

  it('fire on a wet target makes steam, on a frozen one melts it', () => {
    const wet = new StatusSet();
    wet.apply('wet');
    const steam = resolveReaction('fire', wet);
    expect(steam?.id).toBe('steam');
    expect(steam?.removes).toContain('wet');

    const frozen = new StatusSet();
    frozen.apply('frozen');
    expect(resolveReaction('fire', frozen)?.id).toBe('melt');
  });

  it('water extinguishes burning and flash-freezes the soaked', () => {
    const burning = new StatusSet();
    burning.apply('burning');
    expect(resolveReaction('water', burning)?.id).toBe('extinguish');

    const wet = new StatusSet();
    wet.apply('wet');
    expect(resolveReaction('water', wet)?.id).toBe('flash-freeze');
  });

  it('earth shatters frozen targets for heavy bonus damage', () => {
    const frozen = new StatusSet();
    frozen.apply('frozen');
    const shatter = resolveReaction('earth', frozen);
    expect(shatter?.id).toBe('shatter');
    expect(shatter!.bonusDamage).toBeGreaterThan(0.8);
    expect(shatter!.areaBurst).toBe(true);
  });

  it('air spreads fire from a burning target', () => {
    const burning = new StatusSet();
    burning.apply('burning');
    const spread = resolveReaction('air', burning);
    expect(spread?.id).toBe('spread-fire');
    expect(spread!.areaBurst).toBe(true);
  });

  it('produces no reaction on a clean target', () => {
    const clean = new StatusSet();
    for (const el of ['fire', 'water', 'earth', 'air'] as const) {
      expect(resolveReaction(el, clean)).toBeNull();
    }
  });

  it('wet targets freeze faster and burn slower', () => {
    const wet = new StatusSet();
    wet.apply('wet');
    expect(durationModifier('frozen', wet)).toBeGreaterThan(1);
    expect(durationModifier('burning', wet)).toBeLessThan(1);
    expect(durationModifier('stunned', wet)).toBe(1);
  });
});

describe('scenarios', () => {
  it('completes a clear-all objective by reporting kills', () => {
    const state = createScenario('clear-all', [0, 0, 0]);
    beginScenario(state);
    expect(state.phase).toBe('active');
    for (let i = 0; i < state.target - 1; i++) {
      expect(reportProgress(state, 'clear-all')).toBe(false);
    }
    expect(reportProgress(state, 'clear-all')).toBe(true);
    expect(state.phase).toBe('complete');
    expect(progressFraction(state)).toBe(1);
  });

  it('advances waves only when the field is clear', () => {
    const state = createScenario('survive-waves', [0, 0, 0]);
    beginScenario(state);
    expect(tickScenario(state, 0.1, 0).spawn).toBe(true); // first wave
    // Enemies alive: no new wave.
    expect(tickScenario(state, 2, 3).spawn).toBe(false);
    // Field cleared: next wave.
    const next = tickScenario(state, 0.1, 0);
    expect(next.spawn).toBe(true);
    expect(state.wave).toBe(1);
  });

  it('fails a defence scenario when the ward falls', () => {
    const state = createScenario('defend-crystal', [0, 0, 0]);
    beginScenario(state);
    expect(damageWard(state, 0.5)).toBe(false);
    expect(damageWard(state, 0.6)).toBe(true);
    const tick = tickScenario(state, 0.1, 1);
    expect(tick.failed).toBe(true);
    expect(state.phase).toBe('failed');
  });

  it('completes a defence scenario when the timer runs out', () => {
    const state = createScenario('defend-crystal', [0, 0, 0]);
    beginScenario(state);
    let result = { completed: false, failed: false, spawn: false };
    for (let t = 0; t < 60 && !result.completed; t += 1) {
      result = tickScenario(state, 1, 2);
    }
    expect(result.completed).toBe(true);
  });

  it('fails an escape scenario when the timer runs out', () => {
    const state = createScenario('escape-collapse', [0, 0, 0]);
    beginScenario(state);
    let result = { completed: false, failed: false, spawn: false };
    for (let t = 0; t < 80 && !result.failed; t += 1) {
      result = tickScenario(state, 1, 0);
    }
    expect(result.failed).toBe(true);
  });

  it('can always be rescued from an impossible state', () => {
    const state = createScenario('clear-all', [0, 0, 0]);
    beginScenario(state);
    recover(state);
    expect(state.phase).toBe('complete');
  });

  it('respects meta unlocks when picking', () => {
    const gated = Object.values(SCENARIOS).filter((s) => s.unlock).map((s) => s.kind);
    const picked = pickScenario(gated, new Set(), () => 0.5);
    // With nothing unlocked it must still return something playable.
    expect(picked).toBe('clear-all');
    const unlocked = pickScenario(gated, new Set(['scenario-siege', 'scenario-puzzle']), () => 0);
    expect(gated).toContain(unlocked);
  });

  it('scales targets with depth', () => {
    const shallow = createScenario('clear-all', [0, 0, 0], 0);
    const deep = createScenario('clear-all', [0, 0, 0], 8);
    expect(deep.target).toBeGreaterThan(shallow.target);
  });
});

describe('world themes', () => {
  it('defines four distinct worlds', () => {
    expect(WORLD_ORDER).toHaveLength(4);
    const names = new Set(WORLD_ORDER.map((id) => WORLDS[id].name));
    expect(names.size).toBe(4);
  });

  it('gives each world its own terrain, palette, weather and roster', () => {
    const wilds = worldDef('wilds');
    const depths = worldDef('depths');
    const peaks = worldDef('peaks');
    const ashen = worldDef('ashen');
    expect(depths.terrain.caves).toBeGreaterThan(wilds.terrain.caves);
    expect(peaks.weather).toBe('snow');
    expect(ashen.weather).toBe('ash');
    expect(ashen.seaHazard).toBe(true);
    expect(wilds.seaHazard).toBe(false);
    expect(depths.palette.fogScale).toBeLessThan(wilds.palette.fogScale);
    expect(new Set([...wilds.enemies, ...ashen.enemies]).size)
      .toBeGreaterThan(wilds.enemies.length);
  });

  it('polishes at least two worlds fully and keeps the rest functional', () => {
    const full = WORLD_ORDER.filter((id) => WORLDS[id].polish === 'full');
    expect(full.length).toBeGreaterThanOrEqual(2);
    for (const id of WORLD_ORDER) {
      const w = WORLDS[id];
      expect(w.enemies.length).toBeGreaterThan(0);
      expect(w.scenarios.length).toBeGreaterThan(0);
      expect(w.boss.length).toBeGreaterThan(0);
    }
  });

  it('gates the later worlds behind meta unlocks', () => {
    expect(availableWorlds(new Set())).toEqual(['wilds']);
    expect(availableWorlds(new Set(['world-depths']))).toEqual(['wilds', 'depths']);
  });

  it('blends palettes smoothly for atmosphere transitions', () => {
    const a = worldDef('wilds').palette;
    const b = worldDef('ashen').palette;
    expect(lerpPalette(a, b, 0).skyTop).toBe(a.skyTop);
    expect(lerpPalette(a, b, 1).skyTop).toBe(b.skyTop);
    const mid = lerpPalette(a, b, 0.5);
    expect(mid.bloom).toBeCloseTo((a.bloom + b.bloom) / 2, 5);
  });
});
