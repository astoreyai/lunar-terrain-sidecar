/** Minimal 3-vector / 3x3-matrix maths. Dependency-free so the solar model runs headless. */

export type Vec3 = readonly [number, number, number];
/** Row-major 3x3 matrix: [r0c0, r0c1, r0c2, r1c0, ...]. */
export type Mat3 = readonly number[];

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) throw new Error('cannot normalize a zero vector');
  return [a[0] / n, a[1] / n, a[2] / n];
}

/** Apply a row-major 3x3 matrix to a vector. */
export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Transpose (== inverse for a rotation matrix). */
export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Rotation about X by `t` radians (right-handed). */
export function rotX(t: number): Mat3 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Rotation about Y by `t` radians (right-handed). */
export function rotY(t: number): Mat3 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Rotation about Z by `t` radians (right-handed). */
export function rotZ(t: number): Mat3 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Spherical (longitude, latitude, radius) to rectangular. Angles in radians. */
export function sphericalToRect(lon: number, lat: number, r: number): Vec3 {
  const cl = Math.cos(lat);
  return [r * cl * Math.cos(lon), r * cl * Math.sin(lon), r * Math.sin(lat)];
}
