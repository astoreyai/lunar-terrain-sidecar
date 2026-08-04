---
title: 'lunar-terrain-sidecar: reproducible lunar south-polar terrain from measured DEMs, literature-anchored surface features, and a real solar ephemeris'
tags:
  - lunar terrain
  - robotics simulation
  - digital elevation models
  - solar ephemeris
  - permanently shadowed regions
  - procedural generation
  - reproducibility
  - Godot
  - TypeScript
authors:
  - name: Aaron Storey
    orcid: 0009-0009-5560-0015
    affiliation: 1
affiliations:
  - name: Clarkson University, Potsdam, NY, United States
    index: 1
date: 3 August 2026
bibliography: paper.bib
---

# Summary

`lunar-terrain-sidecar` generates, authors, and preprocesses lunar
south-polar terrain for a Godot-based robotics simulation. It is
deliberately not a physics engine: it produces heightfields, feature
manifests, semantic masks, and solar geometry as a sidecar process, and the
game engine remains the simulation authority. Elevations come from real
LOLA/PGDA measurements [@smith2010lola; @barker2021south]; synthesis is
applied only below what the measurement resolves, and every exported sample
carries a provenance mask recording whether it is measurement or synthesis
(including synthetic craters and microrelief stamped into DEM-grounded
layers).
Crater and rock populations are anchored to published models — the Neukum
production function [@neukum2001] capped by empirical equilibrium
[@xiao2015] (sub-10 m diameters use a disclosed slope-continuation of the
polynomial; on ancient surfaces the equilibrium cap governs that regime),
Pike/Stopar morphometry [@pike1977; @stopar2017], McGetchin ejecta
[@mcgetchin1973], and the Golombek rock SFD [@golombek1997; @golombek2003]
— a form calibrated on Mars and Earth-analog sites (lunar anchoring via
Surveyor-era counts); areal coverage is a user parameter, and
Diviner-measured rock abundance across its mapped
latitudes is typically lower than the demonstration value [@bandfield2011]. Solar elevation
and azimuth are never free parameters (a debugging override exists, recorded as
`manual_override` in provenance with a stated limitation): they are computed from a real ephemeris — a Meeus/IAU analytic chain [@meeus1998; @archinal2011;
@archinal2011erratum] by default, or JPL DE440 kernels [@park2021] read by a
dependency-free TypeScript SPICE-subset reader. Generation is deterministic:
regenerating the shipped demonstration site from its configuration and seed
reproduces all 183 exported artifacts byte-for-byte.

# Statement of need

At a lunar pole the Sun never rises more than about 1.54° above the
horizon, because the Moon's spin axis is inclined only 1.5424° to the
ecliptic [@archinal2011]. Shadow length scales as
$1/\tan(\text{elevation})$ — a 1 m rock throws a 38 m shadow — and crater
interiors can be permanently shadowed. Polar illumination is therefore a
function of *topography and date*: a "sun angle slider" cannot produce
physically consistent elevation/azimuth pairs. Polar rover simulation needs
measured topography of the actual site, statistically defensible
sub-resolution detail, and illumination locked to an ephemeris — at once.

Parts of this exist in open tools — OmniLRS [@richard2024omnilrs], notably,
imports LRO-derived DEMs and positions the Sun from ephemerides (see
*Comparison to related work*). What `lunar-terrain-sidecar` contributes is
the set of guarantees around those inputs: per-sample
measurement-versus-synthesis provenance, feature populations traceable to
specific published models and de-conflicted against the DEM's resolving
power, a checksummed byte-reproducibility contract with deterministic edit
replay, and a numerically verified round trip into a real engine rather than
stopping at file export.

# Functionality

A site is described by a JSON configuration: nested layers (e.g., a 1 km
context layer at 2 m resolution, a 200 m mission layer at 0.2 m, and a 30 m
operational layer at 1 cm), a selenographic anchor on a PGDA 5 m/px polar
DEM, crater/rock model parameters, and a UTC epoch. If a configured DEM is
missing, generation fails with a structured error rather than substituting
invented elevations. Synthesis is confined below a per-product *effective resolution* supplied
by the operator and recorded in provenance (17.5 m for the shipped 5 m/px
example) — a stated input, not a derived constant. The pipeline exports heightmaps (float32 raw, EXR,
PNG16, npy), GLB meshes, tiles, semantic and elevation-source masks, and
manifests with per-artifact SHA-256 checksums. Terrain-shadow horizons are
ray-marched over the widest configured layer, bounding skyline fidelity to
its extent: the shipped 1 km context is a demonstrator, and polar
illumination studies need context layers of tens of kilometres
[@mazarico2011].

Around that core:

- **A JSON-RPC 2.0 sidecar server** (WebSocket) exposes generation, tile
  streaming, querying (elevation, slope, semantic class, solar position),
  editing, snapshots, and sparse deltas for live engine synchronization.
- **A Godot 4 editor addon** drives generation from a dock and imports the
  artifacts into mesh + collision + rock multimesh scenes; it speaks the
  same protocol as the browser UI, so physics-bearing data has exactly one
  implementation.
- **An interactive Three.js authoring UI** provides brushes (raise/lower,
  smooth, flatten, slope, noise, semantic paint) and construction
  operations (ramps, pads, spoil piles, wheel tracks, polygonal cut/fill).
  Mass-conserving edits redistribute excavated material with measured
  balance, each edit yields a replayable, checksummed delta, and
  construction features are recorded with cut/fill volumes and mass
  (regolith bulk density 1500 kg/m³).

Traversability queries are answered by a static Bekker–Wong terramechanics
assessment (`packages/lunar-terramech`): equilibrium sinkage from Bekker
pressure–sinkage theory [@bekker1969] under Wong's flat-plate contact
simplification [@wong2008], maximum thrust as the full-slip asymptote of the
Janosi–Hanamoto shear law [@janosi1961], compaction and gradient resistance,
net drawbar pull, and the slope margin where drawbar pull reaches zero — the
screening quantities of terramechanics-based planetary-rover analysis
[@ishigami2007]. Soil parameters are the published NASA LTV
modeling-and-simulation values [@li2022terramechanics], asserted by test to
sit inside the Apollo in-situ ranges of Mitchell et al. [@mitchell1972]. For
a 450 kg VIPER-class reference rover (four 0.20 m × 0.25 m wheels, 1.62
m/s²) the model gives ≈13 mm static sinkage, ≈460 N flat-ground drawbar
pull, and a ≈33° slope margin — the thrust, drawbar-pull and
slope-margin figures are static upper bounds (full-slip thrust; Bekker's
fuller wheel derivation lowers the margin by ~2° and *raises* sinkage to
≈18 mm); operational planners cap lunar traverses well below such margins. This replaced a hand-weighted heuristic,
which remains available and labeled. Two boundaries are stated explicitly: a
provenance block travels with every response recording that the parameters
are equatorial-Apollo/simulant-derived — no polar site has in-situ soil
measurements, so applying them to polar sites is an extrapolation — and the
assessment is deliberately static (no slip time-histories, no deformable
contact) because wheel–soil dynamics belong to the simulation authority —
deformable-terrain engines of the Project Chrono class [@tasora2016] — not
the terrain tool.

# Validation and reproducibility

The test suite (239 tests across 13 files at v0.1.0) validates against
authorities outside the code wherever one exists.

**Ephemeris versus physical invariants.** The analytic solar chain is tested
against nine independent properties of the Earth–Moon–Sun system
(`tests/lunar-solar.ephemeris.test.ts`):

| Invariant | Source of truth | Result |
|---|---|---|
| Sub-solar latitude confined to ±1.54° | lunar obliquity | max 1.57° |
| Sub-solar latitude period ≈ 346.6 d | draconic year | passes |
| Sub-solar longitude period 29.5306 d, westward | synodic month, prograde rotation | passes |
| Solar elevation at −90° = −(sub-solar latitude) | geometric identity | agrees to 10⁻⁹ ° |
| Earth–Sun distance ∈ [0.9833, 1.0167] au | perihelion/aphelion | passes |
| Earth–Moon distance ∈ [356 400, 406 700] km | perigee/apogee | passes |
| Lunar ecliptic latitude ≤ 5.3° | orbital inclination | passes |
| New moon 2000-01-06 18:14 UTC | tabulated event | elongation < 0.1° |
| Synodic month from 791 lunations | 29.530589 d | < 10⁻⁴ d |

**Measured accuracy against JPL's integrated ephemeris.** The DE440 reader
(validated to < 10⁻⁹ rad against a frozen `jplephem`/CSPICE reference)
provides the first direct measurement of the analytic chain's error:
sub-solar point separation of mean 0.0040°, maximum **0.0111°** over 360
monthly epochs spanning 2020–2049 (reproducible via `lunar-terrain
de-compare --months 360`; a denser development-time sweep measured 0.0118°
maximum) — inside the documented 0.01–0.03° budget of the IAU frame
realisation.

**DEM ingestion versus GDAL.** Georeferencing, projection, and elevation
reads of the real LOLA/PGDA products are tested against the products' own
PDS labels and GDAL's independent reading, not against fixtures.

**Engine round trip.** Raycasts against real Godot collision geometry at 145
probe points agree with the sidecar's elevations to **9.0 × 10⁻⁶ m**
on-grid (1.0 × 10⁻² m off-grid, the expected bilinear-versus-triangulated
difference); the full addon lifecycle test measures 6 × 10⁻⁶ m agreement
through collision and 0.000% cut/fill imbalance on a mass-conserving edit.

**Determinism.** Regenerating the shipped site reproduces **183/183
artifacts byte-identically** (on a fixed platform and Node build;
cross-engine bit-identity is guaranteed by construction only for the noise
core — see `docs/reproducibility.md`); edit logs replay bit-exactly onto a
regenerated site. Performance work is held to the same bar: an 8-thread
worker pool (4.84× on the base-relief stage) and algebraic optimizations of
crater stamping (2.09×) and base relief (1.60×) were each proven byte-exact
against the pre-optimization exports before being kept, taking demonstration
site generation (10.3 M samples) from 16.3 s to 3.4 s. A benchmark harness
records measured timings with hardware context in `benchmarks/`.

# Comparison to related work

Agency-internal landing and surface-operations simulators are typically
closed-source. Among open environments, OmniLRS [@richard2024omnilrs] is the
closest relative: it imports LRO-derived DEMs at around 5 m/px, positions
the Sun and Earth from ephemerides for realistic lighting, and scatters
rocks and craters from power-law distributions within Isaac Sim; Gazebo moon
worlds and other engine-native efforts provide rendering and physics with
varying terrain pipelines. `lunar-terrain-sidecar` differs not in *having*
measured DEMs or an ephemeris but in what it guarantees about them:
per-sample measurement-versus-synthesis provenance masks; populations
traceable to specific published models (Neukum production capped by
Xiao–Werner equilibrium; the Golombek SFD) rather than generic power laws,
de-conflicted against the DEM's effective resolution; a checksummed
byte-reproducibility contract with deterministic edit replay; and an
engine-agnostic protocol whose round trip into a real engine is numerically
verified to 9.0 × 10⁻⁶ m. It is complementary to renderers and physics
stacks — the terrain and illumination authority they could consume — and
deliberately defers wheel–soil dynamics to deformable-terrain physics
engines such as Project Chrono [@tasora2016].

# Acknowledgements

This software builds on public NASA data products: LOLA altimetry from the
LRO mission [@smith2010lola], the LOLA-adjusted 5 m/px south-polar site DEMs
of the NASA GSFC Planetary Geodesy Data Archive [@barker2021south], and the
JPL DE440 planetary and lunar ephemerides [@park2021]. The DE440 reader was
validated against a frozen reference generated with `jplephem` and CSPICE in
the author's independently Horizons-checked `ephemkit` oracle environment.

# References
