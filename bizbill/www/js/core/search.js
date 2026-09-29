// Global search across invoices, purchases, quotations, parties, products
// and payments. Works on the in-memory cache, so it is instant offline.

import { normalizeGstin, gstinError } from './validate.js';

const fold = (s) => String(s || '').toLowerCase();

/**
 * Look up an existing saved customer/supplier by GSTIN or exact name, so a
 * new-party form can offer to auto-fill from the app's own database (no
 * external GST lookup is performed). GSTIN match wins; falls back to an
 * exact, case-insensitive name match. Returns null when nothing matches.
 */
export function findPartyMatch(store, { gstin, name } = {}, excludeId) {
  const g = normalizeGstin(gstin || '');
  if (g && g.length === 15 && !gstinError(g)) {
    for (const p of store.parties.values()) {
      if (p.id === excludeId || p.deleted) continue;
      if (p.gstin && p.gstin === g) return p;
    }
  }
  const n = fold(name).trim();
  if (n.length >= 3) {
    for (const p of store.parties.values()) {
      if (p.id === excludeId || p.deleted) continue;
      if (fold(p.name) === n) return p;
    }
  }
  return null;
}

export function matches(q, ...fields) {
  if (!q) return true;
  const terms = fold(q).split(/\s+/).filter(Boolean);
  const hay = fields.map(fold).join(' ');
  return terms.every((t) => hay.includes(t));
}

export function globalSearch(store, q, limit = 30) {
  q = String(q || '').trim();
  if (q.length < 1) return [];
  const out = [];
  const docLabel = { sale: 'Invoice', purchase: 'Purchase', quotation: 'Quotation' };
  for (const p of store.listParties(null)) {
    if (matches(q, p.name, p.mobile, p.whatsapp, p.gstin, p.city, p.email)) {
      out.push({ type: p.type, id: p.id, title: p.name, subtitle: [p.type === 'customer' ? 'Customer' : 'Supplier', p.mobile, p.gstin].filter(Boolean).join(' · '), route: `#/party/${p.id}` });
    }
  }
  for (const p of store.listProducts()) {
    if (matches(q, p.name, p.code, p.sku, p.barcode, p.hsn, p.category, p.brand)) {
      out.push({ type: 'product', id: p.id, title: p.name, subtitle: ['Product', p.sku || p.code, p.hsn && 'HSN ' + p.hsn].filter(Boolean).join(' · '), route: `#/product/${p.id}` });
    }
  }
  for (const d of store.listDocuments(null)) {
    if (matches(q, d.number, d.party.name, d.party.mobile, d.party.gstin, d.refNo, d.transport && d.transport.ewayBill, d.transport && d.transport.vehicle)) {
      out.push({ type: d.kind, id: d.id, title: `${docLabel[d.kind]} ${d.number}`, subtitle: [d.party.name || 'Walk-in', d.date, store.money(d.totals.grandTotal), d.status === 'cancelled' ? 'Cancelled' : ''].filter(Boolean).join(' · '), route: `#/doc/${d.id}` });
    }
  }
  for (const p of store.listPayments()) {
    if (matches(q, p.number, p.reference, p.partyName, p.notes)) {
      out.push({ type: 'payment', id: p.id, title: `${p.direction === 'in' ? 'Receipt' : 'Payment'} ${p.number}`, subtitle: [p.partyName, p.date, store.money(p.amount), p.reference].filter(Boolean).join(' · '), route: `#/payment/${p.id}` });
    }
  }
  // Exact number / code hits first.
  const lq = fold(q);
  out.sort((a, b) => (fold(b.title).includes(lq) ? 1 : 0) - (fold(a.title).includes(lq) ? 1 : 0));
  return out.slice(0, limit);
}
