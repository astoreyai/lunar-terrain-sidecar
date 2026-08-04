/**
 * Sourced lunar regolith terramechanics parameters (spec §22, ADR 0005).
 *
 * Every constant here is a published value with its citation inline; nothing
 * is tuned to make the assessment "look right". The bibliography keys refer to
 * `paper/paper.bib`. The applicability limits are exported as
 * {@link TERRAMECHANICS_PROVENANCE} and travel with every RPC response that
 * uses this model — a consumer must never receive a number from this package
 * without also receiving the statement of where the number came from and
 * where it does NOT apply.
 */

/** Bekker–Wong soil parameter set for the static assessment. */
export interface RegolithParameters {
  /**
   * Bekker cohesive modulus k_c, Pa/m^(n-1).
   * Source: NASA LTV terramechanics white paper, NTRS 20220010732
   * [li2022terramechanics]: k_c = 1400 Pa/m^(n-1) for lunar regolith.
   */
  cohesiveModulusKc: number;
  /**
   * Bekker frictional modulus k_phi, Pa/m^n.
   * Source: NTRS 20220010732 [li2022terramechanics]: k_phi = 820 000 Pa/m^n.
   */
  frictionalModulusKphi: number;
  /**
   * Bekker sinkage exponent n (dimensionless).
   * Source: NTRS 20220010732 [li2022terramechanics]: n = 1.0.
   */
  sinkageExponent: number;
  /**
   * Soil cohesion c, Pa.
   * Source: NTRS 20220010732 [li2022terramechanics]: c = 170 Pa.
   * Cross-check: inside the Apollo in-situ range of Mitchell et al. (1972)
   * [mitchell1972], 0.1–1 kPa — see {@link MITCHELL_1972_APOLLO_RANGES}.
   */
  cohesionPa: number;
  /**
   * Internal friction angle phi, degrees.
   * Source: NTRS 20220010732 [li2022terramechanics]: phi = 35°.
   * Cross-check: inside Mitchell et al. (1972) [mitchell1972], 30–50°.
   */
  frictionAngleDeg: number;
  /**
   * Janosi–Hanamoto shear deformation modulus K, metres [janosi1961].
   *
   * REPRESENTATIVE value, not site-measured: Wong (2008) [wong2008] gives
   * K ≈ 0.01–0.025 m for loose sand; 0.018 m is a typical lunar-regolith
   * value inside that range. K governs how thrust develops with slip
   * — a DYNAMIC quantity this static layer never evaluates (spec §33,
   * ADR 0005). It is carried here so the parameter set handed to the
   * physics authority is complete, and so the static maximum thrust is
   * explicitly understood as the full-slip asymptote of the Janosi curve.
   */
  janosiShearModulusM: number;
  /**
   * Bulk density of the upper regolith, kg/m³ — descriptive soil state,
   * not used in the Bekker arithmetic (wheel load enters through vehicle
   * mass and gravity, not soil density). Recorded so the parameter block
   * documents the assumed soil condition. 1660 kg/m³ sits inside the
   * Apollo in-situ range 1500–1750 kg/m³ of Mitchell et al. (1972)
   * [mitchell1972] for the upper regolith.
   */
  bulkDensityKgM3: number;
}

/**
 * The sourced parameter set (NTRS 20220010732 [li2022terramechanics] except
 * where noted on each field above).
 */
export const LUNAR_REGOLITH_PARAMETERS: RegolithParameters = {
  cohesiveModulusKc: 1400, // Pa/m^(n-1) [li2022terramechanics]
  frictionalModulusKphi: 820_000, // Pa/m^n [li2022terramechanics]
  sinkageExponent: 1.0, // [li2022terramechanics]
  cohesionPa: 170, // [li2022terramechanics]; in Mitchell 1972 range 100–1000 Pa
  frictionAngleDeg: 35, // [li2022terramechanics]; in Mitchell 1972 range 30–50°
  janosiShearModulusM: 0.018, // representative; Wong 2008 loose sand 0.01–0.025 m
  bulkDensityKgM3: 1660, // descriptive; in Mitchell 1972 range 1500–1750 kg/m³
};

/**
 * Apollo in-situ ranges from Mitchell et al. (1972) [mitchell1972],
 * "Mechanical properties of lunar soil: density, porosity, cohesion, and
 * angle of internal friction", Proc. Third Lunar Science Conf.
 *
 * These are the CROSS-CHECK for the chosen point values above: the point
 * values must sit inside these measured ranges (asserted in
 * `tests/terramech.test.ts`), otherwise the parameter set has drifted from
 * what was actually measured on the Moon.
 */
export const MITCHELL_1972_APOLLO_RANGES = {
  /** Upper-regolith bulk density, kg/m³. */
  bulkDensityKgM3: { min: 1500, max: 1750 },
  /** Cohesion, Pa (0.1–1 kPa). */
  cohesionPa: { min: 100, max: 1000 },
  /** Internal friction angle, degrees. */
  frictionAngleDeg: { min: 30, max: 50 },
} as const;

/** Standard lunar surface gravitational acceleration, m/s². */
export const LUNAR_GRAVITY_MS2 = 1.62;

/**
 * PROVENANCE BLOCK — travels with every RPC response that uses this model.
 *
 * The single most important honesty statement in this package: the numbers
 * above are real published values, but they were measured where they were
 * measured, and the model is a static screening estimate, not a validated
 * force prediction (ADR 0005).
 */
export const TERRAMECHANICS_PROVENANCE = {
  model: 'Bekker-Wong static terramechanics assessment',
  citations: [
    'bekker1969',
    'wong2008',
    'janosi1961',
    'ishigami2007',
    'mitchell1972',
    'li2022terramechanics',
  ],
  parameterSource:
    'NASA LTV terramechanics white paper, NTRS 20220010732 [li2022terramechanics]; ' +
    'Janosi K is a representative loose-sand value from the Wong (2008) range ' +
    '0.01-0.025 m, not site-measured.',
  siteApplicability:
    'Parameters are equatorial-Apollo/simulant-derived. NO polar site has ' +
    'in-situ soil measurements; applying these parameters to a polar site is ' +
    'an extrapolation, not a measurement.',
  gravityCaveat:
    'Low-gravity effects on k_phi and cohesion are unsettled; the NTRS white ' +
    'paper itself cautions that parameters derived from Earth-gravity simulant ' +
    'testing may not transfer directly to 1/6 g.',
  scope:
    'STATIC assessment only: no wheel-slip time histories, no deformable ' +
    'contact, no dynamic wheel-soil simulation. The physics authority ' +
    '(Godot/Chrono) owns dynamics (spec §33, ADR 0003, ADR 0005).',
  accuracy:
    'A screening estimate for relative go/no-go classification. NOT claiming ' +
    'force-accuracy; no in-situ validation data exists for the sites this ' +
    'system targets (ADR 0005).',
} as const;

export type TerramechanicsProvenance = typeof TERRAMECHANICS_PROVENANCE;
