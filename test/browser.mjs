// Phone-size browser run of the whole app: two separate "phones" set up, play the puzzles, and swap budget files.
// Optional. Needs Playwright (npm i -D playwright) and Chrome. Run: node test/browser.mjs
// Set CHROME to the browser's path if it is not found, and SHOTS to a folder to keep screenshots.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const SHOTS = process.env.SHOTS || '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'afv-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const BASE = '/ammon-family-values/'; // served from a sub-folder, the way GitHub Pages does it
const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(BASE)) return res.writeHead(404).end();
  const file = path.join(DOCS, path.normalize(url.pathname.slice(BASE.length) || 'index.html'));
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(fs.readFileSync(file));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const URL0 = `http://localhost:${srv.address().port}${BASE}`;
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: 'chrome' }), args: ['--no-sandbox'] });
const requests = [];
const errors = [];
let passed = 0;
const ok = (name) => { passed++; console.log('  PASS ', name); };

async function newPhone(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  page.on('dialog', (d) => d.accept());
  return { ctx, page, name };
}
const shot = (p, n) => (SHOTS ? p.page.screenshot({ path: path.join(SHOTS, `${n}.png`) }) : null);
async function noOverflow(p, where) {
  const o = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, wide: [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && e.offsetParent !== null && r.right > window.innerWidth + 1; }).slice(0, 3).map((e) => e.className || e.id || e.tagName) }));
  assert.ok(o.sw <= o.iw + 1 && o.wide.length === 0, `sideways overflow on ${where}: ${JSON.stringify(o)}`);
}

async function solveGame(p) {
  const page = p.page;
  const kind = await page.locator('#wiz-body .game, #game-host .game').first().getAttribute('data-game');
  const root = page.locator(`.game[data-game="${kind}"]`);
  if (kind === 'sudoku') {
    const grid = await root.locator('.sudoku .sq').evaluateAll((els) => els.map((e) => Number(e.textContent) || 0));
    const g = [0, 1, 2, 3].map((r) => grid.slice(r * 4, r * 4 + 4));
    const okAt = (r, c, v) => { for (let i = 0; i < 4; i++) { if (g[r][i] === v || g[i][c] === v) return false; } const br = r - (r % 2), bc = c - (c % 2); for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) if (g[br + i][bc + j] === v) return false; return true; };
    const solve = () => { for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { if (g[r][c]) continue; for (let v = 1; v <= 4; v++) { if (okAt(r, c, v)) { g[r][c] = v; if (solve()) return true; g[r][c] = 0; } } return false; } return true; };
    assert.ok(solve());
    // first make a deliberate mistake to see the red warning
    const firstEmpty = grid.findIndex((v) => !v);
    const r0 = firstEmpty >> 2;
    const wrong = [1, 2, 3, 4].find((v) => grid.slice(r0 * 4, r0 * 4 + 4).includes(v));
    await root.locator('.sudoku .sq').nth(firstEmpty).click();
    await root.locator('.keys .key', { hasText: String(wrong) }).first().click();
    assert.ok((await root.locator('.sq.bad').count()) >= 1, 'no red square after a wrong number');
    assert.match(await root.locator('.game-status').textContent(), /repeated/);
    for (let i = 0; i < 16; i++) {
      if (grid[i]) continue;
      await root.locator('.sudoku .sq').nth(i).click();
      await root.locator('.keys .key', { hasText: String(g[i >> 2][i & 3]) }).first().click();
    }
  } else if (kind === 'scramble') {
    const tiles = await root.locator('.tiles .tile').evaluateAll((els) => els.map((e) => e.textContent));
    const word = await page.evaluate(async (t) => { const m = await import('./puzzles.js'); return m.SCRAMBLE_WORDS.map((w) => w[0]).find((w) => w.split('').sort().join('') === [...t].sort().join('')); }, tiles);
    assert.ok(word, 'scramble word not in list');
    // wrong first: tap tiles in the order shown (it is scrambled, so it is wrong)
    for (let i = 0; i < tiles.length; i++) await root.locator('.tiles .tile').nth(i).click();
    assert.match(await root.locator('.game-status').textContent(), /Not quite/);
    await root.locator('.chip', { hasText: 'Start over' }).click();
    const used = new Set();
    for (const ch of word) {
      const i = tiles.findIndex((t, k) => t === ch && !used.has(k));
      used.add(i);
      await root.locator('.tiles .tile').nth(i).click();
    }
  } else {
    const clues = await root.locator('.clues li').evaluateAll((els) => els.map((e) => e.textContent));
    const cells = await page.evaluate(async (clueText) => { const m = await import('./puzzles.js'); const words = m.CROSSWORDS.find((ws) => ws.every((w) => clueText.some((c) => c.includes(w.clue)))); const x = m.layCrossword(words); return [...x.cells.entries()].sort((a, b) => { const [ar, ac] = a[0].split(',').map(Number); const [br, bc] = b[0].split(',').map(Number); return ar - br || ac - bc; }).map((e) => e[1]); }, clues);
    const sq = root.locator('.xword .sq');
    assert.equal(await sq.count(), cells.length);
    for (let i = 0; i < cells.length; i++) {
      await sq.nth(i).click();
      await root.locator('.keys .key', { hasText: new RegExp(`^${cells[i]}$`) }).click();
    }
  }
  await root.locator('.game-win').waitFor();
  return kind;
}

async function answer(p, amount) {
  await p.page.locator('#wiz-body .wiz-input').fill(String(amount));
  await p.page.locator('#wiz-body button', { hasText: /^Next$/ }).click();
}
async function saveExport(p, firstPassword) {
  await p.page.click('#btn-menu');
  await p.page.click('#m-export');
  if (firstPassword) {
    await p.page.locator('#dlg-pw[open]').waitFor();
    await p.page.fill('#pw-input', 'short');
    await p.page.click('#pw-go');
    assert.match(await p.page.textContent('#pw-error'), /at least 8/);
    await p.page.fill('#pw-input', firstPassword);
    await p.page.click('#pw-go');
  }
  await p.page.locator('#dlg-export[open]').waitFor({ timeout: 20000 });
  const [dl] = await Promise.all([p.page.waitForEvent('download'), p.page.click('#ex-save')]);
  const file = path.join(TMP, `${p.name}-${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  return { file, name: dl.suggestedFilename() };
}
const heroLeft = (p) => p.page.textContent('#sum-left');
const spent = (p, name) => p.page.locator('.item', { has: p.page.locator('.name-text', { hasText: new RegExp(`^${name}$`) }) }).locator('input.amt').nth(1).inputValue();
async function addSpending(p, name, amt) {
  await p.page.locator('.item', { has: p.page.locator('.name-text', { hasText: new RegExp(`^${name}$`) }) }).locator('.quick').click();
  await p.page.fill('#add-amt', String(amt));
  await p.page.click('#add-go');
  await p.page.locator('#dlg-add[open]').waitFor({ state: 'detached' }).catch(() => {});
  await p.page.waitForTimeout(150);
}

try {
  /* ---------------- phone A: set up with puzzles ---------------- */
  const A = await newPhone('A');
  await A.page.goto(URL0);
  await A.page.evaluate(() => localStorage.setItem('fb.gameN', '0'));
  await A.page.locator('#welcome:not([hidden])').waitFor();
  await noOverflow(A, 'welcome');
  await shot(A, '01-welcome');
  await A.page.click('#btn-new');
  await A.page.locator('#wizard:not([hidden])').waitFor();
  assert.match(await A.page.textContent('#wiz-body'), /quick puzzle/);
  await shot(A, '02-setup-intro');
  await A.page.click('text=Let\'s go');
  ok('welcome screen and guided setup open');

  const kinds = [];
  const amounts = [4000, 250, 1500];
  for (let i = 0; i < 3; i++) {
    await answer(A, amounts[i]);
    await A.page.locator('#wiz-body .game').waitFor();
    assert.equal(await A.page.textContent('#wiz-step'), 'Puzzle break');
    await noOverflow(A, `game ${i}`);
    await shot(A, `03-game-${i}-start`);
    kinds.push(await solveGame(A));
    await noOverflow(A, `game ${i} solved`);
    await A.page.waitForTimeout(450);
    await shot(A, `03-game-${i}-solved`);
    assert.match(await A.page.textContent('.game-win'), new RegExp(`Puzzles solved: ${i + 1}`));
    await A.page.click('.game-next');
    await A.page.locator('#wiz-body .wiz-input').waitFor();
  }
  assert.deepEqual(kinds, ['sudoku', 'scramble', 'crossword']);
  ok('each answered question is followed by a puzzle: sudoku, word scramble, crossword, all solvable by tapping');

  // skipping a question gives no puzzle; answering then skipping the puzzle moves on
  const q4 = await A.page.textContent('#wiz-body .wiz-title');
  await A.page.locator('#wiz-body button', { hasText: /^Skip$/ }).click();
  assert.equal(await A.page.locator('#wiz-body .game').count(), 0);
  assert.notEqual(await A.page.textContent('#wiz-body .wiz-title'), q4);
  await answer(A, 600); // Groceries
  await A.page.locator('#wiz-body .game').waitFor();
  await A.page.click('.game-skip');
  await A.page.locator('#wiz-body .wiz-input').waitFor();
  ok('a skipped question has no puzzle, and a puzzle can be skipped');

  // puzzles off: straight to the next question
  await A.page.evaluate(() => localStorage.setItem('fb.games', 'off'));
  await answer(A, 300);
  await A.page.waitForTimeout(100);
  assert.equal(await A.page.locator('#wiz-body .game').count(), 0);
  await A.page.evaluate(() => localStorage.setItem('fb.games', 'on'));
  ok('with puzzles turned off, setup goes straight on');

  for (let i = 0; i < 30 && (await A.page.locator('#wiz-body .wiz-input').count()); i++) await A.page.locator('#wiz-body button', { hasText: /^Skip$/ }).click();
  await A.page.click("text=No, that's everything");
  await A.page.click('text=Not now');
  assert.match(await A.page.textContent('#wiz-body'), /Puzzles solved so far: 3/);
  await noOverflow(A, 'setup done');
  await shot(A, '04-setup-done');
  await A.page.click('text=Open my budget');
  await A.page.locator('#budget:not([hidden])').waitFor();
  assert.match(await A.page.textContent('#status-text'), /only on this phone/);
  await noOverflow(A, 'budget');
  await addSpending(A, 'Groceries', '82.50');
  assert.equal(await spent(A, 'Groceries'), '82.50');
  await shot(A, '05-budget');
  await A.page.reload();
  await A.page.locator('#budget:not([hidden])').waitFor();
  assert.equal(await spent(A, 'Groceries'), '82.50');
  ok('budget screen works and survives a reload');

  /* ---------------- A sends, B opens ---------------- */
  const PW = 'purple river toast';
  const first = await saveExport(A, PW);
  assert.match(first.name, /^ammon-budget-\d{4}-\d\d-\d\d\.txt$/);
  const text1 = fs.readFileSync(first.file, 'utf8');
  for (const leak of ['Groceries', 'Paycheck', '8250', '400000']) assert.ok(!text1.includes(leak), `file shows ${leak}`);
  await noOverflow(A, 'export dialog');
  await shot(A, '06-send');
  await A.page.click('#ex-close');
  ok('"Send my budget" asks for a sharing password once and makes a locked file');

  const B = await newPhone('B');
  await B.page.goto(URL0);
  await B.page.click('#btn-open');
  await B.page.locator('#dlg-import[open]').waitFor();
  await noOverflow(B, 'import dialog');
  await shot(B, '07-open-file');
  // a file that is not a budget
  const notes = path.join(TMP, 'notes.txt');
  fs.writeFileSync(notes, 'grocery list: eggs');
  await B.page.setInputFiles('#im-file', notes);
  await B.page.locator('#im-error:not([hidden])').waitFor();
  await B.page.setInputFiles('#im-file', first.file);
  await B.page.locator('#dlg-pw[open]').waitFor();
  await B.page.fill('#pw-input', 'wrong password here');
  await B.page.click('#pw-go');
  await B.page.locator('#pw-error:not([hidden])').waitFor({ timeout: 20000 });
  assert.match(await B.page.textContent('#pw-error'), /did not open/);
  await B.page.fill('#pw-input', 'Purple River Toast');
  await B.page.click('#pw-go');
  await B.page.locator('#budget:not([hidden])').waitFor({ timeout: 20000 });
  await B.page.waitForTimeout(300);
  assert.equal(await heroLeft(B), await heroLeft(A));
  assert.equal(await spent(B, 'Groceries'), '82.50');
  assert.equal(await B.page.locator('#wizard:not([hidden])').count(), 0);
  ok('a second phone opens the file (wrong password and wrong file are refused) and shows the same budget');

  /* ---------------- B updates and sends back; A also changed something ---------------- */
  await addSpending(B, 'Groceries', '30');
  await B.page.locator('.item', { has: B.page.locator('.name-text', { hasText: /^Utilities$/ }) }).locator('input.amt').nth(1).fill('140');
  await B.page.locator('.item', { has: B.page.locator('.name-text', { hasText: /^Utilities$/ }) }).locator('input.amt').nth(1).blur();
  await B.page.locator('.add-btn[data-kind="e"]').click();
  await B.page.fill('#cat-name', 'Pet care');
  await B.page.click('#cat-form button[type=submit]');
  await B.page.waitForTimeout(200);
  await addSpending(A, 'Dining out', '25'); // A changes something B did not touch
  await addSpending(A, 'Groceries', '20'); // ...and something B also changed
  await B.page.waitForTimeout(50);
  await addSpending(B, 'Groceries', '5'); // B's Groceries is now the newest: 82.50+30+5 = 117.50
  const second = await saveExport(B, null); // no password question: B remembers it from opening the file
  await B.page.click('#ex-close');
  ok('the second phone sends an update without being asked for the password again');

  await A.page.click('#btn-menu');
  await noOverflow(A, 'menu');
  await shot(A, '08-menu');
  await A.page.click('#m-import');
  await A.page.setInputFiles('#im-file', second.file);
  await A.page.locator('#dlg-preview[open]').waitFor({ timeout: 20000 });
  const preview = await A.page.textContent('#dlg-preview');
  assert.match(preview, /3 changes/);
  assert.match(preview, /New item\s*Pet care/);
  assert.match(preview, /Groceries · Spent/);
  assert.match(preview, /\$102\.50 → \$117\.50/);
  assert.match(preview, /You changed this too/);
  assert.match(preview, /Utilities · Spent/);
  assert.ok(!/Dining out/.test(preview));
  assert.equal(await spent(A, 'Groceries'), '102.50'); // nothing applied yet
  await noOverflow(A, 'preview');
  await shot(A, '09-preview');
  await A.page.click('#pv-cancel');
  assert.equal(await spent(A, 'Groceries'), '102.50');
  // again, and accept this time (pasted as text, wrapped the way email does)
  await A.page.click('#btn-menu');
  await A.page.click('#m-import');
  await A.page.fill('#im-paste', `Here you go:\n${fs.readFileSync(second.file, 'utf8').replace(/(.{70})/g, '$1\n')}\nxo`);
  await A.page.click('#im-read');
  await A.page.locator('#dlg-preview[open]').waitFor({ timeout: 20000 });
  await A.page.click('#pv-go');
  await A.page.waitForTimeout(400);
  assert.equal(await spent(A, 'Groceries'), '117.50');
  assert.equal(await spent(A, 'Utilities'), '140');
  assert.equal(await spent(A, 'Dining out'), '25');
  assert.equal(await A.page.locator('.name-text', { hasText: /^Pet care$/ }).count(), 1);
  await A.page.reload();
  await A.page.locator('#budget:not([hidden])').waitFor();
  assert.equal(await spent(A, 'Groceries'), '117.50');
  // same file again: nothing to do
  await A.page.click('#btn-menu');
  await A.page.click('#m-import');
  await A.page.setInputFiles('#im-file', second.file);
  await A.page.locator('#toast.show').waitFor({ timeout: 20000 });
  assert.match(await A.page.textContent('#toast'), /already/i);
  assert.equal(await A.page.locator('#dlg-preview[open]').count(), 0);
  ok('bringing in an update shows a preview first (with the both-changed warning), Cancel changes nothing, Update applies it, and it sticks');

  /* ---------------- puzzles from the menu ---------------- */
  await A.page.click('#btn-menu');
  await A.page.click('#m-game');
  await A.page.locator('#dlg-game[open] .game').waitFor();
  const k1 = await solveGame(A);
  await shot(A, '10-menu-puzzle');
  await A.page.click('.game-next');
  await A.page.locator('#dlg-game[open] .game:not(.won)').waitFor();
  await solveGame(A);
  await A.page.click('#game-close');
  assert.ok(k1);
  ok('"Play a puzzle" in the menu works');

  /* ---------------- PIN lock, then offline ---------------- */
  await A.page.click('#btn-menu');
  await A.page.click('#m-lock');
  await A.page.fill('#pin-input', '4821');
  await A.page.fill('#pin-confirm', '4821');
  await A.page.click('#pin-go');
  await A.page.waitForTimeout(1500);
  assert.equal(await A.page.evaluate(() => localStorage.getItem('fb.key')), null);
  await A.page.evaluate(() => navigator.serviceWorker.ready);
  await A.page.waitForTimeout(800);
  await A.ctx.setOffline(true);
  await A.page.reload();
  await A.page.locator('#lock:not([hidden])').waitFor();
  await A.page.fill('#lock-pin', '1111');
  await A.page.click('#lock-go');
  await A.page.locator('#lock-error:not([hidden])').waitFor({ timeout: 15000 });
  await A.page.fill('#lock-pin', '4821');
  await A.page.click('#lock-go');
  await A.page.locator('#budget:not([hidden])').waitFor({ timeout: 15000 });
  assert.equal(await spent(A, 'Groceries'), '117.50');
  await addSpending(A, 'Fun', '12');
  const third = await saveExport(A, null); // sending still works with no internet and the lock on
  assert.ok(fs.readFileSync(third.file, 'utf8').includes('ammon-family-values'));
  await A.page.click('#ex-close');
  await A.ctx.setOffline(false);
  ok('PIN lock (wrong PIN refused), and everything including making a file works with the network off');

  /* ---------------- dark mode + extra large text layout ---------------- */
  const D = await newPhone('D', { colorScheme: 'dark', viewport: { width: 360, height: 740 } });
  await D.page.goto(URL0);
  await D.page.evaluate(() => { localStorage.setItem('fb.gameN', '0'); localStorage.setItem('fb.size', 'xl'); });
  await D.page.reload();
  await D.page.click('#btn-new');
  await D.page.click('text=Let\'s go');
  for (let i = 0; i < 3; i++) {
    await answer(D, 100 + i);
    await D.page.locator('#wiz-body .game').waitFor();
    await noOverflow(D, `dark xl game ${i}`);
    await shot(D, `11-dark-xl-game-${i}`);
    await solveGame(D);
    await D.page.click('.game-next');
  }
  ok('puzzles fit a small phone with extra-large text, in dark mode');

  /* ---------------- nothing left the phone ---------------- */
  const bad = requests.filter((r) => !r.url.startsWith(URL0) && !r.url.startsWith('blob:') || r.method !== 'GET');
  assert.deepEqual(bad, []);
  const files = new Set(requests.filter((r) => r.url.startsWith(URL0)).map((r) => r.url.slice(URL0.length).split('?')[0]));
  for (const f of files) assert.ok(/^(|index\.html|[a-z]+\.(js|css|webmanifest)|icons\/[a-z0-9-]+\.png)$/.test(f), `unexpected request: ${f}`);
  ok(`the only requests were for the app's own ${files.size} files (no data sent anywhere)`);
  assert.deepEqual(errors, []);
  ok('no errors in the browser console');
  console.log(`\n${passed} browser checks passed`);
} catch (e) {
  console.log('\nFAILED:', e.message);
  console.log(e.stack.split('\n').slice(1, 4).join('\n'));
  console.log('console errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
