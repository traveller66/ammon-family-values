// The budget's home: this phone, and nowhere else. There is no server and no network code in this app.
// Every record is sealed (AES-256-GCM, see vault.js) before it is written to the phone's storage.

import { open, seal } from './vault.js';
import { store as defaultStore } from './store.js';

export class LocalBook {
  constructor({ vault, store = defaultStore, onRecord }) {
    this.vault = vault;
    this.store = store;
    this.onRecord = onRecord; // (rid, payload) for every record found on the phone at start-up
    this.records = {}; // rid -> {ct, iv}  (sealed)
  }

  /** Read and unseal everything saved on this phone. Records that will not open (wrong key, damage) are dropped. */
  async start() {
    const id = this.vault.bookId;
    let saved = {};
    try {
      const c = JSON.parse(this.store.get('fb.cache') || 'null');
      if (c && c.room === id && c.records && typeof c.records === 'object') saved = c.records;
      // Edits an older, server-based version of the app had not sent yet: they are newer than the copy above.
      const o = JSON.parse(this.store.get('fb.outbox') || 'null');
      if (o && o.room === id && o.items && typeof o.items === 'object') saved = { ...saved, ...o.items };
    } catch {
      /* unreadable storage: start empty */
    }
    for (const [rid, rec] of Object.entries(saved)) {
      try {
        const payload = await open(this.vault, rid, rec);
        this.records[rid] = { ct: rec.ct, iv: rec.iv };
        this.onRecord(rid, payload);
      } catch {
        /* skip */
      }
    }
    if (this.store.get('fb.outbox')) {
      this.persist();
      this.store.del('fb.outbox');
    }
  }

  persist() {
    this.store.set('fb.cache', JSON.stringify({ room: this.vault.bookId, records: this.records }));
  }

  /** Seal one record and save it on the phone. */
  async put(rid, payload) {
    const sealed = await seal(this.vault, rid, payload);
    this.records[rid] = sealed;
    this.persist();
  }

  /** Save many records with a single write (used when a budget file is brought in). */
  async putMany(entries) {
    for (const [rid, payload] of entries) this.records[rid] = await seal(this.vault, rid, payload);
    this.persist();
  }

  /** A small private note sealed with the budget key (used to remember the sharing password). */
  async setNote(name, value) {
    if (value == null) this.store.del(`fb.note.${name}`);
    else this.store.set(`fb.note.${name}`, JSON.stringify(await seal(this.vault, `note:${name}`, value)));
  }
  async getNote(name) {
    try {
      const raw = JSON.parse(this.store.get(`fb.note.${name}`) || 'null');
      return raw ? await open(this.vault, `note:${name}`, raw) : null;
    } catch {
      return null;
    }
  }
}
