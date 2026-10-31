'use strict';

// Deny unknown/global actions for regular users. Never let a missing chat
// target fall through to BotManager.sendChat's administrator broadcast mode.
function authorizeAction(user, type, payload, owned) {
  if (!user) throw new Error('Session expired. Sign in again.');
  if (user.role === 'admin') return;
  if (type === 'stop') return;
  if (type === 'chat') {
    const target = payload && payload.target;
    if (typeof target !== 'string' || !target || target === 'all' || !owned(target, user)) {
      throw new Error('Select a bot assigned to this account.');
    }
    return;
  }
  if (type === 'bot_profile' && typeof payload?.name === 'string' && owned(payload.name, user)) return;
  if (type === 'disconnect_selected' && Array.isArray(payload?.names) && payload.names.length &&
      payload.names.every(name => typeof name === 'string' && owned(name, user))) return;
  throw new Error('Only the admin can change global settings or control unassigned bots.');
}

module.exports = { authorizeAction };
