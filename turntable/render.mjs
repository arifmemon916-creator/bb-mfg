// Renders the turntable frame by frame in headless Chromium and encodes an MP4.
//   node render.mjs [--w 3840 --h 2160 --fps 30 --out out/pio-bindas-turntable-4k.mp4 --frames N]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const W = +arg('w', 3840), H = +arg('h', 2160), FPS = +arg('fps', 30), SECONDS = 12;
const TOTAL = FPS * SECONDS;
const LIMIT = +arg('frames', TOTAL);
const ONLY = arg('only') ? arg('only').split(',').map(Number) : null; // preview specific frames
const OUT = path.resolve(here, arg('out', `out/pio-bindas-turntable-${H >= 2160 ? '4k' : H + 'p'}.mp4`));
const FRAMES = path.resolve(here, arg('framesDir', `out/frames-${H}`));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
if (process.argv.includes('--only')) fs.mkdirSync(FRAMES, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(here) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => { console.error('[page error]', e); process.exit(1); });
await page.goto(`http://localhost:${port}/index.html?render&w=${W}&h=${H}`);
await page.waitForFunction(() => window.ready && window.renderFrame, null, { timeout: 120000 });
await page.evaluate(() => window.ready);

// Preview mode (--only) writes PNGs; otherwise frames are streamed straight into ffmpeg.
let ff = null, ffDone = null;
if (!ONLY) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  ff = spawn(FFMPEG, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', 'vignette=PI/5', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
}

const t0 = Date.now();
const list = ONLY || [...Array(LIMIT).keys()];
for (const i of list) {
  const url = await page.evaluate(([i, n]) => window.renderFrame(i, n), [i, TOTAL]);
  const png = Buffer.from(url.split(',')[1], 'base64');
  if (ff) { if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r)); }
  else fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(4, '0')}.png`), png);
  console.log(`frame ${i + 1}/${TOTAL}  ${((Date.now() - t0) / 1000).toFixed(1)}s elapsed`);
}
await browser.close();
server.close();
if (ff) { ff.stdin.end(); await ffDone; console.log('wrote', OUT); }
