// In-app Notification Center and the payment Dues view.

import { h, icon, clear, put } from '../ui/dom.js';
import { lazyList, emptyState, confirmDialog, chooseDialog, toast } from '../ui/components.js';
import { fmt, remember } from './common.js';
import { ALERT_TYPES, dueSummary } from '../core/alerts.js';
import { today, addDays } from '../core/dates.js';
import { notificationStatus, openNotificationSettings } from '../platform/bridge.js';
import { reminderCardSpec, shareMenu } from '../docs/actions.js';

const TYPE_ICONS = { lowstock: 'box', due: 'calendar', overdue: 'alert', backup: 'download', update: 'refresh', system: 'info' };

export function permissionWarning(store) {
  const n = store.settings.notifications;
  if (!n.enabled) return null;
  const st = notificationStatus();
  if (st.enabled) return null;
  return h('div', { class: 'note warn', style: { marginBottom: '10px' } },
    'Notifications are disabled. Enable notifications in Android Settings to receive payment and stock alerts. ',
    h('button', { class: 'btn small', onclick: () => openNotificationSettings('app') }, 'Open settings'));
}

export function notificationCenter({ store, app }) {
  const state = remember('notif', { type: '' });
  const host = h('div');
  const chips = h('div', { class: 'chips' });
  const draw = () => {
    clear(chips);
    const counts = {};
    for (const x of store.listNotifications()) if (!x.read) counts[x.type] = (counts[x.type] || 0) + 1;
    put(chips, h('button', { class: 'chip' + (!state.type ? ' active' : ''), onclick: () => { state.type = ''; draw(); } }, 'All'));
    for (const [k, l] of Object.entries(ALERT_TYPES)) {
      put(chips, h('button', { class: 'chip' + (state.type === k ? ' active' : ''), onclick: () => { state.type = k; draw(); } }, l + (counts[k] ? ` (${counts[k]})` : '')));
    }
    const list = store.listNotifications(state.type);
    clear(host);
    put(host, list.length ? lazyList(list, (x) => h('div', { class: 'item notif' + (x.read ? '' : ' unread') },
      h('div', { class: 'avatar' }, icon(TYPE_ICONS[x.type] || 'bell')),
      h('button', { class: 'main', style: { background: 'none', border: 0, textAlign: 'left', padding: 0, cursor: 'pointer', color: 'inherit' }, onclick: async () => {
        await store.setNotificationRead(x.id, true);
        if (x.route) app.navigate(x.route); else draw();
      } },
      h('div', { class: 'title' }, x.title),
      h('div', { class: 'subtitle' }, x.message),
      h('div', { class: 'small muted' }, `${ALERT_TYPES[x.type] || x.type} · ${new Date(x.ts).toLocaleString()}`)),
      h('div', { class: 'end' },
        h('button', { class: 'icon-btn', 'aria-label': x.read ? 'Mark as unread' : 'Mark as read', title: x.read ? 'Mark as unread' : 'Mark as read', onclick: async () => { await store.setNotificationRead(x.id, !x.read); draw(); } }, icon(x.read ? 'eye' : 'check')),
        h('button', { class: 'icon-btn', 'aria-label': 'Delete notification', onclick: async () => { await store.deleteNotification(x.id); draw(); } }, icon('trash')))))
      : emptyState('bell', 'No notifications'));
  };
  draw();
  return {
    title: 'Notifications',
    back: true,
    hideSearch: true,
    content: h('div', null, permissionWarning(store), chips, host),
    actions: [
      { icon: 'check', label: 'Mark all as read', onClick: async () => { await store.markAllNotificationsRead(); draw(); } },
      { icon: 'trash', label: 'Delete read notifications', onClick: async () => {
        const read = store.listNotifications().filter((x) => x.read);
        if (!read.length) { toast('No read notifications'); return; }
        if (!(await confirmDialog({ title: 'Delete read notifications?', message: `${read.length} read notification(s) will be removed. Your business records are not affected.`, confirmText: 'Delete', danger: true }))) return;
        for (const x of read) await store.deleteNotification(x.id);
        draw();
      } },
      { icon: 'settings', label: 'Notification settings', onClick: () => app.navigate('#/settings/notifications') },
    ],
  };
}

export function duesView({ store }, params, query) {
  const f = fmt(store);
  const state = remember('dues', { tab: 'overdue', kind: 'sale' });
  if (query.f) state.tab = query.f;
  const host = h('div');
  const chips = h('div', { class: 'chips' });
  const draw = () => {
    const t = today();
    const sum = dueSummary(store, t);
    const pick = (rows) => rows.filter((r) => r.doc.kind === state.kind);
    clear(chips);
    for (const [k, l, rows] of [['today', 'Due today', sum.dueToday], ['overdue', 'Overdue', sum.overdue], ['upcoming', 'Upcoming', sum.upcoming]]) {
      put(chips, h('button', { class: 'chip' + (state.tab === k ? ' active' : ''), onclick: () => { state.tab = k; draw(); } }, `${l} (${pick(rows).length})`));
    }
    put(chips, h('button', { class: 'chip', onclick: () => { state.kind = state.kind === 'sale' ? 'purchase' : 'sale'; draw(); } }, state.kind === 'sale' ? 'Receivable (customers)' : 'Payable (suppliers)'));
    const rows = pick(state.tab === 'today' ? sum.dueToday : state.tab === 'overdue' ? sum.overdue : sum.upcoming);
    const total = rows.reduce((a, r) => a + r.due, 0);
    clear(host);
    put(host,
      h('div', { class: 'card' }, h('div', { class: 'small muted' }, 'Total outstanding'), h('div', { style: { fontSize: '1.4rem', fontWeight: 800 } }, f.money(total))),
      rows.length ? lazyList(rows, (r) => {
        const d = r.doc;
        const paid = d.totals.grandTotal - r.due;
        const isSale = d.kind === 'sale';
        return h('div', { class: 'item', style: { flexWrap: 'wrap' } },
          h('a', { class: 'main', href: '#/doc/' + d.id, style: { color: 'inherit', textDecoration: 'none' } },
            h('div', { class: 'title' }, d.party.name),
            h('div', { class: 'subtitle' }, `${d.number} · Due ${f.date(d.dueDate)}${r.daysOverdue ? ` · ${r.daysOverdue} days overdue` : ''}`),
            h('div', { class: 'small muted' }, `Total ${f.money(d.totals.grandTotal)} · Paid ${f.money(paid)}`)),
          h('div', { class: 'end' }, h('div', { class: 'amount ' + (r.daysOverdue ? 'neg' : '') }, f.money(r.due)), r.daysOverdue ? h('span', { class: 'badge unpaid' }, 'Overdue') : null),
          h('div', { class: 'btn-row', style: { width: '100%', marginTop: '8px' } },
            h('a', { class: 'btn small primary', href: `#/payment/new/${isSale ? 'in' : 'out'}?party=${d.partyId}&doc=${d.id}` }, 'Record Payment'),
            isSale ? h('button', { class: 'btn small', onclick: () => shareMenu(reminderCardSpec(store, d)) }, icon('whatsapp'), 'Send Reminder') : null,
            h('a', { class: 'btn small', href: `#/party/${d.partyId}/ledger` }, 'Ledger'),
            h('button', { class: 'btn small', onclick: async () => {
              const days = await chooseDialog('Snooze alerts for', [{ value: 1, label: '1 day' }, { value: 3, label: '3 days' }, { value: 7, label: '1 week' }]);
              if (!days) return;
              await store.snoozeDocument(d.id, addDays(t, days));
              toast(`Alerts snoozed for ${days} day(s)`);
            } }, 'Snooze')));
      }) : emptyState('calendar', state.tab === 'overdue' ? 'Nothing overdue' : 'Nothing due'));
  };
  draw();
  return { title: 'Payment Dues', back: true, content: h('div', null, chips, host) };
}
