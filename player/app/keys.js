// Keyboard shortcuts and the ? sheet.

import { store, bus, select, toggleApproved, sceneAt, undoLast, getEl } from './state.js';
import { toggle, stepFrames, stepSeconds, seek, duration, prevScene, nextScene, setLoop, setRate, setMuted, setCompare, player, currentTime } from './video.js';
import { editText, pinNote, cancelOverlay, isEditingText } from './overlay.js';
import { describe } from './feedback.js';
import { h, isTyping, toast } from './util.js';
import { on as plainOn, onKey as plainKey, onKeyUp as plainKeyUp } from './vedit.js';
import { tracksKey, tracksOn } from './tracks.js';

export const SHORTCUTS = [
  ['Watching', [
    ['Space', 'Play / pause'],
    ['← →  or  , .', 'One frame back / forward'],
    ['Shift ← →', 'One second back / forward'],
    ['Home  End', 'Start / end'],
    ['[  ]', 'Previous / next scene'],
    ['L', 'Loop the current scene'],
    ['<  >', 'Slower / faster (0.25×)'],
    ['M', 'Mute'],
    ['F', 'Fullscreen (or double-click an empty spot)'],
    ['hold V', 'Show the previous version at this frame'],
  ]],
  ['Fixing', [
    ['Click', 'Select what’s on the frame (Alt-click: the one underneath)'],
    ['Double-click  or  Enter', 'Edit its text in place'],
    ['Drag  /  drag a corner', 'Move / resize (Shift keeps the shape)'],
    ['Right-click  or  C', 'Circle a problem and leave a note'],
    ['A', 'Approve the current scene'],
    ['⌘Z  /  Ctrl Z', 'Undo the last change'],
    ['Esc', 'Cancel, deselect, leave fullscreen'],
    ['?', 'This sheet'],
  ]],
];

/** Shown too when a plain video is open. */
const PLAIN_SHORTCUTS = ['Editing this video', [
  ['I  O', 'Trim: start / end at the playhead'],
  ['X  …  X', 'Cut out a part: press at its start, then at its end'],
  ['T', 'Add text'],
  ['Drag  /  drag a corner', 'Move / resize text, a logo or a blur'],
  ['Double-click  or  Enter', 'Change the words'],
  ['Delete', 'Remove the selected text, logo or blur'],
  ['hold \\', 'See the original, without your edits'],
  ['⌘Z  /  ⇧⌘Z', 'Undo / redo'],
]];

/** Shown too when a timeline project is open. */
const TRACK_SHORTCUTS = ['Editing the timeline', [
  ['S', 'Split the clip at the playhead'],
  ['Delete  /  Shift Delete', 'Remove the clip / and close the gap'],
  ['Drag  /  drag an edge', 'Move a clip (onto another track too) / trim it'],
  ['Alt drag', 'Slip: change what part of the source plays'],
  ['Shift drag', 'No snapping'],
  ['Alt ← →', 'Nudge the clip one frame (Shift: 10)'],
  ['⌘D', 'Duplicate the clip'],
  ['T  /  B', 'Add text / a marker at the playhead'],
  ['⌘ scroll', 'Zoom the timeline'],
  ['⌘Z  /  ⇧⌘Z', 'Undo / redo'],
]];

let sheet = null;

const WORDS = new Set(['or', '/', '…', 'hold', 'Drag', 'drag', 'a', 'corner', 'Click', 'Double-click', 'Right-click', 'drag', 'scroll', 'an', 'edge']);
function keyTokens(k) {
  return k
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (WORDS.has(t) ? h('span.key-word', t) : h('kbd', t)));
}

export function initKeys() {
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => {
    if ((e.key === 'v' || e.key === 'V') && store.ui.compare) setCompare(false);
    plainKeyUp(e);
  });
  window.addEventListener('blur', () => {
    if (store.ui.compare) setCompare(false);
  });
}

export function toggleSheet(force) {
  if (!sheet) {
    sheet = h(
      'dialog.dialog.keys-dialog',
      { 'aria-labelledby': 'keys-title' },
      h(
        'div.dialog-body',
        h('div.dialog-head', h('h2', { id: 'keys-title' }, 'Shortcuts'), h('button.btn.btn-ghost.btn-xs', { type: 'button', 'aria-label': 'Close', onclick: () => sheet.close() }, '✕')),
        h(
          'div.keys-cols',
          (plainOn() ? [...SHORTCUTS, PLAIN_SHORTCUTS] : tracksOn() ? [...SHORTCUTS, TRACK_SHORTCUTS] : SHORTCUTS).map(([title, rows]) =>
            h('div.keys-col', h('h3', title), h('dl.keys', rows.map(([k, d]) => [h('dt', keyTokens(k)), h('dd', d)]))),
          ),
        ),
        h('p.small.muted', 'Deep links: #t=12.5&el=headline · #tab=sound · ?theme=dark'),
      ),
    );
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) sheet.close();
    });
    document.body.append(sheet);
  }
  const want = force ?? !sheet.open;
  if (want && !sheet.open) sheet.showModal();
  else if (!want && sheet.open) sheet.close();
}

function onKey(e) {
  if (e.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) {
    if (e.key === '?' && sheet?.open) {
      e.preventDefault();
      sheet.close();
    }
    return;
  }
  const typing = isTyping(e.target);
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  // a plain video's own edits (trim, layers...) get the key first; ⌘Z undoes whichever came last
  if (tracksKey(e) || plainKey(e)) {
    e.preventDefault();
    return;
  }
  if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    e.preventDefault();
    const c = undoLast();
    toast(c ? `Undid: ${describe(c).short}` : 'Nothing to undo.');
    return;
  }
  if (mod || e.altKey) return;
  // keys that would otherwise click a focused button
  const k = e.key;
  let handled = true;
  switch (k) {
    case ' ':
    case 'k':
    case 'K':
      if (k === ' ' && e.target?.tagName === 'BUTTON' && e.target.closest('.panel')) {
        handled = false;
        break;
      }
      toggle();
      break;
    case 'ArrowLeft':
      e.shiftKey ? stepSeconds(-1) : stepFrames(-1);
      break;
    case 'ArrowRight':
      e.shiftKey ? stepSeconds(1) : stepFrames(1);
      break;
    case ',':
      e.shiftKey ? setRate(player.rate - 0.25) : stepFrames(-1);
      break;
    case '.':
      e.shiftKey ? setRate(player.rate + 0.25) : stepFrames(1);
      break;
    case 'Home':
      seek(0);
      break;
    case 'End':
      seek(duration());
      break;
    case '[':
      prevScene();
      break;
    case ']':
      nextScene();
      break;
    case 'l':
    case 'L':
      setLoop(!player.loopScene);
      toast(player.loopScene ? `Looping ${sceneAt(currentTime())?.id}` : 'Loop off', { ms: 1400 });
      break;
    case '<':
      setRate(player.rate - 0.25);
      break;
    case '>':
      setRate(player.rate + 0.25);
      break;
    case 'f':
    case 'F':
      bus.emit('fullscreen', {});
      break;
    case 'm':
    case 'M':
      setMuted(!player.muted);
      break;
    case 'a':
    case 'A': {
      const sc = sceneAt(currentTime());
      if (sc) {
        const st = toggleApproved(sc.id);
        toast(st === 'approved' ? `${sc.id} ${sc.name} approved` : `${sc.id} back in review`, { ms: 1600 });
      }
      break;
    }
    case 'v':
    case 'V':
      if (!e.repeat) setCompare(true);
      break;
    case 'c':
    case 'C':
      pinNote();
      break;
    case 'Enter':
      if (store.ui.selected && getEl(store.ui.selected)) editText(store.ui.selected);
      else handled = false;
      break;
    case '?':
      toggleSheet();
      break;
    case '/':
      if (e.shiftKey) toggleSheet();
      else handled = false;
      break;
    case 'Escape':
      if (cancelOverlay()) break;
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
        break;
      }
      if (store.ui.selected) select(null);
      else handled = false;
      break;
    default:
      handled = false;
  }
  if (handled) e.preventDefault();
  void isEditingText;
}
