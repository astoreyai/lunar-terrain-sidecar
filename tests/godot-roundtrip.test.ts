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
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfig, elevationAt, finestLayerAt, type TerrainDataset } from '@lts/shared-types';
import { generateTerrain } from '@lts/terrain-pipeline';
import { exportTerrain } from '@lts/terrain-export';
import { validateDataset } from '@lts/terrain-validation';

const REPO = resolve(__dirname, '..');
import { GODOT_BIN as GODOT } from './paths.js';
const SHARED_PROJECT = join(REPO, 'godot/example-project');
const ADDON_SRC = join(REPO, 'godot/addon/lunar_terrain');
const WORK = join(REPO, '.test-artifacts/roundtrip');
const CORRUPT_WORK = join(REPO, '.test-artifacts/roundtrip-corrupt');
const MISALIGNED_WORK = join(REPO, '.test-artifacts/roundtrip-misaligned');
const METADATA_WORK = join(REPO, '.test-artifacts/roundtrip-invalid-metadata');
const PROJECT = join(REPO, '.test-artifacts/roundtrip-project');
import { SITE01_DEM as DEM } from './paths.js';
const SOURCE_PROJECTION_NUMERIC_FIELDS = [
  'latitudeOfOriginDeg',
  'centralMeridianDeg',
  'scaleFactor',
  'falseEastingM',
  'falseNorthingM',
  'bodyRadiusM',
  'originEastingM',
  'originNorthingM',
] as const;
const SOURCE_PROJECTION_FIELDS = ['type', ...SOURCE_PROJECTION_NUMERIC_FIELDS] as const;

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
  visual_chunks: number;
  full_resolution_chunks: number;
  decimated_chunks: number;
  visual_chunk_layout: string[];
  collision_chunk_layout: string[];
  focus_visual_error_m: number;
  focus_collision_error_m: number;
  focus_render_collision_error_m: number;
  focus_geometry_missed: number;
  focus_probe_count: number;
  rock_collision_bodies: number;
  physical_collision_shapes: number;
  max_rock_shapes_per_body: number;
  rock_collision_layout: string[];
  collision_ids_match_physical: boolean;
  visual_collision_ids: number;
  render_triangles: number;
  render_back_facing_triangles: number;
  rock_visual_basis_checked: number;
  rock_visual_basis_mismatches: number;
  physical_rock_raycast_hit: boolean;
  visual_rock_tested: boolean;
  visual_rock_raycast_hit: boolean;
  load_ms: number;
  build_ms: number;
  async_build: boolean;
  async_build_yields: number;
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
let asyncReport: ProbeResult;

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

    // Fixed lattice probes across all three tiers, with the authority's own
    // real-dataset answer for each. No random coordinates hide seam coverage.
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

    // Operational tier: an 8 × 5 interior lattice.
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 8; col++) {
        onGrid('operational-2', 0.08 + col * 0.12, 0.1 + row * 0.2);
      }
    }
    // Mission tier: ten fixed samples along each outer band, clear of the
    // operational footprint and its collision seams.
    for (let i = 0; i < 10; i++) {
      const f = 0.08 + i * (0.84 / 9);
      onGrid('mission-1', f, 0.18);
      onGrid('mission-1', f, 0.82);
      onGrid('mission-1', 0.18, f);
      onGrid('mission-1', 0.82, f);
    }
    // Context tier: the same four-band lattice outside the mission footprint.
    for (let i = 0; i < 10; i++) {
      const f = 0.06 + i * (0.88 / 9);
      onGrid('context-0', f, 0.22);
      onGrid('context-0', f, 0.78);
      onGrid('context-0', 0.22, f);
      onGrid('context-0', 0.78, f);
    }

    // Off-grid probes, kept separate: these legitimately differ by the
    // bilinear-vs-triangulated cell interpolation and get a looser bar.
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 6; col++) {
        push(-8.35 + col * 3.31, -7.75 + row * 3.83, false);
      }
    }

    // Exercise both sides of every nested-tier perimeter. These real terrain
    // probes make a missing collision strip observable independently of the
    // interior lattice above.
    const seamProbes = (innerId: string, outerId: string) => {
      const inner = dataset.layers.find((layer) => layer.id === innerId)!;
      const outer = dataset.layers.find((layer) => layer.id === outerId)!;
      const innerNudge = inner.horizontalResolutionMeters * VERTEX_NUDGE_CELLS;
      const outerNudge = outer.horizontalResolutionMeters * VERTEX_NUDGE_CELLS;
      const midX = (inner.bounds.minX + inner.bounds.maxX) * 0.5;
      const midZ = (inner.bounds.minZ + inner.bounds.maxZ) * 0.5;
      push(inner.bounds.minX - outerNudge, midZ, true, outerId);
      push(inner.bounds.minX + innerNudge, midZ, true, innerId);
      push(inner.bounds.maxX + outerNudge, midZ, true, outerId);
      push(inner.bounds.maxX - innerNudge, midZ, true, innerId);
      push(midX, inner.bounds.minZ - outerNudge, true, outerId);
      push(midX, inner.bounds.minZ + innerNudge, true, innerId);
      push(midX, inner.bounds.maxZ + outerNudge, true, outerId);
      push(midX, inner.bounds.maxZ - innerNudge, true, innerId);
    };
    seamProbes('mission-1', 'context-0');
    seamProbes('operational-2', 'mission-1');

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

    const asyncOutPath = join(WORK, 'roundtrip_async_result.json');
    execFileSync(
      GODOT,
      [
        '--headless',
        '--path',
        PROJECT,
        '--script',
        'roundtrip.gd',
        '--',
        '--async-build',
        '--export-dir',
        WORK,
        '--probes',
        probesPath,
        '--out',
        asyncOutPath,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 300_000 },
    );
    asyncReport = JSON.parse(readFileSync(asyncOutPath, 'utf8'));
  }, 600_000);

  afterAll(() => {
    rmSync(PROJECT, { recursive: true, force: true });
    rmSync(CORRUPT_WORK, { recursive: true, force: true });
    rmSync(MISALIGNED_WORK, { recursive: true, force: true });
    rmSync(METADATA_WORK, { recursive: true, force: true });
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
    expect(report.coordinate_system.east_axis).toBe('+X');
    expect(report.coordinate_system.north_axis).toBe('-Z');
    expect(report.coordinate_system.south_axis).toBe('+Z');
    expect(report.coordinate_system.linear_unit).toBe('meter');
    const projection = report.coordinate_system.source_projection as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual([...SOURCE_PROJECTION_FIELDS].sort());
    expect(projection.type).toBe('polar_stereographic');
    expect(projection.latitudeOfOriginDeg).toBe(-90);
    expect(projection.bodyRadiusM).toBe(1_737_400);
    expect(projection.scaleFactor).toBe(1);
    expect(SOURCE_PROJECTION_NUMERIC_FIELDS.every((field) => Number.isFinite(projection[field]))).toBe(
      true,
    );
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

  it('orients collision normals upward', () => {
    // Every ground normal must have a positive Y component. This checks the
    // physics surface only; HeightMapShape3D normals do not depend on the
    // render mesh's index order, which is checked by the front-face test below.
    //
    // No bound is placed on how *close* to vertical they are: at 0.02 m
    // sampling, real crater walls and boulder-scale microrelief produce
    // legitimately steep faces — one probe here lands on an 81° slope. An
    // arbitrary "mostly flat" threshold would fail on correct terrain.
    const hits = report.results.filter((r) => r.hit);
    expect(hits.length).toBeGreaterThan(80);
    expect(hits.every((r) => (r.normal_y ?? -1) > 0)).toBe(true);
  });

  it('builds spatially chunked non-overlapping collision tiers', () => {
    // Collision regions remain non-overlapping across tiers, but each band is
    // now spatially chunked so a live edit does not rebuild the whole layer.
    // The fixed 201/401/1001-sample tier geometry produces 4 context bands,
    // 6 mission bands, and 16 operational chunks under the 257-sample cap.
    expect(report.collision_shapes).toBe(26);
    expect(report.collision_chunk_layout).toHaveLength(26);
    expect(report.collision_chunk_layout.filter((entry) => entry.includes(':context-0:'))).toHaveLength(
      4,
    );
    expect(report.collision_chunk_layout.filter((entry) => entry.includes(':mission-1:'))).toHaveLength(
      6,
    );
    expect(
      report.collision_chunk_layout.filter((entry) => entry.includes(':operational-2:')),
    ).toHaveLength(16);
    expect(new Set(report.collision_chunk_layout).size).toBe(26);
  });

  it('instantiates rocks and gives collision only to physical rocks', () => {
    const exportedRocks = JSON.parse(readFileSync(join(WORK, 'rocks.json'), 'utf8'));
    expect(report.physical_rocks).toBe(exportedRocks.physicalCount);
    expect(report.physical_rocks + report.visual_rocks).toBe(exportedRocks.count);
    expect(report.physical_rocks).toBeGreaterThan(0);
    expect(report.physical_collision_shapes).toBe(report.physical_rocks);
    expect(report.rock_collision_bodies).toBeGreaterThan(1);
    expect(report.max_rock_shapes_per_body).toBeLessThanOrEqual(128);
    expect(report.collision_ids_match_physical).toBe(true);
    expect(report.visual_collision_ids).toBe(0);
  });

  it('winds every render triangle as a Godot front face seen from above', () => {
    // Collision raycasts are orientation-agnostic; this is the only check that
    // sees what the renderer will cull. Godot front faces are clockwise.
    expect(report.render_triangles).toBeGreaterThan(0);
    expect(report.render_back_facing_triangles).toBe(0);
  });

  it('scales rendered rock instances along their local axes like their collision', () => {
    expect(report.rock_visual_basis_checked).toBeGreaterThan(0);
    expect(report.rock_visual_basis_mismatches).toBe(0);
    expect(report.physical_rock_raycast_hit).toBe(true);
    expect(report.visual_rock_tested).toBe(true);
    expect(report.visual_rock_raycast_hit).toBe(false);
  });

  it('chunks visual terrain and preserves full resolution at the declared focus', () => {
    expect(report.visual_chunks).toBeGreaterThan(report.layers);
    expect(report.full_resolution_chunks).toBeGreaterThan(0);
    expect(report.decimated_chunks).toBeGreaterThan(0);
    expect(report.focus_visual_error_m).toBeLessThan(1e-6);
    expect(report.focus_collision_error_m).toBeLessThan(0.002);
    expect(report.focus_probe_count).toBeGreaterThan(4);
    expect(report.focus_geometry_missed).toBe(0);
    expect(report.focus_render_collision_error_m).toBeLessThan(2e-5);
  });

  it('builds incrementally across frames with the same scene and physics result', () => {
    expect(report.async_build).toBe(false);
    expect(asyncReport.ok).toBe(true);
    expect(asyncReport.async_build).toBe(true);
    expect(asyncReport.async_build_yields).toBeGreaterThan(1);
    expect(asyncReport.layers).toBe(report.layers);
    expect(asyncReport.collision_shapes).toBe(report.collision_shapes);
    expect(asyncReport.visual_chunks).toBe(report.visual_chunks);
    expect(asyncReport.full_resolution_chunks).toBe(report.full_resolution_chunks);
    expect(asyncReport.decimated_chunks).toBe(report.decimated_chunks);
    expect(asyncReport.visual_chunk_layout).toEqual(report.visual_chunk_layout);
    expect(asyncReport.collision_chunk_layout).toEqual(report.collision_chunk_layout);
    expect(asyncReport.physical_rocks).toBe(report.physical_rocks);
    expect(asyncReport.visual_rocks).toBe(report.visual_rocks);
    expect(asyncReport.physical_collision_shapes).toBe(report.physical_collision_shapes);
    expect(asyncReport.rock_collision_bodies).toBe(report.rock_collision_bodies);
    expect(asyncReport.max_rock_shapes_per_body).toBe(report.max_rock_shapes_per_body);
    expect(asyncReport.rock_collision_layout).toEqual(report.rock_collision_layout);
    expect(asyncReport.collision_ids_match_physical).toBe(true);
    expect(asyncReport.visual_collision_ids).toBe(0);
    expect(asyncReport.physical_rock_raycast_hit).toBe(report.physical_rock_raycast_hit);
    expect(asyncReport.visual_rock_raycast_hit).toBe(report.visual_rock_raycast_hit);
    expect(asyncReport.missed).toBe(0);
    expect(asyncReport.max_on_grid_error_m).toBe(report.max_on_grid_error_m);
    expect(asyncReport.max_off_grid_error_m).toBe(report.max_off_grid_error_m);
    expect(asyncReport.focus_visual_error_m).toBe(report.focus_visual_error_m);
    expect(asyncReport.focus_collision_error_m).toBe(report.focus_collision_error_m);
    expect(asyncReport.focus_render_collision_error_m).toBe(report.focus_render_collision_error_m);
    expect(asyncReport.focus_geometry_missed).toBe(0);
    expect(asyncReport.terrain_id).toBe(report.terrain_id);
    expect(asyncReport.seed).toBe(report.seed);
    expect(asyncReport.coordinate_system).toEqual(report.coordinate_system);
    expect(asyncReport.results).toEqual(report.results);
  });

  it('rejects same-size RF32 corruption by SHA-256 before scene construction', () => {
    // This fixture is a byte-corrupted copy of the real Site01-derived export,
    // not fabricated terrain. Keeping its size unchanged proves the digest,
    // rather than the pre-existing byte-count check, rejects it.
    rmSync(CORRUPT_WORK, { recursive: true, force: true });
    mkdirSync(CORRUPT_WORK, { recursive: true });
    cpSync(join(WORK, 'manifest.json'), join(CORRUPT_WORK, 'manifest.json'));
    cpSync(join(WORK, 'rocks.json'), join(CORRUPT_WORK, 'rocks.json'));
    cpSync(join(WORK, 'layers'), join(CORRUPT_WORK, 'layers'), { recursive: true });

    const corruptPath = join(CORRUPT_WORK, 'layers/operational-2/height.rf32');
    const bytes = readFileSync(corruptPath);
    const originalSize = bytes.length;
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    writeFileSync(corruptPath, bytes);
    expect(statSync(corruptPath).size).toBe(originalSize);

    const outPath = join(CORRUPT_WORK, 'result.json');
    const run = spawnSync(
      GODOT,
      [
        '--headless',
        '--path',
        PROJECT,
        '--script',
        'roundtrip.gd',
        '--',
        '--export-dir',
        CORRUPT_WORK,
        '--probes',
        join(WORK, 'probes.json'),
        '--out',
        outPath,
      ],
      { encoding: 'utf8', timeout: 300_000 },
    );
    expect(run.status).not.toBe(0);
    const failure = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(failure.ok).toBe(false);
    expect(failure.reason).toBe('load_failed');
    expect(failure.details.join('\n')).toMatch(/SHA-256/i);
  });

  it('rejects nested bounds that cannot form gap-free collision bands', () => {
    // Shift only real export metadata; the underlying Site01-derived artifacts
    // remain unchanged. Each layer still has the declared size/resolution, but
    // the mission perimeter no longer lands on context collision samples.
    rmSync(MISALIGNED_WORK, { recursive: true, force: true });
    mkdirSync(MISALIGNED_WORK, { recursive: true });
    cpSync(join(WORK, 'manifest.json'), join(MISALIGNED_WORK, 'manifest.json'));
    cpSync(join(WORK, 'rocks.json'), join(MISALIGNED_WORK, 'rocks.json'));
    cpSync(join(WORK, 'layers'), join(MISALIGNED_WORK, 'layers'), { recursive: true });
    const manifestPath = join(MISALIGNED_WORK, 'manifest.json');
    const shifted = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const mission = shifted.layers.find((layer: { id: string }) => layer.id === 'mission-1');
    mission.bounds.minimum[0] += 0.125;
    mission.bounds.maximum[0] += 0.125;
    writeFileSync(manifestPath, JSON.stringify(shifted, null, 2));

    const outPath = join(MISALIGNED_WORK, 'result.json');
    const run = spawnSync(
      GODOT,
      [
        '--headless',
        '--path',
        PROJECT,
        '--script',
        'roundtrip.gd',
        '--',
        '--export-dir',
        MISALIGNED_WORK,
        '--probes',
        join(WORK, 'probes.json'),
        '--out',
        outPath,
      ],
      { encoding: 'utf8', timeout: 300_000 },
    );
    expect(run.status).not.toBe(0);
    const failure = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(failure.reason).toBe('load_failed');
    expect(failure.details.join('\n')).toMatch(/align.*collision samples/i);
  });

  it.each([
    {
      name: 'a non-MOON_ME body frame',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.body_frame = 'MOON_PA';
      },
      expected: /body_frame.*MOON_ME/i,
    },
    {
      name: 'a non-LOLA lunar reference radius',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.body_radius_m = 1_738_000;
      },
      expected: /body_radius_m.*1737400/i,
    },
    {
      name: 'a missing origin object',
      mutate: (manifest: Record<string, any>) => {
        delete manifest.origin;
      },
      expected: /origin must be an object/i,
    },
    {
      name: 'a missing local origin',
      mutate: (manifest: Record<string, any>) => {
        delete manifest.origin.local;
      },
      expected: /origin\.local.*3 finite/i,
    },
    {
      name: 'a malformed local origin',
      mutate: (manifest: Record<string, any>) => {
        manifest.origin.local = [0, 'not-finite', 0];
      },
      expected: /origin\.local.*3 finite/i,
    },
    {
      name: 'a missing selenographic site',
      mutate: (manifest: Record<string, any>) => {
        delete manifest.origin.site_selenographic;
      },
      expected: /site_selenographic must be an object/i,
    },
    {
      name: 'an out-of-range site latitude',
      mutate: (manifest: Record<string, any>) => {
        manifest.origin.site_selenographic.latitude_deg = -90.0001;
      },
      expected: /latitude_deg.*-90.*90/i,
    },
    {
      name: 'an out-of-range site longitude',
      mutate: (manifest: Record<string, any>) => {
        manifest.origin.site_selenographic.longitude_deg = 360.0001;
      },
      expected: /longitude_deg.*-180.*360/i,
    },
    {
      name: 'a missing elevation datum',
      mutate: (manifest: Record<string, any>) => {
        delete manifest.origin.datum_elevation_m;
      },
      expected: /datum_elevation_m.*finite/i,
    },
    ...SOURCE_PROJECTION_FIELDS.map((field) => ({
      name: `source_projection missing ${field}`,
      mutate: (manifest: Record<string, any>) => {
        delete manifest.coordinate_system.source_projection[field];
      },
      expected:
        field === 'type'
          ? /source_projection\.type.*polar_stereographic/i
          : new RegExp(`source_projection\\.${field}.*finite`, 'i'),
    })),
    ...SOURCE_PROJECTION_NUMERIC_FIELDS.map((field) => ({
      name: `source_projection with non-numeric ${field}`,
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection[field] = null;
      },
      expected: new RegExp(`source_projection\\.${field}.*finite`, 'i'),
    })),
    {
      name: 'source_projection with a non-polar projection type',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection.type = 'lambert_conformal_conic';
      },
      expected: /source_projection\.type.*polar_stereographic/i,
    },
    {
      name: 'source_projection that is not an object',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection = [];
      },
      expected: /source_projection must be an object/i,
    },
    {
      name: 'source_projection with an extra field',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection.axisOrder = 'east,north';
      },
      expected: /source_projection.*exactly 9 fields/i,
    },
    {
      name: 'source_projection with a mismatched lunar radius',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection.bodyRadiusM = 1_737_401;
      },
      expected: /source_projection\.bodyRadiusM.*body_radius_m/i,
    },
    {
      name: 'source_projection with a non-polar latitude of origin',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection.latitudeOfOriginDeg = 0;
      },
      expected: /source_projection\.latitudeOfOriginDeg.*-90.*90/i,
    },
    {
      name: 'source_projection with an out-of-domain central meridian',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection.centralMeridianDeg = 360.0001;
      },
      expected: /source_projection\.centralMeridianDeg.*-180.*360/i,
    },
    {
      name: 'source_projection with a non-positive scale',
      mutate: (manifest: Record<string, any>) => {
        manifest.coordinate_system.source_projection.scaleFactor = 0;
      },
      expected: /source_projection\.scaleFactor.*positive/i,
    },
  ])('rejects $name before reading terrain rasters', ({ name, mutate, expected }) => {
    const fixture = join(METADATA_WORK, name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase());
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });

    // Mutate the manifest emitted from the real Site01-derived export. Raster
    // artifacts are intentionally absent: receiving the specific metadata
    // error below, rather than a missing-artifact error, proves the loader
    // rejects the invalid static frame before it can read or allocate rasters.
    const manifest = JSON.parse(readFileSync(join(WORK, 'manifest.json'), 'utf8'));
    mutate(manifest);
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const outPath = join(fixture, 'result.json');
    const run = spawnSync(
      GODOT,
      [
        '--headless',
        '--path',
        PROJECT,
        '--script',
        'roundtrip.gd',
        '--',
        '--export-dir',
        fixture,
        '--probes',
        join(WORK, 'probes.json'),
        '--out',
        outPath,
      ],
      { encoding: 'utf8', timeout: 300_000 },
    );
    expect(run.status).not.toBe(0);
    const failure = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(failure.reason).toBe('load_failed');
    expect(failure.details.join('\n')).toMatch(expected);
    expect(failure.details.join('\n')).not.toMatch(/height\.rf32|semantic\.r8|artifact file/i);
  });

  it('passes the exporter validation suite', () => {
    const v = validateDataset(WORK);
    const failures = v.checks.filter((c) => !c.passed);
    expect(failures.map((f) => f.description)).toEqual([]);
    expect(v.passed).toBe(true);
  });
});
