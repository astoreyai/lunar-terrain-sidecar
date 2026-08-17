/**
 * Construction feature operations (spec §11).
 *
 * Unit tests drive `applyOperation` directly on a flat analytic layer, where
 * every expected elevation and volume can be derived by hand: a linear ramp's
 * mid-point elevation, a cone's (1/3)πr²h volume, a wheel track's 80%
 * berm-to-rut displacement ratio. The protocol-level test then runs the same
 * machinery through a real WebSocket server and verifies the applied feature
 * lands in the export's `features_construction.json` manifest.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { applyOperation, type ApplyResult } from '../apps/headless-server/src/operations.js';
import { startServer } from '../apps/headless-server/src/server.js';
import {
  TerrainError,
  heightAtWorld,
  semanticIndex,
  type TerrainLayer,
} from '@lts/shared-types';
import type { TerrainOperation } from '@lts/terrain-protocol';
import { SITE01_DEM } from './paths.js';

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

/** Conservation error as the delta reports it: |net| / max(removed, deposited). */
function relError(r: ApplyResult): number {
  const scale = Math.max(r.removedVolumeM3, r.depositedVolumeM3);
  return scale > 0 ? Math.abs(r.depositedVolumeM3 - r.removedVolumeM3) / scale : 0;
}

function maskAt(layer: TerrainLayer, x: number, z: number): number {
  const res = layer.horizontalResolutionMeters;
  const col = Math.round((x - layer.bounds.minX) / res);
  const row = Math.round((z - layer.bounds.minZ) / res);
  return layer.masks.semantic![row * layer.widthSamples + col];
}

// -------------------------------------------------------------------- ramp --

describe('ramp', () => {
  const rampOp = (over: Partial<TerrainOperation> = {}) =>
    makeOp({
      kind: 'ramp',
      headingDegrees: 90, // east: +X
      lengthMeters: 20,
      radiusMeters: 3, // half-width
      targetElevationMeters: 2,
      ...over,
    });

  it('grades linearly from the existing surface to the far-end target', () => {
    const layer = flatLayer(60, 0.25);
    applyOperation(layer, rampOp());
    // Mid-ramp on the centreline: halfway between 0 and 2.
    expect(h(layer, 10, 0)).toBeCloseTo(1, 3);
    // Near the far end, inside the plateau: 19/20 of the way up.
    expect(h(layer, 19, 0)).toBeCloseTo(1.9, 3);
    // The near end keeps the existing grade.
    expect(Math.abs(h(layer, 0, 0))).toBeLessThan(1e-6);
    // Behind the near end and laterally outside the footprint: untouched.
    expect(h(layer, -2, 0)).toBe(0);
    expect(h(layer, 10, 8)).toBe(0);
  });

  it('follows the azimuth convention: heading 0 builds toward -Z (north)', () => {
    const layer = flatLayer(60, 0.25);
    applyOperation(layer, rampOp({ headingDegrees: 0 }));
    expect(h(layer, 0, -10)).toBeCloseTo(1, 3);
    expect(h(layer, 0, 10)).toBe(0);
  });

  it('deposits about the prism volume of the graded wedge', () => {
    const layer = flatLayer(60, 0.25);
    const r = applyOperation(layer, rampOp());
    // Core wedge: mean height 1 m over 20 m x 6 m = 120 m³; edge falloff
    // bands add some on top.
    expect(r.removedVolumeM3).toBe(0);
    expect(r.depositedVolumeM3).toBeGreaterThan(100);
    expect(r.depositedVolumeM3).toBeLessThan(165);
    expect(r.elevationAfter.max).toBeCloseTo(2, 1);
    // Semantic mask over the graded surface.
    expect(maskAt(layer, 10, 0)).toBe(semanticIndex('compacted_surface'));
  });

  it('conserves mass when asked to', () => {
    const layer = flatLayer(90, 0.25);
    const r = applyOperation(layer, rampOp({ massConserving: true }));
    expect(r.removedVolumeM3).toBeGreaterThan(0);
    expect(relError(r)).toBeLessThan(0.01);
  });
});

// --------------------------------------------------------------------- pad --

describe('pad', () => {
  it('flattens a circular pad to the target, reporting cut AND fill', () => {
    // Step terrain: -1 west of the origin, +1 east of it. A pad at target 0
    // must cut the high half and fill the low half by equal amounts.
    const layer = flatLayer(40, 0.1);
    for (let row = 0; row < layer.heightSamples; row++) {
      for (let col = 0; col < layer.widthSamples; col++) {
        const x = layer.bounds.minX + col * layer.horizontalResolutionMeters;
        layer.heightData[row * layer.widthSamples + col] = x < 0 ? -1 : 1;
      }
    }
    const r = applyOperation(
      layer,
      makeOp({ kind: 'pad', radiusMeters: 5, targetElevationMeters: 0 }),
    );
    // Inside the pad: exactly at target on both former sides of the step.
    expect(h(layer, 2, 2)).toBeCloseTo(0, 4);
    expect(h(layer, -2, -2)).toBeCloseTo(0, 4);
    // Well outside: untouched.
    expect(h(layer, 8, 0)).toBeCloseTo(1, 4);
    expect(h(layer, -8, 0)).toBeCloseTo(-1, 4);
    // Cut and fill each approximate a half-disc of 1 m depth: π·25/2 ≈ 39.3,
    // plus the edge falloff band; the two must balance closely.
    expect(r.removedVolumeM3).toBeGreaterThan(35);
    expect(r.removedVolumeM3).toBeLessThan(50);
    expect(r.depositedVolumeM3).toBeGreaterThan(35);
    expect(r.depositedVolumeM3).toBeLessThan(50);
    expect(r.removedVolumeM3 / r.depositedVolumeM3).toBeGreaterThan(0.9);
    expect(r.removedVolumeM3 / r.depositedVolumeM3).toBeLessThan(1.1);
    expect(maskAt(layer, 0, 0)).toBe(semanticIndex('compacted_surface'));
  });

  it('supports a rectangular footprint oriented by heading', () => {
    const layer = flatLayer(40, 0.1);
    // Heading 0 (north): 10 m long along -Z/+Z, 4 m wide.
    applyOperation(
      layer,
      makeOp({
        kind: 'pad',
        headingDegrees: 0,
        lengthMeters: 10,
        radiusMeters: 2,
        targetElevationMeters: 1,
      }),
    );
    expect(h(layer, 0, -4)).toBeCloseTo(1, 4); // inside, along the axis
    expect(h(layer, 0, 4)).toBeCloseTo(1, 4); // footprint is centred
    expect(h(layer, 3.5, 0)).toBe(0); // outside laterally
    expect(h(layer, 0, 6.5)).toBe(0); // beyond the end + falloff band
  });

  it('conserves mass when asked to', () => {
    const layer = flatLayer(40, 0.1);
    const r = applyOperation(
      layer,
      makeOp({ kind: 'pad', radiusMeters: 5, targetElevationMeters: 1, massConserving: true }),
    );
    expect(r.depositedVolumeM3).toBeGreaterThan(0);
    expect(relError(r)).toBeLessThan(0.01);
  });
});

// -------------------------------------------------------------- spoil pile --

describe('spoil_pile', () => {
  it('builds a cone of (1/3)πr²h', () => {
    const layer = flatLayer(30, 0.1);
    const r = applyOperation(
      layer,
      makeOp({ kind: 'spoil_pile', radiusMeters: 4, strengthMeters: 1 }),
    );
    expect(h(layer, 0, 0)).toBeCloseTo(1, 3); // apex
    expect(h(layer, 2, 0)).toBeCloseTo(0.5, 3); // half-radius
    expect(h(layer, 4.2, 0)).toBe(0); // beyond the base
    const cone = (Math.PI * 4 * 4 * 1) / 3; // 16.755 m³
    expect(r.removedVolumeM3).toBe(0);
    expect(r.depositedVolumeM3).toBeGreaterThan(cone * 0.95);
    expect(r.depositedVolumeM3).toBeLessThan(cone * 1.05);
    expect(r.reposeClamp).toBeUndefined();
    expect(maskAt(layer, 0, 0)).toBe(semanticIndex('berm'));
  });

  it('clamps the height at the 35° angle of repose and reports the clamp', () => {
    const layer = flatLayer(30, 0.1);
    const r = applyOperation(
      layer,
      makeOp({ kind: 'spoil_pile', radiusMeters: 2, strengthMeters: 5 }),
    );
    const maxHeight = 2 * Math.tan((35 * Math.PI) / 180); // 1.4004 m
    expect(r.reposeClamp).toBeDefined();
    expect(r.reposeClamp!.requestedHeightMeters).toBe(5);
    expect(r.reposeClamp!.appliedHeightMeters).toBeCloseTo(maxHeight, 6);
    expect(r.reposeClamp!.reposeAngleDeg).toBe(35);
    expect(h(layer, 0, 0)).toBeCloseTo(maxHeight, 3);
  });

  it('borrows the pile volume from the surrounding ring when mass-conserving', () => {
    const layer = flatLayer(30, 0.1);
    const r = applyOperation(
      layer,
      makeOp({ kind: 'spoil_pile', radiusMeters: 4, strengthMeters: 1, massConserving: true }),
    );
    expect(r.removedVolumeM3).toBeGreaterThan(0);
    expect(relError(r)).toBeLessThan(0.01);
  });
});

// ------------------------------------------------------------- wheel track --

describe('wheel_track', () => {
  const trackOp = (over: Partial<TerrainOperation> = {}) =>
    makeOp({
      kind: 'wheel_track',
      headingDegrees: 90, // ruts run east-west
      lengthMeters: 10,
      radiusMeters: 2, // gauge: rut centres at z = ±1
      strengthMeters: 0.2, // rut depth
      ...over,
    });

  it('cuts two parallel ruts with raised berms beside them', () => {
    const layer = flatLayer(30, 0.05);
    applyOperation(layer, trackOp());
    expect(h(layer, 0, 1)).toBeCloseTo(-0.2, 3); // rut floor
    expect(h(layer, 0, -1)).toBeCloseTo(-0.2, 3); // the other rut
    expect(h(layer, 0, 0)).toBe(0); // between the ruts
    // Berm crest: rut half-width 0.3, berm band 0.3 wide, peak mid-band at
    // |lat - 1| = 0.45. Height = 0.8 · rutArea / bermWidth with
    // rutArea = depth·2w/(p+1) = 0.2·0.6/3 = 0.04 → 0.1067 m.
    expect(h(layer, 0, 1.45)).toBeCloseTo(0.1067, 3);
    expect(h(layer, 6, 1)).toBe(0); // beyond the track end
    expect(h(layer, 0, 2)).toBe(0); // outside both berms
    expect(maskAt(layer, 0, 1)).toBe(semanticIndex('disturbed_regolith'));
  });

  it('deposits ~80% of the rut removal into the berms', () => {
    const layer = flatLayer(30, 0.05);
    const r = applyOperation(layer, trackOp());
    expect(r.removedVolumeM3).toBeGreaterThan(0);
    const ratio = r.depositedVolumeM3 / r.removedVolumeM3;
    expect(ratio).toBeGreaterThan(0.72);
    expect(ratio).toBeLessThan(0.88);
  });

  it('closes the remaining 20% via the redistribution ring when mass-conserving', () => {
    const layer = flatLayer(30, 0.05);
    const r = applyOperation(layer, trackOp({ massConserving: true }));
    expect(relError(r)).toBeLessThan(0.01);
  });
});

// --------------------------------------------------------- polygonal ops --

describe('polygonal_cut and polygonal_fill', () => {
  const square = [
    [-5, -5],
    [5, -5],
    [5, 5],
    [-5, 5],
  ];

  it('cuts the polygon interior down to the target with a boundary falloff band', () => {
    const layer = flatLayer(40, 0.1);
    const r = applyOperation(
      layer,
      makeOp({
        kind: 'polygonal_cut',
        polygonXZ: square,
        targetElevationMeters: -1,
        radiusMeters: 1, // falloff band width
      }),
    );
    expect(h(layer, 0, 0)).toBeCloseTo(-1, 4);
    expect(h(layer, 4.9, 4.9)).toBeCloseTo(-1, 4);
    // In the falloff band: partially cut.
    expect(h(layer, 5.5, 0)).toBeLessThan(-0.01);
    expect(h(layer, 5.5, 0)).toBeGreaterThan(-0.99);
    // Beyond the band: untouched.
    expect(h(layer, 7, 0)).toBe(0);
    // 10x10 interior at 1 m depth plus the boundary band.
    expect(r.depositedVolumeM3).toBe(0);
    expect(r.removedVolumeM3).toBeGreaterThan(100);
    expect(r.removedVolumeM3).toBeLessThan(130);
    expect(maskAt(layer, 0, 0)).toBe(semanticIndex('trench'));
  });

  it('fills the polygon interior up to the target', () => {
    const layer = flatLayer(40, 0.1);
    const r = applyOperation(
      layer,
      makeOp({
        kind: 'polygonal_fill',
        polygonXZ: square,
        targetElevationMeters: 1,
        radiusMeters: 1,
      }),
    );
    expect(h(layer, 0, 0)).toBeCloseTo(1, 4);
    expect(h(layer, 7, 0)).toBe(0);
    expect(r.removedVolumeM3).toBe(0);
    expect(r.depositedVolumeM3).toBeGreaterThan(100);
    expect(r.depositedVolumeM3).toBeLessThan(130);
    expect(maskAt(layer, 0, 0)).toBe(semanticIndex('berm'));
  });

  it('honours non-convex polygons', () => {
    const lShape = [
      [-5, -5],
      [5, -5],
      [5, 0],
      [0, 0],
      [0, 5],
      [-5, 5],
    ];
    const layer = flatLayer(40, 0.1);
    applyOperation(
      layer,
      makeOp({
        kind: 'polygonal_cut',
        polygonXZ: lShape,
        targetElevationMeters: -1,
        radiusMeters: 1,
      }),
    );
    expect(h(layer, -3, -3)).toBeCloseTo(-1, 4); // inside the L
    expect(h(layer, 3, 3)).toBe(0); // in the notch, beyond the band
  });

  it('redistributes around the polygon bounding circle when mass-conserving', () => {
    const layer = flatLayer(40, 0.1);
    const r = applyOperation(
      layer,
      makeOp({
        kind: 'polygonal_cut',
        polygonXZ: square,
        targetElevationMeters: -1,
        radiusMeters: 1,
        massConserving: true,
      }),
    );
    expect(r.depositedVolumeM3).toBeGreaterThan(0);
    expect(relError(r)).toBeLessThan(0.01);
  });

  it('rejects a missing, short, or non-finite polygon with TERRAIN_INVALID_CONFIG', () => {
    const layer = flatLayer(20, 0.1);
    const bad = (polygonXZ: unknown) =>
      makeOp({
        kind: 'polygonal_cut',
        targetElevationMeters: -1,
        radiusMeters: 1,
        polygonXZ: polygonXZ as number[][],
      });

    for (const polygon of [
      undefined, // missing entirely
      [
        [0, 0],
        [1, 0],
      ], // only 2 vertices
      [
        [0, 0],
        [1, 0],
        [1, Number.NaN],
      ], // non-finite vertex
      [[0, 0], [1, 0], [1]], // malformed pair
    ]) {
      let error: unknown;
      try {
        applyOperation(layer, bad(polygon));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TerrainError);
      expect((error as TerrainError).code).toBe('TERRAIN_INVALID_CONFIG');
    }
    // Nothing was committed by any rejected call.
    expect(h(layer, 0, 0)).toBe(0);
  });
});

// ------------------------------------------------- protocol-level round-trip --

describe('construction over the protocol', () => {
  // 8797 was the intended port, but 8796-8799 are occupied by unrelated
  // long-running local services on the dev host; 8795 is the nearest free one.
  // 8801: must be unique across ALL test files, not merely unused by system
  // services — vitest runs files in parallel, and this suite originally chose
  // 8795, colliding with godot-integration.test.ts's sidecar and failing only
  // in the full run. (8796-8799 are held by unrelated services on this host.)
  const PORT = 8801;
  const WORK = resolve(__dirname, '../.test-artifacts/construction');

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
    terrainId: 'construction_site',
    seed: 'construction-seed',
    outputDirectory: WORK,
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    layers: [{ role: 'context', widthMeters: 60, lengthMeters: 60, resolutionMeters: 0.5 }],
    dem: { enabled: true, path: SITE01_DEM, applyToRoles: ['context'] },
    proceduralStack: [],
    craters: { enabled: false },
    rocks: { enabled: false },
    regolith: { enabled: false },
    solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z' },
  };

  beforeAll(async () => {
    if (!existsSync(SITE01_DEM)) {
      throw new Error(
        `required real Site01 DEM is unavailable at ${SITE01_DEM}; ` +
          'run scripts/fetch-data.sh or set LTS_SITE01_DEM',
      );
    }
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

  it('declares the construction kinds in its capabilities', async () => {
    const r = await rpc('terrain.capabilities');
    for (const kind of ['ramp', 'pad', 'spoil_pile', 'wheel_track', 'polygonal_cut', 'polygonal_fill']) {
      expect(r.result.operations).toContain(kind);
    }
  });

  it('rejects Float32-overflowing finite proposals without mutating terrain, masks, or features', async () => {
    const dataset = (await rpc('terrain.getDataset')).result;
    const layer = dataset.layers[0];
    expect(layer.elevationProvenance).toBe('measured_dem');

    const captureMutableBytes = async () => {
      const response = await rpc('terrain.snapshot');
      expect(response.error).toBeUndefined();
      const snapshot = response.result;
      const layerSnapshot = snapshot.layers.find(
        (candidate: { layerId: string }) => candidate.layerId === layer.id,
      );
      expect(layerSnapshot).toBeDefined();
      const masks = Object.fromEntries(
        Object.entries(layerSnapshot.masks)
          .filter((entry): entry is [string, { file: string }] => entry[1] !== null)
          .map(([name, blob]) => [name, readFileSync(join(snapshot.directory, blob.file))]),
      );
      return {
        height: readFileSync(join(snapshot.directory, layerSnapshot.heightFile)),
        masks,
        featureAndAuditState: readFileSync(join(snapshot.directory, snapshot.stateFile)),
      };
    };

    const before = await captureMutableBytes();
    const additive = await rpc('terrain.applyOperation', {
      operation: {
        kind: 'raise',
        layerId: layer.id,
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 3,
        strengthMeters: 1e308,
      },
    });
    const flattenStyle = await rpc('terrain.applyOperation', {
      operation: {
        kind: 'pad',
        layerId: layer.id,
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 3,
        strengthMeters: 0,
        targetElevationMeters: 1e308,
      },
    });
    const after = await captureMutableBytes();

    expect(additive.error?.data?.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(flattenStyle.error?.data?.code).toBe('TERRAIN_INVALID_CONFIG');
    expect(after.height).toEqual(before.height);
    expect(after.masks).toEqual(before.masks);
    expect(after.featureAndAuditState).toEqual(before.featureAndAuditState);
  });

  it('applies a spoil pile, returns its delta, and exports the feature manifest', async () => {
    const apply = await rpc('terrain.applyOperation', {
      operation: {
        kind: 'spoil_pile',
        centerXMeters: 0,
        centerZMeters: 0,
        radiusMeters: 3,
        strengthMeters: 1,
      },
    });
    expect(apply.result.delta).toBeDefined();
    const mb = apply.result.delta.massBalance;
    const cone = (Math.PI * 3 * 3 * 1) / 3; // 9.42 m³
    // The pile is additive, so the deposit is the cone volume regardless of
    // the terrain underneath it.
    expect(mb.removedVolumeM3).toBe(0);
    expect(mb.depositedVolumeM3).toBeGreaterThan(cone * 0.9);
    expect(mb.depositedVolumeM3).toBeLessThan(cone * 1.1);

    // The semantic mask now reads 'berm' at the pile.
    const sem = (await rpc('terrain.getSemanticClass', { x: 0, z: 0 })).result;
    expect(sem.semanticClass).toBe('berm');

    // A subsequent export carries the feature in features_construction.json
    // and still passes the exporter's own validation.
    const exp = await rpc('terrain.export', {
      outputDirectory: WORK,
      formats: { exr: false, png16: false, glb: false },
    });
    expect(exp.result.validation.passed).toBe(true);

    const path = join(WORK, 'features_construction.json');
    expect(existsSync(path)).toBe(true);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    expect(manifest.count).toBe(1);
    const feature = manifest.features[0];
    expect(feature.kind).toBe('spoil_pile');
    expect(feature.semantic_class).toBe('berm');
    expect(feature.mass_balance.bulkDensityKgM3).toBe(1500);
    expect(feature.mass_balance.depositedVolumeM3).toBeCloseTo(mb.depositedVolumeM3, 6);
    expect(feature.mass_balance.netMassKg).toBeCloseTo(mb.netVolumeM3 * 1500, 3);
  });
});
