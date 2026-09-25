// Reusable UI components: toasts, dialogs, form fields, lists, pickers.

import { h, icon, clear, append, debounce } from './dom.js';
import { RANGE_PRESETS, resolveRange, today, isValidISODate } from '../core/dates.js';
import { paiseToInput, qtyToInput, bpToPct, parseDecimal } from '../core/money.js';

// ------------------------------------------------------------------ toast

export function toast(message, type = '') {
  const host = document.getElementById('toast');
  if (!host) return;
  const t = h('div', { class: 't ' + type }, message);
  host.appendChild(t);
  setTimeout(() => t.remove(), type === 'bad' ? 5000 : 2600);
}

export function errorToast(e) {
  console.error(e);
  const msg = e && e.messages ? e.messages.join('\n') : (e && e.message) || String(e);
  toast(msg, 'bad');
}

// ------------------------------------------------------------------ dialogs

const openSheets = [];

/** Close the topmost dialog (used by Android back button). Returns true if one was open. */
export function closeTopSheet() {
  const s = openSheets[openSheets.length - 1];
  if (!s) return false;
  s.close(null);
  return true;
}

export function openSheet(build, { dismissable = true } = {}) {
  return new Promise((resolve) => {
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    const overlay = h('div', { class: 'overlay' }, sheet);
    let done = false;
    const api = {
      close(value) {
        if (done) return;
        done = true;
        overlay.remove();
        const i = openSheets.indexOf(api);
        if (i >= 0) openSheets.splice(i, 1);
        resolve(value);
      },
      sheet,
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay && dismissable) api.close(null); });
    append(sheet, [build(api)]);
    document.body.appendChild(overlay);
    openSheets.push(api);
    const first = sheet.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first && !first.dataset.noautofocus) setTimeout(() => first.focus(), 50);
  });
}

/**
 * Confirmation dialog. details: array of strings listing affected records.
 */
export function confirmDialog({ title, message, details = [], confirmText = 'Confirm', danger = false, requireText = '' }) {
  return openSheet((api) => {
    const confirmBtn = h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), onclick: () => api.close(true) }, confirmText);
    let typed = null;
    if (requireText) {
      confirmBtn.disabled = true;
      typed = h('input', { type: 'text', placeholder: `Type ${requireText} to confirm`, 'aria-label': 'Confirmation text', oninput: (e) => { confirmBtn.disabled = e.target.value.trim().toUpperCase() !== requireText.toUpperCase(); } });
    }
    return h('div', null,
      h('h2', null, title),
      message ? h('p', { class: 'small', style: { whiteSpace: 'pre-line' } }, message) : null,
      details.length ? h('ul', { class: 'small' }, details.map((d) => h('li', null, d))) : null,
      typed,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(false) }, 'Cancel'), confirmBtn));
  }).then((v) => !!v);
}

export function promptDialog({ title, label, value = '', placeholder = '', required = true, multiline = false, type = 'text', message = '' }) {
  return openSheet((api) => {
    const input = multiline
      ? h('textarea', { placeholder, 'aria-label': label }, value)
      : h('input', { type, value, placeholder, 'aria-label': label });
    const err = h('div', { class: 'err small' });
    const ok = () => {
      const v = input.value.trim();
      if (required && !v) { err.textContent = 'This field is required'; input.classList.add('invalid'); return; }
      api.close(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) ok(); });
    return h('div', null,
      h('h2', null, title),
      message ? h('p', { class: 'small' }, message) : null,
      h('label', { class: 'field' }, h('span', null, label), input, err),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, 'OK')));
  });
}

/** Choose one option from a list. options: [{value, label, sub, icon}] */
export function chooseDialog(title, options) {
  return openSheet((api) => h('div', null,
    h('h2', null, title),
    h('div', { class: 'picker-list' }, options.map((o) => h('button', { class: 'item', onclick: () => api.close(o.value) },
      o.icon ? icon(o.icon) : null,
      h('div', { class: 'main' }, h('div', { class: 'title' }, o.label), o.sub ? h('div', { class: 'subtitle' }, o.sub) : null)))),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel'))));
}

/**
 * Searchable picker. items: array; opts: {title, label(item), sub(item), search(item) -> string, create: {label, fn}}
 */
export function pickerDialog({ title, items, label, sub, end, search, createLabel, onCreate, placeholder = 'Search…' }) {
  return openSheet((api) => {
    const list = h('div', { class: 'picker-list' });
    const input = h('input', { type: 'search', placeholder, 'aria-label': 'Search' });
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      const filtered = items.filter((it) => { const s = search(it).toLowerCase(); return terms.every((t) => s.includes(t)); }).slice(0, 200);
      clear(list);
      if (onCreate) {
        list.appendChild(h('button', { class: 'item', onclick: async () => { const r = await onCreate(input.value.trim()); if (r) api.close(r); } },
          h('div', { class: 'avatar' }, icon('plus')), h('div', { class: 'main' }, h('div', { class: 'title' }, createLabel + (input.value.trim() ? ` "${input.value.trim()}"` : '')))));
      }
      for (const it of filtered) {
        list.appendChild(h('button', { class: 'item', onclick: () => api.close(it) },
          h('div', { class: 'main' }, h('div', { class: 'title' }, label(it)), sub ? h('div', { class: 'subtitle' }, sub(it)) : null),
          end ? h('div', { class: 'end small' }, end(it)) : null));
      }
      if (!filtered.length && !onCreate) list.appendChild(h('div', { class: 'empty' }, 'No matches'));
    };
    input.addEventListener('input', debounce(render, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Barcode scanners type the code followed by Enter: pick exact match.
        const q = input.value.trim().toLowerCase();
        const exact = items.find((it) => search(it).toLowerCase().split(' ').includes(q));
        if (exact) api.close(exact);
      }
    });
    render();
    return h('div', null, h('h2', null, title), input, list,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Close')));
  });
}

// ------------------------------------------------------------------ fields

export function field(label, control, { hint = '', required = false, error = '' } = {}) {
  return h('label', { class: 'field' },
    h('span', null, label, required ? h('span', { class: 'req' }, ' *') : null),
    control,
    error ? h('div', { class: 'err' }, error) : null,
    hint ? h('div', { class: 'hint' }, hint) : null);
}

export function textInput(name, value = '', props = {}) {
  return h('input', { type: 'text', name, value: value ?? '', autocomplete: 'off', ...props });
}

export function moneyInput(name, paise, props = {}) {
  return h('input', { type: 'text', inputmode: 'decimal', name, class: 'num', value: paise ? paiseToInput(paise) : '', placeholder: '0.00', autocomplete: 'off', ...props });
}

export function qtyInput(name, qty, props = {}) {
  return h('input', { type: 'text', inputmode: 'decimal', name, class: 'num', value: qty ? qtyToInput(qty) : '', placeholder: '0', autocomplete: 'off', ...props });
}

export function pctInput(name, bp, props = {}) {
  return h('input', { type: 'text', inputmode: 'decimal', name, class: 'num', value: bp ? bpToPct(bp) : '', placeholder: '0', autocomplete: 'off', ...props });
}

export function dateInput(name, value = today(), props = {}) {
  return h('input', { type: 'date', name, value: value || '', ...props });
}

export function selectInput(name, options, value, props = {}) {
  return h('select', { name, ...props }, options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: String(v) === String(value) }, l);
  }));
}

export function textArea(name, value = '', props = {}) {
  return h('textarea', { name, ...props }, value || '');
}

export function switchRow(title, desc, checked, onChange, props = {}) {
  const input = h('input', { type: 'checkbox', checked, role: 'switch', 'aria-label': title, onchange: (e) => onChange(e.target.checked), ...props });
  return h('div', { class: 'switch-row' },
    h('div', null, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null),
    h('label', { class: 'switch' }, input, h('span')));
}

/** Parse money input; returns {value, error} */
export function readMoney(input, { required = false, allowNegative = false, label = 'Amount' } = {}) {
  const raw = input.value.trim();
  input.classList.remove('invalid');
  if (!raw) {
    if (required) { input.classList.add('invalid'); return { value: 0, error: `${label} is required` }; }
    return { value: 0 };
  }
  const v = parseDecimal(raw, 2);
  if (Number.isNaN(v) || (!allowNegative && v < 0)) { input.classList.add('invalid'); return { value: 0, error: `${label} is not a valid amount` }; }
  return { value: v };
}

export function readQty(input, { required = false, label = 'Quantity', allowNegative = false } = {}) {
  const raw = input.value.trim();
  input.classList.remove('invalid');
  if (!raw) {
    if (required) { input.classList.add('invalid'); return { value: 0, error: `${label} is required` }; }
    return { value: 0 };
  }
  const v = parseDecimal(raw, 3);
  if (Number.isNaN(v) || (!allowNegative && v < 0)) { input.classList.add('invalid'); return { value: 0, error: `${label} is not valid` }; }
  return { value: v };
}

export function readPct(input, label = 'Percentage') {
  const raw = input.value.trim().replace('%', '');
  input.classList.remove('invalid');
  if (!raw) return { value: 0 };
  const v = parseDecimal(raw, 2);
  if (Number.isNaN(v) || v < 0 || v > 10000) { input.classList.add('invalid'); return { value: 0, error: `${label} must be between 0 and 100` }; }
  return { value: v };
}

// ------------------------------------------------------------------ lists

/**
 * Render a potentially large list incrementally (page of 60, more on scroll).
 */
export function lazyList(items, renderItem, { pageSize = 60, empty = null } = {}) {
  const wrap = h('div', { class: 'list' });
  if (!items.length) return empty || h('div', { class: 'list' }, h('div', { class: 'empty' }, 'Nothing here yet'));
  let shown = 0;
  const sentinel = h('button', { class: 'more-btn' }, 'Show more');
  const more = () => {
    const frag = document.createDocumentFragment();
    const next = items.slice(shown, shown + pageSize);
    for (const it of next) frag.appendChild(renderItem(it));
    shown += next.length;
    wrap.insertBefore(frag, sentinel);
    sentinel.textContent = `Show more (${items.length - shown} left)`;
    if (shown >= items.length) sentinel.remove();
  };
  wrap.appendChild(sentinel);
  sentinel.addEventListener('click', more);
  more();
  if ('IntersectionObserver' in window && shown < items.length) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        if (shown < items.length) more();
        if (shown >= items.length) io.disconnect();
      }
    }, { rootMargin: '400px' });
    io.observe(sentinel);
  }
  return wrap;
}

export function emptyState(iconName, text, action) {
  return h('div', { class: 'list' }, h('div', { class: 'empty' }, icon(iconName), h('div', null, text), action ? h('div', { style: { marginTop: '12px' } }, action) : null));
}

export function statusBadge(status) {
  const labels = { paid: 'Paid', unpaid: 'Unpaid', partial: 'Partial', cancelled: 'Cancelled', draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', converted: 'Converted' };
  return h('span', { class: 'badge ' + status }, labels[status] || status);
}

// ------------------------------------------------------------------ date range

/**
 * Range chips with custom range support.
 * state: {preset, from, to}; onChange(state, range)
 */
export function rangeChips(state, onChange, presets = ['today', 'week', 'month', 'lastmonth', 'fy', 'all', 'custom']) {
  const wrap = h('div', { class: 'chips', role: 'tablist' });
  const labels = Object.fromEntries(RANGE_PRESETS);
  const render = () => {
    clear(wrap);
    for (const p of presets) {
      const active = state.preset === p;
      let text = labels[p];
      if (p === 'custom' && active && state.from) text = `${state.from} → ${state.to}`;
      wrap.appendChild(h('button', { class: 'chip' + (active ? ' active' : ''), role: 'tab', 'aria-selected': String(active), onclick: async () => {
        if (p === 'custom') {
          const r = await customRangeDialog(state.from, state.to);
          if (!r) return;
          Object.assign(state, { preset: 'custom', from: r.from, to: r.to });
        } else {
          state.preset = p;
        }
        render();
        onChange(state, resolveRange(state.preset, new Date(), state));
      } }, text));
    }
  };
  render();
  return wrap;
}

export function customRangeDialog(from, to) {
  return openSheet((api) => {
    const f = dateInput('from', from || today());
    const t = dateInput('to', to || today());
    const err = h('div', { class: 'err small' });
    return h('div', null,
      h('h2', null, 'Custom date range'),
      h('div', { class: 'row' }, field('From', f), field('To', t)),
      err,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => {
          if (!isValidISODate(f.value) || !isValidISODate(t.value)) { err.textContent = 'Choose both dates'; return; }
          api.close(f.value <= t.value ? { from: f.value, to: t.value } : { from: t.value, to: f.value });
        } }, 'Apply')));
  });
}

export function kv(rows) {
  const out = h('div', { class: 'kv' });
  for (const r of rows) {
    if (!r) continue;
    if (r === 'sep') { out.appendChild(h('div', { class: 'sep' })); continue; }
    const [k, v, strong, cls] = r;
    out.appendChild(h('div', { class: 'k' + (strong ? ' strong' : '') }, k));
    out.appendChild(h('div', { class: 'v' + (strong ? ' strong' : '') + (cls ? ' ' + cls : '') }, v));
  }
  return out;
}

/** Read an <input type=file> selection as text / dataURL. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Downscale an image file to a JPEG data URL (keeps DB and backups small). */
export function imageToDataUrl(file, maxSide = 1200, quality = 0.8, keepPng = false) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      const ctx = c.getContext('2d');
      const png = keepPng && /png/i.test(file.type);
      if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt); }
      ctx.drawImage(img, 0, 0, w, hgt);
      URL.revokeObjectURL(url);
      resolve({ data: c.toDataURL(png ? 'image/png' : 'image/jpeg', quality), width: w, height: hgt, mime: png ? 'image/png' : 'image/jpeg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image')); };
    img.src = url;
  });
}
