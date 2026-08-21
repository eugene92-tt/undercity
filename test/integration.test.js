'use strict';
/**
 * End-to-end dry run over real websockets: a scripted facilitator drives an
 * R1→R4 shift while six sector clients and a big screen are connected, and we
 * assert on the frames each role actually receives plus the resulting log.
 *
 * This is the contract's definition of done, minus the six physical laptops.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 3222;
const TOKEN = 'test-token';
const SECTORS = ['POW', 'WTR', 'MED', 'TRN', 'AGR', 'COM'];

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** A connected client that keeps its latest state frame and every message. */
function client(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const api = { ws, state: null, messages: [], hello };
    const timer = setTimeout(() => reject(new Error(`${hello.role} never welcomed`)), 5000);

    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      api.messages.push(msg);
      if (msg.type === 'state') api.state = msg;
      // welcome is immediately followed by a state frame; wait for both so
      // callers never see a half-initialised client.
      if (api.state) { clearTimeout(timer); resolve(api); }
    });
    ws.on('error', reject);
  });
}

let server;
let runDir;

test.before(async () => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-e2e-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FACILITATOR_TOKEN: TOKEN, RESUME: '0' },
    stdio: 'ignore',
  });
  // Give the process time to validate content and bind.
  for (let i = 0; i < 40; i += 1) {
    try {
      const probe = await client({ type: 'hello', role: 'bigscreen' });
      probe.ws.close();
      return;
    } catch { await wait(250); }
  }
  throw new Error('server never came up');
});

test.after(() => {
  if (server) server.kill();
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a full R1→R4 dry run, six sectors on one server', async (t) => {
  const control = await client({ type: 'hello', role: 'control', token: TOKEN });
  const big = await client({ type: 'hello', role: 'bigscreen' });
  const sectors = {};
  for (const code of SECTORS) {
    sectors[code] = await client({ type: 'hello', role: 'sector', sector: code });
  }
  const say = (msg) => control.ws.send(JSON.stringify(msg));

  await t.test('a fresh run starts every sector at full integrity', async () => {
    say({ type: 'reset_run', run_id: 'e2e-run', confirm: true });
    await wait(300);
    for (const code of SECTORS) {
      assert.equal(big.state.sectors[code].integrity, 100);
      assert.equal(big.state.sectors[code].status, 'ACTIVE');
    }
  });

  await t.test('R0 klaxon is logged — the audio join key', async () => {
    say({ type: 'set_mode', mode: 'PLAY' });
    say({ type: 'set_round', round: 'R0' });
    say({ type: 'sting', sound: 'klaxon' });
    await wait(300);
    assert.ok(sectors.POW.messages.some((m) => m.type === 'sting' && m.sound === 'klaxon'),
      'sector clients hear the sting');
    assert.ok(big.messages.some((m) => m.type === 'sting'), 'big screen hears it too');
  });

  await t.test('R1: a self-contained fault fires and resolves', async () => {
    say({ type: 'set_round', round: 'R1' });
    say({ type: 'clock', which: 'round', action: 'start' });
    say({ type: 'fire_fault', fault_code: 'F-101', sector: 'POW' });
    await wait(300);

    assert.equal(sectors.POW.state.sectors.POW.faults[0].code, 'F-101');
    assert.equal(sectors.WTR.state.sectors.POW.faults, undefined,
      'WTR must not see POW fault detail');

    sectors.POW.ws.send(JSON.stringify({
      type: 'submit_code', sector: 'POW', fault_code: 'F-101',
      code: 'P-02-990', workers_assigned: 1,
    }));
    await wait(300);

    const result = sectors.POW.messages.filter((m) => m.type === 'submit_result').pop();
    assert.equal(result.accepted, true);
    assert.equal(sectors.POW.state.sectors.POW.faults.length, 0);
  });

  await t.test('R2: the discrepancy fault takes either code', async () => {
    say({ type: 'set_round', round: 'R2' });
    say({ type: 'fire_fault', fault_code: 'F-201', sector: 'POW' });
    await wait(300);

    sectors.POW.ws.send(JSON.stringify({
      type: 'submit_code', sector: 'POW', fault_code: 'F-201',
      code: 'P-04-290', workers_assigned: 2,
    }));
    await wait(300);
    const result = sectors.POW.messages.filter((m) => m.type === 'submit_result').pop();
    assert.equal(result.accepted, true, 'the big screen\'s 290 resolves it');
  });

  await t.test('R2: the false alarm is unsolvable and cleared by hand', async () => {
    say({ type: 'fire_fault', fault_code: 'F-210', sector: 'AGR' });
    await wait(300);

    sectors.AGR.ws.send(JSON.stringify({
      type: 'submit_code', sector: 'AGR', fault_code: 'F-210',
      code: 'P-04-401', workers_assigned: 0,
    }));
    await wait(300);
    const result = sectors.AGR.messages.filter((m) => m.type === 'submit_result').pop();
    assert.equal(result.reason, 'no_procedure');

    say({ type: 'clear_fault', sector: 'AGR', fault_code: 'F-210', reason: 'false alarm confirmed' });
    await wait(300);
    assert.equal(sectors.AGR.state.sectors.AGR.faults.length, 0);
  });

  await t.test('COM sees a foreign fault the affected sector\'s neighbours cannot', async () => {
    say({ type: 'fire_fault', fault_code: 'F-205', sector: 'MED' });
    await wait(300);

    const asCom = COM_view(sectors.COM.state);
    assert.ok(asCom.includes('F-205'), 'COM sees the code');
    assert.equal(sectors.WTR.state.sectors.MED.faults, undefined, 'WTR sees nothing');
    assert.equal(sectors.COM.state.sectors.MED.inventory, undefined,
      'COM still gets no inventory');

    function COM_view(state) {
      return (state.sectors.MED.faults || []).map((f) => f.code);
    }
  });

  await t.test('council mode reaches every screen', async () => {
    say({ type: 'set_mode', mode: 'COUNCIL' });
    await wait(300);
    assert.equal(big.state.mode, 'COUNCIL');
    assert.equal(sectors.POW.state.mode, 'COUNCIL');
    assert.equal(sectors.POW.state.council_clock.remaining_s, 300);
    say({ type: 'set_mode', mode: 'PLAY' });
    await wait(200);
  });

  await t.test('R3: brownout halves delivery, DARK locks the dashboard', async () => {
    say({ type: 'set_round', round: 'R3' });
    say({ type: 'set_core_integrity', value: 60 });
    say({ type: 'set_status', sector: 'AGR', value: 'BROWNOUT' });
    say({ type: 'fire_fault', fault_code: 'F-301', sector: 'POW' });
    await wait(300);

    const agr = sectors.AGR.state.sectors.AGR;
    assert.equal(agr.status, 'BROWNOUT');
    assert.equal(agr.brownout, true);
    assert.equal(agr.upkeep_delivery.power, 1, 'half of 2 power');
    assert.equal(agr.upkeep_per_round.power, 2, 'the full entitlement is still shown');

    say({ type: 'set_status', sector: 'TRN', value: 'DARK' });
    await wait(300);
    assert.equal(sectors.TRN.state.sectors.TRN.status, 'DARK');

    say({ type: 'fire_fault', fault_code: 'F-304', sector: 'TRN' });
    await wait(300);
    sectors.TRN.ws.send(JSON.stringify({
      type: 'submit_code', sector: 'TRN', fault_code: 'F-304',
      code: 'P-06-793-509', workers_assigned: 2,
    }));
    await wait(300);
    const result = sectors.TRN.messages.filter((m) => m.type === 'submit_result').pop();
    assert.equal(result.reason, 'sector_dark', 'a dark sector cannot submit');
  });

  await t.test('R4: a two-spec fault resolves and credits the sector publicly', async () => {
    say({ type: 'set_status', sector: 'TRN', value: 'ACTIVE' });
    say({ type: 'set_round', round: 'R4' });
    say({ type: 'fire_fault', fault_code: 'F-403', sector: 'WTR' });
    await wait(300);

    sectors.WTR.ws.send(JSON.stringify({
      type: 'submit_code', sector: 'WTR', fault_code: 'F-403',
      code: 'P-07-490-795', workers_assigned: 2,
    }));
    await wait(400);

    const result = sectors.WTR.messages.filter((m) => m.type === 'submit_result').pop();
    assert.equal(result.accepted, true);
    assert.ok(big.state.ticker.some((e) => e.text === 'WTR resolved F-403'),
      'the resolve is credited on the public ticker');
  });

  await t.test('facilitator observations land in the log beside game events', async () => {
    say({ type: 'observe', sector: 'POW', tag: 'DISCREPANCY-SPOTTED',
          note: 'Engineer flagged 290/340 mismatch, chief dismissed it' });
    say({ type: 'announce', text: 'Core output stabilising.' });
    await wait(400);
    assert.equal(sectors.POW.state.announcements[0].text, 'Core output stabilising.');
  });

  await t.test('the answer key never appeared in any participant frame', () => {
    for (const code of SECTORS) {
      const frames = sectors[code].messages.filter((m) => m.type === 'state');
      for (const frame of frames) {
        const json = JSON.stringify(frame);
        assert.ok(!json.includes('valid_codes'), `${code} received valid_codes`);
        assert.ok(!json.includes('P-04-340'), `${code} received an answer key`);
        assert.ok(!json.includes('P-07-490-795'), `${code} received an R4 answer key`);
      }
    }
    const bigJson = JSON.stringify(big.messages.filter((m) => m.type === 'state'));
    assert.ok(!bigJson.includes('valid_codes'), 'big screen received valid_codes');
  });

  await t.test('a second control connection is allowed (facilitator laptop dies)', async () => {
    const spare = await client({ type: 'hello', role: 'control', token: TOKEN });
    assert.equal(spare.state.role, 'control');
    assert.ok(spare.state.sectors.POW.faults.every((f) => 'valid_codes' in f));
    spare.ws.close();
  });

  await t.test('a bad facilitator token is refused and the socket closed', async () => {
    await assert.rejects(
      () => client({ type: 'hello', role: 'control', token: 'wrong' }),
      'a control client with the wrong token must never be welcomed'
    );
  });

  await t.test('runlog.jsonl is complete and timestamp-aligned', () => {
    const lines = fs.readFileSync(path.join(ROOT, 'runlog.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));

    const kinds = new Set(lines.map((e) => e.ev));
    for (const required of [
      'run_reset', 'connect', 'mode', 'round', 'sting', 'fault_fired',
      'submit', 'fault_cleared', 'observe', 'announce', 'set_status',
      'set_core_integrity', 'clock',
    ]) {
      assert.ok(kinds.has(required), `runlog is missing "${required}" events`);
    }

    // Every line must carry a parseable ISO timestamp — the audio join depends
    // on it, so a single malformed line breaks the debrief pipeline.
    for (const entry of lines) {
      assert.ok(!Number.isNaN(Date.parse(entry.t)), `bad timestamp: ${entry.t}`);
    }

    const klaxon = lines.find((e) => e.ev === 'sting' && e.sound === 'klaxon');
    assert.ok(klaxon && klaxon.t, 'the klaxon must be logged with its timestamp');

    const rejected = lines.filter((e) => e.ev === 'submit' && e.accepted === false);
    assert.ok(rejected.length > 0, 'failed attempts are diagnostic and must be logged');
    const accepted = lines.filter((e) => e.ev === 'submit' && e.accepted === true);
    assert.ok(accepted.length >= 3, 'accepted submissions are logged with their workers');

    const obs = lines.find((e) => e.ev === 'observe');
    assert.equal(obs.tag, 'DISCREPANCY-SPOTTED');
    assert.equal(obs.sector, 'POW');
  });

  for (const c of [control, big, ...Object.values(sectors)]) c.ws.close();
});
