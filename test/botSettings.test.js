'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReconnectSettings, publicReconnectSettings } = require('../src/botSettings');
const { isInternalHost } = require('../src/botManager');

test('reconnect settings: defaults, validation and keeping previous values', () => {
  const d = normalizeReconnectSettings({});
  assert.deepEqual(d, { commandEnabled: false, command: '', delaySec: 5, runOn: 'reconnect' });
  const a = normalizeReconnectSettings({ commandEnabled: true, command: ' /login secret ', delaySec: 8, runOn: 'always' });
  assert.deepEqual(a, { commandEnabled: true, command: '/login secret', delaySec: 8, runOn: 'always' });
  assert.deepEqual(normalizeReconnectSettings({ delaySec: 1 }, a), { ...a, delaySec: 1 });
  assert.throws(() => normalizeReconnectSettings({ commandEnabled: true, command: '' }), /empty/);
  assert.throws(() => normalizeReconnectSettings({ command: 'a\nb' }), /single line/);
  assert.throws(() => normalizeReconnectSettings({ command: 'x'.repeat(257) }), /256/);
  assert.throws(() => normalizeReconnectSettings({ delaySec: 500 }), /0 and 120/);
  assert.throws(() => normalizeReconnectSettings({ runOn: 'never' }), /Run on/);
  assert.equal(publicReconnectSettings(undefined).delaySec, 5);
});

test('regular users cannot point bots at internal addresses', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.2', '172.20.0.1', '169.254.1.1', '::1', 'intranet', 'x.local']) assert.equal(isInternalHost(h), true, h);
  for (const h of ['play.meltrovia.com', 'game01.ruxora.org', '8.8.8.8']) assert.equal(isInternalHost(h), false, h);
});
