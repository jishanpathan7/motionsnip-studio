// MotionSnip Pro on this computer: the licence (lib/licence.mjs) and the Pro add-on it unlocks.
//
//   createPro({ home, keys, server, fetch })  → pro
//   pro.status()                 what the licence is worth here (verifyLicence), plus nothing secret
//   pro.entitled(name, o)        for loadAddons: is the licence good for this add-on (o.released)
//   pro.activate(key)            licence server /activate → <home>/licence.json
//   pro.refresh()                licence server /refresh  (also quietly at start, when it ends within 7 days)
//   pro.deactivate()             licence server /deactivate, then the licence file goes
//   pro.install()                licence server /download → the signed Pro package, unpacked to <home>/addons/pro
//
// Errors are http errors (lib/http.mjs) with messages meant for the player.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { LICENCE_KEYS, LICENCE_SERVER, canonical, hashInstall, holds, installId, readLicence, removeLicence, verifyLicence, verifySigned, writeLicence } from './licence.mjs';
import { readTar } from './tar.mjs';
import { checkManifest } from './addons.mjs';
import { httpError } from './http.mjs';

export const PRO_ID = 'pro';
const PACKAGE_MAX = 100 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const REFRESH_WITHIN = 7 * 86400e3;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/;

/** The name the licence server gives the Pro package. */
export const PACKAGE_NAME = 'motionsnip-pro';
/** The text a package signature covers: the manifest's signed fields as canonical JSON (the licence key signs it too). */
export const packageSigText = ({ name, version, released, sha256, size }) => canonical({ name, version, released, sha256, size });

export async function createPro({ home, keys = LICENCE_KEYS, server = LICENCE_SERVER, fetch = globalThis.fetch, log = () => {} }) {
  let install = (await installId(home, { create: false })) || null;
  let hash = install ? hashInstall(install) : null;
  const addonsDir = path.join(home, 'addons');

  const status = () => verifyLicence(readLicence(home), { keys, install: hash });

  async function call(route, body) {
    let r;
    try {
      r = await fetch(`${server}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw httpError(503, "Couldn't reach the licence server. Check your connection and try again.");
    }
    const data = await r.json().catch(() => null);
    if (!r.ok) throw httpError(r.status >= 500 ? 502 : 400, String(data?.error || `The licence server answered ${r.status}`).slice(0, 200));
    if (!data || typeof data !== 'object') throw httpError(502, 'The licence server sent something unreadable');
    return data;
  }

  /** Check what the server sent and keep it. */
  async function keep(lic) {
    const st = verifyLicence(lic, { keys, install: hash });
    if (st.state === 'invalid' || st.state === 'none') throw httpError(502, "The licence server sent a licence that doesn't check out");
    await writeLicence(home, lic);
    return st;
  }

  return {
    home,
    addonsDir,
    status,
    entitled: (name, { released } = {}) => holds(status(), name, { released }),

    async activate(key) {
      key = typeof key === 'string' ? key.trim() : '';
      if (!KEY.test(key)) throw httpError(400, "That doesn't look like a licence key");
      install ||= await installId(home);
      hash = hashInstall(install);
      const data = await call('/activate', { key, install: hash });
      return keep(data.licence);
    },

    async refresh() {
      const lic = readLicence(home);
      if (!lic) throw httpError(409, 'No licence to refresh');
      const data = await call('/refresh', { licence: lic });
      return keep(data.licence);
    },

    /** Refresh when the licence ends within 7 days (or has ended); quiet when offline. */
    async maybeRefresh() {
      const st = status();
      if (st.state === 'none' || st.state === 'invalid' || st.expires === null) return false;
      if (Date.parse(st.expires) - Date.now() > REFRESH_WITHIN) return false;
      try {
        await this.refresh();
        return true;
      } catch (e) {
        log(`Pro licence not refreshed: ${e.message}`);
        return false;
      }
    },

    async deactivate() {
      const lic = readLicence(home);
      if (!lic) throw httpError(409, 'No licence on this computer');
      await call('/deactivate', { licence: lic });
      await removeLicence(home);
    },

    async install() {
      const st = status();
      if (!['valid', 'grace', 'fallback'].includes(st.state)) throw httpError(409, 'Activate a Pro licence first');
      const meta = await call('/download', { licence: readLicence(home) });
      const { name, version, released, sha256, size, sig, kid, url } = meta;
      if (
        name !== PACKAGE_NAME ||
        typeof version !== 'string' ||
        !/^[0-9A-Za-z.+-]{1,40}$/.test(version) ||
        typeof released !== 'string' ||
        typeof sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > PACKAGE_MAX
      )
        throw httpError(502, 'The licence server sent a package description that is unreadable');
      if (!verifySigned(packageSigText({ name, version, released, sha256, size }), sig, kid, keys)) throw httpError(502, "The Pro package isn't signed by MotionSnip");
      let bytes;
      try {
        const u = new URL(url, server);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('not https');
        const r = await fetch(u, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (Number(r.headers.get('content-length')) > PACKAGE_MAX) throw new Error('too big');
        bytes = Buffer.from(await r.arrayBuffer());
      } catch (e) {
        throw httpError(503, `Couldn't download the Pro add-on (${e.message}). Try again.`);
      }
      if (bytes.length !== size) throw httpError(502, "The Pro package didn't arrive whole. Try again.");
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) throw httpError(502, "The Pro package didn't arrive whole. Try again.");
      let entries;
      try {
        entries = readTar(bytes);
      } catch (e) {
        throw httpError(502, e.message);
      }
      // unpack beside the add-ons, check it, then swap it in: an old Pro stays until the new one is complete
      await fsp.mkdir(addonsDir, { recursive: true });
      const stage = await fsp.mkdtemp(path.join(addonsDir, '.pro-new-'));
      const dir = path.join(stage, PRO_ID);
      try {
        for (const e of entries) {
          const p = path.join(dir, ...e.path.split('/'));
          if (e.dir) await fsp.mkdir(p, { recursive: true });
          else {
            await fsp.mkdir(path.dirname(p), { recursive: true });
            await fsp.writeFile(p, e.data);
          }
        }
        let manifest = null;
        try {
          manifest = JSON.parse(await fsp.readFile(path.join(dir, 'addon.json'), 'utf8'));
        } catch {}
        const err = checkManifest(manifest, dir);
        if (err) throw httpError(502, `The Pro package is broken: ${err}`);
        const target = path.join(addonsDir, PRO_ID);
        const old = path.join(stage, 'old');
        if (fs.existsSync(target)) await fsp.rename(target, old);
        await fsp.rename(dir, target);
        return { version: manifest.version };
      } finally {
        await fsp.rm(stage, { recursive: true, force: true });
      }
    },
  };
}
