'use strict';
/**
 * Per-role state projection — THE SECURITY BOUNDARY.
 *
 * Filtering happens here, on the server, and never in CSS. Participants will
 * open devtools (contract §2), so anything a sector client must not know must
 * not be in the frame sent to that client.
 *
 * Four projections:
 *   sector            own sector full; others integrity+status only, 60s stale
 *   sector (COM)      as above, plus other sectors' fault codes/names LIVE
 *   bigscreen         integrity/status/ticker/telemetry; no faults, no inventory
 *   control           everything, undelayed, plus valid_codes (the answer key)
 *
 * COM's exception is scoped to fault codes and names. Their view of other
 * sectors' integrity stays on the same 60 s delay as everyone else's — the
 * asymmetry is about knowing what is broken, not about seeing the bars early.
 */

/**
 * The half of a flavour line a participant is allowed to read.
 *
 * Flavour lines are written "SYMPTOM; needs X from Y". The printed fault card
 * prints the symptom ONLY (tools/kit/build_cards.js), because the dependency
 * half is the lookup the team is supposed to earn by talking to another
 * sector — and on the six Appendix C faults it names the buried spec outright,
 * which would kill the frustration-tolerance probe the binder is built around
 * (spec §4.1 p.10).
 *
 * The screen must not hand over what the paper withholds, so the same cut is
 * applied here, server-side, before the text is ever sent. The facilitator's
 * own view keeps the full line.
 */
function cardFlavour(flavour, showDependency) {
  if (showDependency || !flavour) return flavour;
  const symptom = String(flavour).split(';')[0].trim();
  if (!symptom) return flavour;
  return symptom.endsWith('.') ? symptom : `${symptom}.`;
}

/** Fault as its own sector sees it: no answer key, no dependency half. */
function ownFault(f, showDependency = false) {
  return {
    code: f.code,
    name: f.name,
    flavour: cardFlavour(f.flavour, showDependency),
    severity: f.severity,
    crew_required: f.crew_required,
    resources_required: f.resources_required,
    decay_per_min: f.decay_per_min,
    deadline_remaining_s:
      f.deadline_remaining_s === null ? null : Math.ceil(f.deadline_remaining_s),
    attempts: f.attempts,
    locked_until_s: Math.ceil(f.locked_until_s),
    fired_at: f.fired_at,
    resolved: f.resolved,
    resolved_at: f.resolved_at,
    paused: f.paused,
    triggered_by: f.triggered_by,
  };
}

/** Fault as the facilitator sees it: everything, including valid_codes. */
function controlFault(f) {
  return {
    ...ownFault(f, true),   // the facilitator reads the whole line

    valid_codes: f.valid_codes,
    false_alarm: f.false_alarm,
    procedure: f.procedure,
    consecutive_invalid: f.consecutive_invalid,
    cleared_by_facilitator: !!f.cleared_by_facilitator,
  };
}

/** What COM learns about somebody else's fault: that it exists, and its name. */
function comFault(f) {
  return { code: f.code, name: f.name, severity: f.severity, resolved: f.resolved };
}

/**
 * What the city actually delivers this cycle. A brownout sector is on half
 * rations (spec §3.6) — the server computes the figure so the team and the
 * facilitator read the same number, but delivery itself is physical: chits
 * are handed over, never deducted by the server.
 */
function upkeepDelivery(s) {
  const out = {};
  for (const [k, v] of Object.entries(s.upkeep_per_round)) {
    out[k] = s.status === 'BROWNOUT' ? Math.floor(v / 2) : v;
  }
  return out;
}

function ownSector(s, showDependency) {
  return {
    code: s.code,
    name: s.name,
    colour: s.colour,
    integrity: Math.round(s.integrity),
    status: s.status,
    workforce: { ...s.workforce },
    inventory: { ...s.inventory },
    upkeep_per_round: { ...s.upkeep_per_round },
    upkeep_delivery: upkeepDelivery(s),
    brownout: s.status === 'BROWNOUT',
    upkeep_due_in_s: Math.ceil(s.upkeep_due_in_s),
    faults: s.faults.filter((f) => !f.resolved).map((f) => ownFault(f, showDependency)),
    recently_resolved: s.faults.filter((f) => f.resolved).slice(-5)
      .map((f) => ownFault(f, showDependency)),
  };
}

function envelope(game, extra) {
  return {
    type: 'state',
    server_time: new Date().toISOString(),
    run_id: game.state.run_id,
    mode: game.state.mode,
    round: game.state.round,
    round_clock: {
      running: game.state.round_clock.running,
      remaining_s: Math.ceil(game.state.round_clock.remaining_s),
    },
    council_clock: {
      running: game.state.council_clock.running,
      remaining_s: Math.ceil(game.state.council_clock.remaining_s),
    },
    core_integrity: Math.round(game.state.core_integrity),
    breather: game.state.breather,
    ...extra,
  };
}

function forSector(game, sectorCode) {
  const def = game.content.sectors.sectors[sectorCode];
  const fullTelemetry = !!(def && def.full_telemetry);
  const delayed = game.delayedView();
  // Mirrors CARD_SHOWS_DEPENDENCY in the card renderer; both default to off.
  const showDependency = !!game.cfg.card_shows_dependency;

  const sectors = {};
  for (const [code, s] of Object.entries(game.state.sectors)) {
    if (code === sectorCode) {
      sectors[code] = ownSector(s, showDependency);
      continue;
    }
    // Everyone else: the 60-second-old bar, and nothing more.
    const stale = delayed[code] || { integrity: 100, status: 'ACTIVE' };
    const view = {
      code,
      name: s.name,
      colour: s.colour,
      integrity: stale.integrity,
      status: stale.status,
      delayed: true,
    };
    if (fullTelemetry) {
      // COM's asymmetric-information role: what is broken, right now.
      view.faults = s.faults.filter((f) => !f.resolved).map(comFault);
    }
    sectors[code] = view;
  }

  return envelope(game, {
    role: 'sector',
    sector: sectorCode,
    full_telemetry: fullTelemetry,
    sectors,
    ticker: game.state.ticker,
    announcements: game.state.announcements,
    telemetry: { ...game.state.telemetry },
  });
}

function forBigscreen(game) {
  const sectors = {};
  for (const [code, s] of Object.entries(game.state.sectors)) {
    sectors[code] = {
      code,
      name: s.name,
      colour: s.colour,
      integrity: Math.round(s.integrity),
      status: s.status,
      workforce: { ...s.workforce },
      // Count only — the big screen names sectors, never their fault detail.
      unresolved_faults: s.faults.filter((f) => !f.resolved).length,
    };
  }
  return envelope(game, {
    role: 'bigscreen',
    sectors,
    ticker: game.state.ticker,
    announcements: game.state.announcements,
    telemetry: { ...game.state.telemetry },
  });
}

function forControl(game) {
  const sectors = {};
  for (const [code, s] of Object.entries(game.state.sectors)) {
    sectors[code] = {
      code,
      name: s.name,
      colour: s.colour,
      integrity: Math.round(s.integrity * 10) / 10,
      status: s.status,
      status_override: s.status_override,
      workforce: { ...s.workforce },
      inventory: { ...s.inventory },
      upkeep_per_round: { ...s.upkeep_per_round },
      upkeep_delivery: upkeepDelivery(s),
      upkeep_due_in_s: Math.ceil(s.upkeep_due_in_s),
      faults: s.faults.map(controlFault),
    };
  }
  return envelope(game, {
    role: 'control',
    sectors,
    ticker: game.state.ticker,
    announcements: game.state.announcements,
    telemetry: { ...game.state.telemetry },
    runbook_done: [...game.runbookDone],
  });
}

function filterState(game, client) {
  if (client.role === 'control') return forControl(game);
  if (client.role === 'bigscreen') return forBigscreen(game);
  return forSector(game, client.sector);
}

module.exports = {
  filterState, forSector, forBigscreen, forControl, cardFlavour,
};
