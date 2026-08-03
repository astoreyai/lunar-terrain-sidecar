/**
 * Coordinate and unit conventions (spec §4).
 *
 * The whole system is metres, right-handed, Y-up:
 *
 *     +X = east, +Y = elevation (up), +Z = SOUTH   (north = −Z)
 *
 * The spec asked for right-handed *and* Z=north, which is impossible: with
 * X=east and Y=up, right-handedness forces Z = X × Y = east × up = south.
 * Handedness was kept because it governs triangle winding, normal orientation
 * and physics chirality, and because both Three.js and Godot are right-handed
 * Y-up. See `docs/decisions/0002-coordinate-handedness.md`.
 *
 * North being −Z is carried as *data* in {@link CoordinateSystem}, not as a
 * comment, and embedded in every export so a consumer never has to guess.
 *
 * Terrain is authored in a *local Cartesian* frame whose origin is a single
 * {@link TerrainOrigin}. Vertices are stored tile-relative so that a site sitting
 * 1.7e6 m from the Moon's centre never puts kilometre-scale magnitudes into a
 * float32 vertex buffer (spec §4 "local terrain origin to avoid FP instability").
 */

/** Distance in metres. All linear quantities in this system are metres. */
export type Meters = number;

/** Angle in radians. */
export type Radians = number;

/** Angle in degrees. Used only at API/UI boundaries; internals are radians. */
export type Degrees = number;

/** A point or vector in the local terrain frame, metres, [east, up, north]. */
export interface Vector3Meters {
  x: Meters;
  y: Meters;
  z: Meters;
}

/**
 * The IAU mean lunar radius used as the datum for every selenographic
 * conversion in this system.
 *
 * 1 737 400 m — the reference sphere radius of the LOLA gridded data records
 * (PDS `LRO-L-LOLA-4-GDR-V1.0`, `OFFSET = 1737400.0`) and the ellipsoid radius
 * declared by the PGDA polar-stereographic site DEMs. Using the same datum as
 * the source DEMs is what makes ingested elevations and synthesised elevations
 * directly comparable.
 */
export const LUNAR_REFERENCE_RADIUS_M = 1_737_400.0;

/** Lunar surface gravity, m/s². IAU/NASA nominal value. */
export const LUNAR_GRAVITY_M_S2 = 1.62;

/**
 * Selenographic position on the Moon.
 *
 * Latitude is positive north, longitude positive east, both in degrees, in the
 * **Mean Earth / Polar Axis (ME)** body-fixed frame — the frame LOLA products are
 * published in. See `@lts/lunar-solar` for the ME-vs-Principal-Axis discussion.
 */
export interface Selenographic {
  latitudeDeg: Degrees;
  longitudeDeg: Degrees;
}

/**
 * Where the local terrain frame sits on the Moon.
 *
 * `site` anchors local (0,0) to a real selenographic coordinate, which is what
 * lets the solar model compute a physically correct sun angle for this terrain
 * and lets ingested DEM pixels land in the right place.
 */
export interface TerrainOrigin {
  /** Local-frame origin offset, metres. Normally all zero. */
  local: Vector3Meters;
  /** Selenographic anchor of local (x=0, z=0). */
  site: Selenographic;
  /**
   * Elevation datum, metres, added to every stored height to recover an
   * elevation relative to {@link LUNAR_REFERENCE_RADIUS_M}. Stored heights are
   * kept small (near zero) for float precision; `datumElevationM` carries the
   * offset back to absolute lunar elevation.
   */
  datumElevationM: Meters;
}

/** Declared coordinate conventions, embedded verbatim in every export (spec §4). */
export interface CoordinateSystem {
  handedness: 'right';
  up_axis: '+Y';
  east_axis: '+X';
  /** North is −Z; see ADR 0002. Stated as data so consumers cannot mis-assume. */
  north_axis: '-Z';
  south_axis: '+Z';
  linear_unit: 'meter';
  angular_unit: 'degree';
  /** Plain-language restatement, carried into every manifest. */
  note: string;
  /** Body-fixed frame the selenographic anchor is expressed in. */
  body_frame: 'MOON_ME';
  /** Reference sphere radius, metres. */
  body_radius_m: Meters;
  /** Projection used when terrain was ingested from a projected DEM, if any. */
  source_projection?: ProjectionMetadata;
}

/**
 * Projection metadata for terrain derived from a real projected DEM.
 *
 * The LOLA polar products are south polar stereographic on a sphere; carrying
 * these parameters lets a consumer re-project local metres back to
 * selenographic coordinates exactly.
 */
export interface ProjectionMetadata {
  type: 'polar_stereographic';
  /** Latitude of natural origin, degrees (−90 for the south polar products). */
  latitudeOfOriginDeg: Degrees;
  /** Longitude of natural origin, degrees. */
  centralMeridianDeg: Degrees;
  /** Scale factor at natural origin. */
  scaleFactor: number;
  falseEastingM: Meters;
  falseNorthingM: Meters;
  bodyRadiusM: Meters;
  /** Projected coordinate of local-frame origin, metres. */
  originEastingM: Meters;
  originNorthingM: Meters;
}

/** The canonical coordinate system for a site with no projected DEM source. */
export function defaultCoordinateSystem(): CoordinateSystem {
  return {
    handedness: 'right',
    up_axis: '+Y',
    east_axis: '+X',
    north_axis: '-Z',
    south_axis: '+Z',
    linear_unit: 'meter',
    angular_unit: 'degree',
    note:
      'Right-handed Y-up. north = -Z because X=east and Y=up force Z=south. ' +
      'Grid col increases east (+X); grid row increases south (+Z), so row 0 is northernmost. ' +
      'Azimuth is clockwise from north: direction (x,z) = (sin A, -cos A).',
    body_frame: 'MOON_ME',
    body_radius_m: LUNAR_REFERENCE_RADIUS_M,
  };
}

/**
 * An axis-aligned box in the local terrain frame, metres.
 *
 * Horizontal extent is authoritative for layer placement; the vertical range is
 * descriptive (recomputed from data after generation).
 */
export interface TerrainBounds {
  minX: Meters;
  minZ: Meters;
  maxX: Meters;
  maxZ: Meters;
  minY: Meters;
  maxY: Meters;
}

export function boundsWidth(b: TerrainBounds): Meters {
  return b.maxX - b.minX;
}

export function boundsLength(b: TerrainBounds): Meters {
  return b.maxZ - b.minZ;
}

/** True when `inner` lies entirely within `outer` horizontally (spec §28). */
export function boundsContain(outer: TerrainBounds, inner: TerrainBounds): boolean {
  return (
    inner.minX >= outer.minX - 1e-9 &&
    inner.maxX <= outer.maxX + 1e-9 &&
    inner.minZ >= outer.minZ - 1e-9 &&
    inner.maxZ <= outer.maxZ + 1e-9
  );
}

/** True when the two boxes overlap horizontally. */
export function boundsOverlap(a: TerrainBounds, b: TerrainBounds): boolean {
  return !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ);
}

export function makeBounds(
  minX: Meters,
  minZ: Meters,
  maxX: Meters,
  maxZ: Meters,
  minY: Meters = 0,
  maxY: Meters = 0,
): TerrainBounds {
  return { minX, minZ, maxX, maxZ, minY, maxY };
}

/** A square site of `size` metres centred on the local origin. */
export function centeredBounds(sizeX: Meters, sizeZ: Meters): TerrainBounds {
  return makeBounds(-sizeX / 2, -sizeZ / 2, sizeX / 2, sizeZ / 2);
}
