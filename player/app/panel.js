// Side panel: Edit, Script, Look, Sound and Changes tabs.

import {
  store,
  bus,
  getEl,
  sceneOfEl,
  sceneAt,
  select,
  setTab,
  setProp,
  propValue,
  findChange,
  undo,
  setStatus,
  sceneStatus,
  setBrandColor,
  setFont,
  colorValue,
  fontValue,
  resolveColor,
  allAssets,
  assetName,
  effectiveAudio,
  setAudio,
  addUpload,
  notes,
  noteNumber,
  unsentChanges,
  openFindings,
  dismissedFindings,
  findingNumber,
  acceptFinding,
  dismissFinding,
  restoreFinding,
  setRequest,
  requestText,
} from './state.js';
import { seek, currentTime, player, duration } from './video.js';
import { pinNote, openNote, editText, openSpot, render as renderOverlay } from './overlay.js';
import { describe, buildMarkdown, send, setVerdict, finishCheck, checkSummary, sendableCount, sceneApplicable, applySceneNow } from './feedback.js';
import { h, icon, fmtTime, round, clamp, projectUrl, toast, copyText, baseName } from './util.js';
import { on as plainOn, renderPane as renderPlainEdit } from './vedit.js';
import { inspector as trackInspector, selectedClipId } from './tracks.js';
import { goToOutput } from './outputs.js';

const TABS = [
  ['edit', 'Edit'],
  ['script', 'Script'],
  ['look', 'Look'],
  ['sound', 'Sound'],
  ['changes', 'Changes'],
];

const pn = { root: null, nav: null, body: null, dirty: false, fileInput: null, showPreview: false, lastSend: null };

export function initPanel(root) {
  pn.root = root;
  pn.nav = h('div.tabs', { role: 'tablist', 'aria-label': 'Panel' });
  for (const [id, label] of TABS) {
    const b = h(
      'button.tab',
      { type: 'button', role: 'tab', id: 'tab-' + id, dataset: { tab: id }, 'aria-controls': 'panel-body', onclick: () => setTab(id) },
      h('span', label),
      h('span.tab-count', { hidden: true }),
    );
    pn.nav.append(b);
  }
  pn.body = h('div.panel-body', { id: 'panel-body', role: 'tabpanel' });
  pn.fileInput = h('input', { type: 'file', accept: '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a', hidden: true });
  pn.fileInput.addEventListener('change', () => {
    const f = pn.fileInput.files?.[0];
    pn.fileInput.value = '';
    if (f) uploadAudio(f);
  });
  root.append(pn.nav, pn.body, pn.fileInput);
  root.addEventListener('pointerdown', () => (pn.pointerDown = true));
  window.addEventListener('pointerup', () => {
    if (!pn.pointerDown) return;
    pn.pointerDown = false;
    if (pn.dirty) setTimeout(() => !typingInPanel() && render(), 0);
  });

  // Re-render, unless the reviewer is typing in the panel; then wait until they leave the field.
  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (pn.dirty && !typingInPanel()) render();
    }, 0);
  });

  bus.on('tab', () => render(true));
  bus.on('vedit', (d) => store.ui.tab === 'edit' && render(!!d?.select));
  bus.on('reel', () => render(true));
  bus.on('select', () => {
    if (store.ui.tab === 'edit') render(true);
  });
  bus.on('changes', (d) => render(d.sent || d.verdict));
  bus.on('status', () => render());
  bus.on('check', () => render(true));
  bus.on('pending', () => render(true));
  bus.on('music', () => store.ui.tab === 'sound' && render());
  // the timeline editor changed a clip, or the playhead moved over the selected one (its keyframe values)
  bus.on('tracks', () => store.ui.tab === 'edit' && render());
  bus.on('time', (d) => {
    if (store.ui.tab === 'edit' && d?.seek && selectedClipId()) return render();
    if (store.ui.tab === 'edit' && !store.ui.selected && !selectedClipId()) {
      const sc = sceneAt(currentTime());
      if (sc && sc.id !== pn.sceneShown) render();
    }
  });
  bus.on('focus-prop', ({ elId, key }) => {
    select(elId);
    render(true);
    const f = pn.body.querySelector(`[data-prop="${CSS.escape(key)}"] input, [data-prop="${CSS.escape(key)}"] textarea`);
    if (f) {
      f.focus();
      f.select?.();
    }
  });
}

function typingInPanel() {
  const a = document.activeElement;
  if (!a || !pn.root.contains(a) || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
  // sliders, swatches and selects only block a re-render while the pointer is held on them
  if (a.tagName === 'SELECT' || ['range', 'color', 'radio', 'checkbox'].includes(a.type)) return pn.pointerDown;
  return true;
}

export function render(force = false) {
  updateTabs();
  if (!store.reel) return;
  if (!force && typingInPanel()) {
    pn.dirty = true;
    return;
  }
  pn.dirty = false;
  const scroll = pn.body.scrollTop;
  const act = document.activeElement;
  const refocus = act && pn.body.contains(act) ? act.getAttribute('aria-label') : null;
  const tab = store.ui.tab;
  let content;
  if (store.reel.derived && tab !== 'changes') content = renderDerived();
  else if (tab === 'edit') content = renderEdit();
  else if (tab === 'script') content = renderScript();
  else if (tab === 'look') content = renderLook();
  else if (tab === 'sound') content = renderSound();
  else content = renderChanges();
  pn.body.replaceChildren(content);
  if (refocus) {
    const again = [...pn.body.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label') === refocus);
    again?.focus({ preventScroll: true });
  }
  if (!force) pn.body.scrollTop = scroll;
  else if (pn._lastTab !== tab) pn.body.scrollTop = 0;
  pn._lastTab = tab;
}

function updateTabs() {
  for (const b of pn.nav.children) {
    // a plain video has no script or brand to show
    b.hidden = !!store.reel?.plain && (b.dataset.tab === 'script' || b.dataset.tab === 'look');
    const on = b.dataset.tab === store.ui.tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  const cnt = pn.nav.querySelector('[data-tab="changes"] .tab-count');
  const n = store.reel ? sendableCount() : 0;
  cnt.hidden = !n;
  cnt.textContent = String(n);
  const nc = pn.nav.querySelector('[data-tab="changes"]');
  nc.classList.toggle('has-check', !!store.data.check);
}

// ---------------------------------------------------------------- shared bits

function section(title, ...kids) {
  return h('section.psec', title ? h('h3.psec-title', title) : null, ...kids);
}

function tapeMark(title = 'Changed · not sent yet') {
  return h('span.tape-mark', { title, 'aria-label': title });
}

function undoBtn(key, label = 'Undo') {
  return h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Undo this change', onclick: () => undo(key) }, icon('undo', 14), label);
}

function statusControl(scene) {
  const st = sceneStatus(scene.id);
  const opts = [
    ['review', 'Review'],
    ['changes', 'Needs changes'],
    ['approved', 'Approved'],
  ];
  return h(
    'div.seg.seg-status',
    { role: 'radiogroup', 'aria-label': `${scene.id} status` },
    opts.map(([v, l]) =>
      h(
        'button.seg-btn.st-' + v + (st === v ? '.is-on' : ''),
        { type: 'button', role: 'radio', 'aria-checked': st === v ? 'true' : 'false', onclick: () => setStatus(scene.id, v) },
        l,
      ),
    ),
  );
}

function timeBtn(t, label) {
  return h('button.time-btn', { type: 'button', title: 'Jump here', onclick: () => seek(t, { exact: false }) }, label || fmtTime(t));
}

// ---------------------------------------------------------------- Edit

function renderEdit() {
  if (plainOn()) return renderPlainEdit();
  const id = store.ui.selected;
  const el = id && getEl(id);
  if (!el) {
    // a timeline clip that is not on the frame (a sound, or one just added)
    const ins = trackInspector(null);
    return ins ? h('div.edit', h('div.el-head', h('div.el-title', h('h2', 'Clip'))), ins) : renderSceneOverview();
  }
  const scene = sceneOfEl(el.id);
  const wrap = h('div.edit');
  const onScreen = currentTime() >= el.t[0] && currentTime() <= el.t[1];
  wrap.append(
    h(
      'div.el-head',
      h('div.el-title', h('h2', el.label), h('button.btn.btn-ghost.btn-xs', { type: 'button', onclick: () => select(null), title: 'Deselect (Esc)' }, icon('x', 14))),
      h(
        'div.el-meta',
        h('span.mono', `${scene.id} · `),
        timeBtn(el.t[0], `${fmtTime(el.t[0])}–${fmtTime(el.t[1])}`),
        el.src ? h('span.el-src.mono', { title: el.src }, el.src) : null,
      ),
      h(
        'div.el-actions',
        onScreen ? null : h('button.btn.btn-sm', { type: 'button', onclick: () => seek(el.t[0] + Math.min(0.5, (el.t[1] - el.t[0]) / 2)) }, icon('jump', 15), 'Show it'),
        el.box && onScreen ? h('button.btn.btn-sm', { type: 'button', onclick: () => noteOnEl(el) }, icon('note', 15), 'Circle it') : null,
        el.box ? null : h('span.muted.small', 'Not on the frame (no box)'),
      ),
    ),
  );
  const boxC = findChange(`box:${el.id}`);
  if (boxC) {
    wrap.append(
      h(
        'div.field.is-edited',
        h('div.field-row', h('span.field-label', tapeMark(), 'Size and position'), undoBtn(boxC.key)),
        h('div.mono.small', `[${boxC.before.join(', ')}] → [${boxC.after.join(', ')}] · scale ${boxC.scale}`),
      ),
    );
  }
  const keys = Object.keys(el.props);
  if (!keys.length) wrap.append(h('p.muted', 'Nothing to edit here. Right-click the frame (or press C) to leave a note.'));
  for (const k of keys) wrap.append(propField(el, k, el.props[k]));
  const ins = trackInspector(el);
  if (ins) wrap.append(ins);
  wrap.append(section('Scene', h('div.scene-line', h('b', `${scene.id} ${scene.name}`), ' ', h('span.mono.muted', `${fmtTime(scene.t[0])}–${fmtTime(scene.t[1])}`)), statusControl(scene)));
  return wrap;
}

function noteOnEl(el) {
  const b = el.box;
  pinNote(b[0] + b[2] / 2, b[1] + b[3] / 2);
}

function renderSceneOverview() {
  const t = currentTime();
  const scene = sceneAt(t);
  pn.sceneShown = scene?.id;
  if (!scene) return h('div.empty', h('p', 'This reel has no scenes yet.'));
  const els = scene.els;
  return h(
    'div.edit',
    h('div.el-head', h('div.el-title', h('h2', `${scene.id} ${scene.name}`)), h('div.el-meta', timeBtn(scene.t[0], `${fmtTime(scene.t[0])}–${fmtTime(scene.t[1])}`))),
    statusControl(scene),
    h('p.muted.small.lead', 'Pause and click something on the frame to change it. Right-click (or C) to circle a problem.'),
    section(
      'In this scene',
      els.length
        ? h(
            'ul.el-list',
            els.map((el) => {
              const on = t >= el.t[0] && t <= el.t[1];
              return h(
                'li',
                h(
                  'button.el-item' + (on ? '.is-on' : ''),
                  {
                    type: 'button',
                    onclick: () => {
                      if (!(currentTime() >= el.t[0] && currentTime() <= el.t[1])) seek(el.t[0] + Math.min(0.4, (el.t[1] - el.t[0]) / 2));
                      select(el.id);
                    },
                  },
                  h('span.el-item-label', el.label),
                  findChange(`box:${el.id}`) || Object.keys(el.props).some((k) => findChange(`prop:${el.id}:${k}`)) ? tapeMark() : null,
                  h('span.mono.muted.small', fmtTime(el.t[0])),
                ),
              );
            }),
          )
        : h('p.muted', 'No elements listed for this scene.'),
    ),
  );
}

function fieldShell(el, key, p, control) {
  const c = findChange(`prop:${el.id}:${key}`);
  return h(
    'div.field' + (c ? '.is-edited' : ''),
    { dataset: { prop: key } },
    h('div.field-row', h('label.field-label', c ? tapeMark() : null, p.label), c ? undoBtn(c.key) : null),
    control,
    c && p.type !== 'list' ? h('div.was.small', 'Was: ', h('span', fmtVal(c.before))) : null,
  );
}

function fmtVal(v) {
  if (v == null || v === '') return '(empty)';
  if (Array.isArray(v)) return `${v.length} rows`;
  return String(v);
}

function propField(el, key, p) {
  const v = propValue(el.id, key);
  const set = (nv) => setProp(el.id, key, nv);
  let control;
  switch (p.type) {
    case 'longtext': {
      control = h('textarea.input', { rows: 3, value: String(v ?? ''), 'aria-label': p.label });
      control.addEventListener('input', () => set(control.value));
      break;
    }
    case 'number': {
      control = h('input.input', { type: 'number', step: p.step ?? 'any', value: String(v ?? ''), 'aria-label': p.label });
      if (p.min != null) control.min = p.min;
      if (p.max != null) control.max = p.max;
      control.addEventListener('input', () => {
        const n = parseFloat(control.value);
        if (Number.isFinite(n)) set(n);
      });
      break;
    }
    case 'color':
      control = colorControl(v, set, p.label);
      break;
    case 'media': {
      const assets = allAssets();
      const s = h('select.input', { 'aria-label': p.label });
      if (!assets.some((a) => a.id === v)) s.append(h('option', { value: String(v ?? '') }, v ? baseName(v) : '(none)'));
      for (const a of assets) s.append(h('option', { value: a.id }, `${a.name} · ${a.type}`));
      s.value = String(v ?? '');
      s.addEventListener('change', () => set(s.value));
      const asset = assets.find((a) => a.id === v);
      control = h(
        'div.media',
        asset && (asset.type === 'image' || /\.(png|jpe?g|webp|gif|svg)$/i.test(v || '')) ? h('img.media-thumb', { src: projectUrl(v), alt: '' }) : null,
        s,
      );
      break;
    }
    case 'list':
      control = listControl(p, v, set);
      break;
    case 'choice': {
      const s = h('select.input', { 'aria-label': p.label });
      const opts = p.options || [];
      if (!opts.some((o) => sameOpt(o, v))) s.append(h('option', { value: '__cur' }, String(v ?? '')));
      opts.forEach((o, i) => s.append(h('option', { value: String(i) }, o.label ?? String(o.v))));
      const idx = opts.findIndex((o) => sameOpt(o, v));
      s.value = idx >= 0 ? String(idx) : '__cur';
      s.addEventListener('change', () => {
        if (s.value !== '__cur') set(opts[+s.value].v);
      });
      control = s;
      break;
    }
    case 'motion':
      control = h(
        'div.motion',
        h('p.motion-text', String(v ?? '')),
        h(
          'button.btn.btn-sm',
          {
            type: 'button',
            title: "Motion can't be typed in; leave a note and Claude will change it",
            onclick: () => {
              const t = currentTime();
              if (!(t >= el.t[0] && t <= el.t[1])) seek(el.t[0] + Math.min(0.5, (el.t[1] - el.t[0]) / 2));
              if (el.box) noteOnEl(el);
              else pinNote(50, 50);
            },
          },
          icon('note', 15),
          'Comment on this',
        ),
      );
      break;
    default: {
      control = h('input.input', { type: 'text', value: String(v ?? ''), 'aria-label': p.label });
      control.addEventListener('input', () => set(control.value));
      control.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') control.blur();
      });
    }
  }
  return fieldShell(el, key, p, control);
}

const sameOpt = (o, v) => o && (o.v === v || JSON.stringify(o.v) === JSON.stringify(v));

function normHex(s) {
  s = String(s || '').trim();
  if (/^#?[0-9a-f]{3}$/i.test(s)) {
    const x = s.replace('#', '');
    return '#' + x.split('').map((c) => c + c).join('').toLowerCase();
  }
  if (/^#?[0-9a-f]{6}$/i.test(s)) return '#' + s.replace('#', '').toLowerCase();
  return null;
}

function colorControl(v, set, label) {
  const linked = typeof v === 'string' && v.startsWith('brand.');
  const hex = normHex(resolveColor(v)) || '#000000';
  const pick = h('input.swatch', { type: 'color', value: hex, 'aria-label': label + ' colour' });
  const text = h('input.input.mono.hex', { type: 'text', value: linked ? hex : String(v ?? ''), 'aria-label': label + ' hex', spellcheck: 'false' });
  const s = h('select.input', { 'aria-label': label + ' palette' });
  s.append(h('option', { value: '' }, 'Custom'));
  for (const c of store.reel.brand.colors) s.append(h('option', { value: 'brand.' + c.id }, `${c.name}`));
  s.value = linked ? v : '';
  pick.addEventListener('input', () => {
    text.value = pick.value;
    s.value = '';
    set(pick.value);
  });
  text.addEventListener('input', () => {
    const n = normHex(text.value);
    if (n) {
      pick.value = n;
      s.value = '';
      set(n);
    }
  });
  s.addEventListener('change', () => {
    if (s.value) {
      const nh = normHex(resolveColor(s.value)) || '#000000';
      pick.value = nh;
      text.value = nh;
      set(s.value);
    } else set(pick.value);
  });
  return h('div.color', pick, text, s, linked ? h('span.small.muted.color-link', 'Linked to the palette') : null);
}

function listControl(p, v, set) {
  const rows = Array.isArray(v) ? v.map((r) => ({ ...r })) : [];
  const wrap = h('div.list');
  const commit = () => set(rows.map((r) => ({ ...r })));
  const draw = () => {
    wrap.replaceChildren();
    rows.forEach((row, i) => {
      const cells = p.cols.map((col) => {
        const val = row[col.k];
        let inp;
        if (col.type === 'choice' && Array.isArray(col.options)) {
          inp = h('select.input', { 'aria-label': `${col.k} row ${i + 1}` });
          for (const o of col.options) {
            const ov = o && typeof o === 'object' ? o.v : o;
            inp.append(h('option', { value: String(ov) }, o && typeof o === 'object' ? o.label ?? String(o.v) : String(o)));
          }
          inp.value = String(val ?? '');
          inp.addEventListener('change', () => {
            row[col.k] = inp.value;
            commit();
          });
        } else if (col.type === 'color') {
          inp = h('input.swatch', { type: 'color', value: normHex(resolveColor(val)) || '#000000', 'aria-label': `${col.k} row ${i + 1}` });
          inp.addEventListener('input', () => {
            row[col.k] = inp.value;
            commit();
          });
        } else {
          inp = h('input.input', { type: col.type === 'number' ? 'number' : 'text', value: String(val ?? ''), placeholder: col.k, 'aria-label': `${col.k} row ${i + 1}` });
          inp.addEventListener('input', () => {
            row[col.k] = col.type === 'number' ? parseFloat(inp.value) || 0 : inp.value;
            commit();
          });
        }
        return h('div.list-cell', inp);
      });
      wrap.append(
        h(
          'div.list-row',
          h('span.list-n.mono', String(i + 1)),
          ...cells,
          h(
            'button.btn.btn-ghost.btn-xs',
            {
              type: 'button',
              title: 'Remove row',
              'aria-label': `Remove row ${i + 1}`,
              onclick: () => {
                rows.splice(i, 1);
                commit();
                draw();
              },
            },
            icon('trash', 14),
          ),
        ),
      );
    });
    wrap.append(
      h(
        'button.btn.btn-sm.list-add',
        {
          type: 'button',
          onclick: () => {
            const r = {};
            for (const c of p.cols) {
              const first = Array.isArray(c.options) && c.options.length ? c.options[0] : null;
              r[c.k] = c.type === 'number' ? 0 : c.type === 'choice' && first != null ? (typeof first === 'object' ? first.v : first) : '';
            }
            rows.push(r);
            commit();
            draw();
            wrap.querySelector('.list-row:last-of-type input')?.focus();
          },
        },
        '+ Add row',
      ),
    );
  };
  draw();
  return wrap;
}

// ---------------------------------------------------------------- Script

function renderScript() {
  const rows = [];
  for (const s of store.reel.scenes)
    for (const el of s.els)
      for (const [k, p] of Object.entries(el.props)) if (p.type === 'text' || p.type === 'longtext') rows.push({ s, el, k, p });
  rows.sort((a, b) => a.el.t[0] - b.el.t[0] || a.s.t[0] - b.s.t[0]);
  if (!rows.length) return h('div.empty', h('p', 'No words in this video to edit.'));
  const list = h('div.script');
  for (const { s, el, k, p } of rows) {
    const v = propValue(el.id, k);
    const c = findChange(`prop:${el.id}:${k}`);
    const input = h(p.type === 'longtext' ? 'textarea.input' : 'input.input', { value: String(v ?? ''), rows: p.type === 'longtext' ? 2 : null, 'aria-label': `${el.label} ${p.label}` });
    input.addEventListener('input', () => setProp(el.id, k, input.value, el.t[0]));
    input.addEventListener('focus', () => {
      if (store.ui.selected !== el.id) {
        store.ui.selected = el.id; // quiet: don't re-render the tab
        bus.emit('select-quiet', { elId: el.id });
      }
    });
    list.append(
      h(
        'div.script-row' + (c ? '.is-edited' : ''),
        h(
          'div.script-meta',
          h(
            'button.time-btn',
            {
              type: 'button',
              title: 'Jump here',
              onclick: () => {
                seek(el.t[0] + Math.min(0.4, (el.t[1] - el.t[0]) / 2));
                select(el.id);
              },
            },
            fmtTime(el.t[0]),
          ),
          h('span.script-where', h('span.mono', s.id), ' · ', el.label, p.label !== 'Text' ? ` · ${p.label}` : ''),
          c ? tapeMark() : null,
          c ? undoBtn(c.key, '') : null,
        ),
        input,
      ),
    );
  }
  return h('div', h('p.muted.small.lead', 'Every word in the video, in order. Type to change; it shows up in Changes.'), list);
}

// ---------------------------------------------------------------- Look

function renderLook() {
  const b = store.reel.brand;
  const wrap = h('div.look');
  wrap.append(
    section(
      'Brand colours',
      b.colors.length
        ? h(
            'div.swatches',
            b.colors.map((c) => {
              const v = colorValue(c.id);
              const ch = findChange(`brand:${c.id}`);
              const pick = h('input.swatch', { type: 'color', value: normHex(v) || '#000000', 'aria-label': c.name });
              const text = h('input.input.mono.hex', { type: 'text', value: v, 'aria-label': c.name + ' hex', spellcheck: 'false' });
              pick.addEventListener('input', () => {
                text.value = pick.value;
                setBrandColor(c.id, pick.value);
              });
              text.addEventListener('input', () => {
                const n = normHex(text.value);
                if (n) {
                  pick.value = n;
                  setBrandColor(c.id, n);
                }
              });
              return h(
                'div.swatch-row' + (ch ? '.is-edited' : ''),
                pick,
                h('div.swatch-name', h('span', c.name), h('span.mono.muted.small', 'brand.' + c.id)),
                text,
                ch ? tapeMark() : null,
                ch ? undoBtn(ch.key, '') : null,
              );
            }),
          )
        : h('p.muted', 'No brand colours in reel.json.'),
      b.colors.length ? h('p.muted.small', 'Changing a colour changes everything linked to it.') : null,
    ),
  );
  wrap.append(
    section(
      'Fonts',
      b.fonts.length
        ? b.fonts.map((f) => {
            const v = fontValue(f.id);
            const ch = findChange(`font:${f.id}`);
            const inp = h('input.input', { type: 'text', value: v, 'aria-label': f.name });
            const sample = h('div.font-sample', { style: { fontFamily: `"${v}", var(--sans)` } }, 'Aa Bb 123');
            inp.addEventListener('input', () => {
              sample.style.fontFamily = `"${inp.value}", var(--sans)`;
              setFont(f.id, inp.value);
            });
            return h('div.field' + (ch ? '.is-edited' : ''), h('div.field-row', h('label.field-label', ch ? tapeMark() : null, f.name), ch ? undoBtn(ch.key) : null), inp, sample);
          })
        : h('p.muted', 'No fonts in reel.json.'),
    ),
  );
  wrap.append(section('Logo', b.logo ? h('div.logo-box', h('img', { src: projectUrl(b.logo), alt: 'Logo' }), h('span.mono.small.muted', b.logo)) : h('p.muted', 'No logo in reel.json.')));
  const imgs = allAssets().filter((a) => a.type === 'image');
  wrap.append(
    section(
      'Images',
      imgs.length
        ? h(
            'div.asset-grid',
            imgs.map((a) => h('figure.asset', h('img', { src: projectUrl(a.id), alt: '', loading: 'lazy' }), h('figcaption', { title: a.id }, a.name))),
          )
        : h('p.muted', 'No images in this project.'),
    ),
  );
  return wrap;
}

// ---------------------------------------------------------------- Sound

function renderSound() {
  const a = effectiveAudio();
  const reel = store.reel;
  const mix = reel.audio.videoAudio === 'mix';
  const audios = allAssets().filter((x) => x.type === 'audio');
  const mc = findChange('audio:music');
  const wrap = h('div.sound');

  const swap = h('select.input', { 'aria-label': 'Swap music track' });
  swap.append(h('option', { value: '' }, audios.length ? 'Swap to…' : 'No other tracks yet'));
  for (const x of audios) if (x.id !== a.music) swap.append(h('option', { value: x.id }, x.name));
  swap.addEventListener('change', () => {
    if (swap.value) setAudio('music', swap.value);
  });

  wrap.append(
    section(
      'Music',
      h(
        'div.track' + (mc ? '.is-edited' : ''),
        h('span.track-icon', icon('music', 20)),
        h(
          'div.track-info',
          h('div.track-name', mc ? tapeMark() : null, a.music ? assetName(a.music) : 'No music'),
          a.music ? h('div.mono.small.muted', { title: a.music }, a.music) : h('div.small.muted', mix ? 'The video already has music in it.' : 'Add a track to hear it with the video.'),
          a.music && !player.musicOk && player.musicDuration === 0 ? null : null,
        ),
        mc ? undoBtn(mc.key, '') : null,
      ),
      h(
        'div.row-actions',
        swap,
        h('button.btn.btn-sm', { type: 'button', onclick: () => pn.fileInput.click() }, icon('upload', 15), 'Upload'),
        a.music ? h('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => setAudio('music', null) }, icon('trash', 15), 'Remove') : null,
      ),
      h('p.small.muted', 'Or drop an mp3, wav or m4a anywhere on the page.'),
    ),
  );

  // start at scene
  const startSel = h('select.input', { 'aria-label': 'Start the music at', disabled: !a.music });
  const matchScene = reel.scenes.find((s) => Math.abs(s.t[0] - (a.musicOffset || 0)) < 0.01);
  if (!matchScene) startSel.append(h('option', { value: '' }, `Custom · ${round(a.musicOffset || 0, 2)} s`));
  for (const s of reel.scenes) startSel.append(h('option', { value: s.id }, `${s.id} ${s.name} · ${fmtTime(s.t[0])}`));
  startSel.value = matchScene ? matchScene.id : '';
  startSel.addEventListener('change', () => {
    const s = reel.scenes.find((x) => x.id === startSel.value);
    if (s) setAudio('musicOffset', s.t[0]);
  });

  const offC = findChange('audio:musicOffset');
  const fadeC = findChange('audio:musicFade');
  const off = numField('Offset (s)', a.musicOffset || 0, 0.1, null, null, (v) => setAudio('musicOffset', v), offC, !a.music, '+ starts later, − skips into the track');
  const fade = numField('Fade-out (s)', a.musicFade || 0, 0.1, 0, duration() || null, (v) => setAudio('musicFade', Math.max(0, v)), fadeC, !a.music, 'over the last seconds of the video');

  wrap.append(section('Timing', h('div.field', h('label.field-label', 'Start the music at'), startSel), h('div.two', off, fade), h('p.small.muted', 'Tip: drag the music lane in the timeline, or the handle at its end for the fade. Shift turns snapping off.')));

  wrap.append(
    section(
      'Levels',
      slider('Music', 'musicVol', a.musicVol, !a.music),
      slider(mix ? 'Video sound' : 'Effects', 'sfxVol', a.sfxVol, false),
      h('p.small.muted', mix ? 'This video has its music baked in. An added track plays on top of it.' : 'The video carries sound effects only. The music plays from its own file.'),
    ),
  );

  const { bpm, drop } = reel.audio;
  wrap.append(
    section(
      'Beat',
      bpm
        ? h(
            'div.beat',
            h('span.mono', `${round(bpm, 2)} bpm`),
            Number.isFinite(drop) ? [h('span', ' · the drop lands at '), timeBtn(drop)] : null,
          )
        : h('p.muted', 'No beat grid in reel.json.'),
      reel.audio.note ? h('p.small.muted.audio-note', reel.audio.note) : null,
    ),
  );
  return wrap;
}

function numField(label, v, step, min, max, onSet, ch, disabled, help) {
  const inp = h('input.input.mono', { type: 'number', step, value: String(round(v, 2)), disabled, 'aria-label': label });
  if (min != null) inp.min = min;
  if (max != null) inp.max = max;
  inp.addEventListener('change', () => {
    const n = parseFloat(inp.value);
    if (Number.isFinite(n)) onSet(round(n, 2));
  });
  return h('div.field' + (ch ? '.is-edited' : ''), h('div.field-row', h('label.field-label', ch ? tapeMark() : null, label), ch ? undoBtn(ch.key, '') : null), inp, help ? h('div.small.muted', help) : null);
}

function slider(label, field, v, disabled) {
  const ch = findChange('audio:' + field);
  const out = h('span.mono.slider-val', `${Math.round(v * 100)}%`);
  const r = h('input.range', { type: 'range', min: 0, max: 100, step: 1, value: String(Math.round(v * 100)), disabled, 'aria-label': label + ' volume' });
  r.addEventListener('input', () => {
    out.textContent = `${r.value}%`;
    setAudio(field, round(+r.value / 100, 2));
  });
  return h('div.field.slider' + (ch ? '.is-edited' : ''), h('div.field-row', h('label.field-label', ch ? tapeMark() : null, label), out, ch ? undoBtn(ch.key, '') : null), r);
}

export async function uploadAudio(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['mp3', 'wav', 'm4a'].includes(ext)) {
    toast('Only mp3, wav or m4a files can be used as music.', { kind: 'error' });
    return null;
  }
  if (file.size > 100 * 1024 * 1024) {
    toast('That file is over 100 MB.', { kind: 'error' });
    return null;
  }
  toast(`Uploading ${file.name}…`, { ms: 1800 });
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    const asset = addUpload(data);
    setAudio('music', asset.id);
    toast(`Music is now ${asset.name}.`);
    if (store.ui.tab !== 'sound') setTab('sound');
    return asset;
  } catch (e) {
    toast(`Upload failed: ${e.message}`, { kind: 'error', ms: 6000 });
    return null;
  }
}

// ---------------------------------------------------------------- Changes

function jumpTo(at, elId, out = 'master') {
  if (out !== store.out) {
    goToOutput(out, Number.isFinite(at) ? at : 0); // `at` is on that output's clock
    return;
  }
  if (Number.isFinite(at)) seek(at, { exact: true });
  if (elId) select(elId);
}

/** A cutdown is made from the master: notes go here, everything else is changed on the master. */
function renderDerived() {
  const o = store.reel.output;
  return h(
    'div.derived-note',
    h('h2', `The ${o.label} version`),
    h(
      'p.small.muted',
      `${o.w}×${o.h} · ${fmtTime(o.duration)} · ${o.by === 'player' ? 'made here from the master' : 'made by Claude'}. Click the frame to leave a note on this version. Edits, script, look and sound are changed on the master${o.by === 'player' ? ', then re-render this version' : ''}.`,
    ),
    h('button.btn.btn-sm', { type: 'button', onclick: () => goToOutput('master') }, 'Go to the master'),
  );
}

function renderChanges() {
  const wrap = h('div.changes');
  const reel = store.reel;
  const ch = store.data.check;
  if (ch) wrap.append(renderCheck(ch));

  const pending = store.data.pending;
  if (pending) {
    wrap.append(
      h(
        'div.waiting',
        h('div.waiting-head', h('span.sweep', { 'aria-hidden': 'true' }), h('b', `Waiting for v${pending.version + 1}`)),
        h('p.small', 'Paste this into Claude. The player reloads by itself when the new version is in.'),
        promptBox(pending.line),
        h('div.mono.small.muted.path', { title: pending.path }, pending.path),
      ),
    );
  }

  if (!reel.derived) wrap.append(describeBox());

  const spotted = renderSpotted();
  if (spotted) wrap.append(spotted);

  const list = store.data.changes;
  const groups = [
    ['edits', 'Edits'],
    ['sound', 'Music and sound'],
    ['uploads', 'Uploads'],
    ['notes', 'Notes'],
  ];
  const ds = list.map((c) => ({ c, d: describe(c) }));
  let any = false;
  for (const [sec, title] of groups) {
    let items = ds.filter((x) => x.d.section === sec);
    if (!items.length) continue;
    any = true;
    if (sec === 'edits') items = items.sort((a, b) => (a.d.at ?? -1) - (b.d.at ?? -1));
    wrap.append(
      section(
        title,
        h(
          'ul.clist',
          items.map(({ c, d }) =>
            h(
              'li.citem' + (c.sent ? '.is-sent' : ''),
              c.kind === 'note' ? h('span.cnum', String(noteNumber(c.id))) : h('span.ctape', { 'aria-hidden': 'true' }),
              h(
                'div.cbody',
                h('div.cshort', d.short),
                h(
                  'div.cdetail.small.muted',
                  d.detail,
                  c.out && c.out !== 'master' ? h('span.out-tag', ` · on ${store.master.outputs.find((o) => o.id === c.out)?.label || c.out}`) : null,
                  c.sent ? h('span.sent-tag', ` · sent with v${c.sent}`) : null,
                ),
              ),
              h(
                'div.cact',
                Number.isFinite(d.at)
                  ? h(
                      'button.btn.btn-ghost.btn-xs',
                      {
                        type: 'button',
                        title: 'Jump there',
                        'aria-label': 'Jump there',
                        onclick: () => {
                          jumpTo(d.at, c.elId, c.out || 'master'); // switching output reloads synchronously
                          if (c.kind === 'note') openNote(c.id);
                        },
                      },
                      icon('jump', 14),
                    )
                  : null,
                h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Undo', 'aria-label': 'Undo', onclick: () => undo(c.key) }, icon('undo', 14)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const nq = store.data.notQuite;
  if (nq.length) {
    any = true;
    wrap.append(
      section(
        `Not quite from v${nq[0].from}`,
        h(
          'ul.clist',
          nq.map((x) =>
            h(
              'li.citem',
              h('span.cnq', { 'aria-hidden': 'true' }, '!'),
              h('div.cbody', h('div.cshort', x.text), x.reason ? h('div.cdetail.small.muted', x.reason) : null),
              h(
                'div.cact',
                h(
                  'button.btn.btn-ghost.btn-xs',
                  {
                    type: 'button',
                    title: 'Drop this',
                    'aria-label': 'Drop this',
                    onclick: () => {
                      store.data.notQuite = store.data.notQuite.filter((y) => y !== x);
                      if (store.data.check) {
                        const it = store.data.check.items.find((i) => i.key === x.key);
                        if (it) it.verdict = null;
                      }
                      bus.emit('changes', { verdict: true });
                    },
                  },
                  icon('x', 14),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  if (spotted) any = true;
  if (!any && !ch) {
    wrap.append(
      h(
        'div.empty',
        h('p.empty-title', 'Nothing changed yet'),
        h('p.muted', 'Click a word on the frame to fix it, or right-click to circle a problem. Nothing circled yet.'),
      ),
    );
  }

  if (requestText()) any = true;

  // a scene's edits can be written into scene.json right here; notes and moved boxes still need Claude
  const app = sceneApplicable();
  if (app.keys.length) {
    const btn = h(
      'button.btn.btn-sm',
      {
        type: 'button',
        onclick: async () => {
          btn.disabled = true;
          await applySceneNow();
          btn.disabled = false;
        },
      },
      icon('check', 15),
      `Apply ${app.keys.length} edit${app.keys.length === 1 ? '' : 's'} now`,
    );
    wrap.append(h('div.apply-now', btn, h('p.small.muted', `Writes ${app.keys.length === 1 ? 'it' : 'them'} into scene.json as v${store.master.version + 1}, without Claude. Notes and moved things still go to Claude.`)));
  }

  // Send area
  const unsent = unsentChanges().length + nq.length;
  const counts = countsLine();
  const sendBtn = h('button.btn.btn-tape.btn-send', { type: 'button', disabled: !unsent, onclick: () => doSend(sendBtn) }, icon('send', 16), unsent ? `Send to Claude` : 'Nothing new to send');
  const preview = h('pre.md-preview', { hidden: !pn.showPreview }, pn.showPreview ? buildMarkdown(store.data.changes) : '');
  wrap.append(
    h(
      'div.send-area',
      { id: 'send-area' },
      h('div.send-counts', counts || 'Nothing to send yet'),
      sendBtn,
      h(
        'button.btn.btn-ghost.btn-xs.preview-toggle',
        {
          type: 'button',
          'aria-expanded': pn.showPreview ? 'true' : 'false',
          onclick: () => {
            pn.showPreview = !pn.showPreview;
            render(true);
          },
        },
        pn.showPreview ? 'Hide what Claude gets' : 'Show what Claude gets',
      ),
    ),
  );
  wrap.append(preview);
  return wrap;
}

/** Ask Claude for something new, in words: it goes into the feedback file as "New request". */
function describeBox() {
  const ta = h('textarea.input.describe-input', {
    rows: 3,
    'aria-label': 'Ask Claude for something new',
    placeholder: store.master.timeline
      ? 'Describe a new video or part: "a 20 s launch teaser: a stuck developer, then our app saves the day, with captions and upbeat music"'
      : 'Describe something new for Claude to make or change',
  });
  ta.value = requestText();
  ta.addEventListener('input', () => setRequest(ta.value));
  return section('Ask for something new', ta, h('p.small.muted.describe-help', 'Goes to Claude with Send, with your edits and notes.'));
}

/** Claude's self-review: what it spotted in its own render, for the reviewer to accept or dismiss. */
function renderSpotted() {
  const open = openFindings();
  const gone = dismissedFindings();
  if (!open.length && !gone.length) return null;
  const item = (f, dismissed) =>
    h(
      'li.citem' + (dismissed ? '.is-sent' : ''),
      h('span.cspot', 'C' + findingNumber(f.id)),
      h(
        'div.cbody',
        h('div.cshort', f.title),
        h('div.cdetail.small.muted', [fmtTime(f.t), f.kind, dismissed ? 'dismissed' : f.fix ? 'Fix: ' + f.fix : ''].filter(Boolean).join(' · ')),
      ),
      h(
        'div.cact',
        dismissed
          ? h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Bring it back', 'aria-label': 'Bring it back', onclick: () => restoreFinding(f.id) }, icon('undo', 14))
          : [
              h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Show me', 'aria-label': 'Show me', onclick: () => openSpot(f.id) }, icon('jump', 14)),
              h(
                'button.btn.btn-ghost.btn-xs',
                {
                  type: 'button',
                  title: 'Add as my note',
                  'aria-label': 'Add as my note',
                  onclick: () => {
                    acceptFinding(f.id);
                    renderOverlay(true);
                  },
                },
                icon('check', 14),
              ),
              h('button.btn.btn-ghost.btn-xs', { type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => dismissFinding(f.id) }, icon('x', 14)),
            ],
      ),
    );
  return section(
    `Claude spotted${open.length ? ` · ${open.length}` : ''}`,
    open.length ? h('p.cspot-head', 'Claude checked its own render and left these for you. Add the ones you agree with as your notes, dismiss the rest.') : null,
    h('ul.clist', [...open.map((f) => item(f, false)), ...gone.map((f) => item(f, true))]),
  );
}

function countsLine() {
  const list = unsentChanges();
  const e = list.filter((c) => ['prop', 'box', 'brand', 'font'].includes(c.kind)).length;
  const s = list.filter((c) => c.kind === 'audio' || c.kind === 'upload').length;
  const n = list.filter((c) => c.kind === 'note').length;
  const q = store.data.notQuite.length;
  const parts = [];
  if (e) parts.push(`${e} edit${e === 1 ? '' : 's'}`);
  if (s) parts.push(`${s} sound change${s === 1 ? '' : 's'}`);
  if (n) parts.push(`${n} note${n === 1 ? '' : 's'}`);
  if (q) parts.push(`${q} not quite`);
  return parts.join(' · ');
}

function promptBox(line) {
  return h(
    'div.prompt',
    h('code.prompt-line', line),
    h(
      'button.btn.btn-sm',
      {
        type: 'button',
        onclick: async () => {
          const ok = await copyText(line);
          toast(ok ? 'Copied.' : "Couldn't copy. Select the line and copy it.");
        },
      },
      icon('copy', 14),
      'Copy',
    ),
  );
}

export async function doSend(btn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-sending');
  }
  bus.emit('sending', {});
  const res = await send();
  if (btn) btn.classList.remove('is-sending');
  if (!res) {
    if (btn) btn.disabled = false;
    bus.emit('send-failed', {});
  }
  render(true);
}

function renderCheck(ch) {
  const sum = checkSummary();
  const items = ch.items;
  return h(
    'section.check',
    h(
      'div.check-head',
      h('span.cue-dot-inline', { 'aria-hidden': 'true' }),
      h('h3', `Check v${ch.to}`),
      h('span.small.muted', `${sum.ok} of ${sum.total} look right${sum.auto ? ` · ${sum.auto} matched automatically` : ''}`),
    ),
    h(
      'ul.check-list',
      items.map((it) => {
        const reasonInput = h('input.input.input-sm', { type: 'text', placeholder: "What's still off? (optional)", value: it.reason || '', 'aria-label': 'Reason' });
        reasonInput.addEventListener('change', () => setVerdict(it.key, 'no', reasonInput.value.trim()));
        reasonInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') reasonInput.blur();
        });
        return h(
          'li.check-item.v-' + (it.verdict || 'open'),
          h('span.check-mark', { 'aria-hidden': 'true' }, it.verdict === 'ok' ? icon('check', 14) : it.verdict === 'no' ? '!' : ''),
          h(
            'div.cbody',
            h('div.cshort', it.text),
            it.auto ? h('div.small.muted', 'Matched in reel.json') : null,
            it.verdict === 'no' ? reasonInput : null,
          ),
          h(
            'div.check-act',
            Number.isFinite(it.at)
              ? h('button.btn.btn-xs', { type: 'button', onclick: () => jumpTo(it.at, it.elId && getEl(it.elId) ? it.elId : null) }, 'Show me')
              : null,
            h('button.btn.btn-xs' + (it.verdict === 'ok' ? '.is-on' : ''), { type: 'button', onclick: () => setVerdict(it.key, 'ok') }, 'Looks right'),
            h('button.btn.btn-xs' + (it.verdict === 'no' ? '.is-on-bad' : ''), { type: 'button', onclick: () => setVerdict(it.key, 'no', it.reason || '') }, 'Not quite'),
          ),
        );
      }),
    ),
    h('div.check-foot', h('button.btn.btn-sm', { type: 'button', onclick: () => finishCheck() }, sum.open ? `Done for now (${sum.open} unchecked)` : 'Done checking')),
  );
}

export function focusSend() {
  setTab('changes');
  requestAnimationFrame(() => {
    const a = document.getElementById('send-area');
    a?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    a?.querySelector('.btn-send')?.focus();
  });
}

void notes;
void clamp;
void editText;
