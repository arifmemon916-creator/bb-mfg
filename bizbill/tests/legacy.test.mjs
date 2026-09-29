import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { BizStore } from '../www/js/core/store.js';
import { Database } from '../www/js/core/db.js';
import { analyseLegacy, importLegacy } from '../www/js/core/legacy.js';
import { validateUpdateMeta } from '../www/js/services/update.js';

const dump = {
  exportedAt: '2026-09-25T10:00:00Z',
  localStorage: {
    customers: JSON.stringify([{ name: 'ABC Traders', phone: '9876543210', gstin: '27AAPFU0939F1ZV', balance: '1500.50' }, { name: 'ABC Traders', phone: '9876543210' }]),
    products: JSON.stringify([{ productName: 'Coca Cola 250ml', price: 20, stock: 48, gst: 28, hsn: '2202' }]),
    invoices: JSON.stringify([{ invoiceNo: 'INV-7', date: '12/09/2026', customerName: 'ABC Traders', items: [{ name: 'Coca Cola 250ml', qty: 10, rate: 20, gst: 28 }], total: 256, paid: 100 }]),
    theme: 'dark',
    broken: '{not json',
  },
  indexedDB: { oldbizbill: { suppliers: [{ name: 'Metro Wholesale', mobile: '9000000000' }] } },
};

test('legacy data is recognised, previewed and imported without overwriting', async () => {
  const a = analyseLegacy(dump);
  assert.equal(a.customers.length, 1, 'duplicates collapsed');
  assert.equal(a.customers[0].openingBalance, 150050);
  assert.equal(a.suppliers.length, 1);
  assert.equal(a.products[0].openingStock, 48000);
  assert.equal(a.products[0].gstBp, 2800);
  assert.equal(a.invoices[0].date, '2026-09-12');
  const s = new BizStore(new Database('legacy', new IDBFactory()));
  await s.init();
  await s.saveParty({ type: 'supplier', name: 'Metro Wholesale', mobile: '1111111111' });
  const r = await importLegacy(s, a, { invoices: true });
  assert.equal(r.customers, 1);
  assert.equal(r.suppliers, 0, 'existing supplier not overwritten');
  assert.equal(r.skipped, 1);
  assert.equal(r.products, 1);
  assert.equal(r.invoices, 1);
  const inv = s.listDocuments('sale')[0];
  assert.equal(inv.number, 'INV-7');
  assert.equal(s.docDue(inv), inv.totals.grandTotal - 10000);
  assert.equal(s.listParties('supplier')[0].mobile, '1111111111');
});

test('update.json validation rejects anything untrusted', () => {
  const good = { packageName: 'tech.bbmfg.bizbill', latestVersionName: '3.6', latestVersionCode: 14, downloadUrl: 'https://github.com/arifmemon916-creator/bb-mfg/releases/download/v3.6/BizBill-release.apk', sha256: 'a'.repeat(64), mandatoryUpdate: false, minimumSupportedVersion: '3.0' };
  const ctx = { packageName: 'tech.bbmfg.bizbill', versionCode: 13, versionName: '3.5' };
  const ok = validateUpdateMeta(good, ctx);
  assert.ok(ok.ok && ok.info.available && !ok.info.mandatory);
  assert.equal(validateUpdateMeta({ ...good, latestVersionCode: 13 }, ctx).info.available, false, 'same versionCode is not an update');
  assert.equal(validateUpdateMeta({ ...good, latestVersionCode: 12 }, ctx).info.available, false, 'lower versionCode is not an update');
  assert.match(validateUpdateMeta({ ...good, packageName: 'com.evil.app' }, ctx).error, /package/);
  assert.match(validateUpdateMeta({ ...good, downloadUrl: 'http://github.com/x.apk' }, ctx).error, /trusted/);
  assert.match(validateUpdateMeta({ ...good, downloadUrl: 'https://evil.example/x.apk' }, ctx).error, /trusted/);
  assert.match(validateUpdateMeta({ ...good, downloadUrl: 'https://github.com@evil.example/x.apk' }, ctx).error, /trusted/);
  assert.match(validateUpdateMeta({ ...good, sha256: 'xyz' }, ctx).error, /checksum/);
  assert.equal(validateUpdateMeta({ ...good, mandatoryUpdate: true }, ctx).info.mandatory, true);
  assert.equal(validateUpdateMeta({ ...good, minimumSupportedVersion: '3.6' }, ctx).info.mandatory, true, 'below minimum supported = mandatory');
  assert.equal(validateUpdateMeta(null, ctx).ok, false);
});
