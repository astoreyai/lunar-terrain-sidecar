/**
 * Far-field horizon ring from a wide-coverage polar DEM (spec follow-up to the
 * "Horizon and shadow fidelity are bounded by the widest configured layer"
 * limitation; reference method: Mazarico, Neumann, Smith, Zuber & Torrence
 * 2011, *Icarus* 211 — illumination at the lunar poles from LOLA topography,
 * which computes horizons from polar gridded products out to ranges where
 * distant massifs still matter).
 *
 * At grazing polar sun the skyline is set by relief tens of kilometres away:
 * a 260 m massif at 10 km subtends the same 1.5° as a 13 m ridge at 500 m. A
 * site's configured layers end after a few hundred metres, so this module
 * ray-marches the real LOLA LDEM_75S product (120 m/px, 75°S–90°S) along
 * great circles from the observer and returns the skyline elevation those
 * layers cannot see.
 *
 * ## Geometry — exact spherical, no tangent-plane approximation
 *
 * The DEM carries **radial** elevations (metres above the 1737.4 km sphere).
 * For an observer at radius `r₀ = R + h₀` and a terrain sample at radius
 * `rₚ = R + hₚ` separated by arc angle `γ = s / R`, the elevation of the
 * sample above the observer's local horizontal is exactly
 *
 *     el = atan2(rₚ·cos γ − r₀,  rₚ·sin γ)
 *
 * which contains the full curvature drop (its small-γ expansion is the
 * familiar `(hₚ − h₀ − s²/2R) / s`). Rays are propagated along true great
 * circles with the standard destination formula, so azimuth here means the
 * same thing it means in `solarPositionAtSite`: the initial bearing,
 * clockwise from north.
 *
 * The result merges with the near-field profile by per-bin `max()`: the fine
 * layers resolve nearby rims the 120 m grid smooths away, and the far field
 * contributes only terrain the layers do not contain. Distant relief can
 * raise a horizon, never lower it, so the merge is conservative in exactly
 * the direction the disclosed limitation errs.
 */

import { forward } from './projection.js';
import type { DemRaster } from './source.js';

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export interface FarHorizonObserver {
  latitudeDeg: number;
  longitudeDeg: number;
  /** Radial elevation, metres above the reference sphere. */
  radialElevationM: number;
}

export interface FarHorizonOptions {
  /** Azimuth bins over 360°. Default 360. */
  azimuthBins?: number;
  /**
   * Range at which marching starts, metres. Default 2 source pixels. Keep it
   * inside the configured layers' extent so the near/far merge has overlap
   * rather than a gap; the per-bin max() makes the overlap harmless.
   */
  startRangeM?: number;
  /** Range at which marching stops, metres. Default 100 km (Mazarico-scale). */
  maxRangeM?: number;
  /** Step growth factor toward max range (same scheme as horizonProfile). */
  stepGrowth?: number;
}

export interface FarHorizonResult {
  /** Skyline elevation per azimuth bin, degrees, −90 where nothing was seen. */
  horizonElevationDeg: Float32Array;
  observer: FarHorizonObserver;
  startRangeM: number;
  maxRangeM: number;
  /**
   * Smallest range, metres, at which any ray left the product's coverage
   * (Infinity when every ray ran to maxRangeM inside coverage). A finite
   * value means bins are truncated and the ring understates the horizon.
   */
  truncatedAtM: number;
  /** Terrain samples evaluated / samples that fell on no-data. */
  samplesEvaluated: number;
  noDataSamples: number;
  source: {
    id: string;
    path: string;
    /** Projected metres per pixel. */
    mapScaleM: number;
  };
}

/** Great-circle destination from (lat, lon) with initial bearing and arc angle. */
function destination(
  latRad: number,
  lonRad: number,
  bearingRad: number,
  arcRad: number,
): { latRad: number; lonRad: number } {
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinArc = Math.sin(arcRad);
  const cosArc = Math.cos(arcRad);
  const lat2 = Math.asin(sinLat * cosArc + cosLat * sinArc * Math.cos(bearingRad));
  const lon2 =
    lonRad +
    Math.atan2(Math.sin(bearingRad) * sinArc * cosLat, cosArc - sinLat * Math.sin(lat2));
  return { latRad: lat2, lonRad: lon2 };
}

/** Bilinear read from a window; NaN outside it or on no-data. */
function bilinearWindow(
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
  if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) {
    return NaN;
  }
  return h00 * (1 - fc) * (1 - fr) + h10 * fc * (1 - fr) + h01 * (1 - fc) * fr + h11 * fc * fr;
}

/**
 * Compute the far-field horizon ring around an observer from a wide DEM.
 *
 * Deterministic: a pure function of the raster bytes, the observer, and the
 * options. Throws if the observer itself lies outside the raster; rays that
 * *leave* coverage mid-march are truncated and reported, not errors.
 */
export function farFieldHorizon(
  raster: DemRaster,
  observer: FarHorizonObserver,
  options: FarHorizonOptions = {},
): FarHorizonResult {
  const bins = options.azimuthBins ?? 360;
  const R = raster.projection.radiusM;
  const mapScale = raster.resolutionMeters;
  // One projected metre is 1/k true metres; near the pole k ≈ 1 so a source
  // pixel is ~mapScale true metres on the ground.
  const startRange = options.startRangeM ?? 2 * mapScale;
  const maxRange = options.maxRangeM ?? 100_000;
  const growth = options.stepGrowth ?? 8;
  if (!(maxRange > startRange)) {
    throw new Error(`maxRangeM (${maxRange}) must exceed startRangeM (${startRange})`);
  }

  // Pre-read one window covering the reachable disc. Stereographic ρ grows
  // away from the pole, so pad by the worst-case scale factor over the disc.
  const centre = forward(observer.latitudeDeg, observer.longitudeDeg, raster.projection);
  const padProjected = maxRange * 1.05 + 4 * mapScale;
  const pMin = raster.projectedToPixel(centre.x - padProjected, centre.y + padProjected);
  const pMax = raster.projectedToPixel(centre.x + padProjected, centre.y - padProjected);
  const col0 = Math.floor(Math.min(pMin.col, pMax.col));
  const row0 = Math.floor(Math.min(pMin.row, pMax.row));
  const cols = Math.ceil(Math.abs(pMax.col - pMin.col)) + 1;
  const rows = Math.ceil(Math.abs(pMax.row - pMin.row)) + 1;
  const win = raster.readWindow(col0, row0, cols, rows);

  const obsPx = raster.projectedToPixel(centre.x, centre.y);
  if (
    obsPx.col < win.col0 ||
    obsPx.row < win.row0 ||
    obsPx.col > win.col0 + win.width - 1 ||
    obsPx.row > win.row0 + win.height - 1
  ) {
    throw new Error(
      `observer (${observer.latitudeDeg}, ${observer.longitudeDeg}) lies outside ` +
        `${raster.provenance.id}`,
    );
  }

  const lat0 = toRad(observer.latitudeDeg);
  const lon0 = toRad(observer.longitudeDeg);
  const r0 = R + observer.radialElevationM;

  const out = new Float32Array(bins);
  let truncatedAtM = Infinity;
  let samplesEvaluated = 0;
  let noDataSamples = 0;

  for (let b = 0; b < bins; b++) {
    const bearing = toRad((b * 360) / bins);
    let maxAngle = -Infinity;
    let s = startRange;
    while (s <= maxRange) {
      const gamma = s / R;
      const d = destination(lat0, lon0, bearing, gamma);
      const p = forward(toDeg(d.latRad), toDeg(d.lonRad), raster.projection);
      const px = raster.projectedToPixel(p.x, p.y);
      const h = bilinearWindow(
        win.data,
        win.width,
        win.height,
        px.col - win.col0,
        px.row - win.row0,
      );
      samplesEvaluated++;
      if (
        px.col < 0 ||
        px.row < 0 ||
        px.col > raster.widthPixels - 1 ||
        px.row > raster.heightPixels - 1
      ) {
        // Left the product itself (not just our window): truncated coverage.
        if (s < truncatedAtM) truncatedAtM = s;
        break;
      }
      if (Number.isNaN(h)) {
        noDataSamples++;
      } else {
        const rp = R + h;
        const angle = Math.atan2(rp * Math.cos(gamma) - r0, rp * Math.sin(gamma));
        if (angle > maxAngle) maxAngle = angle;
      }
      const t = s / maxRange;
      s += mapScale * (1 + t * growth);
    }
    out[b] = maxAngle === -Infinity ? -90 : toDeg(maxAngle);
  }

  return {
    horizonElevationDeg: out,
    observer,
    startRangeM: startRange,
    maxRangeM: maxRange,
    truncatedAtM,
    samplesEvaluated,
    noDataSamples,
    source: {
      id: raster.provenance.id,
      path: raster.provenance.path,
      mapScaleM: mapScale,
    },
  };
}
