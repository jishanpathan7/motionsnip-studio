// Composed export: which parts of a timeline ffmpeg draws, and which the browser draws on top.
// ffmpeg draws the video clips (fit, look, keyframes, fades and slides) and the blur boxes over them; the browser
// draws everything else (scenes, text, shapes, images, captions) onto a transparent canvas that ffmpeg lays on top.
// That only works when nothing the browser draws sits under something ffmpeg draws at the same time, and when every
// ffmpeg clip uses things ffmpeg can reproduce exactly. composePlan says yes or no, and why. Pure: the player and
// the server (lib/compose.mjs) share it.
import { VISUAL } from './timeline.mjs';

const constant = (list) => !list || list.length <= 1 || list.every((k) => k[1] === list[0][1]);
const transitions = (c) => [c.enter, c.exit].filter(Boolean).map((t) => t.kind);

/** Why ffmpeg can't draw this clip, or null when it can. kind: its track's kind. */
export function clipProblem(kind, clip) {
  if (kind === 'video') {
    if (!clip.src) return 'a video clip has no file';
    if (transitions(clip).includes('wipe')) return 'a video clip uses a wipe';
    return null;
  }
  if (kind === 'graphics' && clip.type === 'blur') {
    const tr = transitions(clip);
    if (tr.includes('wipe')) return 'a blur box uses a wipe';
    if (tr.includes('slide') || !constant(clip.keys?.x) || !constant(clip.keys?.y)) return 'a blur box moves';
    return null;
  }
  return 'not a video or blur clip';
}

/** Whether ffmpeg draws this clip in a composed export (video clips and blur boxes). */
export const ffmpegDraws = (kind, clip) => kind === 'video' || (kind === 'graphics' && clip.type === 'blur');

/**
 * Plan a composed export for a normalised timeline.
 * Returns { ok: true, layers: [{ kind, clip }] back to front, ids: Set of clip ids ffmpeg draws }
 * or { ok: false, reason }. Visibility follows evalAt: hidden tracks are left out, solo shows only soloed tracks.
 */
export function composePlan(tl) {
  const soloV = tl.tracks.some((tr) => VISUAL.has(tr.kind) && tr.solo);
  const order = []; // every visible clip, back to front (the order evalAt draws them in)
  for (const tr of tl.tracks) {
    if (!VISUAL.has(tr.kind) || tr.hide || (soloV && !tr.solo)) continue;
    for (const c of tr.clips) order.push({ kind: tr.kind, clip: c, ff: ffmpegDraws(tr.kind, c) });
  }
  const layers = order.filter((L) => L.ff);
  if (!layers.length) return { ok: false, reason: 'nothing for ffmpeg to draw' };
  for (const L of layers) {
    const why = clipProblem(L.kind, L.clip);
    if (why) return { ok: false, reason: why };
  }
  // the browser's layer is laid on top of all of ffmpeg's: nothing it draws may sit under an ffmpeg clip
  // while both are on screen
  const overlap = (a, b) => a.at < b.end && b.at < a.end;
  for (let i = 0; i < order.length; i++) {
    if (order[i].ff) continue;
    for (let j = i + 1; j < order.length; j++) {
      if (order[j].ff && overlap(order[i].clip, order[j].clip)) {
        return { ok: false, reason: `${order[i].kind === 'scene' ? 'a scene' : 'a graphic'} sits under ${order[j].kind === 'video' ? 'a video clip' : 'a blur box'}` };
      }
    }
  }
  return { ok: true, layers, ids: new Set(layers.map((L) => L.clip.id)) };
}

/**
 * What the server needs to draw a plan's layers: plain JSON, clip fields only (the server normalises it again).
 * The boxes are the ones on screen (after any drag in the player).
 */
export function composeSpec(tl, plan) {
  return {
    size: tl.size,
    fps: tl.fps,
    bg: tl.bg,
    layers: plan.layers.map(({ kind, clip: c }) => {
      const base = { kind, id: c.id, at: c.at, dur: c.dur, box: c.box, keys: c.keys, enter: c.enter, exit: c.exit };
      if (kind === 'video') return { ...base, src: c.src, in: c.in, out: c.out, fit: c.fit, look: c.look };
      return { ...base, type: 'blur', amount: c.amount };
    }),
  };
}
