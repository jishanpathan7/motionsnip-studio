// Drawing a timeline's graphics: text with its animation presets, shapes, images, captions, and the transform
// every visual clip shares (keyframes and transitions). The live preview and the export call the same functions,
// so what you see is what you get. Canvas 2D only; nothing here touches the page.
import { clipState, textShown, ease } from './timeline.mjs';

export const FONT_STACK = {
  'Bricolage Grotesque': '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif',
  'DM Mono': '"DM Mono", ui-monospace, Menlo, monospace',
  'Patrick Hand': '"Patrick Hand", "Comic Sans MS", cursive',
  'system-ui': 'system-ui, -apple-system, "Segoe UI", sans-serif',
};
const stack = (f) => FONT_STACK[f] || `"${String(f).replace(/["\\]/g, '')}", system-ui, sans-serif`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FULL = [0, 0, 100, 100];
const CAPTION_BOX = [8, 78, 84, 16];

/** A clip's box in pixels before its transform: [x, y, w, h]. */
export function rectOf(clip, W, H, kind = clip.kind) {
  const b = kind === 'captions' ? CAPTION_BOX : clip.box || FULL;
  return [(b[0] / 100) * W, (b[1] / 100) * H, (b[2] / 100) * W, (b[3] / 100) * H];
}

/** The text animation preset at local time u: { dy (px), scale, opacity, word(i) → { a, dy } }. */
export function presetAt(clip, u, H) {
  const p = clip.preset || 'none';
  const out = { dy: 0, scale: 1, opacity: 1, word: null };
  if (p === 'none') return out;
  const tail = clip.dur - u;
  if (p !== 'type-on' && tail < 0.25) out.opacity *= clamp(tail / 0.25, 0, 1);
  if (p === 'fade') out.opacity *= ease('out', u / 0.4);
  else if (p === 'pop') {
    const q = clamp(u / 0.45, 0, 1);
    const c = 1.70158;
    out.scale = 0.6 + 0.4 * (1 + (c + 1) * (q - 1) ** 3 + c * (q - 1) ** 2); // back-out: overshoots, settles at 1
    out.opacity *= clamp(u / 0.15, 0, 1);
  } else if (p === 'slide-up') {
    const e = ease('out', u / 0.5);
    out.dy = (1 - e) * 0.06 * H;
    out.opacity *= clamp(u / 0.3, 0, 1);
  } else if (p === 'word-stagger') {
    out.word = (i) => {
      const e = ease('out', (u - i * 0.08) / 0.35);
      return { a: e, dy: (1 - e) * 0.03 * H };
    };
  }
  return out;
}

/**
 * Run draw() with a clip's transform applied: shift, scale and rotate about the box centre, opacity, and a wipe
 * that reveals the box from the left. st: clipState(); rect: rectOf().
 */
export function withTransform(g, rect, st, W, H, draw) {
  const [x, y, w, h] = rect;
  const cx = x + w / 2 + (st.x / 100) * W;
  const cy = y + h / 2 + (st.y / 100) * H;
  g.save();
  g.globalAlpha *= clamp(st.opacity, 0, 1);
  g.translate(cx, cy);
  if (st.rotate) g.rotate((st.rotate * Math.PI) / 180);
  if (st.scale !== 1) g.scale(st.scale, st.scale);
  g.translate(-w / 2, -h / 2);
  if (st.reveal < 1) {
    g.beginPath();
    g.rect(0, 0, w * clamp(st.reveal, 0, 1), h);
    g.clip();
  }
  draw(w, h);
  g.restore();
}

/** The same transform as CSS for a DOM layer (video, scene) in a frame W×H px: left/top/width/height in %. */
export function cssFor(rect, st, W, H) {
  const [x, y, w, h] = rect;
  const css = {
    left: `${(x / W) * 100}%`,
    top: `${(y / H) * 100}%`,
    width: `${(w / W) * 100}%`,
    height: `${(h / H) * 100}%`,
    transform: `translate(${st.x * (W / w)}%, ${st.y * (H / h)}%) rotate(${st.rotate || 0}deg) scale(${st.scale})`,
    opacity: String(clamp(st.opacity, 0, 1)),
    clipPath: st.reveal < 1 ? `inset(0 ${(1 - clamp(st.reveal, 0, 1)) * 100}% 0 0)` : '',
  };
  return css;
}

function wrap(g, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = [];
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = [...line, word].join(' ');
      if (line.length && g.measureText(next).width > maxW) {
        lines.push(line);
        line = [word];
      } else line.push(word);
    }
    lines.push(line);
  }
  return lines;
}

function rounded(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/** Text in its box: wrapped to the box width, centred in its height, with the clip's preset. */
function drawText(g, clip, u, w, h, H) {
  const s = clip.style;
  const fs = (s.size / 100) * H;
  const lh = fs * 1.15;
  g.font = `${s.weight} ${fs}px ${stack(s.font)}`;
  g.textBaseline = 'middle';
  const pr = presetAt(clip, u, H);
  const text = textShown(clip, u);
  const all = wrap(g, clip.text || '', w);
  // type-on keeps the layout of the whole text, so lines don't jump as letters arrive
  let left = text.length;
  const lines = all.map((ws) =>
    ws
      .map((word) => {
        const shown = word.slice(0, Math.max(0, left));
        left -= word.length + 1;
        return { word, shown };
      })
      .filter((x) => x.shown || clip.preset !== 'type-on'),
  );
  const total = all.length * lh;
  const top = (h - total) / 2;
  g.save();
  g.globalAlpha *= pr.opacity;
  g.translate(w / 2, h / 2 + pr.dy);
  g.scale(pr.scale, pr.scale);
  g.translate(-w / 2, -h / 2);
  if (s.bg) {
    const mw = Math.max(...all.map((ws) => g.measureText(ws.join(' ')).width), 1);
    const pad = fs * 0.4;
    const bw = Math.min(w + pad * 2, mw + pad * 2);
    const bx = s.align === 'left' ? -pad : s.align === 'right' ? w - bw + pad : (w - bw) / 2;
    g.fillStyle = s.bg;
    rounded(g, bx, top - pad * 0.6, bw, total + pad * 1.2, fs * 0.25);
    g.fill();
  }
  if (s.shadow) {
    g.shadowColor = 'rgba(0,0,0,.45)';
    g.shadowBlur = fs * 0.12;
    g.shadowOffsetY = fs * 0.04;
  }
  g.fillStyle = s.color;
  g.textAlign = 'left';
  let wi = 0;
  const space = g.measureText(' ').width;
  all.forEach((ws, li) => {
    const lw = g.measureText(ws.join(' ')).width;
    let x = s.align === 'left' ? 0 : s.align === 'right' ? w - lw : (w - lw) / 2;
    const y = top + li * lh + lh / 2;
    for (const { word, shown } of lines[li] || []) {
      const ww = g.measureText(word).width;
      if (pr.word) {
        const q = pr.word(wi);
        g.save();
        g.globalAlpha *= clamp(q.a, 0, 1);
        g.fillText(shown, x, y + q.dy);
        g.restore();
      } else g.fillText(shown, x, y);
      x += ww + space;
      wi++;
    }
  });
  g.restore();
}

/**
 * Draw one graphics or captions layer (from evalAt) onto g, a canvas W×H px.
 * opts.img(src) → a loaded image or null. Blur boxes blur what is already on g (opts.blur: false skips them).
 */
export function drawGraphic(g, layer, W, H, opts = {}) {
  const { clip, u } = layer;
  const kind = layer.track?.kind || clip.kind;
  const st = layer.state || clipState(clip, u);
  const rect = rectOf(clip, W, H, kind);
  if (kind === 'captions') return drawCaption(g, clip, rect, st, W, H);
  if (clip.type === 'blur') {
    if (opts.blur === false) return;
    // what is under the box, in the canvas's own pixels (g may be scaled to the frame)
    const [x, y, w, h] = rect;
    const m = g.getTransform();
    const px = (clip.amount / 100) * Math.min(W, H) * 0.5 * m.a;
    const src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(w * m.a));
    src.height = Math.max(1, Math.round(h * m.d));
    src.getContext('2d').drawImage(g.canvas, (x + (st.x / 100) * W) * m.a + m.e, (y + (st.y / 100) * H) * m.d + m.f, src.width, src.height, 0, 0, src.width, src.height);
    withTransform(g, rect, { ...st, scale: 1, rotate: 0 }, W, H, (bw, bh) => {
      g.filter = `blur(${px}px)`;
      g.drawImage(src, 0, 0, bw, bh);
      g.filter = 'none';
    });
    return;
  }
  withTransform(g, rect, st, W, H, (w, h) => {
    if (clip.type === 'text') drawText(g, clip, u, w, h, H);
    else if (clip.type === 'shape') {
      g.fillStyle = clip.fill;
      if (clip.shape === 'ellipse') {
        g.beginPath();
        g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else rounded(g, 0, 0, w, h, (clip.radius / 100) * Math.min(w, h));
      g.fill();
    } else if (clip.type === 'image') {
      const img = opts.img?.(clip.src);
      if (img && (img.naturalWidth || img.width)) drawFit(g, img, img.naturalWidth || img.width, img.naturalHeight || img.height, w, h, clip.fit);
    }
  });
}

/** Draw a source sw×sh into w×h at the origin: 'cover' fills and crops, 'contain' fits whole. */
export function drawFit(g, src, sw, sh, w, h, fit = 'contain') {
  if (!sw || !sh) return;
  const k = fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
  const dw = sw * k;
  const dh = sh * k;
  if (fit === 'cover') {
    g.save();
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    g.restore();
  } else g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** A caption: white on a dark box, bottom centre, as subtitles look. */
function drawCaption(g, clip, rect, st, W, H) {
  if (!clip.text) return;
  const fs = 0.048 * H;
  withTransform(g, rect, { ...st, scale: 1, rotate: 0 }, W, H, (w, h) => {
    g.font = `600 ${fs}px ${stack('Bricolage Grotesque')}`;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const lines = wrap(g, clip.text, w - fs).map((ws) => ws.join(' '));
    const lh = fs * 1.25;
    const pad = fs * 0.35;
    const total = lines.length * lh;
    const y0 = h - total - pad;
    const mw = Math.max(...lines.map((l) => g.measureText(l).width));
    g.fillStyle = 'rgba(0,0,0,.62)';
    rounded(g, (w - mw) / 2 - pad * 1.4, y0 - pad, mw + pad * 2.8, total + pad * 2, fs * 0.22);
    g.fill();
    g.fillStyle = '#fff';
    lines.forEach((l, i) => g.fillText(l, w / 2, y0 + i * lh + lh / 2));
  });
}

// ---------------------------------------------------------------- colour looks (same math as the server's lookFilter)

const r3 = (v) => Math.round(v * 1000) / 1000;

/** { brightness, contrast, saturation, warmth } (each −1…1) → a 3×3 colour matrix M, contrast k and offset o. */
export function lookMatrix(l = {}) {
  const s = 1 + (+l.saturation || 0);
  const k = 1 + (+l.contrast || 0);
  const w = +l.warmth || 0;
  const lum = [0.2126, 0.7152, 0.0722];
  const gain = [1 + 0.1 * w, 1 + 0.02 * w, 1 - 0.1 * w];
  return {
    M: [0, 1, 2].map((i) => [0, 1, 2].map((j) => r3(gain[i] * ((1 - s) * lum[j] + (i === j ? s : 0))))),
    k: r3(k),
    o: r3(0.5 - 0.5 * k + 0.2 * (+l.brightness || 0)),
  };
}

/** The look as an SVG filter's feColorMatrix values and feComponentTransfer slope/intercept (for the preview). */
export function lookSvg(l) {
  const { M, k, o } = lookMatrix(l);
  return { values: M.map((r) => [...r, 0, 0].join(' ')).join(' ') + ' 0 0 0 1 0', slope: k, intercept: o };
}

/** Apply a look to the pixels of a canvas (for export): colour matrix, then contrast and brightness. */
export function applyLookPixels(g, w, h, l) {
  const { M, k, o } = lookMatrix(l);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const O = o * 255;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const gg = d[i + 1];
    const b = d[i + 2];
    d[i] = k * (M[0][0] * r + M[0][1] * gg + M[0][2] * b) + O;
    d[i + 1] = k * (M[1][0] * r + M[1][1] * gg + M[1][2] * b) + O;
    d[i + 2] = k * (M[2][0] * r + M[2][1] * gg + M[2][2] * b) + O;
  }
  g.putImageData(img, 0, 0);
}
