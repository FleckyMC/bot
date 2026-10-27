const socket = io();
let token = localStorage.getItem('token');
let currentBot = null;

// --- Initialisierung ---
window.addEventListener('load', () => {
  if (token) {
    showDashboard();
  } else {
    showLogin();
  }
  updateBotStatus();
  setInterval(updateBotStatus, 1000);
});

// --- Login ---
function login() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  if (!username || !password) {
    showError('Benutzername und Passwort erforderlich');
    return;
  }

  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      token = data.token;
      localStorage.setItem('token', token);
      showSuccess('Angemeldet!');
      setTimeout(showDashboard, 500);
    } else {
      showError(data.message || 'Login fehlgeschlagen');
    }
  })
  .catch(err => showError('Fehler: ' + err.message));
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  showLogin();
}

// --- UI ---
function showLogin() {
  document.getElementById('loginPanel').style.display = 'block';
  document.getElementById('dashboard').style.display = 'none';
}

function showDashboard() {
  document.getElementById('loginPanel').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
}

// --- Bot Verbindung ---
function connectBot(botIndex) {
  const server = document.getElementById(bot${botIndex}-server).value;
  const accountType = document.getElementById(bot${botIndex}-type).value;
  const account = document.getElementById(bot${botIndex}-account).value;
  const password = document.getElementById(bot${botIndex}-password).value;

  if (!server || !account) {
    showError('Server und Account erforderlich');
    return;
  }

  socket.emit('connect-bot', {
    botIndex,
    server,
    accountType,
    account,
    password,
    token
  });

  showInfo(Verbinde Bot ${botIndex}...);
}

function disconnectBot(botIndex) {
  socket.emit('disconnect-bot', { botIndex });
  showInfo(Bot ${botIndex} getrennt);
}

// --- Mining ---
function startMining(botIndex) {
  const pos1 = {
    x: parseInt(document.getElementById(bot${botIndex}-pos1-x).value),
    y: parseInt(document.getElementById(bot${botIndex}-pos1-y).value),
    z: parseInt(document.getElementById(bot${botIndex}-pos1-z).value)
  };

  const pos2 = {
    x: parseInt(document.getElementById(bot${botIndex}-pos2-x).value),
    y: parseInt(document.getElementById(bot${botIndex}-pos2-y).value),
    z: parseInt(document.getElementById(bot${botIndex}-pos2-z).value)
  };

  if (isNaN(pos1.x) || isNaN(pos2.x)) {
    showError('Ungültige Koordinaten');
    return;
  }

  socket.emit('start-mining', { botIndex, pos1, pos2 });
  showSuccess(Mining für Bot ${botIndex} gestartet);
}

function stopMining(botIndex) {
  socket.emit('stop-mining', { botIndex });
  showInfo(Mining für Bot ${botIndex} gestoppt);
}

// --- Status Update ---
function updateBotStatus() {
  fetch('/api/bots/status')
    .then(res => res.json())
    .then(bots => {
      bots.forEach(bot => {
        const statusEl = document.getElementById(bot${bot.index}-status);
        const posEl = document.getElementById(bot${bot.index}-pos);
        const durEl = document.getElementById(bot${bot.index}-dur);

        if (statusEl) {
          statusEl.textContent = bot.status.toUpperCase();
          statusEl.className = bot-status ${bot.status};
        }

        if (posEl && bot.pos) {
          posEl.textContent = Position: X=${bot.pos.x} Y=${bot.pos.y} Z=${bot.pos.z};
        }

        if (durEl && bot.durability) {
          durEl.textContent = Durability: ${bot.durability};
        }
      });
    })
    .catch(err => console.error('Status Update Fehler:', err));
}

// --- Socket Events ---
socket.on('bot-status', (status) => {
  console.log('Bot Status Update:', status);
  updateBotStatus();
});

socket.on('error', (data) => {
  showError(data.message);
});

// --- Notifications ---
function showError(msg) {
  const div = document.createElement('div');
  div.className = 'error';
  div.textContent = '❌ ' + msg;
  document.body.insertBefore(div, document.body.firstChild);
  setTimeout(() => div.remove(), 5000);
}

function showSuccess(msg) {
  const div = document.createElement('div');
  div.className = 'success';
  div.textContent = '✅ ' + msg;
  document.body.insertBefore(div, document.body.firstChild);
  setTimeout(() => div.remove(), 5000);
}

function showInfo(msg) {
  const div = document.createElement('div');
  div.className = 'info';
  div.textContent = 'ℹ️ ' + msg;
  document.body.insertBefore(div, document.body.firstChild);
  setTimeout(() => div.remove(), 5000);
}
