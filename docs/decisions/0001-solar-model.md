# ADR 0001 — Accurate solar geometry rather than a sun-angle slider

**Status:** accepted · **Date:** 2026-08-03

## Context

The primary target is lunar **south-polar** terrain. Polar illumination is not a
lighting preference — it is the dominant physical feature of the site:

- The Moon's spin axis is tilted only **1.5424°** to the ecliptic, so at a pole
  the Sun never rises more than ~1.54° above the horizon.
- Shadow length scales as `1/tan(elevation)`. At 1.5° elevation a 1 m rock
  throws a **38 m** shadow; a 30 m crater rim shadows a kilometre of floor.
- Consequently illumination is governed by **topography**, not time of day, and
  permanently shadowed regions exist at all.

A free-floating "solar elevation" slider cannot represent this. Elevation and
azimuth are not independent at a pole — they are jointly determined by the date
and the site's selenographic coordinates.

## Decision

Implement a real ephemeris in `@lts/lunar-solar` rather than parameterising the
Sun directly. The chain is:

1. UTC → TT with an explicit IERS leap-second table (ΔAT = 37 s since 2017).
2. Geocentric Sun (Meeus ch. 25) and Moon (Meeus ch. 47, full 60+60 term
   tables), both at mean equinox **of date**.
3. **Precess both to J2000.** Non-negotiable: the IAU lunar pole is referred to
   the ICRF, and by 2026 the accumulated precession is ~0.36° — a quarter of the
   entire ±1.54° elevation range. Mixing the frames would swamp every other term.
4. Moon→Sun vector, light time solved by antedating the Sun (~0.0057°). Done
   geometrically rather than with the classical aberration constant, because
   the constant is derived for an Earth-bound observer.
5. Rotate into the lunar body-fixed frame via IAU/WGCCRE (Archinal et al. 2011)
   with the E1…E13 libration terms.
6. Sub-solar selenographic latitude/longitude → local topocentric azimuth and
   elevation.

Terrain shadowing is separate (`horizon.ts`): ray-march the real DEM per azimuth
to build a skyline, **including the lunar curvature drop** `d²/2R` (28.8 m over
10 km, comparable to the relief doing the shadowing).

## Alternatives rejected

- **Sun-angle slider.** Cannot produce physically consistent az/el pairs, and
  makes illumination studies meaningless.
- **Vendoring a JPL DE kernel.** Most accurate, but a ~100 MB binary dependency
  and a SPICE-class reader for a sidecar whose job is terrain. Left as the
  documented upgrade path.
- **Earth-centred solar position without the parallax term.** The Moon→Sun and
  Earth→Sun directions differ by up to 0.147°, which is 10% of the polar
  elevation range. Rejected.

## Accuracy and its floor

The limiting error is **not** the solar series (~0.01°) but the **IAU rotation
model's realisation of the Mean Earth/Polar Axis frame**, which differs from a
JPL DE-integrated libration by roughly **0.01–0.03°**. That propagates ~1:1 into
solar elevation. At 1° elevation a 0.03° error moves a shadow edge by ~3%.

This is stated in the module docstring, in `docs/known-limitations.md`, and in
every export's provenance block rather than being left implicit.

## Verification

No DE kernel is vendored, so the model is validated against **independent
physical invariants** — properties of the Earth–Moon–Sun system that come from
outside the code being tested (`tests/lunar-solar.ephemeris.test.ts`, 23 tests):

| Invariant | Source of truth | Result |
|---|---|---|
| Sub-solar latitude confined to ±1.54° | lunar obliquity | max 1.59° |
| Sub-solar latitude period ≈ 346.6 d | draconic year, not the tropical year — proves the pole actually librates | passes |
| Sub-solar longitude period = 29.5306 d, **westward** | synodic month, prograde rotation | passes |
| Solar elevation at −90° = −(sub-solar latitude) | exact geometric identity | agrees to 1e-9° |
| Earth–Sun distance ∈ [0.9833, 1.0167] AU | perihelion/aphelion | passes |
| Earth–Moon distance ∈ [356 400, 406 700] km | perigee/apogee | passes |
| Lunar ecliptic latitude ≤ 5.3° | 5.145° orbital inclination | passes |
| New moon 2000-01-06 18:14 UTC | tabulated event | elongation < 0.1° |
| Synodic month from 791 lunations | 29.530589 d | agrees to <1e-4 d |

The sub-solar latitude bound is the decisive end-to-end check: a dropped
precession step, a wrong pole, or a mangled lunar term all break it.

### A note on the synodic-month estimator

The first implementation measured `(t_last − t_first) / (N − 1)` and was off by
1.3e-2 d. That estimator **telescopes** — interior crossings cancel, so its
error depends only on where the two endpoints fall in the 411.78-day full-moon
cycle and never improves with span. Replacing it with a least-squares
regression over all 791 crossings (which converges as N^(-3/2)) brought
agreement to <1e-4 d. The series was correct throughout; the test was measuring
its own sampling.
