/**
 * Sidecar protocol tests (spec §16, §26 "protocol tests").
 *
 * Drives the real server over a real WebSocket — no mocked transport — so the
 * message framing, the job lifecycle, progress notifications and the structured
 * error shape are all exercised as a Godot client would meet them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';
import {
  METHODS,
  PROTOCOL_VERSION,
  ROCK_TRANSFER_ENCODING,
  RPC_CODES,
} from '@lts/terrain-protocol';

const PORT = 8791;
const WORK = resolve(__dirname, '../.test-artifacts/protocol');
/** Real DEM used only by the concurrency test (its yield opens the race window). */
import { SITE01_DEM as CONCURRENCY_DEM } from './paths.js';

let server: WebSocketServer;
let socket: WebSocket;
let nextId = 1;
const progressEvents: Array<{ stage: string; progress: number; jobId: string }> = [];

/** Send a request and resolve with its matching response. */
function rpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 120_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'terrain.progress') {
        progressEvents.push({ stage: msg.stage, progress: msg.progress, jobId: msg.jobId });
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolvePromise(msg);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

const smallConfig = {
  terrainId: 'protocol_site',
  seed: 'protocol-seed',
  outputDirectory: WORK,
  site: { latitudeDeg: -89.4, longitudeDeg: -137.5 },
  layers: [
    { role: 'context', widthMeters: 100, lengthMeters: 100, resolutionMeters: 1.0 },
    { role: 'operational', widthMeters: 20, lengthMeters: 20, resolutionMeters: 0.1 },
  ],
  craters: { enabled: true, minimumDiameterMeters: 0.5, maximumDiameterMeters: 8 },
  rocks: { enabled: true, minimumDiameterMeters: 0.1, maximumDiameterMeters: 1.0 },
  solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z', computeHorizon: true },
};

describe('sidecar protocol', () => {
  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
  }, 60_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('reports health and the protocol version', async () => {
    const r = await rpc('terrain.health');
    expect(r.result.status).toBe('ok');
    expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('rejects browser WebSockets from non-local origins', async () => {
    const attacker = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      origin: 'https://untrusted.example',
    });
    const status = await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('cross-origin handshake did not finish')), 5_000);
      attacker.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        response.resume();
        resolvePromise(response.statusCode ?? 0);
      });
      attacker.once('open', () => {
        clearTimeout(timer);
        attacker.close();
        reject(new Error('untrusted browser origin was accepted'));
      });
      attacker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(status).toBe(403);
  });

  it('declares its capabilities honestly', async () => {
    const r = await rpc('terrain.capabilities');
    expect(r.result.methods).toEqual([...METHODS]);
    expect(r.result.coordinateSystem.north_axis).toBe('-Z');
    expect(r.result.solarModes).toContain('ephemeris_de');
    // Anything unbuilt is named as unbuilt rather than silently absent.
    expect(r.result.notImplemented).toBeTruthy();
    expect(Object.keys(r.result.notImplemented).length).toBeGreaterThan(0);
  });

  it('reports where the Site01 DEM actually is, so clients need no machine-specific default', async () => {
    // The browser UI cannot read the environment; it asks the sidecar. The
    // sidecar resolves LTS_SITE01_DEM (or its documented fallback), checks the
    // file exists, and reports the path or null — never a path that would fail.
    const r = await rpc('terrain.capabilities');
    const datasets = r.result.datasets;
    expect(datasets).toBeTruthy();
    if (existsSync(CONCURRENCY_DEM)) {
      expect(datasets.site01DemPath).toBe(CONCURRENCY_DEM);
      expect(['env:LTS_SITE01_DEM', 'default']).toContain(datasets.site01DemSource);
    } else {
      expect(datasets.site01DemPath).toBeNull();
      expect(datasets.site01DemSource).toBe('none');
    }
  });

  it('rejects an unknown method with METHOD_NOT_FOUND', async () => {
    const r = await rpc('terrain.doesNotExist');
    expect(r.error.code).toBe(RPC_CODES.METHOD_NOT_FOUND);
    expect(r.error.data.supported).toContain('terrain.generate');
  });

  it('rejects JSON null as INVALID_REQUEST without dropping the connection', async () => {
    const response = await new Promise<any>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout on literal null request')), 5_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString());
        if (message.id !== null) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolvePromise(message);
      };
      socket.on('message', onMessage);
      socket.send('null');
    });
    expect(response.error.code).toBe(RPC_CODES.INVALID_REQUEST);
    expect((await rpc('terrain.health')).result.status).toBe('ok');
  });

  it('validates a good configuration', async () => {
    const r = await rpc('terrain.validateConfig', { config: smallConfig });
    expect(r.result.valid).toBe(true);
    expect(r.result.seed).toBe('protocol-seed');
  });

  it('returns a structured error for an invalid configuration', async () => {
    const r = await rpc('terrain.validateConfig', {
      config: { ...smallConfig, layers: [{ role: 'context', widthMeters: -5, lengthMeters: 10, resolutionMeters: 1 }] },
    });
    expect(r.error.code).toBe(RPC_CODES.TERRAIN_ERROR);
    expect(r.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(Array.isArray(r.error.data.details.issues)).toBe(true);
  });

  it('estimates before generating, and refuses an infeasible request', async () => {
    const good = await rpc('terrain.estimate', { config: smallConfig });
    expect(good.result.feasible).toBe(true);
    expect(good.result.estimate.totalSamples).toBeGreaterThan(0);

    const bad = await rpc('terrain.estimate', {
      config: {
        ...smallConfig,
        layers: [
          { role: 'context', widthMeters: 4000, lengthMeters: 4000, resolutionMeters: 2 },
          { role: 'operational', widthMeters: 3000, lengthMeters: 3000, resolutionMeters: 0.01 },
        ],
      },
    });
    expect(bad.result.feasible).toBe(false);
    expect(bad.result.error.code).toBe('TERRAIN_MEMORY_LIMIT_EXCEEDED');
    expect(bad.result.error.details.estimatedBytes).toBeGreaterThan(
      bad.result.error.details.limitBytes,
    );
  });

  it('runs a generation job to completion with progress events', async () => {
    const start = await rpc('terrain.generate', { config: smallConfig });
    expect(start.result.status).toBe('queued');
    const jobId: string = start.result.jobId;

    let status: any;
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await rpc('terrain.getStatus', { jobId })).result;
      if (status.status === 'complete' || status.status === 'failed') break;
    }
    expect(status.status).toBe('complete');
    expect(status.progress).toBe(1);

    const mine = progressEvents.filter((e) => e.jobId === jobId);
    expect(mine.length).toBeGreaterThan(3);
    expect(mine.some((e) => e.stage === 'generating_craters')).toBe(true);
    // Progress must be monotonic; a client drawing a bar should never see it
    // jump backwards.
    for (let i = 1; i < mine.length; i++) {
      expect(mine[i].progress).toBeGreaterThanOrEqual(mine[i - 1].progress);
    }
  }, 300_000);

  it('serves the manifest of the completed job', async () => {
    const r = await rpc('terrain.getManifest', { directory: WORK });
    expect(r.result.terrainId).toBe('protocol_site');
    expect(r.result.coordinate_system.north_axis).toBe('-Z');
    expect(r.result.provenance.seeds.master).toBe('protocol-seed');
  });

  it('streams a bounded, explicitly modelled rock-instance preview', async () => {
    const dataset = (await rpc('terrain.getDataset')).result;
    const r = await rpc('terrain.getRocks', { maxInstances: 8 });
    expect(r.result).toMatchObject({
      terrainId: dataset.terrainId,
      seed: dataset.seed,
      datasetRevision: dataset.datasetRevision,
      sequenceNumber: dataset.sequenceNumber,
    });
    expect(r.result.baseline).toEqual(dataset.baseline);
    expect(r.result.totalCount).toBeGreaterThan(8);
    expect(r.result.returnedCount).toBe(8);
    expect(r.result.truncated).toBe(true);
    expect(r.result.transferEncoding).toBe(ROCK_TRANSFER_ENCODING);
    expect(r.result.transferSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.result.transferSha256).not.toBe(r.result.baseline.rocks.transferSha256);
    expect(Buffer.from(r.result.transferData, 'base64').byteLength).toBeGreaterThan(0);
    expect(r.result.provenance).toMatch(/modelled|modeled/i);
    expect(r.result.provenance).toMatch(/not measured/i);
    expect(r.result.rocks).toHaveLength(8);
    expect(r.result.rocks.map((rock: { id: string }) => rock.id)).toEqual(
      r.result.rocks.map((rock: { id: string }) => rock.id).toSorted(),
    );
    for (const rock of r.result.rocks) {
      expect(rock.position_m).toHaveLength(3);
      expect(rock.rotation_quaternion).toHaveLength(4);
      expect(rock.scale_m).toHaveLength(3);
      expect(typeof rock.physical).toBe('boolean');
    }

    const one = await rpc('terrain.getRocks', { maxInstances: 1 });
    expect(one.result.rocks).toHaveLength(1);
    expect(one.result.rocks[0].physical).toBe(true);

    const complete = await rpc('terrain.getRocks', { maxInstances: 50_000 });
    expect(complete.result.truncated).toBe(false);
    const completeTransfer = Buffer.from(complete.result.transferData, 'base64');
    expect(createHash('sha256').update(completeTransfer).digest('hex')).toBe(
      complete.result.transferSha256,
    );
    expect(complete.result.transferSha256).toBe(dataset.baseline.rocks.transferSha256);
    expect(complete.result.rocks.map((rock: { id: string }) => rock.id)).toEqual(
      complete.result.rocks.map((rock: { id: string }) => rock.id).toSorted(),
    );

    const invalid = await rpc('terrain.getRocks', { maxInstances: 0 });
    expect(invalid.error.code).toBe(RPC_CODES.TERRAIN_ERROR);
    expect(invalid.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
  });

  it('returns one opaque, complete baseline identity on dataset and sync metadata', async () => {
    const dataset = (await rpc('terrain.getDataset')).result;
    expect(dataset.baseline).toMatchObject({
      schemaVersion: 1,
      immutableIdentitySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      worldStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      rocks: {
        totalCount: dataset.features.rocks,
        physicalCount: expect.any(Number),
        physicsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        transferSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(dataset.baseline.layers).toHaveLength(dataset.layers.length);
    for (const layer of dataset.baseline.layers) {
      expect(layer).toMatchObject({
        layerId: expect.any(String),
        heightSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        semanticSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(
        layer.disturbanceSha256 === null || /^[0-9a-f]{64}$/.test(layer.disturbanceSha256),
      ).toBe(true);
      expect(
        layer.elevationSourceSha256 === null ||
          /^[0-9a-f]{64}$/.test(layer.elevationSourceSha256),
      ).toBe(true);
    }

    const poll = (
      await rpc('terrain.getChangedSince', {
        datasetRevision: dataset.datasetRevision,
        sequenceNumber: dataset.sequenceNumber,
      })
    ).result;
    expect(poll.baseline).toEqual(dataset.baseline);
  });

  it('answers point queries consistently with each other', async () => {
    const h = (await rpc('terrain.getHeight', { x: 1.25, z: -2.5 })).result;
    expect(Number.isFinite(h.elevationM)).toBe(true);
    expect(h.layerId).toBe('operational-1');

    const n = (await rpc('terrain.getNormal', { x: 1.25, z: -2.5 })).result;
    expect(n.normal.y).toBeGreaterThan(0);
    const len = Math.hypot(n.normal.x, n.normal.y, n.normal.z);
    expect(len).toBeCloseTo(1, 6);

    const s = (await rpc('terrain.getSemanticClass', { x: 1.25, z: -2.5 })).result;
    expect(typeof s.semanticClass).toBe('string');
  });

  it('labels traversability models honestly on both paths', async () => {
    // The default model is now the static Bekker–Wong assessment (ADR 0005):
    // the response carries the parameter provenance block, and the legacy
    // heuristic rides along — still labelled as a heuristic.
    const t = (await rpc('terrain.getTraversability', { x: 0, z: 0 })).result;
    expect(t.traversability.model).toBe('bekker');
    expect(t.traversability.parameters.provenance.accuracy).toMatch(/NOT claiming force-accuracy/);
    expect(t.traversability.heuristic.provenance).toMatch(/synthetic heuristic/i);

    // model:'heuristic' still returns the legacy shape, labelled (spec §22/§33:
    // heuristics must be marked as heuristics).
    const legacy = (await rpc('terrain.getTraversability', { x: 0, z: 0, model: 'heuristic' }))
      .result;
    expect(legacy.traversability.score).toBeGreaterThanOrEqual(0);
    expect(legacy.traversability.score).toBeLessThanOrEqual(1);
    expect(legacy.traversability.provenance).toMatch(/synthetic heuristic/i);
  });

  it('returns solar geometry consistent with a polar site', async () => {
    const s = (await rpc('terrain.getSolar', { epochUtc: '2026-08-03T00:00:00Z' })).result;
    // At 89.4°S the Sun cannot climb far above the horizon.
    expect(Math.abs(s.elevationDeg)).toBeLessThan(2.2);
    expect(Math.abs(s.subSolar.latitudeDeg)).toBeLessThan(1.6);
    expect(s.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(s.azimuthDeg).toBeLessThan(360);
  });

  it('returns a terrain horizon profile', async () => {
    const h = (await rpc('terrain.getHorizon', { azimuthBins: 72 })).result;
    expect(h.horizonElevationDeg).toHaveLength(72);
    expect(h.azimuthStepDeg).toBeCloseTo(5, 9);
    expect(h.horizonElevationDeg.every((v: number) => Number.isFinite(v))).toBe(true);
  });

  it('streams a tile as base64 float32', async () => {
    const t = (await rpc('terrain.getTile', {
      layerId: 'operational-1',
      col0: 0,
      row0: 0,
      width: 16,
      height: 16,
    })).result;
    expect(t.encoding).toBe('base64:float32le');
    const buf = Buffer.from(t.data, 'base64');
    expect(buf.length).toBe(16 * 16 * 4);
    expect(Number.isFinite(buf.readFloatLE(0))).toBe(true);

    for (const width of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const rejected = await rpc('terrain.getTile', {
        layerId: 'operational-1',
        col0: 0,
        row0: 0,
        width,
        height: 1,
      });
      expect(rejected.error.code).toBe(RPC_CODES.TERRAIN_ERROR);
      expect(rejected.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    }
  });

  it('applies an edit and returns a replayable delta', async () => {
    const before = (await rpc('terrain.getHeight', { x: 0, z: 0 })).result.elevationM;

    const r = (await rpc('terrain.applyOperation', {
      operation: {
        kind: 'lower',
        layerId: 'operational-1',
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 2,
        strengthMeters: 0.5,
        falloff: 2,
      },
    })).result;

    expect(r.delta.operations).toHaveLength(1);
    expect(r.delta.previousChecksum).not.toBe(r.delta.resultingChecksum);
    expect(r.delta.previousRockTransferSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.delta.resultingRockTransferSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.delta.rocksReseated === 0).toBe(
      r.delta.previousRockTransferSha256 === r.delta.resultingRockTransferSha256,
    );
    expect(r.delta.changedTiles.length).toBeGreaterThan(0);
    expect(r.delta.affectedBounds.minX).toBeLessThan(0);
    expect(r.delta.massBalance.removedVolumeM3).toBeGreaterThan(0);

    const after = (await rpc('terrain.getHeight', { x: 0, z: 0 })).result.elevationM;
    expect(after).toBeCloseTo(before - 0.5, 5);
  });

  it('conserves mass when asked to, and reports the residual', async () => {
    const r = (await rpc('terrain.applyOperation', {
      operation: {
        kind: 'lower',
        layerId: 'operational-1',
        centerXMeters: 5,
        centerZMeters: 5,
        radiusMeters: 2,
        strengthMeters: 0.4,
        falloff: 2,
        massConserving: true,
      },
    })).result;

    const mb = r.delta.massBalance;
    expect(mb.removedVolumeM3).toBeGreaterThan(0);
    expect(mb.depositedVolumeM3).toBeGreaterThan(0);
    // Cut and fill must balance; the residual is reported, not assumed zero.
    expect(mb.relativeError).toBeLessThan(0.01);
  });

  it('rejects non-finite operation parameters instead of committing NaN', async () => {
    // Regression: a malformed strengthMeters previously flowed into the
    // heightfield as NaN with a success response, surfacing only much later
    // as validation failures far from the cause.
    const r = await rpc('terrain.applyOperation', {
      operation: { kind: 'raise', radiusMeters: 2, strengthMeters: 'oops' },
    });
    expect(r.error.code).toBe(RPC_CODES.TERRAIN_ERROR);
    expect(r.error.data.code).toBe('TERRAIN_INVALID_CONFIG');

    // The terrain must be untouched: the origin still answers finitely.
    const h = (await rpc('terrain.getHeight', { x: 0, z: 0 })).result;
    expect(Number.isFinite(h.elevationM)).toBe(true);
  });

  it('keeps vertical bounds current after an edit', async () => {
    // Regression: edits mutated heights but not layer bounds, so an
    // export-after-edit failed the exporter's own vertical-bounds check on
    // healthy data. A big raise followed by an export must still validate.
    await rpc('terrain.applyOperation', {
      operation: {
        kind: 'raise',
        layerId: 'operational-1',
        centerXMeters: -5,
        centerZMeters: -5,
        radiusMeters: 2,
        strengthMeters: 3.0,
        falloff: 2,
      },
    });
    const r = (await rpc('terrain.export', { outputDirectory: WORK })).result;
    expect(r.validation.passed).toBe(true);
    expect(r.validation.errors).toBe(0);
  });

  // Skips (loudly, never fake-passing) when the DEM is absent: the overlap
  // window this test needs only exists because the DEM read yields the event
  // loop — see the comment inside. With the DEM missing, the job fails
  // synchronously at ingesting_dem before the second request is even parsed,
  // so BOTH generates are accepted and the assertion is meaningless (verified
  // by running with the dataset directory masked).
  it.skipIf(!existsSync(CONCURRENCY_DEM))(
    'refuses to run two generation jobs concurrently',
    async () => {
    // The session holds ONE dataset; a second concurrent generate would race
    // to install its result and could silently destroy acknowledged edits.
    //
    // The overlap window only exists when generation AWAITS something: without
    // a DEM the pipeline is pure CPU work, blocks the event loop, and always
    // finishes before a second request can even be parsed — a no-DEM version
    // of this test found both jobs "accepted" and proved nothing. The DEM read
    // yields, so the second request lands mid-generation.
    const demConfig = {
      ...smallConfig,
      terrainId: 'protocol_concurrent',
      dem: {
        enabled: true,
        path: CONCURRENCY_DEM,
        applyToRoles: ['context', 'operational'],
        effectiveResolutionMeters: 17.5,
      },
      site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    };
    const first = await rpc('terrain.generate', { config: demConfig });
    const second = await rpc('terrain.generate', { config: demConfig });

    // Exactly one must be accepted; the other must fail with a structured
    // error naming the running job.
    const accepted = [first, second].filter((r) => r.result?.jobId);
    const refused = [first, second].filter((r) => r.error);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(refused[0].error.data.details.runningJobId).toBe(accepted[0].result.jobId);

    // Wait the accepted one out so later tests see a stable session.
    const jobId = accepted[0].result.jobId;
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = (await rpc('terrain.getStatus', { jobId })).result;
      if (s.status === 'complete' || s.status === 'failed') break;
    }
  }, 300_000);

  it('honours requested export formats', async () => {
    const dir = `${WORK}-formats`;
    const r = (await rpc('terrain.export', {
      outputDirectory: dir,
      formats: { exr: false, png16: false, glb: false },
    })).result;
    expect(r.validation.passed).toBe(true);
    const manifest = (await rpc('terrain.getManifest', { directory: dir })).result;
    const kinds = new Set(manifest.artifacts.map((a: { kind: string }) => a.kind));
    expect(kinds.has('heightmap_raw_f32')).toBe(true); // always written
    expect(kinds.has('heightmap_exr_f32')).toBe(false);
    expect(kinds.has('heightmap_png_u16')).toBe(false);
    expect(kinds.has('tile_glb')).toBe(false);
  });

  it('reports a cancel request for an unknown job as a structured error', async () => {
    const r = await rpc('terrain.cancel', { jobId: 'terrain-job-99999' });
    expect(r.error.code).toBe(RPC_CODES.TERRAIN_ERROR);
    expect(r.error.data.code).toBe('TERRAIN_JOB_NOT_FOUND');
  });

  it('rejects malformed JSON with PARSE_ERROR', async () => {
    const reply = await new Promise<any>((res) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.error?.code === RPC_CODES.PARSE_ERROR) {
          socket.off('message', onMessage);
          res(msg);
        }
      };
      socket.on('message', onMessage);
      socket.send('{not json');
    });
    expect(reply.error.code).toBe(RPC_CODES.PARSE_ERROR);
  });

  it.skipIf(!existsSync(CONCURRENCY_DEM))(
    'keeps the installed real-DEM dataset when a later job fails during export',
    async () => {
      const goodDirectory = `${WORK}-atomic-good`;
      rmSync(goodDirectory, { recursive: true, force: true });
      const realConfig = {
        terrainId: 'atomic_known_good',
        seed: 'atomic-real-dem',
        outputDirectory: goodDirectory,
        site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
        layers: [
          { role: 'context', widthMeters: 20, lengthMeters: 20, resolutionMeters: 5 },
        ],
        dem: {
          enabled: true,
          path: CONCURRENCY_DEM,
          applyToRoles: ['context'],
          effectiveResolutionMeters: 17.5,
        },
        proceduralStack: [],
        craters: { enabled: false },
        rocks: { enabled: false },
        regolith: { enabled: false },
        solar: {
          mode: 'ephemeris',
          epochUtc: '2026-08-03T00:00:00Z',
          computeHorizon: false,
        },
      };

      const waitForTerminalStatus = async (jobId: string): Promise<any> => {
        for (let i = 0; i < 600; i++) {
          const status = (await rpc('terrain.getStatus', { jobId })).result;
          if (['complete', 'failed', 'cancelled'].includes(status.status)) return status;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
        throw new Error(`job ${jobId} did not reach a terminal state`);
      };

      const first = await rpc('terrain.generate', { config: realConfig });
      expect((await waitForTerminalStatus(first.result.jobId)).status).toBe('complete');

      // package.json is a file, so using a child path fails quickly with
      // ENOTDIR on every supported platform; no special filesystem is involved.
      const impossibleDirectory = join(resolve(__dirname, '../package.json'), 'child');
      const second = await rpc('terrain.generate', {
        config: {
          ...realConfig,
          terrainId: 'atomic_must_not_install',
          outputDirectory: impossibleDirectory,
        },
      });
      const failed = await waitForTerminalStatus(second.result.jobId);
      expect(failed.status).toBe('failed');
      expect(failed.error.code).toBe('TERRAIN_OUTPUT_NOT_WRITABLE');

      const live = (await rpc('terrain.getDataset')).result;
      expect(live.terrainId).toBe('atomic_known_good');
    },
    120_000,
  );
});
