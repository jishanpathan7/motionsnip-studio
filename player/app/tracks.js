// The multi-track editor for timeline projects: tracks and clips you move, trim, split and slip, keyframes,
// transitions, new text/shapes/captions/media, undo and redo. Every edit is a pure op on timeline.json
// (comp/ops.mjs), shown at once by the compositor and saved straight into the file, so Claude sees exactly what
// you did. timeline.js hands this module its host when the project is a timeline.

import { store, bus, select, getEl, editHooks } from './state.js';
import { player, seek, currentTime, duration, isPlaying, pause } from './video.js';
import { h, icon, clamp, fmtTime, projectUrl, toast, api } from './util.js';
import { normTimeline, findClip, valueAt, KEYS, TRANSITIONS, PRESETS, FONTS, baseName, editablePaths, kitLabel, setPath as tlSetPath } from './comp/timeline.mjs';
import { applyOps, ensureIds, newId } from './comp/ops.mjs';
import { setPath as sceneSetPath, normScene } from './scene/compile.mjs';

const SNAP_PX = 8;
const HEAD_W = 156;
const LANE_H = { video: 46, scene: 46, graphics: 38, audio: 40, captions: 30 };
const KIND_ICON = { video: 'film', scene: 'image', graphics: 'text', audio: 'music', captions: 'captions' };
const KIND_LABEL = { video: 'Video', scene: 'Scene', graphics: 'Graphics', audio: 'Audio', captions: 'Captions' };
const KEY_LABEL = { x: 'Move across', y: 'Move down', scale: 'Scale', rotate: 'Rotate', opacity: 'Opacity' };
const KEY_STEP = { x: 0.5, y: 0.5, scale: 0.01, rotate: 1, opacity: 0.05 };
const r3 = (v) => Math.round(v * 1000) / 1000;

const ED = {
  host: null,
  active: false,
  raw: null,
  scenes: {},
  saved: { raw: null, scenes: {} },
  rev: null,
  norm: null,
  undo: [],
  redo: [],
  coalesce: null, // { key, until }
  zoom: 0, // px per second; 0 = fit
  saving: Promise.resolve(),
  saveTimer: 0,
  inflight: 0,
  drag: null,
  sel: null, // the selected clip (audio clips and brand-new ones aren't reel elements yet)
  wantSel: null,
  durs: new Map(), // media src → seconds
  peaks: new Map(), // media src → Float32Array | null | Promise
  thumbs: new Map(), // `${src}@${t}` → ImageBitmap | canvas
  thumbQueue: [],
  thumbBusy: false,
};

// ---------------------------------------------------------------- the model

const opts = () => ({ scenes: ED.scenes, srcDur: (src) => ED.durs.get(src) || null });
function model() {
  if (!ED.norm) ED.norm = normTimeline(ED.raw, { scenes: ED.scenes });
  return ED.norm;
}

const fetchText = (rel) =>
  fetch(projectUrl(rel) + `?r=${Date.now()}`, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`${rel} returned ${r.status}`);
    return r.text();
  });

/** The same short sha1 the server calls rev, so a stale poll can't make us reload what we just wrote. */
async function revOf(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

async function readFiles() {
  const text = await fetchText(store.master.live?.spec || 'timeline.json');
  const raw = ensureIds(JSON.parse(text));
  const rev = await revOf(text).catch(() => store.master.rev);
  const scenes = {};
  for (const t of raw.tracks || [])
    if (t?.kind === 'scene')
      for (const c of t.clips || []) {
        const f = typeof c?.scene === 'string' && c.scene ? c.scene : 'scene.json';
        if (!(f in scenes)) scenes[f] = await fetchText(f).then(JSON.parse).catch(() => null);
      }
  for (const k of Object.keys(scenes)) if (!scenes[k]) delete scenes[k];
  return { raw, scenes, rev };
}

/** Show a state: the compositor gets it at once, the editor redraws. */
function show(raw, scenes) {
  ED.raw = raw;
  ED.scenes = scenes;
  ED.norm = null;
  try {
    player.live?.load?.(raw, scenes);
  } catch (e) {
    console.warn('[motionsnip] compositor load:', e.message);
  }
  render();
  bus.emit('tracks', {});
}

/**
 * Make an edit: ops (comp/ops.mjs) or a function raw → { raw, scenes }. Pushes undo, shows it, saves it.
 * coalesce: edits with the same key within a second share one undo step (typing, dragging a number).
 */
export function edit(ops, { coalesce = null, scenes = null } = {}) {
  if (!ED.active) return false;
  let next;
  try {
    next = typeof ops === 'function' ? ops(ED.raw, ED.scenes) : { raw: applyOps(ED.raw, ops, opts()), scenes: scenes || ED.scenes };
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return false;
  }
  if (!next || !next.raw) return false;
  const now = Date.now();
  const same = coalesce && ED.coalesce && ED.coalesce.key === coalesce && ED.coalesce.until > now;
  if (!same) {
    ED.undo.push({ raw: ED.raw, scenes: ED.scenes });
    if (ED.undo.length > 200) ED.undo.shift();
  }
  ED.coalesce = coalesce ? { key: coalesce, until: now + 1000 } : null;
  ED.redo = [];
  show(next.raw, next.scenes || ED.scenes);
  queueSave();
  return true;
}

export function undo() {
  const prev = ED.undo.pop();
  if (!prev) return false;
  ED.redo.push({ raw: ED.raw, scenes: ED.scenes });
  ED.coalesce = null;
  show(prev.raw, prev.scenes);
  queueSave();
  return true;
}

export function redo() {
  const next = ED.redo.pop();
  if (!next) return false;
  ED.undo.push({ raw: ED.raw, scenes: ED.scenes });
  ED.coalesce = null;
  show(next.raw, next.scenes);
  queueSave();
  return true;
}

// ---------------------------------------------------------------- saving into the files

function queueSave() {
  clearTimeout(ED.saveTimer);
  ED.saveTimer = setTimeout(() => {
    ED.saving = ED.saving.then(save, save);
  }, 250);
}

async function save() {
  if (!ED.active) return;
  const raw = ED.raw;
  const scenes = ED.scenes;
  ED.inflight++;
  try {
    for (const [file, sc] of Object.entries(scenes)) {
      if (ED.saved.scenes[file] === sc) continue;
      await api('/api/project-apply', { json: { file, content: sc } });
      ED.saved.scenes = { ...ED.saved.scenes, [file]: sc };
    }
    if (ED.saved.raw !== raw) {
      const r = await api('/api/project-apply', { json: { file: 'timeline.json', base: ED.rev, content: raw } });
      ED.rev = r.rev;
      ED.saved.raw = raw;
    }
    bus.emit('refresh', {}); // the reel (sections, checks, boxes) from the saved file
  } catch (e) {
    if (e.status === 409) {
      toast('timeline.json was changed outside the editor. Loaded the new one; your last edit was not saved.', { kind: 'error', ms: 7000 });
      await reloadFromDisk();
    } else toast(`Couldn't save timeline.json: ${e.message}`, { kind: 'error', ms: 6000 });
  } finally {
    ED.inflight--;
  }
}

async function checkDisk() {
  if (ED.checking) return;
  ED.checking = true;
  try {
    const { raw, scenes, rev } = await readFiles();
    ED.depsRev = store.master.depsRev;
    if (!settled()) return; // an edit started while we read
    const scenesSame = JSON.stringify(scenes) === JSON.stringify(ED.saved.scenes);
    if (rev === ED.rev && scenesSame) return;
    clearTimeout(ED.saveTimer);
    ED.rev = rev;
    ED.saved = { raw, scenes };
    ED.undo = [];
    ED.redo = [];
    show(raw, scenes);
  } catch (e) {
    console.warn('[motionsnip] timeline reload:', e.message);
  } finally {
    ED.checking = false;
  }
}

async function reloadFromDisk() {
  try {
    const { raw, scenes, rev } = await readFiles();
    ED.rev = rev;
    ED.saved = { raw, scenes };
    ED.undo = [];
    ED.redo = [];
    show(raw, scenes);
  } catch (e) {
    toast(`Couldn't read timeline.json: ${e.message}`, { kind: 'error' });
  }
}

/** Saved and nothing waiting. */
export const settled = () => !ED.inflight && ED.saved.raw === ED.raw && !ED.drag;

/** Select a clip: the editor's own selection, and the element of the same id when the reel has it. */
export function selectClip(id) {
  if (id && store.els.has(id)) select(id);
  else if (store.ui.selected) select(null);
  ED.sel = id || null;
  ED.wantSel = id && !store.els.has(id) ? id : null;
  bus.emit('select', { elId: store.ui.selected, tracks: true });
}

/** The selected timeline clip's id, for the panel. */
export const selectedClipId = () => (ED.active ? ED.sel : null);

// ---------------------------------------------------------------- setup

export function initTracks(host) {
  ED.host = host;
  editHooks.prop = propHook;
  editHooks.box = boxHook;
  bus.on('time', ({ t }) => movePlayhead(t));
  bus.on('reel', () => {
    if (!ED.active || !store.reel?.timeline) return;
    if (ED.wantSel && store.els.has(ED.wantSel)) {
      const id = ED.wantSel;
      ED.wantSel = null;
      select(id);
    }
    render();
    // someone else may have changed the files (Claude, another tab): take them when we have nothing unsaved
    if (settled() && (store.master.rev !== ED.rev || store.master.depsRev !== ED.depsRev)) checkDisk();
  });
  bus.on('select', (d) => {
    if (!ED.active) return;
    if (!d?.tracks) {
      // picked on the frame or in the panel: a scene's element selects its clip
      const id = d?.elId || null;
      ED.sel = id ? id.split('/')[0] : null;
      ED.wantSel = null;
    }
    render();
  });
  bus.on('theme', () => render());
  new ResizeObserver(() => ED.active && render()).observe(host);
  host.addEventListener('dragover', (e) => {
    if (!ED.active || ![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    host.classList.add('is-drop');
  });
  host.addEventListener('dragleave', () => host.classList.remove('is-drop'));
  host.addEventListener('drop', onDrop);
}

/** Called by timeline.js whenever a reel loads. */
export async function loadTracks() {
  const on = !!store.reel?.timeline && !store.reel.derived;
  const was = ED.active && ED.raw;
  ED.active = on;
  ED.host.hidden = !on;
  if (!on) return;
  // already open: keep the edits and undo; a changed file is picked up by the 'reel' check
  if (was) return render();
  try {
    const { raw, scenes, rev } = await readFiles();
    ED.rev = rev;
    ED.depsRev = store.master.depsRev;
    ED.saved = { raw, scenes };
    ED.undo = [];
    ED.redo = [];
    ED.raw = raw;
    ED.scenes = scenes;
    ED.norm = null;
    loadDurations();
    render();
    bus.emit('tracks', {}); // the panel's clip inspector can show now
  } catch (e) {
    ED.host.replaceChildren(h('p.muted.small', `Couldn't read the timeline: ${e.message}`));
  }
}

function loadDurations() {
  for (const tr of model().tracks)
    for (const c of tr.clips) {
      const src = c.src;
      if (!src || ED.durs.has(src) || (tr.kind !== 'video' && tr.kind !== 'audio')) continue;
      ED.durs.set(src, null);
      const m = document.createElement(tr.kind === 'video' ? 'video' : 'audio');
      m.preload = 'metadata';
      m.onloadedmetadata = () => {
        ED.durs.set(src, Number.isFinite(m.duration) ? m.duration : null);
        m.removeAttribute('src');
        m.load();
      };
      m.src = projectUrl(src);
    }
}

// ---------------------------------------------------------------- geometry

const lanesWidth = () => Math.max(100, (ED.host?.clientWidth || 800) - HEAD_W - 2);
const span = () => Math.max(model().duration + 2, 8);
const zoom = () => (ED.zoom > 0 ? ED.zoom : lanesWidth() / span());
const x = (t) => t * zoom();
const tAt = (px) => Math.max(0, px / zoom());

function snapPoints(skip) {
  const pts = [0, currentTime()];
  for (const tr of model().tracks) for (const c of tr.clips) if (!skip?.has(c.id)) pts.push(c.at, c.end);
  for (const m of model().markers) pts.push(m.t[0], m.t[1]);
  return pts;
}

function snap(t, skip, shift) {
  if (shift) return t;
  const tol = SNAP_PX / zoom();
  let best = t;
  let d = tol;
  for (const p of snapPoints(skip)) {
    if (Math.abs(p - t) < d) {
      d = Math.abs(p - t);
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------- drawing

function render() {
  if (!ED.active || !ED.raw || ED.host.hidden) return;
  const tl = model();
  const sel = ED.sel;
  const width = Math.max(lanesWidth(), x(span()));
  const head = h('div.trk-heads', h('div.trk-corner', h('span.small.muted', `${tl.tracks.length} track${tl.tracks.length === 1 ? '' : 's'}`)));
  const ruler = h('div.trk-ruler', { style: { width: width + 'px' } });
  drawRuler(ruler, width);
  const lanes = h('div.trk-lanes', { style: { width: width + 'px' } });
  for (const tr of tl.tracks) {
    head.append(trackHead(tr));
    const lane = h('div.trk-lane.k-' + tr.kind + (tr.hide ? '.is-hidden' : '') + (tr.mute ? '.is-muted' : '') + (tr.lock ? '.is-locked' : ''), { dataset: { track: tr.id, kind: tr.kind }, style: { height: LANE_H[tr.kind] + 'px' } });
    for (const c of tr.clips) lane.append(clipEl(tr, c, c.id === sel));
    lanes.append(lane);
  }
  if (!tl.tracks.length) lanes.append(h('div.trk-empty.muted.small', 'No tracks yet. Add text, a shape or a caption above, or drop a video, picture or sound here.'));
  const playhead = h('div.trk-playhead', { style: { transform: `translateX(${x(currentTime())}px)` } });
  const inner = h('div.trk-inner', { style: { width: width + 'px' } }, ruler, lanes, playhead);
  const scroller = h('div.trk-scroll', inner);
  const prev = ED.host.querySelector('.trk-scroll');
  const keep = prev ? prev.scrollLeft : 0;
  ED.host.replaceChildren(toolbar(), h('div.trk-body', head, scroller));
  scroller.scrollLeft = keep;
  ED.els = { scroller, inner, playhead, lanes, ruler };
  scroller.addEventListener('pointerdown', onDown);
  scroller.addEventListener('wheel', onWheel, { passive: false });
}

function movePlayhead(t) {
  if (!ED.active || !ED.els) return;
  ED.els.playhead.style.transform = `translateX(${x(t)}px)`;
  // keep the playhead in view while playing
  if (isPlaying()) {
    const s = ED.els.scroller;
    const px = x(t);
    if (px > s.scrollLeft + s.clientWidth - 40 || px < s.scrollLeft) s.scrollLeft = Math.max(0, px - 60);
  }
}

function drawRuler(ruler, width) {
  const z = zoom();
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * z >= 64) || 600;
  for (let t = 0; x(t) <= width; t += step) ruler.append(h('span.trk-tick', { style: { left: x(t) + 'px' } }, fmtTime(t)));
  for (const m of model().markers)
    ruler.append(
      h(
        'span.trk-marker',
        { style: { left: x(m.t[0]) + 'px', width: Math.max(2, x(m.t[1] - m.t[0])) + 'px' }, title: `${m.name} · ${fmtTime(m.t[0])}${m.t[1] > m.t[0] ? '–' + fmtTime(m.t[1]) : ''}` },
        h('span.trk-marker-name', m.name),
      ),
    );
}

function trackHead(tr) {
  const btn = (key, on, ic, offIc, label) =>
    h(
      'button.trk-hbtn' + (on ? '.is-on' : ''),
      { type: 'button', title: label, 'aria-label': `${label} ${tr.name}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => edit({ op: 'setTrack', track: tr.id, key, value: !on }) },
      icon(on ? ic : offIc || ic, 14),
    );
  const sound = tr.kind === 'audio' || tr.kind === 'video';
  const visual = tr.kind !== 'audio';
  return h(
    'div.trk-head.k-' + tr.kind,
    { style: { height: LANE_H[tr.kind] + 'px' } },
    h('span.trk-kind', { title: KIND_LABEL[tr.kind] }, icon(KIND_ICON[tr.kind], 14)),
    h('span.trk-name', { title: `${tr.name} (${tr.id})` }, tr.name),
    h(
      'span.trk-hbtns',
      sound ? btn('mute', tr.mute, 'mute', 'volume', tr.mute ? 'Unmute' : 'Mute') : null,
      btn('solo', tr.solo, 'jump', 'jump', tr.solo ? 'Unsolo' : 'Solo'),
      visual ? btn('hide', tr.hide, 'eyeoff', 'eye', tr.hide ? 'Show' : 'Hide') : null,
      btn('lock', tr.lock, 'lock', 'unlock', tr.lock ? 'Unlock' : 'Lock'),
    ),
  );
}

function clipLabel(tr, c) {
  if (c.name) return c.name;
  if (tr.kind === 'graphics' && c.type === 'kit') return kitLabel(c);
  if (tr.kind === 'graphics') return c.type === 'text' ? c.text || 'Text' : c.type[0].toUpperCase() + c.type.slice(1);
  if (tr.kind === 'captions') return c.text || 'Caption';
  if (tr.kind === 'scene') return `${c.scene} · ${c.shots.join(', ')}`;
  return baseName(c.src) || 'Clip';
}

function clipEl(tr, c, on) {
  const left = x(c.at);
  const w = Math.max(4, x(c.dur));
  const el = h(
    'div.trk-clip.k-' + tr.kind + (on ? '.is-sel' : '') + (c.noLength || c.noScene ? '.is-bad' : ''),
    { dataset: { clip: c.id }, style: { left: left + 'px', width: w + 'px' }, title: `${clipLabel(tr, c)} · ${fmtTime(c.at)}–${fmtTime(c.end)}${tr.lock ? ' · locked' : ''}` },
  );
  if (tr.kind === 'video' || tr.kind === 'audio') el.append(mediaCanvas(tr, c, w));
  el.append(h('span.trk-clip-name', clipLabel(tr, c)));
  if (c.enter) el.append(h('span.trk-trans.is-in', { style: { width: Math.min(w / 2, x(c.enter.dur)) + 'px' }, title: `In: ${c.enter.kind} ${c.enter.dur}s` }));
  if (c.exit) el.append(h('span.trk-trans.is-out', { style: { width: Math.min(w / 2, x(c.exit.dur)) + 'px' }, title: `Out: ${c.exit.kind} ${c.exit.dur}s` }));
  const keyTimes = new Set();
  for (const list of Object.values(c.keys || {})) for (const k of list) if (k[0] > 0.001 && k[0] < c.dur) keyTimes.add(k[0]);
  for (const kt of keyTimes) el.append(h('span.trk-key', { style: { left: x(kt) + 'px' }, title: `Keyframe at ${fmtTime(c.at + kt)}` }));
  if (!tr.lock) el.append(h('span.trk-edge.is-l', { dataset: { edge: 'start' }, title: 'Drag to trim the start' }), h('span.trk-edge.is-r', { dataset: { edge: 'end' }, title: 'Drag to trim the end' }));
  return el;
}

// waveform (audio, and the sound of a video) and thumbnails (video), drawn into one canvas per clip
function mediaCanvas(tr, c, w) {
  const hgt = LANE_H[tr.kind] - 4;
  const cv = h('canvas.trk-media', { width: Math.max(1, Math.round(w)), height: hgt });
  const g = cv.getContext('2d');
  if (tr.kind === 'video') {
    const n = Math.max(1, Math.round(w / 72));
    for (let i = 0; i < n; i++) {
      const st = r3(Math.round((c.in + ((i + 0.5) / n) * c.dur) * 4) / 4);
      const img = thumbFor(c.src, st);
      if (img) {
        const tw = w / n;
        const k = Math.max(tw / img.width, hgt / img.height);
        g.save();
        g.beginPath();
        g.rect(i * tw, 0, tw, hgt);
        g.clip();
        g.globalAlpha = 0.85;
        g.drawImage(img, i * tw + (tw - img.width * k) / 2, (hgt - img.height * k) / 2, img.width * k, img.height * k);
        g.restore();
      }
    }
  }
  const p = peaksFor(c.src);
  if (p && p.length) {
    const rate = 50; // buckets per second
    const color = getComputedStyle(document.documentElement).getPropertyValue(tr.kind === 'audio' ? '--wave-music' : '--wave-fx').trim() || '#aaa';
    g.fillStyle = color;
    const mid = tr.kind === 'audio' ? hgt / 2 : hgt * 0.8;
    const amp = tr.kind === 'audio' ? hgt / 2 - 2 : hgt * 0.18;
    for (let px = 0; px < w; px += 2) {
      const a = c.in + px / zoom();
      const b = c.in + (px + 2) / zoom();
      let m = 0;
      for (let i = Math.floor(a * rate); i < Math.min(p.length, Math.ceil(b * rate)); i++) m = Math.max(m, p[i]);
      const gain = c.gain * (tr.mute || c.mute ? 0.3 : 1);
      const hh = Math.max(1, Math.min(1, m * gain) * amp);
      g.fillRect(px, mid - hh, 1.5, hh * 2);
    }
  }
  return cv;
}

function peaksFor(src) {
  if (!src) return null;
  const v = ED.peaks.get(src);
  if (v !== undefined) return v instanceof Promise ? null : v;
  const p = (async () => {
    try {
      const buf = await (await fetch(projectUrl(src))).arrayBuffer();
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new AC(1, 2, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const rate = 50;
      const ch = audio.getChannelData(0);
      const per = Math.max(1, Math.floor(audio.sampleRate / rate));
      const out = new Float32Array(Math.ceil(ch.length / per));
      for (let i = 0; i < out.length; i++) {
        let m = 0;
        for (let j = i * per; j < Math.min(ch.length, (i + 1) * per); j += 4) m = Math.max(m, Math.abs(ch[j]));
        out[i] = m;
      }
      ED.peaks.set(src, out);
    } catch {
      ED.peaks.set(src, null); // no sound track, or a format the browser can't decode
    }
    render();
  })();
  ED.peaks.set(src, p);
  return null;
}

function thumbFor(src, t) {
  const k = `${src}@${t}`;
  const v = ED.thumbs.get(k);
  if (v) return v;
  if (v === undefined) {
    ED.thumbs.set(k, null);
    ED.thumbQueue.push({ src, t, k });
    pumpThumbs();
  }
  return null;
}

async function pumpThumbs() {
  if (ED.thumbBusy) return;
  ED.thumbBusy = true;
  const vids = new Map();
  try {
    while (ED.thumbQueue.length) {
      const { src, t, k } = ED.thumbQueue.shift();
      let v = vids.get(src);
      if (!v) {
        v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.src = projectUrl(src);
        await new Promise((res) => {
          v.onloadeddata = res;
          v.onerror = res;
          setTimeout(res, 5000);
        });
        vids.set(src, v);
      }
      if (!v.videoWidth) continue;
      await new Promise((res) => {
        v.onseeked = res;
        setTimeout(res, 3000);
        v.currentTime = Math.min(t, (v.duration || t) - 0.05);
      });
      const c = document.createElement('canvas');
      c.height = 60;
      c.width = Math.round((60 * v.videoWidth) / v.videoHeight);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      ED.thumbs.set(k, c);
      if (!ED.thumbQueue.length || ED.thumbQueue.length % 6 === 0) render();
    }
  } finally {
    for (const v of vids.values()) {
      v.removeAttribute('src');
      v.load();
    }
    ED.thumbBusy = false;
  }
}

// ---------------------------------------------------------------- toolbar

// buttons add-ons put in the toolbar's "add" group (addons.js host.addToolButton)
const extraTools = [];

/** An add-on's button beside Text, Shape and Caption. onClick runs with nothing; use addKitClip to add clips. */
export function addToolButton(tool) {
  extraTools.push(tool);
  if (ED.host) render();
}

/** Add a graphics clip at the playhead (a kit clip from an add-on). False when this isn't a timeline project. */
export function addKitClip(clip) {
  if (!ED.host || !ED.raw) return false;
  addClip('graphics', { type: 'kit', dur: 4, box: [10, 10, 80, 80], ...clip }, currentTime());
  return true;
}

function toolbar() {
  const tl = model();
  const sel = selectedClip();
  const b = (label, ic, onclick, opts = {}) =>
    h('button.btn.btn-sm' + (opts.ghost ? '.btn-ghost' : ''), { type: 'button', title: opts.title || label, 'aria-label': opts.title || label, disabled: !!opts.disabled, onclick }, icon(ic, 15), opts.iconOnly ? null : label);
  const fileIn = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/webm,audio/*,image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: () => uploadFiles([...fileIn.files], currentTime(), null) });
  const sceneFiles = Object.keys(ED.scenes);
  return h(
    'div.trk-bar',
    h('div.trk-group', b('Undo', 'undo', undo, { iconOnly: true, ghost: true, disabled: !ED.undo.length, title: 'Undo (⌘Z)' }), b('Redo', 'redo', redo, { iconOnly: true, ghost: true, disabled: !ED.redo.length, title: 'Redo (⇧⌘Z)' })),
    h(
      'div.trk-group',
      b('Text', 'text', () => addGraphic('text'), { title: 'Add text at the playhead (T)' }),
      b('Shape', 'shape', () => addGraphic('shape')),
      b('Caption', 'captions', addCaption),
      sceneFiles.length ? b('Scene', 'image', () => addScene(sceneFiles[0]), { title: `Add ${sceneFiles[0]} at the playhead` }) : null,
      b('Media', 'upload', () => fileIn.click(), { title: 'Add a video, picture or sound at the playhead (or drop files on a track)' }),
      ...extraTools.map((t) => b(t.label, t.icon || 'plus', t.onClick, { title: t.title || t.label })),
      fileIn,
    ),
    h(
      'div.trk-group',
      b('Split', 'split', () => splitAt(), { iconOnly: true, ghost: true, disabled: !clipToSplit(), title: 'Split at the playhead (S)' }),
      b('Delete', 'trash', () => removeSel(false), { iconOnly: true, ghost: true, disabled: !sel, title: 'Delete (Delete; ⇧Delete closes the gap)' }),
      b('Marker', 'marker', addMarker, { iconOnly: true, ghost: true, title: 'Add a marker at the playhead (B)' }),
    ),
    h('span.trk-spacer'),
    h('span.trk-dur.mono.small.muted', fmtTime(tl.duration)),
    h(
      'div.trk-group',
      b('Zoom out', 'zoomout', () => setZoom(zoom() / 1.5), { iconOnly: true, ghost: true }),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'Fit the whole timeline', onclick: () => setZoom(0), 'aria-pressed': ED.zoom ? 'false' : 'true' }, 'Fit'),
      b('Zoom in', 'zoomin', () => setZoom(zoom() * 1.5), { iconOnly: true, ghost: true }),
    ),
  );
}

function setZoom(z) {
  const fit = lanesWidth() / span();
  ED.zoom = z <= fit * 1.01 ? 0 : clamp(z, 2, 2000);
  render();
  // keep the playhead in view
  const s = ED.els?.scroller;
  if (s) s.scrollLeft = Math.max(0, x(currentTime()) - s.clientWidth / 2);
}

function onWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(zoom() * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}

// ---------------------------------------------------------------- adding things

function trackFor(kind, create = true) {
  const tr = model().tracks.find((t) => t.kind === kind && !t.lock);
  if (tr) return { id: tr.id, ops: [] };
  if (!create) return null;
  const id = newId(ED.raw, { video: 'v', scene: 's', graphics: 'g', audio: 'a', captions: 'cc' }[kind]);
  // new visual tracks go above the others of their kind; sound and captions at the end
  return { id, ops: [{ op: 'addTrack', kind, id }] };
}

function addClip(kind, clip, at) {
  const tr = trackFor(kind);
  const id = newId(applyOps(ED.raw, tr.ops, opts()));
  if (edit([...tr.ops, { op: 'add', track: tr.id, clip: { ...clip, id }, at: r3(at) }])) selectClip(id);
}

function addGraphic(type) {
  const base = type === 'text' ? { type, text: 'Your words here', dur: 3, preset: 'pop', box: [10, 40, 80, 20], style: { bg: '#15121dcc' } } : { type, dur: 3, box: [38, 38, 24, 24], fill: '#ff4fa3', radius: 12 };
  addClip('graphics', base, currentTime());
}

function addCaption() {
  addClip('captions', { text: 'Caption', dur: 2 }, currentTime());
}

function addScene(file) {
  addClip('scene', { scene: file }, currentTime());
}

function addMarker() {
  const n = model().markers.length + 1;
  edit({ op: 'marker', id: `m${Date.now().toString(36)}`, name: `Marker ${n}`, t: r3(currentTime()) });
}

async function uploadFiles(files, at, trackId) {
  for (const f of files) {
    const kind = /^video\//.test(f.type) ? 'video' : /^audio\//.test(f.type) ? 'audio' : /^image\//.test(f.type) ? 'image' : null;
    if (!kind) {
      toast(`${f.name}: only videos, sounds and pictures go on the timeline`, { kind: 'error' });
      continue;
    }
    toast(`Adding ${f.name}…`);
    let res;
    try {
      res = await api(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    } catch (e) {
      toast(`${f.name}: ${e.message}`, { kind: 'error', ms: 6000 });
      continue;
    }
    const src = res?.path || res?.id || res?.file;
    if (!src) continue;
    const len = await mediaLength(src, kind);
    if (kind === 'image') addClip('graphics', { type: 'image', src, dur: 4, box: [25, 20, 50, 60] }, at);
    else {
      const tk = trackId && model().tracks.find((t) => t.id === trackId && t.kind === kind) ? { id: trackId, ops: [] } : trackFor(kind);
      const id = newId(applyOps(ED.raw, tk.ops, opts()));
      ED.durs.set(src, len);
      if (edit([...tk.ops, { op: 'add', track: tk.id, clip: { id, src, in: 0, out: r3(len || 5) }, at: r3(at) }])) selectClip(id);
    }
    at += len || 4;
  }
}

function mediaLength(src, kind) {
  if (kind === 'image') return Promise.resolve(4);
  return new Promise((res) => {
    const m = document.createElement(kind === 'video' ? 'video' : 'audio');
    m.preload = 'metadata';
    m.onloadedmetadata = () => res(Number.isFinite(m.duration) ? r3(m.duration) : null);
    m.onerror = () => res(null);
    m.src = projectUrl(src);
  });
}

function onDrop(e) {
  ED.host.classList.remove('is-drop');
  if (!ED.active) return;
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  const lane = e.target.closest?.('.trk-lane');
  const r = ED.els?.inner.getBoundingClientRect();
  const at = r && e.clientX > r.left ? tAt(e.clientX - r.left) : currentTime();
  uploadFiles(files, at, lane?.dataset.track || null);
}

// ---------------------------------------------------------------- editing what is selected

function selectedClip() {
  const id = ED.sel;
  return id && ED.raw ? findClip(model(), id) : null;
}

/** The selected clip if the playhead is inside it, else the top visual clip under the playhead. */
function clipToSplit() {
  const t = currentTime();
  const s = selectedClip();
  if (s) return t > s.clip.at + 0.05 && t < s.clip.end - 0.05 && !s.track.lock ? s : null;
  const tracks = [...model().tracks].reverse();
  for (const tr of tracks) {
    if (tr.lock) continue;
    const c = tr.clips.find((c) => t > c.at + 0.05 && t < c.end - 0.05);
    if (c) return { track: tr, clip: c };
  }
  return null;
}

function splitAt() {
  const s = clipToSplit();
  if (!s) return toast('Put the playhead inside a clip to split it.');
  const id = newId(ED.raw);
  if (edit({ op: 'split', clip: s.clip.id, t: r3(currentTime()), id })) selectClip(id);
}

function removeSel(ripple) {
  const s = selectedClip();
  if (!s) return;
  if (edit({ op: 'remove', clip: s.clip.id, ripple })) selectClip(null);
}

function duplicateSel() {
  const s = selectedClip();
  if (!s) return;
  const rawClip = ED.raw.tracks.find((t) => t.id === s.track.id)?.clips.find((c) => c.id === s.clip.id);
  const id = newId(ED.raw);
  if (edit({ op: 'add', track: s.track.id, clip: { ...structuredClone(rawClip), id }, at: s.clip.end })) selectClip(id);
}

function nudge(frames) {
  const s = selectedClip();
  if (!s) return;
  edit({ op: 'move', clip: s.clip.id, at: r3(Math.max(0, s.clip.at + frames / model().fps)) }, { coalesce: `nudge:${s.clip.id}` });
}

/** Keys while a timeline is open. Returns true when it used the key. */
export function tracksKey(e) {
  if (!ED.active) return false;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (mod && (k === 'z' || k === 'Z')) return e.shiftKey ? redo() || true : undo();
  if (mod && (k === 'y' || k === 'Y')) return redo() || true;
  if (mod && (k === 'd' || k === 'D')) {
    duplicateSel();
    return true;
  }
  if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight') && selectedClip()) {
    nudge((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
    return true;
  }
  if (mod || e.altKey) return false;
  if (k === 'Escape' && ED.sel && !store.ui.selected) {
    selectClip(null);
    return true;
  }
  if (k === 's' || k === 'S') {
    splitAt();
    return true;
  }
  if ((k === 'Delete' || k === 'Backspace') && selectedClip()) {
    removeSel(e.shiftKey);
    return true;
  }
  if (k === 't' || k === 'T') {
    addGraphic('text');
    return true;
  }
  if (k === 'b' || k === 'B') {
    addMarker();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- dragging clips, scrubbing

function onDown(e) {
  if (e.button !== 0) return;
  const inner = ED.els.inner;
  const r = inner.getBoundingClientRect();
  const t0 = tAt(e.clientX - r.left);
  const clipNode = e.target.closest('.trk-clip');
  if (!clipNode) {
    // empty lane or the ruler: scrub
    if (isPlaying()) pause();
    if (!e.target.closest('.trk-ruler') && ED.sel) selectClip(null);
    seek(t0, { exact: true });
    const move = (ev) => seek(tAt(ev.clientX - r.left), { exact: true });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return;
  }
  const id = clipNode.dataset.clip;
  const found = findClip(model(), id);
  if (!found) return;
  e.preventDefault();
  if (ED.sel !== id) selectClip(id);
  if (found.track.lock) return;
  const edge = e.target.dataset.edge || null;
  const mode = edge ? 'trim' : e.altKey ? 'slip' : 'move';
  ED.drag = { id, mode, edge, x0: e.clientX, raw0: ED.raw, scenes0: ED.scenes, c: found.clip, track: found.track, moved: false, shift: e.shiftKey };
  ED.host.classList.add('is-dragging', `is-${mode}`);
  const move = (ev) => dragMove(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    dragEnd(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function laneUnder(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.trk-lane');
  return el ? { id: el.dataset.track, kind: el.dataset.kind } : null;
}

function dragMove(ev) {
  const d = ED.drag;
  if (!d) return;
  const dx = ev.clientX - d.x0;
  if (!d.moved && Math.abs(dx) < 3 && d.mode !== 'move') return;
  if (!d.moved && Math.abs(dx) < 3 && !laneChanged(ev, d)) return;
  d.moved = true;
  const dt = dx / zoom();
  const skip = new Set([d.id]);
  const shift = ev.shiftKey;
  let ops;
  if (d.mode === 'move') {
    let at = Math.max(0, d.c.at + dt);
    const s1 = snap(at, skip, shift);
    const s2 = snap(at + d.c.dur, skip, shift) - d.c.dur;
    at = Math.abs(s1 - at) <= Math.abs(s2 - at) ? s1 : s2;
    const lane = laneUnder(ev);
    ops = [{ op: 'move', clip: d.id, at: r3(Math.max(0, at)), track: lane && lane.kind === d.track.kind ? lane.id : undefined }];
  } else if (d.mode === 'trim') {
    const t = d.edge === 'start' ? snap(d.c.at + dt, skip, shift) : snap(d.c.end + dt, skip, shift);
    ops = [{ op: 'trim', clip: d.id, edge: d.edge, t: r3(t) }];
  } else ops = [{ op: 'slip', clip: d.id, by: r3(-dt) }];
  try {
    const next = applyOps(d.raw0, ops, opts());
    ED.raw = next;
    ED.norm = null;
    player.live?.load?.(next, ED.scenes);
    render();
    if (d.mode === 'trim') seek(d.edge === 'start' ? model().tracks.flatMap((t) => t.clips).find((c) => c.id === d.id)?.at ?? currentTime() : Math.max(0, (findClip(model(), d.id)?.clip.end ?? currentTime()) - 0.5 / model().fps), { exact: true });
  } catch {
    /* an edit that can't happen there: stay where it was */
  }
}

const laneChanged = (ev, d) => {
  const l = laneUnder(ev);
  return l && l.id !== d.track.id;
};

function dragEnd() {
  const d = ED.drag;
  ED.drag = null;
  ED.host.classList.remove('is-dragging', 'is-move', 'is-trim', 'is-slip');
  if (!d || !d.moved || ED.raw === d.raw0) return render();
  ED.undo.push({ raw: d.raw0, scenes: d.scenes0 });
  ED.redo = [];
  ED.coalesce = null;
  render();
  bus.emit('tracks', {});
  queueSave();
}

// ---------------------------------------------------------------- props and boxes from the player and panel

/** An element prop edited in the panel or on the frame: save it into timeline.json or the scene file. */
function propHook(el, key, value) {
  if (!ED.active || !store.reel?.timeline) return false;
  const p = el.props[key];
  if (!p?.path) return false;
  const ck = `prop:${el.id}:${key}`;
  if (p.file) {
    if (!ED.scenes[p.file]) return false;
    return edit(
      (raw, scenes) => {
        const sc = sceneSetPath(scenes[p.file], p.path, value);
        normScene(sc);
        return { raw, scenes: { ...scenes, [p.file]: sc } };
      },
      { coalesce: ck },
    );
  }
  if (!editablePaths(ED.raw, { scenes: ED.scenes }).has(p.path)) return false;
  return edit((raw, scenes) => ({ raw: tlSetPath(raw, p.path, value), scenes }), { coalesce: ck });
}

/** A clip's box dragged on the frame: move and resize its own box by the same amount. */
function boxHook(el, nb) {
  if (!ED.active || !store.reel?.timeline || !el.clip || el.id !== el.clip) return false;
  const f = findClip(model(), el.clip);
  if (!f || f.track.kind === 'captions' || f.track.kind === 'audio') return false;
  const ob = el.box;
  const base = f.clip.box || [0, 0, 100, 100];
  const kx = ob[2] > 0 ? nb[2] / ob[2] : 1;
  const ky = ob[3] > 0 ? nb[3] / ob[3] : 1;
  const box = [r3(base[0] + (nb[0] - ob[0])), r3(base[1] + (nb[1] - ob[1])), r3(base[2] * kx), r3(base[3] * ky)];
  return edit({ op: 'set', clip: f.clip.id, key: 'box', value: box });
}

// ---------------------------------------------------------------- the inspector (panel, Edit tab)

/** The clip inspector for the panel: timing, transitions, keyframes, sound, look and style. null when not a clip. */
export function inspector(el) {
  if (!ED.active) return null;
  const cid = el ? (el.clip && el.id === el.clip ? el.clip : null) : ED.sel;
  const f = cid && findClip(model(), cid);
  if (!f) return null;
  const { track: tr, clip: c } = f;
  const id = c.id;
  const locked = tr.lock;
  const set = (key, value, co) => edit({ op: 'set', clip: id, key, value }, { coalesce: co || `set:${id}:${key}` });
  const num = (label, v, step, min, max, onSet, unit) => {
    const inp = h('input.input.input-sm', { type: 'number', step, value: String(r3(v)), min, max, disabled: locked, 'aria-label': label });
    inp.addEventListener('change', () => {
      const n = Number(inp.value);
      if (Number.isFinite(n)) onSet(clamp(n, min ?? -Infinity, max ?? Infinity));
    });
    return h('label.ins-num', h('span.ins-label', label), inp, unit ? h('span.small.muted', unit) : null);
  };
  const sec = (title, ...kids) => h('section.psec.ins', h('h3.psec-title', title), ...kids);
  const out = h('div.ins-wrap');

  // timing
  out.append(
    sec(
      'Timing',
      h(
        'div.ins-row',
        num('Start', c.at, 0.1, 0, null, (v) => edit({ op: 'move', clip: id, at: r3(v) })),
        num('Length', c.dur, 0.1, 0.05, null, (v) => edit({ op: 'trim', clip: id, edge: 'end', t: r3(c.at + v) })),
        tr.kind === 'video' || tr.kind === 'audio' || tr.kind === 'scene' ? num('From', c.in, 0.1, 0, null, (v) => edit({ op: 'slip', clip: id, by: r3(v - c.in) }), 's in') : null,
      ),
      h('div.small.muted', `${tr.name} · ${fmtTime(c.at)}–${fmtTime(c.end)}${locked ? ' · track locked' : ''}`),
    ),
  );

  // transitions
  if (tr.kind !== 'audio') {
    const trans = (which) => {
      const v = c[which];
      const sel = h(
        'select.input.input-sm',
        { 'aria-label': which === 'enter' ? 'Transition in' : 'Transition out', disabled: locked },
        h('option', { value: '' }, 'None'),
        TRANSITIONS.map((k) => h('option', { value: k, selected: v?.kind === k }, k[0].toUpperCase() + k.slice(1))),
      );
      sel.addEventListener('change', () => set(which, sel.value ? { kind: sel.value, dur: v?.dur || 0.5 } : null));
      return h('div.ins-trans', h('span.ins-label', which === 'enter' ? 'In' : 'Out'), sel, v ? num('Seconds', v.dur, 0.1, 0.05, 10, (d) => set(which, { kind: v.kind, dur: r3(d) })) : null);
    };
    out.append(sec('Transitions', trans('enter'), trans('exit')));
  }

  // keyframes
  if (tr.kind !== 'audio' && tr.kind !== 'captions') {
    const u = r3(clamp(currentTime() - c.at, 0, c.dur));
    const inside = currentTime() >= c.at - 1 / 240 && currentTime() <= c.end + 1 / 240;
    const rows = Object.keys(KEYS).map((p) => {
      const list = c.keys[p] || [];
      const v = valueAt(list, u, KEYS[p]);
      const here = list.find((k) => Math.abs(k[0] - u) < 1 / 240);
      const prevK = [...list].reverse().find((k) => k[0] < u - 1 / 240);
      const nextK = list.find((k) => k[0] > u + 1 / 240);
      const inp = h('input.input.input-sm', { type: 'number', step: KEY_STEP[p], value: String(r3(v)), disabled: locked || !inside, 'aria-label': KEY_LABEL[p] });
      inp.addEventListener('change', () => {
        const n = Number(inp.value);
        if (!Number.isFinite(n)) return;
        // no keys yet: the value holds for the whole clip; with keys, it becomes a keyframe here
        if (!list.length) edit({ op: 'key', clip: id, prop: p, t: 0, value: n });
        else edit({ op: 'key', clip: id, prop: p, t: u, value: n, ease: 'inOut' });
      });
      return h(
        'div.ins-key' + (here ? '.is-here' : ''),
        h('span.ins-label', KEY_LABEL[p]),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Previous keyframe', disabled: !prevK, onclick: () => seek(c.at + prevK[0], { exact: true }) }, icon('prev', 13)),
        h(
          'button.ins-diamond' + (here ? '.is-on' : list.length ? '.is-some' : ''),
          { type: 'button', disabled: locked || !inside, title: here ? 'Remove the keyframe here' : 'Add a keyframe here', 'aria-label': `${here ? 'Remove' : 'Add'} ${KEY_LABEL[p]} keyframe`, onclick: () => edit(here ? { op: 'unkey', clip: id, prop: p, t: u } : { op: 'key', clip: id, prop: p, t: u, value: r3(v), ease: 'inOut' }) },
          icon('key', 13),
        ),
        h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Next keyframe', disabled: !nextK, onclick: () => seek(c.at + nextK[0], { exact: true }) }, icon('next', 13)),
        inp,
      );
    });
    out.append(sec('Motion', inside ? null : h('p.small.muted', 'Move the playhead into the clip to set keyframes.'), ...rows));
  }

  // sound
  if (tr.kind === 'video' || tr.kind === 'audio') {
    out.append(
      sec(
        'Sound',
        h(
          'div.ins-row',
          // the volume is also an element prop (shown above the inspector) when the clip is on the frame
          el?.props?.gain || Object.values(el?.props || {}).some((p) => /\.gain$/.test(p.path || '')) ? null : num('Volume', c.gain, 0.05, 0, 2, (v) => set('gain', r3(v))),
          num('Fade in', c.fadeIn, 0.1, 0, c.dur, (v) => set('fadeIn', r3(v)), 's'),
          num('Fade out', c.fadeOut, 0.1, 0, c.dur, (v) => set('fadeOut', r3(v)), 's'),
        ),
      ),
    );
  }

  // look and framing (video)
  if (tr.kind === 'video') {
    const look = c.look || {};
    const slider = (k, label) => {
      const inp = h('input', { type: 'range', min: -1, max: 1, step: 0.05, value: String(look[k] || 0), disabled: locked, 'aria-label': label });
      inp.addEventListener('input', () => set('look', { ...look, [k]: Number(inp.value) }, `look:${id}`));
      return h('label.ins-slider', h('span.ins-label', label), inp);
    };
    const fit = h('select.input.input-sm', { 'aria-label': 'Fit', disabled: locked }, h('option', { value: 'cover', selected: c.fit === 'cover' }, 'Fill the frame'), h('option', { value: 'contain', selected: c.fit === 'contain' }, 'Show it all'));
    fit.addEventListener('change', () => set('fit', fit.value));
    out.append(sec('Look', slider('brightness', 'Brightness'), slider('contrast', 'Contrast'), slider('saturation', 'Saturation'), slider('warmth', 'Warmth'), h('div.ins-row', h('span.ins-label', 'Fit'), fit)));
  }

  // text style (the words, colour, size, font and animation are the element's props above)
  if (tr.kind === 'graphics' && c.type === 'text') {
    const s = c.style;
    const style = (k, v) => set('style', { ...(rawClip(id)?.style || {}), [k]: v }, `style:${id}:${k}`);
    const weight = h('select.input.input-sm', { 'aria-label': 'Weight', disabled: locked }, [400, 500, 600, 700, 800].map((w) => h('option', { value: w, selected: s.weight === w }, String(w))));
    weight.addEventListener('change', () => style('weight', Number(weight.value)));
    const align = h('select.input.input-sm', { 'aria-label': 'Align', disabled: locked }, ['left', 'center', 'right'].map((a) => h('option', { value: a, selected: s.align === a }, a)));
    align.addEventListener('change', () => style('align', align.value));
    const bg = h('input', { type: 'checkbox', checked: !!s.bg, disabled: locked, 'aria-label': 'Background box' });
    bg.addEventListener('change', () => style('bg', bg.checked ? '#000000aa' : null));
    const shadow = h('input', { type: 'checkbox', checked: s.shadow, disabled: locked, 'aria-label': 'Shadow' });
    shadow.addEventListener('change', () => style('shadow', shadow.checked));
    out.append(sec('Style', h('div.ins-row', h('span.ins-label', 'Weight'), weight, h('span.ins-label', 'Align'), align), h('div.ins-row', h('label.ins-check', bg, 'Box behind'), h('label.ins-check', shadow, 'Shadow'))));
  }
  if (tr.kind === 'graphics' && c.type === 'shape') {
    const shape = h('select.input.input-sm', { 'aria-label': 'Shape', disabled: locked }, h('option', { value: 'rect', selected: c.shape === 'rect' }, 'Rectangle'), h('option', { value: 'ellipse', selected: c.shape === 'ellipse' }, 'Ellipse'));
    shape.addEventListener('change', () => set('shape', shape.value));
    out.append(sec('Shape', h('div.ins-row', shape)));
  }

  // scene shots
  if (tr.kind === 'scene') {
    const spec = model().scenes[c.scene];
    if (spec) {
      const want = new Set(c.shots);
      const boxes = spec.shots.map((s) => {
        const cb = h('input', { type: 'checkbox', checked: want.has(s.id), disabled: locked });
        cb.addEventListener('change', () => {
          const next = spec.shots.filter((x) => (x.id === s.id ? cb.checked : want.has(x.id))).map((x) => x.id);
          if (!next.length) return render();
          edit((raw, scenes) => {
            let r = applyOps(raw, { op: 'set', clip: id, key: 'shots', value: next }, opts());
            const n = normTimeline(r, { scenes });
            const nc = findClip(n, id).clip;
            // the clip takes the length of its shots
            r = applyOps(r, { op: 'trim', clip: id, edge: 'end', t: r3(nc.at + spec.shots.filter((x) => next.includes(x.id)).reduce((a, x) => a + x.dur, 0) - nc.in) }, opts());
            return { raw: r, scenes };
          });
        });
        return h('label.ins-check', cb, `${s.name} `, h('span.small.muted', `${s.dur}s`));
      });
      out.append(sec('Shots', ...boxes));
    }
  }

  out.append(
    h(
      'div.ins-actions',
      h('button.btn.btn-sm', { type: 'button', disabled: locked || !(currentTime() > c.at + 0.05 && currentTime() < c.end - 0.05), onclick: splitAt }, icon('split', 14), 'Split here'),
      h('button.btn.btn-sm', { type: 'button', disabled: locked, onclick: duplicateSel }, icon('copy', 14), 'Duplicate'),
      h('button.btn.btn-sm.btn-danger', { type: 'button', disabled: locked, onclick: () => removeSel(false) }, icon('trash', 14), 'Delete'),
    ),
  );
  return out;
}

function rawClip(id) {
  for (const t of ED.raw.tracks || []) for (const c of t.clips || []) if (c.id === id) return c;
  return null;
}

/** For other modules: the editor is on, and its model. */
export const tracksOn = () => ED.active;
export const timelineModel = () => (ED.active && ED.raw ? model() : null);
export { PRESETS, FONTS };
