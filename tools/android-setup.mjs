// Run by the GitHub build after "npx cap add android" has made the android/ folder.
// It sets the things the generated Android project does not know about this app:
//   - the version number (so a new APK installs over the old one and keeps the budget)
//   - permission to write the backup copy into Documents on older Android versions
//   - no Google cloud backup of the app's data (the budget stays on the phone)
//   - the app's own icon
// Usage: node tools/android-setup.mjs <build number> [android folder]
import fs from 'node:fs';
import path from 'node:path';

const build = Number(process.argv[2]);
const android = path.resolve(process.argv[3] || 'android');
if (!Number.isInteger(build) || build < 1) throw new Error('Give the build number, e.g. node tools/android-setup.mjs 12');
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
const must = (text, pattern, what) => {
  if (!pattern.test(text)) throw new Error(`Android project looks different than expected: ${what}`);
};

// Version: Android only installs an update if versionCode went up.
edit(path.join(android, 'app/build.gradle'), (s) => {
  must(s, /versionCode\s+\d+/, 'no versionCode in app/build.gradle');
  must(s, /versionName\s+"[^"]*"/, 'no versionName in app/build.gradle');
  return s.replace(/versionCode\s+\d+/, `versionCode ${build}`).replace(/versionName\s+"[^"]*"/, `versionName "1.${build}"`);
});

edit(path.join(android, 'app/src/main/AndroidManifest.xml'), (s) => {
  must(s, /<application\b/, 'no <application> in AndroidManifest.xml');
  must(s, /<\/manifest>/, 'no </manifest> in AndroidManifest.xml');
  s = /android:allowBackup="[^"]*"/.test(s)
    ? s.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"')
    : s.replace(/<application\b/, '<application android:allowBackup="false"');
  if (!s.includes('requestLegacyExternalStorage')) s = s.replace(/<application\b/, '<application android:requestLegacyExternalStorage="true"');
  if (!s.includes('WRITE_EXTERNAL_STORAGE')) {
    s = s.replace(
      /<\/manifest>/,
      '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />\n' +
        '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />\n</manifest>',
    );
  }
  return s;
});

// Icon: use the app's own picture at every size, and drop the template's layered icon so Android picks ours.
const res = path.join(android, 'app/src/main/res');
const icon = path.resolve('docs/icons/icon-192.png');
let icons = 0;
for (const dir of fs.readdirSync(res)) {
  if (!/^mipmap-[a-z]+dpi$/.test(dir)) continue;
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    fs.copyFileSync(icon, path.join(res, dir, name));
    icons++;
  }
}
if (icons) fs.rmSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });
console.log(`Android project set up: version 1.${build} (code ${build}), ${icons} icon files.`);
