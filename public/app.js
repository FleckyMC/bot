'use strict';
const $ = (id) => document.getElementById(id);
const socket = io();
const ICONS = window.ItemIcons;

let state = null;
let formsFilled = false;
let msaDismissed = false;
let lastMsaSig = '';
let invBot = null;
const invSel = new Map(); // slot -> item name (for stale-selection checks)
const picked = new Set(); // bots ticked on the Bots tab
const sigs = {};
const TABS = ['overview', 'bots', 'inventory', 'mining', 'automation', 'console', 'accounts', 'bot', 'purchases', 'founder', 'settings'];

// ------------------------------------------------------------ helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const num = (id) => { const v = $(id).value.trim(); return v === '' ? NaN : Number(v); };
const botLabel = (b) => b.accountName || b.name;
const serverOf = (b) => b.serverAddress ? `${b.serverAddress.host}${b.serverAddress.port && b.serverAddress.port !== 25565 ? ':' + b.serverAddress.port : ''}` : '';
const humanize = (n) => String(n || '').replace(/^minecraft:/, '').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const changed = (key, value) => { if (sigs[key] === value) return false; sigs[key] = value; return true; };

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2600);
}

// Sends an action; resolves with the server's reply and shows errors/success as a toast.
function call(type, payload, okMsg) {
  return new Promise((resolve) => {
    socket.emit('action', type, payload, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Something went wrong', true);
      else if (okMsg) toast(okMsg);
      resolve(res || { ok: false });
    });
  });
}
const act = (type, payload, okMsg) => { call(type, payload, okMsg); };

// Small modal for questions and confirmations. Resolves with the entered values, or null when cancelled.
function ask({ title, text = '', fields = [], ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('askDialog');
    $('askTitle').textContent = title;
    $('askText').textContent = text;
    $('askText').hidden = !text;
    const box = $('askFields');
    box.replaceChildren();
    const inputs = {};
    for (const f of fields) {
      const label = el('label', f.type === 'checkbox' ? 'check' : '');
      const input = el('input');
      input.type = f.type || 'text';
      if (f.type === 'checkbox') input.checked = !!f.value;
      else if (f.value !== undefined) input.value = f.value;
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.maxLength) input.maxLength = f.maxLength;
      inputs[f.key] = input;
      if (f.type === 'checkbox') label.append(input, document.createTextNode(' ' + f.label));
      else { label.append(document.createTextNode(f.label), input); }
      if (f.hint) label.append(el('span', 'hint', f.hint));
      box.append(label);
    }
    const okBtn = $('askOk');
    okBtn.textContent = ok;
    okBtn.className = danger ? 'danger' : 'primary';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      $('askForm').onsubmit = null; $('askCancel').onclick = null; dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    $('askForm').onsubmit = (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) values[f.key] = f.type === 'checkbox' ? inputs[f.key].checked : inputs[f.key].value;
      finish(values);
    };
    $('askCancel').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    const first = fields.find((f) => f.type !== 'checkbox');
    if (first) inputs[first.key].focus(); else okBtn.focus();
  });
}

// ------------------------------------------------------------ tabs

function visibleTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  return !!btn && !btn.hidden;
}
function showTab(name) {
  if (!TABS.includes(name) || !visibleTab(name)) name = 'overview';
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
  window.dispatchEvent(new CustomEvent('dashboard:tab', { detail: { tab: name } }));
}
const currentTab = () => (document.querySelector('.tab[aria-selected="true"]') || {}).dataset?.tab || 'overview';
const goto = (name) => { if (location.hash.slice(1) === name) showTab(name); else location.hash = name; };
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => goto(t.dataset.tab));
for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => goto(b.dataset.goto));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

function applyRole(s) {
  for (const n of document.querySelectorAll('[data-admin]')) n.hidden = !s.isAdmin;
  if (!visibleTab(currentTab())) showTab('overview');
}

// ------------------------------------------------------------ forms (admin settings, filled once)

function fillForms(s) {
  if (!s.isAdmin || !s.settings || s.settings.durabilityThreshold === undefined) return;
  $('version').textContent = s.version || 'auto';
  $('mcVersion').value = s.version || 'auto';
  if (s.area) {
    $('x1').value = s.area.p1.x; $('y1').value = s.area.p1.y; $('z1').value = s.area.p1.z;
    $('x2').value = s.area.p2.x; $('y2').value = s.area.p2.y; $('z2').value = s.area.p2.z;
  }
  $('sThreshold').value = s.settings.durabilityThreshold;
  $('sDelay').value = s.settings.throwDelayMs;
  $('sFree').value = s.settings.minFreeSlots;
  $('fishThreshold').value = s.settings.fishingThreshold ?? 20;
  $('fishMending').checked = s.settings.fishingUseMending !== false;
  $('fishDeposit').checked = s.settings.fishingDeposit !== false;
  $('sLiquid').checked = !!s.settings.avoidLiquid;
  $('sOutside').checked = !!s.settings.allowDigOutside;
  $('sExcluded').value = (s.settings.excludedBlocks || []).join(', ');
  if (s.settings.chest) { $('cx').value = s.settings.chest.x; $('cy').value = s.settings.chest.y; $('cz').value = s.settings.chest.z; }
  $('autoEat').checked = s.settings.autoEat !== false;
  $('autoEatThreshold').value = s.settings.autoEatThreshold ?? 14;
  $('dropItems').value = (s.settings.dropItems || []).join(', ');
  formsFilled = true;
}

// ------------------------------------------------------------ render

const STATUS = {
  idle: ['Ready', 'ok'], mining: ['Mining', 'ok'], fishing: ['Fishing', 'ok'], afk: ['AFK', 'ok'], trading: ['Trading', 'ok'],
  repairing: ['Repairing', 'warn'], depositing: ['Depositing', 'warn'], done: ['Done', 'ok'], error: ['Error', 'err'],
  offline: ['Offline', 'err'], connecting: ['Connecting', 'warn'], reconnecting: ['Reconnecting', 'warn'],
};
const statusOf = (b) => (b.pos ? (STATUS[b.status] || [humanize(b.status), 'ok']) : (STATUS[b.status] && b.status !== 'idle' && b.status !== 'done' ? STATUS[b.status] : ['Offline', 'err']));

function render(s) {
  state = s;
  if (!formsFilled) fillForms(s);
  applyRole(s);
  renderHeader(s);
  renderOverview(s);
  renderMining(s);
  renderBots(s);
  renderInventory(s);
  renderChatTargets(s);
  renderMsa(s);
  renderProfile(s);
}

function renderHeader(s) {
  const online = s.bots.filter((b) => b.pos).length;
  const c = $('conn');
  c.textContent = `${online}/${s.bots.length} online`;
  c.className = 'chip ' + (online ? 'ok' : '');
  $('whoName').textContent = s.me ? s.me.username : '';
  const cnt = $('botCount');
  cnt.hidden = !s.bots.length;
  cnt.textContent = String(s.bots.length);
  $('version').textContent = s.version || 'auto';
}

function limitText(s) {
  const l = s.limits || { used: 0, limit: 0, unlimited: false };
  return l.unlimited ? `${l.used} connected · unlimited` : `${l.used} of ${l.limit} used`;
}

function renderOverview(s) {
  const online = s.bots.filter((b) => b.pos).length;
  $('stOnline').textContent = String(online);
  $('stOnlineSub').textContent = `of ${s.bots.length} account${s.bots.length === 1 ? '' : 's'}`;
  const l = s.limits || { used: s.bots.length, limit: 0, unlimited: true };
  $('stAccounts').textContent = String(l.unlimited ? s.bots.length : l.used);
  $('stAccountsSub').textContent = l.unlimited ? 'Admin · no limit' : `of ${l.limit} allowed`;
  const meter = $('stAccountsMeter');
  meter.hidden = l.unlimited;
  if (!l.unlimited) {
    const pct = l.limit ? Math.min(100, (l.used / l.limit) * 100) : 100;
    meter.firstElementChild.style.width = pct.toFixed(0) + '%';
    meter.className = 'meter' + (l.used >= l.limit ? ' low' : '');
  }
  $('stMining').textContent = s.mining ? 'Running' : 'Stopped';
  $('stMiningSub').textContent = s.area ? `${(s.areaVolume || 0).toLocaleString('en-US')} blocks in area` : 'No area saved';
  $('stVersion').textContent = s.version || 'auto';

  const full = !l.unlimited && l.used >= l.limit;
  for (const id of ['btnAddBot', 'btnAddBot2']) $(id).disabled = full;
  $('addBotHint').textContent = l.unlimited ? '' : (l.limit === 0 ? 'Your account may not connect Minecraft accounts yet. Ask an admin to raise your limit.' : `${l.used} of ${l.limit} accounts used`);

  const sig = JSON.stringify(s.bots.map((b) => [b.name, b.pos ? 1 : 0, Math.round(b.health || 0), b.status, b.owner]));
  if (!changed('overviewBots', sig)) return;
  const box = $('overviewBots');
  box.replaceChildren();
  if (!s.bots.length) { box.append(el('p', 'muted', 'No Minecraft accounts yet. Add your first one to get started.')); return; }
  for (const b of s.bots.slice(0, 6)) {
    const [label, cls] = statusOf(b);
    const row = el('div', 'kv');
    const left = el('span');
    left.append(el('b', '', botLabel(b)));
    row.append(left, el('span', 'chip ' + cls, label));
    box.append(row);
  }
  if (s.bots.length > 6) box.append(el('p', 'hint', `+ ${s.bots.length - 6} more`));
}

function renderMining(s) {
  if (!s.isAdmin) return;
  const run = $('runChip');
  run.textContent = s.mining ? 'running' : 'stopped';
  run.className = 'chip ' + (s.mining ? 'ok' : '');
  $('runHint').textContent = !s.area ? 'Save an area first.' : !s.bots.length ? 'Connect bots first.' : '';
  $('btnStartMining').disabled = s.mining || !s.bots.length || !s.area;
  $('areaInfo').textContent = s.area ? `${(s.areaVolume || 0).toLocaleString('en-US')} blocks saved` : '';
}

function renderProfile(s) {
  if (!s.me) return;
  $('pfName').textContent = s.me.username;
  $('pfRole').textContent = s.me.role === 'admin' ? 'Admin' : 'User';
  $('pfLimit').textContent = limitText(s);
}

function renderChatTargets(s) {
  const want = [['all', s.isAdmin ? 'All bots' : 'Select a bot…'], ...s.bots.map((b) => [b.name, botLabel(b)])];
  if (!changed('chatTargets', JSON.stringify(want))) return;
  const sel = $('chatTarget');
  const cur = sel.value;
  sel.replaceChildren();
  for (const [v, label] of want) { const o = el('option', '', label); o.value = v; sel.append(o); }
  sel.value = want.some(([v]) => v === cur) ? cur : want[s.isAdmin || want.length < 2 ? 0 : 1][0];
}

// ---------- bots tab

function renderBots(s) {
  const query = $('botSearch').value.trim().toLowerCase();
  const filter = $('botStatusFilter').value;
  const list = s.bots.filter((b) => {
    const on = !!b.pos;
    if (filter === 'online' && !on) return false;
    if (filter === 'offline' && on) return false;
    return !query || botLabel(b).toLowerCase().includes(query);
  });
  const sig = JSON.stringify([list.map(({ inventory, ...rest }) => rest), [...picked], s.isAdmin, s.bots.length]);
  if (!changed('bots', sig)) return;
  const box = $('bots');
  box.replaceChildren();
  if (!list.length) {
    const e = el('div', 'empty');
    e.style.gridColumn = '1/-1';
    e.append(el('b', '', s.bots.length ? 'No bots match these filters' : 'No Minecraft accounts yet'), el('span', '', s.bots.length ? 'Try a different search.' : 'Use “Add Microsoft account” to connect your own Minecraft account.'));
    box.append(e);
    return;
  }
  for (const b of list) box.append(botCard(b, s));
}

function vital(label, value, pct, cls) {
  const v = el('div', 'vital');
  v.append(el('span', '', label), el('b', '', value));
  if (pct !== undefined) {
    const m = el('div', 'meter' + (cls ? ' ' + cls : ''));
    const i = el('i'); i.style.width = Math.max(0, Math.min(100, pct)).toFixed(0) + '%';
    m.append(i); v.append(m);
  }
  return v;
}

function botCard(b, s) {
  const [label, cls] = statusOf(b);
  const card = el('div', 'bot' + (picked.has(b.name) ? ' sel' : ''));
  const top = el('div', 'bot-top');
  const check = el('input'); check.type = 'checkbox'; check.checked = picked.has(b.name); check.setAttribute('aria-label', 'Select ' + botLabel(b));
  check.onchange = () => { if (check.checked) picked.add(b.name); else picked.delete(b.name); sigs.bots = null; if (state) renderBots(state); };
  const avatar = el('div', 'avatar', botLabel(b).charAt(0).toUpperCase());
  const meta = el('div', 'meta');
  meta.append(el('b', '', botLabel(b)), el('span', '', b.pos ? (serverOf(b) || 'Connected') : (['connecting', 'reconnecting', 'error'].includes(b.status) && b.detail ? b.detail : 'Offline')));
  top.append(check, avatar, meta, el('span', 'chip ' + cls, label));
  card.append(top);
  if (s.isAdmin) { const o = el('div'); o.append(el('span', 'chip owner', b.owner ? 'Owner: ' + b.owner : 'No owner')); card.append(o); }

  const v = el('div', 'vitals');
  v.append(vital('Health', b.health != null ? `${Math.round(b.health)} / 20` : '-', b.health != null ? (b.health / 20) * 100 : undefined, b.health != null && b.health < 8 ? 'low' : 'good'));
  v.append(vital('Hunger', b.food != null ? `${b.food} / 20` : '-', b.food != null ? (b.food / 20) * 100 : undefined, b.food != null && b.food < 8 ? 'low' : ''));
  v.append(vital('Position', b.pos ? `${b.pos.x} ${b.pos.y} ${b.pos.z}` : '-'));
  v.append(vital('Task', ({ idle: 'None', mining: 'Mining', afk: 'AFK', fishing: 'Fishing', trading: 'Trading' })[b.profile] || humanize(b.profile) || 'None'));
  card.append(v);
  const extra = [];
  if (b.pickaxe) extra.push(`Pickaxe ${b.pickaxe.left ?? '?'}/${b.pickaxe.max ?? '?'}`);
  if (b.bottles != null && b.pos) extra.push(`${b.bottles} XP bottles`);
  if (b.freeSlots != null && b.pos) extra.push(`${b.freeSlots} free slots`);
  if (b.hasRegion) extra.push(`${b.mined || 0} mined`);
  if (b.profile === 'fishing') extra.push(`${b.fishCaught || 0} caught`);
  if (b.profile === 'trading') extra.push(`${b.trades || 0} trades`);
  if (b.sneak) extra.push('sneaking');
  if (extra.length) card.append(el('div', 'bot-detail', extra.join(' · ')));
  if (b.hasRegion && b.progress != null) { const m = el('div', 'meter'); const i = el('i'); i.style.width = (b.progress * 100).toFixed(0) + '%'; m.append(i); card.append(m); }

  const actions = el('div', 'bot-actions');
  const btn = (text, cls2, fn) => { const x = el('button', cls2 || 'ghost sm', text); x.type = 'button'; x.onclick = fn; actions.append(x); return x; };
  btn('Inventory', 'sm', () => { invBot = b.name; invSel.clear(); sigs.inv = null; goto('inventory'); if (state) renderInventory(state); }).disabled = false;
  const online = !!b.pos;
  btn('AFK', 'ghost sm', () => act('bot_profile', { name: b.name, profile: 'afk' }, `${botLabel(b)}: AFK started`)).disabled = !online;
  btn(b.profile === 'fishing' ? 'Fishing…' : 'Fish', 'ghost sm', () => {
    const options = { threshold: Math.max(1, Math.min(64, Number($('fishThreshold').value) || 20)), useMending: $('fishMending').checked, deposit: $('fishDeposit').checked };
    act('bot_profile', { name: b.name, profile: 'fishing', options }, `${botLabel(b)}: fishing started`);
  }).disabled = !online;
  btn('Trade', 'ghost sm', async () => {
    const r = await ask({
      title: 'Auto trading', text: 'Name the item you want to receive (e.g. emerald) or the offer number. Leave it empty to only list the villager’s offers.',
      fields: [{ key: 'target', label: 'Result item or offer number', placeholder: 'emerald' }, { key: 'count', label: 'Maximum number of trades (1–256)', type: 'number', value: 16, min: 1, max: 256 }], ok: 'Start',
    });
    if (!r) return;
    const target = r.target.trim();
    if (!target) return act('bot_profile', { name: b.name, profile: 'trading', options: {} }, `${botLabel(b)}: listing offers`);
    const count = Number(r.count);
    if (!Number.isInteger(count) || count < 1 || count > 256) return toast('The number of trades must be between 1 and 256', true);
    const options = { tradeCount: count };
    if (/^\d+$/.test(target)) options.tradeIndex = Number(target) - 1; else options.outputItem = target;
    act('bot_profile', { name: b.name, profile: 'trading', options }, `${botLabel(b)}: trading started`);
  }).disabled = !online;
  btn('Stop task', 'ghost sm', () => act('bot_profile', { name: b.name, profile: 'idle' }, `${botLabel(b)}: task stopped`)).disabled = !online;
  if (s.isAdmin) btn('⚙ Settings', 'ghost sm', () => openBotDialog(b));
  btn('Remove', 'danger sm', async () => {
    const r = await ask({ title: `Remove ${botLabel(b)}?`, text: 'The bot is disconnected and its saved Microsoft login is deleted. This frees the account slot; you can add the account again later.', ok: 'Remove', danger: true });
    if (r) { picked.delete(b.name); act('remove_bot', { name: b.name }, `${botLabel(b)} removed`); }
  });
  card.append(actions);
  return card;
}

// ---------- inventory tab

const slotKind = { 5: 'helmet', 6: 'chest', 7: 'legs', 8: 'boots', 45: 'shield' };
const slotName = { 5: 'Helmet', 6: 'Chestplate', 7: 'Leggings', 8: 'Boots', 45: 'Offhand' };

function renderInventory(s, force) {
  const pills = $('invPills');
  if (!s.bots.length) {
    if (changed('inv', 'none')) { pills.replaceChildren(); $('invBody').replaceChildren(); const e = el('div', 'empty'); e.append(el('b', '', 'No bots yet'), el('span', '', 'Add a Minecraft account to see its inventory.')); $('invBody').append(e); }
    return;
  }
  if (!invBot || !s.bots.some((b) => b.name === invBot)) { invBot = s.bots[0].name; invSel.clear(); }
  const bot = s.bots.find((b) => b.name === invBot);
  const items = bot.inventory || [];
  // forget selections whose slot changed
  for (const [slot, name] of [...invSel]) { const it = items.find((i) => i.slot === slot); if (!it || it.name !== name) invSel.delete(slot); }
  const sig = JSON.stringify([bot.name, !!bot.pos, items, [...invSel.keys()], s.bots.map((b) => b.name), bot.freeSlots]);
  if (!force && !changed('inv', sig)) return;
  sigs.inv = sig;

  pills.replaceChildren();
  for (const b of s.bots) {
    const p = el('button', 'pill', botLabel(b)); p.type = 'button';
    p.setAttribute('aria-pressed', String(b.name === invBot));
    p.onclick = () => { invBot = b.name; invSel.clear(); renderInventory(state, true); };
    pills.append(p);
  }
  const body = $('invBody');
  body.replaceChildren();
  const layout = el('div', 'inv-layout');
  const wrap = el('div', 'inv-wrap');
  const board = el('div', 'inv-board');
  const bySlot = new Map(items.map((i) => [i.slot, i]));

  const mk = (slot, hotbarNo) => {
    const it = bySlot.get(slot);
    if (!it) {
      const d = el('div', 'slot empty');
      if (slotKind[slot]) { d.title = slotName[slot]; d.innerHTML = `<span class="ico">${ICONS.svg(slotKind[slot])}</span>`; d.style.opacity = '.45'; }
      if (hotbarNo) d.classList.add('hot'), d.dataset.n = hotbarNo;
      return d;
    }
    const { kind, color } = ICONS.classify(it.name);
    const b = el('button', 'slot' + (it.enchanted || it.mending ? ' ench' : '') + (invSel.has(slot) ? ' picked' : ''));
    b.type = 'button';
    b.style.setProperty('--c', color);
    b.setAttribute('aria-label', `${it.displayName || humanize(it.name)} x${it.count}, slot ${slot}`);
    b.setAttribute('aria-pressed', String(invSel.has(slot)));
    if (hotbarNo) { b.classList.add('hot'); b.dataset.n = hotbarNo; }
    b.innerHTML = `<span class="ico">${ICONS.svg(kind)}</span>`;
    if (it.count > 1) b.append(el('span', 'cnt', String(it.count)));
    if (it.maxDurability) {
      const pct = Math.max(0, Math.min(100, ((Number(it.durabilityLeft) || 0) / it.maxDurability) * 100));
      const d = el('span', 'dur'); const i = el('i');
      i.style.width = pct + '%'; i.style.background = pct < 20 ? 'var(--danger)' : pct < 55 ? 'var(--warn)' : 'var(--ok)';
      d.append(i); b.append(d);
    }
    b.onclick = () => { if (invSel.has(slot)) invSel.delete(slot); else invSel.set(slot, it.name); renderInventory(state, true); };
    b.onmouseenter = (e) => showTip(it, e); b.onmousemove = moveTip; b.onmouseleave = hideTip; b.onfocus = () => showTip(it, null, b); b.onblur = hideTip;
    return b;
  };

  const top = el('div', 'inv-top');
  const equipWrap = el('div');
  equipWrap.append(el('div', 'inv-label', 'Equipment'));
  const equip = el('div', 'inv-equip');
  for (const sl of [5, 6, 7, 8, 45]) equip.append(mk(sl));
  equipWrap.append(equip);
  const mainWrap = el('div');
  mainWrap.append(el('div', 'inv-label', 'Backpack'));
  const main = el('div', 'inv-main');
  for (let sl = 9; sl <= 35; sl++) main.append(mk(sl));
  mainWrap.append(main);
  top.append(equipWrap, mainWrap);
  const hotWrap = el('div');
  hotWrap.append(el('div', 'inv-label', 'Hotbar'));
  const hot = el('div', 'inv-main');
  for (let sl = 36; sl <= 44; sl++) hot.append(mk(sl, sl - 35));
  hotWrap.append(hot);
  board.append(top, hotWrap);
  wrap.append(board);
  if (!bot.pos) wrap.append(el('p', 'hint', 'This bot is offline. Connect it to see and manage its inventory.'));
  else wrap.append(el('p', 'hint', `${items.length} item stack${items.length === 1 ? '' : 's'} · ${bot.freeSlots ?? '?'} free slots. Purple glow = enchanted. Hover an item for details.`));

  // side panel
  const side = el('div', 'panel');
  const sel = [...invSel.keys()].sort((a, b) => a - b).map((sl) => bySlot.get(sl)).filter(Boolean);
  side.append(el('div', 'eyebrow', 'Drop items'), el('h3', '', sel.length ? `${sel.length} selected` : 'Nothing selected'));
  const list = el('div', 'side-list'); list.style.margin = '12px 0';
  if (!sel.length) list.append(el('p', 'hint', 'Click items in the inventory to select them. Stacks can be dropped partially.'));
  for (const it of sel) {
    const { kind, color } = ICONS.classify(it.name);
    const row = el('div', 'sel-item'); row.style.setProperty('--c', color);
    const ico = el('span', 'ico'); ico.innerHTML = ICONS.svg(kind);
    row.append(ico, el('b', '', it.displayName || humanize(it.name)), el('span', '', '×' + it.count));
    list.append(row);
  }
  side.append(list);
  const dropSel = el('button', 'primary', sel.length ? `Drop selected (${sel.length})` : 'Drop selected'); dropSel.type = 'button';
  dropSel.disabled = !sel.length || !bot.pos;
  dropSel.onclick = () => dropSelected(bot, sel);
  const clear = el('button', 'ghost', 'Clear selection'); clear.type = 'button'; clear.disabled = !sel.length; clear.onclick = () => { invSel.clear(); renderInventory(state, true); };
  const all = el('button', 'ghost', 'Select all'); all.type = 'button'; all.disabled = !items.length;
  all.onclick = () => { for (const it of items) if (it.slot >= 9 && it.slot <= 44) invSel.set(it.slot, it.name); renderInventory(state, true); };
  const everything = el('button', 'danger', 'Drop everything'); everything.type = 'button'; everything.disabled = !items.length || !bot.pos;
  everything.onclick = () => dropEverything(bot, items);
  const row1 = el('div', 'toolbar'); row1.append(dropSel, clear, all);
  const row2 = el('div', 'toolbar'); row2.style.marginTop = '14px'; row2.append(everything);
  side.append(row1, row2);

  layout.append(wrap, side);
  body.append(layout);
}

async function dropSelected(bot, sel) {
  const multi = sel.filter((it) => it.count > 1);
  let counts = new Map(sel.map((it) => [it.slot, it.count]));
  if (multi.length) {
    const r = await ask({
      title: 'How many should be dropped?', text: 'Enter the amount for each stack. The default is the whole stack.',
      fields: multi.map((it) => ({ key: String(it.slot), label: `${it.displayName || humanize(it.name)} (stack of ${it.count})`, type: 'number', value: it.count, min: 1, max: it.count })),
      ok: 'Drop',
    });
    if (!r) return;
    for (const it of multi) {
      const n = Number(r[String(it.slot)]);
      if (!Number.isInteger(n) || n < 1 || n > it.count) return toast(`${it.displayName || humanize(it.name)}: enter a whole number between 1 and ${it.count}`, true);
      counts.set(it.slot, n);
    }
  }
  const items = sel.map((it) => ({ slot: it.slot, name: it.name, count: counts.get(it.slot) }));
  const res = await call('drop_items', { name: bot.name, items }, 'Items dropped');
  if (res.ok) { invSel.clear(); if (state) renderInventory(state, true); }
}

async function dropEverything(bot, items) {
  const hasEquipped = items.some((i) => i.slot < 9 || i.slot === 45);
  const fields = hasEquipped ? [{ key: 'equipped', type: 'checkbox', label: 'Also drop worn armor and the offhand item', value: false }] : [];
  const r = await ask({ title: `Drop everything from ${botLabel(bot)}?`, text: `All ${items.length} stack${items.length === 1 ? '' : 's'} will be thrown on the ground. This cannot be undone.`, fields, ok: 'Drop everything', danger: true });
  if (!r) return;
  const res = await call('drop_all', { name: bot.name, includeEquipped: !!r.equipped }, 'Dropped everything');
  if (res.ok) { invSel.clear(); if (state) renderInventory(state, true); }
}

// tooltip
let tip = null;
function showTip(it, ev, anchor) {
  hideTip();
  tip = el('div', 'slot-tip' + (it.enchanted || it.mending ? ' ench' : ''));
  tip.append(el('b', '', it.displayName || humanize(it.name)));
  tip.append(el('span', '', `${it.count} / ${it.stackSize || 64} · slot ${it.slot}`));
  if (it.maxDurability) tip.append(el('span', '', `Durability ${it.durabilityLeft ?? '?'} / ${it.maxDurability}`));
  if (it.mending) tip.append(el('span', '', 'Mending'));
  else if (it.enchanted) tip.append(el('span', '', 'Enchanted'));
  tip.append(el('span', 'hint', it.name));
  document.body.append(tip);
  if (ev) moveTip(ev); else if (anchor) { const r = anchor.getBoundingClientRect(); tip.style.left = r.right + 8 + 'px'; tip.style.top = r.top + 'px'; }
}
function moveTip(e) {
  if (!tip) return;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, e.clientX + 14) + 'px';
  tip.style.top = Math.min(window.innerHeight - h - 8, e.clientY + 14) + 'px';
}
function hideTip() { if (tip) { tip.remove(); tip = null; } }

// ---------- Microsoft sign-in dialog

function renderMsa(s) {
  const pending = (s.pendingSignIns || []).map((p) => ({ ...p, msa: p.msa || { code: '', url: 'https://www.microsoft.com/link', pending: true } }));
  const sig = pending.map((p) => `${p.name}:${p.msa.code || (p.msa.pending ? 'pending' : '')}`).join('|');
  if (sig !== lastMsaSig) { msaDismissed = false; lastMsaSig = sig; }
  const dlg = $('msaDialog');
  if (!pending.length || msaDismissed) { if (dlg.open) dlg.close(); return; }
  if (!dlg.open) dlg.showModal();
  if (!changed('msa', sig)) return;
  const list = $('msaList');
  list.replaceChildren();
  for (const p of pending) {
    const row = el('div', 'msa-item');
    if (p.msa.code) {
      const code = el('div', 'msa-code', p.msa.code);
      const copy = el('button', 'ghost', 'Copy code'); copy.type = 'button';
      copy.onclick = async () => {
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(p.msa.code);
          else { const t = document.createElement('textarea'); t.value = p.msa.code; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove(); if (!ok) throw new Error('copy failed'); }
          toast('Sign-in code copied');
        } catch { toast('Copy failed. Please select the code and copy it manually.', true); }
      };
      const open = el('a', 'primary-link', 'Open Microsoft sign-in');
      open.className = 'chip plain'; open.style.cursor = 'pointer';
      try { const u = new URL(p.msa.url || 'https://www.microsoft.com/link'); if (u.protocol === 'https:') { open.href = u.href; open.target = '_blank'; open.rel = 'noopener noreferrer'; } } catch { /* invalid link */ }
      const r2 = el('div', 'toolbar'); r2.append(copy, open);
      row.append(code, r2);
    } else {
      row.append(el('p', 'muted', p.detail || 'Requesting a sign-in code from Microsoft…'));
    }
    const cancel = el('button', 'danger sm', 'Cancel this sign-in'); cancel.type = 'button';
    cancel.onclick = () => act('cancel_signin', { name: p.name }, 'Sign-in cancelled');
    const r3 = el('div', 'toolbar'); r3.append(cancel);
    row.append(r3);
    list.append(row);
  }
}
$('closeMsaModal').onclick = () => { msaDismissed = true; $('msaDialog').close(); };
$('msaDialog').addEventListener('cancel', () => { msaDismissed = true; });

// ------------------------------------------------------------ activity log

const logBox = $('log');
const sourceLabel = (src) => { const b = state && (state.bots || []).find((x) => x.name === src); return b ? botLabel(b) : src; };
function applyLogFilter(node) {
  const q = $('logSearch').value.trim().toLowerCase();
  const problems = $('logLevel').value === 'problems';
  node.hidden = (problems && node.dataset.level === 'info') || (!!q && !node.dataset.text.includes(q));
}
function addLog(e) {
  const stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
  const level = e.level === 'warn' || e.level === 'error' ? e.level : 'info';
  const d = el('div', level === 'info' ? '' : level);
  const label = sourceLabel(e.source);
  d.dataset.level = level;
  d.dataset.text = `${label} ${e.text}`.toLowerCase();
  d.append(el('span', 't', new Date(e.t).toLocaleTimeString('en-GB') + ' '), el('span', 'src', `[${label}] `), document.createTextNode(e.text));
  applyLogFilter(d);
  logBox.append(d);
  while (logBox.childElementCount > 500) logBox.firstElementChild.remove();
  if (stick) logBox.scrollTop = logBox.scrollHeight;
}
for (const id of ['logSearch', 'logLevel']) $(id).addEventListener('input', () => { for (const n of logBox.children) applyLogFilter(n); });
$('clearLog').addEventListener('click', () => act('clear_logs', {}, 'Activity log cleared'));

// ------------------------------------------------------------ bot settings dialog

let settingsBot = null;
function openBotDialog(bot) {
  settingsBot = bot.name;
  const d = bot.death || {};
  const r = bot.reconnect || {};
  $('botTitle').textContent = `Bot settings · ${botLabel(bot)}`;
  $('botSneak').checked = !!bot.sneak;
  $('rcOn').checked = !!r.commandEnabled;
  $('rcCmd').value = r.command || '';
  $('rcDelay').value = r.delaySec ?? 5;
  $('rcRunOn').value = r.runOn || 'reconnect';
  $('deathCmdOn').checked = !!d.commandEnabled;
  $('deathCmd').value = d.command || '';
  $('deathDelay').value = d.delaySec ?? 3;
  $('deathHookOn').checked = !!d.webhookEnabled;
  $('deathHook').value = '';
  $('deathHookClear').checked = false;
  $('deathHookHint').textContent = d.hasWebhook
    ? `Saved webhook: ${d.webhookHint}. Leave empty to keep it, or enter a new URL to replace it.`
    : 'No webhook saved yet. The URL is stored on the server and never shown again.';
  $('deathTest').disabled = !d.hasWebhook;
  $('botDialog').showModal();
}
$('botSneak').addEventListener('change', () => { if (settingsBot) act('set_bot_sneak', { name: settingsBot, sneak: $('botSneak').checked }, $('botSneak').checked ? 'Sneak on' : 'Sneak off'); });
$('botClose').addEventListener('click', () => $('botDialog').close());
$('botForm').addEventListener('submit', (e) => { e.preventDefault(); $('botSave').click(); });
$('botSave').addEventListener('click', async () => {
  if (!settingsBot) return;
  const rcDelay = Number($('rcDelay').value);
  const dDelay = Number($('deathDelay').value);
  for (const [v, what] of [[rcDelay, 'Join command wait time'], [dDelay, 'Death command wait time']]) {
    if (!Number.isInteger(v) || v < 0 || v > 120) return toast(`${what} must be a whole number between 0 and 120 seconds`, true);
  }
  const reconnect = { commandEnabled: $('rcOn').checked, command: $('rcCmd').value.trim(), delaySec: rcDelay, runOn: $('rcRunOn').value };
  const death = { commandEnabled: $('deathCmdOn').checked, command: $('deathCmd').value.trim(), delaySec: dDelay, webhookEnabled: $('deathHookOn').checked, clearWebhook: $('deathHookClear').checked };
  const url = $('deathHook').value.trim();
  if (url) death.webhookUrl = url;
  const a = await call('set_bot_reconnect', { name: settingsBot, reconnect });
  if (!a.ok) return;
  const b = await call('set_bot_death', { name: settingsBot, death });
  if (!b.ok) return;
  toast('Bot settings saved');
  $('botDialog').close();
});
$('deathTest').addEventListener('click', () => { if (settingsBot) act('test_death_webhook', { name: settingsBot }, 'Test webhook sent'); });

// ------------------------------------------------------------ view as (admin)

window.addEventListener('dashboard:view-as', async (event) => {
  const userId = event.detail && event.detail.userId;
  if (userId) await call('view_as', { userId });
});
$('exitViewAs').addEventListener('click', () => act('exit_view_as', {}, 'Admin view restored'));
socket.on('view_as_changed', ({ active, username }) => {
  $('viewAsBar').hidden = !active;
  $('viewAsName').textContent = username || '';
  invBot = null; invSel.clear(); picked.clear();
  for (const k of Object.keys(sigs)) sigs[k] = null;
  window.dispatchEvent(new CustomEvent('dashboard:view-as-changed', { detail: { active: !!active } }));
});

// ------------------------------------------------------------ socket

socket.on('init', ({ state: s, logs }) => {
  render(s);
  logBox.replaceChildren();
  logs.forEach(addLog);
  logBox.scrollTop = logBox.scrollHeight;
  showTab(location.hash.slice(1) || 'overview');
});
socket.on('state', render);
socket.on('log', addLog);
socket.on('logs_cleared', () => logBox.replaceChildren());
socket.on('connect_error', (e) => {
  if (e && e.message === 'unauthorized') location.href = '/login';
  else if (e && (e.message === 'expired' || e.message === 'discord_required')) location.href = '/gate.html';
  else toast('Connection to the dashboard interrupted', true);
});
socket.on('disconnect', (reason) => {
  // The server closes the socket of accounts that expired, were deleted or lost their Discord link.
  if (reason === 'io server disconnect') { setTimeout(() => { location.reload(); }, 800); return; }
  toast('Disconnected from the dashboard. Reconnecting…', true);
});

// ------------------------------------------------------------ buttons

const rerender = () => { for (const k of ['bots', 'overviewBots']) sigs[k] = null; if (state) { renderBots(state); renderOverview(state); } };
$('btnStop').onclick = () => act('stop', {}, 'All tasks stopped');
$('btnStartMining').onclick = () => act('start', {}, 'Mining started');
$('btnVersion').onclick = () => act('set_version', { version: $('mcVersion').value }, 'Minecraft version saved');
for (const id of ['btnAddBot', 'btnAddBot2']) $(id).onclick = () => act('add_bot', {}, 'Starting Microsoft sign-in…');

$('btnConnect').onclick = () => {
  const names = [...picked].filter((n) => state && state.bots.some((b) => b.name === n));
  if (!names.length) return toast('Tick at least one bot first.', true);
  if (!$('host').value.trim()) return toast('Enter a server address first.', true);
  act('connect_selected', { host: $('host').value, names }, 'Connecting selected bots…');
};
$('btnDisconnect').onclick = async () => {
  const names = [...picked].filter((n) => state && state.bots.some((b) => b.name === n));
  if (!names.length) return toast('Tick at least one bot first.', true);
  const r = await ask({ title: 'Disconnect selected bots?', text: `${names.length} bot${names.length === 1 ? '' : 's'} will leave the server.`, ok: 'Disconnect', danger: true });
  if (r) act('disconnect_selected', { names }, 'Selected bots disconnected');
};
$('botSearch').addEventListener('input', rerender);
$('botStatusFilter').addEventListener('change', rerender);
$('selectAllBots').onclick = () => { if (state) state.bots.forEach((b) => picked.add(b.name)); rerender(); };
$('deselectAllBots').onclick = () => { picked.clear(); rerender(); };

$('btnArea').onclick = () => {
  const p1 = { x: num('x1'), y: num('y1'), z: num('z1') };
  const p2 = { x: num('x2'), y: num('y2'), z: num('z2') };
  if ([...Object.values(p1), ...Object.values(p2)].some(Number.isNaN)) return toast('Please fill in all six coordinates', true);
  act('set_area', { p1, p2 }, 'Area saved');
};
$('btnSettings').onclick = () => {
  const c = ['cx', 'cy', 'cz'].map(num);
  const any = c.some((v) => !Number.isNaN(v));
  const all = c.every((v) => !Number.isNaN(v));
  if (any && !all) return toast('Storage chest: fill in X, Y and Z or leave all three empty', true);
  act('set_settings', {
    durabilityThreshold: num('sThreshold'),
    throwDelayMs: num('sDelay'),
    minFreeSlots: num('sFree'),
    fishingThreshold: num('fishThreshold'),
    fishingUseMending: $('fishMending').checked,
    fishingDeposit: $('fishDeposit').checked,
    dropItems: $('dropItems').value.split(',').map((x) => x.trim().toLowerCase().replace(/^minecraft:/, '')).filter(Boolean),
    avoidLiquid: $('sLiquid').checked,
    allowDigOutside: $('sOutside').checked,
    excludedBlocks: $('sExcluded').value.split(',').map((x) => x.trim()).filter(Boolean),
    chest: all ? { x: c[0], y: c[1], z: c[2] } : null,
  }, 'Settings saved');
};
$('btnAutoEat').onclick = () => {
  const threshold = num('autoEatThreshold');
  if (Number.isNaN(threshold)) return toast('Please enter a hunger threshold between 1 and 20', true);
  act('set_settings', { autoEat: $('autoEat').checked, autoEatThreshold: threshold }, 'Auto Eat saved');
};

function sendChat() {
  const text = $('chatText').value;
  if (!text.trim()) return;
  const target = $('chatTarget').value;
  if (target === 'all' && state && !state.isAdmin) return toast('Select a bot first.', true);
  act('chat', { target, text }, 'Sent');
  $('chatText').value = '';
}
$('btnChat').onclick = sendChat;
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

// Copies text to the clipboard (also works on plain http, where navigator.clipboard is unavailable).
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove(); if (!ok) throw new Error('copy failed'); }
    toast('Copied');
  } catch { toast('Copy failed. Please select the text and copy it manually.', true); }
}
