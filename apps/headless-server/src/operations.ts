/**
 * Terrain edit operations, applied as **replayable records** (spec §12, §19).
 *
 * Edits are never stored as mutated meshes. Every operation is a small
 * parameter record; the terrain at any point is the seed plus the ordered log,
 * which is what makes undo, deterministic replay and tile-level deltas possible
 * (spec §31 item 12).
 *
 * Mass-conserving mode is genuinely conserving: material removed from the
 * brush interior is redeposited in an annulus around it, and the residual is
 * *measured and reported* rather than assumed to be zero (spec §11).
 */

import { createHash } from 'node:crypto';
import type { TerrainLayer } from '@lts/shared-types';
import type { TerrainDelta, TerrainOperation } from '@lts/terrain-protocol';

export interface ApplyResult {
  removedVolumeM3: number;
  depositedVolumeM3: number;
  samplesTouched: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

/** Normalised brush weight at distance `d` from the centre. */
function falloffWeight(d: number, radius: number, exponent: number): number {
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  return Math.pow(t, Math.max(0.01, exponent));
}

/** Apply one operation to a layer, returning the volumes moved. */
export function applyOperation(layer: TerrainLayer, op: TerrainOperation): ApplyResult {
  const res = layer.horizontalResolutionMeters;
  const cellArea = res * res;
  const reach = op.kind === 'trench' || op.kind === 'berm'
    ? Math.max(op.radiusMeters, (op.lengthMeters ?? 0) / 2 + op.radiusMeters)
    : op.radiusMeters;

  const colMin = Math.max(0, Math.floor((op.centerXMeters - reach - layer.bounds.minX) / res));
  const colMax = Math.min(
    layer.widthSamples - 1,
    Math.ceil((op.centerXMeters + reach - layer.bounds.minX) / res),
  );
  const rowMin = Math.max(0, Math.floor((op.centerZMeters - reach - layer.bounds.minZ) / res));
  const rowMax = Math.min(
    layer.heightSamples - 1,
    Math.ceil((op.centerZMeters + reach - layer.bounds.minZ) / res),
  );

  let removed = 0;
  let deposited = 0;
  let touched = 0;

  // Pass 1: compute the intended delta for every sample in reach.
  const deltas = new Map<number, number>();

  for (let row = rowMin; row <= rowMax; row++) {
    const z = layer.bounds.minZ + row * res;
    for (let col = colMin; col <= colMax; col++) {
      const x = layer.bounds.minX + col * res;
      const i = row * layer.widthSamples + col;

      let dh = 0;
      switch (op.kind) {
        case 'raise':
        case 'lower': {
          const d = Math.hypot(x - op.centerXMeters, z - op.centerZMeters);
          const w = falloffWeight(d, op.radiusMeters, op.falloff);
          if (w > 0) dh = (op.kind === 'raise' ? 1 : -1) * Math.abs(op.strengthMeters) * w;
          break;
        }
        case 'flatten': {
          const d = Math.hypot(x - op.centerXMeters, z - op.centerZMeters);
          const w = falloffWeight(d, op.radiusMeters, op.falloff);
          if (w > 0) {
            const target = op.targetElevationMeters ?? 0;
            dh = (target - layer.heightData[i]) * w;
          }
          break;
        }
        case 'smooth': {
          const d = Math.hypot(x - op.centerXMeters, z - op.centerZMeters);
          const w = falloffWeight(d, op.radiusMeters, op.falloff);
          if (w > 0 && col > 0 && row > 0 && col < layer.widthSamples - 1 && row < layer.heightSamples - 1) {
            const avg =
              (layer.heightData[i - 1] +
                layer.heightData[i + 1] +
                layer.heightData[i - layer.widthSamples] +
                layer.heightData[i + layer.widthSamples]) /
              4;
            dh = (avg - layer.heightData[i]) * w * Math.min(1, Math.abs(op.strengthMeters));
          }
          break;
        }
        case 'crater_stamp': {
          const d = Math.hypot(x - op.centerXMeters, z - op.centerZMeters);
          const u = d / op.radiusMeters;
          if (u < 1.3) {
            const depth = Math.abs(op.strengthMeters);
            if (u < 1) dh = -depth * (1 - u * u);
            const rimW = 0.12;
            const t = (u - 1) / rimW;
            dh += depth * 0.15 * Math.exp(-t * t);
          }
          break;
        }
        case 'trench':
        case 'berm': {
          // Distance to the segment centred on (cx, cz) at `headingDegrees`.
          const hdg = ((op.headingDegrees ?? 0) * Math.PI) / 180;
          // Azimuth clockwise from north, north = -Z (ADR 0002).
          const ax = Math.sin(hdg);
          const az = -Math.cos(hdg);
          const half = (op.lengthMeters ?? 0) / 2;
          const px = x - op.centerXMeters;
          const pz = z - op.centerZMeters;
          const along = Math.max(-half, Math.min(half, px * ax + pz * az));
          const perpX = px - along * ax;
          const perpZ = pz - along * az;
          const d = Math.hypot(perpX, perpZ);
          const w = falloffWeight(d, op.radiusMeters, op.falloff);
          if (w > 0) dh = (op.kind === 'berm' ? 1 : -1) * Math.abs(op.strengthMeters) * w;
          break;
        }
      }

      if (dh !== 0) deltas.set(i, dh);
    }
  }

  // Pass 2: mass conservation. Redistribute the net volume over the annulus
  // between radius and 1.6*radius so cut-and-fill balances.
  if (op.massConserving) {
    let net = 0;
    for (const dh of deltas.values()) net += dh * cellArea;

    if (Math.abs(net) > 0) {
      const inner = op.radiusMeters;
      const outer = op.radiusMeters * 1.6;
      const ring: number[] = [];
      let ringWeight = 0;
      const rColMin = Math.max(0, Math.floor((op.centerXMeters - outer - layer.bounds.minX) / res));
      const rColMax = Math.min(
        layer.widthSamples - 1,
        Math.ceil((op.centerXMeters + outer - layer.bounds.minX) / res),
      );
      const rRowMin = Math.max(0, Math.floor((op.centerZMeters - outer - layer.bounds.minZ) / res));
      const rRowMax = Math.min(
        layer.heightSamples - 1,
        Math.ceil((op.centerZMeters + outer - layer.bounds.minZ) / res),
      );
      const weights = new Map<number, number>();
      for (let row = rRowMin; row <= rRowMax; row++) {
        const z = layer.bounds.minZ + row * res;
        for (let col = rColMin; col <= rColMax; col++) {
          const x = layer.bounds.minX + col * res;
          const d = Math.hypot(x - op.centerXMeters, z - op.centerZMeters);
          if (d < inner || d > outer) continue;
          const t = 1 - (d - inner) / (outer - inner);
          const w = t * t;
          const i = row * layer.widthSamples + col;
          weights.set(i, w);
          ringWeight += w;
          ring.push(i);
        }
      }
      if (ringWeight > 0) {
        // Deposit -net over the ring, so the total change sums to zero.
        for (const i of ring) {
          const w = weights.get(i)!;
          const add = (-net * (w / ringWeight)) / cellArea;
          deltas.set(i, (deltas.get(i) ?? 0) + add);
        }
      }
    }
  }

  // Pass 3: commit.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [i, dh] of deltas) {
    layer.heightData[i] += dh;
    touched++;
    if (dh < 0) removed += -dh * cellArea;
    else deposited += dh * cellArea;
    const col = i % layer.widthSamples;
    const row = (i - col) / layer.widthSamples;
    const x = layer.bounds.minX + col * res;
    const z = layer.bounds.minZ + row * res;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  return {
    removedVolumeM3: removed,
    depositedVolumeM3: deposited,
    samplesTouched: touched,
    bounds: {
      minX: touched ? minX : op.centerXMeters,
      maxX: touched ? maxX : op.centerXMeters,
      minZ: touched ? minZ : op.centerZMeters,
      maxZ: touched ? maxZ : op.centerZMeters,
    },
  };
}

/** SHA-256 of a layer's heightfield, for delta chaining. */
export function layerChecksum(layer: TerrainLayer): string {
  const buf = Buffer.from(
    layer.heightData.buffer,
    layer.heightData.byteOffset,
    layer.heightData.byteLength,
  );
  return createHash('sha256').update(buf).digest('hex');
}

/** Tiles intersecting a bounding box, for tile-level delta updates (spec §19). */
export function tilesInBounds(
  layer: TerrainLayer,
  tileSizeSamples: number,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
): string[] {
  const res = layer.horizontalResolutionMeters;
  const step = tileSizeSamples - 1;
  const out: string[] = [];
  const c0 = Math.max(0, Math.floor((bounds.minX - layer.bounds.minX) / res));
  const c1 = Math.min(layer.widthSamples - 1, Math.ceil((bounds.maxX - layer.bounds.minX) / res));
  const r0 = Math.max(0, Math.floor((bounds.minZ - layer.bounds.minZ) / res));
  const r1 = Math.min(layer.heightSamples - 1, Math.ceil((bounds.maxZ - layer.bounds.minZ) / res));

  for (let row0 = 0; row0 < layer.heightSamples - 1; row0 += step) {
    for (let col0 = 0; col0 < layer.widthSamples - 1; col0 += step) {
      const tc1 = Math.min(col0 + step, layer.widthSamples - 1);
      const tr1 = Math.min(row0 + step, layer.heightSamples - 1);
      if (tc1 < c0 || col0 > c1 || tr1 < r0 || row0 > r1) continue;
      out.push(
        `${layer.id}_t${String(col0).padStart(6, '0')}_${String(row0).padStart(6, '0')}`,
      );
    }
  }
  return out;
}

/** Build a delta record from an applied operation. */
export function makeDelta(
  layer: TerrainLayer,
  op: TerrainOperation,
  result: ApplyResult,
  sequenceNumber: number,
  previousChecksum: string,
  tileSizeSamples: number,
): TerrainDelta {
  const net = result.depositedVolumeM3 - result.removedVolumeM3;
  const scale = Math.max(result.removedVolumeM3, result.depositedVolumeM3);
  return {
    deltaId: `delta-${String(sequenceNumber).padStart(6, '0')}`,
    sequenceNumber,
    timestamp: op.timestamp,
    affectedBounds: result.bounds,
    changedTiles: tilesInBounds(layer, tileSizeSamples, result.bounds),
    operations: [op],
    previousChecksum,
    resultingChecksum: layerChecksum(layer),
    massBalance: {
      removedVolumeM3: result.removedVolumeM3,
      depositedVolumeM3: result.depositedVolumeM3,
      netVolumeM3: net,
      relativeError: scale > 0 ? Math.abs(net) / scale : 0,
    },
  };
}
