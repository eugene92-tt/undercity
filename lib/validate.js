'use strict';
/**
 * Boot-time content reconciliation.
 *
 * The spreadsheet is the game (spec §11); this module refuses to let a build
 * run on content that would strand a team mid-session. It re-derives every
 * resolution code from specs.json and compares it to what the exporter wrote,
 * so a desynchronised answer key is caught at boot rather than in the room.
 *
 * Errors abort boot. Warnings print loudly but allow a run — they flag prose
 * that contradicts the answer key, which is a judgement call, not a fact.
 */

const DIRECTION_WORDS = [
  'North', 'South', 'East', 'West',
  'Upper', 'Lower', 'Mid',
  'Alpha', 'Beta', 'Gamma', 'Delta',
];

function validateContent({ faults, specs, sectors }) {
  const errors = [];
  const warnings = [];

  const specById = new Map(specs.specs.map((s) => [s.spec_id, s]));
  const sectorCodes = new Set(Object.keys(sectors.sectors));
  const list = faults.faults;

  // -- declared meta vs actual -----------------------------------------------
  if (faults.meta.fault_count !== list.length) {
    errors.push(
      `faults.json meta.fault_count=${faults.meta.fault_count} but file holds ${list.length} faults`
    );
  }
  if (specs.meta.spec_count !== specs.specs.length) {
    errors.push(
      `specs.json meta.spec_count=${specs.meta.spec_count} but file holds ${specs.specs.length} specs`
    );
  }

  // -- fault code uniqueness --------------------------------------------------
  const seenCodes = new Set();
  for (const f of list) {
    if (seenCodes.has(f.code)) errors.push(`Duplicate fault code ${f.code}`);
    seenCodes.add(f.code);
    if (!sectorCodes.has(f.sector)) {
      errors.push(`${f.code}: unknown sector ${f.sector}`);
    }
  }

  // -- spec value uniqueness (spec §3.3) --------------------------------------
  const byValue = new Map();
  for (const s of specs.specs) {
    if (!byValue.has(s.value)) byValue.set(s.value, []);
    byValue.get(s.value).push(s.spec_id);
  }
  for (const [value, ids] of byValue) {
    if (ids.length > 1) {
      errors.push(`Spec value ${value} is not unique — used by ${ids.join(', ')}`);
    }
  }

  // -- the reserved discrepancy value -----------------------------------------
  if (byValue.has(290)) {
    errors.push('Reserved value 290 appears in a spec table — collides with the discrepancy seed');
  }

  // -- resolution codes reconcile to spec values ------------------------------
  for (const f of list) {
    const isFalseAlarm = f.valid_codes.length === 0;

    if (f.false_alarm !== isFalseAlarm) {
      errors.push(
        `${f.code}: false_alarm=${f.false_alarm} contradicts valid_codes length ${f.valid_codes.length}`
      );
    }
    if (isFalseAlarm) continue;

    const values = [];
    for (const ref of f.spec_refs) {
      const spec = specById.get(ref.spec_id);
      if (!spec) {
        errors.push(`${f.code}: references unknown spec ${ref.spec_id}`);
        continue;
      }
      values.push(spec.value);
    }

    const derived = `${f.procedure}-${values.map((v) => String(v).padStart(3, '0')).join('-')}`;
    if (!f.valid_codes.includes(derived)) {
      errors.push(
        `${f.code}: no valid_code matches its spec refs — derived ${derived}, file has ${JSON.stringify(f.valid_codes)}`
      );
    }
  }

  // -- code ambiguity within a sector -----------------------------------------
  const seenPairs = new Map();
  for (const f of list) {
    for (const code of f.valid_codes) {
      const key = `${f.sector}|${code}`;
      if (seenPairs.has(key)) {
        errors.push(
          `Ambiguous code ${code} in ${f.sector}: claimed by ${seenPairs.get(key)} and ${f.code}`
        );
      }
      seenPairs.set(key, f.code);
    }
  }

  // -- prose vs answer key (the F-208 class of defect) ------------------------
  // The flavour line prints on the physical fault card. If it sends the team to
  // a different row of the SAME table than the answer key uses, a team doing
  // everything right fetches the wrong number and cannot recover.
  //
  // Scoped to the clause that actually names the source binder: a fault may
  // legitimately mention a direction when describing its OWN broken equipment
  // ("North array dead; re-strike needs COM Grid South offset") without that
  // word having anything to do with the spec it needs. Heuristic, so: warning.
  for (const f of list) {
    if (!f.flavour) continue;
    const clauses = f.flavour.split(/[;,.]/).map((c) => c.trim()).filter(Boolean);

    for (const ref of f.spec_refs) {
      const spec = specById.get(ref.spec_id);
      if (!spec) continue;
      // Self-references carry no binder name in the prose; nothing to anchor on.
      if (spec.binder === f.sector) continue;

      const siblings = specs.specs.filter(
        (s) => s.table_id === spec.table_id && s.spec_id !== spec.spec_id
      );

      for (const word of DIRECTION_WORDS) {
        if (spec.row_label.includes(word)) continue;

        const sibling = siblings.find((s) => s.row_label.includes(word));
        if (!sibling) continue;

        // Only a clause that names the source binder can be misdirecting us.
        const misdirects = clauses.some(
          (c) => c.includes(spec.binder) && new RegExp(`\\b${word}\\b`).test(c)
        );
        if (!misdirects) continue;

        warnings.push(
          `${f.code}: flavour says "${word}" but the answer key uses ${spec.spec_id} ` +
          `"${spec.row_label}" (${spec.value}). Same table also holds ${sibling.spec_id} ` +
          `"${sibling.row_label}" (${sibling.value}). A team following the card fetches the wrong value.`
        );
      }
    }
  }

  return { errors, warnings };
}

module.exports = { validateContent };
