/**
 * Lunar body-fixed frames from the DE440 kernels: J2000 → Principal Axes (PA)
 * from the binary PCK's integrated Euler angles, then PA → Mean Earth (ME)
 * via the fixed rotation published in the frames kernel.
 *
 * ## Conventions (verified against CSPICE, see tests/lunar-solar.de.test.ts)
 *
 * SPICE composes **frame** (passive) rotations `[θ]ᵢ`, which are the
 * transposes of this package's active `rotX/rotY/rotZ`. The two constructions
 * used here were both confirmed numerically against `pxform` from CSPICE
 * N0067 on the real kernels (max element deviation 2.8e-11 for the PA matrix
 * — single-double JD rounding in the probe — and 5.4e-20 for the fixed
 * PA→ME rotation):
 *
 *   J2000→PA = [w]₃ [δ]₁ [φ]₃            (3-1-3 Euler angles from the PCK)
 *   PA→ME    = ( [a₁]₃ [a₂]₂ [a₃]₁ )ᵀ    (TKFRAME angles from the .tf)
 */

import { matMul, rotX, rotY, rotZ, type Mat3 } from '../vec.js';
import { BinaryPckFile, MOON_PA_DE440_CLASS_ID } from './pck.js';

/**
 * Fixed rotation MOON_PA_DE440 → MOON_ME_DE440_ME421, specified as TKFRAME
 * Euler angles in `/mnt/projects/datasets/spice_kernels/moon_de440_250416.tf`
 * (Bachman, NAIF/JPL, 2025-04-16):
 *
 *   TKFRAME_31009_SPEC     = 'ANGLES'
 *   TKFRAME_31009_RELATIVE = 'MOON_PA_DE440'
 *   TKFRAME_31009_ANGLES   = (   67.8526   78.6944   0.2785  )
 *   TKFRAME_31009_AXES     = (   3,        2,        1       )
 *   TKFRAME_31009_UNITS    = 'ARCSECONDS'
 *
 * Equivalently (Park et al. 2021, the DE440 report): rotate from the DE440 PA
 * frame to the DE421 mean-Earth frame by −67.8526″ about Z, then −78.6944″
 * about Y, then −0.2785″ about X. The total rotation is ~0.0288°, i.e. the
 * PA→ME correction moves surface coordinates by roughly 875 m — this constant
 * is exactly the term the analytic IAU chain realises only approximately.
 */
export const PA_TO_ME_ANGLES_ARCSEC = [67.8526, 78.6944, 0.2785] as const;

const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

function paToMeMatrixOnce(): Mat3 {
  const [a1, a2, a3] = PA_TO_ME_ANGLES_ARCSEC.map((a) => a * ARCSEC_TO_RAD);
  // The TKFRAME matrix [a1]₃[a2]₂[a3]₁ (SPICE frame rotations, [θ]ᵢ = activeᵀ
  // = active(−θ)) maps the defined frame ME to its RELATIVE frame PA; the
  // PA→ME map is its transpose,
  //   ([a1]₃[a2]₂[a3]₁)ᵀ = (rotZ(−a1)·rotY(−a2)·rotX(−a3))ᵀ
  //                      = rotX(a3)·rotY(a2)·rotZ(a1)
  // in this package's active-rotation primitives.
  return matMul(rotX(a3), matMul(rotY(a2), rotZ(a1)));
}

/** Constant rotation PA(DE440) → ME(DE440/ME421), row-major. */
export const PA_TO_ME_MATRIX: Mat3 = paToMeMatrixOnce();

/**
 * Matrix rotating a J2000 vector into the MOON_PA_DE440 frame at `etSec`
 * (TDB seconds past J2000), from the binary PCK's 3-1-3 Euler angles:
 * J2000→PA = [w]₃ [δ]₁ [φ]₃, with [θ]ᵢ = activeᵀ = active(−θ).
 */
export function j2000ToMoonPAMatrix(pck: BinaryPckFile, etSec: number): Mat3 {
  const { phiRad, deltaRad, wRad } = pck.eulerAngles(MOON_PA_DE440_CLASS_ID, etSec);
  return matMul(rotZ(-wRad), matMul(rotX(-deltaRad), rotZ(-phiRad)));
}

/**
 * Matrix rotating a J2000 vector into the lunar Mean Earth frame
 * (MOON_ME_DE440_ME421) at `etSec` — the frame the LOLA products and this
 * project's selenographic coordinates live in.
 */
export function j2000ToMoonMEMatrix(pck: BinaryPckFile, etSec: number): Mat3 {
  return matMul(PA_TO_ME_MATRIX, j2000ToMoonPAMatrix(pck, etSec));
}
