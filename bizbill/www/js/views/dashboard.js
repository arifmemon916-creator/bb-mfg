// Dashboard: KPIs computed from stored transactions for the chosen period.

import { h, icon, replace } from '../ui/dom.js';
import { rangeChips } from '../ui/components.js';
import { dashboardMetrics, salesTrend } from '../core/reports.js';
import { fmt, rangeState, rangeOf, rangeLabel, sectionTitle } from './common.js';
import { DASHBOARD_CARDS } from '../core/settings.js';
import { dueSummary } from '../core/alerts.js';
import { today, resolveRange } from '../core/dates.js';
import { permissionWarning } from './notifications.js';

export function dashboard({ store, app }) {
  const f = fmt(store);
  const state = rangeState('dashboard', store.settings.ui.dashboardRange || 'today');
  const body = h('div');
  const cardsEnabled = new Set(store.settings.ui.dashboardCards || DASHBOARD_CARDS.map(([k]) => k));

  const draw = () => {
    const range = rangeOf(state);
    const m = dashboardMetrics(store, range);
    const card = (key, label, value, sub, ic, href, cls = '') => (cardsEnabled.has(key)
      ? h('a', { class: 'kpi ' + cls, href }, h('div', { class: 'label' }, icon(ic), label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null)
      : null);
    const period = rangeLabel(store, state);
    const kpis = h('div', { class: 'kpis' },
      card('sales', 'Sales', f.money(m.sales), `${m.salesCount} invoice(s)`, 'sales', '#/sales'),
      card('purchases', 'Purchases', f.money(m.purchases), `${m.purchaseCount} bill(s)`, 'purchase', '#/purchases'),
      card('expenses', 'Expenses', f.money(m.expenses), period, 'expense', '#/expenses'),
      card('collection', 'Collection', f.money(m.collection), `Paid out ${f.money(m.paid)}`, 'in', '#/payments'),
      card('receivable', 'To Receive', f.money(m.receivable), 'All customers', 'wallet', '#/receivables', m.receivable ? 'good' : ''),
      card('payable', 'To Pay', f.money(m.payable), 'All suppliers', 'out', '#/payables', m.payable ? 'bad' : ''),
      card('gst', m.gst.netTax >= 0 ? 'Net GST Payable' : 'Net GST Credit', f.money(Math.abs(m.gst.netTax)), `Out ${f.money(m.gst.outputTax)} · In ${f.money(m.gst.inputTax)}`, 'percent', '#/gst'),
      card('profit', 'Net Profit', f.money(m.profit), period, 'trend', '#/pl', m.profit < 0 ? 'bad' : m.profit > 0 ? 'good' : ''),
      card('customers', 'Customers', String(m.customers), 'Total', 'users', '#/customers'),
      card('suppliers', 'Suppliers', String(m.suppliers), 'Total', 'truck', '#/suppliers'),
      card('products', 'Products', String(m.products), 'Total', 'tag', '#/products'),
      card('lowstock', 'Low Stock', String(m.lowStock), m.lowStock ? 'Needs attention' : 'All good', 'alert', '#/inventory?filter=low', m.lowStock ? 'bad' : ''));

    const t = today();
    const dues = dueSummary(store, t);
    const recv = (rows) => rows.filter((r) => r.doc.kind === 'sale');
    const sumDue = (rows) => rows.reduce((a, r) => a + r.due, 0);
    const todayM = dashboardMetrics(store, resolveRange('today'));
    const payCards = h('div', { class: 'kpis', style: { marginTop: '10px' } },
      card('duetoday', 'Due Today', f.money(sumDue(recv(dues.dueToday))), `${recv(dues.dueToday).length} invoice(s)`, 'calendar', '#/dues?f=today', recv(dues.dueToday).length ? 'bad' : ''),
      card('overdue', 'Overdue', f.money(sumDue(recv(dues.overdue))), `${recv(dues.overdue).length} invoice(s)`, 'alert', '#/dues?f=overdue', recv(dues.overdue).length ? 'bad' : ''),
      card('collection', 'Collected Today', f.money(todayM.collection), 'Payment In', 'in', '#/payments?dir=in', 'good'),
      card('paidtoday', 'Paid Today', f.money(todayM.paid), 'Payment Out', 'out', '#/payments?dir=out'));
    const trend = salesTrend(store, range);
    let trendCard = null;
    if (trend.length > 1 && cardsEnabled.has('sales')) {
      const max = Math.max(1, ...trend.map((t) => t.value));
      trendCard = h('div', { class: 'card' },
        h('h3', null, 'Sales trend'),
        h('div', { class: 'trend', role: 'img', 'aria-label': 'Daily sales chart' },
          trend.map((t) => h('span', { style: { height: Math.max(1, Math.round((t.value / max) * 100)) + '%' }, title: `${f.date(t.date)}: ${f.money(t.value)}` }))),
        h('div', { class: 'small muted', style: { display: 'flex', justifyContent: 'space-between' } }, h('span', null, f.date(trend[0].date)), h('span', null, f.date(trend[trend.length - 1].date))));
    }

    const recent = store.listDocuments('sale').slice(0, 5);
    const company = store.settings.company;
    replace(body, 
      permissionWarning(store),
      !company.name ? h('div', { class: 'note warn', style: { marginBottom: '12px' } }, 'Set up your company profile so it appears on invoices. ', h('a', { href: '#/settings/company' }, 'Open Company Profile')) : null,
      h('div', { class: 'quick' },
        h('a', { href: '#/doc/new/sale' }, icon('sales'), 'New Invoice'),
        h('a', { href: '#/doc/new/purchase' }, icon('purchase'), 'Purchase'),
        h('a', { href: '#/payment/new/in' }, icon('in'), 'Payment In'),
        h('a', { href: '#/payment/new/out' }, icon('out'), 'Payment Out')),
      sectionTitle('Overview · ' + rangeLabel(store, state), h('a', { href: '#/settings/appearance' }, 'Customize')),
      chips,
      kpis,
      sectionTitle('Payments', h('a', { href: '#/dues' }, 'Dues')),
      payCards,
      trendCard,
      sectionTitle('Recent invoices', h('a', { href: '#/sales' }, 'View all')),
      recent.length
        ? h('div', { class: 'list' }, recent.map((d) => h('a', { class: 'item', href: '#/doc/' + d.id },
          h('div', { class: 'main' }, h('div', { class: 'title' }, d.party.name || 'Walk-in'), h('div', { class: 'subtitle' }, `${d.number} · ${f.date(d.date)}`)),
          h('div', { class: 'end' }, h('div', { class: 'amount' }, f.money(d.totals.grandTotal)), h('span', { class: 'badge ' + store.docStatus(d) }, store.docStatus(d))))))
        : h('div', { class: 'list' }, h('div', { class: 'empty' }, 'No invoices yet. ', h('a', { href: '#/doc/new/sale' }, 'Create your first invoice'))),
    );
  };
  const chips = rangeChips(state, () => draw(), ['today', 'week', 'month', 'fy', 'custom']);
  draw();
  void app;
  return {
    title: store.settings.company.name || 'BizBill',
    content: body,
    fab: { href: '#/doc/new/sale', icon: 'plus', text: 'Invoice', label: 'New invoice' },
  };
}
