// MotionSnip Scenes: one frame as an SVG string. A hand-drawn pen (seeded wobble that "boils" a few times a
// second), the person and robot rigs, the kit of props, speech bubbles, the camera and shot transitions.
// Pure (no DOM): the same t always gives the same string, so a frame grab, an export and the live view agree.

import { clamp, lerp, hash, rng, parsePath, bboxOf, ik } from './geom.mjs';
import { stateAt, sizeOf, personH, bubbleOf, arrowEnds, FLOOR } from './motion.mjs';
import { colorOf, fontFamily } from './compile.mjs';

const f = (v) => Math.round(v * 10) / 10;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------- the pen

function penFor(spec, t, id, e) {
  const st = spec.style;
  const u = spec.size[1] / 1080;
  const boil = st.boil ? Math.floor(t * st.boil) : 0;
  return { spec, u, amp: st.wobble * 2.2 * u, width: st.stroke * u, seed: (hash(id) + boil * 7919) >>> 0, ink: colorOf(spec, 'ink'), marker: st.preset === 'marker', draw: e ? e.draw : 1, k: 0 };
}

function wob(pts, pen, closed) {
  if (!pen.amp) return closed ? pts : pts;
  const step = 15 * pen.u;
  const r = rng(pen.seed + ++pen.k * 131);
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [];
  for (let i = 0; i < src.length - 1; i++) {
    const [a, b] = [src[i], src[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let j = 0; j < n; j++) out.push([lerp(a[0], b[0], j / n), lerp(a[1], b[1], j / n)]);
  }
  if (!closed) out.push(src[src.length - 1]);
  let ox = (r() - 0.5) * pen.amp;
  let oy = (r() - 0.5) * pen.amp;
  return out.map(([x, y]) => {
    ox = ox * 0.7 + (r() - 0.5) * pen.amp * 0.8;
    oy = oy * 0.7 + (r() - 0.5) * pen.amp * 0.8;
    return [x + ox, y + oy];
  });
}

function pathD(pts, closed) {
  if (pts.length < 2) return '';
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  if (pts.length === 2) return d + `L${f(pts[1][0])} ${f(pts[1][1])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f((pts[i][0] + pts[i + 1][0]) / 2)} ${f((pts[i][1] + pts[i + 1][1]) / 2)}`;
  const z = pts[pts.length - 1];
  return d + `L${f(z[0])} ${f(z[1])}` + (closed ? 'Z' : '');
}

const dash = (pen) => (pen.draw < 1 ? ` pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="${f(1 - pen.draw)}"` : '');
const fillAlpha = (pen) => (pen.draw < 1 ? clamp((pen.draw - 0.55) / 0.45, 0, 1) : 1);

function stroke(pts, pen, { closed = false, w = 1, color } = {}) {
  const c = color || pen.ink;
  const sw = f(pen.width * w);
  let s = `<path d="${pathD(wob(pts, pen, closed), closed)}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash(pen)}/>`;
  if (pen.marker && pen.amp) s += `<path d="${pathD(wob(pts, pen, closed), closed)}" fill="none" stroke="${c}" stroke-opacity="0.35" stroke-width="${f(sw * 0.6)}" stroke-linecap="round"${dash(pen)}/>`;
  return s;
}

function shape(pts, pen, { fill, w = 1, color, noStroke = false } = {}) {
  let s = '';
  if (fill && fill !== 'none') {
    const a = fillAlpha(pen);
    if (a > 0) s += `<path d="${pathD(pen.amp ? wob(pts, { ...pen, amp: pen.amp * 0.4 }, true) : pts, true)}" fill="${fill}"${a < 1 ? ` fill-opacity="${f(a)}"` : ''} stroke="none"/>`;
  }
  if (!noStroke) s += stroke(pts, pen, { closed: true, w, color });
  return s;
}

const circle = (cx, cy, r, n = 26) => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r]);
const ellipse = (cx, cy, rx, ry, n = 26, a0 = 0, a1 = Math.PI * 2) => Array.from({ length: n + 1 }, (_, i) => a0 + ((a1 - a0) * i) / n).map((a) => [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
function rect(x, y, w, h, r = 0) {
  if (!r) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  r = Math.min(r, w / 2, h / 2);
  const c = (cx, cy, a) => ellipse(cx, cy, r, r, 4, a, a + Math.PI / 2);
  return [...c(x + w - r, y + r, -Math.PI / 2), ...c(x + w - r, y + h - r, 0), ...c(x + r, y + h - r, Math.PI / 2), ...c(x + r, y + r, Math.PI)];
}

function text(spec, x, y, str, { size, anchor = 'middle', color, reveal = 1, weight = 400 }) {
  const s = String(str);
  const shown = reveal < 1 ? s.slice(0, Math.round(s.length * reveal)) : s;
  return `<text x="${f(x)}" y="${f(y)}" font-family="${esc(fontFamily(spec.style.font))}" font-size="${f(size)}" font-weight="${weight}" text-anchor="${anchor}" fill="${color || colorOf(spec, 'ink')}" dominant-baseline="middle">${esc(shown)}</text>`;
}

// ---------------------------------------------------------------- people and robots

function handTargets(spec, e, t, h, sh, F) {
  const sway = Math.sin(t * 1.7 + (hash(e.id) % 7)) * h * 0.008;
  let T = [
    [0.07 * h + sway, -0.42 * h],
    [-0.05 * h - sway, -0.42 * h],
  ];
  if (e.base === 'walk') {
    const s = Math.sin(e.phase * Math.PI * 2) * h * (e.gait === 'run' ? 0.17 : 0.11);
    T = [
      [s, -0.44 * h],
      [-s, -0.44 * h],
    ];
  }
  if (e.hold)
    T = [
      [0.23 * h, -0.5 * h],
      [0.19 * h, -0.52 * h],
    ];
  const towards = (a) => {
    const dx = (a[0] - e.x) * F;
    const dy = a[1] - (e.y - e.jumpY + sh[1]);
    const d = Math.hypot(dx, dy) || 1;
    return [sh[0] + (dx / d) * 0.31 * h, sh[1] + (dy / d) * 0.31 * h];
  };
  for (const a of e.acts) {
    if (!(a.w > 0)) continue;
    const q = a.t || t;
    const P = {
      talk: [[0.2 * h, -0.58 * h + Math.sin(q * 6) * 0.03 * h], T[1]],
      thinking: [[0.075 * h, -0.83 * h], [0.06 * h, -0.56 * h]],
      point: a.at ? [towards(a.at), T[1]] : null,
      wave: [[0.15 * h + Math.sin(q * 11) * 0.05 * h, -1.0 * h], T[1]],
      cheer: [[0.14 * h, -1.07 * h], [-0.12 * h, -1.07 * h]],
      type: [[0.25 * h + Math.sin(q * 23) * 0.012 * h, -0.53 * h], [0.21 * h + Math.cos(q * 19) * 0.012 * h, -0.53 * h]],
      reach: [[0.25 * h, -0.53 * h], [0.2 * h, -0.55 * h]],
      surprised: [[0.17 * h, -0.9 * h], [-0.13 * h, -0.9 * h]],
      frustrated: [[0.08 * h, -0.99 * h], [-0.06 * h, -0.99 * h]],
      sad: [[0.03 * h, -0.37 * h], [-0.02 * h, -0.37 * h]],
      nod: T,
    }[a.name];
    if (P) T = T.map((p, i) => [lerp(p[0], P[i][0], a.w), lerp(p[1], P[i][1], a.w)]);
  }
  if (e.hold) T[0] = [0.23 * h, -0.5 * h];
  return T;
}

function face(spec, e, t, cx, cy, r, pen, F, robot) {
  const ink = colorOf(spec, 'ink');
  const blink = (t + (hash(e.id) % 100) / 37) % 3.7 < 0.13;
  const em = e.emote;
  const ex = cx + F * r * 0.28;
  const ey = cy - r * 0.08;
  const sp = r * 0.26;
  let s = '';
  const eye = (x) => {
    if (blink) return stroke([[x - r * 0.08, ey], [x + r * 0.08, ey]], pen, { w: 0.8 });
    if (robot) {
      if (em === 'happy') return stroke([[x - r * 0.1, ey + r * 0.04], [x, ey - r * 0.07], [x + r * 0.1, ey + r * 0.04]], pen, { w: 0.9 });
      const k = em === 'surprised' ? 1.35 : 1;
      return `<ellipse cx="${f(x)}" cy="${f(ey)}" rx="${f(r * 0.075 * k)}" ry="${f(r * 0.13 * k)}" fill="${ink}"/>`;
    }
    return `<circle cx="${f(x)}" cy="${f(ey)}" r="${f(r * (em === 'surprised' ? 0.11 : 0.085))}" fill="${ink}"/>`;
  };
  s += eye(ex - sp) + eye(ex + sp);
  const by = ey - r * 0.24;
  const brow = (x, tilt) => stroke([[x - r * 0.1, by + tilt * r * 0.06], [x + r * 0.1, by - tilt * r * 0.06]], pen, { w: 0.7 });
  if (em === 'frustrated') s += brow(ex - sp, -1) + brow(ex + sp, 1);
  if (em === 'sad') s += brow(ex - sp, 1) + brow(ex + sp, -1);
  if (em === 'surprised') s += brow(ex - sp, 0) + brow(ex + sp, 0);
  if (em === 'thinking') s += brow(ex + sp, -0.6);
  const mx = cx + F * r * 0.24;
  const my = cy + r * 0.4;
  const mw = r * 0.22;
  if (robot) {
    for (let i = -1; i <= 1; i++) s += stroke([[mx + i * mw * 0.6, my - r * 0.05], [mx + i * mw * 0.6, my + r * 0.07]], pen, { w: 0.6 });
    return s;
  }
  if (em === 'surprised') s += `<ellipse cx="${f(mx)}" cy="${f(my)}" rx="${f(mw * 0.4)}" ry="${f(mw * 0.55)}" fill="${ink}"/>`;
  else if (em === 'happy') s += shape([...ellipse(mx, my - mw * 0.2, mw, mw * 0.85, 10, 0.1, Math.PI - 0.1)], pen, { fill: ink, w: 0.6 });
  else if (em === 'sad') s += stroke(ellipse(mx, my + mw * 0.55, mw * 0.85, mw * 0.55, 8, Math.PI + 0.3, Math.PI * 2 - 0.3), pen, { w: 0.75 });
  else if (em === 'frustrated') s += stroke([[mx - mw, my], [mx - mw * 0.3, my - mw * 0.2], [mx + mw * 0.3, my + mw * 0.15], [mx + mw, my]], pen, { w: 0.75 });
  else if (em === 'thinking') s += stroke([[mx - mw * 0.5, my], [mx + mw * 0.5, my - mw * 0.1]], pen, { w: 0.75 });
  else s += stroke(ellipse(mx, my - mw * 0.35, mw * 0.8, mw * 0.5, 8, 0.4, Math.PI - 0.4), pen, { w: 0.75 });
  return s;
}

function hair(spec, c, cx, cy, r, pen, F) {
  const ink = colorOf(spec, c.look.hairColor || 'ink');
  const cap = [...ellipse(cx, cy, r * 1.04, r * 1.04, 14, Math.PI * 1.05, Math.PI * 1.95), [cx + r * 0.6, cy - r * 0.45], [cx - r * 0.6, cy - r * 0.45]];
  switch (c.look.hair) {
    case 'none':
      return '';
    case 'bun':
      return shape(cap, pen, { fill: ink, w: 0.6 }) + shape(circle(cx - F * r * 0.55, cy - r * 0.95, r * 0.33, 14), pen, { fill: ink, w: 0.6 });
    case 'long':
      return shape([...ellipse(cx, cy, r * 1.06, r * 1.06, 16, Math.PI * 0.8, Math.PI * 2.05), [cx + F * r * 0.2, cy - r * 0.5], [cx - F * r * 0.9, cy + r * 1.3], [cx - F * r * 1.15, cy + r * 1.2]], pen, { fill: ink, w: 0.6 });
    case 'spiky': {
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (1.05 + (0.9 * i) / 8);
        const rr = i % 2 ? r * 1.35 : r * 1.0;
        pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
      }
      return shape([...pts, [cx + r * 0.5, cy - r * 0.4], [cx - r * 0.5, cy - r * 0.4]], pen, { fill: ink, w: 0.6 });
    }
    case 'cap': {
      const col = colorOf(spec, c.look.capColor || 'accent');
      return shape(cap, pen, { fill: col, w: 0.7 }) + stroke([[cx, cy - r * 0.5], [cx + F * r * 1.45, cy - r * 0.42]], pen, { w: 1.1 });
    }
    default:
      return shape(cap, pen, { fill: ink, w: 0.6 });
  }
}

function actor(spec, e, t, pen) {
  const c = spec.cast[e.id];
  const robot = c.kind === 'robot';
  const h = personH(spec, e.id) * e.scale;
  const F = e.face;
  const X = e.x + e.shakeX;
  const Y = e.y - e.jumpY;
  const sq = e.squash || 0;
  const ph = ((hash(e.id) % 1000) / 1000) * 6.28;
  const breathe = Math.sin((t * 2 * Math.PI) / 3.4 + ph) * 0.007 * h;
  const W = (lx, ly) => [X + F * lx, Y + ly];
  const ink = colorOf(spec, 'ink');
  let bob = 0;
  let lean = 0;
  if (e.base === 'walk') {
    bob = -Math.abs(Math.sin(e.phase * Math.PI * 2)) * h * (robot ? 0.008 : 0.022);
    lean = e.gait === 'run' ? 0.09 : 0.035;
  }
  const sadDrop = e.acts.some((a) => a.name === 'sad' && a.w > 0.2) || e.emote === 'sad' ? 0.02 * h : 0;
  const nod = e.acts.find((a) => a.name === 'nod');
  const nodY = nod ? Math.abs(Math.sin((nod.t || 0) * 9)) * 0.02 * h * nod.w : 0;
  const hipY = -0.47 * h * (1 - sq) + bob;
  const neck = robot ? [lean * h * 0.3, -0.7 * h * (1 - sq * 0.8) + bob + breathe] : [lean * h * 0.55, -0.8 * h * (1 - sq * 0.8) + bob + breathe];
  const head = [neck[0] + lean * h * 0.12, neck[1] - (robot ? 0.13 : 0.095) * h + sadDrop + nodY];
  const r = (robot ? 0.105 : 0.085) * h;
  const sh = [neck[0], neck[1] + (robot ? 0.07 : 0.035) * h];
  const lrect = (x, y, w, hh, rr) => rect(x, y, w, hh, rr).map(([px, py]) => W(px, py));
  const T = handTargets(spec, e, t, h, sh, F);
  const arm = (i) => {
    // a robot's arms hang from the sides of its body, a person's from the shoulder point
    const ox = robot ? (i ? -0.15 : 0.15) * h : 0;
    const s0 = [sh[0] + ox, sh[1]];
    const [el, hand] = ik(s0, [T[i][0] + ox, T[i][1]], 0.165 * h, 0.16 * h, -1);
    return stroke([W(...s0), W(...el), W(...hand)], pen, { w: 1.15 });
  };
  let legs = '';
  let body = '';
  if (robot) {
    // one wheel instead of legs; it turns with the distance travelled
    const wr = 0.075 * h;
    const wc = [0, -wr];
    const rot = (X / wr) % (Math.PI * 2);
    legs += shape(circle(...W(...wc), wr), pen, { fill: colorOf(spec, 'paper') });
    for (let k = 0; k < 3; k++) {
      const a = rot + (k * Math.PI * 2) / 3;
      legs += stroke([W(...wc), W(wc[0] + Math.cos(a) * wr * 0.75, wc[1] + Math.sin(a) * wr * 0.75)], pen, { w: 0.7 });
    }
    legs += stroke([W(0, -wr * 2), W(0, -0.27 * h)], pen, { w: 1.1 });
    const bw = 0.3 * h;
    const top = neck[1] + 0.03 * h;
    body += shape(lrect(-bw / 2, top, bw, -0.27 * h - top, 0.06 * h), pen, { fill: colorOf(spec, c.look.body) });
    const glow = 0.6 + 0.4 * Math.sin(t * 3 + ph);
    const lp = W(0.06 * h, top + 0.14 * h);
    body += `<circle cx="${f(lp[0])}" cy="${f(lp[1])}" r="${f(0.028 * h)}" fill="${colorOf(spec, 'accent')}" fill-opacity="${f(glow)}"/>`;
  } else {
    const L = h * (e.gait === 'run' ? 0.62 : 0.38) * 2;
    const leg = (o) => {
      if (e.base !== 'walk') return o ? [-0.05 * h, 0] : [0.06 * h, 0];
      const p = (((e.phase + o) % 1) + 1) % 1;
      if (p < 0.5) return [L / 4 - (p / 0.5) * (L / 2), 0];
      const q = (p - 0.5) / 0.5;
      return [-L / 4 + q * q * (3 - 2 * q) * (L / 2), -Math.sin(Math.PI * q) * h * (e.gait === 'run' ? 0.12 : 0.07)];
    };
    const hip = [lean * h * 0.2, hipY];
    for (const o of [0.5, 0]) {
      const foot = leg(o);
      const [knee, end] = ik(hip, foot, 0.25 * h, 0.25 * h, 1);
      legs += stroke([W(...hip), W(...knee), W(...end), W(end[0] + 0.05 * h, end[1])], pen, { w: 1.2 });
    }
    const tw = 0.115 * h;
    const torso = [W(neck[0] - tw / 2, neck[1] + 0.02 * h), W(neck[0] + tw / 2, neck[1] + 0.02 * h), W(hip[0] + tw * 0.42, hip[1]), W(hip[0] - tw * 0.42, hip[1])];
    body += shape(torso, pen, { fill: colorOf(spec, c.look.shirt, colorOf(spec, 'paper')) });
  }
  // back arm, legs, body, front arm, head
  let s = arm(1) + legs + body;
  if (robot) {
    const hw = 0.34 * h;
    const hh = 0.26 * h;
    const hx = head[0] - hw / 2;
    const hy = head[1] - hh / 2;
    s += stroke([W(head[0], hy), W(head[0] - F * 0.01 * h, hy - 0.07 * h)], pen, { w: 0.8 });
    s += `<circle cx="${f(W(head[0] - F * 0.01 * h, 0)[0])}" cy="${f(Y + hy - 0.08 * h)}" r="${f(0.022 * h)}" fill="${colorOf(spec, 'accent')}"/>`;
    s += shape(lrect(hx, hy, hw, hh, 0.05 * h), pen, { fill: colorOf(spec, 'paper') });
    s += face(spec, e, t, ...W(head[0], head[1]), r, pen, F, true);
  } else {
    s += shape(circle(...W(...head), r), pen, { fill: colorOf(spec, c.look.skin, colorOf(spec, 'paper')) });
    s += hair(spec, c, ...W(...head), r, pen, F);
    s += face(spec, e, t, ...W(...head), r, pen, F, false);
  }
  s += arm(0);
  if (e.acts.some((a) => a.name === 'thinking' && a.w > 0.5)) {
    const q = W(head[0] + 0.15 * h, head[1] - 0.16 * h);
    s += `<circle cx="${f(q[0])}" cy="${f(q[1])}" r="${f(0.012 * h)}" fill="${ink}" fill-opacity="0.6"/>`;
  }
  return s;
}

// ---------------------------------------------------------------- props

function labelOf(p, e) {
  const s = String(p.text ?? '');
  return e.value != null ? s.replace('{n}', Math.round(e.value).toLocaleString('en-US')) : s;
}

function prop(spec, e, t, pen, opts) {
  const p = spec.props[e.id];
  const { w, h } = sizeOf(spec, e.id);
  const x = e.x + e.shakeX;
  const y = e.y - e.jumpY;
  const L = x - w / 2;
  const T = y - h;
  const fill = colorOf(spec, p.fill || (p.kit === 'star' || p.kit === 'bulb' || p.kit === 'chart' ? 'accent' : 'paper'));
  const soft = colorOf(spec, 'soft');
  const paper = colorOf(spec, 'paper');
  const ink = colorOf(spec, 'ink');
  const u = pen.u;
  const label = labelOf(p, e);
  const reveal = pen.draw;
  if (p.image) {
    const href = opts.asset ? opts.asset(p.image) : p.image;
    return `<image href="${esc(href)}" x="${f(L)}" y="${f(T)}" width="${f(w)}" height="${f(h)}" opacity="${f(fillAlpha(pen))}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  if (p.draw) {
    const sub = parsePath(p.draw);
    const [bx, by, bw, bh] = bboxOf(sub);
    const k = Math.min(w / Math.max(bw, 1e-6), h / Math.max(bh, 1e-6));
    return sub
      .map((sp) => {
        const pts = sp.pts.map(([px, py]) => [L + (px - bx) * k, T + (py - by) * k]);
        return sp.closed ? shape(pts, pen, { fill: p.fill ? fill : 'none' }) : stroke(pts, pen);
      })
      .join('');
  }
  switch (p.kit) {
    case 'desk':
      return shape(rect(L, T, w, h * 0.13, 4 * u), pen, { fill: soft }) + stroke([[L + w * 0.08, T + h * 0.13], [L + w * 0.08, y]], pen) + stroke([[L + w * 0.92, T + h * 0.13], [L + w * 0.92, y]], pen) + shape(rect(L + w * 0.62, T + h * 0.13, w * 0.24, h * 0.32), pen, { fill: paper, w: 0.8 });
    case 'laptop': {
      const sw = w * 0.8;
      let s = shape(rect(x - sw / 2, T, sw, h * 0.86, 6 * u), pen, { fill: ink });
      s += shape(rect(x - sw / 2 + 9 * u, T + 9 * u, sw - 18 * u, h * 0.86 - 18 * u, 3 * u), pen, { fill: fill === paper ? soft : fill, w: 0.5 });
      s += shape([[L, y - h * 0.1], [L + w, y - h * 0.1], [L + w * 0.97, y], [L + w * 0.03, y]], pen, { fill: soft });
      if (label) s += text(spec, x, T + h * 0.43, label, { size: Math.min(h * 0.16, (sw / Math.max(label.length, 4)) * 1.6), color: ink, reveal });
      return s;
    }
    case 'phone': {
      let s = shape(rect(L, T, w, h, 14 * u), pen, { fill: ink });
      s += shape(rect(L + 6 * u, T + 14 * u, w - 12 * u, h - 28 * u, 6 * u), pen, { fill: fill === paper ? soft : fill, w: 0.5 });
      if (label) s += text(spec, x, T + h / 2, label, { size: w * 0.18, color: ink, reveal });
      return s;
    }
    case 'screen': {
      let s = shape(rect(L, T, w, h * 0.78, 8 * u), pen, { fill: ink });
      s += shape(rect(L + 10 * u, T + 10 * u, w - 20 * u, h * 0.78 - 20 * u, 4 * u), pen, { fill: fill === paper ? soft : fill, w: 0.5 });
      s += stroke([[x, T + h * 0.78], [x, y - 6 * u]], pen, { w: 1.4 }) + stroke([[x - w * 0.18, y], [x + w * 0.18, y]], pen, { w: 1.2 });
      if (label) s += text(spec, x, T + h * 0.39, label, { size: Math.min(h * 0.13, (w / Math.max(label.length, 4)) * 1.5), color: ink, reveal });
      return s;
    }
    case 'doc': {
      const fold = w * 0.22;
      let s = shape([[L, T], [L + w - fold, T], [L + w, T + fold], [L + w, y], [L, y]], pen, { fill });
      s += stroke([[L + w - fold, T], [L + w - fold, T + fold], [L + w, T + fold]], pen, { w: 0.7 });
      const top = label ? T + h * 0.34 : T + h * 0.2;
      if (label) s += text(spec, x, T + h * 0.17, label, { size: w * 0.13, reveal });
      for (let i = 0; i < 4; i++) s += stroke([[L + w * 0.14, top + i * h * 0.15], [L + w * (i === 3 ? 0.55 : 0.84), top + i * h * 0.15]], pen, { w: 0.55, color: colorOf(spec, 'ink') });
      return s;
    }
    case 'box': {
      let s = shape(rect(L, T + h * 0.18, w, h * 0.82), pen, { fill: fill === paper ? '#e7c49a' : fill });
      s += shape([[L, T + h * 0.18], [L + w * 0.12, T], [L + w * 0.88, T], [L + w, T + h * 0.18]], pen, { fill: fill === paper ? '#d9ae7e' : soft, w: 0.9 });
      s += stroke([[x, T + h * 0.18], [x, T + h * 0.45]], pen, { w: 0.7 });
      if (label) s += text(spec, x, T + h * 0.66, label, { size: h * 0.17, reveal });
      return s;
    }
    case 'cloud': {
      const pts = Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        const rr = 1 + 0.13 * Math.abs(Math.sin(a * 3.5));
        return [x + Math.cos(a) * (w / 2) * rr * 0.88, T + h / 2 + Math.sin(a) * (h / 2) * rr * 0.82];
      });
      return shape(pts, pen, { fill });
    }
    case 'database': {
      const ry = h * 0.11;
      let s = shape([...ellipse(x, T + ry, w / 2, ry, 14, Math.PI, 0), ...ellipse(x, y - ry, w / 2, ry, 14, 0, Math.PI)], pen, { fill });
      s += stroke(ellipse(x, T + ry, w / 2, ry, 14, 0, Math.PI), pen, { w: 0.8 });
      s += stroke(ellipse(x, T + h * 0.5, w / 2, ry, 14, 0, Math.PI), pen, { w: 0.6 });
      return s;
    }
    case 'sign': {
      let s = stroke([[x, T + h * 0.55], [x, y]], pen, { w: 1.6 });
      s += shape(rect(L, T, w, h * 0.55, 6 * u), pen, { fill });
      if (label) s += text(spec, x, T + h * 0.275, label, { size: Math.min(h * 0.2, (w / Math.max(label.length, 4)) * 1.6), reveal });
      return s;
    }
    case 'chart': {
      const data = (Array.isArray(p.data) ? p.data : [3, 5, 8]).map(Number).filter(Number.isFinite).slice(0, 12);
      const max = Math.max(...data, 1);
      const pad = w * 0.08;
      let s = stroke([[L, T], [L, y], [L + w, y]], { ...pen, draw: Math.min(1, pen.draw * 2) }, { w: 1.1 });
      const bw = (w - pad * 2) / Math.max(data.length, 1);
      data.forEach((v, i) => {
        const grow = clamp(pen.draw * 1.3 - i * (0.3 / data.length), 0, 1);
        const bh = (v / max) * (h - 12 * u) * grow;
        if (bh > 1) s += shape(rect(L + pad + i * bw + bw * 0.15, y - bh, bw * 0.7, bh), { ...pen, draw: 1 }, { fill, w: 0.8 });
      });
      return s;
    }
    case 'plant': {
      let s = '';
      const g = colorOf(spec, 'second');
      for (const [a, k] of [[-0.6, 0.9], [0, 1.05], [0.6, 0.85]]) {
        const tip = [x + Math.sin(a) * w * 0.5, T + h * (0.55 - k * 0.5)];
        s += shape([[x, T + h * 0.55], [lerp(x, tip[0], 0.5) + w * 0.12, lerp(T + h * 0.55, tip[1], 0.5)], tip, [lerp(x, tip[0], 0.5) - w * 0.12, lerp(T + h * 0.55, tip[1], 0.5)]], pen, { fill: g, w: 0.7 });
      }
      s += shape([[L + w * 0.12, T + h * 0.55], [L + w * 0.88, T + h * 0.55], [L + w * 0.76, y], [L + w * 0.24, y]], pen, { fill: fill === paper ? colorOf(spec, 'accent') : fill });
      return s;
    }
    case 'star': {
      const pts = Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = (i % 2 ? 0.42 : 1) * (w / 2);
        return [x + Math.cos(a) * rr, T + h / 2 + Math.sin(a) * rr];
      });
      let s = shape(pts, pen, { fill });
      const tw = 0.5 + 0.5 * Math.sin(t * 5 + hash(e.id));
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        s += stroke([[x + Math.cos(a) * w * 0.62, T + h / 2 + Math.sin(a) * w * 0.62], [x + Math.cos(a) * w * (0.68 + 0.08 * tw), T + h / 2 + Math.sin(a) * w * (0.68 + 0.08 * tw)]], pen, { w: 0.7 });
      }
      return s;
    }
    case 'check': {
      const g = p.fill ? fill : colorOf(spec, 'second');
      return shape(circle(x, T + h / 2, w / 2), pen, { fill: g }) + stroke([[x - w * 0.22, T + h * 0.52], [x - w * 0.05, T + h * 0.68], [x + w * 0.24, T + h * 0.34]], pen, { w: 1.6, color: paper });
    }
    case 'bulb': {
      const r = w * 0.42;
      const cy = T + r + h * 0.05;
      let s = shape([...ellipse(x, cy, r, r, 18, Math.PI * 0.75, Math.PI * 2.25), [x + r * 0.45, y - h * 0.22], [x - r * 0.45, y - h * 0.22]], pen, { fill });
      s += shape(rect(x - r * 0.45, y - h * 0.22, r * 0.9, h * 0.2, 4 * u), pen, { fill: soft, w: 0.8 });
      const glow = 0.5 + 0.5 * Math.sin(t * 4);
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * (1.1 + i * 0.2);
        s += stroke([[x + Math.cos(a) * r * 1.3, cy + Math.sin(a) * r * 1.3], [x + Math.cos(a) * r * (1.55 + 0.1 * glow), cy + Math.sin(a) * r * (1.55 + 0.1 * glow)]], pen, { w: 0.8 });
      }
      return s;
    }
    case 'text': {
      const fs = (p.size || 64) * u * 1;
      const lines = label.split('\n');
      return lines.map((l, i) => text(spec, x, T + fs * 0.6 + i * fs * 1.2, l, { size: fs, reveal: pen.draw, color: colorOf(spec, p.color || 'ink'), weight: p.bold ? 700 : 400 })).join('');
    }
    default:
      return shape(rect(L, T, w, h, 8 * u), pen, { fill });
  }
}

function arrow(spec, st, id, pen) {
  const ends = arrowEnds(spec, st, id);
  if (!ends) return '';
  const [a, b] = ends;
  const bend = Number(spec.props[id].bend) || 0.15;
  const mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * bend;
  const my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * bend;
  const pts = Array.from({ length: 13 }, (_, i) => {
    const q = i / 12;
    return [(1 - q) ** 2 * a[0] + 2 * (1 - q) * q * mx + q * q * b[0], (1 - q) ** 2 * a[1] + 2 * (1 - q) * q * my + q * q * b[1]];
  });
  let s = stroke(pts, pen, { w: 1.1 });
  if (pen.draw > 0.85) {
    const ang = Math.atan2(b[1] - pts[10][1], b[0] - pts[10][0]);
    const k = 22 * pen.u;
    s += stroke([[b[0] - Math.cos(ang - 0.5) * k, b[1] - Math.sin(ang - 0.5) * k], b, [b[0] - Math.cos(ang + 0.5) * k, b[1] - Math.sin(ang + 0.5) * k]], { ...pen, draw: 1 }, { w: 1.1 });
  }
  return s;
}

function bubble(spec, st, id, t) {
  const b = bubbleOf(spec, st, id);
  if (!b) return '';
  const a = st[id];
  const pen = penFor(spec, t, id + ':bubble', null);
  const [x, y, w, h] = b.box;
  const paper = colorOf(spec, 'paper');
  let s = '';
  if (a.say.kind === 'think') {
    const pts = Array.from({ length: 40 }, (_, i) => {
      const q = (i / 40) * Math.PI * 2;
      const rr = 1 + 0.07 * Math.abs(Math.sin(q * 5));
      return [x + w / 2 + Math.cos(q) * (w / 2) * rr, y + h / 2 + Math.sin(q) * (h / 2) * rr];
    });
    s += shape(pts, pen, { fill: paper });
    const [tx, ty] = b.tail;
    for (let i = 0; i < 3; i++) s += shape(circle(lerp(x + w / 2, tx, 0.45 + i * 0.22), lerp(y + h, ty, 0.45 + i * 0.22), (8 - i * 2.2) * pen.u, 10), pen, { fill: paper, w: 0.7 });
  } else {
    const [tx, ty] = b.tail;
    const bx = clamp(tx, x + 30 * pen.u, x + w - 30 * pen.u);
    const body = rect(x, y, w, h, 22 * pen.u);
    s += shape(body, pen, { fill: paper });
    s += shape([[bx - 16 * pen.u, y + h - 2 * pen.u], [tx, ty], [bx + 14 * pen.u, y + h - 2 * pen.u]], pen, { fill: paper, noStroke: true });
    s += stroke([[bx - 16 * pen.u, y + h], [tx, ty], [bx + 14 * pen.u, y + h]], pen);
  }
  const total = b.lines.join(' ').length;
  let left = Math.round(total * a.say.reveal);
  b.lines.forEach((l, i) => {
    const n = clamp(left, 0, l.length);
    left -= l.length + 1;
    if (n > 0) s += text(spec, x + w / 2, y + b.fs * 1.05 + i * b.fs * 1.25, l.slice(0, n), { size: b.fs });
  });
  return `<g opacity="${f(a.say.alpha)}">${s}</g>`;
}

// ---------------------------------------------------------------- the frame

function world(spec, s, t, opts) {
  const [W, H] = spec.size;
  const paper = colorOf(spec, 'paper');
  const { cam } = s;
  let out = `<rect x="0" y="0" width="${W}" height="${H}" fill="${paper}"/>`;
  out += `<g transform="translate(${f(W / 2)} ${f(H / 2)}) scale(${f(cam.zoom * 1000) / 1000}) translate(${f(-cam.x)} ${f(-cam.y)})">`;
  if (spec.style.floor) {
    const pen = penFor(spec, t, 'floor', null);
    const fy = H * FLOOR;
    out += stroke([[-W * 0.1, fy], [W * 1.1, fy]], pen, { w: 0.8 });
    for (let i = 0; i < 9; i++) {
      const x = ((hash('tick' + i) % 1000) / 1000) * W;
      out += stroke([[x, fy + 18 * pen.u], [x + 26 * pen.u, fy + 18 * pen.u]], pen, { w: 0.5 });
    }
  }
  const z = (id) => Number((spec.cast[id] || spec.props[id])?.z) || 0;
  const order = [...Object.keys(spec.props).map((id, i) => [id, z(id), 0, i]), ...Object.keys(spec.cast).map((id, i) => [id, z(id), 1, i])];
  const held = new Set(Object.values(s.ents).filter((e) => e.heldBy || e.carry).map((e) => e.id));
  order.sort((a, b) => a[1] - b[1] || held.has(a[0]) - held.has(b[0]) || a[2] - b[2] || a[3] - b[3]);
  for (const [id] of order) {
    const e = s.ents[id];
    if (!e || !e.visible || e.opacity <= 0.01 || e.scale <= 0.01 || e.draw <= 0.005) continue;
    const pen = penFor(spec, t, id, e);
    const isArrow = spec.props[id]?.kit === 'arrow';
    const body = spec.cast[id] ? actor(spec, e, t, pen) : isArrow ? arrow(spec, s.ents, id, pen) : prop(spec, e, t, pen, opts);
    const { h } = sizeOf(spec, id);
    const cy = e.y - (h * e.scale) / 2 - e.jumpY;
    const sc = spec.cast[id] || isArrow || e.scale === 1 ? '' : ` transform="translate(${f(e.x)} ${f(cy)}) scale(${f(e.scale * 1000) / 1000}) translate(${f(-e.x)} ${f(cy * -1)})"`;
    out += `<g data-id="${esc(id)}"${sc}${e.opacity < 1 ? ` opacity="${f(e.opacity)}"` : ''}>${body}</g>`;
  }
  for (const id of Object.keys(spec.cast)) out += bubble(spec, s.ents, id, t);
  return out + '</g>';
}

/** The frame at t as an SVG document string. opts: { uid, asset(path) → url, adjust(state) → state }. */
export function frameSVG(spec, t, opts = {}) {
  const [W, H] = spec.size;
  const adj = (st) => (opts.adjust ? opts.adjust(st) || st : st);
  const s = adj(stateAt(spec, t));
  const uid = opts.uid || 'ms';
  let inner = world(spec, s, t, opts);
  let defs = '';
  if (s.trans) {
    const prev = adj(stateAt(spec, s.trans.prevT, { noTrans: true }));
    const pb = world(spec, prev, s.trans.prevT, opts);
    const p = s.trans.p;
    if (s.trans.kind === 'fade') inner = `${pb}<g opacity="${f(p * 100) / 100}">${inner}</g>`;
    else if (s.trans.kind === 'wipe') {
      defs = `<defs><clipPath id="${uid}-wipe"><rect x="0" y="0" width="${f(W * p)}" height="${H}"/></clipPath></defs>`;
      inner = `${pb}<g clip-path="url(#${uid}-wipe)">${inner}</g><path d="M${f(W * p)} 0V${H}" stroke="${colorOf(spec, 'ink')}" stroke-width="${f(4 * (H / 1080))}"/>`;
    } else inner = `<g transform="translate(${f(-W * p)} 0)">${pb}</g><g transform="translate(${f(W * (1 - p))} 0)">${inner}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${defs}${inner}</svg>`;
}
