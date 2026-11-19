// The timeline compositor: the live renderer the player loads for a timeline project
// (reel.live = { type: 'timeline', spec: 'timeline.json' }). It follows the player's clock like the scene runtime:
// video clips are pooled <video> elements kept in sync, scene clips are SVG, text/shapes/images/captions are drawn
// on canvases between them, and the sound plays through WebAudio. renderFrame() draws any time for export with the
// same math.

import { normTimeline, evalAt, setPath as tlSetPath, VISUAL } from './timeline.mjs';
import { setPath as sceneSetPath } from '../scene/compile.mjs';
import { frameSVG } from '../scene/draw.mjs';
import { composePlan, composeSpec } from './compose.mjs';
import { drawGraphic, rectOf, cssFor, lookSvg, drawFit, applyLookPixels, withTransform } from './graphics.mjs';

const SCENE_FONT = '/app/fonts/fonts.css'; // Patrick Hand, served with the player
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function ensureFont() {
  if (document.querySelector('link[data-scene-font]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = SCENE_FONT;
  l.dataset.sceneFont = '';
  document.head.append(l);
}

const once = (el, ev, ms = 8000) =>
  new Promise((resolve, reject) => {
    const done = (ok) => {
      clearTimeout(timer);
      el.removeEventListener(ev, onOk);
      el.removeEventListener('error', onErr);
      ok ? resolve() : reject(new Error(`${el.currentSrc || 'media'} didn't load`));
    };
    const onOk = () => done(true);
    const onErr = () => done(false);
    const timer = setTimeout(() => done(true), ms); // a slow decoder still draws its last frame
    el.addEventListener(ev, onOk);
    el.addEventListener('error', onErr);
  });

/**
 * host: the element to draw into. raw: timeline.json as parsed. opts.scenes: { file: raw scene }, opts.asset(path) → URL.
 * Returns the live-renderer API: seek, play, pause, setRate, setBoxes, setProps, load, setMuted, renderFrame,
 * exportAudio, destroy, and timeline (the normalised model).
 */
export function createTimeline(host, raw, opts = {}) {
  ensureFont();
  const asset = opts.asset || ((p) => p);
  let base = raw;
  let sceneBase = { ...(opts.scenes || {}) };
  let patches = [];
  let boxes = {};
  let tl = null;
  let t = 0;
  let playing = false;
  let rate = 1;
  let muted = false;
  let queued = false;
  let dead = false;
  let actx = null;
  const media = new Map(); // clip id → { el, src, gain node }
  const els = new Map(); // slot key → element
  const sceneSvg = new WeakMap();
  const imgs = new Map();
  const W = () => tl.size[0];
  const H = () => tl.size[1];

  host.classList.add('comp-host');
  host.style.background = '';
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.style.position = 'absolute';
  document.body.append(defs);

  // ------------------------------------------------------------ the model with the player's unsaved edits

  function rebuild() {
    let r = base;
    const sc = { ...sceneBase };
    for (const p of patches) {
      try {
        if (p.file) sc[p.file] = sceneSetPath(sc[p.file] || {}, p.path, p.value);
        else r = tlSetPath(r, p.path, p.value);
      } catch (e) {
        console.warn('[motionsnip] timeline edit skipped:', p.path, e.message);
      }
    }
    tl = normTimeline(r, { scenes: sc });
    // a box dragged in the player: move and resize the clip's box by the same amount
    for (const tr of tl.tracks)
      for (const c of tr.clips) {
        const b = boxes[c.id];
        if (!b || tr.kind === 'captions' || tr.kind === 'audio') continue;
        const [x, y, w, h, nx, ny, nw, nh] = b;
        const box = c.box || [0, 0, 100, 100];
        const kx = w > 0 ? nw / w : 1;
        const ky = h > 0 ? nh / h : 1;
        c.box = [box[0] + (nx - x), box[1] + (ny - y), box[2] * kx, box[3] * ky];
      }
    host.style.background = tl.bg;
    schedule();
  }

  // ------------------------------------------------------------ media elements and sound

  function ensureAudioCtx() {
    if (actx || !(window.AudioContext || window.webkitAudioContext)) return;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      for (const m of media.values()) connect(m);
    } catch {
      actx = null;
    }
  }

  function connect(m) {
    if (!actx || m.node) return;
    try {
      m.node = actx.createGain();
      actx.createMediaElementSource(m.el).connect(m.node);
      m.node.connect(actx.destination);
      m.el.volume = 1;
    } catch {
      m.node = null;
    }
  }

  function mediaFor(clip, kind) {
    let m = media.get(clip.id);
    if (m && m.src === clip.src) return m;
    if (m) dropMedia(clip.id);
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = asset(clip.src);
    el.addEventListener('seeked', () => {
      if (el._want != null) {
        const w = el._want;
        el._want = null;
        if (Math.abs(el.currentTime - w) > 1e-3) el.currentTime = w;
      }
    });
    el.addEventListener('error', () => (m.failed = true));
    if (kind === 'video') {
      el.className = 'comp-layer comp-video';
      el.disablePictureInPicture = true;
    }
    m = { el, src: clip.src, node: null, failed: false };
    media.set(clip.id, m);
    connect(m);
    return m;
  }

  function dropMedia(id) {
    const m = media.get(id);
    if (!m) return;
    m.el.pause();
    m.el.removeAttribute('src');
    m.el.load();
    m.el.remove();
    media.delete(id);
  }

  function seekEl(el, target) {
    if (el.seeking) el._want = target;
    else el.currentTime = target;
  }

  /** Keep every media clip's element where the clock says, playing or paused, at its level. */
  function syncMedia() {
    const { audio } = evalAt(tl, t);
    const level = new Map(audio.map((a) => [a.clip.id, a.gain]));
    const live = new Set();
    const fpsTol = 0.5 / tl.fps;
    for (const tr of tl.tracks) {
      if (tr.kind !== 'video' && tr.kind !== 'audio') continue;
      for (const c of tr.clips) {
        const active = t >= c.at && t < c.end;
        const soon = playing && t < c.at && c.at - t < 1.5;
        if (!active && !soon) continue;
        if (!c.src) continue;
        live.add(c.id);
        const m = mediaFor(c, tr.kind);
        const el = m.el;
        const g = muted ? 0 : level.get(c.id) || 0;
        if (m.node) m.node.gain.setTargetAtTime(g, actx.currentTime, 0.02);
        else el.volume = clamp(g, 0, 1);
        if (!active) {
          if (!el.paused) el.pause();
          if (el.readyState >= 1 && Math.abs(el.currentTime - c.in) > 0.05) seekEl(el, c.in);
          continue;
        }
        const target = c.in + (t - c.at);
        el.playbackRate = rate;
        if (playing) {
          if (el.readyState >= 1 && Math.abs(el.currentTime - target) > 0.25) seekEl(el, target);
          if (el.paused) el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (el.readyState >= 1 && Math.abs(el.currentTime - target) > fpsTol) seekEl(el, target);
        }
      }
    }
    for (const [id, m] of media) if (!live.has(id) && !m.el.paused) m.el.pause();
    // forget clips that are gone from the timeline
    const ids = new Set(tl.tracks.flatMap((tr) => tr.clips.map((c) => c.id)));
    for (const id of [...media.keys()]) if (!ids.has(id)) dropMedia(id);
  }

  // ------------------------------------------------------------ drawing the preview

  function img(src) {
    if (!src) return null;
    let i = imgs.get(src);
    if (!i) {
      i = new Image();
      i.onload = schedule;
      i.src = asset(src);
      imgs.set(src, i);
    }
    return i.complete && i.naturalWidth ? i : null;
  }

  function lookFilter(clip) {
    if (!clip.look) return '';
    const id = `ms-look-${clip.id}`;
    let f = defs.querySelector(`#${CSS.escape(id)}`);
    if (!f) {
      f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      f.id = id;
      f.setAttribute('color-interpolation-filters', 'sRGB');
      f.innerHTML = '<feColorMatrix type="matrix"/><feComponentTransfer><feFuncR type="linear"/><feFuncG type="linear"/><feFuncB type="linear"/></feComponentTransfer>';
      defs.append(f);
    }
    const L = lookSvg(clip.look);
    f.querySelector('feColorMatrix').setAttribute('values', L.values);
    for (const fn of f.querySelectorAll('feFuncR,feFuncG,feFuncB')) {
      fn.setAttribute('slope', L.slope);
      fn.setAttribute('intercept', L.intercept);
    }
    return `url(#${id})`;
  }

  function place(el, layer) {
    const css = cssFor(rectOf(layer.clip, W(), H(), layer.track.kind), layer.state, W(), H());
    const s = el.style;
    s.position = 'absolute';
    s.right = 'auto';
    s.bottom = 'auto';
    for (const k of ['left', 'top', 'width', 'height', 'transform', 'opacity', 'clipPath']) if (s[k] !== css[k]) s[k] = css[k];
  }

  function canvasEl(key) {
    let c = els.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'comp-layer comp-canvas';
      Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' });
      els.set(key, c);
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.max(1, Math.round(host.clientWidth * dpr));
    const ph = Math.max(1, Math.round(host.clientHeight * dpr));
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    return c;
  }

  function draw() {
    queued = false;
    if (dead || !tl) return;
    syncMedia();
    const { layers } = evalAt(tl, t);
    // layers back to front; graphics and captions next to each other share one canvas
    const slots = [];
    let run = null;
    let runs = 0;
    for (const L of layers) {
      const k = L.track.kind;
      if (k === 'video') slots.push({ key: `v:${L.clip.id}`, L }), (run = null);
      else if (k === 'scene') slots.push({ key: `s:${L.clip.id}`, L }), (run = null);
      else if (k === 'graphics' && L.clip.type === 'blur') slots.push({ key: `b:${L.clip.id}`, L }), (run = null);
      else {
        if (!run) slots.push((run = { key: `c:${runs++}`, layers: [] }));
        run.layers.push(L);
      }
    }
    const want = [];
    for (const s of slots) {
      let el;
      if (s.key[0] === 'v') {
        const m = mediaFor(s.L.clip, 'video');
        el = m.el;
        el.style.objectFit = s.L.clip.fit;
        const f = lookFilter(s.L.clip);
        if (el.style.filter !== f) el.style.filter = f;
        place(el, s.L);
      } else if (s.key[0] === 's') {
        el = els.get(s.key);
        if (!el) {
          el = document.createElement('div');
          el.className = 'comp-layer comp-scene';
          els.set(s.key, el);
        }
        const spec = tl.scenes[s.L.clip.scene];
        const svg = spec && s.L.sceneT != null ? frameSVG(spec, s.L.sceneT, { uid: `tl-${s.L.clip.id}`, asset, noTrans: s.L.sceneCut }) : '';
        if (sceneSvg.get(el) !== svg) {
          el.innerHTML = svg;
          sceneSvg.set(el, svg);
        }
        place(el, s.L);
      } else if (s.key[0] === 'b') {
        el = els.get(s.key);
        if (!el) {
          el = document.createElement('div');
          el.className = 'comp-layer comp-blur';
          els.set(s.key, el);
        }
        const px = (s.L.clip.amount / 100) * Math.min(host.clientWidth, host.clientHeight) * 0.5;
        el.style.backdropFilter = el.style.webkitBackdropFilter = `blur(${px.toFixed(1)}px)`;
        place(el, { ...s.L, state: { ...s.L.state, scale: 1, rotate: 0 } });
      } else {
        el = canvasEl(s.key);
        const g = el.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, el.width, el.height);
        g.setTransform(el.width / W(), 0, 0, el.height / H(), 0, 0);
        for (const L of s.layers) drawGraphic(g, L, W(), H(), { img });
      }
      want.push(el);
    }
    // put the elements in layer order, take away the rest
    want.forEach((el, i) => {
      if (host.children[i] !== el) host.insertBefore(el, host.children[i] || null);
    });
    while (host.children.length > want.length) host.lastElementChild.remove();
  }

  // next frame; a timer as well, because frames don't come in a hidden tab or pane and media still need syncing
  function schedule() {
    if (queued || dead) return;
    queued = true;
    let raf = 0;
    let timer = 0;
    const run = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (queued) draw();
    };
    raf = requestAnimationFrame(run);
    timer = setTimeout(run, 100);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  ro?.observe(host);

  // ------------------------------------------------------------ export: any time, onto a canvas

  const exportVideos = new Map(); // src → video element used only for export

  async function exportFrameOf(src, at) {
    let v = exportVideos.get(src);
    if (!v) {
      v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.src = asset(src);
      exportVideos.set(src, v);
      await once(v, 'loadeddata');
    }
    const target = clamp(at, 0, Math.max(0, (v.duration || Infinity) - 0.001));
    if (Math.abs(v.currentTime - target) > 1e-4 || v.readyState < 2) {
      const p = once(v, 'seeked');
      v.currentTime = target;
      await p;
    }
    return v;
  }

  async function imgReady(src) {
    img(src);
    const i = imgs.get(src);
    if (i && !i.complete) await i.decode().catch(() => {});
    return img(src);
  }

  /**
   * Draw time t onto raster (createRaster from raster.js), at the raster's size. opts.skip: clip ids ffmpeg draws in
   * a composed export; with it the frame starts transparent and those clips are left out.
   */
  async function renderFrame(raster, at, opts = {}) {
    const { canvas, ctx: g } = raster;
    const sx = canvas.width / W();
    const sy = canvas.height / H();
    const skip = opts.skip || null;
    raster.clear(skip ? null : tl.bg);
    const { layers } = evalAt(tl, at);
    for (const L of layers) {
      if (skip?.has(L.clip.id)) continue;
      g.setTransform(sx, 0, 0, sy, 0, 0);
      const k = L.track.kind;
      const rect = rectOf(L.clip, W(), H(), k);
      if (k === 'video') {
        if (!L.clip.src) continue;
        let v;
        try {
          v = await exportFrameOf(L.clip.src, L.srcT);
        } catch {
          continue; // a missing file draws nothing (the checks say so)
        }
        const tw = Math.max(1, Math.round(rect[2] * sx));
        const th = Math.max(1, Math.round(rect[3] * sy));
        const tmp = document.createElement('canvas');
        tmp.width = tw;
        tmp.height = th;
        const tg = tmp.getContext('2d', { willReadFrequently: !!L.clip.look });
        drawFit(tg, v, v.videoWidth, v.videoHeight, tw, th, L.clip.fit);
        if (L.clip.look) applyLookPixels(tg, tw, th, L.clip.look);
        withTransform(g, rect, L.state, W(), H(), (w, h) => g.drawImage(tmp, 0, 0, w, h));
      } else if (k === 'scene') {
        const spec = tl.scenes[L.clip.scene];
        if (!spec || L.sceneT == null) continue;
        const im = await raster.svgImage(frameSVG(spec, L.sceneT, { uid: `ex-${L.clip.id}`, asset, noTrans: L.sceneCut }), Math.round(rect[2] * sx), Math.round(rect[3] * sy));
        withTransform(g, rect, L.state, W(), H(), (w, h) => g.drawImage(im, 0, 0, w, h));
      } else {
        if (L.clip.type === 'image') await imgReady(L.clip.src);
        drawGraphic(g, L, W(), H(), { img });
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** The sound for an export: one entry per audible media clip, for the server's mix. */
  function exportAudio() {
    const soloA = tl.tracks.some((tr) => (tr.kind === 'audio' || tr.kind === 'video') && tr.solo);
    const out = [];
    for (const tr of tl.tracks) {
      if ((tr.kind !== 'audio' && tr.kind !== 'video') || tr.mute || (soloA && !tr.solo)) continue;
      for (const c of tr.clips) {
        if (c.mute || !c.src || !(tr.gain * c.gain > 0)) continue;
        out.push({ src: c.src, at: c.at, in: c.in, out: c.out, gain: tr.gain * c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
      }
    }
    return out;
  }

  rebuild();

  return {
    seek(v) {
      if (!Number.isFinite(v) || v === t) return;
      t = v;
      schedule();
    },
    play() {
      ensureAudioCtx();
      actx?.resume?.().catch(() => {});
      playing = true;
      schedule();
    },
    pause() {
      playing = false;
      for (const m of media.values()) m.el.pause();
      schedule();
    },
    setRate(r) {
      rate = clamp(Number(r) || 1, 0.25, 4);
      schedule();
    },
    setMuted(on) {
      muted = !!on;
      schedule();
    },
    /** boxes: { elId: [x, y, w, h, nx, ny, nw, nh] } in % of the frame; a clip's element id is the clip id. */
    setBoxes(next = {}) {
      boxes = next || {};
      rebuild();
    },
    /** edits: { elId: { prop: value } }; patches: [{ path, value, file? }] — file is a scene a clip uses. */
    setProps(edits, next = []) {
      patches = Array.isArray(next) ? next : [];
      rebuild();
    },
    /** A new timeline.json (and its scenes) after an edit, Claude's change or Apply. Keeps the time. */
    load(nextRaw, nextScenes) {
      base = nextRaw;
      if (nextScenes) sceneBase = { ...nextScenes };
      rebuild();
    },
    renderFrame,
    exportAudio,
    /** A composed export (ffmpeg draws the video and blur boxes): { ok, spec, ids } or { ok: false, reason }. */
    composeSpec() {
      const plan = composePlan(tl);
      return plan.ok ? { ok: true, spec: composeSpec(tl, plan), ids: plan.ids } : plan;
    },
    audio: true,
    destroy() {
      dead = true;
      ro?.disconnect();
      for (const id of [...media.keys()]) dropMedia(id);
      for (const v of exportVideos.values()) {
        v.removeAttribute('src');
        v.load();
      }
      defs.remove();
      actx?.close?.().catch(() => {});
      host.classList.remove('comp-host');
      host.style.background = '';
    },
    get timeline() {
      return tl;
    },
    get raw() {
      return base;
    },
  };
}

export { VISUAL };
