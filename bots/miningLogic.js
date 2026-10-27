const Vec3 = require('vec3');

class MiningLogic {
  constructor(bot, io) {
    this.bot = bot;
    this.io = io;
    this.isRunning = false;
  }

  async startMining(pos1, pos2, xpRepair) {
    this.isRunning = true;

    const minX = Math.min(pos1.x, pos2.x);
    const maxX = Math.max(pos1.x, pos2.x);
    const minY = Math.min(pos1.y, pos2.y);
    const maxY = Math.max(pos1.y, pos2.y);
    const minZ = Math.min(pos1.z, pos2.z);
    const maxZ = Math.max(pos1.z, pos2.z);

    const blocks = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
          if (block && block.hardness >= 0 && block.hardness !== null) {
            blocks.push(block);
          }
        }
      }
    }

    console.log(${blocks.length} Blöcke zum Abbauen gefunden);

    for (const block of blocks) {
      if (!this.isRunning) break;

      // Durability checken
      const heldItem = this.bot.inventory.slots[this.bot.inventory.selected];
      if (heldItem && heldItem.durability < 300) {
        console.log('Repariere Spitzhacke...');
        await xpRepair.repairPickaxe(this.bot);
      }

      // Block abbauen
      await this.bot.dig(block);
      await this.sleep(100);
    }

    console.log('Mining abgeschlossen');
    this.isRunning = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = MiningLogic;
