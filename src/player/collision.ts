/**
 * Player collision core.
 *
 * The body is a vertical capsule sampled as a stack of spheres against the
 * smooth density field, plus a separate pass against the static obstacle field
 * (trees, boulders, ruins, chests, raised walls).
 *
 * The rules implemented here:
 *   - swept motion, so a fast body cannot tunnel through thin geometry,
 *   - depenetration along the real surface gradient,
 *   - ground detection with a slope limit,
 *   - step-up over low ledges,
 *   - ceiling contact that kills upward velocity,
 *   - sliding: only the component of velocity going *into* a surface is removed.
 *
 * Everything is pure and engine-free so the behaviour can be unit-tested.
 */

import type { ObstacleField, PushOut } from '../world/Obstacles';
import { createPushOut } from '../world/Obstacles';

export const PLAYER_HEIGHT = 1.78;
export const PLAYER_RADIUS = 0.35;
export const EYE_HEIGHT = 1.6;

/** Highest ledge the player walks up without jumping. */
export const STEP_HEIGHT = 0.62;
/** Steepest surface that still counts as walkable ground (~50 degrees). */
export const MAX_WALKABLE_NORMAL_Y = 0.64;
/** A contact normal pointing this far down is a ceiling. */
export const CEILING_NORMAL_Y = -0.4;
/** The capsule is placed this far above the floor after a respawn. */
export const FLOOR_CLEARANCE = 0.06;
/** Longest distance integrated in one collision substep. */
export const MAX_SUBSTEP = 0.22;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The subset of the world the collision code needs. */
export interface DensityField {
  /** > 0 inside solid terrain; roughly a signed distance near the surface. */
  densityAt(x: number, y: number, z: number): number;
  /** Outward surface normal of the density field. */
  normalAt(x: number, y: number, z: number, out: Vec3Like): Vec3Like;
}

/** Sphere stack approximating the capsule, as [heightOffset, radius]. */
export const BODY_SPHERES: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([0.36, PLAYER_RADIUS] as const),
  Object.freeze([0.95, PLAYER_RADIUS] as const),
  Object.freeze([1.5, 0.32] as const),
]);

export interface ContactReport {
  /** A contact normal pointed up enough to stand on. */
  grounded: boolean;
  /** A contact normal pointed down: the body hit a ceiling. */
  ceiling: boolean;
  /** The body touched something too steep to stand on. */
  steep: boolean;
  /** Number of depenetration corrections applied. */
  corrections: number;
  /** Deepest contact normal this frame. */
  nx: number;
  ny: number;
  nz: number;
}

export function createContactReport(): ContactReport {
  return { grounded: false, ceiling: false, steep: false, corrections: 0, nx: 0, ny: 1, nz: 0 };
}

/** True when the capsule at this position overlaps solid terrain. */
export function terrainOverlap(field: DensityField, x: number, y: number, z: number, slack = 0.12): boolean {
  for (const [oy, radius] of BODY_SPHERES) {
    if (field.densityAt(x, y + oy, z) + radius > slack) return true;
  }
  return false;
}

/** Deepest penetration of the capsule into terrain, negative when clear. */
export function penetrationDepth(field: DensityField, x: number, y: number, z: number): number {
  let worst = -Infinity;
  for (const [oy, radius] of BODY_SPHERES) {
    const d = field.densityAt(x, y + oy, z) + radius;
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Push a capsule out of solid terrain and out of every solid obstacle.
 *
 * The position vector is modified in place. Velocity, when supplied, has the
 * component going into each contact removed, which is what produces sliding
 * along walls instead of sticking to them.
 */
export function depenetrate(
  field: DensityField,
  position: Vec3Like,
  velocity: Vec3Like | null,
  obstacles: ObstacleField | null,
  report: ContactReport,
  iterations = 6,
): ContactReport {
  report.grounded = false;
  report.ceiling = false;
  report.steep = false;
  report.corrections = 0;

  for (let i = 0; i < iterations; i++) {
    let worst = 0;
    let worstOffset = 0;
    for (const [oy, radius] of BODY_SPHERES) {
      const d = field.densityAt(position.x, position.y + oy, position.z) + radius;
      if (d > worst) { worst = d; worstOffset = oy; }
    }
    if (worst <= 0.001) break;

    field.normalAt(position.x, position.y + worstOffset, position.z, _n);
    if (_n.x * _n.x + _n.y * _n.y + _n.z * _n.z < 1e-6) { _n.x = 0; _n.y = 1; _n.z = 0; }

    const push = Math.min(0.5, worst);
    position.x += _n.x * push;
    position.y += _n.y * push;
    position.z += _n.z * push;
    report.corrections++;
    report.nx = _n.x; report.ny = _n.y; report.nz = _n.z;

    if (_n.y >= MAX_WALKABLE_NORMAL_Y) report.grounded = true;
    else if (_n.y > 0.05) report.steep = true;
    if (_n.y <= CEILING_NORMAL_Y) report.ceiling = true;

    if (velocity) {
      const into = velocity.x * _n.x + velocity.y * _n.y + velocity.z * _n.z;
      if (into < 0) {
        velocity.x -= _n.x * into;
        velocity.y -= _n.y * into;
        velocity.z -= _n.z * into;
      }
    }
  }

  if (obstacles) {
    for (let i = 0; i < 3; i++) {
      obstacles.resolveCapsule(
        position.x, position.y, position.z, PLAYER_RADIUS, PLAYER_HEIGHT, _push,
      );
      if (_push.contacts === 0) break;
      position.x += _push.x;
      position.z += _push.z;
      report.corrections++;
      report.nx = _push.nx; report.ny = 0; report.nz = _push.nz;
      if (velocity) {
        const into = velocity.x * _push.nx + velocity.z * _push.nz;
        if (into < 0) {
          velocity.x -= _push.nx * into;
          velocity.z -= _push.nz * into;
        }
      }
    }
  }

  return report;
}

/**
 * Move a capsule by `delta`, resolving collision after every substep.
 *
 * Substeps are capped at `MAX_SUBSTEP` so nothing thinner than the step size
 * can be crossed in a single frame - the fix for tunnelling through walls and
 * newly raised earth at high speed.
 */
export function sweepMove(
  field: DensityField,
  position: Vec3Like,
  velocity: Vec3Like,
  delta: Vec3Like,
  obstacles: ObstacleField | null,
  report: ContactReport,
): ContactReport {
  const distance = Math.hypot(delta.x, delta.y, delta.z);
  const steps = Math.max(1, Math.min(16, Math.ceil(distance / MAX_SUBSTEP)));
  const inv = 1 / steps;

  const aggregate = createContactReport();
  aggregate.grounded = false;

  for (let s = 0; s < steps; s++) {
    const beforeX = position.x;
    const beforeZ = position.z;

    position.x += delta.x * inv;
    position.y += delta.y * inv;
    position.z += delta.z * inv;

    depenetrate(field, position, velocity, obstacles, report);

    aggregate.grounded ||= report.grounded;
    aggregate.ceiling ||= report.ceiling;
    aggregate.steep ||= report.steep;
    aggregate.corrections += report.corrections;
    if (report.corrections > 0) {
      aggregate.nx = report.nx; aggregate.ny = report.ny; aggregate.nz = report.nz;
    }

    // ---- step-up: horizontal progress was cancelled by something low enough
    // to walk over. Lift the body and retry the remaining horizontal motion.
    const wantedX = delta.x * inv;
    const wantedZ = delta.z * inv;
    if ((wantedX !== 0 || wantedZ !== 0) && report.corrections > 0 && !report.grounded) {
      const movedX = position.x - beforeX;
      const movedZ = position.z - beforeZ;
      const wanted = Math.hypot(wantedX, wantedZ);
      const moved = Math.hypot(movedX, movedZ);
      if (wanted > 1e-4 && moved < wanted * 0.55) {
        const stepped = tryStepUp(field, position, wantedX, wantedZ, obstacles);
        if (stepped) aggregate.grounded = true;
      }
    }
  }

  report.grounded = aggregate.grounded;
  report.ceiling = aggregate.ceiling;
  report.steep = aggregate.steep;
  report.corrections = aggregate.corrections;
  report.nx = aggregate.nx; report.ny = aggregate.ny; report.nz = aggregate.nz;
  return report;
}

/**
 * Attempt to climb a ledge no taller than `STEP_HEIGHT`.
 *
 * Returns true when the body ended up on top of the ledge; otherwise the
 * position is restored exactly, so a failed step costs nothing.
 */
export function tryStepUp(
  field: DensityField,
  position: Vec3Like,
  dx: number,
  dz: number,
  obstacles: ObstacleField | null,
): boolean {
  const ox = position.x;
  const oy = position.y;
  const oz = position.z;

  for (let lift = 0.2; lift <= STEP_HEIGHT + 1e-6; lift += 0.2) {
    position.x = ox;
    position.y = oy + lift;
    position.z = oz;
    if (terrainOverlap(field, position.x, position.y, position.z, 0.02)) continue;

    position.x = ox + dx;
    position.z = oz + dz;
    if (terrainOverlap(field, position.x, position.y, position.z, 0.02)) continue;
    if (obstacles?.overlaps(position.x, position.y, position.z, PLAYER_RADIUS, PLAYER_HEIGHT)) continue;

    // Settle back down onto the ledge so the player does not float.
    for (let drop = 0; drop <= lift + 0.02; drop += 0.05) {
      const y = oy + lift - drop;
      if (terrainOverlap(field, position.x, y, position.z, 0.02)) {
        position.y = y + 0.05;
        return true;
      }
    }
    position.y = oy + lift;
    return true;
  }

  position.x = ox;
  position.y = oy;
  position.z = oz;
  return false;
}

/**
 * Ground probe used when no depenetration contact happened - standing exactly
 * on the surface must still count as grounded. Also reports the slope so the
 * caller can refuse to treat a cliff face as a floor.
 */
export function probeGround(
  field: DensityField,
  position: Vec3Like,
  velocityY: number,
  obstacles: ObstacleField | null,
): { grounded: boolean; normalY: number } {
  if (velocityY > 0.5) return { grounded: false, normalY: 1 };

  const support = obstacles?.supportHeight(position.x, position.z, position.y + 0.05, PLAYER_RADIUS) ?? null;
  if (support !== null && position.y - support <= 0.2 && position.y - support >= -0.2) {
    return { grounded: true, normalY: 1 };
  }

  const d = field.densityAt(position.x, position.y - 0.14, position.z);
  if (d <= -0.05) return { grounded: false, normalY: 1 };
  field.normalAt(position.x, position.y - 0.14, position.z, _n);
  const ny = _n.y;
  return { grounded: ny >= MAX_WALKABLE_NORMAL_Y || ny === 0, normalY: ny };
}

const _n: Vec3Like = { x: 0, y: 1, z: 0 };
const _push: PushOut = createPushOut();
