'use strict';
const crypto = require('crypto');

const SESSION_MS = 7 * 24 * 3600 * 1000;
const sessions = new Map();           // token -> expiresAt
const attempts = new Map();           // ip -> { count, resetAt }

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFrom(req) {
  return parseCookies(req.headers.cookie).session;
}

function isValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function tooManyAttempts(ip) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || e.resetAt < now) return false;
  return e.count >= 8;
}

function noteFailure(ip) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || e.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
  else e.count++;
}

function login(user, password, ip, expectedUser, expectedPassword) {
  if (tooManyAttempts(ip)) return { error: 'rate' };
  const ok = safeEqual(user || '', expectedUser) & safeEqual(password || '', expectedPassword);
  if (!ok) { noteFailure(ip); return { error: 'invalid' }; }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  return { token };
}

function logout(token) { sessions.delete(token); }

function cookieHeader(token, secure, clear = false) {
  const parts = [`session=${clear ? '' : token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/',
    `Max-Age=${clear ? 0 : Math.floor(SESSION_MS / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, e] of attempts) if (e.resetAt < now) attempts.delete(ip);
}, 10 * 60 * 1000).unref();

module.exports = { login, logout, isValid, tokenFrom, parseCookies, cookieHeader };
