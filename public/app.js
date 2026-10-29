'use strict';
const $ = (id) => document.getElementById(id);
const socket = io();
let state = null;
let formsFilled = false;
let msaModalDismissed = false;
let lastMsaSignature = '';
// Fallback for device codes that arrive in the Activity Log before the state snapshot.
const msaFromLogs = new Map();
const selectedConnectBots = new Set();
const inventoryShown = new Set();
let lastScroll = { x: 0, y: 0 };
const ITEM_ICONS = { fishing_rod: '🎣', experience_bottle: '🧪', diamond: '💎', emerald: '🟩', iron_ingot: '🔩', gold_ingot: '🪙', coal: '⚫', cooked_cod: '🐟', cod: '🐟', salmon: '🐠', enchanted_book: '📘', bow: '🏹', arrow: '➶', chest: '📦', barrel: '🛢️', bread: '🍞', apple: '🍎', pickaxe: '⛏️' };
const itemIcon = (name) => ITEM_ICONS[name] || (name.includes('pickaxe') ? '⛏️' : name.includes('sword') ? '⚔️' : name.includes('fish') ? '🐟' : name.includes('ore') ? '🪨' : name.includes('log') ? '🪵' : name.includes('planks') ? '🪵' : name.includes('armor') || name.includes('helmet') ? '🛡️' : name.includes('potion') ? '🧪' : name.includes('wool') ? '🧶' : '📦');

// ------------------------------------------------------------ Hilfen

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
}

function act(type, payload, okMsg) {
  socket.emit('action', type, payload, (res) => {
    if (!res || !res.ok) toast((res && res.error) || 'Error', true);
    else if (okMsg) toast(okMsg);
  });
}

window.addEventListener('dashboard:view-as', (event) => {
  const userId = event.detail && event.detail.userId;
  if (!userId) return;
  socket.emit('action','view_as',{userId},(res)=>{
    if (!res || !res.ok) toast((res && res.error)||'Could not switch account view',true);
    else { toast('Viewing account: '+(event.detail.username||'user')); const p=$('accountPanel'); if(p) p.dataset.viewAs='true'; }
  });
});
window.addEventListener('dashboard:exit-view-as', () => {
  socket.emit('action','exit_view_as',{},(res)=>{
    if (!res || !res.ok) toast((res && res.error)||'Could not exit account view',true);
    else { toast('Admin view restored'); const p=$('accountPanel'); if(p) delete p.dataset.viewAs; }
  });
});

const num = (id) => {
  const v = $(id).value.trim();
  return v === '' ? NaN : Number(v);
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const STATUS = {
  fishing: ['fishing', 'ok'], trading: ['trading', 'warn'], offline: ['disconnected', ''], connecting: ['connecting', 'warn'], reconnecting: ['reconnecting', 'warn'],
  idle: ['ready', 'ok'], mining: ['mining', 'ok'], repairing: ['repairing', 'warn'],
  depositing: ['Chest', 'warn'], done: ['done', 'ok'], error: ['Error', 'err'],
};

// ------------------------------------------------------------ Formulare befuellen (einmalig)

function fillForms(s) {
  $('host').value = s.connection.host ? s.connection.host + (s.connection.port ? ':' + s.connection.port : '') : '';
  $('names').value = (s.names || []).join('\n');
  $('version').textContent = s.version || 'auto';
  if ($('mcVersion')) $('mcVersion').value = s.version || 'auto';
  if (s.area) {
    $('x1').value = s.area.p1.x; $('y1').value = s.area.p1.y; $('z1').value = s.area.p1.z;
    $('x2').value = s.area.p2.x; $('y2').value = s.area.p2.y; $('z2').value = s.area.p2.z;
  }
  $('sThreshold').value = s.settings.durabilityThreshold;
  $('sDelay').value = s.settings.throwDelayMs;
  $('sFree').value = s.settings.minFreeSlots;
  if ($('fishThreshold')) $('fishThreshold').value = s.settings.fishingThreshold ?? 20;
  if ($('fishMending')) $('fishMending').checked = s.settings.fishingUseMending !== false;
  if ($('fishDeposit')) $('fishDeposit').checked = s.settings.fishingDeposit !== false;
  $('sLiquid').checked = s.settings.avoidLiquid;
  $('sOutside').checked = !!s.settings.allowDigOutside;
  $('sExcluded').value = (s.settings.excludedBlocks || []).join(', ');
  if (s.settings.chest) { $('cx').value = s.settings.chest.x; $('cy').value = s.settings.chest.y; $('cz').value = s.settings.chest.z; }
  if ($('autoEat')) $('autoEat').checked = s.settings.autoEat !== false;
  if ($('autoEatThreshold')) $('autoEatThreshold').value = s.settings.autoEatThreshold ?? 14;
  if ($('dropItems')) $('dropItems').value = (s.settings.dropItems || []).join(', ');
  formsFilled = true;
}

// ------------------------------------------------------------ Rendern

function render(s) {
  const scrollBefore = { x: window.scrollX, y: window.scrollY };
  const activeId = document.activeElement && document.activeElement.id;
  const selection = activeId && document.activeElement && typeof document.activeElement.selectionStart === 'number' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  state = s;
  if (!formsFilled) fillForms(s);

  const online = s.bots.filter((b) => b.pos).length;
  const c = $('conn');
  c.textContent = s.bots.length ? `${online}/${s.bots.length} online` : 'disconnected';
  c.className = 'chip ' + (online ? 'ok' : 'off');

  const run = $('runChip');
  run.textContent = s.mining ? 'running' : 'stopped';
  run.className = 'chip ' + (s.mining ? 'ok' : 'off');
  $('runHint').textContent = !s.area ? 'Save an area first.' : !s.bots.length ? 'Connect bots first.' : '';
  if ($('btnStartMining')) $('btnStartMining').disabled = s.mining || !s.bots.length || !s.area;
  $('areaInfo').textContent = s.area ? `${s.areaVolume.toLocaleString('de-DE')} blocks saved` : '';

  // Microsoft-Codes. The Activity Log is also a fallback source in case a state
  // snapshot arrives without the msa field (for example during a reconnect).
  const msaByName = new Map();
  for (const b of s.bots) {
    const logged = msaFromLogs.get(b.name);
    if (b.msa) msaByName.set(b.name, b);
    else if (logged) msaByName.set(b.name, { ...b, msa: logged });
    else if (b.authMethod === 'microsoft' && !b.accountName && (
      b.status === 'connecting' ||
      b.status === 'error'
    )) {
      // Show the sign-in panel immediately, even while prismarine-auth is still
      // waiting for Microsoft's device-code response.
      msaByName.set(b.name, {
        ...b,
        msa: { code: '', url: 'https://www.microsoft.com/link', pending: true },
      });
    }
  }
  // A log event can arrive just before the matching bot appears in a state snapshot.
  // Render the real device code from that event anyway instead of hiding the sign-in panel.
  for (const [name, logged] of msaFromLogs) {
    if (!msaByName.has(name)) msaByName.set(name, { name, accountName: name, msa: logged });
  }
  const msa = [...msaByName.values()];
  const msaSignature = msa.map((b) => `${b.name}:${b.msa.code || (b.msa.pending ? 'pending' : '')}`).join('|');
  if (msaSignature !== lastMsaSignature) { msaModalDismissed = false; lastMsaSignature = msaSignature; }
  $('msaCard').hidden = !msa.length || msaModalDismissed;
  const list = $('msaList');
  list.replaceChildren();
  for (const b of msa) {
    const row = el('div', 'msa');
    row.append(el('b', '', b.accountName || 'Microsoft account'));
    if (b.msa.code) {
      row.append(el('code', '', b.msa.code));
      const copy = el('button', 'ghost copy-code', '⧉');
      copy.type = 'button';
      copy.title = 'Copy sign-in code';
      copy.setAttribute('aria-label', 'Copy sign-in code');
      copy.onclick = async () => {
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(b.msa.code);
          } else {
            const input = document.createElement('textarea');
            input.value = b.msa.code;
            input.setAttribute('readonly', '');
            input.style.position = 'fixed';
            input.style.opacity = '0';
            document.body.append(input);
            input.select();
            const copied = document.execCommand('copy');
            input.remove();
            if (!copied) throw new Error('copy failed');
          }
          toast('Sign-in code copied');
        } catch {
          toast('Copy failed. Please select the code and copy it manually.', true);
        }
      };
      row.append(copy);
    } else {
      row.append(el('span', 'muted', b.detail || 'Microsoft-Gerätecode wird angefordert …'));
    }
    const a = el('a', 'primary msa-open', 'Open Microsoft sign-in');
    try {
      const u = new URL(b.msa.url || 'https://www.microsoft.com/link');
      if (u.protocol === 'https:') { a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    } catch { /* invalid link */ }
    row.append(a);
    list.append(row);
  }

  // Ziel-Auswahl fuer Befehle
  const sel = $('chatTarget');
  const want = ['all', ...s.bots.map((b) => b.name)];
  if (sel.options.length !== want.length || [...sel.options].some((o, i) => o.value !== want[i])) {
    const cur = sel.value;
    sel.replaceChildren();
    for (const v of want) { const o = el('option', '', v === 'all' ? 'All bots' : v); o.value = v; sel.append(o); }
    sel.value = want.includes(cur) ? cur : 'all';
  }

  // Searchable multi-select for server connection
  const choices = $('connectBotChoices');
  if (choices) {
    const search = ($('connectBotSearch')?.value || '').trim().toLowerCase();
    choices.replaceChildren();
    const bots = s.bots.filter((b) => !search || String(b.accountName || 'Minecraft profile pending').toLowerCase().includes(search) || b.name.toLowerCase().includes(search));
    if (!bots.length) choices.append(el('p', 'muted', s.bots.length ? 'No bots match your search.' : 'No saved bot accounts yet.'));
    for (const b of bots) {
      const label = el('label', 'connect-bot-choice');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedConnectBots.has(b.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedConnectBots.add(b.name);
        else selectedConnectBots.delete(b.name);
      });
      const info = el('span', 'connect-bot-info');
      info.append(el('b', '', b.accountName || 'Minecraft profile pending'), el('small', '', b.pos ? 'Connected to server' : (b.status === 'error' ? (b.detail || 'Authentication error') : (b.detail || b.status))));
      label.append(checkbox, info);
      choices.append(label);
    }
  }

  // Bot-Karten
  const box = $('bots');
  box.replaceChildren();
  if (!s.bots.length) { box.append(el('p', 'muted', 'No bots connected yet.')); return; }
  for (const b of s.bots) {
    const [label, cls] = STATUS[b.status] || [b.status, ''];
    const card = el('div', 'bot');
    const top = el('div', 'top');
    top.append(el('span', 'name', b.accountName || 'Minecraft profile pending'), el('span', 'chip ' + cls, label));
    card.append(top);
    const account = el('div', 'detail', b.accountName ? `Minecraft player: ${b.accountName}` : 'Minecraft player: profile not available yet');
    card.append(account, el('div', 'detail', b.detail || ' '));
    const noteKey = 'bot-note:' + b.name;
    const note = el('div', 'detail bot-note');
    const savedNote = (() => { try { return localStorage.getItem(noteKey) || ''; } catch { return ''; } })();
    note.textContent = savedNote ? 'My note: ' + savedNote : 'My note: none';
    const noteBtn = el('button', 'ghost', 'Edit my note');
    noteBtn.type = 'button';
    noteBtn.onclick = () => {
      const value = prompt('Private note for this bot (saved only in this browser)', (() => { try { return localStorage.getItem(noteKey) || ''; } catch { return ''; } })());
      if (value === null) return;
      try { if (value.trim()) localStorage.setItem(noteKey, value.trim().slice(0, 300)); else localStorage.removeItem(noteKey); } catch { toast('Could not save note in this browser', true); return; }
      render(state);
    };
    card.append(note, noteBtn);

    const kv = (k, v) => { const r = el('div', 'kv'); r.append(el('span', '', k), el('b', '', v)); return r; };
    card.append(kv('Position', b.pos ? `${b.pos.x} ${b.pos.y} ${b.pos.z}` : '-'));
    card.append(kv('Health / hunger', b.health != null ? `${Math.round(b.health)} / ${b.food}` : '-'));
    card.append(kv('Pickaxe', b.pickaxe ? `${b.pickaxe.left ?? '?'} / ${b.pickaxe.max ?? '?'}` : (b.pos ? 'keine' : '-')));
    if (b.pickaxe && b.pickaxe.max) {
      const frac = Math.max(0, Math.min(1, b.pickaxe.left / b.pickaxe.max));
      const bar = el('div', 'bar' + (b.pickaxe.left < (state.settings.durabilityThreshold) ? ' low' : ''));
      const fill = el('i'); fill.style.width = (frac * 100).toFixed(0) + '%';
      bar.append(fill); card.append(bar);
    }
    card.append(kv('XP bottles', b.bottles != null ? String(b.bottles) : '-'));
    card.append(kv('Free slots', b.freeSlots != null ? String(b.freeSlots) : '-'));
    card.append(kv('Mined', String(b.mined)));
    if (b.fishCaught != null) card.append(kv('Caught', String(b.fishCaught)));
    if (b.trades != null) card.append(kv('Trades', String(b.trades))); 
    card.append(kv('Task', ({ idle: 'None', mining: 'Mining', afk: 'AFK/Präsenz', fishing: 'Angeln', trading: 'Trading' })[b.profile] || b.profile || 'None'));
    const actions = el('div', 'row wrap');
    const addTask = (label, profile, cls) => {
      const btn = el('button', cls || 'ghost', label);
      btn.onclick = () => act('bot_profile', { name: b.name, profile }, `${b.name}: ${label}`);
      actions.append(btn);
    };
    addTask('AFK', 'afk');
    const fishBtn = el('button', 'ghost', b.profile === 'fishing' ? 'Angeln läuft' : '🎣 Angeln');
    fishBtn.onclick = () => {
      const options = { threshold: Math.max(1, Math.min(64, Number($('fishThreshold').value) || 20)), useMending: $('fishMending').checked, deposit: $('fishDeposit').checked };
      act('bot_profile', { name: b.name, profile: 'fishing', options }, `${b.name}: Angel-Automatik gestartet`);
    };
    actions.append(fishBtn);
    const trade = el('button', 'ghost', 'Trading');
    trade.onclick = () => {
      const target = prompt('Automatischer Trading: Ergebnis-Itemname (z. B. emerald) ODER Angebotsnummer. Leer lassen, um nur Angebote anzuzeigen.');
      if (target === null) return;
      if (!target.trim()) { act('bot_profile', { name: b.name, profile: 'trading', options: {} }, `${b.name}: Tradingsangebote anzeigen`); return; }
      const countRaw = prompt('Maximum number of trades (1–256). The bot stops earlier if the offer sells out or materials are missing.', '16');
      if (countRaw === null) return;
      const count = Number(countRaw);
      if (!Number.isInteger(count) || count < 1 || count > 256) return toast('Amount must be between 1 and 256', true);
      const options = { tradeCount: count };
      if (/^\d+$/.test(target.trim())) options.tradeIndex = Number(target.trim()) - 1;
      else options.outputItem = target.trim();
      act('bot_profile', { name: b.name, profile: 'trading', options }, `${b.name}: automatischer Trading gestartet`);
    };
    actions.append(trade); addTask('Task stoppen', 'idle', 'danger-ghost');
    const remove = el('button', 'danger-ghost', 'Remove bot');
    remove.onclick = () => { if (confirm(`Bot ${b.name} entfernen?`)) act('remove_bot', { name: b.name }, `${b.name} entfernt`); };
    actions.append(remove);
    const invBtn = el('button', 'ghost', inventoryShown.has(b.name) ? 'Hide inventory' : '▦ View inventory');
    invBtn.onclick = () => { if (inventoryShown.has(b.name)) inventoryShown.delete(b.name); else inventoryShown.add(b.name); render(state); };
    actions.append(invBtn);
    card.append(actions);
    if (inventoryShown.has(b.name)) {
      const inv = el('div', 'inventory-list');
      const inventory = b.inventory || [];
      const title = el('div', 'inventory-title');
      title.append(el('b', '', `Inventar · ${inventory.length} belegte Slots`), el('span', 'hint', b.pos ? `${b.freeSlots ?? '?'} freie Slots` : 'offline'));
      inv.append(title);
      if (!inventory.length) inv.append(el('p', 'muted small', b.pos ? 'None Items im Inventar gemeldet.' : 'Bot ist nicht verbunden'));
      for (const item of inventory) {
        const tile = el('div', 'inventory-item');
        tile.title = `${item.name} · Slot ${item.slot}`;
        tile.append(el('span', 'item-icon', itemIcon(item.name)), el('span', 'item-count', String(item.count)), el('span', 'item-name', item.name.replaceAll('_', ' ')));
        if (item.maxDurability) {
          const dur = el('div', 'item-durability'); const fill = el('i');
          const left = Number(item.durabilityLeft) || 0; const pct = Math.max(0, Math.min(100, left / item.maxDurability * 100));
          fill.style.width = `${pct}%`; if (pct < 20) fill.style.background = 'var(--danger)'; dur.append(fill); tile.append(dur);
          tile.append(el('span', 'item-meta', `${left}/${item.maxDurability}${item.mending ? ' · Mending' : ''}`));
        } else tile.append(el('span', 'item-meta', `Slot ${item.slot}`));
        inv.append(tile);
      }
      card.append(inv);
    }
    if (b.hasRegion && b.progress != null) {
      card.append(kv('Fortschritt', Math.round(b.progress * 100) + ' %'));
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (b.progress * 100).toFixed(0) + '%';
      bar.append(fill); card.append(bar);
    }
    box.append(card);
  }
  requestAnimationFrame(() => {
    if (Math.abs(window.scrollY - scrollBefore.y) > 2 || Math.abs(window.scrollX - scrollBefore.x) > 2) window.scrollTo({ left: scrollBefore.x, top: scrollBefore.y, behavior: 'instant' });
    if (activeId) {
      const active = $(activeId);
      if (active && document.activeElement !== active) { active.focus({ preventScroll: true }); if (selection && typeof active.setSelectionRange === 'function') { try { active.setSelectionRange(selection[0], selection[1]); } catch {} } }
    }
  });
}

// ------------------------------------------------------------ Log

const logBox = $('log');
$('clearLog')?.addEventListener('click', () => { logBox.replaceChildren(); toast('Activity log cleared'); });
function addLog(e) {
  const logText = String(e.text || '');
  const oldCodeMatch = logText.match(/Microsoft-Login:\s*Code\s+(\S+)\s+auf\s+(\S+)/i);
  const callbackCodeMatch = logText.match(/Microsoft device code received:\s*(\S+);\s*sign in at\s*(\S+)/i);
  const codeMatch = oldCodeMatch || callbackCodeMatch;
  if (codeMatch && e.source) {
    const code = oldCodeMatch ? codeMatch[1] : codeMatch[1];
    const rawUrl = oldCodeMatch ? codeMatch[2] : codeMatch[2];
    msaFromLogs.set(e.source, { code, url: /^https:\/\//i.test(rawUrl) ? rawUrl : 'https://www.microsoft.com/link' });
    if (state) render(state);
  }
  const stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
  const d = el('div', e.level === 'warn' || e.level === 'error' ? e.level : '');
  d.append(el('span', 't', new Date(e.t).toLocaleTimeString('de-DE') + ' '), el('span', 'src', `[${e.source}] `), document.createTextNode(e.text));
  logBox.append(d);
  while (logBox.childElementCount > 400) logBox.firstElementChild.remove();
  if (stick) logBox.scrollTop = logBox.scrollHeight;
}

// ------------------------------------------------------------ Socket

socket.on('view_as_changed', ({active}) => { const p=$('accountPanel'); if(!p)return; p.hidden=false; const create=$('createAccount'), list=$('accountList'), search=$('accountSearch'), refresh=$('refreshAccounts'), exit=$('exitViewAs'); if(create)create.hidden=!!active; if(list)list.hidden=!!active; if(search&&search.parentElement)search.parentElement.hidden=!!active; if(refresh)refresh.hidden=!!active; if(exit)exit.hidden=!active; });
socket.on('init', ({ state: s, logs }) => {
  formsFilled = false;
  render(s);
  logBox.replaceChildren();
  logs.forEach(addLog);
  logBox.scrollTop = logBox.scrollHeight;
});
socket.on('state', render);
socket.on('log', addLog);
socket.on('connect_error', (e) => {
  if (e && e.message === 'unauthorized') location.href = '/login';
  else toast('Dashboard connection interrupted', true);
});
socket.on('disconnect', () => toast('Verbindung zum Dashboard disconnected', true));

// ------------------------------------------------------------ Buttons

$('btnVersion').onclick = () => act('set_version', { version: $('mcVersion').value }, 'Minecraft-Version gespeichert');
$('btnStop').onclick = () => act('stop', {}, 'Stopped');
$('btnStartMining')?.addEventListener('click', () => act('start', {}, 'Mining gestartet'));

$('btnConnect').onclick = () => {
  const names = [...selectedConnectBots];
  if (!names.length) return toast('Select at least one bot first.', true);
  act('connect_selected', { host: $('host').value, names }, 'Connecting selected bots…');
};
$('connectBotSearch')?.addEventListener('input', () => { if (state) render(state); });
$('selectAllBots')?.addEventListener('click', () => {
  if (state) state.bots.forEach((b) => selectedConnectBots.add(b.name));
  if (state) render(state);
});
$('deselectAllBots')?.addEventListener('click', () => {
  selectedConnectBots.clear();
  if (state) render(state);
});
$('btnDisconnect').onclick = () => { const names = [...selectedConnectBots]; if (!names.length) return toast('Select at least one bot first.', true); if (confirm('Disconnect selected bots?')) act('disconnect_selected', { names }, 'Selected bots disconnected'); };
$('closeMsaModal').onclick = () => { msaModalDismissed = true; $('msaCard').hidden = true; };

$('btnAddBot').onclick = () => {
  act('add_bot', { auth: 'microsoft' }, 'Starting Microsoft sign-in…');
};

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
  if (any && !all) return toast('Chest: bitte X, Y und Z ausfuellen oder alle leer lassen', true);
  act('set_settings', {
    durabilityThreshold: num('sThreshold'),
    throwDelayMs: num('sDelay'),
    minFreeSlots: num('sFree'),
    fishingThreshold: num('fishThreshold'),
    fishingUseMending: $('fishMending').checked,
    fishingDeposit: $('fishDeposit').checked,
    autoEat: $('autoEat').checked,
    autoEatThreshold: num('autoEatThreshold'),
    dropItems: $('dropItems').value.split(',').map(x => x.trim().toLowerCase().replace(/^minecraft:/, '')).filter(Boolean),
    avoidLiquid: $('sLiquid').checked,
    allowDigOutside: $('sOutside').checked,
    excludedBlocks: $('sExcluded').value.split(',').map(x => x.trim()).filter(Boolean),
    chest: all ? { x: c[0], y: c[1], z: c[2] } : null,
  }, 'Settings saved');
};

function sendChat() {
  const text = $('chatText').value;
  if (!text.trim()) return;
  act('chat', { target: $('chatTarget').value, text }, 'Sent');
  $('chatText').value = '';
}
$('btnChat').onclick = sendChat;
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
