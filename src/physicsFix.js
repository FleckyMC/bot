'use strict';
/**
 * Physik-Korrekturen fuer Minecraft 1.21.9+ (u.a. 1.21.11) mit Mineflayer.
 *
 * 1) Knockback / Server-Velocity
 *    Ab 1.21.9 senden `entity_velocity` und `spawn_entity` die Geschwindigkeit als
 *    `lpVec3` - bereits in Bloecken pro Tick. Mineflayer (4.39) rechnet aber noch mit dem
 *    alten Format (int16 / 8000) und teilt den Wert nochmals durch 8000. Ergebnis: Jeder
 *    Knockback ist ~8000x zu klein, die Bots wirken, als haetten sie keine Physik.
 *    Wir ueberschreiben die Velocity direkt nach Mineflayers Handler mit dem korrekten Wert.
 *
 * 2) Spieler-Kollision (Anstupsen)
 *    Der Vanilla-Client berechnet das gegenseitige Wegdruecken ueberlappender Spieler selbst
 *    (LivingEntity#pushEntities -> Entity#push); der Server schickt dafuer keine Velocity.
 *    Mineflayer hat das nicht, also bilden wir es hier 1:1 nach.
 */
const { Vec3 } = require('vec3');

const PUSH_STRENGTH = 0.05;

/** true, wenn das Protokoll die Velocity als lpVec3 (Bloecke/Tick) uebertraegt. */
function usesLpVelocity(bot) {
  try {
    const types = bot.registry.protocol.play.toClient.types;
    const fields = types.packet_entity_velocity[1];
    const field = fields.find((f) => f.name === 'velocity');
    return !!field && field.type === 'lpVec3';
  } catch {
    return false;
  }
}

function setVelocity(entity, v) {
  if (!entity || !entity.velocity || !v) return;
  const { x, y, z } = v;
  if (![x, y, z].every(Number.isFinite)) return;
  entity.velocity.set(x, y, z);
}

function overlaps(a, b) {
  const ahw = (a.width || 0.6) / 2;
  const bhw = (b.width || 0.6) / 2;
  const ah = a.height || 1.8;
  const bh = b.height || 1.8;
  return Math.abs(a.position.x - b.position.x) < ahw + bhw
    && Math.abs(a.position.z - b.position.z) < ahw + bhw
    && a.position.y < b.position.y + bh
    && b.position.y < a.position.y + ah;
}

/**
 * Entspricht Entity#push(other) aus Vanilla, angewendet auf `me` (die "other"-Seite):
 * Gibt den Schubvektor zurueck, den `me` von `from` bekommt (oder null).
 */
function pushVector(me, from) {
  let dx = me.position.x - from.position.x;
  let dz = me.position.z - from.position.z;
  let max = Math.max(Math.abs(dx), Math.abs(dz));
  if (!(max >= 0.01)) return null;
  max = Math.sqrt(max);
  dx /= max;
  dz /= max;
  const scale = Math.min(1, 1 / max);
  dx *= scale * PUSH_STRENGTH;
  dz *= scale * PUSH_STRENGTH;
  return new Vec3(dx, 0, dz);
}

function isPushable(entity) {
  if (!entity || entity.type !== 'player' || !entity.position) return false;
  if (entity.gameMode === 'spectator' || entity.gameMode === 3) return false;
  if (entity.vehicle) return false;
  return true;
}

function applyEntityPush(bot) {
  const me = bot.entity;
  if (!me || !me.position || !me.velocity) return 0;
  if (bot.game && (bot.game.gameMode === 'spectator' || bot.game.gameMode === 3)) return 0;
  if (me.vehicle) return 0;
  let pushed = 0;
  for (const other of Object.values(bot.entities || {})) {
    if (!other || other === me || other.id === me.id) continue;
    if (!isPushable(other) || !overlaps(me, other)) continue;
    const push = pushVector(me, other);
    if (!push) continue;
    me.velocity.x += push.x;
    me.velocity.z += push.z;
    pushed++;
  }
  return pushed;
}

function installPhysicsFixes(bot, log = () => {}, options = {}) {
  if (!bot || bot.__physicsFixInstalled) return;
  bot.__physicsFixInstalled = true;

  // Mineflayer injiziert seine Plugins (und damit seine eigenen entity_velocity/spawn_entity-Handler)
  // erst nach `createBot()`, bei 'inject_allowed'. Erst dann gibt es auch bot.registry.
  // Unsere Listener muessen NACH denen von Mineflayer registriert werden, sonst ueberschreibt
  // Mineflayer unseren Wert wieder mit dem falschen (/8000) Wert.
  const installVelocityFix = () => {
    const client = bot._client;
    if (!client || !usesLpVelocity(bot)) return;
    let loggedFirstHit = false;
    client.on('entity_velocity', (packet) => {
      if (!packet) return;
      const entity = bot.entities[packet.entityId];
      setVelocity(entity, packet.velocity);
      if (!loggedFirstHit && bot.entity && packet.entityId === bot.entity.id) {
        loggedFirstHit = true;
        const v = packet.velocity || {};
        log(`Knockback empfangen: vx=${(+v.x).toFixed(3)} vy=${(+v.y).toFixed(3)} vz=${(+v.z).toFixed(3)} (Bloecke/Tick)`, 'info');
      }
    });
    client.on('spawn_entity', (packet) => {
      if (!packet || !packet.velocity) return;
      setVelocity(bot.entities[packet.entityId], packet.velocity);
    });
    log('Physik-Fix aktiv: Knockback nutzt lpVec3-Velocity (Bloecke/Tick)', 'info');
  };
  // plugin_loader registriert sein 'inject_allowed' vor uns -> unser Handler laeuft nach den Plugins.
  bot.once('inject_allowed', installVelocityFix);

  if (options.entityPush !== false) {
    bot.on('physicsTick', () => {
      if (typeof options.enabled === 'function' && !options.enabled()) return;
      applyEntityPush(bot);
    });
  }
}

module.exports = { installPhysicsFixes, usesLpVelocity, applyEntityPush, pushVector, overlaps };
