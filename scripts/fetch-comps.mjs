// Refresh market comps for financed models via Monid (mrscraper listing extractor on marketplace search pages).
// Writes fixtures/comps-live.json, which lib/valuation.js uses for collateral coverage.
// Usage: node scripts/fetch-comps.mjs ["make model|minPrice" ...]
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../lib/env.js';
import { root } from '../lib/data.js';

loadEnv();
const KEY = process.env.MONID_API_KEY;
if (!KEY) throw new Error('MONID_API_KEY missing');
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const OUT = path.join(root, 'fixtures/comps-live.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --collect-since <iso>: don't start new scrapes, just collect runs started after that time.
const ci = process.argv.indexOf('--collect-since');
const since = ci > 0 ? process.argv[ci + 1] : null;
const cliTargets = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--collect-since');
const targets = (cliTargets.length ? cliTargets : [
  'John Deere 3038E|12000',
  'Kubota BX2380|9000',
  'Kubota L3902|12000',
  'John Deere 5075E|25000',
  'Bobcat T66|30000',
]).map((s) => {
  const [model, min] = s.split('|');
  return { model, min: Number(min) || 5000 };
});

async function start(t) {
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(t.model.toLowerCase())}&_udlo=${t.min}&_sacat=0`;
  const body = {
    provider: 'mrscraper',
    endpoint: '/scrape/listing',
    input: { body: { url, prompt: 'Extract every equipment/machine listing (not parts or manuals) as items with: title, price_usd (number), year (number or null), hours (number or null), location, condition, listing_url.', maxPages: 1, blockResources: true, timeout: 120 } },
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 8000);
  // Sync provider: the HTTP call can outlive the gateway; the run continues server-side, so we find it via /runs.
  const t0 = new Date(Date.now() - 2000).toISOString();
  try { await fetch('https://api.monid.ai/v1/run', { method: 'POST', headers: H, body: JSON.stringify(body), signal: ac.signal }); } catch {}
  return { ...t, url, t0 };
}

// The runs list omits inputs, so fetch each recent run's detail to match it to its search URL.
const detailCache = new Map();
async function findRun(t) {
  const r = await (await fetch('https://api.monid.ai/v1/runs?limit=40', { headers: H })).json();
  for (const x of r.items || []) {
    if (x.createdAt < t.t0) continue;
    let d = detailCache.get(x.runId);
    if (!d || !['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT'].includes(d.status)) {
      d = await (await fetch(`https://api.monid.ai/v1/runs/${x.runId}`, { headers: H })).json();
      detailCache.set(x.runId, d);
    }
    if (d.input?.body?.url === t.url) return d;
  }
  return null;
}

const started = [];
for (const t of targets) {
  if (since) {
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(t.model.toLowerCase())}&_udlo=${t.min}&_sacat=0`;
    started.push({ ...t, url, t0: since });
  } else started.push(await start(t));
}
console.log(since ? 'collecting' : 'started', started.map((s) => s.model).join(', '));

const live = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const pending = new Set(started);
const until = Date.now() + 9 * 60 * 1000;
while (pending.size && Date.now() < until) {
  await sleep(8000);
  for (const t of [...pending]) {
    const run = await findRun(t).catch(() => null);
    if (!run || !['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT'].includes(run.status)) continue;
    pending.delete(t);
    const full = await (await fetch(`https://api.monid.ai/v1/runs/${run.runId}`, { headers: H })).json();
    let data = full.output;
    if (data?.data?.download_link) data = await (await fetch(data.data.download_link)).json();
    const items = (data?.data?.response || []).flatMap((p) => p?.data?.data || []);
    const machines = items.filter((i) => typeof i.price_usd === 'number' && i.price_usd >= t.min * 0.8).map((i) => ({ title: i.title?.replace(/ Opens in a new window or tab$/, ''), price_usd: i.price_usd, year: i.year ?? null, hours: i.hours ?? null, location: i.location ?? null, listing_url: i.listing_url ?? null }));
    console.log(`${t.model}: ${run.status}, ${items.length} items, ${machines.length} machines`);
    if (machines.length) {
      const key = t.model.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      live[key] = { provider: 'mrscraper/scrape/listing', run_id: run.runId, url: t.url, fetched_at: new Date().toISOString(), items: machines };
      fs.writeFileSync(OUT, JSON.stringify(live, null, 1));
    }
  }
}
console.log('done; models with live comps:', Object.keys(live).join(', ') || 'none');
