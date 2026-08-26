'use strict';
/**
 * Is DATA_DIR actually going to survive a restart?
 *
 * Everything durable lives there: facilitator accounts, sessions, teams, and
 * every runlog.jsonl. On a container host that directory is only persistent if
 * a disk is mounted over it. Without one the app runs perfectly, writes
 * happily, and loses the lot the next time the container is replaced — the
 * failure gives no signal at all until someone notices their account is gone.
 *
 * Two independent checks, because neither alone is enough:
 *
 *   1. Mount detection. A real disk appears in /proc/self/mounts as a mount
 *      point at or above DATA_DIR. Cheap, immediate, Linux-only.
 *   2. A boot ledger written INTO DATA_DIR. If it comes back on a later boot,
 *      the directory demonstrably survived — that is proof rather than
 *      inference, and it outranks the heuristic.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER = 'persistence.json';

/** Mount points visible to this process, deepest first. */
function mountPoints() {
  try {
    return fs.readFileSync('/proc/self/mounts', 'utf8')
      .trim().split('\n')
      .map((line) => line.split(' ')[1])
      .filter(Boolean)
      .map((p) => p.replace(/\\040/g, ' '))
      .sort((a, b) => b.length - a.length);
  } catch {
    return null;   // not Linux, or /proc not mounted
  }
}

/**
 * The mount that DATA_DIR sits on. `/` means it is part of the container's
 * own filesystem and will vanish with the container.
 */
function mountFor(dir) {
  const points = mountPoints();
  if (!points) return { known: false, point: null };

  const resolved = path.resolve(dir);
  for (const point of points) {
    if (resolved === point || resolved.startsWith(point === '/' ? '/' : `${point}/`)) {
      return { known: true, point };
    }
  }
  return { known: true, point: '/' };
}

function readLedger(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data.boots !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Inspect the directory and record this boot. Call once at startup.
 * Never throws: a storage check must not be the thing that stops a run.
 */
function inspectStorage(dataDir) {
  const dir = path.resolve(dataDir);
  const file = path.join(dir, LEDGER);

  let previous = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    previous = readLedger(file);
  } catch { /* reported as unwritable below */ }

  const now = new Date().toISOString();
  const ledger = previous
    ? { ...previous, boots: previous.boots + 1, last_boot_at: now }
    : {
      instance_id: crypto.randomBytes(8).toString('hex'),
      first_boot_at: now,
      last_boot_at: now,
      boots: 1,
    };

  let writable = true;
  try {
    fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    writable = false;
  }

  const mount = mountFor(dir);
  const onOwnMount = mount.known && mount.point !== '/';
  // Surviving a restart is proof; a mount point is only a strong hint.
  const provenPersistent = !!previous && ledger.boots > 1;

  let verdict;
  let detail;
  if (!writable) {
    verdict = 'unwritable';
    detail = `${dir} cannot be written to. Accounts and run logs will fail to save.`;
  } else if (provenPersistent) {
    verdict = 'persistent';
    detail = `Data has survived ${ledger.boots - 1} restart${ledger.boots > 2 ? 's' : ''} `
      + `since ${ledger.first_boot_at.slice(0, 10)}.`;
  } else if (onOwnMount) {
    verdict = 'persistent';
    detail = `${dir} is a mounted disk (${mount.point}).`;
  } else if (!mount.known) {
    verdict = 'unverified';
    detail = `Could not determine whether ${dir} is on a persistent disk.`;
  } else {
    verdict = 'ephemeral';
    detail = `${dir} is part of the container filesystem, not a mounted disk. `
      + 'Accounts, sessions and run logs will be lost when the instance restarts.';
  }

  return {
    dir,
    verdict,
    detail,
    mount_point: mount.point,
    on_own_mount: onOwnMount,
    boots: ledger.boots,
    first_boot_at: ledger.first_boot_at,
    last_boot_at: ledger.last_boot_at,
    instance_id: ledger.instance_id,
    fresh: !previous,
  };
}

/** The boot banner. Loud on purpose — silent data loss is the worst outcome. */
function reportStorage(info) {
  if (info.verdict === 'persistent') {
    console.log(`✓ storage OK — ${info.detail}`);
    return;
  }
  if (info.verdict === 'unverified') {
    console.log(`  storage: ${info.detail}`);
    return;
  }

  const rule = '─'.repeat(72);
  console.warn(`\n${rule}`);
  console.warn(info.verdict === 'unwritable'
    ? '  ✗ DATA DIRECTORY IS NOT WRITABLE'
    : '  ⚠  STORAGE IS EPHEMERAL — DATA WILL BE LOST ON RESTART');
  console.warn(rule);
  console.warn(`  ${info.detail}`);
  if (info.verdict === 'ephemeral') {
    console.warn('');
    console.warn('  On Render: attach a persistent disk to this service and mount it at');
    console.warn(`  ${info.dir}. A disk requires a paid instance type. Free instances`);
    console.warn('  cannot have one, and they also spin down when idle.');
    console.warn('');
    console.warn('  render.yaml already declares the disk — but it only applies to a');
    console.warn('  service created from the Blueprint. A service created by hand in the');
    console.warn('  dashboard must have the disk added there.');
  }
  console.warn(`${rule}\n`);
}

module.exports = { inspectStorage, reportStorage, mountFor, LEDGER };
