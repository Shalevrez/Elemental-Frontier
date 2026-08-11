/**
 * World dimensions and coordinate helpers for the smooth density terrain.
 *
 * The world is a finite box sampled by a scalar density field. A sample lives
 * at every integer lattice point, so the field is (SIZE+1) x (HEIGHT+1) x
 * (SIZE+1) values. Density > 0 means solid; the isosurface is at 0.
 *
 * Pure, engine-free and unit-testable.
 */

export const WORLD_SIZE = 256;
export const WORLD_HEIGHT = 64;

/** Density samples per axis (one more than the number of cells). */
export const DX = WORLD_SIZE + 1;
export const DY = WORLD_HEIGHT + 1;
export const DZ = WORLD_SIZE + 1;

/** Cells per chunk edge. */
export const CHUNK = 32;
export const CHUNKS_X = WORLD_SIZE / CHUNK; // 8
export const CHUNKS_Y = WORLD_HEIGHT / CHUNK; // 2
export const CHUNKS_Z = WORLD_SIZE / CHUNK; // 8
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 128

/**
 * A chunk meshes cells [-1 .. CHUNK-1] of its own space so that quads owned by
 * its lowest boundary have all four neighbouring cell vertices available.
 * That needs samples [-1 .. CHUNK] => CHUNK + 2 samples per axis.
 */
export const CHUNK_SAMPLES = CHUNK + 2; // 34
export const CHUNK_CELLS = CHUNK + 1; // 33

/**
 * Sea level sits well below the average land height so there is room to dig a
 * proper mine before striking the water table.
 */
export const SEA_LEVEL = 18;
export const WORLD_CENTER = WORLD_SIZE / 2;

/** Radius from the world centre at which the four shrines are placed. */
export const SHRINE_RADIUS = 88;

/** Index into the global density / material field. */
export function fieldIndex(x: number, y: number, z: number): number {
  return (x * DZ + z) * DY + y;
}

/** True when a density sample coordinate is inside the field. */
export function inField(x: number, y: number, z: number): boolean {
  return x >= 0 && x < DX && y >= 0 && y < DY && z >= 0 && z < DZ;
}

/** True when a world position is inside the playable box. */
export function inWorld(x: number, y: number, z: number): boolean {
  return x >= 0 && x <= WORLD_SIZE && y >= 0 && y <= WORLD_HEIGHT && z >= 0 && z <= WORLD_SIZE;
}

export function inColumn(x: number, z: number): boolean {
  return x >= 0 && x <= WORLD_SIZE && z >= 0 && z <= WORLD_SIZE;
}

/** Chunk coordinate that owns a world position. */
export function chunkCoordOf(x: number, y: number, z: number): { cx: number; cy: number; cz: number } {
  return {
    cx: Math.floor(x / CHUNK),
    cy: Math.floor(y / CHUNK),
    cz: Math.floor(z / CHUNK),
  };
}

export function chunkIndex(cx: number, cy: number, cz: number): number {
  return (cx * CHUNKS_Y + cy) * CHUNKS_Z + cz;
}

export function chunkIndexToCoord(index: number): { cx: number; cy: number; cz: number } {
  const cz = index % CHUNKS_Z;
  const rest = (index - cz) / CHUNKS_Z;
  const cy = rest % CHUNKS_Y;
  const cx = (rest - cy) / CHUNKS_Y;
  return { cx, cy, cz };
}

export function validChunk(cx: number, cy: number, cz: number): boolean {
  return cx >= 0 && cx < CHUNKS_X && cy >= 0 && cy < CHUNKS_Y && cz >= 0 && cz < CHUNKS_Z;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
