/**
 * `@lts/lunar-terramech` — static Bekker–Wong terramechanics assessment
 * (spec §22, ADR 0005).
 *
 * Upgrades traversability from the hand-weighted heuristic in the sidecar to
 * a model-based estimate with sourced parameters. STATIC assessment only:
 * equilibrium sinkage, maximum (full-slip) thrust, drawbar pull and slope
 * margin. No wheel-soil dynamics, no slip time histories, no deformable
 * contact — the physics authority (Godot/Chrono) owns dynamics (spec §33,
 * ADR 0003). Every output carries the parameter provenance block, including
 * the statement that no polar site has in-situ soil measurements.
 */

export {
  LUNAR_GRAVITY_MS2,
  LUNAR_REGOLITH_PARAMETERS,
  MITCHELL_1972_APOLLO_RANGES,
  TERRAMECHANICS_PROVENANCE,
  type RegolithParameters,
  type TerramechanicsProvenance,
} from './parameters.js';
export {
  REFERENCE_VEHICLE,
  compactionResistance,
  pressureSinkage,
  sinkageModulus,
  staticSinkage,
  type ReferenceVehicle,
  type StaticSinkage,
} from './bekker.js';
export {
  drawbarPull,
  gradientResistance,
  maxThrustPerWheel,
  slopeMarginDeg,
  type DrawbarBudget,
} from './traction.js';
export {
  GO_DRAWBAR_FRACTION_OF_THRUST,
  LAYER_ASSESSMENT_CLASSES,
  NO_GO_SINKAGE_FRACTION_OF_RADIUS,
  assessAt,
  assessLayer,
  type LayerAssessment,
  type PointAssessment,
  type TraversabilityClass,
} from './assess.js';
