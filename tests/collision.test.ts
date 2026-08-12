import { describe, expect, it } from 'vitest';
import {
  BODY_SPHERES, MAX_SUBSTEP, MAX_WALKABLE_NORMAL_Y, PLAYER_HEIGHT, PLAYER_RADIUS,
  STEP_HEIGHT, createContactReport, depenetrate, penetrationDepth, probeGround,
  sweepMove, terrainOverlap, tryStepUp,
  type DensityField, type Vec3Like,
} from '../src/player/collision';
import { ObstacleField, createPushOut } from '../src/world/Obstacles';

/**
 * A flat world: solid below `height`, open above.
 *
 * Density is a signed distance, positive inside the solid, exactly as the real
 * field is near the surface.
 */
function flatWorld(height = 20, wallAtX?: number): DensityField {
  return {
    densityAt: (x, y) => {
      const ground = height - y;
      if (wallAtX === undefined) return ground;
      // A vertical slab from wallAtX to wallAtX + 2, six metres tall.
      const inSlabX = x >= wallAtX && x <= wallAtX + 2;
      const inSlabY = y >= height && y <= height + 6;
      const wall = inSlabX && inSlabY
        ? Math.min(x - wallAtX, wallAtX + 2 - x, y - height, height + 6 - y)
        : -Math.max(
          Math.max(wallAtX - x, x - (wallAtX + 2)),
          Math.max(height - y, y - (height + 6)),
        );
      return Math.max(ground, wall);
    },
    normalAt: (x, y, _z, out) => {
      const e = 0.3;
      const f = (px: number, py: number): number =>
        (wallAtX === undefined ? height - py : Math.max(height - py, slab(px, py, height, wallAtX)));
      const gx = f(x + e, y) - f(x - e, y);
      const gy = f(x, y + e) - f(x, y - e);
      const len = Math.hypot(gx, gy) || 1;
      out.x = -gx / len;
      out.y = -gy / len;
      out.z = 0;
      return out;
    },
  };
}

function slab(x: number, y: number, height: number, wallAtX: number): number {
  const dx = Math.min(x - wallAtX, wallAtX + 2 - x);
  const dy = Math.min(y - height, height + 6 - y);
  return Math.min(dx, dy);
}

/** A world with a low ledge the player should be able to step onto. */
function ledgeWorld(base = 20, ledgeHeight = 0.4, ledgeAtX = 10): DensityField {
  const heightAt = (x: number): number => (x >= ledgeAtX ? base + ledgeHeight : base);
  return {
    densityAt: (x, y) => heightAt(x) - y,
    normalAt: (x, y, _z, out) => {
      const e = 0.3;
      const gx = (heightAt(x + e) - y) - (heightAt(x - e) - y);
      const gy = (heightAt(x) - (y + e)) - (heightAt(x) - (y - e));
      const len = Math.hypot(gx, gy) || 1;
      out.x = -gx / len; out.y = -gy / len; out.z = 0;
      return out;
    },
  };
}

describe('capsule geometry', () => {
  it('samples the whole body height', () => {
    const top = BODY_SPHERES[BODY_SPHERES.length - 1]!;
    expect(top[0] + top[1]).toBeGreaterThan(PLAYER_HEIGHT - 0.1);
    expect(BODY_SPHERES[0]![1]).toBeCloseTo(PLAYER_RADIUS, 5);
  });

  it('detects overlap with solid terrain', () => {
    const world = flatWorld(20);
    // Standing exactly on the surface is not an overlap; being buried is.
    expect(terrainOverlap(world, 0, 19.4, 0)).toBe(true);
    expect(terrainOverlap(world, 0, 20, 0)).toBe(false);
  });

  it('reports penetration depth', () => {
    const world = flatWorld(20);
    expect(penetrationDepth(world, 0, 18, 0)).toBeGreaterThan(0);
    expect(penetrationDepth(world, 0, 25, 0)).toBeLessThan(0);
  });
});

describe('depenetration', () => {
  it('pushes a buried body up onto the surface', () => {
    const world = flatWorld(20);
    const pos: Vec3Like = { x: 0, y: 17, z: 0 };
    const report = createContactReport();
    depenetrate(world, pos, null, null, report, 12);
    expect(pos.y).toBeGreaterThan(19.5);
    expect(report.grounded).toBe(true);
    expect(terrainOverlap(world, pos.x, pos.y, pos.z)).toBe(false);
  });

  it('removes only the velocity going into the surface, so the body slides', () => {
    const world = flatWorld(20);
    const pos: Vec3Like = { x: 0, y: 19.4, z: 0 };
    const vel: Vec3Like = { x: 5, y: -8, z: 0 };
    depenetrate(world, pos, vel, null, createContactReport(), 8);
    // Downward motion is cancelled; horizontal motion survives.
    expect(vel.y).toBeGreaterThan(-0.001);
    expect(vel.x).toBeCloseTo(5, 1);
  });

  it('pushes out of a solid obstacle', () => {
    const world = flatWorld(20);
    const obstacles = new ObstacleField();
    obstacles.add({ id: 1, kind: 'tree', x: 0, y: 20, z: 0, radius: 1, height: 4 });
    const pos: Vec3Like = { x: 0.2, y: 20.1, z: 0 };
    depenetrate(world, pos, null, obstacles, createContactReport(), 6);
    expect(Math.hypot(pos.x, pos.z)).toBeGreaterThan(1 + PLAYER_RADIUS - 0.05);
  });

  it('ignores obstacles marked non-solid', () => {
    const obstacles = new ObstacleField();
    obstacles.add({ id: 1, kind: 'bush', x: 0, y: 20, z: 0, radius: 1, height: 2, solid: false });
    const pos: Vec3Like = { x: 0, y: 20.1, z: 0 };
    depenetrate(flatWorld(20), pos, null, obstacles, createContactReport(), 6);
    expect(Math.hypot(pos.x, pos.z)).toBeLessThan(0.2);
  });
});

describe('swept movement', () => {
  it('splits long moves into substeps so nothing tunnels', () => {
    const world = flatWorld(20, 10);
    const pos: Vec3Like = { x: 5, y: 20.4, z: 0 };
    const vel: Vec3Like = { x: 60, y: 0, z: 0 };
    // 60 m/s for a frame would cross the 2m wall in one step without sweeping.
    sweepMove(world, pos, vel, { x: 6, y: 0, z: 0 }, null, createContactReport());
    expect(pos.x).toBeLessThan(10);
  });

  it('caps the substep length', () => {
    expect(MAX_SUBSTEP).toBeLessThanOrEqual(PLAYER_RADIUS);
  });

  it('stops a body at a wall rather than passing through it', () => {
    const world = flatWorld(20, 10);
    const pos: Vec3Like = { x: 5, y: 20.4, z: 0 };
    const vel: Vec3Like = { x: 12, y: 0, z: 0 };
    for (let i = 0; i < 30; i++) {
      sweepMove(world, pos, vel, { x: vel.x * 0.05, y: 0, z: 0 }, null, createContactReport());
    }
    expect(pos.x).toBeLessThan(10.1);
  });

  it('walks through open ground unimpeded', () => {
    const world = flatWorld(20);
    const pos: Vec3Like = { x: 0, y: 20.05, z: 0 };
    const vel: Vec3Like = { x: 5, y: 0, z: 0 };
    sweepMove(world, pos, vel, { x: 1, y: 0, z: 0 }, null, createContactReport());
    expect(pos.x).toBeCloseTo(1, 1);
  });
});

describe('step height and slopes', () => {
  it('climbs a ledge inside the step height', () => {
    const world = ledgeWorld(20, 0.4, 10);
    const pos: Vec3Like = { x: 9.6, y: 20.02, z: 0 };
    const stepped = tryStepUp(world, pos, 0.5, 0, null);
    expect(stepped).toBe(true);
    expect(pos.y).toBeGreaterThan(20.3);
  });

  it('refuses a ledge taller than the step height', () => {
    const world = ledgeWorld(20, STEP_HEIGHT + 1.5, 10);
    const pos: Vec3Like = { x: 9.6, y: 20.02, z: 0 };
    const before = { ...pos };
    const stepped = tryStepUp(world, pos, 0.5, 0, null);
    expect(stepped).toBe(false);
    expect(pos.x).toBeCloseTo(before.x, 6);
    expect(pos.y).toBeCloseTo(before.y, 6);
  });

  it('treats a shallow surface as ground and a cliff face as not', () => {
    expect(MAX_WALKABLE_NORMAL_Y).toBeGreaterThan(0.5);
    expect(MAX_WALKABLE_NORMAL_Y).toBeLessThan(0.9);
  });

  it('detects ground with a downward probe', () => {
    const world = flatWorld(20);
    expect(probeGround(world, { x: 0, y: 20.05, z: 0 }, 0, null).grounded).toBe(true);
    expect(probeGround(world, { x: 0, y: 26, z: 0 }, 0, null).grounded).toBe(false);
  });

  it('does not probe for ground while moving upward', () => {
    const world = flatWorld(20);
    expect(probeGround(world, { x: 0, y: 20.05, z: 0 }, 6, null).grounded).toBe(false);
  });

  it('stands on top of a solid obstacle', () => {
    const obstacles = new ObstacleField();
    obstacles.add({ id: 1, kind: 'chest', x: 0, y: 20, z: 0, radius: 0.6, height: 0.8 });
    const result = probeGround(flatWorld(20), { x: 0, y: 20.8, z: 0 }, 0, obstacles);
    expect(result.grounded).toBe(true);
  });
});

describe('obstacle field', () => {
  it('registers, finds and removes volumes', () => {
    const field = new ObstacleField();
    field.add({ id: 7, kind: 'tree', x: 30, y: 20, z: 40, radius: 0.5, height: 4 });
    expect(field.size).toBe(1);
    expect(field.query(30, 40, 2)).toHaveLength(1);
    expect(field.remove(7)).toBe(true);
    expect(field.query(30, 40, 2)).toHaveLength(0);
  });

  it('detects capsule overlap and lets a body rest on top', () => {
    const field = new ObstacleField();
    field.add({ id: 1, kind: 'chest', x: 0, y: 20, z: 0, radius: 0.6, height: 0.7 });
    // Standing at its base is blocked; standing on its lid is not.
    expect(field.overlaps(0, 20, 0, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
    expect(field.overlaps(0, 20.7, 0, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
    field.add({ id: 2, kind: 'wall', x: 0, y: 20, z: 0, radius: 1, height: 5 });
    expect(field.overlaps(0, 20.7, 0, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(true);
  });

  it('resolves box obstacles along the shallowest axis', () => {
    const field = new ObstacleField();
    field.add({ id: 1, kind: 'ruin', shape: 'box', x: 0, y: 20, z: 0, halfX: 4, halfZ: 0.5, height: 4 });
    const push = createPushOut();
    field.resolveCapsule(0, 20.2, 0.3, PLAYER_RADIUS, PLAYER_HEIGHT, push);
    expect(push.contacts).toBe(1);
    // Pushed out along Z, the thin axis, not along the 8m-long X axis.
    expect(Math.abs(push.z)).toBeGreaterThan(Math.abs(push.x));
  });

  it('reports the highest support under a point', () => {
    const field = new ObstacleField();
    field.add({ id: 1, kind: 'chest', x: 0, y: 20, z: 0, radius: 1, height: 0.7 });
    field.add({ id: 2, kind: 'crate', x: 0, y: 20, z: 0, radius: 1, height: 1.2 });
    expect(field.supportHeight(0, 0, 21.5, PLAYER_RADIUS)).toBeCloseTo(21.2, 5);
  });

  it('breaks destructible volumes but never protected ones', () => {
    const field = new ObstacleField();
    field.add({ id: 1, kind: 'tree', x: 0, y: 20, z: 0, radius: 0.5, height: 4, destructible: true });
    field.add({ id: 2, kind: 'portal', x: 1, y: 20, z: 0, radius: 0.5, height: 4, destructible: true, protectedVolume: true });
    const broken = field.breakInSphere(0.5, 21, 0, 3);
    expect(broken.map((o) => o.id)).toEqual([1]);
    expect(field.get(2)).not.toBeNull();
  });

  it('removes every volume of a kind at once', () => {
    const field = new ObstacleField();
    field.add({ id: 1, kind: 'earth-wall', x: 0, y: 20, z: 0, radius: 1, height: 3 });
    field.add({ id: 2, kind: 'earth-wall', x: 4, y: 20, z: 0, radius: 1, height: 3 });
    field.add({ id: 3, kind: 'tree', x: 8, y: 20, z: 0, radius: 1, height: 3 });
    expect(field.removeKind('earth-wall')).toBe(2);
    expect(field.size).toBe(1);
  });
});

describe('collision after terrain changes', () => {
  it('sees a newly raised wall on the very next query', () => {
    // The obstacle field is the single source of truth, so an ability that
    // registers a volume blocks movement immediately.
    const field = new ObstacleField();
    const pos: Vec3Like = { x: 0, y: 20.05, z: 0 };
    const vel: Vec3Like = { x: 8, y: 0, z: 0 };
    const world = flatWorld(20);

    sweepMove(world, pos, vel, { x: 0.5, y: 0, z: 0 }, field, createContactReport());
    const afterOpen = pos.x;

    field.add({ id: 99, kind: 'earth-wall', x: afterOpen + 1, y: 20, z: 0, radius: 1, height: 4 });
    for (let i = 0; i < 10; i++) {
      sweepMove(world, pos, vel, { x: 0.3, y: 0, z: 0 }, field, createContactReport());
    }
    expect(pos.x).toBeLessThan(afterOpen + 1);
  });

  it('frees a body that a raised wall closed around', () => {
    const field = new ObstacleField();
    field.add({ id: 1, kind: 'earth-wall', x: 0, y: 20, z: 0, radius: 1.2, height: 4 });
    const pos: Vec3Like = { x: 0, y: 20.1, z: 0 };
    depenetrate(flatWorld(20), pos, null, field, createContactReport(), 6);
    expect(field.overlaps(pos.x, pos.y, pos.z, PLAYER_RADIUS, PLAYER_HEIGHT)).toBe(false);
  });
});
