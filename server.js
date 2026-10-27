const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const BotController = require('./bots/botController');
const AuthController = require('./auth/authController');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const botController = new BotController(io);
const authController = new AuthController();

// --- Routes ---

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const token = authController.login(username, password);
  if (token) {
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Ungültige Zugangsdaten' });
  }
});

// Bots-Status
app.get('/api/bots/status', (req, res) => {
  const status = botController.getBotsStatus();
  res.json(status);
});

// --- Socket.io Events ---

io.on('connection', (socket) => {
  console.log('Client verbunden:', socket.id);

  // Bot verbinden
  socket.on('connect-bot', async (data) => {
    const { botIndex, server, accountType, account, password, token } = data;
    try {
      await botController.connectBot(botIndex, server, accountType, account, password, token);
      io.emit('bot-status', botController.getBotsStatus());
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  // Mining starten
  socket.on('start-mining', (data) => {
    const { botIndex, pos1, pos2 } = data;
    botController.startMining(botIndex, pos1, pos2);
  });

  // Mining stoppen
  socket.on('stop-mining', (data) => {
    const { botIndex } = data;
    botController.stopMining(botIndex);
  });

  // Bot disconnecten
  socket.on('disconnect-bot', (data) => {
    const { botIndex } = data;
    botController.disconnectBot(botIndex);
  });

  socket.on('disconnect', () => {
    console.log('Client getrennt:', socket.id);
  });
});

// --- Server starten ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(Dashboard läuft auf http://localhost:${PORT});
});
