import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { jsPDF } from 'jspdf';
import { BizStore } from '../www/js/core/store.js';
import { Database } from '../www/js/core/db.js';
import { Layout, makeMeasurer, toPdf, pdfSafe } from '../www/js/docs/layout.js';
import { renderInvoice, renderReceipt, renderLedger, renderReport } from '../www/js/docs/templates.js';
import { ledgerStatement } from '../www/js/core/ledger.js';
import { runReport, REPORTS } from '../www/js/core/reports.js';

const measure = makeMeasurer(jsPDF);

async function setup() {
  const s = new BizStore(new Database('docs-' + Math.random(), new IDBFactory()));
  await s.init();
  const st = structuredClone(s.settings);
  Object.assign(st.company, { name: 'Sharma Electricals', stateCode: '27', gstin: '27AAPFU0939F1ZV', address: '12 MG Road', city: 'Pune', mobile: '9876500000', bankName: 'SBI', bankAccount: '1234567890', bankIfsc: 'SBIN0000001', upiId: 'sharma@upi' });
  await s.saveSettings(st);
  const c = await s.saveParty({ type: 'customer', name: 'Rahul Traders', stateCode: '29', gstin: '29AAGCB7383J1Z4', address: 'Bengaluru' });
  const items = [];
  for (let i = 0; i < 45; i++) items.push({ name: 'LED Bulb 9W model ' + i + ' with a fairly long description that wraps', hsn: '8539', qty: 2000 + i, rate: 12345 + i, gstBp: i % 2 ? 1200 : 1800, discType: 'pct', disc: 500 });
  const doc = await s.saveDocument({ kind: 'sale', partyId: c.id, items, packaging: 5000, transport: { name: 'VRL', vehicle: 'mh12ab1234', ewayBill: '123456789012', shippingAddress: 'Warehouse 4, Hosur Road' }, notes: 'Deliver before 5 PM' });
  return { s, doc, c };
}

test('invoice PDF paginates, repeats header and is a valid PDF', async () => {
  const { s, doc } = await setup();
  const L = renderInvoice(new Layout(measure), doc, s.settings, { paid: 0, due: doc.totals.grandTotal, status: 'unpaid' });
  assert.ok(L.pages >= 2, 'long invoice spans pages');
  const texts = L.ops.filter((o) => o.t === 'text').map((o) => o.s);
  assert.ok(texts.includes('TAX INVOICE'));
  assert.ok(texts.includes('IGST'), 'inter-state invoice shows IGST column');
  assert.ok(texts.some((t) => t.startsWith('Rupees ')));
  assert.equal(texts.filter((t) => t === 'HSN/SAC').length >= L.pages, true, 'table header repeated per page');
  // No op may fall below the printable area.
  for (const o of L.ops) if (o.t === 'text') assert.ok(o.y <= L.H, 'text inside page');
  const pdf = toPdf(L, jsPDF, { title: doc.number });
  const bytes = Buffer.from(pdf.output('arraybuffer'));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pdf.getNumberOfPages(), L.pages);
});

test('continuous layout (JPG) has a single tall page', async () => {
  const { s, doc } = await setup();
  const L = renderInvoice(new Layout(measure, { continuous: true }), doc, s.settings, {});
  assert.equal(L.pages, 1);
  assert.ok(L.H > 297);
});

test('receipt, ledger and every report render', async () => {
  const { s, doc, c } = await setup();
  const p = await s.savePayment({ direction: 'in', partyId: c.id, amount: 100000, method: 'UPI', reference: 'UTR1', allocations: [{ docId: doc.id, amount: 100000 }] });
  const R = renderReceipt(new Layout(measure), p, s.settings, [{ doc, amount: 100000 }]);
  assert.ok(R.ops.some((o) => o.s === 'PAYMENT RECEIPT'));
  const st = ledgerStatement(c, [...s.documents.values()], [...s.payments.values()]);
  const LG = renderLedger(new Layout(measure), c, st, s.settings, { from: '0000-01-01', to: '9999-12-31' });
  assert.ok(LG.ops.some((o) => o.s === 'Closing Balance'));
  for (const r of REPORTS) {
    const rep = runReport(s, r.id, { from: '2000-01-01', to: '2100-12-31' });
    const L = renderReport(new Layout(measure), r.title, 'All', rep, s.settings);
    assert.ok(L.ops.length > 10, r.id);
    toPdf(L, jsPDF);
  }
});

test('pdfSafe replaces unsupported glyphs', () => {
  assert.equal(pdfSafe('₹100 – ok'), 'Rs. 100 - ok');
  assert.equal(pdfSafe('नमस्ते'), '??????');
});
