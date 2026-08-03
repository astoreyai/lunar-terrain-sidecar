/**
 * Kernel-driven solar geometry: the same API as `solarGeometry.ts`, but with
 * every quantity taken from the JPL DE440 kernels instead of the Meeus series
 * and the IAU/WGCCRE rotation model.
 *
 * This attacks the module's documented accuracy floor (ADR 0001,
 * docs/known-limitations.md): the IAU trigonometric series realises the lunar
 * Mean Earth frame only to ~0.01–0.03°, while `moon_pa_de440_200625.bpc`
 * carries JPL's numerically integrated libration and `moon_de440_250416.tf`
 * the exact PA→ME rotation. The residual orientation error of this path is
 * the ME421-vs-current-ME realisation difference the frames kernel itself
 * quantifies: ≤ 3.1e-7 rad (~53 cm on the surface) over 2000–2040.
 *
 * ## Time argument: ET = TDB ≈ TT
 *
 * SPK and binary PCK polynomials are functions of ET (TDB seconds past
 * J2000). This module reuses `time.ts`'s UTC→TT chain and treats TT as TDB.
 * TDB−TT is a periodic relativistic term bounded by ±1.7 ms. Its worst-case
 * geometric effect here is through the lunar prime-meridian rate
 * (13.18°/day ≈ 1.5e-4 °/s): 1.7 ms → ~2.6e-7°; the Moon→Sun direction
 * itself moves ~1.1e-5 °/s → ~2e-8°. Both are two-plus orders of magnitude
 * below the ME421 realisation floor above, so carrying the TDB periodic
 * terms would add code without adding accuracy.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { toDeg, toRad, norm180, norm360 } from '../angles.js';
import { daysTT } from '../time.js';
import { C_M_S, solarAngularRadiusDeg } from '../sun.js';
import { apply, dot, norm, normalize, type Vec3 } from '../vec.js';
import {
  discFractionAbove,
  subSolarPoint,
  type SolarPosition,
  type SubSolarPoint,
} from '../solarGeometry.js';
import { SpiceKernelError } from './daf.js';
import { NAIF_CODES, SpkFile } from './spk.js';
import { BinaryPckFile } from './pck.js';
import { j2000ToMoonMEMatrix } from './deFrame.js';

/** Where the DE440 kernels live on this machine unless configured otherwise. */
export const DEFAULT_KERNEL_DIRECTORY = '/mnt/projects/datasets/spice_kernels';
/** SPK planetary ephemeris (SSB/Sun/EMB/Moon/Earth, 1849–2150). */
export const DE_SPK_FILENAME = 'de440s.bsp';
/** Binary PCK with the integrated MOON_PA_DE440 orientation. */
export const DE_PCK_FILENAME = 'moon_pa_de440_200625.bpc';

/** A loaded pair of DE440 kernels. */
export interface DeKernels {
  directory: string;
  spk: SpkFile;
  pck: BinaryPckFile;
}

const kernelCache = new Map<string, DeKernels>();

/**
 * Load (and cache per directory) the DE440 SPK + binary PCK pair. Throws a
 * structured `SpiceKernelError` when either file is absent — there is no
 * silent fallback to the analytic chain.
 */
export function loadDeKernels(directory: string = DEFAULT_KERNEL_DIRECTORY): DeKernels {
  const cached = kernelCache.get(directory);
  if (cached) return cached;

  const spkPath = join(directory, DE_SPK_FILENAME);
  const pckPath = join(directory, DE_PCK_FILENAME);
  const missing = [spkPath, pckPath].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new SpiceKernelError(
      'SPICE_KERNEL_UNREADABLE',
      `DE440 kernels not found: ${missing.join(', ')}. Solar mode 'ephemeris_de' needs ` +
        `${DE_SPK_FILENAME} and ${DE_PCK_FILENAME}; set solar.kernelDirectory or use the ` +
        `analytic 'ephemeris' mode.`,
      { directory, missing },
    );
  }

  const kernels: DeKernels = {
    directory,
    spk: SpkFile.open(spkPath),
    pck: BinaryPckFile.open(pckPath),
  };
  kernelCache.set(directory, kernels);
  return kernels;
}

/**
 * ET (TDB seconds past J2000) of a UTC instant, under the TT ≈ TDB
 * approximation discussed in the module docstring.
 */
export function etSecondsTDB(utc: Date): number {
  return daysTT(utc) * 86400;
}

const C_KM_S = C_M_S / 1000;

/**
 * Geometric Moon→Sun vector in J2000, km, with the Sun antedated by the
 * Moon→Sun light time — the same one-sided correction `subSolarPoint` makes,
 * so the two chains are comparable term by term.
 */
function moonToSunJ2000Km(kernels: DeKernels, etSec: number): Vec3 {
  const { spk } = kernels;
  const moon = spk.positionRelativeToSsbKm(NAIF_CODES.MOON, etSec);
  let sun = spk.positionRelativeToSsbKm(NAIF_CODES.SUN, etSec);
  let rel: Vec3 = [sun[0] - moon[0], sun[1] - moon[1], sun[2] - moon[2]];
  for (let i = 0; i < 2; i++) {
    const lightTimeS = norm(rel) / C_KM_S;
    sun = spk.positionRelativeToSsbKm(NAIF_CODES.SUN, etSec - lightTimeS);
    rel = [sun[0] - moon[0], sun[1] - moon[1], sun[2] - moon[2]];
  }
  return rel;
}

/**
 * Sub-solar point on the Moon at a UTC instant, entirely kernel-driven:
 * DE440 Chebyshev positions chained Moon→Sun, rotated by the integrated
 * MOON_PA orientation and the fixed PA→ME rotation.
 */
export function subSolarPointDE(utc: Date, kernels: DeKernels = loadDeKernels()): SubSolarPoint {
  const etSec = etSecondsTDB(utc);
  const moonToSun = moonToSunJ2000Km(kernels, etSec);
  const distanceM = norm(moonToSun) * 1000;
  const dirBody = apply(j2000ToMoonMEMatrix(kernels.pck, etSec), normalize(moonToSun));

  return {
    latitudeDeg: toDeg(Math.asin(Math.max(-1, Math.min(1, dirBody[2])))),
    longitudeDeg: norm180(toDeg(Math.atan2(dirBody[1], dirBody[0]))),
    distanceM,
    angularRadiusDeg: solarAngularRadiusDeg(distanceM),
    bodyFixedDirection: dirBody,
  };
}

/**
 * Solar azimuth/elevation at a selenographic site from the DE440 kernels.
 *
 * The local-basis construction duplicates `solarPositionAtSite` in
 * `solarGeometry.ts` (including its polar azimuth convention) rather than
 * refactoring that file — the analytic path's numbers must stay bit-identical
 * for reproducibility of existing sites.
 */
export function solarPositionAtSiteDE(
  utc: Date,
  siteLatitudeDeg: number,
  siteLongitudeDeg: number,
  kernels: DeKernels = loadDeKernels(),
): SolarPosition {
  const subSolar = subSolarPointDE(utc, kernels);
  const s = subSolar.bodyFixedDirection;

  const lat = toRad(siteLatitudeDeg);
  const lon = toRad(siteLongitudeDeg);
  const clat = Math.cos(lat);
  const slat = Math.sin(lat);
  const clon = Math.cos(lon);
  const slon = Math.sin(lon);

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

/** Result of holding the analytic chain up against the DE kernels. */
export interface DeAnalyticComparison {
  /** Angle between the DE and analytic sub-solar directions, degrees. */
  separationDeg: number;
  de: SubSolarPoint;
  analytic: SubSolarPoint;
}

/**
 * Angular difference between the kernel-driven and Meeus/IAU sub-solar
 * points at a UTC instant. This IS the long-sought validation of the
 * analytic path: its documented error budget (~0.01–0.03° from the IAU ME
 * realisation, ~0.01° from the series) predicts agreement well inside
 * 0.05°, and this function measures the actual number against JPL's
 * integrated truth.
 */
export function compareWithAnalytic(
  utc: Date,
  kernels: DeKernels = loadDeKernels(),
): DeAnalyticComparison {
  const de = subSolarPointDE(utc, kernels);
  const analytic = subSolarPoint(utc);
  const cosSep = Math.max(
    -1,
    Math.min(1, dot(de.bodyFixedDirection, analytic.bodyFixedDirection)),
  );
  return { separationDeg: toDeg(Math.acos(cosSep)), de, analytic };
}
