/**
 * Per-sample elevation-provenance regression tests (round-2 domain review,
 * MAJOR-A / NOTE-E).
 *
 * The paper guarantees that every exported sample records whether it is
 * measurement or synthesis — including synthetic craters and regolith
 * microrelief stamped into DEM-grounded layers. Round 1 fixed the crater
 * half; the regolith half silently no-opped (the patch targeted a loop the
 * worker refactor had replaced) and shipped with a commit message claiming
 * otherwise. These tests pin both halves so the guarantee cannot silently
 * regress again.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  ELEVATION_SOURCES,
  parseConfig,
  type TerrainLayer,
} from '@lts/shared-types';
import { stampCrater, makeCrater } from '@lts/lunar-features';
import { Rng } from '@lts/terrain-core';
import { generateTerrain } from '@lts/terrain-pipeline';

const DEM = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';
const MEASURED = ELEVATION_SOURCES.indexOf('measured');
const MEASURED_PLUS = ELEVATION_SOURCES.indexOf('measured_plus_synthetic');

function measuredLayer(n: number, res: number): TerrainLayer {
  const span = (n - 1) * res;
  return {
    id: 'unit',
    role: 'operational',
    bounds: { minX: -span / 2, minZ: -span / 2, maxX: span / 2, maxZ: span / 2, minY: 0, maxY: 0 },
    horizontalResolutionMeters: res,
    verticalQuantizationMeters: 0,
    widthSamples: n,
    heightSamples: n,
    heightData: new Float32Array(n * n),
    masks: {
      semantic: new Uint8Array(n * n),
      elevationSource: new Uint8Array(n * n).fill(MEASURED),
    },
    elevationProvenance: 'measured_dem',
  };
}

describe('crater stamping marks elevation provenance', () => {
  it('flips exactly the touched samples, and only those', () => {
    const layer = measuredLayer(101, 0.5);
    const crater = makeCrater(new Rng('prov-test'), 'c0', 0, 0, 12, {
      meanDegradation: 0.2,
      degradationSpread: 0,
      ellipticalFraction: 0,
    });

    const result = stampCrater(
      layer,
      crater,
      layer.masks.semantic,
      layer.masks.elevationSource,
      MEASURED_PLUS,
    );

    expect(result.samplesTouched).toBeGreaterThan(0);
    let flipped = 0;
    let stillMeasured = 0;
    for (let i = 0; i < layer.heightData.length; i++) {
      const changed = layer.heightData[i] !== 0;
      const mask = layer.masks.elevationSource![i];
      if (changed) {
        if (mask === MEASURED_PLUS) flipped++;
        else stillMeasured++;
      } else {
        // Untouched samples must keep their measured label.
        expect(mask).toBe(MEASURED);
      }
    }
    expect(stillMeasured).toBe(0);
    expect(flipped).toBe(result.samplesTouched);
  });

  it('defaults the mask index to measured_plus_synthetic, not synthetic', () => {
    // Round-2 NOTE-D: the old default of 0 silently labelled crater samples
    // 'synthetic' (index 0) when a caller passed the mask without the index.
    const layer = measuredLayer(51, 0.5);
    const crater = makeCrater(new Rng('prov-default'), 'c1', 0, 0, 8, {
      meanDegradation: 0.2,
      degradationSpread: 0,
      ellipticalFraction: 0,
    });
    stampCrater(layer, crater, undefined, layer.masks.elevationSource);
    const values = new Set(layer.masks.elevationSource);
    expect(values.has(ELEVATION_SOURCES.indexOf('synthetic'))).toBe(false);
    expect(values.has(MEASURED_PLUS)).toBe(true);
  });
});

describe.skipIf(!existsSync(DEM))(
  'regolith microrelief marks provenance on DEM-grounded layers',
  () => {
    it('leaves no measured-labelled sample on a layer whose only synthesis is regolith', async () => {
      // The exact configuration class the round-2 review identified as the
      // failure case: procedural stack EMPTY, craters and rocks off, regolith
      // ON — so microrelief is the sole synthesis on a measured layer. Before
      // the fix, every sample of this export claimed 'measured' while
      // carrying procedural texture.
      const config = parseConfig({
        terrainId: 'provenance_regolith',
        seed: 'provenance-regolith-seed',
        outputDirectory: '/tmp/claude-1000/-mnt-projects-lunarlandscape/aad79c86-d3f7-49f9-be43-e808711b3f9e/scratchpad/prov-out',
        site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
        layers: [
          { role: 'operational', widthMeters: 20, lengthMeters: 20, resolutionMeters: 0.05 },
        ],
        dem: {
          enabled: true,
          path: DEM,
          applyToRoles: ['operational'],
          effectiveResolutionMeters: 17.5,
        },
        proceduralStack: [],
        craters: { enabled: false },
        rocks: { enabled: false },
        regolith: { enabled: true, maximumResolutionMeters: 0.1 },
        solar: { mode: 'ephemeris', epochUtc: '2026-01-01T00:00:00Z', computeHorizon: false },
      });

      const { dataset } = await generateTerrain(config, { workerThreads: 1 });
      const layer = dataset.layers[0];
      expect(layer.elevationProvenance).toBe('measured_dem_plus_synthetic_subresolution');

      const mask = layer.masks.elevationSource!;
      let measuredOnly = 0;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] === MEASURED) measuredOnly++;
      }
      expect(measuredOnly).toBe(0);

      // And the parallel path must agree byte-for-byte on the mask too.
      const parallel = await generateTerrain(config, { workerThreads: 4 });
      expect(
        Buffer.compare(
          Buffer.from(parallel.dataset.layers[0].masks.elevationSource!),
          Buffer.from(mask),
        ),
      ).toBe(0);
    }, 120_000);
  },
);
