// HTTP plumbing for the local server: content types, byte ranges, the origin check, reading request bodies and
// sending JSON, errors and files. Pure Node, no dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const JSON_LIMIT = 2 * 1024 * 1024; // 2 MB

export const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

/** File extension in lower case, without the dot ("" if none). */
export function extOf(name) {
  const e = path.extname(String(name || '')).slice(1).toLowerCase();
  return e;
}

export function mimeFor(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

/**
 * Parse a Range header against a file size.
 * Returns null      when there is no usable range (serve the whole file, 200),
 *         'unsatisfiable' when the range can't be met (416),
 *         { start, end } (inclusive) for a single satisfiable range (206).
 * Malformed and multi-range headers are ignored, as HTTP allows.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    // Suffix range: the last N bytes.
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
    if (b !== '' && end < start) return null; // invalid spec: ignore the header
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/** Host header must name this server (blocks DNS rebinding). */
export function hostAllowed(host, port) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  return h === `localhost:${port}` || h === `127.0.0.1:${port}`;
}

/** POSTs must come from the player page itself. */
export function originAllowed(origin, port) {
  if (typeof origin !== 'string') return false;
  const o = origin.trim().toLowerCase();
  return o === `http://localhost:${port}` || o === `http://127.0.0.1:${port}`;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > limit) return reject(httpError(413, 'Too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = JSON_LIMIT) {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || 'null');
  } catch {
    throw httpError(400, 'Body is not valid JSON');
  }
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

export const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': MIME.json, 'Content-Length': data.length });
  res.end(data);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** Stream a file, with byte ranges. */
export function sendFile(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendError(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendError(res, 404, 'Not found');
  const headers = { ...BASE_HEADERS, 'Content-Type': mimeFor(file), 'Accept-Ranges': 'bytes' };
  const range = parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  let status = 200;
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    status = 206;
    ({ start, end } = range);
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
