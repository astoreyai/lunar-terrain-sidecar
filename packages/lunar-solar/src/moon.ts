/**
 * Geocentric lunar position (Meeus, *Astronomical Algorithms*, 2nd ed., ch. 47).
 *
 * Returns coordinates referred to the **mean equinox and ecliptic of date**,
 * matching `sun.ts`, so the two can be differenced directly before the single
 * precession step to J2000.
 */

import { norm360, sinDeg, cosDeg, toRad } from './angles.js';
import { sphericalToRect, type Vec3 } from './vec.js';
import { TABLE_47A, TABLE_47B } from './moonTables.js';
import { eclipticToEquatorial } from './sun.js';

export interface MoonPosition {
  /** Geocentric ecliptic longitude, mean equinox of date, degrees. */
  longitudeDeg: number;
  /** Geocentric ecliptic latitude, degrees. */
  latitudeDeg: number;
  /** Earth–Moon centre-to-centre distance, kilometres. */
  distanceKm: number;
}

/** Fundamental arguments of the lunar theory at Julian centuries `T` of TT. */
export interface LunarArguments {
  /** Moon's mean longitude L′, degrees. */
  Lp: number;
  /** Mean elongation of the Moon from the Sun D, degrees. */
  D: number;
  /** Sun's mean anomaly M, degrees. */
  M: number;
  /** Moon's mean anomaly M′, degrees. */
  Mp: number;
  /** Moon's argument of latitude F, degrees. */
  F: number;
  /** Eccentricity correction factor E (Meeus 47.6). */
  E: number;
}

export function lunarArguments(T: number): LunarArguments {
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;

  const Lp =
    218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;
  const D =
    297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000;
  const Mp =
    134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000;
  const F =
    93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000;

  // Correction for the decreasing eccentricity of the Earth's orbit; applied to
  // every term whose M multiplier is non-zero (Meeus 47.6).
  const E = 1 - 0.002516 * T - 0.0000074 * T2;

  return { Lp: norm360(Lp), D: norm360(D), M: norm360(M), Mp: norm360(Mp), F: norm360(F), E };
}

/** Geocentric lunar position for Julian centuries `T` of TT since J2000.0. */
export function moonPosition(T: number): MoonPosition {
  const { Lp, D, M, Mp, F, E } = lunarArguments(T);

  // Additive arguments from Venus (A1), Jupiter (A2) and the flattening of the
  // Earth (A3) — Meeus ch. 47.
  const A1 = norm360(119.75 + 131.849 * T);
  const A2 = norm360(53.09 + 479264.29 * T);
  const A3 = norm360(313.45 + 481266.484 * T);

  let sumL = 0;
  let sumR = 0;
  for (const [cD, cM, cMp, cF, cl, cr] of TABLE_47A) {
    const arg = cD * D + cM * M + cMp * Mp + cF * F;
    const ecc = cM === 0 ? 1 : cM === 1 || cM === -1 ? E : E * E;
    sumL += cl * ecc * sinDeg(arg);
    sumR += cr * ecc * cosDeg(arg);
  }

  let sumB = 0;
  for (const [cD, cM, cMp, cF, cb] of TABLE_47B) {
    const arg = cD * D + cM * M + cMp * Mp + cF * F;
    const ecc = cM === 0 ? 1 : cM === 1 || cM === -1 ? E : E * E;
    sumB += cb * ecc * sinDeg(arg);
  }

  // Additive corrections (Meeus ch. 47).
  sumL += 3958 * sinDeg(A1) + 1962 * sinDeg(Lp - F) + 318 * sinDeg(A2);
  sumB +=
    -2235 * sinDeg(Lp) +
    382 * sinDeg(A3) +
    175 * sinDeg(A1 - F) +
    175 * sinDeg(A1 + F) +
    127 * sinDeg(Lp - Mp) -
    115 * sinDeg(Lp + Mp);

  return {
    longitudeDeg: norm360(Lp + sumL / 1e6),
    latitudeDeg: sumB / 1e6,
    distanceKm: 385000.56 + sumR / 1000,
  };
}

/** Geocentric lunar position as a rectangular equatorial vector of date, metres. */
export function moonEquatorialOfDate(T: number): Vec3 {
  const m = moonPosition(T);
  return eclipticToEquatorial(
    sphericalToRect(toRad(m.longitudeDeg), toRad(m.latitudeDeg), m.distanceKm * 1000),
    T,
  );
}
