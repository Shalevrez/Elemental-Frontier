/**
 * Terrain edit journal.
 *
 * The base world stays perfectly deterministic from its seed, so a save only
 * has to remember what the *player* changed. Every brush stroke is recorded as
 * a compact sphere operation and replayed onto the freshly generated density
 * field when the world loads.
 *
 * Storage format is a flat number array (7 numbers per operation) which keeps
 * the JSON small and easy to version.
 *
 * Pure and engine-free.
 */

import { Mat, isValidMaterial, type MaterialId } from './materials';
import { WORLD_HEIGHT, WORLD_SIZE } from './coords';

/** Numbers per operation in the flat serialised form. */
export const OP_STRIDE = 7;

/** Hard ceiling so a very long session can never blow the storage quota. */
export const MAX_EDIT_OPS = 6000;

export const MIN_BRUSH = 1.5;
export const MAX_BRUSH = 7;

export interface TerrainOp {
  x: number;
  y: number;
  z: number;
  /** Brush radius in world units. */
  radius: number;
  /** Signed strength: positive adds terrain, negative excavates. */
  strength: number;
  /** Material deposited when adding. Ignored when excavating. */
  material: MaterialId;
}

/** Round to two decimals so serialised ops stay short. */
function q(v: number): number {
  return Math.round(v * 100) / 100;
}

export function serialiseOps(ops: readonly TerrainOp[]): number[] {
  const out: number[] = [];
  const start = Math.max(0, ops.length - MAX_EDIT_OPS);
  for (let i = start; i < ops.length; i++) {
    const op = ops[i]!;
    out.push(q(op.x), q(op.y), q(op.z), q(op.radius), q(op.strength), op.material, 0);
  }
  return out;
}

/**
 * Rebuild an operation list from stored data. Anything malformed is dropped
 * rather than throwing, so a damaged save still loads.
 */
export function deserialiseOps(raw: unknown): TerrainOp[] {
  const ops: TerrainOp[] = [];
  if (!Array.isArray(raw)) return ops;
  for (let i = 0; i + OP_STRIDE - 1 < raw.length; i += OP_STRIDE) {
    const x = Number(raw[i]);
    const y = Number(raw[i + 1]);
    const z = Number(raw[i + 2]);
    const radius = Number(raw[i + 3]);
    const strength = Number(raw[i + 4]);
    const material = Number(raw[i + 5]);
    if (![x, y, z, radius, strength].every((n) => Number.isFinite(n))) continue;
    if (x < -8 || x > WORLD_SIZE + 8 || z < -8 || z > WORLD_SIZE + 8) continue;
    if (y < -8 || y > WORLD_HEIGHT + 8) continue;
    if (radius < 0.2 || radius > MAX_BRUSH * 2) continue;
    if (strength === 0 || Math.abs(strength) > 12) continue;
    ops.push({
      x, y, z, radius, strength,
      material: isValidMaterial(material) ? material : Mat.SOIL,
    });
    if (ops.length >= MAX_EDIT_OPS) break;
  }
  return ops;
}

/**
 * Approximate volume of a brush stroke, used to price excavation and
 * deposition. Deliberately simple: proportional to the sphere volume scaled by
 * how hard the stroke pushes.
 */
export function brushVolume(radius: number, strength: number): number {
  const r = Math.max(0, radius);
  return (4 / 3) * Math.PI * r * r * r * Math.min(1, Math.abs(strength)) * 0.055;
}

/** Clamp a requested brush radius into the allowed range. */
export function clampBrush(radius: number): number {
  return Math.min(MAX_BRUSH, Math.max(MIN_BRUSH, radius));
}

export interface EditJournal {
  ops: TerrainOp[];
  /** Bumped whenever an op is appended, so callers can tell when to autosave. */
  revision: number;
}

export function createJournal(ops: TerrainOp[] = []): EditJournal {
  return { ops, revision: 0 };
}

export function pushOp(journal: EditJournal, op: TerrainOp): void {
  journal.ops.push(op);
  // Trim from the front once the ceiling is reached. Old strokes that have
  // already been covered by newer ones are the least valuable to keep.
  if (journal.ops.length > MAX_EDIT_OPS) {
    journal.ops.splice(0, journal.ops.length - MAX_EDIT_OPS);
  }
  journal.revision++;
}
