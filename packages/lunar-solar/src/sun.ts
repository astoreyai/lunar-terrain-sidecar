/**
 * Geocentric solar position.
 *
 * Reference: Meeus, *Astronomical Algorithms*, 2nd ed., ch. 25 ("Solar
 * Coordinates"), the abridged VSOP87-derived series. Stated accuracy of this
 * series is about 0.01° in longitude over the modern era, which is the
 * dominant term in this module's overall error budget.
 *
 * Deliberately **geometric, mean equinox of date**: no nutation and no
 * aberration constant are folded in here. Nutation is omitted because the
 * downstream lunar body frame (IAU/WGCCRE) is referred to the ICRF, so the
 * chain precesses mean-of-date → J2000 and a nutation term would have to be
 * removed again. Light travel is handled geometrically in `solarGeometry.ts`
 * by antedating the Sun, which is the same first-order effect as the classical
 * aberration constant but is exact for the Moon rather than for an Earth-bound
 * observer.
 */

import { norm360, sinDeg, cosDeg, toRad } from './angles.js';
import { sphericalToRect, type Vec3 } from './vec.js';

/** Astronomical unit in metres (IAU 2012 definition). */
export const AU_M = 149_597_870_700;
/** Speed of light in vacuum, m/s (SI definition). */
export const C_M_S = 299_792_458;

export interface SunPosition {
  /** Geometric ecliptic longitude, mean equinox of date, degrees. */
  longitudeDeg: number;
  /**
   * Geocentric ecliptic latitude, degrees. Taken as zero: the true value is
   * below 1.2 arcsec (0.0003°), an order of magnitude under the series' own
   * 0.01° longitude accuracy.
   */
  latitudeDeg: number;
  /** Earth–Sun distance, AU. */
  radiusAU: number;
}

/** Solar position for Julian centuries `T` of TT since J2000.0. */
export function sunPosition(T: number): SunPosition {
  // Geometric mean longitude and mean anomaly (Meeus 25.2, 25.3).
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  // Eccentricity of the Earth's orbit (Meeus 25.4).
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;

  // Equation of the centre (Meeus, ch. 25).
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * sinDeg(M) +
    (0.019993 - 0.000101 * T) * sinDeg(2 * M) +
    0.000289 * sinDeg(3 * M);

  const trueLongitude = L0 + C;
  const trueAnomaly = M + C;
  // Radius vector (Meeus 25.5).
  const R = (1.000001018 * (1 - e * e)) / (1 + e * cosDeg(trueAnomaly));

  return {
    longitudeDeg: norm360(trueLongitude),
    latitudeDeg: 0,
    radiusAU: R,
  };
}

/**
 * Mean obliquity of the ecliptic, degrees (Meeus 22.2, IAU 1980 / Laskar).
 *
 * Mean rather than true, to stay consistent with the mean-equinox-of-date
 * frame used throughout this module.
 */
export function meanObliquityDeg(T: number): number {
  const seconds =
    21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813));
  return 23 + 26 / 60 + seconds / 3600;
}

/** Geocentric solar position as a rectangular equatorial vector of date, metres. */
export function sunEquatorialOfDate(T: number): Vec3 {
  const s = sunPosition(T);
  return eclipticToEquatorial(
    sphericalToRect(toRad(s.longitudeDeg), toRad(s.latitudeDeg), s.radiusAU * AU_M),
    T,
  );
}

/** Rotate an ecliptic-of-date rectangular vector into equatorial-of-date. */
export function eclipticToEquatorial(v: Vec3, T: number): Vec3 {
  const eps = toRad(meanObliquityDeg(T));
  const c = Math.cos(eps);
  const s = Math.sin(eps);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/**
 * Apparent angular radius of the Sun seen from `distanceM`, degrees.
 *
 * Solar photospheric radius 6.957e8 m (IAU 2015 Resolution B3 nominal value).
 * At the Moon this is ~0.266°, which is why a lunar polar site can be in
 * partial illumination: the disc is not a point at grazing elevations.
 */
export const SOLAR_RADIUS_M = 6.957e8;

export function solarAngularRadiusDeg(distanceM: number): number {
  return (Math.asin(SOLAR_RADIUS_M / distanceM) * 180) / Math.PI;
}
