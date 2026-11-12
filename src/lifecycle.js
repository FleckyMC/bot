'use strict';
const { accountState } = require('./auth');

/**
 * Membership lifecycle, run every minute:
 *  - the moment a membership ends the account is locked and its bots are disconnected (once);
 *  - 24 hours later, if nobody added time, the account and its bots are deleted.
 */
function runLifecycle({ auth, manager, audit, notify = () => {}, now = Date.now() }) {
  const result = { locked: [], deleted: [], slots: [] };
  // A slot whose time is over disappears together with its Microsoft account; the ones behind it move up.
  for (const e of auth.expireSlots ? auth.expireSlots(now) : []) {
    for (const n of e.bots) { try { manager.removeBot(n); } catch { /* already gone */ } }
    audit.add({ type: 'slot_expired', target: e.user, detail: `${e.count} slot${e.count === 1 ? '' : 's'} ended${e.bots.length ? ' - Microsoft account removed' : ''}` });
    notify({ type: 'slot_expired', target: e.user, at: now });
    result.slots.push(e.user.username);
  }
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
