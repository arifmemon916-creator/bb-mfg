// Periodic local tasks run on app start / resume (no background service):
//  - automatic backup when due
//  - local alert notifications (low stock, outstanding, due payments, backup reminder)
//  - optional update check (only when the user enabled it)
// Nothing here sends business data anywhere.

import { createBackup, backupFileName, saveSnapshot } from '../core/backup.js';
import { dueSoon } from '../core/reports.js';
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

async function alerts(store) {
  const n = store.settings.notifications;
  if (!n.enabled) {
    bridge.cancelReminder('backup');
    return;
  }
  const t = today();
  const onceToday = (key, fn) => {
    if (local('notified.' + key) === t) return;
    if (fn()) local('notified.' + key, t);
  };
  if (n.lowStock) {
    onceToday('lowstock', () => {
      const low = store.listProducts().filter((p) => store.isLowStock(p));
      if (!low.length) return false;
      return bridge.notify(1, 'Low stock alert', `${low.length} item(s) at or below minimum stock: ${low.slice(0, 3).map((p) => p.name).join(', ')}${low.length > 3 ? '…' : ''}`);
    });
  }
  if (n.outstanding) {
    onceToday('outstanding', () => {
      let overdue = 0; let count = 0;
      for (const p of store.listParties('customer')) {
        const a = store.account(p.id);
        const old = a.aging[2] + a.aging[3] + a.aging[4];
        if (old > 0) { overdue += old; count++; }
      }
      if (!overdue) return false;
      return bridge.notify(2, 'Outstanding payments', `${count} customer(s) owe ${store.money(overdue)} for more than 30 days.`);
    });
  }
  if (n.paymentDue) {
    onceToday('due', () => {
      const due = dueSoon(store, 2);
      if (!due.length) return false;
      const overdue = due.filter((d) => d.daysLeft < 0).length;
      return bridge.notify(3, 'Payments due', `${due.length} invoice(s) due soon${overdue ? `, ${overdue} overdue` : ''}. Total ${store.money(due.reduce((a, d) => a + d.due, 0))}.`);
    });
  }
  if (n.backupReminder) {
    const last = store.settings.backup.lastBackupAt || store.settings.backup.lastAutoBackupAt;
    const days = n.backupReminderDays || 7;
    const lastDate = last ? last.slice(0, 10) : '';
    if (!lastDate || daysBetween(lastDate, t) >= days) {
      onceToday('backup', () => bridge.notify(4, 'Backup reminder', last ? `Last backup was ${daysBetween(lastDate, t)} days ago. Back up your data now.` : 'You have not backed up your data yet.'));
    }
    const at = (last ? new Date(last).getTime() : Date.now()) + days * 86400000;
    bridge.scheduleReminder('backup', Math.max(at, Date.now() + 3600000), 'Backup reminder', 'It is time to back up your BizBill data.');
  } else {
    bridge.cancelReminder('backup');
  }
}

async function updateCheck(store) {
  const u = store.settings.update;
  if (!u.autoCheck || hoursSince(u.lastCheckedAt) < 24) return;
  try {
    const r = await checkForUpdate(store);
    if (r.available && store.settings.notifications.enabled && store.settings.notifications.updates) {
      bridge.notify(5, 'BizBill update available', `Version ${r.latest} is available.`);
    }
  } catch (e) {
    console.warn('update check failed', e);
  }
}
