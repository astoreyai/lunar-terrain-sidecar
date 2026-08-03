/**
 * Precession of the equinoxes, mean equinox of date ↔ J2000.0.
 *
 * This step is **not optional**. The Meeus solar and lunar series produce
 * coordinates in the mean equinox of date, while the IAU/WGCCRE lunar rotation
 * elements (α₀, δ₀) are referred to the ICRF, which is aligned with J2000 to
 * well under a milliarcsecond. Differencing the two frames without precessing
 * would inject the accumulated precession — about 0.36° by 2026 — straight into
 * the sub-solar point. That is a quarter of the entire ±1.54° range of solar
 * elevation at a lunar pole, so it would dominate every other error in the
 * module.
 *
 * Angles: Lieske et al. (1977), the IAU 1976 precession model, as given in the
 * *Explanatory Supplement to the Astronomical Almanac*.
 */

import { ARCSEC } from './angles.js';
import { apply, transpose, type Mat3, type Vec3 } from './vec.js';

/** Precession matrix taking J2000 rectangular coordinates to mean-of-date. */
export function precessionMatrixJ2000ToDate(T: number): Mat3 {
  const T2 = T * T;
  const T3 = T2 * T;

  const zeta = (2306.2181 * T + 0.30188 * T2 + 0.017998 * T3) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T2 + 0.018203 * T3) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T2 - 0.041833 * T3) * ARCSEC;

  const cz = Math.cos(zeta);
  const sz = Math.sin(zeta);
  const cZ = Math.cos(z);
  const sZ = Math.sin(z);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);

  // Explanatory Supplement, eq. 3.21-4.
  return [
    cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
    cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
    cz * st, -sz * st, ct,
  ];
}

/** Rotate a mean-equinox-of-date equatorial vector into J2000. */
export function precessToJ2000(v: Vec3, T: number): Vec3 {
  return apply(transpose(precessionMatrixJ2000ToDate(T)), v);
}

/** Rotate a J2000 equatorial vector into mean equinox of date. */
export function precessFromJ2000(v: Vec3, T: number): Vec3 {
  return apply(precessionMatrixJ2000ToDate(T), v);
}
