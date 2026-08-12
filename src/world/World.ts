/**
 * The smooth density world: field storage, chunked isosurface meshing,
 * continuous collision queries and free-form terrain editing.
 *
 * There are no blocks anywhere in here. Terrain is a scalar field; the visible
 * surface is its zero isosurface, rebuilt by Surface Nets whenever the field
 * changes. Digging subtracts a smooth spherical falloff from the field and
 * only the affected chunks are re-meshed.
 */

import * as THREE from 'three';
import {
  CHUNK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_SAMPLES,
  DX, DY, DZ, SEA_LEVEL, WORLD_HEIGHT,
  chunkIndex, fieldIndex, inField, validChunk,
} from './coords';
import {
  DENSITY_CLAMP, densityAt, generateFieldSteps, gradientAt, isSolidAt, materialAt,
  shrineProtection, surfaceHeight, type DensityField, type TerrainShape,
} from './density';
import { Mat, materialDef } from './materials';
import { ObstacleField } from './Obstacles';
import type { WorldDef, WorldId } from './worlds';
import { buildChunkMesh } from './surfaceNets';
import { brushVolume, createJournal, pushOp, type EditJournal, type TerrainOp } from './terrainEdits';

export interface RaycastHit {
  /** Exact surface point. */
  point: THREE.Vector3;
  /** Outward surface normal. */
  normal: THREE.Vector3;
  distance: number;
  material: number;
  protectedGround: boolean;
}

interface ChunkRecord {
  cx: number; cy: number; cz: number;
  mesh: THREE.Mesh | null;
  dirty: boolean;
  pending: boolean;
  /** Monotonic token so stale worker results can be discarded. */
  token: number;
}

interface TempEdit {
  op: TerrainOp;
  expires: number;
  /**
   * The exact change this edit made to each sample.
   *
   * Deltas rather than previous values, because several temporary edits often
   * overlap (a raised wall is a row of deposits) and they do not expire in the
   * order they were applied. Subtracting a delta is order-independent;
   * restoring a saved value would re-apply whatever was underneath it.
   */
  restore: { index: number; delta: number; material: number }[];
}

const _grad = { x: 0, y: 0, z: 0 };
const _tmpDir = new THREE.Vector3();

export class World {
  readonly group = new THREE.Group();

  density!: Float32Array;
  material!: Uint8Array;
  heights!: Float32Array;
  seed = 0;
  spawn = { x: 0, y: 0, z: 0 };
  shrineY: number[] = [];

  /**
   * Collision volumes for everything that is not terrain: trees, boulders,
   * ruins, chests, portals and temporary earth walls. The player, respawn
   * resolver and debug overlay all read from here.
   */
  readonly obstacles = new ObstacleField();

  /** The world definition currently generated. */
  worldId: WorldId = 'wilds';
  /** Height of this world's water or lava surface. */
  fluidLevel = SEA_LEVEL;
  /** True when the fluid at `fluidLevel` is lava rather than water. */
  fluidIsHazard = false;
  /** Terrain shape parameters this world was generated with. */
  private shape: Partial<TerrainShape> | undefined;
  /**
   * Spheres that terrain deformation may never touch: portals, World Hearts and
   * boss arena anchors.
   */
  private readonly protectedSpheres: { x: number; y: number; z: number; r: number }[] = [];

  /** Player terrain edits, replayed on load. */
  readonly journal: EditJournal = createJournal();

  private chunks: ChunkRecord[] = [];
  private dirtyQueue: number[] = [];
  private temps: TempEdit[] = [];
  private clock = 0;
  private terrainMaterial: THREE.MeshStandardMaterial;
  private worker: Worker | null = null;
  private pendingJobs = new Map<number, { chunk: number; token: number }>();
  private nextJobId = 1;
  private meshBudgetMs = 5;

  /** Rebuild counter, useful for tests and the debug readout. */
  remeshCount = 0;

  constructor() {
    this.group.name = 'terrain';
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
      flatShading: false,
      envMapIntensity: 0.5,
    });

    for (let cx = 0; cx < CHUNKS_X; cx++) {
      for (let cy = 0; cy < CHUNKS_Y; cy++) {
        for (let cz = 0; cz < CHUNKS_Z; cz++) {
          this.chunks[chunkIndex(cx, cy, cz)] = {
            cx, cy, cz, mesh: null, dirty: true, pending: false, token: 0,
          };
        }
      }
    }

    this.startWorker();
  }

  private startWorker(): void {
    try {
      this.worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent): void => this.onWorkerMessage(event);
      this.worker.onerror = (): void => {
        // Fall back to synchronous meshing; the game keeps working.
        this.worker?.terminate();
        this.worker = null;
        this.pendingJobs.clear();
      };
    } catch {
      this.worker = null;
    }
  }

  // ------------------------------------------------------------- creation

  /**
   * Generate the base field for a seed, yielding 0..1 progress.
   *
   * The world definition supplies the terrain shape, materials and fluid level,
   * so each world is genuinely differently built rather than recoloured.
   */
  *generate(seed: number, cleansed: readonly boolean[], world?: WorldDef): Generator<number, void, void> {
    this.seed = seed;
    this.obstacles.clear();
    this.protectedSpheres.length = 0;
    this.worldId = world?.id ?? 'wilds';
    this.fluidLevel = world ? world.seaLevel : SEA_LEVEL;
    this.fluidIsHazard = world ? world.seaHazard : false;
    this.shape = world ? { ...world.terrain, fluidLevel: world.seaLevel } : undefined;

    const it = generateFieldSteps(seed, cleansed, {
      shape: this.shape,
      materials: world?.materials,
    });
    let step = it.next();
    while (!step.done) {
      yield step.value * 0.55;
      step = it.next();
    }
    const field: DensityField = step.value;
    this.density = field.density;
    this.material = field.material;
    this.heights = field.heights;
    this.shrineY = [];
    yield 0.56;
  }

  /** Mark a sphere as undeformable, e.g. a portal or a World Heart. */
  protectSphere(x: number, y: number, z: number, r: number): void {
    this.protectedSpheres.push({ x, y, z, r });
  }

  clearProtectedSpheres(): void {
    this.protectedSpheres.length = 0;
  }

  /** Replay stored player edits onto the freshly generated field. */
  applyJournal(ops: readonly TerrainOp[]): void {
    this.journal.ops.length = 0;
    for (const op of ops) {
      this.applyBrush(op, null);
      this.journal.ops.push(op);
    }
    this.journal.revision++;
    // Everything is dirty after a bulk replay.
    for (const chunk of this.chunks) chunk.dirty = true;
  }

  /** Mesh every chunk, yielding 0..1 progress. Runs synchronously. */
  *buildAllChunks(): Generator<number, void, void> {
    const order = this.chunks.map((_, i) => i);
    const scx = this.spawn.x / CHUNK;
    const scz = this.spawn.z / CHUNK;
    order.sort((a, b) => {
      const ca = this.chunks[a]!;
      const cb = this.chunks[b]!;
      const da = (ca.cx - scx) ** 2 + (ca.cz - scz) ** 2;
      const db = (cb.cx - scx) ** 2 + (cb.cz - scz) ** 2;
      return da - db;
    });
    let done = 0;
    let last = performance.now();
    for (const idx of order) {
      this.buildChunkSync(idx);
      done++;
      if (performance.now() - last > 22) {
        last = performance.now();
        yield done / order.length;
      }
    }
    this.dirtyQueue.length = 0;
    yield 1;
  }

  /** Pick a safe spawn on the plaza: open air above solid ground. */
  resolveSpawn(centerX: number, centerZ: number): { x: number; y: number; z: number } {
    const candidates: [number, number][] = [
      [0, 0], [1.5, 0], [0, 1.5], [-1.5, 0], [0, -1.5], [3, 3], [-3, -3], [4, 0], [0, 4],
    ];
    for (const [dx, dz] of candidates) {
      const x = centerX + dx;
      const z = centerZ + dz;
      const h = surfaceHeight(this.density, x, z, WORLD_HEIGHT - 2);
      if (h < 1) continue;
      const y = h + 0.15;
      if (!this.isSolid(x, y + 0.3, z) && !this.isSolid(x, y + 1.5, z)) {
        this.spawn = { x, y, z };
        return this.spawn;
      }
    }
    this.spawn = { x: centerX, y: Math.max(2, surfaceHeight(this.density, centerX, centerZ) + 0.2), z: centerZ };
    return this.spawn;
  }

  // -------------------------------------------------------------- queries

  isSolid(x: number, y: number, z: number): boolean {
    return isSolidAt(this.density, x, y, z);
  }

  densityAt(x: number, y: number, z: number): number {
    return densityAt(this.density, x, y, z);
  }

  /**
   * Outward surface normal at a point (points away from the solid).
   *
   * `out` is any object with x/y/z, not necessarily a `THREE.Vector3`: the
   * collision core is engine-free and passes plain vectors, so the fields are
   * assigned directly rather than through `Vector3.set`.
   */
  normalAt<T extends { x: number; y: number; z: number }>(x: number, y: number, z: number, out: T): T {
    gradientAt(this.density, x, y, z, _grad);
    out.x = -_grad.x;
    out.y = -_grad.y;
    out.z = -_grad.z;
    return out;
  }

  materialAt(x: number, y: number, z: number): number {
    return materialAt(this.material, x, y, z);
  }

  /** Height of the terrain surface in a column (-1 when the column is empty). */
  groundHeight(x: number, z: number): number {
    const h = surfaceHeight(this.density, x, z, WORLD_HEIGHT - 1);
    return h < 0 ? 0 : h;
  }

  /**
   * True when the point may not be deformed.
   *
   * Covers the sculpted shrine foundations and every explicitly protected
   * sphere - portals, World Hearts and boss anchors - so combat can never
   * delete an objective or seal the way out of a world.
   */
  isProtected(x: number, y: number, z: number): boolean {
    if (shrineProtection(x, y, z, this.seed, this.shape)) return true;
    for (const s of this.protectedSpheres) {
      const dx = x - s.x;
      const dy = y - s.y;
      const dz = z - s.z;
      if (dx * dx + dy * dy + dz * dz < s.r * s.r) return true;
    }
    return false;
  }

  isUnderwater(y: number): boolean {
    return y < this.fluidLevel;
  }

  /** True when this point is inside the world's damaging fluid (lava). */
  inHazardFluid(y: number): boolean {
    return this.fluidIsHazard && y < this.fluidLevel;
  }

  // ------------------------------------------------------------ raycasting

  /**
   * March a ray until the density turns solid, then binary-refine the crossing.
   * Works for any terrain shape including tunnels and overhangs.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, step = 0.25): RaycastHit | null {
    _tmpDir.copy(direction).normalize();
    let prevT = 0;
    let prevV = this.densityAt(origin.x, origin.y, origin.z);
    if (prevV > 0) {
      // Started inside solid ground - report immediately.
      const point = origin.clone();
      const normal = this.normalAt(point.x, point.y, point.z, new THREE.Vector3());
      return {
        point, normal, distance: 0,
        material: this.materialAt(point.x, point.y, point.z),
        protectedGround: this.isProtected(point.x, point.y, point.z),
      };
    }

    for (let t = step; t <= maxDistance; t += step) {
      const x = origin.x + _tmpDir.x * t;
      const y = origin.y + _tmpDir.y * t;
      const z = origin.z + _tmpDir.z * t;
      const v = this.densityAt(x, y, z);
      if (v > 0) {
        // Refine the crossing between prevT and t.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          const mv = this.densityAt(
            origin.x + _tmpDir.x * mid,
            origin.y + _tmpDir.y * mid,
            origin.z + _tmpDir.z * mid,
          );
          if (mv > 0) hi = mid; else lo = mid;
        }
        const d = hi;
        const point = new THREE.Vector3(
          origin.x + _tmpDir.x * d,
          origin.y + _tmpDir.y * d,
          origin.z + _tmpDir.z * d,
        );
        const normal = this.normalAt(point.x, point.y, point.z, new THREE.Vector3());
        return {
          point, normal, distance: d,
          material: this.materialAt(point.x, point.y, point.z),
          protectedGround: this.isProtected(point.x, point.y, point.z),
        };
      }
      prevT = t;
      prevV = v;
    }
    void prevV;
    return null;
  }

  // -------------------------------------------------------------- editing

  /**
   * Apply a smooth spherical brush to the field.
   *
   * The falloff is a smoothstep, so added material blends into the surrounding
   * ground as a mound rather than a pasted-on sphere, and excavation leaves a
   * rounded crater.
   *
   * @param record when non-null, the collected/consumed volume is reported.
   * @returns the amount of material actually moved.
   */
  applyBrush(op: TerrainOp, collect: Map<number, number> | null, restore?: TempEdit['restore']): number {
    const { x, y, z, radius, strength } = op;
    const r = Math.max(0.5, radius);
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(DX - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(DY - 1, Math.ceil(y + r));
    const z0 = Math.max(0, Math.floor(z - r));
    const z1 = Math.min(DZ - 1, Math.ceil(z + r));

    let moved = 0;
    const adding = strength > 0;

    for (let sx = x0; sx <= x1; sx++) {
      const dx = sx - x;
      for (let sz = z0; sz <= z1; sz++) {
        const dz = sz - z;
        const dxz2 = dx * dx + dz * dz;
        if (dxz2 > r2) continue;
        for (let sy = y0; sy <= y1; sy++) {
          const dy = sy - y;
          const d2 = dxz2 + dy * dy;
          if (d2 > r2) continue;

          const dist = Math.sqrt(d2);
          // Smooth falloff: full strength in the middle, feathered at the rim.
          const t = 1 - dist / r;
          const fall = t * t * (3 - 2 * t);
          if (fall <= 0.0001) continue;

          const index = fieldIndex(sx, sy, sz);
          const before = this.density[index]!;
          const beforeMat = this.material[index]!;
          const delta = strength * fall;
          let after = before + delta;
          if (after > DENSITY_CLAMP) after = DENSITY_CLAMP;
          if (after < -DENSITY_CLAMP) after = -DENSITY_CLAMP;
          if (after === before) continue;

          if (restore) restore.push({ index, delta: after - before, material: beforeMat });

          // Account for the material that crossed the surface.
          if (collect) {
            if (!adding && before > 0) {
              const removed = Math.min(before, before - Math.max(after, 0));
              if (removed > 0) {
                const m = beforeMat === Mat.AIR ? Mat.STONE : beforeMat;
                const yielded = materialDef(m).yields;
                collect.set(yielded, (collect.get(yielded) ?? 0) + removed);
                moved += removed;
              }
            } else if (adding && after > 0) {
              const gained = after - Math.max(before, 0);
              if (gained > 0) {
                collect.set(op.material, (collect.get(op.material) ?? 0) - gained);
                moved += gained;
              }
            }
          } else {
            moved += Math.abs(after - before);
          }

          this.density[index] = after;
          if (after > 0) {
            // Newly solid samples take the brush material; existing solid
            // ground keeps its own so digging never repaints a hillside.
            if (before <= 0) this.material[index] = adding ? op.material : (beforeMat === Mat.AIR ? Mat.STONE : beforeMat);
          } else {
            this.material[index] = Mat.AIR;
          }
        }
      }
    }
    // One dirty-marking pass per stroke rather than per sample.
    if (moved > 0) this.markSphereDirty(x, y, z, r);
    return moved;
  }

  /**
   * Player-driven edit. Refuses protected shrine ground and records the stroke
   * so it can be saved and replayed.
   */
  edit(op: TerrainOp, collect: Map<number, number>): { moved: number; blocked: boolean } {
    if (this.isProtected(op.x, op.y, op.z)) return { moved: 0, blocked: true };
    const moved = this.applyBrush(op, collect);
    if (moved > 0) pushOp(this.journal, op);
    return { moved, blocked: false };
  }

  /**
   * A temporary sculpted change (Raise Wall). Stores the exact previous field
   * values so the terrain is restored perfectly, and is never journalled.
   */
  addTemporary(op: TerrainOp, seconds: number): boolean {
    if (this.isProtected(op.x, op.y, op.z)) return false;
    const restore: TempEdit['restore'] = [];
    const moved = this.applyBrush(op, null, restore);
    if (moved <= 0) return false;
    this.temps.push({ op, expires: this.clock + seconds, restore });
    return true;
  }

  /** Estimated volume of a brush stroke, used for resource accounting. */
  static volumeOf(radius: number, strength: number): number {
    return brushVolume(radius, strength);
  }

  private markChunkDirty(cx: number, cy: number, cz: number): void {
    if (!validChunk(cx, cy, cz)) return;
    const idx = chunkIndex(cx, cy, cz);
    const chunk = this.chunks[idx]!;
    if (chunk.dirty) return;
    chunk.dirty = true;
    this.dirtyQueue.push(idx);
  }

  /**
   * Force every chunk whose meshing region touches a world-space sphere to
   * rebuild.
   *
   * A chunk meshes cells `[c*CHUNK-1 .. c*CHUNK+CHUNK-1]`, so it reads samples
   * one step outside its own box on the low side. The low bound therefore
   * reaches one chunk further than a naive division would suggest - that extra
   * chunk is exactly what prevents seams appearing at chunk borders after an
   * edit.
   */
  markSphereDirty(x: number, y: number, z: number, radius: number): void {
    // A sample s is read by chunks ceil(s/CHUNK)-1 .. floor((s+1)/CHUNK).
    const lo = (v: number): number => Math.ceil((v - radius) / CHUNK) - 1;
    const hi = (v: number): number => Math.floor((v + radius + 1) / CHUNK);
    const c0x = lo(x);
    const c1x = hi(x);
    const c0y = lo(y);
    const c1y = hi(y);
    const c0z = lo(z);
    const c1z = hi(z);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cz = c0z; cz <= c1z; cz++) this.markChunkDirty(cx, cy, cz);
      }
    }
  }

  // --------------------------------------------------------------- update

  update(dt: number, camera: THREE.Camera, renderDistance: number): void {
    this.clock += dt;

    // Expire temporary sculpted terrain.
    for (let i = this.temps.length - 1; i >= 0; i--) {
      const temp = this.temps[i]!;
      if (temp.expires > this.clock) continue;
      for (const entry of temp.restore) {
        const value = this.density[entry.index]! - entry.delta;
        this.density[entry.index] = value;
        // Put the original material back, but never leave solid ground marked
        // as air (another edit may have filled the sample since).
        this.material[entry.index] = value > 0
          ? (entry.material === Mat.AIR ? Mat.STONE : entry.material)
          : Mat.AIR;
      }
      this.markSphereDirty(temp.op.x, temp.op.y, temp.op.z, temp.op.radius + 1);
      this.temps.splice(i, 1);
    }

    this.pumpMeshQueue();

    const px = camera.position.x;
    const pz = camera.position.z;
    const maxD = renderDistance + CHUNK;
    const maxD2 = maxD * maxD;
    for (const chunk of this.chunks) {
      if (!chunk.mesh) continue;
      const dx = chunk.cx * CHUNK + CHUNK / 2 - px;
      const dz = chunk.cz * CHUNK + CHUNK / 2 - pz;
      chunk.mesh.visible = dx * dx + dz * dz <= maxD2;
    }
  }

  /** Process the dirty chunk queue inside a frame time budget. */
  private pumpMeshQueue(): void {
    if (this.dirtyQueue.length === 0) return;
    const start = performance.now();
    while (this.dirtyQueue.length > 0) {
      const idx = this.dirtyQueue.shift()!;
      const chunk = this.chunks[idx]!;
      if (!chunk.dirty) continue;
      if (this.worker) {
        this.dispatchToWorker(idx);
        // Worker jobs are cheap to queue; limit how many are in flight.
        if (this.pendingJobs.size >= 6) break;
      } else {
        this.buildChunkSync(idx);
        if (performance.now() - start > this.meshBudgetMs) break;
      }
    }
  }

  private extractBlock(chunk: ChunkRecord): { density: Float32Array; material: Uint8Array } {
    const n = CHUNK_SAMPLES;
    const density = new Float32Array(n * n * n);
    const material = new Uint8Array(n * n * n);
    const ox = chunk.cx * CHUNK - 1;
    const oy = chunk.cy * CHUNK - 1;
    const oz = chunk.cz * CHUNK - 1;

    for (let i = 0; i < n; i++) {
      const wx = ox + i;
      for (let j = 0; j < n; j++) {
        const wy = oy + j;
        for (let k = 0; k < n; k++) {
          const wz = oz + k;
          const di = (i * n + j) * n + k;
          if (inField(wx, wy, wz)) {
            const fi = fieldIndex(wx, wy, wz);
            density[di] = this.density[fi]!;
            material[di] = this.material[fi]!;
          } else {
            // Outside the field: below the floor is rock, elsewhere is sky.
            density[di] = wy < 0 ? DENSITY_CLAMP : -DENSITY_CLAMP;
            material[di] = wy < 0 ? Mat.STONE : Mat.AIR;
          }
        }
      }
    }
    return { density, material };
  }

  private dispatchToWorker(index: number): void {
    const chunk = this.chunks[index]!;
    chunk.dirty = false;
    chunk.pending = true;
    chunk.token++;
    const block = this.extractBlock(chunk);
    const id = this.nextJobId++;
    this.pendingJobs.set(id, { chunk: index, token: chunk.token });
    this.worker!.postMessage(
      {
        id,
        originX: chunk.cx * CHUNK,
        originY: chunk.cy * CHUNK,
        originZ: chunk.cz * CHUNK,
        density: block.density,
        material: block.material,
      },
      [block.density.buffer, block.material.buffer],
    );
  }

  private onWorkerMessage(event: MessageEvent): void {
    const data = event.data as {
      id: number; positions: Float32Array; normals: Float32Array;
      colors: Float32Array; indices: Uint32Array; triangles: number;
    };
    const job = this.pendingJobs.get(data.id);
    this.pendingJobs.delete(data.id);
    if (!job) return;
    const chunk = this.chunks[job.chunk]!;
    chunk.pending = false;
    // Discard results that a newer edit has already superseded.
    if (job.token !== chunk.token) return;
    this.commitMesh(chunk, data.positions, data.normals, data.colors, data.indices);
    this.remeshCount++;
  }

  private buildChunkSync(index: number): void {
    const chunk = this.chunks[index]!;
    chunk.dirty = false;
    chunk.token++;
    const block = this.extractBlock(chunk);
    const mesh = buildChunkMesh({
      density: block.density,
      material: block.material,
      originX: chunk.cx * CHUNK,
      originY: chunk.cy * CHUNK,
      originZ: chunk.cz * CHUNK,
    });
    this.commitMesh(chunk, mesh.positions, mesh.normals, mesh.colors, mesh.indices);
    this.remeshCount++;
  }

  private commitMesh(
    chunk: ChunkRecord,
    positions: Float32Array, normals: Float32Array, colors: Float32Array, indices: Uint32Array,
  ): void {
    if (chunk.mesh) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      chunk.mesh = null;
    }
    if (indices.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.terrainMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `chunk-${chunk.cx}-${chunk.cy}-${chunk.cz}`;
    this.group.add(mesh);
    chunk.mesh = mesh;
  }

  /** Number of chunks still waiting to be rebuilt. */
  get pendingChunks(): number {
    return this.dirtyQueue.length + this.pendingJobs.size;
  }

  setShadowCasting(enabled: boolean): void {
    for (const chunk of this.chunks) {
      if (chunk.mesh) chunk.mesh.castShadow = enabled;
    }
  }

  setMeshBudget(ms: number): void {
    this.meshBudgetMs = Math.max(2, ms);
  }

  dispose(): void {
    for (const chunk of this.chunks) {
      if (chunk.mesh) {
        this.group.remove(chunk.mesh);
        chunk.mesh.geometry.dispose();
        chunk.mesh = null;
      }
      chunk.dirty = true;
    }
    this.terrainMaterial.dispose();
    this.dirtyQueue.length = 0;
    this.temps.length = 0;
    this.pendingJobs.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
