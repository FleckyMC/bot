'use strict';
const { quote, stars, parseStars, fillTemplate, ticketChannelName, unitText, money } = require('./util');

/**
 * The Discord bot: welcome/leave messages, autorole, reaction roles, role toggle panels, tickets, the purchase panel
 * (orders, discounts, completing/cancelling, ratings) and kick/ban commands.
 * discord.js is only loaded when the bot is started, so the dashboard runs fine without a token.
 */
const TOKEN_HELP = {
  TokenInvalid: 'The bot token is invalid. Copy it again from the Discord developer portal (Bot → Reset Token).',
  DisallowedIntents: 'Enable "Server Members Intent" in the Discord developer portal (Bot → Privileged Gateway Intents) and start the bot again.',
};
const emojiKey = (e) => String(e || '').replace(/️/g, '').trim();
const customEmoji = (e) => { const m = String(e || '').match(/^<(a?):(\w{2,32}):(\d{15,25})>$/); return m ? { id: m[3], name: m[2], animated: !!m[1] } : null; };
const emojiOption = (e) => { const s = String(e || '').trim(); if (!s) return undefined; return customEmoji(s) || { name: s }; };
const reactionKey = (r) => (r.emoji.id ? r.emoji.id : emojiKey(r.emoji.name));
const configKey = (e) => { const c = customEmoji(e); return c ? c.id : emojiKey(e); };

function createDiscordBot({ founder, config, data, log = () => {}, onEvent = () => {} }) {
  let D = null, client = null, status = 'offline', error = '', startedAt = 0, starting = null;
  const cfg = () => config.get();

  const guild = () => {
    if (!client) return null;
    const id = cfg().guildId;
    if (id) return client.guilds.cache.get(id) || null;
    return client.guilds.cache.size === 1 ? client.guilds.cache.first() : null;
  };
  const rolesOf = (list) => (list || []).filter(Boolean);
  const hasRole = (member, ids) => !!member && (member.guild.ownerId === member.id || rolesOf(ids).some((id) => member.roles.cache.has(id)));
  const isAdmin = (member) => hasRole(member, cfg().adminRoleIds);
  // moderation roles (kick/ban/honeypot) · support roles (per category, then general) · purchase admins; each falls back to the moderation roles until set
  const supportRoles = (cat) => (cat && cat.roleIds && cat.roleIds.length ? cat.roleIds : cfg().tickets.closerRoleIds.length ? cfg().tickets.closerRoleIds : cfg().adminRoleIds);
  const purchaseRoles = () => (cfg().shop.adminRoleIds.length ? cfg().shop.adminRoleIds : cfg().adminRoleIds);
  const isPurchaseAdmin = (member) => hasRole(member, purchaseRoles());
  const ephemeral = (content, extra = {}) => ({ content, flags: D.MessageFlags.Ephemeral, ...extra });
  const noMentions = { parse: [] };

  // ------------------------------------------------------------------ message builders

  function ticketPanel() {
    const t = cfg().tickets;
    const select = new D.StringSelectMenuBuilder().setCustomId('tk:open').setPlaceholder(t.placeholder).addOptions(t.categories.map((c) => ({ label: c.label, description: c.description || undefined, value: c.id, emoji: emojiOption(c.emoji) })));
    return { embeds: [new D.EmbedBuilder().setTitle(t.title).setDescription(t.description).setColor(t.color)], components: [new D.ActionRowBuilder().addComponents(select)] };
  }

  function shopPanel() {
    const s = cfg().shop;
    const lines = s.plans.map((p) => { const q = quote(p, s.discounts); return `**Per ${p.label}** (${p.days} day${p.days === 1 ? '' : 's'}) — ${q.percent ? `~~${s.currency}${money(q.base)}~~ **${s.currency}${money(q.total)}** (-${q.percent}%)` : `**${s.currency}${money(q.base)}**`}`; });
    const embed = new D.EmbedBuilder().setTitle(s.title).setDescription(s.description).setColor(s.color)
      .addFields({ name: 'Prices', value: (lines.join('\n') + `\nChoose how many you want (${s.minQuantity}–${s.maxQuantity}); the total is calculated for you.`).slice(0, 1024) }, { name: 'Payment methods', value: s.methods.map((m) => m.label).join(', ').slice(0, 1024) || '—' });
    const select = new D.StringSelectMenuBuilder().setCustomId('shop:plan').setPlaceholder(s.placeholder).addOptions(s.plans.map((p) => {
      const q = quote(p, s.discounts);
      return { label: `Buy by the ${p.label}`.slice(0, 100), description: (p.description ? p.description + ' · ' : '').slice(0, 60) + `${s.currency}${money(q.total)} per ${p.label}`.slice(0, 40), value: p.id };
    }));
    return { embeds: [embed], components: [new D.ActionRowBuilder().addComponents(select)] };
  }

  function reactionPanel(g) {
    const body = g.pairs.map((p) => `${p.emoji} → <@&${p.roleId}>`).join('\n');
    return { embeds: [new D.EmbedBuilder().setTitle(g.title).setDescription([g.description, body].filter(Boolean).join('\n\n').slice(0, 4000)).setColor(cfg().tickets.color)] };
  }

  function rolePanel(g) {
    const rows = [];
    for (let i = 0; i < g.roles.length; i += 5) {
      rows.push(new D.ActionRowBuilder().addComponents(g.roles.slice(i, i + 5).map((r) => {
        const b = new D.ButtonBuilder().setCustomId(`role:${g.id}:${r.roleId}`).setLabel(r.label).setStyle(D.ButtonStyle.Secondary);
        const e = emojiOption(r.emoji); if (e) b.setEmoji(e);
        return b;
      })));
    }
    return { embeds: [new D.EmbedBuilder().setTitle(g.title).setDescription(g.description).setColor(cfg().tickets.color)], components: rows };
  }

  function orderEmbed(p) {
    const cur = cfg().shop.currency;
    const state = p.status === 'completed' ? '✅ Completed' : p.status === 'cancelled' ? '❌ Cancelled' : '🟡 Open';
    return new D.EmbedBuilder().setTitle('Purchase order').setColor(p.status === 'completed' ? '#22c55e' : p.status === 'cancelled' ? '#ef4444' : cfg().shop.color)
      .addFields(
        { name: 'Buyer', value: `<@${p.userId}>`, inline: true },
        { name: 'Duration', value: `${p.planLabel} (${p.days} days)`, inline: true },
        { name: 'Payment method', value: p.methodLabel, inline: true },
        { name: 'Price', value: `${cur}${money(p.basePrice)}`, inline: true },
        { name: 'Discount', value: p.discountPercent ? `${p.discountLabel} (-${p.discountPercent}%)` : 'None', inline: true },
        { name: 'Current total', value: `**${cur}${money(p.total)}**`, inline: true },
        ...(p.claimChannelId || p.claimedBy ? [{ name: 'Seller', value: p.claimedBy ? `<@${p.claimedBy}>` : 'Waiting for a seller to claim this ticket', inline: true }] : []),
      ).setFooter({ text: `Order ${p.id} · ${state}` });
  }

  // ---- claiming: sellers (one role per payment method) claim orders from a notification channel
  const methodOf = (p) => cfg().shop.methods.find((m) => m.id === p.methodId) || null;
  const claimedBy = (p) => (p.claimedBy ? `<@${p.claimedBy}>` : null);
  const canHandle = (member, p) => (p.claimChannelId ? (!!p.claimedBy && p.claimedBy === member.id) || isPurchaseAdmin(member) : isPurchaseAdmin(member));
  const handleDenied = (p) => (p.claimChannelId ? (p.claimedBy ? `Only the seller who claimed this ticket (${claimedBy(p)}) or the purchase admins can do that.` : 'Claim this ticket first.') : 'Only the purchase admins can do that.');

  function notifyEmbed(p) {
    const cur = p.currency || cfg().shop.currency;
    const state = p.status === 'completed' ? '✅ Completed' : p.status === 'cancelled' ? '❌ Cancelled' : p.claimedBy ? `🔒 Claimed by ${p.claimedByName || 'a seller'}` : '🟡 Waiting for a seller';
    return new D.EmbedBuilder().setTitle('New customer').setColor(p.status === 'completed' ? '#22c55e' : p.status === 'cancelled' ? '#ef4444' : p.claimedBy ? '#f59e0b' : cfg().shop.color)
      .addFields(
        { name: 'Buyer', value: `<@${p.userId}> (${p.username})`, inline: true },
        { name: 'Payment method', value: p.methodLabel, inline: true },
        { name: 'Duration', value: `${p.planLabel} (${p.days} days)`, inline: true },
        { name: 'Total', value: `**${cur}${money(p.total)}**${p.discountPercent ? ` (-${p.discountPercent}%)` : ''}`, inline: true },
        { name: 'Seller', value: p.claimedBy ? `<@${p.claimedBy}>` : '—', inline: true },
      ).setFooter({ text: `Order ${p.id} · ${state}` });
  }
  const notifyButtons = (p) => (p.status !== 'open' ? [] : [new D.ActionRowBuilder().addComponents(p.claimedBy
    ? new D.ButtonBuilder().setCustomId('shop:unclaim').setLabel('Unclaim ticket').setStyle(D.ButtonStyle.Secondary)
    : new D.ButtonBuilder().setCustomId('shop:claim').setLabel('Claim ticket').setStyle(D.ButtonStyle.Success))]);

  async function syncNotify(p) {
    try {
      const g = guild(); if (!g || !p.notifyChannelId || !p.notifyMessageId) return;
      const ch = await g.channels.fetch(p.notifyChannelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(p.notifyMessageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [notifyEmbed(p)], components: notifyButtons(p) });
    } catch (e) { log(`Could not update the claim message: ${e.message}`); }
  }
  async function syncOrder(p) {
    try {
      const g = guild(); if (!g || !p.messageId) return;
      const ch = await g.channels.fetch(p.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(p.messageId).catch(() => null) : null;
      if (msg) await msg.edit({ embeds: [orderEmbed(p)], components: p.status === 'open' ? orderButtons(p) : [] });
    } catch (e) { log(`Could not update the order message: ${e.message}`); }
  }

  const orderButtons = (p) => [new D.ActionRowBuilder().addComponents(
    new D.ButtonBuilder().setCustomId('shop:complete').setLabel('Complete purchase').setStyle(D.ButtonStyle.Success),
    new D.ButtonBuilder().setCustomId('shop:cancel').setLabel('Cancel purchase').setStyle(D.ButtonStyle.Danger),
    new D.ButtonBuilder().setCustomId('shop:discount').setLabel('Set discount').setStyle(D.ButtonStyle.Secondary),
    ...(p && p.claimedBy ? [new D.ButtonBuilder().setCustomId('shop:unclaim').setLabel('Unclaim ticket').setStyle(D.ButtonStyle.Secondary)] : []),
  )];

  // ------------------------------------------------------------------ posting panels

  async function upsertMessage(key, channelId, payload) {
    const g = guild();
    if (!g) throw new Error('The bot is not in the selected server yet.');
    const channel = await g.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not a text channel. Check the selection and the bot permissions.');
    const me = g.members && g.members.me;
    if (me && typeof channel.permissionsFor === 'function') {
      const P = D.PermissionFlagsBits;
      const have = channel.permissionsFor(me);
      const need = [['View Channel', P.ViewChannel], ['Send Messages', P.SendMessages], ['Embed Links', P.EmbedLinks], ['Read Message History', P.ReadMessageHistory], ['Add Reactions', P.AddReactions]];
      const missing = have ? need.filter(([, bit]) => !have.has(bit)).map(([n]) => n) : [];
      if (missing.length) throw new Error(`I am missing permissions in #${channel.name}: ${missing.join(', ')}. Open the channel settings → Permissions, add my role (or the bot) and allow them, then try again.`);
    }
    const old = data.getPanel(key);
    if (old && old.channelId === channelId) {
      const msg = await channel.messages.fetch(old.messageId).catch(() => null);
      if (msg) {
        try { await msg.edit(payload); } catch (e) { if (e.code === 50013 || e.code === 50001) throw new Error(`Discord refused: the bot cannot edit its message in #${channel.name}. Check its channel permissions.`); throw e; }
        return msg;
      }
    } else if (old) {
      const prev = await g.channels.fetch(old.channelId).catch(() => null);
      const msg = prev && prev.isTextBased() ? await prev.messages.fetch(old.messageId).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
    }
    let msg;
    try { msg = await channel.send(payload); } catch (e) {
      if (e.code === 50013 || e.code === 50001) throw new Error(`Discord refused: the bot may not post in #${channel.name}. Allow View Channel, Send Messages and Embed Links for the bot in that channel.`);
      throw e;
    }
    data.setPanel(key, { channelId, messageId: msg.id });
    return msg;
  }

  async function postPanel(kind, id) {
    if (status !== 'online') throw new Error('The bot is offline. Ask the founder to start it.');
    const c = cfg();
    if (kind === 'tickets') {
      if (!c.tickets.channelId) throw new Error('Select a channel for the ticket panel first and save.');
      await upsertMessage('tickets', c.tickets.channelId, ticketPanel());
      return 'Ticket panel posted.';
    }
    if (kind === 'shop') {
      if (!c.shop.channelId) throw new Error('Select a channel for the purchase panel first and save.');
      await upsertMessage('shop', c.shop.channelId, shopPanel());
      return 'Purchase panel posted.';
    }
    if (kind === 'rolePanel') {
      const g = c.rolePanels.find((x) => x.id === id);
      if (!g) throw new Error('Save the role panel first, then post it.');
      await upsertMessage(`rp:${id}`, g.channelId, rolePanel(g));
      return 'Role panel posted.';
    }
    if (kind === 'reactionRole') {
      const g = c.reactionRoles.find((x) => x.id === id);
      if (!g) throw new Error('Save the reaction role message first, then post it.');
      const msg = await upsertMessage(`rr:${id}`, g.channelId, reactionPanel(g));
      const failed = [];
      for (const p of g.pairs) { try { await msg.react(customEmoji(p.emoji) ? customEmoji(p.emoji).id : p.emoji); } catch { failed.push(p.emoji); } }
      for (const r of msg.reactions.cache.values()) if (!g.pairs.some((p) => configKey(p.emoji) === reactionKey(r))) await r.remove().catch(() => {});
      if (failed.length) throw new Error(`Posted, but could not add these emojis: ${failed.join(' ')} (custom emojis must come from this server).`);
      return 'Reaction role message posted.';
    }
    if (kind === 'honeypot') {
      if (!c.honeypot.channelId) throw new Error('Select the honeypot channel first and save.');
      await upsertMessage('honeypot', c.honeypot.channelId, honeypotPanel());
      return 'Honeypot message posted.';
    }
    throw new Error('Unknown panel type.');
  }

  function honeypotPanel() {
    const h = cfg().honeypot;
    return { embeds: [new D.EmbedBuilder().setTitle(h.title).setDescription(h.description).setColor(h.color)] };
  }

  // after a select menu was used the client keeps the choice displayed; resetting the panel lets people pick it again
  const resetPanel = (interaction, payload) => interaction.message.edit({ components: payload.components }).catch(() => {});

  // ------------------------------------------------------------------ tickets

  async function createTicketChannel(g, user, parentId, extraNames, { roleIds = [] } = {}) {
    const base = { allow: [D.PermissionFlagsBits.ViewChannel, D.PermissionFlagsBits.SendMessages, D.PermissionFlagsBits.ReadMessageHistory, D.PermissionFlagsBits.AttachFiles, D.PermissionFlagsBits.EmbedLinks] };
    const closers = roleIds.filter((id) => g.roles.cache.has(id));
    const parent = parentId && g.channels.cache.get(parentId)?.type === D.ChannelType.GuildCategory ? parentId : undefined;
    return g.channels.create({
      name: ticketChannelName(user.username), type: D.ChannelType.GuildText, parent, topic: `${extraNames} · opened by ${user.tag || user.username} (${user.id})`,
      permissionOverwrites: [
        { id: g.roles.everyone.id, deny: [D.PermissionFlagsBits.ViewChannel] },
        { id: user.id, ...base },
        ...closers.map((id) => ({ id, ...base })),
        { id: client.user.id, allow: [...base.allow, D.PermissionFlagsBits.ManageChannels] },
      ],
    });
  }

  function limitReached(g, userId) {
    const open = data.openTicketsFor(userId).filter((t) => { if (g.channels.cache.has(t.channelId)) return true; data.closeTicket(t.channelId); return false; });
    return open.length >= cfg().tickets.limitPerUser ? open : null;
  }

  async function openSupportTicket(interaction) {
    const g = interaction.guild;
    const cat = cfg().tickets.categories.find((c) => c.id === interaction.values[0]);
    if (!cat) return interaction.reply(ephemeral('That category no longer exists.'));
    await resetPanel(interaction, ticketPanel());
    const open = limitReached(g, interaction.user.id);
    if (open) return interaction.reply(ephemeral(`You already have ${open.length} open ticket${open.length > 1 ? 's' : ''} (limit ${cfg().tickets.limitPerUser}): ${open.map((t) => `<#${t.channelId}>`).join(' ')}`));
    await interaction.deferReply({ flags: D.MessageFlags.Ephemeral });
    const roleIds = supportRoles(cat);
    const channel = await createTicketChannel(g, interaction.user, cfg().tickets.categoryId, `Category: ${cat.label}`, { roleIds });
    data.addTicket({ channelId: channel.id, userId: interaction.user.id, username: interaction.user.username, kind: 'support', category: cat.label, roleIds });
    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [new D.EmbedBuilder().setTitle(`${cat.label} ticket`).setDescription('Thanks for reaching out! Please describe your problem and our team will answer as soon as possible.').setColor(cfg().tickets.color)],
      components: [new D.ActionRowBuilder().addComponents(new D.ButtonBuilder().setCustomId('tk:close').setLabel('Close ticket').setStyle(D.ButtonStyle.Danger))],
      allowedMentions: { users: [interaction.user.id] },
    });
    await interaction.editReply(`Your ticket was created: <#${channel.id}>`);
  }

  async function closeChannel(channel, delayMs = 5000) {
    data.closeTicket(channel.id);
    setTimeout(async () => {
      try { await channel.delete('Ticket closed'); } catch (e) {
        log(`Could not delete ticket channel ${channel.id}: ${e.message}`);
        await channel.send('⚠ I could not delete this channel (the bot needs the “Manage Channels” permission). Please delete it manually.').catch(() => {});
      }
    }, delayMs);
  }

  async function closeSupportTicket(interaction) {
    const t = data.ticketByChannel(interaction.channelId);
    if (!hasRole(interaction.member, t && t.roleIds && t.roleIds.length ? t.roleIds : supportRoles())) return interaction.reply(ephemeral('Only the support roles for this ticket can close it.'));
    await interaction.reply('Ticket will be closed in 5 seconds…');
    await closeChannel(interaction.channel);
  }

  // ------------------------------------------------------------------ shop

  async function shopPickPlan(interaction) {
    const plan = cfg().shop.plans.find((p) => p.id === interaction.values[0]);
    await resetPanel(interaction, shopPanel());
    if (!plan) return interaction.reply(ephemeral('That option no longer exists.'));
    const open = limitReached(interaction.guild, interaction.user.id);
    if (open) return interaction.reply(ephemeral(`You already have ${open.length} open ticket${open.length > 1 ? 's' : ''} (limit ${cfg().tickets.limitPerUser}): ${open.map((t) => `<#${t.channelId}>`).join(' ')}`));
    const { minQuantity: lo, maxQuantity: hi } = cfg().shop;
    const input = new D.TextInputBuilder().setCustomId('qty').setLabel(`How many ${plan.label}s? (${lo}-${hi})`.slice(0, 45)).setStyle(D.TextInputStyle.Short).setRequired(true).setMaxLength(4).setPlaceholder(String(lo));
    return interaction.showModal(new D.ModalBuilder().setCustomId(`shop:qty:${plan.id}`).setTitle(`Buy by the ${plan.label}`.slice(0, 45)).addComponents(new D.ActionRowBuilder().addComponents(input)));
  }

  async function shopQuantity(interaction) {
    const shop = cfg().shop;
    const plan = shop.plans.find((p) => p.id === interaction.customId.split(':')[2]);
    if (!plan) return interaction.reply(ephemeral('That option no longer exists.'));
    const raw = interaction.fields.getTextInputValue('qty').trim();
    const qty = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
    if (qty < shop.minQuantity || qty > shop.maxQuantity) return interaction.reply(ephemeral(`Please enter a whole number from ${shop.minQuantity} to ${shop.maxQuantity}.`));
    const q = quote({ id: plan.id, price: plan.price * qty }, shop.discounts);
    const select = new D.StringSelectMenuBuilder().setCustomId(`shop:pay:${plan.id}:${qty}`).setPlaceholder('Choose a payment method…').addOptions(shop.methods.map((m) => ({ label: m.label, description: m.description || undefined, value: m.id })));
    const price = q.percent ? `~~${shop.currency}${money(q.base)}~~ **${shop.currency}${money(q.total)}** (-${q.percent}%)` : `**${shop.currency}${money(q.total)}**`;
    return interaction.reply(ephemeral(`**${unitText(plan.label, qty)}** (${plan.days * qty} days) for ${price}. How do you want to pay?`, { components: [new D.ActionRowBuilder().addComponents(select)] }));
  }

  async function shopPickMethod(interaction) {
    const shop = cfg().shop;
    const [, , planId, qtyRaw] = interaction.customId.split(':');
    const plan = shop.plans.find((p) => p.id === planId);
    const qty = Number(qtyRaw);
    const method = shop.methods.find((m) => m.id === interaction.values[0]);
    if (!plan || !method || !Number.isInteger(qty) || qty < shop.minQuantity || qty > shop.maxQuantity) return interaction.update({ content: 'That option no longer exists. Please start again from the panel.', components: [] });
    const g = interaction.guild;
    const open = limitReached(g, interaction.user.id);
    if (open) return interaction.update({ content: `You already have an open ticket: ${open.map((t) => `<#${t.channelId}>`).join(' ')}`, components: [] });
    await interaction.update({ content: 'Creating your order…', components: [] });
    const q = quote({ id: plan.id, price: plan.price * qty }, shop.discounts);
    const label = unitText(plan.label, qty);
    // claim notifications go to the method's channel (or the shop default); without one the admin roles see the ticket as before
    const wantedClaim = method.claimChannelId || shop.claimChannelId;
    const claimChannel = wantedClaim ? await g.channels.fetch(wantedClaim).catch(() => null) : null;
    const claimChannelId = claimChannel && claimChannel.isTextBased() ? claimChannel.id : '';
    const channel = await createTicketChannel(g, interaction.user, method.categoryId || shop.categoryId || cfg().tickets.categoryId, `Purchase: ${label}`, { roleIds: claimChannelId ? [] : purchaseRoles() });
    data.addTicket({ channelId: channel.id, userId: interaction.user.id, username: interaction.user.username, kind: 'shop', category: 'Purchase' });
    const p = data.addPurchase({ channelId: channel.id, userId: interaction.user.id, username: interaction.user.username, planId: plan.id, planLabel: label, quantity: qty, unitLabel: plan.label, unitPrice: plan.price, days: plan.days * qty, methodId: method.id, methodLabel: method.label, basePrice: q.base, discountPercent: q.percent, discountLabel: q.discountLabel, total: q.total, currency: shop.currency, claimChannelId });
    const msg = await channel.send({ content: `<@${interaction.user.id}> thanks for your order! ${claimChannelId ? 'A seller will claim your ticket shortly and contact you about the payment.' : 'A team member will contact you about the payment.'}`, embeds: [orderEmbed(p)], components: orderButtons(p), allowedMentions: { users: [interaction.user.id] } });
    data.updatePurchase(p.id, { messageId: msg.id });
    if (claimChannelId) {
      const role = method.roleId && g.roles.cache.has(method.roleId) ? method.roleId : '';
      const note = await claimChannel.send({ content: `${role ? `<@&${role}> ` : ''}There's a new customer!`, embeds: [notifyEmbed(p)], components: notifyButtons(p), allowedMentions: role ? { roles: [role] } : noMentions }).catch((e) => { log(`Claim message failed: ${e.message}`); return null; });
      if (note) data.updatePurchase(p.id, { notifyChannelId: claimChannel.id, notifyMessageId: note.id });
      else await channel.send('⚠ I could not post the claim message. Please tell an admin to check the bot permissions in the claim channel.');
    }
    await interaction.editReply({ content: `Your order ticket was created: <#${channel.id}>` });
  }

  const purchaseOf = (interaction) => data.purchaseByChannel(interaction.channelId);

  async function shopComplete(interaction) {
    const p = purchaseOf(interaction);
    if (!p || p.status !== 'open') return interaction.reply(ephemeral('This purchase is already finished.'));
    if (!canHandle(interaction.member, p)) return interaction.reply(ephemeral(handleDenied(p)));
    const done = data.updatePurchase(p.id, { status: 'completed', completedAt: Date.now(), completedBy: interaction.user.id, completedByName: interaction.user.username, sellerId: p.claimedBy || interaction.user.id, sellerName: p.claimedByName || interaction.user.username });
    await interaction.update({ embeds: [orderEmbed(done)], components: [] });
    await syncNotify(done);
    const thanks = await interaction.channel.send({
      content: `<@${done.userId}>`,
      embeds: [new D.EmbedBuilder().setTitle('Thank you for your purchase!').setDescription('Please leave a rating — it only takes a few seconds.').setColor('#22c55e')],
      components: [new D.ActionRowBuilder().addComponents(
        new D.ButtonBuilder().setCustomId('shop:rate').setLabel('Leave a rating').setStyle(D.ButtonStyle.Primary),
        new D.ButtonBuilder().setCustomId('shop:close').setLabel('Close ticket').setStyle(D.ButtonStyle.Secondary),
      )],
      allowedMentions: { users: [done.userId] },
    });
    data.updatePurchase(done.id, { thanksMessageId: thanks.id });
    onEvent('purchase_completed', done);
  }

  async function shopCancel(interaction) {
    const p = purchaseOf(interaction);
    if (!p || p.status !== 'open') return interaction.reply(ephemeral('This purchase is already finished.'));
    if (!canHandle(interaction.member, p)) return interaction.reply(ephemeral(handleDenied(p)));
    const done = data.updatePurchase(p.id, { status: 'cancelled', cancelledAt: Date.now(), cancelledBy: interaction.user.id });
    await interaction.update({ embeds: [orderEmbed(done)], components: [] });
    await syncNotify(done);
    await interaction.channel.send('Purchase cancelled. This ticket will be closed in 5 seconds…');
    onEvent('purchase_cancelled', done);
    await closeChannel(interaction.channel);
  }

  const ticketAccess = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true };

  async function shopClaim(interaction) {
    const p = data.purchaseByNotify(interaction.message.id);
    if (!p) return interaction.reply(ephemeral('This order no longer exists.'));
    if (p.status !== 'open') return interaction.reply(ephemeral('This order is already finished.'));
    const m = methodOf(p);
    const allowed = (m && m.roleId && hasRole(interaction.member, [m.roleId])) || isPurchaseAdmin(interaction.member);
    if (!allowed) return interaction.reply(ephemeral(`Only ${m && m.roleId ? `<@&${m.roleId}>` : 'the purchase admins'} can claim this ticket.`, { allowedMentions: noMentions }));
    if (interaction.user.id === p.userId) return interaction.reply(ephemeral('You cannot claim your own order.'));
    if (p.claimedBy) return interaction.reply(ephemeral(`This ticket is already claimed by ${claimedBy(p)}. It can be claimed again once they unclaim it.`, { allowedMentions: noMentions }));
    const ch = await interaction.guild.channels.fetch(p.channelId).catch(() => null);
    if (!ch) return interaction.reply(ephemeral('The ticket channel no longer exists.'));
    await interaction.deferUpdate();
    await ch.permissionOverwrites.edit(interaction.user.id, ticketAccess);
    const upd = data.updatePurchase(p.id, { claimedBy: interaction.user.id, claimedByName: interaction.user.username, claimedAt: Date.now() });
    await ch.send({ content: `Ticket claimed by <@${interaction.user.id}>`, allowedMentions: { users: [interaction.user.id] } });
    await syncNotify(upd);
    await syncOrder(upd);
    onEvent('purchase_claimed', upd);
  }

  async function shopUnclaim(interaction) {
    const p = data.purchaseByNotify(interaction.message.id) || purchaseOf(interaction);
    if (!p || p.status !== 'open') return interaction.reply(ephemeral('This order is already finished.'));
    if (!p.claimedBy) return interaction.reply(ephemeral('This ticket is not claimed.'));
    if (interaction.user.id !== p.claimedBy && interaction.guild.ownerId !== interaction.user.id && !isPurchaseAdmin(interaction.member)) return interaction.reply(ephemeral(`Only ${claimedBy(p)} or the purchase admins can unclaim this ticket.`, { allowedMentions: noMentions }));
    await interaction.deferUpdate();
    const ch = await interaction.guild.channels.fetch(p.channelId).catch(() => null);
    if (ch) {
      await ch.permissionOverwrites.delete(p.claimedBy).catch((e) => log(`Could not remove ticket access: ${e.message}`));
      await ch.send({ content: `Ticket has been unclaimed by <@${interaction.user.id}>`, allowedMentions: noMentions });
    }
    const upd = data.updatePurchase(p.id, { claimedBy: null, claimedByName: null });
    await syncNotify(upd);
    await syncOrder(upd);
    onEvent('purchase_unclaimed', { ...upd, by: interaction.user });
  }

  async function shopDiscountButton(interaction) {
    const cur = purchaseOf(interaction);
    if (!cur || cur.status !== 'open') return interaction.reply(ephemeral('This purchase is already finished.'));
    if (!canHandle(interaction.member, cur)) return interaction.reply(ephemeral(handleDenied(cur)));
    const input = new D.TextInputBuilder().setCustomId('percent').setLabel('Discount in percent (0-100)').setStyle(D.TextInputStyle.Short).setRequired(true).setMaxLength(3).setPlaceholder('e.g. 15');
    return interaction.showModal(new D.ModalBuilder().setCustomId('shop:discountmodal').setTitle('Set discount').addComponents(new D.ActionRowBuilder().addComponents(input)));
  }

  async function shopDiscountModal(interaction) {
    const p = purchaseOf(interaction);
    if (!p || p.status !== 'open') return interaction.reply(ephemeral('This purchase is already finished.'));
    if (!canHandle(interaction.member, p)) return interaction.reply(ephemeral(handleDenied(p)));
    const percent = Number(interaction.fields.getTextInputValue('percent').replace('%', '').trim());
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) return interaction.reply(ephemeral('Enter a whole number between 0 and 100.'));
    const q = quote({ id: p.planId, price: p.basePrice }, [], { percent, label: `Discount by ${interaction.user.username}` });
    const updated = data.updatePurchase(p.id, { discountPercent: q.percent, discountLabel: q.discountLabel, total: q.total });
    const msg = p.messageId ? await interaction.channel.messages.fetch(p.messageId).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [orderEmbed(updated)] }).catch(() => {});
    await syncNotify(updated);
    return interaction.reply(`Discount updated: **${percent}%** → new total **${updated.currency || cfg().shop.currency}${money(updated.total)}**`);
  }

  async function shopRateButton(interaction) {
    const p = purchaseOf(interaction);
    if (!p || p.status !== 'completed') return interaction.reply(ephemeral('There is nothing to rate here.'));
    if (interaction.user.id !== p.userId) return interaction.reply(ephemeral('Only the buyer can leave a rating.'));
    if (p.rating) return interaction.reply(ephemeral('You already rated this purchase. Thank you!'));
    const starsInput = new D.TextInputBuilder().setCustomId('stars').setLabel('How many stars do you want to give us? (1-5)').setStyle(D.TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(8).setPlaceholder('1 – 5');
    const feedback = new D.TextInputBuilder().setCustomId('feedback').setLabel('Any feedback for us?').setStyle(D.TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
    return interaction.showModal(new D.ModalBuilder().setCustomId('shop:ratemodal').setTitle('Leave a rating').addComponents(new D.ActionRowBuilder().addComponents(starsInput), new D.ActionRowBuilder().addComponents(feedback)));
  }

  /** A review as a card: stars, buyer, seller, product, price and payment method (plus the feedback when given). */
  function reviewCard(p, { avatar, feedback, title } = {}) {
    const n = p.rating, cur = p.currency || cfg().shop.currency;
    const e = new D.EmbedBuilder().setColor(n >= 4 ? '#22c55e' : n === 3 ? '#f59e0b' : '#ef4444')
      .setTitle(title || `${stars(n)}  ${n}/5`)
      .setDescription(`<@${p.userId}> bought something${p.sellerId ? ` from <@${p.sellerId}>` : ''} and left a rating of ${stars(n)} (${n}/5)`)
      .addFields(
        { name: '🛒 Buyer', value: `<@${p.userId}>`, inline: true },
        { name: '🧑‍💼 Seller', value: p.sellerId ? `<@${p.sellerId}>` : '—', inline: true },
        { name: '⭐ Rating', value: `${stars(n)}${'☆'.repeat(5 - n)}  **${n}/5**`, inline: true },
        { name: '📦 Product', value: p.planLabel, inline: true },
        { name: '💶 Price', value: `${cur}${money(p.total)}`, inline: true },
        { name: '💳 Payment', value: p.methodLabel, inline: true },
      ).setFooter({ text: `Order ${p.id}` }).setTimestamp(p.ratedAt || Date.now());
    if (feedback) e.addFields({ name: '💬 Feedback', value: ('>>> ' + feedback).slice(0, 1024) });
    if (avatar) e.setThumbnail(avatar);
    return e;
  }

  async function shopRateModal(interaction) {
    const p = purchaseOf(interaction);
    if (!p || p.status !== 'completed' || interaction.user.id !== p.userId) return interaction.reply(ephemeral('There is nothing to rate here.'));
    if (p.rating) return interaction.reply(ephemeral('You already rated this purchase. Thank you!'));
    const n = parseStars(interaction.fields.getTextInputValue('stars'));
    if (!n) return interaction.reply(ephemeral('Please enter a number from 1 to 5.'));
    const feedback = (interaction.fields.getTextInputValue('feedback') || '').trim();
    const done = data.updatePurchase(p.id, { rating: n, feedback, ratedAt: Date.now() });
    const g = interaction.guild, r = cfg().ratings;
    const post = async (channelId, payload) => { const ch = channelId ? await g.channels.fetch(channelId).catch(() => null) : null; if (ch && ch.isTextBased()) await ch.send({ allowedMentions: noMentions, ...payload }).catch((e) => log(`Could not post to ${channelId}: ${e.message}`)); };
    const avatar = interaction.user.displayAvatarURL ? interaction.user.displayAvatarURL() : undefined;
    await post(r.channelId, { embeds: [reviewCard(done, { avatar })] });
    if (feedback) await post(r.feedbackChannelId, { embeds: [reviewCard(done, { avatar, feedback, title: 'New feedback' })] });
    const thanks = done.thanksMessageId ? await interaction.channel.messages.fetch(done.thanksMessageId).catch(() => null) : null;
    if (thanks) await thanks.edit({ components: [] }).catch(() => {});
    onEvent('purchase_rated', done);
    await interaction.reply(`Thank you for your rating of ${stars(n)}! This ticket will close in 5 seconds…`);
    await closeChannel(interaction.channel);
  }

  async function shopClose(interaction) {
    const p = purchaseOf(interaction);
    if (!p || p.status !== 'completed') return interaction.reply(ephemeral('This ticket cannot be closed here.'));
    if (interaction.user.id !== p.userId && interaction.user.id !== p.claimedBy && !isPurchaseAdmin(interaction.member)) return interaction.reply(ephemeral('Only the buyer or the seller can close this ticket.'));
    await interaction.reply('Ticket will be closed in 5 seconds…');
    await closeChannel(interaction.channel);
  }

  // ------------------------------------------------------------------ role toggles, reactions

  async function toggleRole(interaction) {
    const [, panelId, roleId] = interaction.customId.split(':');
    const panel = cfg().rolePanels.find((p) => p.id === panelId);
    if (!panel || !panel.roles.some((r) => r.roleId === roleId)) return interaction.reply(ephemeral('This role button is no longer active.'));
    const member = interaction.member;
    try {
      if (member.roles.cache.has(roleId)) { await member.roles.remove(roleId); return interaction.reply(ephemeral(`Removed <@&${roleId}>.`, { allowedMentions: noMentions })); }
      await member.roles.add(roleId);
      return interaction.reply(ephemeral(`You now have <@&${roleId}>.`, { allowedMentions: noMentions }));
    } catch { return interaction.reply(ephemeral('I could not change that role. My role must be above it in the server settings.')); }
  }

  async function onReaction(reaction, user, add) {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      const found = data.panelsWhere('rr:').find(([, v]) => v.messageId === reaction.message.id);
      if (!found) return;
      const group = cfg().reactionRoles.find((g) => g.id === found[0].slice(3));
      if (!group) return;
      const pair = group.pairs.find((p) => configKey(p.emoji) === reactionKey(reaction));
      if (!pair) return;
      const g = guild(); if (!g || reaction.message.guildId !== g.id) return;
      const member = await g.members.fetch(user.id);
      if (add) await member.roles.add(pair.roleId); else await member.roles.remove(pair.roleId);
    } catch (e) { log(`Reaction role failed: ${e.message}`); }
  }

  // ------------------------------------------------------------------ welcome / leave / autorole

  async function sendGreeting(kind, member) {
    const c = cfg()[kind];
    if (!c.enabled || !c.channelId) return;
    const channel = await member.guild.channels.fetch(c.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const body = fillTemplate(c.message, { user: `<@${member.id}>`, username: member.user.username, server: member.guild.name, count: member.guild.memberCount });
    const payload = c.embed ? { embeds: [new D.EmbedBuilder().setDescription(body).setColor(kind === 'welcome' ? '#22c55e' : '#ef4444').setThumbnail(member.user.displayAvatarURL())], content: kind === 'welcome' ? `<@${member.id}>` : undefined } : { content: body };
    await channel.send({ ...payload, allowedMentions: kind === 'welcome' ? { users: [member.id] } : noMentions }).catch((e) => log(`${kind} message failed: ${e.message}`));
  }

  async function onMemberAdd(member) {
    const g = guild(); if (!g || member.guild.id !== g.id) return;
    const a = cfg().autorole;
    if (a.enabled && !(a.ignoreBots && member.user.bot)) {
      for (const id of a.roleIds) await member.roles.add(id, 'Autorole').catch((e) => log(`Autorole ${id} failed: ${e.message}`));
    }
    await sendGreeting('welcome', member);
  }

  // ------------------------------------------------------------------ slash commands

  const commandDefs = () => [
    new D.SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(300)),
    new D.SlashCommandBuilder().setName('ban').setDescription('Ban a user').setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(300))
      .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
    new D.SlashCommandBuilder().setName('unban').setDescription('Remove a ban').setDMPermission(false)
      .addStringOption((o) => o.setName('user_id').setDescription('ID of the banned user').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(300)),
    new D.SlashCommandBuilder().setName('purchases').setDescription('Show your completed purchases').setDMPermission(false),
  ].map((c) => c.toJSON());

  async function registerCommands() {
    const g = guild();
    if (!g) return;
    await g.commands.set(commandDefs()).catch((e) => log(`Could not register commands: ${e.message}`));
  }

  async function moderation(interaction) {
    if (!isAdmin(interaction.member)) return interaction.reply(ephemeral('You need one of the configured admin roles for this command.'));
    const name = interaction.commandName, g = interaction.guild;
    const reason = `${interaction.options.getString('reason') || 'No reason given'} (by ${interaction.user.username})`;
    if (name === 'unban') {
      const id = interaction.options.getString('user_id').trim();
      if (!/^\d{15,25}$/.test(id)) return interaction.reply(ephemeral('That is not a valid user ID.'));
      try { await g.bans.remove(id, reason); } catch { return interaction.reply(ephemeral('That user is not banned (or I lack permission).')); }
      onEvent('unban', { by: interaction.user, target: id, reason });
      return interaction.reply(ephemeral(`Unbanned <@${id}>.`, { allowedMentions: noMentions }));
    }
    const user = interaction.options.getUser('user');
    if (user.id === interaction.user.id || user.id === client.user.id) return interaction.reply(ephemeral('You cannot do that to yourself or to me.'));
    const target = interaction.options.getMember('user');
    if (target) {
      if (g.ownerId === target.id) return interaction.reply(ephemeral('You cannot target the server owner.'));
      if (g.ownerId !== interaction.user.id && target.roles.highest.position >= interaction.member.roles.highest.position) return interaction.reply(ephemeral('That member has the same or a higher role than you.'));
      if (name === 'kick' ? !target.kickable : !target.bannable) return interaction.reply(ephemeral('I cannot do that — my role must be above theirs and I need the permission.'));
    } else if (name === 'kick') return interaction.reply(ephemeral('That user is not in the server.'));
    try {
      if (name === 'kick') await target.kick(reason);
      else await g.members.ban(user, { reason, deleteMessageSeconds: (interaction.options.getInteger('delete_days') || 0) * 86400 });
    } catch (e) { return interaction.reply(ephemeral(`Failed: ${e.message}`)); }
    onEvent(name, { by: interaction.user, target: user.id, targetName: user.username, reason });
    return interaction.reply(ephemeral(`${name === 'kick' ? 'Kicked' : 'Banned'} **${user.username}**.`));
  }

  async function myPurchases(interaction) {
    const mine = data.purchases().filter((p) => p.userId === interaction.user.id && p.status === 'completed');
    if (!mine.length) return interaction.reply(ephemeral('You have no completed purchases yet.'));
    const total = mine.reduce((s, p) => s + p.total, 0);
    const lines = mine.slice(-15).reverse().map((p) => `• <t:${Math.floor(p.completedAt / 1000)}:d> ${p.planLabel} — ${p.currency || ''}${money(p.total)}${p.rating ? ` ${stars(p.rating)}` : ''}`);
    return interaction.reply(ephemeral(`**Your purchases** (${mine.length}, total ${cfg().shop.currency}${money(total)})\n${lines.join('\n')}`));
  }

  // ------------------------------------------------------------------ dispatch

  async function onInteraction(interaction) {
    const g = guild();
    if (!g || interaction.guildId !== g.id) return;
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'purchases') return await myPurchases(interaction);
        return await moderation(interaction);
      }
      const id = interaction.customId || '';
      if (interaction.isStringSelectMenu()) {
        if (id === 'tk:open') return await openSupportTicket(interaction);
        if (id === 'shop:plan') return await shopPickPlan(interaction);
        if (id.startsWith('shop:pay:')) return await shopPickMethod(interaction);
      } else if (interaction.isButton()) {
        if (id === 'tk:close') return await closeSupportTicket(interaction);
        if (id === 'shop:complete') return await shopComplete(interaction);
        if (id === 'shop:cancel') return await shopCancel(interaction);
        if (id === 'shop:claim') return await shopClaim(interaction);
        if (id === 'shop:unclaim') return await shopUnclaim(interaction);
        if (id === 'shop:discount') return await shopDiscountButton(interaction);
        if (id === 'shop:rate') return await shopRateButton(interaction);
        if (id === 'shop:close') return await shopClose(interaction);
        if (id.startsWith('role:')) return await toggleRole(interaction);
      } else if (interaction.isModalSubmit()) {
        if (id === 'shop:discountmodal') return await shopDiscountModal(interaction);
        if (id === 'shop:ratemodal') return await shopRateModal(interaction);
        if (id.startsWith('shop:qty:')) return await shopQuantity(interaction);
      }
    } catch (e) {
      log(`Interaction ${interaction.customId || interaction.commandName} failed: ${e.message}`);
      const msg = ephemeral('Something went wrong. Please try again or contact the team.');
      try { if (interaction.deferred || interaction.replied) await interaction.followUp(msg); else await interaction.reply(msg); } catch { /* interaction expired */ }
    }
  }

  /** Anyone who writes in the honeypot channel (except staff) is removed; the message is deleted first. */
  async function onMessage(message) {
    try {
      const h = cfg().honeypot, g = guild();
      if (!h.enabled || !h.channelId || !g || message.guildId !== g.id || message.channelId !== h.channelId) return;
      if (message.author.bot || message.webhookId) return;
      const member = message.member || await g.members.fetch(message.author.id).catch(() => null);
      if (member && isAdmin(member)) return;
      await message.delete().catch(() => {});
      const reason = 'Honeypot: wrote in the bot-catching channel';
      let ok = true, err = '';
      try {
        if (h.action === 'ban') await g.members.ban(message.author.id, { reason, deleteMessageSeconds: 3600 });
        else if (member && member.kickable) await member.kick(reason);
        else { ok = false; err = 'I cannot kick this member (my role must be above theirs).'; }
      } catch (e) { ok = false; err = e.message; }
      onEvent('honeypot', { by: { username: 'Honeypot' }, target: message.author.id, targetName: message.author.username, reason: `${h.action === 'ban' ? 'banned' : 'kicked'}${ok ? '' : ' FAILED: ' + err}` });
      const log = h.logChannelId ? await g.channels.fetch(h.logChannelId).catch(() => null) : null;
      if (log && log.isTextBased()) await log.send({ allowedMentions: noMentions, embeds: [new D.EmbedBuilder().setTitle('Honeypot triggered').setColor(ok ? '#ef4444' : '#f59e0b').addFields({ name: 'User', value: `<@${message.author.id}> (${message.author.username})`, inline: true }, { name: 'Action', value: ok ? (h.action === 'ban' ? 'Banned' : 'Kicked') : `Failed – ${err}`, inline: true }, { name: 'Message', value: (message.content || '(no text)').slice(0, 500) })] }).catch(() => {});
    } catch (e) { log(`Honeypot failed: ${e.message}`); }
  }

  function onChannelDelete(channel) {
    const t = data.ticketByChannel(channel.id);
    if (!t) return;
    data.closeTicket(channel.id);
    const p = data.purchaseByChannel(channel.id);
    if (p && p.status === 'open') { const done = data.updatePurchase(p.id, { status: 'cancelled', cancelledAt: Date.now(), note: 'Ticket channel was deleted' }); onEvent('purchase_cancelled', done); syncNotify(done); }
  }

  // ------------------------------------------------------------------ lifecycle

  async function start() {
    if (client) return starting || undefined;
    const token = founder.get().botToken;
    if (!token) throw new Error('Save a bot token in the Founder tab first.');
    D = require('discord.js');
    status = 'starting'; error = '';
    client = new D.Client({
      intents: [D.GatewayIntentBits.Guilds, D.GatewayIntentBits.GuildMembers, D.GatewayIntentBits.GuildMessageReactions, D.GatewayIntentBits.GuildMessages],
      partials: [D.Partials.Message, D.Partials.Channel, D.Partials.Reaction, D.Partials.User, D.Partials.GuildMember],
    });
    const c = client;
    c.on(D.Events.InteractionCreate, onInteraction);
    c.on(D.Events.GuildMemberAdd, (m) => onMemberAdd(m).catch((e) => log(`Join handler failed: ${e.message}`)));
    c.on(D.Events.GuildMemberRemove, (m) => { const g = guild(); if (g && m.guild.id === g.id) sendGreeting('leave', m).catch(() => {}); });
    c.on(D.Events.MessageReactionAdd, (r, u) => onReaction(r, u, true));
    c.on(D.Events.MessageReactionRemove, (r, u) => onReaction(r, u, false));
    c.on(D.Events.ChannelDelete, onChannelDelete);
    c.on(D.Events.MessageCreate, onMessage);
    c.on(D.Events.Error, (e) => log(`Client error: ${e.message}`));
    c.on(D.Events.ShardDisconnect, () => { if (client === c && status === 'online') status = 'starting'; });
    c.on(D.Events.ShardResume, () => { if (client === c) status = 'online'; });
    starting = (async () => {
      try {
        const ready = new Promise((resolve, reject) => { c.once(D.Events.ClientReady, resolve); setTimeout(() => reject(new Error('Timed out while connecting to Discord.')), 30000).unref?.(); });
        await c.login(token);
        await ready;
        status = 'online'; startedAt = Date.now();
        await registerCommands();
        log(`Discord bot online as ${c.user.tag}`);
      } catch (e) {
        error = TOKEN_HELP[e.code] || e.message;
        status = 'error';
        try { await c.destroy(); } catch { /* ignore */ }
        if (client === c) client = null;
        throw new Error(error);
      } finally { starting = null; }
    })();
    return starting;
  }

  async function stop() {
    const c = client; client = null; status = 'offline'; error = ''; startedAt = 0;
    if (c) await c.destroy();
  }

  function info() {
    const g = guild();
    if (!g) return null;
    const chans = [...g.channels.cache.values()];
    return {
      id: g.id, name: g.name, memberCount: g.memberCount,
      textChannels: chans.filter((c) => c.type === D.ChannelType.GuildText || c.type === D.ChannelType.GuildAnnouncement).sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name })),
      categories: chans.filter((c) => c.type === D.ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name })),
      roles: [...g.roles.cache.values()].filter((r) => r.id !== g.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
    };
  }

  return {
    start, stop, postPanel, info,
    refresh: () => (status === 'online' ? registerCommands() : undefined),
    guilds: () => (client ? [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name })) : []),
    status: () => ({ status, error, since: startedAt, tag: client && client.user ? client.user.tag : '', guildFound: !!guild() }),
    // exposed for tests
    _handlers: { onMessage, onInteraction, onMemberAdd, onReaction, onChannelDelete, sendGreeting, setClient(c, d) { client = c; D = d || require('discord.js'); status = 'online'; } },
  };
}

module.exports = { createDiscordBot };
