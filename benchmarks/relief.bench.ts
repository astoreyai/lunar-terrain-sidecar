/**
 * Base-relief + regolith micro-benchmark.
 *
 * Isolates the `base_relief` (4.82 s) and `regolith_microrelief` (1.73 s)
 * stage costs from the 2026-08-03 archimedes demo-scale run so optimizations
 * to the procedural-stack evaluation path (`evaluateStack` / `fbm` /
 * `ridgedMultifractal` / `domainWarp` in packages/terrain-core/src/noise.ts)
 * can be measured directly.
 *
 * Real work only: the three grids are the demo layer shapes
 * (1 km @ 2 m, 200 m @ 0.2 m, 30 m @ 0.01 m from
 * examples/south_pole_site_01/config.json), the procedural stack is the
 * demo's two-layer stack verbatim, the regolith parameters are the demo's,
 * and the seeds derive from the demo master seed through the production
 * `SeedTree` exactly as the pipeline derives them. The per-sample loop
 * mirrors packages/terrain-pipeline/src/generate.ts (demo regionalSlopeDeg
 * is 0, so the slope term is skipped there just as it is here). Unlike the
 * pipeline — which gates regolith on maximumResolutionMeters — regolith is
 * timed over all three grids so the fBm path is measured at every scale.
 *
 * Determinism gate: the SHA-256 of each heightfield is printed after base
 * relief and again after regolith. Any optimization to this path MUST leave
 * every checksum unchanged — the project guarantees same-seed
 * byte-for-byte reproducibility (docs/reproducibility.md).
 *
 * Run from the repository root:
 *
 *     npx tsx --tsconfig tsconfig.json benchmarks/relief.bench.ts
 */

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import {
  PerlinNoise2D,
  SeedTree,
  compileFractal,
  compileStack,
  evaluateCompiledStack,
  fbmCompiled,
  type FractalParameters,
  type ProceduralLayerSpec,
} from '@lts/terrain-core';
import { centeredBounds } from '@lts/shared-types';
import {
  ReliefWorkerPool,
  defaultWorkerThreads,
  runBaseReliefParallel,
  runRegolithParallel,
  type WireStackLayer,
} from '@lts/terrain-pipeline';

// ------------------------------------------------------------- demo inputs --

// Demo master seed (examples/south_pole_site_01/config.json).
const MASTER_SEED = 'lunar-south-pole-site-01';

// Demo layer shapes: 1 km @ 2 m, 200 m @ 0.2 m, 30 m @ 0.01 m.
const GRIDS = [
  { id: 'context-0', res: 2.0, samples: 501 },
  { id: 'mission-1', res: 0.2, samples: 1001 },
  { id: 'operational-2', res: 0.01, samples: 3001 },
] as const;

// Demo procedural stack, verbatim.
const STACK: ProceduralLayerSpec[] = [
  {
    id: 'sub_dem_relief',
    model: 'warped_fbm',
    enabled: true,
    fractal: {
      octaves: 6,
      lacunarity: 2.0,
      persistence: 0.5,
      frequency: 0.2,
      amplitude: 0.12,
      anisotropy: 1.0,
    },
    warpStrengthM: 1.5,
    warpFrequency: 0.06,
  },
  {
    id: 'fine_roughness',
    model: 'fbm',
    enabled: true,
    fractal: {
      octaves: 5,
      lacunarity: 2.1,
      persistence: 0.55,
      frequency: 2.0,
      amplitude: 0.02,
      anisotropy: 1.0,
    },
  },
];

// Demo regolith parameters, as generate.ts constructs them.
const REGOLITH_P: FractalParameters = {
  octaves: 4,
  lacunarity: 2.0,
  persistence: 0.5,
  frequency: 1 / 0.35,
  amplitude: 0.012,
  anisotropy: 1,
};

// Seeds derive exactly as the pipeline derives them (generate.ts).
const seeds = new SeedTree(MASTER_SEED);
const noises = new Map<string, PerlinNoise2D>();
const warpNoises = new Map<string, PerlinNoise2D>();
for (const s of STACK) {
  noises.set(s.id, new PerlinNoise2D(seeds.seed(`procedural:${s.id}`)));
  warpNoises.set(s.id, new PerlinNoise2D(seeds.seed(`procedural-warp:${s.id}`)));
}

// ------------------------------------------------------------ stage loops --

interface Grid {
  id: string;
  res: number;
  samples: number;
  minX: number;
  minZ: number;
}

function makeGrid(g: (typeof GRIDS)[number]): Grid {
  const span = (g.samples - 1) * g.res;
  const bounds = centeredBounds(span, span);
  return { id: g.id, res: g.res, samples: g.samples, minX: bounds.minX, minZ: bounds.minZ };
}

/** Mirror of the generate.ts base_relief loop (demo slope is 0). */
function baseReliefPass(grid: Grid, height: Float32Array): void {
  const compiled = compileStack(STACK, noises, warpNoises);
  const { res, minX, minZ, samples } = grid;
  for (let row = 0; row < samples; row++) {
    const z = minZ + row * res;
    const rowBase = row * samples;
    for (let col = 0; col < samples; col++) {
      const x = minX + col * res;
      let h = 0;
      h += evaluateCompiledStack(compiled, x, z);
      if (h !== 0) height[rowBase + col] += h;
    }
  }
}

/** Mirror of the generate.ts regolith loop. */
function regolithPass(grid: Grid, height: Float32Array, noise: PerlinNoise2D): void {
  const compiled = compileFractal(REGOLITH_P);
  const { res, minX, minZ, samples } = grid;
  for (let row = 0; row < samples; row++) {
    const z = minZ + row * res;
    const rowBase = row * samples;
    for (let col = 0; col < samples; col++) {
      const x = minX + col * res;
      height[rowBase + col] += fbmCompiled(noise, x, z, compiled);
    }
  }
}

// ---------------------------------------------------------------- harness --

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sha256(a: Float32Array): string {
  return createHash('sha256')
    .update(Buffer.from(a.buffer, a.byteOffset, a.byteLength))
    .digest('hex');
}

const RUNS = 3;

// Untimed warm-up on the smallest grid so JIT compilation is not measured.
{
  const warm = makeGrid(GRIDS[0]);
  const h = new Float32Array(warm.samples * warm.samples);
  baseReliefPass(warm, h);
  regolithPass(warm, h, new PerlinNoise2D(seeds.seed(`regolith:${warm.id}`)));
}

let totalBaseMs = 0;
let totalRegolithMs = 0;

/** Single-thread results kept for the worker-pool determinism gate below. */
const singleResults: Array<{
  grid: Grid;
  baseMed: number;
  regolithMed: number;
  baseSha: string;
  bothSha: string;
  base: Float32Array;
}> = [];

for (const g of GRIDS) {
  const grid = makeGrid(g);
  const n = grid.samples * grid.samples;

  // base relief: fresh field per run, keep the last.
  let base = new Float32Array(n);
  const baseRuns: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    base = new Float32Array(n);
    const t0 = performance.now();
    baseReliefPass(grid, base);
    baseRuns.push(performance.now() - t0);
  }
  const baseMed = median(baseRuns);
  totalBaseMs += baseMed;

  // regolith: same seed derivation as the pipeline; fresh noise + fresh copy
  // of the base field per run so += accumulation is not double-applied.
  const regolithSeed = seeds.seed(`regolith:${grid.id}`);
  let both = base;
  const regolithRuns: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    both = base.slice();
    const noise = new PerlinNoise2D(regolithSeed);
    const t0 = performance.now();
    regolithPass(grid, both, noise);
    regolithRuns.push(performance.now() - t0);
  }
  const regolithMed = median(regolithRuns);
  totalRegolithMs += regolithMed;

  console.log(`${grid.id} (${grid.samples}x${grid.samples} @ ${grid.res} m):`);
  console.log(`  base_relief runs (ms): ${baseRuns.map((x) => x.toFixed(1)).join(', ')}  median ${baseMed.toFixed(1)}`);
  console.log(`  regolith    runs (ms): ${regolithRuns.map((x) => x.toFixed(1)).join(', ')}  median ${regolithMed.toFixed(1)}`);
  console.log(`  base_relief sha256:          ${sha256(base)}`);
  console.log(`  base+regolith sha256:        ${sha256(both)}`);

  singleResults.push({
    grid,
    baseMed,
    regolithMed,
    baseSha: sha256(base),
    bothSha: sha256(both),
    base,
  });
}

console.log(`total base_relief median:    ${totalBaseMs.toFixed(1)} ms`);
console.log(`total regolith median:       ${totalRegolithMs.toFixed(1)} ms`);

// -------------------------------------------- worker-pool comparison (§27) --
//
// The same two stages, banded across the production worker pool
// (packages/terrain-pipeline/src/workerPool.ts) at its default size
// min(cores − 2, 8). Timings include the pool path's SharedArrayBuffer
// copy-in/copy-out, i.e. they are the real cost the pipeline pays.
// Determinism gate: every pooled checksum MUST equal the single-thread
// checksum printed above; a mismatch fails the benchmark.
//
// The wire stack mirrors generate.ts exactly: the same specs, and the seed
// channels derived through the same SeedTree.
const WIRE_STACK: WireStackLayer[] = STACK.map((s) => ({
  id: s.id,
  model: s.model,
  enabled: s.enabled,
  fractal: s.fractal,
  warpStrengthM: s.warpStrengthM,
  warpFrequency: s.warpFrequency,
  noiseSeed: seeds.seed(`procedural:${s.id}`),
  warpSeed: seeds.seed(`procedural-warp:${s.id}`),
}));

const poolSize = defaultWorkerThreads();
const pool = new ReliefWorkerPool(poolSize);
console.log(`\nworker pool (${poolSize} threads, demo regionalSlopeDeg 0):`);

let mismatched = false;
try {
  // Untimed warm-up so worker startup and JIT are not measured.
  {
    const warm = makeGrid(GRIDS[0]);
    const h = new Float32Array(warm.samples * warm.samples);
    await runBaseReliefParallel(
      pool,
      {
        minX: warm.minX,
        minZ: warm.minZ,
        res: warm.res,
        widthSamples: warm.samples,
        heightSamples: warm.samples,
        tanSlope: 0,
        slopeDirX: 0,
        slopeDirZ: -1,
        stack: WIRE_STACK,
        measured: false,
        measuredPlusSynthetic: 0,
      },
      h,
      null,
    );
  }

  let totalBasePoolMs = 0;
  let totalRegolithPoolMs = 0;

  for (const s of singleResults) {
    const { grid } = s;
    const n = grid.samples * grid.samples;

    let base = new Float32Array(n);
    const baseRuns: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      base = new Float32Array(n);
      const t0 = performance.now();
      await runBaseReliefParallel(
        pool,
        {
          minX: grid.minX,
          minZ: grid.minZ,
          res: grid.res,
          widthSamples: grid.samples,
          heightSamples: grid.samples,
          tanSlope: 0,
          slopeDirX: 0,
          slopeDirZ: -1,
          stack: WIRE_STACK,
          measured: false,
          measuredPlusSynthetic: 0,
        },
        base,
        null,
      );
      baseRuns.push(performance.now() - t0);
    }
    const baseMed = median(baseRuns);
    totalBasePoolMs += baseMed;

    const regolithSeed = seeds.seed(`regolith:${grid.id}`);
    let both = base;
    const regolithRuns: number[] = [];
    for (let r = 0; r < RUNS; r++) {
      both = base.slice();
      const t0 = performance.now();
      await runRegolithParallel(
        pool,
        {
          minX: grid.minX,
          minZ: grid.minZ,
          res: grid.res,
          widthSamples: grid.samples,
          heightSamples: grid.samples,
          fractal: REGOLITH_P,
          noiseSeed: regolithSeed,
        },
        both,
      );
      regolithRuns.push(performance.now() - t0);
    }
    const regolithMed = median(regolithRuns);
    totalRegolithPoolMs += regolithMed;

    const baseOk = sha256(base) === s.baseSha;
    const bothOk = sha256(both) === s.bothSha;
    if (!baseOk || !bothOk) mismatched = true;

    console.log(`${grid.id} (${grid.samples}x${grid.samples} @ ${grid.res} m):`);
    console.log(
      `  base_relief pooled (ms): ${baseRuns.map((x) => x.toFixed(1)).join(', ')}  median ${baseMed.toFixed(1)}  ` +
        `speedup ${(s.baseMed / baseMed).toFixed(2)}x  sha ${baseOk ? 'IDENTICAL' : 'MISMATCH'}`,
    );
    console.log(
      `  regolith    pooled (ms): ${regolithRuns.map((x) => x.toFixed(1)).join(', ')}  median ${regolithMed.toFixed(1)}  ` +
        `speedup ${(s.regolithMed / regolithMed).toFixed(2)}x  sha ${bothOk ? 'IDENTICAL' : 'MISMATCH'}`,
    );
  }

  console.log(`total base_relief pooled:    ${totalBasePoolMs.toFixed(1)} ms  (${(totalBaseMs / totalBasePoolMs).toFixed(2)}x)`);
  console.log(`total regolith pooled:       ${totalRegolithPoolMs.toFixed(1)} ms  (${(totalRegolithMs / totalRegolithPoolMs).toFixed(2)}x)`);
} finally {
  await pool.destroy();
}

if (mismatched) {
  console.error('DETERMINISM GATE FAILED: pooled checksums differ from single-thread checksums.');
  process.exit(1);
}
