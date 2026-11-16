// DOM-free budget state. Amounts are integer cents. The only things ever stored are:
//   category records:  {t:'cat', n:label, k:'i'|'e', o:order, x:deleted?}
//   value records:     {t:'val', c:categoryId, m:'YYYY-MM', f:'p'|'a', v:cents|null}
// i.e. numbers tied to the field they belong to - no names, locations or user info.

export const APP_NAME = 'Ammon Family Values';

export const DEFAULT_CATEGORIES = {
  i: ['Paycheck', 'Other income'],
  e: ['Housing', 'Utilities', 'Groceries', 'Transportation', 'Insurance', 'Dining out', 'Fun', 'Savings', 'Other'],
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
export const valPayload = (cat, month, field, cents) => ({ t: 'val', c: cat, m: month, f: field, v: cents });
export const catPayload = (name, kind, order, deleted = false) => ({ t: 'cat', n: name, k: kind, o: order, x: deleted ? 1 : 0 });

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
    this.isHeld = () => false; // set by the app: true while we have an unsent local edit for rid
    this.reset();
  }
  reset() {
    this.cats = new Map(); // id -> {id,name,kind,order,deleted}
    this.vals = new Map(); // 'cat|month|field' -> cents|null
    this.seqs = new Map(); // rid -> highest server seq applied
  }
  resetSeqs() {
    this.seqs.clear();
  }

  /** seq === null means a local optimistic edit. Server events apply only if newer (last writer wins). */
  apply(rid, payload, seq = null) {
    if (seq !== null) {
      if (seq <= (this.seqs.get(rid) ?? 0)) return false;
      this.seqs.set(rid, seq);
      if (this.isHeld(rid)) return false; // our own newer edit is still on its way to the server
    }
    return this._set(rid, payload);
  }

  _set(rid, p) {
    if (!p || typeof p !== 'object') return false;
    if (p.t === 'cat') {
      if (typeof p.n !== 'string' || p.n.length > 40 || (p.k !== 'i' && p.k !== 'e') || !Number.isFinite(p.o)) return false;
      this.cats.set(rid, { id: rid, name: p.n, kind: p.k, order: p.o, deleted: !!p.x });
      return true;
    }
    if (p.t === 'val') {
      if (!HEX32.test(p.c) || !MONTH_RE.test(p.m) || (p.f !== 'p' && p.f !== 'a')) return false;
      if (p.v !== null && !Number.isSafeInteger(p.v)) return false;
      this.vals.set(`${p.c}|${p.m}|${p.f}`, p.v);
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
