// The single billing calculation engine. Sales invoices, purchases and
// quotations all go through computeDocument() so there is exactly one
// implementation of discount / GST / charges / round-off logic.
//
// Units: money in paise, qty in milli-units, rates (GST %, discount %) in
// basis points. See money.js.
//
// Invariants guaranteed for every result (tested in tests/calc.test.mjs):
//   line:  gross - discount = taxable;  taxable + cgst + sgst + igst = total
//   doc:   gross - discount = itemsTaxable
//          itemsTaxable + chargesTaxable = taxable
//          taxable + tax = beforeRound
//          beforeRound + roundOff = grandTotal

import { mulDivRound, qtyTimesRate, applyBp, roundToRupee, divRound } from './money.js';

/**
 * Split a tax amount computed on `taxable` at `bp` into CGST/SGST or IGST.
 * For intra-state supply each half is computed at half the rate and rounded
 * separately (common invoicing practice), so CGST always equals SGST.
 */
function splitTax(taxable, bp, interState) {
  if (!bp) return { cgst: 0, sgst: 0, igst: 0 };
  if (interState) return { cgst: 0, sgst: 0, igst: applyBp(taxable, bp) };
  const half = mulDivRound(taxable, bp, 20000);
  return { cgst: half, sgst: half, igst: 0 };
}

/** Split an already-known inclusive tax so that parts add up exactly. */
function splitKnownTax(tax, interState) {
  if (interState) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = divRound(tax, 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

/**
 * Compute a single line.
 * item: {qty, rate, discType: 'pct'|'amt', disc, gstBp}
 * ctx:  {inclusive, gst (bool), interState}
 */
export function computeLine(item, ctx) {
  const qty = Math.trunc(item.qty || 0);
  const rate = Math.trunc(item.rate || 0);
  const bp = ctx.gst ? Math.max(0, Math.trunc(item.gstBp || 0)) : 0;
  const grossEntered = qtyTimesRate(qty, rate);
  let discEntered = 0;
  if (item.discType === 'amt') {
    discEntered = Math.trunc(item.disc || 0);
  } else if (item.disc) {
    discEntered = applyBp(grossEntered, Math.trunc(item.disc));
  }
  // A discount can never exceed the line value (or flip its sign).
  if (grossEntered >= 0) discEntered = Math.min(Math.max(discEntered, 0), grossEntered);
  else discEntered = 0;
  const netEntered = grossEntered - discEntered;

  let gross, discount, taxable, parts;
  if (ctx.inclusive && bp) {
    taxable = mulDivRound(netEntered, 10000, 10000 + bp);
    gross = mulDivRound(grossEntered, 10000, 10000 + bp);
    discount = gross - taxable;
    parts = splitKnownTax(netEntered - taxable, ctx.interState);
  } else {
    gross = grossEntered;
    discount = discEntered;
    taxable = netEntered;
    parts = splitTax(taxable, bp, ctx.interState);
  }
  const tax = parts.cgst + parts.sgst + parts.igst;
  return {
    gross,
    discount,
    taxable,
    cgst: parts.cgst,
    sgst: parts.sgst,
    igst: parts.igst,
    tax,
    total: taxable + tax,
    gstBp: bp,
  };
}

/**
 * Compute a whole document.
 * doc: {
 *   items: [...],
 *   inclusive: bool, gst: bool, interState: bool,
 *   packaging: paise, otherCharges: paise, chargesGstBp: bp,
 *   roundOff: bool
 * }
 */
export function computeDocument(doc) {
  const ctx = { inclusive: !!doc.inclusive, gst: doc.gst !== false, interState: !!doc.interState };
  const lines = (doc.items || []).map((it) => computeLine(it, ctx));
  const t = {
    gross: 0, discount: 0, itemsTaxable: 0,
    cgst: 0, sgst: 0, igst: 0,
    chargesEntered: 0, chargesTaxable: 0, chargesTax: 0,
  };
  const byRate = new Map();
  lines.forEach((l, i) => {
    t.gross += l.gross;
    t.discount += l.discount;
    t.itemsTaxable += l.taxable;
    t.cgst += l.cgst;
    t.sgst += l.sgst;
    t.igst += l.igst;
    const hsn = (doc.items[i] && doc.items[i].hsn) || '';
    const key = hsn + '|' + l.gstBp;
    const r = byRate.get(key) || { hsn, gstBp: l.gstBp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst;
    byRate.set(key, r);
  });

  // Packaging / other charges. They follow the document's price mode and
  // are taxed at chargesGstBp (0 by default; configurable per document).
  const chargesEntered = Math.trunc(doc.packaging || 0) + Math.trunc(doc.otherCharges || 0);
  const cbp = ctx.gst ? Math.max(0, Math.trunc(doc.chargesGstBp || 0)) : 0;
  let cTaxable = chargesEntered;
  let cParts = { cgst: 0, sgst: 0, igst: 0 };
  if (chargesEntered && cbp) {
    if (ctx.inclusive) {
      cTaxable = mulDivRound(chargesEntered, 10000, 10000 + cbp);
      cParts = splitKnownTax(chargesEntered - cTaxable, ctx.interState);
    } else {
      cParts = splitTax(chargesEntered, cbp, ctx.interState);
    }
  }
  t.chargesEntered = chargesEntered;
  t.chargesTaxable = cTaxable;
  t.chargesTax = cParts.cgst + cParts.sgst + cParts.igst;
  t.cgst += cParts.cgst;
  t.sgst += cParts.sgst;
  t.igst += cParts.igst;
  if (chargesEntered && cbp) {
    const key = 'charges|' + cbp;
    const r = byRate.get(key) || { hsn: 'Charges', gstBp: cbp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += cTaxable; r.cgst += cParts.cgst; r.sgst += cParts.sgst; r.igst += cParts.igst;
    byRate.set(key, r);
  }

  t.taxable = t.itemsTaxable + t.chargesTaxable;
  t.tax = t.cgst + t.sgst + t.igst;
  t.beforeRound = t.taxable + t.tax;
  if (doc.roundOff) {
    const r = roundToRupee(t.beforeRound);
    t.roundOff = r.roundOff;
    t.grandTotal = r.rounded;
  } else {
    t.roundOff = 0;
    t.grandTotal = t.beforeRound;
  }
  t.taxBreakup = [...byRate.values()].filter((r) => r.taxable || r.cgst || r.igst);
  return { lines, totals: t };
}

/** Is the supply inter-state? Unknown codes default to intra-state. */
export function isInterState(companyStateCode, placeOfSupplyCode) {
  const a = String(companyStateCode || '').padStart(2, '0');
  const b = String(placeOfSupplyCode || '').padStart(2, '0');
  if (a === '00' || b === '00') return false;
  return a !== b;
}
