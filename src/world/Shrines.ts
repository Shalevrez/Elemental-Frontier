/**
 * The four blighted shrines: sculpted presentation, guardian encounters in
 * Normal Mode, the mote ritual in Peaceful Mode, and cleansing.
 */

import * as THREE from 'three';
import type { World } from './World';
import type { Particles } from '../fx/Particles';
import type { EnemyManager } from '../combat/Enemies';
import { ELEMENTS } from '../elements/elements';
import { buildMote, buildShrine, type ShrineBuild } from '../render/models';
import {
  GUARDIAN_WAKE_RADIUS, MOTES_PER_SHRINE, MOTE_INTERACT_RADIUS, MOTE_OFFSETS,
  SHRINE_INTERACT_RADIUS, SHRINE_SITES, canCleanse, type ShrineSite, type WorldMode,
} from './shrineData';
import { SEA_LEVEL } from './coords';

export interface MoteRuntime {
  index: number;
  gathered: boolean;
  position: THREE.Vector3;
  object: THREE.Object3D;
  animated: THREE.Object3D[];
  light: THREE.PointLight;
}

export interface ShrineRuntime {
  readonly site: ShrineSite;
  cleansed: boolean;
  guardianDefeated: boolean;
  guardianSpawned: boolean;
  /** Dais centre - where the player stands to cleanse. */
  readonly anchor: THREE.Vector3;
  /** Glowing core position in world space. */
  readonly core: THREE.Vector3;
  build: ShrineBuild;
  light: THREE.PointLight;
  motes: MoteRuntime[];
}

export interface ShrineInteraction {
  index: number;
  distance: number;
  status: 'cleanse' | 'guardian' | 'ritual' | 'done';
  /** Motes still to gather, when status is 'ritual'. */
  motesLeft: number;
}

const _tmp = new THREE.Vector3();

export class ShrineManager {
  readonly group = new THREE.Group();
  readonly shrines: ShrineRuntime[] = [];
  private clock = 0;
  private mode: WorldMode = 'normal';
  private materials: THREE.Material[] = [];

  constructor(private readonly world: World, private readonly particles: Particles) {
    this.group.name = 'shrines';
  }

  setMode(mode: WorldMode): void {
    this.mode = mode;
    for (const shrine of this.shrines) {
      const showMotes = mode === 'peaceful' && !shrine.cleansed;
      for (const mote of shrine.motes) {
        mote.object.visible = showMotes && !mote.gathered;
        mote.light.intensity = mote.object.visible ? 3 : 0;
      }
    }
  }

  get worldMode(): WorldMode {
    return this.mode;
  }

  build(
    cleansedFlags: readonly boolean[],
    guardianFlags: readonly boolean[],
    moteFlags: readonly (readonly boolean[])[],
    mode: WorldMode,
  ): void {
    this.clearMeshes();
    this.mode = mode;

    for (const site of SHRINE_SITES) {
      const ground = this.world.groundHeight(site.x, site.z);
      const anchor = new THREE.Vector3(site.x, ground, site.z);
      const cleansed = cleansedFlags[site.index] === true;
      const element = ELEMENTS[site.element];

      const build = buildShrine(site.index, site.element, cleansed);
      build.group.position.copy(anchor);
      // Sink the dais slightly so it meets the smooth ground without a lip.
      build.group.position.y -= 0.9;
      this.materials.push(...build.materials);
      this.group.add(build.group);

      const core = new THREE.Vector3(anchor.x, anchor.y - 0.9 + build.coreHeight, anchor.z);

      const light = new THREE.PointLight(cleansed ? element.color : 0xa855f7, cleansed ? 8 : 5, 42, 2);
      light.position.copy(core);
      this.group.add(light);

      const motes: MoteRuntime[] = [];
      for (let m = 0; m < MOTES_PER_SHRINE; m++) {
        const [ox, oz] = MOTE_OFFSETS[m]!;
        const mx = site.x + ox;
        const mz = site.z + oz;
        const my = Math.max(SEA_LEVEL + 1, this.world.groundHeight(mx, mz)) + 1.5;
        const moteBuild = buildMote(element.color);
        moteBuild.group.position.set(mx, my, mz);
        this.materials.push(...moteBuild.materials);
        this.group.add(moteBuild.group);

        const moteLight = new THREE.PointLight(element.color, 3, 16, 2);
        moteLight.position.set(mx, my, mz);
        this.group.add(moteLight);

        const gathered = moteFlags[site.index]?.[m] === true;
        const visible = mode === 'peaceful' && !cleansed && !gathered;
        moteBuild.group.visible = visible;
        moteLight.intensity = visible ? 3 : 0;

        motes.push({
          index: m, gathered,
          position: new THREE.Vector3(mx, my, mz),
          object: moteBuild.group,
          animated: moteBuild.animated,
          light: moteLight,
        });
      }

      this.shrines.push({
        site,
        cleansed,
        guardianDefeated: guardianFlags[site.index] === true,
        guardianSpawned: false,
        anchor,
        core,
        build,
        light,
        motes,
      });
    }
  }

  update(dt: number, playerPos: THREE.Vector3, enemies: EnemyManager, peaceful: boolean): void {
    this.clock += dt;

    for (const shrine of this.shrines) {
      const dist = _tmp.copy(playerPos).sub(shrine.anchor).length();
      const element = ELEMENTS[shrine.site.element];

      // Sculpted pieces drift and turn.
      for (let i = 0; i < shrine.build.animated.length; i++) {
        const part = shrine.build.animated[i]!;
        part.rotation.z += dt * (0.15 + i * 0.04) * (shrine.cleansed ? 1 : 0.6);
        part.rotation.y += dt * 0.2;
      }
      shrine.build.core.position.y = shrine.core.y - shrine.build.group.position.y
        + Math.sin(this.clock * 1.5 + shrine.site.index) * 0.22;
      shrine.light.intensity = (shrine.cleansed ? 8 : 5) + Math.sin(this.clock * 2.1 + shrine.site.index) * 1.4;

      // Motes bob and spin.
      for (const mote of shrine.motes) {
        if (!mote.object.visible) continue;
        mote.object.position.y = mote.position.y + Math.sin(this.clock * 1.7 + mote.index * 2) * 0.28;
        mote.light.position.copy(mote.object.position);
        for (let i = 0; i < mote.animated.length; i++) {
          mote.animated[i]!.rotation.y += dt * (0.9 + i * 0.5);
          mote.animated[i]!.rotation.x += dt * 0.4;
        }
        if (Math.random() < dt * 14) {
          this.particles.spark({
            count: 1,
            x: mote.object.position.x, y: mote.object.position.y, z: mote.object.position.z,
            spread: 0.5, vy: 0.8, jitter: 0.5,
            color: element.color, color2: 0xffffff,
            size: 0.28, life: 1.4, gravity: 0.3, drag: 0.4,
          });
        }
      }

      if (dist < 70) {
        if (shrine.cleansed) {
          if (Math.random() < dt * 24) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * 9;
            this.particles.spark({
              count: 1,
              x: shrine.anchor.x + Math.cos(a) * r,
              y: shrine.anchor.y + Math.random() * 3,
              z: shrine.anchor.z + Math.sin(a) * r,
              vy: 1.1 + Math.random(), jitter: 0.3,
              color: element.color, color2: 0xffffff,
              size: 0.3, life: 2.4, gravity: 0.4, drag: 0.3,
            });
          }
        } else if (Math.random() < dt * 30) {
          const a = Math.random() * Math.PI * 2;
          const r = 2 + Math.random() * 9;
          this.particles.spark({
            count: 1,
            x: shrine.anchor.x + Math.cos(a) * r,
            y: shrine.anchor.y + 7 + Math.random() * 7,
            z: shrine.anchor.z + Math.sin(a) * r,
            vy: -1.4, jitter: 0.4,
            color: 0xb96bff, color2: 0x6b3f8e,
            size: 0.34, life: 2.6, gravity: -0.6, drag: 0.2,
          });
        }
      }

      // Guardian wake-up, Normal Mode only.
      if (!peaceful && !shrine.cleansed && !shrine.guardianDefeated
          && !shrine.guardianSpawned && dist < GUARDIAN_WAKE_RADIUS + 6) {
        const gx = shrine.anchor.x + 8;
        const gz = shrine.anchor.z + 8;
        const gy = this.world.groundHeight(gx, gz) + 0.2;
        enemies.spawnGuardian(shrine.site.index, _tmp.set(gx, gy, gz));
        shrine.guardianSpawned = true;
      }
    }
  }

  /** Restore guardians for uncleansed shrines when returning to Normal Mode. */
  resetGuardianSpawns(): void {
    for (const shrine of this.shrines) {
      if (!shrine.cleansed) shrine.guardianSpawned = false;
    }
  }

  /** Nearest gatherable mote within reach, if any. */
  nearestMote(playerPos: THREE.Vector3): { shrine: number; mote: MoteRuntime } | null {
    if (this.mode !== 'peaceful') return null;
    for (const shrine of this.shrines) {
      if (shrine.cleansed) continue;
      for (const mote of shrine.motes) {
        if (mote.gathered) continue;
        if (mote.object.position.distanceTo(playerPos) <= MOTE_INTERACT_RADIUS) {
          return { shrine: shrine.site.index, mote };
        }
      }
    }
    return null;
  }

  gatherMote(shrineIndex: number, mote: MoteRuntime): void {
    const shrine = this.shrines[shrineIndex];
    if (!shrine || mote.gathered) return;
    mote.gathered = true;
    mote.object.visible = false;
    mote.light.intensity = 0;
    const element = ELEMENTS[shrine.site.element];
    this.particles.spark({
      count: 60, x: mote.position.x, y: mote.position.y, z: mote.position.z,
      spread: 0.6, jitter: 5, color: element.color, color2: 0xffffff,
      size: 0.42, life: 1.1, gravity: 1.2, drag: 0.8,
    });
  }

  motesGathered(shrineIndex: number): boolean[] {
    const shrine = this.shrines[shrineIndex];
    if (!shrine) return [false, false, false];
    return shrine.motes.map((m) => m.gathered);
  }

  /** What the player can do at the shrine they are standing in, if any. */
  getInteraction(playerPos: THREE.Vector3, enemies: EnemyManager): ShrineInteraction | null {
    let best: ShrineInteraction | null = null;
    for (const shrine of this.shrines) {
      const dx = playerPos.x - shrine.anchor.x;
      const dz = playerPos.z - shrine.anchor.z;
      const dy = Math.abs(playerPos.y - shrine.anchor.y);
      const dist = Math.hypot(dx, dz);
      if (dist > SHRINE_INTERACT_RADIUS || dy > 16) continue;

      const motes = shrine.motes.map((m) => m.gathered);
      const guardianClear = shrine.guardianDefeated && !enemies.hasGuardian(shrine.site.index);
      let status: ShrineInteraction['status'];
      if (shrine.cleansed) status = 'done';
      else if (canCleanse(this.mode, guardianClear, motes)) status = 'cleanse';
      else if (this.mode === 'peaceful') status = 'ritual';
      else status = 'guardian';

      const motesLeft = MOTES_PER_SHRINE - motes.filter(Boolean).length;
      if (!best || dist < best.distance) {
        best = { index: shrine.site.index, distance: dist, status, motesLeft };
      }
    }
    return best;
  }

  markGuardianDefeated(index: number): void {
    const shrine = this.shrines[index];
    if (shrine) shrine.guardianDefeated = true;
  }

  /** Permanent world change on cleansing. */
  cleanse(index: number): void {
    const shrine = this.shrines[index];
    if (!shrine || shrine.cleansed) return;
    shrine.cleansed = true;
    const element = ELEMENTS[shrine.site.element];

    // Repaint the sculpture from blighted to cleansed.
    shrine.light.color.setHex(element.color);
    for (const mat of shrine.build.materials) {
      const std = mat as THREE.MeshStandardMaterial;
      if (!std.emissive) continue;
      std.emissive.setHex(element.color);
      std.emissiveIntensity = Math.max(0.8, std.emissiveIntensity * 0.7);
      if (std.color) std.color.lerp(new THREE.Color(0xd6e4f0), 0.55);
    }
    for (const mote of shrine.motes) {
      mote.object.visible = false;
      mote.light.intensity = 0;
    }

    for (let i = 0; i < 200; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 13;
      this.particles.spark({
        count: 1,
        x: shrine.anchor.x + Math.cos(a) * r,
        y: shrine.anchor.y + Math.random() * 2,
        z: shrine.anchor.z + Math.sin(a) * r,
        vy: 6 + Math.random() * 9, jitter: 2.6,
        color: element.color, color2: 0xffffff,
        size: 0.5, life: 1.9, lifeJitter: 0.5, gravity: -2, drag: 0.5,
      });
    }
    this.particles.debris({
      count: 90, x: shrine.anchor.x, y: shrine.anchor.y + 1.5, z: shrine.anchor.z,
      spread: 6, jitter: 7, color: 0x4a2769, color2: 0xb96bff,
      size: 0.3, life: 1.6, gravity: -12, drag: 0.6,
    });
  }

  /** Influence 0..1 of the nearest shrine, used to tint fog and light. */
  environmentTint(playerPos: THREE.Vector3, out: THREE.Color): number {
    let strongest = 0;
    let index = -1;
    for (const shrine of this.shrines) {
      const d = Math.hypot(playerPos.x - shrine.anchor.x, playerPos.z - shrine.anchor.z);
      const influence = Math.max(0, 1 - d / 55);
      if (influence > strongest) { strongest = influence; index = shrine.site.index; }
    }
    if (index < 0) return 0;
    const shrine = this.shrines[index]!;
    if (shrine.cleansed) out.setHex(ELEMENTS[shrine.site.element].color);
    else out.setHex(0x7a3fa8);
    return strongest;
  }

  /** A cleansed shrine close enough to rest at. */
  restSiteNear(playerPos: THREE.Vector3): ShrineRuntime | null {
    for (const shrine of this.shrines) {
      if (!shrine.cleansed) continue;
      if (Math.hypot(playerPos.x - shrine.anchor.x, playerPos.z - shrine.anchor.z) <= SHRINE_INTERACT_RADIUS + 2) {
        return shrine;
      }
    }
    return null;
  }

  private clearMeshes(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const mat of this.materials) mat.dispose();
    this.materials.length = 0;
    this.shrines.length = 0;
  }

  dispose(): void {
    this.clearMeshes();
  }
}
