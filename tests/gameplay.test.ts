import { describe, it, expect } from 'vitest';
import {
  CONSUMABLES, CONSUMABLE_ORDER, Inventory, MAX_MATERIAL, STARTING_CONSUMABLES,
  STARTING_MATERIALS, chooseHealingItem,
} from '../src/player/inventory';
import { Mat } from '../src/world/materials';
import {
  BASE_STATS, MOTES_PER_SHRINE, SHRINE_COUNT, SHRINE_UPGRADES, accumulateUpgrades,
  allShrinesCleansed, canCleanse, isWorldMode, motesGathered, normaliseMotes,
  normaliseShrineFlags, pendingShrines, ritualComplete, shrineProgress,
} from '../src/world/shrineData';
import {
  cooldownFraction, createCooldown, effectiveCooldown, isReady, startCooldown, tickCooldown,
} from '../src/core/cooldown';
import { ELEMENTS, ELEMENT_ORDER, affinityPresentation, cssColor } from '../src/elements/elements';
import { buildTutorial, createTracker } from '../src/game/Tutorial';

describe('terrain material inventory', () => {
  it('adds and removes material amounts', () => {
    const inv = new Inventory();
    expect(inv.countMaterial(Mat.STONE)).toBe(0);
    expect(inv.addMaterial(Mat.STONE, 5)).toBe(5);
    expect(inv.countMaterial(Mat.STONE)).toBe(5);
    expect(inv.takeMaterial(Mat.STONE, 2)).toBe(2);
    expect(inv.countMaterial(Mat.STONE)).toBe(3);
  });

  it('takes only what is available and reports it', () => {
    const inv = new Inventory({ [Mat.SOIL]: 2 });
    expect(inv.takeMaterial(Mat.SOIL, 5)).toBe(2);
    expect(inv.countMaterial(Mat.SOIL)).toBe(0);
    expect(inv.hasMaterial(Mat.SOIL, 1)).toBe(false);
  });

  it('handles fractional excavation amounts', () => {
    const inv = new Inventory();
    inv.addMaterial(Mat.CLAY, 0.4);
    inv.addMaterial(Mat.CLAY, 0.35);
    expect(inv.countMaterial(Mat.CLAY)).toBeCloseTo(0.75, 5);
    expect(inv.takeMaterial(Mat.CLAY, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('refuses materials that cannot be carried', () => {
    const inv = new Inventory();
    expect(inv.addMaterial(Mat.GRASS, 5)).toBe(0);
    expect(inv.addMaterial(Mat.ICE, 5)).toBe(0);
    expect(inv.addMaterial(Mat.AIR, 5)).toBe(0);
    expect(inv.addMaterial(Mat.STONE, -3)).toBe(0);
  });

  it('clamps to the carry ceiling', () => {
    const inv = new Inventory();
    inv.addMaterial(Mat.STONE, 999999);
    expect(inv.countMaterial(Mat.STONE)).toBe(MAX_MATERIAL);
  });

  it('round-trips through JSON', () => {
    const inv = new Inventory({ ...STARTING_MATERIALS });
    const json = inv.materialsToJSON();
    const restored = new Inventory(json);
    expect(restored.materialsToJSON()).toEqual(json);
    expect(restored.countMaterial(Mat.SOIL)).toBe(STARTING_MATERIALS[Mat.SOIL]);
  });

  it('ignores hostile saved data', () => {
    const inv = new Inventory();
    inv.loadMaterials({ '3': 10, '999': 5, 'banana': 2, '1': 7 });
    expect(inv.countMaterial(Mat.STONE)).toBe(10);
    expect(inv.totalMaterials()).toBe(10);
  });

  it('cycles the selected slot in both directions', () => {
    const inv = new Inventory();
    const n = inv.slots.length;
    inv.select(0);
    inv.cycle(1);
    expect(inv.selected).toBe(1);
    inv.cycle(-1);
    expect(inv.selected).toBe(0);
    inv.cycle(-1);
    expect(inv.selected).toBe(n - 1);
    inv.select(n + 2);
    expect(inv.selected).toBe(2);
  });

  it('locks blightmatter until some has been collected', () => {
    const inv = new Inventory();
    expect(inv.canSelect(Mat.CORRUPT)).toBe(false);
    expect(inv.canSelect(Mat.STONE)).toBe(true);
    inv.addMaterial(Mat.CORRUPT, 3);
    expect(inv.canSelect(Mat.CORRUPT)).toBe(true);
  });
});

describe('healing consumables inventory', () => {
  it('adds, counts and consumes items', () => {
    const inv = new Inventory(undefined, { berries: 2 });
    expect(inv.countItem('berries')).toBe(2);
    expect(inv.takeItem('berries')).toBe(true);
    expect(inv.countItem('berries')).toBe(1);
    expect(inv.takeItem('berries')).toBe(true);
    expect(inv.takeItem('berries')).toBe(false);
    expect(inv.countItem('berries')).toBe(0);
  });

  it('starts a new world with a small supply', () => {
    const inv = new Inventory(undefined, { ...STARTING_CONSUMABLES });
    expect(inv.countItem('berries')).toBeGreaterThan(0);
    expect(inv.totalItems()).toBeGreaterThan(0);
  });

  it('ignores unknown item ids', () => {
    const inv = new Inventory();
    inv.loadConsumables({ berries: 3, elixirOfNonsense: 5 });
    expect(inv.countItem('berries')).toBe(3);
    expect(inv.totalItems()).toBe(3);
  });

  it('defines two foods and two potions with sensible strengths', () => {
    const foods = CONSUMABLE_ORDER.filter((id) => CONSUMABLES[id].kind === 'food');
    const potions = CONSUMABLE_ORDER.filter((id) => CONSUMABLES[id].kind === 'potion');
    expect(foods.length).toBeGreaterThanOrEqual(2);
    expect(potions.length).toBeGreaterThanOrEqual(2);
    expect(CONSUMABLES.meal.heal).toBeGreaterThan(CONSUMABLES.berries.heal);
    expect(CONSUMABLES.greaterPotion.heal).toBeGreaterThan(CONSUMABLES.minorPotion.heal);
    // Potions are stronger and faster than food.
    expect(CONSUMABLES.minorPotion.heal).toBeGreaterThan(CONSUMABLES.berries.heal);
    expect(CONSUMABLES.minorPotion.duration).toBeLessThan(CONSUMABLES.berries.duration);
  });
});

describe('quick-heal item choice', () => {
  const full = (): Inventory => new Inventory(undefined, {
    berries: 5, meal: 5, minorPotion: 5, greaterPotion: 5,
  });

  it('never chooses anything at full health', () => {
    expect(chooseHealingItem(full(), 100, 100, true)).toBeNull();
  });

  it('prefers food for a scratch', () => {
    expect(chooseHealingItem(full(), 90, 100, true)).toBe('berries');
  });

  it('prefers a minor draught for moderate damage', () => {
    expect(chooseHealingItem(full(), 55, 100, true)).toBe('minorPotion');
  });

  it('saves the greater draught for real trouble', () => {
    expect(chooseHealingItem(full(), 20, 100, true)).toBe('greaterPotion');
  });

  it('falls back to food while potions are on cooldown', () => {
    expect(chooseHealingItem(full(), 20, 100, false)).toBe('meal');
    expect(chooseHealingItem(full(), 55, 100, false)).toBe('meal');
  });

  it('returns null when the satchel is empty', () => {
    expect(chooseHealingItem(new Inventory(), 20, 100, true)).toBeNull();
  });

  it('does not waste a big meal on a scratch', () => {
    const inv = new Inventory(undefined, { meal: 1 });
    expect(chooseHealingItem(inv, 99, 100, true)).toBeNull();
    expect(chooseHealingItem(inv, 60, 100, false)).toBe('meal');
  });
});

describe('shrine progress', () => {
  it('counts cleansed shrines', () => {
    expect(shrineProgress([false, false, false, false])).toBe(0);
    expect(shrineProgress([true, false, true, false])).toBe(2);
    expect(shrineProgress([true, true, true, true])).toBe(SHRINE_COUNT);
  });

  it('detects completion', () => {
    expect(allShrinesCleansed([true, true, true, false])).toBe(false);
    expect(allShrinesCleansed([true, true, true, true])).toBe(true);
  });

  it('lists outstanding shrines', () => {
    expect(pendingShrines([true, false, true, false])).toEqual([1, 3]);
  });

  it('normalises hostile stored flags', () => {
    expect(normaliseShrineFlags(null)).toEqual([false, false, false, false]);
    expect(normaliseShrineFlags('true')).toEqual([false, false, false, false]);
    expect(normaliseShrineFlags([1, true, 'yes', true])).toEqual([false, true, false, true]);
  });
});

describe('peaceful ritual', () => {
  it('normalises the mote grid', () => {
    const motes = normaliseMotes(null);
    expect(motes).toHaveLength(SHRINE_COUNT);
    expect(motes[0]).toHaveLength(MOTES_PER_SHRINE);
    expect(motes.every((row) => row.every((m) => m === false))).toBe(true);
  });

  it('survives malformed stored motes', () => {
    const motes = normaliseMotes([[true, 'yes', 1], 'nope', null, [true, true, true, true]]);
    expect(motes[0]).toEqual([true, false, false]);
    expect(motes[1]).toEqual([false, false, false]);
    expect(motes[3]).toEqual([true, true, true]);
  });

  it('counts gathered motes and detects completion', () => {
    expect(motesGathered([true, false, true])).toBe(2);
    expect(ritualComplete([true, true, false])).toBe(false);
    expect(ritualComplete([true, true, true])).toBe(true);
  });

  it('gates cleansing on the guardian in Normal Mode', () => {
    expect(canCleanse('normal', false, [true, true, true])).toBe(false);
    expect(canCleanse('normal', true, [false, false, false])).toBe(true);
  });

  it('gates cleansing on the motes in Peaceful Mode - no guardian needed', () => {
    expect(canCleanse('peaceful', false, [false, false, false])).toBe(false);
    expect(canCleanse('peaceful', false, [true, true, false])).toBe(false);
    expect(canCleanse('peaceful', false, [true, true, true])).toBe(true);
  });

  it('validates world mode values', () => {
    expect(isWorldMode('normal')).toBe(true);
    expect(isWorldMode('peaceful')).toBe(true);
    expect(isWorldMode('creative')).toBe(false);
    expect(isWorldMode(null)).toBe(false);
  });
});

describe('shrine upgrades', () => {
  it('returns base stats with no upgrades', () => {
    expect(accumulateUpgrades(0, false)).toEqual({ ...BASE_STATS });
  });

  it('accumulates in cleansing order', () => {
    const one = accumulateUpgrades(1, false);
    expect(one.maxHealth).toBe(BASE_STATS.maxHealth + SHRINE_UPGRADES[0]!.maxHealth);

    const all = accumulateUpgrades(SHRINE_COUNT, false);
    expect(all.maxHealth).toBeGreaterThan(one.maxHealth);
    expect(all.maxEnergy).toBeGreaterThan(BASE_STATS.maxEnergy);
    expect(all.cooldownScale).toBeLessThan(1);
    expect(all.moveScale).toBeGreaterThan(1);
    expect(all.powerScale).toBeGreaterThan(1);
  });

  it('clamps counts outside the valid range', () => {
    expect(accumulateUpgrades(-3, false)).toEqual({ ...BASE_STATS });
    expect(accumulateUpgrades(99, false)).toEqual(accumulateUpgrades(SHRINE_COUNT, false));
    expect(accumulateUpgrades(Number.NaN, false)).toEqual({ ...BASE_STATS });
  });

  it('gives Convergence a smaller focused power bonus', () => {
    const single = accumulateUpgrades(SHRINE_COUNT, false);
    const converged = accumulateUpgrades(SHRINE_COUNT, true);
    expect(converged.powerScale).toBeLessThan(single.powerScale);
    expect(converged.maxHealth).toBe(single.maxHealth);
  });

  it('never grants another element', () => {
    for (const upgrade of SHRINE_UPGRADES) {
      expect(Object.keys(upgrade)).not.toContain('element');
      expect(upgrade.lines.join(' ').toLowerCase()).not.toContain('affinity');
    }
  });
});

describe('cooldowns', () => {
  it('starts ready', () => {
    const cd = createCooldown();
    expect(isReady(cd)).toBe(true);
    expect(cooldownFraction(cd)).toBe(0);
  });

  it('counts down to ready', () => {
    const cd = createCooldown();
    startCooldown(cd, 1);
    expect(isReady(cd)).toBe(false);
    expect(cooldownFraction(cd)).toBe(1);
    tickCooldown(cd, 0.5);
    expect(cooldownFraction(cd)).toBeCloseTo(0.5, 5);
    tickCooldown(cd, 0.6);
    expect(isReady(cd)).toBe(true);
  });

  it('ignores negative time steps', () => {
    const cd = createCooldown();
    startCooldown(cd, 2);
    tickCooldown(cd, -5);
    expect(cd.remaining).toBe(2);
  });

  it('scales with upgrades but never below a floor', () => {
    expect(effectiveCooldown(2, 1)).toBe(2);
    expect(effectiveCooldown(2, 0.8)).toBeCloseTo(1.6, 6);
    expect(effectiveCooldown(0, 1)).toBe(0.05);
    expect(effectiveCooldown(1, 0)).toBeCloseTo(0.1, 6);
    expect(effectiveCooldown(Number.NaN, 1)).toBe(0.05);
  });
});

describe('element definitions', () => {
  it('defines a primary, secondary and passive for every element', () => {
    for (const id of ELEMENT_ORDER) {
      const def = ELEMENTS[id];
      expect(def.primary.cost).toBeGreaterThan(0);
      expect(def.primary.cooldown).toBeGreaterThan(0);
      expect(def.secondary.cost).toBeGreaterThan(0);
      expect(def.secondary.cooldown).toBeGreaterThan(0);
      expect(def.passiveName.length).toBeGreaterThan(0);
      expect(def.shrineName.length).toBeGreaterThan(0);
    }
  });

  it('assigns hotkeys 1-4 in order', () => {
    expect(ELEMENT_ORDER.map((id) => ELEMENTS[id].hotkey)).toEqual([1, 2, 3, 4]);
  });

  it('presents Convergence under its own name', () => {
    const pres = affinityPresentation('convergence');
    expect(pres.title).toBe('Elemental Convergence');
    expect(pres.title.toLowerCase()).not.toContain('avatar');
  });

  it('converts colours to CSS', () => {
    expect(cssColor(0xff9b3d)).toBe('#ff9b3d');
    expect(cssColor(0x000f00)).toBe('#000f00');
  });
});

describe('adaptive tutorial', () => {
  it('teaches a single-element player only their own abilities', () => {
    const steps = buildTutorial('earth', 'earth', 'normal');
    const text = steps.map((s) => s.text).join(' ');
    expect(text).toContain(ELEMENTS.earth.primary.name);
    expect(text).not.toContain(ELEMENTS.fire.primary.name);
  });

  it('teaches Convergence players to switch elements', () => {
    const steps = buildTutorial('convergence', 'air', 'normal');
    const text = steps.map((s) => s.text).join(' ');
    expect(text).toContain('Switch');
    expect(text).toContain('<kbd>1</kbd>');
  });

  it('explains terrain shaping and healing', () => {
    const text = buildTutorial('fire', 'fire', 'normal').map((s) => s.text).join(' ');
    expect(text).toContain('Terrain Mode');
    expect(text).toContain('<kbd>H</kbd>');
    expect(text).toContain('<kbd>[</kbd>');
  });

  it('describes motes in Peaceful Mode and guardians in Normal Mode', () => {
    const peaceful = buildTutorial('water', 'water', 'peaceful').map((s) => s.text).join(' ');
    const normal = buildTutorial('water', 'water', 'normal').map((s) => s.text).join(' ');
    expect(peaceful).toContain('motes');
    expect(peaceful).not.toContain('guardian');
    expect(normal).toContain('guardian');
  });

  it('completes only when every action has been performed', () => {
    const steps = buildTutorial('fire', 'fire', 'normal');
    const tracker = createTracker();
    expect(steps.every((s) => s.isDone(tracker))).toBe(false);
    tracker.distanceMoved = 100;
    tracker.jumped = true;
    tracker.sprinted = true;
    tracker.primaryUsed = true;
    tracker.secondaryUsed = true;
    tracker.terrainModeUsed = true;
    tracker.terrainDug = 10;
    tracker.terrainAdded = 4;
    tracker.healingUsed = true;
    tracker.shrineCleansed = true;
    expect(steps.every((s) => s.isDone(tracker))).toBe(true);
  });

  it('always ends with the shrine objective', () => {
    for (const affinity of ['air', 'water', 'earth', 'fire', 'convergence'] as const) {
      for (const mode of ['normal', 'peaceful'] as const) {
        const steps = buildTutorial(affinity, affinity === 'convergence' ? 'air' : affinity, mode);
        expect(steps[steps.length - 1]!.text).toContain('cleanse');
      }
    }
  });
});
