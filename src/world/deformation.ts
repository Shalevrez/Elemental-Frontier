/**
 * Combat terrain deformation.
 *
 * Elemental attacks are supposed to change the arena, not leave it pristine.
 * This module owns the *rules*: how big a single deformation may be, what is
 * protected from it, how long temporary ground effects live, and how the four
 * elements interact when their effects overlap - water extinguishes fire, fire
 * melts ice, water on lava makes stone and steam, air spreads fire and clears
 * smoke, earth shatters frozen ground.
 *
 * The geometry work is delegated to `World.addTemporary` / `World.edit`; what
 * lives here is the bookkeeping that keeps deformation fair and performant.
 */

import { Mat, type MaterialId } from './materials';
import type { World } from './World';
import { INCOMING } from '../combat/combatConfig';

export type ZoneKind = 'burning' | 'wet' | 'ice' | 'slippery' | 'steam' | 'smoke';

export interface TerrainZone {
  id: number;
  kind: ZoneKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Seconds left before the zone lifts. */
  timeLeft: number;
  duration: number;
  /** Damage per second applied to anything standing in it. */
  dps: number;
  /** Who created it, so a player's own burning ground can be made harmless. */
  owner: 'player' | 'world' | 'enemy';
}

/** Hard ceiling on a single deformation, whatever the ability asks for. */
export const MAX_DEFORM_RADIUS = 7;
/** Hard ceiling on simultaneously live ground zones, for performance. */
export const MAX_ZONES = 48;
/** Hard ceiling on simultaneously live temporary terrain edits. */
export const MAX_TEMPORARY_EDITS = 90;

export interface DeformResult {
  applied: boolean;
  /** Set when the request was refused, for the debug overlay. */
  reason: 'protected' | 'too-many' | 'no-ground' | null;
}

/**
 * Ground effects created by combat.
 *
 * Zones are cheap: a position, a radius and a timer. Enemy and player damage
 * both sample them, and their elemental interactions are resolved here so any
 * two abilities that meet on the ground behave consistently.
 */
export class TerrainEffects {
  private readonly zones: TerrainZone[] = [];
  private nextId = 1;
  /** Deformations applied this world, for the debug readout. */
  deformCount = 0;

  constructor(private readonly world: World) {}

  get list(): readonly TerrainZone[] {
    return this.zones;
  }

  get count(): number {
    return this.zones.length;
  }

  clear(): void {
    this.zones.length = 0;
  }

  /**
   * Add a ground zone.
   *
   * Overlapping zones of opposing elements cancel: water puts fire out, fire
   * boils water into steam, and earth shatters ice.
   */
  add(
    kind: ZoneKind,
    x: number, y: number, z: number,
    radius: number,
    seconds: number,
    dps = 0,
    owner: TerrainZone['owner'] = 'player',
  ): TerrainZone | null {
    const r = Math.min(MAX_DEFORM_RADIUS, Math.max(0.4, radius));
    this.resolveInteractions(kind, x, y, z, r);

    if (this.zones.length >= MAX_ZONES) {
      // Recycle the zone closest to expiring rather than growing without bound.
      let worst = 0;
      for (let i = 1; i < this.zones.length; i++) {
        if (this.zones[i]!.timeLeft < this.zones[worst]!.timeLeft) worst = i;
      }
      this.zones.splice(worst, 1);
    }

    const zone: TerrainZone = {
      id: this.nextId++,
      kind, x, y, z, radius: r,
      timeLeft: seconds, duration: seconds, dps, owner,
    };
    this.zones.push(zone);
    return zone;
  }

  /**
   * Cancel or transform zones the incoming one interacts with.
   *
   * Returns the number of zones that reacted, which the caller can use to
   * decide whether to play a steam effect.
   */
  private resolveInteractions(kind: ZoneKind, x: number, y: number, z: number, radius: number): number {
    let reacted = 0;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zone = this.zones[i]!;
      const d = Math.hypot(zone.x - x, zone.z - z);
      if (d > radius + zone.radius) continue;
      if (Math.abs(zone.y - y) > 6) continue;

      if (kind === 'wet' && zone.kind === 'burning') {
        this.zones.splice(i, 1);
        reacted++;
      } else if (kind === 'burning' && zone.kind === 'wet') {
        this.zones.splice(i, 1);
        reacted++;
      } else if (kind === 'burning' && zone.kind === 'ice') {
        this.zones.splice(i, 1);
        reacted++;
      } else if (kind === 'wet' && zone.kind === 'steam') {
        this.zones.splice(i, 1);
      }
    }
    return reacted;
  }

  /** Zones overlapping a point, cheapest possible query. */
  at(x: number, y: number, z: number, out: TerrainZone[] = []): TerrainZone[] {
    out.length = 0;
    for (const zone of this.zones) {
      if (Math.abs(zone.y - y) > 4) continue;
      const dx = zone.x - x;
      const dz = zone.z - z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) out.push(zone);
    }
    return out;
  }

  /** Total damage per second something standing here should take. */
  damageAt(x: number, y: number, z: number, from: TerrainZone['owner'] | 'any' = 'any'): number {
    let dps = 0;
    for (const zone of this.zones) {
      if (zone.dps <= 0) continue;
      if (from !== 'any' && zone.owner !== from) continue;
      if (Math.abs(zone.y - y) > 4) continue;
      const dx = zone.x - x;
      const dz = zone.z - z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) dps += zone.dps;
    }
    // Overlapping zones stack, but not without limit: three burning patches
    // laid over one another used to be three times the damage per second,
    // which is how a player dies to standing still for a moment.
    return Math.min(INCOMING.maxEnvironmentDps, dps);
  }

  /**
   * The largest radius a single attack may reshape in the current world.
   *
   * Declared per world so a lava basin's shelves and a snowfield's ice bridges
   * survive a terrain build that would flatten the Verdant Ruins. Set on load;
   * `deform` clamps against it as well as against the global ceiling.
   */
  private worldLimit = MAX_DEFORM_RADIUS;

  setWorldLimit(radius: number): void {
    this.worldLimit = Math.max(1, Math.min(MAX_DEFORM_RADIUS, radius));
  }

  /** True when the ground here has been made slippery (ice). */
  slipperyAt(x: number, y: number, z: number): boolean {
    for (const zone of this.zones) {
      if (zone.kind !== 'ice' && zone.kind !== 'slippery') continue;
      if (Math.abs(zone.y - y) > 3) continue;
      const dx = zone.x - x;
      const dz = zone.z - z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) return true;
    }
    return false;
  }

  /** True when the air here is thick with smoke, reducing visibility. */
  obscuredAt(x: number, y: number, z: number): boolean {
    for (const zone of this.zones) {
      if (zone.kind !== 'smoke' && zone.kind !== 'steam') continue;
      if (Math.abs(zone.y - y) > 5) continue;
      const dx = zone.x - x;
      const dz = zone.z - z;
      if (dx * dx + dz * dz <= zone.radius * zone.radius) return true;
    }
    return false;
  }

  /** Air abilities clear smoke and steam out of an area. */
  clearObscurants(x: number, z: number, radius: number): number {
    let cleared = 0;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zone = this.zones[i]!;
      if (zone.kind !== 'smoke' && zone.kind !== 'steam') continue;
      if (Math.hypot(zone.x - x, zone.z - z) > radius + zone.radius) continue;
      this.zones.splice(i, 1);
      cleared++;
    }
    return cleared;
  }

  /** Air abilities spread nearby fire outward instead of putting it out. */
  fanFlames(x: number, z: number, radius: number): number {
    let spread = 0;
    for (const zone of [...this.zones]) {
      if (zone.kind !== 'burning') continue;
      if (Math.hypot(zone.x - x, zone.z - z) > radius + zone.radius) continue;
      zone.radius = Math.min(MAX_DEFORM_RADIUS, zone.radius * 1.35);
      zone.timeLeft = Math.min(zone.duration, zone.timeLeft + 2);
      spread++;
    }
    return spread;
  }

  tick(dt: number): TerrainZone[] {
    const expired: TerrainZone[] = [];
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zone = this.zones[i]!;
      zone.timeLeft -= dt;
      if (zone.timeLeft <= 0) {
        this.zones.splice(i, 1);
        expired.push(zone);
      }
    }
    return expired;
  }

  // ------------------------------------------------------ geometry helpers

  /**
   * Carve or raise ground, refusing anything protected or oversized.
   *
   * Every combat deformation goes through here, so the "never delete an
   * objective, never seal a portal, never exceed the size limit" rules are
   * enforced in exactly one place.
   */
  deform(
    x: number, y: number, z: number,
    radius: number,
    strength: number,
    material: number,
    seconds: number,
    maxRadius = MAX_DEFORM_RADIUS,
  ): DeformResult {
    if (this.world.isProtected(x, y, z)) return { applied: false, reason: 'protected' };
    const r = Math.min(maxRadius, MAX_DEFORM_RADIUS, this.worldLimit, Math.max(0.5, radius));
    const ok = this.world.addTemporary({ x, y, z, radius: r, strength, material: material as MaterialId }, seconds);
    if (!ok) return { applied: false, reason: 'protected' };
    this.deformCount++;
    return { applied: true, reason: null };
  }

  /** Earth: a short defensive ridge in front of a point. */
  raiseCover(
    x: number, y: number, z: number,
    dirX: number, dirZ: number,
    segments: number,
    seconds: number,
    maxRadius = MAX_DEFORM_RADIUS,
  ): number {
    const sideX = -dirZ;
    const sideZ = dirX;
    let placed = 0;
    for (let s = 0; s < segments; s++) {
      const offset = (s - (segments - 1) / 2) * 1.5;
      const bx = x + sideX * offset;
      const bz = z + sideZ * offset;
      const ground = this.world.groundHeight(bx, bz);
      if (ground <= 0) continue;
      for (let h = 0; h < 3; h++) {
        const result = this.deform(
          bx, ground + 0.4 + h * 0.85, bz, 1.55, 2.4, Mat.SOIL, seconds + h * 0.4, maxRadius,
        );
        if (result.applied) placed++;
      }
    }
    void y;
    return placed;
  }

  /** Earth: a shallow crater where something heavy landed. */
  crater(x: number, y: number, z: number, radius: number, seconds = 26, maxRadius = MAX_DEFORM_RADIUS): DeformResult {
    return this.deform(x, y, z, radius, -1.7, Mat.SOIL, seconds, maxRadius);
  }

  /** Water: a temporary ice sheet over shallow water or wet ground. */
  icePath(x: number, z: number, level: number, radius: number, seconds: number, maxRadius = MAX_DEFORM_RADIUS): number {
    let placed = 0;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const r = i === 0 ? 0 : radius * 0.7;
      const result = this.deform(
        x + Math.cos(a) * r, level - 0.35, z + Math.sin(a) * r,
        radius * 0.9, 2.6, Mat.ICE, seconds, maxRadius,
      );
      if (result.applied) placed++;
    }
    return placed;
  }

  /**
   * Water meeting lava: the surface crusts over into temporary stone and the
   * area fills with steam.
   */
  quenchLava(x: number, z: number, level: number, radius: number, seconds = 14): boolean {
    const result = this.deform(x, level - 0.3, z, Math.min(3.2, radius), 2.8, Mat.STONE, seconds);
    if (result.applied) this.add('steam', x, level + 1, z, radius, 6, 0, 'world');
    return result.applied;
  }
}

/**
 * How many temporary edits a world may hold at once.
 *
 * Exposed so the caller can decline to deform rather than pushing the terrain
 * mesher past its budget.
 */
export function deformationAllowed(activeTemporaries: number): boolean {
  return activeTemporaries < MAX_TEMPORARY_EDITS;
}
