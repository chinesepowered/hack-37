// Portfolio (the lender's floor-plan ledger) and the ground truth of what each dealer site lists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

export const portfolio = readJson('fixtures/portfolio.json');
export const dealerSites = readJson('fixtures/dealer-sites.json');

export const dealerById = Object.fromEntries(portfolio.dealers.map((d) => [d.id, d]));
export const unitById = Object.fromEntries(portfolio.units.map((u) => [u.id, u]));

export const normSerial = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

// Fallback implementation of the listing rules; the site builder exports the canonical one.
function localBuildListings(pf, sites) {
  const out = {};
  for (const d of pf.dealers) {
    const site = sites[d.id] || {};
    const overrides = site.overrides || {};
    const rows = [];
    for (const u of pf.units.filter((x) => x.dealer_id === d.id)) {
      const o = overrides[u.serial] || {};
      if (o.status === 'MISSING') continue;
      const status = o.status || 'AVAILABLE';
      rows.push({
        serial: u.serial, year: u.year, make: u.make, model: u.model, category: u.category,
        status, price: status === 'SOLD' ? null : Math.round((u.advance * (1.12 + hash(u.serial) * 0.1)) / 100) * 100,
        hours: Math.floor(hash(u.serial + 'h') * 60), condition: 'New', financed: true,
      });
    }
    for (const x of site.extras || []) rows.push({ ...x, status: 'AVAILABLE', financed: false });
    out[d.id] = rows;
  }
  return out;
}

let cachedTruth = null;
export async function groundTruthListings() {
  if (cachedTruth) return cachedTruth;
  try {
    const mod = await import('../scripts/build-dealer-sites.mjs');
    if (typeof mod.buildListings === 'function') cachedTruth = mod.buildListings(portfolio, dealerSites);
  } catch {}
  if (!cachedTruth) cachedTruth = localBuildListings(portfolio, dealerSites);
  return cachedTruth;
}

export function dealerUrl(dealerId, base) {
  const b = (base || '').replace(/\/$/, '');
  return `${b}/${dealerId}/`;
}

export { root };
