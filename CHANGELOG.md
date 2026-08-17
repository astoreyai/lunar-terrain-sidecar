# Changelog

All notable changes to lunar-terrain-sidecar are documented here.

## 0.2.0 - 2026-08-14

### Compatibility

- Protocol 2.0 is a breaking wire-contract change. Upgrade the sidecar, browser UI, and Godot addon together; both shipped clients reject a different protocol major.
- Snapshot v2 replaces the incomplete v1 format. Version 1 snapshots cannot restore the complete mutable terrain, feature, and audit state and are rejected explicitly.
- Terrain artifact, configuration, and dataset schemas remain 1.0.0. The byte-producing generator remains 0.1.0 because the fixed-platform 183-payload reproduction contract is unchanged.
- The reproducibility oracle and CI now pin **Node 26.7.0** (`.nvmrc`; `engines.node` stays `>=20.10` for running). The generator source is unchanged, but V8 14.6 rounds `Math.pow` differently in the last ulp, so `craters.json` and `rocks.json` of the shipped demonstration site changed bytes; `expected-checksums.sha256` was regenerated on 26.7.0 (2 of 183 lines). Node 20.20.2 now reproduces 181/183 against it (measured); the other 181 artifacts are engine-identical.

### Added

- Complete atomic snapshots of raster channels, features, operation history, retained deltas, session settings, and monotonic dataset revision.
- Revision-bound live synchronization for the Godot addon, including sparse height and semantic updates, bounded tile fallback, affected-chunk render/collision refresh, and rock reseating.
- Strict Godot import validation, focused mesh levels, spatially chunked terrain collision, bounded physical-rock collision, and frame-yielding scene construction.
- Real Godot save/reopen and official Linux binary/PCK acceptance using checksum-pinned Site01 data and collision raycasts.
- DEM source projection, exact projected local origin, and SHA-256 source-byte provenance for GeoTIFF and detached PDS inputs.
- Sidecar-backed point, solar, horizon, terramechanics, provenance, and simulated-construction controls in the Godot editor dock.
- `terrain.capabilities.datasets` reports the resolved, existing Site01 DEM path (`LTS_SITE01_DEM` or the documented fallback) so clients need no machine-specific default; `scripts/fetch-data.sh` prints the export line.

### Changed

- The browser and Godot clients now bind imported terrain to authoritative geometry, origin, coordinate, raster, and rock state before enabling edits.
- Godot imports are staged and built incrementally before replacing the prior scene; narrow and high-scale dock layouts reflow without horizontal clipping.
- CI uses immutable action references, checksum-pinned public inputs, the official Godot editor/export template, pnpm 10 (the lockfile writer) on Node 26.7.0, and machine-readable guards that reject missing, skipped, or disabled release tests.
- Dependency updates include Vitest 3.2.7 and a Nano ID 3.3.18 override.

### Fixed

- Snapshot restore now validates identity, channel presence, delta chains, feature and operation domains, rock physical invariants, file confinement, and bounded sizes before one atomic state swap.
- Snapshot restore accepts the generator's per-layer crater numbering (ids repeat across crater-bearing layers by contract) and the floating-point mean of a flat construction footprint; both previously rejected the server's own snapshots of the shipped demonstration site and of a pad-then-cut sequence. Round trips of a two-layer crater site and of pad → polygonal cut are now tested on the real Site01 DEM.
- The Godot addon winds terrain render triangles clockwise (Godot's front face); the previous order was back-face culled from above under the default material while every collision probe passed. Rendered rock instances now scale along their local axes (`scaled_local`), matching their collision ellipsoids and the browser viewer. Both are asserted in the round-trip suite.
- The browser UI adopts the Site01 DEM path the sidecar resolves from `LTS_SITE01_DEM` (`terrain.capabilities.datasets`) instead of a machine-specific default, and clears undo/redo history when a different world (regenerate, restore, other sidecar dataset) is installed; undo previously re-applied an inverse from the old world to the new terrain.
- CI result guards require exactly the listed test files to have run, so a deleted or renamed suite fails like a skipped one.
- The browser viewer keeps the operator's camera across an edit's dataset reload; it re-frames only when the layer geometry changes (first load, generate, another sidecar dataset).
- The browser viewer picks the terrain under the pointer analytically against the finest covering layer instead of ray-casting ~1.5 M preview triangles on every pointer event; hover no longer stalls the page on slow machines, and the picked point is on the authoritative surface rather than on whichever overlapping preview mesh was nearest (previously up to metres off).
- Release-acceptance tests no longer read the machine-local `examples/.../generated` export (gitignored) and tolerate slow two-core CI runners for the browser re-stream paths.
- Live operation input rejects malformed booleans and incomplete flatten, trench, berm, and rectangular-pad records before mutation.
- Terrain edits stage and validate Float32-rounded heights, masks, volumes, and elevation statistics before committing, rejecting finite JavaScript values that would overflow the stored surface.
- Rock transfers preserve collision-bearing instances first, report truncation, bind canonical binary physics bytes to each revision/delta, and avoid a full rebuild when an edit reseats no rocks.
- Rock reseating includes the bilinear interpolation halo, preventing floating or burial-inconsistent instances at edit boundaries.
- The browser clears stale direct-sun lighting when an authoritative solar request fails and rejects mixed-revision generation loads.
- The Godot transport handles large valid responses, explicit disconnects, send failures, stale analysis responses, and request deadlines.

### Security

- Snapshot publication uses fresh temporary directories, exclusive bounded writes, regular-file and real-path confinement, checksums, and atomic rename.
- JSON-RPC rejects malformed top-level values without terminating the connection.
- CI and downloaded runtime/data dependencies are pinned to immutable revisions and verified hashes.
- The documented deployment boundary remains a single trusted local OS account; loopback transport is not multi-user authentication.
