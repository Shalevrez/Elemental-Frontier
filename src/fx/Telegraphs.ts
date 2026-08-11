/**
 * Ground warning markers for telegraphed enemy attacks.
 *
 * A single instanced ring that fills up as the wind-up completes, so the
 * player can read *where* and *when* an attack will land at a glance. One draw
 * call regardless of how many warnings are on screen.
 */

import * as THREE from 'three';

const MAX = 24;

const VERT = /* glsl */ `
  attribute vec4 marker;   // xyz = centre, w = radius
  attribute vec4 style;    // rgb = colour, a = fill 0..1
  varying vec2 vUv;
  varying vec4 vStyle;
  void main() {
    vUv = uv * 2.0 - 1.0;
    vStyle = style;
    vec3 world = marker.xyz + vec3(position.x, 0.0, position.y) * marker.w;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vStyle;
  void main() {
    float d = length(vUv);
    if (d > 1.0) discard;

    // Outline ring plus a filling disc that closes as the attack lands.
    float ring = smoothstep(1.0, 0.92, d) * smoothstep(0.82, 0.9, d);
    float fill = step(d, vStyle.a) * 0.35;
    float a = clamp(ring + fill, 0.0, 1.0);
    if (a < 0.02) discard;
    // Pulse harder as it nears completion.
    float pulse = 0.75 + 0.25 * vStyle.a;
    gl_FragColor = vec4(vStyle.rgb * pulse, a * 0.85);
  }
`;

interface Marker {
  life: number;
  total: number;
}

export class Telegraphs {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private marker = new Float32Array(MAX * 4);
  private style = new Float32Array(MAX * 4);
  private aMarker: THREE.InstancedBufferAttribute;
  private aStyle: THREE.InstancedBufferAttribute;
  private slots: Marker[] = [];
  private count = 0;

  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.attributes.position = quad.attributes.position!;
    this.geometry.attributes.uv = quad.attributes.uv!;
    quad.dispose();

    this.aMarker = new THREE.InstancedBufferAttribute(this.marker, 4);
    this.aStyle = new THREE.InstancedBufferAttribute(this.style, 4);
    this.geometry.setAttribute('marker', this.aMarker);
    this.geometry.setAttribute('style', this.aStyle);
    this.geometry.instanceCount = 0;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(128, 30, 128), 420);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'telegraphs';
  }

  /** Show a warning that closes over `seconds`. */
  add(x: number, y: number, z: number, radius: number, seconds: number, color: number): void {
    let index: number;
    if (this.count < MAX) {
      index = this.count++;
      this.slots.push({ life: seconds, total: seconds });
    } else {
      let oldest = 0;
      for (let i = 1; i < this.count; i++) {
        if (this.slots[i]!.life < this.slots[oldest]!.life) oldest = i;
      }
      index = oldest;
      this.slots[index] = { life: seconds, total: seconds };
    }

    const i4 = index * 4;
    this.marker[i4] = x;
    this.marker[i4 + 1] = y + 0.08;
    this.marker[i4 + 2] = z;
    this.marker[i4 + 3] = Math.max(0.5, radius);
    this.style[i4] = ((color >> 16) & 255) / 255;
    this.style[i4 + 1] = ((color >> 8) & 255) / 255;
    this.style[i4 + 2] = (color & 255) / 255;
    this.style[i4 + 3] = 0;

    this.geometry.instanceCount = this.count;
    this.aMarker.needsUpdate = true;
    this.aStyle.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.count === 0) return;
    for (let i = this.count - 1; i >= 0; i--) {
      const slot = this.slots[i]!;
      slot.life -= dt;
      if (slot.life <= 0) {
        const last = --this.count;
        if (i !== last) {
          for (let k = 0; k < 4; k++) {
            this.marker[i * 4 + k] = this.marker[last * 4 + k]!;
            this.style[i * 4 + k] = this.style[last * 4 + k]!;
          }
          this.slots[i] = this.slots[last]!;
        }
        this.slots.length = this.count;
        continue;
      }
      // Fill fraction runs 0 -> 1 as the wind-up completes.
      this.style[i * 4 + 3] = 1 - slot.life / slot.total;
    }
    this.geometry.instanceCount = this.count;
    this.aMarker.needsUpdate = true;
    this.aStyle.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.slots.length = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
