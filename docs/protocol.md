# Sidecar protocol

Scope: the JSON-RPC 2.0 WebSocket protocol between the terrain sidecar server and its clients (the browser UI and the Godot editor dock). This is the reference for transport, the connection handshake, every method the server implements, progress events, the structured error shape, the single-running-job policy, and the edit/delta records. Sources of truth: `packages/terrain-protocol/src/index.ts` (constants and wire types), `apps/headless-server/src/server.ts` (method implementations), `apps/headless-server/src/operations.ts` (delta construction), `packages/shared-types/src/config.ts` (error codes). See [ADR 0003](decisions/0003-ui-and-dock-are-protocol-clients.md) for why both front ends are thin clients of this protocol.

## Transport

- **JSON-RPC 2.0 over WebSocket**, one JSON text frame per request/response/notification.
- Default endpoint `ws://127.0.0.1:8765` (`DEFAULT_PORT` in `terrain-protocol`; port overridable with `lunar-terrain serve --port N`).
- **Loopback only.** `startServer` (`server.ts`) binds `host: '127.0.0.1'` explicitly. The server reads and writes arbitrary filesystem paths supplied by its client (`terrain.loadConfig`, `terrain.saveConfig`, `terrain.export`, config `outputDirectory`), so exposing it on a routable address would hand out a remote file-read/write primitive. There is no authentication layer; loopback binding *is* the security model.
- `PROTOCOL_VERSION = '1.0.0'`, `GENERATOR_VERSION = '0.1.0'` (`terrain-protocol/src/index.ts`, `terrain-pipeline/src/generate.ts`).

## The hello event

On every new connection the server pushes, unsolicited:

```json
{ "event": "terrain.hello", "protocolVersion": "1.0.0", "generatorVersion": "0.1.0" }
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
| `terrain.capabilities` | — | protocol/generator versions, `methods`, `exportFormats` (`rf32, exr, png16, npy, glb, json`), `operations`, `craterModels`, `rockModels`, `noiseModels`, `demFormats` (`pds3_img, geotiff`), `solarModes`, `coordinateSystem`, `notImplemented` (`gpuGeneration`, `volumetricTerrain`) |
| `terrain.validateConfig` | `{config}` (or the config inline) | `{valid: true, terrainId, seed}`; invalid configs fail with `TERRAIN_INVALID_CONFIG` and per-field `details.issues` |
| `terrain.estimate` | `{config}` | `{estimate, feasible, error}` — feasibility from `assertFeasible` without allocating |
| `terrain.generate` | `{config}` | `{jobId, status:'queued', seed}` immediately; work continues asynchronously (progress events, then a `JobRecord` retrievable via `getStatus`). On success the dataset is installed in the session and exported to the config's `outputDirectory` |
| `terrain.cancel` | `{jobId}` | `{jobId, cancelling: true}`; cancellation is cooperative (checked between pipeline stages); the job ends `cancelled` with `TERRAIN_CANCELLED` |
| `terrain.getStatus` | `{jobId?}` | the `JobRecord` for one job, or `{jobs: [...]}` for all remembered jobs |
| `terrain.getManifest` | `{directory?}` or `{jobId?}` | the parsed `manifest.json` of an export |
| `terrain.getDataset` | — (*dataset*) | live session summary: `terrainId`, `seed`, `coordinateSystem`, `origin{site, datumElevationM}`, `bounds`, per-layer geometry + `elevationProvenance`, feature counts, `provenance` |
| `terrain.export` | `{outputDirectory?, formats?: {exr?, png16?, npy?, glb?}}` (*dataset*, no running job) | `{outputDirectory, artifacts, totalBytes, validation: {passed, errors}}` — runs `validateDataset` on the result |
| `terrain.loadConfig` | `{path}` | the parsed, validated config |
| `terrain.saveConfig` | `{path, config}` | `{path, bytes}` |
| `terrain.applyOperation` | `{operation}` (*dataset*, no running job) | `{delta, operation, rocksReseated}` — see below |
| `terrain.getOperationLog` | — | `{operations, deltas}` — the full ordered operation log plus per-delta **summaries** (`deltaId`, `sequenceNumber`, `kind`, `changedTileCount`, `massBalance`, `timestamp`, `resultingChecksum`, `resultingMaskChecksum`); empty arrays before any generate |
| `terrain.replayLog` | `{operations: TerrainOperation[]}` (*dataset*, no running job) | applies each record in order through the **same internal path** as `applyOperation`, validation included; returns `{applied, deltas, finalChecksum, finalMaskChecksum}`. Deterministic replay (spec §12, §19): generate the same seed, replay the same log, get the same terrain. A malformed record mid-log fails with a structured error whose `details` carry `failedIndex`, `appliedOperations` and the causing error — operations before the failure are applied and stay applied (apply-up-to-failure, reported, never silent) |
| `terrain.getDelta` | `{sequenceNumber}` (*dataset*) | the stored `TerrainDelta` for that sequence number, sparse payload included. Only the last 256 deltas (`DELTA_WINDOW`) are retained: an aged-out sequence number fails as **pruned** (`details.reason: 'pruned'`, full resync required), one that never existed fails as **unknown** (`details.reason: 'unknown'`) — distinct because the client's remedy differs |
| `terrain.getChangedSince` | `{sequenceNumber}` (*dataset*) | `{fromSequence, toSequence, changedTiles, perLayer: [{layerId, changedSampleCount}]}` — the deduplicated union of changed tile ids across every delta at or after `sequenceNumber`, the cheap poll a live client uses to decide what to refetch. `sequenceNumber === toSequence` yields an empty union; older than the retained window fails as pruned, telling the client to do a full resync |
| `terrain.snapshot` | — (*dataset*, no running job) | writes every layer's raw heightfield (`<layerId>.height.f32`, float32le) and semantic mask (`<layerId>.mask.u8`) plus a checksummed manifest (`snapshot.json`: `sequenceNumber`, `timestamp`, per-layer sha256) to `<outputDirectory>/snapshots/snap-<seq>/`; returns the manifest |
| `terrain.restoreSnapshot` | `{directory}` (*dataset*, no running job) | validates the manifest checksums against the files **before touching anything** — checksum, size, or missing-file problems fail with `TERRAIN_VALIDATION_FAILED` and leave the live dataset untouched (corrupt snapshots must not load); layer ids that do not match the current dataset fail with `TERRAIN_INVALID_CONFIG` listing the mismatches. On success restores heights + masks into the CURRENT dataset, resets the deltas and operation log (a new baseline at sequence 0), and returns per-layer checksums |
| `terrain.getTile` | `{layerId?, col0, row0, width, height, stride?}` (*dataset*) | `{layerId, col0, row0, width, height, stride, resolutionMeters, layerResolutionMeters, encoding:'base64:float32le', data}` |
| `terrain.getHeight` | `{x, z}` (*dataset*) | `{x, z, elevationM, layerId, datumElevationM}` — finest covering layer, bilinear |
| `terrain.getNormal` | `{x, z}` (*dataset*) | `{x, z, normal: {x,y,z} \| null, layerId?}` |
| `terrain.getSemanticClass` | `{x, z}` (*dataset*) | `{x, z, semanticClass, index, layerId}` (names from `SEMANTIC_CLASSES`) |
| `terrain.getTraversability` | `{x, z}` (*dataset*) | `{x, z, traversability: {slopeDeg, roughnessM, score, class, provenance} \| null}` — the `provenance` string labels it a **synthetic heuristic**, not a terramechanics prediction |
| `terrain.getSolar` | `{epochUtc?, x?, z?}` (*dataset*) | `{epochUtc, elevationDeg, azimuthDeg, angularRadiusDeg, discFractionAboveHorizon, subSolar, site, model:'ephemeris', note}` — optional `(x, z)` re-anchors the local horizontal (~0.033°/km of offset) |
| `terrain.getHorizon` | `{azimuthBins?, x?, z?}` (*dataset*) | `{layerId, bins, azimuthStepDeg, horizonElevationDeg[], note}` — ray-marched over the widest layer; curvature not re-applied (see [coordinate-system.md](coordinate-system.md)) |
| `terrain.shutdown` | — | `{shuttingDown: true}`, then the process exits (~50 ms) |

### `terrain.getTile` decimation

`stride` returns every n-th sample so a preview stays bounded (a 3001² layer is 36 MB of float32, 48 MB as base64). The returned `resolutionMeters` is the **spacing of the returned samples** (`layer.horizontalResolutionMeters * stride`); `layerResolutionMeters` is the layer's own. A simulation client requests `stride: 1` and receives every value. The browser UI bounds each layer to ~512 samples per edge (`PREVIEW_MAX_SIDE` in `apps/interactive-ui/src/main.ts`).

### Job records

`JobRecord` (`terrain-protocol`): `jobId`, `status` (`queued | running | complete | failed | cancelled`), `seed`, `terrainId`, `stage`, `progress`, `startedAt`, `finishedAt?`, `outputDirectory?`, `error?` (the structured `TerrainError` record). Job ids are `terrain-job-NNNNN`.

## Edit operations and deltas

Edits are **replayable records**, never mutated meshes (`operations.ts` header; spec §12, §19). `terrain.applyOperation` validates every numeric parameter finite *before* touching the heightfield (a NaN would be committed and surface only much later), applies the operation to the named layer (default: the finest), recomputes vertical bounds, re-seats rocks whose centres fall in the affected bounds (`reseatRocks` in `server.ts` — rocks are instances, not heightfield features), and returns a delta.

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

Everything from `trench` down is a **construction feature** (spec §11): applying one also appends a `ConstructionFeature` record (measured mass balance at 1500 kg/m³ bulk density, before/after elevation stats, semantic class) to the dataset's feature manifest, which is exported to `features_construction.json` alongside `craters.json` / `rocks.json`. The six kinds from `ramp` down additionally stamp the semantic mask over the samples they shape (`compacted_surface` for ramp/pad, `berm` for spoil_pile/polygonal_fill, `disturbed_regolith` for wheel_track, `trench` for polygonal_cut); the mass-conserving redistribution ring is left unmarked — it is borrowed regolith, not the feature.

`TerrainDelta` fields: `deltaId` (`delta-NNNNNN`), `sequenceNumber`, `timestamp`, `affectedBounds` `{minX,minZ,maxX,maxZ}`, `changedTiles` (tile ids intersecting the bounds, from `tilesInBounds`), `operations`, `previousChecksum` / `resultingChecksum` (SHA-256 of the layer's raw heightfield bytes, `layerChecksum` — deltas chain per edited layer), `previousMaskChecksum` / `resultingMaskChecksum` (SHA-256 of the layer's semantic mask, populated for every kind — without them a `semantic_paint`, which moves no height, would produce a delta claiming nothing changed), `massBalance` `{removedVolumeM3, depositedVolumeM3, netVolumeM3, relativeError}`, `changedSampleCount` (height samples the edit committed; 0 for a mask-only `semantic_paint`), and the live-sync payload: `sparse` `{layerId, sampleCount, indices, heights}` — `indices` base64 uint32le row-major sample indices into the edited layer, `heights` base64 float32le post-edit elevations at those samples — or, above the cap, `sparseOmitted` stating why. Mass-conserving mode redeposits the displaced volume in an annulus between `radius` and `1.6×radius`; the residual is **measured and reported**, not assumed zero.

## Live sync: sparse deltas, polling, snapshots (spec §19)

A live Godot excavation session keeps its terrain in step without re-streaming full tiles:

- **Sparse changed-sample encoding.** Every delta from `terrain.applyOperation` / `terrain.replayLog` carries `sparse`: the exact samples the edit changed and their new heights. A client applies them in place to its copy of the layer and is bit-identical with the server. **Cap: 65 536 changed samples** (`SPARSE_SAMPLE_CAP` in `terrain-protocol`) — past that a sparse payload out-weighs simply refetching the changed tiles, so `sparse` is omitted and `sparseOmitted` says `sample count N exceeds 65536; fetch changed tiles instead`.
- **Cheap polling.** `terrain.getChangedSince` returns the deduplicated changed-tile union and per-layer changed-sample counts since a sequence number; `terrain.getDelta` fetches an individual missed delta. The session retains the last **256** deltas (`DELTA_WINDOW`); older sequence numbers fail as *pruned* (do a full resync), never as *unknown*.
- **Periodic full snapshots.** `terrain.snapshot` writes each layer's full heightfield + semantic mask + a sha256-checksummed manifest under `<outputDirectory>/snapshots/snap-<seq>/`; `terrain.restoreSnapshot` validates every checksum before mutating anything and restores the snapshot into the current dataset as a new baseline (deltas and operation log reset). Both are refused while a generate runs. The snapshot covers heightfields and semantic masks; the feature manifest is not snapshotted — features added by construction edits after the snapshot survive a restore as records even though their terrain shaping is rolled back.

The declared limits ride in `terrain.capabilities` as `sync: {sparseSampleCap, deltaWindow}`.

Undo semantics live in the client, not the protocol: only `raise/lower/berm/trench` have exact inverses from the stored record; `smooth`, `flatten` and `crater_stamp` destroy information and cannot be undone (`INVERTIBLE_KINDS` in `apps/interactive-ui/src/main.ts`; see [known-limitations.md](known-limitations.md)).

## Examples

Generate (request → immediate response → progress → final status):

```json
→ {"jsonrpc":"2.0","id":1,"method":"terrain.generate","params":{"config":{ "terrainId":"south_pole_site_01","seed":"site-alpha","site":{"latitudeDeg":-89.4631639,"longitudeDeg":-137.4895528},"layers":[{"role":"context","widthMeters":1000,"lengthMeters":1000,"resolutionMeters":2}],"solar":{"mode":"ephemeris","epochUtc":"2026-08-03T00:00:00Z"}}}}
← {"jsonrpc":"2.0","id":1,"result":{"jobId":"terrain-job-00001","status":"queued","seed":"site-alpha"}}
← {"event":"terrain.progress","jobId":"terrain-job-00001","stage":"generating_craters","progress":0.35}
→ {"jsonrpc":"2.0","id":2,"method":"terrain.getStatus","params":{"jobId":"terrain-job-00001"}}
← {"jsonrpc":"2.0","id":2,"result":{"jobId":"terrain-job-00001","status":"complete","seed":"site-alpha","terrainId":"south_pole_site_01","stage":"complete","progress":1,"startedAt":"…","finishedAt":"…","outputDirectory":"/…/generated"}}
```

Point query:

```json
→ {"jsonrpc":"2.0","id":3,"method":"terrain.getHeight","params":{"x":12.5,"z":-40.0}}
← {"jsonrpc":"2.0","id":3,"result":{"x":12.5,"z":-40.0,"elevationM":0.4183,"layerId":"operational-2","datumElevationM":1621.74}}
```

Edit with mass balance:

```json
→ {"jsonrpc":"2.0","id":4,"method":"terrain.applyOperation","params":{"operation":{"kind":"lower","centerXMeters":0,"centerZMeters":0,"radiusMeters":3,"strengthMeters":0.4,"falloff":2,"massConserving":true}}}
← {"jsonrpc":"2.0","id":4,"result":{"delta":{"deltaId":"delta-000000","sequenceNumber":0,"affectedBounds":{"minX":-4.8,"minZ":-4.8,"maxX":4.8,"maxZ":4.8},"changedTiles":["operational-2_t000000_000000"],"previousChecksum":"…","resultingChecksum":"…","massBalance":{"removedVolumeM3":1.702,"depositedVolumeM3":1.702,"netVolumeM3":0.0,"relativeError":0.0}},"operation":{"operationId":"op-000000","kind":"lower","…":"…"},"rocksReseated":2}}
```

Structured failure (missing DEM):

```json
← {"jsonrpc":"2.0","id":5,"error":{"code":-32000,"message":"The configured DEM is not readable. No synthetic fallback exists; fix the path or disable dem.enabled to generate a fully synthetic site.","data":{"code":"TERRAIN_DEM_UNAVAILABLE","message":"…","details":{"path":"/data/ldem_87s_5m.img"}}}}
```

Elevation values in the examples above are illustrative of shape, not recorded transcripts; field names and structure are verbatim from `server.ts`.


### Checksum chain scope

Delta checksums (height and semantic-mask) are computed over the **edited
layer only**. The chain property — each delta's `previousChecksum` equalling
its predecessor's `resultingChecksum` — therefore holds **per layer**: two
consecutive deltas on different layers do not chain to each other, and the
`finalChecksum`/`finalMaskChecksum` returned by `terrain.replayLog` describe
the last-edited layer, not the whole dataset. A multi-layer replay is fully
verified by comparing the per-layer checksums of the last delta touching each
layer. The mask checksum covers `masks.semantic`; other masks are not hashed.
