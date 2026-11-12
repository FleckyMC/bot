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
    else if (type === 'purchase_claimed') audit.add({ type, actor: { username: info.claimedByName || 'seller', role: 'bot' }, detail: `${info.username}'s order (${info.planLabel})` });
    else if (type === 'purchase_unclaimed') audit.add({ type, actor: botIdentity(info.by), detail: `${info.username}'s order (${info.planLabel})` });
    else if (type === 'purchase_rated') audit.add({ type, detail: `${info.username} rated ${info.rating}/5` });
    else audit.add({ type: 'bot_' + type, actor: who, detail: `${info.targetName || info.target || ''} – ${info.reason || ''}` });
  },
});

const isAdmin = perms.isStaff; // admin or founder
// Bots connected by a regular user belong to that user. Bots of admins/the founder (or unassigned ones) are shared.
const ownerOf = (w) => auth.getUsers().find((u) => Array.isArray(u.botNames) && u.botNames.includes(w.name)) || null;
manager.isShared = () => true; // mining only ever touches the bots of the person who starts it (see actions.start)
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
  if (auth.isValid(auth.tokenFrom(req))) return res.redirect('/panel');
  res.sendFile(path.join(ROOT, 'public', 'login.html'));
});
app.get('/login.css', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.css')));
app.get('/login.js', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.js')));
const PUBLIC_ASSETS = /^\/(logo\.png|logo-small\.png|favicon\.png|favicon\.ico|apple-touch-icon\.png|fonts\/[A-Za-z0-9._-]+\.(woff2|txt))$/;
app.use((req, res, next) => (req.method === 'GET' && PUBLIC_ASSETS.test(req.path)) ? express.static(path.join(ROOT, 'public'), { maxAge: '7d' })(req, res, next) : next());

// ---- Public website (advertising page). Needs neither a login nor a linked Discord account.
const DISCORD_INVITE = 'https://discord.gg/97XjSp7JcU';
const SITE_FILES = { '/': 'site.html', '/site.css': 'site.css', '/site.js': 'site.js' };
app.get(['/', '/site.css', '/site.js'], (req, res) => res.sendFile(path.join(ROOT, 'public', SITE_FILES[req.path])));
app.get(/^\/site\/[A-Za-z0-9._-]+\.(png|jpg|webp|svg)$/, (req, res) => res.sendFile(path.join(ROOT, 'public', req.path), { maxAge: '1d' }, (e) => { if (e && !res.headersSent) res.status(404).end(); }));
app.get('/discord', (req, res) => res.redirect(302, DISCORD_INVITE));
// Price shown on the website: the week price of the Discord shop (so both always agree).
const sitePrice = () => {
  try {
    const s = botConfig.get().shop;
    const week = (s.plans || []).find((p) => p.days === 7) || (s.plans || [])[0];
    const perWeek = week ? Math.round((week.price / week.days) * 7 * 100) / 100 : 1;
    return { perWeek: perWeek > 0 ? perWeek : 1, currency: s.currency || '€' };
  } catch { return { perWeek: 1, currency: '€' }; }
};
app.get('/api/site', (req, res) => {
  const u = actorOf(req);
  res.json({ price: sitePrice(), discord: '/discord', signedIn: !!u, name: u ? u.username : null });
});

app.post('/login', (req, res) => {
  const r = auth.login(req.body.username, req.body.password, req.ip);
  if (r.error === 'rate') return res.redirect('/login?e=rate');
  if (r.error) return res.redirect('/login?e=1');
  res.set('Set-Cookie', auth.cookieHeader(r.token, isSecure(req)));
  res.redirect('/panel');
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
  if (u.discord) return res.redirect('/panel');
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
    res.redirect('/panel');
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
      slots: (auth.publicUser(u).slots || []).map((s) => ({ expiresAt: s.expiresAt, used: !!s.bot })),
      can: { manage: perms.canManage(actor, u), remove: perms.canDelete(actor, u) },
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
// Every Microsoft account slot has its own end date. Slot n holds the n-th Microsoft account of the user.
const slotRoute = (fn) => (req, res) => {
  const target = manageable(req, res);
  if (!target) return;
  try { fn(req, res, target); } catch (e) { fail(res, e); }
};
app.post('/api/admin/users/:id/slots', json, staffOnly, slotRoute((req, res, target) => {
  const r = auth.addSlot(target.id, req.body && req.body.days);
  audit.add({ type: 'slot_added', actor: req.actor, target: r.user, detail: `Slot ${r.user.slots.length} added (${r.user.slots[r.user.slots.length - 1].expiresAt ? 'ends ' + new Date(r.user.slots[r.user.slots.length - 1].expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'permanent'})${r.wasState !== 'active' ? ' - account is active again' : ''}` });
  res.json({ user: r.user });
}));
app.patch('/api/admin/users/:id/slots/:index', json, staffOnly, slotRoute((req, res, target) => {
  const user = auth.setSlotExpiry(target.id, req.params.index, req.body && req.body.days);
  const s = user.slots[Number(req.params.index)];
  audit.add({ type: 'slot_changed', actor: req.actor, target: user, detail: `Slot ${Number(req.params.index) + 1} ${s.expiresAt ? 'now ends ' + new Date(s.expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'is now permanent'}` });
  res.json({ user });
}));
app.post('/api/admin/users/:id/slots/:index/add-time', json, staffOnly, slotRoute((req, res, target) => {
  const days = Number(req.body && req.body.days);
  const user = auth.addSlotTime(target.id, req.params.index, days);
  audit.add({ type: 'slot_time_added', actor: req.actor, target: user, detail: `Added ${days} day${days === 1 ? '' : 's'} to slot ${Number(req.params.index) + 1}` });
  res.json({ user });
}));
app.delete('/api/admin/users/:id/slots/:index', staffOnly, slotRoute((req, res, target) => {
  const r = auth.removeSlot(target.id, req.params.index);
  if (r.bot) { try { manager.removeBot(r.bot); } catch { /* already gone */ } }
  audit.add({ type: 'slot_removed', actor: req.actor, target: r.user, detail: `Slot ${Number(req.params.index) + 1} removed${r.bot ? ' together with its Microsoft account' : ''}` });
  res.json({ user: r.user });
}));
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

// Purchases: everyone sees the completed purchases they made or sold (matched by their linked Discord account), staff see all of them.
const purchaseRow = (p, staff, byDiscord) => ({
  id: p.id, userId: p.userId, discordName: p.username, account: staff ? (byDiscord.get(p.userId) || null) : null,
  sellerId: p.sellerId || null, sellerName: p.sellerName || null, sellerAccount: staff && p.sellerId ? (byDiscord.get(p.sellerId) || null) : null,
  plan: p.planLabel, days: p.days, method: p.methodLabel, basePrice: p.basePrice, discountPercent: p.discountPercent, total: p.total,
  currency: p.currency || botConfig.get().shop.currency, completedAt: p.completedAt, rating: p.rating || 0, feedback: p.feedback || '',
});
app.get('/api/purchases', anyUser, (req, res) => {
  const staff = perms.isStaff(req.actor);
  const all = botData.purchases();
  const me = req.actor.discord && req.actor.discord.id;
  const mine = staff ? all : all.filter((p) => me && (p.userId === me || p.sellerId === me));
  const done = mine.filter((p) => p.status === 'completed').sort((a, b) => b.completedAt - a.completedAt);
  const byDiscord = new Map(auth.getUsers().filter((u) => u.discord).map((u) => [u.discord.id, u.username]));
  const rows = done.map((p) => purchaseRow(p, staff, byDiscord));
  const rated = rows.filter((r) => r.rating);
  const revenue = {};
  for (const r of rows) revenue[r.currency] = Math.round(((revenue[r.currency] || 0) + r.total) * 100) / 100;
  const sellers = new Map();
  for (const r of rows) {
    const key = r.sellerId || 'none';
    const s = sellers.get(key) || { id: r.sellerId, name: r.sellerName || 'Unknown', count: 0, revenue: {}, ratings: [] };
    s.count++; s.revenue[r.currency] = Math.round(((s.revenue[r.currency] || 0) + r.total) * 100) / 100; if (r.rating) s.ratings.push(r.rating);
    sellers.set(key, s);
  }
  res.json({
    scope: staff ? 'all' : 'own', linked: staff || !!req.actor.discord, canDelete: perms.isFounder(req.actor), rows,
    sellers: [...sellers.values()].map((s) => ({ id: s.id, name: s.name, count: s.count, revenue: s.revenue, avgRating: s.ratings.length ? Math.round(s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length * 10) / 10 : null })).sort((a, b) => b.count - a.count),
    summary: { count: rows.length, revenue, avgRating: rated.length ? Math.round(rated.reduce((a, r) => a + r.rating, 0) / rated.length * 10) / 10 : null, open: staff ? all.filter((p) => p.status === 'open').length : undefined, cancelled: staff ? all.filter((p) => p.status === 'cancelled').length : undefined },
  });
});
// Only the founder can remove entries from the history or wipe the logs.
app.delete('/api/purchases/:id', founderOnly, (req, res) => {
  try {
    if (!botData.deletePurchase(String(req.params.id))) return fail(res, new Error('Purchase not found.'), 404);
    audit.add({ type: 'purchase_deleted', actor: req.actor, detail: `Purchase ${String(req.params.id).slice(0, 12)} removed from the history` });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
app.post('/api/purchases/clear', founderOnly, (req, res) => {
  const n = botData.clearPurchases();
  audit.add({ type: 'purchase_deleted', actor: req.actor, detail: `Purchase history cleared (${n} entr${n === 1 ? 'y' : 'ies'})` });
  res.json({ ok: true, removed: n });
});
app.post('/api/admin/audit/clear', founderOnly, (req, res) => {
  const n = audit.clear();
  audit.add({ type: 'audit_cleared', actor: req.actor, detail: `Activity log cleared (${n} entr${n === 1 ? 'y' : 'ies'} removed)` });
  res.json({ ok: true, removed: n });
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
  if (!lock) return req.path === '/gate.html' ? res.redirect('/panel') : next();
  if (req.path === '/gate.html' || req.path === '/gate.js') return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/gate.html');
  res.status(403).json({ error: lock === 'expired' ? 'Your membership has ended.' : 'Link your Discord account first.' });
});
app.get('/panel', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.use(express.static(path.join(ROOT, 'public'), { index: false, extensions: ['html'] }));

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
  connect_bots: () => { throw new Error('Connect your accounts from the Bots tab.'); },
  connect_selected: (p, user) => manager.connectSelected(p || {}, { restrictInternal: !isAdmin(user) }),
  disconnect_selected: (p) => manager.disconnectSelected(p && p.names),
  disconnect_bots: (p, user) => manager.disconnectSelected([...manager.workers.values()].filter((w) => owned(w.name, user)).map((w) => w.name)),
  set_area: (p) => manager.setArea(p && p.p1, p && p.p2),
  set_settings: (p) => manager.setSettings(p || {}),
  set_version: (p) => manager.setVersion(p && p.version),
  start: (p, user) => manager.start((w) => owned(w.name, user)),
  stop: () => manager.stop(),
  chat: async (p, user) => {
    if (p && p.target && p.target !== 'all') return manager.sendChat(p.target, p.text);
    const mine = [...manager.workers.values()].filter((w) => owned(w.name, user) && w.bot && w.spawned);
    if (!mine.length) throw new Error('None of your accounts is connected.');
    for (const w of mine) await manager.sendChat(w.name, p && p.text);
  },
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
  move_item: (p) => manager.moveItem(p && p.name, p && p.from, p && p.to, p && p.item),
  drop_all: (p) => manager.dropAll(p && p.name, p || {}),
  test_death_webhook: (p) => manager.testDeathWebhook(p && p.name),
  clear_logs: () => { manager.logs.length = 0; for (const client of io.sockets.sockets.values()) client.emit('logs_cleared'); },
};

// Microsoft accounts are private: everyone (admins and the founder included) only sees and controls the ones they connected.
// Legacy accounts without an owner belong to the founder.
const ownerRecordOf = (name) => auth.getUsers().find((u) => Array.isArray(u.botNames) && u.botNames.includes(name)) || null;
const staffOwns = (name, user) => { const rec = ownerRecordOf(name); return rec ? rec.id === user.id : perms.isFounder(user); };
const owned = (name, user) => {
  if (isAdmin(user)) return staffOwns(name, user);
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
  snap.limits = { used: usedSlots(user), limit: user.botLimit || 0, unlimited: admin, slots: admin ? [] : auth.publicUser(user).slots };
  if (admin) {
    snap.bots = snap.bots.filter((b) => staffOwns(b.name, user)).map((b) => ({ ...b, owner: user.username }));
    snap.names = snap.bots.map((b) => b.name);
    snap.pendingSignIns = (snap.pendingSignIns || []).filter((x) => x.ownerId === user.id || (!x.ownerId && perms.isFounder(user)));
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
  socket.emit('init', { state: snapshotFor(currentUser()), logs: manager.logs.filter((l) => canSeeLog(l, currentUser())).slice(-200) });
  socket.on('action', async (type, payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = currentUser();
    const original = originalUser();
    if (!original || lockReason(original)) {
      reply({ ok: false, error: 'Session expired. Sign in again.' });
      socket.disconnect(true);
      return;
    }
    if (type === 'view_as') return reply({ ok: false, error: 'Viewing other accounts is not available.' });
    if (type === 'exit_view_as') {
      if (!isAdmin(original)) return reply({ ok: false, error: 'Admin only' });
      viewAsBySocket.delete(socket.id);
      socket.emit('view_as_changed', { active: false });
      socket.emit('state', snapshotFor(original));
      return reply({ ok: true });
    }
    if (type === 'stop') {
      try {
        const internalNames = [...manager.workers.values()].filter((w) => owned(w.name, user)).map((w) => w.name);
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
      if (isAdmin(user)) {
        // admins and the founder control only their own Microsoft accounts, like everybody else
        const names = [payload && payload.name, payload && payload.target !== 'all' ? payload.target : null, ...(Array.isArray(payload && payload.names) ? payload.names : [])].filter((n) => typeof n === 'string' && n);
        if (names.some((n) => !owned(n, user))) throw new Error('That Microsoft account does not belong to you.');
      }
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
// A log line is shown to: the account it names (ownerId), the owners of the bots it names (bots), the owner of its source bot, or - for plain system lines - every admin.
const canSeeLog = (entry, user) => {
  if (entry.ownerId) return entry.ownerId === user.id;
  if (entry.bots) return entry.bots.some((n) => owned(n, user));
  return entry.source === 'system' ? isAdmin(user) : owned(entry.source, user);
};
manager.on('log', (entry) => {
  for (const socket of io.sockets.sockets.values()) {
    const who = liveUser(socket);
    if (who && canSeeLog(entry, who.effective)) socket.emit('log', entry);
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
