// MotionSnip Pro: a header button and a dialog to activate a licence key, install the Pro add-on, refresh and
// deactivate. Shown only when the server manages licences (/api/licence answers), so the demo site and older
// servers show nothing.

import { api, h, icon, toast } from './util.js';

const pro = { dlg: null, body: null, data: null, busy: '', error: '', btn: null, key: '' };

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** Add the Pro button before `anchor` when the server has licences. */
export async function initPro({ anchor }) {
  try {
    pro.data = await api('/api/licence');
  } catch {
    return; // no licences on this server
  }
  pro.btn = h('button.btn.btn-ghost', { type: 'button', title: 'MotionSnip Pro', onclick: open }, icon('key', 16), h('span.btn-label', 'Pro'));
  anchor.before(pro.btn);
  pro.dlg = h('dialog.dialog.pro-dialog', { 'aria-labelledby': 'pro-title' });
  pro.body = h('div.dialog-body');
  pro.dlg.append(pro.body);
  pro.dlg.addEventListener('click', (e) => {
    if (e.target === pro.dlg) pro.dlg.close();
  });
  document.body.append(pro.dlg);
  mark();
}

function mark() {
  const s = pro.data?.state;
  pro.btn.classList.toggle('is-on', s === 'valid' || s === 'grace' || s === 'fallback');
}

async function open() {
  pro.error = '';
  render();
  pro.dlg.showModal();
  try {
    pro.data = await api('/api/licence');
    render();
  } catch {}
}

/** Run a licence action; `then` after success (e.g. reload so the add-on's player code starts). */
async function act(what, route, json, then) {
  pro.busy = what;
  pro.error = '';
  render();
  try {
    pro.data = await api(`/api/licence/${route}`, { json: json || {} });
    pro.key = '';
    mark();
    if (then) await then();
  } catch (e) {
    pro.error = e.message;
  } finally {
    pro.busy = '';
    render();
  }
}

const reload = (msg) => async () => {
  if (pro.data?.addon?.state === 'on') {
    toast(msg);
    setTimeout(() => location.reload(), 700);
  }
};

async function activate(key) {
  await act('Activating…', 'activate', { key }, async () => {
    if (!pro.data.addon || pro.data.addon.state !== 'on') {
      pro.busy = 'Installing the Pro add-on…';
      render();
      pro.data = await api('/api/licence/install', { json: {} });
    }
    await reload('Pro is on. Reloading the player…')();
  });
}

function render() {
  const d = pro.data || {};
  const busy = !!pro.busy;
  const kids = [
    h(
      'div.dialog-head',
      h('h2', { id: 'pro-title' }, 'MotionSnip Pro'),
      h('button.btn.btn-ghost.btn-xs', { type: 'button', 'aria-label': 'Close', onclick: () => pro.dlg.close() }, icon('x', 16)),
    ),
  ];
  const held = d.state === 'valid' || d.state === 'grace' || d.state === 'fallback';

  if (!held) {
    kids.push(h('p.muted', 'Pro adds the UI-demo kit to timeline projects: app and browser windows, a terminal, a code editor, a cursor with clicks, typing and notifications. Everything else in MotionSnip stays free.'));
    if (d.state === 'expired' || d.state === 'invalid') kids.push(h('div.warn.warn-bad', d.reason));
    const input = h('input.input.mono', { type: 'text', placeholder: 'Licence key', 'aria-label': 'Licence key', autocomplete: 'off', spellcheck: false, disabled: busy, value: pro.key });
    input.addEventListener('input', () => (pro.key = input.value));
    const go = () => input.value.trim() && activate(input.value.trim());
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    kids.push(
      h('div.field', h('div.field-row', h('label.field-label', 'Licence key')), input),
      h('p.hint', 'Activating sends the key and a random ID for this computer to licence.motionsnip.com. Nothing else leaves your machine.'),
    );
    if (pro.error) kids.push(h('div.warn.warn-bad', pro.error));
    kids.push(
      h(
        'div.dialog-foot',
        d.buy ? h('a.btn.btn-ghost', { href: d.buy, target: '_blank', rel: 'noopener' }, 'Get a licence') : null,
        h('button.btn.btn-primary', { type: 'button', disabled: busy, onclick: go }, icon('key', 16), pro.busy || 'Activate'),
      ),
    );
  } else {
    const line =
      d.state === 'fallback'
        ? `Your subscription ended. Pro versions released before ${day(d.updatesUntil)} keep working.`
        : d.expires === null
          ? 'Active: a lifetime licence.'
          : d.state === 'grace'
            ? `Renewal due: paid until ${day(d.periodEnd)}, works until ${day(d.expires)}.`
            : `Active: paid until ${day(d.periodEnd)}. Works offline until ${day(d.expires)}.`;
    kids.push(h('p', line));
    const a = d.addon;
    if (!a) kids.push(h('div.warn', "The Pro add-on isn't installed on this computer yet."));
    else if (a.state === 'on') kids.push(h('p.muted', `Pro add-on ${a.version} is on.`));
    else kids.push(h('div.warn.warn-bad', `Pro add-on ${a.version}: ${a.reason || a.state}`));
    if (pro.error) kids.push(h('div.warn.warn-bad', pro.error));
    kids.push(
      h(
        'div.dialog-foot',
        h('button.btn.btn-ghost', { type: 'button', disabled: busy, title: 'Free this licence key for another computer', onclick: () => confirm('Deactivate Pro on this computer? You can activate the key again later.') && act('Deactivating…', 'deactivate', null, async () => location.reload()) }, 'Deactivate'),
        h('button.btn.btn-ghost', { type: 'button', disabled: busy, onclick: () => act('Checking…', 'refresh') }, pro.busy === 'Checking…' ? 'Checking…' : 'Check licence'),
        h(
          'button.btn.btn-primary',
          { type: 'button', disabled: busy, onclick: () => act('Installing…', 'install', null, reload('Pro add-on updated. Reloading the player…')) },
          icon('upload', 16),
          pro.busy === 'Installing…' ? 'Installing…' : a ? 'Update the add-on' : 'Install the add-on',
        ),
      ),
    );
  }
  pro.body.replaceChildren(...kids);
}
