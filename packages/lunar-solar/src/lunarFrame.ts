/**
 * Orientation of the Moon's body-fixed frame in inertial (ICRF/J2000) space.
 *
 * Reference: Archinal et al. (2011), "Report of the IAU Working Group on
 * Cartographic Coordinates and Rotational Elements: 2009", *Celestial Mechanics
 * and Dynamical Astronomy* 109:101–135, with the 2015 erratum (110:401–403).
 *
 * ## Which lunar frame this is, and what that costs
 *
 * The IAU/WGCCRE expressions below realise the lunar **Mean Earth / Polar Axis
 * (ME)** frame — the frame the LOLA gridded products and the PGDA polar site
 * DEMs are published in, so it is the correct frame to pair with those DEMs.
 *
 * The realisation is approximate. The IAU trigonometric series is a fit, not the
 * numerically integrated lunar libration of a JPL DE ephemeris; the two differ
 * by roughly 0.01–0.03°. That propagates about 1:1 into solar elevation, which
 * at a lunar pole spans only ±1.54°. So the pole orientation, not the solar
 * series, is the accuracy floor of this module — see `docs/known-limitations.md`
 * for the upgrade path (JPL DE440 + a PA→ME rotation).
 *
 * This is stated rather than buried because at grazing incidence shadow length
 * scales as 1/tan(elevation): at 1° elevation a 0.03° error moves a shadow edge
 * by ~3%, which is visible in a rendered scene and matters for illumination
 * studies at candidate landing sites.
 */

import { norm360, toRad } from './angles.js';
import { cross, normalize, scale, add, type Mat3, type Vec3 } from './vec.js';

/** The libration arguments E1…E13, degrees, for `d` days of TT since J2000. */
export function librationArguments(d: number): number[] {
  return [
    125.045 - 0.0529921 * d, // E1
    250.089 - 0.1059842 * d, // E2
    260.008 + 13.0120009 * d, // E3
    176.625 + 13.3407154 * d, // E4
    357.529 + 0.9856003 * d, // E5
    311.589 + 26.4057084 * d, // E6
    134.963 + 13.064993 * d, // E7
    276.617 + 0.3287146 * d, // E8
    34.226 + 1.7484877 * d, // E9
    15.134 - 0.1589763 * d, // E10
    119.743 + 0.0036096 * d, // E11
    239.961 + 0.1643573 * d, // E12
    25.053 + 12.9590088 * d, // E13
  ];
}

export interface LunarOrientation {
  /** Right ascension of the lunar north pole in J2000, degrees. */
  poleRaDeg: number;
  /** Declination of the lunar north pole in J2000, degrees. */
  poleDecDeg: number;
  /** Prime meridian angle W, degrees. */
  primeMeridianDeg: number;
}

/**
 * Lunar pole and prime meridian at `d` days of TT past J2000
 * (`T = d / 36525` Julian centuries).
 */
export function lunarOrientation(d: number): LunarOrientation {
  const T = d / 36525;
  const E = librationArguments(d);
  const sinE = (i: number) => Math.sin(toRad(E[i - 1]));
  const cosE = (i: number) => Math.cos(toRad(E[i - 1]));

  const ra =
    269.9949 +
    0.0031 * T -
    3.8787 * sinE(1) -
    0.1204 * sinE(2) +
    0.07 * sinE(3) -
    0.0172 * sinE(4) +
    0.0072 * sinE(6) -
    0.0052 * sinE(10) +
    0.0043 * sinE(13);

  const dec =
    66.5392 +
    0.013 * T +
    1.5419 * cosE(1) +
    0.0239 * cosE(2) -
    0.0278 * cosE(3) +
    0.0068 * cosE(4) -
    0.0029 * cosE(6) +
    0.0009 * cosE(7) +
    0.0008 * cosE(10) -
    0.0009 * cosE(13);

  const w =
    38.3213 +
    13.17635815 * d -
    1.4e-12 * d * d +
    3.561 * sinE(1) +
    0.1208 * sinE(2) -
    0.0642 * sinE(3) +
    0.0158 * sinE(4) +
    0.0252 * sinE(5) -
    0.0066 * sinE(6) -
    0.0047 * sinE(7) -
    0.0046 * sinE(8) +
    0.0028 * sinE(9) +
    0.0052 * sinE(10) +
    0.004 * sinE(11) +
    0.0019 * sinE(12) -
    0.0044 * sinE(13);

  return {
    poleRaDeg: norm360(ra),
    poleDecDeg: dec,
    primeMeridianDeg: norm360(w),
  };
}

/**
 * Matrix rotating a J2000 equatorial vector into the lunar body-fixed frame.
 *
 * Construction is the standard WGCCRE one: the body +Z axis is the pole; the
 * node of the body equator on the J2000 equator lies at right ascension
 * α₀ + 90°; the prime meridian is that node advanced by W about the pole.
 */
export function j2000ToBodyFixedMatrix(d: number): Mat3 {
  const { poleRaDeg, poleDecDeg, primeMeridianDeg } = lunarOrientation(d);
  const ra = toRad(poleRaDeg);
  const dec = toRad(poleDecDeg);
  const w = toRad(primeMeridianDeg);

  // Body +Z: the north pole direction in J2000.
  const zAxis: Vec3 = [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];

  // Ascending node of the body equator on the J2000 equator: RA = α₀ + 90°,
  // declination 0.
  const node: Vec3 = [-Math.sin(ra), Math.cos(ra), 0];
  // Completes a right-handed triad with `node` and `zAxis`.
  const perp = cross(zAxis, node);

  // Prime meridian: the node rotated by W about the pole.
  const xAxis = normalize(add(scale(node, Math.cos(w)), scale(perp, Math.sin(w))));
  const yAxis = cross(zAxis, xAxis);

  // Rows are the body axes expressed in J2000, so M·v_J2000 = v_body.
  return [
    xAxis[0], xAxis[1], xAxis[2],
    yAxis[0], yAxis[1], yAxis[2],
    zAxis[0], zAxis[1], zAxis[2],
  ];
}
