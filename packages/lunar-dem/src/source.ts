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

import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  readPdsLabel,
  readPdsWindow,
  pixelToProjected,
  projectedToPixel,
  type PdsLabel,
} from './pds.js';
import { inverse, forward, SOUTH_POLAR_LOLA, type PolarStereographicParams } from './projection.js';

/** Metadata describing where a raster's numbers came from. */
export interface RasterProvenance {
  id: string;
  description: string;
  path: string;
  citation: string;
  resolutionMeters: number;
  effectiveResolutionMeters?: number;
  bodyFrame?: string;
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
}

/** SHA-256 of a file, for staleness detection in provenance. */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Open a LOLA PDS3 gridded product from its detached `.lbl`. */
export function openPdsRaster(labelPath: string, provenanceOverride?: Partial<RasterProvenance>): DemRaster {
  const label: PdsLabel = readPdsLabel(labelPath);
  const projection: PolarStereographicParams = {
    hemisphere: label.centerLatitudeDeg < 0 ? -1 : 1,
    centralMeridianDeg: label.centerLongitudeDeg,
    scaleFactor: 1,
    radiusM: label.radiusM,
  };

  return {
    widthPixels: label.lineSamples,
    heightPixels: label.lines,
    resolutionMeters: label.mapScale,
    projection,
    provenance: {
      id: basename(label.imagePath).replace(/\.(img|IMG)$/, ''),
      description: 'LOLA gridded elevation, polar stereographic',
      path: label.imagePath,
      citation:
        'LRO LOLA Gridded Data Record, PDS DATA_SET_ID "LRO-L-LOLA-4-GDR-V1.0" ' +
        '(Smith et al., LRO_LOLA_TEAM, NASA GSFC). Radii relative to 1737.4 km.',
      resolutionMeters: label.mapScale,
      // LOLA gridded products resolve features at roughly 3x the grid spacing;
      // synthetic craters are injected strictly below this.
      effectiveResolutionMeters: label.mapScale * 3,
      bodyFrame: label.coordinateSystemName,
      ...provenanceOverride,
    },
    pixelToProjected: (col, row) => pixelToProjected(label, col, row),
    projectedToPixel: (x, y) => projectedToPixel(label, x, y),
    readWindow: (col0, row0, width, height) => readPdsWindow(label, col0, row0, width, height),
  };
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

/**
 * Open a PGDA polar-stereographic site DEM (GeoTIFF).
 *
 * The `geotiff` package is loaded lazily so that a configuration which only
 * uses the PDS context product never pays for it.
 */
export async function openGeoTiffRaster(
  path: string,
  provenanceOverride?: Partial<RasterProvenance>,
): Promise<DemRaster> {
  if (!existsSync(path)) {
    throw new Error(`GeoTIFF not found: ${path}`);
  }
  const { fromFile } = (await import('geotiff')) as typeof import('geotiff');
  const tiff = await fromFile(path);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();
  const [originX, originY] = image.getOrigin() as [number, number, number];
  const [pixelSizeX, pixelSizeYRaw] = image.getResolution() as [number, number, number];
  // getResolution reports a negative Y step for north-up images.
  const pixelSizeY = pixelSizeYRaw;

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
    projection: SOUTH_POLAR_LOLA,
    provenance: {
      id: basename(path).replace(/\.tif$/i, ''),
      description: 'PGDA LOLA-derived polar site DEM, polar stereographic',
      path,
      citation:
        'NASA GSFC Planetary Geodesy (PGDA) LOLA-adjusted south-polar site DEM, ' +
        '5 m/pixel, sphere radius 1737.4 km, south polar stereographic.',
      resolutionMeters: Math.abs(pixelSizeX),
      // PGDA 5 m/px products resolve features at roughly 15-20 m.
      effectiveResolutionMeters: Math.abs(pixelSizeX) * 3.5,
      bodyFrame: 'MEAN EARTH/POLAR AXIS',
      ...provenanceOverride,
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
  if (/\.lbl$/i.test(path)) return openPdsRaster(path);
  if (/\.(tif|tiff)$/i.test(path)) return openGeoTiffRaster(path);
  if (/\.img$/i.test(path)) {
    // Look for the detached label beside the image.
    for (const ext of ['.lbl', '.LBL']) {
      const cand = path.replace(/\.img$/i, ext);
      if (existsSync(cand)) return openPdsRaster(cand);
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
