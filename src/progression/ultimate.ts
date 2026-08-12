/**
 * The Ultimate charge meter.
 *
 * Ultimates deliberately do *not* run on ordinary Mana. They are earned by
 * fighting: dealing damage, applying elemental status, finishing creatures,
 * chaining hits, shattering frozen targets, deflecting shots, using terrain
 * against something, and - within a strict cap - by surviving damage.
 *
 * Hitting scenery grants nothing, so there is no way to farm a meter by
 * punching a rock.
 *
 * Pure state, so charge rates and the anti-spam rules are testable.
 */

export const ULTIMATE_MAX = 100;
/** Minimum seconds between two activations, even with a refilled meter. */
export const ULTIMATE_LOCKOUT = 8;
/** Ceiling on how much of a full meter passive damage-taken can contribute. */
export const DAMAGE_TAKEN_CAP = 25;
/** Ceiling on how much of a fill terrain interactions may contribute. */
export const TERRAIN_CAP = 18;
/** Ceiling on how much of a fill deflecting projectiles may contribute. */
export const DEFLECT_CAP = 20;

/**
 * Rolling ceiling on charge gained per second.
 *
 * A sustained Ultimate field ticks every half second against every creature it
 * covers, and each of those ticks used to feed the meter. Twelve ticks across
 * five creatures returned most of a fresh Ultimate, which is how an Ultimate
 * ends up charging the next one. Every multi-hit source is now metered through
 * the same window, so no ability can outrun the pacing target regardless of
 * how many times it hits.
 */
export const CHARGE_RATE_CAP = 22;
export const CHARGE_RATE_WINDOW = 1;

/**
 * Charge multiplier while the player's own Ultimate is running.
 *
 * Zero: an Ultimate is the payoff for the encounters that charged it, not an
 * engine for the next one.
 */
export const ULTIMATE_ACTIVE_SCALE = 0;

export type ChargeSource =
  | 'damage-dealt'
  | 'status-applied'
  | 'enemy-defeated'
  | 'combo'
  | 'damage-taken'
  | 'deflect'
  | 'shatter'
  | 'terrain';

/** Charge per event (or, for damage, per 100 points dealt). */
export const CHARGE_RATES: Readonly<Record<ChargeSource, number>> = Object.freeze({
  'damage-dealt': 13,
  'status-applied': 1.4,
  'enemy-defeated': 6,
  combo: 2.2,
  'damage-taken': 5,
  deflect: 3,
  shatter: 5,
  terrain: 2.5,
});

export interface UltimateState {
  charge: number;
  /** How much of the meter has come from taking damage this fill. */
  fromDamageTaken: number;
  /** How much has come from terrain interactions this fill. */
  fromTerrain: number;
  /** How much has come from deflecting projectiles this fill. */
  fromDeflect: number;
  /** Charge granted inside the current rate-limit window. */
  windowGain: number;
  windowLeft: number;
  /** True while one of the player's own Ultimate fields is running. */
  ultimateActive: boolean;
  /** Seconds until another Ultimate may be activated. */
  lockout: number;
  /** Hits inside the combo window. */
  comboCount: number;
  comboTimer: number;
  /** Set for one frame when the meter first becomes full. */
  justReady: boolean;
  /** True once the element's Ultimate has been unlocked. */
  unlocked: boolean;
}

export const COMBO_WINDOW = 2.4;
/** Hits needed inside the window before combo charge starts paying out. */
export const COMBO_THRESHOLD = 3;

export function createUltimateState(unlocked = false): UltimateState {
  return {
    charge: 0,
    fromDamageTaken: 0,
    fromTerrain: 0,
    fromDeflect: 0,
    windowGain: 0,
    windowLeft: 0,
    ultimateActive: false,
    lockout: 0,
    comboCount: 0,
    comboTimer: 0,
    justReady: false,
    unlocked,
  };
}

export function tickUltimate(state: UltimateState, dt: number): void {
  state.justReady = false;
  if (state.lockout > 0) state.lockout = Math.max(0, state.lockout - dt);
  if (state.comboTimer > 0) {
    state.comboTimer -= dt;
    if (state.comboTimer <= 0) state.comboCount = 0;
  }
  if (state.windowLeft > 0) {
    state.windowLeft = Math.max(0, state.windowLeft - dt);
    if (state.windowLeft === 0) state.windowGain = 0;
  }
}

/** Tell the meter whether one of the player's Ultimate fields is running. */
export function setUltimateActive(state: UltimateState, active: boolean): void {
  state.ultimateActive = active;
}

/**
 * Add charge from a gameplay event.
 *
 * `magnitude` scales damage-based sources (points of damage); every other
 * source ignores it. Returns how much charge was actually granted.
 */
export function addCharge(
  state: UltimateState,
  source: ChargeSource,
  magnitude = 1,
  scale = 1,
): number {
  if (!state.unlocked) return 0;
  if (state.charge >= ULTIMATE_MAX) return 0;
  // An Ultimate never pays for the next one.
  if (state.ultimateActive) scale *= ULTIMATE_ACTIVE_SCALE;

  let amount: number;
  if (source === 'damage-dealt') {
    amount = CHARGE_RATES['damage-dealt'] * (Math.max(0, magnitude) / 100);
  } else if (source === 'damage-taken') {
    const room = Math.max(0, DAMAGE_TAKEN_CAP - state.fromDamageTaken);
    amount = Math.min(room, CHARGE_RATES['damage-taken'] * Math.max(0, magnitude) / 30);
  } else if (source === 'terrain') {
    amount = Math.min(Math.max(0, TERRAIN_CAP - state.fromTerrain), CHARGE_RATES.terrain);
  } else if (source === 'deflect') {
    amount = Math.min(Math.max(0, DEFLECT_CAP - state.fromDeflect), CHARGE_RATES.deflect);
  } else if (source === 'combo') {
    if (state.comboCount < COMBO_THRESHOLD) return 0;
    amount = CHARGE_RATES.combo;
  } else {
    amount = CHARGE_RATES[source];
  }

  amount *= Math.max(0, scale);
  if (amount <= 0) return 0;

  // Rolling per-second ceiling. This is what rate-limits multi-hit abilities:
  // whatever a single frame's worth of hits is worth on paper, the meter only
  // ever accepts a fixed amount of it per second.
  if (state.windowLeft <= 0) {
    state.windowLeft = CHARGE_RATE_WINDOW;
    state.windowGain = 0;
  }
  amount = Math.min(amount, Math.max(0, CHARGE_RATE_CAP - state.windowGain));
  if (amount <= 0) return 0;

  const before = state.charge;
  state.charge = Math.min(ULTIMATE_MAX, state.charge + amount);
  const gained = state.charge - before;
  state.windowGain += gained;
  if (source === 'damage-taken') state.fromDamageTaken += gained;
  if (source === 'terrain') state.fromTerrain += gained;
  if (source === 'deflect') state.fromDeflect += gained;
  if (before < ULTIMATE_MAX && state.charge >= ULTIMATE_MAX) state.justReady = true;
  return gained;
}

/** Register a hit for the combo counter. */
export function registerComboHit(state: UltimateState): void {
  state.comboCount++;
  state.comboTimer = COMBO_WINDOW;
}

export function isUltimateReady(state: UltimateState): boolean {
  return state.unlocked && state.charge >= ULTIMATE_MAX && state.lockout <= 0;
}

export type UltimateDenial = 'locked' | 'charging' | 'cooldown';

/** Why the Ultimate cannot fire right now, or null when it can. */
export function ultimateDenial(state: UltimateState): UltimateDenial | null {
  if (!state.unlocked) return 'locked';
  if (state.charge < ULTIMATE_MAX) return 'charging';
  if (state.lockout > 0) return 'cooldown';
  return null;
}

/** Spend the whole meter. Returns false when it was not ready. */
export function consumeUltimate(state: UltimateState): boolean {
  if (!isUltimateReady(state)) return false;
  state.charge = 0;
  state.fromDamageTaken = 0;
  state.fromTerrain = 0;
  state.fromDeflect = 0;
  state.windowGain = 0;
  state.windowLeft = 0;
  state.lockout = ULTIMATE_LOCKOUT;
  state.comboCount = 0;
  return true;
}

/** 0..1 for the HUD ring. */
export function ultimateFraction(state: UltimateState): number {
  return Math.max(0, Math.min(1, state.charge / ULTIMATE_MAX));
}

export function sanitiseCharge(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(ULTIMATE_MAX, Math.max(0, n));
}
