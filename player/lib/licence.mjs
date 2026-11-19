// The MotionSnip Pro licence: a small file signed by the licence server, checked here with no network.
//
//   <home>/licence.json       home is $MOTIONSNIP_HOME or ~/.motionsnip
//   { "v": 1, "kid": "k1",
//     "claims": { "sub": key id, "act": activation id, "plan": "pro", "features": ["pro"],
//                 "install": sha256 of <home>/install-id, "issued": ISO,
//                 "expires": ISO | null, "updates_until": ISO | null },
//     "sig": base64url Ed25519 signature of canonical(claims) }
//
// A licence holds a feature when its signature checks out against one of LICENCE_KEYS, it was issued to this
// install, and either it hasn't expired (expires is the paid period's end plus 14 days; null never expires) or
// the add-on asking was released on or before updates_until (you keep the versions released while you paid).
//
// The only network calls MotionSnip makes are here and only when you use Pro: activate, refresh, deactivate and
// downloading the Pro add-on. They send the licence key (or the licence) and the install ID's hash, nothing else.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** kid → the licence server's public key: raw Ed25519, base64url. */
export const LICENCE_KEYS = { k1: 'obw0MGPBmo6LdUoQg_UWOxgzkgcbWQm8nKQw00obnDU' };
/** Where licences and the Pro add-on come from. */
export const LICENCE_SERVER = 'https://licence.motionsnip.com';
export const GRACE_DAYS = 14;

const DAY = 86400e3;
const STATES = ['valid', 'grace', 'fallback', 'expired', 'invalid', 'none'];

/** The folder MotionSnip keeps its own files in: $MOTIONSNIP_HOME, else ~/.motionsnip. */
export function motionsnipHome(env = process.env, home = os.homedir()) {
  return env.MOTIONSNIP_HOME ? path.resolve(env.MOTIONSNIP_HOME) : path.join(home, '.motionsnip');
}

/** JSON with object keys sorted at every level: the bytes a licence signature covers. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const keyCache = new Map();
function publicKey(b64) {
  if (!keyCache.has(b64)) {
    let k = null;
    try {
      k = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' });
    } catch {}
    keyCache.set(b64, k);
  }
  return keyCache.get(b64);
}

/** Does sig (base64url) sign text with the key kid names in keys? */
export function verifySigned(text, sig, kid, keys = LICENCE_KEYS) {
  const b64 = typeof kid === 'string' && Object.hasOwn(keys, kid) ? keys[kid] : null;
  const key = b64 && publicKey(b64);
  if (!key || typeof sig !== 'string' || !/^[A-Za-z0-9_-]{80,90}$/.test(sig)) return false;
  try {
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export const hashInstall = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');

/** This computer's install ID (random, made the first time it's needed), or with create: false null if none yet. */
export async function installId(home, { create = true } = {}) {
  const file = path.join(home, 'install-id');
  try {
    const id = (await fsp.readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{32,64}$/.test(id)) return id;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!create) return null;
  await fsp.mkdir(home, { recursive: true });
  const id = crypto.randomBytes(16).toString('hex');
  try {
    await fsp.writeFile(file, id + '\n', { flag: 'wx', mode: 0o600 });
    return id;
  } catch (e) {
    if (e.code === 'EEXIST') return installId(home, { create: false });
    throw e;
  }
}

/** The licence file, parsed, or null. */
export function readLicence(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'licence.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Write the licence file atomically, readable only by you. */
export async function writeLicence(home, lic) {
  await fsp.mkdir(home, { recursive: true });
  const file = path.join(home, 'licence.json');
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(lic, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export const removeLicence = (home) => fsp.rm(path.join(home, 'licence.json'), { force: true });

const isoOrNull = (v) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

/**
 * What a licence is worth here:
 *   { state, reason, plan, features, issued, expires, periodEnd, updatesUntil }
 * state: 'none' (no licence) · 'invalid' (not signed by us, another computer, or malformed) · 'valid' ·
 * 'grace' (past the paid period, within the 14 days) · 'fallback' (expired; versions released up to
 * updatesUntil still work) · 'expired' (expired, nothing to fall back to).
 */
export function verifyLicence(lic, { keys = LICENCE_KEYS, now = Date.now(), install = null } = {}) {
  const out = { state: 'none', reason: '', plan: null, features: [], issued: null, expires: null, periodEnd: null, updatesUntil: null };
  if (!lic) return out;
  const bad = (reason) => ({ ...out, state: 'invalid', reason });
  if (typeof lic !== 'object' || lic.v !== 1 || !lic.claims || typeof lic.claims !== 'object') return bad('The licence file is damaged');
  const c = lic.claims;
  if (!verifySigned(canonical(c), lic.sig, lic.kid, keys)) return bad("The licence isn't signed by the MotionSnip licence server");
  if (typeof c.plan !== 'string' || !Array.isArray(c.features) || !c.features.every((f) => typeof f === 'string')) return bad('The licence file is damaged');
  if (!isoOrNull(c.expires) || !isoOrNull(c.updates_until ?? null) || typeof c.issued !== 'string') return bad('The licence file is damaged');
  if (!install || c.install !== install) return bad('This licence was activated on another computer');
  const expires = c.expires === null ? Infinity : Date.parse(c.expires);
  const info = {
    ...out,
    plan: c.plan,
    features: c.features,
    issued: c.issued,
    expires: c.expires,
    periodEnd: c.expires === null ? null : new Date(expires - GRACE_DAYS * DAY).toISOString(),
    updatesUntil: c.updates_until ?? null,
  };
  if (now <= expires) return { ...info, state: now > expires - GRACE_DAYS * DAY ? 'grace' : 'valid' };
  if (info.updatesUntil) return { ...info, state: 'fallback', reason: 'The subscription ended; versions released while it ran keep working' };
  return { ...info, state: 'expired', reason: 'The licence has expired' };
}

/** Does a verified licence hold `feature` for an add-on released on `released` (ISO date, optional)? */
export function holds(status, feature, { released } = {}) {
  if (!status || !status.features?.includes(feature)) return false;
  if (status.state === 'valid' || status.state === 'grace') return true;
  if (status.state !== 'fallback' || !released) return false;
  const r = Date.parse(released);
  return Number.isFinite(r) && r <= Date.parse(status.updatesUntil);
}

export { STATES as LICENCE_STATES };
