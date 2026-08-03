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

    // Local alias: one property load instead of six (integer lookups only —
    // no float behaviour is involved).
    const perm = this.perm;
    const pX = perm[X];
    const pX1 = perm[X + 1];
    const aa = perm[pX + Y];
    const ab = perm[pX + Y + 1];
    const ba = perm[pX1 + Y];
    const bb = perm[pX1 + Y + 1];

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

// ---------------------------------------------------------------------------
// Precompiled evaluation path.
//
// `fbm` / `ridgedMultifractal` rebuild the frequency and amplitude ladders
// (`freq *= lacunarity`, `amp *= persistence`, `norm += amp`) on EVERY call,
// and `evaluateStack` re-dispatches through Map lookups and the model switch
// on every sample. All of that is invariant per parameter set, so the
// pipeline's per-sample loops (base relief, regolith — spec §6) hoist it once
// with `compileFractal` / `compileStack` and evaluate through the functions
// below.
//
// BIT-EXACTNESS CONTRACT: for identical inputs the compiled path performs the
// SAME per-sample IEEE-754 operation sequence as the uncompiled functions
// above, with identical operand values, and therefore produces bit-identical
// results:
//   - the ladder entries freq[i] / amp[i] and the divisor `norm` are produced
//     by the same repeated multiplications and additions, just once instead of
//     per sample;
//   - per octave the compiled loop computes `x * freq[i]`,
//     `y * freq[i] * aniso` (left-to-right, exactly as the originals parse
//     `y * freq * aniso`) and accumulates `sum += amp[i] * n` in the same
//     order;
//   - the final normalisation keeps the original division
//     (`(amplitude * sum) / norm` — NOT a reciprocal multiply);
//   - the warp displacement and the 137.17 / −91.31 channel offsets are
//     unchanged; only the `warpFrequency ?? frequency * 0.5` default is
//     resolved once (a pure product of constants — the same double either
//     way).
// No transcendental is approximated, no addition reassociated, no division
// turned into a multiply. Same seed → same Float32Array bits
// (docs/reproducibility.md).
// ---------------------------------------------------------------------------

/** Ladders of a fractal parameter set, computed once (see contract above). */
export interface CompiledFractal {
  /** Iteration count — exactly the count the uncompiled octave loop runs. */
  readonly octaves: number;
  /** freq[i]: the value `freq` held on octave i in the uncompiled loop. */
  readonly freq: readonly number[];
  /** amp[i]: the value `amp` held on octave i in the uncompiled loop. */
  readonly amp: readonly number[];
  /** Σ amp[i], accumulated in octave order — identical to the loop's `norm`. */
  readonly norm: number;
  readonly aniso: number;
  readonly amplitude: number;
}

/** Precompute the per-octave ladders of `p`. Pure; no float sequence changes. */
export function compileFractal(p: FractalParameters): CompiledFractal {
  const aniso = p.anisotropy ?? 1;
  const freqs: number[] = [];
  const amps: number[] = [];
  let freq = p.frequency;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < p.octaves; i++) {
    freqs.push(freq);
    amps.push(amp);
    norm += amp;
    freq *= p.lacunarity;
    amp *= p.persistence;
  }
  return { octaves: freqs.length, freq: freqs, amp: amps, norm, aniso, amplitude: p.amplitude };
}

/** `fbm` over a precompiled ladder — bit-identical to `fbm(noise, x, y, p)`. */
export function fbmCompiled(
  noise: PerlinNoise2D,
  x: number,
  y: number,
  c: CompiledFractal,
): number {
  const freqs = c.freq;
  const amps = c.amp;
  const aniso = c.aniso;
  let sum = 0;
  for (let i = 0; i < c.octaves; i++) {
    const f = freqs[i];
    sum += amps[i] * noise.noise(x * f, y * f * aniso);
  }
  return c.norm > 0 ? (c.amplitude * sum) / c.norm : 0;
}

/**
 * `ridgedMultifractal` over a precompiled ladder — bit-identical to
 * `ridgedMultifractal(noise, x, y, p, offset, gain)`.
 */
export function ridgedMultifractalCompiled(
  noise: PerlinNoise2D,
  x: number,
  y: number,
  c: CompiledFractal,
  offset = 1.0,
  gain = 2.0,
): number {
  const freqs = c.freq;
  const amps = c.amp;
  const aniso = c.aniso;
  let sum = 0;
  let weight = 1;
  for (let i = 0; i < c.octaves; i++) {
    const f = freqs[i];
    let n = noise.noise(x * f, y * f * aniso);
    n = offset - (n < 0 ? -n : n);
    n = n * n;
    n *= weight;
    weight = n * gain;
    if (weight > 1) weight = 1;
    if (weight < 0) weight = 0;
    sum += amps[i] * n;
  }
  return c.norm > 0 ? c.amplitude * ((sum / c.norm) * 2 - 1) : 0;
}

/** One enabled procedural layer with its dispatch and ladders resolved. */
export interface CompiledStackLayer {
  /** 0 = fbm, 1 = ridged, 2 = warped_fbm. */
  readonly kind: 0 | 1 | 2;
  readonly noise: PerlinNoise2D;
  /** Present only when kind is 2. */
  readonly warp: PerlinNoise2D | null;
  readonly fractal: CompiledFractal;
  readonly warpStrengthM: number;
  readonly warpFrequency: number;
}

export type CompiledStack = readonly CompiledStackLayer[];

/**
 * Resolve a stack's per-layer dispatch once: enabled filter, Map lookups,
 * model switch, warp defaults, fractal ladders. Disabled layers contribute
 * exactly nothing in `evaluateStack`, so dropping them here changes no sums.
 */
export function compileStack(
  stack: ProceduralLayerSpec[],
  noises: Map<string, PerlinNoise2D>,
  warpNoises: Map<string, PerlinNoise2D>,
): CompiledStack {
  const compiled: CompiledStackLayer[] = [];
  for (const layer of stack) {
    if (!layer.enabled) continue;
    const n = noises.get(layer.id);
    if (!n) throw new Error(`no noise instance for procedural layer '${layer.id}'`);
    if (layer.model === 'warped_fbm') {
      const w = warpNoises.get(layer.id);
      if (!w) throw new Error(`no warp noise instance for procedural layer '${layer.id}'`);
      compiled.push({
        kind: 2,
        noise: n,
        warp: w,
        fractal: compileFractal(layer.fractal),
        warpStrengthM: layer.warpStrengthM ?? 10,
        warpFrequency: layer.warpFrequency ?? layer.fractal.frequency * 0.5,
      });
    } else {
      compiled.push({
        kind: layer.model === 'fbm' ? 0 : 1,
        noise: n,
        warp: null,
        fractal: compileFractal(layer.fractal),
        warpStrengthM: 0,
        warpFrequency: 0,
      });
    }
  }
  return compiled;
}

/**
 * Evaluate a compiled stack at (x, y) — bit-identical to
 * `evaluateStack(stack, noises, warpNoises, x, y)` on the stack it was
 * compiled from. Layer order, and so summation order, is preserved.
 */
export function evaluateCompiledStack(compiled: CompiledStack, x: number, y: number): number {
  let sum = 0;
  for (let i = 0; i < compiled.length; i++) {
    const l = compiled[i];
    switch (l.kind) {
      case 0:
        sum += fbmCompiled(l.noise, x, y, l.fractal);
        break;
      case 1:
        sum += ridgedMultifractalCompiled(l.noise, x, y, l.fractal);
        break;
      default: {
        // domainWarp, with the warp frequency/strength already resolved.
        const wf = l.warpFrequency;
        const wx = l.warp!.noise(x * wf, y * wf) * l.warpStrengthM;
        const wy = l.warp!.noise(x * wf + 137.17, y * wf - 91.31) * l.warpStrengthM;
        sum += fbmCompiled(l.noise, x + wx, y + wy, l.fractal);
        break;
      }
    }
  }
  return sum;
}
