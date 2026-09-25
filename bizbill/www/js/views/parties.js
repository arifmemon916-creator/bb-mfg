// Customers & suppliers (one party master): list, form, detail, ledger.

import { h, icon, clear, debounce, initials, put } from '../ui/dom.js';
import {
  field, textInput, moneyInput, dateInput, selectInput, textArea, readMoney, toast, errorToast,
  lazyList, emptyState, confirmDialog, rangeChips, kv, chooseDialog,
} from '../ui/components.js';
import { fmt, remember, rangeState, rangeOf, amountClass } from './common.js';
import { STATES, stateName } from '../core/states.js';
import { matches } from '../core/search.js';
import { ledgerStatement, drCr, AGING_BUCKETS } from '../core/ledger.js';
import { gstinError, mobileError } from '../core/validate.js';
import { exportParties } from '../core/csv.js';
import { ledgerSpec, shareMenu, runDocAction } from '../docs/actions.js';
import { shareText, saveFile } from '../platform/bridge.js';
import { today } from '../core/dates.js';

const META = {
  customer: { title: 'Customers', one: 'Customer', icon: 'users', docKind: 'sale', docLabel: 'Invoices' },
  supplier: { title: 'Suppliers', one: 'Supplier', icon: 'truck', docKind: 'purchase', docLabel: 'Purchases' },
};

export const customerList = (ctx) => partyList(ctx, 'customer');
export const supplierList = (ctx) => partyList(ctx, 'supplier');

function partyList({ store }, type) {
  const f = fmt(store);
  const meta = META[type];
  const state = remember('parties:' + type, { q: '', filter: 'all', sort: 'name' });
  const host = h('div');
  const summary = h('div', { class: 'small muted', style: { margin: '0 2px 8px' } });
  const draw = () => {
    let list = store.listParties(type).filter((p) => matches(state.q, p.name, p.mobile, p.whatsapp, p.gstin, p.city, p.email));
    const bal = (p) => store.account(p.id).balance;
    if (state.filter === 'due') list = list.filter((p) => bal(p) > 0);
    if (state.filter === 'advance') list = list.filter((p) => bal(p) < 0);
    if (state.filter === 'gst') list = list.filter((p) => p.gstin);
    if (state.filter === 'overlimit') list = list.filter((p) => p.creditLimit && bal(p) > p.creditLimit);
    if (state.sort === 'balance') list.sort((a, b) => bal(b) - bal(a));
    const total = list.reduce((a, p) => a + Math.max(0, bal(p)), 0);
    summary.textContent = `${list.length} ${meta.title.toLowerCase()} · ${type === 'customer' ? 'To receive' : 'To pay'} ${f.money(total)}`;
    clear(host);
    host.appendChild(list.length ? lazyList(list, (p) => {
      const b = bal(p);
      return h('a', { class: 'item', href: '#/party/' + p.id },
        h('div', { class: 'avatar' }, initials(p.name)),
        h('div', { class: 'main' }, h('div', { class: 'title' }, p.name), h('div', { class: 'subtitle' }, [p.mobile, p.city, p.gstin].filter(Boolean).join(' · ') || '—')),
        h('div', { class: 'end' }, h('div', { class: 'amount ' + (b > 0 ? (type === 'customer' ? 'pos' : 'neg') : '') }, b ? f.money(Math.abs(b)) : '—'),
          b ? h('div', { class: 'small muted' }, b > 0 ? (type === 'customer' ? 'to receive' : 'to pay') : 'advance') : null));
    }) : emptyState(meta.icon, state.q ? 'No matches' : `No ${meta.title.toLowerCase()} yet`, h('a', { class: 'btn primary', href: '#/party/new/' + type }, icon('plus'), 'Add ' + meta.one)));
  };
  const chips = h('div', { class: 'chips' });
  const filters = [['all', 'All'], ['due', type === 'customer' ? 'To receive' : 'To pay'], ['advance', 'Advance'], ['gst', 'Has GSTIN'], ...(type === 'customer' ? [['overlimit', 'Over credit limit']] : [])];
  const paint = () => {
    clear(chips);
    for (const [v, l] of filters) chips.appendChild(h('button', { class: 'chip' + (state.filter === v ? ' active' : ''), onclick: () => { state.filter = v; paint(); draw(); } }, l));
    chips.appendChild(h('button', { class: 'chip', onclick: () => { state.sort = state.sort === 'name' ? 'balance' : 'name'; paint(); draw(); } }, 'Sort: ' + (state.sort === 'name' ? 'Name' : 'Balance')));
  };
  paint();
  draw();
  return {
    title: meta.title,
    content: h('div', null,
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Search name, mobile, GSTIN…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      chips, summary, host),
    actions: [{ icon: 'download', label: 'Export CSV', onClick: () => saveFile(new Blob([exportParties(store, type)], { type: 'text/csv' }), `${meta.title}_${today()}.csv`) }],
    fab: { href: '#/party/new/' + type, icon: 'plus', text: meta.one, label: 'Add ' + meta.one },
  };
}

// ------------------------------------------------------------------ form

export function partyForm({ store, app }, params) {
  const existing = params.id ? store.parties.get(params.id) : null;
  if (params.id && !existing) throw new Error('Party not found');
  const type = existing ? existing.type : params.type === 'supplier' ? 'supplier' : 'customer';
  const meta = META[type];
  const p = existing || { type, stateCode: store.settings.company.stateCode };
  let dirty = false;
  const inputs = {
    name: textInput('name', p.name, { required: true, autocapitalize: 'words' }),
    mobile: textInput('mobile', p.mobile, { type: 'tel', inputmode: 'tel' }),
    whatsapp: textInput('whatsapp', p.whatsapp, { type: 'tel', inputmode: 'tel', placeholder: 'Same as mobile if empty' }),
    email: textInput('email', p.email, { type: 'email', inputmode: 'email' }),
    gstin: textInput('gstin', p.gstin, { maxlength: 15, style: { textTransform: 'uppercase' }, placeholder: '15-character GSTIN' }),
    address: textArea('address', p.address, { rows: 2 }),
    city: textInput('city', p.city),
    pincode: textInput('pincode', p.pincode, { inputmode: 'numeric', maxlength: 6 }),
    stateCode: selectInput('stateCode', [['', 'Select state'], ...STATES.map(([c, n]) => [c, `${n} (${c})`])], p.stateCode),
    opening: moneyInput('opening', Math.abs(p.openingBalance || 0)),
    openingDir: selectInput('openingDir', type === 'customer' ? [['dr', 'Customer owes me (receivable)'], ['cr', 'I owe customer (advance)']] : [['cr', 'I owe supplier (payable)'], ['dr', 'Supplier owes me (advance)']], (p.openingBalance || 0) < 0 ? (type === 'customer' ? 'cr' : 'dr') : (type === 'customer' ? 'dr' : 'cr')),
    openingDate: dateInput('openingDate', p.openingDate || ''),
    creditLimit: moneyInput('creditLimit', p.creditLimit),
    notes: textArea('notes', p.notes, { rows: 2 }),
  };
  const gstErr = h('div', { class: 'err small' });
  const mobErr = h('div', { class: 'err small' });
  for (const i of Object.values(inputs)) i.addEventListener('input', () => { dirty = true; });
  inputs.gstin.addEventListener('change', () => {
    const g = inputs.gstin.value.trim().toUpperCase();
    inputs.gstin.value = g;
    gstErr.textContent = gstinError(g);
    if (!gstErr.textContent && g) inputs.stateCode.value = g.slice(0, 2);
  });
  inputs.mobile.addEventListener('change', () => { mobErr.textContent = mobileError(inputs.mobile.value); });

  const save = async () => {
    const op = readMoney(inputs.opening, { label: 'Opening balance' });
    const cl = readMoney(inputs.creditLimit, { label: 'Credit limit' });
    const e = [op, cl].find((r) => r.error);
    if (e) { toast(e.error, 'bad'); return; }
    const positiveDir = type === 'customer' ? 'dr' : 'cr';
    try {
      const saved = await store.saveParty({
        id: existing ? existing.id : undefined,
        type,
        name: inputs.name.value,
        mobile: inputs.mobile.value,
        whatsapp: inputs.whatsapp.value,
        email: inputs.email.value,
        gstin: inputs.gstin.value,
        address: inputs.address.value.trim(),
        city: inputs.city.value.trim(),
        pincode: inputs.pincode.value.trim(),
        stateCode: inputs.stateCode.value,
        state: stateName(inputs.stateCode.value),
        openingBalance: inputs.openingDir.value === positiveDir ? op.value : -op.value,
        openingDate: inputs.openingDate.value,
        creditLimit: cl.value,
        notes: inputs.notes.value.trim(),
      });
      dirty = false;
      toast(`${meta.one} saved`, 'good');
      app.navigate('#/party/' + saved.id, { replace: true });
    } catch (err) { errorToast(err); }
  };

  const form = h('div', { class: 'form' },
    h('div', { class: 'card form' },
      field('Name', inputs.name, { required: true }),
      h('div', { class: 'row' }, h('div', { class: 'field' }, field('Mobile', inputs.mobile), mobErr), field('WhatsApp', inputs.whatsapp)),
      field('Email', inputs.email),
      h('div', null, field('GSTIN', inputs.gstin, { hint: 'State is filled from the GSTIN automatically' }), gstErr)),
    h('div', { class: 'card form' },
      h('h2', null, 'Address'),
      field('Address', inputs.address),
      h('div', { class: 'row' }, field('City', inputs.city), field('Pincode', inputs.pincode)),
      field('State (place of supply)', inputs.stateCode)),
    h('div', { class: 'card form' },
      h('h2', null, 'Balance'),
      h('div', { class: 'row' }, field('Opening balance', inputs.opening), field('As on date', inputs.openingDate)),
      field('Opening balance type', inputs.openingDir),
      type === 'customer' ? field('Credit limit', inputs.creditLimit, { hint: 'You are warned when an invoice exceeds this' }) : null,
      field('Notes', inputs.notes)),
  );
  return {
    title: existing ? 'Edit ' + meta.one : 'New ' + meta.one,
    back: true,
    nav: false,
    hideSearch: true,
    content: form,
    footer: h('div', { class: 'savebar' }, h('div', { class: 'total' }), h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Save')),
    dirty: () => dirty,
  };
}

// ------------------------------------------------------------------ detail

export function partyView({ store, app }, params) {
  const f = fmt(store);
  const p = store.parties.get(params.id);
  if (!p) throw new Error('Party not found');
  const meta = META[p.type];
  const acc = store.account(p.id);
  const docs = store.listDocuments(meta.docKind).filter((d) => d.partyId === p.id);
  const quotes = p.type === 'customer' ? store.listDocuments('quotation').filter((d) => d.partyId === p.id) : [];
  const pays = store.listPayments().filter((x) => x.partyId === p.id);
  const tab = remember('partytab:' + p.id, { t: 'docs' });
  const tabHost = h('div');
  const tabs = h('div', { class: 'chips' });
  const drawTab = () => {
    clear(tabs);
    for (const [v, l] of [['docs', `${meta.docLabel} (${docs.length})`], ['payments', `Payments (${pays.length})`], ...(quotes.length ? [['quotes', `Quotations (${quotes.length})`]] : [])]) {
      tabs.appendChild(h('button', { class: 'chip' + (tab.t === v ? ' active' : ''), onclick: () => { tab.t = v; drawTab(); } }, l));
    }
    clear(tabHost);
    if (tab.t === 'payments') {
      tabHost.appendChild(pays.length ? lazyList(pays, (x) => h('a', { class: 'item', href: '#/payment/' + x.id },
        h('div', { class: 'main' }, h('div', { class: 'title' }, `${x.number} · ${x.method}`), h('div', { class: 'subtitle' }, [f.date(x.date), x.reference, x.status === 'cancelled' ? 'CANCELLED' : ''].filter(Boolean).join(' · '))),
        h('div', { class: 'end amount ' + (x.status === 'cancelled' ? 'muted' : '') }, f.money(x.amount)))) : emptyState('wallet', 'No payments yet'));
    } else {
      const list = tab.t === 'quotes' ? quotes : docs;
      tabHost.appendChild(list.length ? lazyList(list, (d) => h('a', { class: 'item', href: '#/doc/' + d.id },
        h('div', { class: 'main' }, h('div', { class: 'title' }, d.number), h('div', { class: 'subtitle' }, f.date(d.date))),
        h('div', { class: 'end' }, h('div', { class: 'amount' }, f.money(d.totals.grandTotal)), h('span', { class: 'badge ' + store.docStatus(d) }, store.docStatus(d))))) : emptyState(meta.icon, 'Nothing yet'));
    }
  };
  drawTab();

  const shareDetails = async () => {
    const c = store.settings.company;
    const target = await chooseDialog('Share details', [{ value: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp' }, { value: '', label: 'Other apps', icon: 'share' }]);
    if (target === null) return;
    const text = [p.name, p.mobile && 'Mobile: ' + p.mobile, p.email && 'Email: ' + p.email, p.gstin && 'GSTIN: ' + p.gstin,
      [p.address, p.city, stateName(p.stateCode), p.pincode].filter(Boolean).join(', '),
      acc.balance ? `Balance: ${f.money(Math.abs(acc.balance))} ${drCr(acc.balance, p.type === 'supplier')}` : '', '', '– ' + (c.name || 'BizBill')].filter((x) => x !== '').join('\n');
    const r = await shareText(text, { target, subject: p.name });
    if (r && r.copied) toast('Copied to clipboard');
  };
  const remind = async () => {
    const c = store.settings.company;
    const text = `Dear ${p.name},\nThis is a friendly reminder that ${f.money(acc.balance)} is outstanding on your account with ${c.name || 'us'}.${c.upiId ? `\nUPI: ${c.upiId}` : ''}\nThank you.`;
    await shareText(text, { target: 'whatsapp', phone: p.whatsapp || p.mobile });
  };
  const del = async () => {
    const u = store.partyUsage(p.id);
    const ok = await confirmDialog({
      title: `Delete ${meta.one.toLowerCase()}?`,
      message: `${p.name} will be moved to the recycle bin and hidden from lists. Existing invoices and payments are NOT deleted and keep their details. You can restore from Settings → Recycle bin.`,
      details: [u.docs ? `${u.docs} document(s) reference this ${meta.one.toLowerCase()}` : 'No documents', u.pays ? `${u.pays} payment(s)` : 'No payments', acc.balance ? `Outstanding balance ${f.money(acc.balance)}` : ''].filter(Boolean),
      confirmText: 'Move to recycle bin', danger: true,
    });
    if (!ok) return;
    await store.deleteParty(p.id);
    toast('Moved to recycle bin');
    app.navigate(p.type === 'customer' ? '#/customers' : '#/suppliers', { replace: true });
  };

  const act = (ic, label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn }, icon(ic), label);
  const isCust = p.type === 'customer';
  return {
    title: p.name,
    back: true,
    content: h('div', null,
      p.deleted ? h('div', { class: 'note bad', style: { marginBottom: '12px' } }, 'This record is in the recycle bin.') : null,
      h('div', { class: 'card' },
        h('div', { class: 'doc-head' },
          h('div', null, h('h2', null, p.name),
            h('div', { class: 'small muted' }, [p.mobile, p.email].filter(Boolean).join(' · ')),
            p.gstin ? h('div', { class: 'small' }, 'GSTIN ' + p.gstin) : null,
            h('div', { class: 'small muted' }, [p.address, p.city, stateName(p.stateCode)].filter(Boolean).join(', '))),
          h('div', { style: { textAlign: 'right' } },
            h('div', { class: 'small muted' }, acc.balance > 0 ? (isCust ? 'To receive' : 'To pay') : acc.balance < 0 ? 'Advance' : 'Settled'),
            h('div', { class: 'big ' + amountClass(isCust ? acc.balance : -acc.balance) }, f.money(Math.abs(acc.balance))),
            p.creditLimit ? h('div', { class: 'small muted' }, 'Limit ' + f.money(p.creditLimit)) : null)),
        acc.balance > 0 ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'small muted', style: { marginBottom: '4px' } }, 'Aging'),
          h('div', { class: 'aging' }, AGING_BUCKETS.map((bk, i) => h('div', null, bk.replace(' days', 'd'), h('b', null, f.plain(acc.aging[i])))))) : null,
        p.notes ? h('p', { class: 'small', style: { whiteSpace: 'pre-line' } }, p.notes) : null),
      h('div', { class: 'actions-grid', style: { marginBottom: '12px' } },
        act('plus', isCust ? 'Invoice' : 'Purchase', () => app.navigate(`#/doc/new/${meta.docKind}?party=${p.id}`), 'primary'),
        act(isCust ? 'in' : 'out', isCust ? 'Receive' : 'Pay', () => app.navigate(`#/payment/new/${isCust ? 'in' : 'out'}?party=${p.id}`)),
        act('book', 'Ledger', () => app.navigate(`#/party/${p.id}/ledger`)),
        p.mobile ? act('phone', 'Call', () => { location.href = 'tel:' + p.mobile.replace(/\s/g, ''); }) : null,
        isCust && acc.balance > 0 && (p.whatsapp || p.mobile) ? act('whatsapp', 'Remind', remind) : null,
        act('share', 'Share', shareDetails),
        isCust ? act('quote', 'Quotation', () => app.navigate(`#/doc/new/quotation?party=${p.id}`)) : null,
        act('edit', 'Edit', () => app.navigate(`#/party/${p.id}/edit`)),
        !p.deleted ? act('trash', 'Delete', del, 'danger') : act('restore', 'Restore', async () => { await store.restoreParty(p.id); app.refresh(); })),
      tabs, tabHost),
  };
}

// ------------------------------------------------------------------ ledger

export function partyLedger({ store }, params) {
  const f = fmt(store);
  const p = store.parties.get(params.id);
  if (!p) throw new Error('Party not found');
  const range = rangeState('ledger', 'all');
  const host = h('div');
  let current = null;
  const draw = () => {
    const r = rangeOf(range);
    const st = ledgerStatement(p, [...store.documents.values()], [...store.payments.values()], r);
    current = { st, r };
    const isSup = p.type === 'supplier';
    const bal = (v) => (v ? `${f.plain(Math.abs(v))} ${drCr(v, isSup)}` : '0.00');
    clear(host);
    put(host, 
      h('div', { class: 'card' }, kv([
        ['Opening balance', bal(st.opening)],
        ['Total debit', f.money(st.totalDebit)],
        ['Total credit', f.money(st.totalCredit)],
        'sep',
        ['Closing balance', bal(st.closing), true],
      ])),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Particulars'), h('th', { class: 'n' }, 'Debit'), h('th', { class: 'n' }, 'Credit'), h('th', { class: 'n' }, 'Balance'))),
        h('tbody', null,
          h('tr', { class: 'strong' }, h('td'), h('td', null, 'Opening balance'), h('td'), h('td'), h('td', { class: 'n' }, bal(st.opening))),
          st.rows.map((row) => h('tr', { class: row.id ? 'click' : '', onclick: row.id ? () => { location.hash = row.type === 'payment' ? '#/payment/' + row.id : '#/doc/' + row.id; } : null },
            h('td', null, f.date(row.date)), h('td', { class: 'wrap' }, row.description),
            h('td', { class: 'n' }, row.debit ? f.plain(row.debit) : ''), h('td', { class: 'n' }, row.credit ? f.plain(row.credit) : ''), h('td', { class: 'n' }, bal(row.balance)))),
          h('tr', { class: 'strong' }, h('td'), h('td', null, 'Total'), h('td', { class: 'n' }, f.plain(st.totalDebit)), h('td', { class: 'n' }, f.plain(st.totalCredit)), h('td')),
          h('tr', { class: 'strong' }, h('td'), h('td', null, 'Closing balance'), h('td'), h('td'), h('td', { class: 'n' }, bal(st.closing)))))),
      st.rows.length ? null : h('p', { class: 'small muted', style: { textAlign: 'center' } }, 'No transactions in this period'),
    );
  };
  draw();
  const spec = () => ledgerSpec(store, p, current.st, current.r);
  return {
    title: 'Ledger · ' + p.name,
    back: true,
    content: h('div', null, rangeChips(range, () => draw()), h('div', { class: 'btn-row', style: { marginBottom: '10px' } },
      h('button', { class: 'btn', onclick: () => runDocAction(spec(), 'share') }, icon('file'), 'PDF'),
      h('button', { class: 'btn', onclick: () => runDocAction(spec(), 'print') }, icon('print'), 'Print'),
      h('button', { class: 'btn', onclick: () => shareMenu(spec(), { jpg: true }) }, icon('share'), 'Share')), host),
    actions: [{ icon: 'share', label: 'Share ledger', onClick: () => shareMenu(spec()) }],
  };
}

export function ledgerHub({ store }) {
  const f = fmt(store);
  const state = remember('ledgerhub', { q: '', type: 'all' });
  const host = h('div');
  const chips = h('div', { class: 'chips' });
  const draw = () => {
    clear(chips);
    for (const [v, l] of [['all', 'All'], ['customer', 'Customers'], ['supplier', 'Suppliers']]) {
      chips.appendChild(h('button', { class: 'chip' + (state.type === v ? ' active' : ''), onclick: () => { state.type = v; draw(); } }, l));
    }
    const list = store.listParties(state.type === 'all' ? null : state.type).filter((p) => matches(state.q, p.name, p.mobile, p.gstin));
    clear(host);
    host.appendChild(list.length ? lazyList(list, (p) => {
      const b = store.account(p.id).balance;
      return h('a', { class: 'item', href: `#/party/${p.id}/ledger` },
        h('div', { class: 'avatar' }, icon(p.type === 'customer' ? 'users' : 'truck')),
        h('div', { class: 'main' }, h('div', { class: 'title' }, p.name), h('div', { class: 'subtitle' }, (p.type === 'customer' ? 'Customer' : 'Supplier') + (p.mobile ? ' · ' + p.mobile : ''))),
        h('div', { class: 'end amount' }, b ? `${f.money(Math.abs(b))} ${drCr(b, p.type === 'supplier')}` : '—'));
    }) : emptyState('book', 'No customers or suppliers yet'));
  };
  draw();
  return {
    title: 'Ledger',
    back: true,
    content: h('div', null,
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Search party…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      chips, host),
  };
}
