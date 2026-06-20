// Account/profile editing: validation, whitelist (no mass assignment), backfill.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, account, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-account-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../db/db', '../account']) delete require.cache[require.resolve(m)];
  db = require('../db/db');
  account = require('../account');
  await db.runAsync('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT)');
  await account.applyAccountSchema(db);
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

beforeEach(async () => {
  await db.runAsync('DELETE FROM users');
  await db.runAsync(
    "INSERT INTO users (id, username, email, password, display_name) VALUES (1, 'handle1', 'a@b.com', 'orig', 'handle1')"
  );
});

test('applyAccountSchema backfills display_name from username', async () => {
  await db.runAsync("INSERT INTO users (id, username, email, password) VALUES (2, 'neo', 'n@x.com', 'p')");
  await account.applyAccountSchema(db);
  assert.equal((await account.getAccount(2)).display_name, 'neo');
});

test('updateAccount sets whitelisted fields', async () => {
  const { account: a } = await account.updateAccount(1, {
    display_name: 'Daigo', full_name: 'Daigo Umehara',
    favorite_game: 'Street Fighter 6', main_character: 'Guile',
  });
  assert.equal(a.display_name, 'Daigo');
  assert.equal(a.full_name, 'Daigo Umehara');
  assert.equal(a.favorite_game, 'Street Fighter 6');
  assert.equal(a.main_character, 'Guile');
});

test('display_name is required (rejects blank)', async () => {
  await assert.rejects(
    () => account.updateAccount(1, { display_name: '   ' }),
    (e) => e.code === 'VALIDATION' && e.field === 'display_name'
  );
});

test('blank optional field clears to NULL', async () => {
  await account.updateAccount(1, { display_name: 'Xen', bio: 'hi there' });
  assert.equal((await account.getAccount(1)).bio, 'hi there');
  await account.updateAccount(1, { display_name: 'Xen', bio: '' });
  assert.equal((await account.getAccount(1)).bio, null);
});

test('rejects over-long and too-short values', async () => {
  await assert.rejects(() => account.updateAccount(1, { display_name: 'a'.repeat(31) }), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => account.updateAccount(1, { display_name: 'a' }), (e) => e.code === 'VALIDATION'); // min 2
  await assert.rejects(() => account.updateAccount(1, { display_name: 'Xen', bio: 'b'.repeat(281) }), (e) => e.code === 'VALIDATION');
});

test('birthday validation: format, real date, not future', async () => {
  await assert.rejects(() => account.updateAccount(1, { display_name: 'Xen', birthday: 'not-a-date' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => account.updateAccount(1, { display_name: 'Xen', birthday: '2999-01-01' }), (e) => e.code === 'VALIDATION');
  const { account: a } = await account.updateAccount(1, { display_name: 'Xen', birthday: '1990-05-04' });
  assert.equal(a.birthday, '1990-05-04');
});

test('strips leading @ from social handles', async () => {
  const { account: a } = await account.updateAccount(1, { display_name: 'Xen', twitter: '@daigo', twitch: 'daigothebeast' });
  assert.equal(a.twitter, 'daigo');
  assert.equal(a.twitch, 'daigothebeast');
});

test('an all-@ handle clears to NULL (not empty string)', async () => {
  const { account: a } = await account.updateAccount(1, { display_name: 'Xen', twitch: '@@@', twitter: '@' });
  assert.equal(a.twitch, null);
  assert.equal(a.twitter, null);
});

test('rejects impossible calendar dates (Feb 30, Feb 29 in a non-leap year)', async () => {
  await assert.rejects(() => account.updateAccount(1, { display_name: 'Xen', birthday: '2026-02-30' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => account.updateAccount(1, { display_name: 'Xen', birthday: '2025-02-29' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(() => account.updateAccount(1, { display_name: 'Xen', birthday: '2026-04-31' }), (e) => e.code === 'VALIDATION');
});

test('ignores non-whitelisted fields (no mass assignment)', async () => {
  await account.updateAccount(1, { display_name: 'Xen', password: 'hacked', id: 999, username: 'newhandle', balance_cents: 999999 });
  const row = await db.getAsync('SELECT password, username FROM users WHERE id = 1');
  assert.equal(row.password, 'orig');    // password never writable
  assert.equal(row.username, 'handle1'); // login handle never writable
});

test('updateAccount on a missing user returns NOT_FOUND', async () => {
  assert.equal((await account.updateAccount(999, { display_name: 'Xen' })).error, 'NOT_FOUND');
});
