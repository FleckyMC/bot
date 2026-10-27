'use strict';
const assert = require('assert');
const { normalizeArea, volume, split, inside } = require('../src/planner');

const a = normalizeArea({ x: 10, y: 5, z: -3 }, { x: -4, y: 20, z: 6 });
assert.deepStrictEqual(a, { minX: -4, maxX: 10, minY: 5, maxY: 20, minZ: -3, maxZ: 6 });
assert.strictEqual(volume(a), 15 * 16 * 10);

// Streifen decken den Bereich lueckenlos und ohne Ueberlappung ab
for (const n of [1, 2, 3, 4, 7, 15, 20]) {
  const parts = split(a, n);
  assert.strictEqual(parts.length, n);
  const total = parts.filter(Boolean).reduce((s, r) => s + volume(r), 0);
  assert.strictEqual(total, volume(a), `n=${n}`);
}
// Mehr Bots als Breite -> ueberzaehlige bekommen null
assert.strictEqual(split(a, 20).filter(r => r === null).length, 5);

// laengere Achse wird gewaehlt (hier Z)
const b = normalizeArea({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 9 });
assert.ok(split(b, 2).every(r => r.minX === 0 && r.maxX === 2));

assert.ok(inside(a, 0, 5, 0));
assert.ok(!inside(a, 11, 5, 0));
assert.throws(() => normalizeArea({ x: 'a', y: 0, z: 0 }, { x: 0, y: 0, z: 0 }));
assert.throws(() => normalizeArea({ x: 0, y: -64, z: 0 }, { x: 5000, y: 300, z: 5000 }));
console.log('planner tests ok');
