// The reward puzzles: a hard 9 x 9 sudoku, a three-word scramble of long words and phrases, and a big crossword.
// No DOM in here: just making and checking puzzles.

const pickInt = (rng, n) => Math.floor(rng() * n);
export function shuffle(list, rng = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = pickInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ sudoku (9 x 9, hard) */
// Every row, every column and every 3 x 3 box holds 1 to 9 exactly once.
// Every puzzle has exactly one answer and can be finished by reasoning alone (no guessing), but it needs more
// than the easy "only one number fits here" moves: at least one of the harder techniques (see gradeSudoku).

const ALL = 0x1ff;
const POP = Uint8Array.from({ length: 512 }, (_, m) => { let n = 0; for (let x = m; x; x &= x - 1) n++; return n; });
const digitOf = (bit) => 32 - Math.clz32(bit); // 1 -> 1, 2 -> 2, 4 -> 3 ...
const ROW = Uint8Array.from({ length: 81 }, (_, i) => Math.floor(i / 9));
const COL = Uint8Array.from({ length: 81 }, (_, i) => i % 9);
const BOX = Uint8Array.from({ length: 81 }, (_, i) => Math.floor(ROW[i] / 3) * 3 + Math.floor(COL[i] / 3));
const UNITS = [
  ...Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => r * 9 + c)),
  ...Array.from({ length: 9 }, (_, c) => Array.from({ length: 9 }, (_, r) => r * 9 + c)),
  ...Array.from({ length: 9 }, (_, b) => Array.from({ length: 9 }, (_, k) => (Math.floor(b / 3) * 3 + Math.floor(k / 3)) * 9 + (b % 3) * 3 + (k % 3))),
];
const PEERS = Array.from({ length: 81 }, (_, i) => [...new Set([...UNITS[ROW[i]], ...UNITS[9 + COL[i]], ...UNITS[18 + BOX[i]]])].filter((j) => j !== i));

/** Squares (as 'row,col') that break the rules because the same number appears twice in a row, column or box. Works for 4 x 4 and 9 x 9. */
export function sudokuClashes(grid) {
  const n = grid.length;
  const b = Math.round(Math.sqrt(n));
  const bad = new Set();
  const groups = [];
  for (let i = 0; i < n; i++) {
    groups.push(Array.from({ length: n }, (_, j) => [i, j]));
    groups.push(Array.from({ length: n }, (_, j) => [j, i]));
    const r0 = Math.floor(i / b) * b;
    const c0 = (i % b) * b;
    groups.push(Array.from({ length: n }, (_, k) => [r0 + Math.floor(k / b), c0 + (k % b)]));
  }
  for (const g of groups) {
    const seen = new Map();
    for (const [r, c] of g) {
      const v = grid[r][c];
      if (!v) continue;
      if (seen.has(v)) {
        bad.add(`${r},${c}`);
        bad.add(seen.get(v));
      } else seen.set(v, `${r},${c}`);
    }
  }
  return bad;
}
export const sudokuSolved = (grid) => grid.every((row) => row.every((v) => v >= 1 && v <= grid.length)) && sudokuClashes(grid).size === 0;

/** How many answers a 9 x 9 puzzle (81 numbers, 0 = empty) has, counting no higher than `limit`. */
export function countSudokuSolutions(cells, limit = 2) {
  const g = Int8Array.from(cells);
  const rows = new Uint16Array(9);
  const cols = new Uint16Array(9);
  const boxes = new Uint16Array(9);
  for (let i = 0; i < 81; i++) {
    if (!g[i]) continue;
    const bit = 1 << (g[i] - 1);
    if ((rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & bit) return 0;
    rows[ROW[i]] |= bit;
    cols[COL[i]] |= bit;
    boxes[BOX[i]] |= bit;
  }
  let count = 0;
  const rec = () => {
    let best = -1;
    let bestMask = 0;
    let bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const m = ALL & ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]);
      if (POP[m] < bestN) {
        best = i;
        bestMask = m;
        bestN = POP[m];
        if (bestN <= 1) break;
      }
    }
    if (best < 0) return ++count >= limit;
    for (let m = bestMask; m; m &= m - 1) {
      const bit = m & -m;
      g[best] = digitOf(bit);
      rows[ROW[best]] |= bit;
      cols[COL[best]] |= bit;
      boxes[BOX[best]] |= bit;
      const stop = rec();
      rows[ROW[best]] &= ~bit;
      cols[COL[best]] &= ~bit;
      boxes[BOX[best]] &= ~bit;
      if (stop) {
        g[best] = 0;
        return true;
      }
    }
    g[best] = 0;
    return false;
  };
  rec();
  return count;
}

/** A completely filled, random, valid 9 x 9 grid (81 numbers). */
function fullGrid(rng) {
  const g = new Int8Array(81);
  const rows = new Uint16Array(9);
  const cols = new Uint16Array(9);
  const boxes = new Uint16Array(9);
  const rec = (i) => {
    if (i === 81) return true;
    const m = ALL & ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]);
    const bits = [];
    for (let x = m; x; x &= x - 1) bits.push(x & -x);
    for (const bit of shuffle(bits, rng)) {
      g[i] = digitOf(bit);
      rows[ROW[i]] |= bit;
      cols[COL[i]] |= bit;
      boxes[BOX[i]] |= bit;
      if (rec(i + 1)) return true;
      rows[ROW[i]] &= ~bit;
      cols[COL[i]] &= ~bit;
      boxes[BOX[i]] &= ~bit;
    }
    g[i] = 0;
    return false;
  };
  rec(0);
  return [...g];
}

/**
 * Solves the way a person would, and reports the hardest technique needed:
 *   1 = singles (the only number that fits a square, or the only square in a row/column/box for a number)
 *   2 = locked candidates (a number confined to one line inside a box, or to one box inside a line)
 *   3 = naked pairs or triples and hidden pairs
 * `solved` is false when these are not enough (the puzzle would need guessing or rarer tricks).
 */
export function gradeSudoku(cells) {
  const v = Int8Array.from(cells);
  const cand = new Uint16Array(81);
  for (let i = 0; i < 81; i++) {
    if (v[i]) continue;
    let m = ALL;
    for (const p of PEERS[i]) if (v[p]) m &= ~(1 << (v[p] - 1));
    cand[i] = m;
  }
  const place = (i, d) => {
    v[i] = d;
    cand[i] = 0;
    const bit = 1 << (d - 1);
    for (const p of PEERS[i]) cand[p] &= ~bit;
  };
  const drop = (cells2, mask) => {
    let changed = false;
    for (const i of cells2) {
      if (!v[i] && cand[i] & mask) {
        cand[i] &= ~mask;
        changed = true;
      }
    }
    return changed;
  };
  const lockedCandidates = () => {
    for (let b = 0; b < 9; b++) {
      const box = UNITS[18 + b];
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        const at = box.filter((i) => !v[i] && cand[i] & bit);
        if (at.length < 2) continue;
        if (at.every((i) => ROW[i] === ROW[at[0]]) && drop(UNITS[ROW[at[0]]].filter((i) => BOX[i] !== b), bit)) return true;
        if (at.every((i) => COL[i] === COL[at[0]]) && drop(UNITS[9 + COL[at[0]]].filter((i) => BOX[i] !== b), bit)) return true;
      }
    }
    for (let u = 0; u < 18; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        const at = UNITS[u].filter((i) => !v[i] && cand[i] & bit);
        if (at.length < 2 || !at.every((i) => BOX[i] === BOX[at[0]])) continue;
        if (drop(UNITS[18 + BOX[at[0]]].filter((i) => !UNITS[u].includes(i)), bit)) return true;
      }
    }
    return false;
  };
  const subsets = () => {
    for (const unit of UNITS) {
      const open = unit.filter((i) => !v[i]);
      for (const size of [2, 3]) {
        const small = open.filter((i) => POP[cand[i]] <= size);
        const pick = (start, chosen, mask) => {
          if (chosen.length === size) return POP[mask] === size && drop(open.filter((i) => !chosen.includes(i)), mask);
          for (let k = start; k < small.length; k++) if (pick(k + 1, [...chosen, small[k]], mask | cand[small[k]])) return true;
          return false;
        };
        if (pick(0, [], 0)) return true;
      }
      for (let d1 = 0; d1 < 9; d1++) {
        const a = open.filter((i) => cand[i] & (1 << d1));
        if (a.length !== 2) continue;
        for (let d2 = d1 + 1; d2 < 9; d2++) {
          const b = open.filter((i) => cand[i] & (1 << d2));
          if (b.length !== 2 || b[0] !== a[0] || b[1] !== a[1]) continue;
          const keep = (1 << d1) | (1 << d2);
          if (a.some((i) => cand[i] & ~keep)) {
            for (const i of a) cand[i] &= keep;
            return true;
          }
        }
      }
    }
    return false;
  };
  let level = 0;
  for (;;) {
    if (v.every((x) => x)) return { solved: true, level, cells: [...v] };
    let moved = false;
    for (let i = 0; i < 81; i++) {
      if (!v[i] && POP[cand[i]] === 1) {
        place(i, digitOf(cand[i]));
        moved = true;
      }
    }
    if (!moved) {
      for (const unit of UNITS) {
        for (let d = 0; d < 9; d++) {
          const bit = 1 << d;
          let where = -1;
          let n = 0;
          for (const i of unit) {
            if (!v[i] && cand[i] & bit) {
              n++;
              where = i;
            }
          }
          if (n === 1) {
            place(where, d + 1);
            moved = true;
          }
        }
      }
    }
    if (moved) {
      level = Math.max(level, 1);
      continue;
    }
    if (lockedCandidates()) {
      level = Math.max(level, 2);
      continue;
    }
    if (subsets()) {
      level = Math.max(level, 3);
      continue;
    }
    return { solved: false, level, cells: [...v] };
  }
}

const to2D = (flat) => Array.from({ length: 9 }, (_, r) => flat.slice(r * 9, r * 9 + 9));

/**
 * A fresh hard puzzle: exactly one answer, about 22 to 32 numbers given, solvable by reasoning,
 * and needing at least one technique beyond singles.
 */
export function makeSudoku(rng = Math.random) {
  let fallback = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const solution = fullGrid(rng);
    const puzzle = [...solution];
    // Take numbers away in random order for as long as the answer stays unique.
    for (const i of shuffle([...Array(81).keys()], rng)) {
      const keep = puzzle[i];
      puzzle[i] = 0;
      if (countSudokuSolutions(puzzle) !== 1) puzzle[i] = keep;
    }
    // If reasoning alone gets stuck, give back one number where it got stuck, and try again.
    let grade = gradeSudoku(puzzle);
    while (!grade.solved) {
      const stuck = grade.cells.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
      const i = stuck[pickInt(rng, stuck.length)];
      puzzle[i] = solution[i];
      grade = gradeSudoku(puzzle);
    }
    const out = { puzzle: to2D(puzzle), solution: to2D(solution), level: grade.level, givens: puzzle.filter((x) => x).length };
    if (grade.level >= 2) return out;
    fallback = out;
  }
  return fallback;
}

/* ------------------------------------------------------------------ word scramble (three long words or phrases per round) */
// The answer may be two words; the letters of both are mixed together.

export const SCRAMBLE_WORDS = [
  ['COMPOUND INTEREST', 'Earnings that go on to earn earnings of their own'],
  ['HOUSEHOLD', 'Everyone living under one roof'],
  ['CREDIT SCORE', 'Three-digit number lenders peek at'],
  ['DEPRECIATION', 'Why a new car is worth less the minute it leaves the lot'],
  ['EMERGENCY FUND', 'Money kept for the repair nobody saw coming'],
  ['UTILITIES', 'Water, power and gas bills, all together'],
  ['MORTGAGE PAYMENT', 'Monthly check that slowly buys the house'],
  ['CONTENTMENT', 'Being happy with what you already have'],
  ['TAX REFUND', 'Spring money back from the government'],
  ['AMORTIZATION', 'Paying a loan down on a schedule of equal installments'],
  ['GROCERY LIST', 'Paper that keeps the cart honest'],
  ['FRUGALITY', 'The habit of never wasting a dollar'],
  ['INSURANCE PREMIUM', 'The regular price of being covered'],
  ['RETIREMENT', 'The long vacation a 401(k) pays for'],
  ['SINKING FUND', 'Savings set aside bit by bit for a cost you know is coming'],
  ['REIMBURSEMENT', 'Getting paid back for something you bought for someone else'],
  ['CHECKING ACCOUNT', 'Where a debit card draws from'],
  ['GENEROSITY', 'Quality of a cheerful giver'],
  ['WITHHOLDING', 'Tax taken out of each paycheck before you ever see it'],
  ['ENVELOPE SYSTEM', 'Budgeting with cash split into labeled paper packets'],
  ['DEDUCTIBLE', 'What you pay before the insurance company pays'],
  ['THRIFT STORE', 'Secondhand shop where bargains hide'],
  ['BENEFICIARY', 'Person named to receive the money someday'],
  ['MEAL PLANNING', "Deciding the week's dinners before shopping"],
  ['APPRECIATION', 'Rise in value over time, or heartfelt gratitude'],
  ['STOCK MARKET', 'Where shares are bought and sold'],
  ['PROSPERITY', 'Thriving and doing well, financially'],
  ['COUPON CLIPPING', 'Snipping savings out of the Sunday paper'],
  ['DIVERSIFY', "Spread investments around so one flop can't sink you"],
  ['DOWN PAYMENT', 'Money paid up front when buying a house'],
  ['SPREADSHEET', 'Grid of rows and columns for crunching numbers'],
  ['FAMILY DINNER', 'Everyone at the table at the same time'],
  ['COLLATERAL', 'Property pledged to secure a loan'],
  ['CLOSING COSTS', 'Fees due when a home purchase is finalized'],
  ['PORTFOLIO', "Collection of someone's investments"],
  ['SAVINGS BOND', 'Government IOU often given to kids as a gift'],
  ['ANNIVERSARY', 'Yearly celebration of a wedding day'],
  ['PROPERTY TAX', 'Yearly bill just for owning a home'],
  ['INVESTMENT', 'Money put to work so it can grow'],
  ['FINANCIAL GOALS', 'Targets a budget aims at'],
  ['GRANDPARENTS', "Mom's mom and dad, for example"],
  ['HOME EQUITY', "The part of the house that's truly yours"],
  ['SPENDING PLAN', 'Another name for a budget'],
  ['INTEREST RATE', 'Percentage charged for borrowing'],
  ['BALANCE SHEET', 'Snapshot of assets and liabilities'],
  ['PIGGY BANK', 'Ceramic saver with a coin slot on its back'],
  ['HEIRLOOM', 'Treasure passed down the generations'],
  ['GAME NIGHT', 'Evening of cards and board play together'],
];

export const SCRAMBLE_ROUND = 3; // words per puzzle

/** One round: three long words or phrases in a row. Each has its letters mixed (never in the right order). */
export function makeScramble(rng = Math.random, index = pickInt(rng, SCRAMBLE_WORDS.length)) {
  const items = [];
  for (let k = 0; k < SCRAMBLE_ROUND; k++) {
    const [answer, clue] = SCRAMBLE_WORDS[(index * SCRAMBLE_ROUND + k) % SCRAMBLE_WORDS.length];
    const word = answer.replace(/ /g, '');
    const lengths = answer.split(' ').map((w) => w.length);
    let tiles = word.split('');
    for (let i = 0; i < 20 && tiles.join('') === word; i++) tiles = shuffle(tiles, rng);
    items.push({ answer, word, lengths, clue, tiles });
  }
  return { items };
}

/* ------------------------------------------------------------------ crossword (big, hard clues) */
// A fresh grid every time: up to about 20 words picked from this list and woven together so every word crosses another.

export const CROSSWORD_WORDS = [
  // money
  ['LEDGER', 'Book that gets balanced but is never read for fun'],
  ['ESCROW', 'Account a neutral party holds until closing'],
  ['ANNUITY', 'Insurance product that pays out year after year'],
  ['TITHE', 'One-tenth, traditionally'],
  ['LIEN', 'Legal claim against a property'],
  ['AUDIT', 'Close look from the IRS'],
  ['ACCRUE', 'Build up over time, as interest'],
  ['ARREARS', 'In ___ (behind on payments)'],
  ['FISCAL', '___ year (it may not start in January)'],
  ['SOLVENT', 'In the black, or able to dissolve things'],
  ['MORTGAGE', 'Home loan whose name comes from Old French for "death pledge"'],
  ['EQUITY', 'Home value minus what is still owed'],
  ['PRINCIPAL', 'Amount borrowed, or the head of a school'],
  ['DIVIDEND', "Shareholder's cut of the profits"],
  ['INFLATION', 'Why a candy bar costs more than it did in Grandpa\'s day'],
  ['LIQUID', 'Easily turned into cash, as assets'],
  ['TARIFF', 'Tax on imports'],
  ['BARTER', 'Swap goods without cash'],
  ['SURPLUS', 'More than enough, budget-wise'],
  ['DEFICIT', 'Shortfall'],
  ['FRUGAL', 'Careful with every dollar'],
  ['MISER', 'Coin hoarder'],
  ['PAYROLL', "A company's list of who gets paid"],
  ['INVOICE', 'Bill sent by a business'],
  ['REBATE', 'Money back after mailing in a form'],
  ['RECEIPT', 'Paper proof of purchase'],
  ['STIPEND', "Fixed allowance, like an intern's"],
  ['PENSION', 'Retirement check from a former employer'],
  ['BUDGET', 'Plan that tells every dollar where to go'],
  ['THRIFT', 'Economy, or a kind of secondhand store'],
  ['CREDIT', 'Opposite of debit'],
  ['DEBIT', 'Card tied straight to checking'],
  ['COLLATERAL', 'Security pledged against a loan'],
  ['AMORTIZE', 'Pay off a loan bit by bit'],
  ['FORECLOSE', 'Take back a house after missed payments'],
  ['INTEREST', 'Cost of borrowing, or curiosity'],
  ['BULLION', 'Gold in bars'],
  ['MINT', 'Coin factory, or a breath freshener'],
  ['SPLURGE', 'Big indulgent spend'],
  ['HAGGLE', 'Bargain at a flea market'],
  ['APPRAISE', 'Estimate the value of'],
  ['ASSETS', 'Balance sheet pluses'],
  ['CAPITAL', 'Startup money, or a seat of government'],
  ['YIELD', "Give way, or a bond's return"],
  ['BROKE', 'Flat ___ (penniless)'],
  ['TENDER', 'Legal ___ (money)'],
  ['NICKEL', 'Coin with Monticello on the back'],
  ['DIME', 'Coin with Franklin Roosevelt on it'],
  ['QUARTER', 'Washington coin, or one-fourth'],
  ['PENNY', 'Lincoln coin'],
  ['EURO', 'Currency in both Rome and Paris'],
  ['YEN', 'Tokyo cash, or a craving'],
  ['PESO', 'Money in Mexico City'],
  ['RUPEE', 'Money in Mumbai'],
  ['POUND', 'Sterling, or hammer away'],
  ['FRANC', 'Currency still used in Switzerland'],
  ['KRONA', 'Money in Stockholm'],
  ['IOU', 'Note promising payment'],
  ['DEBT', "What's owed"],
  ['LOAN', 'Borrowed sum'],
  ['RENT', 'Monthly check to a landlord'],
  ['WAGE', 'Hourly pay'],
  ['FUND', 'Pool of money for a purpose'],
  ['EARN', 'Bring home, as pay'],
  ['OWE', 'Be in the red to'],
  ['NET', 'Take-home, after deductions'],
  ['GROSS', 'Before deductions, or yucky'],
  ['TIP', "Server's extra, or a helpful hint"],
  ['FEE', 'Charge for a service'],
  ['TAX', 'April burden'],
  // family and home
  ['NEPHEW', "Brother's son"],
  ['NIECE', "Sister's daughter"],
  ['COUSIN', "Aunt's son or daughter"],
  ['SPOUSE', 'Better half'],
  ['SIBLING', 'Brother or sister'],
  ['ANCESTOR', 'Far-back branch on the family tree'],
  ['HEIRLOOM', 'Treasure passed down the generations'],
  ['HOUSEHOLD', 'Everyone under one roof'],
  ['PANTRY', 'Room for canned goods'],
  ['CUPBOARD', "Old Mother Hubbard's was bare"],
  ['CASSEROLE', 'Potluck staple in a baking dish'],
  ['LEFTOVERS', "Tomorrow's lunch from tonight's dinner"],
  ['LAUNDRY', 'Chore that is never all done'],
  ['CHORES', 'Jobs that earn an allowance'],
  ['REUNION', 'Family gathering after years apart'],
  ['HEARTH', 'Fireside floor; a symbol of home'],
  ['ATTIC', 'Room under the rafters'],
  ['CELLAR', 'Below-ground room for root vegetables'],
  ['PORCH', 'Spot for a swing and a rocking chair'],
  ['GARAGE', 'Where the car spends the night'],
  ['AUNT', "Uncle's wife"],
  ['KIN', 'Family'],
  ['HEIR', 'One who inherits'],
  ['TWIN', 'Sibling with the same birthday'],
  ['ADOPT', 'Welcome into the family for good'],
  ['ELOPE', 'Wed without the big fuss'],
  ['NEST', 'Where the birds live, or a kind of egg for retirement'],
  ['DOOR', 'Entry with a knob'],
  ['ROOF', 'Shingled house topper'],
  ['YARD', 'Three feet, or the lawn'],
  // the world
  ['ORBIT', 'Path around the sun'],
  ['ECLIPSE', "When the moon steals the sun's spotlight"],
  ['EQUATOR', 'Zero degrees latitude'],
  ['GLACIER', 'River of ice'],
  ['TUNDRA', 'Treeless Arctic plain'],
  ['DELTA', 'Where the Nile fans out into the sea'],
  ['CANYON', 'Grand one in Arizona'],
  ['OASIS', 'Palm-fringed desert stop'],
  ['ATLAS', 'Book of maps, or a Titan holding up the sky'],
  ['ISTHMUS', 'Narrow land bridge, like Panama'],
  ['ARCHIPELAGO', 'Island chain, like the Philippines'],
  ['PENINSULA', 'Florida, geographically'],
  ['MERIDIAN', 'Line of longitude'],
  ['COMPASS', 'Its needle points north'],
  ['VOLCANO', 'Vesuvius, for one'],
  ['TORNADO', 'Twister'],
  ['MONSOON', 'Seasonal wind that brings South Asia its rains'],
  ['EMBER', 'Last glow of a campfire'],
  ['ECHO', 'Sound that comes back from a canyon wall'],
  ['ORE', 'Rock worth mining'],
  ['ERA', 'Long stretch of history'],
  // arts and music
  ['ANTHEM', 'Song before the first pitch'],
  ['SONNET', 'Shakespeare wrote 154 of these'],
  ['HAIKU', '5-7-5 creation'],
  ['LIMERICK', 'Five-line verse with an AABBA rhyme'],
  ['FABLE', 'Aesop tale with a moral'],
  ['SAGA', 'Norse tale of heroes'],
  ['EPIC', 'Beowulf, for one'],
  ['NOVEL', 'Fresh and new, or a long story'],
  ['OPERA', "It isn't over till a certain lady sings"],
  ['ARIA', "Diva's showstopper"],
  ['TEMPO', 'Allegro or adagio, e.g.'],
  ['CHORD', 'C-E-G, for one'],
  ['OCTAVE', 'Do-to-do span'],
  ['CELLO', "Yo-Yo Ma's instrument"],
  ['OBOE', 'Instrument that gives the orchestra its tuning note'],
  ['PIANO', 'It has 88 keys but opens no doors'],
  ['EASEL', 'Stand for a still life?'],
  ['FRESCO', 'Painting on wet plaster'],
  ['MOSAIC', 'Picture made of tiny tiles'],
  // science
  ['ATOM', 'Smallest bit of an element'],
  ['PROTON', 'Nucleus resident with a positive outlook?'],
  ['MOLECULE', 'Two or more atoms bonded together'],
  ['OXYGEN', 'Element number 8'],
  ['CARBON', 'Element in both diamonds and pencil "lead"'],
  ['HELIUM', 'Gas that makes voices squeaky'],
  ['NEON', 'Gas that lights up Las Vegas'],
  ['MAGNET', 'It attracts iron'],
  ['GRAVITY', 'Force that keeps you grounded'],
  ['PRISM', 'Triangular rainbow maker'],
  ['FOSSIL', 'Very old-timer in a museum?'],
  // nature
  ['NECTAR', "Drink of the Greek gods, or a bee's haul"],
  ['CACTUS', 'Saguaro, for one'],
  ['ACORN', "A mighty oak's humble start"],
  ['WILLOW', 'Tree that weeps'],
  ['TULIP', 'Bulb behind a famous Dutch market crash in 1637'],
  ['ORCHID', 'Flower that vanilla comes from'],
  ['FALCON', 'Peregrine, for one'],
  ['PELICAN', 'Bird whose bill can hold more than its belly'],
  ['OTTER', 'Sea swimmer that uses a rock as a tool'],
  ['BEAVER', 'Busy dam builder'],
  ['LLAMA', 'Andean animal known to spit'],
  ['MOOSE', 'Largest member of the deer family'],
  ['PLATYPUS', 'Mammal that lays eggs'],
  ['GIRAFFE', 'Animal with seven neck bones, the same number as yours'],
  ['OWL', "Night hunter that can't move its eyes"],
  ['EMU', 'Flightless Australian bird'],
  ['ELK', 'Wapiti'],
  ['EEL', 'Slippery swimmer'],
  ['OAK', 'Tree from an acorn'],
  ['ELM', 'Shade tree on many a Main Street'],
  ['IVY', 'Climber on old college walls'],
  ['IRIS', 'Part of the eye, or a flower'],
  ['SAGE', 'Wise one, or an herb'],
  ['OPAL', 'October birthstone'],
  ['ONYX', 'Black gem'],
  ['RUBY', 'July birthstone'],
  ['PEARL', 'June birthstone an oyster makes'],
  ['AMBER', 'Fossilized tree resin'],
  // kitchen
  ['COLANDER', 'Bowl full of holes, on purpose'],
  ['SPATULA', 'Flipper in the kitchen'],
  ['LADLE', 'Big dipper, in the kitchen?'],
  ['WHISK', 'Kitchen tool that beats everything?'],
  ['SKILLET', 'Cast-iron cooker'],
  ['BAGEL', 'Roll with a hole, boiled before baking'],
  ['PRETZEL', 'Knot you can eat'],
  ['WAFFLE', 'Hem and haw, or a gridded breakfast'],
  ['OMELET', "Can't be made without breaking a few eggs"],
  ['CINNAMON', 'Tree bark used as a spice'],
  ['NUTMEG', 'Seed grated over eggnog'],
  ['PAPRIKA', 'Red powder in goulash'],
  ['VANILLA', 'Second-priciest spice, after saffron'],
  ['ALMOND', 'Marzipan nut'],
  ['AVOCADO', 'Guacamole base that is technically a berry'],
  ['LEMON', "Car that won't stop breaking down"],
  ['RAISIN', 'Grape after too long in the sun'],
  ['PRUNE', 'Trim a hedge, or a wrinkled plum'],
  ['OLIVE', 'Martini garnish, or a drab green'],
  ['GARLIC', 'Bulb said to keep vampires away'],
  ['DILL', 'Pickle herb'],
  ['KALE', 'Leafy green with a health halo'],
  ['PEAR', 'Fruit shaped like a light bulb'],
  ['PLUM', 'Purple fruit, or a choice job'],
  ['YAM', 'Thanksgiving tuber'],
  ['OAT', 'Grain in granola'],
  ['RYE', 'Grain in a deli bread'],
  ['TEA', 'Afternoon drink in England'],
  ['STEW', 'Slow-cooked dish, or fret'],
  ['OVEN', 'Where the roast goes'],
];

export const CROSSWORD_SIZE = { rows: 13, cols: 11 }; // fits a phone screen side to side
export const CROSSWORD_TARGET = 24; // words per grid

/**
 * Lays a crossword out. `words` are { w, r, c, d: 'a'|'d', clue }. Returns the grid size, the answer letter for
 * every square and the numbered clues. Throws if two words disagree about a square.
 */
export function layCrossword(words) {
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
  return { rows, cols, cells, numbers, clues };
}

/** Weaves words from `list` into a grid no bigger than `size`. Every word crosses at least one other; no stray words form. */
export function buildCrossword(list = CROSSWORD_WORDS, rng = Math.random, { size = CROSSWORD_SIZE, target = CROSSWORD_TARGET } = {}) {
  const R = size.rows;
  const C = size.cols;
  const fits = list.filter(([w]) => w.length <= Math.max(R, C));
  let best = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const grid = Array.from({ length: R }, () => Array(C).fill(''));
    const used = Array.from({ length: R }, () => Array.from({ length: C }, () => ({ a: false, d: false })));
    const at = (r, c) => (r >= 0 && r < R && c >= 0 && c < C ? grid[r][c] : '');
    const words = [];
    const put = (w, r, c, d, clue) => {
      for (let i = 0; i < w.length; i++) {
        const rr = r + (d === 'd' ? i : 0);
        const cc = c + (d === 'a' ? i : 0);
        grid[rr][cc] = w[i];
        used[rr][cc][d] = true;
      }
      words.push({ w, r, c, d, clue });
    };
    // How many squares `w` would share with words already down, or -1 if it cannot go there.
    const crossings = (w, r, c, d) => {
      const dr = d === 'd' ? 1 : 0;
      const dc = d === 'a' ? 1 : 0;
      const endR = r + dr * (w.length - 1);
      const endC = c + dc * (w.length - 1);
      if (r < 0 || c < 0 || endR >= R || endC >= C) return -1;
      if (at(r - dr, c - dc) || at(endR + dr, endC + dc)) return -1;
      let n = 0;
      for (let i = 0; i < w.length; i++) {
        const rr = r + dr * i;
        const cc = c + dc * i;
        const here = grid[rr][cc];
        if (here) {
          if (here !== w[i] || used[rr][cc][d]) return -1;
          n++;
        } else if (at(rr + dc, cc + dr) || at(rr - dc, cc - dr)) return -1; // would touch a word side by side
      }
      return n === w.length ? -1 : n;
    };
    // Longer words first (with some randomness) so the grid fills with meaty answers, not just three-letter ones.
    const pool = shuffle(fits, rng)
      .map((x) => [x, x[0].length + rng() * 6])
      .sort((a, b) => b[1] - a[1])
      .map(([x]) => x);
    const first = pool.findIndex(([w]) => w.length >= 7 && w.length <= C);
    const [w0, clue0] = pool.splice(Math.max(first, 0), 1)[0];
    put(w0, Math.floor(R / 2), pickInt(rng, C - w0.length + 1), 'a', clue0);
    // Keep going through the pool, adding each word where it crosses the most, until the grid is full enough.
    for (let pass = 0; pass < 3 && words.length < target; pass++) {
      for (let k = 0; k < pool.length && words.length < target; k++) {
        const [w, clue] = pool[k];
        if (!w || words.some((x) => x.w === w)) continue;
        let spots = [];
        let most = 0;
        for (let r = 0; r < R; r++) {
          for (let c = 0; c < C; c++) {
            if (!grid[r][c]) continue;
            for (let i = 0; i < w.length; i++) {
              if (w[i] !== grid[r][c]) continue;
              for (const d of ['a', 'd']) {
                const sr = d === 'd' ? r - i : r;
                const sc = d === 'a' ? c - i : c;
                const n = crossings(w, sr, sc, d);
                if (n < 1) continue;
                if (n > most) {
                  most = n;
                  spots = [];
                }
                if (n === most) spots.push([sr, sc, d]);
              }
            }
          }
        }
        if (!spots.length) continue;
        const [sr, sc, d] = spots[pickInt(rng, spots.length)];
        put(w, sr, sc, d, clue);
        pool[k] = [];
      }
    }
    // Trim the empty edges.
    let top = R;
    let left = C;
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (grid[r][c]) { top = Math.min(top, r); left = Math.min(left, c); }
    const shifted = words.map((x) => ({ ...x, r: x.r - top, c: x.c - left }));
    const filled = grid.flat().filter(Boolean).length;
    const score = words.length * 8 + filled;
    if (!best || score > best.score) best = { score, words: shifted };
    if (words.length >= target) break;
  }
  return best.words;
}

export function makeCrossword(rng = Math.random) {
  return layCrossword(buildCrossword(CROSSWORD_WORDS, rng));
}

export const GAME_KINDS = ['sudoku', 'scramble', 'crossword'];
