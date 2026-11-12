'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_MS = 7 * 24 * 3600 * 1000;
const GRACE_MS = 24 * 3600 * 1000; // after the membership ends, an account is locked for 24 h and then deleted
const MAX_BOT_LIMIT = 100;
const MAX_DAYS = 3650;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

let usersFile = null;
let sessionsFile = null;
const sessions = new Map(); // key: sha256(token) – the file never contains a usable cookie value
const attempts = new Map();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function verifyPassword(password, entry) {
  if (!entry || !entry.salt || !entry.hash) return false;
  const got = crypto.scryptSync(String(password), entry.salt, 64);
  const want = Buffer.from(entry.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- storage

function loadSessions() {
  sessions.clear();
  if (!sessionsFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) || {};
    const now = Date.now();
    for (const [key, s] of Object.entries(raw)) if (s && s.userId && s.expiresAt > now) sessions.set(key, { userId: s.userId, expiresAt: s.expiresAt });
  } catch { /* first start or unreadable file: nobody is signed in */ }
}
let sessionTimer = null;
function saveSessions() {
  if (!sessionsFile || sessionTimer) return;
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    try {
      const tmp = sessionsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
      fs.renameSync(tmp, sessionsFile);
    } catch { /* sessions then simply do not survive a restart */ }
  }, 200);
  if (sessionTimer.unref) sessionTimer.unref();
}

function readData() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(usersFile, 'utf8')) || {}; } catch { /* first start */ }
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.seedsRemoved)) data.seedsRemoved = [];
  for (const u of data.users) normalizeSlots(u);
  return data;
}
/**
 * A regular user owns "slots" – one per Microsoft account they may connect. Each slot has its own end date
 * (null = permanent). The n-th bot of the user sits in the n-th slot. Older accounts only had a limit and one
 * membership date; that is turned into the same number of slots with that date.
 */
function normalizeSlots(u) {
  if (u.role !== 'user') return u;
  if (!Array.isArray(u.slots)) u.slots = Array.from({ length: Number(u.botLimit) || 0 }, () => ({ expiresAt: u.expiresAt || null }));
  u.slots = u.slots.map((s) => ({ expiresAt: s && s.expiresAt ? Number(s.expiresAt) : null }));
  u.botLimit = u.slots.length;
  return u;
}
/** The account ends when its last slot ends (permanent if any slot is permanent). Without slots the old date stays. */
function syncExpiry(u) {
  if (u.role !== 'user' || !u.slots.length) return;
  u.botLimit = u.slots.length;
  u.expiresAt = u.slots.some((s) => !s.expiresAt) ? null : Math.max(...u.slots.map((s) => s.expiresAt));
  if (accountState(u) === 'active') delete u.expiredHandled;
}
const slotDays = (days) => {
  if (days === null || days === undefined || days === '') return null;
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new Error(`Days must be a whole number between 1 and ${MAX_DAYS}.`);
  return Date.now() + n * 86400000;
};

function writeData(data) {
  const tmp = usersFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, usersFile);
}
function getUsers() { try { return readData().users; } catch { return []; } }
function saveUsers(users) { const data = readData(); data.users = users; writeData(data); }

/**
 * Sets up the accounts defined in the environment.
 *  - founderUser / founderPassword: the founder (an existing account with that name is promoted).
 *  - admins: [{ username, password }] from ADMIN_ACCOUNTS. Created if missing, unless the founder deleted them
 *    in the dashboard earlier (then they stay deleted).
 */
function configure(file, founderUser, founderPassword, opts = {}) {
  usersFile = file;
  sessionsFile = path.join(path.dirname(file), 'sessions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  loadSessions();
  const data = readData();
  const lower = (s) => String(s || '').toLowerCase();

  let founder = data.users.find((u) => u.role === 'founder');
  const named = data.users.find((u) => lower(u.username) === lower(founderUser));
  if (!founder) {
    if (named) { named.role = 'founder'; named.expiresAt = null; founder = named; }
    else {
      founder = { id: crypto.randomUUID(), username: founderUser, role: 'founder', ...hashPassword(founderPassword), createdAt: Date.now(), expiresAt: null, botLimit: 0, botNames: [] };
      data.users.push(founder);
    }
  }
  const skipped = [];
  for (const a of (Array.isArray(opts.admins) ? opts.admins : [])) {
    const username = String(a && a.username || '').trim();
    if (!USERNAME_RE.test(username) || String(a.password || '').length < 10) { skipped.push(username || '(empty)'); continue; }
    if (data.seedsRemoved.includes(lower(username))) continue;
    if (data.users.some((u) => lower(u.username) === lower(username))) continue;
    data.users.push({ id: crypto.randomUUID(), username, role: 'admin', ...hashPassword(a.password), createdAt: Date.now(), expiresAt: null, botLimit: 0, botNames: [] });
  }
  writeData(data);
  return { skipped };
}

/** ADMIN_ACCOUNTS="alice:password-one,bob:password-two" */
function parseAdminAccounts(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf(':');
    return i > 0 ? { username: pair.slice(0, i).trim(), password: pair.slice(i + 1) } : { username: pair, password: '' };
  });
}

// ---------------------------------------------------------------- lifecycle (membership time)

/**
 * active  – no expiry, or the membership is running
 * grace   – membership ended less than 24 h ago: locked, nothing can be used until an admin adds time
 * gone    – grace is over; the account is deleted by the lifecycle job
 */
function accountState(u, now = Date.now()) {
  if (!u || u.role === 'founder' || !u.expiresAt) return 'active';
  if (u.expiresAt > now) return 'active';
  return now < u.expiresAt + GRACE_MS ? 'grace' : 'gone';
}

function publicUser(u, now = Date.now()) {
  const state = accountState(u, now);
  return {
    id: u.id, username: u.username, role: u.role, createdAt: u.createdAt,
    expiresAt: u.expiresAt || null, state, graceEndsAt: state === 'grace' ? u.expiresAt + GRACE_MS : null,
    botLimit: u.botLimit || 0, botNames: Array.isArray(u.botNames) ? u.botNames : [],
    slots: u.role === 'user' ? normalizeSlots(u).slots.map((s, i) => ({ expiresAt: s.expiresAt, bot: (u.botNames || [])[i] || null })) : [],
    discord: u.discord ? { id: u.discord.id, username: u.discord.username, linkedAt: u.discord.linkedAt || null } : null,
  };
}

// How many Microsoft accounts a regular user may connect (0 = none). Staff are never limited.
function parseBotLimit(value) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < 0 || n > MAX_BOT_LIMIT) throw new Error(`Account limit must be a whole number between 0 and ${MAX_BOT_LIMIT}.`);
  return n;
}
function parseUsername(value) {
  const username = String(value || '').trim();
  if (!USERNAME_RE.test(username)) throw new Error('Username must be 3–32 letters, numbers, dots, dashes or underscores.');
  return username;
}
const nameTaken = (users, username, exceptId) => users.some((u) => u.id !== exceptId && u.username.toLowerCase() === username.toLowerCase());

function createUser({ username, password, role = 'user', expiresAt = null, botLimit = 0, botNames = [], slots = null }) {
  username = parseUsername(username);
  if (String(password || '').length < 10) throw new Error('Password must contain at least 10 characters.');
  const data = readData();
  if (nameTaken(data.users, username)) throw new Error('Username already exists.');
  const limit = parseBotLimit(botLimit);
  const assigned = Array.isArray(botNames) ? [...new Set(botNames.map(String).map((x) => x.trim()).filter(Boolean))] : [];
  const finalRole = role === 'admin' ? 'admin' : 'user';
  const user = { id: crypto.randomUUID(), username, role: finalRole, ...hashPassword(password), createdAt: Date.now(), expiresAt: expiresAt ? Number(expiresAt) : null, botLimit: limit, botNames: assigned };
  if (finalRole === 'user') {
    user.slots = Array.isArray(slots) ? slots.map((s) => ({ expiresAt: s && s.expiresAt ? Number(s.expiresAt) : null })) : Array.from({ length: limit }, () => ({ expiresAt: user.expiresAt }));
    normalizeSlots(user); syncExpiry(user);
  }
  data.users.push(user);
  data.seedsRemoved = data.seedsRemoved.filter((n) => n !== username.toLowerCase());
  writeData(data);
  return publicUser(user);
}

function updateUser(id, patch = {}) {
  const users = getUsers(), u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (patch.expiresAt !== undefined) {
    u.expiresAt = patch.expiresAt === null || patch.expiresAt === '' ? null : Number(patch.expiresAt);
    if (u.role === 'user') for (const s of u.slots) s.expiresAt = u.expiresAt;
    if (accountState(u) === 'active') delete u.expiredHandled;
  }
  if (patch.botLimit !== undefined) {
    const limit = parseBotLimit(patch.botLimit);
    if (u.role === 'user') {
      const last = u.slots.length ? u.slots[u.slots.length - 1].expiresAt : u.expiresAt || null;
      u.slots = u.slots.slice(0, limit);
      while (u.slots.length < limit) u.slots.push({ expiresAt: last });
      syncExpiry(u);
    }
    u.botLimit = limit;
  }
  if (patch.botNames !== undefined) u.botNames = Array.isArray(patch.botNames) ? [...new Set(patch.botNames.map(String).map((x) => x.trim()).filter(Boolean))] : [];
  saveUsers(users);
  return publicUser(u);
}

function renameUser(id, newName) {
  const username = parseUsername(newName);
  const users = getUsers(), u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (nameTaken(users, username, id)) throw new Error('Username already exists.');
  const before = u.username;
  u.username = username;
  saveUsers(users);
  return { before, user: publicUser(u) };
}

/** Adds days to the membership. An expired account restarts from now; permanent accounts have nothing to extend. */
function addTime(id, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new Error(`Days must be a whole number between 1 and ${MAX_DAYS}.`);
  const users = getUsers(), u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (!u.expiresAt) throw new Error('This account is permanent – there is no time to add.');
  const wasState = accountState(u);
  const base = Math.max(u.expiresAt, Date.now());
  u.expiresAt = base + n * 86400000;
  if (u.role === 'user') for (const s of u.slots) if (s.expiresAt) s.expiresAt = Math.max(s.expiresAt, Date.now()) + n * 86400000;
  delete u.expiredHandled;
  saveUsers(users);
  return { user: publicUser(u), wasState };
}

// ---------------------------------------------------------------- slots

const slotOf = (users, id, index) => {
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (u.role !== 'user') throw new Error('Only regular accounts have Microsoft account slots.');
  const i = Number(index);
  return { u, i, slot: Number.isInteger(i) ? u.slots[i] : undefined };
};
/** Adds one slot that ends in `days` days (empty = permanent). Also wakes up a locked account. */
function addSlot(id, days) {
  const users = getUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (u.role !== 'user') throw new Error('Only regular accounts have Microsoft account slots.');
  if (u.slots.length >= MAX_BOT_LIMIT) throw new Error(`An account can have at most ${MAX_BOT_LIMIT} slots.`);
  const wasState = accountState(u);
  u.slots.push({ expiresAt: slotDays(days) });
  syncExpiry(u);
  saveUsers(users);
  return { user: publicUser(u), wasState };
}
/** Sets the end of one slot to `days` days from now (empty = permanent). */
function setSlotExpiry(id, index, days) {
  const users = getUsers();
  const { u, slot } = slotOf(users, id, index);
  if (!slot) throw new Error('Slot not found.');
  slot.expiresAt = slotDays(days);
  syncExpiry(u);
  saveUsers(users);
  return publicUser(u);
}
/** Adds days to the end of one slot. An ended slot cannot exist (it is removed), a permanent one has nothing to add. */
function addSlotTime(id, index, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new Error(`Days must be a whole number between 1 and ${MAX_DAYS}.`);
  const users = getUsers();
  const { u, slot } = slotOf(users, id, index);
  if (!slot) throw new Error('Slot not found.');
  if (!slot.expiresAt) throw new Error('This slot is permanent – there is no time to add.');
  slot.expiresAt = Math.max(slot.expiresAt, Date.now()) + n * 86400000;
  syncExpiry(u);
  saveUsers(users);
  return publicUser(u);
}
/** Removes a slot. The Microsoft account that sat in it is returned so the caller can remove the bot. */
function removeSlot(id, index) {
  const users = getUsers();
  const { u, i, slot } = slotOf(users, id, index);
  if (!slot) throw new Error('Slot not found.');
  const bot = (u.botNames || [])[i] || null;
  u.slots.splice(i, 1);
  if (bot) u.botNames.splice(i, 1);
  const last = Math.max(0, ...u.slots.map((s) => s.expiresAt || 0));
  if (u.slots.length) syncExpiry(u); else { u.expiresAt = u.expiresAt || last || null; u.botLimit = 0; }
  saveUsers(users);
  return { user: publicUser(u), bot };
}
/**
 * Removes every slot whose time is over together with its Microsoft account; the slots behind it move up.
 * The last remaining slot is not removed when it ends: the account then enters its 24 h grace period.
 */
function expireSlots(now = Date.now()) {
  const users = getUsers();
  const out = [];
  for (const u of users) {
    if (u.role !== 'user' || !u.slots.length) continue;
    const ended = u.slots.map((s, i) => (s.expiresAt && s.expiresAt <= now ? i : -1)).filter((i) => i >= 0);
    // When every slot has ended the whole account is in its 24 h grace period instead (nothing is removed yet; adding time brings it all back).
    if (!ended.length || ended.length === u.slots.length) continue;
    const lastEnd = Math.max(...u.slots.map((s) => s.expiresAt || 0));
    const bots = [];
    for (const i of ended.slice().reverse()) {
      const bot = (u.botNames || [])[i];
      if (bot) { bots.push(bot); u.botNames.splice(i, 1); }
      u.slots.splice(i, 1);
    }
    if (u.slots.length) syncExpiry(u); else { u.expiresAt = lastEnd; u.botLimit = 0; }
    out.push({ user: publicUser(u), count: ended.length, bots, wasLast: !u.slots.length });
  }
  if (out.length) saveUsers(users);
  return out;
}

// ---------------------------------------------------------------- bot ownership

// Bots belong to the user who connected their Microsoft account. `botNames` stores the internal bot names.
function addOwnedBot(userId, name) {
  const users = getUsers(), u = users.find((x) => x.id === userId);
  if (!u) return false;
  const bots = Array.isArray(u.botNames) ? u.botNames : [];
  if (!bots.some((n) => String(n).toLowerCase() === String(name).toLowerCase())) bots.push(String(name));
  u.botNames = bots;
  saveUsers(users);
  return true;
}
function removeOwnedBots(names) {
  const drop = new Set((Array.isArray(names) ? names : [names]).filter(Boolean).map((n) => String(n).toLowerCase()));
  if (!drop.size) return;
  const users = getUsers();
  let changed = false;
  for (const u of users) {
    const before = Array.isArray(u.botNames) ? u.botNames : [];
    const after = before.filter((n) => !drop.has(String(n).toLowerCase()));
    if (after.length !== before.length) { u.botNames = after; changed = true; }
  }
  if (changed) saveUsers(users);
}

// ---------------------------------------------------------------- Discord link

const findByDiscordId = (id) => getUsers().find((u) => u.discord && u.discord.id === String(id)) || null;

/**
 * Stores a verified Discord identity for a user. One Discord account can belong to one dashboard account only.
 * Returns { previous } where previous is the Discord id this account had before a deauthorization (if any and different).
 */
function setDiscord(userId, link) {
  const data = readData();
  const u = data.users.find((x) => x.id === userId);
  if (!u) throw new Error('User not found.');
  const other = data.users.find((x) => x.id !== userId && x.discord && x.discord.id === String(link.id));
  if (other) throw new Error('This Discord account is already linked to another dashboard account.');
  if (u.discord && u.discord.id !== String(link.id)) throw new Error('A Discord account is already linked. It can only be changed after revoking the authorization in Discord.');
  const previous = !u.discord && u.lastDiscord && u.lastDiscord.id !== String(link.id) ? u.lastDiscord : null;
  u.discord = { ...link, id: String(link.id), linkedAt: (u.discord && u.discord.linkedAt) || Date.now() };
  delete u.lastDiscord;
  writeData(data);
  return { previous, user: publicUser(u) };
}
function updateDiscordTokens(userId, patch) {
  const data = readData();
  const u = data.users.find((x) => x.id === userId);
  if (!u || !u.discord) return;
  Object.assign(u.discord, patch);
  writeData(data);
}
/** Called when the user revoked the app in Discord. Remembers who it was, so a change of account can be logged. */
function clearDiscord(userId) {
  const data = readData();
  const u = data.users.find((x) => x.id === userId);
  if (!u || !u.discord) return null;
  const old = { id: u.discord.id, username: u.discord.username };
  u.lastDiscord = old;
  delete u.discord;
  writeData(data);
  return old;
}

// ---------------------------------------------------------------- deletion

function deleteUser(id) {
  const users = getUsers(), u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found.');
  if (u.role === 'founder') throw new Error('The founder account cannot be deleted.');
  const data = readData();
  data.users = users.filter((x) => x.id !== id);
  // An admin that comes from ADMIN_ACCOUNTS must not reappear at the next start.
  if (u.role === 'admin' && !data.seedsRemoved.includes(u.username.toLowerCase())) data.seedsRemoved.push(u.username.toLowerCase());
  writeData(data);
  for (const [t, s] of sessions) if (s.userId === id) sessions.delete(t);
  saveSessions();
  return publicUser(u);
}

function markExpiredHandled(id) {
  const users = getUsers(), u = users.find((x) => x.id === id);
  if (!u) return;
  u.expiredHandled = true;
  saveUsers(users);
}

function changePassword(userId, currentPassword, newPassword) {
  if (String(newPassword || '').length < 10) throw new Error('New password must contain at least 10 characters.');
  const users = getUsers(), u = users.find((x) => x.id === userId);
  if (!u || !verifyPassword(currentPassword, u)) throw new Error('Current password is incorrect.');
  Object.assign(u, hashPassword(newPassword));
  saveUsers(users);
}

// ---------------------------------------------------------------- sessions

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}
function tokenFrom(req) { return parseCookies(req.headers.cookie).session; }

// An account in its 24 h grace period still has a session (it needs to see the "expired" page) but nothing else.
function sessionUser(token) {
  if (!token) return null;
  const key = tokenKey(token);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(key); saveSessions(); return null; }
  const u = getUsers().find((x) => x.id === s.userId);
  if (!u || accountState(u) === 'gone') { sessions.delete(key); saveSessions(); return null; }
  return u;
}
function isValid(token) { return !!sessionUser(token); }

function tooManyAttempts(ip) { const e = attempts.get(ip); return !!e && e.resetAt > Date.now() && e.count >= 8; }
function noteFailure(ip) { const now = Date.now(), e = attempts.get(ip); if (!e || e.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + 600000 }); else e.count++; }

function login(username, password, ip) {
  if (tooManyAttempts(ip)) return { error: 'rate' };
  const u = getUsers().find((x) => x.username.toLowerCase() === String(username || '').toLowerCase());
  if (!verifyPassword(password, u)) { noteFailure(ip); return { error: 'invalid' }; }
  if (accountState(u) === 'gone') { noteFailure(ip); return { error: 'expired' }; }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(tokenKey(token), { userId: u.id, expiresAt: Date.now() + SESSION_MS });
  saveSessions();
  return { token, user: publicUser(u) };
}
function logout(token) { sessions.delete(tokenKey(token)); saveSessions(); }
function cookieHeader(token, secure, clear = false) {
  const p = [`session=${clear ? '' : token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${clear ? 0 : Math.floor(SESSION_MS / 1000)}`];
  if (secure) p.push('Secure');
  return p.join('; ');
}
setInterval(() => {
  const now = Date.now();
  let dropped = false;
  for (const [t, s] of sessions) if (s.expiresAt < now) { sessions.delete(t); dropped = true; }
  if (dropped) saveSessions();
  for (const [ip, e] of attempts) if (e.resetAt < now) attempts.delete(ip);
}, 600000).unref();

module.exports = {
  GRACE_MS, MAX_BOT_LIMIT, safeEqual,
  configure, parseAdminAccounts, getUsers, publicUser, accountState,
  createUser, updateUser, renameUser, addTime, addSlot, setSlotExpiry, addSlotTime, removeSlot, expireSlots, deleteUser, markExpiredHandled,
  addOwnedBot, removeOwnedBots,
  findByDiscordId, setDiscord, updateDiscordTokens, clearDiscord,
  changePassword, sessionUser, login, logout, isValid, tokenFrom, parseCookies, cookieHeader,
};
