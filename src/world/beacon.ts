/**
 * The World Beacon.
 *
 * A player who restored every shrine in a world was told so by a five-second
 * toast and then left with nothing: the exit stood at the centre of the world,
 * the compass showed only the four shrines - all of them reading "cleansed" -
 * and the prompt to use it appeared within three metres. Finishing the last
 * shrine out at the world edge meant finishing the world and having no idea
 * where to go.
 *
 * The Beacon is the fix. It is the deliberate, unmissable transition point: a
 * grounded base under a tall elemental beam, marked on the compass, named in
 * the objective line, and used by *holding* a key rather than brushing past it.
 *
 * This module is the pure half - when a Beacon may exist, where it is allowed
 * to stand, and how the hold-to-travel interaction progresses. The geometry and
 * the audio live with the renderer; everything decided here is testable without
 * a world.
 */

import type { WorldId } from './worlds';
import { nextWorld } from './worlds';

/** How the Beacon may be used right now. */
export type BeaconMode =
  /** The world is not finished; the Beacon does not exist yet. */
  | 'dormant'
  /** Ready, and there is a next world to travel to. */
  | 'travel'
  /** Ready, this is the final world, and the campaign has not been finished. */
  | 'finale'
  /** Ready, the campaign is over; using it begins New Game Plus. */
  | 'new-game-plus';

export const BEACON = Object.freeze({
  /** Seconds the player must hold the key to commit to travelling. */
  holdSeconds: 1.2,
  /** Distance at which the prompt and the hold become available. */
  interactRadius: 4.5,
  /** Distance at which the ambient hum can be heard. */
  ambientRadius: 34,
  /** Radius of ground kept safe from deformation around the base. */
  protectRadius: 9,
  /** Radius of the solid part of the base. The beam itself is not solid. */
  baseRadius: 1.9,
  baseHeight: 1.1,
  /** How tall the beam climbs, in metres. Visible across the world. */
  beamHeight: 90,
  /** Clearance a candidate site needs above the ground for the player to stand. */
  clearance: 3,
  /** Ground-height spread across the footprint that counts as too uneven. */
  maxSlope: 1.8,
  /** Placement attempts around each preferred anchor before widening. */
  attempts: 16,
  /** Rings of increasing radius searched around a preferred anchor. */
  searchRadii: Object.freeze([0, 7, 12, 18, 26]),
});

/**
 * Is the world finished?
 *
 * Deliberately the same condition the rest of the game already uses - every
 * shrine restored - so a save that completed a world before the Beacon existed
 * satisfies it immediately and the Beacon is reconstructed on load with no
 * migration and no progress reset.
 */
export function worldComplete(shrines: readonly boolean[]): boolean {
  return shrines.length > 0 && shrines.every(Boolean);
}

/** How many shrines are done, for the objective readout. */
export function completionProgress(shrines: readonly boolean[]): { done: number; total: number } {
  return { done: shrines.filter(Boolean).length, total: shrines.length };
}

/**
 * What the Beacon is for in this world.
 *
 * `dormant` until the world is finished; then travel onward, or - in the last
 * world - the ending, and after that a new cycle.
 */
export function beaconMode(
  world: WorldId,
  shrines: readonly boolean[],
  postGame: boolean,
): BeaconMode {
  if (!worldComplete(shrines)) return 'dormant';
  if (nextWorld(world) !== null) return 'travel';
  return postGame ? 'new-game-plus' : 'finale';
}

/** The prompt shown when the player is close enough to use it. */
export function beaconPrompt(mode: BeaconMode, destinationName: string): string {
  switch (mode) {
    case 'travel': return `Hold to travel to ${destinationName}`;
    case 'finale': return 'Hold to take the last step';
    case 'new-game-plus': return `Hold to begin again in ${destinationName}, stronger`;
    default: return '';
  }
}

/** The objective line while the Beacon is lit. */
export function beaconObjective(mode: BeaconMode, destinationName: string): string {
  switch (mode) {
    case 'travel': return `The World Beacon is lit — travel to ${destinationName}`;
    case 'finale': return 'The World Beacon is lit — take the last step';
    case 'new-game-plus': return 'The World Beacon is lit — begin again, stronger';
    default: return '';
  }
}

// =====================================================================
//  Placement
// =====================================================================

/** What the placement rules need to be able to ask the world. */
export interface BeaconWorldProbe {
  groundHeight(x: number, z: number): number;
  isSolid(x: number, y: number, z: number): boolean;
  /** Is this point inside a prop, boulder or other non-terrain solid? */
  isObstacle(x: number, y: number, z: number, radius: number, height: number): boolean;
  /** Surface height of the world's fluid, and whether standing in it hurts. */
  fluidLevel: number;
  fluidIsHazard: boolean;
}

export type BeaconRejection =
  | 'out-of-bounds'
  | 'no-ground'
  | 'in-fluid'
  | 'in-hazard'
  | 'inside-terrain'
  | 'no-clearance'
  | 'obstacle'
  | 'uneven';

export interface BeaconSite {
  x: number;
  y: number;
  z: number;
}

export interface BeaconCheck {
  ok: boolean;
  reason?: BeaconRejection;
  site?: BeaconSite;
}

/**
 * Is this a place a Beacon may stand?
 *
 * It has to be on real ground, out of the water, well clear of lava, level
 * enough that the base does not hang off a slope, tall enough that the player
 * can stand beside it, and free of the props and boulders the world dresses
 * itself with.
 */
export function validateBeaconSite(
  x: number,
  z: number,
  probe: BeaconWorldProbe,
  worldSize: number,
  margin = 14,
): BeaconCheck {
  if (x < margin || z < margin || x > worldSize - margin || z > worldSize - margin) {
    return { ok: false, reason: 'out-of-bounds' };
  }
  const ground = probe.groundHeight(x, z);
  if (!Number.isFinite(ground) || ground <= 0) return { ok: false, reason: 'no-ground' };

  // Never in the water, and never anywhere near the lava line.
  if (probe.fluidIsHazard) {
    if (ground < probe.fluidLevel + 4) return { ok: false, reason: 'in-hazard' };
  } else if (ground < probe.fluidLevel + 0.8) {
    return { ok: false, reason: 'in-fluid' };
  }

  const base = ground + 0.05;
  if (probe.isSolid(x, base + 0.4, z)) return { ok: false, reason: 'inside-terrain' };
  if (probe.isSolid(x, base + BEACON.clearance, z)) return { ok: false, reason: 'no-clearance' };
  if (probe.isObstacle(x, base + 0.6, z, BEACON.baseRadius + 1, BEACON.clearance)) {
    return { ok: false, reason: 'obstacle' };
  }

  // Level enough that the base sits flat and the player can walk up to it.
  const offsets: readonly [number, number][] = [
    [BEACON.baseRadius, 0], [-BEACON.baseRadius, 0],
    [0, BEACON.baseRadius], [0, -BEACON.baseRadius],
  ];
  for (const [ox, oz] of offsets) {
    const h = probe.groundHeight(x + ox, z + oz);
    if (!Number.isFinite(h)) continue;
    if (Math.abs(h - ground) > BEACON.maxSlope) return { ok: false, reason: 'uneven' };
  }

  return { ok: true, site: { x, y: base, z } };
}

/**
 * Find somewhere for the Beacon.
 *
 * Preferred anchors are tried in order - the restored Heart first, then the
 * arena the last guardian fell in, then the world centre - and each is searched
 * outward in rings until a site passes. The search is deterministic given the
 * same anchors and world, so a Beacon is in the same place every time a save is
 * loaded.
 */
export function placeBeacon(
  anchors: readonly { x: number; z: number }[],
  probe: BeaconWorldProbe,
  worldSize: number,
): BeaconCheck {
  let lastReason: BeaconRejection = 'no-ground';
  for (const anchor of anchors) {
    for (const radius of BEACON.searchRadii) {
      const steps = radius === 0 ? 1 : BEACON.attempts;
      for (let i = 0; i < steps; i++) {
        // A fixed angular sweep rather than a random one, so placement is
        // reproducible across loads.
        const angle = (i / steps) * Math.PI * 2;
        const x = anchor.x + Math.cos(angle) * radius;
        const z = anchor.z + Math.sin(angle) * radius;
        const check = validateBeaconSite(x, z, probe, worldSize);
        if (check.ok) return check;
        lastReason = check.reason ?? lastReason;
      }
    }
  }
  return { ok: false, reason: lastReason };
}

// =====================================================================
//  Hold-to-travel
// =====================================================================

export interface BeaconHold {
  /** Seconds the key has been held. */
  held: number;
  /** True for the single frame the hold completes. */
  committed: boolean;
}

export function createBeaconHold(): BeaconHold {
  return { held: 0, committed: false };
}

/**
 * Advance the hold.
 *
 * Travelling is deliberately not a tap: brushing past the Beacon with a finger
 * on the interact key should never take the world away. Releasing resets the
 * progress, and the commit fires exactly once.
 */
export function tickBeaconHold(
  hold: BeaconHold,
  dt: number,
  holding: boolean,
  enabled: boolean,
): BeaconHold {
  hold.committed = false;
  if (!holding || !enabled) {
    hold.held = 0;
    return hold;
  }
  // Already committed and still holding: do not fire again until released.
  if (hold.held >= BEACON.holdSeconds) return hold;
  hold.held += Math.max(0, dt);
  if (hold.held >= BEACON.holdSeconds) hold.committed = true;
  return hold;
}

/** 0..1 progress for the prompt's fill bar. */
export function beaconHoldFraction(hold: BeaconHold): number {
  return Math.max(0, Math.min(1, hold.held / BEACON.holdSeconds));
}
