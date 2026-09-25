// Local alert engine: low stock, payment due, overdue payments.
//
// evaluateAlerts() is a pure function. It takes the store, the persisted
// alert state and "today", and returns:
//   - notifications: new alerts to add to the notification center (and to
//     post as Android notifications),
//   - state:         the updated de-duplication state,
//   - schedule:      future reminders for Android AlarmManager, computed with
//                    the CURRENT outstanding amount (so partial payments show
//                    the remaining balance, and paid invoices have none).
//
// De-duplication rules
//   Low stock: one alert when a product becomes low. Re-armed only after its
//              stock goes back above the minimum.
//   Due:       one alert per invoice per reminder offset (e.g. 3 days before,
//              on due date). Keyed by invoice + due date + offset, so editing
//              the due date re-arms reminders.
//   Overdue:   one alert per invoice per due date.
//   Snooze:    state.snooze[docId] = ISO date; no due/overdue alerts until then.

import { addDays, daysBetween } from './dates.js';

export const ALERT_TYPES = {
  lowstock: 'Low Stock',
  due: 'Payment Due',
  overdue: 'Payment Overdue',
  backup: 'Backup Reminder',
  update: 'App Update',
  system: 'System Alerts',
};

export function emptyAlertState() {
  return { low: {}, due: {}, overdue: {}, snooze: {} };
}

function reminderOffsets(doc, settings) {
  const r = doc.reminders;
  const offsets = r && Array.isArray(r.offsets) ? r.offsets : settings.notifications.reminderOffsets || [0];
  return [...new Set(offsets.map((n) => Math.max(0, Math.min(60, Math.trunc(n) || 0))))];
}

/**
 * @param store   BizStore (or compatible)
 * @param state   previous alert state
 * @param today   ISO date
 * @param money   formatter (paise -> string)
 */
export function evaluateAlerts(store, state, today, money, qty = (q) => String(q / 1000)) {
  const s = store.settings;
  const n = s.notifications;
  const next = {
    low: { ...(state && state.low) },
    due: { ...(state && state.due) },
    overdue: { ...(state && state.overdue) },
    snooze: { ...(state && state.snooze) },
  };
  const out = [];
  const schedule = [];

  // ---- low stock
  const seen = new Set();
  for (const p of store.listProducts()) {
    seen.add(p.id);
    const tracked = p.trackStock && p.lowStockAlert !== false && (p.minStock || 0) > 0;
    const cur = store.stockOf(p.id).current;
    const low = tracked && cur <= p.minStock;
    if (!low) { delete next.low[p.id]; continue; }
    if (next.low[p.id]) continue;
    next.low[p.id] = { at: today, stock: cur };
    out.push({
      type: 'lowstock', relatedType: 'product', relatedId: p.id,
      title: 'Low Stock Alert',
      message: `Product: ${p.name}\nCurrent Stock: ${qty(cur)} ${p.unit || ''}\nMinimum Stock: ${qty(p.minStock)} ${p.unit || ''}`.trim(),
      route: '#/product/' + p.id,
      actions: [{ label: 'View Product', route: '#/product/' + p.id }, { label: 'View Inventory', route: '#/inventory?filter=low' }],
      fullScreen: !!n.fullScreenLowStock,
    });
  }
  for (const id of Object.keys(next.low)) if (!seen.has(id)) delete next.low[id];

  // ---- payment due / overdue (sales = receivable, purchases = payable)
  const openKeys = new Set();
  for (const kind of ['sale', 'purchase']) {
    for (const d of store.listDocuments(kind)) {
      if (d.status === 'cancelled' || !d.dueDate) continue;
      const due = store.docDue(d);
      if (due <= 0) continue;
      const party = d.party.name || 'Customer';
      const isSale = kind === 'sale';
      const total = d.totals.grandTotal;
      const paid = total - due;
      const snoozed = next.snooze[d.id] && next.snooze[d.id] > today;
      const actions = [
        { label: 'Record Payment', route: `#/payment/new/${isSale ? 'in' : 'out'}?party=${d.partyId}&doc=${d.id}` },
        { label: 'View Invoice', route: '#/doc/' + d.id },
        { label: 'View Ledger', route: `#/party/${d.partyId}/ledger` },
      ];
      const lines = (heading) => [
        `${isSale ? 'Customer' : 'Supplier'}: ${party}`,
        `${isSale ? 'Invoice' : 'Bill'}: ${d.number}${d.refNo ? ' (' + d.refNo + ')' : ''}`,
        `Outstanding: ${money(due)}${paid > 0 ? ` (of ${money(total)})` : ''}`,
        heading,
      ].join('\n');

      if (today > d.dueDate) {
        const key = d.id + '|' + d.dueDate;
        openKeys.add(key);
        if (!next.overdue[key] && !snoozed) {
          next.overdue[key] = today;
          const days = daysBetween(d.dueDate, today);
          out.push({
            type: 'overdue', relatedType: 'document', relatedId: d.id,
            title: isSale ? 'Payment Overdue' : 'Supplier Payment Overdue',
            message: lines(`Due Date: ${d.dueDate} · ${days} day(s) overdue`),
            amount: due, route: '#/doc/' + d.id, actions, fullScreen: !!n.fullScreen, daysOverdue: days,
          });
        }
        continue;
      }
      for (const off of reminderOffsets(d, s)) {
        const when = addDays(d.dueDate, -off);
        const key = `${d.id}|${d.dueDate}|${off}`;
        openKeys.add(key);
        const title = off === 0 ? (isSale ? 'Payment Due Today' : 'Supplier Payment Due Today')
          : `${isSale ? 'Payment' : 'Supplier payment'} due in ${off} day${off > 1 ? 's' : ''}`;
        const payload = {
          type: 'due', relatedType: 'document', relatedId: d.id, title,
          message: lines(`Due Date: ${d.dueDate}`), amount: due, route: '#/doc/' + d.id, actions, fullScreen: !!n.fullScreen,
        };
        if (when <= today) {
          if (!next.due[key] && !snoozed) { next.due[key] = today; out.push(payload); }
        } else {
          schedule.push({ key, date: when, ...payload });
        }
      }
      // Overdue moment itself (the day after the due date).
      schedule.push({
        key: `${d.id}|${d.dueDate}|overdue`, date: addDays(d.dueDate, 1), type: 'overdue', relatedType: 'document', relatedId: d.id,
        title: isSale ? 'Payment Overdue' : 'Supplier Payment Overdue', message: lines(`Due Date: ${d.dueDate} · now overdue`),
        amount: due, route: '#/doc/' + d.id, actions, fullScreen: !!n.fullScreen,
      });
    }
  }
  // Forget keys of invoices that are paid / cancelled / re-dated.
  for (const k of Object.keys(next.due)) if (!openKeys.has(k)) delete next.due[k];
  for (const k of Object.keys(next.overdue)) if (!openKeys.has(k)) delete next.overdue[k];
  for (const [id, until] of Object.entries(next.snooze)) if (until <= today) delete next.snooze[id];

  // Respect per-type switches.
  const allowed = (t) => (t === 'lowstock' ? n.lowStock : t === 'due' ? n.paymentDue : t === 'overdue' ? n.overdue !== false : true);
  return {
    notifications: out.filter((x) => allowed(x.type)),
    state: next,
    schedule: schedule.filter((x) => allowed(x.type)),
  };
}

/** Invoices/bills with outstanding amounts and due dates, for dashboard & lists. */
export function dueSummary(store, today) {
  const dueToday = [];
  const overdue = [];
  const upcoming = [];
  for (const kind of ['sale', 'purchase']) {
    for (const d of store.listDocuments(kind)) {
      if (d.status === 'cancelled' || !d.dueDate) continue;
      const due = store.docDue(d);
      if (due <= 0) continue;
      const row = { doc: d, due, daysOverdue: Math.max(0, daysBetween(d.dueDate, today)) };
      if (d.dueDate === today) dueToday.push(row);
      else if (d.dueDate < today) overdue.push(row);
      else upcoming.push(row);
    }
  }
  const byDate = (a, b) => (a.doc.dueDate < b.doc.dueDate ? -1 : 1);
  return { dueToday: dueToday.sort(byDate), overdue: overdue.sort(byDate), upcoming: upcoming.sort(byDate) };
}
