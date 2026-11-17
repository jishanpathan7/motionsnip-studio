// The reel: normalising reel.json, and the outputs (cutdowns, language versions) made from it.
// Shared by the player (browser) and the server (node imports this file too), so: no DOM, no imports.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

export const DEFAULT_AUDIO = {
  music: null,
  videoAudio: 'effects',
  bpm: null,
  drop: null,
  musicVol: 1,
  sfxVol: 1,
  musicOffset: 0,
  musicFade: 0,
  note: '',
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pair = (v, d) =>
  Array.isArray(v) && v.length >= 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1]) ? [+v[0], +v[1]] : d;

export function normBox(b) {
  if (!Array.isArray(b) || b.length < 4) return null;
  const out = b.slice(0, 4).map(Number);
  return out.every(Number.isFinite) ? out : null;
}

function normProp(key, p) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) p = { v: p };
  const type = typeof p.type === 'string' ? p.type : typeof p.v === 'number' ? 'number' : 'text';
  const out = { ...p, type, label: p.label || key };
  if (type === 'list') {
    out.cols = Array.isArray(p.cols) && p.cols.length ? p.cols.filter((c) => c && c.k) : [{ k: 'text', type: 'text' }];
    out.v = Array.isArray(p.v) ? p.v.map((r) => (r && typeof r === 'object' ? r : { [out.cols[0].k]: r })) : [];
  } else if (type === 'choice') {
    out.options = Array.isArray(p.options) ? p.options.map((o) => (o && typeof o === 'object' ? o : { v: o, label: String(o) })) : [];
  }
  if (out.v === undefined) out.v = type === 'number' ? 0 : '';
  return out;
}

export function normalizeReel(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const duration = num(r.duration, 0);
  const reel = {
    ...r,
    id: String(r.id || r.title || 'reel'),
    title: String(r.title || r.id || 'Untitled'),
    version: num(r.version, 1),
    path: String(r.path || ''),
    src: r.src || '',
    w: num(r.w, 1920),
    h: num(r.h, 1080),
    fps: num(r.fps, 30) || 30,
    duration,
    reference: r.reference || '',
    // a script that defines window.MotionSnipLive, or { type: 'scene' | 'timeline', spec } drawn by MotionSnip itself
    live: typeof r.live === 'string' && r.live ? r.live : r.live && (r.live.type === 'scene' || r.live.type === 'timeline') ? { type: r.live.type, spec: String(r.live.spec || `${r.live.type}.json`) } : null,
    export: r.export && typeof r.export === 'object' ? r.export : null,
  };
  const brand = r.brand && typeof r.brand === 'object' ? r.brand : {};
  reel.brand = {
    colors: Array.isArray(brand.colors) ? brand.colors.filter((c) => c && c.id).map((c) => ({ name: c.id, v: '#000000', ...c })) : [],
    fonts: Array.isArray(brand.fonts) ? brand.fonts.filter((f) => f && f.id).map((f) => ({ name: f.id, v: '', ...f })) : [],
    logo: brand.logo || null,
  };
  const a = r.audio && typeof r.audio === 'object' ? r.audio : {};
  reel.audio = {
    ...DEFAULT_AUDIO,
    ...a,
    music: a.music || null,
    videoAudio: a.videoAudio === 'mix' ? 'mix' : 'effects',
    bpm: num(a.bpm, null),
    drop: num(a.drop, null),
    musicVol: clamp(num(a.musicVol, 1), 0, 1),
    sfxVol: clamp(num(a.sfxVol, 1), 0, 1),
    musicOffset: num(a.musicOffset, 0),
    musicFade: Math.max(0, num(a.musicFade, 0)),
    note: a.note ? String(a.note) : '',
  };
  reel.assets = Array.isArray(r.assets)
    ? r.assets.filter((x) => x && x.id).map((x) => ({ name: baseName(x.id), type: guessType(x.id), from: '', ...x }))
    : [];
  if (reel.audio.music && !reel.assets.some((x) => x.id === reel.audio.music)) {
    reel.assets.push({ id: reel.audio.music, name: baseName(reel.audio.music), type: 'audio', from: 'reel.json' });
  }
  const scenes = Array.isArray(r.scenes) ? r.scenes : [];
  let lastEnd = 0;
  reel.scenes = scenes
    .filter((s) => s && typeof s === 'object')
    .map((s, i) => {
      const t = pair(s.t, [lastEnd, lastEnd]);
      lastEnd = t[1];
      return {
        ...s,
        id: String(s.id || 'S' + (i + 1)),
        name: String(s.name || s.id || 'Scene ' + (i + 1)),
        t,
        els: (Array.isArray(s.els) ? s.els : [])
          .filter((e) => e && e.id)
          .map((e) => {
            const props = {};
            if (e.props && typeof e.props === 'object') for (const [k, p] of Object.entries(e.props)) props[k] = normProp(k, p);
            return { ...e, id: String(e.id), label: String(e.label || e.id), t: pair(e.t, t), box: normBox(e.box), src: e.src || '', props };
          }),
      };
    });
  if (!reel.duration) reel.duration = reel.scenes.length ? reel.scenes[reel.scenes.length - 1].t[1] : 0;
  reel.review = normReview(r.review);
  reel.outputs = normOutputs(r.outputs, reel);
  return reel;
}

/**
 * Claude's self-review: problems it spotted in its own render and left for the reviewer to decide.
 * Each finding: { id, t, title, detail?, fix?, kind?, box?: [x, y, w, h] in % | x?, y? in % | elId? }.
 */
export function normReview(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((f) => f && typeof f === 'object' && (f.title || f.text))
    .map((f, i) => {
      let id = String(f.id || 'r' + (i + 1));
      while (seen.has(id)) id += '_';
      seen.add(id);
      const box = normBox(f.box);
      const x = box ? box[0] + box[2] / 2 : num(f.x, null);
      const y = box ? box[1] + box[3] / 2 : num(f.y, null);
      return {
        id,
        t: Math.max(0, num(f.t, 0)),
        title: String(f.title || f.text),
        detail: f.detail ? String(f.detail) : '',
        fix: f.fix ? String(f.fix) : '',
        kind: f.kind ? String(f.kind) : '',
        box,
        x: x == null ? null : clamp(x, 0, 100),
        y: y == null ? null : clamp(y, 0, 100),
        elId: f.elId ? String(f.elId) : null,
      };
    });
}

export function guessType(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  return 'image';
}


// ---------------------------------------------------------------- outputs (cutdowns, language versions)
//
// An output is another video made from the master: a reframe (9:16, 1:1…), a bumper (a few seconds cut from
// it), a language version, or a separate render Claude made. Claude lists its own in reel.json `outputs`;
// the ones the player made live in .motionsnip/outputs.json and the server merges them in (by: 'player').

/** Ready-made cutdowns. Sizes in pixels; a bumper keeps the master's size. */
export const PRESETS = {
  vertical: { label: '9:16', kind: 'reframe', w: 1080, h: 1920, platform: 'reels', hint: 'Reels, TikTok, Shorts' },
  square: { label: '1:1', kind: 'reframe', w: 1080, h: 1080, platform: 'feed', hint: 'Feed posts' },
  landscape: { label: '16:9', kind: 'reframe', w: 1920, h: 1080, platform: 'youtube', hint: 'YouTube, web' },
  bumper6: { label: '6 s', kind: 'bumper', duration: 6, hint: 'A 6-second bumper' },
};

const KINDS = ['reframe', 'bumper', 'render', 'lang'];
const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => Math.round(v * 10) / 10;

export function outputSlug(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'out'
  );
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

export function ratioLabel(w, h) {
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  const a = Math.round(w) / g;
  const b = Math.round(h) / g;
  return a <= 32 && b <= 32 ? `${a}:${b}` : `${Math.round(w)}×${Math.round(h)}`;
}

/** Crop centre keys: [{ t, cx, cy }], cx/cy in % of the master frame, sorted by time. */
export function normKeys(list) {
  if (!Array.isArray(list)) return [];
  const byT = new Map();
  for (const k of list.slice(0, 400)) {
    if (!k || typeof k !== 'object') continue;
    const t = num(+k.t, null);
    if (t == null || t < 0) continue;
    byT.set(r3(t), { t: r3(t), cx: r1(clamp(num(+k.cx, 50), 0, 100)), cy: r1(clamp(num(+k.cy, 50), 0, 100)) });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Bumper ranges in master time: sorted, inside [0, D], none shorter than 0.05 s. */
export function normRanges(list, D) {
  if (!Array.isArray(list)) return [];
  const hi = D > 0 ? D : Infinity;
  return list
    .slice(0, 40)
    .map((r) => [clamp(num(+r?.[0], 0), 0, hi), clamp(num(+r?.[1], 0), 0, hi)])
    .map(([a, b]) => [r3(Math.min(a, b)), r3(Math.max(a, b))])
    .filter(([a, b]) => b - a >= 0.05)
    .sort((a, b) => a[0] - b[0]);
}

const rangesLength = (ranges) => r3(ranges.reduce((s, [a, b]) => s + b - a, 0));

export function normOutputs(list, master) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(['master']);
  const out = [];
  list.forEach((o, i) => {
    if (!o || typeof o !== 'object') return;
    let id = outputSlug(o.id || o.preset || 'out' + (i + 1));
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const kind = KINDS.includes(o.kind) ? o.kind : o.lang ? 'lang' : Array.isArray(o.ranges) ? 'bumper' : o.render ? 'render' : 'reframe';
    const ranges = kind === 'bumper' ? normRanges(o.ranges, master.duration) : null;
    const w = num(o.w, master.w);
    const h = num(o.h, master.h);
    const duration = num(o.duration, ranges?.length ? rangesLength(ranges) : master.duration);
    const label =
      o.label ? String(o.label) : kind === 'bumper' ? `${Math.round(duration * 10) / 10} s` : kind === 'lang' && o.lang ? String(o.lang).toUpperCase() : ratioLabel(w, h);
    out.push({
      ...o,
      id,
      kind,
      label,
      src: typeof o.src === 'string' ? o.src : '',
      w,
      h,
      duration,
      version: num(o.version, 1),
      by: o.by === 'player' ? 'player' : 'reel',
      platform: o.platform ? String(o.platform) : null,
      lang: o.lang ? String(o.lang) : null,
      mode: o.mode === 'blurpad' ? 'blurpad' : 'crop',
      zoom: clamp(num(+o.zoom, 1), 1, 4),
      keys: normKeys(o.keys),
      ranges,
      audio: o.audio && typeof o.audio === 'object' && !Array.isArray(o.audio) ? o.audio : null,
      review: normReview(o.review),
      scenes: Array.isArray(o.scenes) ? o.scenes : null,
    });
  });
  return out;
}

/** The scenes of a bumper, on its own clock: the pieces of each master scene the ranges keep. */
function bumperScenes(scenes, ranges) {
  const out = [];
  let off = 0;
  for (const [a, b] of ranges) {
    for (const s of scenes) {
      const p = Math.max(a, s.t[0]);
      const q = Math.min(b, s.t[1]);
      if (q - p > 0.01) out.push({ ...s, t: [r3(off + p - a), r3(off + q - a)] });
    }
    off += b - a;
  }
  return out;
}

/**
 * The reel as seen on one output: its video, size, length and clock, the master's elements and audio.
 * A derived view (every output, for now) takes notes but not element edits: those belong on the master.
 */
export function resolveOutput(master, id) {
  const o = id && id !== 'master' ? master.outputs.find((x) => x.id === id) : null;
  if (!o) return { ...master, outputId: null, output: null, derived: false };
  const view = { ...master, outputId: o.id, output: o, src: o.src, w: o.w, h: o.h, duration: o.duration, version: o.version, review: o.review, live: null, derived: true };
  view.audio = o.audio ? { ...master.audio, ...o.audio } : master.audio;
  if (o.scenes) view.scenes = normalizeReel({ scenes: o.scenes, duration: o.duration }).scenes;
  else if (o.kind === 'bumper' && o.ranges.length) view.scenes = bumperScenes(master.scenes, o.ranges);
  return view;
}

/** Master time → the output's clock (a bumper skips; anything else keeps time). Outside the bumper: its next range. */
export function outTime(o, t) {
  if (!o || o.kind !== 'bumper' || !o.ranges?.length) return t;
  let off = 0;
  for (const [a, b] of o.ranges) {
    if (t < a) return off;
    if (t <= b) return off + t - a;
    off += b - a;
  }
  return off;
}

/** The output's clock → master time. */
export function masterTime(o, t) {
  if (!o || o.kind !== 'bumper' || !o.ranges?.length) return t;
  let off = 0;
  for (const [a, b] of o.ranges) {
    if (t <= off + (b - a)) return a + Math.max(0, t - off);
    off += b - a;
  }
  return o.ranges[o.ranges.length - 1][1];
}

// ---------------------------------------------------------------- reframing

/** Size of the crop window in master pixels (even numbers), for an output of outW×outH at a zoom. */
export function cropSize(W, H, outW, outH, zoom = 1) {
  const ar = outW / outH;
  let cw;
  let ch;
  if (W / H > ar) {
    ch = H / zoom;
    cw = ch * ar;
  } else {
    cw = W / zoom;
    ch = cw / ar;
  }
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  return { cw: even(Math.min(cw, W)), ch: even(Math.min(ch, H)) };
}

/** Crop centre at time t, in % of the master: straight lines between keys, held before the first and after the last. */
export function centreAt(keys, t) {
  if (!keys?.length) return { cx: 50, cy: 50 };
  if (t <= keys[0].t) return { cx: keys[0].cx, cy: keys[0].cy };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
    }
  }
  const z = keys[keys.length - 1];
  return { cx: z.cx, cy: z.cy };
}

/** The crop window at time t as [x, y, w, h] in % of the master, kept inside the frame. */
export function cropRectPct(master, o, t) {
  const { cw, ch } = cropSize(master.w, master.h, o.w, o.h, o.zoom);
  const w = (cw / master.w) * 100;
  const h = (ch / master.h) * 100;
  const { cx, cy } = centreAt(o.keys, t);
  return [clamp(cx - w / 2, 0, 100 - w), clamp(cy - h / 2, 0, 100 - h), w, h];
}

function unionBox(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * A first guess at the crop for a reframe: per scene, centre the elements it shows, hold it through the
 * scene, and jump at the cut (a cut is a new shot, so the frame moves with it).
 * Returns { keys, mode }: 'crop' when most scenes fit the window, else 'blurpad' (the whole frame on a blurred fill).
 */
export function autoReframe(master, outW, outH, zoom = 1) {
  const { cw, ch } = cropSize(master.w, master.h, outW, outH, zoom);
  const wp = (cw / master.w) * 100;
  const hp = (ch / master.h) * 100;
  const keys = [];
  let fit = 0;
  const scenes = master.scenes.length ? master.scenes : [{ t: [0, master.duration || 0], els: [] }];
  const frame = 1 / (master.fps || 30);
  for (const s of scenes) {
    const u = unionBox(s.els.map((e) => e.box).filter(Boolean));
    const cx = u ? u[0] + u[2] / 2 : 50;
    const cy = u ? u[1] + u[3] / 2 : 50;
    if (!u || (u[2] <= wp + 0.5 && u[3] <= hp + 0.5)) fit++;
    keys.push({ t: s.t[0], cx, cy });
    if (s.t[1] - frame > s.t[0]) keys.push({ t: s.t[1] - frame, cx, cy });
  }
  return { keys: normKeys(keys), mode: fit >= scenes.length / 2 ? 'crop' : 'blurpad' };
}

/**
 * A first guess at a bumper of `dur` seconds: the opening of the first scene, then the end of the last
 * (usually the hook and the logo). A short or one-scene video keeps its first `dur` seconds.
 */
export function autoRanges(master, dur = 6) {
  const D = master.duration || 0;
  const sc = master.scenes;
  if (D <= dur + 0.05 || sc.length < 2) return [[0, r3(Math.min(D, dur))]];
  const first = sc[0];
  const last = sc[sc.length - 1];
  let a = Math.min(first.t[1] - first.t[0], dur * 0.55);
  let b = Math.min(last.t[1] - last.t[0], dur - a);
  a = dur - b > first.t[1] - first.t[0] ? first.t[1] - first.t[0] : dur - b;
  return normRanges([[first.t[0], first.t[0] + a], [last.t[1] - b, last.t[1]]], D);
}
