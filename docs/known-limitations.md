# Known limitations

Scope: every limitation the system itself states — in module docstrings, capability declarations, provenance blocks, the README, and the ADRs — consolidated in one place. Each entry cites where the limitation is declared in source, so this file cannot silently diverge from the code that enforces or reports it. Dataset-specific limitations are additionally emitted into every export's `provenance.limitations` ([export-formats.md](export-formats.md)).

## Solar accuracy floor: the IAU frame realisation, 0.01–0.03°

The limiting error of the solar model is **not** the Meeus solar/lunar series (~0.01°) but the IAU/WGCCRE trigonometric realisation of the lunar Mean Earth / Polar Axis frame, which differs from a JPL DE-integrated libration by roughly **0.01–0.03°**. That propagates ~1:1 into solar elevation — a few percent of the entire ±1.54° polar elevation range; at 1° elevation a 0.03° error moves a shadow edge by ~3%. Declared in `packages/lunar-solar/src/lunarFrame.ts` (module docstring), [ADR 0001](decisions/0001-solar-model.md), and the limitation statement the pipeline writes into every ephemeris-mode export (`terrain-pipeline/src/generate.ts`). Upgrade path: a JPL DE kernel (DE440) plus a PA→ME rotation — rejected for now as a ~100 MB binary dependency (ADR 0001).

Related: `manual` solar mode is flagged `manual_override` in provenance and may be physically unreachable at the site; the pipeline warns when a polar config requests > 2° elevation (`generate.ts`).

## PSR determination needs 18.6 years of sampling

`permanentlyShadowed` in `illuminationStatistics` (`packages/lunar-solar/src/horizon.ts`) is only as good as the sampled epoch series: a true permanently-shadowed-region determination needs at least a full **18.6-year lunar nodal precession cycle**, because the sub-solar latitude envelope itself migrates. The function reports the span it was given; sampling one year and calling the result a PSR would overstate the finding. Also stated in the README.

## The browser viewport is a decimated preview

Layers stream to the UI at a stride bounding each to ~512 samples per edge (`PREVIEW_MAX_SIDE` in `apps/interactive-ui/src/main.ts`; `stride` parameter of `terrain.getTile`) — a 3001² operational layer is 36 MB of float32, 48 MB as base64. The rendered mesh is therefore **not** the authoritative surface: any value a user might act on (elevation, slope, semantic class, traversability) is queried from the sidecar, which holds the full-resolution field. Do not read measurements off the mesh. Declared in [ADR 0003](decisions/0003-ui-and-dock-are-protocol-clients.md) and the README; wire mechanics in [protocol.md](protocol.md).

## Undo is an inverse operation, not a snapshot

Undo re-applies the exact inverse of the recorded operation (`INVERTIBLE_KINDS` in `apps/interactive-ui/src/main.ts`). Only `raise↔lower` and `berm↔trench` are invertible from the stored record. **`smooth`, `flatten` and `crater_stamp` destroy information** — the pre-edit surface is not stored — so undoing them is refused with an explanation rather than corrupting the terrain further (an earlier fallback that re-applied the same operation stamped a second crater on top of the first). Recovery from a non-invertible edit is regeneration from config + seed ([reproducibility.md](reproducibility.md)).

## No GPU or WASM acceleration

CPU generation is the reference implementation and the only implementation. Declared machine-readably in `terrain.capabilities` → `notImplemented.gpuGeneration` (`apps/headless-server/src/server.ts`) and in `apps/headless-server/src/cli.ts` (spec §20). The README's measured demonstration site (10.3 M samples) generates in ~7 s on CPU.

## Heightfields only

No SDF or voxel patches; a heightfield cannot represent overhangs or undersides. Declared in `terrain.capabilities` → `notImplemented.volumetricTerrain`. This is also why rocks are instances rather than terrain (`packages/lunar-features/src/rocks.ts` header) — see [terrain-model.md](terrain-model.md).

## Off-grid collision agreement is ~1 cm

Godot triangulates each heightfield cell into two flat triangles while the sidecar interpolates bilinearly, so elevations *between* grid samples disagree by up to ~1.0e-2 m (measured, `tests/godot-roundtrip.test.ts`, README "Measured results"). On-grid agreement is 9.0e-6 m. The 1 cm figure is a property of the two interpolation schemes, not a bug to fix on either side.

## Little-endian loader assumption in the Godot addon

`_load_heights` in `godot/addon/lunar_terrain/lunar_terrain_loader.gd` reads `height.rf32` with `to_float32_array()`, which is **native-endian**; the file is little-endian per the manifest ([export-formats.md](export-formats.md)). Every platform Godot 4 ships on is little-endian, so these coincide — noted in the loader so a future big-endian port knows this is the line to fix.

## Single-session, single-dataset server model

The sidecar holds exactly one session with one dataset (`Session` in `apps/headless-server/src/server.ts`). One generation job runs at a time; while it runs, `terrain.generate`, `terrain.export` and `terrain.applyOperation` are refused with a structured error (`requireNoRunningJob`) rather than queued — two concurrent generates would race to install results, and an edit applied mid-generation would be acknowledged and then silently destroyed. A new generation clears the session's delta and operation logs. Multiple clients may connect (progress broadcasts to all), but they share the one dataset. See [protocol.md](protocol.md).

## Rock count estimates are upper bounds

`estimate` reports rock instance counts **before** slope and crater-rim-density rejection, which depend on terrain not yet generated (`packages/terrain-core/src/estimate.ts`; README). The realised count after rejection is lower and is reported in generation notes.

## Further declared limitations

- **Neukum extrapolation below 10 m.** The production polynomial is fitted over 0.01–300 km; below that the curve is continued as a power law with the polynomial's own boundary slope — an extrapolation, explicitly flagged, though the equilibrium cap governs that regime on old surfaces anyway (`packages/lunar-features/src/craterModels.ts`, `productionDensityExtended`). See [terrain-model.md](terrain-model.md).
- **Stopar interpolation.** The depth/diameter branch below 400 m is a log-linear interpolation between two published endpoints, not a fitted coefficient from either paper (`freshDepthDiameterRatio`).
- **Penumbra model is a heuristic.** `sunlitFraction` treats the horizon as a straight chord across a uniformly bright disc; real penumbral illumination depends on rim shape and limb darkening (`lunar-solar/src/horizon.ts`, labelled SYNTHETIC HEURISTIC).
- **Traversability is not terramechanics.** Slope + roughness hand-weighted into a 0–1 score; the label travels with every response and every export (`traversabilityAt` in `server.ts`; `provenance.syntheticHeuristics`).
- **Oversampled DEM layers interpolate.** A layer sampled finer than its source product contains interpolated, not measured, elevations between source pixels; reported per-layer in the generation notes (`generate.ts`).
- **Protocol-version enforcement is major-version only.** Both shipped clients (browser `rpc.ts`, Godot `sidecar_client.gd`) disconnect with an error when the sidecar's announced protocol **major** version differs from theirs (`CLIENT_PROTOCOL_MAJOR`). Minor/patch drift is tolerated by design; a breaking change within the same major would not be caught. See [protocol.md](protocol.md).
- **Cross-engine bit-reproducibility is proven only for the noise core.** Feature models and the ephemeris use transcendental functions whose rounding is engine-dependent; byte-identity is verified on a fixed platform by the `reproduce` gate. See [reproducibility.md](reproducibility.md).
