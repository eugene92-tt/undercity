'use strict';
/**
 * Sector dashboard — spec §6.1.
 *
 * Renders whatever the server sends and sends intents back. It computes no
 * game state: there is no optimistic UI here, so a rejected code never
 * briefly looks accepted.
 *
 * There is deliberately no chat surface. All inter-sector communication is
 * voice or feet (contract §0.5).
 */
(function sectorDashboard() {
  const U = window.Undercity;
  const SECTOR = (location.pathname.split('/')[2] || '').toUpperCase();
  const RESOURCES = [
    { key: 'power', glyph: '⚡', name: 'power' },
    { key: 'water', glyph: '💧', name: 'water' },
    { key: 'parts', glyph: '🔧', name: 'parts' },
    { key: 'med',   glyph: '⚕',      name: 'med' },
  ];

  const $ = (id) => document.getElementById(id);

  let state = null;
  // Per-fault UI that must survive a re-render: what the operator has typed,
  // and the last verdict from the server.
  const draft = new Map();
  const verdict = new Map();

  const socket = U.connect({
    hello: { type: 'hello', role: 'sector', sector: SECTOR, token: null },
    onState: render,
    onStatus: setConnStatus,
    onMessage: (msg) => {
      if (msg.type === 'submit_result') handleResult(msg);
      if (msg.type === 'sting') U.playSting(msg.sound);
    },
  });

  function setConnStatus(status) {
    const el = $('conn');
    el.dataset.status = status;
    $('conn-text').textContent =
      status === 'live' ? 'LIVE' : status === 'stale' ? 'DELAYED' : 'RECONNECTING';
  }

  // -- submit -----------------------------------------------------------------

  function handleResult(msg) {
    verdict.set(msg.fault_code, msg);
    if (msg.accepted) draft.delete(msg.fault_code);
    if (state) render(state);

    const card = document.querySelector(`[data-fault="${msg.fault_code}"]`);
    if (!card) return;
    card.classList.add(msg.accepted ? 'flash-ok' : 'flash-bad');
    setTimeout(() => card.classList.remove('flash-ok', 'flash-bad'), 750);
  }

  function submit(faultCode) {
    const d = draft.get(faultCode) || {};
    socket.send({
      type: 'submit_code',
      sector: SECTOR,
      fault_code: faultCode,
      code: d.code || '',
      workers_assigned: Number(d.workers || 0),
    });
  }

  function rejectionText(v) {
    if (v.accepted) return 'ACCEPTED — fault resolved.';
    switch (v.reason) {
      // Driven by an empty valid_codes array, never by the fault code (§3).
      case 'no_procedure':     return 'No matching procedure. Verify this alert.';
      case 'invalid_code':     return 'REJECTED — verify procedure.';
      case 'insufficient_crew':
        return `Not enough crew assigned (needs ${v.crew_required}, ${v.workforce_active} active).`;
      case 'locked':           return 'Locked out — wait for the timer.';
      case 'sector_dark':      return 'Sector is dark. Systems offline.';
      case 'unknown_fault':    return 'That fault is not active here.';
      default:                 return 'REJECTED.';
    }
  }

  // -- render -----------------------------------------------------------------

  function render(next) {
    state = next;
    const mine = state.sectors[SECTOR];
    if (!mine) return;

    document.documentElement.style.setProperty('--sector', mine.colour);
    $('sector-name').textContent = mine.name;
    $('sector-code').textContent = mine.code;
    $('round').textContent = state.round;
    $('round-clock').textContent = U.mmss(state.round_clock.remaining_s);
    $('mode').textContent = state.breather ? 'BREATHER' : state.mode;

    renderMine(mine);
    renderFaults(mine);
    renderCity();

    $('dark-overlay').classList.toggle('hidden', mine.status !== 'DARK');
  }

  function renderMine(mine) {
    const value = Math.round(mine.integrity);
    $('integrity').textContent = value;
    const bar = $('integrity-bar');
    bar.className = `bar ${U.integrityClass(value)}`;
    bar.querySelector('i').style.width = `${value}%`;

    $('status').textContent = mine.status;
    $('status').dataset.status = mine.status;

    $('wf-active').textContent = mine.workforce.active;
    $('wf-injured').textContent = mine.workforce.injured;

    renderInventory(mine);

    // A brownout sector is on half rations; show what will actually arrive,
    // with the full entitlement struck through beside it.
    const glyph = (k) => (RESOURCES.find((r) => r.key === k) || {}).glyph || k;
    const delivery = Object.entries(mine.upkeep_delivery || mine.upkeep_per_round)
      .map(([k, v]) => `${v}${glyph(k)}`).join(' ');
    const full = Object.entries(mine.upkeep_per_round)
      .map(([k, v]) => `${v}${glyph(k)}`).join(' ');
    $('upkeep-cost').innerHTML = mine.brownout
      ? `<s>${U.escapeHtml(full)}</s> ${U.escapeHtml(delivery)} <em class="brownout-tag">BROWNOUT</em>`
      : U.escapeHtml(delivery);
    const clock = $('upkeep-clock');
    clock.textContent = mine.upkeep_due_in_s > 0 ? U.mmss(mine.upkeep_due_in_s) : 'DUE';
    clock.classList.toggle('due', mine.upkeep_due_in_s <= 0);
  }

  /**
   * Inventory is a declaration the team keeps synced out loud — that
   * reconciliation chatter is deliberate design (contract §3).
   */
  function renderInventory(mine) {
    const host = $('inventory');
    host.innerHTML = '';
    for (const res of RESOURCES) {
      const row = document.createElement('div');
      row.className = 'inv-row';
      row.innerHTML =
        `<span class="n">${res.glyph} ${res.name}</span>` +
        `<span class="inv-ctl"><button data-d="-1">&minus;</button>` +
        `<b>${mine.inventory[res.key]}</b>` +
        `<button data-d="1">+</button></span>`;
      for (const btn of row.querySelectorAll('button')) {
        btn.addEventListener('click', () => {
          const inventory = { ...mine.inventory };
          inventory[res.key] = Math.max(0, inventory[res.key] + Number(btn.dataset.d));
          socket.send({ type: 'set_inventory', sector: SECTOR, inventory });
        });
      }
      host.appendChild(row);
    }
  }

  function renderFaults(mine) {
    const host = $('faults');
    const faults = mine.faults || [];
    $('fault-count').textContent = faults.length;

    if (!faults.length) {
      host.innerHTML = '<div class="empty">No active faults.</div>';
      return;
    }

    host.innerHTML = '';
    for (const fault of faults) {
      host.appendChild(faultCard(fault, mine));
    }
  }

  function faultCard(fault, mine) {
    const d = draft.get(fault.code) || { code: '', workers: String(fault.crew_required) };
    draft.set(fault.code, d);

    const card = document.createElement('div');
    card.className = `fault sev-${fault.severity}`;
    card.dataset.fault = fault.code;

    const meta = [
      `<span>crew <b>${fault.crew_required}</b></span>`,
      `<span>decay <b>${fault.decay_per_min}</b>/min</span>`,
      `<span>attempts <b>${fault.attempts}</b></span>`,
    ];
    const needs = Object.entries(fault.resources_required || {})
      .map(([k, v]) => `${v}${(RESOURCES.find((r) => r.key === k) || {}).glyph || k}`).join(' ');
    if (needs) meta.push(`<span>spend <b>${needs}</b></span>`);
    if (fault.deadline_remaining_s !== null) {
      meta.push(`<span class="deadline">deadline <b>${U.mmss(fault.deadline_remaining_s)}</b></span>`);
    }

    const locked = fault.locked_until_s > 0;
    const options = [];
    for (let n = 0; n <= mine.workforce.active; n += 1) {
      options.push(`<option value="${n}"${String(n) === String(d.workers) ? ' selected' : ''}>${n}</option>`);
    }

    card.innerHTML =
      `<div class="fault-head">
         <span class="fault-code">${U.escapeHtml(fault.code)}</span>
         <span class="fault-name">${U.escapeHtml(fault.name)}</span>
         <span class="pips">${U.severityPips(fault.severity)}</span>
       </div>
       <div class="fault-flavour">${U.escapeHtml(fault.flavour || '')}</div>
       <div class="fault-meta">${meta.join('')}</div>
       <div class="fault-entry">
         <input type="text" placeholder="RESOLUTION CODE" value="${U.escapeHtml(d.code)}"
                ${locked ? 'disabled' : ''} autocomplete="off" spellcheck="false">
         <select ${locked ? 'disabled' : ''}>${options.join('')}</select>
         <button ${locked ? 'disabled' : ''}>SUBMIT</button>
       </div>`;

    const input = card.querySelector('input');
    const select = card.querySelector('select');
    const button = card.querySelector('button');

    input.addEventListener('input', () => { d.code = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !locked) submit(fault.code); });
    select.addEventListener('change', () => { d.workers = select.value; });
    button.addEventListener('click', () => submit(fault.code));

    if (locked) {
      const el = document.createElement('div');
      el.className = 'locked';
      el.textContent = `LOCKED — ${Math.ceil(fault.locked_until_s)}s. Slow down and verify.`;
      card.appendChild(el);
    }

    const v = verdict.get(fault.code);
    if (v && !locked) {
      const el = document.createElement('div');
      el.className = `reject${v.accepted ? ' ok' : ''}`;
      el.textContent = rejectionText(v);
      card.appendChild(el);
    }
    return card;
  }

  function renderCity() {
    const council = state.mode === 'COUNCIL';
    $('city-normal').classList.toggle('hidden', council);
    $('city-council').classList.toggle('hidden', !council);
    if (council) {
      $('council-clock').textContent = U.mmss(state.council_clock.remaining_s);
      return;
    }

    $('delay-note').textContent = state.full_telemetry ? 'FULL TELEMETRY' : '60s delay';

    const host = $('city');
    host.innerHTML = '';
    for (const [code, s] of Object.entries(state.sectors)) {
      if (code === SECTOR) continue;
      const row = document.createElement('div');
      row.className = 'city-row';
      const cls = U.integrityClass(s.integrity);
      // COM alone sees which faults are live elsewhere — the asymmetry engine.
      const faults = (s.faults || [])
        .map((f) => `<span class="city-fault" title="${U.escapeHtml(f.name)}">${U.escapeHtml(f.code)}</span>`)
        .join('');
      row.innerHTML =
        `<div class="top"><span class="nm">${U.escapeHtml(s.name)}</span>
           <span class="vl">${s.integrity} · ${s.status}</span></div>
         <div class="bar ${cls}"><i style="width:${Math.max(0, s.integrity)}%"></i></div>
         ${faults ? `<div class="city-faults">${faults}</div>` : ''}`;
      host.appendChild(row);
    }

    const feed = $('announcements');
    if (!state.announcements.length) {
      feed.innerHTML = '<div class="empty">Nothing yet.</div>';
    } else {
      feed.innerHTML = state.announcements.map((a) =>
        `<div class="announcement"><span class="t">${new Date(a.t).toLocaleTimeString()}</span>${U.escapeHtml(a.text)}</div>`
      ).join('');
    }
  }
})();
