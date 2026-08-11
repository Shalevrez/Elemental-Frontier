/**
 * Data-driven upgrade definitions.
 *
 * Nothing here knows about Three.js or about any individual ability class.
 * Each upgrade declares *what it is* (rarity, element, requirements, stacking)
 * and *what behaviour it enables* through semantic *tags*. Gameplay code asks
 * the build "how many stacks of the `split` behaviour do I have?" rather than
 * checking for a specific upgrade id, so adding a new upgrade that grants an
 * existing behaviour needs no code change at all.
 */

import type { ElementId } from '../elements/affinity';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export const RARITY_ORDER: readonly Rarity[] = Object.freeze([
  'common', 'uncommon', 'rare', 'epic', 'legendary',
]);

export const RARITY_COLORS: Readonly<Record<Rarity, number>> = Object.freeze({
  common: 0x9fb2c8,
  uncommon: 0x63d38a,
  rare: 0x53a8ff,
  epic: 0xc07bff,
  legendary: 0xffb03a,
});

/** Base draw weights. Higher rarities get rarer, but never impossible. */
export const RARITY_WEIGHTS: Readonly<Record<Rarity, number>> = Object.freeze({
  common: 100,
  uncommon: 55,
  rare: 26,
  epic: 10,
  legendary: 3,
});

/** Gameplay moments an upgrade can react to. */
export type UpgradeHook =
  | 'onAbilityCast'
  | 'onProjectileCreated'
  | 'onProjectileHit'
  | 'onEnemyDamaged'
  | 'onEnemyDefeated'
  | 'onPlayerDamaged'
  | 'onDash'
  | 'onTerrainEdited'
  | 'onStatusApplied'
  | 'onStatusExpired';

/** Additive/multiplicative stat changes an upgrade can contribute. */
export interface StatModifiers {
  /** Multiplies all elemental damage. */
  damageScale: number;
  /** Multiplies damage of one element only. */
  fireScale: number;
  waterScale: number;
  earthScale: number;
  airScale: number;
  /** Multiplies every cooldown (lower is faster). */
  cooldownScale: number;
  /** Multiplies aether costs. */
  costScale: number;
  /** Flat additions. */
  maxHealth: number;
  maxEnergy: number;
  energyRegen: number;
  /** Multiplies movement speed. */
  moveScale: number;
  /** Multiplies projectile speed and size. */
  projectileSpeed: number;
  projectileSize: number;
  /** 0..1 chance of a critical hit, and its damage multiplier. */
  critChance: number;
  critScale: number;
  /** Multiplies how long statuses the player applies last. */
  statusDuration: number;
  /** 0..0.8 flat incoming-damage reduction. */
  armor: number;
  /** Fraction of damage dealt returned as health. */
  lifesteal: number;
  /** Multiplies knockback the player applies. */
  knockback: number;
}

export const BASE_MODIFIERS: Readonly<StatModifiers> = Object.freeze({
  damageScale: 1,
  fireScale: 1,
  waterScale: 1,
  earthScale: 1,
  airScale: 1,
  cooldownScale: 1,
  costScale: 1,
  maxHealth: 0,
  maxEnergy: 0,
  energyRegen: 0,
  moveScale: 1,
  projectileSpeed: 1,
  projectileSize: 1,
  critChance: 0,
  critScale: 1.8,
  statusDuration: 1,
  armor: 0,
  lifesteal: 0,
  knockback: 1,
});

/** Which stats combine by multiplication rather than addition. */
const MULTIPLICATIVE: readonly (keyof StatModifiers)[] = [
  'damageScale', 'fireScale', 'waterScale', 'earthScale', 'airScale',
  'cooldownScale', 'costScale', 'moveScale', 'projectileSpeed', 'projectileSize',
  'statusDuration', 'knockback',
];

export interface UpgradeDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rarity: Rarity;
  /** `any` upgrades can be offered to every affinity. */
  readonly element: ElementId | 'any';
  /** Build-path labels shown in the pause menu, e.g. 'burning', 'armor'. */
  readonly tags: readonly string[];
  /** Behaviour switches the gameplay code queries. */
  readonly grants?: readonly string[];
  /** Other upgrade ids that must already be owned. */
  readonly requires?: readonly string[];
  /** Upgrade ids that make this one unofferable. */
  readonly incompatible?: readonly string[];
  readonly maxStacks: number;
  readonly stats?: Partial<StatModifiers>;
  readonly hooks?: readonly UpgradeHook[];
  /** Synergy labels; two upgrades sharing one are highlighted as a synergy. */
  readonly synergy?: readonly string[];
  /** Meta-unlock id required before this can appear in the pool. */
  readonly unlock?: string;
}

function up(d: UpgradeDef): UpgradeDef {
  return Object.freeze(d);
}

// =====================================================================
//  FIRE - burning, explosions, rapid attacks, crits, low-health aggression
// =====================================================================

const FIRE: UpgradeDef[] = [
  up({
    id: 'fire-split', name: 'Splitting Ember', rarity: 'rare', element: 'fire',
    description: 'Fireball splits into three smaller embers on release.',
    tags: ['explosions', 'rapid'], grants: ['split'], maxStacks: 2,
    stats: { fireScale: 0.78 }, hooks: ['onAbilityCast', 'onProjectileCreated'],
    synergy: ['multi-projectile'],
  }),
  up({
    id: 'fire-corpse-bloom', name: 'Pyre Bloom', rarity: 'uncommon', element: 'fire',
    description: 'Burning enemies explode when defeated, igniting everything nearby.',
    tags: ['burning', 'explosions'], grants: ['corpse-explode'], maxStacks: 3,
    hooks: ['onEnemyDefeated'], synergy: ['burning'],
  }),
  up({
    id: 'fire-scorched-earth', name: 'Scorched Earth', rarity: 'uncommon', element: 'fire',
    description: 'Flame Wave leaves burning ground that ignites anything crossing it.',
    tags: ['burning'], grants: ['burning-ground'], maxStacks: 2,
    hooks: ['onAbilityCast'], synergy: ['burning'],
  }),
  up({
    id: 'fire-crit-spread', name: 'Cinder Chain', rarity: 'rare', element: 'fire',
    description: 'Critical hits spread Burning to every enemy near the victim.',
    tags: ['critical', 'burning'], grants: ['crit-spread'], maxStacks: 1,
    stats: { critChance: 0.12 }, hooks: ['onEnemyDamaged'], synergy: ['critical', 'burning'],
  }),
  up({
    id: 'fire-heavy-ember', name: 'Slow Sun', rarity: 'uncommon', element: 'fire',
    description: 'Fireball becomes much larger and heavier, but travels slowly.',
    tags: ['explosions'], grants: ['big-slow-projectile'], maxStacks: 1,
    stats: { projectileSize: 1.9, projectileSpeed: 0.55, fireScale: 1.45 },
    incompatible: ['fire-split'], synergy: ['heavy'],
  }),
  up({
    id: 'fire-rampage', name: 'Rampage', rarity: 'rare', element: 'fire',
    description: 'Each fire hit briefly stacks attack speed, up to a fierce cap.',
    tags: ['rapid'], grants: ['rampage'], maxStacks: 2,
    hooks: ['onEnemyDamaged'], synergy: ['rapid'],
  }),
  up({
    id: 'fire-last-stand', name: 'Last Stand', rarity: 'epic', element: 'fire',
    description: 'Below half health, fire damage and critical chance surge.',
    tags: ['low-health', 'critical'], grants: ['last-stand'], maxStacks: 1,
    stats: { critChance: 0.08 }, synergy: ['low-health'],
  }),
  up({
    id: 'fire-conflagration', name: 'Conflagration', rarity: 'legendary', element: 'fire',
    description: 'Burning stacks to five and every stack adds explosive force.',
    tags: ['burning', 'explosions'], grants: ['conflagration'], maxStacks: 1,
    stats: { statusDuration: 1.4 }, requires: ['fire-corpse-bloom'],
    hooks: ['onStatusApplied'], synergy: ['burning'],
  }),
];

// =====================================================================
//  WATER - freezing, healing, control, chaining, barriers
// =====================================================================

const WATER: UpgradeDef[] = [
  up({
    id: 'water-return-lash', name: 'Returning Lash', rarity: 'uncommon', element: 'water',
    description: 'Water Whip snaps back on the way out, striking a second time.',
    tags: ['chaining'], grants: ['whip-return'], maxStacks: 2,
    hooks: ['onAbilityCast'], synergy: ['multi-hit'],
  }),
  up({
    id: 'water-shatter-nova', name: 'Shatter Nova', rarity: 'rare', element: 'water',
    description: 'Frozen enemies that break send damaging ice outward.',
    tags: ['freezing'], grants: ['shatter-nova'], maxStacks: 3,
    hooks: ['onEnemyDamaged'], synergy: ['freezing'],
  }),
  up({
    id: 'water-creeping-frost', name: 'Creeping Frost', rarity: 'rare', element: 'water',
    description: 'Freeze spreads from a frozen enemy to those beside it.',
    tags: ['freezing', 'control'], grants: ['freeze-spread'], maxStacks: 2,
    hooks: ['onStatusApplied'], synergy: ['freezing'],
  }),
  up({
    id: 'water-tideguard', name: 'Tideguard', rarity: 'uncommon', element: 'water',
    description: 'Any healing also grants a temporary shield.',
    tags: ['healing', 'barriers'], grants: ['heal-shield'], maxStacks: 3,
    synergy: ['barriers'],
  }),
  up({
    id: 'water-skipping-stream', name: 'Skipping Stream', rarity: 'uncommon', element: 'water',
    description: 'Water attacks leap to one more nearby enemy.',
    tags: ['chaining'], grants: ['bounce'], maxStacks: 3,
    hooks: ['onEnemyDamaged'], synergy: ['multi-hit'],
  }),
  up({
    id: 'water-splinter-ice', name: 'Splinter Ice', rarity: 'uncommon', element: 'water',
    description: 'Broken ice leaves shards that cut anything walking through.',
    tags: ['freezing', 'control'], grants: ['ice-shards'], maxStacks: 2,
    synergy: ['freezing'],
  }),
  up({
    id: 'water-deep-current', name: 'Deep Current', rarity: 'epic', element: 'water',
    description: 'Wet enemies take far more damage from every source.',
    tags: ['control'], grants: ['deep-current'], maxStacks: 1,
    hooks: ['onEnemyDamaged'], synergy: ['wet'],
  }),
  up({
    id: 'water-glacier', name: 'Glacier Heart', rarity: 'legendary', element: 'water',
    description: 'Freeze lasts far longer and frozen foes shatter for huge damage.',
    tags: ['freezing', 'control'], grants: ['glacier'], maxStacks: 1,
    stats: { statusDuration: 1.5 }, requires: ['water-shatter-nova'], synergy: ['freezing'],
  }),
];

// =====================================================================
//  EARTH - armor, heavy impact, stun, terrain control, structures
// =====================================================================

const EARTH: UpgradeDef[] = [
  up({
    id: 'earth-fragment', name: 'Fragmenting Stone', rarity: 'uncommon', element: 'earth',
    description: 'Rock Shot bursts into sharp fragments on impact.',
    tags: ['heavy'], grants: ['rock-fragment'], maxStacks: 3,
    hooks: ['onProjectileHit'], synergy: ['multi-projectile'],
  }),
  up({
    id: 'earth-ricochet', name: 'Ricochet', rarity: 'rare', element: 'earth',
    description: 'Rock Shot rebounds off terrain instead of stopping.',
    tags: ['heavy'], grants: ['rock-bounce'], maxStacks: 2,
    hooks: ['onProjectileHit'], synergy: ['multi-hit'],
  }),
  up({
    id: 'earth-detonating-wall', name: 'Detonating Bulwark', rarity: 'rare', element: 'earth',
    description: 'Raised walls explode when they crumble.',
    tags: ['structures', 'heavy'], grants: ['wall-explode'], maxStacks: 2,
    hooks: ['onAbilityCast'], synergy: ['structures'],
  }),
  up({
    id: 'earth-stonehide', name: 'Stonehide', rarity: 'common', element: 'earth',
    description: 'Raising a wall grants you armor for a while.',
    tags: ['armor', 'structures'], grants: ['wall-armor'], maxStacks: 3,
    hooks: ['onAbilityCast'], synergy: ['armor'],
  }),
  up({
    id: 'earth-crush', name: 'Crushing Impact', rarity: 'uncommon', element: 'earth',
    description: 'Enemies knocked into terrain are stunned and take impact damage.',
    tags: ['stun', 'heavy'], grants: ['wall-slam-stun'], maxStacks: 2,
    stats: { knockback: 1.25 }, hooks: ['onEnemyDamaged'], synergy: ['impact'],
  }),
  up({
    id: 'earth-fissure', name: 'Fissure', rarity: 'rare', element: 'earth',
    description: 'Heavy impacts tear damaging cracks across the ground.',
    tags: ['terrain', 'heavy'], grants: ['ground-cracks'], maxStacks: 2,
    hooks: ['onProjectileHit'], synergy: ['impact'],
  }),
  up({
    id: 'earth-unmoved', name: 'Unmoved', rarity: 'epic', element: 'earth',
    description: 'Standing still builds armor quickly; moving spends it.',
    tags: ['armor'], grants: ['unmoved'], maxStacks: 1,
    stats: { armor: 0.08 }, synergy: ['armor'],
  }),
  up({
    id: 'earth-tectonic', name: 'Tectonic Will', rarity: 'legendary', element: 'earth',
    description: 'Walls rise instantly, last far longer and shrug off projectiles.',
    tags: ['structures', 'terrain'], grants: ['tectonic'], maxStacks: 1,
    requires: ['earth-stonehide'], synergy: ['structures'],
  }),
];

// =====================================================================
//  AIR - speed, knockback, reflection, multi-hit, mobility
// =====================================================================

const AIR: UpgradeDef[] = [
  up({
    id: 'air-cyclone-trail', name: 'Cyclone Trail', rarity: 'rare', element: 'air',
    description: 'Air Dash leaves a tornado that drags enemies in.',
    tags: ['mobility', 'control'], grants: ['dash-tornado'], maxStacks: 2,
    hooks: ['onDash'], synergy: ['mobility'],
  }),
  up({
    id: 'air-mirror-gale', name: 'Mirror Gale', rarity: 'uncommon', element: 'air',
    description: 'Gust hurls deflected projectiles straight back at whoever fired them.',
    tags: ['reflection'], grants: ['gust-reflect-source'], maxStacks: 1,
    hooks: ['onAbilityCast'], synergy: ['reflection'],
  }),
  up({
    id: 'air-double-gust', name: 'Second Wind', rarity: 'uncommon', element: 'air',
    description: 'Gust triggers a second time a moment later.',
    tags: ['multi-hit'], grants: ['gust-double'], maxStacks: 2,
    hooks: ['onAbilityCast'], synergy: ['multi-hit'],
  }),
  up({
    id: 'air-shear', name: 'Shearwind', rarity: 'common', element: 'air',
    description: 'Air Dash cuts every enemy you pass through.',
    tags: ['mobility'], grants: ['dash-damage'], maxStacks: 3,
    hooks: ['onDash'], synergy: ['mobility'],
  }),
  up({
    id: 'air-momentum', name: 'Momentum', rarity: 'rare', element: 'air',
    description: 'Air damage rises the faster you are moving.',
    tags: ['speed'], grants: ['speed-damage'], maxStacks: 2,
    stats: { moveScale: 1.06 }, synergy: ['speed'],
  }),
  up({
    id: 'air-thunderclap', name: 'Thunderclap', rarity: 'rare', element: 'air',
    description: 'Deflected projectiles burst into a wind explosion on impact.',
    tags: ['reflection', 'knockback'], grants: ['deflect-burst'], maxStacks: 2,
    hooks: ['onProjectileHit'], requires: ['air-mirror-gale'], synergy: ['reflection'],
  }),
  up({
    id: 'air-featherfall', name: 'Featherfall', rarity: 'common', element: 'air',
    description: 'An extra air dash, and dashes cost less aether.',
    tags: ['mobility', 'speed'], grants: ['extra-dash'], maxStacks: 2,
    stats: { costScale: 0.9 }, synergy: ['mobility'],
  }),
  up({
    id: 'air-tempest', name: 'Tempest Crown', rarity: 'legendary', element: 'air',
    description: 'Gust becomes a whirling storm that flings everything aside.',
    tags: ['knockback', 'control'], grants: ['tempest'], maxStacks: 1,
    stats: { knockback: 1.6, airScale: 1.25 }, requires: ['air-double-gust'], synergy: ['knockback'],
  }),
];

// =====================================================================
//  ANY - available to every affinity
// =====================================================================

const GENERIC: UpgradeDef[] = [
  up({
    id: 'any-honed', name: 'Honed Focus', rarity: 'common', element: 'any',
    description: 'All elemental damage +12%.',
    tags: ['power'], maxStacks: 5, stats: { damageScale: 1.12 },
  }),
  up({
    id: 'any-swift-currents', name: 'Swift Currents', rarity: 'common', element: 'any',
    description: 'All cooldowns -10%.',
    tags: ['power'], maxStacks: 4, stats: { cooldownScale: 0.9 },
  }),
  up({
    id: 'any-deep-well', name: 'Deep Well', rarity: 'common', element: 'any',
    description: '+25 maximum aether and +1.5 regeneration.',
    tags: ['sustain'], maxStacks: 4, stats: { maxEnergy: 25, energyRegen: 1.5 },
  }),
  up({
    id: 'any-hardy', name: 'Hardy', rarity: 'common', element: 'any',
    description: '+25 maximum health.',
    tags: ['sustain'], maxStacks: 5, stats: { maxHealth: 25 },
  }),
  up({
    id: 'any-quickstep', name: 'Quickstep', rarity: 'common', element: 'any',
    description: 'Move 8% faster.',
    tags: ['speed'], maxStacks: 4, stats: { moveScale: 1.08 },
  }),
  up({
    id: 'any-keen-edge', name: 'Keen Edge', rarity: 'uncommon', element: 'any',
    description: '+10% critical chance.',
    tags: ['critical'], maxStacks: 4, stats: { critChance: 0.1 }, synergy: ['critical'],
  }),
  up({
    id: 'any-cruel-edge', name: 'Cruel Edge', rarity: 'rare', element: 'any',
    description: 'Critical hits deal far more damage.',
    tags: ['critical'], maxStacks: 3, stats: { critScale: 0.6 },
    requires: ['any-keen-edge'], synergy: ['critical'],
  }),
  up({
    id: 'any-warded', name: 'Warded Skin', rarity: 'uncommon', element: 'any',
    description: 'Take 12% less damage.',
    tags: ['armor'], maxStacks: 4, stats: { armor: 0.12 }, synergy: ['armor'],
  }),
  up({
    id: 'any-siphon', name: 'Siphon', rarity: 'rare', element: 'any',
    description: 'Heal for a small share of the damage you deal.',
    tags: ['sustain'], maxStacks: 3, stats: { lifesteal: 0.05 }, synergy: ['sustain'],
  }),
  up({
    id: 'any-lingering', name: 'Lingering Grasp', rarity: 'uncommon', element: 'any',
    description: 'Statuses you apply last 30% longer.',
    tags: ['control'], maxStacks: 3, stats: { statusDuration: 1.3 }, synergy: ['control'],
  }),
  up({
    id: 'any-overcharge', name: 'Overcharge', rarity: 'epic', element: 'any',
    description: 'Big damage, but every ability costs far more aether.',
    tags: ['power'], maxStacks: 1, stats: { damageScale: 1.5, costScale: 1.45 },
  }),
  up({
    id: 'any-echo', name: 'Echo of the Verdance', rarity: 'legendary', element: 'any',
    description: 'Every ability has a chance to cast a second time for free.',
    tags: ['power', 'multi-hit'], grants: ['echo-cast'], maxStacks: 1,
    hooks: ['onAbilityCast'], synergy: ['multi-hit'],
  }),
];

export const UPGRADES: readonly UpgradeDef[] = Object.freeze([
  ...FIRE, ...WATER, ...EARTH, ...AIR, ...GENERIC,
]);

const BY_ID = new Map<string, UpgradeDef>(UPGRADES.map((u) => [u.id, u]));

export function upgradeById(id: string): UpgradeDef | null {
  return BY_ID.get(id) ?? null;
}

export function upgradesForElement(element: ElementId | 'any'): UpgradeDef[] {
  return UPGRADES.filter((u) => u.element === element);
}

/** Sanity check used by the tests: ids unique, references resolvable. */
export function validateUpgradeRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const u of UPGRADES) {
    if (seen.has(u.id)) problems.push(`duplicate id ${u.id}`);
    seen.add(u.id);
    if (u.maxStacks < 1) problems.push(`${u.id} has maxStacks < 1`);
    for (const r of u.requires ?? []) {
      if (!BY_ID.has(r)) problems.push(`${u.id} requires unknown ${r}`);
    }
    for (const i of u.incompatible ?? []) {
      if (!BY_ID.has(i)) problems.push(`${u.id} incompatible with unknown ${i}`);
    }
    if (u.requires?.includes(u.id)) problems.push(`${u.id} requires itself`);
  }
  return problems;
}

/** Combine one upgrade's stats into an accumulator, honouring stack count. */
export function accumulateStats(target: StatModifiers, def: UpgradeDef, stacks: number): void {
  if (!def.stats) return;
  for (const key of Object.keys(def.stats) as (keyof StatModifiers)[]) {
    const value = def.stats[key];
    if (value === undefined) continue;
    if (MULTIPLICATIVE.includes(key)) {
      target[key] *= Math.pow(value, stacks);
    } else {
      target[key] += value * stacks;
    }
  }
}

export function clampStats(stats: StatModifiers): StatModifiers {
  stats.armor = Math.min(0.75, Math.max(0, stats.armor));
  stats.critChance = Math.min(0.85, Math.max(0, stats.critChance));
  stats.cooldownScale = Math.max(0.25, stats.cooldownScale);
  stats.costScale = Math.max(0.35, stats.costScale);
  stats.moveScale = Math.min(2.2, Math.max(0.5, stats.moveScale));
  stats.lifesteal = Math.min(0.4, Math.max(0, stats.lifesteal));
  return stats;
}
