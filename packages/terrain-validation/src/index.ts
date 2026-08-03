/**
 * `@lts/terrain-validation` — automated validation of an exported dataset
 * (spec §21).
 *
 * Operates on the **exported artifacts**, not on in-memory objects, so it
 * checks what a consumer will actually load. Produces a machine-readable
 * report.
 *
 * Failures are failures. Nothing here downgrades a failed check to a warning
 * (spec §33: "never hide failed validation behind warnings").
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CheckSeverity = 'error' | 'warning' | 'info';

export interface CheckResult {
  id: string;
  description: string;
  passed: boolean;
  severity: CheckSeverity;
  detail?: string;
  measured?: Record<string, unknown>;
}

export interface ValidationReport {
  terrainId: string;
  passed: boolean;
  checks: CheckResult[];
  errors: number;
  warnings: number;
  generatedAt: string;
}

interface ManifestLayer {
  id: string;
  role: string;
  resolution_m: number;
  width_samples: number;
  height_samples: number;
  bounds: { minimum: number[]; maximum: number[] };
  elevation_provenance: string;
  source_effective_resolution_m: number | null;
}

interface Manifest {
  terrainId: string;
  seed: string;
  coordinate_system: Record<string, unknown>;
  origin: Record<string, unknown>;
  bounds: { minimum: number[]; maximum: number[] };
  layers: ManifestLayer[];
  provenance: Record<string, unknown>;
  artifacts: Array<{ path: string; kind: string; bytes: number; sha256: string }>;
}

function readRawFloat32(path: string): Float32Array {
  const buf = readFileSync(path);
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Validate an exported terrain directory. */
export function validateDataset(directory: string): ValidationReport {
  const checks: CheckResult[] = [];
  const add = (
    id: string,
    description: string,
    passed: boolean,
    severity: CheckSeverity = 'error',
    detail?: string,
    measured?: Record<string, unknown>,
  ) => {
    checks.push({ id, description, passed, severity, detail, measured });
  };

  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      terrainId: '(unknown)',
      passed: false,
      checks: [
        {
          id: 'manifest_present',
          description: 'manifest.json exists',
          passed: false,
          severity: 'error',
          detail: `not found at ${manifestPath}`,
        },
      ],
      errors: 1,
      warnings: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  add('manifest_present', 'manifest.json exists and parses', true, 'info');

  // ------------------------------------------------------------ checksums --
  let checksumFailures = 0;
  let missingFiles = 0;
  for (const a of manifest.artifacts) {
    const p = join(directory, a.path);
    if (!existsSync(p)) {
      missingFiles++;
      continue;
    }
    const data = readFileSync(p);
    if (data.length !== a.bytes) {
      checksumFailures++;
      continue;
    }
    if (createHash('sha256').update(data).digest('hex') !== a.sha256) checksumFailures++;
  }
  add(
    'artifact_files_present',
    'every artifact named in the manifest exists on disk',
    missingFiles === 0,
    'error',
    missingFiles ? `${missingFiles} missing` : undefined,
    { artifacts: manifest.artifacts.length, missing: missingFiles },
  );
  add(
    'checksums_match',
    'every artifact matches its recorded SHA-256',
    checksumFailures === 0,
    'error',
    checksumFailures ? `${checksumFailures} mismatched` : undefined,
    { mismatched: checksumFailures },
  );

  // ------------------------------------------------- coordinate metadata --
  const cs = manifest.coordinate_system;
  const csOk =
    cs?.handedness === 'right' &&
    cs?.up_axis === '+Y' &&
    cs?.east_axis === '+X' &&
    cs?.north_axis === '-Z';
  add(
    'coordinate_system_declared',
    'coordinate system is declared, right-handed, with north on -Z',
    !!csOk,
    'error',
    csOk ? undefined : `got ${JSON.stringify(cs)}`,
  );

  // ---------------------------------------------------------- provenance --
  const prov = manifest.provenance as {
    seeds?: { master?: string };
    configurationHash?: string;
    syntheticHeuristics?: string[];
    dataSources?: unknown[];
  };
  add(
    'provenance_complete',
    'provenance records the master seed and configuration hash',
    !!prov?.seeds?.master && !!prov?.configurationHash,
    'error',
  );
  add(
    'synthetic_labelled',
    'synthetic heuristics are labelled as synthetic',
    Array.isArray(prov?.syntheticHeuristics) && prov.syntheticHeuristics.length > 0,
    'error',
    'spec §22/§33 require heuristic outputs to be marked',
  );

  // --------------------------------------------------------- per layer ----
  for (const layer of manifest.layers) {
    const heightPath = join(directory, `layers/${layer.id}/height.rf32`);
    if (!existsSync(heightPath)) {
      add(`layer_${layer.id}_height`, `${layer.id} raw heightfield exists`, false);
      continue;
    }
    const h = readRawFloat32(heightPath);

    const expected = layer.width_samples * layer.height_samples;
    add(
      `layer_${layer.id}_sample_count`,
      `${layer.id} raster length matches the declared grid`,
      h.length === expected,
      'error',
      h.length === expected ? undefined : `expected ${expected}, got ${h.length}`,
      { expected, actual: h.length },
    );

    let nan = 0;
    let inf = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (Number.isNaN(v)) nan++;
      else if (!Number.isFinite(v)) inf++;
      else {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    add(
      `layer_${layer.id}_finite`,
      `${layer.id} contains no NaN or infinite elevations`,
      nan === 0 && inf === 0,
      'error',
      nan || inf ? `${nan} NaN, ${inf} infinite` : undefined,
      { nan, inf },
    );

    const bMin = layer.bounds.minimum[1];
    const bMax = layer.bounds.maximum[1];
    const tol = 1e-3;
    add(
      `layer_${layer.id}_vertical_bounds`,
      `${layer.id} vertical bounds in the manifest match the data`,
      Math.abs(min - bMin) < tol && Math.abs(max - bMax) < tol,
      'error',
      `manifest [${bMin.toFixed(4)}, ${bMax.toFixed(4)}] vs data [${min.toFixed(4)}, ${max.toFixed(4)}]`,
      { manifestMin: bMin, manifestMax: bMax, dataMin: min, dataMax: max },
    );

    const spanX = layer.bounds.maximum[0] - layer.bounds.minimum[0];
    const impliedRes = spanX / (layer.width_samples - 1);
    add(
      `layer_${layer.id}_spacing`,
      `${layer.id} sample spacing is consistent with its bounds`,
      Math.abs(impliedRes - layer.resolution_m) < layer.resolution_m * 1e-6,
      'error',
      `declared ${layer.resolution_m} m, implied ${impliedRes} m`,
    );

    // Semantic mask must align with the heightfield grid.
    const semPath = join(directory, `layers/${layer.id}/semantic.r8`);
    if (existsSync(semPath)) {
      const sem = readFileSync(semPath);
      add(
        `layer_${layer.id}_semantic_aligned`,
        `${layer.id} semantic mask aligns with the heightfield grid`,
        sem.length === expected,
        'error',
        sem.length === expected ? undefined : `expected ${expected}, got ${sem.length}`,
      );
    }
  }

  // ------------------------------------------------ nested layer bounds ---
  const sorted = [...manifest.layers].sort((a, b) => b.resolution_m - a.resolution_m);
  for (let i = 1; i < sorted.length; i++) {
    const fine = sorted[i];
    const coarse = sorted[i - 1];
    const inside =
      fine.bounds.minimum[0] >= coarse.bounds.minimum[0] - 1e-6 &&
      fine.bounds.maximum[0] <= coarse.bounds.maximum[0] + 1e-6 &&
      fine.bounds.minimum[2] >= coarse.bounds.minimum[2] - 1e-6 &&
      fine.bounds.maximum[2] <= coarse.bounds.maximum[2] + 1e-6;
    add(
      `nesting_${fine.id}`,
      `${fine.id} is contained within ${coarse.id}`,
      inside,
      'error',
    );
  }

  // ------------------------------------------------------------- rocks ----
  const rocksPath = join(directory, 'rocks.json');
  if (existsSync(rocksPath)) {
    const rocks = JSON.parse(readFileSync(rocksPath, 'utf8')) as {
      rocks: Array<{
        id: string;
        position_m: number[];
        scale_m: number[];
        buried_fraction: number;
        physical: boolean;
      }>;
    };
    // Find the finest layer to test against.
    const finest = [...manifest.layers].sort((a, b) => a.resolution_m - b.resolution_m)[0];
    const heightPath = finest ? join(directory, `layers/${finest.id}/height.rf32`) : '';
    if (finest && existsSync(heightPath)) {
      const h = readRawFloat32(heightPath);

      // Bilinear, matching how the generator resolved each rock's ground
      // elevation. Sampling the nearest grid point instead would compare two
      // different definitions of "the ground": at 0.01 m spacing with
      // centimetre microrelief the two differ by more than the tolerance, and
      // the check would report phantom floating rocks.
      const groundAt = (x: number, z: number): number => {
        const fc = (x - finest.bounds.minimum[0]) / finest.resolution_m;
        const fr = (z - finest.bounds.minimum[2]) / finest.resolution_m;
        if (fc < 0 || fr < 0 || fc > finest.width_samples - 1 || fr > finest.height_samples - 1) {
          return NaN;
        }
        const c0 = Math.floor(fc);
        const r0 = Math.floor(fr);
        const c1 = Math.min(c0 + 1, finest.width_samples - 1);
        const r1 = Math.min(r0 + 1, finest.height_samples - 1);
        const tc = fc - c0;
        const tr = fr - r0;
        const W = finest.width_samples;
        return (
          h[r0 * W + c0] * (1 - tc) * (1 - tr) +
          h[r0 * W + c1] * tc * (1 - tr) +
          h[r1 * W + c0] * (1 - tc) * tr +
          h[r1 * W + c1] * tc * tr
        );
      };

      let floating = 0;
      let buriedWrong = 0;
      for (const r of rocks.rocks) {
        const ground = groundAt(r.position_m[0], r.position_m[2]);
        if (Number.isNaN(ground)) continue;
        // Centre must sit at ground + a*(1 - 2b) within a tolerance of one
        // sample of local relief.
        const expectedY = ground + r.scale_m[1] * (1 - 2 * r.buried_fraction);
        if (Math.abs(r.position_m[1] - expectedY) > Math.max(0.05, r.scale_m[1] * 0.5)) {
          buriedWrong++;
        }
        // A rock whose lowest point is above the ground is floating.
        const lowest = r.position_m[1] - r.scale_m[1];
        if (lowest > ground + 1e-3) floating++;
      }
      add(
        'rocks_not_floating',
        'no rock sits entirely above the terrain surface',
        floating === 0,
        'error',
        floating ? `${floating} of ${rocks.rocks.length} floating` : undefined,
        { floating, total: rocks.rocks.length },
      );
      add(
        'rocks_burial_consistent',
        'rock centre elevations match their declared burial fraction',
        buriedWrong === 0,
        'error',
        buriedWrong ? `${buriedWrong} inconsistent` : undefined,
        { inconsistent: buriedWrong },
      );
    }
  }

  // ------------------------------------------------------------ craters ---
  const cratersPath = join(directory, 'craters.json');
  if (existsSync(cratersPath)) {
    const craters = JSON.parse(readFileSync(cratersPath, 'utf8')) as {
      craters: Array<{ id: string; diameterMeters: number; depthMeters: number; degradation: number }>;
    };
    let badGeometry = 0;
    for (const c of craters.craters) {
      if (!(c.diameterMeters > 0) || !(c.depthMeters >= 0)) badGeometry++;
      // Depth must never exceed the fresh Pike ratio.
      if (c.depthMeters > c.diameterMeters * 0.25) badGeometry++;
    }
    add(
      'crater_geometry_plausible',
      'crater depths stay within the simple-crater depth/diameter envelope',
      badGeometry === 0,
      'error',
      badGeometry ? `${badGeometry} craters out of envelope` : undefined,
      { craters: craters.craters.length, bad: badGeometry },
    );
  }

  const errors = checks.filter((c) => !c.passed && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.passed && c.severity === 'warning').length;

  return {
    terrainId: manifest.terrainId,
    passed: errors === 0,
    checks,
    errors,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

/** Human-readable validation report. */
export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`validation report — ${report.terrainId}`);
  lines.push('');
  for (const c of report.checks) {
    const mark = c.passed ? 'PASS' : c.severity === 'error' ? 'FAIL' : 'WARN';
    lines.push(`  [${mark}] ${c.description}`);
    if (!c.passed && c.detail) lines.push(`         ${c.detail}`);
  }
  lines.push('');
  lines.push(`${report.checks.length} checks, ${report.errors} errors, ${report.warnings} warnings`);
  lines.push(report.passed ? 'RESULT: PASSED' : 'RESULT: FAILED');
  return lines.join('\n');
}
