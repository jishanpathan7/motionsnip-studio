#!/usr/bin/env node
// MotionSnip Studio server.
//
// A small local server for the review player. It serves the player page, the
// project's files and a JSON API. Node 18+, no dependencies.
//
//   node player/server.mjs <project-dir | video-file> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]
//                          [--addons <dir>]… [--no-addons] [--safe]
//   node player/server.mjs --activate <key> | --install-pro | --deactivate | --licence   (MotionSnip Pro)
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
import { reframeSpec, keyExpr, CUTDOWN_FILTERS, readPlayerOutputs, writePlayerOutputs, mergeOutputs, planCutdown } from './lib/cutdown.mjs';
import { normalizeReel, resolveOutput, outTime, masterTime, cropSize, autoReframe, autoRanges } from './app/reel.mjs';
import { toReel as sceneToReel, applyPatches as applyScenePatches, normScene } from './app/scene/compile.mjs';
import { toReel as timelineToReel, applyPatches as applyTimelinePatches, normTimeline, captionCues, toSrt, toVtt } from './app/comp/timeline.mjs';
import { applyOps } from './app/comp/ops.mjs';
import { loadAddons, addonList, defaultAddonDirs } from './lib/addons.mjs';
import { createPro, PRO_ID } from './lib/pro.mjs';
import { motionsnipHome } from './lib/licence.mjs';
import { FORMATS, encoderSet, pickEncoder, availableFormats, audioMix, buildFramesArgs, buildMuxArgs, countPngs } from './lib/frames.mjs';
import { normComposeSpec, buildComposeArgs } from './lib/compose.mjs';
import { JSON_LIMIT, extOf, mimeFor, parseRange, hostAllowed, originAllowed, readBody, readJson, httpError, sendJson, sendJsonTagged, sendError, sendFile } from './lib/http.mjs';
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, cleanName, numberedName, sniffAudio, sniffImage, sniffVideo, resolveInside, parseReel, slug, stamp, isFile, isExecutable } from './lib/files.mjs';
import { localStore, META } from './lib/store.mjs';
import { createJobRunner, runTracked } from './lib/jobs.mjs';
import { EDIT_FILTERS, parseProbe, progressFromText, buildMixArgs, within, keepRanges, normLook, lookMatrix, lookFilter, buildEditArgs, pickEditEncoder, run, findFfmpeg, ffmpegEnv, probe, lastLine } from './lib/media.mjs';
// moved to lib/ and still exported from here, for the selftest and anything that imported them
export { EDIT_FILTERS, buildEditArgs, buildMixArgs, cleanName, extOf, findFfmpeg, hostAllowed, keepRanges, lookFilter, lookMatrix, mimeFor, normLook, numberedName, originAllowed, parseProbe, parseRange, parseReel, pickEditEncoder, progressFromText, resolveInside, slug, sniffAudio, sniffImage, sniffVideo, stamp };

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../player
const ROOT = path.dirname(HERE); // the repo / skill folder
const APP_DIR = path.join(HERE, 'app');
const BRAND_DIR = path.join(ROOT, 'docs', 'brand');
const INDEX_FILE = path.join(HERE, 'index.html');

const DEFAULT_PORT = 4321;
const PORT_TRIES = 20;
const EXPORT_LIMIT = 64 * 1024 * 1024; // an edit export carries its text and logo layers as PNGs
const LAYER_LIMIT = 16 * 1024 * 1024; // one layer PNG
const MAX_LAYERS = 40;
const UPLOAD_LIMIT = 100 * 1024 * 1024; // 100 MB
const VIDEO_LIMIT = 4 * 1024 * 1024 * 1024; // 4 GB, streamed to disk
const KEEP_TAKES = 6;

// ---------------------------------------------------------------------------
// Pure helpers (exported for --selftest)
// ---------------------------------------------------------------------------

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/** The ffmpeg this server uses: --ffmpeg, else one on PATH, else one a Remotion project bundles. */
const ffmpegFor = (ctx) => findFfmpeg(ctx.store.root, ctx.ffmpegArg);

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

/** The video to open in a project with no reel.json: the newest playable one at the top level, or null. */
export async function pickVideo(store) {
  let best = null;
  for (const e of await store.list('')) {
    if (!e.file || e.name.startsWith('.') || !VIDEO_EXTS.includes(extOf(e.name))) continue;
    if (!best || e.mtimeMs > best.m) best = { name: e.name, m: e.mtimeMs };
  }
  return best ? best.name : null;
}

/**
 * A plain video's version: 1 the first time, +1 each time the file changes (a new cut exported over the
 * same name), counted once the file has stopped changing for 2 s. Kept in .motionsnip/video.json.
 * Opening a different video in the same folder starts again at 1 and drops the old takes.
 */
export async function videoVersion(store, name, stat, now = Date.now()) {
  const sig = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  const saved = (await store.readJson(`${META}/video.json`)) || {};
  const same = saved.src === name;
  const ver = Math.max(1, Math.floor(Number(saved.version)) || 1);
  if (same && (saved.sig === sig || now - stat.mtimeMs < 2000)) return ver;
  const version = same ? ver + 1 : 1;
  try {
    if (!same && saved.src) await store.remove(`${META}/takes`, { recursive: true });
    await store.writeText(`${META}/video.json`, JSON.stringify({ src: name, sig, version }));
  } catch {
    /* a read-only folder still plays; it just can't count versions */
  }
  return version;
}

/** Make up a reel from the video itself. */
async function plainReel(ctx) {
  const { store } = ctx;
  const name = ctx.video || (await pickVideo(store));
  if (!name) throw httpError(404, `No reel.json or video file in ${store.root}`);
  const file = store.path(name);
  const stat = await store.stat(name);
  if (!stat?.file) throw httpError(404, `Video not found: ${file}`);
  const sig = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (ctx.probed?.sig !== sig) {
    const ff = ffmpegFor(ctx);
    ctx.probed = { sig, info: ff ? await probe(ff, file) : {} };
  }
  const info = ctx.probed.info;
  const stem = name.slice(0, name.length - path.extname(name).length);
  const reel = {
    id: `${slug(stem)}-${crypto.createHash('sha1').update(file).digest('hex').slice(0, 6)}`,
    title: name,
    version: await videoVersion(store, name, stat),
    src: name,
    path: store.root,
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
async function sceneReel(ctx) {
  const { store } = ctx;
  let raw;
  try {
    raw = parseReel((await store.readText('scene.json')) ?? '');
  } catch (err) {
    throw httpError(500, `scene.json is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(500, 'scene.json must be a JSON object');
  const src = typeof raw.src === 'string' && raw.src && (await store.file(raw.src)) ? raw.src : await lastRender(ctx, raw.version);
  const reel = sceneToReel(raw, { src });
  reel.path = store.root;
  reel.file = store.path('scene.json');
  return reel;
}

/** Where a scene's or timeline's last export is remembered (scene.json stays Claude's file). */
const RENDER_FILE = `${META}/render.json`;

/** The last export of this version, so takes, compare and cutdowns have a video ('' when there is none). */
async function lastRender(ctx, version) {
  const r = await ctx.store.readJson(RENDER_FILE);
  if (r && r.version === (Number(version) || 1) && typeof r.src === 'string' && (await ctx.store.file(r.src))) return r.src;
  return '';
}

/** A project file as JSON: { file, raw, text, rev } where rev is a short hash of the text (who saved last). */
async function readProjectFile(ctx, rel) {
  const text = await ctx.store.readText(rel);
  if (text == null) throw httpError(404, `${rel} not found`);
  let raw;
  try {
    raw = parseReel(text);
  } catch (err) {
    throw httpError(500, `${rel} is not valid JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(500, `${rel} must be a JSON object`);
  return { file: ctx.store.path(rel), raw, text, rev: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) };
}

/** The scene files a timeline's scene clips use: { 'scene.json': raw }. Unreadable ones are left out (lint says so). */
async function timelineScenes(ctx, raw) {
  const out = {};
  for (const t of Array.isArray(raw.tracks) ? raw.tracks : [])
    for (const c of t?.kind === 'scene' && Array.isArray(t.clips) ? t.clips : []) {
      const rel = typeof c?.scene === 'string' && c.scene ? c.scene : 'scene.json';
      if (rel in out || !rel.endsWith('.json')) continue;
      try {
        out[rel] = (await readProjectFile(ctx, rel)).raw;
      } catch {}
    }
  return out;
}

/**
 * A timeline project (timeline.json, no reel.json): the reel is built from the composition. The player draws it
 * live; "src" is the last export of this version. rev is timeline.json's, depsRev the scene files'.
 */
async function timelineReel(ctx) {
  const { raw, rev, file } = await readProjectFile(ctx, 'timeline.json');
  const scenes = await timelineScenes(ctx, raw);
  // which media files are there, for lint (asked once each, up front: the compiler is synchronous)
  const media = new Set();
  for (const t of Array.isArray(raw.tracks) ? raw.tracks : [])
    for (const c of Array.isArray(t?.clips) ? t.clips : []) if (typeof c?.src === 'string' && c.src && (await ctx.store.file(c.src))) media.add(c.src);
  const reel = timelineToReel(raw, { scenes, src: await lastRender(ctx, raw.version), exists: (rel) => media.has(rel) });
  reel.rev = rev; // the base for the editor's saves
  reel.depsRev = crypto.createHash('sha1').update(JSON.stringify(scenes)).digest('hex').slice(0, 12); // the scenes it uses
  reel.path = ctx.store.root;
  reel.file = file;
  return reel;
}

/** The video a timeline.json was made from ("Open in timeline"), or null. */
async function timelineFrom(ctx) {
  const from = (await ctx.store.readJson('timeline.json'))?.from;
  return typeof from === 'string' ? from : null;
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
    await ctx.store.writeText('timeline.json', JSON.stringify(tl, null, 2) + '\n', { create: true });
  } catch (err) {
    if (err.code === 'EEXIST') throw httpError(409, 'This folder already has a timeline.json');
    throw err;
  }
  return sendJson(res, 200, { ok: true, file: 'timeline.json' });
}

/**
 * Write the player's edits into timeline.json or a scene file, without Claude.
 * body: { file, base?, bump?, patches?: [{ path, value }], ops?: [...] (timeline only), content?: {...} (a whole copy: undo) }
 *   base: the rev the edit was made on; a different file on disk is a 409 (reload, then edit again).
 *   bump: start a new version (Apply); plain editor saves keep the version.
 */
async function apiProjectApply(ctx, req, res) {
  const body = (await readJson(req)) || {};
  const rel = typeof body.file === 'string' ? body.file : '';
  const isTimeline = rel === 'timeline.json';
  if (!isTimeline) {
    // a scene file: scene.json, or one the timeline uses
    let ok = rel === 'scene.json';
    if (!ok && rel.endsWith('.json') && (await ctx.store.file('timeline.json'))) ok = rel in (await timelineScenes(ctx, (await readProjectFile(ctx, 'timeline.json')).raw));
    if (!ok) throw httpError(400, `Can't edit ${rel || 'that file'} here`);
  }
  const cur = await readProjectFile(ctx, rel);
  if (body.base && body.base !== cur.rev) return sendJson(res, 409, { error: `${rel} changed since you started this edit`, rev: cur.rev });
  let out = cur.raw;
  try {
    if (isTimeline) {
      const scenes = await timelineScenes(ctx, cur.raw);
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
  await ctx.store.writeText(rel, text);
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
  const store = opts.store || localStore(opts.dir);
  const ctx = {
    store, // the project's files (lib/store.mjs)
    port: 0,
    ffmpegArg: opts.ffmpeg || null,
    video: opts.video || null,
    probed: null, // the plain video's last ffmpeg probe
    editEnc: null, // { path, encoder } for edit exports
    // the long tasks (lib/jobs.mjs): an export (the video) and a cutdown being made
    jobs: createJobRunner({
      export: { state: 'idle', pct: 0, line: '', out: null, rel: null, mode: null },
      cutdown: { state: 'idle', pct: 0, line: '', id: null, label: null },
    }),
    takesBusy: new Set(),
    addons: new Map(),
    // false (--safe): code from the project folder never runs: no export.cmd, no live.js
    projectCode: opts.projectCode !== false,
  };
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  // Pro: the licence in opts.home (~/.motionsnip when started from the command line); off without a home
  ctx.pro = opts.home ? await createPro({ home: opts.home, keys: opts.licenceKeys, server: opts.licenceServer, fetch: opts.fetch, log }) : null;
  // add-ons from opts.addons (folders that hold add-on folders); none unless asked for
  ctx.addonDirs = (opts.addons || []).map((d) => path.resolve(d));
  ctx.loadAddons = async () => {
    ctx.addons = await loadAddons(ctx.addonDirs, {
      log,
      entitled: (name, o) => !!ctx.pro?.entitled(name, o),
      helpers: { sendJson, sendError, readJson, httpError, resolveInside, projectDir: () => ctx.store.root, store: ctx.store, ffmpeg: () => ffmpegFor(ctx) },
    });
  };
  await ctx.loadAddons();
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      // Our own httpError messages are short and meant for the player; anything else stays in the log.
      const status = err.status || 500;
      if (!err.expose && !opts.quiet) console.error(err);
      if (!res.headersSent) sendError(res, status, err.expose ? err.message : 'Server error');
      else res.destroy();
    });
  });

  // Node closes an idle kept-alive connection after 5 s by default. A browser that sends on that socket just as
  // it closes gets "Failed to fetch", which can drop an export partway through (a frame batch that takes a few
  // seconds to draw is enough). Keep idle connections much longer than any pause between requests.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  const port = await listen(server, opts.port ?? DEFAULT_PORT);
  ctx.port = port;
  const url = `http://localhost:${port}`;
  if (!opts.quiet) console.log(`MotionSnip Studio: ${url}  (project: ${store.root})`);
  if (opts.open) openInBrowser(url);
  // a licence that ends within 7 days is refreshed quietly (the only call made without you asking, and only
  // when you have a licence); offline, Pro keeps working until it ends
  if (ctx.pro) ctx.pro.maybeRefresh().then((done) => done && ctx.loadAddons()).catch(() => {});
  return {
    server,
    port,
    url,
    ctx,
    close: () =>
      new Promise((resolve) => {
        ctx.jobs.stopAll();
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
  if (pathname.startsWith('/addons/')) return serveAddon(ctx, req, res, pathname.slice(8));
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

/** /addons/<id>/* -> a file of an add-on that is on (a locked or broken add-on's files aren't served). */
function serveAddon(ctx, req, res, rel) {
  const [id, ...rest] = rel.split('/');
  const a = ctx.addons.get(id);
  if (!a || a.state !== 'on') return sendError(res, 404, 'Not found');
  if (rest.some((p) => p.startsWith('.'))) return sendError(res, 403, 'Forbidden');
  const file = resolveInside(a.dir, rest.join('/'));
  if (!file) return sendError(res, 403, 'Forbidden');
  if (!isFile(file)) return sendError(res, 404, 'Not found');
  return sendFile(req, res, file);
}

/** /p/* -> a file in the project, else in its public/ folder. */
async function serveProject(ctx, req, res, rel) {
  // Hidden files (.env, .git...) stay private; only our own .motionsnip folder is served.
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => p.startsWith('.') && p !== '.motionsnip')) return sendError(res, 403, 'Forbidden');
  if (!ctx.store.path(rel)) return sendError(res, 403, 'Forbidden');
  const file = (await ctx.store.file(rel)) || (await ctx.store.file(`public/${rel}`));
  if (file) return sendFile(req, res, file);
  return sendError(res, 404, 'Not found');
}

async function api(ctx, req, res, route, url) {
  const m = req.method === 'HEAD' ? 'GET' : req.method;
  const key = `${m} ${route}`;
  switch (key) {
    case 'GET reel':
      return apiReel(ctx, req, res);
    case 'GET state':
      return apiGetState(ctx, res);
    case 'POST state':
      return apiPostState(ctx, req, res);
    case 'POST upload':
      return apiUpload(ctx, req, res, url);
    case 'POST feedback':
      return apiFeedback(ctx, req, res);
    case 'GET export':
      return sendJson(res, 200, ctx.jobs.export.status);
    case 'POST export':
      return apiExport(ctx, req, res);
    case 'POST reveal':
      return apiReveal(ctx, req, res);
    case 'GET takes':
      return apiTakes(ctx, res);
    case 'GET cutdown':
      return sendJson(res, 200, ctx.jobs.cutdown.status);
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
      const ff = ffmpegFor(ctx);
      // edits: this ffmpeg can export a plain video's trim, cuts, colour and layers
      return sendJson(res, 200, { ok: !!ff, path: ff ? ff.path : null, edits: !!(await editEncoder(ctx, ff)) });
    }
    case 'GET addons':
      return sendJson(res, 200, { addons: addonList(ctx.addons) });
    case 'GET licence':
    case 'POST licence/activate':
    case 'POST licence/refresh':
    case 'POST licence/deactivate':
    case 'POST licence/install':
      return apiLicence(ctx, req, res, key);
    default: {
      // /api/addons/<id>/<name>: a route an add-on registered
      const hit = /^addons\/([^/]+)\/([^/]+)$/.exec(route);
      const a = hit && ctx.addons.get(hit[1]);
      const handler = a && a.state === 'on' && a.routes.get(`${m} ${hit[2]}`);
      if (handler) return handler(req, res, { url });
      return sendError(res, 404, 'Unknown API route');
    }
  }
}

/** What the player sees of the Pro licence and add-on: never the key or the licence itself. */
function licenceView(ctx) {
  const st = ctx.pro.status();
  const a = ctx.addons.get(PRO_ID);
  return {
    state: st.state,
    reason: st.reason,
    plan: st.plan,
    expires: st.expires,
    periodEnd: st.periodEnd,
    updatesUntil: st.updatesUntil,
    addon: a ? { state: a.state, version: a.version, reason: a.reason || '' } : null,
    buy: 'https://motionsnip.com/pro/',
  };
}

/** /api/licence: the Pro licence (GET), and activate, refresh, deactivate and install (POST). */
async function apiLicence(ctx, req, res, key) {
  if (!ctx.pro) return sendError(res, 404, 'Pro licences are off for this server');
  if (key === 'GET licence') return sendJson(res, 200, licenceView(ctx));
  const body = (await readJson(req)) || {};
  if (key === 'POST licence/activate') await ctx.pro.activate(body.key);
  else if (key === 'POST licence/refresh') await ctx.pro.refresh();
  else if (key === 'POST licence/deactivate') await ctx.pro.deactivate();
  else if (key === 'POST licence/install') {
    await ctx.pro.install();
    // the Pro add-on lives in <home>/addons; load it even when the add-on folders were chosen with --addons
    if (!ctx.addonDirs.includes(ctx.pro.addonsDir)) ctx.addonDirs.push(ctx.pro.addonsDir);
  }
  await ctx.loadAddons();
  return sendJson(res, 200, licenceView(ctx));
}

/** Load reel.json (or, with none, the plain video's made-up reel), or throw an http error with a short message. */
async function loadReel(ctx) {
  const reel = await readReel(ctx);
  const mine = await readPlayerOutputs(ctx.store);
  if (mine.length || reel.outputs) reel.outputs = mergeOutputs(reel.outputs, mine);
  return ctx.projectCode ? reel : withoutProjectCode(reel);
}

/** Safe mode: the reel without the parts that run code from the project folder, and a note of what was left out. */
export function withoutProjectCode(reel) {
  const off = [];
  const out = { ...reel };
  if (out.export && typeof out.export === 'object' && typeof out.export.cmd === 'string' && out.export.cmd.trim()) {
    const { cmd, cwd, ...rest } = out.export;
    out.export = Object.keys(rest).length ? rest : undefined;
    if (!out.export) delete out.export;
    off.push('export.cmd');
  }
  // a live renderer given as a script file; MotionSnip's own scene and timeline renderers run no project code
  if (typeof out.live === 'string' && out.live) {
    delete out.live;
    off.push('live');
  }
  if (off.length) out.codeOff = off;
  return out;
}

async function readReel(ctx) {
  const { store } = ctx;
  const text = await store.readText('reel.json');
  if (text == null) {
    // a video opened as a file plays plain until "Open in timeline" makes a timeline.json for it
    if ((await store.file('timeline.json')) && (!ctx.video || (await timelineFrom(ctx)) === ctx.video)) return timelineReel(ctx);
    if (ctx.video) return plainReel(ctx);
    return (await store.file('scene.json')) ? sceneReel(ctx) : plainReel(ctx);
  }
  let reel;
  try {
    reel = parseReel(text);
  } catch (err) {
    throw httpError(500, `reel.json is not valid JSON: ${err.message}`);
  }
  if (!reel || typeof reel !== 'object' || Array.isArray(reel)) throw httpError(500, 'reel.json must be a JSON object');
  if (!reel.path) reel.path = store.root; // so the prompt can always say where the project is
  return reel;
}

async function apiReel(ctx, req, res) {
  const reel = await loadReel(ctx);
  ensureTake(ctx, reel); // (not awaited) snapshot this version's video for compare (in the background)
  return sendJsonTagged(req, res, reel); // the player polls this every 2 s: 304 when nothing changed
}

const STATE_FILE = `${META}/state.json`;

async function apiGetState(ctx, res) {
  return sendJson(res, 200, (await ctx.store.readJson(STATE_FILE)) ?? {});
}

async function apiPostState(ctx, req, res) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'State must be a JSON object');
  await ctx.store.writeText(STATE_FILE, JSON.stringify(body, null, 1));
  return sendJson(res, 200, { ok: true });
}

async function apiUpload(ctx, req, res, url) {
  const name = cleanName(url.searchParams.get('name'), [...AUDIO_EXTS, ...IMAGE_EXTS, ...VIDEO_EXTS]);
  if (!name) throw httpError(400, 'Only mp3, wav, m4a, png, jpg, webp, mp4, mov or webm files can be uploaded');
  const type = IMAGE_EXTS.includes(extOf(name)) ? 'image' : VIDEO_EXTS.includes(extOf(name)) ? 'video' : 'audio';
  const limit = type === 'video' ? VIDEO_LIMIT : UPLOAD_LIMIT;
  const tooBig = `File is over ${Math.round(limit / 1024 / 1024)} MB`;
  if (Number(req.headers['content-length']) > limit) throw httpError(413, tooBig);

  // streamed to a temp file next to where it goes, then moved in under a free name
  const tmp = ctx.store.path(`assets/.upload-${crypto.randomBytes(6).toString('hex')}.part`);
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
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

    // never overwrites: a taken name becomes name-2, name-3...
    const id = await ctx.store.addFile('assets', name, tmp);
    return sendJson(res, 200, { id, name: id.slice('assets/'.length), type });
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function apiFeedback(ctx, req, res) {
  const body = await readJson(req);
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 0) throw httpError(400, 'version must be a whole number');
  if (typeof body.markdown !== 'string' || !body.markdown.trim()) throw httpError(400, 'markdown is required');
  const rel = `${META}/feedback-v${version}.md`;
  await ctx.store.writeText(rel, body.markdown.endsWith('\n') ? body.markdown : body.markdown + '\n');
  return sendJson(res, 200, { path: ctx.store.path(rel) });
}

async function apiReveal(ctx, req, res) {
  const body = await readJson(req);
  const file = typeof body?.path === 'string' ? ctx.store.path(body.path) : null;
  if (!file) throw httpError(403, 'Path must be inside the project');
  const st = await ctx.store.stat(body.path);
  if (!st) throw httpError(404, 'Not found');
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', ['-R', file]]
      : process.platform === 'win32'
        ? ['explorer', [`/select,${file}`]]
        : ['xdg-open', [st.dir ? file : path.dirname(file)]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
  return sendJson(res, 200, { ok: true });
}

// --- Takes: copies of recent versions' videos, for compare ----------------

const TAKES = `${META}/takes`;

async function listTakes(ctx) {
  return (await ctx.store.list(TAKES))
    .map((e) => {
      const m = /^v(\d+)\.([A-Za-z0-9]+)$/.exec(e.name);
      return m && e.file ? { version: Number(m[1]), file: e.name, mtimeMs: e.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.version - a.version);
}

/** Copy the current version's video into .motionsnip/takes/v<N>.<ext>, keep the newest 6. */
async function ensureTake(ctx, reel) {
  const { store } = ctx;
  const version = Number(reel.version);
  if (!Number.isInteger(version) || version < 0 || typeof reel.src !== 'string') return;
  const src = await store.stat(reel.src);
  if (!src?.file) return;
  const name = `v${version}.${extOf(reel.src) || 'mp4'}`;
  const dest = `${TAKES}/${name}`;
  // Copy when missing, or when the render changed after we copied it (Claude bumped the version mid-render).
  if (((await store.stat(dest))?.mtimeMs ?? -1) >= src.mtimeMs) return;
  if (ctx.takesBusy.has(dest)) return;
  ctx.takesBusy.add(dest);
  try {
    await store.copy(reel.src, dest);
    // Other files for this version (different extension) are stale now.
    for (const t of await listTakes(ctx)) if (t.version === version && t.file !== name) await store.remove(`${TAKES}/${t.file}`);
    for (const t of (await listTakes(ctx)).slice(KEEP_TAKES)) await store.remove(`${TAKES}/${t.file}`);
  } catch (err) {
    console.error('Could not save take:', err.message);
  } finally {
    ctx.takesBusy.delete(dest);
  }
}

async function apiTakes(ctx, res) {
  try {
    await ensureTake(ctx, await loadReel(ctx));
  } catch {}
  const takes = (await listTakes(ctx)).map((t) => ({
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
  const ff = ffmpegFor(ctx);
  const have = await formatsFor(ctx, ff);
  const formats = Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext, ok: !!have[id], encoder: have[id] || null }));
  return sendJson(res, 200, { ffmpeg: !!ff, formats });
}

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
    ctx.jobs.export.reset();
  }
  if (ctx.jobs.export.running) throw httpError(409, 'An export is already running');
  const body = (await readJson(req)) || {};
  const ff = ffmpegFor(ctx);
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
    const file = typeof c?.src === 'string' ? await ctx.store.file(c.src) : null;
    if (!file) throw httpError(400, `Audio not found in the project: ${c?.src}`);
    if (!(await hasSound(ctx, ff, file))) continue; // a video clip with no sound track adds nothing to the mix
    audio.push({ file, at: num(c.at, 0), in: num(c.in, 0), out: num(c.out, null), gain: num(c.gain, 1), fadeIn: num(c.fadeIn, 0), fadeOut: num(c.fadeOut, 0) });
  }
  const reel = await loadReel(ctx);
  const tag = typeof body.tag === 'string' && /^[\w-]{1,24}$/.test(body.tag) ? `-${body.tag}` : '';
  const rel = await ctx.store.freeName('exports', `${slug(reel.id)}${tag}-${stamp()}.${FORMATS[format].ext}`);
  const out = ctx.store.path(rel);
  const raw = body.pix === 'rgba';
  // with sound, the frames become a picture-only file first and the sound is added in a second pass (see buildMuxArgs)
  const withSound = !!buildMuxArgs({ video: out, out, format, duration: frames / fps, audio });
  const picture = withSound ? out.replace(/(\.\w+)$/, '.picture$1') : out;
  // composed: ffmpeg draws the timeline's video clips and blur boxes, the frames go on top (lib/compose.mjs)
  let comp = null;
  if (body.compose) {
    if (!raw) throw httpError(400, 'A composed export needs raw frames');
    // the files its video clips use (asked up front: normComposeSpec is synchronous)
    const files = new Map();
    for (const L of Array.isArray(body.compose?.layers) ? body.compose.layers.slice(0, 64) : [])
      if (typeof L?.src === 'string' && !files.has(L.src)) files.set(L.src, await ctx.store.file(L.src));
    try {
      comp = normComposeSpec(body.compose, (src) => files.get(src) || null);
    } catch (e) {
      throw httpError(400, e.message);
    }
  }
  let args;
  let graphFile = null;
  if (comp) {
    for (const L of comp.layers) if (L.kind === 'video') L.untagged = !(await probe(ff, L.file).catch(() => ({}))).matrix;
    const built = buildComposeArgs({ fps, w, h, frames, out: picture, format, encoder, ...comp, look: lookFilter });
    args = built.args;
    // a long graph (many keyframes) goes in a file: command lines have a length limit
    if (built.graph.length > 100_000) {
      graphFile = path.join(os.tmpdir(), `motionsnip-graph-${crypto.randomBytes(6).toString('hex')}.txt`);
      fs.writeFileSync(graphFile, built.graph);
      const i = args.indexOf('-filter_complex');
      args.splice(i, 2, '-/filter_complex', graphFile);
    }
  } else args = buildFramesArgs({ fps, w, h, frames, out: picture, format, encoder, raw });
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
      if (graphFile) fs.rmSync(graphFile, { force: true });
      resolve();
    });
  });
  ctx.frames = job;
  ctx.jobs.export.attach(child);
  ctx.jobs.export.begin({ line: `Drawing frames (0/${frames})…`, out, rel, mode: 'frames' });
  return sendJson(res, 200, { job: id, format, encoder, w, h, fps, frames, rel, composed: !!comp });
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
  // ?from=i (raw frames): the index of the first frame in this push, so a push the page sends again after a failed
  // request doesn't add its frames twice. Frames the server already has are skipped; a gap is an error.
  const fromRaw = url.searchParams.get('from');
  const from = fromRaw == null ? null : Math.round(num(fromRaw, NaN));
  if (from != null) {
    if (!j.frameBytes) throw httpError(400, '?from= is for raw frames');
    if (!(from >= 0)) throw httpError(400, 'Bad ?from=');
    if (from > j.got) throw httpError(400, `Frames missing: the server has ${j.got}, this push starts at ${from}`);
  }
  const already = from == null ? 0 : j.got - from;
  // ?repeat=n: the last frame again n times (a still stretch costs no upload)
  const asked = Math.max(0, Math.round(num(url.searchParams.get('repeat'), 0)));
  const repeat = Math.min(Math.max(0, asked - already), j.total - j.got);
  if (asked) {
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
    const fresh = already > 0 ? buf.subarray(Math.min(buf.length, already * j.frameBytes)) : buf;
    if (fresh.length) {
      const ok = j.child.stdin.write(fresh);
      if (!ok) await new Promise((r) => j.child.stdin.once('drain', r));
      if (j.frameBytes) {
        j.got += fresh.length / j.frameBytes;
        j.lastFrame = Buffer.from(fresh.subarray(fresh.length - j.frameBytes));
      } else j.got += countPngs(fresh);
    }
  }
  ctx.jobs.export.set({ pct: clamp((j.got / j.total) * 97, 0, 97), line: `Drawing frames (${Math.min(j.got, j.total)}/${j.total})…` });
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
    ctx.jobs.export.reset();
    return sendJson(res, 200, ctx.jobs.export.status);
  }
  ctx.jobs.export.set({ line: 'Encoding…', pct: 98 });
  j.child.stdin.end();
  await j.done;
  if (!j.failed && j.picture !== j.out) {
    ctx.jobs.export.set({ line: 'Adding sound…', pct: 99 });
    const ff = ffmpegFor(ctx);
    const r = await run(ff.path, buildMuxArgs({ video: j.picture, out: j.out, format: j.format, duration: j.duration, audio: j.audio }), { env: ffmpegEnv(ff) });
    if (r.code !== 0) j.failed = lastLine(r.stderr) || `ffmpeg exited with code ${r.code}`;
  }
  if (j.picture !== j.out) fs.rmSync(j.picture, { force: true });
  ctx.frames = null;
  if (j.failed) {
    fs.rmSync(j.out, { force: true });
    ctx.jobs.export.set({ state: 'error', line: j.failed, out: null, rel: null });
  } else {
    if (j.setSrc) {
      try {
        await ctx.store.writeText(RENDER_FILE, JSON.stringify({ version: j.version, src: j.rel }));
      } catch {
        /* the export still worked */
      }
    }
    const side = j.captions ? await writeCaptionFiles(ctx, j.rel).catch(() => []) : [];
    ctx.jobs.export.set({ state: 'done', pct: 100, line: `Saved ${j.rel}${side.length ? ` and its captions (${side.join(', ')})` : ''}` });
  }
  return sendJson(res, 200, ctx.jobs.export.status);
}

/** A timeline's captions next to an export (rel): name.srt and name.vtt. Returns the extensions written. */
async function writeCaptionFiles(ctx, rel) {
  const { raw } = await readProjectFile(ctx, 'timeline.json');
  const cues = captionCues(normTimeline(raw, { scenes: await timelineScenes(ctx, raw) }));
  if (!cues.length) return [];
  const base = rel.replace(/\.[^./]+$/, '');
  await ctx.store.writeText(base + '.srt', toSrt(cues));
  await ctx.store.writeText(base + '.vtt', toVtt(cues));
  return ['.srt', '.vtt'];
}

// --- Export ------------------------------------------------------------------

async function apiExport(ctx, req, res) {
  if (ctx.jobs.export.running) throw httpError(409, 'An export is already running');
  const body = (await readJson(req, EXPORT_LIMIT)) || {};
  const mode = ['render', 'edit'].includes(body.mode) ? body.mode : 'mix';
  if (mode === 'render' && !ctx.projectCode) throw httpError(403, "This server runs in safe mode (--safe): the project's export command doesn't run");
  const reel = await loadReel(ctx);

  // Music: a project path, or none.
  let music = null;
  if (body.music) {
    music = typeof body.music === 'string' ? await ctx.store.file(body.music) : null;
    if (!music) throw httpError(400, 'Music file not found in the project');
  }
  const levels = {
    music,
    musicVol: clamp(num(body.musicVol, 1), 0, 1),
    sfxVol: clamp(num(body.sfxVol, 1), 0, 1),
    musicOffset: num(body.musicOffset, 0),
    musicFade: Math.max(0, num(body.musicFade, 0)),
  };

  const rel = await ctx.store.freeName('exports', `${slug(reel.id)}-${stamp()}.mp4`);
  const out = ctx.store.path(rel);
  ctx.jobs.export.begin({ line: 'Starting…', out, rel, mode });

  if (mode === 'render') {
    if (!reel.export || typeof reel.export.cmd !== 'string' || !reel.export.cmd.trim()) {
      ctx.jobs.export.reset();
      throw httpError(400, 'reel.json has no export.cmd');
    }
    runRender(ctx, reel, body.props, levels, out).catch((err) => ctx.jobs.export.set({ state: 'error', line: err.message }));
  } else if (mode === 'edit') {
    const ff = ffmpegFor(ctx);
    const encoder = await editEncoder(ctx, ff);
    const video = await ctx.store.file(String(reel.src || ''));
    const fail = (line) => {
      ctx.jobs.export.set({ state: 'error', line, out: null, rel: null });
      return sendJson(res, 200, ctx.jobs.export.status);
    };
    if (!ff) return fail('ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.');
    if (!encoder) return fail("This ffmpeg can't apply edits (it has no video filters). Install the full one (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.");
    if (!video) return fail(`Video not found: ${reel.src}`);
    runEdit(ctx, ff, encoder, video, reel, body.edit, levels, out)
      .then(() => ctx.jobs.export.set({ state: 'done', pct: 100, line: `Saved ${rel}` }))
      .catch((err) => {
        fs.rmSync(out, { force: true });
        ctx.jobs.export.set({ state: 'error', line: err.message, out: null, rel: null });
      });
  } else {
    const ff = ffmpegFor(ctx);
    if (!ff) {
      ctx.jobs.export.set({ state: 'error', line: 'ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.', out: null, rel: null });
      return sendJson(res, 200, ctx.jobs.export.status);
    }
    const video = await ctx.store.file(String(reel.src || ''));
    if (!video) {
      ctx.jobs.export.set({ state: 'error', line: `Video not found: ${reel.src}`, out: null, rel: null });
      return sendJson(res, 200, ctx.jobs.export.status);
    }
    runMix(ctx, ff, video, levels, out, reel.duration)
      .then(() => ctx.jobs.export.set({ state: 'done', pct: 100, line: `Saved ${rel}` }))
      .catch((err) => {
        fs.rmSync(out, { force: true });
        ctx.jobs.export.set({ state: 'error', line: err.message, out: null, rel: null });
      });
  }
  return sendJson(res, 200, ctx.jobs.export.status);
}

/** Copy the video and mix in the music with ffmpeg. Updates the export's pct as it goes. */
async function runMix(ctx, ff, video, levels, out, reelDuration) {
  const info = await probe(ff, video);
  const duration = info.duration || num(reelDuration, 0);
  if (!(duration > 0)) throw new Error('Could not read the video duration');
  const args = buildMixArgs({ video, out, duration, hasVideoAudio: info.hasAudio, ...levels });
  ctx.jobs.export.set({ line: 'Mixing audio…' });
  await runTracked(ctx.jobs.export, ff.path, args, { env: ffmpegEnv(ff), seconds: duration });
}

/**
 * Export an edited plain video: trim, cuts, colour, blur boxes, and text/logo layers the player drew as
 * full-frame PNGs (data URLs in edit.layers[].png). Updates the export's pct over the edited length.
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
    ctx.jobs.export.set({ line: 'Applying your edits…' });
    await runTracked(ctx.jobs.export, ff.path, args, { env: ffmpegEnv(ff), seconds: OD });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Cutdowns -----------------------------------------------------------------

/** Music and levels from a request body (the player's current audio). */
async function levelsFrom(ctx, body) {
  let music = null;
  if (body.music) {
    music = typeof body.music === 'string' ? await ctx.store.file(body.music) : null;
    if (!music) throw httpError(400, 'Music file not found in the project');
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
  if (ctx.jobs.cutdown.running) throw httpError(409, 'A cutdown is already being made');
  const body = (await readJson(req)) || {};
  if (typeof body.id !== 'string' || !body.id) throw httpError(400, 'Which cutdown? (id)');
  const reel = await readReel(ctx);
  const mine = await readPlayerOutputs(ctx.store);
  if ((Array.isArray(reel.outputs) ? reel.outputs : []).some((o) => o && String(o.id) === body.id)) {
    throw httpError(400, 'Claude made this version; ask Claude to change it');
  }
  const levels = await levelsFrom(ctx, body);
  const fail = (line) => {
    ctx.jobs.cutdown.reset({ state: 'error', line, id: body.id });
    return sendJson(res, 200, ctx.jobs.cutdown.status);
  };
  const ff = ffmpegFor(ctx);
  if (!ff) return fail('ffmpeg not found. Install it (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.');
  const encoder = await cutEncoder(ctx, ff);
  if (!encoder) return fail("This ffmpeg can't make cutdowns (it has no video filters). Install the full one (brew install ffmpeg) or start the server with --ffmpeg /path/to/ffmpeg.");
  const video = await ctx.store.file(String(reel.src || ''));
  if (!video) return fail(`Video not found: ${reel.src}`);
  const info = await probe(ff, video);
  if (!(info.duration > 0) || !info.w || !info.h) return fail("Couldn't read the video's length or size");

  const prev = mine.find((o) => o.id === body.id) || null;
  let entry;
  try {
    entry = planCutdown({ ...reel, w: info.w, h: info.h, duration: info.duration }, body, prev);
  } catch (err) {
    return fail(err.message);
  }
  ctx.jobs.cutdown.begin({ line: `Making the ${entry.label} version…`, id: entry.id, label: entry.label });
  runCutdown(ctx, ff, encoder, video, info, reel, entry, levels)
    .then(() => ctx.jobs.cutdown.set({ state: 'done', pct: 100, line: `Saved ${entry.src}` }))
    .catch((err) => ctx.jobs.cutdown.set({ state: 'error', line: err.message }));
  return sendJson(res, 200, ctx.jobs.cutdown.status);
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
  const final = ctx.store.path(`outputs/${entry.id}.mp4`);
  const tmp = ctx.store.path(`outputs/.${entry.id}.${crypto.randomBytes(3).toString('hex')}.mp4`);
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const OD = keep.reduce((s, [a, b]) => s + b - a, 0);
  const args = buildEditArgs({ video, hasVideoAudio: info.hasAudio, W: info.w, H: info.h, fps: info.fps || reel.fps, D, keep, reframe, encoder, out: tmp, ...levels });
  try {
    await runTracked(ctx.jobs.cutdown, ff.path, args, { env: ffmpegEnv(ff), seconds: OD });
    fs.renameSync(tmp, final);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // list it (re-read: the list may have changed while ffmpeg ran)
  const list = await readPlayerOutputs(ctx.store);
  const i = list.findIndex((o) => o.id === entry.id);
  const version = i >= 0 ? (Number(list[i].version) || 1) + 1 : 1;
  const done = { ...entry, version, from: Number(reel.version) || 1, made: new Date().toISOString() };
  if (i >= 0) list[i] = done;
  else list.push(done);
  await writePlayerOutputs(ctx.store, list);
}

/** Remove a cutdown made in the player, and its video. */
async function apiCutdownRemove(ctx, req, res) {
  const body = (await readJson(req)) || {};
  if (ctx.jobs.cutdown.running && ctx.jobs.cutdown.status.id === body.id) throw httpError(409, 'That cutdown is being made');
  const list = await readPlayerOutputs(ctx.store);
  const o = list.find((x) => x.id === body.id);
  if (!o) throw httpError(404, 'No such cutdown');
  await ctx.store.remove(`outputs/${o.id}.mp4`);
  await writePlayerOutputs(ctx.store, list.filter((x) => x !== o));
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
    // export.cmd runs on this computer, in the project folder (or export.cwd, which may be outside it)
    const cwd = reel.export.cwd ? path.resolve(ctx.store.root, String(reel.export.cwd)) : ctx.store.root;
    if (!fs.existsSync(cwd)) throw new Error(`export.cwd not found: ${cwd}`);
    ctx.jobs.export.set({ line: 'Rendering…' });

    const env = { ...process.env, PROPS: propsFile, OUT: out, RAW: raw, PROJECT: ctx.store.root };
    await runTracked(ctx.jobs.export, 'sh', ['-c', reel.export.cmd], {
      cwd,
      env,
      what: 'export command',
      onOutput: (text) => {
        const pct = progressFromText(text);
        const line = lastLine(text);
        ctx.jobs.export.set({ ...(pct !== null ? { pct: clamp(pct, 0, 99) } : {}), ...(line ? { line } : {}) });
      },
    });

    if (!isFile(out)) {
      if (!isFile(raw)) throw new Error('The export command finished but wrote neither $OUT nor $RAW');
      const ff = ffmpegFor(ctx);
      if (levels.music && ff) {
        await runMix(ctx, ff, raw, levels, out, reel.duration);
      } else {
        await fsp.copyFile(raw, out);
      }
    }
    ctx.jobs.export.set({ state: 'done', pct: 100, line: `Saved ${ctx.store.rel(out)}` });
  } catch (err) {
    ctx.jobs.export.set({ state: 'error', line: err.message, out: null, rel: null });
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
    assert.deepEqual(parseProbe(probeText), { duration: 62.5, hasAudio: true, hasVideo: true, w: 1280, h: 720, fps: 30, matrix: null });
    assert.equal(parseProbe('Duration: 00:00:01.00\n  Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080, 30 fps').matrix, 'bt709', 'a tagged colour matrix');
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
      assert.equal(a[a.indexOf('-vf') + 1], 'format=rgba,scale=1280:720,setsar=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', 'converted with BT.709');
      assert.equal(a[a.indexOf('-colorspace') + 1], 'bt709', 'and tagged');
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
    // JobRunner (lib/jobs.mjs): one task at a time per lane, the status the player polls
    {
      const jr = createJobRunner({ a: { state: 'idle', pct: 0, line: '', id: null } });
      assert.deepEqual(jr.a.status, { state: 'idle', pct: 0, line: '', id: null });
      jr.a.begin({ line: 'Go', id: 'x' });
      assert.ok(jr.a.running);
      assert.deepEqual(jr.a.status, { state: 'running', pct: 0, line: 'Go', id: 'x' });
      const node = process.execPath;
      await runTracked(jr.a, node, ['-e', "process.stdout.write('out_time_us=500000\\n')"], { seconds: 1 });
      assert.equal(jr.a.status.pct, 50, 'ffmpeg -progress output becomes pct');
      await assert.rejects(runTracked(jr.a, node, ['-e', "console.error('first\\nit broke'); process.exit(3)"]), /it broke/, 'a failure says its last line');
      await assert.rejects(runTracked(jr.a, node, ['-e', 'process.exit(2)'], { what: 'thing' }), /thing exited with code 2/);
      const seen = [];
      await runTracked(jr.a, node, ['-e', "console.log('12%'); console.error('half')"], { onOutput: (t) => seen.push(t.trim()) });
      assert.deepEqual(seen.sort(), ['12%', 'half']);
      const slow = runTracked(jr.a, node, ['-e', 'setTimeout(() => {}, 30000)']);
      await new Promise((r) => setTimeout(r, 100));
      jr.stopAll();
      await assert.rejects(slow, /exited|null/, 'stopAll ends a running task');
      jr.a.set({ state: 'done', pct: 100 });
      assert.ok(!jr.a.running);
      jr.a.reset({ state: 'error', line: 'No' });
      assert.deepEqual(jr.a.status, { state: 'error', pct: 0, line: 'No', id: null });
    }
    // ProjectStore (lib/store.mjs): the local folder store the routes go through
    {
      const sd = mkTmp();
      const st = localStore(sd);
      assert.equal(await st.readText('nope.json'), null, 'a missing file reads as null');
      assert.equal(await st.readJson('nope.json'), null);
      assert.equal(st.path('../x'), null, 'paths stay inside the project');
      await assert.rejects(st.writeText('../x.txt', 'no'), /inside the project/);
      await st.writeText('a/b.json', '{"x":1}');
      assert.deepEqual(await st.readJson('a/b.json'), { x: 1 });
      fs.writeFileSync(path.join(sd, 'bad.json'), '{');
      assert.equal(await st.readJson('bad.json'), null, 'invalid JSON reads as null');
      await assert.rejects(st.writeText('a/b.json', 'again', { create: true }), (e) => e.code === 'EEXIST');
      assert.equal(fs.readdirSync(path.join(sd, 'a')).length, 1, 'no temp files left behind');
      assert.equal(await st.file('a'), null, 'a folder is not a file');
      assert.equal(await st.file('a/b.json'), path.join(sd, 'a', 'b.json'));
      assert.deepEqual((await st.stat('a')).dir, true);
      assert.deepEqual((await st.list('a')).map((e) => e.name), ['b.json']);
      assert.deepEqual(await st.list('missing'), []);
      assert.equal(st.rel(path.join(sd, 'a', 'b.json')), 'a/b.json');
      assert.equal(await st.freeName('out', 'v.mp4'), 'out/v.mp4');
      fs.writeFileSync(path.join(sd, 'out', 'v.mp4'), 'x');
      assert.equal(await st.freeName('out', 'v.mp4'), 'out/v-2.mp4', 'a taken name gets a number');
      const tmpUp = path.join(sd, 'up.part');
      fs.writeFileSync(tmpUp, 'new');
      assert.equal(await st.addFile('out', 'v.mp4', tmpUp), 'out/v-2.mp4', 'addFile never overwrites');
      assert.equal(fs.readFileSync(path.join(sd, 'out', 'v.mp4'), 'utf8'), 'x');
      assert.ok(!fs.existsSync(tmpUp), 'the temp file is moved in');
      await st.copy('out/v.mp4', 'c/copy.mp4');
      assert.equal(fs.readFileSync(path.join(sd, 'c', 'copy.mp4'), 'utf8'), 'x');
      await st.remove('c', { recursive: true });
      await st.remove('c/none.txt');
      assert.ok(!fs.existsSync(path.join(sd, 'c')));
      await st.remove('');
      assert.ok(fs.existsSync(sd), 'the project folder itself is never removed');
    }
    const pv = mkTmp();
    const pvs = localStore(pv);
    assert.equal(await pickVideo(pvs), null);
    fs.writeFileSync(path.join(pv, 'old.mp4'), 'a');
    fs.writeFileSync(path.join(pv, '.hidden.mp4'), 'a');
    fs.writeFileSync(path.join(pv, 'notes.txt'), 'a');
    fs.writeFileSync(path.join(pv, 'new.MOV'), 'a');
    fs.utimesSync(path.join(pv, 'old.mp4'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    assert.equal(await pickVideo(pvs), 'new.MOV', 'the newest playable file, no dotfiles');
    const T = 1_800_000_000_000;
    const st = (size, ago) => ({ size, mtimeMs: T - ago });
    assert.equal(await videoVersion(pvs, 'clip.mp4', st(10, 60000), T), 1);
    assert.equal(await videoVersion(pvs, 'clip.mp4', st(10, 60000), T), 1, 'same file, same version');
    assert.equal(await videoVersion(pvs, 'clip.mp4', st(12, 50000), T), 2, 'the file changed');
    assert.equal(await videoVersion(pvs, 'clip.mp4', st(14, 500), T), 2, 'still being written: wait');
    assert.equal(await videoVersion(pvs, 'clip.mp4', st(14, 40000), T), 3);
    fs.mkdirSync(path.join(pv, '.motionsnip', 'takes'), { recursive: true });
    assert.equal(await videoVersion(pvs, 'other.mp4', st(10, 60000), T), 1, 'another video starts again');
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
      // polling: an ETag, and 304 with no body while nothing changed
      const tag = r.headers.etag;
      assert.match(tag, /^"[\w-]+"$/);
      r = await req('GET', '/api/reel', { headers: { 'if-none-match': tag } });
      assert.equal(r.status, 304, 'unchanged reel: 304');
      assert.equal(r.buf.length, 0);
      assert.equal(r.headers.etag, tag);
      r = await req('GET', '/api/reel', { headers: { 'if-none-match': `"other", W/${tag}` } });
      assert.equal(r.status, 304, 'a list of tags, and weak ones, match too');
      fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({ id: 'test', title: 'Test 2', version: 1, src: 'video.mp4', duration: 1 }));
      r = await req('GET', '/api/reel', { headers: { 'if-none-match': tag } });
      assert.equal(r.status, 200, 'a changed reel comes back whole');
      assert.equal(r.json.title, 'Test 2');
      assert.notEqual(r.headers.etag, tag);
      fs.writeFileSync(path.join(dir, 'reel.json'), JSON.stringify({ id: 'test', title: 'Test', version: 1, src: 'video.mp4', duration: 1 }));

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
      // fonts are served with the player: nothing for an export to fetch from outside
      r = await req('GET', '/app/fonts/fonts.css');
      assert.equal(r.status, 200);
      const fontFiles = [...r.buf.toString().matchAll(/url\('([^']+\.woff2)'\)/g)].map((m) => m[1]);
      assert.ok(fontFiles.length >= 6, 'fonts.css names its font files');
      for (const f of new Set(fontFiles)) {
        const fr = await req('GET', `/app/fonts/${f}`);
        assert.equal(fr.status, 200, f);
        assert.equal(fr.headers['content-type'], 'font/woff2');
      }
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
    // Frames that follow motion: elements carry their box over time
    {
      const sc = await import('./app/scene/compile.mjs');
      const tm = await import('./app/comp/timeline.mjs');
      const { boxAt, normalizeReel } = await import('./app/reel.mjs');
      const scene = { title: 'M', version: 1, cast: { ana: { kind: 'person' } }, props: { box: { kit: 'box' } }, shots: [{ id: 'a', dur: 3, place: { ana: [400, 885], box: [1400, 885] }, beats: [{ at: 0.5, who: 'ana', do: 'walk', to: [1000, 885], dur: 1.5 }] }] };
      const sr = sc.toReel(scene);
      const ana = sr.scenes[0].els.find((e) => e.entity === 'ana');
      const still = sr.scenes[0].els.find((e) => e.entity === 'box');
      assert.ok(ana.moves && ana.moves.length >= 3, 'a walking person has moves');
      assert.equal(still.moves, undefined, 'a prop that stays put has none');
      const x0 = boxAt(ana, 0)[0];
      const x2 = boxAt(ana, 2.5)[0];
      assert.ok(x2 - x0 > 20, `the box walks with her (${x0} → ${x2})`);
      assert.deepEqual(boxAt(still, 1), still.box);
      assert.deepEqual(boxAt({ box: [1, 2, 3, 4], moves: [[0, 0, 0, 10, 10], [2, 20, 0, 10, 10]] }, 1), [10, 0, 10, 10], 'halfway between two points');
      assert.equal(normalizeReel({ scenes: [{ els: [{ id: 'e', box: [0, 0, 1, 1], moves: [[0, 1]] }] }] }).scenes[0].els[0].moves, undefined, 'bad moves are dropped');
      const tl = {
        tracks: [
          { id: 'g', kind: 'graphics', clips: [{ id: 'fly', type: 'text', text: 'Hi', at: 1, dur: 2, keys: { x: [[0, 0], [2, 40]] } }, { id: 'sit', type: 'text', text: 'Yo', at: 0, dur: 2 }] },
          { id: 's', kind: 'scene', clips: [{ id: 'sc', scene: 'scene.json', at: 4 }] },
        ],
      };
      const tr = tm.toReel(tl, { scenes: { 'scene.json': scene } });
      const all = tr.scenes.flatMap((s) => s.els);
      const fly = all.find((e) => e.id === 'fly');
      assert.ok(fly.moves && Math.abs(boxAt(fly, 3)[0] - boxAt(fly, 1)[0] - 40) < 0.5, 'a keyframed clip moves by its keys');
      assert.equal(all.find((e) => e.id === 'sit').moves, undefined);
      const inClip = all.find((e) => e.id === 'sc/ana@a');
      assert.ok(inClip.moves && inClip.moves[0][0] >= 4 - 0.11, 'scene moves shift to the clip on the timeline');
      assert.ok(boxAt(inClip, 6.5)[0] - boxAt(inClip, 4)[0] > 20);
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

      // composed export: what ffmpeg draws, what stops it, and the graph it gets
      {
        const CP = await import('./app/comp/compose.mjs');
        const CL = await import('./lib/compose.mjs');
        const mk = (tracks) => T.normTimeline({ size: [1920, 1080], fps: 30, tracks });
        const vid = (extra = {}) => ({ kind: 'video', clips: [{ id: 'v', src: 'a.mp4', at: 0, in: 0, out: 4, ...extra }] });
        const txt = (extra = {}) => ({ kind: 'graphics', clips: [{ id: 't', type: 'text', text: 'Hi', at: 1, dur: 2, ...extra }] });
        let p = CP.composePlan(mk([vid(), txt()]));
        assert.ok(p.ok && p.ids.has('v') && !p.ids.has('t'), 'video under text: composed');
        assert.equal(CP.composePlan(mk([txt()])).ok, false, 'no video: nothing to compose');
        assert.match(CP.composePlan(mk([txt(), vid()])).reason, /under a video/, 'text under a video: not composed');
        assert.ok(CP.composePlan(mk([txt({ at: 5 }), vid()])).ok, 'text under a video at another time: composed');
        assert.ok(CP.composePlan(mk([{ ...txt(), hide: true }, vid()])).ok, 'a hidden track is left out');
        assert.match(CP.composePlan(mk([vid({ enter: { kind: 'wipe', dur: 1 } })])).reason, /wipe/);
        assert.ok(CP.composePlan(mk([vid({ enter: { kind: 'zoom', dur: 1 }, keys: { scale: [[0, 1], [4, 1.2, 'inOut']], x: [[0, 0], [2, 10]] } })])).ok, 'zoom, scale and moves are composed');
        const blur = (extra = {}) => ({ kind: 'graphics', clips: [{ id: 'b', type: 'blur', at: 0, dur: 2, box: [10, 10, 20, 20], ...extra }] });
        p = CP.composePlan(mk([vid(), blur()]));
        assert.ok(p.ok && p.ids.has('b'), 'a blur box over video: composed');
        assert.match(CP.composePlan(mk([vid(), blur({ keys: { x: [[0, 0], [1, 5]] } })])).reason, /blur box moves/);
        assert.match(CP.composePlan(mk([vid(), txt({ at: 0 }), blur()])).reason, /under a blur box/, 'text under a blur box: not composed');
        const spec = CP.composeSpec(mk([vid({ look: { saturation: 0.5 } }), blur()]), CP.composePlan(mk([vid({ look: { saturation: 0.5 } }), blur()])));
        const n = CL.normComposeSpec(JSON.parse(JSON.stringify(spec)), (s) => `/p/${s}`);
        assert.equal(n.layers.length, 2);
        assert.equal(n.layers[0].file, '/p/a.mp4');
        assert.equal(CL.normComposeSpec(spec, () => null).layers.length, 1, 'a missing video is left out');
        assert.throws(() => CL.normComposeSpec({ layers: [{ kind: 'video', src: 'a.mp4', at: 0, dur: 1, enter: { kind: 'wipe', dur: 0.5 } }] }, (s) => s), /wipe/);
        const { args, graph } = CL.buildComposeArgs({ w: 1920, h: 1080, fps: 30, frames: 120, out: 'o.mp4', format: 'mp4', encoder: 'libx264', ...n, look: lookFilter });
        assert.ok(args.includes('pipe:0') && args.includes('/p/a.mp4'));
        assert.match(graph, /colorchannelmixer=rr=/, 'the look');
        assert.match(graph, /gblur=sigma=/, 'the blur box');
        assert.doesNotMatch(graph, /perspective/, 'a still full-frame clip needs no transform');
        assert.match(graph, /\[b2\]\[0:v\]overlay=0:0/, 'the browser layer goes on top');
        assert.equal(CL.ffColor('#abc'), '0xaabbcc');
        assert.equal(CL.ffColor('#11223344'), '0x112233');
        assert.deepEqual(CL.simplify([[0, 0], [1, 1], [2, 2], [3, 5]], 0.01), [[0, 0], [2, 2], [3, 5]]);
        assert.equal(CL.pwlExpr([[0, 2], [10, 2]]), '2');
        assert.equal(CL.pwlExpr([[0, 0], [10, 5]]), 'if(lt(in,0),0,if(lt(in,10),0+(5)*(in-0)/10,5))');
        assert.deepEqual(CL.cornersFor(100, 50, 50, 25, 0, 0, 0, 1), [0, 0, 100, 0, 0, 50, 100, 50]);
        const z = CL.cornersFor(100, 50, 50, 25, 0, 0, 0, 2);
        assert.deepEqual(z, [25, 12.5, 75, 12.5, 25, 37.5, 75, 37.5], 'scale 2 shows the middle half');
        assert.deepEqual(CL.clipFrames({ at: 1.05, end: 2.05 }, 10, 30), [11, 21]);
      }

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
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&from=0`, { body: Buffer.concat([rawFrame(0), rawFrame(80), rawFrame(160)]), headers: post });
        assert.equal(r.json.got, 3);
        // a push sent again after a failed request: frames the server has are skipped, a gap is refused
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&from=0`, { body: Buffer.concat([rawFrame(0), rawFrame(80), rawFrame(160)]), headers: post });
        assert.equal(r.json.got, 3, 'the same push twice adds nothing');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&from=2`, { body: Buffer.concat([rawFrame(160), rawFrame(200)]), headers: post });
        assert.equal(r.json.got, 4, 'an overlapping push adds only the new frame');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&from=6`, { body: rawFrame(0), headers: post });
        assert.equal(r.status, 400, 'a gap is refused');
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&repeat=2&from=4`, { body: '', headers: post });
        assert.equal(r.json.got, 6);
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${rj}&repeat=2&from=4`, { body: '', headers: post });
        assert.equal(r.json.got, 6, 'a repeat sent twice adds nothing');
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
        // composed: ffmpeg draws a video clip (fading in) under transparent frames, on the timeline's clock
        const red = await run(realFf.path, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=10:d=2', '-pix_fmt', 'yuv420p', path.join(fd, 'red.mp4')], { env });
        assert.equal(red.code, 0, 'make test clip');
        const spec = { size: [64, 36], fps: 10, bg: '#0000ff', layers: [{ kind: 'video', src: 'red.mp4', at: 1.05, dur: 1, in: 0, out: 1, enter: { kind: 'fade', dur: 0.3 } }] };
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 30, compose: spec });
        assert.equal(r.status, 400, 'composed exports take raw frames');
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 30, pix: 'rgba', compose: { ...spec, layers: [{ ...spec.layers[0], enter: { kind: 'wipe', dur: 0.3 } }] } });
        assert.equal(r.status, 400, "a wipe on a video clip isn't composed");
        assert.match(r.json.error, /wipe/);
        r = await begin({ format: 'mp4', fps: 10, w: 64, h: 36, frames: 30, pix: 'rgba', compose: spec });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.composed, true);
        const cj = r.json.job;
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${cj}`, { body: rawFrame(0), headers: post });
        r = await request(fs2.port, 'POST', `/api/frames-push?job=${cj}&repeat=29`, { body: '', headers: post });
        assert.equal(r.json.got, 30);
        r = await request(fs2.port, 'POST', `/api/frames-end?job=${cj}`, { body: '{}', headers: post });
        assert.equal(r.json.state, 'done', r.json.line);
        const px = await run(realFf.path, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', path.join(fd, r.json.rel), '-vf', 'format=rgb24,crop=2:2:30:16,scale=1:1', '-f', 'rawvideo', path.join(fd, 'px.rgb')], { env });
        assert.equal(px.code, 0, px.stderr);
        const rgb = fs.readFileSync(path.join(fd, 'px.rgb'));
        const at = (i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
        assert.equal(rgb.length, 90, 'thirty frames');
        assert.ok(at(10)[2] > 200 && at(10)[0] < 30, `before the clip: the background (${at(10)})`);
        assert.ok(at(11)[0] > 80 && at(11)[0] < 130, `the fade's first frame: about 42% (${at(11)})`);
        assert.ok(at(15)[0] > 240 && at(15)[2] < 20, `the clip (${at(15)})`);
        assert.ok(at(21)[2] > 200 && at(21)[0] < 30, `after the clip: the background again (${at(21)})`);
        assert.equal((await probe(realFf, path.join(fd, r.json.rel))).matrix, 'bt709', 'exports are tagged BT.709');
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

    // Add-ons: discovery, manifest checks, locked add-ons, a failing setup, routes and files
    {
      const { checkManifest, defaultAddonDirs, ADDON_API } = await import('./lib/addons.mjs');
      const base = mkTmp();
      const mk = (id, manifest, files = {}) => {
        const d = path.join(base, id);
        fs.mkdirSync(d, { recursive: true });
        if (manifest) fs.writeFileSync(path.join(d, 'addon.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
        for (const [f, text] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
          fs.writeFileSync(path.join(d, f), text);
        }
      };
      const ok = (id, extra = {}) => ({ id, name: id.toUpperCase(), version: '1.0.0', core: ADDON_API, ...extra });
      mk('hello', ok('hello', { server: 'server.mjs', app: 'app.js' }), {
        'server.mjs': `export default (addon) => {
          addon.route('GET', 'hi', (req, res) => addon.helpers.sendJson(res, 200, { text: 'hi from ' + addon.id, project: addon.helpers.projectDir() }));
          addon.route('POST', 'echo', async (req, res) => addon.helpers.sendJson(res, 200, await addon.helpers.readJson(req)));
        };`,
        'app.js': 'export default (host) => {};',
        '.secret': 'no',
      });
      mk('appy', ok('appy', { app: 'ui/app.js' }), { 'ui/app.js': 'export default () => {};' });
      mk('paid', ok('paid', { app: 'app.js', requires: 'pro' }), { 'app.js': 'export default () => {};' });
      mk('broken', ok('broken', { server: 'server.mjs' }), { 'server.mjs': "export default () => { throw new Error('boom'); };" });
      mk('noexport', ok('noexport', { server: 'server.mjs' }), { 'server.mjs': 'export const x = 1;' });
      mk('future', ok('future', { core: ADDON_API + 1, app: 'app.js' }), { 'app.js': '' });
      mk('badjson', '{ nope');
      mk('escape', ok('escape', { app: '../hello/app.js' }));
      mk('wrongname', ok('other', { app: 'app.js' }), { 'app.js': '' });
      mk('.hidden', ok('.hidden', { app: 'app.js' }), { 'app.js': '' });
      mk('notanaddon', null, { 'readme.txt': 'no manifest' });

      assert.equal(checkManifest(ok('x', { app: 'a.js' }), path.join(base, 'x')), 'app file not found: a.js');
      assert.match(checkManifest(ok('x'), path.join(base, 'x')), /needs a server or an app/);
      assert.match(checkManifest(ok('x', { server: 'a.txt' }), path.join(base, 'x')), /\.mjs or \.js/);
      assert.deepEqual(defaultAddonDirs({ MOTIONSNIP_ADDONS: ['/a', '/b'].join(path.delimiter) }, '/home/u'), ['/a', '/b']);
      assert.deepEqual(defaultAddonDirs({}, '/home/u'), [path.join('/home/u', '.motionsnip', 'addons')]);

      const proj = mkTmp();
      const srv = await startServer({ dir: proj, port: 0, open: false, quiet: true, addons: [base, path.join(base, 'missing')] });
      try {
        const post = { 'content-type': 'application/json', origin: `http://localhost:${srv.port}` };
        let r = await request(srv.port, 'GET', '/api/addons');
        assert.equal(r.status, 200);
        const by = Object.fromEntries(r.json.addons.map((a) => [a.id, a]));
        assert.deepEqual(Object.keys(by).sort(), ['appy', 'badjson', 'broken', 'escape', 'future', 'hello', 'noexport', 'paid', 'wrongname']);
        assert.equal(by.hello.state, 'on');
        assert.match(by.hello.app, /^\/addons\/hello\/app\.js\?t=\d+$/);
        assert.match(by.appy.app, /^\/addons\/appy\/ui\/app\.js\?t=\d+$/);
        assert.equal(by.paid.state, 'locked');
        assert.equal(by.paid.reason, 'Needs a pro licence');
        assert.equal(by.paid.app, undefined, 'a locked add-on offers no app');
        assert.equal(by.broken.state, 'error');
        assert.match(by.broken.reason, /setup failed: boom/);
        assert.match(by.noexport.reason, /no default export/);
        assert.match(by.future.reason, /add-on API/);
        assert.match(by.badjson.reason, /addon\.json/);
        assert.match(by.escape.reason, /inside the add-on folder/);
        assert.match(by.wrongname.reason, /doesn't match its folder/);

        r = await request(srv.port, 'GET', '/api/addons/hello/hi');
        assert.deepEqual(r.json, { text: 'hi from hello', project: proj });
        r = await request(srv.port, 'POST', '/api/addons/hello/echo', { body: '{"a":1}', headers: post });
        assert.deepEqual(r.json, { a: 1 });
        r = await request(srv.port, 'POST', '/api/addons/hello/echo', { body: '{"a":1}', headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
        assert.equal(r.status, 403, 'add-on routes keep the origin check');
        r = await request(srv.port, 'POST', '/api/addons/hello/hi', { body: '{}', headers: post });
        assert.equal(r.status, 404, 'method must match');
        assert.equal((await request(srv.port, 'GET', '/api/addons/broken/x')).status, 404);
        assert.equal((await request(srv.port, 'GET', '/api/addons/nobody/x')).status, 404);

        r = await request(srv.port, 'GET', '/addons/hello/app.js');
        assert.equal(r.status, 200);
        assert.match(r.headers['content-type'], /javascript/);
        assert.equal((await request(srv.port, 'GET', '/addons/hello/.secret')).status, 403);
        assert.equal((await request(srv.port, 'GET', '/addons/hello/..%2fpaid%2fapp.js')).status, 403);
        assert.equal((await request(srv.port, 'GET', '/addons/paid/app.js')).status, 404, "a locked add-on's files aren't served");
        assert.equal((await request(srv.port, 'GET', '/addons/broken/server.mjs')).status, 404);
      } finally {
        await srv.close();
      }
      // no add-on folders given: none loaded
      const bare = await startServer({ dir: mkTmp(), port: 0, open: false, quiet: true });
      assert.deepEqual((await request(bare.port, 'GET', '/api/addons')).json, { addons: [] });
      await bare.close();
    }

    // Pro: the signed licence, the tar reader, and activate / install / refresh / deactivate against a fake
    // licence server
    {
      const L = await import('./lib/licence.mjs');
      const { readTar, writeTar, safeEntryPath } = await import('./lib/tar.mjs');
      const { packageSigText } = await import('./lib/pro.mjs');
      const { spawnSync } = await import('node:child_process');
      const { ADDON_API } = await import('./lib/addons.mjs');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const keys = { t1: publicKey.export({ format: 'jwk' }).x };
      const signText = (text) => crypto.sign(null, Buffer.from(text), privateKey).toString('base64url');
      const sign = (claims, kid = 't1') => ({ v: 1, kid, claims, sig: signText(L.canonical(claims)) });
      const DAY = 86400e3;
      const iso = (ms) => new Date(ms).toISOString();
      const now = Date.parse('2026-12-01T00:00:00Z');
      const inst = L.hashInstall('abc');
      const claims = (o = {}) => ({ sub: 'k1', act: 'a1', plan: 'pro', features: ['pro'], install: inst, issued: iso(now - DAY), expires: iso(now + 30 * DAY), updates_until: iso(now), ...o });
      const v = (lic, o = {}) => L.verifyLicence(lic, { keys, now, install: inst, ...o });

      assert.equal(L.canonical({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"c":null,"d":2}],"b":1}');
      assert.equal(v(null).state, 'none');
      assert.equal(v(sign(claims())).state, 'valid');
      assert.equal(v(sign(claims({ expires: iso(now + 5 * DAY) }))).state, 'grace', 'within 14 days of the end: grace');
      assert.equal(v(sign(claims({ expires: null }))).state, 'valid', 'a lifetime licence');
      assert.equal(v(sign(claims({ expires: null }))).periodEnd, null);
      const lapsed = v(sign(claims({ expires: iso(now - DAY), updates_until: iso(now - 30 * DAY) })));
      assert.equal(lapsed.state, 'fallback');
      assert.ok(L.holds(lapsed, 'pro', { released: iso(now - 40 * DAY) }), 'a version released while paid keeps working');
      assert.ok(!L.holds(lapsed, 'pro', { released: iso(now - 10 * DAY) }), 'a version released after it lapsed does not');
      assert.ok(!L.holds(lapsed, 'pro'), 'no release date: no fallback');
      assert.equal(v(sign(claims({ expires: iso(now - DAY), updates_until: null }))).state, 'expired');
      const forged = sign(claims());
      forged.claims.features = ['pro', 'team'];
      assert.equal(v(forged).state, 'invalid', 'a changed claim breaks the signature');
      assert.equal(v({ ...sign(claims()), kid: 'nope' }).state, 'invalid');
      assert.equal(v(sign(claims()), { install: L.hashInstall('other') }).reason, 'This licence was activated on another computer');
      assert.equal(v({ v: 2 }).state, 'invalid');
      const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
      assert.equal(v({ v: 1, kid: 't1', claims: claims(), sig: crypto.sign(null, Buffer.from(L.canonical(claims())), otherKey).toString('base64url') }).state, 'invalid', 'signed by someone else');
      assert.ok(L.holds(v(sign(claims())), 'pro') && !L.holds(v(sign(claims())), 'team'));

      // install id: made once, kept
      const home0 = mkTmp();
      assert.equal(await L.installId(home0, { create: false }), null);
      const id1 = await L.installId(home0);
      assert.equal(await L.installId(home0), id1);
      assert.equal(fs.statSync(path.join(home0, 'install-id')).mode & 0o077, 0, 'install-id is private');

      // tar: round trip, readable by the system tar, and unsafe entries refused
      const tarBuf = writeTar([{ path: 'pkg/', data: null }, { path: 'pkg/a.txt', data: 'hello' }, { path: `pkg/${'d'.repeat(90)}/${'f'.repeat(60)}.js`, data: Buffer.alloc(700, 1) }]);
      const back = readTar(tarBuf);
      assert.deepEqual(back.map((e) => e.path), ['pkg', 'pkg/a.txt', `pkg/${'d'.repeat(90)}/${'f'.repeat(60)}.js`]);
      assert.equal(back[1].data.toString(), 'hello');
      assert.equal(back[2].data.length, 700);
      const sysTar = spawnSync('tar', ['-tf', '-'], { input: tarBuf });
      if (sysTar.status === 0) assert.match(sysTar.stdout.toString(), /pkg\/a\.txt/);
      const patch = (buf, at, text) => {
        const b = Buffer.from(buf);
        b.write(text, at);
        b.fill(32, 148, 156);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += b[i];
        b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
        return b;
      };
      const one = writeTar([{ path: 'xx/evil', data: 'x' }]);
      assert.throws(() => readTar(patch(one, 0, '../evil')), /unsafe path/);
      assert.throws(() => readTar(patch(one, 0, '/x/evil')), /unsafe path/);
      assert.throws(() => readTar(patch(one, 156, '2')), /only files and folders/, 'links are refused');
      const broken = Buffer.from(one);
      broken[10] ^= 1;
      assert.throws(() => readTar(broken), /checksum/);
      assert.ok(safeEntryPath('a/b.js') && !safeEntryPath('a/../b') && !safeEntryPath('a\\b') && !safeEntryPath('C:/x'));

      // a fake licence server
      const pkgFiles = (version, released) =>
        writeTar([
          { path: 'addon.json', data: JSON.stringify({ id: 'pro', name: 'MotionSnip Pro', version, core: ADDON_API, app: 'app.js', requires: 'pro', released, provides: { presets: ['ui.terminal'] } }) },
          { path: 'app.js', data: 'export default () => {};' },
        ]);
      const fake = { pkg: pkgFiles('0.1.0', '2026-11-01'), refreshes: 0, badPackage: false, licenceFor: null };
      const fakeSrv = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
        const send = (status, data) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        const t = Date.now();
        const issue = (install) => sign(fake.licenceFor ? fake.licenceFor(install) : { sub: 'k1', act: 'a1', plan: 'pro', features: ['pro'], install, issued: iso(t), expires: iso(t + 44 * DAY), updates_until: iso(t) });
        if (req.url === '/activate') {
          if (body.key === 'REVOKED-KEY-0000') return send(403, { error: 'This licence key was revoked' });
          return send(200, { licence: issue(body.install) });
        }
        if (req.url === '/refresh') {
          fake.refreshes++;
          return send(200, { licence: issue(body.licence.claims.install) });
        }
        if (req.url === '/deactivate') return send(200, { ok: true });
        if (req.url === '/download') {
          const sha = crypto.createHash('sha256').update(fake.pkg).digest('hex');
          const version = JSON.parse(readTar(fake.pkg).find((e) => e.path === 'addon.json').data).version;
          // badPackage: the bytes don't match the (signed) hash, as when a download is cut or changed on the way
          const told = fake.badPackage ? sha.replace(/^./, (c) => (c === '0' ? '1' : '0')) : sha;
          return send(200, { version, sha256: told, kid: 't1', sig: signText(packageSigText('pro', version, told)), url: '/pkg' });
        }
        if (req.url === '/pkg') {
          res.writeHead(200, { 'content-type': 'application/x-tar' });
          return res.end(fake.pkg);
        }
        send(404, { error: 'no' });
      });
      await new Promise((r) => fakeSrv.listen(0, '127.0.0.1', r));
      const fakeUrl = `http://127.0.0.1:${fakeSrv.address().port}`;

      const home = mkTmp();
      const addonsDir = path.join(home, 'addons');
      const srv = await startServer({ dir: mkTmp(), port: 0, open: false, quiet: true, home, licenceKeys: keys, licenceServer: fakeUrl, addons: [addonsDir] });
      try {
        const post = (route, json = {}, origin = `http://localhost:${srv.port}`) => request(srv.port, 'POST', `/api/licence${route}`, { body: JSON.stringify(json), headers: { 'content-type': 'application/json', origin } });
        let r = await request(srv.port, 'GET', '/api/licence');
        assert.equal(r.json.state, 'none');
        assert.equal(r.json.addon, null);
        assert.equal((await post('/activate', { key: 'nope' })).status, 400);
        assert.equal((await post('/activate', { key: 'GOOD-KEY-1234' }, 'http://evil.example')).status, 403);
        r = await post('/activate', { key: 'REVOKED-KEY-0000' });
        assert.equal(r.status, 400);
        assert.equal(r.json.error, 'This licence key was revoked');
        assert.equal((await post('/install')).status, 409, 'install needs a licence');
        r = await post('/activate', { key: 'GOOD-KEY-1234' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.state, 'valid');
        for (const k of ['key', 'sub', 'act', 'sig', 'claims', 'install']) assert.ok(!(k in r.json), `the player never sees ${k}`);
        assert.equal(fs.statSync(path.join(home, 'licence.json')).mode & 0o077, 0, 'licence.json is private');

        r = await post('/install');
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual(r.json.addon, { state: 'on', version: '0.1.0', reason: '' });
        let list = (await request(srv.port, 'GET', '/api/addons')).json.addons;
        assert.deepEqual(list.find((a) => a.id === 'pro').presets, ['ui.terminal']);

        // an update replaces it; a damaged download leaves the installed one alone
        fake.pkg = pkgFiles('0.2.0', '2026-11-20');
        assert.equal((await post('/install')).json.addon.version, '0.2.0');
        fake.pkg = pkgFiles('0.3.0', '2026-11-25');
        fake.badPackage = true;
        r = await post('/install');
        assert.equal(r.status, 502);
        assert.match(r.json.error, /didn't arrive whole/);
        fake.badPackage = false;
        assert.equal((await request(srv.port, 'GET', '/api/licence')).json.addon.version, '0.2.0');
        assert.deepEqual(fs.readdirSync(addonsDir), ['pro'], 'no staging folders left');

        // lapsed: versions released while paid keep working; later ones lock
        const hashHere = JSON.parse(fs.readFileSync(path.join(home, 'licence.json'), 'utf8')).claims.install;
        const t = Date.now();
        await L.writeLicence(home, sign(claims({ install: hashHere, expires: iso(t - DAY), updates_until: '2026-11-22T00:00:00Z' })));
        await srv.ctx.loadAddons();
        r = await request(srv.port, 'GET', '/api/licence');
        assert.equal(r.json.state, 'fallback');
        assert.equal(r.json.addon.state, 'on', '0.2.0 (released 2026-11-20) was released while paid');
        await L.writeLicence(home, sign(claims({ install: hashHere, expires: iso(t - DAY), updates_until: '2026-11-10T00:00:00Z' })));
        await srv.ctx.loadAddons();
        assert.equal((await request(srv.port, 'GET', '/api/licence')).json.addon.state, 'locked');

        // refresh: by hand, and quietly at start when it ends within 7 days
        r = await post('/refresh');
        assert.equal(r.json.state, 'valid');
        assert.equal(r.json.addon.state, 'on');
        await L.writeLicence(home, sign(claims({ install: hashHere, expires: iso(t + 3 * DAY) })));
        const before = fake.refreshes;
        const again = await startServer({ dir: mkTmp(), port: 0, open: false, quiet: true, home, licenceKeys: keys, licenceServer: fakeUrl, addons: [addonsDir] });
        for (let i = 0; i < 50 && fake.refreshes === before; i++) await new Promise((res) => setTimeout(res, 20));
        await again.close();
        assert.equal(fake.refreshes, before + 1, 'a licence ending soon is refreshed at start');

        // deactivate: the licence goes, Pro locks
        r = await post('/deactivate');
        assert.equal(r.json.state, 'none');
        assert.equal(r.json.addon.state, 'locked');
        assert.ok(!fs.existsSync(path.join(home, 'licence.json')));
      } finally {
        await srv.close();
      }
      // the licence server can't be reached: a short message
      const off = await startServer({ dir: mkTmp(), port: 0, open: false, quiet: true, home: mkTmp(), licenceKeys: keys, licenceServer: 'http://127.0.0.1:9' });
      const offR = await request(off.port, 'POST', '/api/licence/activate', { body: '{"key":"GOOD-KEY-1234"}', headers: { 'content-type': 'application/json', origin: `http://localhost:${off.port}` } });
      assert.equal(offR.status, 503);
      assert.match(offR.json.error, /Couldn't reach the licence server/);
      await off.close();
      await new Promise((r) => fakeSrv.close(r));
      // no home (how the selftest's other servers run): no licence routes
      const noPro = await startServer({ dir: mkTmp(), port: 0, open: false, quiet: true });
      assert.equal((await request(noPro.port, 'GET', '/api/licence')).status, 404);
      await noPro.close();
    }

    // Safe mode: export.cmd and a live.js script are left out of the reel, and a render export is refused
    {
      assert.deepEqual(withoutProjectCode({ id: 'a', live: { type: 'scene', spec: 'scene.json' } }), { id: 'a', live: { type: 'scene', spec: 'scene.json' } }, "MotionSnip's own renderers stay");
      assert.deepEqual(withoutProjectCode({ id: 'a', export: { cmd: 'make', cwd: '..', props: { x: 1 } } }), { id: 'a', export: { props: { x: 1 } }, codeOff: ['export.cmd'] });
      assert.deepEqual(withoutProjectCode({ id: 'a', export: { cmd: '  ' } }), { id: 'a', export: { cmd: '  ' } });
      const sdir = mkTmp();
      fs.writeFileSync(path.join(sdir, 'video.mp4'), Buffer.alloc(64));
      fs.writeFileSync(path.join(sdir, 'live.js'), 'window.MotionSnipLive = () => ({});');
      fs.writeFileSync(path.join(sdir, 'reel.json'), JSON.stringify({ id: 'safe', version: 1, src: 'video.mp4', duration: 1, live: 'live.js', export: { cmd: 'touch ran.txt' } }));
      const post = (port) => ({ 'content-type': 'application/json', origin: `http://localhost:${port}` });
      const safe = await startServer({ dir: sdir, port: 0, open: false, quiet: true, projectCode: false });
      try {
        let r = await request(safe.port, 'GET', '/api/reel');
        assert.equal(r.json.live, undefined);
        assert.equal(r.json.export, undefined);
        assert.deepEqual(r.json.codeOff, ['export.cmd', 'live']);
        r = await request(safe.port, 'POST', '/api/export', { body: JSON.stringify({ mode: 'render' }), headers: post(safe.port) });
        assert.equal(r.status, 403);
        assert.match(r.json.error, /safe mode/);
        assert.ok(!fs.existsSync(path.join(sdir, 'ran.txt')));
      } finally {
        await safe.close();
      }
      const normal = await startServer({ dir: sdir, port: 0, open: false, quiet: true });
      try {
        const r = await request(normal.port, 'GET', '/api/reel');
        assert.equal(r.json.live, 'live.js');
        assert.equal(r.json.export.cmd, 'touch ran.txt');
        assert.equal(r.json.codeOff, undefined);
      } finally {
        await normal.close();
      }
    }

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
  const opts = { dir: null, port: DEFAULT_PORT, open: true, ffmpeg: null, selftest: false, addons: null, safe: false, activate: null, installPro: false, deactivate: false, licence: false };
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
    else if (a === '--addons' || a.startsWith('--addons=')) (opts.addons ||= []).push(value());
    else if (a === '--no-addons') opts.addons = [];
    else if (a === '--safe') opts.safe = true;
    else if (a === '--activate' || a.startsWith('--activate=')) opts.activate = value();
    else if (a === '--install-pro') opts.installPro = true;
    else if (a === '--deactivate') opts.deactivate = true;
    else if (a === '--licence' || a === '--license') opts.licence = true;
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
      'Usage: node player/server.mjs <project-dir | video-file> [--port 4321] [--no-open] [--ffmpeg /path/to/ffmpeg]\n                              [--addons <dir>]… [--no-addons] [--safe]\n       node player/server.mjs --activate <key> | --install-pro | --deactivate | --licence\n       node player/server.mjs --selftest\n\nAdd-ons load from ~/.motionsnip/addons (or MOTIONSNIP_ADDONS, or each --addons dir).\n--safe: never run code from the project folder (reel.json export.cmd, a live.js renderer).',
    );
    return;
  }
  if (opts.selftest) process.exit(await selftest());
  if (opts.activate || opts.installPro || opts.deactivate || opts.licence) process.exit(await licenceCli(opts));

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
    const found = await pickVideo(localStore(dir));
    if (found) console.log(`No reel.json in ${dir}: opening ${found} as a plain video.`);
    else console.warn(`Note: no reel.json or video in ${dir} yet. The player will wait for one.`);
  }
  if (opts.ffmpeg && !isExecutable(opts.ffmpeg)) console.warn(`Note: --ffmpeg ${opts.ffmpeg} is not an executable file.`);

  if (opts.safe) console.log("Safe mode: the project's export.cmd and live.js won't run.");
  const app = await startServer({ dir, video, port: opts.port, open: opts.open, ffmpeg: opts.ffmpeg, addons: opts.addons ?? defaultAddonDirs(), projectCode: !opts.safe, home: motionsnipHome() });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** --activate <key>, --install-pro, --deactivate, --licence: manage Pro from the command line. */
async function licenceCli(opts) {
  const pro = await createPro({ home: motionsnipHome() });
  const say = (st) => {
    const until = st.expires === null ? 'never ends' : st.expires ? `paid until ${st.periodEnd.slice(0, 10)}, works offline until ${st.expires.slice(0, 10)}` : '';
    console.log(`Pro licence: ${st.state}${st.reason ? ` (${st.reason})` : ''}${until ? `; ${until}` : ''}`);
  };
  try {
    if (opts.activate) say(await pro.activate(opts.activate));
    if (opts.installPro || opts.activate) {
      const { version } = await pro.install();
      console.log(`Pro add-on ${version} installed in ${path.join(pro.addonsDir, PRO_ID)}`);
    }
    if (opts.deactivate) {
      await pro.deactivate();
      console.log('Pro deactivated on this computer; the licence key can be used on another one.');
    }
    if (opts.licence) say(pro.status());
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

// Run only when started directly (not when imported).
const entry = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
