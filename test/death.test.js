'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const {
  validateWebhookUrl, normalizeDeathSettings, publicDeathSettings, extractDeathCause, buildDeathPayload, sendWebhook,
} = require('../src/deathNotify');
const { BotWorker } = require('../src/botWorker');
const { getPhysicsPlugin } = require('../src/tickEndPhysics');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOOK = 'https://discord.com/api/webhooks/123456/abcdefSECRET';

test('webhook URLs must be public https', () => {
  assert.equal(validateWebhookUrl(HOOK), HOOK);
  for (const bad of ['', 'nonsense', 'http://discord.com/x', 'https://user:pw@discord.com/x', 'https://localhost/x', 'https://127.0.0.1/x',
    'https://10.1.2.3/x', 'https://192.168.0.5/x', 'https://172.20.1.1/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'https://printer.local/x',
    'https://db.internal/x', 'https://' + 'a'.repeat(600) + '.com']) {
    assert.throws(() => validateWebhookUrl(bad), undefined, bad);
  }
});

test('death settings: validation, keeping and clearing the stored URL', () => {
  const first = normalizeDeathSettings({ commandEnabled: true, command: ' /home ', delaySec: 5, webhookEnabled: true, webhookUrl: HOOK });
  assert.deepEqual(first, { commandEnabled: true, command: '/home', delaySec: 5, webhookEnabled: true, webhookUrl: HOOK });
  const kept = normalizeDeathSettings({ command: '/back', webhookUrl: '' }, first);
  assert.equal(kept.webhookUrl, HOOK);
  assert.equal(kept.command, '/back');
  const cleared = normalizeDeathSettings({ webhookEnabled: false, clearWebhook: true }, first);
  assert.equal(cleared.webhookUrl, '');
  assert.throws(() => normalizeDeathSettings({ commandEnabled: true, command: '' }), /leer/);
  assert.throws(() => normalizeDeathSettings({ webhookEnabled: true }), /keine URL/);
  assert.throws(() => normalizeDeathSettings({ command: 'a\nb' }), /eine Zeile/);
  assert.throws(() => normalizeDeathSettings({ command: 'x'.repeat(257) }), /256/);
  assert.throws(() => normalizeDeathSettings({ delaySec: 500 }), /0 und 120/);
  assert.throws(() => normalizeDeathSettings({ webhookUrl: 'http://example.com' }), /https/);
});

test('the dashboard never receives the full webhook URL', () => {
  const pub = publicDeathSettings({ webhookEnabled: true, webhookUrl: HOOK, command: '/home', commandEnabled: true, delaySec: 2 });
  assert.equal(pub.hasWebhook, true);
  assert.ok(!JSON.stringify(pub).includes('SECRET'));
  assert.ok(!JSON.stringify(pub).includes('webhooks/123456'));
  assert.deepEqual(publicDeathSettings(null), { commandEnabled: false, command: '', delaySec: 3, webhookEnabled: false, hasWebhook: false, webhookHint: '' });
});

test('death cause: server message first, then a recent chat line, else unknown', () => {
  const now = 1_000_000;
  assert.equal(extractDeathCause({ packetText: '§cSteve was slain by Zombie', chatLines: [], names: ['Steve'], now }), 'Steve was slain by Zombie');
  const chat = [{ t: now - 30000, text: 'Steve fell from a high place' }, { t: now - 2000, text: 'Alex hat Hallo gesagt' }, { t: now - 1000, text: 'Steve was blown up by Creeper' }];
  assert.equal(extractDeathCause({ packetText: '', chatLines: chat, names: ['Steve'], now }), 'Steve was blown up by Creeper');
  assert.equal(extractDeathCause({ packetText: '  ', chatLines: [chat[0]], names: ['Steve'], now }), 'unbekannt', 'zu alte Zeilen zaehlen nicht');
  assert.equal(extractDeathCause({ packetText: '', chatLines: [], names: [], now }), 'unbekannt');
});

test('payload: Discord embed without pings, generic JSON elsewhere', () => {
  const info = { minecraftName: 'Steve', cause: 'Steve was slain by @everyone', server: 'play.example.net', position: '1 64 -3', dimension: 'overworld', task: 'Abbau', time: 0 };
  const discord = buildDeathPayload(info, HOOK);
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  assert.equal(discord.embeds[0].description, 'Steve was slain by @everyone');
  assert.equal(discord.embeds[0].fields.find((f) => f.name === 'Minecraft-Name').value, 'Steve');
  const generic = buildDeathPayload(info, 'https://hooks.example.com/x');
  assert.equal(generic.minecraftName, 'Steve');
  assert.match(generic.text, /Steve ist gestorben/);
  assert.equal(buildDeathPayload({ ...info, cause: 'x'.repeat(5000) }, HOOK).embeds[0].description.length, 1000);
});

test('sendWebhook posts JSON, never follows redirects and reports HTTP errors without the URL', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 204 }; };
  assert.equal(await sendWebhook(HOOK, { a: 1 }, { fetchImpl: ok }), 204);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { a: 1 });
  await assert.rejects(sendWebhook(HOOK, {}, { fetchImpl: async () => ({ ok: false, status: 404 }) }), (e) => /404/.test(e.message) && !e.message.includes('SECRET'));
  await assert.rejects(sendWebhook('http://example.com/x', {}, { fetchImpl: ok }), /https/);
});

// ---------------------------------------------------------------- BotWorker: Tod und Respawn

function setup(death, extra = {}) {
  const logs = [];
  const m = {
    log: (name, text, level) => logs.push({ name, text, level }),
    touch() {}, accountNames: {}, settings: {}, mining: false, msa: new Map(), connection: { auth: 'microsoft' },
    getBotSettings: () => ({ death }),
    ...extra,
  };
  const w = new BotWorker(m, 'TestBot');
  const bot = new EventEmitter();
  bot.registry = require('prismarine-registry')('1.21.11');
  bot.username = 'Steve';
  bot.entity = { position: new Vec3(10.4, 64, -3.2) };
  bot.game = { dimension: 'minecraft:overworld' };
  bot._client = new EventEmitter();
  bot._client.state = 'play';
  bot.pathfinder = { stop() {} };
  bot.clearControlStates = () => {};
  bot.sent = [];
  bot.chat = (t) => { bot.sent.push(t); };
  w.bot = bot;
  w.spawned = true;
  w.serverAddress = { host: 'play.example.net', port: 25565 };
  w.physicsWaitMs = 60;
  w.setupLifecycle(bot);
  bot.emit('spawn'); // erster Spawn (wird in connect() behandelt)
  return { w, bot, logs, m };
}

test('death: webhook with name, cause, server and position; secret stays out of the log', async (t) => {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; };
  t.after(() => { globalThis.fetch = realFetch; });
  const { w, bot, logs } = setup({ webhookEnabled: true, webhookUrl: HOOK, commandEnabled: false });
  bot._client.emit('death_combat_event', { playerId: 1, message: JSON.stringify({ text: 'Steve was slain by Zombie' }) });
  bot.emit('death');
  await sleep(1400);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, HOOK);
  const embed = posts[0].body.embeds[0];
  assert.equal(embed.description, 'Steve was slain by Zombie');
  const field = (n) => embed.fields.find((f) => f.name === n).value;
  assert.equal(field('Minecraft-Name'), 'Steve');
  assert.equal(field('Server'), 'play.example.net');
  assert.equal(field('Position'), '10 64 -4');
  assert.equal(field('Dimension'), 'overworld');
  assert.ok(logs.every((l) => !l.text.includes('SECRET')));
  assert.ok(w.resume === null);
});

test('death without server message falls back to the chat line', async (t) => {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  t.after(() => { globalThis.fetch = realFetch; });
  const { bot } = setup({ webhookEnabled: true, webhookUrl: HOOK });
  bot.emit('messagestr', 'Steve drowned');
  bot.emit('death');
  await sleep(1400);
  assert.equal(posts[0].embeds[0].description, 'Steve drowned');
});

test('no webhook is sent when disabled; a failing webhook only logs a warning', async (t) => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('netzwerk weg'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const off = setup({ webhookEnabled: false, webhookUrl: HOOK });
  off.bot.emit('death');
  await sleep(1400);
  assert.equal(calls, 0);
  const failing = setup({ webhookEnabled: true, webhookUrl: HOOK });
  failing.bot.emit('death');
  await sleep(1400);
  assert.equal(calls, 1);
  assert.ok(failing.logs.some((l) => l.level === 'warn' && /Webhook fehlgeschlagen/.test(l.text)));
});

test('respawn: command runs after the configured wait, then the task resumes', async () => {
  const { w, bot, logs } = setup({ commandEnabled: true, command: '/home base', delaySec: 0, webhookEnabled: false }, { mining: true });
  w.region = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 };
  w.profile = 'mining';
  let started = 0;
  w.startJob = () => { started++; };
  bot.emit('death');
  assert.deepEqual(w.resume, { type: 'mining' }, 'Aufgabe wird vorgemerkt');
  assert.equal(w.job, null, 'Aufgabe pausiert, solange der Bot tot ist');
  assert.deepEqual(bot.sent, [], 'Befehl erst nach dem Respawn');
  bot.emit('respawn');
  bot.emit('forcedMove');
  bot.emit('spawn');
  await sleep(2300);
  assert.deepEqual(bot.sent, ['/home base']);
  assert.equal(started, 1);
  assert.equal(w.resume, null);
  assert.ok(logs.some((l) => /Todes-Befehl ausgeführt/.test(l.text)));
  assert.ok(logs.some((l) => /fortgesetzt/.test(l.text)));
});

test('respawn: AFK/fishing resume with their options, and stopping cancels the resume', async () => {
  const { w, bot } = setup({ commandEnabled: false, webhookEnabled: false });
  const started = [];
  w.startProfile = (profile, options) => started.push([profile, options]);
  w.profile = 'fishing';
  w.profileOptions = { threshold: 7 };
  bot.emit('death');
  bot.emit('respawn'); bot.emit('forcedMove'); bot.emit('spawn');
  await sleep(800);
  assert.deepEqual(started, [['fishing', { threshold: 7 }]]);

  w.profile = 'afk';
  bot.emit('death');
  w.stopJob();
  bot.emit('respawn'); bot.emit('forcedMove'); bot.emit('spawn');
  await sleep(800);
  assert.equal(started.length, 1, 'wer stoppt, startet nach dem Respawn nichts neu');
});

test('respawn: physics is forced back on when the server never sends a position', async () => {
  const { w, bot, logs } = setup({ commandEnabled: false, webhookEnabled: false });
  let forced = 0;
  bot._forcePhysicsOn = () => { forced++; };
  bot.emit('death');
  bot.emit('respawn');
  bot.emit('spawn'); // kein forcedMove
  await sleep(400);
  assert.equal(forced, 1);
  assert.ok(logs.some((l) => /Physik manuell wieder eingeschaltet/.test(l.text)));
  assert.equal(bot.physicsEnabled, true);

  // kommt die Position rechtzeitig, wird nichts erzwungen
  forced = 0;
  bot.emit('death'); bot.emit('respawn');
  setTimeout(() => bot.emit('forcedMove'), 10);
  bot.emit('spawn');
  await sleep(400);
  assert.equal(forced, 0);
});

test('a dimension change does not reset a running task or its status', async () => {
  const { w, bot } = setup({ commandEnabled: false, webhookEnabled: false });
  w.status = 'mining'; w.detail = 'Block 1 2 3';
  bot.emit('respawn'); bot.emit('forcedMove'); bot.emit('spawn');
  await sleep(100);
  assert.equal(w.status, 'mining');
});

test('the snapshot exposes the death settings without the webhook URL', () => {
  const { w } = setup({ webhookEnabled: true, webhookUrl: HOOK, commandEnabled: true, command: '/home', delaySec: 2 });
  const snap = w.snapshot();
  assert.equal(snap.death.hasWebhook, true);
  assert.equal(snap.death.command, '/home');
  assert.ok(!JSON.stringify(snap).includes('SECRET'));
});

test('the patched physics plugin offers a way to force physics on again', async () => {
  const bot = new EventEmitter();
  bot.registry = require('prismarine-registry')('1.21.11');
  bot.supportFeature = bot.registry.supportFeature;
  bot.version = '1.21.11';
  bot._client = new EventEmitter();
  bot._client.state = 'play';
  bot._client.write = () => {};
  bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(), yaw: 0, pitch: 0, onGround: true };
  bot.isAlive = true;
  bot.blockAt = () => ({});
  getPhysicsPlugin()(bot, { physicsEnabled: false });
  assert.equal(typeof bot._forcePhysicsOn, 'function');
  bot.emit('end');
});

// ---------------------------------------------------------------- Manager: Speichern, Rechte, Test-Webhook

test('manager persists per-bot death settings, hides the URL from snapshots and only admins may change them', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { BotManager } = require('../src/botManager');
  const { authorizeAction } = require('../src/access');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'death-mgr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ accountNames: { Acc1: 'Steve' }, names: ['Acc1'] }));

  const m1 = new BotManager({ dataDir: dir });
  m1.setBotDeathSettings('Acc1', { commandEnabled: true, command: '/home', delaySec: 4, webhookEnabled: true, webhookUrl: HOOK });
  assert.throws(() => m1.setBotDeathSettings('Nope', {}), /Unbekannter Bot/);

  const m2 = new BotManager({ dataDir: dir }); // neu geladen
  assert.equal(m2.getBotSettings('Acc1').death.webhookUrl, HOOK);
  const snap = m2.snapshot();
  assert.equal(snap.bots[0].death.command, '/home');
  assert.ok(!JSON.stringify(snap).includes('SECRET'));

  const realFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  t.after(() => { globalThis.fetch = realFetch; });
  await m2.testDeathWebhook('Acc1');
  assert.equal(posts[0].embeds[0].title, 'Bot gestorben (Test)');
  m2.setBotDeathSettings('Acc1', { webhookEnabled: false, clearWebhook: true });
  await assert.rejects(m2.testDeathWebhook('Acc1'), /keine Webhook-URL/);

  m2.removeBot('Acc1');
  assert.equal(m2.getBotSettings('Acc1').death, undefined, 'beim Entfernen wird auch die Einstellung geloescht');

  const owner = { role: 'user', botNames: ['Acc1'] };
  const owned = () => true;
  assert.throws(() => authorizeAction(owner, 'set_bot_death', { name: 'Acc1' }, owned), /Only the admin/);
  assert.throws(() => authorizeAction(owner, 'test_death_webhook', { name: 'Acc1' }, owned), /Only the admin/);
  assert.doesNotThrow(() => authorizeAction({ role: 'admin' }, 'set_bot_death', {}, owned));
});
