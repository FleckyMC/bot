'use strict';
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const planner = require('./planner');
const { BotWorker } = require('./botWorker');
const { Authflow, Titles } = require('prismarine-auth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseHost(input, portInput) {
  let host = String(input || '').trim();
  let port = Number(portInput) || 0;
  const m = host.match(/^(.+):(\d{1,5})$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (!host || /\s/.test(host)) throw new Error('Bitte eine Server-IP oder Adresse angeben');
  if (port && (port < 1 || port > 65535)) throw new Error('Ungueltiger Port');
  return { host, port };
}

class BotManager extends EventEmitter {
  constructor({ dataDir, version }) {
    super();
    this.dataDir = dataDir;
    this.version = version || 'auto';
    this.file = path.join(dataDir, 'config.json');
    const cfg = config.load(this.file);
    this.connection = cfg.connection;
    this.version = version && version !== 'auto' ? version : (cfg.version || 'auto');
    this.accountNames = cfg.accountNames || {};
    // Only fully authenticated Minecraft profiles are persisted as selectable bots.
    this.names = Array.isArray(cfg.names) ? [...new Set(cfg.names.filter((n) => typeof n === 'string' && n.trim() && this.accountNames[n]))] : [];
    this.accountProfiles = cfg.accountProfiles || {};
    this.area = cfg.area;
    this.settings = cfg.settings;
    this.workers = new Map();
    // Restore every saved bot entry, including accounts whose device login was
    // started but not completed before a restart. Older config files only have names.
    const savedNames = [...new Set(Object.keys(this.accountNames).filter((n) => this.accountNames[n]))];
    const profilesRoot = path.join(this.dataDir, 'profiles');
    for (const key of savedNames) {
      if (!key) continue;
      const w = new BotWorker(this, key);
      const profileName = this.accountNames[key];
      if (profileName) w.accountName = profileName;
      w.authMethod = 'microsoft';
      w.newAccountSignIn = false;
      w.wantConnected = false;
      w.status = profileName ? 'offline' : 'error';
      w.detail = profileName
        ? 'Saved Microsoft account. Select it to connect to the Minecraft server.'
        : 'Saved account entry. Microsoft sign-in may need to be completed again.';
      const safe = String(key).replace(/[^A-Za-z0-9_.@-]/g, '_');
      let profileDir = this.accountProfiles[key];
      if (!profileDir) {
        // Migrate older timestamped profile folders created before accountProfiles
        // was persisted. Prefer the newest matching folder if one exists.
        try {
          const candidates = fs.readdirSync(profilesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && (entry.name === safe || entry.name.startsWith(safe + '-')))
            .map((entry) => path.join(profilesRoot, entry.name))
            .sort()
            .reverse();
          if (candidates.length) profileDir = candidates[0];
        } catch { /* profiles directory may not exist yet */ }
      }
      w.profileDir = profileDir || path.join(profilesRoot, safe);
      this.workers.set(key, w);
    }
    this.mining = false;
    this.msa = new Map();
    this.pendingAccounts = new Map();
    this.logs = [];
    this.touchTimer = null;
  }

  // ------------------------------------------------------------ Hilfen

  save() {
    try {
      config.save(this.file, {
        connection: this.connection, version: this.version, names: this.names, accountNames: this.accountNames, accountProfiles: this.accountProfiles, area: this.area, settings: this.settings,
      });
    } catch (e) { this.log('system', `Konfiguration konnte nicht gespeichert werden: ${e.message}`, 'warn'); }
  }

  log(source, text, level = 'info') {
    // Chat sehen alle Bots: gleiche Zeile innerhalb von 1,5 s nur einmal anzeigen
    if (level === 'chat') {
      const now = Date.now();
      this.recentChat = this.recentChat || new Map();
      const last = this.recentChat.get(text);
      if (last && now - last < 1500) return;
      this.recentChat.set(text, now);
      if (this.recentChat.size > 200) for (const [k, t] of this.recentChat) if (now - t > 5000) this.recentChat.delete(k);
    }
    const entry = { t: Date.now(), source, text: String(text).slice(0, 500), level };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', entry);
  }

  touch() {
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => { this.touchTimer = null; this.emit('change'); }, 250);
  }

  setMsa(name, data) {
    this.msa.set(name, {
      code: data.user_code,
      url: data.verification_uri || 'https://www.microsoft.com/link',
      expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    });
    this.log(name, `Microsoft-Login: Code ${data.user_code} auf ${data.verification_uri || 'microsoft.com/link'} eingeben`, 'warn');
    this.touch();
  }

  clearMsa(name) { this.msa.delete(name); }

  setVersion(version) {
    const v = String(version || 'auto').trim();
    // Mineflayer auto-detects the server protocol. Explicit versions are accepted
    // without a UI allow-list; actual support is still limited by minecraft-protocol.
    if (v !== 'auto' && !/^1\.\d{1,2}(?:\.\d{1,2})?$/.test(v)) throw new Error('Ungueltige Minecraft-Version (z. B. auto, 1.20.4)');
    if (this.workers.size) throw new Error('Bitte Bots zuerst trennen, dann die Version ändern');
    this.version = v;
    this.save();
    this.log('system', `Minecraft-Version gesetzt: ${v === 'auto' ? 'automatisch erkennen' : v}`, 'info');
    this.touch();
  }

  snapshot() {
    return {
      connection: this.connection,
      version: this.version,
      names: this.names,
      area: this.area,
      areaVolume: this.area ? planner.volume(planner.normalizeArea(this.area.p1, this.area.p2)) : 0,
      settings: this.settings,
      mining: this.mining,
      bots: [...this.workers.values()].filter((w) => !!(w.accountName || this.accountNames[w.name])).map((w) => w.snapshot()),
      pendingSignIns: [...this.pendingAccounts.values()].map((p) => ({ name: p.name, msa: this.msa.get(p.name) || null, detail: p.detail || 'Waiting for Microsoft sign-in' })),
    };
  }

  // ------------------------------------------------------------ Verbindung

  parseNames(list, auth) {
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const n = String(raw).trim();
      if (!n) continue;
      
      if (auth === 'microsoft' && !MAIL_RE.test(n) && !NAME_RE.test(n)) throw new Error(`Ungueltiger Account "${n}" (E-Mail-Adresse erwartet)`);
      if (seen.has(n.toLowerCase())) throw new Error(`Doppelter Name "${n}"`);
      seen.add(n.toLowerCase());
      out.push(n);
    }
    if (!out.length) throw new Error('Mindestens ein Bot-Name / Account noetig');
    if (out.length > 100) throw new Error('Maximal 100 Bots');
    return out;
  }

  connect(p) {
    const { host, port } = parseHost(p.host, p.port);
    const auth = 'microsoft';
    const names = this.parseNames(Array.isArray(p.names) ? p.names : [], auth);

    this.disconnect(true);
    this.workers.clear();
    this.connection = { host, port, auth };
    this.names = names;
    this.save();

    this.log('system', `Verbinde ${names.length} Bot(s) mit ${host}${port ? ':' + port : ''} (Version ${this.version}, ${auth})`, 'info');
    names.forEach((n) => { const w = new BotWorker(this, n); w.authMethod = auth; this.workers.set(n, w); });
    // Verbindungen gestaffelt aufbauen, viele Server drosseln schnelle Logins
    const delay = auth === 'microsoft' ? 1500 : 5000;
    let i = 0;
    for (const w of this.workers.values()) {
      setTimeout(() => { if (this.workers.get(w.name) === w && w.wantConnected !== false) w.connect(); }, i++ * delay);
      w.wantConnected = true;
    }
    this.touch();
  }

  addBot() {
    // Adding an account only authenticates with Microsoft. It must not connect
    // to any Minecraft server; the user chooses a server later via Connect.
    let index = 1;
    while (this.workers.has(`MicrosoftAccount${index}`) || this.pendingAccounts.has(`MicrosoftAccount${index}`)) index++;
    const name = `MicrosoftAccount${index}`;
    const safe = name.replace(/[^A-Za-z0-9_.@-]/g, '_');
    const profileDir = path.join(this.dataDir, 'profiles', `${safe}-${Date.now()}`);
    const pending = { name, profileDir, detail: 'Microsoft sign-in in progress' };
    this.pendingAccounts.set(name, pending);
    this.log('system', 'Starting Microsoft account sign-in. No Minecraft server connection will be started.', 'info');
    this.touch();

    (async () => {
      try {
        const flow = new Authflow(name, profileDir, { authTitle: Titles.MinecraftJava }, (data) => this.setMsa(name, data));
        const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
        const profile = result && (result.profile || result);
        const playerName = profile && (profile.name || profile.username);
        if (!playerName || !/^[A-Za-z0-9_]{3,16}$/.test(String(playerName))) {
          throw new Error('Microsoft login completed, but no valid Minecraft Java profile was returned. Check that the account owns Minecraft Java Edition.');
        }
        const worker = new BotWorker(this, name);
        worker.profileDir = profileDir;
        worker.authMethod = 'microsoft';
        worker.accountName = String(playerName);
        worker.newAccountSignIn = false;
        worker.wantConnected = false;
        worker.status = 'offline';
        worker.detail = 'Microsoft account connected. Select a server and click Connect to join.';
        this.workers.set(name, worker);
        this.accountNames[name] = String(playerName);
        this.accountProfiles[name] = profileDir;
        this.names = [...new Set([...this.names, name])];
        this.pendingAccounts.delete(name);
        this.clearMsa(name);
        this.save();
        this.log(name, `Microsoft account connected: ${playerName}. No server connection started.`, 'info');
        this.touch();
      } catch (e) {
        this.pendingAccounts.delete(name);
        this.clearMsa(name);
        this.log(name, `Microsoft sign-in failed: ${e && e.message ? e.message : e}`, 'error');
        this.touch();
      }
    })();
  }

  connectSelected(p) {
    const { host, port } = parseHost(p.host, p.port);
    const selected = [...new Set((Array.isArray(p.names) ? p.names : []).map(String))];
    if (!selected.length) throw new Error('Select at least one bot to connect.');
    this.connection = { host, port, auth: 'microsoft' };
    this.save();
    let delay = 0;
    for (const name of selected) {
      const w = this.workers.get(name);
      if (!w) continue;
      if (w.bot) continue;
      w.wantConnected = true;
      setTimeout(() => {
        if (this.workers.get(name) === w && w.wantConnected) w.connect();
      }, delay);
      delay += 1500;
    }
    this.log('system', `Connecting ${selected.length} selected bot(s) to ${host}${port ? ':' + port : ''}`, 'info');
    this.touch();
  }

  disconnectSelected(names) {
    const selected = [...new Set((Array.isArray(names) ? names : []).map(String))];
    if (!selected.length) throw new Error('Select at least one bot to disconnect.');
    let disconnected = 0;
    for (const name of selected) {
      const w = this.workers.get(name);
      if (!w) continue;
      w.wantConnected = false;
      w.disconnect();
      w.status = 'offline';
      w.detail = 'Disconnected. Select this bot to connect again.';
      disconnected++;
    }
    if (!disconnected) throw new Error('No selected bots were found.');
    this.log('system', `Disconnected ${disconnected} selected bot(s)`, 'info');
    this.touch();
  }

  removeBot(name) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unbekannter Bot');
    w.disconnect();
    this.workers.delete(w.name);
    this.names = this.names.filter(n => n !== w.name);
    this.msa.delete(w.name);
    delete this.accountNames[w.name];
    delete this.accountProfiles[w.name];
    this.save();
    this.log('system', `Bot ${w.name} entfernt`, 'info');
    this.touch();
  }

  disconnect(silent = false) {
    this.mining = false;
    for (const w of this.workers.values()) w.disconnect();
    this.msa.clear();
    if (!silent) this.log('system', 'All bots disconnected. Saved bot accounts are still available to select and reconnect.', 'info');
    this.touch();
  }

  // ------------------------------------------------------------ Bereich & Einstellungen

  setArea(p1, p2) {
    if (this.mining) throw new Error('Bitte zuerst stoppen, dann den Bereich aendern');
    const r = planner.normalizeArea(p1, p2); // validiert
    this.area = {
      p1: { x: r.minX, y: r.minY, z: r.minZ },
      p2: { x: r.maxX, y: r.maxY, z: r.maxZ },
    };
    this.save();
    this.log('system', `Bereich gesetzt: ${r.minX} ${r.minY} ${r.minZ} bis ${r.maxX} ${r.maxY} ${r.maxZ} (${planner.volume(r)} Bloecke)`, 'info');
    this.touch();
  }

  setSettings(p) {
    const s = { ...this.settings };
    const int = (v, min, max, label) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: Zahl zwischen ${min} und ${max} erwartet`);
      return n;
    };
    if (p.durabilityThreshold !== undefined) s.durabilityThreshold = int(p.durabilityThreshold, 1, 2500, 'Haltbarkeit');
    if (p.minFreeSlots !== undefined) s.minFreeSlots = int(p.minFreeSlots, 0, 20, 'Freie Slots');
    if (p.throwDelayMs !== undefined) s.throwDelayMs = int(p.throwDelayMs, 250, 3000, 'Wurf-Pause');
    if (p.fishingThreshold !== undefined) s.fishingThreshold = int(p.fishingThreshold, 1, 64, 'Angel-Haltbarkeit');
    if (p.fishingUseMending !== undefined) s.fishingUseMending = !!p.fishingUseMending;
    if (p.fishingDeposit !== undefined) s.fishingDeposit = !!p.fishingDeposit;
    if (p.autoEat !== undefined) s.autoEat = !!p.autoEat;
    if (p.autoEatThreshold !== undefined) s.autoEatThreshold = int(p.autoEatThreshold, 1, 20, 'Auto Eat threshold');
    if (p.dropItems !== undefined) {
      if (!Array.isArray(p.dropItems)) throw new Error('Drop items must be a list');
      s.dropItems = [...new Set(p.dropItems.map(x => String(x).trim().toLowerCase().replace(/^minecraft:/, '')).filter(x => /^[a-z0-9_]+$/.test(x)))].slice(0, 128);
    }
    if (p.collectEvery !== undefined) s.collectEvery = int(p.collectEvery, 1, 100, 'Einsammeln alle');
    if (p.avoidLiquid !== undefined) s.avoidLiquid = !!p.avoidLiquid;
    if (p.allowDigOutside !== undefined) s.allowDigOutside = !!p.allowDigOutside;
    if (p.excludedBlocks !== undefined) {
      if (!Array.isArray(p.excludedBlocks)) throw new Error('Block-Ausnahmen muessen eine Liste sein');
      s.excludedBlocks = [...new Set(p.excludedBlocks.map(v => String(v).trim().toLowerCase()).filter(v => /^[a-z0-9_]+$/.test(v)))].slice(0, 200);
    }
    if (p.chest !== undefined) {
      if (p.chest === null) s.chest = null;
      else s.chest = {
        x: int(p.chest.x, -30000000, 30000000, 'Kiste X'),
        y: int(p.chest.y, -2048, 2048, 'Kiste Y'),
        z: int(p.chest.z, -30000000, 30000000, 'Kiste Z'),
      };
    }
    this.settings = s;
    this.save();
    this.log('system', 'Einstellungen gespeichert', 'info');
    this.touch();
  }

  // ------------------------------------------------------------ Start / Stop

  start() {
    if (!this.area) throw new Error('Bitte zuerst einen Bereich (Pos1/Pos2) speichern');
    if (!this.workers.size) throw new Error('Keine Bots verbunden');
    const area = planner.normalizeArea(this.area.p1, this.area.p2);
    const workers = [...this.workers.values()];
    const parts = planner.split(area, workers.length);
    this.mining = true;
    workers.forEach((w, i) => {
      w.region = parts[i];
      w.resetCursor();
      if (!w.region) { w.setStatus('idle', 'Kein Abschnitt (zu viele Bots)'); return; }
      if (w.bot && w.spawned) w.startJob();
      else w.setStatus(w.status, 'Startet nach dem Verbinden');
    });
    this.log('system', `Start: ${workers.length} Bot(s) bauen ${planner.volume(area)} Bloecke ab`, 'info');
    this.touch();
  }

  stop() {
    this.mining = false;
    for (const w of this.workers.values()) w.stopJob();
    this.log('system', 'Gestoppt - alle Bots stehen still', 'info');
    this.touch();
  }

  stopBots(names) {
    const allowed = new Set(Array.isArray(names) ? names.map(String) : []);
    const selected = [...this.workers.values()].filter(w => allowed.has(w.name));
    for (const w of selected) {
      w.stopJob();
      w.region = null;
      this.log(w.name, 'Aufgabe durch Account gestoppt', 'info');
    }
    if (!selected.length) throw new Error('Diesem Account sind keine verbundenen Bots zugewiesen.');
    const activeRegions = [...this.workers.values()].some(w => w.region);
    if (!activeRegions) this.mining = false;
    this.touch();
  }

  workerFinished() {
    const active = [...this.workers.values()].filter((w) => w.region);
    if (this.mining && active.length && active.every((w) => w.status === 'done')) {
      this.mining = false;
      this.log('system', 'Alle Abschnitte sind fertig', 'info');
      this.touch();
    }
  }

  setBotProfile(name, profile, options = {}) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unbekannter Bot');
    if (this.mining) throw new Error('Bitte zuerst den gemeinsamen Abbau stoppen');
    if (profile === 'idle') { w.stopProfile(); this.log(w.name, 'Aufgabe gestoppt', 'info'); return; }
    w.startProfile(profile, options);
    this.log(w.name, `Aufgabenprofil gestartet: ${profile}`, 'info');
    this.touch();
  }

  // ------------------------------------------------------------ Chat / Befehle

  async sendChat(target, text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Leere Nachricht');
    if (t.length > 256) throw new Error('Maximal 256 Zeichen');
    if (target && target !== 'all') {
      const w = this.workers.get(target);
      if (!w) throw new Error('Unbekannter Bot');
      w.chat(t);
      return;
    }
    const ready = [...this.workers.values()].filter((w) => w.bot && w.spawned);
    if (!ready.length) throw new Error('Kein Bot ist verbunden');
    for (const w of ready) {
      try { w.chat(t); } catch (e) { this.log(w.name, e.message, 'warn'); }
      await sleep(300); // nicht alle gleichzeitig, sonst Spam-Kick
    }
  }
}

module.exports = { BotManager };
