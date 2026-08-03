/**
 * Band-evaluation worker for `ReliefWorkerPool` (spec §14).
 *
 * Loaded as plain TypeScript: the pool spawns an eval'd bootstrap that
 * registers tsx's ESM loader in-thread (`tsx/esm/api` `register()`) and then
 * dynamically imports this file. That makes the same source file work under
 * both `npx tsx` and `npx vitest run` (see workerPool.ts for why
 * `execArgv: ['--import', 'tsx']` does not).
 *
 * BIT-EXACTNESS: the two loop bodies below are line-for-line mirrors of the
 * synchronous reference loops in `generate.ts` (base_relief and
 * regolith_microrelief). The noises are rebuilt from the SAME seed strings
 * the main thread derived through its SeedTree — `PerlinNoise2D` is a pure
 * function of its seed — and `compileStack`/`compileFractal` are the same
 * pure precompilations the reference path uses. A worker computes exactly
 * the samples of its row band, with the identical per-sample IEEE-754
 * operation sequence, and writes each result only to that sample's own index
 * in the SharedArrayBuffer-backed views it received. Ownership of disjoint
 * row ranges is what makes the shared writes race-free (see workerPool.ts).
 */

import { parentPort } from 'node:worker_threads';
import {
  PerlinNoise2D,
  compileFractal,
  compileStack,
  evaluateCompiledStack,
  fbmCompiled,
  type ProceduralLayerSpec,
} from '@lts/terrain-core';
import type { BandMessage, BandReply, WireStackLayer } from './workerPool.js';

if (!parentPort) {
  throw new Error('reliefWorker must be run as a worker thread');
}

/**
 * Noise instances are cached by seed string. Identical seeds produce
 * identical permutation tables, so the cache can only save work, never
 * change a result.
 */
const noiseCache = new Map<string, PerlinNoise2D>();

function noiseFor(seed: string): PerlinNoise2D {
  let n = noiseCache.get(seed);
  if (!n) {
    n = new PerlinNoise2D(seed);
    noiseCache.set(seed, n);
  }
  return n;
}

/** Rebuild the compiled stack exactly as generate.ts compiles it. */
function compileWireStack(stack: WireStackLayer[]) {
  const specs: ProceduralLayerSpec[] = [];
  const noises = new Map<string, PerlinNoise2D>();
  const warpNoises = new Map<string, PerlinNoise2D>();
  for (const s of stack) {
    specs.push({
      id: s.id,
      model: s.model,
      enabled: s.enabled,
      fractal: s.fractal,
      warpStrengthM: s.warpStrengthM,
      warpFrequency: s.warpFrequency,
    });
    noises.set(s.id, noiseFor(s.noiseSeed));
    warpNoises.set(s.id, noiseFor(s.warpSeed));
  }
  return compileStack(specs, noises, warpNoises);
}

function runBand(task: BandMessage): void {
  if (task.kind === 'base_relief') {
    const compiled = compileWireStack(task.stack);
    const { minX, minZ, res, widthSamples, tanSlope, slopeDirX, slopeDirZ } = task;
    const heightData = task.height;
    const elevationSource = task.elevationSource;
    const measured = task.measured;
    const measuredPlusSynthetic = task.measuredPlusSynthetic;
    // Mirror of the generate.ts base_relief loop, restricted to this band's
    // rows. `z` is computed from the absolute row index, so the values are
    // the same doubles the full loop produces.
    for (let row = task.rowStart; row < task.rowEnd; row++) {
      const z = minZ + row * res;
      const rowBase = row * widthSamples;
      for (let col = 0; col < widthSamples; col++) {
        const x = minX + col * res;
        let h = 0;
        if (tanSlope !== 0) h -= (x * slopeDirX + z * slopeDirZ) * tanSlope;
        if (compiled.length > 0) h += evaluateCompiledStack(compiled, x, z);
        if (h !== 0) {
          const i = rowBase + col;
          heightData[i] += h;
          if (measured) {
            elevationSource![i] = measuredPlusSynthetic;
          }
        }
      }
    }
  } else {
    const compiled = compileFractal(task.fractal);
    const noise = noiseFor(task.noiseSeed);
    const { minX, minZ, res, widthSamples } = task;
    const heightData = task.height;
    // Mirror of the generate.ts regolith loop (unconditional accumulate).
    for (let row = task.rowStart; row < task.rowEnd; row++) {
      const z = minZ + row * res;
      const rowBase = row * widthSamples;
      for (let col = 0; col < widthSamples; col++) {
        const x = minX + col * res;
        heightData[rowBase + col] += fbmCompiled(noise, x, z, compiled);
      }
    }
  }
}

parentPort.on('message', (task: BandMessage) => {
  let reply: BandReply;
  try {
    runBand(task);
    reply = { id: task.id, ok: true };
  } catch (e) {
    reply = { id: task.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply);
});
