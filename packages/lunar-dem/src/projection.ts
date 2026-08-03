/**
 * Polar stereographic projection on a sphere (Snyder, *Map Projections — A
 * Working Manual*, USGS PP 1395, §21).
 *
 * Both real datasets this package reads are south polar stereographic on the
 * 1737.4 km sphere with the pole at the origin and the central meridian at 0°:
 *
 *   - LOLA `LDEM_75S_120M`   — 120 m/px, PDS3, covers 75°S–90°S
 *   - PGDA `*_final_adj_5mpp_surf.tif` — 5 m/px GeoTIFF site DEMs
 *
 * Their PDS label records `COORDINATE_SYSTEM_NAME = "MEAN EARTH/POLAR AXIS OF
 * DE421"`, i.e. the ME frame — the same frame `@lts/lunar-solar` resolves the
 * lunar body axes into, so selenographic coordinates are consistent end to end.
 */

/** Lunar reference sphere radius, metres (LOLA `A_AXIS_RADIUS = 1737.4 km`). */
export const LUNAR_RADIUS_M = 1_737_400.0;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface PolarStereographicParams {
  /** +1 for the north aspect, −1 for the south. */
  hemisphere: 1 | -1;
  /** Central meridian, degrees east. */
  centralMeridianDeg: number;
  /** Scale factor at the pole. */
  scaleFactor: number;
  /** Sphere radius, metres. */
  radiusM: number;
}

export const SOUTH_POLAR_LOLA: PolarStereographicParams = {
  hemisphere: -1,
  centralMeridianDeg: 0,
  scaleFactor: 1,
  radiusM: LUNAR_RADIUS_M,
};

/**
 * Selenographic (lat, lon) → projected (x, y) in metres.
 *
 * South aspect: `x = ρ sin Δλ`, `y = ρ cos Δλ`, with
 * `ρ = 2 R k₀ tan(π/4 + φ/2)`. At φ = −90° this gives ρ = 0 (the pole sits at
 * the origin); at φ = −75° it gives 457 466 m — 26 m inside the LDEM_75S
 * product's 457 440 m half-extent, i.e. the 75°S boundary lands within a
 * quarter-pixel of the outermost pixel centre. (An earlier revision of this
 * comment quoted 457 425 m, which matched neither the formula nor the
 * product.)
 */
export function forward(
  latitudeDeg: number,
  longitudeDeg: number,
  p: PolarStereographicParams = SOUTH_POLAR_LOLA,
): { x: number; y: number } {
  const phi = latitudeDeg * DEG;
  const dLambda = (longitudeDeg - p.centralMeridianDeg) * DEG;

  const rho =
    p.hemisphere === -1
      ? 2 * p.radiusM * p.scaleFactor * Math.tan(Math.PI / 4 + phi / 2)
      : 2 * p.radiusM * p.scaleFactor * Math.tan(Math.PI / 4 - phi / 2);

  return p.hemisphere === -1
    ? { x: rho * Math.sin(dLambda), y: rho * Math.cos(dLambda) }
    : { x: rho * Math.sin(dLambda), y: -rho * Math.cos(dLambda) };
}

/** Projected (x, y) in metres → selenographic (lat, lon) in degrees. */
export function inverse(
  x: number,
  y: number,
  p: PolarStereographicParams = SOUTH_POLAR_LOLA,
): { latitudeDeg: number; longitudeDeg: number } {
  const rho = Math.hypot(x, y);
  if (rho === 0) {
    return { latitudeDeg: p.hemisphere === -1 ? -90 : 90, longitudeDeg: p.centralMeridianDeg };
  }
  const c = 2 * Math.atan(rho / (2 * p.radiusM * p.scaleFactor));

  if (p.hemisphere === -1) {
    const lat = (c - Math.PI / 2) * RAD;
    const lon = p.centralMeridianDeg + Math.atan2(x, y) * RAD;
    return { latitudeDeg: lat, longitudeDeg: normalizeLongitude(lon) };
  }
  const lat = (Math.PI / 2 - c) * RAD;
  const lon = p.centralMeridianDeg + Math.atan2(x, -y) * RAD;
  return { latitudeDeg: lat, longitudeDeg: normalizeLongitude(lon) };
}

/** Normalise to (−180, 180]. */
export function normalizeLongitude(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Local scale distortion of the projection at a latitude.
 *
 * Polar stereographic is conformal but not equal-area: one TRUE metre on the
 * ground maps to `k` projected metres, with `k = 2 k₀ / (1 + sin|φ|)` ≥ 1 for
 * the polar aspect (so one projected metre is 1/k true metres). At the pole
 * k = k₀ = 1; at 75° it is 1.017, so ignoring it would misplace the edge of a
 * 2 km context tile by 34 m at the boundary of the LDEM_75S product.
 *
 * Local terrain frames are built at the site and are small enough that this is
 * applied as a single scalar at the site latitude rather than per-pixel; the
 * residual across a 2 km tile at 88°S is under 1 part in 10⁵.
 */
export function scaleFactorAtLatitude(
  latitudeDeg: number,
  p: PolarStereographicParams = SOUTH_POLAR_LOLA,
): number {
  const phi = Math.abs(latitudeDeg) * DEG;
  return (2 * p.scaleFactor) / (1 + Math.sin(phi));
}
