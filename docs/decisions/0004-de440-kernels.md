# ADR 0004 — Read the real JPL DE440 kernels rather than build or approximate an ephemeris

**Status:** accepted · **Date:** 2026-08-03

## Context

ADR 0001 shipped an analytic solar model (Meeus series + IAU/WGCCRE lunar
rotation) and named its accuracy floor: the IAU trigonometric realisation of
the lunar Mean Earth frame differs from a JPL DE-integrated libration by
roughly **0.01–0.03°**, propagating ~1:1 into solar elevation — a few percent
of the entire ±1.54° polar elevation range. ADR 0001 rejected vendoring a DE
kernel as a ~100 MB binary dependency and left it as the documented upgrade
path.

The situation changed: the kernels are already on this machine, as real data,
at `/mnt/projects/datasets/spice_kernels/` —

- `de440s.bsp` (33 MB) — DE440 SPK, 14 Type 2 Chebyshev-position segments
  (SSB→Sun, SSB→EMB, EMB→Moon, …), coverage 1849–2150;
- `moon_pa_de440_200625.bpc` (13 MB) — binary PCK with JPL's **numerically
  integrated** MOON_PA_DE440 orientation as Type 2 Chebyshev 3-1-3 Euler
  angles;
- `moon_de440_250416.tf` — text frames kernel carrying the fixed
  PA→ME rotation (TKFRAME_31009: 67.8526″, 78.6944″, 0.2785″ about axes
  3, 2, 1).

So "vendoring" costs nothing, and the only real question was how to read them.

## Decision

Implement a **dependency-free TypeScript reader for the real kernels**
(`packages/lunar-solar/src/spice/`: DAF container → SPK Type 2 → binary PCK
Type 2 → PA→ME frame chain → `deSolar.ts`), exposed as a new solar mode
`ephemeris_de` beside the existing `ephemeris` (analytic) and `manual` modes.

Missing kernels are a **structured failure**
(`TERRAIN_SPICE_KERNELS_UNAVAILABLE`), never a silent fallback: a dataset
claiming DE440 accuracy while carrying Meeus/IAU numbers would be a
provenance lie.

### The default stays `ephemeris`

`solar.mode` continues to default to the analytic chain. Switching the
default would change the solar angles — and therefore the exported bytes — of
every existing site regenerated from its stored config + seed, breaking the
byte-reproducibility contract ([reproducibility.md](../reproducibility.md)).
For the same reason `solar.kernelDirectory` is schema-**optional with no
default value injected**: a Zod `.default()` would add the key to every
parsed config and change the canonical configuration hash of sites that never
mention it. The effective default
(`/mnt/projects/datasets/spice_kernels`) is applied at the point of use.

## Alternatives rejected

- **Build our own kernel** (integrate the n-body problem + lunar rigid-body
  dynamics and fit our own Chebyshev sets). An integrator we wrote could only
  be validated against… JPL's ephemerides, so it adds an unverifiable
  numerical layer between us and the truth we would be testing against, plus
  force-model choices (asteroid perturbations, tidal dissipation, core-mantle
  coupling) that JPL spent decades fitting to LLR and spacecraft ranging.
  Reading JPL's bytes directly has zero modelling error by construction.
- **Stay pure-analytic.** Leaves the documented 0.01–0.03° frame floor in
  place, which at 1° solar elevation moves shadow edges by ~1–3% — visible in
  rendered polar scenes and material for illumination studies.
- **Depend on a SPICE binding** (naif/cspice WASM, or shelling out to
  spiceypy). Adds a native/foreign dependency to a sidecar whose reproducibility
  story is "same bytes from the same config on the same platform"; the DAF/SPK
  Type 2 format is small enough (~600 lines here) that reading it directly is
  less machinery than binding to it.

## Approximations, stated

- **TT ≈ TDB.** The kernels are functions of TDB; the time chain reuses
  `time.ts` (UTC → TAI → TT) and treats TT as TDB. TDB−TT is periodic,
  bounded by ±1.7 ms. Worst-case effect is through the lunar prime-meridian
  rate (13.18°/day ≈ 1.5e-4 °/s): **~2.6e-7°**, two-plus orders below the
  next error term. (Declared in `deSolar.ts`.)
- **ME421 realisation.** The .tf maps PA to `MOON_ME_DE440_ME421`, the
  DE421-aligned ME frame the LOLA products use. The frames kernel itself
  quantifies the difference to the current-best ME realisation: ≤ 3.1e-7 rad
  (~53 cm on the surface) over 2000–2040. That is the new accuracy floor.
- **Light time** is solved the same way as the analytic chain (antedating the
  Sun, two iterations), so the two modes remain comparable term by term.

## The measured number

`compareWithAnalytic` (in `deSolar.ts`) measures the angular separation
between the DE440 and Meeus/IAU sub-solar points — the first direct
measurement of the analytic chain's real error, which until now was a
literature estimate:

- over the 24 frozen test epochs (2020–2049): **max 0.0095°**
  (at 2028-10-27);
- over the shipped reproducible sweep (`lunar-terrain de-compare --months
  360`, mean-month stepping, 2020–2049): **mean 0.0040°, max 0.0111°**
  (at 2028-11-30);
- a denser development-time sweep on a different epoch grid measured **max
  0.0118°** (at 2035-06-11) — quoted here for the record; the citable
  number is the reproducible command's.

This **validates the analytic chain**: the measured error sits inside the
documented 0.01–0.03° budget (toward its favourable end — consistent with
the frames kernel's own statement that the IAU-vs-DE440 ME difference has
amplitude ~0.0051° about a 0.0024° mean, on top of ~0.01° of Meeus series
error). The `ephemeris` mode's numbers were never wrong; they are now
*measured* rather than estimated, and `ephemeris_de` exists for work where
0.01° of frame error matters.

## Verification

`tests/lunar-solar.de.test.ts`, offline, gated on kernel presence
(skip, not fake-pass, when absent):

| Check | Reference | Tolerance |
|---|---|---|
| Moon→Sun J2000 unit vector, 24 epochs | frozen jplephem chaining (`tests/data/de-reference.json`) | < 1e-9 rad |
| PA Euler angles + J2000→PA / J2000→ME matrices | frozen jplephem.pck + CSPICE `pxform` | < 1e-9 rad |
| Fixed PA→ME matrix | frozen CSPICE `pxform` | < 1e-14 rad |
| Sub-solar point vs analytic chain | the code under ADR 0001 | < 0.05°, measured value printed |
| 1700s epoch | coverage bounds | structured `SPICE_COVERAGE` error |
| Determinism | same instant twice | bit-identical |
| `terrain.getSolar` `mode:'ephemeris_de'` | real WebSocket round-trip | model label + < 0.05° vs analytic |

The reference file is generated once by `scripts/freeze-de-reference.py`
(jplephem 2.24 + CSPICE N0067 in the validated `/mnt/projects/ephem` oracle
environment, itself checked to 0.02 arcsec against JPL Horizons) and committed
with kernel SHA-256 prefixes; the vitest suite never shells out. Both Euler
conventions (PCK 3-1-3, TKFRAME angles) were pinned **empirically** against
CSPICE `pxform` on the real kernels rather than trusted from documentation —
the two candidate TKFRAME compositions differ by ~1.4e-7 rad, above the test
tolerance, so guessing was not an option.
