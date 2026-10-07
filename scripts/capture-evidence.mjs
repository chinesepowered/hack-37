#!/usr/bin/env node
// Captures evidence screenshots of the fake dealer sites with Playwright (global install).
//   public/evidence/{serial}.png      - browser capture around every SOLD / SALE_PENDING card
//   public/evidence/site-{dealer}.png - top of each dealer page (viewport only)
// Run `npm run build:sites` first.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'evidence');
const DEALERS = ['valley-ag', 'ironline', 'bayshore'];
const VIEWPORT = { width: 1440, height: 900 };
const MARGIN = 40;
const MAX_W = 1000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) throw new Error('forbidden');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const written = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    for (const id of DEALERS) {
      const url = `${base}/dealers/${id}/`;
      const resp = await page.goto(url, { waitUntil: 'load' });
      if (!resp || !resp.ok()) throw new Error(`Failed to load ${url}: ${resp && resp.status()}`);
      await page.evaluate(() => document.fonts && document.fonts.ready);

      const sitePng = path.join(OUT, `site-${id}.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: sitePng });
      written.push(sitePng);

      const serials = await page.$$eval('article.unit[data-status="SOLD"], article.unit[data-status="SALE_PENDING"]', (els) =>
        els.map((e) => ({ serial: e.dataset.serial, status: e.dataset.status })),
      );
      for (const { serial, status } of serials) {
        const card = page.locator(`article.unit[data-serial="${serial}"]`);
        await card.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
        await page.waitForTimeout(50);
        const box = await card.boundingBox(); // viewport-relative
        if (!box) throw new Error(`No bounding box for ${serial}`);
        const width = Math.min(MAX_W, box.width + 2 * MARGIN);
        let x = Math.max(0, box.x + box.width / 2 - width / 2);
        x = Math.min(x, VIEWPORT.width - width);
        const y = Math.max(0, box.y - MARGIN);
        const height = Math.min(VIEWPORT.height - y, box.height + (box.y - y) + MARGIN);
        const file = path.join(OUT, `${serial}.png`);
        await page.screenshot({ path: file, clip: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } });
        written.push(file);
        console.log(`${id}: ${status.padEnd(12)} ${serial} -> public/evidence/${serial}.png`);
      }
      console.log(`${id}: site screenshot -> public/evidence/site-${id}.png`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`Wrote ${written.length} PNGs to public/evidence/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
