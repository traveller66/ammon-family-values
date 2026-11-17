// Ammon Family Values - UI. All data handling lives in vault.js / model.js / local.js / share.js.
// Stand-alone: this app has no server and makes no network requests of its own. The budget lives on this phone;
// to share it, the person sends a locked budget file (by email, for example) and family brings it in.
import { newFamilyKey, deriveVault, recordId, randomRecordId } from './vault.js';
import { store } from './store.js';
import {
  APP_NAME, DEFAULT_CATEGORIES, Budget, monthKey, shiftMonth, monthLabel,
  parseMoney, formatMoney, centsToInput, valLabel, valPayload, catPayload, helpFor,
  exportData, cleanImport, planMerge,
} from './model.js';
import { LocalBook } from './local.js';
import { wrapKey, unwrapKey, validPin } from './lock.js';
import { sealFile, parseFile, openFile, fileName, validPassword, MIN_PASSWORD } from './share.js';
import { mountGame } from './games.js';
import { GAME_KINDS } from './puzzles.js';

/* ------------------------------------------------------------------ helpers */
const $ = (sel) => document.querySelector(sel);

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

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function busy(msg) {
  const el = $('#busy');
  el.textContent = msg || '';
  el.hidden = !msg;
}

/**
 * The "I'm asking for" line and the longer explanation that goes with it.
 * With `always` the explanation is simply shown; otherwise an (i) button opens and closes it.
 */
function makeHelp(info, { always = false, id }) {
  const panel = h('div', { class: 'help', id, hidden: !always }, h('p', { text: info.what }), h('p', { class: 'help-note', text: info.note }));
  let btn = null;
  if (!always) {
    btn = h('button', { class: 'info-btn', type: 'button', text: 'i', title: info.what, 'aria-controls': id, 'aria-expanded': 'false', 'aria-label': `More about this question. ${info.ask}` });
    btn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      btn.setAttribute('aria-expanded', String(!panel.hidden));
    });
  }
  const badge = h(
    'div',
    { class: 'ask' },
    h('div', { class: 'ask-main' }, h('span', { class: 'ask-label', text: "I'm asking for" }), h('span', { class: 'ask-text', text: info.ask }), h('span', { class: 'ask-stage', text: info.stage })),
    btn,
  );
  return { badge, panel };
}

function show(name) {
  for (const id of ['insecure', 'welcome', 'lock', 'budget']) $(`#${id}`).hidden = id !== name;
}

/* ------------------------------------------------------------------ state */
const budget = new Budget();
let vault = null;
let book = null; // the sealed copy of the budget on this phone
let familyKey = null; // this phone's budget key (never leaves the phone)
let month = monthKey();
let currency = store.get('fb.currency') || 'USD';
const rows = { i: new Map(), e: new Map() };

const fmt = (cents) => formatMoney(cents, currency);
function currencySymbol() {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? '$';
  } catch {
    return '$';
  }
}
function applySize() {
  document.documentElement.dataset.size = store.get('fb.size') === 'xl' ? 'xl' : 'l';
}

/* ------------------------------------------------------------------ edits (serialised so order is kept) */
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((e) => console.error(e)));

function putRecord(rid, payload) {
  return enqueue(async () => {
    if (!book) return; // locked or no budget: nothing to save to
    budget.apply(rid, payload);
    scheduleRender();
    await book.put(rid, payload);
  });
}
function setValue(catId, m, field, cents) {
  return enqueue(async () => {
    if (!book || !vault) return;
    const rid = await recordId(vault, valLabel(catId, m, field));
    const payload = valPayload(catId, m, field, cents);
    budget.apply(rid, payload);
    scheduleRender();
    await book.put(rid, payload);
  });
}
async function seedDefaults() {
  for (const kind of ['i', 'e']) {
    let order = 0;
    for (const name of DEFAULT_CATEGORIES[kind]) await putRecord(randomRecordId(), catPayload(name, kind, order++));
  }
}

/* ------------------------------------------------------------------ session */
async function enter(key, creator) {
  familyKey = key;
  vault = await deriveVault(key);
  if (!loadWrapped()) store.set('fb.key', key); // with the PIN lock on, the key is never stored in the clear
  budget.reset();
  book = new LocalBook({ vault, onRecord: (rid, payload) => budget.apply(rid, payload) });
  await book.start();
  show('budget');
  render();
  if (creator) {
    store.set('fb.setup', 'todo'); // first-time setup: stays 'todo' until its last screen is reached
    await seedDefaults();
    openWizard(true);
  } else if (setupPending()) {
    openWizard(false); // the app was closed part-way through first-time setup: carry on where it stopped
  }
}

const KEEP = ['fb.size', 'fb.currency', 'fb.games', 'fb.gameN', 'fb.solved']; // look-and-feel choices that are not budget data
function leaveLocal(message) {
  book = null;
  vault = null;
  familyKey = null;
  const keep = KEEP.map((k) => [k, store.get(k)]);
  store.clearAll();
  for (const [k, v] of keep) if (v) store.set(k, v);
  budget.reset();
  rows.i.clear();
  rows.e.clear();
  $('#income-list').replaceChildren();
  $('#expense-list').replaceChildren();
  closeWizard();
  show('welcome');
  const err = $('#welcome-error');
  err.hidden = !message;
  err.textContent = message || '';
}

/* ------------------------------------------------------------------ rendering */
let rafId = 0;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

function render() {
  $('#month-label').textContent = monthLabel(month);
  const t = budget.totals(month);
  const left = t.incomeA - t.expenseA;
  const sumLeft = $('#sum-left');
  sumLeft.textContent = fmt(left);
  sumLeft.classList.toggle('neg', left < 0);
  $('#sum-plan').textContent = `Planned to be left: ${fmt(t.incomeP - t.expenseP)}`;
  $('#sum-income').textContent = fmt(t.incomeA);
  $('#sum-income-plan').textContent = `of ${fmt(t.incomeP)} expected`;
  $('#sum-spent').textContent = fmt(t.expenseA);
  $('#sum-spent-plan').textContent = `of ${fmt(t.expenseP)} planned`;
  reconcile('i');
  reconcile('e');
  if (addCtx && $('#dlg-add').open) refreshAdd(); // keep an open "add" box in step with the numbers
}

function reconcile(kind) {
  const list = $(kind === 'i' ? '#income-list' : '#expense-list');
  const cats = budget.categories(kind);
  const seen = new Set();
  const els = [];
  for (const c of cats) {
    let row = rows[kind].get(c.id);
    if (!row) {
      row = makeRow(c.id, kind);
      rows[kind].set(c.id, row);
    }
    updateRow(row, c);
    seen.add(c.id);
    els.push(row.el);
  }
  for (const [id, row] of rows[kind]) {
    if (!seen.has(id)) {
      row.el.remove();
      rows[kind].delete(id);
    }
  }
  const current = Array.from(list.children);
  if (current.length !== els.length || current.some((el, i) => el !== els[i])) list.replaceChildren(...els);
}

function makeRow(id, kind) {
  const row = { id, kind, nameText: '' };
  const caps = kind === 'i' ? { p: 'Expected', a: 'Received' } : { p: 'Planned', a: 'Spent' };
  row.name = h('button', { class: 'item-name', type: 'button', onclick: () => openCategoryDialog(id, kind) });
  row.status = h('span', { class: 'item-status' });
  row.help = h('div', { class: 'help', id: `help-${id}`, hidden: true });
  row.info = h('button', { class: 'info-btn sm', type: 'button', text: 'i', 'aria-controls': `help-${id}`, 'aria-expanded': 'false', onclick: () => toggleRowHelp(row) });
  const mk = (field) => {
    const input = h('input', { class: 'amt', type: 'text', inputMode: 'decimal', autocomplete: 'off', enterKeyHint: 'done', placeholder: '0' });
    const cur = h('span', { class: 'cur', 'aria-hidden': 'true' });
    row[`${field}Cur`] = cur;
    wireAmount(id, field, input);
    row[`${field}In`] = input;
    return h('label', { class: 'field' }, h('span', { class: 'field-cap', text: caps[field] }), h('span', { class: 'money' }, cur, input));
  };
  row.el = h(
    'article',
    { class: 'item' },
    h('div', { class: 'item-head' }, row.name, row.info, row.status),
    row.help,
    h('div', { class: 'pair' }, mk('p'), mk('a')),
    (row.quick = h('button', { class: 'quick', type: 'button', text: kind === 'i' ? '+ Add money received' : '+ Add spending', onclick: () => openAdd(id, kind) })),
    kind === 'e' ? (row.bar = h('div', { class: 'bar' }, h('i'))) : null,
  );
  return row;
}

/** The (i) on an item card: what belongs in this item, and what its two boxes mean. */
function toggleRowHelp(row) {
  const c = budget.cats.get(row.id);
  if (!c) return;
  if (row.help.hidden) {
    const info = helpFor(c.name, c.kind, 'p');
    row.help.replaceChildren(
      h('p', {}, h('b', { text: info.ask })),
      h('p', { text: info.what }),
      h('p', {
        class: 'help-note',
        text: c.kind === 'i'
          ? '"Expected" is your estimate for the month. "Received" is what has actually come in so far.'
          : '"Planned" is your estimate for the month. "Spent" is what has actually gone out so far.',
      }),
    );
  }
  row.help.hidden = !row.help.hidden;
  row.info.setAttribute('aria-expanded', String(!row.help.hidden));
}

function updateRow(row, cat) {
  if (row.nameText !== cat.name) {
    row.nameText = cat.name;
    row.help.hidden = true;
    row.info.setAttribute('aria-expanded', 'false');
    row.info.setAttribute('aria-label', `What goes in ${cat.name}?`);
    row.name.replaceChildren(h('span', { class: 'name-text', text: cat.name }), h('span', { class: 'edit-hint', text: 'Edit' }));
    row.pIn.setAttribute('aria-label', `${cat.name}, ${row.kind === 'i' ? 'expected' : 'planned'}`);
    row.aIn.setAttribute('aria-label', `${cat.name}, ${row.kind === 'i' ? 'received' : 'spent'}`);
    row.quick.setAttribute('aria-label', `${row.kind === 'i' ? 'Add money received to' : 'Add spending to'} ${cat.name}`);
  }
  const sym = currencySymbol();
  row.pCur.textContent = sym;
  row.aCur.textContent = sym;
  const p = budget.get(cat.id, month, 'p');
  const a = budget.get(cat.id, month, 'a');
  for (const [input, v] of [[row.pIn, p], [row.aIn, a]]) {
    if (document.activeElement === input) continue; // never overwrite what someone is typing
    const s = centsToInput(v);
    if (input.value !== s) input.value = s;
  }
  const pn = p ?? 0;
  const an = a ?? 0;
  if (row.kind === 'e') {
    const planned = pn > 0;
    const over = planned && an > pn; // "over" only means something once there is a plan to be over
    row.el.classList.toggle('over', over);
    row.el.classList.toggle('unplanned', !planned);
    row.status.textContent = !planned ? (an > 0 ? 'No plan set' : 'Set a plan') : over ? `${fmt(an - pn)} over` : `${fmt(pn - an)} left`;
    const ratio = planned ? Math.min(1, an / pn) : 0;
    row.bar.firstChild.style.width = `${Math.round(ratio * 100)}%`;
  } else {
    row.status.textContent = pn > an ? `${fmt(pn - an)} to go` : an > 0 ? 'Received' : '';
  }
}

/** Big inputs on the main screen: save while typing (after a short pause) and when leaving the box. */
function wireAmount(catId, field, input) {
  let timer = 0;
  const box = () => input.closest('.money');
  const commit = (m) => {
    const r = parseMoney(input.value);
    if (!r.ok) {
      box()?.classList.add('invalid');
      return false;
    }
    box()?.classList.remove('invalid');
    if (r.cents !== budget.get(catId, m, field)) setValue(catId, m, field, r.cents);
    return true;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const m = month;
    timer = setTimeout(() => commit(m), 700);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => {
    clearTimeout(timer);
    const m = month;
    if (commit(m)) input.value = centsToInput(parseMoney(input.value).cents);
    else {
      input.value = centsToInput(budget.get(catId, m, field));
      box()?.classList.remove('invalid');
    }
  });
}

function changeMonth(delta) {
  document.activeElement?.blur?.();
  month = shiftMonth(month, delta);
  render();
}

/* ------------------------------------------------------------------ category dialog */
let catEdit = null;
function openCategoryDialog(id, kind) {
  const existing = id ? budget.cats.get(id) : null;
  catEdit = { id: id || null, kind: existing?.kind || kind };
  $('#cat-title').textContent = existing ? 'Edit item' : catEdit.kind === 'i' ? 'Add income' : 'Add expense';
  $('#cat-name').value = existing?.name || '';
  $('#cat-delete').hidden = !existing;
  $('#dlg-cat').showModal();
  $('#cat-name').focus();
}

/* ------------------------------------------------------------------ menu actions */
function copyPlanned() {
  const prev = shiftMonth(month, -1);
  let n = 0;
  for (const c of [...budget.categories('i'), ...budget.categories('e')]) {
    const v = budget.get(c.id, prev, 'p');
    if (v !== null && budget.get(c.id, month, 'p') === null) {
      setValue(c.id, month, 'p', v);
      n++;
    }
  }
  toast(n ? `Copied ${n} planned amount${n === 1 ? '' : 's'} from ${monthLabel(prev)}` : `Nothing to copy from ${monthLabel(prev)}`);
}

/* ------------------------------------------------------------------ guided setup (one value at a time) */
const wiz = { steps: [], step: 0, month: '' };

function openWizard(fresh) {
  const cats = [...budget.categories('i'), ...budget.categories('e')];
  wiz.month = month;
  wiz.steps = [
    { type: 'intro' },
    ...cats.map((c) => ({ type: 'val', id: c.id, field: 'p' })),
    { type: 'extra' },
    { type: 'gate' },
    { type: 'done' },
  ];
  wiz.step = fresh ? 0 : 1;
  if (!fresh && setupPending()) {
    // Carrying on with first-time setup: go to the first question that has no answer yet.
    const i = wiz.steps.findIndex((x) => x.type === 'val' && budget.get(x.id, wiz.month, 'p') === null);
    wiz.step = i >= 0 ? i : wiz.steps.findIndex((x) => x.type === 'extra');
  }
  $('#wizard').hidden = false;
  document.body.classList.add('no-scroll');
  renderWizard();
}
function closeWizard() {
  $('#wizard').hidden = true;
  document.body.classList.remove('no-scroll');
  scheduleRender();
}
function go(delta) {
  wiz.step = Math.max(0, Math.min(wiz.steps.length - 1, wiz.step + delta));
  renderWizard();
}

function renderWizard() {
  const s = wiz.steps[wiz.step];
  const last = wiz.steps.length - 1;
  $('#wiz-progress').style.width = `${Math.round((wiz.step / last) * 100)}%`;
  $('#wiz-step').textContent = s.type === 'done' ? 'All done' : `Step ${wiz.step + 1} of ${wiz.steps.length}`;
  const view = { intro: wizIntro, val: wizValue, extra: wizExtra, gate: wizGate, done: wizDone }[s.type](s);
  $('#wiz-body').replaceChildren(view.el);
  window.scrollTo(0, 0);
  $('#wizard').scrollTop = 0;
  view.focus?.focus();
}

function wizIntro() {
  return {
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: 'Welcome' }),
      h('h2', { class: 'wiz-title', text: `Let's set up ${APP_NAME}` }),
      h('p', { class: 'wiz-lead', text: "We'll ask for one number at a time: first each income, then each bill. Every question says exactly what it is asking for." }),
      setupPending()
        ? h('p', { class: 'help', text: 'Every answer unlocks a quick puzzle: a mini sudoku, a word scramble or a mini crossword. Solve it to move on to the next question. Stuck? Ask for a hint, or swap it for a different puzzle.' })
        : gamesOn()
          ? h('p', { class: 'help', text: 'Every answer earns a quick puzzle. You can skip any of them, or turn them off in the menu.' })
          : null,
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: "Let's go", onclick: () => go(1) }),
    ),
  };
}

function wizValue(s) {
  const cat = budget.cats.get(s.id);
  const isIncome = cat.kind === 'i';
  const isPlan = s.field === 'p';
  const when = monthLabel(wiz.month);
  const question = isPlan
    ? isIncome
      ? `How much do you expect from “${cat.name}” in ${when}?`
      : `How much do you plan to spend on “${cat.name}” in ${when}?`
    : isIncome
      ? `How much has come in so far from “${cat.name}”?`
      : `How much have you spent so far on “${cat.name}”?`;
  const existing = budget.get(s.id, wiz.month, s.field);
  const prev = isPlan ? budget.get(s.id, shiftMonth(wiz.month, -1), 'p') : null;
  const input = h('input', {
    class: 'wiz-input', type: 'text', inputMode: 'decimal', autocomplete: 'off', enterKeyHint: 'next',
    placeholder: '0', value: centsToInput(existing), 'aria-label': question,
  });
  const err = h('p', { class: 'notice error', role: 'alert', hidden: true });

  // "What am I being asked for?" The explanation is always on the screen during setup.
  const { badge: askBadge, panel } = makeHelp(helpFor(cat.name, cat.kind, s.field), { always: true, id: 'wiz-help' });

  const save = () => {
    const r = parseMoney(input.value);
    if (!r.ok) {
      err.textContent = 'Please type a number, like 450 or 450.50';
      err.hidden = false;
      input.focus();
      return false;
    }
    if (r.cents !== null && r.cents !== existing) setValue(s.id, wiz.month, s.field, r.cents);
    return true;
  };
  // An answered question earns a puzzle; a blank one just moves on.
  const next = () => {
    if (!save()) return;
    if (parseMoney(input.value).cents === null) return go(1);
    reward(isPlan ? `“${cat.name}” is planned. Puzzle time!` : `“${cat.name}” is up to date. Puzzle time!`, () => go(1));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      next();
    }
  });
  // "We don't have this one": take the item out of the budget and out of the rest of setup.
  const remove = async () => {
    await putRecord(cat.id, catPayload(cat.name, cat.kind, cat.order, true));
    wiz.steps = wiz.steps.filter((x) => x.id !== cat.id);
    wiz.step = Math.min(wiz.step, wiz.steps.length - 1);
    renderWizard();
  };
  return {
    // The keyboard stays down until they tap the box, so the explanation is not pushed off the screen.
    focus: null,
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: `${isIncome ? 'Money in' : 'Money out'} · ${isPlan ? 'Plan' : 'So far'}` }),
      h('h2', { class: 'wiz-title', text: question }),
      askBadge,
      panel,
      h('label', { class: 'wiz-money' }, h('span', { class: 'cur', text: currencySymbol() }), input),
      prev !== null
        ? h('button', { class: 'chip', type: 'button', text: `Same as last month (${fmt(prev)})`, onclick: () => { input.value = centsToInput(prev); input.focus(); } })
        : null,
      err,
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: 'Next', onclick: next }),
      h(
        'div',
        { class: 'wiz-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Back', onclick: () => go(-1) }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Skip for now', onclick: () => go(1) }),
      ),
      isPlan ? h('button', { class: 'link', type: 'button', text: "We don't have this one. Remove it.", onclick: remove }) : null,
    ),
  };
}

function wizExtra() {
  let kind = 'e';
  const name = h('input', { class: 'input', type: 'text', maxLength: 40, autocomplete: 'off', placeholder: 'For example: Pet care', 'aria-label': 'Name of the new item' });
  const bIn = h('button', { type: 'button', text: 'Money in', 'aria-pressed': 'false' });
  const bOut = h('button', { type: 'button', text: 'Money out', 'aria-pressed': 'true' });
  const pick = (k) => {
    kind = k;
    bIn.setAttribute('aria-pressed', String(k === 'i'));
    bOut.setAttribute('aria-pressed', String(k === 'e'));
  };
  bIn.addEventListener('click', () => pick('i'));
  bOut.addEventListener('click', () => pick('e'));
  const add = async () => {
    const n = name.value.trim().slice(0, 40);
    if (!n) {
      name.focus();
      return;
    }
    const id = randomRecordId();
    await putRecord(id, catPayload(n, kind, budget.nextOrder(kind)));
    wiz.steps.splice(wiz.step, 0, { type: 'val', id, field: 'p' }); // ask for its amount, then come back here
    renderWizard();
  };
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  return {
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: 'Anything else?' }),
      h('h2', { class: 'wiz-title', text: 'Is there another item you want to track?' }),
      h('p', { class: 'wiz-lead', text: 'For example, pet care, a subscription, or a second paycheck. Use labels for the money, not people\'s names.' }),
      name,
      h('div', { class: 'seg' }, bIn, bOut),
      h('button', { class: 'btn btn-secondary btn-xl', type: 'button', text: 'Add this item', onclick: add }),
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: "No, that's everything", onclick: () => go(1) }),
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Back', onclick: () => go(-1) }),
    ),
  };
}

function wizGate() {
  const yes = () => {
    wiz.steps = wiz.steps.filter((x) => !(x.type === 'val' && x.field === 'a')); // avoid duplicates if revisited
    const cats = [...budget.categories('i'), ...budget.categories('e')];
    wiz.steps.splice(wiz.step + 1, 0, ...cats.map((c) => ({ type: 'val', id: c.id, field: 'a' })));
    go(1);
  };
  return {
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: 'Plans are in' }),
      h('h2', { class: 'wiz-title', text: `Do you want to enter what has already come in and gone out in ${monthLabel(wiz.month)}?` }),
      h('p', { class: 'wiz-lead', text: "We'll go through each item one at a time. You can also skip this and enter amounts as you go." }),
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: 'Yes, go through them', onclick: yes }),
      h('button', { class: 'btn btn-secondary btn-xl', type: 'button', text: "Not now, I'll add them as I go", onclick: () => { wiz.step = wiz.steps.length - 1; renderWizard(); } }),
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Back', onclick: () => go(-1) }),
    ),
  };
}

function wizDone() {
  const rowEl = (label) => {
    const b = h('b', { text: '…' });
    return { b, el: h('div', {}, h('span', { text: label }), b) };
  };
  const inR = rowEl('Money in (planned)');
  const outR = rowEl('Money out (planned)');
  const leftR = rowEl('Planned to be left');
  chain.then(() => {
    const t = budget.totals(wiz.month);
    inR.b.textContent = fmt(t.incomeP);
    outR.b.textContent = fmt(t.expenseP);
    leftR.b.textContent = fmt(t.incomeP - t.expenseP);
  });
  if (setupPending()) store.set('fb.setup', 'done'); // from here on, puzzles are never required
  const solved = Number(store.get('fb.solved')) || 0;
  const buttons = [
    h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: 'Open my budget', onclick: closeWizard }),
    h('button', { class: 'btn btn-secondary btn-xl', type: 'button', text: 'Send this budget to family', onclick: () => { closeWizard(); exportFlow(); } }),
  ];
  return {
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: 'All set' }),
      h('h2', { class: 'wiz-title', text: `${monthLabel(wiz.month)} is ready` }),
      h('div', { class: 'summary-box' }, inR.el, outR.el, leftR.el),
      solved > 0 ? h('p', { class: 'wiz-lead', text: `Puzzles solved so far: ${solved}` }) : null,
      ...buttons,
      h('button', { class: 'btn btn-ghost', type: 'button', text: 'Back', onclick: () => go(-1) }),
    ),
  };
}

/* ------------------------------------------------------------------ quick add (add to a running total) */
let addCtx = null; // { id, kind, month, sign, busy }

function refreshAdd() {
  const c = budget.cats.get(addCtx.id);
  const cur = budget.get(addCtx.id, addCtx.month, 'a') ?? 0;
  $('#add-cur').textContent = fmt(cur);
  const r = parseMoney($('#add-amt').value);
  $('#add-preview').textContent = c && r.ok && r.cents > 0 ? `New total: ${fmt(cur + addCtx.sign * r.cents)}` : '';
}
function setAddMode(sign) {
  addCtx.sign = sign;
  $('#add-mode-add').setAttribute('aria-pressed', String(sign > 0));
  $('#add-mode-sub').setAttribute('aria-pressed', String(sign < 0));
  $('#add-go').textContent = sign > 0 ? 'Add it' : 'Subtract it';
  refreshAdd();
}
function openAdd(id, kind) {
  const c = budget.cats.get(id);
  if (!c) return;
  addCtx = { id, kind, month, sign: 1, busy: false };
  $('#add-title').textContent = kind === 'i' ? `Money received: ${c.name}` : `Add spending: ${c.name}`;
  $('#add-now').textContent = `So far in ${monthLabel(month)}`;
  $('#add-sym').textContent = currencySymbol();
  $('#add-amt').value = '';
  $('#add-error').hidden = true;
  $('#add-go').disabled = false;
  setAddMode(1);
  $('#dlg-add').showModal();
  $('#add-amt').focus();
}
async function submitAdd() {
  const ctx = addCtx;
  if (!ctx || ctx.busy) return;
  const err = $('#add-error');
  const fail = (msg) => {
    err.textContent = msg;
    err.hidden = false;
    $('#add-amt').focus();
  };
  const c = budget.cats.get(ctx.id);
  if (!c || c.deleted) return fail('That item was removed.');
  const r = parseMoney($('#add-amt').value);
  if (!r.ok || r.cents === null || r.cents <= 0) return fail('Type an amount above zero, like 12.50');
  const cur = budget.get(ctx.id, ctx.month, 'a') ?? 0; // read now, in case the total changed while this box was open
  const next = cur + ctx.sign * r.cents;
  if (next < 0) return fail(`That is more than the ${fmt(cur)} recorded so far.`);
  if (next > 99_999_999_999) return fail('That number is too big.');
  ctx.busy = true;
  $('#add-go').disabled = true;
  await setValue(ctx.id, ctx.month, 'a', next);
  $('#dlg-add').close();
  toast(`${ctx.sign > 0 ? 'Added' : 'Subtracted'} ${fmt(r.cents)}. ${c.name} is now ${fmt(next)}.`);
}

/* ------------------------------------------------------------------ app lock (PIN) */
// With the lock on, the budget key is stored only in encrypted form (wrapped by the PIN) and lives in memory while unlocked.
const LOCK_AFTER_MS = 60_000; // lock again once the app has been out of sight this long
let hiddenAt = 0;
let failedPins = 0;
let lockedUntil = 0;

function loadWrapped() {
  try {
    const w = JSON.parse(store.get('fb.wrapped') || 'null');
    const ok = w && w.v === 1 && Number.isInteger(w.iter) && w.iter >= 1000 && w.iter <= 5_000_000 && ['salt', 'iv', 'ct'].every((k) => typeof w[k] === 'string');
    return ok ? w : null;
  } catch {
    return null;
  }
}

function showLock(message) {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#wizard').hidden = true;
  document.body.classList.remove('no-scroll');
  show('lock');
  $('#lock-pin').value = '';
  const err = $('#lock-error');
  err.hidden = !message;
  err.textContent = message || '';
  setTimeout(() => $('#lock-pin').focus(), 50);
}

/** Forget the key and everything decrypted, and ask for the PIN again. Sealed data stays on the phone. */
function lockNow() {
  if (!familyKey || !loadWrapped()) return;
  book = null;
  vault = null;
  familyKey = null;
  pendingPlan = null;
  exportText = '';
  budget.reset();
  rows.i.clear();
  rows.e.clear();
  $('#income-list').replaceChildren();
  $('#expense-list').replaceChildren();
  showLock();
}

/** What to open: the budget saved on this phone, or the welcome screen. */
async function start(saved) {
  if (saved) return enter(saved, false);
  show('welcome');
}

async function tryUnlock() {
  const w = loadWrapped();
  const err = $('#lock-error');
  const say = (msg) => {
    err.textContent = msg;
    err.hidden = false;
  };
  if (!w) return show('welcome');
  const wait = lockedUntil - Date.now();
  if (wait > 0) return say(`Too many wrong tries. Please wait ${Math.ceil(wait / 1000)} seconds.`);
  const pin = $('#lock-pin').value.trim();
  if (!validPin(pin)) return say('Type your PIN: 4 to 8 numbers.');
  $('#lock-go').disabled = true;
  let key;
  try {
    key = await unwrapKey(pin, w);
  } finally {
    $('#lock-go').disabled = false;
  }
  if (!key) {
    failedPins += 1;
    $('#lock-pin').value = '';
    if (failedPins >= 5) {
      failedPins = 0;
      lockedUntil = Date.now() + 30_000;
      say('Too many wrong tries. Please wait 30 seconds.');
    } else say('That PIN is not right. Try again.');
    $('#lock-pin').focus();
    return;
  }
  failedPins = 0;
  err.hidden = true;
  try {
    await start(key);
  } catch (e) {
    say(`Could not open the budget: ${e.message}`);
  }
}

function forgotPin() {
  if (!confirm('A forgotten PIN cannot be recovered. The only way back in is to delete this budget from this phone.\n\nIf family has the budget on their phone, they can email you a budget file to bring it back.\n\nDelete it from this phone?')) return;
  leaveLocal();
}

/** Ask for a PIN in a box. Resolves with the PIN, or null if cancelled. `check` may return an error message to keep the box open. */
function askPin({ title, text, confirm: twice = false, check = null }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-pin');
    const form = $('#pin-form');
    const pin = $('#pin-input');
    const again = $('#pin-confirm');
    const err = $('#pin-error');
    const go = $('#pin-go');
    $('#pin-title').textContent = title;
    $('#pin-text').textContent = text;
    $('#pin-confirm-wrap').hidden = !twice;
    pin.value = '';
    again.value = '';
    err.hidden = true;
    go.disabled = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      $('#pin-cancel').removeEventListener('click', onCancel);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const fail = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };
    async function onSubmit(e) {
      e.preventDefault();
      if (!validPin(pin.value)) return fail('Use 4 to 8 numbers.');
      if (twice && pin.value !== again.value) return fail('The two PINs do not match.');
      if (check) {
        go.disabled = true;
        const problem = await check(pin.value);
        go.disabled = false;
        if (problem) return fail(problem);
      }
      finish(pin.value);
    }
    const onCancel = () => finish(null);
    const onClose = () => finish(null); // Esc, or a tap outside the box
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    $('#pin-cancel').addEventListener('click', onCancel);
    dlg.showModal();
    pin.focus();
  });
}

async function toggleLock() {
  if (!familyKey) return;
  const w = loadWrapped();
  if (!w) {
    const pin = await askPin({
      title: 'Choose a PIN',
      text: 'Pick 4 to 8 numbers. You will type it each time the app opens. A forgotten PIN cannot be recovered, so pick one you will remember.',
      confirm: true,
    });
    if (!pin) return;
    try {
      store.set('fb.wrapped', JSON.stringify(await wrapKey(pin, familyKey)));
      store.del('fb.key'); // from now on the key is only on the phone in locked form
      toast('App lock is on');
    } catch {
      toast('Could not turn on the lock. Please try again.');
    }
    return;
  }
  const pin = await askPin({
    title: 'Turn off app lock',
    text: 'Type your PIN to confirm.',
    check: async (p) => ((await unwrapKey(p, w)) ? null : 'That PIN is not right.'),
  });
  if (!pin) return;
  store.set('fb.key', familyKey);
  store.del('fb.wrapped');
  toast('App lock is off');
}

/* ------------------------------------------------------------------ sharing password */
// Budget files are locked with a password the family agrees on. This phone remembers it (sealed with the budget key).

/** Ask for the sharing password. Resolves with it, or null if cancelled. `check` may return an error message to keep the box open. */
function askPassword({ title, text, hint = true, check = null }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-pw');
    const form = $('#pw-form');
    const input = $('#pw-input');
    const err = $('#pw-error');
    const go = $('#pw-go');
    $('#pw-title').textContent = title;
    $('#pw-text').textContent = text;
    $('#pw-hint').hidden = !hint;
    input.value = '';
    err.hidden = true;
    go.disabled = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      $('#pw-cancel').removeEventListener('click', onCancel);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const fail = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };
    async function onSubmit(e) {
      e.preventDefault();
      const pw = input.value;
      if (!validPassword(pw)) return fail(`Use at least ${MIN_PASSWORD} letters or numbers.`);
      if (check) {
        go.disabled = true;
        go.textContent = 'Checking…';
        const problem = await check(pw);
        go.disabled = false;
        go.textContent = 'OK';
        if (problem) return fail(problem);
      }
      finish(pw);
    }
    const onCancel = () => finish(null);
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    $('#pw-cancel').addEventListener('click', onCancel);
    dlg.showModal();
    input.focus();
  });
}

const NEW_PASSWORD_TEXT =
  'This password locks the budget files you send. Your family types the same one to open them, so choose it together and tell each other in person or on the phone, not in the email with the file. This phone will remember it.';

async function changeSharingPassword() {
  if (!book) return;
  const pw = await askPassword({ title: 'New sharing password', text: `${NEW_PASSWORD_TEXT} Files you sent before still open with the old one.` });
  if (!pw || !book) return;
  await book.setNote('sharepw', pw);
  toast('Sharing password changed');
}

/* ------------------------------------------------------------------ send my budget (export) */
const lastShared = () => Number(store.get('fb.shared')) || 0;
const markShared = () => store.set('fb.shared', String(Date.now()));
let exportText = ''; // the locked file that is ready to send

async function exportFlow() {
  if (!book) return;
  await chain; // make sure the last edit is in
  let pw = await book.getNote('sharepw');
  if (!validPassword(pw)) {
    pw = await askPassword({ title: 'Choose a sharing password', text: NEW_PASSWORD_TEXT });
    if (!pw || !book) return;
    await book.setNote('sharepw', pw);
  }
  busy('Locking your budget file…');
  try {
    exportText = await sealFile(pw, exportData(budget));
  } catch (e) {
    console.error(e);
    toast('Could not make the file. Please try again.');
    return;
  } finally {
    busy('');
  }
  $('#ex-name').textContent = `The file is called ${fileName()}`;
  $('#dlg-export').showModal();
}

function saveExportFile() {
  const url = URL.createObjectURL(new Blob([exportText], { type: 'text/plain' }));
  const a = h('a', { href: url, download: fileName() });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  markShared();
  toast('Saved to Downloads. Attach it to an email.');
}

async function shareExportFile() {
  if (!exportText) return;
  let file = null;
  try {
    file = new File([exportText], fileName(), { type: 'text/plain' });
  } catch {
    /* very old browser */
  }
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: `${APP_NAME} budget`,
        text: `Here is my latest budget file. Open ${APP_NAME}, tap the menu, then "Bring in a budget file from family".`,
      });
      markShared();
      toast('Budget file handed off');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  saveExportFile(); // no share sheet here (a computer, usually): save the file instead
}

async function copyExportText() {
  try {
    await navigator.clipboard.writeText(exportText);
    markShared();
    toast('Copied. Paste it into an email.');
  } catch {
    toast('Could not copy. Use "Save the file" instead.');
  }
}

/* ------------------------------------------------------------------ bring in a budget file (import) */
let pendingPlan = null; // changes shown in the preview, waiting for a yes

function importFlow() {
  $('#im-error').hidden = true;
  $('#im-paste').value = '';
  $('#im-file').value = '';
  $('#im-title').textContent = book ? 'Bring in a budget file' : 'Open a budget file';
  $('#im-text').textContent = book
    ? 'Choose the budget file family emailed you (save the attachment to this phone first), or paste the text they sent. You will see what changes before anything is updated.'
    : 'Choose the budget file family emailed you (save the attachment to this phone first), or paste the text they sent.';
  $('#dlg-import').showModal();
}

const FIELD_NAME = { ip: 'Expected', ia: 'Received', ep: 'Planned', ea: 'Spent' };

async function handleImportText(text) {
  const err = $('#im-error');
  const file = parseFile(text);
  if (!file) {
    err.textContent = `That is not an ${APP_NAME} budget file. Choose the file family sent you, or paste all of its text.`;
    err.hidden = false;
    return;
  }
  $('#dlg-import').close();

  // Unlock it: try the password this phone remembers, then ask.
  let data = null;
  let typed = null;
  const remembered = book ? await book.getNote('sharepw') : null;
  if (validPassword(remembered)) {
    busy('Opening the file…');
    data = await openFile(remembered, file);
    busy('');
  }
  if (!data) {
    typed = await askPassword({
      title: 'Sharing password',
      text: 'Type the sharing password your family chose for budget files.',
      hint: false,
      check: async (p) => {
        data = await openFile(p, file);
        return data ? null : 'That password did not open the file. Check it with the person who sent it.';
      },
    });
    if (!typed) return;
  }

  let clean;
  try {
    clean = cleanImport(data);
  } catch {
    toast('That file could not be read.');
    return;
  }

  if (!book) {
    // First time on this phone: the file becomes this phone's budget.
    await enter(newFamilyKey(), false);
    await book.setNote('sharepw', typed);
    await applyPlan(planMerge(budget, clean, 0));
    toast('Budget opened. It now lives on this phone.');
    return;
  }
  if (typed && !validPassword(remembered)) await book.setNote('sharepw', typed);
  showPreview(planMerge(budget, clean, lastShared()));
}

function showPreview(plan) {
  if (plan.total === 0) {
    toast(plan.kept ? 'Nothing newer in that file. Your budget is already up to date.' : 'Your budget already matches that file.');
    return;
  }
  pendingPlan = plan;
  const money = (v) => (v === null ? 'empty' : fmt(v));
  const lines = [];
  for (const c of plan.cats) {
    if (c.change === 'added') lines.push(h('li', {}, h('b', { text: 'New item' }), h('span', { text: c.name })));
    else if (c.change === 'removed') lines.push(h('li', {}, h('b', { text: 'Removed item' }), h('span', { text: c.name })));
    else if (c.change === 'renamed') lines.push(h('li', {}, h('b', { text: 'Renamed' }), h('span', { text: `${c.was} → ${c.name}` })));
  }
  for (const v of plan.vals) {
    lines.push(
      h(
        'li',
        { class: v.both ? 'both' : '' },
        h('b', { text: `${v.name} · ${FIELD_NAME[v.kind + v.f]}` }),
        h('span', { class: 'muted', text: monthLabel(v.m) }),
        h('span', { class: 'delta', text: `${money(v.from)} → ${money(v.to)}` }),
        v.both ? h('span', { class: 'tag', text: 'You changed this too' }) : null,
      ),
    );
  }
  const MAX = 80;
  const extra = lines.length - MAX;
  $('#pv-list').replaceChildren(...lines.slice(0, MAX), extra > 0 ? h('li', { text: `…and ${extra} more` }) : '');
  $('#pv-text').textContent = `This file has ${plan.total} change${plan.total === 1 ? '' : 's'} for your budget. Nothing is updated until you say so.`;
  const notes = [];
  if (plan.vals.some((v) => v.both)) notes.push('Amounts marked "You changed this too" were changed on both phones. The amount in the file is newer, so it will replace yours.');
  if (plan.kept) notes.push(`${plan.kept} amount${plan.kept === 1 ? '' : 's'} in the file ${plan.kept === 1 ? 'is' : 'are'} older than yours and will be left alone.`);
  $('#pv-note').textContent = notes.join(' ');
  $('#pv-note').hidden = notes.length === 0;
  $('#dlg-preview').showModal();
}

function applyPlan(plan) {
  return enqueue(async () => {
    if (!book || !vault) return;
    const entries = [];
    for (const c of plan.cats) {
      budget.apply(c.id, c.payload);
      entries.push([c.id, c.payload]);
    }
    for (const v of plan.vals) {
      const rid = await recordId(vault, valLabel(v.c, v.m, v.f));
      budget.apply(rid, v.payload);
      entries.push([rid, v.payload]);
    }
    await book.putMany(entries);
    markShared();
    scheduleRender();
  });
}

/* ------------------------------------------------------------------ reward puzzles */
const gamesOn = () => store.get('fb.games') !== 'off';

/** Which puzzle comes next: sudoku, then a word scramble, then a crossword, round and round. */
function nextGame() {
  let n = Number(store.get('fb.gameN'));
  if (!Number.isInteger(n) || n < 0) n = Math.floor(Math.random() * 300) * GAME_KINDS.length; // start somewhere different on every phone
  store.set('fb.gameN', String(n + 1));
  return { kind: GAME_KINDS[n % GAME_KINDS.length], n: Math.floor(n / GAME_KINDS.length) };
}
function countSolved() {
  const total = (Number(store.get('fb.solved')) || 0) + 1;
  store.set('fb.solved', String(total));
  return total;
}

/** True until first-time setup has been finished on this phone. Until then every answer is followed by a puzzle. */
const setupPending = () => store.get('fb.setup') === 'todo';

/**
 * During guided setup: a puzzle after an answer, then carry on.
 * First-time setup: the puzzle has to be solved (hints and "a different puzzle" keep anyone from getting stuck).
 * Any later guided setup: it can be skipped, and the menu switch turns the puzzles off.
 */
function reward(praise, then) {
  const required = setupPending();
  if (!required && !gamesOn()) return then();
  $('#wiz-step').textContent = 'Puzzle break';
  const mount = () => {
    mountGame($('#wiz-body'), { ...nextGame(), praise, required, onSolved: countSolved, onSwap: mount, onDone: then });
    window.scrollTo(0, 0);
    $('#wizard').scrollTop = 0;
  };
  mount();
}

/** From the menu: puzzles just for fun. */
function playPuzzle() {
  mountGame($('#game-host'), { ...nextGame(), doneLabel: 'Another puzzle', skipLabel: 'Try a different puzzle', onSolved: countSolved, onDone: playPuzzle });
  if (!$('#dlg-game').open) $('#dlg-game').showModal();
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  const startError = (e) => {
    $('#welcome-error').textContent = `Could not start: ${e.message}`;
    $('#welcome-error').hidden = false;
  };
  $('#btn-new').addEventListener('click', () => enter(newFamilyKey(), true).catch(startError));
  $('#btn-open').addEventListener('click', importFlow);

  $('#prev-month').addEventListener('click', () => changeMonth(-1));
  $('#next-month').addEventListener('click', () => changeMonth(1));
  for (const b of document.querySelectorAll('.add-btn')) b.addEventListener('click', () => openCategoryDialog(null, b.dataset.kind));

  // Category dialog
  $('#cat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#cat-name').value.trim().slice(0, 40);
    if (!name || !catEdit) return;
    if (catEdit.id) {
      const c = budget.cats.get(catEdit.id);
      await putRecord(catEdit.id, catPayload(name, c.kind, c.order));
    } else {
      await putRecord(randomRecordId(), catPayload(name, catEdit.kind, budget.nextOrder(catEdit.kind)));
    }
    $('#dlg-cat').close();
  });
  $('#cat-cancel').addEventListener('click', () => $('#dlg-cat').close());
  $('#cat-delete').addEventListener('click', async () => {
    const c = catEdit?.id && budget.cats.get(catEdit.id);
    if (!c) return;
    if (!confirm(`Delete "${c.name}"? Its amounts will no longer be counted.`)) return;
    await putRecord(c.id, catPayload(c.name, c.kind, c.order, true));
    $('#dlg-cat').close();
  });

  // Menu
  const menu = $('#dlg-menu');
  const fromMenu = (id, fn) => $(id).addEventListener('click', () => { menu.close(); fn(); });
  $('#btn-menu').addEventListener('click', () => {
    $('#m-currency').value = currency;
    $('#m-size').checked = store.get('fb.size') === 'xl';
    $('#m-games').checked = gamesOn();
    $('#m-lock').textContent = loadWrapped() ? 'Turn off app lock (PIN)' : 'Turn on app lock (PIN)';
    menu.showModal();
  });
  $('#m-close').addEventListener('click', () => menu.close());
  fromMenu('#m-export', exportFlow);
  fromMenu('#m-import', importFlow);
  fromMenu('#m-setup', () => openWizard(false));
  fromMenu('#m-copyplan', copyPlanned);
  fromMenu('#m-game', playPuzzle);
  $('#btn-play').addEventListener('click', playPuzzle);
  fromMenu('#m-lock', toggleLock);
  fromMenu('#m-sharepw', changeSharingPassword);
  $('#m-currency').addEventListener('change', (e) => {
    currency = e.target.value;
    store.set('fb.currency', currency);
    render();
  });
  $('#m-size').addEventListener('change', (e) => {
    store.set('fb.size', e.target.checked ? 'xl' : 'l');
    applySize();
  });
  $('#m-games').addEventListener('change', (e) => store.set('fb.games', e.target.checked ? 'on' : 'off'));
  $('#m-leave').addEventListener('click', () => {
    if (!confirm('Delete this budget from this phone?\n\nIt is not saved anywhere else. Unless family has it on their phone, or you kept a budget file, it will be gone for good.')) return;
    menu.close();
    leaveLocal();
  });

  // Quick add
  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAdd();
  });
  $('#add-amt').addEventListener('input', () => {
    $('#add-error').hidden = true;
    if (addCtx) refreshAdd();
  });
  $('#add-mode-add').addEventListener('click', () => addCtx && setAddMode(1));
  $('#add-mode-sub').addEventListener('click', () => addCtx && setAddMode(-1));
  $('#add-cancel').addEventListener('click', () => $('#dlg-add').close());
  $('#dlg-add').addEventListener('close', () => {
    addCtx = null;
  });

  // App lock
  $('#lock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    tryUnlock();
  });
  $('#lock-forgot').addEventListener('click', forgotPin);

  // Send my budget
  $('#ex-share').addEventListener('click', shareExportFile);
  $('#ex-save').addEventListener('click', saveExportFile);
  $('#ex-copy').addEventListener('click', copyExportText);
  $('#ex-close').addEventListener('click', () => $('#dlg-export').close());

  // Bring in a budget file
  $('#im-choose').addEventListener('click', () => $('#im-file').click());
  $('#im-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 20_000_000) {
      $('#im-error').textContent = 'That file is too big to be a budget file.';
      $('#im-error').hidden = false;
      return;
    }
    handleImportText(await f.text()).catch((ex) => {
      console.error(ex);
      toast('That file could not be read.');
    });
  });
  $('#im-read').addEventListener('click', () => {
    handleImportText($('#im-paste').value).catch((ex) => {
      console.error(ex);
      toast('That text could not be read.');
    });
  });
  $('#im-cancel').addEventListener('click', () => $('#dlg-import').close());
  $('#pv-go').addEventListener('click', async () => {
    const plan = pendingPlan;
    pendingPlan = null;
    $('#dlg-preview').close();
    if (!plan || !book) return;
    await applyPlan(plan);
    toast(`Budget updated: ${plan.total} change${plan.total === 1 ? '' : 's'}`);
  });
  $('#pv-cancel').addEventListener('click', () => $('#dlg-preview').close());
  $('#dlg-preview').addEventListener('close', () => {
    pendingPlan = null;
  });

  // Puzzles
  $('#game-close').addEventListener('click', () => $('#dlg-game').close());
  $('#dlg-game').addEventListener('close', () => $('#game-host').replaceChildren());

  // Wizard
  $('#wiz-exit').addEventListener('click', closeWizard);

  // Tap outside a sheet to close it
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  }

  // The PIN lock asks again after a minute out of sight
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (familyKey && away > LOCK_AFTER_MS && loadWrapped()) lockNow();
  });
}

async function boot() {
  applySize();
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    show('insecure');
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  wire();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // old invite links carried a key here: drop it

  if (loadWrapped()) {
    // The PIN lock is on: the key is not on the phone in the clear, so ask for the PIN first.
    store.del('fb.key');
    showLock();
    return;
  }
  return start(store.get('fb.key'));
}

boot().catch((e) => {
  console.error(e);
  show('welcome');
  const err = $('#welcome-error');
  err.textContent = `Something went wrong starting the app: ${e.message}`;
  err.hidden = false;
});
