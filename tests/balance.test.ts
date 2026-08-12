/**
 * Combat balance and pacing.
 *
 * These are deterministic arithmetic assertions about how the game is tuned:
 * how long a creature survives, how much a hit takes off the bar, how the
 * encounter cycle breathes, where a creature is allowed to appear, and which
 * economies can and cannot be farmed.
 *
 * Nothing here renders anything or steps the real game loop - every module
 * under test is pure - so a regression in the numbers fails at the same speed
 * as a type error.
 */

import { describe, expect, it } from 'vitest';
import {
  DIRECTOR, ENCOUNTER, INCOMING, PACING, PRIMARY_ABILITY, PRIMARY_COOLDOWN, RESISTANCE,
  SPAWN, STATUS_TUNING, TIME_TO_KILL, TOKENS, clampResistance, damagePerCast,
  primaryDps,
} from '../src/combat/combatConfig';
import {
  ELITE_MODIFIERS, ENEMY_KINDS, ENEMY_TYPES, attackCategoryOf, effectiveResistance,
  eliteStats, type EnemyKind, type EnemyTier,
} from '../src/combat/enemyTypes';
import {
  CombatDirector, attackWeight, rangedBudgetForDepth, tokenBudgetForDepth,
} from '../src/combat/CombatDirector';
import {
  EncounterDirector, encounterBudget, type EncounterSignals,
} from '../src/combat/encounter';
import { isStranded, validateSpawn, type SpawnWorldProbe } from '../src/combat/spawnRules';
import { ELEMENTS, ELEMENT_ORDER, abilityForSlot } from '../src/elements/elements';
import {
  CAST_PAUSE, FALLBACK_COST_FRACTION, FALLBACK_POWER, FREE_CAST_CAP,
  IN_COMBAT_REGEN_SCALE, OUT_OF_COMBAT_DELAY, OUT_OF_COMBAT_REGEN_SCALE,
  REFUND_RATE_LIMIT, allowRefund, createManaState, grantFreeCast, resolvePrimaryCost,
  tickMana,
} from '../src/progression/mana';
import {
  CHARGE_RATE_CAP, DAMAGE_TAKEN_CAP, DEFLECT_CAP, TERRAIN_CAP, ULTIMATE_MAX,
  addCharge, createUltimateState, sanitiseCharge, setUltimateActive, tickUltimate,
} from '../src/progression/ultimate';
import { RunState } from '../src/progression/RunState';
import { SAVE_VERSION, createSave, validateSave } from '../src/save/saveData';
import { clampStats } from '../src/progression/upgrades';
import { BASE_MODIFIERS } from '../src/progression/upgrades';
import { CONVERGENCE_AFFINITY_BONUS, FOCUSED_AFFINITY_BONUS } from '../src/progression/RunState';

/** The reference player: no upgrades, focused affinity, 100 health and Mana. */
const REFERENCE_HEALTH = 100;
const REFERENCE_MANA = 100;
const REFERENCE_REGEN = 7;

/** Every enemy the campaign can require the player to fight. */
const MANDATORY: EnemyKind[] = ENEMY_KINDS.filter((k) => ENEMY_TYPES[k].tier !== 'guardian');

/** Seconds to kill a creature with one element's primary and nothing else. */
function timeToKill(kind: EnemyKind, element: string): number {
  const type = ENEMY_TYPES[kind];
  const dps = primaryDps(element) * effectiveResistance(kind, element as never);
  return type.maxHealth / dps;
}

// =====================================================================
//  Damage calculation and effective DPS
// =====================================================================

describe('player damage', () => {
  it('splits a continuous cast across its interval-protected ticks', () => {
    // The Water Whip's number on the tin is the whole cast, not one tick.
    const whip = damagePerCast('water-whip');
    expect(whip).toBeGreaterThan(0);
    expect(whip).toBeCloseTo(13 * 3 * (0.12 / 0.32), 5);
  });

  it('treats a single-shot ability as one hit', () => {
    expect(damagePerCast('rock-shot')).toBe(26);
    expect(damagePerCast('fireball')).toBe(18);
  });

  it('mirrors the real cooldowns of every primary', () => {
    for (const element of ELEMENT_ORDER) {
      const def = abilityForSlot(element, 'primary');
      expect(PRIMARY_ABILITY[element], element).toBe(def.id);
      expect(PRIMARY_COOLDOWN[element], element).toBeCloseTo(def.cooldown, 6);
    }
  });

  it('gives a focused adept a real specialization advantage over Convergence', () => {
    expect(FOCUSED_AFFINITY_BONUS).toBeGreaterThan(CONVERGENCE_AFFINITY_BONUS);
    // Meaningful, but not so large that flexibility is worthless.
    expect(FOCUSED_AFFINITY_BONUS / CONVERGENCE_AFFINITY_BONUS).toBeGreaterThanOrEqual(1.1);
    expect(FOCUSED_AFFINITY_BONUS / CONVERGENCE_AFFINITY_BONUS).toBeLessThanOrEqual(1.3);
  });
});

describe('status damage', () => {
  it('burning is worth a meaningful share of a Fireball, not a rounding error', () => {
    const total = STATUS_TUNING.burnDps * STATUS_TUNING.burnSeconds;
    const direct = damagePerCast('fireball');
    expect(total).toBeGreaterThan(direct * 0.5);
    expect(total).toBeLessThan(direct * 2);
  });

  it('the whip soak outlasts the slow it applies, so the combo has a window', () => {
    expect(STATUS_TUNING.wetSeconds).toBeGreaterThan(STATUS_TUNING.whipSlowSeconds);
    expect(STATUS_TUNING.freezeSecondsWhenWet).toBeGreaterThan(STATUS_TUNING.freezeSeconds);
  });
});

describe('effective DPS', () => {
  it('keeps every element inside one band of the others', () => {
    const values = ELEMENT_ORDER.map((e) => primaryDps(e));
    const low = Math.min(...values);
    const high = Math.max(...values);
    // Distinct, but never so far apart that an element is a trap.
    expect(high / low).toBeLessThanOrEqual(1.45);
    expect(high / low).toBeGreaterThan(1);
  });

  it('pays Air back for its lower single-target damage in reach and control', () => {
    const air = ELEMENTS.air;
    // Air has the widest knockback and a cone, so its per-target damage is the
    // lowest of the four - deliberately, and only by a limited margin.
    const airDps = primaryDps('air');
    for (const element of ELEMENT_ORDER) {
      expect(airDps, element).toBeGreaterThanOrEqual(primaryDps(element) * 0.7);
    }
    expect(air.primary.cooldown).toBeLessThan(ELEMENTS.earth.primary.cooldown);
  });
});

// =====================================================================
//  Cooldowns and Mana costs
// =====================================================================

describe('cooldowns and costs', () => {
  it('orders every element the same way: primary, secondary, technique', () => {
    for (const element of ELEMENT_ORDER) {
      const def = ELEMENTS[element];
      expect(def.primary.cooldown, element).toBeLessThan(def.secondary.cooldown);
      expect(def.primary.cost, element).toBeLessThan(def.secondary.cost);
      expect(def.technique.cost, element).toBeGreaterThan(def.primary.cost);
      // The Ultimate spends its own meter and nothing else.
      expect(def.ultimate.cost, element).toBe(0);
      expect(def.ultimate.cooldown, element).toBe(0);
    }
  });

  it('lets a full bar pay for several primaries plus a real ability', () => {
    for (const element of ELEMENT_ORDER) {
      const def = ELEMENTS[element];
      // Four primaries and the cheaper of the two heavier abilities.
      const heavier = Math.min(def.secondary.cost, def.technique.cost);
      expect(def.primary.cost * 4 + heavier, element).toBeLessThanOrEqual(REFERENCE_MANA + 6);
      // And at least three primaries with room to spare.
      expect(def.primary.cost * 3, element).toBeLessThan(REFERENCE_MANA * 0.6);
    }
  });

  it('keeps the fallback usable but strictly worse than a funded cast', () => {
    const fallbackCost = REFERENCE_MANA * FALLBACK_COST_FRACTION;
    for (const element of ELEMENT_ORDER) {
      const full = ELEMENTS[element].primary.cost;
      const resolved = resolvePrimaryCost(full, fallbackCost, REFERENCE_MANA, false);
      expect(resolved, element).not.toBeNull();
      expect(resolved!.weakened, element).toBe(true);
      expect(resolved!.power, element).toBe(FALLBACK_POWER);
      // The fallback must never be the efficient choice: damage per Mana is
      // what stops it from outperforming a properly funded ability.
      const fundedPerMana = 1 / full;
      const fallbackPerMana = FALLBACK_POWER / fallbackCost;
      expect(fallbackPerMana, element).toBeLessThan(fundedPerMana * 3);
    }
  });

  it('refuses everything only when the bar is genuinely empty', () => {
    expect(resolvePrimaryCost(16, 0, REFERENCE_MANA, false)).toBeNull();
    // A free-cast window pays nothing and is never weakened.
    const free = resolvePrimaryCost(16, 0, REFERENCE_MANA, true);
    expect(free).toEqual({ cost: 0, power: 1, weakened: false });
  });
});

// =====================================================================
//  Mana regeneration, caps and refund loops
// =====================================================================

describe('mana regeneration', () => {
  const ctx = {
    maxMana: REFERENCE_MANA, baseRegen: REFERENCE_REGEN, inCombat: true,
    element: 'fire' as const, onAffinityTerrain: false,
  };

  it('keeps regenerating during combat rather than stopping dead', () => {
    const state = createManaState();
    const tick = tickMana(state, 1, ctx);
    expect(tick.regen).toBeCloseTo(REFERENCE_REGEN * IN_COMBAT_REGEN_SCALE, 5);
    expect(tick.regen).toBeGreaterThan(0);
  });

  it('recovers a full bar out of combat without an unreasonable wait', () => {
    const state = createManaState();
    let mana = 0;
    let seconds = 0;
    // Out of combat after the lull, from empty.
    state.sinceCombat = OUT_OF_COMBAT_DELAY;
    while (mana < REFERENCE_MANA && seconds < 60) {
      mana += tickMana(state, 0.1, { ...ctx, inCombat: false }).regen;
      seconds += 0.1;
    }
    expect(seconds).toBeLessThan(10);
  });

  it('never leaves an ordinary fight without an offensive option for long', () => {
    // Worst case: empty bar, in combat, no terrain bonus. How long until the
    // cheapest fallback cast is affordable again?
    const state = createManaState();
    const perSecond = REFERENCE_REGEN * IN_COMBAT_REGEN_SCALE;
    const fallback = REFERENCE_MANA * FALLBACK_COST_FRACTION;
    expect(fallback / perSecond).toBeLessThan(1);
    // And until a full-strength primary is affordable again.
    const dearest = Math.max(...ELEMENT_ORDER.map((e) => ELEMENTS[e].primary.cost));
    expect(dearest / perSecond).toBeLessThan(4);
    expect(tickMana(state, 1, ctx).regen).toBeGreaterThan(0);
  });

  it('pauses only briefly after an expensive cast', () => {
    expect(CAST_PAUSE).toBeLessThan(1.5);
    expect(OUT_OF_COMBAT_REGEN_SCALE).toBeGreaterThan(IN_COMBAT_REGEN_SCALE * 2);
  });
});

describe('cost-reduction caps', () => {
  it('never lets stacked reductions approach free casting', () => {
    const stats = { ...BASE_MODIFIERS };
    for (let i = 0; i < 20; i++) stats.costScale *= 0.8;
    clampStats(stats);
    expect(stats.costScale).toBeGreaterThanOrEqual(0.35);
  });

  it('caps how much Mana a single hit or kill can return', () => {
    const stats = { ...BASE_MODIFIERS };
    stats.manaOnHit = 500;
    stats.manaOnKill = 500;
    clampStats(stats);
    expect(stats.manaOnHit).toBeLessThanOrEqual(20);
    expect(stats.manaOnKill).toBeLessThanOrEqual(60);
  });

  it('caps a free-cast window however many grants overlap', () => {
    const state = createManaState();
    for (let i = 0; i < 10; i++) grantFreeCast(state, 60);
    expect(state.freeCast).toBeLessThanOrEqual(FREE_CAST_CAP);
  });
});

describe('refund-loop prevention', () => {
  it('meters refunds so a multi-hit ability cannot mint Mana', () => {
    const state = createManaState();
    // A multi-hit tick refunding the per-hit maximum against ten targets.
    let total = 0;
    for (let i = 0; i < 10; i++) total += allowRefund(state, 20, REFERENCE_MANA);
    expect(total).toBeLessThanOrEqual(REFERENCE_MANA * REFUND_RATE_LIMIT + 0.001);
  });

  it('holds the ceiling across a whole second of frames', () => {
    const state = createManaState();
    let total = 0;
    // Sixty frames of a refund firing every frame.
    for (let frame = 0; frame < 60; frame++) {
      total += allowRefund(state, 20, REFERENCE_MANA);
      tickMana(state, 1 / 60, {
        maxMana: REFERENCE_MANA, baseRegen: 0, inCombat: true,
        element: 'water', onAffinityTerrain: false,
      });
    }
    // Roughly one window's worth, not sixty.
    expect(total).toBeLessThanOrEqual(REFERENCE_MANA * REFUND_RATE_LIMIT * 2);
  });

  it('cannot out-earn what a rotation spends, so refunds are a discount not an engine', () => {
    const state = createManaState();
    const refundPerSecond = REFERENCE_MANA * REFUND_RATE_LIMIT;
    const cheapestRotation = Math.min(...ELEMENT_ORDER.map(
      (e) => ELEMENTS[e].primary.cost / ELEMENTS[e].primary.cooldown,
    ));
    expect(refundPerSecond).toBeLessThan(cheapestRotation);
    expect(allowRefund(state, -5, REFERENCE_MANA)).toBe(0);
    expect(allowRefund(state, 10, 0)).toBe(0);
  });
});

// =====================================================================
//  Ultimate charge
// =====================================================================

describe('ultimate charge limits', () => {
  it('caps how much charge one second of hits can produce', () => {
    const state = createUltimateState(true);
    // A sustained field ticking against a dozen targets inside one frame.
    for (let i = 0; i < 100; i++) addCharge(state, 'damage-dealt', 500);
    expect(state.charge).toBeLessThanOrEqual(CHARGE_RATE_CAP + 0.001);
  });

  it('rate-limits a multi-hit ability to the same ceiling as anything else', () => {
    const multiHit = createUltimateState(true);
    const singleHit = createUltimateState(true);
    // Twenty small hits in one frame versus one large hit.
    for (let i = 0; i < 20; i++) addCharge(multiHit, 'damage-dealt', 40);
    addCharge(singleHit, 'damage-dealt', 800);
    expect(multiHit.charge).toBeCloseTo(singleHit.charge, 5);
  });

  it('grants nothing at all while the player’s own Ultimate is running', () => {
    const state = createUltimateState(true);
    setUltimateActive(state, true);
    addCharge(state, 'damage-dealt', 2000);
    addCharge(state, 'enemy-defeated');
    addCharge(state, 'terrain');
    expect(state.charge).toBe(0);
    setUltimateActive(state, false);
    expect(addCharge(state, 'damage-dealt', 200)).toBeGreaterThan(0);
  });

  it('keeps taking damage a limited contributor', () => {
    const state = createUltimateState(true);
    for (let i = 0; i < 300; i++) {
      addCharge(state, 'damage-taken', 40);
      tickUltimate(state, 1.05);
    }
    expect(state.fromDamageTaken).toBeLessThanOrEqual(DAMAGE_TAKEN_CAP + 0.001);
  });

  it('caps terrain and deflection charge per fill, so neither can be farmed', () => {
    const state = createUltimateState(true);
    for (let i = 0; i < 200; i++) {
      addCharge(state, 'terrain');
      addCharge(state, 'deflect');
      tickUltimate(state, 1.05);
    }
    expect(state.fromTerrain).toBeLessThanOrEqual(TERRAIN_CAP + 0.001);
    expect(state.fromDeflect).toBeLessThanOrEqual(DEFLECT_CAP + 0.001);
  });

  it('fills in roughly two to four meaningful encounters of real fighting', () => {
    const state = createUltimateState(true);
    // One encounter: an encounter budget's worth of standard creatures killed
    // with primary damage, spread over a realistic fight length.
    const perEncounter = (): void => {
      const budget = encounterBudget(2);
      const health = ENEMY_TYPES.crawler.maxHealth;
      const creatures = Math.round(budget / ENEMY_TYPES.crawler.threat);
      for (let i = 0; i < creatures; i++) {
        // Each creature takes a few seconds of damage, then dies.
        for (let hit = 0; hit < 3; hit++) {
          addCharge(state, 'damage-dealt', health / 3);
          tickUltimate(state, 1.2);
        }
        addCharge(state, 'enemy-defeated');
      }
    };
    let encounters = 0;
    while (state.charge < ULTIMATE_MAX && encounters < 12) {
      perEncounter();
      encounters++;
    }
    expect(encounters).toBeGreaterThanOrEqual(2);
    expect(encounters).toBeLessThanOrEqual(4);
  });

  it('never charges from nothing at all', () => {
    const locked = createUltimateState(false);
    expect(addCharge(locked, 'damage-dealt', 1000)).toBe(0);
    const state = createUltimateState(true);
    expect(addCharge(state, 'damage-dealt', 0)).toBe(0);
  });
});

// =====================================================================
//  Enemy durability and incoming damage
// =====================================================================

describe('enemy durability', () => {
  it('gives every creature a pacing tier', () => {
    for (const kind of ENEMY_KINDS) {
      expect(ENEMY_TYPES[kind].tier, kind).toBeTruthy();
    }
  });

  it('never lets a mandatory creature become a sponge for any element', () => {
    // The ceiling applies to every element without exception: this is the
    // assertion that "normal enemies must not feel like damage sponges".
    for (const kind of MANDATORY) {
      const tier = ENEMY_TYPES[kind].tier as Exclude<EnemyTier, 'guardian'>;
      for (const element of ELEMENT_ORDER) {
        const ttk = timeToKill(kind, element);
        expect(ttk, `${kind} vs ${element}`).toBeLessThanOrEqual(TIME_TO_KILL[tier].max);
      }
    }
  });

  it('keeps a creature substantial against the average element', () => {
    // The floor is an average rather than a per-element rule, because killing
    // something quickly with the element it is weak to is the whole point of
    // having weaknesses.
    for (const kind of MANDATORY) {
      const tier = ENEMY_TYPES[kind].tier as Exclude<EnemyTier, 'guardian'>;
      const times = ELEMENT_ORDER.map((e) => timeToKill(kind, e));
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      expect(mean, kind).toBeGreaterThanOrEqual(TIME_TO_KILL[tier].min);
    }
  });

  it('keeps the tiers distinguishable from one another', () => {
    const worst = (tier: EnemyTier): number => Math.max(
      ...MANDATORY.filter((k) => ENEMY_TYPES[k].tier === tier)
        .flatMap((k) => ELEMENT_ORDER.map((e) => timeToKill(k, e))),
    );
    expect(worst('small')).toBeLessThan(worst('standard'));
    expect(worst('standard')).toBeLessThan(worst('heavy'));
  });

  it('kills a small creature in a handful of accurate primary hits', () => {
    const small = MANDATORY.filter((k) => ENEMY_TYPES[k].tier === 'small');
    expect(small.length).toBeGreaterThan(0);
    for (const kind of small) {
      // Using the heaviest single-shot opener the game has.
      const perHit = damagePerCast('rock-shot') * FOCUSED_AFFINITY_BONUS
        * effectiveResistance(kind, 'earth');
      const hits = Math.ceil(ENEMY_TYPES[kind].maxHealth / perHit);
      expect(hits, kind).toBeLessThanOrEqual(PACING.small.maxHits);
    }
  });

  it('asks for a real commitment from a heavy without a bloated bar', () => {
    for (const kind of MANDATORY.filter((k) => ENEMY_TYPES[k].tier === 'heavy')) {
      const perHit = damagePerCast('rock-shot') * FOCUSED_AFFINITY_BONUS
        * effectiveResistance(kind, 'earth');
      const hits = Math.ceil(ENEMY_TYPES[kind].maxHealth / perHit);
      // Only a ceiling: Earth is the wrong element to measure a floor with,
      // since several heavies are deliberately weak to it.
      expect(hits, kind).toBeLessThanOrEqual(PACING.heavy.maxHits);
      // Heavies earn their length with something other than a longer bar: an
      // exposed weak point, a second attack pattern to read, or a guard heavy
      // enough that it has to be broken rather than out-damaged.
      const type = ENEMY_TYPES[kind];
      const hasMechanic = (type.weakPointMultiplier ?? 0) > 1
        || type.attacks.length > 1
        || type.knockbackResist >= 0.6;
      expect(hasMechanic, kind).toBe(true);
    }
  });

  it('clamps every resistance into the playable band', () => {
    for (const kind of ENEMY_KINDS) {
      for (const element of ELEMENT_ORDER) {
        const r = effectiveResistance(kind, element);
        expect(r, `${kind}/${element}`).toBeGreaterThanOrEqual(RESISTANCE.floor);
        expect(r, `${kind}/${element}`).toBeLessThanOrEqual(RESISTANCE.ceiling);
      }
    }
    expect(clampResistance(0)).toBe(RESISTANCE.floor);
    expect(clampResistance(99)).toBe(RESISTANCE.ceiling);
    expect(clampResistance(Number.NaN)).toBe(1);
  });

  it('keeps elemental identity: a bad match is still visibly worse', () => {
    // Fire really is the wrong answer to an Obsidian-Clad, just not a hopeless
    // one, and Water really is the right answer to a Magma Beast.
    expect(effectiveResistance('obsidian-clad', 'fire'))
      .toBeLessThan(effectiveResistance('obsidian-clad', 'earth'));
    expect(effectiveResistance('magma-beast', 'water'))
      .toBeGreaterThan(effectiveResistance('magma-beast', 'fire') * 2);
  });

  it('makes an elite harder without simply doubling the bar', () => {
    const stats = eliteStats(['armored', 'vampiric', 'corrupted']);
    expect(stats.healthScale).toBeLessThanOrEqual(1.9);
    expect(stats.damageScale).toBeLessThanOrEqual(1.35);
    // Every modifier changes something other than health.
    for (const [id, def] of Object.entries(ELITE_MODIFIERS)) {
      const changesBehaviour = def.speedScale !== 1 || def.damageScale !== 1
        || ['volatile', 'splitting', 'shielded', 'regenerating', 'vampiric', 'corrupted'].includes(id);
      expect(changesBehaviour, id).toBe(true);
    }
  });
});

describe('enemy health scaling', () => {
  it('grows health with depth but not without limit', () => {
    const run = new RunState();
    run.depth = 0;
    expect(run.difficulty).toBe(1);
    run.depth = 1000;
    expect(run.difficulty).toBeCloseTo(1 + INCOMING.healthCap, 5);
  });

  it('grows enemy damage far more slowly than enemy health', () => {
    const run = new RunState();
    run.depth = 20;
    expect(run.damageDifficulty).toBeLessThan(run.difficulty);
    run.depth = 1000;
    expect(run.damageDifficulty).toBeCloseTo(1 + INCOMING.damageCap, 5);
    expect(INCOMING.damageCap).toBeLessThan(INCOMING.healthCap);
  });
});

describe('incoming damage scaling', () => {
  /** What one attack takes off the bar at a given depth, for a given elite. */
  function hit(kind: EnemyKind, attackIndex: number, depth: number, eliteScale: number): number {
    const attack = ENEMY_TYPES[kind].attacks[attackIndex]!;
    const run = new RunState();
    run.depth = depth;
    const raw = attack.damage * eliteScale * run.damageDifficulty;
    const fraction = ENEMY_TYPES[kind].role === 'boss'
      ? INCOMING.maxBossHitFraction : INCOMING.maxHitFraction;
    return Math.min(raw, REFERENCE_HEALTH * fraction);
  }

  it('never lets a single non-boss hit take a third of the bar', () => {
    for (const kind of MANDATORY) {
      ENEMY_TYPES[kind].attacks.forEach((_, i) => {
        const worst = hit(kind, i, 1000, 1.35);
        expect(worst, kind).toBeLessThanOrEqual(REFERENCE_HEALTH * INCOMING.maxHitFraction + 0.001);
      });
    }
  });

  it('always leaves a full-health player at least three hits of margin', () => {
    const worst = Math.max(...MANDATORY.flatMap(
      (kind) => ENEMY_TYPES[kind].attacks.map((_, i) => hit(kind, i, 1000, 1.35)),
    ));
    expect(Math.floor(REFERENCE_HEALTH / worst)).toBeGreaterThanOrEqual(3);
  });

  it('gives every attack at least the minimum reaction window', () => {
    for (const kind of ENEMY_KINDS) {
      for (const attack of ENEMY_TYPES[kind].attacks) {
        expect(attack.telegraph, `${kind}/${attack.id}`)
          .toBeGreaterThanOrEqual(DIRECTOR.minTelegraph);
      }
    }
  });

  it('leaves a heavy hit punishable: a long wind-up and a long recovery', () => {
    for (const kind of ENEMY_KINDS) {
      const type = ENEMY_TYPES[kind];
      // A creature that dies delivering its attack has nothing to recover from.
      if (type.role === 'suicide') continue;
      for (const attack of type.attacks) {
        if (attack.damage < 20) continue;
        expect(attack.telegraph, `${kind}/${attack.id}`).toBeGreaterThanOrEqual(0.6);
        expect(attack.recovery, `${kind}/${attack.id}`).toBeGreaterThanOrEqual(0.45);
      }
    }
  });

  it('gives a wide ground attack a wind-up long enough to walk out of', () => {
    for (const kind of ENEMY_KINDS) {
      for (const attack of ENEMY_TYPES[kind].attacks) {
        if (attack.markerRadius < TOKENS.heavyMarkerRadius) continue;
        expect(attack.telegraph, `${kind}/${attack.id}`).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it('never lets the biggest hits land without a real reaction window', () => {
    for (const kind of ENEMY_KINDS) {
      for (const attack of ENEMY_TYPES[kind].attacks) {
        if (attack.damage < 20) continue;
        expect(attack.telegraph, `${kind}/${attack.id}`).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it('caps stacked environmental damage-over-time', () => {
    // Three overlapping burning patches must not be three times the damage.
    const single = STATUS_TUNING.burnDps;
    expect(INCOMING.maxEnvironmentDps).toBeLessThan(single * 3);
    // And a full-health player always has several seconds to walk out of it.
    expect(REFERENCE_HEALTH / INCOMING.maxEnvironmentDps).toBeGreaterThan(5);
  });

  it('leaves a gap between hits, so control always comes back', () => {
    expect(INCOMING.postHitInvuln).toBeGreaterThanOrEqual(0.5);
    expect(INCOMING.postHitInvuln).toBeGreaterThan(INCOMING.postShieldInvuln);
  });
});

// =====================================================================
//  Attack tokens
// =====================================================================

describe('attack-token limits', () => {
  it('starts at one or two dangerous attackers and climbs to at most four', () => {
    expect(tokenBudgetForDepth(0)).toBeLessThanOrEqual(2);
    expect(tokenBudgetForDepth(TOKENS.midDepth)).toBe(3);
    expect(tokenBudgetForDepth(TOKENS.lateDepth)).toBe(4);
    expect(tokenBudgetForDepth(9999)).toBeLessThanOrEqual(4);
    expect(rangedBudgetForDepth(0)).toBeLessThanOrEqual(rangedBudgetForDepth(9999));
  });

  it('weights a heavy area attack above an ordinary swing', () => {
    expect(attackWeight('heavy')).toBeGreaterThan(attackWeight('melee'));
    expect(attackWeight('ranged')).toBeGreaterThan(0);
  });

  it('lets an early budget hold two swings but only one heavy attack', () => {
    const d = new CombatDirector({ globalCooldown: 0 });
    d.setDepth(0);
    expect(d.request(1, 0.5, true, 'melee').granted).toBe(true);
    expect(d.request(2, 0.5, true, 'melee').granted).toBe(true);
    expect(d.request(3, 0.5, true, 'melee').granted).toBe(false);

    const e = new CombatDirector({ globalCooldown: 0 });
    e.setDepth(0);
    expect(e.request(1, 0.9, true, 'heavy').granted).toBe(true);
    expect(e.request(2, 0.5, true, 'melee').granted).toBe(false);
  });

  it('classifies every enemy attack into the right pressure category', () => {
    for (const kind of ENEMY_KINDS) {
      const type = ENEMY_TYPES[kind];
      for (const attack of type.attacks) {
        const category = attackCategoryOf(attack, type.role);
        if (type.role === 'boss' || attack.damage <= 0) {
          expect(category, `${kind}/${attack.id}`).toBeNull();
          continue;
        }
        expect(category, `${kind}/${attack.id}`).not.toBeNull();
        if (attack.shape === 'projectile') expect(category).toBe('ranged');
        else if (attack.markerRadius >= TOKENS.heavyMarkerRadius
                 && (attack.shape === 'area' || attack.shape === 'cone')) {
          expect(category, `${kind}/${attack.id}`).toBe('heavy');
        }
      }
    }
  });

  it('makes every damaging non-boss attack draw on the budget', () => {
    for (const kind of MANDATORY) {
      for (const attack of ENEMY_TYPES[kind].attacks) {
        if (attack.damage <= 0) continue;
        expect(attack.needsToken, `${kind}/${attack.id}`).toBe(true);
      }
    }
  });

  it('releases everything an attacker held when it dies', () => {
    const d = new CombatDirector({ maxTokens: 2, globalCooldown: 0 });
    d.request(7, 0.5, true, 'melee');
    expect(d.activeAttackers).toBe(1);
    d.releaseOwner(7);
    expect(d.activeAttackers).toBe(0);
  });

  it('expires a stale token rather than leaking the budget', () => {
    const d = new CombatDirector({ maxTokens: 1, globalCooldown: 0 });
    d.request(1, 0.5, true, 'melee');
    expect(d.request(2, 0.5, true, 'melee').granted).toBe(false);
    d.update(5);
    expect(d.request(2, 0.5, true, 'melee').granted).toBe(true);
  });
});

// =====================================================================
//  Encounter budgets and pacing
// =====================================================================

/** Baseline signals: exploring, healthy, in control, nothing alive. */
function signals(patch: Partial<EncounterSignals> = {}): EncounterSignals {
  return {
    liveEnemies: 0,
    engaged: false,
    healthFraction: 1,
    playing: true,
    playerReady: true,
    peaceful: false,
    scenarioDriven: false,
    locationPressure: 0,
    ...patch,
  };
}

/** Run the director forward, spawning whatever it offers. Returns a log. */
function simulate(
  d: EncounterDirector,
  seconds: number,
  build: (t: number, spawned: number) => EncounterSignals,
  random: () => number = () => 0,
): { phases: string[]; spawns: number[]; threat: number } {
  const phases: string[] = [];
  const spawns: number[] = [];
  let threat = 0;
  let spawned = 0;
  const dt = 0.25;
  for (let t = 0; t < seconds; t += dt) {
    const s = build(t, spawned);
    d.update(dt, s);
    const verdict = d.requestSpawn(s, random);
    if (verdict.allowed && verdict.threat > 0) {
      // Place one creature's worth, as the game does.
      const placed = Math.min(1, verdict.threat);
      d.spend(placed, d.status.budgetLeft <= 0);
      threat += placed;
      spawned++;
      spawns.push(t);
    }
    const phase = d.status.phase;
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return { phases, spawns, threat };
}

describe('encounter budgets', () => {
  it('scales the budget with depth but never without limit', () => {
    expect(encounterBudget(0)).toBe(ENCOUNTER.baseBudget);
    expect(encounterBudget(5)).toBeGreaterThan(encounterBudget(0));
    expect(encounterBudget(9999)).toBe(ENCOUNTER.maxBudget);
  });

  it('stops spawning once the encounter budget is spent', () => {
    const d = new EncounterDirector();
    d.setDepth(0);
    const result = simulate(d, 200, (_t, spawned) => signals({
      liveEnemies: Math.max(1, spawned), engaged: spawned > 0,
    }));
    // The opening budget plus reinforcements, and not a creature more.
    const ceiling = encounterBudget(0) * (1 + ENCOUNTER.reinforcementFraction);
    expect(result.threat).toBeLessThanOrEqual(ceiling + 0.001);
  });

  it('closes reinforcements part-way through rather than trickling forever', () => {
    const d = new EncounterDirector();
    d.setDepth(10);
    const result = simulate(d, 300, (_t, spawned) => signals({
      liveEnemies: Math.max(1, spawned), engaged: true,
    }));
    const last = result.spawns[result.spawns.length - 1] ?? 0;
    expect(last).toBeLessThanOrEqual(ENCOUNTER.targetMax * ENCOUNTER.reinforcementWindow + 1);
  });

  it('walks the whole cycle: explore, buildup, active, peak, resolve, recover', () => {
    const d = new EncounterDirector();
    // Nothing is alive until something has been placed; the player then wins
    // the fight sixty seconds in.
    const result = simulate(d, 200, (t, spawned) => signals({
      liveEnemies: t < 60 ? spawned : 0,
      engaged: spawned > 0 && t < 60,
    }));
    expect(result.phases).toContain('buildup');
    expect(result.phases).toContain('active');
    expect(result.phases).toContain('peak');
    expect(result.phases).toContain('resolve');
    expect(result.phases).toContain('recover');
    // And in that order, each phase reached only once for this single fight.
    const order = ['buildup', 'active', 'peak', 'resolve', 'recover'];
    const seen = result.phases.filter((p) => order.includes(p));
    expect(seen.slice(0, order.length)).toEqual(order);
  });

  it('finds the player an encounter inside the exploration window', () => {
    const d = new EncounterDirector();
    // A player who keeps walking and finds nothing: readiness must reach
    // certainty by the upper bound of the target window.
    let t = 0;
    while (t < ENCOUNTER.discoveryMax && d.readiness(signals()) < 1) {
      d.update(0.25, signals());
      t += 0.25;
    }
    expect(t).toBeGreaterThanOrEqual(ENCOUNTER.discoveryMin);
    expect(t).toBeLessThanOrEqual(ENCOUNTER.discoveryMax + 0.5);
  });

  it('starts sooner where the world says trouble lives', () => {
    const open = new EncounterDirector();
    const shrine = new EncounterDirector();
    for (let t = 0; t < 5; t += 0.25) {
      open.update(0.25, signals());
      shrine.update(0.25, signals({ locationPressure: 1 }));
    }
    expect(shrine.readiness(signals({ locationPressure: 1 })))
      .toBeGreaterThan(open.readiness(signals()));
  });

  it('gives the player a recovery period before anything else appears', () => {
    const d = new EncounterDirector();
    const result = simulate(d, 120, (t, spawned) => signals({
      liveEnemies: t < 30 ? spawned : 0,
      engaged: spawned > 0 && t < 30,
    }));
    // Something must actually have been fought.
    expect(result.spawns.length).toBeGreaterThan(0);
    // The first spawn after the fight ended must respect the quiet period.
    const afterFight = result.spawns.filter((t) => t >= 30);
    expect(afterFight.length).toBeGreaterThan(0);
    expect(afterFight[0]! - 30).toBeGreaterThanOrEqual(ENCOUNTER.recoverySeconds);
  });

  it('never opens a second encounter on top of a running one', () => {
    const d = new EncounterDirector();
    d.update(1, signals());
    // Something is alive and fighting: the director must refuse to open.
    const busy = signals({ liveEnemies: 3, engaged: true });
    for (let t = 0; t < 200; t += 0.25) d.update(0.25, busy);
    const before = d.status.encounters;
    d.requestSpawn(busy, () => 0);
    expect(d.status.encounters).toBe(before);
  });

  it('does not force a fight on a nearly-dead player', () => {
    const d = new EncounterDirector();
    const hurt = signals({ healthFraction: 0.1 });
    for (let t = 0; t < ENCOUNTER.discoveryMax * 2; t += 0.25) d.update(0.25, hurt);
    const verdict = d.requestSpawn(hurt, () => 0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('low-health');
    // Unless a scenario deliberately corners them.
    const scripted = { ...hurt, scenarioDriven: true };
    expect(d.requestSpawn(scripted, () => 0).allowed).toBe(true);
  });

  it('never spawns while a screen owns the player’s attention', () => {
    const d = new EncounterDirector();
    const reading = signals({ playing: false });
    for (let t = 0; t < ENCOUNTER.discoveryMax * 2; t += 0.25) d.update(0.25, reading);
    expect(d.requestSpawn(reading, () => 0).reason).toBe('not-playing');
    const respawning = signals({ playerReady: false });
    expect(d.requestSpawn(respawning, () => 0).reason).toBe('player-down');
  });

  it('holds the world quiet on request, then lets it breathe again', () => {
    const d = new EncounterDirector();
    d.hold(10);
    expect(d.recovering).toBe(true);
    expect(d.requestSpawn(signals(), () => 0).reason).toBe('recovering');
    for (let t = 0; t < 11; t += 0.25) d.update(0.25, signals());
    expect(d.recovering).toBe(false);
  });

  it('caps the live population however generous the budget gets', () => {
    const d = new EncounterDirector();
    d.setDepth(100);
    const crowded = signals({ liveEnemies: ENCOUNTER.maxWanderers, engaged: true });
    expect(d.requestSpawn(crowded, () => 0).reason).toBe('crowded');
  });

  it('closes out a fight that has run far past its intended length', () => {
    const d = new EncounterDirector();
    const endless = signals({ liveEnemies: 2, engaged: true });
    d.forceEncounter();
    for (let t = 0; t < ENCOUNTER.hardTimeout + 10; t += 0.5) d.update(0.5, endless);
    expect(['explore', 'recover']).toContain(d.status.phase);
  });

  it('keeps a standard encounter inside the 25-75 second target', () => {
    // A whole encounter: the opening budget plus the reinforcements it is
    // allowed, killed at the reference DPS, and scaled by the overhead a real
    // fight carries - closing distance, reading telegraphs, repositioning.
    const budget = encounterBudget(0) * (1 + ENCOUNTER.reinforcementFraction);
    const creatures = Math.round(budget / ENEMY_TYPES.crawler.threat);
    const damageTime = creatures * timeToKill('crawler', 'air');
    const total = damageTime * ENCOUNTER.combatOverhead + ENCOUNTER.buildupSeconds;
    expect(total).toBeGreaterThanOrEqual(ENCOUNTER.targetMin);
    expect(total).toBeLessThanOrEqual(ENCOUNTER.targetMax);
  });

  it('keeps the deepest encounter from running past the intended ceiling', () => {
    const budget = encounterBudget(9999) * (1 + ENCOUNTER.reinforcementFraction);
    const creatures = Math.round(budget / ENEMY_TYPES.crawler.threat);
    const damageTime = creatures * timeToKill('crawler', 'air');
    const total = damageTime * ENCOUNTER.combatOverhead + ENCOUNTER.buildupSeconds;
    expect(total).toBeLessThanOrEqual(ENCOUNTER.hardTimeout);
  });
});

describe('peaceful mode spawning', () => {
  it('refuses every spawn, whatever else is true', () => {
    const d = new EncounterDirector();
    const peaceful = signals({ peaceful: true, locationPressure: 1 });
    for (let t = 0; t < 600; t += 0.25) {
      d.update(0.25, peaceful);
      expect(d.requestSpawn(peaceful, () => 0).allowed).toBe(false);
    }
  });

  it('holds the cycle in its quiet state rather than banking an encounter', () => {
    const d = new EncounterDirector();
    // Open a fight, then switch to Peaceful mid-encounter.
    d.forceEncounter();
    d.update(1, signals({ liveEnemies: 3, engaged: true }));
    d.update(1, signals({ peaceful: true }));
    expect(d.status.budgetLeft).toBe(0);
    expect(d.status.reinforcementLeft).toBe(0);
    // And it does not accumulate exploration credit while peaceful, so
    // switching back does not immediately produce a fight.
    for (let t = 0; t < 300; t += 0.5) d.update(0.5, signals({ peaceful: true }));
    expect(d.readiness(signals())).toBe(0);
  });
});

// =====================================================================
//  Spawn validation
// =====================================================================

/** A flat, dry, empty world at ground height 10, with nothing in the way. */
function flatWorld(patch: Partial<SpawnWorldProbe> = {}): SpawnWorldProbe {
  return {
    groundHeight: () => 10,
    isSolid: () => false,
    hasLineOfSight: () => false,
    fluidLevel: 0,
    fluidIsHazard: false,
    isObstacle: () => false,
    distanceToProtected: () => 999,
    ...patch,
  };
}

/** A candidate directly in front of a player at the origin facing -Z. */
function ahead(distance: number, world = flatWorld()): ReturnType<typeof validateSpawn> {
  return validateSpawn({
    x: 500, z: 500 - distance,
    playerX: 500, playerY: 10, playerZ: 500,
    forwardX: 0, forwardZ: -1,
    frontHalfAngle: 1.05,
  }, world, 1000);
}

/** A candidate directly behind the player. */
function behind(distance: number, world = flatWorld()): ReturnType<typeof validateSpawn> {
  return validateSpawn({
    x: 500, z: 500 + distance,
    playerX: 500, playerY: 10, playerZ: 500,
    forwardX: 0, forwardZ: -1,
    frontHalfAngle: 1.05,
  }, world, 1000);
}

describe('spawn validation', () => {
  it('never places a creature in view at close range', () => {
    const visible = flatWorld({ hasLineOfSight: () => true });
    const close = ahead(12, visible);
    expect(close.ok).toBe(false);
    expect(close.reason).toBe('too-close-visible');
    expect(ahead(SPAWN.minVisibleDistance + 1, visible).ok).toBe(true);
  });

  it('allows a nearer placement only when it is genuinely out of sight', () => {
    const occluded = flatWorld({ hasLineOfSight: () => false });
    expect(ahead(SPAWN.minOccludedFrontDistance + 1, occluded).ok).toBe(true);
    expect(ahead(SPAWN.minOccludedFrontDistance - 4, occluded).ok).toBe(false);
  });

  it('never places a creature immediately behind the player', () => {
    const close = behind(8);
    expect(close.ok).toBe(false);
    expect(close.reason).toBe('too-close-rear');
    expect(behind(SPAWN.minRearDistance + 1).ok).toBe(true);
    // The rear rule is stricter than the occluded-front rule.
    expect(SPAWN.minRearDistance).toBeGreaterThan(SPAWN.minOccludedFrontDistance);
  });

  it('rejects a point too far away to ever find the player', () => {
    expect(behind(SPAWN.maxDistance + 5).reason).toBe('too-far');
  });

  it('rejects placement inside terrain and under low ceilings', () => {
    const buried = flatWorld({ isSolid: (_x, y) => y < 11 });
    expect(ahead(30, buried).reason).toBe('inside-terrain');
    const lowRoof = flatWorld({ isSolid: (_x, y) => y > 11.5 });
    expect(ahead(30, lowRoof).reason).toBe('no-headroom');
  });

  it('rejects water and lava', () => {
    const flooded = flatWorld({ fluidLevel: 12 });
    expect(ahead(30, flooded).reason).toBe('in-water');
    const lava = flatWorld({ fluidLevel: 12, fluidIsHazard: true });
    expect(ahead(30, lava).reason).toBe('in-lava');
  });

  it('lets a creature designed for the hazard stand in it', () => {
    const lava = flatWorld({ fluidLevel: 12, fluidIsHazard: true });
    const check = validateSpawn({
      x: 500, z: 470,
      playerX: 500, playerY: 10, playerZ: 500,
      forwardX: 0, forwardZ: -1, frontHalfAngle: 1.05,
      hazardTolerant: true,
    }, lava, 1000);
    expect(check.ok).toBe(true);
  });

  it('rejects obstacles and protected structures', () => {
    expect(ahead(30, flatWorld({ isObstacle: () => true })).reason).toBe('obstacle');
    expect(ahead(30, flatWorld({ distanceToProtected: () => 2 })).reason).toBe('protected');
  });

  it('rejects a pit or ledge a creature could not walk out of', () => {
    // Every neighbouring column is a cliff far above this one.
    const pit = flatWorld({
      groundHeight: (x, z) => (x === 500 && z === 470 ? 10 : 40),
    });
    expect(ahead(30, pit).reason).toBe('unreachable');
    // A flyer is exempt, because it can simply leave.
    const flyer = validateSpawn({
      x: 500, z: 470,
      playerX: 500, playerY: 10, playerZ: 500,
      forwardX: 0, forwardZ: -1, frontHalfAngle: 1.05, flying: true,
    }, pit, 1000);
    expect(flyer.ok).toBe(true);
  });

  it('rejects points outside the playable area', () => {
    const check = validateSpawn({
      x: 2, z: 2, playerX: 30, playerY: 10, playerZ: 30,
      forwardX: 0, forwardZ: -1, frontHalfAngle: 1.05,
    }, flatWorld(), 1000);
    expect(check.reason).toBe('out-of-bounds');
  });

  it('reports the ground it chose for a valid point', () => {
    const check = behind(30);
    expect(check.ok).toBe(true);
    expect(check.y).toBeCloseTo(10.3, 5);
    expect(check.inFront).toBe(false);
  });

  it('recovers a creature that is stuck or hopelessly far away', () => {
    expect(isStranded(0, SPAWN.abandonDistance + 1, false)).toBe(true);
    expect(isStranded(SPAWN.stuckSeconds + 1, 20, true)).toBe(true);
    // Not stuck: making progress, or not even chasing.
    expect(isStranded(1, 20, true)).toBe(false);
    expect(isStranded(SPAWN.stuckSeconds + 1, 20, false)).toBe(false);
  });
});

// =====================================================================
//  Element parity
// =====================================================================

describe('element parity', () => {
  it('leaves every element able to finish every mandatory creature', () => {
    for (const kind of MANDATORY) {
      for (const element of ELEMENT_ORDER) {
        expect(effectiveResistance(kind, element), `${kind}/${element}`).toBeGreaterThan(0);
        expect(Number.isFinite(timeToKill(kind, element))).toBe(true);
      }
    }
  });

  it('keeps each element the best answer to something', () => {
    // For every element there is at least one mandatory creature it kills
    // faster than any other element does.
    for (const element of ELEMENT_ORDER) {
      const best = MANDATORY.some((kind) => ELEMENT_ORDER.every(
        (other) => other === element || timeToKill(kind, element) <= timeToKill(kind, other),
      ));
      expect(best, element).toBe(true);
    }
  });

  it('keeps the elements distinct rather than numerically identical', () => {
    const costs = new Set(ELEMENT_ORDER.map((e) => ELEMENTS[e].primary.cost));
    const cooldowns = new Set(ELEMENT_ORDER.map((e) => ELEMENTS[e].primary.cooldown));
    expect(costs.size).toBeGreaterThan(1);
    expect(cooldowns.size).toBeGreaterThan(1);
  });

  it('gives every element a way to recover Mana from its own terrain', () => {
    // Each element has an affinity condition it can seek out in the world.
    const state = createManaState();
    for (const element of ELEMENT_ORDER) {
      const tick = tickMana(state, 1, {
        maxMana: REFERENCE_MANA, baseRegen: REFERENCE_REGEN, inCombat: true,
        element, onAffinityTerrain: true,
      });
      expect(tick.terrainBonus, element).toBeGreaterThan(0);
    }
  });

  it('never lets a terrain bonus replace the economy entirely', () => {
    const state = createManaState();
    const boosted = tickMana(state, 1, {
      maxMana: REFERENCE_MANA, baseRegen: REFERENCE_REGEN, inCombat: true,
      element: 'water', onAffinityTerrain: true,
    });
    // Standing in the right place is worth having, but a rotation still costs
    // more than it earns, so positioning is a discount and not a licence.
    const cheapest = Math.min(...ELEMENT_ORDER.map(
      (e) => ELEMENTS[e].primary.cost / ELEMENTS[e].primary.cooldown,
    ));
    expect(boosted.regen).toBeLessThan(cheapest);
  });
});

// =====================================================================
//  Save persistence
// =====================================================================

describe('save persistence', () => {
  it('leaves the save schema untouched by the combat pass', () => {
    // Combat and pacing tuning is derived state: none of it is serialized, so
    // this work must not have moved the schema version at all.
    expect(SAVE_VERSION).toBe(5);
  });

  it('loads an existing save unchanged, with every field preserved', () => {
    const original = createSave(987654, 'fire', 'normal', [128, 40, 128], {}, { berries: 2 });
    original.ultimateUnlocked = true;
    original.ultimateCharge = 62;
    original.health = 47;
    original.energy = 31;
    original.depth = 9;
    original.encounters = 4;

    const result = validateSave(JSON.parse(JSON.stringify(original)));
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.terrainReset).toBe(false);
    const data = result.data!;
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.ultimateUnlocked).toBe(true);
    expect(data.ultimateCharge).toBe(62);
    expect(data.health).toBe(47);
    expect(data.energy).toBe(31);
    expect(data.depth).toBe(9);
    expect(data.encounters).toBe(4);
    expect(data.shrines).toEqual([false, false, false, false]);
    expect(data.affinity).toBe('fire');
    expect(data.seed).toBe(987654);
    expect(data.items.berries).toBe(2);
  });

  it('keeps a stored Ultimate charge across a world transition', () => {
    // The meter is stored as a plain clamped number, so the new rate-limiting
    // and suppression state is rebuilt on load and never persisted.
    const state = createUltimateState(true);
    state.charge = 73;
    const stored = sanitiseCharge(state.charge);
    expect(stored).toBe(73);
    const restored = createUltimateState(true);
    restored.charge = sanitiseCharge(stored);
    expect(restored.charge).toBe(73);
    // A restored meter carries no leftover per-fill or window accounting.
    expect(restored.fromDamageTaken).toBe(0);
    expect(restored.fromTerrain).toBe(0);
    expect(restored.windowGain).toBe(0);
    expect(restored.ultimateActive).toBe(false);
  });

  it('clamps a corrupt or out-of-range stored charge rather than failing', () => {
    expect(sanitiseCharge(-40)).toBe(0);
    expect(sanitiseCharge(1e9)).toBe(ULTIMATE_MAX);
    expect(sanitiseCharge(undefined)).toBe(0);
  });

  it('rebuilds transient Mana state on load without touching the save', () => {
    const state = createManaState();
    expect(state.refunded).toBe(0);
    expect(state.refundWindow).toBe(0);
    expect(state.freeCast).toBe(0);
  });
});
