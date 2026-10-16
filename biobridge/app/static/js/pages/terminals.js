/* Terminals: every device the account's biometric connections bring in, shown
 * per connection, read-only, failed connections included. Connections with
 * several terminals fold. Managing a connection (sync, edit, test) lives in
 * Settings. */

import { api } from '../api.js';
import { empty, esc, fmtAgo, loading, pill } from '../ui.js';

function deviceState(d, source) {
  if (d.over_plan_limit) {
    return `<span data-tip="Beyond your plan's device limit: its punches are kept but not sent to Odoo until you upgrade.">${pill('pending', 'over plan limit')}</span>`;
  }
  if (d.missing_since) return pill('missing', 'missing');
  // Disabled, or behind a connection that is failing: not collecting punches.
  return d.is_enabled && (!source || source.status === 'connected') ? pill('active', 'active') : pill('skipped', 'inactive');
}

/* View choices live for the browser, not the account: try/catch because storage
 * can be unavailable. */
const VIEW = { group: 'connection' };  // always by connection for now

let FOLDED = new Set();   // "<group mode>:<group id>" folded shut
try { FOLDED = new Set(JSON.parse(localStorage.getItem('bb.terminals.folded') || '[]')); } catch { /* none */ }

const NO_COMPANY = '__none';
const isConnected = (source) => source.status === 'connected';
const companyOf = (device, source) => device?.company_name || source.default_company_name || null;
const companyPill = (name) => (name ? ` <span class="pill mute">${esc(name)}</span>` : '');
// Header line: the address as saved. The IP column drops the internal scheme
// tag (zk://, adms://), which only tells the backend the protocol.
const addressOf = (source) => (source.provider === 'zk_adms'
  ? `serial ${String(source.base_url || '').replace(/^adms:\/\//i, '')}`
  : source.base_url);
const ipOf = (source) => String(source.base_url || '').replace(/^(zk|adms):\/\//i, '');

/* One row per terminal, plus one for a connection that has none yet (a device
 * not reached, say) so a failed connection still shows. */
function buildRows(sources, devicesBySource) {
  const rows = [];
  for (const source of sources) {
    const devices = devicesBySource[source.id] || [];
    if (!devices.length) rows.push({ source, device: null });
    devices.forEach((device) => rows.push({ source, device }));
  }
  return rows;
}

const applyFilters = (rows) => rows;   // no filters for now: every connection and terminal shows

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = VIEW.group === 'company' ? (companyOf(row.device, row.source) ?? NO_COMPANY) : row.source.id;
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(row);
  }
  const list = [...groups.values()];
  if (VIEW.group === 'company') {
    list.sort((a, b) => (a.key === NO_COMPANY) - (b.key === NO_COMPANY) || a.key.localeCompare(b.key));
  } else {
    list.sort((a, b) => a.rows[0].source.name.localeCompare(b.rows[0].source.name));
  }
  return list;
}

function terminalRow({ source, device }, withConnection) {
  if (!device) {
    return `<tr>
      <td>${esc(source.name)}${companyPill(source.default_company_name)}</td><td class="mono">—</td>
      ${withConnection ? `<td>${esc(source.name)}</td>` : ''}
      <td class="mono">${esc(ipOf(source) || '—')}</td><td class="num">—</td><td>—</td>
      <td>${pill('skipped', 'inactive')}</td></tr>`;
  }
  return `<tr>
    <td>${esc(device.alias || device.serial_number)}${companyPill(companyOf(device, source))}</td>
    <td class="mono">${esc(device.serial_number)}</td>
    ${withConnection ? `<td>${esc(source.name)}</td>` : ''}
    <td class="mono">${esc(device.ip_address || '—')}</td>
    <td class="num">${esc(device.punch_count)}</td>
    <td>${esc(device.last_seen_at ? fmtAgo(device.last_seen_at) : '—')}</td>
    <td>${deviceState(device, source)}</td></tr>`;
}

function groupCard(group) {
  const byCompany = VIEW.group === 'company';
  const first = group.rows[0].source;
  const terminals = group.rows.filter((r) => r.device);
  const foldId = `${VIEW.group}:${group.key}`;
  const collapsible = terminals.length > 1;
  const folded = collapsible && FOLDED.has(foldId);
  const title = byCompany ? (group.key === NO_COMPANY ? 'No Company Set' : group.key) : first.name;
  const pills = byCompany ? '' : pill(first.status);
  const sub = byCompany ? '' : `<div class="hint mono" style="margin-top:2px${collapsible ? ';margin-left:22px' : ''}">${esc(addressOf(first))}</div>`;
  return `
    <div class="card" style="margin-bottom:14px">
      <div class="item-head"${collapsible ? ` data-fold="${esc(foldId)}" role="button" tabindex="0"
          aria-expanded="${folded ? 'false' : 'true'}" style="cursor:pointer"` : ''}>
        <div style="min-width:0">
          <div class="row" style="gap:8px;align-items:center">
            ${collapsible ? `<span class="chev" aria-hidden="true" style="display:inline-block;width:14px">${folded ? '▸' : '▾'}</span>` : ''}
            <strong>${esc(title)}</strong>
            ${pills}
            ${collapsible ? `<span class="hint">${terminals.length} terminals</span>` : ''}
          </div>
          ${sub}
        </div>
      </div>
      <div class="scroll terminal-list" style="margin-top:12px"${folded ? ' hidden' : ''}>
        <table>
          <thead><tr><th>Device</th><th>Serial</th>${byCompany ? '<th>Connection</th>' : ''}<th>IP</th><th class="num">Punches</th><th>Last Seen</th><th>State</th></tr></thead>
          <tbody>${group.rows.map((r) => terminalRow(r, byCompany)).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

export async function renderTerminals(mount) {
  mount.innerHTML = loading();
  const [sources, devices] = await Promise.all([
    api.get('/sources'),
    api.get('/devices').catch(() => []),
  ]);
  const devicesBySource = {};
  devices.forEach((d) => { (devicesBySource[d.source_id] ||= []).push(d); });

  if (!sources.length) {
    mount.innerHTML = `
      <div class="card">
        ${empty('No Biometric Connections Yet', 'Add a BioTime server or a standalone device, then its terminals show up here.')}
        <div class="row" style="justify-content:center"><a class="btn primary-link" href="#/settings/biometric?add=1">Add Connection</a></div>
      </div>`;
    return;
  }

  const all = buildRows(sources, devicesBySource);

  mount.innerHTML = `
    <div class="page-bar">
      <span class="hint" id="tCount"></span>
      <div class="row" style="gap:8px;align-items:center">
        <a class="btn sm" href="#/settings/biometric">Manage Connections</a>
      </div>
    </div>
    <div id="tList"></div>`;

  const paint = () => {
    const rows = applyFilters(all);
    const terminals = rows.filter((r) => r.device).length;
    const conns = new Set(rows.map((r) => r.source.id)).size;
    mount.querySelector('#tCount').textContent =
      `${terminals} terminal${terminals === 1 ? '' : 's'} across ${conns} connection${conns === 1 ? '' : 's'}`;
    const list = mount.querySelector('#tList');
    list.innerHTML = rows.length
      ? groupRows(rows).map(groupCard).join('')
      : `<div class="card">${empty('No Terminals Match', 'Add a connection in Settings to see its terminals.')}</div>`;

    list.querySelectorAll('[data-fold]').forEach((head) => {
      const toggle = () => {
        const id = head.dataset.fold;
        const folding = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', folding ? 'false' : 'true');
        const chev = head.querySelector('.chev');
        if (chev) chev.textContent = folding ? '▸' : '▾';
        const body = head.closest('.card')?.querySelector('.terminal-list');
        if (body) body.hidden = folding;
        if (folding) FOLDED.add(id); else FOLDED.delete(id);
        try { localStorage.setItem('bb.terminals.folded', JSON.stringify([...FOLDED])); } catch { /* fine */ }
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  };

  paint();
}
