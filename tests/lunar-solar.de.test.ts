/**
 * Validation of the dependency-free DE440 kernel reader against a FROZEN
 * independent reference (tests/data/de-reference.json, generated once by
 * scripts/freeze-de-reference.py from jplephem + CSPICE — an oracle validated
 * to 0.02 arcsec against JPL Horizons). These tests run offline: nothing here
 * shells out to Python or the network.
 *
 * The end-to-end DE-vs-analytic comparison in this file is also the
 * long-sought validation of the existing Meeus/IAU chain: until now its
 * ~0.01–0.03° error budget was a literature claim
 * (docs/known-limitations.md); here it is measured against JPL's numerically
 * integrated truth and printed.
 *
 * Everything is gated on the kernels being present at their canonical path —
 * absent kernels skip the suite rather than faking a pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';
import {
  DEFAULT_KERNEL_DIRECTORY,
  DE_PCK_FILENAME,
  DE_SPK_FILENAME,
  NAIF_CODES,
  PA_TO_ME_MATRIX,
  SpiceKernelError,
  compareWithAnalytic,
  j2000ToMoonMEMatrix,
  j2000ToMoonPAMatrix,
  loadDeKernels,
  parseInstant,
  solarPositionAtSiteDE,
  subSolarPointDE,
  type Mat3,
  type Vec3,
} from '@lts/lunar-solar';

const KERNELS_PRESENT =
  existsSync(join(DEFAULT_KERNEL_DIRECTORY, DE_SPK_FILENAME)) &&
  existsSync(join(DEFAULT_KERNEL_DIRECTORY, DE_PCK_FILENAME));

interface ReferenceEpoch {
  utc: string;
  etSec: number;
  moonToSunUnitJ2000: [number, number, number];
  moonToSunKm: [number, number, number];
  paAnglesRad: { phi: number; delta: number; w: number };
  j2000ToPaMatrix: number[];
  j2000ToMeMatrix: number[];
}

interface ReferenceFile {
  provenance: { kernels: Record<string, { sha256_16: string }> };
  paToMeMatrix: number[];
  epochs: ReferenceEpoch[];
}

const reference: ReferenceFile = JSON.parse(
  readFileSync(resolve(__dirname, 'data/de-reference.json'), 'utf8'),
);

/**
 * Angle between two unit vectors via the chord length, 2·asin(|a−b|/2).
 * Precision-safe for tiny angles, where acos(dot) bottoms out at ~1.5e-8 rad
 * because cos θ is flat near 1.
 */
function angleBetweenRad(a: Vec3, b: Vec3): number {
  const chord = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return 2 * Math.asin(Math.min(1, chord / 2));
}

/**
 * Rotation-angle distance between two rotation matrices, small-angle form
 * ‖A−B‖_F / √2. Exact enough below ~1e-3 rad and, unlike the trace formula,
 * does not lose the answer to double rounding near zero.
 */
function rotationDistanceRad(a: Mat3, b: Mat3): number {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / 2);
}

describe.skipIf(!KERNELS_PRESENT)('DE440 kernel reader vs frozen jplephem/CSPICE reference', () => {
  const kernels = KERNELS_PRESENT ? loadDeKernels() : undefined!;

  it('reads the expected segment inventory from de440s.bsp', () => {
    // 14 Type 2 segments, per the DAF summaries (verified against jplephem).
    expect(kernels.spk.segments).toHaveLength(14);
    expect(kernels.spk.segments.every((s) => s.dataType === 2)).toBe(true);
    const pairs = kernels.spk.segments.map((s) => `${s.center}->${s.target}`);
    for (const needed of ['0->10', '0->3', '3->301', '3->399']) {
      expect(pairs).toContain(needed);
    }
  });

  it('(a) chains Moon→Sun J2000 positions to < 1e-9 rad of the reference at all 24 epochs', () => {
    let worst = 0;
    for (const e of reference.epochs) {
      const rel = kernels.spk.positionKm(NAIF_CODES.SUN, NAIF_CODES.MOON, e.etSec);
      const n = Math.hypot(rel[0], rel[1], rel[2]);
      const unit: Vec3 = [rel[0] / n, rel[1] / n, rel[2] / n];
      worst = Math.max(worst, angleBetweenRad(unit, e.moonToSunUnitJ2000));

      // Distance agreement too, not just direction: relative error < 1e-12.
      const refN = Math.hypot(...e.moonToSunKm);
      expect(Math.abs(n - refN) / refN).toBeLessThan(1e-12);
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('(b) reproduces the PA Euler angles and orientation matrices to < 1e-9 rad', () => {
    let worstPa = 0;
    let worstMe = 0;
    for (const e of reference.epochs) {
      const angles = kernels.pck.eulerAngles(31008, e.etSec);
      // Raw unwrapped angles from the same Chebyshev polynomials jplephem
      // read; w is thousands of radians by 2049, so compare absolutely.
      expect(Math.abs(angles.phiRad - e.paAnglesRad.phi)).toBeLessThan(1e-9);
      expect(Math.abs(angles.deltaRad - e.paAnglesRad.delta)).toBeLessThan(1e-9);
      expect(Math.abs(angles.wRad - e.paAnglesRad.w)).toBeLessThan(1e-9);

      worstPa = Math.max(
        worstPa,
        rotationDistanceRad(j2000ToMoonPAMatrix(kernels.pck, e.etSec), e.j2000ToPaMatrix),
      );
      worstMe = Math.max(
        worstMe,
        rotationDistanceRad(j2000ToMoonMEMatrix(kernels.pck, e.etSec), e.j2000ToMeMatrix),
      );
    }
    expect(worstPa).toBeLessThan(1e-9);
    expect(worstMe).toBeLessThan(1e-9);
  });

  it('matches the fixed PA→ME rotation from the frames kernel against CSPICE exactly', () => {
    expect(rotationDistanceRad(PA_TO_ME_MATRIX, reference.paToMeMatrix)).toBeLessThan(1e-14);
  });

  it('(c) agrees with the analytic Meeus/IAU sub-solar point within its documented error budget', () => {
    // THE measurement this file exists for. The analytic chain's floor is the
    // IAU realisation of the ME frame, documented as ~0.01–0.03°; on top sit
    // the Meeus series (~0.01°). If the measured separation stayed under
    // 0.05° the budget holds; a blowout would mean the analytic chain (or
    // this reader) has a frame error.
    let maxSeparationDeg = 0;
    let atUtc = '';
    for (const e of reference.epochs) {
      const { separationDeg } = compareWithAnalytic(parseInstant(e.utc), kernels);
      if (separationDeg > maxSeparationDeg) {
        maxSeparationDeg = separationDeg;
        atUtc = e.utc;
      }
      expect(separationDeg).toBeLessThan(0.05);
    }
    // eslint-disable-next-line no-console
    console.log(
      `MEASURED Meeus/IAU-vs-DE440 sub-solar separation over 24 epochs 2020–2049: ` +
        `max ${maxSeparationDeg.toFixed(6)}° (at ${atUtc})`,
    );
  });

  it('(d) throws a structured coverage error for a 1700s epoch', () => {
    // de440s coverage starts in 1849; 1700 is far outside.
    const utc = parseInstant('1700-01-01T00:00:00Z');
    let thrown: unknown;
    try {
      subSolarPointDE(utc, kernels);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SpiceKernelError);
    const err = thrown as SpiceKernelError;
    expect(err.code).toBe('SPICE_COVERAGE');
    expect(err.details.etSec).toBeTypeOf('number');
    expect(err.details.startEt).toBeTypeOf('number');
    expect(err.details.endEt).toBeTypeOf('number');
  });

  it('(e) returns bit-identical az/el for the same instant', () => {
    const t = parseInstant('2031-05-14T09:15:27Z');
    const a = solarPositionAtSiteDE(t, -89.9, 123.4, kernels);
    const b = solarPositionAtSiteDE(new Date(t.getTime()), -89.9, 123.4, kernels);
    expect(a.elevationDeg).toBe(b.elevationDeg);
    expect(a.azimuthDeg).toBe(b.azimuthDeg);
    expect(a.subSolar.bodyFixedDirection).toEqual(b.subSolar.bodyFixedDirection);
  });

  it('keeps the DE sub-solar latitude inside the lunar obliquity envelope', () => {
    // Same physical invariant the analytic suite leans on, now for the
    // kernel path: |sub-solar latitude| stays within ±1.60°.
    for (const e of reference.epochs) {
      expect(Math.abs(subSolarPointDE(parseInstant(e.utc), kernels).latitudeDeg)).toBeLessThan(1.6);
    }
  });
});

describe.skipIf(!KERNELS_PRESENT)('terrain.getSolar with mode ephemeris_de over the protocol', () => {
  // Unique across ALL test files (vitest runs files in parallel):
  // 8791/93/95/8801/03/05 are taken by other suites and 8796–8799 are held
  // by unrelated services on this host.
  const PORT = 8807;
  const WORK = resolve(__dirname, '../.test-artifacts/de-solar');
  const EPOCH = '2031-05-14T09:15:27Z';

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

  const config = {
    terrainId: 'de_solar_site',
    seed: 'de-solar-seed',
    outputDirectory: WORK,
    site: { latitudeDeg: -89.4, longitudeDeg: -137.5 },
    layers: [{ role: 'context', widthMeters: 40, lengthMeters: 40, resolutionMeters: 0.5 }],
    craters: { enabled: false },
    rocks: { enabled: false },
    regolith: { enabled: false },
    solar: { mode: 'ephemeris', epochUtc: EPOCH, computeHorizon: false },
  };

  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });

    const start = await rpc('terrain.generate', { config });
    const jobId: string = start.result.jobId;
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = (await rpc('terrain.getStatus', { jobId })).result;
      if (s.status === 'complete' || s.status === 'failed') break;
    }
  }, 120_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('(f) returns DE-mode solar geometry within 0.05° of analytic mode, labelled ephemeris_de', async () => {
    const analytic = (await rpc('terrain.getSolar', { epochUtc: EPOCH })).result;
    const de = (await rpc('terrain.getSolar', { epochUtc: EPOCH, mode: 'ephemeris_de' })).result;

    expect(analytic.model).toBe('ephemeris');
    expect(de.model).toBe('ephemeris_de');
    expect(Math.abs(de.elevationDeg - analytic.elevationDeg)).toBeLessThan(0.05);
    expect(Math.abs(de.subSolar.latitudeDeg - analytic.subSolar.latitudeDeg)).toBeLessThan(0.05);

    // The DE numbers over the wire are the library's numbers, untransformed.
    const direct = solarPositionAtSiteDE(
      parseInstant(EPOCH),
      de.site.latitudeDeg,
      de.site.longitudeDeg,
    );
    expect(de.elevationDeg).toBe(direct.elevationDeg);
    expect(de.azimuthDeg).toBe(direct.azimuthDeg);
  });

  it('rejects an unknown mode with a structured error', async () => {
    const r = await rpc('terrain.getSolar', { epochUtc: EPOCH, mode: 'horoscope' });
    expect(r.error).toBeTruthy();
    expect(r.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
  });

  it('fails loudly, not silently, when the kernel directory is wrong', async () => {
    const r = await rpc('terrain.getSolar', {
      epochUtc: EPOCH,
      mode: 'ephemeris_de',
      kernelDirectory: '/nonexistent/kernels',
    });
    expect(r.error).toBeTruthy();
    expect(r.error.data.code).toBe('TERRAIN_SPICE_KERNELS_UNAVAILABLE');
  });
});
