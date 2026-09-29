// Update prompt. Optional updates can be postponed ("Later"); mandatory
// security updates show only "Update Now". If the download cannot happen
// (offline, verification failed) the user keeps working; data is never
// touched by the update process.

import { h, icon } from '../ui/dom.js';
import { openSheet } from '../ui/components.js';
import * as bridge from '../platform/bridge.js';

let open = false;

export async function showUpdateDialog(store, info) {
  if (open) return;
  open = true;
  try {
    await openSheet((api) => {
      const status = h('div', { class: 'small', role: 'status' });
      const bar = h('div', { style: { height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden', display: 'none' } },
        h('div', { style: { height: '100%', width: '0%', background: 'var(--brand)', transition: 'width .2s' } }));
      const updateBtn = h('button', { class: 'btn primary', onclick: async () => {
        if (!bridge.hasNativeUpdater) {
          bridge.openExternal(info.downloadUrl);
          if (!info.mandatory) api.close();
          return;
        }
        updateBtn.disabled = true;
        bar.style.display = 'block';
        status.className = 'small';
        status.textContent = 'Downloading update…';
        const r = await bridge.nativeDownloadAndInstall((pct) => {
          bar.firstChild.style.width = Math.max(0, Math.min(100, pct)) + '%';
          status.textContent = pct >= 100 ? 'Verifying update…' : `Downloading update… ${pct}%`;
        });
        updateBtn.disabled = false;
        if (r && r.ok) {
          status.textContent = r.message || 'Verified. Follow the Android installer to finish. Your data is kept.';
          if (!info.mandatory) setTimeout(() => api.close(), 1500);
        } else {
          status.className = 'small neg';
          status.textContent = (r && r.error) || 'Update failed. Please try again later.';
          if (r && r.needsPermission) status.textContent += ' Allow "Install unknown apps" for BizBill, then tap Update Now again.';
          // Never trap the user offline: allow continuing after a failed attempt.
          if (info.mandatory && !content.querySelector('.continue-btn')) {
            content.querySelector('.btn-row').prepend(h('button', { class: 'btn continue-btn', onclick: () => api.close() }, 'Continue for now'));
          }
        }
      } }, icon('download'), 'Update Now');
      const later = info.mandatory ? null : h('button', { class: 'btn', onclick: async () => {
        await store.patchSettings('update', { dismissedVersionCode: info.latestVersionCode });
        api.close();
      } }, 'Later');
      const content = h('div', null,
        h('h2', null, info.mandatory ? 'Security Update Required' : 'New BizBill Update Available'),
        info.mandatory ? h('p', { class: 'note warn' }, 'This version is no longer supported. Please update to keep your data secure. Your bills and settings are preserved.') : null,
        h('div', { class: 'kv' },
          h('div', { class: 'k' }, 'Current Version'), h('div', { class: 'v' }, `${info.currentVersionName} (${info.currentVersionCode})`),
          h('div', { class: 'k' }, 'New Version'), h('div', { class: 'v strong' }, `${info.latestVersionName} (${info.latestVersionCode})`)),
        info.releaseNotes ? h('div', null, h('h3', { style: { marginTop: '12px' } }, "What's New"),
          h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', maxHeight: '30vh', overflow: 'auto', fontFamily: 'inherit' } }, info.releaseNotes)) : null,
        bar, status,
        h('p', { class: 'small muted' }, 'The update is verified (checksum, package and signature) before Android asks you to install it. Taking a backup first is recommended.'),
        h('div', { class: 'btn-row' }, later, updateBtn));
      return content;
    }, { dismissable: !info.mandatory });
  } finally {
    open = false;
  }
}
