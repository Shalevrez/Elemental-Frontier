/**
 * Trees and shrubs.
 *
 * Placement is deterministic from the world seed, so flora reappears exactly
 * where it was after a reload without needing to be saved. Everything is drawn
 * with instanced meshes and swayed by the shared wind shader.
 */

import * as THREE from 'three';
import { hash2 } from '../core/rng';
import { SEA_LEVEL, WORLD_CENTER, WORLD_SIZE } from './coords';
import { Mat } from './materials';
import { SHRINE_SITES } from './shrineData';
import { SPAWN_PLAZA_RADIUS } from './density';
import {
  applyWind, makeCanopyGeometry, makeConiferGeometry, makeTrunkGeometry,
} from '../render/models';
import type { World } from './World';
import type { ObstacleField } from './Obstacles';

/** Obstacle ids for flora start at 0; props start at their own base. */
export const OBSTACLE_ID_BASE = 0;

interface Placement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  conifer: boolean;
  tint: number;
}

const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _normal = new THREE.Vector3();

export class Flora {
  readonly group = new THREE.Group();
  readonly windTime = { value: 0 };

  private trunks: THREE.InstancedMesh | null = null;
  private canopies: THREE.InstancedMesh | null = null;
  private conifers: THREE.InstancedMesh | null = null;
  private placements: Placement[] = [];
  private coniferPlacements: Placement[] = [];
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private alive: boolean[] = [];
  /** Collision registry, so a felled tree loses its volume immediately. */
  private obstacleField: ObstacleField | null = null;

  constructor() {
    this.group.name = 'flora';
  }

  /**
   * Scatter flora across the finished terrain. Trees only take root on gentle
   * grassy ground away from the shrines, the plaza and the waterline.
   */
  build(world: World, seed: number, density = 1): void {
    this.clear();
    const broadleaf: Placement[] = [];
    const conifers: Placement[] = [];

    const spacing = 4;
    for (let gx = 6; gx < WORLD_SIZE - 6; gx += spacing) {
      for (let gz = 6; gz < WORLD_SIZE - 6; gz += spacing) {
        const jitterX = (hash2(gx, gz, seed + 11) - 0.5) * spacing * 0.9;
        const jitterZ = (hash2(gx, gz, seed + 29) - 0.5) * spacing * 0.9;
        const x = gx + jitterX;
        const z = gz + jitterZ;

        if (Math.hypot(x - WORLD_CENTER, z - WORLD_CENTER) < SPAWN_PLAZA_RADIUS + 5) continue;
        let nearShrine = false;
        for (const site of SHRINE_SITES) {
          if (Math.hypot(x - site.x, z - site.z) < 18) { nearShrine = true; break; }
        }
        if (nearShrine) continue;

        const forest = hash2(Math.round(x / 9), Math.round(z / 9), seed + 4242);
        const roll = hash2(Math.round(x), Math.round(z), seed + 9137);
        if (roll > forest * 0.55 * density) continue;

        const y = world.groundHeight(x, z);
        if (y < SEA_LEVEL + 1.5 || y > 52) continue;

        // Refuse steep ground: trees look wrong growing out of a cliff face.
        world.normalAt(x, y + 0.2, z, _normal);
        if (_normal.y < 0.72) continue;

        const surface = world.materialAt(x, y - 0.4, z);
        if (surface !== Mat.GRASS && surface !== Mat.SOIL) continue;

        const cold = hash2(Math.round(x / 40), Math.round(z / 40), seed + 777) < 0.32;
        const scale = 0.75 + hash2(Math.round(x), Math.round(z), seed + 313) * 0.7;
        const place: Placement = {
          x, y: y - 0.3, z, scale,
          rotation: hash2(Math.round(x), Math.round(z), seed + 55) * Math.PI * 2,
          conifer: cold,
          tint: 0.82 + hash2(Math.round(x), Math.round(z), seed + 88) * 0.36,
        };
        if (cold) conifers.push(place);
        else broadleaf.push(place);
      }
    }

    this.placements = broadleaf;
    this.coniferPlacements = conifers;
    this.alive = new Array(broadleaf.length + conifers.length).fill(true);

    this.buildBroadleaf(broadleaf);
    this.buildConifers(conifers);
  }

  private buildBroadleaf(list: Placement[]): void {
    if (list.length === 0) return;
    const trunkGeo = makeTrunkGeometry(5, 0.32);
    const canopyGeo = makeCanopyGeometry(2.2, 11);
    this.geometries.push(trunkGeo, canopyGeo);

    const barkMat = new THREE.MeshStandardMaterial({ color: 0x6d4c31, roughness: 0.92 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x4e9440, roughness: 0.88, flatShading: true });
    applyWind(leafMat, this.windTime, 1);
    applyWind(barkMat, this.windTime, 0.25);
    this.materials.push(barkMat, leafMat);

    const trunks = new THREE.InstancedMesh(trunkGeo, barkMat, list.length);
    const canopies = new THREE.InstancedMesh(canopyGeo, leafMat, list.length);
    trunks.castShadow = true;
    canopies.castShadow = true;
    canopies.receiveShadow = true;
    trunks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    canopies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);

    list.forEach((p, i) => {
      _quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotation);
      _pos.set(p.x, p.y, p.z);
      _scale.setScalar(p.scale);
      _mat.compose(_pos, _quat, _scale);
      trunks.setMatrixAt(i, _mat);

      _pos.set(p.x, p.y + 4.5 * p.scale, p.z);
      _scale.setScalar(p.scale * (0.85 + (p.tint - 0.82) * 0.6));
      _mat.compose(_pos, _quat, _scale);
      canopies.setMatrixAt(i, _mat);

      // instanceColor multiplies the material colour, so it must be a
      // near-white tint - putting the hue here too would square it and turn
      // every tree almost black.
      _color.setRGB(p.tint, p.tint, p.tint);
      trunks.setColorAt(i, _color);
      _color.setRGB(p.tint, p.tint * 1.04, p.tint * 0.96);
      canopies.setColorAt(i, _color);
    });
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    this.group.add(trunks, canopies);
    this.trunks = trunks;
    this.canopies = canopies;
  }

  private buildConifers(list: Placement[]): void {
    if (list.length === 0) return;
    const geo = makeConiferGeometry(6, 1.8);
    this.geometries.push(geo);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f6b48, roughness: 0.9, flatShading: true });
    applyWind(mat, this.windTime, 0.55);
    this.materials.push(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    list.forEach((p, i) => {
      _quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotation);
      _pos.set(p.x, p.y, p.z);
      _scale.set(p.scale * 0.9, p.scale * 1.15, p.scale * 0.9);
      _mat.compose(_pos, _quat, _scale);
      mesh.setMatrixAt(i, _mat);
      _color.setRGB(p.tint, p.tint, p.tint);
      mesh.setColorAt(i, _color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.conifers = mesh;
  }

  update(dt: number): void {
    this.windTime.value += dt;
  }

  /**
   * Give every trunk a matching collision cylinder.
   *
   * Trees were previously drawn but never collided with, so the player walked
   * straight through them. The cylinder matches the visible trunk radius, and
   * only the trunk is solid - the canopy overhead is deliberately passable, so
   * there are no invisible walls where the leaves are.
   */
  registerObstacles(field: ObstacleField): void {
    this.obstacleField = field;
    const add = (list: Placement[], offset: number, conifer: boolean): void => {
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        const id = OBSTACLE_ID_BASE + offset + i;
        field.remove(id);
        if (!this.alive[offset + i]) continue;
        field.add({
          id, kind: conifer ? 'conifer' : 'tree', shape: 'cylinder',
          x: p.x, y: p.y - 0.4, z: p.z,
          radius: (conifer ? 0.32 : 0.38) * p.scale,
          height: (conifer ? 4.6 : 3.8) * p.scale,
          solid: true, destructible: true,
        });
      }
    };
    add(this.placements, 0, false);
    add(this.coniferPlacements, this.placements.length, true);
  }

  /**
   * Remove any tree whose roots the player has excavated, so nothing is left
   * hanging in mid-air over a fresh tunnel.
   */
  pruneAround(world: World, x: number, z: number, radius: number): void {
    const r2 = (radius + 3) * (radius + 3);
    const check = (list: Placement[], mesh: THREE.InstancedMesh | null, offset: number): void => {
      if (!mesh) return;
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        if (!this.alive[offset + i]) continue;
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz > r2) continue;
        // Still rooted? Sample just under the trunk base.
        if (world.isSolid(p.x, p.y - 0.5, p.z)) continue;
        this.alive[offset + i] = false;
        // The collision volume has to go with the visual, immediately, or the
        // player walks into a tree that is no longer there.
        this.obstacleField?.remove(OBSTACLE_ID_BASE + offset + i);
        _pos.set(p.x, -999, p.z);
        _quat.identity();
        _scale.setScalar(0.0001);
        _mat.compose(_pos, _quat, _scale);
        mesh.setMatrixAt(i, _mat);
        changed = true;
      }
      if (changed) mesh.instanceMatrix.needsUpdate = true;
    };
    check(this.placements, this.trunks, 0);
    check(this.placements, this.canopies, 0);
    check(this.coniferPlacements, this.conifers, this.placements.length);
  }

  clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const geo of this.geometries) geo.dispose();
    for (const mat of this.materials) mat.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.trunks = null;
    this.canopies = null;
    this.conifers = null;
    this.placements = [];
    this.coniferPlacements = [];
    this.alive = [];
  }

  dispose(): void {
    this.clear();
  }
}
