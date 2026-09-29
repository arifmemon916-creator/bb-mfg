// Reports and dashboard metrics. Pure functions over a BizStore instance;
// every figure is computed from stored transactions.

import { inRange, today as todayISO, daysBetween } from './dates.js';
import { mulDivRound, sum } from './money.js';
import { AGING_BUCKETS } from './ledger.js';

const activeDocs = (store, kind, range) =>
  store.listDocuments(kind).filter((d) => d.status !== 'cancelled' && inRange(d.date, range));
const activePays = (store, dir, range) =>
  store.listPayments(dir).filter((p) => p.status !== 'cancelled' && inRange(p.date, range));
const activeExpenses = (store, range) =>
  store.listExpenses().filter((e) => e.status !== 'cancelled' && inRange(e.date, range));

const col = (key, label, type = 'text') => ({ key, label, type });

// --------------------------------------------------------------- P & L

export function profitAndLoss(store, range) {
  const sales = activeDocs(store, 'sale', range);
  let grossSales = 0; let discounts = 0; let cogs = 0; let charges = 0; let roundOff = 0;
  for (const d of sales) {
    for (const it of d.items) {
      grossSales += it.calc.gross;
      discounts += it.calc.discount;
      cogs += mulDivRound(it.qty, it.cost || 0, 1000);
    }
    charges += d.totals.chargesTaxable;
    roundOff += d.totals.roundOff;
  }
  const netSales = grossSales - discounts;
  const grossProfit = netSales - cogs;
  const exp = activeExpenses(store, range);
  const byCat = new Map();
  for (const e of exp) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
  const expenses = sum(exp, (e) => e.amount);
  const otherIncome = charges + roundOff;
  const purchases = sum(activeDocs(store, 'purchase', range), (d) => d.totals.taxable);
  return {
    grossSales, discounts, netSales, cogs, grossProfit,
    charges, roundOff, otherIncome,
    expenses, expensesByCategory: [...byCat.entries()].sort((a, b) => b[1] - a[1]),
    netProfit: grossProfit + otherIncome - expenses,
    purchases,
    invoiceCount: sales.length,
  };
}

// --------------------------------------------------------------- GST

export function gstSummary(store, range) {
  const out = { taxableSales: 0, cgst: 0, sgst: 0, igst: 0, outputTax: 0, taxablePurchases: 0, inCgst: 0, inSgst: 0, inIgst: 0, inputTax: 0 };
  for (const d of activeDocs(store, 'sale', range)) {
    out.taxableSales += d.totals.taxable;
    out.cgst += d.totals.cgst; out.sgst += d.totals.sgst; out.igst += d.totals.igst;
  }
  for (const d of activeDocs(store, 'purchase', range)) {
    out.taxablePurchases += d.totals.taxable;
    out.inCgst += d.totals.cgst; out.inSgst += d.totals.sgst; out.inIgst += d.totals.igst;
  }
  out.outputTax = out.cgst + out.sgst + out.igst;
  out.inputTax = out.inCgst + out.inSgst + out.inIgst;
  out.netTax = out.outputTax - out.inputTax;
  return out;
}

// --------------------------------------------------------------- dashboard

export function dashboardMetrics(store, range) {
  const sales = activeDocs(store, 'sale', range);
  const purchases = activeDocs(store, 'purchase', range);
  let receivable = 0; let payable = 0;
  for (const p of store.parties.values()) {
    const bal = store.account(p.id).balance;
    if (bal <= 0) continue;
    if (p.type === 'customer') receivable += bal; else payable += bal;
  }
  const products = store.listProducts();
  const pl = profitAndLoss(store, range);
  return {
    sales: sum(sales, (d) => d.totals.grandTotal),
    salesCount: sales.length,
    purchases: sum(purchases, (d) => d.totals.grandTotal),
    purchaseCount: purchases.length,
    expenses: pl.expenses,
    collection: sum(activePays(store, 'in', range), (p) => p.amount),
    paid: sum(activePays(store, 'out', range), (p) => p.amount),
    receivable,
    payable,
    gst: gstSummary(store, range),
    profit: pl.netProfit,
    customers: store.listParties('customer').length,
    suppliers: store.listParties('supplier').length,
    products: products.length,
    lowStock: products.filter((p) => store.isLowStock(p)).length,
  };
}

/** Daily sales totals for a small trend chart. */
export function salesTrend(store, range, maxDays = 31) {
  const days = Math.min(maxDays, daysBetween(range.from, range.to) + 1);
  if (days <= 1 || days > maxDays) return [];
  const map = new Map();
  for (const d of activeDocs(store, 'sale', range)) map.set(d.date, (map.get(d.date) || 0) + d.totals.grandTotal);
  const out = [];
  const start = new Date(range.from + 'T00:00:00');
  for (let i = 0; i < days; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    out.push({ date: iso, value: map.get(iso) || 0 });
  }
  return out;
}

// --------------------------------------------------------------- reports

function docRows(store, kind, range) {
  return activeDocs(store, kind, range).map((d) => ({
    id: d.id, date: d.date, number: d.number, party: d.party.name || 'Walk-in', gstin: d.party.gstin,
    taxable: d.totals.taxable, cgst: d.totals.cgst, sgst: d.totals.sgst, igst: d.totals.igst,
    tax: d.totals.tax, total: d.totals.grandTotal, due: store.docDue(d), status: store.docStatus(d),
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.number.localeCompare(b.number)));
}

function groupItems(store, kind, range, keyFn, labelFn) {
  const map = new Map();
  for (const d of activeDocs(store, kind, range)) {
    for (const it of d.items) {
      const k = keyFn(d, it);
      const r = map.get(k) || { label: labelFn(d, it), qty: 0, taxable: 0, tax: 0, total: 0, cost: 0, docs: new Set() };
      r.qty += it.qty; r.taxable += it.calc.taxable; r.tax += it.calc.tax; r.total += it.calc.total;
      r.cost += mulDivRound(it.qty, it.cost || 0, 1000);
      r.docs.add(d.id);
      map.set(k, r);
    }
  }
  return [...map.values()].map((r) => ({ ...r, count: r.docs.size, docs: undefined, profit: r.taxable - r.cost }));
}

function totalsOf(rows, keys) {
  const t = {};
  for (const k of keys) t[k] = sum(rows, (r) => r[k]);
  return t;
}

export const REPORTS = [
  { id: 'sales-summary', group: 'Sales', title: 'Sales Summary' },
  { id: 'sales-product', group: 'Sales', title: 'Sales by Product' },
  { id: 'sales-customer', group: 'Sales', title: 'Sales by Customer' },
  { id: 'sales-date', group: 'Sales', title: 'Sales by Date' },
  { id: 'purchase-summary', group: 'Purchase', title: 'Purchase Summary' },
  { id: 'purchase-supplier', group: 'Purchase', title: 'Purchase by Supplier' },
  { id: 'purchase-product', group: 'Purchase', title: 'Purchase by Product' },
  { id: 'stock-current', group: 'Stock', title: 'Current Stock', noRange: true },
  { id: 'stock-movement', group: 'Stock', title: 'Stock Movement' },
  { id: 'stock-low', group: 'Stock', title: 'Low Stock', noRange: true },
  { id: 'fin-income', group: 'Finance', title: 'Income (Collections)' },
  { id: 'fin-expenses', group: 'Finance', title: 'Expenses' },
  { id: 'fin-receivables', group: 'Finance', title: 'Receivables (Aging)', noRange: true },
  { id: 'fin-payables', group: 'Finance', title: 'Payables (Aging)', noRange: true },
  { id: 'fin-pl', group: 'Finance', title: 'Profit & Loss' },
  { id: 'gst-sales', group: 'GST', title: 'Sales GST' },
  { id: 'gst-purchase', group: 'GST', title: 'Purchase GST' },
  { id: 'gst-rate', group: 'GST', title: 'GST Rate-wise Summary' },
  { id: 'gst-hsn', group: 'GST', title: 'HSN-wise Summary' },
  { id: 'gst-summary', group: 'GST', title: 'GST Summary (Net)' },
];

export function runReport(store, id, range) {
  const docCols = (partyLabel) => [
    col('date', 'Date', 'date'), col('number', 'No.'), col('party', partyLabel),
    col('taxable', 'Taxable', 'money'), col('tax', 'GST', 'money'), col('total', 'Total', 'money'), col('due', 'Due', 'money'), col('status', 'Status'),
  ];
  const gstCols = (partyLabel) => [
    col('date', 'Date', 'date'), col('number', 'No.'), col('party', partyLabel), col('gstin', 'GSTIN'),
    col('taxable', 'Taxable', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'), col('igst', 'IGST', 'money'), col('total', 'Total', 'money'),
  ];
  switch (id) {
    case 'sales-summary': {
      const rows = docRows(store, 'sale', range);
      return { columns: docCols('Customer'), rows, totals: totalsOf(rows, ['taxable', 'tax', 'total', 'due']) };
    }
    case 'purchase-summary': {
      const rows = docRows(store, 'purchase', range);
      return { columns: docCols('Supplier'), rows, totals: totalsOf(rows, ['taxable', 'tax', 'total', 'due']) };
    }
    case 'sales-product':
    case 'purchase-product': {
      const kind = id.startsWith('sales') ? 'sale' : 'purchase';
      const rows = groupItems(store, kind, range, (d, it) => it.productId || 'n:' + it.name.toLowerCase(), (d, it) => it.name)
        .sort((a, b) => b.taxable - a.taxable);
      const columns = [col('label', 'Product'), col('qty', 'Qty', 'qty'), col('taxable', 'Taxable', 'money'), col('tax', 'GST', 'money'), col('total', 'Total', 'money')];
      if (kind === 'sale') columns.push(col('profit', 'Gross Profit', 'money'));
      return { columns, rows, totals: totalsOf(rows, ['qty', 'taxable', 'tax', 'total', 'profit']) };
    }
    case 'sales-customer':
    case 'purchase-supplier': {
      const kind = id.startsWith('sales') ? 'sale' : 'purchase';
      const map = new Map();
      for (const d of activeDocs(store, kind, range)) {
        const k = d.partyId || 'walkin';
        const r = map.get(k) || { label: d.partyId ? d.party.name : 'Walk-in', count: 0, taxable: 0, tax: 0, total: 0, due: 0 };
        r.count++; r.taxable += d.totals.taxable; r.tax += d.totals.tax; r.total += d.totals.grandTotal; r.due += store.docDue(d);
        map.set(k, r);
      }
      const rows = [...map.values()].sort((a, b) => b.total - a.total);
      return {
        columns: [col('label', kind === 'sale' ? 'Customer' : 'Supplier'), col('count', 'Bills', 'int'), col('taxable', 'Taxable', 'money'), col('tax', 'GST', 'money'), col('total', 'Total', 'money'), col('due', 'Due', 'money')],
        rows, totals: totalsOf(rows, ['count', 'taxable', 'tax', 'total', 'due']),
      };
    }
    case 'sales-date': {
      const map = new Map();
      for (const d of activeDocs(store, 'sale', range)) {
        const r = map.get(d.date) || { date: d.date, count: 0, taxable: 0, tax: 0, total: 0 };
        r.count++; r.taxable += d.totals.taxable; r.tax += d.totals.tax; r.total += d.totals.grandTotal;
        map.set(d.date, r);
      }
      const rows = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        columns: [col('date', 'Date', 'date'), col('count', 'Invoices', 'int'), col('taxable', 'Taxable', 'money'), col('tax', 'GST', 'money'), col('total', 'Total', 'money')],
        rows, totals: totalsOf(rows, ['count', 'taxable', 'tax', 'total']),
      };
    }
    case 'stock-current':
    case 'stock-low': {
      let prods = store.listProducts().filter((p) => p.trackStock);
      if (id === 'stock-low') prods = prods.filter((p) => store.isLowStock(p));
      const rows = prods.map((p) => {
        const s = store.stockOf(p.id);
        return {
          id: p.id, label: p.name, sku: p.sku || p.code, unit: p.unit, stock: s.current, min: p.minStock,
          value: mulDivRound(Math.max(0, s.current), p.purchasePrice, 1000),
          saleValue: mulDivRound(Math.max(0, s.current), p.salePrice, 1000),
        };
      });
      return {
        columns: [col('label', 'Product'), col('sku', 'SKU'), col('stock', 'Stock', 'qty'), col('unit', 'Unit'), col('min', 'Min', 'qty'), col('value', 'Value (Cost)', 'money'), col('saleValue', 'Value (Sale)', 'money')],
        rows, totals: totalsOf(rows, ['value', 'saleValue']),
      };
    }
    case 'stock-movement': {
      const rows = stockMovementSummary(store, range);
      return {
        columns: [col('label', 'Product'), col('opening', 'Opening', 'qty'), col('purchased', 'Purchased', 'qty'), col('sold', 'Sold', 'qty'), col('adjusted', 'Adjusted', 'qty'), col('closing', 'Closing', 'qty')],
        rows, totals: null,
      };
    }
    case 'fin-income': {
      const rows = activePays(store, 'in', range).map((p) => ({ date: p.date, number: p.number, party: p.partyName, method: p.method, reference: p.reference, amount: p.amount }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const byMethod = new Map();
      for (const r of rows) byMethod.set(r.method, (byMethod.get(r.method) || 0) + r.amount);
      return {
        columns: [col('date', 'Date', 'date'), col('number', 'Receipt'), col('party', 'Customer'), col('method', 'Method'), col('reference', 'Reference'), col('amount', 'Amount', 'money')],
        rows, totals: totalsOf(rows, ['amount']),
        summary: [...byMethod.entries()].map(([m, v]) => [m, v, 'money']),
      };
    }
    case 'fin-expenses': {
      const rows = activeExpenses(store, range).map((e) => ({ date: e.date, category: e.category, method: e.method, description: e.description, amount: e.amount }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const byCat = new Map();
      for (const r of rows) byCat.set(r.category, (byCat.get(r.category) || 0) + r.amount);
      return {
        columns: [col('date', 'Date', 'date'), col('category', 'Category'), col('method', 'Method'), col('description', 'Description'), col('amount', 'Amount', 'money')],
        rows, totals: totalsOf(rows, ['amount']),
        summary: [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, v, 'money']),
      };
    }
    case 'fin-receivables':
    case 'fin-payables': {
      const type = id === 'fin-receivables' ? 'customer' : 'supplier';
      const rows = outstandingRows(store, type);
      return {
        columns: [col('label', type === 'customer' ? 'Customer' : 'Supplier'), col('mobile', 'Mobile'),
          ...AGING_BUCKETS.map((b, i) => col('a' + i, b, 'money')), col('balance', 'Outstanding', 'money')],
        rows, totals: totalsOf(rows, ['a0', 'a1', 'a2', 'a3', 'a4', 'balance']),
      };
    }
    case 'fin-pl': {
      const pl = profitAndLoss(store, range);
      const rows = [
        { label: 'Gross Sales (excl. GST)', amount: pl.grossSales },
        { label: 'Less: Discounts', amount: -pl.discounts },
        { label: 'Net Sales', amount: pl.netSales, strong: true },
        { label: 'Less: Cost of Goods Sold (purchase cost)', amount: -pl.cogs },
        { label: 'Gross Profit', amount: pl.grossProfit, strong: true },
        { label: 'Add: Charges collected (packaging / other)', amount: pl.charges },
        { label: 'Add: Round off', amount: pl.roundOff },
        ...pl.expensesByCategory.map(([c, v]) => ({ label: 'Less: Expense – ' + c, amount: -v })),
        { label: 'Total Expenses', amount: -pl.expenses },
        { label: 'Net Profit', amount: pl.netProfit, strong: true },
      ];
      return {
        columns: [col('label', 'Particulars'), col('amount', 'Amount', 'money')], rows, totals: null,
        note: 'Cost of goods sold uses each product\'s purchase price at the time of sale. GST is excluded (it is a liability, not income). Purchases in period (taxable): ' + store.money(pl.purchases),
      };
    }
    case 'gst-sales': {
      const rows = docRows(store, 'sale', range);
      return { columns: gstCols('Customer'), rows, totals: totalsOf(rows, ['taxable', 'cgst', 'sgst', 'igst', 'total']) };
    }
    case 'gst-purchase': {
      const rows = docRows(store, 'purchase', range);
      return { columns: gstCols('Supplier'), rows, totals: totalsOf(rows, ['taxable', 'cgst', 'sgst', 'igst', 'total']) };
    }
    case 'gst-rate':
    case 'gst-hsn': {
      const rows = [];
      for (const kind of ['sale', 'purchase']) {
        const map = new Map();
        for (const d of activeDocs(store, kind, range)) {
          for (const r of d.totals.taxBreakup) {
            const key = id === 'gst-rate' ? String(r.gstBp) : r.hsn + '|' + r.gstBp;
            const x = map.get(key) || { type: kind === 'sale' ? 'Output (Sales)' : 'Input (Purchase)', hsn: r.hsn || '-', rate: r.gstBp / 100 + '%', taxable: 0, cgst: 0, sgst: 0, igst: 0 };
            x.taxable += r.taxable; x.cgst += r.cgst; x.sgst += r.sgst; x.igst += r.igst;
            map.set(key, x);
          }
        }
        rows.push(...[...map.values()].map((x) => ({ ...x, tax: x.cgst + x.sgst + x.igst })));
      }
      const columns = [col('type', 'Type'), ...(id === 'gst-hsn' ? [col('hsn', 'HSN/SAC')] : []), col('rate', 'GST %'),
        col('taxable', 'Taxable', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'), col('igst', 'IGST', 'money'), col('tax', 'Total GST', 'money')];
      return { columns, rows, totals: null };
    }
    case 'gst-summary': {
      const g = gstSummary(store, range);
      const rows = [
        { label: 'Taxable Sales', amount: g.taxableSales },
        { label: 'Output CGST', amount: g.cgst },
        { label: 'Output SGST', amount: g.sgst },
        { label: 'Output IGST', amount: g.igst },
        { label: 'Total Output GST', amount: g.outputTax, strong: true },
        { label: 'Taxable Purchases', amount: g.taxablePurchases },
        { label: 'Input CGST', amount: g.inCgst },
        { label: 'Input SGST', amount: g.inSgst },
        { label: 'Input IGST', amount: g.inIgst },
        { label: 'Total Input GST (Purchase GST)', amount: g.inputTax, strong: true },
        { label: g.netTax >= 0 ? 'Net GST Payable' : 'Net GST Credit', amount: Math.abs(g.netTax), strong: true },
      ];
      return {
        columns: [col('label', 'Particulars'), col('amount', 'Amount', 'money')], rows, totals: null,
        note: 'Indicative figures computed from recorded invoices. Verify with your accountant before filing returns; eligibility of input credit and set-off rules are not applied.',
      };
    }
    default:
      return { columns: [], rows: [], totals: null };
  }
}

export function outstandingRows(store, type) {
  return store.listParties(type).map((p) => {
    const a = store.account(p.id);
    return {
      id: p.id, label: p.name, mobile: p.mobile, balance: a.balance,
      a0: a.aging[0], a1: a.aging[1], a2: a.aging[2], a3: a.aging[3], a4: a.aging[4],
      creditLimit: p.creditLimit || 0,
    };
  }).filter((r) => r.balance !== 0).sort((a, b) => b.balance - a.balance);
}

/** Per product opening / in / out / adjusted / closing for a date range. */
export function stockMovementSummary(store, range) {
  const map = new Map();
  for (const p of store.listProducts()) {
    if (!p.trackStock) continue;
    map.set(p.id, { id: p.id, label: p.name, opening: p.openingStock || 0, purchased: 0, sold: 0, adjusted: 0 });
  }
  const bump = (pid, field, qty, date) => {
    const r = map.get(pid);
    if (!r) return;
    if (date < range.from) r.opening += qty * (field === 'sold' ? -1 : 1);
    else if (date <= range.to) r[field] += qty;
  };
  for (const d of store.documents.values()) {
    if (d.status === 'cancelled' || d.deleted || (d.kind !== 'sale' && d.kind !== 'purchase')) continue;
    for (const it of d.items) if (it.productId) bump(it.productId, d.kind === 'sale' ? 'sold' : 'purchased', it.qty, d.date);
  }
  for (const m of store.stockMoves.values()) bump(m.productId, 'adjusted', m.qty, m.date);
  return [...map.values()].map((r) => ({ ...r, closing: r.opening + r.purchased - r.sold + r.adjusted }));
}

/** Detailed movement history of one product (newest first). */
export function productMovements(store, productId) {
  const rows = [];
  for (const d of store.documents.values()) {
    if (d.status === 'cancelled' || d.deleted || (d.kind !== 'sale' && d.kind !== 'purchase')) continue;
    for (const it of d.items) {
      if (it.productId !== productId) continue;
      rows.push({ date: d.date, ts: d.createdAt, type: d.kind === 'sale' ? 'Sale' : 'Purchase', ref: d.number, docId: d.id, party: d.party.name, qty: d.kind === 'sale' ? -it.qty : it.qty });
    }
  }
  for (const m of store.stockMoves.values()) {
    if (m.productId === productId) rows.push({ date: m.date, ts: m.createdAt, type: 'Adjustment', ref: m.reason, qty: m.qty });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.ts || '').localeCompare(b.ts || '')));
  const p = store.products.get(productId);
  let bal = p ? p.openingStock || 0 : 0;
  for (const r of rows) { bal += r.qty; r.balance = bal; }
  return rows.reverse();
}

export function dueSoon(store, days = 3) {
  const t = todayISO();
  const out = [];
  for (const d of store.listDocuments('sale')) {
    if (d.status === 'cancelled' || !d.dueDate) continue;
    const due = store.docDue(d);
    if (due <= 0) continue;
    const left = daysBetween(t, d.dueDate);
    if (left <= days) out.push({ doc: d, due, daysLeft: left });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
