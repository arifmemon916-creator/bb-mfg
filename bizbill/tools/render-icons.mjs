// Renders legacy launcher PNGs (Android 7.x) from www/icons/icon.svg.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const svg = fs.readFileSync('www/icons/icon.svg', 'utf8');
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
for (const [d, px] of Object.entries(sizes)) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${px}" height="${px}" `)}</body></html>`);
  const dir = `android/app/src/main/res/mipmap-${d}`;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/ic_launcher.png`, omitBackground: true });
}
await browser.close();
