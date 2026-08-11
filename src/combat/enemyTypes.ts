/**
 * Enemy archetypes and elite modifiers.
 *
 * Every archetype differs in silhouette, movement, attack pattern, timing and
 * tactical role - not just in colour and health. Pure data, so the roster is
 * testable and the spawn director can reason about it without touching the
 * renderer.
 */

import type { ElementId } from '../elements/affinity';
import type { StatusId } from './status';

export type EnemyKind =
  | 'crawler'    // fast melee hunter (the original)
  | 'wisp'       // flying ranged (the original)
  | 'guardian'   // shrine guardian (the original)
  | 'brute'      // armored tank, slow, huge knockback resist
  | 'slinger'    // ground ranged, keeps range, arcing shots
  | 'burrower'   // ambusher, travels underground, erupts
  | 'warden'     // summoner, calls crawlers, never closes
  | 'mender'     // support, heals nearby allies, flees the player
  | 'sapper'     // exploding charger
  | 'bulwark'    // shielded, must be flanked or broken
  | 'boss-maw';  // multi-phase world boss

/** How the creature moves through the world. */
export type Locomotion = 'ground' | 'hover' | 'burrow';

/** What the creature is trying to do. */
export type EnemyRole = 'melee' | 'ranged' | 'ambush' | 'support' | 'summon' | 'suicide' | 'tank' | 'boss';

export interface EnemyAttackDef {
  readonly id: string;
  /** Seconds of visible wind-up before the hit lands. */
  readonly telegraph: number;
  /** Seconds the creature is committed after the hit. */
  readonly recovery: number;
  readonly range: number;
  readonly damage: number;
  readonly cooldown: number;
  /** 'melee' arcs in front, 'projectile' fires, 'area' is a ground slam. */
  readonly shape: 'melee' | 'projectile' | 'area' | 'cone';
  /** Radius of the ground warning marker; 0 hides it. */
  readonly markerRadius: number;
  readonly knockback: number;
  readonly applies?: { status: StatusId; seconds: number; magnitude?: number };
  /** Costs an attack token from the combat director. */
  readonly needsToken: boolean;
}

function atk(a: EnemyAttackDef): EnemyAttackDef {
  return Object.freeze(a);
}

export interface EnemyTypeDef {
  readonly kind: EnemyKind;
  readonly name: string;
  readonly role: EnemyRole;
  readonly locomotion: Locomotion;
  readonly maxHealth: number;
  readonly speed: number;
  readonly detectRange: number;
  readonly loseRange: number;
  readonly radius: number;
  readonly height: number;
  readonly knockbackResist: number;
  readonly energyDrop: number;
  /** Preferred distance from the player. 0 means "get in its face". */
  readonly standoff: number;
  readonly attacks: readonly EnemyAttackDef[];
  /** Damage multipliers by element. Never 0 - nothing is immune. */
  readonly resistance: Readonly<Record<ElementId, number>>;
  /** Accent colour for eyes, glow and telegraphs. */
  readonly accent: number;
  /** Body tint. */
  readonly body: number;
  /** Threat weight used by the spawn budget. */
  readonly threat: number;
  /** Meta unlock required, if any. */
  readonly unlock?: string;
  readonly blurb: string;
}

function ed(d: EnemyTypeDef): EnemyTypeDef {
  return Object.freeze(d);
}

const NEUTRAL: Readonly<Record<ElementId, number>> = Object.freeze({
  air: 1, water: 1, earth: 1, fire: 1,
});

export const ENEMY_TYPES: Readonly<Record<EnemyKind, EnemyTypeDef>> = Object.freeze({
  crawler: ed({
    kind: 'crawler', name: 'Corrupted Crawler', role: 'melee', locomotion: 'ground',
    maxHealth: 38, speed: 3.6, detectRange: 24, loseRange: 42,
    radius: 0.5, height: 1.0, knockbackResist: 0.25, energyDrop: 9, standoff: 0,
    attacks: [atk({
      id: 'bite', telegraph: 0.42, recovery: 0.35, range: 2.1, damage: 9,
      cooldown: 1.15, shape: 'melee', markerRadius: 0, knockback: 4.5, needsToken: true,
    })],
    resistance: Object.freeze({ air: 0.9, water: 1.0, earth: 1.15, fire: 1.2 }),
    accent: 0xff5fd0, body: 0x3c2154, threat: 1,
    blurb: 'Low, quick and never alone.',
  }),

  wisp: ed({
    kind: 'wisp', name: 'Corrupted Wisp', role: 'ranged', locomotion: 'hover',
    maxHealth: 26, speed: 3.0, detectRange: 28, loseRange: 46,
    radius: 0.5, height: 1.4, knockbackResist: 0.05, energyDrop: 12, standoff: 9,
    attacks: [atk({
      id: 'bolt', telegraph: 0.55, recovery: 0.3, range: 17, damage: 8,
      cooldown: 2.3, shape: 'projectile', markerRadius: 0, knockback: 3.5, needsToken: false,
    })],
    resistance: Object.freeze({ air: 1.35, water: 1.1, earth: 0.85, fire: 1.0 }),
    accent: 0xd08bff, body: 0x4a2769, threat: 1.2,
    blurb: 'Drifts out of reach and lobs slow bolts you can swat back.',
  }),

  brute: ed({
    kind: 'brute', name: 'Blight Brute', role: 'tank', locomotion: 'ground',
    maxHealth: 130, speed: 2.1, detectRange: 26, loseRange: 48,
    radius: 0.85, height: 2.2, knockbackResist: 0.75, energyDrop: 24, standoff: 0,
    attacks: [
      atk({
        id: 'overhead', telegraph: 0.95, recovery: 0.7, range: 3.0, damage: 22,
        cooldown: 2.6, shape: 'area', markerRadius: 3.2, knockback: 11, needsToken: true,
      }),
      atk({
        id: 'sweep', telegraph: 0.6, recovery: 0.45, range: 3.4, damage: 13,
        cooldown: 3.4, shape: 'cone', markerRadius: 3.6, knockback: 8, needsToken: true,
      }),
    ],
    resistance: Object.freeze({ air: 0.8, water: 1.1, earth: 0.9, fire: 1.15 }),
    accent: 0xffa347, body: 0x4a3a2c, threat: 3,
    blurb: 'Slow, armoured and hits like a landslide. Break its rhythm, not its face.',
  }),

  slinger: ed({
    kind: 'slinger', name: 'Blight Slinger', role: 'ranged', locomotion: 'ground',
    maxHealth: 42, speed: 3.2, detectRange: 30, loseRange: 50,
    radius: 0.5, height: 1.6, knockbackResist: 0.15, energyDrop: 14, standoff: 13,
    attacks: [atk({
      id: 'lob', telegraph: 0.75, recovery: 0.4, range: 22, damage: 12,
      cooldown: 2.8, shape: 'projectile', markerRadius: 2.4, knockback: 4, needsToken: false,
      applies: { status: 'corrupted', seconds: 4 },
    })],
    resistance: Object.freeze({ air: 1.2, water: 1.0, earth: 1.0, fire: 1.05 }),
    accent: 0x9be36b, body: 0x3a4a2c, threat: 1.6,
    blurb: 'Backs away and lobs corruption in a high arc. The marker shows where it lands.',
  }),

  burrower: ed({
    kind: 'burrower', name: 'Rift Burrower', role: 'ambush', locomotion: 'burrow',
    maxHealth: 54, speed: 5.2, detectRange: 30, loseRange: 55,
    radius: 0.6, height: 1.2, knockbackResist: 0.35, energyDrop: 18, standoff: 0,
    attacks: [atk({
      id: 'erupt', telegraph: 1.05, recovery: 0.8, range: 2.6, damage: 18,
      cooldown: 4.5, shape: 'area', markerRadius: 2.8, knockback: 9, needsToken: true,
    })],
    resistance: Object.freeze({ air: 1.1, water: 1.15, earth: 0.7, fire: 1.0 }),
    accent: 0xffd66b, body: 0x53381f, threat: 2.2, unlock: 'enemy-burrower',
    blurb: 'Travels underground. A churning mound of soil is your only warning.',
  }),

  warden: ed({
    kind: 'warden', name: 'Blight Warden', role: 'summon', locomotion: 'ground',
    maxHealth: 70, speed: 2.4, detectRange: 32, loseRange: 55,
    radius: 0.6, height: 2.0, knockbackResist: 0.2, energyDrop: 26, standoff: 16,
    attacks: [atk({
      id: 'summon', telegraph: 1.4, recovery: 1.0, range: 30, damage: 0,
      cooldown: 9, shape: 'area', markerRadius: 0, knockback: 0, needsToken: false,
    })],
    resistance: Object.freeze({ air: 1.15, water: 1.0, earth: 1.0, fire: 1.1 }),
    accent: 0xc07bff, body: 0x2e1c45, threat: 2.6, unlock: 'enemy-summoner',
    blurb: 'Hangs back and calls crawlers out of the blight. Kill it first.',
  }),

  mender: ed({
    kind: 'mender', name: 'Blight Mender', role: 'support', locomotion: 'hover',
    maxHealth: 48, speed: 3.4, detectRange: 30, loseRange: 52,
    radius: 0.5, height: 1.5, knockbackResist: 0.1, energyDrop: 22, standoff: 11,
    attacks: [atk({
      id: 'mend', telegraph: 0.9, recovery: 0.5, range: 14, damage: 0,
      cooldown: 4.5, shape: 'area', markerRadius: 0, knockback: 0, needsToken: false,
    })],
    resistance: Object.freeze({ air: 1.25, water: 1.0, earth: 0.95, fire: 1.15 }),
    accent: 0x63e6d2, body: 0x1f4a48, threat: 2.4,
    blurb: 'Stitches its allies back together and flees from you. Cut the thread.',
  }),

  sapper: ed({
    kind: 'sapper', name: 'Rift Sapper', role: 'suicide', locomotion: 'ground',
    maxHealth: 30, speed: 4.6, detectRange: 26, loseRange: 46,
    radius: 0.55, height: 1.1, knockbackResist: 0.1, energyDrop: 16, standoff: 0,
    attacks: [atk({
      id: 'detonate', telegraph: 1.15, recovery: 0, range: 3.4, damage: 30,
      cooldown: 99, shape: 'area', markerRadius: 4.2, knockback: 14, needsToken: false,
    })],
    resistance: Object.freeze({ air: 1.2, water: 1.0, earth: 1.0, fire: 1.3 }),
    accent: 0xff6b3a, body: 0x5a2418, threat: 2,
    blurb: 'Runs at you, swells, and bursts. Push it away or put it down early.',
  }),

  bulwark: ed({
    kind: 'bulwark', name: 'Blight Bulwark', role: 'tank', locomotion: 'ground',
    maxHealth: 95, speed: 2.6, detectRange: 26, loseRange: 46,
    radius: 0.7, height: 2.0, knockbackResist: 0.6, energyDrop: 22, standoff: 0,
    attacks: [atk({
      id: 'shieldbash', telegraph: 0.7, recovery: 0.55, range: 2.8, damage: 15,
      cooldown: 2.4, shape: 'melee', markerRadius: 2.6, knockback: 10, needsToken: true,
      applies: { status: 'stunned', seconds: 0.8 },
    })],
    resistance: Object.freeze({ air: 0.85, water: 1.05, earth: 1.0, fire: 1.0 }),
    accent: 0x8fd4ff, body: 0x2f3f55, threat: 2.8,
    blurb: 'Carries a frontal shield. Hit it from the side, or shatter the guard.',
  }),

  guardian: ed({
    kind: 'guardian', name: 'Shrine Guardian', role: 'boss', locomotion: 'ground',
    maxHealth: 460, speed: 2.8, detectRange: 34, loseRange: 70,
    radius: 1.1, height: 4.0, knockbackResist: 0.9, energyDrop: 60, standoff: 0,
    attacks: [
      atk({
        id: 'sweep', telegraph: 0.75, recovery: 0.55, range: 3.8, damage: 20,
        cooldown: 1.9, shape: 'melee', markerRadius: 3.8, knockback: 9, needsToken: false,
      }),
      atk({
        id: 'shockwave', telegraph: 1.0, recovery: 0.8, range: 8, damage: 16,
        cooldown: 3.2, shape: 'area', markerRadius: 7.5, knockback: 11, needsToken: false,
      }),
      atk({
        id: 'volley', telegraph: 0.85, recovery: 0.5, range: 30, damage: 13,
        cooldown: 3.6, shape: 'projectile', markerRadius: 0, knockback: 6, needsToken: false,
      }),
    ],
    resistance: NEUTRAL,
    accent: 0xb96bff, body: 0x3a2352, threat: 10,
    blurb: 'Wakes when you near its shrine. Three attacks, all of them readable.',
  }),

  'boss-maw': ed({
    kind: 'boss-maw', name: 'The Sundering Maw', role: 'boss', locomotion: 'ground',
    maxHealth: 1500, speed: 2.9, detectRange: 55, loseRange: 200,
    radius: 1.8, height: 5.2, knockbackResist: 0.95, energyDrop: 200, standoff: 0,
    attacks: [
      atk({
        id: 'slam', telegraph: 1.1, recovery: 0.8, range: 6.5, damage: 26,
        cooldown: 3.4, shape: 'area', markerRadius: 7, knockback: 16, needsToken: false,
      }),
      atk({
        id: 'volley', telegraph: 0.9, recovery: 0.6, range: 40, damage: 15,
        cooldown: 4.2, shape: 'projectile', markerRadius: 0, knockback: 6, needsToken: false,
      }),
      atk({
        id: 'sweepwave', telegraph: 1.35, recovery: 1.0, range: 18, damage: 22,
        cooldown: 6.5, shape: 'cone', markerRadius: 14, knockback: 13, needsToken: false,
        applies: { status: 'weakened', seconds: 5 },
      }),
    ],
    resistance: NEUTRAL,
    accent: 0xff8a2a, body: 0x2a1636, threat: 20,
    blurb: 'A mouth in the world. It rewrites the ground you fight on.',
  }),
});

export const ENEMY_KINDS: readonly EnemyKind[] = Object.freeze(
  Object.keys(ENEMY_TYPES) as EnemyKind[],
);

export function enemyType(kind: EnemyKind): EnemyTypeDef {
  return ENEMY_TYPES[kind];
}

// =====================================================================
//  Elite modifiers
// =====================================================================

export type EliteId =
  | 'armored' | 'swift' | 'regenerating' | 'volatile'
  | 'splitting' | 'shielded' | 'vampiric' | 'corrupted';

export interface EliteDef {
  readonly id: EliteId;
  readonly name: string;
  readonly description: string;
  readonly color: number;
  /** Multipliers applied on top of the base type. */
  readonly healthScale: number;
  readonly speedScale: number;
  readonly damageScale: number;
  /** Extra reward weight when it dies. */
  readonly rewardBonus: number;
  /** Roles this modifier must never be applied to. */
  readonly forbidRoles?: readonly EnemyRole[];
  /** Modifiers that must not be combined with this one. */
  readonly conflicts?: readonly EliteId[];
}

function el(d: EliteDef): EliteDef {
  return Object.freeze(d);
}

export const ELITE_MODIFIERS: Readonly<Record<EliteId, EliteDef>> = Object.freeze({
  armored: el({
    id: 'armored', name: 'Armored', color: 0x9aa6bb,
    description: 'Plated hide: takes far less damage until the plates are broken.',
    healthScale: 1.5, speedScale: 0.9, damageScale: 1, rewardBonus: 1,
    conflicts: ['shielded'],
  }),
  swift: el({
    id: 'swift', name: 'Swift', color: 0x8fe3ff,
    description: 'Moves and attacks noticeably faster.',
    healthScale: 0.85, speedScale: 1.55, damageScale: 1, rewardBonus: 1,
    forbidRoles: ['tank'],
  }),
  regenerating: el({
    id: 'regenerating', name: 'Regenerating', color: 0x63e6d2,
    description: 'Knits itself back together unless you keep the pressure on.',
    healthScale: 1.15, speedScale: 1, damageScale: 1, rewardBonus: 1,
    conflicts: ['vampiric'],
  }),
  volatile: el({
    id: 'volatile', name: 'Volatile', color: 0xff8a2a,
    description: 'Bursts violently when defeated.',
    healthScale: 1, speedScale: 1.05, damageScale: 1, rewardBonus: 1,
    forbidRoles: ['suicide', 'boss'],
  }),
  splitting: el({
    id: 'splitting', name: 'Splitting', color: 0xb6ff6b,
    description: 'Breaks into two smaller copies when it falls.',
    healthScale: 1.3, speedScale: 0.95, damageScale: 0.9, rewardBonus: 1.5,
    forbidRoles: ['boss', 'suicide', 'summon'],
    conflicts: ['volatile'],
  }),
  shielded: el({
    id: 'shielded', name: 'Shielded', color: 0x53a8ff,
    description: 'Carries a regenerating barrier that must be stripped first.',
    healthScale: 1.2, speedScale: 1, damageScale: 1, rewardBonus: 1.2,
    conflicts: ['armored'],
  }),
  vampiric: el({
    id: 'vampiric', name: 'Vampiric', color: 0xff5f6d,
    description: 'Heals itself from the damage it deals to you.',
    healthScale: 1.1, speedScale: 1.05, damageScale: 1.15, rewardBonus: 1.2,
    conflicts: ['regenerating'],
  }),
  corrupted: el({
    id: 'corrupted', name: 'Corrupted', color: 0xc07bff,
    description: 'Its hits smear blight across you, weakening your defences.',
    healthScale: 1.15, speedScale: 1, damageScale: 1.1, rewardBonus: 1.2,
  }),
});

export const ELITE_IDS: readonly EliteId[] = Object.freeze(
  Object.keys(ELITE_MODIFIERS) as EliteId[],
);

/** Would this combination produce an unfair or nonsensical creature? */
export function eliteAllowed(id: EliteId, kind: EnemyKind, existing: readonly EliteId[]): boolean {
  const def = ELITE_MODIFIERS[id];
  const type = ENEMY_TYPES[kind];
  if (existing.includes(id)) return false;
  if (def.forbidRoles?.includes(type.role)) return false;
  for (const other of existing) {
    if (def.conflicts?.includes(other)) return false;
    if (ELITE_MODIFIERS[other].conflicts?.includes(id)) return false;
  }
  // Never stack two "takes less damage" modifiers, whatever their names.
  const defensive: EliteId[] = ['armored', 'shielded'];
  if (defensive.includes(id) && existing.some((o) => defensive.includes(o))) return false;
  // A creature that is both very fast and very tough is not fun to fight.
  if (id === 'swift' && existing.includes('armored')) return false;
  return true;
}

/** Pick up to `count` compatible modifiers for an elite. */
export function rollElites(
  kind: EnemyKind,
  count: number,
  random: () => number = Math.random,
): EliteId[] {
  const chosen: EliteId[] = [];
  const pool = [...ELITE_IDS];
  let guard = 0;
  while (chosen.length < count && pool.length > 0 && guard++ < 40) {
    const i = Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length));
    const id = pool.splice(i, 1)[0]!;
    if (eliteAllowed(id, kind, chosen)) chosen.push(id);
  }
  return chosen;
}

export interface EliteStats {
  healthScale: number;
  speedScale: number;
  damageScale: number;
  rewardBonus: number;
}

export function eliteStats(ids: readonly EliteId[]): EliteStats {
  const out: EliteStats = { healthScale: 1, speedScale: 1, damageScale: 1, rewardBonus: 1 };
  for (const id of ids) {
    const def = ELITE_MODIFIERS[id];
    out.healthScale *= def.healthScale;
    out.speedScale *= def.speedScale;
    out.damageScale *= def.damageScale;
    out.rewardBonus *= def.rewardBonus;
  }
  // Hard ceilings so an unlucky roll can never produce something absurd.
  out.healthScale = Math.min(2.6, out.healthScale);
  out.speedScale = Math.min(1.7, out.speedScale);
  out.damageScale = Math.min(1.5, out.damageScale);
  return out;
}

/** Display name, e.g. "Swift Vampiric Corrupted Crawler". */
export function eliteName(kind: EnemyKind, ids: readonly EliteId[]): string {
  const base = ENEMY_TYPES[kind].name;
  if (ids.length === 0) return base;
  // Skip any prefix the base name already contains, so a corrupted creature
  // never ends up called a "Corrupted Corrupted Crawler".
  const lower = base.toLowerCase();
  const prefixes = ids
    .map((i) => ELITE_MODIFIERS[i].name)
    .filter((name) => !lower.includes(name.toLowerCase()));
  if (prefixes.length === 0) return `Elite ${base}`;
  return `${prefixes.join(' ')} ${base}`;
}
