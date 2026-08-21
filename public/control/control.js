'use strict';
/**
 * Facilitator control panel — spec §6.3. "The real product."
 *
 * Design principle enforced throughout: the facilitator's eyes should be on
 * the room ≥80% of the time, so nothing here demands sustained attention and
 * everything is reachable in ≤2 clicks. Only DARK and RESET confirm.
 *
 * The observation pad (column 4) is the highest-value surface in the panel —
 * its tags land in runlog.jsonl alongside game events, and the debrief
 * timeline builds itself from that join.
 */
(function controlPanel() {
  const U = window.Undercity;
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const TAGS = ['DOMINANCE', 'WITHDRAWAL', 'SAFETY+', 'SAFETY-', 'DISCREPANCY-SPOTTED'];
  const MODES = ['BRIEFING', 'PLAY', 'COUNCIL', 'PAUSED', 'DEBRIEF'];
  const PRESETS = [
    'Core output dropping. Council convenes in 10 minutes.',
    'Upkeep suspended this cycle.',
    'Core output dropping to 60 percent.',
    'Continuity Order due in 5 minutes.',
    'Transport capacity reduced — expect transfer delays.',
    'All sectors: report status to Council.',
  ];
  const RESOURCES = ['power', 'water', 'parts', 'med'];

  const $ = (id) => document.getElementById(id);

  let state = null;
  let content = null;
  let obsSector = null;
  let obsTag = null;
  const feed = [];

  // -- content (answer key; token-gated exactly like the socket) --------------

  fetch(`/api/content?token=${encodeURIComponent(TOKEN)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('forbidden'))))
    .then((data) => { content = data; buildStatics(); renderInjects(); renderRunbook(); })
    .catch(() => {
      $('injects').innerHTML =
        '<div class="hint">Content unavailable — check the token in the URL.</div>';
    });

  const socket = U.connect({
    hello: { type: 'hello', role: 'control', token: TOKEN },
    onState: render,
    onStatus: setConnStatus,
    onMessage: (msg) => {
      if (msg.type === 'error' && msg.reason === 'bad_token') {
        document.body.innerHTML =
          '<div style="padding:40px;font-family:monospace;color:#E85A5A">' +
          'REJECTED — bad facilitator token. Append ?token=… to the URL.</div>';
      }
      if (msg.type === 'observe_ack') {
        $('obs-note').value = '';
        obsTag = null;
        renderObsTags();
      }
      if (msg.type === 'export_ready') window.open(msg.url, '_blank');
    },
  });

  function setConnStatus(status) {
    $('conn').dataset.status = status;
    $('conn-text').textContent =
      status === 'live' ? 'LIVE' : status === 'stale' ? 'DELAYED' : 'RECONNECTING';
  }

  const send = (payload) => socket.send(payload);

  // -- static scaffolding -----------------------------------------------------

  function buildStatics() {
    const sectorCodes = Object.keys(content.sectors.sectors);

    const fRound = $('f-round');
    for (const r of content.faults.meta.rounds) {
      fRound.insertAdjacentHTML('beforeend', `<option value="${r}">${r}</option>`);
    }
    const fSector = $('f-sector');
    for (const s of sectorCodes) {
      fSector.insertAdjacentHTML('beforeend', `<option value="${s}">${s}</option>`);
    }
    for (const id of ['f-round', 'f-sector', 'f-sev']) {
      $(id).addEventListener('change', renderInjects);
    }
    $('f-text').addEventListener('input', renderInjects);

    $('rounds').innerHTML = content.rounds.rounds
      .map((r) => `<button data-round="${r.id}" title="${U.escapeHtml(r.name)}">${r.id}</button>`)
      .join('');
    for (const btn of $('rounds').querySelectorAll('button')) {
      btn.addEventListener('click', () => send({ type: 'set_round', round: btn.dataset.round }));
    }

    $('modes').innerHTML = MODES
      .map((m) => `<button data-mode="${m}">${m}</button>`).join('');
    for (const btn of $('modes').querySelectorAll('button')) {
      btn.addEventListener('click', () => send({ type: 'set_mode', mode: btn.dataset.mode }));
    }

    $('obs-sectors').innerHTML = sectorCodes
      .map((s) => `<button data-sector="${s}">${s}</button>`).join('');
    for (const btn of $('obs-sectors').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        obsSector = obsSector === btn.dataset.sector ? null : btn.dataset.sector;
        renderObsSectors();
      });
    }

    $('presets').innerHTML = PRESETS
      .map((p, i) => `<button data-preset="${i}">${U.escapeHtml(p)}</button>`).join('');
    for (const btn of $('presets').querySelectorAll('button')) {
      btn.addEventListener('click', () =>
        send({ type: 'announce', text: PRESETS[Number(btn.dataset.preset)] }));
    }
  }

  // -- col 1: runbook + injects ----------------------------------------------

  function renderRunbook() {
    const beats = content.rounds.rounds.flatMap((r) =>
      (r.beats || []).map((b) => ({ ...b, round: r.id })));

    if (!beats.length) {
      $('runbook').innerHTML =
        '<div class="empty">No scripted beats loaded.<br>' +
        'Author them in lib/rounds.json (rounds[].beats) to mirror the ' +
        'Facilitator Artifact Map 1:1. The inject library below is live meanwhile.</div>';
      return;
    }

    const done = new Set(state ? state.runbook_done : []);
    $('runbook').innerHTML = beats.map((b) => `
      <label class="beat${done.has(b.id) ? ' done' : ''}">
        <input type="checkbox" data-beat="${b.id}" ${done.has(b.id) ? 'checked' : ''}>
        <span class="off">${U.escapeHtml(b.offset || '')}</span>
        <span>${U.escapeHtml(b.instruction || '')}</span>
      </label>`).join('');

    for (const box of $('runbook').querySelectorAll('input')) {
      box.addEventListener('change', () =>
        send({ type: 'runbook_mark', beat_id: box.dataset.beat, done: box.checked }));
    }
  }

  function activeFaultCodes() {
    const out = new Set();
    if (!state) return out;
    for (const s of Object.values(state.sectors)) {
      for (const f of s.faults) if (!f.resolved) out.add(f.code);
    }
    return out;
  }

  function renderInjects() {
    if (!content) return;
    const round = $('f-round').value;
    const sector = $('f-sector').value;
    const sev = $('f-sev').value;
    const text = $('f-text').value.trim().toUpperCase();
    const active = activeFaultCodes();

    const rows = content.faults.faults.filter((f) =>
      (!round || f.round === round) &&
      (!sector || f.sector === sector) &&
      (!sev || String(f.severity) === sev) &&
      (!text || f.code.includes(text) || f.name.toUpperCase().includes(text))
    );

    $('injects').innerHTML = rows.map((f) => {
      const tags = [];
      // An empty valid_codes array is the false alarm — flag it so the
      // facilitator knows this one is cleared by hand, never by a code.
      if (f.valid_codes.length === 0) tags.push('<span class="tag ghost">GHOST</span>');
      if (f.valid_codes.length > 1) tags.push('<span class="tag multi">2 CODES</span>');
      if (f.injures_workforce > 0) {
        tags.push(`<span class="tag injury">−${f.injures_workforce}👤</span>`);
      }
      return `<div class="inject${active.has(f.code) ? ' active' : ''}">
          <span class="code">${f.code}</span>
          <span class="nm" title="${U.escapeHtml(f.name)}">${U.escapeHtml(f.name)}</span>
          <span class="tags">${tags.join('')}<button data-fire="${f.code}" data-sector="${f.sector}"
            >${active.has(f.code) ? 'LIVE' : 'FIRE'}</button></span>
        </div>`;
    }).join('') || '<div class="hint">No injects match.</div>';

    for (const btn of $('injects').querySelectorAll('button[data-fire]')) {
      btn.addEventListener('click', () =>
        send({ type: 'fire_fault', fault_code: btn.dataset.fire, sector: btn.dataset.sector }));
    }
  }

  // -- col 2: city state ------------------------------------------------------

  $('core-slider').addEventListener('input', (e) => {
    $('core-readout').textContent = e.target.value;
  });
  $('core-slider').addEventListener('change', (e) =>
    send({ type: 'set_core_integrity', value: Number(e.target.value) }));

  function renderSectors() {
    const host = $('sectors');
    host.innerHTML = '';

    for (const [code, s] of Object.entries(state.sectors)) {
      const el = document.createElement('div');
      el.className = 'sec';

      const statuses = ['ACTIVE', 'CRITICAL', 'BROWNOUT', 'DARK']
        .map((v) => `<option value="${v}"${v === s.status ? ' selected' : ''}>${v}</option>`).join('');

      const faults = s.faults.filter((f) => !f.resolved).map((f) => {
        const keys = f.valid_codes.length
          ? `<span class="keys">${f.valid_codes.join(' / ')}</span>`
          : '<span class="keys none">NO CODE — clear by hand</span>';
        return `<div class="sec-fault">
            <span class="c">${f.code}</span>${keys}<span class="sp"></span>
            <button data-acc="${f.code}" data-sec="${code}" title="double decay">FAST</button>
            <button data-clear="${f.code}" data-sec="${code}">CLEAR</button>
          </div>`;
      }).join('');

      el.innerHTML = `
        <div class="sec-head">
          <span class="sec-code" style="color:${s.colour}">${code}</span>
          <span class="sec-int">${s.integrity}</span>
          <div class="bar ${U.integrityClass(s.integrity)}" style="flex:1">
            <i style="width:${Math.max(0, s.integrity)}%"></i></div>
          <select data-status="${code}">${statuses}</select>
        </div>
        <div class="sec-row">
          <span class="label">INT</span>
          <input type="range" min="0" max="100" value="${Math.round(s.integrity)}" data-int="${code}">
        </div>
        <div class="sec-row">
          <span class="label">WF</span>
          <span class="stepper"><button data-wf="${code}" data-d="-1">−</button>
            <b>${s.workforce.active}</b><button data-wf="${code}" data-d="1">+</button></span>
          <span class="label">INJ</span>
          <span class="stepper"><button data-inj="${code}" data-d="-1">−</button>
            <b>${s.workforce.injured}</b><button data-inj="${code}" data-d="1">+</button></span>
        </div>
        <div class="inv-grid">${RESOURCES.map((r) => `
          <span class="stepper"><span class="n">${r}</span>
            <button data-inv="${code}" data-r="${r}" data-d="-1">−</button>
            <b>${s.inventory[r]}</b>
            <button data-inv="${code}" data-r="${r}" data-d="1">+</button></span>`).join('')}
        </div>
        ${faults ? `<div class="sec-faults">${faults}</div>` : ''}`;

      host.appendChild(el);
    }

    bindSectorControls(host);
  }

  function bindSectorControls(host) {
    for (const el of host.querySelectorAll('[data-int]')) {
      el.addEventListener('change', () =>
        send({ type: 'set_integrity', sector: el.dataset.int, value: Number(el.value) }));
    }
    for (const el of host.querySelectorAll('[data-status]')) {
      el.addEventListener('change', () => {
        // DARK is irreversible in the fiction and confirms, per spec §6.3.
        if (el.value === 'DARK' &&
            !confirm(`Take ${el.dataset.status} DARK? Its dashboard locks.`)) {
          renderSectors();
          return;
        }
        send({ type: 'set_status', sector: el.dataset.status, value: el.value });
      });
    }
    for (const el of host.querySelectorAll('[data-wf]')) {
      el.addEventListener('click', () =>
        send({ type: 'adjust_workforce', sector: el.dataset.wf, active: Number(el.dataset.d), injured: 0 }));
    }
    for (const el of host.querySelectorAll('[data-inj]')) {
      el.addEventListener('click', () =>
        send({ type: 'adjust_workforce', sector: el.dataset.inj, active: 0, injured: Number(el.dataset.d) }));
    }
    for (const el of host.querySelectorAll('[data-inv]')) {
      el.addEventListener('click', () =>
        send({ type: 'adjust_inventory', sector: el.dataset.inv, delta: { [el.dataset.r]: Number(el.dataset.d) } }));
    }
    for (const el of host.querySelectorAll('[data-clear]')) {
      el.addEventListener('click', () =>
        send({ type: 'clear_fault', sector: el.dataset.sec, fault_code: el.dataset.clear,
               reason: 'facilitator cleared' }));
    }
    for (const el of host.querySelectorAll('[data-acc]')) {
      el.addEventListener('click', () => {
        const sector = state.sectors[el.dataset.sec];
        const fault = sector.faults.find((f) => f.code === el.dataset.acc && !f.resolved);
        if (!fault) return;
        send({ type: 'accelerate_fault', sector: el.dataset.sec, fault_code: el.dataset.acc,
               decay_per_min: Math.round(fault.decay_per_min * 2 * 10) / 10 });
      });
    }
  }

  // -- col 3: tempo -----------------------------------------------------------

  for (const btn of document.querySelectorAll('[data-clock]')) {
    btn.addEventListener('click', () =>
      send({ type: 'clock', which: 'round', action: btn.dataset.clock,
             seconds: Number(btn.dataset.sec || 0) }));
  }
  for (const btn of document.querySelectorAll('[data-council]')) {
    btn.addEventListener('click', () =>
      send({ type: 'clock', which: 'council', action: btn.dataset.council,
             seconds: Number(btn.dataset.sec || 0) }));
  }
  for (const btn of document.querySelectorAll('[data-sting]')) {
    btn.addEventListener('click', () => send({ type: 'sting', sound: btn.dataset.sting }));
  }
  $('btn-breather').addEventListener('click', () =>
    send({ type: 'breather', on: !(state && state.breather) }));
  $('btn-announce').addEventListener('click', () => {
    const text = $('announce-text').value.trim();
    if (!text) return;
    send({ type: 'announce', text });
    $('announce-text').value = '';
  });
  $('announce-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-announce').click();
  });

  // -- col 4: observation pad -------------------------------------------------

  $('obs-tags').innerHTML = TAGS.map((t) => `<button data-tag="${t}">${t}</button>`).join('');
  for (const btn of $('obs-tags').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      obsTag = obsTag === btn.dataset.tag ? null : btn.dataset.tag;
      renderObsTags();
    });
  }

  function renderObsTags() {
    for (const btn of $('obs-tags').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.tag === obsTag);
    }
  }
  function renderObsSectors() {
    for (const btn of $('obs-sectors').querySelectorAll('button')) {
      const on = btn.dataset.sector === obsSector;
      btn.classList.toggle('on', on);
      if (on && state) {
        btn.style.setProperty('--sector-on', state.sectors[btn.dataset.sector].colour);
      }
    }
  }

  function logObservation() {
    const note = $('obs-note').value.trim();
    if (!note && !obsTag) return;
    send({ type: 'observe', sector: obsSector, tag: obsTag, note });
  }
  $('btn-observe').addEventListener('click', logObservation);
  $('obs-note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); logObservation(); }
  });

  // -- header actions ---------------------------------------------------------

  $('btn-snapshot').addEventListener('click', () => send({ type: 'snapshot' }));
  $('btn-export').addEventListener('click', () => send({ type: 'export_log' }));
  $('btn-reset').addEventListener('click', () => {
    // Double-confirm: this is the only destructive control on the panel.
    if (!confirm('RESET RUN — wipe all state and start a new run?')) return;
    const runId = prompt('New run id:', `${new Date().toISOString().slice(0, 10)}-c2`);
    if (!runId) return;
    if (!confirm(`Confirm reset to "${runId}". This cannot be undone.`)) return;
    send({ type: 'reset_run', run_id: runId, confirm: true });
  });

  // -- render -----------------------------------------------------------------

  function render(next) {
    const firstPaint = !state;
    state = next;

    $('run-id').textContent = state.run_id;
    $('mode-pill').textContent = state.mode;
    $('breather-pill').classList.toggle('hidden', !state.breather);
    $('core-value').textContent = state.core_integrity;
    if (document.activeElement !== $('core-slider')) {
      $('core-slider').value = state.core_integrity;
      $('core-readout').textContent = state.core_integrity;
    }

    $('round-clock').textContent = U.mmss(state.round_clock.remaining_s);
    $('council-clock').textContent = U.mmss(state.council_clock.remaining_s);
    $('btn-breather').textContent = state.breather ? 'BREATHER ON' : 'BREATHER OFF';
    $('btn-breather').classList.toggle('on', state.breather);

    for (const btn of $('rounds').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.round === state.round);
    }
    for (const btn of $('modes').querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.mode === state.mode);
    }

    renderSectors();
    renderObsSectors();
    renderFeed();
    if (content) { renderInjects(); if (firstPaint) renderRunbook(); }
  }

  /** Ticker doubles as the facilitator's live feed — same events, denser. */
  function renderFeed() {
    const rows = state.ticker.slice(0, 60);
    $('feed').innerHTML = rows.map((e) => `
      <div class="feed-row ${U.escapeHtml(e.kind)}">
        <span class="ft">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
        <span class="fx">${U.escapeHtml(e.text)}</span>
      </div>`).join('') || '<div class="hint">No events yet.</div>';
  }
})();
