/**
 * Chunk meshing worker.
 *
 * The main thread copies a padded block of the density field into a
 * transferable buffer and hands it over; the worker runs Surface Nets and
 * transfers the finished geometry back. Nothing is shared, so no
 * SharedArrayBuffer (and therefore no cross-origin isolation headers) is
 * needed and the game still runs from a plain local dev server.
 *
 * The game falls back to synchronous main-thread meshing if a worker cannot be
 * created, so this file is an optimisation rather than a requirement.
 */

import { buildChunkMesh } from './surfaceNets';

export interface MeshRequest {
  id: number;
  originX: number;
  originY: number;
  originZ: number;
  density: Float32Array;
  material: Uint8Array;
}

export interface MeshResponse {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  triangles: number;
}

self.onmessage = (event: MessageEvent<MeshRequest>): void => {
  const req = event.data;
  const mesh = buildChunkMesh({
    density: req.density,
    material: req.material,
    originX: req.originX,
    originY: req.originY,
    originZ: req.originZ,
  });

  const response: MeshResponse = {
    id: req.id,
    positions: mesh.positions,
    normals: mesh.normals,
    colors: mesh.colors,
    indices: mesh.indices,
    triangles: mesh.triangles,
  };

  // Only transfer buffers that actually hold data; a zero-length buffer can be
  // shared and transferring it twice would detach it permanently.
  const transfer = [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.colors.buffer,
    mesh.indices.buffer,
  ].filter((b) => b.byteLength > 0);

  (self as unknown as Worker).postMessage(response, transfer);
};
