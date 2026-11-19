// Cutdowns: other shapes and lengths made from the master with ffmpeg.
//   reframe: a 9:16, 1:1 or 16:9 version. Either a crop window that follows keys over time (the crop x/y
//            are ffmpeg expressions of t, straight lines between keys), or the whole frame on a blurred fill.
//   bumper:  a few seconds cut from the master (ranges in master time), joined.
// The ffmpeg graph itself is built by buildEditArgs in server.mjs; this file works out what goes in it.
// The player's own cutdowns are listed in .motionsnip/outputs.json; Claude's live in reel.json `outputs`.
//
// MIT licence. Copyright (c) 2026 Jishan Pathan.

import { PRESETS, cropSize, normKeys, normRanges, outputSlug, autoReframe, autoRanges, normalizeReel } from '../app/reel.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const n3 = (v) => Math.round(Number(v) * 1000) / 1000;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/**
 * A piecewise-straight expression of t through points [{ t, v }] (sorted), held before the first and
 * after the last. Commas are fine: the caller quotes it.
 */
export function keyExpr(points) {
  if (!points.length) return '0';
  const v = (x) => String(n3(x));
  if (points.every((p) => n3(p.v) === n3(points[0].v))) return v(points[0].v); // still: no expression
  let expr = v(points[points.length - 1].v);
  for (let i = points.length - 1; i >= 1; i--) {
    const a = points[i - 1];
    const b = points[i];
    const dt = b.t - a.t;
    const seg = dt > 0.0005 && a.v !== b.v ? `${v(a.v)}+(${v(b.v - a.v)})*(t-${v(a.t)})/${v(dt)}` : v(b.v);
    expr = `if(lt(t,${v(b.t)}),${seg},${expr})`;
  }
  return `if(lt(t,${v(points[0].t)}),${v(points[0].v)},${expr})`;
}

/**
 * What the reframe step of the ffmpeg graph needs, for a W×H master and an output o
 * ({ w, h, mode, zoom, keys }). Crop: { mode, outW, outH, cw, ch, x, y } with x/y in pixels (numbers or
 * expressions). Whole frame: { mode: 'blurpad', outW, outH, fw, fh } (the frame scaled to fit).
 */
export function reframeSpec(W, H, o) {
  const outW = even(clamp(Number(o.w) || 1080, 16, 4096));
  const outH = even(clamp(Number(o.h) || 1920, 16, 4096));
  if (o.mode === 'blurpad') {
    const s = Math.min(outW / W, outH / H);
    return { mode: 'blurpad', outW, outH, fw: Math.min(outW, even(W * s)), fh: Math.min(outH, even(H * s)) };
  }
  const { cw, ch } = cropSize(W, H, outW, outH, clamp(Number(o.zoom) || 1, 1, 4));
  const keys = normKeys(o.keys);
  const px = (c, size, win) => Math.round(clamp((c / 100) * size - win / 2, 0, size - win));
  const pts = keys.length ? keys : [{ t: 0, cx: 50, cy: 50 }];
  const x = keyExpr(pts.map((k) => ({ t: k.t, v: px(k.cx, W, cw) })));
  const y = keyExpr(pts.map((k) => ({ t: k.t, v: px(k.cy, H, ch) })));
  return { mode: 'crop', outW, outH, cw, ch, x, y };
}

/** The reframe step as filtergraph pieces, from label `cur`. Returns { parts, cur }. */
export function reframeGraph(spec, cur, label) {
  if (spec.mode === 'blurpad') {
    const [main, copy, bg, fg, o] = [label(), label(), label(), label(), label()];
    // the fill: the frame enlarged to cover, blurred small (fast) then scaled up, and dimmed
    const sw = even(spec.outW / 4);
    const sh = even(spec.outH / 4);
    return {
      parts: [
        `${cur}split${main}${copy}`,
        `${copy}scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},gblur=sigma=10,scale=${spec.outW}:${spec.outH},colorchannelmixer=rr=0.6:gg=0.6:bb=0.6${bg}`,
        `${main}scale=${spec.fw}:${spec.fh}${fg}`,
        `${bg}${fg}overlay=${(spec.outW - spec.fw) / 2}:${(spec.outH - spec.fh) / 2},setsar=1${o}`,
      ],
      cur: o,
    };
  }
  const o = label();
  return { parts: [`${cur}crop=w=${spec.cw}:h=${spec.ch}:x='${spec.x}':y='${spec.y}',scale=${spec.outW}:${spec.outH},setsar=1${o}`], cur: o };
}

/** Filters a cutdown needs on top of an edit export's. */
export const CUTDOWN_FILTERS = ['setsar'];

// ---------------------------------------------------------------- the player's outputs list

/** Where a project keeps the cutdowns made in the player (in its ProjectStore). */
export const OUTPUTS_FILE = '.motionsnip/outputs.json';

/** The cutdowns made in the player (raw entries), or []. */
export async function readPlayerOutputs(store) {
  const data = await store.readJson(OUTPUTS_FILE);
  return (Array.isArray(data?.outputs) ? data.outputs : []).filter((o) => o && typeof o === 'object' && typeof o.id === 'string');
}

export function writePlayerOutputs(store, list) {
  return store.writeText(OUTPUTS_FILE, JSON.stringify({ outputs: list }, null, 2) + '\n');
}

/** reel.json's outputs, then the player's (marked by: 'player'); an id in both is Claude's. */
export function mergeOutputs(reelOutputs, playerOutputs) {
  const mine = Array.isArray(reelOutputs) ? reelOutputs.filter((o) => o && typeof o === 'object').map((o) => ({ ...o, by: 'reel' })) : [];
  const ids = new Set(mine.map((o) => outputSlug(o.id || o.preset || '')));
  return [...mine, ...playerOutputs.filter((o) => !ids.has(outputSlug(o.id))).map((o) => ({ ...o, by: 'player' }))];
}

/**
 * The output entry to render, from a request. `prev` is the existing player entry with that id (or null).
 *   req: { id, keys?, mode?, zoom?, ranges? }; master: the raw reel (with w, h, duration from the probe).
 * Returns the entry (not yet with its new version) or throws a short message.
 */
export function planCutdown(rawMaster, req, prev) {
  const master = normalizeReel(rawMaster);
  const id = outputSlug(req.id);
  const preset = PRESETS[prev?.preset || id];
  if (!prev && !preset) throw new Error(`Unknown cutdown: ${req.id}`);
  const kind = prev?.kind || preset.kind;
  const base = {
    id,
    preset: prev?.preset || id,
    kind,
    label: prev?.label || preset.label,
    platform: prev?.platform ?? preset?.platform ?? null,
    src: `outputs/${id}.mp4`,
    audio: { music: null, videoAudio: 'mix' }, // the music is mixed into the cutdown's own sound
  };
  if (kind === 'bumper') {
    const dur = Number(prev?.target || preset?.duration) || 6;
    let ranges = normRanges(req.ranges ?? prev?.ranges, master.duration);
    if (!ranges.length) ranges = autoRanges(master, dur);
    if (!ranges.length) throw new Error('The video is too short for a bumper');
    const duration = n3(ranges.reduce((s, [a, b]) => s + b - a, 0));
    return { ...base, target: dur, w: master.w, h: master.h, duration, ranges };
  }
  const w = Number(prev?.w || preset.w);
  const h = Number(prev?.h || preset.h);
  if (Math.abs(w / h - master.w / master.h) < 0.01) throw new Error(`The video is already ${base.label}`);
  const zoom = clamp(Number(req.zoom ?? prev?.zoom) || 1, 1, 4);
  let keys = req.keys ?? prev?.keys;
  let mode = req.mode ?? prev?.mode;
  if (!Array.isArray(keys) || !mode) {
    const auto = autoReframe(master, w, h, zoom);
    keys = Array.isArray(keys) ? keys : auto.keys;
    mode = mode || auto.mode;
  }
  return { ...base, w, h, duration: master.duration, mode: mode === 'blurpad' ? 'blurpad' : 'crop', zoom, keys: normKeys(keys) };
}
