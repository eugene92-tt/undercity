'use strict';
/**
 * Authoritative game state and its reducers.
 *
 * The server owns everything; clients render what they are told and send
 * intents (contract §0.1). Nothing in here trusts a client, and nothing in
 * here deducts a resource — resource spend is declared by the team via
 * set_inventory and settled with paper chits (contract §3.5).
 */

const TICKER_MAX = 60;
const ANNOUNCE_MAX = 20;

class GameState {
  constructor({ content, rounds, runId, log }) {
    this.content = content;
    this.rounds = rounds;
    this.cfg = rounds.defaults;
    this.log = log;
    this.faultsByCode = new Map(content.faults.faults.map((f) => [f.code, f]));
    this.reset(runId, { silent: true });
  }

  // -- lifecycle --------------------------------------------------------------

  reset(runId, { silent = false } = {}) {
    const sectors = {};
    for (const [code, def] of Object.entries(this.content.sectors.sectors)) {
      sectors[code] = {
        code,
        name: def.name,
        colour: def.colour,
        integrity: def.start_integrity,
        status: 'ACTIVE',
        // Set only by the facilitator. Auto-status never overwrites BROWNOUT.
        status_override: null,
        workforce: { active: def.start_workforce, injured: 0 },
        inventory: { ...def.start_inventory },
        upkeep_per_round: { ...def.upkeep_per_round },
        upkeep_due_in_s: this.cfg.upkeep_interval_s,
        faults: [],
      };
    }

    const firstRound = this.rounds.rounds[0];
    this.state = {
      run_id: runId,
      mode: 'BRIEFING',
      round: firstRound.id,
      round_clock: { running: false, remaining_s: firstRound.length_s },
      council_clock: { running: false, remaining_s: this.cfg.council_clock_s },
      core_integrity: 100,
      breather: false,
      sectors,
      ticker: [],
      announcements: [],
      // 290 is the public half of the seeded discrepancy; the WTR binder
      // prints 340. Both resolve F-201. These are never reconciled (§7).
      telemetry: { wtr_reservoir_pressure: 290, core_output_pct: 100 },
    };

    this.delayed = [];
    this.runbookDone = new Set();

    if (!silent) this.log.write('run_reset', { run_id: runId });
  }

  /** Restore from a snapshot written by a previous process. */
  restore(snapshot) {
    if (!snapshot || !snapshot.state) return false;
    this.state = snapshot.state;
    this.delayed = snapshot.delayed || [];
    this.runbookDone = new Set(snapshot.runbook_done || []);
    return true;
  }

  serialise() {
    return {
      state: this.state,
      delayed: this.delayed,
      runbook_done: [...this.runbookDone],
      saved_at: new Date().toISOString(),
    };
  }

  roundConfig(id = this.state.round) {
    return this.rounds.rounds.find((r) => r.id === id) || this.rounds.rounds[0];
  }

  // -- feed -------------------------------------------------------------------

  ticker(kind, text) {
    this.state.ticker.unshift({ t: new Date().toISOString(), kind, text });
    if (this.state.ticker.length > TICKER_MAX) this.state.ticker.length = TICKER_MAX;
  }

  announce(text) {
    this.state.announcements.unshift({ t: new Date().toISOString(), text });
    if (this.state.announcements.length > ANNOUNCE_MAX) {
      this.state.announcements.length = ANNOUNCE_MAX;
    }
    this.log.write('announce', { text });
  }

  // -- status -----------------------------------------------------------------

  /**
   * Derive status from integrity, without clobbering a facilitator override.
   * DARK at 0 wins over everything; BROWNOUT is held until lifted by hand.
   */
  refreshStatus(sector) {
    if (sector.integrity <= 0) {
      sector.integrity = 0;
      if (sector.status !== 'DARK') {
        this.ticker('status', `${sector.code} IS DARK`);
        this.log.write('status', { sector: sector.code, status: 'DARK' });
      }
      sector.status = 'DARK';
      return;
    }
    if (sector.status_override === 'BROWNOUT') {
      sector.status = 'BROWNOUT';
      return;
    }
    if (sector.status_override === 'DARK') {
      sector.status = 'DARK';
      return;
    }
    const next = sector.integrity < this.cfg.critical_below ? 'CRITICAL' : 'ACTIVE';
    if (next !== sector.status) {
      this.log.write('status', { sector: sector.code, status: next });
      if (next === 'CRITICAL') this.ticker('status', `${sector.code} CRITICAL`);
    }
    sector.status = next;
  }

  setIntegrity(code, value) {
    const s = this.state.sectors[code];
    if (!s) return false;
    s.integrity = Math.max(0, Math.min(100, Number(value)));
    this.refreshStatus(s);
    this.log.write('set_integrity', { sector: code, value: s.integrity });
    return true;
  }

  setStatus(code, value) {
    const s = this.state.sectors[code];
    if (!s) return false;
    s.status_override = value === 'ACTIVE' ? null : value;
    s.status = value;
    this.log.write('set_status', { sector: code, status: value });
    this.ticker('status', `${code} → ${value}`);
    return true;
  }

  setCoreIntegrity(value) {
    this.state.core_integrity = Math.max(0, Math.min(100, Number(value)));
    this.log.write('set_core_integrity', { value: this.state.core_integrity });
  }

  // -- faults -----------------------------------------------------------------

  /** Instantiate a fault definition onto a sector. */
  fireFault(faultCode, sectorCode) {
    const def = this.faultsByCode.get(faultCode);
    if (!def) return { ok: false, reason: 'unknown_fault' };

    const target = sectorCode || def.sector;
    const sector = this.state.sectors[target];
    if (!sector) return { ok: false, reason: 'unknown_sector' };

    if (sector.faults.some((f) => f.code === faultCode && !f.resolved)) {
      return { ok: false, reason: 'already_active' };
    }

    const instance = {
      code: def.code,
      name: def.name,
      flavour: def.flavour,
      severity: def.severity,
      crew_required: def.crew_required,
      resources_required: { ...def.resources_required },
      decay_per_min: def.decay_per_min,
      deadline_remaining_s: def.deadline_s,
      attempts: 0,
      // Lifetime `attempts` is what the contract reports; the lockout runs off
      // a separate consecutive counter that any accepted code resets.
      consecutive_invalid: 0,
      locked_until_s: 0,
      fired_at: new Date().toISOString(),
      resolved: false,
      resolved_at: null,
      paused: false,
      // P2 architectural insurance (spec §9). Always null in MVP.
      triggered_by: null,
      valid_codes: [...def.valid_codes],
      false_alarm: def.false_alarm,
      procedure: def.procedure,
    };
    sector.faults.push(instance);

    if (def.injures_workforce > 0) {
      this.injure(target, def.injures_workforce);
    }

    this.ticker('fault', `${target} fault detected: ${def.code}`);
    this.log.write('fault_fired', {
      sector: target,
      fault: def.code,
      round: this.state.round,
      injures: def.injures_workforce || 0,
    });
    return { ok: true, fault: instance, sector: target };
  }

  /**
   * Injured workers leave the sector and appear in MED's injured pile — the
   * server does this so the facilitator never has to remember (contract §4).
   */
  injure(sectorCode, count) {
    const sector = this.state.sectors[sectorCode];
    const med = this.state.sectors.MED;
    if (!sector) return;
    const moved = Math.min(count, sector.workforce.active);
    sector.workforce.active -= moved;
    sector.workforce.injured += moved;
    if (med && med !== sector) med.workforce.injured += 0; // tokens sit with MED physically
    this.log.write('injury', { sector: sectorCode, count: moved });
    if (moved > 0) this.ticker('injury', `${sectorCode}: ${moved} workforce injured`);
  }

  findFault(sectorCode, faultCode) {
    const sector = this.state.sectors[sectorCode];
    if (!sector) return null;
    return sector.faults.find((f) => f.code === faultCode && !f.resolved) || null;
  }

  clearFault(sectorCode, faultCode, reason) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.resolved = true;
    fault.resolved_at = new Date().toISOString();
    fault.cleared_by_facilitator = true;
    this.ticker('clear', `${sectorCode} ${faultCode} cleared — ${reason || 'facilitator'}`);
    this.log.write('fault_cleared', { sector: sectorCode, fault: faultCode, reason: reason || null });
    return true;
  }

  accelerateFault(sectorCode, faultCode, decayPerMin) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.decay_per_min = Number(decayPerMin);
    this.log.write('accelerate_fault', {
      sector: sectorCode, fault: faultCode, decay_per_min: fault.decay_per_min,
    });
    return true;
  }

  pauseFault(sectorCode, faultCode, paused) {
    const fault = this.findFault(sectorCode, faultCode);
    if (!fault) return false;
    fault.paused = !!paused;
    this.log.write('pause_fault', { sector: sectorCode, fault: faultCode, paused: fault.paused });
    return true;
  }

  // -- workforce / inventory --------------------------------------------------

  adjustWorkforce(code, activeDelta = 0, injuredDelta = 0) {
    const s = this.state.sectors[code];
    if (!s) return false;
    s.workforce.active = Math.max(0, s.workforce.active + Number(activeDelta || 0));
    s.workforce.injured = Math.max(0, s.workforce.injured + Number(injuredDelta || 0));
    this.log.write('adjust_workforce', { sector: code, workforce: { ...s.workforce } });
    return true;
  }

  adjustInventory(code, delta = {}) {
    const s = this.state.sectors[code];
    if (!s) return false;
    for (const [k, v] of Object.entries(delta)) {
      if (!(k in s.inventory)) continue;
      s.inventory[k] = Math.max(0, s.inventory[k] + Number(v || 0));
    }
    this.log.write('adjust_inventory', { sector: code, inventory: { ...s.inventory } });
    return true;
  }

  /**
   * A declaration, not a transaction (contract §3). Physical chits are the
   * source of truth; divergence between declared and actual is debrief
   * material, not an error to prevent.
   */
  setInventory(code, inventory = {}) {
    const s = this.state.sectors[code];
    if (!s) return false;
    for (const [k, v] of Object.entries(inventory)) {
      if (!(k in s.inventory)) continue;
      s.inventory[k] = Math.max(0, Number(v) || 0);
    }
    this.log.write('inventory_declared', { sector: code, inventory: { ...s.inventory } });
    return true;
  }

  // -- tempo ------------------------------------------------------------------

  setRound(id) {
    const cfg = this.roundConfig(id);
    this.state.round = cfg.id;
    this.state.round_clock = { running: false, remaining_s: cfg.length_s };
    for (const s of Object.values(this.state.sectors)) {
      s.upkeep_due_in_s = this.cfg.upkeep_interval_s;
    }
    this.log.write('round', { round: cfg.id });
    this.ticker('round', `${cfg.id} — ${cfg.name}`);
  }

  setMode(mode) {
    this.state.mode = mode;
    if (mode === 'COUNCIL') {
      this.state.council_clock = { running: true, remaining_s: this.cfg.council_clock_s };
      this.ticker('council', 'COUNCIL CONVENED');
    }
    this.log.write('mode', { mode });
  }

  clock(action, seconds, which = 'round') {
    const clk = which === 'council' ? this.state.council_clock : this.state.round_clock;
    if (action === 'start') clk.running = true;
    else if (action === 'pause') clk.running = false;
    else if (action === 'add') clk.remaining_s = Math.max(0, clk.remaining_s + Number(seconds || 0));
    else if (action === 'set') clk.remaining_s = Math.max(0, Number(seconds || 0));
    this.log.write('clock', { which, action, seconds: seconds ?? null, remaining_s: clk.remaining_s });
  }

  setBreather(on) {
    this.state.breather = !!on;
    if (on) {
      this.state.round_clock.running = false;
      this.state.council_clock.running = false;
    }
    this.log.write('breather', { on: this.state.breather });
    this.ticker('breather', on ? 'BREATHER — systems holding' : 'BREATHER OVER');
  }

  // -- the 10s tick -----------------------------------------------------------

  /**
   * Decay, clocks and countdowns. A breather freezes everything (contract §4),
   * as do PAUSED and BRIEFING — decay while nobody is playing is just noise in
   * the log.
   */
  tick(elapsedMs) {
    const secs = elapsedMs / 1000;
    const frozen =
      this.state.breather || this.state.mode === 'PAUSED' || this.state.mode === 'BRIEFING';

    for (const sector of Object.values(this.state.sectors)) {
      for (const fault of sector.faults) {
        if (fault.resolved) continue;
        if (fault.locked_until_s > 0) {
          fault.locked_until_s = Math.max(0, fault.locked_until_s - secs);
        }
        if (frozen) continue;
        if (!fault.paused && fault.decay_per_min > 0 && sector.status !== 'DARK') {
          sector.integrity = Math.max(0, sector.integrity - (fault.decay_per_min * secs) / 60);
        }
        if (fault.deadline_remaining_s !== null && fault.deadline_remaining_s > 0) {
          fault.deadline_remaining_s = Math.max(0, fault.deadline_remaining_s - secs);
          if (fault.deadline_remaining_s === 0) {
            this.ticker('deadline', `${sector.code} ${fault.code} DEADLINE PASSED`);
            this.log.write('deadline_expired', { sector: sector.code, fault: fault.code });
          }
        }
      }

      if (!frozen) {
        // Brownout sectors bleed slowly even with no active fault (spec §3.6).
        if (sector.status === 'BROWNOUT') {
          sector.integrity = Math.max(
            0, sector.integrity - (this.cfg.brownout_decay_per_min * secs) / 60
          );
        }
        if (sector.upkeep_due_in_s > 0) {
          sector.upkeep_due_in_s = Math.max(0, sector.upkeep_due_in_s - secs);
          if (sector.upkeep_due_in_s === 0) {
            this.log.write('upkeep_due', { sector: sector.code, round: this.state.round });
          }
        }
      }

      sector.integrity = Math.round(sector.integrity * 10) / 10;
      this.refreshStatus(sector);
    }

    if (!frozen) {
      for (const clk of [this.state.round_clock, this.state.council_clock]) {
        if (clk.running && clk.remaining_s > 0) {
          clk.remaining_s = Math.max(0, clk.remaining_s - secs);
        }
      }
    }

    this.sampleDelayed();
  }

  // -- the delayed city feed --------------------------------------------------

  /**
   * Other sectors are visible to participants only as they were 60 s ago.
   * The buffer is kept server-side so the live numbers never reach a
   * participant client at all (contract §2).
   */
  sampleDelayed() {
    const now = Date.now();
    const frame = { t: now, sectors: {} };
    for (const [code, s] of Object.entries(this.state.sectors)) {
      frame.sectors[code] = { integrity: Math.round(s.integrity), status: s.status };
    }
    this.delayed.push(frame);
    const cutoff = now - this.cfg.delay_window_s * 1000 * 3;
    while (this.delayed.length > 2 && this.delayed[0].t < cutoff) this.delayed.shift();
  }

  /** The newest frame at least `delay_window_s` old, or the oldest we hold. */
  delayedView() {
    const cutoff = Date.now() - this.cfg.delay_window_s * 1000;
    let chosen = null;
    for (const frame of this.delayed) {
      if (frame.t <= cutoff) chosen = frame;
      else break;
    }
    if (chosen) return chosen.sectors;

    // Early in a run nothing is old enough yet: show starting values rather
    // than leaking the present.
    const start = {};
    for (const [code, def] of Object.entries(this.content.sectors.sectors)) {
      start[code] = { integrity: def.start_integrity, status: 'ACTIVE' };
    }
    return start;
  }
}

module.exports = { GameState };
