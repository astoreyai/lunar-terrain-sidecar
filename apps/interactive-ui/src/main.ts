/**
 * Interactive UI bootstrap (spec §23).
 *
 * The browser never generates terrain. It configures the sidecar, streams the
 * result back as tiles, renders it, and sends edits as operations — keeping one
 * implementation of the physics-bearing data (spec §33).
 */

import { SidecarClient, decodeTile, RpcError } from './rpc.js';
import { Viewer, type CameraMode } from './viewer.js';
import { overlayLegend, type OverlayMode, slopeDegAt, roughnessAt, traversabilityScore } from './overlays.js';
import { PRESETS, presetToConfig } from './presets.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const client = new SidecarClient();
let viewer: Viewer;
let activeBrush: string | null = null;
const undoStack: Array<Record<string, unknown>> = [];
const redoStack: Array<Record<string, unknown>> = [];

/** Construction kinds that take an explicit heading and length (protocol.md). */
const HEADING_KINDS = new Set(['ramp', 'pad', 'wheel_track']);
/** Kinds whose target elevation the user may override (auto = surface at click). */
const TARGET_KINDS = new Set(['ramp', 'pad', 'polygonal_cut', 'polygonal_fill']);
/** Kinds driven by a clicked polygon rather than a single brush centre. */
const POLYGON_KINDS = new Set(['polygonal_cut', 'polygonal_fill']);
/** Vertices collected so far for a polygonal_cut/polygonal_fill, world metres. */
const polygonVertices: Array<[number, number]> = [];
let currentLayers: Awaited<ReturnType<typeof fetchLayers>> = [];

/** Everything the status bar must always show (spec §23). */
function setStatus(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function log(id: string, text: string, cls?: 'pass' | 'fail'): void {
  const el = $(id);
  el.textContent = text;
  el.className = `log${cls ? ` ${cls}` : ''}`;
}

// ------------------------------------------------------------ configuration

function currentPreset() {
  return PRESETS[($('cfg-preset') as HTMLSelectElement).value] ?? PRESETS.south_pole_navigation;
}

function buildConfig(): Record<string, unknown> {
  const num = (id: string) => Number(($(id) as HTMLInputElement).value);
  const str = (id: string) => ($(id) as HTMLInputElement).value;
  return presetToConfig(currentPreset(), {
    terrainId: str('cfg-terrain-id'),
    seed: str('cfg-seed'),
    outputDirectory: str('cfg-output'),
    latitudeDeg: num('cfg-lat'),
    longitudeDeg: num('cfg-lon'),
    epochUtc: str('cfg-epoch'),
    demEnabled: ($('cfg-dem-enabled') as HTMLInputElement).checked,
    demPath: str('cfg-dem-path'),
    demEffectiveResolutionMeters: num('cfg-dem-effres'),
    craterModel: ($('cfg-crater-model') as HTMLSelectElement).value as 'production_csfd',
    craterAgeGyr: num('cfg-crater-age'),
    craterMinDiameterM: num('cfg-crater-dmin'),
    craterMaxDiameterM: num('cfg-crater-dmax'),
    craterMeanDegradation: num('cfg-crater-degradation'),
    rockModel: ($('cfg-rock-model') as HTMLSelectElement).value as 'golombek_sfd',
    rockAreaCoverage: num('cfg-rock-k'),
    rockMinDiameterM: num('cfg-rock-dmin'),
    rockPhysicalMinDiameterM: num('cfg-rock-physical'),
  });
}

function renderLayerTable(): void {
  const preset = currentPreset();
  const tbody = $('layer-rows');
  const select = $('cfg-selected-layer') as HTMLSelectElement;
  tbody.innerHTML = '';
  select.innerHTML = '';
  for (const l of preset.layers) {
    const samples = Math.floor(l.widthMeters / l.resolutionMeters) + 1;
    const tr = document.createElement('tr');
    tr.className = `role-${l.role}`;
    tr.innerHTML =
      `<td>${l.role}</td><td>${l.widthMeters}×${l.lengthMeters}</td>` +
      `<td>${l.resolutionMeters}</td><td>${(samples * samples).toLocaleString()}</td>`;
    tbody.appendChild(tr);

    const opt = document.createElement('option');
    opt.value = l.role;
    opt.textContent = `${l.role} (${l.resolutionMeters} m)`;
    select.appendChild(opt);
  }
  const finest = preset.layers.reduce((a, b) =>
    a.resolutionMeters <= b.resolutionMeters ? a : b,
  );
  select.value = finest.role;
  setStatus('status-layer', finest.role);
  setStatus('status-resolution', `${finest.resolutionMeters} m`);
  const ctx = preset.layers.reduce((a, b) => (a.widthMeters >= b.widthMeters ? a : b));
  setStatus('status-dimensions', `${ctx.widthMeters}×${ctx.lengthMeters} m`);
}

function renderProceduralRows(): void {
  const cfg = presetToConfig(currentPreset(), {
    terrainId: 'x',
    seed: 'x',
    outputDirectory: 'x',
  });
  const stack = cfg.proceduralStack as Array<{
    id: string;
    model: string;
    fractal: { octaves: number; frequency: number; amplitude: number };
  }>;
  const host = $('procedural-rows');
  host.innerHTML = '';
  for (const s of stack) {
    const row = document.createElement('div');
    row.className = 'chips';
    row.innerHTML =
      `<span style="color:var(--text)">${s.id}</span>` +
      `<span style="color:var(--muted)">${s.model} · ${s.fractal.octaves} oct · ` +
      `λ≈${(1 / s.fractal.frequency).toFixed(2)} m · ±${s.fractal.amplitude} m</span>`;
    host.appendChild(row);
  }
}

// ------------------------------------------------------------ sidecar calls

async function connect(): Promise<void> {
  const url = ($('sidecar-url') as HTMLInputElement).value;
  try {
    await client.connect(url);
    const health = await client.call<{ protocolVersion: string; generatorVersion: string }>(
      'terrain.health',
    );
    setStatus('status-sidecar', `connected · protocol ${health.protocolVersion}`);
  } catch (e) {
    setStatus('status-sidecar', `unreachable: ${(e as Error).message}`);
  }
}

async function estimate(): Promise<void> {
  const config = buildConfig();
  try {
    const r = await client.call<{
      estimate: { totalFieldBytes: number; totalTiles: number; totalSamples: number; warnings: string[] };
      feasible: boolean;
      error: { code: string; message: string } | null;
    }>('terrain.estimate', { config });
    setStatus('status-memory', `${(r.estimate.totalFieldBytes / 1e6).toFixed(1)} MB`);
    const lines = [
      `samples   ${r.estimate.totalSamples.toLocaleString()}`,
      `fields    ${(r.estimate.totalFieldBytes / 1e6).toFixed(1)} MB`,
      `tiles     ${r.estimate.totalTiles}`,
      `feasible  ${r.feasible ? 'yes' : `NO — ${r.error?.code}`}`,
      ...r.estimate.warnings.map((w) => `\n! ${w}`),
    ];
    log('export-result', lines.join('\n'), r.feasible ? 'pass' : 'fail');
  } catch (e) {
    log('export-result', describeError(e), 'fail');
  }
}

function describeError(e: unknown): string {
  if (e instanceof RpcError) {
    return `${e.terrainCode ?? e.code}: ${e.message}\n${JSON.stringify(e.data, null, 2)}`;
  }
  return (e as Error).message ?? String(e);
}

let generating = false;

async function generate(): Promise<void> {
  // The server refuses concurrent generates with a structured error, but a
  // double-click should not even send the second request: the first finally{}
  // would hide the progress overlay while the second job still runs.
  if (generating) return;
  generating = true;
  ($('btn-generate') as HTMLButtonElement).disabled = true;
  const config = buildConfig();
  $('progress-overlay').hidden = false;
  const started = performance.now();

  client.onProgress = (evt) => {
    ($('progress-fill') as HTMLElement).style.width = `${(evt.progress * 100).toFixed(0)}%`;
    $('progress-stage').textContent = `${evt.stage} ${(evt.progress * 100).toFixed(0)}%`;
    setStatus('status-job', evt.stage);
  };

  try {
    const start = await client.call<{ jobId: string }>('terrain.generate', { config });
    let status: { status: string; error?: { code: string; message: string } } | undefined;
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      status = await client.call('terrain.getStatus', { jobId: start.jobId });
      if (status!.status === 'complete' || status!.status === 'failed' || status!.status === 'cancelled') break;
    }
    if (status!.status !== 'complete') {
      log('export-result', `generation ${status!.status}: ${status!.error?.message ?? ''}`, 'fail');
      return;
    }
    setStatus('perf-generate', `${Math.round(performance.now() - started)} ms`);
    setStatus('status-job', 'complete');
    await loadDataset();
  } catch (e) {
    log('export-result', describeError(e), 'fail');
  } finally {
    $('progress-overlay').hidden = true;
    generating = false;
    ($('btn-generate') as HTMLButtonElement).disabled = false;
  }
}

interface LayerMeta {
  id: string;
  role: string;
  resolutionMeters: number;
  widthSamples: number;
  heightSamples: number;
  bounds: { minX: number; minZ: number };
  elevationProvenance: string;
}

async function fetchLayers(): Promise<
  Array<LayerMeta & { heights: Float32Array }>
> {
  const ds = await client.call<{
    terrainId: string;
    seed: string;
    origin: { site: { latitudeDeg: number; longitudeDeg: number } };
    layers: LayerMeta[];
    features: { craters: number; rocks: number };
    provenance: Record<string, unknown>;
  }>('terrain.getDataset');

  setStatus('insp-terrain', ds.terrainId);
  setStatus('insp-seed', ds.seed);
  setStatus('status-seed', ds.seed);
  setStatus(
    'insp-site',
    `${ds.origin.site.latitudeDeg.toFixed(4)}°, ${ds.origin.site.longitudeDeg.toFixed(4)}°`,
  );
  setStatus('insp-layers', String(ds.layers.length));
  setStatus('insp-craters', ds.features.craters.toLocaleString());
  setStatus('insp-rocks', ds.features.rocks.toLocaleString());

  const prov = ds.provenance as {
    dataSources?: Array<{ id: string; citation: string }>;
    syntheticHeuristics?: string[];
  };
  const provText = [
    ...(prov.dataSources ?? []).map((d) => `source: ${d.id}\n  ${d.citation}`),
    ...(prov.syntheticHeuristics ?? []).map((h) => `synthetic: ${h}`),
  ].join('\n\n');
  log('insp-provenance', provText || 'fully synthetic — no measured DEM used');

  // Stream each layer's heightfield, decimated server-side.
  //
  // A 3001x3001 operational layer is 36 MB of float32 and 48 MB base64 — far
  // too much to pull for a preview. `stride` bounds every layer to roughly
  // PREVIEW_MAX_SIDE samples per edge (~1 MB). The rendered mesh is therefore a
  // preview; authoritative elevations come from terrain.getHeight, which reads
  // the full-resolution field.
  const PREVIEW_MAX_SIDE = 512;
  const out: Array<LayerMeta & { heights: Float32Array }> = [];
  for (const layer of ds.layers) {
    const stride = Math.max(
      1,
      Math.ceil(Math.max(layer.widthSamples, layer.heightSamples) / PREVIEW_MAX_SIDE),
    );
    const tile = await client.call<{
      data: string;
      width: number;
      height: number;
      resolutionMeters: number;
    }>('terrain.getTile', {
      layerId: layer.id,
      col0: 0,
      row0: 0,
      width: layer.widthSamples,
      height: layer.heightSamples,
      stride,
    });
    out.push({
      ...layer,
      widthSamples: tile.width,
      heightSamples: tile.height,
      resolutionMeters: tile.resolutionMeters,
      heights: decodeTile(tile.data),
    });
  }
  return out;
}

/**
 * Monotonic token for loadDataset calls.
 *
 * Tile streaming awaits one RPC per layer, and callers are fire-and-forget
 * (brush strokes, generate completion), so two loads can interleave. Without
 * sequencing, whichever finished LAST installed its layers — not the one
 * started last — and a load could stitch together tiles from before and after
 * a concurrent edit. Stale loads now discard their results.
 */
let loadGeneration = 0;

async function loadDataset(): Promise<void> {
  const myGeneration = ++loadGeneration;
  const layers = await fetchLayers();
  if (myGeneration !== loadGeneration) return; // superseded — discard
  currentLayers = layers;
  viewer.setLayers(
    currentLayers.map((l) => ({
      id: l.id,
      role: l.role,
      heights: l.heights,
      widthSamples: l.widthSamples,
      heightSamples: l.heightSamples,
      resolutionMeters: l.resolutionMeters,
      minX: l.bounds.minX,
      minZ: l.bounds.minZ,
    })),
  );
  applyVisualization();
  await refreshSolar();

  try {
    const rocks = await client.call<{ rocks: unknown[] }>('terrain.getManifest', {
      directory: ($('cfg-output') as HTMLInputElement).value,
    });
    void rocks;
  } catch {
    // Manifest is optional for display; the viewport does not depend on it.
  }
}

async function refreshSolar(): Promise<void> {
  try {
    const s = await client.call<{
      elevationDeg: number;
      azimuthDeg: number;
      subSolar: { latitudeDeg: number };
    }>('terrain.getSolar', { epochUtc: ($('cfg-epoch') as HTMLInputElement).value });

    setStatus('solar-elevation', `${s.elevationDeg.toFixed(4)}°`);
    setStatus('solar-azimuth', `${s.azimuthDeg.toFixed(3)}°`);
    setStatus('solar-subsolar', `${s.subSolar.latitudeDeg.toFixed(4)}°`);
    setStatus(
      'solar-shadow',
      s.elevationDeg > 0
        ? `${(1 / Math.tan((s.elevationDeg * Math.PI) / 180)).toFixed(1)} m`
        : 'sun below horizon',
    );
    viewer.setSolar(s.azimuthDeg, s.elevationDeg);
  } catch (e) {
    setStatus('solar-elevation', 'unavailable');
    void e;
  }
}

async function exportTerrain(): Promise<void> {
  try {
    const r = await client.call<{
      outputDirectory: string;
      artifacts: number;
      totalBytes: number;
      validation: { passed: boolean; errors: number };
    }>('terrain.export', {
      outputDirectory: ($('cfg-output') as HTMLInputElement).value,
      // The format checkboxes were previously wired to nothing: unchecking
      // EXR still exported EXR. They now travel with the request.
      formats: {
        exr: ($('fmt-exr') as HTMLInputElement).checked,
        png16: ($('fmt-png') as HTMLInputElement).checked,
        glb: ($('fmt-glb') as HTMLInputElement).checked,
      },
    });
    log(
      'export-result',
      `${r.artifacts} artifacts, ${(r.totalBytes / 1e6).toFixed(1)} MB\n${r.outputDirectory}\n` +
        `validation: ${r.validation.passed ? 'PASSED' : `FAILED (${r.validation.errors} errors)`}`,
      r.validation.passed ? 'pass' : 'fail',
    );
  } catch (e) {
    log('export-result', describeError(e), 'fail');
  }
}

async function validate(): Promise<void> {
  try {
    const r = await client.call<{
      outputDirectory: string;
      validation: { passed: boolean; errors: number };
    }>('terrain.export', {
      outputDirectory: ($('cfg-output') as HTMLInputElement).value,
      // The format checkboxes were previously wired to nothing: unchecking
      // EXR still exported EXR. They now travel with the request.
      formats: {
        exr: ($('fmt-exr') as HTMLInputElement).checked,
        png16: ($('fmt-png') as HTMLInputElement).checked,
        glb: ($('fmt-glb') as HTMLInputElement).checked,
      },
    });
    log(
      'validation-result',
      r.validation.passed
        ? `PASSED — 0 errors\n${r.outputDirectory}`
        : `FAILED — ${r.validation.errors} errors\n${r.outputDirectory}`,
      r.validation.passed ? 'pass' : 'fail',
    );
  } catch (e) {
    log('validation-result', describeError(e), 'fail');
  }
}

// ----------------------------------------------------------------- editing

async function applyStoredOperation(
  operation: Record<string, unknown>,
  pushUndo: boolean,
): Promise<boolean> {
  if (!client.connected) return false;
  try {
    const r = await client.call<{
      delta: {
        deltaId: string;
        changedTiles: string[];
        massBalance: { removedVolumeM3: number; depositedVolumeM3: number; relativeError: number };
      };
      reposeClamp?: {
        requestedHeightMeters: number;
        appliedHeightMeters: number;
        reposeAngleDeg: number;
      };
    }>('terrain.applyOperation', { operation });

    if (pushUndo) undoStack.push(operation);
    const mb = r.delta.massBalance;
    $('edit-status').textContent =
      `${r.delta.deltaId}: ${r.delta.changedTiles.length} tiles · ` +
      `cut ${mb.removedVolumeM3.toFixed(3)} m³ · fill ${mb.depositedVolumeM3.toFixed(3)} m³ · ` +
      `error ${(mb.relativeError * 100).toFixed(2)}%` +
      // A spoil pile steeper than the regolith angle of repose is clamped by
      // the server (spec §11); the clamp is reported, never silent.
      (r.reposeClamp
        ? ` · height clamped to ${r.reposeClamp.appliedHeightMeters.toFixed(3)} m ` +
          `by ${r.reposeClamp.reposeAngleDeg} deg repose`
        : '');
    await loadDataset();
    // Keep the history panel current once the user has looked at it; before
    // the first Refresh there is nothing on screen to keep in sync.
    if (historyFetched && client.connected) void refreshHistory();
    return true;
  } catch (e) {
    $('edit-status').textContent = describeError(e);
    return false;
  }
}

// ----------------------------------------------------------------- history

/** True once the user has opened (refreshed) the History panel. */
let historyFetched = false;

interface OperationLogEntry {
  kind: string;
  radiusMeters: number;
  timestamp: string;
  [key: string]: unknown;
}

/** History inspection (spec §12): render the server's operation log. */
async function refreshHistory(): Promise<void> {
  if (!client.connected) return;
  historyFetched = true;
  const host = $('history-rows');
  try {
    const r = await client.call<{ operations: OperationLogEntry[] }>('terrain.getOperationLog');
    host.textContent = '';
    if (r.operations.length === 0) {
      host.textContent = 'no operations recorded';
      return;
    }
    r.operations.forEach((op, i) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      // Time-of-day only — a full ISO stamp per row would drown the kind.
      const tod = op.timestamp ? new Date(op.timestamp).toISOString().slice(11, 19) : '—';
      row.textContent = `#${i} ${op.kind} r=${Number(op.radiusMeters).toFixed(1)} m ${tod}`;
      host.appendChild(row);
    });
  } catch (e) {
    host.textContent = describeError(e);
  }
}

/**
 * Re-apply the full operation log onto the CURRENT terrain.
 *
 * terrain.replayLog runs each record through the applyOperation path against
 * whatever the terrain holds now — it does not reset first. The deterministic
 * replay contract (spec §12) is regenerate-then-replay; applied here, on an
 * already-edited terrain, every edit lands a second time on top of itself,
 * which is why the button says "Re-apply log", not "Restore".
 */
async function replayHistory(): Promise<void> {
  if (!client.connected) return;
  try {
    const log = await client.call<{ operations: OperationLogEntry[] }>('terrain.getOperationLog');
    if (log.operations.length === 0) {
      $('edit-status').textContent = 'operation log is empty — nothing to re-apply';
      return;
    }
    const r = await client.call<{ applied: number; finalChecksum: string }>('terrain.replayLog', {
      operations: log.operations,
    });
    $('edit-status').textContent =
      `re-applied ${r.applied} operation(s) on top of the current terrain · ` +
      `checksum ${r.finalChecksum.slice(0, 12)}…`;
    await loadDataset();
    await refreshHistory();
  } catch (e) {
    $('edit-status').textContent = describeError(e);
  }
}

/**
 * Target elevation for the active brush: the surface height at the reference
 * point (the click, or the polygon centroid) unless the user unticked "auto"
 * and typed an explicit elevation. Auto is the default and matches the
 * pre-existing behaviour of every brush.
 */
function resolveTargetElevation(x: number, z: number): number {
  const auto = ($('brush-target-auto') as HTMLInputElement).checked;
  const surface = viewer.surfaceHeightAt(x, z);
  if (auto || !TARGET_KINDS.has(activeBrush ?? '')) {
    // Reflect the auto value into the override field so unticking "auto"
    // starts from a real elevation rather than a stale one.
    ($('brush-target') as HTMLInputElement).value = surface.toFixed(3);
    return surface;
  }
  return Number(($('brush-target') as HTMLInputElement).value);
}

async function applyBrushAt(x: number, z: number): Promise<void> {
  if (!activeBrush || !client.connected) return;
  if (POLYGON_KINDS.has(activeBrush)) {
    // Polygon brushes collect vertices; the operation is sent by
    // applyPolygon (Enter / "Apply polygon"), not per click.
    polygonVertices.push([x, z]);
    viewer.addPolygonPreview(polygonVertices);
    $('edit-status').textContent =
      `polygon: ${polygonVertices.length} vertices — ` +
      `Enter or "Apply polygon" submits, Escape or "Clear" resets`;
    return;
  }
  const num = (id: string) => Number(($(id) as HTMLInputElement).value);
  // `slope` descends along its (required) heading — an ADR 0002 azimuth,
  // clockwise from north — so it reads the same heading field the
  // construction kinds use.
  const usesHeading = HEADING_KINDS.has(activeBrush) || activeBrush === 'slope';
  const heading = usesHeading ? num('brush-heading') : 0;
  const length = HEADING_KINDS.has(activeBrush) ? num('brush-length') : num('brush-radius') * 4;
  const operation: Record<string, unknown> = {
    kind: activeBrush,
    centerXMeters: x,
    centerZMeters: z,
    radiusMeters: num('brush-radius'),
    strengthMeters: num('brush-strength'),
    falloff: num('brush-falloff'),
    massConserving: ($('brush-mass-conserving') as HTMLInputElement).checked,
    headingDegrees: heading,
    lengthMeters: length,
    targetElevationMeters: resolveTargetElevation(x, z),
  };
  // The server requires these per kind and refuses their absence with a
  // structured error (protocol.md kind table).
  if (activeBrush === 'noise') {
    operation.noiseSeed = ($('brush-noise-seed') as HTMLInputElement).value;
  }
  if (activeBrush === 'semantic_paint') {
    operation.semanticClass = ($('brush-semantic-class') as HTMLSelectElement).value;
  }
  // A NEW stroke invalidates the redo history; undo/redo themselves do not.
  if (await applyStoredOperation(operation, true)) redoStack.length = 0;
}

/** Submit the collected polygon as a polygonal_cut / polygonal_fill. */
async function applyPolygon(): Promise<void> {
  if (!activeBrush || !POLYGON_KINDS.has(activeBrush) || !client.connected) return;
  if (polygonVertices.length < 3) {
    $('edit-status').textContent =
      `polygon needs at least 3 vertices (have ${polygonVertices.length})`;
    return;
  }
  const num = (id: string) => Number(($(id) as HTMLInputElement).value);
  // The centroid stands in for the brush centre: it anchors the auto target
  // elevation and the (otherwise unused) centre coordinates.
  const cx = polygonVertices.reduce((s, v) => s + v[0], 0) / polygonVertices.length;
  const cz = polygonVertices.reduce((s, v) => s + v[1], 0) / polygonVertices.length;
  const operation = {
    kind: activeBrush,
    centerXMeters: cx,
    centerZMeters: cz,
    radiusMeters: num('brush-radius'),
    strengthMeters: num('brush-strength'),
    falloff: num('brush-falloff'),
    massConserving: ($('brush-mass-conserving') as HTMLInputElement).checked,
    targetElevationMeters: resolveTargetElevation(cx, cz),
    polygonXZ: polygonVertices.map((v) => [v[0], v[1]]),
  };
  if (await applyStoredOperation(operation, true)) {
    redoStack.length = 0;
    clearPolygon(false); // keep the delta report applyStoredOperation just wrote
  }
}

/** Drop the in-progress polygon. `announce` writes to edit-status. */
function clearPolygon(announce: boolean): void {
  polygonVertices.length = 0;
  viewer.clearPolygonPreview();
  if (announce) $('edit-status').textContent = 'polygon cleared';
}

/** Show only the parameter fields the active brush actually uses. */
function updateBrushParamVisibility(): void {
  const kind = activeBrush ?? '';
  // `slope` shares the heading field: its gradient descends along an
  // ADR 0002 azimuth exactly like the construction kinds' axes.
  $('param-heading').hidden = !(HEADING_KINDS.has(kind) || kind === 'slope');
  $('param-length').hidden = !HEADING_KINDS.has(kind);
  $('param-target-auto').hidden = !TARGET_KINDS.has(kind);
  $('param-target').hidden = !TARGET_KINDS.has(kind);
  $('param-noise-seed').hidden = kind !== 'noise';
  $('param-semantic-class').hidden = kind !== 'semantic_paint';
  $('polygon-controls').hidden = !POLYGON_KINDS.has(kind);
}

/** Kinds whose stored parameters fully determine an exact inverse. */
const INVERTIBLE_KINDS: Record<string, string> = {
  raise: 'lower',
  lower: 'raise',
  berm: 'trench',
  trench: 'berm',
};

/**
 * Undo re-applies the exact inverse operation.
 *
 * Only raise/lower/berm/trench are invertible from the stored record; smooth,
 * flatten, crater_stamp, slope, noise, semantic_paint (the overwritten mask
 * classes are not stored) and every construction kind (ramp, pad, spoil_pile,
 * wheel_track, polygonal_cut, polygonal_fill) destroy information (the
 * pre-edit surface is gone),
 * so "undoing" them by re-applying anything would corrupt the terrain further
 * — the honest behaviour is to refuse with an explanation. This replaced code
 * whose fallback re-applied the SAME operation: undoing a crater stamped a
 * second crater on top of the first.
 */
async function undo(): Promise<void> {
  const op = undoStack.pop();
  if (!op) return;

  const kind = String(op.kind);
  const inverseKind = INVERTIBLE_KINDS[kind];
  if (!inverseKind) {
    // Not invertible: put it back so the history stays truthful.
    undoStack.push(op);
    $('edit-status').textContent =
      `cannot undo '${kind}': it is not invertible from the operation record ` +
      `(the pre-edit surface is not stored). Regenerate to reset.`;
    return;
  }

  const inverse = { ...op, kind: inverseKind };
  // The inverse is NOT pushed onto the undo stack (it would undo the undo);
  // the original op goes to the redo stack instead.
  if (await applyStoredOperation(inverse, false)) {
    redoStack.push(op);
    $('edit-status').textContent = `undid ${kind}`;
  } else {
    undoStack.push(op); // failed — restore history
  }
}

/**
 * Redo re-applies the EXACT stored operation — not, as before, a new operation
 * built from whatever brush and parameters the UI happens to have selected now.
 */
async function redo(): Promise<void> {
  const op = redoStack.pop();
  if (!op) return;
  if (await applyStoredOperation(op, true)) {
    $('edit-status').textContent = `redid ${String(op.kind)}`;
  } else {
    redoStack.push(op);
  }
}

// --------------------------------------------------------------- viewport

function applyVisualization(): void {
  const overlay = ($('viz-overlay') as HTMLSelectElement).value as OverlayMode;
  viewer.setOverlay(overlay);
  viewer.setWireframe(($('viz-wireframe') as HTMLInputElement).checked);
  viewer.setHelpers({
    grid: ($('viz-grid') as HTMLInputElement).checked,
    tileBounds: ($('viz-tilebounds') as HTMLInputElement).checked,
    contours: ($('viz-contours') as HTMLInputElement).checked,
  });
  viewer.setEarthshine(($('viz-earthshine') as HTMLInputElement).checked);
  viewer.setCameraMode(($('viz-camera') as HTMLSelectElement).value as CameraMode);

  const legend = overlayLegend(overlay);
  $('legend-title').textContent = legend.title;
  $('legend-note').textContent = legend.note;
}

/**
 * Authoritative point query, throttled.
 *
 * The rendered mesh is a decimated preview, so reading elevation off it would
 * report a smoothed value. Anything a user might act on is asked of the
 * sidecar, which holds the full-resolution field.
 */
let pointQueryPending = false;
async function queryPointAuthoritative(x: number, z: number): Promise<void> {
  if (pointQueryPending || !client.connected) return;
  pointQueryPending = true;
  try {
    const [h, sem, trav] = await Promise.all([
      client.call<{ elevationM: number; layerId: string | null }>('terrain.getHeight', { x, z }),
      client.call<{ semanticClass: string | null }>('terrain.getSemanticClass', { x, z }),
      client.call<{ traversability: { score: number; slopeDeg: number } | null }>(
        'terrain.getTraversability',
        { x, z },
      ),
    ]);
    if (Number.isFinite(h.elevationM)) {
      setStatus('insp-elevation', `${h.elevationM.toFixed(4)} m`);
      setStatus('status-elevation', `${h.elevationM.toFixed(4)} m`);
    }
    setStatus('insp-semantic', sem.semanticClass ?? '—');
    if (trav.traversability) {
      setStatus('insp-slope', `${trav.traversability.slopeDeg.toFixed(2)}°`);
      setStatus('insp-trav', trav.traversability.score.toFixed(3));
    }
  } catch {
    // A dropped query is not worth surfacing; the preview values still show.
  } finally {
    pointQueryPending = false;
  }
}

function updateCursorReadout(x: number, z: number): void {
  setStatus('status-cursor', `${x.toFixed(3)}, ${z.toFixed(3)} m`);
  // Instant feedback from the preview mesh, then the authoritative value.
  const y = viewer.surfaceHeightAt(x, z);
  setStatus('status-elevation', `${y.toFixed(4)} m`);
  setStatus('insp-xz', `${x.toFixed(2)}, ${z.toFixed(2)}`);
  setStatus('insp-elevation', `${y.toFixed(4)} m`);
  void queryPointAuthoritative(x, z);

  const layer = currentLayers.reduce<(typeof currentLayers)[number] | undefined>((best, l) => {
    const maxX = l.bounds.minX + (l.widthSamples - 1) * l.resolutionMeters;
    const maxZ = l.bounds.minZ + (l.heightSamples - 1) * l.resolutionMeters;
    if (x < l.bounds.minX || x > maxX || z < l.bounds.minZ || z > maxZ) return best;
    return !best || l.resolutionMeters < best.resolutionMeters ? l : best;
  }, undefined);
  if (!layer) return;

  const col = Math.round((x - layer.bounds.minX) / layer.resolutionMeters);
  const row = Math.round((z - layer.bounds.minZ) / layer.resolutionMeters);
  const slope = slopeDegAt(
    layer.heights,
    layer.widthSamples,
    layer.heightSamples,
    col,
    row,
    layer.resolutionMeters,
  );
  const rough = roughnessAt(layer.heights, layer.widthSamples, layer.heightSamples, col, row);
  setStatus('insp-slope', `${slope.toFixed(2)}°`);
  setStatus(
    'insp-trav',
    traversabilityScore(slope, rough, layer.resolutionMeters).toFixed(3),
  );
  setStatus('status-layer', layer.role);
  setStatus('status-resolution', `${layer.resolutionMeters} m`);
}

// ------------------------------------------------------------------- boot

function wireUi(): void {
  $('btn-connect').addEventListener('click', () => void connect());
  $('btn-estimate').addEventListener('click', () => void estimate());
  $('btn-generate').addEventListener('click', () => void generate());
  $('btn-export').addEventListener('click', () => void exportTerrain());
  $('btn-validate').addEventListener('click', () => void validate());
  $('btn-solar').addEventListener('click', () => void refreshSolar());
  $('btn-undo').addEventListener('click', () => void undo());
  $('btn-redo').addEventListener('click', () => void redo());
  $('btn-history-refresh').addEventListener('click', () => void refreshHistory());
  $('btn-history-replay').addEventListener('click', () => void replayHistory());

  $('btn-new').addEventListener('click', () => {
    ($('cfg-seed') as HTMLInputElement).value = `site-${Date.now().toString(36)}`;
    renderLayerTable();
  });
  $('btn-save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(buildConfig(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${($('cfg-terrain-id') as HTMLInputElement).value}.json`;
    a.click();
  });
  $('btn-load').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const cfg = JSON.parse(await file.text());
      ($('cfg-terrain-id') as HTMLInputElement).value = cfg.terrainId ?? '';
      ($('cfg-seed') as HTMLInputElement).value = cfg.seed ?? '';
      ($('cfg-lat') as HTMLInputElement).value = String(cfg.site?.latitudeDeg ?? '');
      ($('cfg-lon') as HTMLInputElement).value = String(cfg.site?.longitudeDeg ?? '');
    };
    input.click();
  });

  ($('cfg-preset') as HTMLSelectElement).addEventListener('change', () => {
    const p = currentPreset();
    ($('cfg-lat') as HTMLInputElement).value = String(p.site.latitudeDeg);
    ($('cfg-lon') as HTMLInputElement).value = String(p.site.longitudeDeg);
    ($('cfg-dem-enabled') as HTMLInputElement).checked = p.demEnabled;
    ($('cfg-crater-age') as HTMLInputElement).value = String(p.craters.surfaceAgeGyr);
    ($('cfg-rock-k') as HTMLInputElement).value = String(
      p.rocks.cumulativeFractionalAreaCovered,
    );
    renderLayerTable();
    renderProceduralRows();
  });

  for (const id of ['viz-overlay', 'viz-camera', 'viz-wireframe', 'viz-grid', 'viz-tilebounds', 'viz-contours', 'viz-earthshine']) {
    $(id).addEventListener('change', applyVisualization);
  }

  // Sculpting and construction chips share one active-brush selection.
  const brushRows = ['brush-buttons', 'construction-buttons'];
  const allBrushButtons = () =>
    brushRows.flatMap((id) => Array.from($(id).querySelectorAll('button')));
  for (const btn of allBrushButtons()) {
    btn.addEventListener('click', () => {
      const brush = btn.getAttribute('data-brush');
      activeBrush = activeBrush === brush ? null : brush;
      for (const b of allBrushButtons()) {
        b.classList.toggle('active', b.getAttribute('data-brush') === activeBrush);
      }
      // A half-built polygon is meaningless under a non-polygon brush.
      if (!POLYGON_KINDS.has(activeBrush ?? '')) clearPolygon(false);
      updateBrushParamVisibility();
    });
  }

  $('btn-polygon-apply').addEventListener('click', () => void applyPolygon());
  $('btn-polygon-clear').addEventListener('click', () => clearPolygon(true));
  window.addEventListener('keydown', (e) => {
    if (!activeBrush || !POLYGON_KINDS.has(activeBrush)) return;
    // Never hijack Enter/Escape from a form field.
    const tag = (document.activeElement?.tagName ?? '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void applyPolygon();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearPolygon(true);
    }
  });

  const canvas = $('canvas') as HTMLCanvasElement;
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = viewer.pick(ndcX, ndcY);
    if (hit) updateCursorReadout(hit.x, hit.z);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (!activeBrush || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const hit = viewer.pick(ndcX, ndcY);
    if (hit) void applyBrushAt(hit.x, hit.z);
  });

  client.onStateChange = (state, detail) => {
    const ind = $('connection-indicator');
    ind.className = `indicator ${state}`;
    $('connection-label').textContent = state;
    setStatus('status-sidecar', detail ? `${state} — ${detail}` : state);
  };
}

function boot(): void {
  const canvas = $('canvas') as HTMLCanvasElement;
  viewer = new Viewer(canvas);

  const resize = () => {
    const rect = ($('viewport') as HTMLElement).getBoundingClientRect();
    viewer.setSize(Math.max(1, rect.width), Math.max(1, rect.height));
  };
  window.addEventListener('resize', resize);
  resize();

  wireUi();
  renderLayerTable();
  renderProceduralRows();
  applyVisualization();
  // A plausible grazing angle until the ephemeris answers.
  viewer.setSolar(80, 1.2);

  let frames = 0;
  let last = performance.now();
  const loop = () => {
    viewer.render();
    frames++;
    const now = performance.now();
    if (now - last >= 1000) {
      setStatus('perf-fps', String(frames));
      setStatus('perf-draws', String(viewer.renderer.info.render.calls));
      setStatus('perf-tris', viewer.renderer.info.render.triangles.toLocaleString());
      frames = 0;
      last = now;
    }
    requestAnimationFrame(loop);
  };
  loop();

  // Expose for the Playwright checks; also handy in the browser console.
  (window as unknown as Record<string, unknown>).__lts = {
    viewer,
    client,
    buildConfig,
    connect,
    generate,
    loadDataset,
    applyVisualization,
  };
  document.body.setAttribute('data-ready', 'true');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
