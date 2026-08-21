'use strict';
/**
 * submit_code resolution — contract §3, in exactly that order.
 *
 * Two structural properties drive this module and must never be special-cased
 * away (contract §0.4):
 *   · valid_codes is an ARRAY. F-201 carries two codes (the seeded 340/290
 *     discrepancy) and the game must not punish either answer.
 *   · valid_codes may be EMPTY. F-210 is a false alarm with no procedure at
 *     all. That is detected from the empty array, never from the fault code,
 *     so a future false alarm needs no code change.
 *
 * Resources are NOT deducted here. Enforcement would push the argument onto
 * the screen instead of into the room, and the paper chits already carry the
 * audit trail (contract §3.5).
 */

/** Trim, uppercase, and normalise any dash-ish separator to a single hyphen. */
function normaliseCode(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toUpperCase()
    .replace(/[‐-―−_]/g, '-')  // en/em dashes, minus, underscore
    .replace(/\s*-\s*/g, '-')                  // spaces hugging a hyphen
    .replace(/-{2,}/g, '-')                    // collapse runs
    .replace(/\s+/g, '');                      // any remaining whitespace
}

function submitCode(game, { sector: sectorCode, fault_code: faultCode, code, workers_assigned }) {
  const cfg = game.cfg;
  const sector = game.state.sectors[sectorCode];

  const reject = (reason, extra = {}) => {
    game.log.write('submit', {
      sector: sectorCode,
      fault: faultCode,
      code: code ?? null,
      accepted: false,
      reason,
      ...extra,
    });
    return { type: 'submit_result', fault_code: faultCode, accepted: false, reason, ...extra };
  };

  // 1. Fault exists, belongs to this sector, is unresolved.
  if (!sector) return reject('unknown_fault');
  const fault = sector.faults.find((f) => f.code === faultCode && !f.resolved);
  if (!fault) return reject('unknown_fault');

  // A DARK sector's dashboard is locked (spec §3.1).
  if (sector.status === 'DARK') return reject('sector_dark', { attempts: fault.attempts });

  // 2. Lockout.
  if (fault.locked_until_s > 0) {
    return reject('locked', {
      attempts: fault.attempts,
      locked_until_s: Math.ceil(fault.locked_until_s),
    });
  }

  // 3. Crew. Must meet the requirement and not exceed who is actually standing.
  const workers = Number(workers_assigned || 0);
  if (workers < fault.crew_required || workers > sector.workforce.active) {
    return reject('insufficient_crew', {
      attempts: fault.attempts,
      crew_required: fault.crew_required,
      workforce_active: sector.workforce.active,
    });
  }

  // 4. Code. An empty valid_codes array means no procedure exists at all —
  //    the fault is a ghost and only the facilitator can clear it.
  if (fault.valid_codes.length === 0) {
    fault.attempts += 1;
    return reject('no_procedure', { attempts: fault.attempts });
  }

  const submitted = normaliseCode(code);
  const accepted = fault.valid_codes.some((valid) => normaliseCode(valid) === submitted);

  if (!accepted) {
    fault.attempts += 1;
    fault.consecutive_invalid += 1;

    const result = { attempts: fault.attempts };
    if (fault.consecutive_invalid >= cfg.lockout_after_consecutive_invalid) {
      fault.locked_until_s = cfg.lockout_s;
      fault.consecutive_invalid = 0;
      result.locked_until_s = cfg.lockout_s;
    }
    return reject('invalid_code', result);
  }

  // 5. Success: stop decay, apply recovery, credit the sector publicly.
  fault.attempts += 1;
  fault.consecutive_invalid = 0;
  fault.resolved = true;
  fault.resolved_at = new Date().toISOString();

  sector.integrity = Math.min(100, sector.integrity + cfg.resolve_recovery);
  game.refreshStatus(sector);

  game.ticker('resolve', `${sectorCode} resolved ${faultCode}`);
  game.log.write('submit', {
    sector: sectorCode,
    fault: faultCode,
    code,
    accepted: true,
    workers,
    attempts: fault.attempts,
  });

  return {
    type: 'submit_result',
    fault_code: faultCode,
    accepted: true,
    reason: null,
    attempts: fault.attempts,
  };
}

module.exports = { submitCode, normaliseCode };
