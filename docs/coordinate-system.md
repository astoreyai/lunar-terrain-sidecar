# Coordinate system

Scope: the complete spatial convention of the terrain sidecar — axes and handedness, grid indexing, azimuth, the selenographic anchor and lunar body frame, the elevation datum chain, and the tangent-plane treatment of lunar curvature. Sources of truth: `packages/shared-types/src/coordinates.ts`, [ADR 0002](decisions/0002-coordinate-handedness.md), `packages/lunar-dem/src/sample.ts` (curvature and datum), `packages/lunar-solar/src/lunarFrame.ts` (body frame), `packages/lunar-solar/src/horizon.ts`. Every export embeds this convention as data (`CoordinateSystem` in the manifest — see [export-formats.md](export-formats.md)), so no consumer has to trust this document alone.

## The frame

**Right-handed, Y-up, metres throughout.**

| Axis | Direction |
|---|---|
| +X | east |
| +Y | up (elevation) |
| +Z | **south** |
| −Z | north |

The engineering spec asked for right-handed *and* Z=north, which cannot both hold. Right-handedness means `X × Y = Z`; with X=east and Y=up, `east × up = −north`, so Z is south. Derivation (ADR 0002): in the ENU triad `E × N = U`, therefore `E × U = E × (E × N) = E(E·N) − N(E·E) = −N`. The X=east, Y=up, Z=north combination is self-consistent only in a left-handed frame (Unity's convention, not Three.js's or Godot's).

Handedness won over the axis label because it is load-bearing: triangle winding, surface-normal signs and physics chirality all invert with the frame, and both target engines (Three.js, Godot) are right-handed Y-up. The entire cost of north = −Z is one sign in the azimuth conversion. North is carried as **data**, not a comment: `CoordinateSystem.north_axis: '-Z'` (`coordinates.ts`, `defaultCoordinateSystem()`) is embedded verbatim in every manifest.

Constants (`coordinates.ts`, `lunar-solar/src/constants.ts`): `LUNAR_REFERENCE_RADIUS_M = 1_737_400.0` (the LOLA GDR reference sphere, PDS `LRO-L-LOLA-4-GDR-V1.0` `OFFSET = 1737400.0`, and the radius declared by the PGDA polar site DEMs); `LUNAR_GRAVITY_M_S2 = 1.62`.

## Grid indexing

Heightfields are row-major: sample `(col, row)` lives at `row * widthSamples + col` (`TerrainLayer` docs, `shared-types/src/terrain.ts`).

- `col` increases with +X (east); `row` increases with +Z (south). **Row 0 is the northernmost row.**
- World position of a sample: `x = bounds.minX + col * horizontalResolutionMeters`, likewise `z` from `minZ` (`sampleToWorld`; also stated per-layer in every manifest as `sample_to_world`).
- This matches the top-down image convention and PDS line ordering (PDS `LINE` increases southward for the south-polar products), so the DEM reader needs no vertical flip (ADR 0002).

## Azimuth

Azimuth is measured **clockwise from north**, degrees. A unit ground direction at azimuth `A` is:

```
(x, z) = (sin A, −cos A)
```

The minus sign on `z` is the entire cost of north = −Z. This formula appears in `defaultCoordinateSystem().note`, in the horizon ray-marcher (`horizon.ts` `horizonProfile`: `dCol = sin A`, `dRow = −cos A`), in the regional-slope and trench/berm heading math (`terrain-pipeline/src/generate.ts`, `apps/headless-server/src/operations.ts`), and is produced by the solar model as `azimuthDeg = atan2(s·east, s·north)` normalised to [0, 360) (`lunar-solar/src/solarGeometry.ts`). Azimuth 0 = north, 90 = east, 180 = south, 270 = west (asserted in `tests/history.test.ts` and `tests/construction.test.ts`, per ADR 0002).

## Selenographic anchor and the ME frame

Terrain is authored in a **local Cartesian frame** anchored to the Moon by a single `TerrainOrigin` (`coordinates.ts`):

- `origin.site` is a `Selenographic` position — latitude positive north, longitude positive east, degrees — interpreted in the simulation's **Mean Earth / Polar Axis (ME)** body-fixed frame (`CoordinateSystem.body_frame: 'MOON_ME'`; realised by `lunar-solar/src/lunarFrame.ts` via the IAU/WGCCRE expressions of Archinal et al. 2011 with the E1…E13 libration terms). The LDEM_75S PDS label explicitly declares `MEAN EARTH/POLAR AXIS`; the PGDA Site01 GeoTIFF declares its polar-stereographic sphere and parameters but no machine-readable body-frame identifier, so its source provenance leaves `bodyFrame` unset rather than claiming ME was read from the file.
- Local `(x=0, z=0)` sits at that selenographic point. This anchoring is what lets the solar model compute a physically correct sun angle for the terrain and lets ingested DEM pixels land in the right place.
- Vertices are stored tile-relative so a site 1.7e6 m from the Moon's centre never puts kilometre-scale magnitudes into a float32 vertex buffer (spec §4, `coordinates.ts` header).
- When terrain was ingested from a projected DEM, `CoordinateSystem.source_projection` (`ProjectionMetadata`, type `polar_stereographic`) carries the projection parameters read from that source plus the projected coordinate of the local origin. GeoTIFF parameters come from its GeoKeys; PDS parameters come from its detached label. A dataset generated without a DEM omits `source_projection` rather than implying a source CRS that did not contribute terrain.
- The local tangent frame at the site is built by `buildLocalFrame` (`lunar-dem/src/sample.ts`) from those same source parameters: in the south-polar-stereographic aspect, local east is `(cos Δλ, −sin Δλ)` and local south (+Z) is `−(sin Δλ, cos Δλ)` in projected space, where `Δλ` is longitude relative to the declared central meridian, with a per-latitude projection scale factor.

The IAU realisation of the ME frame is approximate to ~0.01–0.03° versus a JPL DE-integrated libration; that is the system's solar accuracy floor — see [ADR 0001](decisions/0001-solar-model.md) and [known-limitations.md](known-limitations.md).

## Elevation datum chain

Three levels, so stored heights stay small for float precision:

```
stored height (Float32, near 0)
  + origin.datumElevationM          →  elevation above the reference sphere
  + LUNAR_REFERENCE_RADIUS_M        →  radial distance from the Moon's centre (1 737 400 m sphere)
```

- `TerrainLayer.heightData` holds metres **relative to `origin.datumElevationM`** (`terrain.ts`).
- `datumElevationM` is set during DEM ingestion to the **mean elevation of the sampled source window** (`resampleDemToLocal` in `sample.ts` returns it); with no DEM it is the configured `site.datumElevationM` (default 0, `SiteConfigSchema` in `config.ts`).
- Every manifest states this chain verbatim in `origin.datum_note`; `terrain.getHeight` returns `datumElevationM` alongside every elevation so the offset is never lost.

## Tangent-plane curvature removal

DEM elevations are **radial** — heights above the 1737.4 km sphere. A local terrain frame is a **tangent plane**, and Godot's physics is Euclidean. The difference is the curvature drop `d²/2R`: 0.29 m at 1 km, 28.8 m at 10 km — negligible at rover scale, decisive for a horizon (`sample.ts` header).

`resampleDemToLocal` removes the curvature during ingestion: after rebasing to the datum, each sample becomes `h − datum − d²/(2R)` where `d² = x² + z²` from the local origin and `R = 1_737_400` m. A stored layer is therefore a true tangent plane — a flat mesh in it really is flat.

**Consequence:** horizon ray-marching over an ingested layer must **not** re-apply curvature; it is already baked in. `horizonProfile` (`lunar-solar/src/horizon.ts`) therefore defaults `bodyRadiusM: Infinity` (no curvature term), so the double count cannot happen by omission. Pass `LUNAR_REFERENCE_RADIUS_M` only when ray-marching *raw radial* elevations still sitting on the sphere. The exporter's rf32 encoding note, the horizon.json description, and the `terrain.getHorizon` response `note` all restate this.

Drift note (verified against source): the `sample.ts` module comment refers to a `TerrainLayer.curvatureRemoved` field; no such field exists on `TerrainLayer` (`shared-types/src/terrain.ts`). The fact is instead carried by the exporter's per-raster encoding note ("Tangent-plane: spherical curvature has been removed during ingestion") and the manifest.

## Bounds

`TerrainBounds` (`coordinates.ts`) is an axis-aligned box in local metres. Horizontal extent is authoritative for layer placement; the vertical range is descriptive and recomputed from data (`recomputeVerticalBounds` in `terrain.ts` — the server re-runs it after every edit so exports never carry stale vertical bounds).
