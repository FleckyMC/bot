'use strict';
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { inside } = require('./planner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
const AIR = new Set(['air', 'cave_air', 'void_air']);
const LIQUIDISH = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const FLUID = new Set(['water', 'lava']);
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OFFHAND_SLOT = 45;

function remaining(item) {
  if (!item || !item.maxDurability) return null;
  return item.maxDurability - (item.durabilityUsed || 0);
}

function tierOf(name) {
  const i = TIERS.indexOf(name.replace('_pickaxe', ''));
  return i;
}

function hasMending(item) {
  if (!item) return false;
  if (Array.isArray(item.enchants) && item.enchants.some((e) => /mending/i.test(String(e.name || e.enchant || '')))) return true;
  // Item NBT layout differs between protocol versions; inspect serialized NBT defensively.
  try { return /mending/i.test(JSON.stringify(item.nbt || null)); } catch { return false; }
}

class BotWorker {
  constructor(manager, name) {
    this.m = manager;
    this.name = name;
    this.authMethod = 'microsoft';
    this.bot = null;
    this.spawned = false;
    this.status = 'offline';
    this.detail = '';
    this.wantConnected = false;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.region = null;
    this.job = null;
    this.jobPromise = Promise.resolve();
    this.stats = { mined: 0, bottles: 0 };
    this.autoEatBusy = false;
    this.lastAutomationAt = 0;
    this.profile = 'idle';
    this.profileOptions = {};
    this.resetCursor();
  }

  // ---------------------------------------------------------------- Verbindung

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    this.m.touch();
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    if (this.bot) return;
    const m = this.m;
    const c = m.connection;
    this.serverAddress = { host: c.host, port: c.port || 25565 };
    this.wantConnected = true;
    this.setStatus('connecting', 'Verbinde...');

    const safe = this.name.replace(/[^A-Za-z0-9_.@-]/g, '_');
    let bot;
    try {
      bot = mineflayer.createBot({
        host: c.host,
        port: c.port || 25565,
        username: this.name,
        ...(m.version && m.version !== 'auto' ? { version: m.version } : {}),
        auth: 'microsoft',
        profilesFolder: this.profileDir || path.join(m.dataDir, 'profiles', safe),
        onMsaCode: (data) => m.setMsa(this.name, data),
        viewDistance: 'short',
        checkTimeoutInterval: 60000,
        hideErrors: true,
      });
    } catch (e) {
      m.log(this.name, `Start fehlgeschlagen: ${e.message}`, 'error');
      this.setStatus('error', e.message);
      return;
    }
    this.bot = bot;
    // Keep Mineflayer's normal server-authoritative player physics enabled.
    // Knockback/velocity comes from the Minecraft server; don't pin the entity in place.
    bot.physicsEnabled = true;
    bot.loadPlugin(pathfinder);
    this.setupAutomation(bot);

    bot.once('spawn', () => {
      if (this.bot !== bot) return;
      this.spawned = true;
      this.newAccountSignIn = false;
      this.attempts = 0;
      if (bot.username && bot.username !== this.accountName) {
        this.accountName = bot.username;
        this.m.accountNames[this.name] = bot.username;
        this.m.save();
      }
      m.clearMsa(this.name);
      this.setupMovements();
      m.log(this.name, 'Verbunden und gespawnt', 'info');
      this.setStatus('idle', 'Bereit');
      if (m.mining && this.region) this.startJob();
      else if (this.profile !== 'idle') this.startProfile(this.profile, this.profileOptions || {});
    });

    bot.on('messagestr', (msg, pos) => {
      if (pos === 'game_info' || !msg) return;
      m.log(this.name, msg, 'chat');
    });

    bot.on('death', () => m.log(this.name, 'Bot ist gestorben und respawnt', 'warn'));

    bot.on('kicked', (reason) => {
      let text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      try {
        const ChatMessage = require('prismarine-chat')(bot.registry);
        text = ChatMessage.fromNotch(reason).toString() || text;
      } catch { /* Rohtext reicht */ }
      m.log(this.name, `Gekickt: ${String(text).slice(0, 300)}`, 'warn');
    });

    bot.on('error', (e) => m.log(this.name, `Fehler: ${e && e.message ? e.message : e}`, 'error'));

    bot.on('end', (reason) => {
      if (this.bot !== bot) return;
      this.bot = null;
      this.spawned = false;
      this.cancelJob();
      m.log(this.name, `Verbindung getrennt (${reason || 'unbekannt'})`, 'warn');
      if (!this.wantConnected) { this.setStatus('offline'); return; }
      this.attempts++;
      if (this.attempts > 5) {
        this.wantConnected = false;
        this.setStatus('error', 'Connection failed after 5 attempts. Check the server address, version, and account access.');
        m.log(this.name, 'Stopped reconnecting after 5 failed attempts', 'error');
        return;
      }
      const delay = Math.min(60000, 5000 * 2 ** Math.min(this.attempts - 1, 4));
      this.setStatus('reconnecting', `Retrying in ${Math.round(delay / 1000)}s (attempt ${this.attempts}/5)`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  disconnect() {
    this.wantConnected = false;
    clearTimeout(this.reconnectTimer);
    this.cancelJob();
    const bot = this.bot;
    this.bot = null;
    this.spawned = false;
    if (bot) { try { bot.quit(); } catch { /* egal */ } }
    this.setStatus('offline');
  }

  setupMovements() {
    const bot = this.bot;
    const mv = new Movements(bot);
    mv.canDig = true;
    mv.allowSprinting = true;
    // Ausserhalb des eigenen Abschnitts wird nie etwas abgebaut (auch nicht zum Wegfinden).
    // (optional erlaubt: Einstellung "Tunnel graben", z.B. wenn der Bereich unter einer Erdschicht liegt)
    mv.exclusionAreasBreak = [(block) => {
      if (this.m.settings.allowDigOutside) return 0;
      return this.region && inside(this.region, block.position.x, block.position.y, block.position.z) ? 0 : 100;
    }];
    bot.pathfinder.setMovements(mv);
    bot.pathfinder.thinkTimeout = 8000;
  }


  setupAutomation(bot) {
    bot.on('physicsTick', async () => {
      if (this.bot !== bot || !this.spawned || this.autoEatBusy) return;
      const now = Date.now();
      if (now - this.lastAutomationAt < 1200) return;
      this.lastAutomationAt = now;
      const settings = this.m.settings || {};
      const dropNames = new Set((settings.dropItems || []).map((x) => String(x).trim().toLowerCase().replace(/^minecraft:/, '')).filter(Boolean));
      if (dropNames.size) {
        const toDrop = bot.inventory.items().find((item) => dropNames.has(item.name.toLowerCase()));
        if (toDrop) {
          this.autoEatBusy = true;
          try { await bot.tossStack(toDrop); this.m.log(this.name, `Dropped configured item: ${toDrop.name}`, 'info'); }
          catch (e) { this.m.log(this.name, `Item drop failed: ${e.message}`, 'warn'); }
          finally { this.autoEatBusy = false; }
          return;
        }
      }
      if (settings.autoEat === false || bot.food == null || bot.food >= Math.max(1, Math.min(20, Number(settings.autoEatThreshold) || 14))) return;
      const foods = bot.inventory.items().filter((item) => bot.registry.foods && bot.registry.foods[item.type]);
      if (!foods.length) return;
      const food = foods.sort((a, b) => {
        const fa = bot.registry.foods[a.type] || {}, fb = bot.registry.foods[b.type] || {};
        return (Number(fb.foodPoints) || 0) - (Number(fa.foodPoints) || 0);
      })[0];
      this.autoEatBusy = true;
      try {
        await bot.equip(food, 'hand');
        await bot.consume();
        this.m.log(this.name, `Auto Eat: ate ${food.name}`, 'info');
      } catch (e) {
        this.m.log(this.name, `Auto Eat: ${e.message}`, 'warn');
      } finally { this.autoEatBusy = false; }
    });
  }

  // ---------------------------------------------------------------- Job-Steuerung

  alive(token) {
    return !token.cancelled && this.bot && this.bot.entity && this.spawned;
  }

  startJob() {
    this.profile = 'mining';
    if (!this.bot || !this.spawned || !this.region) return;
    this.cancelJob();
    const token = { cancelled: false };
    this.job = token;
    const prev = this.jobPromise;
    this.jobPromise = (async () => {
      await prev.catch(() => {});
      if (token.cancelled) return;
      await this.runJob(token);
    })().catch((e) => {
      if (!token.cancelled) {
        this.m.log(this.name, `Job-Fehler: ${e.message}`, 'error');
        this.setStatus('error', e.message);
      }
    });
  }

  stopJob() {
    this.profile = 'idle';
    this.cancelJob();
    const bot = this.bot;
    if (bot && this.spawned) {
      try { bot.pathfinder.stop(); } catch { /* egal */ }
      try { bot.stopDigging(); } catch { /* egal */ }
      try { bot.deactivateItem(); } catch { /* egal */ }
      try { bot.clearControlStates(); } catch { /* egal */ }
      this.setStatus('idle', 'Gestoppt');
    }
  }

  cancelJob() {
    if (this.job) this.job.cancelled = true;
    this.job = null;
  }

  fail(message) {
    this.m.log(this.name, message, 'error');
    this.setStatus('error', message);
    return false;
  }

  async goto(goal, token, timeoutMs = 30000) {
    const bot = this.bot;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { bot.pathfinder.stop(); } catch { /* egal */ }
        reject(new Error('Wegfindung Zeitueberschreitung'));
      }, timeoutMs);
    });
    try {
      await Promise.race([bot.pathfinder.goto(goal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ Aufgabenprofile

  startProfile(profile, options = {}) {
    if (!this.bot || !this.spawned) throw new Error(`${this.name} ist nicht bereit`);
    if (!['afk', 'fishing', 'trading'].includes(profile)) throw new Error('Unbekanntes Aufgabenprofil');
    this.cancelJob();
    this.profile = profile;
    this.profileOptions = { ...options };
    const token = { cancelled: false };
    this.job = token;
    const prev = this.jobPromise;
    this.jobPromise = (async () => {
      await prev.catch(() => {});
      if (token.cancelled || !this.alive(token)) return;
      if (profile === 'afk') {
        this.setStatus('idle', 'AFK/Präsenz aktiv');
        // Keep controls released and periodically verify that the connection is alive.
        let lastLook = Date.now();
        while (this.alive(token)) {
          // Keine künstliche Flugsteuerung: Mineflayer/Serverphysik hält den Bot am Boden.
          // Gelegentlich den Blick leicht bewegen, ohne Bewegungstasten zu drücken.
          if (Date.now() - lastLook >= 15000) {
            try { await this.bot.look(this.bot.entity.yaw + (Math.random() - 0.5) * 0.35, this.bot.entity.pitch * 0.5, true); } catch { /* Blick ist optional */ }
            lastLook = Date.now();
          }
          await sleep(1000);
        }
      } else if (profile === 'fishing') {
        const bot = this.bot;
        const fishOptions = {
          threshold: Math.max(1, Math.min(64, Number(options.threshold ?? this.m.settings.fishingThreshold ?? 20) || 20)),
          useMending: options.useMending !== undefined ? !!options.useMending : this.m.settings.fishingUseMending !== false,
          deposit: options.deposit !== undefined ? !!options.deposit : this.m.settings.fishingDeposit !== false,
        };
        const findRods = () => bot.inventory.items().filter((it) => it.name === 'fishing_rod' && (remaining(it) === null || remaining(it) > 0));
        if (!findRods().length) return this.fail('Keine Angel im Inventar');
        this.setStatus('fishing', 'Angeln aktiv · Stop beendet die Aufgabe');
        while (this.alive(token) && !token.cancelled) {
          let rods = findRods();
          if (!rods.length) return this.fail('Keine einsatzfähige Angel mehr im Inventar');
          let rod = rods.find((it) => (remaining(it) ?? 999999) > fishOptions.threshold) || rods.sort((a,b) => (remaining(b) ?? 999999) - (remaining(a) ?? 999999))[0];
          const left = remaining(rod);
          if (left !== null && left <= fishOptions.threshold) {
            if (fishOptions.useMending && hasMending(rod)) {
              const repaired = await this.repairFishingRod(token, rod, fishOptions.threshold);
              if (!this.alive(token) || token.cancelled) return;
              rods = findRods();
              const updated = rods.find((it) => it.slot === rod.slot) || rod;
              if (!repaired || (remaining(updated) !== null && remaining(updated) <= fishOptions.threshold)) {
                const spare = rods.find((it) => it.slot !== rod.slot && (remaining(it) === null || remaining(it) > fishOptions.threshold));
                if (!spare) return this.fail('Angel unter Grenzwert; Reparatur ohne Erfolg und keine Ersatzangel vorhanden');
                rod = spare;
              } else rod = updated;
            } else {
              const spare = rods.find((it) => it.slot !== rod.slot && (remaining(it) === null || remaining(it) > fishOptions.threshold));
              if (!spare) return this.fail('Angel ohne Mending unter Grenzwert; keine Ersatzangel vorhanden');
              rod = spare;
              this.m.log(this.name, 'Wechsle auf Ersatzangel (Mending fehlt oder ist deaktiviert)', 'info');
            }
          }
          if (fishOptions.deposit && bot.inventory.emptySlotCount() <= this.m.settings.minFreeSlots) {
            if (!this.m.settings.chest) return this.fail('Inventar fast voll: zum Einlagern bitte Lagerkiste in den Einstellungen setzen');
            if (!(await this.dropoff(token))) return;
            if (!this.alive(token) || token.cancelled) return;
          }
          try {
            await bot.equip(rod, 'hand');
            this.setStatus('fishing', `Angelt · Angel ${remaining(rod) ?? '∞'} Haltbarkeit`);
            await bot.fish();
            this.stats.fishCaught = (this.stats.fishCaught || 0) + 1;
            this.m.touch();
          } catch (e) {
            if (!token.cancelled) { this.m.log(this.name, `Angeln: ${e.message}`, 'warn'); await sleep(2500); }
          }
          await sleep(400);
        }
      } else if (profile === 'trading') {
        const bot = this.bot;
        const villagers = Object.values(bot.entities).filter((e) => e && e.name === 'villager' && e.position && e.position.distanceTo(bot.entity.position) < 5);
        if (!villagers.length) return this.fail('Kein Dorfbewohner in 5 Blöcken Nähe gefunden');
        this.setStatus('trading', 'Dorfbewohner gefunden – Handelsfenster wird geöffnet');
        try {
          await bot.lookAt(villagers[0].position.offset(0, 1, 0), true);
          const window = await bot.openVillager(villagers[0]);
          const offers = window.trades || [];
          const tradeCount = Math.max(1, Math.min(256, Number(options.tradeCount) || 1));
          const wanted = String(options.outputItem || '').trim().toLowerCase().replace(/^minecraft:/, '');
          let tradeIndex = Number.isInteger(Number(options.tradeIndex)) && options.tradeIndex !== '' ? Number(options.tradeIndex) : -1;
          if (wanted) {
            tradeIndex = offers.findIndex((t) => {
              const output = t && (t.outputItem || t.output || t.result);
              return output && String(output.name || '').toLowerCase().replace(/^minecraft:/, '').includes(wanted);
            });
            if (tradeIndex < 0) throw new Error(`Kein Angebot gefunden, das als Ergebnis [0m"${wanted}" enthält. Angebote: ${offers.map((t, i) => `${i + 1}: ${(t.outputItem && t.outputItem.name) || 'unbekannt'}`).join(', ') || 'keine'}`);
          }
          if (tradeIndex >= 0) {
            if (tradeIndex >= offers.length) throw new Error(`Angebot ${tradeIndex + 1} existiert nicht; gefunden: ${offers.length}`);
            const offer = offers[tradeIndex];
            const maxUses = Number(offer && (offer.maximumNbTradeUses ?? offer.maxUses ?? offer.maximumUses));
            const used = Number(offer && (offer.nbTradeUses ?? offer.uses ?? offer.tradeUses)) || 0;
            const available = Number.isFinite(maxUses) && maxUses > 0 ? Math.max(0, maxUses - used) : tradeCount;
            const runs = Math.min(tradeCount, available || (Number.isFinite(maxUses) && maxUses > 0 ? 0 : tradeCount));
            if (runs <= 0 || offer.tradeDisabled || offer.disabled) throw new Error('Dieses Handelsangebot ist derzeit ausverkauft/deaktiviert');
            let completed = 0;
            for (; completed < runs && this.alive(token) && !token.cancelled; completed++) {
              await bot.trade(villagers[0], tradeIndex, 1);
              this.stats.trades = (this.stats.trades || 0) + 1;
              this.m.touch();
              await sleep(250);
            }
            this.m.log(this.name, `Automatischer Handel beendet: Angebot ${tradeIndex + 1}, ${completed} Trade(s)`, 'info');
            this.setStatus('trading', `Handel: ${completed}/${runs} ausgeführt`);
            try { window.close(); } catch { /* egal */ }
          } else {
            const summary = offers.map((t, i) => `${i + 1}: ${(t.outputItem && t.outputItem.name) || 'unbekannt'}`).join(' | ');
            this.m.log(this.name, `Handelsangebote: ${summary || 'keine Angebote'}. Gib im Dashboard eine Angebotsnummer oder einen Ergebnis-Itemnamen an.`, 'info');
            this.setStatus('trading', `Handelsfenster offen (${offers.length} Angebote)`);
          }
        } catch (e) { return this.fail(`Handel konnte nicht geöffnet werden: ${e.message}`); }
      }
    })().catch((e) => { if (!token.cancelled) this.fail(`Aufgabe: ${e.message}`); });
  }

  stopProfile() { this.profile = 'idle'; this.profileOptions = {}; this.stopJob(); }

  async repairFishingRod(token, rod, threshold) {
    const bot = this.bot;
    const before = remaining(rod);
    const bottles = () => bot.inventory.items().find((it) => it.name === 'experience_bottle');
    if (!bottles()) {
      this.m.log(this.name, 'Angel hat Mending, aber keine XP-Flaschen im Inventar', 'warn');
      return false;
    }
    this.setStatus('repairing', `Angel reparieren · ${before} Haltbarkeit`);
    try { await bot.equip(rod, 'hand'); } catch { return false; }
    let last = before;
    let noProgress = 0;
    // Begrenzte Versuche verhindern endlose XP-Flaschen-Schleifen.
    for (let i = 0; i < 6 && this.alive(token) && !token.cancelled; i++) {
      const bottle = bottles();
      if (!bottle) break;
      try {
        await bot.equip(bottle, 'off-hand');
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        bot.activateItem(true);
        this.stats.bottles++;
        await sleep(Math.max(500, this.m.settings.throwDelayMs));
        const current = bot.inventory.items().find((it) => it.name === 'fishing_rod' && it.slot === rod.slot) || bot.heldItem;
        const now = current && current.name === 'fishing_rod' ? remaining(current) : null;
        if (now !== null && now > last) { last = now; noProgress = 0; }
        else noProgress++;
        if (now !== null && now > threshold) { await bot.equip(current, 'hand'); this.setStatus('fishing', 'Angel repariert'); return true; }
        if (noProgress >= 3) break;
      } catch (e) { this.m.log(this.name, `Angel-Reparatur: ${e.message}`, 'warn'); break; }
    }
    const updated = bot.inventory.items().find((it) => it.name === 'fishing_rod' && it.slot === rod.slot);
    if (updated) { try { await bot.equip(updated, 'hand'); } catch { /* next task reports */ } }
    return !!(updated && remaining(updated) !== null && remaining(updated) > before);
  }

  // ---------------------------------------------------------------- Hauptschleife

  async runJob(token) {
    const bot = this.bot;
    const s = this.m.settings;
    this.setStatus('mining', 'Starte...');
    let sinceCollect = 0;

    while (this.alive(token)) {
      if (!(await this.maintainTool(token))) return;
      if (!this.alive(token)) return;

      if (bot.inventory.emptySlotCount() <= s.minFreeSlots) {
        if (!s.chest) return this.fail('Inventar voll - bitte Kiste in den Einstellungen setzen');
        if (!(await this.dropoff(token))) return;
        if (!this.alive(token)) return;
      }

      const target = this.nextTarget();
      if (!target) {
        await this.collectDrops(token).catch(() => {});
        if (this.stats.mined === 0 && this.skip.size > 0) {
          return this.fail(`${this.skip.size} Bloecke nicht erreichbar - liegt der Bereich unter einer Schicht? Dann "Tunnel graben" aktivieren`);
        }
        this.setStatus('done', 'Abschnitt fertig');
        this.m.log(this.name, 'Abschnitt fertig', 'info');
        this.m.workerFinished();
        return;
      }

      this.setStatus('mining', `Block ${target.x} ${target.y} ${target.z}`);
      await this.mineAt(target, token);

      if (++sinceCollect >= s.collectEvery) {
        sinceCollect = 0;
        await this.collectDrops(token).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- Abbau

  resetCursor() {
    this.queue = [];
    this.queueSize = 0;
    this.layerY = null;
    this.pass = 0;
    this.skip = new Set();
    this.tries = new Map();
  }

  isMinable(block) {
    if (!block || AIR.has(block.name) || LIQUIDISH.has(block.name)) return false;
    if (block.diggable === false) return false;
    const p = block.position;
    if (this.skip.has(`${p.x},${p.y},${p.z}`)) return false;
    if (this.m.settings.excludedBlocks && this.m.settings.excludedBlocks.includes(block.name)) return false;
    if (this.m.settings.avoidLiquid && this.touchesFluid(p)) return false;
    return true;
  }

  touchesFluid(p) {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const b = this.bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
      if (b && FLUID.has(b.name)) return true;
    }
    return false;
  }

  buildLayer(y) {
    const r = this.region;
    const out = [];
    let flip = false;
    for (let x = r.minX; x <= r.maxX; x++) {
      const zs = [];
      for (let z = r.minZ; z <= r.maxZ; z++) zs.push(z);
      if (flip) zs.reverse();
      flip = !flip;
      for (const z of zs) {
        const b = this.bot.blockAt(new Vec3(x, y, z));
        if (!b) out.push({ x, y, z, unloaded: true });
        else if (this.isMinable(b)) out.push({ x, y, z });
      }
    }
    return out;
  }

  nextTarget() {
    const r = this.region;
    for (;;) {
      if (this.queue.length) return this.queue.shift();
      if (this.layerY === null) { this.layerY = r.maxY; this.pass = 0; }
      if (this.layerY < r.minY) return null;
      if (this.pass === 0) {
        this.queue = this.buildLayer(this.layerY);
        this.queueSize = this.queue.length;
        this.pass = 1;
        if (!this.queue.length) { this.layerY--; this.pass = 0; }
      } else {
        // Zweiter Durchlauf: Nachzuegler (z.B. gefallener Sand/Kies)
        const rest = this.buildLayer(this.layerY);
        this.layerY--;
        this.pass = 0;
        this.queue = rest;
        this.queueSize = rest.length;
      }
    }
  }

  progress() {
    const r = this.region;
    if (!r) return 0;
    if (this.layerY === null) return 0;
    const layers = r.maxY - r.minY + 1;
    if (this.layerY < r.minY) return 1;
    const doneLayers = r.maxY - this.layerY;
    const frac = this.queueSize ? 1 - this.queue.length / this.queueSize : 0;
    return Math.min(1, (doneLayers + (this.pass === 1 ? frac : 0)) / layers);
  }

  retryOrSkip(t) {
    const key = `${t.x},${t.y},${t.z}`;
    const n = (this.tries.get(key) || 0) + 1;
    this.tries.set(key, n);
    if (n >= 2) this.skip.add(key);
    else this.queue.push({ x: t.x, y: t.y, z: t.z });
  }

  async mineAt(t, token) {
    const bot = this.bot;
    try {
      let block = bot.blockAt(new Vec3(t.x, t.y, t.z));
      if (!block) {
        // Chunk nicht geladen: in die Naehe laufen
        await this.goto(new goals.GoalNearXZ(t.x, t.z, 6), token, 30000);
        block = bot.blockAt(new Vec3(t.x, t.y, t.z));
        if (!block) { this.skip.add(`${t.x},${t.y},${t.z}`); return; }
      }
      if (!this.isMinable(block)) return;

      const center = block.position.offset(0.5, 0.5, 0.5);
      if (bot.entity.position.distanceTo(center) > 4.2 || !bot.canSeeBlock(block)) {
        await this.goto(new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 }), token, 30000);
      }
      if (!this.alive(token)) return;

      block = bot.blockAt(block.position);
      if (!this.isMinable(block)) return;
      await this.equipPickaxe();
      await bot.dig(block, true);
      this.stats.mined++;
    } catch (e) {
      if (!this.alive(token)) return;
      this.retryOrSkip(t);
    }
  }

  async collectDrops(token) {
    const bot = this.bot;
    const r = this.region;
    if (!bot || !r) return;
    const pad = 3;
    const here = bot.entity.position;
    const drops = Object.values(bot.entities)
      .filter((e) => e && (e.name === 'item' || e.name === 'item_entity') && e.position
        && e.position.distanceTo(here) <= 8
        && e.position.x >= r.minX - pad && e.position.x <= r.maxX + 1 + pad
        && e.position.z >= r.minZ - pad && e.position.z <= r.maxZ + 1 + pad
        && e.position.y >= r.minY - pad && e.position.y <= r.maxY + 1 + pad)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))
      .slice(0, 10);
    for (const e of drops) {
      if (!this.alive(token)) return;
      if (!bot.entities[e.id]) continue;
      const p = e.position;
      try { await this.goto(new goals.GoalNear(p.x, p.y, p.z, 1), token, 8000); } catch { /* naechstes Item */ }
    }
  }

  // ---------------------------------------------------------------- Werkzeug & Reparatur

  findPickaxe() {
    const picks = this.bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name) && (remaining(i) === null || remaining(i) > 0));
    picks.sort((a, b) => tierOf(b.name) - tierOf(a.name) || (remaining(b) || 0) - (remaining(a) || 0));
    return picks[0] || null;
  }

  findBottle() {
    return this.bot.inventory.items().find((i) => i.name === 'experience_bottle') || null;
  }

  bottleCount() {
    const bot = this.bot;
    let n = 0;
    for (const i of bot.inventory.items()) if (i.name === 'experience_bottle') n += i.count;
    const off = bot.inventory.slots[OFFHAND_SLOT];
    if (off && off.name === 'experience_bottle') n += off.count;
    return n;
  }

  async equipPickaxe() {
    const bot = this.bot;
    const best = this.findPickaxe();
    if (!best) throw new Error('Keine Spitzhacke');
    const held = bot.heldItem;
    if (held && held.slot === best.slot) return;
    await bot.equip(best, 'hand');
  }

  async maintainTool(token) {
    const pick = this.findPickaxe();
    if (!pick) return this.fail('Keine Spitzhacke im Inventar');
    const left = remaining(pick);
    if (left !== null) {
      // Bei kleinen Spitzhacken (Holz, Gold) wuerde 300 nie erreicht werden -> max. die Haelfte
      const threshold = Math.min(this.m.settings.durabilityThreshold, Math.floor(pick.maxDurability / 2));
      if (left < threshold) return this.repair(token);
    }
    try { await this.equipPickaxe(); } catch (e) { return this.fail(e.message); }
    return true;
  }

  async repair(token) {
    const bot = this.bot;
    const s = this.m.settings;
    try { bot.pathfinder.stop(); } catch { /* egal */ }
    this.setStatus('repairing', 'Repariere Spitzhacke');

    let lastUsed = null;
    let noProgress = 0;
    let setupTries = 0; // Fehlversuche beim Item-Wechseln, verhindert Endlosschleifen

    while (this.alive(token)) {
      // 1. Spitzhacke in der Haupthand
      let held = bot.heldItem;
      if (!held || !/_pickaxe$/.test(held.name)) {
        const pick = this.findPickaxe();
        if (!pick) return this.fail('Keine Spitzhacke im Inventar');
        if (++setupTries > 5) return this.fail('Spitzhacke konnte nicht in die Hand genommen werden');
        await bot.equip(pick, 'hand');
        await sleep(200);
        continue;
      }
      const used = held.durabilityUsed || 0;
      if (used === 0) break; // wieder voll
      this.setStatus('repairing', `Spitzhacke ${remaining(held)}/${held.maxDurability}`);

      // 2. XP-Flasche in der Nebenhand (aus Hotbar oder Inventar)
      const off = bot.inventory.slots[OFFHAND_SLOT];
      if (!off || off.name !== 'experience_bottle') {
        let bottle = this.findBottle();
        if (!bottle && s.chest) {
          await this.fetchBottles(token);
          if (!this.alive(token)) return false;
          bottle = this.findBottle();
        }
        if (!bottle) return this.fail(`Keine XP-Flaschen mehr - Spitzhacke hat nur noch ${remaining(held)} Haltbarkeit`);
        if (++setupTries > 5) return this.fail('XP-Flasche konnte nicht in die Nebenhand gelegt werden');
        await bot.equip(bottle, 'off-hand');
        await sleep(200);
        continue;
      }
      setupTries = 0;

      // 3. Nach unten schauen und werfen
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      bot.activateItem(true);
      this.stats.bottles++;
      await sleep(s.throwDelayMs);

      const now = (bot.heldItem && bot.heldItem.durabilityUsed) || 0;
      if (lastUsed !== null && now >= lastUsed) {
        if (++noProgress >= 8) {
          return this.fail('Reparatur ohne Fortschritt - hat die Spitzhacke Mending?');
        }
      } else {
        noProgress = 0;
      }
      lastUsed = now;
    }

    if (!this.alive(token)) return false;
    await sleep(300);
    try { await this.equipPickaxe(); } catch (e) { return this.fail(e.message); }
    this.m.log(this.name, 'Spitzhacke repariert', 'info');
    this.setStatus(this.profile === 'fishing' ? 'fishing' : 'mining', this.profile === 'fishing' ? 'Zurück zum Angeln' : 'Weiter mit Abbau');
    return true;
  }

  // ---------------------------------------------------------------- Kiste

  chestBlock() {
    const c = this.m.settings.chest;
    if (!c) return null;
    const b = this.bot.blockAt(new Vec3(c.x, c.y, c.z));
    return b && /chest|barrel/.test(b.name) ? b : null;
  }

  async openChest(token) {
    const c = this.m.settings.chest;
    await this.goto(new goals.GoalNear(c.x, c.y, c.z, 3), token, 60000);
    const block = this.chestBlock();
    if (!block) throw new Error(`An ${c.x} ${c.y} ${c.z} ist keine Kiste`);
    return this.bot.openContainer(block);
  }

  keepItem(item) {
    if (/_pickaxe$/.test(item.name) || item.name === 'experience_bottle' || item.name === 'fishing_rod') return true;
    if (this.bot.registry.foods && this.bot.registry.foods[item.type]) return true;
    return false;
  }

  async dropoff(token) {
    const bot = this.bot;
    const s = this.m.settings;
    this.setStatus('depositing', 'Bringe Items zur Kiste');
    let container;
    try {
      container = await this.openChest(token);
      for (const item of bot.inventory.items()) {
        if (this.keepItem(item)) continue;
        try { await container.deposit(item.type, null, item.count); } catch { break; }
      }
    } catch (e) {
      if (!this.alive(token)) return false;
      return this.fail(`Kiste: ${e.message}`);
    } finally {
      if (container) { try { container.close(); } catch { /* egal */ } }
    }
    if (bot.inventory.emptySlotCount() <= s.minFreeSlots) return this.fail('Kiste voll oder nichts abzulegen');
    this.setStatus(this.profile === 'fishing' ? 'fishing' : 'mining', this.profile === 'fishing' ? 'Zurück zum Angeln' : 'Weiter mit Abbau');
    return true;
  }

  async fetchBottles(token) {
    const bot = this.bot;
    this.setStatus('repairing', 'Hole XP-Flaschen aus Kiste');
    let container;
    try {
      container = await this.openChest(token);
      let need = this.m.settings.bottleBatch;
      for (const item of container.containerItems()) {
        if (need <= 0) break;
        if (item.name !== 'experience_bottle') continue;
        const n = Math.min(item.count, need);
        try { await container.withdraw(item.type, null, n); need -= n; } catch { break; }
      }
    } catch (e) {
      if (this.alive(token)) this.m.log(this.name, `Kiste: ${e.message}`, 'warn');
    } finally {
      if (container) { try { container.close(); } catch { /* egal */ } }
    }
  }

  // ---------------------------------------------------------------- Chat / Status

  chat(text) {
    if (!this.bot || !this.spawned || !this.bot.entity) throw new Error(`${this.accountName || this.name} ist nicht verbunden oder noch nicht gespawnt`);
    const message = String(text || '').trim();
    if (!message) throw new Error('Leere Nachricht');
    this.bot.chat(message);
    this.m.log(this.name, `Chat gesendet: ${message}`, 'chat');
  }

  snapshot() {
    const bot = this.bot;
    const ready = !!(bot && this.spawned && bot.entity);
    const snap = {
      name: this.name,
      profile: this.profile,
      accountName: this.accountName || this.m.accountNames?.[this.name] || (bot && bot.username ? bot.username : null),
      authMethod: this.authMethod || this.m.connection.auth || 'microsoft',
      newAccountSignIn: !!this.newAccountSignIn,
      status: this.status,
      detail: this.detail,
      serverAddress: ready ? (this.serverAddress || null) : null,
      mined: this.stats.mined,
      fishCaught: this.stats.fishCaught || 0,
      trades: this.stats.trades || 0,
      bottlesThrown: this.stats.bottles,
      progress: this.region ? this.progress() : null,
      hasRegion: !!this.region,
      msa: this.m.msa.get(this.name) || null,
      pos: null, health: null, food: null, pickaxe: null, bottles: null, freeSlots: null, inventory: [],
    };
    if (ready) {
      const p = bot.entity.position;
      snap.pos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
      snap.health = bot.health;
      snap.food = bot.food;
      try {
        const pick = this.findPickaxe();
        if (pick) snap.pickaxe = { name: pick.name, left: remaining(pick), max: pick.maxDurability || null };
        snap.bottles = this.bottleCount();
        snap.freeSlots = bot.inventory.emptySlotCount();
        snap.inventory = bot.inventory.items().map((it) => ({ name: it.name, count: it.count, slot: it.slot, durabilityLeft: remaining(it), maxDurability: it.maxDurability || null, mending: hasMending(it) }));
      } catch { /* Inventar noch nicht bereit */ }
    }
    return snap;
  }
}

module.exports = { BotWorker };
