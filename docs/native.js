// The installed Android app (the APK). The same pages run inside a small Android shell (Capacitor), which hands
// them two extra abilities a browser does not have: reading and writing files on the phone, and the share sheet.
// In a browser none of this is used. Nothing here talks to the internet.

const FOLDER = 'AmmonFamilyValues'; // inside the phone's Documents folder

/** True only inside the installed Android app. */
export function isNative() {
  try {
    const C = globalThis.Capacitor;
    return !!C && (C.isNativePlatform?.() === true || (typeof C.nativePromise === 'function' && !!globalThis.androidBridge));
  } catch {
    return false;
  }
}

/** One of the shell's helpers ('Filesystem', 'Share'), or null in a browser. */
export function plugin(name) {
  if (!isNative()) return null;
  const C = globalThis.Capacitor;
  if (C.Plugins?.[name]) return C.Plugins[name];
  if (typeof C.nativePromise !== 'function') return null;
  return new Proxy({}, { get: (_, method) => (options) => C.nativePromise(name, method, options) });
}

export const DOCUMENTS_PLACE = `Documents → ${FOLDER}`;

/** Writes a text file into Documents/AmmonFamilyValues, where it outlives the app being removed. */
export async function writeDocument(name, text, fs = plugin('Filesystem')) {
  if (!fs) throw new Error('No file access here.');
  await fs.writeFile({ path: `${FOLDER}/${name}`, data: text, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
  return { name, place: DOCUMENTS_PLACE };
}

/** Opens Android's share sheet (email, messages...) with a text file attached. Resolves false if the person backs out. */
export async function shareTextFile(name, text, { title, message }, fs = plugin('Filesystem'), share = plugin('Share')) {
  if (!fs || !share) throw new Error('No share sheet here.');
  const made = await fs.writeFile({ path: `share/${name}`, data: text, directory: 'CACHE', encoding: 'utf8', recursive: true });
  try {
    await share.share({ title, text: message, files: [made.uri], dialogTitle: title });
    return true;
  } catch (e) {
    if (/cancel/i.test(String(e?.message ?? e))) return false;
    throw e;
  }
}
