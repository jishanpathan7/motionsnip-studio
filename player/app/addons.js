// Add-ons in the player: each add-on that is on and has an app file is imported, and its default export
// is called with a small host. An add-on that fails to start is reported and left out; the player carries on.
//
//   export default async function start(host) {
//     host.addHeaderButton({ label: 'Hello', icon: 'send', title: 'Say hello', onClick: async () => host.toast((await host.api('hello')).text) });
//   }
//
// host: { id, name, version, store, bus, h, icon, toast, api(name, opts), url(file), addHeaderButton({ label, icon, title, onClick }),
//         registerKit(name, def), addToolButton({ label, icon, title, onClick }), addKitClip(clip) }
// store and bus are the player's own; an add-on reads them and listens, and changes the project through the API.

import { store, bus } from './state.js';
import { api, h, icon, toast } from './util.js';
import { registerKit } from './comp/graphics.mjs';
import { addToolButton, addKitClip } from './tracks.js';

export const addons = { list: [] };

/** Start the add-ons. `anchor`: header buttons go just before it. */
export async function initAddons({ anchor }) {
  let data;
  try {
    data = await api('/api/addons');
  } catch {
    return; // an older server without add-ons
  }
  addons.list = Array.isArray(data?.addons) ? data.addons : [];
  for (const a of addons.list) {
    if (a.state !== 'on' || !a.app) continue;
    try {
      const mod = await import(a.app);
      if (typeof mod.default !== 'function') throw new Error('its app file has no default export function');
      await mod.default(hostFor(a, anchor));
    } catch (e) {
      console.error(`Add-on ${a.id}:`, e);
      toast(`The ${a.name} add-on couldn't start: ${e.message}`, { kind: 'error', ms: 6000 });
    }
  }
  bus.emit('addons', { list: addons.list });
}

function hostFor(a, anchor) {
  return {
    id: a.id,
    name: a.name,
    version: a.version,
    store,
    bus,
    h,
    icon,
    toast,
    /** Call this add-on's server route: /api/addons/<id>/<name>. */
    api: (name, opts) => api(`/api/addons/${a.id}/${name}`, opts),
    /** The URL of a file in this add-on's folder. */
    url: (file) => `/addons/${a.id}/${String(file).replace(/^\/+/, '')}`,
    /** A button in the header, before Export. Returns the button. */
    addHeaderButton({ label, icon: ic, title, onClick }) {
      if (typeof onClick !== 'function') throw new Error('addHeaderButton needs an onClick function');
      const b = h('button.btn.btn-ghost', { type: 'button', title: title || label, dataset: { addon: a.id }, onclick: onClick }, ic ? icon(ic, 16) : null, label ? h('span', label) : null);
      if (!label) b.setAttribute('aria-label', title || a.name);
      anchor.before(b);
      return b;
    },
    /**
     * Draw timeline kit clips named `name` ({ type: 'kit', kit: name, params }). The name must be listed in the
     * add-on's addon.json provides.kits. def: { label, draw(g, { params, u, dur, w, h, W, H, img, clip }) }.
     */
    registerKit(name, def) {
      if (!(a.kits || []).includes(name)) throw new Error(`registerKit: ${name} isn't in provides.kits of ${a.id}'s addon.json`);
      registerKit(name, def);
    },
    /** A button in the timeline toolbar's add group (timeline projects). */
    addToolButton({ label, icon: ic, title, onClick }) {
      if (typeof onClick !== 'function') throw new Error('addToolButton needs an onClick function');
      addToolButton({ label, icon: ic, title, onClick });
    },
    /** Add a kit clip at the playhead: { kit, params, dur?, box? }. False when the project isn't a timeline. */
    addKitClip: (clip) => addKitClip(clip),
  };
}
