/**
 * Worker-thread pool for the terrain generation hot loops (spec §14).
 *
 * Parallelises the two per-sample stages whose samples are mutually
 * independent — `base_relief` and `regolith_microrelief` — by splitting each
 * layer's rows into bands and evaluating the bands on `node:worker_threads`.
 * Crater stamping is NOT parallelised: craters accumulate `+=` into
 * overlapping footprints, so their result depends on accumulation order and
 * splitting them across threads would change bits.
 *
 * BIT-EXACTNESS: every worker executes the byte-for-byte same per-sample
 * IEEE-754 operation sequence as the synchronous reference loops in
 * `generate.ts` (see `reliefWorker.ts`, which mirrors them line for line).
 * Each sample is a pure function of (x, z), the seeds and the value already
 * at its own index; row partitioning changes which THREAD computes a sample,
 * never the operations or their order within a sample, and no accumulation
 * crosses sample boundaries. Same seed → same Float32Array bits, workers or
 * not (docs/reproducibility.md).
 *
 * RACE FREEDOM (why no atomics are needed): each band task owns the disjoint
 * index range [rowStart*widthSamples, rowEnd*widthSamples) of the shared
 * height/mask buffers. No two bands overlap, so no address is ever written by
 * two threads. Reads within a band are either of loop-invariant scalars or of
 * the band's own indices, whose pre-stage values were written before the pool
 * was posted any work. `postMessage`/`'message'` delivery establishes the
 * happens-before edges: the main thread's copy-in completes before any worker
 * receives its task, and a worker's writes complete before the main thread
 * observes its completion message. Plain (non-atomic) stores are therefore
 * fully visible and never concurrent on the same address.
 *
 * TS-UNDER-NODE MECHANISM: a worker cannot be spawned on the `.ts` file
 * directly — neither the tsx CLI's loader nor vitest's vite-node transforms
 * extend into real worker threads, and on Node 20 `execArgv:
 * ['--import', 'tsx']` does not register the loader in the worker either
 * (verified empirically; the worker dies with ERR_UNKNOWN_FILE_EXTENSION).
 * Instead each worker is spawned on a tiny eval'd bootstrap that registers
 * tsx's ESM loader IN-THREAD via `tsx/esm/api` `register()` and then
 * dynamically imports `reliefWorker.ts`; tsx resolves the
 * `@lts/terrain-core` tsconfig path exactly as it does for the main thread.
 * Messages posted before the import completes are buffered by the port, so
 * no readiness handshake is needed. This works identically under `npx tsx`
 * and `npx vitest run`.
 */

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { FractalParameters, NoiseModel } from '@lts/terrain-core';

/**
 * Resolve `tsx/esm/api` from THIS file's position so the worker does not
 * depend on its cwd containing a node_modules; falls back to the bare
 * specifier (cwd resolution) if the local resolution fails.
 */
function tsxApiSpecifier(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
  } catch {
    return 'tsx/esm/api';
  }
}

const WORKER_URL = new URL('./reliefWorker.ts', import.meta.url);

function workerBootstrap(): string {
  return `
(async () => {
  const { register } = await import(${JSON.stringify(tsxApiSpecifier())});
  register();
  await import(${JSON.stringify(WORKER_URL.href)});
})().catch((e) => {
  console.error('terrain reliefWorker failed to load:', e);
  process.exit(1);
});
`;
}

/**
 * Default pool size: min(cores − 2, 8). Two cores are left for the main
 * thread and the rest of the machine; beyond 8 threads the band dispatch is
 * memory-bandwidth-bound and returns diminish.
 */
export function defaultWorkerThreads(): number {
  return Math.max(1, Math.min(availableParallelism() - 2, 8));
}

/**
 * Layers below this sample count are generated synchronously even when a pool
 * is available — worker startup and the copy in/out of the shared scratch
 * cost more than the loop itself at this size (~256k samples ≈ 1 MB float32).
 */
export const PARALLEL_THRESHOLD_SAMPLES = 262_144;

/** One procedural stack layer on the wire: spec + the two seed channels. */
export interface WireStackLayer {
  id: string;
  model: NoiseModel;
  enabled: boolean;
  fractal: FractalParameters;
  warpStrengthM?: number;
  warpFrequency?: number;
  /** Seed for the layer's noise, derived on the main thread's SeedTree. */
  noiseSeed: string;
  /** Seed for the layer's warp noise, derived on the main thread's SeedTree. */
  warpSeed: string;
}

/** A base-relief row band (mirrors the generate.ts base_relief loop). */
export interface BaseReliefBandTask {
  kind: 'base_relief';
  rowStart: number;
  rowEnd: number;
  minX: number;
  minZ: number;
  res: number;
  widthSamples: number;
  tanSlope: number;
  slopeDirX: number;
  slopeDirZ: number;
  stack: WireStackLayer[];
  measured: boolean;
  measuredPlusSynthetic: number;
  /** SharedArrayBuffer-backed view of the layer's heights. */
  height: Float32Array;
  /** SharedArrayBuffer-backed elevation-source mask; null when not measured. */
  elevationSource: Uint8Array | null;
}

/** A regolith row band (mirrors the generate.ts regolith loop). */
export interface RegolithBandTask {
  kind: 'regolith';
  rowStart: number;
  rowEnd: number;
  minX: number;
  minZ: number;
  res: number;
  widthSamples: number;
  fractal: FractalParameters;
  noiseSeed: string;
  /** SharedArrayBuffer-backed view of the layer's heights. */
  height: Float32Array;
}

export type BandTask = BaseReliefBandTask | RegolithBandTask;
export type BandMessage = BandTask & { id: number };
export type BandReply =
  | { id: number; ok: true }
  | { id: number; ok: false; error: string };

interface PendingBand {
  resolve: () => void;
  reject: (e: Error) => void;
}

/** A small fixed-size pool of band-evaluating workers. */
export class ReliefWorkerPool {
  readonly size: number;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: BandMessage[] = [];
  private readonly pending = new Map<number, PendingBand>();
  private nextId = 0;
  private destroyed = false;
  private failure: Error | null = null;

  constructor(size: number) {
    this.size = Math.max(1, Math.floor(size));
    const bootstrap = workerBootstrap();
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(bootstrap, { eval: true });
      w.on('message', (reply: BandReply) => this.onReply(w, reply));
      w.on('error', (err) => this.onWorkerError(err));
      w.on('exit', (code) => {
        // A worker that dies with work outstanding (e.g. its bootstrap
        // failed) must not leave submitters hanging forever.
        if (code !== 0 && !this.destroyed) {
          this.onWorkerError(new Error(`terrain worker exited with code ${code}`));
        }
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Submit one band; resolves when the worker reports the band written. */
  submit(task: BandTask): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('worker pool is destroyed'));
    if (this.failure) return Promise.reject(this.failure);
    const msg: BandMessage = { ...task, id: this.nextId++ };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      const w = this.idle.pop();
      if (w) w.postMessage(msg);
      else this.queue.push(msg);
    });
  }

  private onReply(w: Worker, reply: BandReply): void {
    const p = this.pending.get(reply.id);
    this.pending.delete(reply.id);
    const next = this.queue.shift();
    if (next) w.postMessage(next);
    else this.idle.push(w);
    if (!p) return;
    if (reply.ok) p.resolve();
    else p.reject(new Error(`terrain worker band failed: ${reply.error}`));
  }

  private onWorkerError(err: Error): void {
    // A worker-level error (not a band failure) poisons the pool: reject
    // everything in flight so the caller's finally can destroy it.
    this.failure = err instanceof Error ? err : new Error(String(err));
    for (const p of this.pending.values()) p.reject(this.failure);
    this.pending.clear();
    this.queue.length = 0;
  }

  /** Terminate every worker. Idempotent; awaits full thread exit. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const gone = new Error('worker pool destroyed while bands were in flight');
    for (const p of this.pending.values()) p.reject(gone);
    this.pending.clear();
    this.queue.length = 0;
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

/** Split `rows` into up to `parts` contiguous [start, end) bands. */
function rowBands(rows: number, parts: number): Array<[number, number]> {
  const bands: Array<[number, number]> = [];
  const step = Math.max(1, Math.ceil(rows / parts));
  for (let r0 = 0; r0 < rows; r0 += step) {
    bands.push([r0, Math.min(rows, r0 + step)]);
  }
  return bands;
}

/** Geometry + physics of one base-relief dispatch (everything but the rows). */
export interface BaseReliefJob {
  minX: number;
  minZ: number;
  res: number;
  widthSamples: number;
  heightSamples: number;
  tanSlope: number;
  slopeDirX: number;
  slopeDirZ: number;
  stack: WireStackLayer[];
  measured: boolean;
  measuredPlusSynthetic: number;
}

/**
 * Evaluate the base-relief stage of one layer on the pool.
 *
 * The layer's current heights (and mask, when measured) are copied into
 * SharedArrayBuffer scratch, the row bands are evaluated in parallel, and the
 * scratch is copied back. The dataset's own arrays deliberately stay backed
 * by ordinary ArrayBuffers — several downstream consumers (crypto, encoders)
 * reject SharedArrayBuffer-backed views. The two memcpys are microseconds
 * against the seconds of noise evaluation they unlock.
 */
export async function runBaseReliefParallel(
  pool: ReliefWorkerPool,
  job: BaseReliefJob,
  height: Float32Array,
  elevationSource: Uint8Array | null,
  onRowsDone?: (rows: number) => void,
): Promise<void> {
  const sharedHeight = new Float32Array(new SharedArrayBuffer(height.byteLength));
  sharedHeight.set(height);
  let sharedMask: Uint8Array | null = null;
  if (elevationSource) {
    sharedMask = new Uint8Array(new SharedArrayBuffer(elevationSource.byteLength));
    sharedMask.set(elevationSource);
  }
  const bands = rowBands(job.heightSamples, pool.size * 4);
  await Promise.all(
    bands.map(([rowStart, rowEnd]) =>
      pool
        .submit({
          kind: 'base_relief',
          rowStart,
          rowEnd,
          minX: job.minX,
          minZ: job.minZ,
          res: job.res,
          widthSamples: job.widthSamples,
          tanSlope: job.tanSlope,
          slopeDirX: job.slopeDirX,
          slopeDirZ: job.slopeDirZ,
          stack: job.stack,
          measured: job.measured,
          measuredPlusSynthetic: job.measuredPlusSynthetic,
          height: sharedHeight,
          elevationSource: sharedMask,
        })
        .then(() => onRowsDone?.(rowEnd - rowStart)),
    ),
  );
  height.set(sharedHeight);
  if (elevationSource && sharedMask) elevationSource.set(sharedMask);
}

/** Geometry + fractal of one regolith dispatch (everything but the rows). */
export interface RegolithJob {
  minX: number;
  minZ: number;
  res: number;
  widthSamples: number;
  heightSamples: number;
  fractal: FractalParameters;
  noiseSeed: string;
}

/** Evaluate the regolith stage of one layer on the pool (see above). */
export async function runRegolithParallel(
  pool: ReliefWorkerPool,
  job: RegolithJob,
  height: Float32Array,
  onRowsDone?: (rows: number) => void,
): Promise<void> {
  const sharedHeight = new Float32Array(new SharedArrayBuffer(height.byteLength));
  sharedHeight.set(height);
  const bands = rowBands(job.heightSamples, pool.size * 4);
  await Promise.all(
    bands.map(([rowStart, rowEnd]) =>
      pool
        .submit({
          kind: 'regolith',
          rowStart,
          rowEnd,
          minX: job.minX,
          minZ: job.minZ,
          res: job.res,
          widthSamples: job.widthSamples,
          fractal: job.fractal,
          noiseSeed: job.noiseSeed,
          height: sharedHeight,
        })
        .then(() => onRowsDone?.(rowEnd - rowStart)),
    ),
  );
  height.set(sharedHeight);
}
