# Export formats

Scope: every artifact the exporter writes, byte-level format details, the lossy/lossless status of each, tiling and winding rules for GLB, the JSON manifests, and the checksums file. Sources of truth: `packages/terrain-export/src/writer.ts` (`exportTerrain` — assembly and manifests), `raster.ts` (rf32/EXR/PNG16/npy/u8 encoders), `glb.ts` (tiling and mesh encoding). Coordinates and datum semantics of the exported values are defined in [coordinate-system.md](coordinate-system.md); reproducibility of the bytes in [reproducibility.md](reproducibility.md).

## Directory layout

```
<outputDirectory>/
├── layers/<layerId>/
│   ├── height.rf32            always written
│   ├── height.exr             default on
│   ├── height.png             default on   (16-bit, lossy)
│   ├── height.npy             default OFF  (opt-in)
│   ├── semantic.r8            when the layer has a semantic mask
│   └── elevation_source.r8    when the layer has an elevation-source mask
├── tiles/<tileId>.glb         default on
├── craters.json
├── rocks.json
├── horizon.json               when a horizon profile was computed
├── manifest.json
└── checksums.sha256
```

Format toggles: `ExportOptions.formats {exr, png16, npy, glb}` (`writer.ts`); via CLI `npm run terrain -- generate --no-exr --no-png --no-glb --npy` (`apps/headless-server/src/cli.ts`); via RPC `terrain.export` params. rf32, the masks, the JSON manifests and the checksums are unconditional. Every artifact is recorded in the manifest with its byte size, SHA-256 and an `encoding` block describing its mapping — a heightmap that silently normalised or lost a sign would be worse than none (`raster.ts` header).

## height.rf32 — raw float32 (lossless, canonical)

`encodeRawFloat32`: little-endian IEEE-754 float32, row-major C order, no header. `widthSamples × heightSamples` values; row 0 is the northernmost row (see [coordinate-system.md](coordinate-system.md)). Units: metres relative to `origin.datumElevationM`; tangent-plane (curvature removed at ingestion). This is what the Godot importer reads in the hot path (`godot/addon/lunar_terrain/lunar_terrain_loader.gd`); dimensions come from the manifest, not the file. Manifest `kind`: `heightmap_raw_f32`, with `dtype: '<f4'`, `order: 'row-major-C'`, sample counts and units in its `encoding` block.

## height.exr — OpenEXR float32 (lossless)

`encodeExrFloat32`: OpenEXR v2, single channel named **`Y`**, pixel type FLOAT (32-bit), **NO_COMPRESSION**, line order INCREASING_Y, data/display window `(0,0)–(w−1,h−1)`, uncompressed scanline blocks (`y:int32`, `dataSize:int32`, then `width` float32 pixels), written directly to the file layout (magic `0x01312f76`, version 2, attribute list, uint64 scanline offset table). EXR keeps elevations as true signed metres with no range mapping — the recommended interchange for anything that will be *measured* rather than looked at. Manifest `kind`: `heightmap_exr_f32`, `encoding: {channel:'Y', compression:'none', units:'meter'}`.

## height.png — 16-bit greyscale PNG (lossy)

`encodePng16Height`: PNG, bit depth 16, colour type 0 (greyscale), filter 0 on every scanline, big-endian uint16 samples, zlib level 9. PNG cannot hold negative or unbounded values, so the layer's elevation range is mapped onto 0–65535 and the mapping is **returned and recorded**, never discarded:

```
elevation_m = minElevationM + sample * scaleMetersPerUnit
scaleMetersPerUnit = (maxElevationM − minElevationM) / 65535
```

`minElevationM`/`maxElevationM`/`scaleMetersPerUnit` and the decode formula are in the manifest `encoding` block (`kind: heightmap_png_u16`). Quantisation: a 10 m range quantises to 0.15 mm; a 5 km range to 7.6 cm — reported so the caller decides whether that is acceptable. Non-finite samples encode as 0. Use rf32 or EXR for measurements.

## height.npy — NumPy (lossless, opt-in)

`encodeNpyFloat32`: `.npy` format v1.0, header `{'descr': '<f4', 'fortran_order': False, 'shape': (heightSamples, widthSamples)}` padded so data starts on a 64-byte boundary, then little-endian float32 in C order. Shape is **(rows, cols)** — `np.load(...)[row, col]` indexes north-to-south, west-to-east. Exists so the terrain drops straight into the scientific Python stack.

## semantic.r8 and elevation_source.r8 — raw uint8 masks

`encodeRawUint8`: raw row-major uint8, no header, same dimensions as the heightfield.

- `semantic.r8` (`kind: semantic_raw_u8`): values index `SEMANTIC_CLASSES` (`shared-types/src/terrain.ts`) — `unknown, flat_regolith, rough_regolith, crater_floor, crater_wall, crater_rim, rock_field, berm, trench, compacted_surface, disturbed_regolith, unsafe_slope`. Index order is the on-disk encoding and is append-only. The class list is repeated in the manifest `encoding` block.
- `elevation_source.r8` (`kind: elevation_source_raw_u8`): per-sample record of **which elevations are measurement and which are synthesis**. Values index `ELEVATION_SOURCES = ['synthetic', 'measured', 'measured_plus_synthetic']` (append-only). Semantics, from the pipeline (`terrain-pipeline/src/generate.ts`): a DEM-grounded layer is filled `measured` at ingestion; any sample subsequently touched by procedural relief (regional slope / noise stack) is promoted to `measured_plus_synthetic`; fully procedural layers stay `synthetic` (index 0). This mask is the artifact-level enforcement of the no-invented-elevations rule: a consumer can tell, from the export alone, what the LOLA measurement said and what the generator added.

## tiles/*.glb — glTF 2.0 binary tiles

`tileLayer` + `buildTileGeometry` + `encodeGlb` (`glb.ts`):

- **Tiling.** Each layer is divided into tiles of at most `tileSizeSamples` per edge that **share their boundary samples**: the iteration step is `tileSizeSamples − 1`, so adjacent tiles overlap by exactly one row/column. Both tiles evaluate the identical elevation on the shared edge — no cracks, no seams to interpolate, no skirts. Tile id: `${layerId}_t<col0 %06d>_<row0 %06d>` (also the id used in delta `changedTiles` — see [protocol.md](protocol.md)).
- **Geometry.** Indexed triangle mesh, positions and per-vertex normals as float32 VEC3, indices uint32, mode TRIANGLES. Positions are in the local terrain frame — metres, right-handed, Y-up, north = −Z — so the Godot importer needs no scale factor and no axis swap. Normals are central differences sampled from the *layer* (not the tile) so tile edges agree with their neighbours instead of flattening at seams.
- **Winding.** Triangles wind counter-clockwise (glTF front-face) so the geometric normal points **+Y** for upward-facing ground: the two triangles of a quad are `(v00, v01, v11)` and `(v00, v11, v10)` with col toward +X and row toward +Z. Getting this backwards renders tiles inside-out and points collision normals into the ground; it is asserted in `tests/godot-roundtrip.test.ts` (`normal_y > 0`) rather than assumed.
- **Container.** Self-contained GLB: JSON chunk (asset generator `lunar-terrain-sidecar`) + single BIN chunk holding positions/normals/indices at 4-byte-aligned offsets; position accessor carries min/max bounds. No materials, no textures.
- Manifest `kind`: `tile_glb`, with layer id, tile origin, sample counts, vertex/triangle counts and bounds in `encoding`.

## Feature and site manifests

All JSON manifests are pretty-printed (2-space) UTF-8, carry `schemaVersion` and use metre units.

- **craters.json** (`kind: crater_manifest`): `count` and one record per crater — `id`, `origin` (`production_csfd` or `authored`), `layers` (ids stamped into), and the full `CraterParameters` spread inline (`centerXMeters`, `centerZMeters`, `diameterMeters`, `depthMeters`, `rimHeightMeters`, `rimWidthMeters`, `floorRadiusRatio`, `ellipticity`, `rotationRadians`, `degradation`, `ejectaExtentMeters`, `ejectaAmplitudeMeters`, `centralPeak`). See [terrain-model.md](terrain-model.md) for the models behind these numbers.
- **rocks.json** (`kind: rock_manifest`): `count`, `physicalCount`, and per rock `position_m [x,y,z]`, `rotation_quaternion`, `scale_m` (ellipsoid semi-axes), `physical` (has collision geometry), `buried_fraction`, `angularity`, `material`, `semantic_class`. The embedded note states the contract: rocks are **instances, not heightfield features**; visual-only rocks carry no collision.
- **horizon.json** (`kind: horizon_profile`): `bins`, `azimuthStepDeg`, `horizonElevationDeg[]` — skyline elevation angle per azimuth bin, clockwise from north (north = −Z), ray-marched over the widest layer from its centre. The description records that curvature is NOT re-applied (tangent planes, see [coordinate-system.md](coordinate-system.md)).
- **manifest.json**: the root document — `terrainId`, `seed`, `coordinate_system` (the `CoordinateSystem` record verbatim), `origin` with `site_selenographic`, `datum_elevation_m` and the datum note, dataset `bounds`, `solar` conditions at the configured epoch, per-layer geometry (`resolution_m`, sample counts, bounds, `vertical_quantization_m`, `elevation_provenance`, `source_effective_resolution_m`, `sample_to_world` formula), feature counts, the full `provenance` block (generator identity, seed tree, data sources, literature models, synthetic-heuristic and limitation statements, `configurationHash` — see [reproducibility.md](reproducibility.md)), free-text `notes`, and the complete `artifacts` list with per-file `path`, `kind`, `bytes`, `sha256`, `encoding`.

## checksums.sha256

One line per artifact, `sha256sum -c` compatible format: `<hex sha256><2 spaces><relative path>`. Written so integrity can be verified without parsing the manifest. `manifest.json` and `checksums.sha256` themselves are not listed (they are written after the artifact list is closed); the artifact list is the byte-identity surface the `reproduce` command compares (see [reproducibility.md](reproducibility.md)).

## Consumer notes

- rf32/npy are little-endian. The Godot loader uses `to_float32_array()`, which is native-endian; on every platform Godot 4 ships on these coincide — noted in `lunar_terrain_loader.gd` for any future big-endian port (see [known-limitations.md](known-limitations.md)).
- The exporter refuses to run into an unwritable directory with `TERRAIN_OUTPUT_NOT_WRITABLE` (`ensureWritable` in `writer.ts`).
