'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

// Load .env; if no password is set, one is generated and saved to .env
require('dotenv').config({ path: ENV_FILE, quiet: true });
if (!process.env.FOUNDER_PASSWORD && !process.env.DASHBOARD_PASSWORD) {
  const pw = crypto.randomBytes(9).toString('base64url');
  const user = process.env.FOUNDER_USER || process.env.DASHBOARD_USER || 'admin';
  fs.appendFileSync(ENV_FILE, `${fs.existsSync(ENV_FILE) && fs.readFileSync(ENV_FILE, 'utf8').endsWith('\n') === false ? '\n' : ''}DASHBOARD_USER=${user}\nDASHBOARD_PASSWORD=${pw}\n`);
  process.env.DASHBOARD_USER = user;
  process.env.DASHBOARD_PASSWORD = pw;
  console.log('==============================================');
  console.log(' No password was set - one has been generated:');
  console.log(`   User     : ${user}`);
  console.log(`   Password : ${pw}`);
  console.log(' (saved in .env, where you can change it)');
  console.log('==============================================');
}

// The founder comes from FOUNDER_USER / FOUNDER_PASSWORD (the old DASHBOARD_* names still work).
const FOUNDER_USER = process.env.FOUNDER_USER || process.env.DASHBOARD_USER || 'admin';
const FOUNDER_PASSWORD = process.env.FOUNDER_PASSWORD || process.env.DASHBOARD_PASSWORD;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = process.env.MC_VERSION || 'auto';
const FORCE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';

const auth = require('./auth');
const perms = require('./permissions');
const { authorizeAction } = require('./access');
const { BotManager } = require('./botManager');
const { createFounderStore } = require('./founder');
const { createAudit } = require('./audit');
const { notifyAccountEvent, buildAccountPayload } = require('./accountNotify');
const { sendWebhook } = require('./deathNotify');
const discordLink = require('./discordLink');
const { runLifecycle } = require('./lifecycle');
const { createBotConfig } = require('./discord/config');
const { createBotData } = require('./discord/store');
const { createDiscordBot } = require('./discord/bot');

const seeded = auth.configure(path.join(ROOT, 'data', 'users.json'), FOUNDER_USER, FOUNDER_PASSWORD, { admins: auth.parseAdminAccounts(process.env.ADMIN_ACCOUNTS) });
if (seeded && seeded.skipped && seeded.skipped.length) console.log(`ADMIN_ACCOUNTS: skipped ${seeded.skipped.join(', ')} (user names need 3-32 characters, passwords at least 10)`);
const manager = new BotManager({ dataDir: path.join(ROOT, 'data'), version: VERSION });
const founder = createFounderStore(path.join(ROOT, 'data', 'founder.json'));
const audit = createAudit(path.join(ROOT, 'data', 'audit.json'));
const botConfig = createBotConfig(path.join(ROOT, 'data', 'bot.json'));
const botData = createBotData(path.join(ROOT, 'data', 'botdata.json'));
const botIdentity = (u) => (u ? { id: null, username: u.username || String(u.id || ''), role: 'bot' } : null);
const discordBot = createDiscordBot({
  founder, config: botConfig, data: botData,
  log: (m) => manager.log('system', `[Discord bot] ${m}`, 'info'),
  onEvent: (type, info) => {
    const who = info.by ? botIdentity(info.by) : null;
    if (type === 'purchase_completed') audit.add({ type, actor: { username: info.completedByName || 'team', role: 'bot' }, detail: `${info.username} bought ${info.planLabel} (${info.currency || ''}${info.total})` });
    else if (type === 'purchase_cancelled') audit.add({ type, detail: `${info.username}: ${info.planLabel}` });
    else if (type === 'purchase_rated') audit.add({ type, detail: `${info.username} rated ${info.rating}/5` });
    else audit.add({ type: 'bot_' + type, actor: who, detail: `${info.targetName || info.target || ''} – ${info.reason || ''}` });
  },
});

const isAdmin = perms.isStaff; // admin or founder
// Bots connected by a regular user belong to that user. Bots of admins/the founder (or unassigned ones) are shared.
const ownerOf = (w) => auth.getUsers().find((u) => Array.isArray(u.botNames) && u.botNames.includes(w.name)) || null;
manager.isShared = (w) => { const o = ownerOf(w); return !o || o.role !== 'user'; };
manager.on('account_added', ({ name, ownerId }) => { if (ownerId) auth.addOwnedBot(ownerId, name); });
manager.on('bot_removed', ({ name }) => auth.removeOwnedBots([name]));
const ownedNames = (user) => (Array.isArray(user.botNames) ? user.botNames.filter((n) => manager.workers.has(n)) : []);
const usedSlots = (user) => ownedNames(user).length + manager.pendingCountFor(user.id);

// ---- account events: written to the audit log and sent to the founder's webhook
const notify = (info) => notifyAccountEvent(founder, { at: Date.now(), ...info }, { onError: (e) => manager.log('system', `Account webhook failed: ${e.message}`, 'warn') });
const record = (type, actor, target, detail, extra = {}) => { audit.add({ type, actor, target, detail }); return notify({ type, actor, target, ...extra }); };

// Why an account may not use the dashboard right now (null = fine).
const lockReason = (u) => {
  if (!u) return null;
  if (auth.accountState(u) === 'grace') return 'expired';
  if (u.role !== 'founder' && founder.discordConfigured() && !u.discord) return 'discord';
  return null;
};
const removeUserCompletely = (target) => {
  for (const n of ownedNames(target)) { try { manager.removeBot(n); } catch { /* already gone */ } }
  return auth.deleteUser(target.id);
};

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });

const isSecure = (req) => FORCE_SECURE || req.secure || req.headers['x-forwarded-proto'] === 'https';
const actorOf = (req) => auth.sessionUser(auth.tokenFrom(req));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});

app.use(express.urlencoded({ extended: false, limit: '4kb' }));

// ---- Public: the sign-in page and its brand assets only
app.get('/login', (req, res) => {
  if (auth.isValid(auth.tokenFrom(req))) return res.redirect('/');
  res.sendFile(path.join(ROOT, 'public', 'login.html'));
});
app.get('/login.css', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.css')));
app.get('/login.js', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.js')));
const PUBLIC_ASSETS = /^\/(logo\.png|logo-small\.png|favicon\.png|favicon\.ico|apple-touch-icon\.png|fonts\/[A-Za-z0-9._-]+\.(woff2|txt))$/;
app.use((req, res, next) => (req.method === 'GET' && PUBLIC_ASSETS.test(req.path)) ? express.static(path.join(ROOT, 'public'), { maxAge: '7d' })(req, res, next) : next());

app.post('/login', (req, res) => {
  const r = auth.login(req.body.username, req.body.password, req.ip);
  if (r.error === 'rate') return res.redirect('/login?e=rate');
  if (r.error) return res.redirect('/login?e=1');
  res.set('Set-Cookie', auth.cookieHeader(r.token, isSecure(req)));
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  auth.logout(auth.tokenFrom(req));
  res.set('Set-Cookie', auth.cookieHeader('', isSecure(req), true));
  res.redirect('/login');
});

// ---- Signed-in, but allowed even while the account is locked (the gate page needs these)
const signedIn = (req, res, next) => { const u = actorOf(req); if (!u) return res.status(401).json({ error: 'Not signed in' }); req.actor = u; next(); };
app.get('/api/me', signedIn, (req, res) => {
  const u = req.actor;
  res.json({ user: auth.publicUser(u), lock: lockReason(u), discordConfigured: founder.discordConfigured() });
});

// ---- Discord account linking (OAuth2)
const oauthStates = new Map();
const gateError = (res, message) => res.redirect('/gate.html?msg=' + encodeURIComponent(String(message).slice(0, 160)));
app.get('/auth/discord', signedIn, (req, res) => {
  const u = req.actor;
  if (!founder.discordConfigured()) return gateError(res, 'Discord linking is not set up yet. Please ask the founder.');
  if (u.discord) return res.redirect('/');
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.exp < now) oauthStates.delete(k);
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, { userId: u.id, exp: now + 10 * 60 * 1000 });
  const d = founder.get().discord;
  res.redirect(discordLink.authorizeUrl({ clientId: d.clientId, redirectUri: founder.redirectUri(), state }));
});
app.get('/auth/discord/callback', signedIn, async (req, res) => {
  const u = req.actor;
  const state = String(req.query.state || '');
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  if (req.query.error) return gateError(res, 'Discord linking was cancelled.');
  if (!saved || saved.userId !== u.id || saved.exp < Date.now()) return gateError(res, 'The sign-in expired. Please try again.');
  try {
    const d = founder.get().discord;
    const link = await discordLink.completeLink({ clientId: d.clientId, clientSecret: d.clientSecret, redirectUri: founder.redirectUri(), code: String(req.query.code || '') });
    const { previous, user } = auth.setDiscord(u.id, link);
    if (previous) record('discord_changed', null, u, `${previous.username} → ${link.username}`, { from: previous.username, to: link.username });
    else audit.add({ type: 'discord_linked', target: u, detail: `Linked Discord account ${link.username}` });
    res.redirect('/');
  } catch (e) { gateError(res, e.message); }
});

// ---- JSON API (signed in, account not locked)
const guard = (allowed) => (req, res, next) => {
  const u = actorOf(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  if (lockReason(u)) return res.status(403).json({ error: 'Account locked' });
  if (!allowed(u)) return res.status(403).json({ error: 'Not allowed' });
  req.actor = u;
  next();
};
const anyUser = guard(() => true);
const staffOnly = guard(perms.isStaff);
const founderOnly = guard(perms.isFounder);
const json = express.json({ limit: '16kb' });
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message });
const targetOf = (req) => auth.getUsers().find((u) => u.id === req.params.id);
const manageable = (req, res) => {
  const t = targetOf(req);
  if (!t || !perms.canSee(req.actor, t)) { fail(res, new Error('User not found.'), 404); return null; }
  if (!perms.canManage(req.actor, t)) { fail(res, new Error(t.role === 'founder' ? 'The founder cannot be changed.' : 'Admins cannot change other admins. Only the founder can.'), 403); return null; }
  return t;
};

app.get('/api/admin/users', staffOnly, (req, res) => {
  const actor = req.actor;
  res.json({
    me: { id: actor.id, role: actor.role },
    users: auth.getUsers().filter((u) => perms.canSee(actor, u)).map((u) => ({
      ...auth.publicUser(u),
      botCount: usedSlots(u),
      bots: ownedNames(u).map((n) => ({ name: n, accountName: manager.workers.get(n).accountName || manager.accountNames[n] || '' })),
      can: { manage: perms.canManage(actor, u), remove: perms.canDelete(actor, u), viewAs: perms.canViewAs(actor, u) },
    })),
  });
});
app.post('/api/admin/users', json, staffOnly, (req, res) => {
  try {
    const { botNames, role, ...body } = req.body || {};
    const wanted = role === 'admin' ? 'admin' : 'user';
    if (!perms.canCreate(req.actor, wanted)) return fail(res, new Error('Only the founder can create admin accounts.'), 403);
    const created = auth.createUser({ ...body, role: wanted });
    record('created', req.actor, created, `${wanted} account created`, { expiresAt: created.expiresAt, at: Date.now() });
    res.status(201).json({ user: created });
  } catch (e) { fail(res, e); }
});
app.patch('/api/admin/users/:id', json, staffOnly, (req, res) => {
  const target = manageable(req, res);
  if (!target) return;
  try {
    const { username, botLimit, expiresAt } = req.body || {};
    let current = auth.publicUser(target);
    if (username !== undefined && String(username).trim() !== target.username) {
      const r = auth.renameUser(target.id, username);
      current = r.user;
      record('renamed', req.actor, current, `${r.before} → ${current.username}`, { from: r.before, to: current.username });
    }
    const patch = {};
    if (botLimit !== undefined) patch.botLimit = botLimit;
    if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    if (Object.keys(patch).length) {
      const before = auth.publicUser(target);
      current = auth.updateUser(target.id, patch);
      if (patch.botLimit !== undefined && current.botLimit !== before.botLimit) audit.add({ type: 'limit_changed', actor: req.actor, target: current, detail: `Account limit ${before.botLimit} → ${current.botLimit}` });
      if (patch.expiresAt !== undefined && current.expiresAt !== before.expiresAt) audit.add({ type: 'lifetime_changed', actor: req.actor, target: current, detail: current.expiresAt ? `Membership now ends ${new Date(current.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'Membership is now permanent' });
    }
    res.json({ user: current });
  } catch (e) { fail(res, e); }
});
app.post('/api/admin/users/:id/add-time', json, staffOnly, (req, res) => {
  const target = manageable(req, res);
  if (!target) return;
  try {
    const days = Number(req.body && req.body.days);
    const r = auth.addTime(target.id, days);
    audit.add({ type: 'time_added', actor: req.actor, target: r.user, detail: `Added ${days} day${days === 1 ? '' : 's'}${r.wasState !== 'active' ? ' (account was locked and is active again)' : ''}` });
    notify({ type: 'time_added', actor: req.actor, target: r.user, days, expiresAt: r.user.expiresAt });
    res.json({ user: r.user });
  } catch (e) { fail(res, e); }
});
app.delete('/api/admin/users/:id', staffOnly, (req, res) => {
  const t = targetOf(req);
  if (!t || !perms.canSee(req.actor, t)) return fail(res, new Error('User not found.'), 404);
  if (!perms.canDelete(req.actor, t)) return fail(res, new Error('Admins cannot delete other admins. Only the founder can.'), 403);
  try {
    const gone = removeUserCompletely(t);
    record('deleted', req.actor, gone, `${gone.role} account deleted`, {});
    res.status(204).end();
  } catch (e) { fail(res, e); }
});
app.get('/api/admin/audit', staffOnly, (req, res) => {
  res.json({ entries: audit.list({ limit: Math.min(500, Number(req.query.limit) || 200), viewer: req.actor.role }) });
});

app.get('/api/founder/settings', founderOnly, (req, res) => res.json(founder.publicView()));
app.put('/api/founder/settings', json, founderOnly, (req, res) => {
  try { founder.update(req.body || {}); res.json(founder.publicView()); } catch (e) { fail(res, e); }
});
app.post('/api/founder/webhook-test', founderOnly, async (req, res) => {
  const w = founder.get().accountWebhook;
  if (!w.url) return fail(res, new Error('Save a webhook URL first.'));
  try { await sendWebhook(w.url, buildAccountPayload({ type: 'test', actor: req.actor, target: req.actor, at: Date.now() }, w.url)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

// ---- Discord bot: only the founder manages it (token, start/stop, settings, panels)
const bigJson = express.json({ limit: '256kb' });
app.get('/api/bot', founderOnly, (req, res) => {
  const st = discordBot.status();
  res.json({ status: st, guild: st.status === 'online' ? discordBot.info() : null, guilds: st.status === 'online' ? discordBot.guilds() : [], config: botConfig.get(), panels: botData.panels(), isFounder: perms.isFounder(req.actor), hasToken: !!founder.get().botToken });
});
app.put('/api/bot/config', bigJson, founderOnly, async (req, res) => {
  try {
    const before = JSON.stringify(botConfig.get());
    const cfg = botConfig.replace(req.body || {});
    if (JSON.stringify(cfg) !== before) audit.add({ type: 'bot_config', actor: req.actor, detail: 'Bot settings saved' });
    await Promise.resolve(discordBot.refresh()).catch(() => {});
    res.json({ config: cfg });
  } catch (e) { fail(res, e); }
});
app.post('/api/bot/post', json, founderOnly, async (req, res) => {
  try {
    const kind = String((req.body || {}).kind || ''), id = (req.body || {}).id ? String(req.body.id) : undefined;
    const message = await discordBot.postPanel(kind, id);
    audit.add({ type: 'bot_panel', actor: req.actor, detail: `${kind}${id ? ' ' + id : ''} posted` });
    res.json({ ok: true, message });
  } catch (e) { fail(res, e); }
});
app.post('/api/founder/bot/start', founderOnly, async (req, res) => {
  try { await discordBot.start(); founder.update({ botAutostart: true }); audit.add({ type: 'bot_started', actor: req.actor, detail: 'Discord bot started' }); res.json({ status: discordBot.status() }); }
  catch (e) { fail(res, e); }
});
app.post('/api/founder/bot/stop', founderOnly, async (req, res) => {
  try { await discordBot.stop(); founder.update({ botAutostart: false }); audit.add({ type: 'bot_stopped', actor: req.actor, detail: 'Discord bot stopped' }); res.json({ status: discordBot.status() }); }
  catch (e) { fail(res, e); }
});

// Purchases: everyone sees their own completed purchases (matched by the linked Discord account), staff see all of them.
app.get('/api/purchases', anyUser, (req, res) => {
  const staff = perms.isStaff(req.actor);
  const all = botData.purchases();
  const mine = staff ? all : all.filter((p) => req.actor.discord && p.userId === req.actor.discord.id);
  const done = mine.filter((p) => p.status === 'completed').sort((a, b) => b.completedAt - a.completedAt);
  const byDiscord = new Map(auth.getUsers().filter((u) => u.discord).map((u) => [u.discord.id, u.username]));
  const rows = done.map((p) => ({ id: p.id, userId: p.userId, discordName: p.username, account: staff ? (byDiscord.get(p.userId) || null) : null, plan: p.planLabel, days: p.days, method: p.methodLabel, basePrice: p.basePrice, discountPercent: p.discountPercent, total: p.total, currency: p.currency || botConfig.get().shop.currency, completedAt: p.completedAt, rating: p.rating || 0, feedback: staff ? p.feedback || '' : p.feedback || '' }));
  const rated = rows.filter((r) => r.rating);
  const revenue = {};
  for (const r of rows) revenue[r.currency] = Math.round(((revenue[r.currency] || 0) + r.total) * 100) / 100;
  res.json({
    scope: staff ? 'all' : 'own', linked: staff || !!req.actor.discord, rows,
    summary: { count: rows.length, revenue, avgRating: rated.length ? Math.round(rated.reduce((a, r) => a + r.rating, 0) / rated.length * 10) / 10 : null, open: staff ? all.filter((p) => p.status === 'open').length : undefined, cancelled: staff ? all.filter((p) => p.status === 'cancelled').length : undefined },
  });
});

app.post('/api/password', json, anyUser, (req, res) => {
  try { auth.changePassword(req.actor.id, req.body.currentPassword, req.body.newPassword); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

// ---- Everything else requires sign-in
app.use((req, res, next) => {
  if (auth.isValid(auth.tokenFrom(req))) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
  res.status(401).send('Not signed in');
});
// Locked accounts (membership ended, or Discord not linked yet) only reach the gate page.
app.use((req, res, next) => {
  const lock = lockReason(actorOf(req));
  if (!lock) return req.path === '/gate.html' ? res.redirect('/') : next();
  if (req.path === '/gate.html' || req.path === '/gate.js') return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/gate.html');
  res.status(403).json({ error: lock === 'expired' ? 'Your membership has ended.' : 'Link your Discord account first.' });
});
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', extensions: ['html'] }));

// ---- Socket.io: check sign-in cookie and origin
const socketUserById = new Map();
const viewAsBySocket = new Map();
const userForSocket = (socket) => auth.sessionUser(auth.tokenFrom(socket.request));
io.use((socket, next) => {
  const req = socket.request;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return next(new Error('origin')); }
    catch { return next(new Error('origin')); }
  }
  const user = auth.sessionUser(auth.tokenFrom(req));
  if (!user) return next(new Error('unauthorized'));
  const lock = lockReason(user);
  if (lock) return next(new Error(lock === 'expired' ? 'expired' : 'discord_required'));
  socketUserById.set(socket.id, user.id);
  next();
});

const actions = {
  connect_bots: (p) => manager.connect(p || {}),
  connect_selected: (p, user) => manager.connectSelected(p || {}, { restrictInternal: !isAdmin(user) }),
  disconnect_selected: (p) => manager.disconnectSelected(p && p.names),
  disconnect_bots: () => manager.disconnect(),
  set_area: (p) => manager.setArea(p && p.p1, p && p.p2),
  set_settings: (p) => manager.setSettings(p || {}),
  set_version: (p) => manager.setVersion(p && p.version),
  start: () => manager.start(),
  stop: () => manager.stop(),
  chat: (p) => manager.sendChat(p && p.target, p && p.text),
  bot_profile: (p) => manager.setBotProfile(p && p.name, p && p.profile, p && p.options || {}),
  add_bot: (p, user) => {
    if (!isAdmin(user)) {
      const limit = user.botLimit || 0;
      const used = usedSlots(user);
      if (used >= limit) throw new Error(limit === 0 ? 'Your account is not allowed to connect Minecraft accounts. Ask an admin to raise your limit.' : `Account limit reached (${used}/${limit}). Ask an admin to raise your limit.`);
    }
    manager.addBot({ ownerId: user.id });
  },
  cancel_signin: (p, user) => manager.cancelSignIn(p && p.name, isAdmin(user) ? null : user.id),
  remove_bot: (p) => manager.removeBot(p && p.name),
  set_bot_sneak: (p) => manager.setBotSneak(p && p.name, p && p.sneak),
  set_bot_death: (p) => manager.setBotDeathSettings(p && p.name, p && p.death),
  set_bot_reconnect: (p) => manager.setBotReconnectSettings(p && p.name, p && p.reconnect),
  drop_items: (p) => manager.dropItems(p && p.name, p && p.items),
  drop_all: (p) => manager.dropAll(p && p.name, p || {}),
  test_death_webhook: (p) => manager.testDeathWebhook(p && p.name),
  clear_logs: () => { manager.logs.length = 0; for (const client of io.sockets.sockets.values()) client.emit('logs_cleared'); },
};

const owned = (name, user) => {
  if (isAdmin(user)) return true;
  const assigned = Array.isArray(user && user.botNames) ? new Set(user.botNames.map((n) => String(n).toLowerCase())) : new Set();
  const worker = manager.workers.get(name);
  const profileName = worker && worker.accountName || manager.accountNames[name];
  return assigned.has(String(name).toLowerCase()) || (!!profileName && assigned.has(String(profileName).toLowerCase()));
};
const snapshotFor = (user) => {
  const snap = manager.snapshot();
  const admin = isAdmin(user);
  snap.isAdmin = admin;
  snap.me = { id: user.id, username: user.username, role: user.role };
  snap.limits = { used: usedSlots(user), limit: user.botLimit || 0, unlimited: admin };
  if (admin) {
    const everyone = auth.getUsers();
    snap.bots = snap.bots.map((b) => {
      const o = everyone.find((u) => Array.isArray(u.botNames) && u.botNames.includes(b.name));
      return { ...b, owner: o ? (o.role === 'founder' && !perms.isFounder(user) ? 'Founder' : o.username) : null };
    });
    return snap;
  }
  snap.bots = snap.bots.filter((b) => owned(b.name, user));
  snap.names = snap.bots.map((b) => b.name);
  snap.pendingSignIns = (snap.pendingSignIns || []).filter((x) => x.ownerId === user.id);
  return { ...snap, connection: null, area: null, settings: {}, mining: false };
};

io.on('connection', (socket) => {
  const originalUser = () => userForSocket(socket);
  const currentUser = () => { const original = originalUser(); const target = viewAsBySocket.get(socket.id); return isAdmin(original) && target ? auth.getUsers().find((u) => u.id === target) || original : original; };
  socket.emit('init', { state: snapshotFor(currentUser()), logs: isAdmin(currentUser()) ? manager.logs.slice(-200) : [] });
  socket.on('action', async (type, payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = currentUser();
    const original = originalUser();
    if (!original || lockReason(original)) {
      reply({ ok: false, error: 'Session expired. Sign in again.' });
      socket.disconnect(true);
      return;
    }
    if (type === 'view_as') {
      if (!isAdmin(original)) return reply({ ok: false, error: 'Admin only' });
      const target = auth.getUsers().find((u) => u.id === String(payload && payload.userId || ''));
      if (!target || !perms.canViewAs(original, target)) return reply({ ok: false, error: 'Account not found' });
      viewAsBySocket.set(socket.id, target.id);
      socket.emit('view_as_changed', { active: true, username: target.username });
      socket.emit('state', snapshotFor(target));
      return reply({ ok: true });
    }
    if (type === 'exit_view_as') {
      if (!isAdmin(original)) return reply({ ok: false, error: 'Admin only' });
      viewAsBySocket.delete(socket.id);
      socket.emit('view_as_changed', { active: false });
      socket.emit('state', snapshotFor(original));
      return reply({ ok: true });
    }
    if (type === 'stop' && !isAdmin(user)) {
      try {
        const assigned = Array.isArray(user && user.botNames) ? new Set(user.botNames.map((n) => String(n).toLowerCase())) : new Set();
        const internalNames = [...manager.workers.values()]
          .filter((w) => assigned.has(String(w.name).toLowerCase()) || assigned.has(String(w.accountName || manager.accountNames[w.name] || '').toLowerCase()))
          .map((w) => w.name);
        manager.stopBots(internalNames);
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false, error: e.message });
      }
      return;
    }
    const fn = Object.prototype.hasOwnProperty.call(actions, type) ? actions[type] : null;
    if (!fn) return reply({ ok: false, error: 'Unknown action' });
    try {
      authorizeAction(user, type, payload, owned);
      await fn(payload, user);
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });
  socket.on('disconnect', () => { socketUserById.delete(socket.id); viewAsBySocket.delete(socket.id); });
});

// Sockets of accounts that are no longer allowed in (expired, deleted, signed out) are closed.
const liveUser = (socket) => {
  const original = userForSocket(socket);
  if (!original || lockReason(original)) { socket.disconnect(true); return null; }
  const viewing = isAdmin(original) && viewAsBySocket.has(socket.id) ? auth.getUsers().find((x) => x.id === viewAsBySocket.get(socket.id)) : null;
  return { original, effective: viewing || original };
};
manager.on('log', (entry) => {
  for (const socket of io.sockets.sockets.values()) {
    const who = liveUser(socket);
    if (who && (isAdmin(who.effective) || owned(entry.source, who.effective))) socket.emit('log', entry);
  }
});
const broadcastState = () => {
  for (const socket of io.sockets.sockets.values()) {
    const who = liveUser(socket);
    if (who) socket.emit('state', snapshotFor(who.effective));
  }
};
manager.on('change', broadcastState);
setInterval(() => { if (io.engine.clientsCount) broadcastState(); }, 1000).unref();

// ---- Background jobs (the broadcast timer above must stay the first one)
// Membership lifecycle: lock the moment time runs out, delete after 24 h without renewal.
setInterval(() => {
  try { const r = runLifecycle({ auth, manager, audit, notify }); if (r.locked.length || r.deleted.length) broadcastState(); }
  catch (e) { manager.log('system', `Lifecycle job failed: ${e.message}`, 'error'); }
}, 60 * 1000).unref();
// Discord: a user who revokes the authorization loses the link and has to link again.
let checkingDiscord = false;
setInterval(async () => {
  if (checkingDiscord || !founder.discordConfigured()) return;
  checkingDiscord = true;
  try {
    const d = founder.get().discord;
    for (const u of auth.getUsers().filter((x) => x.discord)) {
      const r = await discordLink.checkLink({ clientId: d.clientId, clientSecret: d.clientSecret }, u.discord);
      if (r.status === 'ok' && r.patch && Object.keys(r.patch).length) auth.updateDiscordTokens(u.id, r.patch);
      else if (r.status === 'revoked') {
        const old = auth.clearDiscord(u.id);
        if (old) record('discord_revoked', null, u, `Authorization for ${old.username} was revoked`, { from: old.username });
      }
    }
  } catch (e) { manager.log('system', `Discord check failed: ${e.message}`, 'warn'); }
  checkingDiscord = false;
}, 15 * 60 * 1000).unref();

process.on('unhandledRejection', (e) => manager.log('system', `Unhandled error: ${e && e.message ? e.message : e}`, 'error'));
process.on('uncaughtException', (e) => manager.log('system', `Error: ${e && e.message ? e.message : e}`, 'error'));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { manager.disconnect(true); } catch { /* ignore */ } try { discordBot.stop(); } catch { /* ignore */ } process.exit(0); });
}

server.listen(PORT, HOST, () => {
  console.log(`Dashboard running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (Minecraft ${VERSION})`);
  if (founder.get().botAutostart && founder.get().botToken) discordBot.start().catch((e) => manager.log('system', `[Discord bot] ${e.message}`, 'error'));
});
