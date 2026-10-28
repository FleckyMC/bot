'use strict';
const $ = (id) => document.getElementById(id);
const socket = io();
let state = null;
let formsFilled = false;
const inventoryShown = new Set();

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
    if (!res || !res.ok) toast((res && res.error) || 'Fehler', true);
    else if (okMsg) toast(okMsg);
  });
}

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
  fishing: ['angelt', 'ok'], trading: ['handelt', 'warn'], offline: ['getrennt', ''], connecting: ['verbindet', 'warn'], reconnecting: ['verbindet neu', 'warn'],
  idle: ['bereit', 'ok'], mining: ['baut ab', 'ok'], repairing: ['repariert', 'warn'],
  depositing: ['Kiste', 'warn'], done: ['fertig', 'ok'], error: ['Fehler', 'err'],
};

// ------------------------------------------------------------ Formulare befuellen (einmalig)

function fillForms(s) {
  $('host').value = s.connection.host ? s.connection.host + (s.connection.port ? ':' + s.connection.port : '') : '';
  $('auth').value = s.connection.auth || 'offline';
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
  $('sLiquid').checked = s.settings.avoidLiquid;
  $('sOutside').checked = !!s.settings.allowDigOutside;
  $('sExcluded').value = (s.settings.excludedBlocks || []).join(', ');
  if (s.settings.chest) { $('cx').value = s.settings.chest.x; $('cy').value = s.settings.chest.y; $('cz').value = s.settings.chest.z; }
  formsFilled = true;
}

// ------------------------------------------------------------ Rendern

function render(s) {
  // Die Bot-Karten werden bei jedem Status neu aufgebaut. Scrollposition sichern,
  // damit das geöffnete Inventar nicht bei jedem Socket-Update nach oben springt.
  const savedScrollX = window.scrollX;
  const savedScrollY = window.scrollY;
  state = s;
  if (!formsFilled) fillForms(s);

  const online = s.bots.filter((b) => b.pos).length;
  const c = $('conn');
  c.textContent = s.bots.length ? `${online}/${s.bots.length} online` : 'getrennt';
  c.className = 'chip ' + (online ? 'ok' : 'off');

  const run = $('runChip');
  run.textContent = s.mining ? 'laeuft' : 'steht still';
  run.className = 'chip ' + (s.mining ? 'ok' : 'off');
  $('btnStart').disabled = s.mining || !s.bots.length;
  $('runHint').textContent = !s.area ? 'Zuerst einen Bereich speichern.' : !s.bots.length ? 'Zuerst Bots verbinden.' : '';
  $('areaInfo').textContent = s.area ? `${s.areaVolume.toLocaleString('de-DE')} Bloecke gespeichert` : '';

  // Microsoft-Codes
  const msa = s.bots.filter((b) => b.msa);
  $('msaCard').hidden = !msa.length;
  const list = $('msaList');
  list.replaceChildren();
  for (const b of msa) {
    const row = el('div', 'msa');
    row.append(el('b', '', b.name), el('code', '', b.msa.code));
    const a = el('a', '', 'Seite oeffnen');
    try {
      const u = new URL(b.msa.url);
      if (u.protocol === 'https:') { a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    } catch { /* kein Link */ }
    row.append(a);
    list.append(row);
  }

  // Ziel-Auswahl fuer Befehle
  const sel = $('chatTarget');
  const want = ['all', ...s.bots.map((b) => b.name)];
  if (sel.options.length !== want.length || [...sel.options].some((o, i) => o.value !== want[i])) {
    const cur = sel.value;
    sel.replaceChildren();
    for (const v of want) { const o = el('option', '', v === 'all' ? 'Alle Bots' : v); o.value = v; sel.append(o); }
    sel.value = want.includes(cur) ? cur : 'all';
  }

  // Bot-Karten
  const box = $('bots');
  box.replaceChildren();
  if (!s.bots.length) {
    box.append(el('p', 'muted', 'Noch keine Bots verbunden.'));
    requestAnimationFrame(() => window.scrollTo(savedScrollX, savedScrollY));
    return;
  }
  for (const b of s.bots) {
    const [label, cls] = STATUS[b.status] || [b.status, ''];
    const card = el('div', 'bot');
    const top = el('div', 'top');
    top.append(el('span', 'name', b.name), el('span', 'chip ' + cls, label));
    card.append(top);
    const account = el('div', 'detail', b.accountName ? `Minecraft-Spieler: ${b.accountName}` : (b.authMethod === 'microsoft' ? 'Minecraft-Spieler: wird nach Login angezeigt' : `Offline-Name: ${b.name}`));
    card.append(account, el('div', 'detail', b.detail || ' '));

    const kv = (k, v) => { const r = el('div', 'kv'); r.append(el('span', '', k), el('b', '', v)); return r; };
    card.append(kv('Position', b.pos ? `${b.pos.x} ${b.pos.y} ${b.pos.z}` : '-'));
    card.append(kv('Leben / Hunger', b.health != null ? `${Math.round(b.health)} / ${b.food}` : '-'));
    card.append(kv('Spitzhacke', b.pickaxe ? `${b.pickaxe.left ?? '?'} / ${b.pickaxe.max ?? '?'}` : (b.pos ? 'keine' : '-')));
    if (b.pickaxe && b.pickaxe.max) {
      const frac = Math.max(0, Math.min(1, b.pickaxe.left / b.pickaxe.max));
      const bar = el('div', 'bar' + (b.pickaxe.left < (state.settings.durabilityThreshold) ? ' low' : ''));
      const fill = el('i'); fill.style.width = (frac * 100).toFixed(0) + '%';
      bar.append(fill); card.append(bar);
    }
    card.append(kv('XP-Flaschen', b.bottles != null ? String(b.bottles) : '-'));
    card.append(kv('Freie Slots', b.freeSlots != null ? String(b.freeSlots) : '-'));
    card.append(kv('Abgebaut', String(b.mined)));
    if (b.fishCaught != null) card.append(kv('Gefangen', String(b.fishCaught)));
    if (b.trades != null) card.append(kv('Trades', String(b.trades))); 
    card.append(kv('Aufgabe', ({ idle: 'Keine', mining: 'Abbau', afk: 'AFK/Präsenz', fishing: 'Angeln', trading: 'Handel' })[b.profile] || b.profile || 'Keine'));
    const actions = el('div', 'row wrap');
    const addTask = (label, profile, cls) => {
      const btn = el('button', cls || 'ghost', label);
      btn.onclick = () => act('bot_profile', { name: b.name, profile }, `${b.name}: ${label}`);
      actions.append(btn);
    };
    addTask('AFK', 'afk'); addTask('Angeln', 'fishing');
    const trade = el('button', 'ghost', 'Handel');
    trade.onclick = () => {
      const target = prompt('Automatischer Handel: Ergebnis-Itemname (z. B. emerald) ODER Angebotsnummer. Leer lassen, um nur Angebote anzuzeigen.');
      if (target === null) return;
      if (!target.trim()) { act('bot_profile', { name: b.name, profile: 'trading', options: {} }, `${b.name}: Handelsangebote anzeigen`); return; }
      const countRaw = prompt('Maximale Anzahl Trades (1–256). Der Bot stoppt früher, wenn das Angebot ausverkauft ist oder Materialien fehlen.', '16');
      if (countRaw === null) return;
      const count = Number(countRaw);
      if (!Number.isInteger(count) || count < 1 || count > 256) return toast('Menge muss zwischen 1 und 256 liegen', true);
      const options = { tradeCount: count };
      if (/^\d+$/.test(target.trim())) options.tradeIndex = Number(target.trim()) - 1;
      else options.outputItem = target.trim();
      act('bot_profile', { name: b.name, profile: 'trading', options }, `${b.name}: automatischer Handel gestartet`);
    };
    actions.append(trade); addTask('Aufgabe stoppen', 'idle', 'danger-ghost');
    const remove = el('button', 'danger-ghost', 'Bot entfernen');
    remove.onclick = () => { if (confirm(`Bot ${b.name} entfernen?`)) act('remove_bot', { name: b.name }, `${b.name} entfernt`); };
    actions.append(remove);
    const invBtn = el('button', 'ghost', inventoryShown.has(b.name) ? 'Inventar ausblenden' : 'Inventar ansehen');
    invBtn.onclick = () => { if (inventoryShown.has(b.name)) inventoryShown.delete(b.name); else inventoryShown.add(b.name); render(state); };
    actions.append(invBtn);
    card.append(actions);
    if (inventoryShown.has(b.name)) {
      const inv = el('div', 'inventory-list');
      const invHead = el('div', 'inventory-head');
      invHead.append(el('b', '', 'Inventar'), el('span', 'inventory-count', `${(b.inventory || []).length} Slots`));
      inv.append(invHead);
      if (!(b.inventory || []).length) {
        inv.append(el('p', 'muted small inventory-empty', b.pos ? 'Keine Items im Inventar.' : 'Bot ist nicht verbunden.'));
      } else {
        const grid = el('div', 'inventory-grid');
        for (const item of (b.inventory || [])) {
          const slot = el('div', 'inventory-slot');
          const itemName = String(item.name || 'unbekannt').replaceAll('_', ' ');
          const icon = el('span', 'inventory-item-icon', item.name === 'fishing_rod' ? '🎣' : item.name === 'experience_bottle' ? '🧪' : item.name.includes('fish') ? '🐟' : item.name.includes('pickaxe') ? '⛏️' : '📦');
          const count = el('span', 'inventory-count-stack', `×${item.count}`);
          slot.title = `${itemName} · Slot ${item.slot}`;
          slot.append(icon, count, el('span', 'inventory-item-name', itemName));
          if (item.maxDurability) {
            const pct = Math.max(0, Math.min(100, (Number(item.durabilityLeft) || 0) / item.maxDurability * 100));
            const durability = el('div', 'inventory-durability' + (pct < 25 ? ' low' : ''));
            const bar = el('i'); bar.style.width = `${pct}%`; durability.append(bar); slot.append(durability);
          }
          if (item.mending) slot.append(el('span', 'inventory-enchant', 'Mending'));
          grid.append(slot);
        }
        inv.append(grid);
      }
      inv.append(el('div', 'muted small inventory-note', 'Wird automatisch aktualisiert, solange der Bot verbunden ist.'));
      card.append(inv);
    }
    if (b.hasRegion && b.progress != null) {
      card.append(kv('Fortschritt', Math.round(b.progress * 100) + ' %'));
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (b.progress * 100).toFixed(0) + '%';
      bar.append(fill); card.append(bar);
    }
    box.append(card);
  }
  requestAnimationFrame(() => window.scrollTo(savedScrollX, savedScrollY));
}

// ------------------------------------------------------------ Log

const logBox = $('log');
function addLog(e) {
  const stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
  const d = el('div', e.level === 'warn' || e.level === 'error' ? e.level : '');
  d.append(el('span', 't', new Date(e.t).toLocaleTimeString('de-DE') + ' '), el('span', 'src', `[${e.source}] `), document.createTextNode(e.text));
  logBox.append(d);
  while (logBox.childElementCount > 400) logBox.firstElementChild.remove();
  if (stick) logBox.scrollTop = logBox.scrollHeight;
}

// ------------------------------------------------------------ Socket

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
  else toast('Verbindung zum Dashboard unterbrochen', true);
});
socket.on('disconnect', () => toast('Verbindung zum Dashboard getrennt', true));

// ------------------------------------------------------------ Buttons

$('btnVersion').onclick = () => act('set_version', { version: $('mcVersion').value }, 'Minecraft-Version gespeichert');
$('btnStart').onclick = () => act('start', {}, 'Gestartet');
$('btnStop').onclick = () => act('stop', {}, 'Gestoppt');

$('btnConnect').onclick = () => act('connect_bots', {
  host: $('host').value,
  auth: $('auth').value,
  names: $('names').value.split(/\r?\n/),
}, 'Verbinde...');
$('btnDisconnect').onclick = () => { if (confirm('Alle Bots trennen?')) act('disconnect_bots', {}, 'Getrennt'); };
$('btnAddBot').onclick = () => {
  const name = $('singleName').value.trim();
  if (!name) return toast('Bitte einen Bot-Namen eingeben', true);
  act('add_bot', { name, auth: $('singleAuth').value }, `Bot ${name} wird hinzugefügt`);
};

$('btnGen').onclick = () => {
  const prefix = $('genPrefix').value.trim() || 'Miner';
  const n = Math.max(1, Math.min(100, Number($('genCount').value) || 1));
  $('names').value = Array.from({ length: n }, (_, i) => prefix + (i + 1)).join('\n');
};

$('btnArea').onclick = () => {
  const p1 = { x: num('x1'), y: num('y1'), z: num('z1') };
  const p2 = { x: num('x2'), y: num('y2'), z: num('z2') };
  if ([...Object.values(p1), ...Object.values(p2)].some(Number.isNaN)) return toast('Bitte alle sechs Koordinaten ausfuellen', true);
  act('set_area', { p1, p2 }, 'Bereich gespeichert');
};

$('btnSettings').onclick = () => {
  const c = ['cx', 'cy', 'cz'].map(num);
  const any = c.some((v) => !Number.isNaN(v));
  const all = c.every((v) => !Number.isNaN(v));
  if (any && !all) return toast('Kiste: bitte X, Y und Z ausfuellen oder alle leer lassen', true);
  act('set_settings', {
    durabilityThreshold: num('sThreshold'),
    throwDelayMs: num('sDelay'),
    minFreeSlots: num('sFree'),
    avoidLiquid: $('sLiquid').checked,
    allowDigOutside: $('sOutside').checked,
    excludedBlocks: $('sExcluded').value.split(',').map(x => x.trim()).filter(Boolean),
    chest: all ? { x: c[0], y: c[1], z: c[2] } : null,
  }, 'Einstellungen gespeichert');
};

function sendChat() {
  const text = $('chatText').value;
  if (!text.trim()) return;
  act('chat', { target: $('chatTarget').value, text }, 'Gesendet');
  $('chatText').value = '';
}
$('btnChat').onclick = sendChat;
$('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
