# Benchmarks

The project's own rule is that **performance claims require benchmarks**
(spec §27). This directory is that benchmark suite: a plain `tsx` harness that
exercises the real generation pipeline, exporter, edit path and tile encoder,
and records what it actually measured. Nothing here is estimated or synthetic —
every number is the wall-clock result of running the real code, and the
DEM-grounded case reads the real LOLA 5 mpp GeoTIFF (it is **skipped, loudly**,
if that file is not on disk; no substitute data is ever used).

## Running

From the repository root:

```bash
npm run bench:terrain            # default suite, ~2 minutes on the reference machine
npm run bench:terrain -- --full  # adds the 50 m × 50 m @ 1 cm case (~1 extra minute)

# equivalently:
npx tsx --tsconfig tsconfig.json benchmarks/run.ts [--full]
```

Output goes to stdout as tables and to
`benchmarks/results/<ISO-date>-<hostname>.json` with hardware context
(CPU model, core count, RAM, Node version) and every raw run time.
Export benchmarks write their artifacts to a fresh directory under
`os.tmpdir()` and delete it after each run; nothing inside the repository is
touched except the results file.

## What each benchmark measures

1. **Terrain generation time vs size** — `generateTerrain()` end-to-end for
   four configurations: small (100 m @ 1 m), medium (1 km @ 2 m + 200 m @
   0.2 m), demo-scale (adds the 30 m @ 0.01 m operational tier — the
   `examples/south_pole_site_01` layer stack), and, when the LOLA DEM at
   `/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif` is
   present, the same demo-scale stack grounded in that real DEM at the Site01
   coordinates (lat −89.4631639°, lon −137.4895528°). Reports sample counts,
   in-memory layer bytes, and crater/rock counts alongside the time.
2. **Stage breakdown** — durations between the pipeline's `onProgress`
   callbacks (DEM ingest, base relief, craters, regolith, rocks,
   classification, solar geometry) for the most complete configuration, taken
   from its last timed run.
3. **Export time and bytes by format** — `exportTerrain()` on the demo-scale
   dataset: raw float32 only, then +EXR, +PNG16, and +GLB individually. Note
   the exporter always writes the semantic / elevation-source masks and the
   JSON manifests, so "rf32-only" includes those.
4. **Tile update latency** — `applyOperation()` (the headless server's edit
   path) applied 50 times to the generated 3001×3001 @ 0.01 m operational
   layer with a deterministic mix of raise/lower/flatten/smooth/crater-stamp/
   trench/berm brushes, a third of them mass-conserving. Reports p50/p95/max
   per-operation latency after 3 warm-up operations.
5. **`getTile` stride streaming** — the encode step of `terrain.getTile`
   (strided copy of the operational layer + base64), stride 1 (full fidelity)
   vs the preview stride that yields a ≈256² grid. Reports encode time and
   base64 payload size.
6. **1 cm operational-region feasibility (spec §27)** — samples, bytes and
   generation time for a single operational layer at 0.01 m: 25 m × 25 m in
   the default suite, 50 m × 50 m behind `--full`.

## Timing policy

- One untimed warm-up generation runs before anything is timed; export,
  encode and edit benchmarks additionally get their own untimed warm-up.
- Each measurement starts with a timed probe run. If the probe finishes in
  under 10 s, two more timed runs follow and the **median of 3** is reported;
  otherwise the probe stands alone as a **single run**. Every table row states
  which policy applied, and the JSON keeps all raw run times.

## Honest caveats

- **All numbers are machine-specific.** The checked-in results file is one
  sample from one machine on one day — it documents what was measured there,
  not a performance guarantee anywhere else. Re-run the suite on your own
  hardware before relying on any figure.
- Single-run rows (anything over 10 s) carry normal run-to-run variance;
  treat differences of tens of percent between such rows as noise unless
  reproduced.
- Export benchmarks write to `os.tmpdir()`, which on many Linux machines is a
  RAM-backed tmpfs; on such machines export times measure encoding plus
  memory-speed I/O, not spinning-disk or SSD throughput.
- The small and medium configurations place their rock population on their
  finest layer over its full extent (that is how the pipeline works), so their
  rock counts — and the rock-manifest share of their export sizes — are much
  larger than the demo-scale configuration, whose finest layer covers only
  30 m × 30 m. The tables report the counts so this is visible.
