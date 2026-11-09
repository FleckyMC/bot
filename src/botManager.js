'use strict';
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const planner = require('./planner');
const { BotWorker } = require('./botWorker');
const { normalizeDeathSettings, buildDeathPayload, sendWebhook } = require('./deathNotify');
const { normalizeReconnectSettings } = require('./botSettings');
const net = require('net');
const { Authflow, Titles } = require('prismarine-auth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseHost(input, portInput) {
  let host = String(input || '').trim();
  let port = Number(portInput) || 0;
  const m = host.match(/^(.+):(\d{1,5})$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (!host || /\s/.test(host)) throw new Error('Please enter a server address');
  if (port && (port < 1 || port > 65535)) throw new Error('Invalid port');
  return { host, port };
}

// Regular users may connect their bots to public servers only, so the dashboard cannot be used to probe
// the machine it runs on or its local network. (Literal addresses and obvious local names are checked.)
function isInternalHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !net.isIP(h)) return true;
  const kind = net.isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
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
    this.names = [...new Set([...(Array.isArray(cfg.names) ? cfg.names.filter((n) => typeof n === 'string' && n.trim() && this.accountNames[n]) : []), ...Object.keys(this.accountNames).filter((n) => this.accountNames[n])])];
    this.accountProfiles = cfg.accountProfiles || {};
    this.botSettings = cfg.botSettings || {};
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
    this.cancelledSignIns = new Set();
    // The dashboard decides which bots are shared (admin-owned) and which belong to a regular user.
    // Global actions (mining, auto-drop, storage chest) only touch shared bots.
    this.isShared = () => true;
    this.logs = [];
    this.touchTimer = null;
  }

  // ------------------------------------------------------------ Hilfen

  save() {
    try {
      config.save(this.file, {
        connection: this.connection, version: this.version, names: this.names, accountNames: this.accountNames, accountProfiles: this.accountProfiles, botSettings: this.botSettings, area: this.area, settings: this.settings,
      });
    } catch (e) { this.log('system', `Could not save the configuration: ${e.message}`, 'warn'); }
  }

  // extra.bots: only the owners of these bots see the line; extra.ownerId: only that account sees it.
  log(source, text, level = 'info', extra = {}) {
    // Chat sehen alle Bots: gleiche Zeile innerhalb von 1,5 s nur einmal anzeigen
    if (level === 'chat') {
      const now = Date.now();
      this.recentChat = this.recentChat || new Map();
      const last = this.recentChat.get(text);
      if (last && now - last < 1500) return;
      this.recentChat.set(text, now);
      if (this.recentChat.size > 200) for (const [k, t] of this.recentChat) if (now - t > 5000) this.recentChat.delete(k);
    }
    // Show the Minecraft name instead of the internal "MicrosoftAccountN" id.
    let shown = String(text);
    for (const [id, mc] of Object.entries(this.accountNames || {})) if (mc && id !== mc && shown.includes(id)) shown = shown.split(id).join(mc);
    const entry = { t: Date.now(), source, text: shown.slice(0, 500), level };
    if (Array.isArray(extra.bots)) entry.bots = extra.bots.map(String);
    if (extra.ownerId) entry.ownerId = extra.ownerId;
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
    this.log(name, 'Microsoft device code is available in the active sign-in panel.', 'warn');
    this.touch();
  }

  clearMsa(name) { this.msa.delete(name); }

  setVersion(version) {
    const v = String(version || 'auto').trim();
    // Mineflayer auto-detects the server protocol. Explicit versions are accepted
    // without a UI allow-list; actual support is still limited by minecraft-protocol.
    if (v !== 'auto' && !require('minecraft-data').versionsByMinecraftVersion.pc[v]) throw new Error('Unknown Minecraft version (e.g. auto, 1.21.11, 26.1)');
    if ([...this.workers.values()].some(w => w.bot || w.wantConnected)) throw new Error('Please disconnect the bots first, then change the version');
    this.version = v;
    this.save();
    this.log('system', `Minecraft version set: ${v === 'auto' ? 'auto-detect' : v}`, 'info');
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
      pendingSignIns: [...this.pendingAccounts.values()].map((p) => ({ name: p.name, ownerId: p.ownerId || null, msa: this.msa.get(p.name) || null, detail: p.detail || 'Waiting for Microsoft sign-in' })),
    };
  }

  // ------------------------------------------------------------ Verbindung

  parseNames(list, auth) {
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const n = String(raw).trim();
      if (!n) continue;
      
      if (auth === 'microsoft' && !MAIL_RE.test(n) && !NAME_RE.test(n)) throw new Error(`Invalid account "${n}" (email address expected)`);
      if (seen.has(n.toLowerCase())) throw new Error(`Duplicate name "${n}"`);
      seen.add(n.toLowerCase());
      out.push(n);
    }
    if (!out.length) throw new Error('At least one bot name / account is required');
    if (out.length > 100) throw new Error('At most 100 bots');
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

    this.log('system', `Connecting ${names.length} bot(s) to ${host}${port ? ':' + port : ''} (version ${this.version}, ${auth})`, 'info', { bots: names });
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

  pendingCountFor(ownerId) {
    let n = 0;
    for (const p of this.pendingAccounts.values()) if (p.ownerId && p.ownerId === ownerId) n++;
    return n;
  }

  // Cancels a running Microsoft sign-in. A device-code login cannot be aborted on Microsoft's side, so the
  // result is simply discarded when (if) it arrives.
  cancelSignIn(name, ownerId = null) {
    const pending = this.pendingAccounts.get(String(name || ''));
    if (!pending) throw new Error('This sign-in is no longer running');
    if (ownerId && pending.ownerId !== ownerId) throw new Error('This sign-in belongs to another account');
    this.cancelledSignIns.add(pending.name);
    this.pendingAccounts.delete(pending.name);
    this.clearMsa(pending.name);
    this.forgetProfile(pending.profileDir);
    this.log('system', 'Microsoft sign-in cancelled', 'info', { ownerId: pending.ownerId });
    this.touch();
  }

  // Deletes the saved Microsoft login of a bot (only inside data/profiles).
  forgetProfile(profileDir) {
    try {
      const root = path.resolve(this.dataDir, 'profiles') + path.sep;
      const dir = path.resolve(String(profileDir || ''));
      if (!dir.startsWith(root) || dir === root) return;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  addBot({ ownerId = null } = {}) {
    // Adding an account only authenticates with Microsoft. It must not connect
    // to any Minecraft server; the user chooses a server later via Connect.
    let index = 1;
    while (this.workers.has(`MicrosoftAccount${index}`) || this.pendingAccounts.has(`MicrosoftAccount${index}`)) index++;
    const name = `MicrosoftAccount${index}`;
    const safe = name.replace(/[^A-Za-z0-9_.@-]/g, '_');
    const profileDir = path.join(this.dataDir, 'profiles', `${safe}-${Date.now()}`);
    const pending = { name, profileDir, ownerId, detail: 'Microsoft sign-in in progress' };
    this.pendingAccounts.set(name, pending);
    this.log('system', 'Starting Microsoft account sign-in. No Minecraft server connection will be started.', 'info', { ownerId });
    this.touch();

    (async () => {
      try {
        // Sisu uses the Minecraft Java title with its matching Windows device type.
        const flow = new Authflow(name, profileDir, { flow: 'sisu', authTitle: Titles.MinecraftJava, deviceType: 'Win32' }, (data) => this.setMsa(name, data));
        const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
        const profile = result && (result.profile || result.user || result);
        const playerName = profile && (profile.name || profile.username || profile.gamertag);
        if (!playerName || !/^[A-Za-z0-9_]{3,16}$/.test(String(playerName))) {
          const returnedFields = result && typeof result === 'object' ? Object.keys(result).filter((key) => !/token|secret|key/i.test(key)).join(', ') : typeof result;
          throw new Error(`Microsoft authorization finished, but no Minecraft Java profile name was returned (response fields: ${returnedFields || 'none'}). Make sure this Microsoft account owns Minecraft Java Edition.`);
        }
        if (this.cancelledSignIns.delete(name)) { this.forgetProfile(profileDir); return; }
        const duplicate = [...this.workers.values()].find((w) => String(w.accountName || this.accountNames[w.name] || '').toLowerCase() === String(playerName).toLowerCase());
        if (duplicate) throw new Error(`The Minecraft account ${playerName} is already added to the dashboard.`);
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
        this.emit('account_added', { name, ownerId, accountName: String(playerName) });
        this.touch();
      } catch (e) {
        if (this.cancelledSignIns.delete(name)) { this.forgetProfile(profileDir); return; }
        this.pendingAccounts.delete(name);
        this.clearMsa(name);
        this.forgetProfile(profileDir);
        const parts = [];
        const seen = new Set();
        for (let current = e, depth = 0; current && depth < 5; current = current.cause, depth++) {
          const status = current.statusCode || current.status || (current.response && current.response.status);
          const body = current.body || current.responseBody || (current.response && (current.response.data || current.response.body));
          const message = current.message || String(current);
          const detail = [message, status ? `HTTP ${status}` : '', body && typeof body === 'string' ? body : body && typeof body === 'object' ? JSON.stringify(body) : ''].filter(Boolean).join(' | ');
          if (detail && !seen.has(detail)) { parts.push(detail); seen.add(detail); }
        }
        const diagnostic = parts.join(' <- ').slice(0, 1200) || String(e);
        this.log(name, `Microsoft sign-in failed after device approval: ${diagnostic}`, 'error');
        this.touch();
      }
    })();
  }

  connectSelected(p, { restrictInternal = false } = {}) {
    const { host, port } = parseHost(p.host, p.port);
    if (restrictInternal && isInternalHost(host)) throw new Error('Please enter the public address of a Minecraft server.');
    const selected = [...new Set((Array.isArray(p.names) ? p.names : []).map(String))];
    if (!selected.length) throw new Error('Select at least one bot to connect.');
    // A regular user only sets the target of their own bots; the shared server stays as the admin set it.
    if (!restrictInternal) { this.connection = { host, port, auth: 'microsoft' }; this.save(); }
    let delay = 0;
    for (const name of selected) {
      const w = this.workers.get(name);
      if (!w) continue;
      if (w.bot) continue;
      w.target = { host, port };
      w.wantConnected = true;
      setTimeout(() => {
        if (this.workers.get(name) === w && w.wantConnected) w.connect();
      }, delay);
      delay += 1500;
    }
    this.log('system', `Connecting ${selected.length} selected bot(s) to ${host}${port ? ':' + port : ''}`, 'info', { bots: selected });
    this.touch();
  }

  disconnectSelected(names) {
    const selected = [...new Set((Array.isArray(names) ? names : []).map(String))];
    if (!selected.length) throw new Error('Select at least one bot to disconnect.');
    let disconnected = 0;
    const done = [];
    for (const name of selected) {
      const w = this.workers.get(name);
      if (!w) continue;
      w.wantConnected = false;
      w.disconnect();
      w.status = 'offline';
      w.detail = 'Disconnected. Select this bot to connect again.';
      disconnected++; done.push(name);
    }
    if (!disconnected) throw new Error('No selected bots were found.');
    this.log('system', `Disconnected ${disconnected} selected bot(s)`, 'info', { bots: done });
    this.touch();
  }

  removeBot(name) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    const accountName = w.accountName || this.accountNames[w.name] || null;
    const profileDir = w.profileDir || this.accountProfiles[w.name];
    w.disconnect();
    this.workers.delete(w.name);
    this.names = this.names.filter(n => n !== w.name);
    this.msa.delete(w.name);
    delete this.accountNames[w.name];
    delete this.accountProfiles[w.name];
    delete this.botSettings[w.name];
    this.save();
    this.forgetProfile(profileDir);
    this.emit('bot_removed', { name: w.name, accountName });
    this.log('system', `Bot ${w.name} removed`, 'info', { bots: [w.name] });
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
    if (this.mining) throw new Error('Please stop first, then change the area');
    const r = planner.normalizeArea(p1, p2); // validiert
    this.area = {
      p1: { x: r.minX, y: r.minY, z: r.minZ },
      p2: { x: r.maxX, y: r.maxY, z: r.maxZ },
    };
    this.save();
    this.log('system', `Area set: ${r.minX} ${r.minY} ${r.minZ} to ${r.maxX} ${r.maxY} ${r.maxZ} (${planner.volume(r)} blocks)`, 'info');
    this.touch();
  }

  setSettings(p) {
    const s = { ...this.settings };
    const int = (v, min, max, label) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: a whole number between ${min} and ${max} is required`);
      return n;
    };
    if (p.durabilityThreshold !== undefined) s.durabilityThreshold = int(p.durabilityThreshold, 1, 2500, 'Durability');
    if (p.minFreeSlots !== undefined) s.minFreeSlots = int(p.minFreeSlots, 0, 20, 'Free slots');
    if (p.throwDelayMs !== undefined) s.throwDelayMs = int(p.throwDelayMs, 250, 3000, 'Throw delay');
    if (p.fishingThreshold !== undefined) s.fishingThreshold = int(p.fishingThreshold, 1, 64, 'Rod durability');
    if (p.fishingUseMending !== undefined) s.fishingUseMending = !!p.fishingUseMending;
    if (p.fishingDeposit !== undefined) s.fishingDeposit = !!p.fishingDeposit;
    if (p.autoEat !== undefined) s.autoEat = !!p.autoEat;
    if (p.autoEatThreshold !== undefined) s.autoEatThreshold = int(p.autoEatThreshold, 1, 20, 'Auto Eat threshold');
    if (p.dropItems !== undefined) {
      if (!Array.isArray(p.dropItems)) throw new Error('Drop items must be a list');
      s.dropItems = [...new Set(p.dropItems.map(x => String(x).trim().toLowerCase().replace(/^minecraft:/, '')).filter(x => /^[a-z0-9_]+$/.test(x)))].slice(0, 128);
    }
    if (p.collectEvery !== undefined) s.collectEvery = int(p.collectEvery, 1, 100, 'Collect every');
    if (p.avoidLiquid !== undefined) s.avoidLiquid = !!p.avoidLiquid;
    if (p.allowDigOutside !== undefined) s.allowDigOutside = !!p.allowDigOutside;
    if (p.excludedBlocks !== undefined) {
      if (!Array.isArray(p.excludedBlocks)) throw new Error('Excluded blocks must be a list');
      s.excludedBlocks = [...new Set(p.excludedBlocks.map(v => String(v).trim().toLowerCase()).filter(v => /^[a-z0-9_]+$/.test(v)))].slice(0, 200);
    }
    if (p.chest !== undefined) {
      if (p.chest === null) s.chest = null;
      else s.chest = {
        x: int(p.chest.x, -30000000, 30000000, 'Chest X'),
        y: int(p.chest.y, -2048, 2048, 'Chest Y'),
        z: int(p.chest.z, -30000000, 30000000, 'Chest Z'),
      };
    }
    this.settings = s;
    this.save();
    this.log('system', 'Settings saved', 'info');
    this.touch();
  }

  // ------------------------------------------------------------ Einstellungen pro Bot

  getBotSettings(name) {
    return this.botSettings[String(name)] || {};
  }

  setBotSneak(name, enabled) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    const sneak = enabled === true || enabled === 'true';
    this.botSettings[w.name] = { ...this.getBotSettings(w.name), sneak };
    this.save();
    this.log(w.name, sneak ? 'Sneak enabled' : 'Sneak disabled', 'info');
    w.applySneak();
    this.touch();
  }

  setBotDeathSettings(name, input) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    const current = this.getBotSettings(w.name);
    const death = normalizeDeathSettings(input, current.death);
    this.botSettings[w.name] = { ...current, death };
    this.save();
    this.log(w.name, `Death settings saved (command: ${death.commandEnabled ? 'on' : 'off'}, webhook: ${death.webhookEnabled ? 'on' : 'off'})`, 'info');
    this.touch();
  }

  async testDeathWebhook(name) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    const death = this.getBotSettings(w.name).death;
    if (!death || !death.webhookUrl) throw new Error('No webhook URL is saved for this bot yet');
    const payload = buildDeathPayload({
      minecraftName: w.accountName || this.accountNames[w.name] || w.name,
      cause: 'This is a test message – not a real death.',
      server: this.connection && this.connection.host ? this.connection.host : null,
      test: true,
      time: Date.now(),
    }, death.webhookUrl);
    await sendWebhook(death.webhookUrl, payload);
    this.log(w.name, 'Test webhook sent', 'info');
  }

  setBotReconnectSettings(name, input) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    const current = this.getBotSettings(w.name);
    const reconnect = normalizeReconnectSettings(input, current.reconnect);
    this.botSettings[w.name] = { ...current, reconnect };
    this.save();
    this.log(w.name, `Reconnect command saved (${reconnect.commandEnabled ? 'on' : 'off'})`, 'info');
    this.touch();
  }

  // ------------------------------------------------------------ Item drops

  async dropItems(name, requests) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    return w.dropFromSlots(requests);
  }

  async moveItem(name, from, to, item) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    return w.moveItem({ from, to, name: item });
  }

  async dropAll(name, options = {}) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    return w.dropEverything({ includeEquipped: options.includeEquipped !== false });
  }

  // ------------------------------------------------------------ Start / Stop

  start(filter = (w) => this.isShared(w)) {
    if (!this.area) throw new Error('Please save an area (Pos 1 / Pos 2) first');
    const workers = [...this.workers.values()].filter((w) => filter(w));
    if (!workers.length) throw new Error('No bots connected');
    const area = planner.normalizeArea(this.area.p1, this.area.p2);
    const parts = planner.split(area, workers.length);
    this.mining = true;
    workers.forEach((w, i) => {
      w.region = parts[i];
      w.resetCursor();
      if (!w.region) { w.setStatus('idle', 'No section (too many bots)'); return; }
      if (w.bot && w.spawned) w.startJob();
      else w.setStatus(w.status, 'Starts after connecting');
    });
    this.log('system', `Start: ${workers.length} bot(s) are mining ${planner.volume(area)} blocks`, 'info', { bots: workers.map((w) => w.name) });
    this.touch();
  }

  stop() {
    this.mining = false;
    for (const w of this.workers.values()) w.stopJob();
    this.log('system', 'Stopped - all bots are standing still', 'info');
    this.touch();
  }

  stopBots(names) {
    const allowed = new Set(Array.isArray(names) ? names.map(String) : []);
    const selected = [...this.workers.values()].filter(w => allowed.has(w.name));
    for (const w of selected) {
      w.stopJob();
      w.region = null;
      this.log(w.name, 'Task stopped by the account owner', 'info');
    }
    if (!selected.length) throw new Error('This account has no connected bots.');
    const activeRegions = [...this.workers.values()].some(w => w.region);
    if (!activeRegions) this.mining = false;
    this.touch();
  }

  workerFinished() {
    const active = [...this.workers.values()].filter((w) => w.region);
    if (this.mining && active.length && active.every((w) => w.status === 'done')) {
      this.mining = false;
      this.log('system', 'All sections are finished', 'info');
      this.touch();
    }
  }

  setBotProfile(name, profile, options = {}) {
    const w = this.workers.get(String(name || ''));
    if (!w) throw new Error('Unknown bot');
    if (this.mining && this.isShared(w)) throw new Error('Please stop the shared mining first');
    if (profile === 'idle') { w.stopProfile(); this.log(w.name, 'Task stopped', 'info'); return; }
    w.startProfile(profile, options);
    this.log(w.name, `Task profile started: ${profile}`, 'info');
    this.touch();
  }

  // ------------------------------------------------------------ Chat / Befehle

  async sendChat(target, text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Empty message');
    if (t.length > 256) throw new Error('At most 256 characters');
    if (target && target !== 'all') {
      const w = this.workers.get(target);
      if (!w) throw new Error('Unknown bot');
      await w.chat(t);
      return;
    }
    const ready = [...this.workers.values()].filter((w) => w.bot && w.spawned);
    if (!ready.length) throw new Error('No bot is connected');
    let sent = 0;
    const errors = [];
    for (const w of ready) {
      try { await w.chat(t); sent++; } catch (e) { errors.push(`${w.accountName || w.name}: ${e.message}`); this.log(w.name, `Chat could not be sent: ${e.message}`, 'error'); }
      await sleep(300); // nicht alle gleichzeitig, sonst Spam-Kick
    }
    if (!sent) throw new Error(errors.join(' | ') || 'The message could not be sent to any connected bot');
  }
}

module.exports = { BotManager, isInternalHost };
