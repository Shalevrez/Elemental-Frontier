/**
 * Data-driven world definitions.
 *
 * Each world is a complete description of a place: how its terrain is shaped,
 * what it is made of, where its water or lava sits, what hazards it has, how it
 * is lit, what weather blows through it, what lives there, what guards its
 * World Heart and how the player leaves it. The generator, the renderer, the
 * hazard code and the spawn director all read from here, so adding a world is
 * a data entry rather than new code.
 *
 * The four worlds are structurally different, not recoloured: the Verdant Ruins
 * are hilly forest with caves, the Tidal Archipelago is a broken sea of islands
 * with real depth, the Ember Caldera is a lava basin with elevated safe paths,
 * and the Frozen Expanse is a high vertical snowfield over ice caverns.
 *
 * Pure data - no engine imports.
 */

import type { EnemyKind } from '../combat/enemyTypes';
import type { Mat } from './materials';
import type { ScenarioKind } from '../game/scenarios';

export type WorldId = 'wilds' | 'depths' | 'ashen' | 'peaks';
export type WeatherKind = 'clear' | 'rain' | 'snow' | 'ash' | 'mist';
export type HazardKind = 'none' | 'lava' | 'deep-cold' | 'blight';

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
  /** Threshold below which a column becomes a basin, 0..1. */
  basinThreshold: number;
  /** Cave density multiplier. */
  caves: number;
  /** Extra 3D warp, which produces overhangs and arches. */
  warp: number;
  /** Height of the enclosing rim. */
  rim: number;
  /**
   * Island frequency. 0 keeps a continuous landmass; higher values break the
   * surface into separated islands with real water between them.
   */
  islands: number;
  /** How much of the world sits below the fluid line, 0..1, for placement. */
  submergence: number;
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

export interface WorldHazard {
  readonly kind: HazardKind;
  /** Damage applied the instant the player touches it. */
  readonly contactDamage: number;
  /** Damage per second of the lingering effect afterwards. */
  readonly dotDamage: number;
  /** How long the lingering effect lasts. */
  readonly dotSeconds: number;
  /** Metres of clearly marked warning band around the hazard. */
  readonly warningBand: number;
  /** Player-facing name, used by the HUD and the death note. */
  readonly name: string;
}

const NO_HAZARD: WorldHazard = Object.freeze({
  kind: 'none', contactDamage: 0, dotDamage: 0, dotSeconds: 0, warningBand: 0, name: '',
});

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
  /** What the fluid and the ground hazards do here. */
  readonly hazard: WorldHazard;
  /** Surfaces here are slippery (ice). */
  readonly slippery: boolean;
  /** Underwater visibility, in metres. */
  readonly underwaterVisibility: number;
  readonly vegetation: number;
  /** Structure kinds the world dresses itself with. */
  readonly structures: readonly string[];
  readonly enemies: readonly EnemyKind[];
  /** Weighted extra spawns that make the world feel distinct. */
  readonly signatureEnemy: EnemyKind;
  readonly scenarios: readonly ScenarioKind[];
  readonly boss: EnemyKind;
  /** The World Heart guarded here. */
  readonly heart: { readonly name: string; readonly guardian: string };
  /** Flavour name for the exit portal. */
  readonly portal: string;
  /** Ambient bed: drives the procedural audio filter. */
  readonly ambience: { filter: number; wind: number; rumble: number };
  /** Largest radius a single attack may deform here. */
  readonly maxDeformRadius: number;
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
    name: 'Verdant Ruins',
    tagline: 'Overgrown, patient, and quietly wrong.',
    description:
      'Forest, river country and rolling hills, with the ruins of an older people standing in the '
      + 'trees. Broken bridges cross the gullies, hidden paths run under the roots, and the '
      + 'vegetation nearest the Heart has been corrupted into something with opinions.',
    terrain: {
      baseHeight: 26, amplitude: 8.5, detail: 2.2, ridge: 12,
      basinDepth: 42, basinThreshold: 0.6, caves: 1, warp: 5.4, rim: 20,
      islands: 0, submergence: 0.12,
    },
    palette: {
      skyTop: 0x2f7fd8, skyHorizon: 0xc7e6f7, ground: 0x69795f, fog: 0xa2cfec,
      sunColor: 0xffefd0, sunIntensity: 2.1, ambient: 0x9dc2e6, ambientIntensity: 1.0,
      fogScale: 1.0, bloom: 0.42,
    },
    materials: { surface: M.GRASS, subsurface: M.SOIL, deep: M.STONE, shore: M.SAND, accent: M.CLAY },
    weather: 'clear', weatherIntensity: 0.15,
    seaLevel: 21, seaHazard: false, hazard: NO_HAZARD,
    slippery: false, underwaterVisibility: 26, vegetation: 1,
    structures: ['overgrown-ruin', 'broken-bridge', 'root-arch', 'keeper-statue', 'sunken-cellar'],
    enemies: ['root-hunter', 'stone-beast', 'thorn-spitter', 'crawler', 'warden'],
    signatureEnemy: 'root-hunter',
    scenarios: ['clear-all', 'survive-waves', 'destroy-nodes', 'defeat-elite', 'defend-shrine', 'hidden-exit'],
    boss: 'boss-maw',
    heart: { name: 'The Green Heart', guardian: 'The Rootwarden' },
    portal: 'Rootgate',
    ambience: { filter: 420, wind: 0.5, rumble: 0.1 },
    maxDeformRadius: 6,
    polish: 'full',
  }),

  depths: w({
    id: 'depths',
    name: 'Tidal Archipelago',
    tagline: 'Islands, and a city under the water between them.',
    description:
      'A shattered coast of islands, shallows and real depth. Drowned ruins hold air pockets, '
      + 'currents push you off course, waterfalls feed the channels, and half of every arena is '
      + 'flooded. There is plenty of dry land - you simply have to swim to reach it.',
    terrain: {
      baseHeight: 34, amplitude: 10, detail: 3.0, ridge: 9,
      basinDepth: 14, basinThreshold: 0.46, caves: 1.6, warp: 6.5, rim: 26,
      islands: 1.9, submergence: 0.5,
    },
    palette: {
      skyTop: 0x1e6fbe, skyHorizon: 0xa9dcef, ground: 0x2a4a58, fog: 0x74b8d6,
      sunColor: 0xdff0ff, sunIntensity: 1.6, ambient: 0x4f93b8, ambientIntensity: 1.2,
      fogScale: 0.8, bloom: 0.7,
    },
    materials: { surface: M.SAND, subsurface: M.CLAY, deep: M.STONE, shore: M.SAND, accent: M.ICE },
    weather: 'rain', weatherIntensity: 0.5,
    seaLevel: 24, seaHazard: false, hazard: NO_HAZARD,
    slippery: false, underwaterVisibility: 14, vegetation: 0.45,
    structures: ['drowned-ruin', 'air-pocket-cave', 'floating-platform', 'waterfall', 'stone-bridge'],
    enemies: ['shellback', 'tide-spirit', 'silt-lurker', 'crawler', 'mender'],
    signatureEnemy: 'silt-lurker',
    scenarios: ['clear-all', 'defeat-elite', 'escape-collapse', 'hidden-exit', 'elemental-puzzle', 'destroy-nodes'],
    boss: 'boss-maw',
    heart: { name: 'The Tidal Heart', guardian: 'The Drowned Chorus' },
    portal: 'Tidegate',
    ambience: { filter: 240, wind: 0.15, rumble: 0.55 },
    maxDeformRadius: 5,
    unlock: 'world-depths',
    polish: 'full',
  }),

  ashen: w({
    id: 'ashen',
    name: 'Ember Caldera',
    tagline: 'Everything here has already burned once.',
    description:
      'A volcanic basin of cracked basalt and obsidian. Lava runs in rivers and pools at the '
      + 'bottom; the safe routes are the elevated stone shelves above it. Heat vents fire without '
      + 'warning, ash blinds, and the rock over the vents will not hold forever.',
    terrain: {
      baseHeight: 26, amplitude: 10, detail: 4.0, ridge: 20,
      basinDepth: 44, basinThreshold: 0.62, caves: 1.4, warp: 7.5, rim: 26,
      islands: 0.35, submergence: 0.3,
    },
    palette: {
      skyTop: 0x2a1420, skyHorizon: 0xd06a34, ground: 0x3a2620, fog: 0x8a4a32,
      sunColor: 0xffb070, sunIntensity: 1.5, ambient: 0x7a3f36, ambientIntensity: 0.95,
      fogScale: 0.7, bloom: 1.1,
    },
    materials: { surface: M.STONE, subsurface: M.SOIL, deep: M.STONE, shore: M.SAND, accent: M.CORRUPT },
    weather: 'ash', weatherIntensity: 0.85,
    seaLevel: 18, seaHazard: true,
    hazard: Object.freeze({
      kind: 'lava' as const,
      // A brush against lava hurts and sets you alight; it does not delete you.
      contactDamage: 14, dotDamage: 7, dotSeconds: 4, warningBand: 2.5, name: 'Lava',
    }),
    slippery: false, underwaterVisibility: 6, vegetation: 0.08,
    structures: ['obsidian-spire', 'heat-vent', 'collapsing-shelf', 'basalt-arch', 'keeper-statue'],
    enemies: ['magma-beast', 'obsidian-clad', 'ember-burst', 'slinger', 'brute'],
    signatureEnemy: 'magma-beast',
    scenarios: ['clear-all', 'defeat-elite', 'survive-waves', 'escape-collapse', 'cross-hazard', 'defend-crystal'],
    boss: 'boss-maw',
    heart: { name: 'The Ember Heart', guardian: 'The Cinderbound' },
    portal: 'Embergate',
    ambience: { filter: 300, wind: 0.7, rumble: 0.8 },
    maxDeformRadius: 7,
    unlock: 'world-ashen',
    polish: 'full',
  }),

  peaks: w({
    id: 'peaks',
    name: 'Frozen Expanse',
    tagline: 'White, loud, and very far down.',
    description:
      'Snowfields and frozen lakes above ice caverns, climbing into vertical mountain routes. '
      + 'The surface is slippery, the blizzards cut visibility to nothing, and the ice over the '
      + 'lakes breaks under weight. Frozen ruins mark where the last keepers stopped.',
    terrain: {
      baseHeight: 37, amplitude: 13, detail: 3.0, ridge: 24,
      basinDepth: 50, basinThreshold: 0.7, caves: 1.9, warp: 6.5, rim: 34,
      islands: 0, submergence: 0.08,
    },
    palette: {
      skyTop: 0x5f8fc4, skyHorizon: 0xdfeaf5, ground: 0x8fa3b5, fog: 0xd3e2ee,
      sunColor: 0xf0f6ff, sunIntensity: 1.7, ambient: 0xc3d9ec, ambientIntensity: 1.15,
      fogScale: 0.5, bloom: 0.55,
    },
    materials: { surface: M.ICE, subsurface: M.STONE, deep: M.STONE, shore: M.ICE, accent: M.CLAY },
    weather: 'snow', weatherIntensity: 0.85,
    seaLevel: 28, seaHazard: false,
    hazard: Object.freeze({
      kind: 'deep-cold' as const,
      contactDamage: 0, dotDamage: 3.5, dotSeconds: 6, warningBand: 0, name: 'Deep cold',
    }),
    slippery: true, underwaterVisibility: 10, vegetation: 0.3,
    structures: ['frozen-ruin', 'ice-cavern', 'breakable-ice', 'crevasse', 'keeper-statue'],
    enemies: ['rime-stalker', 'frost-flier', 'crystal-clad', 'wisp', 'bulwark'],
    signatureEnemy: 'frost-flier',
    scenarios: ['clear-all', 'survive-waves', 'defeat-elite', 'cross-hazard', 'hidden-exit'],
    boss: 'boss-maw',
    heart: { name: 'The Rime Heart', guardian: 'The Rimebound' },
    portal: 'Rimegate',
    ambience: { filter: 900, wind: 1.0, rumble: 0.2 },
    maxDeformRadius: 6,
    unlock: 'world-peaks',
    polish: 'full',
  }),
});

/** The order the campaign visits the worlds in. */
export const WORLD_ORDER: readonly WorldId[] = Object.freeze(['wilds', 'depths', 'ashen', 'peaks']);

export function worldDef(id: WorldId): WorldDef {
  return WORLDS[id];
}

export function isWorldId(value: unknown): value is WorldId {
  return typeof value === 'string' && (WORLD_ORDER as readonly string[]).includes(value);
}

/** The world that follows this one, or null at the end of the campaign. */
export function nextWorld(id: WorldId): WorldId | null {
  const i = WORLD_ORDER.indexOf(id);
  if (i < 0 || i >= WORLD_ORDER.length - 1) return null;
  return WORLD_ORDER[i + 1]!;
}

/** 1-based position of a world in the campaign. */
export function worldIndex(id: WorldId): number {
  const i = WORLD_ORDER.indexOf(id);
  return i < 0 ? 1 : i + 1;
}

/** Worlds the player may currently choose. The first world is always available. */
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
