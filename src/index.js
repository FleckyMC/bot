'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

// .env laden; fehlt das Passwort, wird eins erzeugt und in .env gespeichert
require('dotenv').config({ path: ENV_FILE, quiet: true });
if (!process.env.DASHBOARD_PASSWORD) {
  const pw = crypto.randomBytes(9).toString('base64url');
  const user = process.env.DASHBOARD_USER || 'admin';
  fs.appendFileSync(ENV_FILE, `${fs.existsSync(ENV_FILE) && fs.readFileSync(ENV_FILE, 'utf8').endsWith('\n') === false ? '\n' : ''}DASHBOARD_USER=${user}\nDASHBOARD_PASSWORD=${pw}\n`);
  process.env.DASHBOARD_USER = user;
  process.env.DASHBOARD_PASSWORD = pw;
  console.log('==============================================');
  console.log(' Kein Passwort gesetzt - es wurde eins erzeugt:');
  console.log(`   Benutzer : ${user}`);
  console.log(`   Passwort : ${pw}`);
  console.log(' (gespeichert in .env, dort kannst du es aendern)');
  console.log('==============================================');
}

const USER = process.env.DASHBOARD_USER || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = process.env.MC_VERSION || 'auto';
const FORCE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';

const auth = require('./auth');
const { BotManager } = require('./botManager');

auth.configure(path.join(ROOT, 'data', 'users.json'), USER, PASSWORD);
const manager = new BotManager({ dataDir: path.join(ROOT, 'data'), version: VERSION });
const isAdmin = (user) => !!user && user.role === 'admin';
const requireAdmin = (req, res, next) => isAdmin(auth.sessionUser(auth.tokenFrom(req))) ? next() : res.status(403).json({ error: 'Admin only' });

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });

const isSecure = (req) => FORCE_SECURE || req.secure || req.headers['x-forwarded-proto'] === 'https';

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

// ---- Oeffentlich: nur die Login-Seite
app.get('/login', (req, res) => {
  if (auth.isValid(auth.tokenFrom(req))) return res.redirect('/');
  res.sendFile(path.join(ROOT, 'public', 'login.html'));
});
app.get('/login.css', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.css')));
app.get('/login.js', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.js')));

app.post('/login', (req, res) => {
  const r = auth.login(req.body.username, req.body.password, req.ip);
  if (r.error === 'rate') return res.redirect('/login?e=rate');
  if (r.error) return res.redirect('/login?e=1');
  res.set('Set-Cookie', auth.cookieHeader(r.token, isSecure(req)));
  res.redirect('/');
});

app.get('/api/me', (req, res) => { const user = auth.sessionUser(auth.tokenFrom(req)); if (!user) return res.status(401).json({error:'Not signed in'}); res.json({user:auth.publicUser(user)}); });
app.get('/api/admin/users', (req, res, next) => { if (!auth.isValid(auth.tokenFrom(req))) return res.status(401).json({error:'Not signed in'}); next(); }, requireAdmin, (req, res) => res.json({users:auth.getUsers().map(auth.publicUser)}));
app.post('/api/admin/users', express.json({limit:'16kb'}), (req, res, next) => { if (!auth.isValid(auth.tokenFrom(req))) return res.status(401).json({error:'Not signed in'}); next(); }, requireAdmin, (req, res) => { try { res.status(201).json({user:auth.createUser(req.body || {})}); } catch(e) { res.status(400).json({error:e.message}); } });
app.patch('/api/admin/users/:id', express.json({limit:'16kb'}), (req, res, next) => { if (!auth.isValid(auth.tokenFrom(req))) return res.status(401).json({error:'Not signed in'}); next(); }, requireAdmin, (req, res) => { try { res.json({user:auth.updateUser(req.params.id, req.body || {})}); } catch(e) { res.status(400).json({error:e.message}); } });
app.delete('/api/admin/users/:id', (req, res, next) => { if (!auth.isValid(auth.tokenFrom(req))) return res.status(401).json({error:'Not signed in'}); next(); }, requireAdmin, (req, res) => { try { auth.deleteUser(req.params.id); res.status(204).end(); } catch(e) { res.status(400).json({error:e.message}); } });
app.post('/api/password', express.json({limit:'8kb'}), (req, res, next) => { if (!auth.isValid(auth.tokenFrom(req))) return res.status(401).json({error:'Not signed in'}); next(); }, (req, res) => { try { const u=auth.sessionUser(auth.tokenFrom(req)); auth.changePassword(u.id, req.body.currentPassword, req.body.newPassword); res.json({ok:true}); } catch(e) { res.status(400).json({error:e.message}); } });
app.post('/logout', (req, res) => {
  auth.logout(auth.tokenFrom(req));
  res.set('Set-Cookie', auth.cookieHeader('', isSecure(req), true));
  res.redirect('/login');
});

// ---- Alles andere nur mit Login
app.use((req, res, next) => {
  if (auth.isValid(auth.tokenFrom(req))) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
  res.status(401).send('Nicht angemeldet');
});
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', extensions: ['html'] }));

// ---- Socket.io: Login-Cookie und Origin pruefen
const socketUserById = new Map();
const viewAsBySocket = new Map();
io.use((socket, next) => {
  const req = socket.request;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return next(new Error('origin')); }
    catch { return next(new Error('origin')); }
  }
  const user = auth.sessionUser(auth.tokenFrom(req));
  if (!user) return next(new Error('unauthorized'));
  socketUserById.set(socket.id, user.id);
  next();
});

const actions = {
  connect_bots: (p) => manager.connect(p || {}),
  connect_selected: (p) => manager.connectSelected(p || {}),
  disconnect_bots: () => manager.disconnect(),
  set_area: (p) => manager.setArea(p && p.p1, p && p.p2),
  set_settings: (p) => manager.setSettings(p || {}),
  set_version: (p) => manager.setVersion(p && p.version),
  start: () => manager.start(),
  stop: () => manager.stop(),
  chat: (p) => manager.sendChat(p && p.target, p && p.text),
  bot_profile: (p) => manager.setBotProfile(p && p.name, p && p.profile, p && p.options || {}),
  add_bot: (p) => manager.addBot(p || {}),
  remove_bot: (p) => manager.removeBot(p && p.name),
};

const owned = (name, user) => isAdmin(user) || (Array.isArray(user && user.botNames) && user.botNames.includes(name));
const snapshotFor = (user) => { const snap=manager.snapshot(); if (isAdmin(user)) return snap; snap.bots=snap.bots.filter(b=>owned(b.name,user)); snap.names=snap.bots.map(b=>b.name); return {...snap,connection:null,area:null,settings:{},mining:false}; };
io.on('connection', (socket) => {
  const originalUser = () => auth.getUsers().find(u => u.id === socketUserById.get(socket.id));
  const currentUser = () => { const original=originalUser(); const target=viewAsBySocket.get(socket.id); return isAdmin(original)&&target ? auth.getUsers().find(u=>u.id===target) || original : original; };
  socket.emit('init', { state: snapshotFor(currentUser()), logs: isAdmin(currentUser()) ? manager.logs.slice(-200) : [] });
  socket.on('action', async (type, payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const user = currentUser();
    const original = originalUser();
    if (type === 'view_as') {
      if (!isAdmin(original)) return reply({ok:false,error:'Admin only'});
      const target = auth.getUsers().find(u=>u.id===String(payload && payload.userId || ''));
      if (!target) return reply({ok:false,error:'Account not found'});
      viewAsBySocket.set(socket.id,target.id);
      socket.emit('view_as_changed',{active:true,username:target.username});
      socket.emit('state',snapshotFor(target));
      return reply({ok:true});
    }
    if (type === 'exit_view_as') {
      if (!isAdmin(original)) return reply({ok:false,error:'Admin only'});
      viewAsBySocket.delete(socket.id);
      socket.emit('view_as_changed',{active:false});
      socket.emit('state',snapshotFor(original));
      return reply({ok:true});
    }
    if (type === 'stop' && !isAdmin(user)) {
      try {
        manager.stopBots(user && user.botNames);
        reply({ok:true});
      } catch (e) {
        reply({ok:false,error:e.message});
      }
      return;
    }
    const fn = Object.prototype.hasOwnProperty.call(actions, type) ? actions[type] : null;
    if (!fn) return reply({ ok: false, error: 'Unknown action' });
    if (!isAdmin(user)) {
      if (['connect_bots','connect_selected','disconnect_bots','set_area','set_settings','set_version','start','add_bot','remove_bot'].includes(type)) return reply({ok:false,error:'Only the admin can change global bot settings or add/remove bots.'});
      if (type === 'chat' && payload && payload.target !== 'all' && !owned(payload.target,user)) return reply({ok:false,error:'Bot not assigned to this account.'});
      if (type === 'chat' && payload && payload.target === 'all') return reply({ok:false,error:'Select an assigned bot.'});
      if (type === 'bot_profile' && !owned(payload && payload.name,user)) return reply({ok:false,error:'Bot not assigned to this account.'});
    }
    try {
      await fn(payload);
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });
  socket.on('disconnect', () => { socketUserById.delete(socket.id); viewAsBySocket.delete(socket.id); });
});

manager.on('log', (entry) => { for (const socket of io.sockets.sockets.values()) { const original=auth.getUsers().find(x=>x.id===socketUserById.get(socket.id)); const u=viewAsBySocket.has(socket.id)?auth.getUsers().find(x=>x.id===viewAsBySocket.get(socket.id)):original; if (isAdmin(original) || (u && u.botNames.includes(entry.source))) socket.emit('log', entry); } });
manager.on('change', () => { for (const socket of io.sockets.sockets.values()) { const original=auth.getUsers().find(x=>x.id===socketUserById.get(socket.id)); const u=viewAsBySocket.has(socket.id)?auth.getUsers().find(x=>x.id===viewAsBySocket.get(socket.id)):original; socket.emit('state', snapshotFor(u)); } });
setInterval(() => { if (io.engine.clientsCount) for (const socket of io.sockets.sockets.values()) { const original=auth.getUsers().find(x=>x.id===socketUserById.get(socket.id)); const u=viewAsBySocket.has(socket.id)?auth.getUsers().find(x=>x.id===viewAsBySocket.get(socket.id)):original; socket.emit('state', snapshotFor(u)); } }, 1000).unref();

process.on('unhandledRejection', (e) => manager.log('system', `Unbehandelter Fehler: ${e && e.message ? e.message : e}`, 'error'));
process.on('uncaughtException', (e) => manager.log('system', `Fehler: ${e && e.message ? e.message : e}`, 'error'));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { manager.disconnect(true); } catch { /* egal */ } process.exit(0); });
}

server.listen(PORT, HOST, () => {
  console.log(`Dashboard laeuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (Minecraft ${VERSION})`);
});
