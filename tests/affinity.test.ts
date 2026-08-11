import { describe, it, expect } from 'vitest';
import {
  AFFINITY_WEIGHTS,
  ALL_AFFINITIES,
  TOTAL_AFFINITY_WEIGHT,
  affinityFromRoll,
  affinityOdds,
  elementsFor,
  isAffinityId,
  isConvergence,
  resolveActiveElement,
  rollAffinity,
  type AffinityId,
} from '../src/elements/affinity';

describe('affinity weights', () => {
  it('totals exactly 11', () => {
    expect(TOTAL_AFFINITY_WEIGHT).toBe(11);
  });

  it('uses the exact required integer weights', () => {
    const table = Object.fromEntries(AFFINITY_WEIGHTS.map((w) => [w.id, w.weight]));
    expect(table).toEqual({ earth: 3, fire: 3, water: 2, air: 2, convergence: 1 });
  });

  it('exposes every affinity exactly once', () => {
    expect([...ALL_AFFINITIES].sort()).toEqual(['air', 'convergence', 'earth', 'fire', 'water']);
  });

  it('reports the documented probabilities', () => {
    const odds = Object.fromEntries(affinityOdds().map((o) => [o.id, Number(o.percent.toFixed(2))]));
    expect(odds.earth).toBe(27.27);
    expect(odds.fire).toBe(27.27);
    expect(odds.water).toBe(18.18);
    expect(odds.air).toBe(18.18);
    expect(odds.convergence).toBe(9.09);
  });
});

describe('affinityFromRoll boundaries', () => {
  it('maps every integer in range to the correct affinity', () => {
    const expected: AffinityId[] = [
      'earth', 'earth', 'earth',
      'fire', 'fire', 'fire',
      'water', 'water',
      'air', 'air',
      'convergence',
    ];
    expect(expected).toHaveLength(TOTAL_AFFINITY_WEIGHT);
    for (let roll = 0; roll < TOTAL_AFFINITY_WEIGHT; roll++) {
      expect(affinityFromRoll(roll)).toBe(expected[roll]);
    }
  });

  it('places boundaries exactly at the cumulative weights', () => {
    expect(affinityFromRoll(2)).toBe('earth');
    expect(affinityFromRoll(3)).toBe('fire');
    expect(affinityFromRoll(5)).toBe('fire');
    expect(affinityFromRoll(6)).toBe('water');
    expect(affinityFromRoll(7)).toBe('water');
    expect(affinityFromRoll(8)).toBe('air');
    expect(affinityFromRoll(9)).toBe('air');
    expect(affinityFromRoll(10)).toBe('convergence');
  });

  it('clamps out-of-range and non-finite rolls instead of throwing', () => {
    expect(affinityFromRoll(-5)).toBe('earth');
    expect(affinityFromRoll(11)).toBe('convergence');
    expect(affinityFromRoll(9999)).toBe('convergence');
    expect(affinityFromRoll(Number.NaN)).toBe('earth');
    expect(affinityFromRoll(2.99)).toBe('earth');
    expect(affinityFromRoll(3.01)).toBe('fire');
  });
});

describe('rollAffinity', () => {
  it('maps the unit interval onto the same boundaries', () => {
    const at = (u: number): AffinityId => rollAffinity(() => u);
    expect(at(0)).toBe('earth');
    expect(at(2.9 / 11)).toBe('earth');
    expect(at(3 / 11)).toBe('fire');
    expect(at(5.9 / 11)).toBe('fire');
    expect(at(6 / 11)).toBe('water');
    expect(at(8 / 11)).toBe('air');
    expect(at(10 / 11)).toBe('convergence');
    expect(at(0.999999)).toBe('convergence');
  });

  it('survives a hostile random source', () => {
    expect(ALL_AFFINITIES).toContain(rollAffinity(() => Number.NaN));
    expect(ALL_AFFINITIES).toContain(rollAffinity(() => -1));
    expect(ALL_AFFINITIES).toContain(rollAffinity(() => 1));
  });

  it('produces the expected distribution over a uniform sweep', () => {
    const counts: Record<string, number> = {};
    const samples = 11000;
    for (let i = 0; i < samples; i++) {
      const id = rollAffinity(() => (i + 0.5) / samples);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    expect(counts.earth).toBe(3000);
    expect(counts.fire).toBe(3000);
    expect(counts.water).toBe(2000);
    expect(counts.air).toBe(2000);
    expect(counts.convergence).toBe(1000);
  });
});

describe('affinity helpers', () => {
  it('validates stored affinity strings', () => {
    expect(isAffinityId('fire')).toBe(true);
    expect(isAffinityId('convergence')).toBe(true);
    expect(isAffinityId('avatar')).toBe(false);
    expect(isAffinityId(null)).toBe(false);
    expect(isAffinityId(3)).toBe(false);
  });

  it('gives single-element players only their own element', () => {
    expect(elementsFor('earth')).toEqual(['earth']);
    expect(elementsFor('convergence')).toEqual(['air', 'water', 'earth', 'fire']);
    expect(isConvergence('convergence')).toBe(true);
    expect(isConvergence('water')).toBe(false);
  });

  it('locks single-element players to their element even if the save says otherwise', () => {
    expect(resolveActiveElement('earth', 'fire')).toBe('earth');
    expect(resolveActiveElement('air', 'water')).toBe('air');
    expect(resolveActiveElement('convergence', 'fire')).toBe('fire');
    expect(resolveActiveElement('convergence', 'nonsense')).toBe('air');
    expect(resolveActiveElement('convergence', undefined)).toBe('air');
  });
});
