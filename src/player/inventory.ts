/**
 * The satchel: terrain materials the player has excavated plus healing
 * consumables. Pure logic - the HUD only reads from it.
 */

import { CARRYABLE_MATERIALS, Mat, isValidMaterial, materialDef, type MaterialId } from '../world/materials';

export const MAX_MATERIAL = 9999;
export const MAX_CONSUMABLE = 99;

export type ConsumableId = 'berries' | 'meal' | 'minorPotion' | 'greaterPotion';

export interface ConsumableDef {
  readonly id: ConsumableId;
  readonly name: string;
  readonly kind: 'food' | 'potion';
  /** Total health restored across the whole effect. */
  readonly heal: number;
  /** Seconds the healing is spread over (0 = instant). */
  readonly duration: number;
  /** Seconds before the same category can be used again. */
  readonly cooldown: number;
  /** How much of the remaining effect survives taking a hit, 0..1. */
  readonly interruptRetention: number;
  readonly color: number;
  readonly symbol: string;
  readonly blurb: string;
}

export const CONSUMABLES: Readonly<Record<ConsumableId, ConsumableDef>> = Object.freeze({
  berries: Object.freeze({
    id: 'berries', name: 'Sunberries', kind: 'food',
    heal: 20, duration: 6, cooldown: 1.5, interruptRetention: 0.35,
    color: 0xe0517a, symbol: '#sym-berries',
    blurb: 'A handful of tart berries. Mends a little, slowly.',
  }),
  meal: Object.freeze({
    id: 'meal', name: 'Travelling Meal', kind: 'food',
    heal: 48, duration: 12, cooldown: 2.5, interruptRetention: 0.5,
    color: 0xd9a05a, symbol: '#sym-meal',
    blurb: 'A packed camp meal. Mends a great deal over a long while.',
  }),
  minorPotion: Object.freeze({
    id: 'minorPotion', name: 'Minor Draught', kind: 'potion',
    heal: 38, duration: 0.8, cooldown: 10, interruptRetention: 1,
    color: 0x5ad6a0, symbol: '#sym-vial',
    blurb: 'A small vial of distilled spring. Works almost at once.',
  }),
  greaterPotion: Object.freeze({
    id: 'greaterPotion', name: 'Greater Draught', kind: 'potion',
    heal: 85, duration: 1.2, cooldown: 16, interruptRetention: 1,
    color: 0x63b8ff, symbol: '#sym-flask',
    blurb: 'A heavy flask of deep-water essence. Rare, and worth saving.',
  }),
});

export const CONSUMABLE_ORDER: readonly ConsumableId[] = Object.freeze([
  'berries', 'meal', 'minorPotion', 'greaterPotion',
]);

export function isConsumableId(value: unknown): value is ConsumableId {
  return typeof value === 'string' && (CONSUMABLE_ORDER as readonly string[]).includes(value);
}

/** What a brand new world starts with. */
export const STARTING_MATERIALS: Readonly<Partial<Record<MaterialId, number>>> = Object.freeze({
  [Mat.SOIL]: 40,
  [Mat.STONE]: 25,
});

export const STARTING_CONSUMABLES: Readonly<Record<ConsumableId, number>> = Object.freeze({
  berries: 3,
  meal: 1,
  minorPotion: 1,
  greaterPotion: 0,
});

export class Inventory {
  private materials = new Map<MaterialId, number>();
  private consumables = new Map<ConsumableId, number>();
  private slotOrder: MaterialId[] = [...CARRYABLE_MATERIALS];
  selected = 0;

  constructor(materials?: unknown, consumables?: unknown) {
    if (materials) this.loadMaterials(materials);
    if (consumables) this.loadConsumables(consumables);
  }

  // ---------------------------------------------------------- materials

  loadMaterials(data: unknown): void {
    this.materials.clear();
    if (!data || typeof data !== 'object') return;
    for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
      const id = Number(key);
      if (!isValidMaterial(id) || id === Mat.AIR) continue;
      if (!materialDef(id).carryable) continue;
      const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
      if (n > 0) this.materials.set(id, Math.min(n, MAX_MATERIAL));
    }
  }

  materialsToJSON(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [id, n] of this.materials) {
      if (n > 0.01) out[id] = Math.round(n * 10) / 10;
    }
    return out;
  }

  get slots(): readonly MaterialId[] {
    return this.slotOrder;
  }

  countMaterial(id: MaterialId): number {
    return this.materials.get(id) ?? 0;
  }

  totalMaterials(): number {
    let n = 0;
    for (const v of this.materials.values()) n += v;
    return n;
  }

  addMaterial(id: MaterialId, amount: number): number {
    if (!isValidMaterial(id) || id === Mat.AIR) return 0;
    if (!materialDef(id).carryable) return 0;
    const n = Math.max(0, amount);
    if (n === 0) return 0;
    const current = this.countMaterial(id);
    const next = Math.min(MAX_MATERIAL, current + n);
    this.materials.set(id, next);
    return next - current;
  }

  /** Remove material. Returns how much was actually taken. */
  takeMaterial(id: MaterialId, amount: number): number {
    const want = Math.max(0, amount);
    const current = this.countMaterial(id);
    const taken = Math.min(current, want);
    const next = current - taken;
    if (next <= 0.001) this.materials.delete(id);
    else this.materials.set(id, next);
    return taken;
  }

  hasMaterial(id: MaterialId, amount = 1): boolean {
    return this.countMaterial(id) >= amount;
  }

  selectedMaterial(): MaterialId {
    return this.slotOrder[this.selected] ?? Mat.SOIL;
  }

  select(index: number): void {
    const n = this.slotOrder.length;
    this.selected = ((Math.floor(index) % n) + n) % n;
  }

  cycle(delta: number): void {
    this.select(this.selected + (delta > 0 ? 1 : -1));
  }

  /** Move to the next slot that has material in it (or stay put). */
  selectNextAvailable(): void {
    for (let i = 1; i <= this.slotOrder.length; i++) {
      const idx = (this.selected + i) % this.slotOrder.length;
      if (this.countMaterial(this.slotOrder[idx]!) > 0) {
        this.selected = idx;
        return;
      }
    }
  }

  /**
   * Blightmatter can only be selected once some has been collected, which is
   * what makes it a "restricted" material rather than a starting one.
   */
  canSelect(id: MaterialId): boolean {
    return !materialDef(id).restricted || this.countMaterial(id) > 0;
  }

  // -------------------------------------------------------- consumables

  loadConsumables(data: unknown): void {
    this.consumables.clear();
    if (!data || typeof data !== 'object') return;
    for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
      if (!isConsumableId(key)) continue;
      const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
      if (n > 0) this.consumables.set(key, Math.min(n, MAX_CONSUMABLE));
    }
  }

  consumablesToJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.consumables) if (n > 0) out[id] = n;
    return out;
  }

  countItem(id: ConsumableId): number {
    return this.consumables.get(id) ?? 0;
  }

  addItem(id: ConsumableId, amount = 1): number {
    if (!isConsumableId(id)) return 0;
    const n = Math.max(0, Math.floor(amount));
    if (n === 0) return 0;
    const current = this.countItem(id);
    const next = Math.min(MAX_CONSUMABLE, current + n);
    this.consumables.set(id, next);
    return next - current;
  }

  /** Consume one item. Returns false when the player has none. */
  takeItem(id: ConsumableId): boolean {
    const current = this.countItem(id);
    if (current < 1) return false;
    const next = current - 1;
    if (next <= 0) this.consumables.delete(id);
    else this.consumables.set(id, next);
    return true;
  }

  totalItems(): number {
    let n = 0;
    for (const v of this.consumables.values()) n += v;
    return n;
  }
}

/**
 * Pick the most appropriate healing item for the damage the player has taken.
 *
 * Small scratches get food, moderate wounds a minor draught, and the greater
 * draught is saved for genuine emergencies. Returns null at full health, so
 * the quick-use key can never waste an item.
 */
export function chooseHealingItem(
  inventory: Inventory,
  health: number,
  maxHealth: number,
  potionReady: boolean,
): ConsumableId | null {
  if (maxHealth <= 0) return null;
  const missing = maxHealth - health;
  if (missing < 1) return null;
  const fraction = health / maxHealth;

  const has = (id: ConsumableId): boolean => inventory.countItem(id) > 0;

  // Badly injured: reach for the strongest thing available.
  if (fraction <= 0.3) {
    if (potionReady && has('greaterPotion')) return 'greaterPotion';
    if (potionReady && has('minorPotion')) return 'minorPotion';
    if (has('meal')) return 'meal';
    if (has('berries')) return 'berries';
    return null;
  }

  // Moderately hurt: a minor draught, or a meal if no potion is ready.
  if (fraction <= 0.65) {
    if (potionReady && has('minorPotion')) return 'minorPotion';
    if (has('meal')) return 'meal';
    if (has('berries')) return 'berries';
    if (potionReady && has('greaterPotion') && missing >= CONSUMABLES.greaterPotion.heal * 0.7) return 'greaterPotion';
    return null;
  }

  // Lightly scratched: food only, and only if it will not mostly go to waste.
  if (has('berries')) return 'berries';
  if (has('meal') && missing >= CONSUMABLES.meal.heal * 0.5) return 'meal';
  return null;
}
