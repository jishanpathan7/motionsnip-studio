// MotionSnip Scenes: small geometry and number helpers. Pure (no DOM), shared by every scene module.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, p) => a + (b - a) * p;
export const r2 = (v) => Math.round(v * 100) / 100;

// easing
export const ease = {
  linear: (p) => p,
  in: (p) => p * p * p,
  out: (p) => 1 - (1 - p) ** 3,
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  back: (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2, // overshoot, then settle
  spring: (p) => (p >= 1 ? 1 : 1 - Math.cos(p * Math.PI * 2.5) * Math.exp(-5 * p)),
};
export const easeOf = (name, fallback = 'inOut') => ease[name] || ease[fallback];

/** Constant speed in the middle, eased start and stop: a walk that doesn't skate. */
export function travel(p, a = 0.15) {
  p = clamp(p, 0, 1);
  const k = 1 / (2 * a * (1 - a));
  if (p < a) return p * p * k;
  if (p > 1 - a) return 1 - (1 - p) * (1 - p) * k;
  return (p - a / 2) / (1 - a);
}

/** A stable 32-bit hash of a string. */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded random numbers in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SVG path data → sub-paths of points: [{ pts: [[x, y]...], closed }]. M L H V C S Q T Z, absolute and relative. */
export function parsePath(d) {
  const toks = String(d || '').match(/[MmLlHhVvCcSsQqTtZzAa]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = '';
  let lc = null; // last control point, for S and T
  let i = 0;
  const n = () => Number(toks[i++]);
  const more = () => i < toks.length && !/[A-Za-z]/.test(toks[i]);
  const bez = (pts, steps = 12) => {
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      if (pts.length === 3) cur.pts.push([u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0], u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1]]);
      else
        cur.pts.push([
          u ** 3 * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t ** 3 * pts[3][0],
          u ** 3 * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t ** 3 * pts[3][1],
        ]);
    }
  };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === 'Z') {
      if (cur) {
        cur.closed = true;
        x = sx;
        y = sy;
      }
      lc = null;
      continue;
    }
    if (!more()) {
      i++;
      continue;
    }
    if (C === 'M') {
      x = ox + n();
      y = oy + n();
      sx = x;
      sy = y;
      cur = { pts: [[x, y]], closed: false };
      out.push(cur);
      cmd = rel ? 'l' : 'L';
      lc = null;
      continue;
    }
    if (!cur) {
      cur = { pts: [[x, y]], closed: false };
      out.push(cur);
    }
    if (C === 'L') {
      x = ox + n();
      y = oy + n();
      cur.pts.push([x, y]);
      lc = null;
    } else if (C === 'H') {
      x = ox + n();
      cur.pts.push([x, y]);
      lc = null;
    } else if (C === 'V') {
      y = oy + n();
      cur.pts.push([x, y]);
      lc = null;
    } else if (C === 'C' || C === 'S') {
      const c1 = C === 'C' ? [ox + n(), oy + n()] : lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
      const c2 = [ox + n(), oy + n()];
      const e = [ox + n(), oy + n()];
      bez([[x, y], c1, c2, e]);
      lc = c2;
      [x, y] = e;
    } else if (C === 'Q' || C === 'T') {
      const c = C === 'Q' ? [ox + n(), oy + n()] : lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
      const e = [ox + n(), oy + n()];
      bez([[x, y], c, e]);
      lc = c;
      [x, y] = e;
    } else if (C === 'A') {
      // arcs: drawn as a straight line to the end point (rare in hand-drawn shapes)
      for (let k = 0; k < 5; k++) n();
      x = ox + n();
      y = oy + n();
      cur.pts.push([x, y]);
      lc = null;
    } else i++;
  }
  return out.filter((s) => s.pts.length > 1);
}

export function bboxOf(subpaths) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of subpaths)
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return Number.isFinite(x0) ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 1, 1];
}

/** Two-bone IK: the middle joint for a limb from `a` to target `t`, bending to the side `bend` (+1/-1). */
export function ik(a, t, l1, l2, bend = 1) {
  let dx = t[0] - a[0];
  let dy = t[1] - a[1];
  let d = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.001;
  if (d > max) {
    dx *= max / d;
    dy *= max / d;
    d = max;
  }
  d = Math.max(d, Math.abs(l1 - l2) + 0.001);
  const ang = Math.atan2(dy, dx);
  const c = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a1 = ang - bend * Math.acos(c);
  const mid = [a[0] + Math.cos(a1) * l1, a[1] + Math.sin(a1) * l1];
  const end = [a[0] + dx, a[1] + dy];
  return [mid, end];
}
