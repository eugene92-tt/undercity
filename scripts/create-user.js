#!/usr/bin/env node
'use strict';
/**
 * Create or update a facilitator account.
 *
 *   npm run create-user -- you@example.com "Your Name" [password]
 *
 * With no password an unguessable one is generated and printed once. Run it
 * against the same DATA_DIR the server uses.
 */

const path = require('path');
const crypto = require('crypto');
const { Store } = require('../lib/db');
const { hashPassword } = require('../lib/auth');

const [email, name, supplied] = process.argv.slice(2);

if (!email || !name) {
  console.error('usage: npm run create-user -- <email> <name> [password]');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`✗ "${email}" does not look like an email address`);
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const store = new Store(path.join(DATA_DIR, 'undercity.db'));

// Readable but high-entropy: this gets copied out of a terminal by hand.
const password = supplied || crypto.randomBytes(12).toString('base64url');
const existing = store.facilitatorByEmail(email);

if (existing) {
  store.setPassword(existing.id, hashPassword(password));
  console.log(`✓ password reset for ${existing.email} (${existing.name})`);
} else {
  const user = store.createFacilitator({
    email, name, passwordHash: hashPassword(password), isAdmin: true,
  });
  console.log(`✓ created facilitator ${user.email} (${user.name})`);
}

if (!supplied) {
  console.log(`\n  password: ${password}`);
  console.log('  (shown once — store it in your password manager now)\n');
}
console.log(`  data dir: ${DATA_DIR}`);
store.close();
