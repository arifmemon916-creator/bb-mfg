// Reports hub, generic report view (table + PDF / share / print / CSV),
// GST summary and Profit & Loss.

import { h, icon, clear, debounce, put } from '../ui/dom.js';
import { rangeChips, kv } from '../ui/components.js';
import { fmt, rangeState, rangeOf, rangeLabel, remember } from './common.js';
import { REPORTS, runReport, profitAndLoss, gstSummary } from '../core/reports.js';
import { reportSpec, shareMenu, runDocAction } from '../docs/actions.js';
import { cellText } from '../docs/templates.js';
import { toCSV } from '../core/csv.js';
import { saveFile } from '../platform/bridge.js';
import { paiseToInput, qtyToInput } from '../core/money.js';
import { matches } from '../core/search.js';

const GROUP_ICONS = { Sales: 'sales', Purchase: 'purchase', Stock: 'box', Finance: 'wallet', GST: 'percent' };

export function reportHub() {
  const groups = new Map();
  for (const r of REPORTS) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  return {
    title: 'Reports',
    content: h('div', null,
      h('div', { class: 'quick', style: { marginBottom: '8px' } },
        h('a', { href: '#/pl' }, icon('trend'), 'Profit & Loss'),
        h('a', { href: '#/gst' }, icon('percent'), 'GST'),
        h('a', { href: '#/receivables' }, icon('in'), 'Receivables'),
        h('a', { href: '#/payables' }, icon('out'), 'Payables')),
      [...groups.entries()].map(([g, list]) => h('div', null,
        h('div', { class: 'section-title' }, g),
        h('div', { class: 'list' }, list.map((r) => h('a', { class: 'item', href: '#/report/' + r.id },
          icon(GROUP_ICONS[g] || 'chart'), h('div', { class: 'main' }, h('div', { class: 'title' }, r.title)), icon('back', 'rot')))))),
    ),
  };
}

function exportCSV(store, title, report) {
  const rows = report.rows.map((r) => report.columns.map((c) => {
    const v = r[c.key];
    if (v == null) return '';
    if (c.type === 'money') return paiseToInput(v);
    if (c.type === 'qty') return qtyToInput(v);
    return v;
  }));
  if (report.totals) rows.push(report.columns.map((c, i) => (i === 0 ? 'Total' : report.totals[c.key] != null ? (c.type === 'money' ? paiseToInput(report.totals[c.key]) : c.type === 'qty' ? qtyToInput(report.totals[c.key]) : report.totals[c.key]) : '')));
  const csv = toCSV(report.columns.map((c) => c.label), rows);
  return saveFile(new Blob([csv], { type: 'text/csv' }), title.replace(/[^a-z0-9]+/gi, '_') + '.csv');
}

/** Render a report as a scrollable table. */
export function reportTable(store, report, onRowClick) {
  const numeric = (c) => ['money', 'qty', 'int'].includes(c.type);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, report.columns.map((c) => h('th', { class: numeric(c) ? 'n' : '' }, c.label)))),
    h('tbody', null,
      report.rows.length ? report.rows.map((r) => h('tr', { class: (r.strong ? 'strong ' : '') + (onRowClick && r.id ? 'click' : ''), onclick: onRowClick && r.id ? () => onRowClick(r) : null },
        report.columns.map((c) => h('td', { class: (numeric(c) ? 'n ' : '') + (c.type === 'text' && c.key === 'description' ? 'wrap' : '') + (c.type === 'money' && r[c.key] < 0 ? ' neg' : '') }, cellText(r[c.key], c.type, store.settings)))))
        : h('tr', null, h('td', { colspan: report.columns.length, class: 'muted' }, 'No records for this period')),
      report.totals ? h('tr', { class: 'strong' }, report.columns.map((c, i) => h('td', { class: numeric(c) ? 'n' : '' }, i === 0 ? 'Total' : report.totals[c.key] != null && c.type !== 'date' ? cellText(report.totals[c.key], c.type, store.settings) : ''))) : null)));
}

export function reportView({ store, app }, params) {
  const def = REPORTS.find((r) => r.id === params.id);
  if (!def) throw new Error('Unknown report');
  const f = fmt(store);
  const range = rangeState('report', 'month');
  const state = remember('report:' + def.id, { q: '' });
  const host = h('div');
  let current = null;
  const label = () => (def.noRange ? 'As on ' + f.date(new Date().toISOString().slice(0, 10)) : rangeLabel(store, range));
  const draw = () => {
    const full = runReport(store, def.id, rangeOf(range));
    const textKeys = full.columns.filter((c) => c.type === 'text' || c.type === 'date').map((c) => c.key);
    const rows = state.q ? full.rows.filter((r) => matches(state.q, ...textKeys.map((k) => r[k]))) : full.rows;
    const totals = full.totals && state.q ? Object.fromEntries(Object.keys(full.totals).map((k) => [k, rows.reduce((a, r) => a + (r[k] || 0), 0)])) : full.totals;
    current = { ...full, rows, totals };
    clear(host);
    put(host, 
      current.summary && current.summary.length ? h('div', { class: 'card' }, kv(current.summary.map(([k, v]) => [k, f.money(v)]))) : null,
      reportTable(store, current, (r) => {
        if (def.id.startsWith('fin-rec') || def.id.startsWith('fin-pay')) app.navigate('#/party/' + r.id);
        else if (def.id.startsWith('stock')) app.navigate('#/product/' + r.id);
        else if (r.id) app.navigate('#/doc/' + r.id);
      }),
      current.note ? h('p', { class: 'note', style: { marginTop: '10px' } }, current.note) : null);
  };
  draw();
  const spec = () => reportSpec(store, def.title, label(), current);
  return {
    title: def.title,
    back: true,
    content: h('div', null,
      def.noRange ? null : rangeChips(range, () => draw(), ['today', 'week', 'month', 'lastmonth', 'quarter', 'fy', 'all', 'custom']),
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Filter rows…', value: state.q, 'aria-label': 'Filter rows', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      h('div', { class: 'btn-row', style: { marginBottom: '10px' } },
        h('button', { class: 'btn', onclick: () => runDocAction(spec(), 'share') }, icon('file'), 'PDF'),
        h('button', { class: 'btn', onclick: () => runDocAction(spec(), 'print') }, icon('print'), 'Print'),
        h('button', { class: 'btn', onclick: () => exportCSV(store, def.title + ' ' + label(), current) }, icon('download'), 'CSV')),
      host),
    actions: [{ icon: 'share', label: 'Share', onClick: () => shareMenu(spec(), { jpg: false }) }],
  };
}

export function gstView({ store }) {
  const f = fmt(store);
  const range = rangeState('gst', 'month');
  const host = h('div');
  const draw = () => {
    const g = gstSummary(store, rangeOf(range));
    clear(host);
    put(host, 
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Output GST (sales)'), h('div', { class: 'value' }, f.money(g.outputTax))),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Input GST (purchases)'), h('div', { class: 'value' }, f.money(g.inputTax))),
        h('div', { class: 'kpi ' + (g.netTax > 0 ? 'bad' : 'good') }, h('div', { class: 'label' }, g.netTax >= 0 ? 'Net GST payable' : 'Net GST credit'), h('div', { class: 'value' }, f.money(Math.abs(g.netTax)))),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Taxable sales'), h('div', { class: 'value' }, f.money(g.taxableSales)))),
      h('div', { class: 'card', style: { marginTop: '12px' } }, kv([
        ['Taxable sales', f.money(g.taxableSales)],
        ['CGST', f.money(g.cgst)], ['SGST', f.money(g.sgst)], ['IGST', f.money(g.igst)],
        ['Total output GST', f.money(g.outputTax), true],
        'sep',
        ['Taxable purchases', f.money(g.taxablePurchases)],
        ['Input CGST', f.money(g.inCgst)], ['Input SGST', f.money(g.inSgst)], ['Input IGST', f.money(g.inIgst)],
        ['Total input GST', f.money(g.inputTax), true],
        'sep',
        [g.netTax >= 0 ? 'Net GST payable' : 'Net GST credit', f.money(Math.abs(g.netTax)), true],
      ])),
      h('p', { class: 'note' }, 'These are indicative figures computed from the invoices and purchases recorded in BizBill using the rates you entered. BizBill does not guarantee tax compliance — have them validated by your accountant before filing returns.'),
      h('div', { class: 'section-title' }, 'GST reports'),
      h('div', { class: 'list' }, REPORTS.filter((r) => r.group === 'GST').map((r) => h('a', { class: 'item', href: '#/report/' + r.id }, icon('percent'), h('div', { class: 'main' }, h('div', { class: 'title' }, r.title))))));
  };
  draw();
  return {
    title: 'GST Summary',
    back: true,
    content: h('div', null, rangeChips(range, () => draw(), ['month', 'lastmonth', 'quarter', 'fy', 'custom']), host),
    actions: [{ icon: 'share', label: 'Share', onClick: () => shareMenu(reportSpec(store, 'GST Summary', rangeLabel(store, range), runReport(store, 'gst-summary', rangeOf(range))), { jpg: false }) }],
  };
}

export function plView({ store }) {
  const f = fmt(store);
  const range = rangeState('pl', 'month');
  const host = h('div');
  const draw = () => {
    const pl = profitAndLoss(store, rangeOf(range));
    clear(host);
    put(host, 
      h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Net sales'), h('div', { class: 'value' }, f.money(pl.netSales))),
        h('div', { class: 'kpi ' + (pl.grossProfit < 0 ? 'bad' : 'good') }, h('div', { class: 'label' }, 'Gross profit'), h('div', { class: 'value' }, f.money(pl.grossProfit))),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Expenses'), h('div', { class: 'value' }, f.money(pl.expenses))),
        h('div', { class: 'kpi ' + (pl.netProfit < 0 ? 'bad' : 'good') }, h('div', { class: 'label' }, pl.netProfit < 0 ? 'Net loss' : 'Net profit'), h('div', { class: 'value' }, f.money(pl.netProfit)))),
      h('div', { class: 'card', style: { marginTop: '12px' } }, kv([
        ['Gross sales (excl. GST)', f.money(pl.grossSales)],
        ['Less: discounts', '− ' + f.money(pl.discounts)],
        ['Net sales', f.money(pl.netSales), true],
        ['Less: cost of goods sold', '− ' + f.money(pl.cogs)],
        ['Gross profit', f.money(pl.grossProfit), true],
        pl.charges ? ['Add: charges collected', f.money(pl.charges)] : null,
        pl.roundOff ? ['Add: round off', f.money(pl.roundOff)] : null,
        ...pl.expensesByCategory.map(([c, v]) => ['Less: ' + c, '− ' + f.money(v)]),
        ['Total expenses', '− ' + f.money(pl.expenses)],
        'sep',
        [pl.netProfit < 0 ? 'Net loss' : 'Net profit', f.money(pl.netProfit), true, pl.netProfit < 0 ? 'neg' : 'pos'],
      ])),
      h('p', { class: 'note' }, `Cost of goods sold uses each item's purchase price recorded at the time of sale (items without a purchase price count as zero cost). GST collected is a liability and is not treated as income. Purchases recorded in this period (taxable value): ${f.money(pl.purchases)}.`));
  };
  draw();
  return {
    title: 'Profit & Loss',
    back: true,
    content: h('div', null, rangeChips(range, () => draw(), ['month', 'lastmonth', 'quarter', 'fy', 'all', 'custom']), host),
    actions: [{ icon: 'share', label: 'Share', onClick: () => shareMenu(reportSpec(store, 'Profit & Loss', rangeLabel(store, range), runReport(store, 'fin-pl', rangeOf(range))), { jpg: false }) }],
  };
}
