// Export: a dialog that says what you'll get, starts the job, shows progress, offers Show in Finder.

import { store, bus, effectiveAudio, approvedCount, assetName, findChange } from './state.js';
import { api, h, icon, projectUrl, round, toast } from './util.js';

const ex = { dlg: null, body: null, job: null, poll: 0, btn: null, mode: 'mix', ffmpeg: null };

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
  // pick up a job that was already running (e.g. after a reload)
  api('/api/export')
    .then((j) => {
      if (j && j.state === 'running') {
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
  ex.mode = canRender() && needsClaude().length ? 'render' : 'mix';
  render();
  if (!ex.dlg.open) ex.dlg.showModal();
  try {
    ex.ffmpeg = await api('/api/ffmpeg');
  } catch {
    ex.ffmpeg = null;
  }
  render();
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
  if (ex.mode === 'mix') {
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

  if (ex.mode === 'mix' && pending.length) {
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
  if (ex.mode === 'mix' && ex.ffmpeg && !ex.ffmpeg.ok) {
    kids.push(h('div.warn.warn-bad', 'ffmpeg not found. Install it, or start the server with --ffmpeg /path/to/ffmpeg.'));
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
      h('button.btn.btn-ghost', { type: 'button', onclick: () => ex.dlg.close() }, running ? 'Hide' : 'Close'),
      h(
        'button.btn.btn-primary',
        { type: 'button', disabled: running || (ex.mode === 'mix' && ex.ffmpeg && !ex.ffmpeg.ok), onclick: start },
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

async function start() {
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
