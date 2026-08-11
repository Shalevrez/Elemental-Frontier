/**
 * World props: campfires to rest at, berry bushes to forage and supply caches
 * to loot.
 *
 * Placement is deterministic from the world seed, so only the *looted* set has
 * to be saved. Each prop gets a stable numeric id derived from its slot index.
 */

import * as THREE from 'three';
import { hash2 } from '../core/rng';
import { SEA_LEVEL, WORLD_CENTER, WORLD_SIZE } from './coords';
import { SHRINE_SITES } from './shrineData';
import { SPAWN_PLAZA_RADIUS } from './density';
import { buildBerryBush, buildCampfire, buildSupplyCache } from '../render/models';
import type { World } from './World';
import type { ConsumableId } from '../player/inventory';

export type PropKind = 'campfire' | 'bush' | 'cache';

export interface PropInstance {
  id: number;
  kind: PropKind;
  position: THREE.Vector3;
  looted: boolean;
  object: THREE.Object3D;
  light: THREE.PointLight | null;
  animated: THREE.Object3D[];
  /** What a cache or bush yields. */
  loot: { item: ConsumableId; count: number } | null;
}

export const PROP_INTERACT_RADIUS = 2.8;
export const CAMPFIRE_REST_RADIUS = 3.4;

const _v = new THREE.Vector3();

export class Props {
  readonly group = new THREE.Group();
  readonly items: PropInstance[] = [];
  private materials: THREE.Material[] = [];
  private clock = 0;

  constructor() {
    this.group.name = 'props';
  }

  /**
   * Scatter props over the finished terrain.
   *
   * Campfires prefer gentle ground at a comfortable distance from the shrines;
   * bushes cluster in the greener regions; caches favour the routes between the
   * plaza and the shrines so exploring is rewarded.
   */
  build(world: World, seed: number, looted: readonly number[]): void {
    this.clear();
    const lootedSet = new Set(looted);

    const place = (kind: PropKind, x: number, z: number, id: number): void => {
      const y = world.groundHeight(x, z);
      if (y < SEA_LEVEL + 1.2 || y > 54) return;
      world.normalAt(x, y + 0.2, z, _v);
      if (_v.y < 0.8) return;

      let build;
      let light: THREE.PointLight | null = null;
      let loot: PropInstance['loot'] = null;

      if (kind === 'campfire') {
        build = buildCampfire();
        light = new THREE.PointLight(0xffa347, 6, 18, 2);
        light.position.set(x, y + 1.1, z);
        this.group.add(light);
      } else if (kind === 'bush') {
        build = buildBerryBush();
        loot = { item: 'berries', count: 1 + Math.floor(hash2(Math.round(x), Math.round(z), seed + 61) * 2) };
      } else {
        build = buildSupplyCache();
        const roll = hash2(Math.round(x), Math.round(z), seed + 97);
        loot = roll < 0.12
          ? { item: 'greaterPotion', count: 1 }
          : roll < 0.48
            ? { item: 'minorPotion', count: 1 }
            : { item: 'meal', count: 1 };
      }

      build.group.position.set(x, y - 0.08, z);
      build.group.rotation.y = hash2(Math.round(x), Math.round(z), seed + 5) * Math.PI * 2;
      this.materials.push(...build.materials);
      this.group.add(build.group);

      const instance: PropInstance = {
        id, kind, position: new THREE.Vector3(x, y, z),
        looted: lootedSet.has(id),
        object: build.group,
        light,
        animated: build.animated,
        loot,
      };
      if (instance.looted && kind !== 'campfire') {
        build.group.visible = false;
      }
      this.items.push(instance);
    };

    let id = 0;

    // --- campfires: a sparse ring of way-camps plus a few outliers
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + hash2(i, 3, seed) * 0.5;
      const r = 34 + hash2(i, 7, seed) * 62;
      const x = WORLD_CENTER + Math.cos(a) * r;
      const z = WORLD_CENTER + Math.sin(a) * r;
      if (Math.hypot(x - WORLD_CENTER, z - WORLD_CENTER) < SPAWN_PLAZA_RADIUS + 6) continue;
      place('campfire', x, z, id++);
    }

    // --- caches on the approaches to each shrine
    for (const site of SHRINE_SITES) {
      for (let i = 0; i < 4; i++) {
        const t = 0.3 + i * 0.17;
        const jitterA = (hash2(site.index, i, seed + 13) - 0.5) * 34;
        const jitterB = (hash2(site.index, i, seed + 23) - 0.5) * 34;
        const x = WORLD_CENTER + (site.x - WORLD_CENTER) * t + jitterA;
        const z = WORLD_CENTER + (site.z - WORLD_CENTER) * t + jitterB;
        place('cache', x, z, id++);
      }
    }
    for (let i = 0; i < 12; i++) {
      const a = hash2(i, 41, seed) * Math.PI * 2;
      const r = 24 + hash2(i, 43, seed) * 88;
      place('cache', WORLD_CENTER + Math.cos(a) * r, WORLD_CENTER + Math.sin(a) * r, id++);
    }

    // --- berry bushes scattered through the greener country
    const spacing = 15;
    for (let gx = 10; gx < WORLD_SIZE - 10; gx += spacing) {
      for (let gz = 10; gz < WORLD_SIZE - 10; gz += spacing) {
        const roll = hash2(gx, gz, seed + 1201);
        if (roll > 0.34) continue;
        const x = gx + (hash2(gx, gz, seed + 17) - 0.5) * spacing;
        const z = gz + (hash2(gx, gz, seed + 19) - 0.5) * spacing;
        if (Math.hypot(x - WORLD_CENTER, z - WORLD_CENTER) < SPAWN_PLAZA_RADIUS + 4) continue;
        place('bush', x, z, id++);
      }
    }
  }

  /**
   * Animate nearby props and cull distant ones.
   *
   * Each prop is a small group of meshes, so without distance culling a few
   * hundred of them would cost a few hundred draw calls every frame no matter
   * where the player is standing.
   */
  update(dt: number, viewer?: THREE.Vector3, viewDistance = 90): void {
    this.clock += dt;
    const cullSq = viewDistance * viewDistance;

    for (const prop of this.items) {
      if (prop.looted && prop.kind !== 'campfire') continue;
      const near = !viewer || prop.position.distanceToSquared(viewer) <= cullSq;
      if (prop.object.visible !== near) prop.object.visible = near;
      if (prop.light) prop.light.visible = near;
      if (!near) continue;

      if (prop.kind === 'campfire') {
        const flicker = 0.85 + Math.sin(this.clock * 9 + prop.id) * 0.1 + Math.sin(this.clock * 21 + prop.id * 3) * 0.06;
        for (const part of prop.animated) {
          part.scale.set(0.9 + flicker * 0.2, flicker * 1.1, 0.9 + flicker * 0.2);
          part.rotation.y += dt * 1.6;
        }
        if (prop.light) prop.light.intensity = 5 + flicker * 3;
      } else if (prop.kind === 'cache') {
        for (const part of prop.animated) part.rotation.z += dt * 0.8;
      }
    }
  }

  /** Nearest interactable prop within range, ignoring already-looted ones. */
  nearest(position: THREE.Vector3, radius = PROP_INTERACT_RADIUS): PropInstance | null {
    let best: PropInstance | null = null;
    let bestD = radius * radius;
    for (const prop of this.items) {
      if (prop.kind !== 'campfire' && prop.looted) continue;
      const d = prop.position.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = prop; }
    }
    return best;
  }

  /** True when the player is standing at a campfire and may rest. */
  restSiteNear(position: THREE.Vector3): PropInstance | null {
    for (const prop of this.items) {
      if (prop.kind !== 'campfire') continue;
      if (prop.position.distanceToSquared(position) <= CAMPFIRE_REST_RADIUS * CAMPFIRE_REST_RADIUS) return prop;
    }
    return null;
  }

  /** Mark a prop looted and hide it. */
  loot(prop: PropInstance): { item: ConsumableId; count: number } | null {
    if (prop.looted || !prop.loot) return null;
    prop.looted = true;
    prop.object.visible = false;
    return prop.loot;
  }

  lootedIds(): number[] {
    const out: number[] = [];
    for (const prop of this.items) if (prop.looted) out.push(prop.id);
    return out;
  }

  /** Drop props whose ground the player has excavated. */
  pruneAround(world: World, x: number, z: number, radius: number): void {
    const r2 = (radius + 3) * (radius + 3);
    for (const prop of this.items) {
      if (!prop.object.visible) continue;
      const dx = prop.position.x - x;
      const dz = prop.position.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (world.isSolid(prop.position.x, prop.position.y - 0.6, prop.position.z)) continue;
      // Mark it gone rather than just hiding it, so the culling pass in
      // update() does not bring it back when the player walks near again.
      prop.looted = true;
      prop.object.visible = false;
      if (prop.light) { prop.light.intensity = 0; prop.light.visible = false; }
    }
  }

  clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const mat of this.materials) mat.dispose();
    this.materials.length = 0;
    this.items.length = 0;
  }

  dispose(): void {
    this.clear();
  }
}
