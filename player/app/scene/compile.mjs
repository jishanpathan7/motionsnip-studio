// MotionSnip Scenes: scene.json → a checked spec, the reel the player reviews, and the scene's own checks.
// A scene project has no reel.json: the server builds one from scene.json with toReel(), the way it makes one
// up for a plain video. Pure (no DOM): the server, the selftest and the browser all import it.

import { prepare, stateAt, boxOf, bubbleOf, toScreen, sizeOf, VERBS, KIT } from './motion.mjs';
import { clamp } from './geom.mjs';

/** Looks. Each is a pen, a palette and a font; a scene's own palette entries win. */
export const STYLES = {
  ink: { label: 'Ink', wobble: 0.7, stroke: 3.2, boil: 6, grain: 0.18, font: 'hand', palette: { ink: '#16141a', paper: '#fffdf6', accent: '#ff4fa8', soft: '#f1ede4', second: '#3d8bfd' } },
  marker: { label: 'Marker', wobble: 1, stroke: 5.5, boil: 8, grain: 0.1, font: 'hand', palette: { ink: '#1d1b22', paper: '#fbfaf7', accent: '#ff7a1a', soft: '#ffe7a8', second: '#2bb673' } },
  flat: { label: 'Flat', wobble: 0, stroke: 3, boil: 0, grain: 0, font: 'sans', palette: { ink: '#20202a', paper: '#f7f7fb', accent: '#6c5ce7', soft: '#e6e4f5', second: '#00b894' } },
};

const FONTS = { hand: "'Patrick Hand', 'Chalkboard SE', 'Comic Neue', 'Segoe Print', cursive", sans: "'Bricolage Grotesque', ui-sans-serif, system-ui, sans-serif", mono: "'DM Mono', ui-monospace, monospace" };
export const fontFamily = (name) => FONTS[name] || FONTS.hand;

const HAIR = ['none', 'short', 'bun', 'long', 'spiky', 'cap'];
const EMOTES = ['neutral', 'happy', 'sad', 'surprised', 'frustrated', 'thinking'];
const TRANSITIONS = ['cut', 'fade', 'wipe', 'push', 'match'];
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const idOk = (s) => typeof s === 'string' && /^[A-Za-z][\w-]{0,39}$/.test(s);
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** scene.json → a spec with every default filled in. Never throws; unknown things are dropped (lint reports them). */
export function normScene(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const size = Array.isArray(r.size) && r.size.length === 2 ? r.size.map((v, i) => clamp(Math.round(num(+v, i ? 1080 : 1920)), 64, 4096)) : [1920, 1080];
  const st = r.style && typeof r.style === 'object' ? r.style : {};
  const preset = STYLES[st.preset] ? st.preset : 'ink';
  const P = STYLES[preset];
  const style = {
    preset,
    wobble: clamp(num(st.wobble, P.wobble), 0, 3),
    stroke: clamp(num(st.stroke, P.stroke), 0.5, 20),
    boil: clamp(num(st.boil, P.boil), 0, 24),
    grain: clamp(num(st.grain, P.grain), 0, 1),
    font: FONTS[st.font] ? st.font : P.font,
    floor: st.floor !== false,
    palette: { ...P.palette, ...(st.palette && typeof st.palette === 'object' ? st.palette : {}) },
  };
  const cast = {};
  for (const [id, c] of Object.entries(r.cast && typeof r.cast === 'object' ? r.cast : {})) {
    if (!idOk(id) || !c || typeof c !== 'object') continue;
    const look = c.look && typeof c.look === 'object' ? c.look : {};
    cast[id] = {
      kind: c.kind === 'robot' ? 'robot' : 'person',
      name: String(c.name || id),
      scale: clamp(num(c.scale, 1), 0.2, 3),
      look: { hair: HAIR.includes(look.hair) ? look.hair : 'short', shirt: look.shirt || 'paper', body: look.body || 'soft', skin: look.skin || 'paper', ...look },
    };
  }
  const props = {};
  for (const [id, p] of Object.entries(r.props && typeof r.props === 'object' ? r.props : {})) {
    if (!idOk(id) || cast[id] || !p || typeof p !== 'object') continue;
    const kit = KIT[p.kit] ? p.kit : p.draw ? null : p.image ? null : 'box';
    props[id] = { ...p, kit, name: String(p.name || id), scale: clamp(num(p.scale, 1), 0.1, 8) };
  }
  let t0 = 0;
  const shots = [];
  const seen = new Set();
  (Array.isArray(r.shots) ? r.shots : []).slice(0, 60).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    let id = idOk(s.id) ? s.id : `s${i + 1}`;
    while (seen.has(id)) id += 'b';
    seen.add(id);
    const dur = clamp(num(s.dur, 4), 0.5, 120);
    const [tk] = String(s.in || 'cut').split(':');
    const beats = (Array.isArray(s.beats) ? s.beats : [])
      .slice(0, 200)
      .map((b, j) => (b && typeof b === 'object' ? { ...b, at: clamp(num(+b.at, 0), 0, dur), _j: j } : null))
      .filter((b) => b && VERBS.includes(b.do))
      .sort((a, b) => a.at - b.at || a._j - b._j);
    shots.push({
      id,
      name: String(s.name || id),
      dur,
      in: i === 0 ? 'cut' : TRANSITIONS.includes(tk) ? String(s.in) : 'cut',
      tempo: clamp(num(s.tempo, 1), 0.2, 5),
      camera: s.camera && typeof s.camera === 'object' ? s.camera : null,
      place: s.place && typeof s.place === 'object' ? s.place : {},
      beats,
      index: i,
      t0: r3(t0),
      t1: r3(t0 + dur),
    });
    t0 += dur;
  });
  return {
    id: String(r.id || r.title || 'scene'),
    title: String(r.title || 'Untitled scene'),
    version: Math.max(0, Math.round(num(r.version, 1))),
    size,
    fps: clamp(Math.round(num(r.fps, 30)), 1, 120),
    loop: !!r.loop,
    tempo: clamp(num(r.tempo, 1), 0.2, 5),
    style,
    cast,
    props,
    shots,
    duration: r3(t0),
    audio: r.audio && typeof r.audio === 'object' ? r.audio : null,
  };
}

/** A palette name, brand.<name> or a colour → a colour. */
export function colorOf(spec, v, fallback = '#000') {
  if (typeof v !== 'string' || !v) return fallback;
  const k = v.startsWith('brand.') ? v.slice(6) : v;
  return spec.style.palette[k] || (/^#|^rgb|^hsl/.test(v) ? v : fallback);
}

// ---------------------------------------------------------------- the reel

const pct = (spec, b) => [r1((b[0] / spec.size[0]) * 100), r1((b[1] / spec.size[1]) * 100), r1((b[2] / spec.size[0]) * 100), r1((b[3] / spec.size[1]) * 100)];

function screenBox(spec, s, b) {
  const [x, y] = toScreen(spec, s.cam, b[0], b[1]);
  return [x, y, b[2] * s.cam.zoom, b[3] * s.cam.zoom];
}

// palette names show as brand.<name>, the player's own way of linking a colour to the brand
function colorProp(label, v, path) {
  const s = String(v);
  return { type: 'color', label, v: /^[A-Za-z][\w-]*$/.test(s) ? `brand.${s}` : s, path };
}

const beatPath = (shot, b) => `shots[${shot.index}].beats[${b._j}]`;

function describeBeats(spec, shot, id) {
  const bits = shot.beats
    .filter((b) => b.who === id || b.what === id)
    .map((b) => {
      const to = typeof b.to === 'string' ? ` to ${spec.cast[b.to]?.name || spec.props[b.to]?.name || b.to}` : '';
      if (b.do === 'say' || b.do === 'think') return `${b.do}s "${String(b.text || '').slice(0, 40)}"`;
      if (b.do === 'emote') return `looks ${b.as}`;
      return `${b.do}${b.who === id || !b.who ? '' : ' (by ' + b.who + ')'}${to}`;
    });
  return bits.length ? bits.join(', then ') : 'stays put';
}

/**
 * The reel for a scene: shots are scenes, the cast, props and lines are elements whose props point back at
 * scene.json (`path`), so the player's edits and Claude's exact changes land in the right place.
 */
export function toReel(raw, { src = '' } = {}) {
  const spec = normScene(raw);
  prepare(spec);
  const scenes = spec.shots.map((shot) => {
    const els = [];
    const ids = [...Object.keys(spec.cast), ...Object.keys(spec.props)];
    for (const id of ids) {
      let a = null;
      let b = null;
      for (let u = 0; u <= shot.dur + 1e-6; u += 0.1) {
        const s = stateAt(spec, shot.t0 + Math.min(u, shot.dur - 1e-3), { noTrans: true });
        if (boxOf(spec, s.ents, id)) {
          if (a === null) a = u;
          b = u;
        }
      }
      if (a === null) continue;
      const mid = shot.t0 + Math.min((a + b) / 2, shot.dur - 1e-3);
      const s = stateAt(spec, mid, { noTrans: true });
      const wb = boxOf(spec, s.ents, id);
      if (!wb) continue;
      const c = spec.cast[id];
      const p = spec.props[id];
      const props = {};
      if (c) {
        if (c.kind === 'person') {
          props.shirt = colorProp('Shirt', c.look.shirt, `cast.${id}.look.shirt`);
          props.hair = { type: 'choice', label: 'Hair', v: c.look.hair, options: HAIR, path: `cast.${id}.look.hair` };
        } else props.body = colorProp('Body', c.look.body, `cast.${id}.look.body`);
      } else {
        if (p.fill || ['box', 'chart', 'bulb', 'star', 'check', 'sign', 'cloud', 'database', 'phone', 'laptop', 'screen', 'doc'].includes(p.kit) || p.draw)
          props.fill = colorProp('Fill', p.fill || (p.kit === 'star' || p.kit === 'bulb' ? 'accent' : 'paper'), `props.${id}.fill`);
        if (['sign', 'text', 'screen', 'doc', 'box', 'laptop', 'phone'].includes(p.kit)) props.text = { type: p.kit === 'text' ? 'longtext' : 'text', label: 'Text', v: String(p.text || ''), path: `props.${id}.text` };
        if (p.kit === 'chart') props.data = { type: 'text', label: 'Values', v: (Array.isArray(p.data) ? p.data : []).join(', '), path: `props.${id}.data` };
      }
      props.motion = { type: 'motion', label: 'Motion', v: describeBeats(spec, shot, id) };
      els.push({
        id: `${id}@${shot.id}`,
        label: c ? c.name : p.name,
        t: [r3(shot.t0 + a), r3(shot.t0 + Math.min(b + 0.1, shot.dur))],
        box: pct(spec, screenBox(spec, s, wb)),
        src: `scene.json › ${c ? 'cast' : 'props'}.${id}`,
        entity: id,
        props,
      });
    }
    // lines
    for (const bt of shot.beats.filter((x) => (x.do === 'say' || x.do === 'think') && spec.cast[x.who])) {
      const P = prepare(spec).shots[shot.index].beats.find((x) => x._j === bt._j);
      const tt = shot.t0 + Math.min(bt.at + Math.min(P.d / 2, 1), shot.dur - 1e-3);
      const s = stateAt(spec, tt, { noTrans: true });
      const bub = bubbleOf(spec, s.ents, bt.who);
      if (!bub) continue;
      els.push({
        id: `line${bt._j + 1}@${shot.id}`,
        label: `${spec.cast[bt.who].name} ${bt.do}s`,
        t: [r3(shot.t0 + bt.at), r3(Math.min(shot.t1, shot.t0 + bt.at + P.d))],
        box: pct(spec, screenBox(spec, s, bub.box)),
        src: `scene.json › ${beatPath(shot, bt)}`,
        props: { text: { type: 'text', label: 'Line', v: String(bt.text || ''), path: `${beatPath(shot, bt)}.text` } },
      });
    }
    return { id: shot.id, name: shot.name, t: [shot.t0, shot.t1], els };
  });
  const colors = Object.entries(spec.style.palette).map(([id, v]) => ({ id, name: id[0].toUpperCase() + id.slice(1), v }));
  const reel = {
    id: spec.id,
    title: spec.title,
    version: spec.version,
    src,
    w: spec.size[0],
    h: spec.size[1],
    fps: spec.fps,
    duration: spec.duration,
    scene: true,
    brand: { colors, fonts: [{ id: 'scene', name: 'Scene font', v: spec.style.font }], logo: null },
    scenes,
    review: lint(spec),
    live: { type: 'scene', spec: 'scene.json' },
  };
  if (spec.audio) reel.audio = spec.audio;
  return reel;
}

// ---------------------------------------------------------------- the scene's own checks

/** Things a viewer would notice: lines too fast to read, things off the frame, references to nothing. */
export function lint(spec) {
  const out = [];
  const add = (f) => out.length < 30 && out.push({ id: `check-${out.length + 1}`, kind: 'scene check', ...f });
  const ids = new Set([...Object.keys(spec.cast), ...Object.keys(spec.props)]);
  const P = prepare(spec);
  for (const shot of spec.shots) {
    for (const b of P.shots[shot.index].beats) {
      const t = shot.t0 + b.s;
      for (const k of ['who', 'what']) if (typeof b[k] === 'string' && !ids.has(b[k])) add({ t, title: `"${b[k]}" isn't in the cast or props`, detail: `${shot.name}, beat ${b._j + 1} (${b.do}).`, fix: `Add "${b[k]}" to cast or props, or fix the name.` });
      if ((b.verb === 'say' || b.verb === 'think') && spec.cast[b.who]) {
        const wps = String(b.text || '').trim().split(/\s+/).filter(Boolean).length / b.d;
        if (wps > 3.2) add({ t, elId: `line${b._j + 1}@${shot.id}`, title: 'Too fast to read', detail: `${r1(wps)} words a second; about 3 is comfortable.`, fix: `Give the line ${r1(String(b.text).split(/\s+/).length / 2.8)} s, or shorten it.` });
        if (shot.t0 + b.s + b.d > shot.t1 + 0.05) add({ t, elId: `line${b._j + 1}@${shot.id}`, title: 'The line is cut off by the next shot', detail: `It needs ${r1(b.d)} s but the shot ends ${r1(shot.dur - b.s)} s after it starts.`, fix: 'Make the shot longer or start the line earlier.' });
      }
    }
    // off the frame, half way through the shot
    const s = stateAt(spec, shot.t0 + shot.dur / 2, { noTrans: true });
    for (const id of ids) {
      const b = boxOf(spec, s.ents, id);
      if (!b) continue;
      const [x, y, w, h] = screenBox(spec, s, b);
      const [W, H] = spec.size;
      const out1 = Math.max(0, -x) + Math.max(0, x + w - W);
      const out2 = Math.max(0, -y) + Math.max(0, y + h - H);
      if (out1 > w * 0.3 || out2 > h * 0.3) add({ t: s.t, elId: `${id}@${shot.id}`, title: `${spec.cast[id]?.name || spec.props[id].name} is partly off the frame`, detail: `${shot.name}, half way through.`, fix: 'Move it in, or zoom the camera out.' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- edits

/** Every scene.json path the player may change: element props, and where things stand in each shot. */
export function editablePaths(raw) {
  const reel = toReel(raw);
  const paths = new Set();
  for (const s of reel.scenes) for (const el of s.els) for (const p of Object.values(el.props)) if (p.path) paths.add(p.path);
  for (const k of Object.keys(normScene(raw).style.palette)) paths.add(`style.palette.${k}`);
  return paths;
}

const segs = (path) => String(path).match(/[^.[\]]+/g) || [];

/** Set a value at a path in a copy of raw; arrays for chart values. Unknown parents are created as objects. */
export function setPath(raw, path, value) {
  const out = structuredClone(raw);
  const k = segs(path);
  let o = out;
  for (let i = 0; i < k.length - 1; i++) {
    if (o[k[i]] == null || typeof o[k[i]] !== 'object') o[k[i]] = /^\d+$/.test(k[i + 1]) ? [] : {};
    o = o[k[i]];
  }
  const last = k[k.length - 1];
  o[last] = last === 'data' && typeof value === 'string' ? value.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite) : value;
  return out;
}

/** Element-prop edits ({ elId: { prop: value } }) and palette edits → scene.json patches [{ path, value }]. */
export function patchesFor(reel, edits = {}, palette = {}) {
  const out = [];
  const els = new Map(reel.scenes.flatMap((s) => s.els.map((e) => [e.id, e])));
  for (const [elId, props] of Object.entries(edits)) {
    const el = els.get(elId);
    if (!el) continue;
    for (const [k, v] of Object.entries(props)) if (el.props[k]?.path) out.push({ path: el.props[k].path, value: v });
  }
  for (const [k, v] of Object.entries(palette)) out.push({ path: `style.palette.${k}`, value: v });
  return out;
}

/** Apply patches to raw (a copy), only at editable paths. Throws on any other path. */
export function applyPatches(raw, patches) {
  const ok = editablePaths(raw);
  let out = raw;
  for (const p of patches) {
    if (!p || typeof p.path !== 'string' || !ok.has(p.path)) throw new Error(`Can't change ${p?.path ?? 'that'} here`);
    out = setPath(out, p.path, p.value);
  }
  return out;
}

export { EMOTES, sizeOf };
