/**
 * Reward cadence: deciding *when* a selection card is worth showing.
 *
 * The old rule was a single line in the game loop: offer three cards whenever
 * an elite or a boss died. That has two failure modes at once. A player who
 * meets no elites can clear a dozen encounters and be offered nothing, and a
 * player who meets several in a row is handed a build-defining choice every
 * ninety seconds, which is how a choice stops feeling like one.
 *
 * This module replaces that with an accomplishment ledger. Things the player
 * *achieves* pay credit - clearing a real encounter, killing an elite,
 * finishing an objective, finding somewhere hidden, putting down a guardian -
 * and a card is offered when the credit is worth a decision. A minimum gap
 * stops a run of quick wins from producing a run of screens, and a maximum gap
 * stops a slow, careful player from going unrewarded.
 *
 * Pure state and arithmetic, so the whole cadence is testable without a game.
 */

/** Something the player did that a reward could reasonably follow. */
export type Accomplishment =
  | 'encounter'    // a real encounter fought and resolved
  | 'elite'        // an elite creature defeated
  | 'guardian'     // a shrine guardian defeated
  | 'boss'         // a world boss defeated
  | 'objective'    // a shrine cleansed, a scenario completed
  | 'discovery';   // a hidden area or a rare chest found

/**
 * Credit each accomplishment pays toward the next selection card.
 *
 * The threshold is 3, so: one guardian is a card on its own, an elite plus a
 * cleared encounter is a card, and three ordinary encounters are a card. A
 * single small skirmish never is.
 */
export const CREDIT: Readonly<Record<Accomplishment, number>> = Object.freeze({
  encounter: 1,
  elite: 2,
  guardian: 4,
  boss: 6,
  objective: 2,
  discovery: 1,
});

/** Extra rarity push an accomplishment adds to the offer it produces. */
export const LUCK: Readonly<Record<Accomplishment, number>> = Object.freeze({
  encounter: 0,
  elite: 1.4,
  guardian: 2,
  boss: 2.2,
  objective: 0.8,
  discovery: 0.5,
});

export const CADENCE = Object.freeze({
  /** Credit needed before a card is offered. */
  threshold: 3,
  /** Seconds that must pass between two selection screens. */
  minGap: 75,
  /**
   * Seconds after which any accumulated credit is enough.
   *
   * This is the "every 2-5 minutes" guarantee: a player who is making progress
   * but not meeting elites still gets a decision inside the window.
   */
  maxGap: 300,
  /**
   * Credit needed once the maximum gap has elapsed. Deliberately low but not
   * zero - a player who has genuinely done nothing is not handed a reward for
   * standing still.
   */
  lateThreshold: 1,
  /**
   * Early-game grace: the first few cards come sooner, so a build direction
   * can be established inside the first world.
   */
  openingOffers: 3,
  openingThreshold: 2,
  openingMinGap: 45,
});

export interface CadenceState {
  /** Accomplishment credit banked toward the next card. */
  credit: number;
  /** Seconds since the last selection screen closed. */
  since: number;
  /** Selection screens shown so far this save. */
  offers: number;
  /** Rarity push accumulated from what earned the pending card. */
  luck: number;
  /** The richest accomplishment banked since the last card. */
  best: Accomplishment | null;
}

export function createCadenceState(offers = 0): CadenceState {
  return { credit: 0, since: CADENCE.minGap, offers: Math.max(0, Math.floor(offers)), luck: 0, best: null };
}

/** Credit threshold and minimum gap in force right now. */
export function currentGates(state: CadenceState): { threshold: number; minGap: number } {
  const opening = state.offers < CADENCE.openingOffers;
  return {
    threshold: opening ? CADENCE.openingThreshold : CADENCE.threshold,
    minGap: opening ? CADENCE.openingMinGap : CADENCE.minGap,
  };
}

export function tickCadence(state: CadenceState, dt: number): void {
  state.since += Math.max(0, dt);
}

/** Bank an accomplishment. Returns the credit it was worth. */
export function recordAccomplishment(state: CadenceState, what: Accomplishment): number {
  const credit = CREDIT[what] ?? 0;
  state.credit += credit;
  state.luck = Math.max(state.luck, LUCK[what] ?? 0);
  if (state.best === null || (LUCK[what] ?? 0) > (LUCK[state.best] ?? 0)) state.best = what;
  return credit;
}

/**
 * Should a selection card be offered now?
 *
 * A boss or a guardian is always worth stopping for; everything else has to
 * clear both the credit threshold and the minimum gap, or wait out the maximum
 * gap. The player being in a fight is the caller's business, not this
 * module's - it only answers "has enough been achieved".
 */
export function shouldOffer(state: CadenceState): boolean {
  if (state.credit <= 0) return false;
  // A defeated guardian or world boss earns its screen immediately: these are
  // the punctuation marks of the campaign, not routine progress.
  if (state.best === 'guardian' || state.best === 'boss') return true;
  const { threshold, minGap } = currentGates(state);
  if (state.since >= CADENCE.maxGap && state.credit >= CADENCE.lateThreshold) return true;
  return state.credit >= threshold && state.since >= minGap;
}

/** The rarity push the pending offer has earned. */
export function offerLuck(state: CadenceState): number {
  return state.luck;
}

/** Consume the banked credit once a card has actually been shown. */
export function consumeOffer(state: CadenceState): void {
  state.credit = 0;
  state.since = 0;
  state.luck = 0;
  state.best = null;
  state.offers += 1;
}

/**
 * Expected minutes between selection screens for a given rate of play.
 *
 * Used by the balance tests to check the 2-5 minute target holds for both a
 * fast player clearing encounters back to back and a careful one exploring
 * between them. `encounterSeconds` is how long one encounter cycle takes,
 * including the exploration and recovery either side of it.
 */
export function expectedOfferMinutes(encounterSeconds: number, eliteChance = 0): number {
  const state = createCadenceState(CADENCE.openingOffers);
  let elapsed = 0;
  let guard = 0;
  while (guard++ < 10_000) {
    // One encounter cycle passes.
    tickCadence(state, encounterSeconds);
    elapsed += encounterSeconds;
    recordAccomplishment(state, 'encounter');
    // Elites arrive as a fraction of encounters rather than as whole ones.
    if (eliteChance > 0 && guard % Math.max(1, Math.round(1 / eliteChance)) === 0) {
      recordAccomplishment(state, 'elite');
    }
    if (shouldOffer(state)) return elapsed / 60;
  }
  return Infinity;
}
