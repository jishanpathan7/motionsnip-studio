// Export: a dialog that says what you'll get, starts the job, shows progress, offers Show in Finder.

import { store, bus, masterAudio as effectiveAudio, approvedCount, assetName, findChange } from './state.js';
import { api, h, icon, projectUrl, round, toast } from './util.js';
import { hasEdits, summary as editSummary, exportEdit } from './vedit.js';
import { player } from './video.js';
import { exportFrames } from './comp/raster.js';

const ex = { dlg: null, body: null, job: null, poll: 0, btn: null, mode: 'mix', ffmpeg: null, formats: null, opt: { format: 'mp4', size: 'native', fps: 0 }, abort: null };

// a project the player draws itself (a scene, a timeline): export by drawing every frame
const drawsItself = () => !!(store.reel && !store.reel.derived && player.live && (typeof player.live.renderFrame === 'function' || typeof player.live.frameAt === 'function'));

/** Output sizes for a frame export, keeping the project's shape. */
function sizes() {
  const W = store.reel.w;
  const H = store.reel.h;
  const fit = (short) => {
    const k = short / Math.min(W, H);
    return [Math.round((W * k) / 2) * 2, Math.round((H * k) / 2) * 2];
  };
  return [
    { id: 'native', label: `${W}×${H} (project)`, wh: [W, H] },
    { id: '720', label: '720p', wh: fit(720) },
    { id: '1080', label: '1080p', wh: fit(1080) },
    { id: '2160', label: '4K', wh: fit(2160) },
  ].filter((s, i, a) => a.findIndex((x) => x.wh[0] === s.wh[0] && x.wh[1] === s.wh[1]) === i);
}

export function initExport(button) {
  ex.btn = button;
  ex.dlg = h('dialog.dialog.export-dialog', { 'aria-labelledby': 'export-title' });
  ex.body = h('div.dialog-body');
  ex.dlg.append(ex.body);
  ex.dlg.addEventListener('click', (e) => {
    if (e.target === ex.dlg) ex.dlg.close();
  });
  document.body.append(ex.dlg);
  button.addEventListener('click', open);
  bus.on('changes', updateButton);
  bus.on('status', updateButton);
  bus.on('reel', updateButton);
  bus.on('vedit', updateButton);
  // pick up a job that was already running (e.g. after a reload)
  api('/api/export')
    .then((j) => {
      if (j && j.state === 'running' && j.mode !== 'frames') {
        ex.job = j;
        startPolling();
      }
    })
    .catch(() => {});
}

const audioChanged = () => store.data.changes.some((c) => c.kind === 'audio');
const needsClaude = () => store.data.changes.filter((c) => ['prop', 'box', 'brand', 'font', 'note'].includes(c.kind));
const canRender = () => !!store.reel.export?.cmd;

export function exportLabel() {
  if (!store.reel) return 'Export';
  if (ex.job?.state === 'running') return `Exporting ${Math.round(ex.job.pct || 0)}%`;
  const all = store.reel.scenes.length && approvedCount() === store.reel.scenes.length;
  if (hasEdits()) return 'Export with your edits';
  if (findChange('audio:music')) return 'Export with new music';
  if (audioChanged()) return 'Export with new levels';
  if (all) return 'Export final';
  return 'Export';
}

export function updateButton() {
  if (!ex.btn) return;
  const label = ex.btn.querySelector('.btn-label');
  if (label) label.textContent = exportLabel();
  ex.btn.classList.toggle('is-running', ex.job?.state === 'running');
}

async function open() {
  ex.mode = drawsItself() ? 'frames' : hasEdits() ? 'edit' : canRender() && needsClaude().length ? 'render' : 'mix';
  render();
  if (!ex.dlg.open) ex.dlg.showModal();
  try {
    ex.ffmpeg = await api('/api/ffmpeg');
    if (ex.mode === 'frames') ex.formats = (await api('/api/formats')).formats;
  } catch {
    ex.ffmpeg = null;
  }
  render();
}

/** The format, size and frame-rate pickers of a frame export. */
function framesForm(running) {
  const sel = (label, key, options) =>
    h(
      'label.field',
      h('span.small.muted', label),
      h(
        'select.input',
        {
          disabled: running,
          onchange: (e) => {
            ex.opt[key] = key === 'fps' ? Number(e.target.value) : e.target.value;
            render();
          },
        },
        ...options.map(([v, text, off]) => h('option', { value: String(v), selected: String(ex.opt[key]) === String(v), disabled: !!off }, text)),
      ),
    );
  const fmts = ex.formats || [{ id: 'mp4', label: 'MP4 (H.264)', ok: true }];
  if (!fmts.some((f) => f.id === ex.opt.format && f.ok)) ex.opt.format = (fmts.find((f) => f.ok) || fmts[0]).id;
  if (!ex.opt.fps) ex.opt.fps = store.reel.fps || 30;
  return h(
    'div.export-form',
    sel('Format', 'format', fmts.map((f) => [f.id, f.ok ? f.label : `${f.label} (this ffmpeg can't)`, !f.ok])),
    sel('Size', 'size', sizes().map((x) => [x.id, x.label])),
    sel('Frame rate', 'fps', [24, 25, 30, 60].map((v) => [v, `${v} fps`])),
  );
}

function render() {
  const reel = store.reel;
  const a = effectiveAudio();
  const pending = needsClaude();
  const job = ex.job;
  const running = job?.state === 'running';
  const kids = [];
  kids.push(
    h(
      'div.dialog-head',
      h('h2', { id: 'export-title' }, exportLabel()),
      h('button.btn.btn-ghost.btn-xs', { type: 'button', 'aria-label': 'Close', onclick: () => ex.dlg.close() }, icon('x', 16)),
    ),
  );

  if (canRender()) {
    const opt = (v, title, sub) =>
      h(
        'label.radio' + (ex.mode === v ? '.is-on' : ''),
        h('input', {
          type: 'radio',
          name: 'export-mode',
          value: v,
          checked: ex.mode === v,
          disabled: running,
          onchange: () => {
            ex.mode = v;
            render();
          },
        }),
        h('span', h('b', title), h('span.small.muted', sub)),
      );
    kids.push(
      h(
        'div.radios',
        opt('mix', 'Mix the sound', `v${reel.version} as rendered, with the music and levels set here. Fast.`),
        opt('render', 'Render with my edits', 'Runs the project’s export command with your edits applied.'),
      ),
    );
  }

  const what = [];
  if (ex.mode === 'frames') {
    kids.push(framesForm(running));
    const o = outSpec();
    what.push(`v${reel.version} of ${reel.title} as ${(ex.formats || []).find((f) => f.id === ex.opt.format)?.label || ex.opt.format}, ${o.w}×${o.h} at ${o.fps} fps`);
    if (ex.opt.format === 'gif') what.push('no sound');
    else if (typeof player.live?.exportAudio === 'function') {
      const n = player.live.exportAudio().length;
      what.push(n ? `the sound of ${n} clip${n === 1 ? '' : 's'}, mixed as you hear it` : 'no sound');
    } else what.push(a.music ? `music: ${assetName(a.music)} at ${Math.round(a.musicVol * 100)}%` : 'no music');
    what.push('with the edits you see');
  } else if (ex.mode === 'edit') {
    what.push(`a new cut of ${reel.title}: ${editSummary()}`);
    what.push(a.music ? `music: ${assetName(a.music)} at ${Math.round(a.musicVol * 100)}%` : 'no separate music');
    what.push(`video sound at ${Math.round(a.sfxVol * 100)}%`);
  } else if (ex.mode === 'mix') {
    what.push(`v${reel.version} of ${reel.title}`);
    what.push(a.music ? `music: ${assetName(a.music)} at ${Math.round(a.musicVol * 100)}%` : 'no separate music');
    what.push(`${reel.audio.videoAudio === 'mix' ? 'video sound' : 'effects'} at ${Math.round(a.sfxVol * 100)}%`);
    if (a.music && a.musicOffset) what.push(`music starts at ${round(a.musicOffset, 2)} s`);
    if (a.music && a.musicFade) what.push(`fades out over ${round(a.musicFade, 2)} s`);
  } else {
    what.push(`a fresh render of ${reel.title} with ${pending.filter((c) => c.kind !== 'note').length} edits applied`);
    what.push(a.music ? `music: ${assetName(a.music)}` : 'no separate music');
  }
  kids.push(h('p.export-what', "You'll get ", what.join(', '), '.'));
  if (ex.mode === 'frames') kids.push(h('p.small.muted', 'Every frame is drawn here and encoded by ffmpeg, so keep this tab open until it finishes.'));
  if (ex.mode === 'edit') kids.push(h('p.small.muted', 'The video is re-encoded with your edits, so this takes a little while. You can keep working. The original file stays as it is.'));

  if (ex.mode !== 'render' && ex.mode !== 'frames' && pending.length) {
    kids.push(
      h(
        'div.warn',
        `${pending.length} change${pending.length === 1 ? '' : 's'} still need${pending.length === 1 ? 's' : ''} Claude and won't be in this file.`,
        ' Send them first if you want them in.',
      ),
    );
  }
  if (ex.mode === 'render' && pending.some((c) => c.kind === 'note')) {
    kids.push(h('div.warn', 'Notes need Claude; they are not part of a render.'));
  }
  if (ex.mode !== 'render' && ex.ffmpeg && !ex.ffmpeg.ok) {
    kids.push(h('div.warn.warn-bad', 'ffmpeg not found. Install it (macOS: brew install ffmpeg), or start the server with --ffmpeg /path/to/ffmpeg.'));
  } else if (ex.mode === 'edit' && ex.ffmpeg && !ex.ffmpeg.edits) {
    kids.push(h('div.warn.warn-bad', "This ffmpeg can't apply edits (it has no video filters). Install the full one (macOS: brew install ffmpeg), or start the server with --ffmpeg /path/to/ffmpeg."));
  }

  if (job && job.state !== 'idle') {
    const pct = Math.max(0, Math.min(100, Number(job.pct) || 0));
    if (running) {
      kids.push(
        h(
          'div.progress',
          h('div.progress-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, h('span', { style: { width: pct + '%' } })),
          h('div.progress-line.mono.small', job.line || 'Working…'),
        ),
      );
    } else if (job.state === 'done') {
      kids.push(
        h(
          'div.done',
          h('div', icon('check', 16), ' Saved ', h('span.mono', job.rel || job.out)),
          h(
            'div.row-actions',
            h('button.btn.btn-sm', { type: 'button', onclick: reveal }, icon('folder', 15), 'Show in Finder'),
            job.rel ? h('a.btn.btn-sm.btn-ghost', { href: projectUrl(job.rel), target: '_blank', rel: 'noopener' }, 'Play it') : null,
          ),
        ),
      );
    } else if (job.state === 'error') {
      kids.push(h('div.warn.warn-bad', job.line || 'Export failed.'));
    }
  }

  kids.push(
    h(
      'div.dialog-foot',
      running && ex.abort ? h('button.btn.btn-ghost', { type: 'button', onclick: () => ex.abort.abort() }, 'Cancel') : null,
      h('button.btn.btn-ghost', { type: 'button', onclick: () => ex.dlg.close() }, running ? 'Hide' : 'Close'),
      h(
        'button.btn.btn-primary',
        { type: 'button', disabled: running || (ex.mode !== 'render' && ex.ffmpeg && (!ex.ffmpeg.ok || (ex.mode === 'edit' && !ex.ffmpeg.edits))) || (ex.mode === 'frames' && ex.formats && !ex.formats.some((f) => f.ok)), onclick: start },
        icon('export', 16),
        running ? 'Exporting…' : job?.state === 'done' ? 'Export again' : 'Export',
      ),
    ),
  );
  ex.body.replaceChildren(...kids);
}

function renderProps() {
  const edits = {};
  const boxes = {};
  const colors = {};
  const fonts = {};
  for (const c of store.data.changes) {
    if (c.kind === 'prop') (edits[c.elId] ||= {})[c.propKey] = c.after;
    else if (c.kind === 'box') boxes[c.elId] = c.after;
    else if (c.kind === 'brand') colors[c.colorId] = c.after;
    else if (c.kind === 'font') fonts[c.fontId] = c.after;
  }
  return { edits, boxes, colors, fonts };
}

// What the frames export will actually draw. A GIF keeps at most 15 fps and 960 px wide,
// so only those frames are drawn.
function outSpec() {
  const size = sizes().find((x) => x.id === ex.opt.size) || sizes()[0];
  let [w, h] = size.wh;
  let fps = ex.opt.fps || store.reel.fps || 30;
  if (ex.opt.format === 'gif') {
    fps = Math.min(fps, 15);
    if (w > 960) [w, h] = [960, Math.round((h * 960) / w / 2) * 2];
  }
  return { size, w, h, fps };
}

async function startFrames() {
  const a = effectiveAudio();
  const reel = store.reel;
  const { size, w, h: hgt, fps } = outSpec();
  const frames = Math.max(1, Math.round(reel.duration * fps));
  const live = player.live;
  const audio = [];
  // a timeline brings its own sound: every audible clip, mixed by the server
  if (typeof live.exportAudio === 'function') {
    if (ex.opt.format !== 'gif') audio.push(...live.exportAudio());
  } else if (a.music && ex.opt.format !== 'gif') {
    const off = Number(a.musicOffset) || 0;
    audio.push({ src: a.music, at: Math.max(0, off), in: Math.max(0, -off), gain: a.musicVol, fadeOut: a.musicFade || 0 });
  }
  ex.abort = new AbortController();
  ex.job = { state: 'running', pct: 0, line: 'Starting…' };
  render();
  updateButton();
  try {
    ex.job = await exportFrames(
      async (i, t, r) => {
        if (typeof live.renderFrame === 'function') return live.renderFrame(r, t);
        r.clear();
        await r.drawSVG(live.frameAt(t));
      },
      {
        w,
        h: hgt,
        fps,
        frames,
        format: ex.opt.format,
        audio,
        setSrc: ex.opt.format !== 'gif' && size.id === 'native' && fps === reel.fps,
        signal: ex.abort.signal,
        onProgress: (i, n) => {
          ex.job = { state: 'running', pct: (i / n) * 97, line: `Drawing frames (${i}/${n})…` };
          if (i % 6 === 0 || i === n) {
            if (ex.dlg.open) render();
            updateButton();
          }
        },
      },
    );
    if (ex.job.state === 'done') toast(`Export saved: ${ex.job.rel}`);
    else if (ex.job.state === 'error') toast(`Export failed: ${ex.job.line || ''}`, { kind: 'error', ms: 6000 });
  } catch (e) {
    ex.job = e.message === 'Cancelled' ? { state: 'idle' } : { state: 'error', line: e.status === 409 ? 'An export is already running.' : e.message };
  }
  ex.abort = null;
  render();
  updateButton();
}

async function start() {
  if (ex.mode === 'frames') return startFrames();
  const a = effectiveAudio();
  const body = {
    mode: ex.mode,
    music: a.music || null,
    musicVol: a.musicVol,
    sfxVol: a.sfxVol,
    musicOffset: a.musicOffset || 0,
    musicFade: a.musicFade || 0,
    props: ex.mode === 'render' ? renderProps() : {},
  };
  if (ex.mode === 'edit') {
    ex.job = { state: 'running', pct: 0, line: 'Drawing your text and logos…' };
    render();
    try {
      body.edit = await exportEdit();
    } catch (e) {
      ex.job = { state: 'error', line: `Couldn't draw the text and logos: ${e.message}` };
      render();
      return;
    }
  }
  try {
    ex.job = await api('/api/export', { json: body });
  } catch (e) {
    if (e.status === 409) {
      toast('An export is already running.');
    } else {
      ex.job = { state: 'error', line: e.message };
      render();
      return;
    }
  }
  if (!ex.job || ex.job.state === 'running' || !ex.job.state) startPolling();
  render();
  updateButton();
}

function startPolling() {
  clearInterval(ex.poll);
  ex.poll = setInterval(async () => {
    try {
      ex.job = await api('/api/export');
    } catch {
      return;
    }
    if (ex.job.state !== 'running') {
      clearInterval(ex.poll);
      if (ex.job.state === 'done') toast(`Export saved: ${ex.job.rel || ex.job.out}`);
      else if (ex.job.state === 'error') toast(`Export failed: ${ex.job.line || ''}`, { kind: 'error', ms: 6000 });
    }
    if (ex.dlg.open) render();
    updateButton();
  }, 500);
}

async function reveal() {
  try {
    await api('/api/reveal', { json: { path: ex.job.out || ex.job.rel } });
  } catch (e) {
    toast(`Couldn't open the folder: ${e.message}`, { kind: 'error' });
  }
}

export const exportOpen = () => !!ex.dlg?.open;
