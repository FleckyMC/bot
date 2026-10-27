module.exports = {
  port: process.env.PORT || 3000,
  host: 'localhost',
  
  // Mining Einstellungen
  mining: {
    repairDurability: 300,
    tickDelay: 200
  },

  // Bot Einstellungen
  bots: {
    maxBots: 2,
    minecraftVersion: '1.21.1'
  },

  // Logger
  logging: {
    level: 'info',
    file: './logs/bot.log'
  }
};
