/**
 * Memory and feasibility estimation (spec §15, §28).
 *
 * Runs *before* anything is allocated. Centimetre resolution is only tractable
 * when it is bounded — 50 m × 50 m at 0.01 m is 25 010 001 samples and 100 MB of
 * float32 for the heightfield alone, and a naive single mesh of that would be
 * 25 M vertices. The estimator makes that arithmetic visible and refuses
 * configurations that cannot work, rather than letting the process die halfway
 * through generation.
 */

import {
  ERROR_CODES,
  TerrainError,
  type GenerationProfile,
  type LayerConfig,
  type TerrainConfig,
} from '@lts/shared-types';

export interface LayerEstimate {
  role: string;
  widthSamples: number;
  heightSamples: number;
  samples: number;
  resolutionMeters: number;
  /** Float32 heightfield bytes. */
  heightBytes: number;
  /** Semantic + disturbance + elevation-source mask bytes. */
  maskBytes: number;
  /** Tiles this layer will be divided into. */
  tiles: number;
  tilesX: number;
  tilesZ: number;
  /** Vertex + index buffer bytes if every tile were meshed at full resolution. */
  meshBytes: number;
}

export interface TerrainEstimate {
  layers: LayerEstimate[];
  totalSamples: number;
  /** Heightfield + masks, the resident working set. */
  totalFieldBytes: number;
  /** Full-resolution mesh buffers for every tile, if all were realised at once. */
  totalMeshBytes: number;
  totalTiles: number;
  /** Rough on-disk size of the exported artifacts. */
  estimatedExportBytes: number;
  /** Expected number of rock instances. */
  estimatedRockInstances: number;
  /** Expected number of craters. */
  estimatedCraters: number;
  /** Human-readable notes, including anything that was clamped or is risky. */
  warnings: string[];
  profile: GenerationProfile;
  limitBytes: number;
}

const BYTES_PER_FLOAT32 = 4;
/** position(3) + normal(3) floats + uv(2) floats = 8 floats per vertex. */
const BYTES_PER_VERTEX = 8 * BYTES_PER_FLOAT32;
/** Two triangles per quad, 3 indices each, 4 bytes per index. */
const BYTES_PER_QUAD_INDICES = 6 * 4;

/** Samples along one axis for an extent at a given resolution, inclusive of both edges. */
export function samplesForExtent(extentMeters: number, resolutionMeters: number): number {
  return Math.floor(extentMeters / resolutionMeters) + 1;
}

export function estimateLayer(layer: LayerConfig, tileSizeSamples: number): LayerEstimate {
  const widthSamples = samplesForExtent(layer.widthMeters, layer.resolutionMeters);
  const heightSamples = samplesForExtent(layer.lengthMeters, layer.resolutionMeters);
  const samples = widthSamples * heightSamples;

  const tilesX = Math.max(1, Math.ceil((widthSamples - 1) / (tileSizeSamples - 1)));
  const tilesZ = Math.max(1, Math.ceil((heightSamples - 1) / (tileSizeSamples - 1)));

  // Masks: semantic (u8) + elevationSource (u8) + disturbance (f32).
  const maskBytes = samples * (1 + 1 + 4);
  const heightBytes = samples * BYTES_PER_FLOAT32;

  const quads = (widthSamples - 1) * (heightSamples - 1);
  const meshBytes = samples * BYTES_PER_VERTEX + quads * BYTES_PER_QUAD_INDICES;

  return {
    role: layer.role,
    widthSamples,
    heightSamples,
    samples,
    resolutionMeters: layer.resolutionMeters,
    heightBytes,
    maskBytes,
    tiles: tilesX * tilesZ,
    tilesX,
    tilesZ,
    meshBytes,
  };
}

/**
 * Expected crater count for one layer, used only for reporting.
 *
 * Must mirror the two bounds the generator actually applies, or the estimate is
 * meaningless: the pipeline raises the minimum diameter to four samples (a
 * crater smaller than that cannot be represented on the grid) and caps the
 * maximum at the source DEM's effective resolution (above which real craters
 * are already in the measured elevations). Ignoring both overstated a
 * three-tier polar site by more than two orders of magnitude.
 */
function estimateCraterCount(
  config: TerrainConfig,
  layer: LayerConfig,
  demEffectiveResolutionM?: number,
): number {
  if (!config.craters.enabled) return 0;
  const c = config.craters;
  const areaM2 = layer.widthMeters * layer.lengthMeters;

  const dMin = Math.max(c.minimumDiameterMeters, layer.resolutionMeters * 4);
  const dMax = Math.min(c.maximumDiameterMeters, demEffectiveResolutionM ?? Infinity);
  if (dMax <= dMin) return 0;

  if (c.model === 'power_law' && c.densityPerSquareKilometer !== undefined) {
    const n0 = c.densityPerSquareKilometer / 1e6;
    const slope = c.powerLawExponent - 1;
    const perM2 =
      n0 *
      (Math.pow(dMin / c.minimumDiameterMeters, -slope) -
        Math.pow(dMax / c.minimumDiameterMeters, -slope));
    return Math.round(Math.max(0, perM2 * areaM2));
  }

  // Equilibrium cap n(>=D) = 0.084 D^-2 per m² dominates at the small diameters
  // this generator synthesises (Xiao & Werner 2015). Counting between the two
  // bounds rather than above dMin alone.
  const perM2 = 0.084 * (Math.pow(dMin, -2) - Math.pow(dMax, -2));
  return Math.round(Math.max(0, perM2 * areaM2));
}

/**
 * Golombek rock number density, per m², integrated over [dMin, dMax].
 *
 * Duplicated from `@lts/lunar-features` rather than imported, because that
 * package depends on this one. `tests/lunar-features.test.ts` asserts the two
 * agree so they cannot drift apart.
 *
 * The integral matters: the common `F(D)/(πD²/4)` shortcut assumes every rock
 * above D has diameter exactly D, and over-counts a realistic polar population
 * by a factor of about six.
 */
function golombekCountPerM2(k: number, dMin: number, dMax: number, bins = 512): number {
  if (dMax <= dMin || k <= 0) return 0;
  const q = 1.79 + 0.152 / k;
  const logMin = Math.log(dMin);
  const logMax = Math.log(dMax);
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const a = Math.exp(logMin + ((logMax - logMin) * i) / bins);
    const b = Math.exp(logMin + ((logMax - logMin) * (i + 1)) / bins);
    const mid = Math.sqrt(a * b);
    total += ((4 * k * q * Math.exp(-q * mid)) / (Math.PI * mid * mid)) * (b - a);
  }
  return total;
}

/**
 * Expected rock count, used only for reporting.
 *
 * This is the **background expectation** — the calibrated Golombek population
 * over the area. The generator ADDS rim-excess rocks on top of it
 * ((enhancement − 1) × background density over each crater's rim annulus) and
 * rejects rocks on slopes above the configured limit; both depend on the
 * crater population and terrain that have not been generated yet, so the
 * realised count can exceed this figure substantially on cratered sites
 * (measured: ~2.2× on the shipped demo). An earlier revision mislabelled this
 * an "upper bound", which the demo itself falsified.
 */
function estimateRockCount(config: TerrainConfig, areaM2: number): number {
  if (!config.rocks.enabled) return 0;
  const r = config.rocks;
  if (r.model === 'power_law' && r.densityPerSquareMeter !== undefined) {
    return Math.round(r.densityPerSquareMeter * areaM2);
  }
  const perM2 = golombekCountPerM2(
    r.cumulativeFractionalAreaCovered,
    r.minimumDiameterMeters,
    r.maximumDiameterMeters,
  );
  return Math.round(perM2 * areaM2);
}

/** Estimate a whole configuration, without allocating anything. */
export function estimate(config: TerrainConfig): TerrainEstimate {
  const warnings: string[] = [];
  const layers = config.layers.map((l) => estimateLayer(l, config.tileSizeSamples));

  const totalSamples = layers.reduce((a, l) => a + l.samples, 0);
  const totalFieldBytes = layers.reduce((a, l) => a + l.heightBytes + l.maskBytes, 0);
  const totalMeshBytes = layers.reduce((a, l) => a + l.meshBytes, 0);
  const totalTiles = layers.reduce((a, l) => a + l.tiles, 0);

  let estimatedCraters = 0;
  let estimatedRockInstances = 0;
  for (const l of config.layers) {
    // The de-confliction cap applies only to layers the DEM actually grounds
    // (dem.applyToRoles); the pipeline caps per-layer via
    // sourceEffectiveResolutionMeters, so the estimate must match.
    const grounded =
      config.dem?.enabled === true && config.dem.applyToRoles.includes(l.role);
    estimatedCraters += estimateCraterCount(
      config,
      l,
      grounded ? config.dem!.effectiveResolutionMeters : undefined,
    );
  }
  // Rocks go on the finest layer only; placing them per layer would duplicate
  // the same boulder at three resolutions.
  const finest = [...config.layers].sort((a, b) => a.resolutionMeters - b.resolutionMeters)[0];
  if (finest) {
    estimatedRockInstances = estimateRockCount(config, finest.widthMeters * finest.lengthMeters);
  }

  // Exports: raw f32 heightmap + u8 semantic per layer, plus GLB tiles at
  // roughly half the in-memory mesh size after quantisation and compression.
  const estimatedExportBytes =
    layers.reduce((a, l) => a + l.samples * (4 + 1), 0) + Math.round(totalMeshBytes * 0.5);

  for (const l of layers) {
    if (l.samples > 25_000_000) {
      warnings.push(
        `${l.role} layer is ${l.widthSamples}x${l.heightSamples} = ${l.samples.toLocaleString()} samples ` +
          `(${(l.heightBytes / 1e6).toFixed(0)} MB of float32 heights); it will be split into ${l.tiles} tiles. ` +
          `A single full-resolution mesh of this layer is not recommended.`,
      );
    }
    if (l.resolutionMeters < 0.01) {
      warnings.push(
        `${l.role} layer resolution ${l.resolutionMeters} m is finer than the 0.01 m design floor; ` +
          `detail below 1 cm is not physically grounded in any available data.`,
      );
    }
  }

  const est: TerrainEstimate = {
    layers,
    totalSamples,
    totalFieldBytes,
    totalMeshBytes,
    totalTiles,
    estimatedExportBytes,
    estimatedRockInstances,
    estimatedCraters,
    warnings,
    profile: config.limits.profile,
    limitBytes: config.limits.maxBytes,
  };
  return est;
}

/**
 * Reject an infeasible configuration (spec §28).
 *
 * The hard byte ceiling applies in **every** profile, including `unrestricted`
 * — that profile lifts the advisory limits, not the ceiling, because a process
 * that exhausts memory takes the whole sidecar down with it.
 */
export function assertFeasible(config: TerrainConfig, est: TerrainEstimate): void {
  const { limits } = config;

  if (est.totalFieldBytes > limits.maxBytes) {
    throw new TerrainError(
      ERROR_CODES.MEMORY_LIMIT,
      'The requested terrain exceeds the configured memory limit.',
      {
        estimatedBytes: est.totalFieldBytes,
        limitBytes: limits.maxBytes,
        profile: limits.profile,
        perLayer: est.layers.map((l) => ({
          role: l.role,
          samples: l.samples,
          bytes: l.heightBytes + l.maskBytes,
        })),
      },
    );
  }

  for (const l of est.layers) {
    if (l.samples > limits.maxSamplesPerLayer) {
      throw new TerrainError(
        ERROR_CODES.SAMPLE_LIMIT,
        `Layer '${l.role}' requests ${l.samples.toLocaleString()} samples, above the per-layer limit.`,
        { role: l.role, samples: l.samples, limit: limits.maxSamplesPerLayer },
      );
    }
  }

  if (est.totalTiles > limits.maxTiles) {
    throw new TerrainError(
      ERROR_CODES.TILE_LIMIT,
      `The configuration produces ${est.totalTiles} tiles, above the limit.`,
      { tiles: est.totalTiles, limit: limits.maxTiles },
    );
  }

  // Nested-layer sanity: a finer layer must sit inside a coarser one (spec §28).
  const sorted = [...config.layers].sort((a, b) => b.resolutionMeters - a.resolutionMeters);
  for (let i = 1; i < sorted.length; i++) {
    const fine = sorted[i];
    const coarse = sorted[i - 1];
    const fineMinX = fine.centerXMeters - fine.widthMeters / 2;
    const fineMaxX = fine.centerXMeters + fine.widthMeters / 2;
    const fineMinZ = fine.centerZMeters - fine.lengthMeters / 2;
    const fineMaxZ = fine.centerZMeters + fine.lengthMeters / 2;
    const coarseMinX = coarse.centerXMeters - coarse.widthMeters / 2;
    const coarseMaxX = coarse.centerXMeters + coarse.widthMeters / 2;
    const coarseMinZ = coarse.centerZMeters - coarse.lengthMeters / 2;
    const coarseMaxZ = coarse.centerZMeters + coarse.lengthMeters / 2;
    const contained =
      fineMinX >= coarseMinX - 1e-9 &&
      fineMaxX <= coarseMaxX + 1e-9 &&
      fineMinZ >= coarseMinZ - 1e-9 &&
      fineMaxZ <= coarseMaxZ + 1e-9;
    if (!contained) {
      throw new TerrainError(
        ERROR_CODES.LAYER_BOUNDS,
        `The '${fine.role}' layer is not contained within the coarser '${coarse.role}' layer.`,
        {
          fine: { role: fine.role, minX: fineMinX, maxX: fineMaxX, minZ: fineMinZ, maxZ: fineMaxZ },
          coarse: {
            role: coarse.role,
            minX: coarseMinX,
            maxX: coarseMaxX,
            minZ: coarseMinZ,
            maxZ: coarseMaxZ,
          },
        },
      );
    }
  }
}

/** A human-readable estimate report (spec §15's worked example). */
export function formatEstimate(est: TerrainEstimate): string {
  const lines: string[] = [];
  for (const l of est.layers) {
    lines.push(
      `${l.role.padEnd(12)} ${l.widthSamples} x ${l.heightSamples} @ ${l.resolutionMeters} m/sample`,
    );
    lines.push(
      `${''.padEnd(12)} ${l.samples.toLocaleString()} samples, ` +
        `${(l.heightBytes / 1e6).toFixed(1)} MB heights, ` +
        `${(l.maskBytes / 1e6).toFixed(1)} MB masks, ` +
        `${l.tilesX}x${l.tilesZ} = ${l.tiles} tiles`,
    );
  }
  lines.push('');
  lines.push(`total samples      ${est.totalSamples.toLocaleString()}`);
  lines.push(`resident fields    ${(est.totalFieldBytes / 1e6).toFixed(1)} MB`);
  lines.push(`full mesh buffers  ${(est.totalMeshBytes / 1e6).toFixed(1)} MB`);
  lines.push(`estimated export   ${(est.estimatedExportBytes / 1e6).toFixed(1)} MB`);
  lines.push(`tiles              ${est.totalTiles}`);
  lines.push(`craters (expected) ${est.estimatedCraters.toLocaleString()}`);
  lines.push(`rocks (background)  ${est.estimatedRockInstances.toLocaleString()}  (rim excess and slope rejection depend on the generated terrain)`);
  lines.push(`profile            ${est.profile} (hard ceiling ${(est.limitBytes / 1e6).toFixed(0)} MB)`);
  if (est.warnings.length) {
    lines.push('');
    for (const w of est.warnings) lines.push(`WARNING: ${w}`);
  }
  return lines.join('\n');
}
