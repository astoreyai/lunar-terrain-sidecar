# Terrain generation model

Scope: the generation pipeline stage by stage, the published literature models it implements with their citations exactly as recorded in the code and in every export's provenance block, the de-confliction rule that keeps measured and synthetic content from double-counting, and the parts that are synthetic and labelled as such. Sources of truth: `packages/terrain-pipeline/src/generate.ts` (the pipeline), `packages/lunar-features/src/craterModels.ts` / `craters.ts` / `rocks.ts` (feature models), `packages/terrain-core/src/noise.ts` (procedural relief), `packages/lunar-dem/src/sample.ts` (DEM ingestion). Determinism of every stage is covered in [reproducibility.md](reproducibility.md); the artifacts in [export-formats.md](export-formats.md).

## Pipeline

`generateTerrain` (`terrain-pipeline/src/generate.ts`) runs these stages, which are also the progress-event names on the wire ([protocol.md](protocol.md)):

| Stage | Progress | What happens |
|---|---|---|
| `validating` | 0.00 | `estimate` + `assertFeasible` — cost and limits checked before any allocation |
| `allocating` | 0.02 | layers allocated; **bounds derive from the sample grid**, not the requested extent (a non-divisible extent is snapped and noted, preventing a phantom no-data strip) |
| `ingesting_dem` | 0.05 | real DEM opened, resampled to each configured layer, no-data filled by neighbour averaging; missing DEM ⇒ hard `TERRAIN_DEM_UNAVAILABLE`, never a synthetic fallback |
| `base_relief` | 0.20 | regional slope + procedural noise stack (fbm / ridged / warped_fbm), wavelength-gated against the DEM (below) |
| `generating_craters` | 0.35 | population sampling + stamping, per layer |
| `regolith_microrelief` | 0.55 | centimetre-scale fbm on layers fine enough to carry it |
| `generating_rocks` | 0.65 | rock population on the finest layer only |
| `classifying` | 0.80 | slope-based semantic defaults where no feature already classified a sample |
| `solar_geometry` | 0.90 | ephemeris (or flagged manual) solar conditions + horizon profile |
| `complete` | 1.00 | dataset assembled with full provenance |

Cancellation is checked between stages (`checkAborted`). Layer roles are `context / mission / operational`; the nested-tier model exists because 1 km² at 0.01 m would be 1e10 samples (`shared-types/src/terrain.ts`).

## Measured base: the DEM

Elevations come from real LOLA/PGDA products (PDS3 `.img`+`.lbl` or GeoTIFF, `lunar-dem`). Ingestion resamples into the local tangent frame, rebases to the window-mean datum and removes spherical curvature ([coordinate-system.md](coordinate-system.md)). Layers grounded in a DEM get `elevationProvenance: 'measured_dem'` and an `elevation_source` mask filled `measured`; the source product is recorded as a `DataSource` with its citation. Oversampling is reported, not hidden: when a layer samples finer than the source, the note states that between-pixel elevations are interpolated, not measured.

## De-confliction rule: synthesis only below what the measurement resolves

The single rule that keeps real and synthetic content from double-counting, applied three times:

1. **Noise stack.** For a DEM-grounded layer, procedural layers whose wavelength `1/frequency` is **not** below the DEM's effective resolution are suppressed — the measured elevations are already authoritative at those scales (`generate.ts`, `activeStack` filter; each suppression is noted). A layer that receives sub-resolution detail is promoted to `elevationProvenance: 'measured_dem_plus_synthetic_subresolution'`.
2. **Craters.** `sampleCraterPopulation` caps the maximum synthesised diameter at `demEffectiveResolutionM` — craters at or above it are already present in the measured elevations (`craters.ts`, with an explanatory note in the output; if the cap falls at or below the minimum diameter, **no** craters are synthesised). The minimum diameter is additionally raised to 4 grid samples per layer (`generate.ts`), below which a crater cannot be represented.
3. **Effective vs grid resolution.** `sourceEffectiveResolutionMeters` is distinct from the product's pixel size: a 5 m/px product typically resolves features only at ~15–20 m (an operator-supplied per-product input, not a constant: the shipped 17.5 m equals 3.5x grid spacing, consistent with the products' feature-resolving scale; deriving it per site from LOLA track density / the Barker et al. 2021 error analysis would tighten it) (`terrain.ts`). It defaults to 3× the grid spacing when not configured (`DemSourceSchema`, `config.ts`).

## Crater model (literature-anchored)

Citations exactly as recorded in `craterModels.ts` and emitted into `provenance.literatureModels`:

- Neukum, Ivanov & Hartmann (2001), "Cratering records in the inner solar system in relation to the lunar reference system", *Space Science Reviews* 96:55–86 — production function polynomial and chronology.
- Xiao & Werner (2015), "Size-frequency distribution of crater populations in equilibrium on the Moon", *JGR Planets* 120:2277–2292 — empirical equilibrium (saturation) density.
- Pike (1977), "Size-dependence in the shape of fresh impact craters on the Moon", in *Impact and Explosion Cratering*, 489–509 — simple-crater depth/diameter and rim height.
- Stopar et al. (2017), "Relative depths of simple craters and the nature of the lunar regolith", *Icarus* 298:34–48 — shallowing of d/D below ~400 m.
- McGetchin, Settle & Head (1973), "Radial thickness variation in impact crater ejecta", *EPSL* 20:226–236 — ejecta blanket thickness.

**Population density** (`model: production_csfd`, the default):

- Neukum production at 1 Ga: `log10 N(≥D) = Σ aᵢ (log10 D)ⁱ` with the 12 published coefficients (`NEUKUM_COEFFICIENTS`), valid 0.01–300 km. Below the 10 m floor the curve is **continued as a power law with the polynomial's own slope at the floor** (`productionDensityExtended`) — an extrapolation, explicitly flagged, because evaluating a degree-11 polynomial outside its fit diverges and clamping would understate sub-metre counts by orders of magnitude.
- Chronology scaling: `N(1, T) = 5.44e-14 (e^{6.93 T} − 1) + 8.38e-4 T` (`neukumChronology`) — exponential Late Heavy Bombardment term plus a linear recent flux; density scales by `N(1, T)/N(1, 1)`.
- Equilibrium cap (Xiao & Werner): `n(≥D) = 0.084 D⁻²` (`EQUILIBRIUM_COEFFICIENT`), scale-free. The realised density is `min(production, equilibrium)` (`cappedCumulativeDensityPerM2`) — the cap is what stops an old surface from receiving a physically impossible number of small craters.
- Sampling: 48 log-spaced diameter bins, expected count per bin = cumulative-density difference × area, Poisson-realised; optional clustering and exclusion-radius rejection (`sampleCraterPopulation`). The `power_law` model remains available with the density anchored at the *configured* minimum diameter so the same config realises the same density on every layer resolution (`powerLawAnchorDiameterM`).

**Morphometry** (`makeCrater`, `craterProfile`):

- Fresh depth/diameter: Pike's 0.2 above 400 m; Stopar's shallowing to ~0.11 at metre scale. The branch below 400 m is a **log-linear interpolation between those two published endpoints, not a coefficient from either paper** — flagged as such in `freshDepthDiameterRatio`.
- Fresh rim height: **Pike (1977) `h_r = 0.036 D^1.014`, both in kilometres** (`PIKE_RIM_COEFFICIENT`, `PIKE_RIM_EXPONENT`). The exponent is near 1 but not 1: the earlier flat-4% shorthand overshot the source by ~14% across the 1–400 m range (3.51 m vs 4.0 m at D = 100 m), and at grazing polar sun a rim's shadow length scales directly with its height.
- Ejecta: McGetchin `t(r) = 0.14 R^0.74 (r/R)^{−3}` for r ≥ R (`mcgetchinEjectaThickness`); the stamp is bounded where the blanket drops below 1 mm (`ejectaExtent`).
- Degradation infills the cavity and rounds the rim, rim faster than floor: depth × `(1−deg)^1.2`, rim height × `(1−deg)^2.2`, floor radius and rim width grow with degradation (`makeCrater`).
- Profile: flat floor, parabolic wall, Gaussian rim crest, McGetchin ejecta tail (`craterProfile`); stamping reports excavated/deposited volumes, which do **not** balance exactly and are reported rather than enforced (`stampCrater`).
- Central peaks only above the ~15 km simple-to-complex transition (`SIMPLE_TO_COMPLEX_TRANSITION_M`) — effectively never for synthesised sub-resolution craters; the flag exists for authored large craters.

## Rock model (Golombek)

Citation as recorded in `rocks.ts` / provenance: Golombek & Rapp (1997), *JGR* 102:4117–4129; Golombek et al. (2003), *JGR* 108:8086.

- Cumulative **area** fraction covered by rocks ≥ D: `F(D) = k·exp(−q(k)·D)`, `q(k) = 1.79 + 0.152/k`, with `k` the total area fraction (config `cumulativeFractionalAreaCovered`, default 0.06; typical lunar terrain k ≈ 0.03–0.10). Note the distinct diameter regimes: Diviner rock abundance (Bandfield et al. 2011) counts ~metre-scale rocks (typically 0.2–1% areal fraction), while k here is cumulative coverage down to small diameters — the two are not directly comparable.
- Number density derived, not shortcut: `n(D) = 4kq·e^{−qD}/(πD²)` (`golombekNumberDensity`), integrated numerically for cumulative counts (`golombekCumulativeCount`) — the common `F(D)/(πD²/4)` shortcut overestimates steep distributions and is deliberately avoided.
- **Rim-excess construction** (`sampleRockPopulation`): the background population is placed everywhere at the *full calibrated density*, and crater rims receive **additional** rocks — `(craterRimEnhancement − 1) ×` the background density over annuli 0.9R–1.4R, annulus picked area-weighted, position uniform in the annulus. The previous construction thinned off-rim rocks to 1/enhancement, silently dividing the configured global coverage by the enhancement factor (k = 0.06 realised ~0.015); rim blockiness is physically *excess* ejecta, not suppression of the background.
- Rejection: rocks on slopes steeper than `maximumSlopeDeg` (default 35°) are rejected and counted in the notes. Within-bin diameters are drawn from the active model's own distribution (exact inverse of `e^{−qD}` for Golombek — the power-law exponent must stay inert in Golombek mode).
- Rocks are **instances, not heightfield stamps** — a heightfield cannot represent an overhang or underside — placed on the finest layer only (per-layer placement would duplicate each boulder at three resolutions), as ellipsoids with angularity-widened axis ratios, Shoemake-uniform random orientation, and a buried fraction; `y = ground + semiAxisY·(1 − 2·buriedFraction)` (`toRockFeature`; the same relation the server uses to re-seat rocks after edits). Rocks ≥ `physicalMinimumDiameterMeters` get collision geometry.
- Pre-generation rock **estimates are background expectations (rim excess adds on top; slope rejection subtracts)** — taken before slope and rim-density rejection, which depend on terrain not yet generated (`terrain-core/src/estimate.ts`).

## Regolith microrelief

Centimetre-scale fbm (4 octaves) with configured RMS amplitude (default 0.01 m) and wavelength (default 0.35 m), applied **only** to layers at or finer than `maximumResolutionMeters` (default 0.1 m) — coarser grids cannot represent it and stamping it there would alias (`RegolithConfigSchema`, `config.ts`; `generate.ts`).

## Semantic classification

Samples not already classified by a feature (crater floor/wall/rim, rock field) get slope-based defaults: > 25° `unsafe_slope`, > 8° `rough_regolith`, else `flat_regolith` (`generate.ts`). Class encoding in [export-formats.md](export-formats.md).

## Solar geometry and horizon

Ephemeris mode computes real az/el from site + epoch ([ADR 0001](decisions/0001-solar-model.md)); manual mode is honoured but flagged `manual_override` in provenance with a limitation statement, and a warning fires for physically unattainable polar elevations (> 2° above |lat| 85°). The horizon is ray-marched over the **widest** layer (note: also a far-field truncation — relief beyond the widest layer cannot shadow the site, so illumination studies need a context layer sized to the real skyline distance, tens of km at polar sites) (a 30 m patch cannot see its own skyline), with curvature *not* re-applied — layers are tangent planes ([coordinate-system.md](coordinate-system.md)).

## Static terramechanics assessment (Bekker–Wong)

`terrain.getTraversability` defaults to a model-based static assessment (`packages/lunar-terramech`, [ADR 0005](decisions/0005-terramechanics.md)) in place of the hand-weighted heuristic, which remains available as `model: 'heuristic'` and rides inside every default response for comparison.

Per queried point, from the finest covering layer's own local slope: Bekker equilibrium sinkage `z = (p / (k_c/b + k_φ))^(1/n)` under Wong's flat-plate contact simplification, compaction resistance `R_c = b·k·z^(n+1)/(n+1)`, Mohr–Coulomb maximum thrust `H = A·c + W·tan(φ)`, gradient resistance `m·g·sin(θ)`, net drawbar pull `DP(θ) = H − R_c − R_g`, and the slope margin where DP reaches zero — **32.6°** for the sourced parameters and the reference vehicle (450 kg VIPER-class, 4 wheels, b = 0.20 m, r = 0.25 m). Classes: `go` (DP > 20 % of thrust), `marginal`, `no-go` (DP ≤ 0 or sinkage > half the wheel radius).

Citations exactly as recorded in `parameters.ts` and the provenance block: Bekker (1969), *Introduction to Terrain-Vehicle Systems*; Wong (2008), *Theory of Ground Vehicles*; Janosi & Hanamoto (1961) — shear law whose full-slip asymptote the static thrust is; Ishigami et al. (2007), *J. Field Robotics* 24(3) — the drawbar decomposition for planetary rovers; Mitchell et al. (1972), Proc. Third Lunar Sci. Conf. — Apollo in-situ ranges the point values are asserted against in tests; NASA LTV terramechanics white paper, NTRS 20220010732 — the parameter set (k_c = 1400, k_φ = 820 000, n = 1.0, c = 170 Pa, φ = 35°).

**Static only** (spec §33, [ADR 0003](decisions/0003-ui-and-dock-are-protocol-clients.md), [ADR 0005](decisions/0005-terramechanics.md)): no slip time-histories, no deformable contact, no dynamic wheel–soil simulation — the physics authority owns dynamics. And **not validated**: parameters are equatorial-Apollo/simulant-derived, no polar site has in-situ measurements, and every response carries that provenance block.

## What is synthetic, and labelled as such

Emitted verbatim into `provenance.syntheticHeuristics` / `limitations` of every export (`generate.ts`, `server.ts`):

- **Centimetre microrelief** — no measurement constrains lunar roughness at centimetre scale at these sites; plausible texture, not observed topography.
- **Traversability / slope / roughness classes** — the pipeline's semantic classification and the UI overlay remain hand-weighted heuristics (`traversabilityAt` in `server.ts` carries the label in every response where it is used). The RPC's default is now the static Bekker–Wong assessment above — a sourced model, but an **unvalidated extrapolation at polar sites**, and its provenance block says so; the heuristic result is embedded in every bekker response, still labelled.
- **Sub-DEM crater and boulder populations** — statistically anchored to the published SFDs above, but individual features are sampled, not observed.
- **Fully synthetic sites** (no DEM configured) carry the limitation "all elevations in this dataset are procedurally synthesised".

The per-sample `elevation_source.r8` mask ([export-formats.md](export-formats.md)) records measurement vs synthesis at sample granularity. If a configured DEM is missing, generation fails; there is no synthetic fallback.

## Two regolith densities, on purpose

Construction cut/fill mass accounting uses **1500 kg/m³** (config
`bulkDensityKgM3`, default 1500): excavated, loosened spoil at the low end
of the Apollo bulk-density range. The terramechanics soil parameter set uses
**1660 kg/m³** (ADR 0005, NTRS 20220010732): *in-situ* consolidated regolith
under a wheel. Both sit inside Mitchell et al. (1972)'s measured 1500–1750
kg/m³ span; they differ because disturbed spoil and undisturbed surface are
different states of the same material.
