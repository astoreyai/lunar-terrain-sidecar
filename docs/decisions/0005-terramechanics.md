# ADR 0005 — Static Bekker–Wong terramechanics assessment, and why it stays static

**Status:** accepted · **Date:** 2026-08-03

## Context

Traversability was a hand-weighted heuristic (`traversabilityAt` in
`apps/headless-server/src/server.ts`): slope and roughness folded into a 0–1
score by chosen weights, labelled `synthetic heuristic` in every response.
Honest, but not a model — a consumer planning a route got a number with no
physical meaning. The literature has had a physical screening model for sixty
years: Bekker pressure–sinkage (Bekker 1969), the Mohr–Coulomb thrust limit
and motion-resistance framework as consolidated by Wong (2008), the
Janosi–Hanamoto shear law (1961), and their application to planetary rovers
on loose soil (Ishigami et al. 2007).

## Decision

A new package, `packages/lunar-terramech`, computes a **static** Bekker–Wong
assessment per terrain sample: equilibrium sinkage, maximum (full-slip)
thrust, compaction and gradient resistance, net drawbar pull at the local
slope, and the slope margin where drawbar pull reaches zero.
`terrain.getTraversability` defaults to `model: 'bekker'` and embeds the old
heuristic result (still labelled) for comparison; `model: 'heuristic'`
returns the legacy shape unchanged. The method table did not change — this is
a parameter, not a new method.

For the sourced parameters (below) and the reference vehicle (450 kg
VIPER-class, 4 wheels, b = 0.20 m, r = 0.25 m, 1.62 m/s²), the model gives
13.4 mm static sinkage, 461.8 N flat-ground drawbar pull, and a
**32.6° slope margin**.

### Why static only — the authority boundary

Spec §33 and ADR 0003 give this sidecar one physics rule: it must never own
dynamics. The physics authority (Godot/Chrono) simulates wheel–soil
interaction; this layer only pre-screens terrain. So the assessment
deliberately contains **no dynamic wheel–soil simulation, no slip
time-histories, no deformable contact**:

- Thrust is the Mohr–Coulomb **maximum** `H = A·c + W·tan(φ)` — the
  full-slip asymptote of the Janosi–Hanamoto curve. The shear modulus
  K = 0.018 m is carried in the parameter block *for the dynamics consumer*,
  never evaluated here.
- Sinkage is the **equilibrium** value for a stationary wheel via Wong's
  flat-plate simplification (contact chord `l ≈ √(D·z)`, uniform pressure);
  no slip-sinkage, no multi-pass effects.
- Load split is static and even across wheels; longitudinal load transfer is
  a dynamic effect and is omitted.

A second, dynamic implementation here would be exactly the drift ADR 0003
exists to prevent: two owners of wheel–soil physics that can silently
disagree.

### Parameter provenance, and its limits

| Parameter | Value | Source |
|---|---|---|
| k_c | 1400 Pa/m^(n−1) | NASA LTV terramechanics white paper, NTRS 20220010732 |
| k_φ | 820 000 Pa/m^n | NTRS 20220010732 |
| n | 1.0 | NTRS 20220010732 |
| c | 170 Pa | NTRS 20220010732; inside Mitchell et al. (1972) Apollo range 0.1–1 kPa |
| φ | 35° | NTRS 20220010732; inside Mitchell (1972) range 30–50° |
| K (Janosi) | 0.018 m | representative; Wong (2008) loose sand 0.01–0.025 m — **not site-measured** |
| ρ | 1660 kg/m³ | descriptive; inside Mitchell (1972) upper-regolith range 1500–1750 kg/m³ |

The Mitchell et al. (1972) Apollo in-situ ranges are the cross-check: a test
asserts the chosen point values sit inside them, so the parameter set cannot
silently drift from what was measured on the Moon.

The limits are stated in `TERRAMECHANICS_PROVENANCE`, which travels with
**every** RPC response using the model:

- Parameters are **equatorial-Apollo/simulant-derived**. **No polar site has
  in-situ soil measurements.** Applying these numbers to the polar sites this
  system targets is an extrapolation.
- **Low-gravity effects on k_φ and cohesion are unsettled** — the NTRS white
  paper itself cautions that Earth-gravity simulant-derived parameters may
  not transfer directly to 1/6 g.

### What would be needed to claim validation

In-situ polar bevameter/penetrometer data — plate pressure–sinkage and shear
ring measurements at the actual site — compared against the model's
predictions. **None exists.** Until it does, this is a screening estimate for
relative go/marginal/no-go classification. The go threshold (drawbar pull
> 20 % of thrust) is a reserve for resistances the static model omits
(bulldozing, rocks, steering losses), not a calibrated boundary.

**This ADR explicitly does NOT claim force-accuracy.** The verified claims
are (a) the implementation matches the published formulas — asserted against
independently coded hand computations to 1e-12 in `tests/terramech.test.ts`
— and (b) the parameters are the published values. Whether those formulas
with those parameters predict real forces at a real polar site is untested
and untestable with existing data, and the provenance block says so on every
response.

### The heuristic stays

The old heuristic remains available (`model: 'heuristic'`, byte-compatible
response) and rides inside every bekker response for comparison. It is the
UI overlay's model and the fallback if the parameter set is ever inapplicable;
removing it would break the shipped clients for no gain.

## Consequences

- `packages/lunar-terramech`: `parameters.ts` (sourced constants + provenance
  block), `bekker.ts` (pressure–sinkage, static sinkage, compaction
  resistance), `traction.ts` (thrust, gradient resistance, drawbar pull,
  slope margin), `assess.ts` (per-point and per-layer assessment).
- Consumers comparing the two models will see them disagree — by design. The
  heuristic's 25° hard slope cutoff sits below the Bekker 32.6° margin
  because the heuristic was tuned conservatively by hand; the disagreement is
  visible in every default response rather than hidden behind a switch.
- Citations: bekker1969, wong2008, janosi1961, ishigami2007, mitchell1972,
  li2022terramechanics (`paper/paper.bib`).
