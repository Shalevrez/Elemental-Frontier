/**
 * Pooled projectiles used by both the player's abilities and the enemies.
 *
 * Every projectile is a smooth 3D shape - an irregular boulder, a glowing
 * ember, a faceted bolt - and collides against the continuous density field
 * rather than a voxel grid.
 */

import * as THREE from 'three';
import type { World } from '../world/World';
import { makeRockGeometry } from '../render/models';

export type ProjectileKind = 'rock' | 'fireball' | 'bolt' | 'orb';
export type ProjectileOwner = 'player' | 'enemy';

export interface ProjectileSpawn {
  kind: ProjectileKind;
  owner: ProjectileOwner;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  damage: number;
  radius: number;
  blast?: number;
  life?: number;
  gravity?: number;
  knockback?: number;
  burn?: number;
  slow?: number;
  stagger?: number;
  color?: number;
  /** Times the shot may rebound off terrain before it stops. */
  bounces?: number;
  /** Smaller shards spawned on impact. */
  fragments?: number;
  /** Element used for reactions and resistances. */
  element?: 'fire' | 'water' | 'earth' | 'air';
  /** Who fired it, so reflections can be sent back. */
  sourceId?: number;
  /** Set when Air reflected it back toward its owner. */
  homingBack?: boolean;
}

export interface Projectile extends ProjectileSpawn {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  maxLife: number;
  mesh: THREE.Object3D;
  light: THREE.PointLight | null;
  deflected: boolean;
  spin: THREE.Vector3;
  /** Remaining rebounds. */
  bouncesLeft: number;
  /** Where it was fired from, used by reflect-to-source. */
  originPoint: THREE.Vector3;
}

export interface ProjectileHooks {
  onImpact(p: Projectile, point: THREE.Vector3, hitEntity: boolean): void;
  /**
   * Continuous entity test over the segment the projectile travelled this
   * frame. Returning a point means "it hit something there"; null means it
   * passed through cleanly.
   */
  onEntitySweep(p: Projectile, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 | null;
  onTrail(p: Projectile): void;
}

const _tmp = new THREE.Vector3();
const _from = new THREE.Vector3();

export class Projectiles {
  readonly group = new THREE.Group();
  private readonly active: Projectile[] = [];
  private readonly pool = new Map<ProjectileKind, THREE.Object3D[]>();
  private readonly geometries = new Map<ProjectileKind, THREE.BufferGeometry>();
  private readonly materials: THREE.Material[] = [];
  private lights: THREE.PointLight[] = [];
  /** Lights are expensive; only the newest few glowing shots get one. */
  private maxLights = 4;

  constructor(private readonly hooks: ProjectileHooks) {
    this.group.name = 'projectiles';
  }

  private geometryFor(kind: ProjectileKind): THREE.BufferGeometry {
    let geo = this.geometries.get(kind);
    if (geo) return geo;
    switch (kind) {
      case 'rock':
        geo = makeRockGeometry(0.36, 1, 0.34, 1234);
        break;
      case 'fireball':
        geo = new THREE.IcosahedronGeometry(0.3, 1);
        break;
      case 'orb':
        geo = new THREE.IcosahedronGeometry(0.38, 1);
        break;
      default:
        geo = new THREE.OctahedronGeometry(0.24, 0);
        break;
    }
    this.geometries.set(kind, geo);
    return geo;
  }

  private createMesh(kind: ProjectileKind, color: number): THREE.Object3D {
    const geo = this.geometryFor(kind);
    let mat: THREE.Material;
    if (kind === 'rock') {
      mat = new THREE.MeshStandardMaterial({ color: 0x8b7d68, roughness: 0.92, metalness: 0.05 });
    } else {
      mat = new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: kind === 'fireball' ? 4.2 : 3,
        roughness: 0.3,
      });
    }
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    return mesh;
  }

  private obtain(kind: ProjectileKind, color: number): THREE.Object3D {
    const bucket = this.pool.get(kind);
    const reused = bucket?.pop();
    if (reused) {
      const mat = (reused as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (kind !== 'rock' && mat.color) {
        mat.color.setHex(color);
        mat.emissive.setHex(color);
      }
      reused.visible = true;
      return reused;
    }
    return this.createMesh(kind, color);
  }

  private release(kind: ProjectileKind, mesh: THREE.Object3D): void {
    mesh.visible = false;
    this.group.remove(mesh);
    let bucket = this.pool.get(kind);
    if (!bucket) { bucket = []; this.pool.set(kind, bucket); }
    if (bucket.length < 24) bucket.push(mesh);
    else {
      const m = mesh as THREE.Mesh;
      (m.material as THREE.Material).dispose();
    }
  }

  private obtainLight(color: number): THREE.PointLight | null {
    if (this.lights.length >= this.maxLights) return null;
    const light = new THREE.PointLight(color, 9, 14, 2);
    this.group.add(light);
    this.lights.push(light);
    return light;
  }

  private releaseLight(light: THREE.PointLight | null): void {
    if (!light) return;
    this.group.remove(light);
    const i = this.lights.indexOf(light);
    if (i >= 0) this.lights.splice(i, 1);
    light.dispose();
  }

  spawn(spec: ProjectileSpawn): Projectile {
    const color = spec.color ?? 0xffffff;
    const mesh = this.obtain(spec.kind, color);
    mesh.position.copy(spec.origin);
    this.group.add(mesh);
    const glowing = spec.kind === 'fireball' || spec.kind === 'orb' || spec.kind === 'bolt';
    const p: Projectile = {
      ...spec,
      alive: true,
      pos: spec.origin.clone(),
      vel: spec.direction.clone().normalize().multiplyScalar(spec.speed),
      age: 0,
      maxLife: spec.life ?? 3,
      mesh,
      light: glowing ? this.obtainLight(color) : null,
      deflected: false,
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      ),
      bouncesLeft: spec.bounces ?? 0,
      originPoint: spec.origin.clone(),
      color,
    };
    this.active.push(p);
    return p;
  }

  /** Enemy projectiles inside a cone are turned back on their owner. */
  deflect(
    origin: THREE.Vector3, forward: THREE.Vector3, range: number,
    cosAngle: number, newSpeed: number, towardSource = false,
  ): number {
    let count = 0;
    for (const p of this.active) {
      if (!p.alive || p.owner !== 'enemy') continue;
      _tmp.copy(p.pos).sub(origin);
      const dist = _tmp.length();
      if (dist > range || dist < 0.001) continue;
      _tmp.divideScalar(dist);
      if (_tmp.dot(forward) < cosAngle) continue;
      p.owner = 'player';
      p.deflected = true;
      p.damage *= 1.6;
      if (towardSource && p.originPoint) {
        // Send it straight back down the line it came from.
        _tmp.copy(p.originPoint).sub(p.pos);
        if (_tmp.lengthSq() > 0.01) p.vel.copy(_tmp.normalize()).multiplyScalar(newSpeed);
        else p.vel.copy(forward).multiplyScalar(newSpeed);
      } else {
        p.vel.copy(forward).multiplyScalar(newSpeed);
      }
      p.age = 0;
      p.maxLife = 2.4;
      const mat = (p.mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (mat.color) {
        mat.color.setHex(0xd6f4ff);
        mat.emissive.setHex(0xd6f4ff);
      }
      count++;
    }
    return count;
  }

  /** Cancel every projectile belonging to one side (used by Peaceful Mode). */
  clearOwner(owner: ProjectileOwner): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i]!.owner === owner) this.retire(i);
    }
  }

  /** Live projectiles, for the combat debug overlay. */
  get liveShots(): readonly Projectile[] {
    return this.active;
  }

  update(dt: number, world: World): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      if (!p.alive) { this.retire(i); continue; }

      p.age += dt;
      if (p.age > p.maxLife) {
        this.hit(p, p.pos, false);
        this.retire(i);
        continue;
      }

      if (p.gravity) p.vel.y -= p.gravity * dt;

      // Terrain is still marched in small steps (the density field has no
      // analytic sweep), but creatures get a true swept test over the whole
      // segment so a fast shot can never skip past a body between frames.
      const stepLen = p.vel.length() * dt;
      const steps = Math.max(1, Math.ceil(stepLen / 0.5));
      let impacted = false;

      for (let s = 0; s < steps && !impacted; s++) {
        _from.copy(p.pos);
        _tmp.copy(p.vel).multiplyScalar(dt / steps);
        p.pos.add(_tmp);

        const entityPoint = this.hooks.onEntitySweep(p, _from, p.pos);
        if (entityPoint) {
          p.pos.copy(entityPoint);
          this.hit(p, p.pos, true);
          impacted = true;
          break;
        }

        if (world.isSolid(p.pos.x, p.pos.y, p.pos.z)) {
          if (p.bouncesLeft > 0) {
            p.bouncesLeft--;
            world.normalAt(p.pos.x, p.pos.y, p.pos.z, _tmp);
            const into = p.vel.dot(_tmp);
            p.vel.addScaledVector(_tmp, -2 * into).multiplyScalar(0.82);
            p.pos.addScaledVector(_tmp, 0.35);
            this.hooks.onImpact(p, p.pos, false);
          } else {
            this.hit(p, p.pos, false);
            impacted = true;
          }
        }
      }

      if (impacted) { this.retire(i); continue; }

      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      if (p.light) p.light.position.copy(p.pos);
      this.hooks.onTrail(p);
    }
  }

  private hit(p: Projectile, point: THREE.Vector3, entity: boolean): void {
    p.alive = false;
    this.hooks.onImpact(p, point, entity);
  }

  private retire(index: number): void {
    const p = this.active[index]!;
    p.alive = false;
    this.releaseLight(p.light);
    p.light = null;
    this.release(p.kind, p.mesh);
    this.active.splice(index, 1);
  }

  get count(): number { return this.active.length; }

  setMaxLights(n: number): void {
    this.maxLights = Math.max(0, n);
  }

  clear(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.retire(i);
  }

  dispose(): void {
    this.clear();
    for (const bucket of this.pool.values()) {
      for (const mesh of bucket) {
        (( mesh as THREE.Mesh).material as THREE.Material).dispose();
      }
    }
    this.pool.clear();
    for (const geo of this.geometries.values()) geo.dispose();
    this.geometries.clear();
    for (const mat of this.materials) mat.dispose();
    this.materials.length = 0;
    for (const light of this.lights) light.dispose();
    this.lights.length = 0;
    this.group.clear();
  }
}
