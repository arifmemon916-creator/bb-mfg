// Validates a generated update.json with the same rules the app enforces.
import fs from 'node:fs';
import { validateUpdateMeta } from '../www/js/services/update.js';
import { readVersion } from './release-lib.mjs';

const file = process.argv[2];
const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
const v = readVersion();
// Pretend an older app (versionCode - 1) is checking: the release must be accepted as an update.
const r = validateUpdateMeta(meta, { packageName: v.packageName, versionCode: v.code - 1, versionName: '0.0' });
if (!r.ok || !r.info.available) {
  console.error('update.json rejected:', r.error || 'not an update');
  process.exit(1);
}
console.log('update.json valid:', meta.latestVersionName, meta.latestVersionCode, meta.sha256);
