'use strict';
// "Discord bot" tab (admins), "Purchases" tab (everyone) and the bot card in the Founder tab.
// Relies on toast() and copyText() from app.js.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  async function api(url, options = {}) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const uid = () => Math.random().toString(16).slice(2, 8);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  let state = null, cfg = null, info = null, dirty = false;
  const mark = () => { dirty = true; $('botSave').textContent = 'Save settings *'; };

  // ------------------------------------------------------------ form controls (write straight into the draft config)

  function field(label, control, hint) {
    const l = el('label'); l.append(document.createTextNode(label), control);
    if (hint) l.append(el('span', 'hint', hint));
    return l;
  }
  function text(obj, key, label, opts = {}) {
    const c = opts.multiline ? el('textarea') : el('input');
    if (!opts.multiline) c.type = opts.type || 'text';
    if (opts.min !== undefined) c.min = opts.min;
    if (opts.max !== undefined) c.max = opts.max;
    if (opts.step) c.step = opts.step;
    if (opts.placeholder) c.placeholder = opts.placeholder;
    c.maxLength = opts.maxLength || 2000;
    c.value = obj[key] ?? '';
    c.addEventListener('input', () => { obj[key] = opts.type === 'number' ? (c.value === '' ? '' : Number(c.value)) : c.value; mark(); });
    return field(label, c, opts.hint);
  }
  function check(obj, key, label) {
    const l = el('label', 'check'); const c = el('input'); c.type = 'checkbox'; c.checked = !!obj[key];
    c.addEventListener('change', () => { obj[key] = c.checked; mark(); });
    l.append(c, document.createTextNode(' ' + label));
    return l;
  }
  function colorField(obj, key, label) {
    const c = el('input'); c.type = 'color'; c.value = /^#[0-9a-f]{6}$/i.test(obj[key]) ? obj[key] : '#8b5cf6';
    c.addEventListener('input', () => { obj[key] = c.value; mark(); });
    return field(label, c);
  }
  // channel/category dropdown (falls back to a plain ID box while the bot is offline)
  function channel(obj, key, label, kind = 'textChannels', hint) {
    const list = info ? info[kind] : null;
    if (!list) return text(obj, key, label + ' (ID)', { placeholder: 'Start the bot to pick from a list', hint });
    const s = el('select'); s.append(new Option('— none —', ''));
    for (const c of list) s.append(new Option((kind === 'categories' ? '' : '# ') + c.name, c.id));
    if (obj[key] && !list.some((c) => c.id === obj[key])) s.append(new Option(`Unknown (${obj[key]})`, obj[key]));
    s.value = obj[key] || '';
    s.addEventListener('change', () => { obj[key] = s.value; mark(); });
    return field(label, s, hint);
  }
  function roleOne(obj, key, label) {
    if (!info) return text(obj, key, label + ' (ID)', { placeholder: 'Start the bot to pick from a list' });
    const s = el('select'); s.append(new Option('— pick a role —', ''));
    for (const r of info.roles) s.append(new Option('@' + r.name, r.id));
    if (obj[key] && !info.roles.some((r) => r.id === obj[key])) s.append(new Option(`Unknown (${obj[key]})`, obj[key]));
    s.value = obj[key] || '';
    s.addEventListener('change', () => { obj[key] = s.value; mark(); });
    return field(label, s);
  }
  function roleMulti(obj, key, label, hint) {
    if (!info) {
      const c = el('input'); c.placeholder = 'Role IDs separated by commas'; c.value = (obj[key] || []).join(', ');
      c.addEventListener('input', () => { obj[key] = c.value.split(/[\s,]+/).filter(Boolean); mark(); });
      return field(label + ' (IDs)', c, hint || 'Start the bot to pick from a list');
    }
    const box = el('div', 'pick-list');
    for (const r of info.roles) {
      const l = el('label'); const c = el('input'); c.type = 'checkbox'; c.checked = (obj[key] || []).includes(r.id); l.classList.toggle('on', c.checked);
      c.addEventListener('change', () => { const set = new Set(obj[key] || []); c.checked ? set.add(r.id) : set.delete(r.id); obj[key] = [...set]; l.classList.toggle('on', c.checked); mark(); });
      l.append(c, document.createTextNode('@' + r.name)); box.append(l);
    }
    if (!info.roles.length) box.append(el('span', 'hint', 'No roles found.'));
    return field(label, box, hint);
  }
  function section(eyebrow, title, ...children) {
    const p = el('div', 'panel'); const head = el('div', 'head'); const t = el('div'); t.append(el('p', 'eyebrow', eyebrow), el('h3', '', title)); head.append(t); p.append(head);
    const body = el('div', 'bot-section'); body.append(...children); p.append(body);
    return p;
  }
  const grid = (cls, ...kids) => { const g = el('div', 'form-grid ' + cls); g.append(...kids); return g; };
  const note = (t) => el('p', 'muted', t);

  function listEditor(arr, make, render, addLabel, max) {
    const wrap = el('div', 'bot-section');
    const draw = () => {
      wrap.replaceChildren();
      arr.forEach((item, i) => {
        const card = el('div', 'row-card'); const head = el('div', 'row-head'); head.append(el('b', '', `#${i + 1}`), el('span', 'spacer'));
        const rm = el('button', 'danger sm', 'Remove'); rm.type = 'button'; rm.addEventListener('click', () => { arr.splice(i, 1); mark(); draw(); });
        head.append(rm); card.append(head, ...[].concat(render(item, draw))); wrap.append(card);
      });
      if (!max || arr.length < max) { const add = el('button', 'ghost', addLabel); add.type = 'button'; add.addEventListener('click', () => { arr.push(make()); mark(); draw(); }); wrap.append(add); }
    };
    draw();
    return wrap;
  }

  async function saveAndPost(kind, id, label) {
    try {
      await save();
      const r = await api('/api/bot/post', { method: 'POST', body: JSON.stringify({ kind, id }) });
      toast(r.message || 'Posted');
      await load();
    } catch (e) { toast(e.message, true); }
  }
  const postButton = (kind, id, key, label) => {
    const wrap = el('div', 'toolbar'); const b = el('button', 'primary', label); b.type = 'button';
    b.addEventListener('click', () => saveAndPost(kind, id));
    wrap.append(b);
    const posted = state && state.panels[key];
    wrap.append(el('span', 'hint', posted ? 'Already posted – posting again updates the same message.' : 'Saves your changes and sends the message to the selected channel.'));
    if (!state || state.status.status !== 'online') b.disabled = true;
    return wrap;
  };

  // ------------------------------------------------------------ the sections

  function render() {
    const root = $('botRoot'); root.replaceChildren();
    const st = state.status;
    const chip = $('botStatus'); chip.textContent = { online: 'online', starting: 'starting…', error: 'error', offline: 'offline' }[st.status] || st.status; chip.className = 'chip ' + (st.status === 'online' ? 'ok' : st.status === 'error' ? 'err' : st.status === 'starting' ? 'warn' : '');
    if (st.status !== 'online') {
      const msg = st.status === 'error' ? `The bot could not start: ${st.error}` : state.hasToken ? 'The bot is offline. Ask the founder to start it. You can already edit the settings, but channels and roles can only be picked while the bot is online.' : 'No bot token saved yet. The founder adds it in the Founder tab.';
      const p = el('div', 'panel'); p.append(el('p', '', msg)); root.append(p);
    }
    const c = cfg;

    // --- server & permissions
    const serverKids = [];
    if (st.status === 'online') {
      const g = state.guilds || [];
      if (g.length > 1 || (g.length === 1 && !c.guildId)) {
        const s = el('select'); for (const x of g) s.append(new Option(x.name, x.id)); s.value = c.guildId || (info ? info.id : g[0].id); if (!c.guildId) { c.guildId = s.value; }
        s.addEventListener('change', () => { c.guildId = s.value; mark(); });
        serverKids.push(field('Server the bot manages', s, 'Save, then reload the page to load that server\'s channels and roles.'));
      } else if (info) { const kv = el('div', 'kv'); kv.append(el('span', '', 'Server'), el('b', '', `${info.name} (${info.memberCount} members)`)); serverKids.push(kv); }
      if (st.status === 'online' && !info) serverKids.push(note('The bot is not in a server yet. Invite it with the link from the Founder tab.'));
    }
    serverKids.push(roleMulti(c, 'adminRoleIds', 'Admin roles', 'These roles can use /kick, /ban, /unban and can complete or cancel purchases. Ticket closing uses the same roles unless you pick different ones in the Tickets section.'));
    if (!c.adminRoleIds.length) serverKids.push(note('⚠ No admin roles selected: only the server owner can use the admin functions.'));
    root.append(section('General', 'Server & admin roles', ...serverKids));

    // --- welcome / leave
    const greet = (key, title, hint) => section('Messages', title, check(c[key], 'enabled', 'Enabled'), channel(c[key], 'channelId', 'Channel'), text(c[key], 'message', 'Message', { multiline: true, maxLength: 1500, hint }), check(c[key], 'embed', 'Send as a styled embed'));
    root.append(grid('two', greet('welcome', 'Welcome message', 'Placeholders: {user} (mention), {username}, {server}, {count} (member number)'), greet('leave', 'Leave message', 'Placeholders: {username}, {server}, {count}. Leave messages never ping anyone.')));

    // --- roles
    root.append(section('Roles', 'Autorole', note('These roles are given automatically to everyone who joins.'), check(c.autorole, 'enabled', 'Give roles on join'), roleMulti(c.autorole, 'roleIds', 'Roles to give'), check(c.autorole, 'ignoreBots', 'Skip bot accounts')));

    root.append(section('Roles', 'Reaction roles', note('The bot posts a message and adds your emojis as reactions. Members get the role when they react and lose it when they remove the reaction.'),
      listEditor(c.reactionRoles, () => ({ id: uid(), channelId: '', title: 'Pick your roles', description: '', pairs: [{ emoji: '', roleId: '' }] }), (g, redraw) => [
        grid('two', channel(g, 'channelId', 'Channel'), text(g, 'title', 'Title', { maxLength: 100 })),
        text(g, 'description', 'Description', { multiline: true, maxLength: 1000 }),
        listEditor(g.pairs, () => ({ emoji: '', roleId: '' }), (p) => [grid('two', text(p, 'emoji', 'Emoji', { maxLength: 64, placeholder: '👍 or <:name:id>' }), roleOne(p, 'roleId', 'Role'))], '+ Add emoji', 20),
        postButton('reactionRole', g.id, 'rr:' + g.id, 'Save & post message'),
      ], '+ New reaction role message', 10)));

    root.append(section('Roles', 'Role buttons', note('A message with toggle buttons: one click adds the role, another click removes it. Only members can change their own roles.'),
      listEditor(c.rolePanels, () => ({ id: uid(), channelId: '', title: 'Roles', description: 'Press a button to add or remove a role.', roles: [{ roleId: '', label: '', emoji: '' }] }), (g) => [
        grid('two', channel(g, 'channelId', 'Channel'), text(g, 'title', 'Title', { maxLength: 100 })),
        text(g, 'description', 'Description', { multiline: true, maxLength: 1000 }),
        listEditor(g.roles, () => ({ roleId: '', label: '', emoji: '' }), (r) => [grid('three', roleOne(r, 'roleId', 'Role'), text(r, 'label', 'Button label', { maxLength: 80 }), text(r, 'emoji', 'Emoji (optional)', { maxLength: 64 }))], '+ Add role button', 20),
        postButton('rolePanel', g.id, 'rp:' + g.id, 'Save & post buttons'),
      ], '+ New role button panel', 10)));

    // --- tickets
    const t = c.tickets;
    root.append(section('Support', 'Ticket panel', note('Members pick a category from a dropdown and a private channel named “ticket-from-<name>” opens. Only the roles below can close tickets.'),
      grid('two', channel(t, 'channelId', 'Panel channel'), channel(t, 'categoryId', 'Create tickets in category', 'categories', 'Optional. Tickets are created at the top of the server otherwise.')),
      grid('three', text(t, 'title', 'Panel title', { maxLength: 100 }), text(t, 'placeholder', 'Dropdown text', { maxLength: 100 }), colorField(t, 'color', 'Colour')),
      text(t, 'description', 'Panel description', { multiline: true, maxLength: 2000 }),
      grid('two', text(t, 'limitPerUser', 'Open tickets per member', { type: 'number', min: 1, max: 20, hint: 'Applies to support and purchase tickets together.' }), roleMulti(t, 'closerRoleIds', 'Roles that can close tickets', 'Empty = the admin roles from above.')),
      el('b', '', 'Categories (dropdown options)'),
      listEditor(t.categories, () => ({ id: uid(), label: '', description: '', emoji: '' }), (x) => [grid('three', text(x, 'label', 'Name', { maxLength: 80 }), text(x, 'description', 'Short description', { maxLength: 100 }), text(x, 'emoji', 'Emoji (optional)', { maxLength: 64 }))], '+ Add category', 25),
      postButton('tickets', null, 'tickets', 'Save & post panel')));

    // --- shop
    const s = c.shop;
    root.append(section('Shop', 'Purchase panel', note('Members choose a duration, then a payment method. A ticket opens showing the duration, payment method and the current total price. Admins finish it with “Complete purchase” or “Cancel purchase”.'),
      grid('two', channel(s, 'channelId', 'Panel channel'), channel(s, 'categoryId', 'Create purchase tickets in category', 'categories', 'Empty = the ticket category above.')),
      grid('four', text(s, 'title', 'Panel title', { maxLength: 100 }), text(s, 'placeholder', 'Dropdown text', { maxLength: 100 }), text(s, 'currency', 'Currency symbol', { maxLength: 4 }), colorField(s, 'color', 'Colour')),
      text(s, 'description', 'Panel description', { multiline: true, maxLength: 2000 }),
      el('b', '', 'Payment methods & sellers'),
      note('Each payment method can have its own seller role, ticket category and claim channel. When someone buys with it, the seller role is pinged in the claim channel and a seller claims the ticket. Only the claimer is added to the ticket – neither the seller role nor the admin roles can see it. Without a claim channel, the admin roles see the ticket as usual.'),
      channel(s, 'claimChannelId', 'Default claim channel', 'textChannels', 'Used by every payment method that has no claim channel of its own. Only sellers should be able to see it.'),
      listEditor(s.methods, () => ({ id: uid(), label: '', description: '', roleId: '', categoryId: '', claimChannelId: '' }), (m) => [
        grid('two', text(m, 'label', 'Name', { maxLength: 80, placeholder: 'PayPal' }), text(m, 'description', 'Short description', { maxLength: 100 })),
        grid('three', roleOne(m, 'roleId', 'Seller role (e.g. “Paypal Seller”)'), channel(m, 'categoryId', 'Ticket category for this method', 'categories'), channel(m, 'claimChannelId', 'Claim channel (optional)', 'textChannels', 'Overrides the default above')),
      ], '+ Add payment method', 25),
      el('b', '', 'Price per unit'),
      note('Members choose how many units they want (for example 5 weeks). The total is calculated as amount × price and shown in the ticket. Example: Name “week”, Days 7, Price 1.00.'),
      grid('two', text(s, 'minQuantity', 'Minimum amount', { type: 'number', min: 1, max: 1000 }), text(s, 'maxQuantity', 'Maximum amount', { type: 'number', min: 1, max: 1000 })),
      listEditor(s.plans, () => ({ id: uid(), label: '', description: '', days: 7, price: 0 }), (p) => [grid('four', text(p, 'label', 'Unit name (singular)', { maxLength: 80, placeholder: 'week' }), text(p, 'days', 'Days per unit', { type: 'number', min: 1, max: 3650 }), text(p, 'price', 'Price per unit', { type: 'number', min: 0, step: '0.01' }), text(p, 'description', 'Description', { maxLength: 100 }))], '+ Add unit (e.g. month)', 25),
      el('b', '', 'Discounts'),
      note('The highest active discount that applies is used for new orders. Admins can still set a custom discount inside a ticket.'),
      listEditor(s.discounts, () => ({ id: uid(), label: '', percent: 10, active: true, planIds: [] }), (d) => {
        const plans = el('div', 'pick-list');
        for (const p of s.plans) { const l = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = (d.planIds || []).includes(p.id); l.classList.toggle('on', cb.checked); cb.addEventListener('change', () => { const set = new Set(d.planIds || []); cb.checked ? set.add(p.id) : set.delete(p.id); d.planIds = [...set]; l.classList.toggle('on', cb.checked); mark(); }); l.append(cb, document.createTextNode(p.label || p.id)); plans.append(l); }
        return [grid('three', text(d, 'label', 'Name', { maxLength: 60, placeholder: 'Launch week' }), text(d, 'percent', 'Percent off', { type: 'number', min: 1, max: 100 }), check(d, 'active', 'Active')), field('Applies to', plans, 'None selected = every duration')];
      }, '+ Add discount', 25),
      postButton('shop', null, 'shop', 'Save & post panel')));

    // --- honeypot
    const hp = c.honeypot;
    const act = el('select'); act.append(new Option('Kick the member', 'kick'), new Option('Ban the member', 'ban')); act.value = hp.action; act.addEventListener('change', () => { hp.action = act.value; mark(); });
    root.append(section('Protection', 'Honeypot channel', note('A trap channel for spam bots: anyone who writes in it (except members with an admin role) has the message deleted and is removed from the server. Put the channel where bots find it, and give it a clear warning – the bot posts one for you.'),
      check(hp, 'enabled', 'Honeypot active'),
      grid('three', channel(hp, 'channelId', 'Honeypot channel'), field('When someone writes there', act), channel(hp, 'logChannelId', 'Log channel (optional)', 'textChannels', 'Every catch is posted here.')),
      grid('two', text(hp, 'title', 'Warning title', { maxLength: 100 }), colorField(hp, 'color', 'Colour')),
      text(hp, 'description', 'Warning text', { multiline: true, maxLength: 2000, hint: 'If you switch to “Ban”, change the text to say so.' }),
      postButton('honeypot', null, 'honeypot', 'Save & post warning')));

    // --- ratings
    root.append(section('Shop', 'Ratings & feedback', note('After a purchase is completed the buyer can rate with 1–5 stars. The rating is posted as “@name bought something and left a rating of ⭐⭐⭐⭐ (4/5)”.'),
      grid('two', channel(c.ratings, 'channelId', 'Ratings channel'), channel(c.ratings, 'feedbackChannelId', 'Feedback channel', 'textChannels', 'Written feedback goes here, separate from the ratings.'))));
  }

  async function load() {
    try {
      state = await api('/api/bot');
      cfg = clone(state.config); info = state.guild;
      dirty = false; $('botSave').textContent = 'Save settings';
      render();
    } catch (e) { toast(e.message, true); }
  }
  async function save() {
    const r = await api('/api/bot/config', { method: 'PUT', body: JSON.stringify(cfg) });
    cfg = clone(r.config); dirty = false; $('botSave').textContent = 'Save settings';
    return r;
  }
  $('botSave').addEventListener('click', async () => { try { await save(); toast('Settings saved'); await load(); } catch (e) { toast(e.message, true); } });

  // ------------------------------------------------------------ purchases

  const when = (t) => new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const money = (n, cur) => `${cur || ''}${Number(n).toFixed(2)}`;
  async function loadPurchases() {
    try {
      const d = await api('/api/purchases');
      const all = d.scope === 'all';
      $('purEyebrow').textContent = all ? 'All purchases' : 'Your purchases';
      $('purLead').textContent = all ? 'Every completed purchase from the Discord shop.' : 'Your completed purchases from the Discord shop.';
      const sum = $('purSummary'); sum.replaceChildren();
      const tile = (label, value) => { const p = el('div', 'panel'); p.append(el('p', 'eyebrow', label), el('h3', '', value)); sum.append(p); };
      const rev = Object.entries(d.summary.revenue).map(([c, v]) => money(v, c)).join(' + ') || '0.00';
      tile(all ? 'Completed' : 'Purchases', String(d.summary.count));
      tile(all ? 'Revenue' : 'Total spent', rev);
      tile(all ? 'Average rating' : 'Average rating', d.summary.avgRating ? '⭐ ' + d.summary.avgRating + ' / 5' : '–');
      if (all) tile('Open / cancelled', `${d.summary.open} / ${d.summary.cancelled}`);
      const head = $('purTable').tHead; head.replaceChildren();
      const cols = ['Date', 'Buyer', 'Seller', 'Duration', 'Payment', 'Price', 'Rating'].concat(d.canDelete ? [''] : []);
      const hr = el('tr'); cols.forEach((c) => hr.append(el('th', '', c))); head.append(hr);
      const body = $('purTable').tBodies[0]; body.replaceChildren();
      for (const r of d.rows) {
        const tr = el('tr');
        tr.append(el('td', '', when(r.completedAt)));
        const buyer = el('td'); buyer.append(el('b', '', r.discordName || r.userId)); if (all && r.account) buyer.append(el('div', 'hint', 'Dashboard: ' + r.account)); tr.append(buyer);
        const seller = el('td'); seller.append(el('b', '', r.sellerName || '–')); if (all && r.sellerAccount) seller.append(el('div', 'hint', 'Dashboard: ' + r.sellerAccount)); tr.append(seller);
        tr.append(el('td', '', `${r.plan} (${r.days} d)`), el('td', '', r.method));
        const price = el('td', 'num', money(r.total, r.currency)); if (r.discountPercent) price.append(el('div', 'hint', `-${r.discountPercent}% from ${money(r.basePrice, r.currency)}`)); tr.append(price);
        const rt = el('td'); rt.append(el('span', '', r.rating ? '⭐'.repeat(r.rating) : '–')); if (r.feedback) { rt.title = r.feedback; rt.append(el('div', 'hint', r.feedback.length > 80 ? r.feedback.slice(0, 80) + '…' : r.feedback)); } tr.append(rt);
        if (d.canDelete) { const td = el('td'); const del = el('button', 'danger sm', 'Delete'); del.type = 'button'; del.addEventListener('click', async () => { const ok = await ask({ title: 'Delete this purchase?', text: 'It is removed from the history and the statistics.', ok: 'Delete', danger: true }); if (!ok) return; try { await api('/api/purchases/' + encodeURIComponent(r.id), { method: 'DELETE' }); toast('Purchase deleted'); loadPurchases(); } catch (e) { toast(e.message, true); } }); td.append(del); tr.append(td); }
        body.append(tr);
      }
      $('purClear').hidden = !d.canDelete;
      const sb = $('purSellersBox'); sb.hidden = !(d.sellers && d.sellers.length);
      if (!sb.hidden) {
        const sh = $('purSellers').tHead; sh.replaceChildren(); const shr = el('tr'); ['Seller', 'Sales', 'Revenue', 'Average rating'].forEach((c) => shr.append(el('th', '', c))); sh.append(shr);
        const sbody = $('purSellers').tBodies[0]; sbody.replaceChildren();
        for (const s of d.sellers) { const tr = el('tr'); tr.append(el('td', '', s.name), el('td', '', String(s.count)), el('td', '', Object.entries(s.revenue).map(([c, v]) => money(v, c)).join(' + ')), el('td', '', s.avgRating ? '⭐ ' + s.avgRating : '–')); sbody.append(tr); }
      }
      const empty = $('purEmpty'); empty.hidden = d.rows.length > 0;
      $('purTable').parentElement.hidden = !d.rows.length;
      empty.textContent = !d.linked ? 'Link your Discord account first (Settings tab) to see your purchases.' : all ? 'No completed purchases yet.' : 'You have no completed purchases yet.';
    } catch (e) { toast(e.message, true); }
  }
  $('purRefresh').addEventListener('click', loadPurchases);
  $('purClear').addEventListener('click', async () => {
    const ok = await ask({ title: 'Clear the purchase history?', text: 'All completed and cancelled purchases are deleted, including the statistics and ratings. Open orders stay. This cannot be undone.', ok: 'Clear history', danger: true });
    if (!ok) return;
    try { const r = await api('/api/purchases/clear', { method: 'POST' }); toast(`${r.removed} purchase${r.removed === 1 ? '' : 's'} removed`); loadPurchases(); } catch (e) { toast(e.message, true); }
  });

  // ------------------------------------------------------------ founder: token and start/stop

  let fdTimer = null;
  async function loadFounderBot() {
    if (!document.querySelector('.tab[data-tab="founder"]:not([hidden])')) return;
    try {
      const [s, b] = await Promise.all([api('/api/founder/settings'), api('/api/bot')]);
      $('fdBotHint').textContent = s.hasBotToken ? `Saved token: ${s.botTokenHint}. Paste a new one to replace it.` : 'No token saved yet.';
      $('fdBotInvite').value = s.botInviteUrl || '';
      const st = b.status; const chip = $('fdBotStatus');
      chip.textContent = { online: `online as ${st.tag}`, starting: 'starting…', error: 'error', offline: 'offline' }[st.status]; chip.className = 'chip ' + (st.status === 'online' ? 'ok' : st.status === 'error' ? 'err' : st.status === 'starting' ? 'warn' : '');
      $('fdBotInfo').textContent = st.status === 'error' ? st.error : st.status === 'online' && !st.guildFound ? 'Online, but not in a server yet. Use the invite link.' : 'The bot starts automatically with the dashboard once it was started here.';
      $('fdBotStart').disabled = !s.hasBotToken || st.status === 'online' || st.status === 'starting';
      $('fdBotStop').disabled = st.status === 'offline';
    } catch (e) { toast(e.message, true); }
  }
  const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, true); } await loadFounderBot(); };
  $('fdBotSave').addEventListener('click', () => { const v = $('fdBotToken').value.trim(); if (!v) return toast('Paste the bot token first', true); run(async () => { await api('/api/founder/settings', { method: 'PUT', body: JSON.stringify({ botToken: v }) }); $('fdBotToken').value = ''; }, 'Token saved'); });
  $('fdBotClear').addEventListener('click', () => run(async () => { await api('/api/founder/bot/stop', { method: 'POST' }); await api('/api/founder/settings', { method: 'PUT', body: JSON.stringify({ clearBotToken: true }) }); }, 'Token removed'));
  $('fdBotStart').addEventListener('click', () => { $('fdBotStart').disabled = true; run(() => api('/api/founder/bot/start', { method: 'POST' }), 'Bot started'); });
  $('fdBotStop').addEventListener('click', () => run(() => api('/api/founder/bot/stop', { method: 'POST' }), 'Bot stopped'));
  $('fdBotInviteCopy').addEventListener('click', () => { const v = $('fdBotInvite').value; if (v) { copyText(v); toast('Invite link copied'); } });

  window.addEventListener('dashboard:tab', (e) => {
    clearInterval(fdTimer);
    const tab = e.detail.tab;
    if (tab === 'bot') load();
    if (tab === 'purchases') loadPurchases();
    if (tab === 'founder') { loadFounderBot(); fdTimer = setInterval(loadFounderBot, 10000); }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
