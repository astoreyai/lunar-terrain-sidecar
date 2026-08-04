/**
 * Static terramechanics assessment tests (spec §22, §26; ADR 0005).
 *
 * Validation strategy: the library is checked against INDEPENDENTLY coded
 * hand computations of the published formulas (Bekker 1969; Wong 2008) — the
 * test re-derives sinkage and compaction resistance from the raw constants
 * without calling the library's own functions, then asserts agreement to
 * 1e-12. Structural identities from Wong's framework (n = 1 linearity,
 * zero-cohesion thrust, zero drawbar pull at the slope margin) pin the
 * shapes of the relations, and Mitchell et al. (1972) Apollo in-situ ranges
 * gate the parameter values themselves.
 *
 * The layer fixtures are analytically defined inclined planes — geometry
 * with an exact known slope, used to validate the slope→assessment path
 * against closed-form ground truth (the same technique the projection and
 * solar tests use). They are labelled fixtures, not measurements.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';
import type { TerrainLayer } from '@lts/shared-types';
import {
  LUNAR_REGOLITH_PARAMETERS,
  MITCHELL_1972_APOLLO_RANGES,
  REFERENCE_VEHICLE,
  TERRAMECHANICS_PROVENANCE,
  assessAt,
  assessLayer,
  compactionResistance,
  drawbarPull,
  maxThrustPerWheel,
  pressureSinkage,
  slopeMarginDeg,
  staticSinkage,
} from '@lts/lunar-terramech';

/**
 * Analytic inclined-plane fixture: a plane rising along +X at exactly
 * `slopeDeg`. Ground truth for the local slope at any interior sample is the
 * constructed angle itself (float32 height storage perturbs it by < 1e-3°).
 */
function planeLayer(slopeDeg: number, id = `plane-${slopeDeg}`): TerrainLayer {
  const size = 41;
  const res = 0.1;
  const grad = Math.tan((slopeDeg * Math.PI) / 180);
  const heightData = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      heightData[row * size + col] = grad * col * res;
    }
  }
  const maxY = grad * (size - 1) * res;
  return {
    id,
    role: 'operational',
    bounds: { minX: 0, minZ: 0, maxX: (size - 1) * res, maxZ: (size - 1) * res, minY: 0, maxY },
    horizontalResolutionMeters: res,
    verticalQuantizationMeters: 0,
    widthSamples: size,
    heightSamples: size,
    heightData,
    masks: {},
    elevationProvenance: 'synthetic',
  };
}

describe('Bekker validation against published structure', () => {
  it('matches an independent hand computation of sinkage and R_c to 1e-12', () => {
    // Hand computation straight from the published formulas and the sourced
    // constants — NOT calling the library. Flat-plate contact (Wong 2008):
    //   k = k_c/b + k_phi                       [bekker1969]
    //   z = (W / (k·b·sqrt(D)))^(2/(2n+1))      flat-plate rigid wheel
    //   R_c = b·z²·k/2                          Bekker, integral form for n=1
    const b = 0.2;
    const D = 2 * 0.25;
    const n = 1.0;
    const kc = 1400;
    const kphi = 820_000;
    const W = (450 * 1.62) / 4; // per-wheel load, lunar gravity
    const k = kc / b + kphi;
    const zHand = Math.pow(W / (k * b * Math.sqrt(D)), 2 / (2 * n + 1));
    const rcHand = (b * zHand * zHand * k) / 2;

    const s = staticSinkage(W);
    expect(Math.abs(s.sinkageM - zHand)).toBeLessThan(1e-12);
    expect(Math.abs(compactionResistance(s.sinkageM) - rcHand)).toBeLessThan(1e-12);

    // Sanity on the actual magnitudes: centimetre-scale sinkage, tens of
    // newtons of compaction resistance for a VIPER-class wheel.
    expect(s.sinkageM).toBeGreaterThan(0.005);
    expect(s.sinkageM).toBeLessThan(0.05);
    expect(rcHand).toBeGreaterThan(1);
    expect(rcHand).toBeLessThan(100);
  });

  it('halving ground pressure exactly halves sinkage (n = 1 linearity)', () => {
    // Wong-framework structural check: with n = 1 the plate equation
    // p = k·z is linear, so z(p/2) = z(p)/2 exactly.
    const p = 11_000; // Pa, representative of the reference wheel
    const z1 = pressureSinkage(p, LUNAR_REGOLITH_PARAMETERS, REFERENCE_VEHICLE.wheelWidthM);
    const z2 = pressureSinkage(p / 2, LUNAR_REGOLITH_PARAMETERS, REFERENCE_VEHICLE.wheelWidthM);
    // Division by 2 is exact in binary floating point, so this holds to the
    // last bit, not merely to a tolerance.
    expect(2 * z2).toBe(z1);
  });

  it('thrust at zero cohesion reduces to W·tan(phi)', () => {
    const W = (REFERENCE_VEHICLE.massKg * REFERENCE_VEHICLE.gravityMS2) / 4;
    const zeroCohesion = { ...LUNAR_REGOLITH_PARAMETERS, cohesionPa: 0 };
    const h = maxThrustPerWheel(0.016, W, zeroCohesion);
    const phiRad = zeroCohesion.frictionAngleDeg * (Math.PI / 180);
    expect(Math.abs(h - W * Math.tan(phiRad))).toBeLessThan(1e-12);
  });

  it('drawbar pull at the computed slope margin is 0 within 1e-9 N', () => {
    const margin = slopeMarginDeg();
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(90);
    expect(Math.abs(drawbarPull(margin).drawbarPullN)).toBeLessThan(1e-9);
  });

  it('produces a positive drawbar pull on flat ground for the reference rover', () => {
    const flat = drawbarPull(0);
    expect(flat.drawbarPullN).toBeGreaterThan(0);
    expect(flat.thrustN).toBeGreaterThan(flat.compactionResistanceN);
    expect(flat.gradientResistanceN).toBe(0);
  });
});

describe('parameter provenance against Mitchell et al. (1972) Apollo ranges', () => {
  it('keeps the chosen point values inside the in-situ measured ranges', () => {
    const p = LUNAR_REGOLITH_PARAMETERS;
    const r = MITCHELL_1972_APOLLO_RANGES;
    expect(p.cohesionPa).toBeGreaterThanOrEqual(r.cohesionPa.min);
    expect(p.cohesionPa).toBeLessThanOrEqual(r.cohesionPa.max);
    expect(p.frictionAngleDeg).toBeGreaterThanOrEqual(r.frictionAngleDeg.min);
    expect(p.frictionAngleDeg).toBeLessThanOrEqual(r.frictionAngleDeg.max);
    expect(p.bulkDensityKgM3).toBeGreaterThanOrEqual(r.bulkDensityKgM3.min);
    expect(p.bulkDensityKgM3).toBeLessThanOrEqual(r.bulkDensityKgM3.max);
  });

  it('keeps the Janosi K inside the Wong (2008) loose-sand range it is drawn from', () => {
    expect(LUNAR_REGOLITH_PARAMETERS.janosiShearModulusM).toBeGreaterThanOrEqual(0.01);
    expect(LUNAR_REGOLITH_PARAMETERS.janosiShearModulusM).toBeLessThanOrEqual(0.025);
  });

  it('cites every source key recorded in paper.bib', () => {
    expect([...TERRAMECHANICS_PROVENANCE.citations].sort()).toEqual(
      ['bekker1969', 'ishigami2007', 'janosi1961', 'li2022terramechanics', 'mitchell1972', 'wong2008'].sort(),
    );
  });
});

describe('slope behaviour', () => {
  it('drawbar pull is strictly decreasing in slope angle', () => {
    let previous = drawbarPull(0).drawbarPullN;
    for (let deg = 0.5; deg <= 89.5; deg += 0.5) {
      const dp = drawbarPull(deg).drawbarPullN;
      expect(dp).toBeLessThan(previous);
      previous = dp;
    }
  });

  it('gravity enters the margin only through resistances, not the friction limit', () => {
    // Structural cross-check: W·tan(phi) and m·g·sin(theta) both scale with
    // g, but A·c and R_c do not, so the margin must CHANGE when gravity does
    // — a margin independent of g would mean the cohesive and compaction
    // terms were silently dropped.
    const earthVehicle = { ...REFERENCE_VEHICLE, gravityMS2: 9.81 };
    expect(slopeMarginDeg(LUNAR_REGOLITH_PARAMETERS, earthVehicle)).not.toBeCloseTo(
      slopeMarginDeg(),
      3,
    );
  });
});

describe('per-sample assessment over a terrain layer', () => {
  const margin = slopeMarginDeg();

  it('classifies a 0° flat sample as go', () => {
    const layer = planeLayer(0);
    const a = assessAt(layer, 2.0, 2.0);
    expect(a).not.toBeNull();
    expect(a!.slopeDeg).toBeLessThan(1e-3);
    expect(a!.class).toBe('go');
    expect(a!.sinkageM).toBeGreaterThan(0);
    expect(a!.drawbarPullN).toBeGreaterThan(0.2 * a!.thrustN);
  });

  it('classifies a sample at slope margin + 5° as no-go', () => {
    const layer = planeLayer(margin + 5);
    const a = assessAt(layer, 2.0, 2.0);
    expect(a).not.toBeNull();
    expect(a!.slopeDeg).toBeCloseTo(margin + 5, 2);
    expect(a!.drawbarPullN).toBeLessThan(0);
    expect(a!.class).toBe('no-go');
  });

  it('returns null outside the layer instead of inventing a value', () => {
    expect(assessAt(planeLayer(0), -1, -1)).toBeNull();
  });

  it('carries the polar-provenance label in every assess() output', () => {
    for (const slope of [0, 10, margin + 5]) {
      const a = assessAt(planeLayer(slope), 2.0, 2.0);
      expect(a!.provenance.siteApplicability).toMatch(/NO polar site has in-situ/);
      expect(a!.provenance.parameterSource).toMatch(/20220010732/);
    }
    const grid = assessLayer(planeLayer(10));
    expect(grid.provenance.siteApplicability).toMatch(/NO polar site has in-situ/);
  });

  it('assesses every sample of a layer deterministically', () => {
    const layer = planeLayer(10);
    const a = assessLayer(layer);
    const b = assessLayer(layer);
    expect(a.slopeDeg.length).toBe(41 * 41);
    expect(Array.from(a.drawbarPullN)).toEqual(Array.from(b.drawbarPullN));
    expect(Array.from(a.classes)).toEqual(Array.from(b.classes));
    // A 10° plane is comfortably inside the margin: interior samples are go.
    const mid = 20 * 41 + 20;
    expect(a.classes[mid]).toBe(0);
    expect(a.slopeMarginDeg).toBeCloseTo(margin, 9);
  });
});

// ---------------------------------------------------------------- protocol

const PORT = 8809; // unique across the suite: 8791/93/95/8801/03/05/07 taken
const WORK = resolve(__dirname, '../.test-artifacts/terramech');

describe('terrain.getTraversability over the protocol', () => {
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

  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    const start = await rpc('terrain.generate', {
      config: {
        terrainId: 'terramech_site',
        seed: 'terramech-seed',
        outputDirectory: WORK,
        site: { latitudeDeg: -89.4, longitudeDeg: -137.5 },
        layers: [
          { role: 'context', widthMeters: 100, lengthMeters: 100, resolutionMeters: 1.0 },
          { role: 'operational', widthMeters: 20, lengthMeters: 20, resolutionMeters: 0.1 },
        ],
        craters: { enabled: true, minimumDiameterMeters: 0.5, maximumDiameterMeters: 8 },
        rocks: { enabled: true, minimumDiameterMeters: 0.1, maximumDiameterMeters: 1.0 },
        solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z', computeHorizon: false },
      },
    });
    const jobId: string = start.result.jobId;
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = (await rpc('terrain.getStatus', { jobId })).result;
      if (s.status === 'complete') return;
      if (s.status === 'failed') throw new Error(JSON.stringify(s.error));
    }
    throw new Error('generation did not complete');
  }, 300_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('defaults to the bekker model with provenance AND the embedded heuristic', async () => {
    const t = (await rpc('terrain.getTraversability', { x: 0, z: 0 })).result.traversability;
    expect(t.model).toBe('bekker');
    expect(t.sinkageM).toBeGreaterThan(0);
    expect(Number.isFinite(t.drawbarPullN)).toBe(true);
    expect(['go', 'marginal', 'no-go']).toContain(t.class);
    // The margin the server reports is the library's own, not a re-derivation.
    expect(t.slopeMarginDeg).toBeCloseTo(slopeMarginDeg(), 9);
    // Parameters travel WITH the provenance block (ADR 0005).
    expect(t.parameters.cohesionPa).toBe(LUNAR_REGOLITH_PARAMETERS.cohesionPa);
    expect(t.parameters.vehicle.massKg).toBe(450);
    expect(t.parameters.provenance.siteApplicability).toMatch(/NO polar site has in-situ/);
    expect(t.parameters.provenance.scope).toMatch(/STATIC assessment only/);
    // The legacy heuristic rides along for comparison, still labelled.
    expect(t.heuristic.provenance).toMatch(/synthetic heuristic/i);
    expect(t.heuristic.score).toBeGreaterThanOrEqual(0);
    expect(t.heuristic.score).toBeLessThanOrEqual(1);
  });

  it("model:'heuristic' returns the legacy shape exactly", async () => {
    const t = (await rpc('terrain.getTraversability', { x: 0, z: 0, model: 'heuristic' }))
      .result.traversability;
    // Byte-compatible with the pre-terramechanics response: the UI reads it.
    expect(Object.keys(t).sort()).toEqual(
      ['class', 'provenance', 'roughnessM', 'score', 'slopeDeg'].sort(),
    );
    expect(t.provenance).toMatch(/synthetic heuristic/i);
    expect(t.score).toBeGreaterThanOrEqual(0);
    expect(t.score).toBeLessThanOrEqual(1);
  });

  it('agrees between the embedded heuristic and the standalone heuristic call', async () => {
    const bekker = (await rpc('terrain.getTraversability', { x: 1.5, z: -2.5 })).result
      .traversability;
    const legacy = (await rpc('terrain.getTraversability', { x: 1.5, z: -2.5, model: 'heuristic' }))
      .result.traversability;
    expect(bekker.heuristic).toEqual(legacy);
  });

  it('rejects an unknown model with a structured error', async () => {
    const r = await rpc('terrain.getTraversability', { x: 0, z: 0, model: 'dynamic' });
    expect(r.error).toBeTruthy();
    expect(r.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(r.error.message).toMatch(/bekker|heuristic/);
  });
});
