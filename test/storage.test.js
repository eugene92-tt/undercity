'use strict';
/**
 * The storage check.
 *
 * Without a mounted disk the app runs perfectly and loses everything on the
 * next restart, with no signal until someone notices their account is gone.
 * These tests pin the detection and, more importantly, that it is loud.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { inspectStorage, mountFor, LEDGER } = require('../lib/storage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'undercity-storage-'));

test('a fresh directory on the container filesystem reads as ephemeral', () => {
  const dir = tmp();
  const info = inspectStorage(dir);

  assert.equal(info.verdict, 'ephemeral');
  assert.equal(info.boots, 1);
  assert.equal(info.fresh, true);
  assert.match(info.detail, /will be lost when the instance restarts/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('surviving a restart is treated as proof, outranking the heuristic', () => {
  const dir = tmp();

  const first = inspectStorage(dir);
  assert.equal(first.verdict, 'ephemeral', 'nothing is proven on a first boot');

  // Same directory, second process: the ledger came back, so it demonstrably
  // persisted — regardless of what the mount table says.
  const second = inspectStorage(dir);
  assert.equal(second.verdict, 'persistent');
  assert.equal(second.boots, 2);
  assert.match(second.detail, /survived 1 restart/);

  const third = inspectStorage(dir);
  assert.equal(third.boots, 3);
  assert.match(third.detail, /survived 2 restarts/);
  assert.equal(third.instance_id, first.instance_id, 'the same data directory, not a new one');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a wiped directory falls back to ephemeral — the loss is detected', () => {
  const dir = tmp();
  inspectStorage(dir);
  assert.equal(inspectStorage(dir).verdict, 'persistent');

  // Simulate the container being replaced with no disk attached.
  fs.rmSync(path.join(dir, LEDGER));

  const afterWipe = inspectStorage(dir);
  assert.equal(afterWipe.verdict, 'ephemeral',
    'a restart that lost the ledger must not still claim to be persistent');
  assert.equal(afterWipe.boots, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the ledger records identity and timing for the admin panel', () => {
  const dir = tmp();
  const info = inspectStorage(dir);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, LEDGER), 'utf8'));
  assert.equal(onDisk.boots, 1);
  assert.ok(onDisk.instance_id && onDisk.first_boot_at && onDisk.last_boot_at);
  assert.equal(onDisk.instance_id, info.instance_id);
  assert.ok(!Number.isNaN(Date.parse(onDisk.first_boot_at)));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt ledger is treated as absent rather than crashing the boot', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, LEDGER), 'not json at all');

  const info = inspectStorage(dir);
  assert.equal(info.boots, 1, 'it starts a fresh ledger');
  assert.ok(info.verdict);   // whatever it is, we got a verdict rather than a throw

  fs.rmSync(dir, { recursive: true, force: true });
});

test('mount detection resolves a directory to the filesystem it sits on', () => {
  const mount = mountFor('/');
  if (!mount.known) return;   // non-Linux: the ledger still covers us

  assert.equal(mount.point, '/');
  // A deep path with no mount of its own belongs to whatever is above it.
  assert.equal(mountFor('/definitely/not/a/mount/point').point, '/');
  assert.equal(mountFor('/proc/self').point, '/proc',
    'the nearest enclosing mount wins, not the shortest');
});

test('inspectStorage creates the directory rather than failing on a missing one', () => {
  const parent = tmp();
  const nested = path.join(parent, 'deep', 'data');

  const info = inspectStorage(nested);
  assert.ok(fs.existsSync(nested));
  assert.equal(info.boots, 1);

  fs.rmSync(parent, { recursive: true, force: true });
});
