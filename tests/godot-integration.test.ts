/**
 * Godot ↔ sidecar integration test (spec §26).
 *
 * Drives the **addon** end to end against a live sidecar, in real headless
 * Godot: connect, generate a seeded terrain, import it, instantiate collision,
 * sample points, apply a delta, reload the affected tiles, and confirm the
 * physics surface actually moved.
 *
 * Running the real editor plugin scripts here also means a GDScript syntax
 * error in the dock or the plugin fails the suite rather than waiting to be
 * discovered when someone opens the editor.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';

const REPO = resolve(__dirname, '..');
const GODOT = '/mnt/projects/tools/Godot_v4.6.3-stable_linux.x86_64';
const SHARED_PROJECT = join(REPO, 'godot/example-project');
const ADDON_SRC = join(REPO, 'godot/addon/lunar_terrain');
const WORK = join(REPO, '.test-artifacts/integration');
const PROJECT = join(REPO, '.test-artifacts/integration-project');
import { SITE01_DEM as DEM } from './paths.js';
const PORT = 8795;

const available = existsSync(GODOT) && existsSync(DEM);

interface Step {
  step: string;
  passed: boolean;
  detail: unknown;
}
interface Report {
  ok: boolean;
  reason: string;
  steps: Step[];
  passed: number;
  total: number;
  godot_version: { string: string };
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

let sidecar: WebSocketServer;
let report: Report;
let stdout = '';

/** Small three-tier site: real DEM, quick enough to run inside a test. */
const config = {
  schemaVersion: '1.0.0',
  terrainId: 'integration_site',
  seed: 'integration-fixed-seed',
  outputDirectory: WORK,
  site: { latitudeDeg: -89.4631639, longitudeDeg: -137.4895528 },
  layers: [
    { role: 'context', widthMeters: 200, lengthMeters: 200, resolutionMeters: 1.0 },
    { role: 'operational', widthMeters: 20, lengthMeters: 20, resolutionMeters: 0.05 },
  ],
  tileSizeSamples: 256,
  dem: {
    enabled: true,
    path: DEM,
    applyToRoles: ['context', 'operational'],
    effectiveResolutionMeters: 17.5,
  },
  craters: { enabled: true, minimumDiameterMeters: 0.4, maximumDiameterMeters: 10 },
  rocks: { enabled: true, minimumDiameterMeters: 0.1, maximumDiameterMeters: 1.2 },
  regolith: { enabled: true },
  solar: { mode: 'ephemeris', epochUtc: '2026-01-01T00:00:00Z', computeHorizon: false },
};

describe.skipIf(!available)('Godot addon integration', () => {
  beforeAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });

    // Installed exactly as a user would, into a project of this test's own.
    makeIsolatedProject(PROJECT, 'integration.gd');

    sidecar = await startServer(PORT);

    const configPath = join(WORK, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const outPath = join(WORK, 'integration_result.json');

    // Spawned ASYNCHRONOUSLY on purpose. execFileSync blocks Node's event
    // loop, so the in-process WebSocket server started above would never
    // accept Godot's connection and every run would time out at step 1.
    //
    // The script also exits non-zero when a step fails, which is the signal
    // we want to assert on, so failure is captured rather than thrown.
    const result = await new Promise<{ stdout: string; stderr: string }>((res) => {
      execFile(
        GODOT,
        [
          '--headless',
          '--path',
          PROJECT,
          '--script',
          'integration.gd',
          '--',
          '--url',
          `ws://127.0.0.1:${PORT}`,
          '--config',
          configPath,
          '--out',
          outPath,
        ],
        { encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
        (_err, out, errOut) => res({ stdout: out ?? '', stderr: errOut ?? '' }),
      );
    });
    stdout = `${result.stdout}\n${result.stderr}`;

    if (!existsSync(outPath)) {
      throw new Error(`Godot wrote no result file. Output was:\n${stdout}`);
    }
    report = JSON.parse(readFileSync(outPath, 'utf8'));
  }, 900_000);

  afterAll(async () => {
    rmSync(PROJECT, { recursive: true, force: true });
    await new Promise<void>((res) => sidecar.close(() => res()));
  });

  it('loads the addon scripts without GDScript errors', () => {
    // A parse error in dock.gd or plugin.gd surfaces here rather than the
    // first time somebody enables the plugin in the editor.
    expect(stdout).not.toMatch(/Parse Error|SCRIPT ERROR/);
  });

  it('completes every step of the spec §26 lifecycle', () => {
    const failed = report.steps.filter((s) => !s.passed);
    expect(failed.map((f) => `${f.step}: ${JSON.stringify(f.detail)}`)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.total).toBeGreaterThanOrEqual(20);
  });

  it('connects the addon client to the sidecar over the real protocol', () => {
    const step = report.steps.find((s) => s.step === 'connect to sidecar');
    expect(step?.passed).toBe(true);
    expect(step?.detail).toBe('1.0.0');
  });

  it('imports the export and builds non-overlapping collision', () => {
    expect(report.steps.find((s) => s.step === 'import export')?.passed).toBe(true);
    const collision = report.steps.find((s) => s.step === 'instantiate terrain + collision');
    expect(collision?.passed).toBe(true);
    expect(String(collision?.detail)).toMatch(/collision regions/);
  });

  it('carries the coordinate contract into Godot', () => {
    expect(report.steps.find((s) => s.step === 'coordinate contract preserved')?.passed).toBe(true);
  });

  it('agrees with the sidecar on elevation through collision geometry', () => {
    const step = report.steps.find((s) => s.step === 'elevation agrees with the sidecar');
    expect(step?.passed).toBe(true);
    const err = Number(/max error ([\d.]+) m/.exec(String(step?.detail))?.[1] ?? '99');
    expect(err).toBeLessThan(0.01);
  });

  it('applies a delta with checksum chaining and balanced cut/fill', () => {
    expect(report.steps.find((s) => s.step === 'apply terrain delta')?.passed).toBe(true);
    expect(report.steps.find((s) => s.step === 'delta is checksum-chained')?.passed).toBe(true);

    const mass = report.steps.find((s) => s.step === 'cut and fill balance');
    expect(mass?.passed).toBe(true);
    const err = Number(/error ([\d.]+)%/.exec(String(mass?.detail))?.[1] ?? '99');
    expect(err).toBeLessThan(1);
  });

  it('keeps the edited terrain valid on re-export', () => {
    expect(report.steps.find((s) => s.step === 'edited terrain still validates')?.passed).toBe(true);
  });

  it('reloads affected tiles and moves the collision surface with the edit', () => {
    // The decisive check: after an excavation the *physics* surface must drop,
    // not just the exported file. Stale collision would let a rover drive on
    // ground that no longer exists.
    expect(report.steps.find((s) => s.step === 'reload affected tiles')?.passed).toBe(true);
    expect(report.steps.find((s) => s.step === 'sidecar recorded the excavation')?.passed).toBe(true);
    expect(report.steps.find((s) => s.step === 'collision surface moved with it')?.passed).toBe(true);
    expect(report.steps.find((s) => s.step === 'collision actually changed')?.passed).toBe(true);
  });
});
