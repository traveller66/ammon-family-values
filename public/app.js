// Ammon Family Values - UI. All data handling lives in vault.js / model.js / sync.js.
import { newFamilyKey, deriveVault, recordId, randomRecordId } from './vault.js';
import { store } from './store.js';
import {
  APP_NAME, DEFAULT_CATEGORIES, Budget, monthKey, shiftMonth, monthLabel,
  parseMoney, formatMoney, centsToInput, valLabel, valPayload, catPayload, helpFor,
} from './model.js';
import { SyncClient } from './sync.js';
import { wrapKey, unwrapKey, validPin } from './lock.js';
import { migrateTo } from './rotate.js';
import { makeQr } from './qr.js';

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
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function show(name) {
  for (const id of ['insecure', 'welcome', 'lock', 'budget']) $(`#${id}`).hidden = id !== name;
}

/* ------------------------------------------------------------------ state */
const budget = new Budget();
let vault = null;
let sync = null;
let familyKey = null;
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
    if (!sync) return; // locked or signed out: nothing to save to
    budget.apply(rid, payload);
    scheduleRender();
    await sync.put(rid, payload);
  });
}
function setValue(catId, m, field, cents) {
  return enqueue(async () => {
    if (!sync || !vault) return;
    const rid = await recordId(vault, valLabel(catId, m, field));
    const payload = valPayload(catId, m, field, cents);
    budget.apply(rid, payload);
    scheduleRender();
    await sync.put(rid, payload);
  });
}
async function seedDefaults() {
  for (const kind of ['i', 'e']) {
    let order = 0;
    for (const name of DEFAULT_CATEGORIES[kind]) await putRecord(randomRecordId(), catPayload(name, kind, order++));
  }
}

/* ------------------------------------------------------------------ session */
function keyFromText(text) {
  const m = String(text ?? '').trim().match(/(?:k=)?([A-Za-z0-9_-]{43})$/);
  return m ? m[1] : null;
}

async function enter(key, creator) {
  familyKey = key;
  vault = await deriveVault(key);
  if (!loadWrapped()) store.set('fb.key', key); // with the PIN lock on, the key is never stored in the clear
  budget.reset();
  sync = new SyncClient({
    vault,
    creator,
    live: false, // connect only to sync (on open and on each save) so the server can stay asleep
    onRecord: (rid, payload, seq) => {
      if (budget.apply(rid, payload, seq)) scheduleRender();
    },
    onStatus,
    onReset: () => budget.resetSeqs(),
  });
  budget.isHeld = (rid) => sync.hasPending(rid);
  show('budget');
  render();
  await sync.start();
  if (creator) {
    await seedDefaults();
    openWizard(true);
  }
}

function leaveLocal(message) {
  sync?.stop();
  sync = null;
  vault = null;
  familyKey = null;
  const keep = { size: store.get('fb.size'), cur: store.get('fb.currency') };
  store.clearAll();
  if (keep.size) store.set('fb.size', keep.size);
  if (keep.cur) store.set('fb.currency', keep.cur);
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

const STATUS = {
  connecting: ['Connecting…', 'wait'],
  online: ['Live', 'ok'],
  idle: ['Saved', 'ok'],
  reconnecting: ['Reconnecting…', 'wait'],
  offline: ['Offline, saved here', 'off'],
  missing: ['Not found', 'bad'],
  unauthorized: ['Not allowed', 'bad'],
  deleted: ['Deleted', 'bad'],
};
function onStatus(s) {
  const [text, tone] = STATUS[s] ?? STATUS.connecting;
  $('#status').dataset.tone = tone;
  $('#status-text').textContent = text;
  if (s === 'missing') leaveLocal("We couldn't find a budget for that invite. Ask for a fresh link and try again.");
  else if (s === 'unauthorized') leaveLocal('That invite was not accepted. Ask for a fresh link.');
  else if (s === 'deleted') leaveLocal('This budget was moved or deleted. Ask for a new invite link.');
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
  if (addCtx && $('#dlg-add').open) refreshAdd(); // keep the open "add" box in step with live changes from family
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
    h('div', { class: 'item-head' }, row.name, row.status),
    h('div', { class: 'pair' }, mk('p'), mk('a')),
    (row.quick = h('button', { class: 'quick', type: 'button', text: kind === 'i' ? '+ Add money received' : '+ Add spending', onclick: () => openAdd(id, kind) })),
    kind === 'e' ? (row.bar = h('div', { class: 'bar' }, h('i'))) : null,
  );
  return row;
}

function updateRow(row, cat) {
  if (row.nameText !== cat.name) {
    row.nameText = cat.name;
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
function inviteLink() {
  return `${location.origin}${location.pathname}#k=${familyKey}`;
}
/** Draw a QR code on a canvas: black squares on white with the 4-square quiet border scanners need. */
function drawQr(canvas, text) {
  const q = makeQr(text);
  const quiet = 4;
  const scale = Math.max(4, Math.floor(320 / (q.size + quiet * 2)));
  const px = (q.size + quiet * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) if (q.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  }
}
function openInvite() {
  const link = inviteLink();
  $('#invite-link').value = link;
  const qr = $('#invite-qr');
  try {
    drawQr(qr, link);
    qr.hidden = false;
    $('#invite-qr-cap').hidden = false;
  } catch {
    qr.hidden = true; // a very long address will not fit; the link buttons still work
    $('#invite-qr-cap').hidden = true;
  }
  $('#dlg-invite').showModal();
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    const box = $('#invite-link');
    box.select();
    toast('Press and hold the link, then tap Copy');
  }
}
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
const wiz = { steps: [], step: 0, month: '', helpShown: false };

function openWizard(fresh) {
  const cats = [...budget.categories('i'), ...budget.categories('e')];
  wiz.month = month;
  wiz.helpShown = false; // the first question opens its explanation by itself, so people notice the (i) button
  wiz.steps = [
    { type: 'intro' },
    ...cats.map((c) => ({ type: 'val', id: c.id, field: 'p' })),
    { type: 'extra' },
    { type: 'gate' },
    { type: 'done' },
  ];
  wiz.step = fresh ? 0 : 1;
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
      h('p', { class: 'wiz-lead', text: "We'll ask about each item one at a time: first what comes in, then what goes out. It takes about two minutes, and you can change anything later." }),
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

  // "What am I being asked for?" Always visible, with an (i) button (hover on a computer, tap on a phone) for more.
  const info = helpFor(cat.name, cat.kind, s.field);
  const startOpen = !wiz.helpShown;
  wiz.helpShown = true;
  const panel = h('div', { class: 'help', id: 'wiz-help', hidden: !startOpen }, h('p', { text: info.what }), h('p', { class: 'help-note', text: info.note }));
  const infoBtn = h('button', {
    class: 'info-btn', type: 'button', text: 'i', title: info.what,
    'aria-controls': 'wiz-help', 'aria-expanded': String(startOpen), 'aria-label': `More about this question. ${info.ask}`,
  });
  infoBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    infoBtn.setAttribute('aria-expanded', String(!panel.hidden));
  });
  const askBadge = h(
    'div',
    { class: 'ask' },
    h('div', { class: 'ask-main' }, h('span', { class: 'ask-label', text: "I'm asking for" }), h('span', { class: 'ask-text', text: info.ask }), h('span', { class: 'ask-stage', text: info.stage })),
    infoBtn,
  );

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
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (save()) go(1);
    }
  });
  return {
    // On the first question the explanation opens by itself, so leave the keyboard down until they have had a chance to read it.
    focus: startOpen ? null : input,
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: `${isIncome ? 'Money in' : 'Money out'} · ${isPlan ? 'Plan' : 'So far'}` }),
      h('h2', { class: 'wiz-title', text: question }),
      askBadge,
      h('label', { class: 'wiz-money' }, h('span', { class: 'cur', text: currencySymbol() }), input),
      prev !== null
        ? h('button', { class: 'chip', type: 'button', text: `Same as last month (${fmt(prev)})`, onclick: () => { input.value = centsToInput(prev); input.focus(); } })
        : null,
      panel,
      err,
      h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: 'Next', onclick: () => { if (save()) go(1); } }),
      h(
        'div',
        { class: 'wiz-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Back', onclick: () => go(-1) }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Skip', onclick: () => go(1) }),
      ),
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
  const buttons = [];
  if (familyKey) {
    buttons.push(h('button', { class: 'btn btn-primary btn-xl', type: 'button', text: 'Invite my family', onclick: () => { closeWizard(); openInvite(); } }));
  }
  buttons.push(h('button', { class: `btn ${familyKey ? 'btn-secondary' : 'btn-primary'} btn-xl`, type: 'button', text: 'Open my budget', onclick: closeWizard }));
  return {
    el: h(
      'div',
      { class: 'wiz-stack' },
      h('p', { class: 'eyebrow', text: 'All set' }),
      h('h2', { class: 'wiz-title', text: `${monthLabel(wiz.month)} is ready` }),
      h('div', { class: 'summary-box' }, inR.el, outR.el, leftR.el),
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
  if (!c || c.deleted) return fail('That item was removed by someone else.');
  const r = parseMoney($('#add-amt').value);
  if (!r.ok || r.cents === null || r.cents <= 0) return fail('Type an amount above zero, like 12.50');
  const cur = budget.get(ctx.id, ctx.month, 'a') ?? 0; // read now, so changes from family while this box was open are included
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
// With the lock on, the family key is stored only in encrypted form (wrapped by the PIN) and lives in memory while unlocked.
const LOCK_AFTER_MS = 60_000; // lock again once the app has been out of sight this long
let hiddenAt = 0;
let pendingInvite = null; // an invite link that was opened while the app was locked
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
  sync?.stop();
  sync = null;
  vault = null;
  familyKey = null;
  budget.reset();
  rows.i.clear();
  rows.e.clear();
  $('#income-list').replaceChildren();
  $('#expense-list').replaceChildren();
  showLock();
}

/** What to open: the saved budget, the budget from an invite link, or the welcome screen. */
async function start(invite, saved) {
  if (invite && saved && invite !== saved) {
    if (confirm(`Switch this phone to the ${APP_NAME} from this invite? Your current budget stays safe for everyone else.`)) {
      leaveLocal();
      return enter(invite, false);
    }
    return enter(saved, false);
  }
  if (invite && !saved) return enter(invite, false);
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
  const invite = pendingInvite;
  pendingInvite = null;
  try {
    await start(invite, key);
  } catch (e) {
    say(`Could not open the budget: ${e.message}`);
  }
}

function forgotPin() {
  if (!confirm('If you forgot your PIN, the only way back in is to remove this budget from this phone and join again with an invite link from someone in your family. Everyone else keeps their data.\n\nRemove it from this phone?')) return;
  const invite = pendingInvite;
  pendingInvite = null;
  leaveLocal();
  if (invite) enter(invite, false).catch((e) => console.error(e));
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
      text: 'Pick 4 to 8 numbers. You will type it each time the app opens. If you ever forget it, you can rejoin with an invite link from family.',
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

/* ------------------------------------------------------------------ new family key (to remove someone) */
async function rotateKeyFlow() {
  $('#dlg-menu').close();
  if (!sync || !familyKey) return;
  if (sync.status !== 'online' && sync.status !== 'idle') {
    toast('Connect to the internet first, then try again.');
    return;
  }
  if (!confirm('Make a new family key?\n\nUse this to remove someone: their old invite link stops working. Everyone you still want in will need the NEW link, which you will see next.\n\nIt works best when nobody else is editing right now.')) return;
  const w = loadWrapped();
  let pin = null;
  if (w) {
    pin = await askPin({
      title: 'Confirm with your PIN',
      text: 'Type your PIN to make a new key.',
      check: async (p) => ((await unwrapKey(p, w)) ? null : 'That PIN is not right.'),
    });
    if (!pin) return;
  }

  const oldKey = familyKey;
  const oldSync = sync;
  const prefs = { 'fb.size': store.get('fb.size'), 'fb.currency': store.get('fb.currency') };
  const newKey = newFamilyKey();
  const banner = $('#busy');
  banner.textContent = 'Making a new key…';
  banner.hidden = false;
  document.body.classList.add('busy');

  let moved;
  try {
    moved = await migrateTo({
      budget,
      oldSync,
      newKey,
      onProgress: (done, total) => {
        banner.textContent = `Making a new key… ${done} of ${total}`;
      },
    });
  } catch (e) {
    console.error(e);
    if (!oldSync.running) await enter(oldKey, false).catch((e2) => console.error(e2)); // the old connection was stopped: bring it back
    alert(`Nothing was changed. The new key could not be made: ${e.message}.`);
    return;
  } finally {
    banner.hidden = true;
    document.body.classList.remove('busy');
  }

  // From here the old budget is gone, so never go back: always end up holding the new link.
  try {
    store.clearAll();
    for (const [k, v] of Object.entries(prefs)) if (v) store.set(k, v);
    store.set('fb.cache', moved.cacheJson); // keeps this phone working offline, and lets it re-upload if the server loses the data
    store.set('fb.known', '1');
    if (pin) store.set('fb.wrapped', JSON.stringify(await wrapKey(pin, newKey)));
    await enter(newKey, false);
    openInvite();
    toast('New key made. Send the new link to your family.');
  } catch (e) {
    console.error(e);
    window.prompt('Your family now has a new invite link. Copy it and keep it safe:', `${location.origin}${location.pathname}#k=${newKey}`);
  }
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $('#btn-new').addEventListener('click', async () => {
    try {
      await enter(newFamilyKey(), true);
    } catch (e) {
      $('#welcome-error').textContent = `Could not start: ${e.message}`;
      $('#welcome-error').hidden = false;
    }
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = keyFromText($('#join-input').value);
    const err = $('#welcome-error');
    if (!key) {
      err.textContent = "That doesn't look like an invite link. Paste the whole link you were sent.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    try {
      await enter(key, false);
    } catch (ex) {
      err.textContent = `Could not join: ${ex.message}`;
      err.hidden = false;
    }
  });

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
    if (!confirm(`Delete "${c.name}"? It will disappear for everyone in the family.`)) return;
    await putRecord(c.id, catPayload(c.name, c.kind, c.order, true));
    $('#dlg-cat').close();
  });

  // Menu
  $('#btn-menu').addEventListener('click', () => {
    $('#m-currency').value = currency;
    $('#m-size').checked = store.get('fb.size') === 'xl';
    $('#m-lock').textContent = loadWrapped() ? 'Turn off app lock (PIN)' : 'Turn on app lock (PIN)';
    $('#dlg-menu').showModal();
  });
  $('#m-close').addEventListener('click', () => $('#dlg-menu').close());
  $('#m-invite').addEventListener('click', () => { $('#dlg-menu').close(); openInvite(); });
  $('#m-setup').addEventListener('click', () => { $('#dlg-menu').close(); openWizard(false); });
  $('#m-copyplan').addEventListener('click', () => { $('#dlg-menu').close(); copyPlanned(); });
  $('#m-lock').addEventListener('click', () => { $('#dlg-menu').close(); toggleLock(); });
  $('#m-rotate').addEventListener('click', rotateKeyFlow);
  $('#m-currency').addEventListener('change', (e) => {
    currency = e.target.value;
    store.set('fb.currency', currency);
    render();
  });
  $('#m-size').addEventListener('change', (e) => {
    store.set('fb.size', e.target.checked ? 'xl' : 'l');
    applySize();
  });
  $('#m-wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL budget data from the server for everyone? Phones will be signed out. This cannot be undone.')) return;
    try {
      await sync.deleteRoom();
      $('#dlg-menu').close();
      leaveLocal('The budget was deleted from the server.');
    } catch {
      toast("Couldn't reach the server. Try again when you're online.");
    }
  });
  $('#m-leave').addEventListener('click', () => {
    if (!confirm('Remove this budget from this phone? You will need the invite link to come back.')) return;
    $('#dlg-menu').close();
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

  // Invite
  $('#invite-close').addEventListener('click', () => $('#dlg-invite').close());
  $('#btn-copy').addEventListener('click', () => copyText(inviteLink()));
  $('#invite-link').addEventListener('focus', (e) => e.target.select());
  $('#btn-share').addEventListener('click', async () => {
    const url = inviteLink();
    if (navigator.share) {
      try {
        await navigator.share({ title: APP_NAME, text: `Join our family budget, ${APP_NAME}:`, url });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    copyText(url);
  });

  // Wizard
  $('#wiz-exit').addEventListener('click', closeWizard);

  // Tap outside a sheet to close it
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
  }

  // Stay in sync when the phone wakes up or the network comes back
  window.addEventListener('online', () => sync?.kick());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (familyKey && away > LOCK_AFTER_MS && loadWrapped()) lockNow(); // the PIN lock asks again after a minute away
    else sync?.kickIfStale();
  });
}

async function boot() {
  applySize();
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    show('insecure');
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  wire();

  const invite = keyFromText(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // keep the key out of the address bar

  if (loadWrapped()) {
    // The PIN lock is on: the key is not on the phone in the clear, so ask for the PIN first.
    store.del('fb.key');
    pendingInvite = invite;
    showLock();
    return;
  }
  return start(invite, store.get('fb.key'));
}

boot().catch((e) => {
  console.error(e);
  show('welcome');
  const err = $('#welcome-error');
  err.textContent = `Something went wrong starting the app: ${e.message}`;
  err.hidden = false;
});
