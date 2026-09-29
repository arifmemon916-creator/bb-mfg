// Expenses: list with category filter, form with receipt attachment.

import { h, icon, clear, debounce, put } from '../ui/dom.js';
import {
  field, textInput, moneyInput, dateInput, selectInput, textArea, readMoney, toast, errorToast, lazyList, emptyState,
  confirmDialog, rangeChips, pickFile, imageToDataUrl, openSheet,
} from '../ui/components.js';
import { fmt, remember, rangeState, rangeOf, rangeLabel } from './common.js';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from '../core/settings.js';
import { matches } from '../core/search.js';
import { inRange, today } from '../core/dates.js';
import { sum } from '../core/money.js';
import { runReport } from '../core/reports.js';
import { reportSpec, shareMenu } from '../docs/actions.js';

export function expenseList({ store }) {
  const f = fmt(store);
  const state = remember('expenses', { q: '', category: '', showVoid: false });
  const range = rangeState('expenses', 'month');
  const host = h('div');
  const summary = h('div', { class: 'card' });
  const chips = h('div', { class: 'chips' });
  const cats = [...new Set([...EXPENSE_CATEGORIES, ...store.listExpenses().map((e) => e.category)])];
  const draw = () => {
    clear(chips);
    chips.appendChild(h('button', { class: 'chip' + (!state.category ? ' active' : ''), onclick: () => { state.category = ''; draw(); } }, 'All'));
    for (const c of cats) chips.appendChild(h('button', { class: 'chip' + (state.category === c ? ' active' : ''), onclick: () => { state.category = c; draw(); } }, c));
    chips.appendChild(h('button', { class: 'chip' + (state.showVoid ? ' active' : ''), onclick: () => { state.showVoid = !state.showVoid; draw(); } }, 'Show voided'));
    const r = rangeOf(range);
    const list = store.listExpenses().filter((e) => inRange(e.date, r) && (!state.category || e.category === state.category)
      && (state.showVoid || e.status !== 'cancelled') && matches(state.q, e.category, e.description, e.method, e.reference));
    const active = list.filter((e) => e.status !== 'cancelled');
    const byCat = new Map();
    for (const e of active) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
    clear(summary);
    put(summary, 
      h('div', { class: 'small muted' }, 'Total expenses · ' + rangeLabel(store, range)),
      h('div', { style: { fontSize: '1.4rem', fontWeight: 800 } }, f.money(sum(active, (e) => e.amount))),
      byCat.size ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${f.money(v)}`).join(' · ')) : null);
    clear(host);
    host.appendChild(list.length ? lazyList(list, (e) => h('a', { class: 'item', href: '#/expense/' + e.id },
      h('div', { class: 'avatar' }, icon('expense')),
      h('div', { class: 'main' }, h('div', { class: 'title' }, e.category + (e.attachmentId ? ' 📎' : '')), h('div', { class: 'subtitle' }, [f.date(e.date), e.method, e.description].filter(Boolean).join(' · '))),
      h('div', { class: 'end' }, h('div', { class: 'amount ' + (e.status === 'cancelled' ? 'muted' : '') }, f.money(e.amount)), e.status === 'cancelled' ? h('span', { class: 'badge cancelled' }, 'Void') : null)))
      : emptyState('expense', 'No expenses in this period', h('a', { class: 'btn primary', href: '#/expense/new' }, icon('plus'), 'Add expense')));
  };
  draw();
  return {
    title: 'Expenses',
    content: h('div', null, summary,
      h('div', { class: 'searchbar' }, icon('search'), h('input', { type: 'search', placeholder: 'Search expenses…', value: state.q, 'aria-label': 'Search', oninput: debounce((e) => { state.q = e.target.value; draw(); }, 150) })),
      rangeChips(range, () => draw()), chips, host),
    actions: [{ icon: 'print', label: 'Expense report', onClick: () => shareMenu(reportSpec(store, 'Expenses', rangeLabel(store, range), runReport(store, 'fin-expenses', rangeOf(range))), { jpg: false }) }],
    fab: { href: '#/expense/new', icon: 'plus', text: 'Expense', label: 'Add expense' },
  };
}

export async function expenseForm({ store, app }, params) {
  const existing = params.id ? store.expenses.get(params.id) : null;
  if (params.id && !existing) throw new Error('Expense not found');
  const e = existing || {};
  let dirty = false;
  let attachment = null; // {name, mime, data}
  let existingAtt = e.attachmentId ? await store.getAttachment(e.attachmentId) : null;
  const cats = [...new Set([...EXPENSE_CATEGORIES, ...store.listExpenses().map((x) => x.category)])];
  const inputs = {
    date: dateInput('date', e.date || today()),
    category: selectInput('category', [...cats, '+ New category'], e.category || 'Other'),
    amount: moneyInput('amount', e.amount),
    method: selectInput('method', PAYMENT_METHODS.filter((m) => m !== 'Credit'), e.method || (store.settings.billing.defaultPaymentMethod === 'Credit' ? 'Cash' : store.settings.billing.defaultPaymentMethod)),
    reference: textInput('reference', e.reference, { placeholder: 'Bill / voucher no.' }),
    description: textArea('description', e.description, { rows: 2 }),
  };
  const newCat = textInput('newCat', '', { placeholder: 'Category name' });
  const newCatField = field('New category', newCat);
  newCatField.classList.add('hidden');
  inputs.category.addEventListener('change', () => newCatField.classList.toggle('hidden', inputs.category.value !== '+ New category'));
  for (const i of [...Object.values(inputs), newCat]) i.addEventListener('input', () => { dirty = true; });

  const attBox = h('div');
  const paintAtt = () => {
    clear(attBox);
    const cur = attachment || existingAtt;
    if (cur) {
      const img = /^data:image\//.test(cur.data) ? h('img', { src: cur.data, alt: 'Receipt', style: { maxWidth: '100%', maxHeight: '220px', borderRadius: '8px', display: 'block', marginBottom: '8px' } }) : h('p', { class: 'small' }, cur.name);
      put(attBox, img, h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', onclick: () => openSheet((api) => h('div', null, h('img', { src: cur.data, alt: 'Receipt', style: { width: '100%' } }), h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close() }, 'Close')))) }, icon('eye'), 'View'),
        h('button', { class: 'btn small', onclick: choose }, 'Replace'),
        h('button', { class: 'btn small danger', onclick: () => { attachment = null; existingAtt = null; removeAtt = true; dirty = true; paintAtt(); } }, 'Remove')));
    } else {
      put(attBox, h('button', { class: 'btn block', onclick: choose }, icon('image'), 'Attach receipt photo'));
    }
  };
  let removeAtt = false;
  const choose = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const img = await imageToDataUrl(file, 1400, 0.75);
      attachment = { name: file.name, mime: img.mime, data: img.data };
      removeAtt = false;
      dirty = true;
      paintAtt();
    } catch (err) { errorToast(err); }
  };
  paintAtt();

  const save = async () => {
    const amt = readMoney(inputs.amount, { required: true });
    if (amt.error) { toast(amt.error, 'bad'); return; }
    let category = inputs.category.value;
    if (category === '+ New category') {
      category = newCat.value.trim();
      if (!category) { toast('Enter the new category name', 'bad'); return; }
    }
    try {
      await store.saveExpense({
        id: existing ? existing.id : undefined, date: inputs.date.value, category, amount: amt.value, method: inputs.method.value,
        reference: inputs.reference.value, description: inputs.description.value,
        attachmentId: removeAtt ? '' : undefined,
      }, attachment);
      dirty = false;
      toast('Expense saved', 'good');
      app.navigate('#/expenses', { replace: true });
    } catch (err) { errorToast(err); }
  };
  const voidBtn = existing ? h('button', { class: 'btn ' + (existing.status === 'cancelled' ? '' : 'danger'), onclick: async () => {
    if (existing.status === 'cancelled') { await store.cancelExpense(existing.id, true); toast('Expense restored'); app.refresh(); return; }
    const ok = await confirmDialog({ title: 'Void expense?', message: 'The expense is kept but excluded from reports and profit. You can restore it later.', details: [`${existing.category} · ${fmt(store).money(existing.amount)} · ${fmt(store).date(existing.date)}`], confirmText: 'Void', danger: true });
    if (ok) { await store.cancelExpense(existing.id); toast('Expense voided'); app.navigate('#/expenses', { replace: true }); }
  } }, existing.status === 'cancelled' ? 'Restore' : 'Void') : null;

  return {
    title: existing ? 'Edit expense' : 'New expense',
    back: true,
    nav: false,
    hideSearch: true,
    dirty: () => dirty,
    content: h('div', { class: 'form' },
      existing && existing.status === 'cancelled' ? h('div', { class: 'note bad' }, 'This expense is voided and excluded from reports.') : null,
      h('div', { class: 'card form' },
        h('div', { class: 'row' }, field('Amount', inputs.amount, { required: true }), field('Date', inputs.date)),
        h('div', { class: 'row' }, field('Category', inputs.category), field('Paid by', inputs.method)),
        newCatField,
        field('Reference', inputs.reference),
        field('Description', inputs.description)),
      h('div', { class: 'card' }, h('h2', null, 'Receipt'), attBox)),
    footer: h('div', { class: 'savebar' }, h('div', { class: 'total' }), voidBtn, h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Save')),
  };
}
