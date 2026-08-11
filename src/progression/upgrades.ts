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

  // ---- added with the tradeoff / chest layer
  /** Multiplies maximum health (tradeoff penalties use this). */
  maxHealthScale: number;
  /** Multiplies maximum aether. */
  maxEnergyScale: number;
  /** Multiplies aether regeneration. */
  regenScale: number;
  /** Multiplies the radius of area effects. */
  areaScale: number;
  /** Multiplies damage of a *direct* hit (not the splash). */
  directScale: number;
  /** Multiplies damage of non-critical hits only. */
  normalHitScale: number;
  /** Multiplies how far attacks reach. */
  rangeScale: number;
  /** Multiplies the aim-assist cone (1 = normal, 0 = no assistance). */
  aimAssistScale: number;
  /** Multiplies Ultimate damage. */
  ultimateDamage: number;
  /** Multiplies how fast the Ultimate meter fills. */
  ultimateGain: number;
  /** Multiplies sprint speed only. */
  sprintScale: number;
  /** Extra seconds of lung capacity. */
  oxygenCapacity: number;
  /** Multiplies how fast oxygen drains (lower is better). */
  oxygenDrain: number;
  /** Flat aether returned on a damaging hit. */
  manaOnHit: number;
  /** Flat aether returned when a creature is defeated. */
  manaOnKill: number;
  /** Multiplies the strength of status effects the player applies. */
  statusPower: number;
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
  maxHealthScale: 1,
  maxEnergyScale: 1,
  regenScale: 1,
  areaScale: 1,
  directScale: 1,
  normalHitScale: 1,
  rangeScale: 1,
  aimAssistScale: 1,
  ultimateDamage: 1,
  ultimateGain: 1,
  sprintScale: 1,
  oxygenCapacity: 0,
  oxygenDrain: 1,
  manaOnHit: 0,
  manaOnKill: 0,
  statusPower: 1,
});

/** Which stats combine by multiplication rather than addition. */
const MULTIPLICATIVE: readonly (keyof StatModifiers)[] = [
  'damageScale', 'fireScale', 'waterScale', 'earthScale', 'airScale',
  'cooldownScale', 'costScale', 'moveScale', 'projectileSpeed', 'projectileSize',
  'statusDuration', 'knockback',
  'maxHealthScale', 'maxEnergyScale', 'regenScale', 'areaScale', 'directScale',
  'normalHitScale', 'rangeScale', 'aimAssistScale', 'ultimateDamage', 'ultimateGain',
  'sprintScale', 'oxygenDrain', 'statusPower',
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
  /**
   * Where this upgrade comes from.
   *
   *  `reward` (the default) appears on post-encounter selection cards,
   *  `chest`  is only ever granted by opening a chest.
   */
  readonly source?: 'reward' | 'chest';
  /** True when the upgrade carries a deliberate downside. */
  readonly tradeoff?: boolean;
  /** How long the effect lasts. Chest buffs override this at runtime. */
  readonly permanence?: 'save' | 'world' | 'temporary';
  /** Short, explicit warning shown with a caution symbol. */
  readonly warning?: string;
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

// =====================================================================
//  Deep single-element paths
//
//  Every element supports at least three build directions on its own, so a
//  focused adept has as much long-term growth as a Convergence vessel. These
//  fill out the directions the base sets only hinted at.
// =====================================================================

const DEPTH: UpgradeDef[] = [
  // ---- WATER: freeze/shatter, healing/shields, streams & control
  up({
    id: 'water-mending-tide', name: 'Mending Tide', rarity: 'uncommon', element: 'water',
    description: 'Freezing or soaking a creature knits a little of you back together.',
    tags: ['healing'], grants: ['mend-on-status'], maxStacks: 3,
    stats: { manaOnHit: 1.2 }, hooks: ['onStatusApplied'], synergy: ['sustain', 'barriers'],
  }),
  up({
    id: 'water-torrent', name: 'Torrent', rarity: 'rare', element: 'water',
    description: 'Water Whip widens into a torrent that sweeps several targets at once.',
    tags: ['chaining', 'control'], grants: ['whip-wide'], maxStacks: 2,
    stats: { areaScale: 1.2 }, hooks: ['onAbilityCast'], synergy: ['multi-hit'],
  }),
  up({
    id: 'water-undertow', name: 'Undertow', rarity: 'uncommon', element: 'water',
    description: 'Tidal Pull drags harder and holds creatures in place for longer.',
    tags: ['control'], grants: ['pull-strength'], maxStacks: 3,
    stats: { statusPower: 1.2 }, synergy: ['control'],
  }),
  up({
    id: 'water-maelstrom-heart', name: 'Maelstrom Heart', rarity: 'epic', element: 'water',
    description: 'Maelstrom lasts longer and freezes anything it has soaked enough.',
    tags: ['freezing', 'ultimate'], grants: ['ultimate-water'], maxStacks: 1,
    stats: { ultimateDamage: 1.25 }, synergy: ['freezing'],
  }),

  // ---- FIRE: burning, explosions, aggression
  up({
    id: 'fire-wildfire', name: 'Wildfire', rarity: 'uncommon', element: 'fire',
    description: 'Burning spreads from a burning creature to anything that touches it.',
    tags: ['burning'], grants: ['burn-contagion'], maxStacks: 2,
    stats: { statusPower: 1.18 }, hooks: ['onStatusApplied'], synergy: ['burning'],
  }),
  up({
    id: 'fire-blast-core', name: 'Blast Core', rarity: 'rare', element: 'fire',
    description: 'Every fire explosion is wider and hits harder at its edge.',
    tags: ['explosions'], grants: ['blast-core'], maxStacks: 3,
    stats: { areaScale: 1.16 }, synergy: ['explosions'],
  }),
  up({
    id: 'fire-quickdraw', name: 'Quickdraw', rarity: 'common', element: 'fire',
    description: 'Fireball and Flame Wave come back faster.',
    tags: ['rapid'], maxStacks: 4, stats: { cooldownScale: 0.91 }, synergy: ['rapid'],
  }),
  up({
    id: 'fire-inferno-heart', name: 'Inferno Heart', rarity: 'epic', element: 'fire',
    description: 'Inferno burns for longer and detonates the creatures it kills.',
    tags: ['burning', 'ultimate'], grants: ['ultimate-fire'], maxStacks: 1,
    stats: { ultimateDamage: 1.25 }, synergy: ['explosions'],
  }),

  // ---- EARTH: defence, impact, terrain control
  up({
    id: 'earth-bulwark-stance', name: 'Bulwark Stance', rarity: 'uncommon', element: 'earth',
    description: 'Standing on stone or soil hardens you further.',
    tags: ['armor'], grants: ['ground-armor'], maxStacks: 3,
    stats: { armor: 0.06 }, synergy: ['armor'],
  }),
  up({
    id: 'earth-quake-step', name: 'Quakestep', rarity: 'rare', element: 'earth',
    description: 'Seismic Slam cracks a wider area and staggers for longer.',
    tags: ['stun', 'terrain'], grants: ['slam-wide'], maxStacks: 2,
    stats: { areaScale: 1.22, statusPower: 1.15 }, synergy: ['impact'],
  }),
  up({
    id: 'earth-terraformer', name: 'Terraformer', rarity: 'uncommon', element: 'earth',
    description: 'Earth abilities reshape more ground and leave it standing longer.',
    tags: ['terrain', 'structures'], grants: ['deform-strength'], maxStacks: 3,
    synergy: ['structures'],
  }),
  up({
    id: 'earth-tectonic-heart', name: 'Tectonic Heart', rarity: 'epic', element: 'earth',
    description: 'Tectonic Rupture raises more cover and shakes a wider arena.',
    tags: ['terrain', 'ultimate'], grants: ['ultimate-earth'], maxStacks: 1,
    stats: { ultimateDamage: 1.25 }, synergy: ['structures'],
  }),

  // ---- AIR: mobility, knockback, reflection
  up({
    id: 'air-slipstream', name: 'Slipstream', rarity: 'common', element: 'air',
    description: 'Sprinting and dashing are faster, and dashes recover sooner.',
    tags: ['mobility', 'speed'], maxStacks: 4,
    stats: { sprintScale: 1.08, cooldownScale: 0.94 }, synergy: ['mobility'],
  }),
  up({
    id: 'air-hurricane', name: 'Hurricane', rarity: 'rare', element: 'air',
    description: 'Anything blown into terrain or a hazard takes heavy impact damage.',
    tags: ['knockback'], grants: ['hazard-slam'], maxStacks: 2,
    stats: { knockback: 1.2 }, hooks: ['onEnemyDamaged'], synergy: ['knockback'],
  }),
  up({
    id: 'air-blade-storm', name: 'Blade Storm', rarity: 'uncommon', element: 'air',
    description: 'Air Blades releases two extra blades and they ricochet once more.',
    tags: ['multi-hit', 'reflection'], grants: ['extra-blade'], maxStacks: 3,
    synergy: ['multi-hit'],
  }),
  up({
    id: 'air-cyclone-heart', name: 'Cyclone Heart', rarity: 'epic', element: 'air',
    description: 'Cyclone travels further, pulls harder and hurls back more projectiles.',
    tags: ['control', 'ultimate'], grants: ['ultimate-air'], maxStacks: 1,
    stats: { ultimateDamage: 1.25 }, synergy: ['reflection'],
  }),

  // ---- Ability mutations: rare, behaviour-changing, element-specific
  up({
    id: 'mut-frozen-core', name: 'Mutation · Frozen Core', rarity: 'rare', element: 'water',
    description: 'Water Whip fires a shard of ice that pierces the first creature it hits.',
    tags: ['mutation', 'freezing'], grants: ['mutate-whip-shard'], maxStacks: 1,
    hooks: ['onAbilityCast'], synergy: ['freezing'],
  }),
  up({
    id: 'mut-emberfall', name: 'Mutation · Emberfall', rarity: 'rare', element: 'fire',
    description: 'Fireball rains three embers down on impact instead of one burst.',
    tags: ['mutation', 'explosions'], grants: ['mutate-ember-rain'], maxStacks: 1,
    hooks: ['onProjectileHit'], synergy: ['explosions'],
  }),
  up({
    id: 'mut-stonefall', name: 'Mutation · Stonefall', rarity: 'rare', element: 'earth',
    description: 'Rock Shot arcs high and lands as a crater instead of flying flat.',
    tags: ['mutation', 'heavy'], grants: ['mutate-mortar'], maxStacks: 1,
    hooks: ['onAbilityCast'], synergy: ['impact'],
  }),
  up({
    id: 'mut-shearwind', name: 'Mutation · Shearwind', rarity: 'rare', element: 'air',
    description: 'Gust becomes a narrow lance that pierces everything in a line.',
    tags: ['mutation', 'multi-hit'], grants: ['mutate-gust-lance'], maxStacks: 1,
    hooks: ['onAbilityCast'], synergy: ['multi-hit'],
  }),

  // ---- Mana and oxygen support, available to everybody
  up({
    id: 'any-wellspring', name: 'Wellspring', rarity: 'uncommon', element: 'any',
    description: 'Damaging a creature returns a little Mana.',
    tags: ['sustain', 'mana'], maxStacks: 4, stats: { manaOnHit: 1.6 }, synergy: ['sustain'],
  }),
  up({
    id: 'any-reclaim', name: 'Reclaim', rarity: 'uncommon', element: 'any',
    description: 'Defeating a creature returns Mana.',
    tags: ['sustain', 'mana'], maxStacks: 4, stats: { manaOnKill: 8 }, synergy: ['sustain'],
  }),
  up({
    id: 'any-second-breath', name: 'Second Breath', rarity: 'common', element: 'any',
    description: 'Hold your breath for much longer, and use it more slowly.',
    tags: ['sustain'], maxStacks: 3, stats: { oxygenCapacity: 8, oxygenDrain: 0.88 },
  }),
  up({
    id: 'any-perfect-step', name: 'Perfect Step', rarity: 'rare', element: 'any',
    description: 'Dodging an attack at the last moment refunds Mana and charges the Ultimate.',
    tags: ['mobility', 'mana'], grants: ['perfect-dodge'], maxStacks: 2,
    hooks: ['onPlayerDamaged'], synergy: ['mobility'],
  }),
  up({
    id: 'any-ascendant', name: 'Ascendant', rarity: 'uncommon', element: 'any',
    description: 'The Ultimate meter fills noticeably faster.',
    tags: ['ultimate'], maxStacks: 3, stats: { ultimateGain: 1.18 }, synergy: ['ultimate'],
  }),
];

// =====================================================================
//  Tradeoff cards
//
//  Every one of these is a real decision: a clear, sizeable benefit paid for
//  with a clear, sizeable cost. The card UI reads the numbers straight out of
//  `stats`, so a penalty can never be hidden from the player.
// =====================================================================

const TRADEOFFS: UpgradeDef[] = [
  up({
    id: 'trade-glass-cannon', name: 'Glass Cannon', rarity: 'epic', element: 'any',
    description: 'Damage ×2, but maximum health is reduced by 30%.',
    tags: ['power', 'tradeoff'], maxStacks: 1, tradeoff: true,
    warning: 'You will die in far fewer hits.',
    stats: { damageScale: 2, maxHealthScale: 0.7 },
    incompatible: ['chest-double-damage'], synergy: ['risk'],
  }),
  up({
    id: 'trade-reckless-speed', name: 'Reckless Sprint', rarity: 'uncommon', element: 'any',
    description: 'Movement speed +35%, but aim assistance is reduced by 60%.',
    tags: ['speed', 'tradeoff'], maxStacks: 1, tradeoff: true,
    warning: 'Shots no longer bend toward a target.',
    stats: { moveScale: 1.35, aimAssistScale: 0.4 }, synergy: ['speed', 'risk'],
  }),
  up({
    id: 'trade-swift-well', name: 'Swift Well', rarity: 'uncommon', element: 'any',
    description: 'Mana regeneration +60%, but maximum Mana is reduced by 20%.',
    tags: ['mana', 'tradeoff'], maxStacks: 2, tradeoff: true,
    stats: { regenScale: 1.6, maxEnergyScale: 0.8 },
    incompatible: ['trade-deep-reserve'], synergy: ['sustain', 'risk'],
  }),
  up({
    id: 'trade-deep-reserve', name: 'Deep Reserve', rarity: 'uncommon', element: 'any',
    description: 'Maximum Mana +50%, but movement speed is reduced by 10%.',
    tags: ['mana', 'tradeoff'], maxStacks: 2, tradeoff: true,
    stats: { maxEnergyScale: 1.5, moveScale: 0.9 },
    incompatible: ['trade-swift-well'], synergy: ['sustain', 'risk'],
  }),
  up({
    id: 'trade-haste-tax', name: 'Hasty Casting', rarity: 'rare', element: 'any',
    description: 'Cooldowns −30%, but ability Mana costs +25%.',
    tags: ['power', 'tradeoff'], maxStacks: 1, tradeoff: true,
    stats: { cooldownScale: 0.7, costScale: 1.25 },
    incompatible: ['any-overcharge'], synergy: ['rapid', 'risk'],
  }),
  up({
    id: 'trade-precision', name: 'Executioner', rarity: 'rare', element: 'any',
    description: 'Critical chance +25%, but normal hits deal 15% less damage.',
    tags: ['critical', 'tradeoff'], maxStacks: 1, tradeoff: true,
    stats: { critChance: 0.25, normalHitScale: 0.85 }, synergy: ['critical', 'risk'],
  }),
  up({
    id: 'trade-wide-blast', name: 'Wide Detonation', rarity: 'uncommon', element: 'any',
    description: 'Area of effect +40%, but direct-hit damage is reduced by 20%.',
    tags: ['explosions', 'tradeoff'], maxStacks: 2, tradeoff: true,
    stats: { areaScale: 1.4, directScale: 0.8 }, synergy: ['explosions', 'risk'],
  }),
  up({
    id: 'trade-pyre-focus', name: 'Pyre Focus', rarity: 'rare', element: 'fire',
    description: 'Burning is 45% stronger, but attack range is reduced by 25%.',
    tags: ['burning', 'tradeoff'], maxStacks: 1, tradeoff: true,
    warning: 'You must fight much closer in.',
    stats: { statusPower: 1.45, rangeScale: 0.75 }, synergy: ['burning', 'risk'],
  }),
  up({
    id: 'trade-deep-freeze', name: 'Deep Freeze', rarity: 'rare', element: 'water',
    description: 'Freezing lasts 40% longer, but Mana regeneration is reduced by 25%.',
    tags: ['freezing', 'tradeoff'], maxStacks: 1, tradeoff: true,
    stats: { statusDuration: 1.4, regenScale: 0.75 }, synergy: ['freezing', 'risk'],
  }),
  up({
    id: 'trade-bedrock', name: 'Bedrock', rarity: 'rare', element: 'earth',
    description: 'Damage taken −18%, but sprint speed is reduced by 20%.',
    tags: ['armor', 'tradeoff'], maxStacks: 1, tradeoff: true,
    stats: { armor: 0.18, sprintScale: 0.8 }, synergy: ['armor', 'risk'],
  }),
  up({
    id: 'trade-updraft', name: 'Updraft', rarity: 'rare', element: 'air',
    description: 'Movement speed +20% and Air damage +20%, but damage taken +15%.',
    tags: ['mobility', 'tradeoff'], maxStacks: 1, tradeoff: true,
    warning: 'Nothing softens a hit any more.',
    stats: { moveScale: 1.2, airScale: 1.2, armor: -0.15 }, synergy: ['mobility', 'risk'],
  }),
  up({
    id: 'trade-slow-thunder', name: 'Slow Thunder', rarity: 'epic', element: 'any',
    description: 'Ultimate damage +75%, but the Ultimate meter fills 35% more slowly.',
    tags: ['ultimate', 'tradeoff'], maxStacks: 1, tradeoff: true,
    stats: { ultimateDamage: 1.75, ultimateGain: 0.65 }, synergy: ['ultimate', 'risk'],
  }),
];

// =====================================================================
//  Chest-only rewards
//
//  These never appear on a selection card. They are what a chest can contain,
//  and they carry the heaviest single effects in the game - Double Damage most
//  of all, which is legendary, unique, and paid for with a real downside.
// =====================================================================

const CHEST_UPGRADES: UpgradeDef[] = [
  up({
    id: 'chest-double-damage', name: 'Double Damage', rarity: 'legendary', element: 'any',
    description: 'Damage ×2, but maximum Mana is reduced by 25%.',
    tags: ['power', 'tradeoff'], grants: ['double-damage'], maxStacks: 1,
    source: 'chest', tradeoff: true, permanence: 'save',
    warning: 'Unique. It cannot be taken twice, and it thins your Mana pool.',
    stats: { damageScale: 2, maxEnergyScale: 0.75 },
    incompatible: ['trade-glass-cannon'], synergy: ['risk'],
  }),
  up({
    id: 'chest-vital-surge', name: 'Vital Surge', rarity: 'rare', element: 'any',
    description: 'Maximum health +40.',
    tags: ['sustain'], maxStacks: 6, source: 'chest', permanence: 'save',
    stats: { maxHealth: 40 },
  }),
  up({
    id: 'chest-mana-font', name: 'Mana Font', rarity: 'rare', element: 'any',
    description: 'Maximum Mana +35 and regeneration +2/s.',
    tags: ['mana'], maxStacks: 6, source: 'chest', permanence: 'save',
    stats: { maxEnergy: 35, energyRegen: 2 },
  }),
  up({
    id: 'chest-fleetfoot', name: 'Fleetfoot', rarity: 'uncommon', element: 'any',
    description: 'Movement speed +10%.',
    tags: ['speed'], maxStacks: 4, source: 'chest', permanence: 'save',
    stats: { moveScale: 1.1 },
  }),
  up({
    id: 'chest-swift-hands', name: 'Swift Hands', rarity: 'uncommon', element: 'any',
    description: 'Cooldowns −12%.',
    tags: ['rapid'], maxStacks: 4, source: 'chest', permanence: 'save',
    stats: { cooldownScale: 0.88 },
  }),
  up({
    id: 'chest-frugal', name: 'Frugal Casting', rarity: 'uncommon', element: 'any',
    description: 'Ability Mana costs −12%.',
    tags: ['mana'], maxStacks: 4, source: 'chest', permanence: 'save',
    stats: { costScale: 0.88 },
  }),
  up({
    id: 'chest-keen', name: 'Keen Instinct', rarity: 'rare', element: 'any',
    description: 'Critical chance +8%.',
    tags: ['critical'], maxStacks: 4, source: 'chest', permanence: 'save',
    stats: { critChance: 0.08 }, synergy: ['critical'],
  }),
  up({
    id: 'chest-brutal', name: 'Brutal Instinct', rarity: 'epic', element: 'any',
    description: 'Critical damage +0.5×.',
    tags: ['critical'], maxStacks: 3, source: 'chest', permanence: 'save',
    stats: { critScale: 0.5 }, synergy: ['critical'],
  }),
  up({
    id: 'chest-hardened', name: 'Hardened', rarity: 'rare', element: 'any',
    description: 'Damage taken −10%.',
    tags: ['armor'], maxStacks: 4, source: 'chest', permanence: 'save',
    stats: { armor: 0.1 }, synergy: ['armor'],
  }),
  up({
    id: 'chest-wide-reach', name: 'Wide Reach', rarity: 'rare', element: 'any',
    description: 'Area of effect +18%.',
    tags: ['explosions'], maxStacks: 3, source: 'chest', permanence: 'save',
    stats: { areaScale: 1.18 },
  }),
  up({
    id: 'chest-extra-shot', name: 'Splitting Focus', rarity: 'epic', element: 'any',
    description: 'Every projectile ability fires one additional projectile.',
    tags: ['multi-hit'], grants: ['extra-projectile'], maxStacks: 2,
    source: 'chest', permanence: 'save', synergy: ['multi-projectile'],
  }),
  up({
    id: 'chest-lingering-bite', name: 'Lingering Bite', rarity: 'rare', element: 'any',
    description: 'Status effects you apply are 25% stronger and last 20% longer.',
    tags: ['control'], maxStacks: 3, source: 'chest', permanence: 'save',
    stats: { statusPower: 1.25, statusDuration: 1.2 }, synergy: ['control'],
  }),
  up({
    id: 'chest-ultimate-well', name: 'Ultimate Well', rarity: 'epic', element: 'any',
    description: 'The Ultimate meter fills 25% faster.',
    tags: ['ultimate'], maxStacks: 2, source: 'chest', permanence: 'save',
    stats: { ultimateGain: 1.25 }, synergy: ['ultimate'],
  }),
  up({
    id: 'chest-emberheart', name: 'Emberheart', rarity: 'epic', element: 'fire',
    description: 'Fire damage +30% and burning spreads on death.',
    tags: ['burning'], grants: ['corpse-explode'], maxStacks: 2,
    source: 'chest', permanence: 'save', stats: { fireScale: 1.3 }, synergy: ['burning'],
  }),
  up({
    id: 'chest-tideheart', name: 'Tideheart', rarity: 'epic', element: 'water',
    description: 'Water damage +30% and freezing lasts 25% longer.',
    tags: ['freezing'], grants: ['freeze-spread'], maxStacks: 2,
    source: 'chest', permanence: 'save',
    stats: { waterScale: 1.3, statusDuration: 1.25 }, synergy: ['freezing'],
  }),
  up({
    id: 'chest-stoneheart', name: 'Stoneheart', rarity: 'epic', element: 'earth',
    description: 'Earth damage +30% and damage taken −8%.',
    tags: ['armor', 'heavy'], grants: ['ground-armor'], maxStacks: 2,
    source: 'chest', permanence: 'save',
    stats: { earthScale: 1.3, armor: 0.08 }, synergy: ['armor'],
  }),
  up({
    id: 'chest-galeheart', name: 'Galeheart', rarity: 'epic', element: 'air',
    description: 'Air damage +30% and knockback +30%.',
    tags: ['knockback'], grants: ['hazard-slam'], maxStacks: 2,
    source: 'chest', permanence: 'save',
    stats: { airScale: 1.3, knockback: 1.3 }, synergy: ['knockback'],
  }),
];

export const UPGRADES: readonly UpgradeDef[] = Object.freeze([
  ...FIRE, ...WATER, ...EARTH, ...AIR, ...GENERIC, ...DEPTH, ...TRADEOFFS, ...CHEST_UPGRADES,
]);

/** Upgrades that may appear on a post-encounter selection card. */
export const REWARD_UPGRADES: readonly UpgradeDef[] = Object.freeze(
  UPGRADES.filter((u) => u.source !== 'chest'),
);

/** Upgrades that only ever come out of a chest. */
export const CHEST_ONLY_UPGRADES: readonly UpgradeDef[] = Object.freeze(
  UPGRADES.filter((u) => u.source === 'chest'),
);

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

/**
 * Clamp the aggregated modifiers into ranges the game can survive.
 *
 * Tradeoff cards deliberately push numbers downward, so this is also the
 * safety net that stops a stack of penalties from reducing a critical value -
 * health, aether, movement, range - below a playable minimum.
 */
export function clampStats(stats: StatModifiers): StatModifiers {
  stats.armor = Math.min(0.75, Math.max(0, stats.armor));
  stats.critChance = Math.min(0.85, Math.max(0, stats.critChance));
  stats.cooldownScale = Math.max(0.25, stats.cooldownScale);
  stats.costScale = Math.max(0.35, Math.min(2.2, stats.costScale));
  stats.moveScale = Math.min(2.2, Math.max(0.5, stats.moveScale));
  stats.lifesteal = Math.min(0.4, Math.max(0, stats.lifesteal));

  stats.maxHealthScale = Math.min(2.5, Math.max(SAFE_MINIMUMS.maxHealthScale, stats.maxHealthScale));
  stats.maxEnergyScale = Math.min(2.5, Math.max(SAFE_MINIMUMS.maxEnergyScale, stats.maxEnergyScale));
  stats.regenScale = Math.min(3, Math.max(SAFE_MINIMUMS.regenScale, stats.regenScale));
  stats.areaScale = Math.min(2.6, Math.max(0.5, stats.areaScale));
  stats.directScale = Math.min(2.5, Math.max(SAFE_MINIMUMS.directScale, stats.directScale));
  stats.normalHitScale = Math.min(2.5, Math.max(SAFE_MINIMUMS.normalHitScale, stats.normalHitScale));
  stats.rangeScale = Math.min(2, Math.max(SAFE_MINIMUMS.rangeScale, stats.rangeScale));
  stats.aimAssistScale = Math.min(1.5, Math.max(0, stats.aimAssistScale));
  stats.ultimateDamage = Math.min(3, Math.max(0.5, stats.ultimateDamage));
  stats.ultimateGain = Math.min(2.5, Math.max(SAFE_MINIMUMS.ultimateGain, stats.ultimateGain));
  stats.sprintScale = Math.min(1.8, Math.max(SAFE_MINIMUMS.sprintScale, stats.sprintScale));
  stats.oxygenDrain = Math.min(2, Math.max(0.35, stats.oxygenDrain));
  stats.oxygenCapacity = Math.min(60, Math.max(-8, stats.oxygenCapacity));
  stats.statusPower = Math.min(3, Math.max(0.5, stats.statusPower));
  stats.manaOnHit = Math.min(20, Math.max(0, stats.manaOnHit));
  stats.manaOnKill = Math.min(60, Math.max(0, stats.manaOnKill));
  return stats;
}

/**
 * Floors a stack of penalties may never push a value below.
 *
 * These are gameplay-critical: a build that halves its own health four times
 * would otherwise become unplayable rather than risky.
 */
export const SAFE_MINIMUMS = Object.freeze({
  maxHealthScale: 0.45,
  maxEnergyScale: 0.45,
  regenScale: 0.4,
  directScale: 0.5,
  normalHitScale: 0.55,
  rangeScale: 0.55,
  ultimateGain: 0.4,
  sprintScale: 0.6,
});

// =====================================================================
//  Human-readable effect lines
// =====================================================================

export type EffectTone = 'good' | 'bad' | 'neutral';

export interface EffectLine {
  text: string;
  tone: EffectTone;
}

interface StatLabel {
  label: string;
  /** How the raw value maps to a displayed number. */
  kind: 'multiplier' | 'inverse-multiplier' | 'flat' | 'percent-flat';
  suffix?: string;
}

const STAT_LABELS: Partial<Record<keyof StatModifiers, StatLabel>> = {
  damageScale: { label: 'All elemental damage', kind: 'multiplier' },
  fireScale: { label: 'Fire damage', kind: 'multiplier' },
  waterScale: { label: 'Water damage', kind: 'multiplier' },
  earthScale: { label: 'Earth damage', kind: 'multiplier' },
  airScale: { label: 'Air damage', kind: 'multiplier' },
  cooldownScale: { label: 'Cooldowns', kind: 'inverse-multiplier' },
  costScale: { label: 'Ability Mana cost', kind: 'inverse-multiplier' },
  maxHealth: { label: 'Maximum health', kind: 'flat' },
  maxEnergy: { label: 'Maximum Mana', kind: 'flat' },
  energyRegen: { label: 'Mana regeneration', kind: 'flat', suffix: '/s' },
  moveScale: { label: 'Movement speed', kind: 'multiplier' },
  projectileSpeed: { label: 'Projectile speed', kind: 'multiplier' },
  projectileSize: { label: 'Projectile size', kind: 'multiplier' },
  critChance: { label: 'Critical chance', kind: 'percent-flat' },
  critScale: { label: 'Critical damage', kind: 'flat', suffix: '×' },
  statusDuration: { label: 'Status duration', kind: 'multiplier' },
  armor: { label: 'Damage taken', kind: 'percent-flat' },
  lifesteal: { label: 'Life stolen from damage', kind: 'percent-flat' },
  knockback: { label: 'Knockback', kind: 'multiplier' },
  maxHealthScale: { label: 'Maximum health', kind: 'multiplier' },
  maxEnergyScale: { label: 'Maximum Mana', kind: 'multiplier' },
  regenScale: { label: 'Mana regeneration', kind: 'multiplier' },
  areaScale: { label: 'Area of effect', kind: 'multiplier' },
  directScale: { label: 'Direct-hit damage', kind: 'multiplier' },
  normalHitScale: { label: 'Normal-hit damage', kind: 'multiplier' },
  rangeScale: { label: 'Attack range', kind: 'multiplier' },
  aimAssistScale: { label: 'Aim assistance', kind: 'multiplier' },
  ultimateDamage: { label: 'Ultimate damage', kind: 'multiplier' },
  ultimateGain: { label: 'Ultimate charge rate', kind: 'multiplier' },
  sprintScale: { label: 'Sprint speed', kind: 'multiplier' },
  oxygenCapacity: { label: 'Oxygen', kind: 'flat', suffix: 's' },
  oxygenDrain: { label: 'Oxygen use', kind: 'inverse-multiplier' },
  manaOnHit: { label: 'Mana restored on hit', kind: 'flat' },
  manaOnKill: { label: 'Mana restored on defeat', kind: 'flat' },
  statusPower: { label: 'Status effect strength', kind: 'multiplier' },
};

/** Stats where a *lower* number is better for the player. */
const LOWER_IS_BETTER: readonly (keyof StatModifiers)[] = [
  'cooldownScale', 'costScale', 'oxygenDrain',
];

function pct(value: number): string {
  const p = Math.round(Math.abs(value) * 1000) / 10;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/**
 * Turn one stat entry into an exact, human sentence.
 *
 * Never vague: the card always shows the real number the game will apply.
 */
export function describeStat(key: keyof StatModifiers, value: number, stacks = 1): EffectLine | null {
  const label = STAT_LABELS[key];
  if (!label) return null;

  if (label.kind === 'multiplier' || label.kind === 'inverse-multiplier') {
    const total = Math.pow(value, stacks);
    if (Math.abs(total - 1) < 0.0005) return null;
    const delta = total - 1;
    const better = LOWER_IS_BETTER.includes(key) ? delta < 0 : delta > 0;
    const sign = delta > 0 ? '+' : '−';
    return { text: `${label.label} ${sign}${pct(delta)}`, tone: better ? 'good' : 'bad' };
  }

  const total = value * stacks;
  if (Math.abs(total) < 0.0005) return null;
  if (label.kind === 'percent-flat') {
    const better = key === 'armor' ? true : total > 0;
    const sign = total > 0 ? '+' : '−';
    const text = key === 'armor'
      ? `Damage taken −${pct(total)}`
      : `${label.label} ${sign}${pct(total)}`;
    return { text, tone: better ? 'good' : 'bad' };
  }
  const sign = total > 0 ? '+' : '−';
  const shown = Math.round(Math.abs(total) * 100) / 100;
  return {
    text: `${label.label} ${sign}${shown}${label.suffix ?? ''}`,
    tone: total > 0 ? 'good' : 'bad',
  };
}

/** Every numeric change an upgrade would apply, split into gains and costs. */
export function describeUpgrade(def: UpgradeDef, stacks = 1): {
  benefits: EffectLine[];
  penalties: EffectLine[];
} {
  const benefits: EffectLine[] = [];
  const penalties: EffectLine[] = [];
  for (const key of Object.keys(def.stats ?? {}) as (keyof StatModifiers)[]) {
    const value = def.stats?.[key];
    if (value === undefined) continue;
    const line = describeStat(key, value, stacks);
    if (!line) continue;
    (line.tone === 'bad' ? penalties : benefits).push(line);
  }
  return { benefits, penalties };
}
