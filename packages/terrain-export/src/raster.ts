/**
 * Raster export formats (spec §18).
 *
 * Encoders are written directly against the file-format specifications rather
 * than pulled from image libraries, because every one of these carries physical
 * units and a declared range: a heightmap that silently normalises to 0–1, or
 * loses the sign of a crater floor, is worse than no heightmap.
 */

import { deflateSync } from 'node:zlib';

/** Raw little-endian float32, row-major. The format Godot reads in the hot path. */
export function encodeRawFloat32(data: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(data.length * 4);
  for (let i = 0; i < data.length; i++) buf.writeFloatLE(data[i], i * 4);
  return buf;
}

/**
 * NumPy `.npy` v1.0, little-endian float32 (spec §18 "NumPy-compatible").
 *
 * Lets the terrain be analysed in the scientific Python stack without a
 * conversion step, which is how validation and figures usually get made.
 */
export function encodeNpyFloat32(
  data: Float32Array,
  shape: [number, number],
): Buffer {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape[0]}, ${shape[1]}), }`;
  // Header must be padded so that the data starts on a 64-byte boundary.
  const prefixLen = 10; // magic(6) + version(2) + headerLen(2)
  let padded = header;
  while ((prefixLen + padded.length + 1) % 64 !== 0) padded += ' ';
  padded += '\n';

  const out = Buffer.allocUnsafe(prefixLen + padded.length + data.length * 4);
  out.write('\x93NUMPY', 0, 'latin1');
  out.writeUInt8(1, 6);
  out.writeUInt8(0, 7);
  out.writeUInt16LE(padded.length, 8);
  out.write(padded, prefixLen, 'latin1');
  for (let i = 0; i < data.length; i++) {
    out.writeFloatLE(data[i], prefixLen + padded.length + i * 4);
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export interface PngHeightResult {
  buffer: Buffer;
  /** Elevation, metres, encoded by sample value 0. */
  minElevationM: number;
  /** Elevation, metres, encoded by sample value 65535. */
  maxElevationM: number;
  /** Metres per integer step. */
  scaleMetersPerUnit: number;
}

/**
 * 16-bit greyscale PNG heightmap (spec §18 "PNG heightmap for compatible
 * bounded ranges").
 *
 * PNG cannot hold negative or unbounded values, so the elevation range is
 * mapped onto 0–65535 and the mapping is **returned**, not discarded — the
 * manifest records it so a consumer can invert it exactly. A 16-bit encoding of
 * a 10 m range quantises to 0.15 mm; of a 5 km range, to 7.6 cm. The caller
 * decides whether that is acceptable, which is why the quantisation step is
 * reported rather than hidden.
 */
export function encodePng16Height(
  data: Float32Array,
  width: number,
  height: number,
): PngHeightResult {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) {
    min = 0;
    max = 0;
  }
  const range = max - min || 1;

  // Scanlines: one filter byte (0 = None) then big-endian uint16 samples.
  const stride = width * 2 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let r = 0; r < height; r++) {
    raw[r * stride] = 0;
    for (let c = 0; c < width; c++) {
      const v = data[r * width + c];
      const t = Number.isFinite(v) ? (v - min) / range : 0;
      const q = Math.max(0, Math.min(65535, Math.round(t * 65535)));
      raw.writeUInt16BE(q, r * stride + 1 + c * 2);
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(16, 8); // bit depth
  ihdr.writeUInt8(0, 9); // colour type: greyscale
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  return {
    buffer,
    minElevationM: min,
    maxElevationM: max,
    scaleMetersPerUnit: range / 65535,
  };
}

/**
 * OpenEXR, single-channel 32-bit float, uncompressed scanlines (spec §18).
 *
 * EXR is the format that keeps elevations as true signed metres with no range
 * mapping at all — which is why it is the recommended interchange for anything
 * that will be measured rather than looked at.
 *
 * Written to the OpenEXR file layout: magic, version, a null-terminated
 * attribute list, a scanline offset table, then per-scanline blocks.
 */
export function encodeExrFloat32(
  data: Float32Array,
  width: number,
  height: number,
  channelName = 'Y',
): Buffer {
  const parts: Buffer[] = [];
  const str = (s: string) => Buffer.from(s + '\0', 'latin1');

  const attribute = (name: string, type: string, value: Buffer): Buffer => {
    const size = Buffer.allocUnsafe(4);
    size.writeInt32LE(value.length, 0);
    return Buffer.concat([str(name), str(type), size, value]);
  };

  // channels: name, pixelType(2 = FLOAT), pLinear, reserved, xSampling, ySampling
  const chan = Buffer.concat([
    str(channelName),
    (() => {
      const b = Buffer.alloc(16);
      b.writeInt32LE(2, 0); // FLOAT
      b.writeUInt8(0, 4); // pLinear
      // bytes 5..7 reserved = 0
      b.writeInt32LE(1, 8); // xSampling
      b.writeInt32LE(1, 12); // ySampling
      return b;
    })(),
    Buffer.from([0]), // channel list terminator
  ]);

  const box2i = (xMin: number, yMin: number, xMax: number, yMax: number) => {
    const b = Buffer.allocUnsafe(16);
    b.writeInt32LE(xMin, 0);
    b.writeInt32LE(yMin, 4);
    b.writeInt32LE(xMax, 8);
    b.writeInt32LE(yMax, 12);
    return b;
  };

  const v2f = (x: number, y: number) => {
    const b = Buffer.allocUnsafe(8);
    b.writeFloatLE(x, 0);
    b.writeFloatLE(y, 4);
    return b;
  };

  // Magic + version (2, no flags).
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32LE(0x01312f76, 0);
  head.writeUInt32LE(2, 4);
  parts.push(head);

  parts.push(attribute('channels', 'chlist', chan));
  parts.push(
    attribute(
      'compression',
      'compression',
      Buffer.from([0]), // NO_COMPRESSION
    ),
  );
  parts.push(attribute('dataWindow', 'box2i', box2i(0, 0, width - 1, height - 1)));
  parts.push(attribute('displayWindow', 'box2i', box2i(0, 0, width - 1, height - 1)));
  parts.push(attribute('lineOrder', 'lineOrder', Buffer.from([0]))); // INCREASING_Y
  parts.push(
    attribute(
      'pixelAspectRatio',
      'float',
      (() => {
        const b = Buffer.allocUnsafe(4);
        b.writeFloatLE(1, 0);
        return b;
      })(),
    ),
  );
  parts.push(attribute('screenWindowCenter', 'v2f', v2f(0, 0)));
  parts.push(
    attribute(
      'screenWindowWidth',
      'float',
      (() => {
        const b = Buffer.allocUnsafe(4);
        b.writeFloatLE(1, 0);
        return b;
      })(),
    ),
  );
  parts.push(Buffer.from([0])); // end of header

  const headerBytes = Buffer.concat(parts);

  // Offset table: one uint64 per scanline.
  const offsetTableBytes = height * 8;
  const scanlineSize = 4 + 4 + width * 4; // y (int32) + dataSize (int32) + pixels
  const offsets = Buffer.allocUnsafe(offsetTableBytes);
  let cursor = headerBytes.length + offsetTableBytes;
  for (let y = 0; y < height; y++) {
    offsets.writeBigUInt64LE(BigInt(cursor), y * 8);
    cursor += scanlineSize;
  }

  const pixels = Buffer.allocUnsafe(height * scanlineSize);
  let p = 0;
  for (let y = 0; y < height; y++) {
    pixels.writeInt32LE(y, p);
    pixels.writeInt32LE(width * 4, p + 4);
    p += 8;
    for (let x = 0; x < width; x++) {
      pixels.writeFloatLE(data[y * width + x], p);
      p += 4;
    }
  }

  return Buffer.concat([headerBytes, offsets, pixels]);
}

/** Raw uint8 mask, row-major — semantic and classification grids. */
export function encodeRawUint8(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
