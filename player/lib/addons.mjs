// Add-ons: optional features that live outside the core, each in its own folder with an addon.json.
//
//   ~/.motionsnip/addons/<id>/addon.json   (or the folders in MOTIONSNIP_ADDONS, or --addons <dir>)
//   {
//     "id": "hello",           // a-z, 0-9 and dashes; the same as the folder name
//     "name": "Hello",
//     "version": "1.0.0",
//     "core": 1,               // the add-on API it was written for (ADDON_API)
//     "server": "server.mjs",  // optional: export default async function setup(addon) { addon.route(...) }
//     "app": "app.js",         // optional: export default async function start(host) { ... } in the player
//     "requires": "pro",       // optional: the licence it needs; without that licence it stays locked
//     "released": "2026-12-01", // optional: its release date; a lapsed licence still runs versions released
//                              // while it was paid for (lib/licence.mjs; for Pro, the signed package date counts)
//     "provides": { "kits": ["ui.terminal"] }  // optional: the timeline kit clips it draws ({ type: "kit" })
//   }
//
// An add-on that can't load (a bad manifest, an older API, an error in setup) is reported and left out;
// the core and the other add-ons carry on. An add-on that needs a licence the user doesn't have is locked:
// its code isn't loaded and its files aren't served. Add-on code runs with the same rights as the core,
// like any program you install, so only install add-ons you trust.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ADDON_API = 1;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROUTE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KIT = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;
const SETUP_MS = 5000;

/** Where add-ons are looked for: MOTIONSNIP_ADDONS (a path list) or ~/.motionsnip/addons. */
export function defaultAddonDirs(env = process.env, home = os.homedir()) {
  if (env.MOTIONSNIP_ADDONS) return env.MOTIONSNIP_ADDONS.split(path.delimiter).filter(Boolean);
  return [path.join(home, '.motionsnip', 'addons')];
}

/** A file named by a manifest, inside the add-on's folder, or null. */
function entryFile(dir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) return null;
  if (!/\.(mjs|js)$/.test(file)) return null;
  return file;
}

/** What's wrong with a manifest in folder `dir`, or null when it's fine. */
export function checkManifest(m, dir) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'addon.json is not an object';
  if (typeof m.id !== 'string' || !ID.test(m.id)) return 'id must be lowercase letters, digits and dashes';
  if (m.id !== path.basename(dir)) return `id "${m.id}" doesn't match its folder "${path.basename(dir)}"`;
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is missing';
  if (typeof m.version !== 'string' || !m.version.trim()) return 'version is missing';
  if (m.core !== ADDON_API) return `written for add-on API ${JSON.stringify(m.core)}; this MotionSnip has API ${ADDON_API}`;
  if (m.server === undefined && m.app === undefined) return 'needs a server or an app file';
  for (const k of ['server', 'app']) {
    if (m[k] === undefined) continue;
    const f = entryFile(dir, m[k]);
    if (!f) return `${k} must be a .mjs or .js file inside the add-on folder`;
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return `${k} file not found: ${m[k]}`;
  }
  if (m.requires !== undefined && (typeof m.requires !== 'string' || !ID.test(m.requires))) return 'requires must be a licence name';
  if (m.released !== undefined && (typeof m.released !== 'string' || !/^\d{4}-\d\d-\d\d/.test(m.released) || !Number.isFinite(Date.parse(m.released)))) return 'released must be a date (YYYY-MM-DD)';
  if (m.provides !== undefined) {
    if (!m.provides || typeof m.provides !== 'object' || Array.isArray(m.provides)) return 'provides must be an object';
    const k = m.provides.kits;
    if (k !== undefined && (!Array.isArray(k) || k.length > 200 || !k.every((n) => typeof n === 'string' && KIT.test(n)))) return 'provides.kits must be a list of kit names (like ui.terminal)';
  }
  return null;
}

/** Every add-on folder under the given dirs: [{ dir, manifest, error }]. Hidden folders are skipped. */
export function discoverAddons(dirs) {
  const found = [];
  for (const base of dirs) {
    let names;
    try {
      names = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // a missing folder means no add-ons there
    }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.name.startsWith('.')) continue;
      // a folder, or a link to one (an add-on being developed elsewhere); the id is the name it has here
      const dir = path.resolve(base, d.name);
      if (!d.isDirectory() && !(d.isSymbolicLink() && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())) continue;
      const file = path.join(dir, 'addon.json');
      if (!fs.existsSync(file)) continue;
      let manifest = null;
      let error = null;
      try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        error = checkManifest(manifest, dir);
      } catch (e) {
        error = `addon.json: ${e.message}`;
      }
      found.push({ dir, manifest, error });
    }
  }
  return found;
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms).unref?.())]);

/**
 * Discover and start add-ons. Returns a Map id → add-on:
 *   { id, name, version, dir, state: 'on' | 'locked' | 'error', reason, app (file) | null, routes: Map('GET name' → handler) }
 * opts.entitled(name, { released }) says whether a licence for it is held (by default none is).
 * opts.helpers are handed to every server setup() as addon.helpers.
 */
export async function loadAddons(dirs, { entitled = () => false, helpers = {}, log = () => {} } = {}) {
  const addons = new Map();
  for (const { dir, manifest: m, error } of discoverAddons(dirs)) {
    const id = path.basename(dir); // a good manifest's id is its folder's name
    const a = { id, name: (m && typeof m.name === 'string' && m.name) || id, version: (m && typeof m.version === 'string' && m.version) || '', dir, state: 'error', reason: '', app: null, routes: new Map(), kits: [] };
    if (addons.has(id)) {
      log(`Add-on ${id} in ${dir} skipped: an add-on with that id is already loaded from ${addons.get(id).dir}`);
      continue;
    }
    addons.set(id, a);
    if (error) {
      a.reason = error;
      log(`Add-on ${id} not loaded: ${error}`);
      continue;
    }
    if (m.requires && !entitled(m.requires, { released: m.released })) {
      a.state = 'locked';
      a.reason = `Needs a ${m.requires} licence`;
      continue;
    }
    if (m.server) {
      try {
        // ?t= the file's time: after an update in place, the new code loads, not the cached module
        const file = entryFile(dir, m.server);
        const mod = await import(`${pathToFileURL(file).href}?t=${Math.round(fs.statSync(file).mtimeMs)}`);
        if (typeof mod.default !== 'function') throw new Error(`${m.server} has no default export function`);
        const api = {
          id,
          dir,
          version: a.version,
          helpers,
          log: (...args) => log(`[${id}]`, ...args),
          /** Answer METHOD /api/addons/<id>/<name>. handler(req, res, { url }) */
          route(method, name, handler) {
            if (!['GET', 'POST'].includes(method)) throw new Error(`route method must be GET or POST, not ${method}`);
            if (typeof name !== 'string' || !ROUTE.test(name)) throw new Error(`route name must be lowercase letters, digits and dashes: ${name}`);
            if (typeof handler !== 'function') throw new Error(`route ${name} needs a handler function`);
            a.routes.set(`${method} ${name}`, handler);
          },
        };
        await withTimeout(Promise.resolve(mod.default(api)), SETUP_MS, 'setup');
      } catch (e) {
        a.routes.clear();
        a.reason = `setup failed: ${e.message}`;
        log(`Add-on ${id} not loaded: ${a.reason}`);
        continue;
      }
    }
    a.app = m.app ? entryFile(dir, m.app) : null;
    a.kits = m.provides?.kits || [];
    a.state = 'on';
    log(`Add-on ${a.name} ${a.version} on`);
  }
  return addons;
}

/** The add-on list the player sees. */
export function addonList(addons) {
  return [...addons.values()].map((a) => ({
    id: a.id,
    name: a.name,
    version: a.version,
    state: a.state,
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.state === 'on' && a.app ? { app: `/addons/${a.id}/${path.relative(a.dir, a.app).split(path.sep).join('/')}?t=${Math.round(fs.statSync(a.app, { throwIfNoEntry: false })?.mtimeMs || 0)}` } : {}),
    ...(a.state === 'on' && a.kits.length ? { kits: a.kits } : {}),
  }));
}
