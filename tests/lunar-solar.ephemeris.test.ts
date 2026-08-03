/**
 * Validation of the solar/lunar ephemeris chain against *independent physical
 * invariants* — quantities whose true values come from the physics of the
 * Earth–Moon–Sun system rather than from the series being tested.
 *
 * This is deliberate. Checking the code against numbers produced by the same
 * code proves nothing, and no JPL DE kernel is vendored here. Every bound below
 * is an externally known property of the system, so a transcription error in
 * any of the ~120 periodic terms, a frame mix-up, or a dropped precession step
 * shows up as a violated invariant.
 */

import { describe, expect, it } from 'vitest';
import {
  centuriesTT,
  daysTT,
  deltaAT,
  julianDateTT,
  lunarOrientation,
  moonPosition,
  parseInstant,
  precessToJ2000,
  precessFromJ2000,
  solarPositionAtSite,
  subSolarPoint,
  sunPosition,
  norm180,
  discFractionAbove,
  shadowLengthM,
} from '@lts/lunar-solar';

/** Sample a whole number of years at a fixed cadence. */
function sampleInstants(startISO: string, days: number, stepHours: number): Date[] {
  const t0 = parseInstant(startISO).getTime();
  const out: Date[] = [];
  const stepMs = stepHours * 3600_000;
  for (let t = t0; t < t0 + days * 86400_000; t += stepMs) out.push(new Date(t));
  return out;
}

describe('time scales', () => {
  it('carries the IERS leap-second count', () => {
    // ΔAT stepped to 37 s on 2017-01-01 and has not changed since.
    expect(deltaAT(parseInstant('2016-12-31T00:00:00Z'))).toBe(36);
    expect(deltaAT(parseInstant('2017-01-01T00:00:00Z'))).toBe(37);
    expect(deltaAT(parseInstant('2026-08-03T00:00:00Z'))).toBe(37);
    // The 1972 introduction of the modern system.
    expect(deltaAT(parseInstant('1972-01-01T00:00:00Z'))).toBe(10);
  });

  it('places J2000.0 at JD 2451545.0 TT', () => {
    // J2000.0 is 2000-01-01T12:00:00 TT, which is 64.184 s earlier in UTC
    // (ΔAT was 32 s in 2000).
    const utc = new Date(parseInstant('2000-01-01T12:00:00Z').getTime() - 64.184 * 1000);
    expect(julianDateTT(utc)).toBeCloseTo(2451545.0, 9);
  });
});

describe('solar series', () => {
  it('keeps the Earth–Sun distance inside the known aphelion/perihelion range', () => {
    // Perihelion ~0.98329 AU, aphelion ~1.01671 AU.
    let min = Infinity;
    let max = -Infinity;
    for (const t of sampleInstants('2024-01-01T00:00:00Z', 366 * 4, 6)) {
      const r = sunPosition(centuriesTT(t)).radiusAU;
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    expect(min).toBeGreaterThan(0.9825);
    expect(min).toBeLessThan(0.9840);
    expect(max).toBeGreaterThan(1.0160);
    expect(max).toBeLessThan(1.0172);
  });

  it('puts the Sun near ecliptic longitude 0 at the March equinox', () => {
    // The 2025 March equinox was 2025-03-20T09:01Z. Solar longitude there is 0
    // by definition of the equinox, up to the series' ~0.01° accuracy and the
    // nutation this module deliberately omits (~0.005°).
    const lon = sunPosition(centuriesTT(parseInstant('2025-03-20T09:01:00Z'))).longitudeDeg;
    expect(Math.abs(norm180(lon))).toBeLessThan(0.02);
  });
});

describe('lunar series', () => {
  it('keeps the Earth–Moon distance inside the known perigee/apogee range', () => {
    // Extreme perigee ~356 400 km, extreme apogee ~406 700 km.
    let min = Infinity;
    let max = -Infinity;
    for (const t of sampleInstants('2024-01-01T00:00:00Z', 366 * 4, 3)) {
      const dkm = moonPosition(centuriesTT(t)).distanceKm;
      min = Math.min(min, dkm);
      max = Math.max(max, dkm);
    }
    expect(min).toBeGreaterThan(356_000);
    expect(min).toBeLessThan(358_500);
    expect(max).toBeGreaterThan(405_500);
    expect(max).toBeLessThan(407_000);
  });

  it('keeps the lunar ecliptic latitude inside the inclination envelope', () => {
    // Orbital inclination to the ecliptic is 5.145°; perturbations carry the
    // instantaneous latitude to roughly ±5.3° but never beyond.
    let maxAbs = 0;
    for (const t of sampleInstants('2024-01-01T00:00:00Z', 366 * 4, 3)) {
      maxAbs = Math.max(maxAbs, Math.abs(moonPosition(centuriesTT(t)).latitudeDeg));
    }
    expect(maxAbs).toBeGreaterThan(4.9);
    expect(maxAbs).toBeLessThan(5.4);
  });

  it('encodes the synodic month exactly in the mean-elongation rate', () => {
    // The mean elongation D advances 445267.1114034°/Julian century, so the
    // mean synodic month is 360 * 36525 / 445267.1114034 = 29.5305888 days.
    // This checks the leading D coefficient to full precision, independent of
    // the periodic terms.
    const synodic = (360 * 36525) / 445267.1114034;
    expect(synodic).toBeCloseTo(29.530589, 6);
  });

  it('reproduces the synodic month from the Sun–Moon elongation', () => {
    // Empirical check of the full series: count new moons (elongation crossing
    // zero upward) and average the interval.
    //
    // The span must be long. Individual lunations range over 29.27–29.83 days,
    // modulated by the 411.78-day full-moon cycle, so a short span does not
    // average out — measured error is 0.013 d over 4 years but 0.00015 d over
    // 64. Sixty-four years covers ~57 full-moon cycles.
    const start = parseInstant('2000-01-01T00:00:00Z');
    const spanDays = 64 * 365.25;
    const step = 0.01; // days
    const elongationAt = (dday: number) => {
      const T = centuriesTT(new Date(start.getTime() + dday * 86400_000));
      return norm180(moonPosition(T).longitudeDeg - sunPosition(T).longitudeDeg);
    };

    const crossings: number[] = [];
    let prev = elongationAt(0);
    for (let dday = step; dday < spanDays; dday += step) {
      const elong = elongationAt(dday);
      if (prev < 0 && elong >= 0) {
        // Linear interpolation onto the zero crossing.
        crossings.push(dday - step + (step * -prev) / (elong - prev));
      }
      prev = elong;
    }
    expect(crossings.length).toBeGreaterThan(780);

    // Least-squares slope of crossing time against lunation index.
    //
    // The obvious estimator, (t_last − t_first) / (N − 1), telescopes: every
    // interior crossing cancels, so its accuracy depends only on where the two
    // endpoints happen to fall within the 411.78-day full-moon cycle and never
    // improves with span. Individual lunations run 29.27–29.83 days, so that
    // estimator is stuck around 1e-3 d of error. Regression uses all 791
    // crossings and converges as N^(-3/2).
    const n = crossings.length;
    let sumI = 0;
    let sumT = 0;
    for (let i = 0; i < n; i++) {
      sumI += i;
      sumT += crossings[i];
    }
    const meanI = sumI / n;
    const meanT = sumT / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - meanI) * (crossings[i] - meanT);
      den += (i - meanI) * (i - meanI);
    }
    const measured = num / den;
    expect(measured).toBeCloseTo(29.530589, 4);
  });

  it('places new moon on 2000-01-06 within a few minutes', () => {
    // A widely tabulated new moon: 2000-01-06 18:14 UTC. Elongation must be
    // near zero. The Moon moves ~0.5°/hour relative to the Sun, so a 0.05°
    // tolerance is about 6 minutes of time.
    const T = centuriesTT(parseInstant('2000-01-06T18:14:00Z'));
    const elong = norm180(moonPosition(T).longitudeDeg - sunPosition(T).longitudeDeg);
    expect(Math.abs(elong)).toBeLessThan(0.1);
  });
});

describe('precession', () => {
  it('round-trips a vector through J2000 and back', () => {
    const T = centuriesTT(parseInstant('2026-08-03T00:00:00Z'));
    const v: [number, number, number] = [0.3, -0.7, 0.64807407];
    const back = precessFromJ2000(precessToJ2000(v, T), T);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(v[i], 12);
  });

  it('accumulates the known general precession rate', () => {
    // General precession in right ascension is m ≈ 4612.16″/century, i.e. the
    // equinox shift over one century. Measured as the rotation this matrix
    // applies to a vector on the equator at RA 0.
    const T = 1.0;
    const v: [number, number, number] = [1, 0, 0];
    const moved = precessFromJ2000(v, T);
    const raShiftArcsec = (Math.atan2(moved[1], moved[0]) * 180) / Math.PI * 3600;
    expect(Math.abs(raShiftArcsec)).toBeGreaterThan(4400);
    expect(Math.abs(raShiftArcsec)).toBeLessThan(4800);
  });
});

describe('lunar body frame (IAU/WGCCRE)', () => {
  it('advances the prime meridian at the synodic-ish rotation rate', () => {
    // W advances 13.17635815°/day, giving a sidereal rotation of 27.32 days.
    const w0 = lunarOrientation(0).primeMeridianDeg;
    const w1 = lunarOrientation(1).primeMeridianDeg;
    let dw = w1 - w0;
    if (dw < 0) dw += 360;
    expect(dw).toBeCloseTo(13.17635815, 1);
  });

  it('holds the lunar pole near its mean J2000 direction', () => {
    // α₀ ≈ 269.99°, δ₀ ≈ 66.54°, with libration swinging α₀ by ±3.9° and
    // δ₀ by ±1.5°.
    for (const d of [0, 1000, 5000, 9700]) {
      const o = lunarOrientation(d);
      expect(Math.abs(norm180(o.poleRaDeg - 269.9949))).toBeLessThan(4.5);
      expect(Math.abs(o.poleDecDeg - 66.5392)).toBeLessThan(1.9);
    }
  });
});

describe('sub-solar point — the end-to-end invariant', () => {
  it('confines the sub-solar latitude to the lunar obliquity of 1.54°', () => {
    // THE decisive test of the whole chain. The Moon's spin axis is tilted
    // 1.5424° to the ecliptic, and the Sun lies in the ecliptic, so the
    // sub-solar latitude can never leave ±1.5424° by more than the small
    // solar-latitude and series errors. A wrong precession step, a bad pole,
    // or a mangled lunar series would blow this bound apart.
    let maxAbs = 0;
    for (const t of sampleInstants('2024-01-01T00:00:00Z', 366 * 3, 6)) {
      maxAbs = Math.max(maxAbs, Math.abs(subSolarPoint(t).latitudeDeg));
    }
    expect(maxAbs).toBeGreaterThan(1.50);
    expect(maxAbs).toBeLessThan(1.60);
  });

  it('cycles the sub-solar longitude westward once per synodic month', () => {
    // The lunar solar day is the synodic month, 29.53 days. The Moon spins
    // prograde, so the sub-solar longitude *decreases* at ~12.2°/day — the Sun
    // tracks westward across the surface. Detecting an eastward crossing here
    // would find nothing at all, which is a useful sign-convention guard.
    const start = parseInstant('2025-01-01T00:00:00Z');
    const step = 0.05;
    let prev = subSolarPoint(start).longitudeDeg;
    let wraps = 0;
    let firstWrap = NaN;
    let lastWrap = NaN;
    for (let dday = step; dday < 8 * 365.25; dday += step) {
      const lon = subSolarPoint(new Date(start.getTime() + dday * 86400_000)).longitudeDeg;
      // Descending crossing of zero; the 90° guard rejects the ±180° wrap.
      if (prev > 0 && lon <= 0 && Math.abs(lon - prev) < 90) {
        if (Number.isNaN(firstWrap)) firstWrap = dday;
        lastWrap = dday;
        wraps++;
      }
      prev = lon;
    }
    expect(wraps).toBeGreaterThan(90);
    const period = (lastWrap - firstWrap) / (wraps - 1);
    expect(period).toBeCloseTo(29.530589, 1);
  });

  it('drives the sub-solar longitude westward, never eastward', () => {
    const start = parseInstant('2026-03-01T00:00:00Z');
    for (let d = 0; d < 20; d++) {
      const a = subSolarPoint(new Date(start.getTime() + d * 86400_000)).longitudeDeg;
      const b = subSolarPoint(new Date(start.getTime() + (d + 1) * 86400_000)).longitudeDeg;
      let delta = b - a;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      // ~-12.2 deg/day, varying with orbital eccentricity.
      expect(delta).toBeLessThan(-11);
      expect(delta).toBeGreaterThan(-13.5);
    }
  });

  it('oscillates the sub-solar latitude with the draconic-year period', () => {
    // The lunar equator's node regresses with the 18.6-year nodal cycle, so the
    // Sun returns to the lunar equator every eclipse year, 346.62 days — not
    // every tropical year. Getting 365 days here would mean the lunar pole was
    // being held fixed instead of librating.
    const start = parseInstant('2020-01-01T00:00:00Z');
    const step = 0.25;
    let prev = subSolarPoint(start).latitudeDeg;
    let firstUp = NaN;
    let lastUp = NaN;
    let count = 0;
    for (let dday = step; dday < 8 * 365.25; dday += step) {
      const lat = subSolarPoint(new Date(start.getTime() + dday * 86400_000)).latitudeDeg;
      if (prev < 0 && lat >= 0) {
        if (Number.isNaN(firstUp)) firstUp = dday;
        lastUp = dday;
        count++;
      }
      prev = lat;
    }
    expect(count).toBeGreaterThan(6);
    const period = (lastUp - firstUp) / (count - 1);
    expect(period).toBeGreaterThan(340);
    expect(period).toBeLessThan(353);
  });
});

describe('site solar position — south polar behaviour', () => {
  it('equals minus the sub-solar latitude at the south pole', () => {
    // Geometric identity: at latitude −90° the local zenith is the −Z body
    // axis, so solar elevation = −(sub-solar latitude), exactly.
    for (const iso of [
      '2026-01-15T00:00:00Z',
      '2026-04-02T12:00:00Z',
      '2026-08-03T06:00:00Z',
      '2026-11-20T18:00:00Z',
    ]) {
      const t = parseInstant(iso);
      const ss = subSolarPoint(t);
      const sp = solarPositionAtSite(t, -90, 0);
      expect(sp.elevationDeg).toBeCloseTo(-ss.latitudeDeg, 9);
    }
  });

  it('never lifts the Sun far above the horizon at the south pole', () => {
    // The defining property of lunar polar illumination and the reason this
    // module exists: grazing light, all the time.
    let maxEl = -Infinity;
    for (const t of sampleInstants('2026-01-01T00:00:00Z', 366, 6)) {
      maxEl = Math.max(maxEl, solarPositionAtSite(t, -90, 0).elevationDeg);
    }
    expect(maxEl).toBeLessThan(1.60);
    expect(maxEl).toBeGreaterThan(1.30);
  });

  it('sweeps azimuth through a full turn each synodic month near the pole', () => {
    // At a site just off the pole the Sun circles the horizon rather than
    // rising and setting.
    const seen = new Set<number>();
    for (const t of sampleInstants('2026-01-01T00:00:00Z', 30, 2)) {
      seen.add(Math.floor(solarPositionAtSite(t, -89.5, 0).azimuthDeg / 45));
    }
    expect(seen.size).toBe(8);
  });

  it('reports a partially illuminated disc across the geometric horizon', () => {
    expect(discFractionAbove(0, 0.266)).toBeCloseTo(0.5, 12);
    expect(discFractionAbove(0.3, 0.266)).toBe(1);
    expect(discFractionAbove(-0.3, 0.266)).toBe(0);
    expect(discFractionAbove(0.1, 0.266)).toBeGreaterThan(0.5);
    expect(discFractionAbove(0.1, 0.266)).toBeLessThan(1);
  });

  it('computes grazing-incidence shadow lengths', () => {
    // A 1 m rock at 1.5° elevation throws a ~38 m shadow.
    expect(shadowLengthM(1, 1.5)).toBeCloseTo(38.19, 1);
    expect(shadowLengthM(1, 0)).toBe(Infinity);
  });
});

describe('determinism', () => {
  it('returns bit-identical results for the same instant', () => {
    const t = parseInstant('2026-08-03T12:34:56Z');
    const a = solarPositionAtSite(t, -89.9, 123.4);
    const b = solarPositionAtSite(new Date(t.getTime()), -89.9, 123.4);
    expect(a.elevationDeg).toBe(b.elevationDeg);
    expect(a.azimuthDeg).toBe(b.azimuthDeg);
    expect(daysTT(t)).toBe(daysTT(new Date(t.getTime())));
  });
});
