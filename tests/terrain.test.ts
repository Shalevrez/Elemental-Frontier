import { describe, it, expect } from 'vitest';
import {
  CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_CELLS, CHUNK_COUNT, CHUNK_SAMPLES,
  DX, DY, DZ, SEA_LEVEL, WORLD_HEIGHT, WORLD_SIZE,
  chunkCoordOf, chunkIndex, chunkIndexToCoord, fieldIndex, inField, inWorld, validChunk,
} from '../src/world/coords';
import {
  DENSITY_CLAMP, densityAt, generateField, gradientAt, isSolidAt, naturalHeight,
  shrineProtection, surfaceHeight, terrainHeight,
} from '../src/world/density';
import { buildChunkMesh } from '../src/world/surfaceNets';
import {
  MAX_EDIT_OPS, brushVolume, clampBrush, createJournal, deserialiseOps, pushOp, serialiseOps,
  type TerrainOp,
} from '../src/world/terrainEdits';
import { Mat, isCarryable, isValidMaterial, materialDef } from '../src/world/materials';
import { SHRINE_SITES } from '../src/world/shrineData';

describe('field coordinates', () => {
  it('round-trips sample indices', () => {
    const seen = new Set<number>();
    for (const [x, y, z] of [[0, 0, 0], [1, 2, 3], [DX - 1, DY - 1, DZ - 1], [128, 30, 200]] as const) {
      const i = fieldIndex(x, y, z);
      expect(seen.has(i)).toBe(false);
      seen.add(i);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(DX * DY * DZ);
    }
  });

  it('produces unique indices across a dense sample', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          const i = fieldIndex(x, y, z);
          expect(seen.has(i)).toBe(false);
          seen.add(i);
        }
      }
    }
  });

  it('reports field and world bounds', () => {
    expect(inField(0, 0, 0)).toBe(true);
    expect(inField(DX - 1, DY - 1, DZ - 1)).toBe(true);
    expect(inField(-1, 0, 0)).toBe(false);
    expect(inField(0, DY, 0)).toBe(false);
    expect(inWorld(WORLD_SIZE / 2, 10, WORLD_SIZE / 2)).toBe(true);
    expect(inWorld(-1, 10, 0)).toBe(false);
    expect(inWorld(0, WORLD_HEIGHT + 1, 0)).toBe(false);
  });

  it('maps positions to chunks and back', () => {
    expect(chunkCoordOf(0, 0, 0)).toEqual({ cx: 0, cy: 0, cz: 0 });
    expect(chunkCoordOf(CHUNK, CHUNK, CHUNK)).toEqual({ cx: 1, cy: 1, cz: 1 });
    expect(chunkIndex(CHUNKS_X - 1, CHUNKS_Y - 1, CHUNKS_Z - 1)).toBe(CHUNK_COUNT - 1);
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const c = chunkIndexToCoord(i);
      expect(chunkIndex(c.cx, c.cy, c.cz)).toBe(i);
      expect(validChunk(c.cx, c.cy, c.cz)).toBe(true);
    }
    expect(validChunk(-1, 0, 0)).toBe(false);
    expect(validChunk(CHUNKS_X, 0, 0)).toBe(false);
  });

  it('pads chunk meshing blocks so borders can be stitched', () => {
    // A chunk meshes one cell beyond its own low edge, which is exactly what
    // stops cracks appearing between neighbouring chunks.
    expect(CHUNK_SAMPLES).toBe(CHUNK + 2);
    expect(CHUNK_CELLS).toBe(CHUNK + 1);
  });
});

describe('terrain materials', () => {
  it('validates ids', () => {
    expect(isValidMaterial(Mat.STONE)).toBe(true);
    expect(isValidMaterial(999)).toBe(false);
    expect(isValidMaterial('3')).toBe(false);
  });

  it('marks only the intended materials carryable', () => {
    expect(isCarryable(Mat.SOIL)).toBe(true);
    expect(isCarryable(Mat.STONE)).toBe(true);
    expect(isCarryable(Mat.SAND)).toBe(true);
    expect(isCarryable(Mat.CLAY)).toBe(true);
    expect(isCarryable(Mat.CORRUPT)).toBe(true);
    expect(isCarryable(Mat.GRASS)).toBe(false);
    expect(isCarryable(Mat.ICE)).toBe(false);
  });

  it('makes blightmatter restricted and tough', () => {
    expect(materialDef(Mat.CORRUPT).restricted).toBe(true);
    expect(materialDef(Mat.CORRUPT).toughness).toBeGreaterThan(materialDef(Mat.STONE).toughness);
  });

  it('yields soil when digging grass', () => {
    expect(materialDef(Mat.GRASS).yields).toBe(Mat.SOIL);
  });
});

describe('terrain edit journal', () => {
  const op = (patch: Partial<TerrainOp> = {}): TerrainOp => ({
    x: 100.123, y: 30.456, z: 90.789, radius: 3, strength: -2.5, material: Mat.SOIL, ...patch,
  });

  it('serialises and reconstructs an operation', () => {
    const ops = [op(), op({ x: 12, strength: 2.5, material: Mat.STONE })];
    const flat = serialiseOps(ops);
    const back = deserialiseOps(flat);
    expect(back).toHaveLength(2);
    expect(back[0]!.x).toBeCloseTo(100.12, 2);
    expect(back[0]!.strength).toBeCloseTo(-2.5, 2);
    expect(back[0]!.material).toBe(Mat.SOIL);
    expect(back[1]!.material).toBe(Mat.STONE);
    expect(back[1]!.strength).toBeGreaterThan(0);
  });

  it('round-trips repeatedly without drifting', () => {
    let flat = serialiseOps([op()]);
    for (let i = 0; i < 5; i++) flat = serialiseOps(deserialiseOps(flat));
    const back = deserialiseOps(flat);
    expect(back[0]!.x).toBeCloseTo(100.12, 2);
    expect(back[0]!.radius).toBeCloseTo(3, 5);
  });

  it('drops malformed or out-of-range strokes instead of throwing', () => {
    expect(deserialiseOps(null)).toEqual([]);
    expect(deserialiseOps('nope')).toEqual([]);
    expect(deserialiseOps([1, 2, 3])).toEqual([]); // incomplete record
    expect(deserialiseOps([Number.NaN, 1, 1, 1, 1, 1, 0])).toEqual([]);
    expect(deserialiseOps([-999, 1, 1, 1, 1, 1, 0])).toEqual([]); // outside the world
    expect(deserialiseOps([10, 10, 10, 999, 1, 1, 0])).toEqual([]); // absurd radius
    expect(deserialiseOps([10, 10, 10, 3, 0, 1, 0])).toEqual([]); // no-op stroke
  });

  it('repairs an unknown material rather than dropping the stroke', () => {
    const back = deserialiseOps([10, 10, 10, 3, -2, 999, 0]);
    expect(back).toHaveLength(1);
    expect(back[0]!.material).toBe(Mat.SOIL);
  });

  it('caps the journal so storage can never be flooded', () => {
    const journal = createJournal();
    for (let i = 0; i < MAX_EDIT_OPS + 250; i++) pushOp(journal, op({ x: 10 + (i % 100) }));
    expect(journal.ops.length).toBe(MAX_EDIT_OPS);
    expect(serialiseOps(journal.ops).length).toBe(MAX_EDIT_OPS * 7);
  });

  it('clamps brush sizes and prices volume sensibly', () => {
    expect(clampBrush(0.1)).toBeGreaterThan(1);
    expect(clampBrush(99)).toBeLessThan(10);
    expect(brushVolume(4, 1)).toBeGreaterThan(brushVolume(2, 1));
    expect(brushVolume(3, 0.4)).toBeLessThan(brushVolume(3, 1));
  });
});

describe('density field generation', () => {
  const field = generateField(20240617);

  it('is deterministic for a seed', () => {
    expect(terrainHeight(100, 100, 1234)).toBe(terrainHeight(100, 100, 1234));
    expect(naturalHeight(50, 60, 7)).toBe(naturalHeight(50, 60, 7));
    const again = generateField(20240617);
    let mismatches = 0;
    for (let i = 0; i < field.density.length; i += 4001) {
      if (field.density[i] !== again.density[i]) mismatches++;
      if (field.material[i] !== again.material[i]) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('differs between seeds', () => {
    let differences = 0;
    for (let x = 20; x < 200; x += 11) {
      for (let z = 20; z < 200; z += 13) {
        if (terrainHeight(x, z, 1) !== terrainHeight(x, z, 2)) differences++;
      }
    }
    expect(differences).toBeGreaterThan(50);
  });

  it('keeps every height inside the world box', () => {
    for (let x = 0; x <= WORLD_SIZE; x += 9) {
      for (let z = 0; z <= WORLD_SIZE; z += 9) {
        const h = terrainHeight(x, z, 777);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(WORLD_HEIGHT);
      }
    }
  });

  it('clamps density into the working range', () => {
    for (let i = 0; i < field.density.length; i += 997) {
      expect(field.density[i]!).toBeGreaterThanOrEqual(-DENSITY_CLAMP);
      expect(field.density[i]!).toBeLessThanOrEqual(DENSITY_CLAMP);
    }
  });

  it('has solid ground under the surface and open air above it', () => {
    const x = 128.5;
    const z = 128.5;
    const h = surfaceHeight(field.density, x, z);
    expect(h).toBeGreaterThan(0);
    expect(isSolidAt(field.density, x, h - 1.5, z)).toBe(true);
    expect(isSolidAt(field.density, x, h + 2, z)).toBe(false);
  });

  it('produces an outward-facing surface normal', () => {
    const x = 128.5;
    const z = 128.5;
    const h = surfaceHeight(field.density, x, z);
    const g = gradientAt(field.density, x, h, z, { x: 0, y: 0, z: 0 });
    // Gradient points into the solid, so on flat ground it points downward.
    expect(g.y).toBeLessThan(0.2);
    expect(Math.hypot(g.x, g.y, g.z)).toBeCloseTo(1, 3);
  });

  it('carries a varied material palette', () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < field.material.length; i += 137) {
      const m = field.material[i]!;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    expect(counts.get(Mat.STONE) ?? 0).toBeGreaterThan(0);
    expect(counts.get(Mat.GRASS) ?? 0).toBeGreaterThan(0);
    expect(counts.get(Mat.SOIL) ?? 0).toBeGreaterThan(0);
  });

  it('protects the shrine foundations from terrain edits', () => {
    for (const site of SHRINE_SITES) {
      const plateau = terrainHeight(site.x, site.z, 20240617);
      expect(shrineProtection(site.x, plateau + 1, site.z, 20240617)).toBe(true);
      // Well away from any shrine, shaping is allowed.
      expect(shrineProtection(site.x + 60, plateau, site.z + 60, 20240617)).toBe(false);
    }
  });

  it('keeps some ground above the waterline', () => {
    let dry = 0;
    for (let x = 20; x < WORLD_SIZE - 20; x += 17) {
      for (let z = 20; z < WORLD_SIZE - 20; z += 17) {
        if (terrainHeight(x, z, 20240617) > SEA_LEVEL + 1) dry++;
      }
    }
    expect(dry).toBeGreaterThan(20);
  });
});

describe('surface nets meshing', () => {
  const N = CHUNK_SAMPLES;

  function block(fill: (x: number, y: number, z: number) => number): { density: Float32Array; material: Uint8Array } {
    const density = new Float32Array(N * N * N);
    const material = new Uint8Array(N * N * N);
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        for (let z = 0; z < N; z++) {
          const i = (x * N + y) * N + z;
          const d = fill(x, y, z);
          density[i] = d;
          material[i] = d > 0 ? Mat.STONE : Mat.AIR;
        }
      }
    }
    return { density, material };
  }

  it('produces nothing for an entirely empty block', () => {
    const { density, material } = block(() => -4);
    const mesh = buildChunkMesh({ density, material, originX: 0, originY: 0, originZ: 0 });
    expect(mesh.triangles).toBe(0);
  });

  it('produces nothing for an entirely solid block', () => {
    const { density, material } = block(() => 4);
    const mesh = buildChunkMesh({ density, material, originX: 0, originY: 0, originZ: 0 });
    expect(mesh.triangles).toBe(0);
  });

  it('meshes a flat ground plane with upward normals', () => {
    // Solid below local y = 16, air above.
    const { density, material } = block((_x, y) => 16 - y);
    const mesh = buildChunkMesh({ density, material, originX: 0, originY: 0, originZ: 0 });
    expect(mesh.triangles).toBeGreaterThan(100);
    expect(mesh.positions.length / 3).toBeGreaterThan(50);

    let upward = 0;
    for (let i = 1; i < mesh.normals.length; i += 3) {
      if (mesh.normals[i]! > 0.9) upward++;
    }
    // A flat ground plane should have essentially every normal pointing up.
    expect(upward / (mesh.normals.length / 3)).toBeGreaterThan(0.95);
  });

  it('places the surface at the isosurface, not on cell boundaries', () => {
    // Surface at y = 16.5 exactly between two samples.
    const { density, material } = block((_x, y) => 16.5 - y);
    const mesh = buildChunkMesh({ density, material, originX: 0, originY: 0, originZ: 0 });
    let sum = 0;
    let count = 0;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      sum += mesh.positions[i]!;
      count++;
    }
    // originY 0 means local sample 0 maps to world -1, so expect 16.5 - 1.
    expect(sum / count).toBeCloseTo(15.5, 1);
  });

  it('produces smooth normals on a sphere rather than axis-aligned faces', () => {
    const c = N / 2;
    const { density, material } = block((x, y, z) => 10 - Math.hypot(x - c, y - c, z - c));
    const mesh = buildChunkMesh({ density, material, originX: 0, originY: 0, originZ: 0 });
    expect(mesh.triangles).toBeGreaterThan(200);

    // If this were a cube mesh every normal would be axis-aligned. Count how
    // many are not - a sphere should be overwhelmingly diagonal.
    let diagonal = 0;
    let total = 0;
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const nx = Math.abs(mesh.normals[i]!);
      const ny = Math.abs(mesh.normals[i + 1]!);
      const nz = Math.abs(mesh.normals[i + 2]!);
      const maxAxis = Math.max(nx, ny, nz);
      if (maxAxis < 0.98) diagonal++;
      total++;
    }
    expect(diagonal / total).toBeGreaterThan(0.8);
  });

  it('emits a watertight index buffer', () => {
    const { density, material } = block((_x, y) => 16 - y);
    const mesh = buildChunkMesh({ density, material, originX: 0, originY: 0, originZ: 0 });
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.indices.length % 3).toBe(0);
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]!).toBeLessThan(vertexCount);
    }
    expect(mesh.colors.length).toBe(mesh.positions.length);
    expect(mesh.normals.length).toBe(mesh.positions.length);
  });
});

describe('applying edits to a density field', () => {
  /** Minimal stand-in for World.applyBrush so the maths can be tested purely. */
  function applyBrush(density: Float32Array, op: TerrainOp): number {
    const r = op.radius;
    let moved = 0;
    const x0 = Math.max(0, Math.floor(op.x - r));
    const x1 = Math.min(DX - 1, Math.ceil(op.x + r));
    const y0 = Math.max(0, Math.floor(op.y - r));
    const y1 = Math.min(DY - 1, Math.ceil(op.y + r));
    const z0 = Math.max(0, Math.floor(op.z - r));
    const z1 = Math.min(DZ - 1, Math.ceil(op.z + r));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const d = Math.hypot(x - op.x, y - op.y, z - op.z);
          if (d > r) continue;
          const t = 1 - d / r;
          const fall = t * t * (3 - 2 * t);
          const i = fieldIndex(x, y, z);
          const before = density[i]!;
          const after = Math.max(-DENSITY_CLAMP, Math.min(DENSITY_CLAMP, before + op.strength * fall));
          density[i] = after;
          moved += Math.abs(after - before);
        }
      }
    }
    return moved;
  }

  it('digging opens a hole and adding fills it back', () => {
    const field = generateField(4242);
    const x = 128;
    const z = 128;
    const h = surfaceHeight(field.density, x, z);
    const probeY = h - 1;

    expect(isSolidAt(field.density, x, probeY, z)).toBe(true);

    const dug = applyBrush(field.density, { x, y: probeY, z, radius: 3.5, strength: -6, material: Mat.SOIL });
    expect(dug).toBeGreaterThan(0);
    expect(isSolidAt(field.density, x, probeY, z)).toBe(false);

    const filled = applyBrush(field.density, { x, y: probeY, z, radius: 3.5, strength: 6, material: Mat.SOIL });
    expect(filled).toBeGreaterThan(0);
    expect(isSolidAt(field.density, x, probeY, z)).toBe(true);
  });

  it('digging sideways into a hill creates a tunnel that heightmaps could not', () => {
    const field = generateField(99);

    // Find a column with a solid band deep enough to tunnel through: the roof,
    // the tunnel line and the floor must all start out as rock.
    let x = 0;
    let z = 0;
    let y = 0;
    let found = false;
    outer:
    for (let sx = 60; sx < 200 && !found; sx += 7) {
      for (let sz = 60; sz < 200; sz += 7) {
        const h = surfaceHeight(field.density, sx, sz);
        if (h < 18) continue;
        const mid = h - 7;
        if (mid < 6) continue;
        const solidEverywhere = [0, 1.5, 3, 4.5, 6, 7.5]
          .every((d) => isSolidAt(field.density, sx + d, mid, sz))
          && isSolidAt(field.density, sx + 4, mid + 3.6, sz)
          && isSolidAt(field.density, sx + 4, mid - 3.6, sz);
        if (!solidEverywhere) continue;
        x = sx; z = sz; y = mid; found = true;
        break outer;
      }
    }
    expect(found, 'a solid band to tunnel through').toBe(true);

    // Carve horizontally: a run of overlapping spheres at constant height.
    for (let step = 0; step < 8; step++) {
      applyBrush(field.density, { x: x + step * 1.2, y, z, radius: 2.4, strength: -7, material: Mat.SOIL });
    }

    // The tunnel is open, and there is still solid rock above and below it -
    // an overhang that a heightmap simply cannot represent.
    expect(isSolidAt(field.density, x + 4, y, z)).toBe(false);
    expect(isSolidAt(field.density, x + 4, y + 3.6, z)).toBe(true);
    expect(isSolidAt(field.density, x + 4, y - 3.6, z)).toBe(true);
  });

  it('replaying the same journal reproduces the same field', () => {
    const ops: TerrainOp[] = [
      { x: 120, y: 26, z: 120, radius: 3, strength: -5, material: Mat.SOIL },
      { x: 123, y: 27, z: 121, radius: 2.5, strength: -4, material: Mat.SOIL },
      { x: 121, y: 28, z: 119, radius: 4, strength: 3, material: Mat.STONE },
    ];
    const a = generateField(5150);
    const b = generateField(5150);
    for (const op of ops) applyBrush(a.density, op);
    // Serialise, deserialise, replay - exactly what loading a save does.
    for (const op of deserialiseOps(serialiseOps(ops))) applyBrush(b.density, op);

    let mismatches = 0;
    for (let x = 110; x < 135; x += 2) {
      for (let y = 20; y < 36; y += 2) {
        for (let z = 110; z < 135; z += 2) {
          const i = fieldIndex(x, y, z);
          if (Math.abs(a.density[i]! - b.density[i]!) > 0.02) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
  });

  it('edits stay local to the brush', () => {
    const field = generateField(31337);
    const before = densityAt(field.density, 60, 26, 60);
    applyBrush(field.density, { x: 128, y: 26, z: 128, radius: 4, strength: -6, material: Mat.SOIL });
    expect(densityAt(field.density, 60, 26, 60)).toBe(before);
  });
});
