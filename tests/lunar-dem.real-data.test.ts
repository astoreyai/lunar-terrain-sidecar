/**
 * DEM ingestion validated against the **real** LOLA products on this machine.
 *
 * No fixture is fabricated and no raster is mocked. Expected values are taken
 * from the products' own metadata (the PDS label, and GDAL's independent
 * reading of the GeoTIFF georeferencing), so these tests check this code
 * against an outside authority rather than against itself.
 *
 * Tests skip — loudly, never silently passing — when a product is absent.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  buildLocalFrame,
  forward,
  inverse,
  localToProjected,
  openGeoTiffRaster,
  openPdsRaster,
  pixelToSelenographic,
  projectedToLocal,
  resampleDemToLocal,
  scaleFactorAtLatitude,
  selenographicToPixel,
  LUNAR_RADIUS_M,
} from '@lts/lunar-dem';

const PGDA_DIR = '/mnt/projects/datasets/lola_5mpp';
const SITE01 = `${PGDA_DIR}/Site01_final_adj_5mpp_surf.tif`;
const SHOEMAKER = `${PGDA_DIR}/Shoemaker_final_adj_5mpp_surf.tif`;
const LDEM_75S = '/mnt/projects/stewie/data/gis/raw/ldem_75s_120m.lbl';

/** Degrees-minutes-seconds string from GDAL → decimal degrees. */
function dms(d: number, m: number, s: number, negative: boolean): number {
  const v = d + m / 60 + s / 3600;
  return negative ? -v : v;
}

describe('polar stereographic projection', () => {
  it('places the south pole at the projection origin', () => {
    const p = forward(-90, 0);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
    const inv = inverse(0, 0);
    expect(inv.latitudeDeg).toBe(-90);
  });

  it('puts 75°S at the radius the LDEM_75S product is sized for', () => {
    // The LDEM_75S_120M product is 7624 px at 120 m/px = 914 880 m across, so
    // its edge radius is 457 440 m. The projection must agree to under a pixel.
    const p = forward(-75, 0);
    const rho = Math.hypot(p.x, p.y);
    expect(rho).toBeGreaterThan(457_300);
    expect(rho).toBeLessThan(457_500);
  });

  it('round-trips selenographic coordinates', () => {
    for (const [lat, lon] of [
      [-90, 0],
      [-89.5, 137.4],
      [-87.2, -62.8],
      [-80, 179.9],
      [-75.001, -45],
    ]) {
      const p = forward(lat, lon);
      const back = inverse(p.x, p.y);
      expect(back.latitudeDeg).toBeCloseTo(lat, 9);
      if (lat > -90) {
        // Longitude is undefined exactly at the pole. This expression is the
        // signed angular difference folded into (−180, 180], so a perfect
        // round-trip gives 0.
        const dLon = Math.abs(((back.longitudeDeg - lon + 540) % 360) - 180);
        expect(dLon).toBeCloseTo(0, 6);
      }
    }
  });

  it('reports the conformal scale distortion', () => {
    // k = 2k0 / (1 + sin|phi|): unity at the pole, and
    // 2/(1 + sin 75°) = 1.0173324 at the edge of the LDEM_75S product.
    expect(scaleFactorAtLatitude(-90)).toBeCloseTo(1.0, 12);
    expect(scaleFactorAtLatitude(-75)).toBeCloseTo(1.0173324, 6);
  });
});

describe.skipIf(!existsSync(SITE01))('PGDA 5 m/px site DEM (real GeoTIFF)', () => {
  it('reads the georeferencing GDAL reports', async () => {
    const r = await openGeoTiffRaster(SITE01);
    expect(r.widthPixels).toBe(3200);
    expect(r.heightPixels).toBe(3200);
    expect(r.resolutionMeters).toBe(5);

    // GDAL: Origin = (-19000, -4000), Pixel Size = (5, -5).
    // Pixel (0,0) centre is therefore at (-18997.5, -4002.5).
    const p = r.pixelToProjected(0, 0);
    expect(p.x).toBeCloseTo(-18997.5, 6);
    expect(p.y).toBeCloseTo(-4002.5, 6);
  });

  it('agrees with GDAL on the centre pixel selenographic coordinates', async () => {
    const r = await openGeoTiffRaster(SITE01);
    // GDAL: Center (-11000, -12000) = 137d29'22.39"W, 89d27'47.39"S
    const expectedLat = dms(89, 27, 47.39, true);
    const expectedLon = dms(137, 29, 22.39, true);

    const centreCol = 3200 / 2 - 0.5;
    const centreRow = 3200 / 2 - 0.5;
    const s = pixelToSelenographic(r, centreCol, centreRow);

    // Agreement to 0.5 arcsecond (1.4e-4 deg); at this latitude one arcsecond
    // of latitude is ~8 m on the ground.
    expect(Math.abs(s.latitudeDeg - expectedLat)).toBeLessThan(1.5e-4);
    expect(Math.abs(s.longitudeDeg - expectedLon)).toBeLessThan(1.5e-4);
  });

  it('agrees with GDAL on the upper-left corner', async () => {
    const r = await openGeoTiffRaster(SITE01);
    // GDAL corner coordinates are for the pixel *corner*, i.e. (-19000, -4000).
    const s = inverse(-19000, -4000, r.projection);
    expect(Math.abs(s.latitudeDeg - dms(89, 21, 34.89, true))).toBeLessThan(1.5e-4);
    expect(Math.abs(s.longitudeDeg - dms(101, 53, 19.17, true))).toBeLessThan(1.5e-4);
  });

  it('round-trips selenographic coordinates through pixel indices', async () => {
    const r = await openGeoTiffRaster(SITE01);
    const s0 = pixelToSelenographic(r, 1234.5, 2345.5);
    const px = selenographicToPixel(r, s0.latitudeDeg, s0.longitudeDeg);
    expect(px.col).toBeCloseTo(1234.5, 6);
    expect(px.row).toBeCloseTo(2345.5, 6);
  });

  it('reads elevations inside the range the file declares', async () => {
    const r = await openGeoTiffRaster(SITE01);
    // GDAL: z#actual_range = {-523.1834, 1959.4962}
    const win = r.readWindow(0, 0, 3200, 3200);
    let min = Infinity;
    let max = -Infinity;
    let nan = 0;
    for (let i = 0; i < win.data.length; i++) {
      const v = win.data[i];
      if (Number.isNaN(v)) {
        nan++;
        continue;
      }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(nan).toBe(0);
    expect(min).toBeCloseTo(-523.1834, 2);
    expect(max).toBeCloseTo(1959.4962, 2);
  });
});

describe.skipIf(!existsSync(SITE01))('resampling into a local tangent frame', () => {
  it('builds an orthonormal local frame and round-trips through it', () => {
    const frame = buildLocalFrame(-89.463164, -137.489553);
    // east and south must be unit length and orthogonal.
    expect(Math.hypot(frame.eastX, frame.eastY)).toBeCloseTo(1, 12);
    expect(Math.hypot(frame.southX, frame.southY)).toBeCloseTo(1, 12);
    expect(frame.eastX * frame.southX + frame.eastY * frame.southY).toBeCloseTo(0, 12);

    for (const [lx, lz] of [
      [0, 0],
      [100, -250],
      [-1000, 750],
    ]) {
      const p = localToProjected(frame, lx, lz);
      const back = projectedToLocal(frame, p.x, p.y);
      expect(back.localX).toBeCloseTo(lx, 6);
      expect(back.localZ).toBeCloseTo(lz, 6);
    }
  });

  it('puts local north on −Z, matching ADR 0002', () => {
    // Moving toward −Z must increase selenographic latitude (toward 75°S),
    // i.e. move away from the pole.
    const frame = buildLocalFrame(-89.4, 0);
    const here = localToProjected(frame, 0, 0);
    const north = localToProjected(frame, 0, -1000);
    const latHere = inverse(here.x, here.y).latitudeDeg;
    const latNorth = inverse(north.x, north.y).latitudeDeg;
    expect(latNorth).toBeGreaterThan(latHere);
  });

  it('resamples a real 2 km patch and removes curvature', async () => {
    const r = await openGeoTiffRaster(SITE01);
    const centre = pixelToSelenographic(r, 1599.5, 1599.5);
    const frame = buildLocalFrame(centre.latitudeDeg, centre.longitudeDeg);

    const res = resampleDemToLocal(r, frame, {
      minX: -1000,
      minZ: -1000,
      resolutionMeters: 5,
      widthSamples: 401,
      heightSamples: 401,
    });

    expect(res.noDataFraction).toBe(0);
    expect(res.sourcePixelsPerSample).toBeCloseTo(1, 9);
    // Rebased to the window mean, so elevations straddle zero.
    let min = Infinity;
    let max = -Infinity;
    for (const v of res.data) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
    // Real polar terrain over 2 km has relief but is not a cliff everywhere.
    expect(max - min).toBeGreaterThan(1);
    expect(max - min).toBeLessThan(3000);
  });

  it('removes exactly the spherical curvature drop', async () => {
    // Resample the same patch twice at different body radii; the difference at
    // a given offset must be the d^2/2R term and nothing else.
    const r = await openGeoTiffRaster(SITE01);
    const centre = pixelToSelenographic(r, 1599.5, 1599.5);
    const frame = buildLocalFrame(centre.latitudeDeg, centre.longitudeDeg);
    const req = {
      minX: -1000,
      minZ: 0,
      resolutionMeters: 5,
      widthSamples: 401,
      heightSamples: 1,
    };
    const flat = resampleDemToLocal(r, frame, req, Infinity);
    const curved = resampleDemToLocal(r, frame, req, LUNAR_RADIUS_M);

    // Sample at local x = -1000 m (index 0): drop = 1000^2 / (2 * 1737400).
    const expectedDrop = (1000 * 1000) / (2 * LUNAR_RADIUS_M);
    expect(expectedDrop).toBeCloseTo(0.2878, 3);
    // Both share the same datum, so the difference is purely the curvature.
    //
    // Tolerance is set by Float32Array storage, not by the maths: elevations
    // here are of order 100 m, where a float32 ulp is 1.5e-5 m, so differencing
    // two stored values carries ~1e-5 of noise. 1e-4 still pins the 0.2878 m
    // drop to better than 0.04%.
    expect(flat.data[0] - curved.data[0]).toBeCloseTo(expectedDrop, 4);
    // At the frame origin (index 200, local x = 0) there is no drop.
    expect(flat.data[200] - curved.data[200]).toBeCloseTo(0, 4);
  });

  it('refuses a site outside the raster rather than inventing elevations', async () => {
    const r = await openGeoTiffRaster(SITE01);
    // A site on the opposite side of the pole is not in this tile.
    const frame = buildLocalFrame(-89.4, 42.0);
    expect(() =>
      resampleDemToLocal(r, frame, {
        minX: -100,
        minZ: -100,
        resolutionMeters: 5,
        widthSamples: 41,
        heightSamples: 41,
      }),
    ).toThrow(/does not fall within|no-data/);
  });
});

describe.skipIf(!existsSync(SHOEMAKER))('a second real product, for reader generality', () => {
  it('reads Shoemaker crater georeferencing', async () => {
    const r = await openGeoTiffRaster(SHOEMAKER);
    expect(r.widthPixels).toBe(4000);
    expect(r.resolutionMeters).toBe(5);
    // GDAL: Center (76000, 39000) = 62d50'6.05"E, 87d11'0.65"S
    const s = inverse(76000, 39000, r.projection);
    expect(Math.abs(s.latitudeDeg - dms(87, 11, 0.65, true))).toBeLessThan(1.5e-4);
    expect(Math.abs(s.longitudeDeg - dms(62, 50, 6.05, false))).toBeLessThan(1.5e-4);
  });
});

describe.skipIf(!existsSync(LDEM_75S))('LOLA PDS3 gridded product (real IMG)', () => {
  it('parses the detached label and reads the ME frame declaration', () => {
    const r = openPdsRaster(LDEM_75S);
    expect(r.widthPixels).toBe(7624);
    expect(r.heightPixels).toBe(7624);
    expect(r.resolutionMeters).toBe(120);
    // The product declares the frame this system's solar model assumes.
    expect(r.provenance.bodyFrame).toMatch(/MEAN EARTH\/POLAR AXIS/i);
  });

  it('places the projection origin at the image centre', () => {
    const r = openPdsRaster(LDEM_75S);
    // SAMPLE/LINE_PROJECTION_OFFSET = 3811.5 in a 7624-wide image.
    const p = r.pixelToProjected(3811.5, 3811.5);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
    const s = pixelToSelenographic(r, 3811.5, 3811.5);
    expect(s.latitudeDeg).toBeCloseTo(-90, 9);
  });

  it('covers exactly 75°S to 90°S', () => {
    const r = openPdsRaster(LDEM_75S);
    // Mid-edge of the image is the closest approach of the boundary to the pole.
    const edge = pixelToSelenographic(r, 0, 3811.5);
    expect(edge.latitudeDeg).toBeGreaterThan(-75.05);
    expect(edge.latitudeDeg).toBeLessThan(-74.95);
  });

  it('reads elevations inside the range the label declares', () => {
    const r = openPdsRaster(LDEM_75S);
    // DERIVED_MINIMUM = -15526, DERIVED_MAXIMUM = 14050 raw counts,
    // SCALING_FACTOR = 0.5 -> -7763 m to +7025 m about the 1737.4 km sphere.
    const win = r.readWindow(3600, 3600, 400, 400);
    let min = Infinity;
    let max = -Infinity;
    for (const v of win.data) {
      if (Number.isNaN(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThan(-7763);
    expect(max).toBeLessThan(7025);
    // The polar region is not flat; a 48 km window must show real relief.
    expect(max - min).toBeGreaterThan(100);
  });
});
