'use strict';
/**
 * Looks inside an uploaded file without unpacking it to disk or running anything. Reads only the zip's table of contents
 * (plus package.json / pubspec.yaml when small) and says what the file is.
 */
const zlib = require('zlib');

function listZip(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(0) !== 0x06054b50) return null;
  let e = buf.length - 22; const stop = Math.max(0, buf.length - 65557); while (e >= stop && buf.readUInt32LE(e) !== 0x06054b50) e--; if (e < stop) return null;
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    out.push({ name: buf.slice(p + 46, p + 46 + nlen).toString('utf8'), method, csize, usize, off }); p += 46 + nlen + xlen + clen; if (out.length >= 200000) break;
  }
  return out;
}
function readEntry(buf, en, max = 200000) {
  if (!en || en.usize > max) return null; const l2 = 30 + buf.readUInt16LE(en.off + 26) + buf.readUInt16LE(en.off + 28); const data = buf.slice(en.off + l2, en.off + l2 + en.csize);
  try { return (en.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: max + 1 })).toString('utf8'); } catch { return null; }
}
const fmt = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes');
const GENERIC = ['A signed release build, a privacy policy link, store listing text and screenshots are needed before any store submission.', 'Health and finance apps may also need regulator and data-protection approval before launch.'];

function inspect(name, buf) {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''; const res = { kind: 'file', label: ext ? `.${ext} file` : 'File', size: buf.length, found: [], warnings: [], storeNotes: [], top: [] };
  if (['xlsx', 'docx', 'pptx'].includes(ext)) { res.kind = 'document'; res.label = { xlsx: 'Excel workbook', docx: 'Word document', pptx: 'Slides' }[ext]; return res; }
  const zip = listZip(buf);
  if (!zip) { const doc = { pdf: 'PDF document', csv: 'CSV table', xlsx: 'Excel workbook', docx: 'Word document', pptx: 'Slides', json: 'JSON file', md: 'Notes', txt: 'Text file', png: 'Image', jpg: 'Image', jpeg: 'Image' }[ext]; if (doc) { res.kind = 'document'; res.label = doc; } else if (['apk', 'aab', 'ipa', 'zip', 'jar'].includes(ext)) res.warnings.push('The file is called .' + ext + ' but it is not a valid archive, so it cannot be inspected.'); return res; }
  const names = zip.map((x) => x.name); const has = (re) => names.some((x) => re.test(x)); const usize = zip.reduce((s, x) => s + x.usize, 0); const top = [...new Set(names.map((x) => x.split('/')[0]).filter(Boolean))];
  res.files = zip.length; res.unpackedBytes = usize; res.top = top.slice(0, 14);
  if (names.some((x) => x.startsWith('/') || x.split('/').includes('..') || /^[a-z]:/i.test(x))) res.warnings.push('It contains file paths that point outside the package. It is only stored, never unpacked.');
  if (buf.length > 0 && usize / buf.length > 200 && usize > 500e6) res.warnings.push(`It expands to ${fmt(usize)}, far more than its size. Be careful unpacking it.`);
  if (has(/\.(exe|dll|bat|cmd|scr|msi)$/i)) res.warnings.push('It contains Windows executables. Dry Run never runs uploaded files.');
  if (ext === 'aab' || has(/^base\/manifest\/AndroidManifest\.xml$/)) {
    const mods = [...new Set(names.filter((x) => /\/manifest\/AndroidManifest\.xml$/.test(x)).map((x) => x.split('/')[0]))]; Object.assign(res, { kind: 'android_bundle', label: 'Android App Bundle (.aab)', platform: 'android' }); res.found.push(`${mods.length} module${mods.length === 1 ? '' : 's'}: ${mods.join(', ')}`); if (has(/^BUNDLE-METADATA\//)) res.found.push('Bundle metadata present'); res.found.push(has(/^META-INF\/.+\.(SF|RSA|DSA|EC)$/i) ? 'Signed' : 'No signature found'); res.storeNotes.push('This is the format Google Play takes for new apps. It still has to be uploaded in the Play Console.');
  } else if (ext === 'apk' || (has(/^AndroidManifest\.xml$/) && has(/^classes\d*\.dex$/))) {
    Object.assign(res, { kind: 'android_apk', label: 'Android app (.apk)', platform: 'android' }); res.found.push(`${names.filter((x) => /^classes\d*\.dex$/.test(x)).length} code file(s)`); const abis = [...new Set(names.filter((x) => /^lib\/[^/]+\//.test(x)).map((x) => x.split('/')[1]))]; if (abis.length) res.found.push('Native code for ' + abis.join(', ')); res.found.push(has(/^META-INF\/.+\.(SF|RSA|DSA|EC)$/i) ? 'Signed' : 'No signature found');
    res.storeNotes.push('Google Play now asks for an Android App Bundle (.aab) for new apps. An .apk suits testing and installing directly.');
  } else if (ext === 'ipa' || has(/^Payload\/[^/]+\.app\//)) {
    const app = (names.find((x) => /^Payload\/[^/]+\.app\//.test(x)) || '').split('/')[1] || ''; Object.assign(res, { kind: 'ios_app', label: 'iOS app (.ipa)', platform: 'ios' }); if (app) res.found.push('App: ' + app); res.found.push(has(/embedded\.mobileprovision$/) ? 'Provisioning profile included' : 'No provisioning profile found'); res.storeNotes.push('App Store submissions go through Apple\'s own tools (Xcode or Transporter) from a Mac.');
  } else {
    res.kind = 'archive'; res.label = ext === 'jar' ? 'Java archive' : 'Zip archive'; const pk = zip.find((x) => /(^|\/)package\.json$/.test(x.name) && x.name.split('/').length <= 3); let deps = '';
    if (pk) { const t = readEntry(buf, pk); try { const j = JSON.parse(t); deps = Object.keys({ ...j.dependencies, ...j.devDependencies }).join(' '); } catch { /* ignore */ } }
    const kinds = []; if (has(/(^|\/)pubspec\.yaml$/)) kinds.push('Flutter project'); if (/react-native|expo/.test(deps)) kinds.push('React Native project'); else if (/capacitor|cordova/.test(deps)) kinds.push('Hybrid mobile project (Capacitor or Cordova)'); else if (pk) kinds.push(/next|react|vue|svelte|angular/.test(deps) ? 'Web app (Node)' : 'Node project');
    if (has(/(^|\/)(build\.gradle|build\.gradle\.kts|settings\.gradle)$/) && has(/AndroidManifest\.xml$/)) kinds.push('Android project'); if (has(/\.xcodeproj\/|\.xcworkspace\/|(^|\/)Podfile$/)) kinds.push('iOS (Xcode) project'); if (has(/(^|\/)pom\.xml$/)) kinds.push('Java (Maven) project'); if (has(/(^|\/)(requirements\.txt|pyproject\.toml)$/)) kinds.push('Python project'); if (has(/(^|\/)Dockerfile$/)) kinds.push('Docker image recipe'); if (!kinds.length && has(/(^|\/)index\.html$/)) kinds.push('Static website');
    if (kinds.length) { res.kind = 'project'; res.label = 'Source project'; res.found.push(...kinds); if (kinds.some((k) => /Flutter|React Native|Hybrid|Android|iOS/.test(k))) res.platform = 'mobile'; res.storeNotes.push('A signed build is made from this with the platform\'s own tools, then submitted to the stores.'); }
    if (has(/(^|\/)\.idea\//)) res.found.push('JetBrains IDE settings'); if (has(/(^|\/)\.vscode\//)) res.found.push('VS Code workspace settings'); if (has(/(^|\/)\.git\//)) res.warnings.push('It includes a .git folder, which holds the full history of the code.'); if (has(/(^|\/)\.env($|\.)/)) res.warnings.push('It includes a .env file, which often holds passwords and keys. Remove it before sharing.'); if (has(/\.(jks|keystore|p12|pem)$/i)) res.warnings.push('It includes a signing key or certificate. Do not share those widely.');
  }
  res.found.unshift(`${zip.length.toLocaleString('en-US')} files, ${fmt(usize)} unpacked`); if (res.storeNotes.length || res.platform) res.storeNotes.push(...GENERIC);
  return res;
}
module.exports = { inspect, listZip, fmt };
