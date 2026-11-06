'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../src/auth');
const perms = require('../src/permissions');
const { createAudit } = require('../src/audit');
const { createFounderStore } = require('../src/founder');
const { buildAccountPayload, notifyAccountEvent } = require('../src/accountNotify');
const discord = require('../src/discordLink');
const { runLifecycle } = require('../src/lifecycle');

const DAY = 86400000;
function setup(t, admins = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  auth.configure(path.join(dir, 'users.json'), 'Boss', 'founder-password-1', { admins });
  const byName = (n) => auth.getUsers().find((u) => u.username === n);
  return { dir, byName };
}

test('founder and env admins are created once; deleted env admins stay deleted', (t) => {
  const { dir, byName } = setup(t, [{ username: 'alice', password: 'alice-password-1' }, { username: 'bad', password: 'short' }]);
  assert.equal(byName('Boss').role, 'founder');
  assert.equal(byName('alice').role, 'admin');
  assert.equal(byName('bad'), undefined);
  assert.deepEqual(auth.parseAdminAccounts('a1:pw one,b2:x:y'), [{ username: 'a1', password: 'pw one' }, { username: 'b2', password: 'x:y' }]);
  auth.deleteUser(byName('alice').id);
  auth.configure(path.join(dir, 'users.json'), 'Boss', 'founder-password-1', { admins: [{ username: 'alice', password: 'alice-password-1' }] });
  assert.equal(byName('alice'), undefined, 'a deleted admin is not re-created from .env');
  assert.throws(() => auth.deleteUser(byName('Boss').id), /founder/);
  // an existing account with the founder name is promoted
  auth.createUser({ username: 'Chief', password: 'chief-password-1' });
  auth.configure(path.join(dir, 'users.json'), 'Chief', 'x'.repeat(12), {});
  assert.equal(auth.getUsers().filter((u) => u.role === 'founder').length, 1, 'only one founder');
});

test('permissions: admins manage users only, never other admins, and cannot see the founder', (t) => {
  const { byName } = setup(t, [{ username: 'alice', password: 'alice-password-1' }, { username: 'bob', password: 'bob-password-12' }]);
  auth.createUser({ username: 'carl', password: 'carl-password-1' });
  const [boss, alice, bob, carl] = ['Boss', 'alice', 'bob', 'carl'].map(byName);
  assert.equal(perms.canManage(alice, carl), true);
  assert.equal(perms.canDelete(alice, carl), true);
  assert.equal(perms.canDelete(alice, bob), false, 'admin cannot delete admin');
  assert.equal(perms.canManage(alice, boss), false);
  assert.equal(perms.canSee(alice, boss), false, 'founder is invisible to admins');
  assert.equal(perms.canSee(boss, alice), true);
  assert.equal(perms.canDelete(boss, alice), true, 'founder can delete admins');
  assert.equal(perms.canDelete(boss, boss), false);
  assert.equal(perms.canCreate(alice, 'admin'), false);
  assert.equal(perms.canCreate(boss, 'admin'), true);
  assert.equal(perms.canCreate(boss, 'founder'), false);
  assert.equal(perms.canManage(carl, alice), false);
  assert.equal(perms.canViewAs(alice, bob), false);
  assert.equal(perms.canViewAs(alice, carl), true);
});

test('rename and add time; permanent accounts cannot get more time', (t) => {
  setup(t);
  const u = auth.createUser({ username: 'dave', password: 'dave-password-1', expiresAt: Date.now() + 2 * DAY });
  auth.createUser({ username: 'erin', password: 'erin-password-1' });
  assert.throws(() => auth.renameUser(u.id, 'ERIN'), /already exists/);
  assert.throws(() => auth.renameUser(u.id, 'x'), /Username must/);
  const r = auth.renameUser(u.id, 'dave2');
  assert.equal(r.before, 'dave'); assert.equal(r.user.username, 'dave2');
  const before = auth.getUsers().find((x) => x.id === u.id).expiresAt;
  const added = auth.addTime(u.id, 30);
  assert.equal(added.user.expiresAt, before + 30 * DAY);
  assert.throws(() => auth.addTime(u.id, 0), /between 1 and/);
  const perm = auth.getUsers().find((x) => x.username === 'erin');
  assert.throws(() => auth.addTime(perm.id, 5), /permanent/);
});

test('expiry: 24 h grace locks the account, then it is deleted; adding time restores it', (t) => {
  setup(t);
  const now = Date.now();
  const u = auth.createUser({ username: 'frank', password: 'frank-password-1', expiresAt: now + 1000 });
  const stored = () => auth.getUsers().find((x) => x.id === u.id);
  assert.equal(auth.accountState(stored(), now), 'active');
  assert.equal(auth.accountState(stored(), now + 2000), 'grace');
  assert.equal(auth.accountState(stored(), now + 1000 + auth.GRACE_MS - 1), 'grace');
  assert.equal(auth.accountState(stored(), now + 1000 + auth.GRACE_MS), 'gone');

  // lifecycle: lock once, then delete after the grace period
  const calls = [];
  const manager = { workers: new Map([['Acc1', {}]]), stopBots: (n) => calls.push(['stop', n]), disconnectSelected: (n) => calls.push(['disc', n]), removeBot: (n) => { calls.push(['remove', n]); manager.workers.delete(n); } };
  auth.updateUser(u.id, { botLimit: 1 }); auth.addOwnedBot(u.id, 'Acc1');
  const audit = createAudit(path.join(os.tmpdir(), `a-${Date.now()}.json`));
  const events = [];
  const notify = (e) => events.push(e.type);
  assert.deepEqual(runLifecycle({ auth, manager, audit, notify, now: now + 2000 }).locked, ['frank']);
  assert.deepEqual(runLifecycle({ auth, manager, audit, notify, now: now + 3000 }).locked, [], 'locks only once');
  assert.deepEqual(calls, [['stop', ['Acc1']], ['disc', ['Acc1']]]);
  // an admin adds time -> active again
  auth.addTime(u.id, 7);
  assert.equal(auth.accountState(stored()), 'active');
  assert.equal(stored().expiredHandled, undefined);
  // expire again and let the grace run out
  auth.updateUser(u.id, { expiresAt: now - 2 * DAY });
  const res = runLifecycle({ auth, manager, audit, notify, now });
  assert.deepEqual(res.deleted, ['frank']);
  assert.equal(stored(), undefined);
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === 'Acc1'));
  assert.deepEqual(events, ['expired', 'auto_deleted']);
});

test('a locked account still has a session (to see the expired page) but a gone one does not', (t) => {
  setup(t);
  const u = auth.createUser({ username: 'gina', password: 'gina-password-1', expiresAt: Date.now() + 60000 });
  const login = auth.login('gina', 'gina-password-1', 'ip1');
  assert.ok(login.token);
  auth.updateUser(u.id, { expiresAt: Date.now() - 1000 });
  assert.equal(auth.sessionUser(login.token).username, 'gina');
  assert.equal(auth.publicUser(auth.sessionUser(login.token)).state, 'grace');
  auth.updateUser(u.id, { expiresAt: Date.now() - 2 * DAY });
  assert.equal(auth.sessionUser(login.token), null);
  assert.equal(auth.login('gina', 'gina-password-1', 'ip2').error, 'expired');
});

test('Discord link: one Discord per account, no silent change, revoke is remembered and logged as a change', (t) => {
  setup(t);
  const a = auth.createUser({ username: 'hank', password: 'hank-password-1' });
  const b = auth.createUser({ username: 'ivy', password: 'ivy-password-12' });
  const link = (id, name) => ({ id, username: name, accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 1e6 });
  assert.equal(auth.setDiscord(a.id, link('111', 'hank#1')).previous, null);
  assert.throws(() => auth.setDiscord(b.id, link('111', 'x')), /already linked to another/);
  assert.throws(() => auth.setDiscord(a.id, link('222', 'other')), /revoking the authorization/);
  const pub = auth.publicUser(auth.getUsers().find((u) => u.id === a.id));
  assert.deepEqual({ id: pub.discord.id, username: pub.discord.username }, { id: '111', username: 'hank#1' });
  assert.equal(JSON.stringify(pub).includes('accessToken'), false, 'tokens never leave the server');
  assert.deepEqual(auth.clearDiscord(a.id), { id: '111', username: 'hank#1' });
  assert.equal(auth.setDiscord(a.id, link('111', 'hank#1')).previous, null, 'same account again is not a change');
  auth.clearDiscord(a.id);
  assert.equal(auth.setDiscord(a.id, link('333', 'newhank')).previous.username, 'hank#1');
});

test('Discord revoke detection uses refresh tokens and never unlinks on network errors', async () => {
  const cfg = { clientId: '1', clientSecret: 's' };
  const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const link = { id: '1', username: 'u', accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() + 1e6 };
  assert.equal((await discord.checkLink(cfg, link, { fetchImpl: async () => res(200, { id: '1', username: 'u' }) })).status, 'ok');
  const revokedAccess = async (url) => (url.includes('/users/@me') ? res(401) : res(400, { error: 'invalid_grant' }));
  assert.equal((await discord.checkLink(cfg, link, { fetchImpl: revokedAccess })).status, 'revoked');
  assert.equal((await discord.checkLink(cfg, link, { fetchImpl: async () => { throw new Error('offline'); } })).status, 'error');
  assert.equal((await discord.checkLink(cfg, link, { fetchImpl: async () => res(503) })).status, 'error');
  const refreshed = async (url) => (url.includes('/users/@me') ? (url.includes('x') ? res(200) : res(200, { id: '1', global_name: 'New Name' })) : res(200, { access_token: 'n', refresh_token: 'r2', expires_in: 600 }));
  const expired = { ...link, tokenExpiresAt: Date.now() - 1000 };
  const r = await discord.checkLink(cfg, expired, { fetchImpl: refreshed });
  assert.equal(r.status, 'ok'); assert.equal(r.patch.accessToken, 'n'); assert.equal(r.patch.username, 'New Name');
  const url = new URL(discord.authorizeUrl({ clientId: '1', redirectUri: 'https://meltrovia.com/auth/discord/callback', state: 'xyz' }));
  assert.equal(url.searchParams.get('scope'), 'identify'); assert.equal(url.searchParams.get('state'), 'xyz');
});

test('audit log hides the founder from admins', () => {
  const audit = createAudit(path.join(os.tmpdir(), `audit-${Date.now()}.json`));
  const boss = { id: 'b', username: 'Boss', role: 'founder' }, alice = { id: 'a', username: 'alice', role: 'admin' }, carl = { id: 'c', username: 'carl', role: 'user' };
  audit.add({ type: 'created', actor: boss, target: alice });
  audit.add({ type: 'created', actor: alice, target: carl });
  audit.add({ type: 'discord_linked', target: boss });
  assert.equal(audit.list({ viewer: 'founder' }).length, 3);
  const asAdmin = audit.list({ viewer: 'admin' });
  assert.equal(asAdmin.length, 2, 'entries about the founder are hidden');
  assert.equal(asAdmin.find((e) => e.target.username === 'alice').actor.username, 'Founder', 'founder name is masked');
});

test('founder settings validate input and never expose secrets; webhook text matches the spec', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = createFounderStore(path.join(dir, 'f.json'));
  assert.equal(f.discordConfigured(), false);
  assert.throws(() => f.update({ discord: { clientId: 'abc' } }), /numeric/);
  assert.throws(() => f.update({ discord: { publicUrl: 'http://evil.com' } }), /https/);
  f.update({ discord: { clientId: '123456789012345678', clientSecret: 'super-secret-value', publicUrl: 'https://meltrovia.com/anything' } });
  assert.equal(f.redirectUri(), 'https://meltrovia.com/auth/discord/callback');
  assert.equal(f.discordConfigured(), true);
  assert.equal(JSON.stringify(f.publicView()).includes('super-secret-value'), false);
  assert.equal(fs.statSync(path.join(dir, 'f.json')).mode & 0o077, 0, 'file is private');
  assert.throws(() => f.update({ accountWebhook: { enabled: true } }), /no URL/);
  assert.throws(() => f.update({ accountWebhook: { url: 'http://discord.com/api/webhooks/1/x' } }), /https/);
  f.update({ accountWebhook: { enabled: true, url: 'https://discord.com/api/webhooks/1/abcd', events: { renamed: false } } });

  const boss = { username: 'Boss', role: 'founder' }, alice = { username: 'alice', role: 'admin' }, carl = { username: 'carl', role: 'user' };
  const sent = [];
  const send = async (url, body) => sent.push(body);
  await notifyAccountEvent(f, { type: 'created', actor: boss, target: carl, expiresAt: Date.now() + 30 * DAY, at: Date.now() }, { send });
  await notifyAccountEvent(f, { type: 'deleted', actor: alice, target: carl }, { send });
  await notifyAccountEvent(f, { type: 'renamed', actor: alice, target: carl, from: 'a', to: 'b' }, { send });
  assert.equal(sent.length, 2, 'disabled event types are not sent');
  assert.match(sent[0].embeds[0].description, /^Founder @Boss created account carl$/);
  assert.equal(sent[0].embeds[0].fields[0].value, '30 days', 'membership length is included');
  assert.match(sent[1].embeds[0].description, /^Admin @alice deleted account carl$/);
  assert.deepEqual(sent[0].allowed_mentions, { parse: [] });
  assert.match(buildAccountPayload({ type: 'created', actor: boss, target: carl, expiresAt: null }, 'https://discord.com/x').embeds[0].fields[0].value, /permanent/);
});
