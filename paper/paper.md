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
  - name: Aaron W. Storey
    orcid: 0009-0009-5560-0015
    affiliation: 1
  - name: John McCardle
    orcid: 0009-0000-7044-4211
    affiliation: 2
  - name: Masudul H. Imtiaz
    orcid: 0000-0001-5528-482X
    affiliation: 3
affiliations:
  - name: Department of Computer Science, Clarkson University, Potsdam, NY, United States
    index: 1
  - name: Independent Researcher, United States
    index: 2
  - name: Department of Electrical and Computer Engineering, Clarkson University, Potsdam, NY, United States
    index: 3
date: 3 August 2026
bibliography: paper.bib
---

# Summary

`lunar-terrain-sidecar` generates, authors, and preprocesses lunar
south-polar terrain for a Godot-based robotics simulation. It is
deliberately not a physics engine: it produces heightfields, feature
manifests, semantic masks, and solar geometry as a sidecar process; the game engine remains the simulation authority. Elevations come from real
LOLA/PGDA measurements [@smith2010lola; @barker2021south]; the pipeline
synthesizes only below what the measurement resolves, and every exported
sample carries a per-sample provenance mask recording whether it is
measurement or synthesis, including synthetic craters and microrelief
stamped into DEM-grounded layers. Crater and rock populations are anchored
to published models: the Neukum production function [@neukum2001] capped by
empirical equilibrium [@xiao2015], with sub-10 m diameters continued by a disclosed slope extrapolation (the equilibrium cap governs that regime on ancient surfaces); Pike/Stopar morphometry [@pike1977;
@stopar2017]; McGetchin ejecta [@mcgetchin1973]; and the Golombek rock SFD
[@golombek1997; @golombek2003]. The Golombek form is calibrated on Mars and
Earth-analog sites and anchored to the Moon via Surveyor-era counts. Areal
coverage is a user parameter; Diviner rock-abundance values, which count
meter-scale rocks, are typically well below the demonstration coverage
[@bandfield2011]. Solar elevation and azimuth are never free parameters:
they come from a real ephemeris, either a Meeus/IAU analytic chain
[@meeus1998; @archinal2011; @archinal2011erratum] by default or JPL DE440
kernels [@park2021] read by a dependency-free TypeScript SPICE-subset
reader. (A debugging override exists, recorded as `manual_override` with a stated limitation.) Generation is deterministic:
regenerating the shipped demonstration site from its configuration and seed
reproduces all 183 exported artifacts byte-for-byte.

# Statement of need

At a lunar pole the Sun never rises more than about 1.54° above the horizon: the Moon's spin axis is inclined only 1.5424° to the
ecliptic [@archinal2011]. Shadow length scales as
$1/\tan(\text{elevation})$, so a 1 m rock throws a 38 m shadow, and crater
interiors can be permanently shadowed. Polar illumination is therefore a
function of *topography and date*: a "sun angle slider" cannot produce
physically consistent elevation/azimuth pairs. Polar rover simulation needs
measured topography of the actual site, statistically defensible
sub-resolution detail, and illumination locked to an ephemeris, all at
once. It serves planetary-robotics simulation developers, lunar surface-operations researchers, and mission-planning tool builders. \autoref{fig:sweep} shows what that
geometry does to the shipped demonstration site: across one lunar day the
Sun's azimuth sweeps the full compass while its elevation stays within a
0.8°–1.9° band, so the same terrain presents entirely different shadow fields as the date changes.

![The demonstration site (real PGDA Site01 DEM, 89.46°S) rendered by the
authoring UI at four ephemeris epochs between 2025-12-22 and 2026-01-13.
Solar elevation stays between 0.88° and 1.68° while azimuth rotates from
290° through 201° and 111° to 22°; shadow direction and length follow the
epoch, never a manual light setting.\label{fig:sweep}](figures/solar-sweep.png)

OmniLRS [@richard2024omnilrs] already imports LRO-derived DEMs and positions the Sun from ephemerides
(see *Comparison to related work*). `lunar-terrain-sidecar` contributes the
guarantees around those inputs: per-sample measurement-versus-synthesis
provenance, feature populations traceable to specific published models and
de-conflicted against the DEM's resolving power, a checksummed
byte-reproducibility contract with deterministic edit replay, and a numerically verified round trip into a real engine.

# Functionality

A JSON configuration describes a site: nested layers (e.g., a 1 km context
layer at 2 m resolution, a 200 m mission layer at 0.2 m, and a 30 m
operational layer at 1 cm), a selenographic anchor on a PGDA 5 m/px polar
DEM, crater/rock model parameters, and a UTC epoch. If a configured DEM is
missing, generation fails with a structured error rather than substituting
invented elevations. Synthesis is confined below a per-product *effective
resolution* supplied by the operator and recorded in provenance (17.5 m for
the shipped 5 m/px example). The pipeline exports heightmaps (float32 raw, EXR, PNG16, npy), GLB meshes, tiles, semantic and
elevation-source (per-sample provenance) masks, and manifests with
per-artifact SHA-256 checksums. By default the pipeline ray-marches
terrain-shadow horizons over the widest configured layer, bounding skyline
fidelity to its extent. An opt-in far-field mode also marches the LOLA 120 m/px polar product along great circles to 100 km, the reference method for long-range polar horizons [@mazarico2011], merging the two skylines by per-bin maximum: distant relief can raise a horizon, never lower it. Rendered shadows still come from layer geometry alone; horizon and illumination queries can carry the far field.

Three interfaces surround that core:

- **A JSON-RPC 2.0 sidecar server** (WebSocket) exposes generation, tile
  streaming, querying (elevation, slope, semantic class, solar position),
  editing, snapshots, and sparse deltas for live engine synchronization.
- **A Godot 4 editor addon** drives generation from a dock and imports the
  artifacts into mesh + collision + rock multimesh scenes; it speaks the
  same protocol as the authoring UI, so physics-bearing data has exactly
  one implementation.
- **An interactive Three.js authoring UI** provides brushes (raise/lower,
  smooth, flatten, slope, noise, semantic paint) and construction
  operations (ramps, pads, spoil piles, wheel tracks, polygonal cut/fill).
  Mass-conserving edits redistribute excavated material with measured
  balance, each edit yields a replayable, checksummed delta, and the
  pipeline records construction features with cut/fill volumes and mass
  (regolith bulk density 1500 kg/m³).

A static Bekker–Wong terramechanics assessment (`packages/lunar-terramech`)
answers traversability queries: equilibrium sinkage from Bekker
pressure–sinkage theory [@bekker1969] under Wong's flat-plate contact
simplification [@wong2008], maximum thrust as the full-slip asymptote of
the Janosi–Hanamoto shear law [@janosi1961], compaction and gradient
resistance, net drawbar pull, and the slope margin where drawbar pull
reaches zero, the screening quantities of terramechanics-based rover analysis [@ishigami2007]. Soil parameters are the published
NASA LTV modeling-and-simulation values [@li2022terramechanics], with
cohesion, friction angle, and density asserted by test to sit inside the
Apollo in-situ ranges of Mitchell et al. [@mitchell1972]. For a 450 kg
VIPER-class reference rover (four 0.20 m × 0.25 m wheels, 1.62 m/s²) the
model gives $\approx 13$ mm static sinkage, $\approx 460$ N flat-ground
drawbar pull, and a $\approx 33°$ slope margin. These are static upper bounds (full-slip thrust; Bekker's fuller wheel derivation, hand-derived in a decision record, lowers the margin by about 2.3° and *raises* sinkage to $pprox 18$ mm); operational planners cap traverses well below them. The Bekker–Wong assessment
replaced a hand-weighted heuristic, which remains available and labeled.
Two boundaries are stated explicitly. First, a provenance block travels
with every response, recording that the parameters are
equatorial-Apollo/simulant-derived; no polar site has in-situ soil
measurements, so applying them there is an extrapolation. Second, the
assessment is static by design (no slip time-histories, no deformable
contact): wheel–soil dynamics belong to the simulation authority,
deformable-terrain engines of the Project Chrono class [@tasora2016], not
the terrain tool.

# Validation and reproducibility

The test suite (257 tests across 15 files at v0.1.2) validates against an
authority outside the code wherever one exists. Suites that need the public
datasets, SPICE kernels, or a Godot binary skip loudly when those are absent; `scripts/fetch-data.sh` retrieves the data, and the README maps prerequisites to suites.

**Ephemeris versus physical invariants.** The analytic solar chain is
tested against nine independent properties of the Earth–Moon–Sun system
(`tests/lunar-solar.ephemeris.test.ts`):

| Invariant | Source of truth | Result |
|---|---|---|
| Sub-solar latitude confined to ±1.54° | lunar obliquity | max 1.59° |
| Sub-solar latitude period $\approx 346.6$ d | draconic year | passes |
| Sub-solar longitude period 29.5306 d, westward | synodic month, prograde rotation | passes |
| Solar elevation at −90° = −(sub-solar latitude) | geometric identity | agrees to $10^{-9}$ ° |
| Earth–Sun distance $\in$ [0.9833, 1.0167] au | perihelion/aphelion | passes |
| Earth–Moon distance $\in$ [356 400, 406 700] km | perigee/apogee | passes |
| Lunar ecliptic latitude $\leq$ 5.3° | orbital inclination | passes |
| New moon 2000-01-06 18:14 UTC | tabulated event | elongation < 0.1° |
| Synodic month from 791 lunations | 29.530589 d | < $10^{-4}$ d |

The table states physical invariants; committed assertions carry small padding (ecliptic latitude asserted below 5.4°, sub-solar confinement below 1.60°). The 1.59° maximum is not an error: pole libration and the Sun's offset from the lunar ecliptic let instantaneous sub-solar latitude exceed the mean obliquity.

**Measured accuracy against JPL's integrated ephemeris.** The DE440 reader
(validated to < $10^{-9}$ rad against a frozen `jplephem`/CSPICE reference)
provides the first direct measurement of the analytic chain's error:
sub-solar point separation of mean 0.0040°, maximum **0.0111°**, over 360
monthly epochs spanning 2020–2049. The sweep reproduces via `npm run terrain -- de-compare --months 360`, its maximum asserted in-suite below 0.012° when kernels are present; a denser development sweep measured 0.0118°. Both sit inside the documented 0.01–0.03° budget of the IAU frame realization.

**DEM ingestion versus GDAL.** Georeferencing, projection, and elevation
reads of the real LOLA/PGDA products are tested against the products' own
PDS labels and GDAL's independent reading, not fixtures.

**Engine round trip.** Raycasts against real Godot collision geometry at
145 probe points agree with the sidecar's elevations to a measured
**9.0 × $10^{-6}$ m** on-grid and 1.0 × $10^{-2}$ m off-grid (the expected
bilinear-versus-triangulated difference); the committed assertions gate at
2 × $10^{-3}$ m and 5 × $10^{-2}$ m. The addon lifecycle test measures
6 × $10^{-6}$ m agreement through collision over its 12 probes and 0.000%
cut/fill imbalance on a mass-conserving edit.

**Determinism.** Regenerating the shipped site reproduces **183/183
artifacts byte-identically** on a fixed platform and Node build;
cross-engine bit-identity is guaranteed by construction only for the noise core (`docs/reproducibility.md`). Edit logs replay bit-exactly onto a
regenerated site. Performance work is held to the same bar: an 8-thread
worker pool and algebraic optimizations of crater stamping and base relief
were each proven byte-exact against pre-optimization exports before being kept. The committed harness in `benchmarks/` records timings with
hardware context (the DEM-grounded demonstration stack, 10.3 M samples, generates in 3.8 s) and the per-change speedups with commit provenance.

# Comparison to related work

Agency-internal landing and surface-operations simulators are typically
closed-source. Among open environments, OmniLRS [@richard2024omnilrs] is
the closest relative: it imports LRO-derived DEMs at around 5 m/px,
positions the Sun and Earth from ephemerides, and
scatters rocks and craters from power-law distributions within Isaac Sim;
Gazebo moon worlds and other engine-native efforts provide rendering and
physics with varying terrain pipelines. `lunar-terrain-sidecar` differs not
in *having* measured DEMs or an ephemeris but in the four guarantees above: populations pinned to named models (Neukum
production capped by Xiao–Werner equilibrium; the Golombek SFD) rather than
generic power laws, and the engine round trip verified to
9.0 × $10^{-6}$ m. It complements renderers and physics stacks as their terrain and illumination authority, deferring wheel–soil dynamics to deformable-terrain engines such as Project Chrono [@tasora2016].

# Acknowledgements

This software builds on public NASA data products: LOLA altimetry from the
LRO mission [@smith2010lola], the LOLA-adjusted 5 m/px south-polar site
DEMs of the NASA GSFC Planetary Geodesy Data Archive [@barker2021south],
and the JPL DE440 planetary and lunar ephemerides [@park2021]. We validated
the DE440 reader against a frozen reference generated with `jplephem` and
CSPICE in the first author's `ephemkit` oracle environment, itself
independently checked against JPL Horizons.

# References
