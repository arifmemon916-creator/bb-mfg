// Update Center. Offline-first: a failed or missing network never blocks
// the app. Metadata comes from update.json published with each GitHub
// release. On Android, download + verification + installation happen in
// native code (UpdateManager.java): HTTPS, host allowlist, size, SHA-256,
// package name, versionCode and signing certificate are all checked before
// the system installer is opened. Nothing is ever installed silently.

import { VERSION_NAME, VERSION_CODE, PACKAGE_NAME } from '../version.js';
import * as bridge from '../platform/bridge.js';
import { nowStamp } from '../core/dates.js';

export const UPDATE_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

export function currentVersion() {
  const info = bridge.appInfo();
  return info.versionName || VERSION_NAME;
}

export function currentVersionCode() {
  const info = bridge.appInfo();
  return info.versionCode || VERSION_CODE;
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function hostAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && UPDATE_HOSTS.includes(u.hostname) && !u.username && !u.password && (u.port === '' || u.port === '443');
  } catch { return false; }
}

/**
 * Validate update.json. Pure; mirrors UpdateManager.validateMetadata().
 * Returns {ok, error, info}
 */
export function validateUpdateMeta(meta, { packageName = PACKAGE_NAME, versionCode = VERSION_CODE, versionName = VERSION_NAME } = {}) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { ok: false, error: 'Update information is not valid' };
  if (meta.packageName !== packageName) return { ok: false, error: 'Update is for a different app (package name mismatch)' };
  const code = meta.latestVersionCode;
  if (!Number.isInteger(code) || code <= 0 || code > 2100000000) return { ok: false, error: 'Update version code is invalid' };
  if (typeof meta.latestVersionName !== 'string' || !/^\d+(\.\d+){0,3}$/.test(meta.latestVersionName)) return { ok: false, error: 'Update version name is invalid' };
  if (typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(meta.sha256)) return { ok: false, error: 'Update checksum is missing or invalid' };
  if (!hostAllowed(meta.downloadUrl)) return { ok: false, error: 'Update download address is not trusted' };
  if (meta.minimumSupportedVersion != null && (typeof meta.minimumSupportedVersion !== 'string' || !/^\d+(\.\d+){0,3}$/.test(meta.minimumSupportedVersion))) {
    return { ok: false, error: 'Minimum supported version is invalid' };
  }
  const available = code > versionCode;
  const belowMinimum = meta.minimumSupportedVersion ? compareVersions(versionName, meta.minimumSupportedVersion) < 0 : false;
  return {
    ok: true,
    info: {
      available,
      mandatory: available && (meta.mandatoryUpdate === true || belowMinimum),
      latestVersionName: meta.latestVersionName,
      latestVersionCode: code,
      currentVersionName: versionName,
      currentVersionCode: versionCode,
      releaseNotes: String(meta.releaseNotes || '').slice(0, 4000),
      downloadUrl: meta.downloadUrl,
      sha256: meta.sha256.toLowerCase(),
    },
  };
}

export async function checkForUpdate(store) {
  const url = store.settings.update.url;
  if (!/^https:\/\//.test(url)) throw new Error('Update URL must use https');
  if (!bridge.hasNativeUpdater) throw new Error('In-app updates are available in the BizBill Android app.');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('No internet connection');
  // Native code downloads update.json, then applies the same rules as
  // validateUpdateMeta() (package name, version, checksum, trusted host).
  const info = await bridge.nativeCheckUpdate(url);
  if (!info || !info.ok) throw new Error((info && info.error) || 'Could not check for updates');
  await store.patchSettings('update', { lastCheckedAt: nowStamp() });
  return info;
}
