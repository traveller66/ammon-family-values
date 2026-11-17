// App lock: the family key is wrapped (encrypted) with a key derived from the PIN, so while the lock
// is on the key is NOT stored in the clear on the phone. It only exists in memory while unlocked.
// Honest limit: a 4-8 digit PIN can be brute-forced offline by someone who copies the phone's storage;
// PBKDF2 slows that down but cannot make a short PIN strong. It protects against casual access.

import { b64u } from './vault.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 250000;

export const validPin = (pin) => /^\d{4,8}$/.test(String(pin));

async function pinKey(pin, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapKey(pin, familyKey, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pinKey(pin, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(familyKey));
  return { v: 1, iter: iterations, salt: b64u.enc(salt), iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

/** Returns the family key, or null if the PIN is wrong (AES-GCM authentication fails). */
export async function unwrapKey(pin, wrapped) {
  try {
    const key = await pinKey(pin, b64u.dec(wrapped.salt), wrapped.iter);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(wrapped.iv) }, key, b64u.dec(wrapped.ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}
