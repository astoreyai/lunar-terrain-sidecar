/**
 * Binary PCK reader for Type 2 segments — JPL's numerically integrated lunar
 * orientation (`moon_pa_de440_200625.bpc`).
 *
 * A binary PCK is a DAF with LOCIDW "DAF/PCK". Summary layout (ND=2, NI=5,
 * per NAIF `pck.req`):
 *
 *   doubles: [ startEt, endEt ]                — TDB seconds past J2000
 *   ints:    [ bodyClassId, frame, type, initialAddr, finalAddr ]
 *
 * `bodyClassId` is the frame class ID (31008 = MOON_PA_DE440), `frame` the
 * integer code of the base frame (1 = J2000). Type 2 records are structurally
 * identical to SPK Type 2, but the three Chebyshev component sets are the
 * **3-1-3 Euler angles φ, δ, w of the body frame relative to J2000, in
 * radians** (w accumulates without wrapping — thousands of radians by 2030).
 * The angle *rates* are available by differentiating the same polynomials;
 * the solar-geometry path needs only the angles, so no derivative evaluator
 * is implemented.
 */

import { DafFile, SpiceKernelError } from './daf.js';
import { evaluateType2, readType2Directory } from './spk.js';

/** Frame class ID of the DE440 lunar Principal Axes frame. */
export const MOON_PA_DE440_CLASS_ID = 31008;

/** One binary-PCK segment as summarised in the DAF. */
export interface PckSegment {
  startEt: number;
  endEt: number;
  bodyClassId: number;
  frame: number;
  dataType: number;
  initialAddr: number;
  finalAddr: number;
}

/** 3-1-3 Euler angles of a body-fixed frame relative to its base frame. */
export interface PckEulerAngles {
  /** First rotation about Z, radians. */
  phiRad: number;
  /** Second rotation about X, radians. */
  deltaRad: number;
  /** Third rotation about Z (prime-meridian angle), radians, unwrapped. */
  wRad: number;
}

/** A binary PCK file restricted to Type 2 segments. */
export class BinaryPckFile {
  readonly daf: DafFile;
  readonly segments: PckSegment[];
  private readonly directories = new Map<PckSegment, { init: number; intlen: number; rsize: number; n: number }>();

  constructor(daf: DafFile) {
    if (daf.locidw !== 'DAF/PCK') {
      throw new SpiceKernelError(
        'SPICE_UNSUPPORTED_FORMAT',
        `${daf.path} is ${daf.locidw}, not DAF/PCK`,
        { path: daf.path, locidw: daf.locidw },
      );
    }
    this.daf = daf;
    this.segments = daf.summaries().map((s) => ({
      startEt: s.doubles[0],
      endEt: s.doubles[1],
      bodyClassId: s.ints[0],
      frame: s.ints[1],
      dataType: s.ints[2],
      initialAddr: s.ints[3],
      finalAddr: s.ints[4],
    }));
  }

  static open(path: string): BinaryPckFile {
    return new BinaryPckFile(DafFile.open(path));
  }

  /**
   * 3-1-3 Euler angles of the frame with class ID `bodyClassId` relative to
   * its base frame at `etSec` (TDB seconds past J2000).
   */
  eulerAngles(bodyClassId: number, etSec: number): PckEulerAngles {
    const candidates = this.segments.filter((s) => s.bodyClassId === bodyClassId);
    if (candidates.length === 0) {
      throw new SpiceKernelError(
        'SPICE_SEGMENT_NOT_FOUND',
        `no PCK segment for frame class ID ${bodyClassId} in ${this.daf.path}`,
        { bodyClassId, path: this.daf.path },
      );
    }
    const seg = candidates.find((s) => etSec >= s.startEt && etSec <= s.endEt) ?? candidates[0];
    if (seg.dataType !== 2) {
      throw new SpiceKernelError(
        'SPICE_UNSUPPORTED_TYPE',
        `PCK segment for ${bodyClassId} in ${this.daf.path} is type ${seg.dataType}; ` +
          `only Type 2 (Chebyshev Euler angles) is implemented`,
        { dataType: seg.dataType, bodyClassId },
      );
    }
    let dir = this.directories.get(seg);
    if (!dir) {
      dir = readType2Directory(this.daf, seg);
      this.directories.set(seg, dir);
    }
    const [phiRad, deltaRad, wRad] = evaluateType2(
      this.daf,
      seg,
      dir,
      etSec,
      `PCK frame ${bodyClassId}`,
    );
    return { phiRad, deltaRad, wRad };
  }
}
