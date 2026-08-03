/**
 * Analysis overlays for the viewport (spec §13).
 *
 * Each overlay maps a per-vertex scalar to a colour. The mapping functions are
 * pure so they can be unit-tested without a GPU — the colour of an "unsafe
 * slope" is a safety-relevant claim, not decoration.
 *
 * Palettes are chosen to stay legible for the most common colour-vision
 * deficiencies: the slope and traversability ramps run dark-blue → yellow
 * rather than red → green.
 */

export type OverlayMode =
  | 'lit'
  | 'elevation'
  | 'slope'
  | 'roughness'
  | 'traversability'
  | 'semantic';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function ramp(stops: Array<[number, Rgb]>, t: number): Rgb {
  const x = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
      return { r: lerp(c0.r, c1.r, f), g: lerp(c0.g, c1.g, f), b: lerp(c0.b, c1.b, f) };
    }
  }
  return stops[stops.length - 1][1];
}

/** Viridis-like ramp: perceptually ordered and colour-blind safe. */
const VIRIDIS: Array<[number, Rgb]> = [
  [0.0, { r: 0.267, g: 0.005, b: 0.329 }],
  [0.25, { r: 0.229, g: 0.322, b: 0.545 }],
  [0.5, { r: 0.127, g: 0.567, b: 0.551 }],
  [0.75, { r: 0.369, g: 0.789, b: 0.383 }],
  [1.0, { r: 0.993, g: 0.906, b: 0.144 }],
];

/** Elevation heatmap, normalised between the layer's own min and max. */
export function elevationColor(elevation: number, min: number, max: number): Rgb {
  const t = max > min ? (elevation - min) / (max - min) : 0.5;
  return ramp(VIRIDIS, t);
}

/**
 * Slope heatmap in degrees.
 *
 * The ramp saturates at 25°, the same threshold the semantic classifier uses
 * for `unsafe_slope`, so the picture and the classification agree instead of
 * telling different stories.
 */
export const UNSAFE_SLOPE_DEG = 25;

export function slopeColor(slopeDeg: number): Rgb {
  return ramp(VIRIDIS, slopeDeg / UNSAFE_SLOPE_DEG);
}

/** Roughness heatmap, normalised against a reference RMS in metres. */
export function roughnessColor(roughnessM: number, referenceM: number): Rgb {
  return ramp(VIRIDIS, referenceM > 0 ? roughnessM / referenceM : 0);
}

/**
 * Traversability heatmap, 0 (impassable) … 1 (easy).
 *
 * SYNTHETIC HEURISTIC (spec §22). The viewport legend carries that label so a
 * viewer cannot read this as a validated mobility prediction.
 */
export function traversabilityColor(score: number): Rgb {
  return ramp(VIRIDIS, score);
}

/**
 * Semantic class colours. Index order matches `SEMANTIC_CLASSES` in
 * `@lts/shared-types`; a mismatch would mislabel terrain, so a test pins the
 * two lists together.
 */
export const SEMANTIC_COLORS: Rgb[] = [
  { r: 0.35, g: 0.35, b: 0.35 }, // unknown
  { r: 0.72, g: 0.70, b: 0.66 }, // flat_regolith
  { r: 0.55, g: 0.52, b: 0.48 }, // rough_regolith
  { r: 0.30, g: 0.38, b: 0.55 }, // crater_floor
  { r: 0.45, g: 0.55, b: 0.72 }, // crater_wall
  { r: 0.85, g: 0.80, b: 0.55 }, // crater_rim
  { r: 0.62, g: 0.42, b: 0.30 }, // rock_field
  { r: 0.90, g: 0.65, b: 0.25 }, // berm
  { r: 0.40, g: 0.25, b: 0.45 }, // trench
  { r: 0.55, g: 0.65, b: 0.60 }, // compacted_surface
  { r: 0.70, g: 0.55, b: 0.40 }, // disturbed_regolith
  { r: 0.85, g: 0.25, b: 0.25 }, // unsafe_slope
];

export function semanticColor(index: number): Rgb {
  return SEMANTIC_COLORS[index] ?? SEMANTIC_COLORS[0];
}

/** Slope, degrees, from a heightfield by central differences. */
export function slopeDegAt(
  heights: Float32Array,
  width: number,
  height: number,
  col: number,
  row: number,
  resolutionM: number,
): number {
  const c0 = Math.max(0, col - 1);
  const c1 = Math.min(width - 1, col + 1);
  const r0 = Math.max(0, row - 1);
  const r1 = Math.min(height - 1, row + 1);
  const dzdx = (heights[row * width + c1] - heights[row * width + c0]) / ((c1 - c0) * resolutionM);
  const dzdz = (heights[r1 * width + col] - heights[r0 * width + col]) / ((r1 - r0) * resolutionM);
  return (Math.atan(Math.hypot(dzdx, dzdz)) * 180) / Math.PI;
}

/** RMS residual against the 4-neighbourhood, metres — the roughness measure. */
export function roughnessAt(
  heights: Float32Array,
  width: number,
  height: number,
  col: number,
  row: number,
): number {
  const h0 = heights[row * width + col];
  let sq = 0;
  let n = 0;
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const c = col + dc;
    const r = row + dr;
    if (c < 0 || r < 0 || c >= width || r >= height) continue;
    const d = heights[r * width + c] - h0;
    sq += d * d;
    n++;
  }
  return n > 0 ? Math.sqrt(sq / n) : 0;
}

/**
 * Traversability score, 0…1. SYNTHETIC HEURISTIC.
 *
 * Deliberately the same weighting the sidecar's `terrain.getTraversability`
 * uses, so the viewport and the API cannot disagree about whether a patch is
 * drivable. A test asserts they match.
 */
export function traversabilityScore(slopeDeg: number, roughnessM: number, resolutionM: number): number {
  const slopeScore = Math.max(0, 1 - slopeDeg / UNSAFE_SLOPE_DEG);
  const roughScore = Math.max(0, 1 - roughnessM / (resolutionM * 2));
  return 0.65 * slopeScore + 0.35 * roughScore;
}

/** Build a vertex-colour buffer for a heightfield under the chosen overlay. */
export function buildOverlayColors(
  mode: OverlayMode,
  heights: Float32Array,
  width: number,
  height: number,
  resolutionM: number,
  semantic?: Uint8Array,
): Float32Array {
  const colors = new Float32Array(width * height * 3);

  let min = Infinity;
  let max = -Infinity;
  if (mode === 'elevation') {
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] < min) min = heights[i];
      if (heights[i] > max) max = heights[i];
    }
  }

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      let c: Rgb;
      switch (mode) {
        case 'elevation':
          c = elevationColor(heights[i], min, max);
          break;
        case 'slope':
          c = slopeColor(slopeDegAt(heights, width, height, col, row, resolutionM));
          break;
        case 'roughness':
          c = roughnessColor(roughnessAt(heights, width, height, col, row), resolutionM);
          break;
        case 'traversability': {
          const s = slopeDegAt(heights, width, height, col, row, resolutionM);
          const r = roughnessAt(heights, width, height, col, row);
          c = traversabilityColor(traversabilityScore(s, r, resolutionM));
          break;
        }
        case 'semantic':
          c = semanticColor(semantic ? semantic[i] : 0);
          break;
        case 'lit':
        default:
          // Physically plausible grey regolith (spec §13). Apollo soil has a
          // normal albedo near 0.09-0.13; 0.11 is used here.
          c = { r: 0.11, g: 0.105, b: 0.10 };
          break;
      }
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
  }
  return colors;
}

/** Legend entries for the active overlay, for the viewport caption. */
export function overlayLegend(mode: OverlayMode): { title: string; note: string } {
  switch (mode) {
    case 'elevation':
      return { title: 'Elevation (m, layer min → max)', note: 'measured + synthetic' };
    case 'slope':
      return { title: `Slope (0° → ${UNSAFE_SLOPE_DEG}°+)`, note: 'derived from the heightfield' };
    case 'roughness':
      return { title: 'Roughness (RMS residual, 0 → 1 sample)', note: 'derived' };
    case 'traversability':
      return {
        title: 'Traversability (0 → 1)',
        note: 'SYNTHETIC HEURISTIC — not a validated terramechanics prediction',
      };
    case 'semantic':
      return { title: 'Semantic class', note: 'crater/rock classes from feature manifests' };
    case 'lit':
    default:
      return { title: 'Lit regolith', note: 'albedo 0.11, single solar source, no sky light' };
  }
}
