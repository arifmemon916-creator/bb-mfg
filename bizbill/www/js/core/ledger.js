// Party accounts: balances, per-invoice dues, aging and ledger statements.
//
// Everything here is DERIVED from the stored documents and payments; no
// balance is stored separately, so a ledger can never drift out of sync with
// the transactions it summarises.
//
// Conventions (our books):
//   Customer account: Sale invoice = Debit, Payment received = Credit,
//                     Refund paid to customer = Debit.
//                     Positive balance = receivable (Dr).
//   Supplier account: Purchase = Credit, Payment made = Debit,
//                     Refund received from supplier = Credit.
//                     Positive balance = payable (Cr).
//   Opening balance: positive = customer owes us / we owe supplier.

import { daysBetween, today as todayISO } from './dates.js';

export const AGING_BUCKETS = ['Current', '1-30 days', '31-60 days', '61-90 days', '90+ days'];

function agingIndex(days) {
  if (days <= 0) return 0;
  if (days <= 30) return 1;
  if (days <= 60) return 2;
  if (days <= 90) return 3;
  return 4;
}

const docKindFor = (type) => (type === 'supplier' ? 'purchase' : 'sale');

function isActiveDoc(d) {
  return d.status !== 'cancelled' && d.kind !== 'quotation';
}

/**
 * Build the charge/settlement view of one party.
 * Returns {balance, charges, settlements, docDue(Map), aging[5], advance}
 */
export function computePartyAccount(party, docs, payments, asOf = todayISO()) {
  const kind = docKindFor(party.type);
  const settleDir = party.type === 'supplier' ? 'out' : 'in';
  const myDocs = docs.filter((d) => d.partyId === party.id && d.kind === kind && isActiveDoc(d));
  const myPays = payments.filter((p) => p.partyId === party.id && p.status !== 'cancelled');
  const docById = new Map(myDocs.map((d) => [d.id, d]));

  // Items that increase the amount owed (in the party's natural direction).
  const items = [];
  const opening = Math.trunc(party.openingBalance || 0);
  let pool = 0;
  if (opening > 0) items.push({ id: 'opening', date: party.openingDate || '0000-01-01', due: opening, ref: null });
  else if (opening < 0) pool += -opening;

  const allocated = new Map();
  let settlements = opening < 0 ? -opening : 0;
  let charges = opening > 0 ? opening : 0;

  for (const p of myPays) {
    if (p.direction === settleDir) {
      settlements += p.amount;
      let used = 0;
      for (const a of p.allocations || []) {
        if (!docById.has(a.docId) || !(a.amount > 0)) continue;
        allocated.set(a.docId, (allocated.get(a.docId) || 0) + a.amount);
        used += a.amount;
      }
      pool += Math.max(0, p.amount - used);
    } else {
      // Refund in the opposite direction behaves like a new charge.
      charges += p.amount;
      items.push({ id: p.id, date: p.date, due: p.amount, ref: null });
    }
  }

  for (const d of myDocs) {
    const total = d.totals ? d.totals.grandTotal : 0;
    charges += total;
    const alloc = allocated.get(d.id) || 0;
    let due = total - alloc;
    if (due < 0) { pool += -due; due = 0; }
    items.push({ id: d.id, date: d.dueDate || d.date, docDate: d.date, due, ref: d });
  }

  // Unallocated settlements are applied to the oldest dues first (FIFO).
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const it of items) {
    if (pool <= 0) break;
    const take = Math.min(pool, it.due);
    it.due -= take;
    pool -= take;
  }

  const docDue = new Map();
  const aging = [0, 0, 0, 0, 0];
  for (const it of items) {
    if (it.ref) docDue.set(it.id, it.due);
    if (it.due > 0) aging[agingIndex(daysBetween(it.date, asOf))] += it.due;
  }
  return {
    balance: charges - settlements,
    charges,
    settlements,
    advance: pool,
    docDue,
    aging,
  };
}

/** Payment status for a document given its remaining due. */
export function paymentStatus(doc, due) {
  if (doc.status === 'cancelled') return 'cancelled';
  if (doc.kind === 'quotation') return doc.qStatus || 'draft';
  const total = doc.totals ? doc.totals.grandTotal : 0;
  if (total <= 0 || due <= 0) return 'paid';
  if (due >= total) return 'unpaid';
  return 'partial';
}

/**
 * Ledger statement for a party within [from, to].
 * Returns {opening, rows:[{date, type, ref, description, debit, credit, balance}],
 *          totalDebit, totalCredit, closing}
 * Balances are signed Dr-positive (customer) or Cr-positive (supplier).
 */
export function ledgerStatement(party, docs, payments, range = { from: '0000-01-01', to: '9999-12-31' }) {
  const isSupplier = party.type === 'supplier';
  const kind = docKindFor(party.type);
  const entries = [];
  const opening = Math.trunc(party.openingBalance || 0);
  const openDate = party.openingDate || '0000-01-01';
  if (opening) {
    entries.push({
      date: openDate, order: 0, type: 'opening', ref: '', description: 'Opening balance',
      amount: opening, // natural direction (+ = increases balance)
    });
  }
  for (const d of docs) {
    if (d.partyId !== party.id || d.kind !== kind || !isActiveDoc(d)) continue;
    entries.push({
      date: d.date, order: 1, ts: d.createdAt || '', type: d.kind, id: d.id, ref: d.number,
      description: (isSupplier ? 'Purchase ' : 'Sales Invoice ') + d.number + (d.refNo ? ` (Bill ${d.refNo})` : ''),
      amount: d.totals.grandTotal,
    });
  }
  const settleDir = isSupplier ? 'out' : 'in';
  for (const p of payments) {
    if (p.partyId !== party.id || p.status === 'cancelled') continue;
    const settles = p.direction === settleDir;
    const label = settles ? (isSupplier ? 'Payment made' : 'Payment received') : (isSupplier ? 'Refund received' : 'Refund paid');
    entries.push({
      date: p.date, order: 2, ts: p.createdAt || '', type: 'payment', id: p.id, ref: p.number,
      description: `${label} ${p.number || ''} (${p.method}${p.reference ? ' · ' + p.reference : ''})`.replace(/\s+/g, ' '),
      amount: settles ? -p.amount : p.amount,
    });
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)));

  let openingBal = 0;
  const rows = [];
  let bal = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  for (const e of entries) {
    if (e.date < range.from) {
      openingBal += e.amount;
      continue;
    }
    if (e.date > range.to) continue;
    if (!rows.length) bal = openingBal;
    bal += e.amount;
    // Customer: + amount is Debit. Supplier: + amount is Credit.
    const debit = isSupplier ? (e.amount < 0 ? -e.amount : 0) : (e.amount > 0 ? e.amount : 0);
    const credit = isSupplier ? (e.amount > 0 ? e.amount : 0) : (e.amount < 0 ? -e.amount : 0);
    totalDebit += debit;
    totalCredit += credit;
    rows.push({ date: e.date, type: e.type, id: e.id, ref: e.ref, description: e.description, debit, credit, balance: bal });
  }
  if (!rows.length) bal = openingBal;
  return { opening: openingBal, rows, totalDebit, totalCredit, closing: bal, isSupplier };
}

/** Label a signed natural-direction balance as Dr/Cr for display. */
export function drCr(balance, isSupplier) {
  if (!balance) return '';
  const positiveIsDr = !isSupplier;
  return (balance > 0) === positiveIsDr ? 'Dr' : 'Cr';
}
