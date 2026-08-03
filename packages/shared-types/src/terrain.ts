/**
 * The canonical terrain representation (spec §5).
 *
 * Deliberately free of any Three.js type. The renderer builds meshes *from*
 * this; it never owns it. That separation is what lets the same dataset drive
 * the browser viewport, the headless exporter and the validation pass without
 * any of them being able to quietly mutate physics-bearing data (spec §33).
 */

import type {
  CoordinateSystem,
  Meters,
  TerrainBounds,
  TerrainOrigin,
} from './coordinates.js';
import type { TerrainFeature } from './features.js';
import type { TerrainProvenance } from './provenance.js';

/**
 * Resolution tier of a layer (spec §2).
 *
 * The nested model exists because a uniform centimetre grid over a kilometre is
 * not representable: 1 km² at 0.01 m is 1e10 samples, 40 GB as float32. Detail
 * is spent only where a rover actually touches the ground.
 */
export type LayerRole = 'context' | 'mission' | 'operational';

/** Which parts of a layer are real measurement and which are synthesised. */
export type ElevationProvenance =
  /** Resampled from a real measured DEM. */
  | 'measured_dem'
  /** Measured DEM plus synthesised detail below its effective resolution. */
  | 'measured_dem_plus_synthetic_subresolution'
  /** Entirely procedural. */
  | 'synthetic';

/** Per-sample classification grids carried alongside the heightfield. */
export interface TerrainMasks {
  /**
   * Semantic class per sample (spec §22). Values index
   * {@link SEMANTIC_CLASSES}.
   */
  semantic?: Uint8Array;
  /**
   * Normalised surface disturbance, 0…1 — how worked the regolith is. Drives
   * appearance only; nothing reads it back as physics.
   */
  disturbance?: Float32Array;
  /**
   * Whether each sample's elevation came from measurement or synthesis. Values
   * index {@link ELEVATION_SOURCES}. Carried per-sample because a mission layer
   * is typically measured at low frequency and synthetic at high frequency.
   */
  elevationSource?: Uint8Array;
}

/** Semantic classes (spec §22). Index order is the on-disk encoding — append only. */
export const SEMANTIC_CLASSES = [
  'unknown',
  'flat_regolith',
  'rough_regolith',
  'crater_floor',
  'crater_wall',
  'crater_rim',
  'rock_field',
  'berm',
  'trench',
  'compacted_surface',
  'disturbed_regolith',
  'unsafe_slope',
] as const;

export type SemanticClass = (typeof SEMANTIC_CLASSES)[number];

/** Per-sample elevation source encoding. Index order is on-disk — append only. */
export const ELEVATION_SOURCES = ['synthetic', 'measured', 'measured_plus_synthetic'] as const;
export type ElevationSource = (typeof ELEVATION_SOURCES)[number];

export function semanticIndex(name: SemanticClass): number {
  const i = SEMANTIC_CLASSES.indexOf(name);
  if (i < 0) throw new Error(`unknown semantic class '${name}'`);
  return i;
}

/**
 * One resolution tier of a site.
 *
 * `heightData` is row-major: sample `(col, row)` lives at `row * widthSamples +
 * col`, with `col` increasing toward +X (east) and `row` increasing toward +Z
 * (**south** — see ADR 0002), so row 0 is the northernmost row. World position
 * of a sample is
 * `x = bounds.minX + col * horizontalResolutionMeters`, likewise for z.
 */
export interface TerrainLayer {
  id: string;
  role: LayerRole;
  bounds: TerrainBounds;
  /** Ground sample distance, metres. */
  horizontalResolutionMeters: Meters;
  /**
   * Elevation quantisation step, metres. Zero means unquantised float. Used
   * when exporting to fixed-point formats so the loss is declared rather than
   * discovered.
   */
  verticalQuantizationMeters: Meters;
  widthSamples: number;
  heightSamples: number;
  /** Elevations in metres relative to {@link TerrainOrigin.datumElevationM}. */
  heightData: Float32Array;
  masks: TerrainMasks;
  /** Where this layer's elevations came from. */
  elevationProvenance: ElevationProvenance;
  /**
   * Effective resolution of the source DEM, metres, when one was used.
   *
   * Distinct from `horizontalResolutionMeters`: a 5 m/px product typically
   * resolves features only at ~15–20 m. Synthetic craters are injected strictly
   * below this scale so the real and synthetic populations never double-count.
   */
  sourceEffectiveResolutionMeters?: Meters;
}

/** World position of a layer sample. */
export function sampleToWorld(
  layer: TerrainLayer,
  col: number,
  row: number,
): { x: Meters; z: Meters } {
  return {
    x: layer.bounds.minX + col * layer.horizontalResolutionMeters,
    z: layer.bounds.minZ + row * layer.horizontalResolutionMeters,
  };
}

/** Nearest sample indices for a world position; may fall outside the grid. */
export function worldToSample(
  layer: TerrainLayer,
  x: Meters,
  z: Meters,
): { col: number; row: number } {
  return {
    col: (x - layer.bounds.minX) / layer.horizontalResolutionMeters,
    row: (z - layer.bounds.minZ) / layer.horizontalResolutionMeters,
  };
}

/** Elevation at integer sample indices; NaN outside the grid. */
export function heightAtSample(layer: TerrainLayer, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= layer.widthSamples || row >= layer.heightSamples) return NaN;
  return layer.heightData[row * layer.widthSamples + col];
}

/** Bilinearly interpolated elevation at a world position; NaN outside the layer. */
export function heightAtWorld(layer: TerrainLayer, x: Meters, z: Meters): number {
  const { col, row } = worldToSample(layer, x, z);
  if (col < 0 || row < 0 || col > layer.widthSamples - 1 || row > layer.heightSamples - 1) {
    return NaN;
  }
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(c0 + 1, layer.widthSamples - 1);
  const r1 = Math.min(r0 + 1, layer.heightSamples - 1);
  const fc = col - c0;
  const fr = row - r0;
  const h00 = layer.heightData[r0 * layer.widthSamples + c0];
  const h10 = layer.heightData[r0 * layer.widthSamples + c1];
  const h01 = layer.heightData[r1 * layer.widthSamples + c0];
  const h11 = layer.heightData[r1 * layer.widthSamples + c1];
  return (
    h00 * (1 - fc) * (1 - fr) + h10 * fc * (1 - fr) + h01 * (1 - fc) * fr + h11 * fc * fr
  );
}

/** Surface normal at a world position, from central differences. */
export function normalAtWorld(
  layer: TerrainLayer,
  x: Meters,
  z: Meters,
): { x: number; y: number; z: number } {
  const d = layer.horizontalResolutionMeters;
  const hl = heightAtWorld(layer, x - d, z);
  const hr = heightAtWorld(layer, x + d, z);
  const hd = heightAtWorld(layer, x, z - d);
  const hu = heightAtWorld(layer, x, z + d);
  if (Number.isNaN(hl) || Number.isNaN(hr) || Number.isNaN(hd) || Number.isNaN(hu)) {
    return { x: 0, y: 1, z: 0 };
  }
  // Gradient of the surface; the normal is (-dh/dx, 1, -dh/dz) normalised.
  const nx = -(hr - hl) / (2 * d);
  const nz = -(hu - hd) / (2 * d);
  const len = Math.hypot(nx, 1, nz);
  return { x: nx / len, y: 1 / len, z: nz / len };
}

/** Slope magnitude in degrees at a world position. */
export function slopeDegAtWorld(layer: TerrainLayer, x: Meters, z: Meters): number {
  const n = normalAtWorld(layer, x, z);
  return (Math.acos(Math.max(-1, Math.min(1, n.y))) * 180) / Math.PI;
}

/** The complete authored site (spec §5). */
export interface TerrainDataset {
  id: string;
  /** Schema version of this structure. */
  version: string;
  /** Master seed; every generator stream derives from it. */
  seed: string;
  /** Union of all layer bounds. */
  bounds: TerrainBounds;
  origin: TerrainOrigin;
  coordinateSystem: CoordinateSystem;
  layers: TerrainLayer[];
  featureManifest: TerrainFeature[];
  provenance: TerrainProvenance;
}

/** The finest layer covering a world position, or undefined if none does. */
export function finestLayerAt(
  dataset: TerrainDataset,
  x: Meters,
  z: Meters,
): TerrainLayer | undefined {
  let best: TerrainLayer | undefined;
  for (const layer of dataset.layers) {
    if (
      x < layer.bounds.minX ||
      x > layer.bounds.maxX ||
      z < layer.bounds.minZ ||
      z > layer.bounds.maxZ
    ) {
      continue;
    }
    if (!best || layer.horizontalResolutionMeters < best.horizontalResolutionMeters) {
      best = layer;
    }
  }
  return best;
}

/**
 * Elevation at a world position, taken from the finest layer that covers it.
 *
 * This is the function a simulation should query: it is the single definition
 * of "the ground" across the nested layers, so the sidecar and Godot cannot
 * disagree about which tier is authoritative.
 */
export function elevationAt(dataset: TerrainDataset, x: Meters, z: Meters): number {
  const layer = finestLayerAt(dataset, x, z);
  if (!layer) return NaN;
  return heightAtWorld(layer, x, z);
}

/** Recompute a layer's vertical bounds from its data. */
export function recomputeVerticalBounds(layer: TerrainLayer): void {
  let min = Infinity;
  let max = -Infinity;
  const d = layer.heightData;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  layer.bounds.minY = min === Infinity ? 0 : min;
  layer.bounds.maxY = max === -Infinity ? 0 : max;
}
