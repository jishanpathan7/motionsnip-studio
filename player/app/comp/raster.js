// Frames to pixels: an SVG frame (or any drawing on a canvas) → PNG bytes, for export. Web fonts don't load
// inside an SVG drawn as an image, so the fonts it uses are fetched once and inlined as data URLs.

const FONT_CSS = {
  'Patrick Hand': 'https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap',
  'Bricolage Grotesque': 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&display=swap',
  'DM Mono': 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap',
};

const fontCache = new Map();

const toDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** @font-face rules with the font files inlined, for the families an SVG names. Offline: '' (system fonts). */
export async function inlineFonts(svg) {
  const css = [];
  for (const fam of Object.keys(FONT_CSS)) {
    if (!svg.includes(fam)) continue;
    if (!fontCache.has(fam)) {
      fontCache.set(
        fam,
        (async () => {
          try {
            let text = await (await fetch(FONT_CSS[fam])).text();
            const urls = [...new Set([...text.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))];
            for (const u of urls) text = text.split(u).join(await toDataUrl(await (await fetch(u)).blob()));
            return text;
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

/** A drawing surface for export frames at w×h. */
export function createRaster(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  /** An SVG document string as a decoded image at w×h, with its web fonts inlined. */
  async function svgImage(svg, iw = w, ih = h) {
    const fontCss = await inlineFonts(svg);
    let s = svg.replace('width="100%" height="100%"', `width="${iw}" height="${ih}"`);
    if (fontCss) s = s.replace(/<svg[^>]*>/, (m) => `${m}<style>${fontCss}</style>`);
    const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
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
 * opts: { w, h, fps, frames, format, audio, tag, setSrc, onProgress(i, n), signal }. Resolves to the final job.
 */
export async function exportFrames(draw, opts) {
  const post = async (url, body, json = true) => {
    const r = await fetch(url, { method: 'POST', headers: json ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  };
  const start = await post('/api/frames-start', JSON.stringify({ w: opts.w, h: opts.h, fps: opts.fps, frames: opts.frames, format: opts.format, audio: opts.audio || [], tag: opts.tag, setSrc: opts.setSrc, captions: !!opts.captions }));
  const job = start.job;
  const raster = createRaster(start.w, start.h);
  const batch = [];
  let size = 0;
  let sending = Promise.resolve();
  const flush = () => {
    if (!batch.length) return sending;
    const body = new Blob(batch.splice(0));
    size = 0;
    sending = sending.then(() => post(`/api/frames-push?job=${job}`, body, false));
    return sending;
  };
  try {
    for (let i = 0; i < start.frames; i++) {
      if (opts.signal?.aborted) throw new Error('Cancelled');
      await draw(i, i / start.fps, raster);
      const png = await raster.png();
      batch.push(png);
      size += png.length;
      if (size > 6e6 || batch.length >= 24) {
        await sending; // keep at most one batch in flight
        flush();
      }
      opts.onProgress?.(i + 1, start.frames);
    }
    await flush();
    return await post(`/api/frames-end?job=${job}`, '{}');
  } catch (e) {
    await sending.catch(() => {});
    await post(`/api/frames-end?job=${job}&cancel=1`, '{}').catch(() => {});
    throw e;
  }
}
