/**
 * Pooled GPU particle system.
 *
 * Two pools share one class: an additive pool for energy/fire/light effects
 * and a "chunk" pool that draws opaque square voxel-ish fragments for dust and
 * block debris. Nothing is allocated per particle at runtime.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (320.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG_SOFT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.12, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

/**
 * Debris grains: rounded pebble shapes with a soft lit edge, so dust and grit
 * match the smooth world instead of reading as tiny cubes.
 */
const FRAG_CHUNK = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p);
    if (d > 0.5 || vAlpha < 0.02) discard;
    float edge = smoothstep(0.5, 0.36, d);
    // Fake a lit top-left so each grain reads as a little rounded solid.
    float lit = 0.72 + 0.42 * clamp(dot(normalize(vec2(-0.55, -0.7)), p / max(d, 0.001)), 0.0, 1.0);
    gl_FragColor = vec4(vColor * lit, vAlpha * edge);
  }
`;

export interface EmitOptions {
  count: number;
  x: number; y: number; z: number;
  /** Random position jitter radius. */
  spread?: number;
  /** Base velocity. */
  vx?: number; vy?: number; vz?: number;
  /** Random velocity jitter. */
  jitter?: number;
  color: number;
  /** Optional second colour; each particle lerps randomly between the two. */
  color2?: number;
  size?: number;
  sizeJitter?: number;
  life?: number;
  lifeJitter?: number;
  gravity?: number;
  drag?: number;
}

class Pool {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly baseSize: Float32Array;
  private count = 0;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(128, 36, 128), 400);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: additive ? FRAG_SOFT : FRAG_CHUNK,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexColors: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  emit(o: EmitOptions): void {
    const spread = o.spread ?? 0;
    const jitter = o.jitter ?? 0;
    const life = o.life ?? 0.7;
    const lifeJ = o.lifeJitter ?? 0.3;
    const size = o.size ?? 0.35;
    const sizeJ = o.sizeJitter ?? 0.4;
    const c1 = new THREE.Color(o.color);
    const c2 = o.color2 !== undefined ? new THREE.Color(o.color2) : c1;

    for (let n = 0; n < o.count; n++) {
      if (this.count >= this.capacity) {
        // Recycle the oldest slot rather than dropping the effect entirely.
        this.count = this.capacity - 1;
      }
      const i = this.count++;
      const i3 = i * 3;
      this.positions[i3] = o.x + (Math.random() - 0.5) * 2 * spread;
      this.positions[i3 + 1] = o.y + (Math.random() - 0.5) * 2 * spread;
      this.positions[i3 + 2] = o.z + (Math.random() - 0.5) * 2 * spread;
      this.vel[i3] = (o.vx ?? 0) + (Math.random() - 0.5) * 2 * jitter;
      this.vel[i3 + 1] = (o.vy ?? 0) + (Math.random() - 0.5) * 2 * jitter;
      this.vel[i3 + 2] = (o.vz ?? 0) + (Math.random() - 0.5) * 2 * jitter;
      const t = Math.random();
      this.colors[i3] = c1.r + (c2.r - c1.r) * t;
      this.colors[i3 + 1] = c1.g + (c2.g - c1.g) * t;
      this.colors[i3 + 2] = c1.b + (c2.b - c1.b) * t;
      const ml = life * (1 + (Math.random() - 0.5) * 2 * lifeJ);
      this.life[i] = ml;
      this.maxLife[i] = ml;
      this.baseSize[i] = size * (1 + (Math.random() - 0.5) * 2 * sizeJ);
      this.sizes[i] = this.baseSize[i]!;
      this.alphas[i] = 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0.6;
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        const last = --this.count;
        if (i !== last) this.swap(i, last);
        continue;
      }
      const i3 = i * 3;
      const damp = Math.max(0, 1 - this.drag[i]! * dt);
      this.vel[i3]! *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1]! * damp + this.grav[i]! * dt;
      this.vel[i3 + 2]! *= damp;
      this.positions[i3]! += this.vel[i3]! * dt;
      this.positions[i3 + 1]! += this.vel[i3 + 1]! * dt;
      this.positions[i3 + 2]! += this.vel[i3 + 2]! * dt;
      const f = this.life[i]! / this.maxLife[i]!;
      this.alphas[i] = f < 0.35 ? f / 0.35 : 1;
      this.sizes[i] = this.baseSize[i]! * (0.4 + f * 0.6);
      i++;
    }

    this.geometry.setDrawRange(0, this.count);
    if (this.count > 0) {
      (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  private swap(a: number, b: number): void {
    const a3 = a * 3;
    const b3 = b * 3;
    for (let k = 0; k < 3; k++) {
      this.positions[a3 + k] = this.positions[b3 + k]!;
      this.colors[a3 + k] = this.colors[b3 + k]!;
      this.vel[a3 + k] = this.vel[b3 + k]!;
    }
    this.sizes[a] = this.sizes[b]!;
    this.alphas[a] = this.alphas[b]!;
    this.life[a] = this.life[b]!;
    this.maxLife[a] = this.maxLife[b]!;
    this.grav[a] = this.grav[b]!;
    this.drag[a] = this.drag[b]!;
    this.baseSize[a] = this.baseSize[b]!;
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class Particles {
  readonly group = new THREE.Group();
  private readonly glow: Pool;
  private readonly chunky: Pool;
  /** Scales every emission, driven by the particle-density setting. */
  private density = 1;

  constructor(glowCapacity = 3600, chunkCapacity = 1800) {
    this.group.name = 'particles';
    this.glow = new Pool(glowCapacity, true);
    this.chunky = new Pool(chunkCapacity, false);
    this.group.add(this.glow.points, this.chunky.points);
  }

  setDensity(value: number): void {
    this.density = Math.max(0.15, Math.min(2, value));
  }

  /** Scale a requested count, never dropping a single-particle emission. */
  private scale(count: number): number {
    if (this.density >= 1) return Math.round(count * this.density);
    const scaled = count * this.density;
    if (scaled >= 1) return Math.round(scaled);
    // Below one, emit probabilistically so trails still shimmer on Low.
    return Math.random() < scaled ? 1 : 0;
  }

  /** Soft additive sparks - abilities, energy, magic. */
  spark(options: EmitOptions): void {
    const count = this.scale(options.count);
    if (count <= 0) return;
    this.glow.emit(count === options.count ? options : { ...options, count });
  }

  /** Opaque fragments - dust, grit, rock chips. */
  debris(options: EmitOptions): void {
    const count = this.scale(options.count);
    if (count <= 0) return;
    this.chunky.emit(count === options.count ? options : { ...options, count });
  }

  update(dt: number): void {
    this.glow.update(dt);
    this.chunky.update(dt);
  }

  clear(): void {
    this.glow.clear();
    this.chunky.clear();
  }

  dispose(): void {
    this.glow.dispose();
    this.chunky.dispose();
    this.group.clear();
  }
}
