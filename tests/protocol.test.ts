/**
 * Sidecar protocol tests (spec §16, §26 "protocol tests").
 *
 * Drives the real server over a real WebSocket — no mocked transport — so the
 * message framing, the job lifecycle, progress notifications and the structured
 * error shape are all exercised as a Godot client would meet them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';
import { METHODS, PROTOCOL_VERSION, RPC_CODES } from '@lts/terrain-protocol';

const PORT = 8791;
const WORK = resolve(__dirname, '../.test-artifacts/protocol');

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

  it('declares its capabilities honestly', async () => {
    const r = await rpc('terrain.capabilities');
    expect(r.result.methods).toEqual([...METHODS]);
    expect(r.result.coordinateSystem.north_axis).toBe('-Z');
    // Anything unbuilt is named as unbuilt rather than silently absent.
    expect(r.result.notImplemented).toBeTruthy();
    expect(Object.keys(r.result.notImplemented).length).toBeGreaterThan(0);
  });

  it('rejects an unknown method with METHOD_NOT_FOUND', async () => {
    const r = await rpc('terrain.doesNotExist');
    expect(r.error.code).toBe(RPC_CODES.METHOD_NOT_FOUND);
    expect(r.error.data.supported).toContain('terrain.generate');
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

  it('labels traversability as a synthetic heuristic', async () => {
    const t = (await rpc('terrain.getTraversability', { x: 0, z: 0 })).result;
    expect(t.traversability.score).toBeGreaterThanOrEqual(0);
    expect(t.traversability.score).toBeLessThanOrEqual(1);
    // Spec §22/§33: heuristics must be marked as heuristics.
    expect(t.traversability.provenance).toMatch(/synthetic heuristic/i);
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
});
