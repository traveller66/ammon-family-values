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

// `installed: true` (the default) makes the page believe it was opened from the installed app's icon: the question
// "is this a browser tab?" is answered no, which is what Android answers for an installed app. Chrome's test tools
// cannot switch a page into real installed mode, so that one answer is simulated here. `installed: false` is a plain tab.
async function newPhone(name, { installed = true, ...opts } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  if (installed) {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*browser/.test(q) ? { matches: false, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
    });
  }
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

async function hintThrough(p) {
  for (let i = 0; i < 40 && !(await p.page.locator('.game-win').count()); i++) await p.page.locator('.game-hint').click();
  await p.page.locator('.game-win').waitFor();
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
  /* ---------------- a browser tab only gets the install page ---------------- */
  const T = await newPhone('tab', { installed: false });
  await T.page.goto(URL0);
  await T.page.locator('#install:not([hidden])').waitFor();
  assert.match(await T.page.textContent('#install'), /only installs the app/);
  for (const id of ['welcome', 'lock', 'budget']) assert.equal(await T.page.locator(`#${id}`).isVisible(), false, `${id} is showing in a browser tab`);
  assert.equal(await T.page.locator('#btn-new').isVisible(), false);
  await noOverflow(T, 'install page');
  await shot(T, '00-install-page');
  ok('opened in a browser tab, the address shows only the install page');

  /* ---------------- phone A: set up with puzzles ---------------- */
  const A = await newPhone('A');
  await A.page.goto(URL0);
  await A.page.evaluate(() => localStorage.setItem('fb.gameN', '0'));
  await A.page.locator('#welcome:not([hidden])').waitFor();
  await noOverflow(A, 'welcome');
  await shot(A, '01-welcome');
  await A.page.click('#btn-new');
  await A.page.locator('#wizard:not([hidden])').waitFor();
  assert.match(await A.page.textContent('#wiz-body'), /Solve it to move on/);
  await shot(A, '02-setup-intro');
  await A.page.click('text=Let\'s go');
  ok('welcome screen and guided setup open');

  // The explanation is on the screen for every question, with nothing to press.
  assert.ok(await A.page.locator('#wiz-body .ask').isVisible());
  assert.match(await A.page.textContent('#wiz-body .ask'), /Net income: the first paycheck, after taxes/);
  assert.match(await A.page.textContent('#wiz-body .help'), /not the bigger "gross" amount/);
  assert.equal(await A.page.locator('#wiz-body .info-btn').count(), 0);
  await noOverflow(A, 'first question');
  await shot(A, '02-first-question');

  // One small question at a time. Every answer must be followed by a solved puzzle.
  const plan = { 'Paycheck 1': 4000, 'Other income': 250, 'Rent or mortgage': 1500, Groceries: 600, 'Dining out': 300 };
  const asked = [];
  const kinds = [];
  for (let i = 0; i < 40 && (await A.page.locator('#wiz-body .wiz-input').count()); i++) {
    const title = await A.page.textContent('#wiz-body .wiz-title');
    const name = title.match(/“(.+)”/)[1];
    asked.push(name);
    assert.ok(await A.page.locator('#wiz-body .help').isVisible(), `no explanation showing for ${name}`);
    const moved = () => A.page.waitForFunction((t) => document.querySelector('#wiz-body .wiz-title')?.textContent !== t, title);
    if (name === 'Paycheck 2') {
      await A.page.locator('#wiz-body button', { hasText: "We don't have this one" }).click();
      await moved();
      continue;
    }
    if (!(name in plan)) {
      await A.page.locator('#wiz-body button', { hasText: /^Skip for now$/ }).click();
      await moved();
      assert.equal(await A.page.locator('#wiz-body .game').count(), 0); // no answer, no puzzle
      continue;
    }
    await answer(A, plan[name]);
    await A.page.locator('#wiz-body .game').waitFor();
    assert.equal(await A.page.textContent('#wiz-step'), 'Puzzle break');
    assert.equal(await A.page.locator('#wiz-body .game-skip').count(), 0, 'first-time setup must not offer a skip');
    assert.match(await A.page.textContent('#wiz-body .game-must'), /Solve this one to move on/);
    assert.equal(await A.page.locator('#wiz-body .wiz-input').count(), 0); // the next question is not reachable yet
    await noOverflow(A, `game ${kinds.length}`);
    if (kinds.length < 3) {
      await shot(A, `03-game-${kinds.length}-start`);
      kinds.push(await solveGame(A)); // solved by tapping, the way a person would
      await A.page.waitForTimeout(450);
      await shot(A, `03-game-${kinds.length - 1}-solved`);
    } else if (kinds.length === 3) {
      const before = await A.page.locator('#wiz-body .game').getAttribute('data-game');
      await A.page.click('.game-swap'); // stuck? a different puzzle, but still a puzzle
      assert.notEqual(await A.page.locator('#wiz-body .game').getAttribute('data-game'), before);
      assert.equal(await A.page.locator('#wiz-body .game-skip').count(), 0);
      await hintThrough(A);
      kinds.push('swapped');
    } else {
      await hintThrough(A); // hints alone can finish any puzzle, so nobody is locked out
      kinds.push('hints');
    }
    assert.match(await A.page.textContent('.game-win'), new RegExp(`Puzzles solved: ${kinds.length}`));
    await noOverflow(A, `game ${kinds.length} solved`);
    await A.page.click('.game-next');
    await A.page.locator('#wiz-body .game').waitFor({ state: 'detached' });
  }
  assert.deepEqual(kinds, ['sudoku', 'scramble', 'crossword', 'swapped', 'hints']);
  assert.deepEqual(asked.slice(0, 5), ['Paycheck 1', 'Paycheck 2', 'Other income', 'Rent or mortgage', 'Electricity']);
  assert.equal(asked.length, 15);
  ok('first-time setup: one small question at a time, the explanation always showing, and a puzzle that must be solved after every answer');
  ok('a question left blank has no puzzle; hints and "a different puzzle" get anyone unstuck without a skip');

  await A.page.click("text=No, that's everything");
  await A.page.click('text=Not now');
  assert.match(await A.page.textContent('#wiz-body'), /Puzzles solved so far: 5/);
  await noOverflow(A, 'setup done');
  await shot(A, '04-setup-done');
  await A.page.click('text=Open my budget');
  await A.page.locator('#budget:not([hidden])').waitFor();
  assert.match(await A.page.textContent('#status-text'), /only on this phone/);
  await noOverflow(A, 'budget');
  assert.equal(await A.page.locator('.name-text', { hasText: /^Paycheck 2$/ }).count(), 0); // "We don't have this one" removed it
  const card = A.page.locator('.item', { has: A.page.locator('.name-text', { hasText: /^Paycheck 1$/ }) });
  assert.equal(await card.locator('.help').isVisible(), false);
  await card.locator('.info-btn').click();
  assert.match(await card.locator('.help').textContent(), /Net income: the first paycheck, after taxes.*not the bigger "gross" amount.*"Expected" is your estimate/s);
  await noOverflow(A, 'item help');
  await shot(A, '05-item-help');
  await card.locator('.info-btn').click();
  ok('every item on the main screen has an (i) that explains what goes in it');

  // Setup run again later: puzzles are offered but never required.
  await A.page.click('#btn-menu');
  await A.page.click('#m-setup');
  assert.ok(await A.page.locator('#wiz-body .help').isVisible());
  await answer(A, 4100);
  await A.page.locator('#wiz-body .game').waitFor();
  assert.equal(await A.page.locator('#wiz-body .game-must').count(), 0);
  await A.page.click('.game-skip');
  await A.page.locator('#wiz-body .wiz-input').waitFor();
  await A.page.evaluate(() => localStorage.setItem('fb.games', 'off'));
  await answer(A, 260);
  await A.page.waitForTimeout(100);
  assert.equal(await A.page.locator('#wiz-body .game').count(), 0);
  await A.page.evaluate(() => localStorage.setItem('fb.games', 'on'));
  await A.page.click('#wiz-exit');
  ok('after first-time setup, puzzles can be skipped or turned off');

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
  await B.page.locator('.item', { has: B.page.locator('.name-text', { hasText: /^Electricity$/ }) }).locator('input.amt').nth(1).fill('140');
  await B.page.locator('.item', { has: B.page.locator('.name-text', { hasText: /^Electricity$/ }) }).locator('input.amt').nth(1).blur();
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
  assert.match(preview, /Electricity · Spent/);
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
  assert.equal(await spent(A, 'Electricity'), '140');
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
  await A.page.click('#btn-play');
  await A.page.locator('#dlg-game[open] .game').waitFor();
  assert.equal(await A.page.locator('#dlg-game .game-must').count(), 0);
  const k1 = await solveGame(A);
  await shot(A, '10-menu-puzzle');
  await A.page.click('.game-next');
  await A.page.locator('#dlg-game[open] .game:not(.won)').waitFor();
  await solveGame(A);
  await A.page.click('#game-close');
  await A.page.click('#btn-menu');
  await A.page.click('#m-game');
  await A.page.locator('#dlg-game[open] .game').waitFor();
  await A.page.click('.game-skip'); // "Try a different puzzle"
  await hintThrough(A);
  await A.page.click('#game-close');
  assert.ok(k1);
  ok('"Play a puzzle" works from the main screen and the menu, with nothing required');

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
  await noOverflow(D, 'dark xl question');
  await shot(D, '12-dark-xl-question');
  await D.page.reload();
  await D.page.locator('#wizard:not([hidden])').waitFor();
  assert.match(await D.page.textContent('#wiz-body .wiz-title'), /Rent or mortgage/);
  await answer(D, 900);
  await D.page.locator('#wiz-body .game').waitFor();
  assert.equal(await D.page.locator('#wiz-body .game-skip').count(), 0);
  ok('closing the app part-way through first-time setup picks up at the next unanswered question, puzzles still required');

  /* ---------------- the same phone, opened in the browser instead of the app ---------------- */
  const tab = await A.ctx.newPage(); // same storage as phone A, but a plain tab
  tab.on('pageerror', (e) => errors.push(`A-tab: ${e.message}`));
  await tab.goto(URL0);
  await tab.locator('#install:not([hidden])').waitFor();
  assert.equal(await tab.locator('#budget').isVisible(), false);
  assert.equal(await tab.locator('#lock').isVisible(), false);
  assert.equal(await tab.locator('.name-text').count(), 0); // none of the budget is put on the page
  await tab.close();
  ok('a phone that already has a budget still gets only the install page in a browser tab');

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
