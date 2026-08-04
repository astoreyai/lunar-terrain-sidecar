/**
 * Bekker pressure–sinkage relations for a static rigid wheel (spec §22).
 *
 * STATIC ONLY (ADR 0005): everything here is an equilibrium quantity — the
 * sinkage a stationary wheel settles to and the resistance it would meet at
 * incipient motion. No slip, no time, no deformable contact; those belong to
 * the physics authority (spec §33, ADR 0003).
 *
 * Model [bekker1969, ch. on pressure–sinkage; wong2008 §2.3–2.5]:
 *
 *     p = (k_c / b + k_phi) · z^n
 *
 * with p ground pressure (Pa), b the smaller contact-patch dimension (here
 * the wheel width, m), z sinkage (m), and (k_c, k_phi, n) the soil moduli
 * from `parameters.ts`.
 */

import {
  LUNAR_GRAVITY_MS2,
  LUNAR_REGOLITH_PARAMETERS,
  type RegolithParameters,
} from './parameters.js';

/**
 * The reference vehicle the per-point assessment is computed for.
 *
 * Defaults are VIPER-class: 450 kg on four wheels, 0.20 m wide, 0.25 m
 * radius, under lunar gravity. Not a claim about any specific flight rover —
 * a fixed, documented reference so assessments are comparable across sites.
 */
export interface ReferenceVehicle {
  massKg: number;
  wheelCount: number;
  /** Wheel width b, metres — the smaller contact-patch dimension. */
  wheelWidthM: number;
  wheelRadiusM: number;
  gravityMS2: number;
}

export const REFERENCE_VEHICLE: ReferenceVehicle = {
  massKg: 450,
  wheelCount: 4,
  wheelWidthM: 0.2,
  wheelRadiusM: 0.25,
  gravityMS2: LUNAR_GRAVITY_MS2,
};

/** Combined sinkage modulus (k_c / b + k_phi), Pa/m^n [bekker1969]. */
export function sinkageModulus(params: RegolithParameters, wheelWidthM: number): number {
  return params.cohesiveModulusKc / wheelWidthM + params.frictionalModulusKphi;
}

/**
 * Sinkage of a flat plate of width b under uniform pressure p [bekker1969]:
 *
 *     z = (p / (k_c/b + k_phi))^(1/n)
 *
 * For n = 1 (the sourced lunar value) sinkage is exactly linear in pressure —
 * halving p halves z — which the validation test asserts.
 */
export function pressureSinkage(
  pressurePa: number,
  params: RegolithParameters,
  wheelWidthM: number,
): number {
  if (pressurePa <= 0) return 0;
  return Math.pow(pressurePa / sinkageModulus(params, wheelWidthM), 1 / params.sinkageExponent);
}

/** Result of the static-sinkage solve for one wheel. */
export interface StaticSinkage {
  /** Equilibrium sinkage z, metres. */
  sinkageM: number;
  /** Contact chord length l ≈ sqrt(D·z), metres. */
  contactLengthM: number;
  /** Contact area A = b·l, m². */
  contactAreaM2: number;
  /** Mean ground pressure p = W/A, Pa. */
  groundPressurePa: number;
}

/**
 * Static sinkage of one rigid wheel under vertical load W.
 *
 * CONTACT-PATCH APPROXIMATION (Wong's flat-plate simplification,
 * [wong2008 §2.5]): the curved wheel–soil interface is replaced by a flat
 * plate of width b and length equal to the contact chord,
 *
 *     l = sqrt(D·z − z²) ≈ sqrt(D·z)   (valid for z ≪ r),
 *
 * carrying the load at uniform pressure p = W / (b·l). Substituting into the
 * Bekker plate equation p = (k_c/b + k_phi)·z^n and writing k for the
 * combined modulus:
 *
 *     W = k · z^n · b · sqrt(D·z)  =  k · b · sqrt(D) · z^(n + 1/2)
 *  ⇒  z = ( W / (k · b · sqrt(D)) )^( 2 / (2n + 1) )
 *
 * This is the flat-plate form of Bekker's rigid-wheel sinkage; Bekker's own
 * pressure-distribution derivation carries an additional 3/(3−n) factor
 * inside the parenthesis [bekker1969; wong2008 eq. 2.51]. The flat-plate
 * simplification is documented (not hidden) because it is what makes the
 * n = 1 case exactly hand-checkable and keeps this a screening estimate
 * rather than a pretended high-fidelity contact model.
 */
export function staticSinkage(
  wheelLoadN: number,
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
  vehicle: ReferenceVehicle = REFERENCE_VEHICLE,
): StaticSinkage {
  const b = vehicle.wheelWidthM;
  const diameterM = 2 * vehicle.wheelRadiusM;
  if (wheelLoadN <= 0) {
    return { sinkageM: 0, contactLengthM: 0, contactAreaM2: 0, groundPressurePa: 0 };
  }
  const k = sinkageModulus(params, b);
  const sinkageM = Math.pow(
    wheelLoadN / (k * b * Math.sqrt(diameterM)),
    2 / (2 * params.sinkageExponent + 1),
  );
  const contactLengthM = Math.sqrt(diameterM * sinkageM);
  const contactAreaM2 = b * contactLengthM;
  return {
    sinkageM,
    contactLengthM,
    contactAreaM2,
    groundPressurePa: contactAreaM2 > 0 ? wheelLoadN / contactAreaM2 : 0,
  };
}

/**
 * Compaction resistance R_c of one wheel, Newtons [bekker1969; wong2008 §2.5].
 *
 * Derivation: the work done compacting soil from the surface to depth z, per
 * unit forward travel and per unit width, equals the area under the
 * pressure–sinkage curve,
 *
 *     ∫₀^z p(ζ) dζ = ∫₀^z k·ζ^n dζ = k · z^(n+1) / (n + 1)
 *
 * so for a wheel of width b,
 *
 *     R_c = b · k · z^(n+1) / (n + 1)
 *
 * which for n = 1 reduces to the hand-checkable
 *
 *     R_c = b · z² · (k_c/b + k_phi) / 2
 *
 * — the same structure as Wong's worked motion-resistance examples
 * [wong2008 §2.5], asserted against an independent hand computation in
 * `tests/terramech.test.ts`.
 */
export function compactionResistance(
  sinkageM: number,
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
  wheelWidthM: number = REFERENCE_VEHICLE.wheelWidthM,
): number {
  if (sinkageM <= 0) return 0;
  const k = sinkageModulus(params, wheelWidthM);
  const n = params.sinkageExponent;
  return (wheelWidthM * k * Math.pow(sinkageM, n + 1)) / (n + 1);
}
