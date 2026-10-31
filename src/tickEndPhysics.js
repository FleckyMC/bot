'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let cachedPlugin;

// Backport https://github.com/PrismarineJS/mineflayer/pull/4137 to the
// locked Mineflayer 4.39.0. Compile its installed physics module in memory,
// preserving its relative imports. No node_modules files are changed.
function getPhysicsPlugin() {
  if (cachedPlugin) return cachedPlugin;
  const filename = require.resolve('mineflayer/lib/plugins/physics');
  const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
  // A newer/already patched installation must not send tick_end twice.
  if (/\.write\(\s*['"]tick_end['"]/.test(source)) {
    return (cachedPlugin = require(filename));
  }
  const original = `  function tickPhysics (now) {
    if (bot._client.state !== 'play') return // do nothing outside of the play state (e.g. server transfer configuration phase)
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return // entity not ready
    if (bot.blockAt(bot.entity.position) == null) return // check if chunk is unloaded
    if (bot.physicsEnabled && shouldUsePhysics) {
      physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (shouldUsePhysics) {
      updatePosition(now)
    }
  }`;
  const replacement = `  const sendsTickEnd = bot.supportFeature('sendsClientTickEndPacket')
  function tickPhysics (now) {
    if (bot._client.state !== 'play') return
    if (!bot.entity?.position || !Number.isFinite(bot.entity.position.x)) return
    if (bot.blockAt(bot.entity.position) != null) {
      if (bot.physicsEnabled && shouldUsePhysics) {
        physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot)
        bot.emit('physicsTick')
        bot.emit('physicTick')
      }
      if (shouldUsePhysics) updatePosition(now)
    }
    if (sendsTickEnd) bot._client.write('tick_end', {})
  }`;
  if (source.split(original).length !== 2) {
    throw new Error('Unsupported Mineflayer physics module. Restore dependencies with npm ci; the tick_end backport expects the locked 4.39.0 source.');
  }
  let patchedSource = source.replace(original, replacement);
  // Mineflayer schaltet die Physik bei Tod/Respawn/Dimensionswechsel ab und erst mit dem
  // naechsten Positionspaket des Servers wieder an. Bleibt das aus, steht der Bot ohne
  // Physik (kein Knockback, kein Wegschieben). Dieser Haken erlaubt, sie notfalls wieder
  // einzuschalten (siehe BotWorker#ensurePhysics). Fehlt die Zielzeile, bleibt alles wie es ist.
  const hookAnchor = '  let respawnTimer = 0\n';
  if (patchedSource.includes(hookAnchor)) {
    patchedSource = patchedSource.replace(hookAnchor, `${hookAnchor}  bot._forcePhysicsOn = () => { shouldUsePhysics = true }\n`);
  }
  const patched = new Module(filename, module);
  patched.filename = filename;
  patched.paths = Module._nodeModulePaths(path.dirname(filename));
  patched._compile(patchedSource, filename);
  cachedPlugin = patched.exports;
  return cachedPlugin;
}

module.exports = { getPhysicsPlugin };
