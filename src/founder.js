'use strict';
const fs = require('fs');
const path = require('path');
const { validateWebhookUrl } = require('./deathNotify');

/**
 * Settings only the founder can change: Discord OAuth2 application, account-event webhook (and later the bot token).
 * Secrets live in data/founder.json (mode 600) and are never sent to the browser.
 */
const EVENTS = ['created', 'deleted', 'auto_deleted', 'expired', 'time_added', 'renamed', 'discord_changed'];

const defaults = () => ({
  discord: { clientId: '', clientSecret: '', publicUrl: '' },
  accountWebhook: { enabled: false, url: '', events: Object.fromEntries(EVENTS.map((e) => [e, true])) },
  botToken: '',
});

function createFounderStore(file) {
  let data = defaults();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...defaults(), ...saved, discord: { ...defaults().discord, ...(saved.discord || {}) }, accountWebhook: { ...defaults().accountWebhook, ...(saved.accountWebhook || {}), events: { ...defaults().accountWebhook.events, ...((saved.accountWebhook || {}).events || {}) } } };
  } catch { /* first start */ }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const mask = (secret) => (secret ? `••••${String(secret).slice(-4)}` : '');

  function normalizePublicUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    let url;
    try { url = new URL(text); } catch { throw new Error('Public URL is invalid (example: https://meltrovia.com)'); }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Public URL must start with https://');
    if (url.username || url.password) throw new Error('Public URL must not contain credentials');
    return url.origin;
  }

  return {
    get: () => data,
    redirectUri: () => (data.discord.publicUrl ? data.discord.publicUrl + '/auth/discord/callback' : ''),
    discordConfigured: () => !!(data.discord.clientId && data.discord.clientSecret && data.discord.publicUrl),
    publicView() {
      const d = data.discord, w = data.accountWebhook;
      return {
        discord: { clientId: d.clientId, hasSecret: !!d.clientSecret, secretHint: mask(d.clientSecret), publicUrl: d.publicUrl, redirectUri: this.redirectUri(), configured: this.discordConfigured() },
        accountWebhook: { enabled: w.enabled, hasUrl: !!w.url, urlHint: w.url ? (() => { try { return `${new URL(w.url).host}/…${w.url.slice(-4)}`; } catch { return '…'; } })() : '', events: { ...w.events } },
        hasBotToken: !!data.botToken,
        eventNames: EVENTS,
      };
    },
    update(patch = {}) {
      const next = JSON.parse(JSON.stringify(data));
      if (patch.discord && typeof patch.discord === 'object') {
        const p = patch.discord;
        if (p.clientId !== undefined) {
          const id = String(p.clientId).trim();
          if (id && !/^\d{5,25}$/.test(id)) throw new Error('Client ID must be the numeric Application ID from the Discord developer portal.');
          next.discord.clientId = id;
        }
        if (typeof p.clientSecret === 'string' && p.clientSecret.trim()) {
          if (p.clientSecret.length > 200) throw new Error('Client secret is too long.');
          next.discord.clientSecret = p.clientSecret.trim();
        }
        if (p.clearSecret) next.discord.clientSecret = '';
        if (p.publicUrl !== undefined) next.discord.publicUrl = normalizePublicUrl(p.publicUrl);
      }
      if (patch.accountWebhook && typeof patch.accountWebhook === 'object') {
        const p = patch.accountWebhook;
        if (p.enabled !== undefined) next.accountWebhook.enabled = !!p.enabled;
        if (p.clearUrl) next.accountWebhook.url = '';
        else if (typeof p.url === 'string' && p.url.trim()) next.accountWebhook.url = validateWebhookUrl(p.url);
        if (p.events && typeof p.events === 'object') for (const e of EVENTS) if (p.events[e] !== undefined) next.accountWebhook.events[e] = !!p.events[e];
        if (next.accountWebhook.enabled && !next.accountWebhook.url) throw new Error('The webhook is enabled but no URL is saved.');
      }
      data = next;
      save();
    },
  };
}

module.exports = { createFounderStore, EVENTS };
