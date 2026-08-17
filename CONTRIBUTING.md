# Contributing to lunar-terrain-sidecar

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
Questions and support requests are welcome as GitHub issues too.

## Reporting issues

Open a GitHub issue with: what you ran (the exact command or RPC call), what
you expected, what happened, and — for generation issues — the configuration
JSON and the seed. Determinism is a core contract here, so a seed plus a
config reproduces your terrain exactly; that makes minimal reproductions easy
and we will ask for one.

## Contributing changes

1. Fork, branch, and keep the change scoped: one concern per pull request.
2. **The gates must pass**: `npx tsc --noEmit -p tsconfig.json` and
   `npx vitest run`. Suites that need the NASA datasets, Godot, or a browser
   skip loudly when those are absent (see `.github/workflows/ci.yml` for the
   dataset-free set that must always be green).
3. **Determinism is non-negotiable.** Any change touching generation must
   preserve byte-identical output for a fixed seed, proven by
   `npm run terrain -- reproduce examples/south_pole_site_01/config.json`
   against a pre-change export — see `docs/reproducibility.md`. Performance
   changes must state why each transformation is float-exact (see the
   iteration-8 commit for the expected standard of proof).
4. **Cite what you model.** Physical models and parameters carry inline
   citations to published sources; synthetic or heuristic outputs are labeled
   as such in code, docs, and RPC responses. Follow `docs/terrain-model.md`
   and ADR 0005 for the expected honesty bar.
5. Architecture decisions go in `docs/decisions/` as ADRs; the coordinate
   convention (ADR 0002) and the sidecar-authority boundary (ADR 0003) are
   settled.

## Getting help

Open an issue with the `question` label. For the data files, run
`scripts/fetch-data.sh` first — most setup problems are missing kernels/DEMs.

## Test ports are a fixed registry

Each server-spawning suite owns a fixed loopback port (8791 protocol, 8793
UI-sidecar, 8795 godot-integration, 8801 construction, 8803 history, 8805
sync, 8807 DE, 8809 terramech, 8816 far-horizon; the UI suite also uses
5199 for Vite). `npm test` is therefore not re-entrant: a second concurrent
run, or anything else holding one of these ports, fails that suite. Pick an
unused port for any new server-spawning suite.
