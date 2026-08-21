# UNDERCITY — Websocket Message Contract & Build Handoff

**Companion to:** `undercity-spec.md` (design) · `undercity-crossref-matrix.xlsx` (content source of truth) · `export_faults.py` (fixture generator)
**Purpose:** the contract every client and the server agree on, written down *before* any code exists. Paste this into Claude Code as the first context of the build.

---

## 0. Read this first (build principles)

1. **The server is authoritative.** Clients never compute game state. They render what they are told and send intents. No optimistic UI.
2. **Broadcast full state, always.** ~3–5 KB JSON, 8 clients, human-speed events. Diffing is premature optimisation and a bug factory. One `state` message shape, every client re-renders from it.
3. **Content is loaded, never coded.** Server reads `content/faults.json`, `content/specs.json`, `content/sectors.json` at boot. Changing the game = re-running `export_faults.py`, not editing source.
4. **Two edge cases are structural, not exceptions.** `valid_codes` is an *array* (F-201 accepts two codes), and it may be *empty* (F-210 is a false alarm with no code). Any code path that assumes exactly one code is wrong.
5. **No chat feature, ever.** All inter-sector communication is voice or feet. A chat box would route the diagnostic data into silent text and destroy the product.
6. **Every state change is logged** to `runlog.jsonl` — this file is joined to audio timestamps in debrief. Logging is a P0 feature, not instrumentation.

---

## 1. Connection & identity

Three client roles, distinguished by URL at connect time:

| Role | URL | Count | Trust |
|------|-----|-------|-------|
| `sector` | `/sector/POW` … `/sector/COM` | 6 | Untrusted-ish (participants) |
| `bigscreen` | `/bigscreen` | 1 | Read-only |
| `control` | `/control?token=<FACILITATOR_TOKEN>` | 1 | Full authority |

On websocket open, client sends `hello`; server replies `state` (full snapshot) and thereafter broadcasts `state` on every change.

```json
// client -> server, first message
{ "type": "hello", "role": "sector", "sector": "POW", "token": null }
{ "type": "hello", "role": "control", "token": "haven9" }
```

```json
// server -> client, on accept
{ "type": "welcome", "role": "sector", "sector": "POW", "server_time": "2026-09-14T09:02:11.482Z" }
```

Rules: reject `control` without a matching token (closes socket). A second `control` connection is allowed (facilitator laptop dies mid-run — this must not be fatal). Sector clients reconnect freely; identity is the URL, there are no accounts or sessions.

**Heartbeat:** server pings every 20 s; client replies pong. Sector dashboard shows a small connection dot — amber on missed pong, red on disconnect, with "RECONNECTING". A frozen dashboard mid-crisis with no indicator is the worst possible failure mode in the room.

---

## 2. Server → all clients: `state`

The only message that carries game state. Full snapshot every time.

```json
{
  "type": "state",
  "server_time": "2026-09-14T10:42:03.117Z",
  "run_id": "2026-09-14-clientX-c1",
  "mode": "PLAY",
  "round": "R2",
  "round_clock": { "running": true, "remaining_s": 1140 },
  "council_clock": { "running": false, "remaining_s": 300 },
  "core_integrity": 74,
  "sectors": {
    "POW": {
      "code": "POW",
      "name": "Power Grid",
      "integrity": 61,
      "status": "ACTIVE",
      "workforce": { "active": 6, "injured": 2 },
      "inventory": { "power": 4, "water": 1, "parts": 2, "med": 0 },
      "upkeep_due_in_s": 252,
      "faults": [
        {
          "code": "F-201",
          "name": "Coolant loop failure",
          "flavour": "Turbine coolant pressure collapsing...",
          "severity": 2,
          "crew_required": 2,
          "resources_required": { "parts": 2, "water": 1 },
          "decay_per_min": 1.5,
          "deadline_remaining_s": null,
          "attempts": 3,
          "locked_until_s": 0,
          "fired_at": "2026-09-14T10:38:00.000Z"
        }
      ]
    }
  },
  "ticker": [
    { "t": "...", "kind": "resolve", "text": "WTR resolved F-105" },
    { "t": "...", "kind": "fault",   "text": "POW fault detected: F-201" },
    { "t": "...", "kind": "transfer","text": "WTR → POW transfer stamped" }
  ],
  "announcements": [
    { "t": "...", "text": "Core output dropping. Council convenes in 10 minutes." }
  ],
  "telemetry": { "wtr_reservoir_pressure": 290, "core_output_pct": 100 }
}
```

**`mode`:** `BRIEFING` | `PLAY` | `COUNCIL` | `PAUSED` | `DEBRIEF`
**`status`:** `ACTIVE` | `CRITICAL` (<30) | `BROWNOUT` | `DARK` (0)

### Visibility filtering — do this server-side, not client-side

The server sends each sector client a **filtered** state. Never send the full picture and hide it in CSS; participants will open devtools.

- Own sector: full fidelity.
- Other sectors: `integrity` and `status` only, **snapshotted 60 s ago** (server keeps a rolling delayed copy). No fault arrays, no inventory, no workforce.
- **COM exception:** `full_telemetry: true` in `sectors.json` — COM receives other sectors' *fault codes and names* in real time (not inventory). This is the asymmetric-information engine; it is a feature, not a leak.
- `bigscreen` receives integrity/status/ticker/telemetry for all, no fault detail, no inventory.
- `control` receives everything, undelayed, plus `valid_codes` for every active fault (the facilitator's live answer key).

`telemetry.wtr_reservoir_pressure` is **290** — the public half of the seeded discrepancy (the WTR binder prints 340). Both resolve F-201. Never reconcile these two numbers.

---

## 3. Sector client → server (participant intents)

```json
{ "type": "submit_code", "sector": "POW", "fault_code": "F-201",
  "code": "P-04-340", "workers_assigned": 2 }

{ "type": "set_inventory", "sector": "POW",
  "inventory": { "power": 4, "water": 1, "parts": 2, "med": 0 } }
```

`set_inventory` is a **declaration, not a transaction** — physical chits are the source of truth; the dashboard mirrors them. Teams keeping this synced out loud is deliberate design (§6.1 of the spec). The server records every declaration in the log; discrepancies between declared and actual chits are debrief material, not errors to prevent.

### `submit_code` resolution logic (server-side, exact order)

1. Fault exists, belongs to this sector, is unresolved → else `reject: "unknown_fault"`.
2. `locked_until_s > 0` → `reject: "locked"`.
3. `workers_assigned >= crew_required` and `≤ workforce.active` → else `reject: "insufficient_crew"`.
4. `code` (trimmed, uppercased, hyphens normalised) is in `valid_codes` → else increment `attempts`, `reject: "invalid_code"`; on 3 consecutive invalids set `locked_until_s = 20`.
5. **Resources are NOT auto-deducted.** The team declares spend via `set_inventory`; the server does not enforce it. Enforcement would push arguments onto the screen instead of into the room — and the paper chits already carry the audit trail.
6. On success: mark resolved, stop decay, apply `+5` integrity recovery, ticker entry crediting the sector, log it.

**Empty `valid_codes` (F-210, false alarm):** every submission returns `reject: "no_procedure"` with UI text *"No matching procedure. Verify this alert."* The facilitator clears it manually via `clear_fault` once COM confirms the ghost. Do not special-case F-210 by code — drive it off the empty array, so future false alarms need no code change.

```json
// server -> requesting client only
{ "type": "submit_result", "fault_code": "F-201", "accepted": true,
  "reason": null, "attempts": 3 }
{ "type": "submit_result", "fault_code": "F-201", "accepted": false,
  "reason": "invalid_code", "attempts": 4, "locked_until_s": 20 }
```

---

## 4. Control panel → server (facilitator authority)

Every message requires the token. Grouped by control-panel column (§6.3 of the spec).

**Col 1 — Runbook / injects**
```json
{ "type": "fire_fault",  "fault_code": "F-201", "sector": "POW" }
{ "type": "clear_fault", "fault_code": "F-210", "sector": "AGR", "reason": "false alarm confirmed" }
{ "type": "runbook_mark", "beat_id": "R2-04", "done": true }
```
`fire_fault` looks the fault up in `faults.json` and instantiates it on the sector, applying `injures_workforce` (tokens move to MED's injured count) — server-side, so the facilitator never has to remember.

**Col 2 — City state (god view)**
```json
{ "type": "set_integrity", "sector": "POW", "value": 45 }
{ "type": "set_status",    "sector": "AGR", "value": "BROWNOUT" }
{ "type": "adjust_workforce", "sector": "MED", "active": 1, "injured": -1 }
{ "type": "adjust_inventory", "sector": "WTR", "delta": { "parts": -2 } }
{ "type": "set_core_integrity", "value": 60 }
{ "type": "accelerate_fault", "fault_code": "F-301", "decay_per_min": 4.0 }
```

**Col 3 — Tempo**
```json
{ "type": "set_round", "round": "R3" }
{ "type": "clock", "action": "start" }        // start | pause | add, with "seconds"
{ "type": "set_mode", "mode": "COUNCIL" }     // triggers big-screen takeover + 5:00
{ "type": "announce", "text": "Core output dropping to 60 percent." }
{ "type": "sting", "sound": "klaxon" }        // klaxon | chime | silence
{ "type": "breather", "on": true }            // pauses ALL decay and clocks
```

**Col 4 — Observation pad**
```json
{ "type": "observe", "sector": "POW", "tag": "DOMINANCE",
  "note": "Chief cut off liaison twice during transfer negotiation" }
```
Tags: `DOMINANCE` `WITHDRAWAL` `SAFETY+` `SAFETY-` `DISCREPANCY-SPOTTED`. Writes straight to `runlog.jsonl` — this is how the debrief timeline builds itself. **This is the highest-value feature in the control panel; build it early, not last.**

**Run control**
```json
{ "type": "reset_run", "run_id": "2026-09-14-clientX-c2", "confirm": true }
{ "type": "snapshot" }
{ "type": "export_log" }
```

---

## 5. `runlog.jsonl` — one JSON object per line

```json
{"t":"2026-09-14T10:38:00.112Z","ev":"fault_fired","sector":"POW","fault":"F-201","round":"R2"}
{"t":"2026-09-14T10:41:22.900Z","ev":"submit","sector":"POW","fault":"F-201","code":"P-04-291","accepted":false,"reason":"invalid_code","attempts":2}
{"t":"2026-09-14T10:42:03.117Z","ev":"submit","sector":"POW","fault":"F-201","code":"P-04-340","accepted":true,"workers":2}
{"t":"2026-09-14T10:44:10.004Z","ev":"observe","sector":"POW","tag":"SAFETY-","note":"Engineer flagged 290/340 mismatch, chief dismissed it"}
{"t":"2026-09-14T10:45:00.000Z","ev":"mode","mode":"COUNCIL"}
```

Log every: fault fired/resolved/cleared, every submit (accepted *and* rejected — failed attempts are diagnostic), inventory declarations, mode/round/clock changes, announcements, facilitator overrides, observation tags, connect/disconnect.

**Clock sync:** at R0 the facilitator fires `sting: klaxon`; the audio spike aligns every recording to this log. Log the sting with its timestamp — it is the join key for the entire analytics pipeline.

---

## 6. Build order for Claude Code

1. **Server skeleton** — Express + `ws`, load the three JSON fixtures, in-memory state, 10 s decay tick, snapshot to disk every 10 s, `runlog.jsonl` appender.
2. **`hello`/`state` loop + visibility filter** — get the filtering right here; retrofitting it later means auditing every view.
3. **Sector dashboard** — three columns per spec §6.1. Test against F-201 (two valid codes) and F-210 (empty array) before building anything else.
4. **Control panel** — ugly is fine, complete is not. Runbook column + observation pad first.
5. **Big screen** — the HAVEN-9 cross-section SVG deserves real design time; everything else on it is bars and a ticker.
6. **Council mode + brownout/dark states** — the R3 climax path, end to end.

**Definition of done for MVP:** a full R1→R4 dry run with 6 laptops on the offline router, no restarts, `runlog.jsonl` complete and timestamp-aligned to a klaxon spike.

---

## 7. Deliberate non-features (do not let the build add these)

- ❌ Chat / messaging between sectors — destroys the diagnostic.
- ❌ Auto-deducted resources — pushes arguments onto the screen, off the transcript.
- ❌ Automated cascade rules engine — facilitator fires everything in MVP (`triggered_by` field exists, stays `null`).
- ❌ Accounts, logins, persistence between runs — every run is stateless; `reset_run` is the whole lifecycle.
- ❌ Mobile-responsive layouts — fixed 1366×768 on provided hardware.
- ❌ Reconciling telemetry 290 with binder 340 — that mismatch *is* the psychological safety probe.
