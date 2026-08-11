import { describe, expect, it } from 'vitest';
import {
  findFloor, resolveRespawn, validateStanding,
  type RespawnProbe,
} from '../src/player/respawn';
import { FLOOR_CLEARANCE, PLAYER_HEIGHT } from '../src/player/collision';

/**
 * A synthetic world for the resolver.
 *
 * `groundAt` decides the surface height of each column; everything below it is
 * solid. Hazards, water, scenery and creatures are supplied as predicates, so
 * each rejection rule can be tested in isolation.
 */
interface WorldOptions {
  groundAt?(x: number, z: number): number;
  hazardAt?(x: number, z: number): boolean;
  waterLevel?: number;
  sceneryAt?(x: number, z: number): boolean;
  creatureAt?(x: number, z: number): boolean;
  ceilingAt?(x: number, z: number): number | null;
  size?: number;
}

function makeProbe(options: WorldOptions = {}): RespawnProbe {
  const ground = options.groundAt ?? (() => 20);
  const size = options.size ?? 256;
  const waterLevel = options.waterLevel ?? -100;
  return {
    inBounds: (x, y, z) => x >= 0 && x <= size && z >= 0 && z <= size && y >= -8 && y <= 64,
    solidAt: (x, y, z) => {
      const ceiling = options.ceilingAt?.(x, z) ?? null;
      if (ceiling !== null && y >= ceiling && y <= ceiling + 1) return true;
      return y <= ground(x, z);
    },
    normalYAt: () => 1,
    damagingSurface: (x, _y, z) => options.hazardAt?.(x, z) ?? false,
    insideFluid: (_x, y) => y < waterLevel,
    sceneryOverlap: (x, _y, z) => options.sceneryAt?.(x, z) ?? false,
    creatureOverlap: (x, _y, z) => options.creatureAt?.(x, z) ?? false,
    hazardNearby: (x, _y, z) => options.hazardAt?.(x, z) ?? false,
    columnHeight: (x, z) => ground(x, z),
  };
}

describe('floor search', () => {
  it('finds the surface below a point in the air', () => {
    const probe = makeProbe({ groundAt: () => 20 });
    const floor = findFloor(probe, 50, 40, 50, 64);
    expect(floor).not.toBeNull();
    expect(floor!).toBeGreaterThan(19.9);
    expect(floor!).toBeLessThan(20.3);
  });

  it('climbs out of terrain before searching downward', () => {
    const probe = makeProbe({ groundAt: () => 20 });
    // Starting *inside* the ground still resolves to the surface.
    const floor = findFloor(probe, 50, 12, 50, 64);
    expect(floor).not.toBeNull();
    expect(floor!).toBeLessThan(20.4);
  });

  it('returns null over a bottomless column', () => {
    const probe = makeProbe({ groundAt: () => -50 });
    expect(findFloor(probe, 50, 30, 50, 40)).toBeNull();
  });
});

describe('standing validation', () => {
  it('accepts open ground', () => {
    expect(validateStanding(makeProbe(), 50, 20, 50)).toBeNull();
  });

  it('rejects a damaging surface', () => {
    const probe = makeProbe({ hazardAt: () => true });
    expect(validateStanding(probe, 50, 20, 50)).toBe('damaging-surface');
  });

  it('rejects a spot without capsule clearance', () => {
    const probe = makeProbe({ ceilingAt: () => 20.5 });
    expect(validateStanding(probe, 50, 20, 50)).toBe('no-clearance');
  });

  it('rejects a submerged spot', () => {
    const probe = makeProbe({ waterLevel: 40 });
    expect(validateStanding(probe, 50, 20, 50)).toBe('submerged');
  });

  it('rejects scenery and creature overlap separately', () => {
    expect(validateStanding(makeProbe({ sceneryAt: () => true }), 50, 20, 50))
      .toBe('scenery-overlap');
    expect(validateStanding(makeProbe({ creatureAt: () => true }), 50, 20, 50))
      .toBe('creature-overlap');
  });

  it('rejects a steep face', () => {
    const probe = { ...makeProbe(), normalYAt: () => 0.2 };
    expect(validateStanding(probe, 50, 20, 50)).toBe('too-steep');
  });

  it('rejects a position outside the world', () => {
    expect(validateStanding(makeProbe(), -20, 20, 50)).toBe('out-of-bounds');
  });
});

describe('respawn resolution', () => {
  it('uses the checkpoint when it is safe, resting just above the floor', () => {
    const result = resolveRespawn(makeProbe(), [50, 30, 50], [128, 30, 128], 256);
    expect(result.source).toBe('checkpoint');
    expect(result.x).toBe(50);
    expect(result.z).toBe(50);
    expect(result.y).toBeGreaterThan(20);
    expect(result.y).toBeLessThan(20 + FLOOR_CLEARANCE + 0.4);
  });

  it('never respawns the player in the air', () => {
    // Checkpoint is 40m up; the resolver drops it onto the surface.
    const result = resolveRespawn(makeProbe(), [50, 60, 50], [128, 30, 128], 256);
    expect(result.y).toBeLessThan(21);
  });

  it('never respawns the player inside terrain', () => {
    const probe = makeProbe({ groundAt: () => 20 });
    const result = resolveRespawn(probe, [50, 5, 50], [128, 30, 128], 256);
    expect(probe.solidAt(result.x, result.y + 0.2, result.z)).toBe(false);
    expect(probe.solidAt(result.x, result.y + PLAYER_HEIGHT * 0.9, result.z)).toBe(false);
  });

  it('steps aside when the checkpoint is inside a wall', () => {
    // A 6m column of scenery sits exactly on the checkpoint.
    const probe = makeProbe({
      sceneryAt: (x, z) => Math.hypot(x - 50, z - 50) < 6,
    });
    const result = resolveRespawn(probe, [50, 30, 50], [128, 30, 128], 256);
    expect(result.source).toBe('nearby');
    expect(Math.hypot(result.x - 50, result.z - 50)).toBeGreaterThan(5);
    expect(probe.sceneryOverlap(result.x, result.y, result.z)).toBe(false);
  });

  it('steps aside when a creature is standing on the checkpoint', () => {
    const probe = makeProbe({ creatureAt: (x, z) => Math.hypot(x - 50, z - 50) < 4 });
    const result = resolveRespawn(probe, [50, 30, 50], [128, 30, 128], 256);
    expect(probe.creatureOverlap(result.x, result.y, result.z)).toBe(false);
  });

  it('refuses to respawn next to lava and finds dry ground instead', () => {
    const probe = makeProbe({ hazardAt: (x, z) => Math.hypot(x - 50, z - 50) < 10 });
    const result = resolveRespawn(probe, [50, 30, 50], [128, 30, 128], 256);
    expect(probe.hazardNearby(result.x, result.y, result.z)).toBe(false);
  });

  it('falls back to the world spawn when nothing nearby works', () => {
    // Everything within 40m of the checkpoint is occupied.
    const probe = makeProbe({ sceneryAt: (x, z) => Math.hypot(x - 50, z - 50) < 40 });
    const result = resolveRespawn(probe, [50, 30, 50], [128, 30, 128], 256);
    expect(result.source).toBe('fallback');
    expect(result.x).toBe(128);
  });

  it('scans the world when even the fallback is unusable', () => {
    const probe = makeProbe({
      sceneryAt: (x, z) => Math.hypot(x - 50, z - 50) < 40 || Math.hypot(x - 128, z - 128) < 20,
    });
    const result = resolveRespawn(probe, [50, 30, 50], [128, 30, 128], 256);
    expect(result.source).toBe('scan');
    expect(probe.sceneryOverlap(result.x, result.y, result.z)).toBe(false);
  });

  it('recovers from a checkpoint outside the world', () => {
    const result = resolveRespawn(makeProbe(), [-500, 900, -500], [128, 30, 128], 256);
    expect(result.source).not.toBe('checkpoint');
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.x).toBeLessThanOrEqual(256);
  });

  it('handles terrain that was deformed after the checkpoint was recorded', () => {
    // The ground under the checkpoint has been dug away into a pit.
    const probe = makeProbe({
      groundAt: (x, z) => (Math.hypot(x - 50, z - 50) < 8 ? 4 : 20),
    });
    const result = resolveRespawn(probe, [50, 20.2, 50], [128, 30, 128], 256);
    // It still lands on solid ground, at the new floor height.
    expect(probe.solidAt(result.x, result.y - 0.3, result.z)).toBe(true);
    expect(probe.solidAt(result.x, result.y + 1, result.z)).toBe(false);
  });

  it('always reports how many candidates it examined', () => {
    const result = resolveRespawn(makeProbe(), [50, 30, 50], [128, 30, 128], 256);
    expect(result.attempts).toBeGreaterThan(0);
  });
});
