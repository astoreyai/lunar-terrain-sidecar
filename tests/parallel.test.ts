/**
 * Worker-thread generation equivalence (spec §14, §20).
 *
 * The hard invariant: same seed → byte-identical heightfields whether the
 * base_relief / regolith hot loops run synchronously (workerThreads: 1, the
 * reference implementation) or row-banded across a worker pool. These tests
 * generate the same configurations both ways and compare every layer's
 * heightData — and masks — byte for byte.
 *
 * Layer sizing matters: layers must exceed PARALLEL_THRESHOLD_SAMPLES or the
 * pool is (correctly) bypassed and the comparison proves nothing. The grids
 * here are 1001² = 1,002,001 samples, comfortably above the 262,144 gate.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { parseConfig } from '@lts/shared-types';
import {
  PARALLEL_THRESHOLD_SAMPLES,
  ReliefWorkerPool,
  generateTerrain,
  type GenerateResult,
} from '@lts/terrain-pipeline';

const DEM = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';
const demAvailable = existsSync(DEM);

/** The demonstration site's procedural stack, verbatim — a real stack with a
 * warped_fbm and an fbm layer, so both compiled models are exercised. */
const STACK = [
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

function noDemConfig() {
  return parseConfig({
    terrainId: 'parallel-equivalence',
    seed: 'parallel-equivalence-seed',
    site: { latitudeDeg: -89.45, longitudeDeg: -137.5 },
    layers: [
      // 1001² samples each; the operational layer is fine enough (0.05 m ≤
      // the 0.1 m regolith gate) to take the regolith stage in parallel too.
      { role: 'context', widthMeters: 500, lengthMeters: 500, resolutionMeters: 0.5 },
      { role: 'operational', widthMeters: 50, lengthMeters: 50, resolutionMeters: 0.05 },
    ],
    proceduralStack: STACK,
    regionalSlopeDeg: 2.5,
    regionalSlopeAzimuthDeg: 135,
    solar: { mode: 'manual', elevationDeg: 1.2, azimuthDeg: 180, computeHorizon: false },
  });
}

function demConfig() {
  return parseConfig({
    terrainId: 'parallel-equivalence-dem',
    seed: 'parallel-equivalence-dem-seed',
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    layers: [
      // context is 501² = 251,001 samples — below the threshold, so it also
      // proves the sync-below-threshold and parallel-above paths mix freely
      // in one dataset. mission is 1001² and parallel.
      { role: 'context', widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2.0 },
      { role: 'mission', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.2 },
    ],
    dem: {
      enabled: true,
      path: DEM,
      applyToRoles: ['context', 'mission'],
      effectiveResolutionMeters: 17.5,
    },
    proceduralStack: STACK,
    solar: { mode: 'manual', elevationDeg: 1.2, azimuthDeg: 180, computeHorizon: false },
  });
}

function layerBytes(result: GenerateResult, which: 'height' | 'semantic' | 'source') {
  return result.dataset.layers.map((l) => {
    const a =
      which === 'height' ? l.heightData : which === 'semantic' ? l.masks.semantic! : l.masks.elevationSource!;
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  });
}

function expectIdenticalLayers(a: GenerateResult, b: GenerateResult): void {
  expect(b.dataset.layers.length).toBe(a.dataset.layers.length);
  for (const which of ['height', 'semantic', 'source'] as const) {
    const ba = layerBytes(a, which);
    const bb = layerBytes(b, which);
    for (let i = 0; i < ba.length; i++) {
      expect(
        Buffer.compare(ba[i], bb[i]),
        `${which} bytes of layer ${a.dataset.layers[i].id} differ between workerThreads 1 and 4`,
      ).toBe(0);
    }
  }
}

describe('worker-thread generation is byte-identical to the reference path', () => {
  it('no-DEM: workerThreads 4 matches workerThreads 1 on every layer', async () => {
    const config = noDemConfig();
    // Sanity: the layers actually exceed the dispatch threshold.
    for (const l of config.layers) {
      const samples = (l.widthMeters / l.resolutionMeters + 1) ** 2;
      expect(samples).toBeGreaterThan(PARALLEL_THRESHOLD_SAMPLES);
    }
    const single = await generateTerrain(config, { workerThreads: 1 });
    const parallel = await generateTerrain(config, { workerThreads: 4 });
    expectIdenticalLayers(single, parallel);
    expect(parallel.dataset.featureManifest.length).toBe(single.dataset.featureManifest.length);
  });

  it.skipIf(!demAvailable)(
    'DEM-grounded: workerThreads 4 matches workerThreads 1 on every layer',
    async () => {
      const config = demConfig();
      const single = await generateTerrain(config, { workerThreads: 1 });
      const parallel = await generateTerrain(config, { workerThreads: 4 });
      expectIdenticalLayers(single, parallel);
      // The measured→measured_plus_synthetic mask promotion must also be
      // identical, which `source` above already proved byte-wise; check the
      // provenance labels agree too.
      expect(parallel.dataset.layers.map((l) => l.elevationProvenance)).toEqual(
        single.dataset.layers.map((l) => l.elevationProvenance),
      );
    },
  );

  it('progress stays monotonic while bands complete out of order', async () => {
    const events: Array<{ stage: string; p: number }> = [];
    await generateTerrain(noDemConfig(), {
      workerThreads: 4,
      onProgress: (stage, p) => events.push({ stage, p }),
    });
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(
        events[i].p,
        `progress went backwards at event ${i} (${events[i - 1].stage} ${events[i - 1].p} → ${events[i].stage} ${events[i].p})`,
      ).toBeGreaterThanOrEqual(events[i - 1].p);
    }
    // Band-level events actually happened — positive proof the pool was
    // dispatched, not silently bypassed. The synchronous path emits one
    // base_relief event per layer plus the stage banner (3 here); the
    // banded path emits one per completed band (~16 bands × 2 layers).
    expect(events.filter((e) => e.stage === 'base_relief').length).toBeGreaterThan(10);
    expect(events.at(-1)).toEqual({ stage: 'complete', p: 1.0 });
  });

  it('the pool shuts down cleanly and is idempotent to destroy', async () => {
    const pool = new ReliefWorkerPool(2);
    await pool.destroy();
    await pool.destroy(); // second destroy must be a no-op, not a crash
    await expect(pool.submit(null as never)).rejects.toThrow(/destroyed/);
    // generateTerrain tears its pool down in a finally; if it ever leaked a
    // worker, vitest would hang on open handles and this file would time out
    // rather than complete — completion of this suite is itself the gate.
  });
});
