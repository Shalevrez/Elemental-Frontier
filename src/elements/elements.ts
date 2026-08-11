/**
 * Data-driven element and ability definitions.
 *
 * Pure data + metadata only (numbers, strings, hex colours). The runtime
 * behaviour of each ability lives in `src/elements/abilities.ts`.
 */

import type { AffinityId, ElementId } from './affinity';

export interface AbilityDef {
  readonly id: string;
  readonly name: string;
  readonly slot: 'primary' | 'secondary';
  /** Aether cost. */
  readonly cost: number;
  /** Base cooldown in seconds (before cooldown upgrades). */
  readonly cooldown: number;
  readonly blurb: string;
}

export interface ElementDef {
  readonly id: ElementId;
  readonly name: string;
  /** Original in-world title for a practitioner of this element. */
  readonly adept: string;
  readonly symbol: string;
  /** Primary UI colour. */
  readonly color: number;
  /** Deep / shadow colour. */
  readonly deep: number;
  /** Bright accent used for particles and light flashes. */
  readonly spark: number;
  readonly hotkey: number;
  readonly primary: AbilityDef;
  readonly secondary: AbilityDef;
  readonly passiveName: string;
  readonly passiveBlurb: string;
  readonly description: string;
  /** Shrine flavour name for the matching shrine. */
  readonly shrineName: string;
}

export const ELEMENTS: Readonly<Record<ElementId, ElementDef>> = Object.freeze({
  air: Object.freeze({
    id: 'air',
    name: 'Air',
    adept: 'Gale Adept',
    symbol: '#sym-air',
    color: 0xb8ecff,
    deep: 0x4fb4dc,
    spark: 0xffffff,
    hotkey: 1,
    primary: Object.freeze({
      id: 'gust',
      name: 'Gust',
      slot: 'primary' as const,
      cost: 12,
      cooldown: 0.6,
      blurb: 'A wide cone of wind that hurls creatures back and swats slow projectiles out of the air.',
    }),
    secondary: Object.freeze({
      id: 'air-dash',
      name: 'Air Dash',
      slot: 'secondary' as const,
      cost: 18,
      cooldown: 1.5,
      blurb: 'Snap forward on a cushion of wind. One extra dash while airborne, refreshed on landing.',
    }),
    passiveName: 'Featherstep',
    passiveBlurb: 'Higher jumps, faster sprint, and the ground rarely bruises you.',
    description:
      'You are light on the world. Wind answers before you finish asking, and gravity keeps losing the argument.',
    shrineName: 'Shrine of the Whispering Gale',
  }),
  water: Object.freeze({
    id: 'water',
    name: 'Water',
    adept: 'Tide Adept',
    symbol: '#sym-water',
    color: 0x4aa6ff,
    deep: 0x1f5fbd,
    spark: 0xcbe9ff,
    hotkey: 2,
    primary: Object.freeze({
      id: 'water-whip',
      name: 'Water Whip',
      slot: 'primary' as const,
      cost: 14,
      cooldown: 0.55,
      blurb: 'A curling lash of water that chills and slows whatever it touches. Stronger near open water.',
    }),
    secondary: Object.freeze({
      id: 'freeze',
      name: 'Freeze',
      slot: 'secondary' as const,
      cost: 22,
      cooldown: 3.6,
      blurb: 'Locks water into a temporary ice bridge and seizes up any creature caught in the bloom.',
    }),
    passiveName: 'Tidemend',
    passiveBlurb: 'Standing in water slowly knits your wounds - as long as nothing is hitting you.',
    description:
      'You are patient the way rivers are patient. What you cannot break, you wear down or freeze in place.',
    shrineName: 'Shrine of the Sunken Chorus',
  }),
  earth: Object.freeze({
    id: 'earth',
    name: 'Earth',
    adept: 'Stone Adept',
    symbol: '#sym-earth',
    color: 0x8bd66a,
    deep: 0x3f7f33,
    spark: 0xd9c08a,
    hotkey: 3,
    primary: Object.freeze({
      id: 'rock-shot',
      name: 'Rock Shot',
      slot: 'primary' as const,
      cost: 18,
      cooldown: 0.9,
      blurb: 'Rips a boulder from the ground and throws it. Slow, heavy, and it staggers small creatures.',
    }),
    secondary: Object.freeze({
      id: 'raise-wall',
      name: 'Raise Wall',
      slot: 'secondary' as const,
      cost: 25,
      cooldown: 5.5,
      blurb: 'Heaves a temporary wall of packed earth out of the ground. It crumbles on its own.',
    }),
    passiveName: 'Rootbound',
    passiveBlurb: 'On dirt or stone you shrug off knockback and take less physical damage.',
    description:
      'The ground under you is an ally, not a surface. You hit like a landslide and move like one too.',
    shrineName: 'Shrine of the Stoneheart',
  }),
  fire: Object.freeze({
    id: 'fire',
    name: 'Fire',
    adept: 'Ember Adept',
    symbol: '#sym-fire',
    color: 0xff9b3d,
    deep: 0xd43f1a,
    spark: 0xffe08a,
    hotkey: 4,
    primary: Object.freeze({
      id: 'fireball',
      name: 'Fireball',
      slot: 'primary' as const,
      cost: 16,
      cooldown: 0.8,
      blurb: 'A fast ember that bursts on impact and leaves its target burning.',
    }),
    secondary: Object.freeze({
      id: 'flame-wave',
      name: 'Flame Wave',
      slot: 'secondary' as const,
      cost: 28,
      cooldown: 4.8,
      blurb: 'A fan of ground fire that sweeps outward, igniting everything it reaches.',
    }),
    passiveName: 'Last Ember',
    passiveBlurb: 'The closer you are to death, the hotter you burn.',
    description:
      'You do not conserve. Everything you have goes out at once, and it is usually enough.',
    shrineName: 'Shrine of the Emberfall',
  }),
});

export const ELEMENT_ORDER: readonly ElementId[] = Object.freeze(['air', 'water', 'earth', 'fire']);

export interface AffinityPresentation {
  readonly id: AffinityId;
  readonly title: string;
  readonly symbol: string;
  readonly color: number;
  readonly deep: number;
  readonly description: string;
}

export const CONVERGENCE_COLOR = 0xd9a7ff;
export const CONVERGENCE_DEEP = 0x7b46c9;

/** Presentation data for the affinity reveal and every HUD readout. */
export function affinityPresentation(affinity: AffinityId): AffinityPresentation {
  if (affinity === 'convergence') {
    return {
      id: 'convergence',
      title: 'Elemental Convergence',
      symbol: '#sym-convergence',
      color: CONVERGENCE_COLOR,
      deep: CONVERGENCE_DEEP,
      description:
        'All four currents run through you at once - a thing the Verdance allows about once in eleven lifetimes. Hold one element at a time and switch as the fight demands.',
    };
  }
  const el = ELEMENTS[affinity];
  return {
    id: affinity,
    title: el.adept,
    symbol: el.symbol,
    color: el.color,
    deep: el.deep,
    description: el.description,
  };
}

/** CSS hex string helper (`0xff9b3d` -> `#ff9b3d`). */
export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}
