# Sidecar protocol

Scope: the JSON-RPC 2.0 WebSocket protocol between the terrain sidecar server and its clients (the browser UI and the Godot editor dock). This is the reference for transport, the connection handshake, every method the server implements, progress events, the structured error shape, the single-running-job policy, and the edit/delta records. Sources of truth: `packages/terrain-protocol/src/index.ts` (constants and wire types), `apps/headless-server/src/server.ts` (method implementations), `apps/headless-server/src/operations.ts` (delta construction), `packages/shared-types/src/config.ts` (error codes). See [ADR 0003](decisions/0003-ui-and-dock-are-protocol-clients.md) for why both front ends are thin clients of this protocol.

## Transport

- **JSON-RPC 2.0 over WebSocket**, one JSON text frame per request/response/notification.
- Default endpoint `ws://127.0.0.1:8768` (`DEFAULT_PORT` in `terrain-protocol`; port overridable with `lunar-terrain serve --port N`).
- **Loopback only, single trusted OS-user boundary.** `startServer` (`server.ts`) binds `host: '127.0.0.1'` explicitly. The server reads and writes filesystem paths supplied by its client (`terrain.loadConfig`, `terrain.saveConfig`, `terrain.export`, config `outputDirectory`), so exposing it on a routable address would hand out a remote file-read/write primitive. There is no bearer-token authentication, and native clients without an HTTP `Origin` are accepted; loopback does not isolate other users/processes on the same host. Run the sidecar only where the local OS account and its processes are trusted.
- `PROTOCOL_VERSION = '2.0.0'`, `GENERATOR_VERSION = '0.1.0'` (`terrain-protocol/src/index.ts`, `terrain-pipeline/src/generate.ts`). Protocol 2 makes installed-world revision part of live-sync identity and makes complete-history snapshot restore explicit; those changes are intentionally not presented as protocol-1-compatible.

## The hello event

On every new connection the server pushes, unsolicited:

```json
{ "event": "terrain.hello", "protocolVersion": "2.0.0", "generatorVersion": "0.1.0" }
```

The protocol contract (`terrain-protocol` module docstring) is that a protocol-version mismatch is a **hard error, not a warning** — a client built against a different message shape would silently mis-drive generation. Both shipped clients enforce this on the hello event: they compare the announced major version against their own `CLIENT_PROTOCOL_MAJOR` and disconnect with an error on disagreement (`SidecarClient.handleMessage` in `apps/interactive-ui/src/rpc.ts`; `_handle_packet` in the Godot addon's `sidecar_client.gd`, which also fails all in-flight requests before closing). Minor and patch drift within the same major is tolerated: additions to the protocol are required to be backward-compatible.

## Request, response, and error shapes

Requests are `JsonRpcRequest`: `{jsonrpc: "2.0", id, method, params?}`. Responses are `JsonRpcSuccess` (`result`) or `JsonRpcFailure` (`error: {code, message, data?}`).

JSON-RPC codes (`RPC_CODES`):

| Code | Name | When |
|---|---|---|
| -32700 | `PARSE_ERROR` | frame was not valid JSON |
| -32600 | `INVALID_REQUEST` | not `jsonrpc: "2.0"` / no string `method` |
| -32601 | `METHOD_NOT_FOUND` | method not in `METHODS` (the error `data` lists `supported`) |
| -32602 | `INVALID_PARAMS` | reserved (the server reports parameter problems as terrain errors) |
| -32603 | `INTERNAL_ERROR` | non-`TerrainError` exception |
| -32000 | `TERRAIN_ERROR` | any `TerrainError`; `error.data` carries the structured record below |

Every application failure is a `TerrainError` (`shared-types/src/config.ts`) serialised into `error.data`:

```json
{ "code": "TERRAIN_DEM_UNAVAILABLE", "message": "…", "details": { "path": "…" } }
```

`ERROR_CODES` — the complete set of application error codes:

| Constant | Wire value |
|---|---|
| `INVALID_CONFIG` | `TERRAIN_INVALID_CONFIG` |
| `MEMORY_LIMIT` | `TERRAIN_MEMORY_LIMIT_EXCEEDED` |
| `SAMPLE_LIMIT` | `TERRAIN_SAMPLE_LIMIT_EXCEEDED` |
| `TILE_LIMIT` | `TERRAIN_TILE_LIMIT_EXCEEDED` |
| `LAYER_BOUNDS` | `TERRAIN_LAYER_BOUNDS_INCONSISTENT` |
| `DEM_UNAVAILABLE` | `TERRAIN_DEM_UNAVAILABLE` |
| `DEM_COVERAGE` | `TERRAIN_DEM_COVERAGE_INSUFFICIENT` |
| `OUTPUT_NOT_WRITABLE` | `TERRAIN_OUTPUT_NOT_WRITABLE` |
| `PROTOCOL_VERSION` | `TERRAIN_PROTOCOL_VERSION_MISMATCH` |
| `JOB_NOT_FOUND` | `TERRAIN_JOB_NOT_FOUND` |
| `CANCELLED` | `TERRAIN_CANCELLED` |
| `VALIDATION_FAILED` | `TERRAIN_VALIDATION_FAILED` |

## Progress events

While a generation job runs, the server broadcasts `ProgressEvent` notifications **to every connected client** (not only the caller — see `terrain.generate` in `server.ts`):

```json
{ "event": "terrain.progress", "jobId": "terrain-job-00001", "stage": "generating_craters", "progress": 0.35, "detail": "…" }
```

`progress` is 0…1. Stage names and their approximate progress values come from the pipeline (`terrain-pipeline/src/generate.ts`): `validating`, `allocating`, `ingesting_dem`, `base_relief`, `generating_craters`, `regolith_microrelief`, `generating_rocks`, `classifying`, `solar_geometry`, `complete`. See [terrain-model.md](terrain-model.md).

## Single-running-job policy

The server holds **one session with one shared dataset** (`Session` in `server.ts`). At most one generation job runs at a time (`runningJobId`). While it runs, `terrain.generate`, `terrain.export` and `terrain.applyOperation` are refused via `requireNoRunningJob` with a structured `TERRAIN_INVALID_CONFIG` error naming the running job — never a queue, never a silent overwrite. Rationale (from the code comment): two concurrent generates would race to install their results, and an edit applied mid-generation would be acknowledged and then destroyed when the new dataset lands. Finished job records are pruned beyond `MAX_JOB_RECORDS = 64`. See also [known-limitations.md](known-limitations.md) (single-session, single-dataset model).

## Methods

`METHODS` (`terrain-protocol/src/index.ts`) is exhaustive; anything else returns `METHOD_NOT_FOUND`. Params/result shapes below are taken from the `switch` in `server.ts` `handle()`. Methods marked *dataset* throw `TERRAIN_JOB_NOT_FOUND` ("No terrain is loaded. Call terrain.generate first.") when no dataset is in the session.

| Method | Params | Result |
|---|---|---|
| `terrain.health` | — | `{status:'ok', protocolVersion, generatorVersion, uptimeSeconds, datasetLoaded}` |
| `terrain.capabilities` | — | protocol/generator versions, `methods`, `exportFormats` (`rf32, exr, png16, npy, glb, json`), `operations`, `craterModels`, `rockModels`, `noiseModels`, `demFormats` (`pds3_img, geotiff`), `datasets {site01DemPath, site01DemSource}` (the Site01 DEM resolved from `LTS_SITE01_DEM` or the documented fallback and confirmed to exist — `null`/`'none'` otherwise; the browser UI adopts it on connect so no client needs a machine-specific default), `solarModes`, `sync {sparseSampleCap, deltaWindow}`, `coordinateSystem`, `notImplemented` (`gpuGeneration`, `volumetricTerrain`) |
| `terrain.validateConfig` | `{config}` (or the config inline) | `{valid: true, terrainId, seed}`; invalid configs fail with `TERRAIN_INVALID_CONFIG` and per-field `details.issues` |
| `terrain.estimate` | `{config}` | `{estimate, feasible, error}` — feasibility from `assertFeasible` without allocating |
| `terrain.generate` | `{config}` | `{jobId, status:'queued', seed}` immediately; work continues asynchronously (progress events, then a `JobRecord` retrievable via `getStatus`). On success the dataset is installed in the session and exported to the config's `outputDirectory` |
| `terrain.cancel` | `{jobId}` | `{jobId, cancelling: true}`; cancellation is cooperative (checked between pipeline stages); the job ends `cancelled` with `TERRAIN_CANCELLED` |
| `terrain.getStatus` | `{jobId?}` | the `JobRecord` for one job, or `{jobs: [...]}` for all remembered jobs |
| `terrain.getManifest` | `{directory?}` or `{jobId?}` | the parsed `manifest.json` of an export |
| `terrain.getDataset` | — (*dataset*) | live session summary: `terrainId`, `seed`, `datasetRevision`, `sequenceNumber`, `baseline` (opaque immutable/world hashes plus every layer-channel and rock-physics checksum), per-layer height/semantic `layerChecksums`, `coordinateSystem`, `origin{local, site, datumElevationM}`, `bounds`, per-layer geometry + `elevationProvenance`, feature counts, `provenance` |
| `terrain.getRocks` | `{maxInstances?}` (*dataset*) | revision-bound deterministic rock transfer: `terrainId`, `seed`, `datasetRevision`, `sequenceNumber`, `baseline`, counts, `truncated`, model provenance, JSON rock records, and `transferEncoding`, `transferSha256`, `transferData`. The canonical `base64:lts-rock-transfer-v1` bytes bind ordered ids, Float64-LE transforms, and the physical flag; Godot verifies the digest and uses the decoded values as scene authority because independent JSON parsers can differ by one Float64 ULP. Up to 50,000 instances; collision-bearing rocks consume the budget first |
| `terrain.export` | `{outputDirectory?, formats?: {exr?, png16?, npy?, glb?}}` (*dataset*, no running job) | `{outputDirectory, artifacts, totalBytes, validation: {passed, errors}}` — runs `validateDataset` on the result |
| `terrain.loadConfig` | `{path}` | the parsed, validated config |
| `terrain.saveConfig` | `{path, config}` | `{path, bytes}` |
| `terrain.applyOperation` | `{operation}` (*dataset*, no running job) | `{delta, operation, rocksReseated}` — see below |
| `terrain.getOperationLog` | — | `{operations, deltas}` — the full ordered operation log plus per-delta **summaries** (`deltaId`, `sequenceNumber`, `kind`, `changedTileCount`, `rocksReseated`, `massBalance`, `timestamp`, `resultingChecksum`, `resultingMaskChecksum`); empty arrays before any generate |
| `terrain.replayLog` | `{operations: TerrainOperation[]}` (*dataset*, no running job) | applies each record in order through the **same internal path** as `applyOperation`, validation included; returns `{applied, deltas, finalChecksum, finalMaskChecksum}`. Deterministic replay (spec §12, §19): generate the same seed, replay the same log, get the same terrain. A malformed record mid-log fails with a structured error whose `details` carry `failedIndex`, `appliedOperations` and the causing error — operations before the failure are applied and stay applied (apply-up-to-failure, reported, never silent) |
| `terrain.getDelta` | `{sequenceNumber, datasetRevision}` (*dataset*) | the stored `TerrainDelta` for that revision/sequence pair, sparse payload included. A stale revision fails with `details.reason:'revision_mismatch'`. Only the last 256 deltas (`DELTA_WINDOW`) are retained: an aged-out sequence fails as **pruned**, while one that never existed fails as **unknown** |
| `terrain.getChangedSince` | `{sequenceNumber, datasetRevision?}` (*dataset*) | poll result with `fromSequence`, `toSequence`, `datasetRevision`, `terrainId`, `seed`, complete `baseline`, per-layer height/semantic `layerChecksums`, `baselineRequired`, `changedTiles`, exact summed `rocksReseated`, and per-layer counts. Omitting the revision is the baseline handshake: the client must compare identity and every consumed channel before adopting the returned revision/head. Once bound, clients send the revision on every poll; stale revisions fail with `revision_mismatch` |
| `terrain.snapshot` | — (*dataset*, no running job) | atomically publishes snapshot v2 under a unique `<outputDirectory>/snapshots/snap-r<revision>-s<sequence>-n<counter>/`: every layer's height and semantic/disturbance/elevation-source masks, immutable dataset identity/session settings, checksummed feature manifest, full operation log, retained deltas, revision, and sequence head. Files are written exclusively into a fresh temporary directory and the checksummed manifest is written last before rename |
| `terrain.restoreSnapshot` | `{directory}` (*dataset*, no running job) | stages and validates the v2 manifest, regular-file confinement, bounded sizes before reads, every checksum/encoding, immutable dataset identity/session settings, feature/audit schemas, physical rock invariants (positive bounded scale, normalized quaternion, burial/angularity range, layer coverage, no wholly floating instance), revision/sequence consistency, and delta chains **before one atomic session swap**. Success installs a new monotonic `datasetRevision`; corrupt/schema/checksum failures return `TERRAIN_VALIDATION_FAILED`, while a snapshot for a different terrain or immutable configuration returns `TERRAIN_INVALID_CONFIG`. Every failure leaves all live state unchanged. Incomplete v1 snapshots are rejected rather than partially restored |
| `terrain.getTile` | `{layerId?, channel?:'height'\|'semantic', col0, row0, width, height, stride?}` (*dataset*) | height (default): `{..., channel:'height', encoding:'base64:float32le', data}` with optional decimation; semantic: stride 1 only, `{..., channel:'semantic', encoding:'base64:uint8', data}` |
| `terrain.getHeight` | `{x, z}` (*dataset*) | `{x, z, elevationM, layerId, datumElevationM}` — finest covering layer, bilinear |
| `terrain.getNormal` | `{x, z}` (*dataset*) | `{x, z, normal: {x,y,z} \| null, layerId?}` |
| `terrain.getSemanticClass` | `{x, z}` (*dataset*) | `{x, z, semanticClass, index, layerId}` (names from `SEMANTIC_CLASSES`) |
| `terrain.getTraversability` | `{x, z, model?:'bekker'\|'heuristic'}` (*dataset*) | default Bekker–Wong static screening: `{x,z,traversability:{model:'bekker',slopeDeg,sinkageM,drawbarPullN,thrustN,slopeMarginDeg,class,parameters:{...,provenance},heuristic}\|null}`. The provenance states the equatorial-Apollo/simulant basis, polar extrapolation, low-gravity caveat, and static-only scope. `model:'heuristic'` preserves the legacy labelled heuristic shape |
| `terrain.getSolar` | `{epochUtc?, x?, z?, mode?, kernelDirectory?}` (*dataset*) | solar geometry plus `model:'ephemeris'|'ephemeris_de'`; DE mode reads the configured JPL kernels and fails explicitly when unavailable, while optional `(x, z)` re-anchors the local horizontal (~0.033°/km of offset) |
| `terrain.getHorizon` | `{azimuthBins?, x?, z?, farField?}` (*dataset*) | `{layerId, bins, azimuthStepDeg, horizonElevationDeg[], note}` — ray-marched over the widest layer; curvature not re-applied (see [coordinate-system.md](coordinate-system.md)). `farField: true` (or `{demPath?, maxRangeMeters?}`) additionally great-circle-marches the LOLA LDEM_75S product to 100 km ([ADR 0006](decisions/0006-far-field-horizon.md)); `horizonElevationDeg` then becomes the per-bin max and the response adds `nearFieldElevationDeg[]` and a `farField` provenance block (`{applied, elevationDeg[], source, observer, startRangeM, maxRangeM, truncatedAtM, noDataSamples, method}`). Requires a DEM-grounded dataset and the product on disk (`LTS_LDEM_75S` overrides the default path); either missing is a structured error, never a silent near-field-only answer |
| `terrain.shutdown` | — | `{shuttingDown: true}`, then the process exits (~50 ms) |

### `terrain.getTile` decimation

For the default `channel:'height'`, `stride` returns every n-th sample so a preview stays bounded (a 3001² layer is 36 MB of float32, 48 MB as base64). The returned `resolutionMeters` is the **spacing of the returned samples** (`layer.horizontalResolutionMeters * stride`); `layerResolutionMeters` is the layer's own. A simulation client requests `stride: 1` and receives every value. The browser UI bounds each layer to ~512 samples per edge (`PREVIEW_MAX_SIDE` in `apps/interactive-ui/src/main.ts`). Semantic tiles are exact uint8 class indices and require stride 1; an unknown channel, a missing semantic mask, or semantic decimation is a structured error.

### Job records

`JobRecord` (`terrain-protocol`): `jobId`, `status` (`queued | running | complete | failed | cancelled`), `seed`, `terrainId`, `stage`, `progress`, `startedAt`, `finishedAt?`, `outputDirectory?`, `error?` (the structured `TerrainError` record). Job ids are `terrain-job-NNNNN`.

## Edit operations and deltas

Edits are **replayable records**, never mutated meshes (`operations.ts` header; spec §12, §19). `terrain.applyOperation` validates every numeric parameter finite *before* touching the heightfield (a NaN would be committed and surface only much later), applies the operation to the named layer (default: the finest), recomputes vertical bounds, and returns a delta. Rocks are then re-seated over the affected bounds expanded by exactly one edited-layer sample: bilinear support means a rock centre just outside the changed-sample box can still depend on an edited edge sample.

`TerrainOperation` fields (`terrain-protocol`): `operationId` (`op-NNNNNN`), `kind` (table below), `layerId`, `centerXMeters`, `centerZMeters`, `radiusMeters`, `strengthMeters` (signed magnitude, metres; interpretation depends on `kind`), `falloff` (exponent; 1 linear, 2 smooth), `targetElevationMeters?`, `headingDegrees?` + `lengthMeters?`, `polygonXZ?` (polygonal ops: ≥ 3 finite `[x, z]` vertices, world metres), `noiseSeed?` (required for `noise`), `semanticClass?` (required for `semantic_paint`), `massConserving?`, `timestamp` (ISO-8601).

Operation kinds:

| Kind | Shape | Parameter use |
|---|---|---|
| `raise` / `lower` | radial brush, ±`strengthMeters` at the centre | `radiusMeters`, `falloff` |
| `smooth` | blend toward the 4-neighbour mean | `strengthMeters` caps the blend factor |
| `flatten` | pull toward `targetElevationMeters` | weighted by the brush falloff |
| `slope` | radial brush: tilt toward a plane through the click point's **current** elevation | gradient `strengthMeters` per `radiusMeters`, descending along `headingDegrees` (required; ADR 0002 azimuth) |
| `noise` | radial brush: deterministic seeded fBm stamp, amplitude `strengthMeters` | requires `noiseSeed` (string); 4 octaves at frequency 2/`radiusMeters` — the same record reproduces the same displacement on replay |
| `semantic_paint` | radial brush, **mask only**: paints the semantic mask, zero height change | requires `semanticClass` (one of `SEMANTIC_CLASSES`; invalid names fail with a structured error listing the valid set); volumes are zero and the height checksum is unchanged — the delta's mask checksums record the change |
| `crater_stamp` | parabolic cavity + Gaussian rim out to 1.3·radius | `strengthMeters` = depth |
| `trench` / `berm` | linear cut/heap along a segment centred on the centre | `headingDegrees`, `lengthMeters`, `radiusMeters` = half-width |
| `ramp` | linear grade from the existing elevation at the centre (near end) to `targetElevationMeters` at the far end, `lengthMeters` along `headingDegrees` | `radiusMeters` = half-width; smooth edge-falloff band |
| `pad` | flatten to `targetElevationMeters`: circular (radius `radiusMeters`) or, with `lengthMeters`, rectangular `lengthMeters` × 2·`radiusMeters` along `headingDegrees` | reported as cut **and** fill |
| `spoil_pile` | conical pile, height `strengthMeters`, base radius `radiusMeters` | height clamped to `radius·tan 35°` (regolith angle of repose); the clamp is reported in the result (`reposeClamp`), never silent |
| `wheel_track` | two parallel ruts along `headingDegrees`, gauge `radiusMeters` (centre-to-centre), rut width 0.3·`radiusMeters`, depth `strengthMeters`, length `lengthMeters` | raised berms beside each rut carry ~40% of the rut cross-section per side (~80% of the removal total) |
| `polygonal_cut` / `polygonal_fill` | cut down / fill up to `targetElevationMeters` inside `polygonXZ` | point-in-polygon interior; falloff band of `radiusMeters` outside the boundary; a cut never deposits, a fill never removes |

Everything from `trench` down is a **construction feature** (spec §11): applying one also appends a `ConstructionFeature` record (measured mass balance using the configured `bulkDensityKgM3`, default 1500 kg/m³, before/after elevation stats, semantic class) to the dataset's feature manifest, which is exported to `features_construction.json` alongside `craters.json` / `rocks.json`. The six kinds from `ramp` down additionally stamp the semantic mask over the samples they shape (`compacted_surface` for ramp/pad, `berm` for spoil_pile/polygonal_fill, `disturbed_regolith` for wheel_track, `trench` for polygonal_cut); the mass-conserving redistribution ring is left unmarked — it is borrowed regolith, not the feature.

`TerrainDelta` fields: `deltaId` (`delta-NNNNNN`), `datasetRevision`, `sequenceNumber`, `timestamp`, `affectedBounds` `{minX,minZ,maxX,maxZ}`, `changedTiles` (tile ids intersecting the bounds), `operations`, exact nonnegative `rocksReseated`, `previousChecksum` / `resultingChecksum` (SHA-256 of the raw heightfield bytes), `previousMaskChecksum` / `resultingMaskChecksum` (SHA-256 of the semantic mask), `massBalance` `{removedVolumeM3, depositedVolumeM3, netVolumeM3, relativeError}`, `changedSampleCount`, and `changedMaskSampleCount`. A delta is identified by the revision/sequence pair; sequence numbers alone may be reused after an atomic snapshot restore and therefore are not world identity. Height changes carry `sparse {layerId,sampleCount,indices,heights}` (`indices`: base64 uint32le row-major; `heights`: base64 float32le) or an explicit `sparseOmitted`. Semantic changes independently carry `maskSparse {layerId,sampleCount,indices,values}` (`values`: base64 uint8 class indices) or `maskSparseOmitted`. Each sparse stream uses the same 65,536-sample cap. Mass-conserving mode redeposits displaced volume in the operation-specific redistribution ring; the residual is **measured and reported**, not assumed zero.

## Live sync: sparse deltas, polling, snapshots (spec §19)

A live Godot excavation session keeps its imported world checksum-aligned without re-exporting it:

- **Sparse height and semantic encoding.** Deltas carry the exact changed height and class samples when each stream is at or below `SPARSE_SAMPLE_CAP = 65 536`. Above the cap, `LunarTerrainLiveSync` requests the smallest stride-1 `terrain.getTile` rectangle for the omitted channel. It verifies each previous checksum before mutation and each resulting checksum afterward; mismatch stops synchronization and requests a validated full resync.
- **Revision-bound polling.** The first `terrain.getChangedSince` request omits `datasetRevision`; its `baselineRequired:true` response supplies terrain id, seed, revision, head, every layer channel, immutable-identity hash, and rock-physics hash. The Godot client then compares `terrain.getDataset` geometry/origin/frame/configuration, replaces rocks from a response carrying the same revision and sequence, and only then enables edits. Later polls and every `terrain.getDelta` carry the revision. Restore or generation changes the revision, so a stale client gets `revision_mismatch` even when the numeric sequence head is the same. The session retains the last **256** deltas (`DELTA_WINDOW`, counted across revisions; a restore keeps the older revision's records until they age out); a sequence number older than the window fails as *pruned*.
- **Bounded Godot refresh.** The addon stores render/collision chunk metadata and rebuilds only chunks intersecting `affectedBounds` (plus one sample for normals). Every delta chains `previousRockTransferSha256` to `resultingRockTransferSha256`; `rocksReseated: 0` requires equal digests and skips the complete rock transfer/MultiMesh/collision rebuild, while a positive count requires a changed digest and a verified replacement. Terrain arrays, rendered chunks, collision, rocks, sequence, and emitted state commit together or roll back together. The synchronizer serializes requests, so an immediate `applyOperation` response cannot race an in-flight poll.
- **Bounded transport.** The Godot loader accepts at most 16,000,000 samples per layer. Its WebSocket receive ceiling is 128 MiB, above the 81.4 MiB (85.3 MB) base64 payload of the largest accepted stride-1 float32 tile (16,000,000 × 4 bytes) plus its JSON envelope. A maximum 50,000-rock canonical binary transfer is bounded to 17,050,025 decoded bytes (22,733,368 base64 characters) before decode; malformed length, digest, order, duplicate-id, JSON-coherence, or trailing-byte cases fail closed.
- **Complete atomic snapshots.** Snapshot v2 includes immutable dataset identity and session settings alongside all mutable rasters, rock/construction feature state, the operation log, retained deltas, revision, and `nextSequence`. Restore validates bounded, confined regular files and stages all components before swapping the live dataset/session, then advances the live revision. Both methods are refused while generation runs.

The declared limits ride in `terrain.capabilities` as `sync: {sparseSampleCap, deltaWindow}`.

Undo semantics live in the client, not the protocol: only `raise/lower/berm/trench` have exact inverses from the stored record; `smooth`, `flatten` and `crater_stamp` destroy information and cannot be undone (`INVERTIBLE_KINDS` in `apps/interactive-ui/src/main.ts`; see [known-limitations.md](known-limitations.md)).

## Examples

Recorded from a live sidecar (`npm run serve --port 8820`) holding the shipped
demonstration site on 2026-08-17; long hashes and arrays are elided with `…`.

Hello, then capabilities (the DEM path is whatever the sidecar resolved):

```json
← {"event":"terrain.hello","protocolVersion":"2.0.0","generatorVersion":"0.1.0"}
→ {"jsonrpc":"2.0","id":1,"method":"terrain.capabilities"}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2.0.0","generatorVersion":"0.1.0","methods":["terrain.health","…"],"datasets":{"site01DemPath":"/…/lola_5mpp/Site01_final_adj_5mpp_surf.tif","site01DemSource":"env:LTS_SITE01_DEM"},"sync":{"sparseSampleCap":65536,"deltaWindow":256},"…":"…"}}
```

Revision-bound edit and its delta (rock-transfer digests chain the complete
rock physics before and after):

```json
→ {"jsonrpc":"2.0","id":7,"method":"terrain.applyOperation","params":{"operation":{"kind":"raise","centerXMeters":0,"centerZMeters":0,"radiusMeters":3,"strengthMeters":0.5,"falloff":2}}}
← {"jsonrpc":"2.0","id":7,"result":{"delta":{"deltaId":"delta-000000","datasetRevision":1,"sequenceNumber":0,"changedSampleCount":282687,"changedMaskSampleCount":0,"rocksReseated":0,"sparseOmitted":"sample count 282687 exceeds 65536; fetch changed tiles instead","previousRockTransferSha256":"f4100603…","resultingRockTransferSha256":"f4100603…","changedTiles":["operational-2_t…"],"previousChecksum":"…","resultingChecksum":"…","massBalance":{"…":"…"}},"operation":{"operationId":"op-000000","kind":"raise","…":"…"},"rocksReseated":0}}
→ {"jsonrpc":"2.0","id":8,"method":"terrain.getDelta","params":{"sequenceNumber":0,"datasetRevision":99}}
← {"jsonrpc":"2.0","id":8,"error":{"code":-32000,"message":"…","data":{"code":"TERRAIN_VALIDATION_FAILED","details":{"reason":"revision_mismatch","…":"…"}}}}
```

Snapshot and restore of the whole mutable state (restore installs a new
revision, so live clients re-baseline):

```json
→ {"jsonrpc":"2.0","id":9,"method":"terrain.snapshot"}
← {"jsonrpc":"2.0","id":9,"result":{"snapshotVersion":2,"sequenceNumber":2,"terrainId":"south_pole_site_01","seed":"lunar-south-pole-site-01","directory":"/…/generated/south_pole_site_01/snapshots/snap-r1-s2-n1","stateFile":"state.json","…":"…"}}
→ {"jsonrpc":"2.0","id":10,"method":"terrain.restoreSnapshot","params":{"directory":"/…/snapshots/snap-r1-s2-n1"}}
← {"jsonrpc":"2.0","id":10,"result":{"directory":"/…/snapshots/snap-r1-s2-n1","snapshotSequenceNumber":2,"restoredLayers":3,"restoredFeatures":14432,"restoredOperations":2,"nextSequence":2,"datasetRevision":2,"layers":["…"]}}
```

Structured failure (missing DEM):

```json
← {"jsonrpc":"2.0","id":11,"error":{"code":-32000,"message":"The configured DEM is not readable. No synthetic fallback exists; fix the path or disable dem.enabled to generate a fully synthetic site.","data":{"code":"TERRAIN_DEM_UNAVAILABLE","message":"…","details":{"path":"/data/missing.tif"}}}}
```

## Checksum chain scope

Delta checksums (height and semantic-mask) are computed over the **edited
layer only**. The chain property — each delta's `previousChecksum` equalling
its predecessor's `resultingChecksum` — therefore holds **per layer**: two
consecutive deltas on different layers do not chain to each other, and the
`finalChecksum`/`finalMaskChecksum` returned by `terrain.replayLog` describe
the last-edited layer, not the whole dataset. A multi-layer replay is fully
verified by comparing the per-layer checksums of the last delta touching each
layer. The mask checksum covers `masks.semantic`; other masks are not hashed.
