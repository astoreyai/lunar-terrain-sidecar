# Documentation media — provenance

Every image and GIF in this directory is a real render, not an illustration:
headless Chromium (SwiftShader) running the shipped authoring UI against a
live sidecar, over terrain generated from the **real** LOLA/PGDA
`Site01_final_adj_5mpp_surf.tif` DEM (site −89.4631639°, −137.4895528°), lit
by the project's own ephemeris at the epochs stated below. No frame is
staged, composited from non-rendered elements, or retouched beyond resizing,
tiling, and GIF palette encoding.

Regenerate everything with:

```bash
npx tsx scripts/capture-media.ts     # captures frames (real sidecar + UI)
scripts/assemble-media.sh            # resizes/encodes into this directory
```

| File | What it shows |
|---|---|
| `hero-lit.png` | The demonstration site (`examples/south_pole_site_01`) in the lit-regolith view at 2026-01-10T00:00:00Z — solar elevation 1.46°, azimuth 60.8°, from the ephemeris. |
| `solar-sweep.gif` | 30 frames stepping the epoch from 2025-12-20 to 2026-01-19 — the window when the Sun is geometrically above the site's reference-sphere horizon. Elevation stays between 0.82° and 1.90° while azimuth sweeps ~360°; the rotating shadows are the point: illumination is a function of topography and date, never a slider. Shadows are cast by the site's own 1 km of terrain only; relief beyond the layer would only *add* shadow (a distant massif can raise the horizon, never lower it), so the sweep errs bright — see `docs/known-limitations.md`, "Horizon and shadow fidelity". |
| `overlays.png` | The four analysis overlays (elevation, slope, semantic classes, traversability) over the same dataset. The traversability overlay renders the labelled heuristic, as its legend states. |
| `topdown-elevation.png` | Top-down elevation view with nested layer boundaries (1 km context / 200 m mission / 30 m operational). |
| `authoring-ui.png` | The full authoring UI: inspector, provenance panel, solar geometry, coordinate-system card. |
| `construction.gif` | A construction sequence on the 200 m `rover_test_pad` preset, rendered in the unlit elevation overlay (at 1.46° solar elevation a lit flat pad is nearly black): pad, ramp, spoil pile (repose-clamped), mass-conserving excavation, wheel tracks, polygonal cut. Every edit goes over `terrain.applyOperation` and every frame is a fresh page-load of the sidecar's authoritative field. The wheel-track rut depth (0.8 m) is exaggerated for legibility at this scale; realistic 0.1–0.4 m ruts fall below one colour step of the elevation ramp. |
| `construction-ui.png` | The UI after that sequence, with the operation history and cut/fill volumes. |

The capture script asserts, per sweep frame, that sunlit terrain is actually
visible and that lighting varies across frames — a sweep of identical or
black frames fails the run rather than shipping.
