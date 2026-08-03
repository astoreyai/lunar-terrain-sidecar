/**
 * Solar geometry at a point on the lunar surface (spec §13, §32).
 *
 * The chain, in order:
 *
 *   1. UTC → TT (leap seconds carried explicitly).
 *   2. Geocentric Sun and Moon, mean equinox of date (Meeus ch. 25 / ch. 47).
 *   3. Precess both to J2000, the frame the IAU lunar pole is defined in.
 *   4. Moon→Sun vector, corrected for light time by antedating the Sun.
 *   5. Rotate into the lunar body-fixed (ME) frame via IAU/WGCCRE.
 *   6. Sub-solar selenographic latitude/longitude.
 *   7. Local topocentric azimuth/elevation at the site.
 *
 * Everything is geometric — the Moon has no atmosphere, so there is no
 * refraction term and no twilight. The only softening of the terminator is the
 * finite angular size of the solar disc, ~0.266° at the Moon, which is
 * reported so callers can model penumbra rather than a hard shadow edge.
 */

import { norm180, norm360, toDeg, toRad } from './angles.js';
import { centuriesTT, daysTT } from './time.js';
import { sunEquatorialOfDate, solarAngularRadiusDeg, C_M_S } from './sun.js';
import { moonEquatorialOfDate } from './moon.js';
import { precessToJ2000 } from './precession.js';
import { j2000ToBodyFixedMatrix } from './lunarFrame.js';
import { apply, dot, norm, normalize, sub, type Vec3 } from './vec.js';

/** Where the Sun is, as seen from the Moon's centre, in body-fixed terms. */
export interface SubSolarPoint {
  /** Selenographic latitude of the sub-solar point, degrees (positive north). */
  latitudeDeg: number;
  /** Selenographic east longitude of the sub-solar point, degrees, in (−180, 180]. */
  longitudeDeg: number;
  /** Moon-centre-to-Sun-centre distance, metres. */
  distanceM: number;
  /** Apparent angular radius of the solar disc from the Moon, degrees. */
  angularRadiusDeg: number;
  /** Unit Moon→Sun vector in the lunar body-fixed frame. */
  bodyFixedDirection: Vec3;
}

/**
 * Sub-solar point on the Moon at a UTC instant.
 *
 * Light time is solved by one antedating iteration, which converges to well
 * below the series' own accuracy (the correction is ~0.0057°, and the residual
 * after one pass is of order 1e-7 degrees).
 */
export function subSolarPoint(utc: Date): SubSolarPoint {
  const T = centuriesTT(utc);
  const d = daysTT(utc);

  // Moon at the reception time, in J2000.
  const moonJ2000 = precessToJ2000(moonEquatorialOfDate(T), T);

  // Sun antedated by the Moon→Sun light time.
  let sunJ2000 = precessToJ2000(sunEquatorialOfDate(T), T);
  let moonToSun = sub(sunJ2000, moonJ2000);
  for (let i = 0; i < 2; i++) {
    const lightTimeS = norm(moonToSun) / C_M_S;
    const tRetarded = new Date(utc.getTime() - lightTimeS * 1000);
    const Tr = centuriesTT(tRetarded);
    sunJ2000 = precessToJ2000(sunEquatorialOfDate(Tr), Tr);
    moonToSun = sub(sunJ2000, moonJ2000);
  }

  const distanceM = norm(moonToSun);
  const dirBody = apply(j2000ToBodyFixedMatrix(d), normalize(moonToSun));

  return {
    latitudeDeg: toDeg(Math.asin(Math.max(-1, Math.min(1, dirBody[2])))),
    longitudeDeg: norm180(toDeg(Math.atan2(dirBody[1], dirBody[0]))),
    distanceM,
    angularRadiusDeg: solarAngularRadiusDeg(distanceM),
    bodyFixedDirection: dirBody,
  };
}

/** Solar position in a site's local horizon frame. */
export interface SolarPosition {
  /**
   * Elevation of the solar disc centre above the local spherical horizon,
   * degrees. Negative means the disc centre is below the horizon.
   *
   * This is the *geometric* horizon of the reference sphere. It ignores local
   * topography entirely — use `@lts/lunar-solar`'s horizon module to decide
   * whether real terrain blocks the Sun.
   */
  elevationDeg: number;
  /** Azimuth of the Sun, degrees clockwise from local north (north 0°, east 90°). */
  azimuthDeg: number;
  /** Apparent angular radius of the solar disc, degrees. */
  angularRadiusDeg: number;
  /** Moon-centre-to-Sun distance, metres. */
  distanceM: number;
  /** Sub-solar point that produced this position. */
  subSolar: SubSolarPoint;
  /**
   * Fraction of the solar disc above the geometric horizon, 0…1, from a simple
   * circular-segment model. Marked *synthetic heuristic* (spec §22): it treats
   * the disc as uniformly bright and the horizon as a straight chord.
   */
  discFractionAboveHorizon: number;
}

/**
 * Solar azimuth and elevation at a selenographic site.
 *
 * At exactly ±90° latitude the local east/north basis is degenerate; the
 * convention adopted here is that azimuth is then measured from the direction
 * of the supplied longitude's meridian, which is the standard polar convention
 * and keeps the function continuous as latitude approaches the pole.
 */
export function solarPositionAtSite(
  utc: Date,
  siteLatitudeDeg: number,
  siteLongitudeDeg: number,
): SolarPosition {
  const subSolar = subSolarPoint(utc);
  const s = subSolar.bodyFixedDirection;

  const lat = toRad(siteLatitudeDeg);
  const lon = toRad(siteLongitudeDeg);
  const clat = Math.cos(lat);
  const slat = Math.sin(lat);
  const clon = Math.cos(lon);
  const slon = Math.sin(lon);

  // Local topocentric basis on the reference sphere.
  const up: Vec3 = [clat * clon, clat * slon, slat];
  const north: Vec3 = [-slat * clon, -slat * slon, clat];
  const east: Vec3 = [-slon, clon, 0];

  const sinEl = Math.max(-1, Math.min(1, dot(s, up)));
  const elevationDeg = toDeg(Math.asin(sinEl));
  const azimuthDeg = norm360(toDeg(Math.atan2(dot(s, east), dot(s, north))));

  return {
    elevationDeg,
    azimuthDeg,
    angularRadiusDeg: subSolar.angularRadiusDeg,
    distanceM: subSolar.distanceM,
    subSolar,
    discFractionAboveHorizon: discFractionAbove(elevationDeg, subSolar.angularRadiusDeg),
  };
}

/**
 * Fraction of a uniform circular disc of angular radius `r` whose centre sits
 * `h` above a straight horizon. SYNTHETIC HEURISTIC (spec §22) — uniform disc,
 * no limb darkening, flat horizon chord.
 */
export function discFractionAbove(h: number, r: number): number {
  if (r <= 0) return h > 0 ? 1 : 0;
  if (h >= r) return 1;
  if (h <= -r) return 0;
  const x = h / r;
  // Area of a circular segment above the chord, normalised by πr².
  return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI;
}

/**
 * Length of the shadow cast by a vertical object of height `heightM` at solar
 * elevation `elevationDeg`, metres. Returns `Infinity` at or below zero
 * elevation.
 *
 * Included because it is the quantity that makes polar illumination intuitive:
 * at 1.5° elevation a 1 m rock throws a 38 m shadow.
 */
export function shadowLengthM(heightM: number, elevationDeg: number): number {
  if (elevationDeg <= 0) return Infinity;
  return heightM / Math.tan(toRad(elevationDeg));
}
