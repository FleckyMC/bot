'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startAutoEat, pickFood } = require('../src/autoEat');

const registry = require('prismarine-registry')('1.21.11');
const item = (name, count = 1) => ({ name, count, type: registry.itemsByName[name].id, slot: 36 });

function fakeBot({ food = 8, items = [], held = null } = {}) {
  const bot = new EventEmitter();
  bot.registry = registry;
  bot.entity = {};
  bot.isAlive = true;
  bot.food = food;
  bot.heldItem = held;
  bot.currentWindow = null;
  bot.equipped = [];
  bot.eaten = 0;
  bot.inventory = { items: () => items };
  bot.equip = async (it, dest) => { bot.equipped.push([it.name, dest]); bot.heldItem = it; };
  bot.consume = async () => { bot.eaten++; };
  bot.deactivateItem = () => {};
  return bot;
}

test('pickFood never picks dangerous or valuable foods', () => {
  const items = [item('pufferfish'), item('rotten_flesh'), item('chicken'), item('golden_apple'), item('spider_eye')];
  assert.equal(pickFood(items, registry, 5), null);
  assert.equal(pickFood([...items, item('bread')], registry, 5).name, 'bread');
});

test('pickFood prefers the smallest food that fills the missing hunger', () => {
  const items = [item('cooked_beef'), item('bread'), item('apple')];
  // fehlt 4 Punkte: Brot (5) reicht, Apfel (4) reicht knapp -> Apfel ist das kleinste passende
  assert.equal(pickFood(items, registry, 16).name, 'apple');
  // fehlt 12 Punkte: nichts reicht allein -> das mit den meisten Punkten
  assert.equal(pickFood(items, registry, 8).name, 'cooked_beef');
});

test('eats when hunger is below the threshold, independent of any task', async () => {
  const bot = fakeBot({ food: 8, items: [item('bread')] });
  const logs = [];
  const eat = startAutoEat(bot, { getSettings: () => ({ autoEat: true, autoEatThreshold: 14 }), log: (t) => logs.push(t), intervalMs: 1e9 });
  await eat.tick();
  eat.stop();
  assert.equal(bot.eaten, 1);
  assert.deepEqual(bot.equipped[0], ['bread', 'hand']);
  assert.ok(logs.some((l) => /bread/.test(l)));
});

test('does nothing when disabled, full enough, dead, busy or with a window open', async () => {
  const cases = [
    [{ food: 8 }, { autoEat: false }, () => true],
    [{ food: 18 }, { autoEat: true, autoEatThreshold: 14 }, () => true],
    [{ food: 8 }, { autoEat: true }, () => false],
  ];
  for (const [botOpts, settings, canRun] of cases) {
    const bot = fakeBot({ ...botOpts, items: [item('bread')] });
    const eat = startAutoEat(bot, { getSettings: () => settings, canRun, intervalMs: 1e9 });
    await eat.tick(); eat.stop();
    assert.equal(bot.eaten, 0);
  }
  const dead = fakeBot({ food: 8, items: [item('bread')] });
  dead.isAlive = false;
  const e1 = startAutoEat(dead, { getSettings: () => ({}), intervalMs: 1e9 });
  await e1.tick(); e1.stop();
  assert.equal(dead.eaten, 0);
  const windowOpen = fakeBot({ food: 8, items: [item('bread')] });
  windowOpen.currentWindow = {};
  const e2 = startAutoEat(windowOpen, { getSettings: () => ({}), intervalMs: 1e9 });
  await e2.tick(); e2.stop();
  assert.equal(windowOpen.eaten, 0);
});

test('puts the previously held tool back after eating', async () => {
  const pick = { ...item('diamond_pickaxe'), durabilityUsed: 10 };
  const bot = fakeBot({ food: 8, items: [item('bread'), pick], held: pick });
  const eat = startAutoEat(bot, { getSettings: () => ({}), intervalMs: 1e9 });
  await eat.tick(); eat.stop();
  assert.deepEqual(bot.equipped.map((e) => e[0]), ['bread', 'diamond_pickaxe']);
});

test('reports missing food once and a failing meal triggers a cooldown, not a loop', async () => {
  const none = fakeBot({ food: 8, items: [] });
  const logs = [];
  const e1 = startAutoEat(none, { getSettings: () => ({}), log: (t, l) => logs.push([t, l]), intervalMs: 1e9 });
  await e1.tick(); await e1.tick(); e1.stop();
  assert.equal(logs.filter(([, l]) => l === 'warn').length, 1);

  const failing = fakeBot({ food: 8, items: [item('bread')] });
  failing.consume = async () => { throw new Error('kaputt'); };
  const e2 = startAutoEat(failing, { getSettings: () => ({}), log: () => {}, intervalMs: 1e9 });
  await e2.tick(); await e2.tick(); e2.stop();
  assert.equal(failing.equipped.filter((e) => e[0] === 'bread').length, 1, 'zweiter Versuch wartet den Cooldown ab');
});

test('stops its timer when the bot ends', async () => {
  const bot = fakeBot({ food: 8, items: [item('bread')] });
  startAutoEat(bot, { getSettings: () => ({}), intervalMs: 20 });
  bot.emit('end');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(bot.eaten, 0);
});
