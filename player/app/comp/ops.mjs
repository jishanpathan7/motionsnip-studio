// Edit operations on timeline.json. Each is a pure function from the file as written to a new copy, so the editor
// can preview an edit at once, the server can apply the same ops to the file on disk, and undo is a copy away.
// Fields Claude wrote that the editor doesn't know are kept.
import { normTimeline, ensureIds, findClip, normKeyList, valueAt, KINDS, GFX, PRESETS, TRANSITIONS, EASES, KEYS, TRACK_PREFIX } from './timeline.mjs';

const MIN = 0.05; // shortest clip, seconds
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const fail = (msg) => {
  throw new Error(msg);
};

export { ensureIds };

/** The smallest unused id with this prefix. */
export function newId(raw, prefix = 'c') {
  const ids = new Set();
  for (const t of raw.tracks || []) {
    if (t?.id) ids.add(t.id);
    for (const c of t?.clips || []) if (c?.id) ids.add(c.id);
  }
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function locate(raw, id) {
  for (let ti = 0; ti < raw.tracks.length; ti++) {
    const t = raw.tracks[ti];
    const ci = (t?.clips || []).findIndex((c) => c?.id === id);
    if (ci >= 0) return { ti, ci, track: t, clip: t.clips[ci] };
  }
  fail(`There is no clip "${id}"`);
}

function trackOf(raw, id) {
  const ti = raw.tracks.findIndex((t) => t?.id === id);
  if (ti < 0) fail(`There is no track "${id}"`);
  return { ti, track: raw.tracks[ti] };
}

const unlocked = (track) => {
  if (track.lock) fail(`${track.name || track.id} is locked`);
};

/** Shift a clip's keyframes by d seconds (keyframes stay put on the timeline when its start moves). */
function shiftKeys(c, d) {
  if (!obj(c.keys) || !d) return;
  for (const [p, list] of Object.entries(c.keys)) {
    if (!Array.isArray(list)) continue;
    const moved = normKeyList(list).map((k) => [r3(k[0] + d), ...k.slice(1)]);
    // keys cut off by a later start leave the value they had there as the first key
    const before = moved.filter((k) => k[0] < 0);
    const after = moved.filter((k) => k[0] >= 0);
    if (before.length && (!after.length || after[0][0] > 0)) {
      const e = before[before.length - 1][2];
      after.unshift(e ? [0, r3(valueAt(moved, 0)), e] : [0, r3(valueAt(moved, 0))]);
    }
    c.keys[p] = after;
  }
}

const isMedia = (kind) => kind === 'video' || kind === 'audio';
const hasIn = (kind) => isMedia(kind) || kind === 'scene';

/** Write a new length into a raw clip, the way its kind stores it. */
function setLength(kind, c, dur) {
  dur = r3(Math.max(MIN, dur));
  if (isMedia(kind)) {
    c.out = r3(num(c.in, 0) + dur);
    delete c.dur;
  } else c.dur = dur;
}

const SETTABLE = {
  common: ['name', 'enter', 'exit', 'keys'],
  video: ['src', 'gain', 'mute', 'fadeIn', 'fadeOut', 'box', 'fit', 'look'],
  audio: ['src', 'gain', 'mute', 'fadeIn', 'fadeOut'],
  scene: ['scene', 'shots'],
  graphics: ['type', 'text', 'style', 'preset', 'box', 'shape', 'fill', 'radius', 'src', 'fit', 'amount'],
  captions: ['text'],
};

function checkValue(key, v) {
  if (v === null || v === undefined) return;
  const bad = () => fail(`That isn't a valid ${key}`);
  switch (key) {
    case 'box':
      if (!Array.isArray(v) || v.length !== 4 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) bad();
      break;
    case 'style':
    case 'look':
    case 'keys':
      if (!obj(v)) bad();
      break;
    case 'enter':
    case 'exit':
      if (!obj(v) || !TRANSITIONS.includes(v.kind)) bad();
      break;
    case 'shots':
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) bad();
      break;
    case 'type':
      if (!GFX.includes(v)) bad();
      break;
    case 'preset':
      if (!PRESETS.includes(v)) bad();
      break;
    case 'gain':
    case 'fadeIn':
    case 'fadeOut':
    case 'radius':
    case 'amount':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad();
      break;
    case 'mute':
      if (typeof v !== 'boolean') bad();
      break;
    default:
      if (typeof v !== 'string') bad();
  }
}

const TRACK_KEYS = { name: 'string', mute: 'boolean', solo: 'boolean', lock: 'boolean', hide: 'boolean', gain: 'number', role: 'string' };

/**
 * Apply ops to a copy of raw. Throws Error(message) on an op that can't apply, leaving raw untouched.
 * opts.scenes: scene specs for scene clip lengths; opts.srcDur(src) → seconds, to stop trims past a file's end.
 */
export function applyOps(raw, ops, opts = {}) {
  let out = ensureIds(raw);
  for (const op of Array.isArray(ops) ? ops : [ops]) out = applyOp(out, op, opts);
  return out;
}

function applyOp(raw, op, opts) {
  if (!obj(op)) fail('Bad edit');
  const out = structuredClone(raw);
  const tl = normTimeline(out, opts);
  const norm = (id) => findClip(tl, id) || fail(`There is no clip "${id}"`);
  switch (op.op) {
    case 'add': {
      const { track } = trackOf(out, op.track);
      unlocked(track);
      const c = structuredClone(obj(op.clip) || {});
      c.id = typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) && !findClip(tl, c.id) ? c.id : newId(out);
      c.at = r3(Math.max(0, num(op.at, num(c.at, 0))));
      track.clips.push(c);
      track.clips.sort((a, b) => num(a.at, 0) - num(b.at, 0));
      return out;
    }
    case 'remove': {
      const { track, ci, clip } = locate(out, op.clip);
      unlocked(track);
      const n = norm(op.clip).clip;
      track.clips.splice(ci, 1);
      if (op.ripple) for (const c of track.clips) if (num(c.at, 0) >= n.at) c.at = r3(Math.max(0, num(c.at, 0) - n.dur));
      return out;
    }
    case 'move': {
      const { track, ci, clip } = locate(out, op.clip);
      unlocked(track);
      clip.at = r3(Math.max(0, num(op.at, num(clip.at, 0))));
      if (op.track && op.track !== track.id) {
        const to = trackOf(out, op.track).track;
        unlocked(to);
        if (to.kind !== track.kind) fail(`A ${track.kind} clip can't go on a ${to.kind} track`);
        track.clips.splice(ci, 1);
        to.clips.push(clip);
        to.clips.sort((a, b) => num(a.at, 0) - num(b.at, 0));
      } else track.clips.sort((a, b) => num(a.at, 0) - num(b.at, 0));
      return out;
    }
    case 'trim': {
      const { track, clip } = locate(out, op.clip);
      unlocked(track);
      const n = norm(op.clip).clip;
      const t = num(op.t, NaN);
      if (!Number.isFinite(t)) fail('Trim needs a time');
      if (op.edge === 'start') {
        let at = Math.min(t, n.end - MIN);
        if (hasIn(track.kind)) at = Math.max(at, n.at - n.in); // can't start before the source does
        at = Math.max(0, at);
        const d = r3(at - n.at);
        clip.at = r3(at);
        if (hasIn(track.kind)) clip.in = r3(n.in + d);
        if (isMedia(track.kind)) clip.out = r3(n.out);
        else clip.dur = r3(n.dur - d);
        if (isMedia(track.kind)) delete clip.dur;
        shiftKeys(clip, -d);
      } else if (op.edge === 'end') {
        let end = Math.max(t, n.at + MIN);
        const max = isMedia(track.kind) && opts.srcDur ? opts.srcDur(n.src) : null;
        if (max > 0) end = Math.min(end, n.at + (max - n.in));
        setLength(track.kind, clip, end - n.at);
      } else fail('Trim the start or the end');
      return out;
    }
    case 'split': {
      const { track, ci, clip } = locate(out, op.clip);
      unlocked(track);
      const n = norm(op.clip).clip;
      const t = num(op.t, NaN);
      if (!(t > n.at + MIN && t < n.end - MIN)) fail('Split inside the clip');
      const d = r3(t - n.at);
      const right = structuredClone(clip);
      right.id = typeof op.id === 'string' && /^[\w-]{1,40}$/.test(op.id) && !findClip(tl, op.id) ? op.id : newId(out);
      right.at = r3(t);
      if (hasIn(track.kind)) right.in = r3(n.in + d);
      setLength(track.kind, right, n.dur - d);
      delete right.enter;
      shiftKeys(right, -d);
      setLength(track.kind, clip, d);
      if (hasIn(track.kind) && clip.in === undefined) clip.in = 0;
      if (isMedia(track.kind)) {
        clip.out = r3(n.in + d);
        right.out = r3(n.out);
        delete right.fadeIn;
        delete clip.fadeOut;
      }
      delete clip.exit;
      track.clips.splice(ci + 1, 0, right);
      return out;
    }
    case 'slip': {
      const { track, clip } = locate(out, op.clip);
      unlocked(track);
      if (!hasIn(track.kind)) fail('Only video, audio and scene clips slip');
      const n = norm(op.clip).clip;
      let inn = Math.max(0, n.in + num(op.by, 0));
      const max = isMedia(track.kind) && opts.srcDur ? opts.srcDur(n.src) : null;
      if (max > 0) inn = Math.min(inn, Math.max(0, max - n.dur));
      clip.in = r3(inn);
      if (isMedia(track.kind)) {
        clip.out = r3(inn + n.dur);
        delete clip.dur;
      }
      return out;
    }
    case 'set': {
      const { track, clip } = locate(out, op.clip);
      unlocked(track);
      const ok = [...SETTABLE.common, ...(SETTABLE[track.kind] || [])];
      const vals = obj(op.values) || { [op.key]: op.value };
      for (const [k, v] of Object.entries(vals)) {
        if (!ok.includes(k)) fail(`Can't set ${k} on a ${track.kind} clip`);
        checkValue(k, v);
        if (v === null || v === undefined) delete clip[k];
        else clip[k] = structuredClone(v);
      }
      if ('dur' in op) setLength(track.kind, clip, num(op.dur, 1));
      return out;
    }
    case 'key':
    case 'unkey': {
      const { track, clip } = locate(out, op.clip);
      unlocked(track);
      if (!(op.prop in KEYS)) fail(`Can't keyframe ${op.prop}`);
      const t = r3(Math.max(0, num(op.t, NaN)));
      if (!Number.isFinite(t)) fail('A keyframe needs a time');
      const keys = (clip.keys = obj(clip.keys) || {});
      let list = (Array.isArray(keys[op.prop]) ? keys[op.prop] : typeof keys[op.prop] === 'number' ? [[0, keys[op.prop]]] : []).filter((k) => Array.isArray(k) && Math.abs(num(k[0], -1) - t) > 1 / 240);
      if (op.op === 'key') {
        const v = num(op.value, NaN);
        if (!Number.isFinite(v)) fail('A keyframe needs a value');
        list.push(EASES.includes(op.ease) && op.ease !== 'linear' ? [t, v, op.ease] : [t, v]);
        list.sort((a, b) => a[0] - b[0]);
      }
      if (list.length) keys[op.prop] = list;
      else delete keys[op.prop];
      if (!Object.keys(keys).length) delete clip.keys;
      return out;
    }
    case 'addTrack': {
      if (!KINDS.includes(op.kind)) fail(`Unknown track kind ${op.kind}`);
      const t = { id: typeof op.id === 'string' && /^[\w-]{1,40}$/.test(op.id) && !out.tracks.some((x) => x?.id === op.id) ? op.id : newId(out, TRACK_PREFIX[op.kind]), kind: op.kind, clips: [] };
      if (typeof op.name === 'string' && op.name.trim()) t.name = op.name.trim();
      if (op.kind === 'audio' && typeof op.role === 'string') t.role = op.role;
      const i = Number.isInteger(op.index) ? Math.max(0, Math.min(out.tracks.length, op.index)) : out.tracks.length;
      out.tracks.splice(i, 0, t);
      return out;
    }
    case 'removeTrack': {
      const { ti, track } = trackOf(out, op.track);
      unlocked(track);
      out.tracks.splice(ti, 1);
      return out;
    }
    case 'moveTrack': {
      const { ti, track } = trackOf(out, op.track);
      out.tracks.splice(ti, 1);
      out.tracks.splice(Math.max(0, Math.min(out.tracks.length, Math.round(num(op.to, ti)))), 0, track);
      return out;
    }
    case 'setTrack': {
      const { track } = trackOf(out, op.track);
      const type = TRACK_KEYS[op.key];
      if (!type) fail(`Can't set ${op.key} on a track`);
      if (op.key !== 'lock') unlocked(track);
      if (typeof op.value !== type) fail(`That isn't a valid ${op.key}`);
      if (op.value === false || op.value === '') delete track[op.key];
      else track[op.key] = op.value;
      return out;
    }
    case 'marker': {
      // add or change { id?, name, t }; remove with { id, remove: true }
      if (!Array.isArray(out.markers)) out.markers = [];
      const i = out.markers.findIndex((m) => m?.id === op.id);
      if (op.remove) {
        if (i < 0) fail(`There is no marker "${op.id}"`);
        out.markers.splice(i, 1);
      } else {
        const t = Array.isArray(op.t) ? op.t.map((x) => r3(Math.max(0, num(x, 0)))) : r3(Math.max(0, num(op.t, 0)));
        const m = { id: typeof op.id === 'string' && op.id ? op.id : `m${out.markers.length + 1}`, name: String(op.name || 'Marker'), t };
        if (i >= 0) out.markers[i] = { ...out.markers[i], ...m };
        else out.markers.push(m);
        out.markers.sort((a, b) => num([].concat(a.t)[0], 0) - num([].concat(b.t)[0], 0));
      }
      return out;
    }
    case 'meta': {
      const v = op.value;
      if (op.key === 'title' && typeof v === 'string') out.title = v;
      else if (op.key === 'size' && Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 16 && x <= 8192)) out.size = v;
      else if (op.key === 'fps' && Number.isInteger(v) && v >= 1 && v <= 60) out.fps = v;
      else if (op.key === 'bg' && typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v)) out.bg = v;
      else fail(`Can't set ${op.key} to that`);
      return out;
    }
    default:
      fail(`Unknown edit "${op.op}"`);
  }
}
