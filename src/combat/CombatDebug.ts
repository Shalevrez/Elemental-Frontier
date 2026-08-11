/**
 * Combat debug overlay.
 *
 * Development-only and **off by default**: `enabled` starts false, the toggle
 * key is ignored in a production build, and nothing is drawn, allocated or
 * logged until it is switched on. It exists so a combat bug can be seen rather
 * than guessed at - the camera ray, the resolved target point, the collision
 * volumes and the enemy hitboxes are all drawn in world space, and every hit,
 * miss and block is listed with its reason.
 *
 * Toggle with F9 while playing.
 */

import * as THREE from 'three';
import type { Capsule, Vec3 } from './hitVolumes';

/** One entry in the rolling event log. */
export interface DebugEvent {
  time: number;
  text: string;
}

export interface DebugFrame {
  /** Camera position and the crosshair ray. */
  eye: Vec3;
  forward: Vec3;
  /** Resolved aim target, if an ability has aimed this frame. */
  target: Vec3 | null;
  /** Whether terrain stopped the ray rather than the range limit. */
  blockedByTerrain: boolean;
  /** Maximum reach of the currently selected ability. */
  range: number;
  /** Enemy id the crosshair is on, if any. */
  targetId: number | null;
  /** Enemy hitboxes to outline. */
  hitboxes: readonly { id: number; capsule: Capsule; visible: boolean }[];
  /** Extra volumes: the current attack shape. */
  volumes: readonly Capsule[];
  /** Live projectile paths. */
  paths: readonly { from: Vec3; to: Vec3 }[];
  /** Director state. */
  tokens: { used: number; max: number };
  cooldown: number;
  energy: number;
}

const MAX_EVENTS = 14;
const CIRCLE_SEGMENTS = 12;

/** True only in a dev build; the overlay cannot be enabled in production. */
const DEV = typeof import.meta !== 'undefined'
  && Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

export class CombatDebug {
  /** Off until the player explicitly asks for it. */
  enabled = false;

  readonly group = new THREE.Group();

  private readonly events: DebugEvent[] = [];
  private clock = 0;
  private lastText = '';

  // One reused geometry per line layer, rewritten each frame while enabled.
  private readonly rayLine: THREE.LineSegments;
  private readonly boxLine: THREE.LineSegments;
  private readonly volumeLine: THREE.LineSegments;
  private readonly pathLine: THREE.LineSegments;
  private readonly marker: THREE.Mesh;

  constructor() {
    this.group.name = 'combat-debug';
    this.group.visible = false;
    this.group.renderOrder = 999;

    this.rayLine = makeLines(0x66ccff);
    this.boxLine = makeLines(0x66ff88);
    this.volumeLine = makeLines(0xffcc44);
    this.pathLine = makeLines(0xff66cc);
    this.group.add(this.rayLine, this.boxLine, this.volumeLine, this.pathLine);

    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, wireframe: true, depthTest: false, transparent: true, opacity: 0.9,
    });
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), markerMat);
    this.marker.visible = false;
    this.group.add(this.marker);
  }

  /** Available only in a dev build. Returns the new state. */
  toggle(): boolean {
    if (!DEV) return false;
    this.enabled = !this.enabled;
    this.group.visible = this.enabled;
    this.marker.visible = false;
    if (!this.enabled) {
      clearLines(this.rayLine);
      clearLines(this.boxLine);
      clearLines(this.volumeLine);
      clearLines(this.pathLine);
      this.events.length = 0;
    } else {
      this.push('combat debug ON (F9 to hide)');
    }
    return this.enabled;
  }

  /** Record an event. Console logging happens only while enabled. */
  push(text: string): void {
    if (!this.enabled) return;
    this.events.push({ time: this.clock, text });
    while (this.events.length > MAX_EVENTS) this.events.shift();
    // eslint-disable-next-line no-console
    console.debug(`[combat] ${text}`);
  }

  /** Redraw the world-space shapes. Returns early when disabled. */
  update(dt: number, frame: DebugFrame): void {
    this.clock += dt;
    if (!this.enabled) return;

    // ---- camera ray and the point it resolved to
    const rayEnd = frame.target ?? {
      x: frame.eye.x + frame.forward.x * frame.range,
      y: frame.eye.y + frame.forward.y * frame.range,
      z: frame.eye.z + frame.forward.z * frame.range,
    };
    const ray: number[] = [];
    pushSegment(ray, frame.eye, {
      x: frame.eye.x + frame.forward.x * frame.range,
      y: frame.eye.y + frame.forward.y * frame.range,
      z: frame.eye.z + frame.forward.z * frame.range,
    });
    setLines(this.rayLine, ray);

    this.marker.visible = frame.target !== null;
    if (frame.target) this.marker.position.set(rayEnd.x, rayEnd.y, rayEnd.z);

    // ---- enemy hitboxes; anything out of line of sight is drawn thinner
    const boxes: number[] = [];
    for (const box of frame.hitboxes) {
      pushCapsule(boxes, box.capsule, box.visible ? 1 : 0.55);
    }
    setLines(this.boxLine, boxes);

    // ---- current attack volumes
    const volumes: number[] = [];
    for (const v of frame.volumes) pushCapsule(volumes, v, 1);
    setLines(this.volumeLine, volumes);

    // ---- projectile paths
    const paths: number[] = [];
    for (const path of frame.paths) pushSegment(paths, path.from, path.to);
    setLines(this.pathLine, paths);
  }

  /** Text block for the on-screen panel. */
  readout(frame: DebugFrame): string {
    if (!this.enabled) return '';
    const lines = [
      `range ${frame.range.toFixed(1)}  dist ${frame.target
        ? distance(frame.eye, frame.target).toFixed(2) : '-'}`,
      `terrain ${frame.blockedByTerrain ? 'BLOCKED' : 'clear'}  target ${frame.targetId ?? '-'}`,
      `tokens ${frame.tokens.used}/${frame.tokens.max}  cd ${frame.cooldown.toFixed(2)}  energy ${frame.energy.toFixed(0)}`,
      `bodies ${frame.hitboxes.length}  volumes ${frame.volumes.length}  shots ${frame.paths.length}`,
      '--',
    ];
    for (const e of this.events) lines.push(`${e.time.toFixed(1)}s ${e.text}`);
    this.lastText = lines.join('\n');
    return this.lastText;
  }

  dispose(): void {
    for (const line of [this.rayLine, this.boxLine, this.volumeLine, this.pathLine]) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

function makeLines(color: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  const material = new THREE.LineBasicMaterial({
    color, depthTest: false, transparent: true, opacity: 0.9,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

function setLines(target: THREE.LineSegments, points: number[]): void {
  const attribute = target.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (attribute.count * 3 < points.length) {
    target.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  } else {
    (attribute.array as Float32Array).set(points);
    target.geometry.setDrawRange(0, points.length / 3);
    attribute.needsUpdate = true;
  }
  target.geometry.setDrawRange(0, points.length / 3);
}

function clearLines(target: THREE.LineSegments): void {
  target.geometry.setDrawRange(0, 0);
}

function pushSegment(out: number[], a: Vec3, b: Vec3): void {
  out.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

/**
 * Outline a capsule as two rings plus four verticals.
 *
 * The rings sit at the true top and bottom of the volume rather than at the
 * segment ends, so a small creature - whose capsule degenerates to a sphere -
 * still draws as a recognisable cage instead of a single flat circle.
 */
function pushCapsule(out: number[], capsule: Capsule, scale: number): void {
  const r = capsule.radius * scale;
  const lowY = Math.min(capsule.a.y, capsule.b.y) - r;
  const highY = Math.max(capsule.a.y, capsule.b.y) + r;
  for (const y of [lowY, highY]) {
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a0 = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / CIRCLE_SEGMENTS) * Math.PI * 2;
      out.push(
        capsule.a.x + Math.cos(a0) * r, y, capsule.a.z + Math.sin(a0) * r,
        capsule.a.x + Math.cos(a1) * r, y, capsule.a.z + Math.sin(a1) * r,
      );
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    out.push(
      capsule.a.x + Math.cos(a) * r, lowY, capsule.a.z + Math.sin(a) * r,
      capsule.b.x + Math.cos(a) * r, highY, capsule.b.z + Math.sin(a) * r,
    );
  }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
