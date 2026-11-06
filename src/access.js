'use strict';

// Deny unknown/global actions for regular users. Never let a missing chat
// target fall through to BotManager.sendChat's administrator broadcast mode.
//
// Regular users own the Microsoft accounts they connected themselves. They may add accounts (the
// per-user limit is enforced in index.js), and connect, control, drop items from and remove only
// their own bots. Everything global (area, settings, version, bot settings) stays admin-only.
function authorizeAction(user, type, payload, owned) {
  if (!user) throw new Error('Session expired. Sign in again.');
  if (user.role === 'admin' || user.role === 'founder') return;
  const name = payload && typeof payload.name === 'string' ? payload.name : '';
  const namesAllOwned = (names) => Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === 'string' && owned(n, user));

  if (type === 'stop') return;
  if (type === 'add_bot' || type === 'cancel_signin') return; // limit / ownership checked by the dashboard handler
  if (type === 'chat') {
    const target = payload && payload.target;
    if (typeof target !== 'string' || !target || target === 'all' || !owned(target, user)) {
      throw new Error('Select a bot that belongs to your account.');
    }
    return;
  }
  if ((type === 'bot_profile' || type === 'remove_bot' || type === 'drop_items' || type === 'drop_all') && name && owned(name, user)) return;
  if (type === 'disconnect_selected' && namesAllOwned(payload && payload.names)) return;
  if (type === 'connect_selected' && namesAllOwned(payload && payload.names)) return;
  throw new Error('Only the admin can change global settings or control bots that are not yours.');
}

module.exports = { authorizeAction };
