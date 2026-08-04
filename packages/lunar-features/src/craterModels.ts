/**
 * Literature-anchored lunar crater models (spec §8, user direction:
 * "literature-anchored primary").
 *
 * Every constant here traces to a published source, tagged inline. The free
 * parametric model of spec §8 remains available as an override, but the default
 * population is drawn from the production/equilibrium curves so a generated
 * site has a defensible crater density rather than an invented one.
 *
 * Sources:
 *   - Neukum, Ivanov & Hartmann (2001), "Cratering records in the inner solar
 *     system in relation to the lunar reference system", *Space Science
 *     Reviews* 96:55–86 — production function polynomial and chronology.
 *   - Xiao & Werner (2015), "Change of crater size-frequency distribution with
 *     crater degradation and implications for lunar surface ages", *JGR
 *     Planets* 120:2277–2292 — empirical equilibrium (saturation) density.
 *   - Pike (1977), "Size-dependence in the shape of fresh impact craters on the
 *     Moon", in *Impact and Explosion Cratering* — simple-crater depth/diameter
 *     and rim height.
 *   - Stopar et al. (2017), "Relative depths of simple craters and the nature
 *     of the lunar regolith", *Icarus* 298:34–48 — shallowing of d/D below
 *     ~400 m.
 *   - McGetchin, Settle & Head (1973), "Radial thickness variation in impact
 *     crater ejecta", *EPSL* 20:226–236 — ejecta blanket thickness.
 */

/**
 * Neukum production function coefficients for the Moon (Neukum et al. 2001,
 * Table 1), giving
 *
 *     log10 N(≥D) = Σ aᵢ (log10 D)ⁱ      [N in craters/km², D in km]
 *
 * for a reference surface age of 1 Ga. Valid over 0.01 km ≤ D ≤ 300 km; the
 * caller is responsible for staying in range (see {@link NEUKUM_VALID_RANGE_KM}).
 */
export const NEUKUM_COEFFICIENTS = [
  -3.0876, -3.557528, 0.781027, 1.021521, -0.156012, -0.444058, 0.019977, 0.08685, -0.005874,
  -0.006809, 8.25e-4, 5.54e-5,
] as const;

/** Diameter range, km, over which the Neukum polynomial is defined. */
export const NEUKUM_VALID_RANGE_KM: readonly [number, number] = [0.01, 300];

/**
 * Cumulative crater density at 1 Ga, craters/km² with diameter ≥ D.
 *
 * @param diameterKm crater diameter, kilometres
 */
export function neukumProductionAt1Ga(diameterKm: number): number {
  const x = Math.log10(diameterKm);
  let logN = 0;
  let xp = 1;
  for (const a of NEUKUM_COEFFICIENTS) {
    logN += a * xp;
    xp *= x;
  }
  return Math.pow(10, logN);
}

/**
 * Neukum lunar chronology: cumulative density of craters ≥ 1 km, per km², on a
 * surface of age `T` Ga.
 *
 *     N(1, T) = 5.44e-14 (e^(6.93 T) − 1) + 8.38e-4 T
 *
 * The exponential term carries the Late Heavy Bombardment; the linear term is
 * the roughly constant recent flux.
 */
export function neukumChronology(ageGa: number): number {
  return 5.44e-14 * (Math.exp(6.93 * ageGa) - 1) + 8.38e-4 * ageGa;
}

/**
 * Local cumulative slope `d log N / d log D` of the production function at the
 * lower edge of its validity range.
 *
 * Computed once by finite difference just inside the valid interval, and used
 * to continue the curve to smaller diameters (see
 * {@link productionDensityExtended}).
 */
export const NEUKUM_SMALL_D_SLOPE = (() => {
  const d0 = NEUKUM_VALID_RANGE_KM[0];
  const d1 = d0 * 1.01;
  return (
    (Math.log(neukumProductionAt1Ga(d1)) - Math.log(neukumProductionAt1Ga(d0))) /
    (Math.log(d1) - Math.log(d0))
  );
})();

/**
 * Production density at 1 Ga, **continued below the polynomial's 10 m floor**.
 *
 * The Neukum polynomial is a degree-11 fit valid only over 0.01–300 km.
 * Evaluating it below 10 m is meaningless — a high-order polynomial diverges
 * wildly outside its fitted range — but *clamping* the diameter to the floor is
 * worse: it hands a 0.5 m crater the density of a 10 m one, understating the
 * true count by four orders of magnitude and stopping the equilibrium cap from
 * ever binding.
 *
 * Below the floor the curve is continued as a power law with the polynomial's
 * own slope at the floor. This is an **extrapolation, not a fitted result**;
 * for ancient surfaces it barely matters, because the equilibrium cap governs
 * that whole regime anyway.
 */
export function productionDensityExtended(diameterKm: number, ageGa: number): number {
  const floor = NEUKUM_VALID_RANGE_KM[0];
  const scale = neukumChronology(ageGa) / neukumChronology(1.0);
  if (diameterKm >= floor) {
    return neukumProductionAt1Ga(diameterKm) * scale;
  }
  const atFloor = neukumProductionAt1Ga(floor);
  return atFloor * Math.pow(diameterKm / floor, NEUKUM_SMALL_D_SLOPE) * scale;
}

/**
 * Cumulative crater density on a surface of age `ageGa`, craters/km² with
 * diameter ≥ `diameterKm`.
 *
 * The production polynomial supplies the *shape* of the size-frequency
 * distribution; the chronology scales it to the surface age by the ratio of
 * N(1 km) values. Valid only within {@link NEUKUM_VALID_RANGE_KM}; use
 * {@link productionDensityExtended} to go below it.
 */
export function productionDensity(diameterKm: number, ageGa: number): number {
  const shape = neukumProductionAt1Ga(diameterKm);
  const scale = neukumChronology(ageGa) / neukumChronology(1.0);
  return shape * scale;
}

/**
 * Empirical equilibrium (saturation) density, Xiao & Werner (2015):
 *
 *     n(≥D) = 0.084 D⁻²
 *
 * Source locus: Xiao & Werner (2015) report lunar crater equilibrium at a
 * few percent of geometric saturation; 0.084·D⁻² equals 5.5% of the Trask
 * geometric-saturation curve 1.54·D⁻², the level their study characterises
 * for small lunar craters. The single-coefficient power law is the standard
 * summary form of that finding.
 *
 * Scale-free: `n` and `D` share length units, so `n·D² = 0.084` — a surface in
 * equilibrium keeps a fixed fractional coverage regardless of scale, because it
 * erases small craters as fast as it gains them.
 *
 * @returns craters per m² with diameter ≥ `diameterM`
 */
export const EQUILIBRIUM_COEFFICIENT = 0.084;

export function equilibriumDensity(diameterM: number): number {
  return EQUILIBRIUM_COEFFICIENT * Math.pow(diameterM, -2);
}

/**
 * Expected cumulative crater density, craters per m², capped at equilibrium.
 *
 *     N(≥D) = min( production(D, T), equilibrium(D) )
 *
 * The cap is what stops an old surface from being handed a physically
 * impossible number of small craters: on a 3.5 Ga surface the production
 * function alone would place far more sub-metre craters than can coexist.
 */
export function cappedCumulativeDensityPerM2(diameterM: number, ageGa: number): number {
  const diameterKm = diameterM / 1000;
  // productionDensityExtended is per km²; convert to per m².
  const production = productionDensityExtended(diameterKm, ageGa) / 1e6;
  const equilibrium = equilibriumDensity(diameterM);
  return Math.min(production, equilibrium);
}

/**
 * Depth/diameter ratio of a **fresh** simple lunar crater.
 *
 * Pike (1977) established d/D ≈ 0.2 for fresh simple craters above a few
 * hundred metres. Stopar et al. (2017) showed the ratio falls for smaller
 * craters as they bottom out within the regolith, reaching roughly 0.11–0.13 at
 * metre scale.
 *
 * The branch below 400 m is a **log-linear interpolation between those two
 * published endpoints**, not a coefficient quoted from either paper — flagged
 * here rather than presented as a fit.
 */
export function freshDepthDiameterRatio(diameterM: number): number {
  const D_PIKE = 400; // m — above this, Pike's 0.2 holds
  const R_PIKE = 0.2;
  const D_SMALL = 1.0; // m
  const R_SMALL = 0.11;

  if (diameterM >= D_PIKE) return R_PIKE;
  if (diameterM <= D_SMALL) return R_SMALL;
  const t = Math.log(diameterM / D_SMALL) / Math.log(D_PIKE / D_SMALL);
  return R_SMALL + t * (R_PIKE - R_SMALL);
}

/**
 * Rim height of a fresh simple crater, metres.
 *
 * Pike (1977): h_r = 0.036 D^1.014 with both in kilometres. The exponent is
 * close to 1, so this is *nearly* proportional — the earlier shorthand of a
 * flat 4% overshot the source by ~14% across the 1–400 m synthesis range
 * (3.51 m vs 4.0 m at D = 100 m), and at grazing polar sun a rim's shadow
 * length scales directly with its height.
 */
export const PIKE_RIM_COEFFICIENT = 0.036;
export const PIKE_RIM_EXPONENT = 1.014;

export function freshRimHeight(diameterM: number): number {
  const dKm = diameterM / 1000;
  return PIKE_RIM_COEFFICIENT * Math.pow(dKm, PIKE_RIM_EXPONENT) * 1000;
}

/**
 * Ejecta blanket thickness at radial distance `rM` from the centre of a crater
 * of radius `craterRadiusM`, metres (McGetchin, Settle & Head 1973):
 *
 *     t(r) = 0.14 R^0.74 (r/R)^-3     for r ≥ R
 *
 * The r⁻³ falloff is steep: at two crater radii the blanket is already an
 * eighth of its rim value, which is why ejecta reads as a tight collar rather
 * than a broad apron.
 */
export function mcgetchinEjectaThickness(craterRadiusM: number, rM: number): number {
  if (rM < craterRadiusM) return 0;
  const rimThickness = 0.14 * Math.pow(craterRadiusM, 0.74);
  return rimThickness * Math.pow(rM / craterRadiusM, -3);
}

/** Ejecta thickness at the rim itself, metres. */
export function ejectaRimThickness(craterRadiusM: number): number {
  return 0.14 * Math.pow(craterRadiusM, 0.74);
}

/**
 * Radial distance at which the ejecta blanket falls below `cutoffM`, metres.
 *
 * Used to bound the stamp: beyond this the contribution is below the
 * heightfield's own quantisation and stamping it only costs time.
 */
export function ejectaExtent(craterRadiusM: number, cutoffM: number): number {
  const rim = ejectaRimThickness(craterRadiusM);
  if (rim <= cutoffM) return craterRadiusM;
  return craterRadiusM * Math.cbrt(rim / cutoffM);
}

/**
 * Central peaks appear in lunar craters above the simple-to-complex transition,
 * ~15–20 km on the Moon. Any crater this generator synthesises below the DEM's
 * effective resolution is far smaller, so peaks are effectively never produced
 * — the flag exists so an authored large crater can still request one.
 */
export const SIMPLE_TO_COMPLEX_TRANSITION_M = 15_000;

export function hasCentralPeak(diameterM: number): boolean {
  return diameterM >= SIMPLE_TO_COMPLEX_TRANSITION_M;
}
