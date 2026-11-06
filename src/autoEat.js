'use strict';
/**
 * Auto Eat als eigenstaendiges Modul.
 *
 * Laeuft mit eigenem Timer, unabhaengig von Mining-/Angel-Aufgaben, Drop-Items und der
 * Physik-Schleife. Es braucht nur den Bot und die Einstellungen `autoEat` (an/aus) und
 * `autoEatThreshold` (isst, wenn der Hunger darunter liegt).
 */

// Nie automatisch essen: schaden, teleportieren oder sind zu wertvoll.
const NEVER_EAT = new Set([
  'pufferfish', 'spider_eye', 'poisonous_potato', 'rotten_flesh', 'chicken',
  'chorus_fruit', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'ominous_bottle',
]);

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/**
 * Waehlt das passendste Essen: das kleinste, das den fehlenden Hunger voll auffuellt;
 * reicht keines, das mit den meisten Hungerpunkten.
 */
function pickFood(items, registry, food) {
  const foods = (registry && registry.foods) || {};
  const missing = 20 - (Number.isFinite(food) ? food : 0);
  const candidates = (items || [])
    .filter((item) => item && !NEVER_EAT.has(item.name) && foods[item.type])
    .map((item) => ({ item, points: Number(foods[item.type].foodPoints) || 0 }))
    .filter((c) => c.points > 0);
  if (!candidates.length) return null;
  const fitting = candidates.filter((c) => c.points >= missing).sort((a, b) => a.points - b.points);
  if (fitting.length) return fitting[0].item;
  return candidates.sort((a, b) => b.points - a.points)[0].item;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Startet Auto Eat fuer einen Bot.
 * @param {object} bot  Mineflayer-Bot
 * @param {object} opts getSettings(): {autoEat, autoEatThreshold}; canRun(): false = gerade nicht essen;
 *                      log(text, level); intervalMs
 * @returns {{stop: Function, tick: Function}}
 */
function startAutoEat(bot, opts = {}) {
  const getSettings = opts.getSettings || (() => ({}));
  const canRun = opts.canRun || (() => true);
  const log = opts.log || (() => {});
  let busy = false;
  let stopped = false;
  let cooldownUntil = 0;
  let lastNoFoodLog = 0;

  async function tick() {
    if (busy || stopped) return;
    const settings = getSettings() || {};
    if (settings.autoEat === false) return;
    if (!bot.entity || bot.isAlive === false || bot.food == null) return;
    const threshold = clamp(Number(settings.autoEatThreshold) || 14, 1, 20);
    if (bot.food >= threshold) return;
    if (Date.now() < cooldownUntil || !canRun() || bot.currentWindow) return;

    const food = pickFood(bot.inventory.items(), bot.registry, bot.food);
    if (!food) {
      if (Date.now() - lastNoFoodLog > 60000) { lastNoFoodLog = Date.now(); log('Auto Eat: no suitable food in the inventory', 'warn'); }
      return;
    }

    busy = true;
    const previous = bot.heldItem;
    try {
      await bot.equip(food, 'hand');
      await withTimeout(bot.consume(), 5000, 'Eating took too long');
      log(`Auto Eat: ate ${food.name}`, 'info');
    } catch (e) {
      cooldownUntil = Date.now() + 5000;
      try { bot.deactivateItem(); } catch { /* egal */ }
      log(`Auto Eat: ${e && e.message ? e.message : e}`, 'warn');
    } finally {
      busy = false;
      // Vorher gehaltenes Item (z.B. Spitzhacke) wieder in die Hand nehmen.
      if (previous && !stopped) {
        try {
          const again = bot.inventory.items().find((i) => i.name === previous.name && (i.durabilityUsed || 0) === (previous.durabilityUsed || 0))
            || bot.inventory.items().find((i) => i.name === previous.name);
          if (again && !(bot.heldItem && bot.heldItem.name === previous.name)) await bot.equip(again, 'hand');
        } catch { /* der naechste Job holt sich sein Werkzeug selbst */ }
      }
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, opts.intervalMs || 1000);
  if (typeof timer.unref === 'function') timer.unref();
  const stop = () => { stopped = true; clearInterval(timer); };
  if (typeof bot.once === 'function') bot.once('end', stop);
  return { stop, tick };
}

module.exports = { startAutoEat, pickFood, NEVER_EAT };
