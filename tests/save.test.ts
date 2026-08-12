import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SETTINGS, QUALITY_PRESETS, SAVE_KEY, SAVE_VERSION,
  applyQualityPreset, createSave, deleteSave, formatPlaytime, hasSave, loadSave, loadSettings,
  opsFromSave, sanitiseItems, sanitiseMaterials, sanitiseTerrainOps, timeAgo,
  validateSave, validateSettings, writeSave, type StorageLike,
} from '../src/save/saveData';
import { Mat } from '../src/world/materials';
import { MOTES_PER_SHRINE, SHRINE_COUNT } from '../src/world/shrineData';
import { serialiseOps, type TerrainOp } from '../src/world/terrainEdits';

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

class HostileStorage implements StorageLike {
  getItem(): string | null { throw new Error('blocked'); }
  setItem(): void { throw new Error('quota'); }
  removeItem(): void { throw new Error('blocked'); }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

const op = (patch: Partial<TerrainOp> = {}): TerrainOp => ({
  x: 100, y: 30, z: 90, radius: 3, strength: -2.5, material: Mat.SOIL, ...patch,
});

describe('createSave', () => {
  it('produces a valid, current-version save', () => {
    const save = createSave(12345, 'fire', 'normal', [128, 40, 128], { [Mat.SOIL]: 24 }, { berries: 3 });
    expect(save.version).toBe(SAVE_VERSION);
    expect(save.seed).toBe(12345);
    expect(save.affinity).toBe('fire');
    expect(save.activeElement).toBe('fire');
    expect(save.worldMode).toBe('normal');
    expect(save.shrines).toEqual([false, false, false, false]);
    expect(save.terrainOps).toEqual([]);
    expect(validateSave(save).ok).toBe(true);
  });

  it('records the chosen world mode', () => {
    expect(createSave(1, 'air', 'peaceful', [0, 0, 0], {}, {}).worldMode).toBe('peaceful');
  });

  it('starts Convergence players on Air', () => {
    expect(createSave(1, 'convergence', 'normal', [0, 0, 0], {}, {}).activeElement).toBe('air');
  });
});

describe('validateSave', () => {
  it('rejects payloads that are not objects', () => {
    for (const bad of [null, undefined, 42, 'nope', [] as unknown]) {
      expect(validateSave(bad).ok).toBe(false);
    }
  });

  it('rejects a save with an unusable affinity rather than rerolling silently', () => {
    const result = validateSave({ seed: 7, affinity: 'avatar' });
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.reason).toBe('bad-affinity');
  });

  it('rejects a save with no usable seed', () => {
    expect(validateSave({ affinity: 'air' }).reason).toBe('bad-seed');
  });

  it('repairs missing fields without touching a valid affinity', () => {
    const result = validateSave({ seed: 99, affinity: 'water' });
    expect(result.ok).toBe(true);
    expect(result.data!.affinity).toBe('water');
    expect(result.data!.version).toBe(SAVE_VERSION);
    expect(result.data!.worldMode).toBe('normal');
    expect(result.data!.motes).toHaveLength(SHRINE_COUNT);
    expect(result.data!.motes[0]).toHaveLength(MOTES_PER_SHRINE);
  });

  it('forces single-element players onto their own element', () => {
    expect(validateSave({ seed: 1, affinity: 'earth', activeElement: 'fire' }).data!.activeElement).toBe('earth');
  });

  it('remembers the active element for Convergence', () => {
    expect(validateSave({ seed: 1, affinity: 'convergence', activeElement: 'fire' }).data!.activeElement).toBe('fire');
  });

  it('repairs an invalid world mode to Normal', () => {
    expect(validateSave({ seed: 1, affinity: 'air', worldMode: 'sandbox' }).data!.worldMode).toBe('normal');
    expect(validateSave({ seed: 1, affinity: 'air', worldMode: 'peaceful' }).data!.worldMode).toBe('peaceful');
  });

  it('implies guardians and a finished ritual for cleansed shrines', () => {
    const result = validateSave({
      seed: 1, affinity: 'air',
      shrines: [true, false, true, false],
      guardians: [false, false, false, false],
      motes: [[false, false, false], [], [], []],
    });
    expect(result.data!.guardians).toEqual([true, false, true, false]);
    expect(result.data!.motes[0]).toEqual([true, true, true]);
    expect(result.data!.motes[1]).toEqual([false, false, false]);
  });

  it('never lets upgrades fall behind cleansed shrines', () => {
    const result = validateSave({ seed: 1, affinity: 'air', shrines: [true, true, true, false], upgrades: 0 });
    expect(result.data!.upgrades).toBe(3);
  });
});

describe('terrain edits in the save', () => {
  it('persists and reconstructs brush strokes', () => {
    const save = createSave(1, 'earth', 'normal', [0, 0, 0], {}, {});
    save.terrainOps = serialiseOps([op(), op({ x: 40, strength: 3, material: Mat.STONE })]);
    writeSave(storage, save);

    const loaded = loadSave(storage);
    expect(loaded.ok).toBe(true);
    const ops = opsFromSave(loaded.data!);
    expect(ops).toHaveLength(2);
    expect(ops[0]!.strength).toBeLessThan(0);
    expect(ops[1]!.material).toBe(Mat.STONE);
    expect(ops[1]!.x).toBeCloseTo(40, 2);
  });

  it('survives many save/load cycles without losing strokes', () => {
    const save = createSave(1, 'earth', 'normal', [0, 0, 0], {}, {});
    save.terrainOps = serialiseOps([op(), op({ z: 95 }), op({ z: 99 })]);
    for (let i = 0; i < 10; i++) {
      writeSave(storage, save);
      const loaded = loadSave(storage);
      expect(opsFromSave(loaded.data!)).toHaveLength(3);
      Object.assign(save, loaded.data!);
    }
  });

  it('drops corrupt strokes without discarding the whole save', () => {
    const result = validateSave({
      seed: 1, affinity: 'air',
      terrainOps: [10, 10, 10, 3, -2, Mat.SOIL, 0, Number.NaN, 1, 1, 1, 1, 1, 0],
    });
    expect(result.ok).toBe(true);
    expect(opsFromSave(result.data!)).toHaveLength(1);
  });

  it('sanitises a non-array journal to empty', () => {
    expect(sanitiseTerrainOps('nope')).toEqual([]);
    expect(sanitiseTerrainOps(null)).toEqual([]);
  });
});

describe('materials and items in the save', () => {
  it('keeps only carryable materials with positive amounts', () => {
    const mats = sanitiseMaterials({
      [Mat.STONE]: 12.55,
      [Mat.GRASS]: 5, // not carryable
      [Mat.ICE]: 5, // not carryable
      [Mat.SOIL]: -4,
      [Mat.SAND]: 50000,
      banana: 3,
    });
    expect(mats[Mat.STONE]).toBeCloseTo(12.6, 5);
    expect(mats[Mat.SAND]).toBe(9999);
    expect(mats[Mat.GRASS]).toBeUndefined();
    expect(mats[Mat.SOIL]).toBeUndefined();
  });

  it('keeps only known consumables', () => {
    const items = sanitiseItems({ berries: 3, minorPotion: 200, elixir: 5, meal: -1 });
    expect(items.berries).toBe(3);
    expect(items.minorPotion).toBe(99);
    expect(items.elixir).toBeUndefined();
    expect(items.meal).toBeUndefined();
  });
});

describe('migration from a version 2 block world', () => {
  const legacy = {
    version: 2,
    seed: 4242,
    affinity: 'convergence',
    activeElement: 'earth',
    shrines: [true, false, false, false],
    guardians: [true, false, false, false],
    upgrades: 1,
    position: [128.5, 40, 128.5],
    health: 88,
    energy: 40,
    inventory: { 2: 24, 3: 16, 6: 8, 9: 5 }, // dirt, stone, wood, corrupted
    edits: { '10,20,30': 3, '10,20,31': 1 },
    tutorialDone: true,
    playtime: 900,
  };

  it('keeps the affinity, seed, progress and blessings', () => {
    const result = validateSave(legacy);
    expect(result.ok).toBe(true);
    expect(result.data!.affinity).toBe('convergence');
    expect(result.data!.activeElement).toBe('earth');
    expect(result.data!.seed).toBe(4242);
    expect(result.data!.shrines).toEqual([true, false, false, false]);
    expect(result.data!.upgrades).toBe(1);
    expect(result.data!.health).toBe(88);
    expect(result.data!.playtime).toBe(900);
    expect(result.data!.tutorialDone).toBe(true);
    expect(result.data!.version).toBe(SAVE_VERSION);
  });

  it('never rerolls a valid affinity while migrating', () => {
    for (const affinity of ['air', 'water', 'earth', 'fire', 'convergence'] as const) {
      const result = validateSave({ ...legacy, affinity });
      expect(result.data!.affinity).toBe(affinity);
    }
  });

  it('reports that the old block edits could not be converted', () => {
    const result = validateSave(legacy);
    expect(result.terrainReset).toBe(true);
    expect(result.data!.terrainMigrated).toBe(true);
    // The terrain returns to its deterministic seed shape.
    expect(result.data!.terrainOps).toEqual([]);
  });

  it('does not claim a terrain reset when the old world had no edits', () => {
    const result = validateSave({ ...legacy, edits: {} });
    expect(result.terrainReset).toBe(false);
  });

  it('converts the block inventory into terrain materials', () => {
    const result = validateSave(legacy);
    const mats = result.data!.materials;
    expect(mats[Mat.SOIL]).toBeGreaterThan(0);
    expect(mats[Mat.STONE]).toBeGreaterThan(0);
    expect(mats[Mat.CORRUPT]).toBeGreaterThan(0);
  });

  it('gives a migrated world a small starting supply of healing items', () => {
    const result = validateSave(legacy);
    expect(Object.keys(result.data!.items).length).toBeGreaterThan(0);
  });

  it('defaults a migrated world to Normal Mode', () => {
    expect(validateSave(legacy).data!.worldMode).toBe('normal');
  });
});

describe('migration from a version 3 save (before the run layer)', () => {
  const v3 = {
    version: 3,
    seed: 777,
    affinity: 'water',
    activeElement: 'water',
    worldMode: 'peaceful',
    shrines: [true, true, false, false],
    guardians: [true, true, false, false],
    motes: [[true, true, true], [true, true, true], [false, false, false], [false, false, false]],
    upgrades: 2,
    position: [128, 30, 128],
    health: 90,
    energy: 55,
    materials: { [Mat.STONE]: 40 },
    items: { berries: 2, minorPotion: 1 },
    terrainOps: serialiseOps([op(), op({ x: 55 })]),
    lootedProps: [1, 2, 3],
    tutorialDone: true,
    playtime: 1800,
  };

  it('keeps everything the player already had', () => {
    const result = validateSave(v3);
    expect(result.ok).toBe(true);
    const d = result.data!;
    expect(d.version).toBe(SAVE_VERSION);
    expect(d.affinity).toBe('water');
    expect(d.worldMode).toBe('peaceful');
    expect(d.shrines).toEqual([true, true, false, false]);
    expect(d.upgrades).toBe(2);
    expect(d.health).toBe(90);
    expect(d.playtime).toBe(1800);
    expect(d.lootedProps).toEqual([1, 2, 3]);
    expect(opsFromSave(d)).toHaveLength(2);
    expect(d.materials[Mat.STONE]).toBe(40);
    expect(d.items.berries).toBe(2);
  });

  it('starts the run layer cleanly rather than failing', () => {
    const d = validateSave(v3).data!;
    expect(d.build).toEqual({});
    expect(d.depth).toBe(0);
    expect(d.encounters).toBe(0);
    expect(d.worldTheme).toBe('wilds');
    expect(d.runStats.enemiesFelled).toBe(0);
    expect(d.meta.echoes).toBe(0);
    expect(d.meta.unlocked).toEqual([]);
  });

  it('never rerolls a valid affinity while migrating', () => {
    for (const affinity of ['air', 'water', 'earth', 'fire', 'convergence'] as const) {
      expect(validateSave({ ...v3, affinity }).data!.affinity).toBe(affinity);
    }
  });

  it('drops unknown upgrade ids from a tampered build', () => {
    const d = validateSave({
      ...v3, version: 4,
      build: { 'any-honed': 3, 'not-real': 9, 'fire-split': 99 },
    }).data!;
    expect(d.build['any-honed']).toBe(3);
    expect(d.build['not-real']).toBeUndefined();
    // Clamped to the upgrade's own ceiling.
    expect(d.build['fire-split']).toBeLessThanOrEqual(2);
  });

  it('repairs a hostile world theme and meta blob', () => {
    const d = validateSave({
      ...v3, version: 4, worldTheme: 'atlantis', meta: 'nope', depth: -5,
    }).data!;
    expect(d.worldTheme).toBe('wilds');
    expect(d.meta.echoes).toBe(0);
    expect(d.depth).toBe(0);
  });

  it('round-trips a version 4 run through storage', () => {
    const save = createSave(9, 'fire', 'normal', [128, 30, 128], {}, {});
    save.build = { 'any-honed': 2, 'fire-split': 1 };
    save.depth = 6;
    save.encounters = 6;
    save.worldTheme = 'depths';
    save.runStats = {
      enemiesFelled: 30, elitesFelled: 3, bossesFelled: 1,
      scenariosCompleted: 2, worldsReached: 2,
    };
    save.meta = { echoes: 120, unlocked: ['world-depths'], runs: 4, bestDepth: 9, bossesFelled: 1 };
    writeSave(storage, save);

    const loaded = loadSave(storage).data!;
    expect(loaded.build).toEqual({ 'any-honed': 2, 'fire-split': 1 });
    expect(loaded.depth).toBe(6);
    expect(loaded.worldTheme).toBe('depths');
    expect(loaded.runStats.elitesFelled).toBe(3);
    expect(loaded.meta.echoes).toBe(120);
    expect(loaded.meta.unlocked).toEqual(['world-depths']);
  });
});

describe('storage round trip', () => {
  it('persists and reloads with the affinity and mode intact', () => {
    const save = createSave(2024, 'convergence', 'peaceful', [128, 40, 128], {}, {});
    save.activeElement = 'earth';
    save.shrines = [true, false, false, false];
    save.motes = [[true, true, true], [true, false, false], [false, false, false], [false, false, false]];
    save.upgrades = 1;
    expect(writeSave(storage, save)).toBe(true);

    const loaded = loadSave(storage);
    expect(loaded.data!.affinity).toBe('convergence');
    expect(loaded.data!.activeElement).toBe('earth');
    expect(loaded.data!.worldMode).toBe('peaceful');
    expect(loaded.data!.motes[1]).toEqual([true, false, false]);
  });

  it('reloading many times never changes the affinity or mode', () => {
    const save = createSave(5, 'water', 'peaceful', [1, 2, 3], {}, {});
    writeSave(storage, save);
    for (let i = 0; i < 25; i++) {
      const loaded = loadSave(storage);
      expect(loaded.data!.affinity).toBe('water');
      expect(loaded.data!.worldMode).toBe('peaceful');
      writeSave(storage, loaded.data!);
    }
  });

  it('reports empty and corrupt storage without crashing', () => {
    expect(loadSave(storage).reason).toBe('empty');
    storage.setItem(SAVE_KEY, '{ this is not json ');
    expect(loadSave(storage).reason).toBe('corrupt-json');
    storage.setItem(SAVE_KEY, JSON.stringify({ hello: 'world' }));
    expect(loadSave(storage).ok).toBe(false);
  });

  it('survives storage that throws on every call', () => {
    const hostile = new HostileStorage();
    expect(loadSave(hostile).ok).toBe(false);
    expect(writeSave(hostile, createSave(1, 'air', 'normal', [0, 0, 0], {}, {}))).toBe(false);
    expect(hasSave(hostile)).toBe(false);
    expect(() => deleteSave(hostile)).not.toThrow();
    expect(loadSettings(hostile)).toEqual(DEFAULT_SETTINGS);
  });

  it('deletes cleanly', () => {
    writeSave(storage, createSave(1, 'air', 'normal', [0, 0, 0], {}, {}));
    deleteSave(storage);
    expect(hasSave(storage)).toBe(false);
  });
});

describe('settings', () => {
  it('fills defaults for missing or invalid values', () => {
    const s = validateSettings({ fov: 500, masterVolume: 'loud', muted: 'yes', quality: 'ultra' });
    expect(s.fov).toBe(110);
    expect(s.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(s.muted).toBe(false);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
  });

  it('returns defaults for garbage input', () => {
    expect(validateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('applies quality presets coherently', () => {
    const low = applyQualityPreset({ ...DEFAULT_SETTINGS }, 'low');
    const high = applyQualityPreset({ ...DEFAULT_SETTINGS }, 'high');
    expect(low.quality).toBe('low');
    expect(high.quality).toBe('high');
    expect(low.renderDistance).toBeLessThan(high.renderDistance);
    expect(low.postProcessing).toBe(false);
    expect(high.postProcessing).toBe(true);
    expect(low.particleDensity).toBeLessThan(high.particleDensity);
    // Presets must round-trip through validation unchanged.
    expect(validateSettings(low)).toEqual(low);
    expect(validateSettings(high)).toEqual(high);
  });

  it('defines all three presets', () => {
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual(['high', 'low', 'medium']);
  });
});

describe('formatting helpers', () => {
  it('formats playtime', () => {
    expect(formatPlaytime(0)).toBe('0m 00s');
    expect(formatPlaytime(65)).toBe('1m 05s');
    expect(formatPlaytime(3900)).toBe('1h 05m');
  });

  it('formats relative times', () => {
    const now = 1_700_000_000_000;
    expect(timeAgo(now, now)).toBe('just now');
    expect(timeAgo(now - 120_000, now)).toBe('2 minutes ago');
    expect(timeAgo(0, now)).toBe('unknown');
  });
});

// =====================================================================
//  Version 5: the persistent build layer
// =====================================================================

describe('migration from a version 4 save (before the persistent build layer)', () => {
  const v4 = {
    version: 4,
    seed: 4242,
    affinity: 'earth',
    activeElement: 'earth',
    worldMode: 'normal',
    shrines: [true, false, false, false],
    guardians: [true, false, false, false],
    upgrades: 1,
    position: [100, 26, 100],
    respawn: [100, 26, 100],
    health: 120,
    energy: 60,
    materials: { [Mat.STONE]: 12 },
    items: { berries: 1 },
    terrainOps: serialiseOps([op()]),
    lootedProps: [4],
    tutorialDone: true,
    playtime: 900,
    worldTheme: 'wilds',
    build: { 'any-honed': 2, 'earth-stonehide': 1 },
    depth: 5,
    encounters: 5,
    runStats: { enemiesFelled: 20, elitesFelled: 2, bossesFelled: 1, scenariosCompleted: 1, worldsReached: 1 },
    meta: { echoes: 40, unlocked: ['world-depths'], runs: 1, bestDepth: 5, bossesFelled: 1 },
  };

  it('upgrades the version without losing anything', () => {
    const result = validateSave(v4);
    expect(result.ok).toBe(true);
    const d = result.data!;
    expect(d.version).toBe(SAVE_VERSION);
    expect(d.affinity).toBe('earth');
    expect(d.seed).toBe(4242);
    expect(d.upgrades).toBe(1);
    expect(d.health).toBe(120);
    expect(d.build).toEqual({ 'any-honed': 2, 'earth-stonehide': 1 });
    expect(d.depth).toBe(5);
    expect(d.meta.echoes).toBe(40);
    expect(opsFromSave(d)).toHaveLength(1);
  });

  it('starts the new layer from safe defaults', () => {
    const d = validateSave(v4).data!;
    expect(d.worldsCompleted).toEqual([]);
    expect(d.worldHearts).toEqual({});
    expect(d.buffs).toEqual([]);
    expect(d.story).toEqual([]);
    expect(d.postGame).toBe(false);
    expect(d.newGamePlus).toBe(0);
    expect(d.ultimateCharge).toBe(0);
    expect(d.checkpointWorld).toBe('wilds');
    // A save that already cleansed a shrine keeps its Ultimate unlocked.
    expect(d.ultimateUnlocked).toBe(true);
  });

  it('never loads the player straight into a drowning death', () => {
    const drowning = validateSave({ ...v4, oxygen: 0 }).data!;
    expect(drowning.oxygen).toBeGreaterThan(0);
  });
});

describe('version 5 fields', () => {
  const base = createSave(11, 'fire', 'normal', [128, 30, 128], {}, {});

  it('a new save starts with no persistent build layer', () => {
    expect(base.worldsCompleted).toEqual([]);
    expect(base.ultimateUnlocked).toBe(false);
    expect(base.ultimateCharge).toBe(0);
    expect(base.postGame).toBe(false);
    expect(base.newGamePlus).toBe(0);
    expect(base.story).toEqual([]);
  });

  it('round-trips completed worlds, hearts and the post-game flag', () => {
    const save = {
      ...base,
      worldsCompleted: ['wilds', 'depths'],
      worldHearts: { wilds: true },
      postGame: true,
      newGamePlus: 2,
      ultimateUnlocked: true,
      ultimateCharge: 42,
      story: ['opening', 'intro-wilds'],
      buffs: [{ id: 'buff-wrath', timeLeft: 10 }],
      checkpointWorld: 'depths',
    };
    const d = validateSave(save).data!;
    expect(d.worldsCompleted).toEqual(['wilds', 'depths']);
    // A completed world always implies its Heart.
    expect(d.worldHearts.wilds).toBe(true);
    expect(d.worldHearts.depths).toBe(true);
    expect(d.postGame).toBe(true);
    expect(d.newGamePlus).toBe(2);
    expect(d.ultimateUnlocked).toBe(true);
    expect(d.ultimateCharge).toBe(42);
    expect(d.story).toEqual(['opening', 'intro-wilds']);
    expect(d.buffs).toEqual([{ id: 'buff-wrath', timeLeft: 10 }]);
    expect(d.checkpointWorld).toBe('depths');
  });

  it('discards nonsense in the new fields rather than failing to load', () => {
    const d = validateSave({
      ...base,
      worldsCompleted: ['wilds', 'not-a-world', 'wilds'],
      worldHearts: { nope: true },
      story: ['opening', 'not-a-beat'],
      buffs: [{ id: 'not-a-buff', timeLeft: 5 }, 'rubbish'],
      ultimateCharge: 9999,
      newGamePlus: -3,
    }).data!;
    expect(d.worldsCompleted).toEqual(['wilds']);
    expect(d.worldHearts).toEqual({ wilds: true });
    expect(d.story).toEqual(['opening']);
    expect(d.buffs).toEqual([]);
    expect(d.ultimateCharge).toBe(100);
    expect(d.newGamePlus).toBe(0);
  });

  it('keeps chest rewards, which live in the build, through a reload', () => {
    const save = { ...base, build: { 'chest-double-damage': 1, 'any-hardy': 3 } };
    const d = validateSave(save).data!;
    expect(d.build['chest-double-damage']).toBe(1);
    expect(d.build['any-hardy']).toBe(3);
  });

  it('carries the accessibility settings', () => {
    const settings = validateSettings({
      reducedFlashes: true, reducedShake: true, reducedDistortion: true, reducedParticles: true,
    });
    expect(settings.reducedFlashes).toBe(true);
    expect(settings.reducedShake).toBe(true);
    expect(settings.reducedDistortion).toBe(true);
    expect(settings.reducedParticles).toBe(true);
    expect(validateSettings({}).reducedFlashes).toBe(false);
  });
});
