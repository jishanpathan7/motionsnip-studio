#!/usr/bin/env node
// Render benchmark: how much CPU a minute of exported video costs, for each way MotionSnip exports.
//
//   node player/bench/render.mjs [--cases scene,timeline,plain] [--size 1080] [--fps 30] [--format mp4]
//                                [--seconds 60] [--runs 1] [--chrome /path/to/chrome] [--no-gpu] [--json out.json]
//
// Cases:
//   scene     examples/scene-demo, drawn frame by frame in headless Chrome (SVG → pixels) and encoded by ffmpeg
//   timeline  examples/timeline-demo: video, a scene clip, graphics and music, composited in headless Chrome
//   plain     a generated --seconds long 1080p video with a cut and a colour look, exported by ffmpeg alone
//
// Each case gets its own server and its own Chrome, both run under /usr/bin/time, so the CPU of the
// processes they start and wait for (ffmpeg, Chrome's helpers) is counted too. Chrome's share is measured
// over the export alone (its process tree, before and after); the server's share includes ffmpeg.
// Zero dependencies: Chrome is driven over the DevTools protocol with Node's own WebSocket (Node 22+).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'player/server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { cases: ['scene', 'timeline', 'plain'], size: '1080', fps: 30, format: 'mp4', seconds: 60, runs: 1, chrome: null, gpu: true, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--cases') o.cases = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--size') o.size = v();
    else if (a === '--fps') o.fps = Number(v());
    else if (a === '--format') o.format = v();
    else if (a === '--seconds') o.seconds = Number(v());
    else if (a === '--runs') o.runs = Math.max(1, Number(v()) || 1);
    else if (a === '--chrome') o.chrome = v();
    else if (a === '--no-gpu') o.gpu = false;
    else if (a === '--json') o.json = v();
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

function findChrome(given) {
  const list = [
    given,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = list.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome or Chromium found. Pass --chrome /path/to/chrome or set CHROME_PATH.');
  return found;
}

const which = (cmd) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
};

/** Run a command under /usr/bin/time -p. Resolves (at exit) to { code, real, user, sys, stderr }. */
function timed(cmd, args, opts = {}) {
  const child = spawn('/usr/bin/time', ['-p', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let err = '';
  let out = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', (d) => (out += d));
  const done = new Promise((resolve) => {
    child.on('exit', (code) => {
      const num = (k) => Number((new RegExp(`^${k}\\s+([\\d.]+)`, 'm').exec(err) || [])[1] || NaN);
      resolve({ code, real: num('real'), user: num('user'), sys: num('sys'), stderr: err, stdout: out });
    });
  });
  return { child, done, out: () => out, err: () => err };
}

/** CPU seconds used so far by a process and all its live descendants (from ps). */
function treeCpu(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, ppid, t]) => ({ pid: +pid, ppid: +ppid, s: cpuTime(t) }));
  const kids = new Map();
  for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
  let total = 0;
  const stack = rows.filter((r) => r.pid === rootPid);
  while (stack.length) {
    const r = stack.pop();
    total += r.s;
    stack.push(...(kids.get(r.pid) || []));
  }
  return total;
}

// ps time: [[dd-]hh:]mm:ss[.cc]
function cpuTime(t) {
  let days = 0;
  if (t.includes('-')) [days, t] = [Number(t.split('-')[0]), t.split('-')[1]];
  const parts = t.split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return days * 86400 + s;
}

function freePort() {
  return 4700 + Math.floor(Math.random() * 800);
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function startServer(target) {
  const port = freePort();
  const srv = timed(process.execPath, [SERVER, target, '--port', String(port), '--no-open']);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/reel`)).ok, 20000, 'the server');
  return { port, srv, url: `http://127.0.0.1:${port}/` };
}

// /usr/bin/time ignores SIGINT while it waits, so stop the server it runs, then collect time's report
async function stopServer(s) {
  const kids = execFileSync('pgrep', ['-P', String(s.srv.child.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const pid of kids) process.kill(Number(pid), 'SIGINT');
  return s.srv.done;
}

// ---- a minimal DevTools-protocol client -------------------------------------------------------

async function startChrome(bin, gpu) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msbench-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,1000',
    ...(gpu ? [] : ['--disable-gpu']),
    'about:blank',
  ];
  const ch = timed(bin, args);
  const portFile = path.join(dir, 'DevToolsActivePort');
  const port = await waitFor(() => fs.existsSync(portFile) && Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]), 20000, 'Chrome to start');
  const pages = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page'), 10000, 'a Chrome page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('DevTools connection failed'));
  });
  let id = 0;
  const waiting = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  /** Evaluate an expression in the page; resolves to its (JSON) value. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return {
    pid: ch.child.pid,
    send,
    evaluate,
    logs,
    async close() {
      try {
        await send('Browser.close');
      } catch {}
      ws.close();
      const r = await ch.done;
      fs.rmSync(dir, { recursive: true, force: true });
      return r;
    },
  };
}

// ---- driving the export dialog ------------------------------------------------------------------

// In the page: open Export, pick format / size / fps, start it, and wait for the result.
const DRIVE = (opt) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = () => [...document.querySelectorAll('button')].find((b) => b.querySelector('.btn-label') && /^Export/.test(b.querySelector('.btn-label').textContent));
  const dlg = () => document.querySelector('dialog.export-dialog');
  // the dialog offers format/size/fps only once the live renderer is up: reopen until it does
  let form = null;
  for (let i = 0; i < 120 && !form; i++) {
    if (dlg()?.open) dlg().close();
    btn()?.click();
    await sleep(250);
    form = dlg()?.querySelector('.export-form');
  }
  if (!form) return { error: 'The export dialog never offered a frame export' };
  const pick = (label, value) => {
    const f = [...form.querySelectorAll('label.field')].find((l) => l.textContent.trim().startsWith(label));
    const s = f?.querySelector('select');
    if (!s) return false;
    const ok = [...s.options].filter((o) => !o.disabled);
    // a size equal to the project's own is listed once, as "W×H (project)"
    const hit = ok.find((o) => o.value === value) || (label === 'Size' ? ok.find((o) => new RegExp('×' + value + '\\\\b|\\\\b' + value + '×').test(o.textContent)) : null);
    if (!hit) return false;
    s.value = hit.value;
    s.dispatchEvent(new Event('change'));
    return true;
  };
  await sleep(300);
  form = dlg().querySelector('.export-form');
  if (!pick('Format', ${JSON.stringify(opt.format)})) return { error: 'Format not available: ${opt.format}' };
  form = dlg().querySelector('.export-form');
  if (!pick('Size', ${JSON.stringify(opt.size)})) return { error: 'Size not available: ${opt.size}' };
  form = dlg().querySelector('.export-form');
  pick('Frame rate', ${JSON.stringify(String(opt.fps))});
  const what = dlg().querySelector('.export-what')?.textContent || '';
  const go = dlg().querySelector('.dialog-foot .btn-primary');
  if (!go || go.disabled) return { error: 'Export button disabled', what };
  const t0 = performance.now();
  go.click();
  for (;;) {
    await sleep(100);
    const done = dlg().querySelector('.done');
    const bad = dlg().querySelector('.warn-bad');
    if (done) return { ok: true, ms: performance.now() - t0, saved: done.textContent, what };
    if (bad) return { error: bad.textContent, ms: performance.now() - t0, what };
    if (performance.now() - t0 > 30 * 60e3) return { error: 'Export took over 30 minutes' };
  }
})()`;

function probeDuration(file) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
  } catch {
    return NaN;
  }
}

function newestExport(dir) {
  const ex = path.join(dir, 'exports');
  if (!fs.existsSync(ex)) return null;
  const files = fs
    .readdirSync(ex)
    .filter((f) => /\.(mp4|mov|webm|gif)$/.test(f) && !f.includes('.picture.'))
    .map((f) => path.join(ex, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function frameCase(name, example, o, chromeBin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `msbench-${name}-`));
  fs.cpSync(path.join(ROOT, 'examples', example), dir, { recursive: true });
  const s = await startServer(dir);
  const chrome = await startChrome(chromeBin, o.gpu);
  let res;
  try {
    await chrome.send('Page.navigate', { url: s.url });
    await waitFor(() => chrome.evaluate('document.readyState === "complete"'), 20000, 'the page to load');
    await sleep(1500);
    const c0 = treeCpu(chrome.pid);
    const s0 = treeCpu(s.srv.child.pid);
    const r = await chrome.evaluate(DRIVE(o));
    const c1 = treeCpu(chrome.pid);
    if (!r?.ok) throw new Error(`${name}: ${r?.error || 'export failed'}${chrome.logs.length ? `\n  ${chrome.logs.slice(-5).join('\n  ')}` : ''}`);
    res = { wall: r.ms / 1000, chromeCpu: c1 - c0, serverBefore: s0, what: r.what };
  } finally {
    await chrome.close();
  }
  const t = await stopServer(s);
  const file = newestExport(dir);
  const out = file ? probeDuration(file) : NaN;
  // /usr/bin/time counts the server and the ffmpeg runs it waited for; take off what it used before the export
  const serverCpu = t.user + t.sys - res.serverBefore;
  fs.rmSync(dir, { recursive: true, force: true });
  return { name, what: res.what, outSeconds: out, wall: res.wall, cpu: { chrome: res.chromeCpu, serverFfmpeg: serverCpu } };
}

async function plainCase(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msbench-plain-'));
  const src = path.join(dir, 'clip.mp4');
  const D = o.seconds;
  // a busy 1080p30 picture with sound, so the encoder has real work
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${D}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${D}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const s = await startServer(src);
  const base = `http://127.0.0.1:${s.port}`;
  const post = { method: 'POST', headers: { 'content-type': 'application/json', origin: base } };
  const s0 = treeCpu(s.srv.child.pid);
  const t0 = Date.now();
  const edit = { cuts: [[D * 0.25, D * 0.35]], look: { contrast: 0.2, saturation: 0.1 } };
  let job = await (await fetch(`${base}/api/export`, { ...post, body: JSON.stringify({ mode: 'edit', edit, musicVol: 1, sfxVol: 1 }) })).json();
  while (job.state === 'running') {
    await sleep(200);
    job = await (await fetch(`${base}/api/export`)).json();
  }
  const wall = (Date.now() - t0) / 1000;
  if (job.state !== 'done') throw new Error(`plain: ${job.line || job.error || 'export failed'}`);
  const t = await stopServer(s);
  const out = probeDuration(job.out);
  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'plain', what: `a ${D} s 1080p30 video, one cut and a colour look, re-encoded by ffmpeg`, outSeconds: out, wall, cpu: { chrome: 0, serverFfmpeg: t.user + t.sys - s0 } };
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '?');

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!which('ffmpeg') || !which('ffprobe')) throw new Error('ffmpeg and ffprobe must be on PATH');
  if (!fs.existsSync('/usr/bin/time')) throw new Error('/usr/bin/time is needed to count CPU time');
  const needsChrome = o.cases.some((c) => c !== 'plain');
  const chromeBin = needsChrome ? findChrome(o.chrome) : null;
  const machine = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, platform: `${os.platform()} ${os.release()}`, node: process.version, ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0], chrome: chromeBin, gpu: o.gpu };
  console.log(`MotionSnip render benchmark · ${machine.cpu} (${machine.cores} cores) · ${o.format} ${o.size} ${o.fps} fps · GPU ${o.gpu ? 'on' : 'off'}`);
  const results = [];
  for (const c of o.cases) {
    for (let run = 1; run <= o.runs; run++) {
      process.stdout.write(`  ${c}${o.runs > 1 ? ` #${run}` : ''}… `);
      const r = c === 'scene' ? await frameCase('scene', 'scene-demo', o, chromeBin) : c === 'timeline' ? await frameCase('timeline', 'timeline-demo', o, chromeBin) : c === 'plain' ? await plainCase(o) : null;
      if (!r) throw new Error(`Unknown case ${c}`);
      const cpu = r.cpu.chrome + r.cpu.serverFfmpeg;
      r.cpuTotal = cpu;
      r.cpuSecondsPerOutputMinute = (cpu / r.outSeconds) * 60;
      r.realtime = r.outSeconds / r.wall;
      results.push(r);
      console.log(`${f1(r.outSeconds)} s of video in ${f1(r.wall)} s (${f1(r.realtime)}× realtime) · CPU ${f1(cpu)} s (Chrome ${f1(r.cpu.chrome)}, server+ffmpeg ${f1(r.cpu.serverFfmpeg)}) · ${f1(r.cpuSecondsPerOutputMinute / 60)} CPU-min per output minute`);
    }
  }
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ date: new Date().toISOString(), machine, options: o, results }, null, 2));
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
