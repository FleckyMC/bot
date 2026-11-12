'use strict';
// Accounts tab (admins), Founder tab (founder only) and the profile/password forms.
// Relies on ask(), toast() and copyText() from app.js.
(() => {
  const $ = (id) => document.getElementById(id);
  const say = (text, bad = false, id = 'accountMessage') => { const e = $(id); if (e) { e.textContent = text; e.style.color = bad ? 'var(--danger)' : ''; } };
  async function api(url, options = {}) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmtDate = (t) => new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const dur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}min` : `${m}min`; };
  const currentTab = () => (document.querySelector('.tab[aria-selected="true"]') || {}).dataset?.tab;

  let users = [];
  let realAdmin = false, realFounder = false;
  let loaded = false;

  // ------------------------------------------------------------ accounts

  async function loadUsers() {
    try {
      const d = await api('/api/admin/users');
      users = d.users || [];
      draw();
      say('', false, 'accountMessageAdmin');
      loaded = true;
      loadAudit();
    } catch (e) { say(e.message, true, 'accountMessageAdmin'); }
  }

  const daysLeft = (u) => (u.expiresAt ? Math.max(1, Math.ceil((u.expiresAt - Date.now()) / 86400000)) : '');
  const roleLabel = (r) => (r === 'founder' ? 'Founder' : r === 'admin' ? 'Admin' : r === 'bot' ? 'Team' : 'User');

  function membershipLine(u) {
    if (u.state === 'grace') return { text: `Membership ended – locked, deleted in ${dur(u.graceEndsAt - Date.now())} unless time is added`, cls: 'err' };
    if (!u.expiresAt) return { text: 'Membership: permanent', cls: '' };
    return { text: `Membership ends ${fmtDate(u.expiresAt)} (in ${dur(u.expiresAt - Date.now())})`, cls: '' };
  }

  function draw() {
    const root = $('accountList');
    root.replaceChildren();
    const q = ($('accountSearch').value || '').toLowerCase();
    const role = $('accountRole').value;
    const shown = users.filter((u) => u.username.toLowerCase().includes(q) && (role === 'all' || u.role === role));
    if (!shown.length) { const e = el('div', 'empty', 'No matching accounts.'); e.style.gridColumn = '1/-1'; root.append(e); return; }
    for (const u of shown) root.append(card(u));
  }

  function card(u) {
    const c = el('div', 'panel user-card');
    const head = el('div', 'head');
    head.append(el('b', '', u.username), el('span', 'chip plain owner', roleLabel(u.role)));
    if (u.state === 'grace') head.append(el('span', 'chip err', 'Locked'));
    c.append(head);

    // Discord
    const dRow = el('div', 'kv');
    dRow.append(el('span', '', 'Discord'));
    if (u.discord) {
      const right = el('span', 'row');
      right.append(el('b', '', u.discord.username));
      const copy = el('button', 'ghost sm', 'Copy ID'); copy.type = 'button'; copy.title = u.discord.id;
      copy.onclick = () => copyText(u.discord.id);
      right.append(copy);
      dRow.append(right);
    } else dRow.append(el('b', '', 'Not linked'));
    c.append(dRow);

    // Microsoft accounts
    const mRow = el('div', 'kv');
    mRow.append(el('span', '', 'Microsoft accounts'), el('b', '', u.role === 'user' ? `${u.botCount} of ${u.botLimit} connected` : `${u.botCount} connected · no limit`));
    c.append(mRow);
    if (u.role === 'user') {
      const m = el('div', 'meter' + (u.botCount >= u.botLimit ? ' low' : ''));
      const i = el('i'); i.style.width = (u.botLimit ? Math.min(100, (u.botCount / u.botLimit) * 100) : 100) + '%'; m.append(i); c.append(m);
    }

    const ms = membershipLine(u);
    const msEl = el('div', 'hint', u.role === 'user' && u.slots && u.slots.length ? (u.state === 'grace' ? ms.text : 'Each Microsoft account slot has its own end date:') : ms.text);
    if (ms.cls === 'err') msEl.style.color = 'var(--danger)';
    c.append(msEl);
    if (u.role === 'user') for (let i = 0; i < (u.slots || []).length; i++) c.append(slotRow(u, u.slots[i], i));

    const actions = el('div', 'row wrap');
    const btn = (text, cls, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; actions.append(b); };
    if (u.can.manage) {
      btn('Edit', 'sm', () => edit(u));
      if (u.role === 'user') btn('＋ Add slot', 'sm', () => addSlot(u));
      else if (u.expiresAt) btn('＋ Add time', 'sm', () => addTime(u));
    }
    if (u.can.remove) btn('Delete', 'danger sm', () => remove(u));
    if (actions.childElementCount) c.append(actions);
    return c;
  }

  const endText = (s) => (s.expiresAt ? `ends ${fmtDate(s.expiresAt)} (in ${dur(s.expiresAt - Date.now())})` : 'permanent');
  function slotRow(u, s, i) {
    const row = el('div', 'kv slot');
    const left = el('span', '', `Slot ${i + 1} · ${s.used ? 'in use' : 'free'}`);
    const right = el('span', 'row wrap');
    const expired = s.expiresAt && s.expiresAt <= Date.now();
    const label = el('b', '', expired ? 'ended' : endText(s));
    if (expired) label.style.color = 'var(--danger)';
    right.append(label);
    if (u.can.manage) {
      const b = (text, title, fn, cls = 'ghost sm') => { const x = el('button', cls, text); x.type = 'button'; x.title = title; x.onclick = fn; right.append(x); };
      if (s.expiresAt) b('＋', 'Add days to this slot', () => addSlotTime(u, i));
      b('✎', 'Change the end of this slot', () => changeSlot(u, i));
      b('✕', 'Remove this slot', () => removeSlot(u, i), 'ghost sm danger');
    }
    row.append(left, right);
    return row;
  }
  async function slotCall(u, path, method, body, okText) {
    try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/slots${path}`, { method, body: body ? JSON.stringify(body) : undefined }); toast(okText); await loadUsers(); }
    catch (e) { toast(e.message, true); }
  }
  const parseDays = (v) => { const t = String(v).trim(); if (!t) return { days: null }; const n = Number(t); return Number.isInteger(n) && n >= 1 && n <= 3650 ? { days: n } : { error: 'Enter a whole number of days between 1 and 3650 (empty = permanent)' }; };
  async function addSlot(u) {
    const r = await ask({ title: `Add a slot to ${u.username}`, text: 'One more Microsoft account the user may connect. It disappears together with its account when the time is over.', ok: 'Add slot', fields: [{ key: 'days', label: 'How many days? (empty = permanent)', type: 'number', min: 1, max: 3650, value: '7' }] });
    if (!r) return;
    const p = parseDays(r.days);
    if (p.error) return toast(p.error, true);
    await slotCall(u, '', 'POST', { days: p.days }, 'Slot added');
  }
  async function addSlotTime(u, i) {
    const r = await ask({ title: `Add time to slot ${i + 1} of ${u.username}`, text: 'The days are added to the end of this slot only.', ok: 'Add time', fields: [{ key: 'days', label: 'Days to add', type: 'number', min: 1, max: 3650, value: '7' }] });
    if (!r) return;
    const days = Number(r.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return toast('Enter a whole number of days between 1 and 3650', true);
    await slotCall(u, `/${i}/add-time`, 'POST', { days }, `${days} day${days === 1 ? '' : 's'} added`);
  }
  async function changeSlot(u, i) {
    const r = await ask({ title: `Change slot ${i + 1} of ${u.username}`, text: 'The new end counts from now.', ok: 'Save', fields: [{ key: 'days', label: 'Ends in how many days? (empty = permanent)', type: 'number', min: 1, max: 3650, value: u.slots[i].expiresAt ? String(Math.max(1, Math.ceil((u.slots[i].expiresAt - Date.now()) / 86400000))) : '' }] });
    if (!r) return;
    const p = parseDays(r.days);
    if (p.error) return toast(p.error, true);
    await slotCall(u, `/${i}`, 'PATCH', { days: p.days }, 'Slot updated');
  }
  async function removeSlot(u, i) {
    const r = await ask({ title: `Remove slot ${i + 1} of ${u.username}?`, text: u.slots[i].used ? 'The Microsoft account in this slot is disconnected and removed. The slots behind it move up.' : 'The slots behind it move up.', ok: 'Remove slot', danger: true });
    if (!r) return;
    await slotCall(u, `/${i}`, 'DELETE', null, 'Slot removed');
  }

  async function edit(u) {
    // Regular accounts only get renamed here; their Microsoft account slots (and the time of each) are edited on the card.
    const fields = [{ key: 'username', label: 'Username', value: u.username, maxLength: 32 }];
    if (u.role !== 'user') fields.push({ key: 'days', label: 'Membership in days from now (empty = permanent)', type: 'number', value: daysLeft(u), min: 1, hint: 'To extend by some days, use “Add time” instead.' });
    const r = await ask({ title: `Edit ${u.username}`, ok: 'Save', fields });
    if (!r) return;
    const body = {};
    if (r.username.trim() !== u.username) body.username = r.username.trim();
    if (u.role !== 'user') {
      const days = String(r.days).trim();
      if (String(daysLeft(u)) !== days) body.expiresAt = days ? Date.now() + Math.max(1, Number(days)) * 86400000 : null;
    }
    if (!Object.keys(body).length) return;
    try { await api('/api/admin/users/' + encodeURIComponent(u.id), { method: 'PATCH', body: JSON.stringify(body) }); toast('Account updated'); await loadUsers(); }
    catch (e) { toast(e.message, true); }
  }

  async function addTime(u) {
    const r = await ask({ title: `Add time to ${u.username}`, text: u.state === 'grace' ? 'The account is locked. Adding time unlocks it right away, counted from now.' : 'The days are added to the current end of the membership.', ok: 'Add time', fields: [{ key: 'days', label: 'Days to add', type: 'number', value: 30, min: 1, max: 3650 }] });
    if (!r) return;
    const days = Number(r.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return toast('Enter a whole number of days between 1 and 3650', true);
    try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/add-time`, { method: 'POST', body: JSON.stringify({ days }) }); toast(`${days} day${days === 1 ? '' : 's'} added`); await loadUsers(); }
    catch (e) { toast(e.message, true); }
  }

  async function remove(u) {
    const n = u.botCount || 0;
    const r = await ask({ title: `Delete ${u.username}?`, text: n ? `Their ${n} connected Minecraft account${n === 1 ? ' is' : 's are'} disconnected and removed as well. This cannot be undone.` : 'This cannot be undone.', ok: 'Delete account', danger: true });
    if (!r) return;
    try { await api('/api/admin/users/' + encodeURIComponent(u.id), { method: 'DELETE' }); toast('Account deleted'); await loadUsers(); }
    catch (e) { toast(e.message, true); }
  }

  // ---------- audit log

  const VERB = {
    created: 'created account', deleted: 'deleted account', auto_deleted: 'was deleted automatically (not renewed)', expired: 'membership ended:',
    time_added: 'added time to', slot_added: 'added a slot to', slot_changed: 'changed a slot of', slot_time_added: 'added time to a slot of', slot_removed: 'removed a slot of', slot_expired: 'slot ended:', renamed: 'renamed', limit_changed: 'changed the limit of', lifetime_changed: 'changed the membership of',
    discord_linked: 'linked Discord:', discord_changed: 'changed the connected Discord account of', discord_revoked: 'revoked the Discord authorization of',
    bot_config: 'changed the Discord bot settings', bot_panel: 'posted a bot panel:', bot_started: 'started the Discord bot', bot_stopped: 'stopped the Discord bot',
    bot_honeypot: 'caught someone:', purchase_claimed: 'claimed a ticket:', purchase_unclaimed: 'unclaimed a ticket:', purchase_deleted: 'removed from the purchase history:', audit_cleared: 'cleared the activity log', bot_kick: 'kicked', bot_ban: 'banned', bot_unban: 'unbanned', purchase_completed: 'completed a purchase:', purchase_cancelled: 'purchase cancelled:', purchase_rated: 'rating received:',
  };
  async function loadAudit() {
    const box = $('auditList');
    if (!box) return;
    try {
      const { entries } = await api('/api/admin/audit?limit=200');
      box.replaceChildren();
      if (!entries.length) { box.append(el('div', '', 'No activity yet.')); return; }
      for (const e of entries) {
        const row = el('div', e.type.includes('delete') || e.type === 'discord_revoked' ? 'warn' : '');
        const actor = e.actor ? `${roleLabel(e.actor.role)} @${e.actor.username}` : 'System';
        const target = e.target ? '@' + e.target.username : '';
        const text = ['auto_deleted', 'expired', 'discord_linked', 'purchase_cancelled', 'purchase_rated'].includes(e.type) ? `${target} ${VERB[e.type]}` : `${actor} ${VERB[e.type] || e.type} ${target}`;
        row.append(el('span', 't', fmtDate(e.t) + '  '), document.createTextNode(text.replace(/\s+/g, ' ').trim()));
        if (e.detail) row.append(el('span', 'src', ' – ' + e.detail));
        box.append(row);
      }
    } catch (e) { box.textContent = e.message; }
  }

  $('createAccount').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const days = String(f.get('days') || '').trim();
    const payload = { username: f.get('username'), password: f.get('password'), role: realFounder ? f.get('role') : 'user', botLimit: Number(f.get('botLimit')), expiresAt: days ? Date.now() + Math.max(1, Number(days)) * 86400000 : null };
    try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }); form.reset(); form.elements.botLimit.value = 1; toast('Account created'); await loadUsers(); }
    catch (err) { toast(err.message, true); }
  });
  $('refreshAccounts').addEventListener('click', loadUsers);
  $('clearAudit').addEventListener('click', async () => {
    const r = await ask({ title: 'Clear the activity log?', text: 'This removes the whole account activity history for everyone. It cannot be undone.', ok: 'Clear log', danger: true });
    if (!r) return;
    try { await api('/api/admin/audit/clear', { method: 'POST' }); toast('Activity log cleared'); loadAudit(); } catch (e) { toast(e.message, true); }
  });
  $('accountSearch').addEventListener('input', draw);
  $('accountRole').addEventListener('change', draw);

  // ------------------------------------------------------------ founder settings

  const EVENT_LABELS = {
    created: 'Account created (with membership length)', deleted: 'Account deleted by an admin or the founder', auto_deleted: 'Account deleted automatically after the 24 h grace period',
    expired: 'Membership ended (24 h countdown starts)', time_added: 'Time added to an account', renamed: 'Account renamed', discord_changed: 'Discord account changed or authorization revoked',
  };
  let fdEvents = {};
  async function loadFounder() {
    try {
      const s = await api('/api/founder/settings');
      $('fdClientId').value = s.discord.clientId;
      $('fdClientSecret').value = '';
      $('fdSecretHint').textContent = s.discord.hasSecret ? `Saved secret: ${s.discord.secretHint}. Leave empty to keep it.` : 'No secret saved yet.';
      $('fdPublicUrl').value = s.discord.publicUrl;
      $('fdRedirect').value = s.discord.redirectUri || 'Enter the public URL and save';
      const st = $('fdStatus'); st.textContent = s.discord.configured ? 'active' : 'not set up'; st.className = 'chip ' + (s.discord.configured ? 'ok' : 'warn');
      $('fdHookOn').checked = s.accountWebhook.enabled;
      $('fdHookUrl').value = '';
      $('fdHookHint').textContent = s.accountWebhook.hasUrl ? `Saved webhook: ${s.accountWebhook.urlHint}. Leave empty to keep it.` : 'No webhook saved yet. The URL is stored on the server and never shown again.';
      fdEvents = s.accountWebhook.events;
      const box = $('fdEvents'); box.replaceChildren();
      for (const name of s.eventNames) {
        const label = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!fdEvents[name]; cb.dataset.event = name;
        label.append(cb, document.createTextNode(' ' + (EVENT_LABELS[name] || name)));
        box.append(label);
      }
    } catch (e) { toast(e.message, true); }
  }
  async function saveFounder(patch, okMsg) {
    try { await api('/api/founder/settings', { method: 'PUT', body: JSON.stringify(patch) }); toast(okMsg); await loadFounder(); }
    catch (e) { toast(e.message, true); }
  }
  $('fdSaveDiscord').addEventListener('click', () => {
    const discord = { clientId: $('fdClientId').value.trim(), publicUrl: $('fdPublicUrl').value.trim() };
    if ($('fdClientSecret').value.trim()) discord.clientSecret = $('fdClientSecret').value.trim();
    saveFounder({ discord }, 'Discord settings saved');
  });
  $('fdCopyRedirect').addEventListener('click', () => { const v = $('fdRedirect').value; if (v.startsWith('http')) copyText(v); });
  $('fdSaveHook').addEventListener('click', () => {
    const events = {};
    for (const cb of document.querySelectorAll('#fdEvents input[data-event]')) events[cb.dataset.event] = cb.checked;
    const accountWebhook = { enabled: $('fdHookOn').checked, events };
    if ($('fdHookUrl').value.trim()) accountWebhook.url = $('fdHookUrl').value.trim();
    saveFounder({ accountWebhook }, 'Webhook settings saved');
  });
  $('fdTestHook').addEventListener('click', async () => {
    try { await api('/api/founder/webhook-test', { method: 'POST', body: '{}' }); toast('Test message sent'); } catch (e) { toast(e.message, true); }
  });

  // ------------------------------------------------------------ profile / password

  $('changePassword').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try { await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') }) }); form.reset(); say('Password updated.'); }
    catch (err) { say(err.message, true); }
  });

  // ------------------------------------------------------------ tab visibility

  const showAdmin = () => {
    for (const n of document.querySelectorAll('[data-realadmin]')) n.hidden = !realAdmin;
    for (const n of document.querySelectorAll('[data-realfounder]')) n.hidden = !realFounder;
    $('roleField').hidden = !realFounder;
    if ((realAdmin || realFounder) && ['#accounts', '#founder'].includes(location.hash)) window.dispatchEvent(new Event('hashchange'));
  };
  window.addEventListener('dashboard:tab', (e) => {
    if (realAdmin && e.detail.tab === 'accounts') loadUsers();
    if (realFounder && e.detail.tab === 'founder') loadFounder();
  });
  window.addEventListener('dashboard:view-as-changed', showAdmin);
  api('/api/me').then(({ user }) => {
    realAdmin = !!user && (user.role === 'admin' || user.role === 'founder');
    realFounder = !!user && user.role === 'founder';
    $('pfDiscord').textContent = user && user.discord ? user.discord.username : (user && user.role === 'founder' ? 'Not required for the founder' : 'Not linked');
    showAdmin();
    const tab = currentTab();
    if (realAdmin && tab === 'accounts') loadUsers();
    if (realFounder && tab === 'founder') loadFounder();
  }).catch(() => {});
  // keep the countdowns and counters fresh while the tab is open
  setInterval(() => { if (realAdmin && loaded && currentTab() === 'accounts' && !$('askDialog').open) loadUsers(); }, 20000);
})();
