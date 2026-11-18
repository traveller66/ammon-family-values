// Reward puzzles: a hard 9 x 9 sudoku, a three-word scramble and a big crossword. Puzzle rules live in puzzles.js; this file draws them.
import { makeSudoku, sudokuClashes, sudokuSolved, makeScramble, makeCrossword, GAME_KINDS } from './puzzles.js';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}

const CHEERS = ['Solved!', 'Nicely done!', 'You got it!', 'Brilliant!', 'What a brain!', 'Impressive!'];
const NAMES = { sudoku: 'Hard sudoku', scramble: 'Triple scramble', crossword: 'Big crossword' };
const byPlace = (a, b) => {
  const [ar, ac] = a.split(',').map(Number);
  const [br, bc] = b.split(',').map(Number);
  return ar - br || ac - bc;
};

/**
 * Puts a puzzle into `host`.
 *   kind      'sudoku' | 'scramble' | 'crossword'
 *   n         a counter used to pick which word list entries come up, so puzzles do not repeat back to back
 *   praise    a line shown above the puzzle ("Groceries is planned.")
 *   required  true during first-time setup: there is no skip, the puzzle has to be solved to move on.
 *             Nobody gets stuck: "Give me a hint" fills in one square, and `onSwap` offers a different puzzle.
 *   onSolved  called once when the puzzle is solved; may return the running total of solved puzzles
 *   onSwap    if given, a "Try a different puzzle" button calls it
 *   onDone    called when the person moves on (after solving, or by skipping when that is allowed)
 */
export function mountGame(host, { kind, n = 0, praise = '', required = false, doneLabel = 'Keep going', skipLabel = 'Skip this puzzle', onSolved = () => null, onSwap = null, onDone }) {
  if (!GAME_KINDS.includes(kind)) kind = GAME_KINDS[0];
  const status = h('p', { class: 'game-status', role: 'status', 'aria-live': 'polite' });
  const board = h('div', { class: 'game-board' });
  const wrap = h(
    'div',
    { class: 'wiz-stack game', 'data-game': kind },
    h('p', { class: 'eyebrow', text: `Puzzle break · ${NAMES[kind]}` }),
    praise ? h('h2', { class: 'wiz-title game-praise', text: praise }) : null,
    required ? h('p', { class: 'game-must', text: 'Solve this one to move on.' }) : null,
    board,
    status,
  );
  let finished = false;
  const win = () => {
    if (finished) return;
    finished = true;
    const total = onSolved();
    const cheer = CHEERS[Math.floor(Math.random() * CHEERS.length)];
    wrap.classList.add('won');
    status.textContent = '';
    for (const b of board.querySelectorAll('button')) b.disabled = true;
    wrap.querySelector('.game-help')?.remove();
    const go = h('button', { class: 'btn btn-primary btn-xl game-next', type: 'button', text: doneLabel, onclick: () => onDone(true) });
    wrap.append(
      h('div', { class: 'game-win' }, h('b', { text: cheer }), Number.isInteger(total) ? h('span', { text: `Puzzles solved: ${total}` }) : null),
      go,
    );
    go.focus();
  };
  const say = (msg, good = false) => {
    status.textContent = msg;
    status.classList.toggle('good', good);
  };
  const game = ({ sudoku, scramble, crossword })[kind](board, { n, win, say });
  wrap.append(
    h(
      'div',
      { class: 'game-help' },
      h('button', { class: 'chip game-hint', type: 'button', text: 'Give me a hint', onclick: () => { if (!finished) game.hint(); } }),
      game.check ? h('button', { class: 'chip game-check', type: 'button', text: 'Check my answers', onclick: () => { if (!finished) game.check(); } }) : null,
      onSwap ? h('button', { class: 'chip game-swap', type: 'button', text: 'Try a different puzzle', onclick: () => onSwap() }) : null,
      required ? null : h('button', { class: 'btn btn-ghost game-skip', type: 'button', text: skipLabel, onclick: () => onDone(false) }),
    ),
  );
  host.replaceChildren(wrap);
  // A hardware keyboard works too (handy on a tablet or computer). The listener removes itself once the puzzle is gone.
  if (game.key) {
    const onKey = (e) => {
      if (!wrap.isConnected || finished) return document.removeEventListener('keydown', onKey);
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (game.key(e.key)) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
  }
}

// Each puzzle below draws itself into `board` and returns { hint, check?, key? }.
// hint puts one right answer in place; check marks wrong answers in red; key handles a hardware key press.

/* ------------------------------------------------------------------ sudoku (9 x 9) */
function sudoku(board, { win, say }) {
  const { puzzle, solution } = makeSudoku();
  const grid = puzzle.map((row) => [...row]);
  const notes = puzzle.map((row) => row.map(() => new Set()));
  const cells = [];
  let sel = null;
  let noting = false;
  let marked = new Set(); // squares "Check my answers" found wrong, until they are changed
  const at = (r, c) => cells[r * 9 + c];
  const boxOf = (cell) => Math.floor(cell.r / 3) * 3 + Math.floor(cell.c / 3);
  const peersOf = (cell) => cells.filter((x) => x !== cell && (x.r === cell.r || x.c === cell.c || boxOf(x) === boxOf(cell)));

  // Drawn as nine 3 x 3 boxes, so the box lines stay thick whatever square is picked.
  const boxEls = Array.from({ length: 9 }, () => h('div', { class: 'sbox' }));
  const gridEl = h('div', { class: 'sudoku9', role: 'group', 'aria-label': 'Sudoku grid, 9 by 9' }, boxEls);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const given = puzzle[r][c] !== 0;
      const cell = { r, c, given };
      cell.el = h('button', { class: `sq${given ? ' given' : ''}`, type: 'button', onclick: () => { sel = cell; paint(); } });
      cells.push(cell);
      boxEls[boxOf(cell)].append(cell.el);
    }
  }
  const digitKeys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((v) => h('button', { class: 'key', type: 'button', text: String(v), 'aria-label': `Put ${v}`, onclick: () => put(v) }));
  const noteKey = h('button', { class: 'key key-note', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Notes: pencil in small numbers', onclick: () => { noting = !noting; paint(); } }, h('span', { text: '✎', 'aria-hidden': 'true' }), h('small', { text: 'Notes' }));
  const keys = h(
    'div',
    { class: 'keys keys-sudoku' },
    digitKeys.slice(0, 5),
    noteKey,
    digitKeys.slice(5),
    h('button', { class: 'key key-clear', type: 'button', text: 'Erase', 'aria-label': 'Erase this square', onclick: () => put(0) }),
  );

  const paint = () => {
    const bad = sudokuClashes(grid);
    const selV = sel ? grid[sel.r][sel.c] : 0;
    const placed = Array(10).fill(0);
    for (const cell of cells) {
      const { r, c, el } = cell;
      const v = grid[r][c];
      placed[v]++;
      if (v) el.textContent = String(v);
      else if (notes[r][c].size) el.replaceChildren(h('span', { class: 'notes', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => h('span', { text: notes[r][c].has(d) ? String(d) : '' }))));
      else el.textContent = '';
      el.classList.toggle('sel', sel === cell);
      el.classList.toggle('peer', !!sel && sel !== cell && (sel.r === r || sel.c === c || boxOf(sel) === boxOf(cell)));
      el.classList.toggle('same', !!selV && sel !== cell && v === selV);
      el.classList.toggle('bad', !cell.given && (bad.has(`${r},${c}`) || marked.has(`${r},${c}`)));
      const pencil = !v && notes[r][c].size ? `, notes ${[...notes[r][c]].sort().join(' ')}` : '';
      el.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}: ${v || 'empty'}${cell.given ? ', given' : ''}${pencil}`);
    }
    digitKeys.forEach((k, i) => k.classList.toggle('done', placed[i + 1] >= 9));
    noteKey.classList.toggle('on', noting);
    noteKey.setAttribute('aria-pressed', String(noting));
    if (sudokuSolved(grid)) return win();
    if (bad.size) say('A number is repeated in a row, column or box. The red squares need another look.');
    else if (marked.size) say(`${marked.size} square${marked.size === 1 ? ' is' : 's are'} wrong. They are marked in red.`);
    else say(noting ? 'Notes are on: numbers go in small, as reminders. Tap Notes again to turn them off.' : '');
  };
  const put = (v) => {
    if (!sel || sel.given) return;
    const { r, c } = sel;
    marked.delete(`${r},${c}`);
    if (!v) {
      if (grid[r][c]) grid[r][c] = 0;
      else notes[r][c].clear();
    } else if (noting) {
      if (!grid[r][c]) notes[r][c].has(v) ? notes[r][c].delete(v) : notes[r][c].add(v);
    } else {
      grid[r][c] = v;
      for (const p of peersOf(sel)) notes[p.r][p.c].delete(v); // tidy up pencil marks this number rules out
    }
    paint();
  };
  const move = (dr, dc) => {
    const from = sel ?? at(0, 0);
    sel = at((from.r + dr + 9) % 9, (from.c + dc + 9) % 9);
    paint();
  };

  board.append(
    h('p', { class: 'game-how', text: 'Fill every empty square so each row, each column and each 3 × 3 box has 1 to 9 exactly once. Tap a square, then a number. Use Notes to pencil in possibilities.' }),
    gridEl,
    keys,
  );
  sel = cells.find((x) => !x.given) ?? null;
  paint();
  return {
    hint() {
      const wrong = (x) => !x.given && grid[x.r][x.c] !== solution[x.r][x.c];
      const target = sel && wrong(sel) ? sel : cells.find(wrong);
      if (!target) return;
      const v = solution[target.r][target.c];
      grid[target.r][target.c] = v;
      notes[target.r][target.c].clear();
      marked.delete(`${target.r},${target.c}`);
      for (const p of peersOf(target)) notes[p.r][p.c].delete(v);
      sel = target;
      paint();
    },
    check() {
      marked = new Set(cells.filter((x) => !x.given && grid[x.r][x.c] && grid[x.r][x.c] !== solution[x.r][x.c]).map((x) => `${x.r},${x.c}`));
      paint();
      if (!marked.size && !sudokuClashes(grid).size && !sudokuSolved(grid)) say('Everything filled in so far is right. Keep going!', true);
    },
    key(k) {
      if (/^[1-9]$/.test(k)) put(Number(k));
      else if (k === 'Backspace' || k === 'Delete' || k === '0') put(0);
      else if (k === 'n' || k === 'N') { noting = !noting; paint(); }
      else if (k === 'ArrowUp') move(-1, 0);
      else if (k === 'ArrowDown') move(1, 0);
      else if (k === 'ArrowLeft') move(0, -1);
      else if (k === 'ArrowRight') move(0, 1);
      else return false;
      return true;
    },
  };
}

/* ------------------------------------------------------------------ word scramble (three in a row) */
function scramble(board, { n, win, say }) {
  const { items } = makeScramble(Math.random, n);
  let at = 0;
  let current = null;
  const progress = h('p', { class: 'scr-progress' });
  const done = h('ol', { class: 'scr-done', 'aria-label': 'Solved so far' });
  const stage = h('div', { class: 'scr-stage' });
  board.append(
    h('p', { class: 'game-how', text: 'Unscramble all three. Tap the letters in the right order; tap a letter in your answer to take it back.' }),
    progress,
    done,
    stage,
  );

  const one = (item, solved) => {
    const { word, lengths, clue, tiles } = item;
    const slots = Array(word.length).fill(null); // index into tiles
    const slotEls = [];
    const tileEls = [];
    const rowEl = h('div', { class: 'slots', role: 'group', 'aria-label': 'Your answer' });
    let k = 0;
    for (const len of lengths) {
      const wordEl = h('div', { class: 'slot-word' });
      for (let j = 0; j < len; j++, k++) {
        const i = k;
        const el = h('button', { class: 'sq slot', type: 'button', onclick: () => { slots[i] = null; paint(); } });
        slotEls.push(el);
        wordEl.append(el);
      }
      rowEl.append(wordEl);
    }
    const bank = h('div', { class: 'tiles', role: 'group', 'aria-label': 'Letters to use' });
    tiles.forEach((letter, t) => {
      const el = h('button', {
        class: 'key tile', type: 'button', text: letter, 'aria-label': `Letter ${letter}`,
        onclick: () => {
          const i = slots.indexOf(null);
          if (i < 0) return;
          slots[i] = t;
          paint();
        },
      });
      tileEls.push(el);
      bank.append(el);
    });
    const paint = () => {
      slots.forEach((t, i) => {
        slotEls[i].textContent = t === null ? '' : tiles[t];
        slotEls[i].classList.toggle('full', t !== null);
        slotEls[i].setAttribute('aria-label', t === null ? `Letter ${i + 1}: empty` : `Letter ${i + 1}: ${tiles[t]}. Tap to take it back.`);
      });
      tileEls.forEach((el, t) => { el.disabled = slots.includes(t); });
      if (slots.every((t) => t !== null)) {
        if (slots.map((t) => tiles[t]).join('') === word) return solved();
        rowEl.classList.add('bad');
        say('Not quite. Tap a letter in your answer to take it back.');
      } else {
        rowEl.classList.remove('bad');
        say('');
      }
    };
    const sizes = lengths.length > 1 ? `${lengths.join(' + ')} letters` : `${word.length} letters`;
    stage.replaceChildren(
      h('p', { class: 'game-clue' }, h('span', { text: 'Clue: ' }), h('b', { text: clue }), h('span', { class: 'clue-len', text: ` (${sizes})` })),
      rowEl,
      bank,
      h('button', { class: 'chip', type: 'button', text: 'Start over', onclick: () => { slots.fill(null); paint(); } }),
    );
    paint();
    return {
      hint() {
        let j = 0; // how many letters from the start are already right
        while (j < word.length && slots[j] !== null && tiles[slots[j]] === word[j]) j++;
        if (j >= word.length) return;
        for (let i = j; i < word.length; i++) slots[i] = null;
        slots[j] = tiles.findIndex((letter, t) => letter === word[j] && !slots.includes(t));
        paint();
      },
      key(key) {
        if (/^[a-z]$/i.test(key)) {
          const t = tiles.findIndex((letter, i) => letter === key.toUpperCase() && !slots.includes(i));
          const i = slots.indexOf(null);
          if (t < 0 || i < 0) return true;
          slots[i] = t;
        } else if (key === 'Backspace') {
          const last = slots.map((t) => t !== null).lastIndexOf(true);
          if (last >= 0) slots[last] = null;
        } else return false;
        paint();
        return true;
      },
    };
  };

  const next = () => {
    if (at >= items.length) return win();
    progress.textContent = `Word ${at + 1} of ${items.length}`;
    current = one(items[at], () => {
      done.append(h('li', {}, h('b', { text: items[at].answer }), h('span', { text: ' ✓', 'aria-hidden': 'true' })));
      at++;
      say('');
      next();
    });
  };
  next();
  return { hint: () => current?.hint(), key: (k) => (at < items.length ? current.key(k) : false) };
}

/* ------------------------------------------------------------------ crossword (big) */
function crossword(board, { win, say }) {
  const x = makeCrossword();
  const words = x.clues; // in clue-list order: all Across, then all Down
  const order = [...x.cells.keys()].sort(byPlace);
  const across = new Map(); // square -> index into words
  const down = new Map();
  words.forEach((w, i) => w.cells.forEach((k) => (w.dir === 'Across' ? across : down).set(k, i)));
  const typed = new Map(); // square -> letter
  const els = new Map();
  let marked = new Set();
  let cur = 0;
  let sel = words[0].cells[0];

  const choose = (k) => {
    if (k === sel) {
      const other = words[cur].dir === 'Across' ? down.get(k) : across.get(k); // tap the same square again: switch direction
      if (other !== undefined) cur = other;
    } else {
      sel = k;
      const same = (words[cur].dir === 'Across' ? across : down).get(k);
      cur = same ?? across.get(k) ?? down.get(k);
    }
    paint();
  };
  const goWord = (i) => {
    cur = (i + words.length) % words.length;
    sel = words[cur].cells.find((k) => !typed.has(k)) ?? words[cur].cells[0];
    paint();
  };
  const turn = () => {
    const other = words[cur].dir === 'Across' ? down.get(sel) : across.get(sel);
    if (other !== undefined) cur = other;
    paint();
  };
  // After a letter: the next square of this word; at the end of the word, the next word that still has an empty square.
  const advance = () => {
    const cs = words[cur].cells;
    const i = cs.indexOf(sel);
    if (i + 1 < cs.length) {
      sel = cs[i + 1];
      return;
    }
    for (let s = 1; s <= words.length; s++) {
      const j = (cur + s) % words.length;
      const empty = words[j].cells.find((k) => !typed.has(k));
      if (empty) {
        cur = j;
        sel = empty;
        return;
      }
    }
  };
  const type = (letter) => {
    typed.set(sel, letter);
    marked.delete(sel);
    advance();
    paint();
  };
  const back = () => {
    if (!typed.has(sel)) {
      const cs = words[cur].cells;
      const i = cs.indexOf(sel);
      if (i > 0) sel = cs[i - 1];
    }
    typed.delete(sel);
    marked.delete(sel);
    paint();
  };
  const step = (dr, dc) => {
    const [r, c] = sel.split(',').map(Number);
    for (let s = 1; s < Math.max(x.rows, x.cols); s++) {
      const k = `${r + dr * s},${c + dc * s}`;
      if (x.cells.has(k)) {
        const want = dr ? down.get(k) : across.get(k);
        sel = k;
        cur = want ?? across.get(k) ?? down.get(k);
        break;
      }
    }
    paint();
  };

  const gridEl = h('div', { class: 'xword', role: 'group', 'aria-label': `Crossword grid, ${x.rows} rows by ${x.cols} columns` });
  gridEl.style.setProperty('--cols', String(x.cols));
  for (let r = 0; r < x.rows; r++) {
    for (let c = 0; c < x.cols; c++) {
      const k = `${r},${c}`;
      if (!x.cells.has(k)) {
        gridEl.append(h('span', { class: 'gap', 'aria-hidden': 'true' }));
        continue;
      }
      const num = x.numbers.get(k);
      const el = h('button', { class: 'sq', type: 'button', onclick: () => choose(k) }, num ? h('span', { class: 'num', text: String(num), 'aria-hidden': 'true' }) : null, h('span', { class: 'ltr' }));
      els.set(k, el);
      gridEl.append(el);
    }
  }
  const clueText = h('span', { class: 'xclue-text' });
  const clueBar = h(
    'div',
    { class: 'xclue' },
    h('button', { class: 'xclue-nav', type: 'button', text: '‹', 'aria-label': 'Previous clue', onclick: () => goWord(cur - 1) }),
    h('button', { class: 'xclue-main', type: 'button', 'aria-label': 'Switch between across and down', onclick: turn }, clueText),
    h('button', { class: 'xclue-nav', type: 'button', text: '›', 'aria-label': 'Next clue', onclick: () => goWord(cur + 1) }),
  );
  const keyRow = (letters, extra = {}) => h('div', { class: 'qrow' }, extra.before ?? null, letters.split('').map((L) => h('button', { class: 'key', type: 'button', text: L, 'aria-label': `Letter ${L}`, onclick: () => type(L) })), extra.after ?? null);
  const dock = h(
    'div',
    { class: 'xdock' },
    clueBar,
    h(
      'div',
      { class: 'qwerty' },
      keyRow('QWERTYUIOP'),
      keyRow('ASDFGHJKL'),
      keyRow('ZXCVBNM', {
        before: h('button', { class: 'key key-wide key-turn', type: 'button', text: '⇅', 'aria-label': 'Switch between across and down', onclick: turn }),
        after: h('button', { class: 'key key-wide key-clear', type: 'button', text: '⌫', 'aria-label': 'Delete', onclick: back }),
      }),
    ),
  );
  const clueLis = [];
  const list = (dir) =>
    h(
      'div',
      { class: 'xlist' },
      h('h3', { text: dir }),
      h(
        'ul',
        { class: 'clues' },
        words.map((w, i) => {
          if (w.dir !== dir) return null;
          const li = h('li', {}, h('button', { type: 'button', onclick: () => { goWord(i); gridEl.scrollIntoView({ block: 'nearest' }); } }, h('b', { text: `${w.num} ` }), h('span', { text: `${w.clue} (${w.word.length})` })));
          clueLis[i] = li;
          return li;
        }),
      ),
    );

  const paint = () => {
    const w = words[cur];
    for (const k of order) {
      const el = els.get(k);
      el.querySelector('.ltr').textContent = typed.get(k) ?? '';
      el.classList.toggle('sel', k === sel);
      el.classList.toggle('inword', w.cells.includes(k));
      el.classList.toggle('bad', marked.has(k));
      const [r, c] = k.split(',').map(Number);
      el.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}: ${typed.get(k) ?? 'empty'}`);
    }
    clueText.replaceChildren(h('b', { text: `${w.num} ${w.dir}` }), h('span', { text: ` ${w.clue} (${w.word.length})` }));
    clueLis.forEach((li, i) => {
      if (!li) return;
      li.classList.toggle('on', i === cur);
      li.classList.toggle('filled', words[i].cells.every((k) => typed.has(k)));
    });
    const full = order.every((k) => typed.has(k));
    if (full && order.every((k) => typed.get(k) === x.cells.get(k))) return win();
    if (marked.size) say(`${marked.size} letter${marked.size === 1 ? ' is' : 's are'} wrong. They are marked in red.`);
    else if (full) say('Every square is filled, but something is off. Tap "Check my answers" to see where.');
    else say('');
  };

  board.append(
    h('p', { class: 'game-how', text: 'Tap a square and type. Tap the same square again (or the clue bar) to switch between across and down. Tap a clue to jump to it.' }),
    gridEl,
    dock,
    h('div', { class: 'xlists' }, list('Across'), list('Down')),
  );
  paint();
  return {
    hint() {
      const wrong = (k) => typed.get(k) !== x.cells.get(k);
      const target = wrong(sel) ? sel : words[cur].cells.find(wrong) ?? order.find(wrong);
      if (!target) return;
      typed.set(target, x.cells.get(target));
      marked.delete(target);
      if (!words[cur].cells.includes(target)) cur = across.get(target) ?? down.get(target);
      sel = target;
      paint();
    },
    check() {
      marked = new Set(order.filter((k) => typed.has(k) && typed.get(k) !== x.cells.get(k)));
      paint();
      if (!marked.size && typed.size && typed.size < order.length) say('Everything filled in so far is right. Keep going!', true);
    },
    key(k) {
      if (/^[a-z]$/i.test(k)) type(k.toUpperCase());
      else if (k === 'Backspace' || k === 'Delete') back();
      else if (k === 'ArrowUp') step(-1, 0);
      else if (k === 'ArrowDown') step(1, 0);
      else if (k === 'ArrowLeft') step(0, -1);
      else if (k === 'ArrowRight') step(0, 1);
      else if (k === 'Enter') goWord(cur + 1);
      else return false;
      return true;
    },
  };
}
