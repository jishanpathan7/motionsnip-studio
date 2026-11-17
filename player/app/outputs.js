// Outputs: the master and the versions made from it (cutdowns now; language versions later).
// The bar above the frame switches between them, makes a cutdown, re-renders one, and edits a reframe's
// crop: on the master, a window the shape of the output follows the keys; drag it to set the crop here.

import { store, bus, setOutput, currentOutput, masterAudio } from './state.js';
import { PRESETS, normOutputs, centreAt, cropRectPct, cropSize, autoReframe, normKeys } from './reel.mjs';
import { currentTime, seek, pause } from './video.js';
import { renderSafe, SAFE_KINDS } from './safearea.js';

const PLATFORM_KINDS = ['reels', 'tiktok', 'shorts'];
import { h, icon, api, toast, fmtTime, clamp } from './util.js';

const ui = {};
const job = { state: 'idle', id: null, pct: 0, timer: null };
let rf = null; // reframe editing: { id, keys, mode, zoom, dirty }
let safeKind = 'off';
let menuOpen = false;

/** A short signature of the outputs list, to notice when it changes on disk. */
export function outputsSig(reel) {
  const list = reel === store.master ? reel.outputs : normOutputs(reel?.outputs, store.master);
  return list.map((o) => [o.id, o.version, o.src, o.kind, o.label].join(':')).join('|');
}

export function initOutputs(bar, frame) {
  ui.bar = bar;
  ui.frame = frame;
  ui.safe = h('div.safe-layer', { 'aria-hidden': 'true' });
  ui.rfLayer = h('div.rf-layer', { hidden: true });
  ui.rfWin = h('div.rf-win', h('span.rf-label'));
  ui.rfLayer.append(ui.rfWin);
  frame.append(ui.safe, ui.rfLayer);
  wireCropDrag();
  bus.on('reel', render);
  bus.on('outputs', render);
  bus.on('time', ({ t }) => rf && placeWindow(t));
  bus.on('fullscreen', () => renderSafe(ui.safe, safeKind));
  new ResizeObserver(() => renderSafe(ui.safe, safeKind)).observe(frame);
  document.addEventListener('pointerdown', (e) => {
    if (menuOpen && !e.target.closest('.out-add')) toggleMenu(false);
  });
  checkJob();
  render();
}

/** Switch to an output (or 'master'): at time `t` on its clock if given, else the moment on screen now. */
export function goToOutput(id, t = null) {
  if (rf && id !== 'master') endReframe(false);
  const at = setOutput(id, t ?? currentTime());
  if (store.out !== 'master' && safeKind === 'off') safeKind = defaultSafe(currentOutput());
  else if (store.out === 'master' && PLATFORM_KINDS.includes(safeKind)) safeKind = 'off'; // phone UI guides belong on a vertical version
  bus.emit('output', { t: Number.isFinite(t) ? clamp(t, 0, store.reel.duration || t) : at });
}

function defaultSafe(o) {
  if (!o) return 'off';
  if (o.h > o.w) return o.platform === 'tiktok' ? 'tiktok' : o.platform === 'shorts' ? 'shorts' : 'reels';
  return 'title';
}

// ---------------------------------------------------------------- the bar

function render() {
  if (!ui.bar || !store.master) return;
  const m = store.master;
  const tab = (id, label, title, extra = null) =>
    h(
      'button.out-tab' + (store.out === id ? '.is-on' : ''),
      { type: 'button', role: 'tab', 'aria-selected': store.out === id ? 'true' : 'false', title, onclick: () => store.out !== id && goToOutput(id) },
      h('span', label),
      extra,
    );
  const tabs = [tab('master', 'Master', `The master, ${m.w}×${m.h}`)];
  for (const o of m.outputs) {
    const stale = o.by === 'player' && o.from && o.from < m.version;
    const running = job.state === 'running' && job.id === o.id;
    tabs.push(
      tab(
        o.id,
        o.label,
        `${o.label} · ${o.w}×${o.h} · ${fmtTime(o.duration)}${o.by === 'player' ? ' · made here' : ''}${stale ? ` · made from v${o.from}, re-render for v${m.version}` : ''}`,
        running ? h('span.out-pct.mono', `${Math.round(job.pct)}%`) : stale ? h('span.out-stale', { title: 'Made from an older version' }) : null,
      ),
    );
  }
  if (job.state === 'running' && !m.outputs.some((o) => o.id === job.id)) tabs.push(h('span.out-tab.is-pending', h('span', PRESETS[job.id]?.label || job.id), h('span.out-pct.mono', `${Math.round(job.pct)}%`)));

  const menu = h(
    'div.out-menu',
    { hidden: !menuOpen, role: 'menu' },
    Object.entries(PRESETS)
      .filter(([, p]) => p.kind !== 'reframe' || Math.abs(p.w / p.h - m.w / m.h) > 0.01) // not the master's own shape
      .map(([id, p]) => {
      const have = m.outputs.find((o) => o.id === id);
      return h(
        'button.out-menu-item',
        { type: 'button', role: 'menuitem', disabled: job.state === 'running' || have?.by === 'reel', onclick: () => (toggleMenu(false), makeCutdown(id)) },
        h('b', p.label),
        h('span.small.muted', have?.by === 'reel' ? 'Claude made this one' : have ? 'Make it again' : p.hint),
      );
    }),
    plainNote(),
  );
  ui.addBtn = h(
    'button.btn.btn-ghost.btn-sm.out-add-btn',
    { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false', onclick: () => toggleMenu(), disabled: !m.src },
    icon('plus', 14),
    'Cutdown',
  );

  const o = currentOutput();
  const acts = [];
  if (o && o.by === 'player') {
    if (o.kind === 'reframe') acts.push(h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => startReframe(o.id), title: 'Set the crop on the master' }, icon('crop', 14), 'Reframe'));
    acts.push(h('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: job.state === 'running', onclick: () => makeCutdown(o.id), title: 'Render it again from the current master' }, 'Re-render'));
    acts.push(h('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: job.state === 'running', onclick: () => removeOutput(o.id), title: 'Remove this cutdown' }, icon('trash', 14)));
  }

  const safe = h(
    'label.out-safe',
    { title: 'Safe areas' },
    icon('safe', 15),
    h(
      'select',
      { 'aria-label': 'Safe areas', onchange: (e) => setSafe(e.target.value) },
      SAFE_KINDS.map(([v, label]) => h('option', { value: v, selected: v === safeKind }, label)),
    ),
  );

  ui.bar.replaceChildren(
    h('div.out-tabs', { role: 'tablist', 'aria-label': 'Versions' }, tabs, h('div.out-add', ui.addBtn, menu)),
    h('div.spacer'),
    ...acts,
    safe,
  );
  renderRfBar();
  renderSafe(ui.safe, safeKind);
}

function plainNote() {
  return store.master.plain ? h('p.out-menu-note.small.muted', 'Cutdowns use the video as it is on disk; export your edits first to include them.') : null;
}

function toggleMenu(force) {
  menuOpen = typeof force === 'boolean' ? force : !menuOpen;
  render();
}

function setSafe(v) {
  safeKind = SAFE_KINDS.some(([k]) => k === v) ? v : 'off';
  renderSafe(ui.safe, safeKind);
}

// ---------------------------------------------------------------- rendering cutdowns

async function makeCutdown(id, extra = {}) {
  if (job.state === 'running') return;
  const a = masterAudio();
  const body = {
    id,
    ...extra,
    music: a.music,
    musicVol: a.musicVol,
    sfxVol: a.sfxVol,
    musicOffset: a.musicOffset,
    musicFade: a.musicFade,
  };
  try {
    const r = await api('/api/cutdown', { json: body });
    Object.assign(job, r, { id });
    if (job.state === 'error') toast(job.line || "Couldn't make the cutdown.", { kind: 'error', ms: 7000 });
  } catch (e) {
    toast(`Couldn't make the cutdown: ${e.message}`, { kind: 'error', ms: 7000 });
    return;
  }
  render();
  checkJob();
}

async function checkJob() {
  clearTimeout(job.timer);
  let r;
  try {
    r = await api('/api/cutdown');
  } catch {
    return;
  }
  const was = job.state;
  Object.assign(job, r);
  if (job.state === 'running') {
    job.timer = setTimeout(checkJob, 500);
  } else if (was === 'running') {
    if (job.state === 'done') {
      toast(`${job.label || 'Cutdown'} is ready`);
      await refreshReel(job.id);
    } else if (job.state === 'error') toast(job.line || 'The cutdown failed.', { kind: 'error', ms: 8000 });
  }
  render();
}

/** Fetch the reel now (instead of waiting for the poll) and show `showId` if given. */
async function refreshReel(showId) {
  try {
    const raw = await api('/api/reel');
    bus.emit('outputs-raw', { raw });
    if (showId && store.out !== showId && store.master.outputs.some((o) => o.id === showId)) goToOutput(showId);
  } catch {
    /* the poll catches up */
  }
}

async function removeOutput(id) {
  const o = store.master.outputs.find((x) => x.id === id);
  if (!o || !confirm(`Remove the ${o.label} cutdown? Its video file is deleted too.`)) return;
  try {
    await api('/api/cutdown-remove', { json: { id } });
  } catch (e) {
    toast(`Couldn't remove it: ${e.message}`, { kind: 'error' });
    return;
  }
  goToOutput('master');
  refreshReel(null);
}

// ---------------------------------------------------------------- reframe editing (on the master)

function startReframe(id) {
  const o = store.master.outputs.find((x) => x.id === id);
  if (!o) return;
  rf = { id, keys: o.keys.map((k) => ({ ...k })), mode: o.mode, zoom: o.zoom, dirty: false, label: o.label };
  const t = currentTime();
  goToOutput('master', t);
  ui.rfLayer.hidden = false;
  placeWindow(t);
  render();
}

function endReframe(rerender = true) {
  rf = null;
  ui.rfLayer.hidden = true;
  if (rerender) render();
}

function rfOutput() {
  const o = store.master.outputs.find((x) => x.id === rf?.id);
  return o ? { ...o, keys: rf.keys, mode: rf.mode, zoom: rf.zoom } : null;
}

function placeWindow(t) {
  const o = rfOutput();
  if (!o || store.out !== 'master') {
    ui.rfLayer.hidden = true;
    return;
  }
  ui.rfLayer.hidden = false;
  const [x, y, w, hh] = cropRectPct(store.master, o, t);
  Object.assign(ui.rfWin.style, { left: x + '%', top: y + '%', width: w + '%', height: hh + '%' });
  ui.rfWin.classList.toggle('is-key', rf.keys.some((k) => Math.abs(k.t - t) < 0.02));
  ui.rfWin.querySelector('.rf-label').textContent = rf.mode === 'blurpad' ? `${o.label} · whole frame on a blurred fill` : `${o.label} crop`;
  ui.rfWin.classList.toggle('is-pad', rf.mode === 'blurpad');
}

function setKey(t, cx, cy) {
  const near = rf.keys.find((k) => Math.abs(k.t - t) < 0.05);
  if (near) Object.assign(near, { cx, cy });
  else rf.keys.push({ t, cx, cy });
  rf.keys = normKeys(rf.keys);
  rf.dirty = true;
}

function wireCropDrag() {
  let drag = null;
  ui.rfWin.addEventListener('pointerdown', (e) => {
    if (!rf || rf.mode === 'blurpad' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pause();
    const fr = ui.frame.getBoundingClientRect();
    const t = currentTime();
    const c = centreAt(rf.keys, t);
    drag = { x: e.clientX, y: e.clientY, cx: c.cx, cy: c.cy, fr, t };
    ui.rfWin.setPointerCapture(e.pointerId);
    ui.rfWin.classList.add('is-drag');
  });
  ui.rfWin.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const o = rfOutput();
    const { cw, ch } = cropSize(store.master.w, store.master.h, o.w, o.h, o.zoom);
    const wp = (cw / store.master.w) * 100;
    const hp = (ch / store.master.h) * 100;
    const cx = clamp(drag.cx + ((e.clientX - drag.x) / drag.fr.width) * 100, wp / 2, 100 - wp / 2);
    const cy = clamp(drag.cy + ((e.clientY - drag.y) / drag.fr.height) * 100, hp / 2, 100 - hp / 2);
    setKey(drag.t, cx, cy);
    placeWindow(drag.t);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    ui.rfWin.classList.remove('is-drag');
    renderRfBar();
  };
  ui.rfWin.addEventListener('pointerup', end);
  ui.rfWin.addEventListener('pointercancel', end);
  // keep the frame's own click handling (select, notes) from seeing reframe clicks
  ui.rfLayer.addEventListener('pointerdown', (e) => e.stopPropagation());
  ui.rfLayer.addEventListener('contextmenu', (e) => e.stopPropagation());
}

function renderRfBar() {
  ui.rfBar?.remove();
  ui.rfBar = null;
  if (!rf || store.out !== 'master') return;
  const keys = rf.keys.map((k) =>
    h(
      'span.rf-key',
      h('button.pill.mono', { type: 'button', title: `Go to ${fmtTime(k.t)}`, onclick: () => seek(k.t) }, fmtTime(k.t)),
      h(
        'button.rf-key-x',
        {
          type: 'button',
          'aria-label': `Remove the key at ${fmtTime(k.t)}`,
          onclick: () => {
            rf.keys = rf.keys.filter((x) => x !== k);
            rf.dirty = true;
            placeWindow(currentTime());
            renderRfBar();
          },
        },
        '×',
      ),
    ),
  );
  const mode = h(
    'div.seg',
    { role: 'radiogroup', 'aria-label': 'Fit' },
    [
      ['crop', 'Crop'],
      ['blurpad', 'Whole frame'],
    ].map(([v, l]) =>
      h(
        'button.seg-btn' + (rf.mode === v ? '.is-on' : ''),
        {
          type: 'button',
          role: 'radio',
          'aria-checked': rf.mode === v ? 'true' : 'false',
          onclick: () => {
            rf.mode = v;
            rf.dirty = true;
            placeWindow(currentTime());
            renderRfBar();
          },
        },
        l,
      ),
    ),
  );
  const zoom = h('input.range.rf-zoom', { type: 'range', min: 1, max: 2, step: 0.05, value: String(rf.zoom), 'aria-label': 'Zoom', disabled: rf.mode === 'blurpad' });
  zoom.addEventListener('input', () => {
    rf.zoom = +zoom.value;
    rf.dirty = true;
    placeWindow(currentTime());
  });
  ui.rfBar = h(
    'div.rf-bar',
    h('b', `Reframe ${rf.label}`),
    h('span.small.muted', rf.mode === 'blurpad' ? 'The whole frame, centred on a blurred fill.' : 'Drag the window to set the crop at this moment. Between keys it glides; at a cut, add a key on each side.'),
    mode,
    h('label.rf-zoom-l.small', 'Zoom', zoom),
    h('div.rf-keys', keys.length ? keys : h('span.small.muted', 'No keys: centred')),
    h(
      'button.btn.btn-ghost.btn-sm',
      {
        type: 'button',
        title: 'Guess from the elements in each scene',
        onclick: () => {
          const o = rfOutput();
          const a = autoReframe(store.master, o.w, o.h, rf.zoom);
          rf.keys = a.keys;
          rf.mode = a.mode;
          rf.dirty = true;
          placeWindow(currentTime());
          renderRfBar();
        },
      },
      'Auto',
    ),
    h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => endReframe() }, 'Cancel'),
    h(
      'button.btn.btn-sm.btn-tape',
      {
        type: 'button',
        disabled: job.state === 'running',
        onclick: () => {
          const { id, keys, mode, zoom: z } = rf;
          endReframe(false);
          makeCutdown(id, { keys, mode, zoom: z });
          goToOutput(id);
        },
      },
      'Render',
    ),
  );
  ui.bar.after(ui.rfBar);
}

