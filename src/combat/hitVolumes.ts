/**
 * Collision volumes for combat.
 *
 * Enemies are vertical capsules, not points. Attacks are swept spheres, cones
 * or capsules whose radius matches what the player can see. Everything here is
 * plain arithmetic on `{x, y, z}` literals - no Three.js - so the maths that
 * decides whether a shot connects is directly unit-testable.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A vertical capsule: a segment from `a` to `b` swollen by `radius`. */
export interface Capsule {
  a: Vec3;
  b: Vec3;
  radius: number;
}

export function vec(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function sub(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function normalise(a: Vec3, out: Vec3): Vec3 {
  const len = length(a) || 1;
  out.x = a.x / len;
  out.y = a.y / len;
  out.z = a.z / len;
  return out;
}

export function lerpVec(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * Build the capsule that represents a standing creature.
 *
 * `footY` is the ground contact point, so the capsule spans the whole body
 * rather than sitting at an arbitrary mid-point. That is what lets the player
 * hit a tall creature's head or a small one's feet.
 */
export function bodyCapsule(
  x: number, footY: number, z: number,
  height: number, radius: number,
  padding = 0,
): Capsule {
  const r = Math.max(0.05, radius + padding);
  // Keep the caps inside the body so a short creature stays roughly spherical.
  const half = Math.max(r, height * 0.5);
  const lowY = footY + Math.min(r, height * 0.5);
  const highY = footY + Math.max(height - r, Math.min(r, height * 0.5));
  void half;
  return {
    a: { x, y: lowY, z },
    b: { x, y: highY, z },
    radius: r,
  };
}

const _p = vec();
const _q = vec();
const _d1 = vec();
const _d2 = vec();
const _r = vec();

/** Closest point on segment `a`-`b` to `p`, as a 0..1 parameter. */
export function closestParamOnSegment(a: Vec3, b: Vec3, p: Vec3): number {
  sub(b, a, _d1);
  const denom = lengthSq(_d1);
  if (denom < 1e-9) return 0;
  sub(p, a, _r);
  return Math.max(0, Math.min(1, dot(_r, _d1) / denom));
}

/** Squared distance from point `p` to segment `a`-`b`. */
export function pointSegmentDistanceSq(a: Vec3, b: Vec3, p: Vec3): number {
  const t = closestParamOnSegment(a, b, p);
  lerpVec(a, b, t, _q);
  return lengthSq(sub(p, _q, _p));
}

/**
 * Squared distance between two segments, plus the parameter along the first.
 *
 * Standard clamped-parameter solution (Ericson, Real-Time Collision
 * Detection). Handles the degenerate cases where either segment is a point.
 */
export function segmentSegmentDistanceSq(
  p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3,
): { distSq: number; s: number; t: number } {
  sub(q1, p1, _d1);
  sub(q2, p2, _d2);
  sub(p1, p2, _r);
  const a = lengthSq(_d1);
  const e = lengthSq(_d2);
  const f = dot(_d2, _r);

  let s: number;
  let t: number;

  if (a <= 1e-9 && e <= 1e-9) {
    // Both segments are points.
    return { distSq: lengthSq(_r), s: 0, t: 0 };
  }
  if (a <= 1e-9) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(_d1, _r);
    if (e <= 1e-9) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dot(_d1, _d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const cx = p1.x + _d1.x * s - (p2.x + _d2.x * t);
  const cy = p1.y + _d1.y * s - (p2.y + _d2.y * t);
  const cz = p1.z + _d1.z * s - (p2.z + _d2.z * t);
  return { distSq: cx * cx + cy * cy + cz * cz, s, t };
}

export interface SweepHit {
  hit: boolean;
  /** Fraction along the sweep where contact first occurs, 0..1. */
  t: number;
  /** Approximate contact point. */
  point: Vec3;
}

const _miss: SweepHit = { hit: false, t: 1, point: vec() };

/**
 * Swept sphere against a capsule.
 *
 * This is the test that stops fast projectiles tunnelling: the sphere's whole
 * path from the previous frame to this one is considered, not just where it
 * happens to be right now.
 */
export function sweptSphereVsCapsule(
  from: Vec3, to: Vec3, sphereRadius: number, capsule: Capsule,
): SweepHit {
  const combined = sphereRadius + capsule.radius;
  const result = segmentSegmentDistanceSq(from, to, capsule.a, capsule.b);
  if (result.distSq > combined * combined) {
    return { hit: false, t: 1, point: vec(to.x, to.y, to.z) };
  }
  // `s` is the closest approach; use it as the contact time. Good enough for
  // gameplay and far cheaper than solving the quadratic exactly.
  const point = lerpVec(from, to, result.s, vec());
  return { hit: true, t: result.s, point };
}

/** Sphere overlap against a capsule - the instant-attack version. */
export function sphereVsCapsule(centre: Vec3, radius: number, capsule: Capsule): boolean {
  const combined = radius + capsule.radius;
  return pointSegmentDistanceSq(capsule.a, capsule.b, centre) <= combined * combined;
}

/**
 * Capsule against capsule - used by the continuous Water Whip stream, whose
 * volume really is a thick line from the hand to the target.
 */
export function capsuleVsCapsule(a: Capsule, b: Capsule): boolean {
  const combined = a.radius + b.radius;
  return segmentSegmentDistanceSq(a.a, a.b, b.a, b.b).distSq <= combined * combined;
}

/**
 * Cone test against a capsule.
 *
 * A creature counts as inside the cone when the closest point of its body -
 * not its centre - falls inside, so a tall creature clipped by the edge of a
 * Gust is still caught.
 */
export function coneVsCapsule(
  origin: Vec3, direction: Vec3, range: number, cosHalfAngle: number, capsule: Capsule,
): boolean {
  // Closest point on the body to the cone origin.
  const t = closestParamOnSegment(capsule.a, capsule.b, origin);
  lerpVec(capsule.a, capsule.b, t, _q);
  sub(_q, origin, _p);
  const dist = length(_p);
  if (dist > range + capsule.radius) return false;
  if (dist < 1e-4) return true;

  normalise(_p, _p);
  const cos = dot(_p, direction);
  if (cos >= cosHalfAngle) return true;

  // Near the origin a fat body can still overlap the cone even when its centre
  // is outside the angle; widen the test by the body radius.
  const angularSlack = Math.atan2(capsule.radius, Math.max(0.001, dist));
  const halfAngle = Math.acos(Math.max(-1, Math.min(1, cosHalfAngle)));
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= halfAngle + angularSlack;
}

/** Angle in radians between a direction and the line from origin to a point. */
export function angleTo(origin: Vec3, direction: Vec3, point: Vec3): number {
  sub(point, origin, _p);
  const len = length(_p);
  if (len < 1e-6) return 0;
  normalise(_p, _p);
  return Math.acos(Math.max(-1, Math.min(1, dot(_p, direction))));
}

export { _miss as MISS };
