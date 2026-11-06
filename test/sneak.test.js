'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BotWorker } = require('../src/botWorker');
const { BotManager } = require('../src/botManager');
const { authorizeAction } = require('../src/access');

// Minimaler Bot mit echtem Steuerungsverhalten (setControlState/clearControlStates wie in Mineflayer)
function makeBot() {
  const bot = new EventEmitter();
  const state = { forward: false, sneak: false };
  bot.packets = [];
  bot.isAlive = true;
  bot.entity = {};
  bot.setControlState = (k, v) => { if (state[k] === v) return; state[k] = v; if (k === 'sneak') bot.packets.push(v); };
  bot.getControlState = (k) => state[k];
  bot.clearControlStates = () => { for (const k of Object.keys(state)) bot.setControlState(k, false); };
  return bot;
}

function setup(sneak) {
  const settings = { sneak };
  const m = { log() {}, touch() {}, accountNames: {}, settings: {}, msa: new Map(), connection: {}, getBotSettings: () => settings };
  const w = new BotWorker(m, 'TestBot');
  const bot = makeBot();
  w.bot = bot;
  w.spawned = true;
  bot.on('physicsTick', () => { if (w.bot === bot) w.applySneak(); });
  return { w, bot, settings };
}

test('sneak on: enforced on the next physics tick', () => {
  const { bot } = setup(true);
  assert.equal(bot.getControlState('sneak'), false);
  bot.emit('physicsTick');
  assert.equal(bot.getControlState('sneak'), true);
  assert.deepEqual(bot.packets, [true], 'genau ein Sneak-Paket, kein Dauerfeuer');
  bot.emit('physicsTick'); bot.emit('physicsTick');
  assert.deepEqual(bot.packets, [true]);
});

test('sneak survives pathfinder resets, death and respawn (clearControlStates)', () => {
  const { w, bot } = setup(true);
  bot.emit('physicsTick');
  bot.clearControlStates(); // z.B. pathfinder.stop() oder Tod
  assert.equal(bot.getControlState('sneak'), false);
  bot.emit('physicsTick');
  assert.equal(bot.getControlState('sneak'), true);
});

test('sneak off: never touches the control state, and turning it off releases it', () => {
  const { w, bot, settings } = setup(false);
  bot.emit('physicsTick');
  assert.deepEqual(bot.packets, []);
  settings.sneak = true;
  bot.emit('physicsTick');
  assert.equal(bot.getControlState('sneak'), true);
  settings.sneak = false;
  w.applySneak();
  assert.equal(bot.getControlState('sneak'), false);
  assert.deepEqual(bot.packets, [true, false]);
});

test('a dead or disconnected bot is left alone', () => {
  const { w, bot } = setup(true);
  bot.isAlive = false;
  w.applySneak();
  assert.deepEqual(bot.packets, []);
  bot.isAlive = true;
  w.bot = null;
  assert.doesNotThrow(() => w.applySneak());
  w.bot = bot; w.spawned = false;
  w.applySneak();
  assert.deepEqual(bot.packets, []);
});

test('manager stores the setting per bot, applies it at once, and only admins may change it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sneak-mgr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ accountNames: { Acc1: 'Steve', Acc2: 'Alex' }, names: ['Acc1', 'Acc2'] }));

  const m1 = new BotManager({ dataDir: dir });
  const bot = makeBot();
  const w1 = m1.workers.get('Acc1');
  w1.bot = bot; w1.spawned = true;

  m1.setBotSneak('Acc1', true);
  assert.equal(bot.getControlState('sneak'), true, 'sofort angewendet');
  assert.equal(m1.workers.get('Acc2').wantSneak(), false, 'andere Bots bleiben unberuehrt');
  assert.throws(() => m1.setBotSneak('Nope', true), /Unknown bot/);

  const m2 = new BotManager({ dataDir: dir }); // neu geladen
  assert.equal(m2.workers.get('Acc1').wantSneak(), true);
  assert.equal(m2.snapshot().bots.find((b) => b.name === 'Acc1').sneak, true);
  assert.equal(m2.snapshot().bots.find((b) => b.name === 'Acc2').sneak, false);

  // Sneak und Todes-Einstellungen ueberschreiben sich nicht gegenseitig
  m2.setBotDeathSettings('Acc1', { commandEnabled: true, command: '/home', delaySec: 1 });
  assert.equal(m2.workers.get('Acc1').wantSneak(), true);
  m2.setBotSneak('Acc1', false);
  assert.equal(m2.getBotSettings('Acc1').death.command, '/home');

  const owner = { role: 'user', botNames: ['Acc1'] };
  assert.throws(() => authorizeAction(owner, 'set_bot_sneak', { name: 'Acc1' }, () => true), /Only the admin/);
  assert.doesNotThrow(() => authorizeAction({ role: 'admin' }, 'set_bot_sneak', {}, () => true));
});
