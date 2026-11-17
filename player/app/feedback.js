// Feedback: describe changes, build the markdown (spec section 5), Send, and the Check vN review.

import {
  store,
  bus,
  getEl,
  sceneOfEl,
  allNotes,
  sceneStatus,
  persist,
  flushPersist,
  assetName,
  sceneAt,
  unsentChanges,
  dismissedFindings,
} from './state.js';
import { api, copyText, fmtTime, round, sameValue, sameBox, toast } from './util.js';
import { hasEdits as plainEdits, summary as plainSummary } from './vedit.js';
import { resolveOutput } from './reel.mjs';

const q = (v) => {
  if (v == null) return 'none';
  if (typeof v === 'number') return String(round(v, 3));
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
};
const num = (v) => (v == null ? 'none' : String(round(+v, 3)));
const boxStr = (b) => `[${b.map((v) => round(v, 1)).join(', ')}]`;

const AUDIO_LABEL = {
  music: 'Music track',
  musicOffset: 'Music start offset (s)',
  musicFade: 'Music fade-out (s)',
  musicVol: 'Music volume (0-1)',
  sfxVol: 'Effects volume (0-1)',
};

export function audioLabel(field) {
  if (field === 'sfxVol' && store.reel.audio.videoAudio === 'mix') return 'Video sound volume (0-1)';
  return AUDIO_LABEL[field] || field;
}

function isUploaded(id) {
  return store.data.uploads.some((u) => u.id === id) || /^assets\//.test(id || '') && !store.reel.assets.some((a) => a.id === id);
}

/**
 * One line per change, in the spec's format, plus a short label for the UI.
 * Returns { section, line, short, detail, at, sceneId }.
 */
/** For a scene: the same move in scene pixels (things stand on their bottom centre), so Claude can edit "place". */
function sceneMove(c, el, sc) {
  const reel = store.master;
  if (!reel?.scene || !el?.entity || !c.before || !c.after) return '';
  const [x, y, w, h] = c.before;
  const [nx, ny, nw, nh] = c.after;
  const dx = Math.round(((nx + nw / 2 - (x + w / 2)) / 100) * reel.w);
  const dy = Math.round(((ny + nh - (y + h)) / 100) * reel.h);
  const parts = [];
  if (dx || dy) parts.push(`move ${el.entity} by [${dx}, ${dy}] px in shot ${sc?.id || '?'}`);
  if (Math.abs((c.scale ?? 1) - 1) > 0.02) parts.push(`scale it by ${round(c.scale, 2)}`);
  return parts.length ? `: ${parts.join(', ')}` : '';
}

export function describe(c) {
  if (c.kind === 'prop') {
    const el = getEl(c.elId);
    const sc = sceneOfEl(c.elId);
    const p = el?.props[c.propKey];
    const at = Number.isFinite(c.at) ? c.at : el?.t[0] || 0;
    // a scene prop names its exact place in scene.json
    const src = p?.path && store.master?.scene ? ` (scene.json › ${p.path})` : el?.src ? ` (${el.src})` : '';
    return {
      section: 'edits',
      at,
      sceneId: sc?.id,
      line: `- [${fmtTime(at)} · ${sc?.id || '?'} · ${el?.label || c.elId}] ${p?.label || c.propKey}${src}: ${q(c.before)} -> ${q(c.after)}`,
      short: `${el?.label || c.elId} · ${p?.label || c.propKey}`,
      detail: `${short(c.before)} → ${short(c.after)}`,
    };
  }
  if (c.kind === 'box') {
    const el = getEl(c.elId);
    const sc = sceneOfEl(c.elId);
    const at = Number.isFinite(c.at) ? c.at : el?.t[0] || 0;
    const src = el?.src ? ` (${el.src})` : '';
    return {
      section: 'edits',
      at,
      sceneId: sc?.id,
      line: `- [${fmtTime(at)} · ${sc?.id || '?'} · ${el?.label || c.elId}] Size and position${src}: ${boxStr(c.before)} -> ${boxStr(c.after)} (scale ${round(c.scale ?? 1, 2)})${sceneMove(c, el, sc)}`,
      short: `${el?.label || c.elId} · Size and position`,
      detail: `${boxStr(c.after)} · scale ${round(c.scale ?? 1, 2)}`,
    };
  }
  if (c.kind === 'brand') {
    const col = store.reel.brand.colors.find((x) => x.id === c.colorId);
    return {
      section: 'edits',
      at: null,
      line: store.master?.scene
        ? `- [Look · Scene colour] ${col?.name || c.colorId} (scene.json › style.palette.${c.colorId}): ${q(c.before)} -> ${q(c.after)} (changes everything drawn in it)`
        : `- [Look · Brand colour] ${col?.name || c.colorId} (brand.${c.colorId}): ${q(c.before)} -> ${q(c.after)} (changes everything linked to it)`,
      short: `Brand colour · ${col?.name || c.colorId}`,
      detail: `${c.before} → ${c.after}`,
    };
  }
  if (c.kind === 'font') {
    const f = store.reel.brand.fonts.find((x) => x.id === c.fontId);
    return {
      section: 'edits',
      at: null,
      line: `- [Look · Font] ${f?.name || c.fontId} (brand.fonts.${c.fontId}): ${q(c.before)} -> ${q(c.after)}`,
      short: `Font · ${f?.name || c.fontId}`,
      detail: `${c.before} → ${c.after}`,
    };
  }
  if (c.kind === 'audio') {
    if (c.field === 'music') {
      const up = c.after && isUploaded(c.after) ? ' (uploaded in MotionSnip Studio, already in assets/)' : '';
      return {
        section: 'sound',
        at: null,
        line: `- Audio · Music track: ${q(c.before)} -> ${c.after ? q(c.after) : '"none" (remove the music)'}${up}`,
        short: 'Music track',
        detail: `${assetName(c.before)} → ${c.after ? assetName(c.after) : 'no music'}`,
      };
    }
    const vol = c.field === 'musicVol' || c.field === 'sfxVol';
    return {
      section: 'sound',
      at: null,
      line: `- Audio · ${audioLabel(c.field)}: ${num(c.before)} -> ${num(c.after)}`,
      short: audioLabel(c.field).replace(/ \(.*\)$/, ''),
      detail: vol ? `${Math.round((c.before ?? 0) * 100)}% → ${Math.round((c.after ?? 0) * 100)}%` : `${num(c.before)} s → ${num(c.after)} s`,
    };
  }
  if (c.kind === 'upload') {
    return {
      section: 'uploads',
      at: null,
      line: `- Audio · Uploaded ${q(c.asset.name)} to ${c.asset.id}`,
      short: `Uploaded ${c.asset.name}`,
      detail: c.asset.id,
    };
  }
  if (c.kind === 'note') {
    const scenes = c.out ? resolveOutput(store.master, c.out).scenes : store.master.scenes;
    const sc = scenes.find((s) => s.id === c.sceneId && c.t >= s.t[0] - 0.01 && c.t <= s.t[1] + 0.01) || scenes.find((s) => s.id === c.sceneId) || (c.out ? null : sceneAt(c.t));
    const el = c.elId && getEl(c.elId);
    const on = el ? ` · on ${el.label}${el.src ? ` (${el.src})` : ''}` : '';
    return {
      section: 'notes',
      at: c.t,
      sceneId: sc?.id,
      line: `[${fmtTime(c.t)} · ${sc ? sc.id + ' ' + sc.name : '?'} · x ${round(c.x, 1).toFixed(1)}% y ${round(c.y, 1).toFixed(1)}%${on}] ${c.text ? c.text.replace(/\s*\n\s*/g, ' ') : '(circled, no comment)'}${c.review ? ` (from your self-review, ${c.review}; the reviewer agrees)` : ''}`,
      short: c.text || 'No comment yet',
      detail: `${fmtTime(c.t)}${el ? ' · ' + el.label : ''}${c.review ? ' · spotted by Claude' : ''}`,
    };
  }
  return { section: 'other', at: null, line: `- ${c.kind}`, short: c.kind, detail: '' };
}

function short(v) {
  if (v == null) return 'none';
  if (Array.isArray(v)) return `${v.length} row${v.length === 1 ? '' : 's'}`;
  const s = String(v);
  return s.length > 40 ? s.slice(0, 38) + '…' : s;
}

// ---------------------------------------------------------------- markdown

export function buildMarkdown(list = store.data.changes) {
  const reel = store.master;
  const out = [];
  out.push(`MotionSnip Studio feedback for "${reel.title}" v${reel.version}`);
  if (reel.plain) out.push(`Video: ${reel.file || reel.src} (a plain video file, no reel.json) · ${reel.w}x${reel.h} · ${round(reel.duration, 2)}s`);
  else out.push(`Project: ${reel.path || '(unknown path)'} · ${reel.w}x${reel.h} · ${reel.fps} fps · ${round(reel.duration, 2)}s`);
  if (reel.scene) out.push('This is a MotionSnip scene: change scene.json (there is no reel.json; MotionSnip Studio builds the reel from the scene). Moved boxes mean: move that thing in that shot (its "place", or the "to" of the beat that moves it). Keep ids stable.');
  if (reel.reference) out.push(`Reference: ${reel.reference}`);

  const ds = list.map((c) => ({ c, d: describe(c) }));
  const by = (sec) => ds.filter((x) => x.d.section === sec);
  const edits = by('edits').sort((a, b) => (a.d.at ?? -1) - (b.d.at ?? -1));
  if (edits.length) {
    out.push('', '## Exact changes');
    for (const x of edits) out.push(x.d.line);
  }
  const sound = [...by('sound'), ...by('uploads')];
  if (sound.length) {
    out.push('', '## Sound settings');
    for (const x of sound) out.push(x.d.line);
    out.push(
      reel.audio.videoAudio === 'mix'
        ? 'Video sound: the video has the music baked in (a mix); an added track plays on top of it.'
        : 'Video sound: effects only; the music plays from its own file beside the video.',
    );
  }
  const ns = list.filter((c) => c.kind === 'note' && !c.out);
  if (ns.length) {
    out.push('', '## Comments on the frame');
    const all = allNotes().filter((n) => !n.out);
    for (const n of ns) out.push(`${all.indexOf(n) + 1 || ns.indexOf(n) + 1}. ${describe(n).line}`);
  }
  for (const o of reel.outputs) {
    const on = list.filter((c) => c.kind === 'note' && c.out === o.id);
    if (!on.length) continue;
    out.push('', `## Comments on the ${o.label} version (${o.id}: ${o.src}, ${o.w}x${o.h}, ${round(o.duration, 2)}s)`);
    if (o.kind === 'bumper') out.push(`Times are on the ${o.label} version's own clock; it is cut from the master at ${o.ranges.map(([a, b]) => `${fmtTime(a)}-${fmtTime(b)}`).join(', ')}.`);
    on.forEach((n, i) => out.push(`${i + 1}. ${describe(n).line}`));
  }
  const made = reel.outputs.filter((o) => o.by === 'player');
  if (made.length) {
    out.push('', '## Cutdowns made in MotionSnip Studio');
    out.push('MotionSnip Studio renders these itself from the master, so leave the files alone. Fix framing problems noted above in the master (keep the important things where these crops can see them); the reviewer re-renders the cutdowns after your next version.');
    for (const o of made) out.push(`- ${o.id} (${o.label}, ${o.w}x${o.h}): ${describeOutput(o)}`);
  }
  const gone = dismissedFindings();
  if (gone.length) {
    out.push('', '## Dismissed from your self-review');
    out.push('The reviewer looked at these and is happy as it is. Leave them, and don\'t flag them again.');
    for (const f of gone) out.push(`- ${f.id} [${fmtTime(f.t)}] ${f.title}`);
  }
  const nq = store.data.notQuite;
  if (nq.length) {
    const from = nq[0].from ?? reel.version - 1;
    out.push('', `## Not quite from v${from}`);
    for (const x of nq) out.push(`- ${x.text}${x.reason ? ' — ' + x.reason : ''}`);
  }
  if (reel.scenes.length) {
    out.push('', '## Scenes');
    for (const s of reel.scenes) {
      const st = sceneStatus(s.id);
      out.push(`${s.id} ${s.name} (${fmtTime(s.t[0])}-${fmtTime(s.t[1])}): ${st === 'approved' ? 'approved' : st === 'changes' ? 'needs changes' : 'in review'}`);
    }
  }
  if (reel.plain) {
    if (plainEdits()) {
      out.push('', `The reviewer is also editing this video in MotionSnip Studio (${plainSummary()}). Leave those to them: MotionSnip Studio applies them itself when it exports. Times above are in the original video.`);
    }
    out.push('', `Next version: this is a plain video file, not a MotionSnip project. Make the changes and export the new cut over the same file (${reel.src}); MotionSnip Studio counts that as v${reel.version + 1}.`);
  } else out.push('', `Next version: set "version" to ${reel.version + 1} in ${reel.scene ? 'scene.json' : 'reel.json'}.`);
  return out.join('\n') + '\n';
}

/** How a player-made output was cut from the master, in one line. */
export function describeOutput(o) {
  if (o.kind === 'bumper') return `${o.ranges.map(([a, b]) => `${fmtTime(a)}-${fmtTime(b)}`).join(' + ')} of the master`;
  if (o.kind === 'reframe') {
    const keys = o.keys.length ? o.keys.map((k) => `${fmtTime(k.t)} at ${round(k.cx, 1)}%,${round(k.cy, 1)}%`).join(', ') : 'centred';
    return o.mode === 'blurpad' ? 'the whole frame on a blurred fill' : `cropped${o.zoom > 1 ? ` at ${round(o.zoom, 2)}x zoom` : ''}, crop centre ${keys}`;
  }
  return o.src;
}

export function promptLine(path) {
  return `Apply the MotionSnip Studio feedback in ${path}`;
}

export function sendableCount() {
  return unsentChanges().length + store.data.notQuite.length;
}

/** Send to Claude: write the feedback file, copy the prompt, mark changes as sent. */
export async function send() {
  const reel = store.master;
  const list = unsentChanges();
  if (!list.length && !store.data.notQuite.length) {
    toast('Nothing to send yet. Change something or circle a problem first.');
    return null;
  }
  // everything still listed goes, so Claude sees the full picture (earlier sends included)
  const markdown = buildMarkdown(store.data.changes);
  let res;
  try {
    res = await api('/api/feedback', { json: { version: reel.version, markdown } });
  } catch (e) {
    toast(`Couldn't save the feedback: ${e.message}`, { kind: 'error', ms: 6000 });
    return null;
  }
  const line = promptLine(res.path);
  const copied = await copyText(line);
  for (const c of store.data.changes) c.sent = reel.version;
  store.data.pending = { version: reel.version, sentAt: Date.now(), path: res.path, line, count: store.data.changes.length };
  store.data.notQuite = [];
  store.data.check = null;
  persist();
  flushPersist();
  bus.emit('changes', { sent: true });
  bus.emit('pending', { pending: store.data.pending });
  toast(copied ? 'Prompt copied. Paste it into Claude.' : 'Saved. Copy the prompt from Changes and paste it into Claude.');
  return { line, copied, path: res.path, markdown };
}

// ---------------------------------------------------------------- Check vN

function matches(c) {
  const reel = store.master;
  if (c.kind === 'prop') {
    const p = getEl(c.elId)?.props[c.propKey];
    return !!p && sameValue(p.v, c.after);
  }
  if (c.kind === 'box') {
    const el = getEl(c.elId);
    return !!el?.box && sameBox(el.box, c.after);
  }
  if (c.kind === 'audio') return sameValue(reel.audio[c.field] ?? null, c.after ?? null);
  if (c.kind === 'brand') return sameValue(reel.brand.colors.find((x) => x.id === c.colorId)?.v, c.after);
  if (c.kind === 'font') return sameValue(reel.brand.fonts.find((x) => x.id === c.fontId)?.v, c.after);
  return false;
}

/** Build the Check view for a new version from the changes that had been sent. */
export function startCheck(sent, fromVersion) {
  const items = [];
  for (const c of sent) {
    if (c.kind === 'upload') continue;
    const d = describe(c);
    const auto = matches(c);
    items.push({
      key: c.key,
      kind: c.kind,
      text: c.kind === 'note' ? `Note: ${c.text || '(circled, no comment)'}` : `${d.short}: ${d.detail}`,
      at: c.kind === 'note' ? c.t : d.at,
      elId: c.elId || null,
      x: c.x,
      y: c.y,
      auto,
      verdict: auto ? 'ok' : null,
      reason: '',
    });
  }
  store.data.pending = null;
  store.data.check = items.length ? { from: fromVersion, to: store.master.version, items } : null;
  persist();
  bus.emit('check', { check: store.data.check });
  return store.data.check;
}

export function setVerdict(key, verdict, reason = '') {
  const ch = store.data.check;
  if (!ch) return;
  const it = ch.items.find((x) => x.key === key);
  if (!it) return;
  it.verdict = verdict;
  it.reason = reason;
  store.data.notQuite = store.data.notQuite.filter((x) => x.key !== key);
  if (verdict === 'no') store.data.notQuite.push({ key, text: it.text, reason, from: ch.from });
  persist();
  bus.emit('check', { check: ch });
  bus.emit('changes', { verdict: true });
}

export function finishCheck() {
  store.data.check = null;
  persist();
  bus.emit('check', { check: null });
}

export function checkSummary() {
  const ch = store.data.check;
  if (!ch) return null;
  const ok = ch.items.filter((x) => x.verdict === 'ok').length;
  const auto = ch.items.filter((x) => x.auto).length;
  const open = ch.items.filter((x) => !x.verdict).length;
  return { ok, auto, open, total: ch.items.length };
}
