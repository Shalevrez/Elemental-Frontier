/**
 * Temporary ground decals: scorch marks, earth cracks, ice sheets, wet patches.
 *
 * All decals share one instanced quad mesh with a procedurally generated
 * texture atlas, so any number of them costs a single draw call. Each decal is
 * projected onto the terrain surface and fades out over its lifetime.
 */

import * as THREE from 'three';

export type DecalKind = 'scorch' | 'crack' | 'ice' | 'wet' | 'blight';

const KIND_INDEX: Record<DecalKind, number> = {
  scorch: 0, crack: 1, ice: 2, wet: 3, blight: 0,
};

const KIND_COLOR: Record<DecalKind, number> = {
  scorch: 0x241610,
  crack: 0x3a2c20,
  ice: 0xbfe8ff,
  wet: 0x2d4c6b,
  blight: 0x4a1f6b,
};

const MAX_DECALS = 96;

const VERT = /* glsl */ `
  attribute vec4 decal;      // xyz = centre, w = radius
  attribute vec4 tint;       // rgb = colour, a = alpha
  attribute vec3 basisX;
  attribute vec3 basisZ;
  attribute float slot;      // atlas tile index
  varying vec2 vUv;
  varying vec4 vTint;
  varying float vSlot;
  void main() {
    vUv = uv;
    vTint = tint;
    vSlot = slot;
    vec3 world = decal.xyz + basisX * (position.x * decal.w) + basisZ * (position.y * decal.w);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying vec4 vTint;
  varying float vSlot;
  void main() {
    float col = mod(vSlot, 2.0);
    float row = floor(vSlot / 2.0);
    vec2 uv = (vUv + vec2(col, row)) * 0.5;
    vec4 tex = texture2D(uAtlas, uv);
    float a = tex.a * vTint.a;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vTint.rgb * tex.rgb, a);
  }
`;

interface DecalSlot {
  life: number;
  maxLife: number;
  alpha: number;
}

/** Paint the four decal shapes onto a 2x2 atlas. */
function buildAtlas(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable for decal atlas');
  ctx.clearRect(0, 0, size, size);
  const half = size / 2;

  const soft = (cx: number, cy: number, r: number, inner: string, outer: string): void => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, inner);
    g.addColorStop(0.65, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // 0: scorch - a sooty blot with a ragged edge
  soft(half * 0.5, half * 0.5, half * 0.46, 'rgba(255,255,255,0.95)', 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = half * (0.34 + Math.random() * 0.16);
    ctx.beginPath();
    ctx.arc(half * 0.5 + Math.cos(a) * r, half * 0.5 + Math.sin(a) * r, half * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  // 1: cracks - radiating fissures
  ctx.save();
  ctx.translate(half * 1.5, half * 0.5);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
    ctx.lineWidth = 7 - i % 3 * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    let x = 0, y = 0;
    for (let s = 0; s < 4; s++) {
      const step = half * 0.13;
      x += Math.cos(a + (Math.random() - 0.5) * 0.7) * step;
      y += Math.sin(a + (Math.random() - 0.5) * 0.7) * step;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // 2: ice - a frosted sheet with facets
  soft(half * 0.5, half * 1.5, half * 0.46, 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0)');
  ctx.save();
  ctx.translate(half * 0.5, half * 1.5);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * half * 0.4, Math.sin(a) * half * 0.4);
    ctx.stroke();
  }
  ctx.restore();

  // 3: wet - a soft even sheen
  soft(half * 1.5, half * 1.5, half * 0.47, 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0)');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class Decals {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private atlas: THREE.Texture;

  private decal = new Float32Array(MAX_DECALS * 4);
  private tint = new Float32Array(MAX_DECALS * 4);
  private basisX = new Float32Array(MAX_DECALS * 3);
  private basisZ = new Float32Array(MAX_DECALS * 3);
  private slot = new Float32Array(MAX_DECALS);
  private slots: DecalSlot[] = [];
  private count = 0;
  private budget = MAX_DECALS;

  private aDecal: THREE.InstancedBufferAttribute;
  private aTint: THREE.InstancedBufferAttribute;
  private aBasisX: THREE.InstancedBufferAttribute;
  private aBasisZ: THREE.InstancedBufferAttribute;
  private aSlot: THREE.InstancedBufferAttribute;

  constructor() {
    this.atlas = buildAtlas();
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.attributes.position = quad.attributes.position!;
    this.geometry.attributes.uv = quad.attributes.uv!;
    quad.dispose();

    this.aDecal = new THREE.InstancedBufferAttribute(this.decal, 4);
    this.aTint = new THREE.InstancedBufferAttribute(this.tint, 4);
    this.aBasisX = new THREE.InstancedBufferAttribute(this.basisX, 3);
    this.aBasisZ = new THREE.InstancedBufferAttribute(this.basisZ, 3);
    this.aSlot = new THREE.InstancedBufferAttribute(this.slot, 1);
    this.geometry.setAttribute('decal', this.aDecal);
    this.geometry.setAttribute('tint', this.aTint);
    this.geometry.setAttribute('basisX', this.aBasisX);
    this.geometry.setAttribute('basisZ', this.aBasisZ);
    this.geometry.setAttribute('slot', this.aSlot);
    this.geometry.instanceCount = 0;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(128, 30, 128), 420);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uAtlas: { value: this.atlas } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'decals';
  }

  setBudget(n: number): void {
    this.budget = Math.max(8, Math.min(MAX_DECALS, Math.round(n)));
  }

  /**
   * Stamp a decal onto a surface.
   *
   * @param normal surface normal; the decal is oriented to lie flat on it.
   */
  add(
    kind: DecalKind,
    x: number, y: number, z: number,
    normal: THREE.Vector3,
    radius: number,
    seconds: number,
    alpha = 0.85,
  ): void {
    let index: number;
    if (this.count < this.budget) {
      index = this.count++;
      this.slots.push({ life: seconds, maxLife: seconds, alpha });
    } else {
      // Recycle the shortest-lived decal so new impacts always show.
      let oldest = 0;
      let best = Infinity;
      for (let i = 0; i < this.count; i++) {
        const s = this.slots[i]!;
        if (s.life < best) { best = s.life; oldest = i; }
      }
      index = oldest;
      this.slots[index] = { life: seconds, maxLife: seconds, alpha };
    }

    // Build a tangent basis on the surface.
    _n.copy(normal).normalize();
    if (Math.abs(_n.y) > 0.95) _tmp.set(1, 0, 0);
    else _tmp.set(0, 1, 0);
    _tx.crossVectors(_tmp, _n).normalize();
    _tz.crossVectors(_n, _tx).normalize();

    const i4 = index * 4;
    const i3 = index * 3;
    this.decal[i4] = x + _n.x * 0.06;
    this.decal[i4 + 1] = y + _n.y * 0.06;
    this.decal[i4 + 2] = z + _n.z * 0.06;
    this.decal[i4 + 3] = radius;

    const c = KIND_COLOR[kind];
    this.tint[i4] = ((c >> 16) & 255) / 255;
    this.tint[i4 + 1] = ((c >> 8) & 255) / 255;
    this.tint[i4 + 2] = (c & 255) / 255;
    this.tint[i4 + 3] = alpha;

    this.basisX[i3] = _tx.x; this.basisX[i3 + 1] = _tx.y; this.basisX[i3 + 2] = _tx.z;
    this.basisZ[i3] = _tz.x; this.basisZ[i3 + 1] = _tz.y; this.basisZ[i3 + 2] = _tz.z;
    this.slot[index] = KIND_INDEX[kind];

    this.geometry.instanceCount = this.count;
    this.markDirty();
  }

  update(dt: number): void {
    if (this.count === 0) return;
    let changed = false;
    for (let i = this.count - 1; i >= 0; i--) {
      const s = this.slots[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        // Swap-remove.
        const last = --this.count;
        if (i !== last) {
          this.copyInstance(last, i);
          this.slots[i] = this.slots[last]!;
        }
        this.slots.length = this.count;
        changed = true;
        continue;
      }
      // Fade over the last third of the lifetime.
      const f = s.life / s.maxLife;
      const a = s.alpha * (f < 0.35 ? f / 0.35 : 1);
      this.tint[i * 4 + 3] = a;
      changed = true;
    }
    if (changed) {
      this.geometry.instanceCount = this.count;
      this.markDirty();
    }
  }

  private copyInstance(from: number, to: number): void {
    for (let k = 0; k < 4; k++) {
      this.decal[to * 4 + k] = this.decal[from * 4 + k]!;
      this.tint[to * 4 + k] = this.tint[from * 4 + k]!;
    }
    for (let k = 0; k < 3; k++) {
      this.basisX[to * 3 + k] = this.basisX[from * 3 + k]!;
      this.basisZ[to * 3 + k] = this.basisZ[from * 3 + k]!;
    }
    this.slot[to] = this.slot[from]!;
  }

  private markDirty(): void {
    this.aDecal.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.aBasisX.needsUpdate = true;
    this.aBasisZ.needsUpdate = true;
    this.aSlot.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.slots.length = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}

const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tx = new THREE.Vector3();
const _tz = new THREE.Vector3();
