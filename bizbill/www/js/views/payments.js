// Payments (received / made), allocation to invoices, receipts, and
// outstanding receivables / payables with aging.

import { h, icon, clear, debounce, put } from '../ui/dom.js';
import {
  field, textInput, moneyInput, dateInput, selectInput, textArea, readMoney, toast, errorToast, lazyList, emptyState,
  confirmDialog, promptDialog, pickerDialog, rangeChips, kv,
} from '../ui/components.js';
import { fmt, remember, rangeState, rangeOf, rangeLabel } from './common.js';
import { PAYMENT_METHODS } from '../core/settings.js';
import { matches } from '../core/search.js';
import { inRange, today } from '../core/dates.js';
import { paiseToInput, sum } from '../core/money.js';
import { AGING_BUCKETS, drCr } from '../core/ledger.js';
import { outstandingRows, runReport } from '../core/reports.js';
import { receiptSpec, shareMenu, runDocAction, reportSpec } from '../docs/actions.js';
import { shareText } from '../platform/bridge.js';

export function paymentList({ store }, params, query) {
  const f = fmt(store);
  const state = remember('payments', { dir: 'in', q: '', method: '' });
  if (query.dir) state.dir = query.dir;
  const range = rangeState('payments', 'month');
  const host = h('div');
  const summary = h('div', { class: 'small muted', style: { margin: '0 2px 8px' } });
  const tabs = h('div', { class: 'chips' });
  const draw = () => {
    clear(tabs);
    for (const [v, l] of [['in', 'Received'], ['out', 'Paid']]) tabs.appendChild(h('button', { class: 'chip' + (state.dir === v ? ' active' : ''), onclick: () => { state.dir = v; draw(); } }, l));
    for (const m of PAYMENT_METHODS.filter((x) => x !== 'Credit')) tabs.appendChild(h('button', { class: 'chip' + (state.method === m ? ' active' : ''), onclick: () => { state.method = state.method === m ? '' : m; draw(); } }, m));
    const r = rangeOf(range);
    const list = store.listPayments(state.dir).filter((p) => inRange(p.date, r) && (!state.method || p.method === state.method)
      && matches(state.q, p.number, p.partyName, p.reference, p.notes, p.method));
    summary.textContent = `${list.length} payment(s) · ${f.money(sum(list.filter((p) => p.status !== 'cancelled'), (p) => p.amount))} · ${rangeLabel(store, range)}`;
    clear(host);
    host.appendChild(list.length ? lazyList(list, (p) => h('a', { class: 'item', href: '#/payment/' + p.id },
      h('div', { class: 'avatar' }, icon(p.direction === 'in' ? 'in' : 'out')),
      h('div', { class: 'main' }, h('div', { class: 'title' }, p.partyName || '—'), h('div', { class: 'subtitle' }, [p.number, f.date(p.date), p.method, p.reference].filter(Boolean).join(' · '))),
      h('div', { class: 'end' }, h('div', { class: 'amount ' + (p.status === 'cancelled' ? 'muted' : p.direction === 'in' ? 'pos' : 'neg') }, f.money(p.amount)), p.status === 'cancelled' ? h('span', { class: 'badge cancelled' }, 'Cancelled') : null)))
      : emptyState('wallet', 'No payments in this period'));
  };
  draw();
  return {
    title: 'Payments',
    content: h('div', null,
      h('div', { class: 'grid2', style: { marginBottom: '10px' } },
        h('a', { class: 'kpi', href: '#/receivables' }, h('div', { class: 'label' }, icon('in'), 'To receive'), h('div', { class: 'value pos' }, f.money(outstandingRows(store, 'customer').reduce((a, r) => a + Math.max(0, r.balance), 0)))),
        h('a', { class: 'kpi', href: '#/payables' }, h('div', { class: 'label' }, icon('out'), 'To pay'), h('div', { class: 'value neg' }, f.money(outstandingRows(store, 'supplier').reduce((a, r) => a + Math.max(0, r.balance), 0))))),
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Search party, reference, number…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      rangeChips(range, () => draw()), tabs, summary, host),
    fab: { href: '#/payment/new/' + state.dir, icon: 'plus', text: state.dir === 'in' ? 'Receive' : 'Pay', label: 'New payment' },
  };
}

// ------------------------------------------------------------------ form

export function paymentForm({ store, app }, params, query) {
  const f = fmt(store);
  const existing = params.id ? store.payments.get(params.id) : null;
  if (params.id && !existing) throw new Error('Payment not found');
  if (existing && existing.status === 'cancelled') throw new Error('Cancelled payments cannot be edited');
  const dir = existing ? existing.direction : params.dir === 'out' ? 'out' : 'in';
  const partyType = dir === 'in' ? 'customer' : 'supplier';
  let partyId = existing ? existing.partyId : query.party || '';
  let dirty = false;
  const allocInputs = new Map(); // docId -> input

  const amount = moneyInput('amount', existing ? existing.amount : 0, { required: true });
  const date = dateInput('date', existing ? existing.date : today());
  const method = selectInput('method', PAYMENT_METHODS.filter((m) => m !== 'Credit'), existing ? existing.method : store.settings.billing.defaultPaymentMethod === 'Credit' ? 'Cash' : store.settings.billing.defaultPaymentMethod);
  const reference = textInput('reference', existing ? existing.reference : '', { placeholder: 'UTR / cheque no. / transaction id' });
  const notes = textArea('notes', existing ? existing.notes : '', { rows: 2 });
  const number = textInput('number', existing ? existing.number : store.peekNumber(dir === 'in' ? 'receipt' : 'voucher'));
  const partyBox = h('div');
  const allocBox = h('div');
  const allocSummary = h('div', { class: 'small' });

  const pickParty = async () => {
    const picked = await pickerDialog({
      title: 'Select ' + partyType,
      items: store.listParties(partyType),
      label: (p) => p.name,
      sub: (p) => [p.mobile, p.city].filter(Boolean).join(' · '),
      end: (p) => { const b = store.account(p.id).balance; return b ? f.money(Math.abs(b)) + (b < 0 ? ' adv' : '') : ''; },
      search: (p) => [p.name, p.mobile, p.gstin].join(' '),
    });
    if (!picked) return;
    partyId = picked.id;
    dirty = true;
    paintParty();
    paintAlloc(true);
  };

  const paintParty = () => {
    clear(partyBox);
    const p = partyId ? store.parties.get(partyId) : null;
    if (p) {
      const bal = store.account(p.id).balance;
      put(partyBox, h('div', { class: 'item', style: { padding: '8px 0', borderBottom: 0 } },
        h('div', { class: 'avatar' }, icon(partyType === 'customer' ? 'users' : 'truck')),
        h('div', { class: 'main' }, h('div', { class: 'title' }, p.name), h('div', { class: 'subtitle' }, bal ? `${bal > 0 ? (dir === 'in' ? 'Receivable' : 'Payable') : 'Advance'} ${f.money(Math.abs(bal))}` : 'No balance')),
        !existing ? h('button', { class: 'btn small', onclick: pickParty }, 'Change') : null));
    } else {
      put(partyBox, h('button', { class: 'btn primary block', onclick: pickParty }, icon(partyType === 'customer' ? 'users' : 'truck'), 'Select ' + partyType));
    }
  };

  const updateSummary = () => {
    const amt = readMoney(amount).value;
    let alloc = 0;
    for (const inp of allocInputs.values()) alloc += readMoney(inp).value;
    const rest = amt - alloc;
    allocSummary.textContent = allocInputs.size ? `Allocated ${f.money(alloc)} · ${rest >= 0 ? 'Unallocated (advance / older dues) ' + f.money(rest) : 'Over-allocated by ' + f.money(-rest)}` : '';
    allocSummary.className = 'small ' + (rest < 0 ? 'neg' : 'muted');
  };

  const paintAlloc = (auto) => {
    clear(allocBox);
    allocInputs.clear();
    if (!partyId) return;
    const open = store.openDocsFor(partyId, dir, existing ? existing.id : null);
    if (!open.length) {
      put(allocBox, h('p', { class: 'small muted' }, 'No unpaid bills. The amount will be recorded as an advance / against opening balance.'));
      return;
    }
    const current = new Map((existing ? existing.allocations : []).map((a) => [a.docId, a.amount]));
    const preselect = query.doc && !existing ? query.doc : '';
    let proposal = new Map();
    if (auto && !existing) {
      const amt = readMoney(amount).value;
      if (preselect) {
        const x = open.find((o) => o.doc.id === preselect);
        if (x) { proposal.set(preselect, amt ? Math.min(amt, x.due) : x.due); if (!amt) amount.value = paiseToInput(x.due); }
      } else if (amt) {
        proposal = new Map(store.autoAllocate(partyId, dir, amt).map((a) => [a.docId, a.amount]));
      }
    }
    for (const { doc, due } of open) {
      const val = current.get(doc.id) ?? proposal.get(doc.id) ?? 0;
      const inp = moneyInput('alloc-' + doc.id, val, { 'aria-label': 'Allocate to ' + doc.number, style: { maxWidth: '130px' } });
      inp.addEventListener('input', () => { dirty = true; updateSummary(); });
      allocInputs.set(doc.id, inp);
      put(allocBox, h('div', { class: 'item', style: { padding: '8px 0' } },
        h('div', { class: 'main' }, h('div', { class: 'title' }, doc.number), h('div', { class: 'subtitle' }, `${f.date(doc.date)} · Due ${f.money(due)}`)),
        h('button', { class: 'btn small', onclick: () => { inp.value = paiseToInput(due); dirty = true; updateSummary(); } }, 'Full'), inp));
    }
    put(allocBox, h('div', { class: 'btn-row', style: { marginTop: '6px' } },
      h('button', { class: 'btn small', onclick: () => {
        const amt = readMoney(amount).value;
        const auto2 = new Map(store.autoAllocate(partyId, dir, amt, existing ? existing.id : null).map((a) => [a.docId, a.amount]));
        for (const [id, inp] of allocInputs) inp.value = auto2.get(id) ? paiseToInput(auto2.get(id)) : '';
        dirty = true; updateSummary();
      } }, 'Auto allocate (oldest first)'),
      h('button', { class: 'btn small', onclick: () => { for (const inp of allocInputs.values()) inp.value = ''; dirty = true; updateSummary(); } }, 'Clear')));
    updateSummary();
  };

  amount.addEventListener('input', () => { dirty = true; updateSummary(); });
  amount.addEventListener('change', () => { if (!existing && allocInputs.size && [...allocInputs.values()].every((i) => !i.value)) paintAlloc(true); });
  for (const i of [date, method, reference, notes, number]) i.addEventListener('input', () => { dirty = true; });

  paintParty();
  paintAlloc(true);

  const save = async () => {
    const amt = readMoney(amount, { required: true });
    if (amt.error) { toast(amt.error, 'bad'); return; }
    const allocations = [];
    for (const [docId, inp] of allocInputs) {
      const r = readMoney(inp, { label: 'Allocation' });
      if (r.error) { toast(r.error, 'bad'); return; }
      if (r.value > 0) allocations.push({ docId, amount: r.value });
    }
    try {
      const saved = await store.savePayment({
        id: existing ? existing.id : undefined, direction: dir, partyId, number: number.value, date: date.value,
        amount: amt.value, method: method.value, reference: reference.value, notes: notes.value, allocations,
      });
      dirty = false;
      toast('Payment saved', 'good');
      app.navigate('#/payment/' + saved.id, { replace: true });
    } catch (e) { errorToast(e); }
  };

  return {
    title: existing ? 'Edit payment' : dir === 'in' ? 'Receive payment' : 'Make payment',
    back: true,
    nav: false,
    hideSearch: true,
    dirty: () => dirty,
    content: h('div', { class: 'form' },
      h('div', { class: 'card' }, h('h2', null, dir === 'in' ? 'Received from' : 'Paid to'), partyBox),
      h('div', { class: 'card form' },
        h('div', { class: 'row' }, field('Amount', amount, { required: true }), field('Date', date)),
        h('div', { class: 'row' }, field('Method', method), field(dir === 'in' ? 'Receipt no.' : 'Voucher no.', number)),
        field('Reference', reference),
        field('Notes', notes)),
      h('div', { class: 'card' }, h('h2', null, 'Apply to bills'), allocBox, allocSummary)),
    footer: h('div', { class: 'savebar' }, h('div', { class: 'total' }), h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Save')),
  };
}

// ------------------------------------------------------------------ view

export function paymentView({ store, app }, params) {
  const f = fmt(store);
  const p = store.payments.get(params.id);
  if (!p) throw new Error('Payment not found');
  const party = store.parties.get(p.partyId);
  const spec = () => receiptSpec(store, store.payments.get(p.id));
  const allocated = sum(p.allocations || [], (a) => a.amount);
  const act = (ic, label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, icon(ic), label);
  return {
    title: `${p.direction === 'in' ? 'Receipt' : 'Payment'} ${p.number}`,
    back: true,
    content: h('div', null,
      p.status === 'cancelled' ? h('div', { class: 'note bad', style: { marginBottom: '12px' } }, 'Cancelled' + (p.cancelReason ? ': ' + p.cancelReason : '')) : null,
      h('div', { class: 'card' },
        h('div', { class: 'doc-head' },
          h('div', null, h('div', { class: 'small muted' }, p.direction === 'in' ? 'Received from' : 'Paid to'),
            h('h2', null, party ? h('a', { href: '#/party/' + party.id }, p.partyName) : p.partyName),
            h('div', { class: 'small muted' }, [f.date(p.date), p.method, p.reference].filter(Boolean).join(' · '))),
          h('div', { class: 'big ' + (p.direction === 'in' ? 'pos' : 'neg') }, f.money(p.amount)))),
      h('div', { class: 'actions-grid', style: { marginBottom: '12px' } },
        act('share', 'Share', () => shareMenu(spec())),
        act('whatsapp', 'WhatsApp', () => runDocAction(spec(), 'whatsapp')),
        act('print', 'Print', () => runDocAction(spec(), 'print')),
        p.status !== 'cancelled' ? act('edit', 'Edit', () => app.navigate(`#/payment/${p.id}/edit`)) : null,
        p.status !== 'cancelled' ? act('ban', 'Cancel', async () => {
          const ok = await confirmDialog({ title: 'Cancel payment?', message: 'The payment is kept (marked CANCELLED) and its amount is removed from the party balance and bills. This cannot be undone.', details: [`${p.number} · ${f.money(p.amount)} · ${p.partyName}`, ...(p.allocations || []).map((a) => `Bill ${store.documents.get(a.docId)?.number || ''} becomes due again by ${f.money(a.amount)}`)], confirmText: 'Continue', danger: true });
          if (!ok) return;
          const reason = await promptDialog({ title: 'Reason', label: 'Reason for cancellation', placeholder: 'e.g. Cheque bounced' });
          if (!reason) return;
          try { await store.cancelPayment(p.id, reason); toast('Payment cancelled'); app.refresh(); } catch (e) { errorToast(e); }
        }, 'danger') : null),
      h('div', { class: 'card' }, kv([
        ['Number', p.number],
        ['Amount', f.money(p.amount), true],
        ['Allocated to bills', f.money(allocated)],
        p.amount - allocated > 0 ? ['Advance / older dues', f.money(p.amount - allocated)] : null,
        p.notes ? ['Notes', p.notes] : null,
      ])),
      (p.allocations || []).length ? h('div', null, h('div', { class: 'section-title' }, 'Applied to'), h('div', { class: 'list' }, p.allocations.map((a) => {
        const d = store.documents.get(a.docId);
        return h('a', { class: 'item', href: d ? '#/doc/' + d.id : '#' }, h('div', { class: 'main' }, h('div', { class: 'title' }, d ? d.number : 'Deleted document'), h('div', { class: 'subtitle' }, d ? f.date(d.date) + (d.status === 'cancelled' ? ' · cancelled' : '') : '')), h('div', { class: 'end amount' }, f.money(a.amount)));
      }))) : null),
  };
}

// ------------------------------------------------------------------ outstanding

export const receivables = (ctx) => outstanding(ctx, 'customer');
export const payables = (ctx) => outstanding(ctx, 'supplier');

function outstanding({ store }, type) {
  const f = fmt(store);
  const rows = outstandingRows(store, type);
  const positive = rows.filter((r) => r.balance > 0);
  const total = sum(positive, (r) => r.balance);
  const aging = [0, 1, 2, 3, 4].map((i) => sum(positive, (r) => r['a' + i]));
  const state = remember('outstanding:' + type, { q: '' });
  const host = h('div');
  const draw = () => {
    const list = rows.filter((r) => matches(state.q, r.label, r.mobile));
    clear(host);
    host.appendChild(list.length ? lazyList(list, (r) => {
      const party = store.parties.get(r.id);
      return h('div', { class: 'item' },
        h('a', { class: 'main', href: '#/party/' + r.id, style: { color: 'inherit', textDecoration: 'none' } },
          h('div', { class: 'title' }, r.label),
          h('div', { class: 'subtitle' }, r.balance < 0 ? 'Advance' : AGING_BUCKETS.map((b, i) => (r['a' + i] ? `${b.replace(' days', 'd')}: ${f.plain(r['a' + i])}` : '')).filter(Boolean).join(' · '))),
        h('div', { class: 'end' }, h('div', { class: 'amount ' + (r.balance > 0 ? (type === 'customer' ? 'pos' : 'neg') : 'muted') }, `${f.money(Math.abs(r.balance))} ${drCr(r.balance, type === 'supplier')}`),
          type === 'customer' && r.balance > 0 && party && (party.whatsapp || party.mobile)
            ? h('button', { class: 'btn small', onclick: () => shareText(`Dear ${party.name},\nA balance of ${f.money(r.balance)} is outstanding on your account with ${store.settings.company.name || 'us'}.${store.settings.company.upiId ? '\nUPI: ' + store.settings.company.upiId : ''}\nThank you.`, { target: 'whatsapp', phone: party.whatsapp || party.mobile }) }, icon('whatsapp'), 'Remind')
            : h('a', { class: 'btn small', href: `#/payment/new/${type === 'customer' ? 'in' : 'out'}?party=${r.id}` }, type === 'customer' ? 'Receive' : 'Pay')));
    }) : emptyState('wallet', 'Nothing outstanding'));
  };
  draw();
  const pdf = () => {
    const id = type === 'customer' ? 'fin-receivables' : 'fin-payables';
    shareMenu(reportSpec(store, type === 'customer' ? 'Receivables (Aging)' : 'Payables (Aging)', 'As on ' + f.date(today()), runReport(store, id, { from: '0000-01-01', to: '9999-12-31' })), { jpg: false });
  };
  return {
    title: type === 'customer' ? 'Receivables' : 'Payables',
    back: true,
    content: h('div', null,
      h('div', { class: 'card' },
        h('div', { class: 'small muted' }, type === 'customer' ? 'Total to receive' : 'Total to pay'),
        h('div', { class: 'big ' + (type === 'customer' ? 'pos' : 'neg'), style: { fontSize: '1.5rem', fontWeight: 800 } }, f.money(total)),
        h('div', { class: 'aging', style: { marginTop: '10px' } }, AGING_BUCKETS.map((b, i) => h('div', null, b, h('b', null, f.plain(aging[i])))))),
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Search…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      host),
    actions: [{ icon: 'print', label: 'Aging report', onClick: pdf }],
  };
}
