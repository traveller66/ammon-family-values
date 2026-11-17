// The little reward puzzles shown during guided setup. No DOM in here: just making and checking puzzles.

const pickInt = (rng, n) => Math.floor(rng() * n);
export function shuffle(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = pickInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ mini sudoku (4 x 4) */
// Every row, every column and every 2 x 2 box holds 1, 2, 3 and 4 exactly once.

const BASE = [
  [1, 2, 3, 4],
  [3, 4, 1, 2],
  [2, 1, 4, 3],
  [4, 3, 2, 1],
];

/** Cells (as [row, col]) that break the rules because the same number appears twice in a row, column or box. */
export function sudokuClashes(grid) {
  const bad = new Set();
  const groups = [];
  for (let i = 0; i < 4; i++) {
    groups.push([0, 1, 2, 3].map((j) => [i, j]));
    groups.push([0, 1, 2, 3].map((j) => [j, i]));
    const r = (i >> 1) * 2;
    const c = (i & 1) * 2;
    groups.push([[r, c], [r, c + 1], [r + 1, c], [r + 1, c + 1]]);
  }
  for (const g of groups) {
    for (const [r, c] of g) {
      const v = grid[r][c];
      if (v && g.some(([r2, c2]) => (r2 !== r || c2 !== c) && grid[r2][c2] === v)) bad.add(`${r},${c}`);
    }
  }
  return bad;
}
export const sudokuSolved = (grid) => grid.every((row) => row.every((v) => v >= 1 && v <= 4)) && sudokuClashes(grid).size === 0;

function countSolutions(grid, limit = 2) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (grid[r][c]) continue;
      let n = 0;
      for (let v = 1; v <= 4 && n < limit; v++) {
        grid[r][c] = v;
        if (!sudokuClashes(grid).has(`${r},${c}`)) n += countSolutions(grid, limit - n);
      }
      grid[r][c] = 0;
      return n;
    }
  }
  return 1;
}

/** A fresh puzzle with exactly one answer. `blanks` empty squares (fewer if that many cannot be removed safely). */
export function makeSudoku(rng = Math.random, blanks = 7) {
  let g = BASE.map((row) => [...row]);
  const swapRows = (a, b) => ([g[a], g[b]] = [g[b], g[a]]);
  const swapCols = (a, b) => g.forEach((row) => ([row[a], row[b]] = [row[b], row[a]]));
  if (rng() < 0.5) swapRows(0, 1);
  if (rng() < 0.5) swapRows(2, 3);
  if (rng() < 0.5) g = [g[2], g[3], g[0], g[1]];
  if (rng() < 0.5) swapCols(0, 1);
  if (rng() < 0.5) swapCols(2, 3);
  if (rng() < 0.5) g.forEach((row) => row.push(...row.splice(0, 2)));
  const digits = shuffle([1, 2, 3, 4], rng);
  const solution = g.map((row) => row.map((v) => digits[v - 1]));
  const puzzle = solution.map((row) => [...row]);
  let removed = 0;
  for (const i of shuffle([...Array(16).keys()], rng)) {
    if (removed >= blanks) break;
    const r = i >> 2;
    const c = i & 3;
    const keep = puzzle[r][c];
    puzzle[r][c] = 0;
    if (countSolutions(puzzle.map((row) => [...row])) === 1) removed++;
    else puzzle[r][c] = keep;
  }
  return { puzzle, solution };
}

/* ------------------------------------------------------------------ word scramble */

export const SCRAMBLE_WORDS = [
  ['BUDGET', 'A plan for your money'],
  ['INCOME', 'Money that comes in'],
  ['SAVINGS', 'Money set aside for later'],
  ['COUPON', 'It takes a little off the price'],
  ['WALLET', 'Where cash and cards ride along'],
  ['SALARY', 'Yearly pay for a job'],
  ['BARGAIN', 'A really good deal'],
  ['RECEIPT', 'The slip that shows what you paid'],
  ['PAYDAY', 'The best day of the pay period'],
  ['GROCERY', 'The store with the food aisles'],
  ['REFUND', 'Money back after a return'],
  ['DEPOSIT', 'Money put into the bank'],
  ['BALANCE', 'What is left in the account'],
  ['THRIFTY', 'Careful with every dollar'],
  ['NICKEL', 'Five-cent coin'],
  ['QUARTER', 'Twenty-five cent coin'],
  ['PIGGY', 'A ___ bank holds spare change'],
  ['PENNY', 'One-cent coin'],
  ['DOLLAR', 'One hundred cents'],
  ['PAYCHECK', 'What an employer hands you'],
  ['GOALS', 'What you are saving toward'],
  ['RAINY', 'Savings are for a ___ day'],
];

export function makeScramble(rng = Math.random, index = pickInt(rng, SCRAMBLE_WORDS.length)) {
  const [word, clue] = SCRAMBLE_WORDS[index % SCRAMBLE_WORDS.length];
  let tiles = word.split('');
  for (let i = 0; i < 20 && tiles.join('') === word; i++) tiles = shuffle(tiles, rng);
  return { word, clue, tiles };
}

/* ------------------------------------------------------------------ mini crossword */
// Each puzzle is three short words that cross. r/c is where the word starts; d is 'a' (across) or 'd' (down).

export const CROSSWORDS = [
  [
    { w: 'SAVE', r: 0, c: 0, d: 'a', clue: 'Put money aside for later' },
    { w: 'SPEND', r: 0, c: 0, d: 'd', clue: 'Use money to buy things' },
    { w: 'DIME', r: 4, c: 0, d: 'a', clue: 'Ten-cent coin' },
  ],
  [
    { w: 'BUDGET', r: 0, c: 0, d: 'a', clue: 'A plan for your money' },
    { w: 'GOAL', r: 0, c: 3, d: 'd', clue: 'Something you save up for' },
    { w: 'LOAN', r: 3, c: 3, d: 'a', clue: 'Borrowed money you pay back' },
  ],
  [
    { w: 'CASH', r: 0, c: 0, d: 'a', clue: 'Bills and coins' },
    { w: 'COIN', r: 0, c: 0, d: 'd', clue: 'A penny or a quarter' },
    { w: 'NEST', r: 3, c: 0, d: 'a', clue: 'A ___ egg is money saved for the future' },
  ],
  [
    { w: 'RENT', r: 0, c: 0, d: 'a', clue: 'Monthly payment to a landlord' },
    { w: 'TOTAL', r: 0, c: 3, d: 'd', clue: 'Everything added up' },
    { w: 'LIST', r: 4, c: 3, d: 'a', clue: 'Bring one to the grocery store' },
  ],
  [
    { w: 'BANK', r: 0, c: 0, d: 'a', clue: 'Where a checking account lives' },
    { w: 'BILL', r: 0, c: 0, d: 'd', clue: 'It arrives and asks to be paid' },
    { w: 'LESS', r: 3, c: 0, d: 'a', clue: 'Spend ___ than you earn' },
  ],
  [
    { w: 'PRICE', r: 0, c: 0, d: 'a', clue: 'What something costs' },
    { w: 'COUPON', r: 0, c: 3, d: 'd', clue: 'Clip one to save at the store' },
    { w: 'NEED', r: 5, c: 3, d: 'a', clue: 'A must-have, not a want' },
  ],
  [
    { w: 'MONEY', r: 0, c: 0, d: 'a', clue: 'Dollars and cents' },
    { w: 'YEAR', r: 0, c: 4, d: 'd', clue: 'Twelve months' },
    { w: 'SAVER', r: 3, c: 0, d: 'a', clue: 'Someone who puts money aside' },
  ],
  [
    { w: 'WAGE', r: 0, c: 0, d: 'a', clue: 'Pay for each hour worked' },
    { w: 'WANT', r: 0, c: 0, d: 'd', clue: 'Nice to have, but not a need' },
    { w: 'TIPS', r: 3, c: 0, d: 'a', clue: 'Extra money left for a server' },
  ],
];

/**
 * Lays a crossword out. Returns the grid size, the answer letter for every square, the numbered clues,
 * and the letter buttons to offer (the answer's letters plus a few extras, in ABC order).
 * Throws if two words disagree about a square (a mistake in the list above).
 */
export function layCrossword(words, rng = Math.random) {
  const cells = new Map(); // 'r,c' -> letter
  let rows = 0;
  let cols = 0;
  const placed = words.map((x) => {
    const at = [];
    for (let i = 0; i < x.w.length; i++) {
      const r = x.r + (x.d === 'd' ? i : 0);
      const c = x.c + (x.d === 'a' ? i : 0);
      const key = `${r},${c}`;
      if (cells.has(key) && cells.get(key) !== x.w[i]) throw new Error(`crossword words clash at ${key}`);
      cells.set(key, x.w[i]);
      at.push(key);
      rows = Math.max(rows, r + 1);
      cols = Math.max(cols, c + 1);
    }
    return { ...x, cells: at };
  });
  // Number the starting squares the usual way: left to right, top to bottom.
  const starts = [...new Set(placed.map((p) => p.cells[0]))].sort((a, b) => {
    const [ar, ac] = a.split(',').map(Number);
    const [br, bc] = b.split(',').map(Number);
    return ar - br || ac - bc;
  });
  const numbers = new Map(starts.map((key, i) => [key, i + 1]));
  const clues = placed
    .map((p) => ({ num: numbers.get(p.cells[0]), dir: p.d === 'a' ? 'Across' : 'Down', clue: p.clue, word: p.w, cells: p.cells }))
    .sort((a, b) => (a.dir === b.dir ? a.num - b.num : a.dir === 'Across' ? -1 : 1));
  const letters = new Set(cells.values());
  for (const extra of shuffle('ADEILMNORSTU'.split(''), rng)) {
    if (letters.size >= 10) break;
    letters.add(extra);
  }
  return { rows, cols, cells, numbers, clues, bank: [...letters].sort() };
}

export function makeCrossword(rng = Math.random, index = pickInt(rng, CROSSWORDS.length)) {
  return layCrossword(CROSSWORDS[index % CROSSWORDS.length], rng);
}

export const GAME_KINDS = ['sudoku', 'scramble', 'crossword'];
