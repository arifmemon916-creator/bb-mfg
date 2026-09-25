// Writes www/js/version.js from version.properties (npm run version:sync).
// With --check, fails if the file is out of date (used in CI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const props = Object.fromEntries(fs.readFileSync(path.join(root, 'version.properties'), 'utf8')
  .split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('=').map((x) => x.trim())));
if (!/^\d+(\.\d+){0,3}$/.test(props.VERSION_NAME) || !/^\d+$/.test(props.VERSION_CODE)) {
  console.error('version.properties: invalid VERSION_NAME / VERSION_CODE');
  process.exit(1);
}
const out = `// Generated from version.properties by tools/sync-version.mjs. Do not edit.
export const VERSION_NAME = '${props.VERSION_NAME}';
export const VERSION_CODE = ${Number(props.VERSION_CODE)};
export const PACKAGE_NAME = '${props.PACKAGE_NAME}';
`;
const file = path.join(root, 'www/js/version.js');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur !== out) { console.error('www/js/version.js is out of date. Run: npm run version:sync'); process.exit(1); }
  console.log(`Version ${props.VERSION_NAME} (${props.VERSION_CODE}) in sync`);
} else {
  fs.writeFileSync(file, out);
  console.log(`Wrote ${file}`);
}
