'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Runtime data of the Discord bot (data/botdata.json): open tickets, purchases and the messages of posted panels. */
function createBotData(file) {
  let data = { tickets: [], purchases: [], panels: {} };
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); data = { tickets: s.tickets || [], purchases: s.purchases || [], panels: s.panels || {} }; } catch { /* first start */ }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const open = () => data.tickets.filter((t) => !t.closedAt);
  return {
    openTicketsFor: (userId) => open().filter((t) => t.userId === userId),
    ticketByChannel: (channelId) => open().find((t) => t.channelId === channelId) || null,
    addTicket(t) { const rec = { ...t, createdAt: Date.now(), closedAt: 0 }; data.tickets.push(rec); save(); return rec; },
    closeTicket(channelId) {
      const t = data.tickets.find((x) => x.channelId === channelId && !x.closedAt);
      if (t) { t.closedAt = Date.now(); data.tickets = data.tickets.filter((x) => !x.closedAt || Date.now() - x.closedAt < 7 * 86400000); save(); }
      return t || null;
    },
    addPurchase(p) { const rec = { id: crypto.randomBytes(4).toString('hex'), status: 'open', createdAt: Date.now(), ...p }; data.purchases.push(rec); save(); return rec; },
    purchase: (id) => data.purchases.find((p) => p.id === id) || null,
    purchaseByChannel: (channelId) => data.purchases.find((p) => p.channelId === channelId && p.status === 'open') || data.purchases.find((p) => p.channelId === channelId) || null,
    updatePurchase(id, patch) { const p = data.purchases.find((x) => x.id === id); if (!p) return null; Object.assign(p, patch); save(); return p; },
    purchaseByNotify: (messageId) => data.purchases.find((p) => p.notifyMessageId === messageId) || null,
    deletePurchase(id) {
      const p = data.purchases.find((x) => x.id === id);
      if (!p) return false;
      if (p.status === 'open') throw new Error('This order is still open. Cancel or complete it in Discord first.');
      data.purchases = data.purchases.filter((x) => x.id !== id); save(); return true;
    },
    clearPurchases() { const n = data.purchases.filter((p) => p.status !== 'open').length; data.purchases = data.purchases.filter((p) => p.status === 'open'); save(); return n; },
    purchases: () => data.purchases.slice(),
    setPanel(key, value) { data.panels[key] = value; save(); },
    getPanel: (key) => data.panels[key] || null,
    panels: () => ({ ...data.panels }),
    panelsWhere: (prefix) => Object.entries(data.panels).filter(([k]) => k.startsWith(prefix)),
  };
}

module.exports = { createBotData };
