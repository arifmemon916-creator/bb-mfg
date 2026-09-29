// CI gate: the versionCode must be HIGHER than the latest published release.
// Usage: node tools/check-version.mjs [--tag vX.Y]
// Env: GITHUB_REPOSITORY, GITHUB_TOKEN (read-only is enough).
import { readVersion } from './release-lib.mjs';

const v = readVersion();
const tagArg = process.argv.indexOf('--tag');
const tag = tagArg > 0 ? process.argv[tagArg + 1] : '';
if (tag && tag !== 'v' + v.name) {
  console.error(`Tag ${tag} does not match VERSION_NAME ${v.name} (expected v${v.name})`);
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.log(`No GITHUB_REPOSITORY set; local check only. Version ${v.name} (${v.code}).`);
  process.exit(0);
}
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'bizbill-ci' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers });
if (!res.ok) {
  console.error(`Could not list releases (${res.status}). Refusing to continue without verification.`);
  process.exit(1);
}
const releases = (await res.json()).filter((r) => !r.draft);
let latestCode = 0;
let latestName = '';
for (const r of releases) {
  const asset = (r.assets || []).find((a) => a.name === 'update.json');
  if (!asset) continue;
  const a = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' } });
  if (!a.ok) continue;
  try {
    const meta = JSON.parse(await a.text());
    if (Number.isInteger(meta.latestVersionCode) && meta.latestVersionCode > latestCode) {
      latestCode = meta.latestVersionCode;
      latestName = meta.latestVersionName;
    }
  } catch { /* ignore malformed old assets */ }
  if (tag && r.tag_name === tag) {
    console.error(`A release named ${tag} already exists. Bump VERSION_NAME / VERSION_CODE.`);
    process.exit(1);
  }
}
if (latestCode && v.code <= latestCode) {
  console.error(`VERSION_CODE ${v.code} must be greater than the published ${latestCode} (${latestName}). Android refuses equal or lower versionCodes.`);
  process.exit(1);
}
console.log(`Version OK: ${v.name} (${v.code})${latestCode ? `, previous release ${latestName} (${latestCode})` : ', first release'}`);
