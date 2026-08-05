# Reproducibility

Scope: the determinism model — how random streams are derived and consumed, which arithmetic is exactly specified and which is not, what the `reproduce` gate checks and what "byte-identical" means, what invalidates a reproduction, and the configuration hash. Sources of truth: `packages/terrain-core/src/rng.ts` (seed tree, PRNG), `packages/terrain-core/src/noise.ts` (exact-arithmetic noise core), `packages/terrain-pipeline/src/generate.ts` (`configurationHash`, seed-channel usage), `apps/headless-server/src/cli.ts` (`cmdReproduce`), `packages/shared-types/src/provenance.ts`. Artifacts and checksums are described in [export-formats.md](export-formats.md).

## Seed tree

Every generator draws from its **own named stream**, derived from the master seed by string hash (`deriveSeed` in `rng.ts`):

```
deriveSeed(master, channel) = FNV-1a-64(`${master} ${channel}`)   → 16 hex chars
```

The hash is FNV-1a 64-bit, carried as two 32-bit lanes multiplied with 16-bit limbs so every intermediate stays in JavaScript's exact-integer range (`hashString`). Because derivation depends only on the master seed and the channel *name* — not on how many generators exist or the order they run — **adding a generator never perturbs the streams of existing ones**: regenerating a site after adding rocks leaves the craters byte-identical.

Channels actually derived by the pipeline (`generate.ts`):

| Channel | Consumer |
|---|---|
| `procedural:<layerSpecId>` | noise stack permutation table per procedural layer |
| `procedural-warp:<layerSpecId>` | domain-warp noise per procedural layer |
| `crater:<layerId>` | crater population per terrain layer |
| `regolith:<layerId>` | microrelief noise per terrain layer |
| `rock` | the single rock population (finest layer only) |

The `SeedTree` records every channel actually used, and the sorted manifest lands in `provenance.seeds.derived` of every export, so a configuration can be replayed exactly and audited (`SeedTree.manifest()` in `rng.ts`; `provenance.ts`).

## The PRNG

`Rng` (`rng.ts`) is **xoshiro128\*\*** (2^128 period), seeded from the channel hash through a SplitMix-style avalanche with 16 warm-up discards so nearby seeds decorrelate. Chosen over an LCG because LCG low bits are weak and `rand() < p` decisions would show as grid-aligned scatter. Derived draws:

- `next()` — uniform [0,1) with a fully populated 53-bit mantissa (two raw draws).
- `normal()` — polar Box–Muller with a spare. The rejection loop consumes a *variable* number of raw draws; this is safe because each generator owns its own stream, so consumption in one channel can never shift another.
- `poisson(λ)` — Knuth's product method below λ = 30 (exact), normal approximation above (accurate to well under one count there).
- `powerLaw(min, max, α)` — inverse transform on the truncated power law.

## Exactly specified vs avoided arithmetic

Two tiers, and the distinction matters for cross-platform claims:

- **Exact tier — seeding and the noise core.** `hashString`/`deriveSeed`/`Rng` use only integer operations and IEEE-754 add/multiply/divide, which the standard specifies exactly. `PerlinNoise2D` and the fractal stacks (`noise.ts`) use only integer ops and IEEE add/subtract/multiply: gradients are the 8 unit-ish diagonals/axes so dot products are exact sums (**no trigonometry**), and `Math.pow` is deliberately avoided in the octave loops — frequency/amplitude ladders are built by repeated multiplication. This tier is bit-reproducible across engines and platforms by construction (`noise.ts` header).
- **Transcendental tier — feature models and the ephemeris.** The crater/rock/solar models legitimately use `Math.exp`, `Math.log`, `Math.pow`, `Math.sin` etc. (e.g. the Neukum polynomial in `lunar-features/src/craterModels.ts`, the Golombek exponential in `rocks.ts`, the Meeus series in `lunar-solar`). Transcendental functions are *not* exactly specified by IEEE-754; their rounding may differ between JS engines and libm builds. `Math.sin`/`Math.pow` are kept out of the seeding and noise paths (`rng.ts` header) but not out of these models.

Consequence, stated precisely: byte-identical reproduction is **guaranteed by construction for the noise core**, and **verified empirically for the whole pipeline on a fixed platform** (same Node build, same machine — the README records 183/183 artifacts byte-identical for the demonstration site). Cross-engine bit-identity of the transcendental tier is plausible but not proven by the standard; treat a reproduction on a different engine or libm as something to *check with the gate below*, not assume.

## The reproduce gate

```
npm run terrain -- reproduce <config.json>
```

`cmdReproduce` (`cli.ts`):

1. Loads and validates the config; requires a prior export's `manifest.json` in the config's `outputDirectory` (exits 2 otherwise: "run `npm run terrain -- generate` first").
2. Regenerates the full dataset and re-exports into a scratch directory `<outputDirectory>/.reproduce`, leaving the original untouched.
3. Compares the SHA-256 of **every artifact** in the new export against the prior manifest's `artifacts` list, path by path.
4. Prints the current `configurationHash` next to the prior one, the matched count, any paths missing from the prior export, and up to 20 mismatched paths. Exit code 1 on any mismatch; `reproduced byte-for-byte.` when all artifacts match and none are missing.

**What "byte-identical" covers:** everything in `artifacts[]` — every heightfield raster (rf32/EXR/PNG/npy), every mask, every GLB tile, craters.json, rocks.json, horizon.json. **What it excludes:** `manifest.json` and `checksums.sha256` themselves, which are not artifact entries — deliberately, since `provenance.generatedAt` is a wall-clock timestamp and makes the manifest byte-unstable across runs while every physics-bearing byte is stable.

## configurationHash

`configurationHash(config)` (`generate.ts`) is the SHA-256 of the **canonicalised** configuration: JSON serialisation with object keys recursively sorted (`canonicalJson`), applied to the *parsed* config — i.e. after Zod has filled every default (`parseConfig`, `config.ts`), so two configs that differ only in spelled-out defaults hash identically. It is stored in `provenance.configurationHash` of every export and echoed by `reproduce`, making "same configuration" a checkable claim rather than an assumption.

## What invalidates a reproduction

| Change | Effect |
|---|---|
| Master seed or any config field | different streams / different terrain; detected by `configurationHash` |
| **Generator version** (`GENERATOR_VERSION`, `terrain-pipeline/src/generate.ts`, currently `0.1.0`) | any algorithm change legitimately changes bytes; the version is recorded in `provenance.generator.version` and announced in the protocol hello — compare it before expecting byte-identity across builds |
| Source DEM file content | measured elevations change; `DataSource.sha256` (`provenance.ts`) exists to detect a stale input, though the pipeline does not currently populate it (field is optional) |
| JS engine / libm differences | can perturb the transcendental tier (see above); run the gate, don't assume |
| Interactive edits (`terrain.applyOperation`) | not part of `generate` reproduction at all — edits are separate replayable, checksum-chained delta records ([protocol.md](protocol.md)); `reproduce` regenerates the *un-edited* terrain from config + seed |

Renaming a seed channel or reordering channel *derivation* does not matter (derivation is by name); renaming a **layer id or procedural-stack id** does, because channel names embed them (`crater:<layerId>`, `procedural:<id>`).

## Committed oracle

`examples/south_pole_site_01/expected-checksums.sha256` is the checked-in
copy of the demonstration site's per-artifact SHA-256 list (183 entries).
`npm run terrain -- reproduce` compares a fresh generation against the
export it just made; this file lets a reader verify the *authors'* bytes —
diff it against your own `generated/south_pole_site_01/checksums.sha256`.
Note the configuration hash covers `dem.path`, so editing that path for
your machine changes the config hash but not the terrain bytes; the
checksums here are the byte-level ground truth.
