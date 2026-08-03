/**
 * SPK (Spacecraft and Planet Kernel) reader for Type 2 segments — the
 * Chebyshev-position type every DE planetary ephemeris ships.
 *
 * Segment summary layout (ND=2, NI=6, per NAIF `spk.req`):
 *
 *   doubles: [ startEt, endEt ]                       — TDB seconds past J2000
 *   ints:    [ target, center, frame, type, initialAddr, finalAddr ]
 *
 * Type 2 segment data: N logical records of RSIZE doubles each, then a
 * four-double directory trailer `[ INIT, INTLEN, RSIZE, N ]` ending at
 * `finalAddr`. Each record is
 *
 *   [ MID, RADIUS, x-coeffs…, y-coeffs…, z-coeffs… ]
 *
 * with (RSIZE − 2)/3 Chebyshev coefficients per component, evaluated at
 * normalised time τ = (et − MID)/RADIUS ∈ [−1, 1] via the Clenshaw
 * recurrence. Positions are kilometres.
 */

import type { Vec3 } from '../vec.js';
import { DafFile, SpiceKernelError } from './daf.js';

/** One SPK segment as summarised in the DAF. */
export interface SpkSegment {
  /** Coverage start/end, TDB seconds past J2000. */
  startEt: number;
  endEt: number;
  /** NAIF integer codes. */
  target: number;
  center: number;
  frame: number;
  dataType: number;
  initialAddr: number;
  finalAddr: number;
}

/** Cached Type 2 directory trailer. */
interface Type2Directory {
  init: number;
  intlen: number;
  rsize: number;
  n: number;
}

/** Sum a Chebyshev series with the Clenshaw recurrence. */
export function chebyshevClenshaw(coeffs: Float64Array, offset: number, n: number, x: number): number {
  let b1 = 0;
  let b2 = 0;
  const x2 = 2 * x;
  for (let k = n - 1; k >= 1; k--) {
    const b0 = x2 * b1 - b2 + coeffs[offset + k];
    b2 = b1;
    b1 = b0;
  }
  return x * b1 - b2 + coeffs[offset];
}

/** Read the `[INIT, INTLEN, RSIZE, N]` trailer of a Type 2 segment. */
export function readType2Directory(daf: DafFile, seg: { initialAddr: number; finalAddr: number }): Type2Directory {
  const t = daf.readDoubles(seg.finalAddr - 3, seg.finalAddr);
  return { init: t[0], intlen: t[1], rsize: t[2], n: t[3] };
}

/**
 * Evaluate the three Chebyshev components of a Type 2 record at `et`.
 * Shared by SPK (position, km) and binary PCK (Euler angles, radians) — the
 * record structure is identical (`pck.req`: "Type 2 PCK segments use the same
 * format as Type 2 SPK segments").
 */
export function evaluateType2(
  daf: DafFile,
  seg: { startEt: number; endEt: number; initialAddr: number; finalAddr: number },
  dir: Type2Directory,
  etSec: number,
  what: string,
): Vec3 {
  if (etSec < seg.startEt || etSec > seg.endEt) {
    throw new SpiceKernelError(
      'SPICE_COVERAGE',
      `${what}: epoch ${etSec} s TDB past J2000 is outside this kernel's coverage ` +
        `[${seg.startEt}, ${seg.endEt}] (${daf.path})`,
      { etSec, startEt: seg.startEt, endEt: seg.endEt, path: daf.path },
    );
  }
  // Record index by uniform interval; the final interval is closed at endEt.
  let idx = Math.floor((etSec - dir.init) / dir.intlen);
  if (idx >= dir.n) idx = dir.n - 1;
  if (idx < 0) idx = 0;

  const recStart = seg.initialAddr + idx * dir.rsize;
  const rec = daf.readDoubles(recStart, recStart + dir.rsize - 1);
  const mid = rec[0];
  const radius = rec[1];
  const nCoef = (dir.rsize - 2) / 3;
  const tau = (etSec - mid) / radius;

  return [
    chebyshevClenshaw(rec, 2, nCoef, tau),
    chebyshevClenshaw(rec, 2 + nCoef, nCoef, tau),
    chebyshevClenshaw(rec, 2 + 2 * nCoef, nCoef, tau),
  ];
}

/** Commonly needed NAIF body codes. */
export const NAIF_CODES = {
  SOLAR_SYSTEM_BARYCENTER: 0,
  EARTH_MOON_BARYCENTER: 3,
  SUN: 10,
  MOON: 301,
  EARTH: 399,
} as const;

/** An SPK ephemeris file restricted to Type 2 segments. */
export class SpkFile {
  readonly daf: DafFile;
  readonly segments: SpkSegment[];
  private readonly directories = new Map<SpkSegment, Type2Directory>();
  /** target code → segments providing it, for the chaining walk. */
  private readonly byTarget = new Map<number, SpkSegment[]>();

  constructor(daf: DafFile) {
    if (daf.locidw !== 'DAF/SPK') {
      throw new SpiceKernelError(
        'SPICE_UNSUPPORTED_FORMAT',
        `${daf.path} is ${daf.locidw}, not DAF/SPK`,
        { path: daf.path, locidw: daf.locidw },
      );
    }
    this.daf = daf;
    this.segments = daf.summaries().map((s) => ({
      startEt: s.doubles[0],
      endEt: s.doubles[1],
      target: s.ints[0],
      center: s.ints[1],
      frame: s.ints[2],
      dataType: s.ints[3],
      initialAddr: s.ints[4],
      finalAddr: s.ints[5],
    }));
    for (const seg of this.segments) {
      const list = this.byTarget.get(seg.target);
      if (list) list.push(seg);
      else this.byTarget.set(seg.target, [seg]);
    }
  }

  static open(path: string): SpkFile {
    return new SpkFile(DafFile.open(path));
  }

  private directory(seg: SpkSegment): Type2Directory {
    let dir = this.directories.get(seg);
    if (!dir) {
      dir = readType2Directory(this.daf, seg);
      this.directories.set(seg, dir);
    }
    return dir;
  }

  /** Position of `seg.target` relative to `seg.center` at `etSec`, km, J2000. */
  private evaluateSegment(seg: SpkSegment, etSec: number): Vec3 {
    if (seg.dataType !== 2) {
      throw new SpiceKernelError(
        'SPICE_UNSUPPORTED_TYPE',
        `SPK segment ${seg.target}←${seg.center} in ${this.daf.path} is type ${seg.dataType}; ` +
          `only Type 2 (Chebyshev position) is implemented`,
        { dataType: seg.dataType, target: seg.target, center: seg.center },
      );
    }
    return evaluateType2(
      this.daf,
      seg,
      this.directory(seg),
      etSec,
      `SPK ${seg.target}←${seg.center}`,
    );
  }

  /**
   * Position of `code` relative to the solar-system barycenter, km, J2000,
   * by walking the segment chain (e.g. Moon 301 → EMB 3 → SSB 0).
   */
  positionRelativeToSsbKm(code: number, etSec: number): Vec3 {
    let x = 0;
    let y = 0;
    let z = 0;
    let current = code;
    const visited = new Set<number>();
    while (current !== NAIF_CODES.SOLAR_SYSTEM_BARYCENTER) {
      if (visited.has(current)) {
        throw new SpiceKernelError(
          'SPICE_SEGMENT_NOT_FOUND',
          `segment chain for body ${code} loops at ${current} in ${this.daf.path}`,
          { code, current },
        );
      }
      visited.add(current);
      const segs = this.byTarget.get(current);
      const seg = segs?.find((s) => etSec >= s.startEt && etSec <= s.endEt) ?? segs?.[0];
      if (!seg) {
        throw new SpiceKernelError(
          'SPICE_SEGMENT_NOT_FOUND',
          `no SPK segment provides body ${current} (needed for ${code}→SSB) in ${this.daf.path}`,
          { code, missing: current, path: this.daf.path },
        );
      }
      const p = this.evaluateSegment(seg, etSec);
      x += p[0];
      y += p[1];
      z += p[2];
      current = seg.center;
    }
    return [x, y, z];
  }

  /**
   * Position of `targetCode` relative to `centerCode` at `etSec` (TDB seconds
   * past J2000), kilometres, J2000 frame. Chains through the barycenters:
   * Moon relative to Sun = (EB→Moon + SSB→EB) − SSB→Sun.
   */
  positionKm(targetCode: number, centerCode: number, etSec: number): Vec3 {
    const t = this.positionRelativeToSsbKm(targetCode, etSec);
    if (centerCode === NAIF_CODES.SOLAR_SYSTEM_BARYCENTER) return t;
    const c = this.positionRelativeToSsbKm(centerCode, etSec);
    return [t[0] - c[0], t[1] - c[1], t[2] - c[2]];
  }
}
