'use strict';
/**
 * Admin panel — create a session, name the six tables, hand out the links.
 *
 * This is the only surface used before the room fills, so it optimises for
 * "get six laptops pointed at the right dashboards without a mistake": every
 * link is one click to copy, and each team's link resolves to their sector so
 * nobody types a URL under time pressure.
 */
(function admin() {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let meta = null;
  let current = null;
  let pollTimer = null;

  // -- transport --------------------------------------------------------------

  async function api(url, { bounceOn401 = true, ...options } = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));

    // A 401 mid-session means the cookie expired: bounce to login. On the
    // login call itself it just means wrong credentials, so let the server's
    // own message through instead of overwriting it with "unauthorised".
    if (res.status === 401 && bounceOn401) {
      showLogin();
      throw new Error(data.error || 'Session expired — sign in again.');
    }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  // -- views ------------------------------------------------------------------

  function showLogin() {
    stopPolling();
    $('login-view').hidden = false;
    $('app-view').hidden = true;
  }

  function showApp(user) {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('who').textContent = `${user.name} · ${user.email}`;
  }

  function showSection(which) {
    for (const id of ['list-view', 'create-view', 'detail-view']) {
      $(id).hidden = id !== which;
    }
    // Only the list needs to stay fresh; a detail page is edited, not watched.
    if (which === 'list-view') startPolling(); else stopPolling();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => loadSessions({ quiet: true }), 10000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // -- login ------------------------------------------------------------------

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.hidden = true;
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        bounceOn401: false,
        body: { email: $('login-email').value, password: $('login-password').value },
      });
      $('login-password').value = '';
      showApp(user);
      await boot();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    showLogin();
  });

  // -- session list -----------------------------------------------------------

  async function loadSessions({ quiet = false } = {}) {
    const includeEnded = $('show-ended').checked;
    let data;
    try {
      data = await api(`/api/admin/sessions${includeEnded ? '?all=1' : ''}`);
    } catch {
      return;   // an expired cookie already bounced us to the login view
    }

    const host = $('sessions');
    if (!data.sessions.length) {
      host.innerHTML = `<div class="empty-state">
        No sessions yet.<br>Create one, name the six tables, then hand each table its join link.</div>`;
      return;
    }

    host.innerHTML = data.sessions.map((s) => {
      const live = s.live_state
        ? `<span><span class="dot-live"></span>${esc(s.live_state.mode)} · ${esc(s.live_state.round)} · core ${s.live_state.core_integrity}</span>`
        : '';
      const connected = s.connected ? `<span>${s.connected} connected</span>` : '';
      return `<div class="card" data-code="${esc(s.code)}">
          <div>
            <div class="nm">${esc(s.name)}</div>
            <div class="meta">
              <span class="code">${esc(s.code)}</span>
              ${s.client_name ? `<span>${esc(s.client_name)}</span>` : ''}
              <span>${s.team_count} teams</span>
              <span>${esc(s.facilitator_name)}</span>
              ${live}${connected}
            </div>
          </div>
          <div class="right"><span class="status ${esc(s.status)}">${esc(s.status)}</span></div>
        </div>`;
    }).join('');

    for (const card of host.querySelectorAll('.card')) {
      card.addEventListener('click', () => openSession(card.dataset.code));
    }
    if (!quiet) showSection('list-view');
  }

  $('show-ended').addEventListener('change', () => loadSessions());

  // -- create -----------------------------------------------------------------

  $('btn-new').addEventListener('click', () => {
    $('create-form').reset();
    $('create-error').hidden = true;
    $('new-teams').innerHTML = meta.sectors.map((s) => `
      <div class="tf">
        <div class="sec"><span class="swatch" style="background:${esc(s.colour)}"></span>${esc(s.code)}</div>
        <input type="text" data-sector="${esc(s.code)}" placeholder="${esc(s.name)}">
      </div>`).join('');
    showSection('create-view');
  });

  $('btn-cancel-create').addEventListener('click', () => showSection('list-view'));

  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('create-error');
    err.hidden = true;
    const teams = {};
    for (const input of $('new-teams').querySelectorAll('input')) {
      if (input.value.trim()) teams[input.dataset.sector] = input.value.trim();
    }
    try {
      const { session } = await api('/api/admin/sessions', {
        method: 'POST',
        body: {
          name: $('new-name').value,
          client_name: $('new-client').value,
          teams,
        },
      });
      await openSession(session.code);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  });

  // -- detail -----------------------------------------------------------------

  $('btn-back').addEventListener('click', () => { current = null; loadSessions(); });

  async function openSession(code) {
    const data = await api(`/api/admin/sessions/${encodeURIComponent(code)}`);
    current = { ...data.session, control_token: data.control_token };
    renderDetail();
    showSection('detail-view');
  }

  function absolute(pathname) {
    return `${location.origin}${pathname}`;
  }

  function renderDetail() {
    const s = current;
    const base = `/s/${s.code}`;
    const controlUrl = `${base}/control?token=${encodeURIComponent(s.control_token)}`;

    $('detail-actions').innerHTML = `
      ${s.status !== 'LIVE' && s.status !== 'ENDED'
        ? '<button class="primary" data-act="LIVE">OPEN SESSION</button>' : ''}
      ${s.status === 'LIVE' ? '<button data-act="DRAFT">PAUSE INTAKE</button>' : ''}
      ${s.status !== 'ENDED' ? '<button class="danger" data-act="ENDED">END SESSION</button>' : ''}
      <button data-act="log">DOWNLOAD LOG</button>
      ${s.status === 'ENDED' ? '<button class="danger" data-act="delete">DELETE</button>' : ''}`;

    for (const btn of $('detail-actions').querySelectorAll('button')) {
      btn.addEventListener('click', () => detailAction(btn.dataset.act));
    }

    const teamRows = meta.sectors.map((sec) => {
      const team = s.teams.find((t) => t.sector === sec.code);
      const joinUrl = team ? absolute(`/j/${team.join_code}`) : '';
      return `<tr data-sector="${esc(sec.code)}">
          <td><span class="sec-cell"><span class="swatch" style="background:${esc(sec.colour)}"></span>${esc(sec.code)}</span></td>
          <td><input type="text" class="team-name" value="${esc(team ? team.team_name : '')}"
                     placeholder="${esc(sec.name)}"></td>
          <td class="join">${team ? esc(team.join_code) : '—'}</td>
          <td class="actions">
            ${team ? `<button data-copy="${esc(joinUrl)}">COPY LINK</button>
                      <button data-rotate="${esc(sec.code)}" title="Invalidate the old link">NEW CODE</button>` : ''}
          </td>
        </tr>`;
    }).join('');

    $('detail').innerHTML = `
      <div class="detail-head">
        <h3>${esc(s.name)}</h3>
        <div class="meta">
          <span class="big-code">${esc(s.code)}</span>
          <span class="status ${esc(s.status)}">${esc(s.status)}</span>
          ${s.client_name ? `<span>${esc(s.client_name)}</span>` : ''}
          <span>run ${esc(s.run_id)}</span>
          ${s.live_state ? `<span><span class="dot-live"></span>${esc(s.live_state.mode)} · ${esc(s.live_state.round)}</span>` : ''}
        </div>
      </div>

      <div class="links">
        <div class="link-card">
          <div class="lbl">Big screen — projector</div>
          <div class="link-row">
            <input readonly value="${esc(absolute(`${base}/bigscreen`))}">
            <button data-copy="${esc(absolute(`${base}/bigscreen`))}">COPY</button>
            <button data-open="${esc(`${base}/bigscreen`)}">OPEN</button>
          </div>
        </div>
        <div class="link-card">
          <div class="lbl">Control panel — facilitator only</div>
          <div class="link-row">
            <input readonly value="${esc(absolute(controlUrl))}">
            <button data-copy="${esc(absolute(controlUrl))}">COPY</button>
            <button data-open="${esc(controlUrl)}">OPEN</button>
          </div>
          <div class="warn-note">Carries the answer key. Never put this on the projector.</div>
        </div>
      </div>

      <table class="teams-table">
        <thead><tr><th>Sector</th><th>Team name</th><th>Join code</th><th></th></tr></thead>
        <tbody>${teamRows}</tbody>
      </table>
      <p class="hint">Each team's link opens their own dashboard — no sector to pick, nothing to type.
        Renaming a team saves when you click away.</p>`;

    wireDetail();
  }

  function wireDetail() {
    for (const btn of $('detail').querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', () => copy(btn, btn.dataset.copy));
    }
    for (const btn of $('detail').querySelectorAll('[data-open]')) {
      btn.addEventListener('click', () => window.open(btn.dataset.open, '_blank'));
    }
    for (const btn of $('detail').querySelectorAll('[data-rotate]')) {
      btn.addEventListener('click', async () => {
        if (!confirm(`Issue a new join code for ${btn.dataset.rotate}? The old link stops working.`)) return;
        await api(`/api/admin/sessions/${current.code}/teams/${btn.dataset.rotate}/rotate`, { method: 'POST' });
        await openSession(current.code);
      });
    }
    for (const input of $('detail').querySelectorAll('.team-name')) {
      input.addEventListener('change', async () => {
        const sector = input.closest('tr').dataset.sector;
        const name = input.value.trim();
        if (!name) return;
        await api(`/api/admin/sessions/${current.code}/teams`, {
          method: 'POST', body: { sector, team_name: name },
        });
        await openSession(current.code);
      });
    }
  }

  async function detailAction(act) {
    if (act === 'log') {
      window.open(`/api/admin/sessions/${current.code}/log`, '_blank');
      return;
    }
    if (act === 'delete') {
      if (!confirm(`Delete "${current.name}" permanently? The run log stays on disk.`)) return;
      await api(`/api/admin/sessions/${current.code}`, { method: 'DELETE' });
      current = null;
      return loadSessions();
    }
    if (act === 'ENDED' &&
        !confirm(`End "${current.name}"? Every connected screen disconnects and it cannot be reopened.`)) {
      return;
    }
    await api(`/api/admin/sessions/${current.code}/status`, { method: 'POST', body: { status: act } });
    await openSession(current.code);
  }

  function copy(btn, text) {
    const done = () => {
      const original = btn.textContent;
      btn.textContent = 'COPIED';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1200);
    };
    // clipboard API needs a secure context; fall back for plain-http LAN use.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); done(); } catch { /* nothing else to try */ }
    document.body.removeChild(el);
  }

  // -- boot -------------------------------------------------------------------

  async function boot() {
    meta = await api('/api/admin/meta');
    await loadSessions();
  }

  (async function start() {
    try {
      const { user } = await api('/api/auth/me');
      showApp(user);
      await boot();
    } catch {
      showLogin();
    }
  })();
})();
