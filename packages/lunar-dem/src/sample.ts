/**
 * Resampling a real DEM into a local terrain frame.
 *
 * ## Curvature bookkeeping
 *
 * DEM elevations are **radial** — heights above a 1737.4 km sphere. A local
 * terrain frame is a **tangent plane**, and Godot's physics is Euclidean. Those
 * differ by the curvature drop `d²/2R`, which is 0.29 m at 1 km and 28.8 m at
 * 10 km — small at rover scale, decisive for a horizon.
 *
 * This module removes the curvature during ingestion, so a stored layer is a
 * true tangent plane and a flat mesh in it really is flat. The consequence is
 * that **horizon ray-marching over an ingested layer must not re-apply
 * curvature** — it is already baked in. That is why `horizonProfile` defaults
 * to `bodyRadiusM: Infinity`: the double count cannot happen by omission.
 * (No per-layer flag records the removal; every layer this pipeline produces
 * is a tangent plane, and the export manifest's `datum_note` says so.)
 */

import {
  TerrainError,
  ERROR_CODES,
  type ProjectionMetadata,
} from '@lts/shared-types';
import {
  forward,
  scaleFactorAtLatitude,
  SOUTH_POLAR_LOLA,
  type PolarStereographicParams,
} from './projection.js';
import type { DemRaster } from './source.js';

export interface LocalFrame {
  /** Site selenographic latitude, degrees. */
  latitudeDeg: number;
  /** Site selenographic longitude, degrees. */
  longitudeDeg: number;
  /** Projected coordinates of the local origin, metres. */
  originProjectedX: number;
  originProjectedY: number;
  /** Unit vector, in projected space, of local +X (east). */
  eastX: number;
  eastY: number;
  /** Unit vector, in projected space, of local +Z (south). */
  southX: number;
  southY: number;
  /** True metres → projected metres at this latitude. */
  projectionScale: number;
}

/**
 * Build the local tangent frame at a selenographic site.
 *
 * For the south polar aspect a point projects to `ρ(sin Δλ, cos Δλ)`, so:
 *   - local **north** (increasing latitude, i.e. increasing ρ) is
 *     `(sin Δλ, cos Δλ)` — radially *outward* from the pole;
 *   - local **east** (increasing longitude) is `(cos Δλ, −sin Δλ)`;
 *   - local **+Z is south** (ADR 0002), so it is `−north`.
 */
export function buildLocalFrame(
  latitudeDeg: number,
  longitudeDeg: number,
  projection: PolarStereographicParams = SOUTH_POLAR_LOLA,
): LocalFrame {
  const { x, y } = forward(latitudeDeg, longitudeDeg, projection);
  const longitudeFromMeridianDeg =
    projection.centralMeridianDeg === 0
      ? longitudeDeg
      : longitudeDeg - projection.centralMeridianDeg;
  const lam = (longitudeFromMeridianDeg * Math.PI) / 180;
  const sinL = Math.sin(lam);
  const cosL = Math.cos(lam);

  const eastX = cosL;
  const eastY = projection.hemisphere === -1 ? -sinL : sinL;
  const southX = projection.hemisphere === -1 ? -sinL : sinL;
  const southY = -cosL;

  return {
    latitudeDeg,
    longitudeDeg,
    originProjectedX: x,
    originProjectedY: y,
    eastX,
    eastY,
    // South-polar aspect: south = -north = -(sin Δλ, cos Δλ).
    southX,
    southY,
    projectionScale: scaleFactorAtLatitude(latitudeDeg, projection),
  };
}

/** Projection declaration paired with the exact projected local-frame origin. */
export function projectionMetadataForFrame(
  projection: PolarStereographicParams,
  frame: LocalFrame,
): ProjectionMetadata {
  return {
    type: 'polar_stereographic',
    latitudeOfOriginDeg: projection.hemisphere === -1 ? -90 : 90,
    centralMeridianDeg: projection.centralMeridianDeg,
    scaleFactor: projection.scaleFactor,
    falseEastingM: projection.falseEastingM,
    falseNorthingM: projection.falseNorthingM,
    bodyRadiusM: projection.radiusM,
    originEastingM: frame.originProjectedX,
    originNorthingM: frame.originProjectedY,
  };
}

/** Local (x east, z south) in true metres → projected coordinates in metres. */
export function localToProjected(
  frame: LocalFrame,
  localX: number,
  localZ: number,
): { x: number; y: number } {
  const k = frame.projectionScale;
  return {
    x: frame.originProjectedX + (localX * frame.eastX + localZ * frame.southX) * k,
    y: frame.originProjectedY + (localX * frame.eastY + localZ * frame.southY) * k,
  };
}

/** Projected coordinates → local (x east, z south) in true metres. */
export function projectedToLocal(
  frame: LocalFrame,
  x: number,
  y: number,
): { localX: number; localZ: number } {
  const dx = (x - frame.originProjectedX) / frame.projectionScale;
  const dy = (y - frame.originProjectedY) / frame.projectionScale;
  // east and south are orthonormal, so the inverse is the transpose.
  return {
    localX: dx * frame.eastX + dy * frame.eastY,
    localZ: dx * frame.southX + dy * frame.southY,
  };
}

/** Bilinear read from a window buffer; NaN outside or on no-data. */
function bilinear(
  data: Float32Array,
  width: number,
  height: number,
  col: number,
  row: number,
): number {
  if (col < 0 || row < 0 || col > width - 1 || row > height - 1) return NaN;
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(c0 + 1, width - 1);
  const r1 = Math.min(r0 + 1, height - 1);
  const fc = col - c0;
  const fr = row - r0;
  const h00 = data[r0 * width + c0];
  const h10 = data[r0 * width + c1];
  const h01 = data[r1 * width + c0];
  const h11 = data[r1 * width + c1];
  if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) return NaN;
  return h00 * (1 - fc) * (1 - fr) + h10 * fc * (1 - fr) + h01 * (1 - fc) * fr + h11 * fc * fr;
}

export interface ResampleRequest {
  /** Local-frame bounds, metres. */
  minX: number;
  minZ: number;
  /** Ground sample distance in the local frame, metres. */
  resolutionMeters: number;
  widthSamples: number;
  heightSamples: number;
}

export interface ResampleResult {
  /** Tangent-plane elevations, metres, relative to the site datum. */
  data: Float32Array;
  /** Mean elevation of the source window, metres above the reference sphere. */
  datumElevationM: number;
  /** Fraction of samples that fell on no-data. */
  noDataFraction: number;
  /** Source pixels per output sample; below 1 means the output oversamples. */
  sourcePixelsPerSample: number;
}

/**
 * Resample a real DEM into a local layer grid.
 *
 * Elevations are returned relative to the mean elevation of the sampled window
 * (`datumElevationM` carries the offset back to absolute), and with the
 * curvature drop removed so the result is a tangent plane.
 *
 * When the request is finer than the source, this **interpolates** — it does
 * not invent detail. `sourcePixelsPerSample` reports the ratio so the caller
 * can see how much of the output is genuinely resolved, and the generator uses
 * it to decide where synthetic sub-resolution detail is allowed.
 */
export function resampleDemToLocal(
  raster: DemRaster,
  frame: LocalFrame,
  req: ResampleRequest,
  bodyRadiusM = 1_737_400,
): ResampleResult {
  // Projected bounding box of the requested local patch, plus a margin for the
  // bilinear stencil and any rotation of the local frame.
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;
  const maxX = req.minX + (req.widthSamples - 1) * req.resolutionMeters;
  const maxZ = req.minZ + (req.heightSamples - 1) * req.resolutionMeters;
  for (const [lx, lz] of [
    [req.minX, req.minZ],
    [maxX, req.minZ],
    [req.minX, maxZ],
    [maxX, maxZ],
  ]) {
    const p = localToProjected(frame, lx, lz);
    minPx = Math.min(minPx, p.x);
    maxPx = Math.max(maxPx, p.x);
    minPy = Math.min(minPy, p.y);
    maxPy = Math.max(maxPy, p.y);
  }

  const a = raster.projectedToPixel(minPx, minPy);
  const b = raster.projectedToPixel(maxPx, maxPy);
  const margin = 4;
  const col0 = Math.floor(Math.min(a.col, b.col)) - margin;
  const row0 = Math.floor(Math.min(a.row, b.row)) - margin;
  const col1 = Math.ceil(Math.max(a.col, b.col)) + margin;
  const row1 = Math.ceil(Math.max(a.row, b.row)) + margin;

  if (col1 < 0 || row1 < 0 || col0 >= raster.widthPixels || row0 >= raster.heightPixels) {
    throw new TerrainError(
      ERROR_CODES.DEM_COVERAGE,
      `The site does not fall within ${raster.provenance.id}.`,
      {
        site: { latitudeDeg: frame.latitudeDeg, longitudeDeg: frame.longitudeDeg },
        requestedPixelBox: { col0, row0, col1, row1 },
        rasterSize: { width: raster.widthPixels, height: raster.heightPixels },
        dem: raster.provenance.path,
      },
    );
  }

  const win = raster.readWindow(col0, row0, col1 - col0 + 1, row1 - row0 + 1);

  const out = new Float32Array(req.widthSamples * req.heightSamples);
  let sum = 0;
  let counted = 0;
  let noData = 0;

  // First pass: radial elevations.
  for (let r = 0; r < req.heightSamples; r++) {
    const lz = req.minZ + r * req.resolutionMeters;
    for (let c = 0; c < req.widthSamples; c++) {
      const lx = req.minX + c * req.resolutionMeters;
      const p = localToProjected(frame, lx, lz);
      const px = raster.projectedToPixel(p.x, p.y);
      const h = bilinear(win.data, win.width, win.height, px.col - win.col0, px.row - win.row0);
      out[r * req.widthSamples + c] = h;
      if (Number.isNaN(h)) {
        noData++;
      } else {
        sum += h;
        counted++;
      }
    }
  }

  if (counted === 0) {
    throw new TerrainError(
      ERROR_CODES.DEM_COVERAGE,
      `Every sample of the requested patch fell on no-data in ${raster.provenance.id}.`,
      { dem: raster.provenance.path, site: { latitudeDeg: frame.latitudeDeg, longitudeDeg: frame.longitudeDeg } },
    );
  }

  const datum = sum / counted;

  // Second pass: rebase to the datum and flatten the sphere to a tangent plane.
  for (let r = 0; r < req.heightSamples; r++) {
    const lz = req.minZ + r * req.resolutionMeters;
    for (let c = 0; c < req.widthSamples; c++) {
      const i = r * req.widthSamples + c;
      const h = out[i];
      if (Number.isNaN(h)) continue;
      const lx = req.minX + c * req.resolutionMeters;
      const d2 = lx * lx + lz * lz;
      out[i] = h - datum - d2 / (2 * bodyRadiusM);
    }
  }

  return {
    data: out,
    datumElevationM: datum,
    noDataFraction: noData / out.length,
    // Both sides in TRUE ground metres: the raster's MAP_SCALE is projected
    // metres, and one true metre maps to `projectionScale` projected metres,
    // so a source pixel covers MAP_SCALE / k true metres on the ground.
    sourcePixelsPerSample:
      req.resolutionMeters / (raster.resolutionMeters / frame.projectionScale),
  };
}

/** Fill NaN holes by nearest-valid-neighbour search, reporting how many were filled. */
export function fillNoData(
  data: Float32Array,
  width: number,
  height: number,
): { filled: number } {
  let filled = 0;
  const isNan = (i: number) => Number.isNaN(data[i]);
  // Iterative dilation from valid neighbours; converges in a few passes for the
  // small holes these products contain.
  for (let pass = 0; pass < 64; pass++) {
    let changed = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const i = r * width + c;
        if (!isNan(i)) continue;
        let sum = 0;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
            const j = rr * width + cc;
            if (!isNan(j)) {
              sum += data[j];
              n++;
            }
          }
        }
        if (n > 0) {
          data[i] = sum / n;
          changed++;
          filled++;
        }
      }
    }
    if (changed === 0) break;
  }
  return { filled };
}
