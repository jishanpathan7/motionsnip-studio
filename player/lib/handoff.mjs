// Send to Claude without copy and paste.
//
// While the user reviews, Claude keeps one request open to GET /api/feedback-next (through
// `node player/server.mjs --next-feedback --port <port>`, run in the background). When the user clicks
// Send to Claude, the player saves the feedback file and the server answers every open request with the
// prompt line. Claude's background command exits with that line, Claude picks it up in the same chat
// and starts on it. When nobody is listening, the player falls back to copying the prompt.
//
// MIT licence. Copyright (c) 2026 Jishan Pathan.

import http from 'node:http';
import { sendJson } from './http.mjs';

/** How long one listen request stays open before the server answers 204 and the listener asks again. */
export const LISTEN_HOLD_MS = 240_000;
/** Header a listener must send. Browsers can't add it to a cross-site request, so other pages can't listen. */
export const LISTEN_HEADER = 'x-motionsnip-listener';

export function promptLine(file) {
  return `Apply the MotionSnip Studio feedback in ${file}`;
}

/** The open listen requests of one server. */
export function createHandoff({ holdMs = LISTEN_HOLD_MS } = {}) {
  const waiting = new Set();
  const drop = (w) => {
    clearTimeout(w.timer);
    waiting.delete(w);
  };
  return {
    holdMs,
    get size() {
      return waiting.size;
    },
    /** Hold `res` open until the next delivery, or answer 204 after holdMs. */
    wait(res) {
      const w = { res, timer: null };
      w.timer = setTimeout(() => {
        drop(w);
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
        }
      }, this.holdMs);
      // fires when the answer is sent or the listener goes away first
      res.on('close', () => drop(w));
      waiting.add(w);
    },
    /** Answer every open listen request with `payload`. Returns how many listeners got it. */
    deliver(payload) {
      let n = 0;
      for (const w of [...waiting]) {
        drop(w);
        if (w.res.writableEnded || w.res.destroyed) continue;
        sendJson(w.res, 200, payload);
        n++;
      }
      return n;
    },
  };
}

function getOnce(port, host) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/feedback-next', headers: { host: `${host}:${port}`, [LISTEN_HEADER]: '1' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    r.on('error', reject);
  });
}

/**
 * Wait for the next Send to Claude and return its payload ({ path, line, version }). Asks again after each
 * 204. Rejects when the player can't be reached for `giveUpMs` in a row (it was closed), or answers an error.
 */
export async function nextFeedback({ port, host = 'localhost', retryMs = 1000, giveUpMs = 60_000 } = {}) {
  let downSince = null;
  for (;;) {
    let r;
    try {
      r = await getOnce(port, host);
    } catch (err) {
      downSince ??= Date.now();
      if (Date.now() - downSince >= giveUpMs) throw new Error(`MotionSnip Studio isn't running on port ${port} (${err.code || err.message})`);
      await new Promise((ok) => setTimeout(ok, retryMs));
      continue;
    }
    downSince = null;
    if (r.status === 204) continue;
    if (r.status !== 200) throw new Error(`MotionSnip Studio answered ${r.status}: ${r.text.slice(0, 200)}`);
    return JSON.parse(r.text);
  }
}
