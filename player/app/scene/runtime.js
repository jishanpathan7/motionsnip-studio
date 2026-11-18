// MotionSnip Scenes in the browser: the live renderer the player loads for a scene project
// (reel.live = { type: 'scene', spec: 'scene.json' }). It follows the player's clock: the player calls
// seek(t) every frame, so there's no clock of our own, and the same t always draws the same picture.

import { normScene, setPath } from './compile.mjs';
import { frameSVG } from './draw.mjs';
import { prepare } from './motion.mjs';

const FONT_HREF = '/app/fonts/fonts.css'; // Patrick Hand, served with the player

function ensureFont() {
  if (document.querySelector(`link[data-scene-font]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = FONT_HREF;
  l.dataset.sceneFont = '';
  document.head.append(l);
}

/**
 * host: the element to draw into. raw: scene.json as parsed. opts.asset(path) → URL for image props.
 * Returns the live-renderer API: seek, play, pause, setRate, setBoxes, plus setProps, frameAt and spec.
 */
export function createScene(host, raw, opts = {}) {
  ensureFont();
  let base = raw;
  let patches = [];
  let nudges = {};
  let spec = normScene(raw);
  let t = 0;
  let queued = false;
  let last = '';

  // a moved box becomes an offset of that thing in that shot: { shotId: { entity: [dx, dy, k] } }
  const adjust = (st) => {
    const shot = spec.shots[st.i];
    const n = shot && nudges[shot.id];
    if (!n) return st;
    for (const [id, [dx, dy, k]] of Object.entries(n)) {
      const e = st.ents[id];
      if (!e) continue;
      const moved = [id, ...(e.hold ? [e.hold] : [])];
      for (const m of moved) {
        const q = st.ents[m];
        if (!q) continue;
        q.x += dx;
        q.y += dy;
        if (m === id) q.scale *= k;
      }
    }
    return st;
  };

  const draw = () => {
    queued = false;
    const svg = frameSVG(spec, t, { uid: 'ms-scene', asset: opts.asset, adjust });
    if (svg === last) return;
    last = svg;
    host.innerHTML = svg;
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };

  const rebuild = () => {
    let r = base;
    for (const p of patches) {
      try {
        r = setPath(r, p.path, p.value);
      } catch (e) {
        console.warn('[motionsnip] scene edit skipped:', p.path, e.message);
      }
    }
    spec = normScene(r);
    prepare(spec);
    last = '';
    schedule();
  };

  host.classList.add('scene-host');
  draw();

  return {
    seek(v) {
      if (!Number.isFinite(v) || v === t) return;
      t = v;
      schedule();
    },
    play() {},
    pause() {},
    setRate() {},
    /** boxes: { elId: [x, y, w, h, nx, ny, nw, nh] } in % of the frame (elId is "entity@shot"). */
    setBoxes(boxes = {}) {
      const [W, H] = spec.size;
      const next = {};
      for (const [elId, b] of Object.entries(boxes)) {
        const [id, shotId] = String(elId).split('@');
        if (!shotId || !(spec.cast[id] || spec.props[id]) || !Array.isArray(b) || b.length < 8) continue;
        const [x, y, w, h, nx, ny, nw, nh] = b.map(Number);
        const dx = ((nx + nw / 2 - (x + w / 2)) / 100) * W;
        const dy = ((ny + nh - (y + h)) / 100) * H;
        const k = h > 0 ? nh / h : 1;
        (next[shotId] ||= {})[id] = [dx, dy, Number.isFinite(k) && k > 0 ? k : 1];
      }
      nudges = next;
      last = '';
      schedule();
    },
    /** edits: { elId: { prop: value } } (any renderer); scenePatches: [{ path, value }] in scene.json (this one). */
    setProps(edits, scenePatches = []) {
      patches = Array.isArray(scenePatches) ? scenePatches : [];
      rebuild();
    },
    /** A new scene.json (after Claude's change or Apply). Keeps the time. */
    load(nextRaw) {
      base = nextRaw;
      rebuild();
    },
    /** The SVG for any time, without touching the page: frame grabs and export. */
    frameAt(v) {
      return frameSVG(spec, v, { uid: 'ms-frame', asset: opts.asset, adjust });
    },
    get spec() {
      return spec;
    },
  };
}
