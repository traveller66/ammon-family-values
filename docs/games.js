// Reward puzzles: a quick mini sudoku, word scramble or mini crossword. Puzzle rules live in puzzles.js; this file draws them.
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

const CHEERS = ['Solved!', 'Nicely done!', 'You got it!', 'Brilliant!', 'That was quick!'];
const NAMES = { sudoku: 'Mini sudoku', scramble: 'Word scramble', crossword: 'Mini crossword' };

/**
 * Puts a puzzle into `host`.
 *   kind      'sudoku' | 'scramble' | 'crossword'
 *   n         a counter used to pick which word list entry comes up, so puzzles do not repeat back to back
 *   praise    a line shown above the puzzle ("Groceries is planned.")
 *   onSolved  called once when the puzzle is solved; may return the running total of solved puzzles
 *   onDone    called when the person moves on (after solving, or by skipping)
 */
export function mountGame(host, { kind, n = 0, praise = '', doneLabel = 'Keep going', skipLabel = 'Skip this puzzle', onSolved = () => null, onDone }) {
  if (!GAME_KINDS.includes(kind)) kind = GAME_KINDS[0];
  const status = h('p', { class: 'game-status', role: 'status', 'aria-live': 'polite' });
  const board = h('div', { class: 'game-board' });
  const wrap = h(
    'div',
    { class: 'wiz-stack game', 'data-game': kind },
    h('p', { class: 'eyebrow', text: `Puzzle break · ${NAMES[kind]}` }),
    praise ? h('h2', { class: 'wiz-title game-praise', text: praise }) : null,
    board,
    status,
    h('button', { class: 'btn btn-ghost game-skip', type: 'button', text: skipLabel, onclick: () => onDone(false) }),
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
    wrap.querySelector('.game-skip').remove();
    const go = h('button', { class: 'btn btn-primary btn-xl game-next', type: 'button', text: doneLabel, onclick: () => onDone(true) });
    wrap.append(
      h('div', { class: 'game-win' }, h('b', { text: cheer }), Number.isInteger(total) ? h('span', { text: `Puzzles solved: ${total}` }) : null),
      go,
    );
    go.focus();
  };
  const say = (msg) => {
    status.textContent = msg;
  };
  ({ sudoku, scramble, crossword })[kind](board, { n, win, say });
  host.replaceChildren(wrap);
}

/* ------------------------------------------------------------------ mini sudoku */
function sudoku(board, { win, say }) {
  const { puzzle } = makeSudoku();
  const grid = puzzle.map((row) => [...row]);
  const cells = [];
  let sel = null;
  const paint = () => {
    const bad = sudokuClashes(grid);
    for (const cell of cells) {
      const v = grid[cell.r][cell.c];
      cell.el.textContent = v || '';
      cell.el.classList.toggle('sel', sel === cell);
      cell.el.classList.toggle('bad', !cell.given && bad.has(`${cell.r},${cell.c}`));
      cell.el.setAttribute('aria-label', `Row ${cell.r + 1}, column ${cell.c + 1}: ${v || 'empty'}${cell.given ? ', given' : ''}`);
    }
    if (sudokuSolved(grid)) win();
    else if (bad.size) say('A number is repeated. The red squares need another look.');
    else say('');
  };
  const pick = (cell) => {
    if (cell.given) return;
    sel = cell;
    paint();
  };
  const gridEl = h('div', { class: 'sudoku', role: 'group', 'aria-label': 'Sudoku grid' });
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const given = puzzle[r][c] !== 0;
      const cell = { r, c, given };
      cell.el = h('button', { class: `sq${given ? ' given' : ''}${c === 1 ? ' edge-r' : ''}${r === 1 ? ' edge-b' : ''}`, type: 'button', onclick: () => pick(cell) });
      cells.push(cell);
      gridEl.append(cell.el);
    }
  }
  const put = (v) => {
    if (!sel) return;
    grid[sel.r][sel.c] = v;
    if (v) {
      const i = cells.indexOf(sel);
      const next = [...cells.slice(i + 1), ...cells.slice(0, i)].find((x) => !x.given && !grid[x.r][x.c]);
      if (next) sel = next;
    }
    paint();
  };
  const keys = h(
    'div',
    { class: 'keys keys-5' },
    [1, 2, 3, 4].map((v) => h('button', { class: 'key', type: 'button', text: String(v), 'aria-label': `Put ${v}`, onclick: () => put(v) })),
    h('button', { class: 'key key-clear', type: 'button', text: 'Clear', 'aria-label': 'Clear this square', onclick: () => put(0) }),
  );
  board.append(h('p', { class: 'game-how', text: 'Fill the empty squares so every row, every column and every block of four has 1, 2, 3 and 4.' }), gridEl, keys);
  sel = cells.find((x) => !x.given) ?? null;
  paint();
}

/* ------------------------------------------------------------------ word scramble */
function scramble(board, { n, win, say }) {
  const { word, clue, tiles } = makeScramble(Math.random, n);
  const slots = Array(word.length).fill(null); // index into tiles
  const slotEls = [];
  const tileEls = [];
  const paint = () => {
    slots.forEach((t, i) => {
      slotEls[i].textContent = t === null ? '' : tiles[t];
      slotEls[i].classList.toggle('full', t !== null);
      slotEls[i].setAttribute('aria-label', t === null ? `Letter ${i + 1}: empty` : `Letter ${i + 1}: ${tiles[t]}. Tap to take it back.`);
    });
    tileEls.forEach((el, t) => {
      el.disabled = slots.includes(t);
    });
    if (slots.every((t) => t !== null)) {
      const guess = slots.map((t) => tiles[t]).join('');
      if (guess === word) return win();
      rowEl.classList.add('bad');
      say('Not quite. Tap a letter in your answer to take it back.');
    } else {
      rowEl.classList.remove('bad');
      say('');
    }
  };
  const rowEl = h('div', { class: 'slots', role: 'group', 'aria-label': 'Your answer' });
  for (let i = 0; i < word.length; i++) {
    const el = h('button', { class: 'sq slot', type: 'button', onclick: () => { slots[i] = null; paint(); } });
    slotEls.push(el);
    rowEl.append(el);
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
  const clear = h('button', { class: 'chip', type: 'button', text: 'Start over', onclick: () => { slots.fill(null); paint(); } });
  board.append(
    h('p', { class: 'game-how', text: 'Tap the letters in the right order to spell the word.' }),
    h('p', { class: 'game-clue' }, h('span', { text: 'Clue: ' }), h('b', { text: clue })),
    rowEl,
    bank,
    clear,
  );
  paint();
}

/* ------------------------------------------------------------------ mini crossword */
function crossword(board, { n, win, say }) {
  const x = makeCrossword(Math.random, n);
  const order = [...x.cells.keys()].sort((a, b) => {
    const [ar, ac] = a.split(',').map(Number);
    const [br, bc] = b.split(',').map(Number);
    return ar - br || ac - bc;
  });
  const typed = new Map(); // 'r,c' -> letter
  const els = new Map();
  let sel = order[0];
  const paint = () => {
    const full = order.every((k) => typed.has(k));
    for (const k of order) {
      const el = els.get(k);
      el.querySelector('.ltr').textContent = typed.get(k) ?? '';
      el.classList.toggle('sel', k === sel);
      el.classList.toggle('bad', full && typed.get(k) !== x.cells.get(k));
      const [r, c] = k.split(',').map(Number);
      el.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}: ${typed.get(k) ?? 'empty'}`);
    }
    if (full && order.every((k) => typed.get(k) === x.cells.get(k))) win();
    else if (full) say('Close! The red squares are not right yet.');
    else say('');
  };
  const gridEl = h('div', { class: 'xword', role: 'group', 'aria-label': 'Crossword grid' });
  gridEl.style.setProperty('--cols', String(x.cols));
  for (let r = 0; r < x.rows; r++) {
    for (let c = 0; c < x.cols; c++) {
      const k = `${r},${c}`;
      if (!x.cells.has(k)) {
        gridEl.append(h('span', { class: 'gap', 'aria-hidden': 'true' }));
        continue;
      }
      const num = x.numbers.get(k);
      const el = h('button', { class: 'sq', type: 'button', onclick: () => { sel = k; paint(); } }, num ? h('span', { class: 'num', text: String(num), 'aria-hidden': 'true' }) : null, h('span', { class: 'ltr' }));
      els.set(k, el);
      gridEl.append(el);
    }
  }
  const put = (letter) => {
    if (letter) typed.set(sel, letter);
    else typed.delete(sel);
    if (letter) {
      const i = order.indexOf(sel);
      const next = [...order.slice(i + 1), ...order.slice(0, i)].find((k) => !typed.has(k));
      if (next) sel = next;
    }
    paint();
  };
  const keys = h(
    'div',
    { class: 'keys keys-6' },
    x.bank.map((letter) => h('button', { class: 'key', type: 'button', text: letter, 'aria-label': `Letter ${letter}`, onclick: () => put(letter) })),
    h('button', { class: 'key key-clear', type: 'button', text: 'Clear', 'aria-label': 'Clear this square', onclick: () => put(null) }),
  );
  const clues = h('ul', { class: 'clues' }, x.clues.map((c) => h('li', {}, h('b', { text: `${c.num} ${c.dir}` }), h('span', { text: ` ${c.clue} (${c.word.length} letters)` }))));
  board.append(h('p', { class: 'game-how', text: 'Tap a square, then tap a letter.' }), gridEl, clues, keys);
  paint();
}
