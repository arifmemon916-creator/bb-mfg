// Document templates: invoice / purchase / quotation, payment receipt,
// ledger statement and generic report. All share the same company header.

import { pdfSafe } from './layout.js';
import { formatMoney, formatQty, amountInWords, bpToPct } from '../core/money.js';
import { formatDate } from '../core/dates.js';
import { stateName } from '../core/states.js';

const ACCENT = '#1f4e79';
const MUTED = '#555555';

function fmt(settings) {
  const b = settings.billing;
  const m = (p) => formatMoney(p, { symbol: '', grouping: b.grouping });
  const M = (p) => formatMoney(p, { symbol: 'Rs. ', grouping: b.grouping });
  const d = (iso) => formatDate(iso, b.dateFormat);
  const q = (x) => formatQty(x, b.qtyDecimals);
  return { m, M, d, q };
}

/** Company header block. Returns bottom y. `accent` lets bill formats recolour it. */
function header(L, settings, title, subtitle, accent = ACCENT) {
  const c = settings.company;
  const top = L.y;
  let x = L.M;
  if (c.logo) {
    const maxW = 28; const maxH = 20;
    let w = maxW; let h = maxH;
    if (c.logoW && c.logoH) {
      const r = Math.min(maxW / c.logoW, maxH / c.logoH);
      w = c.logoW * r; h = c.logoH * r;
    }
    L.image(c.logo, x, top, w, h);
    x += w + 4;
  }
  const rightW = 62;
  const textW = L.W - L.M - rightW - x;
  let y = top + 5;
  L.text(c.name || 'Your Company Name', x, y, { size: 15, style: 'bold', color: accent });
  y += 5;
  const addr = [c.address, [c.city, c.state || stateName(c.stateCode), c.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  for (const l of L.wrap(addr, textW, 8)) { L.text(l, x, y, { size: 8, color: MUTED }); y += 3.6; }
  const contact = [c.mobile && 'Ph: ' + c.mobile, c.email].filter(Boolean).join('  |  ');
  if (contact) { L.text(contact, x, y, { size: 8, color: MUTED }); y += 3.6; }
  const ids = [c.gstin && 'GSTIN: ' + c.gstin, c.stateCode && `State: ${stateName(c.stateCode)} (${c.stateCode})`, c.pan && 'PAN: ' + c.pan].filter(Boolean).join('  |  ');
  if (ids) { L.text(ids, x, y, { size: 8, style: 'bold' }); y += 3.6; }

  const rx = L.W - L.M;
  L.text(title, rx, top + 6, { size: 14, style: 'bold', color: accent, align: 'right' });
  if (subtitle) L.text(subtitle, rx, top + 11, { size: 7, color: MUTED, align: 'right' });
  L.y = Math.max(y, top + 22) + 2;
  L.line(L.M, L.y, L.W - L.M, L.y, 0.5, accent);
  L.y += 3;
}

function footer(L, settings) {
  if (L.continuous) return;
  for (let p = 0; p < L.pages; p++) {
    const y = L.H - L.M + 2;
    L.ops.push({ t: 'text', p, s: pdfSafe(`Page ${p + 1} of ${L.pages}`), x: L.W - L.M, y, size: 7, style: 'normal', color: '#888888', align: 'right' });
    L.ops.push({ t: 'text', p, s: pdfSafe('Generated with BizBill'), x: L.M, y, size: 7, style: 'normal', color: '#888888', align: 'left' });
    void settings;
  }
}

/** Two-column key/value block. rows: [[label, value]] */
function kvBlock(L, x, y, w, rows, size = 8) {
  const lw = Math.min(28, w * 0.42);
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    L.text(k, x, y, { size, color: MUTED });
    const lines = L.wrap(String(v), w - lw, size, 'bold');
    lines.forEach((l, i) => L.text(l, x + lw, y + i * 3.6, { size, style: 'bold' }));
    y += Math.max(1, lines.length) * 3.6;
  }
  return y;
}

function partyBlock(L, x, y, w, heading, p, accent = ACCENT) {
  L.text(heading, x, y, { size: 7.5, style: 'bold', color: accent });
  y += 4;
  L.text(p.name || 'Walk-in Customer', x, y, { size: 10, style: 'bold' });
  y += 4.2;
  const addr = [p.address, [p.city, p.state || stateName(p.stateCode), p.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  for (const l of L.wrap(addr, w, 8)) { L.text(l, x, y, { size: 8, color: MUTED }); y += 3.6; }
  if (p.mobile) { L.text('Mobile: ' + p.mobile, x, y, { size: 8 }); y += 3.6; }
  if (p.email) { L.text('Email: ' + p.email, x, y, { size: 8 }); y += 3.6; }
  if (p.gstin) { L.text('GSTIN: ' + p.gstin, x, y, { size: 8, style: 'bold' }); y += 3.6; }
  if (p.stateCode) { L.text(`State: ${stateName(p.stateCode)} (${p.stateCode})`, x, y, { size: 8 }); y += 3.6; }
  return y;
}

// -------------------------------------------------------------- invoice

const TITLES = { sale: 'TAX INVOICE', purchase: 'PURCHASE BILL', quotation: 'QUOTATION' };

/**
 * Visual bill formats (Settings → Billing → Bill Format). Every format
 * prints the same data; only colours, borders, density and (for the
 * thermal format) the page layout differ. See core/settings.js BILL_FORMATS.
 */
const INVOICE_STYLES = {
  1: { accent: ACCENT, headFill: ACCENT, zebra: true, grid: false, compact: false },
  2: { accent: ACCENT, headFill: ACCENT, zebra: false, grid: false, compact: true, hideHsnSummary: true },
  3: { accent: '#222222', headFill: '#ffffff', zebra: false, grid: true, compact: false },
  5: { accent: '#0f766e', headFill: '#0f766e', zebra: true, grid: false, compact: false, bold: true },
  6: { accent: '#333333', headFill: '#eeeeee', zebra: false, grid: false, compact: false, plain: true },
};

function styleFor(settings) {
  const id = Math.min(6, Math.max(1, Math.trunc(settings.billing.billFormat) || 1));
  return { id, ...(INVOICE_STYLES[id] || INVOICE_STYLES[1]) };
}

/**
 * @param {import('./layout.js').Layout} L
 * @param {object} doc     stored document
 * @param {object} settings
 * @param {object} extra   {paid, due, status}
 */
export function renderInvoice(L, doc, settings, extra = {}) {
  const style = styleFor(settings);
  if (style.id === 4) return renderThermalInvoice(L, doc, settings, extra);
  const { m, M, d, q } = fmt(settings);
  const b = settings.billing;
  const accent = style.accent;
  const S = { table: style.compact ? 7 : 7.5, totals: style.compact ? 8 : 8.5, gapSmall: style.compact ? 1.5 : 3, gapMed: style.compact ? 4 : 6 };
  let title = TITLES[doc.kind];
  if (doc.kind === 'sale' && !doc.gst) title = 'INVOICE';
  if (doc.status === 'cancelled') title += ' (CANCELLED)';
  if (style.bold) L.rect(0, 0, L.W, 4, { fill: accent }); // Modern: bold top banner
  header(L, settings, title, doc.kind === 'sale' ? b.invoiceCopies : '', accent);

  const top = L.y;
  const half = (L.contentW - 6) / 2;
  const partyHeading = doc.kind === 'purchase' ? 'SUPPLIER' : 'BILL TO';
  const yl = partyBlock(L, L.M, top + 1, half, partyHeading, doc.party, accent);
  const noLabel = { sale: 'Invoice No.', purchase: 'Purchase No.', quotation: 'Quotation No.' }[doc.kind];
  const t = doc.transport || {};
  const yr = kvBlock(L, L.M + half + 6, top + 1, half, [
    [noLabel, doc.number],
    ['Date', d(doc.date)],
    [doc.kind === 'quotation' ? 'Valid Until' : 'Due Date', doc.kind === 'quotation' ? (doc.validUntil ? d(doc.validUntil) : '') : (doc.dueDate ? d(doc.dueDate) : '')],
    ['Supplier Bill', doc.refNo],
    ['Place of Supply', doc.gst && doc.placeOfSupply ? `${stateName(doc.placeOfSupply)} (${doc.placeOfSupply})` : ''],
    ['Transport', t.name],
    ['Vehicle No.', t.vehicle],
    ['E-Way Bill', t.ewayBill],
  ]);
  L.y = Math.max(yl, yr) + 1;
  if (t.shippingAddress || t.deliveryAddress) {
    const ship = t.shippingAddress || t.deliveryAddress;
    L.text('SHIP TO / DELIVERY', L.M, L.y + 3, { size: 7.5, style: 'bold', color: accent });
    L.y += 4;
    L.paragraph(ship, L.M, L.contentW, { size: 8 });
    if (t.deliveryAddress && t.shippingAddress && t.deliveryAddress !== t.shippingAddress) {
      L.paragraph('Delivery: ' + t.deliveryAddress, L.M, L.contentW, { size: 8 });
    }
    if (t.notes) L.paragraph('Transport notes: ' + t.notes, L.M, L.contentW, { size: 8, color: MUTED });
  }
  L.y += 2;

  // Items table.
  const inter = doc.interState;
  const showImg = !!(b.showProductImage && extra.thumbs && doc.items.some((it) => extra.thumbs[it.productId]));
  const cols = [
    { label: '#', w: 6, align: 'center' },
    ...(showImg ? [{ label: '', w: 11 }] : []),
    { label: 'Item', w: 0 },
    { label: 'HSN/SAC', w: 15 },
    { label: 'Qty', w: 14, align: 'right' },
    { label: 'Unit', w: 10 },
    { label: 'Rate', w: 18, align: 'right' },
    { label: 'Disc.', w: 14, align: 'right' },
    { label: 'Taxable', w: 20, align: 'right' },
  ];
  if (doc.gst) cols.push({ label: 'GST%', w: 10, align: 'right' }, { label: inter ? 'IGST' : 'CGST+SGST', w: 18, align: 'right' });
  cols.push({ label: 'Amount', w: 21, align: 'right' });
  const rows = doc.items.map((it, i) => {
    const c = it.calc;
    const name = [it.name, it.sku && `SKU: ${it.sku}`, it.description].filter(Boolean).join('\n');
    const disc = it.disc ? (it.discType === 'pct' ? bpToPct(it.disc) + '%' : m(c.discount)) : '';
    const row = [String(i + 1), ...(showImg ? [''] : []), name, it.hsn || '', q(it.qty), it.unit || '', m(it.rate), disc, m(c.taxable)];
    if (doc.gst) row.push(bpToPct(c.gstBp) + '%', m(c.tax));
    row.push(m(c.total));
    const t = showImg && extra.thumbs[it.productId];
    return t ? { cells: row, image: { col: 1, data: t, size: 9 } } : row;
  });
  L.table(cols, rows, { size: S.table, headFill: style.headFill, headColor: style.plain ? '#111111' : '#ffffff', zebra: style.zebra, grid: style.grid });
  L.y += S.gapSmall;

  // Totals (right) and words / tax summary / bank (left).
  const T = doc.totals;
  const totalRows = [
    ['Sub Total', m(T.gross)],
    T.discount ? ['Discount', '- ' + m(T.discount)] : null,
    ['Taxable Amount', m(T.itemsTaxable)],
    ...(doc.inclusive && doc.chargesGstBp && T.chargesEntered
      // Inclusive charges: show the value net of the GST contained in them.
      ? [['Charges (excl. GST)', m(T.chargesTaxable)]]
      : [doc.packaging ? ['Packaging Charges', m(doc.packaging)] : null,
        doc.otherCharges ? [doc.otherChargesLabel || 'Other Charges', m(doc.otherCharges)] : null]),
    doc.gst && T.cgst ? ['CGST', m(T.cgst)] : null,
    doc.gst && T.sgst ? ['SGST', m(T.sgst)] : null,
    doc.gst && T.igst ? ['IGST', m(T.igst)] : null,
    T.roundOff ? ['Round Off', (T.roundOff > 0 ? '+ ' : '- ') + m(Math.abs(T.roundOff))] : null,
  ].filter(Boolean);
  const boxW = 74;
  const bx = L.W - L.M - boxW;
  const needed = totalRows.length * 4.6 + 12;
  L.ensure(needed);
  const startY = L.y;
  let ty = startY + 4;
  for (const [k, v] of totalRows) {
    L.text(k, bx + 2, ty, { size: S.totals, color: MUTED });
    L.text(v, L.W - L.M - 2, ty, { size: S.totals, align: 'right' });
    ty += 4.6;
  }
  const bannerSize = style.bold ? 11 : 10;
  if (style.plain || style.grid) {
    L.line(bx, ty - 3, L.W - L.M, ty - 3, 0.5, accent);
    L.text('GRAND TOTAL', bx + 2, ty + 2.4, { size: bannerSize, style: 'bold', color: '#111111' });
    L.text(M(T.grandTotal), L.W - L.M - 2, ty + 2.4, { size: bannerSize, style: 'bold', color: '#111111', align: 'right' });
    ty += 9;
  } else {
    const bannerH = style.bold ? 10 : 8;
    L.rect(bx, ty - 3, boxW, bannerH, { fill: accent });
    L.text('GRAND TOTAL', bx + 2, ty + bannerH - 5.6, { size: bannerSize, style: 'bold', color: '#ffffff' });
    L.text(M(T.grandTotal), L.W - L.M - 2, ty + bannerH - 5.6, { size: bannerSize, style: 'bold', color: '#ffffff', align: 'right' });
    ty += bannerH + 1;
  }
  if (doc.kind !== 'quotation' && extra.paid != null && doc.status !== 'cancelled') {
    L.text('Paid', bx + 2, ty + 1, { size: S.totals, color: MUTED });
    L.text(m(extra.paid), L.W - L.M - 2, ty + 1, { size: S.totals, align: 'right' });
    ty += 4.6;
    L.text('Balance Due', bx + 2, ty + 1, { size: S.totals, style: 'bold' });
    L.text(m(extra.due), L.W - L.M - 2, ty + 1, { size: S.totals, style: 'bold', align: 'right' });
    ty += 4.6;
  }

  // Left column.
  const lw = L.contentW - boxW - 6;
  let ly = startY + 4;
  L.text('Amount in words', L.M, ly, { size: 7.5, style: 'bold', color: accent });
  ly += 3.8;
  for (const l of L.wrap(amountInWords(T.grandTotal, b.currencyName, b.currencySubunit), lw, 8, 'bold')) { L.text(l, L.M, ly, { size: 8, style: 'bold' }); ly += 3.6; }
  ly += 1;
  if (doc.kind !== 'purchase' && doc.paymentMethod && doc.kind === 'sale') {
    L.text(`Payment: ${extra.status ? extra.status.toUpperCase() + ' · ' : ''}${doc.paymentMethod}`, L.M, ly + 1, { size: 8 });
    ly += 4.6;
  }
  L.y = Math.max(ly, ty) + 2;

  if (doc.gst && b.showHsnSummary && !style.hideHsnSummary && T.taxBreakup.length) {
    const tcols = [{ label: 'HSN/SAC', w: 0 }, { label: 'GST%', w: 14, align: 'right' }, { label: 'Taxable', w: 26, align: 'right' }];
    if (inter) tcols.push({ label: 'IGST', w: 24, align: 'right' });
    else tcols.push({ label: 'CGST', w: 22, align: 'right' }, { label: 'SGST', w: 22, align: 'right' });
    tcols.push({ label: 'Total Tax', w: 24, align: 'right' });
    const trs = T.taxBreakup.map((r) => {
      const row = [r.hsn || '-', bpToPct(r.gstBp) + '%', m(r.taxable)];
      if (inter) row.push(m(r.igst)); else row.push(m(r.cgst), m(r.sgst));
      row.push(m(r.cgst + r.sgst + r.igst));
      return row;
    });
    L.table(tcols, trs, { size: 7, headFill: style.plain || style.grid ? '#ffffff' : '#5b7fa6', headColor: style.plain || style.grid ? '#111111' : '#ffffff', grid: style.grid });
    L.y += S.gapSmall;
  }

  const c = settings.company;
  const bank = doc.kind !== 'purchase' ? [
    c.bankName && ['Bank', c.bankName], c.bankAccount && ['A/c No.', c.bankAccount],
    c.bankIfsc && ['IFSC', c.bankIfsc], c.bankBranch && ['Branch', c.bankBranch], c.upiId && ['UPI ID', c.upiId],
  ].filter(Boolean) : [];
  const terms = doc.terms && doc.kind !== 'purchase' ? doc.terms : '';
  if (doc.notes) {
    L.ensure(10);
    L.text('Notes', L.M, L.y + 3, { size: 7.5, style: 'bold', color: accent });
    L.y += 4;
    L.paragraph(doc.notes, L.M, L.contentW, { size: 8 });
    L.y += 2;
  }
  if (doc.status === 'cancelled' && doc.cancelReason) {
    L.paragraph('Cancelled: ' + doc.cancelReason, L.M, L.contentW, { size: 8, style: 'bold', color: '#b00020' });
    L.y += 2;
  }
  if (bank.length || terms) {
    const blockH = Math.max(bank.length * 3.8 + 6, L.wrap(terms, L.contentW / 2, 7.5).length * 3.4 + 6);
    L.ensure(blockH + 22);
    const y0 = L.y;
    let by = y0 + 3;
    if (bank.length) {
      L.text('Bank Details', L.M, by, { size: 7.5, style: 'bold', color: accent });
      by = kvBlock(L, L.M, by + 4, L.contentW / 2 - 4, bank, 7.5);
    }
    let ty2 = y0 + 3;
    if (terms) {
      const tx = bank.length ? L.M + L.contentW / 2 : L.M;
      const tw = bank.length ? L.contentW / 2 : L.contentW;
      L.text('Terms & Conditions', tx, ty2, { size: 7.5, style: 'bold', color: accent });
      ty2 += 3.8;
      for (const l of L.wrap(terms, tw, 7.2)) { L.text(l, tx, ty2, { size: 7.2, color: MUTED }); ty2 += 3.3; }
    }
    L.y = Math.max(by, ty2) + 2;
  }
  // Signature.
  L.ensure(22);
  const sy = L.y + 4;
  L.text('For ' + (c.name || ''), L.W - L.M, sy, { size: 8.5, style: 'bold', align: 'right' });
  L.line(L.W - L.M - 50, sy + 13, L.W - L.M, sy + 13, 0.2, '#777777');
  L.text(c.signatory || 'Authorised Signatory', L.W - L.M, sy + 17, { size: 8, color: MUTED, align: 'right' });
  if (doc.kind === 'sale') L.text("Receiver's Signature", L.M, sy + 17, { size: 8, color: MUTED });
  L.y = sy + 20;
  if (c.footer) {
    L.ensure(8);
    L.y += 2;
    L.text(c.footer, L.W / 2, L.y + 3, { size: 8.5, style: 'bold', color: accent, align: 'center' });
    L.y += 6;
  }
  if (doc.gst) {
    L.text('Tax values are computed by BizBill from the rates entered; please verify before filing returns.', L.W / 2, L.y + 3, { size: 6, color: '#999999', align: 'center' });
    L.y += 5;
  }
  footer(L, settings);
  return L.finalize();
}

/** Format 4: narrow continuous receipt for 80mm thermal / POS printers. */
function renderThermalInvoice(L, doc, settings, extra = {}) {
  const { m, M, d, q } = fmt(settings);
  const b = settings.billing;
  const c = settings.company;
  const W = L.W;
  const cx = W / 2;
  const line = () => { L.y += 1.5; L.line(L.M, L.y, W - L.M, L.y, 0.2, '#000000'); L.y += 2.5; };
  const center = (text, size, style) => { L.text(text, cx, L.y, { size, style, align: 'center' }); L.y += size * 0.42 + 1.2; };

  L.y = L.M;
  center(c.name || 'Your Company Name', 11, 'bold');
  if (c.address) for (const l of L.wrap([c.address, c.city].filter(Boolean).join(', '), L.contentW, 7)) center(l, 7);
  if (c.mobile) center('Ph: ' + c.mobile, 7);
  if (c.gstin) center('GSTIN: ' + c.gstin, 7, 'bold');
  line();
  let title = TITLES[doc.kind] || 'INVOICE';
  if (doc.status === 'cancelled') title += ' (CANCELLED)';
  center(title, 9, 'bold');
  L.text(doc.number, L.M, L.y, { size: 8, style: 'bold' });
  L.text(d(doc.date), W - L.M, L.y, { size: 8, align: 'right' });
  L.y += 4;
  if (doc.party && doc.party.name) {
    L.text((doc.kind === 'purchase' ? 'Supplier: ' : 'Customer: ') + doc.party.name, L.M, L.y, { size: 8, style: 'bold' });
    L.y += 3.6;
    if (doc.party.mobile) { L.text('Mobile: ' + doc.party.mobile, L.M, L.y, { size: 7.5 }); L.y += 3.4; }
    if (doc.party.gstin) { L.text('GSTIN: ' + doc.party.gstin, L.M, L.y, { size: 7.5 }); L.y += 3.4; }
  }
  line();
  for (const it of doc.items) {
    const cell = it.calc;
    for (const l of L.wrap(it.name, L.contentW, 8, 'bold')) { L.text(l, L.M, L.y, { size: 8, style: 'bold' }); L.y += 3.6; }
    const qtyRate = `${q(it.qty)} ${it.unit || ''} x ${m(it.rate)}`;
    L.text(qtyRate, L.M, L.y, { size: 7.5, color: MUTED });
    L.text(m(cell.total), W - L.M, L.y, { size: 8, style: 'bold', align: 'right' });
    L.y += 3.8;
  }
  line();
  const T = doc.totals;
  const row = (k, v, bold) => { L.text(k, L.M, L.y, { size: 8, style: bold ? 'bold' : 'normal' }); L.text(v, W - L.M, L.y, { size: 8, style: bold ? 'bold' : 'normal', align: 'right' }); L.y += 4; };
  row('Sub Total', m(T.gross));
  if (T.discount) row('Discount', '- ' + m(T.discount));
  if (doc.gst) {
    if (T.cgst) row('CGST', m(T.cgst));
    if (T.sgst) row('SGST', m(T.sgst));
    if (T.igst) row('IGST', m(T.igst));
  }
  if (T.roundOff) row('Round Off', (T.roundOff > 0 ? '+ ' : '- ') + m(Math.abs(T.roundOff)));
  line();
  center('GRAND TOTAL', 9, 'bold');
  center(M(T.grandTotal), 15, 'bold');
  if (doc.kind !== 'quotation' && extra.paid != null && doc.status !== 'cancelled' && extra.due > 0) {
    L.y += 1;
    row('Paid', m(extra.paid));
    row('Balance Due', m(extra.due), true);
  }
  line();
  for (const l of L.wrap(amountInWords(T.grandTotal, b.currencyName, b.currencySubunit), L.contentW, 7)) center(l, 7);
  if (doc.notes) { L.y += 1; for (const l of L.wrap(doc.notes, L.contentW, 7)) center(l, 7); }
  L.y += 2;
  if (c.footer) center(c.footer, 8, 'bold');
  center('Generated with BizBill', 6);
  L.y += L.M;
  return L.finalize();
}

// -------------------------------------------------------------- receipt

export function renderReceipt(L, pay, settings, docs = []) {
  const { m, M, d } = fmt(settings);
  const b = settings.billing;
  const isIn = pay.direction === 'in';
  header(L, settings, isIn ? 'PAYMENT RECEIPT' : 'PAYMENT VOUCHER', pay.status === 'cancelled' ? 'CANCELLED' : '');
  const half = (L.contentW - 6) / 2;
  const yl = kvBlock(L, L.M, L.y + 2, half, [
    [isIn ? 'Receipt No.' : 'Voucher No.', pay.number],
    ['Date', d(pay.date)],
    [isIn ? 'Received From' : 'Paid To', pay.partyName],
  ], 9);
  const yr = kvBlock(L, L.M + half + 6, L.y + 2, half, [
    ['Method', pay.method],
    ['Reference', pay.reference],
  ], 9);
  L.y = Math.max(yl, yr) + 3;
  L.rect(L.M, L.y, L.contentW, 14, { fill: '#eef3f9' });
  L.text('Amount', L.M + 3, L.y + 5.5, { size: 8, color: MUTED });
  L.text(M(pay.amount), L.M + 3, L.y + 11, { size: 14, style: 'bold', color: ACCENT });
  L.y += 17;
  L.paragraph(amountInWords(pay.amount, b.currencyName, b.currencySubunit), L.M, L.contentW, { size: 9, style: 'bold' });
  L.y += 2;
  if (docs.length) {
    L.table([{ label: 'Against', w: 0 }, { label: 'Date', w: 26 }, { label: 'Bill Amount', w: 32, align: 'right' }, { label: 'Allocated', w: 32, align: 'right' }],
      docs.map((x) => [x.doc.number, d(x.doc.date), m(x.doc.totals.grandTotal), m(x.amount)]), { size: 8 });
    L.y += 2;
    const unalloc = pay.amount - docs.reduce((a, x) => a + x.amount, 0);
    if (unalloc > 0) L.paragraph('Unallocated / advance: ' + M(unalloc), L.M, L.contentW, { size: 8 });
  }
  if (pay.notes) L.paragraph('Notes: ' + pay.notes, L.M, L.contentW, { size: 8, color: MUTED });
  if (pay.status === 'cancelled') L.paragraph('This payment was cancelled' + (pay.cancelReason ? ': ' + pay.cancelReason : ''), L.M, L.contentW, { size: 9, style: 'bold', color: '#b00020' });
  L.ensure(24);
  const sy = L.y + 8;
  const c = settings.company;
  L.text('For ' + (c.name || ''), L.W - L.M, sy, { size: 8.5, style: 'bold', align: 'right' });
  L.line(L.W - L.M - 50, sy + 13, L.W - L.M, sy + 13, 0.2, '#777777');
  L.text(c.signatory || 'Authorised Signatory', L.W - L.M, sy + 17, { size: 8, color: MUTED, align: 'right' });
  L.y = sy + 20;
  footer(L, settings);
  return L.finalize();
}

// -------------------------------------------------------------- ledger

export function renderLedger(L, party, statement, settings, range) {
  const { m, d } = fmt(settings);
  header(L, settings, 'LEDGER STATEMENT', party.type === 'supplier' ? 'Supplier Account' : 'Customer Account');
  const y0 = partyBlock(L, L.M, L.y + 1, L.contentW / 2, party.type === 'supplier' ? 'SUPPLIER' : 'CUSTOMER', party);
  const period = range && range.from > '0000-01-01' ? `${d(range.from)} to ${d(range.to)}` : 'All transactions';
  kvBlock(L, L.M + L.contentW / 2 + 6, L.y + 1, L.contentW / 2 - 6, [['Period', period], ['Printed', d(new Date().toISOString().slice(0, 10))]]);
  L.y = Math.max(y0, L.y + 10) + 2;
  const dc = (v) => (v === 0 ? '0.00' : m(Math.abs(v)) + ' ' + (((v > 0) !== statement.isSupplier) ? 'Dr' : 'Cr'));
  const rows = [{ cells: ['', 'Opening Balance', '', '', dc(statement.opening)], style: 'bold' }];
  for (const r of statement.rows) rows.push([d(r.date), r.description, r.debit ? m(r.debit) : '', r.credit ? m(r.credit) : '', dc(r.balance)]);
  rows.push({ cells: ['', 'Total', m(statement.totalDebit), m(statement.totalCredit), ''], style: 'bold', fill: '#e5ecf5' });
  rows.push({ cells: ['', 'Closing Balance', '', '', dc(statement.closing)], style: 'bold', fill: '#e5ecf5' });
  L.table([{ label: 'Date', w: 22 }, { label: 'Particulars', w: 0 }, { label: 'Debit', w: 26, align: 'right' }, { label: 'Credit', w: 26, align: 'right' }, { label: 'Balance', w: 32, align: 'right' }], rows, { size: 8 });
  footer(L, settings);
  return L.finalize();
}

// -------------------------------------------------------------- report

export function cellText(value, type, settings) {
  const { m, d, q } = fmt(settings);
  if (value == null || value === '') return '';
  switch (type) {
    case 'money': return m(value);
    case 'qty': return q(value);
    case 'date': return d(value);
    case 'int': return String(value);
    default: return String(value);
  }
}

export function renderReport(L, title, rangeLabel, report, settings) {
  const { m } = fmt(settings);
  header(L, settings, title.toUpperCase(), rangeLabel);
  const cols = report.columns.map((c, i) => {
    const numeric = ['money', 'qty', 'int'].includes(c.type);
    return { label: c.label, w: i === 0 || c.type === 'text' ? 0 : c.type === 'date' ? 22 : numeric ? 24 : 20, align: numeric ? 'right' : 'left' };
  });
  const rows = report.rows.map((r) => ({
    cells: report.columns.map((c) => cellText(r[c.key], c.type, settings)),
    style: r.strong ? 'bold' : 'normal',
    fill: r.strong ? '#e5ecf5' : null,
  }));
  if (report.totals) {
    rows.push({ cells: report.columns.map((c, i) => (i === 0 ? 'Total' : report.totals[c.key] != null && c.type !== 'date' ? cellText(report.totals[c.key], c.type, settings) : '')), style: 'bold', fill: '#e5ecf5' });
  }
  if (!rows.length) rows.push({ cells: report.columns.map((c, i) => (i === 0 ? 'No records for this period' : '')) });
  L.table(cols, rows, { size: report.columns.length > 7 ? 7 : 8 });
  if (report.summary && report.summary.length) {
    L.y += 3;
    L.table([{ label: 'Summary', w: 0 }, { label: 'Amount', w: 34, align: 'right' }], report.summary.map(([k, v]) => [k, m(v)]), { size: 8, headFill: '#5b7fa6', width: 100 });
  }
  if (report.note) { L.y += 3; L.paragraph(report.note, L.M, L.contentW, { size: 7.5, color: MUTED }); }
  footer(L, settings);
  return L.finalize();
}


// -------------------------------------------------------------- reminder card

/**
 * Shareable payment reminder card. Every value comes from live data:
 * {amount (outstanding), dueDate, partyName, invoiceNo, overdueDays}
 */
export function renderReminderCard(L, r, settings) {
  const { M, d } = fmt(settings);
  const c = settings.company;
  const W = L.W;
  const overdue = r.overdueDays > 0;
  const band = overdue ? '#b3261e' : ACCENT;
  L.rect(0, 0, W, 34, { fill: band });
  L.text(overdue ? 'PAYMENT OVERDUE' : 'PAYMENT REMINDER', W / 2, 13, { size: 11, style: 'bold', color: '#ffffff', align: 'center' });
  L.text('Payment Reminder For', W / 2, 21, { size: 8, color: '#dce6f2', align: 'center' });
  L.text(M(r.amount), W / 2, 30, { size: 20, style: 'bold', color: '#ffffff', align: 'center' });
  let y = 46;
  const row = (k, v) => {
    if (!v) return;
    L.text(k, 10, y, { size: 8, color: MUTED });
    L.text(v, W - 10, y, { size: 9.5, style: 'bold', align: 'right' });
    y += 4;
    L.line(10, y, W - 10, y, 0.15, '#dddddd');
    y += 6;
  };
  row('Due Date', r.dueDate ? d(r.dueDate) + (overdue ? `  (${r.overdueDays} days overdue)` : '') : '');
  row('Customer / Party', r.partyName);
  row('Invoice', r.invoiceNo);
  if (r.total && r.total !== r.amount) row('Invoice amount', M(r.total));
  if (c.upiId) row('Pay via UPI', c.upiId);
  y += 2;
  const footTop = Math.max(y, L.H - 30);
  L.rect(0, footTop, W, L.H - footTop, { fill: '#f1f4f8' });
  let x = 10;
  if (c.logo) {
    let w = 16; let hgt = 16;
    if (c.logoW && c.logoH) { const k = Math.min(16 / c.logoW, 16 / c.logoH); w = c.logoW * k; hgt = c.logoH * k; }
    L.image(c.logo, x, footTop + 6, w, hgt);
    x += w + 4;
  }
  L.text('Sent by', x, footTop + 9, { size: 7, color: MUTED });
  L.text(c.name || '', x, footTop + 14.5, { size: 10, style: 'bold', color: ACCENT });
  if (c.mobile) L.text('Mobile: ' + c.mobile, x, footTop + 19.5, { size: 8 });
  L.y = L.H;
  return L;
}
