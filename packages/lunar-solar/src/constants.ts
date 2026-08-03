/**
 * Physical constants for the lunar solar model.
 *
 * Kept local to this package so `@lts/lunar-solar` stays dependency-free and
 * usable on its own; the value is identical to the one in `@lts/shared-types`
 * and a test asserts the two agree.
 */

/**
 * Lunar reference sphere radius, metres.
 *
 * 1 737 400 m — the datum of the LOLA gridded data records
 * (PDS `LRO-L-LOLA-4-GDR-V1.0`, `OFFSET = 1737400.0`) and of the PGDA polar
 * stereographic site DEMs.
 */
export const LUNAR_REFERENCE_RADIUS_M = 1_737_400.0;

/**
 * Obliquity of the lunar equator to the ecliptic, degrees.
 *
 * 1.5424° (Archinal et al. 2011). This is why the sub-solar latitude, and
 * hence the solar elevation at a lunar pole, is confined to ±1.54°.
 */
export const LUNAR_OBLIQUITY_TO_ECLIPTIC_DEG = 1.5424;

/** Mean synodic month, days — the lunar solar day. */
export const SYNODIC_MONTH_DAYS = 29.530588861;

/** Draconic (eclipse) year, days — the period of the sub-solar latitude cycle. */
export const DRACONIC_YEAR_DAYS = 346.620076;

/** Lunar nodal precession period, years — the span a true PSR study must cover. */
export const LUNAR_NODAL_PERIOD_YEARS = 18.613;
