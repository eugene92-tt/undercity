# UNDERCITY — HAVEN-9

Server and three screens for the UNDERCITY crisis-leadership simulation.

Six sector tables run a four-round shift keeping an underground city alive
while a facilitator turns the pressure dials by hand. **The software is the
stimulus and the instrument, not the product** — the product is the
measurement-and-debrief methodology, and `runlog.jsonl` is what feeds it.

Design authority: `docs/undercity-spec.md`.
Protocol authority: `docs/undercity-message-contract.md`.
Where the two differ, **the contract wins** (spec §5.2).

---

## Run it

```bash
npm install
npm start
```

| Screen | URL | Count |
|---|---|---|
| Sector dashboard | `http://<host>:3000/sector/POW` … `/sector/COM` | 6 |
| Big screen | `http://<host>:3000/bigscreen` | 1 |
| Control panel | `http://<host>:3000/control?token=haven9` | 1 (a second is allowed) |

```bash
PORT=3000 FACILITATOR_TOKEN=haven9 npm start   # both default as shown
RESUME=0 npm start                             # ignore any snapshot, start clean
npm test                                       # 61 tests
```

Runs on a dedicated offline travel router. No internet is required during
play, and none is used.

---

## Layout

```
server.js              Express + ws; boots content, routes intents, 10s tick
content/*.json         faults · specs · sectors — generated, never hand-edited
lib/
  validate.js          boot-time content reconciliation (aborts on error)
  state.js             authoritative state and every reducer
  resolve.js           submit_code, in the contract's exact order
  visibility.js        per-role filtering — THE SECURITY BOUNDARY
  log.js               runlog.jsonl appender + snapshot writer
  rounds.json          round config from spec §8; runbook beats live here
public/sector          dashboard   (spec §6.1)
public/bigscreen       projection  (spec §6.2)
public/control         facilitator (spec §6.3)
tools/                 the crossref matrix and its exporter
test/                  unit, visibility, integration and resilience suites
```

---

## Content pipeline

The spreadsheet is the game. The code is a display layer.

```
edit tools/undercity-crossref-matrix.xlsx
  → recalculate (formulas must be cached; the exporter aborts otherwise)
  → npm run export-content
  → regenerate binder PDFs
```

**Never hand-edit `content/*.json`.** A hand-fix desynchronises paper from
server and makes a fault unsolvable mid-session — the one failure a
facilitator cannot recover from live (spec §1).

`lib/validate.js` re-checks the fixtures at every boot: it re-derives every
resolution code from `specs.json`, enforces spec-value uniqueness, rejects
ambiguous codes, and flags flavour text that contradicts the answer key.
**Errors abort startup.** Warnings print loudly and allow the run.

There is one open content defect — see **`CONTENT-ISSUES.md`** (F-208's fault
card sends teams to the wrong spec row).

---

## Two structural edge cases

Both live in the content, and any code path that assumes exactly one
resolution code is wrong:

- **`F-201` has two valid codes.** The WTR binder prints reservoir pressure
  **340**; the big screen shows **290**. The server accepts either. These two
  numbers are never reconciled anywhere in the code or the UI — the mismatch
  *is* the psychological-safety probe (spec §3.7).
- **`F-210` has zero.** It is a sensor ghost with no procedure. Every
  submission returns `no_procedure`; only the facilitator can clear it. This
  is driven off `valid_codes.length === 0`, never off the fault code, so a
  future false alarm needs no code change.

## Visibility

Filtering happens on the server. Participants will open devtools, so anything
a sector must not know is never put in its frame.

| Role | Own sector | Other sectors | Extra |
|---|---|---|---|
| `sector` | full | integrity + status only, **60 s stale** | — |
| `sector` = COM | full | as above **+ foreign fault codes and names, live** | — |
| `bigscreen` | — | integrity/status/ticker/telemetry; no faults, no inventory | — |
| `control` | everything, live | everything, live | `valid_codes` |

COM's exception is scoped to *what is broken*, not *how to fix it* and not
*how much they hold* — and COM's view of the bars stays on the same 60 s
delay as everyone else's.

## Deliberate non-features

Do not let a future change add these:

- **No chat.** All inter-sector communication is voice or feet. A chat box
  routes the diagnostic data into silent text and destroys the product.
- **No auto-deducted resources.** `set_inventory` is a declaration; physical
  chits are the source of truth. Enforcement pushes arguments onto the screen
  and off the transcript.
- **No cascade engine.** The facilitator fires everything. `triggered_by`
  exists on every fault and stays `null`.
- **No accounts or cross-run persistence.** `reset_run` is the whole
  lifecycle.
- **No responsive layout.** Fixed 1366×768 on provided hardware.

---

## runlog.jsonl

One JSON object per line, appended on every state change, rotated on
`reset_run`. This file is joined to the table audio in debrief.

At R0 the facilitator fires the klaxon; the audio spike aligns every recording
to this log, and the sting is logged with its timestamp. **That entry is the
join key for the entire analytics pipeline.**

Logged: faults fired/resolved/cleared, every submission — accepted *and*
rejected, since failed attempts are diagnostic — inventory declarations,
mode/round/clock changes, announcements, facilitator overrides, observation
tags, and connect/disconnect.

The observation pad writes straight into it. That is how the debrief timeline
builds itself, and it is the highest-value surface in the control panel.

---

## Not included

Physical artifacts (spec §4) — binders, fault cards, transfer chits, the city
charter, role cards, the consent pack — are out of scope for this repo.

`lib/rounds.json` carries round lengths and mechanics from spec §8, but its
per-beat runbook rows are **empty**: inject timings and artifact instructions
("hand F-201 card to POW") come from the facilitation design and are authored
there. The control panel's off-script inject library is fully functional
meanwhile.
