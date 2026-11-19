// Files and names: upload name cleaning, content sniffing, staying inside the project folder, reel.json parsing,
// free names, atomic writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { extOf } from './http.mjs';

export const AUDIO_EXTS = ['mp3', 'wav', 'm4a'];

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp']; // logos and pictures put on a plain video

export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm']; // what a browser <video> can usually play

/**
 * Reduce an upload name to a safe file name: letters, digits, "-", "_", ".";
 * no path parts, no leading dot, at most 80 characters, extension kept.
 * Returns null when the extension isn't one of `exts`.
 */
export function cleanName(raw, exts = AUDIO_EXTS) {
  let name = String(raw ?? '').replace(/\0/g, '');
  name = name.split(/[\\/]/).pop() || ''; // drop any path parts
  const ext = extOf(name);
  if (!ext || !exts.includes(ext)) return null;
  let stem = name.slice(0, name.length - ext.length - 1);
  stem = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: é -> e
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-_]+/, '')
    .replace(/[.\-]+$/, '');
  const maxStem = 80 - ext.length - 1;
  if (stem.length > maxStem) stem = stem.slice(0, maxStem).replace(/[.\-]+$/, '');
  if (!stem) stem = 'upload';
  return `${stem}.${ext}`;
}

/** Name for the n-th copy: "song.mp3" -> "song-2.mp3". */
export function numberedName(name, n) {
  if (n <= 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
}

/** Guess an audio type from its first bytes: 'mp3' | 'wav' | 'm4a' | null. */
export function sniffAudio(buf) {
  if (!buf || buf.length < 4) return null;
  const ascii = (from, to) => buf.subarray(from, to).toString('latin1');
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 8 && ascii(4, 8) === 'ftyp') return 'm4a';
  return null;
}

/** Guess an image type from its first bytes: 'png' | 'jpg' | 'webp' | null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  const ascii = (from, to) => buf.subarray(from, to).toString('latin1');
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Guess a video container from its first bytes: 'iso' (mp4, m4v, mov) | 'webm' | null. */
export function sniffVideo(buf) {
  if (!buf || buf.length < 8) return null;
  const box = buf.subarray(4, 8).toString('latin1');
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'iso';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

/** Resolve a URL/request path inside `root`; null if it would escape. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, '.' + path.sep + rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** Parse reel.json. Plain JSON first; then tolerate // and /* *\/ comments and trailing commas. */
export function parseReel(text) {
  try {
    return JSON.parse(text);
  } catch (first) {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch {
      throw first;
    }
  }
}

export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Turn an id into a safe file-name piece. */
export function slug(s) {
  const v = String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return v || 'reel';
}

/** Local time as YYYYMMDD-HHMMSS. */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First name that doesn't exist yet in `dir`: name, name-2, name-3... */
export function freePath(dir, name) {
  for (let n = 1; n < 10000; n++) {
    const p = path.join(dir, numberedName(name, n));
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('no free file name');
}

/** Write a file atomically (temp file + rename). */
export async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
