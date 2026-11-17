// The reel, the reviewer's changes and notes, and their persistence.
//
// Everything the reviewer does is a "change" record with a stable `key`, so editing the same prop twice
// keeps one record, and undo removes exactly one thing. Records are saved to browser storage and to
// `.motionsnip/state.json` (POST /api/state, debounced). On load the newer copy wins.

import { Emitter, api, debounce, newId, sameValue, sameBox, baseName } from './util.js';
import { normalizeReel, resolveOutput, outTime, masterTime } from './reel.mjs';

export const bus = new Emitter();


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
    vedit: null, // a plain video's own edits (vedit.js)
    review: {}, // Claude's self-review findings: "v<version>:<id>" -> 'accepted' | 'dismissed'
  };
}

export const store = {
  /** the reel as seen on the current output (the master, or a cutdown/language version of it) */
  reel: null,
  /** the master reel, with every output */
  master: null,
  /** the output on screen: 'master' or an output id */
  out: 'master',
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
  if (store.reel?.derived) return []; // an output takes notes; element edits belong on the master
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
  return c ? c.after : store.master?.audio[field];
}

/** The master's sound with the reviewer's changes: what an export or a cutdown mixes. */
export function masterAudio() {
  const a = { ...store.master.audio };
  for (const f of AUDIO_FIELDS) a[f] = audioValue(f);
  return a;
}

/** The sound to play with the video on screen. A cutdown has its music mixed in already. */
export function effectiveAudio() {
  return store.reel?.derived ? { ...store.reel.audio } : masterAudio();
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

// ---------------------------------------------------------------- Claude's self-review

const reviewKey = (f) => `${store.out === 'master' ? '' : store.out + '@'}v${store.reel.version}:${f.id}`;

/** Findings with a place on the frame: their own box or point, or their element's box. */
export function findingSpot(f) {
  const b = f.box || (f.elId && getEl(f.elId) ? boxValue(f.elId) : null);
  if (b) return { box: b, x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 };
  if (f.x != null && f.y != null) return { box: null, x: f.x, y: f.y };
  return null;
}

export function findingState(f) {
  return store.data.review[reviewKey(f)] || 'open';
}

/** Findings the reviewer hasn't accepted or dismissed yet. */
export function openFindings() {
  return store.reel ? store.reel.review.filter((f) => findingState(f) === 'open') : [];
}

export function dismissedFindings() {
  return store.reel ? store.reel.review.filter((f) => findingState(f) === 'dismissed') : [];
}

export function findingNumber(id) {
  return store.reel.review.findIndex((f) => f.id === id) + 1;
}

/** Accepting turns the finding into one of the reviewer's own notes. */
export function acceptFinding(id) {
  const f = store.reel.review.find((x) => x.id === id);
  if (!f) return null;
  const spot = findingSpot(f) || { x: 50, y: 50 };
  const text = f.fix ? `${f.title}. ${f.fix}` : f.title;
  store.data.review[reviewKey(f)] = 'accepted';
  const rec = addNote({ t: f.t, x: spot.x, y: spot.y, elId: f.elId, text, review: f.id });
  return rec;
}

export function dismissFinding(id) {
  const f = store.reel.review.find((x) => x.id === id);
  if (!f) return;
  store.data.review[reviewKey(f)] = 'dismissed';
  changed({ review: id });
}

export function restoreFinding(id) {
  const f = store.reel.review.find((x) => x.id === id);
  if (!f) return;
  delete store.data.review[reviewKey(f)];
  changed({ review: id });
}

const noteOut = (n) => n.out || 'master';

/** Notes pinned on the output on screen. */
export function notes() {
  return store.data.changes.filter((c) => c.kind === 'note' && noteOut(c) === store.out);
}

/** Every note, on every output. */
export function allNotes() {
  return store.data.changes.filter((c) => c.kind === 'note');
}

/** A note's number among the notes on its own output. */
export function noteNumber(id) {
  const n = allNotes().find((x) => x.id === id);
  if (!n) return 0;
  return allNotes()
    .filter((x) => noteOut(x) === noteOut(n))
    .findIndex((x) => x.id === id) + 1;
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
  return store.master.scenes.filter((s) => sceneStatus(s.id) === 'approved').length;
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

export function addNote({ t, x, y, elId, text = '', review = null }) {
  const id = newId('n');
  const scene = sceneAt(t);
  const rec = { kind: 'note', key: `note:${id}`, id, t, x, y, elId: elId || null, sceneId: scene?.id || null, text };
  if (store.out !== 'master') rec.out = store.out; // pinned on a cutdown: its time is on that output's clock
  if (review) rec.review = review; // accepted from Claude's self-review
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
  // undoing an accepted finding puts it back up for review
  if (c.kind === 'note' && c.review && store.reel && (c.out || 'master') === store.out) delete store.data.review[reviewKey({ id: c.review })];
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
    review: d.review && typeof d.review === 'object' && !Array.isArray(d.review) ? d.review : {},
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
  store.master = normalizeReel(raw);
  if (store.out !== 'master' && !store.master.outputs.some((o) => o.id === store.out)) store.out = 'master';
  store.reel = resolveOutput(store.master, store.out);
  indexEls();
}

/** The output on screen, or null for the master. */
export const currentOutput = () => store.reel?.output || null;

/**
 * Show another output. Returns the time to show it at (the same moment, on that output's clock).
 * The caller reloads the video, timeline and overlay.
 */
export function setOutput(id, t = store.ui.t) {
  const from = currentOutput();
  const next = id && id !== 'master' && store.master.outputs.some((o) => o.id === id) ? id : 'master';
  const mt = masterTime(from, t);
  store.out = next;
  store.reel = resolveOutput(store.master, next);
  indexEls();
  store.ui.selected = null;
  store.ui.noteOpen = null;
  return outTime(currentOutput(), mt);
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
    if (c.sent && c.sent < store.master.version) sent.push(c);
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
      c.before = store.master.audio[c.field] ?? null;
      return !sameValue(c.before, c.after);
    }
    if (c.kind === 'brand') {
      const col = store.master.brand.colors.find((x) => x.id === c.colorId);
      if (!col) return false;
      c.before = col.v;
      return !sameValue(col.v, c.after);
    }
    if (c.kind === 'font') {
      const f = store.master.brand.fonts.find((x) => x.id === c.fontId);
      if (!f) return false;
      c.before = f.v;
      return !sameValue(f.v, c.after);
    }
    return true;
  });
  // keep uploads that the new reel doesn't list yet
  store.data.uploads = store.data.uploads.filter((u) => !store.master.assets.some((a) => a.id === u.id));
  void oldReel;
  return sent;
}
