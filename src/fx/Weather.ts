/**
 * Weather: rain, snow, drifting ash and dust motes.
 *
 * One GPU point cloud that follows the camera inside a moving box, so a light
 * shower and a blizzard cost exactly the same draw call. Intensity, colour,
 * fall speed and streak length are all uniforms, which lets the game blend
 * smoothly between world themes instead of snapping.
 */

import * as THREE from 'three';
import type { WeatherKind } from '../world/worlds';

const COUNT = 4000;
const BOX = 46;

const VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uOrigin;
  uniform float uFall;
  uniform float uDrift;
  uniform float uSize;
  uniform float uCount;
  uniform float uBox;
  attribute float seed;
  varying float vFade;
  void main() {
    // Deterministic per-particle offsets from the seed.
    float s = seed;
    vec3 base = vec3(
      fract(sin(s * 12.9898) * 43758.5453),
      fract(sin(s * 78.233) * 12345.6789),
      fract(sin(s * 39.425) * 24634.6345)
    );

    float span = uBox;
    float y = mod(base.y * span - uTime * uFall, span);
    float sway = sin(uTime * 0.9 + s * 6.283) * uDrift;

    vec3 pos;
    pos.x = uOrigin.x + (base.x - 0.5) * span * 2.0 + sway;
    pos.y = uOrigin.y + y - span * 0.35;
    pos.z = uOrigin.z + (base.z - 0.5) * span * 2.0 + sway * 0.6;

    // Hide the tail of the buffer when intensity is low.
    vFade = step(s * 1.0, uCount);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = uSize * (300.0 / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uStreak;
  varying float vFade;
  void main() {
    if (vFade < 0.5) discard;
    vec2 p = gl_PointCoord - vec2(0.5);
    // Stretch vertically for rain, keep round for snow and ash.
    p.y /= max(0.15, uStreak);
    float d = length(p);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.1, d) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface WeatherProfile {
  color: number;
  fall: number;
  drift: number;
  size: number;
  opacity: number;
  streak: number;
  /** Fraction of the buffer used at full intensity. */
  density: number;
}

const PROFILES: Record<WeatherKind, WeatherProfile> = {
  clear: { color: 0xffffff, fall: 1.5, drift: 1.4, size: 0.06, opacity: 0.16, streak: 1, density: 0.14 },
  rain: { color: 0xbcd8ee, fall: 34, drift: 0.6, size: 0.09, opacity: 0.5, streak: 0.16, density: 1 },
  snow: { color: 0xffffff, fall: 3.2, drift: 3.2, size: 0.14, opacity: 0.75, streak: 1, density: 0.85 },
  ash: { color: 0xd9a07a, fall: 2.2, drift: 2.6, size: 0.12, opacity: 0.5, streak: 1, density: 0.7 },
  mist: { color: 0xcfe4f2, fall: 0.6, drift: 2.0, size: 0.5, opacity: 0.12, streak: 1, density: 0.5 },
};

export class Weather {
  readonly points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  private kind: WeatherKind = 'clear';
  private targetKind: WeatherKind = 'clear';
  private intensity = 0;
  private targetIntensity = 0;
  private densityScale = 1;
  private current: WeatherProfile = { ...PROFILES.clear };

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    const seeds = new Float32Array(COUNT);
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) seeds[i] = i / COUNT;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uFall: { value: 2 },
        uDrift: { value: 1 },
        uSize: { value: 0.1 },
        uCount: { value: 0 },
        uBox: { value: BOX },
        uColor: { value: new THREE.Color(0xffffff) },
        uOpacity: { value: 0 },
        uStreak: { value: 1 },
      },
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'weather';
  }

  /**
   * Ask for a weather state. The change is blended in over a few seconds
   * rather than snapping, which is what makes a storm feel like it arrives.
   */
  set(kind: WeatherKind, intensity: number): void {
    this.targetKind = kind;
    this.targetIntensity = Math.max(0, Math.min(1, intensity));
  }

  /** Quality setting: scales how many particles are actually drawn. */
  setDensityScale(scale: number): void {
    this.densityScale = Math.max(0, Math.min(1.5, scale));
  }

  get activeKind(): WeatherKind {
    return this.kind;
  }

  get activeIntensity(): number {
    return this.intensity;
  }

  update(dt: number, cameraPosition: THREE.Vector3): void {
    // Cross-fade: wind down the old kind, then swap and wind up the new one.
    if (this.kind !== this.targetKind) {
      this.intensity = Math.max(0, this.intensity - dt * 0.7);
      if (this.intensity <= 0.02) this.kind = this.targetKind;
    } else {
      const delta = this.targetIntensity - this.intensity;
      this.intensity += Math.sign(delta) * Math.min(Math.abs(delta), dt * 0.35);
    }

    const target = PROFILES[this.kind];
    const k = Math.min(1, dt * 2.5);
    this.current.fall += (target.fall - this.current.fall) * k;
    this.current.drift += (target.drift - this.current.drift) * k;
    this.current.size += (target.size - this.current.size) * k;
    this.current.streak += (target.streak - this.current.streak) * k;
    this.current.density = target.density;

    const u = this.material.uniforms;
    u.uTime!.value += dt;
    (u.uOrigin!.value as THREE.Vector3).copy(cameraPosition);
    u.uFall!.value = this.current.fall;
    u.uDrift!.value = this.current.drift;
    u.uSize!.value = this.current.size;
    u.uStreak!.value = this.current.streak;
    u.uOpacity!.value = target.opacity * this.intensity;
    u.uCount!.value = this.current.density * this.intensity * this.densityScale;
    (u.uColor!.value as THREE.Color).lerp(_c.setHex(target.color), k);

    this.points.visible = this.intensity > 0.01 && this.densityScale > 0.01;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _c = new THREE.Color();

/**
 * Work out the weather a position should have, blending the world's baseline
 * with local modifiers: storms build over open ground, snow thickens with
 * altitude, and corrupted ground stays hazy.
 */
export function weatherAt(
  base: WeatherKind,
  baseIntensity: number,
  height: number,
  blight: number,
  stormPhase: number,
): { kind: WeatherKind; intensity: number } {
  let intensity = baseIntensity;

  // Snow gets heavier the higher you climb.
  if (base === 'snow') intensity = Math.min(1, baseIntensity + Math.max(0, (height - 30) / 40));
  // Ash thickens in the low, hot basins.
  if (base === 'ash') intensity = Math.min(1, baseIntensity + Math.max(0, (24 - height) / 30));
  // Corruption drags mist in with it.
  if (blight > 0.2) {
    return { kind: base === 'clear' ? 'mist' : base, intensity: Math.min(1, intensity + blight * 0.6) };
  }
  // Clear weather still cycles through gentle showers.
  if (base === 'clear') {
    const storm = Math.max(0, Math.sin(stormPhase * Math.PI * 2));
    if (storm > 0.55) return { kind: 'rain', intensity: (storm - 0.55) / 0.45 * 0.8 };
    return { kind: 'clear', intensity: 0.5 };
  }
  return { kind: base, intensity };
}
