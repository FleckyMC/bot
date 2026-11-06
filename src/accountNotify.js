'use strict';
const { buildDeathPayload, sendWebhook } = require('./deathNotify');

const roleName = (r) => (r === 'founder' ? 'Founder' : r === 'admin' ? 'Admin' : 'User');
const who = (u) => (u ? `${roleName(u.role)} @${u.username}` : 'System');
const fmtDate = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const period = (expiresAt, from = Date.now()) => {
  if (!expiresAt) return 'permanent';
  const days = Math.max(1, Math.round((expiresAt - from) / 86400000));
  return `${days} day${days === 1 ? '' : 's'}`;
};

/** Builds the text for one account event. info: { type, actor, target, detail, expiresAt, days, from, to } */
function describe(info) {
  const t = info.target ? info.target.username : 'unknown';
  switch (info.type) {
    case 'test': return { title: 'Webhook test', color: 0xa66bff, text: 'This is a test message from the Meltrovia Network dashboard.' };
    case 'created': return { title: 'Account created', color: 0x5ee6a8, text: `${who(info.actor)} created account ${t}`, field: ['Membership', period(info.expiresAt, info.at)] };
    case 'deleted': return { title: 'Account deleted', color: 0xff6b8a, text: `${who(info.actor)} deleted account ${t}` };
    case 'auto_deleted': return { title: 'Account deleted automatically', color: 0xff6b8a, text: `Account ${t} was deleted automatically because its membership was not renewed within 24 hours` };
    case 'expired': return { title: 'Membership ended', color: 0xffcb6b, text: `The membership of account ${t} has ended. It will be deleted in 24 hours unless time is added` };
    case 'time_added': return { title: 'Time added', color: 0xa66bff, text: `${who(info.actor)} added ${info.days} day${info.days === 1 ? '' : 's'} to account ${t}`, field: ['New end', info.expiresAt ? fmtDate(info.expiresAt) : '-'] };
    case 'renamed': return { title: 'Account renamed', color: 0xa66bff, text: `${who(info.actor)} renamed account ${info.from} to ${info.to}` };
    case 'discord_changed': return { title: 'Discord account changed', color: 0xffcb6b, text: `Account ${t} changed its connected Discord account${info.from ? ` (${info.from} → ${info.to})` : ''}` };
    case 'discord_revoked': return { title: 'Discord link removed', color: 0xffcb6b, text: `Account ${t} revoked the Discord authorization${info.from ? ` (${info.from})` : ''}` };
    default: return { title: 'Account event', color: 0xa66bff, text: `${who(info.actor)}: ${info.type} ${t}` };
  }
}

/** Discord webhooks get an embed; any other URL gets plain JSON. Mentions are always disabled. */
function buildAccountPayload(info, url) {
  const d = describe(info);
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* ignore */ }
  const isDiscord = host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com' || host.endsWith('.discordapp.com');
  if (isDiscord) {
    return { username: 'Meltrovia Network', allowed_mentions: { parse: [] }, embeds: [{ title: d.title, description: d.text, color: d.color, fields: d.field ? [{ name: d.field[0], value: d.field[1], inline: true }] : [], timestamp: new Date(info.at || Date.now()).toISOString() }] };
  }
  return { text: d.text, content: d.text, event: info.type, time: new Date(info.at || Date.now()).toISOString() };
}

/** Sends the event to the founder's webhook if enabled for that event type. Never throws. */
async function notifyAccountEvent(founder, info, { send = sendWebhook, onError = () => {} } = {}) {
  try {
    const w = founder.get().accountWebhook;
    if (!w.enabled || !w.url || !w.events[info.type]) return false;
    await send(w.url, buildAccountPayload(info, w.url));
    return true;
  } catch (e) { onError(e); return false; }
}

module.exports = { buildAccountPayload, notifyAccountEvent, describe, period, roleName };
