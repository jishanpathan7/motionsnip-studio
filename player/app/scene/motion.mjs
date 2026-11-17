// MotionSnip Scenes: where everything is at time t. Beats (verbs) become positions, poses and reveals, with
// the animation principles built in: eased starts and stops, walks whose feet don't skate, overshoot on a pop,
// anticipation on a jump, a camera that settles. Pure (no DOM): the compiler and the renderer both use it.

import { clamp, lerp, ease, easeOf, travel, parsePath, bboxOf } from './geom.mjs';

export const FLOOR = 0.82; // the floor line, as a share of the stage height
export const PERSON_H = 0.34; // a person's height, as a share of the stage height
export const TRANSITION = 0.6; // seconds a fade, wipe or push takes
const MATCH = 0.8; // seconds a match cut's camera move takes on each side of the cut

/** Kit props: base size in px on a 1080-high stage. */
export const KIT = {
  laptop: [270, 180],
  phone: [96, 176],
  screen: [330, 260],
  doc: [150, 200],
  box: [170, 140],
  cloud: [270, 150],
  database: [150, 190],
  sign: [270, 230],
  chart: [320, 230],
  desk: [440, 170],
  plant: [120, 180],
  star: [100, 96],
  check: [120, 120],
  bulb: [104, 150],
  text: [400, 80],
  arrow: [200, 40],
};

const APPEAR = new Set(['pop', 'draw-on', 'enter', 'fade-in']);
const WHO = (b) => b.who || b.what;

/** Default duration of a beat, in seconds at tempo 1 (distance-based verbs are worked out from the distance). */
export const VERB_DUR = {
  emote: 0.4,
  point: 1.2,
  wave: 1.4,
  jump: 0.7,
  cheer: 1.2,
  type: 1.6,
  pick: 0.5,
  hand: 0.8,
  put: 0.6,
  pop: 0.5,
  fade: 0.5,
  'fade-in': 0.5,
  'draw-on': 1.0,
  move: 0.8,
  grow: 0.6,
  shake: 0.5,
  count: 1.2,
  camera: 1.0,
  look: 0.2,
  nod: 0.6,
};
export const VERBS = ['walk', 'run', 'enter', 'exit', 'say', 'think', ...Object.keys(VERB_DUR)];

const unit = (spec) => spec.size[1] / 1080;
export const personH = (spec, id) => spec.size[1] * PERSON_H * (spec.cast[id]?.scale || 1);

/** An entity's size (px) before its own scale; its anchor is the bottom centre. */
export function sizeOf(spec, id) {
  const c = spec.cast[id];
  if (c) {
    const h = personH(spec, id);
    return { w: h * (c.kind === 'robot' ? 0.46 : 0.36), h };
  }
  const p = spec.props[id];
  if (!p) return { w: 0, h: 0 };
  const u = unit(spec) * (p.scale || 1);
  if (p.w > 0 && p.h > 0) return { w: p.w * u, h: p.h * u };
  if (p.kit === 'text') {
    const fs = (p.size || 64) * u;
    const lines = String(p.text || '').split('\n');
    return { w: Math.max(...lines.map((l) => l.length)) * fs * 0.5 + fs * 0.4, h: lines.length * fs * 1.2 };
  }
  if (p.draw) {
    const [, , bw, bh] = bboxOf(parsePath(p.draw));
    const hh = (p.h || 200) * u;
    return { w: (hh * bw) / Math.max(bh, 1e-6), h: hh };
  }
  const [w, h] = KIT[p.kit] || [200, 200];
  return { w: w * u, h: h * u };
}

// ---------------------------------------------------------------- preparing a spec

function blank(spec, id, x, y) {
  return {
    id,
    x,
    y,
    face: 1,
    scale: 1,
    opacity: 1,
    visible: false,
    draw: 1,
    base: 'idle', // idle | walk
    gait: 'walk',
    phase: 0,
    acts: [], // gesture overlays: { name, w, at? }
    emote: 'neutral',
    say: null,
    hold: null,
    heldBy: null,
    carry: null, // { from: [x, y], to: actor id or [x, y], p, arc }
    jumpY: 0,
    squash: 0,
    shakeX: 0,
    value: null,
  };
}

const clone = (st) => {
  const o = {};
  for (const [k, v] of Object.entries(st)) o[k] = { ...v, acts: [] };
  return o;
};

/** Hand position of an actor (where it holds things). */
export function handAt(spec, a) {
  const h = personH(spec, a.id) * a.scale;
  return [a.x + a.face * h * 0.22, a.y - h * 0.5 - a.jumpY];
}

/** Centre of an entity in world px. */
export function centreOf(spec, st, id) {
  const e = st[id];
  if (!e) return null;
  const { h } = sizeOf(spec, id);
  return [e.x, e.y - (h * e.scale) / 2 - e.jumpY];
}

/** Resolve a target: an entity id, [x, y], or { x, y }. */
function pointOf(spec, st, to) {
  if (Array.isArray(to)) return [Number(to[0]) || 0, Number(to[1]) || 0];
  if (to && typeof to === 'object') return [Number(to.x) || 0, Number(to.y) || 0];
  if (typeof to === 'string' && st[to]) return [st[to].x, st[to].y];
  return null;
}

function tempoOf(spec, shot, b) {
  return (Number(b.tempo) || 1) * (shot.tempo || 1) * (spec.tempo || 1);
}

function words(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Fix each beat's start, length and end points, shot by shot, and the state at every shot's start.
 * Cached on the spec (spec._prep).
 */
export function prepare(spec) {
  if (spec._prep) return spec._prep;
  const W = spec.size[0];
  const H = spec.size[1];
  const ids = [...Object.keys(spec.cast), ...Object.keys(spec.props)];
  let carry = {};
  ids.forEach((id, i) => (carry[id] = blank(spec, id, (W * (i + 1)) / (ids.length + 1), H * FLOOR)));
  let cam = { x: W / 2, y: H / 2, zoom: 1 };
  const shots = [];
  for (const shot of spec.shots) {
    const start = clone(carry);
    for (const id of ids) start[id].say = null;
    // placing: [x, y] | { at, face, hidden } | null (off stage)
    for (const [id, pl] of Object.entries(shot.place || {})) {
      const e = start[id];
      if (!e) continue;
      if (pl === null) {
        e.visible = false;
        if (e.heldBy && start[e.heldBy]) start[e.heldBy].hold = null;
        e.heldBy = null;
        continue;
      }
      const at = Array.isArray(pl) ? pl : pl.at;
      if (Array.isArray(at)) {
        e.x = Number(at[0]) || 0;
        e.y = at[1] == null ? H * FLOOR : Number(at[1]);
      }
      if (pl.face === -1 || pl.face === 1) e.face = pl.face;
      e.visible = !pl.hidden;
      e.heldBy = null;
    }
    // anything a beat uses is on stage; an appearing verb hides it until then
    const first = new Map();
    for (const b of shot.beats) for (const id of [b.who, b.what, b.to].filter((x) => typeof x === 'string' && start[x])) if (!first.has(id)) first.set(id, b);
    for (const [id, b] of first) {
      const e = start[id];
      const isTarget = b.who !== id && b.what !== id;
      if (!isTarget && APPEAR.has(b.do)) {
        e.visible = true;
        if (b.do === 'pop') e.scale = 0;
        if (b.do === 'draw-on') e.draw = 0;
        if (b.do === 'fade-in') e.opacity = 0;
        if (b.do === 'enter') e.x = b.from === 'right' ? W + sizeOf(spec, id).w : -sizeOf(spec, id).w;
      } else e.visible = true;
    }
    // the camera
    const sc = shot.camera || {};
    let c0 = { ...cam };
    if (sc.zoom || sc.on || sc.at) {
      const z = clamp(Number(sc.zoom) || 1, 0.5, 4);
      const p = sc.on && start[sc.on] ? centreOf(spec, start, sc.on) : Array.isArray(sc.at) ? sc.at : [W / 2, H / 2];
      c0 = { x: p[0], y: p[1], zoom: z };
    } else c0 = { x: W / 2, y: H / 2, zoom: 1 };
    // beats: fix their numbers in time order
    const beats = [];
    for (const raw of shot.beats) {
      const b = { ...raw, verb: raw.do, s: Math.max(0, Number(raw.at) || 0) };
      const now = foldBeats(spec, start, c0, beats, b.s);
      const st = now.ents;
      const k = tempoOf(spec, shot, raw);
      const id = WHO(raw);
      const e = st[id];
      const hh = e && spec.cast[id] ? personH(spec, id) : sizeOf(spec, id).h;
      if (['walk', 'run', 'enter', 'exit'].includes(b.verb) && e) {
        const speed = (b.verb === 'run' ? 0.95 : 0.42) * H * k;
        let to = pointOf(spec, st, raw.to);
        let from = [e.x, e.y];
        if (b.verb === 'enter') {
          from = [raw.from === 'right' ? W + sizeOf(spec, id).w : -sizeOf(spec, id).w, e.y];
          to = to || [W / 2, e.y];
        }
        if (b.verb === 'exit') to = [raw.to === 'left' ? -sizeOf(spec, id).w : W + sizeOf(spec, id).w, e.y];
        if (!to) to = from;
        // stop beside an entity, not on top of it
        if (typeof raw.to === 'string' && st[raw.to] && raw.to !== id) {
          const gap = sizeOf(spec, id).w / 2 + sizeOf(spec, raw.to).w / 2 + 10 * unit(spec);
          to = [to[0] + (from[0] < to[0] ? -gap : gap), st[raw.to].y];
        }
        b.from = from;
        b.to = to;
        b.dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
        b.d = raw.dur > 0 ? raw.dur / k : Math.max(0.3, b.dist / speed);
        b.face = to[0] < from[0] ? -1 : to[0] > from[0] ? 1 : e.face;
        b.stride = hh * (b.verb === 'run' ? 0.62 : 0.38);
        b.phase0 = e.phase;
      } else if (b.verb === 'say' || b.verb === 'think') {
        b.d = raw.dur > 0 ? raw.dur / k : Math.max(1.4, words(raw.text) * 0.34 + 0.6) / k;
      } else if (['pick', 'hand', 'put', 'move'].includes(b.verb)) {
        const what = raw.what;
        const m = st[what];
        b.d = (raw.dur > 0 ? raw.dur : VERB_DUR[b.verb]) / k;
        if (m) {
          const giver = b.verb === 'hand' ? st[raw.who] : null;
          b.from = m.heldBy && st[m.heldBy] ? handAt(spec, st[m.heldBy]) : giver ? handAt(spec, giver) : [m.x, m.y - sizeOf(spec, what).h * 0.35];
          if (b.verb === 'move') {
            const p = pointOf(spec, st, raw.to);
            b.from = [m.x, m.y];
            b.to = p || b.from;
          } else if (b.verb === 'put') {
            const p = typeof raw.to === 'string' && st[raw.to] ? [st[raw.to].x, st[raw.to].y - sizeOf(spec, raw.to).h * st[raw.to].scale] : pointOf(spec, st, raw.to || raw.at);
            b.to = p || [m.x, H * FLOOR];
          }
        }
      } else if (b.verb === 'point' || b.verb === 'look') {
        b.target = typeof raw.at === 'string' && st[raw.at] ? centreOf(spec, st, raw.at) : pointOf(spec, st, raw.at || raw.to);
        b.d = (raw.dur > 0 ? raw.dur : VERB_DUR[b.verb]) / k;
      } else if (b.verb === 'camera') {
        const z = clamp(Number(raw.zoom) || now.cam.zoom, 0.5, 4);
        const p = typeof raw.on === 'string' && st[raw.on] ? centreOf(spec, st, raw.on) : Array.isArray(raw.at) ? raw.at : raw.zoom && !raw.on && !raw.at ? [now.cam.x, now.cam.y] : [W / 2, H / 2];
        b.from = { ...now.cam };
        b.to = { x: p[0], y: p[1], zoom: z };
        b.d = (raw.dur > 0 ? raw.dur : VERB_DUR.camera) / k;
      } else if (b.verb === 'count') {
        b.from = Number(raw.from ?? (st[raw.what]?.value ?? 0)) || 0;
        b.to = Number(raw.to) || 0;
        b.d = (raw.dur > 0 ? raw.dur : VERB_DUR.count) / k;
      } else if (b.verb === 'grow') {
        b.from = e ? e.scale : 1;
        b.to = Number(raw.to) || 1.2;
        b.d = (raw.dur > 0 ? raw.dur : VERB_DUR.grow) / k;
      } else if (b.verb === 'fade') {
        b.from = e ? e.opacity : 1;
        b.to = raw.to === 0 || raw.to === '0' || raw.out ? 0 : Number(raw.to ?? 0);
        b.d = (raw.dur > 0 ? raw.dur : VERB_DUR.fade) / k;
      } else b.d = (raw.dur > 0 ? raw.dur : VERB_DUR[b.verb] || 0.6) / k;
      b.e = b.ease ? easeOf(b.ease) : null;
      beats.push(b);
    }
    const end = foldBeats(spec, start, c0, beats, shot.dur);
    for (const id of ids) {
      end.ents[id].acts = [];
      end.ents[id].say = null;
    }
    shots.push({ start, cam0: c0, beats, end: end.ents, camEnd: end.cam });
    carry = end.ents;
    cam = end.cam;
  }
  Object.defineProperty(spec, '_prep', { value: { shots, ids }, enumerable: false });
  return spec._prep;
}

const ramp = (u, s, d, inT = 0.25, outT = 0.25) => {
  if (u < s || u > s + d) return 0;
  const a = clamp((u - s) / Math.min(inT, d / 2), 0, 1);
  const b = clamp((s + d - u) / Math.min(outT, d / 2), 0, 1);
  return ease.inOut(Math.min(a, b));
};

/** Apply the beats (with fixed numbers) to a shot's start state, at shot time u. */
function foldBeats(spec, start, cam0, beats, u) {
  const st = clone(start);
  let cam = { ...cam0 };
  for (const b of beats) {
    if (u < b.s) continue;
    const p = b.d > 0 ? clamp((u - b.s) / b.d, 0, 1) : 1;
    const e = b.e || ease.inOut;
    const id = WHO(b);
    const a = st[id];
    switch (b.verb) {
      case 'walk':
      case 'run':
      case 'enter':
      case 'exit': {
        if (!a || !b.from) break;
        const q = b.e ? b.e(p) : travel(p);
        a.x = lerp(b.from[0], b.to[0], q);
        a.y = lerp(b.from[1], b.to[1], q);
        a.face = b.face;
        a.visible = !(b.verb === 'exit' && p >= 1);
        a.phase = b.phase0 + (b.dist * q) / (2 * b.stride);
        if (p < 1) {
          a.base = 'walk';
          a.gait = b.verb === 'run' ? 'run' : 'walk';
        } else a.base = 'idle';
        break;
      }
      case 'say':
      case 'think': {
        if (!a || p >= 1) break;
        const t = u - b.s;
        a.say = {
          text: String(b.text || ''),
          kind: b.verb,
          reveal: clamp(t / Math.min(0.6, b.d * 0.35), 0, 1),
          alpha: Math.min(clamp(t / 0.15, 0, 1), clamp((b.d - t) / 0.2, 0, 1)),
          beat: b,
        };
        if (b.verb === 'say') a.acts.push({ name: 'talk', w: ramp(u, b.s, b.d, 0.3, 0.4), t });
        else a.acts.push({ name: 'thinking', w: ramp(u, b.s, b.d, 0.3, 0.4) });
        break;
      }
      case 'emote': {
        if (!a) break;
        a.emote = String(b.as || 'neutral');
        const g = { surprised: 'surprised', frustrated: 'frustrated', thinking: 'thinking', happy: 'cheer', sad: 'sad' }[a.emote];
        if (g) a.acts.push({ name: g, w: ramp(u, b.s, Math.max(b.d, g === 'sad' ? 2.4 : 1.4), 0.25, 0.4) });
        if (a.emote === 'surprised') a.jumpY = Math.max(a.jumpY, Math.sin(clamp((u - b.s) / 0.35, 0, 1) * Math.PI) * personH(spec, id) * 0.05);
        break;
      }
      case 'point':
        if (a && b.target) a.acts.push({ name: 'point', w: ramp(u, b.s, b.d, 0.3, 0.35), at: b.target });
        if (a && b.target && p < 1) a.face = b.target[0] < a.x ? -1 : 1;
        break;
      case 'look':
        if (a && b.target) a.face = b.target[0] < a.x ? -1 : 1;
        break;
      case 'wave':
      case 'cheer':
      case 'type':
      case 'nod':
        if (a) a.acts.push({ name: b.verb, w: ramp(u, b.s, b.d, 0.25, 0.3), t: u - b.s });
        if (a && b.verb === 'cheer' && p < 1) a.jumpY = Math.max(a.jumpY, Math.abs(Math.sin((u - b.s) * Math.PI * 2.4)) * personH(spec, id) * 0.06 * ramp(u, b.s, b.d));
        break;
      case 'jump': {
        if (!a || p >= 1) break;
        const h = personH(spec, id);
        // anticipation (crouch), up and down, land (squash)
        if (p < 0.22) a.squash = Math.sin((p / 0.22) * Math.PI) * 0.12;
        else if (p > 0.85) a.squash = Math.sin(((p - 0.85) / 0.15) * Math.PI) * 0.1;
        else a.jumpY = Math.sin(((p - 0.22) / 0.63) * Math.PI) * h * (Number(b.height) || 0.28);
        a.acts.push({ name: 'cheer', w: p > 0.2 && p < 0.9 ? 0.6 : 0 });
        break;
      }
      case 'pick':
      case 'hand':
      case 'put':
      case 'move': {
        const m = st[b.what];
        if (!m || !b.from) break;
        m.visible = true;
        if (b.verb === 'move') {
          const q = e(p);
          m.x = lerp(b.from[0], b.to[0], q);
          m.y = lerp(b.from[1], b.to[1], q) - Math.sin(q * Math.PI) * (Number(b.arc) || 0) * unit(spec);
          if (m.heldBy) m.heldBy = null;
          break;
        }
        const target = b.verb === 'pick' ? b.who : b.verb === 'hand' ? b.to : null;
        if (p < 1) {
          m.carry = { from: b.from, to: target || b.to, p: e(p), arc: (b.verb === 'put' ? 30 : 60) * unit(spec) };
          m.heldBy = null;
          if (st[b.who]) st[b.who].acts.push({ name: 'reach', w: ramp(u, b.s, b.d, 0.2, 0.2) });
          if (b.verb === 'hand' && st[b.to]) st[b.to].acts.push({ name: 'reach', w: ramp(u, b.s, b.d, 0.3, 0.1) });
        } else {
          m.carry = null;
          if (st[b.who] && st[b.who].hold === b.what) st[b.who].hold = null;
          if (target && st[target]) {
            m.heldBy = target;
            st[target].hold = b.what;
          } else {
            m.heldBy = null;
            m.x = b.to[0];
            m.y = b.to[1];
          }
        }
        break;
      }
      case 'pop':
        if (a) a.scale = p >= 1 ? 1 : Math.max(0, ease.back(p));
        break;
      case 'fade':
      case 'fade-in':
        if (a) a.opacity = b.verb === 'fade-in' ? e(p) : lerp(b.from, b.to, e(p));
        if (a && b.verb === 'fade' && b.to === 0 && p >= 1) a.visible = false;
        break;
      case 'draw-on':
        if (a) a.draw = b.e ? b.e(p) : ease.inOut(p);
        break;
      case 'grow':
        if (a) a.scale = lerp(b.from, b.to, b.e ? b.e(p) : ease.back(p));
        break;
      case 'shake':
        if (a) a.shakeX = p < 1 ? Math.sin(p * Math.PI * 8) * (1 - p) * 14 * unit(spec) : 0;
        break;
      case 'count':
        if (a) a.value = lerp(b.from, b.to, ease.out(p));
        break;
      case 'camera':
        if (b.to) {
          const q = e(p);
          cam = { x: lerp(b.from.x, b.to.x, q), y: lerp(b.from.y, b.to.y, q), zoom: lerp(b.from.zoom, b.to.zoom, q) };
        }
        break;
      default:
        break;
    }
  }
  return { ents: st, cam };
}

/** Held and carried things follow hands. */
function attach(spec, st) {
  for (const m of Object.values(st)) {
    const hh = sizeOf(spec, m.id).h * m.scale;
    if (m.heldBy && st[m.heldBy]) {
      const [hx, hy] = handAt(spec, st[m.heldBy]);
      m.x = hx;
      m.y = hy + hh * 0.35;
      m.visible = st[m.heldBy].visible;
    } else if (m.carry) {
      const c = m.carry;
      const to = typeof c.to === 'string' && st[c.to] ? handAt(spec, st[c.to]) : c.to;
      const x = lerp(c.from[0], to[0], c.p);
      const y = lerp(c.from[1], to[1], c.p) - Math.sin(c.p * Math.PI) * c.arc;
      m.x = x;
      m.y = y + hh * 0.35;
    }
  }
}

function clampCam(spec, cam) {
  const [W, H] = spec.size;
  const z = Math.max(1, cam.zoom);
  const hw = W / (2 * z);
  const hh = H / (2 * z);
  return { x: clamp(cam.x, hw, W - hw), y: clamp(cam.y, hh, H - hh), zoom: cam.zoom };
}

function zoomOn(spec, st, id, z) {
  const c = centreOf(spec, st, id);
  return c ? { x: c[0], y: c[1], zoom: z } : null;
}

const lerpCam = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), zoom: lerp(a.zoom, b.zoom, p) });

/** Which shot time t falls in. */
export function shotAt(spec, t) {
  const sh = spec.shots;
  for (let i = 0; i < sh.length; i++) if (t < sh[i].t1) return i;
  return sh.length - 1;
}

/**
 * Everything at time t: { t, i (shot), u (shot time), ents: { id: state }, cam: { x, y, zoom }, trans }.
 * trans: null, or { kind: 'fade' | 'wipe' | 'push', p, prevT } (draw the previous shot's last frame under it).
 */
export function stateAt(spec, t, { noTrans = false } = {}) {
  const prep = prepare(spec);
  if (!spec.shots.length) return { t, i: 0, u: 0, ents: {}, cam: { x: spec.size[0] / 2, y: spec.size[1] / 2, zoom: 1 }, trans: null };
  t = clamp(t, 0, Math.max(0, spec.duration - 1e-4));
  const i = shotAt(spec, t);
  const shot = spec.shots[i];
  const P = prep.shots[i];
  const u = t - shot.t0;
  const { ents, cam: c } = foldBeats(spec, P.start, P.cam0, P.beats, u);
  attach(spec, ents);
  let cam = c;
  // match cuts: the camera pushes into the object at the end of one shot and pulls out of it in the next
  const [kind, obj] = String(shot.in || 'cut').split(':');
  if (kind === 'match' && i > 0 && u < MATCH) {
    const z = zoomOn(spec, ents, obj, 2.4);
    if (z) cam = lerpCam(z, cam, ease.out(u / MATCH));
  }
  const next = spec.shots[i + 1];
  if (next) {
    const [nk, nobj] = String(next.in || 'cut').split(':');
    const left = shot.t1 - t;
    if (nk === 'match' && left < MATCH) {
      const z = zoomOn(spec, ents, nobj, 2.4);
      if (z) cam = lerpCam(cam, z, ease.in(1 - left / MATCH));
    }
  }
  cam = clampCam(spec, cam);
  let trans = null;
  if (!noTrans && i > 0) {
    const d = kind === 'match' ? 0.18 : TRANSITION;
    if (['fade', 'wipe', 'push', 'match'].includes(kind) && u < d) trans = { kind: kind === 'match' ? 'fade' : kind, p: ease.inOut(u / d), prevT: spec.shots[i - 1].t1 - 1e-3 };
  }
  return { t, i, u, ents, cam, trans };
}

/** World px → screen px for a camera. */
export function toScreen(spec, cam, x, y) {
  const [W, H] = spec.size;
  return [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];
}

/** An entity's box in world px [x, y, w, h], or null when it isn't drawn. */
export function boxOf(spec, st, id) {
  const e = st[id];
  if (!e || !e.visible || e.opacity < 0.04 || e.scale < 0.04 || e.draw < 0.02) return null;
  const p = spec.props[id];
  if (p?.kit === 'arrow') {
    const a = arrowEnds(spec, st, id);
    if (!a) return null;
    const pad = 20 * unit(spec);
    const x0 = Math.min(a[0][0], a[1][0]) - pad;
    const y0 = Math.min(a[0][1], a[1][1]) - pad;
    return [x0, y0, Math.abs(a[1][0] - a[0][0]) + 2 * pad, Math.abs(a[1][1] - a[0][1]) + 2 * pad];
  }
  const { w, h } = sizeOf(spec, id);
  const sw = w * e.scale;
  const sh = h * e.scale;
  return [e.x - sw / 2 + e.shakeX, e.y - sh - e.jumpY, sw, sh];
}

/** An arrow's two ends in world px (from/to: an entity id or [x, y]), pulled back from the things it joins. */
export function arrowEnds(spec, st, id) {
  const p = spec.props[id];
  const end = (v) => (typeof v === 'string' && st[v] ? centreOf(spec, st, v) : Array.isArray(v) ? [Number(v[0]), Number(v[1])] : null);
  const a = end(p.from);
  const b = end(p.to);
  if (!a || !b) return null;
  const shrink = (pt, other, ref) => {
    if (typeof ref !== 'string' || !st[ref]) return pt;
    const { w, h } = sizeOf(spec, ref);
    const r = (Math.min(w, h) * st[ref].scale) / 2 + 16 * unit(spec);
    const d = Math.hypot(other[0] - pt[0], other[1] - pt[1]) || 1;
    return [pt[0] + ((other[0] - pt[0]) / d) * r, pt[1] + ((other[1] - pt[1]) / d) * r];
  };
  return [shrink(a, b, p.from), shrink(b, a, p.to)];
}

/** A speech or thought bubble's box in world px, and its text lines. */
export function bubbleOf(spec, st, id) {
  const a = st[id];
  if (!a?.say || !a.visible) return null;
  const u = unit(spec);
  const fs = 34 * u;
  const lines = wrap(a.say.text, 22);
  const w = Math.max(...lines.map((l) => l.length), 4) * fs * 0.5 + fs * 1.4;
  const h = lines.length * fs * 1.25 + fs * 1.1;
  const ph = personH(spec, id) * a.scale;
  const headTop = a.y - ph - a.jumpY;
  let x = a.x + a.face * ph * 0.18 - w / 2 + a.face * w * 0.3;
  x = clamp(x, 12 * u, spec.size[0] - w - 12 * u);
  const y = Math.max(12 * u, headTop - h - 36 * u);
  return { box: [x, y, w, h], lines, fs, tail: [a.x + a.face * ph * 0.06, headTop - 6 * u] };
}

export function wrap(text, max) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + ' ' + word).trim().length > max && line) {
        out.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
