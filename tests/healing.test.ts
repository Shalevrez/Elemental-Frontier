import { describe, it, expect } from 'vitest';
import {
  REGEN_DELAY, REGEN_RATE, REST_DURATION, WATER_REGEN_DELAY_BONUS,
  canRest, clearEffects, consume, createHealingState, inCombat, notifyDamaged,
  notifyDealtDamage, regenDelayFor, regenRateFor, tickHealing, tickRest,
  type CombatContext, type HealingState,
} from '../src/game/Healing';
import { CONSUMABLES, Inventory } from '../src/player/inventory';

function ctx(patch: Partial<CombatContext> = {}): CombatContext {
  return {
    hostilePressure: false,
    takingDamageOverTime: false,
    element: 'earth',
    nearWater: false,
    ...patch,
  };
}

/** Run `seconds` of simulation in small steps and return the final health. */
function simulate(state: HealingState, health: number, maxHealth: number, seconds: number, c = ctx()): number {
  let hp = health;
  const step = 0.1;
  for (let t = 0; t < seconds; t += step) {
    const tick = tickHealing(state, step, hp, maxHealth, c);
    hp = Math.min(maxHealth, hp + tick.regen + tick.fromEffects);
  }
  return hp;
}

describe('automatic regeneration', () => {
  it('does nothing during the out-of-combat delay', () => {
    const state = createHealingState();
    notifyDamaged(state);
    const hp = simulate(state, 50, 100, REGEN_DELAY - 1);
    expect(hp).toBe(50);
  });

  it('starts once the delay has elapsed', () => {
    const state = createHealingState();
    notifyDamaged(state);
    const hp = simulate(state, 50, 100, REGEN_DELAY + 2);
    expect(hp).toBeGreaterThan(50);
    // Roughly two seconds of regeneration at 1.5% per second.
    expect(hp).toBeLessThan(50 + 100 * REGEN_RATE * 3);
  });

  it('regenerates about 1.5% of maximum health per second', () => {
    const state = createHealingState();
    state.sinceDamaged = 999;
    state.sinceDealt = 999;
    const hp = simulate(state, 50, 200, 10);
    // 10 seconds at 1.5% of 200 = 30
    expect(hp - 50).toBeGreaterThan(25);
    expect(hp - 50).toBeLessThan(35);
  });

  it('stops immediately when damage lands', () => {
    const state = createHealingState();
    state.sinceDamaged = 999;
    state.sinceDealt = 999;
    let hp = simulate(state, 50, 100, 3);
    expect(hp).toBeGreaterThan(50);
    const afterRegen = hp;

    notifyDamaged(state);
    hp = simulate(state, hp, 100, 2);
    expect(hp).toBe(afterRegen);
    expect(state.regenActive).toBe(false);
  });

  it('never exceeds maximum health', () => {
    const state = createHealingState();
    state.sinceDamaged = 999;
    state.sinceDealt = 999;
    const hp = simulate(state, 99, 100, 60);
    expect(hp).toBe(100);
  });

  it('counts dealing damage as combat', () => {
    const state = createHealingState();
    state.sinceDamaged = 999;
    notifyDealtDamage(state);
    expect(inCombat(state, ctx(), REGEN_DELAY)).toBe(true);
    const hp = simulate(state, 50, 100, 2);
    expect(hp).toBe(50);
  });

  it('counts a nearby hunting creature as combat', () => {
    const state = createHealingState();
    state.sinceDamaged = 999;
    state.sinceDealt = 999;
    expect(inCombat(state, ctx({ hostilePressure: true }), REGEN_DELAY)).toBe(true);
    expect(simulate(state, 50, 100, 3, ctx({ hostilePressure: true }))).toBe(50);
  });

  it('will not regenerate through damage over time such as drowning', () => {
    const state = createHealingState();
    state.sinceDamaged = 999;
    state.sinceDealt = 999;
    expect(inCombat(state, ctx({ takingDamageOverTime: true }), REGEN_DELAY)).toBe(true);
    expect(simulate(state, 50, 100, 3, ctx({ takingDamageOverTime: true }))).toBe(50);
  });
});

describe('water passive', () => {
  it('shortens the delay near water without removing it', () => {
    const dry = regenDelayFor(ctx({ element: 'water', nearWater: false }));
    const wet = regenDelayFor(ctx({ element: 'water', nearWater: true }));
    expect(dry).toBe(REGEN_DELAY);
    expect(wet).toBe(REGEN_DELAY - WATER_REGEN_DELAY_BONUS);
    expect(wet).toBeGreaterThan(0);
  });

  it('slightly speeds up regeneration near water', () => {
    const base = regenRateFor(ctx({ element: 'earth', nearWater: true }));
    const boosted = regenRateFor(ctx({ element: 'water', nearWater: true }));
    expect(boosted).toBeGreaterThan(base);
    // Balanced: less than double.
    expect(boosted).toBeLessThan(base * 2);
  });

  it('gives no bonus to other elements', () => {
    expect(regenDelayFor(ctx({ element: 'fire', nearWater: true }))).toBe(REGEN_DELAY);
    expect(regenRateFor(ctx({ element: 'air', nearWater: true }))).toBe(REGEN_RATE);
  });

  it('improves food and potion effectiveness', () => {
    const inv = new Inventory(undefined, { minorPotion: 2 });
    const dry = createHealingState();
    const wet = createHealingState();
    const dryResult = consume(dry, 'minorPotion', 10, 100, ctx({ element: 'earth' }), (id) => inv.takeItem(id));
    const wetResult = consume(wet, 'minorPotion', 10, 100, ctx({ element: 'water' }), (id) => inv.takeItem(id));
    expect(dryResult.ok && wetResult.ok).toBe(true);
    if (dryResult.ok && wetResult.ok) expect(wetResult.heal).toBeGreaterThan(dryResult.heal);
  });
});

describe('food and potions', () => {
  it('heals gradually over the food duration', () => {
    const inv = new Inventory(undefined, { berries: 1 });
    const state = createHealingState();
    const result = consume(state, 'berries', 40, 100, ctx(), (id) => inv.takeItem(id));
    expect(result.ok).toBe(true);
    expect(inv.countItem('berries')).toBe(0);

    // Halfway through the effect only part of the healing has landed.
    const half = simulate(state, 40, 100, CONSUMABLES.berries.duration / 2);
    expect(half).toBeGreaterThan(40);
    expect(half).toBeLessThan(40 + CONSUMABLES.berries.heal);

    const full = simulate(state, half, 100, CONSUMABLES.berries.duration);
    expect(full).toBeGreaterThan(half);
    expect(state.effects).toHaveLength(0);
  });

  it('refuses to consume at full health and keeps the item', () => {
    const inv = new Inventory(undefined, { berries: 1 });
    const state = createHealingState();
    const result = consume(state, 'berries', 100, 100, ctx(), (id) => inv.takeItem(id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('full');
    expect(inv.countItem('berries')).toBe(1);
  });

  it('refuses when none are carried', () => {
    const inv = new Inventory();
    const state = createHealingState();
    const result = consume(state, 'meal', 10, 100, ctx(), (id) => inv.takeItem(id));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('none');
  });

  it('cannot stack the same item twice', () => {
    const inv = new Inventory(undefined, { berries: 2 });
    const state = createHealingState();
    expect(consume(state, 'berries', 10, 100, ctx(), (id) => inv.takeItem(id)).ok).toBe(true);
    const second = consume(state, 'berries', 10, 100, ctx(), (id) => inv.takeItem(id));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('duplicate');
    expect(inv.countItem('berries')).toBe(1);
  });

  it('puts potions on a shared cooldown that blocks rapid reuse', () => {
    const inv = new Inventory(undefined, { minorPotion: 2, greaterPotion: 1 });
    const state = createHealingState();
    expect(consume(state, 'minorPotion', 10, 100, ctx(), (id) => inv.takeItem(id)).ok).toBe(true);
    expect(state.potionCooldown).toBeGreaterThan(0);

    const blocked = consume(state, 'greaterPotion', 10, 100, ctx(), (id) => inv.takeItem(id));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('cooldown');
    expect(inv.countItem('greaterPotion')).toBe(1);

    simulate(state, 10, 100, CONSUMABLES.minorPotion.cooldown + 1);
    expect(state.potionCooldown).toBe(0);
  });

  it('never heals past maximum health', () => {
    const inv = new Inventory(undefined, { greaterPotion: 1 });
    const state = createHealingState();
    consume(state, 'greaterPotion', 95, 100, ctx(), (id) => inv.takeItem(id));
    const hp = simulate(state, 95, 100, 10);
    expect(hp).toBe(100);
  });

  it('is blunted by taking a hit but a potion is not', () => {
    const inv = new Inventory(undefined, { meal: 1, minorPotion: 1 });

    const foodState = createHealingState();
    consume(foodState, 'meal', 10, 100, ctx(), (id) => inv.takeItem(id));
    const foodBefore = foodState.effects[0]!.remaining;
    notifyDamaged(foodState);
    expect(foodState.effects[0]!.remaining).toBeLessThan(foodBefore);

    const potionState = createHealingState();
    consume(potionState, 'minorPotion', 10, 100, ctx(), (id) => inv.takeItem(id));
    const potionBefore = potionState.effects[0]!.remaining;
    notifyDamaged(potionState);
    expect(potionState.effects[0]!.remaining).toBe(potionBefore);
  });

  it('clears every effect on demand', () => {
    const inv = new Inventory(undefined, { berries: 1 });
    const state = createHealingState();
    consume(state, 'berries', 10, 100, ctx(), (id) => inv.takeItem(id));
    clearEffects(state);
    expect(state.effects).toHaveLength(0);
  });
});

describe('resting', () => {
  const site = { atRestSite: true, hostileNearby: false, peaceful: false };

  it('needs a valid rest site', () => {
    expect(canRest({ ...site, atRestSite: false }).ok).toBe(false);
    expect(canRest(site).ok).toBe(true);
  });

  it('is refused with hostiles nearby in Normal Mode', () => {
    const check = canRest({ ...site, hostileNearby: true });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('hostiles');
  });

  it('is always allowed in Peaceful Mode at a valid site', () => {
    expect(canRest({ atRestSite: true, hostileNearby: true, peaceful: true }).ok).toBe(true);
  });

  it('completes only after the full uninterrupted hold', () => {
    const state = createHealingState();
    let done = false;
    for (let t = 0; t < REST_DURATION - 0.2; t += 0.1) {
      done = tickRest(state, 0.1, true, site);
    }
    expect(done).toBe(false);
    expect(state.resting).toBe(true);
    for (let t = 0; t < 0.5 && !done; t += 0.1) {
      done = tickRest(state, 0.1, true, site);
    }
    expect(done).toBe(true);
    expect(state.restProgress).toBe(0);
  });

  it('is cancelled by releasing the key', () => {
    const state = createHealingState();
    tickRest(state, 1, true, site);
    expect(state.restProgress).toBeGreaterThan(0);
    tickRest(state, 0.1, false, site);
    expect(state.restProgress).toBe(0);
    expect(state.resting).toBe(false);
  });

  it('is interrupted by damage', () => {
    const state = createHealingState();
    tickRest(state, 1.5, true, site);
    expect(state.resting).toBe(true);
    notifyDamaged(state);
    expect(state.resting).toBe(false);
    expect(state.restProgress).toBe(0);
  });
});
