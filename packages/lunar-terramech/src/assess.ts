/**
 * Per-sample static terramechanics assessment over a terrain layer
 * (spec §22, ADR 0005).
 *
 * Deterministic and pure: the same layer, parameters and vehicle always
 * produce the same assessment — no randomness, no clock, no I/O. Every
 * result carries {@link TERRAMECHANICS_PROVENANCE} so a consumer cannot
 * separate the numbers from the statement of their limits.
 */

import {
  heightAtWorld,
  sampleToWorld,
  slopeDegAtWorld,
  type TerrainLayer,
} from '@lts/shared-types';
import {
  LUNAR_REGOLITH_PARAMETERS,
  TERRAMECHANICS_PROVENANCE,
  type RegolithParameters,
  type TerramechanicsProvenance,
} from './parameters.js';
import { REFERENCE_VEHICLE, type ReferenceVehicle } from './bekker.js';
import { drawbarPull, slopeMarginDeg } from './traction.js';

/**
 * Traversability class thresholds (ADR 0005):
 * - 'go'      — DP at the local slope exceeds 20 % of available thrust
 *               (a reserve for the resistances this static model omits:
 *               bulldozing, rocks, steering losses);
 * - 'no-go'   — DP ≤ 0 (cannot advance even at full slip) OR static sinkage
 *               exceeds half the wheel radius (the flat-plate contact
 *               approximation itself has broken down by then);
 * - 'marginal'— everything between.
 */
export type TraversabilityClass = 'go' | 'marginal' | 'no-go';

export const GO_DRAWBAR_FRACTION_OF_THRUST = 0.2;
export const NO_GO_SINKAGE_FRACTION_OF_RADIUS = 0.5;

/** Static assessment at one point of a layer. */
export interface PointAssessment {
  xM: number;
  zM: number;
  /** Local slope from the layer's own surface normal, degrees. */
  slopeDeg: number;
  /** Static sinkage at the cos(slope)-reduced wheel load, m. */
  sinkageM: number;
  /** Net drawbar pull at the local slope, N (whole vehicle). */
  drawbarPullN: number;
  /** Total maximum thrust at the local slope, N (whole vehicle). */
  thrustN: number;
  /** Slope at which DP = 0 for this parameter set and vehicle, degrees. */
  slopeMarginDeg: number;
  class: TraversabilityClass;
  provenance: TerramechanicsProvenance;
}

function classify(
  drawbarPullN: number,
  thrustN: number,
  sinkageM: number,
  wheelRadiusM: number,
): TraversabilityClass {
  if (drawbarPullN <= 0 || sinkageM > NO_GO_SINKAGE_FRACTION_OF_RADIUS * wheelRadiusM) {
    return 'no-go';
  }
  if (drawbarPullN > GO_DRAWBAR_FRACTION_OF_THRUST * thrustN) return 'go';
  return 'marginal';
}

/**
 * Assess one world position on a layer. Returns null outside the layer
 * (where the surface, and therefore a slope, does not exist).
 */
export function assessAt(
  layer: TerrainLayer,
  xM: number,
  zM: number,
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
  vehicle: ReferenceVehicle = REFERENCE_VEHICLE,
): PointAssessment | null {
  if (!Number.isFinite(heightAtWorld(layer, xM, zM))) return null;
  const slopeDeg = slopeDegAtWorld(layer, xM, zM);
  const budget = drawbarPull(slopeDeg, params, vehicle);
  const marginDeg = slopeMarginDeg(params, vehicle);
  return {
    xM,
    zM,
    slopeDeg,
    sinkageM: budget.sinkageM,
    drawbarPullN: budget.drawbarPullN,
    thrustN: budget.thrustN,
    slopeMarginDeg: marginDeg,
    class: classify(budget.drawbarPullN, budget.thrustN, budget.sinkageM, vehicle.wheelRadiusM),
    provenance: TERRAMECHANICS_PROVENANCE,
  };
}

/** Grid assessment of a whole layer: one entry per sample, row-major. */
export interface LayerAssessment {
  layerId: string;
  widthSamples: number;
  heightSamples: number;
  /** Local slope per sample, degrees. */
  slopeDeg: Float32Array;
  /** Static sinkage per sample, m. */
  sinkageM: Float32Array;
  /** Net drawbar pull per sample, N. */
  drawbarPullN: Float32Array;
  /**
   * Class per sample: 0 = go, 1 = marginal, 2 = no-go
   * (indexes {@link LAYER_ASSESSMENT_CLASSES}).
   */
  classes: Uint8Array;
  /** Vehicle/soil slope margin (a property of the parameter set), degrees. */
  slopeMarginDeg: number;
  provenance: TerramechanicsProvenance;
}

/** On-wire encoding of {@link LayerAssessment.classes}. Append only. */
export const LAYER_ASSESSMENT_CLASSES: readonly TraversabilityClass[] = [
  'go',
  'marginal',
  'no-go',
];

/**
 * Assess every sample of a layer.
 *
 * The slope margin and the DP(theta) curve depend only on (params, vehicle),
 * so the per-sample work is one slope lookup plus one drawbar evaluation —
 * deterministic and embarrassingly parallel, but kept single-threaded: this
 * is an analysis query, not a generation stage.
 */
export function assessLayer(
  layer: TerrainLayer,
  params: RegolithParameters = LUNAR_REGOLITH_PARAMETERS,
  vehicle: ReferenceVehicle = REFERENCE_VEHICLE,
): LayerAssessment {
  const count = layer.widthSamples * layer.heightSamples;
  const slopeDeg = new Float32Array(count);
  const sinkageM = new Float32Array(count);
  const drawbarPullN = new Float32Array(count);
  const classes = new Uint8Array(count);
  const marginDeg = slopeMarginDeg(params, vehicle);
  for (let row = 0; row < layer.heightSamples; row++) {
    for (let col = 0; col < layer.widthSamples; col++) {
      const i = row * layer.widthSamples + col;
      const { x, z } = sampleToWorld(layer, col, row);
      const s = slopeDegAtWorld(layer, x, z);
      const budget = drawbarPull(s, params, vehicle);
      slopeDeg[i] = s;
      sinkageM[i] = budget.sinkageM;
      drawbarPullN[i] = budget.drawbarPullN;
      classes[i] = LAYER_ASSESSMENT_CLASSES.indexOf(
        classify(budget.drawbarPullN, budget.thrustN, budget.sinkageM, vehicle.wheelRadiusM),
      );
    }
  }
  return {
    layerId: layer.id,
    widthSamples: layer.widthSamples,
    heightSamples: layer.heightSamples,
    slopeDeg,
    sinkageM,
    drawbarPullN,
    classes,
    slopeMarginDeg: marginDeg,
    provenance: TERRAMECHANICS_PROVENANCE,
  };
}
