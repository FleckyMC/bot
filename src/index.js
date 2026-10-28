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

const manager = new BotManager({ dataDir: path.join(ROOT, 'data'), version: VERSION });

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
  const r = auth.login(req.body.username, req.body.password, req.ip, USER, PASSWORD);
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

// ---- Alles andere nur mit Login
app.use((req, res, next) => {
  if (auth.isValid(auth.tokenFrom(req))) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
  res.status(401).send('Nicht angemeldet');
});
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', extensions: ['html'] }));

// ---- Socket.io: Login-Cookie und Origin pruefen
io.use((socket, next) => {
  const req = socket.request;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return next(new Error('origin')); }
    catch { return next(new Error('origin')); }
  }
  if (!auth.isValid(auth.tokenFrom(req))) return next(new Error('unauthorized'));
  next();
});

const actions = {
  connect_bots: (p) => manager.connect(p || {}),
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

io.on('connection', (socket) => {
  socket.emit('init', { state: manager.snapshot(), logs: manager.logs.slice(-200) });
  socket.on('action', async (type, payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const fn = Object.prototype.hasOwnProperty.call(actions, type) ? actions[type] : null;
    if (!fn) return reply({ ok: false, error: 'Unbekannte Aktion' });
    try {
      await fn(payload);
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });
});

manager.on('log', (entry) => io.emit('log', entry));
manager.on('change', () => io.emit('state', manager.snapshot()));
setInterval(() => { if (io.engine.clientsCount) io.emit('state', manager.snapshot()); }, 1000).unref();

process.on('unhandledRejection', (e) => manager.log('system', `Unbehandelter Fehler: ${e && e.message ? e.message : e}`, 'error'));
process.on('uncaughtException', (e) => manager.log('system', `Fehler: ${e && e.message ? e.message : e}`, 'error'));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { manager.disconnect(true); } catch { /* egal */ } process.exit(0); });
}

server.listen(PORT, HOST, () => {
  console.log(`Dashboard laeuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (Minecraft ${VERSION})`);
});
