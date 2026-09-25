import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { BizStore } from '../www/js/core/store.js';
import { Database } from '../www/js/core/db.js';
import { evaluateAlerts, emptyAlertState, dueSummary } from '../www/js/core/alerts.js';
import { sniffType, parseDataUrl, isValidAttachment } from '../www/js/core/files.js';
import { createBackup, encryptBackup, decryptBackup, validateBackup, restoreBackup, isEncryptedBackup } from '../www/js/core/backup.js';
import { migrateData } from '../www/js/core/migrate.js';

const money = (p) => '₹' + (p / 100).toFixed(2);
// Minimal valid files (real magic bytes).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const FAKE_PNG = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');

async function freshStore() {
  const s = new BizStore(new Database('alerts-' + Math.random(), new IDBFactory()));
  await s.init();
  const st = structuredClone(s.settings);
  st.company.stateCode = '27';
  st.notifications.enabled = true;
  st.notifications.reminderOffsets = [0, 3];
  await s.saveSettings(st);
  return s;
}

test('low stock alerts fire once and re-arm after restock', async () => {
  const s = await freshStore();
  const p = await s.saveProduct({ name: 'Coca Cola 250ml', openingStock: 25000, minStock: 20000, unit: 'PCS' });
  let st = emptyAlertState();
  let r = evaluateAlerts(s, st, '2026-09-25', money);
  assert.equal(r.notifications.length, 0, 'above minimum: no alert');
  await s.adjustStock(p.id, -5000, 'Sold offline', '2026-09-25'); // 20 = minimum
  r = evaluateAlerts(s, r.state, '2026-09-25', money);
  assert.equal(r.notifications.length, 1, 'reaching minimum alerts');
  assert.match(r.notifications[0].message, /Current Stock: 20 PCS\nMinimum Stock: 20 PCS/);
  st = r.state;
  for (let i = 0; i < 3; i++) { r = evaluateAlerts(s, st, '2026-09-26', money); st = r.state; }
  assert.equal(r.notifications.length, 0, 'repeated launches do not duplicate');
  await s.adjustStock(p.id, -12000, 'Sold', '2026-09-26'); // 8, still low
  r = evaluateAlerts(s, st, '2026-09-26', money); st = r.state;
  assert.equal(r.notifications.length, 0, 'still low: no new alert');
  await s.adjustStock(p.id, 30000, 'Restock', '2026-09-27'); // 38
  r = evaluateAlerts(s, st, '2026-09-27', money); st = r.state;
  assert.equal(r.notifications.length, 0);
  await s.adjustStock(p.id, -30000, 'Sold', '2026-09-28'); // 8 again
  r = evaluateAlerts(s, st, '2026-09-28', money);
  assert.equal(r.notifications.length, 1, 'newly low again after restock alerts again');
  await s.saveProduct({ ...s.products.get(p.id), lowStockAlert: false });
  r = evaluateAlerts(s, emptyAlertState(), '2026-09-28', money);
  assert.equal(r.notifications.length, 0, 'per-product alert switch respected');
});

test('payment due reminders, partial payment amounts, overdue and closing', async () => {
  const s = await freshStore();
  const c = await s.saveParty({ type: 'customer', name: 'ABC Traders', stateCode: '27' });
  const inv = await s.saveDocument({ kind: 'sale', partyId: c.id, date: '2026-09-01', dueDate: '2026-09-25', gst: false, roundOff: false,
    items: [{ name: 'Goods', qty: 1000, rate: 500000 }] });
  // 10 days before: nothing now, reminders scheduled for 22nd (3 days) and 25th, overdue on 26th.
  let r = evaluateAlerts(s, emptyAlertState(), '2026-09-15', money);
  assert.equal(r.notifications.length, 0);
  assert.deepEqual(r.schedule.map((x) => x.date).sort(), ['2026-09-22', '2026-09-25', '2026-09-26']);
  // Partial payment: reminders show the remaining balance.
  await s.savePayment({ direction: 'in', partyId: c.id, amount: 300000, allocations: [{ docId: inv.id, amount: 300000 }] });
  r = evaluateAlerts(s, emptyAlertState(), '2026-09-15', money);
  assert.ok(r.schedule.every((x) => x.amount === 200000));
  assert.match(r.schedule[0].message, /Outstanding: ₹2000\.00 \(of ₹5000\.00\)/);
  // 3 days before -> one alert, not repeated.
  r = evaluateAlerts(s, emptyAlertState(), '2026-09-22', money);
  assert.equal(r.notifications.length, 1);
  assert.match(r.notifications[0].title, /due in 3 days/);
  let st = r.state;
  r = evaluateAlerts(s, st, '2026-09-23', money); st = r.state;
  assert.equal(r.notifications.length, 0);
  // Due today.
  r = evaluateAlerts(s, st, '2026-09-25', money); st = r.state;
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].title, 'Payment Due Today');
  assert.equal(dueSummary(s, '2026-09-25').dueToday.length, 1);
  // Overdue, once.
  r = evaluateAlerts(s, st, '2026-09-30', money); st = r.state;
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0].type, 'overdue');
  assert.equal(r.notifications[0].daysOverdue, 5);
  r = evaluateAlerts(s, st, '2026-10-01', money); st = r.state;
  assert.equal(r.notifications.length, 0, 'no duplicate overdue alerts');
  // Snooze.
  const snoozed = { ...st, overdue: {}, snooze: { [inv.id]: '2026-10-05' } };
  assert.equal(evaluateAlerts(s, snoozed, '2026-10-02', money).notifications.length, 0);
  // Full payment closes everything.
  await s.savePayment({ direction: 'in', partyId: c.id, amount: 200000, allocations: [{ docId: inv.id, amount: 200000 }] });
  r = evaluateAlerts(s, st, '2026-10-02', money);
  assert.equal(r.notifications.length, 0);
  assert.equal(r.schedule.length, 0, 'paid invoice has no future reminders');
  assert.deepEqual(r.state.overdue, {});
  assert.equal(s.docStatus(inv), 'paid');
});

test('per-invoice reminder offsets override the default', async () => {
  const s = await freshStore();
  const c = await s.saveParty({ type: 'customer', name: 'X' });
  await s.saveDocument({ kind: 'sale', partyId: c.id, dueDate: '2026-10-20', reminders: { offsets: [7, 0, 7] }, items: [{ name: 'A', qty: 1000, rate: 100 }] });
  const r = evaluateAlerts(s, emptyAlertState(), '2026-10-01', money);
  assert.deepEqual(r.schedule.filter((x) => x.type === 'due').map((x) => x.date).sort(), ['2026-10-13', '2026-10-20']);
});

test('file type is detected from content, not the name', () => {
  assert.equal(sniffType(Buffer.from(PNG.split(',')[1], 'base64')), 'image/png');
  assert.equal(sniffType(Buffer.from('%PDF-1.7')), 'application/pdf');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(parseDataUrl(FAKE_PNG), null, 'script disguised as png is rejected');
  assert.equal(parseDataUrl('data:image/png;base64,@@@'), null);
  assert.ok(isValidAttachment({ id: 'a', data: PNG }));
  assert.ok(!isValidAttachment({ id: 'b', data: FAKE_PNG }));
});

test('payment attachments: up to 4, validated, removable', async () => {
  const s = await freshStore();
  const c = await s.saveParty({ type: 'customer', name: 'Afjal 2' });
  const five = [1, 2, 3, 4, 5].map((i) => ({ name: 'bill' + i + '.png', data: PNG }));
  await assert.rejects(() => s.savePayment({ direction: 'in', partyId: c.id, amount: 5500, attachments: five }), /At most 4/);
  await assert.rejects(() => s.savePayment({ direction: 'in', partyId: c.id, amount: 5500, attachments: [{ name: 'x.png', data: FAKE_PNG }] }), /not a valid photo or PDF/);
  const p = await s.savePayment({ direction: 'in', partyId: c.id, amount: 5500, method: 'UPI', reference: 'UPI123', attachments: [{ name: '../../etc/passwd.png', data: PNG }, { name: 'bill.pdf', data: PDF }] });
  assert.equal(p.attachments.length, 2);
  assert.equal(p.attachments[0].name, '.._.._etc_passwd.png'.replace(/^\.+/, ''));
  assert.equal(p.attachments[1].mime, 'application/pdf');
  const stored = await s.getAttachment(p.attachments[1].id);
  assert.equal(stored.kind, 'payment');
  const edited = await s.savePayment({ ...p, attachments: [{ id: p.attachments[1].id }] });
  assert.equal(edited.attachments.length, 1);
  assert.equal(await s.getAttachment(p.attachments[0].id), undefined, 'removed attachment is deleted');
  const out = await s.savePayment({ direction: 'out', partyId: (await s.saveParty({ type: 'supplier', name: 'Afjal 2' })).id, amount: 12200, method: 'Cheque', reference: '000123', chequeBank: 'SBI' });
  assert.equal(out.chequeBank, 'SBI');
});

test('product images are validated, shared once, and survive backup/restore', async () => {
  const s = await freshStore();
  const a = await s.saveProduct({ name: 'A' });
  const b = await s.saveProduct({ name: 'B' });
  await assert.rejects(() => s.setProductImage(a.id, { data: FAKE_PNG, thumb: PNG }), /valid JPEG/);
  await s.setProductImage(a.id, { data: PNG, thumb: PNG, sha256: 'h1' });
  await s.setProductImage(b.id, { data: PNG, thumb: PNG, sha256: 'h1' });
  assert.equal(s.products.get(a.id).imageId, s.products.get(b.id).imageId, 'identical image stored once');
  await s.removeProductImage(a.id);
  assert.ok(await s.getAttachment(s.products.get(b.id).imageId), 'shared image kept while still used');
  const backup = await createBackup(s);
  // Corrupt one extra attachment: restore must skip it, not fail.
  backup.data.attachments.push({ id: 'broken', data: FAKE_PNG });
  const p2 = backup.data.products.find((x) => x.name === 'A');
  p2.imageId = 'broken';
  const fresh = JSON.parse(JSON.stringify(backup));
  const { sha256OfString } = await import('../www/js/core/files.js');
  fresh.checksum = await sha256OfString(JSON.stringify(fresh.data));
  const v = await validateBackup(fresh);
  assert.ok(v.ok);
  assert.match(v.warnings.join(), /1 damaged/);
  const s2 = await freshStore();
  const res = await restoreBackup(s2, fresh);
  assert.equal(res.skippedAttachments, 1);
  assert.equal(s2.listProducts().find((x) => x.name === 'A').imageId, '');
  assert.ok(await s2.getAttachment(s2.listProducts().find((x) => x.name === 'B').imageId));
});

test('encrypted backups need the right password and detect tampering', async () => {
  const s = await freshStore();
  await s.saveParty({ type: 'customer', name: 'Secret Customer' });
  const backup = await createBackup(s);
  const env = await encryptBackup(backup, 'correct horse');
  assert.ok(isEncryptedBackup(env));
  assert.ok(!JSON.stringify(env).includes('Secret Customer'));
  assert.equal((await validateBackup(env)).encrypted, true);
  await assert.rejects(() => decryptBackup(env, 'wrong password'), /Wrong password/);
  const tampered = { ...env, payload: env.payload.slice(0, -8) + 'AAAAAAA=' };
  await assert.rejects(() => decryptBackup(tampered, 'correct horse'), /Wrong password|damaged/);
  const plain = await decryptBackup(env, 'correct horse');
  assert.ok((await validateBackup(plain)).ok);
});

test('migration v2 adds new fields without touching existing data', () => {
  const v1 = {
    products: [{ id: 'i', name: 'Old', trackStock: true }],
    payments: [{ id: 'p', amount: 100, allocations: [] }],
    settings: [{ key: 'app', ui: { dashboardCards: ['sales'] } }],
  };
  const out = migrateData(structuredClone(v1), 1);
  assert.equal(out.products[0].name, 'Old');
  assert.equal(out.products[0].lowStockAlert, true);
  assert.deepEqual(out.payments[0].attachments, []);
  assert.deepEqual(out.settings[0].ui.dashboardCards, ['sales', 'duetoday', 'overdue', 'paidtoday']);
  assert.equal(out.payments[0].amount, 100);
});

test('live database upgrade keeps existing records (v1 -> v2)', async () => {
  const factory = new IDBFactory();
  // Simulate a database created by the previous version.
  await new Promise((resolve, reject) => {
    const r = factory.open('bizbill-upg', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const n of ['meta', 'settings', 'products', 'documents', 'payments', 'expenses', 'stockMoves', 'audit', 'attachments', 'snapshots']) db.createObjectStore(n, { keyPath: n === 'meta' || n === 'settings' ? 'key' : 'id' });
      db.createObjectStore('parties', { keyPath: 'id' }).createIndex('type', 'type');
    };
    r.onsuccess = () => {
      const tx = r.result.transaction(['parties', 'meta'], 'readwrite');
      tx.objectStore('parties').put({ id: 'p1', type: 'customer', name: 'Existing Customer', openingBalance: 12345 });
      tx.objectStore('meta').put({ key: 'dataVersion', value: 1 });
      tx.oncomplete = () => { r.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
  const s = new BizStore(new Database('bizbill-upg', factory));
  await s.init();
  assert.equal(s.migrationError, undefined);
  assert.equal(s.parties.get('p1').name, 'Existing Customer');
  assert.equal(s.account('p1').balance, 12345);
  assert.equal(s.meta.get('dataVersion'), 2);
  const snaps = await s.db.getAll('snapshots');
  assert.ok(snaps.some((x) => x.reason === 'before-migration'), 'pre-migration copy kept');
});
