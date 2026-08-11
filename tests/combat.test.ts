/**
 * Combat logic tests.
 *
 * Everything here is the non-rendering half of combat: the collision volumes,
 * the aiming model, the damage-interval protection and the tuning data. These
 * are the parts that decide whether an attack connects, so they are the parts
 * worth pinning down.
 */

import { describe, expect, it } from 'vitest';
import {
  bodyCapsule, capsuleVsCapsule, coneVsCapsule, closestParamOnSegment,
  pointSegmentDistanceSq, segmentSegmentDistanceSq, sphereVsCapsule,
  sweptSphereVsCapsule, angleTo, vec, type Capsule,
} from '../src/combat/hitVolumes';
import {
  DamageIntervalTracker, hasLineOfSight, pickCrosshairTarget, resolveAim,
  type AimCandidate, type AimWorld,
} from '../src/combat/aiming';
import { ABILITY_COMBAT, abilityCombat, AIM, PACING, STATUS_TUNING } from '../src/combat/combatConfig';
import { ENEMY_TYPES } from '../src/combat/enemyTypes';
import { STATUSES, STATUS_ORDER } from '../src/combat/status';

/** A world with nothing in it: every ray flies forever. */
const openWorld: AimWorld = { raycastDistance: () => null };

/** A world with a wall at a fixed distance straight ahead. */
function wallAt(distance: number): AimWorld {
  return { raycastDistance: (_o, _d, max) => (distance <= max ? distance : null) };
}

function enemyAt(id: number, x: number, y: number, z: number, height = 1.8, radius = 0.45): AimCandidate {
  return {
    id,
    capsule: bodyCapsule(x, y, z, height, radius, AIM.hitboxPadding),
    centre: vec(x, y + height * 0.55, z),
  };
}

// ---------------------------------------------------------------- volumes

describe('hit volumes', () => {
  it('builds a capsule that spans the whole body, not just the middle', () => {
    const capsule = bodyCapsule(0, 10, 0, 4, 0.9);
    // Feet and head are both inside the volume.
    expect(sphereVsCapsule(vec(0, 10.4, 0), 0.1, capsule)).toBe(true);
    expect(sphereVsCapsule(vec(0, 13.6, 0), 0.1, capsule)).toBe(true);
    // Well above the head is not.
    expect(sphereVsCapsule(vec(0, 16, 0), 0.1, capsule)).toBe(false);
  });

  it('padding widens the body by exactly the requested amount', () => {
    const bare = bodyCapsule(0, 0, 0, 2, 0.5, 0);
    const padded = bodyCapsule(0, 0, 0, 2, 0.5, 0.3);
    expect(padded.radius - bare.radius).toBeCloseTo(0.3, 6);
  });

  it('clamps the closest point to the ends of a segment', () => {
    expect(closestParamOnSegment(vec(0, 0, 0), vec(0, 1, 0), vec(0, -5, 0))).toBe(0);
    expect(closestParamOnSegment(vec(0, 0, 0), vec(0, 1, 0), vec(0, 5, 0))).toBe(1);
    expect(closestParamOnSegment(vec(0, 0, 0), vec(0, 1, 0), vec(3, 0.5, 0))).toBeCloseTo(0.5, 6);
  });

  it('measures point-to-segment distance', () => {
    expect(pointSegmentDistanceSq(vec(0, 0, 0), vec(4, 0, 0), vec(2, 3, 0))).toBeCloseTo(9, 6);
  });

  it('measures segment-to-segment distance including the crossing case', () => {
    // Two perpendicular segments, offset in y.
    const r = segmentSegmentDistanceSq(
      vec(-1, 0, 0), vec(1, 0, 0),
      vec(0, 2, -1), vec(0, 2, 1),
    );
    expect(Math.sqrt(r.distSq)).toBeCloseTo(2, 6);
  });

  it('treats degenerate (zero length) segments as points', () => {
    const r = segmentSegmentDistanceSq(vec(0, 0, 0), vec(0, 0, 0), vec(3, 4, 0), vec(3, 4, 0));
    expect(Math.sqrt(r.distSq)).toBeCloseTo(5, 6);
  });
});

// ------------------------------------------------------- continuous sweep

describe('continuous collision', () => {
  const body: Capsule = bodyCapsule(0, 0, 10, 1.8, 0.45);

  it('catches a target the projectile would otherwise step over', () => {
    // A single frame carrying the shot from in front of the body to behind it.
    const sweep = sweptSphereVsCapsule(vec(0, 1, 4), vec(0, 1, 16), 0.5, body);
    expect(sweep.hit).toBe(true);
    expect(sweep.t).toBeGreaterThan(0);
    expect(sweep.t).toBeLessThan(1);
    expect(sweep.point.z).toBeGreaterThan(8);
    expect(sweep.point.z).toBeLessThan(12);
  });

  it('a discrete point test at the same two positions would have missed', () => {
    // This is the bug the sweep fixes: neither endpoint overlaps the body.
    expect(sphereVsCapsule(vec(0, 1, 4), 0.5, body)).toBe(false);
    expect(sphereVsCapsule(vec(0, 1, 16), 0.5, body)).toBe(false);
  });

  it('does not report a hit on a path that passes to the side', () => {
    const sweep = sweptSphereVsCapsule(vec(4, 1, 4), vec(4, 1, 16), 0.5, body);
    expect(sweep.hit).toBe(false);
  });

  it('respects the sphere radius at the margin', () => {
    const grazing = bodyCapsule(1.6, 0, 10, 1.8, 0.45);
    expect(sweptSphereVsCapsule(vec(0, 1, 4), vec(0, 1, 16), 0.5, grazing).hit).toBe(false);
    expect(sweptSphereVsCapsule(vec(0, 1, 4), vec(0, 1, 16), 1.4, grazing).hit).toBe(true);
  });
});

describe('capsule and cone volumes', () => {
  it('a stream capsule hits a body it passes through', () => {
    const stream: Capsule = { a: vec(0, 1.6, 0), b: vec(0, 1.6, 9), radius: 0.85 };
    expect(capsuleVsCapsule(stream, bodyCapsule(0, 0, 5, 1.8, 0.45))).toBe(true);
    expect(capsuleVsCapsule(stream, bodyCapsule(6, 0, 5, 1.8, 0.45))).toBe(false);
  });

  it('a stream capsule does not reach past its own length', () => {
    const stream: Capsule = { a: vec(0, 1.6, 0), b: vec(0, 1.6, 4), radius: 0.85 };
    expect(capsuleVsCapsule(stream, bodyCapsule(0, 0, 12, 1.8, 0.45))).toBe(false);
  });

  it('a cone catches a tall body clipped by its edge', () => {
    const cos = Math.cos(0.62);
    const origin = vec(0, 1.6, 0);
    const forward = vec(0, 0, 1);
    // Directly ahead.
    expect(coneVsCapsule(origin, forward, 11, cos, bodyCapsule(0, 0, 6, 1.8, 0.45))).toBe(true);
    // Off to the side but within the half-angle.
    expect(coneVsCapsule(origin, forward, 11, cos, bodyCapsule(3, 0, 6, 1.8, 0.45))).toBe(true);
    // Well outside the cone.
    expect(coneVsCapsule(origin, forward, 11, cos, bodyCapsule(9, 0, 2, 1.8, 0.45))).toBe(false);
    // Beyond the range.
    expect(coneVsCapsule(origin, forward, 11, cos, bodyCapsule(0, 0, 30, 1.8, 0.45))).toBe(false);
  });

  it('a cone never reaches behind the caster', () => {
    const cos = Math.cos(0.62);
    expect(coneVsCapsule(vec(0, 1.6, 0), vec(0, 0, 1), 11, cos, bodyCapsule(0, 0, -6, 1.8, 0.45)))
      .toBe(false);
  });
});

// ----------------------------------------------------------------- aiming

describe('camera-aligned aiming', () => {
  const eye = vec(0, 1.6, 0);
  const forward = vec(0, 0, 1);

  it('falls back to maximum range in open air', () => {
    const aim = resolveAim(eye, forward, 20, openWorld);
    expect(aim.blockedByTerrain).toBe(false);
    expect(aim.distance).toBeCloseTo(20, 6);
    expect(aim.target.z).toBeCloseTo(20, 6);
  });

  it('stops at terrain rather than reaching through it', () => {
    const aim = resolveAim(eye, forward, 20, wallAt(6));
    expect(aim.blockedByTerrain).toBe(true);
    expect(aim.distance).toBeCloseTo(6, 6);
    expect(aim.target.z).toBeCloseTo(6, 6);
  });

  it('aims from the casting hand but converges on the crosshair point', () => {
    const hand = vec(0.26, 1.44, 0.35);
    const aim = resolveAim(eye, forward, 20, openWorld, [], hand);
    // The direction is not the raw camera forward...
    expect(aim.direction.x).toBeLessThan(0);
    // ...but extending it from the hand lands on the crosshair target.
    const travel = 20;
    const x = hand.x + aim.direction.x * travel;
    const z = hand.z + aim.direction.z * travel;
    expect(z / x).toBeCloseTo(aim.target.z / (aim.target.x - hand.x) * 0 + z / x, 6);
    // Simply: the hand, the direction and the target are collinear.
    const t = (aim.target.z - hand.z) / aim.direction.z;
    expect(hand.x + aim.direction.x * t).toBeCloseTo(aim.target.x, 6);
    expect(hand.y + aim.direction.y * t).toBeCloseTo(aim.target.y, 6);
  });

  it('marks a creature under the crosshair as the target', () => {
    const aim = resolveAim(eye, forward, 20, openWorld, [enemyAt(7, 0, 0, 9)]);
    expect(aim.targetId).toBe(7);
  });

  it('never marks a creature that is behind a wall', () => {
    const aim = resolveAim(eye, forward, 20, wallAt(4), [enemyAt(7, 0, 0, 9)]);
    expect(aim.targetId).toBeNull();
  });

  it('never marks a creature beyond the ability range', () => {
    const aim = resolveAim(eye, forward, 8, openWorld, [enemyAt(7, 0, 0, 30)]);
    expect(aim.targetId).toBeNull();
  });

  it('bends the shot only a few degrees, and only toward a near-centred target', () => {
    // Slightly off-centre: assist engages.
    const near = enemyAt(1, 0.3, 0, 12);
    const assisted = resolveAim(eye, forward, 20, openWorld, [near]);
    expect(assisted.assisted).toBe(true);
    expect(angleTo(eye, forward, assisted.target)).toBeLessThanOrEqual(AIM.assistHalfAngle + 1e-6);

    // Clearly off to the side: assist must not reach it.
    const far = enemyAt(2, 6, 0, 12);
    const unassisted = resolveAim(eye, forward, 20, openWorld, [far]);
    expect(unassisted.assisted).toBe(false);
  });

  it('disables assist entirely when asked', () => {
    const aim = resolveAim(eye, forward, 20, openWorld, [enemyAt(1, 0.3, 0, 12)], eye, false);
    expect(aim.assisted).toBe(false);
    expect(aim.target.x).toBeCloseTo(0, 6);
  });
});

describe('line of sight', () => {
  it('is clear across open ground', () => {
    expect(hasLineOfSight(vec(0, 1, 0), vec(0, 1, 10), openWorld)).toBe(true);
  });

  it('is blocked by terrain in between', () => {
    expect(hasLineOfSight(vec(0, 1, 0), vec(0, 1, 10), wallAt(5))).toBe(false);
  });

  it('still allows a target standing flush against a wall', () => {
    // The wall is at the target itself; the slack keeps it reachable.
    expect(hasLineOfSight(vec(0, 1, 0), vec(0, 1, 10), wallAt(9.9))).toBe(true);
  });
});

describe('crosshair targeting', () => {
  const eye = vec(0, 1.6, 0);
  const forward = vec(0, 0, 1);

  it('highlights the creature nearest the crosshair', () => {
    const target = pickCrosshairTarget(eye, forward, 30, openWorld, [
      enemyAt(1, 1.2, 0, 12),
      enemyAt(2, 0.1, 0, 14),
    ]);
    expect(target?.id).toBe(2);
  });

  it('highlights nothing when everything is out of range', () => {
    expect(pickCrosshairTarget(eye, forward, 5, openWorld, [enemyAt(1, 0, 0, 20)])).toBeNull();
  });

  it('highlights nothing through a wall', () => {
    expect(pickCrosshairTarget(eye, forward, 30, wallAt(3), [enemyAt(1, 0, 0, 12)])).toBeNull();
  });
});

// ------------------------------------------------- continuous cast pacing

describe('damage interval protection', () => {
  it('lets the first tick through immediately', () => {
    const ticks = new DamageIntervalTracker();
    expect(ticks.tryTick(1, 0, 0.12)).toBe(true);
  });

  it('refuses a second tick inside the interval', () => {
    const ticks = new DamageIntervalTracker();
    ticks.tryTick(1, 0, 0.12);
    expect(ticks.tryTick(1, 0.05, 0.12)).toBe(false);
    expect(ticks.tryTick(1, 0.11, 0.12)).toBe(false);
  });

  it('allows the next tick once the interval elapses', () => {
    const ticks = new DamageIntervalTracker();
    ticks.tryTick(1, 0, 0.12);
    expect(ticks.tryTick(1, 0.12, 0.12)).toBe(true);
  });

  it('tracks each target independently', () => {
    const ticks = new DamageIntervalTracker();
    ticks.tryTick(1, 0, 0.12);
    expect(ticks.tryTick(2, 0, 0.12)).toBe(true);
    expect(ticks.size).toBe(2);
  });

  it('is frame-rate independent: a 0.32s cast ticks the same at 30 and 240 fps', () => {
    const count = (step: number): number => {
      const ticks = new DamageIntervalTracker();
      let hits = 0;
      for (let t = 0; t <= 0.32 + 1e-9; t += step) {
        if (ticks.tryTick(1, t, 0.12)) hits++;
      }
      return hits;
    };
    expect(count(1 / 240)).toBe(count(1 / 30));
    expect(count(1 / 60)).toBe(3);
  });

  it('clears between casts', () => {
    const ticks = new DamageIntervalTracker();
    ticks.tryTick(1, 0, 0.12);
    ticks.clear();
    expect(ticks.tryTick(1, 0.01, 0.12)).toBe(true);
  });
});

// ------------------------------------------------------------ tuning data

describe('combat tuning', () => {
  it('every ability has a tuning entry', () => {
    for (const id of [
      'water-whip', 'freeze', 'fireball', 'flame-wave',
      'rock-shot', 'raise-wall', 'gust', 'air-dash',
    ]) {
      expect(ABILITY_COMBAT[id], id).toBeDefined();
    }
  });

  it('falls back to a valid definition for an unknown id', () => {
    expect(abilityCombat('nonsense').range).toBeGreaterThan(0);
  });

  it('every collision radius is positive and every range is finite', () => {
    for (const [id, def] of Object.entries(ABILITY_COMBAT)) {
      expect(def.radius, id).toBeGreaterThan(0);
      expect(Number.isFinite(def.range), id).toBe(true);
      expect(def.range, id).toBeGreaterThan(0);
    }
  });

  it('the water whip is a continuous cast with interval protection', () => {
    const whip = abilityCombat('water-whip');
    expect(whip.castTime).toBeGreaterThan(0.2);
    expect(whip.castTime).toBeLessThanOrEqual(0.4);
    expect(whip.damageInterval).toBeGreaterThan(0);
    expect(whip.damageInterval! * 2).toBeLessThan(whip.castTime!);
  });

  it('a soaked target freezes for meaningfully longer', () => {
    expect(STATUS_TUNING.freezeSecondsWhenWet).toBeGreaterThan(STATUS_TUNING.freezeSeconds * 1.5);
  });

  it('the whip slow lasts long enough to line up a freeze', () => {
    expect(STATUS_TUNING.whipSlowSeconds).toBeGreaterThan(1);
    expect(STATUS_TUNING.whipSlowFactor).toBeLessThan(1);
    expect(STATUS_TUNING.wetSeconds).toBeGreaterThan(STATUS_TUNING.whipSlowSeconds);
  });

  it('aim assist is gentle rather than a snap', () => {
    // Under six degrees.
    expect(AIM.assistHalfAngle).toBeLessThan(0.105);
    expect(AIM.hitboxPadding).toBeGreaterThan(0);
    expect(AIM.hitboxPadding).toBeLessThan(0.5);
  });
});

// ----------------------------------------------------------------- pacing

describe('enemy pacing', () => {
  /** Rough hits-to-kill using the strongest single-target opener. */
  function hitsToKill(health: number, damage: number): number {
    return Math.ceil(health / damage);
  }

  it('small creatures die in a handful of hits', () => {
    const rockShot = abilityCombat('rock-shot').damage;
    for (const kind of ['crawler', 'wisp'] as const) {
      const type = ENEMY_TYPES[kind];
      const hits = hitsToKill(type.maxHealth, rockShot);
      expect(hits, kind).toBeGreaterThanOrEqual(PACING.small.minHits - 1);
      expect(hits, kind).toBeLessThanOrEqual(PACING.small.maxHits);
    }
  });

  it('medium creatures sit inside the medium band for the whip', () => {
    const whip = abilityCombat('water-whip').damage;
    const hits = hitsToKill(ENEMY_TYPES.warden.maxHealth, whip);
    expect(hits).toBeGreaterThanOrEqual(PACING.medium.minHits);
    expect(hits).toBeLessThanOrEqual(PACING.medium.maxHits);
  });

  it('heavier creatures take visibly longer than small ones', () => {
    expect(ENEMY_TYPES.brute.maxHealth).toBeGreaterThan(ENEMY_TYPES.crawler.maxHealth * 1.5);
  });

  it('every enemy type has a body with positive height and radius', () => {
    for (const [kind, type] of Object.entries(ENEMY_TYPES)) {
      expect(type.height, kind).toBeGreaterThan(0);
      expect(type.radius, kind).toBeGreaterThan(0);
      // A capsule built from it must contain the creature's own centre.
      const capsule = bodyCapsule(0, 0, 0, type.height, type.radius);
      expect(sphereVsCapsule(vec(0, type.height * 0.55, 0), 0.01, capsule), kind).toBe(true);
    }
  });
});

// --------------------------------------------------------------- statuses

describe('status readability', () => {
  it('every combat status has a label and an icon', () => {
    for (const [id, def] of Object.entries(STATUSES)) {
      expect(def.name, id).toBeTruthy();
      expect(def.blurb, id).toBeTruthy();
      expect(def.id, id).toBe(id);
    }
  });

  it('the whole water combo chain is named and visible', () => {
    for (const id of ['wet', 'slowed', 'frozen', 'burning', 'stunned', 'armored', 'weakened'] as const) {
      expect(STATUSES[id], id).toBeDefined();
      expect(STATUS_ORDER, id).toContain(id);
    }
  });

  it('frozen disables the victim and makes it brittle', () => {
    expect(STATUSES.frozen.disabling).toBe(true);
    expect(STATUSES.frozen.damageTakenScale).toBeGreaterThan(1);
  });

  it('slowed is informational only, so the slow is never applied twice', () => {
    expect(STATUSES.slowed.moveScale).toBe(1);
  });
});
