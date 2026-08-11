/**
 * The scalar density field that defines the smooth world.
 *
 * Convention: density > 0 is solid, density < 0 is open air, and the terrain
 * surface is the isosurface at exactly 0. Because the surface is an isosurface
 * rather than a grid of cubes, the player can carve craters, tunnels, sideways
 * openings and overhangs, and the mesher reconstructs a smooth skin over
 * whatever shape the field happens to have.
 *
 * Pure and engine-free so generation determinism can be unit-tested.
 */

import { clamp, fbm2, hash2, ridged2, valueNoise3 } from '../core/rng';
import { Mat, type MaterialId } from './materials';
import {
  DX, DY, DZ, SEA_LEVEL, WORLD_CENTER, WORLD_HEIGHT, WORLD_SIZE, fieldIndex, inField,
} from './coords';
import { SHRINE_FIELD_RADIUS, SHRINE_SITES } from './shrineData';

/** How far the density value is allowed to travel from the surface. */
export const DENSITY_CLAMP = 6;

export const SPAWN_PLAZA_RADIUS = 9;

export interface DensityField {
  density: Float32Array;
  material: Uint8Array;
  /** Cached natural surface height per column, used for placement queries. */
  heights: Float32Array;
  seed: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function borderDistance(x: number, z: number): number {
  return Math.min(x, z, WORLD_SIZE - x, WORLD_SIZE - z);
}

/**
 * The shape controls a world definition supplies.
 *
 * The defaults reproduce the original Verdant terrain exactly, so a world that
 * does not override anything generates byte-for-byte what it always did.
 */
export interface TerrainShape {
  baseHeight: number;
  amplitude: number;
  detail: number;
  ridge: number;
  basinDepth: number;
  basinThreshold: number;
  caves: number;
  warp: number;
  rim: number;
  /** 0 keeps one landmass; higher values break the surface into islands. */
  islands: number;
  /** Height of this world's water or lava surface. */
  fluidLevel: number;
}

export const DEFAULT_SHAPE: Readonly<TerrainShape> = Object.freeze({
  baseHeight: 26,
  amplitude: 8.5,
  detail: 2.2,
  ridge: 12,
  basinDepth: 24,
  basinThreshold: 0.44,
  caves: 1,
  warp: 5.4,
  rim: 20,
  islands: 0,
  fluidLevel: SEA_LEVEL,
});

function shapeOf(shape?: Partial<TerrainShape>): TerrainShape {
  return shape ? { ...DEFAULT_SHAPE, ...shape } : (DEFAULT_SHAPE as TerrainShape);
}

/** Natural rolling surface height for a column, before shrines and the plaza. */
export function naturalHeight(x: number, z: number, seed: number, shape?: Partial<TerrainShape>): number {
  const s = shapeOf(shape);
  const base = fbm2(x * 0.0088, z * 0.0088, seed, 4) * 2 - 1;
  const detail = fbm2(x * 0.038, z * 0.038, seed + 991, 3) * 2 - 1;
  const ridge = ridged2(x * 0.0118, z * 0.0118, seed + 4409, 3);
  const continent = smoothstep(-0.18, 0.5, base);

  let h = s.baseHeight + base * s.amplitude + detail * s.detail + ridge * ridge * s.ridge * continent;

  const basin = fbm2(x * 0.0058 + 40, z * 0.0058 - 22, seed + 7717, 3);
  if (basin < s.basinThreshold) h -= (s.basinThreshold - basin) * s.basinDepth;

  // Island worlds cut deep channels between raised land masses, so the water
  // between them is genuine open sea rather than a puddle.
  if (s.islands > 0) {
    const archipelago = fbm2(x * 0.0135 - 310, z * 0.0135 + 118, seed + 15511, 4) * 2 - 1;
    // The mask has to straddle the noise's mean, otherwise almost every column
    // reads as "channel" and the archipelago is just an ocean.
    const shelf = smoothstep(-0.34, 0.22, archipelago);
    h -= (1 - shelf) * 16 * s.islands;
    h += shelf * 15 * s.islands;
  }

  // Rolling coastal cliffs enclose the world instead of a hard wall.
  const bd = borderDistance(x, z);
  if (bd < 36) {
    const t = (36 - bd) / 36;
    const crags = ridged2(x * 0.03, z * 0.03, seed + 1319, 3);
    const lumps = fbm2(x * 0.016, z * 0.016, seed + 2411, 3) * 2 - 1;
    h += t * t * (s.rim + crags * 20 + lumps * 7);
  }

  return clamp(h, 3, WORLD_HEIGHT - 5);
}

/** Height after shrine plateaus and the central plaza are blended in. */
export function terrainHeight(x: number, z: number, seed: number, shape?: Partial<TerrainShape>): number {
  let h = naturalHeight(x, z, seed, shape);

  for (const site of SHRINE_SITES) {
    const d = Math.hypot(x - site.x, z - site.z);
    if (d < SHRINE_FIELD_RADIUS) {
      const plateau = shrinePlateauHeight(site.index, seed, shape);
      h = plateau + (h - plateau) * smoothstep(10, SHRINE_FIELD_RADIUS, d);
    }
  }

  const dc = Math.hypot(x - WORLD_CENTER, z - WORLD_CENTER);
  if (dc < SPAWN_PLAZA_RADIUS + 10) {
    const plaza = spawnPlazaHeight(seed, shape);
    h = plaza + (h - plaza) * smoothstep(SPAWN_PLAZA_RADIUS - 2, SPAWN_PLAZA_RADIUS + 10, dc);
  }

  return clamp(h, 2, WORLD_HEIGHT - 5);
}

/**
 * Shrine plateaus and the spawn plaza always sit above this world's fluid line,
 * so a flooded or lava-filled world never drowns its own objectives.
 */
export function shrinePlateauHeight(index: number, seed: number, shape?: Partial<TerrainShape>): number {
  const s = shapeOf(shape);
  const site = SHRINE_SITES[index]!;
  const raw = naturalHeight(site.x, site.z, seed, shape);
  return clamp(Math.round(raw), s.fluidLevel + 3, WORLD_HEIGHT - 22);
}

export function spawnPlazaHeight(seed: number, shape?: Partial<TerrainShape>): number {
  const s = shapeOf(shape);
  const raw = naturalHeight(WORLD_CENTER, WORLD_CENTER, seed, shape);
  return clamp(Math.round(raw), s.fluidLevel + 2, Math.max(40, s.fluidLevel + 8));
}

export function temperatureAt(x: number, z: number, seed: number): number {
  return fbm2(x * 0.0042 + 130, z * 0.0042 - 90, seed + 20101, 3);
}

export function moistureAt(x: number, z: number, seed: number): number {
  return fbm2(x * 0.0066 - 55, z * 0.0066 + 210, seed + 30307, 3);
}

/** Blight intensity around an uncleansed shrine, 0..1. */
export function blightAt(x: number, z: number, seed: number, cleansed: readonly boolean[]): number {
  let worst = 0;
  for (const site of SHRINE_SITES) {
    if (cleansed[site.index]) continue;
    const d = Math.hypot(x - site.x, z - site.z);
    if (d > 26) continue;
    const falloff = 1 - d / 26;
    const n = fbm2(x * 0.08, z * 0.08, seed + 5150 + site.index * 71, 2);
    worst = Math.max(worst, falloff * (0.5 + n * 0.8));
  }
  return clamp(worst, 0, 1);
}

/**
 * Distance from the shrine's protected core, used to refuse terrain edits and
 * to keep the sculpted foundations intact.
 */
export function shrineProtection(x: number, y: number, z: number, seed: number, shape?: Partial<TerrainShape>): boolean {
  for (const site of SHRINE_SITES) {
    const d = Math.hypot(x - site.x, z - site.z);
    if (d > 14) continue;
    const plateau = shrinePlateauHeight(site.index, seed, shape);
    if (y > plateau - 6 && y < plateau + 30) return true;
  }
  return false;
}

/** Material palette a world generates with. Defaults match the Verdant Ruins. */
export interface TerrainMaterials {
  surface: number;
  subsurface: number;
  deep: number;
  shore: number;
  accent: number;
}

export const DEFAULT_MATERIALS: Readonly<TerrainMaterials> = Object.freeze({
  surface: Mat.GRASS, subsurface: Mat.SOIL, deep: Mat.STONE, shore: Mat.SAND, accent: Mat.CLAY,
});

export interface GenerateOptions {
  shape?: Partial<TerrainShape>;
  materials?: Partial<TerrainMaterials>;
}

/**
 * Generate the base density and material fields.
 *
 * Implemented as a generator so the loading screen stays responsive; yields a
 * 0..1 progress fraction.
 */
export function* generateFieldSteps(
  seed: number,
  cleansed: readonly boolean[] = [false, false, false, false],
  options: GenerateOptions = {},
): Generator<number, DensityField, void> {
  const density = new Float32Array(DX * DY * DZ);
  const material = new Uint8Array(DX * DY * DZ);
  const heights = new Float32Array(DX * DZ);

  const s = shapeOf(options.shape);
  const mats: TerrainMaterials = options.materials
    ? { ...DEFAULT_MATERIALS, ...options.materials }
    : (DEFAULT_MATERIALS as TerrainMaterials);
  const fluid = s.fluidLevel;

  const SLICE = 8;
  for (let x0 = 0; x0 < DX; x0 += SLICE) {
    const xEnd = Math.min(DX, x0 + SLICE);
    for (let x = x0; x < xEnd; x++) {
      for (let z = 0; z < DZ; z++) {
        const h = terrainHeight(x, z, seed, options.shape);
        heights[x * DZ + z] = h;

        const temp = temperatureAt(x, z, seed);
        const moist = moistureAt(x, z, seed);
        const blight = blightAt(x, z, seed, cleansed);
        const desert = temp > 0.64 && moist < 0.44;

        const base = fieldIndex(x, 0, z);
        for (let y = 0; y < DY; y++) {
          let d = h - y;

          // Organic detail only matters near the surface; skip the expensive
          // 3D noise deep underground and high in the air.
          if (d > -9 && d < 9) {
            const warp = valueNoise3(x * 0.055, y * 0.075, z * 0.055, seed + 8081) - 0.5;
            const warp2 = valueNoise3(x * 0.14, y * 0.17, z * 0.14, seed + 3313) - 0.5;
            d += warp * s.warp + warp2 * 1.5;
          }

          // Caves: smooth tubular voids well below the surface.
          if (s.caves > 0 && y > 3 && y < h - 5) {
            const c1 = valueNoise3(x * 0.032, y * 0.05, z * 0.032, seed + 6163);
            const c2 = valueNoise3(x * 0.021 + 12, y * 0.036, z * 0.021 - 8, seed + 9421);
            const tube = 1 - Math.abs(c1 - 0.5) * 4 - Math.abs(c2 - 0.5) * 3.2;
            if (tube > 0) d -= tube * 9 * s.caves;
          }

          const dd = clamp(d, -DENSITY_CLAMP, DENSITY_CLAMP);
          density[base + y] = dd;

          if (dd <= 0) {
            material[base + y] = Mat.AIR;
            continue;
          }
          let m: MaterialId;
          const depth = h - y;
          if (blight > 0.45 && depth < 4) m = Mat.CORRUPT;
          else if (depth < 1.4) {
            if (h <= fluid + 1.5) m = mats.shore as MaterialId;
            else if (desert) m = Mat.SAND;
            else m = mats.surface as MaterialId;
          } else if (depth < 4.5) {
            m = desert ? Mat.SAND : h <= fluid + 2 ? (mats.shore as MaterialId) : (mats.subsurface as MaterialId);
          } else if (depth < 8 && moist > 0.58) {
            m = mats.accent as MaterialId;
          } else {
            m = mats.deep as MaterialId;
          }
          material[base + y] = m;
        }
      }
    }
    yield xEnd / DX;
  }

  return { density, material, heights, seed };
}

export function generateField(
  seed: number,
  cleansed: readonly boolean[] = [false, false, false, false],
  options: GenerateOptions = {},
): DensityField {
  const it = generateFieldSteps(seed, cleansed, options);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

// -------------------------------------------------------------- sampling

/** Raw sample lookup with out-of-range handling (outside is solid rock). */
export function sampleAt(field: Float32Array, x: number, y: number, z: number): number {
  if (y >= DY) return -DENSITY_CLAMP;
  if (y < 0) return DENSITY_CLAMP;
  const cx = x < 0 ? 0 : x >= DX ? DX - 1 : x;
  const cz = z < 0 ? 0 : z >= DZ ? DZ - 1 : z;
  const outside = x < 0 || x >= DX || z < 0 || z >= DZ;
  const v = field[fieldIndex(cx, y, cz)]!;
  // Beyond the border, keep the value but never let the player escape through
  // a hole they dug in the rim.
  return outside ? Math.max(v, 0.5) : v;
}

/** Trilinear density sample at an arbitrary world position. */
export function densityAt(field: Float32Array, x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;

  const c000 = sampleAt(field, xi, yi, zi);
  const c100 = sampleAt(field, xi + 1, yi, zi);
  const c010 = sampleAt(field, xi, yi + 1, zi);
  const c110 = sampleAt(field, xi + 1, yi + 1, zi);
  const c001 = sampleAt(field, xi, yi, zi + 1);
  const c101 = sampleAt(field, xi + 1, yi, zi + 1);
  const c011 = sampleAt(field, xi, yi + 1, zi + 1);
  const c111 = sampleAt(field, xi + 1, yi + 1, zi + 1);

  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

export function isSolidAt(field: Float32Array, x: number, y: number, z: number): boolean {
  return densityAt(field, x, y, z) > 0;
}

/** Central-difference gradient; points into the solid. */
export function gradientAt(
  field: Float32Array, x: number, y: number, z: number, out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const e = 0.6;
  out.x = densityAt(field, x + e, y, z) - densityAt(field, x - e, y, z);
  out.y = densityAt(field, x, y + e, z) - densityAt(field, x, y - e, z);
  out.z = densityAt(field, x, y, z + e) - densityAt(field, x, y, z - e);
  const len = Math.hypot(out.x, out.y, out.z);
  if (len > 1e-6) {
    out.x /= len;
    out.y /= len;
    out.z /= len;
  } else {
    out.x = 0;
    out.y = 1;
    out.z = 0;
  }
  return out;
}

/** Material at the nearest lattice point. */
export function materialAt(mats: Uint8Array, x: number, y: number, z: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  const zi = Math.round(z);
  if (!inField(xi, yi, zi)) return Mat.STONE;
  return mats[fieldIndex(xi, yi, zi)]!;
}

/**
 * Surface height of a column by walking down from the sky until the field
 * turns solid. Returns -1 when the column is entirely open.
 */
export function surfaceHeight(field: Float32Array, x: number, z: number, from = WORLD_HEIGHT): number {
  let prev = densityAt(field, x, from, z);
  for (let y = from - 0.5; y >= 0; y -= 0.5) {
    const v = densityAt(field, x, y, z);
    if (v > 0 && prev <= 0) {
      // linear refine between y and y+0.5
      const t = prev / (prev - v);
      return y + 0.5 - t * 0.5;
    }
    prev = v;
  }
  return -1;
}

/** Deterministic scatter helper shared by prop and flora placement. */
export function scatterChance(x: number, z: number, seed: number): number {
  return hash2(Math.round(x), Math.round(z), seed);
}
