// Tiny localStorage wrapper that never throws (private mode, quota) and falls back to memory
// (which is also what the Node tests use).
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

export const store = {
  get(k) {
    try {
      const s = ls();
      return s ? s.getItem(k) : (mem.get(k) ?? null);
    } catch {
      return mem.get(k) ?? null;
    }
  },
  set(k, v) {
    try {
      const s = ls();
      if (s) {
        s.setItem(k, String(v));
        return;
      }
    } catch {
      /* fall through to memory */
    }
    mem.set(k, String(v));
  },
  del(k) {
    try {
      ls()?.removeItem(k);
    } catch {
      /* ignore */
    }
    mem.delete(k);
  },
  clearAll() {
    try {
      const s = ls();
      if (s) for (const k of Object.keys(s)) if (k.startsWith('fb.')) s.removeItem(k);
    } catch {
      /* ignore */
    }
    mem.clear();
  },
};
