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
import {
  ERROR_CODES,
  TerrainError,
  semanticIndex,
  type SemanticClass,
  type TerrainLayer,
} from '@lts/shared-types';
import type { TerrainDelta, TerrainOperation } from '@lts/terrain-protocol';

export interface ElevationStats {
  min: number;
  max: number;
  mean: number;
}

export interface ApplyResult {
  removedVolumeM3: number;
  depositedVolumeM3: number;
  samplesTouched: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** Elevation statistics over the touched samples, before the edit. */
  elevationBefore: ElevationStats;
  /** Elevation statistics over the touched samples, after the edit. */
  elevationAfter: ElevationStats;
  /**
   * Footprint-scoped bounds and elevation statistics for construction kinds:
   * the feature's own geometry, EXCLUDING the mass-conserving borrow ring.
   * `bounds`/`elevationBefore`/`elevationAfter` above cover every changed
   * sample (ring included) because tile invalidation needs them; a feature
   * record must use these instead or it claims the ring as part of itself.
   */
  featureBounds?: { minX: number; minZ: number; maxX: number; maxZ: number };
  featureElevationBefore?: ElevationStats;
  featureElevationAfter?: ElevationStats;
  /**
   * Present when the feature geometry is narrower than the sample grid can
   * represent (wheel-track ruts below one cell wide): recorded volumes are
   * then dominated by grid aliasing, not geometry.
   */
  aliasingWarning?: string;
  /**
   * Present when a spoil pile's requested height exceeded the regolith
   * angle-of-repose limit and was clamped (spec §11). Reported, never silent.
   */
  reposeClamp?: {
    requestedHeightMeters: number;
    appliedHeightMeters: number;
    reposeAngleDeg: number;
  };
}

/**
 * Approximate angle of repose for loose lunar regolith. A conical spoil pile
 * steeper than this would immediately slump, so requested pile heights are
 * clamped to radius * tan(repose) and the clamp is reported.
 */
const REPOSE_ANGLE_DEG = 35;
const TAN_REPOSE = Math.tan((REPOSE_ANGLE_DEG * Math.PI) / 180);

/**
 * Semantic class stamped over the samples a construction operation touches
 * (spec §11, §22). Only the shape samples are marked — the mass-conserving
 * redistribution ring is untouched regolith borrowing, not the feature itself.
 */
const CONSTRUCTION_SEMANTIC: Partial<Record<TerrainOperation['kind'], SemanticClass>> = {
  ramp: 'compacted_surface',
  pad: 'compacted_surface',
  spoil_pile: 'berm',
  wheel_track: 'disturbed_regolith',
  polygonal_cut: 'trench',
  polygonal_fill: 'berm',
};

/** Normalised brush weight at distance `d` from the centre. */
function falloffWeight(d: number, radius: number, exponent: number): number {
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  return Math.pow(t, Math.max(0.01, exponent));
}

/** 1 out to `edge`, then a smooth falloff to 0 across the next `band` metres. */
function plateauWeight(d: number, edge: number, band: number, exponent: number): number {
  if (d <= edge) return 1;
  return falloffWeight(d - edge, band, exponent);
}

/** Even-odd (ray-casting) point-in-polygon test in the XZ plane. */
function pointInPolygon(x: number, z: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Minimum distance from (x, z) to the polygon's boundary segments. */
function distanceToPolygonBoundary(x: number, z: number, poly: number[][]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0];
    const az = poly[j][1];
    const bx = poly[i][0];
    const bz = poly[i][1];
    const ex = bx - ax;
    const ez = bz - az;
    const lenSq = ex * ex + ez * ez;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / lenSq)) : 0;
    const d = Math.hypot(x - (ax + t * ex), z - (az + t * ez));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Validate a polygonal operation's vertices. Runs before the heightfield is
 * touched, for the same reason numeric parameters are checked in the server:
 * a malformed polygon must produce a structured error, not a committed NaN.
 */
function validatePolygon(op: TerrainOperation): number[][] {
  const poly = op.polygonXZ;
  if (!Array.isArray(poly) || poly.length < 3) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `operation.polygonXZ must be an array of at least 3 [x, z] vertices for '${op.kind}'`,
      { vertices: Array.isArray(poly) ? poly.length : String(poly) },
    );
  }
  for (let i = 0; i < poly.length; i++) {
    const v = poly[i];
    if (
      !Array.isArray(v) ||
      v.length !== 2 ||
      typeof v[0] !== 'number' ||
      typeof v[1] !== 'number' ||
      !Number.isFinite(v[0]) ||
      !Number.isFinite(v[1])
    ) {
      throw new TerrainError(
        ERROR_CODES.INVALID_CONFIG,
        `operation.polygonXZ[${i}] must be a finite [x, z] pair`,
        { vertex: String(v) },
      );
    }
  }
  return poly;
}

/** A required finite parameter for a construction kind. */
function requireFinite(v: number | undefined, name: string, kind: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `operation.${name} is required and must be a finite number for '${kind}'`,
      { [name]: String(v) },
    );
  }
  return v;
}

/** Apply one operation to a layer, returning the volumes moved. */
export function applyOperation(layer: TerrainLayer, op: TerrainOperation): ApplyResult {
  const res = layer.horizontalResolutionMeters;
  const cellArea = res * res;

  // ---- per-kind precomputation: parameters, footprint and validation ------
  // Heading unit vector: azimuth clockwise from north, north = -Z (ADR 0002).
  const hdg = ((op.headingDegrees ?? 0) * Math.PI) / 180;
  const ax = Math.sin(hdg);
  const az = -Math.cos(hdg);

  // Smooth edge falloff band for ramp/pad plateaus.
  const edgeBand = Math.max(2 * res, op.radiusMeters * 0.25);

  let aliasingWarning: string | undefined;
  let polygon: number[][] | null = null;
  let rampLength = 0;
  let rampNearElev = 0;
  let trackHalfLen = 0;
  let pileHeight = 0;
  let reposeClamp: ApplyResult['reposeClamp'];

  switch (op.kind) {
    case 'ramp': {
      requireFinite(op.targetElevationMeters, 'targetElevationMeters', op.kind);
      rampLength = requireFinite(op.lengthMeters, 'lengthMeters', op.kind);
      if (rampLength <= 0) {
        throw new TerrainError(
          ERROR_CODES.INVALID_CONFIG,
          `operation.lengthMeters must be positive for '${op.kind}'`,
          { lengthMeters: rampLength },
        );
      }
      // The near end keeps the existing grade: capture the pre-edit elevation
      // at the ramp origin before anything is mutated.
      const c = Math.max(
        0,
        Math.min(layer.widthSamples - 1, Math.round((op.centerXMeters - layer.bounds.minX) / res)),
      );
      const r = Math.max(
        0,
        Math.min(layer.heightSamples - 1, Math.round((op.centerZMeters - layer.bounds.minZ) / res)),
      );
      rampNearElev = layer.heightData[r * layer.widthSamples + c];
      break;
    }
    case 'pad':
      requireFinite(op.targetElevationMeters, 'targetElevationMeters', op.kind);
      break;
    case 'spoil_pile': {
      const requested = Math.abs(op.strengthMeters);
      const maxHeight = op.radiusMeters * TAN_REPOSE;
      pileHeight = Math.min(requested, maxHeight);
      if (requested > maxHeight) {
        reposeClamp = {
          requestedHeightMeters: requested,
          appliedHeightMeters: maxHeight,
          reposeAngleDeg: REPOSE_ANGLE_DEG,
        };
      }
      break;
    }
    case 'wheel_track': {
      // Ruts are 0.3*gauge wide; below one grid cell they cannot be resolved
      // and the recorded volumes measure aliasing, not geometry (measured:
      // 2.5x volume inflation at 0.5 m grid for a 2 m gauge). Warn, honestly.
      const rutWidth = 2 * 0.15 * op.radiusMeters;
      if (rutWidth < res) {
        aliasingWarning =
          `wheel_track rut width ${rutWidth.toFixed(2)} m is narrower than the ` +
          `${res} m sample grid; recorded volumes are grid-aliasing artifacts. ` +
          `Use a layer with resolution <= ${(rutWidth / 2).toFixed(2)} m for meaningful volumes.`;
      }
      const len = requireFinite(op.lengthMeters, 'lengthMeters', op.kind);
      if (len <= 0) {
        throw new TerrainError(
          ERROR_CODES.INVALID_CONFIG,
          `operation.lengthMeters must be positive for '${op.kind}'`,
          { lengthMeters: len },
        );
      }
      trackHalfLen = len / 2;
      break;
    }
    case 'polygonal_cut':
    case 'polygonal_fill':
      polygon = validatePolygon(op);
      requireFinite(op.targetElevationMeters, 'targetElevationMeters', op.kind);
      break;
  }

  // crater_stamp writes its rim Gaussian out to u = 1.3 (see the profile
  // below), so its bounding box must reach 1.3·radius. With reach = radius the
  // rim survived only in the square bbox corners, producing a four-lobed
  // crater whose rim existed on the diagonals and vanished along the axes.
  const reach = (() => {
    switch (op.kind) {
      case 'trench':
      case 'berm':
      case 'wheel_track':
        return Math.max(op.radiusMeters, (op.lengthMeters ?? 0) / 2 + op.radiusMeters);
      case 'crater_stamp':
        return op.radiusMeters * 1.3;
      case 'ramp':
        // From the near end out to the far end plus its falloff band, in any
        // direction (conservative; clipped to the layer below).
        return rampLength + op.radiusMeters + 2 * edgeBand;
      case 'pad':
        return Math.max(op.radiusMeters, (op.lengthMeters ?? 0) / 2 + op.radiusMeters) + edgeBand;
      default:
        return op.radiusMeters;
    }
  })();

  // World-space influence box: centre ± reach, except polygonal operations,
  // whose footprint is the polygon's bounding box plus the falloff band.
  let bboxMinX = op.centerXMeters - reach;
  let bboxMaxX = op.centerXMeters + reach;
  let bboxMinZ = op.centerZMeters - reach;
  let bboxMaxZ = op.centerZMeters + reach;
  if (polygon) {
    bboxMinX = Math.min(...polygon.map((v) => v[0])) - op.radiusMeters;
    bboxMaxX = Math.max(...polygon.map((v) => v[0])) + op.radiusMeters;
    bboxMinZ = Math.min(...polygon.map((v) => v[1])) - op.radiusMeters;
    bboxMaxZ = Math.max(...polygon.map((v) => v[1])) + op.radiusMeters;
  }

  // Mass-conserving redistribution ring: unchanged for the classic brush kinds
  // (annulus radius…1.6·radius around the centre); construction kinds whose
  // footprint exceeds the brush radius push the ring out past their reach, and
  // polygonal operations redistribute around the polygon's bounding circle.
  let ringCx = op.centerXMeters;
  let ringCz = op.centerZMeters;
  let ringInner = op.radiusMeters;
  switch (op.kind) {
    case 'ramp':
    case 'pad':
    case 'wheel_track':
    // trench and berm are exactly as elongated (reach = length/2 + radius)
    // and were the one pair left on ringInner = radius: a mass-conserving
    // 20 m trench redeposited half its excavated volume back INSIDE its own
    // footprint, raising the trench floor 3.3x the trench's depth.
    case 'trench':
    case 'berm':
      ringInner = reach;
      break;
    case 'polygonal_cut':
    case 'polygonal_fill': {
      ringCx = (bboxMinX + bboxMaxX) / 2;
      ringCz = (bboxMinZ + bboxMaxZ) / 2;
      let maxD = 0;
      for (const v of polygon!) {
        const d = Math.hypot(v[0] - ringCx, v[1] - ringCz);
        if (d > maxD) maxD = d;
      }
      ringInner = maxD + op.radiusMeters;
      break;
    }
  }

  const colMin = Math.max(0, Math.floor((bboxMinX - layer.bounds.minX) / res));
  const colMax = Math.min(
    layer.widthSamples - 1,
    Math.ceil((bboxMaxX - layer.bounds.minX) / res),
  );
  const rowMin = Math.max(0, Math.floor((bboxMinZ - layer.bounds.minZ) / res));
  const rowMax = Math.min(
    layer.heightSamples - 1,
    Math.ceil((bboxMaxZ - layer.bounds.minZ) / res),
  );

  let removed = 0;
  let deposited = 0;
  let touched = 0;

  // Pass 1: compute the intended delta for every sample in reach.
  const deltas = new Map<number, number>();

  /**
   * Samples inside the feature's own footprint, tracked from the GEOMETRY,
   * not from `dh !== 0`. The distinction matters: a pad over ground already
   * at target moves no earth, but it is still a pad — keying the semantic
   * mask and the feature record on nonzero deltas recorded "no feature" for
   * exactly the samples where grading was unnecessary, and marked the
   * polygonal falloff band (outside the polygon) as if it were the feature.
   */
  const shapeSet: Set<number> | null = CONSTRUCTION_SEMANTIC[op.kind] ? new Set() : null;

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
          // Distance to the segment centred on (cx, cz) at `headingDegrees`
          // (heading unit vector precomputed above from ADR 0002).
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
        case 'ramp': {
          // Linear grade from the existing elevation at the near end (the
          // centre) to targetElevationMeters at the far end, `lengthMeters`
          // along the heading, half-width `radiusMeters`, with a smooth edge
          // falloff band so the graded surface meets the surroundings without
          // a step. The near end ramps its weight in from zero so the
          // existing grade is genuinely kept there.
          const px = x - op.centerXMeters;
          const pz = z - op.centerZMeters;
          const along = px * ax + pz * az;
          if (along <= 0 || along >= rampLength + edgeBand) break;
          const perpX = px - along * ax;
          const perpZ = pz - along * az;
          const lat = Math.hypot(perpX, perpZ);
          const latW = plateauWeight(lat, op.radiusMeters, edgeBand, op.falloff);
          if (latW <= 0) break;
          if (along <= rampLength && lat <= op.radiusMeters + edgeBand) shapeSet?.add(i);
          const alongW =
            along < edgeBand
              ? falloffWeight(edgeBand - along, edgeBand, op.falloff)
              : plateauWeight(along, rampLength, edgeBand, op.falloff);
          const w = latW * alongW;
          if (w <= 0) break;
          const t = Math.min(1, along / rampLength);
          const target = rampNearElev + t * (op.targetElevationMeters! - rampNearElev);
          dh = (target - layer.heightData[i]) * w;
          break;
        }
        case 'pad': {
          // Flatten to targetElevationMeters over a circular pad of radius
          // `radiusMeters`, or a rectangular pad `lengthMeters` long (along
          // the heading) by 2·radiusMeters wide when a length is given, with
          // a smooth edge falloff band. Reported as cut AND fill: samples
          // above the target are removed, samples below are deposited.
          const px = x - op.centerXMeters;
          const pz = z - op.centerZMeters;
          let dOut: number;
          if ((op.lengthMeters ?? 0) > 0) {
            const along = px * ax + pz * az;
            const perpX = px - along * ax;
            const perpZ = pz - along * az;
            const lat = Math.hypot(perpX, perpZ);
            dOut = Math.hypot(
              Math.max(0, Math.abs(along) - op.lengthMeters! / 2),
              Math.max(0, lat - op.radiusMeters),
            );
          } else {
            dOut = Math.max(0, Math.hypot(px, pz) - op.radiusMeters);
          }
          const w = plateauWeight(dOut, 0, edgeBand, op.falloff);
          if (w > 0) {
            shapeSet?.add(i);
            dh = (op.targetElevationMeters! - layer.heightData[i]) * w;
          }
          break;
        }
        case 'spoil_pile': {
          // Conical pile, apex height `pileHeight` (repose-clamped above),
          // base radius `radiusMeters`. Pure deposit.
          const d = Math.hypot(x - op.centerXMeters, z - op.centerZMeters);
          if (d < op.radiusMeters && pileHeight > 0) {
            shapeSet?.add(i);
            dh = pileHeight * (1 - d / op.radiusMeters);
          }
          break;
        }
        case 'wheel_track': {
          // Two parallel ruts along the heading, centre-to-centre gauge
          // `radiusMeters`, each rut `0.3·radiusMeters` wide and
          // `strengthMeters` deep, flanked by raised berms of displaced
          // material carrying ~40% of the rut cross-section per side.
          const px = x - op.centerXMeters;
          const pz = z - op.centerZMeters;
          const along = px * ax + pz * az;
          if (Math.abs(along) > trackHalfLen) break;
          // Signed lateral offset: perpendicular unit vector is (-az, ax).
          const lat = px * -az + pz * ax;
          const rutHalfWidth = 0.15 * op.radiusMeters;
          const bermWidth = rutHalfWidth;
          const depth = Math.abs(op.strengthMeters);
          const p = Math.max(0.01, op.falloff);
          // Rut cross-section area per metre of track for the (1 - d/w)^p
          // profile; berm height chosen so each side carries 40% of it
          // (triangular berm profile integrates to bermWidth / 2).
          const rutArea = (depth * 2 * rutHalfWidth) / (p + 1);
          const bermHeight = (0.4 * rutArea) / (bermWidth * 0.5);
          for (const offset of [-op.radiusMeters / 2, op.radiusMeters / 2]) {
            const dLat = Math.abs(lat - offset);
            if (dLat < rutHalfWidth) {
              shapeSet?.add(i);
              dh -= depth * falloffWeight(dLat, rutHalfWidth, op.falloff);
            } else if (dLat < rutHalfWidth + bermWidth) {
              shapeSet?.add(i);
              const u = (dLat - rutHalfWidth) / bermWidth;
              dh += bermHeight * (1 - Math.abs(2 * u - 1));
            }
          }
          break;
        }
        case 'polygonal_cut':
        case 'polygonal_fill': {
          // Cut down (or fill up) to targetElevationMeters inside the
          // polygon, with a falloff band of `radiusMeters` outside the
          // boundary so the walls meet the surroundings smoothly. A cut never
          // deposits and a fill never removes: samples already past the
          // target are left alone.
          let w: number;
          if (pointInPolygon(x, z, polygon!)) {
            // Only the polygon interior IS the feature; the falloff band is
            // the wall meeting the surroundings, not more trench/berm.
            shapeSet?.add(i);
            w = 1;
          } else {
            w = falloffWeight(distanceToPolygonBoundary(x, z, polygon!), op.radiusMeters, op.falloff);
          }
          if (w <= 0) break;
          const raw = op.targetElevationMeters! - layer.heightData[i];
          if (op.kind === 'polygonal_cut' ? raw < 0 : raw > 0) dh = raw * w;
          break;
        }
      }

      if (dh !== 0) deltas.set(i, dh);
    }
  }

  const semClass = CONSTRUCTION_SEMANTIC[op.kind];

  // Pass 2: mass conservation. Redistribute the net volume over the annulus
  // between the footprint radius and 1.6× it so cut-and-fill balances. The
  // annulus is centred on the brush centre (polygonal operations: on the
  // polygon's bounding circle) with its inner edge at the operation's reach,
  // so redistribution never lands inside the feature it is balancing.
  if (op.massConserving) {
    let net = 0;
    for (const dh of deltas.values()) net += dh * cellArea;

    if (Math.abs(net) > 0) {
      const inner = ringInner;
      const outer = ringInner * 1.6;
      const ring: number[] = [];
      let ringWeight = 0;
      const rColMin = Math.max(0, Math.floor((ringCx - outer - layer.bounds.minX) / res));
      const rColMax = Math.min(
        layer.widthSamples - 1,
        Math.ceil((ringCx + outer - layer.bounds.minX) / res),
      );
      const rRowMin = Math.max(0, Math.floor((ringCz - outer - layer.bounds.minZ) / res));
      const rRowMax = Math.min(
        layer.heightSamples - 1,
        Math.ceil((ringCz + outer - layer.bounds.minZ) / res),
      );
      const weights = new Map<number, number>();
      for (let row = rRowMin; row <= rRowMax; row++) {
        const z = layer.bounds.minZ + row * res;
        for (let col = rColMin; col <= rColMax; col++) {
          const x = layer.bounds.minX + col * res;
          const d = Math.hypot(x - ringCx, z - ringCz);
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

  // Pass 3: commit, with before/after elevation statistics over the touched
  // samples (the "before" value is recovered as committed - delta, so no
  // second scan of the heightfield is needed).
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let beforeMin = Infinity;
  let beforeMax = -Infinity;
  let beforeSum = 0;
  let afterMin = Infinity;
  let afterMax = -Infinity;
  let afterSum = 0;
  for (const [i, dh] of deltas) {
    const before = layer.heightData[i];
    layer.heightData[i] += dh;
    const after = layer.heightData[i];
    touched++;
    if (dh < 0) removed += -dh * cellArea;
    else deposited += dh * cellArea;
    if (before < beforeMin) beforeMin = before;
    if (before > beforeMax) beforeMax = before;
    beforeSum += before;
    if (after < afterMin) afterMin = after;
    if (after > afterMax) afterMax = after;
    afterSum += after;
    const col = i % layer.widthSamples;
    const row = (i - col) / layer.widthSamples;
    const x = layer.bounds.minX + col * res;
    const z = layer.bounds.minZ + row * res;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // Mark the semantic mask over the feature's own samples (spec §11, §22) —
  // the geometric footprint, including samples where no earth moved.
  if (semClass && shapeSet && layer.masks.semantic) {
    const classIdx = semanticIndex(semClass);
    for (const i of shapeSet) layer.masks.semantic[i] = classIdx;
  }

  // Feature-scoped bounds and elevation statistics, over the footprint only.
  // The delta-based `bounds` above deliberately still includes the borrow
  // ring — tile invalidation must cover everything that changed — but the
  // FEATURE record must not claim the ring: a spoil pile's record previously
  // reported terrain below original grade (the ring borrow pits) as part of
  // the pile.
  let featureBounds: ApplyResult['bounds'] | undefined;
  let featureBefore: ElevationStats | undefined;
  let featureAfter: ElevationStats | undefined;
  if (shapeSet && shapeSet.size > 0) {
    let fMinX = Infinity;
    let fMaxX = -Infinity;
    let fMinZ = Infinity;
    let fMaxZ = -Infinity;
    let bMin = Infinity;
    let bMax = -Infinity;
    let bSum = 0;
    let aMin = Infinity;
    let aMax = -Infinity;
    let aSum = 0;
    for (const i of shapeSet) {
      const after = layer.heightData[i];
      const before = after - (deltas.get(i) ?? 0);
      if (before < bMin) bMin = before;
      if (before > bMax) bMax = before;
      bSum += before;
      if (after < aMin) aMin = after;
      if (after > aMax) aMax = after;
      aSum += after;
      const col = i % layer.widthSamples;
      const row = (i - col) / layer.widthSamples;
      const x = layer.bounds.minX + col * res;
      const z = layer.bounds.minZ + row * res;
      if (x < fMinX) fMinX = x;
      if (x > fMaxX) fMaxX = x;
      if (z < fMinZ) fMinZ = z;
      if (z > fMaxZ) fMaxZ = z;
    }
    featureBounds = { minX: fMinX, minZ: fMinZ, maxX: fMaxX, maxZ: fMaxZ };
    featureBefore = { min: bMin, max: bMax, mean: bSum / shapeSet.size };
    featureAfter = { min: aMin, max: aMax, mean: aSum / shapeSet.size };
  }

  return {
    removedVolumeM3: removed,
    depositedVolumeM3: deposited,
    samplesTouched: touched,
    bounds: {
      minX: touched ? minX : ringCx,
      maxX: touched ? maxX : ringCx,
      minZ: touched ? minZ : ringCz,
      maxZ: touched ? maxZ : ringCz,
    },
    elevationBefore: {
      min: touched ? beforeMin : 0,
      max: touched ? beforeMax : 0,
      mean: touched ? beforeSum / touched : 0,
    },
    elevationAfter: {
      min: touched ? afterMin : 0,
      max: touched ? afterMax : 0,
      mean: touched ? afterSum / touched : 0,
    },
    ...(featureBounds ? { featureBounds } : {}),
    ...(featureBefore ? { featureElevationBefore: featureBefore } : {}),
    ...(featureAfter ? { featureElevationAfter: featureAfter } : {}),
    ...(aliasingWarning ? { aliasingWarning } : {}),
    ...(reposeClamp ? { reposeClamp } : {}),
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
