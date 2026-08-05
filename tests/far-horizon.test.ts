/**
 * Far-field horizon ring (ADR 0006).
 *
 * Three layers of evidence:
 *
 *  1. **Analytic geometry** on in-memory rasters where every expected angle
 *     has a closed form (flat sphere → the exact −γ/2 ground angle and the
 *     classical observer-height horizon dip; a single raised wall → azimuth
 *     orientation, the one bug class a flat sphere cannot catch).
 *  2. **Real LDEM_75S** at the demonstration site: determinism, coverage,
 *     plausibility, truncation reporting, and a pinned regression value.
 *  3. **Protocol round-trip**: opt-in `farField` on terrain.getHorizon over a
 *     real DEM-grounded dataset; back-compat response without it; structured
 *     refusals for procedural datasets and a missing product.
 *
 * The analytic rasters are geometry fixtures for testing math, in the same
 * spirit as the flat layers of construction.test.ts — they are never fed to
 * the terrain pipeline and never masquerade as measurement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import {
  farFieldHorizon,
  openPdsRaster,
  forward,
  SOUTH_POLAR_LOLA,
  LUNAR_RADIUS_M,
  type DemRaster,
} from '@lts/lunar-dem';
import { startServer } from '../apps/headless-server/src/server.js';

const LDEM_LBL = '/mnt/projects/stewie/data/gis/raw/ldem_75s_120m.lbl';
const SITE_DEM = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';
const SITE = { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 };

const ldemAvailable = existsSync(LDEM_LBL);
const siteDemAvailable = existsSync(SITE_DEM);

// ------------------------------------------------------------ analytic rasters

/**
 * An in-memory DemRaster whose radial elevation is a pure function of the
 * projected coordinate. 120 m/px south polar grid, generous extent.
 */
function analyticRaster(heightAt: (x: number, y: number) => number): DemRaster {
  const mapScale = 120;
  const half = 4000; // pixels each side of the pole → ±480 km
  const size = 2 * half + 1;
  return {
    widthPixels: size,
    heightPixels: size,
    resolutionMeters: mapScale,
    projection: SOUTH_POLAR_LOLA,
    provenance: {
      id: 'analytic-test-raster',
      description: 'geometry fixture (test-only, never a measurement)',
      path: '(memory)',
      citation: 'n/a',
      resolutionMeters: mapScale,
    },
    pixelToProjected(col, row) {
      return { x: (col - half) * mapScale, y: (half - row) * mapScale };
    },
    projectedToPixel(x, y) {
      return { col: x / mapScale + half, row: half - y / mapScale };
    },
    readWindow(col0, row0, width, height) {
      const c0 = Math.max(0, col0);
      const r0 = Math.max(0, row0);
      const w = Math.min(size, col0 + width) - c0;
      const h = Math.min(size, row0 + height) - r0;
      const data = new Float32Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const p = this.pixelToProjected(c0 + c, r0 + r);
          data[r * w + c] = heightAt(p.x, p.y);
        }
      }
      return { col0: c0, row0: r0, width: w, height: h, data };
    },
  };
}

describe('farFieldHorizon — analytic geometry', () => {
  const R = LUNAR_RADIUS_M;

  it('flat sphere at observer height 0: every bin is the exact −γ/2 ground angle', () => {
    const raster = analyticRaster(() => 0);
    const startRangeM = 240;
    const far = farFieldHorizon(
      raster,
      { latitudeDeg: -89, longitudeDeg: 30, radialElevationM: 0 },
      { azimuthBins: 36, startRangeM, maxRangeM: 50_000 },
    );
    // On a flat sphere the ground angle el(s) = −(s/R)/2 exactly (the atan2
    // form reduces to atan(−tan(γ/2))), monotonically decreasing in s — so
    // the maximum over the march is at the first sample.
    const expectedDeg = (-(startRangeM / R) / 2 / Math.PI) * 180;
    for (let b = 0; b < 36; b++) {
      expect(far.horizonElevationDeg[b]).toBeCloseTo(expectedDeg, 9);
    }
    expect(far.truncatedAtM).toBe(Infinity);
    expect(far.noDataSamples).toBe(0);
  });

  it('flat sphere with an elevated observer: dip approaches the classical horizon depression', () => {
    const raster = analyticRaster(() => 0);
    const h0 = 2000;
    const far = farFieldHorizon(
      raster,
      { latitudeDeg: -89, longitudeDeg: 0, radialElevationM: h0 },
      // Dense, growth-free stepping so the sampled maximum lands close to the
      // true tangent point at s = R·acos(R/(R+h0)) ≈ 83.4 km.
      { azimuthBins: 8, startRangeM: 240, maxRangeM: 150_000, stepGrowth: 0 },
    );
    const classicalDipDeg = (-Math.acos(R / (R + h0)) / Math.PI) * 180; // ≈ −2.751°
    for (let b = 0; b < 8; b++) {
      expect(far.horizonElevationDeg[b]).toBeGreaterThan(classicalDipDeg - 1e-6);
      expect(far.horizonElevationDeg[b]).toBeCloseTo(classicalDipDeg, 3);
    }
  });

  it('a wall due east appears in the east bin and nowhere opposite (azimuth orientation)', () => {
    const R_ = LUNAR_RADIUS_M;
    const site = { latitudeDeg: -88.5, longitudeDeg: 45, radialElevationM: 0 };
    // Place the wall's centre 5 km along the initial-bearing-90° great circle
    // (due east), computed with an independent hand-rolled destination step.
    const s = 5000;
    const lat1 = (site.latitudeDeg * Math.PI) / 180;
    const lon1 = (site.longitudeDeg * Math.PI) / 180;
    const arc = s / R_;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(arc));
    const lon2 =
      lon1 + Math.atan2(Math.sin(arc) * Math.cos(lat1), Math.cos(arc) - Math.sin(lat1) * Math.sin(lat2));
    const wall = forward((lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI);
    const WALL_H = 500;
    const WALL_RADIUS = 1000;
    const raster = analyticRaster((x, y) => (Math.hypot(x - wall.x, y - wall.y) < WALL_RADIUS ? WALL_H : 0));

    const far = farFieldHorizon(raster, site, {
      azimuthBins: 360,
      startRangeM: 240,
      maxRangeM: 20_000,
      stepGrowth: 0,
    });
    // The east bin sees the wall at roughly atan(500 m / 4 km..5 km) ≈ 6–7°.
    expect(far.horizonElevationDeg[90]).toBeGreaterThan(4);
    // North, west, and south see flat sphere (slightly negative).
    for (const b of [0, 180, 270]) {
      expect(far.horizonElevationDeg[b]).toBeLessThan(0);
    }
  });
});

// ------------------------------------------------------------------ real LDEM

describe.skipIf(!ldemAvailable)('farFieldHorizon — real LDEM_75S', () => {
  it('is deterministic, covers 100 km untruncated, and pins the Site01 ring', () => {
    const raster = openPdsRaster(LDEM_LBL);
    const observer = { ...SITE, radialElevationM: 1949.5 };
    const a = farFieldHorizon(raster, observer);
    const b = farFieldHorizon(raster, observer);
    expect(Array.from(a.horizonElevationDeg)).toEqual(Array.from(b.horizonElevationDeg));

    expect(a.truncatedAtM).toBe(Infinity);
    expect(a.noDataSamples).toBe(0);
    expect(a.horizonElevationDeg.length).toBe(360);

    const els = Array.from(a.horizonElevationDeg);
    const max = Math.max(...els);
    const min = Math.min(...els);
    // Physical plausibility band for a south-polar site on real topography.
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(6);
    expect(min).toBeGreaterThan(-10);

    // Regression pin (2026-08-04, growth-8 stepping, 100 km, 240 m start).
    // These are measured values of THIS implementation on the real product —
    // if an intentional algorithm change moves them, re-measure and update
    // alongside the change, as with the reproduce baseline.
    expect(els[0]).toBeCloseTo(0.51090, 4);
    expect(max).toBeCloseTo(0.70193, 4);
    expect(els.indexOf(max)).toBe(17);
  });

  it('reports truncation when the march can leave the product', () => {
    const raster = openPdsRaster(LDEM_LBL);
    // 500 km from ~16 km off the pole crosses the 75°S edge (~457 km).
    const far = farFieldHorizon(
      raster,
      { ...SITE, radialElevationM: 1949.5 },
      { azimuthBins: 12, maxRangeM: 500_000 },
    );
    expect(far.truncatedAtM).not.toBe(Infinity);
    expect(far.truncatedAtM).toBeGreaterThan(400_000);
  });

  it('throws when the observer is outside the product', () => {
    const raster = openPdsRaster(LDEM_LBL);
    expect(() =>
      farFieldHorizon(raster, { latitudeDeg: -60, longitudeDeg: 0, radialElevationM: 0 }),
    ).toThrow(/outside/);
  });
});

// ----------------------------------------------------------------- protocol

describe.skipIf(!ldemAvailable || !siteDemAvailable)('terrain.getHorizon farField over the protocol', () => {
  const PORT = 8816;
  const WORK = resolve(__dirname, '../.test-artifacts/far-horizon');

  let server: WebSocketServer;
  let socket: WebSocket;
  let nextId = 1;

  function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 120_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== id) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolvePromise(msg);
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async function generate(config: Record<string, unknown>): Promise<void> {
    const start = await rpc('terrain.generate', { config });
    expect(start.result?.jobId, JSON.stringify(start.error)).toBeDefined();
    for (;;) {
      const st = await rpc('terrain.getStatus', { jobId: start.result.jobId });
      if (st.result.status === 'complete') return;
      if (st.result.status === 'failed') throw new Error(JSON.stringify(st.result.error));
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const demConfig = {
    terrainId: 'far_horizon_site',
    seed: 'far-horizon-test',
    outputDirectory: WORK,
    site: SITE,
    layers: [{ role: 'context', widthMeters: 120, lengthMeters: 120, resolutionMeters: 1 }],
    dem: { enabled: true, path: SITE_DEM, effectiveResolutionMeters: 17.5 },
    craters: { enabled: false },
    rocks: { enabled: false },
    solar: { mode: 'ephemeris', epochUtc: '2026-01-10T00:00:00Z' },
  };

  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res) => socket.on('open', () => res()));
    await generate(demConfig);
  }, 180_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('keeps the near-field-only response shape when farField is not requested', async () => {
    const r = (await rpc('terrain.getHorizon', {})).result;
    expect(r.horizonElevationDeg).toHaveLength(360);
    expect(r.farField).toBeUndefined();
    expect(r.nearFieldElevationDeg).toBeUndefined();
  });

  it('merges the LDEM ring by per-bin max and labels its provenance', async () => {
    const r = (await rpc('terrain.getHorizon', { farField: true })).result;
    expect(r.farField.applied).toBe(true);
    expect(r.farField.source.id).toMatch(/ldem/i);
    expect(r.farField.maxRangeM).toBe(100_000);
    expect(r.farField.truncatedAtM).toBeNull();
    expect(r.farField.observer.latitudeDeg).toBeCloseTo(SITE.latitudeDeg, 4);
    // The observer's radial elevation must be near the real LDEM surface
    // there (~1.95 km) — datum bookkeeping gone wrong lands hundreds of
    // metres away and poisons every angle.
    expect(r.farField.observer.radialElevationM).toBeGreaterThan(1900);
    expect(r.farField.observer.radialElevationM).toBeLessThan(2000);

    expect(r.nearFieldElevationDeg).toHaveLength(360);
    for (let i = 0; i < 360; i++) {
      expect(r.horizonElevationDeg[i]).toBe(
        Math.max(r.nearFieldElevationDeg[i], r.farField.elevationDeg[i]),
      );
    }
    // The far field must contribute real skyline the 120 m layer cannot
    // see. It does not dominate everywhere: the near field ray-marches from
    // one metre out, where centimetre relief legitimately subtends degrees.
    const raised = r.horizonElevationDeg.filter(
      (v: number, i: number) => v > r.nearFieldElevationDeg[i],
    ).length;
    expect(raised).toBeGreaterThan(30);
  });

  it('honours maxRangeMeters and reports it back', async () => {
    const r = (await rpc('terrain.getHorizon', { farField: { maxRangeMeters: 20_000 } })).result;
    expect(r.farField.maxRangeM).toBe(20_000);
  });

  it('fails structured when the product is missing', async () => {
    const r = await rpc('terrain.getHorizon', {
      farField: { demPath: '/nonexistent/ldem_75s_120m.lbl' },
    });
    expect(r.error).toBeDefined();
    expect(JSON.stringify(r.error)).toContain('TERRAIN_DEM_UNAVAILABLE');
  });

  it('refuses a procedural (non-measured) dataset with a structured error', async () => {
    const { dem: _dem, ...noDem } = demConfig;
    await generate({
      ...noDem,
      terrainId: 'far_horizon_procedural',
      proceduralStack: [
        {
          id: 'base',
          model: 'fbm',
          fractal: { octaves: 4, lacunarity: 2, persistence: 0.5, frequency: 0.05, amplitude: 1.5 },
        },
      ],
    });
    const r = await rpc('terrain.getHorizon', { farField: true });
    expect(r.error).toBeDefined();
    expect(JSON.stringify(r.error)).toContain('TERRAIN_INVALID_CONFIG');
    expect(JSON.stringify(r.error)).toContain('DEM-grounded');
  });
});
