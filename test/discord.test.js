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
    const ch = { id, sent: [], deleted: false, isTextBased: () => true, ...extra,
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
    reply(p) { this.replies.push(p); return Promise.resolve(); }, update(p) { this.updates.push(p); return Promise.resolve(); }, deferReply() { return Promise.resolve(); }, editReply(p) { this.replies.push(p); return Promise.resolve(); }, followUp(p) { this.replies.push(p); return Promise.resolve(); },
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
  const pick = w.select(buyer, 'shop:pay:week', ['paypal']);
  await w.handle(pick);
  const p = w.data.purchases()[0];
  assert.equal(p.status, 'open'); assert.equal(p.total, 3); assert.equal(p.methodLabel, 'PayPal');
  const channel = w.channels.get(p.channelId);
  assert.equal(channel.opts.name, 'ticket-from-bob');
  const embed = channel.sent[0].embeds[0].toJSON();
  assert.match(JSON.stringify(embed), /Current total/);

  // a second ticket is blocked by the limit
  const again = w.select(buyer, 'shop:pay:week', ['paypal']);
  await w.handle(again);
  assert.match(again.updates[0].content, /already have an open ticket/);
  assert.equal(w.data.purchases().length, 1);

  // only the configured roles can complete
  const denied = w.button(buyer, 'shop:complete', channel);
  await w.handle(denied);
  assert.match(denied.replies[0].content, /Only the configured team roles/);
  assert.equal(w.data.purchases()[0].status, 'open');

  // admin discount via modal changes the total
  const disc = w.modal(staff, 'shop:discountmodal', channel, { percent: '50' }, [ID.admin]);
  await w.handle(disc);
  assert.equal(w.data.purchase(p.id).total, 1.5);
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
  const ok = w.modal(buyer, 'shop:ratemodal', channel, { stars: '4', feedback: 'Fast and friendly' });
  await w.handle(ok);
  assert.equal(w.channels.get(ID.ratings).sent[0].content, `<@${ID.buyer}> bought something and left a rating of ⭐⭐⭐⭐ (4/5)`);
  assert.deepEqual(w.channels.get(ID.ratings).sent[0].allowedMentions, { parse: [] });
  assert.match(JSON.stringify(w.channels.get(ID.feedback).sent[0].embeds[0].toJSON()), /Fast and friendly/);
  const second = w.modal(buyer, 'shop:ratemodal', channel, { stars: '5' });
  await w.handle(second);
  assert.match(second.replies[0].content, /already rated/);
  assert.equal(w.channels.get(ID.ratings).sent.length, 1);

  // the buyer closes the ticket
  const t = setTimeout; global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.button(buyer, 'shop:close', channel)); } finally { global.setTimeout = t; }
  assert.equal(channel.deleted, true);
  assert.equal(w.data.openTicketsFor(ID.buyer).length, 0);

  // cancelled purchase: ticket closed, no stats
  await w.handle(w.select(buyer, 'shop:pay:week', ['paypal']));
  const p2 = w.data.purchases()[1];
  const ch2 = w.channels.get(p2.channelId);
  global.setTimeout = (fn) => { fn(); return 0; };
  try { await w.handle(w.button(staff, 'shop:cancel', ch2, [ID.admin])); } finally { global.setTimeout = t; }
  assert.equal(w.data.purchase(p2.id).status, 'cancelled');
  assert.equal(ch2.deleted, true);
  assert.equal(w.data.purchases().filter((x) => x.status === 'completed').length, 1);
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
  assert.match(no.replies[0].content, /Only the configured team roles/);
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
