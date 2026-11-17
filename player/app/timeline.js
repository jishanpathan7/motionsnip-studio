// Timeline: scene strip, music lane (drag = offset, end handle = fade), effects lane, beat grid,
// scrubbing and hover thumbnails. Waveforms are decoded with Web Audio and drawn as bars.
// For a plain video, vedit.js draws trim, cuts and a layers lane into the parts timelineParts() hands it.

import { store, bus, effectiveAudio, setAudio, sceneStatus, notes, elHasEdits, getEl, sceneAt, findChange, assetName } from './state.js';
import { player, duration, seek, currentTime, isPlaying, pause, play } from './video.js';
import { h, clamp, cssVar, fmtTime, projectUrl, round } from './util.js';

const SNAP_PX = 8;

const tl = {
  root: null,
  area: null,
  grid: null,
  scenes: null,
  marks: null,
  musicLane: null,
  musicCanvas: null,
  musicClip: null,
  fadeHandle: null,
  musicEmpty: null,
  fxLane: null,
  fxCanvas: null,
  fxEmpty: null,
  fxLabel: null,
  playhead: null,
  hoverLine: null,
  tip: null,
  tipCanvas: null,
  tipText: null,
  thumb: null,
  peaks: { music: null, fx: null },
  peaksFor: { music: undefined, fx: undefined }, // undefined: not looked yet (null is "no file")
  drag: null, // { kind: 'offset'|'fade', ... }
  width: 0,
};

export function initTimeline(host) {
  tl.root = host;
  tl.fxLabel = h('div.tl-label', 'Effects');
  tl.scenesLabel = h('div.tl-label', 'Scenes');
  tl.layersLabel = h('div.tl-label', { hidden: true }, 'On the frame');
  const labels = h('div.tl-labels', tl.scenesLabel, h('div.tl-label', 'Music'), tl.fxLabel, tl.layersLabel);

  tl.grid = h('canvas.tl-grid', { 'aria-hidden': 'true' });
  tl.scenes = h('div.tl-scenes');
  tl.marks = h('div.tl-marks', { 'aria-hidden': 'true' });

  tl.musicCanvas = h('canvas.tl-wave');
  tl.musicClip = h('div.tl-clip', { title: 'Drag to move the music · Shift = no snapping' });
  tl.fadeHandle = h('div.tl-fade', { title: 'Drag to set the fade-out', role: 'slider', 'aria-label': 'Music fade-out' }, h('span.tl-fade-grip'));
  tl.fadeShade = h('div.tl-fade-shade', { 'aria-hidden': 'true' });
  tl.musicEmpty = h('div.tl-empty', 'No music · drop a track anywhere, or Upload in Sound');
  tl.musicTape = h('span.tl-lane-tape', { title: 'Music changed · not sent yet' });
  tl.musicLane = h('div.tl-lane.tl-music', tl.musicCanvas, tl.musicClip, tl.fadeShade, tl.fadeHandle, tl.musicEmpty, tl.musicTape);

  tl.fxCanvas = h('canvas.tl-wave');
  tl.fxEmpty = h('div.tl-empty', 'Reading the sound…');
  tl.fxLane = h('div.tl-lane.tl-fx', tl.fxCanvas, tl.fxEmpty);

  tl.layersLane = h('div.tl-lane.tl-layers', { hidden: true });
  tl.edit = h('div.tl-edit'); // trim and cut marks over every lane (plain video)

  tl.playhead = h('div.tl-playhead', { 'aria-hidden': 'true' });
  tl.hoverLine = h('div.tl-hoverline', { 'aria-hidden': 'true' });

  tl.area = h(
    'div.tl-area',
    { role: 'slider', tabindex: '-1', 'aria-label': 'Timeline', 'aria-valuemin': '0' },
    tl.grid,
    tl.scenes,
    tl.musicLane,
    tl.fxLane,
    tl.layersLane,
    tl.edit,
    tl.marks,
    tl.hoverLine,
    tl.playhead,
  );

  tl.tipCanvas = h('canvas.tl-tip-thumb', { width: 192, height: 108 });
  tl.tipText = h('div.tl-tip-text');
  tl.tip = h('div.tl-tip', { hidden: true }, tl.tipCanvas, tl.tipText);

  host.append(labels, tl.area, tl.tip);

  tl.thumb = h('video', { muted: true, preload: 'auto', playsInline: true, 'aria-hidden': 'true' });
  tl.thumb.muted = true;
  tl.thumb.addEventListener('seeked', drawThumb);

  tl.area.addEventListener('pointerdown', onDown);
  tl.area.addEventListener('pointermove', onHover);
  tl.area.addEventListener('pointerleave', () => {
    if (!tl.drag) hideTip();
  });
  tl.fadeHandle.addEventListener('pointerdown', (e) => startLaneDrag(e, 'fade'));
  tl.musicClip.addEventListener('pointerdown', (e) => startLaneDrag(e, 'offset'));

  new ResizeObserver(() => layout()).observe(tl.area);

  bus.on('time', ({ t }) => movePlayhead(t));
  bus.on('changes', (d) => {
    if (d.audio || d.undone || d.upload) {
      drawMusic();
      positionMusic();
      loadWaves();
    }
    renderScenes();
    renderMarks();
  });
  bus.on('status', () => renderScenes());
  bus.on('music', () => {
    positionMusic();
    loadWaves();
  });
  bus.on('theme', () => layout());
  bus.on('duration', () => layout());
}

/** The pieces vedit.js draws into. */
export function timelineParts() {
  return { root: tl.root, area: tl.area, edit: tl.edit, layersLane: tl.layersLane, layersLabel: tl.layersLabel, scenesLabel: tl.scenesLabel };
}

export function loadTimeline() {
  const reel = store.reel;
  tl.fxLabel.textContent = reel.plain ? 'Video sound' : reel.audio.videoAudio === 'mix' ? 'Video sound' : 'Effects';
  tl.scenesLabel.textContent = reel.plain ? 'Edit' : 'Scenes';
  if (reel.src) {
    tl.thumb.src = projectUrl(reel.src) + `?v=${reel.version}&thumb`;
    tl.thumb.load();
  }
  tl.peaksFor.fx = undefined;
  tl.peaksFor.music = undefined;
  layout();
  loadWaves();
}

// ---------------------------------------------------------------- geometry

const W = () => tl.width || tl.area.clientWidth || 1;
const xToT = (x) => clamp((x / W()) * duration(), 0, duration());
const tToX = (t) => (duration() ? (t / duration()) * W() : 0);
const pct = (t) => (duration() ? (t / duration()) * 100 : 0);

function localX(e) {
  const r = tl.area.getBoundingClientRect();
  return clamp(e.clientX - r.left, 0, r.width);
}

function layout() {
  if (!store.reel) return;
  tl.width = tl.area.clientWidth;
  tl.area.setAttribute('aria-valuemax', String(round(duration(), 1)));
  renderScenes();
  renderMarks();
  positionMusic();
  drawGrid();
  drawMusic();
  drawFx();
  movePlayhead(currentTime());
}

function movePlayhead(t) {
  tl.playhead.style.transform = `translateX(${tToX(t)}px)`;
  tl.area.setAttribute('aria-valuenow', String(round(t, 1)));
  tl.area.setAttribute('aria-valuetext', fmtTime(t));
  const cur = sceneAt(t);
  if (cur && tl._cur !== cur.id) {
    tl._cur = cur.id;
    for (const c of tl.scenes.children) c.classList.toggle('is-current', c.dataset.id === cur.id);
  }
}

// ---------------------------------------------------------------- scene strip and marks

function renderScenes() {
  if (!store.reel) return;
  const frag = document.createDocumentFragment();
  const cur = sceneAt(currentTime());
  for (const s of store.reel.scenes) {
    const st = sceneStatus(s.id);
    const w = pct(s.t[1] - s.t[0]);
    const chip = h(
      'div.tl-chip.st-' + st + (cur && cur.id === s.id ? '.is-current' : ''),
      {
        dataset: { id: s.id },
        title: `${s.id} ${s.name} · ${fmtTime(s.t[0])}–${fmtTime(s.t[1])} · ${st === 'approved' ? 'approved' : st === 'changes' ? 'needs changes' : 'in review'}`,
        style: { left: pct(s.t[0]) + '%', width: w + '%' },
      },
      h('span.tl-chip-dot', { 'aria-hidden': 'true' }),
      h('span.tl-chip-name', h('b', s.id), ' ', s.name),
    );
    frag.append(chip);
  }
  tl.scenes.replaceChildren(frag);
  tl._cur = cur?.id;
}

function renderMarks() {
  if (!store.reel) return;
  const frag = document.createDocumentFragment();
  const seen = new Set();
  for (const c of store.data.changes) {
    if ((c.kind === 'prop' || c.kind === 'box') && !seen.has(c.elId) && elHasEdits(c.elId)) {
      seen.add(c.elId);
      const el = getEl(c.elId);
      const t = Number.isFinite(c.at) ? c.at : el?.t[0] || 0;
      frag.append(h('span.tl-tape', { style: { left: pct(t) + '%' }, title: `${el?.label || c.elId} · changed` }));
    }
  }
  notes().forEach((n, i) => {
    frag.append(h('span.tl-note', { style: { left: pct(n.t) + '%' }, title: `Note ${i + 1}: ${n.text || '(no comment yet)'}` }, String(i + 1)));
  });
  tl.marks.replaceChildren(frag);
  const a = store.data.changes.some((c) => c.kind === 'audio');
  tl.musicTape.hidden = !a;
}

// ---------------------------------------------------------------- music lane

function musicGeom(offset) {
  const a = effectiveAudio();
  const off = offset ?? (tl.drag?.kind === 'offset' ? tl.drag.value : a.musicOffset || 0);
  const md = player.musicDuration || duration();
  return { off, md, fade: tl.drag?.kind === 'fade' ? tl.drag.value : a.musicFade || 0 };
}

function positionMusic() {
  if (!store.reel) return;
  const a = effectiveAudio();
  const has = !!a.music;
  tl.musicEmpty.hidden = has;
  tl.musicEmpty.textContent = store.reel.derived ? 'Music is mixed into this version' : 'No music · drop a track anywhere, or Upload in Sound';
  tl.musicClip.hidden = !has;
  tl.fadeHandle.hidden = !has;
  tl.fadeShade.hidden = !has;
  if (!has) return;
  const { off, md, fade } = musicGeom();
  const d = duration();
  const start = clamp(off, -md, d);
  const end = clamp(off + md, 0, d);
  const left = Math.max(0, start);
  tl.musicClip.style.left = pct(left) + '%';
  tl.musicClip.style.width = Math.max(0, pct(end - left)) + '%';
  tl.musicClip.classList.toggle('cut-left', start < 0);
  const fx = clamp(d - fade, 0, d);
  tl.fadeHandle.style.left = pct(fx) + '%';
  tl.fadeShade.style.left = pct(fx) + '%';
  tl.fadeShade.style.width = pct(d - fx) + '%';
  tl.fadeHandle.setAttribute('aria-valuenow', String(round(fade, 2)));
  tl.fadeHandle.title = fade > 0 ? `Fade-out ${round(fade, 2)} s · drag to change` : 'Drag left to fade the music out at the end';
  tl.musicClip.title = `${assetName(a.music)} · starts at ${round(off, 2)} s · drag to move · Shift = no snapping`;
}

function snapPoints() {
  const pts = [0];
  for (const s of store.reel.scenes) pts.push(s.t[0]);
  const { bpm, drop } = store.reel.audio;
  if (bpm > 0) {
    const beat = 60 / bpm;
    const anchor = Number.isFinite(drop) ? drop : 0;
    const d = duration();
    let k = Math.ceil((0 - anchor) / beat);
    for (let t = anchor + k * beat; t <= d; k++, t = anchor + k * beat) pts.push(t);
  }
  return pts;
}

function snap(t, shift) {
  if (shift) return t;
  const pxPerS = W() / (duration() || 1);
  let best = t;
  let bestD = SNAP_PX / pxPerS;
  for (const p of snapPoints()) {
    const dd = Math.abs(p - t);
    if (dd < bestD) {
      bestD = dd;
      best = p;
    }
  }
  return best;
}

function startLaneDrag(e, kind) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const a = effectiveAudio();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  const start = kind === 'offset' ? a.musicOffset || 0 : a.musicFade || 0;
  tl.drag = { kind, value: start, start };
  tl.root.classList.add('is-dragging');
  const pxPerS = W() / (duration() || 1);
  const move = (ev) => {
    const dt = (ev.clientX - x0) / pxPerS;
    if (kind === 'offset') {
      tl.drag.value = round(snap(start + dt, ev.shiftKey), 2);
      showTipText(`Music starts at ${round(tl.drag.value, 2)} s`, ev);
    } else {
      const d = duration();
      const edge = snap(clamp(d - start + dt, 0, d), ev.shiftKey);
      tl.drag.value = round(clamp(d - edge, 0, d), 2);
      showTipText(tl.drag.value > 0 ? `Fade-out ${tl.drag.value} s` : 'No fade', ev);
    }
    positionMusic();
    drawMusic();
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    const v = tl.drag.value;
    tl.drag = null;
    tl.root.classList.remove('is-dragging');
    hideTip();
    if (v !== start) setAudio(kind === 'offset' ? 'musicOffset' : 'musicFade', v);
    positionMusic();
    drawMusic();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- scrubbing and hover

function onDown(e) {
  if (e.button !== 0 || tl.drag) return;
  e.preventDefault();
  tl.area.setPointerCapture(e.pointerId);
  const wasPlaying = isPlaying();
  if (wasPlaying) pause();
  tl.root.classList.add('is-scrubbing');
  seek(xToT(localX(e)));
  const move = (ev) => {
    seek(xToT(localX(ev)));
    onHover(ev);
  };
  const up = () => {
    tl.area.removeEventListener('pointermove', move);
    tl.area.removeEventListener('pointerup', up);
    tl.area.removeEventListener('pointercancel', up);
    tl.root.classList.remove('is-scrubbing');
    if (wasPlaying) play();
  };
  tl.area.addEventListener('pointermove', move);
  tl.area.addEventListener('pointerup', up);
  tl.area.addEventListener('pointercancel', up);
}

let thumbWant = null;
let thumbBusy = false;

function onHover(e) {
  if (tl.drag) return;
  const x = localX(e);
  const t = xToT(x);
  tl.hoverLine.style.transform = `translateX(${x}px)`;
  tl.hoverLine.hidden = false;
  const sc = sceneAt(t);
  tl.tipText.textContent = `${fmtTime(t)} · ${sc ? sc.id + ' ' + sc.name : ''}`;
  tl.tip.hidden = false;
  tl.tipCanvas.hidden = !player.videoOk;
  placeTip(x);
  if (player.videoOk) requestThumb(t);
}

function placeTip(x) {
  const tw = tl.tip.offsetWidth || 200;
  const areaLeft = tl.area.offsetLeft;
  const max = tl.root.clientWidth - tw;
  tl.tip.style.left = clamp(areaLeft + x - tw / 2, 0, Math.max(0, max)) + 'px';
}

function showTipText(text, e) {
  tl.tipText.textContent = text;
  tl.tipCanvas.hidden = true;
  tl.tip.hidden = false;
  placeTip(localX(e));
}

function hideTip() {
  tl.tip.hidden = true;
  tl.hoverLine.hidden = true;
}

function requestThumb(t) {
  thumbWant = t;
  if (thumbBusy || tl.thumb.readyState < 1) return;
  thumbBusy = true;
  try {
    tl.thumb.currentTime = t;
  } catch {
    thumbBusy = false;
  }
}

function drawThumb() {
  thumbBusy = false;
  const c = tl.tipCanvas;
  const g = c.getContext('2d');
  const vw = tl.thumb.videoWidth || 16;
  const vh = tl.thumb.videoHeight || 9;
  const ch = Math.round((c.width * vh) / vw);
  if (c.height !== ch) c.height = ch;
  try {
    g.drawImage(tl.thumb, 0, 0, c.width, c.height);
  } catch {
    /* not decodable yet */
  }
  if (thumbWant != null && Math.abs(thumbWant - tl.thumb.currentTime) > 0.05) requestThumb(thumbWant);
}

// ---------------------------------------------------------------- drawing

function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, c.clientWidth);
  const hh = Math.max(1, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(hh * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hh);
  return { g, w, h: hh };
}

function drawGrid() {
  const { g, w, h: hh } = setupCanvas(tl.grid);
  const { bpm, drop } = store.reel.audio;
  const d = duration();
  if (!d) return;
  const lead = cssVar('--line');
  const strong = cssVar('--line-strong');
  // scene boundaries
  g.fillStyle = strong;
  for (const s of store.reel.scenes) {
    const x = Math.round((s.t[0] / d) * w) + 0.5;
    g.fillRect(x, 0, 1, hh);
  }
  if (bpm > 0) {
    const beat = 60 / bpm;
    const anchor = Number.isFinite(drop) ? drop : 0;
    const pxBeat = (beat / d) * w;
    let k = Math.ceil(-anchor / beat);
    for (let t = anchor + k * beat; t <= d; k++, t = anchor + k * beat) {
      const bar = ((k % 4) + 4) % 4 === 0;
      if (!bar && pxBeat < 5) continue;
      if (bar && pxBeat * 4 < 5) continue;
      const x = Math.round((t / d) * w) + 0.5;
      g.fillStyle = bar ? strong : lead;
      g.fillRect(x, 30, 1, hh - 30);
    }
  }
  if (Number.isFinite(drop) && drop >= 0 && drop <= d) {
    const x = Math.round((drop / d) * w);
    g.fillStyle = cssVar('--text');
    g.globalAlpha = 0.85;
    g.fillRect(x, 30, 2, hh - 30);
    g.globalAlpha = 1;
    g.font = `500 10px ${cssVar('--mono')}`;
    g.textBaseline = 'top';
    const label = 'drop';
    const tw = g.measureText(label).width;
    const lx = x + 4 + tw > w ? x - tw - 4 : x + 4;
    g.fillStyle = cssVar('--text');
    g.fillText(label, lx, 32);
  }
}

function drawBars(canvas, peaks, mapT, color, alpha = 1) {
  const { g, w, h: hh } = setupCanvas(canvas);
  if (!peaks) return;
  const d = duration();
  if (!d) return;
  const step = 3;
  const mid = hh / 2;
  g.fillStyle = color;
  g.globalAlpha = alpha;
  for (let x = 0; x < w; x += step) {
    const t0 = (x / w) * d;
    const t1 = ((x + step) / w) * d;
    const v = peakBetween(peaks, mapT(t0), mapT(t1));
    if (v <= 0) continue;
    const bh = Math.max(1, v * (hh - 6));
    g.fillRect(x, mid - bh / 2, step - 1, bh);
  }
  g.globalAlpha = 1;
}

function peakBetween(p, a, b) {
  if (b <= 0 || a >= p.duration) return 0;
  const i0 = clamp(Math.floor(a * p.rate), 0, p.data.length - 1);
  const i1 = clamp(Math.ceil(b * p.rate), i0 + 1, p.data.length);
  let m = 0;
  for (let i = i0; i < i1; i++) if (p.data[i] > m) m = p.data[i];
  return m;
}

function drawMusic() {
  if (!store.reel) return;
  const a = effectiveAudio();
  if (!a.music) {
    setupCanvas(tl.musicCanvas);
    return;
  }
  const { off, fade } = musicGeom();
  const d = duration();
  const peaks = tl.peaks.music;
  const { g, w, h: hh } = setupCanvas(tl.musicCanvas);
  if (!peaks) return;
  const step = 3;
  const mid = hh / 2;
  const color = cssVar('--wave-music');
  g.fillStyle = color;
  for (let x = 0; x < w; x += step) {
    const t0 = (x / w) * d;
    const t1 = ((x + step) / w) * d;
    let v = peakBetween(peaks, t0 - off, t1 - off);
    if (v <= 0) continue;
    if (fade > 0) v *= clamp((d - t0) / fade, 0, 1);
    v *= clamp(a.musicVol, 0, 1) * 0.85 + 0.15;
    const bh = Math.max(1, v * (hh - 6));
    g.fillRect(x, mid - bh / 2, step - 1, bh);
  }
}

function drawFx() {
  if (!store.reel) return;
  drawBars(tl.fxCanvas, tl.peaks.fx, (t) => t, cssVar('--wave-fx'));
}

// ---------------------------------------------------------------- waveform decoding

async function decodePeaks(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new Error('no Web Audio');
  const ctx = new OAC(1, 1, 44100);
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  const rate = 100; // buckets per second
  const n = Math.max(1, Math.ceil(audio.duration * rate));
  const data = new Float32Array(n);
  const per = audio.sampleRate / rate;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const s = audio.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * per);
      const b = Math.min(s.length, Math.floor((i + 1) * per));
      let m = data[i];
      for (let j = a; j < b; j += 4) {
        const v = s[j] < 0 ? -s[j] : s[j];
        if (v > m) m = v;
      }
      data[i] = m;
    }
  }
  // normalise to the loudest bucket so quiet tracks still read
  let max = 0;
  for (let i = 0; i < n; i++) if (data[i] > max) max = data[i];
  if (max > 0) for (let i = 0; i < n; i++) data[i] = Math.sqrt(data[i] / max);
  return { data, rate, duration: audio.duration };
}

function loadWaves() {
  if (!store.reel) return;
  const a = effectiveAudio();
  const musicUrl = a.music ? projectUrl(a.music) : null;
  if (musicUrl !== tl.peaksFor.music) {
    tl.peaksFor.music = musicUrl;
    tl.peaks.music = null;
    drawMusic();
    if (musicUrl) {
      decodePeaks(musicUrl)
        .then((p) => {
          if (tl.peaksFor.music !== musicUrl) return;
          tl.peaks.music = p;
          drawMusic();
        })
        .catch(() => {
          if (tl.peaksFor.music !== musicUrl) return;
          tl.musicEmpty.hidden = false;
          tl.musicEmpty.textContent = `Can't read ${assetName(a.music)}`;
        });
    }
  }
  const src = store.reel.src ? projectUrl(store.reel.src) + `?v=${store.reel.version}` : null;
  if (src !== tl.peaksFor.fx) {
    tl.peaksFor.fx = src;
    tl.peaks.fx = null;
    tl.fxEmpty.hidden = false;
    tl.fxEmpty.textContent = src ? 'Reading the sound…' : 'No video yet';
    drawFx();
    if (src) {
      decodePeaks(src)
        .then((p) => {
          if (tl.peaksFor.fx !== src) return;
          tl.peaks.fx = p;
          tl.fxEmpty.hidden = true;
          drawFx();
        })
        .catch(() => {
          if (tl.peaksFor.fx !== src) return;
          tl.fxEmpty.textContent = 'No sound in the video';
        });
    }
  }
}

export function musicChangedKey() {
  return findChange('audio:music');
}
