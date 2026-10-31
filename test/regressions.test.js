'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Vec3 } = require('vec3');
const { getPhysicsPlugin } = require('../src/tickEndPhysics');
const { BotWorker } = require('../src/botWorker');
const { BotManager } = require('../src/botManager');
const { authorizeAction } = require('../src/access');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function physicsBot(version, loaded = false, plugin = getPhysicsPlugin()) {
  const bot = new EventEmitter();
  bot.registry = require('prismarine-registry')(version);
  bot.supportFeature = bot.registry.supportFeature;
  bot.version = version;
  bot._client = new EventEmitter();
  bot._client.state = 'play';
  bot.packets = [];
  bot._client.write = (name, data) => bot.packets.push({ name, data });
  bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(), yaw: 0, pitch: 0, onGround: true };
  bot.isAlive = true;
  bot.blockAt = () => loaded ? {} : null;
  plugin(bot, { physicsEnabled: false });
  return bot;
}

test('reproduces missing tick_end in the actual locked Mineflayer', async t => {
  const bot = physicsBot('26.1', false, require('mineflayer/lib/plugins/physics'));
  t.after(() => bot.emit('end'));
  bot.emit('login');
  await sleep(180);
  assert.equal(bot.packets.filter(p => p.name === 'tick_end').length, 0);
});

for (const version of ['26.1', '1.21.11']) {
  test(`tick_end works on ${version} even while chunks are loading`, async t => {
    const bot = physicsBot(version);
    t.after(() => bot.emit('end'));
    bot.emit('login');
    await sleep(180);
    assert.ok(bot.packets.some(p => p.name === 'tick_end'));
    assert.ok(bot.packets.every(p => p.name === 'tick_end'));
  });
}

test('older protocols never receive an unsupported tick_end packet', async t => {
  const bot = physicsBot('1.20.4');
  t.after(() => bot.emit('end'));
  bot.emit('login');
  await sleep(180);
  assert.deepEqual(bot.packets, []);
});

test('configuration/invalid entity stops ticks; end stops the timer', async t => {
  const bot = physicsBot('26.1');
  t.after(() => bot.emit('end'));
  bot._client.state = 'configuration';
  bot.emit('login');
  await sleep(130);
  assert.deepEqual(bot.packets, []);
  bot._client.state = 'play';
  bot.entity.position.x = NaN;
  await sleep(130);
  assert.deepEqual(bot.packets, []);
  bot.entity.position.x = 0;
  await sleep(130);
  assert.ok(bot.packets.length);
  bot.emit('end');
  const count = bot.packets.length;
  await sleep(130);
  assert.equal(bot.packets.length, count);
});

test('tick end follows movement, rather than being sent before movement', async t => {
  const bot = physicsBot('26.1', true);
  t.after(() => bot.emit('end'));
  bot.emit('login');
  bot._client.emit('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: {}, teleportId: 1 });
  bot.packets.length = 0;
  bot.entity.position.x = 1;
  await sleep(180);
  const movement = bot.packets.findIndex(p => ['position', 'position_look'].includes(p.name));
  assert.ok(movement >= 0);
  assert.equal(bot.packets[movement + 1].name, 'tick_end');
});

test('real Mineflayer accepts the physics override alongside pathfinder and existing fixes', async t => {
  const mineflayer = require('mineflayer');
  const client = new EventEmitter();
  client.version = '26.1';
  client.state = 'play';
  client.write = () => {};
  client.end = () => {};
  client.registerChannel = () => {};
  const physicsPath = require.resolve('mineflayer/lib/plugins/physics');
  const before = fs.readFileSync(physicsPath);
  const bot = mineflayer.createBot({ client, username: 'Test', version: '26.1', plugins: { physics: getPhysicsPlugin() }, hideErrors: true });
  bot.on('error', () => {});
  bot.loadPlugin(require('mineflayer-pathfinder').pathfinder);
  require('../src/physicsFix').installPhysicsFixes(bot);
  t.after(() => bot.emit('end'));
  await sleep(60);
  assert.equal(typeof bot.look, 'function');
  assert.equal(typeof bot.pathfinder.goto, 'function');
  assert.equal(bot.listenerCount('physicsTick') > 0, true);
  assert.deepEqual(fs.readFileSync(physicsPath), before, 'installed dependency remains byte-for-byte unchanged');
  assert.equal(getPhysicsPlugin(), getPhysicsPlugin(), 'one compiled plugin is reused');
});

function worker() {
  const logs = [];
  const m = { log: (name, text, level) => logs.push({ name, text, level }), touch() {}, accountNames: {}, settings: {} };
  const w = new BotWorker(m, 'TestBot');
  const bot = new EventEmitter();
  bot.entity = {};
  bot._client = { state: 'play' };
  bot.sent = [];
  bot.chat = text => { bot.sent.push(text); bot.emit('messagestr', `<TestBot> ${text}`); };
  w.bot = bot;
  w.spawned = true;
  return { w, bot, logs };
}

test('queued commands cannot run on a replacement connection', async () => {
  const { w, bot } = worker();
  const task = w.chat('/balance');
  const replacement = new EventEmitter();
  replacement.entity = {};
  replacement._client = { state: 'play' };
  replacement.chat = () => assert.fail('must not send on replacement bot');
  w.bot = replacement;
  await assert.rejects(task, /nicht verbunden/);
  assert.deepEqual(bot.sent, []);
});

test('chat spacing is enforced and reconnection during the wait cancels the command', async () => {
  const { w, bot } = worker();
  await w.chat('/balance');
  const pending = w.chat('/pay Example 1');
  await sleep(20);
  w.bot = null;
  w.spawned = false;
  await assert.rejects(pending, /getrennt/);
  assert.deepEqual(bot.sent, ['/balance']);
});

test('synchronous server echo is caught; echo listeners are cleaned up', async () => {
  const { w, bot, logs } = worker();
  await w.chat('hello');
  assert.ok(logs.some(l => l.text.includes('zurückgespielt')));
  assert.equal(bot.listenerCount('messagestr'), 0);
  assert.equal(bot.listenerCount('end'), 0);
  w.watchChatEcho(bot, 'another message');
  bot.emit('end');
  assert.equal(bot.listenerCount('messagestr'), 0);
});

test('configuration state, newlines and empty messages cannot send', async () => {
  const { w, bot } = worker();
  bot._client.state = 'configuration';
  await assert.rejects(w.chat('/balance'));
  assert.throws(() => w.chat('hello\n/pay Other 1'));
  assert.throws(() => w.chat(''));
  assert.deepEqual(bot.sent, []);
});

test('a synchronous send failure cleans up and does not poison the next command', async () => {
  const { w, bot } = worker();
  bot.chat = () => { throw new Error('write failed'); };
  await assert.rejects(w.chat('hello'), /write failed/);
  assert.equal(bot.listenerCount('messagestr'), 0);
  bot.chat = text => bot.sent.push(text);
  await w.chat('/balance');
  assert.deepEqual(bot.sent, ['/balance']);
});

test('saved offline accounts allow 26.1/version changes; active and reconnecting accounts block changes', t => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'review-temp-'));
  const m = new BotManager({ dataDir: dir });
  t.after(() => { clearTimeout(m.touchTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  m.workers.set('Saved', { bot: null, wantConnected: false });
  m.setVersion('26.1');
  assert.equal(m.version, '26.1');
  assert.equal(JSON.parse(fs.readFileSync(m.file)).version, '26.1');
  m.workers.get('Saved').wantConnected = true;
  assert.throws(() => m.setVersion('auto'), /zuerst trennen/);
  m.workers.get('Saved').wantConnected = false;
  m.workers.get('Saved').bot = {};
  assert.throws(() => m.setVersion('auto'), /zuerst trennen/);
  m.workers.get('Saved').bot = null;
  m.setVersion('1.21.11');
  assert.throws(() => m.setVersion('99.99'));
});

test('regular users cannot disconnect other accounts, clear global logs, or broadcast by omitting target', () => {
  const user = { role: 'user' };
  const owns = name => name === 'Mine';
  assert.throws(() => authorizeAction(user, 'disconnect_selected', { names: ['Other'] }, owns));
  assert.throws(() => authorizeAction(user, 'disconnect_selected', { names: ['Mine', 'Other'] }, owns));
  assert.throws(() => authorizeAction(user, 'chat', { text: 'broadcast' }, owns));
  assert.throws(() => authorizeAction(user, 'chat', { target: 'all', text: 'broadcast' }, owns));
  assert.throws(() => authorizeAction(user, 'clear_logs', {}, owns));
  assert.doesNotThrow(() => authorizeAction(user, 'chat', { target: 'Mine' }, owns));
  assert.doesNotThrow(() => authorizeAction(user, 'disconnect_selected', { names: ['Mine'] }, owns));
  assert.doesNotThrow(() => authorizeAction({ role: 'admin' }, 'chat', { target: 'all' }, owns));
  assert.throws(() => authorizeAction(null, 'chat', { target: 'Mine' }, owns));
});

test('villager trading uses the opened trade window, not the world entity', async () => {
  const { w, bot } = worker();
  const entity = { name: 'villager', position: new Vec3(1, 64, 0) };
  bot.entity.position = new Vec3(0, 64, 0);
  bot.entities = { 2: entity };
  bot.lookAt = async () => {};
  const trades = [];
  let closed = false;
  bot.openVillager = async v => {
    assert.equal(v, entity);
    return { trades: [{ maximumNbTradeUses: 5, nbTradeUses: 0 }], trade: async (...args) => trades.push(args), close: () => { closed = true; } };
  };
  bot.trade = () => assert.fail('world entity must not be passed to bot.trade');
  w.startProfile('trading', { tradeIndex: 0, tradeCount: 1 });
  await w.jobPromise;
  assert.deepEqual(trades, [[0, 1]]);
  assert.equal(closed, true);
});

test('native tick_end support is reused; unfamiliar unpatched sources fail clearly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/tickEndPhysics.js'), 'utf8');
  const nativePlugin = () => {};
  let fixture = "client.write('tick_end', {})";
  const fakeRequire = name => name === 'fs' ? { readFileSync: () => fixture } : name === '/fixture/physics.js' ? nativePlugin : require(name);
  fakeRequire.resolve = () => '/fixture/physics.js';
  const load = () => {
    const m = { exports: {} };
    vm.runInNewContext(source, { require: fakeRequire, module: m });
    return m.exports.getPhysicsPlugin();
  };
  assert.equal(load(), nativePlugin);
  fixture = 'module.exports = function changedPhysics() {}';
  assert.throws(load, /Unsupported Mineflayer physics module/);
});

// Exercise the actual dashboard action handler with an in-memory Socket.IO
// transport and real authentication. No listener, account login or Minecraft
// network connection is started by this harness.
function dashboard(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, 'review-temp-'));
  const auth = require('../src/auth');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let io, manager;
  const intervals = [];
  class SocketServer extends EventEmitter {
    constructor() { super(); io = this; this.sockets = { sockets: new Map() }; this.engine = { clientsCount: 1 }; }
    use(fn) { this.middleware = fn; }
  }
  class Manager extends EventEmitter {
    constructor() {
      super(); manager = this; this.logs = []; this.workers = new Map(); this.accountNames = {}; this.calls = [];
    }
    snapshot() { return { bots: [], names: [], settings: {}, pendingSignIns: [] }; }
    sendChat(...args) { this.calls.push(['chat', ...args]); }
    disconnectSelected(...args) { this.calls.push(['disconnect', ...args]); }
    stopBots(...args) { this.calls.push(['stop', ...args]); }
  }
  const app = { set() {}, disable() {}, use() {}, get() {}, post() {}, patch() {}, delete() {} };
  const express = () => app;
  express.urlencoded = express.json = express.static = () => () => {};
  const authForTest = { ...auth, configure: (_file, user, password) => auth.configure(path.join(dir, 'users.json'), user, password) };
  const fakeRequire = name => {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => ({ listen() {} }) };
    if (name === 'socket.io') return { Server: SocketServer };
    if (name === 'dotenv') return { config() {} };
    if (name === './auth') return authForTest;
    if (name === './botManager') return { BotManager: Manager };
    if (name === './access') return require('../src/access');
    return require(name);
  };
  const fakeProcess = new EventEmitter();
  fakeProcess.env = { DASHBOARD_PASSWORD: 'test-only-password', DASHBOARD_USER: 'ReviewAdmin' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8'), {
    require: fakeRequire, __dirname: path.join(__dirname, '../src'), process: fakeProcess, console,
    setInterval: fn => { intervals.push(fn); return { unref() {} }; }, URL,
  });
  const user = auth.createUser({ username: 'ReviewUser', password: 'test-only-password', botNames: ['Mine'] });
  const login = auth.login(user.username, 'test-only-password', 'test-ip');
  assert.ok(login.token);
  const socket = new EventEmitter();
  socket.id = 'test-socket';
  socket.request = { headers: { cookie: `session=${login.token}` } };
  socket.disconnect = () => { socket.disconnected = true; io.sockets.sockets.delete(socket.id); };
  io.middleware(socket, error => { if (error) throw error; });
  io.sockets.sockets.set(socket.id, socket);
  io.emit('connection', socket);
  const action = (type, payload) => new Promise(resolve => socket.emit('action', type, payload, resolve));
  return { auth, user, login, socket, manager, action, intervals };
}

test('dashboard handler rejects permission bypasses and permits assigned bot chat', async t => {
  const { manager, action } = dashboard(t);
  for (const [type, payload] of [
    ['chat', { text: 'broadcast with no target' }],
    ['chat', { target: 'all', text: 'broadcast' }],
    ['disconnect_selected', { names: ['Other'] }],
    ['clear_logs', {}],
  ]) {
    assert.equal((await action(type, payload)).ok, false);
  }
  assert.deepEqual(manager.calls, []);
  assert.equal((await action('chat', { target: 'Mine', text: '/balance' })).ok, true);
  assert.deepEqual(manager.calls, [['chat', 'Mine', '/balance']]);
});

test('logout invalidates an already connected dashboard socket before another command', async t => {
  const { auth, login, socket, manager, action } = dashboard(t);
  auth.logout(login.token);
  assert.equal((await action('chat', { target: 'Mine', text: '/balance' })).ok, false);
  assert.equal(socket.disconnected, true);
  assert.deepEqual(manager.calls, []);
});

test('expired accounts stop receiving live dashboard updates', t => {
  const { auth, user, socket, intervals } = dashboard(t);
  let updates = 0;
  socket.on('state', () => updates++);
  auth.updateUser(user.id, { expiresAt: Date.now() - 1000 });
  intervals[0]();
  assert.equal(socket.disconnected, true);
  assert.equal(updates, 0);
});
