/**
 * Terrain configuration schema (spec §16, §20, §28).
 *
 * Zod is the single source of truth: the JSON Schema published in `schemas/`
 * is generated from it, so the validator and the documentation cannot drift
 * apart. Validation rejects physically impossible configurations before any
 * memory is allocated.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';

/** Generation profiles (spec §15). */
export const GenerationProfileSchema = z.enum(['safe', 'advanced', 'unrestricted']);
export type GenerationProfile = z.infer<typeof GenerationProfileSchema>;

export const FractalParametersSchema = z.object({
  octaves: z.number().int().min(1).max(24),
  lacunarity: z.number().min(1.01).max(8),
  persistence: z.number().min(0.01).max(0.99),
  /** Cycles per metre. */
  frequency: z.number().positive(),
  /** Peak amplitude, metres. */
  amplitude: z.number().min(0),
  anisotropy: z.number().min(0.05).max(20).default(1),
});

export const ProceduralLayerSchema = z.object({
  id: z.string().min(1),
  model: z.enum(['fbm', 'ridged', 'warped_fbm']),
  enabled: z.boolean().default(true),
  fractal: FractalParametersSchema,
  warpStrengthM: z.number().min(0).optional(),
  warpFrequency: z.number().positive().optional(),
});

export const LayerConfigSchema = z
  .object({
    role: z.enum(['context', 'mission', 'operational']),
    /** Extent along X (east), metres. */
    widthMeters: z.number().positive(),
    /** Extent along Z (north), metres. */
    lengthMeters: z.number().positive(),
    /** Ground sample distance, metres. */
    resolutionMeters: z.number().positive(),
    /** Centre of the layer in local coordinates, metres. Defaults to the origin. */
    centerXMeters: z.number().default(0),
    centerZMeters: z.number().default(0),
    /** Elevation quantisation for fixed-point export, metres. 0 = none. */
    verticalQuantizationMeters: z.number().min(0).default(0),
  })
  .refine((l) => l.resolutionMeters <= l.widthMeters && l.resolutionMeters <= l.lengthMeters, {
    message: 'resolutionMeters cannot exceed the layer extent',
  });

/** Where measured elevations come from (real data only — spec grounding). */
export const DemSourceSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Path to a real DEM. Either a PDS `.img` with its `.lbl`, or a GeoTIFF.
   * No synthetic fallback exists: if the file is missing, generation fails
   * loudly rather than substituting invented elevations.
   */
  path: z.string().min(1),
  /** Which layer roles should be grounded in this DEM. */
  applyToRoles: z.array(z.enum(['context', 'mission', 'operational'])).default(['context']),
  /**
   * Effective feature-resolving resolution, metres. Synthetic craters are
   * injected strictly below this scale so real and synthetic populations do
   * not double-count. Defaults to 3x the grid spacing when omitted.
   */
  effectiveResolutionMeters: z.number().positive().optional(),
});

/** Crater population controls (spec §8). */
export const CraterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Population model.
   * - `production_csfd` (default): Neukum production function capped by the
   *   Xiao & Werner equilibrium curve; density follows from surface age.
   * - `power_law`: the free parametric model of spec §8, where the caller
   *   supplies density and slope directly.
   */
  model: z.enum(['production_csfd', 'power_law']).default('production_csfd'),
  minimumDiameterMeters: z.number().positive().default(0.2),
  maximumDiameterMeters: z.number().positive().default(35),
  /** Surface age in Gyr; only read by `production_csfd`. */
  surfaceAgeGyr: z.number().min(0.01).max(4.5).default(3.5),
  /** Cumulative density at the minimum diameter; only read by `power_law`. */
  densityPerSquareKilometer: z.number().min(0).optional(),
  /** Differential power-law exponent; only read by `power_law`. */
  powerLawExponent: z.number().min(1.1).max(5).default(3.0),
  /** Mean degradation of the population, 0 (all fresh) … 1 (all erased). */
  meanDegradation: z.number().min(0).max(1).default(0.45),
  /** Spread of the degradation distribution. */
  degradationSpread: z.number().min(0).max(1).default(0.3),
  /** Fraction of craters that are elliptical rather than circular. */
  ellipticalFraction: z.number().min(0).max(1).default(0.15),
  /** Minimum centre separation as a multiple of the larger radius. 0 disables. */
  exclusionRadiusFactor: z.number().min(0).default(0),
  /** Clustering strength, 0 (uniform) … 1 (strongly clustered). */
  clustering: z.number().min(0).max(1).default(0),
  /** Explicitly authored craters, always placed regardless of the population model. */
  authored: z
    .array(
      z.object({
        centerXMeters: z.number(),
        centerZMeters: z.number(),
        diameterMeters: z.number().positive(),
        depthMeters: z.number().positive().optional(),
        degradation: z.number().min(0).max(1).default(0.2),
        ellipticity: z.number().min(0.2).max(1).default(1),
        rotationDegrees: z.number().default(0),
      }),
    )
    .default([]),
});

/** Rock population controls (spec §9). */
export const RockConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * - `golombek_sfd` (default): the exponential rock size-frequency
   *   distribution fitted to Mars/Moon landing-site rock counts, parameterised
   *   by cumulative fractional area covered.
   * - `power_law`: free parametric model.
   */
  model: z.enum(['golombek_sfd', 'power_law']).default('golombek_sfd'),
  /** Cumulative fractional area covered by rocks, 0…1. Golombek's `k`. */
  cumulativeFractionalAreaCovered: z.number().min(0).max(0.6).default(0.06),
  minimumDiameterMeters: z.number().positive().default(0.05),
  maximumDiameterMeters: z.number().positive().default(3.0),
  /** Rocks at or above this diameter get collision geometry. */
  physicalMinimumDiameterMeters: z.number().positive().default(0.15),
  /** Number density override for the `power_law` model, rocks per m². */
  densityPerSquareMeter: z.number().min(0).optional(),
  powerLawExponent: z.number().min(1.1).max(6).default(2.8),
  /** Mean fraction of a rock buried below the surface. */
  meanBuriedFraction: z.number().min(0).max(0.95).default(0.35),
  /** Shape irregularity, 0 (ellipsoid) … 1 (angular). */
  angularity: z.number().min(0).max(1).default(0.6),
  /** Extra rock density on crater rims, as a multiplier. */
  craterRimEnhancement: z.number().min(1).max(20).default(4),
  /** Maximum slope, degrees, on which rocks will be placed. */
  maximumSlopeDeg: z.number().min(0).max(90).default(35),
});

/** Regolith microrelief (spec §10). */
export const RegolithConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** RMS amplitude of centimetre-scale undulation, metres. */
  microreliefAmplitudeM: z.number().min(0).default(0.01),
  /** Characteristic wavelength of the microrelief, metres. */
  microreliefWavelengthM: z.number().positive().default(0.35),
  /**
   * Only layers at or finer than this resolution receive microrelief.
   * Coarser layers cannot represent it, and stamping it there would alias.
   */
  maximumResolutionMeters: z.number().positive().default(0.1),
});

/** Solar geometry configuration (spec §13). */
export const SolarConfigSchema = z
  .object({
    /**
     * `ephemeris` computes azimuth and elevation from the site's selenographic
     * coordinates and a UTC epoch. `manual` takes the angles directly, and is
     * flagged as such in provenance so nobody mistakes it for a real geometry.
     */
    mode: z.enum(['ephemeris', 'manual']).default('ephemeris'),
    /** UTC instant, ISO-8601. Required for `ephemeris`. */
    epochUtc: z.string().optional(),
    /** Manual solar elevation, degrees. Required for `manual`. */
    elevationDeg: z.number().min(-90).max(90).optional(),
    /** Manual solar azimuth, degrees clockwise from north. Required for `manual`. */
    azimuthDeg: z.number().optional(),
    /** Compute a horizon profile and shadow map from the terrain. */
    computeHorizon: z.boolean().default(true),
    /** Azimuth bins for the horizon profile. */
    horizonAzimuthBins: z.number().int().min(16).max(2880).default(360),
  })
  .refine((s) => s.mode !== 'ephemeris' || !!s.epochUtc, {
    message: 'solar.epochUtc is required when solar.mode is "ephemeris"',
  })
  .refine(
    (s) => s.mode !== 'manual' || (s.elevationDeg !== undefined && s.azimuthDeg !== undefined),
    { message: 'solar.elevationDeg and solar.azimuthDeg are required when solar.mode is "manual"' },
  );

/** Site placement on the Moon. */
export const SiteConfigSchema = z.object({
  /** Selenographic latitude, degrees, positive north. */
  latitudeDeg: z.number().min(-90).max(90),
  /** Selenographic longitude, degrees, positive east. */
  longitudeDeg: z.number().min(-180).max(360),
  /** Elevation datum, metres relative to the 1737400 m reference sphere. */
  datumElevationM: z.number().default(0),
});

export const MemoryLimitsSchema = z.object({
  profile: GenerationProfileSchema.default('safe'),
  /** Hard ceiling on total heightfield + mask bytes. Enforced in every profile. */
  maxBytes: z.number().int().positive().default(2 * 1024 * 1024 * 1024),
  /** Maximum samples in any single layer. */
  maxSamplesPerLayer: z.number().int().positive().default(400_000_000),
  /** Maximum tiles produced. */
  maxTiles: z.number().int().positive().default(65_536),
});

export const TerrainConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  terrainId: z.string().min(1),
  seed: z.string().min(1),
  outputDirectory: z.string().default('./generated'),
  site: SiteConfigSchema,
  layers: z.array(LayerConfigSchema).min(1),
  /** Samples per tile edge. */
  tileSizeSamples: z.number().int().min(16).max(4096).default(256),
  dem: DemSourceSchema.optional(),
  proceduralStack: z.array(ProceduralLayerSchema).default([]),
  /** Mean regional slope, degrees, and its downhill direction (azimuth). */
  regionalSlopeDeg: z.number().min(0).max(45).default(0),
  regionalSlopeAzimuthDeg: z.number().default(0),
  craters: CraterConfigSchema.default({}),
  rocks: RockConfigSchema.default({}),
  regolith: RegolithConfigSchema.default({}),
  solar: SolarConfigSchema.default({ mode: 'ephemeris', epochUtc: '2026-01-01T00:00:00Z' }),
  limits: MemoryLimitsSchema.default({}),
  /** Bulk density used for cut-and-fill mass balance, kg/m³. */
  bulkDensityKgM3: z.number().positive().default(1500),
});

export type TerrainConfig = z.infer<typeof TerrainConfigSchema>;
export type LayerConfig = z.infer<typeof LayerConfigSchema>;
export type CraterConfig = z.infer<typeof CraterConfigSchema>;
export type RockConfig = z.infer<typeof RockConfigSchema>;
export type RegolithConfig = z.infer<typeof RegolithConfigSchema>;
export type SolarConfig = z.infer<typeof SolarConfigSchema>;
export type SiteConfig = z.infer<typeof SiteConfigSchema>;
export type MemoryLimits = z.infer<typeof MemoryLimitsSchema>;
export type DemSource = z.infer<typeof DemSourceSchema>;

/** Structured error codes (spec §28). */
export const ERROR_CODES = {
  INVALID_CONFIG: 'TERRAIN_INVALID_CONFIG',
  MEMORY_LIMIT: 'TERRAIN_MEMORY_LIMIT_EXCEEDED',
  SAMPLE_LIMIT: 'TERRAIN_SAMPLE_LIMIT_EXCEEDED',
  TILE_LIMIT: 'TERRAIN_TILE_LIMIT_EXCEEDED',
  LAYER_BOUNDS: 'TERRAIN_LAYER_BOUNDS_INCONSISTENT',
  DEM_UNAVAILABLE: 'TERRAIN_DEM_UNAVAILABLE',
  DEM_COVERAGE: 'TERRAIN_DEM_COVERAGE_INSUFFICIENT',
  OUTPUT_NOT_WRITABLE: 'TERRAIN_OUTPUT_NOT_WRITABLE',
  PROTOCOL_VERSION: 'TERRAIN_PROTOCOL_VERSION_MISMATCH',
  JOB_NOT_FOUND: 'TERRAIN_JOB_NOT_FOUND',
  CANCELLED: 'TERRAIN_CANCELLED',
  VALIDATION_FAILED: 'TERRAIN_VALIDATION_FAILED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** A structured, machine-readable failure (spec §28). */
export class TerrainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TerrainError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: string; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Parse and validate a configuration, throwing a structured error on failure. */
export function parseConfig(input: unknown): TerrainConfig {
  const result = TerrainConfigSchema.safeParse(input);
  if (!result.success) {
    throw new TerrainError(ERROR_CODES.INVALID_CONFIG, 'terrain configuration is invalid', {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}
