/**
 * Data-driven element and ability definitions.
 *
 * Pure data + metadata only (numbers, strings, hex colours). The runtime
 * behaviour of each ability lives in `src/elements/abilities.ts`.
 */

import type { AffinityId, ElementId } from './affinity';

export type AbilitySlotId = 'primary' | 'secondary' | 'technique' | 'ultimate';

export interface AbilityDef {
  readonly id: string;
  readonly name: string;
  readonly slot: AbilitySlotId;
  /** Aether cost. Ultimates cost 0 aether - they spend the Ultimate meter. */
  readonly cost: number;
  /** Base cooldown in seconds (before cooldown upgrades). */
  readonly cooldown: number;
  readonly blurb: string;
  /** Key or button that fires it, for the HUD and the reveal screen. */
  readonly input: string;
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
  /** The Q technique: the element's third active. */
  readonly technique: AbilityDef;
  /** The Ultimate, fired with middle mouse or R once the meter is full. */
  readonly ultimate: AbilityDef;
  /** The three directions a focused single-element build can take. */
  readonly buildPaths: readonly { readonly name: string; readonly blurb: string }[];
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
      input: 'LMB',
      blurb: 'A wide cone of wind that hurls creatures back and swats slow projectiles out of the air.',
    }),
    secondary: Object.freeze({
      id: 'air-dash',
      name: 'Air Dash',
      slot: 'secondary' as const,
      cost: 18,
      cooldown: 1.5,
      input: 'RMB',
      blurb: 'Snap forward on a cushion of wind. One extra dash while airborne, refreshed on landing.',
    }),
    technique: Object.freeze({
      id: 'air-blades',
      name: 'Air Blades',
      slot: 'technique' as const,
      cost: 26,
      cooldown: 3.4,
      input: 'Q',
      blurb: 'Three fast wind blades that pass straight through light creatures and ricochet off terrain.',
    }),
    ultimate: Object.freeze({
      id: 'cyclone',
      name: 'Cyclone',
      slot: 'ultimate' as const,
      cost: 0,
      cooldown: 0,
      input: 'MMB / R',
      blurb: 'A travelling tornado that drags light creatures in, turns projectiles around and grinds heavy ones down.',
    }),
    buildPaths: Object.freeze([
      Object.freeze({ name: 'Mobility', blurb: 'Dashes, sprint speed and damage that scales with how fast you move.' }),
      Object.freeze({ name: 'Knockback', blurb: 'Throw creatures into terrain and hazards, and let the world finish them.' }),
      Object.freeze({ name: 'Reflection', blurb: 'Turn every shot fired at you into a shot fired at them, several times over.' }),
    ]),
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
      input: 'LMB',
      blurb: 'A curling lash of water that soaks, chills and slows whatever it touches. Stronger near open water.',
    }),
    secondary: Object.freeze({
      id: 'freeze',
      name: 'Freeze',
      slot: 'secondary' as const,
      cost: 22,
      cooldown: 3.6,
      input: 'RMB',
      blurb: 'Locks water into a temporary ice bridge and seizes up any creature caught in the bloom. Soaked targets freeze far harder.',
    }),
    technique: Object.freeze({
      id: 'tidal-pull',
      name: 'Tidal Pull',
      slot: 'technique' as const,
      cost: 24,
      cooldown: 4.2,
      input: 'Q',
      blurb: 'Drags soaked creatures toward a point, interrupts their wind-ups and packs them together for a combo.',
    }),
    ultimate: Object.freeze({
      id: 'maelstrom',
      name: 'Maelstrom',
      slot: 'ultimate' as const,
      cost: 0,
      cooldown: 0,
      input: 'MMB / R',
      blurb: 'A vast rotating water field that pulls, soaks and grinds - and flash-freezes anything already soaked enough.',
    }),
    buildPaths: Object.freeze([
      Object.freeze({ name: 'Freeze & shatter', blurb: 'Soak, freeze, then break them apart for area damage.' }),
      Object.freeze({ name: 'Healing & shields', blurb: 'Turn every status you apply into recovery and barriers.' }),
      Object.freeze({ name: 'Streams & control', blurb: 'Wide streams that chain between targets and hold a crowd in place.' }),
    ]),
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
      input: 'LMB',
      blurb: 'Rips a boulder from the ground and throws it. Slow, heavy, and it dents whatever it lands on.',
    }),
    secondary: Object.freeze({
      id: 'raise-wall',
      name: 'Raise Wall',
      slot: 'secondary' as const,
      cost: 25,
      cooldown: 5.5,
      input: 'RMB',
      blurb: 'Heaves a temporary wall of packed earth out of the ground. Real cover, and it crumbles on its own.',
    }),
    technique: Object.freeze({
      id: 'seismic-slam',
      name: 'Seismic Slam',
      slot: 'technique' as const,
      cost: 28,
      cooldown: 4.6,
      input: 'Q',
      blurb: 'Sends cracks tearing through the ground, damaging and staggering everything standing on it.',
    }),
    ultimate: Object.freeze({
      id: 'tectonic-rupture',
      name: 'Tectonic Rupture',
      slot: 'ultimate' as const,
      cost: 0,
      cooldown: 0,
      input: 'MMB / R',
      blurb: 'Reshapes the arena: rising rock, ground fractures, shockwaves and a ring of cover left standing.',
    }),
    buildPaths: Object.freeze([
      Object.freeze({ name: 'Defence & armour', blurb: 'Walls, stance and hide - become the thing that does not move.' }),
      Object.freeze({ name: 'Heavy impact', blurb: 'Boulders, slams and stuns that stop a fight dead.' }),
      Object.freeze({ name: 'Terrain control', blurb: 'Reshape the ground until the arena itself is on your side.' }),
    ]),
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
      input: 'LMB',
      blurb: 'A fast ember that bursts on impact, scorches the ground and leaves its target burning.',
    }),
    secondary: Object.freeze({
      id: 'flame-wave',
      name: 'Flame Wave',
      slot: 'secondary' as const,
      cost: 28,
      cooldown: 4.8,
      input: 'RMB',
      blurb: 'A fan of ground fire that sweeps outward, igniting everything it reaches and the ground under it.',
    }),
    technique: Object.freeze({
      id: 'flame-dash',
      name: 'Flame Dash',
      slot: 'technique' as const,
      cost: 22,
      cooldown: 3.2,
      input: 'Q',
      blurb: 'Lunge forward inside a lance of fire, burning everything you pass through and leaving a burning trail.',
    }),
    ultimate: Object.freeze({
      id: 'inferno',
      name: 'Inferno',
      slot: 'ultimate' as const,
      cost: 0,
      cooldown: 0,
      input: 'MMB / R',
      blurb: 'A controlled firestorm that sets the arena alight and detonates every burning creature that falls in it.',
    }),
    buildPaths: Object.freeze([
      Object.freeze({ name: 'Burning', blurb: 'Stack burning until the fight puts itself out.' }),
      Object.freeze({ name: 'Explosions', blurb: 'Bigger blasts, corpse detonations and chain reactions.' }),
      Object.freeze({ name: 'Aggression', blurb: 'Short cooldowns, rampage stacks and damage that rises as you drop.' }),
    ]),
    passiveName: 'Last Ember',
    passiveBlurb: 'The closer you are to death, the hotter you burn.',
    description:
      'You do not conserve. Everything you have goes out at once, and it is usually enough.',
    shrineName: 'Shrine of the Emberfall',
  }),
});

export const ELEMENT_ORDER: readonly ElementId[] = Object.freeze(['air', 'water', 'earth', 'fire']);

/** The ability an element uses in a given slot. */
export function abilityForSlot(element: ElementId, slot: AbilitySlotId): AbilityDef {
  const def = ELEMENTS[element];
  switch (slot) {
    case 'primary': return def.primary;
    case 'secondary': return def.secondary;
    case 'technique': return def.technique;
    default: return def.ultimate;
  }
}

/** Every active ability of an element, in HUD order. */
export function abilitiesOf(element: ElementId): readonly AbilityDef[] {
  const def = ELEMENTS[element];
  return [def.primary, def.secondary, def.technique, def.ultimate];
}

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
