// Editing a plain video (one with no reel.json), right in the player: trim and cuts, text / logo / blur
// layers on the frame, and a colour look. Everything previews live; Export applies the same edits with
// ffmpeg (server.mjs buildEditArgs). The edits live in store.data.vedit and are saved with the rest of the
// state. They are not feedback for Claude: MotionSnip Studio applies them itself.

import { store, bus, persist, setTab } from './state.js';
import { player, hooks, seek, pause, play, currentTime, isPlaying, duration } from './video.js';
import { timelineParts } from './timeline.js';
import { h, svg, icon, clamp, round, fmtTime, toast, projectUrl, newId } from './util.js';

const FONTS = {
  display: ['Display', '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif'],
  sans: ['Sans', 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'],
  serif: ['Serif', 'Georgia, "Times New Roman", serif'],
  mono: ['Mono', '"DM Mono", ui-monospace, Menlo, monospace'],
};
const LOOKS = [
  ['brightness', 'Brightness'],
  ['contrast', 'Contrast'],
  ['saturation', 'Saturation'],
  ['warmth', 'Warmth'],
];
const ZERO = { brightness: 0, contrast: 0, saturation: 0, warmth: 0 };
const EMPTY = Object.freeze({ trim: null, cuts: [], look: ZERO, layers: [] });
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

const r1 = (v) => round(v, 1);
const r3 = (v) => round(v, 3);

const ve = {
  frame: null,
  layer: null, // the overlay element (pointer events land here)
  vis: null,
  canvas: null,
  blurs: null,
  selBox: null,
  look: null,
  sel: null, // selected layer id
  cutStart: null,
  orig: false, // holding \ : show the original
  editor: null, // { id, before, wrap, input }
  drag: null,
  tdrag: null,
  undo: [], // [{ snap, at }]
  redo: [],
  heights: {}, // layer id -> drawn height in % of the frame
  imgs: {},
};

// ---------------------------------------------------------------- state

/** True while a plain video is open (and no live renderer took over). */
export const on = () => !!store.reel?.plain && !player.live;

function normEdit(v) {
  if (!v || typeof v !== 'object') return null;
  const pair = (p) => (Array.isArray(p) && p.length >= 2 && p.every((x) => Number.isFinite(+x)) ? [+p[0], +p[1]] : null);
  return {
    trim: pair(v.trim),
    cuts: (Array.isArray(v.cuts) ? v.cuts : []).map(pair).filter(Boolean),
    look: { ...ZERO, ...(v.look && typeof v.look === 'object' ? v.look : {}) },
    layers: (Array.isArray(v.layers) ? v.layers : []).filter((l) => l && l.id && ['text', 'image', 'blur'].includes(l.kind) && pair(l.t) && Array.isArray(l.box)),
  };
}

/** Read the edits. Reading never creates anything (opening a video saves nothing). */
export const get = () => store.data.vedit || EMPTY;

function mut() {
  if (!store.data.vedit) store.data.vedit = { trim: null, cuts: [], look: { ...ZERO }, layers: [] };
  return store.data.vedit;
}

const D = () => duration();
const layerById = (id) => get().layers.find((l) => l.id === id);
const shows = (L, t) => t >= L.t[0] && t <= L.t[1];

// ---------------------------------------------------------------- time: what stays after trim and cuts

/** Kept ranges, the same rules as server.mjs keepRanges. */
export function keep() {
  const e = get();
  const d = D();
  const cl = (v, dv) => (v !== null && v !== undefined && Number.isFinite(+v) ? clamp(+v, 0, d) : dv);
  const a = cl(e.trim?.[0], 0);
  const b = cl(e.trim?.[1], d);
  let k = b - a >= 0.05 ? [[a, b]] : [];
  for (const c of e.cuts) {
    const x = Math.min(c[0], c[1]);
    const y = Math.max(c[0], c[1]);
    if (y - x <= 0.001) continue;
    k = k.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, x], [y, q]].filter(([u, v]) => v - u >= 0.05)));
  }
  return k;
}

const timingOn = () => {
  const e = get();
  return e.cuts.length > 0 || (!!e.trim && (e.trim[0] > 0.001 || e.trim[1] < D() - 0.001));
};
const lookOn = () => LOOKS.some(([k]) => +get().look[k]);

/** Any edits to apply on export? */
export const hasEdits = () => on() && (timingOn() || lookOn() || get().layers.length > 0);

function outT(t) {
  if (!on() || !timingOn()) return t;
  let s = 0;
  for (const [a, b] of keep()) {
    if (t <= a) break;
    s += Math.min(t, b) - a;
  }
  return s;
}

function outDur() {
  if (!on() || !timingOn()) return null;
  return keep().reduce((s, [a, b]) => s + b - a, 0);
}

/** While playing: jump over cuts, stop at the end. True when it stopped playback. */
function frame() {
  if (!on() || !timingOn()) return false;
  const k = keep();
  const t = currentTime();
  if (!k.length) {
    pause();
    return true;
  }
  for (const [a, b] of k) {
    if (t < a - 0.01) {
      seek(a, { exact: true });
      return false;
    }
    if (t < b - 0.01) return false;
  }
  pause();
  seek(Math.max(k.at(-1)[0], k.at(-1)[1] - 0.02), { exact: true });
  return true;
}

function beforePlay() {
  if (!on() || !timingOn()) return;
  const k = keep();
  const t = currentTime();
  if (!k.length) return;
  if (t >= k.at(-1)[1] - 0.05 || t < k[0][0] - 0.01) seek(k[0][0], { exact: true });
  else for (const [a, b] of k) if (t < a) return seek(a, { exact: true });
}

// ---------------------------------------------------------------- undo

const snap = () => JSON.stringify(store.data.vedit || null);

function pushUndo(s = snap()) {
  ve.undo.push({ snap: s, at: Date.now() });
  if (ve.undo.length > 100) ve.undo.shift();
  ve.redo = [];
}

function restore(s) {
  store.data.vedit = normEdit(JSON.parse(s));
  if (ve.sel && !layerById(ve.sel)) ve.sel = null;
  after();
}

/**
 * ⌘Z: undo the newest edit here if it is newer than the newest change for Claude.
 * Returns false when the change list should undo instead.
 */
export function undoEdit() {
  if (!on() || !ve.undo.length) return false;
  const newest = Math.max(0, ...store.data.changes.filter((c) => !c.sent).map((c) => c.updatedAt || c.createdAt || 0));
  if (ve.undo.at(-1).at < newest) return false;
  ve.redo.push({ snap: snap(), at: Date.now() });
  restore(ve.undo.pop().snap);
  toast('Undone', { ms: 1200 });
  return true;
}

export function redoEdit() {
  if (!on()) return false;
  if (!ve.redo.length) {
    toast('Nothing to redo.', { ms: 1200 });
    return true;
  }
  ve.undo.push({ snap: snap(), at: Date.now() });
  restore(ve.redo.pop().snap);
  toast('Redone', { ms: 1200 });
  return true;
}

function edit(fn) {
  pushUndo();
  fn(mut());
  after();
}

/** Something changed: save, redraw the frame and timeline, tell the panel and export button. */
function after() {
  persist();
  draw();
  renderTimeline();
  bus.emit('vedit', {});
}

// ---------------------------------------------------------------- colour: same math as server.mjs lookMatrix

export function lookMatrix(l) {
  const L = { ...ZERO, ...l };
  const s = 1 + (+L.saturation || 0);
  const k = 1 + (+L.contrast || 0);
  const w = +L.warmth || 0;
  const lum = [0.2126, 0.7152, 0.0722];
  const gain = [1 + 0.1 * w, 1 + 0.02 * w, 1 - 0.1 * w];
  return {
    M: [0, 1, 2].map((i) => [0, 1, 2].map((j) => r3(gain[i] * ((1 - s) * lum[j] + (i === j ? s : 0))))),
    k: r3(k),
    o: r3(0.5 - 0.5 * k + 0.2 * (+L.brightness || 0)),
  };
}

function applyLook() {
  const v = player.video;
  if (!v) return;
  if (!on() || ve.orig || !lookOn()) {
    v.style.filter = '';
    return;
  }
  const { M, k, o } = lookMatrix(get().look);
  ve.look.querySelector('feColorMatrix').setAttribute('values', M.map((r) => [...r, 0, 0].join(' ')).join(' ') + ' 0 0 0 1 0');
  for (const f of ve.look.querySelectorAll('feFuncR,feFuncG,feFuncB')) {
    f.setAttribute('slope', k);
    f.setAttribute('intercept', o);
  }
  v.style.filter = 'url(#veLook)';
}

// ---------------------------------------------------------------- drawing text and logos
// The preview canvas and the export PNGs use this one function, so what you see is what you get.

const fontOf = (L, px) => `${L.bold ? 700 : 400} ${px}px ${(FONTS[L.font] || FONTS.display)[1]}`;

function imgFor(src) {
  if (!src) return null;
  let i = ve.imgs[src];
  if (!i) {
    i = ve.imgs[src] = new Image();
    i.onload = () => draw();
    i.src = projectUrl(src);
  }
  return i;
}

function wrapLines(g, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word;
      if (line && g.measureText(next).width > maxW) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

function rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = parseInt(m ? m[1] : '000000', 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${clamp(+a, 0, 1)})`;
}

function fadeAlpha(L, t) {
  if (!L.fade) return 1;
  const F = Math.min(0.4, (L.t[1] - L.t[0]) / 3);
  return F > 0 ? clamp(Math.min((t - L.t[0]) / F, (L.t[1] - t) / F), 0, 1) : 1;
}

function drawLayer(g, L, W, H, t, forExport) {
  const [x, y, w] = L.box;
  const X = (x / 100) * W;
  const Y = (y / 100) * H;
  const BW = (w / 100) * W;
  g.save();
  const fade = forExport || !isPlaying() ? 1 : fadeAlpha(L, t);
  g.globalAlpha = fade * (L.kind === 'image' ? clamp(L.opacity ?? 1, 0, 1) : 1) * (g.globalAlpha || 1);
  if (L.kind === 'text') {
    const fs = (L.size / 100) * H;
    const pad = L.bg ? fs * 0.38 : 0;
    const lh = fs * 1.18;
    g.font = fontOf(L, fs);
    g.textBaseline = 'top';
    const lines = wrapLines(g, L.text || ' ', BW - 2 * pad);
    const mw = Math.max(1, ...lines.map((l) => g.measureText(l).width));
    const th = lines.length * lh + 2 * pad;
    ve.heights[L.id] = (th / H) * 100;
    const al = L.align || 'center';
    if (L.bg) {
      const bw = Math.min(BW, mw + 2 * pad);
      const bx = al === 'left' ? X : al === 'right' ? X + BW - bw : X + (BW - bw) / 2;
      g.fillStyle = rgba(L.bgColor, L.bgOpacity ?? 0.6);
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, Y, bw, th, fs * 0.28);
      else g.rect(bx, Y, bw, th);
      g.fill();
    }
    if (L.shadow) {
      g.shadowColor = 'rgba(0,0,0,.5)';
      g.shadowBlur = fs * 0.14;
      g.shadowOffsetY = fs * 0.04;
    }
    g.fillStyle = L.color || '#ffffff';
    g.textAlign = al;
    const tx = al === 'left' ? X + pad : al === 'right' ? X + BW - pad : X + BW / 2;
    lines.forEach((ln, i) => g.fillText(ln, tx, Y + pad + i * lh + (lh - fs) / 2));
  } else if (L.kind === 'image') {
    const img = imgFor(L.src);
    if (img?.complete && img.naturalWidth) {
      const ih = (BW * img.naturalHeight) / img.naturalWidth;
      ve.heights[L.id] = (ih / H) * 100;
      g.drawImage(img, X, Y, BW, ih);
    }
  }
  g.restore();
}

const boxOf = (L) => (L.kind === 'blur' ? L.box : [L.box[0], L.box[1], L.box[2], ve.heights[L.id] ?? (L.kind === 'text' ? L.size * 1.6 : L.box[2] * 0.5)]);

function label(L) {
  if (L.kind === 'text') {
    const s = (L.text || 'Text').replace(/\s+/g, ' ').trim() || 'Text';
    return s.length > 28 ? s.slice(0, 27) + '…' : s;
  }
  if (L.kind === 'image') return L.src ? String(L.src).split('/').pop() : 'Logo';
  return 'Blur';
}

// ---------------------------------------------------------------- the frame

export function initVedit(frameEl) {
  ve.frame = frameEl;
  ve.layer = frameEl.querySelector('.overlay');
  const filt = svg('svg', { width: 0, height: 0, 'aria-hidden': 'true', class: 've-defs' });
  filt.innerHTML =
    '<filter id="veLook" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%"><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/><feComponentTransfer><feFuncR type="linear" slope="1" intercept="0"/><feFuncG type="linear" slope="1" intercept="0"/><feFuncB type="linear" slope="1" intercept="0"/></feComponentTransfer></filter>';
  document.body.append(filt);
  ve.look = filt.querySelector('filter');
  ve.blurs = h('div.ve-blurs');
  ve.canvas = h('canvas.ve-canvas');
  ve.selLabel = h('span.ov-label');
  ve.selBox = h('div.ov-box.is-selected.ve-sel', { hidden: true }, ve.selLabel, ['nw', 'ne', 'sw', 'se'].map((c) => h('span.ov-handle.h-' + c)));
  ve.vis = h('div.ve-vis', { hidden: true, 'aria-hidden': 'true' }, ve.blurs, ve.canvas, ve.selBox);
  frameEl.insertBefore(ve.vis, ve.layer);

  Object.assign(hooks, { outT, outDur, frame, beforePlay });
  wireFrame();
  wireTimeline();
  new ResizeObserver(() => draw()).observe(frameEl);
  document.fonts?.ready.then(() => draw());

  bus.on('reel', () => {
    store.data.vedit = normEdit(store.data.vedit);
    if (ve.sel && !layerById(ve.sel)) ve.sel = null;
    draw();
    renderTimeline();
  });
  bus.on('time', () => draw());
  bus.on('play', () => draw());
  bus.on('compare', () => draw());
  bus.on('duration', () => {
    draw();
    renderTimeline();
  });
}

function draw() {
  if (!ve.vis) return;
  if (!on()) {
    ve.vis.hidden = true;
    applyLook();
    return;
  }
  ve.vis.hidden = !!store.ui.compare;
  applyLook();
  const r = ve.frame.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr));
  const H = Math.max(1, Math.round(r.height * dpr));
  const cv = ve.canvas;
  if (cv.width !== W || cv.height !== H) {
    cv.width = W;
    cv.height = H;
  }
  const g = cv.getContext('2d');
  const t = currentTime();
  const paused = !isPlaying();
  g.clearRect(0, 0, W, H);
  const keepB = new Set();
  for (const L of get().layers) {
    const visible = !ve.orig && (shows(L, t) || (paused && L.id === ve.sel));
    if (!visible) continue;
    if (L.kind === 'blur') {
      keepB.add(L.id);
      let b = ve.blurs.querySelector(`[data-b="${CSS.escape(L.id)}"]`);
      if (!b) {
        b = h('div.ve-blur', { dataset: { b: L.id } });
        ve.blurs.append(b);
      }
      const px = Math.max(0.5, (L.amount / 100) * r.height);
      const f = `blur(${px.toFixed(1)}px)`;
      Object.assign(b.style, { left: L.box[0] + '%', top: L.box[1] + '%', width: L.box[2] + '%', height: L.box[3] + '%', backdropFilter: f, webkitBackdropFilter: f, opacity: shows(L, t) ? 1 : 0.4 });
    } else {
      g.globalAlpha = shows(L, t) ? 1 : 0.35;
      drawLayer(g, L, W, H, t, false);
      g.globalAlpha = 1;
    }
  }
  for (const b of [...ve.blurs.children]) if (!keepB.has(b.dataset.b)) b.remove();
  const S = ve.sel && layerById(ve.sel);
  if (S && paused && !ve.orig && !ve.editor) {
    const b = boxOf(S);
    Object.assign(ve.selBox.style, { left: b[0] + '%', top: b[1] + '%', width: b[2] + '%', height: b[3] + '%' });
    ve.selBox.classList.toggle('is-out', !shows(S, t));
    ve.selLabel.classList.toggle('below', b[1] < 6);
    ve.selLabel.textContent = label(S) + (shows(S, t) ? '' : ` · shows ${fmtTime(S.t[0])}–${fmtTime(S.t[1])}`);
    ve.selBox.hidden = false;
  } else ve.selBox.hidden = true;
}

// ---------------------------------------------------------------- picking and dragging layers on the frame
// Capture listeners on the frame run before the overlay's own (which would play/pause or pin notes).

function toPct(e) {
  const r = ve.layer.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
}

function hitLayer(p) {
  const t = currentTime();
  const Ls = get().layers.filter((L) => shows(L, t) || L.id === ve.sel);
  const order = [...Ls.filter((L) => L.kind !== 'blur').reverse(), ...Ls.filter((L) => L.kind === 'blur').reverse()];
  return order.find((L) => {
    const b = boxOf(L);
    return p.x >= b[0] && p.x <= b[0] + b[2] && p.y >= b[1] && p.y <= b[1] + b[3];
  });
}

function handleAt(p) {
  const S = ve.sel && layerById(ve.sel);
  if (!S || isPlaying()) return null;
  const b = boxOf(S);
  const r = ve.layer.getBoundingClientRect();
  const near = (cx, cy) => Math.hypot(((p.x - cx) / 100) * r.width, ((p.y - cy) / 100) * r.height) < 12;
  const corners = [
    ['nw', 0, 0],
    ['ne', 1, 0],
    ['sw', 0, 1],
    ['se', 1, 1],
  ];
  return corners.find(([, i, j]) => near(b[0] + b[2] * i, b[1] + b[3] * j))?.[0] || null;
}

const usable = (e) => on() && !ve.editor && !store.ui.compare && !e.target.closest?.('.ov-note,.ov-pop,.ov-editor');

export function selectLayer(id) {
  if (id && !layerById(id)) id = null;
  ve.sel = id;
  ve.cutStart = null;
  if (id && store.ui.tab !== 'edit') setTab('edit');
  draw();
  renderTimeline();
  bus.emit('vedit', { select: true });
  bus.emit('hint', {});
}

export const selectedLayer = () => (on() && ve.sel ? layerById(ve.sel) : null);

function wireFrame() {
  const fr = ve.frame;
  fr.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || !usable(e)) return;
      const p = toPct(e);
      const corner = handleAt(p);
      const L = corner ? layerById(ve.sel) : hitLayer(p);
      if (!L) {
        if (ve.sel && !e.altKey) {
          // a click on the empty frame lets go of the layer (rather than starting playback)
          e.stopPropagation();
          e.preventDefault();
          selectLayer(null);
        }
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      if (isPlaying()) pause();
      if (L.id !== ve.sel) selectLayer(L.id);
      ve.drag = { id: L.id, corner, p, box: [...boxOf(L)], size: L.size, before: snap(), moved: false };
      try {
        ve.layer.setPointerCapture(e.pointerId);
      } catch {}
    },
    true,
  );
  fr.addEventListener(
    'pointermove',
    (e) => {
      if (!on()) return;
      if (!ve.drag) {
        if (!usable(e) || isPlaying()) return;
        const p = toPct(e);
        const corner = handleAt(p);
        if (!corner && !hitLayer(p)) return;
        e.stopPropagation();
        ve.layer.style.cursor = corner ? (corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize') : 'move';
        return;
      }
      e.stopPropagation();
      const d = ve.drag;
      const p = toPct(e);
      const L = mut().layers.find((l) => l.id === d.id);
      if (!L) return;
      if (!d.moved && Math.hypot(p.x - d.p.x, p.y - d.p.y) < 0.4) return;
      d.moved = true;
      const [bx, by, bw, bh] = d.box;
      if (!d.corner) {
        L.box[0] = r1(clamp(bx + p.x - d.p.x, -bw + 2, 98));
        L.box[1] = r1(clamp(by + p.y - d.p.y, -bh + 2, 98));
      } else {
        const left = d.corner[1] === 'w';
        const top = d.corner[0] === 'n';
        const ax = left ? bx + bw : bx;
        const ay = top ? by + bh : by;
        if (L.kind === 'blur') {
          // a blur box is any rectangle
          L.box = [r1(Math.min(ax, p.x)), r1(Math.min(ay, p.y)), r1(Math.max(2, Math.abs(p.x - ax))), r1(Math.max(2, Math.abs(p.y - ay)))];
        } else {
          // words and logos scale as a whole, anchored at the opposite corner
          const s = Math.max(0.1, ((left ? ax - p.x : p.x - ax) / bw + (top ? ay - p.y : p.y - ay) / bh) / 2);
          L.box[2] = r1(Math.max(3, bw * s));
          if (L.kind === 'text') L.size = r1(clamp(d.size * s, 1, 40));
          L.box[0] = r1(left ? ax - bw * s : ax);
          L.box[1] = r1(top ? ay - bh * s : ay);
        }
      }
      draw();
    },
    true,
  );
  const up = (e) => {
    if (!ve.drag) return;
    e.stopPropagation();
    const d = ve.drag;
    ve.drag = null;
    try {
      ve.layer.releasePointerCapture(e.pointerId);
    } catch {}
    if (d.moved) {
      pushUndo(d.before);
      after();
    }
  };
  fr.addEventListener('pointerup', up, true);
  fr.addEventListener('pointercancel', up, true);
  fr.addEventListener(
    'dblclick',
    (e) => {
      if (!usable(e)) return;
      const L = hitLayer(toPct(e));
      if (!L) return;
      e.stopPropagation();
      if (L.kind === 'text') openEditor(L.id);
    },
    true,
  );
}

// ---------------------------------------------------------------- changing the words, right on the frame

export function openEditor(id = ve.sel) {
  const L = layerById(id);
  if (!L || L.kind !== 'text') return;
  if (isPlaying()) pause();
  closeEditor(true);
  if (!shows(L, currentTime())) seek(L.t[0] + 0.01, { exact: true });
  ve.sel = id;
  const b = boxOf(L);
  const input = h('textarea.ov-input', { value: L.text || '', rows: 2, 'aria-label': 'Text on the frame', spellcheck: 'true' });
  const top = b[1] + b[3] > 78 ? Math.max(0, b[1] - 18) : b[1] + b[3] + 1;
  const wrap = h('div.ov-editor.is-long.ve-editor', { style: { left: clamp(b[0], 0, 60) + '%', top: top + '%', width: Math.max(28, b[2]) + '%' } }, input, h('span.ov-editor-hint', 'Enter saves · Shift+Enter new line · Esc cancels'));
  ve.editor = { id, before: snap(), wrap, input };
  store.ui.editingText = true;
  ve.layer.append(wrap);
  input.addEventListener('input', () => {
    const l = mut().layers.find((x) => x.id === id);
    if (l) l.text = input.value;
    draw();
  });
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeEditor(false);
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      closeEditor(true);
    }
  });
  input.addEventListener('blur', () => closeEditor(true));
  input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  draw();
  bus.emit('hint', {});
  input.focus();
  input.select();
}

function closeEditor(keepIt) {
  const ed = ve.editor;
  if (!ed) return;
  ve.editor = null;
  store.ui.editingText = false;
  ed.wrap.remove();
  if (!keepIt) restore(ed.before);
  else {
    if (snap() !== ed.before) pushUndo(ed.before);
    after();
  }
  bus.emit('hint', {});
}

// ---------------------------------------------------------------- actions

const span3 = () => {
  const t = currentTime();
  return [r1(Math.min(t, Math.max(0, D() - 0.5))), r1(Math.min(D(), t + 3))];
};

export function addText() {
  if (!on()) return;
  pause();
  const id = newId('L');
  edit((e) =>
    e.layers.push({ id, kind: 'text', t: span3(), box: [15, 40, 70, 0], text: 'Your text', font: 'display', size: 7, color: '#ffffff', bold: true, align: 'center', bg: false, bgColor: '#000000', bgOpacity: 0.55, shadow: true, fade: true }),
  );
  selectLayer(id);
  setTimeout(() => openEditor(id), 30);
}

export function addBlur() {
  if (!on()) return;
  pause();
  const id = newId('L');
  edit((e) => e.layers.push({ id, kind: 'blur', t: span3(), box: [38, 35, 24, 22], amount: 2.5 }));
  selectLayer(id);
  toast('Drag the box over what to hide, and its corners to fit it.');
}

function addLogoLayer(src) {
  const id = newId('L');
  edit((e) => e.layers.push({ id, kind: 'image', t: [0, r1(D())], box: [76, 6, 18, 0], src, opacity: 1, fade: false }));
  selectLayer(id);
}

/** Upload an image file and put it on the frame (or swap it into layer `swapId`). */
export async function addLogoFile(file, swapId = null) {
  if (!on()) return null;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) {
    toast('Only png, jpg or webp images can go on the frame.', { kind: 'error' });
    return null;
  }
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!store.data.uploads.some((u) => u.id === data.id)) store.data.uploads.push({ id: data.id, name: data.name, type: 'image', from: 'Upload' });
    if (swapId) edit((e) => (e.layers.find((l) => l.id === swapId).src = data.id));
    else addLogoLayer(data.id);
    toast(`Added ${data.name}`);
    return data;
  } catch (e) {
    toast(`Upload failed: ${e.message}`, { kind: 'error', ms: 6000 });
    return null;
  }
}

function pickImage(swapId = null) {
  const inp = h('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp' });
  inp.addEventListener('change', () => {
    const f = inp.files?.[0];
    if (f) addLogoFile(f, swapId);
  });
  inp.click();
}

export function deleteLayer(id = ve.sel) {
  if (!layerById(id)) return;
  edit((e) => {
    e.layers = e.layers.filter((l) => l.id !== id);
  });
  if (ve.sel === id) selectLayer(null);
  toast('Removed · ⌘Z brings it back', { ms: 1600 });
}

function dupLayer(id) {
  const L = layerById(id);
  if (!L) return;
  const nid = newId('L');
  edit((e) => e.layers.push({ ...JSON.parse(JSON.stringify(L)), id: nid, box: [L.box[0] + 3, L.box[1] + 3, ...L.box.slice(2)] }));
  selectLayer(nid);
}

export function setTrim(ix, t) {
  if (!on()) return;
  edit((e) => {
    const tr = e.trim ? [...e.trim] : [0, r3(D())];
    tr[ix] = r3(clamp(t, 0, D()));
    if (tr[1] - tr[0] < 0.1) tr[ix] = ix ? r3(tr[0] + 0.1) : r3(tr[1] - 0.1);
    e.trim = tr[0] <= 0.001 && tr[1] >= D() - 0.001 ? null : tr;
  });
  toast(ix ? `Ends at ${fmtTime(get().trim?.[1] ?? D())}` : `Starts at ${fmtTime(get().trim?.[0] ?? 0)}`, { ms: 1400 });
}

/** X: the first press marks where a cut starts, the second where it ends. */
export function cutKey() {
  if (!on()) return;
  const t = r3(currentTime());
  if (ve.cutStart == null) {
    pause();
    ve.cutStart = t;
    renderTimeline();
    bus.emit('vedit', {});
    bus.emit('hint', {});
    return;
  }
  const a = Math.min(ve.cutStart, t);
  const b = Math.max(ve.cutStart, t);
  ve.cutStart = null;
  bus.emit('hint', {});
  if (b - a < 0.05) {
    renderTimeline();
    bus.emit('vedit', {});
    toast('That cut is too short. Move the playhead first.');
    return;
  }
  edit((e) => {
    e.cuts.push([a, b]);
    e.cuts.sort((p, q) => p[0] - q[0]);
  });
  seek(b, { exact: true });
  toast(`Cut ${fmtTime(a)}–${fmtTime(b)} (${(b - a).toFixed(1)} s)`);
}

export function cancelCut() {
  if (ve.cutStart == null) return false;
  ve.cutStart = null;
  renderTimeline();
  bus.emit('vedit', {});
  bus.emit('hint', {});
  return true;
}

export function setOriginal(v) {
  if (ve.orig === v || !on()) return;
  ve.orig = v;
  draw();
  bus.emit('hint', { text: v ? 'The original, without your edits · let go of \\ to come back' : null });
}

// ---------------------------------------------------------------- the timeline: trim, cuts, layers lane

const pct = (t) => (D() ? (t / D()) * 100 : 0) + '%';

function renderTimeline() {
  const parts = timelineParts();
  if (!parts.edit) return;
  const { edit: host, layersLane, layersLabel, root } = parts;
  if (!on() || !D()) {
    host.replaceChildren();
    layersLane.hidden = layersLabel.hidden = true;
    root.classList.remove('has-layers');
    return;
  }
  const e = get();
  const d = D();
  const a = e.trim ? e.trim[0] : 0;
  const b = e.trim ? e.trim[1] : d;
  const kids = [];
  if (a > 0) kids.push(h('div.ve-shade', { style: { left: 0, width: pct(a) } }));
  if (b < d) kids.push(h('div.ve-shade', { style: { left: pct(b), right: 0 } }));
  e.cuts.forEach((c, i) =>
    kids.push(
      h(
        'div.ve-cut',
        { style: { left: pct(c[0]), width: pct(c[1] - c[0]) }, title: `Cut ${fmtTime(c[0])}–${fmtTime(c[1])} · drag an edge` },
        h('i.ve-grip', { dataset: { cut: i, edge: 0 } }),
        h('i.ve-grip.r', { dataset: { cut: i, edge: 1 } }),
      ),
    ),
  );
  // the parts that stay, as chips on the top row
  const k = keep();
  k.forEach(([p, q], i) =>
    kids.push(h('div.ve-keep', { style: { left: pct(p), width: pct(q - p) }, title: `Part ${i + 1}: ${fmtTime(p)}–${fmtTime(q)}` }, h('span', k.length > 1 ? `${i + 1}` : `${(outDur() ?? d).toFixed(1)} s`))),
  );
  kids.push(
    h('i.ve-trim.l', { dataset: { trim: 0 }, style: { left: pct(a) }, title: 'Drag to trim the start · I sets it at the playhead' }),
    h('i.ve-trim.r', { dataset: { trim: 1 }, style: { left: pct(b) }, title: 'Drag to trim the end · O sets it at the playhead' }),
  );
  if (ve.cutStart != null) kids.push(h('span.ve-mark', { style: { left: pct(ve.cutStart) } }, h('b', 'cut from')));
  host.replaceChildren(...kids);

  const Ls = e.layers;
  layersLane.hidden = layersLabel.hidden = !Ls.length;
  root.classList.toggle('has-layers', Ls.length > 0);
  root.style.setProperty('--layers-h', Ls.length * 21 + 4 + 'px');
  layersLane.replaceChildren(
    ...Ls.map((L, i) =>
      h(
        'div.ve-bar.ve-' + L.kind + (L.id === ve.sel ? '.is-on' : ''),
        { dataset: { layer: L.id }, style: { top: i * 21 + 2 + 'px', left: pct(L.t[0]), width: pct(L.t[1] - L.t[0]) }, title: `${label(L)} · ${fmtTime(L.t[0])}–${fmtTime(L.t[1])} · drag to move, edges to change when` },
        h('i', { dataset: { edge: 0 } }),
        h('span', label(L)),
        h('i', { dataset: { edge: 1 } }),
      ),
    ),
  );
}

function wireTimeline() {
  const { area } = timelineParts();
  if (!area) return;
  const tAt = (x) => {
    const r = area.getBoundingClientRect();
    return clamp(((x - r.left) / r.width) * D(), 0, D());
  };
  const snapT = (t) => {
    const r = area.getBoundingClientRect();
    const px = (6 * D()) / r.width;
    const cands = [currentTime(), 0, D(), ...keep().flat()];
    const n = cands.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best), Infinity);
    return Math.abs(n - t) < px ? n : t;
  };
  area.addEventListener('pointerdown', (e) => {
    if (!on() || e.button !== 0) return;
    const tr = e.target.closest('[data-trim]');
    const cu = e.target.closest('[data-cut]');
    const bar = e.target.closest('[data-layer]');
    if (!tr && !cu && !bar) return;
    e.stopPropagation(); // not a scrub
    e.preventDefault();
    try {
      area.setPointerCapture(e.pointerId);
    } catch {}
    const base = { x0: e.clientX, t0: tAt(e.clientX), before: snap(), moved: false };
    if (tr) ve.tdrag = { ...base, type: 'trim', ix: +tr.dataset.trim };
    else if (cu) ve.tdrag = { ...base, type: 'cut', i: +cu.dataset.cut, edge: +cu.dataset.edge };
    else {
      const L = layerById(bar.dataset.layer);
      if (!L) return;
      const edge = e.target.closest('i[data-edge]');
      ve.tdrag = { ...base, type: edge ? 'ledge' : 'lmove', id: L.id, edge: edge ? +edge.dataset.edge : null, t: [...L.t] };
      if (ve.sel !== L.id) selectLayer(L.id);
    }
  });
  area.addEventListener('pointermove', (e) => {
    const d = ve.tdrag;
    if (!d) return;
    e.stopPropagation();
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const ed = mut();
    const dd = D();
    const t = snapT(tAt(e.clientX));
    if (d.type === 'trim') {
      const tr = ed.trim ? [...ed.trim] : [0, r3(dd)];
      tr[d.ix] = r3(d.ix ? Math.max(t, tr[0] + 0.1) : Math.min(t, tr[1] - 0.1));
      ed.trim = tr;
      pause();
      seek(tr[d.ix], { exact: true });
    } else if (d.type === 'cut') {
      const c = ed.cuts[d.i];
      if (!c) return;
      c[d.edge] = r3(d.edge ? Math.max(t, c[0] + 0.05) : Math.min(t, c[1] - 0.05));
      pause();
      seek(c[d.edge], { exact: true });
    } else {
      const L = ed.layers.find((l) => l.id === d.id);
      if (!L) return;
      if (d.type === 'ledge') {
        L.t[d.edge] = r1(d.edge ? Math.max(t, L.t[0] + 0.2) : Math.min(t, L.t[1] - 0.2));
        pause();
        seek(L.t[d.edge], { exact: true });
      } else {
        const len = d.t[1] - d.t[0];
        const s = clamp(d.t[0] + tAt(e.clientX) - d.t0, 0, dd - len);
        L.t = [r1(s), r1(s + len)];
      }
    }
    renderTimeline();
    draw();
  });
  const up = (e) => {
    const d = ve.tdrag;
    if (!d) return;
    e.stopPropagation();
    ve.tdrag = null;
    try {
      area.releasePointerCapture(e.pointerId);
    } catch {}
    if (!d.moved) {
      if (d.type === 'lmove') {
        const L = layerById(d.id);
        if (L && !shows(L, currentTime())) seek(L.t[0] + 0.01, { exact: true });
      }
      return;
    }
    const ed = mut();
    if (ed.trim && ed.trim[0] <= 0.001 && ed.trim[1] >= D() - 0.001) ed.trim = null;
    pushUndo(d.before);
    after();
  };
  area.addEventListener('pointerup', up);
  area.addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- the Edit tab for a plain video

function section(title, extra, ...kids) {
  return h('section.psec', h('div.ve-sec-head', h('h3.psec-title', title), extra), ...kids);
}

function numInput(v, label, onSet) {
  const inp = h('input.input.input-num.mono', { type: 'number', step: 0.1, min: 0, max: r3(D()), value: String(r1(v)), 'aria-label': label });
  inp.addEventListener('change', () => {
    const n = parseFloat(inp.value);
    if (Number.isFinite(n)) onSet(n);
  });
  return inp;
}

/** Undo for slider drags and checkbox runs: one step per gesture. */
let armed = null;
const arm = () => (armed = armed || snap());
const commit = () => {
  if (armed && armed !== snap()) {
    pushUndo(armed);
    armed = null;
    after();
  } else armed = null;
};

function rangeRow(lab, value, min, max, step, show, onInput) {
  const out = h('span.mono.slider-val', show(value));
  const r = h('input.range', { type: 'range', min, max, step, value: String(value), 'aria-label': lab });
  r.addEventListener('pointerdown', arm);
  r.addEventListener('keydown', arm);
  r.addEventListener('input', () => {
    arm();
    out.textContent = show(+r.value);
    onInput(+r.value);
    persist();
    draw();
  });
  r.addEventListener('change', commit);
  return h('div.field.slider.ve-range', h('div.field-row', h('label.field-label', lab), out), r);
}

function check(L, key, lab) {
  const c = h('input', { type: 'checkbox', checked: !!L[key] });
  c.addEventListener('change', () => edit((e) => (e.layers.find((l) => l.id === L.id)[key] = c.checked)));
  return h('label.ve-check', c, lab);
}

export function renderPane() {
  const e = get();
  const d = D();
  const a = e.trim ? e.trim[0] : 0;
  const b = e.trim ? e.trim[1] : d;
  const od = outDur();
  const wrap = h('div.edit.ve-pane');
  wrap.append(
    h(
      'div.el-head',
      h('div.el-title', h('h2', store.reel.title)),
      h('div.el-meta', h('span.mono', `${store.reel.w}×${store.reel.h} · ${fmtTime(d)}`)),
      h('p.muted.small.lead', 'A plain video. Trim it, cut parts out, put words, a logo or a blur on it, and set the colour. Export applies it all. Right-click the frame (or C) to leave a note for Claude.'),
    ),
  );

  // Timing
  const cutRows = e.cuts.map((c, i) =>
    h(
      'div.ve-row',
      h('b.ve-cut-label', 'Cut'),
      numInput(c[0], `Cut ${i + 1} from`, (v) => edit((ed) => setCutEdge(ed, i, 0, v))),
      '–',
      numInput(c[1], `Cut ${i + 1} to`, (v) => edit((ed) => setCutEdge(ed, i, 1, v))),
      h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Play across this cut', 'aria-label': 'Play across this cut', onclick: () => (seek(Math.max(0, c[0] - 1.5)), play()) }, icon('play', 14)),
      h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Put this part back', 'aria-label': 'Put this part back', onclick: () => edit((ed) => ed.cuts.splice(i, 1)) }, icon('x', 14)),
    ),
  );
  const cutBtn =
    ve.cutStart == null
      ? h('button.btn.btn-sm', { type: 'button', onclick: cutKey }, '✂ Cut from the playhead · X')
      : [h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: cutKey }, '✂ Cut ends here · X'), h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: cancelCut }, 'Cancel'), h('span.small.muted', `from ${fmtTime(ve.cutStart)}`)];
  wrap.append(
    section(
      'Timing',
      null,
      h('div.ve-row', h('span.ve-row-label', 'Starts at'), numInput(a, 'Starts at', (v) => setTrim(0, v)), h('button.btn.btn-sm', { type: 'button', onclick: () => setTrim(0, currentTime()) }, 'Playhead · I')),
      h('div.ve-row', h('span.ve-row-label', 'Ends at'), numInput(b, 'Ends at', (v) => setTrim(1, v)), h('button.btn.btn-sm', { type: 'button', onclick: () => setTrim(1, currentTime()) }, 'Playhead · O')),
      cutRows,
      h('div.ve-row', cutBtn),
      h('p.small.muted', timingOn() ? ['Final length ', h('b', `${od.toFixed(1)} s`), ` (was ${d.toFixed(1)} s). Playback skips the cuts.`] : `Length ${d.toFixed(1)} s. Drag the brackets on the timeline to trim.`),
    ),
  );

  // On the frame
  wrap.append(
    section(
      'On the frame',
      null,
      h(
        'div.row-actions',
        h('button.btn.btn-sm', { type: 'button', onclick: addText }, '+ Text · T'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => pickImage() }, icon('image', 15), 'Logo'),
        h('button.btn.btn-sm', { type: 'button', onclick: addBlur }, '+ Blur'),
      ),
      e.layers.length ? h('ul.el-list.ve-layers', e.layers.map(layerCard)) : h('p.small.muted', 'Words, a logo, or a blur over something to hide. Drag on the frame to move, corners to resize.'),
    ),
  );

  // Colour
  wrap.append(
    section(
      'Colour',
      lookOn() ? h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: () => edit((ed) => (ed.look = { ...ZERO })) }, icon('undo', 14), 'Reset') : null,
      LOOKS.map(([k, lab]) => {
        const v = Math.round((+e.look[k] || 0) * 100);
        return rangeRow(lab, v, -100, 100, 1, (x) => (x > 0 ? '+' : '') + x, (x) => (mut().look[k] = x / 100));
      }),
      hasEdits() ? holdOriginalBtn() : null,
    ),
  );
  return wrap;
}

function setCutEdge(ed, i, ix, v) {
  const c = ed.cuts[i];
  if (!c) return;
  c[ix] = r3(clamp(v, 0, D()));
  if (c[1] < c[0]) c.reverse();
  ed.cuts.sort((p, q) => p[0] - q[0]);
}

function holdOriginalBtn() {
  const b = h('button.btn.btn-sm.btn-ghost', { type: 'button' }, icon('compare', 15), 'Hold to see the original · \\');
  const off = () => setOriginal(false);
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    setOriginal(true);
    window.addEventListener('pointerup', off, { once: true });
  });
  return b;
}

function layerCard(L) {
  const sel = L.id === ve.sel;
  const ico = L.kind === 'text' ? 'edit' : L.kind === 'image' ? 'image' : 'note';
  const head = h(
    'button.el-item' + (sel ? '.is-on' : ''),
    {
      type: 'button',
      'aria-expanded': sel ? 'true' : 'false',
      onclick: () => {
        const opening = ve.sel !== L.id;
        selectLayer(opening ? L.id : null);
        if (opening && !shows(L, currentTime())) {
          pause();
          seek(L.t[0] + 0.01, { exact: true });
        }
      },
    },
    icon(ico, 15),
    h('span.el-item-label', label(L)),
    h('span.mono.muted.small', `${fmtTime(L.t[0])}–${fmtTime(L.t[1])}`),
  );
  if (!sel) return h('li', head);
  const set = (k, v) => edit((e) => (e.layers.find((l) => l.id === L.id)[k] = v));
  const live = (k, v) => {
    const l = mut().layers.find((x) => x.id === L.id);
    if (l) l[k] = v;
  };
  const f = [];
  if (L.kind === 'text') {
    const ta = h('textarea.input', { rows: 2, value: L.text || '', 'aria-label': 'Words' });
    ta.addEventListener('focus', arm);
    ta.addEventListener('input', () => {
      live('text', ta.value);
      persist();
      draw();
    });
    ta.addEventListener('change', commit);
    const font = h(
      'select.input.input-auto',
      { 'aria-label': 'Font' },
      Object.entries(FONTS).map(([id, [n]]) => h('option', { value: id, selected: (L.font || 'display') === id }, n)),
    );
    font.addEventListener('change', () => {
      set('font', font.value);
      document.fonts?.load(fontOf({ ...L, font: font.value }, 40)).then(() => draw());
    });
    const color = h('input.swatch', { type: 'color', value: L.color || '#ffffff', 'aria-label': 'Text colour' });
    color.addEventListener('pointerdown', arm);
    color.addEventListener('input', () => {
      arm();
      live('color', color.value);
      draw();
    });
    color.addEventListener('change', commit);
    const align = h(
      'div.seg',
      { role: 'radiogroup', 'aria-label': 'Align' },
      [
        ['left', 'L'],
        ['center', 'C'],
        ['right', 'R'],
      ].map(([v, l]) => h('button.seg-btn' + ((L.align || 'center') === v ? '.is-on' : ''), { type: 'button', role: 'radio', 'aria-checked': (L.align || 'center') === v ? 'true' : 'false', 'aria-label': 'Align ' + v, onclick: () => set('align', v) }, l)),
    );
    f.push(
      ta,
      h('div.ve-row', font, color, align),
      rangeRow('Size', L.size, 1, 30, 0.5, (x) => x + '%', (x) => live('size', x)),
      h('div.ve-row.ve-checks', check(L, 'bold', 'Bold'), check(L, 'shadow', 'Shadow'), check(L, 'fade', 'Fade in/out'), check(L, 'bg', 'Background')),
    );
    if (L.bg) {
      const bgc = h('input.swatch', { type: 'color', value: L.bgColor || '#000000', 'aria-label': 'Background colour' });
      bgc.addEventListener('pointerdown', arm);
      bgc.addEventListener('input', () => {
        arm();
        live('bgColor', bgc.value);
        draw();
      });
      bgc.addEventListener('change', commit);
      f.push(h('div.ve-row', h('span.ve-row-label', 'Background'), bgc), rangeRow('Background opacity', Math.round((L.bgOpacity ?? 0.6) * 100), 0, 100, 1, (x) => x + '%', (x) => live('bgOpacity', x / 100)));
    }
  } else if (L.kind === 'image') {
    const pics = new Map();
    for (const a of [...(store.reel.assets || []), ...store.data.uploads]) if (a.type === 'image') pics.set(a.id, a.name || a.id.split('/').pop());
    for (const l of get().layers) if (l.kind === 'image' && l.src && !pics.has(l.src)) pics.set(l.src, l.src.split('/').pop());
    const pick = h('select.input.input-auto', { 'aria-label': 'Image' }, [...pics].map(([id, n]) => h('option', { value: id, selected: id === L.src }, n)));
    pick.addEventListener('change', () => set('src', pick.value));
    f.push(
      h('div.ve-row', pick, h('button.btn.btn-sm', { type: 'button', onclick: () => pickImage(L.id) }, icon('upload', 15), 'Another')),
      rangeRow('Opacity', Math.round((L.opacity ?? 1) * 100), 5, 100, 1, (x) => x + '%', (x) => live('opacity', x / 100)),
      h('div.ve-row.ve-checks', check(L, 'fade', 'Fade in/out')),
    );
  } else {
    f.push(rangeRow('Strength', L.amount, 0.5, 10, 0.5, (x) => String(x), (x) => live('amount', x)));
  }
  const tIn = (ix) =>
    numInput(L.t[ix], ix ? 'Shows until' : 'Shows from', (v) =>
      edit((e) => {
        const l = e.layers.find((x) => x.id === L.id);
        l.t[ix] = r1(clamp(v, 0, D()));
        if (l.t[1] < l.t[0] + 0.2) l.t[ix] = ix ? r1(l.t[0] + 0.2) : r1(Math.max(0, l.t[1] - 0.2));
      }),
    );
  const tPh = (ix) =>
    h(
      'button.btn.btn-ghost.btn-xs',
      {
        type: 'button',
        title: ix ? 'End at the playhead' : 'Start at the playhead',
        'aria-label': ix ? 'End at the playhead' : 'Start at the playhead',
        onclick: () =>
          edit((e) => {
            const l = e.layers.find((x) => x.id === L.id);
            const t = r1(currentTime());
            l.t[ix] = ix ? Math.max(t, l.t[0] + 0.2) : Math.min(t, l.t[1] - 0.2);
          }),
      },
      ix ? '⇥' : '⇤',
    );
  f.push(
    h('div.ve-row', h('span.ve-row-label', 'Shows'), tIn(0), tPh(0), '–', tIn(1), tPh(1)),
    h(
      'div.row-actions',
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => dupLayer(L.id) }, icon('copy', 15), 'Duplicate'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => deleteLayer(L.id) }, icon('trash', 15), 'Delete'),
    ),
  );
  return h('li.ve-layer.is-open', head, h('div.ve-fields', f));
}

// ---------------------------------------------------------------- hints, keys

/** The hint line while editing a plain video, or null for the usual one. */
export function hint() {
  if (!on()) return null;
  if (ve.cutStart != null) return `Cut starts at ${fmtTime(ve.cutStart)} · go to where it ends and press X again · Esc cancels`;
  if (isPlaying()) return null;
  const S = selectedLayer();
  if (S) {
    const words = S.kind === 'text' ? 'double-click or Enter to change the words · ' : '';
    return `${label(S)}: drag to move · drag a corner to resize · ${words}Delete removes · Esc lets go`;
  }
  return 'Space plays · T adds text · I and O trim · X twice cuts a part · right-click to leave a note · ? for shortcuts';
}

/** Keys for editing (called by keys.js before its own). True when handled. */
export function onKey(e) {
  if (!on() || ve.editor) return false;
  const k = e.key;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (k === 'z' || k === 'Z') && e.shiftKey) return redoEdit();
  if (mod && (k === 'y' || k === 'Y')) return redoEdit();
  if (mod && (k === 'z' || k === 'Z')) return undoEdit();
  if (mod || e.altKey) return false;
  switch (k) {
    case 'i':
    case 'I':
      setTrim(0, currentTime());
      return true;
    case 'o':
    case 'O':
      setTrim(1, currentTime());
      return true;
    case 'x':
    case 'X':
      cutKey();
      return true;
    case 't':
    case 'T':
      addText();
      return true;
    case 'Delete':
    case 'Backspace':
      if (!ve.sel) return false;
      deleteLayer(ve.sel);
      return true;
    case 'Enter':
      if (selectedLayer()?.kind !== 'text') return false;
      openEditor(ve.sel);
      return true;
    case 'Escape':
      if (cancelCut()) return true;
      if (!ve.sel) return false;
      selectLayer(null);
      return true;
    case '\\':
      if (!e.repeat) setOriginal(true);
      return true;
    default:
      return false;
  }
}

export function onKeyUp(e) {
  if (e.key === '\\') setOriginal(false);
}

// ---------------------------------------------------------------- export

/** One line for the export dialog: what the edits are. */
export function summary() {
  if (!hasEdits()) return '';
  const e = get();
  const p = [];
  if (timingOn()) p.push(`${outDur().toFixed(1)} s long after the trim${e.cuts.length ? ` and ${e.cuts.length} cut${e.cuts.length === 1 ? '' : 's'}` : ''}`);
  const n = (k) => e.layers.filter((l) => l.kind === k).length;
  const w = (c, s) => (c ? `${c} ${s}${c === 1 ? '' : 's'}` : '');
  for (const x of [w(n('text'), 'text'), w(n('image'), 'logo'), w(n('blur'), 'blur')]) if (x) p.push(x);
  if (lookOn()) p.push('the colour look');
  return p.join(', ');
}

/** The edits for POST /api/export { mode: 'edit' }: text and logos drawn as full-frame PNGs. */
export async function exportEdit() {
  const e = get();
  const W = store.reel.w;
  const H = store.reel.h;
  const out = [];
  await document.fonts?.ready;
  for (const L of [...e.layers.filter((l) => l.kind === 'blur'), ...e.layers.filter((l) => l.kind !== 'blur')]) {
    if (L.kind === 'blur') {
      out.push({ kind: 'blur', t: L.t, box: L.box, amount: L.amount });
      continue;
    }
    if (L.kind === 'text') await document.fonts?.load(fontOf(L, 40));
    if (L.kind === 'image') {
      const img = imgFor(L.src);
      if (!img) continue;
      if (!img.complete) await img.decode().catch(() => {});
      if (!img.naturalWidth) continue;
    }
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    drawLayer(c.getContext('2d'), L, W, H, L.t[0], true);
    out.push({ kind: L.kind, t: L.t, fade: !!L.fade, png: c.toDataURL('image/png') });
  }
  return { trim: e.trim, cuts: e.cuts, look: e.look, layers: out };
}
