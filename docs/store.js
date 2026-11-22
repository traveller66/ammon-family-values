// Where the app keeps what it saves. Never throws.
//
//   In the installed Android app: a file in the app's own private storage on the phone (budget-a.json, with a
//   second copy budget-b.json). Clearing a cache, clearing Chrome, or restarting the phone does not touch it.
//   Only removing the app, or "Clear storage" for this app in Android's settings, does.
//
//   In a browser: the browser's storage for this site (localStorage), with a request that the browser not clear it
//   on its own. In private mode, or in the Node tests, it falls back to memory.
import { plugin } from './native.js';

const mem = new Map();
const ls = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** A private in-memory store with the same shape (used for temporary work and in tests). */
export function createMemoryStore() {
  const m = new Map();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, String(v)),
    del: (k) => void m.delete(k),
    clearAll: () => m.clear(),
  };
}

/* ------------------------------------------------------------------ the file (installed app only) */
// Two copies are written one after the other, each a complete file with a counter. If the phone dies part-way
// through writing one, the other is still whole; at start-up the newest copy that reads cleanly wins.
const SLOTS = ['budget-a.json', 'budget-b.json'];
const TAG = 'ammon-family-values';
let fs = null; // set by initStore when files are in use
let file = null; // Map of everything saved, mirrored to the file
let counter = 0;
let dirty = false;
let writing = null;
let onProblem = () => {};

/** Called with a message if saving to the phone ever fails. */
export function onStoreProblem(fn) {
  onProblem = fn;
}

async function readSlot(name) {
  try {
    const r = await fs.readFile({ path: name, directory: 'DATA', encoding: 'utf8' });
    const o = JSON.parse(typeof r === 'string' ? r : r.data);
    if (o && o.app === TAG && o.kind === 'store' && Number.isInteger(o.n) && o.values && typeof o.values === 'object') return o;
  } catch {
    /* missing or damaged */
  }
  return null;
}

async function flushLoop() {
  while (dirty) {
    dirty = false;
    counter += 1;
    const data = JSON.stringify({ app: TAG, kind: 'store', v: 1, n: counter, values: Object.fromEntries(file) });
    let failed = 0;
    for (const name of SLOTS) {
      try {
        await fs.writeFile({ path: name, data, directory: 'DATA', encoding: 'utf8', recursive: true });
      } catch (e) {
        failed += 1;
        console.error(e);
      }
    }
    if (failed === SLOTS.length) onProblem('Could not save to this phone. Check that the phone has free space.');
  }
}
function scheduleFlush() {
  dirty = true;
  if (!writing) writing = flushLoop().finally(() => (writing = null));
  return writing;
}
/** Resolves once everything set so far is in the file. */
export const flushStore = () => (file ? writing ?? Promise.resolve() : Promise.resolve());

/**
 * Call once before anything is read. In the installed app this loads the budget file (and, the first time, takes
 * over anything the app had saved the old way). Returns 'file' or 'browser'.
 */
export async function initStore(filesystem = plugin('Filesystem')) {
  if (!filesystem) {
    try {
      globalThis.navigator?.storage?.persist?.()?.catch?.(() => {}); // ask the browser not to clear this site on its own
    } catch {
      /* not offered here */
    }
    return 'browser';
  }
  fs = filesystem;
  const copies = (await Promise.all(SLOTS.map(readSlot))).filter(Boolean).sort((a, b) => b.n - a.n);
  file = new Map();
  if (copies.length) {
    counter = copies[0].n;
    for (const [k, v] of Object.entries(copies[0].values)) if (typeof v === 'string') file.set(k, v);
    if (copies.length < SLOTS.length || copies[0].n !== copies[1].n) scheduleFlush(); // repair the other copy
  } else {
    // No file yet: carry over anything already saved in the app's web storage.
    try {
      const s = ls();
      if (s) for (const k of Object.keys(s)) if (k.startsWith('fb.')) file.set(k, s.getItem(k));
    } catch {
      /* nothing to carry over */
    }
    if (file.size) scheduleFlush();
  }
  return 'file';
}

/** Tests only: go back to browser/memory storage. */
export function resetStoreForTests() {
  fs = null;
  file = null;
  counter = 0;
  dirty = false;
  mem.clear();
}

export const store = {
  get(k) {
    if (file) return file.get(k) ?? null;
    try {
      const s = ls();
      return s ? s.getItem(k) : (mem.get(k) ?? null);
    } catch {
      return mem.get(k) ?? null;
    }
  },
  set(k, v) {
    if (file) {
      file.set(k, String(v));
      scheduleFlush();
      return;
    }
    try {
      const s = ls();
      if (s) {
        s.setItem(k, String(v));
        return;
      }
    } catch {
      onProblem('Could not save to this phone. Check that the phone has free space.');
    }
    mem.set(k, String(v));
  },
  del(k) {
    if (file) {
      if (file.delete(k)) scheduleFlush();
      return;
    }
    try {
      ls()?.removeItem(k);
    } catch {
      /* ignore */
    }
    mem.delete(k);
  },
  clearAll() {
    if (file) {
      for (const k of [...file.keys()]) if (k.startsWith('fb.')) file.delete(k);
      scheduleFlush();
      return;
    }
    try {
      const s = ls();
      if (s) for (const k of Object.keys(s)) if (k.startsWith('fb.')) s.removeItem(k);
    } catch {
      /* ignore */
    }
    mem.clear();
  },
};
