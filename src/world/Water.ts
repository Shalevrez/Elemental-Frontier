/**
 * The sea surface.
 *
 * A single large plane at sea level with a custom shader: layered gerstner-ish
 * wave displacement, a fresnel rim, depth-tinted colour and a specular sun
 * glint. Far better looking - and far cheaper - than filling the density field
 * with water.
 */

import * as THREE from 'three';
import { SEA_LEVEL, WORLD_SIZE } from './coords';

const VERT = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vWave;

  float wave(vec2 p, vec2 dir, float freq, float speed, float amp) {
    return sin(dot(p, dir) * freq + uTime * speed) * amp;
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 p = world.xz;

    float h = 0.0;
    h += wave(p, normalize(vec2(1.0, 0.35)), 0.09, 0.9, 0.30);
    h += wave(p, normalize(vec2(-0.4, 1.0)), 0.15, 1.35, 0.18);
    h += wave(p, normalize(vec2(0.7, -0.8)), 0.31, 2.1, 0.075);
    world.y += h;
    vWave = h;

    // Analytic-ish normal from two nearby samples.
    float e = 1.2;
    float hx = 0.0, hz = 0.0;
    vec2 px = p + vec2(e, 0.0);
    vec2 pz = p + vec2(0.0, e);
    hx += wave(px, normalize(vec2(1.0, 0.35)), 0.09, 0.9, 0.30);
    hx += wave(px, normalize(vec2(-0.4, 1.0)), 0.15, 1.35, 0.18);
    hz += wave(pz, normalize(vec2(1.0, 0.35)), 0.09, 0.9, 0.30);
    hz += wave(pz, normalize(vec2(-0.4, 1.0)), 0.15, 1.35, 0.18);
    vNormalW = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));

    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vWave;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorld);
    vec3 n = normalize(vNormalW);

    float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 3.0);
    vec3 base = mix(uDeep, uShallow, clamp(vWave * 0.8 + 0.5, 0.0, 1.0));

    vec3 h = normalize(normalize(uSunDir) + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 90.0);

    vec3 color = base + uSunColor * spec * 1.6;
    color = mix(color, uSunColor * 0.75 + base * 0.35, fres * 0.55);

    float dist = length(cameraPosition - vWorld);
    float fogFactor = smoothstep(uFogNear, uFogFar, dist);
    color = mix(color, uFogColor, fogFactor);

    float alpha = mix(0.82, 0.97, fres);
    gl_FragColor = vec4(color, alpha);
  }
`;

export class Water {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.PlaneGeometry;

  constructor() {
    // Enough subdivision that the waves read, without being expensive.
    this.geometry = new THREE.PlaneGeometry(WORLD_SIZE * 1.6, WORLD_SIZE * 1.6, 96, 96);
    this.geometry.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x4fb0d8) },
        uDeep: { value: new THREE.Color(0x123f6b) },
        uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3) },
        uSunColor: { value: new THREE.Color(0xffefd0) },
        uFogColor: { value: new THREE.Color(0xa2cfec) },
        uFogNear: { value: 60 },
        uFogFar: { value: 200 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(WORLD_SIZE / 2, SEA_LEVEL, WORLD_SIZE / 2);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sea';
  }

  update(dt: number, sunDir: THREE.Vector3, sunColor: THREE.Color, fogColor: THREE.Color, near: number, far: number): void {
    const u = this.material.uniforms;
    u.uTime!.value += dt;
    (u.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor!.value as THREE.Color).copy(sunColor);
    (u.uFogColor!.value as THREE.Color).copy(fogColor);
    u.uFogNear!.value = near;
    u.uFogFar!.value = far;
  }

  /** Height of the animated surface (approximate) - used for splash effects. */
  static levelAt(): number {
    return SEA_LEVEL;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
