// Budget files: how two phones swap a budget without any server.
// One phone makes a file, the person emails it, the other phone opens it. The file is locked with a sharing
// password the family agrees on (PBKDF2-SHA-256 -> AES-256-GCM), so the email service only ever carries scrambled text.
// Honest limit: the lock is only as strong as the password. A few random words is good; "budget1" is not.

import { b64u } from './vault.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 600000;
const TAG = 'ammon-family-values';

export const MIN_PASSWORD = 8;
export const validPassword = (pw) => typeof pw === 'string' && pw.trim().length >= MIN_PASSWORD && pw.length <= 200;
// Typed on two different phones: ignore spaces at the ends and capital letters so small slips do not lock anyone out.
const tidy = (pw) => pw.trim().replace(/\s+/g, ' ').toLowerCase();

async function fileKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(tidy(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function fileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `ammon-budget-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.txt`;
}

/** Lock budget data into the text of a budget file. */
export async function sealFile(password, data, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await fileKey(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(TAG) }, key, enc.encode(JSON.stringify(data)));
  return JSON.stringify({ app: TAG, kind: 'budget-file', v: 1, iter: iterations, salt: b64u.enc(salt), iv: b64u.enc(iv), ct: b64u.enc(ct) });
}

/** Finds the budget file inside some text (a file's contents, or text pasted from an email). Returns null if there is none. */
export function parseFile(text) {
  const t = String(text ?? '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const f = JSON.parse(t.slice(a, b + 1).replace(/\s+/g, '')); // email programs like to wrap long lines
    const ok = f && f.app === TAG && f.v === 1 && Number.isInteger(f.iter) && f.iter >= 1000 && f.iter <= 5_000_000 && ['salt', 'iv', 'ct'].every((k) => typeof f[k] === 'string' && /^[A-Za-z0-9_-]+$/.test(f[k]));
    return ok ? f : null;
  } catch {
    return null;
  }
}

/** Unlocks a parsed budget file. Returns the data, or null if the password is wrong (or the file was altered). */
export async function openFile(password, file) {
  try {
    const key = await fileKey(password, b64u.dec(file.salt), file.iter);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(file.iv), additionalData: enc.encode(TAG) }, key, b64u.dec(file.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}
