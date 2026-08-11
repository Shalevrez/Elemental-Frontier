/**
 * Status effects and the elemental reactions between them.
 *
 * Pure logic - no engine imports - so every interaction rule is unit-testable.
 * The renderer reads `StatusSet` to decide tints, particles and icons; the
 * combat code reads it to decide damage, movement and control.
 */

export type StatusId =
  | 'burning' | 'wet' | 'frozen' | 'stunned' | 'weakened' | 'armored' | 'corrupted' | 'steamed'
  | 'slowed';

export interface StatusDef {
  readonly id: StatusId;
  readonly name: string;
  /** Short line shown in the HUD legend. */
  readonly blurb: string;
  readonly color: number;
  readonly maxStacks: number;
  /** Default duration in seconds. */
  readonly duration: number;
  /** True when it prevents the victim from acting. */
  readonly disabling: boolean;
  /** Multiplier applied to the victim's movement speed. */
  readonly moveScale: number;
  /** Multiplier applied to damage the victim takes. */
  readonly damageTakenScale: number;
}

function def(d: StatusDef): StatusDef {
  return Object.freeze(d);
}

export const STATUSES: Readonly<Record<StatusId, StatusDef>> = Object.freeze({
  burning: def({
    id: 'burning', name: 'Burning', blurb: 'Takes fire damage over time.',
    color: 0xff8a2a, maxStacks: 5, duration: 4, disabling: false,
    moveScale: 1, damageTakenScale: 1,
  }),
  wet: def({
    id: 'wet', name: 'Wet', blurb: 'Freezes faster, burns slower, conducts.',
    color: 0x4aa6ff, maxStacks: 1, duration: 8, disabling: false,
    moveScale: 0.92, damageTakenScale: 1,
  }),
  frozen: def({
    id: 'frozen', name: 'Frozen', blurb: 'Held in place and brittle.',
    color: 0xbfe8ff, maxStacks: 1, duration: 2.4, disabling: true,
    moveScale: 0, damageTakenScale: 1.25,
  }),
  stunned: def({
    id: 'stunned', name: 'Stunned', blurb: 'Cannot act.',
    color: 0xffe08a, maxStacks: 1, duration: 1.6, disabling: true,
    moveScale: 0, damageTakenScale: 1.1,
  }),
  weakened: def({
    id: 'weakened', name: 'Weakened', blurb: 'Deals less damage.',
    color: 0xb08bd6, maxStacks: 3, duration: 6, disabling: false,
    moveScale: 1, damageTakenScale: 1.08,
  }),
  armored: def({
    id: 'armored', name: 'Armored', blurb: 'Takes reduced damage.',
    color: 0x9aa6bb, maxStacks: 1, duration: 6, disabling: false,
    moveScale: 0.94, damageTakenScale: 0.6,
  }),
  corrupted: def({
    id: 'corrupted', name: 'Corrupted', blurb: 'Blight eats away at it.',
    color: 0xb96bff, maxStacks: 3, duration: 6, disabling: false,
    moveScale: 1, damageTakenScale: 1.12,
  }),
  /**
   * Purely informational.
   *
   * The actual slow lives in the creature's own `slowFactor`, so this entry
   * carries `moveScale: 1` deliberately - it exists to give the effect a name,
   * a colour and an icon rather than to apply the slow twice.
   */
  slowed: def({
    id: 'slowed', name: 'Slowed', blurb: 'Moving well below its usual pace.',
    color: 0x7fd4ff, maxStacks: 1, duration: 2.6, disabling: false,
    moveScale: 1, damageTakenScale: 1,
  }),
  steamed: def({
    id: 'steamed', name: 'Steamed', blurb: 'Blinded by scalding vapour.',
    color: 0xd8e8f0, maxStacks: 1, duration: 3, disabling: false,
    moveScale: 0.85, damageTakenScale: 1.05,
  }),
});

export const STATUS_ORDER: readonly StatusId[] = Object.freeze([
  'burning', 'wet', 'frozen', 'slowed', 'stunned', 'weakened', 'armored', 'corrupted', 'steamed',
]);

export function isStatusId(value: unknown): value is StatusId {
  return typeof value === 'string' && (STATUS_ORDER as readonly string[]).includes(value);
}

export interface StatusInstance {
  id: StatusId;
  remaining: number;
  stacks: number;
  /** Effect strength - damage per second for burning, etc. */
  magnitude: number;
}

/**
 * A bag of active statuses on one creature (or the player).
 *
 * Deliberately a plain object with an array so it can be created cheaply and
 * cleared without allocation churn in the frame loop.
 */
export class StatusSet {
  readonly active: StatusInstance[] = [];

  has(id: StatusId): boolean {
    for (const s of this.active) if (s.id === id) return true;
    return false;
  }

  get(id: StatusId): StatusInstance | null {
    for (const s of this.active) if (s.id === id) return s;
    return null;
  }

  stacks(id: StatusId): number {
    const s = this.get(id);
    return s ? s.stacks : 0;
  }

  /** True when anything currently prevents the victim from acting. */
  get disabled(): boolean {
    for (const s of this.active) if (STATUSES[s.id].disabling) return true;
    return false;
  }

  /** Combined movement multiplier from every active status. */
  get moveScale(): number {
    let scale = 1;
    for (const s of this.active) scale *= STATUSES[s.id].moveScale;
    return scale;
  }

  /** Combined incoming-damage multiplier. */
  get damageTakenScale(): number {
    let scale = 1;
    for (const s of this.active) {
      const d = STATUSES[s.id];
      // Stacking statuses scale their contribution with stack count.
      const per = d.damageTakenScale - 1;
      scale *= 1 + per * (d.maxStacks > 1 ? s.stacks : 1);
    }
    return Math.max(0.15, scale);
  }

  /** Damage-per-second currently being applied by damage-over-time statuses. */
  get damageOverTime(): number {
    let dps = 0;
    for (const s of this.active) {
      if (s.id === 'burning') dps += s.magnitude * s.stacks;
      else if (s.id === 'corrupted') dps += s.magnitude * s.stacks * 0.5;
    }
    return dps;
  }

  clear(): void {
    this.active.length = 0;
  }

  remove(id: StatusId): boolean {
    const i = this.active.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.active.splice(i, 1);
    return true;
  }

  /**
   * Apply (or refresh) a status.
   *
   * Duration refreshes to the longer of the two; stacks accumulate up to the
   * definition's ceiling; magnitude takes the stronger value.
   */
  apply(id: StatusId, seconds?: number, magnitude = 0, stacks = 1): StatusInstance {
    const d = STATUSES[id];
    const duration = seconds ?? d.duration;
    const existing = this.get(id);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, duration);
      existing.stacks = Math.min(d.maxStacks, existing.stacks + stacks);
      existing.magnitude = Math.max(existing.magnitude, magnitude);
      return existing;
    }
    const instance: StatusInstance = {
      id,
      remaining: duration,
      stacks: Math.min(d.maxStacks, Math.max(1, stacks)),
      magnitude,
    };
    this.active.push(instance);
    return instance;
  }

  /** Advance every status. Returns the ids that expired this tick. */
  tick(dt: number, expired: StatusId[]): StatusId[] {
    expired.length = 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i]!;
      s.remaining -= dt;
      if (s.remaining <= 0) {
        expired.push(s.id);
        this.active.splice(i, 1);
      }
    }
    return expired;
  }
}

// ------------------------------------------------------------- reactions

export type ReactionId =
  | 'steam' | 'melt' | 'extinguish' | 'flash-freeze' | 'shatter' | 'spread-fire' | 'conduct';

export interface Reaction {
  id: ReactionId;
  /** Human-readable line for the combat log / toast. */
  label: string;
  /** Extra damage dealt immediately as a multiple of the triggering hit. */
  bonusDamage: number;
  /** Statuses removed by the reaction. */
  removes: StatusId[];
  /** Statuses added by the reaction. */
  adds: { id: StatusId; seconds?: number; magnitude?: number }[];
  /** True when the reaction should also damage things around the victim. */
  areaBurst: boolean;
}

export type ReactionElement = 'fire' | 'water' | 'earth' | 'air';

/**
 * Work out what happens when an element strikes a target that already carries
 * statuses.
 *
 * Only one reaction fires per hit, chosen by priority, which keeps combat
 * readable: the player sees a single clear consequence rather than five
 * overlapping ones.
 */
export function resolveReaction(element: ReactionElement, target: StatusSet): Reaction | null {
  const burning = target.has('burning');
  const wet = target.has('wet');
  const frozen = target.has('frozen');

  if (element === 'fire') {
    if (frozen) {
      return {
        id: 'melt', label: 'Melt', bonusDamage: 0.35,
        removes: ['frozen'], adds: [{ id: 'wet' }, { id: 'steamed' }], areaBurst: false,
      };
    }
    if (wet) {
      return {
        id: 'steam', label: 'Steam', bonusDamage: 0.25,
        removes: ['wet'], adds: [{ id: 'steamed' }], areaBurst: true,
      };
    }
    return null;
  }

  if (element === 'water') {
    if (burning) {
      return {
        id: 'extinguish', label: 'Extinguish', bonusDamage: 0.2,
        removes: ['burning'], adds: [{ id: 'wet' }, { id: 'steamed' }], areaBurst: false,
      };
    }
    if (wet && !frozen) {
      // Water on an already-soaked target locks it down fast.
      return {
        id: 'flash-freeze', label: 'Flash Freeze', bonusDamage: 0.15,
        removes: [], adds: [{ id: 'frozen', seconds: STATUSES.frozen.duration * 1.6 }], areaBurst: false,
      };
    }
    return null;
  }

  if (element === 'earth') {
    if (frozen) {
      return {
        id: 'shatter', label: 'Shatter', bonusDamage: 1.1,
        removes: ['frozen'], adds: [{ id: 'weakened' }], areaBurst: true,
      };
    }
    return null;
  }

  // air
  if (burning) {
    return {
      id: 'spread-fire', label: 'Firestorm', bonusDamage: 0.2,
      removes: [], adds: [{ id: 'burning', magnitude: 0 }], areaBurst: true,
    };
  }
  if (wet) {
    return {
      id: 'conduct', label: 'Chill Blast', bonusDamage: 0.3,
      removes: [], adds: [{ id: 'weakened' }], areaBurst: false,
    };
  }
  return null;
}

/**
 * Duration multiplier when applying a status to a target that is already
 * carrying a related one - wet things freeze faster, wet things burn slower.
 */
export function durationModifier(id: StatusId, target: StatusSet): number {
  if (id === 'frozen' && target.has('wet')) return 1.6;
  if (id === 'burning' && target.has('wet')) return 0.45;
  if (id === 'burning' && target.has('frozen')) return 0.3;
  return 1;
}
