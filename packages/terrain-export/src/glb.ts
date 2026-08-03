/**
 * glTF 2.0 binary (.glb) tile export (spec §18).
 *
 * Tiles are emitted as indexed triangle meshes with explicit normals, in the
 * local terrain frame (metres, right-handed, Y-up, north = −Z), so Godot's
 * importer needs no scale factor and no axis swap.
 *
 * ## Winding
 *
 * Triangles are wound so that the geometric normal points **+Y** for
 * upward-facing ground, which is glTF's counter-clockwise front-face
 * convention. With `col` toward +X and `row` toward +Z, the two triangles of a
 * quad are `(v00, v01, v11)` and `(v00, v11, v10)`; the cross products of both
 * come out along +Y. Getting this backwards renders every tile inside-out and
 * makes collision normals point into the ground, so it is asserted in the
 * round-trip test rather than assumed.
 */

import type { TerrainLayer } from '@lts/shared-types';

export interface TileSpec {
  /** Tile identifier, unique within the layer. */
  id: string;
  /** First column of the layer covered by this tile. */
  col0: number;
  /** First row of the layer covered by this tile. */
  row0: number;
  /** Sample counts in this tile (inclusive of the shared edge). */
  widthSamples: number;
  heightSamples: number;
}

/**
 * Divide a layer into tiles that **share their boundary samples**.
 *
 * Adjacent tiles overlap by exactly one row/column of samples. That is what
 * eliminates cracks (spec §14): both tiles evaluate the identical elevation on
 * the shared edge, so there is no seam to interpolate across and no need for
 * skirts.
 */
export function tileLayer(layer: TerrainLayer, tileSizeSamples: number): TileSpec[] {
  const step = tileSizeSamples - 1;
  const tiles: TileSpec[] = [];
  for (let row0 = 0; row0 < layer.heightSamples - 1; row0 += step) {
    for (let col0 = 0; col0 < layer.widthSamples - 1; col0 += step) {
      const w = Math.min(tileSizeSamples, layer.widthSamples - col0);
      const h = Math.min(tileSizeSamples, layer.heightSamples - row0);
      if (w < 2 || h < 2) continue;
      tiles.push({
        id: `${layer.id}_t${String(col0).padStart(6, '0')}_${String(row0).padStart(6, '0')}`,
        col0,
        row0,
        widthSamples: w,
        heightSamples: h,
      });
    }
  }
  return tiles;
}

export interface TileGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
}

/** Build the mesh for one tile, in local-frame metres. */
export function buildTileGeometry(layer: TerrainLayer, tile: TileSpec): TileGeometry {
  const { widthSamples: W, heightSamples: H } = tile;
  const res = layer.horizontalResolutionMeters;
  const positions = new Float32Array(W * H * 3);
  const normals = new Float32Array(W * H * 3);
  const indices = new Uint32Array((W - 1) * (H - 1) * 6);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const heightAt = (c: number, r: number): number => {
    const gc = Math.max(0, Math.min(layer.widthSamples - 1, tile.col0 + c));
    const gr = Math.max(0, Math.min(layer.heightSamples - 1, tile.row0 + r));
    return layer.heightData[gr * layer.widthSamples + gc];
  };

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 3;
      const x = layer.bounds.minX + (tile.col0 + c) * res;
      const z = layer.bounds.minZ + (tile.row0 + r) * res;
      const y = heightAt(c, r);
      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = z;

      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;

      // Central-difference normal, sampled from the *layer* so tile edges
      // agree with their neighbours instead of flattening at the seam.
      const hl = heightAt(c - 1, r);
      const hr = heightAt(c + 1, r);
      const hd = heightAt(c, r - 1);
      const hu = heightAt(c, r + 1);
      const nx = -(hr - hl) / (2 * res);
      const nz = -(hu - hd) / (2 * res);
      const len = Math.hypot(nx, 1, nz);
      normals[i] = nx / len;
      normals[i + 1] = 1 / len;
      normals[i + 2] = nz / len;
    }
  }

  let k = 0;
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const i00 = r * W + c;
      const i10 = r * W + c + 1;
      const i01 = (r + 1) * W + c;
      const i11 = (r + 1) * W + c + 1;
      // Both triangles wind to a +Y normal (see the module note).
      indices[k++] = i00;
      indices[k++] = i01;
      indices[k++] = i11;
      indices[k++] = i00;
      indices[k++] = i11;
      indices[k++] = i10;
    }
  }

  return { positions, normals, indices, min, max };
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Encode a tile as a self-contained .glb buffer. */
export function encodeGlb(geometry: TileGeometry, name: string): Buffer {
  const { positions, normals, indices } = geometry;

  const posBytes = positions.byteLength;
  const nrmBytes = normals.byteLength;
  const idxBytes = indices.byteLength;

  const posOffset = 0;
  const nrmOffset = align4(posOffset + posBytes);
  const idxOffset = align4(nrmOffset + nrmBytes);
  const binLength = align4(idxOffset + idxBytes);

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'lunar-terrain-sidecar',
    },
    scene: 0,
    scenes: [{ nodes: [0], name }],
    nodes: [{ mesh: 0, name }],
    meshes: [
      {
        name,
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            mode: 4, // TRIANGLES
          },
        ],
      },
    ],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: nrmOffset, byteLength: nrmBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: positions.length / 3,
        type: 'VEC3',
        min: geometry.min,
        max: geometry.max,
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: normals.length / 3,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        componentType: 5125, // UNSIGNED_INT
        count: indices.length,
        type: 'SCALAR',
      },
    ],
  };

  let json = JSON.stringify(gltf);
  while (json.length % 4 !== 0) json += ' ';
  const jsonBuf = Buffer.from(json, 'utf8');

  const bin = Buffer.alloc(binLength);
  Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(bin, posOffset);
  Buffer.from(normals.buffer, normals.byteOffset, nrmBytes).copy(bin, nrmOffset);
  Buffer.from(indices.buffer, indices.byteOffset, idxBytes).copy(bin, idxOffset);

  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const out = Buffer.allocUnsafe(total);
  let o = 0;
  out.write('glTF', o, 'latin1');
  o += 4;
  out.writeUInt32LE(2, o);
  o += 4;
  out.writeUInt32LE(total, o);
  o += 4;

  out.writeUInt32LE(jsonBuf.length, o);
  o += 4;
  out.write('JSON', o, 'latin1');
  o += 4;
  jsonBuf.copy(out, o);
  o += jsonBuf.length;

  out.writeUInt32LE(bin.length, o);
  o += 4;
  out.write('BIN\0', o, 'latin1');
  o += 4;
  bin.copy(out, o);

  return out;
}
