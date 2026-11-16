// Feature tests: PIN lock, key rotation, QR code, setup help text, and syncing a big backlog.
// Starts its own server (so it has its own rate-limit buckets). Run: node test/features.mjs
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { newFamilyKey, deriveVault, recordId, randomRecordId } from '../public/vault.js';
import { Budget, valLabel, valPayload, catPayload, helpFor, HELP, DEFAULT_CATEGORIES } from '../public/model.js';
import { SyncClient } from '../public/sync.js';
import { wrapKey, unwrapKey, validPin } from '../public/lock.js';
import { migrateTo } from '../public/rotate.js';
import { makeQr } from '../public/qr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../server/server.js');
const PUBLIC = path.resolve(here, '../public');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avf-feat-'));
const DATA = path.join(tmp, 'rooms.json');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const MONTH = '2026-11';

let srv = null;
let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch { /* keep trying */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) {
    failures.push(name);
    const where = (e.stack || '').split('\n').find((l) => l.includes('features.mjs')) ?? '';
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}\n        ${where.trim()}`);
  }
}

async function startServer() {
  srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE: DATA, CREATE_BURST: '50' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 5000, 'server start');
}
const memStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), del: (k) => m.delete(k), clearAll: () => m.clear() };
};
async function phone(key, { creator = false, st = memStore(), base = BASE, live = true } = {}) {
  const vault = await deriveVault(key);
  const budget = new Budget();
  const p = { key, vault, budget, st, status: 'connecting' };
  p.sync = new SyncClient({
    vault, creator, baseUrl: base, store: st, live,
    onRecord: (rid, payload, seq) => budget.apply(rid, payload, seq),
    onStatus: (s) => { p.status = s; },
    onReset: () => budget.resetSeqs(),
  });
  budget.isHeld = (rid) => p.sync.hasPending(rid);
  await p.sync.start();
  return p;
}
async function addCat(p, name, kind, order, deleted = false) {
  const id = randomRecordId();
  const payload = catPayload(name, kind, order, deleted);
  p.budget.apply(id, payload);
  await p.sync.put(id, payload);
  return id;
}
async function setVal(p, cat, field, cents, month = MONTH) {
  const rid = await recordId(p.vault, valLabel(cat, month, field));
  const payload = valPayload(cat, month, field, cents);
  p.budget.apply(rid, payload);
  await p.sync.put(rid, payload);
}
const synced = (p) => p.status === 'online' && Object.keys(p.sync.outbox).length === 0;
const rawFor = (vault, pathname, opts = {}) =>
  fetch(`${BASE}/api/rooms/${vault.roomId}${pathname}`, { ...opts, headers: { Authorization: `Bearer ${vault.authToken}`, ...(opts.headers || {}) } });

/** A fresh family with a little data: 2 live categories, 1 removed category, a cleared value, two months. */
async function seedFamily() {
  const key = newFamilyKey();
  const P = await phone(key, { creator: true });
  const pay = await addCat(P, 'Paycheck', 'i', 0);
  const food = await addCat(P, 'Groceries', 'e', 0);
  const old = await addCat(P, 'Old thing', 'e', 1);
  await setVal(P, pay, 'p', 520000);
  await setVal(P, food, 'p', 80000);
  await setVal(P, food, 'a', 12345);
  await setVal(P, food, 'p', 90000, '2026-10');
  await setVal(P, food, 'a', 7777, '2026-10');
  await setVal(P, food, 'a', null, '2026-10'); // cleared
  await setVal(P, old, 'p', 5000);
  const removed = catPayload('Old thing', 'e', 1, true);
  P.budget.apply(old, removed);
  await P.sync.put(old, removed);
  await waitFor(() => synced(P), 8000, 'seed to sync');
  return P;
}

console.log('Ammon Family Values - feature tests\n');

// ---------------------------------------------------------------- PIN lock
await step('PIN lock: right PIN opens the key, wrong PIN and tampering do not, nothing readable is stored', async () => {
  const key = newFamilyKey();
  const w = await wrapKey('4821', key, 2000); // fewer rounds just to keep the test quick
  assert.equal(await unwrapKey('4821', w), key);
  assert.equal(await unwrapKey('4822', w), null);
  assert.equal(await unwrapKey('', w), null);
  const text = JSON.stringify(w);
  assert.equal(text.includes(key), false);
  const long = JSON.stringify(await wrapKey('a-long-pin-that-would-be-obvious-if-stored', key, 2000)); // letters, so a chance match is impossible
  assert.equal(long.includes('a-long-pin'), false);
  assert.deepEqual(Object.keys(w).sort(), ['ct', 'iter', 'iv', 'salt', 'v']);
  const w2 = await wrapKey('4821', key, 2000);
  assert.notEqual(w.ct, w2.ct); // random salt and iv every time
  assert.notEqual(w.salt, w2.salt);
  const flipped = { ...w, ct: (w.ct[0] === 'A' ? 'B' : 'A') + w.ct.slice(1) };
  assert.equal(await unwrapKey('4821', flipped), null);
  assert.equal(await unwrapKey('4821', { ...w, iter: 1999 }), null); // changing the work factor breaks it
  assert.equal(await unwrapKey('4821', {}), null); // garbage never throws
  for (const ok of ['1234', '12345678', '0000']) assert.equal(validPin(ok), true);
  for (const bad of ['123', '123456789', 'abcd', '12 34', '', '12.5', '１２３４']) assert.equal(validPin(bad), false, bad);
});

await step('PIN lock: the real work factor takes noticeable time per guess', async () => {
  const t0 = Date.now();
  const w = await wrapKey('1234', newFamilyKey()); // default 250,000 rounds
  await unwrapKey('0000', w);
  const ms = Date.now() - t0;
  assert.equal(w.iter, 250000);
  console.log(`        (one wrap plus one wrong guess: ${ms} ms)`);
  assert.ok(ms > 20, 'expected the key stretching to cost something');
});

// ---------------------------------------------------------------- setup help text
await step('setup help: every starter item explains itself, in plain words', async () => {
  for (const name of [...DEFAULT_CATEGORIES.i, ...DEFAULT_CATEGORIES.e]) {
    const kind = DEFAULT_CATEGORIES.i.includes(name) ? 'i' : 'e';
    assert.ok(HELP[name.toLowerCase()], `no help text for "${name}"`);
    for (const field of ['p', 'a']) {
      const h = helpFor(name, kind, field);
      for (const k of ['ask', 'what', 'stage', 'note']) assert.ok(typeof h[k] === 'string' && h[k].length > 10, `${name}/${field}/${k}`);
    }
  }
  assert.match(helpFor('Paycheck', 'i', 'p').ask, /^Net income/);
  assert.match(helpFor('  paycheck ', 'i', 'a').ask, /^Net income/); // case and spaces do not matter
  assert.match(helpFor('Paycheck', 'i', 'p').stage, /plan/);
  assert.match(helpFor('Paycheck', 'i', 'a').stage, /actually happened/);
});

await step('setup help: items you add yourself still get a clear question', async () => {
  const inc = helpFor('Side job', 'i', 'p');
  assert.match(inc.ask, /Net income from "Side job"/);
  assert.match(inc.what, /take-home \(net\)/);
  const exp = helpFor('Pet care', 'e', 'a');
  assert.match(exp.ask, /spending on "Pet care"/);
});

// ---------------------------------------------------------------- QR code
await step('QR code: valid structure at every size (decoding was also checked with a real scanner library)', async () => {
  for (const len of [1, 20, 60, 100, 150, 213]) {
    const q = makeQr('x'.repeat(len));
    assert.equal(q.size, q.version * 4 + 17);
    assert.equal(q.modules.length, q.size);
    for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          assert.equal(q.modules[oy + dy][ox + dx], edge || core ? 1 : 0, `finder at ${ox},${oy}`);
        }
      }
    }
    for (let i = 8; i < q.size - 8; i++) {
      assert.equal(q.modules[6][i], i % 2 === 0 ? 1 : 0);
      assert.equal(q.modules[i][6], i % 2 === 0 ? 1 : 0);
    }
    assert.equal(q.modules[q.size - 8][8], 1); // the fixed dark module
  }
  assert.throws(() => makeQr('x'.repeat(214)), /too long/);
  assert.deepEqual(makeQr('same').modules, makeQr('same').modules);
  const typical = `https://ammon-family-values.onrender.com/#k=${newFamilyKey()}`;
  assert.equal(makeQr(typical).version <= 7, true, `a typical invite link should stay small (got version ${makeQr(typical).version})`);
});

// ---------------------------------------------------------------- key rotation
await startServer();

await step('offline shell: every script the app loads is in the service worker cache list, and every listed file is served', async () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const needed = new Set(['/app.js']);
  for (const f of fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.js') && n !== 'sw.js')) {
    for (const m of fs.readFileSync(path.join(PUBLIC, f), 'utf8').matchAll(/from '\.\/([\w-]+\.js)'/g)) needed.add(`/${m[1]}`);
  }
  for (const m of fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').matchAll(/(?:href|src)="(\/[^"]+)"/g)) needed.add(m[1]);
  for (const f of needed) assert.ok(shell.includes(f), `${f} is loaded by the app but missing from the offline cache list`);
  for (const f of shell) assert.equal((await fetch(BASE + f)).status, 200, `${f} is listed but not served`);
  assert.match(sw, /const CACHE = 'ammon-family-values-v\d+'/);
});

await step('new key: the budget moves, the old key is locked out, the new key sees the same numbers', async () => {
  const A = await seedFamily();
  const B = await phone(A.key); // a second phone, still on the old key
  await waitFor(() => B.budget.categories('e').length === 1 && B.budget.get(B.budget.categories('e')[0].id, MONTH, 'a') === 12345, 6000, 'B to load');
  const oldIds = new Set((await (await rawFor(A.vault, '/records?since=0')).json()).records.map((r) => r.rid));
  assert.ok(oldIds.size >= 8);

  const newKey = newFamilyKey();
  const progress = [];
  const moved = await migrateTo({ budget: A.budget, oldSync: A.sync, newKey, baseUrl: BASE, onProgress: (d, t) => progress.push([d, t]) });
  const nv = await deriveVault(newKey);
  assert.equal(moved.vault.roomId, nv.roomId);
  assert.ok(progress.length > 0 && progress.at(-1)[0] === progress.at(-1)[1], 'progress should end complete');

  // The old key no longer works for anyone, and a phone that was connected is told so.
  await waitFor(() => B.status === 'deleted', 8000, 'the other phone to be told the old budget is gone');
  assert.equal((await rawFor(A.vault, '/records')).status, 410);
  assert.equal(A.sync.running, false); // the old connection was stopped, not left running

  // A phone with the new key sees the same numbers (removed items are left behind).
  const C = await phone(newKey);
  await waitFor(() => C.budget.categories('e').length === 1, 6000, 'new-key phone to load');
  assert.deepEqual(C.budget.categories('i').map((c) => c.name), ['Paycheck']);
  assert.deepEqual(C.budget.categories('e').map((c) => c.name), ['Groceries']);
  assert.deepEqual(C.budget.totals(MONTH), A.budget.totals(MONTH));
  assert.deepEqual(C.budget.totals('2026-10'), A.budget.totals('2026-10'));
  assert.equal([...C.budget.cats.values()].some((c) => c.name === 'Old thing'), false);

  // Record ids are fresh, so the new room cannot be linked to the old one.
  const newIds = (await (await rawFor(nv, '/records?since=0')).json()).records.map((r) => r.rid);
  assert.equal(newIds.length, 6); // 2 items + 4 amounts (the removed item and the cleared amount are not copied)
  assert.equal(newIds.some((id) => oldIds.has(id)), false);

  // The server still only holds ciphertext.
  await sleep(800);
  const text = fs.readFileSync(DATA, 'utf8');
  for (const needle of ['Groceries', 'Paycheck', newKey, A.key, nv.authToken, '12345']) assert.equal(text.includes(needle), false, `server file leaks "${needle}"`);

  // The cache handed back lets this phone open the new budget with no network at all.
  const st = memStore();
  st.set('fb.cache', moved.cacheJson);
  st.set('fb.known', '1');
  const offline = await phone(newKey, { st, base: 'http://127.0.0.1:1' });
  assert.deepEqual(offline.budget.totals(MONTH), A.budget.totals(MONTH));
  for (const p of [offline, C, B]) p.sync.stop();
});

await step('new key: if the server cannot be reached nothing changes, and the old budget keeps working', async () => {
  const A = await seedFamily();
  await assert.rejects(
    migrateTo({ budget: A.budget, oldSync: A.sync, newKey: newFamilyKey(), baseUrl: 'http://127.0.0.1:1' }),
    /could not be reached/,
  );
  assert.equal(A.sync.running, true); // never touched
  assert.equal((await rawFor(A.vault, '/records')).status, 200);
  await setVal(A, [...A.budget.cats.keys()][0], 'p', 1);
  await waitFor(() => synced(A), 6000, 'old budget to keep syncing');
  A.sync.stop();
});

await step('new key: if deleting the old budget fails, the half-made copy is removed and the old budget is intact', async () => {
  const A = await seedFamily();
  const real = A.sync.deleteRoom.bind(A.sync);
  A.sync.deleteRoom = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
  const newKey = newFamilyKey();
  await assert.rejects(migrateTo({ budget: A.budget, oldSync: A.sync, newKey, baseUrl: BASE }), /boom/);
  const nv = await deriveVault(newKey);
  assert.equal((await rawFor(nv, '/records')).status, 410); // the copy was cleaned up
  A.sync.deleteRoom = real;
  assert.equal((await rawFor(A.vault, '/records')).status, 200); // old budget untouched
  assert.equal(A.sync.running, false); // the caller (the app) restarts the old connection
});

await step('new key: a lost reply to the delete is recognised as success, not rolled back', async () => {
  const A = await seedFamily();
  const real = A.sync.deleteRoom.bind(A.sync);
  let calls = 0;
  A.sync.deleteRoom = async () => {
    calls++;
    await real(); // the server really deletes it...
    if (calls === 1) throw new Error('network dropped before the reply arrived'); // ...but we never hear back
  };
  const newKey = newFamilyKey();
  await migrateTo({ budget: A.budget, oldSync: A.sync, newKey, baseUrl: BASE });
  assert.equal(calls >= 2, true);
  const nv = await deriveVault(newKey);
  assert.equal((await rawFor(nv, '/records')).status, 200); // the new budget stands
  assert.equal((await rawFor(A.vault, '/records')).status, 410);
});

// ---------------------------------------------------------------- on-demand sync
await step('on-demand mode holds no connection: it syncs on open, on each save and on wake-up only', async () => {
  const key = newFamilyKey();
  const A = await phone(key, { creator: true, live: false });
  const cat = await addCat(A, 'Quiet', 'e', 0);
  await setVal(A, cat, 'a', 100, MONTH);
  await waitFor(() => A.status === 'idle' && Object.keys(A.sync.outbox).length === 0, 6000, 'A to sync and go idle');
  assert.equal(A.sync.ctrl, null); // no event stream is open
  const B = await phone(key); // a live phone, to see what reaches the server
  await waitFor(() => B.budget.get(cat, MONTH, 'a') === 100, 6000, 'the save to have reached the server');
  await setVal(B, cat, 'p', 5000, MONTH);
  await waitFor(() => synced(B), 6000, 'B to save');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(A.budget.get(cat, MONTH, 'p') ?? 0, 0); // A is disconnected, so it has not heard yet
  assert.equal(A.status, 'idle');
  await setVal(A, cat, 'a', 250, MONTH); // a save makes one sync: sends this and fetches B's change
  await waitFor(() => A.budget.get(cat, MONTH, 'p') === 5000 && A.status === 'idle', 6000, 'A to pick up B on its own save');
  await waitFor(() => B.budget.get(cat, MONTH, 'a') === 250, 6000, "A's save to reach B");
  await setVal(B, cat, 'p', 6000, MONTH);
  await waitFor(() => synced(B), 6000, 'B to save again');
  A.sync.lastData = 0; // as if the app had been in the background for a while
  A.sync.kickIfStale(); // what the app does when it comes back to the front
  await waitFor(() => A.budget.get(cat, MONTH, 'p') === 6000 && A.status === 'idle', 6000, 'A to refresh on wake-up');
  assert.equal(A.sync.ctrl, null);
  A.sync.stop();
  B.sync.stop();
});

// ---------------------------------------------------------------- big backlog
await step('a big offline backlog (150 edits) syncs through the rate limit without reconnect storms', async () => {
  const key = newFamilyKey();
  const P = await phone(key, { creator: true });
  const cat = await addCat(P, 'Backlog', 'e', 0);
  await waitFor(() => synced(P), 6000, 'start');
  P.sync.stop();
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) await setVal(P, cat, 'a', 100 + i, `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  assert.equal(Object.keys(P.sync.outbox).length, 150);
  const P2 = await phone(key, { st: P.st }); // the app is reopened with those edits still queued
  await waitFor(() => Object.keys(P2.sync.outbox).length === 0, 60000, 'the backlog to drain');
  let n = 0;
  await waitFor(async () => { // the burst allowance is spent by now, so this check may need a moment too
    const r = await rawFor(P2.vault, '/records?since=0');
    if (!r.ok) return false;
    n = (await r.json()).records.length;
    return true;
  }, 15000, 'a successful check of the server');
  assert.equal(n, 151);
  console.log(`        (150 queued edits delivered in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  P2.sync.stop();
});

srv.kill('SIGTERM');
await once(srv, 'exit');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
