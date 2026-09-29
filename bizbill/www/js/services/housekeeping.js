// Periodic local tasks run on app start / resume (no background service):
//  - automatic backup when due
//  - local alert notifications (low stock, outstanding, due payments, backup reminder)
//  - optional update check (only when the user enabled it)
// Nothing here sends business data anywhere.

import { createBackup, backupFileName, saveSnapshot } from '../core/backup.js';
import { evaluateAlerts, emptyAlertState } from '../core/alerts.js';
import { fmt } from '../views/common.js';
import { daysBetween, today, nowStamp } from '../core/dates.js';
import * as bridge from '../platform/bridge.js';
import { checkForUpdate } from './update.js';

let running = false;

function local(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('bizbill.' + key);
    localStorage.setItem('bizbill.' + key, value);
  } catch { /* storage unavailable: treat as not yet done */ }
  return null;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

export async function runHousekeeping(store, reason) {
  if (running) return;
  running = true;
  try {
    await autoBackup(store);
    await alerts(store);
    await updateCheck(store);
  } finally {
    running = false;
  }
  void reason;
}

export async function autoBackup(store, force = false) {
  const b = store.settings.backup;
  if (!b.auto && !force) return null;
  const every = b.frequency === 'weekly' ? 24 * 7 : 24;
  if (!force && hoursSince(b.lastAutoBackupAt) < every) return null;
  const hasData = store.parties.size || store.products.size || store.documents.size;
  if (!hasData) return null;
  let where = 'device';
  if (bridge.hasNativeBackups) {
    const backup = await createBackup(store);
    const name = 'auto-' + backupFileName(store.settings.company.name);
    const r = bridge.writeBackupFile(name, JSON.stringify(backup));
    if (!r || !r.ok) throw new Error('Automatic backup failed: ' + ((r && r.error) || 'unknown error'));
    // Keep only the newest N automatic backups.
    const autos = bridge.listBackupFiles().filter((f) => f.name.startsWith('auto-')).sort((x, y) => y.modified - x.modified);
    for (const old of autos.slice(b.keep || 7)) bridge.deleteBackupFile(old.name);
    where = 'file';
  } else {
    await saveSnapshot(store, 'auto', b.keep || 7);
  }
  await store.patchSettings('backup', { lastAutoBackupAt: nowStamp() });
  return where;
}

let seq = 0;

/**
 * Evaluate alerts, store new ones in the notification center, post them as
 * Android notifications and refresh the reminder alarm schedule.
 * Safe to call often: de-duplication state prevents repeated alerts.
 */
export async function runAlerts(store) {
  const n = store.settings.notifications;
  const f = fmt(store);
  const prev = store.meta.get('alertState') || emptyAlertState();
  const r = evaluateAlerts(store, prev, today(), f.money, f.qty);
  const created = await store.addNotifications(r.notifications, r.state);
  if (!n.enabled) {
    bridge.setReminderSchedule([]);
    bridge.cancelReminder('backup');
    return created;
  }
  created.forEach((c, i) => {
    const src = r.notifications[i];
    bridge.notifyRich({ id: 1000 + (++seq % 5000), type: c.type, title: c.title, message: c.message, route: c.route, actions: src.actions || [], fullScreen: !!src.fullScreen, sound: n.sound, vibration: n.vibration });
  });
  const [hh, mm] = String(n.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  const items = r.schedule.map((x) => {
    const [y, mo, d] = x.date.split('-').map(Number);
    return { key: x.key, at: new Date(y, mo - 1, d, hh, mm).getTime(), type: x.type, title: x.title, message: x.message, route: x.route, actions: x.actions || [], fullScreen: !!x.fullScreen, sound: n.sound, vibration: n.vibration };
  }).filter((x) => x.at > Date.now()).sort((a, b) => a.at - b.at);
  bridge.setReminderSchedule(items);

  // Backup reminder (once a day while overdue) + native alarm.
  if (n.backupReminder) {
    const last = store.settings.backup.lastBackupAt || store.settings.backup.lastAutoBackupAt;
    const days = n.backupReminderDays || 7;
    const lastDate = last ? last.slice(0, 10) : '';
    const t = today();
    if ((!lastDate || daysBetween(lastDate, t) >= days) && local('notified.backup') !== t) {
      local('notified.backup', t);
      const msg = last ? `Last backup was ${daysBetween(lastDate, t)} days ago. Back up your data now.` : 'You have not backed up your data yet.';
      await store.addNotifications([{ type: 'backup', title: 'Backup Reminder', message: msg, route: '#/backup' }]);
      bridge.notifyRich({ id: 4, type: 'backup', title: 'Backup Reminder', message: msg, route: '#/backup', actions: [{ label: 'Backup now', route: '#/backup' }], sound: n.sound, vibration: n.vibration });
    }
    const at = (last ? new Date(last).getTime() : Date.now()) + days * 86400000;
    bridge.scheduleReminder('backup', Math.max(at, Date.now() + 3600000), 'Backup Reminder', 'It is time to back up your BizBill data.');
  } else {
    bridge.cancelReminder('backup');
  }
  return created;
}

async function alerts(store) {
  await runAlerts(store);
}

/** Re-run alerts shortly after data changes (stock, payments, due dates). */
export function watchForAlerts(store) {
  let timer = null;
  let lastVersion = store.version;
  store.onChange((v) => {
    if (v === lastVersion) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      lastVersion = store.version;
      runAlerts(store).catch((e) => console.warn('alerts', e));
    }, 1500);
  });
}

async function updateCheck(store) {
  const u = store.settings.update;
  // In-app updates are an Android feature; the browser build updates itself on reload.
  if (!bridge.hasNativeUpdater || !u.autoCheck || hoursSince(u.lastCheckedAt) < 6) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // offline: silently skip
  try {
    const info = await checkForUpdate(store);
    if (!info.available) return;
    if (local('notified.update') !== String(info.latestVersionCode)) {
      local('notified.update', String(info.latestVersionCode));
      const title = info.mandatory ? 'Security Update Required' : 'New BizBill Update Available';
      const msg = `Version ${info.latestVersionName} is available (you have ${info.currentVersionName}).`;
      await store.addNotifications([{ type: 'update', title, message: msg, route: '#/update' }]);
      const n = store.settings.notifications;
      if (n.enabled && n.updates) bridge.notifyRich({ id: 5, type: 'update', title, message: msg, route: '#/update', actions: [{ label: 'View update', route: '#/update' }], sound: n.sound, vibration: n.vibration });
    }
    if (info.mandatory || info.latestVersionCode > (u.dismissedVersionCode || 0)) {
      const { showUpdateDialog } = await import('../views/update-dialog.js');
      showUpdateDialog(store, info);
    }
  } catch (e) {
    console.warn('update check skipped:', e.message);
  }
}

/** Check again when connectivity returns (no polling). */
export function watchConnectivity(store) {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => updateCheck(store));
}
