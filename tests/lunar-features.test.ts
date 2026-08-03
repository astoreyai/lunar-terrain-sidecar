/**
 * Crater and boulder models checked against their published behaviour.
 *
 * Where a paper states a number, it is asserted directly. Where it states a
 * *relationship* (a slope, a scaling, a monotonicity), that is asserted
 * instead — which catches sign and exponent errors that a single spot value
 * would not.
 */

import { describe, expect, it } from 'vitest';
import {
  Rng,
  SeedTree,
  deriveSeed,
  PerlinNoise2D,
  fbm,
  ridgedMultifractal,
  DEFAULT_FRACTAL,
  estimate,
  assertFeasible,
  samplesForExtent,
} from '@lts/terrain-core';
import {
  EQUILIBRIUM_COEFFICIENT,
  cappedCumulativeDensityPerM2,
  ejectaExtent,
  ejectaRimThickness,
  equilibriumDensity,
  freshDepthDiameterRatio,
  freshRimHeight,
  golombekAreaFraction,
  golombekCumulativeCount,
  golombekQ,
  mcgetchinEjectaThickness,
  neukumChronology,
  neukumProductionAt1Ga,
  productionDensity,
  productionDensityExtended,
  NEUKUM_SMALL_D_SLOPE,
  sampleCraterPopulation,
  makeCrater,
  craterProfile,
} from '@lts/lunar-features';
import { parseConfig, TerrainError } from '@lts/shared-types';

describe('Neukum production function and chronology', () => {
  it('agrees with its own chronology at D = 1 km, T = 1 Ga', () => {
    // Both express N(>=1 km) per km2 on a 1 Ga surface but are fitted
    // separately, so agreement to a few percent is a real cross-check that
    // neither the polynomial coefficients nor the chronology constants have
    // been transcribed wrongly.
    const fromPolynomial = neukumProductionAt1Ga(1.0);
    const fromChronology = neukumChronology(1.0);
    const ratio = fromPolynomial / fromChronology;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it('decreases monotonically with diameter', () => {
    let prev = Infinity;
    for (let d = 0.01; d <= 100; d *= 1.5) {
      const n = neukumProductionAt1Ga(d);
      expect(n).toBeLessThan(prev);
      prev = n;
    }
  });

  it('grows with surface age, steeply before 3.5 Ga', () => {
    const young = productionDensity(0.1, 1.0);
    const old = productionDensity(0.1, 3.5);
    const ancient = productionDensity(0.1, 4.1);
    expect(old).toBeGreaterThan(young);
    expect(ancient).toBeGreaterThan(old);
    // The LHB exponential means 3.5 -> 4.1 Ga adds far more than 1.0 -> 3.5 Ga.
    expect(ancient / old).toBeGreaterThan(old / young);
  });

  it('reproduces the chronology exponential term', () => {
    // N(1,T) = 5.44e-14 (e^(6.93T) - 1) + 8.38e-4 T
    const T = 4.0;
    const expected = 5.44e-14 * (Math.exp(6.93 * T) - 1) + 8.38e-4 * T;
    expect(neukumChronology(T)).toBeCloseTo(expected, 12);
  });
});

describe('production continuation below the polynomial floor', () => {
  it('continues smoothly across the 10 m validity floor', () => {
    // The polynomial is only valid to 0.01 km. The continuation must join it
    // without a step, or the crater count would jump discontinuously at 10 m.
    const justAbove = productionDensityExtended(0.0101, 3.5);
    const justBelow = productionDensityExtended(0.0099, 3.5);
    expect(justBelow / justAbove).toBeGreaterThan(1.0);
    expect(justBelow / justAbove).toBeLessThan(1.1);
  });

  it('uses a physically plausible small-diameter slope', () => {
    // Lunar cumulative SFD slope at small sizes runs about -2 to -4.
    expect(NEUKUM_SMALL_D_SLOPE).toBeLessThan(-2);
    expect(NEUKUM_SMALL_D_SLOPE).toBeGreaterThan(-4.5);
  });

  it('does not clamp sub-floor diameters to the floor value', () => {
    // The bug this replaced: clamping made a 0.5 m crater as rare as a 10 m
    // one, which suppressed the population by orders of magnitude.
    const atFloor = productionDensityExtended(0.01, 3.5);
    const wellBelow = productionDensityExtended(0.0005, 3.5);
    expect(wellBelow).toBeGreaterThan(atFloor * 100);
  });
});

describe('Xiao & Werner equilibrium', () => {
  it('is scale-free with n·D² = 0.084', () => {
    for (const d of [0.1, 1, 10, 100, 1000]) {
      expect(equilibriumDensity(d) * d * d).toBeCloseTo(EQUILIBRIUM_COEFFICIENT, 12);
    }
  });

  it('caps the production function for small craters on an old surface', () => {
    // On a 3.5 Ga surface the production function alone would place more
    // sub-metre craters than can physically coexist; the cap must bind there
    // and not bind for large craters.
    const smallCapped = cappedCumulativeDensityPerM2(0.5, 3.5);
    expect(smallCapped).toBeCloseTo(equilibriumDensity(0.5), 12);

    const large = cappedCumulativeDensityPerM2(5000, 3.5);
    expect(large).toBeLessThan(equilibriumDensity(5000));
  });
});

describe('crater morphometry', () => {
  it('holds Pike depth/diameter above 400 m and shallows below it', () => {
    expect(freshDepthDiameterRatio(400)).toBeCloseTo(0.2, 12);
    expect(freshDepthDiameterRatio(2000)).toBeCloseTo(0.2, 12);
    // Stopar: shallower at metre scale.
    expect(freshDepthDiameterRatio(1)).toBeCloseTo(0.11, 12);
    expect(freshDepthDiameterRatio(50)).toBeGreaterThan(0.11);
    expect(freshDepthDiameterRatio(50)).toBeLessThan(0.2);
  });

  it('increases depth/diameter monotonically with size', () => {
    let prev = 0;
    for (let d = 0.5; d <= 1000; d *= 1.3) {
      const r = freshDepthDiameterRatio(d);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = r;
    }
  });

  it('uses Pike rim height of 4% of diameter', () => {
    expect(freshRimHeight(100)).toBeCloseTo(4, 12);
  });
});

describe('McGetchin ejecta', () => {
  it('falls as the inverse cube of normalised range', () => {
    const R = 50;
    const atRim = mcgetchinEjectaThickness(R, R);
    const at2R = mcgetchinEjectaThickness(R, 2 * R);
    const at3R = mcgetchinEjectaThickness(R, 3 * R);
    expect(at2R / atRim).toBeCloseTo(1 / 8, 9);
    expect(at3R / atRim).toBeCloseTo(1 / 27, 9);
  });

  it('matches the 0.14 R^0.74 rim thickness', () => {
    const R = 100;
    expect(ejectaRimThickness(R)).toBeCloseTo(0.14 * Math.pow(100, 0.74), 12);
    expect(mcgetchinEjectaThickness(R, R)).toBeCloseTo(ejectaRimThickness(R), 12);
  });

  it('is zero inside the crater', () => {
    expect(mcgetchinEjectaThickness(50, 49.9)).toBe(0);
  });

  it('bounds the blanket where it drops below a cutoff', () => {
    const R = 20;
    const cutoff = 0.001;
    const extent = ejectaExtent(R, cutoff);
    expect(mcgetchinEjectaThickness(R, extent)).toBeCloseTo(cutoff, 9);
  });
});

describe('crater profile', () => {
  const rng = new Rng('profile-test');
  const c = makeCrater(rng, 'c0', 0, 0, 20, {
    meanDegradation: 0,
    degradationSpread: 0,
    ellipticalFraction: 0,
  });

  it('is deepest at the centre and rises to a rim', () => {
    const centre = craterProfile(c, 0, 10);
    const mid = craterProfile(c, 0.6, 10);
    const rim = craterProfile(c, 1.0, 10);
    expect(centre).toBeLessThan(mid);
    expect(mid).toBeLessThan(rim);
    expect(rim).toBeGreaterThan(0);
    expect(centre).toBeCloseTo(-c.depthMeters, 6);
  });

  it('decays to nothing far outside the rim', () => {
    expect(Math.abs(craterProfile(c, 20, 10))).toBeLessThan(1e-3);
  });

  it('makes degraded craters shallower with a suppressed rim', () => {
    const fresh = makeCrater(new Rng('a'), 'f', 0, 0, 20, {
      meanDegradation: 0,
      degradationSpread: 0,
      ellipticalFraction: 0,
    });
    const worn = makeCrater(new Rng('a'), 'w', 0, 0, 20, {
      meanDegradation: 0.9,
      degradationSpread: 0,
      ellipticalFraction: 0,
    });
    expect(worn.depthMeters).toBeLessThan(fresh.depthMeters);
    expect(worn.rimHeightMeters).toBeLessThan(fresh.rimHeightMeters);
    // The rim degrades faster than the floor infills.
    expect(worn.rimHeightMeters / fresh.rimHeightMeters).toBeLessThan(
      worn.depthMeters / fresh.depthMeters,
    );
    expect(worn.floorRadiusRatio).toBeGreaterThan(fresh.floorRadiusRatio);
  });
});

describe('crater population sampling', () => {
  const baseOpts = {
    minX: -50,
    minZ: -50,
    maxX: 50,
    maxZ: 50,
    minDiameterM: 0.3,
    maxDiameterM: 10,
    model: 'production_csfd' as const,
    surfaceAgeGa: 3.5,
    powerLawExponent: 3.0,
    meanDegradation: 0.45,
    degradationSpread: 0.3,
    ellipticalFraction: 0.15,
    exclusionRadiusFactor: 0,
    clustering: 0,
  };

  it('is deterministic for a given seed', () => {
    const a = sampleCraterPopulation(new Rng('seed-x'), baseOpts).craters;
    const b = sampleCraterPopulation(new Rng('seed-x'), baseOpts).craters;
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].centerXMeters).toBe(b[i].centerXMeters);
      expect(a[i].diameterMeters).toBe(b[i].diameterMeters);
      expect(a[i].degradation).toBe(b[i].degradation);
    }
  });

  it('produces different populations for different seeds', () => {
    const a = sampleCraterPopulation(new Rng('seed-x'), baseOpts).craters;
    const b = sampleCraterPopulation(new Rng('seed-y'), baseOpts).craters;
    expect(a[0].centerXMeters).not.toBe(b[0].centerXMeters);
  });

  it('realises a count near the equilibrium expectation', () => {
    // Over 100x100 m with D >= 0.3 m, the equilibrium cap dominates:
    // n = 0.084 / 0.3^2 = 0.933 per m2 -> ~9333 craters, minus those above the
    // 10 m upper bound (negligible).
    const { craters } = sampleCraterPopulation(new Rng('count-test'), baseOpts);
    const expected = equilibriumDensity(0.3) * 100 * 100;
    expect(craters.length).toBeGreaterThan(expected * 0.9);
    expect(craters.length).toBeLessThan(expected * 1.1);
  });

  it('respects the DEM de-confliction cap and says so', () => {
    const { craters, notes } = sampleCraterPopulation(new Rng('deconflict'), {
      ...baseOpts,
      demEffectiveResolutionM: 2.0,
    });
    expect(craters.every((c) => c.diameterMeters <= 2.0)).toBe(true);
    expect(notes.join(' ')).toMatch(/double-count/);
  });

  it('returns nothing, with an explanation, when the cap is below the minimum', () => {
    const { craters, notes } = sampleCraterPopulation(new Rng('nocraters'), {
      ...baseOpts,
      demEffectiveResolutionM: 0.1,
    });
    expect(craters).toHaveLength(0);
    expect(notes.join(' ')).toMatch(/No craters synthesised/);
  });

  it('follows a power law when asked to', () => {
    const { craters } = sampleCraterPopulation(new Rng('pl'), {
      ...baseOpts,
      model: 'power_law',
      densityPerKm2: 500_000,
    });
    expect(craters.length).toBeGreaterThan(100);
    // Small craters must vastly outnumber large ones.
    const small = craters.filter((c) => c.diameterMeters < 1).length;
    const large = craters.filter((c) => c.diameterMeters > 3).length;
    expect(small).toBeGreaterThan(large * 5);
  });
});

describe('Golombek rock size-frequency distribution', () => {
  it('computes q(k) as published', () => {
    expect(golombekQ(0.06)).toBeCloseTo(1.79 + 0.152 / 0.06, 12);
    expect(golombekQ(0.1)).toBeCloseTo(3.31, 10);
  });

  it('recovers the total area coverage as D approaches zero', () => {
    // F(0) = k by construction.
    expect(golombekAreaFraction(0.06, 0)).toBeCloseTo(0.06, 12);
    expect(golombekAreaFraction(0.06, 1e-9)).toBeCloseTo(0.06, 8);
  });

  it('decays exponentially with diameter', () => {
    const k = 0.06;
    const q = golombekQ(k);
    expect(golombekAreaFraction(k, 1)).toBeCloseTo(k * Math.exp(-q), 12);
    // A rockier surface has a shallower decay, so big rocks are relatively
    // more common.
    expect(golombekQ(0.2)).toBeLessThan(golombekQ(0.02));
  });

  it('gives more small rocks than large ones', () => {
    const k = 0.06;
    const small = golombekCumulativeCount(k, 0.05, 0.1);
    const large = golombekCumulativeCount(k, 0.5, 1.0);
    expect(small).toBeGreaterThan(large * 100);
  });

  it('converges as the integration is refined', () => {
    const coarse = golombekCumulativeCount(0.06, 0.05, 3, 128);
    const fine = golombekCumulativeCount(0.06, 0.05, 3, 4096);
    expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.01);
  });
});

describe('deterministic seeding', () => {
  it('derives stable named channels', () => {
    expect(deriveSeed('site-alpha', 'crater')).toBe(deriveSeed('site-alpha', 'crater'));
    expect(deriveSeed('site-alpha', 'crater')).not.toBe(deriveSeed('site-alpha', 'rock'));
    expect(deriveSeed('site-alpha', 'crater')).not.toBe(deriveSeed('site-beta', 'crater'));
  });

  it('keeps one channel stable when another is added', () => {
    // Adding a generator must not perturb existing streams (spec §6).
    const tree = new SeedTree('master');
    const crater1 = tree.seed('crater');
    tree.seed('rock');
    tree.seed('regolith');
    expect(tree.seed('crater')).toBe(crater1);
  });

  it('records every derived channel for provenance', () => {
    const tree = new SeedTree('m');
    tree.seed('b');
    tree.seed('a');
    expect(Object.keys(tree.manifest())).toEqual(['a', 'b']);
  });

  it('produces a uniform stream', () => {
    const rng = new Rng('uniformity');
    const buckets = new Array(10).fill(0);
    const N = 200_000;
    for (let i = 0; i < N; i++) buckets[Math.floor(rng.next() * 10)]++;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(N / 10 - 1500);
      expect(b).toBeLessThan(N / 10 + 1500);
    }
  });

  it('produces a standard normal with the right moments', () => {
    const rng = new Rng('normal');
    let sum = 0;
    let sumSq = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) {
      const v = rng.normal();
      sum += v;
      sumSq += v * v;
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.02);
    expect(sumSq / N).toBeGreaterThan(0.97);
    expect(sumSq / N).toBeLessThan(1.03);
  });

  it('produces Poisson counts with mean ≈ variance ≈ lambda', () => {
    for (const lambda of [0.5, 5, 25]) {
      const rng = new Rng(`poisson-${lambda}`);
      const N = 60_000;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < N; i++) {
        const k = rng.poisson(lambda);
        sum += k;
        sumSq += k * k;
      }
      const mean = sum / N;
      const variance = sumSq / N - mean * mean;
      expect(mean).toBeGreaterThan(lambda * 0.95);
      expect(mean).toBeLessThan(lambda * 1.05);
      expect(variance).toBeGreaterThan(lambda * 0.9);
      expect(variance).toBeLessThan(lambda * 1.1);
    }
  });

  it('samples a power law with the requested slope', () => {
    const rng = new Rng('powerlaw');
    const alpha = 3;
    const dMin = 1;
    const dMax = 100;
    let below2 = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) if (rng.powerLaw(dMin, dMax, alpha) < 2) below2++;
    // For dN/dD ~ D^-3 the cumulative between 1 and 2 relative to 1..100 is
    // (1 - 2^-2) / (1 - 100^-2) = 0.75 / 0.9999.
    const expected = (1 - Math.pow(2, -(alpha - 1))) / (1 - Math.pow(dMax, -(alpha - 1)));
    expect(below2 / N).toBeCloseTo(expected, 2);
  });
});

describe('procedural noise', () => {
  it('is deterministic and seed-dependent', () => {
    const a = new PerlinNoise2D('n1');
    const b = new PerlinNoise2D('n1');
    const c = new PerlinNoise2D('n2');
    expect(a.noise(1.3, -4.7)).toBe(b.noise(1.3, -4.7));
    expect(a.noise(1.3, -4.7)).not.toBe(c.noise(1.3, -4.7));
  });

  it('stays inside its nominal range', () => {
    const n = new PerlinNoise2D('range');
    let max = 0;
    for (let i = 0; i < 20000; i++) {
      const v = n.noise(i * 0.137, i * 0.079);
      max = Math.max(max, Math.abs(v));
    }
    expect(max).toBeLessThanOrEqual(1.0001);
    expect(max).toBeGreaterThan(0.5);
  });

  it('honours the amplitude parameter in metres', () => {
    const n = new PerlinNoise2D('amp');
    const p = { ...DEFAULT_FRACTAL, amplitude: 3.0, frequency: 0.05 };
    let max = 0;
    for (let i = 0; i < 20000; i++) {
      max = Math.max(max, Math.abs(fbm(n, i * 0.3, i * 0.7, p)));
    }
    expect(max).toBeLessThanOrEqual(3.0001);
  });

  it('produces zero-mean fBm and non-zero-mean ridged noise', () => {
    const n = new PerlinNoise2D('mean');
    const p = { ...DEFAULT_FRACTAL, amplitude: 1, frequency: 0.02 };
    let f = 0;
    let r = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) {
      const x = (i % 200) * 1.7;
      const y = Math.floor(i / 200) * 1.7;
      f += fbm(n, x, y, p);
      r += ridgedMultifractal(n, x, y, p);
    }
    expect(Math.abs(f / N)).toBeLessThan(0.1);
    // Ridged noise creases upward, so its distribution is skewed.
    expect(Math.abs(r / N)).toBeGreaterThan(0.05);
  });
});

describe('feasibility estimator', () => {
  const baseConfig = {
    terrainId: 'est',
    seed: 's',
    site: { latitudeDeg: -89.45, longitudeDeg: -137.5 },
    layers: [
      { role: 'context' as const, widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2 },
      { role: 'operational' as const, widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.01 },
    ],
  };

  it('counts samples inclusive of both edges', () => {
    expect(samplesForExtent(30, 0.01)).toBe(3001);
    expect(samplesForExtent(1000, 2)).toBe(501);
  });

  it('reproduces the spec §15 worked example', () => {
    // 50 m x 50 m at 0.01 m/sample = 5001^2 = 25,010,001 samples,
    // ~100 MB of float32.
    const est = estimate(
      parseConfig({
        ...baseConfig,
        layers: [
          { role: 'context', widthMeters: 200, lengthMeters: 200, resolutionMeters: 1 },
          { role: 'operational', widthMeters: 50, lengthMeters: 50, resolutionMeters: 0.01 },
        ],
      }),
    );
    const op = est.layers.find((l) => l.role === 'operational')!;
    expect(op.samples).toBe(25_010_001);
    expect(op.heightBytes).toBe(25_010_001 * 4);
    expect(op.heightBytes / 1e6).toBeCloseTo(100, 0);
    expect(op.tiles).toBeGreaterThan(1);
    expect(est.warnings.join(' ')).toMatch(/not recommended/);
  });

  it('rejects a configuration above the memory ceiling', () => {
    const cfg = parseConfig({
      ...baseConfig,
      layers: [
        { role: 'context', widthMeters: 2000, lengthMeters: 2000, resolutionMeters: 2 },
        { role: 'operational', widthMeters: 1500, lengthMeters: 1500, resolutionMeters: 0.01 },
      ],
      limits: { maxBytes: 2 * 1024 * 1024 * 1024 },
    });
    const est = estimate(cfg);
    expect(() => assertFeasible(cfg, est)).toThrow(TerrainError);
    try {
      assertFeasible(cfg, est);
    } catch (e) {
      const err = e as TerrainError;
      expect(err.code).toBe('TERRAIN_MEMORY_LIMIT_EXCEEDED');
      expect(err.details.estimatedBytes).toBeGreaterThan(err.details.limitBytes as number);
    }
  });

  it('rejects a fine layer that escapes its coarse parent', () => {
    const cfg = parseConfig({
      ...baseConfig,
      layers: [
        { role: 'context', widthMeters: 100, lengthMeters: 100, resolutionMeters: 1 },
        {
          role: 'operational',
          widthMeters: 30,
          lengthMeters: 30,
          resolutionMeters: 0.05,
          centerXMeters: 90,
        },
      ],
    });
    const est = estimate(cfg);
    expect(() => assertFeasible(cfg, est)).toThrow(/not contained/);
  });

  it('accepts the nested demonstration configuration', () => {
    const cfg = parseConfig({
      ...baseConfig,
      layers: [
        { role: 'context', widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2 },
        { role: 'mission', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.2 },
        { role: 'operational', widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.01 },
      ],
    });
    const est = estimate(cfg);
    expect(() => assertFeasible(cfg, est)).not.toThrow();
    expect(est.totalTiles).toBeGreaterThan(0);
  });
});
