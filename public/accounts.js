'use strict';
// Admin "Accounts" tab and the password form. Relies on ask() and toast() from app.js.
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
  let users = [];
  let realAdmin = false;
  let loaded = false;

  async function loadUsers() {
    try { users = (await api('/api/admin/users')).users || []; draw(); say('', false, 'accountMessageAdmin'); loaded = true; }
    catch (e) { say(e.message, true, 'accountMessageAdmin'); }
  }

  const daysLeft = (u) => (u.expiresAt ? Math.max(1, Math.ceil((u.expiresAt - Date.now()) / 86400000)) : '');

  function draw() {
    const root = $('accountList');
    root.replaceChildren();
    const q = ($('accountSearch').value || '').toLowerCase();
    const shown = users.filter((u) => u.username.toLowerCase().includes(q));
    if (!shown.length) { const e = el('div', 'empty', 'No matching accounts.'); e.style.gridColumn = '1/-1'; root.append(e); return; }
    for (const u of shown) {
      const card = el('div', 'panel user-card');
      const head = el('div', 'head');
      head.append(el('b', '', u.username), el('span', 'chip plain ' + (u.role === 'admin' ? 'owner' : ''), u.role === 'admin' ? 'Admin' : 'User'));
      card.append(head);
      if (u.role !== 'admin') {
        const used = u.botCount || 0;
        const row = el('div', 'kv');
        row.append(el('span', '', 'Minecraft accounts'), el('b', '', `${used} of ${u.botLimit} used`));
        card.append(row);
        const m = el('div', 'meter' + (used >= u.botLimit ? ' low' : '')); const i = el('i'); i.style.width = (u.botLimit ? Math.min(100, used / u.botLimit * 100) : 100) + '%'; m.append(i); card.append(m);
        const tags = el('div', 'bot-tags');
        for (const b of (u.bots || [])) tags.append(el('span', 'chip plain', b.accountName || b.name));
        if (!(u.bots || []).length) tags.append(el('span', 'hint', 'No Minecraft accounts connected yet'));
        card.append(tags);
      } else {
        card.append(el('p', 'hint', 'Admins have no account limit.'));
      }
      card.append(el('div', 'hint', 'Lifetime: ' + (u.expiresAt ? 'until ' + new Date(u.expiresAt).toLocaleString('en-GB') : 'permanent')));
      const actions = el('div', 'row wrap');
      if (u.role !== 'admin') {
        const edit = el('button', 'sm', 'Edit limit / lifetime'); edit.type = 'button';
        edit.onclick = async () => {
          const r = await ask({
            title: `Edit ${u.username}`, ok: 'Save',
            fields: [
              { key: 'limit', label: 'Minecraft account limit (0–100)', type: 'number', value: u.botLimit, min: 0, max: 100, hint: u.botCount > u.botLimit ? 'Accounts above the new limit stay connected, but no new ones can be added.' : 'Lowering the limit never removes accounts that are already connected.' },
              { key: 'days', label: 'Lifetime in days (empty = permanent)', type: 'number', value: daysLeft(u), min: 1 },
            ],
          });
          if (!r) return;
          const limit = Number(r.limit);
          if (!Number.isInteger(limit) || limit < 0 || limit > 100) return toast('The limit must be a whole number between 0 and 100', true);
          const days = String(r.days).trim();
          try {
            await api('/api/admin/users/' + encodeURIComponent(u.id), { method: 'PATCH', body: JSON.stringify({ botLimit: limit, expiresAt: days ? Date.now() + Math.max(1, Number(days)) * 86400000 : null }) });
            toast('Account updated'); await loadUsers();
          } catch (e) { toast(e.message, true); }
        };
        actions.append(edit);
      }
      const view = el('button', 'ghost sm', 'View as user'); view.type = 'button';
      view.onclick = () => window.dispatchEvent(new CustomEvent('dashboard:view-as', { detail: { userId: u.id, username: u.username } }));
      actions.append(view);
      if (u.role !== 'admin') {
        const del = el('button', 'danger sm', 'Delete'); del.type = 'button';
        del.onclick = async () => {
          const n = (u.bots || []).length;
          const r = await ask({ title: `Delete ${u.username}?`, text: n ? `Their ${n} connected Minecraft account${n === 1 ? ' is' : 's are'} disconnected and removed as well.` : 'This cannot be undone.', ok: 'Delete account', danger: true });
          if (!r) return;
          try { await api('/api/admin/users/' + encodeURIComponent(u.id), { method: 'DELETE' }); toast('Account deleted'); await loadUsers(); }
          catch (e) { toast(e.message, true); }
        };
        actions.append(del);
      }
      card.append(actions);
      root.append(card);
    }
  }

  $('createAccount').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const days = String(f.get('days') || '').trim();
    const payload = { username: f.get('username'), password: f.get('password'), botLimit: Number(f.get('botLimit')), expiresAt: days ? Date.now() + Math.max(1, Number(days)) * 86400000 : null };
    try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }); form.reset(); form.elements.botLimit.value = 1; toast('Account created'); await loadUsers(); }
    catch (err) { toast(err.message, true); }
  });
  $('refreshAccounts').addEventListener('click', loadUsers);
  $('accountSearch').addEventListener('input', draw);
  $('changePassword').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try { await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') }) }); form.reset(); say('Password updated.'); }
    catch (err) { say(err.message, true); }
  });

  // The Accounts tab belongs to the real admin, also while viewing the dashboard as a user.
  const showAdmin = () => { for (const n of document.querySelectorAll('[data-realadmin]')) n.hidden = !realAdmin; if (realAdmin && location.hash === '#accounts') window.dispatchEvent(new Event('hashchange')); };
  window.addEventListener('dashboard:tab', (e) => { if (realAdmin && e.detail.tab === 'accounts') loadUsers(); });
  window.addEventListener('dashboard:view-as-changed', showAdmin);
  api('/api/me').then(({ user }) => {
    realAdmin = !!user && user.role === 'admin';
    showAdmin();
    if (realAdmin && document.querySelector('.tab[aria-selected="true"]')?.dataset.tab === 'accounts') loadUsers();
  }).catch(() => {});
  setInterval(() => { if (realAdmin && loaded && document.querySelector('.tab[aria-selected="true"]')?.dataset.tab === 'accounts' && !document.getElementById('askDialog').open) loadUsers(); }, 15000);
})();
