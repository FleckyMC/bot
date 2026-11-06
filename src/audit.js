'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Append-only history of account events (created, deleted, time added, Discord changes, ...).
 * Kept in memory and saved to a JSON file; the newest MAX entries are retained.
 */
const MAX = 2000;

function createAudit(file) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(entries)) entries = []; } catch { entries = []; }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* the log is best effort */ }
  };
  const ref = (u) => (u ? { id: u.id || null, username: u.username || null, role: u.role || null } : null);

  /** type: created | deleted | auto_deleted | expired | time_added | renamed | limit_changed | discord_linked | discord_changed | discord_revoked */
  function add({ type, actor = null, target = null, detail = '' }) {
    const entry = { t: Date.now(), type, actor: ref(actor), target: ref(target), detail: String(detail || '').slice(0, 300) };
    entries.push(entry);
    if (entries.length > MAX) entries = entries.slice(-MAX);
    save();
    return entry;
  }

  /** Newest first. Admins never see the founder: entries about the founder are hidden and the founder's name is masked. */
  function list({ limit = 200, viewer = 'founder' } = {}) {
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = entries[i];
      if (viewer !== 'founder') {
        if (e.target && e.target.role === 'founder') continue;
        if (e.actor && e.actor.role === 'founder') { out.push({ ...e, actor: { id: null, username: 'Founder', role: 'founder' } }); continue; }
      }
      out.push(e);
    }
    return out;
  }
  return { add, list, size: () => entries.length };
}

module.exports = { createAudit };
