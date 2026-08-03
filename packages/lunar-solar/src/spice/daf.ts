/**
 * NAIF DAF (Double-precision Array File) container reader.
 *
 * DAF is the container format shared by binary SPK ephemerides (`.bsp`) and
 * binary PCK orientation kernels (`.bpc`). The format, per NAIF's
 * `daf.req`:
 *
 *   - The file is a sequence of fixed 1024-byte **records** (128 doubles).
 *   - Record 1 is the **file record**: `LOCIDW` (8 chars, e.g. "DAF/SPK "),
 *     `ND`/`NI` (summary layout), `FWARD`/`BWARD` (first/last summary record),
 *     `FREE`, and `LOCFMT` (8 chars, "LTL-IEEE" or "BIG-IEEE").
 *   - Summary records form a doubly linked list starting at `FWARD`. Each
 *     holds three control doubles — NEXT, PREV, NSUM — followed by NSUM
 *     packed summaries of `ND` doubles + `NI` int32s (the ints packed two
 *     per 8-byte word). The record after each summary record carries the
 *     segment names, 8·(ND + ⌈NI/2⌉) chars each.
 *   - Segment data is addressed in 1-based double-precision **words**:
 *     word `a` lives at byte `(a − 1) · 8`.
 *
 * ## Read strategy: one full Buffer, not readSync windows
 *
 * `packages/lunar-dem/src/pds.ts` windows its reads because a LOLA tile
 * touches <0.05% of a 116 MB image exactly once. Ephemeris access is the
 * opposite shape: `de440s.bsp` is 33 MB, `moon_pa_de440_200625.bpc` is 13 MB,
 * and every solar query touches four segments whose Chebyshev records are
 * scattered through both files — an illumination sweep evaluates thousands of
 * epochs. One `readFileSync` per kernel, cached per path in `deSolar.ts`,
 * turns every subsequent lookup into pointer arithmetic on memory the OS was
 * going to page-cache anyway, and keeps this module free of file-descriptor
 * lifetime management.
 */

import { readFileSync, existsSync } from 'node:fs';

/** Machine-readable failure codes for the kernel reader. */
export type SpiceErrorCode =
  | 'SPICE_KERNEL_UNREADABLE'
  | 'SPICE_UNSUPPORTED_FORMAT'
  | 'SPICE_SEGMENT_NOT_FOUND'
  | 'SPICE_UNSUPPORTED_TYPE'
  | 'SPICE_COVERAGE';

/**
 * Structured kernel-reader failure, mirroring the shape of `TerrainError`
 * without importing `@lts/shared-types` (this package is dependency-free).
 * The pipeline wraps this into a `TerrainError` at its boundary.
 */
export class SpiceKernelError extends Error {
  readonly code: SpiceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SpiceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SpiceKernelError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: string; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** One DAF segment summary: `nd` doubles, `ni` int32s, and the segment name. */
export interface DafSummary {
  doubles: number[];
  ints: number[];
  name: string;
}

const RECORD_BYTES = 1024;

/** A parsed DAF container with random access to its double-precision words. */
export class DafFile {
  readonly path: string;
  /** File architecture word, e.g. "DAF/SPK" or "DAF/PCK". */
  readonly locidw: string;
  readonly nd: number;
  readonly ni: number;
  private readonly view: DataView;
  private readonly summariesCache: DafSummary[];

  private constructor(path: string, bytes: Buffer) {
    this.path = path;
    // A pooled Buffer's backing ArrayBuffer may start at a non-zero offset;
    // the DataView carries that offset so word addresses stay byte-exact.
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    this.locidw = this.ascii(0, 8).trim();
    if (!this.locidw.startsWith('DAF/')) {
      throw new SpiceKernelError(
        'SPICE_UNSUPPORTED_FORMAT',
        `${path} is not a DAF file (LOCIDW ${JSON.stringify(this.locidw)})`,
        { path, locidw: this.locidw },
      );
    }

    const locfmt = this.ascii(88, 8).trim();
    if (locfmt !== 'LTL-IEEE') {
      // BIG-IEEE (and the pre-1993 VAX formats) would need byte-swapped reads
      // of every double and int; no big-endian kernel exists on this machine,
      // so that path would be untestable dead code. Refuse loudly instead.
      throw new SpiceKernelError(
        'SPICE_UNSUPPORTED_FORMAT',
        `${path} uses binary format ${JSON.stringify(locfmt)}; only LTL-IEEE is supported. ` +
          `Convert with NAIF's bingo or toxfr/tobin utilities.`,
        { path, locfmt },
      );
    }

    this.nd = this.view.getInt32(8, true);
    this.ni = this.view.getInt32(12, true);
    const fward = this.view.getInt32(76, true);
    this.summariesCache = this.readSummaries(fward);
  }

  /** Open and fully parse a DAF file. */
  static open(path: string): DafFile {
    if (!existsSync(path)) {
      throw new SpiceKernelError('SPICE_KERNEL_UNREADABLE', `kernel file not found: ${path}`, {
        path,
      });
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      throw new SpiceKernelError(
        'SPICE_KERNEL_UNREADABLE',
        `kernel file could not be read: ${path} (${e instanceof Error ? e.message : String(e)})`,
        { path },
      );
    }
    return new DafFile(path, bytes);
  }

  /** All segment summaries, in file order. */
  summaries(): DafSummary[] {
    return this.summariesCache;
  }

  /**
   * Read the inclusive word range `[initialAddr, finalAddr]` (1-based
   * double-precision word addresses) as a Float64Array.
   */
  readDoubles(initialAddr: number, finalAddr: number): Float64Array {
    const count = finalAddr - initialAddr + 1;
    const out = new Float64Array(count);
    const base = (initialAddr - 1) * 8;
    for (let i = 0; i < count; i++) {
      out[i] = this.view.getFloat64(base + i * 8, true);
    }
    return out;
  }

  /** Read a single word (1-based double-precision word address). */
  readDouble(addr: number): number {
    return this.view.getFloat64((addr - 1) * 8, true);
  }

  private ascii(byteOffset: number, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) {
      s += String.fromCharCode(this.view.getUint8(byteOffset + i));
    }
    return s;
  }

  private readSummaries(fward: number): DafSummary[] {
    // Size of one packed summary in words: ND doubles + NI ints at 2/word.
    const summaryWords = this.nd + Math.ceil(this.ni / 2);
    const nameChars = summaryWords * 8;
    const out: DafSummary[] = [];

    let record = fward;
    while (record > 0) {
      const base = (record - 1) * RECORD_BYTES;
      const next = this.view.getFloat64(base, true);
      const nsum = this.view.getFloat64(base + 16, true);
      const nameBase = record * RECORD_BYTES; // name record directly follows

      for (let s = 0; s < nsum; s++) {
        const sumBase = base + 24 + s * summaryWords * 8;
        const doubles: number[] = [];
        for (let d = 0; d < this.nd; d++) {
          doubles.push(this.view.getFloat64(sumBase + d * 8, true));
        }
        const ints: number[] = [];
        for (let i = 0; i < this.ni; i++) {
          ints.push(this.view.getInt32(sumBase + this.nd * 8 + i * 4, true));
        }
        out.push({
          doubles,
          ints,
          name: this.ascii(nameBase + s * nameChars, nameChars).trim(),
        });
      }
      record = next;
    }
    return out;
  }
}
