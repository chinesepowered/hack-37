// Collateral valuation: market comps per make/model (real Monid scrapes when cached, deterministic estimate otherwise).
import fs from 'node:fs';
import path from 'node:path';
import { root } from './data.js';

const LIVE_FILE = path.join(root, 'fixtures/comps-live.json');

export const modelKey = (u) => `${u.make} ${u.model}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Units whose advance is above what the market pays today (stand-ins for real comps outcomes).
const UNDERWATER = { CIHMAG340JJF41207: 0.93, VCEC220EV00360144: 0.95 };

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function loadLive() {
  try {
    return JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function valueUnit(u, live = loadLive()) {
  const entry = live[modelKey(u)];
  if (entry?.items?.length) {
    const token = u.model.toLowerCase().replace(/[^a-z0-9]/g, '');
    const prices = entry.items
      .filter((it) => typeof it.price_usd === 'number' && it.price_usd > u.advance * 0.35 && it.price_usd < u.advance * 2.5)
      .filter((it) => String(it.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(token))
      .map((it) => it.price_usd);
    if (prices.length >= 3) {
      return {
        market_value: Math.round(median(prices) / 100) * 100,
        comps_count: prices.length,
        source: 'monid',
        provider: entry.provider,
        run_id: entry.run_id,
        query_url: entry.url,
        sample: entry.items.filter((it) => prices.includes(it.price_usd)).slice(0, 5),
      };
    }
  }
  const factor = UNDERWATER[u.serial] ?? 1.04 + hash(u.serial + 'mv') * 0.2;
  return { market_value: Math.round((u.advance * factor) / 100) * 100, comps_count: 0, source: 'estimate' };
}

export function valueUnits(units) {
  const live = loadLive();
  return units.map((u) => ({ unit_id: u.id, ...valueUnit(u, live) }));
}
