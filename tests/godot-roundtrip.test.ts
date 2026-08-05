/**
 * The critical acceptance test (spec §30 "first critical milestone", §31):
 *
 *   seeded configuration
 *     → generated heightfield (grounded in a real LOLA DEM)
 *     → exported tile
 *     → imported into Godot
 *     → correct visual and collision scale
 *     → elevation query agreement
 *
 * Godot is driven **headless for real** — this does not simulate the import. It
 * raycasts against the collision geometry Godot actually builds, so a scale
 * error, an axis swap, a HeightMapShape3D centring mistake or an inverted
 * winding shows up as a numerical disagreement rather than passing quietly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfig, elevationAt, finestLayerAt, type TerrainDataset } from '@lts/shared-types';
import { generateTerrain } from '@lts/terrain-pipeline';
import { exportTerrain } from '@lts/terrain-export';
import { validateDataset } from '@lts/terrain-validation';
import { Rng } from '@lts/terrain-core';

const REPO = resolve(__dirname, '..');
import { GODOT_BIN as GODOT } from './paths.js';
const SHARED_PROJECT = join(REPO, 'godot/example-project');
const ADDON_SRC = join(REPO, 'godot/addon/lunar_terrain');
const WORK = join(REPO, '.test-artifacts/roundtrip');
const PROJECT = join(REPO, '.test-artifacts/roundtrip-project');
import { SITE01_DEM as DEM } from './paths.js';

const godotAvailable = existsSync(GODOT);
const demAvailable = existsSync(DEM);

interface ProbeResult {
  ok: boolean;
  probes: number;
  missed: number;
  max_abs_error_m: number;
  max_on_grid_error_m: number;
  max_off_grid_error_m: number;
  max_sample_error_m: number;
  max_normal_deviation: number;
  layers: number;
  terrain_id: string;
  seed: string;
  coordinate_system: Record<string, unknown>;
  collision_shapes: number;
  physical_rocks: number;
  visual_rocks: number;
  results: Array<{
    x: number;
    z: number;
    expected_m: number;
    hit: boolean;
    godot_m?: number;
    error_m?: number;
    normal_y?: number;
  }>;
}


/**
 * Materialise an isolated Godot project for this test.
 *
 * The two Godot test files run in parallel and previously shared
 * `godot/example-project/addons/`, so one suite's afterAll cleanup deleted the
 * addon while the other was still running — green in isolation, red together.
 * Each now gets its own project directory.
 */
function makeIsolatedProject(dest: string, script: string): string {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'addons'), { recursive: true });
  cpSync(join(SHARED_PROJECT, 'project.godot'), join(dest, 'project.godot'));
  cpSync(join(SHARED_PROJECT, script), join(dest, script));
  cpSync(ADDON_SRC, join(dest, 'addons/lunar_terrain'), { recursive: true });
  return dest;
}

let dataset: TerrainDataset;
let report: ProbeResult;

/**
 * A small nested site: big enough to exercise all three tiers and the real DEM,
 * small enough that the whole round trip runs inside a test.
 */
function testConfig() {
  return parseConfig({
    terrainId: 'roundtrip_site',
    seed: 'roundtrip-fixed-seed',
    outputDirectory: WORK,
    site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
    layers: [
      { role: 'context', widthMeters: 400, lengthMeters: 400, resolutionMeters: 2.0 },
      { role: 'mission', widthMeters: 100, lengthMeters: 100, resolutionMeters: 0.25 },
      { role: 'operational', widthMeters: 20, lengthMeters: 20, resolutionMeters: 0.02 },
    ],
    tileSizeSamples: 256,
    dem: {
      enabled: true,
      path: DEM,
      applyToRoles: ['context', 'mission', 'operational'],
      effectiveResolutionMeters: 17.5,
    },
    proceduralStack: [
      {
        id: 'sub_dem',
        model: 'fbm',
        enabled: true,
        fractal: {
          octaves: 5,
          lacunarity: 2,
          persistence: 0.5,
          frequency: 0.3,
          amplitude: 0.1,
          anisotropy: 1,
        },
      },
    ],
    craters: { enabled: true, minimumDiameterMeters: 0.3, maximumDiameterMeters: 12 },
    rocks: { enabled: true, minimumDiameterMeters: 0.08, maximumDiameterMeters: 1.5 },
    regolith: { enabled: true },
    solar: { mode: 'ephemeris', epochUtc: '2026-08-03T00:00:00Z', computeHorizon: false },
  });
}

describe.skipIf(!godotAvailable || !demAvailable)('Godot round trip', () => {
  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });

    makeIsolatedProject(PROJECT, 'roundtrip.gd');

    const config = testConfig();
    const generated = await generateTerrain(config);
    dataset = generated.dataset;
    exportTerrain(dataset, {
      outputDirectory: WORK,
      tileSizeSamples: config.tileSizeSamples,
      solar: generated.solar,
      notes: generated.notes,
      formats: { exr: false, png16: false, glb: true },
    });

    // Probe points, drawn deterministically across all three tiers, with the
    // sidecar's own answer for each.
    const rng = new Rng('probe-points');
    const probes: Array<{
      x: number;
      z: number;
      elevation_m: number;
      layer: string;
      on_grid: boolean;
    }> = [];

    const push = (x: number, z: number, onGrid: boolean, wantLayer?: string) => {
      const layer = finestLayerAt(dataset, x, z);
      const h = elevationAt(dataset, x, z);
      if (!layer || !Number.isFinite(h)) return;
      // Only probe where the tier we intended is genuinely the finest one, so
      // the test is not accidentally measuring a tier boundary.
      if (wantLayer && layer.id !== wantLayer) return;
      probes.push({ x, z, elevation_m: h, layer: layer.id, on_grid: onGrid });
    };

    /**
     * On-grid probes sit at a sample of the finest covering layer, where
     * bilinear interpolation and Godot's two-triangles-per-cell triangulation
     * both return the stored value — so any residual is a genuine
     * scale/offset/axis error, not an interpolation difference.
     *
     * They are nudged off the vertex by a thousandth of a cell. Casting a ray
     * exactly through a heightfield vertex is numerically ill-conditioned: the
     * ray runs along the shared edge of two triangles and can be rejected by
     * both, which is precisely what happened to 4 of 40 operational probes
     * before this offset was added. At 1e-3 of a cell the interpolation
     * difference introduced is of order 1e-5 m, far below the 2 mm bar.
     */
    const VERTEX_NUDGE_CELLS = 1e-3;
    const onGrid = (layerId: string, colFrac: number, rowFrac: number) => {
      const layer = dataset.layers.find((l) => l.id === layerId)!;
      const res = layer.horizontalResolutionMeters;
      const col = Math.round(colFrac * (layer.widthSamples - 1));
      const row = Math.round(rowFrac * (layer.heightSamples - 1));
      push(
        layer.bounds.minX + (col + VERTEX_NUDGE_CELLS) * res,
        layer.bounds.minZ + (row + VERTEX_NUDGE_CELLS) * res,
        true,
        layerId,
      );
    };

    // Operational tier: sample across the interior.
    for (let i = 0; i < 40; i++) onGrid('operational-2', rng.uniform(0.05, 0.95), rng.uniform(0.05, 0.95));
    // Mission tier, staying clear of the operational footprint and of the
    // collision band seams around it.
    for (let i = 0; i < 40; i++) {
      const f = rng.uniform(0.05, 0.95);
      const g = rng.next() < 0.5 ? rng.uniform(0.05, 0.32) : rng.uniform(0.68, 0.95);
      onGrid('mission-1', rng.next() < 0.5 ? f : g, rng.next() < 0.5 ? g : f);
    }
    // Context tier, clear of the mission footprint.
    for (let i = 0; i < 40; i++) {
      const f = rng.uniform(0.05, 0.95);
      const g = rng.next() < 0.5 ? rng.uniform(0.05, 0.35) : rng.uniform(0.65, 0.95);
      onGrid('context-0', rng.next() < 0.5 ? f : g, rng.next() < 0.5 ? g : f);
    }

    // Off-grid probes, kept separate: these legitimately differ by the
    // bilinear-vs-triangulated cell interpolation and get a looser bar.
    for (let i = 0; i < 30; i++) push(rng.uniform(-9, 9), rng.uniform(-9, 9), false);

    const probesPath = join(WORK, 'probes.json');
    writeFileSync(probesPath, JSON.stringify({ probes }, null, 2));

    const outPath = join(WORK, 'roundtrip_result.json');
    execFileSync(
      GODOT,
      [
        '--headless',
        '--path',
        PROJECT,
        '--script',
        'roundtrip.gd',
        '--',
        '--export-dir',
        WORK,
        '--probes',
        probesPath,
        '--out',
        outPath,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 300_000 },
    );

    report = JSON.parse(readFileSync(outPath, 'utf8'));
  }, 600_000);

  afterAll(() => {
    rmSync(PROJECT, { recursive: true, force: true });
  });

  it('imports the export without errors', () => {
    expect(report.ok).toBe(true);
    expect(report.layers).toBe(3);
    expect(report.terrain_id).toBe('roundtrip_site');
    expect(report.seed).toBe('roundtrip-fixed-seed');
  });

  it('carries the coordinate contract through to Godot', () => {
    expect(report.coordinate_system.handedness).toBe('right');
    expect(report.coordinate_system.up_axis).toBe('+Y');
    expect(report.coordinate_system.north_axis).toBe('-Z');
    expect(report.coordinate_system.linear_unit).toBe('meter');
  });

  it('hits terrain at every probe point', () => {
    expect(report.probes).toBeGreaterThan(80);
    expect(report.missed).toBe(0);
    expect(report.results.every((r) => r.hit)).toBe(true);
  });

  it('agrees on elevation between the sidecar and Godot collision geometry', () => {
    // THE milestone check (spec §31 items 7 and 8), measured on probes that
    // land exactly on a sample of the finest covering layer. At a sample point
    // bilinear interpolation and Godot's two-triangles-per-cell triangulation
    // both return the stored value, so the only residual is float32 storage
    // and Godot's own float maths — anything larger is a real scale, offset or
    // axis error.
    //
    // For scale: a 2x error on this site gives metres, and the overlapping-
    // collision bug this test originally caught gave 2.18 m.
    expect(report.max_on_grid_error_m).toBeLessThan(0.002);
  });

  it('agrees within cell interpolation off-grid', () => {
    // Off-grid the two representations genuinely differ: Godot triangulates
    // each cell into two flat triangles, the sidecar interpolates bilinearly.
    // They agree along the shared diagonal and differ most at the opposite
    // corners, bounded by the cell's twist.
    expect(report.max_off_grid_error_m).toBeLessThan(0.05);
  });

  it('reads identical elevations through the addon loader', () => {
    // The loader's own bilinear read must match the sidecar exactly, up to
    // float32 storage. This isolates a file-parsing bug from a physics bug.
    expect(report.max_sample_error_m).toBeLessThan(1e-4);
  });

  it('orients collision normals upward, proving the winding is not inverted', () => {
    // Every ground normal must have a positive Y component. An inverted
    // winding flips all of them negative, so this is the discriminating check.
    //
    // No bound is placed on how *close* to vertical they are: at 0.02 m
    // sampling, real crater walls and boulder-scale microrelief produce
    // legitimately steep faces — one probe here lands on an 81° slope. An
    // arbitrary "mostly flat" threshold would fail on correct terrain.
    const hits = report.results.filter((r) => r.hit);
    expect(hits.length).toBeGreaterThan(80);
    expect(hits.every((r) => (r.normal_y ?? -1) > 0)).toBe(true);
  });

  it('builds non-overlapping collision, one region per nested tier', () => {
    // context = 4 bands around the mission footprint, mission = 4 bands around
    // the operational footprint, operational = 1 full shape.
    expect(report.collision_shapes).toBe(9);
  });

  it('instantiates rocks split by physical and visual', () => {
    expect(report.physical_rocks + report.visual_rocks).toBeGreaterThan(0);
    expect(report.physical_rocks).toBeGreaterThan(0);
  });

  it('passes the exporter validation suite', () => {
    const v = validateDataset(WORK);
    const failures = v.checks.filter((c) => !c.passed);
    expect(failures.map((f) => f.description)).toEqual([]);
    expect(v.passed).toBe(true);
  });
});
