// End-to-end test: real server process + the real client modules (vault/model/sync), two simulated phones.
// Run: node test/e2e.mjs
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { newFamilyKey, deriveVault, recordId, randomRecordId, open } from '../public/vault.js';
import { Budget, valLabel, valPayload, catPayload, parseMoney, formatMoney, centsToInput } from '../public/model.js';
import { SyncClient } from '../public/sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../server/server.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avf-test-'));
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
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

async function startServer() {
  srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 5000, 'server start');
}
async function stopServer() {
  srv.kill('SIGTERM');
  await once(srv, 'exit');
}

function memStore() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), del: (k) => m.delete(k), clearAll: () => m.clear() };
}
async function phone(key, { creator = false, st = memStore() } = {}) {
  const vault = await deriveVault(key);
  const budget = new Budget();
  const p = { vault, budget, st, status: 'connecting' };
  p.sync = new SyncClient({
    vault, creator, baseUrl: BASE, store: st,
    onRecord: (rid, payload, seq) => budget.apply(rid, payload, seq),
    onStatus: (s) => { p.status = s; },
    onReset: () => budget.resetSeqs(),
  });
  budget.isHeld = (rid) => p.sync.hasPending(rid);
  await p.sync.start();
  return p;
}
async function addCat(p, name, kind, order) {
  const id = randomRecordId();
  const payload = catPayload(name, kind, order);
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
const raw = (p, pathname, opts = {}) =>
  fetch(`${BASE}/api/rooms/${p.vault.roomId}${pathname}`, { ...opts, headers: { Authorization: `Bearer ${p.vault.authToken}`, ...(opts.headers || {}) } });

console.log('Ammon Family Values - end-to-end tests\n');

// ---------------------------------------------------------------- pure logic
await step('money parsing and formatting', async () => {
  assert.deepEqual(parseMoney('$1,200.50'), { ok: true, cents: 120050 });
  assert.deepEqual(parseMoney('12,5'), { ok: true, cents: 1250 }); // decimal comma
  assert.deepEqual(parseMoney(''), { ok: true, cents: null });
  assert.equal(parseMoney('abc').ok, false);
  assert.equal(parseMoney('1.234').ok, false);
  assert.equal(parseMoney('1.15').cents, 115); // no float drift
  assert.equal(centsToInput(120050), '1200.50');
  assert.equal(centsToInput(45000), '450');
  assert.equal(formatMoney(120050, 'USD'), '$1,200.50');
});

await startServer();

// ---------------------------------------------------------------- two phones
const KEY = newFamilyKey();
let A, B, catGroceries, catPay;

await step('phone A creates the budget and seeds values', async () => {
  A = await phone(KEY, { creator: true });
  catPay = await addCat(A, 'Paycheck', 'i', 0);
  catGroceries = await addCat(A, 'Groceries', 'e', 0);
  await setVal(A, catPay, 'p', 520000);
  await setVal(A, catGroceries, 'p', 80000);
  await setVal(A, catGroceries, 'a', 12345);
  await waitFor(() => A.status === 'online' && Object.keys(A.sync.outbox).length === 0, 6000, 'A to sync');
});

await step('phone B joins with the key and sees the same numbers', async () => {
  B = await phone(KEY, { creator: false });
  await waitFor(() => B.budget.get(catGroceries, MONTH, 'a') === 12345, 6000, 'B to receive data');
  assert.deepEqual(B.budget.totals(MONTH), A.budget.totals(MONTH));
  assert.deepEqual(B.budget.categories('e').map((c) => c.name), ['Groceries']);
});

await step('live update: A edits, B sees it in under 2 seconds', async () => {
  const t0 = Date.now();
  await setVal(A, catGroceries, 'a', 20000);
  await waitFor(() => B.budget.get(catGroceries, MONTH, 'a') === 20000, 2000, 'live update');
  console.log(`        (arrived in ${Date.now() - t0} ms)`);
});

await step('concurrent edits to one field converge on the same value', async () => {
  await Promise.all([setVal(A, catGroceries, 'p', 90000), setVal(B, catGroceries, 'p', 95000)]);
  await waitFor(() => A.budget.get(catGroceries, MONTH, 'p') === B.budget.get(catGroceries, MONTH, 'p')
    && Object.keys(A.sync.outbox).length + Object.keys(B.sync.outbox).length === 0, 4000, 'convergence');
  assert.ok([90000, 95000].includes(A.budget.get(catGroceries, MONTH, 'p')));
});

await step('offline edits are queued, survive a restart, and sync on reconnect', async () => {
  const st = B.st;
  B.sync.stop();
  await sleep(100);
  await setVal(B, catGroceries, 'a', 31000); // offline: lands in the outbox
  assert.equal(Object.keys(B.sync.outbox).length > 0, true);
  const B2 = await phone(KEY, { st }); // "app restarted" with the same local storage
  assert.equal(B2.budget.get(catGroceries, MONTH, 'a'), 31000); // visible immediately from local copy
  await waitFor(() => A.budget.get(catGroceries, MONTH, 'a') === 31000, 6000, 'offline edit to reach A');
  B2.sync.stop();
  B = await phone(KEY, { st });
});

// ---------------------------------------------------------------- privacy / security
await step('server storage holds only ciphertext (no names, labels, amounts, key or token)', async () => {
  await sleep(800); // debounce flush
  const text = fs.readFileSync(DATA, 'utf8');
  for (const needle of ['Groceries', 'Paycheck', '2026', MONTH, KEY, A.vault.authToken, '12345', '520000']) {
    assert.equal(text.includes(needle), false, `server file leaks "${needle}"`);
  }
  const db = JSON.parse(text);
  const room = db.rooms[A.vault.roomId];
  assert.deepEqual(Object.keys(room).sort(), ['authHash', 'records', 'seq']);
  for (const r of Object.values(room.records)) assert.deepEqual(Object.keys(r).sort(), ['ct', 'iv', 'seq']);
  assert.ok(Object.keys(room.records).length >= 5);
});

await step('wrong or missing credentials are rejected', async () => {
  const other = await deriveVault(newFamilyKey());
  const bad = await fetch(`${BASE}/api/rooms/${A.vault.roomId}/records`, { headers: { Authorization: `Bearer ${other.authToken}` } });
  assert.equal(bad.status, 401);
  const none = await fetch(`${BASE}/api/rooms/${A.vault.roomId}/records`);
  assert.equal(none.status, 401);
  const unknown = await fetch(`${BASE}/api/rooms/${other.roomId}/records`, { headers: { Authorization: `Bearer ${other.authToken}` } });
  assert.equal(unknown.status, 404);
});

await step('a record cannot be swapped onto another field (AAD binding)', async () => {
  const { records } = await (await raw(A, '/records?since=0')).json();
  const [r1, r2] = records;
  await assert.rejects(open(A.vault, r1.rid, { ct: r2.ct, iv: r2.iv }));
  await open(A.vault, r1.rid, r1); // the genuine pairing still opens
});

await step('server validates input: oversize, bad base64, bad ids', async () => {
  const rid = randomRecordId();
  const big = await raw(A, `/records/${rid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ct: 'A'.repeat(5000), iv: 'A'.repeat(16) }) });
  assert.equal(big.status, 413);
  const badB64 = await raw(A, `/records/${rid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ct: 'not base64!!', iv: 'A'.repeat(16) }) });
  assert.equal(badB64.status, 400);
  const badId = await raw(A, '/records/zzzz', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(badId.status, 404);
  const traversal = await fetch(`${BASE}/..%2Fserver%2Fserver.js`);
  assert.notEqual(traversal.status, 200);
  const sec = await fetch(`${BASE}/`);
  assert.match(sec.headers.get('content-security-policy') ?? '', /default-src 'none'/);
});

await step('the app itself is served (html, js, manifest, icons)', async () => {
  for (const [p, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/manifest.webmanifest', 'manifest+json'], ['/icons/icon-512.png', 'image/png'], ['/sw.js', 'text/javascript']]) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 200, p);
    assert.ok(r.headers.get('content-type').includes(type), `${p}: ${r.headers.get('content-type')}`);
  }
});

// ---------------------------------------------------------------- resilience
await step('server restart: data persists and phones reconnect by themselves', async () => {
  await sleep(600);
  await stopServer();
  await startServer();
  await waitFor(() => A.status === 'online' && B.status === 'online', 20000, 'phones to reconnect');
  await setVal(A, catGroceries, 'a', 44400);
  await waitFor(() => B.budget.get(catGroceries, MONTH, 'a') === 44400, 6000, 'post-restart live update');
});

await step('server loses ALL data (free-host wipe): phones re-upload and a new phone still sees everything', async () => {
  await stopServer();
  fs.rmSync(DATA, { force: true });
  await startServer();
  await waitFor(() => A.status === 'online' && B.status === 'online', 25000, 'phones to reconnect to empty server');
  await waitFor(async () => {
    const r = await raw(A, '/records?since=0');
    return r.ok && (await r.json()).records.length >= 5;
  }, 10000, 'server to be repopulated');
  const D = await phone(KEY, { creator: false });
  await waitFor(() => D.budget.get(catGroceries, MONTH, 'a') === 44400, 8000, 'new phone to receive restored data');
  assert.deepEqual(D.budget.totals(MONTH), A.budget.totals(MONTH));
  D.sync.stop();
});

await step('delete-all wipes the server and signs out every phone', async () => {
  await A.sync.deleteRoom();
  await waitFor(() => B.status === 'deleted', 8000, 'B to learn the budget was deleted');
  const r = await raw(A, '/records');
  assert.equal(r.status, 410);
  const re = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: A.vault.roomId, authHash: A.vault.authHash }) });
  assert.equal(re.status, 410); // cannot be quietly re-created
  await sleep(700);
  assert.equal(fs.readFileSync(DATA, 'utf8').includes('"ct"'), false); // no encrypted records left either
});

await step('rate limiting kicks in under hammering', async () => {
  const fake = '0'.repeat(32);
  let limited = 0;
  for (let i = 0; i < 260; i++) {
    const r = await fetch(`${BASE}/api/rooms/${fake}/records`);
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0, 'expected at least one 429');
});

A.sync.stop();
B.sync.stop();
await stopServer();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
