// The layer over the frame: element boxes, selection, inline text editing, move/resize, note rings,
// tape tabs on edited elements, and the cue dot that flashes when a new version lands.

import {
  store,
  bus,
  visibleEls,
  getEl,
  boxValue,
  select,
  setBox,
  setProp,
  propValue,
  mainTextKey,
  addNote,
  updateNote,
  undo,
  notes,
  noteNumber,
  elHasEdits,
  findChange,
  setTab,
} from './state.js';
import { player, isPlaying, pause, toggle, currentTime, pushLiveBoxes, seek } from './video.js';
import { h, svg, clamp, round, prefersReducedMotion, toast } from './util.js';

const ov = {
  frame: null,
  layer: null,
  boxes: null,
  notesLayer: null,
  pop: null,
  editor: null,
  cue: null,
  sig: '',
  hover: null,
  lastPoint: null, // last pointer position over the frame, in %
  drag: null,
  justDrew: new Set(), // note ids whose ring should animate
};

const RING_PATH = 'M71 13 C95 24 99 68 64 89 C33 105 3 80 6 49 C9 20 41 3 79 17';

export function initOverlay(frame) {
  ov.frame = frame;
  ov.boxes = h('div.ov-boxes');
  ov.notesLayer = h('div.ov-notes');
  ov.layer = h('div.overlay', ov.boxes, ov.notesLayer);
  ov.cue = h('div.cue-dot', { 'aria-hidden': 'true' });
  frame.append(ov.layer, ov.cue);

  ov.layer.addEventListener('pointerdown', onDown);
  ov.layer.addEventListener('pointermove', onMove);
  ov.layer.addEventListener('pointerleave', () => {
    ov.lastPoint = null;
    setHover(null);
  });
  ov.layer.addEventListener('dblclick', onDbl);
  ov.layer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = toPct(e);
    pinNote(p.x, p.y);
  });

  bus.on('time', () => render());
  bus.on('select', () => render(true));
  bus.on('changes', () => render(true));
  bus.on('play', () => render(true));
  bus.on('compare', () => render(true));
}

// ---------------------------------------------------------------- geometry

function toPct(e) {
  const r = ov.layer.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
}

function inBox(b, p) {
  return b && p.x >= b[0] && p.x <= b[0] + b[2] && p.y >= b[1] && p.y <= b[1] + b[3];
}

/** Elements under a point, smallest first. */
export function elsAt(p, t = currentTime()) {
  return visibleEls(t)
    .map((el) => ({ el, b: boxValue(el.id) }))
    .filter((x) => inBox(x.b, p))
    .sort((a, b) => a.b[2] * a.b[3] - b.b[2] * b.b[3])
    .map((x) => x.el);
}

const posStyle = (b) => ({ left: b[0] + '%', top: b[1] + '%', width: b[2] + '%', height: b[3] + '%' });

// ---------------------------------------------------------------- render

function noteVisible(n, t) {
  if (store.ui.noteOpen === n.id) return true;
  const el = n.elId && getEl(n.elId);
  if (el && t >= el.t[0] && t <= el.t[1] && Math.abs(t - n.t) < 6) return true;
  return t >= n.t - 0.75 && t <= n.t + 2;
}

export function render(force = false) {
  if (!store.reel) return;
  const t = currentTime();
  const vis = visibleEls(t).filter((el) => boxValue(el.id));
  const ns = notes().filter((n) => noteVisible(n, t));
  const sig = [
    vis.map((e) => e.id).join(','),
    ns.map((n) => n.id).join(','),
    store.ui.selected,
    isPlaying() ? 'p' : 's',
    store.ui.compare ? 'c' : '',
    ov.hover,
  ].join('|');
  if (!force && sig === ov.sig) return;
  ov.sig = sig;
  if (ov.drag?.active) return; // the drag draws its own preview
  renderBoxes(vis);
  renderNotes(ns);
}

function renderBoxes(vis) {
  const frag = document.createDocumentFragment();
  const playing = isPlaying();
  const live = !!player.live;
  for (const el of vis) {
    const b = boxValue(el.id);
    const orig = el.box;
    const edited = elHasEdits(el.id);
    const moved = !!findChange(`box:${el.id}`);
    const sel = store.ui.selected === el.id;
    if (moved && !live && orig) {
      frag.append(h('div.ov-ghost', { style: posStyle(orig), 'aria-hidden': 'true' }));
    }
    const box = h(
      'div.ov-box' + (sel ? '.is-selected' : '') + (ov.hover === el.id ? '.is-hover' : '') + (moved && !live ? '.is-moved' : ''),
      { style: posStyle(b), dataset: { id: el.id } },
    );
    if (sel) {
      box.append(h('span.ov-label' + (b[1] < 6 ? '.below' : ''), el.label));
      if (!playing) for (const c of ['nw', 'ne', 'sw', 'se']) box.append(h('span.ov-handle.h-' + c, { dataset: { corner: c } }));
    }
    if (edited) {
      const tape = h('span.ov-tape', { 'aria-hidden': 'true' });
      if (!playing) tape.append(h('span.ov-slip', 'Waiting for Claude'));
      if (!ov._taped) ov._taped = new Set();
      if (!ov._taped.has(el.id)) {
        ov._taped.add(el.id);
        if (!prefersReducedMotion()) tape.classList.add('lands');
      }
      box.append(tape);
    }
    frag.append(box);
  }
  if (ov._taped) for (const id of [...ov._taped]) if (!elHasEdits(id)) ov._taped.delete(id);
  ov.boxes.replaceChildren(frag);
}

function renderNotes(ns) {
  const frag = document.createDocumentFragment();
  for (const n of ns) {
    const num = noteNumber(n.id);
    const animate = ov.justDrew.has(n.id) && !prefersReducedMotion();
    const ring = svg(
      'svg',
      { viewBox: '0 0 100 100', class: 'ov-ring' + (animate ? ' draw' : ''), 'aria-hidden': 'true' },
      svg('path', { d: RING_PATH, pathLength: '1' }),
    );
    const badge = h('span.ov-num' + (animate ? '.drop' : ''), String(num));
    const node = h(
      'button.ov-note' + (store.ui.noteOpen === n.id ? '.is-open' : '') + (n.sent ? '.is-sent' : ''),
      {
        type: 'button',
        style: { left: n.x + '%', top: n.y + '%' },
        dataset: { note: n.id },
        title: `Note ${num}${n.text ? ': ' + n.text : ''}`,
        'aria-label': `Note ${num}${n.text ? ': ' + n.text : ''}`,
      },
      ring,
      badge,
    );
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      openNote(n.id);
    });
    frag.append(node);
  }
  ov.justDrew.clear();
  ov.notesLayer.replaceChildren(frag);
}

function setHover(id) {
  if (ov.hover === id) return;
  ov.hover = id;
  for (const b of ov.boxes.querySelectorAll('.ov-box')) b.classList.toggle('is-hover', b.dataset.id === id);
}

// ---------------------------------------------------------------- pointer handling

function onMove(e) {
  ov.lastPoint = toPct(e);
  if (ov.drag) return;
  if (isPlaying()) return setHover(null);
  const top = elsAt(ov.lastPoint)[0];
  setHover(top ? top.id : null);
  ov.layer.style.cursor = top ? (top.id === store.ui.selected ? 'move' : 'pointer') : '';
}

function onDown(e) {
  if (e.button !== 0) return;
  if (ov.editor) return;
  const p = toPct(e);
  const corner = e.target.closest?.('.ov-handle')?.dataset.corner;
  const under = elsAt(p);
  const selId = store.ui.selected;
  const onSelected = selId && (corner || under.some((x) => x.id === selId));
  if (onSelected && !isPlaying()) {
    startDrag(e, selId, corner, p, under);
    return;
  }
  // a plain click
  const up = (ev) => {
    ov.layer.removeEventListener('pointerup', up);
    if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 4) return;
    clickAt(p, under, ev);
  };
  ov.layer.addEventListener('pointerup', up);
}

function clickAt(p, under, ev) {
  closeNote();
  if (under.length) {
    if (isPlaying()) pause();
    let pick = under[0];
    if (ev.altKey && store.ui.selected) {
      const i = under.findIndex((x) => x.id === store.ui.selected);
      pick = under[(i + 1) % under.length];
    }
    select(pick.id);
    if (store.ui.tab !== 'edit') setTab('edit');
  } else if (store.ui.selected) {
    select(null);
  } else {
    toggle();
  }
}

function startDrag(e, id, corner, p0, under) {
  e.preventDefault();
  const el = getEl(id);
  const b0 = boxValue(id).slice();
  ov.layer.setPointerCapture(e.pointerId);
  const d = { id, corner, b0, b: b0.slice(), active: false, x0: e.clientX, y0: e.clientY };
  ov.drag = d;
  const r = ov.layer.getBoundingClientRect();
  const move = (ev) => {
    if (!d.active && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 3) return;
    if (!d.active) {
      d.active = true;
      ov.frame.classList.add('is-dragging');
    }
    const dx = ((ev.clientX - d.x0) / r.width) * 100;
    const dy = ((ev.clientY - d.y0) / r.height) * 100;
    d.b = corner ? resized(b0, corner, dx, dy, ev.shiftKey) : moved(b0, dx, dy);
    drawDragPreview(el, d.b);
  };
  const up = (ev) => {
    ov.layer.removeEventListener('pointermove', move);
    ov.layer.removeEventListener('pointerup', up);
    ov.layer.removeEventListener('pointercancel', up);
    ov.frame.classList.remove('is-dragging');
    ov.drag = null;
    if (d.active) {
      setBox(id, d.b.map((v) => round(v, 1)));
      bus.emit('hint', {});
    } else if (ev.type === 'pointerup') {
      // a click on the selected element: Alt cycles through what's underneath
      clickAt(p0, under, ev);
    }
    render(true);
  };
  ov.layer.addEventListener('pointermove', move);
  ov.layer.addEventListener('pointerup', up);
  ov.layer.addEventListener('pointercancel', up);
}

function moved(b, dx, dy) {
  return [clamp(b[0] + dx, -b[2] + 2, 98), clamp(b[1] + dy, -b[3] + 2, 98), b[2], b[3]];
}

function resized(b, corner, dx, dy, keepAspect) {
  let [x, y, w, hh] = b;
  const right = x + w;
  const bottom = y + hh;
  const MIN = 1.5;
  if (corner.includes('w')) x = Math.min(x + dx, right - MIN);
  if (corner.includes('e')) w = Math.max(MIN, w + dx);
  if (corner.includes('n')) y = Math.min(y + dy, bottom - MIN);
  if (corner.includes('s')) hh = Math.max(MIN, hh + dy);
  if (corner.includes('w')) w = right - x;
  if (corner.includes('n')) hh = bottom - y;
  if (keepAspect) {
    const s = Math.max(w / b[2], hh / b[3]);
    w = b[2] * s;
    hh = b[3] * s;
    if (corner.includes('w')) x = right - w;
    if (corner.includes('n')) y = bottom - hh;
  }
  return [x, y, w, hh];
}

function drawDragPreview(el, b) {
  const node = ov.boxes.querySelector(`.ov-box[data-id="${CSS.escape(el.id)}"]`);
  if (node) {
    Object.assign(node.style, posStyle(b));
    node.classList.toggle('is-moved', !player.live);
  }
  let ghost = ov.boxes.querySelector('.ov-ghost.drag');
  if (!ghost && el.box && !player.live) {
    ghost = h('div.ov-ghost.drag', { style: posStyle(el.box) });
    ov.boxes.prepend(ghost);
  }
  if (player.live && el.box) pushLiveBoxes({ id: el.id, before: el.box, after: b });
  const sc = Math.sqrt((b[2] * b[3]) / (el.box[2] * el.box[3]));
  bus.emit('hint', { text: `[${b.map((v) => round(v, 1)).join(', ')}] · scale ${round(sc, 2)} · Shift keeps the shape` });
}

function onDbl(e) {
  if (ov.editor) return;
  const p = toPct(e);
  const top = elsAt(p)[0];
  if (top) {
    select(top.id);
    editText(top.id);
  } else {
    bus.emit('fullscreen', {});
  }
}

// ---------------------------------------------------------------- inline text edit

export function editText(id = store.ui.selected) {
  const el = getEl(id);
  if (!el) return;
  const key = mainTextKey(el);
  if (!key) {
    toast(`${el.label} has no text to type. Its other settings are in Edit.`);
    setTab('edit');
    return;
  }
  const t = currentTime();
  if (!(t >= el.t[0] && t <= el.t[1]) || !boxValue(id)) {
    // not on screen: edit in the panel instead
    setTab('edit');
    bus.emit('focus-prop', { elId: id, key });
    return;
  }
  if (isPlaying()) pause();
  closeEditor(false);
  const b = boxValue(id);
  const long = el.props[key].type === 'longtext';
  const input = h(long ? 'textarea' : 'input', {
    class: 'ov-input',
    value: String(propValue(id, key) ?? ''),
    'aria-label': `${el.label} · ${el.props[key].label}`,
    spellcheck: 'true',
  });
  const wrap = h('div.ov-editor', { style: posStyle(b) }, input, h('span.ov-editor-hint', long ? 'Enter saves · Shift+Enter new line · Esc cancels' : 'Enter saves · Esc cancels'));
  const frameH = ov.layer.clientHeight || 400;
  const px = long ? clamp(((b[3] / 100) * frameH) / 6, 13, 22) : clamp(((b[3] / 100) * frameH) / 2.6, 13, 36);
  if (long) wrap.classList.add('is-long');
  input.style.fontSize = px + 'px';
  ov.layer.append(wrap);
  ov.editor = { wrap, input, id, key };
  store.ui.editingText = true;
  bus.emit('hint', {});
  input.focus();
  input.select();
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeEditor(false);
    } else if (ev.key === 'Enter' && !(long && ev.shiftKey)) {
      ev.preventDefault();
      closeEditor(true);
    }
  });
  input.addEventListener('blur', () => closeEditor(true));
  input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
}

function closeEditor(save) {
  const ed = ov.editor;
  if (!ed) return;
  ov.editor = null;
  store.ui.editingText = false;
  if (save) setProp(ed.id, ed.key, ed.input.value);
  ed.wrap.remove();
  bus.emit('hint', {});
}

export const isEditingText = () => !!ov.editor;

// ---------------------------------------------------------------- notes

/** Pin a note at x/y (% of frame) at the current time. */
export function pinNote(x, y) {
  if (x == null) {
    const p = ov.lastPoint;
    if (p) ({ x, y } = p);
    else {
      const b = store.ui.selected && boxValue(store.ui.selected);
      x = b ? b[0] + b[2] / 2 : 50;
      y = b ? b[1] + b[3] / 2 : 50;
    }
  }
  if (isPlaying()) pause();
  closeEditor(true);
  closeNote();
  const t = currentTime();
  const under = elsAt({ x, y }, t)[0];
  const n = addNote({ t, x: round(clamp(x, 0, 100), 1), y: round(clamp(y, 0, 100), 1), elId: under?.id || store.ui.selected || null });
  ov.justDrew.add(n.id);
  store.ui.noteOpen = n.id;
  render(true);
  // the ring draws first (~420 ms), then the comment box opens
  const delay = prefersReducedMotion() ? 0 : 460;
  setTimeout(() => openNote(n.id, true), delay);
  return n;
}

export function openNote(id, fresh = false) {
  if (store.ui.noteOpen && store.ui.noteOpen !== id) closeNote();
  const n = notes().find((x) => x.id === id);
  if (!n) return;
  store.ui.noteOpen = id;
  if (Math.abs(currentTime() - n.t) > 0.05 && !fresh) {
    // jump there so the note is in context
    seek(n.t, { exact: true });
  }
  const ta = h('textarea.ov-pop-input', { value: n.text || '', placeholder: 'What should change here?', rows: 3, 'aria-label': `Note ${noteNumber(id)}` });
  const del = h('button.btn.btn-ghost.btn-sm', { type: 'button' }, 'Remove');
  const done = h('button.btn.btn-sm', { type: 'button' }, 'Done');
  ov.pop = h(
    'div.ov-pop',
    { role: 'dialog', 'aria-label': `Note ${noteNumber(id)}` },
    h('div.ov-pop-head', h('span.ov-pop-num', String(noteNumber(id))), h('span', n.elId && getEl(n.elId) ? 'On ' + getEl(n.elId).label : 'Note'), h('span.ov-pop-keys', 'Enter saves · Esc closes')),
    ta,
    h('div.ov-pop-actions', del, done),
  );
  ov.pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  ov.pop.addEventListener('dblclick', (e) => e.stopPropagation());
  ov.pop.addEventListener('contextmenu', (e) => e.stopPropagation());
  ov.freshId = fresh ? id : null;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish();
    }
  });
  const finish = () => closeNote();
  del.addEventListener('click', () => {
    ov.freshId = null;
    store.ui.noteOpen = null;
    ov.pop?.remove();
    ov.pop = null;
    undo(n.key);
    bus.emit('hint', {});
  });
  done.addEventListener('click', finish);
  render(true);
  ov.layer.querySelector('.ov-pop')?.remove();
  ov.layer.append(ov.pop); // outside the notes layer so re-renders never move it (and steal focus)
  placePop(n);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  bus.emit('hint', {});
}

function placePop(n) {
  const pop = ov.pop;
  if (!pop) return;
  const right = n.x > 62;
  const below = n.y < 55;
  pop.style.left = right ? '' : `calc(${n.x}% + 34px)`;
  pop.style.right = right ? `calc(${100 - n.x}% + 34px)` : '';
  pop.style.top = below ? `calc(${n.y}% - 18px)` : '';
  pop.style.bottom = below ? '' : `calc(${100 - n.y}% - 18px)`;
}

export function closeNote() {
  if (!store.ui.noteOpen) return false;
  const id = store.ui.noteOpen;
  store.ui.noteOpen = null;
  const n = notes().find((x) => x.id === id);
  const ta = ov.pop?.querySelector('textarea');
  const text = ta ? ta.value.trim() : n?.text || '';
  const fresh = ov.freshId === id;
  ov.freshId = null;
  ov.pop?.remove();
  ov.pop = null;
  if (n) {
    if (!text && fresh) undo(n.key);
    else if (text !== (n.text || '')) updateNote(id, text);
  }
  render(true);
  bus.emit('hint', {});
  return true;
}

// ---------------------------------------------------------------- cue dot

export function flashCue() {
  const c = ov.cue;
  c.classList.remove('flash', 'steady');
  void c.offsetWidth;
  c.classList.add(prefersReducedMotion() ? 'steady' : 'flash');
  setTimeout(() => c.classList.remove('flash', 'steady'), 1400);
}

export function cancelOverlay() {
  if (ov.editor) {
    closeEditor(false);
    return true;
  }
  if (closeNote()) return true;
  return false;
}
