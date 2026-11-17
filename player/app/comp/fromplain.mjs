// "Open in timeline": a plain video and the edits made to it in the player (store.data.vedit: trim, cuts,
// colour look, text / logo / blur layers) as a timeline.json, so it can grow into a multi-track project.
// Pure, shared by the player and the server's selftest.

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const within = (v, d, a, b) => (Number.isFinite(Number(v)) ? clamp(Number(v), a, b) : d);

// vedit font keys → timeline font families (graphics.mjs FONT_STACK)
const FONT = { display: 'Bricolage Grotesque', mono: 'DM Mono', sans: 'system-ui', serif: 'system-ui' };

/** The parts of a D-second video that stay after trim and cuts: [[from, to], …] in source seconds. */
export function keptRanges(D, trim, cuts) {
  const a = within(trim?.[0], 0, 0, D);
  const b = within(trim?.[1], D, 0, D);
  let keep = b - a >= 0.05 ? [[a, b]] : [];
  const list = (Array.isArray(cuts) ? cuts : [])
    .map((c) => [within(c?.[0], 0, 0, D), within(c?.[1], 0, 0, D)])
    .map(([x, y]) => [Math.min(x, y), Math.max(x, y)])
    .filter(([x, y]) => y - x > 0.001);
  for (const [x, y] of list) keep = keep.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, x], [y, q]].filter(([u, v]) => v - u >= 0.05)));
  return keep.map(([p, q]) => [r3(p), r3(q)]);
}

/** '#rrggbb' and an opacity 0..1 → '#rrggbbaa'. */
function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const base = m ? m[1] : '000000';
  return `#${base}${Math.round(clamp(Number(a ?? 0.6), 0, 1) * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * video: { src, title?, w, h, fps?, duration } — src is the video's path in the project.
 * edit: store.data.vedit ({ trim, cuts, look, layers }) or null.
 * heights: { [layer id]: drawn height in % of the frame } (text and logos size themselves to their content).
 * Returns the timeline.json object. Its `from` names the video, so the server opens the timeline for it.
 */
export function timelineFromPlain(video, edit, heights = {}) {
  const D = Number(video.duration);
  if (!(D > 0)) throw new Error('The video has no length');
  const W = Math.round(Number(video.w) || 1920);
  const H = Math.round(Number(video.h) || 1080);
  const e = edit || {};
  const ranges = keptRanges(D, e.trim, e.cuts);
  if (!ranges.length) throw new Error('Nothing is left after the trim and cuts');
  const look = e.look && Object.values(e.look).some((v) => Number(v)) ? Object.fromEntries(Object.entries(e.look).filter(([, v]) => Number(v))) : null;

  // source seconds → timeline seconds, range by range
  let at = 0;
  const placed = ranges.map(([p, q]) => {
    const r = { from: p, to: q, at };
    at = r3(at + (q - p));
    return r;
  });

  const video1 = placed.map((r, i) => ({ id: `clip${i + 1}`, src: video.src, at: r.at, in: r.from, out: r.to, ...(look ? { look } : {}) }));

  // a layer that spans a cut becomes one clip per kept part it touches
  const gfx = [];
  for (const L of Array.isArray(e.layers) ? e.layers : []) {
    if (!L || !Array.isArray(L.t) || !Array.isArray(L.box)) continue;
    const [s, t] = [Number(L.t[0]), Number(L.t[1])];
    const pieces = placed
      .map((r) => [Math.max(s, r.from), Math.min(t, r.to), r])
      .filter(([a, b]) => b - a >= 0.05)
      .map(([a, b, r]) => ({ at: r3(r.at + (a - r.from)), dur: r3(b - a) }));
    pieces.forEach((pc, k) => {
      const id = pieces.length > 1 ? `${L.id}-${k + 1}` : String(L.id);
      const [x, y, w] = L.box.map(Number);
      const fade = L.fade ? { kind: 'fade', dur: r3(Math.max(0.05, Math.min(0.4, pc.dur / 3))) } : null;
      const base = { id, at: pc.at, dur: pc.dur, ...(fade && k === 0 ? { enter: fade } : {}), ...(fade && k === pieces.length - 1 ? { exit: fade } : {}) };
      if (L.kind === 'text') {
        const size = Number(L.size) || 7;
        const lines = Math.max(1, String(L.text || '').split('\n').length);
        const hh = Number(heights[L.id]) > 0 ? Number(heights[L.id]) : size * 1.18 * lines + (L.bg ? size * 0.76 : 0);
        gfx.push({
          ...base,
          type: 'text',
          text: String(L.text || ''),
          box: [r3(x), r3(y), r3(w), r3(hh)],
          style: {
            font: FONT[L.font] || 'Bricolage Grotesque',
            size,
            weight: L.bold === false ? 400 : 700,
            color: L.color || '#ffffff',
            bg: L.bg ? withAlpha(L.bgColor, L.bgOpacity) : null,
            align: L.align || 'center',
            shadow: !!L.shadow,
          },
        });
      } else if (L.kind === 'image' && L.src) {
        const hh = Number(heights[L.id]) > 0 ? Number(heights[L.id]) : (w * W) / H;
        const op = clamp(Number(L.opacity ?? 1), 0, 1);
        gfx.push({ ...base, type: 'image', src: String(L.src), box: [r3(x), r3(y), r3(w), r3(hh)], fit: 'contain', ...(op < 1 ? { keys: { opacity: [[0, op]] } } : {}) });
      } else if (L.kind === 'blur') {
        // vedit: blur radius = amount % of the frame height; timeline: amount % of half the short side
        const amount = r3(clamp(((Number(L.amount) || 2.5) * 2 * H) / Math.min(W, H), 1, 60));
        gfx.push({ ...base, type: 'blur', box: [r3(x), r3(y), r3(w), r3(Number(L.box[3]) || 20)], amount });
      }
    });
  }
  gfx.sort((a, b) => a.at - b.at);

  const tracks = [{ id: 'video', kind: 'video', name: 'Video', clips: video1 }];
  if (gfx.length) tracks.push({ id: 'graphics', kind: 'graphics', name: 'Graphics', clips: gfx });
  return {
    version: 1,
    title: String(video.title || video.src).replace(/\.[^.]+$/, ''),
    from: video.src,
    size: [W - (W % 2), H - (H % 2)],
    fps: clamp(Math.round(Number(video.fps) || 30), 1, 60),
    bg: '#000000',
    tracks,
  };
}
