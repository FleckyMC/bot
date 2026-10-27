class XPRepair {
  constructor(bot) {
    this.bot = bot;
  }

  async repairPickaxe(bot) {
    let repairSplash = null;

    // In Hotbar (Slots 0-8) nach XP-Splash suchen
    for (let i = 0; i < 9; i++) {
      const item = bot.inventory.slots[i];
      if (item && item.name.includes('splash_potion') && item.nbt && item.nbt.value.CustomPotionEffects) {
        repairSplash = item;
        bot.inventory.selected = i;
        break;
      }
    }

    // Nicht in Hotbar? Aus Inventar in Hotbar
    if (!repairSplash) {
      for (let i = 9; i < bot.inventory.slots.length; i++) {
        const item = bot.inventory.slots[i];
        if (item && item.name.includes('splash_potion')) {
          repairSplash = item;
          // Move to hotbar
          await bot.inventory.move(i, 0);
          bot.inventory.selected = 0;
          break;
        }
      }
    }

    if (repairSplash) {
      console.log('Trinke XP-Splash');
      bot.setControlState('jump', true);
      await this.sleep(200);
      bot.activateItem();
      await this.sleep(300);
      bot.setControlState('jump', false);
      bot.deactivateItem();
      await this.sleep(1000);
    } else {
      console.warn('Keine XP-Splashe im Inventar!');
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = XPRepair;
