import { describe, expect, it } from 'vitest';
import { BuildState } from '../src/progression/BuildState';
import {
  CHEST_BUFFS, chestRarityFromRoll, chestRarityWeight, rollChestOutcome, rollChestRarity,
} from '../src/progression/chests';
import {
  BASE_MODIFIERS, CHEST_ONLY_UPGRADES, REWARD_UPGRADES, SAFE_MINIMUMS, UPGRADES,
  accumulateStats, clampStats, describeStat, describeUpgrade, upgradeById,
  type StatModifiers,
} from '../src/progression/upgrades';
import { previewOffer } from '../src/progression/rewards';
import { BuffTracker, combineModifiers } from '../src/progression/buffs';
import {
  COMBO_THRESHOLD, DAMAGE_TAKEN_CAP, ULTIMATE_LOCKOUT, ULTIMATE_MAX,
  addCharge, consumeUltimate, createUltimateState, isUltimateReady, registerComboHit,
  sanitiseCharge, tickUltimate, ultimateDenial, ultimateFraction,
} from '../src/progression/ultimate';
import {
  CAST_PAUSE, FALLBACK_POWER, LOW_MANA_FRACTION, OUT_OF_COMBAT_DELAY,
  absorbPickup, createManaState, grantFreeCast, isFreeCast, manaFeedback, notifyCast,
  onAffinityTerrain, resolvePrimaryCost, tickMana,
} from '../src/progression/mana';
import {
  BASE_OXYGEN, DROWN_INTERVAL, WATER_DRAIN_SCALE, createOxygenState, sanitiseOxygen,
  swimSpeedScale, tickOxygen,
} from '../src/player/oxygen';
import { MAX_DEFORM_RADIUS, MAX_ZONES, TerrainEffects } from '../src/world/deformation';
import { STORY_BEATS, StoryProgress, beatFor, loreFragmentFor } from '../src/game/story';
import { WORLDS, WORLD_ORDER, nextWorld, worldDef, worldIndex } from '../src/world/worlds';
import { ELEMENTS, ELEMENT_ORDER, abilitiesOf, abilityForSlot } from '../src/elements/elements';
import { ABILITY_COMBAT, abilityCombat } from '../src/combat/combatConfig';
import { ENEMY_TYPES, ENEMY_KINDS } from '../src/combat/enemyTypes';

const UNLOCKED = new Set<string>();
const seq = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

// =====================================================================
//  Chests
// =====================================================================

describe('chest rewards', () => {
  it('never returns nothing', () => {
    const build = new BuildState();
    for (let i = 0; i < 200; i++) {
      const outcome = rollChestOutcome(build, {
        elements: ['fire'], unlocked: UNLOCKED, depth: i % 20,
        maxHealth: 100, maxMana: 100,
      }, seq([i / 200]));
      expect(outcome.name.length).toBeGreaterThan(0);
      expect(outcome.benefits.length + outcome.penalties.length).toBeGreaterThan(0);
      expect(['upgrade', 'blessing', 'recovery']).toContain(outcome.kind);
    }
  });

  it('falls back to a blessing or recovery when the upgrade pool is exhausted', () => {
    const build = new BuildState();
    // Take every legendary chest upgrade so the legendary pool is empty.
    for (const def of CHEST_ONLY_UPGRADES.filter((d) => d.rarity === 'legendary')) {
      for (let i = 0; i < def.maxStacks; i++) build.add(def.id);
    }
    const outcome = rollChestOutcome(build, {
      elements: ['fire'], unlocked: UNLOCKED, depth: 0, maxHealth: 200, maxMana: 150,
    }, seq([0.5]), 'legendary');
    expect(outcome.kind).not.toBe('upgrade');
    expect(outcome.rarity).toBe('legendary');
  });

  it('states permanence and exact numbers', () => {
    const outcome = rollChestOutcome(new BuildState(), {
      elements: ['fire'], unlocked: UNLOCKED, depth: 0, maxHealth: 100, maxMana: 100,
    }, seq([0]), 'legendary');
    expect(['save', 'temporary']).toContain(outcome.permanence);
    for (const line of [...outcome.benefits, ...outcome.penalties]) {
      expect(line.text).toMatch(/\d/);
    }
  });

  it('offers Double Damage only as a legendary, with a stated downside', () => {
    const def = upgradeById('chest-double-damage')!;
    expect(def.rarity).toBe('legendary');
    expect(def.source).toBe('chest');
    expect(def.maxStacks).toBe(1);
    expect(def.stats?.damageScale).toBe(2);
    const { benefits, penalties } = describeUpgrade(def, 1);
    expect(benefits.some((l) => /damage/i.test(l.text))).toBe(true);
    expect(penalties.length).toBeGreaterThan(0);
    expect(penalties.some((l) => /Mana/.test(l.text))).toBe(true);
  });

  it('never lets Double Damage stack', () => {
    const build = new BuildState();
    expect(build.add('chest-double-damage')).toBe(true);
    expect(build.add('chest-double-damage')).toBe(false);
    expect(build.stacksOf('chest-double-damage')).toBe(1);
  });

  it('applies Double Damage as a real x2 multiplier', () => {
    const build = new BuildState();
    build.add('chest-double-damage');
    expect(build.modifiers.damageScale).toBeCloseTo(2, 5);
    expect(build.modifiers.maxEnergyScale).toBeCloseTo(0.75, 5);
    expect(build.hasGrant('double-damage')).toBe(true);
  });

  it('keeps chest rewards out of the selection-card pool', () => {
    expect(REWARD_UPGRADES.some((d) => d.source === 'chest')).toBe(false);
    expect(CHEST_ONLY_UPGRADES.every((d) => d.source === 'chest')).toBe(true);
    expect(CHEST_ONLY_UPGRADES.length).toBeGreaterThan(8);
  });

  it('weights rarity so legendary stays rare but reachable', () => {
    expect(chestRarityWeight('legendary', 0)).toBeLessThan(chestRarityWeight('common', 0));
    expect(chestRarityWeight('legendary', 20)).toBeGreaterThan(chestRarityWeight('legendary', 0));
    const rarities = new Set<string>();
    for (let i = 0; i < 400; i++) rarities.add(rollChestRarity(10, 0, seq([i / 400])));
    expect(rarities.size).toBeGreaterThan(2);
  });

  it('derives a stable chest rarity from a deterministic roll', () => {
    expect(chestRarityFromRoll(0.01)).toBe('legendary');
    expect(chestRarityFromRoll(0.99)).toBe('common');
    expect(chestRarityFromRoll(0.5)).toBe(chestRarityFromRoll(0.5));
  });
});

// =====================================================================
//  Tradeoffs and reward cards
// =====================================================================

describe('tradeoff rewards', () => {
  const tradeoffs = UPGRADES.filter((u) => u.tradeoff);

  it('provides a broad set of risk/reward choices', () => {
    expect(tradeoffs.length).toBeGreaterThanOrEqual(12);
  });

  it('every tradeoff shows both a benefit and a penalty', () => {
    for (const def of tradeoffs) {
      const { benefits, penalties } = describeUpgrade(def, 1);
      expect(benefits.length, `${def.id} benefits`).toBeGreaterThan(0);
      expect(penalties.length, `${def.id} penalties`).toBeGreaterThan(0);
    }
  });

  it('describes effects with exact numbers, never vaguely', () => {
    for (const def of tradeoffs) {
      expect(def.description).toMatch(/\d/);
      expect(def.description).not.toMatch(/become stronger/i);
    }
  });

  it('computes Glass Cannon exactly as advertised', () => {
    const build = new BuildState();
    build.add('trade-glass-cannon');
    expect(build.modifiers.damageScale).toBeCloseTo(2, 5);
    expect(build.modifiers.maxHealthScale).toBeCloseTo(0.7, 5);
  });

  it('blocks incompatible combinations in both directions', () => {
    const a = new BuildState();
    a.add('trade-glass-cannon');
    expect(a.canOffer(upgradeById('chest-double-damage')!, ['fire'], UNLOCKED)).toBe(false);

    const b = new BuildState();
    b.add('chest-double-damage');
    expect(b.canOffer(upgradeById('trade-glass-cannon')!, ['fire'], UNLOCKED)).toBe(false);

    const c = new BuildState();
    c.add('trade-swift-well');
    expect(c.canOffer(upgradeById('trade-deep-reserve')!, ['fire'], UNLOCKED)).toBe(false);
  });

  it('never reduces a critical value below its safe minimum', () => {
    const stats: StatModifiers = { ...BASE_MODIFIERS };
    // Pile on every penalty the registry has, many times over.
    for (const def of UPGRADES) accumulateStats(stats, def, 6);
    clampStats(stats);
    expect(stats.maxHealthScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.maxHealthScale);
    expect(stats.maxEnergyScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.maxEnergyScale);
    expect(stats.regenScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.regenScale);
    expect(stats.rangeScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.rangeScale);
    expect(stats.normalHitScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.normalHitScale);
    expect(stats.sprintScale).toBeGreaterThanOrEqual(SAFE_MINIMUMS.sprintScale);
    expect(stats.ultimateGain).toBeGreaterThanOrEqual(SAFE_MINIMUMS.ultimateGain);
    expect(stats.moveScale).toBeGreaterThanOrEqual(0.5);
  });

  it('produces a before/after preview for a card', () => {
    const build = new BuildState();
    const preview = previewOffer(build, upgradeById('trade-glass-cannon')!);
    expect(preview.penalties.length).toBeGreaterThan(0);
    expect(preview.deltas.length).toBeGreaterThan(0);
    const damage = preview.deltas.find((d) => d.label === 'Damage');
    expect(damage).toBeDefined();
    expect(damage!.before).toBe('×1.00');
    expect(damage!.after).toBe('×2.00');
    expect(preview.warning).toBeTruthy();
  });

  it('formats stat lines with the right sign and tone', () => {
    expect(describeStat('damageScale', 1.12, 1)).toEqual({ text: 'All elemental damage +12%', tone: 'good' });
    expect(describeStat('cooldownScale', 0.9, 1)).toEqual({ text: 'Cooldowns −10%', tone: 'good' });
    expect(describeStat('maxHealthScale', 0.7, 1)).toEqual({ text: 'Maximum health −30%', tone: 'bad' });
    expect(describeStat('maxHealth', 25, 2)).toEqual({ text: 'Maximum health +50', tone: 'good' });
  });
});

// =====================================================================
//  Single-element depth
// =====================================================================

describe('single-element progression', () => {
  it('gives every element four active abilities', () => {
    for (const id of ELEMENT_ORDER) {
      const abilities = abilitiesOf(id);
      expect(abilities).toHaveLength(4);
      expect(new Set(abilities.map((a) => a.id)).size).toBe(4);
      expect(abilityForSlot(id, 'technique').slot).toBe('technique');
      expect(abilityForSlot(id, 'ultimate').slot).toBe('ultimate');
    }
  });

  it('costs Mana for every slot except the Ultimate', () => {
    for (const id of ELEMENT_ORDER) {
      expect(ELEMENTS[id].primary.cost).toBeGreaterThan(0);
      expect(ELEMENTS[id].secondary.cost).toBeGreaterThan(0);
      expect(ELEMENTS[id].technique.cost).toBeGreaterThan(0);
      expect(ELEMENTS[id].ultimate.cost).toBe(0);
    }
  });

  it('escalates cost from primary to technique', () => {
    for (const id of ELEMENT_ORDER) {
      expect(ELEMENTS[id].technique.cost).toBeGreaterThan(ELEMENTS[id].primary.cost);
    }
  });

  it('declares three build directions per element', () => {
    for (const id of ELEMENT_ORDER) {
      expect(ELEMENTS[id].buildPaths.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('offers enough upgrades per element to support them', () => {
    for (const id of ELEMENT_ORDER) {
      const count = REWARD_UPGRADES.filter((u) => u.element === id).length;
      expect(count, id).toBeGreaterThanOrEqual(10);
    }
  });

  it('gives every element an ability mutation', () => {
    for (const id of ELEMENT_ORDER) {
      expect(UPGRADES.some((u) => u.element === id && u.tags.includes('mutation')), id).toBe(true);
    }
  });

  it('tunes every new ability in the combat config', () => {
    for (const id of ELEMENT_ORDER) {
      for (const ability of abilitiesOf(id)) {
        expect(ABILITY_COMBAT[ability.id], ability.id).toBeDefined();
        const cfg = abilityCombat(ability.id);
        expect(cfg.range).toBeGreaterThan(0);
      }
    }
  });

  it('binds the ultimate to the middle mouse button and R, never the wheel', () => {
    for (const id of ELEMENT_ORDER) {
      expect(ELEMENTS[id].ultimate.input).toContain('MMB');
      expect(ELEMENTS[id].ultimate.input).toContain('R');
      expect(ELEMENTS[id].ultimate.input.toLowerCase()).not.toContain('wheel');
    }
  });
});

// =====================================================================
//  Ultimate meter
// =====================================================================

describe('ultimate charge', () => {
  it('does not charge while locked', () => {
    const state = createUltimateState(false);
    expect(addCharge(state, 'damage-dealt', 500)).toBe(0);
    expect(state.charge).toBe(0);
  });

  it('charges from damage dealt and defeating creatures', () => {
    const state = createUltimateState(true);
    addCharge(state, 'damage-dealt', 100);
    expect(state.charge).toBeGreaterThan(0);
    const afterDamage = state.charge;
    addCharge(state, 'enemy-defeated');
    expect(state.charge).toBeGreaterThan(afterDamage);
  });

  it('charges from status, deflection, shatter and terrain use', () => {
    for (const source of ['status-applied', 'deflect', 'shatter', 'terrain'] as const) {
      const state = createUltimateState(true);
      addCharge(state, source);
      expect(state.charge, source).toBeGreaterThan(0);
    }
  });

  it('caps how much taking damage can contribute', () => {
    const state = createUltimateState(true);
    for (let i = 0; i < 200; i++) addCharge(state, 'damage-taken', 30);
    expect(state.fromDamageTaken).toBeLessThanOrEqual(DAMAGE_TAKEN_CAP + 0.001);
    expect(state.charge).toBeLessThan(ULTIMATE_MAX);
  });

  it('only pays combo charge once a real combo is running', () => {
    const state = createUltimateState(true);
    expect(addCharge(state, 'combo')).toBe(0);
    for (let i = 0; i < COMBO_THRESHOLD; i++) registerComboHit(state);
    expect(addCharge(state, 'combo')).toBeGreaterThan(0);
  });

  it('expires the combo window', () => {
    const state = createUltimateState(true);
    for (let i = 0; i < COMBO_THRESHOLD; i++) registerComboHit(state);
    tickUltimate(state, 5);
    expect(state.comboCount).toBe(0);
  });

  it('requires a full meter, spends all of it, and cannot be spammed', () => {
    const state = createUltimateState(true);
    expect(isUltimateReady(state)).toBe(false);
    expect(ultimateDenial(state)).toBe('charging');

    addCharge(state, 'damage-dealt', 100000);
    expect(state.charge).toBe(ULTIMATE_MAX);
    expect(isUltimateReady(state)).toBe(true);
    expect(ultimateDenial(state)).toBeNull();

    expect(consumeUltimate(state)).toBe(true);
    expect(state.charge).toBe(0);
    expect(state.lockout).toBe(ULTIMATE_LOCKOUT);

    // Even refilled instantly, the lockout blocks a second cast.
    addCharge(state, 'damage-dealt', 100000);
    expect(ultimateDenial(state)).toBe('cooldown');
    expect(consumeUltimate(state)).toBe(false);

    tickUltimate(state, ULTIMATE_LOCKOUT + 0.1);
    expect(isUltimateReady(state)).toBe(true);
  });

  it('signals the moment the meter becomes full', () => {
    const state = createUltimateState(true);
    addCharge(state, 'damage-dealt', 100000);
    expect(state.justReady).toBe(true);
    tickUltimate(state, 0.016);
    expect(state.justReady).toBe(false);
  });

  it('scales with the build charge-rate modifier', () => {
    const fast = createUltimateState(true);
    const slow = createUltimateState(true);
    addCharge(fast, 'damage-dealt', 100, 1.5);
    addCharge(slow, 'damage-dealt', 100, 0.65);
    expect(fast.charge).toBeGreaterThan(slow.charge);
  });

  it('reports a clamped fraction and sanitises a loaded charge', () => {
    const state = createUltimateState(true);
    state.charge = ULTIMATE_MAX;
    expect(ultimateFraction(state)).toBe(1);
    expect(sanitiseCharge(-5)).toBe(0);
    expect(sanitiseCharge(9999)).toBe(ULTIMATE_MAX);
    expect(sanitiseCharge('nonsense')).toBe(0);
  });
});

// =====================================================================
//  Mana
// =====================================================================

describe('mana economy', () => {
  const ctx = (overrides: Partial<Parameters<typeof tickMana>[2]> = {}) => ({
    maxMana: 100, baseRegen: 10, inCombat: false,
    element: 'fire' as const, onAffinityTerrain: false, ...overrides,
  });

  it('regenerates more slowly in combat than out of it', () => {
    const inFight = createManaState();
    const resting = createManaState();
    resting.sinceCombat = 99;
    const a = tickMana(inFight, 1, ctx({ inCombat: true }));
    const b = tickMana(resting, 1, ctx({ inCombat: false }));
    expect(b.regen).toBeGreaterThan(a.regen);
    expect(a.regen).toBeGreaterThan(0);
  });

  it('waits a short lull before the faster regeneration', () => {
    const state = createManaState();
    tickMana(state, 0.1, ctx({ inCombat: true }));
    expect(tickMana(state, 1, ctx()).resting).toBe(false);
    tickMana(state, OUT_OF_COMBAT_DELAY, ctx());
    expect(tickMana(state, 0.1, ctx()).resting).toBe(true);
  });

  it('pauses regeneration briefly after an expensive cast', () => {
    const state = createManaState();
    notifyCast(state, 40, 100);
    expect(tickMana(state, 0.1, ctx()).paused).toBe(true);
    tickMana(state, CAST_PAUSE, ctx());
    expect(tickMana(state, 0.1, ctx()).paused).toBe(false);
  });

  it('does not pause after a cheap cast', () => {
    const state = createManaState();
    notifyCast(state, 5, 100);
    expect(tickMana(state, 0.1, ctx()).paused).toBe(false);
  });

  it('gives the primary attack a low-cost fallback so the player is never stuck', () => {
    const full = resolvePrimaryCost(20, 100, 100, false);
    expect(full).toEqual({ cost: 20, power: 1, weakened: false });

    const weak = resolvePrimaryCost(20, 6, 100, false);
    expect(weak).not.toBeNull();
    expect(weak!.weakened).toBe(true);
    expect(weak!.power).toBe(FALLBACK_POWER);
    expect(weak!.cost).toBeLessThan(20);

    // Completely empty is the only case that refuses.
    expect(resolvePrimaryCost(20, 0, 100, false)).toBeNull();
  });

  it('charges nothing during a free cast', () => {
    const state = createManaState();
    grantFreeCast(state, 5);
    expect(isFreeCast(state)).toBe(true);
    expect(resolvePrimaryCost(30, 0, 100, true)).toEqual({ cost: 0, power: 1, weakened: false });
    tickMana(state, 6, ctx());
    expect(isFreeCast(state)).toBe(false);
  });

  it('banks excess pickups instead of wasting them', () => {
    const state = createManaState();
    const result = absorbPickup(state, 40, 90, 100);
    expect(result.mana).toBe(10);
    expect(result.overflow).toBe(30);
    expect(state.overflow).toBeGreaterThan(0);
  });

  it('boosts regeneration on the element’s own terrain', () => {
    const state = createManaState();
    const plain = tickMana(createManaState(), 1, ctx());
    const boosted = tickMana(state, 1, ctx({ onAffinityTerrain: true }));
    expect(boosted.terrainBonus).toBeGreaterThan(0);
    expect(boosted.regen).toBeGreaterThan(plain.regen);
  });

  it('matches each element to its own terrain', () => {
    const probe = { nearWater: true, onStone: false, nearFire: false, airborneOrFast: false };
    expect(onAffinityTerrain('water', probe)).toBe(true);
    expect(onAffinityTerrain('earth', probe)).toBe(false);
    expect(onAffinityTerrain('earth', { ...probe, nearWater: false, onStone: true })).toBe(true);
    expect(onAffinityTerrain('fire', { ...probe, nearWater: false, nearFire: true })).toBe(true);
    expect(onAffinityTerrain('air', { ...probe, nearWater: false, airborneOrFast: true })).toBe(true);
  });

  it('reports the right HUD feedback state', () => {
    const state = createManaState();
    // Fresh state counts as long out of combat, so start from a fight.
    tickMana(state, 0.1, ctx({ inCombat: true }));
    const tick = tickMana(state, 0.1, ctx({ inCombat: true }));
    expect(manaFeedback(100, 100, tick, state)).toBe('normal');
    expect(manaFeedback(LOW_MANA_FRACTION * 100 - 1, 100, tick, state)).toBe('low');
    expect(manaFeedback(0, 100, tick, state)).toBe('empty');
    notifyCast(state, 50, 100);
    expect(manaFeedback(50, 100, tickMana(state, 0.05, ctx()), state)).toBe('paused');
  });
});

// =====================================================================
//  Oxygen
// =====================================================================

describe('oxygen and drowning', () => {
  const ctx = (overrides = {}) => ({
    headSubmerged: true, inAirPocket: false, element: 'fire' as const,
    bonusCapacity: 0, drainScale: 1, maxHealth: 100, ...overrides,
  });

  it('drains only while the head is submerged', () => {
    const state = createOxygenState();
    tickOxygen(state, 3, ctx());
    expect(state.oxygen).toBeLessThan(BASE_OXYGEN);
    const drained = state.oxygen;
    tickOxygen(state, 1, ctx({ headSubmerged: false }));
    expect(state.oxygen).toBeGreaterThan(drained);
  });

  it('treats an air pocket as breathable', () => {
    const state = createOxygenState();
    tickOxygen(state, 5, ctx());
    const before = state.oxygen;
    tickOxygen(state, 1, ctx({ inAirPocket: true }));
    expect(state.oxygen).toBeGreaterThan(before);
  });

  it('does not kill outright when the air runs out', () => {
    const state = createOxygenState();
    const drain = tickOxygen(state, BASE_OXYGEN + 1, ctx());
    expect(state.oxygen).toBe(0);
    expect(drain.justEmptied).toBe(true);
    // The first tick of drowning damage is a fraction of health, not all of it.
    const hit = tickOxygen(state, DROWN_INTERVAL, ctx());
    expect(hit.damage).toBeGreaterThan(0);
    expect(hit.damage).toBeLessThan(20);
  });

  it('applies drowning damage periodically, not every frame', () => {
    const state = createOxygenState();
    tickOxygen(state, BASE_OXYGEN + 1, ctx());
    let ticks = 0;
    for (let i = 0; i < 60; i++) {
      if (tickOxygen(state, 1 / 60, ctx()).damage > 0) ticks++;
    }
    expect(ticks).toBeLessThanOrEqual(1);
  });

  it('gives Water slower drain but never unlimited air', () => {
    const water = createOxygenState();
    const other = createOxygenState();
    tickOxygen(water, 5, ctx({ element: 'water' }));
    tickOxygen(other, 5, ctx({ element: 'fire' }));
    expect(water.oxygen).toBeGreaterThan(other.oxygen);
    expect(WATER_DRAIN_SCALE).toBeGreaterThan(0);
    tickOxygen(water, 500, ctx({ element: 'water' }));
    expect(water.oxygen).toBe(0);
  });

  it('gives Water faster swimming', () => {
    expect(swimSpeedScale('water')).toBeGreaterThan(swimSpeedScale('air'));
  });

  it('grows the lung capacity from upgrades, keeping the fill ratio', () => {
    const state = createOxygenState();
    tickOxygen(state, 5, ctx());
    const ratioBefore = state.oxygen / state.maxOxygen;
    tickOxygen(state, 0.001, ctx({ bonusCapacity: 20 }));
    expect(state.maxOxygen).toBeCloseTo(BASE_OXYGEN + 20, 5);
    expect(state.oxygen / state.maxOxygen).toBeCloseTo(ratioBefore, 2);
  });

  it('never loads the player into an unavoidable drowning', () => {
    expect(sanitiseOxygen(0)).toBeGreaterThan(BASE_OXYGEN * 0.3);
    expect(sanitiseOxygen(-100)).toBeGreaterThan(0);
    expect(sanitiseOxygen(9999)).toBeLessThanOrEqual(BASE_OXYGEN);
  });
});

// =====================================================================
//  Terrain deformation
// =====================================================================

/** A minimal world stub with a protected region around the origin. */
function stubWorld(protectedRadius = 0): { world: any; edits: unknown[] } {
  const edits: unknown[] = [];
  const world = {
    isProtected: (x: number, _y: number, z: number) => Math.hypot(x, z) < protectedRadius,
    addTemporary: (op: unknown) => { edits.push(op); return true; },
    groundHeight: () => 20,
    fluidLevel: 18,
  };
  return { world, edits };
}

describe('terrain deformation', () => {
  it('refuses to deform protected ground', () => {
    const { world, edits } = stubWorld(10);
    const effects = new TerrainEffects(world);
    expect(effects.deform(0, 20, 0, 3, -2, 2, 10).reason).toBe('protected');
    expect(edits).toHaveLength(0);
    expect(effects.deform(40, 20, 40, 3, -2, 2, 10).applied).toBe(true);
  });

  it('clamps deformation size', () => {
    const { world, edits } = stubWorld();
    const effects = new TerrainEffects(world);
    effects.deform(0, 20, 0, 999, -2, 2, 10);
    expect((edits[0] as { radius: number }).radius).toBeLessThanOrEqual(MAX_DEFORM_RADIUS);
  });

  it('water puts out burning ground and fire dries wet ground', () => {
    const { world } = stubWorld();
    const effects = new TerrainEffects(world);
    effects.add('burning', 0, 20, 0, 4, 10, 5);
    expect(effects.damageAt(0, 20, 0)).toBeGreaterThan(0);
    effects.add('wet', 0, 20, 0, 4, 10, 0);
    expect(effects.damageAt(0, 20, 0)).toBe(0);

    effects.add('burning', 0, 20, 0, 4, 10, 5);
    expect(effects.list.filter((z) => z.kind === 'wet')).toHaveLength(0);
  });

  it('fire melts ice', () => {
    const { world } = stubWorld();
    const effects = new TerrainEffects(world);
    effects.add('ice', 0, 20, 0, 4, 20);
    expect(effects.slipperyAt(0, 20, 0)).toBe(true);
    effects.add('burning', 0, 20, 0, 4, 10, 5);
    expect(effects.slipperyAt(0, 20, 0)).toBe(false);
  });

  it('air clears smoke and spreads fire', () => {
    const { world } = stubWorld();
    const effects = new TerrainEffects(world);
    effects.add('smoke', 0, 20, 0, 5, 10);
    expect(effects.obscuredAt(0, 20, 0)).toBe(true);
    expect(effects.clearObscurants(0, 0, 8)).toBe(1);
    expect(effects.obscuredAt(0, 20, 0)).toBe(false);

    const fire = effects.add('burning', 0, 20, 0, 3, 10, 4)!;
    const beforeRadius = fire.radius;
    expect(effects.fanFlames(0, 0, 8)).toBe(1);
    expect(fire.radius).toBeGreaterThan(beforeRadius);
  });

  it('water on lava leaves temporary stone and steam', () => {
    const { world, edits } = stubWorld();
    const effects = new TerrainEffects(world);
    expect(effects.quenchLava(0, 0, 18, 3)).toBe(true);
    expect(edits).toHaveLength(1);
    expect(effects.list.some((z) => z.kind === 'steam')).toBe(true);
  });

  it('cleans temporary effects up on a timer', () => {
    const { world } = stubWorld();
    const effects = new TerrainEffects(world);
    effects.add('burning', 0, 20, 0, 3, 2, 5);
    expect(effects.count).toBe(1);
    expect(effects.tick(3)).toHaveLength(1);
    expect(effects.count).toBe(0);
  });

  it('caps how many zones can be live at once', () => {
    const { world } = stubWorld();
    const effects = new TerrainEffects(world);
    for (let i = 0; i < MAX_ZONES * 3; i++) effects.add('burning', i * 30, 20, i * 30, 2, 60, 1);
    expect(effects.count).toBeLessThanOrEqual(MAX_ZONES);
  });

  it('raises real cover for Earth', () => {
    const { world, edits } = stubWorld();
    const effects = new TerrainEffects(world);
    expect(effects.raiseCover(0, 20, 0, 0, 1, 5, 10)).toBeGreaterThan(0);
    expect(edits.length).toBeGreaterThan(0);
  });
});

// =====================================================================
//  Story and worlds
// =====================================================================

describe('story', () => {
  it('covers every required beat', () => {
    for (const trigger of ['opening', 'world-intro', 'guardian-defeated', 'world-transition', 'final-reveal', 'post-game'] as const) {
      expect(STORY_BEATS.some((b) => b.trigger === trigger), trigger).toBe(true);
    }
  });

  it('introduces every world and previews every boss', () => {
    for (const id of WORLD_ORDER) {
      expect(beatFor('world-intro', id), id).not.toBeNull();
      expect(beatFor('pre-boss', id), id).not.toBeNull();
    }
  });

  it('keeps sequences short', () => {
    for (const beat of STORY_BEATS) {
      expect(beat.lines.length, beat.id).toBeLessThanOrEqual(6);
      expect(beat.seconds, beat.id).toBeLessThanOrEqual(15);
    }
  });

  it('plays a beat once and marks it skippable afterwards', () => {
    const progress = new StoryProgress();
    const first = progress.pending('opening');
    expect(first).not.toBeNull();
    progress.markSeen(first!.id);
    expect(progress.pending('opening')).toBeNull();
    expect(progress.skippable(first!.id)).toBe(true);
    expect(progress.pending('opening', undefined, true)).not.toBeNull();
  });

  it('round-trips through the save', () => {
    const progress = new StoryProgress();
    progress.markSeen('opening');
    progress.markSeen('not-a-real-beat');
    const json = progress.toJSON();
    const restored = new StoryProgress();
    restored.load([...json, 'also-not-real']);
    expect(restored.has('opening')).toBe(true);
    expect(restored.size).toBe(1);
  });

  it('offers discoverable lore fragments', () => {
    expect(STORY_BEATS.filter((b) => b.trigger === 'lore').length).toBeGreaterThanOrEqual(3);
    expect(loreFragmentFor(0).trigger).toBe('lore');
    expect(loreFragmentFor(99).trigger).toBe('lore');
  });
});

describe('worlds', () => {
  it('defines four structurally different worlds', () => {
    expect(WORLD_ORDER).toHaveLength(4);
    const seaLevels = new Set(WORLD_ORDER.map((id) => WORLDS[id].seaLevel));
    const baseHeights = new Set(WORLD_ORDER.map((id) => WORLDS[id].terrain.baseHeight));
    expect(seaLevels.size).toBeGreaterThan(2);
    expect(baseHeights.size).toBeGreaterThan(2);
  });

  it('gives each world its own hazard, weather, structures and roster', () => {
    const rosters = new Set<string>();
    for (const id of WORLD_ORDER) {
      const def = WORLDS[id];
      expect(def.structures.length, id).toBeGreaterThanOrEqual(4);
      expect(def.enemies.length, id).toBeGreaterThanOrEqual(4);
      expect(def.heart.name.length, id).toBeGreaterThan(0);
      expect(def.portal.length, id).toBeGreaterThan(0);
      rosters.add(def.enemies.join(','));
    }
    expect(rosters.size).toBe(4);
  });

  it('makes only the Ember Caldera lethal to swim in', () => {
    expect(WORLDS.ashen.seaHazard).toBe(true);
    expect(WORLDS.ashen.hazard.kind).toBe('lava');
    expect(WORLDS.ashen.hazard.contactDamage).toBeGreaterThan(0);
    expect(WORLDS.ashen.hazard.warningBand).toBeGreaterThan(0);
    for (const id of ['wilds', 'depths', 'peaks'] as const) {
      expect(WORLDS[id].seaHazard, id).toBe(false);
    }
  });

  it('gives the Tidal Archipelago real water without drowning the whole world', () => {
    expect(WORLDS.depths.terrain.islands).toBeGreaterThan(0);
    expect(WORLDS.depths.terrain.submergence).toBeLessThan(1);
    expect(WORLDS.depths.seaLevel).toBeGreaterThan(WORLDS.wilds.seaLevel);
  });

  it('makes only the Frozen Expanse slippery', () => {
    expect(WORLDS.peaks.slippery).toBe(true);
    expect(WORLDS.wilds.slippery).toBe(false);
  });

  it('orders the campaign and knows what follows each world', () => {
    expect(worldIndex('wilds')).toBe(1);
    expect(nextWorld('wilds')).toBe(WORLD_ORDER[1]);
    expect(nextWorld(WORLD_ORDER[3]!)).toBeNull();
    expect(worldDef('ashen').name).toBe('Ember Caldera');
  });
});

// =====================================================================
//  Monsters
// =====================================================================

describe('redesigned monsters', () => {
  it('gives every world roster distinct creatures', () => {
    for (const id of WORLD_ORDER) {
      for (const kind of WORLDS[id].enemies) {
        expect(ENEMY_TYPES[kind], `${id}:${kind}`).toBeDefined();
      }
    }
  });

  it('uses several different body plans, not one recoloured model', () => {
    const plans = new Set(ENEMY_KINDS.map((k) => ENEMY_TYPES[k].bodyPlan ?? 'default'));
    expect(plans.size).toBeGreaterThanOrEqual(6);
  });

  it('gives the new creatures weak points worth aiming at', () => {
    const withWeakPoints = ENEMY_KINDS.filter((k) => (ENEMY_TYPES[k].weakPointMultiplier ?? 1) > 1);
    expect(withWeakPoints.length).toBeGreaterThanOrEqual(10);
    for (const kind of withWeakPoints) {
      expect(ENEMY_TYPES[kind].weakPointName, kind).toBeTruthy();
      expect(ENEMY_TYPES[kind].weakPointMultiplier!, kind).toBeLessThanOrEqual(3);
    }
  });

  it('telegraphs every attack with time to react and a recovery window', () => {
    for (const kind of ENEMY_KINDS) {
      for (const attack of ENEMY_TYPES[kind].attacks) {
        expect(attack.telegraph, `${kind}:${attack.id}`).toBeGreaterThanOrEqual(0.4);
        expect(attack.recovery, `${kind}:${attack.id}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('never makes a creature immune to an element', () => {
    for (const kind of ENEMY_KINDS) {
      for (const value of Object.values(ENEMY_TYPES[kind].resistance)) {
        expect(value, kind).toBeGreaterThan(0);
      }
    }
  });

  it('gives volcanic creatures fire resistance and frozen ones fire weakness', () => {
    expect(ENEMY_TYPES['magma-beast'].resistance.fire).toBeLessThan(0.6);
    expect(ENEMY_TYPES['obsidian-clad'].resistance.fire).toBeLessThan(0.6);
    expect(ENEMY_TYPES['rime-stalker'].resistance.fire).toBeGreaterThan(1.2);
    expect(ENEMY_TYPES['crystal-clad'].resistance.fire).toBeGreaterThan(1.2);
  });
});

// =====================================================================
//  Buffs
// =====================================================================

describe('timed blessings', () => {
  it('applies, expires and refreshes', () => {
    const tracker = new BuffTracker(CHEST_BUFFS);
    tracker.apply(CHEST_BUFFS['buff-wrath']!);
    expect(tracker.has('buff-wrath')).toBe(true);
    expect(tracker.modifiers.damageScale).toBeGreaterThan(1);

    tracker.apply(CHEST_BUFFS['buff-wrath']!);
    expect(tracker.list()).toHaveLength(1);

    const expired = tracker.tick(1000);
    expect(expired.map((d) => d.id)).toContain('buff-wrath');
    expect(tracker.modifiers.damageScale).toBe(1);
  });

  it('round-trips through the save, clamped to its own duration', () => {
    const tracker = new BuffTracker(CHEST_BUFFS);
    tracker.apply(CHEST_BUFFS['buff-swiftness']!);
    tracker.tick(5);
    const json = tracker.toJSON();
    const restored = new BuffTracker(CHEST_BUFFS);
    restored.load([...json, { id: 'nonsense', timeLeft: 50 }]);
    expect(restored.list()).toHaveLength(1);
    expect(restored.list()[0]!.timeLeft).toBeLessThanOrEqual(CHEST_BUFFS['buff-swiftness']!.seconds);
  });

  it('combines with the permanent build without escaping the safe ranges', () => {
    const build = new BuildState();
    build.add('chest-double-damage');
    const tracker = new BuffTracker(CHEST_BUFFS);
    tracker.apply(CHEST_BUFFS['buff-wrath']!);
    const combined = combineModifiers(build.modifiers, tracker.modifiers);
    expect(combined.damageScale).toBeCloseTo(2 * 1.6, 3);
    expect(combined.maxEnergyScale).toBeCloseTo(0.75, 3);
    expect(combined.armor).toBeLessThanOrEqual(0.75);
  });
});
