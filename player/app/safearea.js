// Safe-area guides over the frame. Title/action safe for any shape; for vertical video, the parts of the
// screen that Reels, TikTok and Shorts cover with their own buttons and captions. The platform zones are
// approximate (they move with app versions and devices), drawn as percentages of a 9:16 frame.

import { h } from './util.js';

export const SAFE_KINDS = [
  ['off', 'No guides'],
  ['title', 'Title / action safe'],
  ['reels', 'Reels UI'],
  ['tiktok', 'TikTok UI'],
  ['shorts', 'Shorts UI'],
];

// [left, top, width, height] in % of the frame, and a label
export const PLATFORM_ZONES = {
  reels: [
    [0, 0, 100, 14, 'Top bar'],
    [0, 65, 100, 35, 'Caption and buttons'],
    [86, 40, 14, 25, 'Action rail'],
  ],
  tiktok: [
    [0, 0, 100, 8, 'Top bar'],
    [0, 77, 100, 23, 'Caption and sound'],
    [87, 38, 13, 39, 'Action rail'],
  ],
  shorts: [
    [0, 0, 100, 10, 'Top bar'],
    [0, 76, 100, 24, 'Caption and channel'],
    [86, 42, 14, 34, 'Action rail'],
  ],
};

/** Draw the guides for `kind` into `layer` (an absolutely placed box over the frame). */
export function renderSafe(layer, kind) {
  if (!layer) return;
  layer.className = 'safe-layer' + (kind && kind !== 'off' ? ' is-on' : '');
  if (!kind || kind === 'off') return layer.replaceChildren();
  if (kind === 'title') {
    // action safe 93%, title safe 90% (EBU R95)
    return layer.replaceChildren(
      h('div.safe-rect.is-action', { style: 'inset:3.5%' }, h('span.safe-tag', 'Action safe')),
      h('div.safe-rect.is-title', { style: 'inset:5%' }, h('span.safe-tag', 'Title safe')),
    );
  }
  const zones = PLATFORM_ZONES[kind] || [];
  layer.replaceChildren(
    ...zones.map(([x, y, w, hh, label]) =>
      h('div.safe-zone', { style: `left:${x}%;top:${y}%;width:${w}%;height:${hh}%` }, h('span.safe-tag', label)),
    ),
  );
}

/** Which zones cover the point (x, y) in % of the frame: for review findings and the agent tools. */
export function zonesAt(kind, x, y) {
  return (PLATFORM_ZONES[kind] || []).filter(([zx, zy, w, hh]) => x >= zx && x <= zx + w && y >= zy && y <= zy + hh).map((z) => z[4]);
}
