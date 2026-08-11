/**
 * The story of the World Hearts.
 *
 * An original frame for what the game already does: why the player wakes with
 * a random element, why the worlds are severed, why the creatures are wrong,
 * why powers carry between worlds, and what happens after the last guardian.
 *
 * Beats are short, skippable once seen, and never fire during a fight - the
 * caller decides when it is safe to show one. Pure data plus a tiny progress
 * tracker so the sequencing is testable.
 */

import type { WorldId } from '../world/worlds';

export type StoryTrigger =
  | 'opening'
  | 'world-intro'
  | 'first-heart'
  | 'pre-boss'
  | 'guardian-defeated'
  | 'world-transition'
  | 'final-reveal'
  | 'post-game'
  | 'lore';

export interface StoryBeat {
  readonly id: string;
  readonly trigger: StoryTrigger;
  /** World this beat belongs to, when it is world-specific. */
  readonly world?: WorldId;
  readonly title: string;
  readonly lines: readonly string[];
  /** Seconds the beat is expected to occupy; used to keep them short. */
  readonly seconds: number;
  /** A beat marked `blocking` takes over the screen; others are HUD banners. */
  readonly blocking: boolean;
}

function beat(b: StoryBeat): StoryBeat {
  return Object.freeze({ ...b, lines: Object.freeze([...b.lines]) });
}

export const STORY_BEATS: readonly StoryBeat[] = Object.freeze([
  beat({
    id: 'opening',
    trigger: 'opening',
    title: 'The Bound Wanderer',
    seconds: 12,
    blocking: true,
    lines: [
      'Once, four World Hearts held the worlds against one another, and everything that lived drew breath through them.',
      'Then the Hollow came - not an army, not a beast, but an absence that ate the joins between things.',
      'The Hearts cracked. The worlds drifted apart. The guardians set to keep them woke up wrong.',
      'You are what the Hearts do when they are dying: a Wanderer, bound to a single surviving current, woken because there was no one else left to wake.',
      'Which current answered you was never your choice. It was whichever one still had the strength to reach.',
    ],
  }),

  // ---- world introductions
  beat({
    id: 'intro-wilds',
    trigger: 'world-intro',
    world: 'wilds',
    title: 'Verdant Ruins',
    seconds: 7,
    blocking: false,
    lines: [
      'Forest has taken the roads, the bridges and most of the names.',
      'The first World Heart is buried somewhere under the green. Its guardian has not slept in a long time.',
    ],
  }),
  beat({
    id: 'intro-depths',
    trigger: 'world-intro',
    world: 'depths',
    title: 'Tidal Archipelago',
    seconds: 7,
    blocking: false,
    lines: [
      'Islands, and between them a sea that used to be a city.',
      'Sound carries strangely down here. So does the Hollow.',
    ],
  }),
  beat({
    id: 'intro-ashen',
    trigger: 'world-intro',
    world: 'ashen',
    title: 'Ember Caldera',
    seconds: 7,
    blocking: false,
    lines: [
      'This world burned before the Hollow arrived. The Hollow simply stopped it healing.',
      'Stay on the high stone. The rivers here are not water.',
    ],
  }),
  beat({
    id: 'intro-peaks',
    trigger: 'world-intro',
    world: 'peaks',
    title: 'Frozen Expanse',
    seconds: 7,
    blocking: false,
    lines: [
      'The last Heart went cold rather than let itself be eaten.',
      'Everything above the ice line is either frozen or pretending to be.',
    ],
  }),

  // ---- pre-boss and defeat beats, one per world
  beat({
    id: 'pre-boss-wilds',
    trigger: 'pre-boss',
    world: 'wilds',
    title: 'The Rootwarden stirs',
    seconds: 5,
    blocking: false,
    lines: ['It was set here to hold a door. The door is gone; it is still holding.'],
  }),
  beat({
    id: 'pre-boss-depths',
    trigger: 'pre-boss',
    world: 'depths',
    title: 'The Drowned Chorus',
    seconds: 5,
    blocking: false,
    lines: ['It sings the shape of a city that is no longer there. Do not answer it.'],
  }),
  beat({
    id: 'pre-boss-ashen',
    trigger: 'pre-boss',
    world: 'ashen',
    title: 'The Cinderbound',
    seconds: 5,
    blocking: false,
    lines: ['It has been trying to put itself out for a very long time.'],
  }),
  beat({
    id: 'pre-boss-peaks',
    trigger: 'pre-boss',
    world: 'peaks',
    title: 'The Rimebound',
    seconds: 5,
    blocking: false,
    lines: ['The last guardian did not fall to the Hollow. It froze itself first, and the Hollow moved in anyway.'],
  }),

  beat({
    id: 'heart-restored',
    trigger: 'guardian-defeated',
    title: 'A World Heart beats again',
    seconds: 8,
    blocking: true,
    lines: [
      'The guardian comes apart, and what is underneath is not a monster at all - it is a keeper, finally allowed to stop.',
      'The Heart takes your hand the way a lock takes a key.',
      'It does not give you anything new. It stops taking. Everything you have earned is now yours to keep, across every world you walk into.',
    ],
  }),

  beat({
    id: 'transition',
    trigger: 'world-transition',
    title: 'The way opens',
    seconds: 6,
    blocking: false,
    lines: [
      'A restored Heart remembers where its neighbours were.',
      'Step through. What you are goes with you - the current, the powers, the bargains you made.',
    ],
  }),

  beat({
    id: 'final-reveal',
    trigger: 'final-reveal',
    title: 'What the Hollow was',
    seconds: 14,
    blocking: true,
    lines: [
      'With four Hearts beating, the joins come back, and so does the memory in them.',
      'The Hollow was not an invader. It was what the Hearts became when they were asked to hold too much for too long, and were never allowed to rest.',
      'The worlds were separated on purpose - by the keepers, to stop the emptiness spreading. They knew it would cost them their minds.',
      'You are the repair the Hearts made in advance: a wanderer bound to one current, small enough to survive the crossing.',
      'A new Wanderer wakes to a new current, because no single Heart may be leaned on twice. That is the whole of the rule.',
      'The joins hold. The worlds stay open. Nothing is finished - it is simply no longer falling apart.',
    ],
  }),

  beat({
    id: 'post-game',
    trigger: 'post-game',
    title: 'After',
    seconds: 8,
    blocking: false,
    lines: [
      'The worlds stay where you left them, and so does everything you built.',
      'The Hollow is thinner now, not gone. Deeper trials remain, and the Hearts will keep the door open as long as you keep walking.',
    ],
  }),

  // ---- discoverable lore fragments, shown as quiet banners
  beat({
    id: 'lore-statue',
    trigger: 'lore',
    title: 'A keeper, carved',
    seconds: 6,
    blocking: false,
    lines: ['The statue has four hands and no face. Whoever carved it did not want to guess.'],
  }),
  beat({
    id: 'lore-ruin',
    trigger: 'lore',
    title: 'Wall fragment',
    seconds: 6,
    blocking: false,
    lines: ['"...and we cut the roads ourselves, so that the emptiness would have further to walk."'],
  }),
  beat({
    id: 'lore-heartstone',
    trigger: 'lore',
    title: 'Heartstone shard',
    seconds: 6,
    blocking: false,
    lines: ['Warm. Still trying to connect to something that is not there any more.'],
  }),
  beat({
    id: 'lore-convergence',
    trigger: 'lore',
    title: 'On Convergence',
    seconds: 6,
    blocking: false,
    lines: [
      '"Once in eleven wakings, all four Hearts reach at the same moment. The Wanderer that answers can hold any of them - and none of them well."',
    ],
  }),
]);

const BY_ID = new Map(STORY_BEATS.map((b) => [b.id, b]));

export function storyBeat(id: string): StoryBeat | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Find the beat for a trigger, preferring a world-specific one.
 *
 * Returns null when there is nothing to show, which is the common case.
 */
export function beatFor(trigger: StoryTrigger, world?: WorldId): StoryBeat | null {
  if (world) {
    const specific = STORY_BEATS.find((b) => b.trigger === trigger && b.world === world);
    if (specific) return specific;
  }
  return STORY_BEATS.find((b) => b.trigger === trigger && !b.world) ?? null;
}

/** Persistent record of which beats the player has already seen. */
export class StoryProgress {
  private seen = new Set<string>();

  load(data: unknown): void {
    this.seen.clear();
    if (!Array.isArray(data)) return;
    for (const entry of data) {
      if (typeof entry === 'string' && BY_ID.has(entry)) this.seen.add(entry);
    }
  }

  toJSON(): string[] {
    return [...this.seen];
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  get size(): number {
    return this.seen.size;
  }

  markSeen(id: string): void {
    if (BY_ID.has(id)) this.seen.add(id);
  }

  clear(): void {
    this.seen.clear();
  }

  /**
   * The beat to play for a trigger, or null when it has been seen already and
   * the caller asked for unseen beats only.
   */
  pending(trigger: StoryTrigger, world?: WorldId, repeat = false): StoryBeat | null {
    const b = beatFor(trigger, world);
    if (!b) return null;
    if (!repeat && this.seen.has(b.id)) return null;
    return b;
  }

  /** True once a beat has been seen, so its replay may be skipped instantly. */
  skippable(id: string): boolean {
    return this.seen.has(id);
  }
}

/** Which lore fragment a given world position reveals, deterministic per seed. */
export function loreFragmentFor(index: number): StoryBeat {
  const lore = STORY_BEATS.filter((b) => b.trigger === 'lore');
  return lore[Math.abs(Math.floor(index)) % lore.length]!;
}
