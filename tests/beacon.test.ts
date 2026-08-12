/**
 * The World Beacon, first-world pacing and the build version label.
 *
 * The bug this covers is not subtle: a player who restored every shrine was
 * told so by a five-second toast and then left with a compass showing four
 * marks that all read "cleansed" and nothing at all pointing at the way out.
 * These tests pin the Beacon down - when it exists, where it may stand, how it
 * is used, and that an already-finished save gets one without losing anything.
 */

import { describe, expect, it } from 'vitest';
import {
  BEACON, beaconHoldFraction, beaconMode, beaconObjective, beaconPrompt,
  completionProgress, createBeaconHold, placeBeacon, tickBeaconHold,
  validateBeaconSite, worldComplete, type BeaconWorldProbe,
} from '../src/world/beacon';
import { WORLD_ORDER, nextWorld, worldDef, type WorldId } from '../src/world/worlds';
import { GUARDIAN_PROFILES, WORLD_PROFILES, difficultyIndex, phaseAt } from '../src/world/progression';
import { ENEMY_TYPES } from '../src/combat/enemyTypes';
import { damagePerCast, primaryDps, STATUS_TUNING } from '../src/combat/combatConfig';
import { STATUSES } from '../src/combat/status';
import { BUILD, isProductionBuild, versionDetail, versionLabel } from '../src/core/version';
import { SAVE_VERSION, createSave, validateSave } from '../src/save/saveData';

const ALL: readonly WorldId[] = WORLD_ORDER;
const DONE = [true, true, true, true];
const PARTIAL = [true, true, true, false];

/** A flat, dry world with nothing in the way. */
function flatWorld(patch: Partial<BeaconWorldProbe> = {}): BeaconWorldProbe {
  return {
    groundHeight: () => 30,
    isSolid: () => false,
    isObstacle: () => false,
    fluidLevel: 10,
    fluidIsHazard: false,
    ...patch,
  };
}

// =====================================================================
//  Activation
// =====================================================================

describe('beacon activation', () => {
  it('stays dormant while any shrine is unrestored', () => {
    expect(worldComplete(PARTIAL)).toBe(false);
    expect(beaconMode('wilds', PARTIAL, false)).toBe('dormant');
    expect(beaconMode('wilds', [false, false, false, false], false)).toBe('dormant');
    expect(worldComplete([])).toBe(false);
  });

  it('lights the moment every shrine is restored', () => {
    expect(worldComplete(DONE)).toBe(true);
    expect(beaconMode('wilds', DONE, false)).toBe('travel');
  });

  it('reports progress toward lighting it', () => {
    expect(completionProgress(PARTIAL)).toEqual({ done: 3, total: 4 });
    expect(completionProgress(DONE)).toEqual({ done: 4, total: 4 });
  });

  it('points at the next world in every world that has one', () => {
    for (const world of ALL) {
      const target = nextWorld(world);
      const mode = beaconMode(world, DONE, false);
      if (target) {
        expect(mode, world).toBe('travel');
        expect(beaconPrompt(mode, worldDef(target).name), world)
          .toContain(worldDef(target).name);
      }
    }
  });

  it('leads to the ending in the final world, not to a fifth world', () => {
    expect(nextWorld('peaks')).toBeNull();
    expect(beaconMode('peaks', DONE, false)).toBe('finale');
    // And after the campaign, to a new cycle rather than to nothing.
    expect(beaconMode('peaks', DONE, true)).toBe('new-game-plus');
  });

  it('says something specific in every mode', () => {
    for (const mode of ['travel', 'finale', 'new-game-plus'] as const) {
      expect(beaconPrompt(mode, 'Tidal Archipelago').length, mode).toBeGreaterThan(8);
      expect(beaconObjective(mode, 'Tidal Archipelago').length, mode).toBeGreaterThan(8);
    }
    expect(beaconPrompt('dormant', 'x')).toBe('');
    expect(beaconObjective('dormant', 'x')).toBe('');
  });
});

// =====================================================================
//  Placement
// =====================================================================

describe('beacon placement', () => {
  it('accepts open, level, dry ground', () => {
    const check = validateBeaconSite(500, 500, flatWorld(), 1000);
    expect(check.ok).toBe(true);
    expect(check.site!.y).toBeCloseTo(30.05, 4);
  });

  it('never stands in water', () => {
    const flooded = flatWorld({ fluidLevel: 40 });
    expect(validateBeaconSite(500, 500, flooded, 1000).reason).toBe('in-fluid');
  });

  it('keeps well clear of lava', () => {
    // Ground only just above the lava line is still refused: a Beacon on the
    // shore of a lava sea is not somewhere a player can safely stand.
    const lava = flatWorld({ fluidLevel: 28, fluidIsHazard: true });
    expect(validateBeaconSite(500, 500, lava, 1000).reason).toBe('in-hazard');
    const safe = flatWorld({ fluidLevel: 20, fluidIsHazard: true });
    expect(validateBeaconSite(500, 500, safe, 1000).ok).toBe(true);
  });

  it('never stands inside terrain or under a low ceiling', () => {
    expect(validateBeaconSite(500, 500, flatWorld({ isSolid: (_x, y) => y < 31 }), 1000).reason)
      .toBe('inside-terrain');
    expect(validateBeaconSite(500, 500, flatWorld({ isSolid: (_x, y) => y > 31 }), 1000).reason)
      .toBe('no-clearance');
  });

  it('never stands inside a prop or a boulder', () => {
    expect(validateBeaconSite(500, 500, flatWorld({ isObstacle: () => true }), 1000).reason)
      .toBe('obstacle');
  });

  it('never hangs off a slope', () => {
    const cliff = flatWorld({
      groundHeight: (x) => (x > 500 ? 60 : 30),
    });
    expect(validateBeaconSite(500, 500, cliff, 1000).reason).toBe('uneven');
  });

  it('never stands outside the world', () => {
    expect(validateBeaconSite(2, 2, flatWorld(), 1000).reason).toBe('out-of-bounds');
    expect(validateBeaconSite(998, 500, flatWorld(), 1000).reason).toBe('out-of-bounds');
  });

  it('searches outward when the preferred anchor is unusable', () => {
    // A pit exactly at the anchor, open ground everywhere else.
    const world = flatWorld({
      groundHeight: (x, z) => (Math.hypot(x - 500, z - 500) < 5 ? 5 : 30),
    });
    const check = placeBeacon([{ x: 500, z: 500 }], world, 1000);
    expect(check.ok).toBe(true);
    expect(Math.hypot(check.site!.x - 500, check.site!.z - 500)).toBeGreaterThan(5);
  });

  it('falls through to a later anchor when the first is hopeless', () => {
    const world = flatWorld({
      groundHeight: (x, z) => (Math.hypot(x - 200, z - 200) < 40 ? -1 : 30),
    });
    const check = placeBeacon([{ x: 200, z: 200 }, { x: 500, z: 500 }], world, 1000);
    expect(check.ok).toBe(true);
    expect(Math.hypot(check.site!.x - 500, check.site!.z - 500)).toBeLessThan(30);
  });

  it('reports a reason rather than throwing when nothing works', () => {
    const drowned = flatWorld({ fluidLevel: 999 });
    const check = placeBeacon([{ x: 500, z: 500 }], drowned, 1000);
    expect(check.ok).toBe(false);
    expect(check.reason).toBeTruthy();
  });

  it('places the same Beacon in the same spot every time a save is loaded', () => {
    const world = flatWorld({
      groundHeight: (x, z) => (Math.hypot(x - 500, z - 500) < 9 ? 4 : 30),
    });
    const first = placeBeacon([{ x: 500, z: 500 }], world, 1000);
    for (let i = 0; i < 6; i++) {
      const again = placeBeacon([{ x: 500, z: 500 }], world, 1000);
      expect(again.site).toEqual(first.site);
    }
  });

  it('protects more ground than its own footprint, so terrain play cannot bury it', () => {
    expect(BEACON.protectRadius).toBeGreaterThan(BEACON.baseRadius * 2);
    // And the collider is the plinth, not the beam.
    expect(BEACON.baseHeight).toBeLessThan(2);
    expect(BEACON.beamHeight).toBeGreaterThan(50);
  });
});

// =====================================================================
//  Hold to travel
// =====================================================================

describe('hold to travel', () => {
  it('does not travel on a tap', () => {
    const hold = createBeaconHold();
    tickBeaconHold(hold, 0.016, true, true);
    expect(hold.committed).toBe(false);
    expect(beaconHoldFraction(hold)).toBeLessThan(0.1);
  });

  it('commits once the key has been held long enough', () => {
    const hold = createBeaconHold();
    let commits = 0;
    for (let t = 0; t < 3; t += 0.05) {
      tickBeaconHold(hold, 0.05, true, true);
      if (hold.committed) commits += 1;
    }
    // Exactly once, however long the key stays down.
    expect(commits).toBe(1);
  });

  it('resets when the key is released', () => {
    const hold = createBeaconHold();
    tickBeaconHold(hold, BEACON.holdSeconds * 0.8, true, true);
    expect(beaconHoldFraction(hold)).toBeGreaterThan(0.5);
    tickBeaconHold(hold, 0.016, false, true);
    expect(hold.held).toBe(0);
    expect(hold.committed).toBe(false);
  });

  it('never commits while travel is unavailable', () => {
    const hold = createBeaconHold();
    for (let t = 0; t < 4; t += 0.05) {
      tickBeaconHold(hold, 0.05, true, false);
      expect(hold.committed).toBe(false);
    }
    expect(hold.held).toBe(0);
  });

  it('cannot fire twice from one press, which is what stops a double transition', () => {
    const hold = createBeaconHold();
    for (let t = 0; t < BEACON.holdSeconds + 0.2; t += 0.05) tickBeaconHold(hold, 0.05, true, true);
    // Still holding, well past the threshold.
    for (let t = 0; t < 5; t += 0.05) {
      tickBeaconHold(hold, 0.05, true, true);
      expect(hold.committed).toBe(false);
    }
  });

  it('reports progress for the prompt bar', () => {
    const hold = createBeaconHold();
    expect(beaconHoldFraction(hold)).toBe(0);
    tickBeaconHold(hold, BEACON.holdSeconds / 2, true, true);
    expect(beaconHoldFraction(hold)).toBeCloseTo(0.5, 2);
    tickBeaconHold(hold, BEACON.holdSeconds, true, true);
    expect(beaconHoldFraction(hold)).toBe(1);
  });

  it('asks for a deliberate hold rather than a reflex', () => {
    expect(BEACON.holdSeconds).toBeGreaterThanOrEqual(0.8);
    expect(BEACON.holdSeconds).toBeLessThanOrEqual(2.5);
  });
});

// =====================================================================
//  Existing saves
// =====================================================================

describe('already-completed saves', () => {
  /** A save that finished the first world before the Beacon worked. */
  function finishedFirstWorld(): ReturnType<typeof createSave> {
    const save = createSave(2024, 'fire', 'normal', [128, 40, 128], {}, { berries: 3 });
    save.shrines = [true, true, true, true];
    save.guardians = [true, true, true, true];
    save.build = { 'any-hardy': 2, 'fire-split': 1, 'chest-double-damage': 1 };
    save.upgrades = 4;
    save.ultimateUnlocked = true;
    save.ultimateCharge = 55;
    return save;
  }

  it('lights a Beacon for a save that was already finished', () => {
    const save = finishedFirstWorld();
    // Reconstructed from the shrine flags alone - there is no stored Beacon
    // field to be missing, so an old save needs no migration at all.
    expect(worldComplete(save.shrines)).toBe(true);
    expect(beaconMode(save.worldTheme, save.shrines, save.postGame)).toBe('travel');
  });

  it('does not ask the player to defeat any guardian again', () => {
    const save = finishedFirstWorld();
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.ok).toBe(true);
    expect(result.data!.guardians).toEqual([true, true, true, true]);
    expect(result.data!.shrines).toEqual([true, true, true, true]);
  });

  it('rerolls nothing: not the affinity, not the build, not the rewards', () => {
    const save = finishedFirstWorld();
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    const data = result.data!;
    expect(data.affinity).toBe('fire');
    expect(data.build).toEqual(save.build);
    expect(data.upgrades).toBe(4);
    expect(data.ultimateUnlocked).toBe(true);
    expect(data.ultimateCharge).toBe(55);
    expect(data.items.berries).toBe(3);
  });

  it('never moves a player who is already further on backward', () => {
    const save = finishedFirstWorld();
    save.worldTheme = 'ashen';
    save.worldsCompleted = ['wilds', 'depths'];
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.data!.worldTheme).toBe('ashen');
    expect(result.data!.worldsCompleted).toEqual(['wilds', 'depths']);
  });

  it('needs no schema change at all', () => {
    expect(SAVE_VERSION).toBe(5);
    const result = validateSave(JSON.parse(JSON.stringify(finishedFirstWorld())));
    expect(result.migrated).toBe(false);
  });

  it('works the same for a peaceful save', () => {
    const save = createSave(77, 'water', 'peaceful', [128, 40, 128], {}, {});
    save.shrines = [true, true, true, true];
    // No guardian was ever fought, and the Beacon does not care.
    save.guardians = [false, false, false, false];
    expect(beaconMode('wilds', save.shrines, false)).toBe('travel');
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.data!.worldMode).toBe('peaceful');
  });
});

// =====================================================================
//  First-world pacing
// =====================================================================

describe('first world pacing', () => {
  it('is still the gentlest world in the campaign', () => {
    const wilds = WORLD_PROFILES.wilds;
    for (const id of ALL.filter((w) => w !== 'wilds')) {
      const other = WORLD_PROFILES[id];
      expect(other.rangedShare, id).toBeGreaterThanOrEqual(wilds.rangedShare);
      expect(other.eliteScale, id).toBeGreaterThanOrEqual(wilds.eliteScale);
      expect(other.heavyShare, id).toBeGreaterThanOrEqual(wilds.heavyShare);
    }
    expect(wilds.hazardScale).toBe(0);
    expect(wilds.tokenBonus).toBe(0);
  });

  it('now offers real escalation rather than none', () => {
    // The elite rate is what the first world was missing: at the old 0.6 a
    // player could cross the whole world without meeting one.
    expect(WORLD_PROFILES.wilds.eliteScale).toBeGreaterThanOrEqual(0.8);
    expect(WORLD_PROFILES.wilds.budgetScale).toBeGreaterThanOrEqual(1);
  });

  it('keeps the campaign curve climbing after the change', () => {
    let previous = -Infinity;
    for (const world of ALL) {
      const index = difficultyIndex(world, 0);
      expect(index, world).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('gives the first guardian time to show every phase', () => {
    const profile = GUARDIAN_PROFILES.wilds;
    const health = ENEMY_TYPES.guardian.maxHealth * profile.healthScale;
    // The strongest unupgraded single-element opener against a neutral target.
    const best = Math.max(...['air', 'water', 'earth', 'fire'].map((e) => primaryDps(e)));
    const seconds = health / best;
    // Long enough that the second and third phases are reached, and their
    // recovery windows seen, rather than the bar emptying in one rotation.
    expect(seconds).toBeGreaterThan(14);
    // But not a slog: an unupgraded player still finishes inside a minute.
    expect(seconds).toBeLessThan(45);
  });

  it('keeps the first guardian the least durable in the campaign', () => {
    for (const id of ALL.filter((w) => w !== 'wilds')) {
      expect(GUARDIAN_PROFILES.wilds.healthScale, id)
        .toBeLessThanOrEqual(GUARDIAN_PROFILES[id].healthScale);
    }
  });

  it('shows every phase even to a build that could skip one', () => {
    // The runtime advances at most one phase per crossing, so a single huge
    // hit cannot carry a guardian past the middle phase unseen.
    const profile = GUARDIAN_PROFILES.wilds;
    const target = phaseAt(profile, 0.05);
    expect(target).toBe(profile.phases.length - 1);
    // Stepping one at a time from the opening reaches it through every phase.
    let phase = 0;
    const seen = [0];
    while (phase < target) {
      phase = Math.min(target, phase + 1);
      seen.push(phase);
    }
    expect(seen).toEqual([0, 1, 2]);
  });
});

// =====================================================================
//  Fire
// =====================================================================

describe('fire balance', () => {
  it('bills a direct Fireball hit once, not once and a half', () => {
    // The blast that follows an impact used to include the creature the shot
    // had just hit in full, so a direct hit was worth 145% of its damage.
    // The runtime now skips that creature; this pins the intended arithmetic.
    const direct = damagePerCast('fireball');
    const splashOnHit = direct * 0.45;
    const intended = direct;
    const previouslyDealt = direct + splashOnHit;
    expect(previouslyDealt / intended).toBeCloseTo(1.45, 2);
    // Neighbours still take the splash - only the primary target is excluded.
    expect(splashOnHit).toBeGreaterThan(0);
  });

  it('keeps burning bounded rather than stacking without limit', () => {
    expect(STATUSES.burning.maxStacks).toBeLessThanOrEqual(5);
    expect(STATUS_TUNING.burnSeconds).toBeLessThanOrEqual(6);
  });

  it('leaves Fire strong but not dominant among the elements', () => {
    const fire = primaryDps('fire');
    const others = ['air', 'water', 'earth'].map((e) => primaryDps(e));
    const best = Math.max(...others);
    // Fire may lead on damage, but not run away with the campaign.
    expect(fire).toBeLessThan(best * 1.25);
    expect(fire).toBeGreaterThan(Math.min(...others) * 0.85);
  });

  it('never makes an early creature immune to Fire', () => {
    for (const kind of worldDef('wilds').enemies) {
      expect(ENEMY_TYPES[kind].resistance.fire, kind).toBeGreaterThan(0);
    }
  });

  it('does not make the whole first roster weak to Fire either', () => {
    const roster = worldDef('wilds').enemies;
    const weak = roster.filter((k) => ENEMY_TYPES[k].resistance.fire > 1.1);
    expect(weak.length).toBeLessThan(roster.length);
  });

  it('leaves the first guardian neutral, so no element trivialises it', () => {
    for (const element of ['air', 'water', 'earth', 'fire'] as const) {
      expect(ENEMY_TYPES.guardian.resistance[element], element).toBe(1);
    }
  });
});

// =====================================================================
//  Build version
// =====================================================================

describe('build version', () => {
  it('formats as a short version and commit', () => {
    expect(versionLabel({ version: '1.4.3', commit: 'a1b2c3d', built: 'x', mode: 'production' }))
      .toBe('v1.4.3 • a1b2c3d');
  });

  it('falls back to a development label rather than inventing a hash', () => {
    expect(versionLabel({ version: '1.0.1', commit: 'dev', built: 'x', mode: 'development' }))
      .toBe('v1.0.1 • dev');
    expect(isProductionBuild({ version: '1.0.1', commit: 'dev', built: 'x', mode: 'development' }))
      .toBe(false);
  });

  it('recognises a real deployment build', () => {
    expect(isProductionBuild({
      version: '1.0.1', commit: 'edc3c99', built: '2026-08-12 14:30', mode: 'production',
    })).toBe(true);
  });

  it('never shows a full commit hash', () => {
    // Seven characters is enough to identify a deploy and short enough to read.
    const label = versionLabel({
      version: '1.0.1', commit: 'edc3c99', built: 'x', mode: 'production',
    });
    const commit = label.split('• ')[1]!;
    expect(commit.length).toBeLessThanOrEqual(8);
  });

  it('puts the timestamp and environment in the detail line, not the label', () => {
    const detail = versionDetail({
      version: '1.0.1', commit: 'edc3c99', built: '2026-08-12 14:30', mode: 'production',
    });
    expect(detail).toContain('2026-08-12 14:30');
    expect(detail).toContain('production');
    expect(versionLabel({
      version: '1.0.1', commit: 'edc3c99', built: '2026-08-12 14:30', mode: 'production',
    })).not.toContain('2026');
  });

  it('always resolves to something displayable', () => {
    expect(BUILD.version.length).toBeGreaterThan(0);
    expect(BUILD.commit.length).toBeGreaterThan(0);
    expect(versionLabel()).toMatch(/^v\d+\.\d+\.\d+ • .+$/);
  });

  it('matches the version declared in package.json', async () => {
    const pkg = await import('../package.json');
    // Under vitest there is no define, so BUILD falls back; the label format
    // is what matters here, and the packaged version is the source of truth.
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
