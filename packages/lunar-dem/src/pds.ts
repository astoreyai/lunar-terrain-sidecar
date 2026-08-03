/**
 * PDS3 detached-label raster reader.
 *
 * Written for the LOLA gridded data records, e.g. `LDEM_75S_120M`:
 *
 *     RECORD_TYPE   = FIXED_LENGTH,  RECORD_BYTES = 15248
 *     LINES = 7624, LINE_SAMPLES = 7624
 *     SAMPLE_TYPE = LSB_INTEGER, SAMPLE_BITS = 16
 *     SCALING_FACTOR = 0.5, OFFSET = 1737400.0
 *     MAP_SCALE = 120 <m/pix>,  LINE/SAMPLE_PROJECTION_OFFSET = 3811.5
 *
 * Reads are **windowed** — only the rows a crop needs are pulled off disk.
 * The full 7624² int16 image is 116 MB, and a 2 km context tile touches under
 * 0.05% of it.
 */

import { openSync, readSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

export interface PdsLabel {
  lines: number;
  lineSamples: number;
  sampleBits: number;
  sampleType: string;
  scalingFactor: number;
  offset: number;
  /** Metres per pixel. */
  mapScale: number;
  /** Pixel index (0-based) of projected x = 0. */
  sampleProjectionOffset: number;
  /** Pixel index (0-based) of projected y = 0. */
  lineProjectionOffset: number;
  centerLatitudeDeg: number;
  centerLongitudeDeg: number;
  radiusM: number;
  /** Value marking "no data", if declared. */
  missingConstant?: number;
  /** Path of the .img file the label points at. */
  imagePath: string;
  /** Body-fixed frame name, e.g. "MEAN EARTH/POLAR AXIS OF DE421". */
  coordinateSystemName?: string;
  /** Raw label text, retained for provenance. */
  raw: string;
}

function parseScalar(raw: string, key: string): string | undefined {
  // PDS keywords are `KEY = VALUE` with optional <units>; values may be quoted.
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const m = raw.match(re);
  if (!m) return undefined;
  let v = m[1].trim();
  v = v.replace(/<[^>]*>\s*$/, '').trim(); // strip trailing <units>
  v = v.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
  return v.trim();
}

function parseNumber(raw: string, key: string): number | undefined {
  const v = parseScalar(raw, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a detached PDS3 label (`.lbl`). */
export function readPdsLabel(labelPath: string): PdsLabel {
  if (!existsSync(labelPath)) {
    throw new Error(`PDS label not found: ${labelPath}`);
  }
  const raw = readFileSync(labelPath, 'latin1');

  const lines = parseNumber(raw, 'LINES');
  const lineSamples = parseNumber(raw, 'LINE_SAMPLES');
  const sampleBits = parseNumber(raw, 'SAMPLE_BITS');
  const sampleType = parseScalar(raw, 'SAMPLE_TYPE');
  const mapScale = parseNumber(raw, 'MAP_SCALE');

  if (
    lines === undefined ||
    lineSamples === undefined ||
    sampleBits === undefined ||
    sampleType === undefined ||
    mapScale === undefined
  ) {
    throw new Error(
      `PDS label ${labelPath} is missing required keywords (LINES, LINE_SAMPLES, SAMPLE_BITS, SAMPLE_TYPE, MAP_SCALE)`,
    );
  }

  // The `^IMAGE = "NAME.IMG"` pointer names the data file; fall back to the
  // label's own basename with the extension swapped.
  let imageName = parseScalar(raw, '\\^IMAGE');
  if (imageName) imageName = imageName.replace(/^\(|\)$/g, '').split(',')[0].trim().replace(/"/g, '');
  const dir = dirname(labelPath);
  let imagePath = imageName ? join(dir, imageName) : '';
  if (!imagePath || !existsSync(imagePath)) {
    // PDS filenames are conventionally upper case while the delivered file may
    // not be; try the label's own stem.
    const stem = basename(labelPath).replace(/\.lbl$/i, '');
    for (const cand of [join(dir, `${stem}.img`), join(dir, `${stem}.IMG`)]) {
      if (existsSync(cand)) {
        imagePath = cand;
        break;
      }
    }
  }
  if (!imagePath || !existsSync(imagePath)) {
    throw new Error(`PDS image file for label ${labelPath} was not found`);
  }

  const radiusKm = parseNumber(raw, 'A_AXIS_RADIUS');

  return {
    lines,
    lineSamples,
    sampleBits,
    sampleType,
    scalingFactor: parseNumber(raw, 'SCALING_FACTOR') ?? 1,
    offset: parseNumber(raw, 'OFFSET') ?? 0,
    mapScale,
    sampleProjectionOffset: parseNumber(raw, 'SAMPLE_PROJECTION_OFFSET') ?? (lineSamples - 1) / 2,
    lineProjectionOffset: parseNumber(raw, 'LINE_PROJECTION_OFFSET') ?? (lines - 1) / 2,
    centerLatitudeDeg: parseNumber(raw, 'CENTER_LATITUDE') ?? -90,
    centerLongitudeDeg: parseNumber(raw, 'CENTER_LONGITUDE') ?? 0,
    radiusM: radiusKm !== undefined ? radiusKm * 1000 : 1_737_400,
    missingConstant: parseNumber(raw, 'MISSING_CONSTANT'),
    coordinateSystemName: parseScalar(raw, 'COORDINATE_SYSTEM_NAME'),
    imagePath,
    raw,
  };
}

/**
 * Projected coordinates of a pixel centre, metres.
 *
 * PDS places projected (0,0) at the fractional pixel index given by the
 * PROJECTION_OFFSET keywords, with `line` increasing southward (image top is
 * +y). For LDEM_75S the offsets are 3811.5 in a 7624-wide image, which puts the
 * origin exactly at the image centre and gives a symmetric ±457 380 m grid of
 * pixel centres — matching the product's stated 75°S edge.
 */
export function pixelToProjected(
  label: PdsLabel,
  col: number,
  row: number,
): { x: number; y: number } {
  return {
    x: (col - label.sampleProjectionOffset) * label.mapScale,
    y: (label.lineProjectionOffset - row) * label.mapScale,
  };
}

/** Fractional pixel indices for a projected coordinate. */
export function projectedToPixel(
  label: PdsLabel,
  x: number,
  y: number,
): { col: number; row: number } {
  return {
    col: x / label.mapScale + label.sampleProjectionOffset,
    row: label.lineProjectionOffset - y / label.mapScale,
  };
}

/** A rectangular window of elevations read from a PDS image. */
export interface PdsWindow {
  /** First column (0-based, inclusive). */
  col0: number;
  /** First row (0-based, inclusive). */
  row0: number;
  width: number;
  height: number;
  /**
   * Elevations in metres relative to the label's OFFSET (the reference sphere
   * radius), i.e. `raw * SCALING_FACTOR`. NaN where the missing constant was
   * found.
   */
  data: Float32Array;
}

/**
 * Read a rectangular window of a PDS image.
 *
 * Only the requested rows are read, one `pread` per row. The window is clamped
 * to the image; a request entirely outside it throws rather than returning
 * silently empty data, because a caller that lands off the product has a
 * coordinate bug worth surfacing.
 */
export function readPdsWindow(
  label: PdsLabel,
  col0: number,
  row0: number,
  width: number,
  height: number,
): PdsWindow {
  if (label.sampleBits !== 16) {
    throw new Error(`unsupported SAMPLE_BITS=${label.sampleBits}; this reader handles 16-bit`);
  }
  const signed = /INTEGER/i.test(label.sampleType) && !/UNSIGNED/i.test(label.sampleType);
  const littleEndian = /^LSB/i.test(label.sampleType) || /PC_/i.test(label.sampleType);

  const c0 = Math.max(0, Math.min(label.lineSamples - 1, Math.floor(col0)));
  const r0 = Math.max(0, Math.min(label.lines - 1, Math.floor(row0)));
  const c1 = Math.max(0, Math.min(label.lineSamples, Math.floor(col0) + width));
  const r1 = Math.max(0, Math.min(label.lines, Math.floor(row0) + height));
  const w = c1 - c0;
  const h = r1 - r0;
  if (w <= 0 || h <= 0) {
    throw new Error(
      `requested PDS window (${col0}, ${row0}, ${width}x${height}) lies outside the ` +
        `${label.lineSamples}x${label.lines} image`,
    );
  }

  const bytesPerSample = label.sampleBits / 8;
  const rowBytes = label.lineSamples * bytesPerSample;
  const out = new Float32Array(w * h);
  const rowBuf = Buffer.allocUnsafe(w * bytesPerSample);

  const fd = openSync(label.imagePath, 'r');
  try {
    for (let r = 0; r < h; r++) {
      const fileOffset = (r0 + r) * rowBytes + c0 * bytesPerSample;
      const got = readSync(fd, rowBuf, 0, rowBuf.length, fileOffset);
      if (got !== rowBuf.length) {
        throw new Error(
          `short read from ${label.imagePath} at row ${r0 + r}: got ${got} of ${rowBuf.length} bytes`,
        );
      }
      for (let c = 0; c < w; c++) {
        const b = c * bytesPerSample;
        const rawVal = signed
          ? littleEndian
            ? rowBuf.readInt16LE(b)
            : rowBuf.readInt16BE(b)
          : littleEndian
            ? rowBuf.readUInt16LE(b)
            : rowBuf.readUInt16BE(b);
        out[r * w + c] =
          label.missingConstant !== undefined && rawVal === label.missingConstant
            ? NaN
            : rawVal * label.scalingFactor;
      }
    }
  } finally {
    closeSync(fd);
  }

  return { col0: c0, row0: r0, width: w, height: h, data: out };
}
