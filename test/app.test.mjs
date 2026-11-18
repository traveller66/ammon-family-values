// Automated checks for the stand-alone app. Uses the real app code (everything except the screens).
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { newFamilyKey, deriveVault, recordId, randomRecordId } from '../docs/vault.js';
import { Budget, valLabel, valPayload, catPayload, helpFor, HELP, DEFAULT_CATEGORIES, exportData, cleanImport, planMerge, parseMoney } from '../docs/model.js';
import { LocalBook } from '../docs/local.js';
import { createMemoryStore } from '../docs/store.js';
import { wrapKey, unwrapKey, validPin } from '../docs/lock.js';
import { sealFile, parseFile, openFile, validPassword, fileName } from '../docs/share.js';
import { makeSudoku, sudokuSolved, sudokuClashes, gradeSudoku, SCRAMBLE_WORDS, SCRAMBLE_ROUND, makeScramble, CROSSWORD_WORDS, CROSSWORD_SIZE, makeCrossword, layCrossword, GAME_KINDS } from '../docs/puzzles.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const MONTH = '2026-11';
const FAST = 2000; // PBKDF2 rounds for tests (the app uses far more)
let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
  }
}

/** A pretend phone: its own key, its own storage. */
async function phone(st = createMemoryStore(), key = newFamilyKey()) {
  const vault = await deriveVault(key);
  const budget = new Budget();
  const book = new LocalBook({ vault, store: st, onRecord: (rid, p) => budget.apply(rid, p) });
  await book.start();
  const p = { key, vault, budget, book, st };
  p.addCat = async (name, kind, u) => {
    const id = randomRecordId();
    const payload = catPayload(name, kind, budget.nextOrder(kind), false, u);
    budget.apply(id, payload);
    await book.put(id, payload);
    return id;
  };
  p.set = async (cat, field, cents, u, m = MONTH) => {
    const rid = await recordId(vault, valLabel(cat, m, field));
    const payload = valPayload(cat, m, field, cents, u);
    budget.apply(rid, payload);
    await book.put(rid, payload);
  };
  p.bringIn = async (data, lastShared = 0) => {
    const plan = planMerge(budget, cleanImport(data), lastShared);
    const entries = [];
    for (const c of plan.cats) { budget.apply(c.id, c.payload); entries.push([c.id, c.payload]); }
    for (const v of plan.vals) { const rid = await recordId(vault, valLabel(v.c, v.m, v.f)); budget.apply(rid, v.payload); entries.push([rid, v.payload]); }
    await book.putMany(entries);
    return plan;
  };
  return p;
}
const catByName = (b, name) => [...b.cats.values()].find((c) => c.name === name && !c.deleted);

console.log('Saving on the phone');
await step('a budget survives closing and reopening the app, and is sealed in storage', async () => {
  const a = await phone();
  const g = await a.addCat('Groceries', 'e');
  await a.set(g, 'p', 60000);
  await a.set(g, 'a', 12345);
  const raw = [...['fb.cache']].map((k) => a.st.get(k)).join('');
  assert.ok(raw.length > 50);
  for (const leak of ['Groceries', '60000', '12345', a.key]) assert.ok(!raw.includes(leak), `storage contains ${leak}`);
  const again = await phone(a.st, a.key);
  assert.equal(again.budget.get(g, MONTH, 'p'), 60000);
  assert.equal(again.budget.get(g, MONTH, 'a'), 12345);
  assert.equal(catByName(again.budget, 'Groceries').id, g);
});
await step('the wrong key opens nothing', async () => {
  const a = await phone();
  await a.addCat('Groceries', 'e');
  const other = await phone(a.st);
  assert.equal(other.budget.cats.size, 0);
});
await step('data saved by the older server-based version still opens (including edits it had not sent yet)', async () => {
  const a = await phone();
  const g = await a.addCat('Fun', 'e');
  await a.set(g, 'p', 5000);
  const cache = JSON.parse(a.st.get('fb.cache'));
  const rid = await recordId(a.vault, valLabel(g, MONTH, 'p'));
  const newer = (await phone(createMemoryStore(), a.key));
  await newer.book.put(rid, { t: 'val', c: g, m: MONTH, f: 'p', v: 7500 }); // old format: no change time
  const st = createMemoryStore();
  for (const r of Object.values(cache.records)) r.seq = 3;
  st.set('fb.cache', JSON.stringify({ room: a.vault.bookId, seq: 9, records: cache.records }));
  st.set('fb.outbox', JSON.stringify({ room: a.vault.bookId, items: { [rid]: newer.book.records[rid] } }));
  const b = await phone(st, a.key);
  assert.equal(b.budget.get(g, MONTH, 'p'), 7500);
  assert.equal(st.get('fb.outbox'), null);
  assert.equal((await phone(st, a.key)).budget.get(g, MONTH, 'p'), 7500);
});
await step('the app code has no network calls and no leftovers from the server version', () => {
  for (const f of fs.readdirSync(DOCS).filter((x) => x.endsWith('.js') && x !== 'sw.js')) {
    const src = fs.readFileSync(path.join(DOCS, f), 'utf8');
    for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', '/api/', 'onrender']) assert.ok(!src.includes(word), `${f} mentions ${word}`);
  }
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  assert.ok(!/https?:\/\//.test(html), 'index.html links to another site');
});
await step('every file the app needs is in the offline list, and every listed file exists', () => {
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  const shell = [...sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];')).matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const f of shell) assert.ok(fs.existsSync(path.join(DOCS, f)), `${f} is listed but missing`);
  for (const f of fs.readdirSync(DOCS).filter((x) => /\.(js|css|html|webmanifest)$/.test(x) && x !== 'sw.js')) assert.ok(shell.includes(f), `${f} is not in the offline list`);
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(DOCS, 'app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of app.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) assert.ok(ids.has(m[1]), `app.js uses #${m[1]} but index.html has no such element`);
});

console.log('\nBudget files (send and bring in)');
await step('a budget file is locked: unreadable without the password, opens with it', async () => {
  const a = await phone();
  const g = await a.addCat('Groceries', 'e');
  await a.set(g, 'a', 4321);
  const text = await sealFile('purple river toast', exportData(a.budget), FAST);
  for (const leak of ['Groceries', '4321', a.key]) assert.ok(!text.includes(leak));
  const file = parseFile(text);
  assert.ok(file);
  assert.equal(await openFile('purple river toasty', file), null);
  const data = await openFile('  Purple River  Toast ', file); // capitals and stray spaces are forgiven
  assert.equal(data.cats[0].n, 'Groceries');
  const names = Object.keys(data).sort().join();
  assert.equal(names, 'at,cats,v,vals'); // labels and numbers only: nothing about the person or the phone
});
await step('a file that was altered, cut short, or is something else is refused', async () => {
  const text = await sealFile('purple river toast', { v: 1, at: 1, cats: [], vals: [] }, FAST);
  const f = parseFile(text);
  const flip = (str) => str.slice(0, 5) + (str[5] === 'A' ? 'B' : 'A') + str.slice(6);
  assert.equal(await openFile('purple river toast', { ...f, ct: flip(f.ct) }), null);
  assert.equal(await openFile('purple river toast', { ...f, iv: flip(f.iv) }), null);
  assert.equal(parseFile(text.slice(0, 40)), null);
  assert.equal(parseFile('hello'), null);
  assert.equal(parseFile('{"app":"something-else"}'), null);
  assert.equal(parseFile(''), null);
  assert.throws(() => cleanImport({ v: 2, cats: [], vals: [] }));
  assert.throws(() => cleanImport(null));
  const cleaned = cleanImport({ v: 1, at: 1, cats: [{ id: 'nope', n: 'X', k: 'e', o: 0 }, { id: 'a'.repeat(32), n: 'Ok', k: 'e', o: 0, extra: 'ignored' }], vals: [{ c: 'a'.repeat(32), m: '2026-13', f: 'p', v: 1 }, { c: 'a'.repeat(32), m: MONTH, f: 'p', v: 1.5 }, { c: 'a'.repeat(32), m: MONTH, f: 'p', v: 100 }] });
  assert.equal(cleaned.cats.length, 1);
  assert.deepEqual(Object.keys(cleaned.cats[0]).sort(), ['id', 'k', 'n', 'o', 'u', 'x']);
  assert.equal(cleaned.vals.length, 1);
});
await step('text pasted from an email (wrapped lines, words around it) still opens', async () => {
  const text = await sealFile('purple river toast', { v: 1, at: 1, cats: [], vals: [] }, FAST);
  const wrapped = `Hi honey, here it is:\n\n${text.replace(/(.{60})/g, '$1\r\n')}\n\nLove you`;
  assert.ok(await openFile('purple river toast', parseFile(wrapped)));
});
await step('sharing passwords and file names', () => {
  assert.ok(validPassword('purple river toast'));
  assert.ok(!validPassword('short'));
  assert.ok(!validPassword('       a'));
  assert.equal(fileName(new Date(2026, 10, 6)), 'ammon-budget-2026-11-06.txt');
});
await step('a second phone that opens the file gets the whole budget', async () => {
  const a = await phone();
  const g = await a.addCat('Groceries', 'e');
  const pay = await a.addCat('Paycheck', 'i');
  await a.set(g, 'p', 60000);
  await a.set(pay, 'p', 400000);
  const b = await phone();
  const plan = await b.bringIn(exportData(a.budget));
  assert.equal(plan.total, 4);
  assert.deepEqual(b.budget.totals(MONTH), a.budget.totals(MONTH));
  assert.equal(catByName(b.budget, 'Groceries').id, g);
  const reopened = await phone(b.st, b.key);
  assert.deepEqual(reopened.budget.totals(MONTH), a.budget.totals(MONTH));
  assert.equal((await b.bringIn(exportData(a.budget))).total, 0); // bringing the same file in twice changes nothing
});
await step('an update emailed back changes only what is newer', async () => {
  const me = await phone();
  const g = await me.addCat('Groceries', 'e', 1000);
  const fun = await me.addCat('Fun', 'e', 1000);
  await me.set(g, 'p', 60000, 1000);
  await me.set(fun, 'p', 10000, 1000);
  const wife = await phone();
  await wife.bringIn(exportData(me.budget));
  // she updates spending and adds an item; meanwhile I change the Fun plan after she did
  await wife.set(g, 'a', 8250, 2000);
  await wife.set(fun, 'p', 12000, 2000);
  const pets = await wife.addCat('Pet care', 'e', 2000);
  await wife.set(pets, 'p', 4000, 2000);
  await me.set(fun, 'p', 15000, 3000);
  const plan = await me.bringIn(exportData(wife.budget), 1500);
  assert.equal(me.budget.get(g, MONTH, 'a'), 8250);
  assert.equal(me.budget.get(fun, MONTH, 'p'), 15000); // mine was newer: kept
  assert.equal(plan.kept, 1);
  assert.equal(me.budget.get(pets, MONTH, 'p'), 4000);
  assert.equal(catByName(me.budget, 'Pet care').id, pets);
  assert.equal(me.budget.get(g, MONTH, 'p'), 60000);
  // and when I send mine back, she ends up identical to me
  await wife.bringIn(exportData(me.budget));
  for (const k of ['p', 'a']) for (const c of [g, fun, pets]) assert.equal(wife.budget.get(c, MONTH, k), me.budget.get(c, MONTH, k));
});
await step('the preview flags an amount both phones changed, and nothing changes until it is applied', async () => {
  const me = await phone();
  const g = await me.addCat('Groceries', 'e', 1000);
  await me.set(g, 'a', 2000, 1000);
  const wife = await phone();
  await wife.bringIn(exportData(me.budget));
  await me.set(g, 'a', 4000, 5000); // I add $20
  await wife.set(g, 'a', 5000, 6000); // she adds $30 to the old total, a little later
  const plan = planMerge(me.budget, cleanImport(exportData(wife.budget)), 1500);
  assert.equal(me.budget.get(g, MONTH, 'a'), 4000);
  assert.equal(plan.vals.length, 1);
  assert.deepEqual([plan.vals[0].from, plan.vals[0].to, plan.vals[0].both, plan.vals[0].name], [4000, 5000, true, 'Groceries']);
  const calm = planMerge(me.budget, cleanImport(exportData(wife.budget)), 5500); // nothing of mine changed since we last swapped
  assert.equal(calm.vals[0].both, false);
});
await step('renames, removals and cleared amounts travel in the file', async () => {
  const me = await phone();
  const fun = await me.addCat('Fun', 'e', 1000);
  const other = await me.addCat('Other', 'e', 1000);
  await me.set(fun, 'p', 10000, 1000);
  const wife = await phone();
  await wife.bringIn(exportData(me.budget));
  wife.budget.apply(fun, catPayload('Entertainment', 'e', 0, false, 2000));
  wife.budget.apply(other, catPayload('Other', 'e', 1, true, 2000));
  await wife.set(fun, 'p', null, 2000);
  const plan = await me.bringIn(exportData(wife.budget));
  assert.deepEqual(plan.cats.map((c) => c.change).sort(), ['removed', 'renamed']);
  assert.equal(me.budget.cats.get(fun).name, 'Entertainment');
  assert.equal(me.budget.categories('e').length, 1);
  assert.equal(me.budget.get(fun, MONTH, 'p'), null);
});
await step('two phones that were set up separately still line up by item name', async () => {
  const me = await phone();
  const wife = await phone();
  const mine = await me.addCat('Groceries', 'e', 1000);
  const hers = await wife.addCat('groceries ', 'e', 1500);
  assert.notEqual(mine, hers);
  await me.set(mine, 'p', 60000, 1000);
  await wife.set(hers, 'a', 9900, 2000);
  const plan = await me.bringIn(exportData(wife.budget));
  assert.equal(plan.cats.length, 0); // no duplicate "Groceries"
  assert.equal(me.budget.categories('e').length, 1);
  assert.equal(me.budget.get(mine, MONTH, 'a'), 9900);
  assert.equal(me.budget.get(mine, MONTH, 'p'), 60000);
});

console.log('\nApp lock');
await step('PIN lock: right PIN opens, wrong PIN and tampering do not', async () => {
  const key = newFamilyKey();
  const w = await wrapKey('4821', key, FAST);
  assert.ok(!JSON.stringify(w).includes(key));
  assert.equal(await unwrapKey('4821', w), key);
  assert.equal(await unwrapKey('4822', w), null);
  assert.equal(await unwrapKey('4821', { ...w, ct: w.ct.slice(0, -2) + (w.ct.endsWith('AA') ? 'BB' : 'AA') }), null);
  assert.ok(validPin('1234') && validPin('12345678') && !validPin('123') && !validPin('12a4') && !validPin('123456789'));
});
await step('the remembered sharing password is sealed, and only the budget key reads it', async () => {
  const a = await phone();
  await a.book.setNote('sharepw', 'purple river toast');
  assert.ok(!a.st.get('fb.note.sharepw').includes('purple'));
  assert.equal(await a.book.getNote('sharepw'), 'purple river toast');
  assert.equal(await (await phone(a.st)).book.getNote('sharepw'), null);
  await a.book.setNote('sharepw', null);
  assert.equal(await a.book.getNote('sharepw'), null);
});

console.log('\nGuided setup and puzzles');
await step('every starting item has its own "I\'m asking for" help', () => {
  for (const kind of ['i', 'e']) {
    for (const name of DEFAULT_CATEGORIES[kind]) {
      assert.ok(HELP[name.toLowerCase()], `no help for ${name}`);
      const info = helpFor(name, kind, 'p');
      assert.ok(info.ask.length > 10 && info.what.length > 30);
    }
  }
  assert.match(helpFor('Paycheck', 'i', 'p').ask, /net income/i);
  assert.match(helpFor('Pet care', 'e', 'a').ask, /Pet care/);
  assert.deepEqual(parseMoney('$1,200.50'), { ok: true, cents: 120050 });
});
await step('sudoku: 80 fresh 9 x 9 puzzles each have exactly one answer, 22 to 32 givens, and need more than the easy moves', () => {
  // An independent answer counter (plain backtracking), so the app's own solver is not checking itself.
  const count = (g, limit = 2) => {
    let best = -1;
    let bestOpts = null;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const r = Math.floor(i / 9), c = i % 9, br = r - (r % 3), bc = c - (c % 3);
      const opts = [];
      for (let v = 1; v <= 9; v++) {
        let ok = true;
        for (let k = 0; k < 9 && ok; k++) if (g[r * 9 + k] === v || g[k * 9 + c] === v || g[(br + Math.floor(k / 3)) * 9 + bc + (k % 3)] === v) ok = false;
        if (ok) opts.push(v);
      }
      if (!bestOpts || opts.length < bestOpts.length) { best = i; bestOpts = opts; }
      if (opts.length === 0) return 0;
    }
    if (best < 0) return 1;
    let n = 0;
    for (const v of bestOpts) { g[best] = v; n += count(g, limit - n); if (n >= limit) break; }
    g[best] = 0;
    return n;
  };
  for (let i = 0; i < 80; i++) {
    const { puzzle, solution } = makeSudoku();
    assert.equal(puzzle.length, 9);
    assert.ok(sudokuSolved(solution));
    assert.ok(!sudokuSolved(puzzle));
    const givens = puzzle.flat().filter((v) => v).length;
    assert.ok(givens >= 22 && givens <= 32, `givens: ${givens}`);
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (puzzle[r][c]) assert.equal(puzzle[r][c], solution[r][c]);
    assert.equal(count(puzzle.flat()), 1);
    const grade = gradeSudoku(puzzle.flat());
    assert.ok(grade.solved, 'needs guessing');
    assert.ok(grade.level >= 2, 'too easy');
    assert.deepEqual(grade.cells, solution.flat());
  }
  const g = Array.from({ length: 9 }, () => Array(9).fill(0));
  g[4][1] = 5;
  g[4][7] = 5;
  const bad = sudokuClashes(g);
  assert.ok(bad.has('4,1') && bad.has('4,7') && bad.size === 2);
  assert.ok(sudokuClashes([[1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]).has('0,1'));
});
await step('word scramble: three long words or phrases a round, each mixed up, with a clue that does not give it away', () => {
  assert.equal(SCRAMBLE_ROUND, 3);
  SCRAMBLE_WORDS.forEach(([answer, clue]) => {
    assert.match(answer, /^[A-Z]+( [A-Z]+)?$/);
    const letters = answer.replace(/ /g, '').length;
    assert.ok(letters >= 8 && letters <= 16, `${answer}: ${letters} letters`);
    for (const part of answer.split(' ')) assert.ok(!clue.toUpperCase().includes(part), `clue gives away ${answer}`);
    assert.ok(clue.length > 10);
  });
  assert.equal(new Set(SCRAMBLE_WORDS.map((w) => w[0])).size, SCRAMBLE_WORDS.length);
  const seen = new Set();
  for (let n = 0; n < SCRAMBLE_WORDS.length; n++) {
    const { items } = makeScramble(Math.random, n);
    assert.equal(items.length, 3);
    for (const it of items) {
      seen.add(it.answer);
      assert.equal(it.word, it.answer.replace(/ /g, ''));
      assert.deepEqual(it.lengths, it.answer.split(' ').map((w) => w.length));
      assert.notEqual(it.tiles.join(''), it.word);
      assert.equal([...it.tiles].sort().join(''), it.word.split('').sort().join(''));
    }
  }
  assert.equal(seen.size, SCRAMBLE_WORDS.length, 'some words never come up');
});
await step('crossword: 150 fresh grids fit a phone, have 16+ words that all link up, and form no stray words', () => {
  CROSSWORD_WORDS.forEach(([w, clue]) => {
    assert.match(w, /^[A-Z]{3,11}$/);
    assert.ok(!clue.toUpperCase().includes(w), `clue gives away ${w}`);
  });
  assert.equal(new Set(CROSSWORD_WORDS.map((x) => x[0])).size, CROSSWORD_WORDS.length, 'a word is listed twice');
  assert.equal(new Set(CROSSWORD_WORDS.map((x) => x[1])).size, CROSSWORD_WORDS.length, 'a clue is used twice');
  for (let i = 0; i < 150; i++) {
    const x = makeCrossword();
    assert.ok(x.rows <= CROSSWORD_SIZE.rows && x.cols <= CROSSWORD_SIZE.cols, `too big for a phone: ${x.rows} x ${x.cols}`);
    assert.ok(x.clues.length >= 16, `only ${x.clues.length} words`);
    assert.equal(new Set(x.clues.map((c) => c.word)).size, x.clues.length, 'a word appears twice');
    for (const c of x.clues) {
      assert.equal(c.cells.map((k) => x.cells.get(k)).join(''), c.word);
      assert.ok(x.clues.some((o) => o !== c && o.cells.some((k) => c.cells.includes(k))), `${c.word} crosses nothing`);
    }
    // every word can be reached from every other through crossings
    const reached = new Set([0]);
    for (let grew = true; grew;) {
      grew = false;
      x.clues.forEach((c, j) => {
        if (reached.has(j)) return;
        if ([...reached].some((r) => x.clues[r].cells.some((k) => c.cells.includes(k)))) { reached.add(j); grew = true; }
      });
    }
    assert.equal(reached.size, x.clues.length, 'grid falls apart into pieces');
    // no accidental extra words: squares that touch must belong to the same word
    for (const k of x.cells.keys()) {
      const [r, c] = k.split(',').map(Number);
      for (const n of [`${r},${c + 1}`, `${r + 1},${c}`]) {
        if (x.cells.has(n)) assert.ok(x.clues.some((cl) => cl.cells.includes(k) && cl.cells.includes(n)), `stray neighbours at ${k}`);
      }
    }
    // numbering: each word starts on its number, numbers run in reading order
    const nums = [...x.numbers.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0].split(',').map(Number));
    for (let j = 1; j < nums.length; j++) assert.ok(nums[j][0] > nums[j - 1][0] || (nums[j][0] === nums[j - 1][0] && nums[j][1] > nums[j - 1][1]));
    for (const c of x.clues) assert.equal(x.numbers.get(c.cells[0]), c.num);
  }
  assert.throws(() => layCrossword([{ w: 'AB', r: 0, c: 0, d: 'a', clue: '' }, { w: 'XY', r: 0, c: 0, d: 'd', clue: '' }]));
  assert.deepEqual(GAME_KINDS, ['sudoku', 'scramble', 'crossword']);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`Failed: ${failures.join('; ')}`);
  process.exit(1);
}
