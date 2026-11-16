// Sync engine: encrypted records <-> server, with an offline outbox and automatic reconnect.
// Conflict rule: last writer wins per field, ordered by the server's sequence number.

import { open, seal } from './vault.js';
import { store as defaultStore } from './store.js';

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

export class SyncClient {
  constructor({ vault, creator = false, baseUrl = '', store = defaultStore, onRecord, onStatus = () => {}, onReset = () => {} }) {
    this.vault = vault;
    this.creator = creator;
    this.base = baseUrl;
    this.store = store;
    this.onRecord = onRecord; // (rid, payload, seq|null)
    this.onStatus = onStatus; // 'connecting'|'online'|'reconnecting'|'offline'|'missing'|'unauthorized'|'deleted'
    this.onReset = onReset;
    this.cache = {}; // rid -> {ct, iv, seq}   (sealed, as last confirmed by the server)
    this.outbox = {}; // rid -> {ct, iv}        (sealed edits not yet confirmed)
    this.seq = 0;
    this.status = 'connecting';
    this.running = false;
    this.flushing = false;
    this.kicked = false;
    this.lastData = 0;
    this.ctrl = null;
    this.wakeFn = null;
    this.saveTimer = 0;
  }

  // ------------------------------------------------------------ lifecycle
  async start() {
    this.running = true;
    await this.loadLocal();
    this.loop(); // runs until stop(); intentionally not awaited
  }
  stop() {
    this.running = false;
    this.status = 'offline'; // silent: a stopped client must queue edits, not send them
    this.ctrl?.abort();
    this.wakeFn?.();
  }
  kick() {
    this.kicked = true;
    this.ctrl?.abort();
    this.wakeFn?.();
  }
  kickIfStale() {
    if (this.running && Date.now() - this.lastData > 35000) this.kick();
  }
  hasPending(rid) {
    return Object.hasOwn(this.outbox, rid);
  }
  canCreate() {
    return this.creator || this.store.get('fb.known') === '1';
  }
  setStatus(s) {
    if (this.status !== s) {
      this.status = s;
      this.onStatus(s);
    }
  }

  // ------------------------------------------------------------ local persistence (sealed data only)
  async loadLocal() {
    const room = this.vault.roomId;
    try {
      const c = JSON.parse(this.store.get('fb.cache') || 'null');
      if (c && c.room === room) {
        this.cache = c.records || {};
        this.seq = c.seq || 0;
      }
      const o = JSON.parse(this.store.get('fb.outbox') || 'null');
      if (o && o.room === room) this.outbox = o.items || {};
    } catch {
      /* corrupt local copy: the server copy will refill it */
    }
    for (const [rid, rec] of Object.entries(this.cache)) {
      try {
        this.onRecord(rid, await open(this.vault, rid, rec), rec.seq);
      } catch {
        delete this.cache[rid];
      }
    }
    for (const [rid, rec] of Object.entries(this.outbox)) {
      try {
        this.onRecord(rid, await open(this.vault, rid, rec), null);
      } catch {
        delete this.outbox[rid];
      }
    }
  }
  persistCache() {
    this.store.set('fb.cache', JSON.stringify({ room: this.vault.roomId, seq: this.seq, records: this.cache }));
  }
  persistSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = 0;
      this.persistCache();
    }, 300);
  }
  persistOutbox() {
    this.store.set('fb.outbox', JSON.stringify({ room: this.vault.roomId, items: this.outbox }));
  }

  // ------------------------------------------------------------ network
  async api(method, subpath, body) {
    const res = await fetch(`${this.base}/api/rooms/${this.vault.roomId}${subpath}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.vault.authToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw httpError(res.status);
    return res.json();
  }

  async createRoom() {
    const res = await fetch(`${this.base}/api/rooms`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: this.vault.roomId, authHash: this.vault.authHash }),
    });
    if (!res.ok) throw httpError(res.status);
  }

  /** The server lost its data (free hosts do this): queue everything we have so it re-uploads. */
  resetFromCache() {
    for (const [rid, rec] of Object.entries(this.cache)) {
      if (!this.outbox[rid]) this.outbox[rid] = { ct: rec.ct, iv: rec.iv };
    }
    this.cache = {};
    this.seq = 0;
    this.onReset();
    this.persistOutbox();
    this.persistSoon();
  }

  async connectOnce() {
    let r;
    try {
      // A brand-new budget cannot exist on the server yet, so create it up front instead of asking and getting a 404.
      if (this.creator && this.store.get('fb.known') !== '1') await this.createRoom();
      r = await this.api('GET', `/records?since=${this.seq}`);
    } catch (e) {
      if (e.status !== 404 || !this.canCreate()) throw e;
      await this.createRoom();
      this.resetFromCache();
      r = await this.api('GET', '/records?since=0');
    }
    if (r.seq < this.seq) {
      this.resetFromCache();
      r = await this.api('GET', '/records?since=0');
    }
    for (const rec of r.records) await this.ingest(rec);
    this.seq = Math.max(this.seq, r.seq);
    this.store.set('fb.known', '1');
  }

  async ingest(rec, known) {
    const prev = this.cache[rec.rid];
    this.seq = Math.max(this.seq, rec.seq);
    if (prev && prev.seq >= rec.seq) return;
    let payload = known;
    if (!payload) {
      try {
        payload = await open(this.vault, rec.rid, rec);
      } catch {
        return; // wrong key or tampered record: ignore
      }
    }
    this.cache[rec.rid] = { ct: rec.ct, iv: rec.iv, seq: rec.seq };
    this.persistSoon();
    this.onRecord(rec.rid, payload, rec.seq);
  }

  async stream() {
    const ctrl = (this.ctrl = new AbortController());
    this.lastData = Date.now();
    const res = await fetch(`${this.base}/api/rooms/${this.vault.roomId}/events?since=${this.seq}`, {
      headers: { Authorization: `Bearer ${this.vault.authToken}` },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw httpError(res.status);
    const watchdog = setInterval(() => {
      if (Date.now() - this.lastData > 60000) ctrl.abort();
    }, 10000);
    // Safety net: some proxies (e.g. Cloudflare quick tunnels) buffer event streams, so also poll gently.
    const poller = setInterval(async () => {
      try {
        const r = await this.api('GET', `/records?since=${this.seq}`);
        for (const rec of r.records) await this.ingest(rec);
        this.lastData = Date.now();
      } catch (e) {
        if (e.status === 404 || e.status === 410 || e.status === 401) ctrl.abort();
      }
    }, 6000);
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.lastData = Date.now();
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (event === 'gone') throw httpError(410);
          if (data) await this.ingest(JSON.parse(data));
        }
      }
    } finally {
      clearInterval(watchdog);
      clearInterval(poller);
      this.ctrl = null;
    }
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const entry = Object.entries(this.outbox)[0];
        if (!entry) break;
        const [rid, sealed] = entry;
        try {
          const r = await this.api('PUT', `/records/${rid}`, sealed);
          if (this.outbox[rid] === sealed) {
            delete this.outbox[rid];
            this.persistOutbox();
          }
          await this.ingest({ rid, ct: sealed.ct, iv: sealed.iv, seq: r.seq });
        } catch (e) {
          if (e.status === 400 || e.status === 413) {
            // The server will never accept this one; drop it so it cannot block the queue.
            if (this.outbox[rid] === sealed) delete this.outbox[rid];
            this.persistOutbox();
            continue;
          }
          if (e.status === 429 && this.running) {
            // Rate limited (a big backlog after being offline): pause briefly and carry on, no reconnect needed.
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          throw e;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Queue an edit (already applied locally by the caller) and send it if we are online. */
  async put(rid, payload) {
    const sealed = await seal(this.vault, rid, payload);
    this.outbox[rid] = sealed;
    this.persistOutbox();
    if (this.status === 'online') this.flush().catch(() => this.kick());
  }

  async deleteRoom() {
    await this.api('DELETE', '');
  }

  sleepWake(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wakeFn = null;
        resolve();
      }
      this.wakeFn = done;
    });
  }

  async loop() {
    let backoff = 1000;
    while (this.running) {
      try {
        this.setStatus('connecting');
        await this.connectOnce();
        await this.flush();
        this.setStatus('online');
        backoff = 1000;
        await this.stream();
      } catch (e) {
        if (!this.running) return;
        let fatal = { 404: 'missing', 401: 'unauthorized', 403: 'unauthorized', 410: 'deleted' }[e.status];
        if (e.status === 404 && this.canCreate()) fatal = undefined; // server forgot us: reconnect will re-create
        if (fatal) {
          this.running = false;
          this.setStatus(fatal);
          return;
        }
      }
      if (!this.running) return;
      if (this.kicked) {
        this.kicked = false;
        continue;
      }
      this.setStatus(globalThis.navigator?.onLine === false ? 'offline' : 'reconnecting');
      await this.sleepWake(backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  }
}
