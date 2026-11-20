export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function pathLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Catmull-Rom spline through every control point, sampled about every `stepMm`.
 * Endpoints are duplicated so the curve starts and ends on the first and last points.
 */
export function catmullRom(pts: Vec2[], stepMm = 0.3): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const p = [pts[0], ...pts, pts[pts.length - 1]];
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    const n = Math.max(2, Math.ceil(dist(p1, p2) / stepMm));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/**
 * Points on an elliptical arc. Angles are in degrees in the page frame (y down),
 * so 0 points right and 90 points down the page.
 */
export function arc(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, steps = 0): Vec2[] {
  const n = steps || Math.max(4, Math.ceil(Math.abs(toDeg - fromDeg) / 12));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}
