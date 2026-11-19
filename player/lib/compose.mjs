// Composed timeline export: ffmpeg draws the video clips and blur boxes, the browser streams everything else as a
// transparent layer that goes on top (see app/comp/compose.mjs for the split). Pure argument builders, so the
// selftest can check them without running ffmpeg.
//
// Each video clip becomes its own input (-ss to its first frame), fitted to its box, coloured by its look, placed on
// a transparent canvas the size of the frame (plus any part of the box outside it), moved, scaled and rotated by
// `perspective` (corner positions as expressions of the frame number, computed from clipState: the same numbers the
// preview uses), and faded through `colorchannelmixer` alpha driven by `sendcmd`. Blur boxes blur what is under
// them on the way up, as the browser does.
import { normTimeline, clipState } from '../app/comp/timeline.mjs';
import { clipProblem } from '../app/comp/compose.mjs';
import { videoCodecArgs, bt709Out } from './frames.mjs';

const n6 = (v) => String(Math.round(Number(v) * 1e6) / 1e6);
const n3 = (v) => String(Math.round(Number(v) * 1000) / 1000);
const EPS = 1e-6;

/**
 * The browser's spec (composeSpec) → normalised layers, checked again here: [{ kind, clip, file }]. The caller
 * marks a video `untagged` when its file has no colour matrix.
 * resolve(src) → an absolute file inside the project or null; a missing video is left out (the browser draws
 * nothing for it either). Throws when a layer is something ffmpeg can't draw.
 */
export function normComposeSpec(spec, resolve) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const list = (Array.isArray(s.layers) ? s.layers : []).slice(0, 64);
  const raw = {
    size: s.size,
    fps: s.fps,
    bg: s.bg,
    tracks: list.map((L, i) => ({ id: `t${i}`, kind: L?.kind === 'video' ? 'video' : 'graphics', clips: [{ ...(L && typeof L === 'object' ? L : {}), id: `c${i}`, ...(L?.kind === 'video' ? {} : { type: 'blur' }) }] })),
  };
  const tl = normTimeline(raw);
  const layers = [];
  for (const tr of tl.tracks) {
    const clip = tr.clips[0];
    if (!clip) continue;
    const why = clipProblem(tr.kind, clip);
    if (why) throw new Error(`Can't compose this timeline: ${why}`);
    if (tr.kind === 'video') {
      const file = resolve(clip.src);
      if (!file) continue;
      layers.push({ kind: 'video', clip, file });
    } else layers.push({ kind: 'blur', clip });
  }
  return { W: tl.size[0], H: tl.size[1], bg: tl.bg, layers };
}

/** '#rgb', '#rgba', '#rrggbb' or '#rrggbbaa' → ffmpeg's 0xRRGGBB (the frame is opaque). */
export function ffColor(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(h) ? `0x${h.toLowerCase()}` : '0x000000';
}

/** Points [[x, v], …] with straight runs dropped (Ramer–Douglas–Peucker, tolerance tol). Keeps first and last. */
export function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = (pts[i][0] - pts[a][0]) / (pts[b][0] - pts[a][0]);
      const d = Math.abs(pts[i][1] - (pts[a][1] + (pts[b][1] - pts[a][1]) * p));
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A piecewise-straight expression of variable x through points [[x, v], …] (sorted), held outside them. */
export function pwlExpr(pts, x = 'in') {
  const v = n3;
  if (!pts.length) return '0';
  if (pts.every((p) => v(p[1]) === v(pts[0][1]))) return v(pts[0][1]);
  let expr = v(pts[pts.length - 1][1]);
  for (let i = pts.length - 1; i >= 1; i--) {
    const [x0, a] = pts[i - 1];
    const [x1, b] = pts[i];
    const seg = x1 > x0 && v(a) !== v(b) ? `${v(a)}+(${v(b - a)})*(${x}-${v(x0)})/${v(x1 - x0)}` : v(b);
    expr = `if(lt(${x},${v(x1)}),${seg},${expr})`;
  }
  return `if(lt(${x},${v(pts[0][0])}),${v(pts[0][1])},${expr})`;
}

/** The output frames a clip covers: [k0, k1) with frame k at time k/fps (the browser draws frame k at k/fps). */
export function clipFrames(clip, fps, frames) {
  const k0 = Math.max(0, Math.ceil(clip.at * fps - EPS));
  const k1 = Math.min(frames, Math.ceil(clip.end * fps - EPS));
  return [k0, k1];
}

/** sendcmd + colorchannelmixer for a clip's opacity over its frames (op[j] for frame k0 + j); '' when always 1. */
function opacityChain(op, k0, fps, name) {
  const q = op.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000);
  if (q.every((v) => v === 1)) return '';
  if (q.every((v) => v === q[0])) return `colorchannelmixer=aa=${q[0]}`;
  const cmds = [];
  q.forEach((v, j) => {
    if (j && v === q[j - 1]) return;
    cmds.push(`${n6((k0 + j - 0.5) / fps)} colorchannelmixer@${name} aa ${v}`);
  });
  return `sendcmd=c='${cmds.join(';')}',colorchannelmixer@${name}=aa=${q[0]}`;
}

/**
 * Where the four corners of a layer canvas LW×LH come from in the source canvas (perspective, sense=source),
 * for a box centred at (cx, cy) shifted by (tx, ty), rotated by deg and scaled by s about its centre.
 * The canvas draws q = C + T + R·s·(p − C); so p = C + R⁻¹(q − C − T)/s.
 */
export function cornersFor(LW, LH, cx, cy, tx, ty, deg, s) {
  const k = 1 / Math.max(0.001, s);
  const a = (-deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [
    [0, 0],
    [LW, 0],
    [0, LH],
    [LW, LH],
  ].flatMap(([qx, qy]) => {
    const dx = qx - cx - tx;
    const dy = qy - cy - ty;
    return [cx + k * (cos * dx - sin * dy), cy + k * (sin * dx + cos * dy)];
  });
}

/**
 * ffmpeg args for a composed export.
 * opts: { w, h, fps, frames, out, format, encoder, W, H, bg, layers (normComposeSpec), look(look) → filter string,
 *         gifFps?, gifWidth? }
 * Input 0 is the browser's layer, raw RGBA w×h on stdin; then one input per video clip.
 * Returns { args, graph } (graph: the filter graph, which the caller may pass as a file when it is long).
 */
export function buildComposeArgs(opts) {
  const { w, h, fps, frames, out, format, encoder, W, H } = opts;
  if (!(fps > 0) || !(w > 0) || !(h > 0) || !(frames > 0)) throw new Error('fps, size and frame count are required');
  const D = frames / fps;
  const sx = w / W;
  const sy = h / H;
  const look = opts.look || (() => '');
  const inputs = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', String(fps), '-i', 'pipe:0'];
  const parts = [`color=c=${ffColor(opts.bg)}:s=${w}x${h}:r=${fps}:d=${n6(D)},format=rgba[b0]`];
  let b = 0;
  let input = 1;
  const B = 2; // a transparent border, so perspective's edge pixels are clear

  opts.layers.forEach((L, li) => {
    const c = L.clip;
    const [k0, k1] = clipFrames(c, fps, frames);
    const n = k1 - k0;
    if (n <= 0) return;
    const box = c.box || [0, 0, 100, 100];
    const bw = Math.max(1, Math.round((box[2] / 100) * w));
    const bh = Math.max(1, Math.round((box[3] / 100) * h));
    const states = [];
    for (let k = k0; k < k1; k++) states.push(clipState(c, k / fps - c.at));

    if (L.kind === 'video') {
      const X = Math.round((box[0] / 100) * w);
      const Y = Math.round((box[1] / 100) * h);
      const left = Math.min(0, X) - B;
      const top = Math.min(0, Y) - B;
      const LW = Math.max(w, X + bw) + B - left;
      const LH = Math.max(h, Y + bh) + B - top;
      const ss = c.in + (k0 / fps - c.at);
      inputs.push('-ss', n6(Math.max(0, ss)), '-t', n6(n / fps + 0.5), '-i', L.file);
      const f = [
        'setpts=PTS-STARTPTS',
        // untagged video is read as BT.709, as the browser reads it in the preview
        ...(L.untagged ? ['setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709'] : []),
        `fps=${fps}`,
        `tpad=stop_mode=clone:stop_duration=${n6(n / fps + 1)}`, // a file shorter than its clip holds its last frame
        `trim=end_frame=${n}`,
        `setpts=PTS-STARTPTS+${k0}`, // fps leaves the time base at 1/fps: PTS counts frames
        c.fit === 'contain' ? `scale=${bw}:${bh}:force_original_aspect_ratio=decrease:flags=bicubic` : `scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=bicubic`,
        'setsar=1',
        'format=rgba',
        c.fit === 'contain' ? `pad=${bw}:${bh}:(ow-iw)/2:(oh-ih)/2:color=black@0` : `crop=${bw}:${bh}`,
      ];
      const lk = c.look ? look(c.look) : '';
      if (lk) f.push(lk);
      f.push(`pad=${LW}:${LH}:${X - left}:${Y - top}:color=black@0`);
      const op = opacityChain(
        states.map((s) => s.opacity),
        k0,
        fps,
        `o${li}`,
      );
      if (op) f.push(op);
      // the transform, frame by frame, as perspective corners
      const cx = X - left + bw / 2;
      const cy = Y - top + bh / 2;
      const corners = states.map((s) => cornersFor(LW, LH, cx, cy, (s.x / 100) * w, (s.y / 100) * h, s.rotate, s.scale));
      const ident = cornersFor(LW, LH, cx, cy, 0, 0, 0, 1);
      const still = corners.every((cs) => cs.every((v, i) => Math.abs(v - corners[0][i]) < 0.01));
      if (!(still && corners[0].every((v, i) => Math.abs(v - ident[i]) < 0.01))) {
        const names = ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'];
        const exprs = names.map((_, i) =>
          still
            ? n3(corners[0][i])
            : pwlExpr(
                simplify(
                  corners.map((cs, j) => [j, cs[i]]),
                  0.02,
                ),
              ),
        );
        f.push(`perspective=${names.map((nm, i) => `${nm}='${exprs[i]}'`).join(':')}:sense=source:interpolation=linear:eval=${still ? 'init' : 'frame'}`);
      }
      parts.push(`[${input}:v]${f.join(',')}[l${li}]`);
      parts.push(`[b${b}][l${li}]overlay=x=${left}:y=${top}:eof_action=pass:format=rgb[b${b + 1}]`);
      input++;
      b++;
      return;
    }

    // a blur box: what is under it (in the frame), blurred with room to spread, laid back on top
    const s0 = states[0];
    const X = Math.round(((box[0] + s0.x) / 100) * w);
    const Y = Math.round(((box[1] + s0.y) / 100) * h);
    const x0 = Math.max(0, Math.min(w, X));
    const y0 = Math.max(0, Math.min(h, Y));
    const x1 = Math.max(0, Math.min(w, X + bw));
    const y1 = Math.max(0, Math.min(h, Y + bh));
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const sigma = (c.amount / 100) * Math.min(W, H) * 0.5 * sx;
    const M = Math.ceil(3 * sigma) + 1;
    const f = [
      `trim=start_frame=${k0}:end_frame=${k1}`,
      `crop=${x1 - x0}:${y1 - y0}:${x0}:${y0}`,
      `pad=${bw + 2 * M}:${bh + 2 * M}:${x0 - X + M}:${y0 - Y + M}:color=black@0`,
      `gblur=sigma=${n3(sigma)}`,
    ];
    const op = opacityChain(
      states.map((s) => s.opacity),
      k0,
      fps,
      `o${li}`,
    );
    if (op) f.push(op);
    parts.push(`[b${b}]split[m${li}][s${li}]`);
    parts.push(`[s${li}]${f.join(',')}[l${li}]`);
    parts.push(`[m${li}][l${li}]overlay=x=${X - M}:y=${Y - M}:eof_action=pass:format=rgb[b${b + 1}]`);
    b++;
  });

  // the browser's layer on top
  parts.push(`[b${b}][0:v]overlay=0:0:eof_action=pass:format=rgb,setsar=1[top]`);
  const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...inputs];
  if (format === 'gif') {
    const gf = Math.min(fps, opts.gifFps || 15);
    const gw = Math.min(w, opts.gifWidth || 960);
    parts.push(`[top]fps=${gf},scale=${gw}:-2:flags=lanczos,split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=bayer:bayer_scale=4[v]`);
    const graph = parts.join(';');
    return { args: [...args, '-filter_complex', graph, '-map', '[v]', '-loop', '0', '-t', n3(D), out], graph };
  }
  const c = bt709Out(format, encoder);
  parts.push(`[top]${c.vf}[v]`);
  const graph = parts.join(';');
  return { args: [...args, '-filter_complex', graph, '-map', '[v]', ...videoCodecArgs(format, encoder), ...c.tags, '-r', String(fps), '-an', '-t', n3(D), out], graph };
}
