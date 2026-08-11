/**
 * Terrain material definitions for the smooth density world.
 *
 * A material id is stored per density sample. Meshing turns it into a vertex
 * colour, and the terrain brush uses it to decide what the player collects or
 * deposits. Pure data - no engine imports.
 */

export const Mat = {
  AIR: 0,
  GRASS: 1,
  SOIL: 2,
  STONE: 3,
  SAND: 4,
  CLAY: 5,
  CORRUPT: 6,
  ICE: 7,
} as const;

export type MaterialId = (typeof Mat)[keyof typeof Mat];

export interface MaterialDef {
  readonly id: MaterialId;
  readonly name: string;
  /** Base colour used for terrain vertex shading. */
  readonly color: number;
  /** Slightly darker shade blended into crevices and steep faces. */
  readonly deep: number;
  /** 0 = mirror-smooth, 1 = fully matte. */
  readonly roughness: number;
  /** Seconds of sustained excavation per unit of brush volume. */
  readonly toughness: number;
  /** Which material the player collects when digging this. */
  readonly yields: MaterialId;
  /** Can the player carry and deposit it from the terrain hotbar. */
  readonly carryable: boolean;
  /** Only usable once the player has actually collected some. */
  readonly restricted: boolean;
}

function def(d: MaterialDef): MaterialDef {
  return Object.freeze(d);
}

export const MATERIALS: Readonly<Record<number, MaterialDef>> = Object.freeze({
  [Mat.AIR]: def({
    id: Mat.AIR, name: 'Air', color: 0x000000, deep: 0x000000, roughness: 1,
    toughness: 0, yields: Mat.AIR, carryable: false, restricted: false,
  }),
  [Mat.GRASS]: def({
    id: Mat.GRASS, name: 'Meadowturf', color: 0x6aa845, deep: 0x3d6b2c,
    roughness: 0.95, toughness: 0.5, yields: Mat.SOIL, carryable: false, restricted: false,
  }),
  [Mat.SOIL]: def({
    id: Mat.SOIL, name: 'Soil', color: 0x8a6440, deep: 0x503a24,
    roughness: 0.95, toughness: 0.55, yields: Mat.SOIL, carryable: true, restricted: false,
  }),
  [Mat.STONE]: def({
    id: Mat.STONE, name: 'Stone', color: 0x8d8f98, deep: 0x53555e,
    roughness: 0.82, toughness: 1.15, yields: Mat.STONE, carryable: true, restricted: false,
  }),
  [Mat.SAND]: def({
    id: Mat.SAND, name: 'Sand', color: 0xdccb88, deep: 0x9c8a52,
    roughness: 0.98, toughness: 0.4, yields: Mat.SAND, carryable: true, restricted: false,
  }),
  [Mat.CLAY]: def({
    id: Mat.CLAY, name: 'Clay', color: 0xb2745a, deep: 0x6d4232,
    roughness: 0.75, toughness: 0.7, yields: Mat.CLAY, carryable: true, restricted: false,
  }),
  [Mat.CORRUPT]: def({
    id: Mat.CORRUPT, name: 'Blightmatter', color: 0x7c40a8, deep: 0x3a1d55,
    roughness: 0.6, toughness: 1.9, yields: Mat.CORRUPT, carryable: true, restricted: true,
  }),
  // Conjured by Water's Freeze; never carried, never permanent.
  [Mat.ICE]: def({
    id: Mat.ICE, name: 'Bound Ice', color: 0xbfe8ff, deep: 0x74b4d8,
    roughness: 0.25, toughness: 0.45, yields: Mat.CLAY, carryable: false, restricted: false,
  }),
});

/** Materials the terrain hotbar can cycle through, in order. */
export const CARRYABLE_MATERIALS: readonly MaterialId[] = Object.freeze([
  Mat.SOIL, Mat.STONE, Mat.SAND, Mat.CLAY, Mat.CORRUPT,
]);

export function materialDef(id: number): MaterialDef {
  return MATERIALS[id] ?? MATERIALS[Mat.AIR]!;
}

export function isValidMaterial(id: unknown): id is MaterialId {
  return typeof id === 'number' && Number.isInteger(id) && MATERIALS[id] !== undefined;
}

export function isCarryable(id: number): boolean {
  return materialDef(id).carryable;
}

/** `0xff9b3d` -> `#ff9b3d`, shared by every interface swatch. */
export function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** Gradient swatch used by the terrain hotbar and the satchel panel. */
export function materialSwatchCSS(id: number): string {
  const def = materialDef(id);
  return `linear-gradient(155deg, ${cssHex(def.color)} 0%, ${cssHex(def.deep)} 100%)`;
}
