'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const minecraftData = require('minecraft-data');
const [readLpVec3, writeLpVec3] = require('minecraft-protocol/src/datatypes/lpVec3');
const { installPhysicsFixes, usesLpVelocity, applyEntityPush, pushVector, overlaps } = require('../src/physicsFix');

const FROM_NOTCH_VEL = 1 / 8000; // Mineflayers alter Umrechnungsfaktor (conversions.js)

function makeEntity(id, x, y, z, extra = {}) {
  return { id, type: 'player', position: new Vec3(x, y, z), velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.8, ...extra };
}

function makeBot(version = '1.21.11') {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.registry = minecraftData(version);
  const me = makeEntity(1, 0, 64, 0);
  bot.entity = me;
  bot.entities = { 1: me };
  bot.game = { gameMode: 'survival' };
  // Mineflayers Handler (wie in lib/plugins/entities.js, vor unserem registriert)
  bot._client.on('entity_velocity', (packet) => {
    const e = bot.entities[packet.entityId];
    e.velocity.update(new Vec3(packet.velocity.x * FROM_NOTCH_VEL, packet.velocity.y * FROM_NOTCH_VEL, packet.velocity.z * FROM_NOTCH_VEL));
  });
  return bot;
}

function roundTrip(v) {
  const buf = Buffer.alloc(16);
  const end = writeLpVec3(v, buf, 0);
  return readLpVec3(buf, 0).value && { value: readLpVec3(buf, 0).value, size: end };
}

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// --- Protokoll-Erkennung
assert.strictEqual(usesLpVelocity(makeBot('1.21.11')), true, '1.21.11 nutzt lpVec3');
assert.strictEqual(usesLpVelocity(makeBot('1.20.4')), false, '1.20.4 nutzt altes Format');

// --- Bug-Reproduktion: ohne Fix ist der Knockback praktisch null
{
  const bot = makeBot();
  const knock = roundTrip({ x: 0.4, y: 0.36, z: -0.25 }).value;
  near(knock.x, 0.4); // der Decoder liefert bereits Bloecke/Tick
  bot._client.emit('entity_velocity', { entityId: 1, velocity: knock });
  assert.ok(Math.abs(bot.entity.velocity.x) < 1e-4, 'Ohne Fix: Knockback ~8000x zu klein');

  // --- Mit Fix
  const fixed = makeBot();
  installPhysicsFixes(fixed);
  fixed.emit('inject_allowed');
  fixed._client.emit('entity_velocity', { entityId: 1, velocity: knock });
  near(fixed.entity.velocity.x, 0.4);
  near(fixed.entity.velocity.y, 0.36);
  near(fixed.entity.velocity.z, -0.25);
}

// --- Altes Protokoll bleibt unangetastet
{
  const bot = makeBot('1.20.4');
  installPhysicsFixes(bot);
  bot.emit('inject_allowed');
  bot._client.emit('entity_velocity', { entityId: 1, velocity: { x: 3200, y: 2880, z: 0 } });
  near(bot.entity.velocity.x, 0.4);
  near(bot.entity.velocity.y, 0.36);
}

// --- Spieler-Kollision
{
  const a = makeEntity(1, 0, 64, 0);
  assert.ok(overlaps(a, makeEntity(2, 0.4, 64, 0)), 'Hitboxen ueberlappen');
  assert.ok(!overlaps(a, makeEntity(2, 0.7, 64, 0)), 'Knapp daneben (Breite 0.6)');
  assert.ok(!overlaps(a, makeEntity(2, 0.2, 66, 0)), 'Anderer Spieler ueber dem Kopf');

  const p = pushVector(a, makeEntity(2, 0.4, 64, 0));
  assert.ok(p.x < 0 && p.z === 0, 'Schub weg vom anderen Spieler');
  assert.ok(p.x >= -0.05 - 1e-12, 'max. 0.05 pro Tick (Vanilla)');
  assert.strictEqual(pushVector(a, makeEntity(2, 0.005, 64, 0.005)), null, 'Exakt uebereinander: kein Schub');

  const bot = makeBot();
  installPhysicsFixes(bot);
  bot.entities[2] = makeEntity(2, 0.4, 64, 0.1);
  bot.entities[3] = { id: 3, type: 'zombie', position: new Vec3(0.2, 64, 0), velocity: new Vec3(), width: 0.6, height: 1.95 };
  bot.entities[4] = makeEntity(4, 0.1, 64, 0.1, { gameMode: 'spectator' });
  bot.emit('physicsTick');
  assert.ok(bot.entity.velocity.x < 0, 'Bot wird von Spieler 2 weggedrueckt');
  assert.ok(bot.entity.velocity.z < 0);
  const vx = bot.entity.velocity.x;
  near(vx, -0.05 * 0.4 / Math.sqrt(0.4) / Math.sqrt(0.4) * 1, 0.05); // Groessenordnung: <= 0.05
  assert.ok(Math.abs(vx) <= 0.05, 'Zombie/Spectator schieben nicht');

  bot.game.gameMode = 'spectator';
  const before = bot.entity.velocity.x;
  bot.emit('physicsTick');
  assert.strictEqual(bot.entity.velocity.x, before, 'Spectator wird nicht geschoben');

  assert.strictEqual(applyEntityPush(makeBot()), 0);
}

// --- Integration mit ECHTEM Mineflayer: Reihenfolge der Listener (inject_allowed) ist entscheidend
(async () => {
  const mineflayer = require('mineflayer');
  
  const client = new EventEmitter();
  client.version = '1.21.11';
  client.state = 'play';
  client.write = () => {};
  client.end = () => {};
  client.registerChannel = () => {};
  const bot = mineflayer.createBot({ client, username: 'Test', version: '1.21.11', hideErrors: true });
  bot.on('error', () => {});
  const logs = [];
  installPhysicsFixes(bot, (m) => logs.push(m)); // genau wie in botWorker.js: direkt nach createBot
  await new Promise((r) => setTimeout(r, 50)); // inject_allowed + Plugin-Injektion abwarten

  assert.ok(logs.some((l) => l.includes('Physik-Fix aktiv')), 'Fix muss nach Plugin-Start aktiv werden');
  const Entity = require('prismarine-entity')(bot.registry);
  const e = new Entity(7);
  bot.entities[7] = e;
  bot.entity = e;
  const knock = roundTrip({ x: 0.4, y: 0.36, z: -0.25 }).value;
  client.emit('entity_velocity', { entityId: 7, velocity: knock });
  near(e.velocity.x, 0.4);
  near(e.velocity.y, 0.36);
  near(e.velocity.z, -0.25);
  assert.ok(logs.some((l) => l.startsWith('Knockback empfangen')), 'erster Treffer wird geloggt');

  console.log('physicsFix.test.js: OK');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
