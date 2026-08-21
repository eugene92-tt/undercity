'use strict';
/**
 * Facilitator authentication.
 *
 * Passwords are hashed with scrypt from Node's own crypto — no dependency, and
 * memory-hard, so a stolen database is not a stolen password list. Sessions are
 * opaque random tokens stored server-side in SQLite, so signing out actually
 * revokes access rather than merely asking the browser to forget.
 *
 * This gates the ADMIN surface only. Participants never authenticate: a team
 * joins by code and stays anonymous, exactly as the spec's non-goals require
 * (no participant accounts, no persistence between events).
 */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // one working day
const COOKIE = 'uc_admin';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(
      String(password), salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) }
    );
    // Constant-time: a timing difference here leaks how much of a guess was right.
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function makeAuth(store, { secure = false } = {}) {
  function login(res, facilitatorId) {
    const token = store.createAuthSession(facilitatorId, SESSION_TTL_MS);
    const attrs = [
      `${COOKIE}=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
    store.touchLogin(facilitatorId);
    return token;
  }

  function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    store.destroyAuthSession(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  function currentUser(req) {
    return store.facilitatorByAuthToken(parseCookies(req.headers.cookie)[COOKIE]);
  }

  /**
   * HTML routes bounce to the login page; API routes get a clean 401.
   *
   * originalUrl, not path: inside a mounted router req.path is relative to the
   * mount point ("/sessions"), so a path check would redirect API calls into
   * an HTML login page and the client would parse it as a failed request.
   */
  function requireAuth(req, res, next) {
    const user = currentUser(req);
    if (!user) {
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'unauthorised' });
      }
      return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    req.user = user;
    next();
  }

  return { login, logout, currentUser, requireAuth, COOKIE };
}

module.exports = { makeAuth, hashPassword, verifyPassword, parseCookies, SESSION_TTL_MS, COOKIE };
