/**
 * Capture the repository's documentation media — screenshots and GIF frames —
 * from the REAL stack: a live sidecar, a live Vite server, and a real
 * Chromium rendering terrain generated from the real LOLA/PGDA Site01 DEM.
 *
 * Nothing here is mocked or staged: every frame is the authoring UI rendering
 * the shipped `examples/south_pole_site_01` site (plus the rover_test_pad
 * preset for the construction sequence), lit by the real ephemeris at the
 * epochs named below. The solar-sweep frames step through the site's actual
 * lit window (late Dec 2025 – late Jan 2026, elevation 0.8°–1.7°, azimuth
 * sweeping the full 360°).
 *
 * Run:  npx tsx scripts/capture-media.ts
 * Then: scripts/assemble-media.sh   (ffmpeg/ImageMagick assembly into
 *                                    docs/media/ and paper/figures/)
 *
 * Ports 8814 (sidecar) and 5201 (Vite) — see the port registry in CLAUDE.md.
 */
import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../apps/headless-server/src/server.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(REPO, '.test-artifacts', 'media');
const SIDECAR_PORT = 8814;
const UI_PORT = 5201;

/** Peak of the site's lit arc: elevation 1.46°, azimuth 61° (analytic chain). */
const HERO_EPOCH = '2026-01-10T00:00:00Z';

/**
 * 30 frames across the demonstrated lit window (2025-12-20 → 2026-01-19).
 * The Sun stays up the whole span while its azimuth sweeps ~360°, so shadows
 * rotate around every crater — the point the GIF exists to make.
 */
const SWEEP_START = Date.parse('2025-12-20T00:00:00Z');
const SWEEP_END = Date.parse('2026-01-19T12:00:00Z');
const SWEEP_FRAMES = 30;

function rpc(port: number): {
  call: (method: string, params?: unknown) => Promise<any>;
  close: () => void;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error)));
      else p.res(m.result);
    }
  });
  const open = new Promise<void>((res) => ws.on('open', () => res()));
  return {
    call: async (method, params) => {
      await open;
      return new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function waitText(page: Page, selector: string, needle: string, timeout = 60_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = (await page.locator(selector).textContent()) ?? '';
    if (last.includes(needle)) return last;
    await page.waitForTimeout(200);
  }
  throw new Error(`timeout waiting for ${selector} ~ ${JSON.stringify(needle)}; last=${JSON.stringify(last)}`);
}

async function canvasShot(page: Page, path: string): Promise<void> {
  // Two rAF ticks so the frame reflects the last state change before capture.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.locator('#canvas').screenshot({ path });
}

/** `--construction-only`: keep existing stills/sweep frames, redo construction. */
const ONLY_CONSTRUCTION = process.argv.includes('--construction-only');

async function main(): Promise<void> {
  if (ONLY_CONSTRUCTION) {
    rmSync(join(WORK, 'construction'), { recursive: true, force: true });
  } else {
    rmSync(WORK, { recursive: true, force: true });
  }
  for (const d of ['stills', 'sweep', 'construction']) mkdirSync(join(WORK, d), { recursive: true });

  console.log('starting sidecar + vite…');
  const sidecar = await startServer(SIDECAR_PORT);
  const vite = await createServer({
    root: join(REPO, 'apps/interactive-ui'),
    configFile: false,
    server: { port: UI_PORT, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await vite.listen();

  if (!ONLY_CONSTRUCTION) {
    // Generate the shipped demonstration site directly over the protocol; the
    // page then picks it up through connect-time auto-load.
    console.log('generating south_pole_site_01…');
    const client = rpc(SIDECAR_PORT);
    const config = JSON.parse(readFileSync(join(REPO, 'examples/south_pole_site_01/config.json'), 'utf8'));
    const { jobId } = await client.call('terrain.generate', { config });
    for (;;) {
      const st = await client.call('terrain.getStatus', { jobId });
      if (st.status === 'complete') break;
      if (st.status === 'failed') throw new Error(`generation failed: ${JSON.stringify(st.error)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    client.close();
  }

  const executablePath = [process.env.LTS_BROWSER, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
    (p) => p && existsSync(p),
  );
  const browser = await chromium.launch({
    executablePath,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(`http://127.0.0.1:${UI_PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });

  await page.fill('#sidecar-url', `ws://127.0.0.1:${SIDECAR_PORT}`);
  await page.click('#btn-connect');
  if (!ONLY_CONSTRUCTION) {
  await waitText(page, '#insp-terrain', 'south_pole_site_01');
  console.log('dataset auto-loaded from sidecar');

  await page.fill('#cfg-epoch', HERO_EPOCH);
  await page.click('#btn-solar');
  await waitText(page, '#solar-elevation', '1.46');
  await page.waitForTimeout(1200);

  // ---- stills -------------------------------------------------------------
  console.log('stills…');
  await page.screenshot({ path: join(WORK, 'stills', 'authoring-ui.png') });
  await canvasShot(page, join(WORK, 'stills', 'hero-lit.png'));

  for (const overlay of ['elevation', 'slope', 'semantic', 'traversability']) {
    await page.selectOption('#viz-overlay', overlay);
    await page.waitForTimeout(700);
    await canvasShot(page, join(WORK, 'stills', `overlay-${overlay}.png`));
  }

  await page.selectOption('#viz-camera', 'topdown');
  await page.selectOption('#viz-overlay', 'elevation');
  await page.waitForTimeout(900);
  await canvasShot(page, join(WORK, 'stills', 'topdown-elevation.png'));

  await page.selectOption('#viz-camera', 'orbit');
  await page.selectOption('#viz-overlay', 'lit');
  await page.waitForTimeout(700);

  // ---- solar sweep frames -------------------------------------------------
  console.log('solar sweep…');
  const litFractions: number[] = [];
  for (let i = 0; i < SWEEP_FRAMES; i++) {
    const t = SWEEP_START + ((SWEEP_END - SWEEP_START) * i) / (SWEEP_FRAMES - 1);
    const epoch = new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await page.fill('#cfg-epoch', epoch);
    await page.click('#btn-solar');
    // The elevation readout changes per epoch; waiting on the degree glyph is
    // not enough, so give the light + shadow update a settle beat instead.
    await page.waitForTimeout(650);
    await canvasShot(page, join(WORK, 'sweep', `sweep-${String(i).padStart(2, '0')}.png`));
    const frac = await page.evaluate(() => {
      const canvas = document.getElementById('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return -1;
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let lit = 0;
      for (let j = 0; j < px.length; j += 4) if (px[j] > 8 || px[j + 1] > 8 || px[j + 2] > 8) lit++;
      return lit / (canvas.width * canvas.height);
    });
    litFractions.push(frac);
    const el = ((await page.locator('#solar-elevation').textContent()) ?? '').trim();
    const az = ((await page.locator('#solar-azimuth').textContent()) ?? '').trim();
    console.log(`  frame ${i}: ${epoch} el=${el} az=${az} lit=${frac.toFixed(3)}`);
  }
  // Every sweep frame must actually show sunlit terrain, and the lighting must
  // vary — identical frames would mean the recompute button stopped re-lighting.
  if (litFractions.some((f) => f < 0.02)) throw new Error('a sweep frame rendered dark');
  if (Math.max(...litFractions) - Math.min(...litFractions) < 0.01) {
    throw new Error('sweep frames show no lighting variation');
  }
  } // end !ONLY_CONSTRUCTION

  // ---- construction sequence on the rover test pad ------------------------
  // The demo site's context layer spans 1 km, so metre-scale construction is
  // sub-pixel there; the 200 m rover_test_pad preset makes the edits visible.
  console.log('construction sequence (rover_test_pad)…');
  await page.selectOption('#cfg-preset', 'rover_test_pad');
  await page.fill('#cfg-terrain-id', 'media_construction');
  await page.fill('#cfg-output', join(WORK, 'construction-generated'));
  await page.fill('#cfg-epoch', HERO_EPOCH);
  await page.click('#btn-generate');
  await waitText(page, '#status-job', 'complete', 300_000);
  await page.waitForTimeout(1200);

  await waitText(page, '#insp-terrain', 'media_construction', 60_000);

  // Edits go over the protocol (the same terrain.applyOperation the UI and
  // Godot dock use), and each frame is a full page re-load + connect-time
  // auto-load — so every frame shows the sidecar's AUTHORITATIVE field, not
  // a client-side preview. Frames use the unlit SLOPE overlay: at 1.46°
  // solar elevation a lit flat pad is nearly black, and the elevation ramp
  // spans the layer's tens of metres of relief — metre-scale construction
  // reads as slope discontinuities (rims, ramp edges, rut walls), not as
  // elevation colour.
  const ops = rpc(SIDECAR_PORT);
  const heightAt = async (x: number, z: number): Promise<number> =>
    (await ops.call('terrain.getHeight', { x, z })).elevationM;

  let frame = 0;
  const frameChecksums: string[] = [];
  const shoot = async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
    await page.fill('#sidecar-url', `ws://127.0.0.1:${SIDECAR_PORT}`);
    await page.click('#btn-connect');
    await waitText(page, '#insp-terrain', 'media_construction', 60_000);
    await page.selectOption('#viz-overlay', 'slope');
    await page.selectOption('#viz-camera', 'topdown');
    await page.waitForTimeout(900);
    await canvasShot(page, join(WORK, 'construction', `c-${String(frame++).padStart(2, '0')}.png`));
    const sum = await page.evaluate(() => {
      const canvas = document.getElementById('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return 'no-gl';
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let h = 2166136261;
      for (let j = 0; j < px.length; j += 16) { h ^= px[j]; h = Math.imul(h, 16777619); }
      return String(h >>> 0);
    });
    frameChecksums.push(sum);
    console.log(`  construction frame ${frame - 1}: checksum ${sum}`);
  };
  await shoot(); // untouched pad site

  const apply = async (operation: Record<string, unknown>) => {
    const r = await ops.call('terrain.applyOperation', {
      operation: { layerId: 'context-0', ...operation },
    });
    console.log(
      `  ${operation.kind}: delta ${r.delta?.deltaId ?? '?'} cut ${r.delta?.massBalance?.removedVolumeM3?.toFixed(1)} m³ fill ${r.delta?.massBalance?.depositedVolumeM3?.toFixed(1)} m³`,
    );
    await shoot();
  };

  // Placement constraints, both measured from failed frames: the topdown
  // camera shows only ~±50 m of the 200 m context layer (z beyond +50 and
  // x beyond ~±59 render nothing — the first wheel track sat at z=60 and
  // produced a frame IDENTICAL to its predecessor), and the central 25 m
  // operational layer draws over the context, so ops keep clear of it.
  await apply({
    kind: 'pad', centerXMeters: -34, centerZMeters: -30, radiusMeters: 13,
    targetElevationMeters: await heightAt(-34, -30),
  });
  await apply({
    kind: 'ramp', centerXMeters: 25, centerZMeters: -30, headingDegrees: 45,
    lengthMeters: 24, radiusMeters: 4,
    targetElevationMeters: (await heightAt(25, -30)) + 2,
  });
  await apply({
    kind: 'spoil_pile', centerXMeters: 40, centerZMeters: 14, radiusMeters: 7,
    strengthMeters: 2.5,
  });
  await apply({
    kind: 'lower', centerXMeters: -35, centerZMeters: 28, radiusMeters: 9,
    strengthMeters: 1.5, massConserving: true,
  });
  // Rut depth is exaggerated (0.8 m) for legibility: a realistic 0.1–0.4 m
  // rut reads as under one colour step at this scale.
  await apply({
    kind: 'wheel_track', centerXMeters: 0, centerZMeters: 38, headingDegrees: 90,
    lengthMeters: 70, radiusMeters: 6, strengthMeters: 0.8,
  });
  await apply({
    kind: 'polygonal_cut', polygonXZ: [[26, 28], [48, 34], [32, 46]],
    radiusMeters: 2, centerXMeters: 35, centerZMeters: 36,
    targetElevationMeters: (await heightAt(35, 36)) - 2,
  });
  ops.close();

  // Every frame must differ from its predecessor — this is exactly the
  // failure the first capture shipped (stale-status waits, identical frames).
  for (let i = 1; i < frameChecksums.length; i++) {
    if (frameChecksums[i] === frameChecksums[i - 1]) {
      throw new Error(`construction frames ${i - 1} and ${i} are identical — edit did not render`);
    }
  }

  // Full-page still with the operation history the sequence produced.
  await page.click('#btn-history-refresh');
  await waitText(page, '#history-rows', 'polygonal_cut', 30_000);
  await page.screenshot({ path: join(WORK, 'stills', 'construction-ui.png') });

  await browser.close();
  await vite.close();
  await new Promise<void>((res) => sidecar.close(() => res()));
  console.log(`done — frames in ${WORK}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
