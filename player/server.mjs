#!/usr/bin/env node
// MotionSnip Studio server.
//
// A small local server for the review player. It serves the player page, the
// project's files and a JSON API. Node 18+, no dependencies.
//
//   node player/server.mjs <project-dir | video-file> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]
//   node player/server.mjs --selftest
//
// A folder with a reel.json is a Claude-built project. A folder without one (or a
// video file) opens as a plain video: the server makes up a reel from the file,
// and the player can trim, cut, colour and put text, logos and blurs on it.
//
// MIT licence. Copyright (c) 2026 Jishan Pathan.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reframeSpec, reframeGraph, keyExpr, CUTDOWN_FILTERS, readPlayerOutputs, writePlayerOutputs, mergeOutputs, planCutdown } from './lib/cutdown.mjs';
import { normalizeReel, resolveOutput, outTime, masterTime, cropSize, autoReframe, autoRanges } from './app/reel.mjs';
import { toReel as sceneToReel, applyPatches as applyScenePatches, normScene } from './app/scene/compile.mjs';
import { toReel as timelineToReel, applyPatches as applyTimelinePatches, normTimeline, captionCues, toSrt, toVtt } from './app/comp/timeline.mjs';
import { applyOps } from './app/comp/ops.mjs';
import { FORMATS, encoderSet, pickEncoder, availableFormats, audioMix, buildFramesArgs, buildMuxArgs, countPngs } from './lib/frames.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../player
const ROOT = path.dirname(HERE); // the repo / skill folder
const APP_DIR = path.join(HERE, 'app');
const BRAND_DIR = path.join(ROOT, 'docs', 'brand');
const INDEX_FILE = path.join(HERE, 'index.html');

const DEFAULT_PORT = 4321;
const PORT_TRIES = 20;
const JSON_LIMIT = 2 * 1024 * 1024; // 2 MB
const EXPORT_LIMIT = 64 * 1024 * 1024; // an edit export carries its text and logo layers as PNGs
const LAYER_LIMIT = 16 * 1024 * 1024; // one layer PNG
const MAX_LAYERS = 40;
const UPLOAD_LIMIT = 100 * 1024 * 1024; // 100 MB
const VIDEO_LIMIT = 4 * 1024 * 1024 * 1024; // 4 GB, streamed to disk
const KEEP_TAKES = 6;
const AUDIO_EXTS = ['mp3', 'wav', 'm4a'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp']; // logos and pictures put on a plain video
const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm']; // what a browser <video> can usually play

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for --selftest)
// ---------------------------------------------------------------------------

/** File extension in lower case, without the dot ("" if none). */
export function extOf(name) {
  const e = path.extname(String(name || '')).slice(1).toLowerCase();
  return e;
}

export function mimeFor(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

/**
 * Parse a Range header against a file size.
 * Returns null      when there is no usable range (serve the whole file, 200),
 *         'unsatisfiable' when the range can't be met (416),
 *         { start, end } (inclusive) for a single satisfiable range (206).
 * Malformed and multi-range headers are ignored, as HTTP allows.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    // Suffix range: the last N bytes.
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
    if (b !== '' && end < start) return null; // invalid spec: ignore the header
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/**
 * Reduce an upload name to a safe file name: letters, digits, "-", "_", ".";
 * no path parts, no leading dot, at most 80 characters, extension kept.
 * Returns null when the extension isn't one of `exts`.
 */
export function cleanName(raw, exts = AUDIO_EXTS) {
  let name = String(raw ?? '').replace(/\0/g, '');
  name = name.split(/[\\/]/).pop() || ''; // drop any path parts
  const ext = extOf(name);
  if (!ext || !exts.includes(ext)) return null;
  let stem = name.slice(0, name.length - ext.length - 1);
  stem = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: é -> e
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+/, '')
    .replace(/[.\-]+$/, '');
  const maxStem = 80 - ext.length - 1;
  if (stem.length > maxStem) stem = stem.slice(0, maxStem).replace(/[.\-]+$/, '');
  if (!stem) stem = 'upload';
  return `${stem}.${ext}`;
}

/** Name for the n-th copy: "song.mp3" -> "song-2.mp3". */
export function numberedName(name, n) {
  if (n <= 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
}

/** Guess an audio type from its first bytes: 'mp3' | 'wav' | 'm4a' | null. */
export function sniffAudio(buf) {
  if (!buf || buf.length < 4) return null;
  const ascii = (from, to) => buf.subarray(from, to).toString('latin1');
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 8 && ascii(4, 8) === 'ftyp') return 'm4a';
  return null;
}

/** Guess an image type from its first bytes: 'png' | 'jpg' | 'webp' | null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  const ascii = (from, to) => buf.subarray(from, to).toString('latin1');
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Guess a video container from its first bytes: 'iso' (mp4, m4v, mov) | 'webm' | null. */
export function sniffVideo(buf) {
  if (!buf || buf.length < 8) return null;
  const box = buf.subarray(4, 8).toString('latin1');
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'iso';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

/** Host header must name this server (blocks DNS rebinding). */
export function hostAllowed(host, port) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  return h === `localhost:${port}` || h === `127.0.0.1:${port}`;
}

/** POSTs must come from the player page itself. */
export function originAllowed(origin, port) {
  if (typeof origin !== 'string') return false;
  const o = origin.trim().toLowerCase();
  return o === `http://localhost:${port}` || o === `http://127.0.0.1:${port}`;
}

/** Resolve a URL/request path inside `root`; null if it would escape. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, '.' + path.sep + rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** Parse reel.json. Plain JSON first; then tolerate // and /* *\/ comments and trailing commas. */
export function parseReel(text) {
  try {
    return JSON.parse(text);
  } catch (first) {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch {
      throw first;
    }
  }
}

function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

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
  const out = { duration, hasAudio, hasVideo: !!video, w: null, h: null, fps: null };
  if (video) {
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

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (v) => String(Math.round(v * 1000) / 1000); // trims float noise in filter strings

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

// ---------------------------------------------------------------------------
// Editing a plain video: trim, cuts, colour, blur boxes, text and logo layers
// ---------------------------------------------------------------------------

const n3 = (v) => Math.round(Number(v) * 1000) / 1000;
const within = (v, fallback, lo, hi) => clamp(num(v, fallback), lo, hi);

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

/** Filters an edit export needs. Some trimmed builds (Remotion's) leave many of them out. */
export const EDIT_FILTERS = ['overlay', 'trim', 'atrim', 'concat', 'split', 'asplit', 'crop', 'gblur', 'colorchannelmixer', 'lutrgb', 'fade', 'scale', 'format', 'amix', 'adelay', 'volume', 'afade', 'apad', 'aformat', 'anull'];

/** From `ffmpeg -filters` and `ffmpeg -encoders` output: the H.264 encoder to use for edits, or null if it can't. */
export function pickEditEncoder(filtersText, encodersText) {
  const have = new Set([...String(filtersText).matchAll(/^ [A-Z.|]{2,4} (\S+) /gm)].map((m) => m[1]));
  if (!EDIT_FILTERS.every((f) => have.has(f))) return null;
  return ['libx264', 'h264_videotoolbox', 'mpeg4'].find((e) => new RegExp(`^ V\\S* ${e} `, 'm').test(String(encodersText))) || null;
}

/** Turn an id into a safe file-name piece. */
export function slug(s) {
  const v = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return v || 'reel';
}

/** Local time as YYYYMMDD-HHMMSS. */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Small IO helpers
// ---------------------------------------------------------------------------

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First name that doesn't exist yet in `dir`: name, name-2, name-3... */
function freePath(dir, name) {
  for (let n = 1; n < 10000; n++) {
    const p = path.join(dir, numberedName(name, n));
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('no free file name');
}

/** Write a file atomically (temp file + rename). */
async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/** Run a command and collect its output. Never throws; returns { code, stdout, stderr }. */
function run(cmd, args, options = {}) {
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > limit) return reject(httpError(413, 'Too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = JSON_LIMIT) {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || 'null');
  } catch {
    throw httpError(400, 'Body is not valid JSON');
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': MIME.json, 'Content-Length': data.length });
  res.end(data);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** Stream a file, with byte ranges. */
function sendFile(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendError(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendError(res, 404, 'Not found');
  const headers = { ...BASE_HEADERS, 'Content-Type': mimeFor(file), 'Accept-Ranges': 'bytes' };
  const range = parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  let status = 200;
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    status = 206;
    ({ start, end } = range);
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

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
function ffmpegEnv(ff) {
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

async function probe(ff, file) {
  const r = await run(ff.path, ['-hide_banner', '-nostdin', '-i', file], { env: ffmpegEnv(ff) });
  return parseProbe(r.stderr);
}

/** Which H.264 encoder this ffmpeg can export edits with (null: it can't). Cached per binary. */
async function editEncoder(ctx, ff) {
  if (!ff) return null;
  if (ctx.editEnc?.path === ff.path) return ctx.editEnc.encoder;
  const env = ffmpegEnv(ff);
  const [filters, encoders] = await Promise.all([run(ff.path, ['-hide_banner', '-filters'], { env }), run(ff.path, ['-hide_banner', '-encoders'], { env })]);
  const encoder = pickEditEncoder(filters.stdout, encoders.stdout);
  ctx.editEnc = { path: ff.path, encoder };
  return encoder;
}

// ---------------------------------------------------------------------------
// Plain videos (a folder with no reel.json)
// ---------------------------------------------------------------------------

/** The video to open in a folder with no reel.json: the newest playable one at the top level, or null. */
export function pickVideo(dir) {
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.') || !VIDEO_EXTS.includes(extOf(e.name))) continue;
    let m = 0;
    try {
      m = fs.statSync(path.join(dir, e.name)).mtimeMs;
    } catch {
      continue;
    }
    if (!best || m > best.m) best = { name: e.name, m };
  }
  return best ? best.name : null;
}

/**
 * A plain video's version: 1 the first time, +1 each time the file changes (a new cut exported over the
 * same name), counted once the file has stopped changing for 2 s. Kept in .motionsnip/video.json.
 * Opening a different video in the same folder starts again at 1 and drops the old takes.
 */
export function videoVersion(dir, name, stat, now = Date.now()) {
  const file = path.join(dir, '.motionsnip', 'video.json');
  const sig = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {}
  const same = saved.src === name;
  const ver = Math.max(1, Math.floor(Number(saved.version)) || 1);
  if (same && (saved.sig === sig || now - stat.mtimeMs < 2000)) return ver;
  const version = same ? ver + 1 : 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!same && saved.src) fs.rmSync(path.join(dir, '.motionsnip', 'takes'), { recursive: true, force: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ src: name, sig, version }));
    fs.renameSync(tmp, file);
  } catch {
    /* a read-only folder still plays; it just can't count versions */
  }
  return version;
}

/** Make up a reel from the video itself. */
async function plainReel(ctx) {
  const name = ctx.video || pickVideo(ctx.dir);
  if (!name) throw httpError(404, `No reel.json or video file in ${ctx.dir}`);
  const file = path.join(ctx.dir, name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw httpError(404, `Video not found: ${file}`);
  }
  const sig = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (ctx.probed?.sig !== sig) {
    const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
    ctx.probed = { sig, info: ff ? await probe(ff, file) : {} };
  }
  const info = ctx.probed.info;
  const stem = name.slice(0, name.length - path.extname(name).length);
  const reel = {
    id: `${slug(stem)}-${crypto.createHash('sha1').update(file).digest('hex').slice(0, 6)}`,
    title: name,
    version: videoVersion(ctx.dir, name, stat),
    src: name,
    path: ctx.dir,
    file,
    plain: true,
    audio: { videoAudio: 'mix' }, // its sound is the whole soundtrack, not effects
    scenes: [],
  };
  if (info.duration > 0) reel.duration = Math.round(info.duration * 1000) / 1000;
  if (info.w && info.h) {
    reel.w = info.w;
    reel.h = info.h;
  }
  if (info.fps) reel.fps = info.fps;
  return reel;
}

/**
 * A scene project (scene.json, no reel.json): the reel is built from the scene, the way plainReel makes one up
 * for a video. The player draws it live; "src" is the last export, when there is one.
 */
function sceneReel(ctx) {
  const file = path.join(ctx.dir, 'scene.json');
  let raw;
  try {
    raw = parseReel(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw httpError(500, `scene.json is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(500, 'scene.json must be a JSON object');
  const src = typeof raw.src === 'string' && raw.src && isFile(path.join(ctx.dir, raw.src)) ? raw.src : lastRender(ctx, raw.version);
  const reel = sceneToReel(raw, { src });
  reel.path = ctx.dir;
  reel.file = file;
  return reel;
}

/** The last export of this version, so takes, compare and cutdowns have a video ('' when there is none). */
function lastRender(ctx, version) {
  try {
    const r = JSON.parse(fs.readFileSync(renderFile(ctx), 'utf8'));
    if (r && r.version === (Number(version) || 1) && typeof r.src === 'string' && isFile(path.join(ctx.dir, r.src))) return r.src;
  } catch {}
  return '';
}

/** A project file as JSON: { raw, text, rev } where rev is a short hash of the text (who saved last). */
function readProjectFile(ctx, rel) {
  const file = resolveInside(ctx.dir, rel);
  if (!file || !isFile(file)) throw httpError(404, `${rel} not found`);
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = parseReel(text);
  } catch (err) {
    throw httpError(500, `${rel} is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(500, `${rel} must be a JSON object`);
  return { file, raw, text, rev: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) };
}

/** The scene files a timeline's scene clips use: { 'scene.json': raw }. Unreadable ones are left out (lint says so). */
function timelineScenes(ctx, raw) {
  const out = {};
  for (const t of Array.isArray(raw.tracks) ? raw.tracks : [])
    for (const c of t?.kind === 'scene' && Array.isArray(t.clips) ? t.clips : []) {
      const rel = typeof c?.scene === 'string' && c.scene ? c.scene : 'scene.json';
      if (rel in out || !rel.endsWith('.json')) continue;
      try {
        out[rel] = readProjectFile(ctx, rel).raw;
      } catch {}
    }
  return out;
}

/**
 * A timeline project (timeline.json, no reel.json): the reel is built from the composition. The player draws it
 * live; "src" is the last export of this version. rev is timeline.json's, depsRev the scene files'.
 */
function timelineReel(ctx) {
  const { raw, rev, file } = readProjectFile(ctx, 'timeline.json');
  const scenes = timelineScenes(ctx, raw);
  const exists = (rel) => {
    const f = resolveInside(ctx.dir, rel);
    return !!f && isFile(f);
  };
  const reel = timelineToReel(raw, { scenes, src: lastRender(ctx, raw.version), exists });
  reel.rev = rev; // the base for the editor's saves
  reel.depsRev = crypto.createHash('sha1').update(JSON.stringify(scenes)).digest('hex').slice(0, 12); // the scenes it uses
  reel.path = ctx.dir;
  reel.file = file;
  return reel;
}

/**
 * Write the player's edits into timeline.json or a scene file, without Claude.
 * body: { file, base?, bump?, patches?: [{ path, value }], ops?: [...] (timeline only), content?: {...} (a whole copy: undo) }
 *   base: the rev the edit was made on; a different file on disk is a 409 (reload, then edit again).
 *   bump: start a new version (Apply); plain editor saves keep the version.
 */
/** The video a timeline.json was made from ("Open in timeline"), or null. */
function timelineFrom(ctx) {
  try {
    const from = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'timeline.json'), 'utf8'))?.from;
    return typeof from === 'string' ? from : null;
  } catch {
    return null;
  }
}

/** "Open in timeline": the plain video and its edits, converted by the player, become the folder's timeline.json. */
async function apiTimelineOpen(ctx, req, res) {
  const body = (await readJson(req)) || {};
  const reel = await readReel(ctx);
  if (!reel.plain) throw httpError(400, 'Only a plain video opens in the timeline');
  const tl = body.content;
  if (!tl || typeof tl !== 'object' || Array.isArray(tl)) throw httpError(400, 'timeline must be a JSON object');
  if (tl.from !== reel.src) throw httpError(400, `The timeline must be made from ${reel.src}`);
  try {
    normTimeline(tl, { scenes: {} });
  } catch (err) {
    throw httpError(400, err.message);
  }
  try {
    fs.writeFileSync(path.join(ctx.dir, 'timeline.json'), JSON.stringify(tl, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw httpError(409, 'This folder already has a timeline.json');
    throw err;
  }
  return sendJson(res, 200, { ok: true, file: 'timeline.json' });
}

async function apiProjectApply(ctx, req, res) {
  const body = (await readJson(req)) || {};
  const rel = typeof body.file === 'string' ? body.file : '';
  const isTimeline = rel === 'timeline.json';
  if (!isTimeline) {
    // a scene file: scene.json, or one the timeline uses
    let ok = rel === 'scene.json';
    if (!ok && rel.endsWith('.json') && isFile(path.join(ctx.dir, 'timeline.json'))) ok = rel in timelineScenes(ctx, readProjectFile(ctx, 'timeline.json').raw);
    if (!ok) throw httpError(400, `Can't edit ${rel || 'that file'} here`);
  }
  const cur = readProjectFile(ctx, rel);
  if (body.base && body.base !== cur.rev) return sendJson(res, 409, { error: `${rel} changed since you started this edit`, rev: cur.rev });
  let out = cur.raw;
  try {
    if (isTimeline) {
      const scenes = timelineScenes(ctx, cur.raw);
      const whole = body.content !== undefined ? body.content : body.timeline;
      if (whole !== undefined) {
        if (!whole || typeof whole !== 'object' || Array.isArray(whole)) throw new Error('timeline must be a JSON object');
        normTimeline(whole, { scenes });
        out = whole;
      }
      if (Array.isArray(body.ops) && body.ops.length) out = applyOps(out, body.ops, { scenes });
      if (Array.isArray(body.patches) && body.patches.length) out = applyTimelinePatches(out, body.patches, { scenes });
    } else {
      if (body.ops || body.timeline) throw new Error('Scenes take patches or content');
      if (body.content !== undefined) {
        if (!body.content || typeof body.content !== 'object' || Array.isArray(body.content)) throw new Error('A scene must be a JSON object');
        normScene(body.content);
        out = body.content;
      }
      if (Array.isArray(body.patches) && body.patches.length) out = applyScenePatches(out, body.patches);
    }
  } catch (err) {
    throw httpError(400, err.message);
  }
  if (body.bump) out = { ...out, version: (Math.round(Number(out.version)) || 1) + 1 };
  const text = JSON.stringify(out, null, 2) + '\n';
  await writeAtomic(cur.file, text);
  return sendJson(res, 200, { ok: true, rev: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12), version: Number(out.version) || 1 });
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Start the server. Resolves to { server, port, url, close() }.
 *   opts: { dir, video, port, open, ffmpeg, quiet }
 *   video: a file name in dir to open as a plain video (else the newest video there, when there's no reel.json)
 */
export async function startServer(opts) {
  const dir = path.resolve(opts.dir);
  const ctx = {
    dir,
    port: 0,
    ffmpegArg: opts.ffmpeg || null,
    video: opts.video || null,
    probed: null, // the plain video's last ffmpeg probe
    editEnc: null, // { path, encoder } for edit exports
    job: { state: 'idle', pct: 0, line: '', out: null, rel: null, mode: null },
    child: null,
    cut: { state: 'idle', pct: 0, line: '', id: null, label: null }, // the cutdown being made
    cutChild: null,
    takesBusy: new Set(),
  };
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      // Our own httpError messages are short and meant for the player; anything else stays in the log.
      const status = err.status || 500;
      if (!err.expose && !opts.quiet) console.error(err);
      if (!res.headersSent) sendError(res, status, err.expose ? err.message : 'Server error');
      else res.destroy();
    });
  });

  const port = await listen(server, opts.port ?? DEFAULT_PORT);
  ctx.port = port;
  const url = `http://localhost:${port}`;
  if (!opts.quiet) console.log(`MotionSnip Studio: ${url}  (project: ${dir})`);
  if (opts.open) openInBrowser(url);
  return {
    server,
    port,
    url,
    ctx,
    close: () =>
      new Promise((resolve) => {
        if (ctx.child) ctx.child.kill();
        if (ctx.cutChild) ctx.cutChild.kill();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Listen on 127.0.0.1, moving up one port while the port is busy. */
function listen(server, firstPort) {
  return new Promise((resolve, reject) => {
    let port = Number(firstPort);
    let tries = 0;
    const attempt = () => {
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    };
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0 && ++tries < PORT_TRIES) {
        port += 1;
        attempt();
      } else reject(err);
    };
    attempt();
  });
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

async function handle(ctx, req, res) {
  // DNS rebinding: only answer requests addressed to this server.
  if (!hostAllowed(req.headers.host, ctx.port)) return sendError(res, 403, 'Bad host');
  // Every POST must come from the player page.
  if (req.method === 'POST' && !originAllowed(req.headers.origin, ctx.port)) return sendError(res, 403, 'Bad origin');
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) return sendError(res, 405, 'Method not allowed');

  const url = new URL(req.url, `http://localhost:${ctx.port}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendError(res, 400, 'Bad path');
  }
  const get = req.method === 'GET' || req.method === 'HEAD';

  if (pathname.startsWith('/api/')) return api(ctx, req, res, pathname.slice(5), url);
  if (!get) return sendError(res, 405, 'Method not allowed');

  if (pathname === '/' || pathname === '/index.html') return sendFile(req, res, INDEX_FILE);
  if (pathname === '/favicon.ico') return sendFile(req, res, path.join(BRAND_DIR, 'favicon.svg'));
  if (pathname.startsWith('/app/')) return serveApp(req, res, pathname.slice(5));
  if (pathname.startsWith('/p/')) return serveProject(ctx, req, res, pathname.slice(3));
  return sendError(res, 404, 'Not found');
}

/** /app/* -> player/app/*; /app/brand/* falls back to docs/brand/*. */
function serveApp(req, res, rel) {
  const file = resolveInside(APP_DIR, rel);
  if (!file) return sendError(res, 403, 'Forbidden');
  if (!isFile(file) && rel.startsWith('brand/')) {
    const brand = resolveInside(BRAND_DIR, rel.slice(6));
    if (!brand) return sendError(res, 403, 'Forbidden');
    return sendFile(req, res, brand);
  }
  return sendFile(req, res, file);
}

/** /p/* -> a file in the project, else in its public/ folder. */
function serveProject(ctx, req, res, rel) {
  // Hidden files (.env, .git...) stay private; only our own .motionsnip folder is served.
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => p.startsWith('.') && p !== '.motionsnip')) return sendError(res, 403, 'Forbidden');
  const file = resolveInside(ctx.dir, rel);
  if (!file) return sendError(res, 403, 'Forbidden');
  if (isFile(file)) return sendFile(req, res, file);
  const pub = resolveInside(path.join(ctx.dir, 'public'), rel);
  if (pub && isFile(pub)) return sendFile(req, res, pub);
  return sendError(res, 404, 'Not found');
}

async function api(ctx, req, res, route, url) {
  const m = req.method === 'HEAD' ? 'GET' : req.method;
  const key = `${m} ${route}`;
  switch (key) {
    case 'GET reel':
      return apiReel(ctx, res);
    case 'GET state':
      return apiGetState(ctx, res);
    case 'POST state':
      return apiPostState(ctx, req, res);
    case 'POST upload':
      return apiUpload(ctx, req, res, url);
    case 'POST feedback':
      return apiFeedback(ctx, req, res);
    case 'GET export':
      return sendJson(res, 200, ctx.job);
    case 'POST export':
      return apiExport(ctx, req, res);
    case 'POST reveal':
      return apiReveal(ctx, req, res);
    case 'GET takes':
      return apiTakes(ctx, res);
    case 'GET cutdown':
      return sendJson(res, 200, ctx.cut);
    case 'POST cutdown':
      return apiCutdown(ctx, req, res);
    case 'POST cutdown-remove':
      return apiCutdownRemove(ctx, req, res);
    case 'GET formats':
      return apiFormats(ctx, res);
    case 'POST project-apply':
      return apiProjectApply(ctx, req, res);
    case 'POST timeline-open':
      return apiTimelineOpen(ctx, req, res);
    case 'POST frames-start':
      return apiFramesStart(ctx, req, res);
    case 'POST frames-push':
      return apiFramesPush(ctx, req, res, url);
    case 'POST frames-end':
      return apiFramesEnd(ctx, req, res, url);
    case 'GET ffmpeg': {
      const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
      // edits: this ffmpeg can export a plain video's trim, cuts, colour and layers
      return sendJson(res, 200, { ok: !!ff, path: ff ? ff.path : null, edits: !!(await editEncoder(ctx, ff)) });
    }
    default:
      return sendError(res, 404, 'Unknown API route');
  }
}

/** Load reel.json (or, with none, the plain video's made-up reel), or throw an http error with a short message. */
async function loadReel(ctx) {
  const reel = await readReel(ctx);
  const mine = readPlayerOutputs(ctx.dir);
  if (mine.length || reel.outputs) reel.outputs = mergeOutputs(reel.outputs, mine);
  return reel;
}

async function readReel(ctx) {
  const file = path.join(ctx.dir, 'reel.json');
  if (!fs.existsSync(file)) {
    // a video opened as a file plays plain until "Open in timeline" makes a timeline.json for it
    if (isFile(path.join(ctx.dir, 'timeline.json')) && (!ctx.video || timelineFrom(ctx) === ctx.video)) return timelineReel(ctx);
    if (ctx.video) return plainReel(ctx);
    return isFile(path.join(ctx.dir, 'scene.json')) ? sceneReel(ctx) : plainReel(ctx);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw httpError(404, `reel.json not found in ${ctx.dir}`);
  }
  let reel;
  try {
    reel = parseReel(text);
  } catch (err) {
    throw httpError(500, `reel.json is not valid JSON: ${err.message}`);
  }
  if (!reel || typeof reel !== 'object' || Array.isArray(reel)) throw httpError(500, 'reel.json must be a JSON object');
  if (!reel.path) reel.path = ctx.dir; // so the prompt can always say where the project is
  return reel;
}

async function apiReel(ctx, res) {
  const reel = await loadReel(ctx);
  ensureTake(ctx, reel); // snapshot this version's video for compare (in the background)
  return sendJson(res, 200, reel);
}

const stateFile = (ctx) => path.join(ctx.dir, '.motionsnip', 'state.json');

function apiGetState(ctx, res) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile(ctx), 'utf8'));
  } catch {}
  return sendJson(res, 200, state);
}

async function apiPostState(ctx, req, res) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'State must be a JSON object');
  await writeAtomic(stateFile(ctx), JSON.stringify(body, null, 1));
  return sendJson(res, 200, { ok: true });
}

async function apiUpload(ctx, req, res, url) {
  const name = cleanName(url.searchParams.get('name'), [...AUDIO_EXTS, ...IMAGE_EXTS, ...VIDEO_EXTS]);
  if (!name) throw httpError(400, 'Only mp3, wav, m4a, png, jpg, webp, mp4, mov or webm files can be uploaded');
  const type = IMAGE_EXTS.includes(extOf(name)) ? 'image' : VIDEO_EXTS.includes(extOf(name)) ? 'video' : 'audio';
  const limit = type === 'video' ? VIDEO_LIMIT : UPLOAD_LIMIT;
  const tooBig = `File is over ${Math.round(limit / 1024 / 1024)} MB`;
  if (Number(req.headers['content-length']) > limit) throw httpError(413, tooBig);

  const assets = path.join(ctx.dir, 'assets');
  await fsp.mkdir(assets, { recursive: true });
  const tmp = path.join(assets, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    // Stream to a temp file so big files never sit in memory.
    const size = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total > limit) {
          reject(httpError(413, tooBig));
          req.unpipe(out);
          out.destroy();
          req.resume();
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve(total));
      req.pipe(out);
    });
    if (!size) throw httpError(400, 'The file is empty');

    // The first bytes must match the extension.
    const head = Buffer.alloc(16);
    const fd = await fsp.open(tmp, 'r');
    await fd.read(head, 0, 16, 0);
    await fd.close();
    const want = extOf(name) === 'jpeg' ? 'jpg' : extOf(name);
    const got = type === 'image' ? sniffImage(head) : type === 'video' ? sniffVideo(head) : sniffAudio(head);
    const ok = type === 'video' ? got === (want === 'webm' ? 'webm' : 'iso') : got === want;
    if (!ok) throw httpError(415, `This doesn't look like a .${extOf(name)} file`);

    // Never overwrite: link fails if the name is taken, so try name-2, name-3...
    let final = null;
    for (let n = 1; n < 10000 && !final; n++) {
      const candidate = path.join(assets, numberedName(name, n));
      try {
        await fsp.link(tmp, candidate);
        final = candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!final) throw httpError(500, 'No free file name');
    const base = path.basename(final);
    return sendJson(res, 200, { id: `assets/${base}`, name: base, type });
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function apiFeedback(ctx, req, res) {
  const body = await readJson(req);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 0) throw httpError(400, 'version must be a whole number');
  if (typeof body.markdown !== 'string' || !body.markdown.trim()) throw httpError(400, 'markdown is required');
  const file = path.join(ctx.dir, '.motionsnip', `feedback-v${version}.md`);
  await writeAtomic(file, body.markdown.endsWith('\n') ? body.markdown : body.markdown + '\n');
  return sendJson(res, 200, { path: file });
}

async function apiReveal(ctx, req, res) {
  const body = await readJson(req);
  const file = typeof body?.path === 'string' ? resolveInside(ctx.dir, body.path) : null;
  if (!file) throw httpError(403, 'Path must be inside the project');
  if (!fs.existsSync(file)) throw httpError(404, 'Not found');
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', file]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${file}`]]
        : ['xdg-open', [fs.statSync(file).isDirectory() ? file : path.dirname(file)]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
  return sendJson(res, 200, { ok: true });
}

// --- Takes: copies of recent versions' videos, for compare ----------------

const takesDir = (ctx) => path.join(ctx.dir, '.motionsnip', 'takes');

function listTakes(ctx) {
  let names = [];
  try {
    names = fs.readdirSync(takesDir(ctx));
  } catch {}
  return names
    .map((n) => {
      const m = /^v(\d+)\.([A-Za-z0-9]+)$/.exec(n);
      return m ? { version: Number(m[1]), file: n } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.version - a.version);
}

/** Copy the current version's video into .motionsnip/takes/v<N>.<ext>, keep the newest 6. */
function ensureTake(ctx, reel) {
  const version = Number(reel.version);
  if (!Number.isInteger(version) || version < 0 || typeof reel.src !== 'string') return Promise.resolve();
  const src = resolveInside(ctx.dir, reel.src);
  if (!src || !isFile(src)) return Promise.resolve();
  const ext = extOf(src) || 'mp4';
  const dest = path.join(takesDir(ctx), `v${version}.${ext}`);
  // Copy when missing, or when the render changed after we copied it (Claude bumped the version mid-render).
  try {
    if (fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve();
  } catch {}
  if (ctx.takesBusy.has(dest)) return Promise.resolve();
  ctx.takesBusy.add(dest);
  return (async () => {
    try {
      await fsp.mkdir(takesDir(ctx), { recursive: true });
      const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
      let copied = false;
      if (process.platform === 'darwin') copied = (await run('cp', ['-c', src, tmp])).code === 0; // APFS clone
      if (!copied) await fsp.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE);
      await fsp.rename(tmp, dest);
      // Other files for this version (different extension) are stale now.
      for (const t of listTakes(ctx)) if (t.version === version && t.file !== path.basename(dest)) await fsp.rm(path.join(takesDir(ctx), t.file), { force: true });
      for (const t of listTakes(ctx).slice(KEEP_TAKES)) await fsp.rm(path.join(takesDir(ctx), t.file), { force: true });
    } catch (err) {
      console.error('Could not save take:', err.message);
    } finally {
      ctx.takesBusy.delete(dest);
    }
  })();
}

async function apiTakes(ctx, res) {
  try {
    await ensureTake(ctx, await loadReel(ctx));
  } catch {}
  const takes = listTakes(ctx).map((t) => ({
    version: t.version,
    src: `.motionsnip/takes/${t.file}`,
    url: `/p/.motionsnip/takes/${t.file}`,
  }));
  return sendJson(res, 200, takes);
}

// --- Frame exports -------------------------------------------------------------
// The player draws each frame (a scene, graphics, captions) and streams PNGs here; ffmpeg encodes them.

const FRAMES_LIMIT = 160 * 1024 * 1024; // one push: a batch of frames (raw 4K RGBA is 33 MB a frame)
const MAX_FRAMES = 60 * 60 * 20; // 20 minutes at 60 fps

async function formatsFor(ctx, ff) {
  if (!ff) return {};
  if (ctx.formats?.path === ff.path) return ctx.formats.list;
  const r = await run(ff.path, ['-hide_banner', '-encoders'], { env: ffmpegEnv(ff) });
  const list = availableFormats(encoderSet(r.stdout));
  ctx.formats = { path: ff.path, list };
  return list;
}

async function apiFormats(ctx, res) {
  const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
  const have = await formatsFor(ctx, ff);
  const formats = Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext, ok: !!have[id], encoder: have[id] || null }));
  return sendJson(res, 200, { ffmpeg: !!ff, formats });
}

/** Where a scene's last export is remembered (scene.json stays Claude's file). */
const renderFile = (ctx) => path.join(ctx.dir, '.motionsnip', 'render.json');

/** Whether a media file has a sound track (cached per file version). */
async function hasSound(ctx, ff, file) {
  const st = fs.statSync(file);
  const sig = `${file}:${st.size}:${st.mtimeMs}`;
  ctx.sound ||= new Map();
  if (!ctx.sound.has(sig)) ctx.sound.set(sig, probe(ff, file).then((i) => !!i.hasAudio, () => true));
  return ctx.sound.get(sig);
}

async function apiFramesStart(ctx, req, res) {
  // a frame export whose page went away (reload, closed tab) stops blocking after 20 s without frames
  const stale = ctx.frames && Date.now() - ctx.frames.last > 20000;
  if (stale) {
    ctx.frames.failed = 'Abandoned';
    ctx.frames.child.kill('SIGKILL');
    fs.rmSync(ctx.frames.out, { force: true });
    fs.rmSync(ctx.frames.picture, { force: true });
    ctx.frames = null;
    setJob(ctx, { state: 'idle', pct: 0, line: '', out: null, rel: null, mode: null });
  }
  if (ctx.job.state === 'running') throw httpError(409, 'An export is already running');
  const body = (await readJson(req)) || {};
  const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
  if (!ff) throw httpError(400, 'ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.');
  const format = FORMATS[body.format] ? body.format : 'mp4';
  const encoder = (await formatsFor(ctx, ff))[format];
  if (!encoder) throw httpError(400, `This ffmpeg can't make ${FORMATS[format].label}.`);
  const even = (v, d) => Math.max(16, Math.min(4096, Math.round(num(v, d) / 2) * 2));
  const w = even(body.w, 1920);
  const h = even(body.h, 1080);
  const fps = clamp(Math.round(num(body.fps, 30)), 1, 60);
  const frames = Math.round(num(body.frames, 0));
  if (!(frames > 0) || frames > MAX_FRAMES) throw httpError(400, 'Bad frame count');
  const audio = [];
  for (const c of (Array.isArray(body.audio) ? body.audio : []).slice(0, 32)) {
    const file = typeof c?.src === 'string' ? resolveInside(ctx.dir, c.src) : null;
    if (!file || !isFile(file)) throw httpError(400, `Audio not found in the project: ${c?.src}`);
    if (!(await hasSound(ctx, ff, file))) continue; // a video clip with no sound track adds nothing to the mix
    audio.push({ file, at: num(c.at, 0), in: num(c.in, 0), out: num(c.out, null), gain: num(c.gain, 1), fadeIn: num(c.fadeIn, 0), fadeOut: num(c.fadeOut, 0) });
  }
  const reel = await loadReel(ctx);
  const exportsDir = path.join(ctx.dir, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const tag = typeof body.tag === 'string' && /^[\w-]{1,24}$/.test(body.tag) ? `-${body.tag}` : '';
  const out = freePath(exportsDir, `${slug(reel.id)}${tag}-${stamp()}.${FORMATS[format].ext}`);
  const rel = path.relative(ctx.dir, out).split(path.sep).join('/');
  const raw = body.pix === 'rgba';
  // with sound, the frames become a picture-only file first and the sound is added in a second pass (see buildMuxArgs)
  const withSound = !!buildMuxArgs({ video: out, out, format, duration: frames / fps, audio });
  const picture = withSound ? out.replace(/(\.\w+)$/, '.picture$1') : out;
  const args = buildFramesArgs({ fps, w, h, frames, out: picture, format, encoder, raw });
  const child = spawn(ff.path, args, { env: ffmpegEnv(ff), stdio: ['pipe', 'pipe', 'pipe'] });
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, child, total: frames, got: 0, last: Date.now(), out, picture, audio, duration: frames / fps, rel, format, frameBytes: raw ? w * h * 4 : 0, lastFrame: null, failed: null, version: reel.version, setSrc: !!body.setSrc && format !== 'gif', captions: !!body.captions && !!reel.timeline };
  let errText = '';
  child.stderr.on('data', (d) => (errText = (errText + d).slice(-4000)));
  child.stdout.resume(); // -progress output: unread, its pipe fills and ffmpeg stops mid-export
  child.stdin.on('error', () => {}); // EPIPE when ffmpeg stops early; reported from 'close'
  job.done = new Promise((resolve) => {
    child.on('error', (err) => {
      job.failed = err.message;
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0 && !job.failed) job.failed = lastLine(errText) || `ffmpeg exited with code ${code}`;
      resolve();
    });
  });
  ctx.frames = job;
  ctx.child = child;
  ctx.job = { state: 'running', pct: 0, line: `Drawing frames (0/${frames})…`, out, rel, mode: 'frames' };
  return sendJson(res, 200, { job: id, format, encoder, w, h, fps, frames, rel });
}

function framesJob(ctx, url) {
  const j = ctx.frames;
  if (!j || j.id !== url.searchParams.get('job')) throw httpError(404, 'No such export');
  return j;
}

async function apiFramesPush(ctx, req, res, url) {
  const j = framesJob(ctx, url);
  const buf = await readBody(req, FRAMES_LIMIT);
  if (j.failed) throw httpError(500, j.failed);
  // ?repeat=n: the last frame again n times (a still stretch costs no upload)
  const repeat = Math.min(Math.max(0, Math.round(num(url.searchParams.get('repeat'), 0))), j.total - j.got);
  if (repeat) {
    if (!j.frameBytes || !j.lastFrame) throw httpError(400, 'Nothing to repeat');
    j.last = Date.now();
    for (let i = 0; i < repeat; i++) if (!j.child.stdin.write(j.lastFrame)) await new Promise((r) => j.child.stdin.once('drain', r));
    j.got += repeat;
  } else {
    if (!buf.length) return sendJson(res, 200, { got: j.got });
    if (j.frameBytes) {
      if (buf.length % j.frameBytes) throw httpError(400, `Raw frames must be ${j.frameBytes} bytes each`);
    } else if (buf.readUInt32BE(0) !== 0x89504e47) throw httpError(400, 'Frames must be PNG');
    j.last = Date.now();
    const ok = j.child.stdin.write(buf);
    if (!ok) await new Promise((r) => j.child.stdin.once('drain', r));
    if (j.frameBytes) {
      j.got += buf.length / j.frameBytes;
      j.lastFrame = Buffer.from(buf.subarray(buf.length - j.frameBytes));
    } else j.got += countPngs(buf);
  }
  setJob(ctx, { pct: clamp((j.got / j.total) * 97, 0, 97), line: `Drawing frames (${Math.min(j.got, j.total)}/${j.total})…` });
  if (j.failed) throw httpError(500, j.failed);
  return sendJson(res, 200, { got: j.got });
}

async function apiFramesEnd(ctx, req, res, url) {
  const j = framesJob(ctx, url);
  await readBody(req, JSON_LIMIT);
  if (url.searchParams.get('cancel')) {
    j.failed = 'Cancelled';
    j.child.kill('SIGKILL');
    await j.done;
    fs.rmSync(j.out, { force: true });
    fs.rmSync(j.picture, { force: true });
    ctx.frames = null;
    ctx.child = null;
    setJob(ctx, { state: 'idle', pct: 0, line: '', out: null, rel: null, mode: null });
    return sendJson(res, 200, ctx.job);
  }
  setJob(ctx, { line: 'Encoding…', pct: 98 });
  j.child.stdin.end();
  await j.done;
  if (!j.failed && j.picture !== j.out) {
    setJob(ctx, { line: 'Adding sound…', pct: 99 });
    const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
    const r = await run(ff.path, buildMuxArgs({ video: j.picture, out: j.out, format: j.format, duration: j.duration, audio: j.audio }), { env: ffmpegEnv(ff) });
    if (r.code !== 0) j.failed = lastLine(r.stderr) || `ffmpeg exited with code ${r.code}`;
  }
  if (j.picture !== j.out) fs.rmSync(j.picture, { force: true });
  ctx.frames = null;
  ctx.child = null;
  if (j.failed) {
    fs.rmSync(j.out, { force: true });
    setJob(ctx, { state: 'error', line: j.failed, out: null, rel: null });
  } else {
    if (j.setSrc) {
      try {
        fs.mkdirSync(path.dirname(renderFile(ctx)), { recursive: true });
        fs.writeFileSync(renderFile(ctx), JSON.stringify({ version: j.version, src: j.rel }));
      } catch {
        /* the export still worked */
      }
    }
    const side = j.captions ? await writeCaptionFiles(ctx, j.out).catch(() => []) : [];
    setJob(ctx, { state: 'done', pct: 100, line: `Saved ${j.rel}${side.length ? ` and its captions (${side.join(', ')})` : ''}` });
  }
  return sendJson(res, 200, ctx.job);
}

/** A timeline's captions next to an export: name.srt and name.vtt. Returns the extensions written. */
async function writeCaptionFiles(ctx, out) {
  const { raw } = readProjectFile(ctx, 'timeline.json');
  const cues = captionCues(normTimeline(raw, { scenes: await timelineScenes(ctx, raw) }));
  if (!cues.length) return [];
  const base = out.replace(/\.[^./\\]+$/, '');
  fs.writeFileSync(base + '.srt', toSrt(cues));
  fs.writeFileSync(base + '.vtt', toVtt(cues));
  return ['.srt', '.vtt'];
}

// --- Export ------------------------------------------------------------------

function setJob(ctx, patch) {
  Object.assign(ctx.job, patch);
}

function lastLine(text) {
  const lines = String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // ANSI colours
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.pop() || '').slice(0, 200);
}

async function apiExport(ctx, req, res) {
  if (ctx.job.state === 'running') throw httpError(409, 'An export is already running');
  const body = (await readJson(req, EXPORT_LIMIT)) || {};
  const mode = ['render', 'edit'].includes(body.mode) ? body.mode : 'mix';
  const reel = await loadReel(ctx);

  // Music: a project path, or none.
  let music = null;
  if (body.music) {
    music = typeof body.music === 'string' ? resolveInside(ctx.dir, body.music) : null;
    if (!music || !isFile(music)) throw httpError(400, 'Music file not found in the project');
  }
  const levels = {
    music,
    musicVol: clamp(num(body.musicVol, 1), 0, 1),
    sfxVol: clamp(num(body.sfxVol, 1), 0, 1),
    musicOffset: num(body.musicOffset, 0),
    musicFade: Math.max(0, num(body.musicFade, 0)),
  };

  const exportsDir = path.join(ctx.dir, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const out = freePath(exportsDir, `${slug(reel.id)}-${stamp()}.mp4`);
  const rel = path.relative(ctx.dir, out).split(path.sep).join('/');
  ctx.job = { state: 'running', pct: 0, line: 'Starting…', out, rel, mode };

  if (mode === 'render') {
    if (!reel.export || typeof reel.export.cmd !== 'string' || !reel.export.cmd.trim()) {
      ctx.job = { state: 'idle', pct: 0, line: '', out: null, rel: null, mode: null };
      throw httpError(400, 'reel.json has no export.cmd');
    }
    runRender(ctx, reel, body.props, levels, out).catch((err) => setJob(ctx, { state: 'error', line: err.message }));
  } else if (mode === 'edit') {
    const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
    const encoder = await editEncoder(ctx, ff);
    const video = resolveInside(ctx.dir, String(reel.src || ''));
    const fail = (line) => {
      setJob(ctx, { state: 'error', line, out: null, rel: null });
      return sendJson(res, 200, ctx.job);
    };
    if (!ff) return fail('ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.');
    if (!encoder) return fail("This ffmpeg can't apply edits (it has no video filters). Install the full one (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.");
    if (!video || !isFile(video)) return fail(`Video not found: ${reel.src}`);
    runEdit(ctx, ff, encoder, video, reel, body.edit, levels, out)
      .then(() => setJob(ctx, { state: 'done', pct: 100, line: `Saved ${rel}` }))
      .catch((err) => {
        fs.rmSync(out, { force: true });
        setJob(ctx, { state: 'error', line: err.message, out: null, rel: null });
      });
  } else {
    const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
    if (!ff) {
      setJob(ctx, { state: 'error', line: 'ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.', out: null, rel: null });
      return sendJson(res, 200, ctx.job);
    }
    const video = resolveInside(ctx.dir, String(reel.src || ''));
    if (!video || !isFile(video)) {
      setJob(ctx, { state: 'error', line: `Video not found: ${reel.src}`, out: null, rel: null });
      return sendJson(res, 200, ctx.job);
    }
    runMix(ctx, ff, video, levels, out, reel.duration)
      .then(() => setJob(ctx, { state: 'done', pct: 100, line: `Saved ${rel}` }))
      .catch((err) => {
        fs.rmSync(out, { force: true });
        setJob(ctx, { state: 'error', line: err.message, out: null, rel: null });
      });
  }
  return sendJson(res, 200, ctx.job);
}

/** Copy the video and mix in the music with ffmpeg. Updates ctx.job.pct as it goes. */
async function runMix(ctx, ff, video, levels, out, reelDuration) {
  const info = await probe(ff, video);
  const duration = info.duration || num(reelDuration, 0);
  if (!(duration > 0)) throw new Error('Could not read the video duration');
  const args = buildMixArgs({ video, out, duration, hasVideoAudio: info.hasAudio, ...levels });
  setJob(ctx, { line: 'Mixing audio…' });
  await new Promise((resolve, reject) => {
    const child = spawn(ff.path, args, { env: ffmpegEnv(ff), stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.child = child;
    let errText = '';
    child.stdout.on('data', (d) => {
      // -progress pipe:1 prints "out_time_us=12345" lines.
      const m = [...String(d).matchAll(/out_time_us=(\d+)/g)].pop();
      if (m) setJob(ctx, { pct: clamp((Number(m[1]) / 1e6 / duration) * 100, 0, 99) });
    });
    child.stderr.on('data', (d) => (errText = (errText + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => {
      ctx.child = null;
      if (code === 0) resolve();
      else reject(new Error(lastLine(errText) || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Export an edited plain video: trim, cuts, colour, blur boxes, and text/logo layers the player drew as
 * full-frame PNGs (data URLs in edit.layers[].png). Updates ctx.job.pct over the edited length.
 */
async function runEdit(ctx, ff, encoder, video, reel, edit, levels, out) {
  const info = await probe(ff, video);
  const D = info.duration || num(reel.duration, 0);
  const W = info.w;
  const H = info.h;
  if (!(D > 0) || !W || !H) throw new Error("Couldn't read the video's length or size");
  const e = edit && typeof edit === 'object' ? edit : {};
  const keep = keepRanges(D, e.trim, e.cuts);
  if (!keep.length) throw new Error('Nothing left to export: the cuts cover the whole video');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motionsnip-edit-'));
  try {
    const layers = [];
    const span = (t) => {
      const a = within(t?.[0], 0, 0, D);
      const b = within(t?.[1], D, 0, D);
      return [Math.min(a, b), Math.max(a, b)];
    };
    for (const l of (Array.isArray(e.layers) ? e.layers : []).slice(0, MAX_LAYERS)) {
      if (!l || typeof l !== 'object') continue;
      const t = span(l.t);
      if (t[1] - t[0] < 0.02) continue;
      if (l.kind === 'blur') {
        // even pixel numbers, inside the frame
        const b = (Array.isArray(l.box) ? l.box : []).map((v) => within(v, 0, 0, 100));
        const X = Math.min(W - 2, Math.floor(((b[0] / 100) * W) / 2) * 2);
        const Y = Math.min(H - 2, Math.floor(((b[1] / 100) * H) / 2) * 2);
        const w = Math.min(W - X, Math.max(2, Math.round(((b[2] / 100) * W) / 2) * 2));
        const h = Math.min(H - Y, Math.max(2, Math.round(((b[3] / 100) * H) / 2) * 2));
        layers.push({ kind: 'blur', t, box: [X, Y, w, h], sigma: (within(l.amount, 2, 0.1, 20) / 100) * H });
      } else if (typeof l.png === 'string' && l.png.startsWith('data:image/png;base64,')) {
        const buf = Buffer.from(l.png.slice(22), 'base64');
        if (buf.length > LAYER_LIMIT || sniffImage(buf) !== 'png') continue;
        const file = path.join(tmp, `layer-${layers.length}.png`);
        fs.writeFileSync(file, buf);
        layers.push({ kind: 'png', t, file, fade: !!l.fade });
      }
    }
    const OD = keep.reduce((s, [a, b]) => s + b - a, 0);
    const args = buildEditArgs({ video, hasVideoAudio: info.hasAudio, W, H, fps: info.fps || reel.fps, D, keep, look: e.look, layers, encoder, out, ...levels });
    setJob(ctx, { line: 'Applying your edits…' });
    await new Promise((resolve, reject) => {
      const child = spawn(ff.path, args, { env: ffmpegEnv(ff), stdio: ['ignore', 'pipe', 'pipe'] });
      ctx.child = child;
      let errText = '';
      child.stdout.on('data', (d) => {
        const m = [...String(d).matchAll(/out_time_us=(\d+)/g)].pop();
        if (m) setJob(ctx, { pct: clamp((Number(m[1]) / 1e6 / OD) * 100, 0, 99) });
      });
      child.stderr.on('data', (d) => (errText = (errText + d).slice(-4000)));
      child.on('error', reject);
      child.on('close', (code) => {
        ctx.child = null;
        if (code === 0) resolve();
        else reject(new Error(lastLine(errText) || `ffmpeg exited with code ${code}`));
      });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Cutdowns -----------------------------------------------------------------

/** Music and levels from a request body (the player's current audio). */
function levelsFrom(ctx, body) {
  let music = null;
  if (body.music) {
    music = typeof body.music === 'string' ? resolveInside(ctx.dir, body.music) : null;
    if (!music || !isFile(music)) throw httpError(400, 'Music file not found in the project');
  }
  return {
    music,
    musicVol: clamp(num(body.musicVol, 1), 0, 1),
    sfxVol: clamp(num(body.sfxVol, 1), 0, 1),
    musicOffset: num(body.musicOffset, 0),
    musicFade: Math.max(0, num(body.musicFade, 0)),
  };
}

/** Make (or make again) a cutdown: POST { id: preset or output id, keys?, mode?, zoom?, ranges?, music, levels }. */
async function apiCutdown(ctx, req, res) {
  if (ctx.cut.state === 'running') throw httpError(409, 'A cutdown is already being made');
  const body = (await readJson(req)) || {};
  if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'Which cutdown? (id)');
  const reel = await readReel(ctx);
  const mine = readPlayerOutputs(ctx.dir);
  if ((Array.isArray(reel.outputs) ? reel.outputs : []).some((o) => o && String(o.id) === body.id)) {
    throw httpError(400, 'Claude made this version; ask Claude to change it');
  }
  const levels = levelsFrom(ctx, body);
  const fail = (line) => {
    ctx.cut = { state: 'error', pct: 0, line, id: body.id, label: null };
    return sendJson(res, 200, ctx.cut);
  };
  const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
  if (!ff) return fail('ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.');
  const encoder = await cutEncoder(ctx, ff);
  if (!encoder) return fail("This ffmpeg can't make cutdowns (it has no video filters). Install the full one (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.");
  const video = resolveInside(ctx.dir, String(reel.src || ''));
  if (!video || !isFile(video)) return fail(`Video not found: ${reel.src}`);
  const info = await probe(ff, video);
  if (!(info.duration > 0) || !info.w || !info.h) return fail("Couldn't read the video's length or size");

  const prev = mine.find((o) => o.id === body.id) || null;
  let entry;
  try {
    entry = planCutdown({ ...reel, w: info.w, h: info.h, duration: info.duration }, body, prev);
  } catch (err) {
    return fail(err.message);
  }
  ctx.cut = { state: 'running', pct: 0, line: `Making the ${entry.label} version…`, id: entry.id, label: entry.label };
  runCutdown(ctx, ff, encoder, video, info, reel, entry, levels)
    .then(() => setCut(ctx, { state: 'done', pct: 100, line: `Saved ${entry.src}` }))
    .catch((err) => setCut(ctx, { state: 'error', line: err.message }));
  return sendJson(res, 200, ctx.cut);
}

function setCut(ctx, patch) {
  Object.assign(ctx.cut, patch);
}

/** The encoder for cutdowns: an edit encoder, if this ffmpeg also has setsar. */
async function cutEncoder(ctx, ff) {
  const encoder = await editEncoder(ctx, ff);
  if (!encoder) return null;
  if (ctx.cutOk?.path !== ff.path) {
    const r = await run(ff.path, ['-hide_banner', '-filters'], { env: ffmpegEnv(ff) });
    const have = new Set([...String(r.stdout).matchAll(/^ [A-Z.|]{2,4} (\S+) /gm)].map((m) => m[1]));
    ctx.cutOk = { path: ff.path, ok: CUTDOWN_FILTERS.every((f) => have.has(f)) };
  }
  return ctx.cutOk.ok ? encoder : null;
}

async function runCutdown(ctx, ff, encoder, video, info, reel, entry, levels) {
  const D = info.duration;
  const keep = entry.kind === 'bumper' ? entry.ranges : [[0, D]];
  const reframe = entry.kind === 'reframe' ? reframeSpec(info.w, info.h, entry) : null;
  const dir = path.join(ctx.dir, 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `${entry.id}.mp4`);
  const tmp = path.join(dir, `.${entry.id}.${crypto.randomBytes(3).toString('hex')}.mp4`);
  const OD = keep.reduce((s, [a, b]) => s + b - a, 0);
  const args = buildEditArgs({ video, hasVideoAudio: info.hasAudio, W: info.w, H: info.h, fps: info.fps || reel.fps, D, keep, reframe, encoder, out: tmp, ...levels });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ff.path, args, { env: ffmpegEnv(ff), stdio: ['ignore', 'pipe', 'pipe'] });
      ctx.cutChild = child;
      let errText = '';
      child.stdout.on('data', (d) => {
        const m = [...String(d).matchAll(/out_time_us=(\d+)/g)].pop();
        if (m) setCut(ctx, { pct: clamp((Number(m[1]) / 1e6 / OD) * 100, 0, 99) });
      });
      child.stderr.on('data', (d) => (errText = (errText + d).slice(-4000)));
      child.on('error', reject);
      child.on('close', (code) => {
        ctx.cutChild = null;
        if (code === 0) resolve();
        else reject(new Error(lastLine(errText) || `ffmpeg exited with code ${code}`));
      });
    });
    fs.renameSync(tmp, final);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // list it (re-read: the list may have changed while ffmpeg ran)
  const list = readPlayerOutputs(ctx.dir);
  const i = list.findIndex((o) => o.id === entry.id);
  const version = i >= 0 ? (Number(list[i].version) || 1) + 1 : 1;
  const done = { ...entry, version, from: Number(reel.version) || 1, made: new Date().toISOString() };
  if (i >= 0) list[i] = done;
  else list.push(done);
  writePlayerOutputs(ctx.dir, list);
}

/** Remove a cutdown made in the player, and its video. */
async function apiCutdownRemove(ctx, req, res) {
  const body = (await readJson(req)) || {};
  if (ctx.cut.state === 'running' && ctx.cut.id === body.id) throw httpError(409, 'That cutdown is being made');
  const list = readPlayerOutputs(ctx.dir);
  const o = list.find((x) => x.id === body.id);
  if (!o) throw httpError(404, 'No such cutdown');
  const file = resolveInside(ctx.dir, `outputs/${o.id}.mp4`);
  if (file) fs.rmSync(file, { force: true });
  writePlayerOutputs(ctx.dir, list.filter((x) => x !== o));
  return sendJson(res, 200, { ok: true });
}

/**
 * Run reel.json export.cmd. Env: PROPS (JSON file), OUT, RAW (temp path), PROJECT.
 * If the command writes $OUT we're done. If it only writes $RAW, we mix the music into it to make $OUT
 * (so a render can stay effects-only and the reviewer's music settings still apply).
 */
async function runRender(ctx, reel, reqProps, levels, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motionsnip-'));
  try {
    const props = { ...(reel.export.props || {}), ...(reqProps && typeof reqProps === 'object' ? reqProps : {}) };
    const propsFile = path.join(tmp, 'props.json');
    fs.writeFileSync(propsFile, JSON.stringify(props));
    const raw = path.join(tmp, 'raw.mp4');
    const cwd = reel.export.cwd ? path.resolve(ctx.dir, String(reel.export.cwd)) : ctx.dir;
    if (!fs.existsSync(cwd)) throw new Error(`export.cwd not found: ${cwd}`);
    setJob(ctx, { line: 'Rendering…' });

    await new Promise((resolve, reject) => {
      const env = { ...process.env, PROPS: propsFile, OUT: out, RAW: raw, PROJECT: ctx.dir };
      const child = spawn('sh', ['-c', reel.export.cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      ctx.child = child;
      let tail = '';
      const onData = (d) => {
        tail = (tail + d).slice(-4000);
        const pct = progressFromText(String(d));
        const line = lastLine(d);
        setJob(ctx, { ...(pct !== null ? { pct: clamp(pct, 0, 99) } : {}), ...(line ? { line } : {}) });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => {
        ctx.child = null;
        if (code === 0) resolve();
        else reject(new Error(lastLine(tail) || `export command exited with code ${code}`));
      });
    });

    if (!isFile(out)) {
      if (!isFile(raw)) throw new Error('The export command finished but wrote neither $OUT nor $RAW');
      const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
      if (levels.music && ff) {
        await runMix(ctx, ff, raw, levels, out, reel.duration);
      } else {
        await fsp.copyFile(raw, out);
      }
    }
    const rel = path.relative(ctx.dir, out).split(path.sep).join('/');
    setJob(ctx, { state: 'done', pct: 100, line: `Saved ${rel}` });
  } catch (err) {
    setJob(ctx, { state: 'error', line: err.message, out: null, rel: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

/** Test helper: one HTTP request to a test server. */
function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString());
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

async function selftest() {
  const assert = (await import('node:assert/strict')).default;
  const tmpDirs = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'motionsnip-test-'));
    tmpDirs.push(d);
    return d;
  };
  try {
    // Byte ranges
    assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
    assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
    assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable');
    assert.equal(parseRange(undefined, 1000), null);
    assert.equal(parseRange('bytes=200-100', 1000), null);
    assert.equal(parseRange('bytes=0-1,5-9', 1000), null);
    assert.equal(parseRange('items=0-1', 1000), null);
    assert.equal(parseRange('bytes=-', 1000), null);

    // Upload names
    assert.equal(cleanName('song.mp3'), 'song.mp3');
    assert.equal(cleanName('My Song (final).MP3'), 'My-Song-final.mp3');
    assert.equal(cleanName('../../etc/passwd.mp3'), 'passwd.mp3');
    assert.equal(cleanName('..\\..\\win\\x.wav'), 'x.wav');
    assert.equal(cleanName('.hidden.mp3'), 'hidden.mp3');
    assert.equal(cleanName('.mp3'), null); // no extension at all, just a dotfile
    assert.equal(cleanName('...m4a'), 'upload.m4a');
    assert.equal(cleanName('Café Ümlaut.m4a'), 'Cafe-Umlaut.m4a');
    assert.equal(cleanName('音楽.mp3'), 'upload.mp3');
    assert.equal(cleanName('a\0b.mp3'), 'ab.mp3');
    assert.equal(cleanName('evil.exe'), null);
    assert.equal(cleanName('evil.mp3.exe'), null);
    assert.equal(cleanName('noext'), null);
    assert.equal(cleanName(null), null);
    const long = cleanName('x'.repeat(300) + '.wav');
    assert.equal(long.length, 80);
    assert.ok(long.endsWith('.wav'));
    assert.equal(numberedName('a.mp3', 1), 'a.mp3');
    assert.equal(numberedName('a.mp3', 3), 'a-3.mp3');

    // Magic bytes
    const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
    assert.equal(sniffAudio(b('ID3', [4, 0, 0, 0, 0, 0])), 'mp3');
    assert.equal(sniffAudio(b([0xff, 0xfb, 0x90, 0x00])), 'mp3');
    assert.equal(sniffAudio(b('RIFF', [0, 0, 0, 0], 'WAVE', 'fmt ')), 'wav');
    assert.equal(sniffAudio(b('RIFF', [0, 0, 0, 0], 'AVI ', 'LIST')), null);
    assert.equal(sniffAudio(b([0, 0, 0, 0x20], 'ftyp', 'M4A ')), 'm4a');
    assert.equal(sniffAudio(b('<html><body>')), null);
    assert.equal(sniffAudio(b('ID')), null);

    // Host and origin
    assert.ok(hostAllowed('localhost:4321', 4321));
    assert.ok(hostAllowed('127.0.0.1:4321', 4321));
    assert.ok(hostAllowed('LOCALHOST:4321', 4321));
    assert.ok(!hostAllowed('localhost:4322', 4321));
    assert.ok(!hostAllowed('localhost', 4321));
    assert.ok(!hostAllowed('evil.com:4321', 4321));
    assert.ok(!hostAllowed('localhost.evil.com:4321', 4321));
    assert.ok(!hostAllowed(undefined, 4321));
    assert.ok(originAllowed('http://localhost:4321', 4321));
    assert.ok(originAllowed('http://127.0.0.1:4321', 4321));
    assert.ok(!originAllowed('https://localhost:4321', 4321));
    assert.ok(!originAllowed('http://localhost:4321.evil.com', 4321));
    assert.ok(!originAllowed('null', 4321));
    assert.ok(!originAllowed(undefined, 4321));

    // Paths
    const base = path.resolve(os.tmpdir(), 'proj');
    assert.equal(resolveInside(base, 'a/b.mp4'), path.join(base, 'a', 'b.mp4'));
    assert.equal(resolveInside(base, '../x'), null);
    assert.equal(resolveInside(base, 'a/../../x'), null);
    assert.equal(resolveInside(base, '/etc/passwd'), null);
    assert.equal(resolveInside(base, path.join(base, 'ok.mp3')), path.join(base, 'ok.mp3'));
    assert.equal(resolveInside(base, 'a\0b'), null);

    // reel.json parsing (tolerates comments and trailing commas)
    assert.deepEqual(parseReel('{"a":1}'), { a: 1 });
    assert.deepEqual(parseReel('{\n "a": "http://x", // note\n /* b */ "b": [1,2,],\n}'), { a: 'http://x', b: [1, 2] });
    assert.throws(() => parseReel('{nope'));

    // ffmpeg probe output and progress
    const probeText = `Input #0, mov,mp4: Duration: 00:01:02.50, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo`;
    assert.deepEqual(parseProbe(probeText), { duration: 62.5, hasAudio: true, hasVideo: true, w: 1280, h: 720, fps: 30 });
    assert.equal(parseProbe('Duration: 00:00:10.00\n Stream #0:0: Video: h264').hasAudio, false);
    const upright = 'Duration: 00:00:05.00\n  Stream #0:0: Video: hevc, yuv420p, 1920x1080, 29.97 fps\n    side data:\n      displaymatrix: rotation of -90.00 degrees';
    assert.deepEqual([parseProbe(upright).w, parseProbe(upright).h, parseProbe(upright).fps], [1080, 1920, 29.97]);
    assert.equal(parseProbe('Stream #0:0: Video: h264, 640x360, 25 tbr').fps, 25);

    // Image magic bytes
    assert.equal(sniffImage(b([0x89], 'PNG', [13, 10, 26, 10])), 'png');
    assert.equal(sniffImage(b([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
    assert.equal(sniffImage(b('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ')), 'webp');
    assert.equal(sniffImage(b('RIFF', [0, 0, 0, 0], 'WAVE', 'fmt ')), null);
    assert.equal(sniffImage(b('<svg>')), null);
    assert.equal(cleanName('Logo Final.PNG', [...AUDIO_EXTS, ...IMAGE_EXTS]), 'Logo-Final.png');
    assert.equal(cleanName('logo.png'), null, 'images only where asked for');

    // Frame exports: encoder choice, ffmpeg args, PNG counting
    {
      const have = encoderSet(' V....D libx264              H.264\n V....D gif                  GIF\n A....D aac                  AAC\n');
      assert.deepEqual(availableFormats(have), { mp4: 'libx264', gif: 'gif' });
      assert.equal(pickEncoder('webm', have), null);
      const a = buildFramesArgs({ fps: 30, w: 1280, h: 720, frames: 90, out: 'o.mp4', format: 'mp4', encoder: 'libx264' });
      assert.equal(a[a.indexOf('-vf') + 1], 'format=rgba,scale=1280:720,setsar=1');
      assert.ok(a.includes('-an') && a.filter((x) => x === '-i').length === 1, 'the picture pass reads only the frames');
      assert.deepEqual(a.slice(a.indexOf('image2pipe') - 1, a.indexOf('image2pipe') + 7), ['-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', 'pipe:0']);
      const mux = buildMuxArgs({ video: 'p.mp4', out: 'o.mp4', format: 'mp4', duration: 3, audio: [{ file: 'm.mp3', at: 0.5, in: 2, gain: 0.8, fadeOut: 1 }, { file: 'late.mp3', at: 5 }] });
      const fc = mux[mux.indexOf('-filter_complex') + 1];
      assert.match(fc, /\[1:a\]atrim=start=2:duration=2\.5,.*volume=0\.8,afade=t=out:st=1\.5:d=1,adelay=500:all=1\[a0\]/);
      assert.match(fc, /amix=inputs=1:normalize=0.*atrim=duration=3\[aout\]/);
      assert.deepEqual(mux.filter((x, i) => mux[i - 1] === '-i'), ['p.mp4', 'm.mp3'], 'clips after the end are not inputs');
      assert.ok(mux.join(' ').includes('-map 0:v -map [aout] -c:v copy -c:a aac') && mux.at(-1) === 'o.mp4' && mux[mux.indexOf('-t') + 1] === '3');
      assert.equal(buildMuxArgs({ video: 'p.mp4', out: 'o.mp4', format: 'mp4', duration: 3, audio: [] }), null, 'no clips, no second pass');
      assert.equal(buildMuxArgs({ video: 'p.gif', out: 'o.gif', format: 'gif', duration: 3, audio: [{ file: 'm.mp3', at: 0 }] }), null, 'a GIF has no sound');
      const rawArgs = buildFramesArgs({ fps: 30, w: 1280, h: 720, frames: 90, out: 'o.mp4', format: 'mp4', encoder: 'libx264', raw: true });
      assert.deepEqual(rawArgs.slice(rawArgs.indexOf('rawvideo') - 1, rawArgs.indexOf('rawvideo') + 9), ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1280x720', '-framerate', '30', '-i', 'pipe:0']);
      assert.ok(a.at(-1) === 'o.mp4' && a[a.indexOf('-t') + 1] === '3');
      const gif = buildFramesArgs({ fps: 30, w: 1920, h: 1080, frames: 60, out: 'o.gif', format: 'gif', encoder: 'gif' });
      assert.match(gif.join(' '), /fps=15,scale=960:-2.*palettegen.*paletteuse/);
      assert.throws(() => buildFramesArgs({ fps: 0, w: 1, h: 1, frames: 1, out: 'x', format: 'mp4', encoder: 'libx264' }));
      assert.equal(audioMix([{ file: 'm.mp3', at: 9 }], 1, 3), null, 'a clip after the end is left out');
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('IEND'), Buffer.from([0xae, 0x42, 0x60, 0x82])]);
      assert.equal(countPngs(Buffer.concat([png, png, png])), 3);
      assert.equal(countPngs(png.subarray(0, 8)), 0);
    }

    // Plain video edits: what stays, the colour look, the ffmpeg graph
    assert.deepEqual(keepRanges(10, null, []), [[0, 10]]);
    assert.deepEqual(keepRanges(10, [1, 9], [[3, 4]]), [[1, 3], [4, 9]]);
    assert.deepEqual(keepRanges(10, null, [[4, 3], [8, 12]]), [[0, 3], [4, 8]], 'cuts are sorted per pair and clamped');
    assert.deepEqual(keepRanges(10, [0, 10], [[0, 10]]), []);
    assert.deepEqual(keepRanges(10, null, [[5, 5.0005]]), [[0, 10]], 'a zero-length cut is ignored');
    assert.deepEqual(keepRanges(10, ['x', null], 'nope'), [[0, 10]]);
    assert.deepEqual(lookMatrix({}), { M: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], k: 1, o: 0 });
    assert.equal(lookFilter({}), '');
    assert.equal(lookFilter({ brightness: 0.5 }), "lutrgb=r='clip(val*1+25.5,0,255)':g='clip(val*1+25.5,0,255)':b='clip(val*1+25.5,0,255)'");
    assert.match(lookFilter({ saturation: -1 }), /^colorchannelmixer=rr=0\.213:rg=0\.715:rb=0\.072:gr=0\.213/);
    assert.equal(normLook({ contrast: 9, warmth: 'x' }).contrast, 1);
    const ed = { video: 'in.mp4', hasVideoAudio: true, W: 1280, H: 720, fps: 30, D: 10, look: { contrast: 0.2 }, encoder: 'libx264', out: 'o.mp4' };
    let ea = buildEditArgs({ ...ed, keep: [[1, 3], [4, 9]], layers: [{ kind: 'blur', t: [0, 5], box: [10, 20, 100, 50], sigma: 18 }, { kind: 'png', t: [2, 6], file: 'l.png', fade: true }], music: 'm.mp3', musicOffset: 1, musicFade: 2 });
    let efc = ea[ea.indexOf('-filter_complex') + 1];
    assert.ok(ea.every((a) => typeof a === 'string'));
    assert.match(efc, /^\[0:v\]lutrgb=/);
    assert.match(efc, /crop=100:50:10:20,gblur=sigma=18/);
    assert.match(efc, /overlay=10:20:enable='between\(t,0,5\)'/);
    assert.match(efc, /\[1:v\]scale=1280:720,format=rgba,fade=t=in:st=2:d=0\.4:alpha=1,fade=t=out:st=5\.6:d=0\.4:alpha=1/);
    assert.match(efc, /split=2\[s0\]\[s1\]/);
    assert.match(efc, /\[s1\]trim=start=4:end=9,setpts=PTS-STARTPTS\[t1\]/);
    assert.match(efc, /\[t0\]\[u0\]\[t1\]\[u1\]concat=n=2:v=1:a=1\[vc\]\[va\]/);
    assert.match(efc, /\[2:a:0\][^;]*adelay=1000:all=1[^;]*afade=t=out:st=5:d=2\[a1\]/, 'music on the edited clock (7 s long)');
    assert.match(efc, /amix=inputs=2/);
    assert.equal(ea[ea.indexOf('-t', ea.indexOf('-filter_complex')) + 1], '7');
    assert.deepEqual(ea.slice(ea.indexOf('-loop'), ea.indexOf('-loop') + 8), ['-loop', '1', '-framerate', '30', '-t', '10', '-i', 'l.png']);
    assert.ok(ea.includes('libx264') && ea.includes('bt709'));
    ea = buildEditArgs({ ...ed, hasVideoAudio: false, look: null, keep: [[0, 10]] });
    efc = ea[ea.indexOf('-filter_complex') + 1];
    assert.equal(efc, '[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vf]', 'nothing to do but convert');
    assert.ok(ea.includes('-an'));
    ea = buildEditArgs({ ...ed, look: null, keep: [[2, 8]] });
    efc = ea[ea.indexOf('-filter_complex') + 1];
    assert.match(efc, /^\[0:v\]trim=start=2:end=8,setpts=PTS-STARTPTS\[v1\];\[0:a\]atrim=start=2:end=8/);
    assert.throws(() => buildEditArgs({ ...ed, keep: [] }));
    const filtersOut = EDIT_FILTERS.map((f) => ` TSC ${f}            V->V       x`).join('\n');
    assert.equal(pickEditEncoder(filtersOut, ' V....D libx264              H.264\n V....D mpeg4    MPEG-4'), 'libx264');
    assert.equal(pickEditEncoder(filtersOut, ' V....D mpeg4                MPEG-4'), 'mpeg4');
    assert.equal(pickEditEncoder(' ... overlay  VV->V x', ' V....D libx264  H.264'), null, 'a trimmed ffmpeg cannot edit');

    // Cutdowns: the crop path, the whole-frame fill, output merging and the shared reel module
    assert.equal(keyExpr([]), '0');
    assert.equal(keyExpr([{ t: 0, v: 10 }]), '10');
    const kx = keyExpr([{ t: 1, v: 0 }, { t: 3, v: 100 }, { t: 5, v: 100 }]);
    const evalAt = (expr, t) => Function('t', 'lt', 'if_', 'return ' + expr.replace(/\bif\(/g, 'if_('))(t, (a, b) => (a < b ? 1 : 0), (c, a, b) => (c ? a : b));
    assert.equal(evalAt(kx, 0), 0, 'held before the first key');
    assert.equal(evalAt(kx, 2), 50, 'halfway between keys');
    assert.equal(evalAt(kx, 4), 100);
    assert.equal(evalAt(kx, 9), 100, 'held after the last key');
    assert.deepEqual(cropSize(1280, 720, 1080, 1920), { cw: 404, ch: 720 });
    assert.deepEqual(cropSize(1280, 720, 1080, 1080, 2), { cw: 360, ch: 360 });
    let rs = reframeSpec(1280, 720, { w: 1080, h: 1920, mode: 'crop', keys: [{ t: 0, cx: 0, cy: 50 }, { t: 2, cx: 100, cy: 50 }] });
    assert.equal(rs.cw, 404);
    assert.equal(evalAt(rs.x, 0), 0, 'kept inside the left edge');
    assert.equal(evalAt(rs.x, 2), 1280 - 404, 'kept inside the right edge');
    assert.equal(rs.y, '0');
    rs = reframeSpec(1280, 720, { w: 1080, h: 1920, mode: 'blurpad' });
    assert.deepEqual([rs.fw, rs.fh], [1080, 608]);
    const rea = buildEditArgs({ ...ed, look: null, keep: [[0, 10]], reframe: reframeSpec(1920, 1080, { w: 1080, h: 1080, keys: [] }) });
    assert.match(rea[rea.indexOf('-filter_complex') + 1], /^\[0:v\]crop=w=1080:h=1080:x='420':y='0',scale=1080:1080,setsar=1\[v1\];\[v1\]scale=out_color_matrix/);
    const rpa = buildEditArgs({ ...ed, look: null, keep: [[0, 10]], reframe: rs });
    assert.match(rpa[rpa.indexOf('-filter_complex') + 1], /split\[v1\]\[v2\].*overlay=0:656,setsar=1\[v5\]/);
    assert.deepEqual(
      mergeOutputs([{ id: 'vertical', src: 'v.mp4' }], [{ id: 'vertical', src: 'outputs/vertical.mp4' }, { id: 'square' }]).map((o) => [o.id, o.by]),
      [['vertical', 'reel'], ['square', 'player']],
      "Claude's output wins an id clash",
    );
    const mreel = normalizeReel({ w: 1280, h: 720, duration: 12, scenes: [{ id: 'a', t: [0, 4], els: [{ id: 'x', box: [10, 20, 20, 20] }] }, { id: 'b', t: [4, 12], els: [{ id: 'y', box: [60, 40, 10, 10] }] }], outputs: [{ id: 'bump', ranges: [[0, 2], [10, 12]] }, { id: 'vert', w: 1080, h: 1920 }] });
    assert.deepEqual(mreel.outputs.map((o) => [o.id, o.kind, o.label, o.duration]), [['bump', 'bumper', '4 s', 4], ['vert', 'reframe', '9:16', 12]]);
    const bview = resolveOutput(mreel, 'bump');
    assert.ok(bview.derived);
    assert.deepEqual(bview.scenes.map((x) => [x.id, x.t]), [['a', [0, 2]], ['b', [2, 4]]]);
    assert.equal(outTime(mreel.outputs[0], 11), 3);
    assert.equal(masterTime(mreel.outputs[0], 3), 11);
    assert.equal(outTime(mreel.outputs[0], 5), 2, 'a time the bumper skips goes to its next range');
    assert.equal(resolveOutput(mreel, 'nope').derived, false);
    const ar = autoReframe(mreel, 1080, 1920);
    assert.equal(ar.mode, 'crop');
    assert.deepEqual([ar.keys[0].cx, ar.keys[0].cy], [20, 30]);
    assert.deepEqual(autoRanges(mreel, 6).length, 2);
    const pc = planCutdown({ w: 1280, h: 720, duration: 12, scenes: [] }, { id: 'square' }, null);
    assert.deepEqual([pc.kind, pc.w, pc.h, pc.src, pc.audio.music], ['reframe', 1080, 1080, 'outputs/square.mp4', null]);
    assert.throws(() => planCutdown({ w: 1920, h: 1080, duration: 5, scenes: [] }, { id: 'landscape' }, null), /already 16:9/);
    assert.throws(() => planCutdown({ w: 1920, h: 1080, duration: 5, scenes: [] }, { id: '../x' }, null), /Unknown cutdown/);

    assert.equal(progressFromText('Rendered 10/200, encoded 50/200'), 25);
    assert.equal(progressFromText('nothing here'), null);
    assert.equal(slug('acme/launch v2'), 'acme-launch-v2');
    assert.match(stamp(new Date(2026, 0, 2, 3, 4, 5)), /^20260102-030405$/);

    // Mix arguments
    const common = { video: 'v.mp4', music: 'm.mp3', out: 'o.mp4', duration: 12, hasVideoAudio: true, musicVol: 0.6, sfxVol: 0.8 };
    let args = buildMixArgs({ ...common, musicOffset: 2, musicFade: 4 });
    let fc = args[args.indexOf('-filter_complex') + 1];
    assert.ok(args.every((a) => typeof a === 'string'));
    assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy']);
    assert.ok(args.includes('192k') && args.includes('aac'));
    assert.equal(args[args.indexOf('-t') + 1], '12');
    assert.equal(args.at(-1), 'o.mp4');
    assert.match(fc, /\[0:a:0\][^;]*volume=0\.8/);
    assert.match(fc, /\[1:a:0\][^;]*adelay=2000:all=1/);
    assert.match(fc, /volume=0\.6/);
    assert.match(fc, /afade=t=out:st=8:d=4/);
    assert.match(fc, /amix=inputs=2/);
    assert.equal(args[args.indexOf('-map', args.indexOf('-filter_complex')) + 1], '[aout]');
    args = buildMixArgs({ ...common, musicOffset: -1.5, musicFade: 0 });
    fc = args[args.indexOf('-filter_complex') + 1];
    assert.match(fc, /atrim=start=1\.5,asetpts=PTS-STARTPTS/);
    assert.doesNotMatch(fc, /adelay|afade/);
    args = buildMixArgs({ ...common, hasVideoAudio: false, musicOffset: 0, musicFade: 30 });
    fc = args[args.indexOf('-filter_complex') + 1];
    assert.doesNotMatch(fc, /\[0:a|amix/);
    assert.match(fc, /afade=t=out:st=0:d=12/); // fade is capped at the video length
    assert.ok(args.includes('[mus]'));
    args = buildMixArgs({ ...common, music: null, musicOffset: 0 });
    assert.ok(args.includes('[sfx]') && !args.includes('m.mp3'));
    args = buildMixArgs({ ...common, music: null, hasVideoAudio: false });
    assert.ok(args.includes('-an') && !args.includes('-filter_complex'));
    assert.throws(() => buildMixArgs({ ...common, duration: 0 }));

    // Plain videos: which file, and its version
    const pv = mkTmp();
    assert.equal(pickVideo(pv), null);
    fs.writeFileSync(path.join(pv, 'old.mp4'), 'a');
    fs.writeFileSync(path.join(pv, '.hidden.mp4'), 'a');
    fs.writeFileSync(path.join(pv, 'notes.txt'), 'a');
    fs.writeFileSync(path.join(pv, 'new.MOV'), 'a');
    fs.utimesSync(path.join(pv, 'old.mp4'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    assert.equal(pickVideo(pv), 'new.MOV', 'the newest playable file, no dotfiles');
    const T = 1_800_000_000_000;
    const st = (size, ago) => ({ size, mtimeMs: T - ago });
    assert.equal(videoVersion(pv, 'clip.mp4', st(10, 60000), T), 1);
    assert.equal(videoVersion(pv, 'clip.mp4', st(10, 60000), T), 1, 'same file, same version');
    assert.equal(videoVersion(pv, 'clip.mp4', st(12, 50000), T), 2, 'the file changed');
    assert.equal(videoVersion(pv, 'clip.mp4', st(14, 500), T), 2, 'still being written: wait');
    assert.equal(videoVersion(pv, 'clip.mp4', st(14, 40000), T), 3);
    fs.mkdirSync(path.join(pv, '.motionsnip', 'takes'), { recursive: true });
    assert.equal(videoVersion(pv, 'other.mp4', st(10, 60000), T), 1, 'another video starts again');
    assert.ok(!fs.existsSync(path.join(pv, '.motionsnip', 'takes')), "and the old video's takes go");

    // End to end against a temp project
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'logo.svg'), '<svg/>');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const video = Buffer.alloc(5000, 7);
    fs.writeFileSync(path.join(dir, 'video.mp4'), video);
    fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({ id: 'test', title: 'Test', version: 1, src: 'video.mp4', duration: 1 }));
    const srv = await startServer({ dir, port: 0, open: false, quiet: true, ffmpeg: path.join(dir, 'no-ffmpeg-here') });
    const port = srv.port;
    const origin = `http://localhost:${port}`;
    const req = (method, p, opts) => request(port, method, p, opts);
    try {
      const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
      const post = { origin };

      let r = await req('GET', '/api/reel');
      assert.equal(r.status, 200);
      assert.equal(r.json.id, 'test');
      assert.equal(r.json.path, dir);

      r = await req('GET', '/api/reel', { headers: { host: `evil.example:${port}` } });
      assert.equal(r.status, 403, 'bad host');

      r = await req('POST', '/api/upload?name=song.mp3', { body: mp3, headers: post });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { id: 'assets/song.mp3', name: 'song.mp3', type: 'audio' });
      assert.ok(fs.readFileSync(path.join(dir, 'assets', 'song.mp3')).equals(mp3));
      r = await req('POST', '/api/upload?name=song.mp3', { body: mp3, headers: post });
      assert.equal(r.json.name, 'song-2.mp3', 'never overwrite');
      r = await req('POST', '/api/upload?name=' + encodeURIComponent('../../escape.mp3'), { body: mp3, headers: post });
      assert.equal(r.json.id, 'assets/escape.mp3');
      assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.mp3')));
      r = await req('POST', '/api/upload?name=fake.wav', { body: mp3, headers: post });
      assert.equal(r.status, 415, 'magic bytes must match');
      r = await req('POST', '/api/upload?name=x.exe', { body: mp3, headers: post });
      assert.equal(r.status, 400);
      r = await req('POST', '/api/upload?name=a.mp3', { body: mp3, headers: { origin: 'http://evil.example' } });
      assert.equal(r.status, 403, 'bad origin');
      r = await req('POST', '/api/upload?name=a.mp3', { body: mp3 });
      assert.equal(r.status, 403, 'missing origin');
      assert.deepEqual(fs.readdirSync(path.join(dir, 'assets')).sort(), ['escape.mp3', 'song-2.mp3', 'song.mp3']);

      // Files and ranges
      r = await req('GET', '/p/video.mp4', { headers: { range: 'bytes=100-199' } });
      assert.equal(r.status, 206);
      assert.equal(r.headers['content-range'], 'bytes 100-199/5000');
      assert.equal(r.buf.length, 100);
      assert.equal(r.headers['cache-control'], 'no-store');
      r = await req('GET', '/p/video.mp4', { headers: { range: 'bytes=9000-' } });
      assert.equal(r.status, 416);
      r = await req('GET', '/p/video.mp4');
      assert.equal(r.status, 200);
      assert.equal(r.buf.length, 5000);
      assert.equal(r.headers['content-type'], 'video/mp4');
      r = await req('GET', '/p/logo.svg');
      assert.equal(r.status, 200, 'public/ fallback');
      assert.equal(r.headers['content-type'], 'image/svg+xml');
      r = await req('GET', '/p/../reel.json');
      assert.equal(r.status, 404, 'URL parsing drops the .. so this never leaves /p');
      r = await req('GET', '/p/a%2f..%2f..%2f..%2fetc%2fpasswd');
      assert.equal(r.status, 403);
      r = await req('GET', '/p/..%5c..%5cx');
      assert.ok([403, 404].includes(r.status));
      r = await req('GET', '/p/.env');
      assert.equal(r.status, 403, 'dotfiles stay private');
      r = await req('GET', '/p/missing.mp4');
      assert.equal(r.status, 404);
      r = await req('GET', '/app/brand/favicon.svg');
      assert.equal(r.status, isFile(path.join(BRAND_DIR, 'favicon.svg')) ? 200 : 404);
      r = await req('GET', '/app/..%2fserver.mjs');
      assert.equal(r.status, 403);
      r = await req('GET', '/app/brand/..%2f..%2fSPEC.md');
      assert.equal(r.status, 403);

      // State and feedback
      r = await req('GET', '/api/state');
      assert.deepEqual(r.json, {});
      r = await req('POST', '/api/state', { body: JSON.stringify({ edits: [1] }), headers: post });
      assert.equal(r.status, 200);
      r = await req('GET', '/api/state');
      assert.deepEqual(r.json, { edits: [1] });
      r = await req('POST', '/api/state', { body: 'x'.repeat(JSON_LIMIT + 10), headers: post });
      assert.equal(r.status, 413);
      r = await req('POST', '/api/state', { body: '{bad', headers: post });
      assert.equal(r.status, 400);
      r = await req('POST', '/api/feedback', { body: JSON.stringify({ version: 1, markdown: '# hi' }), headers: post });
      assert.equal(r.status, 200);
      assert.equal(r.json.path, path.join(dir, '.motionsnip', 'feedback-v1.md'));
      assert.equal(fs.readFileSync(r.json.path, 'utf8'), '# hi\n');

      // Takes: a copy per version, newest first
      r = await req('GET', '/api/takes');
      assert.deepEqual(r.json, [{ version: 1, src: '.motionsnip/takes/v1.mp4', url: '/p/.motionsnip/takes/v1.mp4' }]);
      for (let v = 2; v <= 8; v++) {
        fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({ id: 'test', version: v, src: 'video.mp4', duration: 1 }));
        await req('GET', '/api/takes');
      }
      r = await req('GET', '/api/takes');
      assert.deepEqual(r.json.map((t) => t.version), [8, 7, 6, 5, 4, 3]);
      r = await req('GET', '/p/.motionsnip/takes/v8.mp4', { headers: { range: 'bytes=0-9' } });
      assert.equal(r.status, 206);

      // Export without ffmpeg, reveal checks, broken reel.json
      r = await req('GET', '/api/ffmpeg');
      assert.deepEqual(r.json, { ok: false, path: null, edits: false });
      r = await req('POST', '/api/export', { body: JSON.stringify({ mode: 'mix' }), headers: post });
      assert.equal(r.json.state, 'error');
      assert.match(r.json.line, /ffmpeg not found/);
      r = await req('POST', '/api/export', { body: JSON.stringify({ mode: 'render' }), headers: post });
      assert.equal(r.status, 400, 'no export.cmd');
      r = await req('POST', '/api/reveal', { body: JSON.stringify({ path: '../../etc/passwd' }), headers: post });
      assert.equal(r.status, 403);
      fs.writeFileSync(path.join(dir, 'reel.json'), '{ broken');
      r = await req('GET', '/api/reel');
      assert.equal(r.status, 500);
      assert.match(r.json.error, /not valid JSON/);
    } finally {
      await srv.close();
    }

    // A plain video: no reel.json, just a video file
    const plain = mkTmp();
    fs.writeFileSync(path.join(plain, 'My Clip.mp4'), Buffer.alloc(3000, 3));
    const ps = await startServer({ dir: plain, port: 0, open: false, quiet: true, ffmpeg: path.join(plain, 'no-ffmpeg-here') });
    try {
      const preq = (method, p, opts = {}) => request(ps.port, method, p, opts);
      const post = { origin: `http://localhost:${ps.port}` };
      let r = await preq('GET', '/api/reel');
      assert.equal(r.status, 200);
      assert.equal(r.json.plain, true);
      assert.equal(r.json.src, 'My Clip.mp4');
      assert.equal(r.json.title, 'My Clip.mp4');
      assert.equal(r.json.version, 1);
      assert.match(r.json.id, /^My-Clip-[0-9a-f]{6}$/);
      assert.deepEqual(r.json.scenes, []);
      assert.equal(r.json.duration, undefined, 'no ffmpeg: the player reads the length from the video');
      r = await preq('GET', '/p/My%20Clip.mp4', { headers: { range: 'bytes=0-9' } });
      assert.equal(r.status, 206);
      const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG'), Buffer.alloc(60, 1)]);
      r = await preq('POST', '/api/upload?name=Logo.png', { body: png, headers: post });
      assert.deepEqual(r.json, { id: 'assets/Logo.png', name: 'Logo.png', type: 'image' });
      r = await preq('POST', '/api/upload?name=fake.jpg', { body: png, headers: post });
      assert.equal(r.status, 415, 'image magic bytes must match');
      r = await preq('POST', '/api/export', { body: JSON.stringify({ mode: 'edit', edit: { cuts: [[1, 2]] } }), headers: post });
      assert.equal(r.json.state, 'error');
      assert.match(r.json.line, /ffmpeg not found/);
      fs.writeFileSync(path.join(plain, 'reel.json'), JSON.stringify({ id: 'made', version: 4, src: 'My Clip.mp4' }));
      r = await preq('GET', '/api/reel');
      assert.equal(r.json.id, 'made', 'a reel.json wins over the plain video');
      assert.equal(r.json.plain, undefined);
    } finally {
      await ps.close();
    }
    // "Open in timeline": a plain video and its edits become timeline.json
    {
      const { timelineFromPlain, keptRanges } = await import('./app/comp/fromplain.mjs');
      assert.deepEqual(keptRanges(10, [1, 9], [[3, 4]]), [[1, 3], [4, 9]]);
      const edit = {
        trim: [1, 9],
        cuts: [[3, 4]],
        look: { brightness: 0, contrast: 0.2, saturation: 0, warmth: 0 },
        layers: [
          { id: 'w', kind: 'text', t: [2, 6], box: [10, 40, 80, 0], text: 'Hi', font: 'mono', size: 6, color: '#ff0000', bold: true, align: 'left', bg: true, bgColor: '#000000', bgOpacity: 0.5, shadow: false, fade: true },
          { id: 'b', kind: 'blur', t: [0, 2], box: [5, 5, 20, 10], amount: 2 },
          { id: 'l', kind: 'image', t: [0, 10], box: [80, 5, 10, 0], src: 'assets/Logo.png', opacity: 0.5, fade: false },
        ],
      };
      const tl = timelineFromPlain({ src: 'A.mp4', title: 'A.mp4', w: 1280, h: 720, fps: 30, duration: 10 }, edit, { w: 9 });
      assert.equal(tl.from, 'A.mp4');
      assert.deepEqual(tl.size, [1280, 720]);
      assert.deepEqual(tl.tracks[0].clips.map((c) => [c.at, c.in, c.out]), [[0, 1, 3], [2, 4, 9]], 'cuts become clips back to back');
      assert.deepEqual(tl.tracks[0].clips[0].look, { contrast: 0.2 });
      const g = tl.tracks[1].clips;
      assert.deepEqual(g.find((c) => c.id === 'b'), { id: 'b', at: 0, dur: 1, type: 'blur', box: [5, 5, 20, 10], amount: 4 }, 'trimmed away before 1 s');
      const words = g.filter((c) => c.type === 'text');
      assert.deepEqual(words.map((c) => [c.id, c.at, c.dur]), [['w-1', 1, 1], ['w-2', 2, 2]], 'a layer across a cut is split');
      assert.ok(words[0].enter && !words[0].exit && words[1].exit && !words[1].enter, 'fades at the outer ends only');
      assert.deepEqual(words[0].box, [10, 40, 80, 9]);
      assert.deepEqual(words[0].style, { font: 'DM Mono', size: 6, weight: 700, color: '#ff0000', bg: '#00000080', align: 'left', shadow: false });
      const logos = g.filter((c) => c.type === 'image');
      assert.deepEqual(logos.map((c) => c.dur), [2, 5], 'the logo covers every kept part');
      assert.ok(logos[0].keys.opacity[0][1] === 0.5 && logos[0].box[3] > 17 && logos[0].box[3] < 18, 'its opacity, and a square box by default');
      const norm = (await import('./app/comp/timeline.mjs')).normTimeline(JSON.parse(JSON.stringify(tl)), { scenes: {} });
      assert.equal(norm.duration, 7);
      assert.equal(norm.issues.length, 0, JSON.stringify(norm.issues));
      assert.throws(() => timelineFromPlain({ src: 'A.mp4', duration: 10 }, { trim: [5, 5] }), /Nothing is left/);

      const two = mkTmp();
      fs.writeFileSync(path.join(two, 'A.mp4'), Buffer.alloc(3000, 3));
      fs.writeFileSync(path.join(two, 'B.mp4'), Buffer.alloc(3000, 4));
      const none = path.join(two, 'no-ffmpeg-here');
      const sa = await startServer({ dir: two, video: 'A.mp4', port: 0, open: false, quiet: true, ffmpeg: none });
      try {
        const post = { origin: `http://localhost:${sa.port}` };
        const open = (content) => request(sa.port, 'POST', '/api/timeline-open', { body: JSON.stringify({ content }), headers: post });
        let r = await open({ ...tl, from: 'B.mp4' });
        assert.equal(r.status, 400, 'made from another video');
        r = await open(tl);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        r = await request(sa.port, 'GET', '/api/reel');
        assert.ok(!r.json.plain && r.json.timeline, 'the video now opens as its timeline');
        const before = fs.readFileSync(path.join(two, 'timeline.json'), 'utf8');
        r = await open({ ...tl, title: 'Again' });
        assert.ok(r.status >= 400 && fs.readFileSync(path.join(two, 'timeline.json'), 'utf8') === before, 'never overwrites a timeline.json');
      } finally {
        await sa.close();
      }
      const sb = await startServer({ dir: two, video: 'B.mp4', port: 0, open: false, quiet: true, ffmpeg: none });
      try {
        const r = await request(sb.port, 'GET', '/api/reel');
        assert.equal(r.json.plain, true, 'another video in the folder still plays plain');
      } finally {
        await sb.close();
      }
    }
    // A scene project: scene.json, no reel.json. The reel is built from the scene; the player draws it live.
    {
      const sc = await import('./app/scene/compile.mjs');
      const dr = await import('./app/scene/draw.mjs');
      const raw = {
        title: 'T',
        version: 3,
        cast: { ana: { kind: 'person' }, bot: { kind: 'robot' } },
        props: { sign: { kind: 'x', kit: 'sign', text: 'Hi' }, chart: { kit: 'chart', data: [1, 2] } },
        shots: [
          { id: 'a', dur: 3, place: { ana: [600, 885], sign: [1200, 885] }, beats: [{ at: 0.2, who: 'ana', do: 'walk', to: [900, 885] }, { at: 1, who: 'ana', do: 'say', dur: 1.5, text: 'This line has far too many words to read in the little time it has on screen here' }] },
          { id: 'b', dur: 2, in: 'fade', place: { chart: [960, 820] }, beats: [{ at: 0.1, do: 'draw-on', what: 'chart' }, { at: 0.2, who: 'ghost', do: 'wave' }] },
        ],
      };
      const spec = sc.normScene(raw);
      assert.equal(spec.duration, 5);
      assert.deepEqual(spec.size, [1920, 1080]);
      assert.equal(spec.style.preset, 'ink');
      const reel = sc.toReel(raw);
      assert.equal(reel.scene, true);
      assert.deepEqual(reel.live, { type: 'scene', spec: 'scene.json' });
      assert.deepEqual(reel.scenes.map((x) => x.id), ['a', 'b']);
      const ana = reel.scenes[0].els.find((e) => e.id === 'ana@a');
      assert.ok(ana && ana.box.every(Number.isFinite), 'every thing on stage gets a box');
      assert.equal(ana.props.shirt.path, 'cast.ana.look.shirt');
      const line = reel.scenes[0].els.find((e) => e.id.startsWith('line'));
      assert.equal(line.props.text.path, 'shots[0].beats[1].text');
      assert.ok(reel.review.some((f) => f.title === 'Too fast to read' && f.elId === line.id), 'a line too fast to read is flagged');
      assert.ok(reel.review.some((f) => /ghost/.test(JSON.stringify(f))), 'a beat for someone not in the cast is flagged');
      const patched = sc.applyPatches(raw, [{ path: 'props.chart.data', value: '4, 5, 6' }, { path: 'cast.ana.look.shirt', value: '#00ff00' }]);
      assert.deepEqual(patched.props.chart.data, [4, 5, 6]);
      assert.equal(raw.props.chart.data.length, 2, 'patches work on a copy');
      assert.throws(() => sc.applyPatches(raw, [{ path: 'shots[0].dur', value: 99 }]), /Can't change/);
      assert.throws(() => sc.applyPatches(raw, [{ path: '__proto__.x', value: 1 }]), /Can't change/);
      const f1 = dr.frameSVG(spec, 1.3);
      assert.equal(f1, dr.frameSVG(sc.normScene(raw), 1.3), 'the same time draws the same frame');
      assert.ok(f1.startsWith('<svg') && f1.includes('data-id="ana"'));
      assert.notEqual(f1, dr.frameSVG(spec, 1.6), 'time moves things');
      assert.ok(dr.frameSVG(spec, 3.2).includes('opacity'), 'a fade draws both shots');

      const dir = mkTmp();
      fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(raw));
      const ss = await startServer({ dir, port: 0, open: false, quiet: true });
      try {
        let r = await request(ss.port, 'GET', '/api/reel');
        assert.equal(r.status, 200);
        assert.equal(r.json.scene, true);
        assert.equal(r.json.version, 3);
        assert.equal(r.json.src, '', 'no export yet');
        assert.equal(r.json.path, dir);
        fs.writeFileSync(path.join(dir, 'scene.json'), '{ nope');
        r = await request(ss.port, 'GET', '/api/reel');
        assert.equal(r.status, 500);
        assert.match(r.json.error, /scene.json is not valid JSON/);
      } finally {
        await ss.close();
      }
    }

    const empty = await startServer({ dir: mkTmp(), port: 0, open: false, quiet: true });
    try {
      const r = await request(empty.port, 'GET', '/api/reel');
      assert.equal(r.status, 404);
      assert.match(r.json.error, /No reel\.json or video file/);
    } finally {
      await empty.close();
    }

    // A timeline project: timeline.json, no reel.json. Pure model, edit ops, then the reel and Apply over HTTP.
    {
      const T = await import('./app/comp/timeline.mjs');
      const O = await import('./app/comp/ops.mjs');
      const sceneRaw = { title: 'S', version: 1, size: [1920, 1080], fps: 30, cast: { ana: { kind: 'person', name: 'Ana' } }, props: {}, shots: [{ id: 'one', dur: 2, place: { ana: [900, 885] } }, { id: 'two', dur: 3, place: { ana: [900, 885] } }] };
      const raw = {
        title: 'Launch',
        version: 1,
        tracks: [
          { kind: 'video', clips: [{ src: 'a.mp4', at: 0, in: 2, out: 6, enter: { kind: 'fade', dur: 0.5 } }, { src: 'b.mp4', at: 3.8, out: 3, enter: 'fade' }] },
          { kind: 'scene', clips: [{ scene: 'scene.json', shots: ['two'], at: 7 }] },
          { kind: 'graphics', clips: [{ type: 'text', text: 'Ship faster', at: 1, dur: 3, keys: { opacity: [[0, 0], [1, 1, 'out']], x: 5 } }] },
          { kind: 'audio', clips: [{ src: 'm.mp3', at: 0, out: 20, fadeOut: 2 }] },
          { kind: 'captions', clips: [{ at: 1, dur: 1, text: 'far too many words to read in one second' }] },
          { kind: 'nonsense' },
        ],
      };
      const scenes = { 'scene.json': sceneRaw };
      const tl = T.normTimeline(raw, { scenes });
      assert.deepEqual(tl.tracks.map((t) => t.id), ['v1', 's1', 'g1', 'a1', 'cc1']);
      assert.deepEqual(tl.tracks[0].clips.map((c) => [c.id, c.at, c.dur]), [['c1', 0, 4], ['c2', 3.8, 3]]);
      assert.equal(tl.tracks[1].clips[0].dur, 3, 'a scene clip lasts as long as its shots');
      assert.equal(tl.duration, 20);
      assert.equal(T.sceneTime(tl, tl.tracks[1].clips[0], 1), 3, 'shot two starts 2 s into the scene');
      // keyframes and eases
      assert.equal(T.valueAt([[0, 0], [1, 10]], 0.5), 5);
      assert.equal(T.valueAt([[0, 0, 'hold'], [1, 10]], 0.99), 0);
      assert.ok(T.valueAt([[0, 0, 'out'], [1, 10]], 0.5) > 8);
      assert.equal(T.valueAt([[1, 3]], 0), 3);
      assert.deepEqual(T.normKeyList([[1, 2], ['x', 1], [0, 5, 'in'], [2, 1, 'wobble']]), [[0, 5, 'in'], [1, 2], [2, 1]]);
      const at4 = T.evalAt(tl, 3.9);
      assert.deepEqual(at4.layers.map((l) => l.clip.id), ['c1', 'c2', 'c4'], 'the incoming clip draws over the outgoing one');
      assert.ok(at4.layers[1].state.opacity > 0 && at4.layers[1].state.opacity < 1, 'mid fade');
      assert.ok(Math.abs(at4.layers[0].srcT - 5.9) < 1e-9);
      const at15 = T.evalAt(tl, 1.5);
      assert.equal(at15.layers.find((l) => l.clip.id === 'c4').state.x, 5);
      assert.ok(Math.abs(at15.audio.find((a) => a.clip.id === 'c5').gain - 1) < 1e-9);
      assert.ok(Math.abs(T.fadeGain(tl.tracks[3].clips[0], 19) - 0.5) < 1e-9);
      const solo = T.normTimeline({ ...raw, tracks: raw.tracks.map((t, i) => (i === 2 ? { ...t, solo: true } : t)) }, { scenes });
      assert.deepEqual(T.evalAt(solo, 1.5).layers.map((l) => l.clip.id), ['c4'], 'solo shows only the soloed track');
      // the reel and its checks
      const reel = T.toReel(raw, { scenes, exists: (p) => p !== 'b.mp4' });
      assert.deepEqual(reel.live, { type: 'timeline', spec: 'timeline.json' });
      assert.deepEqual(reel.scenes.map((x) => x.id), ['c1', 'c2', 'gap3', 'c3', 'end']);
      const els = reel.scenes.flatMap((x) => x.els);
      assert.equal(els.find((e) => e.id === 'c4').props.text.path, 'tracks[2].clips[0].text');
      const inScene = els.find((e) => e.id === 'c3/ana@two');
      assert.ok(inScene, 'a scene clip brings its own elements');
      assert.equal(inScene.props.shirt.file, 'scene.json');
      assert.deepEqual(inScene.t, [7, 10]);
      const titles = reel.review.map((x) => x.title);
      assert.ok(titles.some((x) => /unknown kind/.test(x)));
      assert.ok(titles.includes('b.mp4 is missing'));
      assert.ok(titles.includes('Too fast to read'));
      assert.ok(!titles.some((x) => /covers the end/.test(x)), 'an overlap inside the fade is fine');
      assert.ok(T.lint({ tracks: [{ kind: 'video', clips: [{ src: 'a.mp4', at: 0, out: 4 }, { src: 'b.mp4', at: 2, out: 4 }] }] }).some((x) => /covers the end/.test(x.title)));
      assert.ok(T.lint({ tracks: [{ kind: 'video', clips: [{ src: 'a.mp4' }] }] }).some((x) => /has no length/.test(x.title)));
      assert.equal(normalizeReel(reel).live.type, 'timeline');
      // patches: only element props
      assert.equal(T.applyPatches(raw, [{ path: 'tracks[2].clips[0].text', value: 'Hi' }], { scenes }).tracks[2].clips[0].text, 'Hi');
      assert.throws(() => T.applyPatches(raw, [{ path: 'tracks[0].clips[0].src', value: '/etc/passwd' }], { scenes }), /Can't change/);
      assert.throws(() => T.applyPatches(raw, [{ path: '__proto__.x', value: 1 }], { scenes }), /Can't change/);
      // ops: split, trim, slip, key, move, remove with ripple, tracks; the original is never changed
      const before = JSON.stringify(raw);
      let e = O.applyOps(raw, { op: 'split', clip: 'c1', t: 1.5 }, { scenes });
      assert.equal(JSON.stringify(raw), before, 'ops copy');
      let v = e.tracks[0].clips;
      assert.deepEqual(v.map((c) => [c.id, c.at, c.in, c.out]), [['c1', 0, 2, 3.5], ['c7', 1.5, 3.5, 6], ['c2', 3.8, undefined, 3]]);
      assert.ok(v[0].enter && !v[1].enter, 'the right half has no enter fade');
      e = O.applyOps(e, [{ op: 'trim', clip: 'c7', edge: 'start', t: 2 }, { op: 'trim', clip: 'c2', edge: 'end', t: 99 }], { scenes, srcDur: (src) => (src === 'b.mp4' ? 5 : 10) });
      v = e.tracks[0].clips;
      assert.deepEqual([v[1].at, v[1].in, v[1].out], [2, 4, 6]);
      assert.equal(v[2].out, 5, 'a trim stops at the end of the file');
      e = O.applyOps(e, { op: 'trim', clip: 'c1', edge: 'start', t: -5 }, { scenes });
      assert.deepEqual([e.tracks[0].clips[0].at, e.tracks[0].clips[0].in], [0, 2], 'no earlier than 0');
      e = O.applyOps(e, { op: 'slip', clip: 'c7', by: -10 }, { scenes });
      assert.deepEqual([e.tracks[0].clips[1].in, e.tracks[0].clips[1].out], [0, 2]);
      e = O.applyOps(e, [{ op: 'key', clip: 'c4', prop: 'scale', t: 0.5, value: 1.2, ease: 'inOut' }, { op: 'key', clip: 'c4', prop: 'opacity', t: 1, value: 0.5 }], { scenes });
      assert.deepEqual(e.tracks[2].clips[0].keys.scale, [[0.5, 1.2, 'inOut']]);
      assert.deepEqual(e.tracks[2].clips[0].keys.opacity, [[0, 0], [1, 0.5]], 'a key at the same time replaces it');
      e = O.applyOps(e, { op: 'trim', clip: 'c4', edge: 'start', t: 1.5 }, { scenes });
      assert.deepEqual(e.tracks[2].clips[0].keys.opacity, [[0, 0.25], [0.5, 0.5]], 'keys stay put on the timeline when the start moves');
      assert.deepEqual([e.tracks[2].clips[0].at, e.tracks[2].clips[0].dur], [1.5, 2.5]);
      e = O.applyOps(e, [{ op: 'remove', clip: 'c1', ripple: true }], { scenes });
      assert.deepEqual(e.tracks[0].clips.map((c) => [c.id, c.at]), [['c7', 0.5], ['c2', 2.3]]);
      assert.throws(() => O.applyOps(e, { op: 'move', clip: 'c4', track: 'v1', at: 0 }, { scenes }), /can't go on/);
      assert.throws(() => O.applyOps(e, { op: 'split', clip: 'c4', t: 0 }, { scenes }), /inside/);
      assert.throws(() => O.applyOps(e, { op: 'set', clip: 'c4', key: 'src', value: 1 }, { scenes }), /valid src/);
      assert.throws(() => O.applyOps(e, { op: 'set', clip: 'c2', key: 'text', value: 'x' }, { scenes }), /Can't set text/);
      assert.throws(() => O.applyOps(e, { op: 'nope' }), /Unknown edit/);
      e = O.applyOps(e, [{ op: 'setTrack', track: 'g1', key: 'lock', value: true }]);
      assert.throws(() => O.applyOps(e, { op: 'set', clip: 'c4', key: 'text', value: 'x' }), /locked/);
      e = O.applyOps(e, [{ op: 'addTrack', kind: 'graphics', index: 3 }, { op: 'add', track: 'g2', clip: { type: 'text', text: 'New' }, at: 2 }, { op: 'marker', name: 'Hook', t: [0, 3] }]);
      assert.deepEqual([e.tracks[3].id, e.tracks[3].clips[0].id, e.tracks[3].clips[0].at], ['g2', 'c1', 2], 'new ids are the smallest free ones');
      assert.deepEqual(T.normTimeline(e, { scenes }).markers.map((m) => m.name), ['Hook']);
      assert.deepEqual(O.ensureIds({ tracks: [{ kind: 'audio', clips: [{}, { id: 'c1' }] }] }).tracks[0].clips.map((c) => c.id), ['c2', 'c1']);

      // caption files: time order, hidden tracks left out, SubRip and WebVTT stamps
      const capTl = T.normTimeline({ tracks: [{ kind: 'captions', clips: [{ at: 3.5, dur: 1.25, text: 'Two' }, { at: 0.2, dur: 2, text: ' One ' }, { at: 9, dur: 1, text: '' }] }, { kind: 'captions', hide: true, clips: [{ at: 1, dur: 1, text: 'Hidden' }] }] });
      const cues = T.captionCues(capTl);
      assert.deepEqual(cues.map((c) => c.text), ['One', 'Two']);
      assert.equal(T.toSrt(cues), '1\n00:00:00,200 --> 00:00:02,200\nOne\n\n2\n00:00:03,500 --> 00:00:04,750\nTwo\n');
      assert.ok(T.toVtt(cues).startsWith('WEBVTT\n\n00:00:00.200 --> 00:00:02.200\nOne\n'));
      assert.equal(T.toSrt(T.captionCues(T.normTimeline({ tracks: [{ kind: 'captions', clips: [{ at: 3725.5, dur: 1, text: 'x' }] }] }))).split('\n')[1], '01:02:05,500 --> 01:02:06,500');

      // graphics: presets settle, a scene cut hides the scene's own transition, CSS matches the canvas transform
      const G = await import('./app/comp/graphics.mjs');
      const popEnd = G.presetAt({ preset: 'pop', dur: 3 }, 1, 1080);
      assert.ok(Math.abs(popEnd.scale - 1) < 1e-9 && popEnd.opacity === 1);
      assert.ok(G.presetAt({ preset: 'pop', dur: 3 }, 0.3, 1080).scale > 1, 'pop overshoots');
      assert.ok(G.presetAt({ preset: 'fade', dur: 3 }, 2.9, 1080).opacity < 1, 'presets fade out at the end');
      assert.equal(G.presetAt({ preset: 'word-stagger', dur: 3 }, 0, 1080).word(2).a, 0);
      assert.deepEqual(G.lookMatrix({}), { M: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], k: 1, o: 0 });
      const css = G.cssFor([0, 0, 960, 540], { x: 10, y: 0, scale: 1.5, rotate: 0, opacity: 0.5, reveal: 0.5 }, 1920, 1080);
      assert.equal(css.transform, 'translate(20%, 0%) rotate(0deg) scale(1.5)');
      assert.equal(css.clipPath, 'inset(0 50% 0 0)');
      const cutTl = T.normTimeline({ tracks: [{ kind: 'scene', clips: [{ scene: 'scene.json', shots: ['two'], at: 0 }, { scene: 'scene.json', at: 4 }] }] }, { scenes });
      assert.equal(T.evalAt(cutTl, 0.1).layers[0].sceneCut, true, 'the first shot of a clip is a cut');
      assert.equal(T.evalAt(cutTl, 6.1).layers[0].sceneCut, false, 'shot two after shot one plays the scene transition');

      // over HTTP
      const td = mkTmp();
      fs.writeFileSync(path.join(td, 'timeline.json'), JSON.stringify(raw));
      fs.writeFileSync(path.join(td, 'scene.json'), JSON.stringify(sceneRaw));
      fs.writeFileSync(path.join(td, 'a.mp4'), 'x');
      const tsrv = await startServer({ dir: td, port: 0, open: false, quiet: true, ffmpeg: path.join(td, 'no-ffmpeg-here') });
      try {
        const post = { origin: `http://localhost:${tsrv.port}` };
        const apply = (body) => request(tsrv.port, 'POST', '/api/project-apply', { body: JSON.stringify(body), headers: post });
        let r = await request(tsrv.port, 'GET', '/api/reel');
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.timeline, true);
        assert.equal(r.json.title, 'Launch');
        assert.ok(r.json.rev);
        assert.ok(r.json.review.some((x) => x.title === 'b.mp4 is missing') && !r.json.review.some((x) => x.title === 'a.mp4 is missing'));
        const rev0 = r.json.rev;
        r = await apply({ file: 'timeline.json', ops: [{ op: 'split', clip: 'c1', t: 1 }] });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.version, 1, 'an editor save keeps the version');
        const disk = JSON.parse(fs.readFileSync(path.join(td, 'timeline.json'), 'utf8'));
        assert.equal(disk.tracks[0].clips.length, 3);
        assert.equal(disk.tracks[0].clips[0].id, 'c1', 'ids are written into the file');
        r = await apply({ file: 'timeline.json', base: rev0, ops: [{ op: 'remove', clip: 'c1' }] });
        assert.equal(r.status, 409, 'an edit on an old copy is refused');
        assert.ok(r.json.rev);
        r = await request(tsrv.port, 'GET', '/api/reel');
        assert.notEqual(r.json.rev, rev0);
        r = await apply({ file: 'timeline.json', base: r.json.rev, bump: true, patches: [{ path: 'tracks[2].clips[0].text', value: 'Hello' }] });
        assert.equal(r.json.version, 2, 'Apply starts a new version: ' + JSON.stringify(r.json));
        r = await apply({ file: 'timeline.json', timeline: raw });
        assert.equal(r.status, 200, 'undo writes the earlier copy back');
        assert.equal(JSON.parse(fs.readFileSync(path.join(td, 'timeline.json'), 'utf8')).tracks[0].clips.length, 2);
        r = await apply({ file: 'timeline.json', ops: [{ op: 'split', clip: 'zzz', t: 1 }] });
        assert.equal(r.status, 400);
        assert.match(r.json.error, /no clip "zzz"/);
        r = await apply({ file: 'timeline.json', timeline: [1, 2] });
        assert.equal(r.status, 400);
        r = await apply({ file: 'scene.json', bump: true, patches: [{ path: 'cast.ana.look.shirt', value: '#00ff00' }] });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const sc2 = JSON.parse(fs.readFileSync(path.join(td, 'scene.json'), 'utf8'));
        assert.equal(sc2.cast.ana.look.shirt, '#00ff00');
        assert.equal(sc2.version, 2);
        r = await apply({ file: 'scene.json', ops: [{ op: 'split' }] });
        assert.equal(r.status, 400);
        for (const bad of ['../x.json', 'reel.json', '.motionsnip/state.json', 'a.mp4']) {
          r = await apply({ file: bad, patches: [] });
          assert.equal(r.status, 400, `can't edit ${bad}`);
        }
        r = await request(tsrv.port, 'POST', '/api/project-apply', { body: JSON.stringify({ file: 'timeline.json', ops: [] }) });
        assert.equal(r.status, 403, 'Apply needs the player origin');
        fs.writeFileSync(path.join(td, 'timeline.json'), '{ nope');
        r = await request(tsrv.port, 'GET', '/api/reel');
        assert.equal(r.status, 500);
        assert.match(r.json.error, /timeline.json is not valid JSON/);
      } finally {
        await tsrv.close();
      }
    }

    // With a real ffmpeg that can edit: export trim + cut + colour + blur + a layer, check the result
    const realFf = findFfmpeg(ROOT);
    const canEdit = realFf && (await editEncoder({}, realFf));
    if (canEdit) {
      const vd = mkTmp();
      const env = ffmpegEnv(realFf);
      const mk = await run(realFf.path, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', canEdit === 'libx264' ? 'libx264' : 'mpeg4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(vd, 'clip.mp4')], { env });
      assert.equal(mk.code, 0, 'make a test clip: ' + lastLine(mk.stderr));
      const pngFile = path.join(vd, 'layer.png');
      const mp = await run(realFf.path, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=white:s=320x180', '-frames:v', '1', pngFile], { env });
      assert.equal(mp.code, 0, 'make a test png');
      const es = await startServer({ dir: vd, port: 0, open: false, quiet: true, ffmpeg: realFf.path });
      try {
        const post = { origin: `http://localhost:${es.port}` };
        let r = await request(es.port, 'GET', '/api/reel');
        assert.equal(r.json.w, 320);
        assert.equal(r.json.h, 180);
        assert.equal(r.json.fps, 30);
        assert.ok(Math.abs(r.json.duration - 4) < 0.1);
        r = await request(es.port, 'GET', '/api/ffmpeg');
        assert.equal(r.json.edits, true);
        const edit = {
          trim: [0.5, 3.5],
          cuts: [[1.5, 2]],
          look: { saturation: -0.5, brightness: 0.1 },
          layers: [
            { kind: 'blur', t: [0, 4], box: [10, 10, 30, 30], amount: 3 },
            { kind: 'text', t: [1, 3], fade: true, png: 'data:image/png;base64,' + fs.readFileSync(pngFile).toString('base64') },
            { kind: 'text', t: [1, 3], png: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') },
          ],
        };
        r = await request(es.port, 'POST', '/api/export', { body: JSON.stringify({ mode: 'edit', edit, musicVol: 1, sfxVol: 0.5 }), headers: post });
        assert.equal(r.json.state, 'running');
        let job = r.json;
        for (let i = 0; i < 300 && job.state === 'running'; i++) {
          await new Promise((res) => setTimeout(res, 100));
          job = (await request(es.port, 'GET', '/api/export')).json;
        }
        assert.equal(job.state, 'done', 'edit export: ' + job.line);
        const outInfo = await probe(realFf, job.out);
        assert.ok(Math.abs(outInfo.duration - 2.5) < 0.15, `edited length ${outInfo.duration}`);
        assert.equal(outInfo.w, 320);
        assert.ok(outInfo.hasAudio);
        r = await request(es.port, 'POST', '/api/export', { body: JSON.stringify({ mode: 'edit', edit: { cuts: [[0, 4]] } }), headers: post });
        for (job = r.json; job.state === 'running'; job = (await request(es.port, 'GET', '/api/export')).json) await new Promise((res) => setTimeout(res, 50));
        assert.match(job.line, /Nothing left to export/);

        // Cutdowns: a 9:16 crop that moves, a whole-frame square and a bumper, listed in .motionsnip/outputs.json
        const cut = async (body) => {
          let c = (await request(es.port, 'POST', '/api/cutdown', { body: JSON.stringify(body), headers: post })).json;
          for (let i = 0; i < 300 && c.state === 'running'; i++) {
            await new Promise((res) => setTimeout(res, 100));
            c = (await request(es.port, 'GET', '/api/cutdown')).json;
          }
          return c;
        };
        let c = await cut({ id: 'vertical', mode: 'crop', keys: [{ t: 0, cx: 0, cy: 50 }, { t: 3, cx: 100, cy: 50 }] });
        assert.equal(c.state, 'done', 'vertical: ' + c.line);
        let ci = await probe(realFf, path.join(vd, 'outputs', 'vertical.mp4'));
        assert.deepEqual([ci.w, ci.h], [1080, 1920]);
        assert.ok(Math.abs(ci.duration - 4) < 0.15 && ci.hasAudio);
        c = await cut({ id: 'square', mode: 'blurpad' });
        assert.equal(c.state, 'done', 'square: ' + c.line);
        ci = await probe(realFf, path.join(vd, 'outputs', 'square.mp4'));
        assert.deepEqual([ci.w, ci.h], [1080, 1080]);
        c = await cut({ id: 'bumper6', ranges: [[0, 1], [3, 4]] });
        assert.equal(c.state, 'done', 'bumper: ' + c.line);
        ci = await probe(realFf, path.join(vd, 'outputs', 'bumper6.mp4'));
        assert.ok(Math.abs(ci.duration - 2) < 0.15, `bumper length ${ci.duration}`);
        assert.equal(ci.w, 320);
        c = await cut({ id: 'vertical', zoom: 1.5 });
        assert.equal(c.state, 'done');
        r = await request(es.port, 'GET', '/api/reel');
        assert.deepEqual(r.json.outputs.map((o) => [o.id, o.by, o.version]), [['vertical', 'player', 2], ['square', 'player', 1], ['bumper6', 'player', 1]]);
        assert.equal(r.json.outputs[0].zoom, 1.5);
        assert.equal(r.json.outputs[0].keys.length, 2, 'a re-render keeps the keys');
        assert.equal((await cut({ id: 'nope' })).state, 'error');
        r = await request(es.port, 'POST', '/api/cutdown-remove', { body: JSON.stringify({ id: 'square' }), headers: post });
        assert.equal(r.status, 200);
        assert.ok(!fs.existsSync(path.join(vd, 'outputs', 'square.mp4')));
        r = await request(es.port, 'GET', '/api/reel');
        assert.deepEqual(r.json.outputs.map((o) => o.id), ['vertical', 'bumper6']);
        r = await request(es.port, 'POST', '/api/cutdown', { body: JSON.stringify({ id: 'vertical' }) });
        assert.equal(r.status, 403, 'a cutdown needs the player origin');
      } finally {
        await es.close();
      }
    } else {
      console.log('(no ffmpeg that can edit: skipped the real edit export)');
    }

    // Frame export over HTTP: synthetic PNGs into ffmpeg, checked by ffprobe; a scene gets the result as its video
    if (realFf) {
      const fd = mkTmp();
      fs.writeFileSync(path.join(fd, 'scene.json'), JSON.stringify({ title: 'Frames', version: 1, size: [64, 36], fps: 10, shots: [{ id: 'a', dur: 1 }] }));
      const env = ffmpegEnv(realFf);
      const mk = await run(realFf.path, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1', path.join(fd, 'f%02d.png')], { env });
      assert.equal(mk.code, 0, 'make test frames');
      const pngs = fs.readdirSync(fd).filter((f) => f.endsWith('.png')).sort().map((f) => fs.readFileSync(path.join(fd, f)));
      assert.equal(pngs.length, 10);
      const fs2 = await startServer({ dir: fd, port: 0, open: false, quiet: true, ffmpeg: realFf.path });
      try {
        const post = { origin: `http://localhost:${fs2.port}` };
        let r = await request(fs2.port, 'GET', '/api/formats');
        assert.equal(r.json.ffmpeg, true);
        assert.ok(r.json.formats.find((f) => f.id === 'mp4').ok);
        const begin = (body) => request(fs2.port, 'POST', '/api/frames-start', { body: JSON.stringify(body), headers: post });
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 0 });
        assert.equal(r.status, 400, 'a frame count is required');
        r = await request(fs2.port, 'POST', '/api/frames-start', { body: JSON.stringify({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 10 }) });
        assert.equal(r.status, 403, 'frames need the player origin');
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 10, setSrc: true });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const job = r.json.job;
        assert.ok(job);
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 10 });
        assert.equal(r.status, 409, 'one export at a time');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${job}`, { body: Buffer.from('nope'), headers: post });
        assert.equal(r.status, 400, 'frames must be PNG');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${job}`, { body: Buffer.concat(pngs.slice(0, 6)), headers: post });
        assert.equal(r.json.got, 6);
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${job}`, { body: Buffer.concat(pngs.slice(6)), headers: post });
        assert.equal(r.json.got, 10);
        r = await request(fs2.port, 'POST', `/api/frames-end?job=${job}`, { body: '{}', headers: post });
        assert.equal(r.json.state, 'done', r.json.line);
        const info = await probe(realFf, path.join(fd, r.json.rel));
        assert.equal(info.w, 64);
        assert.ok(Math.abs(info.duration - 1) < 0.15, `frames length ${info.duration}`);
        assert.ok(!info.hasAudio);
        r = await request(fs2.port, 'GET', '/api/reel');
        assert.match(r.json.src, /^\/p\/exports\/Frames-.*\.mp4$|exports\/Frames-.*\.mp4/, 'the scene plays its export');
        // raw RGBA frames, with a still stretch sent as repeats
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 10, pix: 'rgba' });
        const rj = r.json.job;
        const rawFrame = (v) => Buffer.alloc(64 * 36 * 4, v);
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&repeat=2`, { body: '', headers: post });
        assert.equal(r.status, 400, 'nothing to repeat yet');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}`, { body: Buffer.alloc(100), headers: post });
        assert.equal(r.status, 400, 'raw frames are whole frames');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}`, { body: Buffer.concat([rawFrame(0), rawFrame(80), rawFrame(160)]), headers: post });
        assert.equal(r.json.got, 3);
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&repeat=99`, { body: '', headers: post });
        assert.equal(r.json.got, 10, 'repeats stop at the frame count');
        r = await request(fs2.port, 'POST', `/api/frames-end?job=${rj}`, { body: '{}', headers: post });
        assert.equal(r.json.state, 'done', r.json.line);
        const rinfo = await probe(realFf, path.join(fd, r.json.rel));
        assert.ok(rinfo.w === 64 && Math.abs(rinfo.duration - 1) < 0.15, `raw export ${rinfo.w} ${rinfo.duration}`);
        // with sound: the picture is made first, then the mix goes under it; frames arriving slowly don't stall it
        const tone = await run(realFf.path, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', path.join(fd, 'tone.m4a')], { env });
        assert.equal(tone.code, 0, 'make test tone');
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 10, pix: 'rgba', audio: [{ src: 'tone.m4a', at: 0.2, gain: 0.5 }] });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const sj = r.json.job;
        for (let i = 0; i < 10; i++) {
          await request(fs2.port, 'POST', `/api/frames-push?job=${sj}`, { body: rawFrame(i * 20), headers: post });
          await new Promise((res) => setTimeout(res, 30));
        }
        r = await request(fs2.port, 'POST', `/api/frames-end?job=${sj}`, { body: '{}', headers: post });
        assert.equal(r.json.state, 'done', r.json.line);
        const sinfo = await probe(realFf, path.join(fd, r.json.rel));
        assert.ok(sinfo.hasAudio && sinfo.w === 64 && Math.abs(sinfo.duration - 1) < 0.15, `sound export ${sinfo.hasAudio} ${sinfo.duration}`);
        assert.equal(fs.readdirSync(path.join(fd, 'exports')).filter((f) => f.includes('.picture.')).length, 0, 'the picture-only file is removed');
        // cancel removes the half-made file
        r = await begin({ format: 'gif', fps: 10, w: 64, h: 36, frames: 10 });
        const gj = r.json.job;
        await request(fs2.port, 'POST', `/api/frames-push?job=${gj}`, { body: Buffer.concat(pngs.slice(0, 3)), headers: post });
        r = await request(fs2.port, 'POST', `/api/frames-end?job=${gj}&cancel=1`, { body: '{}', headers: post });
        assert.equal(r.json.state, 'idle');
        assert.equal(fs.readdirSync(path.join(fd, 'exports')).filter((f) => f.endsWith('.gif')).length, 0);
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${gj}`, { body: pngs[0], headers: post });
        assert.ok(r.status >= 400, 'a finished job takes no more frames');
      } finally {
        await fs2.close();
      }
    }

    // Port fallback: a busy port moves to the next one.
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    const next = await startServer({ dir: mkTmp(), port: busy, open: false, quiet: true });
    assert.notEqual(next.port, busy);
    await next.close();
    await new Promise((r) => blocker.close(r));

    console.log('selftest ok');
    return 0;
  } catch (err) {
    console.error('selftest FAILED');
    console.error(err);
    return 1;
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dir: null, port: DEFAULT_PORT, open: true, ffmpeg: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--selftest') opts.selftest = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--port' || a.startsWith('--port=')) opts.port = Number(value());
    else if (a === '--ffmpeg' || a.startsWith('--ffmpeg=')) opts.ffmpeg = value();
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else opts.dir = a;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port must be 1-65535');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      'Usage: node player/server.mjs <project-dir | video-file> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]\n       node player/server.mjs --selftest',
    );
    return;
  }
  if (opts.selftest) process.exit(await selftest());

  let dir = path.resolve(opts.dir || '.');
  let video = null;
  if (isFile(dir)) {
    // a video file: open it as a plain video; its folder is the project
    if (!VIDEO_EXTS.includes(extOf(dir))) {
      console.error(`Not a video MotionSnip Studio can play (${VIDEO_EXTS.join(', ')}): ${dir}`);
      process.exit(2);
    }
    video = path.basename(dir);
    dir = path.dirname(dir);
  } else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Project folder or video not found: ${dir}`);
    process.exit(2);
  }
  if (!video && !isFile(path.join(dir, 'reel.json')) && isFile(path.join(dir, 'timeline.json'))) console.log(`Timeline project: composing ${path.join(dir, 'timeline.json')} live.`);
  else if (!video && !isFile(path.join(dir, 'reel.json')) && isFile(path.join(dir, 'scene.json'))) console.log(`Scene project: drawing ${path.join(dir, 'scene.json')} live.`);
  else if (!video && !isFile(path.join(dir, 'reel.json'))) {
    const found = pickVideo(dir);
    if (found) console.log(`No reel.json in ${dir}: opening ${found} as a plain video.`);
    else console.warn(`Note: no reel.json or video in ${dir} yet. The player will wait for one.`);
  }
  if (opts.ffmpeg && !isExecutable(opts.ffmpeg)) console.warn(`Note: --ffmpeg ${opts.ffmpeg} is not an executable file.`);

  const app = await startServer({ dir, video, port: opts.port, open: opts.open, ffmpeg: opts.ffmpeg });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Run only when started directly (not when imported).
const entry = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
