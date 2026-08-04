/**
 * The terrain generation pipeline (spec §6).
 *
 *   base elevation (real DEM where available)
 *   → regional slope
 *   → multiscale roughness, bounded below the DEM's effective resolution
 *   → crater population + stamping
 *   → rock population
 *   → regolith microrelief
 *   → semantic classification
 *   → solar geometry and horizon
 *   → provenance
 *
 * Lives in its own package because it composes `terrain-core`,
 * `lunar-features`, `lunar-dem` and `lunar-solar`, and `lunar-features` already
 * depends on `terrain-core` — putting the pipeline in the core would be a cycle.
 */

import {
  ELEVATION_SOURCES,
  SEMANTIC_CLASSES,
  TerrainError,
  ERROR_CODES,
  centeredBounds,
  defaultCoordinateSystem,
  recomputeVerticalBounds,
  type ElevationProvenance,
  type TerrainConfig,
  type TerrainDataset,
  type TerrainFeature,
  type TerrainLayer,
  type DataSource,
  type LiteratureModel,
  type SolarConditions,
} from '@lts/shared-types';
import {
  PerlinNoise2D,
  SeedTree,
  assertFeasible,
  compileFractal,
  compileStack,
  estimate,
  evaluateCompiledStack,
  fbmCompiled,
  samplesForExtent,
  type ProceduralLayerSpec,
} from '@lts/terrain-core';
import {
  buildLocalFrame,
  demAvailable,
  fillNoData,
  openDemRaster,
  resampleDemToLocal,
  type DemRaster,
} from '@lts/lunar-dem';
import {
  freshRimHeight,
  markRockSemantics,
  sampleCraterPopulation,
  sampleRockPopulation,
  stampCrater,
  toCraterFeature,
  toRockFeature,
} from '@lts/lunar-features';
import {
  horizonProfile,
  parseInstant,
  solarPositionAtSite,
  solarPositionAtSiteDE,
  loadDeKernels,
  samplerFromArray,
  SpiceKernelError,
  DEFAULT_KERNEL_DIRECTORY,
  DE_SPK_FILENAME,
  DE_PCK_FILENAME,
} from '@lts/lunar-solar';
import { createHash } from 'node:crypto';
import {
  PARALLEL_THRESHOLD_SAMPLES,
  ReliefWorkerPool,
  defaultWorkerThreads,
  runBaseReliefParallel,
  runRegolithParallel,
  type WireStackLayer,
} from './workerPool.js';

/** Index of 'measured_plus_synthetic' in ELEVATION_SOURCES, hoisted once. */
const MEASURED_PLUS_SYNTHETIC_IDX = ELEVATION_SOURCES.indexOf('measured_plus_synthetic');

export const GENERATOR_NAME = 'lunar-terrain-sidecar';
export const GENERATOR_VERSION = '0.1.0';

/** Progress callback (spec §14, §16). */
export type ProgressFn = (stage: string, progress: number, detail?: string) => void;

export interface GenerateOptions {
  onProgress?: ProgressFn;
  /** Abort cooperatively between stages. */
  signal?: { aborted: boolean };
  /**
   * Worker threads for the base_relief and regolith row-band hot loops
   * (spec §14). `0` or `1` selects the fully synchronous code path — the
   * reference implementation (spec §20). Defaults to min(cores − 2, 8).
   * Output bits are identical either way; layers under
   * `PARALLEL_THRESHOLD_SAMPLES` stay synchronous regardless.
   */
  workerThreads?: number;
}

export interface GenerateResult {
  dataset: TerrainDataset;
  /** Solar conditions at the configured epoch. */
  solar: SolarConditions;
  /** Skyline of the site, degrees per azimuth bin, or undefined if not computed. */
  horizon?: Float32Array;
  /** Free-text notes worth surfacing to the operator. */
  notes: string[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 of the canonicalised configuration (spec §20). */
export function configurationHash(config: TerrainConfig): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

function checkAborted(opts: GenerateOptions): void {
  if (opts.signal?.aborted) {
    throw new TerrainError(ERROR_CODES.CANCELLED, 'Generation was cancelled.');
  }
}

/** Generate a complete terrain dataset from a validated configuration. */
export async function generateTerrain(
  config: TerrainConfig,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  // Resolve the worker policy once (spec §14). 0 or 1 → the synchronous
  // reference path (spec §20); otherwise a pool is created lazily on the
  // first layer large enough to dispatch and always torn down before this
  // call returns, so no worker thread ever outlives a generation.
  const workerThreads = Math.max(1, Math.floor(opts.workerThreads ?? defaultWorkerThreads()));
  const holder: { pool: ReliefWorkerPool | null } = { pool: null };
  const getPool =
    workerThreads > 1 ? () => (holder.pool ??= new ReliefWorkerPool(workerThreads)) : null;
  try {
    return await generateTerrainImpl(config, opts, getPool);
  } finally {
    if (holder.pool) await holder.pool.destroy();
  }
}

async function generateTerrainImpl(
  config: TerrainConfig,
  opts: GenerateOptions,
  getPool: (() => ReliefWorkerPool) | null,
): Promise<GenerateResult> {
  const progress = opts.onProgress ?? (() => {});
  const notes: string[] = [];
  const literatureModels: LiteratureModel[] = [];
  const dataSources: DataSource[] = [];
  const syntheticHeuristics: string[] = [];
  const limitations: string[] = [];

  progress('validating', 0.0);
  const est = estimate(config);
  assertFeasible(config, est);
  for (const w of est.warnings) notes.push(w);

  const seeds = new SeedTree(config.seed);

  // ---------------------------------------------------------------- layers --
  progress('allocating', 0.02);
  const layers: TerrainLayer[] = config.layers.map((l, i) => {
    const widthSamples = samplesForExtent(l.widthMeters, l.resolutionMeters);
    const heightSamples = samplesForExtent(l.lengthMeters, l.resolutionMeters);
    // Bounds are derived from the SAMPLE GRID, not the requested extent. When
    // widthMeters is not a multiple of the resolution (50 m at 0.3 m), the
    // grid spans (samples-1)*res < widthMeters; declaring the requested extent
    // anyway created a phantom strip inside the bounds with no data — height
    // queries there returned NaN and the exporter's own spacing check failed
    // on every export of such a configuration.
    const spanX = (widthSamples - 1) * l.resolutionMeters;
    const spanZ = (heightSamples - 1) * l.resolutionMeters;
    if (Math.abs(spanX - l.widthMeters) > 1e-9 || Math.abs(spanZ - l.lengthMeters) > 1e-9) {
      notes.push(
        `${l.role} layer extent snapped to the sample grid: requested ` +
          `${l.widthMeters}×${l.lengthMeters} m, realised ${spanX.toFixed(6)}×${spanZ.toFixed(6)} m ` +
          `(${l.resolutionMeters} m/sample does not divide the requested extent).`,
      );
    }
    const bounds = centeredBounds(spanX, spanZ);
    bounds.minX += l.centerXMeters;
    bounds.maxX += l.centerXMeters;
    bounds.minZ += l.centerZMeters;
    bounds.maxZ += l.centerZMeters;
    return {
      id: `${l.role}-${i}`,
      role: l.role,
      bounds,
      horizontalResolutionMeters: l.resolutionMeters,
      verticalQuantizationMeters: l.verticalQuantizationMeters,
      widthSamples,
      heightSamples,
      heightData: new Float32Array(widthSamples * heightSamples),
      masks: {
        semantic: new Uint8Array(widthSamples * heightSamples),
        elevationSource: new Uint8Array(widthSamples * heightSamples),
      },
      elevationProvenance: 'synthetic' as ElevationProvenance,
    };
  });

  const frame = buildLocalFrame(config.site.latitudeDeg, config.site.longitudeDeg);
  let datumElevationM = config.site.datumElevationM;

  // ------------------------------------------------------------- real DEM --
  let raster: DemRaster | undefined;
  if (config.dem?.enabled) {
    checkAborted(opts);
    progress('ingesting_dem', 0.05, config.dem.path);
    if (!demAvailable(config.dem.path)) {
      throw new TerrainError(
        ERROR_CODES.DEM_UNAVAILABLE,
        `The configured DEM is not readable. No synthetic fallback exists; fix the path or ` +
          `disable dem.enabled to generate a fully synthetic site.`,
        { path: config.dem.path },
      );
    }
    raster = await openDemRaster(config.dem.path);
    dataSources.push({
      id: raster.provenance.id,
      description: raster.provenance.description,
      path: raster.provenance.path,
      citation: raster.provenance.citation,
      resolutionMeters: raster.provenance.resolutionMeters,
      effectiveResolutionMeters:
        config.dem.effectiveResolutionMeters ?? raster.provenance.effectiveResolutionMeters,
    });

    for (const layer of layers) {
      if (!config.dem.applyToRoles.includes(layer.role)) continue;
      const res = resampleDemToLocal(raster, frame, {
        minX: layer.bounds.minX,
        minZ: layer.bounds.minZ,
        resolutionMeters: layer.horizontalResolutionMeters,
        widthSamples: layer.widthSamples,
        heightSamples: layer.heightSamples,
      });
      if (res.noDataFraction > 0) {
        const { filled } = fillNoData(res.data, layer.widthSamples, layer.heightSamples);
        notes.push(
          `${layer.id}: ${(res.noDataFraction * 100).toFixed(2)}% of samples were no-data in ` +
            `${raster.provenance.id}; ${filled} filled by neighbour averaging.`,
        );
      }
      layer.heightData.set(res.data);
      layer.sourceEffectiveResolutionMeters =
        config.dem.effectiveResolutionMeters ?? raster.provenance.effectiveResolutionMeters;
      layer.elevationProvenance = 'measured_dem';
      layer.masks.elevationSource?.fill(ELEVATION_SOURCES.indexOf('measured'));
      datumElevationM = res.datumElevationM;

      if (res.sourcePixelsPerSample < 1) {
        notes.push(
          `${layer.id} samples at ${layer.horizontalResolutionMeters} m from a ` +
            `${raster.resolutionMeters} m product: ` +
            `${(1 / res.sourcePixelsPerSample).toFixed(1)}x oversampled. Elevations between ` +
            `source pixels are interpolated, not measured.`,
        );
      }
    }
  } else {
    limitations.push(
      'No measured DEM was used; all elevations in this dataset are procedurally synthesised.',
    );
  }

  // ------------------------------------------------- slope and roughness --
  checkAborted(opts);
  progress('base_relief', 0.2);

  const stack: ProceduralLayerSpec[] = config.proceduralStack.map((s) => ({
    id: s.id,
    model: s.model,
    enabled: s.enabled,
    fractal: s.fractal,
    warpStrengthM: s.warpStrengthM,
    warpFrequency: s.warpFrequency,
  }));
  const noises = new Map<string, PerlinNoise2D>();
  const warpNoises = new Map<string, PerlinNoise2D>();
  for (const s of stack) {
    noises.set(s.id, new PerlinNoise2D(seeds.seed(`procedural:${s.id}`)));
    warpNoises.set(s.id, new PerlinNoise2D(seeds.seed(`procedural-warp:${s.id}`)));
  }

  const slopeRad = (config.regionalSlopeDeg * Math.PI) / 180;
  // Azimuth is clockwise from north, north = -Z (ADR 0002).
  const slopeAz = (config.regionalSlopeAzimuthDeg * Math.PI) / 180;
  const slopeDirX = Math.sin(slopeAz);
  const slopeDirZ = -Math.cos(slopeAz);
  const tanSlope = Math.tan(slopeRad);

  // Stage progress in rows, accumulated monotonically across layers and
  // emitted from the main thread as parallel bands complete (spec §14, §16).
  const baseReliefTotalRows = layers.reduce((a, l) => a + l.heightSamples, 0);
  let baseReliefDoneRows = 0;
  const emitBaseReliefProgress = () =>
    progress('base_relief', 0.2 + 0.15 * (baseReliefDoneRows / baseReliefTotalRows));

  for (const layer of layers) {
    const res = layer.horizontalResolutionMeters;
    // A layer grounded in a real DEM keeps its measured relief; procedural
    // detail is added only *below* what the source can resolve, so the two
    // never compete to represent the same wavelength.
    const eff = layer.sourceEffectiveResolutionMeters;
    const activeStack = eff
      ? stack.filter((s) => 1 / s.fractal.frequency < eff)
      : stack;
    if (eff && activeStack.length < stack.length) {
      notes.push(
        `${layer.id}: ${stack.length - activeStack.length} procedural layer(s) suppressed — ` +
          `their wavelength exceeds the source DEM's ${eff.toFixed(1)} m effective resolution, ` +
          `where the measured elevations are already authoritative.`,
      );
    }

    // Per-layer invariants, hoisted out of the per-sample loop. The compiled
    // stack resolves the Map lookups, model dispatch and octave ladders once;
    // per sample it performs the identical IEEE-754 operation sequence
    // `evaluateStack` did, so the output bits are unchanged (see the
    // bit-exactness contract in terrain-core/src/noise.ts). A compiled stack
    // holds only the ENABLED layers; when it is empty `evaluateStack` would
    // have contributed an exact 0, and `h += 0` never flips the `h !== 0`
    // write guard (−0 fails it just as +0 does), so skipping the call is
    // observationally identical.
    const compiled = compileStack(activeStack, noises, warpNoises);
    const minX = layer.bounds.minX;
    const minZ = layer.bounds.minZ;
    const widthSamples = layer.widthSamples;
    const heightData = layer.heightData;
    const elevationSource = layer.masks.elevationSource;
    const measured = layer.elevationProvenance === 'measured_dem';
    const measuredPlusSynthetic = ELEVATION_SOURCES.indexOf('measured_plus_synthetic');

    const totalSamples = layer.widthSamples * layer.heightSamples;
    if (getPool && totalSamples >= PARALLEL_THRESHOLD_SAMPLES) {
      // Worker-thread band dispatch (spec §14). Every sample of this loop is
      // a pure function of (x, z), the seeds and the pre-stage value at its
      // own index, so row bands are independent; the workers execute the
      // byte-for-byte same per-sample float sequence as the reference loop
      // below (reliefWorker.ts) against the same seeds, and the result bits
      // are identical. Race-freedom argument: workerPool.ts.
      const wireStack: WireStackLayer[] = activeStack.map((s) => ({
        id: s.id,
        model: s.model,
        enabled: s.enabled,
        fractal: s.fractal,
        warpStrengthM: s.warpStrengthM,
        warpFrequency: s.warpFrequency,
        // Seed channels come from the SAME SeedTree the reference path uses
        // (already derived above), so the provenance manifest is unchanged.
        noiseSeed: seeds.seed(`procedural:${s.id}`),
        warpSeed: seeds.seed(`procedural-warp:${s.id}`),
      }));
      await runBaseReliefParallel(
        getPool(),
        {
          minX,
          minZ,
          res,
          widthSamples,
          heightSamples: layer.heightSamples,
          tanSlope,
          slopeDirX,
          slopeDirZ,
          stack: wireStack,
          measured,
          measuredPlusSynthetic,
        },
        heightData,
        measured ? elevationSource! : null,
        (rows) => {
          baseReliefDoneRows += rows;
          emitBaseReliefProgress();
        },
      );
    } else {
      // Synchronous reference implementation (spec §20) — byte-for-byte the
      // authority the worker path is measured against.
      for (let row = 0; row < layer.heightSamples; row++) {
        const z = minZ + row * res;
        const rowBase = row * widthSamples;
        for (let col = 0; col < widthSamples; col++) {
          const x = minX + col * res;
          let h = 0;
          if (tanSlope !== 0) h -= (x * slopeDirX + z * slopeDirZ) * tanSlope;
          if (compiled.length > 0) h += evaluateCompiledStack(compiled, x, z);
          if (h !== 0) {
            const i = rowBase + col;
            heightData[i] += h;
            if (measured) {
              elevationSource![i] = measuredPlusSynthetic;
            }
          }
        }
      }
      baseReliefDoneRows += layer.heightSamples;
      emitBaseReliefProgress();
    }
    if (layer.elevationProvenance === 'measured_dem' && activeStack.length > 0) {
      layer.elevationProvenance = 'measured_dem_plus_synthetic_subresolution';
    }
  }

  // ------------------------------------------------------------- craters --
  const features: TerrainFeature[] = [];
  if (config.craters.enabled) {
    checkAborted(opts);
    progress('generating_craters', 0.35);
    literatureModels.push(
      {
        id: 'neukum_production',
        description: 'Crater production function and lunar chronology',
        citation:
          'Neukum, Ivanov & Hartmann (2001), Space Science Reviews 96:55-86.',
      },
      {
        id: 'xiao_werner_equilibrium',
        description: 'Empirical crater equilibrium (saturation) density n(>=D) = 0.084 D^-2',
        citation: 'Xiao & Werner (2015), JGR Planets 120:2277-2292.',
      },
      {
        id: 'pike_morphometry',
        description: 'Simple-crater depth/diameter 0.2 and rim height 0.036 D^1.014 (km)',
        citation: 'Pike (1977), in Impact and Explosion Cratering, 489-509.',
      },
      {
        id: 'stopar_shallowing',
        description: 'Shallowing of depth/diameter below ~400 m diameter',
        citation: 'Stopar et al. (2017), Icarus 298:34-48.',
      },
      {
        id: 'mcgetchin_ejecta',
        description: 'Ejecta blanket thickness t(r) = 0.14 R^0.74 (r/R)^-3',
        citation: 'McGetchin, Settle & Head (1973), EPSL 20:226-236.',
      },
    );

    // Craters are stamped into the finest layer covering each position; here
    // they are applied per layer so every tier stays self-consistent.
    for (const layer of layers) {
      const rng = seeds.rng(`crater:${layer.id}`);
      const { craters, notes: cn } = sampleCraterPopulation(rng, {
        minX: layer.bounds.minX,
        minZ: layer.bounds.minZ,
        maxX: layer.bounds.maxX,
        maxZ: layer.bounds.maxZ,
        minDiameterM: Math.max(config.craters.minimumDiameterMeters, layer.horizontalResolutionMeters * 4),
        maxDiameterM: config.craters.maximumDiameterMeters,
        model: config.craters.model,
        surfaceAgeGa: config.craters.surfaceAgeGyr,
        densityPerKm2: config.craters.densityPerSquareKilometer,
        powerLawAnchorDiameterM: config.craters.minimumDiameterMeters,
        powerLawExponent: config.craters.powerLawExponent,
        demEffectiveResolutionM: layer.sourceEffectiveResolutionMeters,
        meanDegradation: config.craters.meanDegradation,
        degradationSpread: config.craters.degradationSpread,
        ellipticalFraction: config.craters.ellipticalFraction,
        exclusionRadiusFactor: config.craters.exclusionRadiusFactor,
        clustering: config.craters.clustering,
      });
      for (const n of cn) notes.push(`${layer.id}: ${n}`);

      for (const c of craters) {
        stampCrater(
          layer,
          c,
          layer.masks.semantic,
          layer.elevationProvenance === 'synthetic' ? undefined : layer.masks.elevationSource,
          MEASURED_PLUS_SYNTHETIC_IDX,
        );
        features.push(toCraterFeature(c, [layer.id], 'production_csfd', `crater:${layer.id}`));
      }

      // Explicitly authored craters, always placed.
      for (let i = 0; i < config.craters.authored.length; i++) {
        const a = config.craters.authored[i];
        const depth = a.depthMeters ?? a.diameterMeters * 0.15;
        const c = {
          id: `crater-authored-${layer.id}-${i}`,
          centerXMeters: a.centerXMeters,
          centerZMeters: a.centerZMeters,
          diameterMeters: a.diameterMeters,
          depthMeters: depth * (1 - a.degradation),
          rimHeightMeters: freshRimHeight(a.diameterMeters) * (1 - a.degradation) ** 2,
          rimWidthMeters: a.diameterMeters * 0.1,
          floorRadiusRatio: 0.1 + 0.5 * a.degradation,
          ellipticity: a.ellipticity,
          rotationRadians: (a.rotationDegrees * Math.PI) / 180,
          degradation: a.degradation,
          ejectaExtentMeters: a.diameterMeters * 1.6,
          ejectaAmplitudeMeters: a.diameterMeters * 0.01 * (1 - a.degradation),
          centralPeak: false,
        };
        stampCrater(
          layer,
          c,
          layer.masks.semantic,
          layer.elevationProvenance === 'synthetic' ? undefined : layer.masks.elevationSource,
          MEASURED_PLUS_SYNTHETIC_IDX,
        );
        features.push(toCraterFeature(c, [layer.id], 'authored', 'authored'));
      }
    }
  }

  // ------------------------------------------------------------ regolith --
  if (config.regolith.enabled) {
    checkAborted(opts);
    progress('regolith_microrelief', 0.55);
    const regolithLayers = layers.filter(
      (l) => l.horizontalResolutionMeters <= config.regolith.maximumResolutionMeters,
    );
    // Stage progress in rows, monotonic across layers (spec §14, §16).
    const regolithTotalRows = regolithLayers.reduce((a, l) => a + l.heightSamples, 0);
    let regolithDoneRows = 0;
    const emitRegolithProgress = () =>
      progress(
        'regolith_microrelief',
        0.55 + 0.1 * (regolithTotalRows > 0 ? regolithDoneRows / regolithTotalRows : 1),
      );
    for (const layer of regolithLayers) {
      const regolithSeed = seeds.seed(`regolith:${layer.id}`);
      const p = {
        octaves: 4,
        lacunarity: 2.0,
        persistence: 0.5,
        frequency: 1 / config.regolith.microreliefWavelengthM,
        amplitude: config.regolith.microreliefAmplitudeM,
        anisotropy: 1,
      };
      const res = layer.horizontalResolutionMeters;
      const minX = layer.bounds.minX;
      const minZ = layer.bounds.minZ;
      const widthSamples = layer.widthSamples;
      const heightData = layer.heightData;
      const totalSamples = layer.widthSamples * layer.heightSamples;
      if (getPool && totalSamples >= PARALLEL_THRESHOLD_SAMPLES) {
        // Worker-thread band dispatch — same independence and bit-exactness
        // argument as base relief (reliefWorker.ts, workerPool.ts). The seed
        // is derived through the same SeedTree channel as the reference
        // path, so the provenance manifest is unchanged.
        await runRegolithParallel(
          getPool(),
          {
            minX,
            minZ,
            res,
            widthSamples,
            heightSamples: layer.heightSamples,
            fractal: p,
            noiseSeed: regolithSeed,
          },
          heightData,
          (rows) => {
            regolithDoneRows += rows;
            emitRegolithProgress();
          },
        );
      } else {
        // Synchronous reference implementation (spec §20).
        const noise = new PerlinNoise2D(regolithSeed);
        // Same hoist as base relief: the octave ladder of `p` is invariant,
        // so it is compiled once; `fbmCompiled` is bit-identical to `fbm`.
        const compiled = compileFractal(p);
        for (let row = 0; row < layer.heightSamples; row++) {
          const z = minZ + row * res;
          const rowBase = row * widthSamples;
          for (let col = 0; col < widthSamples; col++) {
            const x = minX + col * res;
            heightData[rowBase + col] += fbmCompiled(noise, x, z, compiled);
          }
        }
        regolithDoneRows += layer.heightSamples;
        emitRegolithProgress();
      }
    }
    syntheticHeuristics.push(
      'Regolith microrelief below the source DEM resolution is procedurally synthesised. ' +
        'No measurement constrains lunar surface roughness at centimetre scale at these sites; ' +
        'it is plausible texture, not observed topography.',
    );
  }

  for (const layer of layers) recomputeVerticalBounds(layer);

  // --------------------------------------------------------------- rocks --
  if (config.rocks.enabled) {
    checkAborted(opts);
    progress('generating_rocks', 0.65);
    literatureModels.push({
      id: 'golombek_rock_sfd',
      description: 'Exponential rock size-frequency distribution F(D) = k exp(-q D)',
      citation:
        'Golombek & Rapp (1997), JGR 102:4117-4129; Golombek et al. (2003), JGR 108:8086.',
    });

    // Rocks go on the finest layer only; placing them per-layer would
    // duplicate the same boulder at three resolutions.
    const finest = layers.reduce((a, b) =>
      a.horizontalResolutionMeters <= b.horizontalResolutionMeters ? a : b,
    );
    const craterRims = features
      .filter((f): f is Extract<TerrainFeature, { kind: 'crater' }> => f.kind === 'crater')
      .filter((f) => f.appliedToLayers.includes(finest.id))
      .map((f) => ({
        x: f.parameters.centerXMeters,
        z: f.parameters.centerZMeters,
        radiusM: f.parameters.diameterMeters / 2,
      }));

    const rng = seeds.rng('rock');
    const { rocks, notes: rn } = sampleRockPopulation(rng, finest, {
      minX: finest.bounds.minX,
      minZ: finest.bounds.minZ,
      maxX: finest.bounds.maxX,
      maxZ: finest.bounds.maxZ,
      model: config.rocks.model,
      areaCoverage: config.rocks.cumulativeFractionalAreaCovered,
      minDiameterM: config.rocks.minimumDiameterMeters,
      maxDiameterM: config.rocks.maximumDiameterMeters,
      physicalMinDiameterM: config.rocks.physicalMinimumDiameterMeters,
      densityPerM2: config.rocks.densityPerSquareMeter,
      powerLawExponent: config.rocks.powerLawExponent,
      meanBuriedFraction: config.rocks.meanBuriedFraction,
      angularity: config.rocks.angularity,
      maxSlopeDeg: config.rocks.maximumSlopeDeg,
      craterRimEnhancement: config.rocks.craterRimEnhancement,
      craterRims,
      material: 'lunar_breccia',
    });
    for (const n of rn) notes.push(n);

    if (finest.masks.semantic) markRockSemantics(finest, rocks, finest.masks.semantic);
    for (const r of rocks) {
      features.push(toRockFeature(r, finest, [finest.id], 'lunar_breccia', 'rock'));
    }
  }

  // --------------------------------------------------- semantic defaults --
  checkAborted(opts);
  progress('classifying', 0.8);
  const flat = SEMANTIC_CLASSES.indexOf('flat_regolith');
  const rough = SEMANTIC_CLASSES.indexOf('rough_regolith');
  const unsafe = SEMANTIC_CLASSES.indexOf('unsafe_slope');
  for (const layer of layers) {
    const sem = layer.masks.semantic;
    if (!sem) continue;
    const res = layer.horizontalResolutionMeters;
    for (let row = 1; row < layer.heightSamples - 1; row++) {
      for (let col = 1; col < layer.widthSamples - 1; col++) {
        const i = row * layer.widthSamples + col;
        if (sem[i] !== 0) continue; // already classified by a feature
        const dzdx =
          (layer.heightData[i + 1] - layer.heightData[i - 1]) / (2 * res);
        const dzdz =
          (layer.heightData[i + layer.widthSamples] - layer.heightData[i - layer.widthSamples]) /
          (2 * res);
        const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdz)) * 180) / Math.PI;
        sem[i] = slopeDeg > 25 ? unsafe : slopeDeg > 8 ? rough : flat;
      }
    }
  }

  // ----------------------------------------------------------- solar geom --
  checkAborted(opts);
  progress('solar_geometry', 0.9);
  let solar: SolarConditions;
  if (config.solar.mode === 'ephemeris') {
    const epoch = parseInstant(config.solar.epochUtc!);
    const sp = solarPositionAtSite(epoch, config.site.latitudeDeg, config.site.longitudeDeg);
    solar = {
      epochUtc: epoch.toISOString(),
      elevationDeg: sp.elevationDeg,
      azimuthDeg: sp.azimuthDeg,
      angularRadiusDeg: sp.angularRadiusDeg,
      subSolarLatitudeDeg: sp.subSolar.latitudeDeg,
      subSolarLongitudeDeg: sp.subSolar.longitudeDeg,
      model: 'ephemeris',
    };
    limitations.push(
      'Solar angles come from Meeus solar/lunar series with the IAU/WGCCRE lunar rotation ' +
        'model. The limiting error is the IAU realisation of the Mean Earth frame, roughly ' +
        '0.01-0.03 deg, which propagates about 1:1 into solar elevation. At a lunar pole, ' +
        'where elevation spans only +/-1.54 deg, that is a few percent of the range.',
    );
  } else if (config.solar.mode === 'ephemeris_de') {
    // Kernel-driven solar geometry. Missing kernels are a structured failure,
    // NEVER a silent fallback to the analytic chain — a dataset claiming
    // DE440 accuracy while carrying Meeus/IAU numbers would be a provenance
    // lie of exactly the kind this project exists to prevent.
    const kernelDirectory = config.solar.kernelDirectory ?? DEFAULT_KERNEL_DIRECTORY;
    let kernels;
    try {
      kernels = loadDeKernels(kernelDirectory);
    } catch (e) {
      if (e instanceof SpiceKernelError) {
        throw new TerrainError(
          ERROR_CODES.SPICE_KERNELS_UNAVAILABLE,
          `Solar mode 'ephemeris_de' requires the JPL DE440 kernels and they could not be ` +
            `loaded: ${e.message} There is no fallback to the analytic chain; fix ` +
            `solar.kernelDirectory or switch solar.mode to 'ephemeris'.`,
          { kernelDirectory, cause: e.toJSON() },
        );
      }
      throw e;
    }
    const epoch = parseInstant(config.solar.epochUtc!);
    const sp = solarPositionAtSiteDE(epoch, config.site.latitudeDeg, config.site.longitudeDeg, kernels);
    solar = {
      epochUtc: epoch.toISOString(),
      elevationDeg: sp.elevationDeg,
      azimuthDeg: sp.azimuthDeg,
      angularRadiusDeg: sp.angularRadiusDeg,
      subSolarLatitudeDeg: sp.subSolar.latitudeDeg,
      subSolarLongitudeDeg: sp.subSolar.longitudeDeg,
      model: 'ephemeris_de',
    };
    // The kernels are cited as literature models rather than DataSource
    // entries: DataSource requires a ground-sample resolutionMeters, which
    // has no honest value for an ephemeris, and inventing one is exactly
    // what the provenance system forbids.
    literatureModels.push({
      id: 'jpl_de440',
      description:
        'JPL DE440 planetary ephemeris and integrated lunar libration (SPK + binary PCK ' +
        'Type 2 Chebyshev), with the fixed PA->ME421 rotation from moon_de440_250416.tf',
      citation:
        'Park, Folkner, Williams & Boggs (2021), The JPL Planetary and Lunar Ephemerides ' +
        'DE440 and DE441, The Astronomical Journal 161:105.',
    });
    limitations.push(
      `Solar angles come from the JPL DE440 kernels (${kernelDirectory}/${DE_SPK_FILENAME} + ` +
        `${kernelDirectory}/${DE_PCK_FILENAME}: SPK positions, integrated lunar libration, ` +
        'fixed PA->ME rotation). Residual orientation error is the ME421-vs-current-ME ' +
        'realisation difference, <= 3.1e-7 rad (~53 cm on the surface) over 2000-2040 per ' +
        'the frames kernel, plus the TT~TDB approximation (< 3e-7 deg). This mode replaces ' +
        'the 0.01-0.03 deg IAU-frame floor of the analytic chain.',
    );
  } else {
    solar = {
      epochUtc: config.solar.epochUtc ?? new Date(0).toISOString(),
      elevationDeg: config.solar.elevationDeg!,
      azimuthDeg: config.solar.azimuthDeg!,
      angularRadiusDeg: 0.266,
      subSolarLatitudeDeg: NaN,
      subSolarLongitudeDeg: NaN,
      model: 'manual_override',
    };
    limitations.push(
      'Solar angles were set MANUALLY and do not correspond to any real epoch. They may be ' +
        'physically unreachable at this site: at a lunar pole the Sun never exceeds ~1.54 deg ' +
        'elevation.',
    );
    if (Math.abs(config.site.latitudeDeg) > 85 && config.solar.elevationDeg! > 2.0) {
      notes.push(
        `Manual solar elevation ${config.solar.elevationDeg}° is not physically attainable at ` +
          `latitude ${config.site.latitudeDeg}° — the Sun stays within about 1.54° of the ` +
          `horizon at a lunar pole.`,
      );
    }
  }

  // Horizon from the coarsest layer, which reaches furthest and so sets the
  // real skyline; a 30 m operational patch cannot see its own horizon.
  let horizon: Float32Array | undefined;
  if (config.solar.computeHorizon) {
    const widest = layers.reduce((a, b) =>
      a.bounds.maxX - a.bounds.minX >= b.bounds.maxX - b.bounds.minX ? a : b,
    );
    const sampler = samplerFromArray(
      widest.heightData,
      widest.widthSamples,
      widest.heightSamples,
      widest.horizontalResolutionMeters,
    );
    horizon = horizonProfile(
      sampler,
      (widest.widthSamples - 1) / 2,
      (widest.heightSamples - 1) / 2,
      { azimuthBins: config.solar.horizonAzimuthBins },
      // bodyRadiusM defaults to Infinity: ingested layers are tangent planes
      // with curvature already removed, so re-applying it would double-count.
    );
  }

  syntheticHeuristics.push(
    'Traversability, slope class and roughness class outputs are synthetic heuristics, not ' +
      'validated terramechanics predictions. No measured wheel-slip model is connected.',
  );

  progress('complete', 1.0);

  const bounds = {
    minX: Math.min(...layers.map((l) => l.bounds.minX)),
    maxX: Math.max(...layers.map((l) => l.bounds.maxX)),
    minZ: Math.min(...layers.map((l) => l.bounds.minZ)),
    maxZ: Math.max(...layers.map((l) => l.bounds.maxZ)),
    minY: Math.min(...layers.map((l) => l.bounds.minY)),
    maxY: Math.max(...layers.map((l) => l.bounds.maxY)),
  };

  const dataset: TerrainDataset = {
    id: config.terrainId,
    version: '1.0.0',
    seed: config.seed,
    bounds,
    origin: {
      local: { x: 0, y: 0, z: 0 },
      site: { latitudeDeg: config.site.latitudeDeg, longitudeDeg: config.site.longitudeDeg },
      datumElevationM,
    },
    coordinateSystem: defaultCoordinateSystem(),
    layers,
    featureManifest: features,
    provenance: {
      generator: {
        name: GENERATOR_NAME,
        version: GENERATOR_VERSION,
        schemaVersion: config.schemaVersion,
      },
      generatedAt: new Date().toISOString(),
      seeds: { master: config.seed, derived: seeds.manifest() },
      dataSources,
      literatureModels,
      syntheticHeuristics,
      limitations,
      configurationHash: configurationHash(config),
    },
  };

  return { dataset, solar, horizon, notes };
}
