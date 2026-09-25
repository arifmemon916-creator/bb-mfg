// Quick smoke run: open every route in a mobile viewport and report errors.
import { chromium } from 'playwright-core';
import { start } from '../../tools/serve.mjs';

const exe = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = await start(8181);
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8181/index.html#/dashboard');
await page.waitForSelector('.appbar');
const routes = ['dashboard', 'sales', 'purchases', 'quotations', 'doc/new/sale', 'doc/new/purchase', 'doc/new/quotation', 'customers', 'suppliers',
  'party/new/customer', 'products', 'product/new', 'inventory', 'payments', 'payment/new/in', 'receivables', 'payables', 'expenses', 'expense/new',
  'reports', 'report/sales-summary', 'report/fin-pl', 'report/gst-hsn', 'gst', 'pl', 'more', 'search', 'settings', 'settings/company', 'settings/billing',
  'settings/appearance', 'settings/security', 'settings/notifications', 'backup', 'import', 'audit', 'recycle', 'update', 'about', 'ledger'];
for (const r of routes) {
  await page.evaluate((h) => { history.replaceState(null, '', '#/' + h); window.dispatchEvent(new HashChangeEvent('hashchange')); }, r);
  await page.waitForTimeout(250);
  // close any dialog opened automatically
  await page.keyboard.press('Escape');
  const title = await page.textContent('.appbar h1').catch(() => '?');
  console.log(r.padEnd(24), '→', title);
}
if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No errors');
await browser.close();
server.close();
