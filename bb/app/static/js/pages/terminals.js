/* Terminals: every device the account's biometric connections bring in, in
 * one table. Narrow it by protocol (BioTime, ZKTeco, Hikvision, ...) or group
 * it by protocol or by connection. Sync Now and the default company belong to
 * a connection, not a terminal, so they sit in a strip above the table. */

import { api, auth } from '../api.js';
import { empty, esc, fmtAgo, loading, pill, toast } from '../ui.js';
import { syncSource } from './settings.js';

function deviceState(d) {
  if (d.over_plan_limit) {
    return `<span data-tip="Beyond your plan's device limit: its punches are kept but not sent to Odoo until you upgrade.">${pill('pending', 'over plan limit')}</span>`;
  }
  if (d.missing_since) return pill('missing', 'missing');
  return d.is_enabled ? pill('active', 'active') : pill('skipped', 'inactive');
}

/* Company pickers. Shown only when the Odoo has more than one company on,
 * because with one there is nowhere wrong for a terminal's punches to go. */
let COMPANIES = [];

const companyOptions = (selected, blank) => `
  <option value="">${esc(blank)}</option>
  ${COMPANIES.map((c) => `<option value="${esc(c.id)}"${Number(selected) === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}`;

function deviceCompanyCell(d, source) {
  const inherited = source.default_company_name;
  const held = d.held_punch_count
    ? ` <span data-tip="${esc(d.held_punch_count)} punch(es) are waiting for review until this terminal has the right company.">${pill('pending', `${d.held_punch_count} held`)}</span>`
    : '';
  if (!auth.canWrite) return `${esc(d.company_name || inherited || '—')}${held}`;
  const blank = inherited ? `Connection default (${inherited})` : 'Not set';
  return `<select class="sm" data-device-company="${esc(d.id)}" aria-label="Company for ${esc(d.alias || d.serial_number)}">
      ${companyOptions(d.company_id, blank)}</select>${held}`;
}

async function saveDeviceCompany(select) {
  const id = select.value ? Number(select.value) : null;
  const name = id ? COMPANIES.find((c) => c.id === id)?.name || null : null;
  await api.patch(`/devices/${select.dataset.deviceCompany}`, { company_id: id, company_name: name });
}

async function saveSourceCompany(select) {
  const id = select.value ? Number(select.value) : null;
  const name = id ? COMPANIES.find((c) => c.id === id)?.name || null : null;
  await api.put(`/sources/${select.dataset.sourceCompany}/default-company`, { company_id: id, company_name: name });
}

const syncButton = (source, label = 'Sync Now') => (auth.canWrite && source.is_active !== false
  ? `<button class="sm primary" data-sync-source="${esc(source.id)}"
             title="Pull ${esc(source.name)}'s punches now and push them to Odoo">${esc(label)}</button>`
  : '');


/* View choices live for the browser, not the account: try/catch because storage
 * can be unavailable. */
const VIEW = { protocol: 'all', group: 'none', q: '' };
try {
  VIEW.protocol = localStorage.getItem('bb.terminals.protocol') || 'all';
  VIEW.group = localStorage.getItem('bb.terminals.group') || 'none';
} catch { /* keep the defaults */ }
const remember = (key, value) => { try { localStorage.setItem(`bb.terminals.${key}`, value); } catch { /* fine */ } };

let PROTOCOLS = {};   // provider slug -> label

const protocolOf = (source) => PROTOCOLS[source.provider] || source.provider || '—';

/* One row per terminal. A standalone device that has not been recognised yet
 * has no terminal record, so it shows as its connection, flagged as such. */
function buildRows(sources, devicesBySource) {
  const rows = [];
  for (const source of sources) {
    const devices = devicesBySource[source.id] || [];
    if (!devices.length && source.connection_kind === 'device') {
      rows.push({ source, device: null });
    }
    devices.forEach((device) => rows.push({ source, device }));
  }
  return rows;
}

const addressOf = (row) => row.device?.ip_address
  || (row.source.connection_kind === 'device' ? row.source.base_url.replace(/^zk:\/\//i, '') : '—');

function rowHtml({ source, device }, showCompany) {
  if (!device) {
    return `<tr>
      <td><strong>${esc(source.name)}</strong></td><td class="mono">—</td>
      <td>${esc(source.name)}</td><td>${esc(protocolOf(source))}</td>
      <td class="mono">${esc(addressOf({ source, device }))}</td><td>—</td>
      <td class="num">—</td><td>—</td>${showCompany ? '<td>—</td>' : ''}
      <td><span class="hint" data-tip="Recorded the first time Test connection reaches the device (Settings → Biometric connections)">Not Recognised Yet</span></td>
    </tr>`;
  }
  return `<tr>
    <td><strong>${esc(device.alias || device.serial_number)}</strong></td>
    <td class="mono">${esc(device.serial_number)}</td>
    <td>${esc(source.name)}</td>
    <td>${esc(protocolOf(source))}</td>
    <td class="mono">${esc(addressOf({ source, device }))}</td>
    <td>${esc(device.area || '—')}</td>
    <td class="num">${esc(device.punch_count)}</td>
    <td>${esc(device.last_seen_at ? fmtAgo(device.last_seen_at) : '—')}</td>
    ${showCompany ? `<td>${deviceCompanyCell(device, source)}</td>` : ''}
    <td>${deviceState(device)}</td>
  </tr>`;
}

function tableHtml(rows, sources, showCompany) {
  if (!rows.length) {
    return `<div class="card">${empty('No Terminals Match', 'Clear the search or pick another protocol.')}</div>`;
  }
  const cols = 9 + (showCompany ? 1 : 0);
  const groupKey = (r) => (VIEW.group === 'protocol' ? protocolOf(r.source)
    : VIEW.group === 'connection' ? r.source.name : '');
  const groups = new Map();
  rows.forEach((r) => {
    const key = groupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const body = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => `
    ${VIEW.group === 'none' ? '' : `<tr class="group-row"><td colspan="${cols}"><strong>${esc(key)}</strong>
      <span class="hint">${list.length} terminal${list.length === 1 ? '' : 's'}</span></td></tr>`}
    ${list.map((r) => rowHtml(r, showCompany)).join('')}`).join('');
  return `
    <div class="card">
      <div class="scroll">
        <table class="tight-table">
          <thead><tr><th>Terminal</th><th>Serial</th><th>Connection</th><th>Protocol</th><th>Address</th><th>Area</th>
            <th class="num">Punches</th><th>Last Seen</th>${showCompany ? '<th>Company</th>' : ''}<th>State</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

/* The connections behind the table: what Sync Now and the default company act on. */
function connectionsStrip(sources, showCompany) {
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="scroll">
        <table class="tight-table">
          <thead><tr><th>Connection</th><th>Protocol</th><th>Type</th><th>Status</th>${showCompany ? '<th>Default Company</th>' : ''}<th></th></tr></thead>
          <tbody>
            ${sources.map((source) => `
              <tr>
                <td><strong>${esc(source.name)}</strong></td>
                <td>${esc(protocolOf(source))}</td>
                <td>${source.connection_kind === 'device' ? 'Standalone Device' : 'Platform Server'}</td>
                <td><span data-tip="Checked ${esc(fmtAgo(source.last_checked_at))}">${pill(source.status)}</span></td>
                ${showCompany ? `<td>${source.connection_kind !== 'device' && auth.canWrite
                  ? `<select class="sm" data-source-company="${esc(source.id)}"
                       data-tip="Every terminal of this connection belongs to this company unless it sets its own.">${companyOptions(source.default_company_id, 'Not set')}</select>`
                  : esc(source.default_company_name || '—')}</td>` : ''}
                <td class="actions-cell"><div class="row-actions">${syncButton(source)}</div></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* Companies that are switched on for the account's Odoo connection; [] when
 * there is no Odoo yet or it cannot be reached (the pickers then stay hidden). */
async function loadCompanies() {
  try {
    const conns = await api.get('/odoo-connections');
    const conn = conns.find((c) => c.is_active !== false) || conns[0];
    if (!conn) return [];
    const all = await api.get(`/odoo-connections/${conn.id}/companies`);
    const off = new Set(conn.disabled_company_ids || []);
    return all.filter((c) => !off.has(c.id) && (conn.company_id == null || c.id === conn.company_id));
  } catch {
    return [];
  }
}


export async function renderTerminals(mount, route) {
  mount.innerHTML = loading();
  const [sources, devices, providers] = await Promise.all([
    api.get('/sources'),
    api.get('/devices').catch(() => []),
    api.get('/providers').catch(() => []),
  ]);
  PROTOCOLS = Object.fromEntries(providers.map((p) => [p.slug, p.label]));
  COMPANIES = await loadCompanies();
  const devicesBySource = {};
  devices.forEach((d) => { (devicesBySource[d.source_id] ||= []).push(d); });

  if (!sources.length) {
    mount.innerHTML = `
      <div class="card">
        ${empty('No Biometric Connections Yet', 'Add a BioTime server or a standalone device, then its terminals show up here.')}
        ${auth.canWrite ? '<div class="row" style="justify-content:center"><a class="btn primary-link" href="#/settings/biometric?add=1">Add Connection</a></div>' : ''}
      </div>`;
    return;
  }

  const showCompany = COMPANIES.length > 1;
  const all = buildRows(sources, devicesBySource);
  // A protocol that no longer exists among the connections falls back to All.
  const used = [...new Set(sources.map((s) => s.provider))];
  if (VIEW.protocol !== 'all' && !used.includes(VIEW.protocol)) VIEW.protocol = 'all';

  const needle = VIEW.q.trim().toLowerCase();
  const shown = all.filter(({ source, device }) =>
    (VIEW.protocol === 'all' || source.provider === VIEW.protocol)
    && (!needle || [device?.alias, device?.serial_number, device?.ip_address, source.name]
      .some((v) => String(v || '').toLowerCase().includes(needle))));
  const shownSources = sources.filter((s) => VIEW.protocol === 'all' || s.provider === VIEW.protocol);
  const count = (slug) => all.filter((r) => slug === 'all' || r.source.provider === slug).length;

  mount.innerHTML = `
    <div class="page-bar">
      <span class="hint">${all.length} terminal${all.length === 1 ? '' : 's'} across ${sources.length} connection${sources.length === 1 ? '' : 's'}</span>
      <a class="btn sm" href="#/settings/biometric">Manage Connections</a>
    </div>
    <div class="list-toolbar" style="margin-bottom:14px">
      <label class="hint">Protocol:
        <select id="tProtocol" class="sm" aria-label="Filter by protocol">
          <option value="all">All Protocols (${count('all')})</option>
          ${used.sort((a, b) => (PROTOCOLS[a] || a).localeCompare(PROTOCOLS[b] || b)).map((slug) =>
            `<option value="${esc(slug)}"${VIEW.protocol === slug ? ' selected' : ''}>${esc(PROTOCOLS[slug] || slug)} (${count(slug)})</option>`).join('')}
        </select>
      </label>
      <label class="hint">Group By:
        <select id="tGroup" class="sm" aria-label="Group terminals">
          ${[['none', 'None'], ['protocol', 'Protocol'], ['connection', 'Connection']].map(([v, l]) =>
            `<option value="${v}"${VIEW.group === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <div class="search-box" style="max-width:260px;margin-left:auto">
        <input id="tSearch" type="search" placeholder="Search terminals…" value="${esc(VIEW.q)}" aria-label="Search terminals">
      </div>
    </div>
    ${connectionsStrip(shownSources, showCompany)}
    ${tableHtml(shown, sources, showCompany)}
  `;

  mount.querySelector('#tProtocol').addEventListener('change', (e) => {
    VIEW.protocol = e.target.value; remember('protocol', VIEW.protocol); renderTerminals(mount, route);
  });
  mount.querySelector('#tGroup').addEventListener('change', (e) => {
    VIEW.group = e.target.value; remember('group', VIEW.group); renderTerminals(mount, route);
  });
  let timer;
  mount.querySelector('#tSearch').addEventListener('input', (e) => {
    VIEW.q = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await renderTerminals(mount, route);
      const box = mount.querySelector('#tSearch');
      box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    }, 250);
  });

  const onPick = (selector, save) => mount.querySelectorAll(selector).forEach((select) => {
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await save(select);
        await renderTerminals(mount, route);
      } catch (err) {
        select.disabled = false;
        toast(err.message || 'Could not save the company', 'bad');
      }
    });
  });
  onPick('[data-device-company]', saveDeviceCompany);
  onPick('[data-source-company]', saveSourceCompany);

  mount.querySelectorAll('[data-sync-source]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const label = button.textContent;
      button.textContent = 'Syncing…';
      await syncSource(button.dataset.syncSource);
      button.disabled = false;
      button.textContent = label;
      await renderTerminals(mount, route);
    });
  });
}
