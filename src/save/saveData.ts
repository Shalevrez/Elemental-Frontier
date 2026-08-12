/**
 * Save-file schema, validation and migration.
 *
 * Version 3 replaces the old block-edit map with a terrain brush journal and
 * adds the world mode plus healing consumables. Version 2 saves are migrated:
 * their affinity, seed, shrine progress, blessings and settings survive, while
 * the block edits - which have no meaning in a density world - are dropped and
 * reported to the player.
 *
 * Pure functions plus a tiny injectable storage interface, so the whole
 * pipeline is unit-testable without a browser.
 */

import { isAffinityId, resolveActiveElement, type AffinityId, type ElementId } from '../elements/affinity';
import { coerceSeed } from '../core/rng';
import { Mat, isValidMaterial, materialDef } from '../world/materials';
import { WORLD_CENTER, WORLD_HEIGHT, WORLD_SIZE } from '../world/coords';
import {
  MOTES_PER_SHRINE, SHRINE_COUNT, SHRINE_UPGRADES,
  isWorldMode, normaliseMotes, normaliseShrineFlags, type WorldMode,
} from '../world/shrineData';
import { MAX_EDIT_OPS, OP_STRIDE, deserialiseOps, serialiseOps, type TerrainOp } from '../world/terrainEdits';
import { CONSUMABLE_ORDER, isConsumableId, type ConsumableId } from '../player/inventory';
import { isWorldId, type WorldId } from '../world/worlds';
import { createMeta, sanitiseMeta, type MetaState } from '../progression/meta';
import { upgradeById } from '../progression/upgrades';
import { CHEST_BUFFS } from '../progression/chests';
import { BASE_OXYGEN, sanitiseOxygen } from '../player/oxygen';
import { sanitiseCharge } from '../progression/ultimate';
import { storyBeat } from '../game/story';

/**
 * Version 5 adds the persistent-build layer: the Ultimate unlock and charge,
 * timed blessings, oxygen, story progress, World Heart progress, completed
 * worlds, the post-game flag and the New Game Plus counter. Every one of those
 * fields has a safe default, so a version 4 save loads with its affinity,
 * seed, terrain, build and shrine progress completely intact and simply starts
 * the new layer from zero.
 */
export const SAVE_VERSION = 5;
export const SAVE_KEY = 'elemental-frontier/world';
export const SETTINGS_KEY = 'elemental-frontier/settings';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaveData {
  version: number;
  seed: number;
  affinity: AffinityId;
  activeElement: ElementId;
  worldMode: WorldMode;
  shrines: boolean[];
  guardians: boolean[];
  /** Ritual motes gathered per shrine (Peaceful Mode). */
  motes: boolean[][];
  position: [number, number, number];
  yaw: number;
  pitch: number;
  respawn: [number, number, number];
  health: number;
  energy: number;
  upgrades: number;
  /** Terrain materials carried, keyed by material id. */
  materials: Record<number, number>;
  /** Healing consumables carried. */
  items: Record<string, number>;
  /** Flat brush-operation journal (7 numbers per stroke). */
  terrainOps: number[];
  /** Props (bushes, caches) the player has already looted. */
  lootedProps: number[];
  tutorialDone: boolean;
  playtime: number;
  createdAt: number;
  updatedAt: number;
  /** Set when a v2 world was migrated and its block edits were dropped. */
  terrainMigrated?: boolean;

  // ---- added in version 4: the roguelite run layer
  /** Which world theme this run is in. */
  worldTheme: WorldId;
  /** Upgrade id -> stacks owned this run. */
  build: Record<string, number>;
  /** How deep into the run the player is; drives difficulty and rarity. */
  depth: number;
  /** Encounters resolved this run, used to pace reward offers. */
  encounters: number;
  /** Running tallies for the end-of-run summary. */
  runStats: {
    enemiesFelled: number;
    elitesFelled: number;
    bossesFelled: number;
    scenariosCompleted: number;
    worldsReached: number;
  };
  /** Permanent, cross-run progression. */
  meta: MetaState;

  // ---- added in version 5: the persistent build layer
  /** Worlds whose World Heart has been restored, in completion order. */
  worldsCompleted: WorldId[];
  /** Per-world World Heart progress. */
  worldHearts: Partial<Record<WorldId, boolean>>;
  /** True once the element's Ultimate has been unlocked. */
  ultimateUnlocked: boolean;
  /** Ultimate meter, 0..100, preserved across world transitions. */
  ultimateCharge: number;
  /** Timed blessings still running. */
  buffs: { id: string; timeLeft: number }[];
  /** Seconds of oxygen left. Never loaded low enough to drown immediately. */
  oxygen: number;
  /** Story beats already seen, so they can be skipped. */
  story: string[];
  /** True once the final world has been completed at least once. */
  postGame: boolean;
  /** How many times New Game Plus has been started inside this save. */
  newGamePlus: number;
  /** Which world the stored checkpoint belongs to. */
  checkpointWorld: WorldId;
}

export type QualityPreset = 'low' | 'medium' | 'high';

export interface Settings {
  sensitivity: number;
  fov: number;
  renderDistance: number;
  masterVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  muted: boolean;
  shadows: boolean;
  quality: QualityPreset;
  /** 0 = off, 1 = low, 2 = high. */
  shadowQuality: number;
  /** Terrain mesh budget scale, 0.5 .. 1.5. */
  terrainDetail: number;
  /** Particle count multiplier, 0.25 .. 1.5. */
  particleDensity: number;
  postProcessing: boolean;
  antialias: boolean;

  // ---- accessibility
  /** Suppress full-screen elemental flashes. */
  reducedFlashes: boolean;
  /** Cut camera shake to a fraction of its normal strength. */
  reducedShake: boolean;
  /** Suppress underwater and impact screen distortion. */
  reducedDistortion: boolean;
  /** Extra multiplier on particle counts, on top of the quality preset. */
  reducedParticles: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  sensitivity: 1,
  fov: 78,
  renderDistance: 9,
  masterVolume: 0.75,
  sfxVolume: 0.85,
  ambienceVolume: 0.5,
  muted: false,
  shadows: true,
  quality: 'medium',
  shadowQuality: 1,
  terrainDetail: 1,
  particleDensity: 1,
  postProcessing: true,
  antialias: true,
  reducedFlashes: false,
  reducedShake: false,
  reducedDistortion: false,
  reducedParticles: false,
});

export const QUALITY_PRESETS: Readonly<Record<QualityPreset, Partial<Settings>>> = Object.freeze({
  low: Object.freeze({
    renderDistance: 6, shadows: false, shadowQuality: 0, terrainDetail: 0.6,
    particleDensity: 0.4, postProcessing: false, antialias: false,
  }),
  medium: Object.freeze({
    renderDistance: 9, shadows: true, shadowQuality: 1, terrainDetail: 1,
    particleDensity: 1, postProcessing: true, antialias: true,
  }),
  high: Object.freeze({
    renderDistance: 13, shadows: true, shadowQuality: 2, terrainDetail: 1.4,
    particleDensity: 1.4, postProcessing: true, antialias: true,
  }),
});

function num(value: unknown, fallback: number, lo = -Infinity, hi = Infinity): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function vec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    const x = num(value[0], fallback[0], -1e5, 1e5);
    const y = num(value[1], fallback[1], -1e5, 1e5);
    const z = num(value[2], fallback[2], -1e5, 1e5);
    if (x >= 0 && x <= WORLD_SIZE && z >= 0 && z <= WORLD_SIZE && y >= -8 && y <= WORLD_HEIGHT + 40) {
      return [x, y, z];
    }
  }
  return [...fallback] as [number, number, number];
}

/** Sanitise a carried-materials map coming from storage. */
export function sanitiseMaterials(value: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const id = Number(key);
    if (!isValidMaterial(id) || id === Mat.AIR) continue;
    if (!materialDef(id).carryable) continue;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (n > 0) out[id] = Math.min(Math.round(n * 10) / 10, 9999);
  }
  return out;
}

/** Sanitise the healing consumables map. */
export function sanitiseItems(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isConsumableId(key)) continue;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
    if (n > 0) out[key] = Math.min(n, 99);
  }
  return out;
}

/** Sanitise the flat terrain journal, dropping malformed strokes. */
export function sanitiseTerrainOps(value: unknown): number[] {
  const ops = deserialiseOps(value);
  return serialiseOps(ops);
}

export function opsFromSave(save: SaveData): TerrainOp[] {
  return deserialiseOps(save.terrainOps);
}

export function createSave(
  seed: number,
  affinity: AffinityId,
  mode: WorldMode,
  spawn: [number, number, number],
  materials: Record<number, number>,
  items: Record<string, number>,
): SaveData {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    seed,
    affinity,
    activeElement: resolveActiveElement(affinity, null),
    worldMode: mode,
    shrines: [false, false, false, false],
    guardians: [false, false, false, false],
    motes: normaliseMotes(null),
    position: [...spawn] as [number, number, number],
    yaw: 0,
    pitch: 0,
    respawn: [...spawn] as [number, number, number],
    health: -1,
    energy: -1,
    upgrades: 0,
    materials,
    items,
    terrainOps: [],
    lootedProps: [],
    tutorialDone: false,
    playtime: 0,
    createdAt: now,
    updatedAt: now,
    worldTheme: 'wilds',
    build: {},
    depth: 0,
    encounters: 0,
    runStats: {
      enemiesFelled: 0, elitesFelled: 0, bossesFelled: 0,
      scenariosCompleted: 0, worldsReached: 1,
    },
    meta: createMeta(),
    worldsCompleted: [],
    worldHearts: {},
    ultimateUnlocked: false,
    ultimateCharge: 0,
    buffs: [],
    oxygen: BASE_OXYGEN,
    story: [],
    postGame: false,
    newGamePlus: 0,
    checkpointWorld: 'wilds',
  };
}

/** Keep only world ids that still exist, in order and without duplicates. */
export function sanitiseWorldList(value: unknown): WorldId[] {
  const out: WorldId[] = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (isWorldId(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function sanitiseWorldHearts(value: unknown, completed: readonly WorldId[]): Partial<Record<WorldId, boolean>> {
  const out: Partial<Record<WorldId, boolean>> = {};
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (isWorldId(key) && raw === true) out[key] = true;
    }
  }
  // A completed world always implies its Heart, whatever the stored map says.
  for (const id of completed) out[id] = true;
  return out;
}

/** Sanitise the serialised timed blessings. */
export function sanitiseBuffs(value: unknown): { id: string; timeLeft: number }[] {
  const out: { id: string; timeLeft: number }[] = [];
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as { id?: unknown }).id;
    const timeLeft = (raw as { timeLeft?: unknown }).timeLeft;
    if (typeof id !== 'string' || !CHEST_BUFFS[id]) continue;
    const seconds = typeof timeLeft === 'number' && Number.isFinite(timeLeft) ? timeLeft : 0;
    if (seconds > 0.05) out.push({ id, timeLeft: Math.min(CHEST_BUFFS[id]!.seconds, seconds) });
    if (out.length >= 16) break;
  }
  return out;
}

/** Keep only story beat ids that still exist. */
export function sanitiseStory(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry === 'string' && storyBeat(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Keep only upgrade ids that still exist, clamped to their stack ceiling. */
export function sanitiseBuild(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const def = upgradeById(id);
    if (!def) continue;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
    if (n > 0) out[id] = Math.min(def.maxStacks, n);
  }
  return out;
}

function sanitiseRunStats(value: unknown): SaveData['runStats'] {
  const src = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const n = (v: unknown): number => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
  };
  return {
    enemiesFelled: n(src.enemiesFelled),
    elitesFelled: n(src.elitesFelled),
    bossesFelled: n(src.bossesFelled),
    scenariosCompleted: n(src.scenariosCompleted),
    worldsReached: Math.max(1, n(src.worldsReached)),
  };
}

export interface ValidationResult {
  ok: boolean;
  data: SaveData | null;
  migrated: boolean;
  /** Set when a v2 world's block edits had to be discarded. */
  terrainReset: boolean;
  reason?: string;
}

/**
 * Validate and repair a parsed save payload.
 *
 *  - A valid affinity is NEVER rerolled or replaced here.
 *  - Anything else missing or nonsensical is repaired with defaults.
 *  - Version 2 payloads are migrated; their block edits are dropped because a
 *    cube edit map has no meaning in a smooth density world, and the caller is
 *    told so it can inform the player.
 *  - If seed or affinity cannot be recovered the save is rejected so the
 *    caller can offer a fresh world instead of crashing.
 */
export function validateSave(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, data: null, migrated: false, terrainReset: false, reason: 'not-an-object' };
  }
  const src = raw as Record<string, unknown>;

  const seed = coerceSeed(src.seed);
  if (seed === null) {
    return { ok: false, data: null, migrated: false, terrainReset: false, reason: 'bad-seed' };
  }
  if (!isAffinityId(src.affinity)) {
    return { ok: false, data: null, migrated: false, terrainReset: false, reason: 'bad-affinity' };
  }
  const affinity = src.affinity;

  const version = num(src.version, 0, 0, 999);
  let migrated = version !== SAVE_VERSION;

  // A version 2 world stored cube edits under `edits`; there is no faithful
  // conversion to a density field, so the terrain returns to its seed shape.
  const hadBlockEdits = version < 3
    && !!src.edits
    && typeof src.edits === 'object'
    && Object.keys(src.edits as Record<string, unknown>).length > 0;

  const defaultSpawn: [number, number, number] = [WORLD_CENTER, 40, WORLD_CENTER];
  const position = vec3(src.position, defaultSpawn);
  const respawn = vec3(src.respawn, defaultSpawn);

  const shrines = normaliseShrineFlags(src.shrines);
  const guardians = normaliseShrineFlags(src.guardians);
  for (let i = 0; i < SHRINE_COUNT; i++) if (shrines[i]) guardians[i] = true;

  const motes = normaliseMotes(src.motes);
  // A cleansed shrine implies its ritual was finished.
  for (let i = 0; i < SHRINE_COUNT; i++) {
    if (!shrines[i]) continue;
    for (let m = 0; m < MOTES_PER_SHRINE; m++) motes[i]![m] = true;
  }

  const cleansedCount = shrines.filter(Boolean).length;
  let upgrades = Math.floor(num(src.upgrades, cleansedCount, 0, SHRINE_UPGRADES.length));
  if (upgrades < cleansedCount) {
    upgrades = cleansedCount;
    migrated = true;
  }

  // Version 2 carried a block inventory; convert what maps cleanly.
  let materials = sanitiseMaterials(src.materials);
  if (version < 3 && Object.keys(materials).length === 0 && src.inventory && typeof src.inventory === 'object') {
    materials = migrateBlockInventory(src.inventory);
  }

  const items = Object.keys(sanitiseItems(src.items)).length > 0
    ? sanitiseItems(src.items)
    : version < 3
      ? { berries: 2, minorPotion: 1 } // a small welcome pack for migrated worlds
      : {};

  const worldsCompleted = sanitiseWorldList(src.worldsCompleted);

  const data: SaveData = {
    version: SAVE_VERSION,
    seed,
    affinity,
    activeElement: resolveActiveElement(affinity, src.activeElement),
    worldMode: isWorldMode(src.worldMode) ? src.worldMode : 'normal',
    shrines,
    guardians,
    motes,
    position,
    yaw: num(src.yaw, 0, -1e4, 1e4),
    pitch: num(src.pitch, 0, -1.6, 1.6),
    respawn,
    health: num(src.health, -1, -1, 1e4),
    energy: num(src.energy, -1, -1, 1e4),
    upgrades,
    materials,
    items,
    terrainOps: sanitiseTerrainOps(src.terrainOps),
    lootedProps: sanitiseLootedProps(src.lootedProps),
    tutorialDone: bool(src.tutorialDone, false),
    playtime: num(src.playtime, 0, 0, 1e9),
    createdAt: num(src.createdAt, Date.now(), 0, 1e15),
    updatedAt: num(src.updatedAt, Date.now(), 0, 1e15),
    // Version 4 fields. Older saves simply start the run layer from scratch,
    // which costs the player nothing they had before.
    worldTheme: isWorldId(src.worldTheme) ? src.worldTheme : 'wilds',
    build: sanitiseBuild(src.build),
    depth: num(src.depth, 0, 0, 999),
    encounters: num(src.encounters, 0, 0, 1e6),
    runStats: sanitiseRunStats(src.runStats),
    meta: sanitiseMeta(src.meta),
    // Version 5 fields. A version 4 save simply starts the persistent-build
    // layer from its defaults; nothing it already had is touched.
    worldsCompleted,
    worldHearts: sanitiseWorldHearts(src.worldHearts, worldsCompleted),
    ultimateUnlocked: bool(src.ultimateUnlocked, cleansedCount > 0),
    ultimateCharge: sanitiseCharge(src.ultimateCharge),
    buffs: sanitiseBuffs(src.buffs),
    oxygen: sanitiseOxygen(src.oxygen, BASE_OXYGEN),
    story: sanitiseStory(src.story),
    postGame: bool(src.postGame, worldsCompleted.length >= 4),
    newGamePlus: Math.max(0, Math.floor(num(src.newGamePlus, 0, 0, 999))),
    checkpointWorld: isWorldId(src.checkpointWorld)
      ? src.checkpointWorld
      : isWorldId(src.worldTheme) ? src.worldTheme : 'wilds',
  };

  if (src.activeElement !== data.activeElement) migrated = true;
  if (hadBlockEdits) data.terrainMigrated = true;

  return { ok: true, data, migrated, terrainReset: hadBlockEdits };
}

/** Map a legacy block inventory onto the closest terrain materials. */
function migrateBlockInventory(raw: unknown): Record<number, number> {
  // Legacy block ids: 1 grass, 2 dirt, 3 stone, 4 sand, 6 wood, 7 leaves,
  // 8 ice, 9 corrupted.
  const map: Record<number, number> = { 1: Mat.SOIL, 2: Mat.SOIL, 3: Mat.STONE, 4: Mat.SAND, 8: Mat.CLAY, 9: Mat.CORRUPT };
  const out: Record<number, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const target = map[Number(key)];
    if (target === undefined) continue;
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    if (n <= 0) continue;
    // A cube of blocks becomes a comparable amount of loose material.
    out[target] = Math.min(9999, (out[target] ?? 0) + n * 2);
  }
  return out;
}

function sanitiseLootedProps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const n = Number(entry);
    if (Number.isInteger(n) && n >= 0 && n < 1e6) out.push(n);
    if (out.length >= 4000) break;
  }
  return out;
}

export function loadSave(storage: StorageLike): ValidationResult {
  let text: string | null = null;
  try {
    text = storage.getItem(SAVE_KEY);
  } catch {
    return { ok: false, data: null, migrated: false, terrainReset: false, reason: 'storage-unavailable' };
  }
  if (!text) return { ok: false, data: null, migrated: false, terrainReset: false, reason: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, data: null, migrated: false, terrainReset: false, reason: 'corrupt-json' };
  }
  return validateSave(parsed);
}

export function writeSave(storage: StorageLike, data: SaveData): boolean {
  try {
    data.version = SAVE_VERSION;
    data.updatedAt = Date.now();
    storage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function deleteSave(storage: StorageLike): void {
  try {
    storage.removeItem(SAVE_KEY);
  } catch {
    /* nothing sensible to do */
  }
}

export function hasSave(storage: StorageLike): boolean {
  try {
    return storage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

export function validateSettings(raw: unknown): Settings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const quality: QualityPreset =
    src.quality === 'low' || src.quality === 'high' || src.quality === 'medium'
      ? src.quality
      : DEFAULT_SETTINGS.quality;
  return {
    sensitivity: num(src.sensitivity, DEFAULT_SETTINGS.sensitivity, 0.2, 3),
    fov: num(src.fov, DEFAULT_SETTINGS.fov, 60, 110),
    renderDistance: Math.round(num(src.renderDistance, DEFAULT_SETTINGS.renderDistance, 4, 16)),
    masterVolume: num(src.masterVolume, DEFAULT_SETTINGS.masterVolume, 0, 1),
    sfxVolume: num(src.sfxVolume, DEFAULT_SETTINGS.sfxVolume, 0, 1),
    ambienceVolume: num(src.ambienceVolume, DEFAULT_SETTINGS.ambienceVolume, 0, 1),
    muted: bool(src.muted, DEFAULT_SETTINGS.muted),
    shadows: bool(src.shadows, DEFAULT_SETTINGS.shadows),
    quality,
    shadowQuality: Math.round(num(src.shadowQuality, DEFAULT_SETTINGS.shadowQuality, 0, 2)),
    terrainDetail: num(src.terrainDetail, DEFAULT_SETTINGS.terrainDetail, 0.5, 1.5),
    particleDensity: num(src.particleDensity, DEFAULT_SETTINGS.particleDensity, 0.25, 1.5),
    postProcessing: bool(src.postProcessing, DEFAULT_SETTINGS.postProcessing),
    antialias: bool(src.antialias, DEFAULT_SETTINGS.antialias),
    reducedFlashes: bool(src.reducedFlashes, DEFAULT_SETTINGS.reducedFlashes),
    reducedShake: bool(src.reducedShake, DEFAULT_SETTINGS.reducedShake),
    reducedDistortion: bool(src.reducedDistortion, DEFAULT_SETTINGS.reducedDistortion),
    reducedParticles: bool(src.reducedParticles, DEFAULT_SETTINGS.reducedParticles),
  };
}

/** Apply a quality preset on top of the current settings. */
export function applyQualityPreset(settings: Settings, preset: QualityPreset): Settings {
  return { ...settings, ...QUALITY_PRESETS[preset], quality: preset };
}

export function loadSettings(storage: StorageLike): Settings {
  try {
    const text = storage.getItem(SETTINGS_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    return validateSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(storage: StorageLike, settings: Settings): void {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'unknown';
  const secs = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatPlaytime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export { MAX_EDIT_OPS, OP_STRIDE, CONSUMABLE_ORDER };
export type { ConsumableId, WorldMode };
