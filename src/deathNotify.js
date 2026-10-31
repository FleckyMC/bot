'use strict';
/**
 * Todes-Benachrichtigung pro Bot: optionaler Befehl nach dem Respawn und Webhook mit
 * Minecraft-Name, Todesursache usw. Nur reine Hilfsfunktionen, damit alles testbar bleibt.
 */
const net = require('net');

const MAX_COMMAND = 256;
const MAX_URL = 500;

function isPrivateIPv4(host) {
  const p = host.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

/** Nur https, keine Zugangsdaten in der URL, keine lokalen/privaten Ziele. */
function validateWebhookUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Webhook-URL fehlt');
  if (text.length > MAX_URL) throw new Error('Webhook-URL ist zu lang');
  let url;
  try { url = new URL(text); } catch { throw new Error('Webhook-URL ist ungültig'); }
  if (url.protocol !== 'https:') throw new Error('Webhook-URL muss mit https:// beginnen');
  if (url.username || url.password) throw new Error('Webhook-URL darf keine Zugangsdaten enthalten');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Webhook-URL darf nicht auf lokale Adressen zeigen');
  }
  const kind = net.isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) throw new Error('Webhook-URL darf nicht auf private Adressen zeigen');
  if (kind === 6 && (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))) {
    throw new Error('Webhook-URL darf nicht auf private Adressen zeigen');
  }
  return url.href;
}

/**
 * Prueft und normalisiert die Todes-Einstellungen eines Bots.
 * Eine leere/fehlende webhookUrl behaelt die gespeicherte; `clearWebhook: true` loescht sie.
 */
function normalizeDeathSettings(input, previous = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const prev = previous && typeof previous === 'object' ? previous : {};

  const commandEnabled = src.commandEnabled !== undefined ? !!src.commandEnabled : !!prev.commandEnabled;
  let command = src.command !== undefined ? String(src.command).trim() : String(prev.command || '');
  if (command.length > MAX_COMMAND) throw new Error(`Befehl: maximal ${MAX_COMMAND} Zeichen`);
  if (/[\r\n\u0000]/.test(command)) throw new Error('Befehl: nur eine Zeile erlaubt');
  if (commandEnabled && !command) throw new Error('Befehl nach dem Tod ist aktiviert, aber leer');
  let delaySec = src.delaySec !== undefined ? Number(src.delaySec) : (prev.delaySec ?? 3);
  if (!Number.isInteger(delaySec) || delaySec < 0 || delaySec > 120) throw new Error('Wartezeit: Zahl zwischen 0 und 120 Sekunden erwartet');

  const webhookEnabled = src.webhookEnabled !== undefined ? !!src.webhookEnabled : !!prev.webhookEnabled;
  let webhookUrl = String(prev.webhookUrl || '');
  if (src.clearWebhook) webhookUrl = '';
  else if (typeof src.webhookUrl === 'string' && src.webhookUrl.trim()) webhookUrl = validateWebhookUrl(src.webhookUrl);
  if (webhookEnabled && !webhookUrl) throw new Error('Webhook ist aktiviert, aber es ist keine URL gespeichert');

  return { commandEnabled, command, delaySec, webhookEnabled, webhookUrl };
}

/** Fuer das Dashboard: nie die volle Webhook-URL herausgeben (sie ist ein Geheimnis). */
function publicDeathSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  let webhookHint = '';
  if (s.webhookUrl) {
    try { webhookHint = `${new URL(s.webhookUrl).host}/…${s.webhookUrl.slice(-4)}`; } catch { webhookHint = '…'; }
  }
  return {
    commandEnabled: !!s.commandEnabled,
    command: String(s.command || ''),
    delaySec: s.delaySec ?? 3,
    webhookEnabled: !!s.webhookEnabled,
    hasWebhook: !!s.webhookUrl,
    webhookHint,
  };
}

const stripFormatting = (text) => String(text || '').replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim();

/**
 * Todesursache: erst die Todesnachricht des Servers (death_combat_event), sonst die letzte
 * Chatzeile der letzten Sekunden, die den Namen des Bots enthaelt.
 */
function extractDeathCause({ packetText, chatLines, names, now = Date.now(), maxAgeMs = 6000 }) {
  const fromPacket = stripFormatting(packetText);
  if (fromPacket) return fromPacket;
  const wanted = (names || []).map((n) => String(n || '').toLowerCase()).filter(Boolean);
  const recent = (chatLines || []).filter((l) => l && now - l.t <= maxAgeMs).reverse();
  for (const line of recent) {
    const text = stripFormatting(line.text);
    if (text && wanted.some((n) => text.toLowerCase().includes(n))) return text;
  }
  return 'unbekannt';
}

const cut = (v, n) => { const s = String(v ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** Baut die Webhook-Nutzlast (Discord-Embed fuer Discord-URLs, sonst einfaches JSON). */
function buildDeathPayload(info, url = '') {
  const name = cut(info.minecraftName || 'unbekannt', 64);
  const cause = cut(info.cause || 'unbekannt', 1000);
  const when = new Date(info.time || Date.now());
  const line = `☠ ${name} ist gestorben: ${cause}`;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* egal */ }
  const isDiscord = host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com' || host.endsWith('.discordapp.com');
  const fields = [
    { name: 'Minecraft-Name', value: name, inline: true },
    info.server ? { name: 'Server', value: cut(info.server, 200), inline: true } : null,
    info.position ? { name: 'Position', value: cut(info.position, 100), inline: true } : null,
    info.dimension ? { name: 'Dimension', value: cut(info.dimension, 100), inline: true } : null,
    info.task ? { name: 'Aufgabe', value: cut(info.task, 100), inline: true } : null,
  ].filter(Boolean);
  if (isDiscord) {
    return {
      username: 'Bot Control',
      allowed_mentions: { parse: [] },
      embeds: [{ title: info.test ? 'Bot gestorben (Test)' : 'Bot gestorben', description: cause, color: 0xff7185, fields, timestamp: when.toISOString() }],
    };
  }
  return { text: line, content: line, minecraftName: name, cause, server: info.server || null, position: info.position || null, dimension: info.dimension || null, task: info.task || null, test: !!info.test, time: when.toISOString() };
}

async function sendWebhook(url, payload, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch ist nicht verfügbar (Node 18+ nötig)');
  const safeUrl = validateWebhookUrl(url);
  const res = await fetchImpl(safeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Webhook antwortete mit HTTP ${res.status}`);
  return res.status;
}

module.exports = { validateWebhookUrl, normalizeDeathSettings, publicDeathSettings, extractDeathCause, buildDeathPayload, sendWebhook };
