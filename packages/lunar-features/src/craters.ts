/**
 * Crater population sampling and stamping (spec §8).
 *
 * Two population models:
 *   - `production_csfd` (default) — Neukum production capped by Xiao & Werner
 *     equilibrium, de-conflicted against the source DEM's effective resolution
 *     so real and synthetic craters never double-count.
 *   - `power_law` — the free parametric model of spec §8.
 */

import { Rng } from '@lts/terrain-core';
import {
  SEMANTIC_CLASSES,
  type CraterFeature,
  type CraterParameters,
  type TerrainLayer,
} from '@lts/shared-types';
import {
  cappedCumulativeDensityPerM2,
  ejectaExtent,
  ejectaRimThickness,
  freshDepthDiameterRatio,
  freshRimHeight,
  hasCentralPeak,
  mcgetchinEjectaThickness,
} from './craterModels.js';

export interface CraterSamplingOptions {
  /** Local-frame area to populate, metres. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  minDiameterM: number;
  maxDiameterM: number;
  model: 'production_csfd' | 'power_law';
  /** Surface age, Ga. Read by `production_csfd`. */
  surfaceAgeGa: number;
  /** Cumulative density at the anchor diameter, per km². Read by `power_law`. */
  densityPerKm2?: number;
  /**
   * Diameter the power-law density is anchored at, metres. Defaults to
   * `minDiameterM`. The pipeline raises `minDiameterM` to four grid samples,
   * so without an explicit anchor the same configuration would realise
   * different densities on different-resolution layers — the configured
   * density must always mean "cumulative density at the *configured* minimum".
   */
  powerLawAnchorDiameterM?: number;
  /** Differential slope. Read by `power_law`. */
  powerLawExponent: number;
  /**
   * Effective resolution of the source DEM, metres.
   *
   * Craters at or above this are already present in the measured elevations, so
   * synthesis is restricted to smaller diameters. Omit for a fully synthetic
   * layer.
   */
  demEffectiveResolutionM?: number;
  meanDegradation: number;
  degradationSpread: number;
  ellipticalFraction: number;
  /** Minimum centre separation as a multiple of the larger radius. 0 disables. */
  exclusionRadiusFactor: number;
  clustering: number;
}

export interface SampledCrater extends CraterParameters {
  id: string;
}

/**
 * Sample a crater population.
 *
 * Diameters are drawn in log-spaced bins: the expected count in each bin is the
 * difference of the cumulative density across it, multiplied by the area, then
 * Poisson-sampled. The realised count is therefore stochastic while the mean
 * obeys the underlying curve — which is the point of using a sourced model.
 */
export function sampleCraterPopulation(
  rng: Rng,
  opts: CraterSamplingOptions,
): { craters: SampledCrater[]; notes: string[] } {
  const notes: string[] = [];
  const areaM2 = (opts.maxX - opts.minX) * (opts.maxZ - opts.minZ);

  let dMax = opts.maxDiameterM;
  if (opts.demEffectiveResolutionM !== undefined) {
    const cut = opts.demEffectiveResolutionM;
    if (dMax > cut) {
      notes.push(
        `Crater synthesis capped at ${cut.toFixed(1)} m diameter: craters at or above the source ` +
          `DEM's effective resolution are already present in the measured elevations, so ` +
          `synthesising them would double-count the population.`,
      );
      dMax = cut;
    }
  }
  if (dMax <= opts.minDiameterM) {
    notes.push(
      `No craters synthesised: the de-confliction cap (${dMax.toFixed(2)} m) is at or below the ` +
        `requested minimum diameter (${opts.minDiameterM} m).`,
    );
    return { craters: [], notes };
  }

  // Cumulative density function, craters per m² with diameter >= D.
  const cumulative = (D: number): number => {
    if (opts.model === 'production_csfd') {
      return cappedCumulativeDensityPerM2(D, opts.surfaceAgeGa);
    }
    const n0 = (opts.densityPerKm2 ?? 150) / 1e6;
    const anchor = opts.powerLawAnchorDiameterM ?? opts.minDiameterM;
    // Cumulative slope is (exponent - 1) for a differential slope `exponent`.
    return n0 * Math.pow(D / anchor, -(opts.powerLawExponent - 1));
  };

  const BINS = 48;
  const logMin = Math.log(opts.minDiameterM);
  const logMax = Math.log(dMax);
  const craters: SampledCrater[] = [];
  let index = 0;

  // Cluster seeds, used when clustering > 0.
  const clusterCount = opts.clustering > 0 ? Math.max(1, Math.round(4 + 12 * opts.clustering)) : 0;
  const clusters: Array<{ x: number; z: number; r: number }> = [];
  for (let i = 0; i < clusterCount; i++) {
    clusters.push({
      x: rng.uniform(opts.minX, opts.maxX),
      z: rng.uniform(opts.minZ, opts.maxZ),
      r: Math.max(opts.maxX - opts.minX, opts.maxZ - opts.minZ) * (0.05 + 0.15 * (1 - opts.clustering)),
    });
  }

  for (let b = 0; b < BINS; b++) {
    const dLo = Math.exp(logMin + ((logMax - logMin) * b) / BINS);
    const dHi = Math.exp(logMin + ((logMax - logMin) * (b + 1)) / BINS);
    const expected = Math.max(0, (cumulative(dLo) - cumulative(dHi)) * areaM2);
    const count = rng.poisson(expected);

    for (let i = 0; i < count; i++) {
      // Diameter within the bin, from the local power-law shape.
      const diameter = rng.powerLaw(dLo, dHi, opts.powerLawExponent);

      let x: number;
      let z: number;
      if (clusters.length > 0 && rng.next() < opts.clustering) {
        const c = clusters[rng.intBelow(clusters.length)];
        x = c.x + rng.normal() * c.r;
        z = c.z + rng.normal() * c.r;
        if (x < opts.minX || x > opts.maxX || z < opts.minZ || z > opts.maxZ) continue;
      } else {
        x = rng.uniform(opts.minX, opts.maxX);
        z = rng.uniform(opts.minZ, opts.maxZ);
      }

      // Optional exclusion against already-placed craters.
      if (opts.exclusionRadiusFactor > 0) {
        let blocked = false;
        for (const c of craters) {
          const need = opts.exclusionRadiusFactor * Math.max(diameter, c.diameterMeters) * 0.5;
          const dx = c.centerXMeters - x;
          const dz = c.centerZMeters - z;
          if (dx * dx + dz * dz < need * need) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
      }

      craters.push(makeCrater(rng, `crater-${String(index++).padStart(6, '0')}`, x, z, diameter, opts));
    }
  }

  return { craters, notes };
}

/** Build a crater's geometry from its diameter and the population statistics. */
export function makeCrater(
  rng: Rng,
  id: string,
  x: number,
  z: number,
  diameterM: number,
  opts: Pick<CraterSamplingOptions, 'meanDegradation' | 'degradationSpread' | 'ellipticalFraction'>,
): SampledCrater {
  // Degradation, clamped to [0, 1).
  let degradation = opts.meanDegradation + rng.normal() * opts.degradationSpread;
  degradation = Math.max(0, Math.min(0.98, degradation));

  const freshDepth = diameterM * freshDepthDiameterRatio(diameterM);
  // Degradation infills the cavity and rounds the rim. The rim goes faster than
  // the floor, which is why old craters read as shallow dishes with no crest.
  const depth = freshDepth * (1 - degradation) ** 1.2;
  const rimHeight = freshRimHeight(diameterM) * (1 - degradation) ** 2.2;

  const elliptical = rng.next() < opts.ellipticalFraction;
  const ellipticity = elliptical ? rng.uniform(0.6, 0.92) : 1.0;

  const radius = diameterM / 2;
  // Bound the ejecta where it drops below 1 mm, well under any layer's
  // vertical resolution.
  const ejectaMax = Math.min(ejectaExtent(radius, 0.001), radius * 6);

  return {
    id,
    centerXMeters: x,
    centerZMeters: z,
    diameterMeters: diameterM,
    depthMeters: depth,
    rimHeightMeters: rimHeight,
    // Rim crest width is roughly a tenth of the diameter for simple craters.
    rimWidthMeters: diameterM * 0.1 * (1 + degradation),
    // Fresh simple craters are bowls with little flat floor; degradation
    // infills and flattens them.
    floorRadiusRatio: Math.min(0.75, 0.08 + 0.55 * degradation),
    ellipticity,
    rotationRadians: rng.uniform(0, Math.PI),
    degradation,
    ejectaExtentMeters: ejectaMax * (1 - degradation * 0.8),
    ejectaAmplitudeMeters: ejectaRimThickness(radius) * (1 - degradation) ** 1.5,
    centralPeak: hasCentralPeak(diameterM),
  };
}

/**
 * Radial elevation profile of a crater, metres, at normalised radius `u`
 * (u = 1 at the rim crest).
 *
 * Composed of a flat floor, a parabolic wall, a Gaussian rim crest and a
 * McGetchin ejecta tail.
 */
export function craterProfile(c: CraterParameters, u: number, radiusM: number): number {
  const f = c.floorRadiusRatio;
  let h = 0;

  if (u < 1) {
    if (u <= f) {
      h = -c.depthMeters;
    } else {
      const t = (u - f) / (1 - f);
      h = -c.depthMeters * (1 - t * t);
    }
  }

  // Rim crest, centred on u = 1.
  if (c.rimHeightMeters > 0) {
    const w = Math.max(1e-6, c.rimWidthMeters / radiusM);
    const d = (u - 1) / w;
    h += c.rimHeightMeters * Math.exp(-d * d);
  }

  // Ejecta blanket outside the rim.
  if (u > 1 && c.ejectaAmplitudeMeters > 0) {
    const r = u * radiusM;
    const t = mcgetchinEjectaThickness(radiusM, r);
    const scale = c.ejectaAmplitudeMeters / Math.max(1e-12, ejectaRimThickness(radiusM));
    h += t * scale;
  }

  return h;
}

/**
 * Semantic class indices, resolved once at module load. `craterSemantic` used
 * to call `SEMANTIC_CLASSES.indexOf` per sample inside the stamping loop; the
 * indices are constants, so hoisting them changes nothing but the cost.
 */
const SEM_CRATER_FLOOR = SEMANTIC_CLASSES.indexOf('crater_floor');
const SEM_CRATER_WALL = SEMANTIC_CLASSES.indexOf('crater_wall');
const SEM_CRATER_RIM = SEMANTIC_CLASSES.indexOf('crater_rim');

/** Semantic class for a sample at normalised crater radius `u`. */
function craterSemantic(c: CraterParameters, u: number): number {
  if (u <= c.floorRadiusRatio) return SEM_CRATER_FLOOR;
  if (u < 0.92) return SEM_CRATER_WALL;
  if (u <= 1.15) return SEM_CRATER_RIM;
  return -1;
}

export interface StampResult {
  /** Volume removed below the pre-existing surface, m³. */
  excavatedVolumeM3: number;
  /** Volume added above the pre-existing surface, m³. */
  depositedVolumeM3: number;
  samplesTouched: number;
}

/**
 * Reusable per-column scratch for {@link stampCrater} (single-threaded JS, and
 * `stampCrater` never re-enters itself, so module-level reuse is safe). Grown
 * on demand; Float64Array stores the precomputed products as exact doubles.
 */
let stampWxCos = new Float64Array(0);
let stampWxSin = new Float64Array(0);

/**
 * Stamp a crater into a layer's heightfield.
 *
 * Returns the excavated and deposited volumes so the caller can report how
 * closely the cavity and its ejecta balance. They do not balance exactly — the
 * McGetchin blanket is truncated at a finite radius and real impacts vaporise
 * and eject material off the patch — so this is reported rather than enforced.
 *
 * Performance note: this is the pipeline's hot path (the `generating_craters`
 * stage dominates demo-scale generation), so the per-sample loop is written
 * with every crater-constant subexpression hoisted and `craterProfile` /
 * `craterSemantic` inlined. Reproducibility invariant: every per-sample
 * floating-point operation happens with exactly the same operands, in exactly
 * the same order, as the straightforward form — hoisted values are
 * subexpressions whose operands do not depend on the sample, so their results
 * are bit-identical on every iteration (see docs/reproducibility.md; the
 * output must stay byte-for-byte identical for a given seed).
 */
export function stampCrater(
  layer: TerrainLayer,
  c: CraterParameters,
  semantic?: Uint8Array,
): StampResult {
  const res = layer.horizontalResolutionMeters;
  const radius = c.diameterMeters / 2;
  const reach = Math.max(radius * 1.2, c.ejectaExtentMeters);

  const colMin = Math.max(0, Math.floor((c.centerXMeters - reach - layer.bounds.minX) / res));
  const colMax = Math.min(
    layer.widthSamples - 1,
    Math.ceil((c.centerXMeters + reach - layer.bounds.minX) / res),
  );
  const rowMin = Math.max(0, Math.floor((c.centerZMeters - reach - layer.bounds.minZ) / res));
  const rowMax = Math.min(
    layer.heightSamples - 1,
    Math.ceil((c.centerZMeters + reach - layer.bounds.minZ) / res),
  );

  const cosR = Math.cos(-c.rotationRadians);
  const sinR = Math.sin(-c.rotationRadians);
  const cellArea = res * res;

  // ---- Per-crater invariants, hoisted out of the sample loop. Each is the
  // exact subexpression the loop used to evaluate per sample with operands
  // that do not vary across samples, so the hoisted result is bit-identical
  // to what every iteration would have recomputed.
  const ell = Math.max(1e-6, c.ellipticity);
  const uMax = reach / radius; // was: u > reach / radius, per sample
  const depth = c.depthMeters;
  const negDepth = -depth;
  const f = c.floorRadiusRatio;
  const wallDen = 1 - f; // was: (u - f) / (1 - f), per sample
  const rimH = c.rimHeightMeters;
  // was: Math.max(1e-6, c.rimWidthMeters / radiusM) per sample — same
  // division, same operands, every iteration.
  const rimW = rimH > 0 ? Math.max(1e-6, c.rimWidthMeters / radius) : 1;
  const ejectaAmp = c.ejectaAmplitudeMeters;
  // was (per sample, via mcgetchinEjectaThickness + ejectaRimThickness):
  //   rimThickness = 0.14 * Math.pow(radiusM, 0.74)          — two pow() calls
  //   scale = c.ejectaAmplitudeMeters / Math.max(1e-12, rimThickness)
  // Both depend only on the crater, so one evaluation is exact.
  const ejectaRimT = 0.14 * Math.pow(radius, 0.74);
  const ejectaScale = ejectaAmp / Math.max(1e-12, ejectaRimT);

  const heightData = layer.heightData;
  const widthSamples = layer.widthSamples;
  const minX = layer.bounds.minX;
  const minZ = layer.bounds.minZ;
  const cx = c.centerXMeters;
  const cz = c.centerZMeters;

  // ---- Per-column precompute. wx and its two rotation products depend only
  // on the column, not the row; computing them once per crater instead of
  // once per (row, col) repeats the exact same operations with the exact same
  // operands, so every stored double is bit-identical to the in-loop value.
  const nCols = colMax - colMin + 1;
  if (nCols > 0 && nCols > stampWxCos.length) {
    stampWxCos = new Float64Array(nCols);
    stampWxSin = new Float64Array(nCols);
  }
  for (let col = colMin; col <= colMax; col++) {
    const wx = minX + col * res - cx;
    stampWxCos[col - colMin] = wx * cosR;
    stampWxSin[col - colMin] = wx * sinR;
  }

  let excavated = 0;
  let deposited = 0;
  let touched = 0;

  for (let row = rowMin; row <= rowMax; row++) {
    const wz = minZ + row * res - cz;
    const wzSin = wz * sinR;
    const wzCos = wz * cosR;
    const rowBase = row * widthSamples;
    for (let col = colMin; col <= colMax; col++) {
      const k = col - colMin;

      // Rotate into the crater's frame and squash the minor axis.
      // rx = wx * cosR - wz * sinR; rz = (wx * sinR + wz * cosR) / ell —
      // identical operation sequence, products precomputed per column/row.
      const rx = stampWxCos[k] - wzSin;
      const rz = (stampWxSin[k] + wzCos) / ell;
      const u = Math.hypot(rx, rz) / radius;
      if (u > uMax) continue;

      // ---- craterProfile(c, u, radius), inlined with hoisted invariants.
      let dh = 0;
      if (u < 1) {
        if (u <= f) {
          dh = negDepth;
        } else {
          const t = (u - f) / wallDen;
          dh = negDepth * (1 - t * t);
        }
      }
      if (rimH > 0) {
        const d = (u - 1) / rimW;
        dh += rimH * Math.exp(-d * d);
      }
      if (u > 1 && ejectaAmp > 0) {
        const r = u * radius;
        // mcgetchinEjectaThickness(radius, r) with the rim thickness hoisted;
        // the r < radius branch returned 0, and adding 0 * scale (= +0) to a
        // non-negative dh left it unchanged, so the zero branch is skipped.
        if (r >= radius) {
          dh += ejectaRimT * Math.pow(r / radius, -3) * ejectaScale;
        }
      }

      if (dh === 0) continue;

      const i = rowBase + col;
      heightData[i] += dh;
      touched++;
      if (dh < 0) excavated += -dh * cellArea;
      else deposited += dh * cellArea;

      if (semantic) {
        // craterSemantic(c, u), inlined.
        if (u <= f) semantic[i] = SEM_CRATER_FLOOR;
        else if (u < 0.92) semantic[i] = SEM_CRATER_WALL;
        else if (u <= 1.15) semantic[i] = SEM_CRATER_RIM;
      }
    }
  }

  return { excavatedVolumeM3: excavated, depositedVolumeM3: deposited, samplesTouched: touched };
}

/** Convert a sampled crater into a manifest feature record. */
export function toCraterFeature(
  c: SampledCrater,
  layerIds: string[],
  origin: 'production_csfd' | 'authored',
  seedChannel: string,
): CraterFeature {
  const reach = Math.max(c.diameterMeters * 0.6, c.ejectaExtentMeters);
  return {
    id: c.id,
    kind: 'crater',
    appliedToLayers: layerIds,
    affectedBounds: {
      minX: c.centerXMeters - reach,
      maxX: c.centerXMeters + reach,
      minZ: c.centerZMeters - reach,
      maxZ: c.centerZMeters + reach,
    },
    seedChannel,
    origin,
    parameters: {
      centerXMeters: c.centerXMeters,
      centerZMeters: c.centerZMeters,
      diameterMeters: c.diameterMeters,
      depthMeters: c.depthMeters,
      rimHeightMeters: c.rimHeightMeters,
      rimWidthMeters: c.rimWidthMeters,
      floorRadiusRatio: c.floorRadiusRatio,
      ellipticity: c.ellipticity,
      rotationRadians: c.rotationRadians,
      degradation: c.degradation,
      ejectaExtentMeters: c.ejectaExtentMeters,
      ejectaAmplitudeMeters: c.ejectaAmplitudeMeters,
      centralPeak: c.centralPeak,
    },
  };
}
