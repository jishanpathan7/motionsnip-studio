// The reel, the reviewer's changes and notes, and their persistence.
//
// Everything the reviewer does is a "change" record with a stable `key`, so editing the same prop twice
// keeps one record, and undo removes exactly one thing. Records are saved to browser storage and to
// `.motionsnip/state.json` (POST /api/state, debounced). On load the newer copy wins.

import { Emitter, api, clamp, debounce, newId, sameValue, sameBox, baseName } from './util.js';

export const bus = new Emitter();

const DEFAULT_AUDIO = {
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

export const AUDIO_FIELDS = ['music', 'musicOffset', 'musicFade', 'musicVol', 'sfxVol'];

function emptyData() {
  return {
    v: 1,
    reelId: null,
    savedAt: 0,
    changes: [],
    status: {},
    uploads: [],
    pending: null,
    check: null,
    notQuite: [],
    seenVersion: null,
  };
}

export const store = {
  reel: null,
  /** id -> { el, scene } */
  els: new Map(),
  data: emptyData(),
  ui: {
    t: 0,
    playing: false,
    selected: null, // element id
    tab: 'edit',
    editingText: false,
    noteOpen: null, // note id with the comment box open
    compare: false,
    waiting: false,
  },
};

// ---------------------------------------------------------------- reel normalisation

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pair = (v, d) =>
  Array.isArray(v) && v.length >= 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1]) ? [+v[0], +v[1]] : d;

function normBox(b) {
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
    live: typeof r.live === 'string' && r.live ? r.live : null,
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
  return reel;
}

function guessType(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  return 'image';
}

function indexEls() {
  store.els = new Map();
  for (const scene of store.reel.scenes) for (const el of scene.els) store.els.set(el.id, { el, scene });
}

// ---------------------------------------------------------------- lookups

export const changes = () => store.data.changes;
export const getEl = (id) => store.els.get(id)?.el || null;
export const sceneOfEl = (id) => store.els.get(id)?.scene || null;

export function sceneAt(t) {
  const sc = store.reel?.scenes || [];
  for (let i = sc.length - 1; i >= 0; i--) if (t >= sc[i].t[0] - 1e-6) return sc[i];
  return sc[0] || null;
}

export function visibleEls(t) {
  const out = [];
  for (const { el } of store.els.values()) if (t >= el.t[0] - 1e-6 && t < el.t[1] + 1e-6) out.push(el);
  return out;
}

export function findChange(key) {
  return store.data.changes.find((c) => c.key === key) || null;
}

export function propValue(elId, key) {
  const c = findChange(`prop:${elId}:${key}`);
  if (c) return c.after;
  return getEl(elId)?.props[key]?.v;
}

export function boxValue(elId) {
  const c = findChange(`box:${elId}`);
  return c ? c.after : getEl(elId)?.box || null;
}

export function audioValue(field) {
  const c = findChange(`audio:${field}`);
  return c ? c.after : store.reel?.audio[field];
}

export function effectiveAudio() {
  const a = { ...store.reel.audio };
  for (const f of AUDIO_FIELDS) a[f] = audioValue(f);
  return a;
}

export function colorValue(id) {
  const c = findChange(`brand:${id}`);
  return c ? c.after : store.reel.brand.colors.find((x) => x.id === id)?.v;
}

export function fontValue(id) {
  const c = findChange(`font:${id}`);
  return c ? c.after : store.reel.brand.fonts.find((x) => x.id === id)?.v;
}

/** Resolve "brand.accent" to a hex for display. */
export function resolveColor(v) {
  if (typeof v === 'string' && v.startsWith('brand.')) return colorValue(v.slice(6)) || '#000000';
  return v;
}

export function allAssets() {
  const list = [...(store.reel?.assets || [])];
  for (const u of store.data.uploads) if (!list.some((a) => a.id === u.id)) list.push(u);
  return list;
}

export function assetName(id) {
  if (!id) return 'No music';
  return allAssets().find((a) => a.id === id)?.name || baseName(id);
}

/** Main text prop of an element (first text/longtext prop). */
export function mainTextKey(el) {
  if (!el) return null;
  for (const [k, p] of Object.entries(el.props)) if (p.type === 'text' || p.type === 'longtext') return k;
  return null;
}

export function notes() {
  return store.data.changes.filter((c) => c.kind === 'note');
}

export function noteNumber(id) {
  return notes().findIndex((n) => n.id === id) + 1;
}

export function elHasEdits(elId) {
  return store.data.changes.some((c) => c.elId === elId && (c.kind === 'prop' || c.kind === 'box'));
}

export function sceneChanges(sceneId) {
  return store.data.changes.filter((c) => {
    if (c.kind === 'note') return c.sceneId === sceneId;
    if (c.elId) return sceneOfEl(c.elId)?.id === sceneId;
    return false;
  });
}

/** 'approved' | 'changes' | 'review' */
export function sceneStatus(sceneId) {
  const s = store.data.status[sceneId];
  if (s === 'approved' || s === 'changes') return s;
  return sceneChanges(sceneId).length ? 'changes' : 'review';
}

export function approvedCount() {
  return store.reel.scenes.filter((s) => sceneStatus(s.id) === 'approved').length;
}

export function unsentChanges() {
  return store.data.changes.filter((c) => !c.sent);
}

// ---------------------------------------------------------------- mutations

function upsert(rec) {
  const list = store.data.changes;
  const i = list.findIndex((c) => c.key === rec.key);
  if (i >= 0) {
    const prev = list[i];
    list[i] = { ...prev, ...rec, before: prev.before, createdAt: prev.createdAt, updatedAt: Date.now(), sent: null };
  } else list.push({ ...rec, id: rec.id || newId(), createdAt: Date.now(), updatedAt: Date.now(), sent: null });
}

function remove(key) {
  const list = store.data.changes;
  const i = list.findIndex((c) => c.key === key);
  if (i >= 0) list.splice(i, 1);
  return i >= 0;
}

function changed(detail) {
  persist();
  bus.emit('changes', detail || {});
}

export function setProp(elId, key, value, at) {
  const el = getEl(elId);
  if (!el || !el.props[key]) return;
  const before = el.props[key].v;
  const ck = `prop:${elId}:${key}`;
  if (sameValue(before, value)) remove(ck);
  else upsert({ kind: 'prop', key: ck, elId, propKey: key, before, after: value, at: atFor(el, at) });
  changed({ key: ck, elId });
}

function atFor(el, at) {
  const t = Number.isFinite(at) ? at : store.ui.t;
  return t >= el.t[0] && t <= el.t[1] ? t : el.t[0];
}

export function setBox(elId, box) {
  const el = getEl(elId);
  if (!el || !el.box) return;
  const ck = `box:${elId}`;
  const nb = box.map((v) => Math.round(v * 10) / 10);
  if (sameBox(el.box, nb, 0.05)) remove(ck);
  else {
    const scale = Math.round(Math.sqrt((nb[2] * nb[3]) / Math.max(1e-6, el.box[2] * el.box[3])) * 100) / 100;
    upsert({ kind: 'box', key: ck, elId, before: el.box.slice(), after: nb, scale, at: atFor(el) });
  }
  changed({ key: ck, elId, box: true });
}

export function setAudio(field, value) {
  const before = store.reel.audio[field];
  const ck = `audio:${field}`;
  if (sameValue(before ?? null, value ?? null)) remove(ck);
  else upsert({ kind: 'audio', key: ck, field, before: before ?? null, after: value ?? null });
  changed({ key: ck, audio: true });
}

export function setBrandColor(id, v) {
  const c = store.reel.brand.colors.find((x) => x.id === id);
  if (!c) return;
  const ck = `brand:${id}`;
  if (sameValue(c.v, v)) remove(ck);
  else upsert({ kind: 'brand', key: ck, colorId: id, before: c.v, after: v });
  changed({ key: ck, brand: true });
}

export function setFont(id, v) {
  const f = store.reel.brand.fonts.find((x) => x.id === id);
  if (!f) return;
  const ck = `font:${id}`;
  if (sameValue(f.v, v)) remove(ck);
  else upsert({ kind: 'font', key: ck, fontId: id, before: f.v, after: v });
  changed({ key: ck, brand: true });
}

export function addNote({ t, x, y, elId, text = '' }) {
  const id = newId('n');
  const scene = sceneAt(t);
  const rec = { kind: 'note', key: `note:${id}`, id, t, x, y, elId: elId || null, sceneId: scene?.id || null, text };
  store.data.changes.push({ ...rec, createdAt: Date.now(), sent: null });
  changed({ key: rec.key, note: id, added: true });
  return rec;
}

export function updateNote(id, text) {
  const n = store.data.changes.find((c) => c.kind === 'note' && c.id === id);
  if (!n) return;
  n.text = text;
  n.sent = null;
  n.updatedAt = Date.now();
  changed({ key: n.key, note: id });
}

export function addUpload(asset) {
  const a = { id: asset.id, name: asset.name || baseName(asset.id), type: asset.type || 'audio', from: 'Upload' };
  if (!store.data.uploads.some((u) => u.id === a.id)) store.data.uploads.push(a);
  const ck = `upload:${a.id}`;
  if (!findChange(ck)) store.data.changes.push({ kind: 'upload', key: ck, id: newId(), asset: a, createdAt: Date.now(), sent: null });
  changed({ key: ck, upload: true });
  return a;
}

export function undo(key) {
  const c = findChange(key);
  if (!c) return false;
  remove(key);
  if (c.kind === 'upload') {
    store.data.uploads = store.data.uploads.filter((u) => u.id !== c.asset.id);
    if (audioValue('music') === c.asset.id) remove('audio:music');
  }
  changed({ key, undone: true, elId: c.elId, note: c.kind === 'note' ? c.id : undefined });
  return true;
}

export function undoLast() {
  const list = store.data.changes.filter((c) => !c.sent);
  const last = list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))[0];
  if (!last) return null;
  undo(last.key);
  return last;
}

export function setStatus(sceneId, st) {
  if (st === 'review') delete store.data.status[sceneId];
  else store.data.status[sceneId] = st;
  persist();
  bus.emit('status', { sceneId });
}

export function toggleApproved(sceneId) {
  setStatus(sceneId, sceneStatus(sceneId) === 'approved' ? 'review' : 'approved');
  return sceneStatus(sceneId);
}

// ---------------------------------------------------------------- UI state (not persisted)

export function select(elId) {
  if (elId && !store.els.has(elId)) elId = null;
  if (store.ui.selected === elId) return;
  store.ui.selected = elId;
  bus.emit('select', { elId });
}

export function setTab(tab) {
  store.ui.tab = tab;
  bus.emit('tab', { tab });
}

// ---------------------------------------------------------------- persistence

const lsKey = () => `motionsnip:state:${store.reel?.id || 'reel'}`;

const postState = debounce(async () => {
  try {
    await api('/api/state', { json: store.data });
  } catch (e) {
    console.warn('[motionsnip] could not save state to the server:', e.message);
  }
}, 600);

export function persist() {
  store.data.savedAt = Date.now();
  store.data.reelId = store.reel?.id || null;
  try {
    localStorage.setItem(lsKey(), JSON.stringify(store.data));
  } catch {
    /* storage full or blocked */
  }
  postState();
}

export function flushPersist() {
  postState.flush();
}

function sanitizeData(d) {
  const base = emptyData();
  if (!d || typeof d !== 'object') return base;
  return {
    ...base,
    ...d,
    changes: Array.isArray(d.changes) ? d.changes.filter((c) => c && c.key && c.kind) : [],
    status: d.status && typeof d.status === 'object' ? d.status : {},
    uploads: Array.isArray(d.uploads) ? d.uploads.filter((u) => u && u.id) : [],
    notQuite: Array.isArray(d.notQuite) ? d.notQuite : [],
  };
}

/** Load saved state: browser storage and the server's copy; the newer one wins. */
export async function loadSaved() {
  let local = null;
  try {
    local = JSON.parse(localStorage.getItem(lsKey()) || 'null');
  } catch {
    local = null;
  }
  let remote = null;
  try {
    remote = await api('/api/state');
  } catch {
    remote = null;
  }
  const id = store.reel.id;
  const ok = (d) => d && typeof d === 'object' && (!d.reelId || d.reelId === id) && Array.isArray(d.changes);
  const cands = [local, remote].filter(ok);
  cands.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  store.data = sanitizeData(cands[0]);
  store.data.reelId = id;
  dropStaleChanges();
}

/** Remove records that point at elements/props the reel no longer has. */
function dropStaleChanges() {
  const reel = store.reel;
  store.data.changes = store.data.changes.filter((c) => {
    if (c.kind === 'prop') return !!getEl(c.elId)?.props[c.propKey];
    if (c.kind === 'box') return !!getEl(c.elId)?.box;
    if (c.kind === 'brand') return reel.brand.colors.some((x) => x.id === c.colorId);
    if (c.kind === 'font') return reel.brand.fonts.some((x) => x.id === c.fontId);
    return true;
  });
}

export function setReel(raw) {
  store.reel = normalizeReel(raw);
  indexEls();
}

/**
 * A new version arrived. Returns the changes that had been sent (they leave the list; the caller builds the
 * Check view from them). Unsent changes are rebased onto the new reel's values.
 */
export function adoptNewReel(raw) {
  const oldReel = store.reel;
  setReel(raw);
  const sent = [];
  const keep = [];
  for (const c of store.data.changes) {
    if (c.sent && c.sent < store.reel.version) sent.push(c);
    else keep.push(c);
  }
  // rebase unsent records
  store.data.changes = keep.filter((c) => {
    if (c.kind === 'prop') {
      const p = getEl(c.elId)?.props[c.propKey];
      if (!p) return false;
      c.before = p.v;
      return !sameValue(p.v, c.after);
    }
    if (c.kind === 'box') {
      const el = getEl(c.elId);
      if (!el?.box) return false;
      c.before = el.box.slice();
      return !sameBox(el.box, c.after, 0.05);
    }
    if (c.kind === 'audio') {
      c.before = store.reel.audio[c.field] ?? null;
      return !sameValue(c.before, c.after);
    }
    if (c.kind === 'brand') {
      const col = store.reel.brand.colors.find((x) => x.id === c.colorId);
      if (!col) return false;
      c.before = col.v;
      return !sameValue(col.v, c.after);
    }
    if (c.kind === 'font') {
      const f = store.reel.brand.fonts.find((x) => x.id === c.fontId);
      if (!f) return false;
      c.before = f.v;
      return !sameValue(f.v, c.after);
    }
    return true;
  });
  // keep uploads that the new reel doesn't list yet
  store.data.uploads = store.data.uploads.filter((u) => !store.reel.assets.some((a) => a.id === u.id));
  void oldReel;
  return sent;
}
