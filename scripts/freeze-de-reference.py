#!/mnt/projects/ephem/.venv/bin/python
"""Freeze an independent DE440 reference for tests/lunar-solar.de.test.ts.

Generates tests/data/de-reference.json from the REAL kernels in
/mnt/projects/datasets/spice_kernels using the validated oracle environment
(/mnt/projects/ephem/.venv: jplephem 2.24 + spiceypy, validated to 0.02 arcsec
against JPL Horizons). The shipped vitest suite runs OFFLINE from the frozen
file; this script is only re-run to regenerate the fixture.

Per epoch (24 epochs spanning 2020-2049):
  - etSec: TDB seconds past J2000, from CSPICE str2et (real leap-second
    kernel). The TypeScript tests evaluate their Chebyshev readers at this
    exact number, so the UTC->TDB conversion is NOT part of tests (a)/(b) —
    it is exercised separately by the end-to-end DE-vs-analytic comparison.
  - moonToSunUnitJ2000: geometric Moon->Sun unit vector from jplephem reading
    de440s.bsp DIRECTLY (chaining SSB->EMB->Moon and SSB->Sun; raw kernel
    Chebyshev evaluation, no Skyfield apparent-place machinery, no light
    time, no aberration).
  - paAnglesRad: 3-1-3 Euler angles (phi, delta, w) of MOON_PA_DE440 relative
    to J2000, radians, from jplephem.pck reading moon_pa_de440_200625.bpc
    directly. (jplephem.pck import was checked and is available; the Skyfield
    PlanetaryConstants fallback was therefore not needed.)
  - j2000ToPaMatrix / j2000ToMeMatrix: row-major 3x3 rotation matrices from
    CSPICE pxform, as an independent second implementation pinning the Euler
    -angle and TKFRAME conventions.

Top level additionally freezes paToMeMatrix (the constant
MOON_PA_DE440 -> MOON_ME_DE440_ME421 rotation from moon_de440_250416.tf, via
CSPICE) and provenance (kernel filenames + sha256 prefixes + tool versions).

Precision notes:
  - jplephem is driven with a two-part Julian date (2451545.0, et/86400) so
    the epoch is carried to ~1e-7 s; the resulting direction error is
    < 1e-12 rad, well under the 1e-9 rad test tolerance.
  - CSPICE matrices agree with a direct evaluation of the same Chebyshev
    polynomials to ~1e-13, also well under tolerance.
"""

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as sp
from jplephem.pck import PCK
from jplephem.spk import SPK

KDIR = Path('/mnt/projects/datasets/spice_kernels')
SPK_FILE = KDIR / 'de440s.bsp'
PCK_FILE = KDIR / 'moon_pa_de440_200625.bpc'
TF_FILE = KDIR / 'moon_de440_250416.tf'
LSK_FILE = KDIR / 'naif0012.tls'
OUT = Path(__file__).resolve().parent.parent / 'tests' / 'data' / 'de-reference.json'

J2000_JD = 2451545.0
MOON_PA_DE440_CLASS_ID = 31008


def sha256_prefix(path: Path, n: int = 16) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:n]


def epochs_utc() -> list[str]:
    """24 deterministic UTC instants spanning 2020-2049.

    15-month spacing covers the 30-year span; day-of-month and hour are
    varied so the samples do not alias against the synodic month or the
    Chebyshev record boundaries (which are uniform in ET).
    """
    out = []
    year, month = 2020, 1
    for i in range(24):
        day = 3 + (i * 7) % 25          # 3..27
        hour = (i * 5) % 24
        out.append(f'{year:04d}-{month:02d}-{day:02d}T{hour:02d}:30:00Z')
        month += 15
        while month > 12:
            month -= 12
            year += 1
    return out


def main() -> None:
    for p in (SPK_FILE, PCK_FILE, TF_FILE, LSK_FILE):
        if not p.exists():
            sys.exit(f'missing kernel: {p}')

    sp.furnsh(str(LSK_FILE))
    sp.furnsh(str(SPK_FILE))
    sp.furnsh(str(PCK_FILE))
    sp.furnsh(str(TF_FILE))

    spk = SPK.open(str(SPK_FILE))
    seg_emb = spk[0, 3]      # SSB -> Earth-Moon barycenter
    seg_moon = spk[3, 301]   # EMB -> Moon
    seg_sun = spk[0, 10]     # SSB -> Sun
    pck = PCK.open(str(PCK_FILE))
    pa_seg = next(s for s in pck.segments if s.body == MOON_PA_DE440_CLASS_ID)

    records = []
    for utc in epochs_utc():
        et = float(sp.str2et(utc.replace('Z', '')))  # UTC -> TDB s past J2000
        jd2 = et / 86400.0

        # --- jplephem, raw kernel reads, two-part JD for precision ---
        moon_ssb = seg_emb.compute(J2000_JD, jd2) + seg_moon.compute(J2000_JD, jd2)
        sun_ssb = seg_sun.compute(J2000_JD, jd2)
        m2s = sun_ssb - moon_ssb
        unit = m2s / np.linalg.norm(m2s)

        angles, _rates = pa_seg.compute(J2000_JD, jd2)
        phi, delta, w = (float(a) for a in angles)

        # --- CSPICE second opinion on the frame matrices ---
        m_pa = np.array(sp.pxform('J2000', 'MOON_PA_DE440', et))
        m_me = np.array(sp.pxform('J2000', 'MOON_ME_DE440_ME421', et))

        records.append({
            'utc': utc,
            'etSec': et,
            'moonToSunUnitJ2000': [float(v) for v in unit],
            'moonToSunKm': [float(v) for v in m2s],
            'paAnglesRad': {'phi': phi, 'delta': delta, 'w': w},
            'j2000ToPaMatrix': [float(v) for v in m_pa.flatten()],
            'j2000ToMeMatrix': [float(v) for v in m_me.flatten()],
        })

    pa_to_me = np.array(sp.pxform('MOON_PA_DE440', 'MOON_ME_DE440_ME421',
                                  records[0]['etSec']))

    import jplephem
    import skyfield

    doc = {
        'provenance': {
            'description':
                'Frozen DE440 reference for tests/lunar-solar.de.test.ts. '
                'Generated by scripts/freeze-de-reference.py from the real JPL '
                'kernels; the vitest suite runs offline from this file.',
            'generatedUtc': datetime.now(timezone.utc).isoformat(),
            'kernels': {
                SPK_FILE.name: {'sha256_16': sha256_prefix(SPK_FILE)},
                PCK_FILE.name: {'sha256_16': sha256_prefix(PCK_FILE)},
                TF_FILE.name: {'sha256_16': sha256_prefix(TF_FILE)},
                LSK_FILE.name: {'sha256_16': sha256_prefix(LSK_FILE)},
            },
            'tools': {
                'python': sys.version.split()[0],
                'jplephem': jplephem.__version__,
                'skyfield': skyfield.__version__,
                'cspice': sp.tkvrsn('TOOLKIT'),
            },
            'conventions': {
                'moonToSunUnitJ2000':
                    'geometric (no light time), jplephem chaining '
                    '(SSB->EMB)+(EMB->Moon), (SSB->Sun), J2000 frame',
                'paAnglesRad':
                    '3-1-3 Euler angles of MOON_PA_DE440 rel. J2000 from '
                    'jplephem.pck; J2000->PA = [w]_3 [delta]_1 [phi]_3',
                'matrices': 'row-major, from CSPICE pxform',
            },
        },
        'paToMeMatrix': [float(v) for v in pa_to_me.flatten()],
        'epochs': records,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    print(f'wrote {OUT} ({OUT.stat().st_size} bytes, {len(records)} epochs)')

    # Self-check: jplephem angles must reproduce the CSPICE PA matrix.
    def rz(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])

    def rx(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[1, 0, 0], [0, c, s], [0, -s, c]])

    worst = 0.0
    for r in records:
        a = r['paAnglesRad']
        m = rz(a['w']) @ rx(a['delta']) @ rz(a['phi'])
        worst = max(worst, float(np.max(np.abs(
            m - np.array(r['j2000ToPaMatrix']).reshape(3, 3)))))
    print(f'self-check: max |jplephem-angle matrix - CSPICE pxform| = {worst:.3e}')
    if worst > 1e-11:
        sys.exit('self-check FAILED: angle/matrix conventions disagree')


if __name__ == '__main__':
    main()
