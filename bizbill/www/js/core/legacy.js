// Import data left behind by an older BizBill build that stored its data in
// the WebView under the file:// origin (localStorage / IndexedDB).
//
// The Android app copies that data, untouched, into a private JSON file on
// first launch (see LegacyDataExporter.java). The exact shape of the old
// data is unknown, so this module RECOGNISES common structures and shows a
// preview; nothing is imported without the user's confirmation, and the raw
// file is never deleted (it can be exported at any time).
//
// Dump format: {exportedAt, localStorage: {key: string}, indexedDB: {db: {store: [records]}}}

import { parseDecimal, pctToBp } from './money.js';
import { parseFlexibleDate, today } from './dates.js';
import { normalizeGstin, gstinError } from './validate.js';

const lc = (s) => String(s || '').toLowerCase();

function pick(o, names) {
  for (const n of names) {
    for (const k of Object.keys(o)) if (lc(k) === n) return o[k];
  }
  return undefined;
}

function money(v) {
  if (v == null || v === '') return 0;
  const n = parseDecimal(typeof v === 'number' ? v : String(v), 2);
  return Number.isNaN(n) ? 0 : n;
}

function qty(v) {
  const n = parseDecimal(typeof v === 'number' ? v : String(v ?? ''), 3);
  return Number.isNaN(n) ? 0 : n;
}

/** Collect every array of plain objects found in the dump, with a source label. */
export function collectArrays(dump) {
  const out = [];
  const visit = (label, value, depth = 0) => {
    if (depth > 3 || value == null) return;
    if (Array.isArray(value)) {
      if (value.length && value.every((x) => x && typeof x === 'object' && !Array.isArray(x))) out.push({ label, records: value });
      return;
    }
    if (typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(label + '.' + k, v, depth + 1);
  };
  for (const [k, v] of Object.entries((dump && dump.localStorage) || {})) {
    let parsed;
    try { parsed = JSON.parse(v); } catch { continue; }
    visit('localStorage.' + k, parsed);
  }
  for (const [db, stores] of Object.entries((dump && dump.indexedDB) || {})) {
    for (const [store, records] of Object.entries(stores || {})) visit(`indexedDB.${db}.${store}`, records);
  }
  return out;
}

function classify({ label, records }) {
  const l = lc(label);
  const keys = new Set(records.slice(0, 20).flatMap((r) => Object.keys(r).map(lc)));
  const has = (...k) => k.some((x) => keys.has(x));
  if ((/invoice|bill|sale/.test(l) || has('invoiceno', 'invoicenumber', 'billno')) && (has('items', 'products', 'lines') || has('total', 'grandtotal', 'amount'))) return 'invoice';
  if (/supplier|vendor/.test(l)) return 'supplier';
  if (/customer|part(y|ies)|client/.test(l) && has('name', 'customername', 'partyname')) return 'customer';
  if ((/product|item|stock|inventory/.test(l) || has('hsn', 'saleprice', 'mrp', 'sku')) && has('name', 'productname', 'itemname', 'title')) return 'product';
  return null;
}

function mapParty(r, type) {
  const name = String(pick(r, ['name', 'customername', 'partyname', 'suppliername', 'title']) || '').trim();
  if (!name) return null;
  const gstin = normalizeGstin(pick(r, ['gstin', 'gst', 'gstno', 'gstnumber']));
  return {
    type, name,
    mobile: String(pick(r, ['mobile', 'phone', 'mobileno', 'contact', 'phoneno']) || '').trim(),
    email: String(pick(r, ['email']) || '').trim(),
    gstin: gstin && !gstinError(gstin) ? gstin : '',
    address: String(pick(r, ['address', 'addr']) || '').trim(),
    city: String(pick(r, ['city']) || '').trim(),
    stateCode: gstin && !gstinError(gstin) ? gstin.slice(0, 2) : String(pick(r, ['statecode']) || '').padStart(2, '0').replace(/^00$/, ''),
    openingBalance: money(pick(r, ['balance', 'openingbalance', 'outstanding', 'due'])),
    notes: 'Imported from previous BizBill version',
  };
}

function mapProduct(r) {
  const name = String(pick(r, ['name', 'productname', 'itemname', 'title']) || '').trim();
  if (!name) return null;
  const gst = pick(r, ['gst', 'gstrate', 'tax', 'taxrate', 'gstpercent']);
  const gstNum = parseFloat(gst);
  return {
    name,
    sku: String(pick(r, ['sku', 'code', 'productcode', 'itemcode']) || '').trim(),
    hsn: /^\d{2,8}$/.test(String(pick(r, ['hsn', 'hsncode', 'sac']) || '')) ? String(pick(r, ['hsn', 'hsncode', 'sac'])) : '',
    unit: String(pick(r, ['unit', 'uom']) || 'PCS').toUpperCase().slice(0, 8),
    salePrice: money(pick(r, ['saleprice', 'price', 'rate', 'sellingprice', 'mrp'])),
    purchasePrice: money(pick(r, ['purchaseprice', 'cost', 'costprice', 'buyprice'])),
    mrp: money(pick(r, ['mrp'])),
    gstBp: Number.isFinite(gstNum) && gstNum >= 0 && gstNum <= 100 ? pctToBp(gstNum) : 0,
    // Current stock of the old app becomes the opening stock here.
    openingStock: Math.max(0, qty(pick(r, ['stock', 'qty', 'quantity', 'currentstock', 'openingstock']))),
    minStock: Math.max(0, qty(pick(r, ['minstock', 'minimumstock', 'reorderlevel']))),
  };
}

function mapInvoice(r) {
  const number = String(pick(r, ['invoiceno', 'invoicenumber', 'number', 'billno', 'no', 'id']) || '').trim();
  const lines = pick(r, ['items', 'products', 'lines']);
  const items = Array.isArray(lines) ? lines.map((it) => {
    const name = String(pick(it, ['name', 'productname', 'itemname', 'description', 'title']) || '').trim();
    const q = qty(pick(it, ['qty', 'quantity']) ?? 1);
    const rate = money(pick(it, ['rate', 'price', 'saleprice', 'unitprice']));
    const gst = parseFloat(pick(it, ['gst', 'gstrate', 'tax', 'taxrate']));
    return name && q > 0 ? { name, qty: q, rate, gstBp: Number.isFinite(gst) ? pctToBp(gst) : 0, hsn: String(pick(it, ['hsn']) || '').replace(/\D/g, '').slice(0, 8), unit: 'PCS' } : null;
  }).filter(Boolean) : [];
  const total = money(pick(r, ['grandtotal', 'total', 'amount', 'nettotal']));
  if (!number || (!items.length && !total)) return null;
  const paidRaw = pick(r, ['paid', 'paidamount', 'received', 'amountpaid']);
  const status = lc(pick(r, ['status', 'paymentstatus']));
  const paid = paidRaw != null ? money(paidRaw) : status === 'paid' ? total : 0;
  return {
    number,
    date: parseFlexibleDate(pick(r, ['date', 'invoicedate', 'billdate', 'createdat'])?.toString().slice(0, 10)) || today(),
    customer: String(pick(r, ['customername', 'customer', 'partyname', 'party', 'name']) || '').trim() || 'Walk-in Customer',
    mobile: String(pick(r, ['mobile', 'phone', 'customermobile']) || '').trim(),
    items: items.length ? items : [{ name: 'Imported invoice total', qty: 1000, rate: total, gstBp: 0, unit: 'NOS' }],
    total, paid: Math.min(paid, total || paid),
    gstIncludedInRate: !items.length,
  };
}

/** Analyse a dump. Returns {customers, suppliers, products, invoices, sources} (mapped, de-duplicated). */
export function analyseLegacy(dump) {
  const result = { customers: [], suppliers: [], products: [], invoices: [], sources: [] };
  const seen = { customer: new Set(), supplier: new Set(), product: new Set(), invoice: new Set() };
  for (const arr of collectArrays(dump)) {
    const kind = classify(arr);
    if (!kind) continue;
    result.sources.push({ label: arr.label, kind, count: arr.records.length });
    for (const r of arr.records) {
      if (kind === 'customer' || kind === 'supplier') {
        const p = mapParty(r, kind);
        const key = p && lc(p.name) + '|' + p.mobile;
        if (p && !seen[kind].has(key)) { seen[kind].add(key); result[kind === 'customer' ? 'customers' : 'suppliers'].push(p); }
      } else if (kind === 'product') {
        const p = mapProduct(r);
        if (p && !seen.product.has(lc(p.name))) { seen.product.add(lc(p.name)); result.products.push(p); }
      } else {
        const inv = mapInvoice(r);
        if (inv && !seen.invoice.has(lc(inv.number))) { seen.invoice.add(lc(inv.number)); result.invoices.push(inv); }
      }
    }
  }
  return result;
}

/**
 * Import the chosen categories. Existing records with the same name are
 * skipped (never overwritten). Returns counts and per-record problems.
 */
export async function importLegacy(store, analysis, { customers = true, suppliers = true, products = true, invoices = false } = {}) {
  const res = { customers: 0, suppliers: 0, products: 0, invoices: 0, skipped: 0, problems: [] };
  const byName = (type) => new Map(store.listParties(type, { includeDeleted: true }).map((p) => [lc(p.name), p]));
  const tryDo = async (label, fn) => {
    try { await fn(); return true; } catch (e) { res.problems.push(`${label}: ${e.messages ? e.messages.join('; ') : e.message}`); return false; }
  };
  for (const [flag, list, type] of [[customers, analysis.customers, 'customer'], [suppliers, analysis.suppliers, 'supplier']]) {
    if (!flag) continue;
    const existing = byName(type);
    for (const p of list) {
      if (existing.has(lc(p.name))) { res.skipped++; continue; }
      if (await tryDo(p.name, () => store.saveParty(p))) res[type === 'customer' ? 'customers' : 'suppliers']++;
    }
  }
  if (products) {
    const existing = new Set(store.listProducts({ includeDeleted: true }).map((p) => lc(p.name)));
    const skus = new Set(store.listProducts({ includeDeleted: true }).map((p) => lc(p.sku)).filter(Boolean));
    for (const p of analysis.products) {
      if (existing.has(lc(p.name))) { res.skipped++; continue; }
      const rec = { ...p, sku: p.sku && !skus.has(lc(p.sku)) ? p.sku : '' };
      if (await tryDo(p.name, () => store.saveProduct(rec))) { res.products++; if (rec.sku) skus.add(lc(rec.sku)); }
    }
  }
  if (invoices) {
    const numbers = new Set(store.listDocuments('sale', { includeDeleted: true }).map((d) => lc(d.number)));
    for (const inv of analysis.invoices) {
      let number = inv.number;
      if (numbers.has(lc(number))) number = 'OLD-' + number;
      if (numbers.has(lc(number))) { res.skipped++; continue; }
      let party = byName('customer').get(lc(inv.customer));
      const ok = await tryDo('Invoice ' + inv.number, async () => {
        if (!party) party = await store.saveParty({ type: 'customer', name: inv.customer, mobile: inv.mobile, notes: 'Imported from previous BizBill version' });
        const doc = await store.saveDocument({
          kind: 'sale', number, date: inv.date, partyId: party.id, items: inv.items,
          inclusive: inv.gstIncludedInRate, roundOff: true, notes: 'Imported from previous BizBill version', terms: '',
        });
        const paid = Math.min(inv.paid || 0, doc.totals.grandTotal);
        if (paid > 0) {
          await store.savePayment({ direction: 'in', partyId: party.id, date: inv.date, amount: paid, method: 'Other', notes: 'Imported from previous BizBill version', allocations: [{ docId: doc.id, amount: paid }] });
        }
      });
      if (ok) { res.invoices++; numbers.add(lc(number)); }
    }
  }
  await store.logEvent('legacy.import', `Imported from previous version: ${res.customers} customers, ${res.suppliers} suppliers, ${res.products} products, ${res.invoices} invoices`);
  return res;
}
