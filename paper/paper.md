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
date: 14 August 2026
bibliography: paper.bib
---

# Summary

`lunar-terrain-sidecar` generates and authors lunar south-polar terrain for
Godot robotics simulations. It produces heightfields, feature manifests,
semantic masks, and solar geometry; Godot remains the physics authority.
Elevations come from real LOLA/PGDA measurements [@smith2010lola;
@barker2021south]. Synthesis is confined below measurement resolution, and
each exported sample records whether it is measurement or synthesis. Feature
populations use the Neukum production function [@neukum2001] capped by
empirical equilibrium [@xiao2015], a disclosed sub-10 m slope extrapolation,
Pike/Stopar morphometry [@pike1977; @stopar2017], McGetchin ejecta
[@mcgetchin1973], and the Golombek rock SFD
[@golombek1997; @golombek2003]. The Golombek form is calibrated on Mars and Earth-analog sites and applied here as an analog model. Areal coverage is a user parameter. Diviner abundance counts approximately metre-scale rocks, whereas configurable Golombek $k$ integrates coverage down to the chosen minimum diameter; the two are not directly comparable [@bandfield2011]. Solar elevation and azimuth are never free parameters:
they come from a real ephemeris, either a Meeus/IAU analytic chain
[@meeus1998; @archinal2011; @archinal2011erratum] by default or JPL DE440
kernels [@park2021] read by a TypeScript SPICE-subset reader with no third-party runtime dependencies. (A debugging override exists, recorded as `manual_override` with a stated limitation.) Generation is deterministic: regenerating the shipped demonstration site from its configuration and seed reproduces all 183 payload artifacts listed in the manifest byte-for-byte on the fixed platform and Node build.

# Statement of need

At a lunar pole the Sun stays within roughly 1.6° of the astronomical horizon: the Moon's mean spin-axis inclination is 1.5424° to the
ecliptic [@archinal2011]. Shadow length scales as
$1/\tan(\text{elevation})$, so a 1 m rock throws a 37 m shadow, and crater
interiors can be permanently shadowed. Polar illumination is therefore a
function of *topography and date*: a "sun angle slider" cannot produce
physically consistent elevation/azimuth pairs. Polar simulation needs
site-specific measured topography, defensible sub-resolution detail, and
illumination locked to an ephemeris. \autoref{fig:sweep} shows what that
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

A JSON configuration describes nested terrain layers, a selenographic anchor
on a PGDA 5 m/px polar DEM, feature-model parameters, and a UTC epoch. If a configured DEM is
missing, generation fails with a structured error rather than substituting
invented elevations. Synthesis is confined below a per-product *effective
resolution* supplied by the operator and recorded in provenance. The pipeline exports heightmaps, GLB meshes, tiles, semantic and
elevation-source masks, and manifests with
per-artifact SHA-256 checksums. By default the pipeline ray-marches
terrain-shadow horizons over the widest layer. An opt-in far-field mode marches the LOLA 120 m/px polar product along great circles to 100 km [@mazarico2011] and merges the skylines by per-bin maximum. Rendered shadows remain layer-bounded; horizon and illumination queries can include the far field.

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

A static Bekker-Wong assessment (`packages/lunar-terramech`) reports
equilibrium sinkage [@bekker1969; @wong2008], full-slip Janosi-Hanamoto
thrust [@janosi1961], resistance, drawbar pull, and slope margin
[@ishigami2007]. Soil parameters are the published
NASA LTV modeling-and-simulation values [@li2022terramechanics], with
cohesion, friction angle, and density asserted by test to sit inside the
Apollo in-situ ranges of Mitchell et al. [@mitchell1972]. For a 450 kg
VIPER-class reference rover (four 0.20 m × 0.25 m wheels, 1.62 m/s²) the
model gives $\approx 13$ mm static sinkage, $\approx 460$ N flat-ground
drawbar pull, and a $\approx 33°$ slope margin. These full-slip static upper
bounds are not dynamics. Every response labels the equatorial-Apollo/simulant
parameters and their unvalidated polar-site extrapolation. Wheel-soil dynamics
belong to the simulation authority or deformable-terrain engines such as
Project Chrono [@tasora2016].

# Validation and reproducibility

The v0.2.0 release-candidate matrix comprises 345 tests across 17 files and validates against an authority outside the code wherever one exists. On the fully provisioned reference machine, release acceptance requires every test to pass with none skipped, pending, or disabled. Resource-gated suites fail acceptance when a required input is absent; `scripts/fetch-data.sh` retrieves checksum-pinned public inputs.

**Ephemeris versus physical invariants.** The analytic solar chain is
tested against nine independent properties of the Earth-Moon-Sun system
(`tests/lunar-solar.ephemeris.test.ts`):

| Invariant | Source of truth | Result |
|---|---|---|
| Sub-solar latitude confined to ±1.60° | lunar obliquity plus libration | max 1.59° |
| Sub-solar latitude period $\approx 346.6$ d | draconic year | passes |
| Sub-solar longitude period 29.5306 d, westward | synodic month, prograde rotation | passes |
| Solar elevation at −90° = −(sub-solar latitude) | geometric identity | agrees to $10^{-9}$ ° |
| Earth-Sun distance $\in$ [0.9833, 1.0167] au | perihelion/aphelion | passes |
| Earth-Moon distance $\in$ [356 400, 406 700] km | perigee/apogee | passes |
| Lunar ecliptic latitude $\leq$ 5.3° | orbital inclination | passes |
| New moon 2000-01-06 18:14 UTC | tabulated event | elongation < 0.1° |
| Synodic month from 791 lunations | 29.530589 d | < $10^{-4}$ d |

Assertions pad the ecliptic-latitude limit to 5.4° and the sub-solar limit to 1.60°. The 1.59° maximum includes pole libration and the Sun's offset from the lunar ecliptic.

**Measured accuracy against JPL's integrated ephemeris.** The DE440 reader
(validated to < $10^{-9}$ rad against a frozen `jplephem`/CSPICE reference)
provides a direct measurement of this implementation's analytic-chain error:
sub-solar point separation of mean 0.0040°, maximum **0.0111°**, over 360
monthly epochs spanning 2020–2049. The sweep reproduces via `npm run terrain -- de-compare --months 360`, its maximum asserted in-suite below 0.012° when kernels are present. Both figures are below the documented 0.03° upper envelope of the IAU frame realization.

**DEM ingestion versus independent readings.** Tests read the real LOLA/PGDA products and compare georeferencing, declared projection, and elevations with product PDS metadata and independently obtained GDAL readings. DEM-grounded manifests carry the declared polar-stereographic parameters, exact projected local origin, and source-byte SHA-256: one digest for a GeoTIFF and separate label/image digests for detached PDS. Procedural-only outputs omit measured-data identities.

**Engine round trip.** Raycasts at 166 fixed probe points agree with sidecar elevations to **8.7 × $10^{-6}$ m** on-grid and **1.2 × $10^{-4}$ m** off-grid; assertions gate at 2 × $10^{-3}$ m and 5 × $10^{-2}$ m. Synchronous and frame-yielding imports produce identical probe, chunk, and collision results. The addon lifecycle measures 6 × $10^{-6}$ m agreement over 12 probes and 0.000% cut/fill imbalance. A release-acceptance test imports a checksum-pinned real Site01 crop in official Godot 4.6.3, saves and reopens a `PackedScene`, exports and launches a standalone Linux binary/PCK with the matching official template, and preserves terrain plus modeled-rock collision; saved and packaged raycasts agree with the sidecar to **1.82 × $10^{-6}$ m**.

**Protocol and mutable-state integrity.** Protocol 2 binds live clients to a monotonic revision and a server-authored digest of immutable geometry, origin, coordinates, provenance, rasters, and rock physics. Snapshot v2 atomically restores complete real Site01 mutable state and rejects corrupt, cross-site, symlinked, or malformed input without mutation. Godot applies revision-bound sparse edits without re-export, refreshes affected collision, and uses bounded tiles above 65,536 sparse samples.

**Determinism.** Regenerating the shipped site reproduces **183/183
manifest-listed payload artifacts byte-identically** on the pinned platform and Node build (26.7.0; another V8 alters only the last ulp of two JSON feature manifests, per `docs/reproducibility.md`);
cross-engine bit-identity is guaranteed by construction only for the noise core (`docs/reproducibility.md`). Edit logs replay bit-exactly onto a
regenerated site. Performance work is held to the same bar: an 8-thread
worker pool and algebraic optimizations of crater stamping and base relief
were each proven byte-exact against pre-optimization exports before being kept. The committed harness in `benchmarks/` records timings with
hardware context. The checked-in 2026-08-05 report measured a 3.836 s median of three runs for the DEM-grounded 10.3 M-sample demonstration stack; it is a historical benchmark, not a v0.2.0 timing claim.

# Comparison to related work

Among open environments, OmniLRS [@richard2024omnilrs] is
the closest relative: it imports LRO-derived DEMs at around 5 m/px,
positions the Sun and Earth from ephemerides, and
scatters rocks and craters from power-law distributions within Isaac Sim. `lunar-terrain-sidecar` differs not
in *having* measured DEMs or an ephemeris but in the four guarantees above: populations pinned to named models (Neukum
production capped by Xiao-Werner equilibrium; the Golombek SFD) rather than
generic power laws, and the engine round trip verified to
8.7 × $10^{-6}$ m. It complements renderers and physics stacks as their terrain and illumination authority, deferring wheel-soil dynamics to deformable-terrain engines such as Project Chrono [@tasora2016].

# Acknowledgements

This software builds on public NASA data products: LOLA altimetry from the
LRO mission [@smith2010lola], the LOLA-adjusted 5 m/px south-polar site
DEMs of the NASA GSFC Planetary Geodesy Data Archive [@barker2021south],
and the JPL DE440 planetary and lunar ephemerides [@park2021]. We validated
the DE440 reader against a frozen reference generated with `jplephem` and
CSPICE in the first author's `ephemkit` oracle environment, itself
independently checked against JPL Horizons.

# References
