/**
 * `@lts/lunar-solar` — accurate solar geometry on the Moon.
 *
 * Entry points most callers want:
 *   - {@link solarPositionAtSite} — azimuth and elevation at a selenographic site
 *   - {@link subSolarPoint} — where the Sun is overhead on the Moon
 *   - {@link horizonProfile} / {@link isSunlit} — terrain shadowing from a real DEM
 *   - {@link illuminationStatistics} — PSR and average-illumination maps
 */

export * from './angles.js';
export * from './vec.js';
export * from './time.js';
export * from './sun.js';
export * from './moon.js';
export * from './moonTables.js';
export * from './precession.js';
export * from './lunarFrame.js';
export * from './solarGeometry.js';
export * from './constants.js';
export * from './horizon.js';
export * from './spice/index.js';
