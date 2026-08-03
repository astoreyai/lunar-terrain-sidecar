/**
 * `@lts/terrain-protocol` — the versioned sidecar protocol (spec §16).
 *
 * JSON-RPC 2.0 over WebSocket. The protocol version is negotiated on connect
 * and a mismatch is a hard error, not a warning: a Godot client built against a
 * different message shape will silently mis-drive terrain generation otherwise.
 */

export const PROTOCOL_VERSION = '1.0.0';
export const DEFAULT_PORT = 8765;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** JSON-RPC reserved codes plus this protocol's application range. */
export const RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Application errors carry the TerrainError code in `data.code`. */
  TERRAIN_ERROR: -32000,
} as const;

/** Server-pushed progress notification (spec §16). */
export interface ProgressEvent {
  event: 'terrain.progress';
  jobId: string;
  stage: string;
  progress: number;
  detail?: string;
}

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  seed: string;
  terrainId: string;
  stage: string;
  progress: number;
  startedAt: string;
  finishedAt?: string;
  outputDirectory?: string;
  error?: { code: string; message: string; details: Record<string, unknown> };
}

/** Every method this server implements. Anything else is METHOD_NOT_FOUND. */
export const METHODS = [
  'terrain.health',
  'terrain.capabilities',
  'terrain.validateConfig',
  'terrain.estimate',
  'terrain.generate',
  'terrain.cancel',
  'terrain.getStatus',
  'terrain.getManifest',
  'terrain.getDataset',
  'terrain.export',
  'terrain.loadConfig',
  'terrain.saveConfig',
  'terrain.applyOperation',
  'terrain.getOperationLog',
  'terrain.replayLog',
  'terrain.getTile',
  'terrain.getHeight',
  'terrain.getNormal',
  'terrain.getSemanticClass',
  'terrain.getTraversability',
  'terrain.getSolar',
  'terrain.getHorizon',
  'terrain.shutdown',
] as const;

export type Method = (typeof METHODS)[number];

/** Terrain edit operations, stored as replayable records (spec §12, §19). */
export type OperationKind =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  // Tilt toward a plane through the click point's current elevation, with
  // gradient strengthMeters-per-radiusMeters descending along headingDegrees.
  | 'slope'
  // Deterministic seeded fBm stamp; requires `noiseSeed` so an identical
  // operation record reproduces the identical displacement on replay.
  | 'noise'
  // Paints ONLY the semantic mask (requires `semanticClass`); zero height
  // change, so the height checksum is unchanged and the delta's mask
  // checksums are what record that anything happened.
  | 'semantic_paint'
  | 'crater_stamp'
  | 'trench'
  | 'berm'
  // Construction features (spec §11). Each application is also recorded as a
  // ConstructionFeature in the dataset's feature manifest with its measured
  // mass balance.
  | 'ramp'
  | 'pad'
  | 'spoil_pile'
  | 'wheel_track'
  | 'polygonal_cut'
  | 'polygonal_fill';

export interface TerrainOperation {
  operationId: string;
  kind: OperationKind;
  /** Layer the operation applies to. */
  layerId: string;
  /** Centre in local metres. */
  centerXMeters: number;
  centerZMeters: number;
  /**
   * Brush radius, metres. Reused per kind: ramp/pad half-width, spoil-pile
   * base radius, wheel-track gauge (rut centre-to-centre), and the boundary
   * falloff band width for polygonal_cut / polygonal_fill.
   */
  radiusMeters: number;
  /** Signed magnitude, metres. Interpretation depends on `kind`. */
  strengthMeters: number;
  /** Falloff exponent; 1 is linear, 2 is smooth. */
  falloff: number;
  /** Target elevation for `flatten`, `pad`, ramp far end, and polygonal ops. */
  targetElevationMeters?: number;
  /** For trench/berm/ramp/pad/wheel_track: direction and length. */
  headingDegrees?: number;
  lengthMeters?: number;
  /**
   * For polygonal_cut / polygonal_fill: the polygon as [x, z] vertices in
   * world metres. At least 3 finite vertices; the closing edge is implicit.
   */
  polygonXZ?: number[][];
  /**
   * REQUIRED for `noise`: seed string for the fBm stamp. Part of the stored
   * record, so replaying the same operation reproduces the same displacement.
   */
  noiseSeed?: string;
  /**
   * REQUIRED for `semantic_paint`: the semantic class to paint, one of
   * `SEMANTIC_CLASSES` in `@lts/shared-types`. Validated by name with a
   * structured error listing the valid classes.
   */
  semanticClass?: string;
  /** Conserve volume by redistributing the displaced material. */
  massConserving?: boolean;
  /** ISO-8601 instant the operation was recorded. */
  timestamp: string;
}

export interface TerrainDelta {
  deltaId: string;
  sequenceNumber: number;
  timestamp: string;
  affectedBounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  changedTiles: string[];
  operations: TerrainOperation[];
  previousChecksum: string;
  resultingChecksum: string;
  /**
   * SHA-256 of the layer's semantic mask before/after, populated for every
   * operation kind. A `semantic_paint` moves no height at all, so without
   * these the delta would claim nothing changed (identical height checksums)
   * while the mask had in fact been rewritten.
   */
  previousMaskChecksum: string;
  resultingMaskChecksum: string;
  /** Volume removed and added, m³, and the conservation error. */
  massBalance: {
    removedVolumeM3: number;
    depositedVolumeM3: number;
    netVolumeM3: number;
    relativeError: number;
  };
}
