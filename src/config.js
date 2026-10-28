'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  connection: { host: '', port: 0, auth: 'offline' },
  version: 'auto',
  names: [],
  area: null, // { p1:{x,y,z}, p2:{x,y,z} }
  settings: {
    durabilityThreshold: 300, // unter diesem Wert wird repariert
    chest: null,              // {x,y,z} oder null
    minFreeSlots: 2,
    avoidLiquid: true,
    allowDigOutside: false,
    excludedBlocks: ['bedrock', 'chest', 'trapped_chest', 'ender_chest', 'barrel'],
    throwDelayMs: 600,
    collectEvery: 8,
    bottleBatch: 128,
    fishingThreshold: 20,
    fishingUseMending: true,
    fishingDeposit: true,
    autoEat: true,
    autoEatThreshold: 14,
    dropItems: [],
  },
};

function load(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      connection: { ...DEFAULTS.connection, ...(raw.connection || {}) },
      version: raw.version || DEFAULTS.version,
      names: Array.isArray(raw.names) ? raw.names : [],
      area: raw.area || null,
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function save(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { load, save, DEFAULTS };
