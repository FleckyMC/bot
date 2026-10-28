'use strict';
const EventEmitter = require('events');
const path = require('path');
const config = require('./config');
const planner = require('./planner');
const { BotWorker } = require('./botWorker');

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
    this.names = cfg.names;
    this.area = cfg.area;
    this.settings = cfg.settings;
    this.workers = new Map();
    this.mining = false;
    this.msa = new Map();
    this.logs = [];
    this.touchTimer = null;
  }

  // ------------------------------------------------------------ Hilfen

  save() {
    try {
      config.save(this.file, {
        connection: this.connection, version: this.version, names: this.names, area: this.area, settings: this.settings,
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
      bots: [...this.workers.values()].map((w) => w.snapshot()),
    };
  }

  // ------------------------------------------------------------ Verbindung

  parseNames(list, auth) {
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const n = String(raw).trim();
      if (!n) continue;
      if (auth === 'offline' && !NAME_RE.test(n)) throw new Error(`Ungueltiger Bot-Name "${n}" (3-16 Zeichen: Buchstaben, Zahlen, _)`);
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
    const auth = p.auth === 'microsoft' ? 'microsoft' : 'offline';
    const names = this.parseNames(Array.isArray(p.names) ? p.names : [], auth);

    this.disconnect(true);
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

  addBot(p) {
    const name = String(p.name || '').trim();
    if (!NAME_RE.test(name)) throw new Error('Bot-Name muss 3-16 Zeichen haben (Buchstaben, Zahlen, _)');
    if (!this.connection.host) throw new Error('Bitte zuerst Server-IP speichern/verbinden');
    if (this.workers.has(name)) throw new Error('Dieser Bot existiert bereits');
    const auth = p.auth === 'microsoft' ? 'microsoft' : 'offline';
    const w = new BotWorker(this, name);
    w.authMethod = auth;
    w.wantConnected = true;
    this.workers.set(name, w);
    this.names = [...new Set([...this.names, name])];
    this.save();
    this.log('system', `Bot ${name} wird einzeln verbunden (${auth})`, 'info');
    w.connect();
    this.touch();
  }

  removeBot(name) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unbekannter Bot');
    w.disconnect();
    this.workers.delete(w.name);
    this.names = this.names.filter(n => n !== w.name);
    this.msa.delete(w.name);
    this.save();
    this.log('system', `Bot ${w.name} entfernt`, 'info');
    this.touch();
  }

  disconnect(silent = false) {
    this.mining = false;
    for (const w of this.workers.values()) w.disconnect();
    this.workers.clear();
    this.msa.clear();
    if (!silent) this.log('system', 'Alle Bots getrennt', 'info');
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
