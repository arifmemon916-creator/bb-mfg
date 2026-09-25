// BizStore: the single business layer of BizBill.
//
// - Loads every business record from IndexedDB into memory at startup so
//   lists, search, dashboard and reports are instant on mobile.
// - Every mutation builds a list of DB operations and commits them in one
//   atomic transaction, then updates the in-memory cache.
// - Stock levels, party balances and invoice dues are derived from the
//   transactions (never stored twice), so they cannot drift.

import { Database, newId } from './db.js';
import { computeDocument, isInterState } from './calc.js';
import { mulDivRound, pctToBp, sum, formatMoney } from './money.js';
import { mergeSettings, formatDocNumber, DOC_KINDS } from './settings.js';
import { computePartyAccount, paymentStatus } from './ledger.js';
import { gstinError, mobileError, normalizeGstin, emailError } from './validate.js';
import { today, nowStamp, isValidISODate } from './dates.js';
import { DATA_VERSION, migrateData } from './migrate.js';

export class ValidationError extends Error {
  constructor(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.join('\n'));
    this.name = 'ValidationError';
    this.messages = list;
  }
}

const AUDIT_LIMIT = 5000;
const clean = (s) => String(s == null ? '' : s).trim();

export class BizStore {
  constructor(db = new Database()) {
    this.db = db;
    this.version = 0;
    this.listeners = new Set();
    this._derived = null;
  }

  // ---------------------------------------------------------------- setup

  async init() {
    await this.db.open();
    await this.reload();
    await this.runDataMigrations();
    return this;
  }

  async reload() {
    const [settings, parties, products, documents, payments, expenses, stockMoves, meta] = await Promise.all([
      this.db.get('settings', 'app'),
      this.db.getAll('parties'),
      this.db.getAll('products'),
      this.db.getAll('documents'),
      this.db.getAll('payments'),
      this.db.getAll('expenses'),
      this.db.getAll('stockMoves'),
      this.db.getAll('meta'),
    ]);
    this.settings = mergeSettings(settings);
    this.parties = new Map(parties.map((r) => [r.id, r]));
    this.products = new Map(products.map((r) => [r.id, r]));
    this.documents = new Map(documents.map((r) => [r.id, r]));
    this.payments = new Map(payments.map((r) => [r.id, r]));
    this.expenses = new Map(expenses.map((r) => [r.id, r]));
    this.stockMoves = new Map(stockMoves.map((r) => [r.id, r]));
    this.meta = new Map(meta.map((r) => [r.key, r.value]));
    this.touch();
  }

  async runDataMigrations() {
    const current = this.meta.get('dataVersion') || 0;
    const hasData = this.parties.size || this.products.size || this.documents.size;
    if (current >= DATA_VERSION) return;
    if (hasData && current < DATA_VERSION) {
      const data = await this.exportStores();
      const migrated = migrateData(data, current);
      await this.replaceAll(migrated, 'migration');
    }
    await this.db.write([{ store: 'meta', op: 'put', value: { key: 'dataVersion', value: DATA_VERSION } }]);
    this.meta.set('dataVersion', DATA_VERSION);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  touch() {
    this.version++;
    this._derived = null;
    for (const fn of this.listeners) {
      try { fn(this.version); } catch (e) { console.error(e); }
    }
  }

  auditOp(action, entity, entityId, summary) {
    return {
      store: 'audit',
      op: 'put',
      value: { id: newId('a'), ts: nowStamp(), action, entity, entityId: entityId || '', summary: summary || '' },
    };
  }

  async commit(ops) {
    await this.db.write(ops);
    for (const o of ops) {
      if (o.store === 'settings' && o.op === 'put') this.settings = mergeSettings(o.value);
      const map = this.cacheFor(o.store);
      if (!map) continue;
      if (o.op === 'put') map.set(o.value.id, o.value);
      else if (o.op === 'delete') map.delete(o.key);
      else if (o.op === 'clear') map.clear();
    }
    this.touch();
    this.pruneAuditSoon();
  }

  cacheFor(store) {
    switch (store) {
      case 'parties': return this.parties;
      case 'products': return this.products;
      case 'documents': return this.documents;
      case 'payments': return this.payments;
      case 'expenses': return this.expenses;
      case 'stockMoves': return this.stockMoves;
      default: return null;
    }
  }

  pruneAuditSoon() {
    if (this._pruneTimer) return;
    this._pruneTimer = setTimeout(async () => {
      this._pruneTimer = null;
      try {
        const n = await this.db.count('audit');
        if (n <= AUDIT_LIMIT) return;
        const all = await this.db.getAll('audit');
        all.sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const ops = all.slice(0, n - AUDIT_LIMIT).map((a) => ({ store: 'audit', op: 'delete', key: a.id }));
        await this.db.write(ops);
      } catch (e) { console.warn('audit prune failed', e); }
    }, 2000);
  }

  // ------------------------------------------------------------- settings

  async saveSettings(next, auditSummary = 'Settings updated') {
    const value = { ...mergeSettings(next), key: 'app' };
    await this.commit([
      { store: 'settings', op: 'put', value },
      this.auditOp('settings.update', 'settings', 'app', auditSummary),
    ]);
  }

  money(p) {
    const b = this.settings.billing;
    return formatMoney(p, { symbol: b.currencySymbol, grouping: b.grouping });
  }

  // -------------------------------------------------------------- parties

  listParties(type, { includeDeleted = false } = {}) {
    const out = [];
    for (const p of this.parties.values()) {
      if (type && p.type !== type) continue;
      if (!includeDeleted && p.deleted) continue;
      out.push(p);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  validateParty(p) {
    const errs = [];
    if (!clean(p.name)) errs.push('Name is required');
    const g = gstinError(p.gstin);
    if (g) errs.push(g);
    const m = mobileError(p.mobile);
    if (m) errs.push(m);
    const w = mobileError(p.whatsapp);
    if (w) errs.push('WhatsApp: ' + w);
    const e = emailError(p.email);
    if (e) errs.push(e);
    if (p.openingDate && !isValidISODate(p.openingDate)) errs.push('Opening balance date is invalid');
    const dupe = this.listParties(p.type).find((x) => x.id !== p.id && x.name.toLowerCase() === clean(p.name).toLowerCase()
      && clean(x.mobile) === clean(p.mobile));
    if (dupe) errs.push(`A ${p.type} named "${dupe.name}" with the same mobile already exists`);
    return errs;
  }

  async saveParty(input) {
    const existing = input.id ? this.parties.get(input.id) : null;
    const p = {
      ...(existing || {}),
      ...input,
      id: input.id || newId('p'),
      type: input.type || (existing && existing.type) || 'customer',
      name: clean(input.name),
      gstin: normalizeGstin(input.gstin),
      mobile: clean(input.mobile),
      whatsapp: clean(input.whatsapp),
      email: clean(input.email),
      stateCode: input.stateCode || (normalizeGstin(input.gstin).slice(0, 2)) || '',
      openingBalance: Math.trunc(input.openingBalance || 0),
      creditLimit: Math.trunc(input.creditLimit || 0),
      deleted: !!(existing && existing.deleted && input.deleted !== false),
      updatedAt: nowStamp(),
      createdAt: (existing && existing.createdAt) || nowStamp(),
    };
    const errs = this.validateParty(p);
    if (errs.length) throw new ValidationError(errs);
    await this.commit([
      { store: 'parties', op: 'put', value: p },
      this.auditOp(existing ? `${p.type}.edit` : `${p.type}.create`, 'party', p.id, `${cap(p.type)} ${existing ? 'edited' : 'created'}: ${p.name}`),
    ]);
    return p;
  }

  /** Soft delete; the party moves to the recycle bin. Transactions stay intact. */
  async deleteParty(id) {
    const p = this.parties.get(id);
    if (!p) return;
    const v = { ...p, deleted: true, deletedAt: nowStamp(), updatedAt: nowStamp() };
    await this.commit([{ store: 'parties', op: 'put', value: v }, this.auditOp(`${p.type}.delete`, 'party', id, `${cap(p.type)} moved to recycle bin: ${p.name}`)]);
  }

  async restoreParty(id) {
    const p = this.parties.get(id);
    if (!p) return;
    const v = { ...p, deleted: false, deletedAt: '', updatedAt: nowStamp() };
    await this.commit([{ store: 'parties', op: 'put', value: v }, this.auditOp(`${p.type}.restore`, 'party', id, `${cap(p.type)} restored: ${p.name}`)]);
  }

  partyUsage(id) {
    let docs = 0; let pays = 0;
    for (const d of this.documents.values()) if (d.partyId === id) docs++;
    for (const p of this.payments.values()) if (p.partyId === id) pays++;
    return { docs, pays };
  }

  // ------------------------------------------------------------- products

  listProducts({ includeDeleted = false } = {}) {
    const out = [];
    for (const p of this.products.values()) if (includeDeleted || !p.deleted) out.push(p);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  validateProduct(p) {
    const errs = [];
    if (!p.name) errs.push('Product name is required');
    if (p.purchasePrice < 0 || p.salePrice < 0 || p.mrp < 0) errs.push('Prices cannot be negative');
    if (p.gstBp < 0 || p.gstBp > 10000) errs.push('GST % must be between 0 and 100');
    if (p.minStock < 0) errs.push('Minimum stock cannot be negative');
    if (p.hsn && !/^\d{2,8}$/.test(p.hsn)) errs.push('HSN/SAC must be 2–8 digits');
    for (const f of ['code', 'sku', 'barcode']) {
      if (!p[f]) continue;
      const dupe = this.listProducts().find((x) => x.id !== p.id && x[f] && x[f].toLowerCase() === p[f].toLowerCase());
      if (dupe) errs.push(`${f.toUpperCase()} "${p[f]}" is already used by ${dupe.name}`);
    }
    const nameDupe = this.listProducts().find((x) => x.id !== p.id && x.name.toLowerCase() === p.name.toLowerCase());
    if (nameDupe) errs.push(`A product named "${p.name}" already exists`);
    return errs;
  }

  async saveProduct(input) {
    const existing = input.id ? this.products.get(input.id) : null;
    const p = {
      unit: this.settings.billing.defaultUnit,
      ...(existing || {}),
      ...input,
      id: input.id || newId('i'),
      name: clean(input.name),
      code: clean(input.code),
      sku: clean(input.sku),
      barcode: clean(input.barcode),
      hsn: clean(input.hsn),
      category: clean(input.category),
      brand: clean(input.brand),
      purchasePrice: Math.trunc(input.purchasePrice || 0),
      salePrice: Math.trunc(input.salePrice || 0),
      mrp: Math.trunc(input.mrp || 0),
      gstBp: Math.trunc(input.gstBp ?? pctToBp(this.settings.billing.defaultGst)),
      openingStock: Math.trunc(input.openingStock || 0),
      minStock: Math.trunc(input.minStock || 0),
      trackStock: input.trackStock !== false,
      deleted: !!(existing && existing.deleted),
      updatedAt: nowStamp(),
      createdAt: (existing && existing.createdAt) || nowStamp(),
    };
    const errs = this.validateProduct(p);
    if (errs.length) throw new ValidationError(errs);
    const ops = [{ store: 'products', op: 'put', value: p }];
    let summary = `Product ${existing ? 'edited' : 'created'}: ${p.name}`;
    if (existing && existing.openingStock !== p.openingStock) summary += ' (opening stock changed)';
    ops.push(this.auditOp(existing ? 'product.edit' : 'product.create', 'product', p.id, summary));
    await this.commit(ops);
    return p;
  }

  async deleteProduct(id) {
    const p = this.products.get(id);
    if (!p) return;
    await this.commit([
      { store: 'products', op: 'put', value: { ...p, deleted: true, deletedAt: nowStamp(), updatedAt: nowStamp() } },
      this.auditOp('product.delete', 'product', id, `Product moved to recycle bin: ${p.name}`),
    ]);
  }

  async restoreProduct(id) {
    const p = this.products.get(id);
    if (!p) return;
    await this.commit([
      { store: 'products', op: 'put', value: { ...p, deleted: false, deletedAt: '', updatedAt: nowStamp() } },
      this.auditOp('product.restore', 'product', id, `Product restored: ${p.name}`),
    ]);
  }

  /** Manual stock correction. qty is signed milli-units. */
  async adjustStock(productId, qty, reason, date = today()) {
    const p = this.products.get(productId);
    if (!p) throw new ValidationError('Product not found');
    if (!qty) throw new ValidationError('Adjustment quantity cannot be zero');
    if (!clean(reason)) throw new ValidationError('A reason is required for stock adjustment');
    if (!isValidISODate(date)) throw new ValidationError('Date is invalid');
    const mv = { id: newId('m'), productId, date, qty: Math.trunc(qty), type: 'adjust', reason: clean(reason), createdAt: nowStamp() };
    await this.commit([
      { store: 'stockMoves', op: 'put', value: mv },
      this.auditOp('stock.adjust', 'product', productId, `Stock adjusted for ${p.name}: ${qty > 0 ? '+' : ''}${qty / 1000} (${clean(reason)})`),
    ]);
    return mv;
  }

  // ------------------------------------------------------------ derived

  derived() {
    if (this._derived) return this._derived;
    const stock = new Map();
    const blank = (p) => ({ opening: p ? p.openingStock || 0 : 0, purchased: 0, sold: 0, adjusted: 0 });
    for (const p of this.products.values()) stock.set(p.id, blank(p));
    for (const d of this.documents.values()) {
      if (d.status === 'cancelled' || d.deleted || (d.kind !== 'sale' && d.kind !== 'purchase')) continue;
      for (const it of d.items) {
        if (!it.productId) continue;
        let s = stock.get(it.productId);
        if (!s) { s = blank(null); stock.set(it.productId, s); }
        if (d.kind === 'sale') s.sold += it.qty; else s.purchased += it.qty;
      }
    }
    for (const m of this.stockMoves.values()) {
      let s = stock.get(m.productId);
      if (!s) { s = blank(null); stock.set(m.productId, s); }
      s.adjusted += m.qty;
    }
    for (const s of stock.values()) s.current = s.opening + s.purchased - s.sold + s.adjusted;

    const accounts = new Map();
    const docs = [...this.documents.values()];
    const pays = [...this.payments.values()];
    const byParty = new Map();
    for (const d of docs) push(byParty, d.partyId, 'docs', d);
    for (const p of pays) push(byParty, p.partyId, 'pays', p);
    const now = today();
    for (const party of this.parties.values()) {
      const g = byParty.get(party.id) || { docs: [], pays: [] };
      accounts.set(party.id, computePartyAccount(party, g.docs, g.pays, now));
    }
    this._derived = { stock, accounts };
    return this._derived;
  }

  stockOf(productId) {
    return this.derived().stock.get(productId) || { opening: 0, purchased: 0, sold: 0, adjusted: 0, current: 0 };
  }

  isLowStock(p) {
    if (!p.trackStock || p.deleted) return false;
    return this.stockOf(p.id).current <= (p.minStock || 0) && (p.minStock || 0) > 0
      || this.stockOf(p.id).current < 0;
  }

  account(partyId) {
    return this.derived().accounts.get(partyId) || { balance: 0, docDue: new Map(), aging: [0, 0, 0, 0, 0], advance: 0 };
  }

  docDue(doc) {
    if (!doc || doc.kind === 'quotation' || doc.status === 'cancelled') return 0;
    const a = this.account(doc.partyId);
    return a.docDue.has(doc.id) ? a.docDue.get(doc.id) : doc.totals.grandTotal;
  }

  docStatus(doc) {
    return paymentStatus(doc, this.docDue(doc));
  }

  // ------------------------------------------------------------ documents

  listDocuments(kind, { includeDeleted = false } = {}) {
    const out = [];
    for (const d of this.documents.values()) {
      if (kind && d.kind !== kind) continue;
      if (!includeDeleted && d.deleted) continue;
      out.push(d);
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || '').localeCompare(a.createdAt || '')));
  }

  peekNumber(kind) {
    const cfg = { ...this.settings.numbering[kind] };
    const used = new Set();
    const src = kind === 'receipt' || kind === 'voucher'
      ? [...this.payments.values()].filter((p) => (kind === 'receipt' ? p.direction === 'in' : p.direction === 'out')).map((p) => p.number)
      : this.listDocuments(kind, { includeDeleted: true }).map((d) => d.number);
    for (const n of src) used.add(String(n).toLowerCase());
    let guard = 0;
    while (used.has(formatDocNumber(cfg).toLowerCase()) && guard++ < 100000) cfg.next++;
    return formatDocNumber(cfg);
  }

  /** Returns settings ops advancing the counter past `number` when it matches the pattern. */
  numberingOps(kind, number, settingsDraft) {
    const cfg = settingsDraft.numbering[kind];
    const prefix = cfg.prefix || '';
    if (number.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = number.slice(prefix.length);
      if (/^\d+$/.test(rest)) {
        const n = parseInt(rest, 10);
        if (n >= cfg.next) cfg.next = n + 1;
      }
    }
  }

  /**
   * Compute document totals from a draft (does not save).
   * Draft items carry integers: qty (milli), rate (paise), disc (bp or paise), gstBp.
   */
  computeDraft(draft) {
    const b = this.settings.billing;
    const companyState = this.settings.company.stateCode;
    const pos = draft.placeOfSupply || (draft.party && draft.party.stateCode) || companyState;
    const interState = draft.interState != null && draft.manualInterState ? draft.interState : isInterState(companyState, pos);
    const gst = draft.gst != null ? draft.gst : b.gstEnabled;
    const input = {
      items: draft.items || [],
      inclusive: draft.inclusive != null ? draft.inclusive : b.inclusive,
      gst,
      interState,
      packaging: draft.packaging || 0,
      otherCharges: draft.otherCharges || 0,
      chargesGstBp: draft.chargesGstBp || 0,
      roundOff: draft.roundOff != null ? draft.roundOff : b.roundOff,
    };
    const r = computeDocument(input);
    return { ...r, interState, placeOfSupply: pos, gst, inclusive: input.inclusive, roundOff: input.roundOff };
  }

  validateDocument(d, existing) {
    const errs = [];
    const kindInfo = DOC_KINDS[d.kind];
    if (!kindInfo) errs.push('Unknown document type');
    if (!clean(d.number)) errs.push('Number is required');
    if (!isValidISODate(d.date)) errs.push('Date is invalid');
    if (d.dueDate && !isValidISODate(d.dueDate)) errs.push('Due date is invalid');
    if (!d.partyId && !clean(d.party && d.party.name)) errs.push(`${cap(kindInfo ? kindInfo.party : 'party')} is required`);
    if (!d.items.length) errs.push('Add at least one item');
    d.items.forEach((it, i) => {
      const n = `Item ${i + 1}`;
      if (!clean(it.name)) errs.push(`${n}: name is required`);
      if (!(it.qty > 0)) errs.push(`${n}: quantity must be greater than zero`);
      if (it.rate < 0) errs.push(`${n}: rate cannot be negative`);
      if (it.discType === 'pct' && (it.disc < 0 || it.disc > 10000)) errs.push(`${n}: discount % must be 0–100`);
      if (it.discType === 'amt' && it.disc < 0) errs.push(`${n}: discount cannot be negative`);
      if (it.gstBp < 0 || it.gstBp > 10000) errs.push(`${n}: GST % must be 0–100`);
    });
    if (d.packaging < 0 || d.otherCharges < 0) errs.push('Charges cannot be negative');
    if (d.party && d.party.gstin) { const g = gstinError(d.party.gstin); if (g) errs.push('Party ' + g); }
    const dupe = this.listDocuments(d.kind, { includeDeleted: true })
      .find((x) => x.id !== d.id && x.number.toLowerCase() === clean(d.number).toLowerCase());
    if (dupe) errs.push(`${kindInfo.short} number ${d.number} already exists`);
    if (existing && existing.status === 'cancelled') errs.push('A cancelled document cannot be edited');
    if (existing && existing.kind !== d.kind) errs.push('Document type cannot change');
    return errs;
  }

  /**
   * Create or update a sale / purchase / quotation.
   * opts.payment: {amount, method, reference} to record a payment with a new doc.
   * opts.fromQuotationId: marks that quotation as converted.
   */
  async saveDocument(draft, opts = {}) {
    const existing = draft.id ? this.documents.get(draft.id) : null;
    const s = structuredClone(this.settings);
    const b = s.billing;
    const party = draft.partyId ? this.parties.get(draft.partyId) : null;
    const partySnap = {
      name: clean(draft.party?.name || party?.name),
      mobile: clean(draft.party?.mobile ?? party?.mobile),
      gstin: normalizeGstin(draft.party?.gstin ?? party?.gstin),
      address: clean(draft.party?.address ?? party?.address),
      city: clean(draft.party?.city ?? party?.city),
      state: clean(draft.party?.state ?? party?.state),
      stateCode: clean(draft.party?.stateCode ?? party?.stateCode),
    };
    const items = (draft.items || []).map((it) => {
      const prod = it.productId ? this.products.get(it.productId) : null;
      const item = {
        productId: it.productId || '',
        name: clean(it.name),
        sku: clean(it.sku),
        hsn: clean(it.hsn),
        unit: clean(it.unit) || b.defaultUnit,
        qty: Math.trunc(it.qty || 0),
        rate: Math.trunc(it.rate || 0),
        discType: it.discType === 'amt' ? 'amt' : 'pct',
        disc: Math.trunc(it.disc || 0),
        gstBp: Math.trunc(it.gstBp || 0),
        description: clean(it.description),
      };
      if (draft.kind === 'sale' || draft.kind === 'quotation') {
        // Cost snapshot for profit calculation (purchase price, excl. GST).
        item.cost = it.cost != null && existing ? Math.trunc(it.cost) : (prod ? prod.purchasePrice || 0 : Math.trunc(it.cost || 0));
      }
      return item;
    });
    const d = {
      ...(existing || {}),
      id: draft.id || newId('d'),
      kind: draft.kind,
      number: clean(draft.number) || this.peekNumber(draft.kind),
      date: draft.date || today(),
      dueDate: draft.dueDate || '',
      refNo: clean(draft.refNo),
      partyId: draft.partyId || '',
      party: partySnap,
      items,
      packaging: Math.trunc(draft.packaging || 0),
      otherCharges: Math.trunc(draft.otherCharges || 0),
      otherChargesLabel: clean(draft.otherChargesLabel) || 'Other Charges',
      chargesGstBp: Math.trunc(draft.chargesGstBp || 0),
      notes: clean(draft.notes),
      terms: draft.terms != null ? String(draft.terms) : s.company.terms,
      transport: {
        name: clean(draft.transport?.name),
        vehicle: clean(draft.transport?.vehicle).toUpperCase(),
        deliveryAddress: clean(draft.transport?.deliveryAddress),
        shippingAddress: clean(draft.transport?.shippingAddress),
        ewayBill: clean(draft.transport?.ewayBill),
        notes: clean(draft.transport?.notes),
      },
      paymentMethod: draft.paymentMethod || b.defaultPaymentMethod,
      status: existing ? existing.status : 'active',
      updatedAt: nowStamp(),
      createdAt: (existing && existing.createdAt) || nowStamp(),
      revision: existing ? (existing.revision || 1) + 1 : 1,
    };
    if (d.kind === 'quotation') {
      d.qStatus = draft.qStatus || (existing && existing.qStatus) || 'draft';
      d.validUntil = draft.validUntil || '';
    }
    if (opts.fromQuotationId) d.sourceId = opts.fromQuotationId;
    const calc = this.computeDraft({ ...draft, party: partySnap, items });
    d.gst = calc.gst;
    d.inclusive = calc.inclusive;
    d.roundOff = calc.roundOff;
    d.interState = calc.interState;
    d.placeOfSupply = calc.placeOfSupply;
    d.items = items.map((it, i) => ({ ...it, calc: calc.lines[i] }));
    d.totals = calc.totals;

    const errs = this.validateDocument(d, existing);
    if (!party && !d.partyId && d.kind !== 'quotation' && d.kind !== 'sale') errs.push('Select a supplier');

    // Stock check for sales (optional, per settings).
    if (d.kind === 'sale' && !b.allowNegativeStock) {
      const need = new Map();
      for (const it of d.items) if (it.productId) need.set(it.productId, (need.get(it.productId) || 0) + it.qty);
      for (const [pid, q] of need) {
        const prod = this.products.get(pid);
        if (!prod || !prod.trackStock) continue;
        let avail = this.stockOf(pid).current;
        if (existing && existing.status !== 'cancelled') avail += sum(existing.items.filter((x) => x.productId === pid), (x) => x.qty);
        if (q > avail) errs.push(`Insufficient stock for ${prod.name}: available ${avail / 1000}`);
      }
    }
    const pay = opts.payment && opts.payment.amount > 0 ? opts.payment : null;
    if (pay && d.kind === 'quotation') errs.push('Payments cannot be recorded against a quotation');
    if (pay && pay.amount > d.totals.grandTotal) errs.push('Amount paid is more than the grand total. Record the extra as an advance payment instead.');
    if (errs.length) throw new ValidationError(errs);

    const ops = [];
    // Walk-in customer (no party record) is allowed for cash sales only.
    if (!d.partyId && (d.kind === 'sale' || d.kind === 'quotation')) {
      const due = d.totals.grandTotal - (pay ? pay.amount : 0);
      if (d.kind === 'sale' && due > 0) {
        throw new ValidationError('Select or create a customer for credit / partial payment invoices. Walk-in customers must pay in full.');
      }
    }

    if (!existing) this.numberingOps(d.kind, d.number, s);
    ops.push({ store: 'documents', op: 'put', value: d });

    // Purchases update the product purchase price (net of discount, excl. GST).
    if (d.kind === 'purchase' && b.updatePurchasePrice) {
      const seen = new Set();
      for (const it of d.items) {
        if (!it.productId || seen.has(it.productId) || !(it.qty > 0)) continue;
        const prod = this.products.get(it.productId);
        if (!prod) continue;
        seen.add(it.productId);
        const unitCost = mulDivRound(it.calc.taxable, 1000, it.qty);
        if (unitCost !== prod.purchasePrice) ops.push({ store: 'products', op: 'put', value: { ...prod, purchasePrice: unitCost, updatedAt: nowStamp() } });
      }
    }

    if (pay) {
      const direction = d.kind === 'purchase' ? 'out' : 'in';
      const numKind = direction === 'in' ? 'receipt' : 'voucher';
      const number = this.peekNumber(numKind);
      this.numberingOps(numKind, number, s);
      const p = {
        id: newId('y'), direction, number, partyId: d.partyId, partyName: partySnap.name,
        date: d.date, amount: Math.trunc(pay.amount), method: pay.method || d.paymentMethod,
        reference: clean(pay.reference), notes: `Against ${d.number}`,
        allocations: [{ docId: d.id, amount: Math.trunc(pay.amount) }],
        status: 'active', source: 'document', createdAt: nowStamp(), updatedAt: nowStamp(),
      };
      ops.push({ store: 'payments', op: 'put', value: p });
      ops.push(this.auditOp('payment.create', 'payment', p.id, `Payment ${p.number} ${direction === 'in' ? 'received' : 'made'}: ${this.money(p.amount)}`));
    }

    if (opts.fromQuotationId) {
      const q = this.documents.get(opts.fromQuotationId);
      if (q) {
        ops.push({ store: 'documents', op: 'put', value: { ...q, qStatus: 'converted', convertedTo: d.id, updatedAt: nowStamp() } });
        ops.push(this.auditOp('quotation.convert', 'document', q.id, `Quotation ${q.number} converted to invoice ${d.number}`));
      }
    }

    ops.push({ store: 'settings', op: 'put', value: s });
    const label = DOC_KINDS[d.kind].short;
    ops.push(this.auditOp(`${d.kind}.${existing ? 'edit' : 'create'}`, 'document', d.id,
      `${label} ${d.number} ${existing ? 'edited' : 'created'}: ${partySnap.name || 'Walk-in'} · ${this.money(d.totals.grandTotal)}`));
    await this.commit(ops);
    return d;
  }

  /** Void a sale / purchase. Stock returns automatically (derived). Payments become advances. */
  async cancelDocument(id, reason) {
    const d = this.documents.get(id);
    if (!d) return;
    if (d.status === 'cancelled') return;
    if (!clean(reason)) throw new ValidationError('Please give a reason for cancellation');
    const v = { ...d, status: 'cancelled', cancelledAt: nowStamp(), cancelReason: clean(reason), updatedAt: nowStamp() };
    const ops = [{ store: 'documents', op: 'put', value: v }];
    if (d.sourceId) {
      const q = this.documents.get(d.sourceId);
      if (q && q.convertedTo === d.id) ops.push({ store: 'documents', op: 'put', value: { ...q, qStatus: 'accepted', convertedTo: '', updatedAt: nowStamp() } });
    }
    ops.push(this.auditOp(`${d.kind}.cancel`, 'document', id, `${DOC_KINDS[d.kind].short} ${d.number} cancelled (${clean(reason)})`));
    await this.commit(ops);
  }

  async setQuotationStatus(id, qStatus) {
    const d = this.documents.get(id);
    if (!d || d.kind !== 'quotation') return;
    await this.commit([
      { store: 'documents', op: 'put', value: { ...d, qStatus, updatedAt: nowStamp() } },
      this.auditOp('quotation.status', 'document', id, `Quotation ${d.number} marked ${qStatus}`),
    ]);
  }

  /** Quotations can be moved to the recycle bin (they carry no accounting effect). */
  async deleteQuotation(id, restore = false) {
    const d = this.documents.get(id);
    if (!d || d.kind !== 'quotation') return;
    await this.commit([
      { store: 'documents', op: 'put', value: { ...d, deleted: !restore, updatedAt: nowStamp() } },
      this.auditOp(restore ? 'quotation.restore' : 'quotation.delete', 'document', id, `Quotation ${d.number} ${restore ? 'restored' : 'moved to recycle bin'}`),
    ]);
  }

  /** Build an unsaved invoice draft from a quotation (no re-entry of items). */
  quotationToInvoiceDraft(qid) {
    const q = this.documents.get(qid);
    if (!q) throw new ValidationError('Quotation not found');
    return {
      kind: 'sale',
      number: this.peekNumber('sale'),
      date: today(),
      partyId: q.partyId,
      party: { ...q.party },
      placeOfSupply: q.placeOfSupply,
      inclusive: q.inclusive,
      gst: q.gst,
      roundOff: q.roundOff,
      items: q.items.map(({ calc, ...it }) => ({ ...it })),
      packaging: q.packaging,
      otherCharges: q.otherCharges,
      otherChargesLabel: q.otherChargesLabel,
      chargesGstBp: q.chargesGstBp,
      notes: q.notes,
      terms: q.terms,
      transport: { ...(q.transport || {}) },
      fromQuotationId: q.id,
    };
  }

  // ------------------------------------------------------------ payments

  listPayments(direction) {
    const out = [];
    for (const p of this.payments.values()) if (!direction || p.direction === direction) out.push(p);
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || '').localeCompare(a.createdAt || '')));
  }

  /** Open documents of a party that can receive an allocation, oldest first. */
  openDocsFor(partyId, direction, excludePaymentId) {
    const party = this.parties.get(partyId);
    if (!party) return [];
    const kind = party.type === 'supplier' ? 'purchase' : 'sale';
    const own = excludePaymentId ? this.payments.get(excludePaymentId) : null;
    const ownAlloc = new Map((own ? own.allocations || [] : []).map((a) => [a.docId, a.amount]));
    const docs = this.listDocuments(kind).filter((d) => d.partyId === partyId && d.status !== 'cancelled');
    return docs.map((d) => ({ doc: d, due: this.docDue(d) + (ownAlloc.get(d.id) || 0) }))
      .filter((x) => x.due > 0 || ownAlloc.has(x.doc.id))
      .sort((a, b) => (a.doc.date < b.doc.date ? -1 : 1));
    void direction;
  }

  /** FIFO auto allocation proposal. */
  autoAllocate(partyId, direction, amount, excludePaymentId) {
    let left = amount;
    const out = [];
    for (const { doc, due } of this.openDocsFor(partyId, direction, excludePaymentId)) {
      if (left <= 0) break;
      const a = Math.min(left, due);
      if (a > 0) out.push({ docId: doc.id, amount: a });
      left -= a;
    }
    return out;
  }

  async savePayment(input) {
    const existing = input.id ? this.payments.get(input.id) : null;
    const s = structuredClone(this.settings);
    const party = this.parties.get(input.partyId);
    const direction = input.direction === 'out' ? 'out' : 'in';
    const numKind = direction === 'in' ? 'receipt' : 'voucher';
    const p = {
      ...(existing || {}),
      id: input.id || newId('y'),
      direction,
      number: clean(input.number) || (existing && existing.number) || this.peekNumber(numKind),
      partyId: input.partyId,
      partyName: party ? party.name : '',
      date: input.date || today(),
      amount: Math.trunc(input.amount || 0),
      method: input.method || s.billing.defaultPaymentMethod,
      reference: clean(input.reference),
      notes: clean(input.notes),
      allocations: (input.allocations || []).filter((a) => a.amount > 0).map((a) => ({ docId: a.docId, amount: Math.trunc(a.amount) })),
      status: existing ? existing.status : 'active',
      source: (existing && existing.source) || 'manual',
      createdAt: (existing && existing.createdAt) || nowStamp(),
      updatedAt: nowStamp(),
    };
    const errs = [];
    if (!party) errs.push('Select a party');
    if (!(p.amount > 0)) errs.push('Amount must be greater than zero');
    if (!isValidISODate(p.date)) errs.push('Date is invalid');
    if (existing && existing.status === 'cancelled') errs.push('A cancelled payment cannot be edited');
    const allocTotal = sum(p.allocations, (a) => a.amount);
    if (allocTotal > p.amount) errs.push('Allocated amount exceeds the payment amount');
    const open = new Map(this.openDocsFor(p.partyId, direction, p.id).map((x) => [x.doc.id, x.due]));
    for (const a of p.allocations) {
      if (!open.has(a.docId)) { errs.push('An allocated document is not open for this party'); break; }
      if (a.amount > open.get(a.docId)) {
        const doc = this.documents.get(a.docId);
        errs.push(`Allocation to ${doc ? doc.number : 'document'} exceeds its due amount`);
      }
    }
    const dupe = this.listPayments(direction).find((x) => x.id !== p.id && x.number.toLowerCase() === p.number.toLowerCase());
    if (dupe) errs.push(`Number ${p.number} already exists`);
    if (errs.length) throw new ValidationError(errs);
    if (!existing) this.numberingOps(numKind, p.number, s);
    await this.commit([
      { store: 'payments', op: 'put', value: p },
      { store: 'settings', op: 'put', value: s },
      this.auditOp(`payment.${existing ? 'edit' : 'create'}`, 'payment', p.id,
        `Payment ${p.number} ${existing ? 'edited' : (direction === 'in' ? 'received from' : 'made to')} ${p.partyName}: ${this.money(p.amount)}`),
    ]);
    return p;
  }

  async cancelPayment(id, reason) {
    const p = this.payments.get(id);
    if (!p || p.status === 'cancelled') return;
    if (!clean(reason)) throw new ValidationError('Please give a reason for cancellation');
    await this.commit([
      { store: 'payments', op: 'put', value: { ...p, status: 'cancelled', cancelReason: clean(reason), cancelledAt: nowStamp(), updatedAt: nowStamp() } },
      this.auditOp('payment.cancel', 'payment', id, `Payment ${p.number} cancelled (${clean(reason)})`),
    ]);
  }

  paymentsForDoc(docId) {
    return this.listPayments().filter((p) => p.status !== 'cancelled' && (p.allocations || []).some((a) => a.docId === docId));
  }

  // ------------------------------------------------------------ expenses

  listExpenses() {
    return [...this.expenses.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || '').localeCompare(a.createdAt || '')));
  }

  async saveExpense(input, attachment) {
    const existing = input.id ? this.expenses.get(input.id) : null;
    const e = {
      ...(existing || {}),
      id: input.id || newId('e'),
      date: input.date || today(),
      category: clean(input.category) || 'Other',
      amount: Math.trunc(input.amount || 0),
      method: input.method || this.settings.billing.defaultPaymentMethod,
      description: clean(input.description),
      reference: clean(input.reference),
      attachmentId: input.attachmentId ?? (existing && existing.attachmentId) ?? '',
      status: existing ? existing.status : 'active',
      createdAt: (existing && existing.createdAt) || nowStamp(),
      updatedAt: nowStamp(),
    };
    const errs = [];
    if (!(e.amount > 0)) errs.push('Amount must be greater than zero');
    if (!isValidISODate(e.date)) errs.push('Date is invalid');
    if (errs.length) throw new ValidationError(errs);
    const ops = [];
    if (attachment) {
      const id = newId('f');
      ops.push({ store: 'attachments', op: 'put', value: { id, name: attachment.name || 'receipt', mime: attachment.mime, data: attachment.data, createdAt: nowStamp() } });
      if (e.attachmentId) ops.push({ store: 'attachments', op: 'delete', key: e.attachmentId });
      e.attachmentId = id;
    }
    ops.push({ store: 'expenses', op: 'put', value: e });
    ops.push(this.auditOp(`expense.${existing ? 'edit' : 'create'}`, 'expense', e.id, `Expense ${existing ? 'edited' : 'recorded'}: ${e.category} ${this.money(e.amount)}`));
    await this.commit(ops);
    return e;
  }

  async cancelExpense(id, restore = false) {
    const e = this.expenses.get(id);
    if (!e) return;
    await this.commit([
      { store: 'expenses', op: 'put', value: { ...e, status: restore ? 'active' : 'cancelled', updatedAt: nowStamp() } },
      this.auditOp(restore ? 'expense.restore' : 'expense.cancel', 'expense', id, `Expense ${restore ? 'restored' : 'voided'}: ${e.category} ${this.money(e.amount)}`),
    ]);
  }

  getAttachment(id) {
    return this.db.get('attachments', id);
  }

  // ------------------------------------------------------------ audit

  async listAudit(limit = 500) {
    const all = await this.db.getAll('audit');
    all.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return all.slice(0, limit);
  }

  async logEvent(action, summary) {
    await this.db.write([this.auditOp(action, 'app', '', summary)]);
  }

  // ------------------------------------------------------------ backup plumbing

  async exportStores() {
    const data = {};
    for (const store of ['settings', 'parties', 'products', 'documents', 'payments', 'expenses', 'stockMoves', 'audit', 'attachments', 'meta']) {
      data[store] = await this.db.getAll(store);
    }
    return data;
  }

  /** Atomically replace all business data (restore / migration). */
  async replaceAll(data, reason = 'restore') {
    const ops = [];
    for (const store of ['settings', 'parties', 'products', 'documents', 'payments', 'expenses', 'stockMoves', 'audit', 'attachments', 'meta']) {
      ops.push({ store, op: 'clear' });
      for (const value of data[store] || []) ops.push({ store, op: 'put', value });
    }
    ops.push({ store: 'meta', op: 'put', value: { key: 'dataVersion', value: DATA_VERSION } });
    ops.push(this.auditOp(`data.${reason}`, 'app', '', reason === 'restore' ? 'Backup restored' : 'Data migrated'));
    await this.db.write(ops);
    await this.reload();
  }
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function push(map, key, field, value) {
  let g = map.get(key);
  if (!g) { g = { docs: [], pays: [] }; map.set(key, g); }
  g[field].push(value);
}
