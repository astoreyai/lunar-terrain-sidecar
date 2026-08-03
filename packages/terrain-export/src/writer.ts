/**
 * Export assembly (spec §18).
 *
 * Writes a self-describing artifact directory: every raster carries its units
 * and encoding, every manifest carries the coordinate system and provenance,
 * and every file carries a SHA-256 so a consumer can detect a stale or partial
 * export (spec §21, §33).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, accessSync, constants } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  ERROR_CODES,
  TerrainError,
  isConstruction,
  isCrater,
  isRock,
  SEMANTIC_CLASSES,
  type SolarConditions,
  type TerrainDataset,
} from '@lts/shared-types';
import {
  encodeExrFloat32,
  encodeNpyFloat32,
  encodePng16Height,
  encodeRawFloat32,
  encodeRawUint8,
} from './raster.js';
import { buildTileGeometry, encodeGlb, tileLayer } from './glb.js';

export interface ArtifactRecord {
  path: string;
  kind: string;
  bytes: number;
  sha256: string;
  /** Format-specific description, including any encoding mapping applied. */
  encoding?: Record<string, unknown>;
}

export interface ExportOptions {
  outputDirectory: string;
  /** Samples per tile edge for GLB tiling. */
  tileSizeSamples: number;
  /** Formats to emit besides the always-written raw float32 and manifests. */
  formats?: {
    exr?: boolean;
    png16?: boolean;
    npy?: boolean;
    glb?: boolean;
  };
  solar?: SolarConditions;
  horizon?: Float32Array;
  notes?: string[];
}

export interface ExportResult {
  manifestPath: string;
  artifacts: ArtifactRecord[];
  totalBytes: number;
}

function ensureWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (e) {
    throw new TerrainError(
      ERROR_CODES.OUTPUT_NOT_WRITABLE,
      `The output directory is not writable: ${dir}`,
      { directory: dir, cause: (e as Error).message },
    );
  }
}

/** Write a file, record its checksum, and return the record. */
function emit(
  root: string,
  relPath: string,
  data: Buffer,
  kind: string,
  encoding?: Record<string, unknown>,
): ArtifactRecord {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  return {
    path: relPath.split('\\').join('/'),
    kind,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    encoding,
  };
}

/** Export a dataset to disk (spec §18). */
export function exportTerrain(dataset: TerrainDataset, opts: ExportOptions): ExportResult {
  const root = opts.outputDirectory;
  ensureWritable(root);

  const formats = {
    exr: true,
    png16: true,
    npy: false,
    glb: true,
    ...(opts.formats ?? {}),
  };

  const artifacts: ArtifactRecord[] = [];

  for (const layer of dataset.layers) {
    const base = `layers/${layer.id}`;
    const shape: [number, number] = [layer.heightSamples, layer.widthSamples];

    // Raw float32 is always written: it is lossless, needs no decoder, and is
    // what the Godot importer reads in the hot path.
    artifacts.push(
      emit(root, `${base}/height.rf32`, encodeRawFloat32(layer.heightData), 'heightmap_raw_f32', {
        dtype: '<f4',
        order: 'row-major-C',
        widthSamples: layer.widthSamples,
        heightSamples: layer.heightSamples,
        units: 'meter',
        note:
          'Elevation relative to origin.datumElevationM. Tangent-plane: spherical curvature ' +
          'has been removed during ingestion.',
      }),
    );

    if (formats.exr) {
      artifacts.push(
        emit(
          root,
          `${base}/height.exr`,
          encodeExrFloat32(layer.heightData, layer.widthSamples, layer.heightSamples),
          'heightmap_exr_f32',
          { channel: 'Y', compression: 'none', units: 'meter' },
        ),
      );
    }

    if (formats.png16) {
      const png = encodePng16Height(layer.heightData, layer.widthSamples, layer.heightSamples);
      artifacts.push(
        emit(root, `${base}/height.png`, png.buffer, 'heightmap_png_u16', {
          bitDepth: 16,
          minElevationM: png.minElevationM,
          maxElevationM: png.maxElevationM,
          scaleMetersPerUnit: png.scaleMetersPerUnit,
          decode: 'elevation_m = minElevationM + sample * scaleMetersPerUnit',
          note:
            'Lossy: PNG cannot store signed or unbounded values, so the range is mapped to ' +
            '0-65535. Use height.exr or height.rf32 for measurements.',
        }),
      );
    }

    if (formats.npy) {
      artifacts.push(
        emit(root, `${base}/height.npy`, encodeNpyFloat32(layer.heightData, shape), 'heightmap_npy', {
          dtype: '<f4',
          shape,
        }),
      );
    }

    if (layer.masks.semantic) {
      artifacts.push(
        emit(root, `${base}/semantic.r8`, encodeRawUint8(layer.masks.semantic), 'semantic_raw_u8', {
          dtype: 'u1',
          classes: SEMANTIC_CLASSES,
          widthSamples: layer.widthSamples,
          heightSamples: layer.heightSamples,
        }),
      );
    }

    if (layer.masks.elevationSource) {
      artifacts.push(
        emit(
          root,
          `${base}/elevation_source.r8`,
          encodeRawUint8(layer.masks.elevationSource),
          'elevation_source_raw_u8',
          {
            dtype: 'u1',
            values: ['synthetic', 'measured', 'measured_plus_synthetic'],
            note: 'Per-sample record of which elevations are measurement and which are synthesis.',
          },
        ),
      );
    }

    if (formats.glb) {
      const tiles = tileLayer(layer, opts.tileSizeSamples);
      for (const tile of tiles) {
        const geom = buildTileGeometry(layer, tile);
        artifacts.push(
          emit(root, `tiles/${tile.id}.glb`, encodeGlb(geom, tile.id), 'tile_glb', {
            layerId: layer.id,
            col0: tile.col0,
            row0: tile.row0,
            widthSamples: tile.widthSamples,
            heightSamples: tile.heightSamples,
            vertices: geom.positions.length / 3,
            triangles: geom.indices.length / 3,
            boundsMin: geom.min,
            boundsMax: geom.max,
            note: 'Adjacent tiles share their boundary samples, so there are no cracks.',
          }),
        );
      }
    }
  }

  // ----------------------------------------------------------- manifests --
  const craters = dataset.featureManifest.filter(isCrater);
  const rocks = dataset.featureManifest.filter(isRock);
  const construction = dataset.featureManifest.filter(isConstruction);

  artifacts.push(
    emit(
      root,
      'craters.json',
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: dataset.provenance.generator.schemaVersion,
            terrainId: dataset.id,
            count: craters.length,
            units: 'meters',
            craters: craters.map((c) => ({
              id: c.id,
              origin: c.origin,
              layers: c.appliedToLayers,
              ...c.parameters,
            })),
          },
          null,
          2,
        ),
      ),
      'crater_manifest',
    ),
  );

  artifacts.push(
    emit(
      root,
      'rocks.json',
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: dataset.provenance.generator.schemaVersion,
            terrainId: dataset.id,
            count: rocks.length,
            physicalCount: rocks.filter((r) => r.physical).length,
            units: 'meters',
            note:
              'Rocks are instances, not heightfield features. Physical rocks carry collision ' +
              'geometry; visual-only rocks do not.',
            rocks: rocks.map((r) => ({
              id: r.id,
              position_m: [r.position.x, r.position.y, r.position.z],
              rotation_quaternion: r.rotationQuaternion,
              scale_m: [r.scale.x, r.scale.y, r.scale.z],
              physical: r.physical,
              buried_fraction: r.buriedFraction,
              angularity: r.angularity,
              material: r.material,
              semantic_class: r.semanticClass,
            })),
          },
          null,
          2,
        ),
      ),
      'rock_manifest',
    ),
  );

  artifacts.push(
    emit(
      root,
      'features_construction.json',
      Buffer.from(
        JSON.stringify(
          {
            schemaVersion: dataset.provenance.generator.schemaVersion,
            terrainId: dataset.id,
            count: construction.length,
            units: 'meters',
            note:
              'Engineering features (spec §11) applied as terrain edit operations. Volumes are ' +
              'measured from the heightfield delta, not assumed; net mass uses the recorded ' +
              'bulk density.',
            features: construction.map((f) => ({
              id: f.id,
              kind: f.kind,
              layers: f.appliedToLayers,
              affected_bounds: f.affectedBounds,
              parameters: f.parameters,
              mass_balance: f.massBalance,
              elevation_before: f.elevationBefore,
              elevation_after: f.elevationAfter,
              semantic_class: f.semanticClass,
            })),
          },
          null,
          2,
        ),
      ),
      'construction_manifest',
    ),
  );

  if (opts.horizon) {
    artifacts.push(
      emit(
        root,
        'horizon.json',
        Buffer.from(
          JSON.stringify(
            {
              schemaVersion: dataset.provenance.generator.schemaVersion,
              description:
                'Skyline elevation angle in degrees per azimuth bin, measured clockwise from ' +
                'north (north = -Z). Computed by ray-marching the widest layer from its centre. ' +
                'Curvature is NOT re-applied: layers are tangent planes with it already removed.',
              bins: opts.horizon.length,
              azimuthStepDeg: 360 / opts.horizon.length,
              horizonElevationDeg: Array.from(opts.horizon),
            },
            null,
            2,
          ),
        ),
        'horizon_profile',
      ),
    );
  }

  const manifest = {
    schemaVersion: dataset.provenance.generator.schemaVersion,
    terrainId: dataset.id,
    seed: dataset.seed,
    units: 'meters',
    coordinate_system: dataset.coordinateSystem,
    origin: {
      local: [dataset.origin.local.x, dataset.origin.local.y, dataset.origin.local.z],
      site_selenographic: {
        latitude_deg: dataset.origin.site.latitudeDeg,
        longitude_deg: dataset.origin.site.longitudeDeg,
      },
      datum_elevation_m: dataset.origin.datumElevationM,
      datum_note:
        'Stored elevations are relative to datum_elevation_m, which is itself relative to the ' +
        '1737400 m lunar reference sphere.',
    },
    bounds: {
      minimum: [dataset.bounds.minX, dataset.bounds.minY, dataset.bounds.minZ],
      maximum: [dataset.bounds.maxX, dataset.bounds.maxY, dataset.bounds.maxZ],
    },
    solar: opts.solar ?? null,
    layers: dataset.layers.map((l) => ({
      id: l.id,
      role: l.role,
      resolution_m: l.horizontalResolutionMeters,
      width_samples: l.widthSamples,
      height_samples: l.heightSamples,
      bounds: {
        minimum: [l.bounds.minX, l.bounds.minY, l.bounds.minZ],
        maximum: [l.bounds.maxX, l.bounds.maxY, l.bounds.maxZ],
      },
      vertical_quantization_m: l.verticalQuantizationMeters,
      elevation_provenance: l.elevationProvenance,
      source_effective_resolution_m: l.sourceEffectiveResolutionMeters ?? null,
      sample_to_world:
        'x = bounds.minimum[0] + col * resolution_m; z = bounds.minimum[2] + row * resolution_m',
    })),
    features: {
      craters: craters.length,
      rocks: rocks.length,
      physical_rocks: rocks.filter((r) => r.physical).length,
      construction: construction.length,
    },
    provenance: dataset.provenance,
    notes: opts.notes ?? [],
    artifacts: artifacts.map((a) => ({
      path: a.path,
      kind: a.kind,
      bytes: a.bytes,
      sha256: a.sha256,
      encoding: a.encoding ?? null,
    })),
  };

  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Checksums file, so integrity can be verified without parsing the manifest.
  const checksums = artifacts.map((a) => `${a.sha256}  ${a.path}`).join('\n') + '\n';
  writeFileSync(join(root, 'checksums.sha256'), checksums);

  return {
    manifestPath: relative(process.cwd(), manifestPath) || manifestPath,
    artifacts,
    totalBytes: artifacts.reduce((a, x) => a + x.bytes, 0),
  };
}
