// ProjectStore: where a project's own files live. The server's routes read and write a project only through one
// of these, so they don't depend on the project being a folder on this computer. localStore is that folder; a
// hosted edition can implement the same methods over a database and object storage.
//
// Paths are project-relative, with '/' between parts. A path that would leave the project is refused: reads
// give null, writes throw. Every method that touches files is async.
//
//   root                     the folder (a local store only)
//   path(rel)                where rel is on disk, or null when it leaves the project. For engines that need a real
//                            path (ffmpeg, export.cmd); a remote store would fetch the file into a local cache.
//   rel(abs)                 the project-relative path of a path inside the folder
//   file(rel)                the path on disk of an existing file, or null
//   stat(rel)                { file, dir, size, mtimeMs }, or null when it isn't there
//   list(rel)                the entries of a folder: [{ name, file, dir, size, mtimeMs }]; [] when it isn't there
//   readText(rel)            the text of a file, or null when it isn't there
//   readJson(rel)            a JSON file parsed, or null when it isn't there or isn't valid JSON
//   writeText(rel, data, o)  write a file whole, atomically (o.create: fail with code EEXIST if it is there)
//   remove(rel, o)           delete a file (o.recursive: a folder); nothing happens if it isn't there
//   copy(from, to)           copy a file atomically (a clone where the disk can)
//   freeName(dir, name)      the rel of a name in dir that isn't taken yet (name, name-2, name-3…)
//   addFile(dir, name, tmp)  move a finished temp file into dir under a name that isn't taken; never overwrites
//
// The project's own state (what the player saves, feedback, takes, the last render, cutdowns) lives under META.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveInside, numberedName } from './files.mjs';

export const META = '.motionsnip';

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

function outside(rel) {
  return Object.assign(new Error(`Path must be inside the project: ${rel}`), { code: 'EOUTSIDE' });
}

async function statOf(p) {
  try {
    const st = await fsp.stat(p);
    return { file: st.isFile(), dir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** A copy-on-write clone (APFS) when the platform has one; false when it didn't work. */
function cloneFile(from, to) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn('cp', ['-c', from, to], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** The ProjectStore of a folder on this computer. */
export function localStore(dir) {
  const root = path.resolve(dir);
  const abs = (rel) => (typeof rel === 'string' ? resolveInside(root, rel) : null);
  const must = (rel) => {
    const p = abs(rel);
    if (!p || p === root) throw outside(rel);
    return p;
  };
  const store = {
    kind: 'local',
    root,
    path: abs,
    rel: (p) => path.relative(root, p).split(path.sep).join('/'),

    async file(rel) {
      const p = abs(rel);
      return p && (await statOf(p))?.file ? p : null;
    },

    async stat(rel) {
      const p = abs(rel);
      return p ? statOf(p) : null;
    },

    async list(rel = '') {
      const p = abs(rel);
      if (!p) return [];
      let entries;
      try {
        entries = await fsp.readdir(p, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of entries) {
        const st = await statOf(path.join(p, e.name));
        if (st) out.push({ name: e.name, ...st });
      }
      return out;
    },

    async readText(rel) {
      const p = abs(rel);
      if (!p) return null;
      try {
        return await fsp.readFile(p, 'utf8');
      } catch (err) {
        if (MISSING.has(err.code)) return null;
        throw err;
      }
    },

    async readJson(rel) {
      const text = await store.readText(rel);
      if (text == null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },

    async writeText(rel, data, { create = false } = {}) {
      const p = must(rel);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      if (create) return void (await fsp.writeFile(p, data, { flag: 'wx' }));
      const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, p);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    },

    async remove(rel, { recursive = false } = {}) {
      const p = abs(rel);
      if (p && p !== root) await fsp.rm(p, { force: true, recursive });
    },

    async copy(from, to) {
      const src = abs(from);
      if (!src) throw outside(from);
      const dest = must(to);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
      try {
        if (!(await cloneFile(src, tmp))) await fsp.copyFile(src, tmp, fs.constants.COPYFILE_FICLONE);
        await fsp.rename(tmp, dest);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    },

    async freeName(dirRel, name) {
      const d = abs(dirRel);
      if (!d) throw outside(dirRel);
      await fsp.mkdir(d, { recursive: true });
      for (let n = 1; n < 10000; n++) {
        const p = path.join(d, numberedName(name, n));
        if (!(await statOf(p))) return store.rel(p);
      }
      throw new Error('No free file name');
    },

    async addFile(dirRel, name, tmp) {
      const d = abs(dirRel);
      if (!d) throw outside(dirRel);
      await fsp.mkdir(d, { recursive: true });
      // link fails when the name is taken, so nothing is ever overwritten
      for (let n = 1; n < 10000; n++) {
        const p = path.join(d, numberedName(name, n));
        try {
          await fsp.link(tmp, p);
          await fsp.rm(tmp, { force: true });
          return store.rel(p);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      throw new Error('No free file name');
    },
  };
  return store;
}
