#!/usr/bin/env node
/**
 * `lunar-terrain` command line interface (spec §25).
 *
 * Runs fully headless: no browser, no GPU, no display. CPU generation is the
 * reference implementation (spec §20).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { parseConfig, TerrainError, type TerrainConfig } from '@lts/shared-types';
import { estimate, formatEstimate, assertFeasible } from '@lts/terrain-core';
import { generateTerrain, configurationHash } from '@lts/terrain-pipeline';
import { exportTerrain } from '@lts/terrain-export';
import { validateDataset, formatValidationReport } from '@lts/terrain-validation';
import {
  parseInstant,
  solarPositionAtSite,
  subSolarPoint,
  shadowLengthM,
} from '@lts/lunar-solar';

function loadConfig(path: string): { config: TerrainConfig; dir: string } {
  const full = resolve(path);
  if (!existsSync(full)) {
    console.error(`configuration not found: ${full}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(full, 'utf8'));
  return { config: parseConfig(raw), dir: dirname(full) };
}

function resolveOutput(config: TerrainConfig, configDir: string): string {
  return resolve(configDir, config.outputDirectory);
}

function fail(e: unknown): never {
  if (e instanceof TerrainError) {
    console.error(JSON.stringify(e.toJSON(), null, 2));
    process.exit(1);
  }
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
}

function progressBar(stage: string, p: number, detail?: string): void {
  const width = 28;
  const filled = Math.round(p * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  const pct = String(Math.round(p * 100)).padStart(3);
  process.stderr.write(
    `\r[${bar}] ${pct}%  ${stage.padEnd(22)}${detail ? ` ${detail}` : ''}`.padEnd(100),
  );
  if (p >= 1) process.stderr.write('\n');
}

async function cmdEstimate(path: string): Promise<void> {
  const { config } = loadConfig(path);
  const est = estimate(config);
  console.log(formatEstimate(est));
  try {
    assertFeasible(config, est);
    console.log('\nfeasible: yes');
  } catch (e) {
    if (e instanceof TerrainError) {
      console.log(`\nfeasible: NO  (${e.code})`);
      console.log(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

async function cmdGenerate(path: string, argv: string[]): Promise<void> {
  const { config, dir } = loadConfig(path);
  const outDir = resolveOutput(config, dir);
  const quiet = argv.includes('--quiet');

  const started = Date.now();
  const { dataset, solar, horizon, notes } = await generateTerrain(config, {
    onProgress: quiet ? undefined : progressBar,
  });
  const genMs = Date.now() - started;

  const exportStarted = Date.now();
  const result = exportTerrain(dataset, {
    outputDirectory: outDir,
    tileSizeSamples: config.tileSizeSamples,
    solar,
    horizon,
    notes,
    formats: {
      exr: !argv.includes('--no-exr'),
      png16: !argv.includes('--no-png'),
      npy: argv.includes('--npy'),
      glb: !argv.includes('--no-glb'),
    },
  });
  const exportMs = Date.now() - exportStarted;

  console.log(`\nterrain      ${dataset.id}  seed=${dataset.seed}`);
  console.log(`site         ${dataset.origin.site.latitudeDeg}°, ${dataset.origin.site.longitudeDeg}°`);
  console.log(
    `solar        elevation ${solar.elevationDeg.toFixed(4)}°  azimuth ${solar.azimuthDeg.toFixed(3)}°  (${solar.model})`,
  );
  if (Number.isFinite(solar.elevationDeg) && solar.elevationDeg > 0) {
    console.log(
      `             a 1 m rock casts a ${shadowLengthM(1, solar.elevationDeg).toFixed(1)} m shadow`,
    );
  }
  for (const layer of dataset.layers) {
    console.log(
      `layer        ${layer.id.padEnd(14)} ${layer.widthSamples}x${layer.heightSamples} @ ` +
        `${layer.horizontalResolutionMeters} m  [${layer.elevationProvenance}]`,
    );
  }
  console.log(
    `features     ${dataset.featureManifest.filter((f) => f.kind === 'crater').length} craters, ` +
      `${dataset.featureManifest.filter((f) => f.kind === 'rock').length} rocks`,
  );
  console.log(`artifacts    ${result.artifacts.length} files, ${(result.totalBytes / 1e6).toFixed(1)} MB`);
  console.log(`timing       generate ${genMs} ms, export ${exportMs} ms`);
  console.log(`manifest     ${result.manifestPath}`);
  if (notes.length) {
    console.log('\nnotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }
}

async function cmdValidate(dir: string): Promise<void> {
  const manifestPath = existsSync(join(dir, 'manifest.json'))
    ? join(dir, 'manifest.json')
    : resolve(dir);
  const report = validateDataset(dirname(manifestPath));
  console.log(formatValidationReport(report));
  if (!report.passed) process.exitCode = 1;
}

async function cmdReproduce(path: string): Promise<void> {
  const { config, dir } = loadConfig(path);
  const outDir = resolveOutput(config, dir);
  const manifestPath = join(outDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    console.error(`no prior export to compare against at ${manifestPath}`);
    console.error('run `lunar-terrain generate` first');
    process.exit(2);
  }
  const prior = JSON.parse(readFileSync(manifestPath, 'utf8'));

  console.log(`reproducing ${config.terrainId} from seed ${config.seed} ...`);
  const { dataset, solar, horizon, notes } = await generateTerrain(config, {
    onProgress: progressBar,
  });

  // Re-export to a scratch directory so the original is not disturbed.
  const scratch = join(outDir, '.reproduce');
  const result = exportTerrain(dataset, {
    outputDirectory: scratch,
    tileSizeSamples: config.tileSizeSamples,
    solar,
    horizon,
    notes,
  });

  const priorByPath = new Map<string, string>(
    (prior.artifacts as Array<{ path: string; sha256: string }>).map((a) => [a.path, a.sha256]),
  );

  let matched = 0;
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const a of result.artifacts) {
    const before = priorByPath.get(a.path);
    if (before === undefined) {
      missing.push(a.path);
    } else if (before === a.sha256) {
      matched++;
    } else {
      mismatches.push(a.path);
    }
  }

  console.log(`\nconfiguration hash  ${configurationHash(config)}`);
  console.log(`prior hash          ${prior.provenance?.configurationHash ?? '(absent)'}`);
  console.log(`artifacts matched   ${matched} / ${result.artifacts.length}`);
  if (missing.length) console.log(`not in prior export ${missing.length}`);
  if (mismatches.length) {
    console.log(`MISMATCHED          ${mismatches.length}`);
    for (const m of mismatches.slice(0, 20)) console.log(`  ${m}`);
    process.exitCode = 1;
  } else if (missing.length === 0) {
    console.log('\nreproduced byte-for-byte.');
  }
}

async function cmdSolar(argv: string[]): Promise<void> {
  const lat = Number(argv[0]);
  const lon = Number(argv[1]);
  const epoch = argv[2] ?? new Date().toISOString();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error('usage: lunar-terrain solar <latitudeDeg> <longitudeDeg> [isoUtc] [--sweep days]');
    process.exit(2);
  }
  const sweepIdx = argv.indexOf('--sweep');
  const t0 = parseInstant(epoch);

  if (sweepIdx >= 0) {
    const days = Number(argv[sweepIdx + 1] ?? 30);
    console.log('utc                        elev(deg)  azim(deg)  subsolar_lat  shadow_1m(m)');
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = new Date(t0.getTime() + (days * 86400_000 * i) / steps);
      const sp = solarPositionAtSite(t, lat, lon);
      const shadow = sp.elevationDeg > 0 ? shadowLengthM(1, sp.elevationDeg).toFixed(1) : 'night';
      console.log(
        `${t.toISOString()}  ${sp.elevationDeg.toFixed(4).padStart(9)}  ` +
          `${sp.azimuthDeg.toFixed(3).padStart(9)}  ${sp.subSolar.latitudeDeg.toFixed(4).padStart(12)}  ${shadow.padStart(12)}`,
      );
    }
    return;
  }

  const sp = solarPositionAtSite(t0, lat, lon);
  const ss = subSolarPoint(t0);
  console.log(`epoch (UTC)          ${t0.toISOString()}`);
  console.log(`site                 ${lat}°, ${lon}°`);
  console.log(`solar elevation      ${sp.elevationDeg.toFixed(5)}°`);
  console.log(`solar azimuth        ${sp.azimuthDeg.toFixed(5)}°  (clockwise from north, north = -Z)`);
  console.log(`solar angular radius ${sp.angularRadiusDeg.toFixed(5)}°`);
  console.log(`disc above horizon   ${(sp.discFractionAboveHorizon * 100).toFixed(1)}%`);
  console.log(`sub-solar point      ${ss.latitudeDeg.toFixed(5)}°, ${ss.longitudeDeg.toFixed(5)}°`);
  console.log(`Moon-Sun distance    ${(ss.distanceM / 1.495978707e11).toFixed(6)} AU`);
  if (sp.elevationDeg > 0) {
    console.log(`shadow of a 1 m rock ${shadowLengthM(1, sp.elevationDeg).toFixed(2)} m`);
  } else {
    console.log('shadow of a 1 m rock  (sun below the geometric horizon)');
  }
}

async function cmdServe(argv: string[]): Promise<void> {
  const portIdx = argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 8765;
  const { startServer } = await import('./server.js');
  await startServer(port);
}

async function main(): Promise<void> {
  const [, , cmd, ...argv] = process.argv;
  try {
    switch (cmd) {
      case 'generate':
        await cmdGenerate(argv[0], argv.slice(1));
        break;
      case 'estimate':
        await cmdEstimate(argv[0]);
        break;
      case 'validate':
        await cmdValidate(argv[0]);
        break;
      case 'reproduce':
        await cmdReproduce(argv[0]);
        break;
      case 'solar':
        await cmdSolar(argv);
        break;
      case 'serve':
        await cmdServe(argv);
        break;
      default:
        console.log(`lunar-terrain — lunar terrain generation sidecar

usage:
  lunar-terrain generate  <config.json> [--quiet] [--no-exr] [--no-png] [--no-glb] [--npy]
  lunar-terrain estimate  <config.json>
  lunar-terrain validate  <generated-dir>
  lunar-terrain reproduce <config.json>
  lunar-terrain solar     <latDeg> <lonDeg> [isoUtc] [--sweep <days>]
  lunar-terrain serve     [--port 8765]

coordinates: right-handed, Y-up, +X east, +Z south (north = -Z). metres throughout.`);
        process.exitCode = cmd ? 2 : 0;
    }
  } catch (e) {
    fail(e);
  }
}

void main();
