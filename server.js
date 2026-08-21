'use strict';
/**
 * UNDERCITY server — HAVEN-9.
 *
 * Single Node process (spec §5.1): Express serves three static views, `ws`
 * carries the whole protocol. Authoritative state lives in memory and is
 * snapshotted to disk every 10 s so a crash mid-session costs seconds, not the
 * run. Content is loaded from content/*.json at boot and never written.
 *
 *   /sector/:code       participant dashboard  (6 instances)
 *   /bigscreen          projection view        (1)
 *   /control?token=…    facilitator panel      (1, second connection allowed)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { validateContent } = require('./lib/validate');
const { RunLog } = require('./lib/log');
const { GameState } = require('./lib/state');
const { submitCode } = require('./lib/resolve');
const { filterState } = require('./lib/visibility');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.FACILITATOR_TOKEN || 'haven9';
const CONTENT_DIR = path.join(__dirname, 'content');
const HEARTBEAT_MS = 20000;

// Where this run's log and snapshot live. Overridable so a second instance
// never writes over the first's files — and so the facilitator can point the
// log at a USB stick for the debrief.
const RUNLOG_PATH = process.env.RUNLOG_PATH || path.join(__dirname, 'runlog.jsonl');
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || path.join(__dirname, 'snapshot.json');

// -- content ------------------------------------------------------------------

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const content = {
  faults: loadJson(path.join(CONTENT_DIR, 'faults.json')),
  specs: loadJson(path.join(CONTENT_DIR, 'specs.json')),
  sectors: loadJson(path.join(CONTENT_DIR, 'sectors.json')),
};
const rounds = loadJson(path.join(__dirname, 'lib', 'rounds.json'));

const { errors, warnings } = validateContent(content);
if (warnings.length) {
  console.warn('\n⚠  CONTENT WARNINGS — see CONTENT-ISSUES.md');
  for (const w of warnings) console.warn('   ⚠', w);
  console.warn('');
}
if (errors.length) {
  console.error('\n✗ CONTENT VALIDATION FAILED — refusing to boot:\n');
  for (const e of errors) console.error('   ✗', e);
  console.error('\nFix the crossref matrix and re-run tools/export_faults.py.\n');
  process.exit(1);
}
console.log(
  `✓ content OK — ${content.faults.faults.length} faults, ` +
  `${content.specs.specs.length} specs, ${Object.keys(content.sectors.sectors).length} sectors`
);

// -- state --------------------------------------------------------------------

const log = new RunLog(RUNLOG_PATH, SNAPSHOT_PATH);

function defaultRunId() {
  return `${new Date().toISOString().slice(0, 10)}-run`;
}

const game = new GameState({ content, rounds, runId: defaultRunId(), log });

if (process.env.RESUME !== '0') {
  const snap = log.readSnapshot();
  if (snap && game.restore(snap)) {
    console.log(`✓ resumed from snapshot (run ${game.state.run_id}, saved ${snap.saved_at})`);
  }
}

// -- http ---------------------------------------------------------------------

const app = express();
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared')));

// Static assets first: /sector/sector.css must not be read as sector "SECTOR.CSS".
// Unmatched paths fall through to the view routes below.
// redirect:false stops express.static bouncing /bigscreen to /bigscreen/ before
// the view route below can answer it.
const staticOpts = { redirect: false };
app.use('/sector', express.static(path.join(__dirname, 'public', 'sector'), staticOpts));
app.use('/bigscreen', express.static(path.join(__dirname, 'public', 'bigscreen'), staticOpts));
app.use('/control', express.static(path.join(__dirname, 'public', 'control'), staticOpts));

app.get('/', (_req, res) => {
  res.redirect('/bigscreen');
});
app.get('/sector/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!content.sectors.sectors[code]) return res.status(404).send('Unknown sector');
  res.sendFile(path.join(__dirname, 'public', 'sector', 'index.html'));
});
app.get('/bigscreen', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bigscreen', 'index.html'));
});
app.get('/control', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control', 'index.html'));
});

// Content the facilitator panel needs to populate its inject library. This is
// the answer key, so it is token-gated exactly like the control socket.
app.get('/api/content', (req, res) => {
  if (req.query.token !== TOKEN) return res.status(403).json({ error: 'forbidden' });
  res.json({ faults: content.faults, specs: content.specs, sectors: content.sectors, rounds });
});

app.get('/api/log', (req, res) => {
  if (req.query.token !== TOKEN) return res.status(403).send('forbidden');
  res.type('application/x-ndjson')
     .set('Content-Disposition', `attachment; filename="runlog-${game.state.run_id}.jsonl"`)
     .send(log.readAll());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// -- clients ------------------------------------------------------------------

const clients = new Set();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/** Broadcast full state to every client, each through its own filter. */
function broadcast() {
  for (const client of clients) {
    if (!client.ready) continue;
    send(client.ws, filterState(game, client));
  }
}

function requireControl(client) {
  return client.role === 'control';
}

wss.on('connection', (ws, req) => {
  const client = { ws, role: null, sector: null, ready: false, alive: true };
  clients.add(client);

  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', reason: 'bad_json' });
    }
    handleMessage(client, msg);
  });

  ws.on('close', () => {
    clients.delete(client);
    if (client.ready) {
      log.write('disconnect', { role: client.role, sector: client.sector });
    }
  });

  ws.on('error', () => { /* close handler does the cleanup */ });
});

// Heartbeat: a frozen dashboard with no indicator is the worst failure mode in
// the room (contract §1), so the server proves liveness every 20 s.
setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    try { client.ws.ping(); } catch { /* terminated below on next sweep */ }
  }
}, HEARTBEAT_MS);

// -- protocol -----------------------------------------------------------------

function handleMessage(client, msg) {
  if (msg.type === 'hello') return handleHello(client, msg);
  if (!client.ready) return send(client.ws, { type: 'error', reason: 'not_ready' });

  switch (msg.type) {
    // -- participant intents --------------------------------------------------
    case 'submit_code': {
      if (client.role !== 'sector' || client.sector !== msg.sector) {
        return send(client.ws, { type: 'error', reason: 'wrong_sector' });
      }
      const result = submitCode(game, msg);
      send(client.ws, result);
      return broadcast();
    }
    case 'set_inventory': {
      if (client.role !== 'sector' || client.sector !== msg.sector) {
        return send(client.ws, { type: 'error', reason: 'wrong_sector' });
      }
      game.setInventory(msg.sector, msg.inventory || {});
      return broadcast();
    }

    // -- facilitator authority ------------------------------------------------
    default: {
      if (!requireControl(client)) {
        return send(client.ws, { type: 'error', reason: 'forbidden' });
      }
      return handleControl(client, msg);
    }
  }
}

function handleHello(client, msg) {
  const role = msg.role;

  if (role === 'control') {
    if (msg.token !== TOKEN) {
      send(client.ws, { type: 'error', reason: 'bad_token' });
      log.write('auth_rejected', { role: 'control' });
      return client.ws.close();
    }
    client.role = 'control';
  } else if (role === 'bigscreen') {
    client.role = 'bigscreen';
  } else if (role === 'sector') {
    const code = String(msg.sector || '').toUpperCase();
    if (!content.sectors.sectors[code]) {
      send(client.ws, { type: 'error', reason: 'unknown_sector' });
      return client.ws.close();
    }
    client.role = 'sector';
    client.sector = code;
  } else {
    send(client.ws, { type: 'error', reason: 'unknown_role' });
    return client.ws.close();
  }

  client.ready = true;
  send(client.ws, {
    type: 'welcome',
    role: client.role,
    sector: client.sector,
    server_time: new Date().toISOString(),
  });
  send(client.ws, filterState(game, client));
  log.write('connect', { role: client.role, sector: client.sector });
}

function handleControl(client, msg) {
  const ok = () => broadcast();

  switch (msg.type) {
    // Col 1 — runbook / injects
    case 'fire_fault': {
      const result = game.fireFault(msg.fault_code, msg.sector);
      send(client.ws, { type: 'fire_result', ...result });
      return ok();
    }
    case 'clear_fault':
      game.clearFault(msg.sector, msg.fault_code, msg.reason);
      return ok();
    case 'runbook_mark': {
      if (msg.done) game.runbookDone.add(msg.beat_id);
      else game.runbookDone.delete(msg.beat_id);
      log.write('runbook_mark', { beat_id: msg.beat_id, done: !!msg.done });
      return ok();
    }

    // Col 2 — city state
    case 'set_integrity':      game.setIntegrity(msg.sector, msg.value); return ok();
    case 'set_status':         game.setStatus(msg.sector, msg.value); return ok();
    case 'adjust_workforce':   game.adjustWorkforce(msg.sector, msg.active, msg.injured); return ok();
    case 'adjust_inventory':   game.adjustInventory(msg.sector, msg.delta); return ok();
    case 'set_core_integrity': game.setCoreIntegrity(msg.value); return ok();
    case 'accelerate_fault':
      game.accelerateFault(msg.sector, msg.fault_code, msg.decay_per_min); return ok();
    case 'pause_fault':
      game.pauseFault(msg.sector, msg.fault_code, msg.paused); return ok();

    // Col 3 — tempo
    case 'set_round': game.setRound(msg.round); return ok();
    case 'clock':     game.clock(msg.action, msg.seconds, msg.which); return ok();
    case 'set_mode':  game.setMode(msg.mode); return ok();
    case 'announce':  game.announce(msg.text); return ok();
    case 'sting': {
      // The R0 klaxon is the join key for every audio recording (contract §5).
      log.write('sting', { sound: msg.sound });
      for (const c of clients) {
        if (c.ready && (c.role === 'bigscreen' || c.role === 'sector')) {
          send(c.ws, { type: 'sting', sound: msg.sound });
        }
      }
      return ok();
    }
    case 'breather': game.setBreather(msg.on); return ok();
    case 'set_telemetry': {
      // Never used to reconcile 290 with the binder's 340 (contract §7).
      Object.assign(game.state.telemetry, msg.telemetry || {});
      log.write('set_telemetry', { telemetry: msg.telemetry });
      return ok();
    }

    // Col 4 — observation pad (the debrief timeline builds itself from these)
    case 'observe':
      log.write('observe', { sector: msg.sector || null, tag: msg.tag || null, note: msg.note || '' });
      send(client.ws, { type: 'observe_ack', t: new Date().toISOString() });
      return;

    // Run control
    case 'reset_run': {
      if (!msg.confirm) return send(client.ws, { type: 'error', reason: 'confirm_required' });
      const runId = msg.run_id || defaultRunId();
      log.write('run_end', { run_id: game.state.run_id });
      log.rotate(game.state.run_id);
      game.reset(runId);
      log.writeSnapshot(game.serialise());
      return ok();
    }
    case 'snapshot':
      log.writeSnapshot(game.serialise());
      send(client.ws, { type: 'snapshot_ack', t: new Date().toISOString() });
      return;
    case 'export_log':
      send(client.ws, { type: 'export_ready', url: `/api/log?token=${encodeURIComponent(TOKEN)}` });
      return;

    default:
      return send(client.ws, { type: 'error', reason: 'unknown_message', got: msg.type });
  }
}

// -- loops --------------------------------------------------------------------

const tickMs = rounds.defaults.tick_ms;
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  game.tick(now - lastTick);
  lastTick = now;
  broadcast();
}, tickMs);

setInterval(() => log.writeSnapshot(game.serialise()), rounds.defaults.snapshot_ms);

server.listen(PORT, () => {
  console.log(`\nUNDERCITY — HAVEN-9`);
  console.log(`  sector      http://localhost:${PORT}/sector/POW`);
  console.log(`  big screen  http://localhost:${PORT}/bigscreen`);
  console.log(`  control     http://localhost:${PORT}/control?token=${TOKEN}\n`);
  log.write('server_start', { run_id: game.state.run_id, port: PORT });
});

module.exports = { app, server, game, wss };
