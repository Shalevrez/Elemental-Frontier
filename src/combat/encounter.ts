/**
 * Encounter pacing.
 *
 * The old spawner was a faucet: every 2.6 seconds it rolled a die and, if the
 * die agreed, put another creature into the world. That produces a world that
 * is never quiet and never builds to anything.
 *
 * This module replaces the faucet with a cycle:
 *
 *   explore -> buildup -> active -> peak -> resolve -> recover -> explore
 *
 * `explore` is deliberately quiet, but not empty: the longer the player goes
 * without finding anything, the more willing the director becomes to seed the
 * next encounter, so the "something every 30-60 seconds" target is met by
 * rising pressure rather than by a metronome. Once an encounter opens it gets
 * a fixed threat budget; reinforcements draw from a smaller second budget and
 * stop entirely part-way through, so a fight resolves instead of trickling.
 *
 * Pure state and arithmetic - no engine imports - so every rule here is
 * testable without a world.
 */

import { ENCOUNTER } from './combatConfig';

export type EncounterPhase =
  | 'explore'   // quiet; the director is looking for a reason to start
  | 'buildup'   // the first creatures are placed but not yet engaging
  | 'active'    // the fight proper
  | 'peak'      // reinforcements have arrived; the intensity high point
  | 'resolve'   // the last creatures are being cleaned up
  | 'recover';  // guaranteed quiet after a meaningful fight

/** Why the director refused a spawn. Surfaced to the debug overlay only. */
export type SpawnRefusal =
  | 'peaceful'
  | 'player-down'
  | 'low-health'
  | 'not-playing'
  | 'recovering'
  | 'too-soon'
  | 'budget-full'
  | 'crowded'
  | 'reinforcements-closed'
  | 'intensity';

/** Everything the director needs to know about the world this frame. */
export interface EncounterSignals {
  /** Live hostile creatures that belong to the wandering population. */
  liveEnemies: number;
  /** True when a hostile is close enough to be pressuring the player. */
  engaged: boolean;
  /** Player health as a fraction of maximum. */
  healthFraction: number;
  /** False while a story beat, reward screen or transition owns the screen. */
  playing: boolean;
  /** False while the player is dead or inside respawn protection. */
  playerReady: boolean;
  /** True in Peaceful Mode, or anywhere hostiles are forbidden. */
  peaceful: boolean;
  /** True when a scenario is driving its own spawns (waves, sieges, bosses). */
  scenarioDriven: boolean;
  /**
   * 0..1 pressure from the surroundings - proximity to an uncleansed shrine,
   * a blighted region, an objective. High pressure lets an encounter start
   * sooner than the plain exploration timer would.
   */
  locationPressure: number;
}

export interface EncounterStatus {
  phase: EncounterPhase;
  /** Threat still available in the opening budget. */
  budgetLeft: number;
  /** Threat still available for reinforcements. */
  reinforcementLeft: number;
  /** Seconds the current encounter has been running. */
  elapsed: number;
  /** Seconds since the last encounter resolved. */
  sinceEncounter: number;
  /** Rolling memory of how hard the recent fighting has been, 0..~2. */
  intensity: number;
  /** Set for one tick when an encounter closes. */
  justResolved: boolean;
  /** Encounters opened since the director was created. */
  encounters: number;
}

/** The answer to "may something spawn right now, and how much of it?". */
export interface SpawnVerdict {
  allowed: boolean;
  reason?: SpawnRefusal;
  /** Threat weight the director is willing to place this tick. */
  threat: number;
  /** True when this spawn opens a new encounter rather than reinforcing one. */
  opens: boolean;
}

/**
 * Budget for one encounter at a given depth.
 *
 * Threat is the same currency the enemy roster uses, so a budget of 4 is four
 * crawlers, or one stone beast plus a spitter.
 */
export function encounterBudget(depth: number): number {
  const d = Math.max(0, depth);
  return Math.min(
    ENCOUNTER.maxBudget,
    ENCOUNTER.baseBudget + d * ENCOUNTER.budgetPerDepth,
  );
}

export class EncounterDirector {
  private phase: EncounterPhase = 'explore';
  private budget = 0;
  private reinforcement = 0;
  private elapsed = 0;
  private since: number = ENCOUNTER.discoveryMin;
  private recovery = 0;
  private buildup = 0;
  private intensity = 0;
  private resolved = false;
  private count = 0;
  private depth = 0;
  /** Seconds since the last creature was placed, so packs are not spread out. */
  private sinceSpawn = 99;
  /** Beat spent in the resolve phase before recovery begins. */
  private resolveTimer = 0;

  /** Scale set by the world profile, applied on top of the depth budget. */
  private budgetScale = 1;

  setDepth(depth: number): void {
    this.depth = Math.max(0, depth);
  }

  /**
   * How much larger or smaller this world's encounters are.
   *
   * The teaching world runs below one, the last world above it. The result is
   * still clamped by `encounterBudget`'s own ceiling and by the live-creature
   * cap, so no world can flood the arena.
   */
  setBudgetScale(scale: number): void {
    this.budgetScale = Math.max(0.5, Math.min(2, scale));
  }

  get status(): EncounterStatus {
    return {
      phase: this.phase,
      budgetLeft: this.budget,
      reinforcementLeft: this.reinforcement,
      elapsed: this.elapsed,
      sinceEncounter: this.since,
      intensity: this.intensity,
      justResolved: this.resolved,
      encounters: this.count,
    };
  }

  get currentPhase(): EncounterPhase {
    return this.phase;
  }

  /** True while the director is deliberately keeping the world quiet. */
  get recovering(): boolean {
    return this.phase === 'recover';
  }

  /**
   * Advance the cycle.
   *
   * Called once per frame with what the world currently looks like. Returns
   * nothing: everything the caller needs is on `status`, and the spawn
   * decision is a separate question asked through `requestSpawn`.
   */
  update(dt: number, signals: EncounterSignals): void {
    this.resolved = false;
    this.sinceSpawn += dt;
    // Intensity decays toward zero whenever the player is not being fought.
    const target = signals.engaged ? 1 : 0;
    const rate = signals.engaged ? ENCOUNTER.intensityDecay * 4 : ENCOUNTER.intensityDecay;
    this.intensity += (target - this.intensity) * Math.min(1, rate * dt * 4);

    if (this.recovery > 0) this.recovery = Math.max(0, this.recovery - dt);
    if (this.buildup > 0) this.buildup = Math.max(0, this.buildup - dt);

    // Peaceful Mode collapses the whole machine back to exploration and holds
    // it there, so nothing can be mid-encounter when hostiles are forbidden.
    if (signals.peaceful) {
      this.closeEncounter(0);
      this.since = 0;
      return;
    }

    switch (this.phase) {
      case 'explore':
        this.since += dt;
        break;

      case 'buildup':
        this.elapsed += dt;
        if (this.buildup <= 0 || signals.engaged) this.phase = 'active';
        break;

      case 'active':
        this.elapsed += dt;
        if (signals.liveEnemies === 0 && this.elapsed > 2) {
          this.phase = 'resolve';
          this.resolveTimer = 0;
        } else if (this.reinforcement <= 0 || !this.reinforcementsOpen()) {
          // Nothing more is coming: the fight is already at its high point.
          this.phase = 'peak';
        }
        break;

      case 'peak':
        this.elapsed += dt;
        if (signals.liveEnemies === 0) {
          this.phase = 'resolve';
          this.resolveTimer = 0;
        }
        break;

      case 'resolve':
        this.elapsed += dt;
        // A short beat before the world goes quiet, so the last kill lands
        // before the recovery period starts counting.
        this.resolveTimer += dt;
        if (this.resolveTimer > 0.5) this.closeEncounter(ENCOUNTER.recoverySeconds);
        break;

      case 'recover':
        this.since += dt;
        if (this.recovery <= 0) this.phase = 'explore';
        break;

      default:
        break;
    }

    // A fight that never ends is a pacing failure of its own. Close it out and
    // let the caller clean up whatever is left standing.
    if (this.elapsed > ENCOUNTER.hardTimeout && this.phase !== 'explore' && this.phase !== 'recover') {
      this.closeEncounter(ENCOUNTER.recoverySeconds);
    }
  }

  /** Are reinforcements still allowed this far into the encounter? */
  private reinforcementsOpen(): boolean {
    return this.elapsed < ENCOUNTER.targetMax * ENCOUNTER.reinforcementWindow;
  }

  /**
   * How willing the director is to open an encounter right now, 0..1.
   *
   * Rises from nothing at `discoveryMin` to certainty at `discoveryMax`, and
   * a location the player has walked into - a blighted shrine, an objective -
   * pulls that curve forward rather than replacing it. That is what keeps
   * "find something within 30-60 seconds" true without a metronome.
   */
  readiness(signals: EncounterSignals): number {
    const pull = Math.max(0, Math.min(1, signals.locationPressure));
    const min = ENCOUNTER.discoveryMin * (1 - pull * 0.55);
    const max = ENCOUNTER.discoveryMax * (1 - pull * 0.35);
    if (this.since <= min) return 0;
    if (this.since >= max) return 1;
    return (this.since - min) / (max - min);
  }

  /**
   * Ask whether a creature may be placed, and how much threat is on offer.
   *
   * `random` is injected so the tests can drive the director deterministically.
   */
  requestSpawn(signals: EncounterSignals, random: () => number = Math.random): SpawnVerdict {
    const denied = (reason: SpawnRefusal): SpawnVerdict =>
      ({ allowed: false, reason, threat: 0, opens: false });

    if (signals.peaceful) return denied('peaceful');
    if (!signals.playing) return denied('not-playing');
    if (!signals.playerReady) return denied('player-down');
    if (signals.liveEnemies >= ENCOUNTER.maxWanderers) return denied('crowded');

    // A player who is nearly dead is not given a fresh fight to walk into.
    // Scenarios that deliberately corner the player opt out of this rule.
    if (!signals.scenarioDriven && signals.healthFraction < ENCOUNTER.lowHealthFraction) {
      return denied('low-health');
    }

    // Never place two creatures in the same instant: a pack arrives over a
    // second or so, which is also what gives the player time to read it.
    if (this.sinceSpawn < 0.4) return denied('too-soon');

    if (this.phase === 'recover') return denied('recovering');

    if (this.phase === 'explore') {
      // Two encounters must never overlap, and the residual heat of the last
      // one has to fade before a new one may open. Between them these are what
      // stop creatures from turning up the instant a fight ends.
      if (signals.engaged || signals.liveEnemies > 0) return denied('intensity');
      if (this.intensity > ENCOUNTER.intensityCeiling) return denied('intensity');
      const ready = this.readiness(signals);
      if (ready <= 0) return denied('too-soon');
      // Rising probability rather than a hard switch, so two runs through the
      // same clearing do not play out identically.
      if (random() > ready) return denied('too-soon');
      this.openEncounter();
      return { allowed: true, threat: this.take(this.budget), opens: true };
    }

    if (this.phase === 'buildup') {
      if (this.budget <= 0) return denied('budget-full');
      return { allowed: true, threat: this.take(this.budget), opens: false };
    }

    if (this.phase === 'active') {
      // The opening budget is spent first; only then do reinforcements start.
      if (this.budget > 0) return { allowed: true, threat: this.take(this.budget), opens: false };
      if (!this.reinforcementsOpen()) return denied('reinforcements-closed');
      if (this.reinforcement <= 0) return denied('budget-full');
      return { allowed: true, threat: this.takeReinforcement(), opens: false };
    }

    // 'peak' and 'resolve' never add anything: the fight is winding down.
    return denied('budget-full');
  }

  /** Commit threat the caller actually managed to place. */
  spend(threat: number, fromReinforcement = false): void {
    const amount = Math.max(0, threat);
    if (fromReinforcement) this.reinforcement = Math.max(0, this.reinforcement - amount);
    else this.budget = Math.max(0, this.budget - amount);
    this.sinceSpawn = 0;
  }

  /** Return threat that could not be placed, so the budget is not silently lost. */
  refund(threat: number, fromReinforcement = false): void {
    const amount = Math.max(0, threat);
    if (fromReinforcement) this.reinforcement += amount;
    else this.budget += amount;
  }

  /** How much of the remaining budget one placement may consume. */
  private take(pool: number): number {
    return Math.max(0, pool);
  }

  private takeReinforcement(): number {
    return Math.max(0, this.reinforcement);
  }

  private openEncounter(): void {
    const total = Math.min(ENCOUNTER.maxBudget, encounterBudget(this.depth) * this.budgetScale);
    this.budget = total;
    this.reinforcement = total * ENCOUNTER.reinforcementFraction;
    this.phase = 'buildup';
    this.buildup = ENCOUNTER.buildupSeconds;
    this.elapsed = 0;
    this.since = 0;
    this.count += 1;
  }

  /** Force an encounter open, e.g. because a scenario or a guardian demands it. */
  forceEncounter(): void {
    if (this.phase === 'explore' || this.phase === 'recover') this.openEncounter();
  }

  private closeEncounter(recoverySeconds: number): void {
    const wasFighting = this.phase !== 'explore' && this.phase !== 'recover';
    this.budget = 0;
    this.reinforcement = 0;
    this.elapsed = 0;
    this.resolveTimer = 0;
    if (wasFighting) {
      this.resolved = true;
      this.since = 0;
      this.recovery = recoverySeconds;
      this.phase = recoverySeconds > 0 ? 'recover' : 'explore';
    } else {
      this.phase = 'explore';
    }
  }

  /** Wipe the cycle, e.g. on a world transition or a new run. */
  reset(): void {
    this.phase = 'explore';
    this.budget = 0;
    this.reinforcement = 0;
    this.elapsed = 0;
    this.since = ENCOUNTER.discoveryMin;
    this.recovery = 0;
    this.buildup = 0;
    this.intensity = 0;
    this.resolved = false;
    this.sinceSpawn = 99;
    this.resolveTimer = 0;
  }

  /**
   * Grant a quiet spell without an encounter having happened.
   *
   * Used by world transitions, reward screens and story beats: whatever was
   * about to happen waits until the player is back in control.
   */
  hold(seconds: number): void {
    this.recovery = Math.max(this.recovery, seconds);
    if (this.phase === 'explore') this.phase = 'recover';
  }
}
