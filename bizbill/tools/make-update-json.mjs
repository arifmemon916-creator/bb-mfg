// Generates update.json and checksums.txt for a release.
// Usage: node tools/make-update-json.mjs <apk> <aab> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readVersion, releaseNotes } from './release-lib.mjs';

const [apk, aab, outDir] = process.argv.slice(2);
if (!apk || !outDir) { console.error('usage: make-update-json <apk> <aab> <outDir>'); process.exit(1); }
const v = readVersion();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const repo = process.env.GITHUB_REPOSITORY || 'arifmemon916-creator/bb-mfg';
const tag = 'v' + v.name;
const apkSha = sha(apk);
const meta = {
  packageName: v.packageName,
  latestVersionName: v.name,
  latestVersionCode: v.code,
  downloadUrl: `https://github.com/${repo}/releases/download/${tag}/BizBill-release.apk`,
  sha256: apkSha,
  mandatoryUpdate: v.mandatory || process.env.MANDATORY_UPDATE === 'true',
  minimumSupportedVersion: v.minSupported || undefined,
  releaseNotes: releaseNotes().replace(/^## .*\n?/, '').trim().slice(0, 4000),
  publishedAt: new Date().toISOString(),
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'update.json'), JSON.stringify(meta, null, 2) + '\n');
const lines = [`${apkSha}  BizBill-release.apk`];
if (aab && fs.existsSync(aab)) lines.push(`${sha(aab)}  BizBill-release.aab`);
fs.writeFileSync(path.join(outDir, 'checksums.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'release-notes.md'), `${releaseNotes() || '## BizBill ' + v.name}\n\n### Integrity\n\nSHA-256 (BizBill-release.apk):\n\n\`${apkSha}\`\n\nThe app verifies this checksum, the package name, the version and the signing certificate before installing an update.\n`);
console.log(JSON.stringify(meta, null, 2));
