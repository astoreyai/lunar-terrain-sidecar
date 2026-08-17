/**
 * A uniform view over the real lunar DEM products this system ingests.
 *
 * Two concrete backings today, both south polar stereographic on the 1737.4 km
 * sphere in the ME frame:
 *
 *   - `LDEM_75S_120M` — PDS3 int16, 120 m/px, 75°S–90°S regional context
 *   - PGDA `*_final_adj_5mpp_surf.tif` — GeoTIFF float32, 5 m/px site DEMs
 *     (Shackleton/Haworth/Shoemaker/DM2 and the Artemis candidate sites)
 *
 * There is deliberately **no synthetic fallback**. If a configured DEM is
 * missing or does not cover the site, generation fails with a structured error
 * rather than quietly substituting invented elevations.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  readPdsLabel,
  readPdsWindow,
  pixelToProjected,
  projectedToPixel,
  type PdsLabel,
} from './pds.js';
import {
  inverse,
  forward,
  LUNAR_RADIUS_M,
  type PolarStereographicParams,
} from './projection.js';

export interface RasterSourceFile {
  role: 'label' | 'raster';
  path: string;
  /** SHA-256 of the exact opened bytes, when the reader owns a stable snapshot. */
  sha256?: string;
}

/** Metadata describing where a raster's numbers came from. */
export interface RasterProvenance {
  id: string;
  description: string;
  path: string;
  citation: string;
  resolutionMeters: number;
  effectiveResolutionMeters?: number;
  bodyFrame?: string;
  /** Physical files whose bytes and metadata jointly define this raster. */
  sourceFiles?: RasterSourceFile[];
}

/** A projected, georeferenced elevation raster. */
export interface DemRaster {
  readonly widthPixels: number;
  readonly heightPixels: number;
  /** Ground sample distance in projected metres. */
  readonly resolutionMeters: number;
  readonly projection: PolarStereographicParams;
  readonly provenance: RasterProvenance;
  /** Projected coordinates of a (possibly fractional) pixel centre. */
  pixelToProjected(col: number, row: number): { x: number; y: number };
  /** Fractional pixel indices for a projected coordinate. */
  projectedToPixel(x: number, y: number): { col: number; row: number };
  /**
   * Read a window of elevations, metres relative to the reference sphere.
   * NaN marks no-data. Windows are clamped to the raster.
   */
  readWindow(
    col0: number,
    row0: number,
    width: number,
    height: number,
  ): { col0: number; row0: number; width: number; height: number; data: Float32Array };
  /** Release an owned source handle; present only for stable windowed readers. */
  close?(): void;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileDescriptorSha256(fd: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

/** SHA-256 of a file, for staleness detection in provenance. */
export function fileSha256(path: string): string {
  const fd = openSync(path, 'r');
  try {
    return fileDescriptorSha256(fd);
  } finally {
    closeSync(fd);
  }
}

function stableFileState(fd: number): string {
  const stats = fstatSync(fd, { bigint: true });
  // Renaming an open file may update ctime without changing its bytes. The
  // stable descriptor already pins dev+inode; size+mtime detect content writes.
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs].join(':');
}

function assertStableFile(fd: number, expected: string, path: string): void {
  if (stableFileState(fd) !== expected) {
    throw new Error(`DEM source changed while it was being read: ${path}`);
  }
}

function makePdsRaster(
  labelPath: string,
  label: PdsLabel,
  provenanceOverride?: Partial<Omit<RasterProvenance, 'path' | 'sourceFiles'>>,
  sourceFiles: RasterSourceFile[] = [
    { role: 'label', path: labelPath },
    { role: 'raster', path: label.imagePath },
  ],
  openedImage?: { fd: number; state: string },
): DemRaster {
  if (!/^POLAR\s+STEREOGRAPHIC$/i.test(label.mapProjectionType)) {
    throw new Error(
      `PDS label ${labelPath} declares unsupported projection ${label.mapProjectionType}`,
    );
  }
  if (Math.abs(Math.abs(label.centerLatitudeDeg) - 90) > 1e-12) {
    throw new Error(
      `PDS label ${labelPath} projection origin must be a pole, got ` +
        `${label.centerLatitudeDeg}°`,
    );
  }
  if (label.radiusM !== LUNAR_RADIUS_M) {
    throw new Error(
      `PDS label ${labelPath} must declare the ${LUNAR_RADIUS_M} m lunar reference sphere, ` +
        `got ${label.radiusM} m`,
    );
  }
  if (!/MEAN EARTH\/POLAR AXIS/i.test(label.coordinateSystemName)) {
    throw new Error(
      `PDS label ${labelPath} must declare the MEAN EARTH/POLAR AXIS body frame, got ` +
        `${label.coordinateSystemName}`,
    );
  }
  const projection: PolarStereographicParams = {
    hemisphere: label.centerLatitudeDeg < 0 ? -1 : 1,
    centralMeridianDeg: label.centerLongitudeDeg,
    scaleFactor: 1,
    falseEastingM: 0,
    falseNorthingM: 0,
    radiusM: label.radiusM,
  };

  let closed = false;
  const raster: DemRaster = {
    widthPixels: label.lineSamples,
    heightPixels: label.lines,
    resolutionMeters: label.mapScale,
    projection,
    provenance: {
      id: basename(label.imagePath).replace(/\.(img|IMG)$/, ''),
      description: 'LOLA gridded elevation, polar stereographic',
      citation:
        'LRO LOLA Gridded Data Record, PDS DATA_SET_ID "LRO-L-LOLA-4-GDR-V1.0" ' +
        '(Smith et al., LRO_LOLA_TEAM, NASA GSFC). Radii relative to 1737.4 km.',
      resolutionMeters: label.mapScale,
      // LOLA gridded products resolve features at roughly 3x the grid spacing;
      // synthetic craters are injected strictly below this.
      effectiveResolutionMeters: label.mapScale * 3,
      bodyFrame: label.coordinateSystemName,
      ...provenanceOverride,
      // These fields describe bytes actually opened and cannot be overridden.
      path: label.imagePath,
      sourceFiles,
    },
    pixelToProjected: (col, row) => pixelToProjected(label, col, row),
    projectedToPixel: (x, y) => projectedToPixel(label, x, y),
    readWindow: (col0, row0, width, height) => {
      if (!openedImage) return readPdsWindow(label, col0, row0, width, height);
      if (closed) throw new Error(`DEM source handle is closed: ${label.imagePath}`);
      assertStableFile(openedImage.fd, openedImage.state, label.imagePath);
      try {
        return readPdsWindow(label, col0, row0, width, height, openedImage.fd);
      } finally {
        assertStableFile(openedImage.fd, openedImage.state, label.imagePath);
      }
    },
  };
  if (openedImage) {
    raster.close = () => {
      if (closed) return;
      closed = true;
      closeSync(openedImage.fd);
    };
  }
  return raster;
}

/** Open a LOLA PDS3 gridded product from its detached `.lbl`. */
export function openPdsRaster(
  labelPath: string,
  provenanceOverride?: Partial<Omit<RasterProvenance, 'path' | 'sourceFiles'>>,
): DemRaster {
  return makePdsRaster(labelPath, readPdsLabel(labelPath), provenanceOverride);
}

/** Open and bind a detached PDS product to the exact label/image bytes used. */
function openStablePdsRaster(labelPath: string): DemRaster {
  const labelBytes = readFileSync(labelPath);
  const label = readPdsLabel(labelPath, labelBytes);
  const imageFd = openSync(label.imagePath, 'r');
  try {
    const beforeHash = stableFileState(imageFd);
    const imageSha256 = fileDescriptorSha256(imageFd);
    assertStableFile(imageFd, beforeHash, label.imagePath);
    return makePdsRaster(
      labelPath,
      label,
      undefined,
      [
        { role: 'label', path: labelPath, sha256: hashBytes(labelBytes) },
        { role: 'raster', path: label.imagePath, sha256: imageSha256 },
      ],
      { fd: imageFd, state: beforeHash },
    );
  } catch (error) {
    closeSync(imageFd);
    throw error;
  }
}

/** Geotransform of a north-up GeoTIFF: origin at the upper-left pixel corner. */
export interface GeoTiffGrid {
  originX: number;
  originY: number;
  pixelSizeX: number;
  /** Negative for a north-up image. */
  pixelSizeY: number;
  width: number;
  height: number;
}

function requiredGeoKey(
  keys: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = keys[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`GeoTIFF ${path} is missing finite ${key} projection metadata`);
  }
  return value;
}

/** Read the declared CRS rather than assigning the expected PGDA CRS by filename. */
function projectionFromGeoKeys(
  path: string,
  keys: Record<string, unknown>,
): PolarStereographicParams {
  const modelType = requiredGeoKey(keys, 'GTModelTypeGeoKey', path);
  const rasterType = requiredGeoKey(keys, 'GTRasterTypeGeoKey', path);
  const transform = requiredGeoKey(keys, 'ProjCoordTransGeoKey', path);
  const linearUnits = requiredGeoKey(keys, 'ProjLinearUnitsGeoKey', path);
  const angularUnits = requiredGeoKey(keys, 'GeogAngularUnitsGeoKey', path);
  if (modelType !== 1 || rasterType !== 1 || transform !== 15) {
    throw new Error(
      `GeoTIFF ${path} must declare a projected PixelIsArea polar-stereographic CRS ` +
        `(model=${modelType}, raster=${rasterType}, transform=${transform})`,
    );
  }
  if (linearUnits !== 9001 || angularUnits !== 9102) {
    throw new Error(
      `GeoTIFF ${path} must use metre/degree CRS units ` +
        `(linear=${linearUnits}, angular=${angularUnits})`,
    );
  }

  const latitudeOfOriginDeg = requiredGeoKey(keys, 'ProjNatOriginLatGeoKey', path);
  if (Math.abs(Math.abs(latitudeOfOriginDeg) - 90) > 1e-12) {
    throw new Error(
      `GeoTIFF ${path} latitude of natural origin must be a pole, got ${latitudeOfOriginDeg}`,
    );
  }
  const radiusM = requiredGeoKey(keys, 'GeogSemiMajorAxisGeoKey', path);
  const semiMinorM = requiredGeoKey(keys, 'GeogSemiMinorAxisGeoKey', path);
  if (radiusM !== semiMinorM || radiusM !== LUNAR_RADIUS_M) {
    throw new Error(
      `GeoTIFF ${path} must declare the ${LUNAR_RADIUS_M} m lunar reference sphere, ` +
        `got axes ${radiusM} × ${semiMinorM} m`,
    );
  }
  const primeMeridianDeg = requiredGeoKey(keys, 'GeogPrimeMeridianLongGeoKey', path);
  if (primeMeridianDeg !== 0) {
    throw new Error(`GeoTIFF ${path} uses unsupported prime meridian ${primeMeridianDeg}°`);
  }

  const scaleFactor = requiredGeoKey(keys, 'ProjScaleAtNatOriginGeoKey', path);
  if (!(scaleFactor > 0)) {
    throw new Error(`GeoTIFF ${path} projection scale factor must be positive`);
  }
  return {
    hemisphere: latitudeOfOriginDeg < 0 ? -1 : 1,
    centralMeridianDeg: requiredGeoKey(keys, 'ProjStraightVertPoleLongGeoKey', path),
    scaleFactor,
    falseEastingM: requiredGeoKey(keys, 'ProjFalseEastingGeoKey', path),
    falseNorthingM: requiredGeoKey(keys, 'ProjFalseNorthingGeoKey', path),
    radiusM,
  };
}

/**
 * Open a PGDA polar-stereographic site DEM (GeoTIFF).
 *
 * The `geotiff` package is loaded lazily so that a configuration which only
 * uses the PDS context product never pays for it.
 */
export async function openGeoTiffRaster(
  path: string,
  provenanceOverride?: Partial<Omit<RasterProvenance, 'path' | 'sourceFiles'>>,
): Promise<DemRaster> {
  if (!existsSync(path)) {
    throw new Error(`GeoTIFF not found: ${path}`);
  }
  const sourceBytes = readFileSync(path);
  const sourceSha256 = hashBytes(sourceBytes);
  const sourceArrayBuffer = sourceBytes.buffer.slice(
    sourceBytes.byteOffset,
    sourceBytes.byteOffset + sourceBytes.byteLength,
  ) as ArrayBuffer;
  const { fromArrayBuffer } = (await import('geotiff')) as typeof import('geotiff');
  const tiff = await fromArrayBuffer(sourceArrayBuffer);
  const image = await tiff.getImage();
  const projection = projectionFromGeoKeys(
    path,
    image.getGeoKeys() as Record<string, unknown>,
  );

  const width = image.getWidth();
  const height = image.getHeight();
  const [originX, originY] = image.getOrigin() as [number, number, number];
  const [pixelSizeX, pixelSizeYRaw] = image.getResolution() as [number, number, number];
  // getResolution reports a negative Y step for north-up images.
  const pixelSizeY = pixelSizeYRaw;
  if (!(pixelSizeX > 0) || !(pixelSizeY < 0) || Math.abs(pixelSizeX) !== Math.abs(pixelSizeY)) {
    throw new Error(
      `GeoTIFF ${path} must be a north-up square-metre grid, got pixel size ` +
        `${pixelSizeX} × ${pixelSizeY}`,
    );
  }

  const grid: GeoTiffGrid = { originX, originY, pixelSizeX, pixelSizeY, width, height };

  // Cache decoded rasters per window request; site DEMs are 4000x4000 float32
  // (64 MB), small enough to hold one full decode when repeatedly sampled.
  let full: Float32Array | null = null;
  const loadFull = async (): Promise<Float32Array> => {
    if (full) return full;
    const rasters = await image.readRasters({ interleave: false });
    const band = (rasters as unknown as ArrayLike<ArrayLike<number>>)[0];
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = Number(band[i]);
    full = out;
    return out;
  };

  // The reader interface is synchronous, so the first window forces a full
  // decode; subsequent reads are memory hits.
  const decoded = await loadFull();

  return {
    widthPixels: width,
    heightPixels: height,
    resolutionMeters: Math.abs(pixelSizeX),
    projection,
    provenance: {
      id: basename(path).replace(/\.tif$/i, ''),
      description: 'PGDA LOLA-derived polar site DEM, polar stereographic',
      citation:
        'NASA GSFC Planetary Geodesy (PGDA) LOLA-adjusted south-polar site DEM, ' +
        '5 m/pixel, sphere radius 1737.4 km, south polar stereographic.',
      resolutionMeters: Math.abs(pixelSizeX),
      // PGDA 5 m/px products resolve features at roughly 15-20 m.
      effectiveResolutionMeters: Math.abs(pixelSizeX) * 3.5,
      ...provenanceOverride,
      // These fields describe bytes actually opened and cannot be overridden.
      path,
      sourceFiles: [{ role: 'raster', path, sha256: sourceSha256 }],
    },
    pixelToProjected: (col, row) => ({
      // Pixel centres: origin is the upper-left *corner*.
      x: grid.originX + (col + 0.5) * grid.pixelSizeX,
      y: grid.originY + (row + 0.5) * grid.pixelSizeY,
    }),
    projectedToPixel: (x, y) => ({
      col: (x - grid.originX) / grid.pixelSizeX - 0.5,
      row: (y - grid.originY) / grid.pixelSizeY - 0.5,
    }),
    readWindow: (col0, row0, w, h) => {
      const c0 = Math.max(0, Math.min(width - 1, Math.floor(col0)));
      const r0 = Math.max(0, Math.min(height - 1, Math.floor(row0)));
      const c1 = Math.max(0, Math.min(width, Math.floor(col0) + w));
      const r1 = Math.max(0, Math.min(height, Math.floor(row0) + h));
      const ww = c1 - c0;
      const hh = r1 - r0;
      if (ww <= 0 || hh <= 0) {
        throw new Error(
          `requested GeoTIFF window (${col0}, ${row0}, ${w}x${h}) lies outside the ${width}x${height} image`,
        );
      }
      const out = new Float32Array(ww * hh);
      for (let r = 0; r < hh; r++) {
        for (let c = 0; c < ww; c++) {
          out[r * ww + c] = decoded[(r0 + r) * width + (c0 + c)];
        }
      }
      return { col0: c0, row0: r0, width: ww, height: hh, data: out };
    },
  };
}

/** Open either product type by file extension. */
export async function openDemRaster(path: string): Promise<DemRaster> {
  if (!existsSync(path)) {
    throw new Error(`DEM not found: ${path}`);
  }
  if (/\.lbl$/i.test(path)) return openStablePdsRaster(path);
  if (/\.(tif|tiff)$/i.test(path)) return openGeoTiffRaster(path);
  if (/\.img$/i.test(path)) {
    // Look for the detached label beside the image.
    for (const ext of ['.lbl', '.LBL']) {
      const cand = path.replace(/\.img$/i, ext);
      if (existsSync(cand)) return openStablePdsRaster(cand);
    }
    throw new Error(`no detached PDS label found beside ${path}`);
  }
  throw new Error(`unrecognised DEM format: ${path}`);
}

/** Selenographic coordinates of a raster pixel. */
export function pixelToSelenographic(
  raster: DemRaster,
  col: number,
  row: number,
): { latitudeDeg: number; longitudeDeg: number } {
  const { x, y } = raster.pixelToProjected(col, row);
  return inverse(x, y, raster.projection);
}

/** Raster pixel indices for selenographic coordinates. */
export function selenographicToPixel(
  raster: DemRaster,
  latitudeDeg: number,
  longitudeDeg: number,
): { col: number; row: number } {
  const { x, y } = forward(latitudeDeg, longitudeDeg, raster.projection);
  return raster.projectedToPixel(x, y);
}

/** Whether a file exists and is readable, for pre-flight config validation. */
export function demAvailable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}
