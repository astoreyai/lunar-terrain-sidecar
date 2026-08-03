/** Angle helpers. Internals are radians; degrees appear only at API boundaries. */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
/** Arcseconds to radians. */
export const ARCSEC = DEG / 3600;

export function toRad(deg: number): number {
  return deg * DEG;
}

export function toDeg(rad: number): number {
  return rad * RAD;
}

/** Normalise degrees to [0, 360). */
export function norm360(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** Normalise radians to [0, 2π). */
export function norm2pi(rad: number): number {
  const twoPi = 2 * Math.PI;
  const r = rad % twoPi;
  return r < 0 ? r + twoPi : r;
}

/** Normalise degrees to (−180, 180]. */
export function norm180(deg: number): number {
  let r = norm360(deg);
  if (r > 180) r -= 360;
  return r;
}

export function sinDeg(deg: number): number {
  return Math.sin(deg * DEG);
}

export function cosDeg(deg: number): number {
  return Math.cos(deg * DEG);
}
