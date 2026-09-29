// Backup & restore, CSV import / export, activity history, recycle bin.

import { h, icon, clear, put } from '../ui/dom.js';
import {
  toast, errorToast, confirmDialog, openSheet, pickFile, readAsText, switchRow, selectInput, lazyList, emptyState, kv, promptDialog,
} from '../ui/components.js';
import { fmt } from './common.js';
import {
  createBackup, backupFileName, validateBackup, restoreBackup, listSnapshots, getSnapshot, deleteSnapshot,
  encryptBackup, decryptBackup, isEncryptedBackup, backupPasswordError,
} from '../core/backup.js';
import { IMPORT_SCHEMAS, parseImport, commitImport, importTemplate, exportParties, exportProducts } from '../core/csv.js';
import * as bridge from '../platform/bridge.js';
import { nowStamp, today } from '../core/dates.js';
import { autoBackup } from '../services/housekeeping.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

// ------------------------------------------------------------------ backup

export function backupView({ store, app }) {
  const host = h('div');
  const draw = async () => {
    const b = store.settings.backup;
    const snaps = await listSnapshots(store);
    const files = bridge.listBackupFiles().sort((x, y) => y.modified - x.modified);
    clear(host);
    put(host, 
      h('div', { class: 'card' },
        kv([['Last manual backup', when(b.lastBackupAt)], ['Last automatic backup', when(b.lastAutoBackupAt)]]),
        h('div', { class: 'btn-row', style: { marginTop: '12px' } },
          h('button', { class: 'btn primary', onclick: backupNow }, icon('download'), 'Backup now'),
          h('button', { class: 'btn', onclick: restoreFromFile }, icon('upload'), 'Restore backup')),
        h('p', { class: 'small muted' }, 'A backup contains customers, suppliers, products, invoices, purchases, quotations, payments, expenses (with receipts), stock adjustments, activity history and settings. Temporary files and caches are never included. Keep backups somewhere safe (Google Drive, email to yourself, PC).')),
      h('div', { class: 'card' },
        switchRow('Automatic backup', bridge.hasNativeBackups ? 'Saved on this device in the app\'s backup folder when you open the app' : 'Saved inside this browser when you open the app', b.auto, async (on) => {
          await store.patchSettings('backup', { auto: on }, 'Automatic backup ' + (on ? 'enabled' : 'disabled'));
          if (on) { try { await autoBackup(store, true); toast('Automatic backup created', 'good'); } catch (e) { errorToast(e); } }
          draw();
        }),
        b.auto ? h('div', { class: 'switch-row' }, h('div', null, h('div', { class: 't' }, 'Frequency')),
          selectInput('freq', [['daily', 'Daily'], ['weekly', 'Weekly']], b.frequency, { style: { width: 'auto' }, onchange: async (e) => { await store.patchSettings('backup', { frequency: e.target.value }); } })) : null,
        b.auto ? h('div', { class: 'switch-row' }, h('div', null, h('div', { class: 't' }, 'Keep last')),
          selectInput('keep', [['3', '3 backups'], ['7', '7 backups'], ['14', '14 backups'], ['30', '30 backups']], String(b.keep), { style: { width: 'auto' }, onchange: async (e) => { await store.patchSettings('backup', { keep: parseInt(e.target.value, 10) }); } })) : null,
        h('p', { class: 'small muted' }, 'Device backups are removed if the app is uninstalled or its data cleared. Use "Backup now" regularly to save a copy outside the app.')),
      h('div', { class: 'section-title' }, 'Backup history'),
      (files.length || snaps.length) ? h('div', { class: 'list' },
        files.map((f) => historyItem(f.name, new Date(f.modified).toISOString(), f.size, 'Device file', async () => {
          const json = bridge.readBackupFile(f.name);
          if (!json) { toast('Could not read the backup file', 'bad'); return; }
          await restoreFlow(store, app, json);
        }, async () => {
          if (await confirmDialog({ title: 'Delete backup file?', message: f.name, confirmText: 'Delete', danger: true })) { bridge.deleteBackupFile(f.name); draw(); }
        }, async () => {
          const json = bridge.readBackupFile(f.name);
          if (json) await bridge.shareFile(new Blob([json], { type: 'application/json' }), f.name.replace(/^auto-/, ''), { subject: 'BizBill backup' });
        })),
        snaps.map((s) => historyItem(s.reason === 'before-restore' ? 'Safety copy before restore' : s.reason === 'auto' ? 'Automatic backup' : s.reason, s.createdAt, s.size,
          `${s.counts ? s.counts.sales + ' invoices, ' + s.counts.customers + ' customers' : ''}`, async () => {
            const obj = await getSnapshot(store, s.id);
            await restoreFlow(store, app, JSON.stringify(obj));
          }, async () => {
            if (await confirmDialog({ title: 'Delete this backup?', confirmText: 'Delete', danger: true })) { await deleteSnapshot(store, s.id); draw(); }
          }, async () => {
            const obj = await getSnapshot(store, s.id);
            await bridge.saveFile(new Blob([JSON.stringify(obj)], { type: 'application/json' }), backupFileName(store.settings.company.name, new Date(s.createdAt)));
          }))) : emptyState('clock', 'No backups yet'),
    );
  };
  const backupNow = async () => {
    try {
      const backup = await createBackup(store);
      const json = JSON.stringify(backup);
      const name = backupFileName(store.settings.company.name);
      let password = '';
      const choice = await openSheet((api) => {
        const protect = h('input', { type: 'checkbox', checked: true });
        const pw1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters', 'aria-label': 'Backup password' });
        const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password', 'aria-label': 'Repeat backup password' });
        const pwBox = h('div', { class: 'form' }, pw1, pw2, h('div', { class: 'small muted' }, 'Keep this password safe. Without it the backup cannot be restored.'));
        const err = h('div', { class: 'err small' });
        protect.addEventListener('change', () => pwBox.classList.toggle('hidden', !protect.checked));
        const go = (target) => {
          if (protect.checked) {
            const e = backupPasswordError(pw1.value);
            if (e) { err.textContent = e; return; }
            if (pw1.value !== pw2.value) { err.textContent = 'Passwords do not match'; return; }
            password = pw1.value;
          }
          api.close(target);
        };
        return h('div', null, h('h2', null, 'Save backup'),
          h('p', { class: 'small' }, `${backup.counts.sales} invoices · ${backup.counts.purchases} purchases · ${backup.counts.customers} customers · ${backup.counts.products} products · ${(json.length / 1024).toFixed(0)} KB`),
          h('label', { class: 'check' }, protect, 'Protect with password (AES-256 encryption) — recommended'), pwBox, err,
          h('div', { class: 'picker-list' },
            h('button', { class: 'item', onclick: () => go('save') }, icon('download'), h('div', { class: 'main' }, h('div', { class: 'title' }, 'Save to device / Drive'), h('div', { class: 'subtitle' }, 'Choose a folder or Google Drive'))),
            h('button', { class: 'item', onclick: () => go('share') }, icon('share'), h('div', { class: 'main' }, h('div', { class: 'title' }, 'Share'), h('div', { class: 'subtitle' }, 'Email, WhatsApp, Drive…')))),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel')));
      });
      if (!choice) return;
      const fileJson = password ? JSON.stringify(await encryptBackup(backup, password)) : json;
      const blob = new Blob([fileJson], { type: 'application/json' });
      const r = choice === 'save' ? await bridge.saveFile(blob, name) : await bridge.shareFile(blob, name, { subject: 'BizBill backup ' + today(), text: 'BizBill backup file' });
      if (bridge.hasNativeBackups) bridge.writeBackupFile(name, json);
      if (r && (r.ok || r.downloaded || r.saved)) {
        await store.patchSettings('backup', { lastBackupAt: nowStamp() });
        await store.logEvent('backup.create', `Backup created (${backup.counts.sales} invoices, ${backup.counts.customers} customers)`);
        toast('Backup saved', 'good');
      }
      draw();
    } catch (e) { errorToast(e); }
  };
  const restoreFromFile = async () => {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    try { await restoreFlow(store, app, await readAsText(file)); } catch (e) { errorToast(e); }
  };
  draw();
  return { title: 'Backup & Restore', back: true, content: host };
}

function historyItem(title, iso, size, sub, onRestore, onDelete, onExport) {
  return h('div', { class: 'item' },
    h('div', { class: 'main' }, h('div', { class: 'title' }, title), h('div', { class: 'subtitle' }, [when(iso), size ? (size / 1024).toFixed(0) + ' KB' : '', sub].filter(Boolean).join(' · '))),
    h('button', { class: 'icon-btn', 'aria-label': 'Export', onclick: onExport }, icon('share')),
    h('button', { class: 'icon-btn', 'aria-label': 'Restore', onclick: onRestore }, icon('restore')),
    h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: onDelete }, icon('trash')));
}

/** Validate -> show details -> confirm -> safety backup -> restore. */
async function restoreFlow(store, app, text) {
  let obj;
  try { obj = JSON.parse(text); } catch { toast('This file is not a valid BizBill backup (not JSON)', 'bad'); return; }
  if (isEncryptedBackup(obj)) {
    const pw = await promptDialog({ title: 'Password protected backup', label: 'Backup password', type: 'password', message: `Created ${when(obj.createdAt)}${obj.company ? ' · ' + obj.company : ''}` });
    if (!pw) return;
    try { obj = await decryptBackup(obj, pw); } catch (e) { toast(e.message, 'bad'); return; }
  }
  const v = await validateBackup(obj);
  if (!v.ok) {
    await openSheet((api) => h('div', null, h('h2', null, 'Backup cannot be restored'),
      h('div', { class: 'note bad' }, h('ul', null, v.errors.map((e) => h('li', null, e)))),
      h('p', { class: 'small' }, 'Nothing was changed.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close() }, 'Close'))));
    return;
  }
  const c = v.info.counts;
  const ok = await confirmDialog({
    title: 'Restore this backup?',
    message: `Backup date: ${when(v.info.createdAt)}\nCompany: ${v.info.company || '—'}\nApp version: ${v.info.appVersion || '—'}\n\nALL current data on this device will be replaced by the backup. A safety copy of the current data is saved first (Backup history → "Safety copy before restore").`,
    details: [
      ...(v.warnings || []),
      `${c.customers} customers, ${c.suppliers} suppliers`, `${c.products} products`,
      `${c.sales} invoices, ${c.purchases} purchases, ${c.quotations} quotations`,
      `${c.payments} payments, ${c.expenses} expenses`, `${c.stockMoves} stock adjustments`,
    ],
    confirmText: 'Restore', danger: true, requireText: 'RESTORE',
  });
  if (!ok) return;
  try {
    const res = await restoreBackup(store, obj);
    toast('Backup restored successfully' + (res.skippedAttachments ? ` (${res.skippedAttachments} damaged attachment(s) skipped)` : ''), 'good');
    app.applyTheme();
    app.navigate('#/dashboard', { replace: true });
  } catch (e) {
    errorToast(e);
  }
}

// ------------------------------------------------------------------ import / export

export function importExport({ store, app }) {
  const host = h('div');
  const exp = (type) => {
    const csv = type === 'product' ? exportProducts(store) : exportParties(store, type);
    return bridge.saveFile(new Blob([csv], { type: 'text/csv' }), `${IMPORT_SCHEMAS[type].label}_${today()}.csv`);
  };
  const tmpl = (type) => bridge.saveFile(new Blob([importTemplate(type)], { type: 'text/csv' }), `${IMPORT_SCHEMAS[type].label}_template.csv`);
  const imp = async (type) => {
    const file = await pickFile('.csv,text/csv,text/comma-separated-values,text/plain');
    if (!file) return;
    let parsed;
    try { parsed = parseImport(store, type, await readAsText(file)); } catch (e) { errorToast(e); return; }
    const go = await openSheet((api) => {
      const errs = parsed.rows.filter((r) => r.errors.length);
      return h('div', null, h('h2', null, `Import ${IMPORT_SCHEMAS[type].label}`),
        parsed.headerErrors.length ? h('div', { class: 'note bad' }, parsed.headerErrors.join('\n')) : h('div', null,
          h('p', null, h('b', null, parsed.validCount), ' valid row(s) · ', h('b', { class: parsed.errorCount ? 'neg' : '' }, parsed.errorCount), ' row(s) with errors'),
          errs.length ? h('div', { class: 'note warn', style: { maxHeight: '40vh', overflow: 'auto' } },
            h('b', null, 'These rows will NOT be imported:'),
            h('ul', { class: 'small' }, errs.slice(0, 200).map((r) => h('li', null, `Line ${r.line} (${r.values.name || 'no name'}): ${r.errors.join('; ')}`)))) : null,
          parsed.validCount ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Preview: ' + parsed.rows.filter((r) => !r.errors.length).slice(0, 5).map((r) => r.record.name).join(', ') + (parsed.validCount > 5 ? '…' : '')) : null),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(false) }, 'Cancel'),
          !parsed.headerErrors.length && parsed.validCount ? h('button', { class: 'btn primary', onclick: () => api.close(true) }, `Import ${parsed.validCount} row(s)`) : null));
    });
    if (!go) return;
    try {
      const n = await commitImport(store, type, parsed);
      toast(`Imported ${n} record(s)`, 'good');
    } catch (e) { errorToast(e); }
  };
  const section = (type, ic) => h('div', { class: 'card' },
    h('h2', null, IMPORT_SCHEMAS[type].label),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => imp(type) }, icon('upload'), 'Import CSV'),
      h('button', { class: 'btn', onclick: () => exp(type) }, icon('download'), 'Export CSV'),
      h('button', { class: 'btn ghost', onclick: () => tmpl(type) }, icon(ic), 'Template')));
  put(host, 
    h('p', { class: 'note' }, 'Import checks required fields, number formats, GSTIN checksum, duplicates, negative quantities and prices. You see every problem row before anything is saved, and valid rows are imported together in one step.'),
    section('customer', 'users'), section('supplier', 'truck'), section('product', 'tag'),
    h('div', { class: 'card' }, h('h2', null, 'Other exports'),
      h('div', { class: 'stack' },
        h('a', { class: 'btn', href: '#/sales' }, 'Sales list → CSV (use the download icon)'),
        h('a', { class: 'btn', href: '#/reports' }, 'Any report → PDF / CSV'),
        h('a', { class: 'btn', href: '#/backup' }, 'Full backup (JSON)'))));
  void app;
  return { title: 'Import / Export', back: true, content: host };
}

// ------------------------------------------------------------------ audit

export async function auditView({ store }) {
  const entries = await store.listAudit(1000);
  return {
    title: 'Activity history',
    back: true,
    content: entries.length ? lazyList(entries, (a) => h('div', { class: 'item' },
      h('div', { class: 'main' }, h('div', { class: 'title', style: { whiteSpace: 'normal' } }, a.summary || a.action), h('div', { class: 'subtitle' }, `${new Date(a.ts).toLocaleString()} · ${a.action}`)))) : emptyState('clock', 'No activity yet'),
  };
}

// ------------------------------------------------------------------ recycle bin

export function recycleBin({ store, app }) {
  const f = fmt(store);
  const parties = store.listParties(null, { includeDeleted: true }).filter((p) => p.deleted);
  const products = store.listProducts({ includeDeleted: true }).filter((p) => p.deleted);
  const quotes = store.listDocuments('quotation', { includeDeleted: true }).filter((d) => d.deleted);
  const cancelled = [...store.listDocuments('sale'), ...store.listDocuments('purchase')].filter((d) => d.status === 'cancelled');
  const item = (title, sub, onRestore, href) => h('div', { class: 'item' },
    h(href ? 'a' : 'div', { class: 'main', href, style: { color: 'inherit', textDecoration: 'none' } }, h('div', { class: 'title' }, title), h('div', { class: 'subtitle' }, sub)),
    onRestore ? h('button', { class: 'btn small', onclick: async () => { await onRestore(); toast('Restored', 'good'); app.refresh(); } }, icon('restore'), 'Restore') : null);
  const none = !parties.length && !products.length && !quotes.length && !cancelled.length;
  return {
    title: 'Recycle bin',
    back: true,
    content: h('div', null,
      h('p', { class: 'note' }, 'Deleted customers, suppliers, products and quotations stay here and can be restored. Invoices and purchases are never deleted — they are cancelled (voided) and kept for your records.'),
      none ? emptyState('restore', 'Recycle bin is empty') : null,
      parties.length ? h('div', null, h('div', { class: 'section-title' }, 'Customers & suppliers'), h('div', { class: 'list' }, parties.map((p) => item(p.name, (p.type === 'customer' ? 'Customer' : 'Supplier') + (p.deletedAt ? ' · deleted ' + when(p.deletedAt) : ''), () => store.restoreParty(p.id), '#/party/' + p.id)))) : null,
      products.length ? h('div', null, h('div', { class: 'section-title' }, 'Products'), h('div', { class: 'list' }, products.map((p) => item(p.name, p.deletedAt ? 'Deleted ' + when(p.deletedAt) : '', () => store.restoreProduct(p.id), '#/product/' + p.id)))) : null,
      quotes.length ? h('div', null, h('div', { class: 'section-title' }, 'Quotations'), h('div', { class: 'list' }, quotes.map((d) => item(d.number, `${d.party.name} · ${f.money(d.totals.grandTotal)}`, () => store.deleteQuotation(d.id, true))))) : null,
      cancelled.length ? h('div', null, h('div', { class: 'section-title' }, 'Cancelled invoices & purchases (kept for records)'), h('div', { class: 'list' }, cancelled.map((d) => item(`${d.kind === 'sale' ? 'Invoice' : 'Purchase'} ${d.number}`, `${d.party.name} · ${f.money(d.totals.grandTotal)} · ${d.cancelReason || ''}`, null, '#/doc/' + d.id)))) : null),
  };
}

// ------------------------------------------------------------------ legacy data

export async function legacyImport({ store, app }) {
  const info = bridge.legacyDataInfo();
  const host = h('div');
  if (!info.found) {
    return { title: 'Previous version data', back: true, content: emptyState('info', 'No data from a previous BizBill version was found on this device.') };
  }
  const raw = bridge.readLegacyData();
  let dump = null;
  try { dump = JSON.parse(raw); } catch { /* reported below */ }
  const { analyseLegacy, importLegacy } = await import('../core/legacy.js');
  const a = dump ? analyseLegacy(dump) : null;
  const checks = {
    customers: h('input', { type: 'checkbox', checked: !!(a && a.customers.length) }),
    suppliers: h('input', { type: 'checkbox', checked: !!(a && a.suppliers.length) }),
    products: h('input', { type: 'checkbox', checked: !!(a && a.products.length) }),
    invoices: h('input', { type: 'checkbox', checked: false }),
  };
  const exportRaw = () => bridge.saveFile(new Blob([raw || ''], { type: 'application/json' }), `BizBill-previous-version-data-${today()}.json`);
  put(host,
    h('div', { class: 'note' }, 'BizBill found data saved by a previous version of the app on this phone. It has been copied to a private file and the original is left untouched, so nothing is lost. Review what was found and choose what to bring into this version.'),
    !a ? h('div', { class: 'note bad', style: { marginTop: '10px' } }, 'The previous data could not be read automatically. Export the raw file and contact support; it is kept safely on the device.') : h('div', { class: 'card', style: { marginTop: '10px' } },
      h('h2', null, 'Found'),
      h('label', { class: 'check' }, checks.customers, `${a.customers.length} customers`),
      h('label', { class: 'check' }, checks.suppliers, `${a.suppliers.length} suppliers`),
      h('label', { class: 'check' }, checks.products, `${a.products.length} products (their current stock becomes opening stock)`),
      h('label', { class: 'check' }, checks.invoices, `${a.invoices.length} invoices (review after import: totals are recalculated with BizBill's GST engine)`),
      a.sources.length ? h('details', { class: 'more' }, h('summary', null, 'Details'), h('ul', { class: 'small' }, a.sources.map((x) => h('li', null, `${x.label}: ${x.count} ${x.kind} record(s)`)))) : null,
      h('p', { class: 'small muted' }, 'Records whose name already exists in this version are skipped, never overwritten.')),
    h('div', { class: 'btn-row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: exportRaw }, icon('download'), 'Export raw data'),
      h('button', { class: 'btn', onclick: () => { bridge.markLegacyImported(); app.navigate('#/dashboard', { replace: true }); } }, 'Not now'),
      a ? h('button', { class: 'btn primary', onclick: async () => {
        const ok = await confirmDialog({ title: 'Import previous data?', message: 'A safety backup of the current data is taken first.', confirmText: 'Import' });
        if (!ok) return;
        try {
          const { saveSnapshot } = await import('../core/backup.js');
          await saveSnapshot(store, 'before-legacy-import', 3);
          const r = await importLegacy(store, a, { customers: checks.customers.checked, suppliers: checks.suppliers.checked, products: checks.products.checked, invoices: checks.invoices.checked });
          bridge.markLegacyImported();
          toast(`Imported ${r.customers} customers, ${r.suppliers} suppliers, ${r.products} products, ${r.invoices} invoices${r.problems.length ? ` · ${r.problems.length} problem(s)` : ''}`, r.problems.length ? '' : 'good');
          if (r.problems.length) console.warn(r.problems);
          app.navigate('#/dashboard', { replace: true });
        } catch (e) { errorToast(e); }
      } }, 'Import selected') : null));
  return { title: 'Previous version data', back: true, content: host };
}
