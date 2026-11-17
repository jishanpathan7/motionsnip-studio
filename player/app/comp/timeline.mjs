// timeline.json: one non-destructive composition that both Claude and the editor write. Pure functions, shared by
// the browser (preview, editor) and the server (reel, lint, apply, export), like scene/compile.mjs.
//
// Tracks are layers: a later track draws over an earlier one. Clip times (at, dur) are timeline seconds;
// in/out are seconds in the clip's source. Keyframes are [t, value, ease?] with t relative to the clip's start.
import { normScene, toReel as sceneToReel } from '../scene/compile.mjs';

export const KINDS = ['video', 'scene', 'graphics', 'audio', 'captions'];
export const VISUAL = new Set(['video', 'scene', 'graphics', 'captions']);
export const GFX = ['text', 'shape', 'image', 'blur'];
export const PRESETS = ['none', 'fade', 'pop', 'slide-up', 'type-on', 'word-stagger'];
export const TRANSITIONS = ['fade', 'wipe', 'slide', 'zoom'];
export const EASES = ['linear', 'in', 'out', 'inOut', 'hold'];
export const KEYS = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 };
export const FONTS = ['Bricolage Grotesque', 'DM Mono', 'Patrick Hand', 'system-ui'];
const KIND_NAMES = { video: 'Video', scene: 'Scene', graphics: 'Graphics', audio: 'Audio', captions: 'Captions' };
const ROLES = ['music', 'voice', 'sfx'];
/** Id prefixes for new tracks; clips are c1, c2, … */
export const TRACK_PREFIX = { video: 'v', scene: 's', graphics: 'g', audio: 'a', captions: 'cc' };

const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
export const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// ---------------------------------------------------------------- easing and keyframes

export function ease(name, p) {
  p = clamp(p, 0, 1);
  switch (name) {
    case 'in':
      return p * p * p;
    case 'out':
      return 1 - (1 - p) ** 3;
    case 'inOut':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    case 'hold':
      return p >= 1 ? 1 : 0;
    default:
      return p;
  }
}

/** [[t, v, ease?], …] sorted by t, numbers only. A bare number is a constant. */
export function normKeyList(list) {
  if (typeof list === 'number' && Number.isFinite(list)) return [[0, list]];
  if (!Array.isArray(list)) return [];
  return list
    .filter((k) => Array.isArray(k) && Number.isFinite(num(k[0], NaN)) && Number.isFinite(num(k[1], NaN)))
    .map((k) => (EASES.includes(k[2]) && k[2] !== 'linear' ? [r3(Math.max(0, num(k[0]))), num(k[1]), k[2]] : [r3(Math.max(0, num(k[0]))), num(k[1])]))
    .sort((a, b) => a[0] - b[0]);
}

/** The value of a key list at local time t. Each key's ease shapes the way into the next key. */
export function valueAt(list, t, d = 0) {
  if (!list || !list.length) return d;
  if (t <= list[0][0]) return list[0][1];
  for (let i = 0; i < list.length - 1; i++) {
    const [t0, v0, e] = list[i];
    const [t1, v1] = list[i + 1];
    if (t <= t1) return t1 === t0 ? v1 : v0 + (v1 - v0) * ease(e || 'linear', (t - t0) / (t1 - t0));
  }
  return list[list.length - 1][1];
}

function normKeys(k) {
  const o = obj(k) || {};
  const out = {};
  for (const p of Object.keys(KEYS)) {
    const l = normKeyList(o[p]);
    if (l.length) out[p] = l;
  }
  return out;
}

const normTrans = (t) => {
  const o = typeof t === 'string' ? { kind: t } : obj(t);
  if (!o || !TRANSITIONS.includes(o.kind)) return null;
  return { kind: o.kind, dur: clamp(num(o.dur, 0.5), 0.05, 10) };
};

function normBox(b, d) {
  if (!Array.isArray(b) || b.length !== 4) return d;
  const v = b.map((x) => num(x, NaN));
  if (v.some((x) => !Number.isFinite(x))) return d;
  return [v[0], v[1], Math.max(0.1, v[2]), Math.max(0.1, v[3])];
}

function normLook(l) {
  const o = obj(l);
  if (!o) return null;
  const out = {};
  for (const k of ['brightness', 'contrast', 'saturation', 'warmth']) {
    const v = num(o[k], 0);
    if (v) out[k] = clamp(v, -1, 1);
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- ids

const ID = /^[\w-]{1,40}$/;

/**
 * Give every track and clip an id (a copy of raw). Ids already written win, first come first served; the rest get
 * the smallest free v1/s1/g1/a1/cc1 for tracks and c1, c2, … for clips. issues collects duplicates.
 */
export function ensureIds(raw, issues = null) {
  const out = structuredClone(obj(raw) || {});
  if (!Array.isArray(out.tracks)) out.tracks = [];
  const ids = new Set();
  const items = [];
  for (const t of out.tracks) {
    if (!obj(t) || !KINDS.includes(t.kind)) continue;
    items.push([t, TRACK_PREFIX[t.kind]]);
    if (!Array.isArray(t.clips)) t.clips = [];
    for (const c of t.clips) if (obj(c)) items.push([c, 'c']);
  }
  const todo = [];
  for (const [x, prefix] of items) {
    if (typeof x.id === 'string' && ID.test(x.id) && !ids.has(x.id)) ids.add(x.id);
    else {
      if (typeof x.id === 'string' && ids.has(x.id) && issues) issues.push({ title: `Two things are called "${x.id}"`, fix: 'Give each track and clip its own id.' });
      todo.push([x, prefix]);
    }
  }
  for (const [x, prefix] of todo) {
    let n = 1;
    while (ids.has(`${prefix}${n}`)) n++;
    x.id = `${prefix}${n}`;
    ids.add(x.id);
  }
  return out;
}

// ---------------------------------------------------------------- normalise

/**
 * timeline.json → a complete, safe model. opts.scenes: { 'scene.json': raw spec } for scene clips (their length
 * comes from the shots). Never throws on bad data; lint() says what is wrong.
 */
export function normTimeline(raw, { scenes = {} } = {}) {
  const r = obj(raw) || {};
  const size = Array.isArray(r.size) && r.size.length === 2 ? r.size.map((v, i) => Math.round(clamp(num(v, i ? 1080 : 1920), 16, 8192))) : [1920, 1080];
  const tl = {
    version: Math.max(1, Math.round(num(r.version, 1))),
    title: str(r.title, 'Untitled').trim() || 'Untitled',
    size,
    fps: Math.round(clamp(num(r.fps, 30), 1, 60)),
    bg: /^#[0-9a-f]{3,8}$/i.test(str(r.bg)) ? r.bg : '#000000',
    tracks: [],
    markers: [],
    scenes: {},
    issues: [],
  };
  for (const [file, spec] of Object.entries(scenes || {})) if (obj(spec)) tl.scenes[file] = normScene(spec);
  const withIds = ensureIds(r, tl.issues);
  const count = {};
  withIds.tracks.forEach((t, ti) => {
    if (!obj(t)) return;
    if (!KINDS.includes(t.kind)) {
      tl.issues.push({ title: `Track ${ti + 1} has an unknown kind "${t.kind}"`, fix: `Use one of ${KINDS.join(', ')}.` });
      return;
    }
    count[t.kind] = (count[t.kind] || 0) + 1;
    const track = {
      id: t.id,
      kind: t.kind,
      name: str(t.name).trim() || `${KIND_NAMES[t.kind]} ${count[t.kind]}`,
      index: ti,
      path: `tracks[${ti}]`,
      mute: !!t.mute,
      solo: !!t.solo,
      lock: !!t.lock,
      hide: !!t.hide,
      gain: clamp(num(t.gain, 1), 0, 2),
      role: t.kind === 'audio' ? (ROLES.includes(t.role) ? t.role : 'music') : null,
      clips: [],
    };
    (Array.isArray(t.clips) ? t.clips : []).forEach((c, ci) => {
      if (!obj(c)) return;
      const clip = normClip(c, track, tl);
      clip.id = c.id;
      clip.index = ci;
      clip.path = `tracks[${ti}].clips[${ci}]`;
      clip.track = track.id;
      clip.kind = track.kind;
      track.clips.push(clip);
    });
    track.clips.sort((a, b) => a.at - b.at);
    tl.tracks.push(track);
  });
  (Array.isArray(r.markers) ? r.markers : []).forEach((m, i) => {
    if (!obj(m)) return;
    const t = Array.isArray(m.t) ? [num(m.t[0], 0), num(m.t[1], num(m.t[0], 0))] : [num(m.t, 0), num(m.t, 0)];
    tl.markers.push({ id: str(m.id) || `m${i + 1}`, name: str(m.name) || `Marker ${i + 1}`, t: [Math.max(0, Math.min(t[0], t[1])), Math.max(0, t[0], t[1])], index: i });
  });
  let end = 0;
  for (const tr of tl.tracks) for (const c of tr.clips) end = Math.max(end, c.end);
  for (const m of tl.markers) end = Math.max(end, m.t[1]);
  tl.duration = r3(Math.max(end, num(r.duration, 0)) || 0);
  return tl;
}

function sceneLength(tl, c) {
  const spec = tl.scenes[c.scene];
  if (!spec) return { shots: [], len: null };
  const want = Array.isArray(c.shots) && c.shots.length ? c.shots.map(String) : spec.shots.map((s) => s.id);
  const shots = want.map((id) => spec.shots.find((s) => s.id === id)).filter(Boolean);
  return { shots, missing: want.filter((id) => !spec.shots.some((s) => s.id === id)), len: shots.reduce((n, s) => n + s.dur, 0) };
}

function normClip(c, track, tl) {
  const at = Math.max(0, num(c.at, 0));
  const out = { at: r3(at), name: str(c.name).trim(), keys: normKeys(c.keys), enter: normTrans(c.enter), exit: normTrans(c.exit) };
  let dur = num(c.dur, NaN);
  switch (track.kind) {
    case 'video':
    case 'audio': {
      out.src = str(c.src);
      out.in = Math.max(0, num(c.in, 0));
      const o = num(c.out, NaN);
      if (Number.isFinite(o) && o > out.in) dur = o - out.in;
      out.gain = clamp(num(c.gain, 1), 0, 2);
      out.mute = !!c.mute;
      out.fadeIn = Math.max(0, num(c.fadeIn, 0));
      out.fadeOut = Math.max(0, num(c.fadeOut, 0));
      if (track.kind === 'video') {
        out.box = normBox(c.box, null);
        out.fit = c.fit === 'contain' ? 'contain' : 'cover';
        out.look = normLook(c.look);
      }
      if (!(dur > 0)) {
        out.noLength = true;
        dur = 5;
      }
      out.out = r3(out.in + dur);
      break;
    }
    case 'scene': {
      out.scene = str(c.scene, 'scene.json') || 'scene.json';
      out.in = Math.max(0, num(c.in, 0));
      const { shots, missing, len } = sceneLength(tl, { scene: out.scene, shots: c.shots });
      out.shots = shots.map((s) => s.id);
      out.missingShots = missing || [];
      out.noScene = len == null;
      if (!(dur > 0)) dur = len != null ? Math.max(0.1, len - out.in) : 5;
      break;
    }
    case 'graphics': {
      out.type = GFX.includes(c.type) ? c.type : 'text';
      out.box = normBox(c.box, out.type === 'text' ? [10, 40, 80, 20] : [35, 35, 30, 30]);
      if (out.type === 'text') {
        out.text = str(c.text);
        const s = obj(c.style) || {};
        out.style = {
          font: str(s.font, 'Bricolage Grotesque') || 'Bricolage Grotesque',
          size: clamp(num(s.size, 8), 1, 60), // % of the frame height
          weight: clamp(Math.round(num(s.weight, 700) / 100) * 100, 100, 900),
          color: str(s.color, '#ffffff') || '#ffffff',
          bg: str(s.bg) || null,
          align: ['left', 'center', 'right'].includes(s.align) ? s.align : 'center',
          shadow: s.shadow === undefined ? true : !!s.shadow,
        };
        out.preset = PRESETS.includes(c.preset) ? c.preset : 'none';
      } else if (out.type === 'shape') {
        out.shape = c.shape === 'ellipse' ? 'ellipse' : 'rect';
        out.fill = str(c.fill, '#ffffff') || '#ffffff';
        out.radius = clamp(num(c.radius, 0), 0, 50);
      } else if (out.type === 'image') {
        out.src = str(c.src);
        out.fit = c.fit === 'cover' ? 'cover' : 'contain';
      } else out.amount = clamp(num(c.amount, 12), 1, 60);
      if (!(dur > 0)) dur = 3;
      break;
    }
    case 'captions': {
      out.text = str(c.text);
      if (!(dur > 0)) dur = 2;
      break;
    }
  }
  out.dur = r3(Math.max(0.05, dur));
  out.end = r3(out.at + out.dur);
  return out;
}

// ---------------------------------------------------------------- what is on screen at t

export const findClip = (tl, id) => {
  for (const tr of tl.tracks) for (const c of tr.clips) if (c.id === id) return { track: tr, clip: c };
  return null;
};

function transAt(tr, p, entering) {
  if (!tr) return null;
  const e = ease('out', p);
  return { kind: tr.kind, p: e, entering };
}

/**
 * A clip's transform at local time u (seconds from its start): keyframes plus its enter and exit transitions.
 * x/y are a shift in % of the frame, scale and rotate (degrees) about the box centre, opacity 0–1,
 * reveal 0–1 for a wipe (from the left).
 */
export function clipState(clip, u) {
  const k = clip.keys || {};
  const s = {
    x: valueAt(k.x, u, 0),
    y: valueAt(k.y, u, 0),
    scale: valueAt(k.scale, u, 1),
    rotate: valueAt(k.rotate, u, 0),
    opacity: clamp(valueAt(k.opacity, u, 1), 0, 1),
    reveal: 1,
  };
  const apply = (t) => {
    if (!t) return;
    const q = t.p; // 0 → hidden, 1 → fully in
    if (t.kind === 'fade') s.opacity *= q;
    else if (t.kind === 'wipe') s.reveal = Math.min(s.reveal, q);
    else if (t.kind === 'slide') s.x += (1 - q) * (t.entering ? 100 : -100);
    else if (t.kind === 'zoom') {
      s.scale *= 0.85 + 0.15 * q;
      s.opacity *= q;
    }
  };
  if (clip.enter && u < clip.enter.dur) apply(transAt(clip.enter, u / clip.enter.dur, true));
  if (clip.exit && u > clip.dur - clip.exit.dur) apply(transAt(clip.exit, (clip.dur - u) / clip.exit.dur, false));
  return s;
}

/**
 * Where a scene clip's local time lands in its scene.json, shot by shot: { t, cut } where cut is true when the
 * shot doesn't follow its scene neighbour here (the first shot of the clip, or one after a skipped shot),
 * so the scene's own transition into it must not show the shot before.
 */
export function sceneAt(tl, clip, u) {
  const spec = tl.scenes[clip.scene];
  if (!spec) return null;
  let left = clip.in + u;
  let prev = null;
  for (const id of clip.shots) {
    const s = spec.shots.find((x) => x.id === id);
    if (!s) continue;
    if (left < s.dur || id === clip.shots[clip.shots.length - 1]) {
      const cut = !prev || prev.index !== s.index - 1;
      return { t: s.t0 + Math.min(Math.max(0, left), s.dur - 1e-3), cut };
    }
    left -= s.dur;
    prev = s;
  }
  return null;
}

/** Where a scene clip's local time lands in its scene.json (seconds), or null. */
export const sceneTime = (tl, clip, u) => sceneAt(tl, clip, u)?.t ?? null;

/** The source time a media clip shows at timeline time t. */
export const sourceTime = (clip, t) => clip.in + (t - clip.at);

/**
 * Everything active at time t: visual layers back to front, and the audio playing.
 * Solo on any visual track shows only soloed visual tracks; the same for audio.
 */
export function evalAt(tl, t) {
  const soloV = tl.tracks.some((tr) => VISUAL.has(tr.kind) && tr.solo);
  const soloA = tl.tracks.some((tr) => (tr.kind === 'audio' || tr.kind === 'video') && tr.solo);
  const layers = [];
  const audio = [];
  for (const tr of tl.tracks) {
    for (const c of tr.clips) {
      if (t < c.at || t >= c.end) continue;
      const u = t - c.at;
      if (VISUAL.has(tr.kind) && !tr.hide && (!soloV || tr.solo)) {
        const L = { track: tr, clip: c, u, state: clipState(c, u) };
        if (tr.kind === 'scene') {
          const at = sceneAt(tl, c, u);
          L.sceneT = at ? at.t : null;
          L.sceneCut = !!at?.cut;
        }
        if (tr.kind === 'video') L.srcT = sourceTime(c, t);
        layers.push(L);
      }
      if ((tr.kind === 'audio' || tr.kind === 'video') && !tr.mute && !c.mute && (!soloA || tr.solo)) audio.push({ track: tr, clip: c, srcT: sourceTime(c, t), gain: tr.gain * c.gain * fadeGain(c, u) });
    }
  }
  return { layers, audio };
}

/** A media clip's fade in/out as a gain multiplier at local time u. */
export function fadeGain(c, u) {
  let g = 1;
  if (c.fadeIn > 0 && u < c.fadeIn) g *= u / c.fadeIn;
  if (c.fadeOut > 0 && u > c.dur - c.fadeOut) g *= Math.max(0, (c.dur - u) / c.fadeOut);
  return clamp(g, 0, 1);
}

/** Every media file the timeline uses: [{ src, kind }] (video, audio, image), each once. */
export function mediaOf(tl) {
  const seen = new Map();
  for (const tr of tl.tracks)
    for (const c of tr.clips) {
      const kind = tr.kind === 'graphics' ? (c.type === 'image' ? 'image' : null) : tr.kind === 'video' || tr.kind === 'audio' ? tr.kind : null;
      if (kind && c.src && !seen.has(c.src)) seen.set(c.src, kind);
    }
  return [...seen].map(([src, kind]) => ({ src, kind }));
}

/** The words of a text clip as shown at local time u (type-on reveals letters; the rest show all). */
export function textShown(clip, u) {
  const t = clip.text || '';
  if (clip.preset !== 'type-on') return t;
  const n = Math.round(clamp(u / Math.max(0.3, Math.min(clip.dur * 0.6, t.length * 0.05)), 0, 1) * t.length);
  return t.slice(0, n);
}

// ---------------------------------------------------------------- the reel the player understands

const FULL = [0, 0, 100, 100];

function clipLabel(tr, c) {
  if (c.name) return c.name;
  if (tr.kind === 'graphics') return c.type === 'text' ? `“${(c.text || 'Text').slice(0, 24)}”` : c.type[0].toUpperCase() + c.type.slice(1);
  if (tr.kind === 'captions') return `Caption “${(c.text || '').slice(0, 20)}”`;
  if (tr.kind === 'scene') return `Scene ${c.shots.join(', ') || c.scene}`;
  return baseName(c.src) || 'Clip';
}

function clipProps(tr, c) {
  const P = (k) => `${c.path}.${k}`;
  const props = {};
  if (tr.kind === 'graphics' && c.type === 'text') {
    props.text = { type: 'longtext', label: 'Text', v: c.text, path: P('text') };
    props.color = { type: 'color', label: 'Colour', v: c.style.color, path: P('style.color') };
    props.size = { type: 'number', label: 'Size', v: c.style.size, min: 1, max: 60, step: 0.5, unit: '% of height', path: P('style.size') };
    props.font = { type: 'choice', label: 'Font', v: c.style.font, options: FONTS, path: P('style.font') };
    props.preset = { type: 'choice', label: 'Animation', v: c.preset, options: PRESETS, path: P('preset') };
  } else if (tr.kind === 'graphics' && c.type === 'shape') {
    props.fill = { type: 'color', label: 'Fill', v: c.fill, path: P('fill') };
    props.radius = { type: 'number', label: 'Corners', v: c.radius, min: 0, max: 50, path: P('radius') };
  } else if (tr.kind === 'graphics' && c.type === 'image') {
    props.src = { type: 'media', label: 'Image', v: c.src, path: P('src') };
  } else if (tr.kind === 'graphics' && c.type === 'blur') {
    props.amount = { type: 'number', label: 'Blur', v: c.amount, min: 1, max: 60, path: P('amount') };
  } else if (tr.kind === 'captions') {
    props.text = { type: 'text', label: 'Caption', v: c.text, path: P('text') };
  } else if (tr.kind === 'video') {
    props.gain = { type: 'number', label: 'Volume', v: c.gain, min: 0, max: 2, step: 0.05, path: P('gain') };
  }
  return props;
}

/** Sections for the player: the markers, else one per clip on the video and scene tracks, in time order. */
function sections(tl) {
  if (tl.markers.length) return tl.markers.map((m) => ({ id: m.id, name: m.name, t: m.t[1] > m.t[0] ? m.t : [m.t[0], tl.duration] }));
  const main = tl.tracks.filter((tr) => tr.kind === 'video' || tr.kind === 'scene').flatMap((tr) => tr.clips.map((c) => ({ tr, c })));
  if (!main.length) return [{ id: 'all', name: tl.title, t: [0, tl.duration] }];
  main.sort((a, b) => a.c.at - b.c.at);
  const out = [];
  let last = 0;
  for (const { tr, c } of main) {
    const a = Math.max(last, c.at);
    if (c.end <= a + 0.05) continue;
    if (a > last + 0.05) out.push({ id: `gap${out.length + 1}`, name: 'Gap', t: [r3(last), r3(a)] });
    out.push({ id: c.id, name: clipLabel(tr, c), t: [r3(a), c.end] });
    last = c.end;
  }
  if (tl.duration > last + 0.05) out.push({ id: 'end', name: 'End', t: [r3(last), tl.duration] });
  return out;
}

function boxAt(c, u) {
  const b = c.box || FULL;
  const s = clipState(c, u);
  const w = b[2] * s.scale;
  const h = b[3] * s.scale;
  return [r3(b[0] + s.x + (b[2] - w) / 2), r3(b[1] + s.y + (b[3] - h) / 2), r3(w), r3(h)];
}

/**
 * timeline.json → the reel: sections are scenes, clips are elements whose props point back at timeline.json
 * (`path`), scene clips bring their scene's own elements (props with `file`), lint findings are review rings.
 * opts: { scenes, src, exists(path) → bool }
 */
export function toReel(raw, { scenes = {}, src = '', exists = null } = {}) {
  const tl = normTimeline(raw, { scenes });
  const secs = sections(tl);
  const els = [];
  for (const tr of tl.tracks) {
    if (tr.kind === 'audio') continue;
    for (const c of tr.clips) {
      els.push({
        id: c.id,
        label: clipLabel(tr, c),
        t: [c.at, c.end],
        box: tr.kind === 'captions' ? [10, 80, 80, 12] : boxAt(c, Math.min(c.dur / 2, 1)),
        src: `timeline.json › ${c.path}`,
        clip: c.id,
        track: tr.id,
        props: clipProps(tr, c),
      });
      if (tr.kind === 'scene' && !c.noScene) els.push(...sceneEls(tl, c, scenes[c.scene]));
    }
  }
  const scenesOut = secs.map((s) => ({ ...s, els: els.filter((e) => e.t[0] < s.t[1] - 1e-3 && e.t[1] > s.t[0] + 1e-3) }));
  // an element shows once, in the section it starts in
  const placed = new Set();
  for (const s of scenesOut)
    s.els = s.els.filter((e) => {
      if (placed.has(e.id)) return false;
      placed.add(e.id);
      return true;
    });
  return {
    // stable across renames: a new id makes the player reload the page and drop what you have open
    id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : 'timeline',
    title: tl.title,
    version: tl.version,
    src,
    w: tl.size[0],
    h: tl.size[1],
    fps: tl.fps,
    duration: tl.duration,
    timeline: true,
    audio: { videoAudio: 'mix' },
    scenes: scenesOut,
    review: lint(tl, { exists }),
    live: { type: 'timeline', spec: 'timeline.json' },
  };
}

/** A scene clip's own elements, moved onto the timeline's clock; their props edit the scene file. */
function sceneEls(tl, clip, rawSpec) {
  if (!rawSpec) return [];
  const sr = sceneToReel(rawSpec);
  const spec = tl.scenes[clip.scene];
  const out = [];
  let off = clip.at - clip.in;
  for (const id of clip.shots) {
    const shot = spec.shots.find((s) => s.id === id);
    const sec = sr.scenes.find((s) => s.id === id);
    if (!shot || !sec) continue;
    const shift = off - shot.t0;
    for (const e of sec.els) {
      const a = Math.max(clip.at, e.t[0] + shift);
      const b = Math.min(clip.end, e.t[1] + shift);
      if (b <= a) continue;
      const props = {};
      for (const [k, p] of Object.entries(e.props)) props[k] = p.path ? { ...p, file: clip.scene } : p;
      out.push({ ...e, id: `${clip.id}/${e.id}`, t: [r3(a), r3(b)], src: `${clip.scene} › ${e.src.split('› ')[1] || ''}`, clip: clip.id, props });
    }
    off += shot.dur;
  }
  return out;
}

// ---------------------------------------------------------------- the timeline's own checks

/** Things a viewer or the export would trip on. exists(path) → bool checks media files when given. */
export function lint(tlOrRaw, { exists = null, scenes } = {}) {
  const tl = tlOrRaw && tlOrRaw.issues ? tlOrRaw : normTimeline(tlOrRaw, { scenes });
  const out = [];
  const add = (f) => out.length < 40 && out.push({ id: `check-${out.length + 1}`, kind: 'timeline check', t: 0, ...f });
  for (const i of tl.issues) add(i);
  if (!tl.tracks.some((tr) => tr.clips.length)) add({ title: 'The timeline is empty', fix: 'Add a clip, some text or a scene.' });
  for (const tr of tl.tracks) {
    let prev = null;
    for (const c of tr.clips) {
      const where = { t: c.at, elId: c.id };
      const label = clipLabel(tr, c);
      if ((tr.kind === 'video' || tr.kind === 'audio' || (tr.kind === 'graphics' && c.type === 'image')) && !c.src) add({ ...where, title: `${label} has no file`, fix: 'Set its src to a file in the project.' });
      else if (exists && c.src && (tr.kind === 'video' || tr.kind === 'audio' || c.type === 'image') && !exists(c.src)) add({ ...where, title: `${baseName(c.src)} is missing`, detail: c.src, fix: 'Put the file in the project folder or fix the path.' });
      if (c.noLength) add({ ...where, title: `${label} has no length`, fix: 'Give it an out point (seconds into the file) or a dur.' });
      if (tr.kind === 'scene') {
        if (c.noScene) add({ ...where, title: `${c.scene} can't be read`, fix: 'Check the file name, or write the scene.' });
        for (const s of c.missingShots || []) add({ ...where, title: `There is no shot "${s}" in ${c.scene}`, fix: 'Fix the shot id.' });
      }
      if (prev && c.at < prev.end - 0.02) {
        const overlap = prev.end - c.at;
        const blend = Math.max(c.enter?.dur || 0, prev.exit?.dur || 0);
        if (tr.kind === 'captions') add({ ...where, title: 'Two captions at once', detail: `${r3(overlap)} s overlap with “${(prev.text || '').slice(0, 30)}”.`, fix: 'Start it after the one before ends.' });
        else if ((tr.kind === 'video' || tr.kind === 'scene') && overlap > blend + 0.02) add({ ...where, title: `${label} covers the end of ${clipLabel(tr, prev)}`, detail: `${r3(overlap)} s overlap on ${tr.name}.`, fix: blend ? `Overlap by at most ${blend} s, the length of the transition.` : 'Move it later, or give it an enter transition to blend.' });
      }
      if ((tr.kind === 'captions' || (tr.kind === 'graphics' && c.type === 'text')) && c.text) {
        const words = c.text.trim().split(/\s+/).filter(Boolean).length;
        const wps = words / c.dur;
        if (wps > 3.2 && words > 2) add({ ...where, title: 'Too fast to read', detail: `${Math.round(wps * 10) / 10} words a second; about 3 is comfortable.`, fix: `Show it for ${Math.round((words / 2.8) * 10) / 10} s, or shorten it.` });
      }
      if (tr.kind === 'graphics' && c.type === 'text') {
        if (!c.text.trim()) add({ ...where, title: 'Empty text', fix: 'Type something or remove the clip.' });
        if (c.style.size < 2.5) add({ ...where, title: 'Text too small to read on a phone', detail: `${c.style.size}% of the frame height.`, fix: 'Make it at least 3%.' });
      }
      if (c.box && tr.kind !== 'captions') {
        const b = boxAt(c, Math.min(c.dur / 2, 1));
        const offX = Math.max(0, -b[0]) + Math.max(0, b[0] + b[2] - 100);
        const offY = Math.max(0, -b[1]) + Math.max(0, b[1] + b[3] - 100);
        if (tr.kind === 'graphics' && (offX > b[2] * 0.3 || offY > b[3] * 0.3)) add({ ...where, title: `${label} is partly off the frame`, fix: 'Move it in or make it smaller.' });
      }
      if (prev === null || c.end > prev.end) prev = c;
    }
  }
  return out;
}

// ---------------------------------------------------------------- edits at paths (Apply, Send to Claude)

/** Every timeline.json path the player may change through element props. */
export function editablePaths(raw, opts = {}) {
  const tl = normTimeline(raw, opts);
  const paths = new Set();
  for (const tr of tl.tracks) for (const c of tr.clips) for (const p of Object.values(clipProps(tr, c))) paths.add(p.path);
  return paths;
}

const segs = (p) => String(p).match(/[^.[\]]+/g) || [];
const BAD = new Set(['__proto__', 'prototype', 'constructor']);

export function setPath(raw, p, value) {
  const out = structuredClone(raw);
  const k = segs(p);
  if (!k.length || k.some((s) => BAD.has(s))) throw new Error(`Can't change ${p}`);
  let o = out;
  for (let i = 0; i < k.length - 1; i++) {
    if (o[k[i]] == null || typeof o[k[i]] !== 'object') o[k[i]] = /^\d+$/.test(k[i + 1]) ? [] : {};
    o = o[k[i]];
  }
  o[k[k.length - 1]] = value;
  return out;
}

/** Apply [{ path, value }] to a copy of raw, only at editable paths. Throws on any other path. */
export function applyPatches(raw, patches, opts = {}) {
  const ok = editablePaths(raw, opts);
  let out = raw;
  for (const p of patches || []) {
    if (!p || typeof p.path !== 'string' || !ok.has(p.path)) throw new Error(`Can't change ${p?.path ?? 'that'} here`);
    out = setPath(out, p.path, p.value);
  }
  return out;
}
