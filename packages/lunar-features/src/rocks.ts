/**
 * Boulder / clast population (spec §9).
 *
 * Default model is the **Golombek exponential rock size-frequency
 * distribution** (Golombek & Rapp 1997, *JGR* 102:4117–4129; Golombek et al.
 * 2003, *JGR* 108:8086), the standard tool for predicting rock hazards at
 * planetary landing sites:
 *
 *     F(D) = k · exp(−q(k)·D),        q(k) = 1.79 + 0.152/k
 *
 * where `F(D)` is the cumulative fraction of surface **area** covered by rocks
 * of diameter ≥ D, and `k` is the total area fraction covered by rocks. Typical
 * lunar mare and polar terrain runs k ≈ 0.03–0.10.
 *
 * Rocks are emitted as **instances**, not stamped into the heightfield. A
 * boulder is not a height function — a heightfield cannot represent its
 * overhang or its underside — so it is carried as transform + collision proxy
 * and the terrain beneath it stays intact.
 */

import { Rng } from '@lts/terrain-core';
import {
  SEMANTIC_CLASSES,
  heightAtWorld,
  slopeDegAtWorld,
  type RockFeature,
  type TerrainLayer,
} from '@lts/shared-types';

/** Golombek's `q` parameter for a given total area coverage `k`. */
export function golombekQ(k: number): number {
  if (k <= 0) throw new Error('rock area coverage k must be positive');
  return 1.79 + 0.152 / k;
}

/** Cumulative fractional **area** covered by rocks with diameter ≥ D. */
export function golombekAreaFraction(k: number, diameterM: number): number {
  return k * Math.exp(-golombekQ(k) * diameterM);
}

/**
 * Differential number density of rocks, per m² per metre of diameter.
 *
 * Derived from the area model: `dF/dD = −k q e^(−qD)` is the area removed per
 * unit diameter, and a rock of diameter D covers `πD²/4`, so
 *
 *     n(D) = 4 k q e^(−qD) / (π D²)
 */
export function golombekNumberDensity(k: number, diameterM: number): number {
  const q = golombekQ(k);
  return (4 * k * q * Math.exp(-q * diameterM)) / (Math.PI * diameterM * diameterM);
}

/**
 * Cumulative number of rocks per m² with diameter in [dMin, dMax], by numerical
 * integration of {@link golombekNumberDensity}.
 *
 * Integrated rather than using the common `F(D)/(πD²/4)` shortcut, which
 * silently assumes every rock above D has diameter exactly D and overestimates
 * the count for a steep distribution.
 */
export function golombekCumulativeCount(k: number, dMin: number, dMax: number, bins = 512): number {
  if (dMax <= dMin) return 0;
  const logMin = Math.log(dMin);
  const logMax = Math.log(dMax);
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const a = Math.exp(logMin + ((logMax - logMin) * i) / bins);
    const b = Math.exp(logMin + ((logMax - logMin) * (i + 1)) / bins);
    const mid = Math.sqrt(a * b);
    total += golombekNumberDensity(k, mid) * (b - a);
  }
  return total;
}

export interface RockSamplingOptions {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  model: 'golombek_sfd' | 'power_law';
  /** Total fractional area covered by rocks. Read by `golombek_sfd`. */
  areaCoverage: number;
  minDiameterM: number;
  maxDiameterM: number;
  physicalMinDiameterM: number;
  /** Rocks per m². Read by `power_law`. */
  densityPerM2?: number;
  powerLawExponent: number;
  meanBuriedFraction: number;
  angularity: number;
  maxSlopeDeg: number;
  /** Density multiplier within a crater's rim annulus. */
  craterRimEnhancement: number;
  /** Crater rims to concentrate rocks on. */
  craterRims: Array<{ x: number; z: number; radiusM: number }>;
  material: string;
}

export interface SampledRock {
  id: string;
  x: number;
  z: number;
  diameterM: number;
  physical: boolean;
  buriedFraction: number;
  angularity: number;
  /** Semi-axes, metres. */
  semiAxes: [number, number, number];
  rotation: [number, number, number, number];
}

/** Random unit quaternion, uniformly distributed over SO(3) (Shoemake's method). */
function randomQuaternion(rng: Rng): [number, number, number, number] {
  const u1 = rng.next();
  const u2 = rng.next();
  const u3 = rng.next();
  const s1 = Math.sqrt(1 - u1);
  const s2 = Math.sqrt(u1);
  return [
    s1 * Math.sin(2 * Math.PI * u2),
    s1 * Math.cos(2 * Math.PI * u2),
    s2 * Math.sin(2 * Math.PI * u3),
    s2 * Math.cos(2 * Math.PI * u3),
  ];
}

/**
 * Sample a rock population over a layer.
 *
 * Rocks are rejected where the local slope exceeds `maxSlopeDeg` — loose clasts
 * do not rest on steep crater walls — and preferentially retained on crater
 * rims, where impact excavation concentrates blocky ejecta.
 */
export function sampleRockPopulation(
  rng: Rng,
  layer: TerrainLayer,
  opts: RockSamplingOptions,
): { rocks: SampledRock[]; notes: string[] } {
  const notes: string[] = [];
  const areaM2 = (opts.maxX - opts.minX) * (opts.maxZ - opts.minZ);

  const countPerM2 =
    opts.model === 'golombek_sfd'
      ? golombekCumulativeCount(opts.areaCoverage, opts.minDiameterM, opts.maxDiameterM)
      : (opts.densityPerM2 ?? 0.05);

  const expected = countPerM2 * areaM2;
  if (expected > 5_000_000) {
    notes.push(
      `Rock population expectation is ${Math.round(expected).toLocaleString()} instances; ` +
        `consider raising minDiameterM. Instancing cost grows linearly.`,
    );
  }

  const BINS = 40;
  const logMin = Math.log(opts.minDiameterM);
  const logMax = Math.log(opts.maxDiameterM);
  const rocks: SampledRock[] = [];
  let index = 0;
  let rejectedSlope = 0;

  /**
   * Diameter within a bin, drawn from the ACTIVE model's own distribution.
   *
   * The exponential model previously drew within-bin diameters from the
   * power-law exponent — a parameter that is supposed to be inert in Golombek
   * mode. Within a narrow log bin the difference is small, but the sampled
   * distribution must not depend on an unrelated knob. For the exponential
   * model the dominant within-bin weight e^(−qD) is inverted exactly.
   */
  const q = golombekQ(Math.max(1e-6, opts.areaCoverage));
  const drawDiameter = (dLo: number, dHi: number): number => {
    if (opts.model === 'power_law') return rng.powerLaw(dLo, dHi, opts.powerLawExponent);
    const eLo = Math.exp(-q * dLo);
    const eHi = Math.exp(-q * dHi);
    const u = rng.next();
    return -Math.log(eLo - u * (eLo - eHi)) / q;
  };

  const makeRock = (x: number, z: number, dLo: number, dHi: number): void => {
    if (slopeDegAtWorld(layer, x, z) > opts.maxSlopeDeg) {
      rejectedSlope++;
      return;
    }
    const diameter = drawDiameter(dLo, dHi);
    const buried = Math.max(0, Math.min(0.95, opts.meanBuriedFraction + rng.normal() * 0.15));
    // Irregular clasts: axis ratios widen with angularity.
    const spread = 0.15 + 0.35 * opts.angularity;
    const a = diameter / 2;
    const semiAxes: [number, number, number] = [
      a * (1 + rng.normal() * spread * 0.5),
      a * Math.max(0.35, 1 - Math.abs(rng.normal()) * spread),
      a * (1 + rng.normal() * spread * 0.5),
    ];
    rocks.push({
      id: `rock-${String(index++).padStart(6, '0')}`,
      x,
      z,
      diameterM: diameter,
      physical: diameter >= opts.physicalMinDiameterM,
      buriedFraction: buried,
      angularity: opts.angularity,
      semiAxes,
      rotation: randomQuaternion(rng),
    });
  };

  // Rim annuli (0.9R..1.4R), clipped against nothing — annulus area is only
  // used for the EXCESS expectation below.
  const RIM_INNER = 0.9;
  const RIM_OUTER = 1.4;
  const rims = opts.craterRims;
  const rimAnnulusArea = rims.reduce(
    (sum, r) => sum + Math.PI * r.radiusM * r.radiusM * (RIM_OUTER ** 2 - RIM_INNER ** 2),
    0,
  );

  for (let b = 0; b < BINS; b++) {
    const dLo = Math.exp(logMin + ((logMax - logMin) * b) / BINS);
    const dHi = Math.exp(logMin + ((logMax - logMin) * (b + 1)) / BINS);

    const perM2 =
      opts.model === 'golombek_sfd'
        ? golombekCumulativeCount(opts.areaCoverage, dLo, dHi)
        : (opts.densityPerM2 ?? 0.05) *
          (Math.pow(dLo / opts.minDiameterM, -(opts.powerLawExponent - 1)) -
            Math.pow(dHi / opts.minDiameterM, -(opts.powerLawExponent - 1)));

    // Background population at the FULL calibrated density, everywhere.
    //
    // The previous construction thinned off-rim rocks to 1/enhancement, which
    // silently divided the calibrated global coverage by the enhancement
    // factor (default 4): configuring Golombek k = 0.06 realised ~0.015.
    // Rim blockiness is physically EXCESS ejecta on rims, not a suppression
    // of the background — so the background stays calibrated and the rims
    // receive additional rocks on top.
    const count = rng.poisson(Math.max(0, perM2 * areaM2));
    for (let i = 0; i < count; i++) {
      makeRock(rng.uniform(opts.minX, opts.maxX), rng.uniform(opts.minZ, opts.maxZ), dLo, dHi);
    }

    // Rim excess: (enhancement − 1) × the background density over the annuli.
    if (opts.craterRimEnhancement > 1 && rims.length > 0 && rimAnnulusArea > 0) {
      const excess = rng.poisson(
        Math.max(0, perM2 * rimAnnulusArea * (opts.craterRimEnhancement - 1)),
      );
      for (let i = 0; i < excess; i++) {
        // Pick an annulus weighted by its area, then a uniform point in it.
        let pick = rng.next() * rimAnnulusArea;
        let rim = rims[rims.length - 1];
        for (const r of rims) {
          const a = Math.PI * r.radiusM * r.radiusM * (RIM_OUTER ** 2 - RIM_INNER ** 2);
          if (pick < a) {
            rim = r;
            break;
          }
          pick -= a;
        }
        // Uniform over an annulus: r = sqrt(u·(ro²−ri²)+ri²).
        const ri = rim.radiusM * RIM_INNER;
        const ro = rim.radiusM * RIM_OUTER;
        const rr = Math.sqrt(rng.next() * (ro * ro - ri * ri) + ri * ri);
        const theta = rng.uniform(0, 2 * Math.PI);
        const x = rim.x + rr * Math.cos(theta);
        const z = rim.z + rr * Math.sin(theta);
        if (x < opts.minX || x > opts.maxX || z < opts.minZ || z > opts.maxZ) continue;
        makeRock(x, z, dLo, dHi);
      }
    }
  }

  if (rejectedSlope > 0) {
    notes.push(
      `${rejectedSlope.toLocaleString()} rocks rejected for sitting on slopes steeper than ` +
        `${opts.maxSlopeDeg}°.`,
    );
  }

  return { rocks, notes };
}

/** Convert a sampled rock into a manifest feature, resolving its elevation. */
export function toRockFeature(
  rock: SampledRock,
  layer: TerrainLayer,
  layerIds: string[],
  material: string,
  seedChannel: string,
): RockFeature {
  const ground = heightAtWorld(layer, rock.x, rock.z);
  // Centre sits so that `buriedFraction` of the vertical extent is below grade.
  const y = ground + rock.semiAxes[1] * (1 - 2 * rock.buriedFraction);
  const maxAxis = Math.max(...rock.semiAxes);

  return {
    id: rock.id,
    kind: 'rock',
    appliedToLayers: layerIds,
    affectedBounds: {
      minX: rock.x - maxAxis,
      maxX: rock.x + maxAxis,
      minZ: rock.z - maxAxis,
      maxZ: rock.z + maxAxis,
    },
    seedChannel,
    position: { x: rock.x, y, z: rock.z },
    rotationQuaternion: rock.rotation,
    scale: { x: rock.semiAxes[0], y: rock.semiAxes[1], z: rock.semiAxes[2] },
    physical: rock.physical,
    buriedFraction: rock.buriedFraction,
    angularity: rock.angularity,
    material,
    semanticClass: 'boulder',
  };
}

/** Mark the semantic mask where rocks sit, so the class map matches the instances. */
export function markRockSemantics(
  layer: TerrainLayer,
  rocks: SampledRock[],
  semantic: Uint8Array,
): void {
  const rockField = SEMANTIC_CLASSES.indexOf('rock_field');
  const res = layer.horizontalResolutionMeters;
  for (const rock of rocks) {
    const r = Math.max(rock.semiAxes[0], rock.semiAxes[2]);
    const colMin = Math.max(0, Math.floor((rock.x - r - layer.bounds.minX) / res));
    const colMax = Math.min(
      layer.widthSamples - 1,
      Math.ceil((rock.x + r - layer.bounds.minX) / res),
    );
    const rowMin = Math.max(0, Math.floor((rock.z - r - layer.bounds.minZ) / res));
    const rowMax = Math.min(
      layer.heightSamples - 1,
      Math.ceil((rock.z + r - layer.bounds.minZ) / res),
    );
    for (let row = rowMin; row <= rowMax; row++) {
      const dz = layer.bounds.minZ + row * res - rock.z;
      for (let col = colMin; col <= colMax; col++) {
        const dx = layer.bounds.minX + col * res - rock.x;
        if (dx * dx + dz * dz <= r * r) {
          semantic[row * layer.widthSamples + col] = rockField;
        }
      }
    }
  }
}
