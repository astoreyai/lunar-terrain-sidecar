/**
 * The Godot sidecar service (spec §16).
 *
 * JSON-RPC 2.0 over WebSocket on `ws://127.0.0.1:8768` by default. Generation
 * runs as a cancellable job with progress notifications; every failure is a
 * structured error carrying a machine-readable code (spec §28).
 *
 * Bound to the loopback interface only. This service reads and writes arbitrary
 * filesystem paths supplied by its client, so exposing it on a routable address
 * would be handing out a remote file-write primitive.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import {
  closeSync,
  constants as FS_CONSTANTS,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ERROR_CODES,
  ELEVATION_SOURCES,
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
  type TerrainFeature,
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
  ROCK_TRANSFER_ENCODING,
  RPC_CODES,
  SPARSE_SAMPLE_CAP,
  type JobRecord,
  type JsonRpcRequest,
  type TerrainBaselineMetadata,
  type TerrainDelta,
  type TerrainOperation,
} from '@lts/terrain-protocol';
import {
  buildLocalFrame,
  localToProjected,
  inverse,
  openPdsRaster,
  farFieldHorizon,
  type DemRaster,
  type PolarStereographicParams,
} from '@lts/lunar-dem';
import {
  LUNAR_REGOLITH_PARAMETERS,
  REFERENCE_VEHICLE,
  TERRAMECHANICS_PROVENANCE,
  assessAt,
} from '@lts/lunar-terramech';
import {
  horizonProfile,
  samplerFromArray,
  sampleBilinear,
  LUNAR_REFERENCE_RADIUS_M,
  solarPositionAtSite,
  solarPositionAtSiteDE,
  loadDeKernels,
  parseInstant,
  SpiceKernelError,
} from '@lts/lunar-solar';
import { applyOperation, layerChecksum, makeDelta, maskChecksum } from './operations.js';

/** Convert dataset-local metres to the source DEM's declared selenographic frame. */
export function datasetLocalToSelenographic(
  dataset: TerrainDataset,
  localX: number,
  localZ: number,
): { latitudeDeg: number; longitudeDeg: number } {
  const metadata = dataset.coordinateSystem.source_projection;
  const projection: PolarStereographicParams | undefined = metadata
    ? {
        hemisphere: metadata.latitudeOfOriginDeg < 0 ? -1 : 1,
        centralMeridianDeg: metadata.centralMeridianDeg,
        scaleFactor: metadata.scaleFactor,
        falseEastingM: metadata.falseEastingM,
        falseNorthingM: metadata.falseNorthingM,
        radiusM: metadata.bodyRadiusM,
      }
    : undefined;
  const frame = buildLocalFrame(
    dataset.origin.site.latitudeDeg,
    dataset.origin.site.longitudeDeg,
    projection,
  );
  if (metadata) {
    frame.originProjectedX = metadata.originEastingM;
    frame.originProjectedY = metadata.originNorthingM;
  }
  const projected = localToProjected(
    frame,
    localX - dataset.origin.local.x,
    localZ - dataset.origin.local.z,
  );
  return inverse(projected.x, projected.y, projection);
}

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
  /**
   * Regolith bulk density from the generating config (`bulkDensityKgM3`,
   * default 1500): construction-feature mass records use it. Previously a
   * hard-coded local, which silently ignored the config field.
   */
  bulkDensityKgM3: number;
  /**
   * Monotonic identity of the installed world lineage. Generation and snapshot
   * restore both increment it; unlike sequence numbers it is NEVER rewound.
   * Live clients bind `(datasetRevision, sequenceNumber)` so a restored branch
   * cannot reuse an old sync identity silently.
   */
  datasetRevision: number;
  /** Precomputed current checksums make the live handshake O(layers), not O(samples). */
  layerHeads: Record<string, { heightSha256: string; maskSha256: string }>;
  /** Complete server-authored baseline, refreshed only when installed state changes. */
  baseline?: TerrainBaselineMetadata;
  /** Collision-free deterministic snapshot directory suffix within this process. */
  snapshotCounter: number;
}

const jobs = new Map<string, JobRecord>();
const cancelFlags = new Map<string, { aborted: boolean }>();
const session: Session = {
  tileSizeSamples: 256,
  deltas: [],
  operationLog: [],
  nextSequence: 0,
  bulkDensityKgM3: 1500,
  datasetRevision: 0,
  layerHeads: {},
  snapshotCounter: 0,
};
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
 * Browser-origin policy for this path-capable local service.
 *
 * A loopback bind prevents remote TCP clients, but it does not prevent a page
 * on an unrelated website from opening ws://127.0.0.1 and issuing JSON-RPC
 * calls. Native clients (Godot, scripts) do not send Origin and remain
 * supported; browser clients must themselves have been served from loopback.
 */
function allowedClientOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Bound request memory before JSON parsing; tile payloads are server-to-client. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Where the LOLA LDEM_75S label lives when the caller does not say (ADR 0006).
 * Checked in order; `scripts/fetch-data.sh` populates the first, and the
 * second is this machine's pre-existing read-only reference copy.
 */
const LDEM_75S_CANDIDATES = [
  '/mnt/projects/datasets/lola_ldem/ldem_75s_120m.lbl',
  '/mnt/projects/stewie/data/gis/raw/ldem_75s_120m.lbl',
];
const DEFAULT_LDEM_75S_LABEL =
  LDEM_75S_CANDIDATES.find((p) => existsSync(p)) ?? LDEM_75S_CANDIDATES[0];

/**
 * Where the PGDA Site01 5 m/px DEM lives, for clients that cannot read the
 * environment (the browser UI). `LTS_SITE01_DEM` wins; the fallback is the
 * development machine's dataset store, and `scripts/fetch-data.sh` prints the
 * export line for a fresh checkout. Reported only if the file exists — a
 * client is never handed a path that generation would reject.
 */
const DEFAULT_SITE01_DEM = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';
function resolveSite01Dem(): {
  site01DemPath: string | null;
  site01DemSource: 'env:LTS_SITE01_DEM' | 'default' | 'none';
} {
  const fromEnv = process.env.LTS_SITE01_DEM;
  if (fromEnv && existsSync(fromEnv)) {
    return { site01DemPath: fromEnv, site01DemSource: 'env:LTS_SITE01_DEM' };
  }
  if (existsSync(DEFAULT_SITE01_DEM)) {
    return { site01DemPath: DEFAULT_SITE01_DEM, site01DemSource: 'default' };
  }
  return { site01DemPath: null, site01DemSource: 'none' };
}

/**
 * One raster handle per label path. The handle holds the parsed label only —
 * elevation windows are read per call — so this caches label parsing, not
 * 116 MB of pixels.
 */
const farFieldRasters = new Map<string, DemRaster>();
function openFarFieldRaster(labelPath: string): DemRaster {
  const cached = farFieldRasters.get(labelPath);
  if (cached) return cached;
  const raster = openPdsRaster(labelPath);
  farFieldRasters.set(labelPath, raster);
  return raster;
}

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
    rocksReseated: d.rocksReseated,
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
  const current = session.deltas.filter(
    (delta) => delta.datasetRevision === session.datasetRevision,
  );
  const oldest = current.length > 0 ? current[0].sequenceNumber : head;
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

function datasetRevisionParam(p: Record<string, unknown>, required: boolean): number | null {
  if (p.datasetRevision === undefined && !required) return null;
  const revision = num(p, 'datasetRevision');
  if (!Number.isInteger(revision) || revision < 1) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      "parameter 'datasetRevision' must be a positive integer",
      { datasetRevision: revision },
    );
  }
  return revision;
}

function revisionMismatchError(requestedRevision: number): TerrainError {
  return new TerrainError(
    ERROR_CODES.VALIDATION_FAILED,
    `dataset revision ${requestedRevision} is stale; current revision is ${session.datasetRevision} — ` +
      'perform a checksum-validated full resync',
    {
      reason: 'revision_mismatch',
      requestedRevision,
      currentRevision: session.datasetRevision,
      headSequence: session.nextSequence,
    },
  );
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

const SNAPSHOT_VERSION = 2;
const MAX_SNAPSHOT_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_STATE_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_BLOB_BYTES = 2 * 1024 * 1024 * 1024;

type SnapshotEncoding = 'float32le' | 'uint8';

interface SnapshotBlob {
  file: string;
  sha256: string;
  bytes: number;
  encoding: SnapshotEncoding;
}

interface SnapshotLayer {
  layerId: string;
  widthSamples: number;
  heightSamples: number;
  heightFile: string;
  heightSha256: string;
  heightBytes: number;
  maskFile: string | null;
  maskSha256: string;
  masks: {
    semantic: SnapshotBlob | null;
    disturbance: SnapshotBlob | null;
    elevationSource: SnapshotBlob | null;
  };
}

interface SnapshotState {
  /** Canonical immutable scientific/configuration identity (generatedAt excluded). */
  datasetIdentity: Record<string, unknown>;
  sessionSettings: {
    tileSizeSamples: number;
    bulkDensityKgM3: number;
  };
  /** Revision on which the retained deltas were originally emitted. */
  datasetRevision: number;
  featureManifest: TerrainFeature[];
  operationLog: TerrainOperation[];
  deltas: TerrainDelta[];
  nextSequence: number;
}

interface SnapshotManifest {
  snapshotVersion: number;
  sequenceNumber: number;
  timestamp: string;
  terrainId: string;
  seed: string;
  directory: string;
  stateFile: string;
  stateSha256: string;
  stateBytes: number;
  layers: SnapshotLayer[];
}

/**
 * Immutable identity required to interpret the mutable snapshot bytes. The
 * generation timestamp is deliberately excluded: it is not scientific input,
 * while the configuration hash, source hashes, frame, origin and layer model
 * are. Keeping this as plain JSON also makes the checksummed state portable.
 */
function snapshotDatasetIdentity(dataset: TerrainDataset): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...provenance } = dataset.provenance;
  return {
    terrainId: dataset.id,
    version: dataset.version,
    seed: dataset.seed,
    boundsXZ: {
      minX: dataset.bounds.minX,
      minZ: dataset.bounds.minZ,
      maxX: dataset.bounds.maxX,
      maxZ: dataset.bounds.maxZ,
    },
    origin: dataset.origin,
    coordinateSystem: dataset.coordinateSystem,
    layers: dataset.layers.map((layer) => ({
      id: layer.id,
      role: layer.role,
      boundsXZ: {
        minX: layer.bounds.minX,
        minZ: layer.bounds.minZ,
        maxX: layer.bounds.maxX,
        maxZ: layer.bounds.maxZ,
      },
      horizontalResolutionMeters: layer.horizontalResolutionMeters,
      verticalQuantizationMeters: layer.verticalQuantizationMeters,
      widthSamples: layer.widthSamples,
      heightSamples: layer.heightSamples,
      elevationProvenance: layer.elevationProvenance,
      sourceEffectiveResolutionMeters: layer.sourceEffectiveResolutionMeters ?? null,
    })),
    provenance,
  };
}

/** JSON canonicalisation used only as input to opaque server-authored hashes. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const ROCK_TRANSFER_DIGEST_PREFIX = Buffer.from('LTS_ROCK_TRANSFER_V1\0', 'ascii');

function sortedRockFeatures(dataset: TerrainDataset): RockFeature[] {
  return dataset.featureManifest
    .filter((feature): feature is RockFeature => feature.kind === 'rock')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Encode the exact physics-bearing subset transferred by terrain.getRocks. */
function rockTransferBytes(rocks: readonly RockFeature[]): Buffer {
  const chunks: Buffer[] = [ROCK_TRANSFER_DIGEST_PREFIX];
  const count = Buffer.allocUnsafe(4);
  count.writeUInt32LE(rocks.length);
  chunks.push(count);
  for (const rock of rocks) {
    const id = Buffer.from(rock.id, 'utf8');
    const idLength = Buffer.allocUnsafe(4);
    idLength.writeUInt32LE(id.length);
    chunks.push(idLength, id);
    const transform = Buffer.allocUnsafe(10 * 8 + 1);
    const values = [
      rock.position.x,
      rock.position.y,
      rock.position.z,
      ...rock.rotationQuaternion,
      rock.scale.x,
      rock.scale.y,
      rock.scale.z,
    ];
    for (let index = 0; index < values.length; index++) {
      transform.writeDoubleLE(values[index], index * 8);
    }
    transform.writeUInt8(rock.physical ? 1 : 0, 10 * 8);
    chunks.push(transform);
  }
  return Buffer.concat(chunks);
}

function rockTransferSha256(rocks: readonly RockFeature[]): string {
  return sha256(rockTransferBytes(rocks));
}

function arrayViewSha256(view: ArrayBufferView | undefined): string | null {
  if (!view) return null;
  return sha256(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
}

/**
 * Complete baseline identity for native consumers. This deliberately includes
 * channels that live sync does not mutate (disturbance and elevation source)
 * and all rock collision/seating properties; terrainId+seed and height alone
 * cannot prove that an imported physics world is the installed world.
 */
function terrainBaselineMetadata(
  dataset: TerrainDataset,
  layerHeads = currentLayerHeads(dataset),
  invariantBaseline?: TerrainBaselineMetadata,
): TerrainBaselineMetadata {
  const immutableIdentitySha256 =
    invariantBaseline?.immutableIdentitySha256 ??
    sha256(Buffer.from(canonicalJson(snapshotDatasetIdentity(dataset))));
  const previousLayer = new Map(
    (invariantBaseline?.layers ?? []).map((layer) => [layer.layerId, layer]),
  );
  const layers = dataset.layers.map((layer) => ({
    layerId: layer.id,
    heightSha256: layerHeads[layer.id]?.heightSha256 ?? layerChecksum(layer),
    semanticSha256: layerHeads[layer.id]?.maskSha256 ?? maskChecksum(layer),
    disturbanceSha256:
      previousLayer.get(layer.id)?.disturbanceSha256 ?? arrayViewSha256(layer.masks.disturbance),
    elevationSourceSha256:
      previousLayer.get(layer.id)?.elevationSourceSha256 ??
      arrayViewSha256(layer.masks.elevationSource),
  }));
  const rocks = sortedRockFeatures(dataset);
  const rockPhysics = rocks.map((rock) => ({
    id: rock.id,
    appliedToLayers: rock.appliedToLayers,
    affectedBounds: rock.affectedBounds,
    seedChannel: rock.seedChannel ?? null,
    position: rock.position,
    rotationQuaternion: rock.rotationQuaternion,
    scale: rock.scale,
    physical: rock.physical,
    buriedFraction: rock.buriedFraction,
    angularity: rock.angularity,
    material: rock.material,
    semanticClass: rock.semanticClass,
  }));
  const rockSummary = {
    totalCount: rocks.length,
    physicalCount: rocks.filter((rock) => rock.physical).length,
    physicsSha256: sha256(Buffer.from(canonicalJson(rockPhysics))),
    transferSha256: rockTransferSha256(rocks),
  };
  const state = {
    schemaVersion: 1 as const,
    immutableIdentitySha256,
    layers,
    rocks: rockSummary,
  };
  return {
    ...state,
    worldStateSha256: sha256(Buffer.from(canonicalJson(state))),
  };
}

function currentTerrainBaseline(dataset: TerrainDataset): TerrainBaselineMetadata {
  session.baseline ??= terrainBaselineMetadata(dataset, session.layerHeads);
  return session.baseline;
}

function currentLayerHeads(
  dataset: TerrainDataset,
): Record<string, { heightSha256: string; maskSha256: string }> {
  return Object.fromEntries(
    dataset.layers.map((layer) => [
      layer.id,
      { heightSha256: layerChecksum(layer), maskSha256: maskChecksum(layer) },
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validSnapshotBlob(value: unknown, encoding: SnapshotEncoding): value is SnapshotBlob {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    value.file.length > 0 &&
    isSha256(value.sha256) &&
    Number.isInteger(value.bytes) &&
    (value.bytes as number) >= 0 &&
    value.encoding === encoding
  );
}

function finiteBounds(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.minX) &&
    isFiniteNumber(value.minZ) &&
    isFiniteNumber(value.maxX) &&
    isFiniteNumber(value.maxZ) &&
    value.minX <= value.maxX &&
    value.minZ <= value.maxZ
  );
}

function finiteVector3(value: unknown): boolean {
  return (
    isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
  );
}

/**
 * Elevation statistics are audit records, not exact invariants: `mean` is a
 * running double sum over up to millions of Float32 samples, so on a perfectly
 * flat footprint (a pad that is then cut) it can land a few ulps outside the
 * degenerate [min, max] interval. Accept the server's own records with a
 * tolerance far below any physical meaning (1 µm at metre scale) while still
 * rejecting statistics that are inconsistent by more than summation error.
 */
const STATS_MEAN_TOLERANCE = 1e-6;
function finiteStats(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.min) ||
    !isFiniteNumber(value.max) ||
    !isFiniteNumber(value.mean) ||
    value.min > value.max
  ) {
    return false;
  }
  const tolerance =
    STATS_MEAN_TOLERANCE * Math.max(1, Math.abs(value.min), Math.abs(value.max));
  return value.mean >= value.min - tolerance && value.mean <= value.max + tolerance;
}

function snapshotFilePath(directory: string, file: unknown): string | null {
  if (typeof file !== 'string' || file.length === 0) return null;
  const path = resolve(directory, file);
  const rel = relative(directory, path);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    isAbsolute(rel)
  ) {
    return null;
  }
  return path;
}

type SnapshotFileRead =
  | { ok: true; path: string; bytes: Buffer }
  | { ok: false; path: string | null; problem: string; actualBytes?: number };

/**
 * Race-resistant, bounded snapshot read. A lexical in-tree path is not enough:
 * every component is resolved, the final entry must be a regular non-symlink,
 * the open uses O_NOFOLLOW, and size is checked before allocation/read.
 */
function readSnapshotFileBounded(
  directoryReal: string,
  file: unknown,
  maxBytes: number,
  expectedBytes?: number,
): SnapshotFileRead {
  const path = snapshotFilePath(directoryReal, file);
  if (!path) return { ok: false, path: null, problem: 'path escapes snapshot directory' };
  try {
    const linkStat = lstatSync(path);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      return { ok: false, path, problem: 'not a regular non-symlink file' };
    }
    const resolvedPath = realpathSync(path);
    const rel = relative(directoryReal, resolvedPath);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      return { ok: false, path, problem: 'resolved path escapes snapshot directory' };
    }

    const fd = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { ok: false, path, problem: 'not a regular file' };
      if (stat.size > maxBytes) {
        return { ok: false, path, problem: 'file exceeds snapshot read limit', actualBytes: stat.size };
      }
      if (expectedBytes !== undefined && stat.size !== expectedBytes) {
        return { ok: false, path, problem: 'size mismatch', actualBytes: stat.size };
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== bytes.byteLength) {
        return { ok: false, path, problem: 'short read', actualBytes: offset };
      }
      const extra = Buffer.alloc(1);
      if (readSync(fd, extra, 0, 1, offset) !== 0) {
        return { ok: false, path, problem: 'file grew during read', actualBytes: offset + 1 };
      }
      return { ok: true, path, bytes };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return {
      ok: false,
      path,
      problem: existsSync(path) ? `file could not be read safely: ${String(error)}` : 'missing',
    };
  }
}

/** Exclusive no-follow write used only inside a newly-created snapshot temp dir. */
function writeSnapshotFileExclusive(directory: string, file: string, bytes: Buffer): void {
  const path = snapshotFilePath(directory, file);
  if (!path) throw new Error(`invalid snapshot file name '${file}'`);
  const fd = openSync(
    path,
    FS_CONSTANTS.O_WRONLY |
      FS_CONSTANTS.O_CREAT |
      FS_CONSTANTS.O_EXCL |
      FS_CONSTANTS.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function validOperation(value: unknown, layerIds: Set<string>): value is TerrainOperation {
  if (!isRecord(value)) return false;
  if (
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    !(OPERATION_KINDS as readonly unknown[]).includes(value.kind) ||
    typeof value.layerId !== 'string' ||
    !layerIds.has(value.layerId) ||
    !isFiniteNumber(value.centerXMeters) ||
    !isFiniteNumber(value.centerZMeters) ||
    !isFiniteNumber(value.radiusMeters) ||
    value.radiusMeters <= 0 ||
    !isFiniteNumber(value.strengthMeters) ||
    !isFiniteNumber(value.falloff) ||
    value.falloff <= 0 ||
    typeof value.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(value.timestamp))
  ) {
    return false;
  }
  for (const name of ['targetElevationMeters', 'headingDegrees', 'lengthMeters'] as const) {
    if (value[name] !== undefined && !isFiniteNumber(value[name])) return false;
  }
  if (
    value.lengthMeters !== undefined &&
    (!isFiniteNumber(value.lengthMeters) || value.lengthMeters <= 0)
  ) {
    return false;
  }
  if (value.massConserving !== undefined && typeof value.massConserving !== 'boolean') return false;
  if (
    value.noiseSeed !== undefined &&
    (typeof value.noiseSeed !== 'string' || value.noiseSeed.length === 0)
  ) {
    return false;
  }
  if (
    value.semanticClass !== undefined &&
    (typeof value.semanticClass !== 'string' ||
      !(SEMANTIC_CLASSES as readonly string[]).includes(value.semanticClass))
  ) {
    return false;
  }
  if (value.polygonXZ !== undefined) {
    if (
      !Array.isArray(value.polygonXZ) ||
      value.polygonXZ.length < 3 ||
      value.polygonXZ.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          !isFiniteNumber(point[0]) ||
          !isFiniteNumber(point[1]),
      )
    ) {
      return false;
    }
  }
  switch (value.kind) {
    case 'flatten':
      if (!isFiniteNumber(value.targetElevationMeters)) return false;
      break;
    case 'slope':
      if (!isFiniteNumber(value.headingDegrees)) return false;
      break;
    case 'noise':
      if (typeof value.noiseSeed !== 'string' || value.noiseSeed.length === 0) return false;
      break;
    case 'semantic_paint':
      if (
        typeof value.semanticClass !== 'string' ||
        !(SEMANTIC_CLASSES as readonly string[]).includes(value.semanticClass)
      ) {
        return false;
      }
      break;
    case 'ramp':
      if (
        !isFiniteNumber(value.targetElevationMeters) ||
        !isFiniteNumber(value.headingDegrees) ||
        !isFiniteNumber(value.lengthMeters) ||
        value.lengthMeters <= 0
      ) {
        return false;
      }
      break;
    case 'pad':
      if (!isFiniteNumber(value.targetElevationMeters)) return false;
      if (
        value.lengthMeters !== undefined &&
        !isFiniteNumber(value.headingDegrees)
      ) {
        return false;
      }
      break;
    case 'wheel_track':
      if (
        !isFiniteNumber(value.headingDegrees) ||
        !isFiniteNumber(value.lengthMeters) ||
        value.lengthMeters <= 0
      ) {
        return false;
      }
      break;
    case 'trench':
    case 'berm':
      if (
        !isFiniteNumber(value.headingDegrees) ||
        !isFiniteNumber(value.lengthMeters) ||
        value.lengthMeters <= 0
      ) {
        return false;
      }
      break;
    case 'polygonal_cut':
    case 'polygonal_fill':
      if (
        !isFiniteNumber(value.targetElevationMeters) ||
        !Array.isArray(value.polygonXZ) ||
        value.polygonXZ.length < 3
      ) {
        return false;
      }
      break;
  }
  return true;
}

const CONSTRUCTION_FEATURE_KINDS = new Set([
  'berm',
  'trench',
  'ramp',
  'pad',
  'excavation',
  'spoil_pile',
  'graded_slope',
  'wheel_track',
  'polygonal_cut',
  'polygonal_fill',
]);

const CONSTRUCTION_OPERATION_SEMANTIC: Partial<
  Record<TerrainOperation['kind'], string>
> = {
  trench: 'trench',
  berm: 'berm',
  ramp: 'compacted_surface',
  pad: 'compacted_surface',
  spoil_pile: 'berm',
  wheel_track: 'disturbed_regolith',
  polygonal_cut: 'trench',
  polygonal_fill: 'berm',
};

function validFeature(value: unknown, layerIds: Set<string>): value is TerrainFeature {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.kind !== 'string' ||
    !Array.isArray(value.appliedToLayers) ||
    value.appliedToLayers.length === 0 ||
    value.appliedToLayers.some((id) => typeof id !== 'string' || !layerIds.has(id)) ||
    new Set(value.appliedToLayers).size !== value.appliedToLayers.length ||
    !finiteBounds(value.affectedBounds) ||
    (value.seedChannel !== undefined && typeof value.seedChannel !== 'string')
  ) {
    return false;
  }

  if (value.kind === 'rock') {
    if (
      !finiteVector3(value.position) ||
      !Array.isArray(value.rotationQuaternion) ||
      value.rotationQuaternion.length !== 4 ||
      !value.rotationQuaternion.every(isFiniteNumber) ||
      !finiteVector3(value.scale) ||
      typeof value.physical !== 'boolean' ||
      !isFiniteNumber(value.buriedFraction) ||
      value.buriedFraction < 0 ||
      value.buriedFraction > 1 ||
      !isFiniteNumber(value.angularity) ||
      value.angularity < 0 ||
      value.angularity > 1 ||
      typeof value.material !== 'string' ||
      typeof value.semanticClass !== 'string'
    ) {
      return false;
    }
    const scale = value.scale as { x: number; y: number; z: number };
    if (scale.x <= 0 || scale.y <= 0 || scale.z <= 0) return false;
    const quaternion = value.rotationQuaternion as number[];
    return Math.abs(Math.hypot(...quaternion) - 1) <= 1e-6;
  }

  if (value.kind === 'crater') {
    if (!isRecord(value.parameters)) return false;
    const parameters = value.parameters;
    const numeric = [
      'centerXMeters',
      'centerZMeters',
      'diameterMeters',
      'depthMeters',
      'rimHeightMeters',
      'rimWidthMeters',
      'floorRadiusRatio',
      'ellipticity',
      'rotationRadians',
      'degradation',
      'ejectaExtentMeters',
      'ejectaAmplitudeMeters',
    ];
    if (
      !numeric.every((name) => isFiniteNumber(parameters[name])) ||
      typeof parameters.centralPeak !== 'boolean' ||
      (value.origin !== 'production_csfd' && value.origin !== 'authored')
    ) {
      return false;
    }
    const craterParameters = parameters as unknown as Extract<
      TerrainFeature,
      { kind: 'crater' }
    >['parameters'];
    return (
      craterParameters.diameterMeters > 0 &&
      craterParameters.depthMeters >= 0 &&
      craterParameters.rimHeightMeters >= 0 &&
      craterParameters.rimWidthMeters > 0 &&
      craterParameters.floorRadiusRatio >= 0 &&
      craterParameters.floorRadiusRatio <= 1 &&
      craterParameters.ellipticity > 0 &&
      craterParameters.ellipticity <= 1 &&
      craterParameters.degradation >= 0 &&
      craterParameters.degradation <= 1 &&
      craterParameters.ejectaExtentMeters >= 0 &&
      craterParameters.ejectaAmplitudeMeters >= 0
    );
  }

  if (!CONSTRUCTION_FEATURE_KINDS.has(value.kind)) return false;
  if (!isRecord(value.parameters) || !isRecord(value.massBalance)) return false;
  const massBalance = value.massBalance;
  for (const parameter of Object.values(value.parameters)) {
    if (!(
      typeof parameter === 'string' ||
      typeof parameter === 'boolean' ||
      isFiniteNumber(parameter) ||
      (Array.isArray(parameter) && parameter.every(isFiniteNumber))
    )) {
      return false;
    }
  }
  if (
    ![
      'removedVolumeM3',
      'depositedVolumeM3',
      'netVolumeM3',
      'relativeError',
      'bulkDensityKgM3',
      'netMassKg',
    ].every((name) => isFiniteNumber(massBalance[name])) ||
    !finiteStats(value.elevationBefore) ||
    !finiteStats(value.elevationAfter) ||
    typeof value.semanticClass !== 'string' ||
    !(SEMANTIC_CLASSES as readonly string[]).includes(value.semanticClass)
  ) {
    return false;
  }
  const removed = massBalance.removedVolumeM3 as number;
  const deposited = massBalance.depositedVolumeM3 as number;
  const net = massBalance.netVolumeM3 as number;
  const relativeError = massBalance.relativeError as number;
  const bulkDensity = massBalance.bulkDensityKgM3 as number;
  const netMass = massBalance.netMassKg as number;
  const scale = Math.max(removed, deposited);
  return (
    removed >= 0 &&
    deposited >= 0 &&
    net === deposited - removed &&
    relativeError === (scale > 0 ? Math.abs(net) / scale : 0) &&
    relativeError >= 0 &&
    relativeError <= 1 &&
    bulkDensity > 0 &&
    netMass === net * bulkDensity
  );
}

function sameNumberArray(value: unknown, expected: number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

/**
 * A construction feature is the measured audit record of one operation, not
 * an independent editable claim. Bind the two halves so a re-hashed snapshot
 * cannot alter geometry/provenance while retaining valid scalar types.
 */
function constructionAuditProblems(
  features: TerrainFeature[],
  operations: TerrainOperation[],
  deltas: TerrainDelta[],
  bulkDensityKgM3: number,
): string[] {
  const problems: string[] = [];
  const operationById = new Map<string, TerrainOperation>();
  for (const operation of operations) {
    if (operationById.has(operation.operationId)) {
      problems.push(`operationLog contains duplicate operation id '${operation.operationId}'`);
    }
    operationById.set(operation.operationId, operation);
  }
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const deltaByOperationId = new Map(
    deltas.map((delta) => [delta.operations[0].operationId, delta]),
  );

  for (const operation of operations) {
    const semanticClass = CONSTRUCTION_OPERATION_SEMANTIC[operation.kind];
    if (semanticClass === undefined) continue;
    const featureId = `construction-${operation.operationId}`;
    const feature = featureById.get(featureId);
    if (!feature || feature.kind === 'rock' || feature.kind === 'crater') {
      problems.push(`construction operation '${operation.operationId}' has no matching feature`);
      continue;
    }
    if (
      feature.kind !== operation.kind ||
      feature.appliedToLayers.length !== 1 ||
      feature.appliedToLayers[0] !== operation.layerId ||
      feature.semanticClass !== semanticClass
    ) {
      problems.push(`construction feature '${feature.id}' does not match its operation identity`);
      continue;
    }

    const parameters = feature.parameters;
    const requiredParameters: Array<[string, unknown]> = [
      ['centerXMeters', operation.centerXMeters],
      ['centerZMeters', operation.centerZMeters],
      ['radiusMeters', operation.radiusMeters],
      ['strengthMeters', operation.strengthMeters],
      ['falloff', operation.falloff],
      ['massConserving', operation.massConserving ?? false],
    ];
    let parameterMismatch = requiredParameters.some(
      ([name, expected]) => parameters[name] !== expected,
    );
    for (const name of ['targetElevationMeters', 'headingDegrees', 'lengthMeters'] as const) {
      if (parameters[name] !== operation[name]) parameterMismatch = true;
    }
    if (operation.polygonXZ === undefined) {
      if (
        parameters.polygonXZFlat !== undefined ||
        parameters.polygonVertexCount !== undefined
      ) {
        parameterMismatch = true;
      }
    } else if (
      parameters.polygonVertexCount !== operation.polygonXZ.length ||
      !sameNumberArray(parameters.polygonXZFlat, operation.polygonXZ.flat())
    ) {
      parameterMismatch = true;
    }
    if (parameterMismatch) {
      problems.push(`construction feature '${feature.id}' parameters diverge from its operation`);
    }

    if (feature.massBalance.bulkDensityKgM3 !== bulkDensityKgM3) {
      problems.push(`construction feature '${feature.id}' uses a different bulk density`);
    }
    const delta = deltaByOperationId.get(operation.operationId);
    if (
      delta &&
      (feature.massBalance.removedVolumeM3 !== delta.massBalance.removedVolumeM3 ||
        feature.massBalance.depositedVolumeM3 !== delta.massBalance.depositedVolumeM3 ||
        feature.massBalance.netVolumeM3 !== delta.massBalance.netVolumeM3 ||
        feature.massBalance.relativeError !== delta.massBalance.relativeError)
    ) {
      problems.push(`construction feature '${feature.id}' mass balance diverges from its delta`);
    }
  }

  for (const feature of features) {
    if (feature.kind === 'rock' || feature.kind === 'crater') continue;
    if (!feature.id.startsWith('construction-')) {
      problems.push(`construction feature '${feature.id}' has no operation-derived identity`);
      continue;
    }
    const operationId = feature.id.slice('construction-'.length);
    const operation = operationById.get(operationId);
    if (!operation || CONSTRUCTION_OPERATION_SEMANTIC[operation.kind] === undefined) {
      problems.push(`construction feature '${feature.id}' has no matching operation`);
    }
  }

  return problems;
}

function decodeCanonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function validSparseIndices(bytes: Buffer, count: number, layerSamples: number): boolean {
  if (bytes.byteLength !== count * 4) return false;
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const index = bytes.readUInt32LE(i * 4);
    if (index >= layerSamples || index <= previous) return false;
    previous = index;
  }
  return true;
}

/**
 * Validate rock state against the staged heightfields before snapshot commit.
 * Structural finiteness is insufficient: a finite transform can still create
 * an unbounded collider, place it outside its declared terrain, or float it
 * wholly above the restored surface.
 */
function restoredRockPhysicsProblems(
  features: TerrainFeature[],
  stagedDataset: TerrainDataset,
): Array<Record<string, unknown>> {
  const problems: Array<Record<string, unknown>> = [];
  const layerById = new Map(stagedDataset.layers.map((layer) => [layer.id, layer]));
  // Match the native loader's conservative vertical sanity volume: no rock
  // centre may sit more than the largest declared horizontal terrain extent
  // below its local surface. This is deliberately a broad corruption bound,
  // not a claim about physical burial depth.
  const terrainExtentMeters = Math.max(
    ...stagedDataset.layers.flatMap((layer) => [
      layer.bounds.maxX - layer.bounds.minX,
      layer.bounds.maxZ - layer.bounds.minZ,
    ]),
  );
  for (const feature of features) {
    if (feature.kind !== 'rock') continue;
    const rock = feature as RockFeature;
    const declaredLayers = rock.appliedToLayers
      .map((id) => layerById.get(id))
      .filter((layer): layer is TerrainLayer => layer !== undefined);
    const coveringLayers = declaredLayers.filter(
      (layer) =>
        rock.position.x >= layer.bounds.minX &&
        rock.position.x <= layer.bounds.maxX &&
        rock.position.z >= layer.bounds.minZ &&
        rock.position.z <= layer.bounds.maxZ,
    );
    if (coveringLayers.length === 0) {
      problems.push({
        featureId: rock.id,
        problem: 'rock centre is outside its declared layer coverage',
      });
      continue;
    }

    // A semi-axis larger than the entire largest covering footprint is not a
    // terrain rock/collider. This contextual cap avoids an arbitrary global
    // metre limit while accepting every scale the declared terrain can host.
    const maximumCoverageSpan = Math.max(
      ...coveringLayers.flatMap((layer) => [
        layer.bounds.maxX - layer.bounds.minX,
        layer.bounds.maxZ - layer.bounds.minZ,
      ]),
    );
    if (
      rock.scale.x > maximumCoverageSpan ||
      rock.scale.y > maximumCoverageSpan ||
      rock.scale.z > maximumCoverageSpan
    ) {
      problems.push({
        featureId: rock.id,
        problem: 'rock scale exceeds its declared layer coverage',
        maximumCoverageSpan,
      });
      continue;
    }

    const ground = elevationAt(stagedDataset, rock.position.x, rock.position.z);
    if (!Number.isFinite(ground)) {
      problems.push({ featureId: rock.id, problem: 'rock has no staged terrain surface' });
    } else if (rock.position.y - rock.scale.y > ground + 1e-3) {
      problems.push({
        featureId: rock.id,
        problem: 'rock is entirely floating above the staged terrain',
        lowestRockY: rock.position.y - rock.scale.y,
        groundY: ground,
      });
    } else if (rock.position.y < ground - terrainExtentMeters) {
      problems.push({
        featureId: rock.id,
        problem: 'rock centre lies below the bounded terrain volume',
        rockCenterY: rock.position.y,
        minimumRockCenterY: ground - terrainExtentMeters,
        groundY: ground,
        terrainExtentMeters,
      });
    }
  }
  return problems;
}

function validDelta(
  value: unknown,
  layerSamplesById: Map<string, number>,
): value is TerrainDelta {
  if (!isRecord(value)) return false;
  const layerIds = new Set(layerSamplesById.keys());
  const massBalance = value.massBalance;
  if (
    typeof value.deltaId !== 'string' ||
    !Number.isInteger(value.datasetRevision) ||
    (value.datasetRevision as number) < 1 ||
    !Number.isInteger(value.sequenceNumber) ||
    (value.sequenceNumber as number) < 0 ||
    typeof value.timestamp !== 'string' ||
    !finiteBounds(value.affectedBounds) ||
    !Array.isArray(value.changedTiles) ||
    value.changedTiles.some((tile) => typeof tile !== 'string') ||
    !Array.isArray(value.operations) ||
    value.operations.length !== 1 ||
    !validOperation(value.operations[0], layerIds) ||
    !Number.isSafeInteger(value.rocksReseated) ||
    (value.rocksReseated as number) < 0 ||
    !isSha256(value.previousRockTransferSha256) ||
    !isSha256(value.resultingRockTransferSha256) ||
    !Number.isInteger(value.changedSampleCount) ||
    (value.changedSampleCount as number) < 0 ||
    !Number.isInteger(value.changedMaskSampleCount) ||
    (value.changedMaskSampleCount as number) < 0 ||
    !isSha256(value.previousChecksum) ||
    !isSha256(value.resultingChecksum) ||
    !isSha256(value.previousMaskChecksum) ||
    !isSha256(value.resultingMaskChecksum) ||
    !isRecord(massBalance) ||
    !['removedVolumeM3', 'depositedVolumeM3', 'netVolumeM3', 'relativeError'].every((name) =>
      isFiniteNumber(massBalance[name]),
    )
  ) {
    return false;
  }
  if (
    ((value.rocksReseated as number) === 0) !==
    (value.previousRockTransferSha256 === value.resultingRockTransferSha256)
  ) {
    return false;
  }
  const operation = value.operations[0] as TerrainOperation;
  const layerSamples = layerSamplesById.get(operation.layerId)!;
  const heightCount = value.changedSampleCount as number;
  const maskCount = value.changedMaskSampleCount as number;
  const removed = massBalance.removedVolumeM3 as number;
  const deposited = massBalance.depositedVolumeM3 as number;
  const net = massBalance.netVolumeM3 as number;
  const relativeError = massBalance.relativeError as number;
  const scale = Math.max(removed, deposited);
  if (
    removed < 0 ||
    deposited < 0 ||
    net !== deposited - removed ||
    relativeError !== (scale > 0 ? Math.abs(net) / scale : 0) ||
    relativeError < 0 ||
    relativeError > 1
  ) {
    return false;
  }

  if (heightCount <= SPARSE_SAMPLE_CAP) {
    if (!isRecord(value.sparse) || value.sparseOmitted !== undefined) return false;
    if (
      value.sparse.layerId !== operation.layerId ||
      value.sparse.sampleCount !== heightCount
    ) {
      return false;
    }
    const indices = decodeCanonicalBase64(value.sparse.indices);
    const heights = decodeCanonicalBase64(value.sparse.heights);
    if (
      !indices ||
      !heights ||
      !validSparseIndices(indices, heightCount, layerSamples) ||
      heights.byteLength !== heightCount * 4
    ) {
      return false;
    }
    for (let i = 0; i < heightCount; i++) {
      if (!Number.isFinite(heights.readFloatLE(i * 4))) return false;
    }
  } else if (
    value.sparse !== undefined ||
    typeof value.sparseOmitted !== 'string' ||
    value.sparseOmitted.length === 0
  ) {
    return false;
  }

  if (maskCount === 0) {
    if (value.maskSparse !== undefined || value.maskSparseOmitted !== undefined) return false;
  } else if (maskCount <= SPARSE_SAMPLE_CAP) {
    if (!isRecord(value.maskSparse) || value.maskSparseOmitted !== undefined) return false;
    if (
      value.maskSparse.layerId !== operation.layerId ||
      value.maskSparse.sampleCount !== maskCount
    ) {
      return false;
    }
    const indices = decodeCanonicalBase64(value.maskSparse.indices);
    const values = decodeCanonicalBase64(value.maskSparse.values);
    if (
      !indices ||
      !values ||
      !validSparseIndices(indices, maskCount, layerSamples) ||
      values.byteLength !== maskCount ||
      values.some((index) => index >= SEMANTIC_CLASSES.length)
    ) {
      return false;
    }
  } else if (
    value.maskSparse !== undefined ||
    typeof value.maskSparseOmitted !== 'string' ||
    value.maskSparseOmitted.length === 0
  ) {
    return false;
  }
  return true;
}

function validateSnapshotState(
  value: unknown,
  layerSamplesById: Map<string, number>,
): SnapshotState {
  const problems: string[] = [];
  if (!isRecord(value)) {
    throw new TerrainError(ERROR_CODES.VALIDATION_FAILED, 'snapshot state is not an object');
  }
  const featureManifest = value.featureManifest;
  const operationLog = value.operationLog;
  const deltas = value.deltas;
  const nextSequence = value.nextSequence;
  const datasetIdentity = value.datasetIdentity;
  const sessionSettings = value.sessionSettings;
  const datasetRevision = value.datasetRevision;
  const layerIds = new Set(layerSamplesById.keys());

  if (!isRecord(datasetIdentity)) problems.push('datasetIdentity is malformed');
  if (
    !isRecord(sessionSettings) ||
    !Number.isInteger(sessionSettings.tileSizeSamples) ||
    (sessionSettings.tileSizeSamples as number) < 16 ||
    (sessionSettings.tileSizeSamples as number) > 4096 ||
    !isFiniteNumber(sessionSettings.bulkDensityKgM3) ||
    sessionSettings.bulkDensityKgM3 <= 0
  ) {
    problems.push('sessionSettings is malformed');
  }
  if (!Number.isInteger(datasetRevision) || (datasetRevision as number) < 1) {
    problems.push('datasetRevision is not a positive integer');
  }

  if (!Array.isArray(featureManifest) || !featureManifest.every((f) => validFeature(f, layerIds))) {
    problems.push('featureManifest is malformed');
  } else {
    // Generated crater ids restart at crater-000000 on every crater-bearing
    // layer (lunar-features/src/craters.ts) and that numbering is part of the
    // byte-reproducible export contract, so ids are only required to be unique
    // among construction features, whose ids derive from operation ids. The
    // manifest as a whole is bound by its checksum in the snapshot manifest.
    const constructionIds = (featureManifest as TerrainFeature[])
      .filter((f) => f.kind !== 'crater' && f.kind !== 'rock')
      .map((f) => f.id);
    if (new Set(constructionIds).size !== constructionIds.length) {
      problems.push('featureManifest contains duplicate construction feature ids');
    }
  }
  if (!Array.isArray(operationLog) || !operationLog.every((op) => validOperation(op, layerIds))) {
    problems.push('operationLog is malformed');
  }
  if (!Array.isArray(deltas) || !deltas.every((delta) => validDelta(delta, layerSamplesById))) {
    problems.push('deltas are malformed');
  }
  if (!Number.isInteger(nextSequence) || (nextSequence as number) < 0) {
    problems.push('nextSequence is not a non-negative integer');
  }

  if (problems.length === 0) {
    const typedFeatures = featureManifest as TerrainFeature[];
    const typedOperations = operationLog as TerrainOperation[];
    const typedDeltas = deltas as TerrainDelta[];
    const sequence = nextSequence as number;
    if (typedOperations.length !== sequence) {
      problems.push(
        `operationLog length ${typedOperations.length} does not equal nextSequence ${sequence}`,
      );
    }
    if (typedDeltas.length > DELTA_WINDOW || typedDeltas.length > sequence) {
      problems.push(
        `retained delta count ${typedDeltas.length} is inconsistent with sequence ${sequence}`,
      );
    } else {
      const firstSequence = sequence - typedDeltas.length;
      const previousByLayer = new Map<
        string,
        { heightSha256: string; maskSha256: string }
      >();
      let previousRockTransferSha256: string | undefined;
      for (let i = 0; i < typedDeltas.length; i++) {
        const delta = typedDeltas[i];
        const expectedSequence = firstSequence + i;
        if (delta.sequenceNumber !== expectedSequence) {
          problems.push(
            `deltas[${i}] has sequence ${delta.sequenceNumber}, expected ${expectedSequence}`,
          );
          break;
        }
        if (delta.datasetRevision > (datasetRevision as number)) {
          problems.push(
            `deltas[${i}] revision ${delta.datasetRevision} is newer than snapshot revision ${datasetRevision}`,
          );
          break;
        }
        const layerId = delta.operations[0].layerId;
        const previous = previousByLayer.get(layerId);
        if (
          (previous &&
            (delta.previousChecksum !== previous.heightSha256 ||
              delta.previousMaskChecksum !== previous.maskSha256)) ||
          (previousRockTransferSha256 !== undefined &&
            delta.previousRockTransferSha256 !== previousRockTransferSha256)
        ) {
          problems.push(`deltas[${i}] breaks the retained terrain/rock checksum chain`);
          break;
        }
        previousByLayer.set(layerId, {
          heightSha256: delta.resultingChecksum,
          maskSha256: delta.resultingMaskChecksum,
        });
        previousRockTransferSha256 = delta.resultingRockTransferSha256;
        if (
          JSON.stringify(delta.operations[0]) !==
          JSON.stringify(typedOperations[delta.sequenceNumber])
        ) {
          problems.push(
            `deltas[${i}] does not reference operationLog[${delta.sequenceNumber}] exactly`,
          );
          break;
        }
      }
    }
    problems.push(
      ...constructionAuditProblems(
        typedFeatures,
        typedOperations,
        typedDeltas,
        (sessionSettings as SnapshotState['sessionSettings']).bulkDensityKgM3,
      ),
    );
  }

  if (problems.length > 0) {
    throw new TerrainError(
      ERROR_CODES.VALIDATION_FAILED,
      'snapshot state is malformed; the live dataset is unchanged',
      { problems },
    );
  }
  return {
    datasetIdentity: datasetIdentity as Record<string, unknown>,
    sessionSettings: sessionSettings as SnapshotState['sessionSettings'],
    datasetRevision: datasetRevision as number,
    featureManifest: featureManifest as TerrainFeature[],
    operationLog: operationLog as TerrainOperation[],
    deltas: deltas as TerrainDelta[],
    nextSequence: nextSequence as number,
  };
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
  if (
    op.kind === 'semantic_paint' &&
    (typeof op.semanticClass !== 'string' ||
      !(SEMANTIC_CLASSES as readonly string[]).includes(op.semanticClass))
  ) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `operation.semanticClass is required for '${op.kind}' and must be one of: ` +
        SEMANTIC_CLASSES.join(', '),
      {
        semanticClass: String(op.semanticClass),
        validClasses: [...SEMANTIC_CLASSES],
      },
    );
  }
  if (
    !validOperation(
      op as unknown,
      new Set(dataset.layers.map((candidate) => candidate.id)),
    )
  ) {
    throw new TerrainError(
      ERROR_CODES.INVALID_CONFIG,
      `operation parameters are invalid or incomplete for '${op.kind}'`,
      { kind: op.kind },
    );
  }
  const before = layerChecksum(layer);
  const beforeMask = maskChecksum(layer);
  const previousRockTransferSha256 =
    session.baseline?.rocks.transferSha256 ?? rockTransferSha256(sortedRockFeatures(dataset));
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
  // A rock centre up to one grid cell OUTSIDE the changed-sample box still
  // bilinearly interpolates one of its changed edge samples. Include exactly
  // that interpolation support; otherwise boundary rocks keep their old Y and
  // float above an excavation even though their centre is outside the box.
  const halo = layer.horizontalResolutionMeters;
  const reseated = reseatRocks(dataset, {
    minX: result.bounds.minX - halo,
    minZ: result.bounds.minZ - halo,
    maxX: result.bounds.maxX + halo,
    maxZ: result.bounds.maxZ + halo,
  });
  const resultingRockTransferSha256 = rockTransferSha256(sortedRockFeatures(dataset));
  const delta = makeDelta(
    layer,
    op,
    result,
    reseated,
    previousRockTransferSha256,
    resultingRockTransferSha256,
    session.datasetRevision,
    session.nextSequence,
    before,
    beforeMask,
    session.tileSizeSamples,
  );
  session.nextSequence++;
  session.layerHeads[layer.id] = {
    heightSha256: delta.resultingChecksum,
    maskSha256: delta.resultingMaskChecksum,
  };
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
  const semanticClass = CONSTRUCTION_OPERATION_SEMANTIC[op.kind];
  if (semanticClass !== undefined) {
    const bulkDensityKgM3 = session.bulkDensityKgM3;
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

  // Height/semantic heads are already available from the delta. Disturbance,
  // elevation-source and immutable hashes cannot change through operations,
  // so retain those while refreshing the rock-physics/world-state identity.
  session.baseline = terrainBaselineMetadata(dataset, session.layerHeads, session.baseline);

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(null, RPC_CODES.PARSE_ERROR, 'request was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail(null, RPC_CODES.INVALID_REQUEST, 'not a JSON-RPC 2.0 request');
  }
  const req = parsed as JsonRpcRequest;
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
          // Resolved on every call so a DEM fetched after the sidecar started
          // is picked up by the next connecting client.
          datasets: resolveSite01Dem(),
          solarModes: ['ephemeris', 'ephemeris_de', 'manual'],
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
            const outDir = resolve(config.outputDirectory);
            exportTerrain(dataset, {
              outputDirectory: outDir,
              tileSizeSamples: config.tileSizeSamples,
              solar,
              horizon,
              notes,
            });

            // Install only after export succeeds. The session may already
            // hold a known-good dataset; an unwritable destination or encoder
            // failure must not replace it with the result of a failed job.
            const installedLayerHeads = currentLayerHeads(dataset);
            const installedBaseline = terrainBaselineMetadata(dataset, installedLayerHeads);
            session.dataset = dataset;
            session.tileSizeSamples = config.tileSizeSamples;
            session.bulkDensityKgM3 = config.bulkDensityKgM3;
            session.deltas = [];
            session.operationLog = [];
            session.nextSequence = 0;
            session.outputDirectory = outDir;
            session.datasetRevision++;
            session.layerHeads = installedLayerHeads;
            session.baseline = installedBaseline;
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
        const baseline = currentTerrainBaseline(dataset);
        return ok(req.id, {
          terrainId: dataset.id,
          seed: dataset.seed,
          datasetRevision: session.datasetRevision,
          sequenceNumber: session.nextSequence,
          layerChecksums: session.layerHeads,
          baseline,
          coordinateSystem: dataset.coordinateSystem,
          origin: {
            local: dataset.origin.local,
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

      case 'terrain.getRocks': {
        const dataset = requireDataset();
        const maxInstances = p.maxInstances === undefined ? 25_000 : num(p, 'maxInstances');
        if (!Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > 50_000) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            "parameter 'maxInstances' must be an integer from 1 through 50000",
          );
        }

        const rocks = sortedRockFeatures(dataset);
        const evenlySpaced = (items: RockFeature[], limit: number): RockFeature[] => {
          if (items.length <= limit) return items;
          return Array.from(
            { length: limit },
            (_, index) => items[Math.floor((index * items.length) / limit)],
          );
        };

        // Preserve collision-bearing rocks preferentially, then fill the
        // remaining preview budget with a deterministic spread of visual-only
        // instances. This bounds browser/GPU memory without inventing points
        // or making the preview depend on an unstated random sample.
        let selected = rocks;
        if (rocks.length > maxInstances) {
          const physical = rocks.filter((rock) => rock.physical);
          const visual = rocks.filter((rock) => !rock.physical);
          const physicalBudget = Math.min(physical.length, maxInstances);
          selected = [
            ...evenlySpaced(physical, physicalBudget),
            ...evenlySpaced(visual, maxInstances - physicalBudget),
          ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        }
        const transferBytes = rockTransferBytes(selected);

        return ok(req.id, {
          terrainId: dataset.id,
          seed: dataset.seed,
          datasetRevision: session.datasetRevision,
          sequenceNumber: session.nextSequence,
          baseline: currentTerrainBaseline(dataset),
          totalCount: rocks.length,
          returnedCount: selected.length,
          truncated: selected.length < rocks.length,
          physicalCount: rocks.filter((rock) => rock.physical).length,
          transferEncoding: ROCK_TRANSFER_ENCODING,
          transferSha256: sha256(transferBytes),
          transferData: transferBytes.toString('base64'),
          provenance:
            'Deterministic instances from the configured literature-anchored rock population model; ' +
            'positions are modelled, not measured rock locations.',
          rocks: selected.map((rock) => ({
            id: rock.id,
            position_m: [rock.position.x, rock.position.y, rock.position.z],
            rotation_quaternion: rock.rotationQuaternion,
            scale_m: [rock.scale.x, rock.scale.y, rock.scale.z],
            physical: rock.physical,
            buried_fraction: rock.buriedFraction,
            angularity: rock.angularity,
          })),
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
          datasetRevision: session.datasetRevision,
          sequenceNumber: session.nextSequence,
          terrainId: dataset.id,
          seed: dataset.seed,
          layerChecksums: session.layerHeads,
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
        const revision = datasetRevisionParam(p, true)!;
        if (revision !== session.datasetRevision) throw revisionMismatchError(revision);
        const seq = sequenceParam(p);
        const { head, oldest } = sequenceWindow();
        if (seq >= head) throw unknownSequenceError(seq, head);
        if (seq < oldest) throw prunedSequenceError(seq, oldest, head);
        // Retained deltas are contiguous in sequence, so index arithmetic
        // is exact — but assert rather than assume.
        const delta = session.deltas.find(
          (candidate) =>
            candidate.datasetRevision === revision && candidate.sequenceNumber === seq,
        );
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
        const dataset = requireDataset();
        const baseline = currentTerrainBaseline(dataset);
        const revision = datasetRevisionParam(p, false);
        if (revision !== null && revision !== session.datasetRevision) {
          throw revisionMismatchError(revision);
        }
        const seq = sequenceParam(p);
        const { head, oldest } = sequenceWindow();
        if (seq > head) throw unknownSequenceError(seq, head);
        // A revision-less request has no trustworthy history binding. It is
        // the first phase of the client handshake, so always return the
        // current checksum baseline and head without interpreting retained
        // deltas from an unknown lineage. Revision-bound clients retain the
        // strict pruned-window error because their recovery path is a full
        // re-baseline, not a partial replay.
        if (revision !== null && seq < oldest) {
          throw prunedSequenceError(seq, oldest, head);
        }
        const tiles = new Set<string>();
        const perLayer = new Map<string, number>();
        let rocksReseated = 0;
        if (revision !== null) {
          for (const d of session.deltas) {
            if (d.datasetRevision !== session.datasetRevision) continue;
            if (d.sequenceNumber < seq) continue;
            for (const t of d.changedTiles) tiles.add(t);
            const layerId = d.operations[0].layerId;
            perLayer.set(layerId, (perLayer.get(layerId) ?? 0) + d.changedSampleCount);
            rocksReseated += d.rocksReseated;
          }
        }
        return ok(req.id, {
          fromSequence: seq,
          toSequence: head,
          datasetRevision: session.datasetRevision,
          terrainId: dataset.id,
          seed: dataset.seed,
          layerChecksums: session.layerHeads,
          baseline,
          baselineRequired: revision === null,
          changedTiles: [...tiles],
          rocksReseated,
          perLayer: [...perLayer].map(([layerId, changedSampleCount]) => ({
            layerId,
            changedSampleCount,
          })),
        });
      }

      case 'terrain.snapshot': {
        // Periodic full snapshot (spec §19): capture every mutable part of the
        // installed world. Heightfields and masks stay binary; feature and
        // audit state lives in one checksummed JSON file. The manifest is
        // written last so an interrupted write cannot look complete.
        requireNoRunningJob('snapshot the terrain');
        const dataset = requireDataset();
        if (!session.outputDirectory) {
          throw new TerrainError(
            ERROR_CODES.OUTPUT_NOT_WRITABLE,
            'no output directory is associated with the loaded dataset',
          );
        }
        const seq = session.nextSequence;
        const parent = resolve(session.outputDirectory, 'snapshots');
        mkdirSync(parent, { recursive: true });
        let dir: string;
        let tempDir: string;
        do {
          session.snapshotCounter++;
          const stem = `snap-r${session.datasetRevision}-s${seq}-n${session.snapshotCounter}`;
          dir = resolve(parent, stem);
          tempDir = resolve(parent, `.${stem}.writing-${process.pid}`);
        } while (existsSync(dir) || existsSync(tempDir));
        mkdirSync(tempDir, { recursive: false, mode: 0o700 });

        try {
          const writeBlob = (
            file: string,
            view: ArrayBufferView,
            encoding: SnapshotEncoding,
          ): SnapshotBlob => {
            const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
            writeSnapshotFileExclusive(tempDir, file, bytes);
            return {
              file,
              sha256: sha256(bytes),
              bytes: bytes.byteLength,
              encoding,
            };
          };
          const layers = dataset.layers.map((layer) => {
            const heightFile = `${layer.id}.height.f32`;
            const height = writeBlob(heightFile, layer.heightData, 'float32le');
            const semantic = layer.masks.semantic
              ? writeBlob(`${layer.id}.mask.u8`, layer.masks.semantic, 'uint8')
              : null;
            const disturbance = layer.masks.disturbance
              ? writeBlob(`${layer.id}.disturbance.f32`, layer.masks.disturbance, 'float32le')
              : null;
            const elevationSource = layer.masks.elevationSource
              ? writeBlob(`${layer.id}.elevation-source.u8`, layer.masks.elevationSource, 'uint8')
              : null;
            return {
              layerId: layer.id,
              widthSamples: layer.widthSamples,
              heightSamples: layer.heightSamples,
              heightFile,
              heightSha256: height.sha256,
              heightBytes: height.bytes,
              // Kept as semantic-mask aliases for existing protocol consumers.
              maskFile: semantic?.file ?? null,
              maskSha256: maskChecksum(layer),
              masks: { semantic, disturbance, elevationSource },
            };
          });

          const state: SnapshotState = {
            datasetIdentity: snapshotDatasetIdentity(dataset),
            sessionSettings: {
              tileSizeSamples: session.tileSizeSamples,
              bulkDensityKgM3: session.bulkDensityKgM3,
            },
            datasetRevision: session.datasetRevision,
            featureManifest: dataset.featureManifest,
            operationLog: session.operationLog,
            deltas: session.deltas,
            nextSequence: session.nextSequence,
          };
          const stateFile = 'state.json';
          const stateBytes = Buffer.from(JSON.stringify(state, null, 2));
          if (stateBytes.byteLength > MAX_SNAPSHOT_STATE_BYTES) {
            throw new TerrainError(
              ERROR_CODES.VALIDATION_FAILED,
              `snapshot state is ${stateBytes.byteLength} bytes, above the ${MAX_SNAPSHOT_STATE_BYTES}-byte safety limit`,
            );
          }
          writeSnapshotFileExclusive(tempDir, stateFile, stateBytes);

          const manifest: SnapshotManifest = {
            snapshotVersion: SNAPSHOT_VERSION,
            sequenceNumber: seq,
            timestamp: new Date().toISOString(),
            terrainId: dataset.id,
            seed: dataset.seed,
            directory: dir,
            stateFile,
            stateSha256: sha256(stateBytes),
            stateBytes: stateBytes.byteLength,
            layers,
          };
          const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
          writeSnapshotFileExclusive(tempDir, 'snapshot.json', manifestBytes);
          // Atomic publication: no reader can observe a partial snapshot.
          renameSync(tempDir, dir);
          return ok(req.id, manifest);
        } catch (error) {
          rmSync(tempDir, { recursive: true, force: true });
          throw error;
        }
      }

      case 'terrain.restoreSnapshot': {
        // Restore into a newly staged dataset. No live reference changes until
        // every heightfield, mask, feature, audit record and sequence invariant
        // has validated. The eventual commit is a sequence of non-throwing
        // reference assignments in one event-loop turn.
        requireNoRunningJob('restore a snapshot');
        const dataset = requireDataset();
        const dir = resolve(String(p.directory ?? ''));
        if (!existsSync(dir)) {
          throw new TerrainError(
            ERROR_CODES.JOB_NOT_FOUND,
            `no snapshot directory at ${dir}`,
            { directory: dir },
          );
        }
        let directoryReal: string;
        try {
          if (!lstatSync(dir).isDirectory()) throw new Error('path is not a directory');
          directoryReal = realpathSync(dir);
        } catch (error) {
          throw new TerrainError(
            ERROR_CODES.VALIDATION_FAILED,
            `snapshot directory ${dir} cannot be opened safely; the live dataset is unchanged`,
            { directory: dir, cause: String(error) },
          );
        }
        const manifestPath = resolve(directoryReal, 'snapshot.json');
        const manifestRead = readSnapshotFileBounded(
          directoryReal,
          'snapshot.json',
          MAX_SNAPSHOT_MANIFEST_BYTES,
        );
        if (!manifestRead.ok) {
          const code = manifestRead.problem === 'missing' ? ERROR_CODES.JOB_NOT_FOUND : ERROR_CODES.VALIDATION_FAILED;
          throw new TerrainError(
            code,
            `snapshot manifest at ${manifestPath} could not be read safely; the live dataset is unchanged`,
            { directory: directoryReal, manifestPath, problem: manifestRead.problem },
          );
        }
        let parsedManifest: unknown;
        try {
          parsedManifest = JSON.parse(manifestRead.bytes.toString('utf8'));
        } catch (e) {
          throw new TerrainError(
            ERROR_CODES.VALIDATION_FAILED,
            `snapshot manifest at ${manifestPath} is not valid JSON; the live dataset is unchanged`,
            { manifestPath, cause: String(e) },
          );
        }
        if (
          !isRecord(parsedManifest) ||
          parsedManifest.snapshotVersion !== SNAPSHOT_VERSION ||
          !Number.isInteger(parsedManifest.sequenceNumber) ||
          (parsedManifest.sequenceNumber as number) < 0 ||
          typeof parsedManifest.timestamp !== 'string' ||
          typeof parsedManifest.terrainId !== 'string' ||
          typeof parsedManifest.seed !== 'string' ||
          typeof parsedManifest.stateFile !== 'string' ||
          !isSha256(parsedManifest.stateSha256) ||
          !Number.isInteger(parsedManifest.stateBytes) ||
          (parsedManifest.stateBytes as number) < 0 ||
          !Array.isArray(parsedManifest.layers)
        ) {
          throw new TerrainError(
            ERROR_CODES.VALIDATION_FAILED,
            `snapshot manifest at ${manifestPath} is malformed or not snapshot version ${SNAPSHOT_VERSION}; ` +
              'the live dataset is unchanged',
            { manifestPath, requiredSnapshotVersion: SNAPSHOT_VERSION },
          );
        }
        const manifest = parsedManifest as unknown as SnapshotManifest;
        if (manifest.terrainId !== dataset.id || manifest.seed !== dataset.seed) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            `snapshot terrain identity does not match the current dataset; the live dataset is unchanged`,
            {
              snapshot: { terrainId: manifest.terrainId, seed: manifest.seed },
              current: { terrainId: dataset.id, seed: dataset.seed },
            },
          );
        }

        // Layer ids must match the current dataset exactly — restoring a
        // snapshot of a different site into this one would be silent
        // cross-dataset corruption.
        const current = new Map(dataset.layers.map((l) => [l.id, l]));
        const snapshotIds = manifest.layers.map((entry) =>
          isRecord(entry) && typeof entry.layerId === 'string' ? entry.layerId : '',
        );
        const missingInDataset = snapshotIds.filter((id) => !current.has(id));
        const missingInSnapshot = [...current.keys()].filter((id) => !snapshotIds.includes(id));
        const duplicateSnapshotIds = snapshotIds.filter((id, i) => snapshotIds.indexOf(id) !== i);
        if (
          missingInDataset.length > 0 ||
          missingInSnapshot.length > 0 ||
          duplicateSnapshotIds.length > 0
        ) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            'snapshot layers do not match the current dataset: ' +
              `[${missingInDataset.join(', ')}] exist only in the snapshot, ` +
              `[${missingInSnapshot.join(', ')}] only in the dataset, ` +
              `[${duplicateSnapshotIds.join(', ')}] are duplicated`,
            { missingInDataset, missingInSnapshot, duplicateSnapshotIds },
          );
        }

        const mismatches: Array<Record<string, unknown>> = [];
        const readBlob = (
          blob: SnapshotBlob,
          expectedBytes: number,
          label: string,
        ): Buffer | null => {
          if (expectedBytes > MAX_SNAPSHOT_BLOB_BYTES || blob.bytes !== expectedBytes) {
            mismatches.push({
              file: blob.file,
              problem: 'size mismatch',
              manifestBytes: blob.bytes,
              expectedBytes,
              label,
            });
            return null;
          }
          const read = readSnapshotFileBounded(
            directoryReal,
            blob.file,
            MAX_SNAPSHOT_BLOB_BYTES,
            expectedBytes,
          );
          if (!read.ok) {
            mismatches.push({
              file: blob.file,
              problem: read.problem,
              manifestBytes: blob.bytes,
              expectedBytes,
              ...(read.actualBytes !== undefined ? { actualBytes: read.actualBytes } : {}),
              label,
            });
            return null;
          }
          const bytes = read.bytes;
          const actualSha256 = sha256(bytes);
          if (actualSha256 !== blob.sha256) {
            mismatches.push({
              file: blob.file,
              problem: 'checksum mismatch',
              expectedSha256: blob.sha256,
              actualSha256,
              label,
            });
            return null;
          }
          return bytes;
        };
        const float32From = (bytes: Buffer): Float32Array => {
          const out = new Float32Array(bytes.byteLength / 4);
          new Uint8Array(out.buffer).set(bytes);
          return out;
        };
        const stagedLayers: TerrainLayer[] = [];
        for (const entry of manifest.layers) {
          if (
            !isRecord(entry) ||
            typeof entry.layerId !== 'string' ||
            !Number.isInteger(entry.widthSamples) ||
            !Number.isInteger(entry.heightSamples) ||
            typeof entry.heightFile !== 'string' ||
            !isSha256(entry.heightSha256) ||
            !Number.isInteger(entry.heightBytes) ||
            !isSha256(entry.maskSha256) ||
            !isRecord(entry.masks) ||
            !(entry.masks.semantic === null || validSnapshotBlob(entry.masks.semantic, 'uint8')) ||
            !(
              entry.masks.disturbance === null ||
              validSnapshotBlob(entry.masks.disturbance, 'float32le')
            ) ||
            !(
              entry.masks.elevationSource === null ||
              validSnapshotBlob(entry.masks.elevationSource, 'uint8')
            )
          ) {
            mismatches.push({
              layerId: isRecord(entry) ? entry.layerId : null,
              problem: 'malformed layer entry',
            });
            continue;
          }
          const layer = current.get(entry.layerId)!;
          const snapshotMasks = entry.masks as unknown as SnapshotLayer['masks'];
          const maskPresence = {
            semantic: snapshotMasks.semantic !== null,
            disturbance: snapshotMasks.disturbance !== null,
            elevationSource: snapshotMasks.elevationSource !== null,
          };
          const expectedMaskPresence = {
            semantic: layer.masks.semantic !== undefined,
            disturbance: layer.masks.disturbance !== undefined,
            elevationSource: layer.masks.elevationSource !== undefined,
          };
          if (
            maskPresence.semantic !== expectedMaskPresence.semantic ||
            maskPresence.disturbance !== expectedMaskPresence.disturbance ||
            maskPresence.elevationSource !== expectedMaskPresence.elevationSource
          ) {
            mismatches.push({
              layerId: entry.layerId,
              problem: 'mask channel presence mismatch',
              snapshot: maskPresence,
              current: expectedMaskPresence,
            });
            continue;
          }
          const expectedSamples = layer.widthSamples * layer.heightSamples;
          if (
            entry.widthSamples !== layer.widthSamples ||
            entry.heightSamples !== layer.heightSamples
          ) {
            mismatches.push({
              layerId: entry.layerId,
              problem: 'grid dimensions mismatch',
              snapshot: [entry.widthSamples, entry.heightSamples],
              current: [layer.widthSamples, layer.heightSamples],
            });
            continue;
          }
          const heightBlob: SnapshotBlob = {
            file: entry.heightFile,
            sha256: entry.heightSha256,
            bytes: entry.heightBytes,
            encoding: 'float32le',
          };
          const heightBytes = readBlob(heightBlob, expectedSamples * 4, `${entry.layerId}.height`);
          const semanticBytes = entry.masks.semantic
            ? readBlob(entry.masks.semantic, expectedSamples, `${entry.layerId}.semantic`)
            : null;
          const disturbanceBytes = entry.masks.disturbance
            ? readBlob(entry.masks.disturbance, expectedSamples * 4, `${entry.layerId}.disturbance`)
            : null;
          const elevationSourceBytes = entry.masks.elevationSource
            ? readBlob(
                entry.masks.elevationSource,
                expectedSamples,
                `${entry.layerId}.elevationSource`,
              )
            : null;

          if (
            entry.maskFile !== (entry.masks.semantic?.file ?? null) ||
            entry.maskSha256 !== (entry.masks.semantic?.sha256 ?? sha256(Buffer.alloc(0)))
          ) {
            mismatches.push({
              layerId: entry.layerId,
              problem: 'semantic-mask aliases disagree',
            });
          }
          if (
            !heightBytes ||
            (entry.masks.semantic !== null && !semanticBytes) ||
            (entry.masks.disturbance !== null && !disturbanceBytes) ||
            (entry.masks.elevationSource !== null && !elevationSourceBytes)
          ) {
            continue;
          }

          const heightData = float32From(heightBytes);
          if (heightData.some((value) => !Number.isFinite(value))) {
            mismatches.push({
              file: entry.heightFile,
              problem: 'non-finite height sample',
            });
          }
          const semantic = semanticBytes ? Uint8Array.from(semanticBytes) : undefined;
          if (semantic?.some((value) => value >= SEMANTIC_CLASSES.length)) {
            mismatches.push({
              file: entry.masks.semantic!.file,
              problem: 'invalid semantic index',
            });
          }
          const disturbance = disturbanceBytes ? float32From(disturbanceBytes) : undefined;
          if (disturbance?.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
            mismatches.push({
              file: entry.masks.disturbance!.file,
              problem: 'invalid disturbance value',
            });
          }
          const elevationSource = elevationSourceBytes
            ? Uint8Array.from(elevationSourceBytes)
            : undefined;
          if (elevationSource?.some((value) => value >= ELEVATION_SOURCES.length)) {
            mismatches.push({
              file: entry.masks.elevationSource!.file,
              problem: 'invalid elevation-source index',
            });
          }

          const stagedLayer: TerrainLayer = {
            ...layer,
            bounds: { ...layer.bounds },
            heightData,
            masks: { semantic, disturbance, elevationSource },
          };
          recomputeVerticalBounds(stagedLayer);
          stagedLayers.push(stagedLayer);
        }

        let state: SnapshotState | null = null;
        if (manifest.stateBytes > MAX_SNAPSHOT_STATE_BYTES) {
          mismatches.push({
            file: manifest.stateFile,
            problem: 'file exceeds snapshot read limit',
            manifestBytes: manifest.stateBytes,
            limitBytes: MAX_SNAPSHOT_STATE_BYTES,
            label: 'state',
          });
        } else {
          const stateRead = readSnapshotFileBounded(
            directoryReal,
            manifest.stateFile,
            MAX_SNAPSHOT_STATE_BYTES,
            manifest.stateBytes,
          );
          if (!stateRead.ok) {
            mismatches.push({
              file: manifest.stateFile,
              problem: stateRead.problem,
              expectedBytes: manifest.stateBytes,
              ...(stateRead.actualBytes !== undefined
                ? { actualBytes: stateRead.actualBytes }
                : {}),
              label: 'state',
            });
          } else {
            const stateBytes = stateRead.bytes;
            const actualStateSha256 = sha256(stateBytes);
            if (actualStateSha256 !== manifest.stateSha256) {
              mismatches.push({
                file: manifest.stateFile,
                problem: 'checksum mismatch',
                expectedSha256: manifest.stateSha256,
                actualSha256: actualStateSha256,
                label: 'state',
              });
            } else {
            let parsedState: unknown;
            try {
              parsedState = JSON.parse(stateBytes.toString('utf8'));
            } catch (e) {
              mismatches.push({
                file: manifest.stateFile,
                problem: 'invalid JSON',
                cause: String(e),
              });
            }
            if (parsedState !== undefined) {
              try {
                state = validateSnapshotState(
                  parsedState,
                  new Map(
                    dataset.layers.map((layer) => [
                      layer.id,
                      layer.widthSamples * layer.heightSamples,
                    ]),
                  ),
                );
              } catch (e) {
                if (e instanceof TerrainError) {
                  mismatches.push({
                    file: manifest.stateFile,
                    problem: 'malformed state',
                    details: e.details,
                  });
                } else {
                  mismatches.push({
                    file: manifest.stateFile,
                    problem: 'malformed state',
                    cause: String(e),
                  });
                }
              }
            }
            }
          }
        }
        if (state && state.nextSequence !== manifest.sequenceNumber) {
          mismatches.push({
            file: manifest.stateFile,
            problem: 'sequence mismatch',
            manifestSequence: manifest.sequenceNumber,
            stateSequence: state.nextSequence,
          });
        }
        if (state) {
          const expectedIdentity = snapshotDatasetIdentity(dataset);
          const expectedSettings: SnapshotState['sessionSettings'] = {
            tileSizeSamples: session.tileSizeSamples,
            bulkDensityKgM3: session.bulkDensityKgM3,
          };
          if (
            JSON.stringify(state.datasetIdentity) !== JSON.stringify(expectedIdentity) ||
            JSON.stringify(state.sessionSettings) !== JSON.stringify(expectedSettings)
          ) {
            throw new TerrainError(
              ERROR_CODES.INVALID_CONFIG,
              'snapshot immutable dataset identity or session configuration does not match the current dataset; ' +
                'the live dataset is unchanged',
              {
                snapshot: {
                  datasetIdentity: state.datasetIdentity,
                  sessionSettings: state.sessionSettings,
                },
                current: {
                  datasetIdentity: expectedIdentity,
                  sessionSettings: expectedSettings,
                },
              },
            );
          }
        }
        if (mismatches.length === 0 && state && stagedLayers.length === dataset.layers.length) {
          const stagedById = new Map(stagedLayers.map((layer) => [layer.id, layer]));
          for (const delta of state.deltas) {
            const laterSameLayer = state.operationLog
              .slice(delta.sequenceNumber + 1)
              .some((operation) => operation.layerId === delta.operations[0].layerId);
            if (!laterSameLayer) {
              const layer = stagedById.get(delta.operations[0].layerId)!;
              if (
                layerChecksum(layer) !== delta.resultingChecksum ||
                maskChecksum(layer) !== delta.resultingMaskChecksum
              ) {
                mismatches.push({
                  sequenceNumber: delta.sequenceNumber,
                  layerId: layer.id,
                  problem: 'terminal delta checksums do not match restored layer state',
                });
              }
            }
          }
        }
        if (state && stagedLayers.length === dataset.layers.length) {
          const stagedDataset: TerrainDataset = {
            ...dataset,
            layers: stagedLayers,
            featureManifest: state.featureManifest,
          };
          const terminalDelta = state.deltas[state.deltas.length - 1];
          if (
            terminalDelta &&
            terminalDelta.resultingRockTransferSha256 !==
              rockTransferSha256(sortedRockFeatures(stagedDataset))
          ) {
            mismatches.push({
              file: manifest.stateFile,
              sequenceNumber: terminalDelta.sequenceNumber,
              problem: 'terminal rock transfer checksum does not match restored features',
            });
          }
          for (const problem of restoredRockPhysicsProblems(
            state.featureManifest,
            stagedDataset,
          )) {
            mismatches.push({
              file: manifest.stateFile,
              problem: 'invalid rock physics state',
              ...problem,
            });
          }
        }
        if (mismatches.length > 0) {
          throw new TerrainError(
            ERROR_CODES.VALIDATION_FAILED,
            `snapshot at ${dir} failed validation against its manifest — ` +
              'a corrupt snapshot must not load; the live dataset is unchanged',
            { directory: dir, mismatches },
          );
        }

        const restoredState = state!;
        const restoredDataset: TerrainDataset = {
          ...dataset,
          layers: stagedLayers,
          featureManifest: restoredState.featureManifest,
          bounds: {
            ...dataset.bounds,
            minY: Math.min(...stagedLayers.map((layer) => layer.bounds.minY)),
            maxY: Math.max(...stagedLayers.map((layer) => layer.bounds.maxY)),
          },
        };
        const restoredLayerHeads = currentLayerHeads(restoredDataset);
        const restoredBaseline = terrainBaselineMetadata(restoredDataset, restoredLayerHeads);

        // Commit: all inputs and derived data are already staged. These
        // assignments cannot throw, and no request can interleave this turn.
        session.dataset = restoredDataset;
        session.deltas = restoredState.deltas;
        session.operationLog = restoredState.operationLog;
        session.nextSequence = restoredState.nextSequence;
        session.tileSizeSamples = restoredState.sessionSettings.tileSizeSamples;
        session.bulkDensityKgM3 = restoredState.sessionSettings.bulkDensityKgM3;
        session.datasetRevision++;
        session.layerHeads = restoredLayerHeads;
        session.baseline = restoredBaseline;
        return ok(req.id, {
          directory: dir,
          snapshotSequenceNumber: manifest.sequenceNumber,
          restoredLayers: stagedLayers.length,
          restoredFeatures: restoredDataset.featureManifest.length,
          restoredOperations: session.operationLog.length,
          nextSequence: session.nextSequence,
          datasetRevision: session.datasetRevision,
          layers: restoredDataset.layers.map((l) => ({
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
        const channel = p.channel ?? 'height';
        if (channel !== 'height' && channel !== 'semantic') {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            "parameter 'channel' must be 'height' or 'semantic'",
            { channel },
          );
        }
        if (channel === 'semantic' && !layer.masks.semantic) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            `layer '${layerId}' has no semantic mask`,
            { layerId, channel },
          );
        }
        const integer = (name: string, minimum: number): number => {
          const value = num(p, name);
          if (!Number.isSafeInteger(value) || value < minimum) {
            throw new TerrainError(
              ERROR_CODES.INVALID_CONFIG,
              `parameter '${name}' must be an integer >= ${minimum}`,
              { [name]: value },
            );
          }
          return value;
        };
        const col0 = integer('col0', 0);
        const row0 = integer('row0', 0);
        const w = integer('width', 1);
        const h = integer('height', 1);
        if (col0 + w > layer.widthSamples || row0 + h > layer.heightSamples) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            'requested tile lies outside the layer grid',
            {
              col0,
              row0,
              width: w,
              height: h,
              layerWidthSamples: layer.widthSamples,
              layerHeightSamples: layer.heightSamples,
            },
          );
        }
        // Optional decimation. A 3001² operational layer is 36 MB of float32,
        // which is 48 MB once base64-encoded — far too much to push at a
        // browser for a preview. `stride` lets a viewer ask for every n-th
        // sample and bound the transfer, while a simulation client still
        // requests stride 1 and gets every value.
        const stride = p.stride === undefined ? 1 : integer('stride', 1);
        if (channel === 'semantic' && stride !== 1) {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            "semantic tiles require stride 1; parameter 'stride' must be 1",
            { layerId, channel, stride },
          );
        }
        const outW = Math.floor((w - 1) / stride) + 1;
        const outH = Math.floor((h - 1) / stride) + 1;

        if (channel === 'semantic') {
          const semantic = layer.masks.semantic!;
          const out = new Uint8Array(w * h);
          for (let row = 0; row < h; row++) {
            const start = (row0 + row) * layer.widthSamples + col0;
            out.set(semantic.subarray(start, start + w), row * w);
          }
          return ok(req.id, {
            layerId,
            channel,
            col0,
            row0,
            width: w,
            height: h,
            stride: 1,
            resolutionMeters: layer.horizontalResolutionMeters,
            layerResolutionMeters: layer.horizontalResolutionMeters,
            encoding: 'base64:uint8',
            data: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64'),
          });
        }

        const out = new Float32Array(outW * outH);
        for (let r = 0; r < outH; r++) {
          const src = (row0 + r * stride) * layer.widthSamples + col0;
          for (let c = 0; c < outW; c++) {
            out[r * outW + c] = layer.heightData[src + c * stride];
          }
        }
        return ok(req.id, {
          layerId,
          channel,
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
        // Two models behind ONE method (params only — the method table is
        // unchanged, spec §16):
        //
        // - 'bekker' (default): static Bekker–Wong assessment with sourced
        //   parameters (ADR 0005). The legacy heuristic result is embedded
        //   under `heuristic` for comparison, still carrying its own label.
        // - 'heuristic': the legacy hand-weighted score, response shape
        //   byte-for-byte what it was before the model parameter existed —
        //   existing clients (the UI inspector) read that shape.
        const dataset = requireDataset();
        const x = num(p, 'x');
        const z = num(p, 'z');
        const model = p.model === undefined ? 'bekker' : String(p.model);
        if (model !== 'bekker' && model !== 'heuristic') {
          throw new TerrainError(
            ERROR_CODES.INVALID_CONFIG,
            `parameter 'model' must be 'bekker' or 'heuristic', got ${JSON.stringify(p.model)}`,
          );
        }
        if (model === 'heuristic') {
          return ok(req.id, { x, z, traversability: traversabilityAt(dataset, x, z) });
        }
        const layer = finestLayerAt(dataset, x, z);
        const assessment = layer ? assessAt(layer, x, z) : null;
        if (!assessment) {
          return ok(req.id, { x, z, traversability: null });
        }
        return ok(req.id, {
          x,
          z,
          traversability: {
            model: 'bekker',
            slopeDeg: assessment.slopeDeg,
            sinkageM: assessment.sinkageM,
            drawbarPullN: assessment.drawbarPullN,
            thrustN: assessment.thrustN,
            slopeMarginDeg: assessment.slopeMarginDeg,
            class: assessment.class,
            parameters: {
              ...LUNAR_REGOLITH_PARAMETERS,
              vehicle: { ...REFERENCE_VEHICLE },
              // The provenance block travels with EVERY response using this
              // model: equatorial-Apollo/simulant-derived parameters, no
              // polar in-situ data, unsettled low-gravity effects (ADR 0005).
              provenance: TERRAMECHANICS_PROVENANCE,
            },
            // The legacy result, for comparison — still labelled as the
            // synthetic heuristic it is.
            heuristic: traversabilityAt(dataset, x, z),
          },
        });
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
          const selenographic = datasetLocalToSelenographic(
            dataset,
            p.x !== undefined ? num(p, 'x') : 0,
            p.z !== undefined ? num(p, 'z') : 0,
          );
          siteLat = selenographic.latitudeDeg;
          siteLon = selenographic.longitudeDeg;
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

        // Opt-in far-field ring (ADR 0006): merge the skyline the configured
        // layers cannot see, ray-marched from the real LDEM_75S product along
        // great circles. Off by default — the near-field-only response is the
        // documented v1.0 behaviour and existing clients depend on its shape.
        if (p.farField) {
          // The ring compares REAL LDEM radial elevations against the
          // observer's radial elevation, which only exists when the dataset
          // is grounded in a measured DEM (the datum of a procedural site is
          // nominal). Refuse rather than return a physically meaningless
          // skyline with real-data provenance attached.
          if (!/measured/.test(widest.elevationProvenance)) {
            throw new TerrainError(
              ERROR_CODES.INVALID_CONFIG,
              `Far-field horizon requires a DEM-grounded dataset: the ` +
                `observer's radial elevation comes from the measured datum, ` +
                `and layer '${widest.id}' has elevationProvenance ` +
                `'${widest.elevationProvenance}'.`,
              { layerId: widest.id, elevationProvenance: widest.elevationProvenance },
            );
          }
          const ff = (typeof p.farField === 'object' ? p.farField : {}) as {
            demPath?: string;
            maxRangeMeters?: number;
          };
          const labelPath =
            ff.demPath ?? process.env.LTS_LDEM_75S ?? DEFAULT_LDEM_75S_LABEL;
          if (!existsSync(labelPath)) {
            throw new TerrainError(
              ERROR_CODES.DEM_UNAVAILABLE,
              `Far-field horizon needs the LOLA LDEM_75S product, and ` +
                `${labelPath} does not exist. There is no fallback: a horizon ` +
                `computed without the far field would silently understate ` +
                `shadowing. Fetch it with scripts/fetch-data.sh, or point ` +
                `farField.demPath / LTS_LDEM_75S at the .lbl file.`,
              { demPath: labelPath, envOverride: 'LTS_LDEM_75S' },
            );
          }
          const raster = openFarFieldRaster(labelPath);

          // Observer selenographic position and radial elevation. Stored
          // heights are tangent-plane values relative to the datum with the
          // curvature drop removed at ingestion (sample.ts), so the absolute
          // radial elevation restores both terms exactly.
          const worldX = widest.bounds.minX + cx * widest.horizontalResolutionMeters;
          const worldZ = widest.bounds.minZ + cz * widest.horizontalResolutionMeters;
          const ll = datasetLocalToSelenographic(dataset, worldX, worldZ);
          const localH = sampleBilinear(sampler, cx, cz);
          const radialElevationM =
            dataset.origin.datumElevationM +
            localH +
            (worldX * worldX + worldZ * worldZ) / (2 * LUNAR_REFERENCE_RADIUS_M);

          const far = farFieldHorizon(
            raster,
            {
              latitudeDeg: ll.latitudeDeg,
              longitudeDeg: ll.longitudeDeg,
              radialElevationM,
            },
            {
              azimuthBins: bins,
              maxRangeM: ff.maxRangeMeters !== undefined ? num(ff, 'maxRangeMeters') : undefined,
            },
          );

          const merged = new Float32Array(bins);
          for (let i = 0; i < bins; i++) {
            merged[i] = Math.max(profile[i], far.horizonElevationDeg[i]);
          }
          return ok(req.id, {
            layerId: widest.id,
            bins,
            azimuthStepDeg: 360 / bins,
            horizonElevationDeg: Array.from(merged),
            nearFieldElevationDeg: Array.from(profile),
            farField: {
              applied: true,
              elevationDeg: Array.from(far.horizonElevationDeg),
              source: far.source,
              observer: far.observer,
              startRangeM: far.startRangeM,
              maxRangeM: far.maxRangeM,
              truncatedAtM: far.truncatedAtM === Infinity ? null : far.truncatedAtM,
              noDataSamples: far.noDataSamples,
              method:
                'Great-circle ray-march over LDEM_75S radial elevations, exact ' +
                'spherical elevation angles (Mazarico et al. 2011 reference ' +
                'method); merged with the near field by per-bin max.',
            },
            note:
              'horizonElevationDeg is the per-bin max of the near-field layer ' +
              'profile and the far-field LDEM ring. The far field is bounded ' +
              'by the 120 m/px source: rims sharper than that are smoothed, ' +
              'so the merged skyline remains a lower bound near ridgelines.',
          });
        }

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
export async function startServer(port = 8768): Promise<WebSocketServer> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    maxPayload: MAX_REQUEST_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ origin }, accept) => {
      if (allowedClientOrigin(origin)) {
        accept(true);
      } else {
        accept(false, 403, 'Forbidden WebSocket origin');
      }
    },
  });

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
