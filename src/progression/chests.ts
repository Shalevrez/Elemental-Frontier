/**
 * Chests: what they contain, how rare that is, and how it is explained.
 *
 * A chest never fails silently. Every roll produces an outcome - if the
 * permanent pool is exhausted the chest falls back to a timed blessing, and if
 * that is somehow unavailable it falls back to recovery, which is always
 * applicable. The caller gets exact numbers and an explicit permanence flag so
 * the UI can say precisely what the player just gained.
 *
 * Pure and injectable-random.
 */

import type { BuildState } from './BuildState';
import type { ElementId } from '../elements/affinity';
import {
  CHEST_ONLY_UPGRADES, RARITY_ORDER, describeUpgrade,
  type EffectLine, type Rarity, type UpgradeDef,
} from './upgrades';
import type { BuffDef } from './buffs';

export type ChestRarity = Rarity;

/**
 * Chest rarity weights.
 *
 * Legendary is deliberately scarce; depth and luck push the curve upward but
 * never make a legendary common.
 */
export const CHEST_RARITY_WEIGHTS: Readonly<Record<ChestRarity, number>> = Object.freeze({
  common: 100,
  uncommon: 58,
  rare: 27,
  epic: 9,
  legendary: 2.2,
});

export function chestRarityWeight(rarity: ChestRarity, depth: number, luck = 0): number {
  const base = CHEST_RARITY_WEIGHTS[rarity];
  const push = Math.max(0, depth) * 0.14 + Math.max(0, luck);
  switch (rarity) {
    case 'common': return Math.max(10, base * (1 - push * 0.3));
    case 'uncommon': return base * (1 + push * 0.06);
    case 'rare': return base * (1 + push * 0.28);
    case 'epic': return base * (1 + push * 0.5);
    default: return base * (1 + push * 0.7);
  }
}

/** Roll the rarity of a chest's contents. */
export function rollChestRarity(depth: number, luck = 0, random: () => number = Math.random): ChestRarity {
  let total = 0;
  const weights: number[] = [];
  for (const r of RARITY_ORDER) {
    const w = chestRarityWeight(r, depth, luck);
    weights.push(w);
    total += w;
  }
  let roll = clampUnit(random()) * total;
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return RARITY_ORDER[i]!;
  }
  return 'common';
}

// =====================================================================
//  Timed blessings
// =====================================================================

function buff(d: BuffDef): BuffDef {
  return Object.freeze(d);
}

export const CHEST_BUFFS: Readonly<Record<string, BuffDef>> = Object.freeze({
  'buff-shield': buff({
    id: 'buff-shield', name: 'Warding Shell', color: 0x53a8ff, seconds: 45,
    description: 'A shell absorbs the next hits you take.',
    grants: ['temp-shield'],
  }),
  'buff-resistance': buff({
    id: 'buff-resistance', name: 'Stone Skin', color: 0x9fb2c8, seconds: 60,
    description: 'Damage taken −25% while it lasts.',
    stats: { armor: 0.25 },
  }),
  'buff-swiftness': buff({
    id: 'buff-swiftness', name: 'Swiftness', color: 0xb8ecff, seconds: 60,
    description: 'Movement speed +25% while it lasts.',
    stats: { moveScale: 1.25 },
  }),
  'buff-attack-speed': buff({
    id: 'buff-attack-speed', name: 'Quickened', color: 0xffb03a, seconds: 45,
    description: 'Cooldowns −25% while it lasts.',
    stats: { cooldownScale: 0.75 },
  }),
  'buff-flow': buff({
    id: 'buff-flow', name: 'Flowing Mana', color: 0x63d38a, seconds: 60,
    description: 'Mana regeneration ×2 and ability costs −20% while it lasts.',
    stats: { regenScale: 2, costScale: 0.8 },
  }),
  'buff-focus': buff({
    id: 'buff-focus', name: 'Sharp Focus', color: 0xc07bff, seconds: 45,
    description: 'Critical chance +20% and critical damage +0.4× while it lasts.',
    stats: { critChance: 0.2, critScale: 0.4 },
  }),
  'buff-wrath': buff({
    id: 'buff-wrath', name: 'Wrath', color: 0xff9b3d, seconds: 30,
    description: 'All elemental damage +60% while it lasts.',
    stats: { damageScale: 1.6 },
  }),
  'buff-breath': buff({
    id: 'buff-breath', name: 'Deep Lungs', color: 0x4aa6ff, seconds: 180,
    description: 'Oxygen +25s and it drains 40% more slowly.',
    stats: { oxygenCapacity: 25, oxygenDrain: 0.6 },
  }),
});

/** Which blessings a chest of each rarity may contain. */
const BUFFS_BY_RARITY: Readonly<Record<ChestRarity, readonly string[]>> = Object.freeze({
  common: ['buff-breath'],
  uncommon: ['buff-swiftness', 'buff-resistance', 'buff-breath'],
  rare: ['buff-attack-speed', 'buff-flow', 'buff-shield'],
  epic: ['buff-focus', 'buff-shield', 'buff-flow'],
  legendary: ['buff-wrath', 'buff-focus'],
});

// =====================================================================
//  Outcomes
// =====================================================================

export type ChestOutcomeKind = 'upgrade' | 'blessing' | 'recovery';

export interface ChestInstant {
  /** Health restored, absolute points. */
  health?: number;
  /** Mana restored, absolute points. */
  mana?: number;
  /** Ultimate charge granted, 0..100. */
  ultimate?: number;
  /** Absorb shield granted. */
  shield?: number;
}

export interface ChestOutcome {
  kind: ChestOutcomeKind;
  rarity: ChestRarity;
  name: string;
  /** SVG symbol id for the chest reward card. */
  symbol: string;
  /** One precise sentence, never "become stronger". */
  summary: string;
  /** Exact numeric changes, split by tone. */
  benefits: EffectLine[];
  penalties: EffectLine[];
  /** How long the reward lasts. */
  permanence: 'save' | 'temporary';
  /** Seconds, for temporary rewards. */
  seconds: number;
  /** Element the reward is tied to, or 'any'. */
  element: ElementId | 'any';
  /** Set for `kind: 'upgrade'`. */
  upgradeId: string | null;
  /** Set for `kind: 'blessing'`. */
  buffId: string | null;
  /** Set for `kind: 'recovery'`. */
  instant: ChestInstant | null;
  /** Explicit warning for a reward with a downside. */
  warning: string | null;
}

export interface ChestContext {
  elements: readonly ElementId[];
  unlocked: ReadonlySet<string>;
  depth: number;
  luck?: number;
  /** Current vitals, so recovery outcomes can quote real numbers. */
  maxHealth: number;
  maxMana: number;
}

const RECOVERY_BY_RARITY: Readonly<Record<ChestRarity, { health: number; mana: number; ultimate: number; shield: number }>> =
  Object.freeze({
    common: { health: 0.25, mana: 0.35, ultimate: 0, shield: 0 },
    uncommon: { health: 0.4, mana: 0.5, ultimate: 10, shield: 0 },
    rare: { health: 0.6, mana: 0.7, ultimate: 20, shield: 0.15 },
    epic: { health: 0.85, mana: 1, ultimate: 35, shield: 0.25 },
    legendary: { health: 1, mana: 1, ultimate: 60, shield: 0.4 },
  });

/**
 * Roll what one chest contains.
 *
 * The order of preference is: a permanent upgrade of the rolled rarity, then a
 * timed blessing, then recovery. Every branch returns a fully described
 * outcome, so a chest can never open into nothing.
 */
export function rollChestOutcome(
  build: BuildState,
  ctx: ChestContext,
  random: () => number = Math.random,
  forcedRarity?: ChestRarity,
): ChestOutcome {
  const rarity = forcedRarity ?? rollChestRarity(ctx.depth, ctx.luck ?? 0, random);

  // ---- 1. permanent upgrade of exactly this rarity
  const pool = CHEST_ONLY_UPGRADES.filter(
    (def) => def.rarity === rarity && build.canOffer(def, ctx.elements, ctx.unlocked),
  );
  if (pool.length > 0) {
    const def = pool[Math.min(pool.length - 1, Math.floor(clampUnit(random()) * pool.length))]!;
    return upgradeOutcome(def, rarity);
  }

  // ---- 2. a timed blessing
  const buffIds = (BUFFS_BY_RARITY[rarity] ?? []).filter((id) => CHEST_BUFFS[id]);
  if (buffIds.length > 0) {
    const id = buffIds[Math.min(buffIds.length - 1, Math.floor(clampUnit(random()) * buffIds.length))]!;
    return blessingOutcome(CHEST_BUFFS[id]!, rarity);
  }

  // ---- 3. recovery, which always applies
  return recoveryOutcome(rarity, ctx);
}

function upgradeOutcome(def: UpgradeDef, rarity: ChestRarity): ChestOutcome {
  const { benefits, penalties } = describeUpgrade(def, 1);
  return {
    kind: 'upgrade',
    rarity,
    name: def.name,
    symbol: symbolFor(def.element),
    summary: def.description,
    benefits,
    penalties,
    permanence: 'save',
    seconds: 0,
    element: def.element,
    upgradeId: def.id,
    buffId: null,
    instant: null,
    warning: def.warning ?? (penalties.length > 0 ? 'This reward has a real cost.' : null),
  };
}

function blessingOutcome(def: BuffDef, rarity: ChestRarity): ChestOutcome {
  const benefits: EffectLine[] = [];
  const penalties: EffectLine[] = [];
  const { benefits: b, penalties: p } = describeUpgrade(
    {
      id: def.id, name: def.name, description: def.description, rarity,
      element: 'any', tags: [], maxStacks: 1, stats: def.stats,
    },
    1,
  );
  benefits.push(...b);
  penalties.push(...p);
  if (def.grants?.includes('temp-shield')) {
    benefits.push({ text: 'Absorb shield equal to 30% of maximum health', tone: 'good' });
  }
  benefits.push({ text: `Lasts ${Math.round(def.seconds)}s`, tone: 'neutral' });
  return {
    kind: 'blessing',
    rarity,
    name: def.name,
    symbol: '#sym-vitality',
    summary: def.description,
    benefits,
    penalties,
    permanence: 'temporary',
    seconds: def.seconds,
    element: 'any',
    upgradeId: null,
    buffId: def.id,
    instant: null,
    warning: null,
  };
}

function recoveryOutcome(rarity: ChestRarity, ctx: ChestContext): ChestOutcome {
  const table = RECOVERY_BY_RARITY[rarity];
  const health = Math.round(ctx.maxHealth * table.health);
  const mana = Math.round(ctx.maxMana * table.mana);
  const shield = Math.round(ctx.maxHealth * table.shield);
  const benefits: EffectLine[] = [];
  if (health > 0) benefits.push({ text: `Restores ${health} health`, tone: 'good' });
  if (mana > 0) benefits.push({ text: `Restores ${mana} Mana`, tone: 'good' });
  if (shield > 0) benefits.push({ text: `Grants a ${shield} point shield`, tone: 'good' });
  if (table.ultimate > 0) benefits.push({ text: `Ultimate charge +${table.ultimate}`, tone: 'good' });

  return {
    kind: 'recovery',
    rarity,
    name: rarity === 'legendary' ? 'Heart of the World' : 'Restorative Cache',
    symbol: '#sym-flask',
    summary: `Immediate recovery: ${health} health and ${mana} Mana.`,
    benefits,
    penalties: [],
    permanence: 'temporary',
    seconds: 0,
    element: 'any',
    upgradeId: null,
    buffId: null,
    instant: {
      health,
      mana,
      ultimate: table.ultimate,
      shield,
    },
    warning: null,
  };
}

function symbolFor(element: ElementId | 'any'): string {
  switch (element) {
    case 'fire': return '#sym-fire';
    case 'water': return '#sym-water';
    case 'earth': return '#sym-earth';
    case 'air': return '#sym-air';
    default: return '#sym-vitality';
  }
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(0.9999999, Math.max(0, v));
}

/** Human label for a chest rarity, used on the world model and the card. */
export function chestRarityLabel(rarity: ChestRarity): string {
  return rarity[0]!.toUpperCase() + rarity.slice(1);
}

/**
 * Deterministic chest rarity from a world position.
 *
 * Chest placement is generated from the seed, so the rarity has to be stable
 * too: a chest must look the same every time the world is loaded.
 */
export function chestRarityFromRoll(roll: number): ChestRarity {
  const r = clampUnit(roll);
  if (r < 0.03) return 'legendary';
  if (r < 0.12) return 'epic';
  if (r < 0.32) return 'rare';
  if (r < 0.62) return 'uncommon';
  return 'common';
}
