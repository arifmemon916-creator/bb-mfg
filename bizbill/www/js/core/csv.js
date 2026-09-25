// CSV export and validated CSV import for customers, suppliers and products.
// Import never writes silently: parseImport() returns every row with its
// errors so the UI can show a preview and ask for confirmation.

import { parseDecimal, paiseToInput, qtyToInput, bpToPct, pctToBp } from './money.js';
import { gstinError, normalizeGstin, mobileError, hsnError, emailError } from './validate.js';
import { stateName, stateCodeFromName } from './states.js';

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  text = String(text || '').replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

function esc(v) {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export function toCSV(headers, rows) {
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ schemas

export const IMPORT_SCHEMAS = {
  customer: {
    label: 'Customers',
    fields: [
      ['name', 'Name', true], ['mobile', 'Mobile'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['gstin', 'GSTIN'],
      ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['stateCode', 'State Code'], ['pincode', 'Pincode'],
      ['openingBalance', 'Opening Balance'], ['creditLimit', 'Credit Limit'], ['notes', 'Notes'],
    ],
  },
  supplier: {
    label: 'Suppliers',
    fields: [
      ['name', 'Name', true], ['mobile', 'Mobile'], ['email', 'Email'], ['gstin', 'GSTIN'], ['address', 'Address'],
      ['city', 'City'], ['state', 'State'], ['stateCode', 'State Code'], ['openingBalance', 'Opening Balance'], ['notes', 'Notes'],
    ],
  },
  product: {
    label: 'Products',
    fields: [
      ['name', 'Product Name', true], ['code', 'Product Code'], ['sku', 'SKU'], ['barcode', 'Barcode'], ['hsn', 'HSN/SAC'],
      ['category', 'Category'], ['brand', 'Brand'], ['unit', 'Unit'], ['purchasePrice', 'Purchase Price'],
      ['salePrice', 'Sale Price'], ['mrp', 'MRP'], ['gst', 'GST %'], ['openingStock', 'Opening Stock'],
      ['minStock', 'Minimum Stock'], ['description', 'Description'],
    ],
  },
};

export function exportParties(store, type) {
  const schema = IMPORT_SCHEMAS[type];
  const rows = store.listParties(type).map((p) => schema.fields.map(([k]) => {
    if (k === 'openingBalance' || k === 'creditLimit') return paiseToInput(p[k] || 0);
    if (k === 'state') return p.state || stateName(p.stateCode);
    return p[k] || '';
  }));
  return toCSV(schema.fields.map((f) => f[1]), rows);
}

export function exportProducts(store) {
  const schema = IMPORT_SCHEMAS.product;
  const rows = store.listProducts().map((p) => schema.fields.map(([k]) => {
    if (['purchasePrice', 'salePrice', 'mrp'].includes(k)) return paiseToInput(p[k] || 0);
    if (k === 'gst') return bpToPct(p.gstBp || 0);
    if (k === 'openingStock' || k === 'minStock') return qtyToInput(p[k] || 0);
    return p[k] || '';
  }));
  return toCSV(schema.fields.map((f) => f[1]), rows);
}

export function importTemplate(type) {
  return toCSV(IMPORT_SCHEMAS[type].fields.map((f) => f[1]), []);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map header cells to schema keys (accepts label or key, case/space-insensitive). */
function mapHeaders(headerRow, schema) {
  const lookup = new Map();
  for (const [key, label] of schema.fields) { lookup.set(norm(key), key); lookup.set(norm(label), key); }
  lookup.set('hsn', 'hsn'); lookup.set('sac', 'hsn'); lookup.set('gstrate', 'gst'); lookup.set('phone', 'mobile');
  lookup.set('productname', 'name'); lookup.set('customername', 'name'); lookup.set('suppliername', 'name');
  return headerRow.map((h) => lookup.get(norm(h)) || null);
}

/**
 * Parse and validate an import file.
 * Returns {rows:[{line, values, record, errors:[]}], validCount, errorCount, headerErrors:[]}
 */
export function parseImport(store, type, text) {
  const schema = IMPORT_SCHEMAS[type];
  const table = parseCSV(text);
  const result = { rows: [], validCount: 0, errorCount: 0, headerErrors: [] };
  if (!table.length) { result.headerErrors.push('The file is empty'); return result; }
  const keys = mapHeaders(table[0], schema);
  for (const [key, label, required] of schema.fields) {
    if (required && !keys.includes(key)) result.headerErrors.push(`Required column "${label}" is missing`);
  }
  if (result.headerErrors.length) return result;

  const seen = new Map();
  const existingParties = type === 'product' ? [] : store.listParties(type);
  const existingProducts = type === 'product' ? store.listProducts() : [];

  table.slice(1).forEach((cells, idx) => {
    const v = {};
    keys.forEach((k, i) => { if (k) v[k] = String(cells[i] ?? '').trim(); });
    const errors = [];
    const money = (k, label, allowNeg = false) => {
      if (!v[k]) return 0;
      const n = parseDecimal(v[k], 2);
      if (Number.isNaN(n)) { errors.push(`${label} "${v[k]}" is not a number`); return 0; }
      if (!allowNeg && n < 0) errors.push(`${label} cannot be negative`);
      return n;
    };
    const qty = (k, label) => {
      if (!v[k]) return 0;
      const n = parseDecimal(v[k], 3);
      if (Number.isNaN(n)) { errors.push(`${label} "${v[k]}" is not a valid quantity`); return 0; }
      if (n < 0) errors.push(`${label} cannot be negative`);
      return n;
    };
    let record;
    if (!v.name) errors.push('Name is required');
    if (type === 'product') {
      const gstStr = (v.gst || '').replace('%', '');
      let gstBp = pctToBp(store.settings.billing.defaultGst);
      if (gstStr) {
        const n = parseDecimal(gstStr, 2);
        if (Number.isNaN(n) || n < 0 || n > 10000) errors.push(`GST % "${v.gst}" is invalid`);
        else gstBp = n;
      }
      const h = hsnError(v.hsn); if (h) errors.push(h);
      record = {
        name: v.name, code: v.code || '', sku: v.sku || '', barcode: v.barcode || '', hsn: v.hsn || '',
        category: v.category || '', brand: v.brand || '', unit: (v.unit || store.settings.billing.defaultUnit).toUpperCase(),
        purchasePrice: money('purchasePrice', 'Purchase price'), salePrice: money('salePrice', 'Sale price'), mrp: money('mrp', 'MRP'),
        gstBp, openingStock: qty('openingStock', 'Opening stock'), minStock: qty('minStock', 'Minimum stock'), description: v.description || '',
      };
      const nameKey = 'n:' + norm(record.name);
      if (record.name && (existingProducts.some((p) => norm(p.name) === norm(record.name)) || seen.has(nameKey))) errors.push('Duplicate product name');
      for (const f of ['code', 'sku', 'barcode']) {
        if (!record[f]) continue;
        const k = f + ':' + record[f].toLowerCase();
        if (existingProducts.some((p) => p[f] && p[f].toLowerCase() === record[f].toLowerCase()) || seen.has(k)) errors.push(`Duplicate ${f.toUpperCase()} ${record[f]}`);
        seen.set(k, true);
      }
      seen.set(nameKey, true);
    } else {
      const g = gstinError(v.gstin); if (g) errors.push(g);
      const m = mobileError(v.mobile); if (m) errors.push(m);
      const e = emailError(v.email); if (e) errors.push(e);
      let stateCode = (v.stateCode || '').padStart(v.stateCode ? 2 : 0, '0');
      if (!stateCode && v.state) stateCode = stateCodeFromName(v.state);
      if (!stateCode && v.gstin) stateCode = normalizeGstin(v.gstin).slice(0, 2);
      record = {
        type, name: v.name, mobile: v.mobile || '', whatsapp: v.whatsapp || '', email: v.email || '', gstin: normalizeGstin(v.gstin),
        address: v.address || '', city: v.city || '', state: v.state || stateName(stateCode), stateCode, pincode: v.pincode || '',
        openingBalance: money('openingBalance', 'Opening balance', true), creditLimit: money('creditLimit', 'Credit limit'), notes: v.notes || '',
      };
      const key = norm(record.name) + '|' + (record.mobile || '');
      if (record.name && (existingParties.some((p) => norm(p.name) === norm(record.name) && (p.mobile || '') === record.mobile) || seen.has(key))) {
        errors.push('Duplicate record (same name and mobile)');
      }
      if (record.gstin) {
        const gk = 'g:' + record.gstin;
        if (existingParties.some((p) => p.gstin === record.gstin) || seen.has(gk)) errors.push('Duplicate GSTIN ' + record.gstin);
        seen.set(gk, true);
      }
      seen.set(key, true);
    }
    const row = { line: idx + 2, values: v, record, errors };
    result.rows.push(row);
    if (errors.length) result.errorCount++; else result.validCount++;
  });
  return result;
}

/** Import validated rows in ONE atomic transaction. */
export async function commitImport(store, type, parsed) {
  const { newId } = await import('./db.js');
  const { nowStamp } = await import('./dates.js');
  const ops = [];
  let n = 0;
  for (const row of parsed.rows) {
    if (row.errors.length) continue;
    const base = { ...row.record, id: newId(type === 'product' ? 'i' : 'p'), createdAt: nowStamp(), updatedAt: nowStamp(), deleted: false };
    if (type === 'product') base.trackStock = true;
    ops.push({ store: type === 'product' ? 'products' : 'parties', op: 'put', value: base });
    n++;
  }
  if (!n) return 0;
  ops.push(store.auditOp('import.' + type, 'app', '', `Imported ${n} ${IMPORT_SCHEMAS[type].label.toLowerCase()} from CSV`));
  await store.commit(ops);
  return n;
}
