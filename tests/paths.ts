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
