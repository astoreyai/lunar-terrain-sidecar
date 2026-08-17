/**
 * Live terrain sync (spec §19): sparse changed-sample deltas, cheap change
 * polling, and full snapshots with checksum-validated restore.
 *
 * Everything runs against a real WebSocket sidecar and a small grid derived
 * directly from the real NASA/PGDA Site01 GeoTIFF. No procedural relief,
 * crater, rock, or regolith generator contributes test data:
 *
 *  (a) an edit's delta carries a sparse payload that, applied to a pre-edit
 *      copy of the layer, reproduces the post-edit heights EXACTLY;
 *  (b) an edit changing more than SPARSE_SAMPLE_CAP samples omits the payload
 *      with the stated reason instead of shipping a payload heavier than the
 *      tiles it replaces;
 *  (c) terrain.getChangedSince deduplicates tiles across overlapping edits and
 *      returns an empty union at the head sequence;
 *  (d) pruned and unknown sequence numbers fail with DISTINCT structured
 *      errors, because the client remedy differs (resync vs caller bug);
 *  (e) snapshot → edit → restore returns terrain and its retained audit/sync
 *      history to the snapshotted state;
 *  (f) a tampered snapshot is refused with the checksum error and the live
 *      dataset is left untouched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';
import { DELTA_WINDOW, SPARSE_SAMPLE_CAP } from '@lts/terrain-protocol';
import { SITE01_DEM } from './paths.js';

describe('live sync over the protocol', () => {
  // Unique across ALL test files: 8791 (protocol), 8793/8795 (godot), 8801
  // (construction), 8803 (history) are taken and 8796-8799 are held by
  // unrelated services on this host. vitest runs files in parallel, so a
  // duplicate port fails only in the full run.
  const PORT = 8805;
  const WORK = resolve(__dirname, '../.test-artifacts/sync');

  let server: WebSocketServer;
  let socket: WebSocket;
  let nextId = 1;
  let datasetRevision = -1;

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

  // 300 m at 0.5 m is 601² = 361 201 samples: big enough that a wide brush
  // (test b) changes more than SPARSE_SAMPLE_CAP samples, small enough to
  // stay fast. Heights are resampled only from the real Site01 DEM.
  const baseConfig = {
    terrainId: 'sync_site',
    outputDirectory: WORK,
    site: { latitudeDeg: -89.4, longitudeDeg: -137.5 },
    layers: [{ role: 'context', widthMeters: 300, lengthMeters: 300, resolutionMeters: 0.5 }],
    dem: {
      enabled: true,
      path: SITE01_DEM,
      applyToRoles: ['context'],
      effectiveResolutionMeters: 17.5,
    },
    proceduralStack: [],
    craters: { enabled: false },
    rocks: { enabled: false },
    regolith: { enabled: false },
    solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z' },
  };

  async function generate(seed: string): Promise<void> {
    const start = await rpc('terrain.generate', { config: { ...baseConfig, seed } });
    expect(start.result?.jobId).toBeDefined();
    const jobId: string = start.result.jobId;
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = (await rpc('terrain.getStatus', { jobId })).result;
      if (s.status === 'complete') {
        datasetRevision = Number((await rpc('terrain.getDataset')).result.datasetRevision);
        return;
      }
      if (s.status === 'failed' || s.status === 'cancelled') {
        throw new Error(`generate ${seed} ended ${s.status}: ${JSON.stringify(s.error)}`);
      }
    }
    throw new Error(`generate ${seed} timed out`);
  }

  let layerId: string;
  let widthSamples: number;
  let heightSamples: number;

  /** The whole layer at stride 1, decoded to float32 — every sample, exact bits. */
  async function fullLayer(): Promise<Float32Array> {
    const r = await rpc('terrain.getTile', {
      layerId,
      col0: 0,
      row0: 0,
      width: widthSamples,
      height: heightSamples,
      stride: 1,
    });
    expect(r.result.width).toBe(widthSamples);
    expect(r.result.height).toBe(heightSamples);
    expect(r.result.encoding).toBe('base64:float32le');
    const buf = Buffer.from(r.result.data, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  async function heightAt(x: number, z: number): Promise<number> {
    return (await rpc('terrain.getHeight', { x, z })).result.elevationM;
  }

  function decodeSparse(sparse: any): { indices: Uint32Array; heights: Float32Array } {
    const ib = Buffer.from(sparse.indices, 'base64');
    const hb = Buffer.from(sparse.heights, 'base64');
    expect(ib.byteLength).toBe(sparse.sampleCount * 4);
    expect(hb.byteLength).toBe(sparse.sampleCount * 4);
    return {
      indices: new Uint32Array(ib.buffer, ib.byteOffset, sparse.sampleCount),
      heights: new Float32Array(hb.buffer, hb.byteOffset, sparse.sampleCount),
    };
  }

  beforeAll(async () => {
    if (!existsSync(SITE01_DEM)) {
      throw new Error(
        `real Site01 DEM is required at ${SITE01_DEM}; run scripts/fetch-data.sh or set LTS_SITE01_DEM`,
      );
    }
    rmSync(WORK, { recursive: true, force: true });
    server = await startServer(PORT);
    socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise<void>((res, rej) => {
      socket.once('open', () => res());
      socket.once('error', rej);
    });
    await generate('sync-base');
    const ds = (await rpc('terrain.getDataset')).result;
    layerId = ds.layers[0].id;
    widthSamples = ds.layers[0].widthSamples;
    heightSamples = ds.layers[0].heightSamples;
  }, 120_000);

  afterAll(async () => {
    socket?.close();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('declares the sync methods and limits in its capabilities', async () => {
    const r = await rpc('terrain.capabilities');
    for (const m of [
      'terrain.getDelta',
      'terrain.getChangedSince',
      'terrain.snapshot',
      'terrain.restoreSnapshot',
    ]) {
      expect(r.result.methods).toContain(m);
    }
    expect(r.result.sync).toEqual({
      sparseSampleCap: SPARSE_SAMPLE_CAP,
      deltaWindow: DELTA_WINDOW,
    });
  });

  it('(a) sparse payload applied to a pre-edit copy reproduces the post-edit layer exactly', async () => {
    const before = await fullLayer();

    const r = await rpc('terrain.applyOperation', {
      operation: {
        kind: 'raise',
        centerXMeters: 5,
        centerZMeters: -5,
        radiusMeters: 3,
        strengthMeters: 0.4,
      },
    });
    const delta = r.result.delta;
    expect(delta.sparse).toBeDefined();
    expect(delta.sparseOmitted).toBeUndefined();
    expect(delta.sparse.layerId).toBe(layerId);
    expect(delta.sparse.sampleCount).toBeGreaterThan(0);
    expect(delta.changedSampleCount).toBe(delta.sparse.sampleCount);
    const { indices, heights } = decodeSparse(delta.sparse);

    const after = await fullLayer();

    // Apply the sparse payload to the pre-edit copy.
    const patched = before.slice();
    for (let k = 0; k < indices.length; k++) patched[indices[k]] = heights[k];

    // EXACT at every changed sample — same float32 bits, no tolerance — and
    // each changed sample genuinely changed.
    let mismatches = 0;
    let unchanged = 0;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (patched[i] !== after[i]) mismatches++;
      if (before[i] === after[i]) unchanged++;
    }
    expect(mismatches).toBe(0);
    expect(unchanged).toBe(0);
    // And nothing OUTSIDE the sparse payload moved: the patched copy is the
    // post-edit layer, byte for byte.
    expect(
      Buffer.compare(
        Buffer.from(patched.buffer, patched.byteOffset, patched.byteLength),
        Buffer.from(after.buffer, after.byteOffset, after.byteLength),
      ),
    ).toBe(0);
  });

  it('(b) an edit past the sample cap omits sparse with the stated reason', async () => {
    // radius 145 m at 0.5 m resolution ≈ π·290² ≈ 264k changed samples.
    const r = await rpc('terrain.applyOperation', {
      operation: {
        kind: 'raise',
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 145,
        strengthMeters: 0.2,
      },
    });
    const delta = r.result.delta;
    expect(delta.changedSampleCount).toBeGreaterThan(SPARSE_SAMPLE_CAP);
    expect(delta.sparse).toBeUndefined();
    expect(delta.sparseOmitted).toBe(
      `sample count ${delta.changedSampleCount} exceeds ${SPARSE_SAMPLE_CAP}; ` +
        'fetch changed tiles instead',
    );
  });

  it('(c) getChangedSince dedups tiles across overlapping edits and is empty at head', async () => {
    await generate('sync-changed');

    // Fresh baseline: head is 0 and asking for 0 is an empty union.
    const empty = (await rpc('terrain.getChangedSince', { sequenceNumber: 0 })).result;
    expect(empty).toMatchObject({
      fromSequence: 0,
      toSequence: 0,
      datasetRevision,
      terrainId: baseConfig.terrainId,
      seed: 'sync-changed',
      baselineRequired: true,
      changedTiles: [],
      perLayer: [],
    });
    expect(empty.layerChecksums[layerId].heightSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(empty.layerChecksums[layerId].maskSha256).toMatch(/^[0-9a-f]{64}$/);

    // Three overlapping edits around the origin: their changed-tile lists
    // overlap heavily, so a correct union is strictly smaller than the sum.
    const deltas: any[] = [];
    for (const [cx, cz] of [
      [0, 0],
      [2, 0],
      [0, 2],
    ]) {
      const r = await rpc('terrain.applyOperation', {
        operation: {
          kind: 'raise',
          centerXMeters: cx,
          centerZMeters: cz,
          radiusMeters: 5,
          strengthMeters: 0.3,
        },
      });
      deltas.push(r.result.delta);
    }

    const since0 = (
      await rpc('terrain.getChangedSince', { sequenceNumber: 0, datasetRevision })
    ).result;
    expect(since0.fromSequence).toBe(0);
    expect(since0.toSequence).toBe(3);
    const expectedUnion = new Set<string>(deltas.flatMap((d) => d.changedTiles));
    expect(new Set(since0.changedTiles)).toEqual(expectedUnion);
    // Deduplicated: the union is smaller than the concatenation.
    const concatenated = deltas.reduce((n, d) => n + d.changedTiles.length, 0);
    expect(since0.changedTiles.length).toBeLessThan(concatenated);
    // Per-layer changed-sample accounting sums the intervening deltas.
    expect(since0.perLayer).toEqual([
      {
        layerId,
        changedSampleCount: deltas.reduce((n, d) => n + d.changedSampleCount, 0),
      },
    ]);

    // A mid-log poll unions only the deltas at or after the given sequence.
    const since2 = (
      await rpc('terrain.getChangedSince', { sequenceNumber: 2, datasetRevision })
    ).result;
    expect(new Set(since2.changedTiles)).toEqual(new Set(deltas[2].changedTiles));
    expect(since2.perLayer).toEqual([{ layerId, changedSampleCount: deltas[2].changedSampleCount }]);

    // At the head: nothing to report.
    const atHead = (
      await rpc('terrain.getChangedSince', { sequenceNumber: 3, datasetRevision })
    ).result;
    expect(atHead).toMatchObject({
      fromSequence: 3,
      toSequence: 3,
      datasetRevision,
      baselineRequired: false,
      changedTiles: [],
      perLayer: [],
    });
  });

  it('(d) pruned and unknown sequence numbers fail with distinct structured errors', async () => {
    // Continue from (c): head is 3. Push DELTA_WINDOW more small edits so
    // sequence numbers 0..2 age out of the retained window.
    for (let i = 0; i < DELTA_WINDOW; i++) {
      const r = await rpc('terrain.applyOperation', {
        operation: {
          kind: 'raise',
          centerXMeters: -140 + (i % 100),
          centerZMeters: -140 + Math.floor(i / 100),
          radiusMeters: 1,
          strengthMeters: 0.05,
        },
      });
      expect(r.result?.delta).toBeDefined();
    }
    const head = 3 + DELTA_WINDOW;

    // A retained sequence number still round-trips, sparse included.
    const kept = await rpc('terrain.getDelta', {
      sequenceNumber: head - 1,
      datasetRevision,
    });
    expect(kept.result.sequenceNumber).toBe(head - 1);
    expect(kept.result.sparse).toBeDefined();

    // Sequence 0 existed but has been pruned: the error says so and names
    // the remedy (full resync), never claiming the delta was unknown.
    const pruned = await rpc('terrain.getDelta', { sequenceNumber: 0, datasetRevision });
    expect(pruned.error.code).toBe(-32000);
    expect(pruned.error.data.code).toBe('TERRAIN_JOB_NOT_FOUND');
    expect(pruned.error.data.details.reason).toBe('pruned');
    expect(pruned.error.data.details.oldestRetained).toBe(3);
    expect(pruned.error.data.details.deltaWindow).toBe(DELTA_WINDOW);
    expect(pruned.error.message).toMatch(/full resync/);

    // A sequence number that never existed is a different failure.
    const unknown = await rpc('terrain.getDelta', {
      sequenceNumber: 999_999,
      datasetRevision,
    });
    expect(unknown.error.code).toBe(-32000);
    expect(unknown.error.data.code).toBe('TERRAIN_JOB_NOT_FOUND');
    expect(unknown.error.data.details.reason).toBe('unknown');
    expect(unknown.error.data.details.headSequence).toBe(head);
    expect(unknown.error.data.details.reason).not.toBe(pruned.error.data.details.reason);

    // getChangedSince refuses a pruned window the same way.
    const stale = await rpc('terrain.getChangedSince', { sequenceNumber: 0, datasetRevision });
    expect(stale.error.data.details.reason).toBe('pruned');
    expect(stale.error.message).toMatch(/full resync/);
  });

  it('(e) snapshot → edits → restore returns the terrain to the snapshotted state', async () => {
    await generate('sync-snap');
    // One edit before the snapshot so the captured state is not the pristine
    // generate output — the restore must reproduce an EDITED baseline.
    await rpc('terrain.applyOperation', {
      operation: {
        kind: 'lower',
        centerXMeters: 3,
        centerZMeters: 3,
        radiusMeters: 6,
        strengthMeters: 0.5,
      },
    });

    const probes: Array<[number, number]> = [
      [3, 3],
      [-40, 60],
      [100, -100],
      [0, 0],
    ];
    const snapshotHeights: number[] = [];
    for (const [x, z] of probes) snapshotHeights.push(await heightAt(x, z));

    const snap = (await rpc('terrain.snapshot')).result;
    expect(snap.sequenceNumber).toBe(1);
    expect(snap.directory).toMatch(/snap-r\d+-s1-n\d+$/);
    expect(snap.layers).toHaveLength(1);
    expect(snap.layers[0].layerId).toBe(layerId);
    expect(snap.layers[0].heightSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.layers[0].maskSha256).toMatch(/^[0-9a-f]{64}$/);

    // Two more edits, the first directly over probe (3, 3).
    await rpc('terrain.applyOperation', {
      operation: { kind: 'raise', centerXMeters: 3, centerZMeters: 3, radiusMeters: 4, strengthMeters: 0.6 },
    });
    await rpc('terrain.applyOperation', {
      operation: { kind: 'crater_stamp', centerXMeters: 0, centerZMeters: 0, radiusMeters: 5, strengthMeters: 0.8 },
    });
    expect(await heightAt(3, 3)).not.toBe(snapshotHeights[0]);
    expect((await rpc('terrain.getOperationLog')).result.operations).toHaveLength(3);

    const restore = (await rpc('terrain.restoreSnapshot', { directory: snap.directory })).result;
    expect(restore.restoredLayers).toBe(1);
    datasetRevision = restore.datasetRevision;
    // The live per-layer checksums now equal the snapshotted ones: bit-exact.
    expect(restore.layers).toEqual([
      {
        layerId,
        heightSha256: snap.layers[0].heightSha256,
        maskSha256: snap.layers[0].maskSha256,
      },
    ]);
    // Probe heights are the snapshotted values again, toBe, no tolerance.
    for (let i = 0; i < probes.length; i++) {
      const [x, z] = probes[i];
      expect(await heightAt(x, z)).toBe(snapshotHeights[i]);
    }
    // Audit and retained sync history rewind to the snapshot together with
    // the terrain. Numeric sequence ids may be reused on the new branch, but
    // the advanced dataset revision keeps their identity unambiguous.
    const log = (await rpc('terrain.getOperationLog')).result;
    expect(log.operations).toHaveLength(1);
    expect(log.operations[0].kind).toBe('lower');
    expect(log.deltas).toHaveLength(1);
    expect(log.deltas[0]).toMatchObject({ sequenceNumber: 0, kind: 'lower' });
    const atHead = (
      await rpc('terrain.getChangedSince', { sequenceNumber: 1, datasetRevision })
    ).result;
    expect(atHead).toMatchObject({
      fromSequence: 1,
      toSequence: 1,
      datasetRevision,
      baselineRequired: false,
      changedTiles: [],
      perLayer: [],
    });
  });

  it('(f) a tampered snapshot is refused with the checksum error and the dataset is unchanged', async () => {
    // A fresh snapshot of the current restored state at head sequence 1.
    const snap = (await rpc('terrain.snapshot')).result;
    const heightFile = resolve(snap.directory, snap.layers[0].heightFile);

    // Flip one byte mid-file.
    const bytes = readFileSync(heightFile);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(heightFile, bytes);

    const probes: Array<[number, number]> = [
      [3, 3],
      [-40, 60],
      [100, -100],
      [0, 0],
    ];
    const before: number[] = [];
    for (const [x, z] of probes) before.push(await heightAt(x, z));

    const r = await rpc('terrain.restoreSnapshot', { directory: snap.directory });
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32000);
    expect(r.error.data.code).toBe('TERRAIN_VALIDATION_FAILED');
    expect(r.error.data.details.mismatches).toHaveLength(1);
    expect(r.error.data.details.mismatches[0].problem).toBe('checksum mismatch');
    expect(r.error.data.details.mismatches[0].file).toBe(snap.layers[0].heightFile);
    expect(r.error.message).toMatch(/unchanged/);

    // The live dataset was not touched: identical probes, toBe.
    for (let i = 0; i < probes.length; i++) {
      const [x, z] = probes[i];
      expect(await heightAt(x, z)).toBe(before[i]);
    }
  });
});
