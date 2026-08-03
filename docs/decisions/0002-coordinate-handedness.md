# ADR 0002 — Right-handed frame with north on −Z

**Status:** accepted · **Date:** 2026-08-03

## The problem

The engineering spec (§4) asks for all four of these at once:

```
handedness: right
up_axis:    Y
east_axis:  X
north_axis: Z
```

Those cannot all be true. Right-handedness means `X × Y = Z`. With `X = east`
and `Y = up`:

```
east × up = −north
```

so `Z = south`, not north. (Derivation: in the standard ENU triad `E × N = U`,
therefore `E × U = E × (E × N) = E(E·N) − N(E·E) = −N`.)

The requested combination — X=east, Y=up, Z=north — is self-consistent only in a
**left-handed** frame. That is precisely Unity's convention. It is not Three.js's
or Godot's; both are right-handed, Y-up.

Exactly one of the four statements has to give.

## Decision

**Keep right-handed, Y-up, X-east. North is −Z.**

| Axis | Direction |
|---|---|
| +X | east |
| +Y | up (elevation) |
| +Z | **south** |
| −Z | north |

## Why handedness wins over the axis label

Handedness is load-bearing geometry; the label is nomenclature.

- **Triangle winding and face culling.** Flipping handedness inverts winding, so
  every tile would render inside-out or need a compensating flip somewhere.
- **Surface normals.** Computed from cross products of edge vectors; the sign
  flips with the frame.
- **Physics chirality.** Torques, angular velocity and quaternion conventions
  all invert. Godot is the simulation authority (spec §33) and is right-handed;
  handing it a left-handed frame silently corrupts rotational dynamics.
- **Both target engines are right-handed.** Three.js and Godot agree. Adopting a
  left-handed frame would mean converting at *both* ends rather than neither.

By contrast, "north is −Z instead of +Z" costs one sign in the azimuth
conversion, in exactly one place, and is stated explicitly in every export.

## How it is made unmissable

`CoordinateSystem` carries the direction of north as data, not as a comment, and
it is embedded verbatim in every manifest:

```json
"coordinate_system": {
  "handedness": "right",
  "up_axis": "Y",
  "east_axis": "+X",
  "north_axis": "-Z",
  "south_axis": "+Z",
  "linear_unit": "meter",
  "note": "Right-handed Y-up. north = -Z because X=east and Y=up force Z=south."
}
```

A consumer that assumes +Z is north will read `"north_axis": "-Z"` and correct,
rather than discovering a mirrored site after the rover drives the wrong way.

## Consequent conventions

- **Grid indexing.** `col` increases with +X (east); `row` increases with +Z
  (south). Row 0 is therefore the **northernmost** row, which matches the
  top-down image convention and the PDS line ordering (PDS `LINE` increases
  southward), so the DEM reader needs no vertical flip.
- **Azimuth.** Measured clockwise from north, so a unit vector at azimuth `A` is
  `(x, z) = (sin A, −cos A)`. The minus sign on `z` is the whole cost of this
  decision.

## Validation

`tests/coordinates.test.ts` asserts the triad is right-handed
(`X × Y = Z` numerically), that north maps to −Z, and that azimuth 0 points
north, 90 east, 180 south, 270 west. The Godot round-trip test independently
confirms the sign by raycasting a known-north feature.
