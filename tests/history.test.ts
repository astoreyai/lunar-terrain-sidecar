/**
 * Operation history and deterministic replay (spec §12, §19).
 *
 * Unit tests drive the three newest brush kinds — `slope`, `noise`,
 * `semantic_paint` — directly on a flat analytic layer where every expected
 * elevation is derivable by hand. The protocol suite then proves the load-
 * bearing claim behind "edits are replayable records": generate a seed, apply
 * a mixed operation log, regenerate the SAME seed and replay the SAME log
 * through terrain.replayLog, and the terrain is bit-identical — probe heights
 * compared with toBe, checksums compared as strings, no tolerances.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { applyOperation, maskChecksum, layerChecksum } from '../apps/headless-server/src/operations.js';
import { startServer } from '../apps/headless-server/src/server.js';
import {
  SEMANTIC_CLASSES,
  TerrainError,
  heightAtWorld,
  semanticIndex,
  type TerrainLayer,
} from '@lts/shared-types';
import type { TerrainOperation } from '@lts/terrain-protocol';

// ---------------------------------------------------------------- fixtures --

/** A flat analytic layer centred on the origin: geometry is exactly known. */
function flatLayer(sizeMeters: number, resolutionMeters: number, elevation = 0): TerrainLayer {
  const n = Math.round(sizeMeters / resolutionMeters) + 1;
  return {
    id: 'test-layer',
    role: 'operational',
    bounds: {
      minX: -sizeMeters / 2,
      maxX: sizeMeters / 2,
      minZ: -sizeMeters / 2,
      maxZ: sizeMeters / 2,
      minY: elevation,
      maxY: elevation,
    },
    horizontalResolutionMeters: resolutionMeters,
    verticalQuantizationMeters: 0,
    widthSamples: n,
    heightSamples: n,
    heightData: new Float32Array(n * n).fill(elevation),
    masks: { semantic: new Uint8Array(n * n) },
    elevationProvenance: 'synthetic',
  };
}

function makeOp(
  over: Partial<TerrainOperation> & { kind: TerrainOperation['kind'] },
): TerrainOperation {
  return {
    operationId: 'op-test',
    layerId: 'test-layer',
    centerXMeters: 0,
    centerZMeters: 0,
    radiusMeters: 1,
    strengthMeters: 0,
    falloff: 2,
    massConserving: false,
    timestamp: '2026-08-03T00:00:00Z',
    ...over,
  };
}

const h = (layer: TerrainLayer, x: number, z: number) => heightAtWorld(layer, x, z);

function maskAt(layer: TerrainLayer, x: number, z: number): number {
  const res = layer.horizontalResolutionMeters;
  const col = Math.round((x - layer.bounds.minX) / res);
  const row = Math.round((z - layer.bounds.minZ) / res);
  return layer.masks.semantic![row * layer.widthSamples + col];
}

function expectInvalidConfig(fn: () => unknown): TerrainError {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TerrainError);
  expect((error as TerrainError).code).toBe('TERRAIN_INVALID_CONFIG');
  return error as TerrainError;
}

// ------------------------------------------------------------------- slope --

describe('slope', () => {
  it('tilts toward a plane through the centre elevation, descending along the heading', () => {
    const layer = flatLayer(40, 0.25);
    // Heading 90 = east = +X (ADR 0002). Gradient 1 m per 10 m of radius.
    applyOperation(
      layer,
      makeOp({ kind: 'slope', headingDegrees: 90, radiusMeters: 10, strengthMeters: 1 }),
    );
    // At (5, 0): plane = -0.5, brush weight (1 - 0.5)^2 = 0.25 → -0.125.
    expect(h(layer, 5, 0)).toBeCloseTo(-0.125, 4);
    // Mirrored up-gradient side.
    expect(h(layer, -5, 0)).toBeCloseTo(0.125, 4);
    // Perpendicular to the heading the plane passes through the centre
    // elevation, so nothing moves.
    expect(h(layer, 0, 5)).toBeCloseTo(0, 6);
    // Outside the brush: untouched.
    expect(h(layer, 12, 0)).toBe(0);
  });

  it('follows the azimuth convention: heading 0 descends toward -Z (north)', () => {
    const layer = flatLayer(40, 0.25);
    applyOperation(
      layer,
      makeOp({ kind: 'slope', headingDegrees: 0, radiusMeters: 10, strengthMeters: 1 }),
    );
    expect(h(layer, 0, -5)).toBeCloseTo(-0.125, 4); // north: down-gradient
    expect(h(layer, 0, 5)).toBeCloseTo(0.125, 4); // south: up-gradient
  });

  it('requires a finite headingDegrees with a structured error', () => {
    const layer = flatLayer(20, 0.25);
    expectInvalidConfig(() =>
      applyOperation(layer, makeOp({ kind: 'slope', radiusMeters: 5, strengthMeters: 1 })),
    );
    expect(h(layer, 0, 0)).toBe(0); // nothing committed
  });
});

// ------------------------------------------------------------------- noise --

describe('noise', () => {
  const noiseOp = (seed: string) =>
    makeOp({ kind: 'noise', radiusMeters: 8, strengthMeters: 0.5, noiseSeed: seed });

  it('is deterministic: the same seed reproduces the identical field', () => {
    const a = flatLayer(30, 0.25);
    const b = flatLayer(30, 0.25);
    applyOperation(a, noiseOp('stamp-42'));
    applyOperation(b, noiseOp('stamp-42'));
    expect(layerChecksum(a)).toBe(layerChecksum(b));
    // And it genuinely displaced something within the brush.
    expect(layerChecksum(a)).not.toBe(layerChecksum(flatLayer(30, 0.25)));
  });

  it('a different seed produces a different field', () => {
    const a = flatLayer(30, 0.25);
    const b = flatLayer(30, 0.25);
    applyOperation(a, noiseOp('stamp-42'));
    applyOperation(b, noiseOp('stamp-43'));
    expect(layerChecksum(a)).not.toBe(layerChecksum(b));
  });

  it('stays within the brush radius and roughly within the amplitude', () => {
    const layer = flatLayer(30, 0.25);
    applyOperation(layer, noiseOp('stamp-42'));
    expect(h(layer, 10, 0)).toBe(0); // outside the brush
    for (const [x, z] of [[0, 0], [2, 1], [-3, 2]]) {
      expect(Math.abs(h(layer, x, z))).toBeLessThanOrEqual(0.5);
    }
  });

  it('requires noiseSeed with a structured error', () => {
    const layer = flatLayer(20, 0.25);
    expectInvalidConfig(() =>
      applyOperation(layer, makeOp({ kind: 'noise', radiusMeters: 5, strengthMeters: 0.5 })),
    );
    expect(h(layer, 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------- semantic paint --

describe('semantic_paint', () => {
  it('paints only the mask: zero height change, zero volumes', () => {
    const layer = flatLayer(20, 0.25);
    const heightBefore = layerChecksum(layer);
    const maskBefore = maskChecksum(layer);
    const r = applyOperation(
      layer,
      makeOp({ kind: 'semantic_paint', radiusMeters: 3, semanticClass: 'rock_field' }),
    );
    expect(r.removedVolumeM3).toBe(0);
    expect(r.depositedVolumeM3).toBe(0);
    expect(layerChecksum(layer)).toBe(heightBefore); // heights untouched
    expect(maskChecksum(layer)).not.toBe(maskBefore); // mask rewritten
    expect(maskAt(layer, 0, 0)).toBe(semanticIndex('rock_field'));
    expect(maskAt(layer, 2, 0)).toBe(semanticIndex('rock_field'));
    expect(maskAt(layer, 4, 0)).toBe(semanticIndex('unknown')); // outside
    // The bounds cover the painted footprint so tile invalidation works.
    expect(r.bounds.maxX - r.bounds.minX).toBeGreaterThanOrEqual(5.5);
  });

  it('rejects a missing or unknown class with a structured error listing the valid names', () => {
    const layer = flatLayer(20, 0.25);
    for (const semanticClass of [undefined, 'lava_field']) {
      const error = expectInvalidConfig(() =>
        applyOperation(
          layer,
          makeOp({ kind: 'semantic_paint', radiusMeters: 3, semanticClass }),
        ),
      );
      expect(error.details.validClasses).toEqual([...SEMANTIC_CLASSES]);
    }
    expect(maskAt(layer, 0, 0)).toBe(0); // nothing painted
  });
});

// -------------------------------------------- history & replay over the wire --

describe('operation history over the protocol', () => {
  // Unique across ALL test files: 8791 (protocol), 8793, 8795 (godot),
  // 8801 (construction) are taken and 8796-8799 are held by unrelated
  // services on this host. vitest runs files in parallel, so a duplicate
  // port fails only in the full run.
  const PORT = 8803;
  const WORK = resolve(__dirname, '../.test-artifacts/history');

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

  const baseConfig = {
    terrainId: 'history_site',
    outputDirectory: WORK,
    site: { latitudeDeg: -89.4, longitudeDeg: -137.5 },
    layers: [{ role: 'context', widthMeters: 60, lengthMeters: 60, resolutionMeters: 0.5 }],
    // Real seed-dependent relief. Without it the default stack is empty and
    // the site generates dead flat, which would make "regenerate the same
    // seed, get the same terrain" trivially true instead of a proof.
    proceduralStack: [
      {
        id: 'base',
        model: 'fbm',
        fractal: { octaves: 5, lacunarity: 2, persistence: 0.5, frequency: 0.05, amplitude: 1.5 },
      },
    ],
    craters: { enabled: false },
    rocks: { enabled: false },
    solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z' },
  };

  /** Generate with the given seed and wait for the job to complete. */
  async function generate(seed: string): Promise<void> {
    const start = await rpc('terrain.generate', { config: { ...baseConfig, seed } });
    expect(start.result?.jobId).toBeDefined();
    const jobId: string = start.result.jobId;
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = (await rpc('terrain.getStatus', { jobId })).result;
      if (s.status === 'complete') return;
      if (s.status === 'failed' || s.status === 'cancelled') {
        throw new Error(`generate ${seed} ended ${s.status}: ${JSON.stringify(s.error)}`);
      }
    }
    throw new Error(`generate ${seed} timed out`);
  }

  async function heightAt(x: number, z: number): Promise<number> {
    return (await rpc('terrain.getHeight', { x, z })).result.elevationM;
  }

  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    await generate('history-base');
  }, 120_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('declares the new kinds and methods in its capabilities', async () => {
    const r = await rpc('terrain.capabilities');
    for (const kind of ['slope', 'noise', 'semantic_paint']) {
      expect(r.result.operations).toContain(kind);
    }
    expect(r.result.methods).toContain('terrain.getOperationLog');
    expect(r.result.methods).toContain('terrain.replayLog');
  });

  it('applies slope and noise, and validates their required fields', async () => {
    const slope = await rpc('terrain.applyOperation', {
      operation: {
        kind: 'slope',
        centerXMeters: 5,
        centerZMeters: 5,
        radiusMeters: 8,
        strengthMeters: 1,
        headingDegrees: 45,
      },
    });
    expect(slope.result.delta).toBeDefined();
    expect(slope.result.delta.resultingChecksum).not.toBe(slope.result.delta.previousChecksum);

    const noSeed = await rpc('terrain.applyOperation', {
      operation: { kind: 'noise', radiusMeters: 5, strengthMeters: 0.3 },
    });
    expect(noSeed.error.code).toBe(-32000);
    expect(noSeed.error.data.code).toBe('TERRAIN_INVALID_CONFIG');

    const noise = await rpc('terrain.applyOperation', {
      operation: { kind: 'noise', radiusMeters: 5, strengthMeters: 0.3, noiseSeed: 'wire-1' },
    });
    expect(noise.result.delta).toBeDefined();
    expect(noise.result.operation.noiseSeed).toBe('wire-1');
  });

  it('semantic_paint changes the class but not the height, and its delta says so honestly', async () => {
    const x = -8;
    const z = -8;
    const before = await heightAt(x, z);

    const bad = await rpc('terrain.applyOperation', {
      operation: { kind: 'semantic_paint', centerXMeters: x, centerZMeters: z, radiusMeters: 4, semanticClass: 'lava_field' },
    });
    expect(bad.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(bad.error.data.details.validClasses).toEqual([...SEMANTIC_CLASSES]);

    const paint = await rpc('terrain.applyOperation', {
      operation: { kind: 'semantic_paint', centerXMeters: x, centerZMeters: z, radiusMeters: 4, semanticClass: 'rock_field' },
    });
    const delta = paint.result.delta;
    expect(delta.massBalance.removedVolumeM3).toBe(0);
    expect(delta.massBalance.depositedVolumeM3).toBe(0);
    // Heights untouched, so the height checksum chain does not move…
    expect(delta.resultingChecksum).toBe(delta.previousChecksum);
    // …and the mask checksums are what record that anything happened.
    expect(delta.resultingMaskChecksum).not.toBe(delta.previousMaskChecksum);

    const sem = (await rpc('terrain.getSemanticClass', { x, z })).result;
    expect(sem.semanticClass).toBe('rock_field');
    const after = await heightAt(x, z);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1e-12);
  });

  it('noise is deterministic across identical fresh generations', async () => {
    const op = {
      kind: 'noise',
      centerXMeters: 0,
      centerZMeters: 0,
      radiusMeters: 10,
      strengthMeters: 0.5,
      falloff: 2,
      noiseSeed: 'determinism-stamp',
    };
    const probes: Array<[number, number]> = [
      [0, 0],
      [3, -2],
      [-4, 4],
      [6, 6],
      [-7, -1],
    ];

    await generate('history-noise');
    await rpc('terrain.applyOperation', { operation: op });
    const first: number[] = [];
    for (const [x, z] of probes) first.push(await heightAt(x, z));

    await generate('history-noise');
    await rpc('terrain.applyOperation', { operation: op });
    for (let i = 0; i < probes.length; i++) {
      const [x, z] = probes[i];
      expect(await heightAt(x, z)).toBe(first[i]);
    }
  });

  it('getOperationLog returns the operations in order with delta summaries', async () => {
    await generate('history-log');
    const kinds = ['raise', 'slope', 'semantic_paint'] as const;
    await rpc('terrain.applyOperation', {
      operation: { kind: 'raise', centerXMeters: 2, centerZMeters: 2, radiusMeters: 3, strengthMeters: 0.4 },
    });
    await rpc('terrain.applyOperation', {
      operation: { kind: 'slope', centerXMeters: -5, centerZMeters: 0, radiusMeters: 6, strengthMeters: 0.8, headingDegrees: 180 },
    });
    await rpc('terrain.applyOperation', {
      operation: { kind: 'semantic_paint', centerXMeters: 8, centerZMeters: -8, radiusMeters: 3, semanticClass: 'berm' },
    });

    const log = (await rpc('terrain.getOperationLog')).result;
    expect(log.operations.map((o: TerrainOperation) => o.kind)).toEqual([...kinds]);
    expect(log.operations.map((o: TerrainOperation) => o.operationId)).toEqual([
      'op-000000',
      'op-000001',
      'op-000002',
    ]);
    expect(log.deltas).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(log.deltas[i].sequenceNumber).toBe(i);
      expect(log.deltas[i].deltaId).toBe(`delta-${String(i).padStart(6, '0')}`);
      expect(log.deltas[i].kind).toBe(kinds[i]);
      expect(typeof log.deltas[i].changedTileCount).toBe('number');
      expect(log.deltas[i].massBalance).toBeDefined();
      expect(typeof log.deltas[i].timestamp).toBe('string');
      // Summaries, not dumps: no per-tile id list rides along.
      expect(log.deltas[i].changedTiles).toBeUndefined();
    }
  });

  it('THE REPLAY PROOF: same seed + same log = identical terrain', async () => {
    const probes: Array<[number, number]> = [
      [0, 0],
      [5, 5],
      [-6, 3],
      [10, -10],
      [-12, -4],
      [7, 12],
    ];

    // --- first life: generate, edit, record --------------------------------
    await generate('replay-proof');
    const edits = [
      { kind: 'raise', centerXMeters: 5, centerZMeters: 5, radiusMeters: 4, strengthMeters: 0.6, massConserving: true },
      { kind: 'slope', centerXMeters: -3, centerZMeters: 2, radiusMeters: 8, strengthMeters: 0.8, headingDegrees: 135 },
      { kind: 'noise', centerXMeters: 2, centerZMeters: -6, radiusMeters: 6, strengthMeters: 0.4, noiseSeed: 'replay-noise' },
      { kind: 'semantic_paint', centerXMeters: -8, centerZMeters: -8, radiusMeters: 4, semanticClass: 'rock_field' },
    ];
    const recorded: TerrainOperation[] = [];
    let finalDelta: any;
    for (const operation of edits) {
      const r = await rpc('terrain.applyOperation', { operation });
      expect(r.result?.operation).toBeDefined();
      recorded.push(r.result.operation); // the normalised, stored record
      finalDelta = r.result.delta;
    }
    const heights: number[] = [];
    for (const [x, z] of probes) heights.push(await heightAt(x, z));
    const finalChecksum: string = finalDelta.resultingChecksum;
    const finalMaskChecksum: string = finalDelta.resultingMaskChecksum;

    // --- second life: regenerate the SAME seed, replay the SAME records ----
    await generate('replay-proof');
    const replay = (await rpc('terrain.replayLog', { operations: recorded })).result;
    expect(replay.applied).toBe(4);
    expect(replay.deltas.map((d: any) => d.kind)).toEqual([
      'raise',
      'slope',
      'noise',
      'semantic_paint',
    ]);

    // Identical, not approximately identical.
    for (let i = 0; i < probes.length; i++) {
      const [x, z] = probes[i];
      expect(await heightAt(x, z)).toBe(heights[i]);
    }
    expect(replay.finalChecksum).toBe(finalChecksum);
    expect(replay.finalMaskChecksum).toBe(finalMaskChecksum);
    // The painted class survived the replay too.
    expect((await rpc('terrain.getSemanticClass', { x: -8, z: -8 })).result.semanticClass).toBe(
      'rock_field',
    );
  });

  it('refuses a malformed op mid-log with a structured error naming the failed index', async () => {
    await generate('replay-malformed');
    const good = { kind: 'raise', centerXMeters: 0, centerZMeters: 0, radiusMeters: 3, strengthMeters: 0.2 };
    const ops = [
      good,
      // Malformed: 'noise' without its required noiseSeed.
      { kind: 'noise', centerXMeters: 5, centerZMeters: 5, radiusMeters: 3, strengthMeters: 0.2 },
      good,
    ];
    const r = await rpc('terrain.replayLog', { operations: ops });
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32000);
    expect(r.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    // Apply-up-to-failure is acceptable but MUST be reported.
    expect(r.error.data.details.failedIndex).toBe(1);
    expect(r.error.data.details.appliedOperations).toBe(1);
    expect(r.error.data.details.totalOperations).toBe(3);
    expect(r.error.data.details.cause.code).toBe('TERRAIN_INVALID_CONFIG');
    // The one applied op really is in the log — reported state matches truth.
    const log = (await rpc('terrain.getOperationLog')).result;
    expect(log.operations).toHaveLength(1);
    expect(log.operations[0].kind).toBe('raise');

    // An unknown kind is also a structured refusal, never a silent no-op.
    const unknown = await rpc('terrain.replayLog', {
      operations: [{ kind: 'melt', radiusMeters: 3, strengthMeters: 1 }],
    });
    expect(unknown.error.data.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(unknown.error.data.details.failedIndex).toBe(0);
    expect(unknown.error.data.details.cause.details.supported).toContain('raise');
  });
});
