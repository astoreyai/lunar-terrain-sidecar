/**
 * Terrain horizon and shadowing (spec §13, §22).
 *
 * At a lunar pole the Sun stays within ~1.54° of the horizon, so illumination
 * is controlled by *topography*, not by time of day: a 30 m crater rim 1 km away
 * subtends 1.7° and can shadow a site permanently. Deciding whether a point is
 * lit therefore requires the real skyline, which is what this module computes.
 *
 * Lunar curvature is included. Over a 10 km sight-line the reference sphere
 * drops 28.8 m — comparable to the relief that does the shadowing — so ignoring
 * it would put false rims on every distant horizon.
 */

import { toDeg, toRad } from './angles.js';
import { LUNAR_REFERENCE_RADIUS_M } from './constants.js';

/**
 * Read-only access to a heightfield for horizon ray-marching.
 *
 * Grid convention, matching the rest of the system: `col` increases toward +X
 * (east), `row` increases toward +Z (**south**, see ADR 0002), heights are
 * metres. Row 0 is therefore the northernmost row.
 */
export interface HeightSampler {
  readonly widthSamples: number;
  readonly heightSamples: number;
  /** Ground sample distance, metres. */
  readonly cellSizeM: number;
  /** Elevation at integer grid indices, metres. Out-of-range must return NaN. */
  heightAt(col: number, row: number): number;
}

/** Build a sampler over a plain Float32Array in row-major order. */
export function samplerFromArray(
  data: Float32Array,
  widthSamples: number,
  heightSamples: number,
  cellSizeM: number,
): HeightSampler {
  return {
    widthSamples,
    heightSamples,
    cellSizeM,
    heightAt(col: number, row: number): number {
      if (col < 0 || row < 0 || col >= widthSamples || row >= heightSamples) return NaN;
      return data[row * widthSamples + col];
    },
  };
}

/** Bilinear sample at fractional grid coordinates; NaN outside the grid. */
export function sampleBilinear(s: HeightSampler, col: number, row: number): number {
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = c0 + 1;
  const r1 = r0 + 1;
  const h00 = s.heightAt(c0, r0);
  const h10 = s.heightAt(Math.min(c1, s.widthSamples - 1), r0);
  const h01 = s.heightAt(c0, Math.min(r1, s.heightSamples - 1));
  const h11 = s.heightAt(Math.min(c1, s.widthSamples - 1), Math.min(r1, s.heightSamples - 1));
  if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) return NaN;
  const fc = col - c0;
  const fr = row - r0;
  return (
    h00 * (1 - fc) * (1 - fr) + h10 * fc * (1 - fr) + h01 * (1 - fc) * fr + h11 * fc * fr
  );
}

export interface HorizonOptions {
  /** Number of azimuth bins over the full 360°. Default 360 (1° bins). */
  azimuthBins?: number;
  /** Maximum sight-line range, metres. Default: the grid diagonal. */
  maxRangeM?: number;
  /**
   * Ray step as a fraction of a cell near the observer. Default 1.0. Steps grow
   * with distance so a long ray does not cost O(range/cell) samples at full
   * resolution; growth is `1 + distance / rangeM * growth`.
   */
  stepCells?: number;
  /** Step growth factor at maximum range. Default 8. */
  stepGrowth?: number;
  /** Observer height above the surface, metres. Default 0. */
  observerHeightM?: number;
  /**
   * Body radius used for the curvature drop `d²/2R`, metres.
   *
   * **Defaults to `Infinity` (no curvature applied).** Terrain layers produced
   * by `@lts/lunar-dem` are tangent planes with the curvature already removed
   * during ingestion, so applying it again here would double-count and invent
   * a false rim on every distant horizon. Pass
   * {@link LUNAR_REFERENCE_RADIUS_M} only when ray-marching *raw radial*
   * elevations that still sit on the sphere.
   */
  bodyRadiusM?: number;
}

/**
 * Elevation angle of the skyline in each azimuth bin, **degrees**.
 *
 * Bin `i` is centred on azimuth `i * 360 / bins`, measured clockwise from +Z
 * (north) toward +X (east) — the same convention as
 * {@link solarPositionAtSite}'s azimuth. Values may be negative where the
 * terrain falls away.
 */
export function horizonProfile(
  sampler: HeightSampler,
  observerCol: number,
  observerRow: number,
  options: HorizonOptions = {},
): Float32Array {
  const bins = options.azimuthBins ?? 360;
  const cell = sampler.cellSizeM;
  const diagonal =
    Math.hypot(sampler.widthSamples, sampler.heightSamples) * cell;
  const maxRange = options.maxRangeM ?? diagonal;
  const stepCells = options.stepCells ?? 1.0;
  const growth = options.stepGrowth ?? 8;
  const R = options.bodyRadiusM ?? Infinity;

  const h0 =
    sampleBilinear(sampler, observerCol, observerRow) + (options.observerHeightM ?? 0);
  if (Number.isNaN(h0)) {
    throw new Error(
      `observer (${observerCol}, ${observerRow}) is outside the heightfield`,
    );
  }

  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const azRad = toRad((b * 360) / bins);
    // Azimuth is clockwise from north, and north is −Z (ADR 0002), so the
    // ground direction is (x, z) = (sin A, −cos A). Since `row` increases with
    // +Z, that is dRow = −cos A. Getting this sign wrong mirrors every shadow
    // north-for-south, which at a polar site is the difference between a lit
    // slope and a permanently shadowed one.
    const dCol = Math.sin(azRad);
    const dRow = -Math.cos(azRad);

    let maxAngle = -Infinity;
    let distance = cell * stepCells;
    while (distance <= maxRange) {
      const col = observerCol + (dCol * distance) / cell;
      const row = observerRow + (dRow * distance) / cell;
      const h = sampleBilinear(sampler, col, row);
      if (Number.isNaN(h)) break; // Ray left the grid.

      // Curvature drop of the reference sphere over this ground distance.
      const drop = (distance * distance) / (2 * R);
      const angle = Math.atan2(h - h0 - drop, distance);
      if (angle > maxAngle) maxAngle = angle;

      const t = distance / maxRange;
      distance += cell * stepCells * (1 + t * growth);
    }
    out[b] = maxAngle === -Infinity ? -90 : toDeg(maxAngle);
  }
  return out;
}

/** Horizon elevation at an arbitrary azimuth, linearly interpolated between bins. */
export function horizonAtAzimuth(profile: Float32Array, azimuthDeg: number): number {
  const bins = profile.length;
  const x = ((azimuthDeg % 360) + 360) % 360 * (bins / 360);
  const i0 = Math.floor(x) % bins;
  const i1 = (i0 + 1) % bins;
  const f = x - Math.floor(x);
  return profile[i0] * (1 - f) + profile[i1] * f;
}

/**
 * Is the solar disc centre above the local skyline?
 *
 * Use {@link sunlitFraction} instead when the penumbra matters — at grazing
 * elevations the 0.266°-radius disc straddles a rim for a meaningful span.
 */
export function isSunlit(
  profile: Float32Array,
  solarAzimuthDeg: number,
  solarElevationDeg: number,
): boolean {
  return solarElevationDeg > horizonAtAzimuth(profile, solarAzimuthDeg);
}

/**
 * Fraction of the solar disc clearing the skyline, 0…1.
 *
 * SYNTHETIC HEURISTIC (spec §22): the horizon is treated as a straight chord
 * across a uniformly bright disc. Real penumbral illumination depends on the
 * rim's shape and on limb darkening.
 */
export function sunlitFraction(
  profile: Float32Array,
  solarAzimuthDeg: number,
  solarElevationDeg: number,
  solarAngularRadiusDeg: number,
): number {
  const h = solarElevationDeg - horizonAtAzimuth(profile, solarAzimuthDeg);
  const r = solarAngularRadiusDeg;
  if (r <= 0) return h > 0 ? 1 : 0;
  if (h >= r) return 1;
  if (h <= -r) return 0;
  const x = h / r;
  return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI;
}

export interface IlluminationSample {
  /** Solar azimuth, degrees. */
  azimuthDeg: number;
  /** Solar elevation, degrees. */
  elevationDeg: number;
  /** Solar angular radius, degrees. */
  angularRadiusDeg: number;
}

export interface IlluminationStatistics {
  /** Mean illuminated fraction over the sampled epochs, 0…1. */
  averageIllumination: number;
  /** Fraction of sampled epochs with any direct sunlight. */
  litFraction: number;
  /** True when no sampled epoch delivered any direct sunlight. */
  permanentlyShadowed: boolean;
  /** Longest run of consecutive unlit samples. */
  longestShadowRun: number;
  /** Number of epochs sampled. */
  samples: number;
}

/**
 * Illumination statistics for one skyline against a series of solar positions.
 *
 * `permanentlyShadowed` is only as good as the sampling: a true PSR
 * determination needs at least a full 18.6-year lunar precession cycle, because
 * the sub-solar latitude envelope itself migrates. Sampling a single year and
 * calling the result a PSR would overstate the finding, so callers should pass
 * a multi-year series and report the span they used.
 */
export function illuminationStatistics(
  profile: Float32Array,
  samples: IlluminationSample[],
): IlluminationStatistics {
  if (samples.length === 0) throw new Error('illuminationStatistics needs at least one sample');
  let sum = 0;
  let lit = 0;
  let run = 0;
  let longestRun = 0;
  for (const s of samples) {
    const f = sunlitFraction(profile, s.azimuthDeg, s.elevationDeg, s.angularRadiusDeg);
    sum += f;
    if (f > 0) {
      lit++;
      run = 0;
    } else {
      run++;
      if (run > longestRun) longestRun = run;
    }
  }
  return {
    averageIllumination: sum / samples.length,
    litFraction: lit / samples.length,
    permanentlyShadowed: lit === 0,
    longestShadowRun: longestRun,
    samples: samples.length,
  };
}
