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

`TerrainOperation` fields (`terrain-protocol`): `operationId` (`op-NNNNNN`), `kind` (`raise | lower | smooth | flatten | crater_stamp | trench | berm`), `layerId`, `centerXMeters`, `centerZMeters`, `radiusMeters`, `strengthMeters` (signed magnitude, metres; interpretation depends on `kind`), `falloff` (exponent; 1 linear, 2 smooth), `targetElevationMeters?` (flatten), `headingDegrees?` + `lengthMeters?` (trench/berm), `massConserving?`, `timestamp` (ISO-8601).

`TerrainDelta` fields: `deltaId` (`delta-NNNNNN`), `sequenceNumber`, `timestamp`, `affectedBounds` `{minX,minZ,maxX,maxZ}`, `changedTiles` (tile ids intersecting the bounds, from `tilesInBounds`), `operations`, `previousChecksum` / `resultingChecksum` (SHA-256 of the layer's raw heightfield bytes, `layerChecksum` — deltas chain), and `massBalance` `{removedVolumeM3, depositedVolumeM3, netVolumeM3, relativeError}`. Mass-conserving mode redeposits the displaced volume in an annulus between `radius` and `1.6×radius`; the residual is **measured and reported**, not assumed zero.

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
