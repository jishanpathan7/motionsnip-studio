#!/usr/bin/env node
// MotionSnip Studio server.
//
// A small local server for the review player. It serves the player page, the
// project's files and a JSON API. Node 18+, no dependencies.
//
//   node player/server.mjs <project-dir> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]
//   node player/server.mjs --selftest
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

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../player
const ROOT = path.dirname(HERE); // the repo / skill folder
const APP_DIR = path.join(HERE, 'app');
const BRAND_DIR = path.join(ROOT, 'docs', 'brand');
const INDEX_FILE = path.join(HERE, 'index.html');

const DEFAULT_PORT = 4321;
const PORT_TRIES = 20;
const JSON_LIMIT = 2 * 1024 * 1024; // 2 MB
const UPLOAD_LIMIT = 100 * 1024 * 1024; // 100 MB
const KEEP_TAKES = 6;
const AUDIO_EXTS = ['mp3', 'wav', 'm4a'];

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

/** Read the duration and whether there is an audio stream from `ffmpeg -i` output. */
export function parseProbe(stderr) {
  const text = String(stderr || '');
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(text);
  const hasVideo = /Stream #\d+:\d+[^\n]*: Video:/.test(text);
  return { duration, hasAudio, hasVideo };
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

async function readJson(req) {
  const buf = await readBody(req, JSON_LIMIT);
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

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Start the server. Resolves to { server, port, url, close() }.
 *   opts: { dir, port, open, ffmpeg, quiet }
 */
export async function startServer(opts) {
  const dir = path.resolve(opts.dir);
  const ctx = {
    dir,
    port: 0,
    ffmpegArg: opts.ffmpeg || null,
    job: { state: 'idle', pct: 0, line: '', out: null, rel: null, mode: null },
    child: null,
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
    case 'GET ffmpeg': {
      const ff = findFfmpeg(ctx.dir, ctx.ffmpegArg);
      return sendJson(res, 200, { ok: !!ff, path: ff ? ff.path : null });
    }
    default:
      return sendError(res, 404, 'Unknown API route');
  }
}

/** Load reel.json, or throw an http error with a short message. */
function loadReel(ctx) {
  const file = path.join(ctx.dir, 'reel.json');
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

function apiReel(ctx, res) {
  const reel = loadReel(ctx);
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
  const name = cleanName(url.searchParams.get('name'));
  if (!name) throw httpError(400, 'Only mp3, wav or m4a files can be uploaded');
  if (Number(req.headers['content-length']) > UPLOAD_LIMIT) throw httpError(413, 'File is over 100 MB');

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
        if (total > UPLOAD_LIMIT) {
          reject(httpError(413, 'File is over 100 MB'));
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
    if (sniffAudio(head) !== extOf(name)) throw httpError(415, `This doesn't look like a .${extOf(name)} file`);

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
    return sendJson(res, 200, { id: `assets/${base}`, name: base, type: 'audio' });
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
    await ensureTake(ctx, loadReel(ctx));
  } catch {}
  const takes = listTakes(ctx).map((t) => ({
    version: t.version,
    src: `.motionsnip/takes/${t.file}`,
    url: `/p/.motionsnip/takes/${t.file}`,
  }));
  return sendJson(res, 200, takes);
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
  const body = (await readJson(req)) || {};
  const mode = body.mode === 'render' ? 'render' : 'mix';
  const reel = loadReel(ctx);

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
    assert.deepEqual(parseProbe(probeText), { duration: 62.5, hasAudio: true, hasVideo: true });
    assert.equal(parseProbe('Duration: 00:00:10.00\n Stream #0:0: Video: h264').hasAudio, false);
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
    const req = (method, p, { body, headers = {} } = {}) =>
      new Promise((resolve, reject) => {
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
      assert.deepEqual(r.json, { ok: false, path: null });
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
    console.log('Usage: node player/server.mjs <project-dir> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]\n       node player/server.mjs --selftest');
    return;
  }
  if (opts.selftest) process.exit(await selftest());

  const dir = path.resolve(opts.dir || '.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Project folder not found: ${dir}`);
    process.exit(2);
  }
  if (!isFile(path.join(dir, 'reel.json'))) console.warn(`Note: no reel.json in ${dir} yet. The player will wait for it.`);
  if (opts.ffmpeg && !isExecutable(opts.ffmpeg)) console.warn(`Note: --ffmpeg ${opts.ffmpeg} is not an executable file.`);

  const app = await startServer({ dir, port: opts.port, open: opts.open, ffmpeg: opts.ffmpeg });
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
