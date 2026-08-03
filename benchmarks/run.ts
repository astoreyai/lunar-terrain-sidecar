/**
 * Benchmark suite (spec §27: performance claims require benchmarks).
 *
 * Measures real work only — every number printed comes from executing the
 * actual pipeline, exporter, edit path and tile encoder in this repository.
 * Nothing is estimated, extrapolated or fabricated.
 *
 * Run from the repository root:
 *
 *     npx tsx --tsconfig tsconfig.json benchmarks/run.ts          # default suite
 *     npx tsx --tsconfig tsconfig.json benchmarks/run.ts --full   # + 50 m × 50 m @ 1 cm
 *
 * Timing policy (stated per row in the output):
 *   - one global warm-up generation runs before anything is timed;
 *   - each benchmark gets an untimed warm-up where cheap (export, encode, ops);
 *   - a probe run is timed first; if it finishes in under 10 s, two more timed
 *     runs follow and the MEDIAN of the 3 is reported ("median-of-3");
 *     otherwise the probe stands alone ("single-run").
 *
 * Results go to stdout (human table) and to
 * benchmarks/results/<ISO-date>-<hostname>.json (machine-readable, with
 * hardware context).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, hostname, platform, release, arch } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { parseConfig, type TerrainConfig, type TerrainDataset, type TerrainLayer } from '@lts/shared-types';
import { generateTerrain, type GenerateResult } from '@lts/terrain-pipeline';
import { exportTerrain } from '@lts/terrain-export';
import type { TerrainOperation } from '@lts/terrain-protocol';
import { applyOperation } from '../apps/headless-server/src/operations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FULL = process.argv.includes('--full');
const DEM_PATH = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';
const SITE = { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528, datumElevationM: 0 };
const MEDIAN_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------- helpers --

interface Measurement {
  name: string;
  policy: string;
  /** All timed runs, ms. */
  runsMs: number[];
  /** The reported figure: median of runsMs (median-of-3) or the single run. */
  ms: number;
  meta: Record<string, unknown>;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/**
 * Adaptive timing: probe once; under the threshold, run twice more and report
 * the median of 3. `fn` must perform the full unit of work each call and
 * returns metadata kept from the LAST run.
 */
async function measure(
  name: string,
  fn: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<Measurement> {
  const runsMs: number[] = [];
  let meta: Record<string, unknown> = {};

  const t0 = performance.now();
  meta = await fn();
  runsMs.push(performance.now() - t0);

  let policy = 'single-run (probe ≥ 10 s)';
  if (runsMs[0] < MEDIAN_THRESHOLD_MS) {
    policy = 'median-of-3';
    for (let i = 0; i < 2; i++) {
      const t = performance.now();
      meta = await fn();
      runsMs.push(performance.now() - t);
    }
  }
  return { name, policy, runsMs, ms: median(runsMs), meta };
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${b} B`;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|-' + widths.map((w) => '-'.repeat(w)).join('-|-') + '-|';
  return [line(header), sep, ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------- configs --

/** The demonstration site's procedural/feature parameters (examples/south_pole_site_01). */
const STACK = [
  {
    id: 'sub_dem_relief',
    model: 'warped_fbm',
    enabled: true,
    fractal: { octaves: 6, lacunarity: 2.0, persistence: 0.5, frequency: 0.2, amplitude: 0.12, anisotropy: 1.0 },
    warpStrengthM: 1.5,
    warpFrequency: 0.06,
  },
  {
    id: 'fine_roughness',
    model: 'fbm',
    enabled: true,
    fractal: { octaves: 5, lacunarity: 2.1, persistence: 0.55, frequency: 2.0, amplitude: 0.02, anisotropy: 1.0 },
  },
];

function benchConfig(
  id: string,
  layers: Array<{ role: 'context' | 'mission' | 'operational'; widthMeters: number; lengthMeters: number; resolutionMeters: number }>,
  withDem: boolean,
): TerrainConfig {
  return parseConfig({
    terrainId: id,
    seed: `bench-${id}`,
    site: SITE,
    layers,
    tileSizeSamples: 256,
    ...(withDem
      ? {
          dem: {
            enabled: true,
            path: DEM_PATH,
            applyToRoles: layers.map((l) => l.role),
            effectiveResolutionMeters: 17.5,
          },
        }
      : {}),
    proceduralStack: STACK,
    craters: { enabled: true, model: 'production_csfd', minimumDiameterMeters: 0.2, maximumDiameterMeters: 35, surfaceAgeGyr: 3.5 },
    rocks: { enabled: true, model: 'golombek_sfd', cumulativeFractionalAreaCovered: 0.05, maximumDiameterMeters: 2.5 },
    regolith: { enabled: true, microreliefAmplitudeM: 0.012, microreliefWavelengthM: 0.35, maximumResolutionMeters: 0.1 },
    solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z', computeHorizon: true, horizonAzimuthBins: 360 },
  });
}

const CONFIGS: Array<{ key: string; label: string; config: TerrainConfig }> = [
  {
    key: 'small',
    label: 'small: 100 m × 100 m @ 1 m',
    config: benchConfig('bench-small', [
      { role: 'context', widthMeters: 100, lengthMeters: 100, resolutionMeters: 1.0 },
    ], false),
  },
  {
    key: 'medium',
    label: 'medium: 1 km @ 2 m + 200 m @ 0.2 m',
    config: benchConfig('bench-medium', [
      { role: 'context', widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2.0 },
      { role: 'mission', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.2 },
    ], false),
  },
  {
    key: 'demo',
    label: 'demo-scale: 1 km @ 2 m + 200 m @ 0.2 m + 30 m @ 0.01 m',
    config: benchConfig('bench-demo', [
      { role: 'context', widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2.0 },
      { role: 'mission', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.2 },
      { role: 'operational', widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.01 },
    ], false),
  },
];

const demAvailableOnDisk = existsSync(DEM_PATH);
if (demAvailableOnDisk) {
  CONFIGS.push({
    key: 'demo-dem',
    label: 'DEM-grounded demo-scale (LOLA 5 mpp Site01, lat −89.4632°)',
    config: benchConfig('bench-demo-dem', [
      { role: 'context', widthMeters: 1000, lengthMeters: 1000, resolutionMeters: 2.0 },
      { role: 'mission', widthMeters: 200, lengthMeters: 200, resolutionMeters: 0.2 },
      { role: 'operational', widthMeters: 30, lengthMeters: 30, resolutionMeters: 0.01 },
    ], true),
  });
}

// ------------------------------------------------------------------ suite --

interface StageEvent {
  stage: string;
  tMs: number;
}

function totalSamples(dataset: TerrainDataset): number {
  return dataset.layers.reduce((a, l) => a + l.widthSamples * l.heightSamples, 0);
}

/** Bytes held by a layer stack: f32 heights + u8 semantic + u8 elevation-source. */
function layerBytes(dataset: TerrainDataset): number {
  return dataset.layers.reduce((a, l) => {
    const n = l.widthSamples * l.heightSamples;
    return a + 4 * n + (l.masks.semantic ? n : 0) + (l.masks.elevationSource ? n : 0);
  }, 0);
}

/** Replicates the terrain.getTile encode path: strided copy + base64. */
function encodeTile(layer: TerrainLayer, stride: number): { samples: number; base64Bytes: number } {
  const w = layer.widthSamples;
  const h = layer.heightSamples;
  const outW = Math.floor((w - 1) / stride) + 1;
  const outH = Math.floor((h - 1) / stride) + 1;
  const out = new Float32Array(outW * outH);
  for (let r = 0; r < outH; r++) {
    const src = r * stride * w;
    for (let c = 0; c < outW; c++) {
      out[r * outW + c] = layer.heightData[src + c * stride];
    }
  }
  const b64 = Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('base64');
  return { samples: outW * outH, base64Bytes: b64.length };
}

function benchOps(layer: TerrainLayer, count: number, warmup: number): number[] {
  // Deterministic operation mix over the layer's interior. These are edit
  // PARAMETERS driving the real applyOperation path, not data standing in for
  // measurements.
  const kinds: TerrainOperation['kind'][] = [
    'raise', 'lower', 'flatten', 'smooth', 'crater_stamp', 'trench', 'berm',
  ];
  const cx = (layer.bounds.minX + layer.bounds.maxX) / 2;
  const cz = (layer.bounds.minZ + layer.bounds.maxZ) / 2;
  const span = Math.min(
    layer.bounds.maxX - layer.bounds.minX,
    layer.bounds.maxZ - layer.bounds.minZ,
  );
  const makeOp = (i: number): TerrainOperation => {
    const kind = kinds[i % kinds.length];
    const angle = i * 2.399963; // golden-angle spiral: spreads ops over the layer
    const r = 0.05 * span + (0.30 * span * (i % 17)) / 17;
    return {
      operationId: `bench-op-${i}`,
      kind,
      layerId: layer.id,
      centerXMeters: cx + r * Math.cos(angle),
      centerZMeters: cz + r * Math.sin(angle),
      radiusMeters: 0.75 + 0.75 * ((i % 5) / 4),
      strengthMeters: 0.1 + 0.3 * ((i % 4) / 3),
      falloff: 2,
      targetElevationMeters: 0,
      headingDegrees: (i * 37) % 360,
      lengthMeters: 3,
      massConserving: i % 3 === 0,
      timestamp: new Date().toISOString(),
    };
  };
  for (let i = 0; i < warmup; i++) applyOperation(layer, makeOp(i));
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const op = makeOp(warmup + i);
    const t0 = performance.now();
    applyOperation(layer, op);
    times.push(performance.now() - t0);
  }
  return times;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const hw = {
    hostname: hostname(),
    platform: `${platform()} ${release()} ${arch()}`,
    cpuModel: cpus()[0].model,
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
    nodeVersion: process.version,
  };

  console.log('lunar-terrain-sidecar benchmark suite (spec §27)');
  console.log(`host: ${hw.hostname} · ${hw.cpuModel} × ${hw.cpuCount} · ` +
    `${(hw.totalMemBytes / 1024 ** 3).toFixed(0)} GiB RAM · node ${hw.nodeVersion}`);
  console.log(`mode: ${FULL ? '--full' : 'default'} · DEM ${demAvailableOnDisk ? 'present' : 'ABSENT'} at ${DEM_PATH}`);
  if (!demAvailableOnDisk) {
    console.log('NOTE: the real LOLA DEM is not on disk — the DEM-grounded benchmark is ' +
      'SKIPPED. No substitute data is used.');
  }
  console.log('');

  const results: Record<string, unknown> = {};

  // Global warm-up: one untimed tiny generation to warm the JIT and module
  // graph before anything is measured.
  const warmupCfg = benchConfig('bench-warmup', [
    { role: 'context', widthMeters: 50, lengthMeters: 50, resolutionMeters: 1.0 },
  ], false);
  await generateTerrain(warmupCfg);

  // ---------------------------------------------- 1. generation time vs size
  console.log('== 1. Terrain generation time vs size ==');
  const genRows: string[][] = [];
  const genResults: Record<string, unknown>[] = [];
  const datasets = new Map<string, GenerateResult>();
  const stageEventsByKey = new Map<string, StageEvent[]>();

  for (const { key, label, config } of CONFIGS) {
    let kept: GenerateResult | undefined;
    let stages: StageEvent[] = [];
    const m = await measure(label, async () => {
      const events: StageEvent[] = [];
      const res = await generateTerrain(config, {
        onProgress: (stage) => events.push({ stage, tMs: performance.now() }),
      });
      kept = res;
      stages = events;
      return {
        samples: totalSamples(res.dataset),
        layerBytes: layerBytes(res.dataset),
        craters: res.dataset.featureManifest.filter((f) => f.kind === 'crater').length,
        rocks: res.dataset.featureManifest.filter((f) => f.kind === 'rock').length,
      };
    });
    datasets.set(key, kept!);
    stageEventsByKey.set(key, stages);
    genRows.push([
      label,
      String(m.meta.samples),
      fmtBytes(m.meta.layerBytes as number),
      String(m.meta.craters),
      String(m.meta.rocks),
      fmtMs(m.ms),
      m.policy,
    ]);
    genResults.push({ key, label, ...m.meta, runsMs: m.runsMs, medianMs: m.ms, policy: m.policy });
  }
  console.log(table(
    ['config', 'samples', 'layer bytes', 'craters', 'rocks', 'time', 'policy'],
    genRows,
  ));
  results.generation = genResults;
  console.log('');

  // -------------------------------------------------------- 2. stage breakdown
  // From the onProgress timestamps of the LAST timed run of the most complete
  // config (DEM-grounded when the DEM is present, otherwise demo-scale).
  const breakdownKey = demAvailableOnDisk ? 'demo-dem' : 'demo';
  const events = stageEventsByKey.get(breakdownKey)!;
  console.log(`== 2. Stage breakdown (${breakdownKey}, last timed run) ==`);
  const stageRows: string[][] = [];
  const stageJson: Record<string, number> = {};
  for (let i = 0; i < events.length - 1; i++) {
    const dur = events[i + 1].tMs - events[i].tMs;
    stageRows.push([events[i].stage, fmtMs(dur)]);
    stageJson[events[i].stage] = dur;
  }
  console.log(table(['stage', 'duration'], stageRows));
  results.stageBreakdown = { config: breakdownKey, stagesMs: stageJson };
  console.log('');

  // ----------------------------------------------- 3. export time by format
  console.log('== 3. Export time and bytes by format (demo-scale dataset) ==');
  const exportDataset = datasets.get('demo')!;
  const formatCases: Array<{ label: string; formats: { exr: boolean; png16: boolean; npy: boolean; glb: boolean } }> = [
    { label: 'rf32-only', formats: { exr: false, png16: false, npy: false, glb: false } },
    { label: 'rf32 + EXR', formats: { exr: true, png16: false, npy: false, glb: false } },
    { label: 'rf32 + PNG16', formats: { exr: false, png16: true, npy: false, glb: false } },
    { label: 'rf32 + GLB', formats: { exr: false, png16: false, npy: false, glb: true } },
  ];
  const exportRows: string[][] = [];
  const exportResults: Record<string, unknown>[] = [];
  {
    // Untimed warm-up export.
    const wdir = mkdtempSync(join(tmpdir(), 'lts-bench-'));
    exportTerrain(exportDataset.dataset, {
      outputDirectory: wdir,
      tileSizeSamples: 256,
      formats: { exr: false, png16: false, npy: false, glb: false },
    });
    rmSync(wdir, { recursive: true, force: true });
  }
  for (const fc of formatCases) {
    // Pure exportTerrain time per run, excluding temp-dir create/remove.
    const pureMs: number[] = [];
    const m = await measure(fc.label, () => {
      const dir = mkdtempSync(join(tmpdir(), 'lts-bench-'));
      const t0 = performance.now();
      const r = exportTerrain(exportDataset.dataset, {
        outputDirectory: dir,
        tileSizeSamples: 256,
        formats: fc.formats,
        solar: exportDataset.solar,
        horizon: exportDataset.horizon,
        notes: exportDataset.notes,
      });
      pureMs.push(performance.now() - t0);
      rmSync(dir, { recursive: true, force: true });
      return { totalBytes: r.totalBytes, artifacts: r.artifacts.length };
    });
    const reportedMs = median(pureMs);
    exportRows.push([
      fc.label,
      String(m.meta.artifacts),
      fmtBytes(m.meta.totalBytes as number),
      fmtMs(reportedMs),
      m.policy,
    ]);
    exportResults.push({
      label: fc.label,
      artifacts: m.meta.artifacts,
      totalBytes: m.meta.totalBytes,
      exportRunsMs: pureMs,
      medianExportMs: reportedMs,
      policy: m.policy,
    });
  }
  console.log(table(['formats', 'artifacts', 'bytes', 'export time (excl. tmp-dir)', 'policy'], exportRows));
  console.log('note: rf32-only still writes semantic/elevation-source masks and manifests — the exporter always emits those.');
  results.export = { dataset: 'demo', cases: exportResults };
  console.log('');

  // ------------------------------------------------ 4. tile update latency
  console.log('== 4. Tile update latency: applyOperation × 50 (demo operational layer, 0.01 m) ==');
  const demoDs = datasets.get('demo')!;
  const opLayer = demoDs.dataset.layers.find((l) => l.role === 'operational')!;
  const opTimes = benchOps(opLayer, 50, 3).sort((a, b) => a - b);
  const opsRow = [
    `${opLayer.id} (${opLayer.widthSamples}×${opLayer.heightSamples} @ ${opLayer.horizontalResolutionMeters} m)`,
    fmtMs(percentile(opTimes, 0.5)),
    fmtMs(percentile(opTimes, 0.95)),
    fmtMs(opTimes[opTimes.length - 1]),
    '50 ops, 3 warm-up, p50/p95',
  ];
  console.log(table(['layer', 'p50', 'p95', 'max', 'policy'], [opsRow]));
  results.tileUpdateLatency = {
    layer: opLayer.id,
    layerSamples: opLayer.widthSamples * opLayer.heightSamples,
    resolutionMeters: opLayer.horizontalResolutionMeters,
    operations: 50,
    warmupOperations: 3,
    p50Ms: percentile(opTimes, 0.5),
    p95Ms: percentile(opTimes, 0.95),
    maxMs: opTimes[opTimes.length - 1],
    allMsSorted: opTimes,
  };
  console.log('');

  // ------------------------------------------- 5. getTile stride streaming
  console.log('== 5. getTile encode: stride 1 vs preview stride (demo operational layer) ==');
  const previewStride = Math.max(1, Math.ceil((opLayer.widthSamples - 1) / 255)); // ≈256² preview
  encodeTile(opLayer, previewStride); // untimed warm-up
  const strideRows: string[][] = [];
  const strideResults: Record<string, unknown>[] = [];
  for (const stride of [1, previewStride]) {
    const m = await measure(`stride ${stride}`, () => {
      const r = encodeTile(opLayer, stride);
      return { ...r };
    });
    strideRows.push([
      stride === 1 ? 'stride 1 (full fidelity)' : `stride ${stride} (preview ≈256²)`,
      String(m.meta.samples),
      fmtBytes(m.meta.base64Bytes as number),
      fmtMs(m.ms),
      m.policy,
    ]);
    strideResults.push({ stride, ...m.meta, runsMs: m.runsMs, medianMs: m.ms, policy: m.policy });
  }
  console.log(table(['request', 'samples', 'base64 bytes', 'encode time', 'policy'], strideRows));
  results.getTileEncode = { layer: opLayer.id, previewStride, cases: strideResults };
  console.log('');

  // --------------------------------- 6. 1 cm operational-region feasibility
  console.log('== 6. 1 cm operational-region feasibility (spec §27) ==');
  const feasCases = [
    { key: 'feas-25', label: '25 m × 25 m @ 0.01 m', width: 25 },
    ...(FULL ? [{ key: 'feas-50', label: '50 m × 50 m @ 0.01 m', width: 50 }] : []),
  ];
  const feasRows: string[][] = [];
  const feasResults: Record<string, unknown>[] = [];
  for (const fc of feasCases) {
    const cfg = benchConfig(`bench-${fc.key}`, [
      { role: 'operational', widthMeters: fc.width, lengthMeters: fc.width, resolutionMeters: 0.01 },
    ], false);
    const m = await measure(fc.label, async () => {
      const res = await generateTerrain(cfg);
      return {
        samples: totalSamples(res.dataset),
        heightfieldBytes: totalSamples(res.dataset) * 4,
        layerBytes: layerBytes(res.dataset),
        craters: res.dataset.featureManifest.filter((f) => f.kind === 'crater').length,
        rocks: res.dataset.featureManifest.filter((f) => f.kind === 'rock').length,
      };
    });
    feasRows.push([
      fc.label,
      String(m.meta.samples),
      fmtBytes(m.meta.heightfieldBytes as number),
      fmtBytes(m.meta.layerBytes as number),
      fmtMs(m.ms),
      m.policy,
    ]);
    feasResults.push({ ...fc, ...m.meta, runsMs: m.runsMs, medianMs: m.ms, policy: m.policy });
  }
  if (!FULL) {
    console.log('(50 m × 50 m case requires --full)');
  }
  console.log(table(
    ['region', 'samples', 'heightfield (f32)', 'with masks', 'generation time', 'policy'],
    feasRows,
  ));
  results.oneCmFeasibility = feasResults;
  console.log('');

  // ------------------------------------------------------------- write JSON
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${startedAt.toISOString().slice(0, 10)}-${hw.hostname}.json`);
  const payload = {
    suite: 'lunar-terrain-sidecar benchmarks (spec §27)',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    mode: FULL ? 'full' : 'default',
    demPath: DEM_PATH,
    demPresent: demAvailableOnDisk,
    timingPolicy: {
      warmup: 'one untimed 50 m @ 1 m generation before any timing; per-benchmark untimed warm-ups for export, encode and edit paths',
      rule: `probe run first; if < ${MEDIAN_THRESHOLD_MS / 1000} s, two more timed runs and the median of 3 is reported; otherwise the single probe run stands`,
    },
    hardware: hw,
    results,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  const totalS = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`results written to ${outPath}`);
  console.log(`total suite wall time: ${totalS} s`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
