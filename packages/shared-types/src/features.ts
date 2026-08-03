/**
 * Feature manifests (spec §8, §9, §11).
 *
 * Every crater, boulder and engineering feature is recorded with the parameters
 * that produced it. Two reasons: a manifest lets a consumer place semantic
 * labels and collision proxies without re-deriving them from pixels, and it
 * makes the terrain auditable — any bump in the heightfield can be traced back
 * to the feature and seed that made it (spec §33).
 */

import type { Degrees, Meters, Radians, Vector3Meters } from './coordinates.js';

export type TerrainFeatureKind =
  | 'crater'
  | 'rock'
  | 'berm'
  | 'trench'
  | 'ramp'
  | 'pad'
  | 'excavation'
  | 'spoil_pile'
  | 'graded_slope'
  | 'wheel_track'
  | 'polygonal_cut'
  | 'polygonal_fill';

export interface TerrainFeatureBase {
  id: string;
  kind: TerrainFeatureKind;
  /** Layers this feature was stamped into. */
  appliedToLayers: string[];
  /** Axis-aligned horizontal extent affected, metres. */
  affectedBounds: { minX: Meters; minZ: Meters; maxX: Meters; maxZ: Meters };
  /** Seed channel that produced it, for traceability. */
  seedChannel?: string;
}

/** Crater geometry (spec §8). */
export interface CraterParameters {
  centerXMeters: Meters;
  centerZMeters: Meters;
  diameterMeters: Meters;
  depthMeters: Meters;
  rimHeightMeters: Meters;
  rimWidthMeters: Meters;
  /** Flat floor radius as a fraction of the crater radius, 0…1. */
  floorRadiusRatio: number;
  /** Ratio of minor to major axis, 0…1. 1 is circular. */
  ellipticity: number;
  rotationRadians: Radians;
  /**
   * Degradation, 0 (fresh) … 1 (nearly erased). Softens the profile and
   * suppresses the rim, standing in for the infilling and rim-rounding that
   * accumulate with surface age.
   */
  degradation: number;
  ejectaExtentMeters: Meters;
  ejectaAmplitudeMeters: Meters;
  /** Whether a central peak was generated (only for large synthetic craters). */
  centralPeak: boolean;
}

export interface CraterFeature extends TerrainFeatureBase {
  kind: 'crater';
  parameters: CraterParameters;
  /**
   * How this crater was chosen.
   * - `production_csfd`: sampled from the Neukum production function capped by
   *   the Xiao & Werner equilibrium curve.
   * - `authored`: placed explicitly by a user or preset.
   */
  origin: 'production_csfd' | 'authored';
}

/** A boulder or clast (spec §9). */
export interface RockFeature extends TerrainFeatureBase {
  kind: 'rock';
  /** Centre position, metres; y is the elevation of the rock's centre. */
  position: Vector3Meters;
  /** Orientation as a quaternion [x, y, z, w]. */
  rotationQuaternion: [number, number, number, number];
  /** Semi-axes, metres. */
  scale: Vector3Meters;
  /** Whether the rock participates in collision. */
  physical: boolean;
  /** Fraction of the rock buried below the surface, 0…1. */
  buriedFraction: number;
  /** Shape irregularity, 0 (smooth ellipsoid) … 1 (highly angular). */
  angularity: number;
  material: string;
  semanticClass: string;
}

/** Volume bookkeeping for an engineering feature (spec §11). */
export interface MassBalance {
  /** Volume of regolith removed, m³. */
  removedVolumeM3: number;
  /** Volume of regolith deposited, m³. */
  depositedVolumeM3: number;
  /** deposited − removed, m³. Zero for a mass-conserving operation. */
  netVolumeM3: number;
  /**
   * |net| / max(removed, deposited), dimensionless. Reported so a caller can
   * see conservation error rather than trusting that it is zero.
   */
  relativeError: number;
  /** Bulk density assumed when converting volume to mass, kg/m³. */
  bulkDensityKgM3: number;
  /** net volume × density, kg. */
  netMassKg: number;
}

/** An engineering feature: berm, trench, pad, excavation and friends (spec §11). */
export interface ConstructionFeature extends TerrainFeatureBase {
  kind: Exclude<TerrainFeatureKind, 'crater' | 'rock'>;
  /** Free-form geometry parameters, keyed by feature kind. */
  parameters: Record<string, number | number[] | string | boolean>;
  massBalance: MassBalance;
  /** Elevation statistics before and after, metres. */
  elevationBefore: { min: Meters; max: Meters; mean: Meters };
  elevationAfter: { min: Meters; max: Meters; mean: Meters };
  semanticClass: string;
}

export type TerrainFeature = CraterFeature | RockFeature | ConstructionFeature;

export function isCrater(f: TerrainFeature): f is CraterFeature {
  return f.kind === 'crater';
}

export function isRock(f: TerrainFeature): f is RockFeature {
  return f.kind === 'rock';
}

export function isConstruction(f: TerrainFeature): f is ConstructionFeature {
  return f.kind !== 'crater' && f.kind !== 'rock';
}

/** Solar illumination conditions recorded with a site (spec §13, §32). */
export interface SolarConditions {
  /** UTC instant the geometry was evaluated for. */
  epochUtc: string;
  /** Solar elevation above the local spherical horizon, degrees. */
  elevationDeg: Degrees;
  /** Solar azimuth clockwise from local north, degrees. */
  azimuthDeg: Degrees;
  /** Apparent angular radius of the solar disc, degrees. */
  angularRadiusDeg: Degrees;
  /** Sub-solar selenographic latitude, degrees. */
  subSolarLatitudeDeg: Degrees;
  /** Sub-solar selenographic longitude, degrees. */
  subSolarLongitudeDeg: Degrees;
  /** How the angles were obtained. */
  model: 'ephemeris' | 'ephemeris_de' | 'manual_override';
}
