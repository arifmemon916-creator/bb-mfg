// Builds a single, self-contained BizBill.html that can be opened directly
// in a browser (double-click, file://) with no local server and no other
// files: bundles all JS (esbuild, IIFE, no code-splitting) and inlines the
// CSS, the jsPDF vendor library and the app icon as data/text.
//
// Usage: node tools/build-standalone.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'www');
const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild');
const outFile = path.join(root, 'GrowBBPro.html');

execFileSync(esbuild, [
  path.join(www, 'js', 'app.js'),
  '--bundle',
  '--format=iife',
  `--outfile=${path.join(root, '.standalone-bundle.js')}`,
], { stdio: 'inherit' });

const bundleJs = fs.readFileSync(path.join(root, '.standalone-bundle.js'), 'utf8');
fs.rmSync(path.join(root, '.standalone-bundle.js'));
const css = fs.readFileSync(path.join(www, 'css', 'app.css'), 'utf8');
const jspdf = fs.readFileSync(path.join(www, 'vendor', 'jspdf.umd.min.js'), 'utf8');
const iconSvg = fs.readFileSync(path.join(www, 'icons', 'icon.svg'), 'utf8');
const iconDataUri = 'data:image/svg+xml;base64,' + Buffer.from(iconSvg).toString('base64');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1f4e79">
  <meta name="color-scheme" content="light dark">
  <title>BizBill</title>
  <link rel="icon" href="${iconDataUri}" type="image/svg+xml">
  <style>
${css}
  </style>
</head>
<body>
  <div id="app" aria-live="polite">
    <div class="boot"><div class="boot-logo">B</div><p>Loading BizBill…</p></div>
  </div>
  <div id="toast" role="status" aria-live="polite"></div>
  <noscript>BizBill needs JavaScript enabled.</noscript>
  <script>
${jspdf}
  </script>
  <script>
${bundleJs}
  </script>
</body>
</html>
`;

fs.writeFileSync(outFile, html);
console.log(`Wrote ${outFile} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
