# ADR 0003 — The UI and the Godot dock are both protocol clients

**Status:** accepted · **Date:** 2026-08-03

## Context

Two front ends were needed: the interactive Three.js authoring UI (spec §12,
§23) and the Godot editor dock (spec §17). Each could plausibly own some
generation logic — the browser could run noise in a worker, and the dock could
shell out to the CLI.

## Decision

**Neither front end generates terrain.** Both are thin clients of the same
JSON-RPC sidecar:

```
             ws://127.0.0.1:8765
browser UI ──────────┐
                     ├──► sidecar ──► terrain-pipeline ──► artifacts
Godot dock ──────────┘     (sole generator)
```

- `apps/interactive-ui/src/rpc.ts` — browser client
- `godot/addon/lunar_terrain/sidecar_client.gd` — Godot client, same wire format

## Why

- **One implementation of physics-bearing data** (spec §33: "the Three.js
  application must not silently change physics data"). If the browser generated
  its own preview, the picture and the exported heightfield could disagree and
  nothing would catch it.
- **The browser cannot read the source data.** The DEMs are 40–140 MB GeoTIFFs
  on local disk; only the server can open them. A browser-side generator would
  have to be a *different, unvalidated* generator.
- **Editing stays auditable.** Brush strokes become `terrain.applyOperation`
  calls that return replayable deltas with checksums and mass balance. A local
  mesh edit would produce none of that.
- **The dock gets the same guarantees free.** Progress, structured errors,
  validation and delta semantics are the protocol's, not reimplemented twice.

## Consequences, and the honesty they demand

**The viewport is a decimated preview.** A 3001² operational layer is 36 MB of
float32 (48 MB base64). `terrain.getTile` gained a `stride` parameter so each
layer streams at ~512 samples per edge, about 1 MB.

That means the rendered mesh is *not* the authoritative surface, so any value a
user might act on — elevation, slope, semantic class, traversability — is
queried from the sidecar rather than read off the mesh. The status bar shows the
preview value instantly and the inspector replaces it with the authoritative
one.

**False-colour overlays are unlit.** Only the `lit` mode uses a shaded material.
Analysis overlays use `MeshBasicMaterial`, because at this site the Sun is below
the horizon for much of the month and a slope map that goes black whenever it
sets is useless. This surfaced as a test failure: the first lit-render check
measured 0.16% lit pixels, which turned out to be physically correct — solar
elevation was −0.46° — rather than a rendering bug.

**Rocks must be re-seated after an edit.** Rocks are instances placed on the
surface, not part of the heightfield, so lowering terrain beneath a boulder left
it hanging in vacuum. The exporter's "no rock sits entirely above the terrain"
check caught it; `reseatRocks` now re-solves every rock inside the affected
bounds.

## Testing note

The integration test spawns Godot **asynchronously**. `execFileSync` blocks
Node's event loop, so the in-process WebSocket server never accepts the
connection and every run times out at step 1 — with a misleading "could not
connect" that looks like a Godot problem rather than a test-harness one.
