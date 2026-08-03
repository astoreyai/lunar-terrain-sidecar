/**
 * Crater stamping micro-benchmark.
 *
 * Isolates the `generating_craters` stage cost (the dominant term in the
 * 2026-08-03 archimedes run: 10.1 s of a 14.9 s demo-scale generation) so
 * optimizations to `stampCrater` / `craterProfile` can be measured directly.
 *
 * Real work only: the population is drawn with the production `production_csfd`
 * sampler using the same option shapes the pipeline passes for the demo mission
 * layer (see packages/terrain-pipeline/src/generate.ts), and stamping runs the
 * real `stampCrater` against a full-size layer.
 *
 * Determinism gate: the SHA-256 of the resulting heightData buffer is printed.
 * Any optimization to the stamping path MUST leave this checksum unchanged —
 * the project guarantees same-seed byte-for-byte reproducibility
 * (docs/reproducibility.md).
 *
 * Run from the repository root:
 *
 *     npx tsx --tsconfig tsconfig.json benchmarks/craters.bench.ts
 */

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import { Rng } from '@lts/terrain-core';
import { centeredBounds, type TerrainLayer } from '@lts/shared-types';
import { sampleCraterPopulation, stampCrater } from '@lts/lunar-features';

// Mirror of the demo mission layer: 200 m x 200 m @ 0.2 m => 1001 x 1001.
const RES = 0.2;
const WIDTH_SAMPLES = 1001;
const HEIGHT_SAMPLES = 1001;
const SPAN_X = (WIDTH_SAMPLES - 1) * RES;
const SPAN_Z = (HEIGHT_SAMPLES - 1) * RES;

function makeFlatLayer(): TerrainLayer {
  return {
    id: 'bench-mission',
    role: 'mission',
    bounds: centeredBounds(SPAN_X, SPAN_Z),
    horizontalResolutionMeters: RES,
    verticalQuantizationMeters: 0,
    widthSamples: WIDTH_SAMPLES,
    heightSamples: HEIGHT_SAMPLES,
    heightData: new Float32Array(WIDTH_SAMPLES * HEIGHT_SAMPLES),
    masks: {
      semantic: new Uint8Array(WIDTH_SAMPLES * HEIGHT_SAMPLES),
    },
    elevationProvenance: 'synthetic',
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Population: same option shapes the pipeline passes (generate.ts, crater
// stage) for the demo config — production_csfd, 0.2–35 m configured range
// (raised to four grid samples), 17.5 m DEM de-confliction cap.
const bounds = centeredBounds(SPAN_X, SPAN_Z);
const rng = new Rng('bench-craters');
const { craters, notes } = sampleCraterPopulation(rng, {
  minX: bounds.minX,
  minZ: bounds.minZ,
  maxX: bounds.maxX,
  maxZ: bounds.maxZ,
  minDiameterM: Math.max(0.2, RES * 4),
  maxDiameterM: 35,
  model: 'production_csfd',
  surfaceAgeGa: 3.5,
  powerLawAnchorDiameterM: 0.2,
  powerLawExponent: 3.0,
  demEffectiveResolutionM: 17.5,
  meanDegradation: 0.45,
  degradationSpread: 0.3,
  ellipticalFraction: 0.15,
  exclusionRadiusFactor: 0,
  clustering: 0.0,
});
for (const n of notes) console.log(`note: ${n}`);
console.log(`population: ${craters.length} craters (seed 'bench-craters')`);

// Untimed warm-ups so JIT compilation is not measured.
for (let w = 0; w < 3; w++) {
  const warm = makeFlatLayer();
  for (const c of craters) stampCrater(warm, c, warm.masks.semantic);
}

const RUNS = 9;
const runsMs: number[] = [];
let touched = 0;
let lastLayer: TerrainLayer | undefined;

for (let r = 0; r < RUNS; r++) {
  const layer = makeFlatLayer();
  touched = 0;
  const t0 = performance.now();
  for (const c of craters) {
    touched += stampCrater(layer, c, layer.masks.semantic).samplesTouched;
  }
  runsMs.push(performance.now() - t0);
  lastLayer = layer;
}

const med = median(runsMs);
const heightSha = createHash('sha256')
  .update(Buffer.from(lastLayer!.heightData.buffer, lastLayer!.heightData.byteOffset, lastLayer!.heightData.byteLength))
  .digest('hex');
const semanticSha = createHash('sha256').update(lastLayer!.masks.semantic!).digest('hex');

console.log(`runs (ms): ${runsMs.map((x) => x.toFixed(1)).join(', ')}`);
console.log(`median stamp time: ${med.toFixed(1)} ms for ${craters.length} craters`);
console.log(`throughput: ${((craters.length / med) * 1000).toFixed(0)} craters/sec`);
console.log(`samples touched: ${touched}`);
console.log(`heightData sha256:  ${heightSha}`);
console.log(`semantic  sha256:  ${semanticSha}`);
