/**
 * Optional WebGPU compute preview of procedural-stack parameter changes.
 *
 * ## NON-AUTHORITATIVE — the CPU sidecar remains the sole authority
 *
 * This module exists so a parameter edit in the procedural panel can be seen
 * immediately, without a sidecar round trip. It mirrors the ALGORITHM of
 * `packages/terrain-core/src/noise.ts` (gradient noise + fBm / ridged /
 * warped-fBm stack) in WGSL, but a GPU evaluates it in f32 while the sidecar
 * evaluates it in f64 — so the output is an approximation and is NEVER
 * bit-equal to the authoritative terrain (spec §20, docs/reproducibility.md).
 * Nothing computed here may be written back into terrain data, exports, or
 * edit operations; the caller swaps it into a clearly labelled, temporary
 * preview mesh only, and every authoritative query keeps hitting the sidecar
 * (spec §33).
 *
 * What it computes: for each sample of the decimated preview grid,
 *
 *     preview[i] = sidecarHeights[i]
 *                + stack(editedParams, x, z) − stack(baselineParams, x, z)
 *
 * i.e. the sidecar's real heights plus the *delta* the parameter edit would
 * make to the procedural contribution. Craters, rocks, regolith and edits are
 * untouched by the delta, which is exactly why the result previews only the
 * procedural change. When edited == baseline both stack evaluations perform
 * the identical f32 sequence, so the delta is exactly zero.
 *
 * Seeding: the permutation tables are built on the CPU with the exported
 * `Rng` from terrain-core, from the SAME seed channels the pipeline derives
 * (`procedural:<id>` / `procedural-warp:<id>` — generate.ts), replicating the
 * private Fisher–Yates in `PerlinNoise2D`'s constructor via the public API.
 * `tests/interactive-ui.test.ts` pins this replication against
 * `PerlinNoise2D.noise` exactly, so drift in terrain-core breaks a test
 * rather than silently skewing the preview.
 */

import { Rng, deriveSeed } from '../../../packages/terrain-core/src/rng.js';

/** Fractal parameters as the sidecar config carries them. */
export interface PreviewFractal {
  octaves: number;
  lacunarity: number;
  persistence: number;
  frequency: number;
  amplitude: number;
  anisotropy: number;
}

/** One procedural layer, resolved the way the pipeline resolves it. */
export interface PreviewStackLayer {
  id: string;
  model: 'fbm' | 'ridged' | 'warped_fbm';
  /** After DEM-suppression: disabled layers contribute exactly nothing. */
  enabled: boolean;
  fractal: PreviewFractal;
  warpStrengthM: number;
  warpFrequency: number;
}

/** The decimated preview grid of one terrain layer (≤ 512 per side). */
export interface PreviewGrid {
  widthSamples: number;
  heightSamples: number;
  minX: number;
  minZ: number;
  resolutionMeters: number;
  /** The sidecar's decimated heights — the authoritative baseline. */
  baseHeights: Float32Array;
}

/**
 * Rebuild `PerlinNoise2D`'s doubled permutation table through the public API.
 *
 * Byte-for-byte the constructor's private table: `new Rng(seed)`, identity
 * 0..255, Fisher–Yates drawing `rng.intBelow(i + 1)` from 255 down, doubled
 * to 512 so lookups never wrap. Exported (as u32 for the GPU buffer) so the
 * test suite can pin it against `PerlinNoise2D.noise`.
 */
export function buildPermTable(seed: string): Uint32Array {
  const rng = new Rng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.intBelow(i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const out = new Uint32Array(512);
  for (let i = 0; i < 512; i++) out[i] = p[i & 255];
  return out;
}

// --------------------------------------------------------------------- WGSL

/**
 * WGSL mirror of noise.ts. Same permutation lookups, fade polynomial, 8
 * gradient directions, octave ladders, ridged fold and warp offsets
 * (137.17 / −91.31) — in f32, hence approximate by construction.
 */
const SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  layerCount: u32,
  _pad0: u32,
  minX: f32,
  minZ: f32,
  res: f32,
  _pad1: f32,
}

struct Layer {
  kind: u32,          // 0 fbm, 1 ridged, 2 warped_fbm
  octaves: u32,
  permOff: u32,       // offset into perm[], in elements
  warpPermOff: u32,
  lacunarity: f32,
  persistence: f32,
  frequency: f32,
  amplitude: f32,
  aniso: f32,
  warpStrength: f32,
  warpFrequency: f32,
  sign: f32,          // −1 baseline, +1 edited: the pair forms the delta
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> perm: array<u32>;
@group(0) @binding(2) var<storage, read> layers: array<Layer>;
@group(0) @binding(3) var<storage, read> baseHeights: array<f32>;
@group(0) @binding(4) var<storage, read_write> outHeights: array<f32>;

// Perlin's 6t^5 - 15t^4 + 10t^3 fade.
fn fade(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn lerpf(a: f32, b: f32, t: f32) -> f32 {
  return a + t * (b - a);
}

// Dot product with one of 8 unit-ish gradients selected by the low hash bits.
fn grad(h: u32, x: f32, y: f32) -> f32 {
  switch (h & 7u) {
    case 0u: { return x + y; }
    case 1u: { return -x + y; }
    case 2u: { return x - y; }
    case 3u: { return -x - y; }
    case 4u: { return x; }
    case 5u: { return -x; }
    case 6u: { return y; }
    default: { return -y; }
  }
}

// PerlinNoise2D.noise with the table at perm[off .. off+512).
fn pnoise(off: u32, x: f32, y: f32) -> f32 {
  let fx = floor(x);
  let fy = floor(y);
  let xf = x - fx;
  let yf = y - fy;
  let X = u32(i32(fx) & 255);
  let Y = u32(i32(fy) & 255);
  let u = fade(xf);
  let v = fade(yf);
  let pX = perm[off + X];
  let pX1 = perm[off + X + 1u];
  let aa = perm[off + pX + Y];
  let ab = perm[off + pX + Y + 1u];
  let ba = perm[off + pX1 + Y];
  let bb = perm[off + pX1 + Y + 1u];
  let x1 = lerpf(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u);
  let x2 = lerpf(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u);
  return lerpf(x1, x2, v);
}

fn fbmEval(li: u32, x: f32, y: f32) -> f32 {
  let l = layers[li];
  var freq = l.frequency;
  var amp = 1.0;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0u; i < l.octaves; i++) {
    sum += amp * pnoise(l.permOff, x * freq, y * freq * l.aniso);
    norm += amp;
    freq *= l.lacunarity;
    amp *= l.persistence;
  }
  if (norm > 0.0) { return (l.amplitude * sum) / norm; }
  return 0.0;
}

fn ridgedEval(li: u32, x: f32, y: f32) -> f32 {
  let l = layers[li];
  var freq = l.frequency;
  var amp = 1.0;
  var sum = 0.0;
  var norm = 0.0;
  var weight = 1.0;
  for (var i = 0u; i < l.octaves; i++) {
    var n = pnoise(l.permOff, x * freq, y * freq * l.aniso);
    n = 1.0 - abs(n);          // offset 1.0, as the pipeline uses
    n = n * n;
    n = n * weight;
    weight = clamp(n * 2.0, 0.0, 1.0);  // gain 2.0
    sum += amp * n;
    norm += amp;
    freq *= l.lacunarity;
    amp *= l.persistence;
  }
  if (norm > 0.0) { return l.amplitude * ((sum / norm) * 2.0 - 1.0); }
  return 0.0;
}

fn evalLayer(li: u32, x: f32, y: f32) -> f32 {
  let l = layers[li];
  if (l.kind == 0u) { return fbmEval(li, x, y); }
  if (l.kind == 1u) { return ridgedEval(li, x, y); }
  let wf = l.warpFrequency;
  let wx = pnoise(l.warpPermOff, x * wf, y * wf) * l.warpStrength;
  let wy = pnoise(l.warpPermOff, x * wf + 137.17, y * wf - 91.31) * l.warpStrength;
  return fbmEval(li, x + wx, y + wy);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  let idx = gid.y * params.width + gid.x;
  let x = params.minX + f32(gid.x) * params.res;
  let z = params.minZ + f32(gid.y) * params.res;
  var h = baseHeights[idx];
  for (var i = 0u; i < params.layerCount; i++) {
    h += layers[i].sign * evalLayer(i, x, z);
  }
  outHeights[idx] = h;
}
`;

// ------------------------------------------------------ minimal WebGPU types
// The repo does not depend on @webgpu/types; these are the structural slices
// this module actually calls, so tsc stays clean without a new dependency.

interface GpuBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface GpuBindGroup { readonly __brand?: 'bindgroup' }
interface GpuBindGroupLayout { readonly __brand?: 'bindgrouplayout' }
interface GpuComputePass {
  setPipeline(p: GpuComputePipeline): void;
  setBindGroup(index: number, group: GpuBindGroup): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}
interface GpuCommandEncoder {
  beginComputePass(): GpuComputePass;
  copyBufferToBuffer(src: GpuBuffer, srcOff: number, dst: GpuBuffer, dstOff: number, size: number): void;
  finish(): unknown;
}
interface GpuComputePipeline {
  getBindGroupLayout(index: number): GpuBindGroupLayout;
}
interface GpuDevice {
  createShaderModule(desc: { code: string }): unknown;
  createComputePipelineAsync(desc: {
    layout: 'auto';
    compute: { module: unknown; entryPoint: string };
  }): Promise<GpuComputePipeline>;
  createBuffer(desc: { size: number; usage: number }): GpuBuffer;
  createBindGroup(desc: {
    layout: GpuBindGroupLayout;
    entries: Array<{ binding: number; resource: { buffer: GpuBuffer } }>;
  }): GpuBindGroup;
  createCommandEncoder(): GpuCommandEncoder;
  queue: {
    writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView): void;
    submit(commands: unknown[]): void;
  };
  destroy(): void;
}
interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}
interface GpuApi {
  requestAdapter(options?: { forceFallbackAdapter?: boolean }): Promise<GpuAdapter | null>;
}

// GPUBufferUsage / GPUMapMode numeric values per the WebGPU spec.
const USAGE_MAP_READ = 0x0001;
const USAGE_COPY_SRC = 0x0004;
const USAGE_COPY_DST = 0x0008;
const USAGE_UNIFORM = 0x0040;
const USAGE_STORAGE = 0x0080;
const MAP_MODE_READ = 0x0001;

function gpuApi(): GpuApi | null {
  const nav = navigator as unknown as { gpu?: GpuApi };
  return nav.gpu ?? null;
}

/**
 * Every WebGPU await is raced against this deadline: a hung driver promise
 * must resolve to a clean "unavailable", never to an eternal
 * "initialising WebGPU…" spinner.
 */
const DEADLINE_MS = 10_000;

function withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not complete within ${DEADLINE_MS / 1000}s`)),
      DEADLINE_MS,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// One shared device for the whole page, created ONCE and before any WebGL
// context exists.
//
// ORDERING CONSTRAINT (verified empirically on headless Chrome 151 +
// SwiftShader, 2026-08-03): if a WebGL context is created FIRST, a later
// WebGPU device request fails with "A valid external Instance reference no
// longer exists" — or hangs — AND loses the live WebGL context; created in
// the other order, both coexist and compute dispatches complete. Requesting
// the device from a Worker instead also kills the main-thread WebGL context,
// so a worker is no escape. `GpuPreview.preInit()` therefore runs at the top
// of boot() in main.ts, before the three.js renderer is constructed. On
// browsers without navigator.gpu it is an instant no-op.
let sharedInit: Promise<GpuDevice | null> | null = null;
let sharedFailure = '';

async function initSharedDevice(): Promise<GpuDevice | null> {
  const api = gpuApi();
  if (!api) {
    sharedFailure = 'navigator.gpu is not present';
    return null;
  }
  try {
    // A hardware adapter is preferred; the SwiftShader fallback adapter is
    // accepted because a software preview is still faster than a sidecar
    // round trip for a ≤512² grid, and authority is unaffected either way.
    let adapter = await withDeadline(api.requestAdapter(), 'requestAdapter');
    if (!adapter) {
      adapter = await withDeadline(
        api.requestAdapter({ forceFallbackAdapter: true }),
        'requestAdapter(fallback)',
      );
    }
    if (!adapter) {
      sharedFailure = 'no WebGPU adapter (hardware or fallback)';
      return null;
    }
    return await withDeadline(adapter.requestDevice(), 'requestDevice');
  } catch (e) {
    sharedFailure = (e as Error).message ?? String(e);
    return null;
  }
}

const LAYER_STRUCT_WORDS = 12; // 4 × u32 + 8 × f32

/** Non-authoritative WebGPU preview evaluator. */
export class GpuPreview {
  private device: GpuDevice | null = null;
  private pipeline: GpuComputePipeline | null = null;
  /** Perm tables cached per seed-channel string. */
  private readonly permCache = new Map<string, Uint32Array>();
  /** Why init failed, for the status line. Empty until a failure. */
  failureReason = '';

  /** Feature detection only — a true result does not guarantee an adapter. */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && gpuApi() !== null;
  }

  /**
   * Create the page's shared WebGPU device. MUST run before any WebGL
   * context is created (see the ordering constraint above). Never throws;
   * a failure is recorded and later surfaces through `init()`.
   */
  static async preInit(): Promise<void> {
    if (!sharedInit) sharedInit = initSharedDevice();
    await sharedInit;
  }

  /**
   * Adopt the shared device and compile the pipeline. Returns false (with
   * `failureReason` set) on any failure — no throw, no partial state.
   */
  async init(): Promise<boolean> {
    if (this.device && this.pipeline) return true;
    if (!sharedInit) sharedInit = initSharedDevice();
    const device = await sharedInit;
    if (!device) {
      this.failureReason = sharedFailure || 'WebGPU device unavailable';
      return false;
    }
    try {
      const module = device.createShaderModule({ code: SHADER });
      this.pipeline = await withDeadline(
        device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        }),
        'pipeline compilation',
      );
      this.device = device;
      return true;
    } catch (e) {
      this.failureReason = (e as Error).message ?? String(e);
      this.device = null;
      this.pipeline = null;
      return false;
    }
  }

  private permFor(seed: string): Uint32Array {
    let t = this.permCache.get(seed);
    if (!t) {
      t = buildPermTable(seed);
      this.permCache.set(seed, t);
    }
    return t;
  }

  /**
   * Evaluate `base + stack(edited) − stack(baseline)` over the grid.
   *
   * `masterSeed` must be the seed of the DATASET currently rendered, so the
   * noise fields line up with what the sidecar actually generated. Returns a
   * NEW Float32Array — the caller's base heights are never written.
   */
  async compute(
    masterSeed: string,
    baseline: PreviewStackLayer[],
    edited: PreviewStackLayer[],
    grid: PreviewGrid,
  ): Promise<Float32Array> {
    const device = this.device;
    const pipeline = this.pipeline;
    if (!device || !pipeline) throw new Error('GPU preview not initialised');
    const n = grid.widthSamples * grid.heightSamples;
    if (grid.baseHeights.length !== n) {
      throw new Error(
        `grid mismatch: ${grid.baseHeights.length} heights for ${grid.widthSamples}×${grid.heightSamples}`,
      );
    }

    // Pack the ± pair of stacks. Perm tables depend only on (seed, layer id),
    // so baseline and edited share them.
    const entries: Array<{ layer: PreviewStackLayer; sign: number }> = [];
    for (const l of baseline) if (l.enabled) entries.push({ layer: l, sign: -1 });
    for (const l of edited) if (l.enabled) entries.push({ layer: l, sign: +1 });
    if (entries.length === 0) return grid.baseHeights.slice();

    const permOffsets = new Map<string, number>();
    const permTables: Uint32Array[] = [];
    const offsetFor = (channel: string): number => {
      let off = permOffsets.get(channel);
      if (off === undefined) {
        off = permTables.length * 512;
        permOffsets.set(channel, off);
        permTables.push(this.permFor(deriveSeed(masterSeed, channel)));
      }
      return off;
    };

    const layerWords = new ArrayBuffer(entries.length * LAYER_STRUCT_WORDS * 4);
    const u32 = new Uint32Array(layerWords);
    const f32 = new Float32Array(layerWords);
    entries.forEach(({ layer, sign }, i) => {
      const w = i * LAYER_STRUCT_WORDS;
      u32[w] = layer.model === 'fbm' ? 0 : layer.model === 'ridged' ? 1 : 2;
      u32[w + 1] = Math.max(0, Math.floor(layer.fractal.octaves));
      u32[w + 2] = offsetFor(`procedural:${layer.id}`);
      u32[w + 3] =
        layer.model === 'warped_fbm' ? offsetFor(`procedural-warp:${layer.id}`) : 0;
      f32[w + 4] = layer.fractal.lacunarity;
      f32[w + 5] = layer.fractal.persistence;
      f32[w + 6] = layer.fractal.frequency;
      f32[w + 7] = layer.fractal.amplitude;
      f32[w + 8] = layer.fractal.anisotropy;
      f32[w + 9] = layer.warpStrengthM;
      f32[w + 10] = layer.warpFrequency;
      f32[w + 11] = sign;
    });

    const permData = new Uint32Array(permTables.length * 512);
    permTables.forEach((t, i) => permData.set(t, i * 512));

    const paramsData = new ArrayBuffer(32);
    const pu = new Uint32Array(paramsData);
    const pf = new Float32Array(paramsData);
    pu[0] = grid.widthSamples;
    pu[1] = grid.heightSamples;
    pu[2] = entries.length;
    pf[4] = grid.minX;
    pf[5] = grid.minZ;
    pf[6] = grid.resolutionMeters;

    const byteLen = n * 4;
    const paramsBuf = device.createBuffer({ size: 32, usage: USAGE_UNIFORM | USAGE_COPY_DST });
    const permBuf = device.createBuffer({
      size: permData.byteLength,
      usage: USAGE_STORAGE | USAGE_COPY_DST,
    });
    const layersBuf = device.createBuffer({
      size: layerWords.byteLength,
      usage: USAGE_STORAGE | USAGE_COPY_DST,
    });
    const baseBuf = device.createBuffer({ size: byteLen, usage: USAGE_STORAGE | USAGE_COPY_DST });
    const outBuf = device.createBuffer({ size: byteLen, usage: USAGE_STORAGE | USAGE_COPY_SRC });
    const staging = device.createBuffer({ size: byteLen, usage: USAGE_MAP_READ | USAGE_COPY_DST });

    try {
      device.queue.writeBuffer(paramsBuf, 0, new Uint8Array(paramsData));
      device.queue.writeBuffer(permBuf, 0, permData);
      device.queue.writeBuffer(layersBuf, 0, new Uint8Array(layerWords));
      device.queue.writeBuffer(baseBuf, 0, grid.baseHeights);

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuf } },
          { binding: 1, resource: { buffer: permBuf } },
          { binding: 2, resource: { buffer: layersBuf } },
          { binding: 3, resource: { buffer: baseBuf } },
          { binding: 4, resource: { buffer: outBuf } },
        ],
      });

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(grid.widthSamples / 8),
        Math.ceil(grid.heightSamples / 8),
      );
      pass.end();
      encoder.copyBufferToBuffer(outBuf, 0, staging, 0, byteLen);
      device.queue.submit([encoder.finish()]);

      await staging.mapAsync(MAP_MODE_READ);
      const result = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      return result;
    } finally {
      paramsBuf.destroy();
      permBuf.destroy();
      layersBuf.destroy();
      baseBuf.destroy();
      outBuf.destroy();
      staging.destroy();
    }
  }

  dispose(): void {
    // The device is the page-wide shared instance (see preInit) — dropping
    // the references releases this evaluator; the device itself stays valid
    // for a later re-init.
    this.device = null;
    this.pipeline = null;
    this.permCache.clear();
  }
}
