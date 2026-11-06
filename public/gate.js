'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const msg = new URLSearchParams(location.search).get('msg');
  if (msg) $('err').textContent = msg;
  let me;
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; return; }
    me = await r.json();
  } catch { $('sub').textContent = 'Could not reach the dashboard. Please reload.'; return; }

  const box = $('content');
  if (!me.lock) { location.href = '/'; return; }
  if (me.lock === 'discord') {
    $('sub').textContent = 'One more step';
    box.append(el('p', 'msg', 'Please link your Discord account to continue. We use it to identify you in our Discord server and for your purchases and tickets.'));
    const a = el('a', 'btn discord', 'Link Discord account'); a.href = '/auth/discord'; box.append(a);
    box.append(el('p', 'msg', 'You only need to do this once. The link can only be removed by revoking the authorization in your Discord settings.'));
  } else {
    $('sub').textContent = 'Your membership has ended';
    const left = (me.user.graceEndsAt || 0) - Date.now();
    const h = Math.max(0, Math.floor(left / 3600000)), m = Math.max(0, Math.floor((left % 3600000) / 60000));
    box.append(el('div', 'big', `${h}h ${m}min`));
    box.append(el('p', 'msg', 'Your account is locked. If no time is added within this period, the account and its bots are deleted. Contact an admin to extend your membership.'));
  }
})();
