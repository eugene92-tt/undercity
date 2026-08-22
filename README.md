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

## Two ways to run it

UNDERCITY runs in two modes from one codebase.

### Hosted — the platform

Many concurrent sessions, facilitator accounts, an admin panel that creates a
session, names the six tables and hands each one a join link.

```bash
npm install
npm run create-user -- you@example.com "Your Name"   # prints a password once
npm start                                            # http://localhost:3000/admin
```

| Screen | URL |
|---|---|
| Admin | `/admin` |
| Big screen | `/s/<CODE>/bigscreen` |
| Control panel | `/s/<CODE>/control?token=…` |
| A team's dashboard | `/j/<JOIN CODE>` → their own sector |

Each team's join link resolves straight to their sector — nothing to pick and
nothing to type on six laptops while a room fills up.

### LAN — the travel router

The original single-run behaviour, no accounts, bare URLs. **Keep using this
whenever the venue's network is not yours.** The spec calls hotel WiFi *"the #1
failure mode for this class of product"* (§5.1), and a hosted session dies with
the venue's uplink.

```bash
MODE=lan npm start
```

| Screen | URL | Count |
|---|---|---|
| Sector dashboard | `/sector/POW` … `/sector/COM` | 6 |
| Big screen | `/bigscreen` | 1 |
| Control panel | `/control?token=haven9` | 1 (a second is allowed) |

```bash
PORT=3000 FACILITATOR_TOKEN=haven9 MODE=lan npm start
RUNLOG_PATH=/media/usb/run.jsonl MODE=lan npm start   # log straight to a stick
npm test                                              # 78 tests, ~25s
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `lan` unless `DATA_DIR` is set | `hosted` or `lan` |
| `DATA_DIR` | `./data` | SQLite file and one runlog per session |
| `PORT` | `3000` | |
| `FACILITATOR_TOKEN` | `haven9` | LAN mode control-panel token |
| `SECURE_COOKIES` | on when `NODE_ENV=production` | `Secure` flag on the admin cookie |
| `RUNLOG_PATH` / `SNAPSHOT_PATH` | under `DATA_DIR` | LAN mode only |

---

## Deploying (Render)

`render.yaml` and the `Dockerfile` deploy the hosted mode as a single always-on
service with a persistent disk.

1. Push the repo and point Render at the blueprint.
2. Render provisions a 5 GB disk at `/var/data` — SQLite and the run logs.
3. Once live, open a shell on the service and create your first account:
   ```
   npm run create-user -- you@example.com "Your Name"
   ```
4. Sign in at `https://<your-service>/admin`.

**Do not raise `numInstances` above 1.** Game state is authoritative in memory
and broadcast to every client of a session (contract §0.1–0.2). A second
instance would hold its own copy of every game, and clients would see whichever
one the load balancer happened to pick. Scaling this safely means moving state
to Redis, which the contract deliberately rules out for the MVP.

**A paid instance is required.** Free instances sleep when idle, and a server
that sleeps mid-session ends the run.

### Why not Vercel

Vercel's WebSocket support (public beta, June 2026) pins a connection to a
single function instance for at most 30 minutes, with no built-in way to
broadcast between instances, and recommends Redis for any shared state. R2 and
R3 are 30 minutes each, and the whole design is one authoritative process
broadcasting full state to eight clients — so the platform's two hard limits
are exactly the two things this app does.

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
  db.js                SQLite: facilitators, sessions, teams
  auth.js              scrypt passwords, server-side cookie sessions
  sessions.js          registry of concurrent games, one per session
public/sector          dashboard   (spec §6.1)
public/bigscreen       projection  (spec §6.2)
public/control         facilitator (spec §6.3)
public/admin           session management (hosted mode)
scripts/create-user.js facilitator accounts
tools/                 workbook generator, the matrix itself, and the exporter
tools/kit/             paper-kit generators (binders, cards, charter, guides)
kit/                   the generated documents + MANIFEST.json, ready to print
lib/kit.js             manifest reading, audience split, paper/server sync check
lib/zip.js             minimal STORE-method zip writer for download-all
test/                  unit, visibility, integration and resilience suites
```

---

## Content pipeline

The spreadsheet is the game. The code is a display layer.

```
tools/build_crossref.py              generates the workbook (deterministic, seed 9)
  └─ recalculate in Excel/LibreOffice   formulas must be cached
       ├─ npm run export-content        → content/*.json   (server)
       └─ npm run kit                   → kit/*.docx       (paper)
```

Both branches read the **same cells**, so paper and server cannot disagree.
That is the property the whole design rests on: a hand-fix to either side
desynchronises them and makes a fault unsolvable mid-session.

Ordinary content edits start at the workbook, not the generator: edit
`tools/undercity-crossref-matrix.xlsx`, recalculate, re-export. The generator is
there so the workbook itself is reproducible — `random.seed(9)` fixes every spec
value, so re-running it does not invalidate printed binders.

**Never hand-edit `content/*.json`.** A hand-fix desynchronises paper from
server and makes a fault unsolvable mid-session — the one failure a
facilitator cannot recover from live (spec §1).

`lib/validate.js` re-checks the fixtures at every boot: it re-derives every
resolution code from `specs.json`, enforces spec-value uniqueness, rejects
ambiguous codes, and flags flavour text that contradicts the answer key.
**Errors abort startup.** Warnings print loudly and allow the run.

`content/` currently validates clean — 0 errors, 0 warnings. Findings to date,
including the F-208 card/answer-key mismatch and the exporter bug that silently
accepted an uncalculated workbook, are recorded in **`CONTENT-ISSUES.md`**.

---

## The paper kit

### Getting the documents

Sign in to `/admin` → **PRINT KIT**. Every document is downloadable
individually, as a participant-facing set, as a facilitator-only set, or all
thirteen as one zip.

The page splits them deliberately:

| Group | Documents | Rule |
|---|---|---|
| **Participant-facing** | fault cards, City Charter, role cards, transfer chits, consent pack + table tents | safe to hand out and leave on a table |
| **Facilitator only** | answer key, six sector binders, the Guidebook | never leave on a participant table |

A badge at the top says whether the kit matches the content the server is
actually running. It is not a guess: the manifest records the SHA-256 of every
content file at the moment the documents were built, and the server re-hashes
its own content and compares. Green means printing is safe; red means the kit
predates a content change and printing it risks handing teams values the
server will reject.

That guarantee comes from **where** generation happens. The kit is built during
the Docker build, in a stage that runs the generators against the same matrix
and the same `content/*.json` that ship in the image. Paper and server come out
of one build, together. There is deliberately no "regenerate" button and no
Python in the runtime image — nothing on the server can produce a document that
disagrees with the game it is serving. To change the kit, change the matrix and
redeploy.

### Rebuilding locally

`npm run kit` regenerates all thirteen documents: six sector binders, the fault
card deck, the facilitator answer key, the City Charter and Continuity Order,
transfer chits, role cards, the consent pack and table tents, and the
Facilitator & Administrator Guidebook. Requires `openpyxl` (Python) and the
`docx` devDependency.

Three content rules are enforced by the generators, not by discipline:

- **A card prints the symptom only.** Flavour lines read `"SYMPTOM; needs X
  from Y"`; the half after the semicolon is the lookup the team must earn by
  talking to another sector. `lib/visibility.js` applies the same cut before
  sending state to a dashboard, so the screen cannot hand over what the paper
  withholds.
- **A binder never prints another sector's spec values**, and never a complete
  resolution code — only the procedure, the cost, and *where* to fetch each
  value. `assemble_binders.py` fails the build if a binder would leak.
- **Appendix C gets no index entry.** It is findable only by reading the
  binder, and nothing on screen names it.

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
- **No participant accounts.** Facilitators sign in; teams never do. A table
  joins by code and stays anonymous, and nothing about a participant persists
  between runs. The hosted mode adds session management, not participant
  identity.
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
