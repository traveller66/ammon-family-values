// Key rotation ("remove someone"): copy the whole budget into a brand-new room under a brand-new key,
// confirm the server has it, and only THEN delete the old room. Anyone who only had the old key is locked out.
// If anything fails before the old room is deleted, nothing has changed for the family.

import { deriveVault, recordId, randomRecordId } from './vault.js';
import { valLabel, valPayload, catPayload } from './model.js';
import { SyncClient } from './sync.js';
import { createMemoryStore } from './store.js';

const FATAL = new Set(['missing', 'unauthorized', 'deleted']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything currently in the budget as plain payloads, ready to be re-encrypted for the new room.
 * Removed items are left behind, and every item gets a fresh random id so the new room cannot be
 * linked to the old one by its record ids.
 */
export function snapshot(budget) {
  const idMap = new Map();
  const cats = [];
  for (const c of budget.cats.values()) {
    if (c.deleted) continue;
    const id = randomRecordId();
    idMap.set(c.id, id);
    cats.push([id, catPayload(c.name, c.kind, c.order)]);
  }
  const vals = [];
  for (const [key, v] of budget.vals) {
    if (v === null) continue;
    const [c, m, f] = key.split('|');
    if (idMap.has(c)) vals.push([idMap.get(c), m, f, v]);
  }
  return { cats, vals };
}

/** Delete the old room. A 410 means an earlier try already got through (its reply was lost), which is success. */
async function deleteOld(oldSync) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      await oldSync.deleteRoom();
      return;
    } catch (e) {
      if (e.status === 410) return;
      last = e;
      if (i < 2) await sleep(1000);
    }
  }
  throw last;
}

function explain(e) {
  if (e.status === 429) return new Error('too many new budgets were made just now. Please wait a minute and try again');
  if (e.status === 507) return new Error('the server is full');
  return new Error('the server could not be reached');
}

/**
 * Moves the budget to a new room under `newKey`. Resolves with the new vault and the sealed cache for it.
 * Throws (after cleaning up the half-made copy) if anything goes wrong before the old room is deleted.
 * On a failure at the very last step the old connection has already been stopped: the caller restarts it.
 */
export async function migrateTo({ budget, oldSync, newKey, baseUrl = '', onProgress = () => {}, timeoutMs }) {
  const vault = await deriveVault(newKey);
  const { cats, vals } = snapshot(budget);
  const total = cats.length + vals.length;
  const limit = timeoutMs ?? 30000 + total * 500; // the server allows about 4 writes a second once a burst is used up
  const tmp = new SyncClient({ vault, creator: true, baseUrl, store: createMemoryStore(), onRecord() {}, onStatus() {}, onReset() {} });
  try {
    try {
      await tmp.createRoom();
    } catch (e) {
      throw explain(e);
    }
    await tmp.start();
    for (const [rid, payload] of cats) await tmp.put(rid, payload);
    for (const [c, m, f, v] of vals) await tmp.put(await recordId(vault, valLabel(c, m, f)), valPayload(c, m, f, v));

    const end = Date.now() + limit;
    for (;;) {
      const left = Object.keys(tmp.outbox).length;
      onProgress(total - left, total);
      if (tmp.status === 'online' && left === 0) break;
      if (FATAL.has(tmp.status)) throw new Error('the server would not accept the new budget');
      if (Date.now() > end) throw new Error('moving the budget took too long. Check your connection and try again');
      await sleep(150);
    }

    tmp.persistCache();
    const cacheJson = tmp.store.get('fb.cache'); // sealed records for the new room, so this phone keeps working offline
    oldSync.stop(); // stop the old connection first so it does not react to its own deletion
    await deleteOld(oldSync);
    return { vault, cacheJson };
  } catch (e) {
    await tmp.deleteRoom().catch(() => {}); // best effort: do not leave a half-made copy behind
    throw e;
  } finally {
    tmp.stop();
  }
}
