/**
 * Data-driven world themes.
 *
 * Each theme is a complete description of a place: how its terrain is shaped,
 * what it is made of, how it is lit, what weather it has, what lives there and
 * what guards it. The generator and the renderer both read from here, so a new
 * world is a data entry rather than new code.
 *
 * Pure data - no engine imports.
 */

import type { EnemyKind } from '../combat/enemyTypes';
import type { Mat } from './materials';
import type { ScenarioKind } from '../game/scenarios';

export type WorldId = 'wilds' | 'depths' | 'peaks' | 'ashen';
export type WeatherKind = 'clear' | 'rain' | 'snow' | 'ash' | 'mist';

export interface WorldTerrainParams {
  /** Base surface height around which the world varies. */
  baseHeight: number;
  /** Amplitude of the broad continental noise. */
  amplitude: number;
  /** Amplitude of the fine detail noise. */
  detail: number;
  /** Strength of ridged mountain crests. */
  ridge: number;
  /** How aggressively basins are carved (lakes, lava seas, caverns). */
  basinDepth: number;
  /** Cave density multiplier. */
  caves: number;
  /** Extra 3D warp, which produces overhangs and arches. */
  warp: number;
  /** Height of the enclosing rim. */
  rim: number;
}

export interface WorldPalette {
  /** Sky colours at midday. */
  skyTop: number;
  skyHorizon: number;
  ground: number;
  fog: number;
  sunColor: number;
  sunIntensity: number;
  ambient: number;
  ambientIntensity: number;
  /** Fog distance multiplier: <1 is hazier. */
  fogScale: number;
  /** Post-processing bloom strength for this world. */
  bloom: number;
}

export interface WorldDef {
  readonly id: WorldId;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly terrain: WorldTerrainParams;
  readonly palette: WorldPalette;
  /** Surface / subsurface / deep material ids (see materials.ts). */
  readonly materials: {
    surface: number;
    subsurface: number;
    deep: number;
    shore: number;
    /** Optional accent used for veins and outcrops. */
    accent: number;
  };
  readonly weather: WeatherKind;
  /** 0..1 baseline weather intensity. */
  readonly weatherIntensity: number;
  /** Sea/lava level for this world. */
  readonly seaLevel: number;
  /** Is the "sea" harmful to stand in? */
  readonly seaHazard: boolean;
  readonly vegetation: number;
  readonly enemies: readonly EnemyKind[];
  /** Weighted extra spawns that make the world feel distinct. */
  readonly signatureEnemy: EnemyKind;
  readonly scenarios: readonly ScenarioKind[];
  readonly boss: EnemyKind;
  /** Ambient bed: drives the procedural audio filter. */
  readonly ambience: { filter: number; wind: number; rumble: number };
  /** Meta unlock needed to visit, if any. */
  readonly unlock?: string;
  /** How thoroughly this theme is dressed. */
  readonly polish: 'full' | 'functional';
}

function w(d: WorldDef): WorldDef {
  return Object.freeze(d);
}

// Material ids duplicated as numbers to keep this file dependency-free at the
// type level; they line up with `Mat` in materials.ts.
const M = {
  GRASS: 1, SOIL: 2, STONE: 3, SAND: 4, CLAY: 5, CORRUPT: 6, ICE: 7,
} satisfies Record<string, number>;

export const WORLDS: Readonly<Record<WorldId, WorldDef>> = Object.freeze({
  wilds: w({
    id: 'wilds',
    name: 'The Ancient Wilds',
    tagline: 'Overgrown, patient, and quietly wrong.',
    description:
      'Rolling forest and river country strangled by creeping blight. Ruins of an older people '
      + 'stand in the trees, and the things that live here have not been corrupted for long.',
    terrain: {
      baseHeight: 26, amplitude: 8.5, detail: 2.2, ridge: 12,
      basinDepth: 24, caves: 1, warp: 5.4, rim: 20,
    },
    palette: {
      skyTop: 0x2f7fd8, skyHorizon: 0xc7e6f7, ground: 0x69795f, fog: 0xa2cfec,
      sunColor: 0xffefd0, sunIntensity: 2.1, ambient: 0x9dc2e6, ambientIntensity: 1.0,
      fogScale: 1.0, bloom: 0.42,
    },
    materials: { surface: M.GRASS, subsurface: M.SOIL, deep: M.STONE, shore: M.SAND, accent: M.CLAY },
    weather: 'clear', weatherIntensity: 0.15,
    seaLevel: 18, seaHazard: false, vegetation: 1,
    enemies: ['crawler', 'wisp', 'slinger', 'warden', 'sapper'],
    signatureEnemy: 'crawler',
    scenarios: ['clear-all', 'survive-waves', 'destroy-nodes', 'defeat-elite', 'defend-shrine', 'hidden-exit'],
    boss: 'boss-maw',
    ambience: { filter: 420, wind: 0.5, rumble: 0.1 },
    polish: 'full',
  }),

  depths: w({
    id: 'depths',
    name: 'The Sunken Depths',
    tagline: 'Still water, and something breathing under it.',
    description:
      'Flooded caverns beneath the Verdance. Crystal seams give the only honest light, the '
      + 'passages are narrow, and things wait in the silt for you to walk past.',
    terrain: {
      baseHeight: 30, amplitude: 11, detail: 3.4, ridge: 18,
      basinDepth: 34, caves: 2.4, warp: 8.5, rim: 30,
    },
    palette: {
      skyTop: 0x0a1830, skyHorizon: 0x1d4a63, ground: 0x14202c, fog: 0x1b3a4d,
      sunColor: 0x7fd4ff, sunIntensity: 0.8, ambient: 0x2f6f96, ambientIntensity: 1.25,
      fogScale: 0.55, bloom: 0.85,
    },
    materials: { surface: M.STONE, subsurface: M.CLAY, deep: M.STONE, shore: M.SAND, accent: M.ICE },
    weather: 'mist', weatherIntensity: 0.7,
    seaLevel: 22, seaHazard: false, vegetation: 0.25,
    enemies: ['crawler', 'burrower', 'wisp', 'mender', 'bulwark'],
    signatureEnemy: 'burrower',
    scenarios: ['clear-all', 'defeat-elite', 'escape-collapse', 'hidden-exit', 'elemental-puzzle', 'destroy-nodes'],
    boss: 'boss-maw',
    ambience: { filter: 240, wind: 0.15, rumble: 0.55 },
    unlock: 'world-depths',
    polish: 'full',
  }),

  peaks: w({
    id: 'peaks',
    name: 'The Frozen Peaks',
    tagline: 'White, loud, and very far down.',
    description:
      'Wind-scoured snowfields above the treeline. Visibility is poor, footing is worse, and '
      + 'the things that hunt here come from above.',
    terrain: {
      baseHeight: 34, amplitude: 13, detail: 3.0, ridge: 22,
      basinDepth: 16, caves: 0.8, warp: 6.5, rim: 34,
    },
    palette: {
      skyTop: 0x5f8fc4, skyHorizon: 0xdfeaf5, ground: 0x8fa3b5, fog: 0xd3e2ee,
      sunColor: 0xf0f6ff, sunIntensity: 1.7, ambient: 0xc3d9ec, ambientIntensity: 1.15,
      fogScale: 0.6, bloom: 0.55,
    },
    materials: { surface: M.ICE, subsurface: M.STONE, deep: M.STONE, shore: M.ICE, accent: M.CLAY },
    weather: 'snow', weatherIntensity: 0.8,
    seaLevel: 14, seaHazard: false, vegetation: 0.35,
    enemies: ['wisp', 'crawler', 'bulwark', 'slinger', 'mender'],
    signatureEnemy: 'wisp',
    scenarios: ['clear-all', 'survive-waves', 'defeat-elite', 'cross-hazard', 'hidden-exit'],
    boss: 'boss-maw',
    ambience: { filter: 900, wind: 1.0, rumble: 0.2 },
    unlock: 'world-peaks',
    polish: 'functional',
  }),

  ashen: w({
    id: 'ashen',
    name: 'The Ashen Expanse',
    tagline: 'Everything here has already burned once.',
    description:
      'A volcanic waste of cracked basalt and drifting embers. The ground is unstable, the air '
      + 'is worse, and the things that survive out here do not mind fire at all.',
    terrain: {
      baseHeight: 24, amplitude: 10, detail: 4.0, ridge: 20,
      basinDepth: 30, caves: 1.4, warp: 7.5, rim: 26,
    },
    palette: {
      skyTop: 0x2a1420, skyHorizon: 0xd06a34, ground: 0x3a2620, fog: 0x8a4a32,
      sunColor: 0xffb070, sunIntensity: 1.5, ambient: 0x7a3f36, ambientIntensity: 0.95,
      fogScale: 0.7, bloom: 1.1,
    },
    materials: { surface: M.STONE, subsurface: M.SOIL, deep: M.STONE, shore: M.SAND, accent: M.CORRUPT },
    weather: 'ash', weatherIntensity: 0.85,
    seaLevel: 12, seaHazard: true, vegetation: 0.08,
    enemies: ['brute', 'sapper', 'slinger', 'bulwark', 'crawler'],
    signatureEnemy: 'brute',
    scenarios: ['clear-all', 'defeat-elite', 'survive-waves', 'escape-collapse', 'cross-hazard', 'defend-crystal'],
    boss: 'boss-maw',
    ambience: { filter: 300, wind: 0.7, rumble: 0.8 },
    unlock: 'world-ashen',
    polish: 'functional',
  }),
});

export const WORLD_ORDER: readonly WorldId[] = Object.freeze(['wilds', 'depths', 'peaks', 'ashen']);

export function worldDef(id: WorldId): WorldDef {
  return WORLDS[id];
}

export function isWorldId(value: unknown): value is WorldId {
  return typeof value === 'string' && (WORLD_ORDER as readonly string[]).includes(value);
}

/** Worlds the player may currently choose. The Wilds is always available. */
export function availableWorlds(unlocked: ReadonlySet<string>): WorldId[] {
  return WORLD_ORDER.filter((id) => {
    const def = WORLDS[id];
    return !def.unlock || unlocked.has(def.unlock);
  });
}

/** Blend factor helper for smooth atmosphere transitions between regions. */
export function lerpPalette(a: WorldPalette, b: WorldPalette, t: number): WorldPalette {
  const k = Math.max(0, Math.min(1, t));
  const mix = (x: number, y: number): number => {
    const ar = (x >> 16) & 255, ag = (x >> 8) & 255, ab = x & 255;
    const br = (y >> 16) & 255, bg = (y >> 8) & 255, bb = y & 255;
    const r = Math.round(ar + (br - ar) * k);
    const g = Math.round(ag + (bg - ag) * k);
    const bl = Math.round(ab + (bb - ab) * k);
    return (r << 16) | (g << 8) | bl;
  };
  const num = (x: number, y: number): number => x + (y - x) * k;
  return {
    skyTop: mix(a.skyTop, b.skyTop),
    skyHorizon: mix(a.skyHorizon, b.skyHorizon),
    ground: mix(a.ground, b.ground),
    fog: mix(a.fog, b.fog),
    sunColor: mix(a.sunColor, b.sunColor),
    sunIntensity: num(a.sunIntensity, b.sunIntensity),
    ambient: mix(a.ambient, b.ambient),
    ambientIntensity: num(a.ambientIntensity, b.ambientIntensity),
    fogScale: num(a.fogScale, b.fogScale),
    bloom: num(a.bloom, b.bloom),
  };
}

export type { Mat };
