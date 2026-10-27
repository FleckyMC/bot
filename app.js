'use strict';
const $ = (id) => document.getElementById(id);
const socket = io();
let state = null;
let formsFilled = false;

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
  offline: ['getrennt', ''], connecting: ['verbindet', 'warn'], reconnecting: ['verbindet neu', 'warn'],
  idle: ['bereit', 'ok'], mining: ['baut ab', 'ok'], repairing: ['repariert', 'warn'],
  depositing: ['Kiste', 'warn'], done: ['fertig', 'ok'], error: ['Fehler', 'err'],
};

// ------------------------------------------------------------ Formulare befuellen (einmalig)

function fillForms(s) {
  $('host').value = s.connection.host ? s.connection.host + (s.connection.port ? ':' + s.connection.port : '') : '';
  $('auth').value = s.connection.auth || 'offline';
  $('names').value = (s.names || []).join('\n');
  $('version').textContent = s.version;
  if (s.area) {
    $('x1').value = s.area.p1.x; $('y1').value = s.area.p1.y; $('z1').value = s.area.p1.z;
    $('x2').value = s.area.p2.x; $('y2').value = s.area.p2.y; $('z2').value = s.area.p2.z;
  }
  $('sThreshold').value = s.settings.durabilityThreshold;
  $('sDelay').value = s.settings.throwDelayMs;
  $('sFree').value = s.settings.minFreeSlots;
  $('sLiquid').checked = s.settings.avoidLiquid;
  $('sOutside').checked = !!s.settings.allowDigOutside;
  if (s.settings.chest) { $('cx').value = s.settings.chest.x; $('cy').value = s.settings.chest.y; $('cz').value = s.settings.chest.z; }
  formsFilled = true;
}

// ------------------------------------------------------------ Rendern

function render(s) {
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
  if (!s.bots.length) { box.append(el('p', 'muted', 'Noch keine Bots verbunden.')); return; }
  for (const b of s.bots) {
    const [label, cls] = STATUS[b.status] || [b.status, ''];
    const card = el('div', 'bot');
    const top = el('div', 'top');
    top.append(el('span', 'name', b.name), el('span', 'chip ' + cls, label));
    card.append(top, el('div', 'detail', b.detail || ' '));

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
    if (b.hasRegion && b.progress != null) {
      card.append(kv('Fortschritt', Math.round(b.progress * 100) + ' %'));
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (b.progress * 100).toFixed(0) + '%';
      bar.append(fill); card.append(bar);
    }
    box.append(card);
  }
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

$('btnStart').onclick = () => act('start', {}, 'Gestartet');
$('btnStop').onclick = () => act('stop', {}, 'Gestoppt');

$('btnConnect').onclick = () => act('connect_bots', {
  host: $('host').value,
  auth: $('auth').value,
  names: $('names').value.split(/\r?\n/),
}, 'Verbinde...');
$('btnDisconnect').onclick = () => { if (confirm('Alle Bots trennen?')) act('disconnect_bots', {}, 'Getrennt'); };

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
