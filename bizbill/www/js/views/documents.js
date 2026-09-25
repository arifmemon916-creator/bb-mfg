// Sales invoices, purchases and quotations: list, form and detail view.
// All three use the same form and the same calculation engine.

import { h, icon, clear, debounce, put } from '../ui/dom.js';
import {
  field, textInput, moneyInput, qtyInput, dateInput, selectInput, textArea, readMoney, readQty, readPct,
  pickerDialog, confirmDialog, promptDialog, chooseDialog, toast, errorToast, lazyList, emptyState, statusBadge,
  rangeChips, kv, openSheet, productThumb,
} from '../ui/components.js';
import { fmt, remember, rangeState, rangeOf, rangeLabel } from './common.js';
import { DOC_KINDS, PAYMENT_METHODS, UNITS, REMINDER_OFFSETS } from '../core/settings.js';
import { GST_RATES } from '../core/validate.js';
import { STATES, stateName } from '../core/states.js';
import { pctToBp, bpToPct, mulDivRound, paiseToInput, sum } from '../core/money.js';
import { today, addDays, inRange } from '../core/dates.js';
import { matches } from '../core/search.js';
import { toCSV } from '../core/csv.js';
import { invoiceSpec, shareMenu, runDocAction, previewPdf, reminderCardSpec } from '../docs/actions.js';
import { saveFile } from '../platform/bridge.js';

const LIST_META = {
  sale: { title: 'Sales', newLabel: 'Invoice', icon: 'sales', partyLabel: 'Customer' },
  purchase: { title: 'Purchases', newLabel: 'Purchase', icon: 'purchase', partyLabel: 'Supplier' },
  quotation: { title: 'Quotations', newLabel: 'Quotation', icon: 'quote', partyLabel: 'Customer' },
};

export const saleList = (ctx, p, q) => docList(ctx, 'sale', q);
export const purchaseList = (ctx, p, q) => docList(ctx, 'purchase', q);
export const quotationList = (ctx, p, q) => docList(ctx, 'quotation', q);

// ------------------------------------------------------------------ list

function docList({ store, app }, kind, query) {
  const f = fmt(store);
  const meta = LIST_META[kind];
  const state = remember('doclist:' + kind, () => ({ q: '', status: 'all', partyId: '', productId: '', min: '', max: '' }));
  if (query.party) state.partyId = query.party;
  if (query.status) state.status = query.status;
  const range = rangeState('doclist:' + kind, 'month');
  const body = h('div');
  const listHost = h('div');
  const summary = h('div', { class: 'small muted', style: { margin: '0 2px 8px' } });

  const statuses = kind === 'quotation'
    ? [['all', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['converted', 'Converted']]
    : [['all', 'All'], ['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid'], ['cancelled', 'Cancelled']];

  const filtered = () => {
    const r = rangeOf(range);
    const min = state.min ? Math.round(parseFloat(state.min) * 100) : null;
    const max = state.max ? Math.round(parseFloat(state.max) * 100) : null;
    return store.listDocuments(kind).filter((d) => {
      if (!inRange(d.date, r)) return false;
      if (state.partyId && d.partyId !== state.partyId) return false;
      if (state.productId && !d.items.some((it) => it.productId === state.productId)) return false;
      if (min != null && d.totals.grandTotal < min) return false;
      if (max != null && d.totals.grandTotal > max) return false;
      if (state.status !== 'all' && store.docStatus(d) !== state.status) return false;
      return matches(state.q, d.number, d.party.name, d.party.mobile, d.party.gstin, d.refNo, d.items.map((i) => i.name).join(' '));
    });
  };

  const draw = () => {
    const docs = filtered();
    const total = sum(docs.filter((d) => d.status !== 'cancelled'), (d) => d.totals.grandTotal);
    const due = kind === 'quotation' ? 0 : sum(docs, (d) => store.docDue(d));
    summary.textContent = `${docs.length} record(s) · ${f.money(total)}${kind !== 'quotation' ? ' · Due ' + f.money(due) : ''} · ${rangeLabel(store, range)}`;
    clear(listHost);
    listHost.appendChild(docs.length ? lazyList(docs, (d) => {
      const st = store.docStatus(d);
      const dueAmt = store.docDue(d);
      return h('a', { class: 'item', href: '#/doc/' + d.id },
        h('div', { class: 'main' },
          h('div', { class: 'title' }, d.party.name || 'Walk-in'),
          h('div', { class: 'subtitle' }, `${d.number} · ${f.date(d.date)}${d.refNo ? ' · Bill ' + d.refNo : ''}`)),
        h('div', { class: 'end' },
          h('div', { class: 'amount' }, f.money(d.totals.grandTotal)),
          st === 'partial' ? h('div', { class: 'small neg' }, 'Due ' + f.money(dueAmt)) : statusBadge(st)));
    }) : emptyState(meta.icon, state.q || state.status !== 'all' || state.partyId ? 'No matching records' : `No ${meta.title.toLowerCase()} in this period`,
      h('a', { class: 'btn primary', href: '#/doc/new/' + kind }, icon('plus'), 'New ' + meta.newLabel)));
  };

  const search = h('input', { type: 'search', placeholder: 'Search number, party, item…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) });
  const statusChips = h('div', { class: 'chips' });
  const paintStatus = () => {
    clear(statusChips);
    for (const [v, l] of statuses) statusChips.appendChild(h('button', { class: 'chip' + (state.status === v ? ' active' : ''), onclick: () => { state.status = v; paintStatus(); draw(); } }, l));
  };
  paintStatus();
  const filterBtn = h('button', { class: 'icon-btn', 'aria-label': 'Filters', onclick: async () => { if (await filterDialog(store, kind, state)) { paintFilterNote(); draw(); } } }, icon('filter'));
  const filterNote = h('div');
  const paintFilterNote = () => {
    clear(filterNote);
    const bits = [];
    if (state.partyId) bits.push(meta.partyLabel + ': ' + (store.parties.get(state.partyId)?.name || '?'));
    if (state.productId) bits.push('Product: ' + (store.products.get(state.productId)?.name || '?'));
    if (state.min || state.max) bits.push(`Amount ${state.min || 0} – ${state.max || '∞'}`);
    if (bits.length) {
      filterNote.appendChild(h('div', { class: 'note', style: { marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { flex: 1 } }, bits.join(' · ')),
        h('button', { class: 'btn small', onclick: () => { Object.assign(state, { partyId: '', productId: '', min: '', max: '' }); paintFilterNote(); draw(); } }, 'Clear')));
    }
  };
  paintFilterNote();

  put(body, 
    h('div', { class: 'searchbar' }, icon('search'), search, filterBtn),
    rangeChips(range, () => draw()),
    statusChips, filterNote, summary, listHost);
  draw();

  return {
    title: meta.title,
    content: body,
    actions: [{ icon: 'download', label: 'Export CSV', onClick: () => exportDocs(store, kind, filtered()) }],
    fab: { href: '#/doc/new/' + kind, icon: 'plus', text: meta.newLabel, label: 'New ' + meta.newLabel },
    nav: true,
  };
}

async function filterDialog(store, kind, state) {
  const partyType = DOC_KINDS[kind].party;
  const parties = store.listParties(partyType);
  const products = store.listProducts();
  return openSheet((api) => {
    const party = selectInput('party', [['', 'All'], ...parties.map((p) => [p.id, p.name])], state.partyId);
    const product = selectInput('product', [['', 'All'], ...products.map((p) => [p.id, p.name])], state.productId);
    const min = h('input', { type: 'text', inputmode: 'decimal', value: state.min, placeholder: 'Min' });
    const max = h('input', { type: 'text', inputmode: 'decimal', value: state.max, placeholder: 'Max' });
    return h('div', null, h('h2', null, 'Filters'),
      h('div', { class: 'form' },
        field(partyType === 'customer' ? 'Customer' : 'Supplier', party),
        field('Product', product),
        h('div', { class: 'row' }, field('Amount from', min), field('Amount to', max))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => api.close(false) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { Object.assign(state, { partyId: party.value, productId: product.value, min: min.value.trim(), max: max.value.trim() }); api.close(true); } }, 'Apply')));
  });
}

async function exportDocs(store, kind, docs) {
  const f = fmt(store);
  const rows = docs.map((d) => [d.number, d.date, d.party.name, d.party.gstin, paiseToInput(d.totals.taxable), paiseToInput(d.totals.cgst), paiseToInput(d.totals.sgst), paiseToInput(d.totals.igst), paiseToInput(d.totals.grandTotal), kind === 'quotation' ? '' : paiseToInput(store.docDue(d)), store.docStatus(d)]);
  const csv = toCSV(['Number', 'Date', 'Party', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total', 'Due', 'Status'], rows);
  await saveFile(new Blob([csv], { type: 'text/csv' }), `${LIST_META[kind].title}_${today()}.csv`);
  void f;
}

// ------------------------------------------------------------------ form

export function docForm({ store, app }, params, query) {
  const f = fmt(store);
  const s = store.settings;
  const b = s.billing;
  const existing = params.id ? store.documents.get(params.id) : null;
  if (params.id && !existing) throw new Error('Document not found');
  if (existing && existing.status === 'cancelled') throw new Error('Cancelled documents cannot be edited');
  const kind = existing ? existing.kind : params.kind;
  if (!DOC_KINDS[kind]) throw new Error('Unknown document type');
  const meta = LIST_META[kind];
  const partyType = DOC_KINDS[kind].party;

  // Initial draft: existing doc, quotation conversion, duplicate, or new.
  let draft;
  let fromQuotationId = '';
  if (existing) {
    draft = structuredClone(existing);
  } else if (query.from) {
    draft = store.quotationToInvoiceDraft(query.from);
    fromQuotationId = query.from;
  } else if (query.copy && store.documents.get(query.copy)) {
    const src = store.documents.get(query.copy);
    draft = structuredClone(src);
    delete draft.id; delete draft.number; delete draft.status; delete draft.createdAt; delete draft.qStatus; delete draft.convertedTo; delete draft.sourceId; delete draft.cancelReason;
    draft.kind = kind;
    draft.date = today();
    draft.items = draft.items.map(({ calc, cost, ...it }) => it);
  } else {
    draft = {
      kind, date: today(), items: [], inclusive: b.inclusive, gst: b.gstEnabled, roundOff: b.roundOff,
      chargesGstBp: pctToBp(b.chargesGst), paymentMethod: b.defaultPaymentMethod, terms: s.company.terms,
      transport: {}, party: {},
    };
    if (kind === 'sale' && b.dueDays) draft.dueDate = addDays(today(), b.dueDays);
    if (query.party && store.parties.get(query.party)) {
      const p = store.parties.get(query.party);
      draft.partyId = p.id;
      draft.party = { name: p.name, mobile: p.mobile, gstin: p.gstin, address: p.address, city: p.city, state: p.state, stateCode: p.stateCode };
    }
  }
  draft.party = draft.party || {};
  draft.transport = draft.transport || {};
  let dirty = false;
  const markDirty = () => { dirty = true; };

  // ---- party section
  const partyBox = h('div');
  const partyFields = {
    mobile: textInput('mobile', draft.party.mobile, { type: 'tel', inputmode: 'tel' }),
    gstin: textInput('gstin', draft.party.gstin, { style: { textTransform: 'uppercase' }, maxlength: 15 }),
    address: textArea('address', draft.party.address, { rows: 2 }),
    stateCode: selectInput('stateCode', [['', 'Select state'], ...STATES.map(([c, n]) => [c, `${n} (${c})`])], draft.party.stateCode),
    walkin: textInput('walkin', draft.partyId ? '' : draft.party.name, { placeholder: 'Walk-in customer name' }),
  };
  const posSelect = selectInput('pos', [['', 'Same as party state'], ...STATES.map(([c, n]) => [c, `${n} (${c})`])], existing ? existing.placeOfSupply : draft.placeOfSupply || '');

  const choosePartyFn = async () => {
    const list = store.listParties(partyType);
    const picked = await pickerDialog({
      title: 'Select ' + (partyType === 'customer' ? 'customer' : 'supplier'),
      items: list,
      label: (p) => p.name,
      sub: (p) => [p.mobile, p.gstin, p.city].filter(Boolean).join(' · '),
      end: (p) => { const bal = store.account(p.id).balance; return bal ? f.money(bal) : ''; },
      search: (p) => [p.name, p.mobile, p.gstin, p.city].join(' '),
      createLabel: 'Create new ' + partyType,
      onCreate: (name) => quickCreateParty(store, partyType, name),
    });
    if (!picked) return;
    draft.partyId = picked.id;
    draft.party = { name: picked.name, mobile: picked.mobile, gstin: picked.gstin, address: picked.address, city: picked.city, state: picked.state, stateCode: picked.stateCode };
    partyFields.mobile.value = picked.mobile || '';
    partyFields.gstin.value = picked.gstin || '';
    partyFields.address.value = picked.address || '';
    partyFields.stateCode.value = picked.stateCode || '';
    posSelect.value = '';
    markDirty();
    paintParty();
    recalc();
  };

  const paintParty = () => {
    clear(partyBox);
    if (draft.partyId) {
      const p = store.parties.get(draft.partyId);
      const bal = p ? store.account(p.id).balance : 0;
      const limit = p && p.creditLimit;
      put(partyBox, h('div', { class: 'item', style: { padding: '8px 0', borderBottom: 0 } },
        h('div', { class: 'avatar' }, icon(partyType === 'customer' ? 'users' : 'truck')),
        h('div', { class: 'main' }, h('div', { class: 'title' }, draft.party.name),
          h('div', { class: 'subtitle' }, [draft.party.mobile, draft.party.gstin, bal ? 'Balance ' + f.money(bal) : ''].filter(Boolean).join(' · '))),
        h('button', { class: 'btn small', type: 'button', onclick: choosePartyFn }, 'Change')));
      if (limit && bal > limit) put(partyBox, h('div', { class: 'note warn' }, `Credit limit ${f.money(limit)} exceeded (balance ${f.money(bal)}).`));
    } else {
      put(partyBox, h('button', { class: 'btn primary block', type: 'button', onclick: choosePartyFn }, icon('users'), 'Select ' + (partyType === 'customer' ? 'customer' : 'supplier')));
      if (kind !== 'purchase') put(partyBox, h('div', { style: { marginTop: '8px' } }, field('or Walk-in / cash customer', partyFields.walkin, { hint: 'Walk-in sales must be fully paid' })));
    }
  };
  paintParty();

  // ---- header fields
  const numberInput = textInput('number', draft.number || store.peekNumber(kind), { required: true });
  const dateIn = dateInput('date', draft.date);
  const dueIn = dateInput('dueDate', draft.dueDate || '');
  const refIn = textInput('refNo', draft.refNo || '', { placeholder: 'Supplier invoice no.' });
  const validIn = dateInput('validUntil', draft.validUntil || '');
  // Payment reminders (per document; default from notification settings).
  let reminders = draft.reminders ? [...draft.reminders.offsets] : null;
  const remBox = h('div');
  const paintRem = () => {
    clear(remBox);
    if (kind === 'quotation' || !dueIn.value) { put(remBox, h('div', { class: 'small muted' }, kind === 'quotation' ? '' : 'Set a due date to schedule payment reminders.')); return; }
    const active = new Set(reminders || s.notifications.reminderOffsets || []);
    const opts = [...new Set([...REMINDER_OFFSETS.map(([d]) => d), ...active])].sort((a, b) => a - b);
    put(remBox, h('div', { class: 'small', style: { fontWeight: 600, color: 'var(--text-2)' } }, 'Payment reminders' + (reminders ? '' : ' (default)')),
      h('div', { class: 'chips', style: { flexWrap: 'wrap' } }, opts.map((d) => h('button', { type: 'button', class: 'chip' + (active.has(d) ? ' active' : ''), onclick: () => {
        const next = new Set(active);
        if (next.has(d)) next.delete(d); else next.add(d);
        reminders = [...next].sort((a, b) => a - b);
        markDirty(); paintRem();
      } }, d === 0 ? 'On due date' : `${d} day${d > 1 ? 's' : ''} before`)),
      h('button', { type: 'button', class: 'chip', onclick: async () => {
        const v = await promptDialog({ title: 'Custom reminder', label: 'Days before due date (1–60)', type: 'number' });
        const d = parseInt(v, 10);
        if (!(d >= 1 && d <= 60)) return;
        reminders = [...new Set([...active, d])].sort((a, b) => a - b);
        markDirty(); paintRem();
      } }, '+ Custom')),
      !s.notifications.enabled ? h('div', { class: 'small muted' }, 'Turn on notifications in Settings to receive reminders.') : null);
  };
  dueIn.addEventListener('change', paintRem);

  // ---- items
  const itemsHost = h('div', { class: 'stack' });
  const lines = []; // {el, inputs, item, calcEl}
  const gstOptions = GST_RATES.map((r) => [String(pctToBp(r)), r + '%']);

  const addLine = (item) => {
    const it = { productId: '', name: '', sku: '', hsn: '', unit: b.defaultUnit, qty: 1000, rate: 0, discType: 'pct', disc: 0, gstBp: pctToBp(b.defaultGst), description: '', ...item };
    const inputs = {
      name: textInput('name', it.name, { placeholder: 'Item name', 'aria-label': 'Item name' }),
      qty: qtyInput('qty', it.qty, { 'aria-label': 'Quantity' }),
      unit: selectInput('unit', [...new Set([it.unit, ...UNITS])], it.unit, { 'aria-label': 'Unit' }),
      rate: moneyInput('rate', it.rate, { 'aria-label': 'Rate' }),
      discType: selectInput('discType', [['pct', '%'], ['amt', f.money(0).replace(/[\d.,]/g, '') || 'Amt']], it.discType, { 'aria-label': 'Discount type' }),
      disc: h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: it.disc ? (it.discType === 'pct' ? bpToPct(it.disc) : paiseToInput(it.disc)) : '', placeholder: '0', 'aria-label': 'Discount' }),
      gst: selectInput('gst', gstOptions.some(([v]) => v === String(it.gstBp)) ? gstOptions : [[String(it.gstBp), bpToPct(it.gstBp) + '%'], ...gstOptions], String(it.gstBp), { 'aria-label': 'GST rate' }),
      hsn: textInput('hsn', it.hsn, { inputmode: 'numeric', placeholder: 'HSN/SAC', 'aria-label': 'HSN/SAC' }),
    };
    const calcEl = h('div', { class: 'line-foot' });
    const stockEl = h('span', { class: 'small muted' });
    const line = { inputs, item: it, calcEl };
    const removeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove item', onclick: () => {
      const i = lines.indexOf(line);
      if (i >= 0) lines.splice(i, 1);
      el.remove();
      markDirty();
      recalc();
    } }, icon('trash'));
    const el = h('div', { class: 'line' },
      h('div', { class: 'line-head' }, h('div', { class: 'title' }, inputs.name), removeBtn),
      h('div', { class: 'row three' }, field('Qty', inputs.qty), field('Unit', inputs.unit), field('Rate', inputs.rate)),
      h('div', { class: 'row three' },
        field('Discount', h('div', { class: 'disc-wrap' }, inputs.discType, inputs.disc)),
        b.gstEnabled || draft.gst ? field('GST', inputs.gst) : h('div'),
        field('HSN/SAC', inputs.hsn)),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } }, stockEl, calcEl));
    if (it.productId) {
      const prod = store.products.get(it.productId);
      if (prod && prod.trackStock) stockEl.textContent = `In stock: ${f.qty(store.stockOf(prod.id).current)} ${prod.unit || ''}`;
    }
    for (const inp of Object.values(inputs)) {
      inp.addEventListener('input', () => { markDirty(); recalcSoon(); });
      inp.addEventListener('change', () => { markDirty(); recalcSoon(); });
    }
    line.el = el;
    lines.push(line);
    itemsHost.appendChild(el);
    return line;
  };

  const productRate = (prod, inclusive) => {
    if (kind === 'purchase') {
      const r = prod.purchasePrice || 0;
      return inclusive ? mulDivRound(r, 10000 + (prod.gstBp || 0), 10000) : r;
    }
    const r = prod.salePrice || 0;
    if (!!prod.saleInclusive === !!inclusive) return r;
    return prod.saleInclusive ? mulDivRound(r, 10000, 10000 + (prod.gstBp || 0)) : mulDivRound(r, 10000 + (prod.gstBp || 0), 10000);
  };

  const addProduct = async () => {
    const prods = store.listProducts();
    const picked = await pickerDialog({
      title: 'Add item',
      items: prods,
      label: (p) => p.name,
      sub: (p) => [p.sku || p.code, p.hsn && 'HSN ' + p.hsn, p.trackStock ? 'Stock ' + f.qty(store.stockOf(p.id).current) : ''].filter(Boolean).join(' · '),
      end: (p) => f.money(kind === 'purchase' ? p.purchasePrice : p.salePrice),
      search: (p) => [p.name, p.sku, p.code, p.barcode, p.hsn, p.category, p.brand].join(' '),
      createLabel: 'Custom item / new product',
      onCreate: async (name) => ({ custom: true, name }),
      placeholder: 'Search name, SKU or scan barcode…',
      thumb: (p) => productThumb(p),
    });
    if (!picked) return;
    if (picked.custom) {
      const choice = await chooseDialog('Add item', [
        { value: 'once', label: 'One-time item', sub: 'Not saved to products, no stock tracking', icon: 'edit' },
        { value: 'product', label: 'Create product', sub: 'Save to product list with stock', icon: 'tag' },
      ]);
      if (!choice) return;
      if (choice === 'once') {
        const line = addLine({ name: picked.name });
        line.inputs.name.focus();
      } else {
        const prod = await quickCreateProduct(store, picked.name);
        if (prod) addLine({ productId: prod.id, name: prod.name, sku: prod.sku, hsn: prod.hsn, unit: prod.unit, rate: productRate(prod, inclusiveToggle.checked), gstBp: prod.gstBp });
      }
    } else {
      // Same product again -> increase quantity.
      const same = lines.find((l) => l.item.productId === picked.id);
      if (same) {
        const q = readQty(same.inputs.qty).value + 1000;
        same.inputs.qty.value = String(q / 1000);
      } else {
        addLine({ productId: picked.id, name: picked.name, sku: picked.sku || picked.code, hsn: picked.hsn, unit: picked.unit, rate: productRate(picked, inclusiveToggle.checked), gstBp: picked.gstBp || 0 });
      }
    }
    markDirty();
    recalc();
  };

  // ---- charges & options
  const packIn = moneyInput('packaging', draft.packaging);
  const otherIn = moneyInput('otherCharges', draft.otherCharges);
  const otherLabel = textInput('otherLabel', draft.otherChargesLabel || 'Other Charges');
  const chargesGst = selectInput('chargesGst', [['0', '0%'], ...gstOptions.filter(([v]) => v !== '0')], String(draft.chargesGstBp || 0));
  const inclusiveToggle = h('input', { type: 'checkbox', checked: !!draft.inclusive });
  const gstToggle = h('input', { type: 'checkbox', checked: draft.gst !== false });
  const roundToggle = h('input', { type: 'checkbox', checked: draft.roundOff !== false });

  // ---- payment (new sale / purchase)
  const canPayNow = !existing && kind !== 'quotation';
  const payAmount = moneyInput('payAmount', 0, { placeholder: '0.00' });
  const payMethod = selectInput('payMethod', PAYMENT_METHODS.filter((m) => m !== 'Credit'), draft.paymentMethod === 'Credit' ? b.defaultPaymentMethod : draft.paymentMethod);
  const payRef = textInput('payRef', '', { placeholder: 'UTR / cheque / txn no.' });
  const payStatus = h('div', { class: 'small' });
  const fullBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { payAmount.value = paiseToInput(lastTotals ? lastTotals.grandTotal : 0); markDirty(); recalc(); } }, 'Full amount');
  const creditBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { payAmount.value = ''; markDirty(); recalc(); } }, 'Credit (unpaid)');

  // ---- transport, notes
  const t = draft.transport;
  const tr = {
    name: textInput('tname', t.name, { placeholder: 'Transporter' }),
    vehicle: textInput('vehicle', t.vehicle, { placeholder: 'e.g. MH12AB1234', style: { textTransform: 'uppercase' } }),
    ewayBill: textInput('eway', t.ewayBill, { inputmode: 'numeric', placeholder: '12 digit number' }),
    deliveryAddress: textArea('delivery', t.deliveryAddress, { rows: 2 }),
    shippingAddress: textArea('shipping', t.shippingAddress, { rows: 2 }),
    notes: textArea('tnotes', t.notes, { rows: 2 }),
  };
  const notesIn = textArea('notes', draft.notes, { rows: 2 });
  const termsIn = textArea('terms', draft.terms ?? s.company.terms, { rows: 3 });

  // ---- totals
  const totalsBox = h('div');
  const totalLabel = h('b');
  let lastTotals = null;

  const collect = () => {
    const errs = [];
    const items = lines.map((l, i) => {
      const n = `Item ${i + 1}`;
      const qty = readQty(l.inputs.qty, { required: true, label: n + ' quantity' });
      const rate = readMoney(l.inputs.rate, { label: n + ' rate' });
      const discType = l.inputs.discType.value;
      const disc = discType === 'pct' ? readPct(l.inputs.disc, n + ' discount') : readMoney(l.inputs.disc, { label: n + ' discount' });
      [qty, rate, disc].forEach((r) => r.error && errs.push(r.error));
      return {
        ...l.item,
        name: l.inputs.name.value.trim(),
        qty: qty.value,
        unit: l.inputs.unit.value,
        rate: rate.value,
        discType,
        disc: disc.value,
        gstBp: parseInt(l.inputs.gst.value, 10) || 0,
        hsn: l.inputs.hsn.value.trim(),
      };
    });
    const pack = readMoney(packIn, { label: 'Packaging' });
    const other = readMoney(otherIn, { label: 'Other charges' });
    [pack, other].forEach((r) => r.error && errs.push(r.error));
    const partySnap = draft.partyId
      ? { ...draft.party, mobile: partyFields.mobile.value.trim(), gstin: partyFields.gstin.value.trim().toUpperCase(), address: partyFields.address.value.trim(), stateCode: partyFields.stateCode.value, state: stateName(partyFields.stateCode.value) }
      : { name: partyFields.walkin.value.trim() || (kind === 'purchase' ? '' : 'Walk-in Customer'), mobile: partyFields.mobile.value.trim(), gstin: partyFields.gstin.value.trim().toUpperCase(), address: partyFields.address.value.trim(), stateCode: partyFields.stateCode.value, state: stateName(partyFields.stateCode.value) };
    const d = {
      ...draft,
      id: existing ? existing.id : undefined,
      kind,
      number: numberInput.value.trim(),
      date: dateIn.value,
      dueDate: kind !== 'quotation' ? dueIn.value : '',
      reminders: reminders ? { offsets: reminders } : null,
      refNo: kind === 'purchase' ? refIn.value.trim() : '',
      validUntil: kind === 'quotation' ? validIn.value : '',
      party: partySnap,
      placeOfSupply: posSelect.value || partySnap.stateCode || s.company.stateCode,
      items,
      packaging: pack.value,
      otherCharges: other.value,
      otherChargesLabel: otherLabel.value.trim(),
      chargesGstBp: parseInt(chargesGst.value, 10) || 0,
      inclusive: inclusiveToggle.checked,
      gst: gstToggle.checked,
      roundOff: roundToggle.checked,
      notes: notesIn.value,
      terms: termsIn.value,
      transport: {
        name: tr.name.value, vehicle: tr.vehicle.value, ewayBill: tr.ewayBill.value,
        deliveryAddress: tr.deliveryAddress.value, shippingAddress: tr.shippingAddress.value, notes: tr.notes.value,
      },
      paymentMethod: payMethod.value,
    };
    if (!draft.partyId && kind === 'sale' && !payAmount.value.trim()) d.paymentMethod = payMethod.value;
    return { d, errs };
  };

  const recalc = () => {
    const { d } = collect();
    const r = store.computeDraft(d);
    lastTotals = r.totals;
    lines.forEach((l, i) => {
      const c = r.lines[i];
      l.calcEl.textContent = c ? `Taxable ${f.plain(c.taxable)}${c.tax ? ' + GST ' + f.plain(c.tax) : ''} = ${f.money(c.total)}` : '';
    });
    const T = r.totals;
    clear(totalsBox);
    put(totalsBox, kv([
      ['Sub total', f.money(T.gross)],
      T.discount ? ['Discount', '− ' + f.money(T.discount)] : null,
      ['Taxable amount', f.money(T.itemsTaxable)],
      T.chargesEntered ? ['Charges' + (T.chargesTax ? ' (excl. GST)' : ''), f.money(T.chargesTaxable)] : null,
      r.gst && !r.interState ? ['CGST', f.money(T.cgst)] : null,
      r.gst && !r.interState ? ['SGST', f.money(T.sgst)] : null,
      r.gst && r.interState ? ['IGST', f.money(T.igst)] : null,
      T.roundOff ? ['Round off', (T.roundOff > 0 ? '+ ' : '− ') + f.money(Math.abs(T.roundOff))] : null,
      'sep',
      ['Grand total', f.money(T.grandTotal), true],
    ]), r.gst ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${r.interState ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)'} · Place of supply ${stateName(r.placeOfSupply) || 'not set'}${r.inclusive ? ' · Rates include GST' : ''}`) : null);
    totalLabel.textContent = f.money(T.grandTotal);
    if (canPayNow) {
      const paid = readMoney(payAmount).value;
      const due = T.grandTotal - paid;
      payStatus.textContent = paid <= 0 ? 'Status: Unpaid (credit)' : due <= 0 ? (due < 0 ? 'Amount exceeds total' : 'Status: Fully paid') : `Status: Partially paid · Balance ${f.money(due)}`;
      payStatus.className = 'small ' + (due < 0 ? 'neg' : '');
    }
  };
  const recalcSoon = debounce(recalc, 120);

  for (const inp of [numberInput, dateIn, dueIn, refIn, validIn, packIn, otherIn, otherLabel, chargesGst, inclusiveToggle, gstToggle, roundToggle, payAmount, posSelect,
    partyFields.stateCode, partyFields.gstin, partyFields.mobile, partyFields.address, partyFields.walkin, notesIn, termsIn, ...Object.values(tr)]) {
    inp.addEventListener('input', () => { markDirty(); recalcSoon(); });
    inp.addEventListener('change', () => { markDirty(); recalcSoon(); });
  }
  partyFields.gstin.addEventListener('change', () => {
    const g = partyFields.gstin.value.trim().toUpperCase();
    if (/^\d{2}/.test(g) && !partyFields.stateCode.value) { partyFields.stateCode.value = g.slice(0, 2); recalc(); }
  });

  (draft.items || []).forEach((it) => addLine(it));

  let saving = false;
  const save = async (after) => {
    if (saving) return;
    const { d, errs } = collect();
    if (errs.length) { toast(errs.join('\n'), 'bad'); return; }
    const opts = {};
    if (canPayNow) {
      const pay = readMoney(payAmount);
      if (pay.error) { toast(pay.error, 'bad'); return; }
      if (pay.value > 0) opts.payment = { amount: pay.value, method: payMethod.value, reference: payRef.value.trim() };
      if (!pay.value) d.paymentMethod = 'Credit';
    }
    if (fromQuotationId) opts.fromQuotationId = fromQuotationId;
    saving = true;
    try {
      const saved = await store.saveDocument(d, opts);
      dirty = false;
      toast(`${meta.newLabel} ${saved.number} saved`, 'good');
      if (after === 'new') app.navigate('#/doc/new/' + kind, { replace: true });
      else if (after === 'share') { app.navigate('#/doc/' + saved.id, { replace: true }); await shareMenu(invoiceSpec(store, saved)); }
      else app.navigate('#/doc/' + saved.id, { replace: true });
    } catch (e) {
      errorToast(e);
    } finally {
      saving = false;
    }
  };

  const form = h('div', { class: 'form' },
    fromQuotationId ? h('div', { class: 'note' }, 'Converting quotation ' + (store.documents.get(fromQuotationId)?.number || '') + ' to an invoice. Review and save.') : null,
    h('div', { class: 'card' }, h('h2', null, meta.partyLabel), partyBox,
      h('details', { class: 'more', style: { marginTop: '8px' } }, h('summary', null, 'Billing details (mobile, GSTIN, address, state)'),
        h('div', { class: 'form' },
          h('div', { class: 'row' }, field('Mobile', partyFields.mobile), field('GSTIN', partyFields.gstin)),
          field('Address', partyFields.address),
          field('State', partyFields.stateCode)))),
    h('div', { class: 'card form' },
      h('div', { class: 'row' }, field(meta.newLabel + ' No.', numberInput, { required: true }), field('Date', dateIn, { required: true })),
      kind === 'sale' ? h('div', { class: 'row' }, field('Due date', dueIn), field('Place of supply', posSelect)) : null,
      kind === 'purchase' ? h('div', { class: 'row' }, field('Supplier bill no.', refIn), field('Place of supply', posSelect)) : null,
      kind === 'purchase' ? field('Payment due date', dueIn) : null,
      kind !== 'quotation' ? remBox : null,
      kind === 'quotation' ? h('div', { class: 'row' }, field('Valid until', validIn), field('Place of supply', posSelect)) : null),
    h('div', { class: 'card' },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } }, h('h2', { style: { flex: 1, margin: 0 } }, 'Items'),
        h('button', { class: 'btn small primary', type: 'button', onclick: addProduct }, icon('plus'), 'Add item')),
      itemsHost,
      h('button', { class: 'btn block', type: 'button', style: { marginTop: '8px' }, onclick: addProduct }, icon('plus'), 'Add item')),
    h('div', { class: 'card form' },
      h('h2', null, 'Charges & tax'),
      h('div', { class: 'row' }, field('Packaging charge', packIn), field('Charges GST', chargesGst)),
      h('div', { class: 'row' }, field('Other charges', otherIn), field('Label', otherLabel)),
      h('label', { class: 'check' }, gstToggle, 'Apply GST'),
      h('label', { class: 'check' }, inclusiveToggle, 'Rates include GST (inclusive pricing)'),
      h('label', { class: 'check' }, roundToggle, 'Round off grand total'),
      totalsBox),
    canPayNow ? h('div', { class: 'card form' },
      h('h2', null, kind === 'sale' ? 'Payment received' : 'Payment made'),
      h('div', { class: 'row' }, field('Amount', payAmount), field('Method', payMethod)),
      field('Reference', payRef),
      h('div', { class: 'btn-row' }, fullBtn, creditBtn),
      payStatus) : null,
    h('div', { class: 'card' }, h('details', { class: 'more', open: !!(t.name || t.vehicle || t.ewayBill || t.shippingAddress) },
      h('summary', null, 'Transport / delivery (optional)'),
      h('div', { class: 'form' },
        h('div', { class: 'row' }, field('Transport name', tr.name), field('Vehicle number', tr.vehicle)),
        field('E-Way Bill number', tr.ewayBill),
        field('Shipping address', tr.shippingAddress),
        field('Delivery address', tr.deliveryAddress),
        field('Transport notes', tr.notes)))),
    h('div', { class: 'card' }, h('details', { class: 'more', open: !!draft.notes },
      h('summary', null, 'Notes & terms'),
      h('div', { class: 'form' }, field('Notes', notesIn), kind !== 'purchase' ? field('Terms & conditions', termsIn) : null))),
  );

  const footer = h('div', { class: 'savebar' },
    h('div', { class: 'total' }, h('small', null, 'Grand total'), totalLabel),
    !existing ? h('button', { class: 'btn', type: 'button', onclick: () => save('new') }, 'Save & New') : null,
    h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, icon('check'), 'Save'));

  recalc();
  paintRem();
  if (!draft.items.length) setTimeout(() => { if (!existing && !lines.length && store.products.size) addProduct(); }, 250);

  return {
    title: existing ? `Edit ${existing.number}` : fromQuotationId ? 'Invoice from quotation' : 'New ' + meta.newLabel,
    back: true,
    nav: false,
    content: form,
    footer,
    dirty: () => dirty,
    hideSearch: true,
  };
}

async function quickCreateParty(store, type, name) {
  return openSheet((api) => {
    const nameIn = textInput('name', name || '', { required: true });
    const mobile = textInput('mobile', '', { type: 'tel', inputmode: 'tel' });
    const gstin = textInput('gstin', '', { style: { textTransform: 'uppercase' }, maxlength: 15 });
    const state = selectInput('state', [['', 'Select state'], ...STATES.map(([c, n]) => [c, `${n} (${c})`])], store.settings.company.stateCode);
    const save = async () => {
      try {
        const p = await store.saveParty({ type, name: nameIn.value, mobile: mobile.value, gstin: gstin.value, stateCode: state.value || gstin.value.trim().slice(0, 2), state: stateName(state.value) });
        api.close(p);
      } catch (e) { errorToast(e); }
    };
    return h('div', null, h('h2', null, 'New ' + type),
      h('div', { class: 'form' }, field('Name', nameIn, { required: true }), h('div', { class: 'row' }, field('Mobile', mobile), field('GSTIN', gstin)), field('State', state)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save')));
  });
}

async function quickCreateProduct(store, name) {
  const b = store.settings.billing;
  return openSheet((api) => {
    const nameIn = textInput('name', name || '');
    const sale = moneyInput('sale', 0);
    const purchase = moneyInput('purchase', 0);
    const gst = selectInput('gst', GST_RATES.map((r) => [String(pctToBp(r)), r + '%']), String(pctToBp(b.defaultGst)));
    const hsn = textInput('hsn', '', { inputmode: 'numeric' });
    const unit = selectInput('unit', UNITS, b.defaultUnit);
    const opening = qtyInput('opening', 0);
    const save = async () => {
      const sp = readMoney(sale); const pp = readMoney(purchase); const op = readQty(opening);
      const err = [sp, pp, op].find((r) => r.error);
      if (err) { toast(err.error, 'bad'); return; }
      try {
        const p = await store.saveProduct({ name: nameIn.value, salePrice: sp.value, purchasePrice: pp.value, gstBp: parseInt(gst.value, 10), hsn: hsn.value, unit: unit.value, openingStock: op.value, saleInclusive: b.inclusive });
        api.close(p);
      } catch (e) { errorToast(e); }
    };
    return h('div', null, h('h2', null, 'New product'),
      h('div', { class: 'form' }, field('Name', nameIn, { required: true }),
        h('div', { class: 'row' }, field('Sale price', sale), field('Purchase price', purchase)),
        h('div', { class: 'row three' }, field('GST', gst), field('HSN/SAC', hsn), field('Unit', unit)),
        field('Opening stock', opening)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save')));
  });
}

// ------------------------------------------------------------------ view

export function docView({ store, app }, params) {
  const f = fmt(store);
  const d = store.documents.get(params.id);
  if (!d) throw new Error('Document not found');
  const meta = LIST_META[d.kind];
  const status = store.docStatus(d);
  const due = store.docDue(d);
  const party = d.partyId ? store.parties.get(d.partyId) : null;
  const spec = () => invoiceSpec(store, store.documents.get(d.id));
  const T = d.totals;
  const pays = d.kind === 'quotation' ? [] : store.paymentsForDoc(d.id);

  const act = (ic, label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, icon(ic), label);
  const actions = [
    act('share', 'Share', () => shareMenu(spec())),
    act('whatsapp', 'WhatsApp', () => runDocAction(spec(), 'whatsapp')),
    act('eye', 'View PDF', () => previewPdf(spec())),
    act('print', 'Print', () => runDocAction(spec(), 'print')),
  ];
  if (d.kind !== 'quotation' && d.status !== 'cancelled' && due > 0 && d.partyId) {
    actions.push(act('wallet', d.kind === 'sale' ? 'Receive' : 'Pay', () => app.navigate(`#/payment/new/${d.kind === 'sale' ? 'in' : 'out'}?party=${d.partyId}&doc=${d.id}`), 'primary'));
  }
  if (d.kind === 'sale' && d.status !== 'cancelled' && due > 0) actions.push(act('calendar', 'Reminder card', () => shareMenu(reminderCardSpec(store, store.documents.get(d.id)))));
  if (d.status !== 'cancelled' && d.qStatus !== 'converted') actions.push(act('edit', 'Edit', () => app.navigate(`#/doc/${d.id}/edit`)));
  actions.push(act('copy', 'Duplicate', () => app.navigate(`#/doc/new/${d.kind}?copy=${d.id}`)));
  if (d.kind === 'quotation') {
    if (d.qStatus !== 'converted') actions.push(act('convert', 'To Invoice', () => app.navigate(`#/doc/new/sale?from=${d.id}`), 'primary'));
    actions.push(act('check', 'Status', async () => {
      const st = await chooseDialog('Quotation status', ['draft', 'sent', 'accepted', 'rejected'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })));
      if (st) { await store.setQuotationStatus(d.id, st); app.refresh(); }
    }));
    actions.push(act('trash', 'Delete', async () => {
      if (!(await confirmDialog({ title: 'Delete quotation?', message: `Quotation ${d.number} will move to the recycle bin. You can restore it later.`, confirmText: 'Delete', danger: true }))) return;
      await store.deleteQuotation(d.id);
      toast('Moved to recycle bin');
      app.navigate('#/quotations', { replace: true });
    }, 'danger'));
  } else if (d.status !== 'cancelled') {
    actions.push(act('ban', 'Cancel', async () => {
      const details = [
        `${meta.newLabel} ${d.number} · ${f.money(T.grandTotal)}`,
        `Stock of ${d.items.filter((i) => i.productId).length} product(s) will be ${d.kind === 'sale' ? 'returned' : 'reversed'}`,
      ];
      if (pays.length) details.push(`${pays.length} linked payment(s) stay recorded and become an advance for the party`);
      const ok = await confirmDialog({ title: `Cancel ${meta.newLabel.toLowerCase()}?`, message: 'The document is kept (marked CANCELLED) for your records. This cannot be undone.', details, confirmText: 'Continue', danger: true });
      if (!ok) return;
      const reason = await promptDialog({ title: 'Reason for cancellation', label: 'Reason', placeholder: 'e.g. Wrong entry' });
      if (!reason) return;
      try { await store.cancelDocument(d.id, reason); toast('Cancelled'); app.refresh(); } catch (e) { errorToast(e); }
    }, 'danger'));
  }

  const content = h('div', null,
    d.status === 'cancelled' ? h('div', { class: 'note bad', style: { marginBottom: '12px' } }, `Cancelled${d.cancelReason ? ': ' + d.cancelReason : ''}`) : null,
    h('div', { class: 'card' },
      h('div', { class: 'doc-head' },
        h('div', null,
          h('div', { class: 'small muted' }, `${meta.newLabel} ${d.number}`),
          h('h2', null, party ? h('a', { href: '#/party/' + party.id }, d.party.name) : (d.party.name || 'Walk-in')),
          h('div', { class: 'small muted' }, [f.date(d.date), d.dueDate && 'Due ' + f.date(d.dueDate), d.refNo && 'Bill ' + d.refNo].filter(Boolean).join(' · '))),
        h('div', { style: { textAlign: 'right' } },
          h('div', { class: 'big' }, f.money(T.grandTotal)),
          statusBadge(status),
          d.kind !== 'quotation' && due > 0 && status !== 'cancelled' ? h('div', { class: 'small neg' }, 'Due ' + f.money(due)) : null)),
      d.sourceId && store.documents.get(d.sourceId) ? h('div', { class: 'small', style: { marginTop: '6px' } }, 'From quotation ', h('a', { href: '#/doc/' + d.sourceId }, store.documents.get(d.sourceId).number)) : null,
      d.convertedTo && store.documents.get(d.convertedTo) ? h('div', { class: 'small', style: { marginTop: '6px' } }, 'Converted to invoice ', h('a', { href: '#/doc/' + d.convertedTo }, store.documents.get(d.convertedTo).number)) : null),
    h('div', { class: 'actions-grid', style: { marginBottom: '12px' } }, actions),
    h('div', { class: 'section-title' }, `Items (${d.items.length})`),
    h('div', { class: 'list' }, d.items.map((it) => h(it.productId ? 'a' : 'div', { class: 'item', href: it.productId ? '#/product/' + it.productId : null },
      h('div', { class: 'main' },
        h('div', { class: 'title' }, it.name),
        h('div', { class: 'subtitle' }, `${f.qty(it.qty)} ${it.unit} × ${f.money(it.rate)}${it.disc ? ' · disc ' + (it.discType === 'pct' ? bpToPct(it.disc) + '%' : f.money(it.disc)) : ''}${d.gst ? ' · GST ' + bpToPct(it.gstBp) + '%' : ''}${it.hsn ? ' · HSN ' + it.hsn : ''}`)),
      h('div', { class: 'end amount' }, f.money(it.calc.total))))),
    h('div', { class: 'card', style: { marginTop: '12px' } }, kv([
      ['Sub total', f.money(T.gross)],
      T.discount ? ['Discount', '− ' + f.money(T.discount)] : null,
      ['Taxable amount', f.money(T.itemsTaxable)],
      d.packaging ? ['Packaging', f.money(d.packaging)] : null,
      d.otherCharges ? [d.otherChargesLabel || 'Other charges', f.money(d.otherCharges)] : null,
      T.cgst ? ['CGST', f.money(T.cgst)] : null,
      T.sgst ? ['SGST', f.money(T.sgst)] : null,
      T.igst ? ['IGST', f.money(T.igst)] : null,
      T.roundOff ? ['Round off', f.money(T.roundOff)] : null,
      'sep',
      ['Grand total', f.money(T.grandTotal), true],
      d.kind !== 'quotation' ? ['Paid', f.money(T.grandTotal - due)] : null,
      d.kind !== 'quotation' ? ['Balance due', f.money(due), true] : null,
    ]), d.gst ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${d.interState ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'} · Place of supply: ${stateName(d.placeOfSupply) || '—'}${d.inclusive ? ' · GST-inclusive rates' : ''}`) : null),
    pays.length ? h('div', null, h('div', { class: 'section-title' }, 'Payments'),
      h('div', { class: 'list' }, pays.map((p) => {
        const a = p.allocations.find((x) => x.docId === d.id);
        return h('a', { class: 'item', href: '#/payment/' + p.id },
          h('div', { class: 'main' }, h('div', { class: 'title' }, `${p.number} · ${p.method}`), h('div', { class: 'subtitle' }, [f.date(p.date), p.reference].filter(Boolean).join(' · '))),
          h('div', { class: 'end amount' }, f.money(a ? a.amount : p.amount)));
      }))) : null,
    (d.transport && Object.values(d.transport).some(Boolean)) ? h('div', { class: 'card', style: { marginTop: '12px' } }, h('h3', null, 'Transport'), kv([
      d.transport.name ? ['Transport', d.transport.name] : null,
      d.transport.vehicle ? ['Vehicle', d.transport.vehicle] : null,
      d.transport.ewayBill ? ['E-Way Bill', d.transport.ewayBill] : null,
      d.transport.shippingAddress ? ['Shipping', d.transport.shippingAddress] : null,
      d.transport.deliveryAddress ? ['Delivery', d.transport.deliveryAddress] : null,
      d.transport.notes ? ['Notes', d.transport.notes] : null,
    ])) : null,
    d.notes ? h('div', { class: 'card', style: { marginTop: '12px' } }, h('h3', null, 'Notes'), h('p', { class: 'small', style: { whiteSpace: 'pre-line' } }, d.notes)) : null,
    h('p', { class: 'small muted', style: { textAlign: 'center' } }, `Created ${new Date(d.createdAt).toLocaleString()}${d.revision > 1 ? ` · Edited ${d.revision - 1} time(s)` : ''}`),
  );

  return {
    title: `${meta.newLabel} ${d.number}`,
    back: true,
    content,
    actions: [{ icon: 'share', label: 'Share', onClick: () => shareMenu(spec()) }],
  };
}

