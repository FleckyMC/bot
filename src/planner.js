'use strict';

const MAX_VOLUME = 20_000_000;

function toInt(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${label} muss eine ganze Zahl sein`);
  if (Math.abs(n) > 30_000_000) throw new Error(`${label} ist zu gross`);
  return n;
}

function normalizeArea(p1, p2) {
  if (!p1 || !p2) throw new Error('Bitte beide Eckpunkte angeben');
  const a = { x: toInt(p1.x, 'X1'), y: toInt(p1.y, 'Y1'), z: toInt(p1.z, 'Z1') };
  const b = { x: toInt(p2.x, 'X2'), y: toInt(p2.y, 'Y2'), z: toInt(p2.z, 'Z2') };
  const r = {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
    minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
  };
  if (volume(r) > MAX_VOLUME) throw new Error('Bereich ist zu gross (max. 20 Mio. Bloecke)');
  return r;
}

function volume(r) {
  return (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1) * (r.maxZ - r.minZ + 1);
}

// Teilt den Bereich entlang der laengeren horizontalen Achse in gleich grosse Streifen.
// Gibt ein Array gleicher Laenge wie names zurueck (null = Bot bekommt keinen Streifen).
function split(area, count) {
  const sizeX = area.maxX - area.minX + 1;
  const sizeZ = area.maxZ - area.minZ + 1;
  const axis = sizeX >= sizeZ ? 'X' : 'Z';
  const len = axis === 'X' ? sizeX : sizeZ;
  const base = Math.floor(len / count);
  const extra = len % count;
  const out = [];
  let cursor = axis === 'X' ? area.minX : area.minZ;
  for (let i = 0; i < count; i++) {
    const size = base + (i < extra ? 1 : 0);
    if (size === 0) { out.push(null); continue; }
    const from = cursor;
    const to = cursor + size - 1;
    cursor += size;
    out.push(axis === 'X'
      ? { ...area, minX: from, maxX: to }
      : { ...area, minZ: from, maxZ: to });
  }
  return out;
}

function inside(r, x, y, z) {
  return !!r && x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY && z >= r.minZ && z <= r.maxZ;
}

module.exports = { normalizeArea, volume, split, inside, MAX_VOLUME };
