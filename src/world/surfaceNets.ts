/**
 * Naive Surface Nets - the isosurface mesher that turns the density field into
 * smooth terrain geometry.
 *
 * For every cell that straddles the surface we place a single vertex at the
 * average of the cell's edge crossings, then stitch quads across every lattice
 * edge that changes sign. The result is a watertight, smooth, manifold skin
 * with no cube faces anywhere - and because vertices move continuously with
 * the density values, digging deforms the surface smoothly instead of removing
 * blocks.
 *
 * Vertex normals come from the density gradient, which keeps shading smooth
 * across chunk borders.
 *
 * Pure: no engine imports, so it runs identically on the main thread and in
 * the mesh worker.
 */

import { CHUNK, CHUNK_CELLS, CHUNK_SAMPLES } from './coords';
import { Mat, materialDef } from './materials';

/** Cell corner offsets, ordered so bit i of the mask is corner i. */
const CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

/** The 12 cell edges as pairs of corner indices. */
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Number of triangles produced. */
  triangles: number;
}

export interface MeshInput {
  /** (CHUNK+2)^3 density samples covering local sample coords -1 .. CHUNK. */
  density: Float32Array;
  /** Matching material ids. */
  material: Uint8Array;
  /** World position of local sample coordinate 0 (i.e. chunk origin). */
  originX: number;
  originY: number;
  originZ: number;
}

const N = CHUNK_SAMPLES; // 34 samples per axis
const C = CHUNK_CELLS; // 33 cells per axis

/** Sample index inside the padded chunk block. */
function si(x: number, y: number, z: number): number {
  return (x * N + y) * N + z;
}

/** Cell index inside the padded chunk block. */
function ci(x: number, y: number, z: number): number {
  return (x * C + y) * C + z;
}

/**
 * Fresh empty result.
 *
 * This must allocate new buffers every time: the mesh worker transfers the
 * returned ArrayBuffers, and transferring the same shared instance twice would
 * throw `DataCloneError: ArrayBuffer is already detached`.
 */
function emptyMesh(): MeshArrays {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
    triangles: 0,
  };
}

/**
 * Palette lookup with slope, height and noise tinting baked into the vertex
 * colour.
 *
 * Doing this at mesh time keeps the terrain a single material with no texture
 * lookups, while still giving the ground the patchy, mottled variation that
 * stops a smooth surface from reading as plastic.
 */
function shadeMaterial(
  matId: number, worldX: number, worldY: number, worldZ: number, normalY: number,
  out: { r: number; g: number; b: number },
): void {
  const def = materialDef(matId === Mat.AIR ? Mat.STONE : matId);
  const base = def.color;
  const deep = def.deep;

  // Steep faces expose the darker rock tone; flat ground keeps its surface hue.
  const steep = 1 - Math.max(0, Math.min(1, normalY));
  let t = steep * 0.8;

  // Broad patches of lighter and darker ground.
  const patch = smoothNoise(worldX * 0.045, worldY * 0.05, worldZ * 0.045);
  t += (patch - 0.5) * 0.55;
  // Fine grain on top of the patches.
  const grain = smoothNoise(worldX * 0.29, worldY * 0.31, worldZ * 0.29);
  t += (grain - 0.5) * 0.22;

  // Valleys read a touch cooler and damper than ridges.
  t += Math.max(0, (14 - worldY) / 70);
  t = Math.max(0, Math.min(1, t));

  const br = ((base >> 16) & 255) / 255;
  const bg = ((base >> 8) & 255) / 255;
  const bb = (base & 255) / 255;
  const dr = ((deep >> 16) & 255) / 255;
  const dg = ((deep >> 8) & 255) / 255;
  const db = (deep & 255) / 255;

  // A slight overall brightness wobble on a third scale.
  const j = 0.92 + smoothNoise(worldX * 0.12 + 40, worldY * 0.14, worldZ * 0.12 - 17) * 0.2;
  out.r = (br + (dr - br) * t) * j;
  out.g = (bg + (dg - bg) * t) * j;
  out.b = (bb + (db - bb) * t) * j;
}

/** Smooth value noise in [0,1). Cheap and deterministic across chunk borders. */
function smoothNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const fz = fade(z - zi);
  const c000 = hash3f(xi, yi, zi);
  const c100 = hash3f(xi + 1, yi, zi);
  const c010 = hash3f(xi, yi + 1, zi);
  const c110 = hash3f(xi + 1, yi + 1, zi);
  const c001 = hash3f(xi, yi, zi + 1);
  const c101 = hash3f(xi + 1, yi, zi + 1);
  const c011 = hash3f(xi, yi + 1, zi + 1);
  const c111 = hash3f(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

const _col = { r: 0, g: 0, b: 0 };

/**
 * Build the smooth mesh for one padded chunk block.
 *
 * Cells `-1 .. CHUNK-1` (local sample space 0 .. CHUNK) get vertices; quads are
 * emitted only for lattice edges the chunk owns, so neighbouring chunks tile
 * seamlessly without cracks or duplicated triangles.
 */
export function buildChunkMesh(input: MeshInput): MeshArrays {
  const { density, material, originX, originY, originZ } = input;

  const cellVertex = new Int32Array(C * C * C).fill(-1);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const values = new Float32Array(8);

  // ---------------------------------------------------------- vertices
  for (let cx = 0; cx < C; cx++) {
    for (let cy = 0; cy < C; cy++) {
      for (let cz = 0; cz < C; cz++) {
        let mask = 0;
        for (let i = 0; i < 8; i++) {
          const c = CORNERS[i]!;
          const v = density[si(cx + c[0], cy + c[1], cz + c[2])]!;
          values[i] = v;
          if (v > 0) mask |= 1 << i;
        }
        if (mask === 0 || mask === 255) continue;

        let ex = 0, ey = 0, ez = 0, count = 0;
        for (let e = 0; e < 12; e++) {
          const [a, b] = EDGES[e]!;
          const inA = (mask >> a) & 1;
          const inB = (mask >> b) & 1;
          if (inA === inB) continue;
          const va = values[a]!;
          const vb = values[b]!;
          const denom = va - vb;
          const t = Math.abs(denom) < 1e-9 ? 0.5 : Math.max(0, Math.min(1, va / denom));
          const ca = CORNERS[a]!;
          const cb = CORNERS[b]!;
          ex += ca[0] + (cb[0] - ca[0]) * t;
          ey += ca[1] + (cb[1] - ca[1]) * t;
          ez += ca[2] + (cb[2] - ca[2]) * t;
          count++;
        }
        if (count === 0) continue;

        const lx = cx + ex / count;
        const ly = cy + ey / count;
        const lz = cz + ez / count;

        // Gradient normal from the surrounding samples (points into solid).
        const gx = sampleTri(density, lx + 0.7, ly, lz) - sampleTri(density, lx - 0.7, ly, lz);
        const gy = sampleTri(density, lx, ly + 0.7, lz) - sampleTri(density, lx, ly - 0.7, lz);
        const gz = sampleTri(density, lx, ly, lz + 0.7) - sampleTri(density, lx, ly, lz - 0.7);
        const glen = Math.hypot(gx, gy, gz) || 1;
        // Outward normal points toward decreasing density.
        const nx = -gx / glen;
        const ny = -gy / glen;
        const nz = -gz / glen;

        // Material: the *shallowest* solid corner wins - the one nearest the
        // surface. Picking the deepest one instead would paint every hillside
        // with the subsoil hiding under it.
        let bestMat = Mat.STONE as number;
        let bestVal = Infinity;
        for (let i = 0; i < 8; i++) {
          if (values[i]! <= 0) continue;
          const c = CORNERS[i]!;
          const m = material[si(cx + c[0], cy + c[1], cz + c[2])]!;
          if (m !== Mat.AIR && values[i]! < bestVal) {
            bestVal = values[i]!;
            bestMat = m;
          }
        }

        // Local sample 0 maps to world origin - 1.
        const worldX = originX + lx - 1;
        const worldY = originY + ly - 1;
        const worldZ = originZ + lz - 1;
        shadeMaterial(bestMat, worldX, worldY, worldZ, ny, _col);

        cellVertex[ci(cx, cy, cz)] = positions.length / 3;
        positions.push(worldX, worldY, worldZ);
        normals.push(nx, ny, nz);
        colors.push(_col.r, _col.g, _col.b);
      }
    }
  }

  if (positions.length === 0) return emptyMesh();

  // ------------------------------------------------------------- quads
  // Owned lattice edges are those whose lower sample sits at local coords
  // 1 .. CHUNK (i.e. world-local cell 0 .. CHUNK-1).
  for (let x = 1; x <= CHUNK; x++) {
    for (let y = 1; y <= CHUNK; y++) {
      for (let z = 1; z <= CHUNK; z++) {
        const v0 = density[si(x, y, z)]!;
        const s0 = v0 > 0;

        // ---- edge along +X
        if (x < N - 1) {
          const v1 = density[si(x + 1, y, z)]!;
          if (s0 !== v1 > 0) {
            emitQuad(
              indices, cellVertex,
              ci(x, y - 1, z - 1), ci(x, y - 1, z), ci(x, y, z), ci(x, y, z - 1),
              s0,
            );
          }
        }
        // ---- edge along +Y
        if (y < N - 1) {
          const v1 = density[si(x, y + 1, z)]!;
          if (s0 !== v1 > 0) {
            emitQuad(
              indices, cellVertex,
              ci(x - 1, y, z - 1), ci(x, y, z - 1), ci(x, y, z), ci(x - 1, y, z),
              s0,
            );
          }
        }
        // ---- edge along +Z
        if (z < N - 1) {
          const v1 = density[si(x, y, z + 1)]!;
          if (s0 !== v1 > 0) {
            emitQuad(
              indices, cellVertex,
              ci(x - 1, y - 1, z), ci(x - 1, y, z), ci(x, y, z), ci(x, y - 1, z),
              s0,
            );
          }
        }
      }
    }
  }

  if (indices.length === 0) return emptyMesh();

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    triangles: indices.length / 3,
  };
}

function emitQuad(
  indices: number[], cellVertex: Int32Array,
  a: number, b: number, c: number, d: number, flip: boolean,
): void {
  const va = cellVertex[a]!;
  const vb = cellVertex[b]!;
  const vc = cellVertex[c]!;
  const vd = cellVertex[d]!;
  if (va < 0 || vb < 0 || vc < 0 || vd < 0) return;
  // `flip` is true when the solid side is at the edge's lower sample, which
  // means the outward normal runs along the positive axis. The winding below
  // was derived from the cross product of each quad so front faces always
  // point away from the solid.
  if (flip) {
    indices.push(va, vc, vb, va, vd, vc);
  } else {
    indices.push(va, vb, vc, va, vc, vd);
  }
}

/** Trilinear sample inside the padded block, clamped at its edges. */
function sampleTri(density: Float32Array, x: number, y: number, z: number): number {
  const cx = Math.max(0, Math.min(N - 1.001, x));
  const cy = Math.max(0, Math.min(N - 1.001, y));
  const cz = Math.max(0, Math.min(N - 1.001, z));
  const xi = Math.floor(cx);
  const yi = Math.floor(cy);
  const zi = Math.floor(cz);
  const fx = cx - xi;
  const fy = cy - yi;
  const fz = cz - zi;

  const c000 = density[si(xi, yi, zi)]!;
  const c100 = density[si(xi + 1, yi, zi)]!;
  const c010 = density[si(xi, yi + 1, zi)]!;
  const c110 = density[si(xi + 1, yi + 1, zi)]!;
  const c001 = density[si(xi, yi, zi + 1)]!;
  const c101 = density[si(xi + 1, yi, zi + 1)]!;
  const c011 = density[si(xi, yi + 1, zi + 1)]!;
  const c111 = density[si(xi + 1, yi + 1, zi + 1)]!;

  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

function hash3f(x: number, y: number, z: number): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + Math.round(z) * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export { N as CHUNK_BLOCK_SAMPLES, C as CHUNK_BLOCK_CELLS };
