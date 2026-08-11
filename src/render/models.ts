/**
 * Smooth stylised 3D model builders.
 *
 * Everything the player sees that is not terrain is assembled here from
 * rounded primitives - capsules, lathes, tori, displaced icospheres - so no
 * part of the game reads as a stack of cubes. All geometry is generated at
 * runtime; the project still ships no model files.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import { ELEMENTS } from '../elements/elements';
import type { ElementId } from '../elements/affinity';

const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

function track<T extends THREE.BufferGeometry | THREE.Material>(item: T): T {
  disposables.push(item);
  return item;
}

/**
 * Geometry cache.
 *
 * Props are built hundreds of times; without this every bush and campfire
 * would allocate its own copies of the same shapes, which quickly runs into
 * thousands of buffers.
 */
const geoCache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geo = geoCache.get(key);
  if (!geo) {
    geo = track(make());
    geoCache.set(key, geo);
  }
  return geo;
}

export function disposeModelLibrary(): void {
  for (const item of disposables) item.dispose();
  disposables.length = 0;
  geoCache.clear();
}

// --------------------------------------------------------------- helpers

/**
 * Irregular rounded rock. An icosphere whose vertices are pushed along their
 * own normals by seeded noise, then smoothed - reads as a boulder, never as a
 * cube.
 */
export function makeRockGeometry(radius = 1, detail = 1, roughness = 0.32, seed = 7): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const rnd = mulberry32(seed);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  // Hash by rounded position so shared vertices move together and the shell
  // stays watertight.
  const cache = new Map<string, number>();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let scale = cache.get(key);
    if (scale === undefined) {
      scale = 1 + (rnd() - 0.5) * 2 * roughness;
      cache.set(key, scale);
    }
    v.multiplyScalar(scale);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return track(geo);
}

/** Smoothly tapered trunk with a slight lean. */
export function makeTrunkGeometry(height = 5, radius = 0.34): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius * 0.55, radius, height, 8, 3, false);
  geo.translate(0, height / 2, 0);
  // Gentle organic bend so trunks are not perfect cylinders.
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = v.y / height;
    v.x += Math.sin(t * 2.1) * 0.16 * t;
    v.z += Math.cos(t * 1.7) * 0.13 * t;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return track(geo);
}

/** Rounded canopy blob: three overlapping icospheres merged into one shell. */
export function makeCanopyGeometry(radius = 2.1, seed = 11): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, 2);
  const rnd = mulberry32(seed);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const cache = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
    let s = cache.get(key);
    if (s === undefined) {
      s = 1 + (rnd() - 0.5) * 0.28;
      cache.set(key, s);
    }
    v.multiplyScalar(s);
    // Flatten slightly so canopies read as broad rather than spherical.
    v.y *= 0.78;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return track(geo);
}

/** Slim conifer cone for the colder, higher ground. */
export function makeConiferGeometry(height = 5, radius = 1.7): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(radius, height, 9, 3);
  geo.translate(0, height / 2, 0);
  return track(geo);
}

/**
 * Injects a wind sway into any material. The vertex shader displaces geometry
 * horizontally by a noise-ish function of world position and time, scaled by
 * how high the vertex sits, so trunks stay planted while canopies move.
 */
export function applyWind(material: THREE.Material, uniforms: { value: number }, strength = 1): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = uniforms as unknown as THREE.IUniform;
    shader.uniforms.uWindStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uWindTime;
         uniform float uWindStrength;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 wp = modelMatrix * vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
           #endif
           float sway = sin(uWindTime * 1.3 + wp.x * 0.18 + wp.z * 0.11)
                      + 0.5 * sin(uWindTime * 2.1 + wp.z * 0.23);
           float h = clamp(transformed.y * 0.18, 0.0, 1.4);
           transformed.x += sway * 0.13 * h * uWindStrength;
           transformed.z += cos(uWindTime * 1.1 + wp.x * 0.14) * 0.10 * h * uWindStrength;
         }`,
      );
  };
  material.needsUpdate = true;
}

// ---------------------------------------------------------------- enemies

export interface CreatureBuild {
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  /** Parts animated by the enemy update (legs, shards, arms, crown). */
  animated: THREE.Object3D[];
  /** Emissive parts that carry the accent colour. */
  glow: THREE.MeshStandardMaterial;
  /**
   * Local-space offset of the creature's weak point, if it has one.
   *
   * Hits landing here count for extra damage, so "aim for the exposed core"
   * is a real tactic rather than flavour text.
   */
  weakPoint?: { x: number; y: number; z: number };
}

const sharedGeo = {
  crawlerBody: null as THREE.BufferGeometry | null,
  crawlerHead: null as THREE.BufferGeometry | null,
  leg: null as THREE.BufferGeometry | null,
  spike: null as THREE.BufferGeometry | null,
  eye: null as THREE.BufferGeometry | null,
  wispCore: null as THREE.BufferGeometry | null,
  wispShard: null as THREE.BufferGeometry | null,
  guardTorso: null as THREE.BufferGeometry | null,
  guardHead: null as THREE.BufferGeometry | null,
  guardLimb: null as THREE.BufferGeometry | null,
  crown: null as THREE.BufferGeometry | null,
  mote: null as THREE.BufferGeometry | null,
};

function geoCrawlerBody(): THREE.BufferGeometry {
  if (!sharedGeo.crawlerBody) {
    const g = new THREE.IcosahedronGeometry(0.62, 2);
    g.scale(1.0, 0.72, 1.32);
    sharedGeo.crawlerBody = track(g);
  }
  return sharedGeo.crawlerBody;
}

function geoCrawlerHead(): THREE.BufferGeometry {
  if (!sharedGeo.crawlerHead) {
    const g = new THREE.IcosahedronGeometry(0.34, 2);
    g.scale(1.1, 0.85, 1.0);
    sharedGeo.crawlerHead = track(g);
  }
  return sharedGeo.crawlerHead;
}

function geoLeg(): THREE.BufferGeometry {
  if (!sharedGeo.leg) {
    const g = new THREE.CapsuleGeometry(0.09, 0.34, 4, 8);
    sharedGeo.leg = track(g);
  }
  return sharedGeo.leg;
}

function geoSpike(): THREE.BufferGeometry {
  if (!sharedGeo.spike) sharedGeo.spike = track(new THREE.ConeGeometry(0.11, 0.42, 7));
  return sharedGeo.spike;
}

function geoEye(): THREE.BufferGeometry {
  if (!sharedGeo.eye) sharedGeo.eye = track(new THREE.SphereGeometry(0.075, 10, 8));
  return sharedGeo.eye;
}

function geoWispCore(): THREE.BufferGeometry {
  if (!sharedGeo.wispCore) sharedGeo.wispCore = track(new THREE.IcosahedronGeometry(0.36, 2));
  return sharedGeo.wispCore;
}

function geoWispShard(): THREE.BufferGeometry {
  if (!sharedGeo.wispShard) {
    const g = new THREE.ConeGeometry(0.1, 0.42, 6);
    sharedGeo.wispShard = track(g);
  }
  return sharedGeo.wispShard;
}

function geoGuardTorso(): THREE.BufferGeometry {
  if (!sharedGeo.guardTorso) {
    const g = new THREE.CapsuleGeometry(0.78, 1.05, 6, 14);
    g.scale(1.15, 1, 0.82);
    sharedGeo.guardTorso = track(g);
  }
  return sharedGeo.guardTorso;
}

function geoGuardHead(): THREE.BufferGeometry {
  if (!sharedGeo.guardHead) {
    const g = new THREE.IcosahedronGeometry(0.46, 2);
    g.scale(1, 1.12, 0.95);
    sharedGeo.guardHead = track(g);
  }
  return sharedGeo.guardHead;
}

function geoGuardLimb(): THREE.BufferGeometry {
  if (!sharedGeo.guardLimb) sharedGeo.guardLimb = track(new THREE.CapsuleGeometry(0.24, 0.95, 5, 10));
  return sharedGeo.guardLimb;
}

function geoCrown(): THREE.BufferGeometry {
  if (!sharedGeo.crown) sharedGeo.crown = track(new THREE.TorusGeometry(0.95, 0.075, 8, 28));
  return sharedGeo.crown;
}

export function geoMote(): THREE.BufferGeometry {
  if (!sharedGeo.mote) sharedGeo.mote = track(new THREE.IcosahedronGeometry(0.42, 1));
  return sharedGeo.mote;
}

function bodyMaterial(color: number, roughness = 0.72): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.08 });
}

function glowMaterial(color: number, intensity = 2.2): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0,
  });
}

/** Corrupted Crawler: a low, rounded quadruped with a glowing spine. */
export function buildCrawler(accent: number): CreatureBuild {
  const group = new THREE.Group();
  const shell = bodyMaterial(0x3c2154, 0.68);
  const dark = bodyMaterial(0x241236, 0.8);
  const glow = glowMaterial(accent, 2.6);
  const materials = [shell, dark, glow];
  const animated: THREE.Object3D[] = [];

  const body = new THREE.Mesh(geoCrawlerBody(), shell);
  body.position.y = 0.52;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(geoCrawlerHead(), dark);
  head.position.set(0, 0.5, -0.72);
  head.castShadow = true;
  group.add(head);

  for (const ox of [-0.14, 0.14]) {
    const eye = new THREE.Mesh(geoEye(), glow);
    eye.position.set(ox, 0.55, -0.98);
    group.add(eye);
  }

  for (const [sx, sz] of [[-0.4, -0.36], [0.4, -0.36], [-0.4, 0.42], [0.4, 0.42]] as const) {
    const leg = new THREE.Mesh(geoLeg(), dark);
    leg.position.set(sx, 0.26, sz);
    leg.castShadow = true;
    group.add(leg);
    animated.push(leg);
  }

  for (const [sy, sz, scale] of [[0.98, -0.05, 1], [0.9, 0.34, 0.8], [0.78, 0.62, 0.6]] as const) {
    const spike = new THREE.Mesh(geoSpike(), glow);
    spike.position.set(0, sy, sz);
    spike.scale.setScalar(scale);
    group.add(spike);
  }

  return { group, materials, animated, glow };
}

/** Corrupted Wisp: a floating core wrapped in slowly orbiting shards. */
export function buildWisp(accent: number): CreatureBuild {
  const group = new THREE.Group();
  const shell = bodyMaterial(0x4a2769, 0.55);
  const glow = glowMaterial(accent, 3.2);
  const materials = [shell, glow];
  const animated: THREE.Object3D[] = [];

  const core = new THREE.Mesh(geoWispCore(), glow);
  core.position.y = 0.9;
  group.add(core);
  animated.push(core);

  for (let i = 0; i < 4; i++) {
    const shard = new THREE.Mesh(geoWispShard(), shell);
    shard.position.y = 0.9;
    shard.userData.orbit = (i / 4) * Math.PI * 2;
    shard.castShadow = true;
    group.add(shard);
    animated.push(shard);
  }

  const halo = new THREE.Mesh(geoCrown(), glow);
  halo.scale.setScalar(0.55);
  halo.position.y = 0.9;
  halo.rotation.x = Math.PI / 2;
  group.add(halo);
  animated.push(halo);

  return { group, materials, animated, glow };
}

/** Shrine Guardian: a broad sculpted figure crowned by a floating ring. */
export function buildGuardian(accent: number): CreatureBuild {
  const group = new THREE.Group();
  const shell = bodyMaterial(0x3a2352, 0.62);
  const dark = bodyMaterial(0x1f1130, 0.78);
  const glow = glowMaterial(accent, 2.8);
  const materials = [shell, dark, glow];
  const animated: THREE.Object3D[] = [];

  const torso = new THREE.Mesh(geoGuardTorso(), shell);
  torso.position.y = 2.35;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(geoGuardHead(), dark);
  head.position.set(0, 3.45, -0.05);
  head.castShadow = true;
  group.add(head);

  for (const ox of [-0.2, 0.2]) {
    const eye = new THREE.Mesh(geoEye(), glow);
    eye.scale.setScalar(1.5);
    eye.position.set(ox, 3.5, -0.42);
    group.add(eye);
  }

  for (const ox of [-0.45, 0.45]) {
    const leg = new THREE.Mesh(geoGuardLimb(), dark);
    leg.position.set(ox, 0.85, 0);
    leg.scale.set(1.1, 1.15, 1.1);
    leg.castShadow = true;
    group.add(leg);
  }

  for (const ox of [-1.05, 1.05]) {
    const arm = new THREE.Mesh(geoGuardLimb(), shell);
    arm.position.set(ox, 2.4, 0);
    arm.castShadow = true;
    group.add(arm);
    animated.push(arm);
  }

  const crown = new THREE.Mesh(geoCrown(), glow);
  crown.position.y = 4.3;
  crown.rotation.x = Math.PI / 2;
  group.add(crown);
  animated.push(crown);

  const crownInner = new THREE.Mesh(geoCrown(), glow);
  crownInner.position.y = 4.05;
  crownInner.scale.setScalar(0.62);
  crownInner.rotation.x = Math.PI / 2;
  group.add(crownInner);
  animated.push(crownInner);

  return { group, materials, animated, glow };
}

// --------------------------------------------------------------- shrines

export interface ShrineBuild {
  group: THREE.Group;
  materials: THREE.Material[];
  /** Rings and floating pieces animated each frame. */
  animated: THREE.Object3D[];
  core: THREE.Mesh;
  /** Local Y of the glowing core, for light and particle placement. */
  coreHeight: number;
}

/** Lathe profile helper - produces sculpted, smoothly curved masonry. */
function latheProfile(points: [number, number][], segments = 20): THREE.BufferGeometry {
  const pts = points.map(([x, y]) => new THREE.Vector2(x, y));
  return track(new THREE.LatheGeometry(pts, segments));
}

/**
 * Build one of the four shrines. Each has a distinct sculpted silhouette and
 * none of them is made of blocks.
 */
export function buildShrine(index: number, element: ElementId, cleansed: boolean): ShrineBuild {
  const group = new THREE.Group();
  const animated: THREE.Object3D[] = [];
  const accent = ELEMENTS[element].color;

  const stone = new THREE.MeshStandardMaterial({
    color: cleansed ? 0xd6e4f0 : 0x6a6f83,
    roughness: 0.68,
    metalness: 0.12,
  });
  const blight = new THREE.MeshStandardMaterial({
    color: cleansed ? accent : 0x6b3f8e,
    emissive: new THREE.Color(cleansed ? accent : 0x7d2fbb),
    emissiveIntensity: cleansed ? 0.9 : 1.5,
    roughness: 0.5,
    metalness: 0.1,
  });
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: new THREE.Color(cleansed ? accent : 0xc07bff),
    emissiveIntensity: 3.4,
    roughness: 0.25,
  });
  const materials: THREE.Material[] = [stone, blight, coreMat];

  // Shared sculpted dais - a smooth stepped disc.
  const dais = new THREE.Mesh(
    latheProfile([[0, 0], [8.4, 0], [8.0, 0.5], [6.4, 0.75], [6.0, 1.3], [3.6, 1.55], [3.3, 2.0], [0, 2.1]], 44),
    stone,
  );
  dais.receiveShadow = true;
  dais.castShadow = true;
  group.add(dais);

  let coreHeight = 6;

  switch (index) {
    case 0: { // Air - a slender spire ringed by floating hoops
      const spire = new THREE.Mesh(
        latheProfile([[0, 2], [1.1, 2.2], [0.75, 6], [0.5, 10], [0.28, 13.5], [0, 14.4]], 22),
        stone,
      );
      spire.castShadow = true;
      group.add(spire);
      for (const [y, r, tilt] of [[5.2, 3.1, 0.12], [8.4, 4.0, -0.2], [11.6, 2.6, 0.3]] as const) {
        const ring = new THREE.Mesh(track(new THREE.TorusGeometry(r, 0.16, 10, 44)), blight);
        ring.position.y = y;
        ring.rotation.x = Math.PI / 2 + tilt;
        ring.castShadow = true;
        group.add(ring);
        animated.push(ring);
      }
      coreHeight = 7.4;
      break;
    }
    case 1: { // Water - a sunken basin encircled by tapered columns
      const basin = new THREE.Mesh(
        latheProfile([[0, 2.1], [3.4, 2.1], [3.2, 2.9], [1.4, 2.4], [0, 2.35]], 40),
        stone,
      );
      basin.receiveShadow = true;
      group.add(basin);
      const pool = new THREE.Mesh(
        track(new THREE.CircleGeometry(3.05, 40)),
        new THREE.MeshStandardMaterial({
          color: cleansed ? 0x3f9fe0 : 0x5b2a7a,
          emissive: new THREE.Color(cleansed ? 0x1d5c9c : 0x3a1155),
          emissiveIntensity: 0.6,
          roughness: 0.12,
          metalness: 0.35,
          transparent: true,
          opacity: 0.88,
        }),
      );
      materials.push(pool.material as THREE.Material);
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 2.55;
      group.add(pool);
      animated.push(pool);

      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const col = new THREE.Mesh(
          latheProfile([[0, 0], [0.52, 0], [0.42, 3.2 + (i % 2) * 1.4], [0.2, 3.7 + (i % 2) * 1.4], [0, 3.8 + (i % 2) * 1.4]], 16),
          stone,
        );
        col.position.set(Math.cos(a) * 6.4, 1.4, Math.sin(a) * 6.4);
        col.castShadow = true;
        group.add(col);
      }
      const plinth = new THREE.Mesh(latheProfile([[0, 2.3], [0.9, 2.3], [0.6, 4.4], [0, 4.6]], 18), stone);
      group.add(plinth);
      coreHeight = 5.3;
      break;
    }
    case 2: { // Earth - a rounded cairn of stacked boulders
      const boulders: [number, number, number, number][] = [
        [0, 2.4, 0, 2.6], [1.4, 4.2, 0.6, 1.9], [-1.1, 5.6, -0.5, 1.6],
        [0.5, 7.0, 0.9, 1.35], [-0.4, 8.2, -0.2, 1.05],
      ];
      boulders.forEach(([x, y, z, r], i) => {
        const rock = new THREE.Mesh(makeRockGeometry(r, 2, 0.24, 900 + i * 37), i % 2 ? stone : blight);
        rock.position.set(x, y, z);
        rock.castShadow = true;
        rock.receiveShadow = true;
        group.add(rock);
      });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const menhir = new THREE.Mesh(
          latheProfile([[0, 0], [0.7, 0], [0.55, 2.6], [0.28, 3.4], [0, 3.5]], 12),
          stone,
        );
        menhir.position.set(Math.cos(a) * 6.8, 1.2, Math.sin(a) * 6.8);
        menhir.rotation.z = (i - 2) * 0.045;
        menhir.castShadow = true;
        group.add(menhir);
      }
      coreHeight = 9.6;
      break;
    }
    default: { // Fire - a jagged obelisk with rising arms
      const obelisk = new THREE.Mesh(
        latheProfile([[0, 2], [1.5, 2.3], [1.1, 7], [0.62, 11.5], [0.2, 13.6], [0, 14.2]], 7),
        stone,
      );
      obelisk.castShadow = true;
      group.add(obelisk);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const arm = new THREE.Mesh(
          latheProfile([[0, 0], [0.45, 0.2], [0.3, 3.4], [0, 4.2]], 6),
          blight,
        );
        arm.position.set(Math.cos(a) * 3.1, 2.4, Math.sin(a) * 3.1);
        arm.rotation.z = Math.cos(a) * -0.45;
        arm.rotation.x = Math.sin(a) * 0.45;
        arm.castShadow = true;
        group.add(arm);
        animated.push(arm);
      }
      coreHeight = 15.1;
      break;
    }
  }

  const core = new THREE.Mesh(track(new THREE.IcosahedronGeometry(0.72, 2)), coreMat);
  core.position.y = coreHeight;
  group.add(core);
  animated.push(core);

  const coreHalo = new THREE.Mesh(track(new THREE.TorusGeometry(1.25, 0.07, 8, 36)), coreMat);
  coreHalo.position.y = coreHeight;
  coreHalo.rotation.x = Math.PI / 2;
  group.add(coreHalo);
  animated.push(coreHalo);

  return { group, materials, animated, core, coreHeight };
}

// =====================================================================
//  World-specific body plans
//
//  Six additional silhouettes, so the creatures of each world read
//  differently at a glance: long-limbed root hunters, plated stone beasts,
//  rooted spitters, domed shell-backs, ribbon spirits and segmented burrowers.
//  None of them is a recolour of another - the proportions, the materials and
//  the moving parts are all different.
// =====================================================================

/**
 * Root-bound hunter: tall, spindly, four long legs and a low-slung body that
 * hangs between them. Reads as a spider-stalker at any distance.
 */
export function buildRootHunter(accent: number, body = 0x3d4a28): CreatureBuild {
  const group = new THREE.Group();
  const bark = bodyMaterial(body, 0.94);
  const dark = bodyMaterial(0x1e2714, 0.96);
  const glow = glowMaterial(accent, 2.4);
  const materials = [bark, dark, glow];
  const animated: THREE.Object3D[] = [];

  const hull = new THREE.Mesh(
    cached('root-hull', () => {
      const g = new THREE.IcosahedronGeometry(0.42, 1);
      g.scale(1.1, 0.6, 1.5);
      return g;
    }),
    bark,
  );
  hull.position.y = 1.05;
  hull.castShadow = true;
  group.add(hull);

  // Four long legs, jointed upward then down - the defining silhouette.
  for (let i = 0; i < 4; i++) {
    const side = i < 2 ? -1 : 1;
    const front = i % 2 === 0 ? -1 : 1;
    const limb = new THREE.Group();
    limb.position.set(side * 0.34, 1.02, front * 0.42);
    const upper = new THREE.Mesh(
      cached('root-upper', () => new THREE.CapsuleGeometry(0.07, 0.62, 4, 6)), dark,
    );
    upper.position.set(side * 0.28, 0.16, 0);
    upper.rotation.z = side * -0.9;
    limb.add(upper);
    const lower = new THREE.Mesh(
      cached('root-lower', () => new THREE.CapsuleGeometry(0.055, 0.78, 4, 6)), dark,
    );
    lower.position.set(side * 0.56, -0.42, 0);
    lower.rotation.z = side * 0.34;
    limb.add(lower);
    limb.castShadow = true;
    group.add(limb);
    animated.push(limb);
  }

  const head = new THREE.Mesh(
    cached('root-head', () => new THREE.ConeGeometry(0.22, 0.5, 6)), dark,
  );
  head.position.set(0, 1.02, -0.86);
  head.rotation.x = -Math.PI / 2;
  group.add(head);

  // The exposed heartwood is the weak point.
  const core = new THREE.Mesh(cached('root-core', () => new THREE.SphereGeometry(0.14, 8, 6)), glow);
  core.position.set(0, 1.14, 0.24);
  group.add(core);
  animated.push(core);

  return { group, materials, animated, glow, weakPoint: { x: 0, y: 1.14, z: 0.24 } };
}

/**
 * Plated stone beast: a heavy, wide quadruped built from slabs, with a glowing
 * seam down its flank where the plates have cracked apart.
 */
export function buildStoneBeast(accent: number, body = 0x5b5f63): CreatureBuild {
  const group = new THREE.Group();
  const stone = bodyMaterial(body, 0.98);
  const dark = bodyMaterial(0x2b2f33, 0.99);
  const glow = glowMaterial(accent, 2.8);
  const materials = [stone, dark, glow];
  const animated: THREE.Object3D[] = [];

  const hull = new THREE.Mesh(cached('stone-hull', () => new THREE.BoxGeometry(1.05, 0.72, 1.6)), stone);
  hull.position.y = 0.78;
  hull.castShadow = true;
  group.add(hull);

  for (const [ox, oy, oz, s] of [[0, 0.42, -0.5, 0.5], [-0.5, 0.3, 0.2, 0.42], [0.5, 0.3, 0.2, 0.42]] as const) {
    const slab = new THREE.Mesh(cached('stone-slab', () => new THREE.BoxGeometry(0.7, 0.24, 0.9)), dark);
    slab.position.set(ox, 0.78 + oy, oz);
    slab.scale.setScalar(s + 0.5);
    slab.rotation.y = ox * 0.4;
    group.add(slab);
  }

  for (let i = 0; i < 4; i++) {
    const side = i < 2 ? -1 : 1;
    const front = i % 2 === 0 ? -1 : 1;
    const leg = new THREE.Mesh(cached('stone-leg', () => new THREE.BoxGeometry(0.26, 0.62, 0.3)), dark);
    leg.position.set(side * 0.42, 0.31, front * 0.56);
    leg.castShadow = true;
    group.add(leg);
    animated.push(leg);
  }

  const head = new THREE.Mesh(cached('stone-head', () => new THREE.BoxGeometry(0.5, 0.42, 0.56)), stone);
  head.position.set(0, 0.82, -0.98);
  group.add(head);

  // Cracked seam: hitting it bypasses the plating.
  const seam = new THREE.Mesh(cached('stone-seam', () => new THREE.BoxGeometry(0.12, 0.4, 1.1)), glow);
  seam.position.set(0, 1.14, 0.1);
  group.add(seam);
  animated.push(seam);

  return { group, materials, animated, glow, weakPoint: { x: 0, y: 1.14, z: 0.1 } };
}

/**
 * Rooted spitter: a plant that cannot walk. A thick stalk, a heavy bulb head
 * that tracks the player, and a fan of leaves at the base.
 */
export function buildSpitter(accent: number, body = 0x2f5c33): CreatureBuild {
  const group = new THREE.Group();
  const stem = bodyMaterial(body, 0.95);
  const bulbMat = glowMaterial(accent, 1.6);
  const leafMat = bodyMaterial(0x1f4023, 0.98);
  const materials = [stem, bulbMat, leafMat];
  const animated: THREE.Object3D[] = [];

  const stalk = new THREE.Mesh(
    cached('spit-stalk', () => new THREE.CylinderGeometry(0.14, 0.28, 1.35, 8)), stem,
  );
  stalk.position.y = 0.68;
  stalk.castShadow = true;
  group.add(stalk);

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leaf = new THREE.Mesh(cached('spit-leaf', () => {
      const g = new THREE.ConeGeometry(0.2, 0.8, 5);
      g.rotateX(Math.PI / 2);
      return g;
    }), leafMat);
    leaf.position.set(Math.cos(a) * 0.36, 0.16, Math.sin(a) * 0.36);
    leaf.rotation.set(0.8, -a, 0);
    group.add(leaf);
    animated.push(leaf);
  }

  // The bulb is both the mouth and the weak point.
  const bulb = new THREE.Mesh(cached('spit-bulb', () => {
    const g = new THREE.SphereGeometry(0.34, 10, 8);
    g.scale(1, 1.15, 1);
    return g;
  }), bulbMat);
  bulb.position.y = 1.52;
  group.add(bulb);
  animated.push(bulb);

  return { group, materials, animated, glow: bulbMat, weakPoint: { x: 0, y: 1.52, z: 0 } };
}

/**
 * Shell-armoured crawler: a low dome over a squat body. The shell blocks
 * frontal damage; the soft underside is the answer.
 */
export function buildShellback(accent: number, body = 0x3a5560): CreatureBuild {
  const group = new THREE.Group();
  const shell = bodyMaterial(body, 0.6);
  shell.metalness = 0.25;
  const flesh = bodyMaterial(0x7a5a52, 0.9);
  const glow = glowMaterial(accent, 2.2);
  const materials = [shell, flesh, glow];
  const animated: THREE.Object3D[] = [];

  const under = new THREE.Mesh(cached('shell-under', () => {
    const g = new THREE.SphereGeometry(0.6, 12, 8);
    g.scale(1, 0.5, 1.1);
    return g;
  }), flesh);
  under.position.y = 0.42;
  group.add(under);

  const dome = new THREE.Mesh(cached('shell-dome', () => {
    const g = new THREE.SphereGeometry(0.74, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, 0.78, 1.16);
    return g;
  }), shell);
  dome.position.y = 0.5;
  dome.castShadow = true;
  group.add(dome);

  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ridge = new THREE.Mesh(cached('shell-ridge', () => new THREE.ConeGeometry(0.09, 0.3, 5)), shell);
    ridge.position.set(Math.cos(a) * 0.5, 0.72, Math.sin(a) * 0.6);
    ridge.rotation.z = Math.cos(a) * 0.5;
    group.add(ridge);
  }

  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1;
    const along = (i % 3) - 1;
    const leg = new THREE.Mesh(cached('shell-leg', () => new THREE.CapsuleGeometry(0.06, 0.26, 4, 6)), flesh);
    leg.position.set(side * 0.56, 0.16, along * 0.4);
    leg.rotation.z = side * 0.7;
    group.add(leg);
    animated.push(leg);
  }

  const eye = new THREE.Mesh(geoEye(), glow);
  eye.position.set(0, 0.44, -0.7);
  group.add(eye);

  // Soft underside, reachable from behind or below.
  return { group, materials, animated, glow, weakPoint: { x: 0, y: 0.3, z: 0.45 } };
}

/**
 * Ribbon spirit: no legs and no solid body - a drifting core wrapped in
 * trailing ribbons. Silhouette is entirely vertical motion.
 */
export function buildSpirit(accent: number, body = 0x1d3c52): CreatureBuild {
  const group = new THREE.Group();
  const veil = new THREE.MeshStandardMaterial({
    color: body, emissive: new THREE.Color(accent), emissiveIntensity: 0.7,
    roughness: 0.3, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
  });
  const glow = glowMaterial(accent, 3.2);
  const materials = [veil, glow];
  const animated: THREE.Object3D[] = [];

  const core = new THREE.Mesh(cached('spirit-core', () => new THREE.OctahedronGeometry(0.3, 1)), glow);
  core.position.y = 1.0;
  group.add(core);
  animated.push(core);

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const ribbon = new THREE.Mesh(cached('spirit-ribbon', () => {
      const g = new THREE.PlaneGeometry(0.22, 1.5, 1, 4);
      g.translate(0, -0.75, 0);
      return g;
    }), veil);
    ribbon.position.set(Math.cos(a) * 0.28, 0.98, Math.sin(a) * 0.28);
    ribbon.rotation.y = -a;
    group.add(ribbon);
    animated.push(ribbon);
  }

  return { group, materials, animated, glow, weakPoint: { x: 0, y: 1.0, z: 0 } };
}

/**
 * Segmented burrower: a chain of tapering rings with a mandibled head. Built
 * to read as "something long that just came out of the ground".
 */
export function buildBurrower(accent: number, body = 0x4a3320): CreatureBuild {
  const group = new THREE.Group();
  const hide = bodyMaterial(body, 0.88);
  const plate = bodyMaterial(0x2a1c10, 0.92);
  const glow = glowMaterial(accent, 2.6);
  const materials = [hide, plate, glow];
  const animated: THREE.Object3D[] = [];

  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const seg = new THREE.Mesh(
      cached('burrow-seg', () => new THREE.SphereGeometry(0.34, 10, 8)), i % 2 === 0 ? hide : plate,
    );
    seg.position.set(0, 0.5 + Math.sin(t * 2.2) * 0.16, 0.42 + t * 1.1);
    seg.scale.setScalar(1 - t * 0.45);
    seg.castShadow = true;
    group.add(seg);
    animated.push(seg);
  }

  const head = new THREE.Mesh(cached('burrow-head', () => {
    const g = new THREE.ConeGeometry(0.36, 0.78, 8);
    g.rotateX(-Math.PI / 2);
    return g;
  }), plate);
  head.position.set(0, 0.56, -0.3);
  head.castShadow = true;
  group.add(head);

  for (const side of [-1, 1]) {
    const mandible = new THREE.Mesh(cached('burrow-mand', () => new THREE.ConeGeometry(0.08, 0.44, 5)), hide);
    mandible.position.set(side * 0.2, 0.5, -0.6);
    mandible.rotation.set(-1.3, 0, side * 0.5);
    group.add(mandible);
    animated.push(mandible);
  }

  const maw = new THREE.Mesh(cached('burrow-maw', () => new THREE.SphereGeometry(0.14, 8, 6)), glow);
  maw.position.set(0, 0.56, -0.62);
  group.add(maw);

  return { group, materials, animated, glow, weakPoint: { x: 0, y: 0.56, z: -0.62 } };
}

// ------------------------------------------------------------------ props

export interface PropBuild {
  group: THREE.Group;
  materials: THREE.Material[];
  animated: THREE.Object3D[];
}

/** A stone-ringed campfire: a rest site and a source of supplies. */
export function buildCampfire(): PropBuild {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x776f68, roughness: 0.9 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6a4a2c, roughness: 0.85 });
  const flame = new THREE.MeshStandardMaterial({
    color: 0xffb04d,
    emissive: new THREE.Color(0xff8a2a),
    emissiveIntensity: 4.2,
    roughness: 0.3,
    transparent: true,
    opacity: 0.92,
  });
  const materials = [stone, wood, flame];
  const animated: THREE.Object3D[] = [];

  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    // Three shared rock shapes, rotated - looks varied, costs three buffers.
    const rock = new THREE.Mesh(cached(`fire-rock-${i % 3}`, () => makeRockGeometry(0.34, 1, 0.3, 500 + (i % 3) * 13)), stone);
    rock.position.set(Math.cos(a) * 1.05, 0.16, Math.sin(a) * 1.05);
    rock.rotation.y = a;
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    const log = new THREE.Mesh(cached('fire-log', () => new THREE.CapsuleGeometry(0.1, 0.9, 4, 8)), wood);
    log.position.set(Math.cos(a) * 0.28, 0.32, Math.sin(a) * 0.28);
    log.rotation.set(Math.cos(a) * 0.9, a, Math.sin(a) * 0.9);
    log.castShadow = true;
    group.add(log);
  }
  const fire = new THREE.Mesh(cached('fire-flame', () => new THREE.ConeGeometry(0.42, 1.1, 9)), flame);
  fire.position.y = 0.78;
  group.add(fire);
  animated.push(fire);

  return { group, materials, animated };
}

/** A berry bush the player can harvest for food. */
export function buildBerryBush(): PropBuild {
  const group = new THREE.Group();
  const leaf = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.9 });
  const berry = new THREE.MeshStandardMaterial({
    color: 0xe0517a,
    emissive: new THREE.Color(0x6d1030),
    emissiveIntensity: 0.7,
    roughness: 0.4,
  });
  const materials = [leaf, berry];

  for (let i = 0; i < 3; i++) {
    const blob = new THREE.Mesh(cached(`bush-blob-${i}`, () => makeCanopyGeometry(0.62, 300 + i * 17)), leaf);
    blob.position.set((i - 1) * 0.42, 0.42 + (i === 1 ? 0.16 : 0), Math.sin(i) * 0.3);
    blob.castShadow = true;
    group.add(blob);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const b = new THREE.Mesh(cached('bush-berry', () => new THREE.SphereGeometry(0.09, 6, 5)), berry);
    b.position.set(Math.cos(a) * 0.62, 0.55 + Math.sin(a * 3) * 0.2, Math.sin(a) * 0.5);
    group.add(b);
  }
  return { group, materials, animated: [] };
}

/** A traveller's supply cache holding potions or a meal. */
export function buildSupplyCache(): PropBuild {
  const group = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x9d7a4e, roughness: 0.95 });
  const trim = new THREE.MeshStandardMaterial({
    color: 0x63e6d2,
    emissive: new THREE.Color(0x1c6f73),
    emissiveIntensity: 1.4,
    roughness: 0.4,
  });
  const materials = [cloth, trim];

  const sack = new THREE.Mesh(
    cached('cache-sack', () => new THREE.LatheGeometry(
      [[0, 0], [0.55, 0.05], [0.62, 0.5], [0.42, 0.92], [0.2, 1.0], [0, 1.02]]
        .map(([x, y]) => new THREE.Vector2(x, y)),
      18,
    )),
    cloth,
  );
  sack.castShadow = true;
  sack.receiveShadow = true;
  group.add(sack);

  const band = new THREE.Mesh(cached('cache-band', () => new THREE.TorusGeometry(0.44, 0.05, 8, 22)), trim);
  band.position.y = 0.86;
  band.rotation.x = Math.PI / 2;
  group.add(band);

  return { group, materials, animated: [band] };
}

/**
 * A reward chest.
 *
 * Its banding, glow and the crown of shards above it are tinted by rarity, so
 * a legendary chest is readable across an arena before it is opened. The lid is
 * returned as an animated part so the game can play a real opening motion.
 */
export function buildChest(rarityColor: number, rarityIndex: number): PropBuild & { lid: THREE.Object3D } {
  const group = new THREE.Group();
  const materials: THREE.Material[] = [];

  const wood = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.85 });
  const metal = new THREE.MeshStandardMaterial({
    color: rarityColor,
    emissive: new THREE.Color(rarityColor),
    emissiveIntensity: 0.6 + rarityIndex * 0.5,
    roughness: 0.35,
    metalness: 0.5,
  });
  materials.push(wood, metal);

  const base = new THREE.Mesh(cached('chest-base', () => new THREE.BoxGeometry(1.1, 0.62, 0.78)), wood);
  base.position.y = 0.31;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // The lid pivots on a hinge group so the opening animation reads correctly.
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.62, -0.39);
  const lid = new THREE.Mesh(
    cached('chest-lid', () => {
      const geo = new THREE.CylinderGeometry(0.39, 0.39, 1.1, 12, 1, false, 0, Math.PI);
      geo.rotateZ(Math.PI / 2);
      return geo;
    }),
    wood,
  );
  lid.position.set(0, 0, 0.39);
  lid.castShadow = true;
  hinge.add(lid);
  group.add(hinge);

  for (const y of [0.14, 0.5]) {
    const band = new THREE.Mesh(cached('chest-band', () => new THREE.BoxGeometry(1.14, 0.08, 0.82)), metal);
    band.position.y = y;
    group.add(band);
  }
  const lock = new THREE.Mesh(cached('chest-lock', () => new THREE.BoxGeometry(0.2, 0.24, 0.12)), metal);
  lock.position.set(0, 0.56, 0.42);
  group.add(lock);

  // Rarity crown: one floating shard per rarity step above common.
  const shards: THREE.Object3D[] = [];
  for (let i = 0; i < rarityIndex; i++) {
    const a = (i / Math.max(1, rarityIndex)) * Math.PI * 2;
    const shard = new THREE.Mesh(cached('chest-shard', () => new THREE.OctahedronGeometry(0.11, 0)), metal);
    shard.position.set(Math.cos(a) * 0.44, 1.1 + Math.sin(a * 2) * 0.1, Math.sin(a) * 0.44);
    group.add(shard);
    shards.push(shard);
  }

  return { group, materials, animated: [hinge, ...shards], lid: hinge };
}

/**
 * A world-transition portal: a standing ring of keeper stone with a lit core.
 *
 * The core is returned as an animated part so it can pulse while the world's
 * objective is incomplete and open fully once the World Heart is restored.
 */
export function buildPortal(color: number): PropBuild {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x6b6f78, roughness: 0.92 });
  const glow = new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: 2.6,
    roughness: 0.2,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });
  const materials = [stone, glow];

  const arch = new THREE.Mesh(cached('portal-arch', () => new THREE.TorusGeometry(2.1, 0.28, 10, 26)), stone);
  arch.position.y = 2.4;
  arch.castShadow = true;
  group.add(arch);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(cached('portal-leg', () => new THREE.CylinderGeometry(0.3, 0.42, 2.5, 8)), stone);
    leg.position.set(side * 2.0, 1.25, 0);
    leg.castShadow = true;
    group.add(leg);
  }

  const core = new THREE.Mesh(cached('portal-core', () => new THREE.CircleGeometry(1.86, 26)), glow);
  core.position.y = 2.4;
  group.add(core);

  return { group, materials, animated: [core] };
}

/** A ritual mote: the peaceful-mode objective pickup. */
export function buildMote(color: number): PropBuild {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color),
    emissiveIntensity: 3.2,
    roughness: 0.25,
    transparent: true,
    opacity: 0.92,
  });
  const materials = [shell];
  const core = new THREE.Mesh(geoMote(), shell);
  group.add(core);
  const ring = new THREE.Mesh(cached('mote-ring-a', () => new THREE.TorusGeometry(0.75, 0.05, 8, 28)), shell);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  const ring2 = new THREE.Mesh(cached('mote-ring-b', () => new THREE.TorusGeometry(0.62, 0.04, 8, 24)), shell);
  ring2.rotation.z = Math.PI / 3;
  group.add(ring2);
  return { group, materials, animated: [core, ring, ring2] };
}

/** Small floating aether pickup dropped by defeated creatures. */
export function geoPickup(): THREE.BufferGeometry {
  return track(new THREE.IcosahedronGeometry(0.24, 1));
}
