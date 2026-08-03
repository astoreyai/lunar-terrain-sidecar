/**
 * Time scales for the solar model.
 *
 * The ephemeris expressions are functions of **Terrestrial Time (TT)**, but the
 * user supplies **UTC**. The chain is
 *
 *     TT = TAI + 32.184 s,   TAI = UTC + ΔAT (integer leap seconds)
 *
 * Getting this wrong costs ~70 s of time argument. That is negligible for the
 * Sun (0.0008°) but not for the Moon's fast-moving longitude (~0.0004°/s → the
 * Moon moves ~0.011° in 70 s), and the lunar prime meridian W advances
 * 13.176°/day, i.e. ~0.011° in 70 s. Both matter at the accuracy this module
 * claims, so the leap seconds are carried explicitly rather than ignored.
 */

/** Julian Date of the J2000.0 epoch. */
export const JD_J2000 = 2451545.0;
/** Days per Julian century. */
export const DAYS_PER_JULIAN_CENTURY = 36525.0;
/** TT − TAI, seconds (fixed by definition). */
export const TT_MINUS_TAI_S = 32.184;

/**
 * IERS leap-second table: [UTC ISO instant of introduction, TAI−UTC seconds].
 *
 * Source: IERS Bulletin C / `tai-utc.dat`. The list is complete through the last
 * leap second introduced, 2017-01-01 (ΔAT = 37 s). No leap second has been
 * introduced since; {@link deltaAT} therefore holds 37 s for all later dates,
 * which is correct as of the 2026 build date and will remain correct until IERS
 * announces another. Dates before 1972 are outside the table and clamp to 10 s;
 * this module is not intended for pre-1972 epochs.
 */
const LEAP_SECONDS: ReadonlyArray<readonly [string, number]> = [
  ['1972-01-01T00:00:00Z', 10],
  ['1972-07-01T00:00:00Z', 11],
  ['1973-01-01T00:00:00Z', 12],
  ['1974-01-01T00:00:00Z', 13],
  ['1975-01-01T00:00:00Z', 14],
  ['1976-01-01T00:00:00Z', 15],
  ['1977-01-01T00:00:00Z', 16],
  ['1978-01-01T00:00:00Z', 17],
  ['1979-01-01T00:00:00Z', 18],
  ['1980-01-01T00:00:00Z', 19],
  ['1981-07-01T00:00:00Z', 20],
  ['1982-07-01T00:00:00Z', 21],
  ['1983-07-01T00:00:00Z', 22],
  ['1985-07-01T00:00:00Z', 23],
  ['1988-01-01T00:00:00Z', 24],
  ['1990-01-01T00:00:00Z', 25],
  ['1991-01-01T00:00:00Z', 26],
  ['1992-07-01T00:00:00Z', 27],
  ['1993-07-01T00:00:00Z', 28],
  ['1994-07-01T00:00:00Z', 29],
  ['1996-01-01T00:00:00Z', 30],
  ['1997-07-01T00:00:00Z', 31],
  ['1999-01-01T00:00:00Z', 32],
  ['2006-01-01T00:00:00Z', 33],
  ['2009-01-01T00:00:00Z', 34],
  ['2012-07-01T00:00:00Z', 35],
  ['2015-07-01T00:00:00Z', 36],
  ['2017-01-01T00:00:00Z', 37],
];

const LEAP_TABLE_MS: ReadonlyArray<readonly [number, number]> = LEAP_SECONDS.map(
  ([iso, dat]) => [Date.parse(iso), dat] as const,
);

/** TAI − UTC in seconds at the given UTC instant. */
export function deltaAT(utc: Date): number {
  const ms = utc.getTime();
  let dat = LEAP_TABLE_MS[0][1];
  for (const [t, v] of LEAP_TABLE_MS) {
    if (ms >= t) dat = v;
    else break;
  }
  return dat;
}

/** Julian Date (UTC-based) of a JavaScript Date. */
export function julianDateUTC(utc: Date): number {
  return utc.getTime() / 86_400_000 + 2440587.5;
}

/** Julian Date in Terrestrial Time. */
export function julianDateTT(utc: Date): number {
  return julianDateUTC(utc) + (deltaAT(utc) + TT_MINUS_TAI_S) / 86400;
}

/** Julian centuries of TT since J2000.0. */
export function centuriesTT(utc: Date): number {
  return (julianDateTT(utc) - JD_J2000) / DAYS_PER_JULIAN_CENTURY;
}

/** Days of TT since J2000.0 — the `d` argument of the IAU rotation model. */
export function daysTT(utc: Date): number {
  return julianDateTT(utc) - JD_J2000;
}

/** Parse an ISO-8601 instant, rejecting anything JavaScript cannot resolve. */
export function parseInstant(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ISO-8601 instant: ${JSON.stringify(iso)}`);
  }
  return d;
}
