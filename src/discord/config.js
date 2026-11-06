'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Bot configuration (data/bot.json). Everything the admins edit in the Bot tab goes through sanitize(),
 * so a bad request can never store malformed IDs, oversized texts or out-of-range numbers.
 */
const SNOWFLAKE = /^\d{15,25}$/;
const SLUG = /^[a-z0-9_-]{1,24}$/i;
const text = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const flag = (v, fallback = false) => (v === undefined ? fallback : !!v);
const snow = (v) => { const s = String(v ?? '').trim(); return SNOWFLAKE.test(s) ? s : ''; };
const snowList = (v, max) => [...new Set((Array.isArray(v) ? v : []).map(snow).filter(Boolean))].slice(0, max);
const color = (v, fallback = '#8b5cf6') => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : fallback);
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const newId = () => crypto.randomBytes(3).toString('hex');
const slug = (v) => (typeof v === 'string' && SLUG.test(v.trim()) ? v.trim() : newId());
const list = (v, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, max) : []);
const unique = (items) => { const seen = new Set(); return items.map((i) => { while (seen.has(i.id)) i.id = newId(); seen.add(i.id); return i; }); };

const defaults = () => ({
  guildId: '',
  adminRoleIds: [],
  welcome: { enabled: false, channelId: '', message: 'Welcome {user} to **{server}**! You are member #{count}.', embed: true },
  leave: { enabled: false, channelId: '', message: '**{username}** has left {server}.', embed: true },
  autorole: { enabled: false, roleIds: [], ignoreBots: false },
  reactionRoles: [],
  rolePanels: [],
  tickets: {
    channelId: '', title: 'Support', description: 'Pick a category below to open a ticket. Our team will be with you shortly.', color: '#8b5cf6',
    placeholder: 'Select a ticket category…', categoryId: '', limitPerUser: 1, closerRoleIds: [],
    categories: [{ id: 'support', label: 'Support', description: 'General questions and problems', emoji: '' }],
  },
  shop: {
    channelId: '', title: 'Buy a membership', description: 'Choose how long you want to buy. A ticket will open with your order.', color: '#8b5cf6',
    placeholder: 'Select a duration…', categoryId: '', currency: '€',
    methods: [{ id: 'paypal', label: 'PayPal', description: 'Pay with PayPal' }],
    plans: [{ id: 'week', label: '1 week', description: 'Seven days of access', days: 7, price: 3 }],
    discounts: [],
  },
  ratings: { channelId: '', feedbackChannelId: '' },
  honeypot: {
    enabled: false, channelId: '', action: 'kick', logChannelId: '', color: '#ef4444',
    title: '🍯 Do not type here',
    description: 'This channel is here to catch bots.\nIf you type in this chat, you will be kicked from the server.',
  },
});

function sanitize(input = {}, prev = defaults()) {
  const d = defaults();
  const i = input && typeof input === 'object' ? input : {};
  const out = {};
  out.guildId = i.guildId === undefined ? prev.guildId : snow(i.guildId);
  out.adminRoleIds = i.adminRoleIds === undefined ? prev.adminRoleIds : snowList(i.adminRoleIds, 25);

  for (const key of ['welcome', 'leave']) {
    const s = i[key] || {}, p = prev[key] || d[key];
    out[key] = { enabled: flag(s.enabled, p.enabled), channelId: s.channelId === undefined ? p.channelId : snow(s.channelId), message: s.message === undefined ? p.message : text(s.message, 1500), embed: flag(s.embed, p.embed) };
    if (out[key].enabled && !out[key].channelId) throw new Error(`Pick a channel for the ${key} message or turn it off.`);
    if (out[key].enabled && !out[key].message) throw new Error(`The ${key} message is empty.`);
  }

  const a = i.autorole || {}, pa = prev.autorole;
  out.autorole = { enabled: flag(a.enabled, pa.enabled), roleIds: a.roleIds === undefined ? pa.roleIds : snowList(a.roleIds, 10), ignoreBots: flag(a.ignoreBots, pa.ignoreBots) };
  if (out.autorole.enabled && !out.autorole.roleIds.length) throw new Error('Autorole is on but no role is selected.');

  out.reactionRoles = i.reactionRoles === undefined ? prev.reactionRoles : unique(list(i.reactionRoles, 10).map((g) => ({
    id: slug(g.id), channelId: snow(g.channelId), title: text(g.title, 100, 'Pick your roles'), description: text(g.description, 1000),
    pairs: list(g.pairs, 20).map((p) => ({ emoji: text(p.emoji, 64), roleId: snow(p.roleId) })).filter((p) => p.emoji && p.roleId),
  })));
  for (const g of out.reactionRoles) {
    if (!g.channelId) throw new Error(`Reaction role message "${g.title}" needs a channel.`);
    if (!g.pairs.length) throw new Error(`Reaction role message "${g.title}" needs at least one emoji → role pair.`);
    if (new Set(g.pairs.map((p) => p.emoji)).size !== g.pairs.length) throw new Error(`Reaction role message "${g.title}" uses the same emoji twice.`);
  }

  out.rolePanels = i.rolePanels === undefined ? prev.rolePanels : unique(list(i.rolePanels, 10).map((g) => ({
    id: slug(g.id), channelId: snow(g.channelId), title: text(g.title, 100, 'Roles'), description: text(g.description, 1000, 'Press a button to add or remove a role.'),
    roles: list(g.roles, 20).map((r) => ({ roleId: snow(r.roleId), label: text(r.label, 80), emoji: text(r.emoji, 64) })).filter((r) => r.roleId),
  })));
  for (const g of out.rolePanels) {
    if (!g.channelId) throw new Error(`Role panel "${g.title}" needs a channel.`);
    if (!g.roles.length) throw new Error(`Role panel "${g.title}" needs at least one role.`);
    for (const r of g.roles) if (!r.label) r.label = 'Role';
  }

  const t = i.tickets || {}, pt = prev.tickets;
  const cats = t.categories === undefined ? pt.categories : unique(list(t.categories, 25).map((c) => ({ id: slug(c.id), label: text(c.label, 80), description: text(c.description, 100), emoji: text(c.emoji, 64) })).filter((c) => c.label));
  if (!cats.length) throw new Error('Add at least one ticket category.');
  out.tickets = {
    channelId: t.channelId === undefined ? pt.channelId : snow(t.channelId), title: t.title === undefined ? pt.title : text(t.title, 100, 'Support'),
    description: t.description === undefined ? pt.description : text(t.description, 2000), color: t.color === undefined ? pt.color : color(t.color),
    placeholder: t.placeholder === undefined ? pt.placeholder : text(t.placeholder, 100, 'Select a ticket category…'), categoryId: t.categoryId === undefined ? pt.categoryId : snow(t.categoryId),
    limitPerUser: t.limitPerUser === undefined ? pt.limitPerUser : Math.round(num(t.limitPerUser, 1, 20, 1)), closerRoleIds: t.closerRoleIds === undefined ? pt.closerRoleIds : snowList(t.closerRoleIds, 25), categories: cats,
  };

  const s = i.shop || {}, ps = prev.shop;
  const methods = s.methods === undefined ? ps.methods : unique(list(s.methods, 25).map((m) => ({ id: slug(m.id), label: text(m.label, 80), description: text(m.description, 100) })).filter((m) => m.label));
  const plans = s.plans === undefined ? ps.plans : unique(list(s.plans, 25).map((p) => ({ id: slug(p.id), label: text(p.label, 80), description: text(p.description, 100), days: Math.round(num(p.days, 1, 3650, 7)), price: Math.round(num(p.price, 0, 100000, 0) * 100) / 100 })).filter((p) => p.label));
  if (!methods.length) throw new Error('Add at least one payment method.');
  if (!plans.length) throw new Error('Add at least one duration/price.');
  const planIds = new Set(plans.map((p) => p.id));
  const discounts = s.discounts === undefined ? ps.discounts : unique(list(s.discounts, 25).map((x) => ({ id: slug(x.id), label: text(x.label, 60), percent: Math.round(num(x.percent, 1, 100, 10)), active: flag(x.active, true), planIds: (Array.isArray(x.planIds) ? x.planIds : []).filter((p) => planIds.has(p)) })).map((x) => ({ ...x, label: x.label || `${x.percent}% off` })));
  out.shop = {
    channelId: s.channelId === undefined ? ps.channelId : snow(s.channelId), title: s.title === undefined ? ps.title : text(s.title, 100, 'Buy a membership'),
    description: s.description === undefined ? ps.description : text(s.description, 2000), color: s.color === undefined ? ps.color : color(s.color),
    placeholder: s.placeholder === undefined ? ps.placeholder : text(s.placeholder, 100, 'Select a duration…'), categoryId: s.categoryId === undefined ? ps.categoryId : snow(s.categoryId),
    currency: s.currency === undefined ? ps.currency : text(s.currency, 4, '€'), methods, plans, discounts,
  };

  const r = i.ratings || {}, pr = prev.ratings;
  out.ratings = { channelId: r.channelId === undefined ? pr.channelId : snow(r.channelId), feedbackChannelId: r.feedbackChannelId === undefined ? pr.feedbackChannelId : snow(r.feedbackChannelId) };
  const h = i.honeypot || {}, ph = prev.honeypot || d.honeypot;
  out.honeypot = {
    enabled: flag(h.enabled, ph.enabled), channelId: h.channelId === undefined ? ph.channelId : snow(h.channelId),
    action: h.action === undefined ? ph.action : (h.action === 'ban' ? 'ban' : 'kick'), logChannelId: h.logChannelId === undefined ? ph.logChannelId : snow(h.logChannelId),
    color: h.color === undefined ? ph.color : color(h.color, '#ef4444'), title: h.title === undefined ? ph.title : text(h.title, 100, d.honeypot.title),
    description: h.description === undefined ? ph.description : text(h.description, 2000),
  };
  if (out.honeypot.enabled && !out.honeypot.channelId) throw new Error('Pick the honeypot channel or turn the honeypot off.');
  if (out.honeypot.enabled && [out.tickets.channelId, out.shop.channelId].includes(out.honeypot.channelId)) throw new Error('The honeypot channel must not be a ticket or shop channel.');
  return out;
}

function createBotConfig(file) {
  let data = defaults();
  try { data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')), defaults()); } catch { /* first start or damaged file */ }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    get: () => data,
    replace(input) { data = sanitize(input, data); save(); return data; },
  };
}

module.exports = { createBotConfig, sanitize, defaults, SNOWFLAKE };
