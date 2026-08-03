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
carries a provenance mask recording whether it is measurement or synthesis.
Crater and rock populations are anchored to published models — the Neukum
production function [@neukum2001] capped by empirical equilibrium
[@xiao2015], Pike/Stopar morphometry [@pike1977; @stopar2017], McGetchin
ejecta thickness [@mcgetchin1973], and the Golombek exponential rock
size-frequency distribution [@golombek1997; @golombek2003]. Solar elevation
and azimuth are never free parameters: they are computed from a real
ephemeris — a Meeus/IAU analytic chain [@meeus1998; @archinal2011;
@archinal2011erratum] by default, or JPL DE440 kernels [@park2021] read by a
dependency-free TypeScript SPICE-subset reader. Generation is deterministic:
regenerating the shipped demonstration site from its configuration and seed
reproduces all 183 exported artifacts byte-for-byte.

# Statement of need

At a lunar pole the Sun never rises more than about 1.54° above the horizon,
because the Moon's spin axis is inclined only 1.5424° to the ecliptic
[@archinal2011]. Shadow length scales as $1/\tan(\text{elevation})$, so a
1 m rock throws a 38 m shadow and crater interiors can be permanently
shadowed. Polar illumination is therefore a function of *topography and
date*, not a lighting preference — a "sun angle slider" cannot produce
physically consistent elevation/azimuth pairs, and renders illumination and
traverse studies meaningless. Simulation environments for polar rover work
consequently need three things at once: measured topography of the actual
site, statistically defensible sub-resolution detail, and illumination
locked to an ephemeris.

To the author's knowledge no open tool couples these. High-fidelity agency
simulators of the DSENDS and POST2 class are closed-source. Open robotics
stacks (Gazebo lunar worlds, Omniverse/Isaac Sim efforts such as OmniLRS
[@richard2024omnilrs], Unreal- and Unity-based lunar simulators) provide
rendering and physics but leave terrain provenance, feature-population
statistics, and solar geometry to the user. `lunar-terrain-sidecar` fills
this gap as an engine-agnostic terrain authority with an explicit,
checksummed reproducibility contract, and verifies the full round trip into
a real engine rather than stopping at file export.

# Functionality

A site is described by a JSON configuration: nested layers (e.g., a 1 km
context layer at 2 m resolution, a 200 m mission layer at 0.2 m, and a 30 m
operational layer at 1 cm), a selenographic anchor on a PGDA 5 m/px polar
DEM, crater/rock model parameters, and a UTC epoch. If a configured DEM is
missing, generation fails with a structured error rather than substituting
invented elevations. The pipeline exports heightmaps (float32 raw, EXR,
PNG16, npy), GLB meshes, tiles, semantic and elevation-source masks, and
manifests with per-artifact SHA-256 checksums.

Around that core:

- **A JSON-RPC 2.0 sidecar server** (WebSocket) exposes generation, tile
  streaming, querying (elevation, slope, semantic class, solar position),
  editing, snapshots, and sparse deltas for live engine synchronization.
- **A Godot 4 editor addon** drives generation from a dock, imports the
  artifacts into mesh + collision + rock multimesh scenes, and speaks the
  same protocol as the browser UI; both front ends are thin clients, so
  physics-bearing data has exactly one implementation.
- **An interactive Three.js authoring UI** provides brushes (raise/lower,
  smooth, flatten, slope, noise, semantic paint) and construction
  operations (ramps, pads, spoil piles, wheel tracks, polygonal cut/fill).
  Mass-conserving edits redistribute excavated material with measured
  balance, each edit yields a replayable, checksummed delta, and
  construction features are recorded with cut/fill volumes and mass
  (regolith bulk density 1500 kg/m³).

# Validation and reproducibility

The test suite (215 tests across 12 files at v0.1.0) validates against
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
sub-solar point separation of mean 0.0040°, maximum **0.0118°** over 360
monthly epochs spanning 2020–2049 — inside the documented 0.01–0.03° budget
of the IAU frame realisation.

**DEM ingestion versus GDAL.** Georeferencing, projection, and elevation
reads of the real LOLA/PGDA products are tested against the products' own
PDS labels and GDAL's independent reading, not against fixtures.

**Engine round trip.** Raycasts against real Godot collision geometry at 145
probe points agree with the sidecar's elevations to **9.0 × 10⁻⁶ m**
on-grid (1.0 × 10⁻² m off-grid, the expected bilinear-versus-triangulated
difference); the full addon lifecycle test measures 6 × 10⁻⁶ m agreement
through collision and 0.000% cut/fill imbalance on a mass-conserving edit.

**Determinism.** Regenerating the shipped site reproduces **183/183
artifacts byte-identically**; edit logs replay bit-exactly onto a
regenerated site. Performance work is held to the same bar: an 8-thread
worker pool (4.84× on the base-relief stage) and algebraic optimizations of
crater stamping (2.09×) and base relief (1.60×) were each proven byte-exact
against the pre-optimization exports before being kept, taking demonstration
site generation (10.3 M samples) from 16.3 s to 3.4 s. A benchmark harness
records measured timings with hardware context in `benchmarks/`.

# Comparison to related work

NASA's DSENDS (JPL) and POST2 (Langley) simulate landing and surface
operations at high fidelity but are not openly available. Open lunar
simulation environments — Gazebo moon worlds, OmniLRS on Isaac Sim
[@richard2024omnilrs], and Unreal-based efforts such as LunarSim — focus on
photorealistic rendering and robot integration, generally shipping fixed
terrain assets or engine-native procedural terrain without measured-data
provenance, population statistics traceable to the cratering literature, or
ephemeris-locked polar illumination. `lunar-terrain-sidecar` is complementary
to these: it is the terrain and illumination authority that such
environments could consume, with the additional guarantees of byte-level
reproducibility and a verified engine round trip.

# Acknowledgements

This software builds on public NASA data products: LOLA altimetry from the
LRO mission [@smith2010lola], the LOLA-adjusted 5 m/px south-polar site DEMs
of the NASA GSFC Planetary Geodesy Data Archive [@barker2021south], and the
JPL DE440 planetary and lunar ephemerides [@park2021]. The DE440 reader was
validated against a frozen reference generated with `jplephem` and CSPICE in
the author's independently Horizons-checked `ephemkit` oracle environment.

# References
