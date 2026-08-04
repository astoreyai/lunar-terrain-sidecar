/**
 * Static traction budget: maximum thrust, gradient resistance, drawbar pull
 * and the slope margin (spec §22, ADR 0005).
 *
 * The decomposition DP = H − R_c − R_g is the standard drawbar-pull balance
 * for planetary rovers on loose soil [ishigami2007; wong2008 ch. 2].
 *
 * STATIC ONLY: H here is the Mohr–Coulomb MAXIMUM thrust — the full-slip
 * asymptote of the Janosi–Hanamoto shear curve [janosi1961]
 *     H(i) = H_max · (1 − K/(i·l) · (1 − e^(−i·l/K)))
 * whose slip-dependence this layer deliberately never evaluates: slip is a
 * dynamic state owned by the physics authority (spec §33, ADR 0003). The
 * shear modulus K is carried in the parameter block for that consumer.
 */

import {
  LUNAR_REGOLITH_PARAMETERS,
  type RegolithParameters,
} from './parameters.js';
import {
  REFERENCE_VEHICLE,
  compactionResistance,
  staticSinkage,
  type ReferenceVehicle,
} from './bekker.js';

const DEG = Math.PI / 180;

/**
 * Maximum (full-slip, Mohr–Coulomb) thrust of one wheel, Newtons
 * [bekker1969; wong2008 eq. 2.60; janosi1961 as the slip law whose asymptote
 * this is]:
 *
 *     H = A·c + W·tan(phi)
 *
 * with A the contact area (m²), c cohesion (Pa), W the wheel's normal load
 * (N) and phi the internal friction angle. At c = 0 this reduces exactly to
 * W·tan(phi) — asserted in the validation test.
 */
export function maxThrustPerWheel(
  contactAreaM2: number,
  wheelLoadN: number,
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
): number {
  return contactAreaM2 * params.cohesionPa + wheelLoadN * Math.tan(params.frictionAngleDeg * DEG);
}

/**
 * Gradient (slope-climbing) resistance of the whole vehicle, Newtons
 * [wong2008; ishigami2007]: the downslope component of weight,
 *
 *     R_g(theta) = m·g·sin(theta)
 */
export function gradientResistance(vehicle: ReferenceVehicle, slopeDeg: number): number {
  return vehicle.massKg * vehicle.gravityMS2 * Math.sin(slopeDeg * DEG);
}

/** The full static traction budget at one slope angle. */
export interface DrawbarBudget {
  slopeDeg: number;
  /** Per-wheel normal load W = (m·g/wheels)·cos(theta), N. */
  wheelLoadN: number;
  /** Static sinkage at that load, m. */
  sinkageM: number;
  /** Contact area per wheel, m². */
  contactAreaM2: number;
  /** Total maximum thrust across all wheels, N. */
  thrustN: number;
  /** Total compaction resistance across all wheels, N. */
  compactionResistanceN: number;
  /** Gradient resistance, N. */
  gradientResistanceN: number;
  /** Net drawbar pull DP = H − R_c − R_g, N. */
  drawbarPullN: number;
}

/**
 * Net drawbar pull at a slope angle theta [ishigami2007; wong2008]:
 *
 *     DP(theta) = H_total(theta) − R_c_total(theta) − R_g(theta)
 *
 * Load transfer along a uniform slope reduces each wheel's NORMAL load to
 * (m·g/wheels)·cos(theta), which is what sinkage, contact area and thrust
 * are computed from; the sin(theta) component appears as gradient
 * resistance. Purely static: equal load split across wheels, no
 * longitudinal load transfer (that is a dynamic effect).
 */
export function drawbarPull(
  slopeDeg: number,
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
  vehicle: ReferenceVehicle = REFERENCE_VEHICLE,
): DrawbarBudget {
  const weightN = vehicle.massKg * vehicle.gravityMS2;
  const wheelLoadN = (weightN / vehicle.wheelCount) * Math.cos(slopeDeg * DEG);
  const s = staticSinkage(wheelLoadN, params, vehicle);
  const thrustN = vehicle.wheelCount * maxThrustPerWheel(s.contactAreaM2, wheelLoadN, params);
  const compactionResistanceN =
    vehicle.wheelCount * compactionResistance(s.sinkageM, params, vehicle.wheelWidthM);
  const gradientResistanceN = gradientResistance(vehicle, slopeDeg);
  return {
    slopeDeg,
    wheelLoadN,
    sinkageM: s.sinkageM,
    contactAreaM2: s.contactAreaM2,
    thrustN,
    compactionResistanceN,
    gradientResistanceN,
    drawbarPullN: thrustN - compactionResistanceN - gradientResistanceN,
  };
}

/**
 * Slope margin: the angle theta (degrees) at which DP(theta) = 0 — the
 * static limit of gradeability for the parameter set and vehicle.
 *
 * DP(0) > 0 and DP(90°) = −m·g < 0, and DP is strictly decreasing in theta
 * for physically meaningful parameters (thrust and the cos-load terms fall,
 * gradient resistance rises; asserted over the full range in the tests), so
 * a bisection bracket [0°, 90°] converges to the unique root. No closed form
 * exists because contact area scales as cos^(1/(2n+1)) theta.
 *
 * Returns 0 when DP(0) ≤ 0 (the vehicle cannot move on flat ground with
 * these parameters — a fact worth returning honestly rather than erroring).
 */
export function slopeMarginDeg(
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
  vehicle: ReferenceVehicle = REFERENCE_VEHICLE,
): number {
  const dp = (deg: number): number => drawbarPull(deg, params, vehicle).drawbarPullN;
  if (dp(0) <= 0) return 0;
  let lo = 0;
  let hi = 90;
  // 60 halvings take the 90° bracket below 1e-16 degrees — the limit of
  // double precision near the root, so DP(margin) is 0 to well under 1e-9 N.
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (dp(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
