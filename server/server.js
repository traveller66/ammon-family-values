// Family Budget sync server - zero dependencies.
//
// It stores opaque, encrypted records and relays them in real time (Server-Sent Events).
// It never sees the family key, category names, month labels or amounts: everything is
// sealed with AES-GCM on the phones before it leaves them. See README.md for the model.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_FILE = path.resolve(process.env.DATA_FILE ?? path.join(here, '../data/rooms.json'));
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set behind Cloudflare Tunnel / nginx / Caddy
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 200);
const MAX_RECORDS = Number(process.env.MAX_RECORDS ?? 3000);
const MAX_BODY = 4096; // bytes
const MAX_CT = 1024; // base64url chars of ciphertext per record
const MAX_STREAMS_PER_ROOM = 20;

// ---------------------------------------------------------------- storage
// { rooms: { [roomId]: { authHash, seq, records: { [rid]: { ct, iv, seq } } } }, gone: { [roomId]: 1 } }
let db = { rooms: {}, gone: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (loaded && typeof loaded.rooms === 'object') db = { rooms: loaded.rooms, gone: loaded.gone ?? {} };
} catch {
  /* first run */
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 400);
}
function saveNow() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, DATA_FILE); // atomic replace
  } catch (e) {
    console.error('save failed:', e.message);
  }
}

// ---------------------------------------------------------------- small helpers
const SEC = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[a-f0-9]+$/.test(s);
const isB64u = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function send(res, status, body, extra = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SEC,
    ...extra,
  });
  res.end(data);
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(httpErr(413, 'too_large'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return reject(httpErr(413, 'too_large'));
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(httpErr(400, 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- rate limiting (in memory only)
const LIMITS = {
  api: { cap: 120, rate: 4 }, // burst of 120, then 4 req/s per IP
  create: { cap: Number(process.env.CREATE_BURST ?? 5), rate: 1 / 60 }, // new rooms are rare
};
const buckets = new Map();
function take(ip, kind) {
  const cfg = LIMITS[kind];
  const key = `${kind}|${ip}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = { tokens: cfg.cap, t: now }));
  b.tokens = Math.min(cfg.cap, b.tokens + ((now - b.t) / 1000) * cfg.rate);
  b.t = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of buckets) if (b.t < cutoff) buckets.delete(k);
}, 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- auth
function authorized(room, req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ') || h.length > 200) return false;
  const given = Buffer.from(sha256hex(h.slice(7)), 'hex');
  const want = Buffer.from(room.authHash, 'hex');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ---------------------------------------------------------------- realtime
const streams = new Map(); // roomId -> Set<ServerResponse>
function broadcast(roomId, rec) {
  const set = streams.get(roomId);
  if (!set) return;
  const msg = `id: ${rec.seq}\ndata: ${JSON.stringify(rec)}\n\n`;
  for (const r of set) r.write(msg);
}
function closeStreams(roomId) {
  const set = streams.get(roomId);
  if (!set) return;
  for (const r of set) {
    r.write('event: gone\ndata: {}\n\n');
    r.end();
  }
  streams.delete(roomId);
}

// ---------------------------------------------------------------- API
const ROUTE = /^\/api\/rooms\/([a-f0-9]{32})(?:\/(records|events)(?:\/([a-f0-9]{32}))?)?$/;

async function handleApi(req, res, url) {
  if (!take(clientIp(req), 'api')) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '5' });

  // POST /api/rooms  {roomId, authHash}
  if (url.pathname === '/api/rooms') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const body = await readJson(req);
    if (!isHex(body.roomId, 32) || !isHex(body.authHash, 64)) return send(res, 400, { error: 'bad_request' });
    if (db.gone[body.roomId]) return send(res, 410, { error: 'gone' });
    const existing = db.rooms[body.roomId];
    if (existing) {
      return existing.authHash === body.authHash
        ? send(res, 200, { ok: true, seq: existing.seq })
        : send(res, 409, { error: 'exists' });
    }
    if (Object.keys(db.rooms).length >= MAX_ROOMS) return send(res, 507, { error: 'server_full' });
    if (!take(clientIp(req), 'create')) return send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    db.rooms[body.roomId] = { authHash: body.authHash, seq: 0, records: {} };
    scheduleSave();
    return send(res, 201, { ok: true, seq: 0 });
  }

  const m = ROUTE.exec(url.pathname);
  if (!m) return send(res, 404, { error: 'not_found' });
  const [, roomId, sub, rid] = m;

  if (db.gone[roomId]) return send(res, 410, { error: 'gone' });
  const room = db.rooms[roomId];
  if (!room) return send(res, 404, { error: 'no_room' });
  if (!authorized(room, req)) return send(res, 401, { error: 'unauthorized' });

  // DELETE /api/rooms/:id  -> wipe everything, leave a data-free tombstone so stale devices stop re-creating it
  if (!sub && req.method === 'DELETE') {
    delete db.rooms[roomId];
    db.gone[roomId] = 1;
    closeStreams(roomId);
    scheduleSave();
    return send(res, 200, { ok: true });
  }

  // GET /api/rooms/:id/records?since=N
  if (sub === 'records' && !rid && req.method === 'GET') {
    const since = Math.max(0, parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
    const records = [];
    for (const [id, r] of Object.entries(room.records)) {
      if (r.seq > since) records.push({ rid: id, ct: r.ct, iv: r.iv, seq: r.seq });
    }
    records.sort((a, b) => a.seq - b.seq);
    return send(res, 200, { seq: room.seq, records });
  }

  // PUT /api/rooms/:id/records/:rid  {ct, iv}   (last writer wins, ordered by server seq)
  if (sub === 'records' && rid && req.method === 'PUT') {
    const body = await readJson(req);
    if (!isB64u(body.ct, 1, MAX_CT) || !isB64u(body.iv, 16, 16)) return send(res, 400, { error: 'bad_record' });
    if (!room.records[rid] && Object.keys(room.records).length >= MAX_RECORDS) {
      return send(res, 413, { error: 'room_full' });
    }
    room.seq += 1;
    const rec = { ct: body.ct, iv: body.iv, seq: room.seq };
    room.records[rid] = rec;
    scheduleSave();
    broadcast(roomId, { rid, ...rec });
    return send(res, 200, { seq: rec.seq });
  }

  // GET /api/rooms/:id/events?since=N  (Server-Sent Events; replays anything after `since`)
  if (sub === 'events' && !rid && req.method === 'GET') {
    let set = streams.get(roomId);
    if (!set) streams.set(roomId, (set = new Set()));
    if (set.size >= MAX_STREAMS_PER_ROOM) return send(res, 429, { error: 'too_many_streams' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SEC,
    });
    res.write('retry: 3000\n\n');
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam === null ? room.seq : Math.max(0, parseInt(sinceParam, 10) || 0);
    const missed = Object.entries(room.records)
      .filter(([, r]) => r.seq > since)
      .sort((a, b) => a[1].seq - b[1].seq);
    for (const [id, r] of missed) res.write(`id: ${r.seq}\ndata: ${JSON.stringify({ rid: id, ...r })}\n\n`);
    set.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('error', () => {});
    res.on('close', () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (!set.size && streams.get(roomId) === set) streams.delete(roomId);
    });
    return;
  }

  return send(res, 405, { error: 'method' });
}

// ---------------------------------------------------------------- static files (the PWA)
async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad_path' });
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return send(res, 404, { error: 'not_found' });
  }
  if (!st.isFile()) return send(res, 404, { error: 'not_found' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    ...SEC,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e && e.status) {
      const extra = e.status === 413 ? { Connection: 'close' } : {};
      if (e.status === 413) res.once('finish', () => req.socket.destroy());
      return send(res, e.status, { error: e.message }, extra);
    }
    console.error('internal error:', e && e.message);
    return send(res, 500, { error: 'server' });
  }
});
server.requestTimeout = 30000;

function shutdown() {
  if (saveTimer) clearTimeout(saveTimer);
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message));

server.listen(PORT, HOST, () => {
  // Deliberately no per-request logging: no IPs, no paths, nothing about who does what.
  console.log(`Family Budget server listening on http://${HOST}:${PORT}  (data: ${DATA_FILE})`);
});
