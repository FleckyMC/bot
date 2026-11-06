'use strict';
const { accountState } = require('./auth');

/**
 * Membership lifecycle, run every minute:
 *  - the moment a membership ends the account is locked and its bots are disconnected (once);
 *  - 24 hours later, if nobody added time, the account and its bots are deleted.
 */
function runLifecycle({ auth, manager, audit, notify = () => {}, now = Date.now() }) {
  const result = { locked: [], deleted: [] };
  for (const u of auth.getUsers()) {
    if (u.role === 'founder') continue;
    const state = accountState(u, now);
    const names = (Array.isArray(u.botNames) ? u.botNames : []).filter((n) => manager.workers && manager.workers.has(n));
    if (state === 'grace' && !u.expiredHandled) {
      try { if (names.length) { manager.stopBots(names); manager.disconnectSelected(names); } } catch { /* bots may already be offline */ }
      auth.markExpiredHandled(u.id);
      audit.add({ type: 'expired', target: u, detail: 'Membership ended, 24 h until deletion' });
      notify({ type: 'expired', target: u, at: now });
      result.locked.push(u.username);
    } else if (state === 'gone') {
      for (const n of names) { try { manager.removeBot(n); } catch { /* already gone */ } }
      auth.deleteUser(u.id);
      audit.add({ type: 'auto_deleted', target: u, detail: 'Membership not renewed within 24 h' });
      notify({ type: 'auto_deleted', target: u, at: now });
      result.deleted.push(u.username);
    }
  }
  return result;
}

module.exports = { runLifecycle };
