// End-to-end flow through the real UI in a mobile viewport (Chromium).
// Usage: npm run test:e2e   (set CHROME=/path/to/chrome if needed)
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start } from '../../tools/serve.mjs';

const exe = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const shots = process.env.SHOTS || '';
const server = await start(8182);
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

let shotN = 0;
async function shot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${String(++shotN).padStart(2, '0')}-${name}.png`, fullPage: false });
}
const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(300); };
const fill = async (sel, v) => { await page.fill(sel, v); };
const saveBar = async () => { await page.locator('.savebar .btn.primary').click(); await page.waitForTimeout(400); };
const text = async (sel) => (await page.textContent(sel)) || '';

try {
  await page.goto('http://127.0.0.1:8182/index.html#/dashboard');
  await page.waitForSelector('.appbar');
  await shot('dashboard-empty');

  // --- Company profile
  await go('#/settings/company');
  await fill('input[name=name]', 'Sharma Electricals');
  await fill('input[name=gstin]', '27AAPFU0939F1ZV');
  await page.locator('input[name=gstin]').dispatchEvent('change');
  await fill('input[name=mobile]', '9876500000');
  await fill('input[name=upiId]', 'sharma@upi');
  await saveBar();
  assert.equal(await page.inputValue('select[name=stateCode]').catch(() => '27'), '27');

  // --- Product
  await go('#/product/new');
  await fill('input[name=name]', 'LED Bulb 9W');
  await fill('input[name=sku]', 'LB9');
  await fill('input[name=hsn]', '8539');
  await fill('input[name=salePrice]', '100');
  await fill('input[name=purchasePrice]', '60');
  await page.selectOption('select[name=gst]', '1800');
  await fill('input[name=openingStock]', '50');
  await fill('input[name=minStock]', '10');
  await shot('product-form');
  await saveBar();
  assert.match(await text('.appbar h1'), /LED Bulb 9W/);

  // --- Customer
  await go('#/party/new/customer');
  await fill('input[name=name]', 'Rahul Traders');
  await fill('input[name=mobile]', '9822012345');
  await fill('input[name=opening]', '500');
  await saveBar();
  assert.match(await text('.appbar h1'), /Rahul Traders/);

  // --- Invoice: 5 bulbs @100 +18% = 590, receive 200 (partial)
  await go('#/doc/new/sale');
  await page.waitForTimeout(400);
  // item picker opens automatically when products exist
  await page.locator('.sheet .item').filter({ hasText: 'LED Bulb 9W' }).first().click();
  await page.waitForTimeout(200);
  await page.fill('.line input[name=qty]', '5');
  await page.locator('.card').filter({ hasText: 'Customer' }).first().getByText('Select customer').click();
  await page.locator('.sheet .item').filter({ hasText: 'Rahul Traders' }).first().click();
  await fill('input[name=payAmount]', '200');
  await page.waitForTimeout(300);
  const total = await text('.savebar .total b');
  assert.equal(total, '₹590.00');
  await shot('invoice-form');
  await saveBar();
  assert.match(await text('.appbar h1'), /Invoice INV-0001/);
  assert.match(await text('.content'), /Due ₹390\.00/);
  await shot('invoice-view');

  // --- Dashboard reflects real data
  await go('#/dashboard');
  const kpiText = await text('.kpis');
  assert.match(kpiText, /Sales₹590\.00/);
  assert.match(kpiText, /Collection₹200\.00/);
  assert.match(kpiText, /To Receive₹890\.00/); // 500 opening + 390 due
  assert.match(kpiText, /Net Profit₹200\.00/); // 5 x (100 - 60)
  await shot('dashboard');

  // --- Stock decreased
  await go('#/inventory');
  assert.match(await text('.content'), /45 PCS/);

  // --- PDF + JPG generation in the browser
  const sizes = await page.evaluate(async () => {
    const a = await import('./js/docs/actions.js');
    const app = (await import('./js/app.js')).default;
    const d = app.store.listDocuments('sale')[0];
    const spec = a.invoiceSpec(app.store, d);
    const pdf = await a.buildPdf(spec);
    const jpg = await a.buildJpg(spec);
    const head = new Uint8Array(await pdf.slice(0, 5).arrayBuffer());
    return { pdf: pdf.size, jpg: jpg.size, head: String.fromCharCode(...head), jpgType: jpg.type };
  });
  assert.equal(sizes.head, '%PDF-');
  assert.ok(sizes.pdf > 3000);
  assert.equal(sizes.jpgType, 'image/jpeg');
  assert.ok(sizes.jpg > 10000);

  // --- Receive the balance via payment screen (auto-allocated to the invoice)
  await go('#/payment/new/in');
  await page.getByText('Select customer').click();
  await page.locator('.sheet .item').filter({ hasText: 'Rahul Traders' }).first().click();
  await fill('input[name=amount]', '390');
  await page.locator('input[name=amount]').dispatchEvent('change');
  await page.getByText('Auto allocate (oldest first)').click();
  await saveBar();
  assert.match(await text('.appbar h1'), /Receipt RCT-0002/);
  await go('#/sales');
  assert.match(await text('.content'), /Paid/i);

  // --- Global search
  await go('#/search');
  await page.fill('.searchbar input', 'INV-0001');
  await page.waitForTimeout(300);
  assert.match(await text('.content'), /Invoice INV-0001/);

  // --- Reports render with data
  await go('#/report/sales-summary');
  await page.getByText('All Time', { exact: true }).click();
  await page.waitForTimeout(200);
  assert.match(await text('table.data'), /INV-0001/);

  // --- Cancel invoice restores stock
  const docId = await page.evaluate(async () => (await import('./js/app.js')).default.store.listDocuments('sale')[0].id);
  await go('#/doc/' + docId);
  await page.locator('.actions-grid .btn').filter({ hasText: 'Cancel' }).click();
  await page.locator('.sheet .btn.danger').click();
  await page.fill('.sheet input', 'Test cancel');
  await page.locator('.sheet .btn.primary').click();
  await page.waitForTimeout(400);
  assert.match(await text('.content'), /Cancelled/);
  await go('#/inventory');
  assert.match(await text('.content'), /50 PCS/);
  await go('#/report/sales-summary');
  assert.match(await text('table.data'), /No records/, 'cancelled invoice is excluded from reports');

  // --- Backup create + validate round trip (in page)
  const ok = await page.evaluate(async () => {
    const app = (await import('./js/app.js')).default;
    const b = await import('./js/core/backup.js');
    const backup = await b.createBackup(app.store);
    const v = await b.validateBackup(JSON.parse(JSON.stringify(backup)));
    return v.ok && backup.counts.sales === 1;
  });
  assert.ok(ok);

  // --- Dark mode
  await go('#/settings/appearance');
  await page.selectOption('select[name=theme]', 'dark');
  await saveBar();
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await go('#/dashboard');
  await shot('dashboard-dark');

  // --- App lock: set PIN, lock, unlock
  await go('#/settings/security');
  await page.locator('.switch input').first().check();
  await page.waitForTimeout(200);
  const pins = page.locator('.sheet input[type=password]');
  await pins.nth(0).fill('2580');
  await pins.nth(1).fill('2580');
  await page.locator('.sheet .btn.primary').click();
  await page.waitForTimeout(1500);
  await page.getByText('Lock now').click();
  await page.waitForSelector('.lock');
  await shot('lock');
  for (const k of '2580') await page.locator('.keypad button', { hasText: k }).click();
  await page.locator('.keypad button[aria-label=Unlock]').click();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.lock').count(), 0);

  assert.deepEqual(errors, []);
  console.log('E2E flow passed');
} catch (e) {
  await shot('failure');
  console.error('E2E FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
