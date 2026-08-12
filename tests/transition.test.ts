import { describe, it, expect } from 'vitest';
import {
  TRANSITION, TRANSITION_CLEANUP, beginTransition, completeTransition, createTransition,
  failTransition, isTransitionActive, noteTransitionProgress, transitionMessage,
  transitionSilence, transitionStalled,
} from '../src/game/transition';
import {
  BEACON, beaconMode, beaconOwnsHold, beaconHoldFraction, createBeaconHold, tickBeaconHold,
} from '../src/world/beacon';
import { SHRINE_INTERACT_RADIUS } from '../src/world/shrineData';

const SNAPSHOT = '{"version":5,"worldTheme":"wilds"}';

describe('the Beacon owns the interact hold', () => {
  // The production blocker this suite exists for: a Beacon is placed beside the
  // shrine that finished the world, a cleansed shrine is a rest site, and both
  // were driven by holding E. Travelling therefore started a rest as well, and
  // the rest blackout stayed up over the destination world for ever.
  it('claims the hold inside its own radius', () => {
    expect(beaconOwnsHold('travel', 0)).toBe(true);
    expect(beaconOwnsHold('travel', BEACON.interactRadius)).toBe(true);
    expect(beaconOwnsHold('travel', BEACON.interactRadius - 0.01)).toBe(true);
  });

  it('releases the hold outside its radius, so resting still works', () => {
    expect(beaconOwnsHold('travel', BEACON.interactRadius + 0.01)).toBe(false);
    expect(beaconOwnsHold('travel', 12)).toBe(false);
  });

  it('never claims the hold while dormant', () => {
    // Before the world is finished there is no Beacon, and the shrine is a
    // rest site like any other.
    for (const d of [0, 1, BEACON.interactRadius, 40]) {
      expect(beaconOwnsHold('dormant', d)).toBe(false);
    }
  });

  it('claims the hold in every live mode, not just travel', () => {
    expect(beaconOwnsHold('finale', 1)).toBe(true);
    expect(beaconOwnsHold('new-game-plus', 1)).toBe(true);
  });

  it('refuses a distance that is not a number', () => {
    expect(beaconOwnsHold('travel', Number.NaN)).toBe(false);
    expect(beaconOwnsHold('travel', Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('leaves room to rest on the same shrine', () => {
    // The rest radius is larger than the Beacon's, so a player who wants to
    // rest at the shrine that finished the world can still do it a few paces
    // away rather than losing the rest site entirely.
    const restRadius = SHRINE_INTERACT_RADIUS + 2;
    expect(restRadius).toBeGreaterThan(BEACON.interactRadius);
    const stepBack = (restRadius + BEACON.interactRadius) / 2;
    expect(beaconOwnsHold('travel', stepBack)).toBe(false);
    expect(stepBack).toBeLessThanOrEqual(restRadius);
  });

  it('agrees with the mode the Beacon itself resolves', () => {
    const unfinished = [true, true, true, false];
    const finished = [true, true, true, true];
    expect(beaconOwnsHold(beaconMode('wilds', unfinished, false), 1)).toBe(false);
    expect(beaconOwnsHold(beaconMode('wilds', finished, false), 1)).toBe(true);
  });
});

describe('the transition state machine', () => {
  it('starts idle and holds nothing', () => {
    const t = createTransition();
    expect(t.phase).toBe('idle');
    expect(isTransitionActive(t)).toBe(false);
    expect(t.rollback).toBeNull();
  });

  it('claims the transition and keeps the recovery snapshot', () => {
    const t = createTransition();
    expect(beginTransition(t, 'wilds', 'depths', SNAPSHOT, 1000)).toBe(true);
    expect(isTransitionActive(t)).toBe(true);
    expect(t.from).toBe('wilds');
    expect(t.to).toBe('depths');
    expect(t.rollback).toBe(SNAPSHOT);
  });

  it('refuses a second transition while one is running', () => {
    // Beacon activation is idempotent: holding the key through the commit, or
    // any second call, must not stack a second world load on the first.
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    expect(beginTransition(t, 'wilds', 'ashen', 'other', 10)).toBe(false);
    expect(t.to).toBe('depths');
    expect(t.rollback).toBe(SNAPSHOT);
  });

  it('accepts a new transition once the last one completed', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    completeTransition(t);
    expect(beginTransition(t, 'depths', 'ashen', SNAPSHOT, 10)).toBe(true);
  });

  it('accepts a new transition once the last one failed', () => {
    // A failed transition must not lock the Beacon for the rest of the session.
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    failTransition(t, 'error');
    expect(isTransitionActive(t)).toBe(false);
    expect(beginTransition(t, 'wilds', 'depths', SNAPSHOT, 10)).toBe(true);
  });

  it('hands the snapshot back exactly once', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    expect(failTransition(t, 'error')).toBe(SNAPSHOT);
    expect(failTransition(t, 'error')).toBeNull();
  });

  it('drops the snapshot on success, so nothing can roll back afterwards', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    completeTransition(t);
    expect(t.rollback).toBeNull();
    expect(t.failure).toBeNull();
  });

  it('advances through commit, load and enter', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    expect(t.phase).toBe('commit');
    noteTransitionProgress(t, 'load', 100);
    expect(t.phase).toBe('load');
    noteTransitionProgress(t, 'enter', 200);
    expect(t.phase).toBe('enter');
  });

  it('ignores progress reported while idle', () => {
    const t = createTransition();
    noteTransitionProgress(t, 'load', 500);
    expect(t.phase).toBe('idle');
  });
});

describe('the stall backstop', () => {
  it('never fires while idle', () => {
    const t = createTransition();
    expect(transitionStalled(t, 10_000_000)).toBe(false);
    expect(transitionSilence(t, 10_000_000)).toBe(0);
  });

  it('does not fire on a slow but advancing load', () => {
    // Measures whether the load is getting anywhere, not how long it takes: a
    // cold machine that keeps meshing for minutes still finishes rather than
    // being thrown back to the title.
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    let now = 0;
    const steps = 200;
    for (let i = 1; i <= steps; i++) {
      now += TRANSITION.stallSeconds * 1000 * 0.9;
      noteTransitionProgress(t, 'load', now, i / steps);
      expect(transitionStalled(t, now)).toBe(false);
    }
    expect(now / 1000).toBeGreaterThan(TRANSITION.stallSeconds * 100);
  });

  it('fires when the load keeps running without getting anywhere', () => {
    // The case that matters: `stepLoading` runs every frame, so "did a frame
    // happen" proves nothing. Only the percentage moving counts as progress.
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    noteTransitionProgress(t, 'load', 1000, 0.6);
    let now = 1000;
    let stalled = false;
    for (let i = 0; i < 4000 && !stalled; i++) {
      now += 16;
      noteTransitionProgress(t, 'load', now, 0.6);
      stalled = transitionStalled(t, now);
    }
    expect(stalled).toBe(true);
    expect((now - 1000) / 1000).toBeGreaterThan(TRANSITION.stallSeconds);
  });

  it('fires when the load stops reporting at all', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    noteTransitionProgress(t, 'load', 1000, 0.2);
    expect(transitionStalled(t, 1000 + TRANSITION.stallSeconds * 1000)).toBe(false);
    expect(transitionStalled(t, 1000 + TRANSITION.stallSeconds * 1000 + 1)).toBe(true);
  });

  it('treats a phase change as progress on its own', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    noteTransitionProgress(t, 'load', 1000, 1);
    // Handing over is progress even though the percentage cannot climb further.
    noteTransitionProgress(t, 'enter', 1000 + TRANSITION.stallSeconds * 1000, 1);
    expect(transitionStalled(t, 1000 + TRANSITION.stallSeconds * 1000 + 5)).toBe(false);
  });

  it('never counts progress going backwards as progress', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    noteTransitionProgress(t, 'load', 1000, 0.9);
    let now = 1000;
    for (let i = 0; i < 4000; i++) {
      now += 16;
      noteTransitionProgress(t, 'load', now, 0.1);
    }
    expect(transitionStalled(t, now)).toBe(true);
    expect(t.progress).toBeCloseTo(0.9, 6);
  });

  it('is generous enough for a real world build', () => {
    // A backstop that fires during ordinary loading would be its own bug.
    expect(TRANSITION.stallSeconds).toBeGreaterThanOrEqual(30);
  });

  it('reports how long the load has been silent', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 2000);
    expect(transitionSilence(t, 5000)).toBeCloseTo(3, 6);
    expect(transitionSilence(t, 1000)).toBe(0);
  });
});

describe('failure messages', () => {
  it('tells the player their progress survived, whatever went wrong', () => {
    for (const reason of ['write', 'error', 'stalled', 'abandoned'] as const) {
      const message = transitionMessage(reason, 'Tidal Archipelago');
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).toMatch(/intact|nothing lost/);
    }
  });

  it('names the destination when the destination is what failed', () => {
    expect(transitionMessage('error', 'Tidal Archipelago')).toContain('Tidal Archipelago');
    expect(transitionMessage('stalled', 'Tidal Archipelago')).toContain('Tidal Archipelago');
  });

  it('says the player is staying put when nothing was committed', () => {
    expect(transitionMessage('write', 'Tidal Archipelago')).toMatch(/staying in this world/);
  });

  it('records why the last transition failed', () => {
    const t = createTransition();
    beginTransition(t, 'wilds', 'depths', SNAPSHOT, 0);
    failTransition(t, 'stalled');
    expect(t.failure).toBe('stalled');
  });
});

describe('the cleanup contract', () => {
  it('lists every piece of state that can black out or freeze a world', () => {
    // Each of these, left set while the world underneath it is replaced, is on
    // its own enough to leave the player looking at a black or dead screen.
    // The fade overlay is the one that shipped.
    for (const owed of [
      'transition-flag', 'loading-state', 'fade-overlay', 'pause-state',
      'input-lock', 'story-lock', 'interact-holds', 'hit-stop',
    ]) {
      expect(TRANSITION_CLEANUP).toContain(owed);
    }
  });

  it('is frozen, so an obligation cannot be dropped at runtime', () => {
    expect(Object.isFrozen(TRANSITION_CLEANUP)).toBe(true);
  });
});

describe('committing the hold', () => {
  it('commits exactly once per press', () => {
    const hold = createBeaconHold();
    let commits = 0;
    for (let i = 0; i < 200; i++) {
      tickBeaconHold(hold, 0.016, true, true);
      if (hold.committed) commits++;
    }
    expect(commits).toBe(1);
  });

  it('re-arms after the key is released', () => {
    const hold = createBeaconHold();
    const press = (): number => {
      let commits = 0;
      for (let i = 0; i < 200; i++) {
        tickBeaconHold(hold, 0.016, true, true);
        if (hold.committed) commits++;
      }
      tickBeaconHold(hold, 0.016, false, true);
      return commits;
    };
    expect(press()).toBe(1);
    expect(press()).toBe(1);
  });

  it('cannot charge while a transition is already running', () => {
    // The Beacon is disabled for the whole transition, so a player still
    // leaning on the key when the world changes does not travel twice.
    const hold = createBeaconHold();
    for (let i = 0; i < 200; i++) {
      tickBeaconHold(hold, 0.016, true, false);
      expect(hold.committed).toBe(false);
    }
    expect(beaconHoldFraction(hold)).toBe(0);
  });

  it('resets its progress when the transition takes the key away', () => {
    const hold = createBeaconHold();
    tickBeaconHold(hold, 0.5, true, true);
    expect(beaconHoldFraction(hold)).toBeGreaterThan(0);
    tickBeaconHold(hold, 0.016, true, false);
    expect(beaconHoldFraction(hold)).toBe(0);
  });
});
