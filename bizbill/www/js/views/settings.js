// Settings: company profile, billing, appearance & dashboard, security,
// notifications.

import { h, icon, clear, put } from '../ui/dom.js';
import {
  field, textInput, selectInput, textArea, switchRow, toast, errorToast, pickFile, imageToDataUrl, openSheet,
} from '../ui/components.js';
import { STATES, stateName } from '../core/states.js';
import { gstinError, emailError, mobileError, GST_RATES } from '../core/validate.js';
import { PAYMENT_METHODS, UNITS, DATE_FORMATS, DASHBOARD_CARDS, NAV_TABS, formatDocNumber } from '../core/settings.js';
import { hashPin, pinError, verifyPin } from '../core/security.js';
import * as bridge from '../platform/bridge.js';
import { formatDate, today } from '../core/dates.js';
import { formatMoney } from '../core/money.js';

const link = (href, ic, title, sub) => h('a', { class: 'item', href },
  h('div', { class: 'avatar' }, icon(ic)), h('div', { class: 'main' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'subtitle' }, sub) : null));

export function settingsHub({ store }) {
  const s = store.settings;
  return {
    title: 'Settings',
    back: true,
    content: h('div', null,
      h('div', { class: 'section-title' }, 'Business'),
      h('div', { class: 'list' },
        link('#/settings/company', 'home', 'Company profile', s.company.name || 'Name, logo, address, GSTIN, bank, UPI'),
        link('#/settings/billing', 'sales', 'Billing settings', 'Numbering, GST mode, defaults, currency, date format')),
      h('div', { class: 'section-title' }, 'App'),
      h('div', { class: 'list' },
        link('#/settings/appearance', 'grid', 'Appearance & dashboard', 'Theme, full screen, dashboard cards, navigation'),
        link('#/settings/security', 'lock', 'Security / App lock', s.security.enabled ? 'PIN lock is ON' : 'PIN, fingerprint, auto-lock'),
        link('#/settings/notifications', 'bell', 'Notifications', s.notifications.enabled ? 'On' : 'Off')),
      h('div', { class: 'section-title' }, 'Data'),
      h('div', { class: 'list' },
        link('#/backup', 'download', 'Backup & restore', s.backup.lastBackupAt ? 'Last backup ' + new Date(s.backup.lastBackupAt).toLocaleString() : 'No backup yet'),
        link('#/import', 'upload', 'Import / export', 'CSV import & export'),
        link('#/recycle', 'restore', 'Recycle bin', 'Restore deleted records'),
        link('#/audit', 'clock', 'Activity history', 'Log of important actions')),
      h('div', { class: 'section-title' }, 'About'),
      h('div', { class: 'list' },
        link('#/update', 'refresh', 'Update center', 'Check for new versions'),
        link('#/about', 'help', 'About & help', 'Version, help, privacy'))),
  };
}

/** Generic settings form with a Save bar. build(inputs) returns content; read() returns patch or throws. */
function settingsPage({ store, app }, title, build, apply) {
  let dirty = false;
  const content = build(() => { dirty = true; });
  content.addEventListener('input', () => { dirty = true; });
  content.addEventListener('change', () => { dirty = true; });
  const save = async () => {
    try {
      const next = structuredClone(store.settings);
      const errs = apply(next) || [];
      if (errs.length) { toast(errs.join('\n'), 'bad'); return; }
      await store.saveSettings(next, title + ' updated');
      dirty = false;
      toast('Saved', 'good');
      app.navigate('#/settings', { replace: true });
    } catch (e) { errorToast(e); }
  };
  return {
    title,
    back: true,
    nav: false,
    hideSearch: true,
    dirty: () => dirty,
    content,
    footer: h('div', { class: 'savebar' }, h('div', { class: 'total' }), h('button', { class: 'btn primary', onclick: save }, icon('check'), 'Save')),
  };
}

export function companySettings(ctx) {
  const c = ctx.store.settings.company;
  const i = {
    name: textInput('name', c.name, { required: true }),
    address: textArea('address', c.address, { rows: 2 }),
    city: textInput('city', c.city),
    pincode: textInput('pincode', c.pincode, { inputmode: 'numeric', maxlength: 6 }),
    stateCode: selectInput('stateCode', [['', 'Select state'], ...STATES.map(([code, n]) => [code, `${n} (${code})`])], c.stateCode),
    mobile: textInput('mobile', c.mobile, { type: 'tel', inputmode: 'tel' }),
    email: textInput('email', c.email, { type: 'email' }),
    gstin: textInput('gstin', c.gstin, { maxlength: 15, style: { textTransform: 'uppercase' } }),
    pan: textInput('pan', c.pan, { maxlength: 10, style: { textTransform: 'uppercase' } }),
    bankName: textInput('bankName', c.bankName),
    bankAccount: textInput('bankAccount', c.bankAccount, { inputmode: 'numeric' }),
    bankIfsc: textInput('bankIfsc', c.bankIfsc, { style: { textTransform: 'uppercase' }, maxlength: 11 }),
    bankBranch: textInput('bankBranch', c.bankBranch),
    upiId: textInput('upiId', c.upiId, { placeholder: 'name@bank' }),
    terms: textArea('terms', c.terms, { rows: 4 }),
    footer: textInput('footer', c.footer),
    signatory: textInput('signatory', c.signatory),
  };
  let logo = { data: c.logo, width: c.logoW, height: c.logoH };
  const logoBox = h('div');
  const paintLogo = () => {
    clear(logoBox);
    if (logo.data) put(logoBox, h('img', { src: logo.data, alt: 'Logo', style: { maxHeight: '72px', maxWidth: '200px', display: 'block', marginBottom: '8px', background: '#fff', borderRadius: '6px' } }));
    put(logoBox, h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: async () => {
        const file = await pickFile('image/png,image/jpeg,image/webp');
        if (!file) return;
        try { logo = await imageToDataUrl(file, 600, 0.9, true); paintLogo(); logoBox.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { errorToast(e); }
      } }, icon('image'), logo.data ? 'Change logo' : 'Upload logo'),
      logo.data ? h('button', { class: 'btn small danger', onclick: () => { logo = {}; paintLogo(); logoBox.dispatchEvent(new Event('input', { bubbles: true })); } }, 'Remove') : null));
  };
  paintLogo();
  i.gstin.addEventListener('change', () => { const g = i.gstin.value.trim().toUpperCase(); if (!gstinError(g) && g) { i.stateCode.value = g.slice(0, 2); if (!i.pan.value) i.pan.value = g.slice(2, 12); } });
  return settingsPage(ctx, 'Company profile', () => h('div', { class: 'form' },
    h('div', { class: 'card form' }, h('h2', null, 'Business'), logoBox, field('Company name', i.name, { required: true }), h('div', { class: 'row' }, field('Mobile', i.mobile), field('Email', i.email)),
      h('div', { class: 'row' }, field('GSTIN', i.gstin), field('PAN', i.pan))),
    h('div', { class: 'card form' }, h('h2', null, 'Address'), field('Address', i.address), h('div', { class: 'row' }, field('City', i.city), field('Pincode', i.pincode)), field('State', i.stateCode, { hint: 'Used to decide CGST+SGST vs IGST' })),
    h('div', { class: 'card form' }, h('h2', null, 'Bank & UPI (printed on invoices)'), field('Bank name', i.bankName), h('div', { class: 'row' }, field('Account number', i.bankAccount), field('IFSC', i.bankIfsc)), field('Branch', i.bankBranch), field('UPI ID', i.upiId)),
    h('div', { class: 'card form' }, h('h2', null, 'Invoice text'), field('Default terms & conditions', i.terms), field('Invoice footer', i.footer), field('Signatory label', i.signatory))),
  (next) => {
    const errs = [];
    if (!i.name.value.trim()) errs.push('Company name is required');
    const g = gstinError(i.gstin.value); if (g) errs.push(g);
    const e = emailError(i.email.value); if (e) errs.push(e);
    const m = mobileError(i.mobile.value); if (m) errs.push(m);
    if (i.bankIfsc.value && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(i.bankIfsc.value.trim())) errs.push('IFSC format is invalid');
    if (i.upiId.value && !/^[\w.-]{2,}@[a-z][\w.-]*$/i.test(i.upiId.value.trim())) errs.push('UPI ID format is invalid');
    Object.assign(next.company, {
      name: i.name.value.trim(), address: i.address.value.trim(), city: i.city.value.trim(), pincode: i.pincode.value.trim(),
      stateCode: i.stateCode.value, state: stateName(i.stateCode.value), mobile: i.mobile.value.trim(), email: i.email.value.trim(),
      gstin: i.gstin.value.trim().toUpperCase(), pan: i.pan.value.trim().toUpperCase(), bankName: i.bankName.value.trim(),
      bankAccount: i.bankAccount.value.trim(), bankIfsc: i.bankIfsc.value.trim().toUpperCase(), bankBranch: i.bankBranch.value.trim(),
      upiId: i.upiId.value.trim(), terms: i.terms.value, footer: i.footer.value.trim(), signatory: i.signatory.value.trim(),
      logo: logo.data || '', logoW: logo.width || 0, logoH: logo.height || 0,
    });
    return errs;
  });
}

export function billingSettings(ctx) {
  const { store } = ctx;
  const s = store.settings;
  const b = s.billing;
  const num = {};
  const numLabels = { sale: 'Sales invoice', purchase: 'Purchase', quotation: 'Quotation', receipt: 'Payment receipt', voucher: 'Payment voucher' };
  for (const k of Object.keys(numLabels)) {
    const cfg = s.numbering[k];
    num[k] = {
      prefix: textInput('prefix-' + k, cfg.prefix),
      next: textInput('next-' + k, String(cfg.next), { inputmode: 'numeric' }),
      pad: selectInput('pad-' + k, ['1', '2', '3', '4', '5', '6'], String(cfg.pad)),
      preview: h('div', { class: 'small muted' }),
    };
    const upd = () => { num[k].preview.textContent = 'Next: ' + formatDocNumber({ prefix: num[k].prefix.value, next: parseInt(num[k].next.value, 10) || 1, pad: parseInt(num[k].pad.value, 10) }); };
    for (const x of [num[k].prefix, num[k].next, num[k].pad]) x.addEventListener('input', upd);
    upd();
  }
  const i = {
    gstEnabled: h('input', { type: 'checkbox', checked: b.gstEnabled }),
    inclusive: selectInput('inclusive', [['false', 'Exclusive (GST added on top of rate)'], ['true', 'Inclusive (rate includes GST)']], String(b.inclusive)),
    defaultGst: selectInput('defaultGst', GST_RATES.map((r) => [String(r), r + '%']), String(b.defaultGst)),
    chargesGst: selectInput('chargesGst', GST_RATES.map((r) => [String(r), r + '%']), String(b.chargesGst)),
    roundOff: h('input', { type: 'checkbox', checked: b.roundOff }),
    qtyDecimals: selectInput('qtyDecimals', [['0', '0 (whole numbers)'], ['1', '1'], ['2', '2'], ['3', '3']], String(b.qtyDecimals)),
    defaultPaymentMethod: selectInput('dpm', PAYMENT_METHODS, b.defaultPaymentMethod),
    defaultUnit: selectInput('unit', UNITS, b.defaultUnit),
    dueDays: textInput('dueDays', String(b.dueDays || 0), { inputmode: 'numeric' }),
    currencySymbol: textInput('cur', b.currencySymbol, { maxlength: 4 }),
    currencyName: textInput('curName', b.currencyName),
    currencySubunit: textInput('curSub', b.currencySubunit),
    grouping: selectInput('grouping', [['indian', 'Indian (12,34,567.00)'], ['intl', 'International (1,234,567.00)']], b.grouping),
    dateFormat: selectInput('dateFormat', DATE_FORMATS.map((d) => [d, `${d} (${formatDate(today(), d)})`]), b.dateFormat),
    allowNegativeStock: h('input', { type: 'checkbox', checked: b.allowNegativeStock }),
    updatePurchasePrice: h('input', { type: 'checkbox', checked: b.updatePurchasePrice }),
    showHsnSummary: h('input', { type: 'checkbox', checked: b.showHsnSummary }),
    invoiceCopies: textInput('copies', b.invoiceCopies),
  };
  return settingsPage(ctx, 'Billing settings', () => h('div', { class: 'form' },
    h('div', { class: 'card form' }, h('h2', null, 'Tax'),
      h('label', { class: 'check' }, i.gstEnabled, 'GST registered (apply GST on documents)'),
      field('Default price mode', i.inclusive),
      h('div', { class: 'row' }, field('Default GST %', i.defaultGst), field('GST on charges', i.chargesGst)),
      h('label', { class: 'check' }, i.showHsnSummary, 'Print HSN/GST summary on invoices'),
      h('p', { class: 'note' }, 'GST calculations follow the rates and settings you choose. Please have your configuration validated by your accountant; BizBill does not guarantee legal or tax compliance.')),
    h('div', { class: 'card form' }, h('h2', null, 'Numbering'),
      Object.entries(numLabels).map(([k, l]) => h('div', { class: 'form', style: { borderBottom: '1px solid var(--border)', paddingBottom: '10px' } },
        h('b', null, l), h('div', { class: 'row three' }, field('Prefix', num[k].prefix), field('Next number', num[k].next), field('Digits', num[k].pad)), num[k].preview))),
    h('div', { class: 'card form' }, h('h2', null, 'Defaults'),
      h('div', { class: 'row' }, field('Payment method', i.defaultPaymentMethod), field('Unit', i.defaultUnit)),
      h('div', { class: 'row' }, field('Quantity decimals', i.qtyDecimals), field('Invoice due in (days)', i.dueDays)),
      h('label', { class: 'check' }, i.roundOff, 'Round off grand total to nearest rupee'),
      h('label', { class: 'check' }, i.allowNegativeStock, 'Allow sale when stock is insufficient'),
      h('label', { class: 'check' }, i.updatePurchasePrice, 'Update product purchase price from purchases'),
      field('Invoice copy label', i.invoiceCopies, { hint: 'e.g. ORIGINAL FOR RECIPIENT' })),
    h('div', { class: 'card form' }, h('h2', null, 'Currency & date'),
      h('div', { class: 'row three' }, field('Symbol', i.currencySymbol), field('Currency', i.currencyName), field('Sub-unit', i.currencySubunit)),
      field('Number grouping', i.grouping),
      field('Date format', i.dateFormat),
      h('div', { class: 'small muted' }, 'Preview: ' + formatMoney(12345678, { symbol: b.currencySymbol, grouping: b.grouping })))),
  (next) => {
    const errs = [];
    for (const k of Object.keys(numLabels)) {
      const n = parseInt(num[k].next.value, 10);
      if (!(n >= 1)) { errs.push(`${numLabels[k]}: next number must be 1 or more`); continue; }
      next.numbering[k] = { prefix: num[k].prefix.value.trim(), next: n, pad: parseInt(num[k].pad.value, 10) };
    }
    const due = parseInt(i.dueDays.value, 10);
    if (!(due >= 0 && due <= 365)) errs.push('Due days must be between 0 and 365');
    if (!i.currencySymbol.value.trim()) errs.push('Currency symbol is required');
    Object.assign(next.billing, {
      gstEnabled: i.gstEnabled.checked, inclusive: i.inclusive.value === 'true', defaultGst: Number(i.defaultGst.value), chargesGst: Number(i.chargesGst.value),
      roundOff: i.roundOff.checked, qtyDecimals: parseInt(i.qtyDecimals.value, 10), defaultPaymentMethod: i.defaultPaymentMethod.value,
      defaultUnit: i.defaultUnit.value, dueDays: due || 0, currencySymbol: i.currencySymbol.value.trim(), currencyName: i.currencyName.value.trim() || 'Rupees',
      currencySubunit: i.currencySubunit.value.trim() || 'Paise', grouping: i.grouping.value, dateFormat: i.dateFormat.value,
      allowNegativeStock: i.allowNegativeStock.checked, updatePurchasePrice: i.updatePurchasePrice.checked, showHsnSummary: i.showHsnSummary.checked,
      invoiceCopies: i.invoiceCopies.value.trim(),
    });
    return errs;
  });
}

export function appearanceSettings(ctx) {
  const { store, app } = ctx;
  const ui = store.settings.ui;
  const theme = selectInput('theme', [['system', 'System default'], ['light', 'Light'], ['dark', 'Dark']], ui.theme);
  const fullscreen = h('input', { type: 'checkbox', checked: ui.fullscreen });
  const range = selectInput('range', [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['fy', 'This financial year']], ui.dashboardRange);
  const cards = DASHBOARD_CARDS.map(([k, l]) => ({ k, input: h('input', { type: 'checkbox', checked: ui.dashboardCards.includes(k) }), l }));
  const tabs = NAV_TABS.map(([k, l]) => ({ k, input: h('input', { type: 'checkbox', checked: ui.navTabs.includes(k), disabled: k === 'dashboard' }), l }));
  theme.addEventListener('change', () => { document.documentElement.dataset.theme = theme.value === 'dark' || (theme.value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; });
  const page = settingsPage(ctx, 'Appearance & dashboard', () => h('div', { class: 'form' },
    h('div', { class: 'card form' }, h('h2', null, 'Display'), field('Theme', theme), h('label', { class: 'check' }, fullscreen, 'Full screen mode (hide system bars)')),
    h('div', { class: 'card form' }, h('h2', null, 'Dashboard'), field('Default period', range),
      h('div', { class: 'small muted' }, 'Cards to show'), cards.map((c) => h('label', { class: 'check' }, c.input, c.l))),
    h('div', { class: 'card form' }, h('h2', null, 'Bottom navigation'), h('div', { class: 'small muted' }, 'Choose up to 5 tabs. Everything else is under "More".'),
      tabs.map((t) => h('label', { class: 'check' }, t.input, t.l)))),
  (next) => {
    const nav = tabs.filter((t) => t.input.checked).map((t) => t.k);
    if (nav.length > 5) return ['Choose at most 5 navigation tabs'];
    Object.assign(next.ui, {
      theme: theme.value, fullscreen: fullscreen.checked, dashboardRange: range.value,
      dashboardCards: cards.filter((c) => c.input.checked).map((c) => c.k),
      navTabs: nav.includes('dashboard') ? nav : ['dashboard', ...nav].slice(0, 5),
    });
    setTimeout(() => { app.applyTheme(); bridge.setFullscreen(next.ui.fullscreen); }, 0);
    return [];
  });
  const origLeave = page.onLeave;
  page.onLeave = () => { app.applyTheme(); if (origLeave) origLeave(); };
  return page;
}

export function securitySettings({ store, app }) {
  const sec = store.settings.security;
  const host = h('div');
  const save = async (patch, summary) => {
    await store.patchSettings('security', patch, summary);
    bridge.setSecureScreen(store.settings.security.enabled && store.settings.security.secureScreen);
    draw();
  };
  const setPin = async (change) => {
    if (change && !(await askPin(store, 'Enter current PIN', true))) return;
    const pin = await askNewPin();
    if (!pin) return;
    const h2 = await hashPin(pin);
    await save({ ...h2, enabled: true }, change ? 'App lock PIN changed' : 'App lock enabled');
    toast(change ? 'PIN changed' : 'App lock enabled', 'good');
  };
  const draw = () => {
    const s = store.settings.security;
    clear(host);
    const bioAvailable = bridge.canUseBiometric();
    put(host, 
      h('div', { class: 'card' },
        switchRow('App lock', s.enabled ? 'PIN required to open BizBill' : 'Protect BizBill with a PIN', s.enabled, async (on) => {
          if (on) await setPin(false);
          else {
            if (await askPin(store, 'Enter PIN to disable lock', true)) await save({ enabled: false, pinHash: '', pinSalt: '', biometric: false }, 'App lock disabled');
            else draw();
          }
        }),
        s.enabled ? h('div', null,
          switchRow('Fingerprint / biometric', bioAvailable ? 'Unlock with biometrics (PIN still works)' : 'Not available on this device', s.biometric && bioAvailable, async (on) => {
            if (on) {
              const r = await bridge.authenticateBiometric('Confirm biometric unlock');
              if (!r || !r.ok) { toast('Biometric not confirmed', 'bad'); draw(); return; }
            }
            await save({ biometric: on }, 'Biometric unlock ' + (on ? 'enabled' : 'disabled'));
          }, { disabled: !bioAvailable }),
          switchRow('Lock on app start', 'Ask for PIN every time the app opens', s.lockOnStart, (on) => save({ lockOnStart: on })),
          h('div', { class: 'switch-row' }, h('div', null, h('div', { class: 't' }, 'Auto-lock after leaving the app'), h('div', { class: 'd' }, 'When the app was in background this long')),
            selectInput('auto', [['0', 'Immediately'], ['1', '1 minute'], ['5', '5 minutes'], ['15', '15 minutes'], ['60', '1 hour'], ['100000', 'Never']], String(s.autoLockMinutes), { style: { width: 'auto' }, onchange: (e) => save({ autoLockMinutes: parseInt(e.target.value, 10) }) })),
          h('div', { class: 'switch-row' }, h('div', null, h('div', { class: 't' }, 'Lock after inactivity'), h('div', { class: 'd' }, 'While the app is open but unused')),
            selectInput('idle', [['0', 'Off'], ['2', '2 minutes'], ['5', '5 minutes'], ['10', '10 minutes'], ['30', '30 minutes']], String(s.inactivityMinutes), { style: { width: 'auto' }, onchange: (e) => save({ inactivityMinutes: parseInt(e.target.value, 10) }) })),
          switchRow('Secure screen', 'Hide content in recent apps and block screenshots (Android)', s.secureScreen, (on) => save({ secureScreen: on })),
          h('div', { class: 'btn-row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: () => setPin(true) }, 'Change PIN'), h('button', { class: 'btn', onclick: () => { import('./lock.js').then((m) => m.showLock(store)); } }, 'Lock now'))) : null),
      h('p', { class: 'note' }, 'Your PIN is never stored. BizBill keeps only a salted PBKDF2 hash on this device, and backups never contain it. If you forget the PIN, you need to clear the app data and restore from a backup.'));
  };
  draw();
  void sec; void app;
  return { title: 'Security / App lock', back: true, content: host };
}

function askNewPin() {
  return openSheet((api) => {
    const a = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'new-password', placeholder: '4–8 digits', 'aria-label': 'New PIN' });
    const b = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'new-password', placeholder: 'Repeat PIN', 'aria-label': 'Repeat PIN' });
    const err = h('div', { class: 'err small' });
    const ok = () => {
      const e = pinError(a.value);
      if (e) { err.textContent = e; return; }
      if (a.value !== b.value) { err.textContent = 'PINs do not match'; return; }
      api.close(a.value);
    };
    return h('div', null, h('h2', null, 'Set PIN'), h('div', { class: 'form' }, field('New PIN', a), field('Confirm PIN', b), err),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, 'Save PIN')));
  });
}

function askPin(store, title) {
  return openSheet((api) => {
    const a = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, autocomplete: 'current-password', 'aria-label': 'PIN' });
    const err = h('div', { class: 'err small' });
    const ok = async () => {
      if (await verifyPin(a.value, store.settings.security)) api.close(true);
      else { err.textContent = 'Incorrect PIN'; a.value = ''; }
    };
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    return h('div', null, h('h2', null, title), field('PIN', a), err,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => api.close(false) }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, 'OK')));
  }).then((v) => !!v);
}

export function notificationSettings({ store }) {
  const host = h('div');
  const save = (patch) => store.patchSettings('notifications', patch, 'Notification settings updated').then(draw);
  const draw = () => {
    const n = store.settings.notifications;
    clear(host);
    put(host, h('div', { class: 'card' },
      switchRow('Notifications', 'Local alerts on this device only', n.enabled, async (on) => {
        if (on) {
          const r = await bridge.requestNotificationPermission();
          if (r && r.ok === false) toast('Notification permission was not granted. You can enable it in system settings.', 'bad');
        }
        save({ enabled: on });
      }),
      n.enabled ? h('div', null,
        switchRow('Low stock', 'Daily alert when items reach minimum stock', n.lowStock, (on) => save({ lowStock: on })),
        switchRow('Outstanding payments', 'Customers with dues older than 30 days', n.outstanding, (on) => save({ outstanding: on })),
        switchRow('Payment due', 'Invoices due in the next 2 days or overdue', n.paymentDue, (on) => save({ paymentDue: on })),
        switchRow('Backup reminder', 'Remind when no backup was taken recently', n.backupReminder, (on) => save({ backupReminder: on })),
        n.backupReminder ? h('div', { class: 'switch-row' }, h('div', null, h('div', { class: 't' }, 'Remind after')),
          selectInput('days', [['1', '1 day'], ['3', '3 days'], ['7', '7 days'], ['15', '15 days'], ['30', '30 days']], String(n.backupReminderDays), { style: { width: 'auto' }, onchange: (e) => save({ backupReminderDays: parseInt(e.target.value, 10) }) })) : null,
        switchRow('App update available', 'Only when automatic update check is on (Update center)', n.updates, (on) => save({ updates: on }))) : null),
    h('p', { class: 'note' }, 'Alerts are computed on this device when BizBill is opened. No business data is sent to any server or notification service.'),
    n.enabled ? h('button', { class: 'btn block', onclick: () => { if (!bridge.notify(99, 'BizBill', 'Notifications are working.')) toast('Could not show a notification. Check permissions.', 'bad'); } }, 'Send test notification') : null);
  };
  draw();
  return { title: 'Notifications', back: true, content: host };
}

