/**
 * Interactive UI tests (spec §23, §26 "Playwright for UI tests").
 *
 * Runs the **real** stack: a live sidecar, a live Vite server, and a real
 * Chromium with WebGL. Terrain is generated from the real LOLA DEM, streamed
 * over the protocol, and rendered — then the framebuffer is read back to
 * confirm something was actually drawn.
 *
 * A UI test that only checks the DOM would pass on a black canvas, so the
 * pixel checks matter: they are the difference between "the page loaded" and
 * "the terrain rendered".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WebSocketServer } from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';

const REPO = resolve(__dirname, '..');
const UI_ROOT = join(REPO, 'apps/interactive-ui');
const SHOTS = join(REPO, '.test-artifacts/ui');
const DEM = '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';
const SIDECAR_PORT = 8793;
const UI_PORT = 5199;

/**
 * An epoch when the Sun is above the horizon at the demonstration site.
 *
 * Solar elevation there peaks at 2.05 deg and is negative much of the month, so
 * the lit-render checks must pick a time when there is light to see by.
 */
const LIT_EPOCH = '2026-01-01T00:00:00Z';

let sidecar: WebSocketServer;
let vite: ViteDevServer;
let browser: Browser;
let page: Page;
let consoleErrors: string[] = [];

const demAvailable = existsSync(DEM);

/** Fraction of non-black pixels in the canvas — proof something rendered. */
async function litPixelFraction(p: Page): Promise<number> {
  return p.evaluate(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return -1;
    const w = canvas.width;
    const h = canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) lit++;
    }
    return lit / (w * h);
  });
}


/** Plain-Playwright helpers: vitest's expect has no Playwright matchers. */
async function isVisible(p: Page, selector: string): Promise<boolean> {
  return p.locator(selector).isVisible();
}

async function textOf(p: Page, selector: string): Promise<string> {
  return (await p.locator(selector).textContent()) ?? '';
}

/** Wait until an element's text contains `needle`, or throw with what it held. */
async function waitForText(
  p: Page,
  selector: string,
  needle: string,
  timeout = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await textOf(p, selector);
    if (last.includes(needle)) return last;
    await p.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${selector} to contain ${JSON.stringify(needle)}; last value was ${JSON.stringify(last)}`);
}

/** Wait until an element's class list contains `cls`. */
async function waitForClass(p: Page, selector: string, cls: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = (await p.locator(selector).getAttribute('class')) ?? '';
    if (last.split(/\s+/).includes(cls)) return;
    await p.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${selector} to have class ${cls}; last was ${JSON.stringify(last)}`);
}

describe.skipIf(!demAvailable)('interactive UI', () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });

    sidecar = await startServer(SIDECAR_PORT);
    // Configured inline rather than via the app's vite.config.ts, whose
    // strictPort pins 5173 and would fight the test's port.
    vite = await createServer({
      root: UI_ROOT,
      configFile: false,
      server: { port: UI_PORT, strictPort: true, host: '127.0.0.1' },
      logLevel: 'error',
    });
    await vite.listen();

    // Use a browser that is already on the machine rather than downloading
    // one: this Playwright build expects a chromium revision the cache does
    // not have, and a test suite should not require network access to run.
    const executablePath = [
      process.env.LTS_BROWSER,
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((p) => p && existsSync(p));

    browser = await chromium.launch({
      executablePath,
      args: [
        // Software GL so this runs on a headless box with no display.
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
        '--no-sandbox',
      ],
    });
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    // Record which resource failed, so a 404 is diagnosable rather than a
    // bare "Failed to load resource".
    page.on('response', (r) => {
      if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`);
    });

    await page.goto(`http://127.0.0.1:${UI_PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  }, 180_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await vite?.close();
    await new Promise<void>((res) => sidecar.close(() => res()));
  });

  it('boots without console errors', () => {
    if (consoleErrors.length) console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors, null, 2));
    expect(consoleErrors).toEqual([]);
  });

  it('creates a WebGL context and renders a frame', async () => {
    const fraction = await litPixelFraction(page);
    // Before terrain loads the scene is empty black sky, so this only proves
    // the context exists and readback works.
    expect(fraction).toBeGreaterThanOrEqual(0);
  });

  it('shows every status field the spec requires', async () => {
    // Spec §23: seed, selected layer, resolution, dimensions, cursor,
    // elevation, memory estimate and sidecar status must always be visible.
    for (const id of [
      'status-job',
      'status-memory',
      'status-layer',
      'status-resolution',
      'status-dimensions',
      'status-cursor',
      'status-elevation',
      'status-seed',
      'status-sidecar',
    ]) {
      expect(await isVisible(page, `#${id}`), id).toBe(true);
    }
  });

  it('renders every required panel', async () => {
    for (const panel of [
      'project',
      'layers',
      'dem',
      'procedural',
      'craters',
      'rocks',
      'editing',
      'visualization',
      'solar',
      'export',
      'validation',
      'performance',
    ]) {
      expect(await isVisible(page, `[data-panel="${panel}"]`), panel).toBe(true);
    }
  });

  it('lists the nested layers of the active preset', async () => {
    const rows = page.locator('#layer-rows tr');
    expect(await rows.count()).toBe(3);
    const last = (await rows.nth(2).textContent()) ?? '';
    expect(last).toContain('operational');
    expect(last).toContain('0.01');
  });

  it('connects to the sidecar', async () => {
    await page.fill('#sidecar-url', `ws://127.0.0.1:${SIDECAR_PORT}`);
    await page.click('#btn-connect');
    await waitForClass(page, '#connection-indicator', 'connected', 20_000);
    await waitForText(page, '#status-sidecar', 'protocol 1.0.0', 20_000);
  });

  it('estimates before generating and reports the memory cost', async () => {
    await page.click('#btn-estimate');
    await waitForText(page, '#export-result', 'feasible  yes', 30_000);
    expect(await textOf(page, '#status-memory')).not.toBe('—');
  });

  it('generates real terrain and renders it', async () => {
    // Swap to the smaller pad preset so the test stays quick, and point the
    // output somewhere disposable.
    await page.selectOption('#cfg-preset', 'rover_test_pad');
    await page.fill('#cfg-terrain-id', 'ui_roundtrip');
    await page.fill('#cfg-output', join(REPO, '.test-artifacts/ui-generated'));
    // Pick an epoch when the Sun is actually up. At 89.46 S it only clears the
    // horizon for part of each month, and the default 2026-08-03 has it at
    // -0.46 deg -- so a black frame there is physically correct, not a bug.
    await page.fill('#cfg-epoch', LIT_EPOCH);

    await page.click('#btn-generate');
    await waitForText(page, '#status-job', 'complete', 300_000);

    // The inspector must be populated from the real dataset.
    await waitForText(page, '#insp-terrain', 'ui_roundtrip', 30_000);
    expect(await textOf(page, '#insp-layers')).toBe('2');
    const craters = await page.locator('#insp-craters').textContent();
    expect(Number((craters ?? '0').replace(/,/g, ''))).toBeGreaterThan(0);

    // And the viewport must actually show geometry.
    await page.waitForTimeout(1500);
    // The Sun must actually be up at the chosen epoch, or the lit check below
    // would be testing nothing.
    const elevation = Number((await textOf(page, '#solar-elevation')).replace('\u00b0', ''));
    expect(elevation).toBeGreaterThan(0);

    const fraction = await litPixelFraction(page);
    expect(fraction).toBeGreaterThan(0.02);

    await page.screenshot({ path: join(SHOTS, '01-lit-terrain.png') });
  }, 400_000);

  it('cites its real data source in the provenance panel', async () => {
    const text = await page.locator('#insp-provenance').textContent();
    expect(text).toMatch(/LOLA|PGDA/i);
    expect(text).toMatch(/synthetic:/);
  });

  it('reports solar geometry consistent with a polar site', async () => {
    await page.click('#btn-solar');
    await waitForText(page, '#solar-elevation', '°', 20_000);
    const elevation = Number((await page.locator('#solar-elevation').textContent())!.replace('°', ''));
    // The Sun cannot climb far above the horizon at 89.5°S.
    expect(Math.abs(elevation)).toBeLessThan(2.2);
    const subsolar = Number((await page.locator('#solar-subsolar').textContent())!.replace('°', ''));
    expect(Math.abs(subsolar)).toBeLessThan(1.6);
  });

  it('switches analysis overlays and changes what is drawn', async () => {
    const shots: Record<string, number> = {};
    for (const overlay of ['elevation', 'slope', 'traversability', 'semantic']) {
      await page.selectOption('#viz-overlay', overlay);
      await page.waitForTimeout(500);
      shots[overlay] = await litPixelFraction(page);
      await page.screenshot({ path: join(SHOTS, `02-overlay-${overlay}.png`) });
    }
    // False-colour overlays are unlit, so they light far more of the frame
    // than the shadowed lit view.
    for (const [, fraction] of Object.entries(shots)) {
      expect(fraction).toBeGreaterThan(0.02);
    }
    expect(await textOf(page, '#legend-note')).toContain('crater/rock classes');
  });

  it('labels the traversability overlay as a synthetic heuristic', async () => {
    await page.selectOption('#viz-overlay', 'traversability');
    await page.waitForTimeout(300);
    // Spec §22/§33: heuristics must be marked wherever they are shown.
    expect(await textOf(page, '#legend-note')).toContain('SYNTHETIC HEURISTIC');
  });

  it('switches to the rover-height camera', async () => {
    await page.selectOption('#viz-overlay', 'lit');
    await page.selectOption('#viz-camera', 'rover');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOTS, '03-rover-view.png') });
    const fraction = await litPixelFraction(page);
    expect(fraction).toBeGreaterThanOrEqual(0);
  });

  it('renders a top-down view with layer boundaries', async () => {
    await page.selectOption('#viz-camera', 'topdown');
    await page.selectOption('#viz-overlay', 'elevation');
    await page.check('#viz-grid');
    await page.waitForTimeout(800);
    // Unlit false colour, so coverage reflects geometry rather than the Sun.
    const fraction = await litPixelFraction(page);
    expect(fraction).toBeGreaterThan(0.05);
    await page.screenshot({ path: join(SHOTS, '04-topdown.png') });
  });

  it('applies an edit through the protocol and reports mass balance', async () => {
    await page.selectOption('#viz-camera', 'orbit');
    await page.waitForTimeout(500);

    await page.click('#brush-buttons button[data-brush="lower"]');
    await waitForClass(page, '#brush-buttons button[data-brush="lower"]', 'active', 5_000);
    await page.check('#brush-mass-conserving');
    await page.fill('#brush-radius', '1.5');
    await page.fill('#brush-strength', '0.25');

    // Click the middle of the viewport, which looks at the site centre.
    const box = (await page.locator('#canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await waitForText(page, '#edit-status', 'cut', 120_000);
    const status = await page.locator('#edit-status').textContent();
    expect(status).toMatch(/delta-\d+/);
    expect(status).toMatch(/error \d+\.\d+%/);

    // Mass-conserving edits must balance to well under a percent.
    const err = Number(/error (\d+\.\d+)%/.exec(status ?? '')?.[1] ?? '99');
    expect(err).toBeLessThan(1);

    await page.screenshot({ path: join(SHOTS, '05-after-edit.png') });
  }, 200_000);

  it('exports and validates from the UI', async () => {
    await page.click('#btn-validate');
    await waitForText(page, '#validation-result', 'PASSED', 180_000);
    await waitForClass(page, '#validation-result', 'pass', 10_000);
  }, 200_000);

  it('finishes with no console errors', () => {
    // Filter the benign WebGL software-rasteriser notices swiftshader emits.
    const real = consoleErrors.filter((e) => !/swiftshader|SwiftShader|GroupMarker/.test(e));
    expect(real).toEqual([]);
  });

  it('renders the construction brush chips', async () => {
    for (const kind of [
      'ramp',
      'pad',
      'spoil_pile',
      'wheel_track',
      'polygonal_cut',
      'polygonal_fill',
    ]) {
      expect(
        await isVisible(page, `#construction-buttons button[data-brush="${kind}"]`),
        kind,
      ).toBe(true);
    }
  });

  it('applies a spoil pile and reports the repose clamp', async () => {
    await page.click('#construction-buttons button[data-brush="spoil_pile"]');
    await waitForClass(
      page,
      '#construction-buttons button[data-brush="spoil_pile"]',
      'active',
      5_000,
    );
    await page.uncheck('#brush-mass-conserving');
    // A 5 m pile on a 2 m base demands a 68 deg cone — far past the 35 deg
    // regolith angle of repose, so the server must clamp and say so.
    await page.fill('#brush-radius', '2');
    await page.fill('#brush-strength', '5');

    const box = (await page.locator('#canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await waitForText(page, '#edit-status', 'repose', 120_000);
    const status = await textOf(page, '#edit-status');
    expect(status).toMatch(/delta-\d+/);
    // 2 m * tan(35 deg) = 1.400 m.
    expect(status).toContain('height clamped to 1.400 m by 35 deg repose');
  }, 200_000);

  it('collects polygon vertices and applies a polygonal cut', async () => {
    await page.click('#construction-buttons button[data-brush="polygonal_cut"]');
    await waitForClass(
      page,
      '#construction-buttons button[data-brush="polygonal_cut"]',
      'active',
      5_000,
    );
    const box = (await page.locator('#canvas').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Clicks in polygon mode add vertices instead of applying a brush.
    await page.mouse.click(cx - 60, cy - 40);
    await waitForText(page, '#edit-status', 'polygon: 1 vertices', 10_000);
    await page.mouse.click(cx + 60, cy - 40);
    await waitForText(page, '#edit-status', 'polygon: 2 vertices', 10_000);
    await page.mouse.click(cx, cy + 50);
    await waitForText(page, '#edit-status', 'polygon: 3 vertices', 10_000);

    await page.click('#btn-polygon-apply');
    await waitForText(page, '#edit-status', 'delta-', 120_000);
    const status = await textOf(page, '#edit-status');
    expect(status).toMatch(/delta-\d+/);
    expect(status).toMatch(/cut \d+\.\d+ m³/);
  }, 200_000);

  it('refuses to undo a construction operation with the honest message', async () => {
    // The last applied operation is the polygonal_cut above; its pre-edit
    // surface is destroyed, so undo must refuse rather than guess.
    await page.click('#btn-undo');
    await waitForText(page, '#edit-status', 'not invertible', 10_000);
    expect(await textOf(page, '#edit-status')).toContain("cannot undo 'polygonal_cut'");
  });

  it('captures the construction screenshot', async () => {
    await page.screenshot({ path: join(SHOTS, '06-construction.png') });
    expect(existsSync(join(SHOTS, '06-construction.png'))).toBe(true);
  });

  it('writes screenshots for visual inspection', () => {
    for (const name of [
      '01-lit-terrain.png',
      '02-overlay-elevation.png',
      '02-overlay-slope.png',
      '02-overlay-semantic.png',
      '03-rover-view.png',
      '04-topdown.png',
      '05-after-edit.png',
      '06-construction.png',
    ]) {
      expect(existsSync(join(SHOTS, name))).toBe(true);
    }
    writeFileSync(
      join(SHOTS, 'README.txt'),
      'Screenshots from tests/interactive-ui.test.ts, rendered in headless Chromium\n' +
        'with SwiftShader over terrain generated from the real LOLA Site01 DEM.\n',
    );
  });
});
