import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDocument, computeLine, isInterState } from '../www/js/core/calc.js';
import {
  mulDivRound, parseDecimal, toPaise, toQty, formatMoney, amountInWords, roundToRupee, formatQty, paiseToInput,
} from '../www/js/core/money.js';

const intra = { inclusive: false, gst: true, interState: false };

test('mulDivRound rounds half away from zero', () => {
  assert.equal(mulDivRound(5, 1, 10), 1);
  assert.equal(mulDivRound(4, 1, 10), 0);
  assert.equal(mulDivRound(-5, 1, 10), -1);
  assert.equal(mulDivRound(15, 1, 10), 2);
  assert.equal(mulDivRound(25, 1, 10), 3);
  // Huge values do not overflow.
  assert.equal(mulDivRound(9_000_000_000, 9_000_000_000, 1_000_000_000_000), 81_000_000);
});

test('parseDecimal avoids floating point', () => {
  assert.equal(parseDecimal('0.1', 2) + parseDecimal('0.2', 2), 30);
  assert.equal(parseDecimal('1,234.56', 2), 123456);
  assert.equal(parseDecimal('₹ 99.995', 2), 10000);
  assert.equal(parseDecimal('-12.5', 2), -1250);
  assert.ok(Number.isNaN(parseDecimal('abc', 2)));
  assert.ok(Number.isNaN(parseDecimal('1.2.3', 2)));
  assert.equal(toPaise(19.99), 1999);
  assert.equal(toQty('1.5'), 1500);
  assert.equal(paiseToInput(123450), '1234.50');
});

test('money formatting (Indian grouping) and words', () => {
  assert.equal(formatMoney(12345678900), '₹12,34,56,789.00');
  assert.equal(formatMoney(-5050), '-₹50.50');
  assert.equal(formatMoney(100000, { grouping: 'intl', symbol: '$' }), '$1,000.00');
  assert.equal(amountInWords(12345650), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
  assert.equal(amountInWords(100), 'Rupees One Only');
  assert.equal(formatQty(1500, 2), '1.5');
  assert.equal(formatQty(1234, 2), '1.23');
});

test('exclusive GST line: 2 x 500 less 10%, 18% intra-state', () => {
  const l = computeLine({ qty: 2000, rate: 50000, discType: 'pct', disc: 1000, gstBp: 1800 }, intra);
  assert.deepEqual(
    { gross: l.gross, discount: l.discount, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total },
    { gross: 100000, discount: 10000, taxable: 90000, cgst: 8100, sgst: 8100, igst: 0, total: 106200 },
  );
});

test('inclusive GST line: 1180 incl. 18% = 1000 + 180', () => {
  const l = computeLine({ qty: 1000, rate: 118000, gstBp: 1800 }, { ...intra, inclusive: true });
  assert.equal(l.taxable, 100000);
  assert.equal(l.cgst, 9000);
  assert.equal(l.sgst, 9000);
  assert.equal(l.total, 118000);
  assert.equal(l.gross - l.discount, l.taxable);
});

test('inclusive line with odd paise keeps total exact', () => {
  const l = computeLine({ qty: 3000, rate: 9999, discType: 'amt', disc: 1, gstBp: 1200 }, { ...intra, inclusive: true });
  assert.equal(l.total, 3 * 9999 - 1);
  assert.equal(l.taxable + l.cgst + l.sgst, l.total);
  assert.equal(l.gross - l.discount, l.taxable);
});

test('inter-state IGST and round off', () => {
  const r = computeDocument({ items: [{ qty: 3000, rate: 9999, gstBp: 1200 }], interState: true, roundOff: true });
  assert.equal(r.totals.taxable, 29997);
  assert.equal(r.totals.igst, 3600); // 3599.64 -> 3600
  assert.equal(r.totals.cgst + r.totals.sgst, 0);
  assert.equal(r.totals.beforeRound, 33597);
  assert.equal(r.totals.roundOff, 3);
  assert.equal(r.totals.grandTotal, 33600);
});

test('fractional quantity rounds half up to paise', () => {
  const l = computeLine({ qty: 1500, rate: 3333, gstBp: 0 }, intra);
  assert.equal(l.gross, 5000); // 49.995 -> 50.00
});

test('discount can never exceed line value', () => {
  const l = computeLine({ qty: 1000, rate: 1000, discType: 'amt', disc: 5000, gstBp: 1800 }, intra);
  assert.equal(l.discount, 1000);
  assert.equal(l.taxable, 0);
  assert.equal(l.total, 0);
});

test('GST disabled means no tax regardless of rates', () => {
  const r = computeDocument({ gst: false, items: [{ qty: 1000, rate: 10000, gstBp: 1800 }], packaging: 500, chargesGstBp: 1800 });
  assert.equal(r.totals.tax, 0);
  assert.equal(r.totals.grandTotal, 10500);
});

test('document invariants hold for a complex invoice', () => {
  const doc = {
    items: [
      { qty: 2500, rate: 12345, discType: 'pct', disc: 750, gstBp: 1800, hsn: '8471' },
      { qty: 1000, rate: 99999, discType: 'amt', disc: 999, gstBp: 1200, hsn: '8528' },
      { qty: 7000, rate: 1, gstBp: 500, hsn: '0401' },
      { qty: 1000, rate: 50000, gstBp: 0 },
    ],
    packaging: 15000,
    otherCharges: 2550,
    chargesGstBp: 1800,
    roundOff: true,
  };
  for (const inclusive of [false, true]) {
    for (const interState of [false, true]) {
      const { lines, totals: t } = computeDocument({ ...doc, inclusive, interState });
      for (const l of lines) {
        assert.equal(l.gross - l.discount, l.taxable);
        assert.equal(l.taxable + l.cgst + l.sgst + l.igst, l.total);
        if (!interState) assert.equal(l.igst, 0);
        else assert.equal(l.cgst + l.sgst, 0);
      }
      assert.equal(t.gross - t.discount, t.itemsTaxable);
      assert.equal(t.itemsTaxable + t.chargesTaxable, t.taxable);
      assert.equal(t.taxable + t.tax, t.beforeRound);
      assert.equal(t.cgst + t.sgst + t.igst, t.tax);
      assert.equal(t.beforeRound + t.roundOff, t.grandTotal);
      assert.equal(t.grandTotal % 100, 0);
      assert.ok(Math.abs(t.roundOff) <= 50);
      const bt = t.taxBreakup.reduce((a, r) => a + r.taxable, 0);
      assert.equal(bt, t.taxable);
      if (inclusive) assert.equal(t.chargesTaxable + t.chargesTax, 17550);
    }
  }
});

test('intra-state CGST equals SGST (each at half rate)', () => {
  const l = computeLine({ qty: 1000, rate: 1001, gstBp: 500 }, intra);
  // 10.01 x 2.5% = 0.25025 -> 0.25 each
  assert.equal(l.cgst, 25);
  assert.equal(l.sgst, 25);
});

test('isInterState compares state codes', () => {
  assert.equal(isInterState('27', '27'), false);
  assert.equal(isInterState('27', '29'), true);
  assert.equal(isInterState('7', '07'), false);
  assert.equal(isInterState('', '29'), false);
});

test('roundToRupee', () => {
  assert.deepEqual(roundToRupee(10049), { rounded: 10000, roundOff: -49 });
  assert.deepEqual(roundToRupee(10050), { rounded: 10100, roundOff: 50 });
});
