// Products / items and inventory: list, form, detail with stock movement
// history, stock adjustment and low-stock view.

import { h, icon, clear, debounce, put } from '../ui/dom.js';
import {
  field, textInput, moneyInput, qtyInput, selectInput, textArea, readMoney, readQty, toast, errorToast,
  lazyList, emptyState, confirmDialog, openSheet, dateInput, kv, pickImage, processImageFile, productThumb,
} from '../ui/components.js';
import { fmt, remember, sectionTitle } from './common.js';
import { UNITS } from '../core/settings.js';
import { GST_RATES, hsnError } from '../core/validate.js';
import { pctToBp, bpToPct, mulDivRound } from '../core/money.js';
import { matches } from '../core/search.js';
import { productMovements, runReport } from '../core/reports.js';
import { exportProducts } from '../core/csv.js';
import { saveFile } from '../platform/bridge.js';
import { today } from '../core/dates.js';
import { reportSpec, shareMenu } from '../docs/actions.js';

// ------------------------------------------------------------------ list

export function productList({ store }, params, query) {
  const f = fmt(store);
  const state = remember('products', { q: '', category: '', filter: 'all' });
  if (query.q) state.q = query.q;
  const host = h('div');
  const summary = h('div', { class: 'small muted', style: { margin: '0 2px 8px' } });
  const categories = [...new Set(store.listProducts().map((p) => p.category).filter(Boolean))].sort();
  const draw = () => {
    let list = store.listProducts().filter((p) => matches(state.q, p.name, p.code, p.sku, p.barcode, p.hsn, p.category, p.brand));
    if (state.category) list = list.filter((p) => p.category === state.category);
    if (state.filter === 'low') list = list.filter((p) => store.isLowStock(p));
    if (state.filter === 'out') list = list.filter((p) => p.trackStock && store.stockOf(p.id).current <= 0);
    summary.textContent = `${list.length} product(s)`;
    clear(host);
    host.appendChild(list.length ? lazyList(list, (p) => productItem(store, f, p)) : emptyState('tag', state.q ? 'No matches' : 'No products yet', h('a', { class: 'btn primary', href: '#/product/new' }, icon('plus'), 'Add product')));
  };
  const chips = h('div', { class: 'chips' });
  const paint = () => {
    clear(chips);
    for (const [v, l] of [['all', 'All'], ['low', 'Low stock'], ['out', 'Out of stock']]) chips.appendChild(h('button', { class: 'chip' + (state.filter === v ? ' active' : ''), onclick: () => { state.filter = v; paint(); draw(); } }, l));
    for (const c of categories) chips.appendChild(h('button', { class: 'chip' + (state.category === c ? ' active' : ''), onclick: () => { state.category = state.category === c ? '' : c; paint(); draw(); } }, c));
  };
  paint();
  draw();
  const searchInput = h('input', { type: 'search', placeholder: 'Search name, SKU, barcode, HSN…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) });
  return {
    title: 'Products',
    content: h('div', null,
      h('div', { class: 'searchbar' }, icon('search'), searchInput, scanButton((code) => { searchInput.value = code; state.q = code; draw(); })),
      chips, summary, host),
    actions: [{ icon: 'download', label: 'Export CSV', onClick: () => saveFile(new Blob([exportProducts(store)], { type: 'text/csv' }), `Products_${today()}.csv`) }],
    fab: { href: '#/product/new', icon: 'plus', text: 'Product', label: 'Add product' },
  };
}

function productItem(store, f, p) {
  const st = store.stockOf(p.id);
  const low = store.isLowStock(p);
  return h('a', { class: 'item', href: '#/product/' + p.id },
    productThumb(p),
    h('div', { class: 'main' },
      h('div', { class: 'title' }, p.name),
      h('div', { class: 'subtitle' }, [p.sku || p.code, p.category, p.hsn && 'HSN ' + p.hsn].filter(Boolean).join(' · ') || '—')),
    h('div', { class: 'end' },
      h('div', { class: 'amount' }, f.money(p.salePrice)),
      p.trackStock ? h('div', { class: 'small ' + (low ? 'neg' : 'muted') }, `${f.qty(st.current)} ${p.unit || ''}${low ? ' · low' : ''}`) : h('div', { class: 'small muted' }, 'Service')));
}

/** Camera barcode scan using the platform BarcodeDetector when available. */
function scanButton(onCode) {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) return null;
  return h('button', { class: 'icon-btn', 'aria-label': 'Scan barcode', onclick: async () => {
    const code = await scanBarcode();
    if (code) onCode(code);
  } }, icon('scan'));
}

export async function scanBarcode() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    toast('Camera not available', 'bad');
    return null;
  }
  const detector = new window.BarcodeDetector();
  return openSheet((api) => {
    const video = h('video', { autoplay: true, playsinline: true, muted: true, style: { width: '100%', borderRadius: '10px', background: '#000' } });
    video.srcObject = stream;
    let alive = true;
    const stop = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); };
    const tick = async () => {
      if (!alive) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) { stop(); api.close(codes[0].rawValue); return; }
      } catch { /* frame not ready */ }
      setTimeout(tick, 250);
    };
    video.addEventListener('playing', tick);
    const origClose = api.close;
    api.close = (v) => { stop(); origClose(v); };
    return h('div', null, h('h2', null, 'Scan barcode'), video,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel')));
  });
}

// ------------------------------------------------------------------ form

export function productForm({ store, app }, params) {
  const existing = params.id ? store.products.get(params.id) : null;
  if (params.id && !existing) throw new Error('Product not found');
  const b = store.settings.billing;
  const p = existing || { unit: b.defaultUnit, gstBp: pctToBp(b.defaultGst), trackStock: true, saleInclusive: b.inclusive };
  let dirty = false;
  const categories = [...new Set(store.listProducts().map((x) => x.category).filter(Boolean))];
  const gstOpts = GST_RATES.map((r) => [String(pctToBp(r)), r + '%']);
  if (!gstOpts.some(([v]) => v === String(p.gstBp))) gstOpts.unshift([String(p.gstBp), bpToPct(p.gstBp) + '%']);
  const inputs = {
    name: textInput('name', p.name, { required: true }),
    code: textInput('code', p.code),
    sku: textInput('sku', p.sku),
    barcode: textInput('barcode', p.barcode, { inputmode: 'numeric' }),
    hsn: textInput('hsn', p.hsn, { inputmode: 'numeric', maxlength: 8 }),
    category: textInput('category', p.category, { list: 'bb-categories' }),
    brand: textInput('brand', p.brand),
    unit: selectInput('unit', [...new Set([p.unit, ...UNITS])], p.unit),
    purchasePrice: moneyInput('purchasePrice', p.purchasePrice),
    salePrice: moneyInput('salePrice', p.salePrice),
    mrp: moneyInput('mrp', p.mrp),
    gst: selectInput('gst', gstOpts, String(p.gstBp)),
    saleInclusive: h('input', { type: 'checkbox', checked: !!p.saleInclusive }),
    trackStock: h('input', { type: 'checkbox', checked: p.trackStock !== false }),
    lowStockAlert: h('input', { type: 'checkbox', checked: p.lowStockAlert !== false }),
    openingStock: qtyInput('openingStock', p.openingStock),
    minStock: qtyInput('minStock', p.minStock),
    description: textArea('description', p.description, { rows: 2 }),
  };
  const margin = h('div', { class: 'small muted' });
  const updMargin = () => {
    const sp = readMoney(inputs.salePrice).value;
    const pp = readMoney(inputs.purchasePrice).value;
    const bp = parseInt(inputs.gst.value, 10) || 0;
    const net = inputs.saleInclusive.checked ? mulDivRound(sp, 10000, 10000 + bp) : sp;
    margin.textContent = sp && pp ? `Margin per unit (excl. GST): ${fmt(store).money(net - pp)}${pp ? ` (${((net - pp) * 100 / pp).toFixed(1)}%)` : ''}` : '';
  };
  for (const i of Object.values(inputs)) {
    i.addEventListener('input', () => { dirty = true; updMargin(); });
    i.addEventListener('change', () => { dirty = true; updMargin(); });
  }
  updMargin();

  const save = async () => {
    const vals = {
      purchasePrice: readMoney(inputs.purchasePrice, { label: 'Purchase price' }),
      salePrice: readMoney(inputs.salePrice, { label: 'Sale price' }),
      mrp: readMoney(inputs.mrp, { label: 'MRP' }),
      openingStock: readQty(inputs.openingStock, { label: 'Opening stock' }),
      minStock: readQty(inputs.minStock, { label: 'Minimum stock' }),
    };
    const err = Object.values(vals).find((v) => v.error) || (hsnError(inputs.hsn.value) ? { error: hsnError(inputs.hsn.value) } : null);
    if (err) { toast(err.error, 'bad'); return; }
    if (existing && vals.openingStock.value !== (existing.openingStock || 0)) {
      const ok = await confirmDialog({ title: 'Change opening stock?', message: 'Changing opening stock changes current stock for all dates. For corrections after trading has started, use "Adjust stock" instead so the change is recorded with a reason.', confirmText: 'Change anyway' });
      if (!ok) return;
    }
    try {
      const saved = await store.saveProduct({
        id: existing ? existing.id : undefined,
        name: inputs.name.value, code: inputs.code.value, sku: inputs.sku.value, barcode: inputs.barcode.value,
        hsn: inputs.hsn.value, category: inputs.category.value, brand: inputs.brand.value, unit: inputs.unit.value,
        purchasePrice: vals.purchasePrice.value, salePrice: vals.salePrice.value, mrp: vals.mrp.value,
        gstBp: parseInt(inputs.gst.value, 10) || 0, saleInclusive: inputs.saleInclusive.checked,
        trackStock: inputs.trackStock.checked, lowStockAlert: inputs.lowStockAlert.checked, openingStock: vals.openingStock.value, minStock: vals.minStock.value,
        description: inputs.description.value.trim(),
      });
      if (pendingImage) await store.setProductImage(saved.id, pendingImage);
      else if (removeImage && existing && existing.imageId) await store.removeProductImage(saved.id);
      dirty = false;
      toast('Product saved', 'good');
      app.navigate('#/product/' + saved.id, { replace: true });
    } catch (e) { errorToast(e); }
  };

  const scan = scanButton((code) => { inputs.barcode.value = code; dirty = true; });
  // Product image: applied when the product is saved.
  let pendingImage = null;
  let removeImage = false;
  const imgBox = h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } });
  const paintImg = () => {
    clear(imgBox);
    const shown = pendingImage ? { thumb: pendingImage.thumb } : removeImage ? null : p;
    put(imgBox, productThumb(shown, 'lg'), h('div', { class: 'stack' },
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        const file = await pickImage(shown && shown.thumb ? 'Change product image' : 'Add product image');
        if (!file) return;
        try { pendingImage = await processImageFile(file); removeImage = false; dirty = true; paintImg(); } catch (e) { errorToast(e); }
      } }, icon('image'), shown && shown.thumb ? 'Change image' : 'Add product image'),
      shown && shown.thumb ? h('button', { class: 'btn small danger', type: 'button', onclick: () => { pendingImage = null; removeImage = true; dirty = true; paintImg(); } }, 'Remove image') : null,
      h('div', { class: 'small muted' }, 'JPEG, PNG or WebP · resized to 800 px')));
  };
  paintImg();
  return {
    title: existing ? 'Edit product' : 'New product',
    back: true,
    nav: false,
    hideSearch: true,
    dirty: () => dirty,
    content: h('div', { class: 'form' },
      h('datalist', { id: 'bb-categories' }, categories.map((c) => h('option', { value: c }))),
      h('div', { class: 'card form' },
        imgBox,
        field('Product name', inputs.name, { required: true }),
        h('div', { class: 'row' }, field('Product code', inputs.code), field('SKU', inputs.sku)),
        h('div', { class: 'row' }, field('Barcode', scan ? h('div', { style: { display: 'flex', gap: '4px' } }, inputs.barcode, scan) : inputs.barcode), field('HSN/SAC', inputs.hsn)),
        h('div', { class: 'row' }, field('Category', inputs.category), field('Brand', inputs.brand))),
      h('div', { class: 'card form' },
        h('h2', null, 'Pricing & tax'),
        h('div', { class: 'row' }, field('Sale price', inputs.salePrice), field('Purchase price', inputs.purchasePrice, { hint: 'Excl. GST' })),
        h('div', { class: 'row' }, field('MRP', inputs.mrp), field('GST', inputs.gst)),
        h('label', { class: 'check' }, inputs.saleInclusive, 'Sale price includes GST'),
        margin),
      h('div', { class: 'card form' },
        h('h2', null, 'Stock'),
        h('label', { class: 'check' }, inputs.trackStock, 'Track stock for this item (untick for services)'),
        h('label', { class: 'check' }, inputs.lowStockAlert, 'Low stock alert for this product'),
        h('div', { class: 'row' }, field('Unit', inputs.unit), field('Opening stock', inputs.openingStock)),
        field('Minimum stock (low-stock alert)', inputs.minStock),
        field('Description', inputs.description))),
    footer: h('div', { class: 'savebar' }, h('div', { class: 'total' }), h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Save')),
  };
}

// ------------------------------------------------------------------ detail

export function productView({ store, app }, params) {
  const f = fmt(store);
  const p = store.products.get(params.id);
  if (!p) throw new Error('Product not found');
  const st = store.stockOf(p.id);
  const moves = productMovements(store, p.id);
  const low = store.isLowStock(p);
  const act = (ic, label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, icon(ic), label);
  const del = async () => {
    const used = moves.filter((m) => m.docId).length;
    const ok = await confirmDialog({
      title: 'Delete product?',
      message: `${p.name} will move to the recycle bin and disappear from lists and pickers. Existing invoices keep their item details. You can restore it from Settings → Recycle bin.`,
      details: [used ? `Used in ${used} transaction line(s)` : 'Not used in any transaction', p.trackStock ? `Current stock ${f.qty(st.current)} ${p.unit}` : ''].filter(Boolean),
      confirmText: 'Move to recycle bin', danger: true,
    });
    if (!ok) return;
    await store.deleteProduct(p.id);
    toast('Moved to recycle bin');
    app.navigate('#/products', { replace: true });
  };
  return {
    title: p.name,
    back: true,
    content: h('div', null,
      p.deleted ? h('div', { class: 'note bad', style: { marginBottom: '12px' } }, 'This product is in the recycle bin.') : null,
      h('div', { class: 'card' },
        h('div', { class: 'doc-head' },
          h('button', { style: { border: 0, background: 'none', padding: 0, cursor: p.imageId ? 'zoom-in' : 'default' }, 'aria-label': 'Preview image', onclick: () => previewImage(store, p) }, productThumb(p, 'lg')),
          h('div', { style: { flex: 1 } }, h('h2', null, p.name), h('div', { class: 'small muted' }, [p.code, p.sku && 'SKU ' + p.sku, p.barcode, p.category, p.brand].filter(Boolean).join(' · '))),
          p.trackStock ? h('div', { style: { textAlign: 'right' } }, h('div', { class: 'small muted' }, 'In stock'), h('div', { class: 'big ' + (low ? 'neg' : '') }, f.qty(st.current)), h('div', { class: 'small muted' }, p.unit)) : h('span', { class: 'badge info' }, 'Service')),
        low ? h('div', { class: 'note warn', style: { marginTop: '8px' } }, `Low stock: minimum is ${f.qty(p.minStock)} ${p.unit}`) : null),
      h('div', { class: 'actions-grid', style: { marginBottom: '12px' } },
        p.trackStock ? act('settings', 'Adjust stock', async () => { if (await adjustDialog(store, p)) app.refresh(); }, 'primary') : null,
        act('sales', 'Sell', () => app.navigate('#/doc/new/sale')),
        act('purchase', 'Purchase', () => app.navigate('#/doc/new/purchase')),
        act('edit', 'Edit', () => app.navigate(`#/product/${p.id}/edit`)),
        !p.deleted ? act('trash', 'Delete', del, 'danger') : act('restore', 'Restore', async () => { await store.restoreProduct(p.id); app.refresh(); })),
      h('div', { class: 'card' }, kv([
        ['Sale price', f.money(p.salePrice) + (p.saleInclusive ? ' (incl. GST)' : '')],
        ['Purchase price', f.money(p.purchasePrice)],
        p.mrp ? ['MRP', f.money(p.mrp)] : null,
        ['GST', bpToPct(p.gstBp) + '%'],
        p.hsn ? ['HSN/SAC', p.hsn] : null,
        p.description ? ['Description', p.description] : null,
      ])),
      p.trackStock ? h('div', { class: 'card' }, h('h3', null, 'Stock summary'), kv([
        ['Opening stock', f.qty(st.opening)],
        ['Purchased', '+ ' + f.qty(st.purchased)],
        ['Sold', '− ' + f.qty(st.sold)],
        ['Adjusted', (st.adjusted >= 0 ? '+ ' : '− ') + f.qty(Math.abs(st.adjusted))],
        'sep',
        ['Closing stock', f.qty(st.current) + ' ' + p.unit, true],
        ['Stock value (cost)', f.money(mulDivRound(Math.max(0, st.current), p.purchasePrice, 1000))],
      ])) : null,
      p.trackStock ? sectionTitle('Stock movement history') : null,
      p.trackStock ? (moves.length ? lazyList(moves, (m) => h(m.docId ? 'a' : 'div', { class: 'item', href: m.docId ? '#/doc/' + m.docId : null },
        h('div', { class: 'main' }, h('div', { class: 'title' }, `${m.type}${m.ref ? ' · ' + m.ref : ''}`), h('div', { class: 'subtitle' }, [f.date(m.date), m.party].filter(Boolean).join(' · '))),
        h('div', { class: 'end' }, h('div', { class: 'amount ' + (m.qty < 0 ? 'neg' : 'pos') }, (m.qty > 0 ? '+' : '') + f.qty(m.qty)), h('div', { class: 'small muted' }, 'Bal ' + f.qty(m.balance))))) : emptyState('box', 'No movements yet')) : null),
  };
}

export function adjustDialog(store, p) {
  const f = fmt(store);
  return openSheet((api) => {
    const mode = selectInput('mode', [['add', 'Add stock (+)'], ['remove', 'Remove stock (−)'], ['set', 'Set actual count']], 'add');
    const qty = qtyInput('qty', 0);
    const reason = selectInput('reason', ['Physical count correction', 'Damaged / expired', 'Lost / theft', 'Free sample', 'Returned by customer', 'Returned to supplier', 'Opening correction', 'Other'], 'Physical count correction');
    const note = textInput('note', '', { placeholder: 'Details (optional)' });
    const date = dateInput('date', today());
    const cur = store.stockOf(p.id).current;
    const save = async () => {
      const q = readQty(qty, { required: true });
      if (q.error) { toast(q.error, 'bad'); return; }
      let delta = q.value;
      if (mode.value === 'remove') delta = -q.value;
      if (mode.value === 'set') delta = q.value - cur;
      if (!delta) { toast('No change in stock', 'bad'); return; }
      try {
        await store.adjustStock(p.id, delta, [reason.value, note.value.trim()].filter(Boolean).join(': '), date.value);
        toast('Stock adjusted', 'good');
        api.close(true);
      } catch (e) { errorToast(e); }
    };
    return h('div', null, h('h2', null, 'Adjust stock · ' + p.name),
      h('p', { class: 'small muted' }, `Current stock: ${f.qty(cur)} ${p.unit}`),
      h('div', { class: 'form' }, field('Adjustment', mode), h('div', { class: 'row' }, field('Quantity', qty), field('Date', date)), field('Reason', reason, { required: true }), field('Note', note)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(false) }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save adjustment')));
  });
}

// ------------------------------------------------------------------ inventory

export function inventory({ store, app }, params, query) {
  const f = fmt(store);
  const state = remember('inventory', { q: '', filter: 'all' });
  if (query.filter) state.filter = query.filter;
  const host = h('div');
  const totals = h('div', { class: 'card' });
  const draw = () => {
    let list = store.listProducts().filter((p) => p.trackStock && matches(state.q, p.name, p.sku, p.code, p.barcode, p.category));
    if (state.filter === 'low') list = list.filter((p) => store.isLowStock(p));
    if (state.filter === 'out') list = list.filter((p) => store.stockOf(p.id).current <= 0);
    let value = 0; let saleValue = 0;
    for (const p of store.listProducts()) {
      if (!p.trackStock) continue;
      const c = Math.max(0, store.stockOf(p.id).current);
      value += mulDivRound(c, p.purchasePrice, 1000);
      saleValue += mulDivRound(c, p.saleInclusive ? mulDivRound(p.salePrice, 10000, 10000 + (p.gstBp || 0)) : p.salePrice, 1000);
    }
    const lowCount = store.listProducts().filter((p) => store.isLowStock(p)).length;
    clear(totals);
    put(totals, kv([['Stock value (at cost)', f.money(value), true], ['Stock value (at sale price, excl. GST)', f.money(saleValue)], ['Low-stock items', String(lowCount), false, lowCount ? 'neg' : '']]));
    clear(host);
    host.appendChild(list.length ? lazyList(list, (p) => {
      const s = store.stockOf(p.id);
      const low = store.isLowStock(p);
      return h('div', { class: 'item' },
        productThumb(p),
        h('a', { class: 'main', href: '#/product/' + p.id, style: { color: 'inherit', textDecoration: 'none' } },
          h('div', { class: 'title' }, p.name),
          h('div', { class: 'subtitle' }, `Open ${f.qty(s.opening)} · In ${f.qty(s.purchased)} · Out ${f.qty(s.sold)} · Adj ${f.qty(s.adjusted)}`)),
        h('div', { class: 'end' }, h('div', { class: 'amount ' + (low ? 'neg' : '') }, `${f.qty(s.current)} ${p.unit}`),
          h('button', { class: 'btn small', onclick: async () => { if (await adjustDialog(store, p)) draw(); } }, 'Adjust')));
    }) : emptyState('box', state.filter === 'low' ? 'No low-stock items' : 'No stock items yet', h('a', { class: 'btn primary', href: '#/product/new' }, icon('plus'), 'Add product')));
  };
  const chips = h('div', { class: 'chips' });
  const paint = () => {
    clear(chips);
    for (const [v, l] of [['all', 'All items'], ['low', 'Low stock'], ['out', 'Out of stock']]) chips.appendChild(h('button', { class: 'chip' + (state.filter === v ? ' active' : ''), onclick: () => { state.filter = v; paint(); draw(); } }, l));
    chips.appendChild(h('a', { class: 'chip', href: '#/report/stock-movement' }, 'Movement report'));
  };
  paint();
  draw();
  const stockReport = () => {
    const id = state.filter === 'low' ? 'stock-low' : 'stock-current';
    const rep = runReport(store, id, { from: '0000-01-01', to: '9999-12-31' });
    shareMenu(reportSpec(store, id === 'stock-low' ? 'Low Stock Report' : 'Stock Report', 'As on ' + f.date(today()), rep), { jpg: false });
  };
  void app;
  return {
    title: 'Inventory',
    content: h('div', null,
      totals,
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Search stock items…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      chips, host),
    actions: [{ icon: 'print', label: 'Stock report', onClick: stockReport }],
    fab: { href: '#/doc/new/purchase', icon: 'purchase', text: 'Purchase', label: 'New purchase' },
  };
}

async function previewImage(store, p) {
  if (!p.imageId) return;
  const att = await store.getAttachment(p.imageId);
  if (!att) return;
  openSheet((api) => h('div', null, h('h2', null, p.name),
    h('img', { src: att.data, alt: p.name, style: { width: '100%', borderRadius: '10px', background: '#fff' } }),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close() }, 'Close'))));
}
