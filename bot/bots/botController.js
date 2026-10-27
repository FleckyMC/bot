const mineflayer = require('mineflayer');
const MiningLogic = require('./miningLogic');
const XPRepair = require('./xpRepair');

class BotController {
  constructor(io) {
    this.io = io;
    this.bots = [
      { index: 0, bot: null, status: 'disconnected', pos: null, durability: null, mining: false },
      { index: 1, bot: null, status: 'disconnected', pos: null, durability: null, mining: false }
    ];
  }

  async connectBot(botIndex, server, accountType, account, password, token) {
    const botData = this.bots[botIndex];

    const options = {
      host: server,
      version: '1.21.1',
      username: account
    };

    // Microsoft Login oder Token
    if (accountType === 'microsoft') {
      options.auth = 'microsoft';
      options.password = password;
    } else if (accountType === 'token') {
      options.auth = 'offline';
    }

    const bot = mineflayer.createBot(options);

    bot.on('login', () => {
      botData.bot = bot;
      botData.status = 'connected';
      console.log(Bot ${botIndex} verbunden);
      this.io.emit('bot-status', this.getBotsStatus());
      this.attachBotListeners(botIndex);
    });

    bot.on('error', (err) => {
      botData.status = 'error';
      console.error(Bot ${botIndex} Fehler:, err.message);
      this.io.emit('bot-status', this.getBotsStatus());
    });

    bot.on('kicked', (reason) => {
      botData.status = 'kicked';
      console.log(Bot ${botIndex} gekickt:, reason);
      this.io.emit('bot-status', this.getBotsStatus());
    });
  }

  attachBotListeners(botIndex) {
    const bot = this.bots[botIndex].bot;

    bot.on('move', () => {
      this.bots[botIndex].pos = {
        x: Math.floor(bot.entity.position.x),
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z)
      };
      this.io.emit('bot-status', this.getBotsStatus());
    });

    // Durability tracken
    setInterval(() => {
      const heldItem = bot.inventory.slots[bot.inventory.selected];
      if (heldItem && (heldItem.name.includes('pickaxe'))) {
        this.bots[botIndex].durability = heldItem.durability;
        this.io.emit('bot-status', this.getBotsStatus());
      }
    }, 1000);
  }

  startMining(botIndex, pos1, pos2) {
    const botData = this.bots[botIndex];
    if (!botData.bot) return;

    botData.mining = true;
    const miningLogic = new MiningLogic(botData.bot, this.io);
    const xpRepair = new XPRepair(botData.bot);

    miningLogic.startMining(pos1, pos2, xpRepair);
  }

  stopMining(botIndex) {
    this.bots[botIndex].mining = false;
    if (this.bots[botIndex].bot) {
      this.bots[botIndex].bot.clearControlStates();
    }
  }

  disconnectBot(botIndex) {
    const botData = this.bots[botIndex];
    if (botData.bot) {
      botData.bot.quit();
      botData.bot = null;
      botData.status = 'disconnected';
      this.io.emit('bot-status', this.getBotsStatus());
    }
  }

  getBotsStatus() {
    return this.bots.map(b => ({
      index: b.index,
      status: b.status,
      pos: b.pos,
      durability: b.durability,
      mining: b.mining
    }));
  }
}

module.exports = BotController;
