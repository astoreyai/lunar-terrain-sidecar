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
date: 19 August 2026
bibliography: paper.bib
---

# Summary

`lunar-terrain-sidecar` generates and authors lunar south-polar terrain for
Godot robotics simulations, producing heightfields, feature manifests,
semantic masks, and solar geometry; Godot remains the physics authority.
Elevations come from real LOLA/PGDA measurements [@smith2010lola;
@barker2021south]; synthesis is confined below measurement resolution, and
each exported sample records which it is. Feature
populations use the Neukum production function [@neukum2001] capped by
empirical equilibrium [@xiao2015], a disclosed sub-10 m slope extrapolation,
Pike/Stopar morphometry [@pike1977; @stopar2017], McGetchin ejecta
[@mcgetchin1973], and the Golombek rock size-frequency distribution
[@golombek1997; @golombek2003]. The Golombek form is calibrated on Mars and Earth-analog sites, applied here as an analog model with user-set areal coverage; Diviner abundance counts approximately metre-scale rocks and is not directly comparable [@bandfield2011]. Solar elevation and azimuth are never free parameters:
they come from a real ephemeris, either a Meeus/IAU analytic chain
[@meeus1998; @archinal2011; @archinal2011erratum] by default or JPL DE440
kernels [@park2021] read by a TypeScript SPICE-subset reader with no third-party runtime dependencies. (A debugging override is recorded as `manual_override`.) Generation is deterministic: regenerating the shipped demonstration site from its configuration and seed reproduces all 183 payload artifacts listed in the manifest byte-for-byte on the pinned platform and Node build.

# Statement of need

At a lunar pole the Sun stays within roughly 1.6° of the astronomical horizon: the Moon's mean spin-axis inclination is 1.5424° to the
ecliptic [@archinal2011]. Shadow length scales as
$1/\tan(\text{elevation})$, so a 1 m rock throws a 37 m shadow, and crater
interiors can be permanently shadowed. Polar illumination is therefore a
function of *topography and date*: a "sun angle slider" cannot produce
physically consistent elevation/azimuth pairs. Polar simulation needs
site-specific measured topography, defensible sub-resolution detail, and
illumination locked to an ephemeris. That is the need of planetary-robotics
simulation developers, lunar surface-operations researchers, and
mission-planning tool builders. \autoref{fig:sweep} shows what that
geometry does to the shipped demonstration site: across one lunar day the
Sun's azimuth sweeps the full compass while its elevation stays within a
0.8°–1.9° band, so the same terrain presents entirely different shadow fields as the date changes.

![The demonstration site (real PGDA Site01 DEM, 89.46°S) at four ephemeris
epochs between 2025-12-22 and 2026-01-13. Solar elevation stays between 0.88°
and 1.68° while azimuth rotates 290° → 201° → 111° → 22°; shadows follow the
epoch, never a manual light setting.\label{fig:sweep}](figures/solar-sweep.png)

# State of the field

Agency landing and surface-operations simulators are typically closed. Among
open environments, OmniLRS [@richard2024omnilrs] is the closest relative: it
imports LRO-derived DEMs at around 5 m/px, positions the Sun and Earth from
ephemerides, and scatters rocks and craters from power-law distributions
within Isaac Sim. Gazebo and Unity lunar worlds ship engine-native terrain of
varying provenance. `lunar-terrain-sidecar` differs not in *having*
measured DEMs or an ephemeris but in four guarantees around them: per-sample
measurement-versus-synthesis provenance, feature populations pinned to named
published models and de-conflicted against the DEM's resolving power, a
checksummed byte-reproducibility contract with deterministic edit replay, and
a numerically verified round trip into a real engine (8.7 × $10^{-6}$ m).

Those guarantees are structural rather than features to contribute upstream:
they require the terrain authority to live outside the engine, own its
provenance schema, and reproduce independently of a renderer's release cycle.
OmniLRS is bound to Isaac Sim; the target here is Godot and, through a
documented protocol and plain export formats, any engine. The two are
complementary, and this project defers dynamics to engines of the Project
Chrono class [@tasora2016].

# Software design

The central trade-off is scope: this is a terrain *authority*, not a
simulator. Dynamics, rendering, and time-stepping stay with the engine, so
the sidecar stays small enough to verify exhaustively and usable outside
Godot. Three decisions follow, each recorded in `docs/decisions/`. The
browser UI and the Godot dock are thin clients of one JSON-RPC 2.0 protocol,
so physics-bearing data has exactly one implementation and the round-trip
test exercises the path a user does. Missing inputs fail: an unreadable DEM
produces a structured error, never substituted elevations, and every
synthetic or heuristic quantity is labelled in code, documentation, protocol
responses, and a per-sample `elevation_source` mask. Edits are replayable
records rather than mutated meshes, each returning a checksummed delta, so a
session reproduces as configuration plus seed plus log.

A JSON configuration describes nested terrain layers, a selenographic anchor
on a PGDA 5 m/px polar DEM, feature-model parameters, and a UTC epoch.
Synthesis is confined below a per-product *effective resolution* supplied by
the operator and recorded in provenance. Exports are heightmaps, GLB meshes,
tiles, semantic and elevation-source masks, and SHA-256-checksummed
manifests. Horizons are ray-marched over the widest layer; an opt-in
far-field mode marches the LOLA 120 m/px polar product along great circles to
100 km [@mazarico2011], merging skylines by per-bin maximum. The authoring UI
adds brushes and construction operations (ramps, pads, spoil piles, wheel
tracks, polygonal cut/fill) with mass-conserving redistribution and measured
cut/fill balance.

A static Bekker-Wong assessment (`packages/lunar-terramech`) reports
equilibrium sinkage [@bekker1969; @wong2008], full-slip Janosi-Hanamoto
thrust [@janosi1961], resistance, drawbar pull, and slope margin
[@ishigami2007]. Soil parameters are the published NASA LTV values
[@li2022terramechanics], with cohesion, friction angle, and density asserted
by test to sit inside the Apollo in-situ ranges [@mitchell1972]. For a 450 kg
VIPER-class reference rover (four 0.20 m × 0.25 m wheels, 1.62 m/s²) the
model gives $\approx 13$ mm static sinkage, $\approx 460$ N flat-ground
drawbar pull, and a $\approx 33°$ slope margin. These full-slip static upper
bounds are not dynamics. Every response labels the equatorial-Apollo/simulant
parameters and their unvalidated polar-site extrapolation.

# Validation and reproducibility

The v0.2.0 suite comprises 347 tests across 17 files and validates against an authority outside the code wherever one exists. Release acceptance requires every test to pass with none skipped, pending, or disabled. Hosted continuous integration provisions the checksum-pinned public inputs and the official Godot binary, then runs the 261 tests needing real data, a browser, or the engine, with zero skips.

**Ephemeris versus physical invariants.** The analytic solar chain is tested
against nine independent properties of the Earth-Moon-Sun system:

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

Assertions pad the ecliptic-latitude limit to 5.4°. The 1.59° maximum includes pole libration and the Sun's offset from the lunar ecliptic.

**Measured accuracy against JPL's integrated ephemeris.** The DE440 reader
(validated to < $10^{-9}$ rad against a frozen `jplephem`/CSPICE reference)
measures this implementation's analytic-chain error directly: sub-solar point
separation of mean 0.0040°, maximum **0.0111°**, over 360 monthly epochs
spanning 2020–2049, reproducible via `npm run terrain -- de-compare --months 360` and asserted in-suite below 0.012°. Both figures sit below the documented 0.03° envelope of the IAU frame realization.

**DEM ingestion versus independent readings.** Tests read the real LOLA/PGDA products and compare georeferencing, declared projection, and elevations against product PDS metadata and independent GDAL readings. DEM-grounded manifests carry the declared projection parameters, the exact projected local origin, and source-byte SHA-256 digests.

**Engine round trip.** Raycasts at 166 fixed probe points agree with sidecar elevations to **8.7 × $10^{-6}$ m** on-grid and **1.2 × $10^{-4}$ m** off-grid; assertions gate at 2 × $10^{-3}$ m and 5 × $10^{-2}$ m. A release-acceptance test imports a checksum-pinned real Site01 crop in official Godot 4.6.3, saves and reopens the scene, then exports and launches a standalone Linux binary that retains terrain and modeled-rock collision; packaged raycasts agree with the sidecar to **1.82 × $10^{-6}$ m**.

**Protocol and mutable-state integrity.** Protocol 2 binds live clients to a monotonic revision and a server-authored digest of immutable geometry, origin, coordinates, provenance, rasters, and rock physics. Snapshot v2 atomically restores complete real Site01 mutable state and rejects corrupt, cross-site, symlinked, or malformed input without mutation. Godot applies revision-bound sparse edits without re-export and refreshes only affected collision.

**Determinism.** Regenerating the shipped site reproduces **183/183
manifest-listed payload artifacts byte-identically** on the pinned platform and Node build (26.7.0; another V8 alters only the last ulp of two JSON feature manifests, per `docs/reproducibility.md`). Edit logs replay bit-exactly onto a regenerated site. Performance work is held to the same bar: an 8-thread worker pool and
algebraic optimizations were each proven byte-exact against pre-optimization
exports before being kept.

# Research impact statement

The software is the terrain and illumination authority for the authors' own
lunar surface-robotics simulation work, which motivated every guarantee above;
that developer use is the realized impact to date. There is no third-party
adoption yet, and no publication has been produced with it beyond this paper.

Its near-term significance rests on reproducible materials rather than claimed
uptake. The archived release carries a DOI, the demonstration site regenerates
byte-for-byte from configuration and seed, every measured input is a public
NASA/JPL product fetched and checksum-verified by a committed script, and
hosted continuous integration re-runs the real-data acceptance matrix on each
push, so a reviewer can reproduce every number here from a clean clone.
Exports are plain formats and the protocol is specified, so the artifacts are
consumable without adopting the tool. Wider impact (external studies,
integrations, or derived publications) is not asserted here.

# AI usage disclosure

Generative AI was used substantially, with every output treated as a proposal
requiring verification. Anthropic Claude models, through Claude Code, produced
most of the implementation, tests, and documentation; OpenAI Codex produced
the v0.2.0 release-hardening candidate; and Claude Fable 5 independently
reviewed that candidate, finding and fixing defects the generating model's own
tests had missed. Drafts of this paper were also AI-assisted.

The authors set the requirements, made and froze the architectural decisions
in `docs/decisions/`, and reviewed, corrected, or rejected all generated
content. Correctness rests on authorities outside any model: the JPL DE440
ephemeris, GDAL readings of the source products, physical invariants of the
Earth-Moon-Sun system, raycasts inside the real Godot engine, and byte-level
reproduction gates. Every quantitative claim here traces to a shipped
artifact, a committed test, or a re-runnable command.

# Acknowledgements

This software builds on public NASA data products: LOLA altimetry from the
LRO mission [@smith2010lola], the LOLA-adjusted 5 m/px south-polar site DEMs
of the NASA GSFC Planetary Geodesy Data Archive [@barker2021south], and the
JPL DE440 ephemerides [@park2021]. The DE440 reader was validated against a
frozen `jplephem`/CSPICE reference from the first author's `ephemkit` oracle,
itself checked against JPL Horizons.

# References
