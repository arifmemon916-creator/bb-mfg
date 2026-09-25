// More menu, global search, update center, about / help.

import { h, icon, clear, debounce, put } from '../ui/dom.js';
import { switchRow, toast, errorToast, field, textInput } from '../ui/components.js';
import { globalSearch } from '../core/search.js';
import { checkForUpdate, currentVersion } from '../services/update.js';
import { openExternal, isAndroidApp, appInfo } from '../platform/bridge.js';
import { APP_VERSION } from '../core/backup.js';

const tile = (href, ic, label) => h('a', { href }, icon(ic), label);

export function more({ store }) {
  const s = store.settings;
  return {
    title: 'More',
    content: h('div', null,
      h('div', { class: 'section-title' }, 'Transactions'),
      h('div', { class: 'quick' },
        tile('#/sales', 'sales', 'Sales'), tile('#/purchases', 'purchase', 'Purchases'), tile('#/quotations', 'quote', 'Quotations'), tile('#/payments', 'wallet', 'Payments'),
        tile('#/expenses', 'expense', 'Expenses'), tile('#/receivables', 'in', 'Receivables'), tile('#/payables', 'out', 'Payables'), tile('#/inventory', 'box', 'Inventory')),
      h('div', { class: 'section-title' }, 'Masters'),
      h('div', { class: 'quick' },
        tile('#/customers', 'users', 'Customers'), tile('#/suppliers', 'truck', 'Suppliers'), tile('#/products', 'tag', 'Products'), tile('#/ledger', 'book', 'Ledger')),
      h('div', { class: 'section-title' }, 'Reports'),
      h('div', { class: 'quick' },
        tile('#/reports', 'chart', 'All Reports'), tile('#/gst', 'percent', 'GST'), tile('#/pl', 'trend', 'Profit & Loss'), tile('#/report/stock-current', 'box', 'Stock')),
      h('div', { class: 'section-title' }, 'Settings & data'),
      h('div', { class: 'quick' },
        tile('#/settings/company', 'home', 'Company'), tile('#/settings/billing', 'settings', 'Billing'), tile('#/backup', 'download', 'Backup'), tile('#/import', 'upload', 'Import/Export'),
        tile('#/settings/security', 'lock', 'Security'), tile('#/settings/notifications', 'bell', 'Alerts'), tile('#/settings/appearance', 'grid', 'Appearance'), tile('#/settings', 'settings', 'All Settings'),
        tile('#/update', 'refresh', 'Updates'), tile('#/audit', 'clock', 'Activity'), tile('#/recycle', 'restore', 'Recycle Bin'), tile('#/about', 'help', 'Help')),
      h('p', { class: 'small muted', style: { textAlign: 'center', marginTop: '18px' } }, `${s.company.name || 'BizBill'} · BizBill ${currentVersion()} · Works offline`)),
  };
}

export function search({ store, app }) {
  const results = h('div');
  const input = h('input', { type: 'search', placeholder: 'Invoice no., customer, mobile, GSTIN, SKU, reference…', 'aria-label': 'Search everything', autofocus: true });
  const labels = { customer: 'Customer', supplier: 'Supplier', product: 'Product', sale: 'Invoice', purchase: 'Purchase', quotation: 'Quotation', payment: 'Payment' };
  const icons = { customer: 'users', supplier: 'truck', product: 'tag', sale: 'sales', purchase: 'purchase', quotation: 'quote', payment: 'wallet' };
  const draw = () => {
    clear(results);
    const q = input.value.trim();
    if (!q) { put(results, h('p', { class: 'small muted', style: { textAlign: 'center' } }, 'Search across invoices, purchases, quotations, customers, suppliers, products and payments.')); return; }
    const list = globalSearch(store, q, 60);
    if (!list.length) { put(results, h('div', { class: 'list' }, h('div', { class: 'empty' }, 'No results'))); return; }
    put(results, h('div', { class: 'list' }, list.map((r) => h('a', { class: 'item', href: r.route },
      h('div', { class: 'avatar' }, icon(icons[r.type] || 'search')),
      h('div', { class: 'main' }, h('div', { class: 'title' }, r.title), h('div', { class: 'subtitle' }, r.subtitle)),
      h('span', { class: 'badge info' }, labels[r.type] || r.type)))));
  };
  input.addEventListener('input', debounce(draw, 120));
  draw();
  setTimeout(() => input.focus(), 50);
  void app;
  return { title: 'Search', back: true, hideSearch: true, content: h('div', null, h('div', { class: 'searchbar' }, icon('search'), input), results) };
}

export function updateCenter({ store }) {
  const host = h('div');
  const status = h('div');
  const draw = () => {
    const u = store.settings.update;
    const info = appInfo();
    clear(host);
    const urlIn = textInput('url', u.url, { type: 'url' });
    put(host, 
      h('div', { class: 'card' },
        h('div', { class: 'small muted' }, 'Installed version'),
        h('div', { style: { fontSize: '1.4rem', fontWeight: 800 } }, currentVersion()),
        h('div', { class: 'small muted' }, isAndroidApp ? `Android app · build ${info.versionCode || '—'}` : 'Web version'),
        h('div', { class: 'small muted' }, 'Last checked: ' + (u.lastCheckedAt ? new Date(u.lastCheckedAt).toLocaleString() : 'never')),
        h('button', { class: 'btn primary block', style: { marginTop: '12px' }, onclick: check }, icon('refresh'), 'Check for updates'),
        status),
      h('div', { class: 'card' },
        switchRow('Check automatically', 'Once a day when the app opens (requires internet)', u.autoCheck, async (on) => { await store.patchSettings('update', { autoCheck: on }, 'Automatic update check ' + (on ? 'enabled' : 'disabled')); draw(); }),
        h('details', { class: 'more', style: { marginTop: '8px' } }, h('summary', null, 'Update source'),
          h('div', { class: 'form' }, field('Release URL (https)', urlIn, { hint: 'GitHub "latest release" API URL or a JSON file with {version, notes, url}' }),
            h('button', { class: 'btn', onclick: async () => {
              if (!/^https:\/\//.test(urlIn.value.trim())) { toast('URL must start with https://', 'bad'); return; }
              await store.patchSettings('update', { url: urlIn.value.trim() }, 'Update source changed');
              toast('Saved', 'good');
            } }, 'Save source')))),
      h('p', { class: 'note' }, 'Checking for updates is the only feature that uses the internet. Only the release information is downloaded; none of your business data is sent. Updates are installed by you from the download link — BizBill never installs anything silently.'));
  };
  const check = async () => {
    clear(status);
    put(status, h('p', { class: 'small muted' }, 'Checking…'));
    try {
      const r = await checkForUpdate(store);
      clear(status);
      if (r.available) {
        put(status, h('div', { class: 'note', style: { marginTop: '10px' } },
          h('b', null, `Version ${r.latest} is available`), r.publishedAt ? h('div', { class: 'small' }, 'Released ' + new Date(r.publishedAt).toLocaleDateString()) : null,
          r.notes ? h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' } }, r.notes) : null,
          r.downloadUrl ? h('button', { class: 'btn primary', style: { marginTop: '8px' }, onclick: () => openExternal(r.downloadUrl) }, icon('download'), 'Download update') : null,
          h('p', { class: 'small' }, 'Tip: take a backup before installing an update.')));
      } else {
        put(status, h('p', { class: 'small pos', style: { marginTop: '10px' } }, `You have the latest version (${r.current}).`));
      }
      draw();
      host.querySelector('.card').appendChild(status);
    } catch (e) {
      clear(status);
      put(status, h('p', { class: 'small neg', style: { marginTop: '10px' } }, e.message || String(e)));
      if (!/internet|release/i.test(e.message)) errorToast(e);
    }
  };
  draw();
  return { title: 'Update Center', back: true, content: host };
}

export function about({ store }) {
  const faq = [
    ['How do I create an invoice?', 'Tap + Invoice on the home screen, choose a customer (or type a walk-in name), add items, enter the payment received and tap Save. Share it on WhatsApp or print from the invoice screen.'],
    ['How is stock updated?', 'Sales reduce stock, purchases increase it and "Adjust stock" records manual corrections with a reason. Cancelling an invoice returns its stock automatically.'],
    ['How do I record a part payment?', 'Enter the amount received while creating the invoice, or later tap Receive on the invoice / customer. Payments can be applied to specific bills; any extra is kept as an advance.'],
    ['Can I delete an invoice?', 'Invoices, purchases and payments are cancelled (voided) instead of deleted so your records stay complete. Customers, suppliers, products and quotations go to the recycle bin and can be restored.'],
    ['How are GST values calculated?', 'Per line: taxable value = quantity × rate − discount. Intra-state supplies get CGST and SGST at half the rate each, inter-state supplies get IGST. With inclusive pricing the tax is extracted from the rate. All money is calculated in paise, so there are no rounding drifts. Please validate the configuration with your accountant.'],
    ['Where is my data?', 'Only on this device, inside the app. Nothing is uploaded. Use Backup & restore to keep copies elsewhere (Drive, email, PC) and to move to a new phone.'],
    ['I forgot my PIN', 'For security the PIN cannot be recovered. Clear the app\'s data from Android settings and restore your latest backup.'],
  ];
  return {
    title: 'About & Help',
    back: true,
    content: h('div', null,
      h('div', { class: 'card', style: { textAlign: 'center' } },
        h('div', { class: 'boot-logo', style: { margin: '0 auto 8px' } }, 'B'),
        h('h2', null, 'BizBill'),
        h('div', { class: 'small muted' }, `Version ${currentVersion()} (data format ${APP_VERSION})`),
        h('p', { class: 'small' }, 'Offline-first billing, GST, inventory and accounts for small businesses.')),
      h('div', { class: 'section-title' }, 'Help'),
      h('div', { class: 'list' }, faq.map(([q, a]) => h('details', { class: 'item', style: { display: 'block' } }, h('summary', { class: 'title', style: { cursor: 'pointer' } }, q), h('p', { class: 'small' }, a)))),
      h('div', { class: 'section-title' }, 'Privacy'),
      h('div', { class: 'card small' },
        h('p', null, 'BizBill stores all business data locally on your device. It has no account, no analytics and no advertising. The internet is used only when you check for updates.'),
        h('p', null, 'Documents are shared through Android\'s secure sharing system: files are exposed only through a temporary, read-only content link to the app you choose.')),
      h('div', { class: 'section-title' }, 'Disclaimer'),
      h('div', { class: 'card small' }, h('p', null, 'BizBill performs calculations according to the settings and rates you enter. It does not guarantee legal or tax compliance. Please have your GST configuration, reports and returns reviewed by a qualified accountant.')),
      h('div', { class: 'section-title' }, 'Open-source components'),
      h('div', { class: 'card small' }, h('p', null, 'jsPDF (MIT License) – PDF generation.'))),
  };
}
