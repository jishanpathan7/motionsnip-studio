// ffmpeg: finding it, running it, reading its probe output and progress, and the argument builders for the sound
// remix and the plain-video edit export. The builders are pure, so the selftest checks them without ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isExecutable } from './files.mjs';
import { reframeGraph } from './cutdown.mjs';

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v) => String(Math.round(v * 1000) / 1000); // trims float noise in filter strings
const n3 = (v) => Math.round(Number(v) * 1000) / 1000;

// the filters an edit export may use; an ffmpeg without one of them can't run it
export const EDIT_FILTERS = ['overlay', 'trim', 'atrim', 'concat', 'split', 'asplit', 'crop', 'gblur', 'colorchannelmixer', 'lutrgb', 'fade', 'scale', 'format', 'amix', 'adelay', 'volume', 'afade', 'apad', 'aformat', 'anull'];

/**
 * Read `ffmpeg -i` output: duration, audio/video streams, and the picture's size and frame rate.
 * Phone videos shot upright carry a rotation; their size is reported as shown (width and height swapped).
 */
export function parseProbe(stderr) {
  const text = String(stderr || '');
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(text);
  const video = /Stream #\d+:\d+[^\n]*: Video:[^\n]*/.exec(text);
  const out = { duration, hasAudio, hasVideo: !!video, w: null, h: null, fps: null, matrix: null };
  if (video) {
    const m = /\((?:tv|pc), (bt709|smpte170m|bt470bg|bt2020nc|bt2020c|smpte240m|fcc|ycgco|gbr)\b/.exec(video[0]);
    if (m) out.matrix = m[1];
    const wh = /, (\d{2,5})x(\d{2,5})/.exec(video[0]);
    const f = /([\d.]+) fps/.exec(video[0]) || /([\d.]+) tbr/.exec(video[0]);
    if (wh) {
      out.w = Number(wh[1]);
      out.h = Number(wh[2]);
      const rot = /rotation of (-?[\d.]+) degrees/.exec(text) || /rotate\s*:\s*(-?\d+)/.exec(text);
      if (rot && Math.abs(Math.round(Number(rot[1]) / 90)) % 2 === 1) [out.w, out.h] = [out.h, out.w];
    }
    if (f && Number(f[1]) > 0 && Number(f[1]) <= 240) out.fps = Math.round(Number(f[1]) * 100) / 100;
  }
  return out;
}

/** Last "n/m" pair in some command output, as a 0-100 percentage (or null). */
export function progressFromText(text) {
  let pct = null;
  for (const m of String(text).matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
    const n = Number(m[1]);
    const total = Number(m[2]);
    if (total > 0 && n <= total) pct = (n / total) * 100;
  }
  return pct;
}

/**
 * Build the ffmpeg arguments for an audio-only remix.
 * The video stream is copied; the video's own audio (sfx) and the music file are mixed.
 *   opts: { video, music|null, out, duration, hasVideoAudio, musicVol, sfxVol, musicOffset, musicFade }
 */
export function buildMixArgs(opts) {
  const D = num(opts.duration, 0);
  if (!(D > 0)) throw new Error('duration must be > 0');
  const musicVol = clamp(num(opts.musicVol, 1), 0, 1);
  const sfxVol = clamp(num(opts.sfxVol, 1), 0, 1);
  const offset = num(opts.musicOffset, 0);
  const fade = clamp(num(opts.musicFade, 0), 0, D);
  const hasMusic = !!opts.music;
  const hasSfx = !!opts.hasVideoAudio;

  const args = ['-y', '-hide_banner', '-nostdin', '-i', opts.video];
  if (hasMusic) args.push('-i', opts.music);

  const fit = `aformat=sample_rates=48000:channel_layouts=stereo`;
  const toLength = `apad=whole_dur=${fmt(D)},atrim=end=${fmt(D)},asetpts=PTS-STARTPTS`;
  const chains = [];
  if (hasSfx) chains.push(`[0:a:0]${fit},volume=${fmt(sfxVol)},${toLength}[sfx]`);
  if (hasMusic) {
    const parts = [fit];
    if (offset > 0) parts.push(`adelay=${Math.round(offset * 1000)}:all=1`);
    if (offset < 0) parts.push(`atrim=start=${fmt(-offset)}`, 'asetpts=PTS-STARTPTS');
    parts.push(`volume=${fmt(musicVol)}`, toLength);
    if (fade > 0) parts.push(`afade=t=out:st=${fmt(D - fade)}:d=${fmt(fade)}`);
    chains.push(`[1:a:0]${parts.join(',')}[mus]`);
  }

  args.push('-map', '0:v:0');
  if (hasSfx && hasMusic) {
    chains.push(`[sfx][mus]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`);
  }
  if (chains.length) {
    const label = hasSfx && hasMusic ? 'aout' : hasMusic ? 'mus' : 'sfx';
    args.push('-filter_complex', chains.join(';'), '-map', `[${label}]`, '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }
  args.push('-c:v', 'copy', '-t', fmt(D), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', opts.out);
  return args;
}

export const within = (v, fallback, lo, hi) => clamp(num(v, fallback), lo, hi);

/**
 * The parts of a D-second video that stay: inside the trim [in, out], minus the cuts.
 * Sorted, none shorter than 0.05 s. The player plays the same ranges.
 */
export function keepRanges(D, trim, cuts) {
  const a = within(trim?.[0], 0, 0, D);
  const b = within(trim?.[1], D, 0, D);
  let keep = b - a >= 0.05 ? [[a, b]] : [];
  const list = (Array.isArray(cuts) ? cuts : [])
    .slice(0, 200)
    .map((c) => [within(c?.[0], 0, 0, D), within(c?.[1], 0, 0, D)])
    .map(([x, y]) => [Math.min(x, y), Math.max(x, y)])
    .filter(([x, y]) => y - x > 0.001);
  for (const [x, y] of list) {
    keep = keep.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, x], [y, q]].filter(([u, v]) => v - u >= 0.05)));
  }
  return keep.map(([p, q]) => [n3(p), n3(q)]);
}

/** Colour sliders, each -1..1, rounded to hundredths. */
export function normLook(look) {
  const f = (v) => Math.round(within(v, 0, -1, 1) * 100) / 100;
  return { brightness: f(look?.brightness), contrast: f(look?.contrast), saturation: f(look?.saturation), warmth: f(look?.warmth) };
}

/**
 * The colour look as numbers: a 3x3 channel mix M (saturation, warmth), then out = in * k + o per channel
 * (contrast, brightness; values 0..1). The player previews the same numbers with an SVG filter, in sRGB.
 */
export function lookMatrix(look) {
  const L = normLook(look);
  const s = 1 + L.saturation;
  const k = 1 + L.contrast;
  const lum = [0.2126, 0.7152, 0.0722];
  const gain = [1 + 0.1 * L.warmth, 1 + 0.02 * L.warmth, 1 - 0.1 * L.warmth];
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => n3(gain[i] * ((1 - s) * lum[j] + (i === j ? s : 0)))));
  return { M, k: n3(k), o: n3(0.5 - 0.5 * k + 0.2 * L.brightness) };
}

/** The look as an ffmpeg filter chain ('' when nothing changes). */
export function lookFilter(look) {
  const { M, k, o } = lookMatrix(look);
  const parts = [];
  const rgb = ['r', 'g', 'b'];
  if (M.some((row, i) => row.some((v, j) => v !== (i === j ? 1 : 0)))) {
    parts.push('colorchannelmixer=' + rgb.flatMap((c, i) => rgb.map((d, j) => `${c}${d}=${M[i][j]}`)).join(':'));
  }
  if (k !== 1 || o !== 0) {
    const e = `'clip(val*${k}${o < 0 ? '-' : '+'}${n3(Math.abs(o) * 255)},0,255)'`;
    parts.push(`lutrgb=r=${e}:g=${e}:b=${e}`);
  }
  return parts.join(',');
}

/**
 * ffmpeg arguments for exporting an edited plain video.
 *   opts: { video, hasVideoAudio, W, H, fps, D, keep, look, layers, reframe, music, musicVol, sfxVol, musicOffset, musicFade, encoder, out }
 *   layers (source time, drawn in order): { kind: 'blur', t: [a, b], box: [X, Y, w, h] px, sigma }
 *                                       | { kind: 'png', t: [a, b], file, fade }
 *   reframe (a cutdown; from reframeSpec): crop to another shape, or fit the frame on a blurred fill
 * The music runs on the edited (output) clock, so its offset and fade are where the reviewer heard them.
 */
export function buildEditArgs(opts) {
  const { W, H, D, keep } = opts;
  if (!(D > 0) || !W || !H) throw new Error('size and duration are required');
  if (!Array.isArray(keep) || !keep.length) throw new Error('nothing to keep');
  const layers = Array.isArray(opts.layers) ? opts.layers : [];
  const pngs = layers.filter((l) => l.kind === 'png');
  const parts = [];
  let cur = '[0:v]';
  let n = 0;
  const label = () => `[v${++n}]`;
  const step = (filter) => {
    const o = label();
    parts.push(`${cur}${filter}${o}`);
    cur = o;
  };

  const look = lookFilter(opts.look);
  if (look) step(look);
  for (const l of layers) {
    const on = `enable='between(t,${n3(l.t[0])},${n3(l.t[1])})'`;
    if (l.kind === 'blur') {
      const [X, Y, w, h] = l.box;
      const [main, copy, blurred, o] = [label(), label(), label(), label()];
      parts.push(`${cur}split${main}${copy}`, `${copy}crop=${w}:${h}:${X}:${Y},gblur=sigma=${n3(l.sigma)}${blurred}`, `${main}${blurred}overlay=${X}:${Y}:${on}${o}`);
      cur = o;
    } else {
      const input = 1 + pngs.indexOf(l);
      const F = l.fade ? n3(Math.min(0.4, (l.t[1] - l.t[0]) / 3)) : 0;
      const fades = F ? `,fade=t=in:st=${n3(l.t[0])}:d=${F}:alpha=1,fade=t=out:st=${n3(l.t[1] - F)}:d=${F}:alpha=1` : '';
      const pic = label();
      parts.push(`[${input}:v]scale=${W}:${H},format=rgba${fades}${pic}`);
      step(`${pic}overlay=0:0:${on}`);
    }
  }

  // Another shape (a cutdown): after the layers, which are placed on the master's frame
  if (opts.reframe) {
    const r = reframeGraph(opts.reframe, cur, label);
    parts.push(...r.parts);
    cur = r.cur;
  }

  // Trim and cuts: keep each range, then join them.
  const whole = keep.length === 1 && keep[0][0] <= 0.001 && keep[0][1] >= D - 0.001;
  let va = opts.hasVideoAudio ? '[0:a]' : null;
  if (!whole) {
    const N = keep.length;
    const vt = ([a, b]) => `trim=start=${a}:end=${b},setpts=PTS-STARTPTS`;
    const at = ([a, b]) => `atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS`;
    if (N === 1) {
      step(vt(keep[0]));
      if (va) {
        parts.push(`[0:a]${at(keep[0])}[va]`);
        va = '[va]';
      }
    } else {
      parts.push(`${cur}split=${N}${keep.map((_, i) => `[s${i}]`).join('')}`, ...keep.map((r, i) => `[s${i}]${vt(r)}[t${i}]`));
      if (va) parts.push(`[0:a]asplit=${N}${keep.map((_, i) => `[r${i}]`).join('')}`, ...keep.map((r, i) => `[r${i}]${at(r)}[u${i}]`));
      parts.push(`${keep.map((_, i) => `[t${i}]${va ? `[u${i}]` : ''}`).join('')}concat=n=${N}:v=1:a=${va ? 1 : 0}[vc]${va ? '[va]' : ''}`);
      cur = '[vc]';
      if (va) va = '[va]';
    }
  }
  parts.push(`${cur}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vf]`); // back from RGB to standard HD video

  const OD = n3(keep.reduce((s, [a, b]) => s + b - a, 0));
  const mix = [];
  const fit = 'aformat=sample_rates=48000:channel_layouts=stereo';
  if (va) {
    parts.push(`${va}${fit},volume=${fmt(clamp(num(opts.sfxVol, 1), 0, 1))}[a0]`);
    mix.push('[a0]');
  }
  if (opts.music) {
    const offset = num(opts.musicOffset, 0);
    const fade = clamp(num(opts.musicFade, 0), 0, OD);
    const chain = [fit];
    if (offset > 0) chain.push(`adelay=${Math.round(offset * 1000)}:all=1`);
    if (offset < 0) chain.push(`atrim=start=${fmt(-offset)}`, 'asetpts=PTS-STARTPTS');
    chain.push(`volume=${fmt(clamp(num(opts.musicVol, 1), 0, 1))}`, `apad=whole_dur=${fmt(OD)}`, `atrim=end=${fmt(OD)}`);
    if (fade > 0) chain.push(`afade=t=out:st=${fmt(OD - fade)}:d=${fmt(fade)}`);
    parts.push(`[${1 + pngs.length}:a:0]${chain.join(',')}[a1]`);
    mix.push('[a1]');
  }
  if (mix.length === 2) parts.push('[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]');
  else if (mix.length) parts.push(`${mix[0]}anull[aout]`);

  const enc =
    opts.encoder === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']
      : opts.encoder === 'h264_videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M']
        : ['-c:v', 'mpeg4', '-q:v', '2'];
  const fps = fmt(num(opts.fps, 30) || 30);
  return [
    '-y', '-hide_banner', '-nostdin',
    '-i', opts.video,
    ...pngs.flatMap((l) => ['-loop', '1', '-framerate', fps, '-t', fmt(D), '-i', l.file]),
    ...(opts.music ? ['-i', opts.music] : []),
    '-filter_complex', parts.join(';'),
    '-map', '[vf]',
    ...(mix.length ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    ...enc,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-t', fmt(OD), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
    opts.out,
  ];
}

/** From `ffmpeg -filters` and `ffmpeg -encoders` output: the H.264 encoder to use for edits, or null if it can't. */
export function pickEditEncoder(filtersText, encodersText) {
  const have = new Set([...String(filtersText).matchAll(/^ [A-Z.|]{2,4} (\S+) /gm)].map((m) => m[1]));
  if (!EDIT_FILTERS.every((f) => have.has(f))) return null;
  return ['libx264', 'h264_videotoolbox', 'mpeg4'].find((e) => new RegExp(`^ V\\S* ${e} `, 'm').test(String(encodersText))) || null;
}

/** Run a command and collect its output. Never throws; returns { code, stdout, stderr }. */
export function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: String(err.message) });
      return;
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** --ffmpeg, then PATH, then a Remotion-bundled binary in the project. */
export function findFfmpeg(projectDir, explicit) {
  if (explicit) return isExecutable(explicit) ? { path: path.resolve(explicit), bundled: false } : null;
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (isExecutable(p)) return { path: p, bundled: false };
    }
  }
  const remotion = path.join(projectDir, 'node_modules', '@remotion');
  let entries = [];
  try {
    entries = fs.readdirSync(remotion).filter((n) => n.startsWith('compositor-'));
  } catch {}
  for (const e of entries) {
    for (const rel of [...names, path.join('ffmpeg', 'ffmpeg'), path.join('ffmpeg', 'bin', 'ffmpeg')]) {
      const p = path.join(remotion, e, rel);
      if (isExecutable(p)) return { path: p, bundled: true };
    }
  }
  return null;
}

/**
 * Builds like Remotion's ship their libav* libraries next to the binary, so put
 * that folder on the library path, whether the binary was found for us or
 * passed with --ffmpeg.
 */
export function ffmpegEnv(ff) {
  const dir = path.dirname(ff.path);
  let hasLibs = Boolean(ff.bundled);
  try {
    hasLibs = hasLibs || fs.readdirSync(dir).some((f) => /^libav\w*\.(dylib|so)/.test(f));
  } catch {
    /* unreadable folder: leave the environment alone */
  }
  if (!hasLibs) return process.env;
  const join = (v) => (v ? `${dir}${path.delimiter}${v}` : dir);
  return { ...process.env, DYLD_LIBRARY_PATH: join(process.env.DYLD_LIBRARY_PATH), LD_LIBRARY_PATH: join(process.env.LD_LIBRARY_PATH) };
}

export async function probe(ff, file) {
  const r = await run(ff.path, ['-hide_banner', '-nostdin', '-i', file], { env: ffmpegEnv(ff) });
  return parseProbe(r.stderr);
}

export function lastLine(text) {
  const lines = String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // ANSI colours
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.pop() || '').slice(0, 200);
}
