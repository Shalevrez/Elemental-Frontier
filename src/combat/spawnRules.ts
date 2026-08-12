/**
 * Spawn placement validation.
 *
 * A creature appearing out of nothing is the single most immersion-breaking
 * thing a first-person game can do, so a candidate point has to survive every
 * one of these before anything is placed on it:
 *
 *  - far enough away, and *further* when the player can actually see the spot
 *  - outside the close-range slice directly in front of and directly behind
 *  - on solid, level-enough ground with room to stand up in
 *  - not in water, not in lava, not inside terrain, not inside an obstacle
 *  - not on top of a shrine or another protected structure
 *  - somewhere a creature can walk out of
 *
 * The whole module is a pure predicate over a probe interface, so the rules
 * are tested against a synthetic world rather than against the renderer.
 */

import { SPAWN } from './combatConfig';

export type SpawnRejection =
  | 'out-of-bounds'
  | 'too-close-visible'
  | 'too-close-front'
  | 'too-close-rear'
  | 'too-far'
  | 'inside-terrain'
  | 'no-headroom'
  | 'no-ground'
  | 'in-water'
  | 'in-lava'
  | 'obstacle'
  | 'protected'
  | 'unreachable';

/** What the validator needs to be able to ask the world. */
export interface SpawnWorldProbe {
  /** Surface height at a column. */
  groundHeight(x: number, z: number): number;
  /** Is this point inside solid terrain? */
  isSolid(x: number, y: number, z: number): boolean;
  /** Can the player's eye see this point? */
  hasLineOfSight(x: number, y: number, z: number): boolean;
  /** Surface height of the world's fluid, and what that fluid is. */
  fluidLevel: number;
  fluidIsHazard: boolean;
  /** Is this point inside a non-terrain solid, e.g. a prop or a boulder? */
  isObstacle(x: number, y: number, z: number): boolean;
  /** Distance to the nearest protected structure - a shrine, a portal, a camp. */
  distanceToProtected(x: number, z: number): number;
}

export interface SpawnRequest {
  /** Candidate column. */
  x: number;
  z: number;
  /** Player position and eye height. */
  playerX: number;
  playerY: number;
  playerZ: number;
  /** Normalised horizontal facing. */
  forwardX: number;
  forwardZ: number;
  /** Half-angle of the player's view cone, in radians. */
  frontHalfAngle: number;
  /** True for creatures that are designed to live in the world's fluid. */
  hazardTolerant?: boolean;
  /** True for flying creatures, which need less from the ground below them. */
  flying?: boolean;
}

export interface SpawnCheck {
  ok: boolean;
  reason?: SpawnRejection;
  /** Ground height chosen for the creature's feet, when the point is valid. */
  y: number;
  /** Distance from the player. */
  distance: number;
  /** True when the point was inside the player's forward cone. */
  inFront: boolean;
  /** True when the player could actually have seen it appear. */
  visible: boolean;
}

function fail(reason: SpawnRejection, distance: number, inFront: boolean, visible: boolean): SpawnCheck {
  return { ok: false, reason, y: 0, distance, inFront, visible };
}

/**
 * Validate one candidate spawn column.
 *
 * `worldSize` bounds the playable area; `margin` keeps creatures off the very
 * edge, where they have nowhere to retreat to.
 */
export function validateSpawn(
  req: SpawnRequest,
  probe: SpawnWorldProbe,
  worldSize: number,
  margin = 6,
): SpawnCheck {
  const dx = req.x - req.playerX;
  const dz = req.z - req.playerZ;
  const distance = Math.hypot(dx, dz);
  const len = distance || 1;
  const dot = (dx / len) * req.forwardX + (dz / len) * req.forwardZ;
  const inFront = dot >= Math.cos(req.frontHalfAngle);

  if (req.x < margin || req.z < margin || req.x > worldSize - margin || req.z > worldSize - margin) {
    return fail('out-of-bounds', distance, inFront, false);
  }
  if (distance > SPAWN.maxDistance) return fail('too-far', distance, inFront, false);

  const ground = probe.groundHeight(req.x, req.z);
  if (!Number.isFinite(ground) || ground <= 0) return fail('no-ground', distance, inFront, false);

  // ---- fluids. Lava is never a spawn surface for anything that is not built
  // for it; water is never a spawn surface at all, because a creature dropped
  // into it has no footing to fight from.
  if (ground < probe.fluidLevel + SPAWN.waterClearance) {
    if (probe.fluidIsHazard && !req.hazardTolerant) {
      return fail('in-lava', distance, inFront, false);
    }
    if (!probe.fluidIsHazard) return fail('in-water', distance, inFront, false);
  }

  const feetY = ground + 0.3;
  const eyeY = feetY + 1.2;

  // ---- terrain clearance: standing room, not just a surface.
  if (probe.isSolid(req.x, feetY + 0.2, req.z)) return fail('inside-terrain', distance, inFront, false);
  if (probe.isSolid(req.x, feetY + SPAWN.headroom, req.z)) {
    return fail('no-headroom', distance, inFront, false);
  }
  if (probe.isObstacle(req.x, feetY + 0.6, req.z)) return fail('obstacle', distance, inFront, false);

  // ---- protected structures. Nothing materialises on top of a shrine.
  if (probe.distanceToProtected(req.x, req.z) < SPAWN.protectedRadius) {
    return fail('protected', distance, inFront, false);
  }

  // ---- reachability: a ledge or a pit the creature could not climb out of.
  // Flying creatures are exempt, because they can simply leave.
  if (!req.flying && !reachable(req.x, req.z, ground, probe)) {
    return fail('unreachable', distance, inFront, false);
  }

  // ---- visibility. This is the rule that stops things popping into view: a
  // point the player can see needs real distance, a point behind cover needs
  // less, and anything outside the view cone needs the most of all because the
  // player has to be given time to turn around.
  const visible = probe.hasLineOfSight(req.x, eyeY, req.z);
  if (inFront) {
    if (visible && distance < SPAWN.minVisibleDistance) {
      return fail('too-close-visible', distance, inFront, visible);
    }
    if (!visible && distance < SPAWN.minOccludedFrontDistance) {
      return fail('too-close-front', distance, inFront, visible);
    }
  } else if (distance < SPAWN.minRearDistance) {
    return fail('too-close-rear', distance, inFront, visible);
  }

  return { ok: true, y: feetY, distance, inFront, visible };
}

/**
 * Is there a way off this patch of ground?
 *
 * Sampled rather than pathfound: if every neighbouring column is a cliff, the
 * creature is in a hole and would spend the encounter bouncing off walls.
 */
export function reachable(x: number, z: number, ground: number, probe: SpawnWorldProbe): boolean {
  const offsets: readonly [number, number][] = [
    [1.6, 0], [-1.6, 0], [0, 1.6], [0, -1.6],
  ];
  for (const [ox, oz] of offsets) {
    const h = probe.groundHeight(x + ox, z + oz);
    if (!Number.isFinite(h)) continue;
    if (Math.abs(h - ground) <= SPAWN.maxSlope) return true;
  }
  return false;
}

/**
 * Has a creature become permanently stuck?
 *
 * Something that has not meaningfully moved while it was trying to reach the
 * player, or that has ended up outside the world it was spawned into, is
 * removed rather than left twitching against a rock. The caller dissolves it
 * without granting kill credit or loot, so this can never be farmed.
 */
export function isStranded(
  secondsWithoutProgress: number,
  distanceToPlayer: number,
  chasing: boolean,
): boolean {
  if (distanceToPlayer > SPAWN.abandonDistance) return true;
  return chasing && secondsWithoutProgress >= SPAWN.stuckSeconds;
}
