/**
 * The Godot sidecar service (spec §16).
 *
 * JSON-RPC 2.0 over WebSocket on `ws://127.0.0.1:8765` by default. Generation
 * runs as a cancellable job with progress notifications; every failure is a
 * structured error carrying a machine-readable code (spec §28).
 *
 * Bound to the loopback interface only. This service reads and writes arbitrary
 * filesystem paths supplied by its client, so exposing it on a routable address
 * would be handing out a remote file-write primitive.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ERROR_CODES,
  TerrainError,
  elevationAt,
  finestLayerAt,
  heightAtWorld,
  normalAtWorld,
  parseConfig,
  slopeDegAtWorld,
  recomputeVerticalBounds,
  SEMANTIC_CLASSES,
  type ConstructionFeature,
  type TerrainDataset,
  type TerrainLayer,
  type RockFeature,
} from '@lts/shared-types';
import { estimate, assertFeasible } from '@lts/terrain-core';
import { generateTerrain, GENERATOR_VERSION } from '@lts/terrain-pipeline';
import { exportTerrain } from '@lts/terrain-export';
import { validateDataset } from '@lts/terrain-validation';
import {
  DELTA_WINDOW,
  METHODS,
  PROTOCOL_VERSION,
  RPC_CODES,
  SPARSE_SAMPLE_CAP,
  type JobRecord,
  type JsonRpcRequest,
  type TerrainDelta,
  type TerrainOperation,
} from '@lts/terrain-protocol';
import { buildLocalFrame, localToProjected, inverse } from '@lts/lunar-dem';
import {
  horizonProfile,
  samplerFromArray,
  solarPositionAtSite,
  solarPositionAtSiteDE,
  loadDeKernels,
  parseInstant,
  SpiceKernelError,
} from '@lts/lunar-solar';
import { applyOperation, layerChecksum, makeDelta, maskChecksum } from './operations.js';

interface Session {
  dataset?: TerrainDataset;
  tileSizeSamples: number;
  /**
   * The most recent deltas, newest last, capped at DELTA_WINDOW (256): a live
   * sync client polls terrain.getChangedSince and fetches individual deltas by
   * sequence number, so recent history must survive — but unbounded retention
   * would grow without limit under continuous editing. Pruned sequence numbers
   * error as pruned (full resync required), never as unknown.
   */
  deltas: TerrainDelta[];
  operationLog: TerrainOperation[];
  /**
   * Sequence number the NEXT delta will receive. Tracked separately from
   * `deltas.length` because the window above prunes the array's head.
   */
  nextSequence: number;
  /** Output directory of the installed dataset's generate; snapshots go under it. */
  outputDirectory?: string;
}

const jobs = new Map<string, JobRecord>();
const cancelFlags = new Map<string, { aborted: boolean }>();
const session: Session = { tileSizeSamples: 256, deltas: [], operationLog: [], nextSequence: 0 };
let jobCounter = 0;
/**
 * Job id of the generate currently running, or null.
 *
 * The session is a single shared dataset, so two concurrent generates would
 * race to install their results, and an edit applied mid-generation would be
 * acknowledged and then silently destroyed when the new dataset lands. Rather
 * than pretending to support concurrency the session model cannot deliver,
 * one generate runs at a time and mutating calls are refused while it does —
 * with a structured error, never a silent overwrite.
 */
let runningJobId: string | null = null;
/** Bound on remembered job records; oldest finished jobs are pruned. */
const MAX_JOB_RECORDS = 64;

/**
 * Exactly the operation kinds `applyOperation` implements. Declared once so
 * the capabilities announcement and the apply/replay validation cannot drift:
 * an unknown kind is a structured error, never a silent no-op.
 */
const OPERATION_KINDS = [
  'raise',
  'lower',
  'smooth',
  'flatten',
  'slope',
  'noise',
  'semantic_paint',
  'crater_stamp',
  'trench',
  'berm',
  'ramp',
  'pad',
  'spoil_pile',
  'wheel_track',
  'polygonal_cut',
  'polygonal_fill',
] as const;

function pruneJobs(): void {
  if (jobs.size <= MAX_JOB_RECORDS) return;
  for (const [id, record] of jobs) {
    if (jobs.size <= MAX_JOB_RECORDS) break;
    if (record.status === 'complete' || record.status === 'failed' || record.status === 'cancelled') {
      jobs.delete(id);
    }
  }
}

function requireNoRunningJob(action: string): void {
  if (runningJobId !== null) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `Cannot ${action} while generation job ${runningJobId} is running. ` +
        'Wait for it to finish or cancel it first.',
      { runningJobId },
    );
  }
}

function ok(id: JsonRpcRequest['id'], result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function fail(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, data } });
}

function terrainFail(id: JsonRpcRequest['id'], e: unknown): string {
  if (e instanceof TerrainError) {
    return fail(id, RPC_CODES.TERRAIN_ERROR, e.message, e.toJSON());
  }
  return fail(id, RPC_CODES.INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
}

function requireDataset(): TerrainDataset {
  if (!session.dataset) {
    throw new TerrainError(
      ERROR_CODES.JOB_NOT_FOUND,
      'No terrain is loaded. Call terrain.generate first.',
    );
  }
  return session.dataset;
}

function num(params: Record<string, unknown> | undefined, key: string): number {
  const v = params?.[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `parameter '${key}' must be a finite number`,
    );
  }
  return v;
}

/**
 * Traversability heuristic (spec §22).
 *
 * SYNTHETIC HEURISTIC. Slope and local roughness are combined into a 0–1 score
 * by a hand-chosen weighting. No terramechanics model is connected, so this
 * must not be read as a wheel-slip prediction — the label travels with the
 * response so a consumer cannot mistake it for one.
 */
function traversabilityAt(dataset: TerrainDataset, x: number, z: number) {
  const layer = finestLayerAt(dataset, x, z);
  if (!layer) return null;
  const slopeDeg = slopeDegAtWorld(layer, x, z);
  const res = layer.horizontalResolutionMeters;

  const h0 = heightAtWorld(layer, x, z);
  let sq = 0;
  let n = 0;
  for (const [dx, dz] of [
    [res, 0],
    [-res, 0],
    [0, res],
    [0, -res],
  ]) {
    const h = heightAtWorld(layer, x + dx, z + dz);
    if (Number.isFinite(h)) {
      sq += (h - h0) * (h - h0);
      n++;
    }
  }
  const roughness = n > 0 ? Math.sqrt(sq / n) : 0;

  const slopeScore = Math.max(0, 1 - slopeDeg / 25);
  const roughScore = Math.max(0, 1 - roughness / (res * 2));
  const score = 0.65 * slopeScore + 0.35 * roughScore;

  let cls = 'traversable';
  if (slopeDeg > 25) cls = 'unsafe_slope';
  else if (score < 0.4) cls = 'difficult';
  else if (score < 0.7) cls = 'moderate';

  return {
    slopeDeg,
    roughnessM: roughness,
    score,
    class: cls,
    provenance: 'synthetic heuristic — not a validated terramechanics prediction',
  };
}


/**
 * Re-seat rock instances onto the surface after a terrain edit.
 *
 * A rock is an instance placed on the ground, not part of the heightfield, so
 * an operation that raises or lowers terrain beneath it leaves its stored
 * elevation stale. Rocks whose centre falls inside the affected bounds are
 * re-solved against the new surface using the same relation the generator used:
 *
 *     y = ground + semiAxisY * (1 - 2 * buriedFraction)
 *
 * Returns how many were moved, so the caller can report it.
 */
function reseatRocks(
  dataset: TerrainDataset,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number },
): number {
  let moved = 0;
  for (const feature of dataset.featureManifest) {
    if (feature.kind !== 'rock') continue;
    const rock = feature as RockFeature;
    const { x, z } = rock.position;
    if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
    // Ground comes from the FINEST covering layer — the tier rocks were
    // generated on and the tier the exporter validates burial against.
    // Using the edited layer instead snapped rocks to a coarse surface that
    // can differ by decimetres, failing rocks_burial_consistent.
    const ground = elevationAt(dataset, x, z);
    if (!Number.isFinite(ground)) continue;
    const y = ground + rock.scale.y * (1 - 2 * rock.buriedFraction);
    // DOWNWARD ONLY. Excavating under a rock drops it; but material dumped
    // ON TOP of a rock (a spoil pile, a berm, a polygonal fill) buries it —
    // it must not levitate to ride the new surface at its old burial
    // fraction. A buried rock keeps its position and simply ends up deeper.
    if (y < rock.position.y) {
      rock.position.y = y;
      moved++;
    }
  }
  return moved;
}

/**
 * Compact, transfer-friendly view of a delta for history listings and replay
 * results: identity, sequencing, mass balance and checksums, but the tile-id
 * LIST reduced to its count — a history browser needs "how much changed",
 * not thousands of tile ids per row (terrain.getTile serves the data itself).
 */
function deltaSummary(d: TerrainDelta) {
  return {
    deltaId: d.deltaId,
    sequenceNumber: d.sequenceNumber,
    kind: d.operations[0].kind,
    changedTileCount: d.changedTiles.length,
    massBalance: d.massBalance,
    timestamp: d.timestamp,
    resultingChecksum: d.resultingChecksum,
    resultingMaskChecksum: d.resultingMaskChecksum,
  };
}

/**
 * Retained-delta window bounds: `head` is the sequence number the next delta
 * will receive, `oldest` the lowest sequence number still retained. With no
 * deltas retained (fresh baseline, or everything pruned) `oldest === head`.
 */
function sequenceWindow(): { head: number; oldest: number } {
  const head = session.nextSequence;
  const oldest = session.deltas.length > 0 ? session.deltas[0].sequenceNumber : head;
  return { head, oldest };
}

/** A required non-negative-integer `sequenceNumber` parameter. */
function sequenceParam(p: Record<string, unknown>): number {
  const seq = num(p, 'sequenceNumber');
  if (!Number.isInteger(seq) || seq < 0) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      "parameter 'sequenceNumber' must be a non-negative integer",
      { sequenceNumber: seq },
    );
  }
  return seq;
}

/**
 * The two ways a sequence number can miss the retained window, kept DISTINCT
 * because the client's remedy differs: an unknown sequence number is a caller
 * bug (it never existed here); a pruned one existed but has aged out of the
 * DELTA_WINDOW, and the only correct recovery is a full resync — refetch the
 * affected tiles or restore a snapshot, not retry.
 */
function unknownSequenceError(seq: number, head: number): TerrainError {
  return new TerrainError(
    ERROR_CODES.JOB_NOT_FOUND,
    `no delta with sequence number ${seq} exists; the current head sequence is ${head}`,
    { reason: 'unknown', requestedSequence: seq, headSequence: head },
  );
}

function prunedSequenceError(seq: number, oldest: number, head: number): TerrainError {
  return new TerrainError(
    ERROR_CODES.JOB_NOT_FOUND,
    `delta ${seq} has been pruned (only the last ${DELTA_WINDOW} deltas are retained; ` +
      `oldest retained is ${oldest}) — do a full resync: refetch tiles with terrain.getTile ` +
      'or restore a snapshot',
    {
      reason: 'pruned',
      requestedSequence: seq,
      oldestRetained: oldest,
      headSequence: head,
      deltaWindow: DELTA_WINDOW,
    },
  );
}

/** SHA-256 hex digest of raw file bytes, for snapshot manifest validation. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The single internal path every edit takes, whether it arrives via
 * terrain.applyOperation or terrain.replayLog (spec §12, §19): validate,
 * apply, refresh bounds, re-seat rocks, record the delta and the operation
 * log entry, and append any construction feature. Replay going through the
 * same door as a live apply is what makes the replayed terrain identical —
 * a second code path would drift.
 */
function performOperation(opInput: Partial<TerrainOperation> | undefined) {
  const dataset = requireDataset();
  if (!opInput || typeof opInput.kind !== 'string') {
    throw new TerrainError(ERROR_CODES.INVALID_CONFIG, 'operation.kind is required');
  }
  if (!(OPERATION_KINDS as readonly string[]).includes(opInput.kind)) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `unknown operation kind '${opInput.kind}'`,
      { kind: opInput.kind, supported: [...OPERATION_KINDS] },
    );
  }
  // The finest-layer fallback exists for an OMITTED layerId only. A record
  // that names a layer which does not exist must be a structured error: a
  // replayed log from a different configuration previously fell through to
  // the finest layer and re-applied every recorded edit onto the wrong
  // terrain with a success response — silent cross-dataset corruption.
  let layer: TerrainLayer;
  if (opInput.layerId !== undefined) {
    const named = dataset.layers.find((l) => l.id === opInput.layerId);
    if (!named) {
      throw new TerrainError(
        ERROR_CODES.INVALID_CONFIG,
        `operation.layerId '${opInput.layerId}' does not exist in this dataset`,
        { layerId: opInput.layerId, availableLayers: dataset.layers.map((l) => l.id) },
      );
    }
    layer = named;
  } else {
    layer = dataset.layers.reduce((a, b) =>
      a.horizontalResolutionMeters <= b.horizontalResolutionMeters ? a : b,
    );
  }

  // Every numeric parameter is checked finite BEFORE touching the
  // heightfield. A NaN here would be committed into terrain data and
  // acknowledged with a success delta, surfacing only much later as
  // validation failures far from the cause.
  const finite = (v: unknown, name: string, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TerrainError(
        ERROR_CODES.INVALID_CONFIG,
        `operation.${name} must be a finite number`,
        { [name]: String(v) },
      );
    }
    return v;
  };
  const finiteOpt = (v: unknown, name: string): number | undefined =>
    v === undefined ? undefined : finite(v, name, 0);

  const op: TerrainOperation = {
    operationId: `op-${String(session.operationLog.length).padStart(6, '0')}`,
    kind: opInput.kind as TerrainOperation['kind'],
    layerId: layer.id,
    centerXMeters: finite(opInput.centerXMeters, 'centerXMeters', 0),
    centerZMeters: finite(opInput.centerZMeters, 'centerZMeters', 0),
    radiusMeters: finite(opInput.radiusMeters, 'radiusMeters', 1),
    strengthMeters: finite(opInput.strengthMeters, 'strengthMeters', 0.1),
    falloff: finite(opInput.falloff, 'falloff', 2),
    targetElevationMeters: finiteOpt(opInput.targetElevationMeters, 'targetElevationMeters'),
    headingDegrees: finiteOpt(opInput.headingDegrees, 'headingDegrees'),
    lengthMeters: finiteOpt(opInput.lengthMeters, 'lengthMeters'),
    // Validated structurally (>= 3 finite [x, z] vertices) inside
    // applyOperation, before the heightfield is touched.
    ...(opInput.polygonXZ !== undefined ? { polygonXZ: opInput.polygonXZ } : {}),
    // Required for 'noise' / 'semantic_paint' respectively; both validated
    // inside applyOperation before the heightfield or mask is touched.
    ...(opInput.noiseSeed !== undefined ? { noiseSeed: opInput.noiseSeed } : {}),
    ...(opInput.semanticClass !== undefined ? { semanticClass: opInput.semanticClass } : {}),
    massConserving: opInput.massConserving ?? false,
    timestamp: new Date().toISOString(),
  };
  if (op.radiusMeters <= 0) {
    throw new TerrainError(ERROR_CODES.INVALID_CONFIG, 'operation.radiusMeters must be positive', {
      radiusMeters: op.radiusMeters,
    });
  }

  const before = layerChecksum(layer);
  const beforeMask = maskChecksum(layer);
  const result = applyOperation(layer, op);
  // The edit moved the surface, so the layer's recorded vertical bounds
  // are stale; exporting them would fail the exporter's own
  // vertical-bounds validation on perfectly healthy data.
  recomputeVerticalBounds(layer);
  dataset.bounds.minY = Math.min(...dataset.layers.map((l) => l.bounds.minY));
  dataset.bounds.maxY = Math.max(...dataset.layers.map((l) => l.bounds.maxY));
  // Rocks sit *on* the surface, so an edit that moves the ground must
  // move them with it. Without this, lowering terrain under a boulder
  // leaves it hanging in vacuum — which the exporter's
  // "no rock sits entirely above the terrain" check correctly rejected.
  const reseated = reseatRocks(dataset, result.bounds);
  const delta = makeDelta(
    layer,
    op,
    result,
    session.nextSequence,
    before,
    beforeMask,
    session.tileSizeSamples,
  );
  session.nextSequence++;
  session.deltas.push(delta);
  // Retain only the last DELTA_WINDOW deltas for getDelta/getChangedSince.
  // The operation log below is NOT pruned: deterministic replay (spec §12)
  // needs the full ordered history, and it is far smaller than the deltas.
  while (session.deltas.length > DELTA_WINDOW) session.deltas.shift();
  session.operationLog.push(op);

  // Construction kinds (spec §11) — everything except the plain
  // sculpting brushes — are additionally recorded in the feature
  // manifest with their measured mass balance, so the export carries an
  // auditable record of every engineered feature.
  const constructionSemantic: Partial<Record<TerrainOperation['kind'], string>> = {
    trench: 'trench',
    berm: 'berm',
    ramp: 'compacted_surface',
    pad: 'compacted_surface',
    spoil_pile: 'berm',
    wheel_track: 'disturbed_regolith',
    polygonal_cut: 'trench',
    polygonal_fill: 'berm',
  };
  const semanticClass = constructionSemantic[op.kind];
  if (semanticClass !== undefined) {
    const bulkDensityKgM3 = 1500;
    const parameters: ConstructionFeature['parameters'] = {
      centerXMeters: op.centerXMeters,
      centerZMeters: op.centerZMeters,
      radiusMeters: op.radiusMeters,
      strengthMeters: op.strengthMeters,
      falloff: op.falloff,
      massConserving: op.massConserving ?? false,
      ...(op.targetElevationMeters !== undefined
        ? { targetElevationMeters: op.targetElevationMeters }
        : {}),
      ...(op.headingDegrees !== undefined ? { headingDegrees: op.headingDegrees } : {}),
      ...(op.lengthMeters !== undefined ? { lengthMeters: op.lengthMeters } : {}),
      // Flattened [x0, z0, x1, z1, ...] because feature parameters are
      // scalars and flat arrays only.
      ...(op.polygonXZ !== undefined
        ? { polygonXZFlat: op.polygonXZ.flat(), polygonVertexCount: op.polygonXZ.length }
        : {}),
      ...(result.aliasingWarning !== undefined
        ? { aliasingWarning: result.aliasingWarning }
        : {}),
      ...(result.reposeClamp !== undefined
        ? {
            reposeClampApplied: true,
            requestedHeightMeters: result.reposeClamp.requestedHeightMeters,
            appliedHeightMeters: result.reposeClamp.appliedHeightMeters,
            reposeAngleDeg: result.reposeClamp.reposeAngleDeg,
          }
        : {}),
    };
    const feature: ConstructionFeature = {
      id: `construction-${op.operationId}`,
      kind: op.kind as ConstructionFeature['kind'],
      appliedToLayers: [layer.id],
      // Footprint only — the delta's affectedBounds (below) still
      // covers the borrow ring for tile invalidation, but the FEATURE
      // is its geometry, not the ring it borrowed regolith from.
      affectedBounds: result.featureBounds ?? result.bounds,
      parameters,
      massBalance: {
        removedVolumeM3: delta.massBalance.removedVolumeM3,
        depositedVolumeM3: delta.massBalance.depositedVolumeM3,
        netVolumeM3: delta.massBalance.netVolumeM3,
        relativeError: delta.massBalance.relativeError,
        bulkDensityKgM3,
        netMassKg: delta.massBalance.netVolumeM3 * bulkDensityKgM3,
      },
      elevationBefore: result.featureElevationBefore ?? result.elevationBefore,
      elevationAfter: result.featureElevationAfter ?? result.elevationAfter,
      semanticClass,
    };
    dataset.featureManifest.push(feature);
  }

  return {
    delta,
    operation: op,
    rocksReseated: reseated,
    ...(result.reposeClamp !== undefined ? { reposeClamp: result.reposeClamp } : {}),
    ...(result.aliasingWarning !== undefined
      ? { aliasingWarning: result.aliasingWarning }
      : {}),
  };
}

async function handle(
  raw: string,
  _socket: WebSocket,
  server: WebSocketServer,
): Promise<string | null> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    return fail(null, RPC_CODES.PARSE_ERROR, 'request was not valid JSON');
  }
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return fail(req.id ?? null, RPC_CODES.INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
  }
  if (!(METHODS as readonly string[]).includes(req.method)) {
    return fail(req.id, RPC_CODES.METHOD_NOT_FOUND, `unknown method '${req.method}'`, {
      supported: METHODS,
    });
  }

  const p = req.params ?? {};

  try {
    switch (req.method) {
      case 'terrain.health':
        return ok(req.id, {
          status: 'ok',
          protocolVersion: PROTOCOL_VERSION,
          generatorVersion: GENERATOR_VERSION,
          uptimeSeconds: Math.round(process.uptime()),
          datasetLoaded: !!session.dataset,
        });

      case 'terrain.capabilities':
        return ok(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          generatorVersion: GENERATOR_VERSION,
          methods: METHODS,
          exportFormats: ['rf32', 'exr', 'png16', 'npy', 'glb', 'json'],
          // Declared honestly: exactly the operations that are implemented.
          // Anything absent returns a structured error, never a silent no-op.
          operations: [...OPERATION_KINDS],
          craterModels: ['production_csfd', 'power_law'],
          rockModels: ['golombek_sfd', 'power_law'],
          noiseModels: ['fbm', 'ridged', 'warped_fbm'],
          demFormats: ['pds3_img', 'geotiff'],
          solarModes: ['ephemeris', 'manual'],
          // Live-sync limits (spec §19), declared so a client can size its
          // polling strategy without discovering them from errors.
          sync: { sparseSampleCap: SPARSE_SAMPLE_CAP, deltaWindow: DELTA_WINDOW },
          coordinateSystem: {
            handedness: 'right',
            up_axis: '+Y',
            east_axis: '+X',
            north_axis: '-Z',
            linear_unit: 'meter',
          },
          notImplemented: {
            gpuGeneration: 'CPU generation is the reference implementation (spec §20).',
            volumetricTerrain: 'Heightfields only; no SDF or voxel patches yet.',
          },
        });

      case 'terrain.validateConfig': {
        const config = parseConfig(p.config ?? p);
        return ok(req.id, { valid: true, terrainId: config.terrainId, seed: config.seed });
      }

      case 'terrain.estimate': {
        const config = parseConfig(p.config ?? p);
        const est = estimate(config);
        let feasible = true;
        let error: unknown = null;
        try {
          assertFeasible(config, est);
        } catch (e) {
          feasible = false;
          error = e instanceof TerrainError ? e.toJSON() : String(e);
        }
        return ok(req.id, { estimate: est, feasible, error });
      }

      case 'terrain.generate': {
        const config = parseConfig(p.config ?? p);
        const jobId = `terrain-job-${String(++jobCounter).padStart(5, '0')}`;
        const record: JobRecord = {
          jobId,
          status: 'queued',
          seed: config.seed,
          terrainId: config.terrainId,
          stage: 'queued',
          progress: 0,
          startedAt: new Date().toISOString(),
        };
        requireNoRunningJob('start another generation');
        jobs.set(jobId, record);
        pruneJobs();
        const flag = { aborted: false };
        cancelFlags.set(jobId, flag);
        runningJobId = jobId;

        // Run asynchronously so the RPC returns the job id immediately.
        void (async () => {
          record.status = 'running';
          try {
            const { dataset, solar, horizon, notes } = await generateTerrain(config, {
              signal: flag,
              onProgress: (stage, progress, detail) => {
                record.stage = stage;
                record.progress = progress;
                const evt = JSON.stringify({
                  event: 'terrain.progress',
                  jobId,
                  stage,
                  progress,
                  detail,
                });
                for (const client of server.clients) {
                  if (client.readyState === 1) client.send(evt);
                }
              },
            });
            session.dataset = dataset;
            session.tileSizeSamples = config.tileSizeSamples;
            session.deltas = [];
            session.operationLog = [];
            session.nextSequence = 0;

            const outDir = resolve(config.outputDirectory);
            session.outputDirectory = outDir;
            exportTerrain(dataset, {
              outputDirectory: outDir,
              tileSizeSamples: config.tileSizeSamples,
              solar,
              horizon,
              notes,
            });
            record.status = 'complete';
            record.progress = 1;
            record.stage = 'complete';
            record.outputDirectory = outDir;
            record.finishedAt = new Date().toISOString();
          } catch (e) {
            record.status =
              e instanceof TerrainError && e.code === ERROR_CODES.CANCELLED
                ? 'cancelled'
                : 'failed';
            record.finishedAt = new Date().toISOString();
            record.error =
              e instanceof TerrainError
                ? e.toJSON()
                : { code: 'TERRAIN_INTERNAL', message: String(e), details: {} };
          } finally {
            cancelFlags.delete(jobId);
            runningJobId = null;
          }
        })();

        return ok(req.id, { jobId, status: 'queued', seed: config.seed });
      }

      case 'terrain.cancel': {
        const jobId = String(p.jobId ?? '');
        const flag = cancelFlags.get(jobId);
        if (!flag) {
          throw new TerrainError(ERROR_CODES.JOB_NOT_FOUND, `no running job '${jobId}'`, { jobId });
        }
        flag.aborted = true;
        return ok(req.id, { jobId, cancelling: true });
      }

      case 'terrain.getStatus': {
        const jobId = p.jobId ? String(p.jobId) : undefined;
        if (jobId) {
          const record = jobs.get(jobId);
          if (!record) {
            throw new TerrainError(ERROR_CODES.JOB_NOT_FOUND, `no job '${jobId}'`, { jobId });
          }
          return ok(req.id, record);
        }
        return ok(req.id, { jobs: [...jobs.values()] });
      }

      case 'terrain.getManifest': {
        const dir = p.directory
          ? String(p.directory)
          : jobs.get(String(p.jobId ?? ''))?.outputDirectory;
        if (!dir) {
          throw new TerrainError(ERROR_CODES.JOB_NOT_FOUND, 'no output directory known');
        }
        const path = resolve(dir, 'manifest.json');
        if (!existsSync(path)) {
          throw new TerrainError(ERROR_CODES.JOB_NOT_FOUND, `no manifest at ${path}`, { path });
        }
        return ok(req.id, JSON.parse(readFileSync(path, 'utf8')));
      }

      case 'terrain.getDataset': {
        // Layer geometry straight from the live session, so a viewer can size
        // its scene without an export having happened yet.
        const dataset = requireDataset();
        return ok(req.id, {
          terrainId: dataset.id,
          seed: dataset.seed,
          coordinateSystem: dataset.coordinateSystem,
          origin: {
            site: dataset.origin.site,
            datumElevationM: dataset.origin.datumElevationM,
          },
          bounds: dataset.bounds,
          layers: dataset.layers.map((l) => ({
            id: l.id,
            role: l.role,
            resolutionMeters: l.horizontalResolutionMeters,
            widthSamples: l.widthSamples,
            heightSamples: l.heightSamples,
            bounds: l.bounds,
            elevationProvenance: l.elevationProvenance,
            sourceEffectiveResolutionMeters: l.sourceEffectiveResolutionMeters ?? null,
          })),
          features: {
            craters: dataset.featureManifest.filter((f) => f.kind === 'crater').length,
            rocks: dataset.featureManifest.filter((f) => f.kind === 'rock').length,
          },
          provenance: dataset.provenance,
        });
      }

      case 'terrain.export': {
        requireNoRunningJob('export');
        const dataset = requireDataset();
        const outDir = resolve(String(p.outputDirectory ?? './generated/export'));
        const requested = (p.formats ?? {}) as Record<string, boolean>;
        const result = exportTerrain(dataset, {
          outputDirectory: outDir,
          tileSizeSamples: session.tileSizeSamples,
          formats: {
            exr: requested.exr ?? true,
            png16: requested.png16 ?? true,
            npy: requested.npy ?? false,
            glb: requested.glb ?? true,
          },
        });
        const report = validateDataset(outDir);
        return ok(req.id, {
          outputDirectory: outDir,
          artifacts: result.artifacts.length,
          totalBytes: result.totalBytes,
          validation: { passed: report.passed, errors: report.errors },
        });
      }

      case 'terrain.loadConfig': {
        const path = resolve(String(p.path ?? ''));
        if (!existsSync(path)) {
          throw new TerrainError(ERROR_CODES.INVALID_CONFIG, `no configuration at ${path}`, {
            path,
          });
        }
        return ok(req.id, parseConfig(JSON.parse(readFileSync(path, 'utf8'))));
      }

      case 'terrain.saveConfig': {
        const path = resolve(String(p.path ?? ''));
        const config = parseConfig(p.config);
        writeFileSync(path, JSON.stringify(config, null, 2));
        return ok(req.id, { path, bytes: JSON.stringify(config).length });
      }

      case 'terrain.applyOperation': {
        requireNoRunningJob('apply an operation');
        return ok(req.id, performOperation(p.operation as Partial<TerrainOperation> | undefined));
      }

      case 'terrain.getOperationLog': {
        // History inspection (spec §12): the full ordered operation log plus
        // per-delta SUMMARIES — the tile-id lists can run to thousands of
        // entries per delta and a history browser needs counts, not dumps.
        return ok(req.id, {
          operations: [...session.operationLog],
          deltas: session.deltas.map((d) => deltaSummary(d)),
        });
      }

      case 'terrain.replayLog': {
        // Deterministic replay of edits (spec §12, §19): generate with the
        // same seed, replay the same log, get the same terrain. Each record
        // goes through performOperation — exactly the applyOperation path,
        // validation included — so a replay can never commit what a live
        // apply would have refused.
        requireNoRunningJob('replay an operation log');
        const dataset = requireDataset();
        const ops = p.operations;
        if (!Array.isArray(ops)) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            "parameter 'operations' must be an array of operation records",
            { operations: String(ops) },
          );
        }
        const applied: Array<ReturnType<typeof deltaSummary>> = [];
        for (let i = 0; i < ops.length; i++) {
          try {
            const outcome = performOperation(ops[i] as Partial<TerrainOperation>);
            applied.push(deltaSummary(outcome.delta));
          } catch (e) {
            // Apply-up-to-failure: operations before the bad record are
            // already committed and stay committed (there is no transaction
            // over a heightfield) — so the error must say exactly how far
            // the replay got, never leave the caller guessing at the state.
            const cause =
              e instanceof TerrainError
                ? e.toJSON()
                : { code: 'TERRAIN_INTERNAL', message: String(e), details: {} };
            throw new TerrainError(
              ERROR_CODES.INVALID_CONFIG,
              `replay failed at operations[${i}]: ${cause.message} — the ${applied.length} ` +
                'preceding operation(s) were applied and remain applied',
              {
                failedIndex: i,
                appliedOperations: applied.length,
                totalOperations: ops.length,
                cause,
              },
            );
          }
        }
        // Final state: the last delta's checksums, or the current (finest)
        // layer's if the submitted log was empty.
        const finest = dataset.layers.reduce((a, b) =>
          a.horizontalResolutionMeters <= b.horizontalResolutionMeters ? a : b,
        );
        const last = session.deltas[session.deltas.length - 1];
        return ok(req.id, {
          applied: applied.length,
          deltas: applied,
          finalChecksum: applied.length > 0 ? last.resultingChecksum : layerChecksum(finest),
          finalMaskChecksum:
            applied.length > 0 ? last.resultingMaskChecksum : maskChecksum(finest),
        });
      }

      case 'terrain.getDelta': {
        // One stored delta, sparse payload included (spec §19): a sync client
        // that learns from getChangedSince that it missed sequence N fetches
        // exactly that delta and applies its changed samples in place.
        requireDataset();
        const seq = sequenceParam(p);
        const { head, oldest } = sequenceWindow();
        if (seq >= head) throw unknownSequenceError(seq, head);
        if (seq < oldest) throw prunedSequenceError(seq, oldest, head);
        // Retained deltas are contiguous in sequence, so index arithmetic
        // is exact — but assert rather than assume.
        const delta = session.deltas[seq - oldest];
        if (!delta || delta.sequenceNumber !== seq) {
          throw unknownSequenceError(seq, head);
        }
        return ok(req.id, delta);
      }

      case 'terrain.getChangedSince': {
        // The cheap poll (spec §19): "what changed since sequence N?" returns
        // the deduplicated union of changed tiles across every intervening
        // delta plus per-layer changed-sample counts, so a client can decide
        // whether to apply sparse deltas or refetch tiles — without the
        // server re-streaming anything.
        requireDataset();
        const seq = sequenceParam(p);
        const { head, oldest } = sequenceWindow();
        if (seq > head) throw unknownSequenceError(seq, head);
        if (seq < oldest) throw prunedSequenceError(seq, oldest, head);
        const tiles = new Set<string>();
        const perLayer = new Map<string, number>();
        for (const d of session.deltas) {
          if (d.sequenceNumber < seq) continue;
          for (const t of d.changedTiles) tiles.add(t);
          const layerId = d.operations[0].layerId;
          perLayer.set(layerId, (perLayer.get(layerId) ?? 0) + d.changedSampleCount);
        }
        return ok(req.id, {
          fromSequence: seq,
          toSequence: head,
          changedTiles: [...tiles],
          perLayer: [...perLayer].map(([layerId, changedSampleCount]) => ({
            layerId,
            changedSampleCount,
          })),
        });
      }

      case 'terrain.snapshot': {
        // Periodic full snapshot (spec §19): every layer's raw heightfield and
        // semantic mask plus a checksummed manifest, written under the
        // dataset's own output directory. Refused while a generate runs for
        // the same reason edits are: the dataset it would capture is about to
        // be replaced.
        requireNoRunningJob('snapshot the terrain');
        const dataset = requireDataset();
        if (!session.outputDirectory) {
          throw new TerrainError(
            ERROR_CODES.OUTPUT_NOT_WRITABLE,
            'no output directory is associated with the loaded dataset',
          );
        }
        const seq = session.nextSequence;
        const dir = resolve(session.outputDirectory, 'snapshots', `snap-${seq}`);
        mkdirSync(dir, { recursive: true });
        const layers = dataset.layers.map((layer) => {
          const heightFile = `${layer.id}.height.f32`;
          writeFileSync(
            resolve(dir, heightFile),
            Buffer.from(
              layer.heightData.buffer,
              layer.heightData.byteOffset,
              layer.heightData.byteLength,
            ),
          );
          const mask = layer.masks.semantic;
          let maskFile: string | null = null;
          if (mask) {
            maskFile = `${layer.id}.mask.u8`;
            writeFileSync(
              resolve(dir, maskFile),
              Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength),
            );
          }
          return {
            layerId: layer.id,
            widthSamples: layer.widthSamples,
            heightSamples: layer.heightSamples,
            heightFile,
            heightSha256: layerChecksum(layer),
            maskFile,
            maskSha256: maskChecksum(layer),
          };
        });
        const manifest = {
          sequenceNumber: seq,
          timestamp: new Date().toISOString(),
          terrainId: dataset.id,
          seed: dataset.seed,
          directory: dir,
          layers,
        };
        writeFileSync(resolve(dir, 'snapshot.json'), JSON.stringify(manifest, null, 2));
        return ok(req.id, manifest);
      }

      case 'terrain.restoreSnapshot': {
        // Restore a snapshot into the CURRENT dataset (spec §19). Everything
        // is read and validated BEFORE anything is mutated: a checksum
        // mismatch, missing file, layer-set mismatch or size mismatch must
        // leave the live terrain untouched — corrupt snapshots must not load,
        // and must not half-load either.
        requireNoRunningJob('restore a snapshot');
        const dataset = requireDataset();
        const dir = resolve(String(p.directory ?? ''));
        const manifestPath = resolve(dir, 'snapshot.json');
        if (!existsSync(manifestPath)) {
          throw new TerrainError(
            ERROR_CODES.JOB_NOT_FOUND,
            `no snapshot manifest at ${manifestPath}`,
            { directory: dir, manifestPath },
          );
        }
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          sequenceNumber?: number;
          layers?: Array<{
            layerId: string;
            heightFile: string;
            heightSha256: string;
            maskFile: string | null;
            maskSha256: string;
          }>;
        };
        if (!Array.isArray(manifest.layers)) {
          throw new TerrainError(
            ERROR_CODES.VALIDATION_FAILED,
            `snapshot manifest at ${manifestPath} is malformed: no layers array`,
            { manifestPath },
          );
        }

        // Layer ids must match the current dataset exactly — restoring a
        // snapshot of a different site into this one would be silent
        // cross-dataset corruption.
        const current = new Map(dataset.layers.map((l) => [l.id, l]));
        const snapshotIds = manifest.layers.map((e) => e.layerId);
        const missingInDataset = snapshotIds.filter((id) => !current.has(id));
        const missingInSnapshot = [...current.keys()].filter((id) => !snapshotIds.includes(id));
        if (missingInDataset.length > 0 || missingInSnapshot.length > 0) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            'snapshot layers do not match the current dataset: ' +
              `[${missingInDataset.join(', ')}] exist only in the snapshot, ` +
              `[${missingInSnapshot.join(', ')}] only in the dataset`,
            { missingInDataset, missingInSnapshot },
          );
        }

        const mismatches: Array<Record<string, unknown>> = [];
        const staged: Array<{
          layer: TerrainLayer;
          heightBytes: Buffer;
          maskBytes: Buffer | null;
        }> = [];
        for (const entry of manifest.layers) {
          const layer = current.get(entry.layerId)!;
          const heightPath = resolve(dir, entry.heightFile);
          if (!existsSync(heightPath)) {
            mismatches.push({ file: entry.heightFile, problem: 'missing' });
            continue;
          }
          const heightBytes = readFileSync(heightPath);
          const heightActual = sha256(heightBytes);
          if (heightActual !== entry.heightSha256) {
            mismatches.push({
              file: entry.heightFile,
              problem: 'checksum mismatch',
              expectedSha256: entry.heightSha256,
              actualSha256: heightActual,
            });
          }
          if (heightBytes.byteLength !== layer.heightData.byteLength) {
            mismatches.push({
              file: entry.heightFile,
              problem: 'size mismatch',
              expectedBytes: layer.heightData.byteLength,
              actualBytes: heightBytes.byteLength,
            });
          }
          let maskBytes: Buffer | null = null;
          if (entry.maskFile) {
            const maskPath = resolve(dir, entry.maskFile);
            if (!existsSync(maskPath)) {
              mismatches.push({ file: entry.maskFile, problem: 'missing' });
              continue;
            }
            maskBytes = readFileSync(maskPath);
            const maskActual = sha256(maskBytes);
            if (maskActual !== entry.maskSha256) {
              mismatches.push({
                file: entry.maskFile,
                problem: 'checksum mismatch',
                expectedSha256: entry.maskSha256,
                actualSha256: maskActual,
              });
            }
            if (maskBytes.byteLength !== layer.widthSamples * layer.heightSamples) {
              mismatches.push({
                file: entry.maskFile,
                problem: 'size mismatch',
                expectedBytes: layer.widthSamples * layer.heightSamples,
                actualBytes: maskBytes.byteLength,
              });
            }
          }
          staged.push({ layer, heightBytes, maskBytes });
        }
        if (mismatches.length > 0) {
          throw new TerrainError(
            ERROR_CODES.VALIDATION_FAILED,
            `snapshot at ${dir} failed validation against its manifest — ` +
              'a corrupt snapshot must not load; the live dataset is unchanged',
            { directory: dir, mismatches },
          );
        }

        // Commit: byte-copy into the existing typed arrays (avoids any
        // alignment assumption about Node's pooled read buffers), refresh
        // bounds, and reset the edit history — this is a new baseline.
        for (const s of staged) {
          new Uint8Array(
            s.layer.heightData.buffer,
            s.layer.heightData.byteOffset,
            s.layer.heightData.byteLength,
          ).set(s.heightBytes);
          if (s.maskBytes) {
            if (s.layer.masks.semantic) {
              s.layer.masks.semantic.set(s.maskBytes);
            } else {
              s.layer.masks.semantic = Uint8Array.from(s.maskBytes);
            }
          }
          recomputeVerticalBounds(s.layer);
        }
        dataset.bounds.minY = Math.min(...dataset.layers.map((l) => l.bounds.minY));
        dataset.bounds.maxY = Math.max(...dataset.layers.map((l) => l.bounds.maxY));
        session.deltas = [];
        session.operationLog = [];
        session.nextSequence = 0;
        return ok(req.id, {
          directory: dir,
          snapshotSequenceNumber: manifest.sequenceNumber ?? null,
          restoredLayers: staged.length,
          layers: dataset.layers.map((l) => ({
            layerId: l.id,
            heightSha256: layerChecksum(l),
            maskSha256: maskChecksum(l),
          })),
        });
      }

      case 'terrain.getTile': {
        const dataset = requireDataset();
        const layerId = String(p.layerId ?? dataset.layers[0].id);
        const layer = dataset.layers.find((l) => l.id === layerId);
        if (!layer) {
          throw new TerrainError(ERROR_CODES.JOB_NOT_FOUND, `no layer '${layerId}'`, { layerId });
        }
        const col0 = Math.max(0, Math.floor(num(p, 'col0')));
        const row0 = Math.max(0, Math.floor(num(p, 'row0')));
        const w = Math.min(Math.floor(num(p, 'width')), layer.widthSamples - col0);
        const h = Math.min(Math.floor(num(p, 'height')), layer.heightSamples - row0);
        if (w < 1 || h < 1) {
          throw new TerrainError(ERROR_CODES.INVALID_CONFIG, 'requested tile is empty', {
            col0,
            row0,
            width: w,
            height: h,
          });
        }
        // Optional decimation. A 3001² operational layer is 36 MB of float32,
        // which is 48 MB once base64-encoded — far too much to push at a
        // browser for a preview. `stride` lets a viewer ask for every n-th
        // sample and bound the transfer, while a simulation client still
        // requests stride 1 and gets every value.
        const stride = p.stride === undefined ? 1 : Math.max(1, Math.floor(num(p, 'stride')));
        const outW = Math.floor((w - 1) / stride) + 1;
        const outH = Math.floor((h - 1) / stride) + 1;

        const out = new Float32Array(outW * outH);
        for (let r = 0; r < outH; r++) {
          const src = (row0 + r * stride) * layer.widthSamples + col0;
          for (let c = 0; c < outW; c++) {
            out[r * outW + c] = layer.heightData[src + c * stride];
          }
        }
        return ok(req.id, {
          layerId,
          col0,
          row0,
          width: outW,
          height: outH,
          stride,
          // Spacing of the returned samples, which is what a consumer needs to
          // place them; it is not the layer's own resolution when stride > 1.
          resolutionMeters: layer.horizontalResolutionMeters * stride,
          layerResolutionMeters: layer.horizontalResolutionMeters,
          encoding: 'base64:float32le',
          data: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64'),
        });
      }

      case 'terrain.getHeight': {
        const dataset = requireDataset();
        const x = num(p, 'x');
        const z = num(p, 'z');
        const layer = finestLayerAt(dataset, x, z);
        return ok(req.id, {
          x,
          z,
          elevationM: elevationAt(dataset, x, z),
          layerId: layer?.id ?? null,
          datumElevationM: dataset.origin.datumElevationM,
        });
      }

      case 'terrain.getNormal': {
        const dataset = requireDataset();
        const x = num(p, 'x');
        const z = num(p, 'z');
        const layer = finestLayerAt(dataset, x, z);
        if (!layer) return ok(req.id, { x, z, normal: null });
        return ok(req.id, { x, z, normal: normalAtWorld(layer, x, z), layerId: layer.id });
      }

      case 'terrain.getSemanticClass': {
        const dataset = requireDataset();
        const x = num(p, 'x');
        const z = num(p, 'z');
        const layer = finestLayerAt(dataset, x, z);
        if (!layer?.masks.semantic) return ok(req.id, { x, z, semanticClass: null });
        const col = Math.max(
          0,
          Math.min(
            layer.widthSamples - 1,
            Math.round((x - layer.bounds.minX) / layer.horizontalResolutionMeters),
          ),
        );
        const row = Math.max(
          0,
          Math.min(
            layer.heightSamples - 1,
            Math.round((z - layer.bounds.minZ) / layer.horizontalResolutionMeters),
          ),
        );
        const idx = layer.masks.semantic[row * layer.widthSamples + col];
        return ok(req.id, {
          x,
          z,
          semanticClass: SEMANTIC_CLASSES[idx] ?? 'unknown',
          index: idx,
          layerId: layer.id,
        });
      }

      case 'terrain.getTraversability': {
        const dataset = requireDataset();
        const x = num(p, 'x');
        const z = num(p, 'z');
        return ok(req.id, { x, z, traversability: traversabilityAt(dataset, x, z) });
      }

      case 'terrain.getSolar': {
        const dataset = requireDataset();
        const epoch = parseInstant(String(p.epochUtc ?? new Date().toISOString()));
        // Optional local-frame offset: solar elevation is referenced to the
        // observer's own local horizontal, which tilts by ~0.033°/km of
        // offset from the site origin (|p|/R). At grazing polar sun that is
        // not negligible on a kilometres-wide context layer, so a client
        // comparing solar elevation against a horizon computed at (x, z)
        // should ask for the sun at the same offset.
        let siteLat = dataset.origin.site.latitudeDeg;
        let siteLon = dataset.origin.site.longitudeDeg;
        if (p.x !== undefined || p.z !== undefined) {
          const frame = buildLocalFrame(siteLat, siteLon);
          const proj = localToProjected(
            frame,
            p.x !== undefined ? num(p, 'x') : 0,
            p.z !== undefined ? num(p, 'z') : 0,
          );
          const seleno = inverse(proj.x, proj.y);
          siteLat = seleno.latitudeDeg;
          siteLon = seleno.longitudeDeg;
        }
        // Optional mode override: 'ephemeris' (analytic Meeus/IAU, the
        // default — unchanged behaviour for existing clients) or
        // 'ephemeris_de' (JPL DE440 kernels). A missing kernel set is a
        // structured error, never a silent fall-back to the analytic chain.
        const mode = p.mode === undefined ? 'ephemeris' : String(p.mode);
        if (mode !== 'ephemeris' && mode !== 'ephemeris_de') {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            `parameter 'mode' must be 'ephemeris' or 'ephemeris_de', got ${JSON.stringify(p.mode)}`,
          );
        }
        let sp;
        if (mode === 'ephemeris_de') {
          try {
            const kernels = loadDeKernels(
              p.kernelDirectory !== undefined ? String(p.kernelDirectory) : undefined,
            );
            sp = solarPositionAtSiteDE(epoch, siteLat, siteLon, kernels);
          } catch (e) {
            if (e instanceof SpiceKernelError) {
              throw new TerrainError(
                ERROR_CODES.SPICE_KERNELS_UNAVAILABLE,
                `terrain.getSolar mode 'ephemeris_de' failed: ${e.message}`,
                e.toJSON(),
              );
            }
            throw e;
          }
        } else {
          sp = solarPositionAtSite(epoch, siteLat, siteLon);
        }
        return ok(req.id, {
          epochUtc: epoch.toISOString(),
          elevationDeg: sp.elevationDeg,
          azimuthDeg: sp.azimuthDeg,
          angularRadiusDeg: sp.angularRadiusDeg,
          discFractionAboveHorizon: sp.discFractionAboveHorizon,
          subSolar: {
            latitudeDeg: sp.subSolar.latitudeDeg,
            longitudeDeg: sp.subSolar.longitudeDeg,
          },
          site: { latitudeDeg: siteLat, longitudeDeg: siteLon },
          model: mode,
          note:
            'Azimuth is clockwise from north; north is -Z. Elevation is above the geometric ' +
            'horizon of the reference sphere at the queried point and ignores local terrain — ' +
            'use terrain.getHorizon (which measures the skyline from the same local ' +
            'horizontal, since layers carry origin-referenced curvature removal).',
        });
      }

      case 'terrain.getHorizon': {
        const dataset = requireDataset();
        const widest = dataset.layers.reduce((a, b) =>
          a.bounds.maxX - a.bounds.minX >= b.bounds.maxX - b.bounds.minX ? a : b,
        );
        const bins = p.azimuthBins ? Math.floor(num(p, 'azimuthBins')) : 360;
        const sampler = samplerFromArray(
          widest.heightData,
          widest.widthSamples,
          widest.heightSamples,
          widest.horizontalResolutionMeters,
        );
        const cx =
          p.x !== undefined
            ? (num(p, 'x') - widest.bounds.minX) / widest.horizontalResolutionMeters
            : (widest.widthSamples - 1) / 2;
        const cz =
          p.z !== undefined
            ? (num(p, 'z') - widest.bounds.minZ) / widest.horizontalResolutionMeters
            : (widest.heightSamples - 1) / 2;
        const profile = horizonProfile(sampler, cx, cz, { azimuthBins: bins });
        return ok(req.id, {
          layerId: widest.id,
          bins,
          azimuthStepDeg: 360 / bins,
          horizonElevationDeg: Array.from(profile),
          note: 'Curvature is not re-applied; layers are tangent planes with it already removed.',
        });
      }

      case 'terrain.shutdown':
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 50);
        return ok(req.id, { shuttingDown: true });

      default:
        return fail(req.id, RPC_CODES.METHOD_NOT_FOUND, `unhandled method '${req.method}'`);
    }
  } catch (e) {
    return terrainFail(req.id, e);
  }
}

/** Start the sidecar. Resolves once the server is listening. */
export async function startServer(port = 8765): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port });

  server.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        event: 'terrain.hello',
        protocolVersion: PROTOCOL_VERSION,
        generatorVersion: GENERATOR_VERSION,
      }),
    );
    socket.on('message', (data) => {
      void handle(data.toString(), socket, server).then((response) => {
        if (response !== null && socket.readyState === 1) socket.send(response);
      });
    });
  });

  await new Promise<void>((res) => server.once('listening', () => res()));
  console.log(`lunar-terrain sidecar listening on ws://127.0.0.1:${port}`);
  console.log(`protocol ${PROTOCOL_VERSION}, generator ${GENERATOR_VERSION}`);
  console.log('bound to loopback only: this service reads and writes client-supplied paths.');
  return server;
}
