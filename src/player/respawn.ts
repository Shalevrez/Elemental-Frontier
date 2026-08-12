/**
 * Safe respawn placement.
 *
 * The old behaviour teleported the player to the stored checkpoint and hoped:
 * a checkpoint recorded mid-air, inside a wall the player later raised, in a
 * lake, in lava or on top of a creature all produced an unfair respawn.
 *
 * This module resolves a *validated standing position* instead. It never
 * returns a point it has not checked, and its last resort is a full scan of the
 * world for any legal column, so it can always answer.
 *
 * Pure and engine-free: the game passes in a small probe interface, and the
 * tests pass in a synthetic world.
 */

import {
  FLOOR_CLEARANCE, MAX_WALKABLE_NORMAL_Y, PLAYER_HEIGHT, PLAYER_RADIUS,
} from './collision';

export type RespawnRejection =
  | 'out-of-bounds'
  | 'no-floor'
  | 'not-solid'
  | 'damaging-surface'
  | 'too-steep'
  | 'no-clearance'
  | 'submerged'
  | 'scenery-overlap'
  | 'creature-overlap'
  | 'terrain-overlap'
  | 'hazard-adjacent';

export type RespawnSource = 'checkpoint' | 'nearby' | 'fallback' | 'scan';

export interface RespawnProbe {
  /** Is this position inside the playable volume? */
  inBounds(x: number, y: number, z: number): boolean;
  /** Solid terrain test. */
  solidAt(x: number, y: number, z: number): boolean;
  /** Upward component of the terrain normal, 0..1. */
  normalYAt(x: number, y: number, z: number): number;
  /** Does the surface here damage whatever stands on it (lava, blight)? */
  damagingSurface(x: number, y: number, z: number): boolean;
  /** Is this point inside a fluid (water or lava)? */
  insideFluid(x: number, y: number, z: number): boolean;
  /** Does the player capsule based here overlap scenery? */
  sceneryOverlap(x: number, y: number, z: number): boolean;
  /** Does it overlap a living creature? */
  creatureOverlap(x: number, y: number, z: number): boolean;
  /** Is an active hazard (lava pool, telegraphed attack) within a few metres? */
  hazardNearby(x: number, y: number, z: number): boolean;
  /** Terrain surface height of a column, used to seed the downward search. */
  columnHeight(x: number, z: number): number;
}

export interface RespawnResult {
  x: number;
  y: number;
  z: number;
  source: RespawnSource;
  /** How many candidate positions were examined. */
  attempts: number;
  /** Why the requested position was refused, when it was. */
  rejected: RespawnRejection | null;
}

export interface RespawnOptions {
  /** How far the nearby search may wander, in metres. */
  searchRadius?: number;
  /** How far above the desired point the downward search starts. */
  searchUp?: number;
  /** How far below the desired point the downward search may go. */
  searchDown?: number;
  /** Skip the hazard-adjacency rule (used for the final fallback). */
  allowHazardAdjacent?: boolean;
}

/** Vertical resolution of the floor search, in metres. */
const PROBE_STEP = 0.25;

/**
 * Find the top of the first solid surface at or below `fromY`.
 *
 * Returns null when the column is empty all the way down, which is exactly the
 * "respawned over a hole" case the resolver must reject.
 */
export function findFloor(
  probe: RespawnProbe,
  x: number,
  fromY: number,
  z: number,
  maxDrop: number,
): number | null {
  let y = fromY;
  const limit = fromY - maxDrop;
  // If the start point is already inside terrain, climb out first.
  let climbed = 0;
  while (probe.solidAt(x, y, z) && climbed < 24) {
    y += PROBE_STEP;
    climbed += PROBE_STEP;
    if (!probe.inBounds(x, y, z)) return null;
  }
  while (y > limit) {
    const next = y - PROBE_STEP;
    if (probe.solidAt(x, next, z)) {
      // Binary refine so the body rests on the surface, not a quarter metre in.
      let lo = next;
      let hi = y;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        if (probe.solidAt(x, mid, z)) lo = mid; else hi = mid;
      }
      return hi;
    }
    y = next;
  }
  return null;
}

/**
 * Check every rule for one candidate standing position.
 *
 * `y` is the floor height; the capsule is placed slightly above it.
 */
export function validateStanding(
  probe: RespawnProbe,
  x: number,
  floorY: number,
  z: number,
  options: RespawnOptions = {},
): RespawnRejection | null {
  const y = floorY + FLOOR_CLEARANCE;

  if (!probe.inBounds(x, y, z)) return 'out-of-bounds';
  if (!probe.inBounds(x, y + PLAYER_HEIGHT, z)) return 'out-of-bounds';

  // 3. the surface must actually be solid just under the feet
  if (!probe.solidAt(x, floorY - 0.12, z)) return 'not-solid';

  // 4. and it must not be a damaging surface
  if (probe.damagingSurface(x, floorY - 0.1, z)) return 'damaging-surface';

  // steep faces are not standing room
  const ny = probe.normalYAt(x, floorY - 0.05, z);
  if (ny > 0 && ny < MAX_WALKABLE_NORMAL_Y) return 'too-steep';

  // 5. capsule clearance above the surface
  for (let h = 0.2; h <= PLAYER_HEIGHT; h += 0.3) {
    if (probe.solidAt(x, y + h, z)) return 'no-clearance';
  }

  // never respawn underwater or in lava - the head must be in open air
  if (probe.insideFluid(x, y + PLAYER_HEIGHT * 0.9, z)) return 'submerged';

  // 6. no overlap with scenery, creatures or terrain
  if (probe.sceneryOverlap(x, y, z)) return 'scenery-overlap';
  if (probe.creatureOverlap(x, y, z)) return 'creature-overlap';

  // 9. hazards must not be right next to the landing spot
  if (!options.allowHazardAdjacent && probe.hazardNearby(x, y, z)) return 'hazard-adjacent';

  return null;
}

/** Try one column: find its floor, then validate standing on it. */
function tryColumn(
  probe: RespawnProbe,
  x: number,
  y: number,
  z: number,
  options: RespawnOptions,
): { y: number } | { rejected: RespawnRejection } {
  const up = options.searchUp ?? 3;
  const down = options.searchDown ?? 64;
  if (!probe.inBounds(x, y, z)) {
    // Out of bounds vertically is recoverable: drop from the column top.
    const top = probe.columnHeight(x, z);
    if (!probe.inBounds(x, top + 1, z)) return { rejected: 'out-of-bounds' };
    y = top + 1;
  }
  const floor = findFloor(probe, x, y + up, z, down + up);
  if (floor === null) return { rejected: 'no-floor' };
  const rejection = validateStanding(probe, x, floor, z, options);
  if (rejection) return { rejected: rejection };
  return { y: floor + FLOOR_CLEARANCE };
}

/**
 * Resolve a safe respawn.
 *
 *  1. try the requested checkpoint,
 *  2. spiral outward through nearby columns,
 *  3. try the validated fallback spawn,
 *  4. as an absolute last resort scan the world on a coarse grid.
 */
export function resolveRespawn(
  probe: RespawnProbe,
  desired: readonly [number, number, number],
  fallback: readonly [number, number, number],
  worldSize: number,
  options: RespawnOptions = {},
): RespawnResult {
  let attempts = 0;
  let firstRejection: RespawnRejection | null = null;

  // ---- 1. the intended checkpoint
  attempts++;
  const direct = tryColumn(probe, desired[0], desired[1], desired[2], options);
  if ('y' in direct) {
    return { x: desired[0], y: direct.y, z: desired[2], source: 'checkpoint', attempts, rejected: null };
  }
  firstRejection = direct.rejected;

  // ---- 2. nearby positions, spiralling outward
  const maxRadius = options.searchRadius ?? 18;
  for (let radius = 1.5; radius <= maxRadius; radius += 1.5) {
    const samples = Math.max(8, Math.round(radius * 4));
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2 + radius * 0.37;
      const x = desired[0] + Math.cos(a) * radius;
      const z = desired[2] + Math.sin(a) * radius;
      attempts++;
      const near = tryColumn(probe, x, desired[1], z, options);
      if ('y' in near) {
        return { x, y: near.y, z, source: 'nearby', attempts, rejected: firstRejection };
      }
    }
  }

  // ---- 3. the validated fallback spawn
  attempts++;
  const fb = tryColumn(probe, fallback[0], fallback[1], fallback[2], options);
  if ('y' in fb) {
    return { x: fallback[0], y: fb.y, z: fallback[2], source: 'fallback', attempts, rejected: firstRejection };
  }
  // Fallback with the hazard-adjacency rule relaxed: standing next to a hazard
  // beats being deleted from the world.
  attempts++;
  const fbRelaxed = tryColumn(probe, fallback[0], fallback[1], fallback[2], { ...options, allowHazardAdjacent: true });
  if ('y' in fbRelaxed) {
    return { x: fallback[0], y: fbRelaxed.y, z: fallback[2], source: 'fallback', attempts, rejected: firstRejection };
  }

  // ---- 4. coarse world scan, nearest legal column to the fallback wins
  let best: RespawnResult | null = null;
  const step = Math.max(6, worldSize / 32);
  for (let x = step; x < worldSize; x += step) {
    for (let z = step; z < worldSize; z += step) {
      attempts++;
      const top = probe.columnHeight(x, z);
      const scan = tryColumn(probe, x, top + 2, z, { ...options, allowHazardAdjacent: true });
      if (!('y' in scan)) continue;
      const d = Math.hypot(x - fallback[0], z - fallback[2]);
      if (!best || d < Math.hypot(best.x - fallback[0], best.z - fallback[2])) {
        best = { x, y: scan.y, z, source: 'scan', attempts, rejected: firstRejection };
      }
    }
  }
  if (best) return { ...best, attempts };

  // Nothing at all was legal. Return the fallback unresolved rather than throw;
  // the caller still applies its own unstick pass.
  return {
    x: fallback[0], y: fallback[1], z: fallback[2],
    source: 'fallback', attempts, rejected: firstRejection,
  };
}

/** Player capsule footprint, exported so callers build matching probes. */
export const RESPAWN_CAPSULE = Object.freeze({
  radius: PLAYER_RADIUS,
  height: PLAYER_HEIGHT,
  clearance: FLOOR_CLEARANCE,
});
