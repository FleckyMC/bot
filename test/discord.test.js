'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('discord.js');
const util = require('../src/discord/util');
const { createBotConfig, sanitize, defaults } = require('../src/discord/config');
const { createBotData } = require('../src/discord/store');
const { createDiscordBot } = require('../src/discord/bot');
const { createFounderStore } = require('../src/founder');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dcbot-'));

test('pricing: best active discount, admin override, rounding', () => {
  const plan = { id: 'week', price: 3 };
  assert.deepEqual(util.quote(plan, []), { base: 3, percent: 0, discountLabel: '', total: 3 });
  const ds = [{ id: 'a', active: true, percent: 10, planIds: [], label: 'Launch' }, { id: 'b', active: true, percent: 25, planIds: ['month'], label: 'Month deal' }, { id: 'c', active: false, percent: 90, planIds: [] }];
  assert.equal(util.quote(plan, ds).total, 2.7);
  assert.equal(util.quote({ id: 'month', price: 10 }, ds).total, 7.5);
  assert.equal(util.quote(plan, ds, { percent: 50 }).total, 1.5);
  assert.equal(util.quote(plan, ds, { percent: 500 }).total, 0);
});

test('stars, templates, channel names', () => {
  assert.equal(util.stars(4), '⭐⭐⭐⭐');
  assert.equal(util.parseStars('5'), 5);
  assert.equal(util.parseStars(' 3 / 5 '), 3);
  for (const bad of ['0', '6', 'abc', '', '4.5']) assert.equal(util.parseStars(bad), null);
  assert.equal(util.fillTemplate('Hi {user} to {server} #{count} {nope}', { user: '<@1>', server: 'S', count: 7 }), 'Hi <@1> to S #7 {nope}');
  assert.equal(util.ticketChannelName('Hans Müller!'), 'ticket-from-hans-m-ller');
  assert.equal(util.durationLabel(7), '1 week');
  assert.equal(util.durationLabel(30), '1 month');
});

test('config validation rejects malformed input and keeps defaults', () => {
  const c = sanitize({ guildId: 'not-an-id', adminRoleIds: ['123456789012345678', 'x', '123456789012345678'], tickets: { limitPerUser: 99, color: 'red' } });
  assert.equal(c.guildId, '');
  assert.deepEqual(c.adminRoleIds, ['123456789012345678']);
  assert.equal(c.tickets.limitPerUser, 20);
  assert.equal(c.tickets.color, '#8b5cf6');
  assert.throws(() => sanitize({ welcome: { enabled: true } }), /channel/);
  assert.throws(() => sanitize({ autorole: { enabled: true, roleIds: [] } }), /no role/);
  assert.throws(() => sanitize({ shop: { plans: [] } }), /duration/);
  assert.throws(() => sanitize({ reactionRoles: [{ channelId: '123456789012345678', pairs: [] }] }), /emoji/);
  assert.throws(() => sanitize({ reactionRoles: [{ channelId: '123456789012345678', pairs: [{ emoji: '👍', roleId: '123456789012345678' }, { emoji: '👍', roleId: '223456789012345678' }] }] }), /twice/);
  const p = sanitize({ shop: { plans: [{ id: 'x', label: 'Month', days: 30, price: 9.999 }], discounts: [{ percent: 20, planIds: ['x', 'nope'] }] } });
  assert.equal(p.shop.plans[0].price, 10);
  assert.deepEqual(p.shop.discounts[0].planIds, ['x']);
  assert.equal(p.shop.discounts[0].label, '20% off');
});

test('config and data stores persist', () => {
  const dir = tmp();
  const cfg = createBotConfig(path.join(dir, 'bot.json'));
  cfg.replace({ guildId: '123456789012345678', tickets: { limitPerUser: 3 } });
  assert.equal(createBotConfig(path.join(dir, 'bot.json')).get().tickets.limitPerUser, 3);
  const data = createBotData(path.join(dir, 'd.json'));
  data.addTicket({ channelId: 'c1', userId: 'u1', kind: 'support' });
  assert.equal(createBotData(path.join(dir, 'd.json')).openTicketsFor('u1').length, 1);
  data.closeTicket('c1');
  assert.equal(data.openTicketsFor('u1').length, 0);
});

test('founder store validates and hides the bot token', () => {
  const f = createFounderStore(path.join(tmp(), 'f.json'));
  assert.throws(() => f.update({ botToken: 'short' }), /token/);
  const token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GabcDE.' + 'x'.repeat(30);
  f.update({ botToken: token });
  const v = f.publicView();
  assert.equal(v.hasBotToken, true);
  assert.ok(!JSON.stringify(v).includes(token));
  f.update({ clearBotToken: true });
  assert.equal(f.publicView().hasBotToken, false);
});

// ---------------------------------------------------------------- fake Discord server for the interaction flow

const ID = { guild: '111111111111111111', admin: '222222222222222222', ratings: '333333333333333333', feedback: '444444444444444444', buyer: '555555555555555555', bot: '999999999999999999', staff: '666666666666666666', cat: '777777777777777777' };

function world() {
  const dir = tmp();
  const config = createBotConfig(path.join(dir, 'bot.json'));
  config.replace({ guildId: ID.guild, adminRoleIds: [ID.admin], ratings: { channelId: ID.ratings, feedbackChannelId: ID.feedback }, tickets: { limitPerUser: 1 } });
  const data = createBotData(path.join(dir, 'd.json'));
  const events = [];
  const channels = new Map();
  let n = 0;
  const makeChannel = (id, extra = {}) => {
    const msgs = new Map();
    const ch = { id, sent: [], deleted: false, access: new Map(), isTextBased: () => true, ...extra,
      permissionOverwrites: { edit: async (uid, perms) => { ch.access.set(uid, perms); }, delete: async (uid) => { ch.access.delete(uid); } },
      messages: { fetch: async (mid) => msgs.get(mid) || null },
      send: async (payload) => { const m = { id: 'm' + (++n), payload, edits: [], edit: async (p) => { m.edits.push(p); return m; } }; msgs.set(m.id, m); ch.sent.push(payload); return m; },
      delete: async () => { ch.deleted = true; channels.delete(id); } };
    channels.set(id, ch);
    return ch;
  };
  makeChannel(ID.ratings); makeChannel(ID.feedback);
  const guild = { id: ID.guild, ownerId: 'owner', name: 'Meltrovia', memberCount: 5,
    roles: { everyone: { id: ID.guild }, cache: new Map([[ID.admin, {}]]) },
    channels: { cache: { has: (id) => channels.has(id), get: (id) => channels.get(id) }, fetch: async (id) => channels.get(id) || null,
      create: async (opts) => { const ch = makeChannel('9' + String(++n).padStart(17, '0'), { opts }); return ch; } } };
  const client = { user: { id: ID.bot }, guilds: { cache: { size: 1, first: () => guild, get: () => guild } } };
  const bot = createDiscordBot({ founder: { get: () => ({ botToken: '' }) }, config, data, log: () => {}, onEvent: (t, i) => events.push([t, i]) });
  bot._handlers.setClient(client, D);
  const member = (id, roles = []) => ({ id, guild, roles: { cache: new Set(roles) } });
  const base = (user, roles, channel, extra = {}) => ({
    guildId: ID.guild, guild, user, member: member(user.id, roles), channel, channelId: channel ? channel.id : null, replies: [], updates: [],
    reply(p) { this.replies.push(p); return Promise.resolve(); }, update(p) { this.updates.push(p); return Promise.resolve(); }, deferReply() { return Promise.resolve(); }, deferUpdate() { this.deferred = true; return Promise.resolve(); }, editReply(p) { this.replies.push(p); return Promise.resolve(); }, followUp(p) { this.replies.push(p); return Promise.resolve(); },
    showModal(m) { this.modal = m; return Promise.resolve(); }, isChatInputCommand: () => false, isStringSelectMenu: () => false, isButton: () => false, isModalSubmit: () => false, ...extra });
  const select = (user, customId, values, roles = []) => base(user, roles, null, { customId, values, isStringSelectMenu: () => true, message: { edit: async () => {} } });
  const button = (user, customId, channel, roles = []) => base(user, roles, channel, { customId, isButton: () => true });
  const modal = (user, customId, channel, fields, roles = []) => base(user, roles, channel, { customId, isModalSubmit: () => true, fields: { getTextInputValue: (k) => fields[k] ?? '' } });
  return { bot, data, config, events, channels, guild, select, button, modal, handle: (i) => bot._handlers.onInteraction(i) };
}
const buyer = { id: ID.buyer, username: 'Bob', tag: 'Bob#0' };
const staff = { id: ID.staff, username: 'Sam', tag: 'Sam#0' };

test('purchase flow: order → discount → complete → rating → close, and cancel closes the ticket', async () => {
  const w = world();
  const pick = w.select(buyer, 'shop:pay:week:1', ['paypal']);
  await w.handle(pick);
  const p = w.data.purchases()[0];
  assert.equal(p.status, 'open'); assert.equal(p.total, 1); assert.equal(p.methodLabel, 'PayPal');
  const channel = w.channels.get(p.channelId);
  assert.equal(channel.opts.name, 'ticket-from-bob');
  const embed = channel.sent[0].embeds[0].toJSON();
  assert.match(JSON.stringify(embed), /Current total/);

  // a second ticket is blocked by the limit
  const again = w.select(buyer, 'shop:pay:week:1', ['paypal']);
  await w.handle(again);
  assert.match(again.updates[0].content, /already have an open ticket/);
  assert.equal(w.data.purchases().length, 1);

  // only the configured roles can complete
  const denied = w.button(buyer, 'shop:complete', channel);
  await w.handle(denied);
  assert.match(denied.replies[0].content, /Only the purchase admins/);
  assert.equal(w.data.purchases()[0].status, 'open');

  // admin discount via modal changes the total
  const disc = w.modal(staff, 'shop:discountmodal', channel, { percent: '50' }, [ID.admin]);
  await w.handle(disc);
  assert.equal(w.data.purchase(p.id).total, 0.5);
  const bad = w.modal(staff, 'shop:discountmodal', channel, { percent: '150' }, [ID.admin]);
  await w.handle(bad);
  assert.match(bad.replies[0].content, /between 0 and 100/);

  const done = w.button(staff, 'shop:complete', channel, [ID.admin]);
  await w.handle(done);
  assert.equal(w.data.purchase(p.id).status, 'completed');
  assert.equal(w.data.purchase(p.id).completedByName, 'Sam');
  assert.ok(w.events.some(([t]) => t === 'purchase_completed'));
  const thanks = channel.sent.at(-1);
  assert.match(JSON.stringify(thanks.embeds[0].toJSON()), /Thank you for your purchase/);
  const labels = thanks.components[0].components.map((c) => c.toJSON().label);
  assert.deepEqual(labels, ['Leave a rating', 'Close ticket']);

  // completing twice does nothing
  const twice = w.button(staff, 'shop:complete', channel, [ID.admin]);
  await w.handle(twice);
  assert.match(twice.replies[0].content, /already finished/);

  // only the buyer may rate
  const stranger = w.button(staff, 'shop:rate', channel, [ID.admin]);
  await w.handle(stranger);
  assert.match(stranger.replies[0].content, /Only the buyer/);
  const rate = w.button(buyer, 'shop:rate', channel);
  await w.handle(rate);
  const m = rate.modal.toJSON();
  assert.equal(m.components.length, 2);
  assert.match(m.components[0].components[0].label, /How many stars/);
  assert.equal(m.components[1].components[0].required, false);
  assert.match(m.components[1].components[0].label, /Any feedback for us/);

  const invalid = w.modal(buyer, 'shop:ratemodal', channel, { stars: '9' });
  await w.handle(invalid);
  assert.match(invalid.replies[0].content, /1 to 5/);
  const t = setTimeout; global.setTimeout = (fn) => { fn(); return 0; };
  const ok = w.modal(buyer, 'shop:ratemodal', channel, { stars: '4', feedback: 'Fast and friendly' });
  try { await w.handle(ok); } finally { global.setTimeout = t; }
  const card = w.channels.get(ID.ratings).sent[0].embeds[0].toJSON();
  assert.equal(card.description, `<@${ID.buyer}> bought something from <@${ID.staff}> and left a rating of ⭐⭐⭐⭐ (4/5)`);
  assert.deepEqual(card.fields.map((f) => f.name), ['🛒 Buyer', '🧑‍💼 Seller', '⭐ Rating', '📦 Product', '💶 Price', '💳 Payment']);
  assert.match(JSON.stringify(card), /⭐⭐⭐⭐☆/);
  assert.deepEqual(w.channels.get(ID.ratings).sent[0].allowedMentions, { parse: [] });
  assert.match(JSON.stringify(w.channels.get(ID.feedback).sent[0].embeds[0].toJSON()), /Fast and friendly/);
  assert.match(ok.replies[0], /close in 5 seconds/);
  // the ticket closes by itself after the rating
  assert.equal(channel.deleted, true);
  assert.equal(w.data.openTicketsFor(ID.buyer).length, 0);
  assert.equal(w.channels.get(ID.ratings).sent.length, 1);

  // the close button works for a buyer who skips the rating
  await w.handle(w.select(buyer, 'shop:pay:week:1', ['paypal']));
  const p3 = w.data.purchases()[1];
  const ch3 = w.channels.get(p3.channelId);
  await w.handle(w.button(staff, 'shop:complete', ch3, [ID.admin]));
  global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.button(buyer, 'shop:close', ch3)); } finally { global.setTimeout = t; }
  assert.equal(ch3.deleted, true);

  // cancelled purchase: ticket closed, no stats
  await w.handle(w.select(buyer, 'shop:pay:week:1', ['paypal']));
  const p2 = w.data.purchases()[2];
  const ch2 = w.channels.get(p2.channelId);
  global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.button(staff, 'shop:cancel', ch2, [ID.admin])); } finally { global.setTimeout = t; }
  assert.equal(w.data.purchase(p2.id).status, 'cancelled');
  assert.equal(ch2.deleted, true);
  assert.equal(w.data.purchases().filter((x) => x.status === 'completed').length, 2);
});

test('support tickets: any member opens, only team roles close, deleted channels free the limit', async () => {
  const w = world();
  const open = w.select(buyer, 'tk:open', ['support']);
  await w.handle(open);
  const t = w.data.openTicketsFor(ID.buyer)[0];
  assert.ok(t);
  const channel = w.channels.get(t.channelId);
  const ov = channel.opts.permissionOverwrites;
  assert.ok(ov.some((o) => o.id === ID.guild && o.deny.length), '@everyone is denied');
  assert.ok(ov.some((o) => o.id === ID.admin && o.allow.length), 'team role has access');
  const no = w.button(buyer, 'tk:close', channel);
  await w.handle(no);
  assert.match(no.replies[0].content, /Only the support roles/);
  // channel deleted by hand: the user can open a new ticket again
  w.channels.delete(channel.id);
  await w.handle(w.select(buyer, 'tk:open', ['support']));
  assert.equal(w.data.openTicketsFor(ID.buyer).length, 1);
  assert.notEqual(w.data.openTicketsFor(ID.buyer)[0].channelId, channel.id);
});

test('role toggle buttons and reaction roles add and remove roles', async () => {
  const w = world();
  const roleId = '888888888888888888';
  w.config.replace({ rolePanels: [{ id: 'p1', channelId: ID.ratings, title: 'Roles', roles: [{ roleId, label: 'News' }] }], reactionRoles: [{ id: 'r1', channelId: ID.ratings, title: 'Pick', pairs: [{ emoji: '👍', roleId }] }] });
  const calls = [];
  const member = { id: ID.buyer, roles: { cache: new Set(), add: async (r) => { calls.push(['add', r]); member.roles.cache.add(r); }, remove: async (r) => { calls.push(['remove', r]); member.roles.cache.delete(r); } } };
  const click = () => { const i = w.button(buyer, `role:p1:${roleId}`, null); i.member = member; return i; };
  const a = click(); await w.handle(a); const b = click(); await w.handle(b);
  assert.deepEqual(calls, [['add', roleId], ['remove', roleId]]);
  assert.match(a.replies[0].content, /now have/); assert.match(b.replies[0].content, /Removed/);

  w.data.setPanel('rr:r1', { channelId: ID.ratings, messageId: 'msg1' });
  w.guild.members = { fetch: async () => member };
  const reaction = (emoji) => ({ partial: false, message: { id: 'msg1', guildId: ID.guild }, emoji: { id: null, name: emoji } });
  await w.bot._handlers.onReaction(reaction('👍'), { id: ID.buyer, bot: false }, true);
  await w.bot._handlers.onReaction(reaction('👎'), { id: ID.buyer, bot: false }, true);
  await w.bot._handlers.onReaction(reaction('👍'), { id: ID.buyer, bot: false }, false);
  await w.bot._handlers.onReaction(reaction('👍'), { id: 'x', bot: true }, true);
  assert.deepEqual(calls.slice(2), [['add', roleId], ['remove', roleId]]);
});

test('welcome message, leave message and autorole', async () => {
  const w = world();
  const roleId = '888888888888888888';
  w.config.replace({ welcome: { enabled: true, channelId: ID.ratings, message: 'Hi {user}, welcome to {server} (#{count})', embed: false }, leave: { enabled: true, channelId: ID.feedback, message: '{username} left', embed: false }, autorole: { enabled: true, roleIds: [roleId], ignoreBots: true } });
  const added = [];
  const mk = (isBot) => ({ id: ID.buyer, guild: w.guild, user: { username: 'Bob', bot: isBot, displayAvatarURL: () => 'x' }, roles: { add: async (r) => added.push(r) } });
  await w.bot._handlers.onMemberAdd(mk(false));
  await w.bot._handlers.onMemberAdd(mk(true));
  assert.deepEqual(added, [roleId]);
  assert.equal(w.channels.get(ID.ratings).sent[0].content, `Hi <@${ID.buyer}>, welcome to Meltrovia (#5)`);
  await w.bot._handlers.sendGreeting('leave', mk(false));
  assert.equal(w.channels.get(ID.feedback).sent[0].content, 'Bob left');
  assert.deepEqual(w.channels.get(ID.feedback).sent[0].allowedMentions, { parse: [] });
});

test('kick and ban need an admin role and respect the role hierarchy', async () => {
  const w = world();
  const calls = [];
  const target = (pos) => ({ id: '123123123123123123', kickable: true, bannable: true, roles: { highest: { position: pos } }, kick: async (r) => calls.push(['kick', r]) });
  w.guild.members = { ban: async (u, o) => calls.push(['ban', u.id, o.deleteMessageSeconds]) };
  const cmd = (user, roles, name, opts, tgt) => {
    const i = w.button(user, null, null, roles);
    Object.assign(i, { commandName: name, isButton: () => false, isChatInputCommand: () => true, member: { ...i.member, roles: { cache: new Set(roles), highest: { position: 10 } } },
      options: { getString: (k) => opts[k] || null, getInteger: (k) => opts[k] ?? null, getUser: () => ({ id: '123123123123123123', username: 'Troll' }), getMember: () => tgt } });
    return i;
  };
  const nope = cmd(buyer, [], 'kick', {}, target(1)); await w.handle(nope);
  assert.match(nope.replies[0].content, /admin roles/);
  const higher = cmd(staff, [ID.admin], 'kick', {}, target(20)); await w.handle(higher);
  assert.match(higher.replies[0].content, /same or a higher role/);
  const k = cmd(staff, [ID.admin], 'kick', { reason: 'spam' }, target(1)); await w.handle(k);
  assert.equal(calls[0][0], 'kick'); assert.match(calls[0][1], /spam \(by Sam\)/);
  const b = cmd(staff, [ID.admin], 'ban', { delete_days: 2 }, target(1)); await w.handle(b);
  assert.deepEqual(calls[1], ['ban', '123123123123123123', 172800]);
  assert.ok(w.events.some(([t]) => t === 'kick') && w.events.some(([t]) => t === 'ban'));
});

test('default config builds valid panels', () => {
  const w = world();
  assert.ok(defaults().tickets.categories.length);
  assert.ok(w.bot.status().status === 'online');
});

test('panels can be posted, and re-posting edits the same message', async () => {
  const w = world();
  const roleId = '888888888888888888';
  w.config.replace({ tickets: { channelId: ID.ratings, categories: [{ id: 'support', label: 'Support', description: 'Help', emoji: '🎫' }, { id: 'bug', label: 'Bug report' }] },
    shop: { channelId: ID.ratings, plans: [{ id: 'week', label: '1 week', days: 7, price: 3 }, { id: 'month', label: '1 month', days: 30, price: 10 }], discounts: [{ label: 'Launch', percent: 20, active: true }] },
    rolePanels: [{ id: 'p1', channelId: ID.ratings, title: 'Roles', roles: [{ roleId, label: 'News', emoji: '📰' }] }],
    reactionRoles: [{ id: 'r1', channelId: ID.ratings, title: 'Pick', pairs: [{ emoji: '👍', roleId }] }] });
  const ch = w.channels.get(ID.ratings);
  const origSend = ch.send;
  ch.send = async (p) => { const m = await origSend(p); m.reactions = { cache: new Map() }; m.react = async () => {}; return m; };
  for (const [kind, id] of [['tickets'], ['shop'], ['rolePanel', 'p1'], ['reactionRole', 'r1']]) await w.bot.postPanel(kind, id);
  assert.equal(ch.sent.length, 4);
  const shop = ch.sent[1];
  assert.match(JSON.stringify(shop.embeds[0].toJSON()), /20%/);
  assert.equal(shop.components[0].components[0].toJSON().options.length, 2);
  const again = ch.sent.length;
  await w.bot.postPanel('tickets');
  assert.equal(ch.sent.length, again, 'edited instead of posting again');
  await assert.rejects(() => w.bot.postPanel('rolePanel', 'missing'), /Save the role panel/);
});

test('honeypot: deletes the message and kicks/bans, ignores admins and bots and other channels', async () => {
  const w = world();
  const HP = '123123123123123123';
  w.config.replace({ honeypot: { enabled: true, channelId: HP, action: 'kick', logChannelId: ID.feedback } });
  const calls = [];
  const msg = (extra = {}) => ({ guildId: ID.guild, channelId: HP, webhookId: null, content: 'buy cheap stuff', author: { id: ID.buyer, username: 'Spam', bot: false },
    member: { id: ID.buyer, guild: w.guild, kickable: true, roles: { cache: new Set() }, kick: async (r) => calls.push(['kick', r]) }, delete: async () => calls.push(['delete']), ...extra });
  await w.bot._handlers.onMessage(msg());
  assert.deepEqual(calls.map((c) => c[0]), ['delete', 'kick']);
  assert.match(JSON.stringify(w.channels.get(ID.feedback).sent[0].embeds[0].toJSON()), /Honeypot triggered/);
  calls.length = 0;
  await w.bot._handlers.onMessage(msg({ channelId: ID.ratings }));
  await w.bot._handlers.onMessage(msg({ author: { id: ID.buyer, username: 'Bot', bot: true } }));
  await w.bot._handlers.onMessage(msg({ member: { id: ID.staff, guild: w.guild, kickable: true, roles: { cache: new Set([ID.admin]) }, kick: async () => calls.push(['kick']) } }));
  assert.deepEqual(calls, []);
  // ban mode
  w.config.replace({ honeypot: { action: 'ban' } });
  w.guild.members = { ban: async (id, o) => calls.push(['ban', id, o.deleteMessageSeconds]) };
  await w.bot._handlers.onMessage(msg());
  assert.deepEqual(calls.at(-1), ['ban', ID.buyer, 3600]);
  assert.throws(() => w.config.replace({ honeypot: { enabled: true, channelId: '' } }), /honeypot channel/);
});

test('honeypot warning can be posted', async () => {
  const w = world();
  w.config.replace({ honeypot: { enabled: true, channelId: ID.ratings } });
  await w.bot.postPanel('honeypot');
  assert.match(JSON.stringify(w.channels.get(ID.ratings).sent[0].embeds[0].toJSON()), /kicked from the server/);
});

test('shop: the buyer enters the amount and the total is amount × price per unit', async () => {
  const w = world();
  w.config.replace({ shop: { plans: [{ id: 'week', label: '1 week', days: 7, price: 1 }], minQuantity: 1, maxQuantity: 52 } });
  assert.equal(w.config.get().shop.plans[0].label, 'week');
  // choosing the unit opens a modal asking how many
  const pick = w.select(buyer, 'shop:plan', ['week']);
  await w.handle(pick);
  // the TOS must be accepted first
  assert.ok(!pick.modal);
  assert.equal(pick.replies[0].components[0].toJSON().components[0].custom_id, 'shop:tos:week');
  const acc = w.button(buyer, 'shop:tos:week');
  await w.handle(acc);
  assert.match(acc.modal.toJSON().components[0].components[0].label, /How many weeks/);
  for (const bad of ['0', '99', 'abc', '2.5', '']) {
    const m = w.modal(buyer, 'shop:qty:week', null, { qty: bad });
    await w.handle(m);
    assert.match(m.replies[0].content, /whole number from 1 to 52/);
  }
  const ok = w.modal(buyer, 'shop:qty:week', null, { qty: '5' });
  await w.handle(ok);
  assert.match(ok.replies[0].content, /5 weeks.*35 days.*5\.00/);
  const payRow = ok.replies[0].components[0].toJSON().components[0];
  assert.equal(payRow.custom_id, 'shop:pay:week:5');
  await w.handle(w.select(buyer, 'shop:pay:week:5', ['paypal']));
  const p = w.data.purchases()[0];
  assert.equal(p.planLabel, '5 weeks'); assert.equal(p.days, 35); assert.equal(p.basePrice, 5); assert.equal(p.total, 5);
  const channel = w.channels.get(p.channelId);
  assert.match(JSON.stringify(channel.sent[0].embeds[0].toJSON()), /5 weeks/);
  // tampered amount in the custom id is rejected
  const hack = w.select({ id: '555555555555555556', username: 'Eve', tag: 'E#0' }, 'shop:pay:week:9999', ['paypal']);
  await w.handle(hack);
  assert.match(hack.updates[0].content, /no longer exists/);
  // an active discount applies to the whole amount
  w.config.replace({ shop: { discounts: [{ label: 'Launch', percent: 20, active: true }] } });
  const m2 = w.modal({ id: '555555555555555557', username: 'Fay', tag: 'F#0' }, 'shop:qty:week', null, { qty: '10' });
  await w.handle(m2);
  assert.match(m2.replies[0].content, /8\.00/);
  assert.throws(() => w.config.replace({ shop: { minQuantity: 10, maxQuantity: 5 } }), /Minimum/);
});

test('posting a panel explains missing channel permissions', async () => {
  const w = world();
  w.config.replace({ tickets: { channelId: ID.ratings } });
  const ch = w.channels.get(ID.ratings);
  ch.name = 'tickets';
  w.guild.members = { me: { id: ID.bot } };
  ch.permissionsFor = () => ({ has: (bit) => bit !== D.PermissionFlagsBits.EmbedLinks });
  await assert.rejects(() => w.bot.postPanel('tickets'), /missing permissions in #tickets: Embed Links/);
  ch.permissionsFor = () => ({ has: () => true });
  ch.send = async () => { const e = new Error('Missing Permissions'); e.code = 50013; throw e; };
  await assert.rejects(() => w.bot.postPanel('tickets'), /may not post in #tickets/);
});

test('claim system: seller roles per payment method, claim/unclaim, access only for the claimer, seller in the rating', async () => {
  const w = world();
  const PP = '888888888888888881', PS = '888888888888888882', CAT = '777777777777777771', CLAIM_PP = '333333333333333330', CLAIM_ALL = '333333333333333331';
  const S1 = { id: '666666666666666661', username: 'Sel1', tag: 'S1#0' }, S2 = { id: '666666666666666662', username: 'Sel2', tag: 'S2#0' }, PPS = { id: '666666666666666663', username: 'PayPalSeller', tag: 'P#0' };
  for (const r of [PP, PS]) w.guild.roles.cache.set(r, {});
  const mkc = (id, extra) => { const ch = { id, sent: [], access: new Map(), isTextBased: () => true, ...extra, messages: { fetch: async (mid) => ch.msgs.get(mid) || null }, msgs: new Map(),
    send: async (p) => { const m = { id: 'n' + (ch.msgs.size + 1), payload: p, edits: [], edit: async (e) => { m.edits.push(e); return m; } }; ch.msgs.set(m.id, m); ch.sent.push(p); return m; } }; w.channels.set(id, ch); return ch; };
  const claimPP = mkc(CLAIM_PP), claimAll = mkc(CLAIM_ALL); mkc(CAT, { type: D.ChannelType.GuildCategory });
  const PA = '888888888888888889', PAUSER = { id: '666666666666666669', username: 'Boss2', tag: 'B#0' }; w.guild.roles.cache.set(PA, {});
  w.config.replace({ shop: { adminRoleIds: [PA], claimChannelId: CLAIM_ALL, methods: [
    { id: 'paypal', label: 'PayPal', roleId: PP, categoryId: CAT, claimChannelId: CLAIM_PP },
    { id: 'paysafe', label: 'Paysafe', roleId: PS } ] } });
  assert.equal(w.config.get().shop.methods[0].roleId, PP);

  // buyer orders 5 weeks with Paysafe -> default claim channel, pings the Paysafe seller role, no admin access to the ticket
  await w.handle(w.select(buyer, 'shop:pay:week:5', ['paysafe']));
  let p = w.data.purchases()[0];
  assert.equal(p.claimChannelId, CLAIM_ALL);
  const ticket = w.channels.get(p.channelId);
  assert.ok(!ticket.opts.permissionOverwrites.some((o) => o.id === ID.admin), 'admin roles are not added to seller tickets');
  assert.ok(!ticket.opts.permissionOverwrites.some((o) => o.id === PS), 'the seller role is not added either');
  const note = claimAll.sent[0];
  assert.equal(note.content, `<@&${PS}> There's a new customer!`);
  assert.deepEqual(note.allowedMentions, { roles: [PS] });
  assert.match(JSON.stringify(note.embeds[0].toJSON()), /5 weeks/);
  assert.equal(note.components[0].components[0].toJSON().label, 'Claim ticket');
  const notifyId = p.notifyMessageId;
  const click = (user, id, roles, ch) => { const i = w.button(user, id, ch || claimAll, roles); i.message = { id: notifyId }; return i; };

  // wrong role, own order, then a valid claim
  const wrong = click(PPS, 'shop:claim', [PP]); await w.handle(wrong);
  assert.match(wrong.replies[0].content, /Only <@&888888888888888882> can claim/);
  const own = click(buyer, 'shop:claim', [PS]); await w.handle(own);
  assert.match(own.replies[0].content, /own order/);
  const c1 = click(S1, 'shop:claim', [PS]); await w.handle(c1);
  p = w.data.purchase(p.id);
  assert.equal(p.claimedBy, S1.id);
  assert.ok(ticket.access.has(S1.id), 'only the claimer is added to the ticket');
  assert.equal(ticket.access.size, 1);
  assert.equal(ticket.sent.at(-1).content, `Ticket claimed by <@${S1.id}>`);
  const noteMsg = claimAll.msgs.get(notifyId);
  assert.equal(noteMsg.edits.at(-1).components[0].components[0].toJSON().label, 'Unclaim ticket');

  // nobody else can claim while it is claimed; nobody but the claimer may handle it
  const c2 = click(S2, 'shop:claim', [PS]); await w.handle(c2);
  assert.match(c2.replies[0].content, /already claimed by <@666666666666666661>/);
  for (const [user, roles] of [[S2, [PS]], [staff, [ID.admin]], [buyer, []]]) {
    const done = w.button(user, 'shop:complete', ticket, roles); await w.handle(done);
    assert.match(done.replies[0].content, /Only the seller who claimed/);
  }

  // unclaim: access removed, message in the ticket, claimable again
  const un2 = click(S2, 'shop:unclaim', [PS]); await w.handle(un2);
  assert.match(un2.replies[0].content, /can unclaim/);
  // moderation roles are not purchase admins any more; purchase admins may take over
  const modTry = click(staff, 'shop:unclaim', [ID.admin]); await w.handle(modTry);
  assert.match(modTry.replies[0].content, /purchase admins can unclaim/);
  const un = click(PAUSER, 'shop:unclaim', [PA]); await w.handle(un);
  assert.equal(ticket.access.size, 0);
  assert.equal(ticket.sent.at(-1).content, `Ticket has been unclaimed by <@${PAUSER.id}>`);
  assert.equal(w.data.purchase(p.id).claimedBy, null);
  assert.equal(noteMsg.edits.at(-1).components[0].components[0].toJSON().label, 'Claim ticket');
  const early = w.button(S1, 'shop:complete', ticket, [PS]); await w.handle(early);
  assert.match(early.replies[0].content, /Claim this ticket first/);

  // another seller claims, completes, and the rating names the seller
  await w.handle(click(S2, 'shop:claim', [PS]));
  await w.handle(w.button(S2, 'shop:complete', ticket, [PS]));
  p = w.data.purchase(p.id);
  assert.equal(p.status, 'completed'); assert.equal(p.sellerId, S2.id);
  assert.equal(noteMsg.edits.at(-1).components.length, 0);
  const t0 = setTimeout; global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.modal(buyer, 'shop:ratemodal', ticket, { stars: '5', feedback: 'great' })); } finally { global.setTimeout = t0; }
  assert.equal(w.channels.get(ID.ratings).sent[0].embeds[0].toJSON().description, `<@${ID.buyer}> bought something from <@${S2.id}> and left a rating of ⭐⭐⭐⭐⭐ (5/5)`);
  assert.equal(ticket.deleted, true);
  assert.match(JSON.stringify(w.channels.get(ID.feedback).sent[0].embeds[0].toJSON()), /Seller/);

  // PayPal has its own claim channel and its own category
  const buyer2 = { id: '555555555555555558', username: 'Zed', tag: 'Z#0' };
  await w.handle(w.select(buyer2, 'shop:pay:week:1', ['paypal']));
  const p2 = w.data.purchases()[1];
  assert.equal(p2.claimChannelId, CLAIM_PP);
  assert.equal(w.channels.get(p2.channelId).opts.parent, CAT);
  assert.equal(claimPP.sent[0].content, `<@&${PP}> There's a new customer!`);
});

test('roles are separate: moderation, support (per category) and purchase admins', async () => {
  const w = world();
  const SUP = '888888888888888871', BUG = '888888888888888872', PA = '888888888888888873';
  for (const r of [SUP, BUG, PA]) w.guild.roles.cache.set(r, {});
  w.config.replace({ tickets: { closerRoleIds: [SUP], categories: [{ id: 'support', label: 'Support' }, { id: 'bug', label: 'Bug report', roleIds: [BUG] }] }, shop: { adminRoleIds: [PA] } });
  // general support category: support roles get access, moderation roles do not
  await w.handle(w.select(buyer, 'tk:open', ['support']));
  const t1 = w.data.openTicketsFor(ID.buyer)[0]; const c1 = w.channels.get(t1.channelId);
  const ids = (c) => c.opts.permissionOverwrites.map((o) => o.id);
  assert.ok(ids(c1).includes(SUP) && !ids(c1).includes(ID.admin) && !ids(c1).includes(BUG));
  const noMod = w.button(staff, 'tk:close', c1, [ID.admin]); await w.handle(noMod);
  assert.match(noMod.replies[0].content, /support roles/);
  const noBug = w.button(staff, 'tk:close', c1, [BUG]); await w.handle(noBug);
  assert.match(noBug.replies[0].content, /support roles/);
  const t = setTimeout; global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.button(staff, 'tk:close', c1, [SUP])); } finally { global.setTimeout = t; }
  assert.equal(c1.deleted, true);
  // a category with its own roles uses only those
  await w.handle(w.select(buyer, 'tk:open', ['bug']));
  const c2 = w.channels.get(w.data.openTicketsFor(ID.buyer)[0].channelId);
  assert.ok(ids(c2).includes(BUG) && !ids(c2).includes(SUP) && !ids(c2).includes(ID.admin));
  // moderation roles keep kick/ban only; purchase admins are separate (no claim channel -> they join purchase tickets)
  await w.handle(w.select({ id: '555555555555555560', username: 'Kim', tag: 'K#0' }, 'shop:pay:week:1', ['paypal']));
  const c3 = w.channels.get(w.data.purchases()[0].channelId);
  assert.ok(ids(c3).includes(PA) && !ids(c3).includes(ID.admin) && !ids(c3).includes(SUP));
  const nope = w.button(staff, 'shop:complete', c3, [ID.admin]); await w.handle(nope);
  assert.match(nope.replies[0].content, /purchase admins/);
  await w.handle(w.button(staff, 'shop:complete', c3, [PA]));
  assert.equal(w.data.purchases()[0].status, 'completed');
});

test('a ticket that cannot be deleted tells people what to do', async () => {
  const w = world();
  await w.handle(w.select(buyer, 'tk:open', ['support']));
  const t = w.data.openTicketsFor(ID.buyer)[0]; const ch = w.channels.get(t.channelId);
  ch.delete = async () => { throw new Error('Missing Permissions'); };
  const old = setTimeout; global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.button(staff, 'tk:close', ch, [ID.admin])); await new Promise((r) => setImmediate(r)); } finally { global.setTimeout = old; }
  assert.match(ch.sent.at(-1), /Manage Channels/);
});
