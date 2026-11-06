'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BotWorker } = require('../src/botWorker');

function setup(slots) {
  const logs = [];
  const m = { log: (n, text, level) => logs.push({ text, level }), touch() {}, accountNames: {}, settings: {}, msa: new Map(), connection: {}, getBotSettings: () => ({}) };
  const w = new BotWorker(m, 'Dropper');
  const clicks = [];
  const bot = { inventory: { slots: [] }, clickWindow: async (slot, button, mode) => { clicks.push([slot, button, mode]); } };
  for (const [slot, name, count] of slots) bot.inventory.slots[slot] = { name, count };
  w.bot = bot; w.spawned = true;
  return { w, bot, clicks, logs };
}

test('drops a whole stack with one click and part of a stack one item at a time', async () => {
  const { w, clicks } = setup([[9, 'cobblestone', 64], [36, 'diamond', 5]]);
  const total = await w.dropFromSlots([{ slot: 9, name: 'cobblestone', count: 'all' }, { slot: 36, name: 'diamond', count: 2 }]);
  assert.equal(total, 66);
  assert.deepEqual(clicks, [[9, 1, 4], [36, 0, 4], [36, 0, 4]]);
});

test('validates before dropping anything: stale names, amounts, slots', async () => {
  const { w, clicks } = setup([[9, 'stone', 3], [10, 'dirt', 3]]);
  await assert.rejects(w.dropFromSlots([{ slot: 10, name: 'dirt', count: 1 }, { slot: 9, name: 'gold_ingot', count: 1 }]), /no longer contains/);
  await assert.rejects(w.dropFromSlots([{ slot: 9, name: 'stone', count: 4 }]), /only has 3/);
  await assert.rejects(w.dropFromSlots([{ slot: 9, name: 'stone', count: 0 }]), /Invalid amount/);
  await assert.rejects(w.dropFromSlots([{ slot: 2, name: 'stone', count: 1 }]), /Invalid inventory slot/);
  await assert.rejects(w.dropFromSlots([{ slot: 20, name: 'stone', count: 1 }]), /is empty/);
  await assert.rejects(w.dropFromSlots([]), /at least one/);
  assert.deepEqual(clicks, []);
});

test('drop everything covers all stacks; equipped slots can be skipped', async () => {
  const { w, clicks } = setup([[5, 'iron_helmet', 1], [9, 'stone', 64], [44, 'bread', 3], [45, 'shield', 1]]);
  await w.dropEverything({ includeEquipped: false });
  assert.deepEqual(clicks.map((c) => c[0]), [9, 44]);
  clicks.length = 0;
  await w.dropEverything();
  assert.deepEqual(clicks.map((c) => c[0]), [5, 9, 44, 45]);
  const { w: empty } = setup([]);
  await assert.rejects(empty.dropEverything(), /already empty/);
});

test('refuses when the bot is offline', async () => {
  const { w } = setup([[9, 'stone', 1]]);
  w.spawned = false;
  await assert.rejects(w.dropFromSlots([{ slot: 9, name: 'stone', count: 1 }]), /not connected/);
});

test('moves and swaps stacks between slots, validating first', async () => {
  const { w, bot } = setup([[9, 'cobblestone', 64], [36, 'diamond', 5]]);
  const moves = [];
  bot.moveSlotItem = async (a, b) => { moves.push([a, b]); };
  await w.moveItem({ from: 9, to: 20, name: 'cobblestone' });
  await w.moveItem({ from: 36, to: 9 });
  assert.deepEqual(moves, [[9, 20], [36, 9]]);
  await assert.rejects(w.moveItem({ from: 9, to: 9 }), /different slot/);
  await assert.rejects(w.moveItem({ from: 2, to: 9 }), /Invalid inventory slot/);
  await assert.rejects(w.moveItem({ from: 9, to: 99 }), /Invalid inventory slot/);
  await assert.rejects(w.moveItem({ from: 11, to: 12 }), /is empty/);
  await assert.rejects(w.moveItem({ from: 9, to: 10, name: 'dirt' }), /no longer contains/);
  assert.equal(moves.length, 2);
});
