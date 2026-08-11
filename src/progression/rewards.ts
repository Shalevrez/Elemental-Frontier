/**
 * Reward rolling: choosing the three upgrades offered after an encounter.
 *
 * Pure and injectable-random so the draw rules can be tested exactly.
 */

import type { ElementId } from '../elements/affinity';
import type { BuildState } from './BuildState';
import {
  BASE_MODIFIERS, RARITY_WEIGHTS, REWARD_UPGRADES, accumulateStats, clampStats, describeUpgrade,
  type EffectLine, type Rarity, type StatModifiers, type UpgradeDef,
} from './upgrades';

export interface RewardContext {
  /** Elements the player may receive upgrades for. */
  elements: readonly ElementId[];
  /** Meta unlocks the player has purchased. */
  unlocked: ReadonlySet<string>;
  /** 0 at the start of a run, rising as it goes; biases toward rarity. */
  depth: number;
  /** Extra rarity push for elite/boss rewards. */
  luck?: number;
}

export interface RewardOffer {
  def: UpgradeDef;
  /** Stacks already owned, shown as "2/3" in the UI. */
  owned: number;
  /** True when taking it completes a synergy already in the build. */
  synergyHit: string | null;
}

/** How strongly higher rarities are favoured as a run progresses. */
export function rarityWeightAt(rarity: Rarity, depth: number, luck = 0): number {
  const base = RARITY_WEIGHTS[rarity];
  const push = Math.max(0, depth) * 0.16 + luck;
  switch (rarity) {
    case 'common': return Math.max(12, base * (1 - push * 0.32));
    case 'uncommon': return base * (1 + push * 0.05);
    case 'rare': return base * (1 + push * 0.3);
    case 'epic': return base * (1 + push * 0.55);
    default: return base * (1 + push * 0.8);
  }
}

/** Every upgrade that could legally be offered right now. */
export function eligibleUpgrades(build: BuildState, ctx: RewardContext): UpgradeDef[] {
  return REWARD_UPGRADES.filter((def) => build.canOffer(def, ctx.elements, ctx.unlocked));
}

/**
 * Draw `count` distinct offers.
 *
 * Picks are weighted by rarity, never duplicated inside one screen, and always
 * legal for the current build. If the pool runs dry the result is simply
 * shorter rather than padded with illegal choices.
 */
export function rollRewards(
  build: BuildState,
  ctx: RewardContext,
  random: () => number = Math.random,
  count = 3,
): RewardOffer[] {
  const pool = eligibleUpgrades(build, ctx);
  const offers: RewardOffer[] = [];
  const taken = new Set<string>();
  const synergyTags = new Set(build.synergies().map((s) => s.tag));
  const ownedSynergy = new Set<string>();
  for (const entry of build.list()) {
    for (const tag of entry.def.synergy ?? []) ownedSynergy.add(tag);
  }

  for (let n = 0; n < count; n++) {
    const candidates = pool.filter((d) => !taken.has(d.id));
    if (candidates.length === 0) break;

    let total = 0;
    const weights: number[] = [];
    for (const def of candidates) {
      let w = rarityWeightAt(def.rarity, ctx.depth, ctx.luck ?? 0);
      // Gently favour upgrades that build on what the player already has.
      if (def.synergy?.some((t) => ownedSynergy.has(t))) w *= 1.5;
      if (def.element !== 'any') w *= 1.25;
      weights.push(w);
      total += w;
    }

    let roll = clampUnit(random()) * total;
    let chosen = candidates[candidates.length - 1]!;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) { chosen = candidates[i]!; break; }
    }

    taken.add(chosen.id);
    const synergyHit = chosen.synergy?.find((t) => ownedSynergy.has(t) || synergyTags.has(t)) ?? null;
    offers.push({ def: chosen, owned: build.stacksOf(chosen.id), synergyHit });
  }

  return offers;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(0.9999999, Math.max(0, v));
}

/** Short human label for the reward card, e.g. "Rare · Fire · burning". */
export function offerSubtitle(offer: RewardOffer): string {
  const parts: string[] = [capitalise(offer.def.rarity)];
  parts.push(offer.def.element === 'any' ? 'Any element' : capitalise(offer.def.element));
  if (offer.def.tags.length > 0) parts.push(offer.def.tags.slice(0, 2).join(' · '));
  return parts.join(' · ');
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// =====================================================================
//  Card presentation data
// =====================================================================

/** One row of the "how will my stats change" preview. */
export interface StatDelta {
  label: string;
  before: string;
  after: string;
  /** True when the change helps the player. */
  better: boolean;
}

export interface OfferPreview {
  benefits: EffectLine[];
  penalties: EffectLine[];
  /** Exact before/after for the stats this card actually moves. */
  deltas: StatDelta[];
  /** How long the effect lasts. */
  permanence: 'save' | 'world' | 'temporary';
  /** Explicit warning text for a card with a major downside. */
  warning: string | null;
}

/** Stats worth showing in the confirmation preview, with how to format them. */
const PREVIEW_ROWS: { key: keyof StatModifiers; label: string; format: (v: number) => string; better: 'up' | 'down' }[] = [
  { key: 'damageScale', label: 'Damage', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'maxHealth', label: 'Bonus health', format: (v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`, better: 'up' },
  { key: 'maxHealthScale', label: 'Health scale', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'maxEnergy', label: 'Bonus Mana', format: (v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`, better: 'up' },
  { key: 'maxEnergyScale', label: 'Mana scale', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'energyRegen', label: 'Mana regen', format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}/s`, better: 'up' },
  { key: 'regenScale', label: 'Regen scale', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'cooldownScale', label: 'Cooldowns', format: (v) => `×${v.toFixed(2)}`, better: 'down' },
  { key: 'costScale', label: 'Mana costs', format: (v) => `×${v.toFixed(2)}`, better: 'down' },
  { key: 'moveScale', label: 'Move speed', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'critChance', label: 'Crit chance', format: (v) => `${Math.round(v * 100)}%`, better: 'up' },
  { key: 'critScale', label: 'Crit damage', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'armor', label: 'Damage taken', format: (v) => `−${Math.round(v * 100)}%`, better: 'up' },
  { key: 'areaScale', label: 'Area size', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'rangeScale', label: 'Range', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'ultimateDamage', label: 'Ultimate damage', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
  { key: 'ultimateGain', label: 'Ultimate charge', format: (v) => `×${v.toFixed(2)}`, better: 'up' },
];

/**
 * Everything a selection card needs to be honest about an offer:
 * the gains, the costs, and the exact stat values before and after.
 */
export function previewOffer(build: BuildState, def: UpgradeDef): OfferPreview {
  const before = build.modifiers;
  const after: StatModifiers = { ...BASE_MODIFIERS };
  for (const key of Object.keys(before) as (keyof StatModifiers)[]) {
    (after[key] as number) = before[key];
  }
  accumulateStats(after, def, 1);
  clampStats(after);

  const deltas: StatDelta[] = [];
  for (const row of PREVIEW_ROWS) {
    const a = before[row.key];
    const b = after[row.key];
    if (Math.abs(a - b) < 0.0005) continue;
    deltas.push({
      label: row.label,
      before: row.format(a),
      after: row.format(b),
      better: row.better === 'up' ? b > a : b < a,
    });
  }

  const { benefits, penalties } = describeUpgrade(def, 1);
  return {
    benefits,
    penalties,
    deltas,
    permanence: def.permanence ?? 'save',
    warning: def.warning ?? (penalties.length > 0 ? 'This reward has a real cost.' : null),
  };
}
