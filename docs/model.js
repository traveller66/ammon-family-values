// DOM-free budget state. Amounts are integer cents. The only things ever stored are:
//   category records:  {t:'cat', n:label, k:'i'|'e', o:order, x:deleted?, u:changedAt}
//   value records:     {t:'val', c:categoryId, m:'YYYY-MM', f:'p'|'a', v:cents|null, u:changedAt}
// i.e. numbers tied to the field they belong to - no names, locations or user info.
// `u` is when the field was last changed (ms). It decides which copy wins when a budget file from family is brought in.

export const APP_NAME = 'Ammon Family Values';

// One small question each during guided setup: every income and every bill is its own item.
export const DEFAULT_CATEGORIES = {
  i: ['Paycheck 1', 'Paycheck 2', 'Other income'],
  e: ['Rent or mortgage', 'Electricity', 'Water and gas', 'Phone and internet', 'Groceries', 'Car payment', 'Gas and car care', 'Insurance', 'Dining out', 'Fun', 'Savings', 'Other'],
};

const HEX32 = /^[a-f0-9]{32}$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  return monthKey(new Date(y, mo - 1 + delta, 1));
}
export function monthLabel(m, locale) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

export const valLabel = (cat, month, field) => `v|${cat}|${month}|${field}`;
export const valPayload = (cat, month, field, cents, u = Date.now()) => ({ t: 'val', c: cat, m: month, f: field, v: cents, u });
export const catPayload = (name, kind, order, deleted = false, u = Date.now()) => ({ t: 'cat', n: name, k: kind, o: order, x: deleted ? 1 : 0, u });
const stamp = (u) => (Number.isSafeInteger(u) && u > 0 ? u : 0);

/** "12.5", "$1,200", "1200.00", "12,50" -> cents. Empty -> {ok:true, cents:null} (clears the field). */
export function parseMoney(input) {
  let t = String(input).replace(/[\s$€£]/g, '');
  if (t === '') return { ok: true, cents: null };
  if (!t.includes('.') && /^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.'); // European decimal comma
  t = t.replace(/,/g, '');
  if (!/^-?(\d+\.?\d{0,2}|\.\d{1,2})$/.test(t)) return { ok: false };
  const cents = Math.round(parseFloat(t) * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > 99_999_999_999) return { ok: false };
  return { ok: true, cents };
}

const fmtCache = new Map();
export function formatMoney(cents, currency = 'USD') {
  let f = fmtCache.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    fmtCache.set(currency, f);
  }
  return f.format((cents ?? 0) / 100);
}

/** Cents -> text for an input box ("" for empty, "1200" or "1200.50"). */
export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}

/**
 * Plain-language explanations for the guided setup. `ask` is the one-line "what am I being asked for";
 * `what` is the longer explanation behind the (i) button.
 */
export const HELP = {
  'paycheck 1': {
    ask: 'Net income: the first paycheck, after taxes',
    what: 'The take-home pay from one job for the whole month. That is the money that actually lands in the bank after taxes and deductions, not the bigger "gross" amount before taxes. Paid every two weeks? Add the month\'s paychecks together. If it changes from month to month, use a typical month.',
  },
  'paycheck 2': {
    ask: 'Net income: a second paycheck, after taxes',
    what: 'The take-home pay from a second job or a second person, for the whole month. Use the amount after taxes (net), not the gross amount before taxes. Only one paycheck in the family? Tap "We don\'t have this one".',
  },
  'rent or mortgage': {
    ask: 'Your monthly rent or mortgage payment',
    what: 'Just the rent or the mortgage payment itself. If property tax and home insurance are bundled into your mortgage payment, that is fine, leave them in. Electricity, water and the other bills each get their own question next.',
  },
  electricity: {
    ask: 'Your monthly electric bill',
    what: 'The electric bill for a typical month. If it swings a lot between summer and winter, use an average.',
  },
  'water and gas': {
    ask: 'Water, sewer, trash and natural gas bills',
    what: 'Add together the water, sewer, trash and natural gas bills for a typical month. If a bill comes every two or three months, divide it to get one month.',
  },
  'phone and internet': {
    ask: 'Cell phone and home internet bills',
    what: 'Every cell phone plan in the family plus home internet, added together for one month. Streaming services belong under "Fun".',
  },
  'car payment': {
    ask: 'Your monthly car loan or lease payments',
    what: 'The loan or lease payment for each vehicle, added together. Fuel and repairs are the next question, and car insurance goes under "Insurance".',
  },
  'gas and car care': {
    ask: 'Fuel, repairs, parking, tolls and fares',
    what: 'What it costs to get around apart from the car payment: fuel, oil changes, repairs, parking, tolls, and bus or rideshare fares. A rough monthly average is fine.',
  },
  paycheck: {
    ask: 'Net income: your take-home pay after taxes',
    what: 'This is the money that actually lands in your bank account after taxes and deductions, not the bigger "gross" amount before taxes. If more than one person gets paid, add all the paychecks together. If your pay changes from month to month, use a typical month.',
  },
  'other income': {
    ask: 'Other net income: extra money coming in, after taxes',
    what: 'Any other money that comes in, such as a side job, benefits, child support, interest, or regular gifts. Use the amount you actually receive (net), not the amount before taxes.',
  },
  housing: {
    ask: 'Your monthly housing cost',
    what: 'Rent or mortgage payment, plus HOA fees, property tax, and home insurance if you pay them monthly. Utilities come in the next step, so leave them out here.',
  },
  utilities: {
    ask: 'Your monthly utility bills, added together',
    what: 'Electric, gas, water, trash, internet, and phone bills added up for a typical month.',
  },
  groceries: {
    ask: 'Food and household supplies from the store',
    what: 'What you spend at the grocery store and on household supplies. Restaurants and takeout belong under "Dining out".',
  },
  transportation: {
    ask: 'Getting around: car payment, gas, repairs, fares',
    what: 'Car payment, gas, tolls, parking, repairs and maintenance, bus or rideshare fares. Car insurance goes under "Insurance".',
  },
  insurance: {
    ask: 'Insurance premiums you pay yourselves',
    what: 'Health, car, life, and renter\'s insurance premiums you pay each month, as long as they are not already taken out of your paycheck.',
  },
  'dining out': {
    ask: 'Restaurants, takeout, coffee, and delivery',
    what: 'Anything you buy that is already prepared: restaurants, fast food, coffee shops, and delivery apps.',
  },
  fun: {
    ask: 'Fun and entertainment',
    what: 'Streaming, hobbies, outings, movies, games, and anything else just for enjoyment.',
  },
  savings: {
    ask: 'Money you set aside this month',
    what: 'Savings, an emergency fund, or retirement contributions that you make yourselves. Contributions already taken out of your paycheck do not need to be counted again.',
  },
  other: {
    ask: 'Everything else that does not fit above',
    what: 'Gifts, clothing, medical co-pays, school costs, and other things that do not have their own item.',
  },
};

/** What the setup should say for one item and field ('p' = plan, 'a' = actual so far). */
export function helpFor(name, kind, field) {
  const known = HELP[String(name).trim().toLowerCase()];
  const ask = known?.ask ?? (kind === 'i' ? `Net income from "${name}" (after taxes)` : `Your spending on "${name}"`);
  const what =
    known?.what ??
    (kind === 'i'
      ? `Money that comes in from "${name}". Use the take-home (net) amount after taxes, not the gross amount before taxes.`
      : `Everything you spend on "${name}". A rough total is fine.`);
  const stage = field === 'p' ? 'This is your plan, an estimate for the month.' : 'This is what has actually happened so far this month.';
  const note =
    field === 'p'
      ? 'A rough number is fine, and you can change it any time.'
      : kind === 'i'
        ? 'Count money that has already arrived this month. Your bank deposits will tell you.'
        : 'Count money already spent this month. Your bank or card statements will tell you.';
  return { ask, what, stage, note };
}

export class Budget {
  constructor() {
    this.reset();
  }
  reset() {
    this.cats = new Map(); // id -> {id,name,kind,order,deleted,u}
    this.vals = new Map(); // 'cat|month|field' -> cents|null
    this.valU = new Map(); // 'cat|month|field' -> when it was last changed
  }

  /** Put one record into the budget. Returns false if it is not a valid record. */
  apply(rid, p) {
    if (!p || typeof p !== 'object') return false;
    if (p.t === 'cat') {
      if (!HEX32.test(rid) || typeof p.n !== 'string' || p.n.length > 40 || (p.k !== 'i' && p.k !== 'e') || !Number.isFinite(p.o)) return false;
      this.cats.set(rid, { id: rid, name: p.n, kind: p.k, order: p.o, deleted: !!p.x, u: stamp(p.u) });
      return true;
    }
    if (p.t === 'val') {
      if (!HEX32.test(p.c) || !MONTH_RE.test(p.m) || (p.f !== 'p' && p.f !== 'a')) return false;
      if (p.v !== null && !Number.isSafeInteger(p.v)) return false;
      const key = `${p.c}|${p.m}|${p.f}`;
      this.vals.set(key, p.v);
      this.valU.set(key, stamp(p.u));
      return true;
    }
    return false;
  }

  get(cat, month, field) {
    const v = this.vals.get(`${cat}|${month}|${field}`);
    return v === undefined ? null : v;
  }

  categories(kind) {
    return [...this.cats.values()]
      .filter((c) => c.kind === kind && !c.deleted)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }

  nextOrder(kind) {
    let max = -1;
    for (const c of this.cats.values()) if (c.kind === kind && c.order > max) max = c.order;
    return max + 1;
  }

  totals(month) {
    const t = { incomeP: 0, incomeA: 0, expenseP: 0, expenseA: 0 };
    for (const c of this.cats.values()) {
      if (c.deleted) continue;
      const p = this.get(c.id, month, 'p') ?? 0;
      const a = this.get(c.id, month, 'a') ?? 0;
      if (c.kind === 'i') {
        t.incomeP += p;
        t.incomeA += a;
      } else {
        t.expenseP += p;
        t.expenseA += a;
      }
    }
    return t;
  }
}

/* ------------------------------------------------------------------ budget files (export / import) */

/** Everything in the budget as plain data, ready to be locked into a budget file. Still only labels and numbers. */
export function exportData(budget, now = Date.now()) {
  const cats = [...budget.cats.values()].map((c) => ({ id: c.id, n: c.name, k: c.kind, o: c.order, x: c.deleted ? 1 : 0, u: c.u }));
  const vals = [];
  for (const [key, v] of budget.vals) {
    const [c, m, f] = key.split('|');
    if (budget.cats.has(c)) vals.push({ c, m, f, v, u: budget.valU.get(key) ?? 0 });
  }
  return { v: 1, at: now, cats, vals };
}

/** Checks the inside of a budget file and returns a clean copy. Throws if it is not a budget. */
export function cleanImport(data) {
  if (!data || typeof data !== 'object' || data.v !== 1 || !Array.isArray(data.cats) || !Array.isArray(data.vals)) {
    throw new Error('not a budget');
  }
  if (data.cats.length > 2000 || data.vals.length > 200000) throw new Error('too big');
  const probe = new Budget();
  const cats = [];
  for (const c of data.cats) {
    if (!c || typeof c !== 'object') continue;
    if (probe.apply(c.id, { t: 'cat', n: c.n, k: c.k, o: c.o, x: c.x })) cats.push({ id: c.id, n: c.n, k: c.k, o: c.o, x: c.x ? 1 : 0, u: stamp(c.u) });
  }
  const vals = [];
  for (const r of data.vals) {
    if (!r || typeof r !== 'object') continue;
    if (probe.apply('', { t: 'val', c: r.c, m: r.m, f: r.f, v: r.v })) vals.push({ c: r.c, m: r.m, f: r.f, v: r.v, u: stamp(r.u) });
  }
  return { v: 1, at: stamp(data.at), cats, vals };
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Works out what bringing in a budget file would change, without changing anything.
 * Rule: for every field, the copy that was changed most recently wins. Fields the file does not mention are left alone.
 * Items normally match by their id (both phones started from the same budget). If two phones were set up separately,
 * items with the same name are treated as the same item.
 * `lastShared` is when this phone last sent or brought in a file: a field changed on this phone since then, and changed
 * to something else in the file, is flagged `both` so the person can see it before agreeing.
 */
export function planMerge(budget, data, lastShared = 0) {
  const fileIds = new Set(data.cats.map((c) => c.id));
  const taken = new Set();
  const idMap = new Map(); // id in the file -> id on this phone
  const cats = [];
  const names = new Map(); // id on this phone -> name after the merge
  for (const c of budget.cats.values()) names.set(c.id, c.name);

  for (const c of data.cats) {
    const mine = budget.cats.get(c.id);
    if (mine) {
      idMap.set(c.id, c.id);
      taken.add(c.id);
      const differs = mine.name !== c.n || mine.kind !== c.k || mine.order !== c.o || mine.deleted !== !!c.x;
      if (differs && c.u > mine.u) {
        const change = c.x && !mine.deleted ? 'removed' : !c.x && mine.deleted ? 'added' : mine.name !== c.n ? 'renamed' : 'moved';
        cats.push({ id: c.id, payload: catPayload(c.n, c.k, c.o, !!c.x, c.u), change, name: c.n, was: mine.name });
        names.set(c.id, c.n);
      }
      continue;
    }
    if (c.x) continue; // an item that was removed there and never existed here
    const twin = [...budget.cats.values()].find((m) => !m.deleted && m.kind === c.k && sameName(m.name, c.n) && !fileIds.has(m.id) && !taken.has(m.id));
    if (twin) {
      idMap.set(c.id, twin.id);
      taken.add(twin.id);
      continue;
    }
    idMap.set(c.id, c.id);
    cats.push({ id: c.id, payload: catPayload(c.n, c.k, c.o, false, c.u), change: 'added', name: c.n });
    names.set(c.id, c.n);
  }

  const vals = [];
  let kept = 0;
  for (const r of data.vals) {
    const c = idMap.get(r.c);
    if (!c) continue;
    const key = `${c}|${r.m}|${r.f}`;
    const has = budget.vals.has(key);
    const mine = has ? budget.vals.get(key) : null;
    if (mine === r.v) continue;
    const mineU = has ? budget.valU.get(key) ?? 0 : -1;
    if (r.u <= mineU) {
      if (mine !== null) kept++;
      continue;
    }
    if (!has && r.v === null) continue;
    const kind = budget.cats.get(c)?.kind ?? data.cats.find((x) => x.id === r.c)?.k ?? 'e';
    vals.push({
      c, m: r.m, f: r.f, kind,
      name: names.get(c) ?? '',
      from: mine,
      to: r.v,
      both: mine !== null && mineU > lastShared,
      payload: valPayload(c, r.m, r.f, r.v, r.u),
    });
  }
  vals.sort((a, b) => (a.m < b.m ? 1 : a.m > b.m ? -1 : 0) || a.name.localeCompare(b.name) || (a.f < b.f ? 1 : -1));
  return { cats, vals, kept, total: cats.length + vals.length };
}
