/**
 * First-person aiming.
 *
 * The rule this module enforces: **the attack goes where the crosshair is
 * pointing.** Every ability resolves its direction the same way:
 *
 *   1. Cast a ray from the camera centre.
 *   2. Take the first thing it meets - terrain or the maximum range - as the
 *      intended target point.
 *   3. Build the attack direction from the *casting origin* toward that point,
 *      so an effect that visually leaves the hand still converges on what the
 *      crosshair selected.
 *
 * Aim assist is deliberately small: it can bend the shot by a few degrees
 * toward a creature the crosshair is already nearly on, and it will never
 * reach through a wall, past the ability's range, or onto something the player
 * cannot see.
 *
 * Engine-free so all of it is unit-testable.
 */

import { AIM } from './combatConfig';
import {
  angleTo, distance, dot, length, lengthSq, normalise, sub, vec,
  type Capsule, type Vec3,
} from './hitVolumes';

/** Minimal view of the world the aiming code needs. */
export interface AimWorld {
  /**
   * First solid surface along a ray.
   * @returns distance along the ray, or null when nothing was hit.
   */
  raycastDistance(origin: Vec3, direction: Vec3, maxDistance: number): number | null;
}

/** A candidate the aim assist may consider. */
export interface AimCandidate {
  id: number;
  capsule: Capsule;
  /** Body centre, used for the line-of-sight probe and distance sorting. */
  centre: Vec3;
}

export type MissReason = 'none' | 'out-of-range' | 'blocked' | 'no-target';

export interface AimSolution {
  /** Point the crosshair selected. */
  target: Vec3;
  /** Normalised direction from the casting origin toward the target. */
  direction: Vec3;
  /** Distance from the camera to the target point. */
  distance: number;
  /** True when terrain, not the range limit, stopped the ray. */
  blockedByTerrain: boolean;
  /** Candidate the crosshair is on (or was nudged onto), if any. */
  targetId: number | null;
  /** Whether aim assist actually changed the direction. */
  assisted: boolean;
}

const _dir = vec();
const _tmp = vec();
const _toTarget = vec();

/**
 * Resolve where the player is aiming.
 *
 * @param eye camera position
 * @param forward normalised camera forward
 * @param maxRange the ability's reach
 * @param origin where the visual effect starts (hand); direction is measured
 *        from here so the effect converges on the crosshair target
 */
export function resolveAim(
  eye: Vec3,
  forward: Vec3,
  maxRange: number,
  world: AimWorld,
  candidates: readonly AimCandidate[] = [],
  origin: Vec3 = eye,
  assist = true,
): AimSolution {
  // ---- 1. what is the crosshair on?
  const terrainDist = world.raycastDistance(eye, forward, maxRange);
  const blockedByTerrain = terrainDist !== null;
  let hitDistance = terrainDist ?? maxRange;

  // ---- 2. is a creature closer along that ray than the terrain is?
  let targetId: number | null = null;
  let bestAngle = Infinity;
  let bestCandidate: AimCandidate | null = null;

  if (candidates.length > 0) {
    for (const candidate of candidates) {
      const dist = distance(eye, candidate.centre);
      if (dist > Math.min(maxRange, AIM.assistRange)) continue;

      const angle = angleTo(eye, forward, candidate.centre);
      // Only consider things roughly in front of the crosshair.
      if (angle > AIM.assistHalfAngle * 3) continue;

      // A creature behind a wall is never a valid target.
      sub(candidate.centre, eye, _toTarget);
      const len = length(_toTarget) || 1;
      normalise(_toTarget, _toTarget);
      const wall = world.raycastDistance(eye, _toTarget, len - 0.35);
      if (wall !== null) continue;

      if (angle < bestAngle) {
        bestAngle = angle;
        bestCandidate = candidate;
      }
    }
  }

  // ---- 3. build the target point
  const target = vec(
    eye.x + forward.x * hitDistance,
    eye.y + forward.y * hitDistance,
    eye.z + forward.z * hitDistance,
  );

  let assisted = false;
  if (bestCandidate) {
    targetId = bestCandidate.id;
    const withinAssist = bestAngle <= AIM.assistHalfAngle;
    const creatureDist = distance(eye, bestCandidate.centre);
    // Only aim at the creature if it is in front of whatever terrain we hit.
    if (creatureDist <= hitDistance + bestCandidate.capsule.radius) {
      if (assist && withinAssist) {
        // Bend a few degrees toward the body centre.
        target.x += (bestCandidate.centre.x - target.x) * AIM.assistStrength;
        target.y += (bestCandidate.centre.y - target.y) * AIM.assistStrength;
        target.z += (bestCandidate.centre.z - target.z) * AIM.assistStrength;
        assisted = true;
        hitDistance = distance(eye, target);
      }
    } else {
      // The creature is behind the terrain the crosshair actually hit.
      targetId = null;
    }
  }

  // ---- 4. direction is measured from the casting origin, not the camera
  sub(target, origin, _dir);
  if (lengthSq(_dir) < 1e-8) {
    _dir.x = forward.x;
    _dir.y = forward.y;
    _dir.z = forward.z;
  } else {
    normalise(_dir, _dir);
  }

  return {
    target,
    direction: vec(_dir.x, _dir.y, _dir.z),
    distance: hitDistance,
    blockedByTerrain,
    targetId,
    assisted,
  };
}

/**
 * Can the attacker see the point?
 *
 * Used to stop cones and area effects reaching through walls. A small
 * shortening keeps a creature standing flush against a wall reachable.
 */
export function hasLineOfSight(from: Vec3, to: Vec3, world: AimWorld, slack = 0.4): boolean {
  sub(to, from, _tmp);
  const len = length(_tmp);
  if (len <= slack) return true;
  normalise(_tmp, _tmp);
  return world.raycastDistance(from, _tmp, len - slack) === null;
}

/**
 * Which candidate should the crosshair highlight?
 *
 * Prefers the one nearest the crosshair, respecting range and line of sight.
 * This is what drives the "targeted" crosshair state, so the player can tell
 * before firing whether the shot will land.
 */
export function pickCrosshairTarget(
  eye: Vec3,
  forward: Vec3,
  maxRange: number,
  world: AimWorld,
  candidates: readonly AimCandidate[],
): { id: number; angle: number; distance: number } | null {
  let best: { id: number; angle: number; distance: number } | null = null;
  for (const candidate of candidates) {
    const dist = distance(eye, candidate.centre);
    if (dist > maxRange) continue;
    const angle = angleTo(eye, forward, candidate.centre);
    if (angle > AIM.targetHighlightAngle) continue;
    if (!hasLineOfSight(eye, candidate.centre, world)) continue;
    if (!best || angle < best.angle) best = { id: candidate.id, angle, distance: dist };
  }
  return best;
}

/**
 * Per-target damage-interval bookkeeping for continuous attacks.
 *
 * A stream that ticks every frame would delete a creature instantly and feel
 * random; this makes the damage rate explicit and frame-rate independent.
 */
export class DamageIntervalTracker {
  private last = new Map<number, number>();

  /** True when this target may be damaged again at time `now`. */
  ready(id: number, now: number, interval: number): boolean {
    const previous = this.last.get(id);
    return previous === undefined || now - previous >= interval;
  }

  /** Record a damage tick. */
  mark(id: number, now: number): void {
    this.last.set(id, now);
  }

  /** Convenience: check and mark in one call. */
  tryTick(id: number, now: number, interval: number): boolean {
    if (!this.ready(id, now, interval)) return false;
    this.mark(id, now);
    return true;
  }

  clear(): void {
    this.last.clear();
  }

  get size(): number {
    return this.last.size;
  }
}

/** Dot product helper re-exported so callers need only this module. */
export { dot };
