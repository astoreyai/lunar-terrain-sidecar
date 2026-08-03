/**
 * Procedural noise (spec §7).
 *
 * Gradient (Perlin) noise with a seeded permutation table, plus the fractal
 * stacks terrain wants: fractional Brownian motion, ridged multifractal, and
 * domain warping.
 *
 * Every function here uses only integer operations and IEEE-754 add / subtract
 * / multiply. Those are exactly specified, so terrain is bit-reproducible
 * across engines and platforms. `Math.pow` is deliberately avoided in the
 * octave loop — the frequency and amplitude ladders are built by repeated
 * multiplication instead, which is both faster and exactly reproducible.
 */

import { Rng } from './rng.js';

/** 2-D gradient noise with a seeded permutation table. */
export class PerlinNoise2D {
  private readonly perm: Uint8Array;

  constructor(seed: string) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher–Yates, drawing from the seeded stream.
    for (let i = 255; i > 0; i--) {
      const j = rng.intBelow(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    // Doubled so lookups never need a modulo.
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /**
   * Noise at (x, y), returning roughly [-1, 1].
   *
   * The 8 gradient directions are the unit diagonals and axes, chosen so the
   * dot products are exact sums of the inputs — no trigonometry, no rounding
   * beyond the multiply.
   */
  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;

    const u = fade(xf);
    const v = fade(yf);

    const aa = this.perm[this.perm[X] + Y];
    const ab = this.perm[this.perm[X] + Y + 1];
    const ba = this.perm[this.perm[X + 1] + Y];
    const bb = this.perm[this.perm[X + 1] + Y + 1];

    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }
}

/** Perlin's 6t⁵ − 15t⁴ + 10t³ fade, C² continuous so normals stay smooth. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

/** Dot product with one of 8 unit-ish gradients selected by the low hash bits. */
function grad(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/** Parameters of a fractal noise stack (spec §7). */
export interface FractalParameters {
  /** Number of octaves. */
  octaves: number;
  /** Frequency multiplier per octave. Typically 2.0. */
  lacunarity: number;
  /** Amplitude multiplier per octave. Typically 0.5. */
  persistence: number;
  /** Base frequency, cycles per metre. */
  frequency: number;
  /** Peak amplitude, metres. */
  amplitude: number;
  /**
   * Horizontal anisotropy: the y frequency is scaled by this. 1 is isotropic;
   * values away from 1 stretch features along one axis, which is how ridge
   * systems and crater-chain lineations read.
   */
  anisotropy?: number;
}

export const DEFAULT_FRACTAL: FractalParameters = {
  octaves: 6,
  lacunarity: 2.0,
  persistence: 0.5,
  frequency: 0.01,
  amplitude: 1.0,
  anisotropy: 1.0,
};

/**
 * Fractional Brownian motion — the standard sum of scaled octaves.
 *
 * Normalised by the total amplitude so the result stays within ±amplitude
 * regardless of octave count, which keeps the `amplitude` parameter physically
 * meaningful in metres.
 */
export function fbm(
  noise: PerlinNoise2D,
  x: number,
  y: number,
  p: FractalParameters,
): number {
  const aniso = p.anisotropy ?? 1;
  let freq = p.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < p.octaves; i++) {
    sum += amp * noise.noise(x * freq, y * freq * aniso);
    norm += amp;
    freq *= p.lacunarity;
    amp *= p.persistence;
  }
  return norm > 0 ? (p.amplitude * sum) / norm : 0;
}

/**
 * Ridged multifractal.
 *
 * Each octave is folded through `1 - |n|` to make creases rather than bumps,
 * and weighted by the previous octave's value so ridges only branch where the
 * larger scale already had relief. This is what produces crater-rim-like and
 * massif-like structures instead of uniform bumpiness.
 */
export function ridgedMultifractal(
  noise: PerlinNoise2D,
  x: number,
  y: number,
  p: FractalParameters,
  offset = 1.0,
  gain = 2.0,
): number {
  const aniso = p.anisotropy ?? 1;
  let freq = p.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < p.octaves; i++) {
    let n = noise.noise(x * freq, y * freq * aniso);
    n = offset - (n < 0 ? -n : n);
    n = n * n;
    n *= weight;
    weight = n * gain;
    if (weight > 1) weight = 1;
    if (weight < 0) weight = 0;
    sum += amp * n;
    norm += amp;
    freq *= p.lacunarity;
    amp *= p.persistence;
  }
  // Ridged output is in [0, 1]; recentre so it can add or subtract relief.
  return norm > 0 ? p.amplitude * ((sum / norm) * 2 - 1) : 0;
}

/**
 * Domain warping: displace the sample point by another noise field before
 * evaluating.
 *
 * This is what breaks up the visually obvious axis-alignment of raw fBm and
 * produces the swirled, flow-like texture real regolith and ejecta have.
 */
export function domainWarp(
  noise: PerlinNoise2D,
  warpNoise: PerlinNoise2D,
  x: number,
  y: number,
  p: FractalParameters,
  warpStrengthM: number,
  warpFrequency: number,
): number {
  const wx = warpNoise.noise(x * warpFrequency, y * warpFrequency) * warpStrengthM;
  const wy = warpNoise.noise(x * warpFrequency + 137.17, y * warpFrequency - 91.31) * warpStrengthM;
  return fbm(noise, x + wx, y + wy, p);
}

/** The noise models selectable in a procedural layer (spec §7). */
export type NoiseModel = 'fbm' | 'ridged' | 'warped_fbm';

export interface ProceduralLayerSpec {
  id: string;
  model: NoiseModel;
  enabled: boolean;
  fractal: FractalParameters;
  /** Warp strength in metres; only read when `model` is `warped_fbm`. */
  warpStrengthM?: number;
  /** Warp frequency in cycles per metre; only read when `model` is `warped_fbm`. */
  warpFrequency?: number;
}

/**
 * Evaluate an ordered stack of procedural layers at a point, in metres.
 *
 * Layers are summed. Ordering matters only for reproducibility bookkeeping
 * (each layer draws its own seed channel), not for the arithmetic.
 */
export function evaluateStack(
  stack: ProceduralLayerSpec[],
  noises: Map<string, PerlinNoise2D>,
  warpNoises: Map<string, PerlinNoise2D>,
  x: number,
  y: number,
): number {
  let sum = 0;
  for (const layer of stack) {
    if (!layer.enabled) continue;
    const n = noises.get(layer.id);
    if (!n) throw new Error(`no noise instance for procedural layer '${layer.id}'`);
    switch (layer.model) {
      case 'fbm':
        sum += fbm(n, x, y, layer.fractal);
        break;
      case 'ridged':
        sum += ridgedMultifractal(n, x, y, layer.fractal);
        break;
      case 'warped_fbm': {
        const w = warpNoises.get(layer.id);
        if (!w) throw new Error(`no warp noise instance for procedural layer '${layer.id}'`);
        sum += domainWarp(
          n,
          w,
          x,
          y,
          layer.fractal,
          layer.warpStrengthM ?? 10,
          layer.warpFrequency ?? layer.fractal.frequency * 0.5,
        );
        break;
      }
    }
  }
  return sum;
}
