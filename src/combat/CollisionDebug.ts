/**
 * Development collision visualiser.
 *
 * Draws the player capsule, every registered obstacle collider, the terrain
 * contact normal, the ground-contact state and the currently resolved safe
 * respawn point. Disabled by default and costs nothing until it is switched on
 * with F10.
 */

import * as THREE from 'three';
import type { Obstacle, ObstacleField } from '../world/Obstacles';
import { PLAYER_HEIGHT, PLAYER_RADIUS, type ContactReport } from '../player/collision';

export interface CollisionFrame {
  /** Player capsule base (feet) position. */
  x: number;
  y: number;
  z: number;
  onGround: boolean;
  overlapping: boolean;
  steep: boolean;
  ceiling: boolean;
  /** Deepest contact normal this frame. */
  normal: { x: number; y: number; z: number };
  /** Currently resolved safe respawn position. */
  respawn: { x: number; y: number; z: number } | null;
  /** How the respawn point was resolved. */
  respawnSource: string;
  /** Terrain density directly under the feet. */
  groundDensity: number;
  /** Obstacles near the player. */
  nearby: readonly Obstacle[];
}

const CAPSULE_OK = 0x63d38a;
const CAPSULE_OVERLAP = 0xff5f6d;
const CAPSULE_AIR = 0x8fd4ff;
const OBSTACLE_SOLID = 0xffb03a;
const OBSTACLE_PASSABLE = 0x6f7d92;

export class CollisionDebug {
  readonly group = new THREE.Group();
  enabled = false;

  private capsule: THREE.LineSegments;
  private normalLine: THREE.Line;
  private respawnMarker: THREE.Mesh;
  private obstacleMeshes: THREE.LineSegments[] = [];
  private readonly obstacleMaterial = new THREE.LineBasicMaterial({ color: OBSTACLE_SOLID });
  private readonly passableMaterial = new THREE.LineBasicMaterial({ color: OBSTACLE_PASSABLE });
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor() {
    this.group.name = 'collision-debug';
    this.group.visible = false;
    this.group.renderOrder = 999;

    const capsuleGeo = new THREE.EdgesGeometry(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, Math.max(0.1, PLAYER_HEIGHT - PLAYER_RADIUS * 2), 4, 12),
    );
    const capsuleMat = new THREE.LineBasicMaterial({ color: CAPSULE_OK, depthTest: false });
    this.capsule = new THREE.LineSegments(capsuleGeo, capsuleMat);
    this.group.add(this.capsule);
    this.disposables.push(capsuleGeo, capsuleMat);

    const normalGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(0, 1, 0),
    ]);
    const normalMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
    this.normalLine = new THREE.Line(normalGeo, normalMat);
    this.group.add(this.normalLine);
    this.disposables.push(normalGeo, normalMat);

    const markerGeo = new THREE.OctahedronGeometry(0.45, 0);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x63d38a, wireframe: true, depthTest: false });
    this.respawnMarker = new THREE.Mesh(markerGeo, markerMat);
    this.group.add(this.respawnMarker);
    this.disposables.push(markerGeo, markerMat, this.obstacleMaterial, this.passableMaterial);
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.group.visible = this.enabled;
    return this.enabled;
  }

  /** Redraw the overlay. A cheap no-op while it is disabled. */
  update(frame: CollisionFrame, obstacles: ObstacleField | null): void {
    if (!this.enabled) return;

    this.capsule.position.set(frame.x, frame.y + PLAYER_HEIGHT / 2, frame.z);
    const mat = this.capsule.material as THREE.LineBasicMaterial;
    mat.color.setHex(
      frame.overlapping ? CAPSULE_OVERLAP : frame.onGround ? CAPSULE_OK : CAPSULE_AIR,
    );

    const positions = this.normalLine.geometry.attributes.position as THREE.BufferAttribute;
    positions.setXYZ(0, frame.x, frame.y + 0.1, frame.z);
    positions.setXYZ(
      1,
      frame.x + frame.normal.x * 1.6,
      frame.y + 0.1 + frame.normal.y * 1.6,
      frame.z + frame.normal.z * 1.6,
    );
    positions.needsUpdate = true;

    if (frame.respawn) {
      this.respawnMarker.visible = true;
      this.respawnMarker.position.set(frame.respawn.x, frame.respawn.y + 1, frame.respawn.z);
      this.respawnMarker.rotation.y += 0.02;
    } else {
      this.respawnMarker.visible = false;
    }

    this.syncObstacles(obstacles, frame);
  }

  private syncObstacles(obstacles: ObstacleField | null, frame: CollisionFrame): void {
    const near = obstacles ? obstacles.query(frame.x, frame.z, 22) : [];
    while (this.obstacleMeshes.length < near.length) {
      const geo = new THREE.EdgesGeometry(new THREE.CylinderGeometry(1, 1, 1, 10));
      const mesh = new THREE.LineSegments(geo, this.obstacleMaterial);
      this.disposables.push(geo);
      this.obstacleMeshes.push(mesh);
      this.group.add(mesh);
    }
    for (let i = 0; i < this.obstacleMeshes.length; i++) {
      const mesh = this.obstacleMeshes[i]!;
      const o = near[i];
      if (!o) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.material = o.solid ? this.obstacleMaterial : this.passableMaterial;
      const rx = o.shape === 'box' ? o.halfX : o.radius;
      const rz = o.shape === 'box' ? o.halfZ : o.radius;
      mesh.position.set(o.x, o.y + o.height / 2, o.z);
      mesh.scale.set(rx, o.height, rz);
    }
  }

  /** One-line readout for the HUD debug panel. */
  readout(frame: CollisionFrame): string {
    const parts = [
      `pos ${frame.x.toFixed(1)}, ${frame.y.toFixed(1)}, ${frame.z.toFixed(1)}`,
      frame.onGround ? 'grounded' : 'airborne',
      frame.overlapping ? 'OVERLAP' : 'clear',
      frame.steep ? 'steep' : '',
      frame.ceiling ? 'ceiling' : '',
      `n ${frame.normal.x.toFixed(2)}/${frame.normal.y.toFixed(2)}/${frame.normal.z.toFixed(2)}`,
      `density ${frame.groundDensity.toFixed(2)}`,
      `colliders ${frame.nearby.length}`,
      frame.respawn
        ? `respawn ${frame.respawn.x.toFixed(0)},${frame.respawn.y.toFixed(0)},${frame.respawn.z.toFixed(0)} (${frame.respawnSource})`
        : 'respawn unresolved',
    ];
    return parts.filter(Boolean).join(' · ');
  }

  /** Snapshot the contact report into a frame. */
  static contactToFrame(report: ContactReport): { steep: boolean; ceiling: boolean; normal: { x: number; y: number; z: number } } {
    return {
      steep: report.steep,
      ceiling: report.ceiling,
      normal: { x: report.nx, y: report.ny, z: report.nz },
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.obstacleMeshes.length = 0;
  }
}
