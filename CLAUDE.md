# lunar-terrain-sidecar — agent handoff

**State (2026-08-04, tag `v0.1.1`):** feature-complete against its 34-section
engineering spec, JOSS-submission-ready, 244/244 tests across 14 files,
typecheck clean, demo site reproduces 183/183 artifacts byte-for-byte.
**No remote** (creating `github.com/astoreyai/lunar-terrain-sidecar` is
Aaron's pending action; push master + both tags). Since v0.1.0: paper figure
(`paper/figures/solar-sweep.png`), README media set (`docs/media/`, regenerate
via `scripts/capture-media.ts` + `scripts/assemble-media.sh`), UI connect-time
dataset auto-load, and a polar-night viewport banner.

Full session history: `/mnt/projects/session_notes/2026-08-03_lunarlandscape_build_and_joss_paper.md`.

## What this is

TypeScript monorepo generating **lunar south-polar terrain** for a Godot
robotics sim: real LOLA/PGDA DEMs + literature-anchored crater/rock
populations + a validated solar ephemeris + JSON-RPC sidecar + Three.js
authoring UI + Godot 4 addon. It is a *terrain authority*, deliberately not a
physics engine (ADR 0003/0005: dynamics belong to Godot/Chrono-class engines).
Standalone by Aaron's instruction — do **not** couple to STEWIE.

## Hard invariants — break these and the project's claims are false

1. **Byte-determinism.** Same seed → byte-identical output. Any generation
   change must pass `npm run terrain -- reproduce examples/south_pole_site_01/config.json`
   against a **pre-change** export. Perf changes need a float-exactness
   argument per hoist (see commits `a681ae3`, `466c202` for the standard).
   If a change *intends* new bytes (it happened twice: provenance-mask fixes),
   regenerate the demo baseline in the same commit and say so.
2. **Coordinates (ADR 0002, frozen):** right-handed, Y-up, +X east, **+Z
   south — north is −Z**. Row 0 is northernmost. Azimuth clockwise from
   north: direction `(x,z) = (sin A, −cos A)`. Carried as data in every
   manifest; both the Godot loader and UI verify it.
3. **No synthetic data masquerading as measurement** (Aaron's absolute rule).
   Missing DEM/kernels → structured error, never a fallback. Everything
   synthetic/heuristic/static is labeled in code, docs, RPC responses, and
   the per-sample `elevation_source` mask.
4. **Verification discipline — the session's hardest-won lesson:** three
   script-based patches claimed success while silently failing (a
   `str.replace` no-op against refactored code; an empty-match interleave
   that corrupted a doc file to 5.7 MB; a grep fooled by the corruption it
   was checking). **Verify patches by diffing the result against the intended
   change; never trust the patch script's own assertion.** Use the Edit tool
   (exact-match, fails loudly) over ad-hoc `str.replace` for docs.

## Gates (run before any commit)

```bash
npx tsc --noEmit -p tsconfig.json      # must be clean
npx vitest run                          # 242/242, 14 files — no skips on this machine
npm run terrain -- reproduce examples/south_pole_site_01/config.json   # byte-for-byte
```

GDScript changes: parse-check each addon script headlessly
(`/mnt/projects/tools/Godot_v4.6.3-stable_linux.x86_64 --headless --check-only --script ...`
from `godot/example-project` with the addon copied into `addons/`).

## Trap registry (each cost real debugging time)

- **Test ports are a global registry**: 8791 protocol, 8793 UI-sidecar, 8795
  godot-integration, 8801 construction, 8803 history, 8805 sync, 8807 DE,
  8809 terramech, 8814+5201 media capture (`scripts/capture-media.ts`),
  8816 far-horizon. 8796–8799 **and 8811** are held by unrelated system
  services. A new
  suite needs a NEW port — a collision is green in isolation, red only in
  parallel runs.
- **Never run two UI suites concurrently** (Vite 5199 + sidecar 8793 clash;
  the loser's page talks to the winner's sidecar and dies mid-suite).
  Subagents re-running their own gates while the orchestrator gates = the
  usual cause.
- **`execFileSync` blocks the event loop** — an in-process WebSocket server
  can't accept while Godot runs; spawn async (see godot-integration test).
- **tsx in worker_threads**: `execArgv --import tsx` fails on Node 20; the
  working mechanism is the eval'd bootstrap in
  `packages/terrain-pipeline/src/workerPool.ts`.
- **Headless-Chromium WebGPU** exposes `navigator.gpu` then hangs at
  `requestAdapter` — all GPU-preview init awaits race a 10 s deadline; tests
  branch on reported outcome, not API presence.
- **Generation without a DEM has zero await points** — CPU-bound, blocks the
  loop; concurrency tests need the DEM's I/O window to open a race.
- **Craters stay single-threaded** (+= accumulation order). Only
  base_relief/regolith parallelize.

## Data dependencies (machine-local, all public sources)

- PGDA 5 m/px DEMs: `/mnt/projects/datasets/lola_5mpp/` (Site01 is the demo anchor)
- LOLA LDEM_75S: `/mnt/projects/stewie/data/gis/raw/ldem_75s_120m.{img,lbl}` (read-only reference)
- SPICE kernels: `/mnt/projects/datasets/spice_kernels/` (de440s.bsp + moon PA
  kernel + frames); override with `LTS_SPICE_DIR`. `scripts/fetch-data.sh`
  re-downloads everything from verified public URLs (incl. LDEM_75S for the
  far-field horizon; override with `LTS_LDEM_75S`).
- Validation oracle: `/mnt/projects/ephem` (`ephemkit`, jplephem/Skyfield venv,
  itself Horizons-validated) — used only to generate frozen test references.

## Paper status

`paper/paper.md` + `paper/paper.bib` are submission-ready: three simulated
referee rounds (reports in this session's agent transcripts; summaries in the
round commits `c784f22`/`e6df353`/`e1c1f51`) plus a 25-claim
claim-to-source audit — every number traces to a shipped artifact, test, or
re-runnable command. Review package for Aaron:
`~/Desktop/Outbox/2026-08-03_lunarlandscape_JOSS_paper_draft.md` (synced to gdrive).

**Aaron's pending actions (do NOT do these for him):** review the draft;
create the public GitHub repo and push `master` + `v0.1.0`; confirm CI green;
submit at joss.theoj.org. Optionally publish `ephemkit` (GitHub-first) as the
citable oracle.

## Sensible next work (none blocking)

- Far-field horizon consumers: `terrain.getHorizon farField` is built
  (ADR 0006, `packages/lunar-dem/src/farHorizon.ts`, tests port 8816) but
  `isSunlit`/`sunlitFraction`/illumination stats callers and the UI don't
  request it yet; the rendered shadow map is layer-only by design.
- UI: expose `ephemeris_de` mode + terramech class overlay (server side done).
- Godot dock: surface the construction/terramech RPC surface (import-focused today).
- Sparse-delta consumption in the Godot addon (server side done, spec §19).
- If reviewers ask: Powell et al. 2023 extends Diviner rock abundance to ±70°.

## Conventions

- ADRs in `docs/decisions/` — 0001 solar, 0002 coordinates, 0003 protocol
  clients, 0004 DE440, 0005 terramechanics, 0006 far-field horizon. Settled;
  extend, don't relitigate.
- Commit style: what + why + measured evidence + gate line (see history).
- Aaron's global rules apply: no stubs/TODOs/synthetic data; Outbox for
  anything third-party-bound; deliverables staged for his review, never sent.
