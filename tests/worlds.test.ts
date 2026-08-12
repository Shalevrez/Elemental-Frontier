/**
 * Worlds, guardians and the difficulty curve.
 *
 * The four worlds looked different long before they fought differently. These
 * tests pin down the part that matters: that each world asks something the
 * previous one did not, that the curve climbs through composition rather than
 * through arithmetic, that every hazard is real, and that a New Game Plus
 * cycle can never scale past the point of being playable.
 *
 * Everything under test is pure, so none of it needs a renderer.
 */

import { describe, expect, it } from 'vitest';
import {
  GUARDIAN_PROFILES, NG_PLUS, WORLD_PROFILES, allowsKind, campaignCurve, chooseKind,
  createComposition, difficultyIndex, guardianHealthScale, isHeavy, isRanged, ngCycles,
  notePlacement, phaseAt, worldDifficulty,
} from '../src/world/progression';
import {
  WORLDS, WORLD_ORDER, availableWorlds, isWorldId, nextWorld, worldDef, worldIndex,
  type WorldId,
} from '../src/world/worlds';
import { ENEMY_TYPES, type EnemyKind } from '../src/combat/enemyTypes';
import { CombatDirector } from '../src/combat/CombatDirector';
import { EncounterDirector, encounterBudget, type EncounterSignals } from '../src/combat/encounter';
import { TOKENS } from '../src/combat/combatConfig';
import { SAVE_VERSION, createSave, validateSave } from '../src/save/saveData';
import { mulberry32 } from '../src/core/rng';
import { RunState } from '../src/progression/RunState';

const ALL: readonly WorldId[] = WORLD_ORDER;

function rng(seed: number): () => number {
  return mulberry32(seed);
}

// =====================================================================
//  World distinctness
// =====================================================================

describe('world definitions', () => {
  it('covers the campaign order with no gaps', () => {
    expect(ALL.length).toBe(4);
    for (const id of ALL) {
      expect(WORLDS[id], id).toBeDefined();
      expect(isWorldId(id)).toBe(true);
    }
    expect(isWorldId('nowhere')).toBe(false);
    expect(nextWorld('peaks')).toBeNull();
    expect(nextWorld('wilds')).toBe('depths');
  });

  it('differs structurally, not only in colour', () => {
    // Terrain shape is what makes a world a place rather than a palette.
    const shapes = ALL.map((id) => {
      const t = worldDef(id).terrain;
      return `${t.islands}|${t.basinDepth}|${t.ridge}|${t.submergence}|${t.caves}`;
    });
    expect(new Set(shapes).size).toBe(ALL.length);
  });

  it('gives each world its own fluid, hazard and traversal rules', () => {
    // The islands world is the one that is really submerged.
    expect(worldDef('depths').terrain.islands).toBeGreaterThan(1);
    expect(worldDef('depths').terrain.submergence).toBeGreaterThanOrEqual(0.5);
    // Only the caldera's sea is harmful.
    expect(worldDef('ashen').seaHazard).toBe(true);
    for (const id of ALL.filter((w) => w !== 'ashen')) {
      expect(worldDef(id).seaHazard, id).toBe(false);
    }
    // Only the frozen world is slick underfoot.
    expect(worldDef('peaks').slippery).toBe(true);
    for (const id of ALL.filter((w) => w !== 'peaks')) {
      expect(worldDef(id).slippery, id).toBe(false);
    }
  });

  it('declares a real hazard wherever it claims one, and none where it does not', () => {
    for (const id of ALL) {
      const def = worldDef(id);
      if (def.hazard.kind === 'none') {
        expect(def.hazard.contactDamage, id).toBe(0);
        expect(def.hazard.dotDamage, id).toBe(0);
        continue;
      }
      // A declared hazard has to actually do something.
      const bites = def.hazard.contactDamage > 0 || def.hazard.dotDamage > 0;
      expect(bites, `${id} declares ${def.hazard.kind} but does nothing`).toBe(true);
      expect(def.hazard.name.length, id).toBeGreaterThan(0);
    }
  });

  it('keeps lava survivable on contact but dangerous to stand in', () => {
    const lava = worldDef('ashen').hazard;
    // A brush costs a fraction of the bar, not the bar. The game applies half
    // the contact damage per half-second tick.
    const perTick = lava.contactDamage * 0.5;
    expect(perTick).toBeLessThan(100 * 0.25);
    // Standing in it for three seconds is most of a full-health player.
    const threeSeconds = perTick * 6 + lava.dotDamage * 3;
    expect(threeSeconds).toBeGreaterThan(50);
    // And the player is warned before they reach it.
    expect(lava.warningBand).toBeGreaterThan(1);
  });

  it('keeps the deep cold a drain rather than a spike', () => {
    const cold = worldDef('peaks').hazard;
    expect(cold.kind).toBe('deep-cold');
    expect(cold.contactDamage).toBe(0);
    // A fully exposed player has well over ten seconds to reach cover.
    expect(100 / cold.dotDamage).toBeGreaterThan(15);
  });

  it('gives every world a distinct roster and signature creature', () => {
    const signatures = new Set(ALL.map((id) => worldDef(id).signatureEnemy));
    expect(signatures.size).toBe(ALL.length);
    for (const id of ALL) {
      const def = worldDef(id);
      expect(def.enemies.length, id).toBeGreaterThanOrEqual(4);
      // The signature has to be in the roster it signs.
      expect(def.enemies, id).toContain(def.signatureEnemy);
      for (const kind of def.enemies) expect(ENEMY_TYPES[kind], `${id}/${kind}`).toBeDefined();
    }
  });

  it('names a boss, a heart and a portal for every world', () => {
    for (const id of ALL) {
      const def = worldDef(id);
      expect(ENEMY_TYPES[def.boss], id).toBeDefined();
      expect(def.heart.name.length, id).toBeGreaterThan(0);
      expect(def.portal.length, id).toBeGreaterThan(0);
      // The guardian named in the world data is the one the profile builds.
      expect(GUARDIAN_PROFILES[id].name, id).toBe(def.heart.guardian);
    }
  });

  it('gates the later worlds behind their unlocks but never the first', () => {
    expect(worldDef('wilds').unlock).toBeUndefined();
    expect(availableWorlds(new Set())).toEqual(['wilds']);
    const all = availableWorlds(new Set(['world-depths', 'world-ashen', 'world-peaks']));
    expect(all).toEqual([...ALL]);
  });

  it('bounds how much ground a single attack may reshape, per world', () => {
    for (const id of ALL) {
      const radius = worldDef(id).maxDeformRadius;
      expect(radius, id).toBeGreaterThan(0);
      expect(radius, id).toBeLessThanOrEqual(7);
    }
  });
});

// =====================================================================
//  The difficulty curve
// =====================================================================

describe('difficulty curve', () => {
  it('climbs across the campaign', () => {
    const curve = campaignCurve(0);
    expect(curve.map((c) => c.world)).toEqual([...ALL]);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.index, `${curve[i]!.world} vs ${curve[i - 1]!.world}`)
        .toBeGreaterThan(curve[i - 1]!.index);
    }
  });

  it('climbs through composition rather than through health', () => {
    const first = worldDifficulty('wilds');
    const last = worldDifficulty('peaks');
    // Composition moves a lot.
    expect(last.rangedShare).toBeGreaterThan(first.rangedShare);
    expect(last.heavyShare).toBeGreaterThan(first.heavyShare);
    expect(last.eliteScale).toBeGreaterThan(first.eliteScale * 1.5);
    expect(last.tokenBonus).toBeGreaterThan(first.tokenBonus);
    // Health does not move at all across the base campaign.
    expect(last.healthScale).toBe(first.healthScale);
    expect(first.healthScale).toBe(1);
  });

  it('makes the first world the gentlest on every axis', () => {
    const wilds = worldDifficulty('wilds');
    for (const id of ALL.filter((w) => w !== 'wilds')) {
      const other = worldDifficulty(id);
      expect(other.rangedShare, id).toBeGreaterThanOrEqual(wilds.rangedShare);
      expect(other.eliteScale, id).toBeGreaterThanOrEqual(wilds.eliteScale);
      expect(other.budgetScale, id).toBeGreaterThanOrEqual(wilds.budgetScale);
    }
    // And it has no environmental hazard whatsoever.
    expect(wilds.hazardScale).toBe(0);
    expect(WORLD_PROFILES.wilds.hazardScale).toBe(0);
  });

  it('gives each world a stated intent rather than a colour swap', () => {
    const intents = new Set(ALL.map((id) => WORLD_PROFILES[id].intent));
    expect(intents.size).toBe(ALL.length);
    for (const id of ALL) {
      expect(WORLD_PROFILES[id].intent.length, id).toBeGreaterThan(20);
      expect(WORLD_PROFILES[id].favouredRoles.length, id).toBeGreaterThan(0);
    }
  });

  it('never lets any world exceed the fairness ceilings the combat pass set', () => {
    for (const id of ALL) {
      for (let cycle = 0; cycle <= 12; cycle++) {
        const d = worldDifficulty(id, cycle);
        expect(d.rangedShare, `${id}@${cycle}`).toBeLessThanOrEqual(NG_PLUS.shareCap);
        expect(d.heavyShare, `${id}@${cycle}`).toBeLessThanOrEqual(NG_PLUS.shareCap);
        expect(d.eliteScale, `${id}@${cycle}`).toBeLessThanOrEqual(NG_PLUS.eliteCap);
        expect(d.budgetScale, `${id}@${cycle}`).toBeLessThanOrEqual(NG_PLUS.budgetCap);
        expect(d.healthScale, `${id}@${cycle}`).toBeLessThanOrEqual(NG_PLUS.healthCap);
        expect(d.tokenBonus, `${id}@${cycle}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('holds the simultaneous-attacker ceiling at four however deep it goes', () => {
    const director = new CombatDirector({ globalCooldown: 0 });
    director.setDepth(9999);
    director.setWorldBonus(worldDifficulty('peaks', 99).tokenBonus);
    expect(director.maxTokens).toBeLessThanOrEqual(TOKENS.lateBudget);
  });

  it('scales the encounter budget by world without flooding the arena', () => {
    for (const id of ALL) {
      const d = worldDifficulty(id, 99);
      const encounter = new EncounterDirector();
      encounter.setDepth(9999);
      encounter.setBudgetScale(d.budgetScale);
      encounter.forceEncounter();
      expect(encounter.status.budgetLeft, id).toBeLessThanOrEqual(encounterBudget(9999));
    }
  });
});

// =====================================================================
//  New Game Plus
// =====================================================================

describe('new game plus', () => {
  it('clamps the cycle count into the range the scaling is defined over', () => {
    expect(ngCycles(-4)).toBe(0);
    expect(ngCycles(0)).toBe(0);
    expect(ngCycles(3)).toBe(3);
    expect(ngCycles(9999)).toBe(NG_PLUS.maxCycles);
    expect(ngCycles(Number.NaN)).toBe(0);
    expect(ngCycles(2.7)).toBe(2);
  });

  it('makes each cycle harder than the last, up to the ceiling', () => {
    let previous = -Infinity;
    for (let cycle = 0; cycle <= NG_PLUS.maxCycles; cycle++) {
      const index = difficultyIndex('wilds', cycle);
      expect(index, `cycle ${cycle}`).toBeGreaterThan(previous);
      previous = index;
    }
    // And then stops, so a tenth cycle is not a hundred times harder.
    expect(difficultyIndex('wilds', 99)).toBe(difficultyIndex('wilds', NG_PLUS.maxCycles));
  });

  it('leans on combination rather than on arithmetic', () => {
    const base = worldDifficulty('depths', 0);
    const deep = worldDifficulty('depths', NG_PLUS.maxCycles);
    // Elites more than double; health rises by well under that.
    const eliteGrowth = deep.eliteScale / base.eliteScale;
    const healthGrowth = deep.healthScale / base.healthScale;
    expect(eliteGrowth).toBeGreaterThan(healthGrowth);
    expect(healthGrowth).toBeLessThanOrEqual(NG_PLUS.healthCap);
  });

  it('never becomes mathematically impossible', () => {
    // The worst case the game can construct: last world, maximum cycles.
    const worst = worldDifficulty('peaks', 9999);
    expect(worst.healthScale).toBeLessThanOrEqual(1.75);
    expect(worst.hazardScale).toBeLessThanOrEqual(NG_PLUS.hazardCap);
    expect(worst.rangedShare).toBeLessThan(0.7);
    expect(worst.heavyShare).toBeLessThan(0.7);
  });

  it('leaves a hazard-free world hazard-free at every cycle', () => {
    for (let cycle = 0; cycle <= 12; cycle++) {
      expect(worldDifficulty('wilds', cycle).hazardScale, `cycle ${cycle}`).toBe(0);
      expect(worldDifficulty('depths', cycle).hazardScale, `cycle ${cycle}`).toBe(0);
    }
  });
});

// =====================================================================
//  Encounter composition
// =====================================================================

describe('encounter composition', () => {
  /** Fill an encounter to its budget and report what went into it. */
  function compose(world: WorldId, budget: number, cycles = 0, seed = 5): EnemyKind[] {
    const def = worldDef(world);
    const difficulty = worldDifficulty(world, cycles);
    const state = createComposition();
    const random = rng(seed);
    const placed: EnemyKind[] = [];
    let remaining = budget;
    for (let guard = 0; guard < 40 && remaining > 0; guard++) {
      const kind = chooseKind(
        def.enemies, state, budget, remaining, difficulty, def.signatureEnemy, random,
      );
      if (!kind) break;
      placed.push(kind);
      notePlacement(state, kind);
      remaining -= ENEMY_TYPES[kind].threat;
    }
    return placed;
  }

  it('only ever places creatures from the world roster', () => {
    for (const world of ALL) {
      for (const kind of compose(world, 10)) {
        expect(worldDef(world).enemies, `${world}/${kind}`).toContain(kind);
      }
    }
  });

  it('holds the ranged share under the world limit', () => {
    for (const world of ALL) {
      for (let seed = 1; seed <= 25; seed++) {
        const budget = 10;
        const placed = compose(world, budget, 0, seed);
        const ranged = placed.filter(isRanged)
          .reduce((sum, k) => sum + ENEMY_TYPES[k].threat, 0);
        const limit = budget * worldDifficulty(world).rangedShare;
        // One creature may always be placed even if it exceeds the share, so
        // the allowance is the limit plus the largest single ranged threat.
        const largest = Math.max(
          0,
          ...worldDef(world).enemies.filter(isRanged).map((k) => ENEMY_TYPES[k].threat),
        );
        expect(ranged, `${world} seed ${seed}`).toBeLessThanOrEqual(limit + largest + 0.01);
      }
    }
  });

  it('holds the heavy share under the world limit', () => {
    for (const world of ALL) {
      for (let seed = 1; seed <= 25; seed++) {
        const budget = 10;
        const placed = compose(world, budget, 0, seed);
        const heavy = placed.filter(isHeavy)
          .reduce((sum, k) => sum + ENEMY_TYPES[k].threat, 0);
        const largest = Math.max(
          0,
          ...worldDef(world).enemies.filter(isHeavy).map((k) => ENEMY_TYPES[k].threat),
        );
        const limit = budget * worldDifficulty(world).heavyShare;
        expect(heavy, `${world} seed ${seed}`).toBeLessThanOrEqual(limit + largest + 0.01);
      }
    }
  });

  it('never returns nothing when the roster has something affordable', () => {
    for (const world of ALL) {
      const def = worldDef(world);
      const state = createComposition();
      const kind = chooseKind(
        def.enemies, state, 8, 8, worldDifficulty(world), def.signatureEnemy, rng(3),
      );
      expect(kind, world).not.toBeNull();
    }
  });

  it('still places something when composition has closed every door', () => {
    // A state that has already spent the whole ranged and heavy allowance.
    const def = worldDef('ashen');
    const state = createComposition();
    for (let i = 0; i < 12; i++) notePlacement(state, def.signatureEnemy);
    const kind = chooseKind(
      def.enemies, state, 6, 6, worldDifficulty('ashen'), def.signatureEnemy, rng(9),
    );
    expect(kind).not.toBeNull();
  });

  it('favours the world signature often enough to be recognisable', () => {
    for (const world of ALL) {
      const def = worldDef(world);
      let signature = 0;
      let total = 0;
      for (let seed = 1; seed <= 60; seed++) {
        for (const kind of compose(world, 8, 0, seed)) {
          total += 1;
          if (kind === def.signatureEnemy) signature += 1;
        }
      }
      expect(total, world).toBeGreaterThan(0);
      expect(signature / total, world).toBeGreaterThan(0.1);
    }
  });

  it('reflects each world stated intent in what it actually places', () => {
    // The caldera really is the armour-and-ranged world; the ruins really are
    // not. Measured over many encounters rather than asserted in data.
    const heavyShareOf = (world: WorldId): number => {
      let heavy = 0;
      let total = 0;
      for (let seed = 1; seed <= 60; seed++) {
        for (const kind of compose(world, 9, 0, seed)) {
          total += ENEMY_TYPES[kind].threat;
          if (isHeavy(kind)) heavy += ENEMY_TYPES[kind].threat;
        }
      }
      return total > 0 ? heavy / total : 0;
    };
    expect(heavyShareOf('ashen')).toBeGreaterThan(heavyShareOf('wilds'));
  });

  it('refuses a creature that would break the share, and allows one that would not', () => {
    const difficulty = worldDifficulty('wilds');
    const state = createComposition();
    const ranged = worldDef('wilds').enemies.find(isRanged)!;
    // With the allowance spent, another ranged creature is refused.
    for (let i = 0; i < 8; i++) notePlacement(state, ranged);
    expect(allowsKind(state, ranged, 6, difficulty)).toBe(false);
    const melee = worldDef('wilds').enemies.find((k) => !isRanged(k) && !isHeavy(k))!;
    expect(allowsKind(state, melee, 6, difficulty)).toBe(true);
  });
});

// =====================================================================
//  Guardians
// =====================================================================

describe('guardians', () => {
  it('gives every world its own guardian identity', () => {
    const names = new Set(ALL.map((id) => GUARDIAN_PROFILES[id].name));
    expect(names.size).toBe(ALL.length);
    const shapes = new Set(ALL.map((id) => {
      const g = GUARDIAN_PROFILES[id];
      return `${g.healthScale}|${g.speedScale}|${g.telegraph}`;
    }));
    expect(shapes.size).toBe(ALL.length);
  });

  it('gives each fight a readable opening, an escalation and a peak', () => {
    for (const id of ALL) {
      const profile = GUARDIAN_PROFILES[id];
      expect(profile.phases.length, id).toBeGreaterThanOrEqual(3);
      // Thresholds descend, so the phases are reached in order.
      for (let i = 1; i < profile.phases.length; i++) {
        expect(profile.phases[i]!.below, `${id} phase ${i}`)
          .toBeLessThan(profile.phases[i - 1]!.below);
      }
      // Each escalation opens a real window on the creature.
      for (let i = 1; i < profile.phases.length; i++) {
        expect(profile.phases[i]!.recovery, `${id} phase ${i}`).toBeGreaterThan(0);
      }
      // And every phase says something, so the change is never silent.
      for (const phase of profile.phases) expect(phase.note.length, id).toBeGreaterThan(0);
    }
  });

  it('escalates by acting sooner, never by hiding the wind-up', () => {
    for (const id of ALL) {
      const profile = GUARDIAN_PROFILES[id];
      // Cadence tightens across the fight.
      for (let i = 1; i < profile.phases.length; i++) {
        expect(profile.phases[i]!.cadence, `${id} phase ${i}`)
          .toBeLessThan(profile.phases[i - 1]!.cadence);
      }
      // The telegraph multiplier never drops below a readable window: the
      // product of the guardian's own scale and any phase stays at or above 1.
      for (const phase of profile.phases) {
        expect(profile.telegraph * phase.telegraph, `${id}/${phase.note}`)
          .toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('makes the teaching guardian the most readable and the last the hardest', () => {
    expect(GUARDIAN_PROFILES.wilds.telegraph)
      .toBeGreaterThan(GUARDIAN_PROFILES.peaks.telegraph);
    expect(GUARDIAN_PROFILES.wilds.healthScale)
      .toBeLessThan(GUARDIAN_PROFILES.peaks.healthScale);
    expect(GUARDIAN_PROFILES.wilds.speedScale)
      .toBeLessThan(GUARDIAN_PROFILES.peaks.speedScale);
  });

  it('resolves the phase from the health remaining', () => {
    const profile = GUARDIAN_PROFILES.ashen;
    expect(phaseAt(profile, 1)).toBe(0);
    expect(phaseAt(profile, 0.8)).toBe(0);
    expect(phaseAt(profile, 0.6)).toBe(1);
    expect(phaseAt(profile, 0.25)).toBe(2);
    expect(phaseAt(profile, 0)).toBe(2);
    // Out-of-range input never escapes the phase list.
    expect(phaseAt(profile, -3)).toBe(profile.phases.length - 1);
    expect(phaseAt(profile, 99)).toBe(0);
  });

  it('never lets a guardian become an unkillable health bar', () => {
    const guardian = ENEMY_TYPES.guardian;
    for (const id of ALL) {
      for (let cycle = 0; cycle <= 12; cycle++) {
        const health = guardian.maxHealth * guardianHealthScale(id, cycle);
        // Even the worst case stays inside a fight a strong build can finish.
        expect(health, `${id}@${cycle}`).toBeLessThan(guardian.maxHealth * 2.1);
        expect(health, `${id}@${cycle}`).toBeGreaterThan(guardian.maxHealth * 0.5);
      }
    }
  });

  it('leaves every element viable against every guardian', () => {
    // The guardian is deliberately neutral: no element is resisted, so no
    // build can be locked out of the campaign's mandatory fights.
    for (const element of ['air', 'water', 'earth', 'fire'] as const) {
      expect(ENEMY_TYPES.guardian.resistance[element], element).toBe(1);
      expect(ENEMY_TYPES['boss-maw'].resistance[element], element).toBe(1);
    }
  });

  it('gives a guardian more than one attack to read', () => {
    expect(ENEMY_TYPES.guardian.attacks.length).toBeGreaterThanOrEqual(3);
    const shapes = new Set(ENEMY_TYPES.guardian.attacks.map((a) => a.shape));
    expect(shapes.size).toBeGreaterThanOrEqual(3);
  });
});

// =====================================================================
//  Transitions, post-game and persistence
// =====================================================================

describe('world transitions', () => {
  /** A save mid-campaign, with a build worth losing. */
  function midCampaign(): ReturnType<typeof createSave> {
    const save = createSave(4242, 'fire', 'normal', [128, 40, 128], {}, { berries: 2 });
    save.worldTheme = 'depths';
    save.checkpointWorld = 'depths';
    save.build = { 'any-hardy': 2, 'fire-split': 1, 'chest-double-damage': 1 };
    save.upgrades = 3;
    save.ultimateUnlocked = true;
    save.ultimateCharge = 71;
    save.depth = 12;
    save.newGamePlus = 1;
    save.worldsCompleted = ['wilds'];
    save.worldHearts = { wilds: true };
    return save;
  }

  it('carries the whole player across a transition', () => {
    const before = midCampaign();
    const after = validateSave(JSON.parse(JSON.stringify(before)));
    expect(after.ok).toBe(true);
    const data = after.data!;
    expect(data.affinity).toBe(before.affinity);
    expect(data.build).toEqual(before.build);
    expect(data.upgrades).toBe(before.upgrades);
    expect(data.ultimateUnlocked).toBe(true);
    expect(data.ultimateCharge).toBe(71);
    expect(data.newGamePlus).toBe(1);
    expect(data.worldsCompleted).toEqual(['wilds']);
    expect(data.items.berries).toBe(2);
  });

  it('never rerolls a valid affinity on load', () => {
    for (const affinity of ['air', 'water', 'earth', 'fire', 'convergence'] as const) {
      const save = createSave(7, affinity, 'normal', [128, 40, 128], {}, {});
      const result = validateSave(JSON.parse(JSON.stringify(save)));
      expect(result.ok, affinity).toBe(true);
      expect(result.data!.affinity, affinity).toBe(affinity);
    }
  });

  it('recovers the previous save from a snapshot after a failed transition', () => {
    // The rollback path re-validates the snapshot taken before the journey.
    const snapshot = JSON.stringify(midCampaign());
    const restored = validateSave(JSON.parse(snapshot));
    expect(restored.ok).toBe(true);
    expect(restored.data!.worldTheme).toBe('depths');
    expect(restored.data!.build).toEqual(midCampaign().build);
  });

  it('refuses a destination that is not a world', () => {
    expect(isWorldId('depths')).toBe(true);
    expect(isWorldId('')).toBe(false);
    expect(isWorldId(null)).toBe(false);
    expect(isWorldId('boss-maw')).toBe(false);
  });

  it('loads a save in every world without changing it', () => {
    for (const world of ALL) {
      const save = createSave(11, 'water', 'normal', [128, 40, 128], {}, {});
      save.worldTheme = world;
      save.checkpointWorld = world;
      const result = validateSave(JSON.parse(JSON.stringify(save)));
      expect(result.ok, world).toBe(true);
      expect(result.data!.worldTheme, world).toBe(world);
    }
  });

  it('keeps the run layer intact through a reload', () => {
    const run = new RunState();
    run.load({ affinity: 'earth', depth: 9, encounters: 4, worldTheme: 'ashen' });
    run.build.add('any-hardy');
    const json = run.toJSON();
    const reloaded = new RunState();
    reloaded.load({ ...json, affinity: 'earth' });
    expect(reloaded.worldTheme).toBe('ashen');
    expect(reloaded.depth).toBe(9);
    expect(reloaded.build.toJSON()).toEqual(json.build);
  });
});

describe('post-game and peaceful mode', () => {
  it('keeps post-game state and the build after the ending', () => {
    const save = createSave(3, 'air', 'normal', [128, 40, 128], {}, {});
    save.postGame = true;
    save.worldsCompleted = [...ALL];
    save.build = { 'any-honed': 3 };
    save.ultimateUnlocked = true;
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.data!.postGame).toBe(true);
    expect(result.data!.worldsCompleted).toEqual([...ALL]);
    expect(result.data!.build).toEqual({ 'any-honed': 3 });
    expect(result.data!.ultimateUnlocked).toBe(true);
  });

  it('keeps a peaceful save peaceful through a New Game Plus cycle', () => {
    const save = createSave(5, 'water', 'peaceful', [128, 40, 128], {}, {});
    // A cycle resets the worlds and nothing else.
    save.newGamePlus += 1;
    save.worldsCompleted = [];
    save.worldHearts = {};
    save.postGame = true;
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.data!.worldMode).toBe('peaceful');
    expect(result.data!.affinity).toBe('water');
    expect(result.data!.newGamePlus).toBe(1);
  });

  it('offers a non-combat path in every world', () => {
    // Peaceful Mode replaces guardians with the mote ritual, which is a
    // property of the shrine layer rather than of any one world - so no world
    // may declare itself combat-only.
    for (const world of ALL) {
      const def = worldDef(world);
      expect(def.scenarios.length, world).toBeGreaterThan(0);
      expect(def.heart.name.length, world).toBeGreaterThan(0);
    }
  });

  it('never spawns anything in Peaceful Mode, in any world at any cycle', () => {
    const peaceful: EncounterSignals = {
      liveEnemies: 0, engaged: false, healthFraction: 1, playing: true,
      playerReady: true, peaceful: true, scenarioDriven: false, locationPressure: 1,
    };
    for (const world of ALL) {
      for (const cycle of [0, NG_PLUS.maxCycles]) {
        const d = worldDifficulty(world, cycle);
        const encounter = new EncounterDirector();
        encounter.setDepth(50);
        encounter.setBudgetScale(d.budgetScale);
        for (let t = 0; t < 400; t += 0.5) {
          encounter.update(0.5, peaceful);
          expect(encounter.requestSpawn(peaceful, () => 0).allowed, `${world}@${cycle}`).toBe(false);
        }
      }
    }
  });
});

describe('save compatibility', () => {
  it('leaves the schema where the earlier passes left it', () => {
    expect(SAVE_VERSION).toBe(5);
  });

  it('defaults world progress safely when it is missing', () => {
    const save = createSave(9, 'fire', 'normal', [128, 40, 128], {}, {}) as unknown as
      Record<string, unknown>;
    delete save.worldsCompleted;
    delete save.worldHearts;
    delete save.newGamePlus;
    delete save.postGame;
    const result = validateSave(save);
    expect(result.ok).toBe(true);
    expect(result.data!.newGamePlus).toBe(0);
    expect(result.data!.postGame).toBe(false);
    expect(Array.isArray(result.data!.worldsCompleted)).toBe(true);
    // The affinity survives a payload with holes in it.
    expect(result.data!.affinity).toBe('fire');
  });

  it('falls back to a real world when the stored theme is nonsense', () => {
    const save = createSave(9, 'fire', 'normal', [128, 40, 128], {}, {}) as unknown as
      Record<string, unknown>;
    save.worldTheme = 'atlantis';
    const result = validateSave(save);
    expect(result.ok).toBe(true);
    expect(ALL).toContain(result.data!.worldTheme);
  });

  it('clamps an out-of-range New Game Plus count rather than trusting it', () => {
    const save = createSave(9, 'fire', 'normal', [128, 40, 128], {}, {}) as unknown as
      Record<string, unknown>;
    save.newGamePlus = 1e9;
    const result = validateSave(save);
    expect(result.data!.newGamePlus).toBeLessThanOrEqual(999);
    // And the scaling clamps whatever survives validation.
    expect(ngCycles(result.data!.newGamePlus)).toBeLessThanOrEqual(NG_PLUS.maxCycles);
  });

  it('keeps world index and order stable, since saves store the theme by id', () => {
    expect(worldIndex('wilds')).toBe(1);
    expect(worldIndex('peaks')).toBe(4);
    expect([...WORLD_ORDER]).toEqual(['wilds', 'depths', 'ashen', 'peaks']);
  });
});
