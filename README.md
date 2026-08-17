# lunar-terrain-sidecar

Terrain generation, authoring and preprocessing sidecar for a Godot-based lunar
robotics simulation, focused on the **lunar south pole** with a real solar
ephemeris.

It is not the physics engine. It produces terrain; Godot remains the simulation
authority.

![The shipped demonstration site (real PGDA Site01 DEM, 89.46°S) in the authoring UI's lit view — solar elevation 1.46°, azimuth 60.8°, computed by the ephemeris for 2026-01-10T00:00:00Z](docs/media/hero-lit.png)

```
Godot Simulation
      │  WebSocket / JSON-RPC 2.0  (ws://127.0.0.1:8768)
      ▼
Terrain Sidecar Server
      ├── terrain-core        seeding, noise, tiling, feasibility
      ├── lunar-solar         ephemeris, sub-solar point, horizon, PSR
      ├── lunar-dem           real LOLA / PGDA DEM ingestion
      ├── lunar-features      craters (Neukum/Xiao–Werner), rocks (Golombek)
      ├── terrain-pipeline    the generation pipeline
      ├── terrain-export      rf32 / EXR / PNG16 / npy / GLB / JSON
      └── terrain-validation  26 automated checks
              ▼
      Heightmaps / Tiles / Manifests
              ▼
         Godot Importer  (godot/addon/lunar_terrain)
```

## Why the sun is not a slider

At a lunar pole the Sun never rises more than **1.54°** above the horizon,
because the Moon's spin axis is tilted only 1.5424° to the ecliptic. Shadow
length goes as `1/tan(elevation)`, so a 1 m rock throws a **38 m** shadow and a
crater rim shadows its floor permanently. Illumination there is a property of
*topography and date*, not a lighting preference — so elevation and azimuth are
computed from a real ephemeris, never set independently.

![One month at the demonstration site: 30 ephemeris epochs from 2025-12-20 to 2026-01-19. Elevation stays between 0.82° and 1.90° while azimuth sweeps the full compass — same terrain, shadows set entirely by the date](docs/media/solar-sweep.gif)

```
$ npm run terrain -- solar -89.4631639 -137.4895528 2026-08-03T00:00:00Z

solar elevation      -0.45772°
solar azimuth        80.58135°   (clockwise from north, north = -Z)
sub-solar point      0.54555°, -56.90356°
disc above horizon   0.0%
```

See [`docs/decisions/0001-solar-model.md`](docs/decisions/0001-solar-model.md).

## Real data, not invented terrain

Elevations come from real LOLA products; synthesis happens **only below what the
measurement resolves**, so the two never double-count:

| Layer | Source | Provenance recorded |
|---|---|---|
| context / mission / operational | PGDA 5 m/px polar site DEM (Site01, Haworth, Shoemaker, …) | `measured_dem_plus_synthetic_subresolution` |
| craters below 17.5 m | Neukum production capped by Xiao & Werner equilibrium | `production_csfd` |
| boulders | Golombek exponential SFD | instance manifest |
| centimetre microrelief | procedural | flagged as a synthetic heuristic |

Every export carries a per-sample `elevation_source.r8` mask recording which
elevations are measurement and which are synthesis. If a configured DEM is
missing, generation **fails** rather than substituting invented elevations.

## Getting the data

The kernels and DEMs are public NASA products, not vendored in the repo:

```bash
bash scripts/fetch-data.sh          # downloads to ./data, verifies SHA-256
export LTS_SPICE_DIR="$PWD/data/spice_kernels"
export LTS_SITE01_DEM="$PWD/data/lola_5mpp/Site01_final_adj_5mpp_surf.tif"
```

The script fetches the JPL DE440 kernels (NAIF), the PGDA/LOLA 5 m/px Site01
and Shoemaker DEMs, and the LOLA LDEM_75S image/label used by far-field horizon
queries (266,871,140 bytes total). It verifies every checksum against the exact
copies this repository was validated with and prints the config/env lines that
point the tools at the downloads. `LTS_SPICE_DIR` overrides the default kernel
directory; DEM paths live in each site config (`dem.path`); `LTS_SITE01_DEM`
is what the sidecar reports to the browser UI (`terrain.capabilities`) so the
UI's DEM field fills itself on connect; and `LTS_LDEM_75S` selects the
far-field label.

The CLI runs through `tsx` (Node ≥ 20 runs it; `.nvmrc` pins 26.7.0, the build the byte-reproducibility oracle and CI use — other Node majors run and pass the tests but may differ in the last ulp of two JSON feature manifests, see `docs/reproducibility.md`): `npm run terrain -- <cmd>`.
The `bin` entry in package.json points at the TypeScript source and is only
runnable where `tsx` is installed; there is no compiled standalone binary.

## Quick start

The committed example records the absolute Site01 path used for its published
reproducibility oracle. On a fresh checkout, run `scripts/fetch-data.sh` and
replace `dem.path` in the configuration below with the absolute Site01 path the
script prints before running these commands. A missing or different path is
rejected; the generator never substitutes terrain data.

```bash
pnpm install    # or: npm install

# What will this cost before it allocates anything?
npm run terrain -- estimate examples/south_pole_site_01/config.json

# Generate a three-tier south-polar site from real LOLA data
npm run terrain -- generate examples/south_pole_site_01/config.json

# 26 automated checks over the exported artifacts
npm run terrain -- validate examples/south_pole_site_01/generated/south_pole_site_01

# Regenerate and compare every checksum
npm run terrain -- reproduce examples/south_pole_site_01/config.json

# Start the Godot sidecar
npm run serve

# Interactive authoring UI (needs the sidecar running)
npm run ui          # then open http://localhost:5173
```

Connecting the UI to a sidecar that already holds terrain renders it
immediately — no Generate needed. If the lit view is black, read the banner:
the Sun really is below the horizon at that epoch (it spends much of each
month there), and the viewport says so rather than looking broken.

## What it looks like

All images are real renders of real data — headless Chromium over the live
sidecar, terrain from the real LOLA Site01 DEM, lighting from the ephemeris.
Provenance and regeneration commands: [`docs/media/README.md`](docs/media/README.md).

![The four analysis overlays over the demonstration site: elevation, slope, semantic classes, and the labelled traversability heuristic](docs/media/overlays.png)

![Top-down elevation view showing the three nested layers — 1 km context at 2 m, 200 m mission at 0.2 m, 30 m operational at 1 cm](docs/media/topdown-elevation.png)

![Construction sequence on the 200 m rover test pad: pad, ramp, repose-clamped spoil pile, mass-conserving excavation, wheel tracks, polygonal cut — every edit a checksummed, replayable delta](docs/media/construction.gif)

![The authoring UI: viewport with legend, inspector with authoritative point queries, provenance panel, solar geometry from the ephemeris](docs/media/authoring-ui.png)

## Godot editor addon

Copy `godot/addon/lunar_terrain` into your project's `addons/`, enable
**Lunar Terrain Sidecar** in Project Settings → Plugins, and a dock appears with
a text-labelled connection state, configuration/seed/export controls, Generate /
Regenerate / Import, live progress, validation results, and the declared
coordinate system. The same dock exposes authoritative point inspection,
Bekker–Wong screening with its applicability caveats, analytic or DE440 solar
geometry, near/far-field horizon queries, data provenance, and simulated
construction controls. It is visibly labelled **not a live command interface**.

The addon speaks the same JSON-RPC protocol as the browser UI
(`sidecar_client.gd`). Static import rejects an incompatible schema/frame,
missing or over-limit data, malformed rock transforms, and checksum mismatches
before allocating scene nodes. Once imported, `terrain_live_sync.gd` verifies
the server revision, immutable geometry/origin/configuration identity, every
consumed raster checksum, and the complete rock-physics hash before enabling
edits. It applies sparse payloads (or exact tile fallbacks above 65,536
samples) and rebuilds only intersecting render/collision chunks. Physical rocks
get real collision on their own physics layer; the perception focus API keeps
selected visual chunks at source-grid resolution.

```
LunarTerrainRoot
├── ContextTerrain / MissionTerrain / OperationalTerrain   chunk containers
│   └── MeshInstance3D chunks (focused chunks can be full resolution)
├── TerrainCollision                                       StaticBody3D
│   └── non-overlapping, spatially chunked HeightMapShape3D regions
├── PhysicalRocks / VisualRocks                            MultiMeshInstance3D
├── PhysicalRockCollision                                  bounded StaticBody3D batches
└── TerrainMetadata                                        seed, frame, provenance
```

## Measured results

All numbers below were produced by the commands in this README on this machine
(AMD64, Node 26.7.0, Godot 4.6.3-stable), not estimated.

**Demonstration site** — `examples/south_pole_site_01`, anchored at
89.463°S 137.490°W on the real `Site01` PGDA DEM:

| | |
|---|---|
| layers | 1 km @ 2 m, 200 m @ 0.2 m, 30 m @ 0.01 m |
| samples | 10,259,003 |
| craters / rocks | 8,023 / 6,409 |
| artifacts | 183 files, 625.9 MB |
| generate / export | 3.8 s / 1.8 s (8 worker threads, byte-identical to single-thread) |
| validation | 26 checks, 0 errors |
| reproducibility | **183/183 artifacts byte-identical** |

Rock count and timing rose from the first release: the Golombek rim-excess fix
stopped dividing the calibrated background density by 4, so the same k = 0.05
now realises ~4.6× more rocks (which is the point — the old figure understated
the cited model). Timings are one sample on one machine; `npm run bench:terrain`
produces the full measured table (`benchmarks/`).

**Godot round trip** (`tests/godot-roundtrip.test.ts`, 166 fixed probe points across
all three tiers, raycast against real collision geometry):

| | |
|---|---|
| probes missed | 0 |
| max elevation error, on-grid | **8.70e-6 m** |
| max elevation error, off-grid | **1.15e-4 m** (bilinear vs Godot's triangulation) |
| addon loader read error | 1.78e-15 m |
| collision normals | all `normal_y > 0` (winding correct) |
| rock collision | 388 physical rocks = 388 shapes; 876 visual-only rocks = 0 shapes |
| incremental build | 29 frame yields; probe, chunk and collision results identical to synchronous build |

**Godot addon lifecycle** (`tests/godot-integration.test.ts`, all 49 steps of
spec §26 against a live sidecar in headless Godot):

| | |
|---|---|
| elevation agreement through collision | **6e-6 m** |
| cut/fill balance on a mass-conserving edit | **0.000%** |
| excavation 0.40 m | 0.1039 m → −0.2961 m |
| collision surface after reload | −0.2961 m — followed exactly |
| live baseline | revision + geometry + origin + configuration + raster/rock hashes agree |
| editor dock | required visual/assistive actions present; no horizontal clipping at 100% or 200% scale |

**Godot release package** (`tests/godot-package.test.ts`, checksum-pinned
Site01 + official Godot 4.6.3 editor/export template):

| | |
|---|---|
| persisted collision | 186 physical rocks = 186 shapes in 4 bodies |
| saved-scene reload raycast error | 1.82e-6 m |
| exported Linux binary + PCK | identical terrain/rock counts, coordinates and raycast error |

A separate full shipped-Site01 acceptance persisted a 67,370,056-byte
`PackedScene`, then launched the official 71,075,864-byte Linux binary with its
67,481,176-byte PCK. Both reload paths retained 170 terrain collision chunks and
931 physical rocks = 931 collision shapes in 9 bodies; the origin raycast error
was 6.52e-7 m.

**Test suite**: 345 tests across 17 files. The two required CI jobs cover all
17 files and reject any skipped, pending, or disabled test in their machine-readable
Vitest reports. The real-data job fetches and verifies every NASA/PGDA/PDS/JPL
source plus the official Godot editor and Linux export template before running.
Do not treat a partial local run with missing prerequisites as acceptance.

```bash
npm test                        # full suite (vitest)
bash scripts/fetch-data.sh      # fetch public datasets + kernels, then:
export LTS_SITE01_DEM="$PWD/data/lola_5mpp/Site01_final_adj_5mpp_surf.tif"
export LTS_LDEM_75S="$PWD/data/lola_ldem/ldem_75s_120m.lbl"
export LTS_SPICE_DIR="$PWD/data/spice_kernels"
```

The Godot suites additionally need a Godot 4 editor binary on `LTS_GODOT`
or PATH. Hosted CI provisions the exact pinned prerequisites and requires the
full 345-test matrix; it does not accept a missing-data skip as success.
`examples/south_pole_site_01/expected-checksums.sha256` is the committed oracle
for the 183-artifact reproduce gate. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the development workflow.

```
tests/lunar-solar.ephemeris.test.ts   23   ephemeris vs physical invariants
tests/lunar-solar.de.test.ts          12   TS DE440 reader vs frozen JPL reference
tests/lunar-dem.real-data.test.ts     23   real LOLA products vs GDAL
tests/lunar-features.test.ts          47   crater/rock models, RNG, estimator
tests/terramech.test.ts               19   Bekker-Wong vs hand-derived formulas
tests/protocol.test.ts                26   real WebSocket JSON-RPC server
tests/construction.test.ts            21   spec-11 features, volumes, mass balance
tests/history.test.ts                 16   operation log + deterministic replay
tests/sync.test.ts                     7   sparse deltas + snapshot/restore
tests/snapshot-state.test.ts          12   complete real-data snapshot atomicity
tests/parallel.test.ts                 4   worker-thread byte-identity
tests/provenance.test.ts               4   per-sample provenance + solar labels
tests/godot-roundtrip.test.ts         47   headless Godot collision agreement
tests/godot-integration.test.ts       16   full spec-26 addon lifecycle + dock
tests/godot-package.test.ts            6   save/reopen + official Linux package
tests/interactive-ui.test.ts          44   real Chromium + WebGL, screenshots
tests/far-horizon.test.ts             11   far-field horizon ring (ADR 0006)
```

## Coordinates

**Right-handed, Y-up, +X east, +Z south — north is −Z.**

The spec asked for right-handed *and* Z=north, which cannot both hold: with
X=east and Y=up, right-handedness forces `Z = X × Y = south`. Handedness was
kept because it governs winding, normals and physics chirality, and because
Three.js and Godot are both right-handed. North is carried as **data** in every
manifest so no consumer has to guess. See
[`docs/decisions/0002-coordinate-handedness.md`](docs/decisions/0002-coordinate-handedness.md).

Grid `col` increases east; `row` increases south, so **row 0 is northernmost**.
Azimuth is clockwise from north: `(x, z) = (sin A, −cos A)`.

## What is synthetic, and labelled as such

Per the project's absolute rule, nothing here fabricates data that stands in for
measurement. Three outputs are genuinely synthetic and say so in every manifest:

- **Centimetre microrelief.** No measurement constrains lunar roughness at
  centimetre scale at these sites. Plausible texture, not observed topography.
- **Traversability** now defaults to a static Bekker–Wong assessment (sinkage,
  drawbar-pull slope margin) with parameters from the NASA LTV terramechanics
  white paper (NTRS 20220010732), cross-checked against Mitchell et al. (1972)
  Apollo in-situ ranges. Still labeled: parameters are equatorial/simulant-
  derived — no polar site has in-situ measurements — and the model is static
  assessment, not force-accurate dynamics (docs/decisions/0005-terramechanics.md).
  The original hand-weighted heuristic remains available and labeled.
- **Sub-DEM crater and boulder populations.** Statistically anchored to
  published size-frequency distributions, but individual features are sampled,
  not observed.

## Known limitations

- **Solar accuracy is now measured, not estimated.** A dependency-free
  TypeScript reader for the real JPL DE440 kernels (SPK + binary PCK lunar
  orientation, fetched by `scripts/fetch-data.sh` and located via
  `LTS_SPICE_DIR`) provides an
  `ephemeris_de` mode and measures the default Meeus/IAU chain against JPL's
  integrated truth: **max 0.0111° sub-solar separation over 2020–2049** (reproducible: `npm run terrain -- de-compare --months 360`; a denser dev-time sweep measured 0.0118°) — the
  literature's 0.01–0.03° budget holds at its favourable end. The default mode
  stays analytic to preserve byte-reproducibility of existing sites; see
  docs/decisions/0004-de440-kernels.md.
- **PSR determination needs 18.6 years of sampling**, not one year, because the
  sub-solar latitude envelope migrates with the nodal cycle.
  `illuminationStatistics` reports the span it was given; it does not assert a
  PSR from a short sample.
- **Skyline fidelity is bounded by the widest layer by default; an opt-in
  far-field ring lifts the bound for queries.** `terrain.getHorizon` with
  `farField: true` great-circle-marches the real LOLA LDEM_75S 120 m/px
  product to 100 km and merges it by per-bin max (the Mazarico et al. 2011
  reference method; docs/decisions/0006-far-field-horizon.md). Distant relief
  can only raise a horizon, so the near-field-only default errs bright — and
  the *rendered* viewport shadows still use layer geometry alone either way.
- **The browser viewport is a decimated preview.** Layers are streamed at a
  stride that bounds each to ~512 samples per edge (a 3001² operational layer
  is 36 MB of float32). Anything a user might act on — elevation, slope,
  semantic class, traversability — is queried from the sidecar, which holds the
  full-resolution field. Do not read measurements off the mesh.
- **Undo is an inverse operation, not a snapshot.** It re-applies the opposite
  edit. For `raise`/`lower`/`berm`/`trench` that is exact; for `smooth` and
  `flatten`, which are not invertible, undo will not restore the prior surface.
- **Off-grid elevation agreement is 0.12 mm in the fixed real-data probe set**,
  because Godot triangulates each
  heightfield cell into two flat triangles while the sidecar interpolates
  bilinearly. On-grid agreement is 8.7 µm.
- **GPU and WASM acceleration are not implemented.** CPU generation is the
  reference implementation and the only implementation.
- **Rock count estimates are background expectations** — rim-excess rocks are
  added on top per crater (realised counts ran ~2.2× the background on the
  shipped demo) and slope rejection subtracts; both depend on terrain not yet
  generated.
- **Godot import/live rock transfer is capped at 50,000 instances.** The
  sidecar preserves collision-bearing rocks first and reports `truncated`, but
  the addon refuses a truncated baseline rather than silently installing
  incomplete collision. Larger generated/exported populations remain valid for
  non-Godot consumers; paging is not implemented.
- **The loopback sidecar trusts the local OS account.** It has no bearer-token
  authentication and accepts native clients without an HTTP `Origin`, so it is
  suitable only when other users/processes on the same host are trusted. Do not
  run it on a shared or hostile multi-user machine under an account whose files
  those processes must not access.

## Citing

If you use this software, please cite it via [`CITATION.cff`](CITATION.cff)
(Storey, McCardle & Imtiaz, *lunar-terrain-sidecar*, v0.2.0, MIT). A JOSS software paper
draft is in [`paper/paper.md`](paper/paper.md). Please also credit the data:
LOLA (Smith et al. 2010), the PGDA polar DEMs (Barker et al. 2021), and JPL
DE440 (Park et al. 2021).

## Layout

```
packages/   shared-types terrain-core lunar-solar lunar-dem
            lunar-features terrain-pipeline terrain-export
            terrain-validation terrain-protocol
apps/       headless-server (CLI + JSON-RPC sidecar)
            interactive-ui  (Three.js authoring UI)
godot/      addon/lunar_terrain (loader, sidecar client, editor dock, plugin)
            example-project     (round-trip + integration harnesses)
examples/   south_pole_site_01
docs/       decisions/
tests/      345 tests across 17 files
```
