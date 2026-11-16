// Client-side crypto. The family key never leaves the phones; the server only ever
// sees an opaque room id, an auth token it can verify but not forge, and AES-GCM ciphertext.
//
// One random 32-byte family key is expanded with HKDF into four independent secrets:
//   room  -> opaque room id (so the server cannot derive the key from it)
//   auth  -> bearer token proving "I hold the key" (server stores only its SHA-256)
//   enc   -> AES-256-GCM key used to seal every record
//   rid   -> HMAC key that turns field labels into opaque record ids

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  enc(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (const b of u) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const p = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
    const bin = atob(p);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  },
};

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

export function newFamilyKey() {
  return b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
}

async function hkdf(root, label, bytes) {
  const base = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(`family-budget/v1/${label}`) },
    base,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveVault(familyKey) {
  const root = b64u.dec(familyKey);
  if (root.length !== 32) throw new Error('That does not look like a valid family key.');
  const [room, auth, encKey, ridKey] = await Promise.all([
    hkdf(root, 'room', 16),
    hkdf(root, 'auth', 32),
    hkdf(root, 'enc', 32),
    hkdf(root, 'rid', 32),
  ]);
  const aes = await crypto.subtle.importKey('raw', encKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const hmac = await crypto.subtle.importKey('raw', ridKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const authToken = b64u.enc(auth);
  const authHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(authToken))));
  return { roomId: hex(room), authToken, authHash, aes, hmac };
}

/** Deterministic, opaque id for a labelled field (same cell on every phone -> same id). */
export async function recordId(vault, label) {
  const sig = await crypto.subtle.sign('HMAC', vault.hmac, enc.encode(label));
  return hex(new Uint8Array(sig).slice(0, 16));
}

/** Random opaque id (used for categories). */
export function randomRecordId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Encrypt a JSON value. The record id is bound in as AAD, so a server cannot swap records around. */
export async function seal(vault, rid, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(rid) },
    vault.aes,
    enc.encode(JSON.stringify(obj)),
  );
  return { ct: b64u.enc(ct), iv: b64u.enc(iv) };
}

export async function open(vault, rid, { ct, iv }) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64u.dec(iv), additionalData: enc.encode(rid) },
    vault.aes,
    b64u.dec(ct),
  );
  return JSON.parse(dec.decode(pt));
}
