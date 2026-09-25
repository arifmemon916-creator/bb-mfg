// Formatting helpers bound to the current settings.

import { formatMoney, formatQty, bpToPct } from '../core/money.js';
import { formatDate, resolveRange } from '../core/dates.js';
import { h } from '../ui/dom.js';

export function fmt(store) {
  const b = store.settings.billing;
  return {
    money: (p) => formatMoney(p, { symbol: b.currencySymbol, grouping: b.grouping }),
    plain: (p) => formatMoney(p, { symbol: '', grouping: b.grouping }),
    date: (iso) => formatDate(iso, b.dateFormat),
    qty: (q) => formatQty(q, b.qtyDecimals),
    pct: (bp) => bpToPct(bp) + '%',
  };
}

/** Per-screen remembered UI state (filters etc.) for this session. */
const memory = new Map();
export function remember(key, init) {
  if (!memory.has(key)) memory.set(key, typeof init === 'function' ? init() : init);
  return memory.get(key);
}

export function rangeState(key, preset = 'month') {
  return remember('range:' + key, { preset, from: '', to: '' });
}

export function rangeOf(state) {
  return resolveRange(state.preset, new Date(), state);
}

export function rangeLabel(store, state) {
  const f = fmt(store);
  if (state.preset === 'all') return 'All time';
  const r = rangeOf(state);
  return r.from === r.to ? f.date(r.from) : `${f.date(r.from)} – ${f.date(r.to)}`;
}

export function amountClass(v) {
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

export function sectionTitle(text, link) {
  return h('div', { class: 'section-title' }, h('span', null, text), link || null);
}
