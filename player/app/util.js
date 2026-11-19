// Small helpers shared by every module. No dependencies.

/** Create an element. h('div.a.b', { onclick, title }, child, 'text', [more]) */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className += (node.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') node[k] = v;
      else if (k in node && k !== 'list' && k !== 'type' && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : String(c));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}

/** Inline icon. 1.8 px rounded strokes, frames as 3:2 rounded rectangles. */
const ICONS = {
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  redo: '<path d="M15 7H9a5 5 0 0 0 0 10h5"/><path d="M12 4l3 3-3 3"/>',
  split: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 17M8 16.5 20 7"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>',
  shape: '<rect x="4" y="4" width="10" height="10" rx="2"/><circle cx="15.5" cy="15.5" r="4.5"/>',
  captions: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M7 14.5h4M13 14.5h4M7 11h10"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
  marker: '<path d="M7 3.5h10v11l-5 4-5-4z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M4 4l16 16M10 6a9 9 0 0 1 2-.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.5 3.3M6.5 7.5A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4-1"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.5-2"/>',
  key: '<path d="M12 4l7 8-7 8-7-8z"/>',
  zoomin: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
  zoomout: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5"/>',
  safe: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="7" y="8" width="10" height="8" rx="1" stroke-dasharray="2 2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  loop: '<path d="M4 12a6 6 0 0 1 6-6h8m-3-3 3 3-3 3"/><path d="M20 12a6 6 0 0 1-6 6H6m3 3-3-3 3-3"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5m0-5-5 5"/>',
  full: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  compare: '<rect x="2.5" y="6" width="12" height="8" rx="2"/><rect x="9.5" y="10" width="12" height="8" rx="2"/>',
  frame: '<rect x="3" y="6" width="18" height="12" rx="3"/>',
  system: '<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M9 20.5h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z"/>',
  undo: '<path d="M9 7H15a5 5 0 0 1 0 10h-5"/><path d="M12 4 9 7l3 3"/>',
  jump: '<path d="M5 12h12m-4-4 4 4-4 4"/>',
  upload: '<path d="M12 16V5m-4.5 4.5L12 5l4.5 4.5"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  swap: '<path d="M5 8h13m-3-3 3 3-3 3"/><path d="M19 16H6m3-3-3 3 3 3"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  note: '<circle cx="12" cy="12" r="7.5"/>',
  edit: '<path d="M5 19h4l10-10-4-4L5 15z"/>',
  music: '<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z"/>',
  export: '<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M12 9v6m-2.5-2.5L12 15l2.5-2.5"/>',
  send: '<path d="M4 12l16-7-6.5 15-2.5-6z"/><path d="M11 14l9-9"/>',
  keys: '<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="M7 10.5h.01M10.3 10.5h.01M13.6 10.5h.01M17 10.5h.01M8 14h8"/>',
  image: '<rect x="3" y="6" width="18" height="12" rx="3"/><circle cx="9" cy="10.5" r="1.5"/><path d="M5 17l5-4.5 3 2.5 3-2 3 2.5"/>',
};
export function icon(name, size = 18) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('icon');
  s.innerHTML = ICONS[name] || ICONS.frame;
  return s;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, d = 1) => {
  const m = 10 ** d;
  return Math.round(v * m) / m;
};

/** 72.4 -> "01:12.4" */
export function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const tenths = Math.floor(t * 10 + 1e-6);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function debounce(fn, ms) {
  let id = 0;
  const d = (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
  d.flush = (...args) => {
    clearTimeout(id);
    fn(...args);
  };
  return d;
}

export const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fetch JSON from the local server. Throws Error with a short message on failure. */
export async function api(path, opts = {}) {
  const init = { cache: 'no-store', ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    init.body = JSON.stringify(opts.json);
    delete init.json;
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || (typeof data === 'string' && data) || res.statusText;
    const err = new Error(String(msg).slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return data;
}

const etags = new Map(); // path → the ETag of the last answer

/**
 * GET a JSON API route that answers 304 when nothing changed (the server's sendJsonTagged): its data, or
 * undefined when it is the same as the last time this path was asked. Errors as api().
 */
export async function apiIfChanged(path) {
  const tag = etags.get(path);
  const res = await fetch(path, { cache: 'no-store', headers: tag ? { 'If-None-Match': tag } : {} });
  if (res.status === 304 && tag) return undefined;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    etags.delete(path);
    const msg = (data && (data.error || data.message)) || (typeof data === 'string' && data) || res.statusText;
    throw Object.assign(new Error(String(msg).slice(0, 200)), { status: res.status });
  }
  const next = res.headers.get('ETag');
  if (next) etags.set(path, next);
  else etags.delete(path);
  return data;
}

/** URL of a project file served by the server. */
export function projectUrl(p) {
  if (!p) return '';
  if (/^(https?:|blob:|data:)/.test(p) || p.startsWith('/p/')) return p;
  if (p.startsWith('/')) return p; // already an absolute server path
  return '/p/' + p.split('/').map(encodeURIComponent).join('/');
}

export function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

/** Simple pub/sub. */
export class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.map.get(type).delete(fn);
  }
  emit(type, detail) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(detail);
      } catch (e) {
        console.warn('[motionsnip]', type, e);
      }
    }
  }
}

export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a === 'string' && typeof b === 'string') {
    if (/^#[0-9a-f]{3,8}$/i.test(a) && /^#[0-9a-f]{3,8}$/i.test(b)) return a.toLowerCase() === b.toLowerCase();
    return a.trim() === b.trim();
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function sameBox(a, b, tol = 0.6) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  for (let i = 0; i < 4; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > tol) return false;
  return true;
}

let toastHost = null;
export function toast(message, { kind = '', ms = 3200 } = {}) {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div.toast' + (kind ? '.toast-' + kind : ''), message);
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function isTyping(target) {
  const t = target || document.activeElement;
  if (!t || t === document.body) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].includes(type);
  }
  return false;
}

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

let uid = 0;
export function newId(prefix = 'c') {
  uid += 1;
  return `${prefix}${Date.now().toString(36)}${uid.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
