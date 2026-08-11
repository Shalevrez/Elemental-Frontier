/**
 * Static and semi-static collision volumes for everything that is *not*
 * terrain: tree trunks, boulders, ruins, chests, shrine plinths, campfires and
 * temporary Earth walls.
 *
 * The smooth density field handles the ground. Props were previously drawn but
 * never collided with, so the player could walk straight through a tree. This
 * registry gives every visible solid a matching collision volume, keyed by the
 * same id the renderer uses, and resolves a vertical capsule out of them.
 *
 * Pure geometry - no Three.js - so the collision rules are unit-testable.
 */

export type ObstacleShape = 'cylinder' | 'box';

/**
 * A collision volume.
 *
 * `y` is the *base* (the ground contact height); the volume extends upward by
 * `height`. Cylinders use `radius`; boxes use `halfX` / `halfZ`.
 */
export interface Obstacle {
  id: number;
  /** What it is, purely for debug readouts and filtering. */
  kind: string;
  shape: ObstacleShape;
  x: number;
  y: number;
  z: number;
  radius: number;
  halfX: number;
  halfZ: number;
  height: number;
  /** Decorative volumes are registered but never block movement. */
  solid: boolean;
  /** Can be removed by attacks / terrain deformation. */
  destructible: boolean;
  /** Deformation and enemies must never delete this (portals, World Hearts). */
  protectedVolume: boolean;
}

export interface ObstacleInit {
  id: number;
  kind: string;
  x: number;
  y: number;
  z: number;
  height: number;
  radius?: number;
  halfX?: number;
  halfZ?: number;
  shape?: ObstacleShape;
  solid?: boolean;
  destructible?: boolean;
  protectedVolume?: boolean;
}

export interface PushOut {
  x: number;
  y: number;
  z: number;
  /** Contact normal of the deepest contact, for debug and slide handling. */
  nx: number;
  ny: number;
  nz: number;
  contacts: number;
}

/** Cell size of the spatial hash, in metres. */
const CELL = 8;

/** How far a capsule bottom may be below an obstacle top and still step onto it. */
export const OBSTACLE_STEP_TOLERANCE = 0.6;

function key(cx: number, cz: number): number {
  // 16-bit packing is plenty for a 256m world at 8m cells.
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

export class ObstacleField {
  private readonly cells = new Map<number, Obstacle[]>();
  private readonly byId = new Map<number, Obstacle>();
  private nextAutoId = 1_000_000;

  get size(): number {
    return this.byId.size;
  }

  /** Every registered volume, for debug drawing and tests. */
  all(): Obstacle[] {
    return [...this.byId.values()];
  }

  clear(): void {
    this.cells.clear();
    this.byId.clear();
  }

  /** Allocate an id that cannot collide with the caller's own numbering. */
  reserveId(): number {
    return this.nextAutoId++;
  }

  add(init: ObstacleInit): Obstacle {
    const o: Obstacle = {
      id: init.id,
      kind: init.kind,
      shape: init.shape ?? 'cylinder',
      x: init.x,
      y: init.y,
      z: init.z,
      radius: Math.max(0.05, init.radius ?? Math.max(init.halfX ?? 0.5, init.halfZ ?? 0.5)),
      halfX: init.halfX ?? init.radius ?? 0.5,
      halfZ: init.halfZ ?? init.radius ?? 0.5,
      height: Math.max(0.05, init.height),
      solid: init.solid !== false,
      destructible: init.destructible === true,
      protectedVolume: init.protectedVolume === true,
    };
    this.remove(o.id);
    this.byId.set(o.id, o);
    for (const k of this.keysFor(o)) {
      const list = this.cells.get(k);
      if (list) list.push(o);
      else this.cells.set(k, [o]);
    }
    return o;
  }

  remove(id: number): boolean {
    const existing = this.byId.get(id);
    if (!existing) return false;
    this.byId.delete(id);
    for (const k of this.keysFor(existing)) {
      const list = this.cells.get(k);
      if (!list) continue;
      const i = list.indexOf(existing);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.cells.delete(k);
    }
    return true;
  }

  get(id: number): Obstacle | null {
    return this.byId.get(id) ?? null;
  }

  private keysFor(o: Obstacle): number[] {
    const ex = o.shape === 'box' ? o.halfX : o.radius;
    const ez = o.shape === 'box' ? o.halfZ : o.radius;
    const x0 = Math.floor((o.x - ex) / CELL);
    const x1 = Math.floor((o.x + ex) / CELL);
    const z0 = Math.floor((o.z - ez) / CELL);
    const z1 = Math.floor((o.z + ez) / CELL);
    const out: number[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) out.push(key(cx, cz));
    }
    return out;
  }

  /** Obstacles whose footprint could touch a circle at (x, z). */
  query(x: number, z: number, radius: number, out: Obstacle[] = []): Obstacle[] {
    out.length = 0;
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL);
    const z1 = Math.floor((z + radius) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(key(cx, cz));
        if (!list) continue;
        for (const o of list) if (!out.includes(o)) out.push(o);
      }
    }
    return out;
  }

  /**
   * True when a vertical capsule of the given footprint overlaps any solid
   * volume. `stepTolerance` lets a body that is resting on top of a low
   * obstacle (a chest, a kerb) not count as overlapping it.
   */
  overlaps(
    x: number, baseY: number, z: number, radius: number, height: number,
    stepTolerance = OBSTACLE_STEP_TOLERANCE,
  ): boolean {
    const found = this.query(x, z, radius + 1.5, _scratch);
    for (const o of found) {
      if (!o.solid) continue;
      const top = o.y + o.height;
      if (baseY >= top - stepTolerance) continue;
      if (baseY + height <= o.y) continue;
      if (this.horizontalOverlap(o, x, z, radius) > 0) return true;
    }
    return false;
  }

  /** Penetration depth of a circle into an obstacle footprint; 0 = no overlap. */
  private horizontalOverlap(o: Obstacle, x: number, z: number, radius: number): number {
    if (o.shape === 'box') {
      const dx = Math.abs(x - o.x) - o.halfX;
      const dz = Math.abs(z - o.z) - o.halfZ;
      if (dx > radius || dz > radius) return 0;
      if (dx <= 0 && dz <= 0) return radius + Math.min(-dx, -dz);
      const ox = Math.max(0, dx);
      const oz = Math.max(0, dz);
      const d = Math.hypot(ox, oz);
      return d < radius ? radius - d : 0;
    }
    const dx = x - o.x;
    const dz = z - o.z;
    const d = Math.hypot(dx, dz);
    const reach = o.radius + radius;
    return d < reach ? reach - d : 0;
  }

  /**
   * Push a vertical capsule out of every solid volume it overlaps.
   *
   * Resolution is horizontal only: a body is never teleported on top of a tree.
   * Standing surfaces are handled separately by `supportHeight`.
   */
  resolveCapsule(
    x: number, baseY: number, z: number, radius: number, height: number,
    out: PushOut,
    stepTolerance = OBSTACLE_STEP_TOLERANCE,
  ): PushOut {
    out.x = 0; out.y = 0; out.z = 0;
    out.nx = 0; out.ny = 0; out.nz = 0;
    out.contacts = 0;

    const found = this.query(x + out.x, z + out.z, radius + 1.5, _scratch);
    let deepest = 0;
    for (const o of found) {
      if (!o.solid) continue;
      const top = o.y + o.height;
      // Resting on top of it? Then it is a floor, not a wall.
      if (baseY >= top - stepTolerance) continue;
      if (baseY + height <= o.y) continue;

      const px = x + out.x;
      const pz = z + out.z;
      const depth = this.horizontalOverlap(o, px, pz, radius);
      if (depth <= 0) continue;

      let nx = px - o.x;
      let nz = pz - o.z;
      if (o.shape === 'box') {
        // Push along the shallowest box axis so corners resolve cleanly.
        const overlapX = o.halfX + radius - Math.abs(px - o.x);
        const overlapZ = o.halfZ + radius - Math.abs(pz - o.z);
        if (overlapX < overlapZ) { nz = 0; } else { nx = 0; }
      }
      const len = Math.hypot(nx, nz);
      if (len < 1e-5) { nx = 1; nz = 0; } else { nx /= len; nz /= len; }

      out.x += nx * depth;
      out.z += nz * depth;
      out.contacts++;
      if (depth > deepest) {
        deepest = depth;
        out.nx = nx; out.ny = 0; out.nz = nz;
      }
    }
    return out;
  }

  /**
   * Highest solid surface a body at (x, z) could be standing on, searching
   * downward from `fromY`. Returns null when nothing is under it.
   */
  supportHeight(x: number, z: number, fromY: number, radius: number): number | null {
    const found = this.query(x, z, radius + 1.5, _scratch);
    let best: number | null = null;
    for (const o of found) {
      if (!o.solid) continue;
      if (this.horizontalOverlap(o, x, z, radius) <= 0) continue;
      const top = o.y + o.height;
      if (top > fromY + OBSTACLE_STEP_TOLERANCE) continue;
      if (best === null || top > best) best = top;
    }
    return best;
  }

  /** Remove every volume whose kind matches, e.g. all temporary earth walls. */
  removeKind(kind: string): number {
    let n = 0;
    for (const o of this.all()) {
      if (o.kind === kind) { this.remove(o.id); n++; }
    }
    return n;
  }

  /** Remove destructible volumes inside a sphere. Protected ones survive. */
  breakInSphere(x: number, y: number, z: number, radius: number): Obstacle[] {
    const broken: Obstacle[] = [];
    for (const o of this.query(x, z, radius + 2, _scratch).slice()) {
      if (!o.destructible || o.protectedVolume) continue;
      const dx = o.x - x;
      const dz = o.z - z;
      if (Math.hypot(dx, dz) > radius + o.radius) continue;
      if (y + radius < o.y || y - radius > o.y + o.height) continue;
      this.remove(o.id);
      broken.push(o);
    }
    return broken;
  }
}

const _scratch: Obstacle[] = [];

export function createPushOut(): PushOut {
  return { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, contacts: 0 };
}
