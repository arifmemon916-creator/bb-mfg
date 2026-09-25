import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { BizStore, ValidationError } from '../www/js/core/store.js';
import { Database } from '../www/js/core/db.js';
import { ledgerStatement } from '../www/js/core/ledger.js';
import { profitAndLoss, gstSummary, dashboardMetrics, runReport, stockMovementSummary, productMovements } from '../www/js/core/reports.js';
import { createBackup, validateBackup, restoreBackup, listSnapshots } from '../www/js/core/backup.js';
import { parseImport, commitImport, exportProducts, parseCSV } from '../www/js/core/csv.js';
import { hashPin, verifyPin, pinError } from '../www/js/core/security.js';
import { globalSearch } from '../www/js/core/search.js';
import { migrateData } from '../www/js/core/migrate.js';

let n = 0;
async function freshStore() {
  const db = new Database('test-' + (++n), new IDBFactory());
  const s = new BizStore(db);
  await s.init();
  const settings = structuredClone(s.settings);
  settings.company.name = 'Test Traders';
  settings.company.stateCode = '27';
  settings.company.gstin = '27AAPFU0939F1ZV';
  await s.saveSettings(settings);
  return s;
}

async function seed(s) {
  const cust = await s.saveParty({ type: 'customer', name: 'Asha Stores', mobile: '9876543210', stateCode: '27', openingBalance: 50000 });
  const other = await s.saveParty({ type: 'customer', name: 'Karnataka Retail', stateCode: '29', gstin: '29AAGCB7383J1Z4' });
  const sup = await s.saveParty({ type: 'supplier', name: 'Metro Wholesale', stateCode: '27' });
  const pen = await s.saveProduct({ name: 'Pen', sku: 'PEN-1', hsn: '9608', unit: 'PCS', purchasePrice: 600, salePrice: 1000, gstBp: 1800, openingStock: 100000, minStock: 20000 });
  const book = await s.saveProduct({ name: 'Notebook', sku: 'NB-1', hsn: '4820', unit: 'PCS', purchasePrice: 3000, salePrice: 5000, gstBp: 1200, openingStock: 10000, minStock: 5000 });
  return { cust, other, sup, pen, book };
}

test('invoice updates stock, numbering, dues and ledger', async () => {
  const s = await freshStore();
  const { cust, pen, book } = await seed(s);
  assert.equal(s.peekNumber('sale'), 'INV-0001');
  const inv = await s.saveDocument({
    kind: 'sale', date: '2026-09-01', partyId: cust.id,
    items: [
      { productId: pen.id, name: 'Pen', qty: 10000, rate: 1000, gstBp: 1800, discType: 'pct', disc: 0 },
      { productId: book.id, name: 'Notebook', qty: 2000, rate: 5000, gstBp: 1200, discType: 'pct', disc: 1000 },
    ],
  }, { payment: { amount: 10000, method: 'UPI' } });
  // Pen: 100.00 + 18.00 ; Notebook: 100 - 10 = 90 + 10.80 => 218.80 -> round 219.00
  assert.equal(inv.number, 'INV-0001');
  assert.equal(inv.totals.taxable, 19000);
  assert.equal(inv.totals.cgst, 900 + 540);
  assert.equal(inv.totals.grandTotal, 21900);
  assert.equal(inv.totals.roundOff, 20);
  assert.equal(s.peekNumber('sale'), 'INV-0002');
  assert.equal(s.stockOf(pen.id).current, 90000);
  assert.equal(s.stockOf(book.id).current, 8000);
  assert.equal(s.docDue(inv), 11900);
  assert.equal(s.docStatus(inv), 'partial');
  // Customer balance = opening 500 + 219 - 100 received
  assert.equal(s.account(cust.id).balance, 50000 + 21900 - 10000);

  // Manual payment of 600 without allocation: FIFO clears opening (500) then 100 of invoice.
  await s.savePayment({ direction: 'in', partyId: cust.id, date: '2026-09-05', amount: 60000, method: 'Cash' });
  assert.equal(s.docDue(inv), 1900);
  const led = ledgerStatement(s.parties.get(cust.id), [...s.documents.values()], [...s.payments.values()]);
  assert.equal(led.rows[0].description, 'Opening balance');
  assert.equal(led.totalDebit, 50000 + 21900);
  assert.equal(led.totalCredit, 70000);
  assert.equal(led.closing, 1900);
  assert.equal(led.rows.at(-1).balance, 1900);

  // Ranged ledger carries prior balance as opening.
  const ranged = ledgerStatement(s.parties.get(cust.id), [...s.documents.values()], [...s.payments.values()], { from: '2026-09-02', to: '2026-12-31' });
  assert.equal(ranged.opening, 50000 + 21900 - 10000);
  assert.equal(ranged.closing, 1900);

  // Cancel the invoice: stock comes back, payments become advance.
  await assert.rejects(() => s.cancelDocument(inv.id, ''), ValidationError);
  await s.cancelDocument(inv.id, 'Wrong customer');
  assert.equal(s.stockOf(pen.id).current, 100000);
  assert.equal(s.docStatus(s.documents.get(inv.id)), 'cancelled');
  assert.equal(s.account(cust.id).balance, 50000 - 70000);
  await assert.rejects(() => s.saveDocument({ ...s.documents.get(inv.id) }), /cancelled/);
});

test('inter-state invoice uses IGST from place of supply', async () => {
  const s = await freshStore();
  const { other, pen } = await seed(s);
  const inv = await s.saveDocument({ kind: 'sale', date: '2026-09-02', partyId: other.id, items: [{ productId: pen.id, name: 'Pen', qty: 1000, rate: 10000, gstBp: 1800 }] });
  assert.equal(inv.interState, true);
  assert.equal(inv.totals.igst, 1800);
  assert.equal(inv.totals.cgst, 0);
});

test('purchase increases stock and updates purchase price', async () => {
  const s = await freshStore();
  const { sup, pen } = await seed(s);
  const pur = await s.saveDocument({
    kind: 'purchase', date: '2026-09-03', partyId: sup.id, refNo: 'MW-778',
    items: [{ productId: pen.id, name: 'Pen', qty: 50000, rate: 700, gstBp: 1800, discType: 'pct', disc: 1000 }],
  }, { payment: { amount: 20000, method: 'Bank' } });
  assert.equal(s.stockOf(pen.id).current, 150000);
  assert.equal(s.products.get(pen.id).purchasePrice, 630); // 7.00 less 10%
  assert.equal(pur.totals.grandTotal, 37200); // 315 + 56.70 = 371.70 -> 372 with round off
  assert.equal(s.account(sup.id).balance, pur.totals.grandTotal - 20000);
  const led = ledgerStatement(s.parties.get(sup.id), [...s.documents.values()], [...s.payments.values()]);
  assert.equal(led.totalCredit, pur.totals.grandTotal);
  assert.equal(led.totalDebit, 20000);
});

test('walk-in credit sale is refused; walk-in cash sale is allowed', async () => {
  const s = await freshStore();
  const { pen } = await seed(s);
  const draft = { kind: 'sale', date: '2026-09-04', party: { name: 'Cash Customer' }, items: [{ productId: pen.id, name: 'Pen', qty: 1000, rate: 10000, gstBp: 0 }] };
  await assert.rejects(() => s.saveDocument(draft), /Walk-in/);
  const ok = await s.saveDocument(draft, { payment: { amount: 10000, method: 'Cash' } });
  assert.equal(ok.party.name, 'Cash Customer');
});

test('negative stock can be blocked by settings', async () => {
  const s = await freshStore();
  const { cust, book } = await seed(s);
  const st = structuredClone(s.settings);
  st.billing.allowNegativeStock = false;
  await s.saveSettings(st);
  await assert.rejects(() => s.saveDocument({ kind: 'sale', partyId: cust.id, items: [{ productId: book.id, name: 'Notebook', qty: 11000, rate: 5000, gstBp: 1200 }] }), /Insufficient stock/);
});

test('validation catches bad input and duplicates', async () => {
  const s = await freshStore();
  const { cust } = await seed(s);
  await assert.rejects(() => s.saveParty({ type: 'customer', name: 'X', gstin: '27AAPFU0939F1ZA' }), /checksum/);
  await assert.rejects(() => s.saveProduct({ name: 'Pen' }), /already exists/);
  await assert.rejects(() => s.saveProduct({ name: 'New', sku: 'PEN-1' }), /already used/);
  await assert.rejects(() => s.saveDocument({ kind: 'sale', partyId: cust.id, items: [{ name: 'X', qty: 0, rate: 100 }] }), /quantity/);
  await s.saveDocument({ kind: 'sale', number: 'INV-0009', partyId: cust.id, items: [{ name: 'Service', qty: 1000, rate: 100 }] });
  await assert.rejects(() => s.saveDocument({ kind: 'sale', number: 'inv-0009', partyId: cust.id, items: [{ name: 'Service', qty: 1000, rate: 100 }] }), /already exists/);
  assert.equal(s.peekNumber('sale'), 'INV-0010');
});

test('stock adjustment requires reason and appears in history', async () => {
  const s = await freshStore();
  const { pen } = await seed(s);
  await assert.rejects(() => s.adjustStock(pen.id, -5000, ''), /reason/);
  await s.adjustStock(pen.id, -5000, 'Damaged', '2026-09-01');
  assert.equal(s.stockOf(pen.id).current, 95000);
  assert.equal(s.stockOf(pen.id).adjusted, -5000);
  const mv = productMovements(s, pen.id);
  assert.equal(mv[0].type, 'Adjustment');
  assert.equal(mv[0].balance, 95000);
  const sum = stockMovementSummary(s, { from: '2026-09-02', to: '2026-09-30' }).find((r) => r.id === pen.id);
  assert.equal(sum.opening, 95000);
  assert.equal(sum.closing, 95000);
});

test('quotation converts to invoice without re-entry', async () => {
  const s = await freshStore();
  const { cust, pen } = await seed(s);
  const q = await s.saveDocument({ kind: 'quotation', partyId: cust.id, items: [{ productId: pen.id, name: 'Pen', qty: 5000, rate: 1000, gstBp: 1800 }] });
  assert.equal(q.number, 'QT-0001');
  assert.equal(s.stockOf(pen.id).current, 100000, 'quotation does not move stock');
  assert.equal(s.account(cust.id).balance, 50000, 'quotation does not affect ledger');
  const draft = s.quotationToInvoiceDraft(q.id);
  const inv = await s.saveDocument(draft, { fromQuotationId: q.id });
  assert.equal(inv.items.length, 1);
  assert.equal(inv.totals.grandTotal, q.totals.grandTotal);
  assert.equal(s.documents.get(q.id).qStatus, 'converted');
  assert.equal(s.documents.get(q.id).convertedTo, inv.id);
  await s.cancelDocument(inv.id, 'test');
  assert.equal(s.documents.get(q.id).qStatus, 'accepted');
});

test('payment allocation is validated', async () => {
  const s = await freshStore();
  const { cust, pen } = await seed(s);
  const inv = await s.saveDocument({ kind: 'sale', partyId: cust.id, items: [{ productId: pen.id, name: 'Pen', qty: 1000, rate: 10000, gstBp: 0 }] });
  await assert.rejects(() => s.savePayment({ direction: 'in', partyId: cust.id, amount: 5000, allocations: [{ docId: inv.id, amount: 6000 }] }), /exceeds/);
  const auto = s.autoAllocate(cust.id, 'in', 20000);
  assert.deepEqual(auto, [{ docId: inv.id, amount: 10000 }]);
  const p = await s.savePayment({ direction: 'in', partyId: cust.id, amount: 20000, allocations: auto });
  assert.equal(p.number, 'RCT-0001');
  assert.equal(s.docStatus(inv), 'paid');
  // Remaining 100 settles opening balance (FIFO) -> balance 400.
  assert.equal(s.account(cust.id).balance, 50000 + 10000 - 20000);
  await s.cancelPayment(p.id, 'bounced');
  assert.equal(s.docStatus(inv), 'unpaid');
});

test('reports, P&L and GST summary are computed from transactions', async () => {
  const s = await freshStore();
  const { cust, sup, pen, book } = await seed(s);
  await s.saveDocument({ kind: 'purchase', date: '2026-09-01', partyId: sup.id, items: [{ productId: book.id, name: 'Notebook', qty: 10000, rate: 3000, gstBp: 1200 }] });
  await s.saveDocument({
    kind: 'sale', date: '2026-09-02', partyId: cust.id, roundOff: false,
    items: [{ productId: pen.id, name: 'Pen', qty: 10000, rate: 1000, gstBp: 1800, discType: 'amt', disc: 1000 }],
    packaging: 500,
  });
  await s.saveExpense({ date: '2026-09-02', category: 'Rent', amount: 2000, method: 'Cash' });
  const range = { from: '2026-09-01', to: '2026-09-30' };
  const pl = profitAndLoss(s, range);
  assert.equal(pl.grossSales, 10000);
  assert.equal(pl.discounts, 1000);
  assert.equal(pl.netSales, 9000);
  assert.equal(pl.cogs, 6000); // 10 pens x 6.00
  assert.equal(pl.grossProfit, 3000);
  assert.equal(pl.otherIncome, 500);
  assert.equal(pl.expenses, 2000);
  assert.equal(pl.netProfit, 1500);
  const g = gstSummary(s, range);
  assert.equal(g.outputTax, 1620);
  assert.equal(g.inputTax, 3600);
  assert.equal(g.netTax, -1980);
  const dash = dashboardMetrics(s, range);
  assert.equal(dash.sales, 9000 + 1620 + 500);
  assert.equal(dash.customers, 2);
  assert.equal(dash.lowStock, 0);
  const r = runReport(s, 'sales-product', range);
  assert.equal(r.rows[0].label, 'Pen');
  assert.equal(r.rows[0].profit, 3000);
  const aging = runReport(s, 'fin-receivables', range);
  assert.equal(aging.rows[0].balance, 50000 + 11120);
  const exp = runReport(s, 'fin-expenses', range);
  assert.equal(exp.totals.amount, 2000);
});

test('backup validates, detects tampering and restores atomically', async () => {
  const s = await freshStore();
  await seed(s);
  const st = structuredClone(s.settings);
  Object.assign(st.security, await hashPin('4826'), { enabled: true });
  await s.saveSettings(st);
  const b = await createBackup(s);
  assert.equal(b.counts.customers, 2);
  assert.equal(b.data.settings[0].security.pinHash, '', 'PIN hash is not exported');
  const v = await validateBackup(JSON.parse(JSON.stringify(b)));
  assert.ok(v.ok, v.errors.join());
  const tampered = JSON.parse(JSON.stringify(b));
  tampered.data.parties[0].name = 'Hacked';
  assert.equal((await validateBackup(tampered)).ok, false);
  assert.equal((await validateBackup({ hello: 1 })).ok, false);

  const s2 = await freshStore();
  await s2.saveParty({ type: 'customer', name: 'Will be replaced' });
  await restoreBackup(s2, JSON.parse(JSON.stringify(b)));
  assert.equal(s2.listParties('customer').length, 2);
  assert.equal(s2.listProducts().length, 2);
  assert.equal(s2.settings.company.name, 'Test Traders');
  assert.equal(s2.settings.security.enabled, false, 'device lock settings are kept');
  const snaps = await listSnapshots(s2);
  assert.equal(snaps[0].reason, 'before-restore');
  assert.equal(snaps[0].counts.customers, 1);
});

test('CSV import validates types, GSTIN and duplicates', async () => {
  const s = await freshStore();
  await seed(s);
  const csv = [
    'Product Name,SKU,HSN/SAC,Sale Price,GST %,Opening Stock',
    'Stapler,ST-1,8472,120.50,18,10',
    'Pen,PEN-X,9608,10,18,5',
    'Glue,PEN-1,3506,25,18,1',
    'Marker,MK-1,96,abc,18,2',
    'Tape,TP-1,3919,15,150,1',
    'Clip,CL-1,8305,5,18,-3',
    '"Folder, A4",FD-1,4820,30,12,4',
  ].join('\n');
  const parsed = parseImport(s, 'product', csv);
  assert.equal(parsed.validCount, 2);
  assert.equal(parsed.errorCount, 5);
  assert.match(parsed.rows[1].errors.join(), /Duplicate product name/);
  assert.match(parsed.rows[2].errors.join(), /Duplicate SKU/);
  assert.match(parsed.rows[3].errors.join(), /HSN|not a number/);
  assert.match(parsed.rows[4].errors.join(), /GST/);
  assert.match(parsed.rows[5].errors.join(), /negative/);
  const count = await commitImport(s, 'product', parsed);
  assert.equal(count, 2);
  const stapler = s.listProducts().find((p) => p.name === 'Stapler');
  assert.equal(stapler.salePrice, 12050);
  assert.equal(stapler.openingStock, 10000);
  assert.ok(s.listProducts().find((p) => p.name === 'Folder, A4'));
  const out = parseCSV(exportProducts(s));
  assert.equal(out.length, 1 + 4);

  const bad = parseImport(s, 'customer', 'Name,GSTIN,Mobile\nA,27AAPFU0939F1ZA,98765\nB,,12ab');
  assert.equal(bad.validCount, 0);
  const missing = parseImport(s, 'customer', 'Mobile\n123');
  assert.match(missing.headerErrors.join(), /Name/);
});

test('PIN hashing never stores the PIN', async () => {
  const h = await hashPin('7391');
  assert.ok(!JSON.stringify(h).includes('7391'));
  assert.equal(await verifyPin('7391', h), true);
  assert.equal(await verifyPin('7392', h), false);
  assert.ok(pinError('12'));
  assert.ok(pinError('1111'));
  assert.equal(pinError('2580'), '');
});

test('global search finds invoices, parties, products and payments', async () => {
  const s = await freshStore();
  const { cust, pen } = await seed(s);
  await s.saveDocument({ kind: 'sale', partyId: cust.id, items: [{ productId: pen.id, name: 'Pen', qty: 1000, rate: 1000, gstBp: 0 }] });
  await s.savePayment({ direction: 'in', partyId: cust.id, amount: 100, reference: 'UTR998877' });
  assert.equal(globalSearch(s, 'INV-0001')[0].type, 'sale');
  assert.ok(globalSearch(s, '9876543210').some((r) => r.type === 'customer'));
  assert.ok(globalSearch(s, 'PEN-1').some((r) => r.type === 'product'));
  assert.ok(globalSearch(s, 'utr998877').some((r) => r.type === 'payment'));
  assert.ok(globalSearch(s, '29AAGCB7383J1Z4').some((r) => r.type === 'customer'));
});

test('soft delete keeps records recoverable', async () => {
  const s = await freshStore();
  const { cust, pen } = await seed(s);
  await s.deleteParty(cust.id);
  assert.equal(s.listParties('customer').length, 1);
  assert.equal(s.listParties('customer', { includeDeleted: true }).length, 2);
  await s.restoreParty(cust.id);
  assert.equal(s.listParties('customer').length, 2);
  await s.deleteProduct(pen.id);
  assert.equal(s.listProducts().length, 1);
  await s.restoreProduct(pen.id);
  const audit = await s.listAudit();
  assert.ok(audit.some((a) => a.action === 'product.restore'));
});

test('data migration normalises old records', () => {
  const out = migrateData({ documents: [{ id: 'x' }], payments: [{ id: 'p' }], products: [{ id: 'i' }] }, 0);
  assert.deepEqual(out.documents[0].items, []);
  assert.equal(out.documents[0].status, 'active');
  assert.deepEqual(out.payments[0].allocations, []);
  assert.equal(out.products[0].trackStock, true);
});
