// Frames to pixels: an SVG frame (or any drawing on a canvas) → pixels, for export. An SVG drawn as an image
// loads nothing from outside, so the fonts and pictures it uses are fetched once and inlined as data URLs.
// The fonts are the ones served with the player (app/fonts/), so an export needs nothing from the internet.

const FONTS_CSS = new URL('../fonts/fonts.css', import.meta.url).href;
const FAMILIES = ['Patrick Hand', 'Bricolage Grotesque', 'DM Mono'];

const fontCache = new Map();
let fontFaces = null;

const toDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** The @font-face rules of fonts.css. */
function faces() {
  fontFaces ||= fetch(FONTS_CSS)
    .then((r) => (r.ok ? r.text() : ''))
    .then((css) => css.match(/@font-face\s*\{[^}]*\}/g) || [])
    .catch(() => []);
  return fontFaces;
}

/** @font-face rules with the font files inlined, for the families an SVG names. If they can't load: '' (system fonts). */
export async function inlineFonts(svg) {
  const css = [];
  for (const fam of FAMILIES) {
    if (!svg.includes(fam)) continue;
    if (!fontCache.has(fam)) {
      fontCache.set(
        fam,
        (async () => {
          try {
            const rules = (await faces()).filter((r) => r.includes(`'${fam}'`));
            const out = [];
            for (const rule of rules) {
              const m = /url\('?([^')]+)'?\)/.exec(rule);
              if (!m) continue;
              const data = await toDataUrl(await (await fetch(new URL(m[1], FONTS_CSS))).blob());
              out.push(rule.replace(m[0], `url('${data}')`));
            }
            return out.join('\n');
          } catch {
            return '';
          }
        })(),
      );
    }
    css.push(await fontCache.get(fam));
  }
  return css.join('\n');
}

const imageCache = new Map();
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The SVG with every <image href> that isn't a data: URL inlined. A picture that fails to load is left as it is. */
export async function inlineImages(svg) {
  const hrefs = [...new Set([...svg.matchAll(/<image\b[^>]*?\shref="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('data:')))];
  if (!hrefs.length) return svg;
  for (const href of hrefs) {
    if (!imageCache.has(href))
      imageCache.set(
        href,
        fetch(unesc(href))
          .then((r) => (r.ok ? r.blob() : null))
          .then((b) => (b ? toDataUrl(b) : null))
          .catch(() => null),
      );
  }
  let out = svg;
  for (const href of hrefs) {
    const data = await imageCache.get(href);
    if (data) out = out.split(`href="${href}"`).join(`href="${data}"`);
  }
  return out;
}

/** A drawing surface for export frames at w×h. */
export function createRaster(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  /** An SVG document string as a decoded image at w×h, with its web fonts and pictures inlined. */
  async function svgImage(svg, iw = w, ih = h) {
    const fontCss = await inlineFonts(svg);
    let s = (await inlineImages(svg)).replace('width="100%" height="100%"', `width="${iw}" height="${ih}"`);
    if (fontCss) s = s.replace(/<svg[^>]*>/, (m) => `${m}<style>${fontCss}</style>`);
    // a data: URL, not a blob: one: blob URLs load through the browser's network side, where they wait behind
    // the frame uploads of an export (hundreds of ms a frame)
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
    await img.decode();
    return img;
  }

  /** Draw an SVG document string over the canvas (scaled to fill it). */
  async function drawSVG(svg) {
    ctx.drawImage(await svgImage(svg), 0, 0, w, h);
  }

  return {
    canvas,
    ctx,
    clear(color) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
      }
    },
    drawSVG,
    svgImage,
    /** The canvas as PNG bytes. */
    async png() {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error("The browser couldn't encode a frame");
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

/**
 * Stream frames to the server: start → push batches → end. draw(i, t, raster) paints frame i.
 * Frames go as raw RGBA (reading pixels takes milliseconds; encoding a PNG took most of a second at 1080p),
 * and a frame identical to the one before is sent as a repeat, so still stretches cost no upload.
 * opts: { w, h, fps, frames, format, audio, tag, setSrc, captions, compose, onProgress(i, n), signal }. compose: a
 * composeSpec, when ffmpeg draws the video under these frames. Resolves to the final job.
 */
export async function exportFrames(draw, opts) {
  const post = async (url, body, json = true) => {
    const r = await fetch(url, { method: 'POST', headers: json ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  };
  const start = await post(
    '/api/frames-start',
    JSON.stringify({ w: opts.w, h: opts.h, fps: opts.fps, frames: opts.frames, format: opts.format, audio: opts.audio || [], tag: opts.tag, setSrc: opts.setSrc, captions: !!opts.captions, pix: 'rgba', compose: opts.compose || undefined }),
  );
  const job = start.job;
  const raster = createRaster(start.w, start.h);
  const frameBytes = start.w * start.h * 4;
  const perBatch = Math.max(1, Math.floor(24e6 / frameBytes));
  const batch = [];
  let repeats = 0;
  let prev = null;
  let next = 0; // the index of the next frame to send (drawn or repeated)
  let blobs = true;
  let sending = Promise.resolve();
  // One push, sent again when the request fails without an answer. A Blob uploads several times faster than the
  // same bytes as a typed array, but a browser with little blob memory (the desktop app's browser) can refuse to make
  // one (ERR_BLOB_OUT_OF_MEMORY, which fetch reports as "Failed to fetch"); after that, pushes go as plain bytes.
  // ?from= tells the server where the push starts, so frames it already has are not added twice.
  const push = async (query, parts) => {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new Error('Cancelled');
      const body = !parts.length ? new Uint8Array(0) : blobs ? new Blob(parts) : joined(parts);
      try {
        return await post(`/api/frames-push?job=${job}&${query}`, body, false);
      } catch (e) {
        if (e.status || attempt >= 3) throw e; // the server answered: not a transport failure
        if (blobs) console.warn('[motionsnip] a frame upload failed; sending again as plain bytes:', e.message);
        blobs = false;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  };
  // requests go out in order, at most one in flight
  const send = (fn) => {
    sending = sending.then(fn);
    return sending;
  };
  // small batches, one in flight, keep the browser's blob store from filling up
  const flushFrames = () => {
    if (!batch.length) return sending;
    const parts = batch.splice(0);
    const from = next;
    next += parts.length;
    return send(() => push(`from=${from}`, parts));
  };
  const flushRepeats = () => {
    if (!repeats) return sending;
    const n = repeats;
    const from = next;
    repeats = 0;
    next += n;
    return send(() => push(`repeat=${n}&from=${from}`, []));
  };
  try {
    for (let i = 0; i < start.frames; i++) {
      if (opts.signal?.aborted) throw new Error('Cancelled');
      await draw(i, i / start.fps, raster);
      const px = raster.ctx.getImageData(0, 0, start.w, start.h).data;
      const words = new Uint32Array(px.buffer);
      if (prev && sameWords(prev, words)) repeats++;
      else {
        if (repeats) {
          await sending;
          flushFrames();
          flushRepeats();
        }
        batch.push(px);
        prev = words;
        if (batch.length >= perBatch) {
          await sending; // keep at most one batch in flight
          flushFrames();
        }
      }
      opts.onProgress?.(i + 1, start.frames);
    }
    flushFrames();
    await flushRepeats();
    await sending;
    return await post(`/api/frames-end?job=${job}`, '{}');
  } catch (e) {
    await sending.catch(() => {});
    await post(`/api/frames-end?job=${job}&cancel=1`, '{}').catch(() => {});
    throw e;
  }
}

/** Byte arrays → one Uint8Array. */
function joined(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at);
    at += p.byteLength;
  }
  return out;
}

function sameWords(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
