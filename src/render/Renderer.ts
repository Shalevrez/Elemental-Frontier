/**
 * Rendering shell: WebGL renderer, camera, sky dome, lighting, fog, the
 * post-processing stack and the terrain brush preview.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { WORLD_HEIGHT } from '../world/coords';

const SKY_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec3 vWorld;
  void main() {
    vec3 dir = normalize(vWorld);
    float h = dir.y;
    vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
    sky = mix(uGround, sky, smoothstep(-0.22, 0.02, h));
    float sun = max(0.0, dot(dir, normalize(uSunDir)));
    sky += uSunColor * pow(sun, 350.0) * 2.4;
    sky += uSunColor * pow(sun, 9.0) * 0.16;
    gl_FragColor = vec4(sky, 1.0);
  }
`;

/** Filmic-ish grade: contrast, saturation, warm lift and a soft vignette. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.1 },
    uVignette: { value: 0.28 },
    uTint: { value: new THREE.Color(1.02, 1.0, 0.97) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      c = (c - 0.5) * uContrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c *= uTint;
      vec2 d = vUv - 0.5;
      float vig = 1.0 - dot(d, d) * uVignette * 2.2;
      c *= clamp(vig, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), tex.a);
    }
  `,
};

export interface SkyPalette {
  top: number;
  horizon: number;
  ground: number;
  fog: number;
  sun: number;
  sunIntensity: number;
  ambient: number;
  ambientIntensity: number;
}

const PALETTE_KEYS: { t: number; p: SkyPalette }[] = [
  { t: 0.0, p: { top: 0x1d3357, horizon: 0x5c6f96, ground: 0x2a2f42, fog: 0x6b7ba0, sun: 0xa9c0ff, sunIntensity: 0.7, ambient: 0x4c5f86, ambientIntensity: 0.8 } },
  { t: 0.14, p: { top: 0x4a6fae, horizon: 0xf0a878, ground: 0x53483f, fog: 0xd7a184, sun: 0xffc48a, sunIntensity: 1.35, ambient: 0x8b7fa0, ambientIntensity: 0.9 } },
  { t: 0.32, p: { top: 0x3f8fe0, horizon: 0xbfe0f5, ground: 0x6c7b62, fog: 0xa9d2ec, sun: 0xfff2d6, sunIntensity: 2.0, ambient: 0x9fc4e8, ambientIntensity: 1.0 } },
  { t: 0.58, p: { top: 0x2f7fd8, horizon: 0xc7e6f7, ground: 0x69795f, fog: 0xa2cfec, sun: 0xffefd0, sunIntensity: 2.1, ambient: 0x9dc2e6, ambientIntensity: 1.0 } },
  { t: 0.78, p: { top: 0x35558f, horizon: 0xf2a06a, ground: 0x54473c, fog: 0xdb9c7c, sun: 0xffb070, sunIntensity: 1.4, ambient: 0x8d7c9c, ambientIntensity: 0.9 } },
  { t: 1.0, p: { top: 0x1d3357, horizon: 0x5c6f96, ground: 0x2a2f42, fog: 0x6b7ba0, sun: 0xa9c0ff, sunIntensity: 0.7, ambient: 0x4c5f86, ambientIntensity: 0.8 } },
];

const _colorA = new THREE.Color();
const _colorB = new THREE.Color();

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fog: THREE.Fog;
  /** Current sun direction, shared with the water shader. */
  readonly sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  readonly sunColor = new THREE.Color(0xffefd0);

  private skyMesh: THREE.Mesh;
  private skyMaterial: THREE.ShaderMaterial;
  private brushPreview: THREE.Mesh;
  private brushMaterial: THREE.MeshBasicMaterial;
  private renderDistance = 9;
  private shadowsEnabled = true;
  private readonly tint = new THREE.Color();

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private fxaaPass: ShaderPass | null = null;
  private gradePass: ShaderPass | null = null;
  private postEnabled = true;
  private aaEnabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / Math.max(1, window.innerHeight), 0.1, 900);
    this.camera.rotation.order = 'YXZ';

    this.fog = new THREE.Fog(0xa2cfec, 40, this.renderDistance * 16);
    this.scene.fog = this.fog;
    this.camera.far = this.renderDistance * 16 + 260;

    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x2f7fd8) },
        uHorizon: { value: new THREE.Color(0xc7e6f7) },
        uGround: { value: new THREE.Color(0x69795f) },
        uSunDir: { value: this.sunDir.clone() },
        uSunColor: { value: new THREE.Color(0xffefd0) },
      },
    });
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -1;
    this.scene.add(this.skyMesh);

    this.hemi = new THREE.HemisphereLight(0x9dc2e6, 0x8a866f, 1.0);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffefd0, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 190;
    const span = 52;
    this.sun.shadow.camera.left = -span;
    this.sun.shadow.camera.right = span;
    this.sun.shadow.camera.top = span;
    this.sun.shadow.camera.bottom = -span;
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.06;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Translucent brush preview sphere for Terrain Mode.
    // FrontSide only: when the player stands inside the brush volume the near
    // hemisphere is culled, so the preview never blinds them.
    this.brushMaterial = new THREE.MeshBasicMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.brushPreview = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.brushMaterial);
    this.brushPreview.visible = false;
    this.brushPreview.renderOrder = 5;
    this.scene.add(this.brushPreview);

    this.setRenderDistance(this.renderDistance);
    this.buildComposer();
  }

  // -------------------------------------------------------- post stack

  private buildComposer(): void {
    try {
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));

      const size = this.renderer.getSize(new THREE.Vector2());
      const bloom = new UnrealBloomPass(size, 0.42, 0.75, 0.82);
      composer.addPass(bloom);

      const grade = new ShaderPass(GradeShader);
      composer.addPass(grade);

      const fxaa = new ShaderPass(FXAAShader);
      composer.addPass(fxaa);

      composer.addPass(new OutputPass());

      this.composer = composer;
      this.bloomPass = bloom;
      this.gradePass = grade;
      this.fxaaPass = fxaa;
      this.updateComposerSize();
    } catch {
      // Post-processing is a nicety; the game renders fine without it.
      this.composer = null;
      this.postEnabled = false;
    }
  }

  private updateComposerSize(): void {
    if (!this.composer) return;
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const pr = this.renderer.getPixelRatio();
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    if (this.fxaaPass) {
      const u = this.fxaaPass.material.uniforms.resolution;
      if (u) u.value.set(1 / (w * pr), 1 / (h * pr));
    }
  }

  setPostProcessing(enabled: boolean): void {
    this.postEnabled = enabled && this.composer !== null;
  }

  setAntialias(enabled: boolean): void {
    this.aaEnabled = enabled;
    if (this.fxaaPass) this.fxaaPass.enabled = enabled;
  }

  setBloomStrength(strength: number): void {
    if (this.bloomPass) this.bloomPass.strength = strength;
  }

  /** Nudge the colour grade - used to warm the image while resting. */
  setGrade(contrast: number, saturation: number, vignette: number): void {
    if (!this.gradePass) return;
    const u = this.gradePass.material.uniforms;
    if (u.uContrast) u.uContrast.value = contrast;
    if (u.uSaturation) u.uSaturation.value = saturation;
    if (u.uVignette) u.uVignette.value = vignette;
  }

  get postProcessing(): boolean {
    return this.postEnabled;
  }

  get antialias(): boolean {
    return this.aaEnabled;
  }

  // ----------------------------------------------------------- viewport

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(w, h, false);
    this.updateComposerSize();
  }

  setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  setRenderDistance(chunks: number): void {
    this.renderDistance = chunks;
    const far = chunks * 16;
    this.fog.near = far * 0.45;
    this.fog.far = far * 1.1;
    this.camera.far = Math.max(260, far + 240);
    this.camera.updateProjectionMatrix();
    this.skyMesh.scale.setScalar(this.camera.far * 0.85);
  }

  /** World-space render distance used for terrain chunk culling. */
  get renderDistanceUnits(): number {
    return this.renderDistance * 16;
  }

  get renderDistanceChunks(): number {
    return this.renderDistance;
  }

  setShadows(enabled: boolean, quality = 1): void {
    this.shadowsEnabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.sun.castShadow = enabled;
    const size = quality >= 2 ? 2048 : quality >= 1 ? 1024 : 512;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    const span = quality >= 2 ? 64 : 48;
    this.sun.shadow.camera.left = -span;
    this.sun.shadow.camera.right = span;
    this.sun.shadow.camera.top = span;
    this.sun.shadow.camera.bottom = -span;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
  }

  get shadows(): boolean {
    return this.shadowsEnabled;
  }

  // ------------------------------------------------------- day / night

  updateDayNight(timeOfDay: number, shrineTint: THREE.Color, tintStrength: number): void {
    const t = ((timeOfDay % 1) + 1) % 1;
    let a = PALETTE_KEYS[0]!;
    let b = PALETTE_KEYS[PALETTE_KEYS.length - 1]!;
    for (let i = 0; i < PALETTE_KEYS.length - 1; i++) {
      if (t >= PALETTE_KEYS[i]!.t && t <= PALETTE_KEYS[i + 1]!.t) {
        a = PALETTE_KEYS[i]!;
        b = PALETTE_KEYS[i + 1]!;
        break;
      }
    }
    const span = Math.max(0.0001, b.t - a.t);
    const k = (t - a.t) / span;

    const mix = (ca: number, cb: number, target: THREE.Color): THREE.Color => {
      _colorA.setHex(ca);
      _colorB.setHex(cb);
      return target.copy(_colorA).lerp(_colorB, k);
    };

    mix(a.p.top, b.p.top, this.skyMaterial.uniforms.uTop!.value as THREE.Color);
    mix(a.p.horizon, b.p.horizon, this.skyMaterial.uniforms.uHorizon!.value as THREE.Color);
    mix(a.p.ground, b.p.ground, this.skyMaterial.uniforms.uGround!.value as THREE.Color);
    mix(a.p.sun, b.p.sun, this.skyMaterial.uniforms.uSunColor!.value as THREE.Color);
    mix(a.p.sun, b.p.sun, this.sun.color);
    mix(a.p.sun, b.p.sun, this.sunColor);
    mix(a.p.ambient, b.p.ambient, this.hemi.color);
    mix(a.p.fog, b.p.fog, this.tint);

    if (tintStrength > 0.01) {
      this.tint.lerp(shrineTint, tintStrength * 0.5);
      this.hemi.color.lerp(shrineTint, tintStrength * 0.3);
    }
    this.hemi.groundColor.copy(this.hemi.color).multiplyScalar(0.62).offsetHSL(-0.08, -0.25, 0);
    this.fog.color.copy(this.tint);
    this.renderer.setClearColor(this.tint);

    this.sun.intensity = a.p.sunIntensity + (b.p.sunIntensity - a.p.sunIntensity) * k;
    this.hemi.intensity = a.p.ambientIntensity + (b.p.ambientIntensity - a.p.ambientIntensity) * k;

    const angle = t * Math.PI * 2 - Math.PI / 2;
    this.sunDir.set(Math.cos(angle) * 0.75, Math.max(0.24, Math.sin(angle) * 0.9 + 0.3), 0.42).normalize();
    (this.skyMaterial.uniforms.uSunDir!.value as THREE.Vector3).copy(this.sunDir);
  }

  get fogNear(): number { return this.fog.near; }
  get fogFar(): number { return this.fog.far; }
  get fogColor(): THREE.Color { return this.fog.color; }

  followCamera(): void {
    this.skyMesh.position.copy(this.camera.position);
    const target = this.sun.target;
    target.position.set(this.camera.position.x, Math.min(this.camera.position.y, WORLD_HEIGHT), this.camera.position.z);
    target.updateMatrixWorld();
    this.sun.position.copy(target.position).addScaledVector(this.sunDir, 90);
    this.sun.updateMatrixWorld();
  }

  /** Show the translucent terrain brush preview. */
  setBrushPreview(point: THREE.Vector3 | null, radius = 1, adding = false): void {
    if (!point) {
      this.brushPreview.visible = false;
      return;
    }
    this.brushPreview.visible = true;
    this.brushPreview.position.copy(point);
    this.brushPreview.scale.setScalar(radius);
    this.brushMaterial.color.setHex(adding ? 0x8bd66a : 0x9fd8ff);
  }

  render(): void {
    if (this.postEnabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.skyMaterial.dispose();
    this.brushPreview.geometry.dispose();
    this.brushMaterial.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
  }
}
