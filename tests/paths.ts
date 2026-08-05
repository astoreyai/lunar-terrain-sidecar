/**
 * Where the real datasets live, with environment overrides so a reviewer on
 * any machine can run the gated suites after `scripts/fetch-data.sh`:
 *
 *   LTS_SITE01_DEM  — path to Site01_final_adj_5mpp_surf.tif
 *   LTS_LDEM_75S    — path to the LDEM_75S detached label (.lbl)
 *   LTS_SPICE_DIR   — kernel directory (honored inside @lts/lunar-solar)
 *
 * The hardcoded fallbacks are the development machine's dataset store. Suites
 * gate on existence and skip loudly — never fake-pass — when a path resolves
 * to nothing.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const SITE01_DEM =
  process.env.LTS_SITE01_DEM ??
  '/mnt/projects/datasets/lola_5mpp/Site01_final_adj_5mpp_surf.tif';

const LDEM_CANDIDATES = [
  '/mnt/projects/datasets/lola_ldem/ldem_75s_120m.lbl',
  '/mnt/projects/stewie/data/gis/raw/ldem_75s_120m.lbl',
];
export const LDEM_75S_LBL =
  process.env.LTS_LDEM_75S ??
  LDEM_CANDIDATES.find((p) => existsSync(p)) ??
  LDEM_CANDIDATES[0];

/**
 * Godot 4 editor binary for the engine round-trip suites: `LTS_GODOT`, then
 * PATH (`godot4`/`godot`), then the development machine's copy.
 */
function findGodot(): string {
  if (process.env.LTS_GODOT) return process.env.LTS_GODOT;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['godot4', 'godot']) {
      const cand = join(dir, name);
      if (dir && existsSync(cand)) return cand;
    }
  }
  return '/mnt/projects/tools/Godot_v4.6.3-stable_linux.x86_64';
}
export const GODOT_BIN = findGodot();

// Loud, actionable skip diagnostics: a gated suite skipping because of a
// missing prerequisite must say WHICH prerequisite and WHICH env var fixes
// it — a bare "n skipped" counter reads identically to a typo'd path.
for (const [what, path, env] of [
  ['Site01 DEM', SITE01_DEM, 'LTS_SITE01_DEM'],
  ['LDEM_75S label', LDEM_75S_LBL, 'LTS_LDEM_75S'],
  ['Godot binary', GODOT_BIN, 'LTS_GODOT'],
] as const) {
  if (!existsSync(path)) {
    console.warn(
      `[tests/paths] ${what} not found at ${path} — dependent suites will ` +
        `skip. Fetch data with scripts/fetch-data.sh and/or set ${env}.`,
    );
  }
}
