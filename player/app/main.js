// MotionSnip Studio player: boots the page, builds the header/transport, polls for new versions.

import {
  store,
  bus,
  setReel,
  loadSaved,
  adoptNewReel,
  persist,
  select,
  setTab,
  approvedCount,
  sceneStatus,
  sceneAt,
  getEl,
  allNotes,
  unsentChanges,
  setReel as setReelRaw,
} from './state.js';
import {
  player,
  initPlayback,
  loadReel,
  toggle,
  stepFrames,
  seek,
  duration,
  frameOf,
  currentTime,
  setRate,
  setLoop,
  setMuted,
  setCompare,
  isPlaying,
  reloadLiveTimeline,
} from './video.js';
import { initTimeline, loadTimeline } from './timeline.js';
import { tracksOn } from './tracks.js';
import { initOverlay, render as renderOverlay, flashCue } from './overlay.js';
import { initPanel, render as renderPanel, uploadAudio, focusSend } from './panel.js';
import { startCheck, sendableCount, checkSummary } from './feedback.js';
import { initExport, updateButton as updateExportButton } from './export.js';
import { initFavicon, setFavicon } from './favicon.js';
import { initKeys, toggleSheet } from './keys.js';
import { initVedit, hint as plainHint, addLogoFile } from './vedit.js';
import { initOutputs, outputsSig } from './outputs.js';
import { h, icon, api, fmtTime, toast, debounce, clamp, prefersReducedMotion } from './util.js';

const ui = {};
let readyUntilFocus = false;
let arrival = null; // { version, text, until }
let hintOverride = null;
let serverDown = false;

// ---------------------------------------------------------------- theme

const THEME_KEY = 'motionsnip:theme';

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(mode, save = true) {
  if (!['system', 'light', 'dark'].includes(mode)) mode = 'system';
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  root.dataset.themeMode = mode;
  if (save) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* ignore */
    }
  }
  for (const b of ui.theme?.querySelectorAll('button') || []) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  bus.emit('theme', { mode });
}

// ---------------------------------------------------------------- DOM

function build() {
  const app = document.getElementById('app');

  // header
  ui.logo = h(
    'a.logo',
    { href: '#', title: 'MotionSnip Studio', 'aria-label': 'MotionSnip Studio', onclick: (e) => e.preventDefault() },
    h('img.logo-img.logo-on-dark', { src: '/app/brand/logo-dark.svg', alt: 'MotionSnip Studio', width: 140, height: 23 }),
    h('img.logo-img.logo-on-light', { src: '/app/brand/logo-light.svg', alt: '', 'aria-hidden': 'true', width: 140, height: 23 }),
  );
  ui.title = h('span.proj-title');
  ui.version = h('span.proj-version.mono', { 'aria-live': 'polite' });
  ui.approvals = h('button.approvals', { type: 'button', title: 'Go to the next scene to review', onclick: nextToReview });
  ui.pill = h('span.state-pill', { hidden: true, role: 'status' });
  ui.theme = h(
    'div.seg.theme-switch',
    { role: 'radiogroup', 'aria-label': 'Theme' },
    [
      ['system', 'System', 'system'],
      ['light', 'Light', 'sun'],
      ['dark', 'Dark', 'moon'],
    ].map(([mode, label, ic]) =>
      h('button.seg-btn', { type: 'button', role: 'radio', dataset: { mode }, title: label, 'aria-label': label, onclick: () => applyTheme(mode) }, icon(ic, 16)),
    ),
  );
  ui.keysBtn = h('button.btn.btn-ghost.btn-icon', { type: 'button', title: 'Shortcuts (?)', 'aria-label': 'Shortcuts', onclick: () => toggleSheet() }, icon('keys', 18));
  ui.exportBtn = h('button.btn', { type: 'button' }, icon('export', 16), h('span.btn-label', 'Export'));
  ui.sendCount = h('span.send-count', { hidden: true });
  ui.sendBtn = h('button.btn.btn-tape.header-send', { type: 'button', onclick: focusSend }, icon('send', 16), h('span', 'Send to Claude'), ui.sendCount);
  const header = h(
    'header.top',
    ui.logo,
    h('div.proj', ui.title, ui.version),
    ui.approvals,
    ui.pill,
    h('div.spacer'),
    ui.theme,
    ui.keysBtn,
    ui.exportBtn,
    ui.sendBtn,
  );

  // frame
  ui.video = h('video.main-video', { playsInline: true, preload: 'auto' });
  ui.music = h('audio', { preload: 'auto' });
  ui.cmp = h('video.cmp-video', { playsInline: true, preload: 'auto', muted: true });
  ui.cmp.muted = true;
  ui.liveHost = h('div.live-host');
  ui.frameMsg = h('div.frame-msg', { hidden: true });
  ui.cmpBadge = h('span.cmp-badge', { hidden: true });
  ui.frame = h('div.frame', ui.video, ui.liveHost, ui.cmp, ui.frameMsg, ui.cmpBadge);
  ui.stage = h('div.stage', ui.frame);

  // transport
  ui.playBtn = h('button.tbtn.tbtn-play', { type: 'button', title: 'Play (Space)', 'aria-label': 'Play', onclick: toggle }, icon('play', 20));
  const back = h('button.tbtn', { type: 'button', title: 'One frame back (←)', 'aria-label': 'One frame back', onclick: () => stepFrames(-1) }, icon('prev', 18));
  const fwd = h('button.tbtn', { type: 'button', title: 'One frame forward (→)', 'aria-label': 'One frame forward', onclick: () => stepFrames(1) }, icon('next', 18));
  ui.tc = h('span.tc-now');
  ui.tcFrame = h('span.tc-frame');
  ui.tcDur = h('span.tc-dur');
  const tc = h('div.timecode.mono', { title: 'Time and frame number' }, ui.tc, ' ', ui.tcFrame, h('span.tc-sep', ' / '), ui.tcDur);
  ui.speedBtn = h('button.pill.speed-pill.mono', { type: 'button', title: 'Speed (< >)', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: toggleSpeed }, '1×');
  ui.speedRange = h('input.range', { type: 'range', min: 0.25, max: 2, step: 0.25, value: '1', 'aria-label': 'Speed' });
  ui.speedRange.addEventListener('input', () => setRate(+ui.speedRange.value));
  ui.speedPop = h(
    'div.speed-pop',
    { hidden: true },
    ui.speedRange,
    h(
      'div.speed-presets',
      [
        [0.5, '½'],
        [1, '1'],
        [1.5, '1.5'],
        [2, '2'],
      ].map(([v, l]) => h('button.pill.mono', { type: 'button', onclick: () => setRate(v) }, l + '×')),
    ),
  );
  ui.loopBtn = h('button.tbtn', { type: 'button', title: 'Loop this scene (L)', 'aria-label': 'Loop this scene', 'aria-pressed': 'false', onclick: () => setLoop(!player.loopScene) }, icon('loop', 18));
  ui.muteBtn = h('button.tbtn', { type: 'button', title: 'Mute (M)', 'aria-label': 'Mute', 'aria-pressed': 'false', onclick: () => setMuted(!player.muted) }, icon('volume', 18));
  ui.cmpBtn = h('button.tbtn', { type: 'button', title: 'Hold to see the previous version (hold V)', 'aria-label': 'Compare with the previous version' }, icon('compare', 18));
  const cmpOff = () => setCompare(false);
  ui.cmpBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ui.cmpBtn.setPointerCapture(e.pointerId);
    setCompare(true);
  });
  ui.cmpBtn.addEventListener('pointerup', cmpOff);
  ui.cmpBtn.addEventListener('pointercancel', cmpOff);
  ui.cmpBtn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      setCompare(true);
    }
  });
  ui.cmpBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') cmpOff();
  });
  ui.fullBtn = h('button.tbtn', { type: 'button', title: 'Fullscreen (F)', 'aria-label': 'Fullscreen', onclick: toggleFullscreen }, icon('full', 18));
  const transport = h(
    'div.transport',
    h('div.t-group', ui.playBtn, back, fwd),
    tc,
    h('div.t-speed', ui.speedBtn, ui.speedPop),
    h('div.spacer'),
    h('div.t-group', ui.loopBtn, ui.muteBtn, ui.cmpBtn, ui.fullBtn),
  );

  ui.timeline = h('div.timeline');
  ui.hint = h('p.hint', { 'aria-live': 'polite' });

  ui.panel = h('aside.panel', { 'aria-label': 'Edit panel' });
  ui.drop = h(
    'div.drop-zone',
    { hidden: true },
    store.reel?.plain
      ? h('div.drop-card', icon('music', 28), h('b', 'Drop music, or a logo'), h('span.small', 'mp3, wav or m4a · png, jpg or webp'))
      : h('div.drop-card', icon('music', 28), h('b', 'Drop to use as music'), h('span.small', 'mp3, wav or m4a')),
  );

  ui.outBar = h('div.out-bar');
  const left = h('section.left', h('div.out-wrap', ui.outBar), ui.stage, transport, ui.timeline, ui.hint);
  const layout = h('main.layout', left, ui.panel);
  app.replaceChildren(header, layout, ui.drop, ui.music);

  new ResizeObserver(fitFrame).observe(ui.stage);

  document.addEventListener('pointerdown', (e) => {
    if (!ui.speedPop.hidden && !e.target.closest('.t-speed')) toggleSpeed(false);
  });
}

function fitFrame() {
  if (!store.reel) return;
  const r = ui.stage.getBoundingClientRect();
  const ar = store.reel.w / store.reel.h || 16 / 9;
  let w = r.width;
  let hh = w / ar;
  if (hh > r.height) {
    hh = r.height;
    w = hh * ar;
  }
  ui.frame.style.width = Math.max(0, Math.floor(w)) + 'px';
  ui.frame.style.height = Math.max(0, Math.floor(hh)) + 'px';
}

function toggleSpeed(force) {
  const open = typeof force === 'boolean' ? force : ui.speedPop.hidden;
  ui.speedPop.hidden = !open;
  ui.speedBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else ui.stage.requestFullscreen?.().catch(() => toast("Fullscreen isn't available here."));
}

function nextToReview() {
  const sc = store.reel.scenes;
  if (!sc.length) return;
  const cur = sc.indexOf(sceneAt(currentTime()));
  for (let k = 1; k <= sc.length; k++) {
    const s = sc[(cur + k) % sc.length];
    if (sceneStatus(s.id) !== 'approved') {
      seek(s.t[0]);
      select(null);
      setTab('edit');
      return;
    }
  }
  toast('Every scene is approved.');
}

// ---------------------------------------------------------------- header state

function updateHeader() {
  const reel = store.master;
  if (!reel) return;
  ui.title.textContent = reel.title;
  ui.title.title = reel.path || reel.title;
  document.title = `${reel.title} v${reel.version} · MotionSnip Studio`;
  if (ui.version.dataset.v !== String(reel.version)) {
    const old = ui.version.dataset.v;
    ui.version.dataset.v = String(reel.version);
    if (old && !prefersReducedMotion()) {
      ui.version.replaceChildren(h('span.ver-old', 'v' + old), h('span.ver-new', 'v' + reel.version));
      ui.version.classList.remove('roll');
      void ui.version.offsetWidth;
      ui.version.classList.add('roll');
    } else ui.version.replaceChildren(h('span.ver-new', 'v' + reel.version));
  }
  const n = reel.scenes.length;
  const a = approvedCount();
  ui.approvals.textContent = `${a} of ${n} approved`;
  ui.approvals.classList.toggle('all', n > 0 && a === n);
  ui.approvals.hidden = !n;

  const pend = store.data.pending;
  let pill = '';
  let cls = '';
  if (serverDown) {
    pill = "Can't reach the player server";
    cls = 'bad';
  } else if (pend) {
    pill = `Waiting for v${pend.version + 1}`;
    cls = 'waiting';
  } else if (arrival && arrival.until > Date.now()) {
    pill = arrival.text;
    cls = 'arrived';
  }
  ui.pill.hidden = !pill;
  ui.pill.className = 'state-pill' + (cls ? ' is-' + cls : '');
  ui.pill.replaceChildren(cls === 'waiting' ? h('span.sweep', { 'aria-hidden': 'true' }) : cls === 'arrived' ? h('span.cue-dot-inline', { 'aria-hidden': 'true' }) : '', pill);

  const cnt = sendableCount();
  ui.sendCount.hidden = !cnt;
  ui.sendCount.textContent = String(cnt);
  ui.sendBtn.classList.toggle('is-waiting', !!pend && !cnt);
  updateExportButton();
  updateFav();
}

function updateFav() {
  if (readyUntilFocus) return setFavicon('ready');
  if (store.data.pending) return setFavicon('working');
  if (allNotes().some((n) => !n.sent)) return setFavicon('notes');
  setFavicon('idle');
}

// ---------------------------------------------------------------- transport state

function updateTime(t) {
  const f = frameOf(t);
  const fps = store.reel.fps;
  ui.tc.textContent = fmtTime(f / fps);
  ui.tcFrame.textContent = 'f' + f;
  const d = fmtTime(duration());
  if (ui.tcDur.textContent !== d) ui.tcDur.textContent = d;
}

function updatePlay() {
  const p = isPlaying();
  ui.playBtn.replaceChildren(icon(p ? 'pause' : 'play', 20));
  ui.playBtn.title = p ? 'Pause (Space)' : 'Play (Space)';
  ui.playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', p);
}

// ---------------------------------------------------------------- hint line

function hintText() {
  if (hintOverride) return hintOverride;
  const reel = store.reel;
  if (!reel) return '';
  if (store.ui.editingText) return 'Type the new words · Enter saves · Esc cancels';
  if (store.ui.noteOpen) return 'Say what should change here · Enter saves · Esc closes';
  if (store.ui.compare) return `Showing v${player.prevTake?.version} at this frame · let go to come back`;
  const ph = plainHint();
  if (ph) return ph;
  if (isPlaying()) return 'Space pauses · click anything on the frame to stop and select it · right-click to circle a problem';
  const sel = store.ui.selected && getEl(store.ui.selected);
  if (sel) {
    const t = currentTime();
    if (t < sel.t[0] || t > sel.t[1]) return `${sel.label} isn't on screen now · Show it from Edit, or Esc to deselect`;
    if (!sel.box) return `${sel.label} has no box on the frame · change it in Edit · Esc deselects`;
    return `${sel.label}: double-click or Enter to type · drag to move · drag a corner to resize · C to circle · Esc deselects`;
  }
  const cs = checkSummary();
  if (cs && cs.open) return `Check v${store.data.check.to}: Show me jumps to each change · mark it Looks right or Not quite`;
  if (store.data.pending) return `Waiting for v${store.data.pending.version + 1} · keep watching; anything new goes in the next round`;
  const n = unsentChanges().length;
  if (n) return `${n} change${n === 1 ? '' : 's'} ready · Send to Claude when you're done · ⌘Z undoes`;
  return 'Space plays · click something on the frame to change it · right-click to circle a problem · ? for shortcuts';
}

const updateHint = () => {
  ui.hint.textContent = hintText();
};

// ---------------------------------------------------------------- deep links

function parseHash() {
  const out = {};
  const s = location.hash.replace(/^#/, '');
  for (const part of s.split('&')) {
    const [k, v] = part.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

function applyHash(first = false) {
  const p = parseHash();
  const tabs = store.reel.plain ? ['edit', 'sound', 'changes'] : ['edit', 'script', 'look', 'sound', 'changes'];
  if (p.tab && tabs.includes(p.tab)) setTab(p.tab);
  if (p.el && getEl(p.el)) {
    const el = getEl(p.el);
    if (!p.t) seek(el.t[0] + Math.min(0.4, (el.t[1] - el.t[0]) / 2));
    select(p.el);
    if (!p.tab) setTab('edit');
  }
  if (p.t && Number.isFinite(parseFloat(p.t)) && !first) seek(parseFloat(p.t));
  return p;
}

const writeHash = debounce(() => {
  if (!store.reel || isPlaying()) return;
  const parts = [`t=${Math.round(currentTime() * 100) / 100}`];
  if (store.ui.selected) parts.push(`el=${encodeURIComponent(store.ui.selected)}`);
  if (store.ui.tab !== 'edit') parts.push(`tab=${store.ui.tab}`);
  const next = '#' + parts.join('&');
  if (location.hash !== next) history.replaceState(null, '', location.pathname + location.search + next);
}, 400);

// ---------------------------------------------------------------- versions

async function poll() {
  let raw;
  try {
    raw = await api('/api/reel');
  } catch (e) {
    if (e.status) {
      // reel.json is broken right now (Claude may be mid-write); keep the current one
      if (!poll.warned) {
        poll.warned = true;
        console.warn('[motionsnip] reel.json:', e.message);
      }
      serverDown = false;
    } else serverDown = true;
    updateHeader();
    return;
  }
  poll.warned = false;
  if (serverDown) {
    serverDown = false;
    updateHeader();
  }
  if (!raw || typeof raw !== 'object') return;
  if (raw.id && store.reel && String(raw.id) !== store.reel.id) {
    location.reload();
    return;
  }
  applyRaw(raw);
}

/** Take a reel.json read from the server: a new version, a changed outputs list, or nothing new. */
function applyRaw(raw) {
  if (Number(raw.version) !== store.master.version) newVersion(raw);
  else if (raw.timeline && (raw.rev !== store.master.rev || raw.depsRev !== store.master.depsRev)) timelineChanged(raw);
  else if (outputsSig(raw) !== outputsSig(store.master)) outputsChanged(raw);
}

/** timeline.json (or a scene it uses) changed without a new version: an editor save, or Claude mid-round. */
function timelineChanged(raw) {
  setReelRaw(raw);
  if (store.ui.selected && !getEl(store.ui.selected)) select(null);
  if (!tracksOn()) reloadLiveTimeline(); // the timeline editor reloads the compositor itself, after its own saves
  loadTimeline();
  bus.emit('reel', { same: true });
  renderPanel(true);
  renderOverlay(true);
  updateHeader();
  updateTime(currentTime()); // the length may have changed
  bus.emit('duration', {});
}

/** A cutdown finished or Claude listed a new output: take the new list; reload the video if the one on screen changed. */
function outputsChanged(raw) {
  const before = { out: store.out, src: store.reel.src, version: store.reel.version };
  const t = currentTime();
  setReelRaw(raw);
  bus.emit('outputs', {});
  if (store.out !== before.out) showOutput(0);
  else if (store.reel.src !== before.src || store.reel.version !== before.version) showOutput(Math.min(t, store.reel.duration));
}

/** Show the output store.out points at, at time t (on its clock). */
function showOutput(t) {
  if (store.ui.compare) setCompare(false);
  loadReel({ startAt: t });
  loadTimeline();
  fitFrame();
  bus.emit('reel', {});
  bus.emit('changes', { output: true });
  renderPanel(true);
  renderOverlay(true);
  updateHeader();
  updateHint();
}

function newVersion(raw) {
  const from = store.master.version;
  const sent = adoptNewReel(raw);
  let applied = 0;
  let check = null;
  if (sent.length) {
    check = startCheck(sent, from);
    applied = check ? check.items.filter((x) => x.auto).length : 0;
  } else {
    store.data.pending = null;
    persist();
  }
  if (store.ui.selected && !getEl(store.ui.selected)) select(null);
  loadReel({ keepTime: true });
  loadTimeline();
  fitFrame();
  flashCue();
  const v = store.master.version;
  arrival = {
    version: v,
    text: sent.length ? `v${v} is in · ${applied} of ${check?.items.length ?? sent.length} change${sent.length === 1 ? '' : 's'} applied` : `v${v} is in`,
    until: Date.now() + 12000,
  };
  setTimeout(updateHeader, 12100);
  if (!document.hasFocus()) readyUntilFocus = true;
  if (check) setTab('changes');
  bus.emit('reel', {});
  bus.emit('changes', { reel: true });
  renderPanel(true);
  renderOverlay(true);
  updateHeader();
  updateHint();
}

// ---------------------------------------------------------------- drag and drop

function initDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    ui.drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) ui.drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    ui.drop.hidden = true;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (store.reel?.plain && ['png', 'jpg', 'jpeg', 'webp'].includes(ext)) addLogoFile(f);
    else uploadAudio(f);
  });
}

// ---------------------------------------------------------------- boot

function showFatal(msg) {
  const app = document.getElementById('app');
  app.replaceChildren(
    h(
      'div.fatal',
      h('img', { src: '/app/brand/symbol.svg', alt: '', width: 48, height: 48 }),
      h('h1', "This project can't open yet"),
      h('p', msg),
      h('p.muted.small', 'The page tries again every 2 seconds.'),
    ),
  );
}

async function boot() {
  const qs = new URLSearchParams(location.search);
  const qTheme = qs.get('theme');
  applyTheme(qTheme || storedTheme(), !qTheme);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => bus.emit('theme', {}));

  let raw;
  for (;;) {
    try {
      raw = await api('/api/reel');
      break;
    } catch (e) {
      showFatal(e.status ? e.message : "Can't reach the player server. Is it still running?");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  setReel(raw);
  await loadSaved();
  // a version may have landed while the page was closed
  const pend = store.data.pending;
  let landed = null;
  if (pend && store.master.version > pend.version) {
    const from = pend.version;
    const sent = adoptNewReel(raw);
    landed = sent.length ? startCheck(sent, from) : null;
    store.data.pending = null;
  }
  store.data.seenVersion = store.master.version;
  persist();

  build();
  applyTheme(document.documentElement.dataset.themeMode || 'system', false);
  initFavicon();
  initPlayback({ video: ui.video, music: ui.music, cmp: ui.cmp, liveHost: ui.liveHost, frameMsg: ui.frameMsg });
  initOverlay(ui.frame);
  initTimeline(ui.timeline);
  initVedit(ui.frame);
  initPanel(ui.panel);
  initExport(ui.exportBtn);
  initKeys();
  initDrop();
  initOutputs(ui.outBar, ui.frame);
  bus.on('output', ({ t }) => showOutput(t));
  bus.on('outputs-raw', ({ raw }) => raw && typeof raw === 'object' && applyRaw(raw));

  bus.on('time', ({ t }) => {
    updateTime(t);
    if (store.ui.tab === 'edit' || store.ui.selected) updateHintThrottled();
    writeHash();
  });
  bus.on('play', () => {
    updatePlay();
    updateHint();
    writeHash();
  });
  bus.on('rate', ({ rate }) => {
    ui.speedBtn.textContent = (rate === 0.5 ? '½' : String(rate)) + '×';
    ui.speedRange.value = String(rate);
    ui.speedBtn.classList.toggle('is-on', rate !== 1);
  });
  bus.on('loop', ({ on }) => {
    ui.loopBtn.classList.toggle('is-on', on);
    ui.loopBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  bus.on('mute', ({ on }) => {
    ui.muteBtn.replaceChildren(icon(on ? 'mute' : 'volume', 18));
    ui.muteBtn.classList.toggle('is-on', on);
    ui.muteBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  bus.on('takes', ({ prev }) => {
    ui.cmpBtn.disabled = !prev;
    ui.cmpBtn.title = prev ? `Hold to see v${prev.version} at this frame (hold V)` : 'No earlier version to compare with yet';
  });
  bus.on('compare', ({ on }) => {
    ui.frame.classList.toggle('is-compare', on);
    ui.cmpBadge.hidden = !on;
    ui.cmpBadge.textContent = on ? `v${player.prevTake?.version} · previous` : '';
    ui.cmpBtn.classList.toggle('is-on', on);
    updateHint();
  });
  bus.on('fullscreen', toggleFullscreen);
  bus.on('duration', fitFrame); // a plain video's real size arrives with its metadata
  bus.on('vedit', updateHint);
  bus.on('changes', () => {
    updateHeader();
    updateHint();
  });
  bus.on('status', updateHeader);
  bus.on('select', () => {
    updateHint();
    writeHash();
  });
  bus.on('select-quiet', () => renderOverlay(true));
  bus.on('tab', () => {
    updateHint();
    writeHash();
  });
  bus.on('pending', () => {
    updateHeader();
    updateHint();
  });
  bus.on('check', () => {
    updateHeader();
    updateHint();
  });
  bus.on('hint', ({ text } = {}) => {
    hintOverride = text || null;
    updateHint();
  });
  bus.on('sending', () => ui.sendBtn.classList.add('is-sending'));
  bus.on('send-failed', () => ui.sendBtn.classList.remove('is-sending'));
  bus.on('pending', () => setTimeout(() => ui.sendBtn.classList.remove('is-sending'), prefersReducedMotion() ? 0 : 900));
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    setTimeout(fitFrame, 50);
  });
  const clearReady = () => {
    if (readyUntilFocus) {
      readyUntilFocus = false;
      updateFav();
    }
  };
  window.addEventListener('focus', clearReady);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.hasFocus()) clearReady();
  });
  window.addEventListener('hashchange', () => applyHash());
  window.addEventListener('beforeunload', () => persist());

  const hash = parseHash();
  const startAt = hash.t && Number.isFinite(parseFloat(hash.t)) ? clamp(parseFloat(hash.t), 0, store.reel.duration || 1e9) : null;
  loadReel({ startAt });
  loadTimeline();
  fitFrame();
  setTab(store.data.check ? 'changes' : 'edit');
  applyHash(true);
  updateTime(startAt ?? 0);
  updatePlay();
  updateHeader();
  updateHint();
  renderPanel(true);
  bus.emit('reel', {});
  if (landed) {
    flashCue();
    arrival = { version: store.master.version, text: `v${store.master.version} is in · check ${landed.items.length} change${landed.items.length === 1 ? '' : 's'}`, until: Date.now() + 12000 };
    setTab('changes');
    updateHeader();
  }
  setInterval(poll, 2000);
  bus.on('refresh', () => poll()); // the timeline editor saved: show the new reel now

  // for tests and the curious
  window.__motionsnip = { store, player, seek, duration };
}

let hintT = 0;
function updateHintThrottled() {
  const now = performance.now();
  if (now - hintT < 250) return;
  hintT = now;
  updateHint();
}

boot().catch((e) => {
  console.error(e);
  showFatal(e.message || String(e));
});
