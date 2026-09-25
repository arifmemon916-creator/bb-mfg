// Update Center: compares the installed version with the latest release.
// The only network request BizBill ever makes, and only when the user asks
// (or explicitly enables automatic checks). No business data is sent.

import { APP_VERSION } from '../core/backup.js';
import { appInfo } from '../platform/bridge.js';
import { nowStamp } from '../core/dates.js';

export function currentVersion() {
  const info = appInfo();
  return info.versionName || APP_VERSION;
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

export async function checkForUpdate(store) {
  const url = store.settings.update.url;
  if (!/^https:\/\//.test(url)) throw new Error('Update URL must use https');
  if (!navigator.onLine) throw new Error('No internet connection');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let data;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json, application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 404) throw new Error('No published release found yet');
    if (!res.ok) throw new Error('Update server returned ' + res.status);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const latest = String(data.tag_name || data.version || '').replace(/^v/i, '');
  if (!latest) throw new Error('Update information is not in the expected format');
  const apk = (data.assets || []).find((a) => /\.apk$/i.test(a.name || ''));
  await store.patchSettings('update', { lastCheckedAt: nowStamp() });
  const current = currentVersion();
  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    notes: String(data.body || data.notes || '').slice(0, 4000),
    downloadUrl: (apk && apk.browser_download_url) || data.html_url || data.url || '',
    publishedAt: data.published_at || '',
  };
}
