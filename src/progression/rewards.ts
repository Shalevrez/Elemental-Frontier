/**
 * Reward rolling: choosing the three upgrades offered after an encounter.
 *
 * Pure and injectable-random so the draw rules can be tested exactly.
 */

import type { ElementId } from '../elements/affinity';
import type { BuildState } from './BuildState';
import {
  RARITY_WEIGHTS, UPGRADES, type Rarity, type UpgradeDef,
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
  return UPGRADES.filter((def) => build.canOffer(def, ctx.elements, ctx.unlocked));
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
