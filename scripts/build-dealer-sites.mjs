#!/usr/bin/env node
// Builds the three fake dealer inventory websites the FloorCheck agent browses.
// Zero dependencies. Writes public/dealers/<dealer_id>/index.html.
// Also exports buildListings(portfolio, sites) so the server can reuse the exact same data.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- data ----

/** FNV-1a 32-bit hash: deterministic per string. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STATUSES = new Set(['AVAILABLE', 'SOLD', 'SALE_PENDING']);

/**
 * buildListings(portfolio, sites) -> { [dealer_id]: Listing[] }
 * Listing: { serial, year, make, model, category, status, price, hours, condition, financed, sold_label }
 *  - status: AVAILABLE | SOLD | SALE_PENDING (MISSING units are omitted entirely)
 *  - price: retail price in USD (number), or null when SOLD (the page shows no price for sold units)
 *  - financed: true for lender ledger units, false for dealer extras
 *  - sold_label: the label shown on the card for SOLD units, otherwise null
 * Order matches the page order (deterministic shuffle by serial hash).
 */
export function buildListings(portfolio, sites) {
  const out = {};
  for (const dealer of portfolio.dealers) {
    const site = sites[dealer.id];
    if (!site) continue;
    const overrides = site.overrides || {};
    const rows = [];
    for (const u of portfolio.units.filter((x) => x.dealer_id === dealer.id)) {
      const ov = overrides[u.serial] || {};
      const status = ov.status || 'AVAILABLE';
      if (status === 'MISSING') continue;
      if (!STATUSES.has(status)) throw new Error(`Unknown status ${status} for ${u.serial}`);
      const mult = 1.12 + (hash('price:' + u.serial) % 101) / 1000; // 1.120 .. 1.220
      const retail = Math.round((u.advance * mult) / 100) * 100;
      rows.push({
        serial: u.serial,
        year: u.year,
        make: u.make,
        model: u.model,
        category: u.category,
        status,
        price: status === 'SOLD' ? null : retail,
        hours: hash('hours:' + u.serial) % 61, // 0 .. 60
        condition: 'New',
        financed: true,
        sold_label: status === 'SOLD' ? ov.sold_label || 'SOLD' : null,
      });
    }
    for (const x of site.extras || []) {
      const ov = overrides[x.serial] || {};
      const status = ov.status || x.status || 'AVAILABLE';
      if (status === 'MISSING') continue;
      rows.push({
        serial: x.serial,
        year: x.year,
        make: x.make,
        model: x.model,
        category: x.category,
        status,
        price: status === 'SOLD' ? null : x.price,
        hours: x.hours,
        condition: x.condition,
        financed: false,
        sold_label: status === 'SOLD' ? ov.sold_label || 'SOLD' : null,
      });
    }
    // Deterministic shuffle seeded by serial hash, so extras are interleaved with ledger units.
    rows.sort((a, b) => hash('order:' + a.serial) - hash('order:' + b.serial) || (a.serial < b.serial ? -1 : 1));
    out[dealer.id] = rows;
  }
  return out;
}

// ------------------------------------------------------------- helpers ----

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => '$' + Number(n).toLocaleString('en-US');

const CATEGORY_LABELS = {
  tractor: 'Tractor',
  'compact-tractor': 'Compact Tractor',
  'utility-vehicle': 'Utility Vehicle',
  excavator: 'Excavator',
  'mini-excavator': 'Mini Excavator',
  'track-loader': 'Compact Track Loader',
  'skid-steer': 'Skid Steer Loader',
  backhoe: 'Backhoe Loader',
  'wheel-loader': 'Wheel Loader',
  telehandler: 'Telehandler',
  'boom-lift': 'Boom Lift',
  'compact-utility': 'Compact Utility Loader',
};
const catLabel = (c) => CATEGORY_LABELS[c] || c;

// --------------------------------------------------------- SVG artwork ----
// One <symbol> per category, drawn on a 240x140 canvas with the ground at y=124.

function equipmentSymbols(c) {
  const B = c.body, T = c.trim, K = '#25282b', D = c.dark, G = c.glass, M = c.metal, H = '#c9ced3';
  const wheel = (cx, cy, r) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${K}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r - 1.7}" fill="none" stroke="#474c51" stroke-width="2.8" stroke-dasharray="2.6 2.4"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.56).toFixed(1)}" fill="${T}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.56).toFixed(1)}" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="1.5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.18).toFixed(1)}" fill="${D}"/>`;
  const track = (x, w, h) => {
    const y = 124 - h, r = h / 2;
    let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${K}"/>`;
    s += `<rect x="${x + 3}" y="${y + 3}" width="${w - 6}" height="${h - 6}" rx="${r - 3}" fill="#3b3f43"/>`;
    s += `<line x1="${x + r}" y1="122.6" x2="${x + w - r}" y2="122.6" stroke="#4a4f54" stroke-width="2.6" stroke-dasharray="3 3"/>`;
    const n = Math.max(3, Math.round(w / 24));
    for (let i = 0; i < n; i++) {
      const cx = (x + r + ((w - 2 * r) * i) / (n - 1)).toFixed(1);
      const rr = i === 0 || i === n - 1 ? r - 4 : r - 6.5;
      s += `<circle cx="${cx}" cy="${y + r}" r="${rr}" fill="#5d6268"/><circle cx="${cx}" cy="${y + r}" r="2" fill="${K}"/>`;
    }
    return s;
  };
  const fender = (cx, cy, r1, r2) =>
    `<path d="M${cx - r2} ${cy} A${r2} ${r2} 0 0 1 ${cx + r2} ${cy} H${cx + r1} A${r1} ${r1} 0 0 0 ${cx - r1} ${cy} Z" fill="${B}"/>`;
  const shine = `fill="#fff" opacity=".2"`;
  const S = {};

  S.tractor =
    `<rect x="56" y="88" width="96" height="10" fill="${D}"/>` +
    `<path d="M38 96V72Q38 63 47 62L136 57V96Z" fill="${B}"/>` +
    `<path d="M38 70H45V94H38Z" fill="${D}" opacity=".6"/>` +
    `<path d="M48 66L132 61.5V64.5L48 69Z" ${shine}/>` +
    `<rect x="39" y="63.5" width="6" height="4" rx="1" fill="#ffe7a1"/>` +
    `<rect x="104" y="31" width="5" height="28" fill="${D}"/><rect x="102" y="28" width="9" height="4" rx="1" fill="${D}"/>` +
    `<path d="M130 98V56H180V98Z" fill="${B}"/>` +
    `<path d="M134 25H200L203 62H131Z" fill="${G}"/>` +
    `<path d="M140 28H160L158 40H139Z" fill="#fff" opacity=".35"/>` +
    `<rect x="129" y="24" width="5" height="40" fill="${B}"/><rect x="165" y="25" width="3" height="37" fill="${B}"/><rect x="199" y="24" width="5" height="40" fill="${B}"/>` +
    `<path d="M123 18H208Q212 18 212 22V26H123Z" fill="${B}"/><rect x="123" y="25" width="89" height="2" fill="${D}" opacity=".45"/>` +
    wheel(64, 103, 21) + wheel(170, 91, 33) + fender(170, 92, 36, 43);

  S['compact-tractor'] =
    `<rect x="70" y="96" width="92" height="8" fill="${D}"/>` +
    `<path d="M58 102V83Q58 76 65 75L140 71V102Z" fill="${B}"/>` +
    `<path d="M58 81H63V99H58Z" fill="${D}" opacity=".6"/><path d="M66 78L136 74.5V77L66 80.5Z" ${shine}/>` +
    `<path d="M136 102V70H180V102Z" fill="${B}"/>` +
    `<rect x="164" y="46" width="7" height="24" rx="2" fill="${K}"/><rect x="148" y="64" width="23" height="6" rx="2" fill="${K}"/>` +
    `<path d="M138 72L146 58" stroke="${K}" stroke-width="3" stroke-linecap="round"/><ellipse cx="146" cy="57" rx="7" ry="2" fill="${K}"/>` +
    `<rect x="178" y="24" width="6" height="76" rx="2" fill="${K}"/><rect x="174" y="22" width="14" height="5" rx="2" fill="${K}"/>` +
    `<rect x="116" y="62" width="10" height="38" fill="${B}"/><rect x="116" y="62" width="10" height="38" fill="${D}" opacity=".25"/>` +
    `<path d="M120 90L88 79" stroke="${H}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M124 65L100 61L56 101" fill="none" stroke="${B}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M30 96Q27 110 33 122L60 121L58 97Z" fill="${M}"/><rect x="32" y="119" width="28" height="3" fill="${D}"/>` +
    wheel(82, 108, 16) + wheel(170, 99, 25) + fender(170, 100, 27, 32);

  S['utility-vehicle'] =
    `<rect x="52" y="97" width="150" height="9" fill="${D}"/>` +
    `<path d="M38 103V93Q38 83 50 81L104 78L110 103Z" fill="${B}"/><path d="M50 85L102 82.5V85L50 87.5Z" ${shine}/>` +
    `<rect x="39" y="87" width="6" height="4" rx="1" fill="#ffe7a1"/>` +
    `<path d="M104 103L110 78H150V103Z" fill="${B}"/><path d="M104 103L110 78H150V103Z" fill="${D}" opacity=".25"/>` +
    `<rect x="127" y="56" width="7" height="22" rx="2" fill="${K}"/><rect x="114" y="73" width="22" height="6" rx="2" fill="${K}"/>` +
    `<path d="M110 77L117 63" stroke="${K}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M104 80L117 32H158L151 77" fill="none" stroke="${K}" stroke-width="4.5" stroke-linejoin="round"/>` +
    `<rect x="111" y="27" width="53" height="6" rx="2" fill="${B}"/>` +
    `<path d="M146 76H214V103H146Z" fill="${B}"/><rect x="146" y="73" width="68" height="4" fill="${D}"/><rect x="150" y="82" width="60" height="3" ${shine}/>` +
    wheel(70, 108, 16) + wheel(180, 108, 16);

  S.excavator =
    track(48, 146, 24) +
    `<rect x="96" y="93" width="76" height="9" fill="${D}"/>` +
    `<path d="M132 74Q124 24 74 21" fill="none" stroke="${B}" stroke-width="13" stroke-linecap="round"/>` +
    `<path d="M124 70L104 38" stroke="${H}" stroke-width="3.5" stroke-linecap="round"/>` +
    `<path d="M74 21L42 88" stroke="${B}" stroke-width="9" stroke-linecap="round"/>` +
    `<path d="M86 24L62 58" stroke="${H}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M29 84L56 90L52 109Q43 119 31 113Q25 99 29 84Z" fill="${M}"/><path d="M31 113L27 117M37 116L34 120M44 116L42 120" stroke="${D}" stroke-width="2.5"/>` +
    `<path d="M82 96V74Q82 70 86 70H188Q202 70 202 84V96Z" fill="${B}"/>` +
    `<path d="M178 70H188Q202 70 202 84V96H178Z" fill="${D}" opacity=".3"/>` +
    `<rect x="150" y="76" width="22" height="2.5" fill="${D}" opacity=".45"/><rect x="150" y="81" width="22" height="2.5" fill="${D}" opacity=".45"/>` +
    `<path d="M84 72V38Q84 34 88 34H113L120 72Z" fill="${B}"/>` +
    `<path d="M89 40H109L115 69H89Z" fill="${G}"/><path d="M91 42H101L99 52H91Z" fill="#fff" opacity=".35"/>`;

  S['mini-excavator'] =
    track(66, 104, 18) +
    `<path d="M50 104H63V122Q57 124 50 122Z" fill="${M}"/><rect x="60" y="108" width="12" height="5" fill="${D}"/>` +
    `<rect x="92" y="99" width="62" height="8" fill="${D}"/>` +
    `<path d="M90 92Q84 46 62 40" fill="none" stroke="${B}" stroke-width="9" stroke-linecap="round"/>` +
    `<path d="M86 82L78 56" stroke="${H}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M62 40L40 94" stroke="${B}" stroke-width="6.5" stroke-linecap="round"/>` +
    `<path d="M28 88L50 94L46 111Q38 118 30 112Q24 100 28 88Z" fill="${M}"/>` +
    `<path d="M84 103V85Q84 80 89 80H160Q172 80 172 92V103Z" fill="${B}"/>` +
    `<path d="M160 80Q172 80 172 92V103H158V80Z" fill="${D}" opacity=".3"/>` +
    `<rect x="104" y="40" width="3.5" height="42" fill="${K}"/><rect x="147" y="40" width="3.5" height="42" fill="${K}"/>` +
    `<path d="M98 35H157Q160 35 160 38V43H98Z" fill="${B}"/>` +
    `<rect x="129" y="60" width="7" height="20" rx="2" fill="${K}"/><rect x="116" y="74" width="21" height="6" rx="2" fill="${K}"/><rect x="111" y="66" width="4" height="13" fill="${K}"/>`;

  const loaderBody = (wheels) =>
    (wheels ? '' : track(70, 112, 20)) +
    `<path d="M78 ${wheels ? 100 : 106}V70H174Q184 70 184 80V${wheels ? 100 : 106}Z" fill="${B}"/>` +
    `<rect x="166" y="78" width="14" height="18" rx="2" fill="${D}" opacity=".35"/>` +
    `<path d="M90 72V30Q90 26 94 26H136L144 72Z" fill="${D}"/>` +
    `<path d="M96 32H132L138 70H96Z" fill="${G}"/><path d="M98 34H112L110 46H98Z" fill="#fff" opacity=".35"/>` +
    `<path d="M108 32V70M120 32V70" stroke="${D}" stroke-opacity=".35" stroke-width="1.5"/>` +
    `<path d="M150 88L128 50" stroke="${H}" stroke-width="3.5" stroke-linecap="round"/>` +
    `<path d="M174 70L162 36L124 38L66 88" fill="none" stroke="${B}" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M32 80H68L70 118L32 122Q26 100 32 80Z" fill="${M}"/><rect x="30" y="118" width="40" height="4" fill="${D}"/>` +
    (wheels ? wheel(100, 106, 18) + wheel(160, 106, 18) : '');
  S['track-loader'] = loaderBody(false);
  S['skid-steer'] = loaderBody(true);

  S.backhoe =
    `<rect x="64" y="92" width="122" height="10" fill="${D}"/>` +
    `<path d="M58 100V80Q58 72 66 72L118 70V100Z" fill="${B}"/><path d="M58 78H63V98H58Z" fill="${D}" opacity=".6"/>` +
    `<path d="M66 75.5L116 73.5V76L66 78Z" ${shine}/>` +
    `<rect x="100" y="46" width="4" height="25" fill="${D}"/>` +
    `<path d="M114 100V66H186V100Z" fill="${B}"/>` +
    `<path d="M122 30H176L180 66H120Z" fill="${G}"/><path d="M126 33H144L142 44H125Z" fill="#fff" opacity=".35"/>` +
    `<rect x="118" y="28" width="5" height="40" fill="${B}"/><rect x="176" y="28" width="5" height="40" fill="${B}"/>` +
    `<path d="M112 22H186Q189 22 189 25V30H112Z" fill="${B}"/>` +
    `<path d="M120 74L94 70L46 98" fill="none" stroke="${B}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M18 90Q15 106 21 120L50 119L48 92Z" fill="${M}"/><rect x="20" y="117" width="30" height="3" fill="${D}"/>` +
    `<path d="M186 92L194 121H206L198 92Z" fill="${D}"/>` +
    `<path d="M186 84Q202 34 220 30" fill="none" stroke="${B}" stroke-width="8" stroke-linecap="round"/>` +
    `<path d="M196 70L210 40" stroke="${H}" stroke-width="2.5" stroke-linecap="round"/>` +
    `<path d="M220 30L226 92" stroke="${B}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M216 88L234 91Q237 105 229 113L215 106Z" fill="${M}"/>` +
    wheel(80, 107, 17) + wheel(156, 97, 27) + fender(156, 98, 29, 34);

  S['wheel-loader'] =
    `<path d="M58 98V78H120V98Z" fill="${B}"/><rect x="110" y="82" width="12" height="14" fill="${D}"/>` +
    `<path d="M114 100V64H204Q212 64 212 74V100Z" fill="${B}"/>` +
    `<path d="M200 64Q212 64 212 74V100H200Z" fill="${D}" opacity=".3"/>` +
    `<rect x="186" y="70" width="10" height="22" rx="2" fill="${D}" opacity=".35"/>` +
    `<rect x="176" y="46" width="5" height="19" fill="${D}"/>` +
    `<path d="M116 66V26Q116 22 120 22H156L162 66Z" fill="${B}"/>` +
    `<path d="M121 28H153L158 64H121Z" fill="${G}"/><path d="M123 30H137L135 42H123Z" fill="#fff" opacity=".35"/>` +
    `<path d="M112 56L62 74" stroke="${D}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="M120 72L50 84" stroke="${B}" stroke-width="10" stroke-linecap="round"/>` +
    `<path d="M10 64Q3 92 14 120L54 118L52 70Q30 61 10 64Z" fill="${M}"/><rect x="12" y="117" width="42" height="4" fill="${D}"/>` +
    wheel(78, 98, 26) + wheel(168, 98, 26) + fender(78, 99, 28, 33) + fender(168, 99, 28, 33);

  S.telehandler =
    `<path d="M100 47L33 29" stroke="${M}" stroke-width="9" stroke-linecap="round"/>` +
    `<path d="M204 79L72 41" stroke="${B}" stroke-width="15" stroke-linecap="round"/>` +
    `<path d="M150 86L122 58" stroke="${H}" stroke-width="4" stroke-linecap="round"/>` +
    `<rect x="22" y="26" width="8" height="42" rx="1" fill="${D}"/><rect x="4" y="64" width="26" height="4" fill="${D}"/>` +
    `<path d="M42 104V90Q42 86 46 86H200Q206 86 206 92V104Z" fill="${B}"/><rect x="46" y="90" width="156" height="3" ${shine}/>` +
    `<path d="M86 88V46Q86 42 90 42H116L122 88Z" fill="${B}"/>` +
    `<path d="M91 48H113L118 86H91Z" fill="${G}"/><path d="M93 50H104L102 62H93Z" fill="#fff" opacity=".35"/>` +
    wheel(66, 105, 19) + wheel(176, 105, 19);

  S['boom-lift'] =
    `<path d="M70 36L46 14" stroke="${M}" stroke-width="7" stroke-linecap="round"/>` +
    `<path d="M46 16L44 26" stroke="${D}" stroke-width="4"/>` +
    `<rect x="12" y="26" width="40" height="4" fill="${D}"/>` +
    `<path d="M14 26V10H50V26M14 18H50M32 10V26" fill="none" stroke="${K}" stroke-width="2.2"/>` +
    `<rect x="14" y="20" width="36" height="6" fill="${B}" opacity=".85"/>` +
    `<path d="M114 76L70 36" stroke="${B}" stroke-width="10" stroke-linecap="round"/>` +
    `<path d="M128 80L100 60" stroke="${H}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M100 95V77Q100 72 105 72H170Q177 72 177 79V95Z" fill="${B}"/>` +
    `<path d="M156 72H170Q177 72 177 79V95H156Z" fill="${D}" opacity=".3"/>` +
    `<circle cx="114" cy="76" r="6" fill="${D}"/>` +
    `<rect x="54" y="94" width="132" height="16" rx="3" fill="${B}"/><rect x="54" y="106" width="132" height="4" fill="${D}" opacity=".35"/>` +
    wheel(78, 110, 14) + wheel(162, 110, 14);

  S['compact-utility'] =
    track(72, 84, 16) +
    `<path d="M80 110V79Q80 74 85 74H150Q156 74 156 80V110Z" fill="${B}"/>` +
    `<rect x="88" y="82" width="22" height="14" rx="2" fill="${D}" opacity=".3"/>` +
    `<rect x="154" y="104" width="27" height="6" rx="1" fill="${D}"/>` +
    `<path d="M146 76V49Q146 45 150 45H160V76Z" fill="${D}"/>` +
    `<path d="M151 46L168 40" stroke="${K}" stroke-width="3.5" stroke-linecap="round"/>` +
    `<path d="M130 90L110 62" stroke="${H}" stroke-width="3" stroke-linecap="round"/>` +
    `<path d="M150 60L112 52L66 88" fill="none" stroke="${B}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M36 88H68V118L36 121Q31 104 36 88Z" fill="${M}"/><rect x="34" y="118" width="34" height="3" fill="${D}"/>`;

  let out = `<symbol id="gnd" viewBox="0 0 240 140">${c.scene}<rect y="124" width="240" height="16" fill="${c.ground}"/><rect y="124" width="240" height="1.6" fill="${c.groundLine}"/><ellipse cx="120" cy="124.5" rx="98" ry="4.5" fill="#000" opacity=".16"/></symbol>`;
  for (const [k, v] of Object.entries(S)) out += `<symbol id="eq-${k}" viewBox="0 0 240 140">${v}</symbol>`;
  return out;
}

// -------------------------------------------------------------- themes ----

const NAV = ['Home', 'New Equipment', 'Used', 'Parts', 'Service', 'Financing', 'Contact'];

const THEMES = {
  'valley-ag': {
    stock: 'VA',
    art: {
      body: '#2f7a2c', trim: '#f2c418', dark: '#1d4a1b', glass: '#cfe6ee', metal: '#5f676e',
      ground: '#b9cf98', groundLine: '#8fae6a',
      scene: '<path d="M0 124V108Q50 92 104 104T206 98Q226 96 240 100V124Z" fill="#cfe2b4" opacity=".75"/><path d="M0 124V114Q70 104 140 114T240 110V124Z" fill="#c2d9a3"/>',
    },
    logo: '<svg viewBox="0 0 64 64" width="66" height="66" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#2f6b2a" stroke="#f3c316" stroke-width="3"/><circle cx="32" cy="34" r="11" fill="#f3c316"/><path d="M5 36H59V42Q32 34 5 42Z" fill="#2f6b2a"/><path d="M5 40Q32 32 59 40V48Q32 40 5 48Z" fill="#8cc152"/><path d="M8 48Q32 40 56 48L52 54Q32 47 12 54Z" fill="#6ea83c"/><path d="M14 56Q32 50 50 56L44 60Q32 56 20 60Z" fill="#8cc152"/></svg>',
    promo: '&#9733; <b>0% financing for 48 months</b> on select new compact &amp; utility tractors. Ask about our fall harvest specials! &#9733;',
    intro: 'Browse our current new and used inventory below. All new units come with full factory warranty and PDI by our certified techs. Don\'t see what you need? Give us a call &mdash; we can locate it.',
    footerExtra: 'Authorized dealer for John Deere, Kubota, New Holland, Case IH, Massey Ferguson &amp; Mahindra. Prices plus tax, freight &amp; setup. Subject to prior sale.',
    css: `
body{background:#e9e4d2;font:13px/1.5 Verdana,"DejaVu Sans",Geneva,sans-serif;color:#2b2b2b}
.topbar{background:#1d4a1b;color:#d8e6cf;font-size:12px}
.topbar a{color:#f3c316}
.masthead{background:#fffdf5;border-bottom:4px solid #f3c316}
.brand{font:bold 31px/1.05 Georgia,"Bitstream Charter","DejaVu Serif",serif;color:#2f6b2a}
.tagline{font:italic 14px Georgia,"Bitstream Charter",serif;color:#6d6a44}
.contact{text-align:right;font-size:12px;color:#555}
.contact .phone{display:inline-block;background:#2f6b2a;color:#fff;font:bold 20px Georgia,"Bitstream Charter",serif;padding:7px 14px;border:2px solid #f3c316;border-radius:4px;margin-bottom:4px}
.mainnav{background:linear-gradient(#3f8d37,#2a6125);border-bottom:1px solid #173d14}
.mainnav a{color:#fff;font-weight:bold;font-size:13px;padding:11px 18px;border-right:1px solid rgba(255,255,255,.18);text-shadow:0 1px 0 rgba(0,0,0,.35)}
.mainnav a:hover{background:#245520}
.mainnav a.active{background:#f3c316;color:#1d4a1b;text-shadow:none}
.promo{background:#fff4bf;border-bottom:1px solid #e3cf6e;color:#5a4a00;font-size:13px}
main{background:#fff;border-left:1px solid #d8d0b4;border-right:1px solid #d8d0b4}
.crumbs{color:#7a7a6a}.crumbs a{color:#2f6b2a}
h1{font:bold 26px Georgia,"Bitstream Charter",serif;color:#1d4a1b;border-bottom:2px solid #e5dfc9;padding-bottom:8px}
.filters{background:#f4f1e3;border:1px solid #ddd4b2}
.filters select,.filters input{border:1px solid #b9b39a;border-radius:0}
.filters button{background:#2f6b2a;color:#fff;border:1px solid #1d4a1b;border-radius:0}
.resultbar{color:#666}
.unit{border:1px solid #cfc7a8;box-shadow:0 2px 3px rgba(0,0,0,.08)}
.ph{background:linear-gradient(#f6faef,#e3eed6);border-bottom:3px solid #f3c316}
.title{font:bold 16px/1.25 Georgia,"Bitstream Charter",serif;color:#1d4a1b}
.cat{color:#8a7d2c}
.specs li{border-bottom:1px dotted #cfcab4}
.price{font:bold 22px Georgia,"Bitstream Charter",serif;color:#2f6b2a}
.btn{background:#f3c316;color:#1d4a1b;border:1px solid #c9a20f}
.btn.alt{background:#fff;color:#2f6b2a;border:1px solid #2f6b2a}
.tag{background:#2f6b2a;color:#fff}
.finance-note{color:#2f6b2a}
.cta{background:#2f6b2a;color:#fff;border:3px double #f3c316}
.cta b{color:#f3c316}
footer{background:#1d4a1b;color:#cfdcc6;border-top:5px solid #f3c316}
footer h4{color:#f3c316;font-family:Georgia,"Bitstream Charter",serif}
`,
  },
  ironline: {
    stock: 'IL-',
    art: {
      body: '#f07a1a', trim: '#3a3d40', dark: '#2a2c2e', glass: '#c9dbe4', metal: '#5b6167',
      ground: '#c8b79a', groundLine: '#a8936f',
      scene: '<path d="M0 124V104L34 84L58 98L96 70L128 94L160 80L196 100L222 90L240 98V124Z" fill="#d9d2c6" opacity=".9"/><path d="M0 124V114L60 106L120 113L180 104L240 112V124Z" fill="#d6c8ae"/>',
    },
    logo: '<svg viewBox="0 0 64 64" width="62" height="62" aria-hidden="true"><path d="M32 2L59 17.5V46.5L32 62L5 46.5V17.5Z" fill="#f47b20"/><path d="M32 7L54.5 20V44L32 57L9.5 44V20Z" fill="none" stroke="#1d1d1d" stroke-width="2"/><path d="M19 17H45V25H36.5V39H45V47H19V39H27.5V25H19Z" fill="#1d1d1d"/></svg>',
    promo: '<b>FINANCING AVAILABLE O.A.C.</b> &nbsp;|&nbsp; TRADES WELCOME &nbsp;|&nbsp; WE BUY USED IRON &nbsp;|&nbsp; DELIVERY ACROSS NORTHERN NEVADA',
    intro: 'New and used construction equipment in stock and ready to work. Every used machine goes through our 120-point shop inspection. Call our sales desk for availability, freight and attachment packages.',
    footerExtra: 'All prices USD, FOB Sparks NV. Prices, specifications and availability subject to change without notice. Equipment subject to prior sale.',
    sidebar: `<aside class="side">
  <div class="box"><h3>Why Ironline?</h3><ul><li>Family owned since 1994</li><li>Factory-trained technicians</li><li>Field service trucks</li><li>Parts counter open 6 days</li></ul></div>
  <div class="box dark"><h3>Need Financing?</h3><p>Competitive rates for contractors. Fast credit decisions, 0 down O.A.C.</p><a class="btn" href="#">Apply Online</a></div>
  <div class="box"><h3>Sell Your Iron</h3><p>We pay cash for clean late-model excavators, loaders and backhoes.</p><a class="btn alt" href="#">Get an Offer</a></div>
</aside>`,
    css: `
body{background:#d7d8d9;font:14px/1.45 Arial,"Liberation Sans",Helvetica,sans-serif;color:#222}
.hazard{height:9px;background:repeating-linear-gradient(-45deg,#f47b20 0 14px,#1d1d1d 14px 28px)}
.topbar{background:#1d1d1d;color:#aaa;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.topbar a{color:#f47b20}
.masthead{background:linear-gradient(#35383b,#222426);color:#ccc}
.brand{font:900 32px/1 "Arial Black",Impact,"Liberation Sans",Arial,sans-serif;color:#fff;text-transform:uppercase;letter-spacing:.5px}
.tagline{color:#f47b20;text-transform:uppercase;letter-spacing:2.5px;font-size:12px;font-weight:bold;margin-top:4px}
.contact{text-align:right;font-size:12px;color:#bbb;text-transform:uppercase}
.contact .phone{display:block;color:#f47b20;font:900 26px "Arial Black","Liberation Sans",Arial,sans-serif;letter-spacing:.5px}
.mainnav{background:#f47b20;border-top:1px solid #ff9d55;border-bottom:3px solid #b5570f}
.mainnav a{color:#fff;font-weight:bold;text-transform:uppercase;letter-spacing:.6px;padding:12px 19px;font-size:13px;border-right:1px solid #d76510}
.mainnav a:hover{background:#d96812}
.mainnav a.active{background:#1d1d1d}
.promo{background:#2b2d2f;color:#f0f0f0;font-size:12px;letter-spacing:.6px}
main{background:#f2f2f2}
.crumbs{color:#777;text-transform:uppercase;font-size:11px}.crumbs a{color:#b5570f}
h1{font:900 26px "Arial Black","Liberation Sans",Arial,sans-serif;text-transform:uppercase;color:#1d1d1d;border-left:8px solid #f47b20;padding-left:12px}
.filters{background:#2b2d2f;color:#ddd;border:0}
.filters label{color:#ccc}
.filters select,.filters input{border:1px solid #555;border-radius:0;background:#fff}
.filters button{background:#f47b20;color:#fff;border:0;border-radius:0;text-transform:uppercase}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:22px;align-items:start}
.side .box{background:#fff;border:1px solid #c4c4c4;border-top:4px solid #f47b20;padding:12px 14px;margin-bottom:16px;font-size:13px}
.side .box.dark{background:#2b2d2f;color:#ddd;border-color:#2b2d2f;border-top-color:#f47b20}
.side h3{margin:0 0 8px;font:900 15px "Arial Black","Liberation Sans",Arial,sans-serif;text-transform:uppercase}
.side ul{margin:0;padding-left:18px}
.side p{margin:0 0 10px}
.unit{border:1px solid #bdbdbd;border-top:4px solid #f47b20}
.ph{background:linear-gradient(#f4f1ec,#e3ddd2);border-bottom:1px solid #ccc}
.title{font:bold 16px/1.25 Arial,"Liberation Sans",sans-serif;text-transform:uppercase;color:#1d1d1d}
.cat{color:#b5570f;font-weight:bold}
.specs li{border-bottom:1px solid #e3e3e3}
.price{font:900 23px "Arial Black","Liberation Sans",Arial,sans-serif;color:#1d1d1d}
.btn{background:#f47b20;color:#fff;border:0;text-transform:uppercase;font-weight:bold}
.btn.alt{background:#2b2d2f;color:#fff}
.tag{background:#1d1d1d;color:#f47b20}
.finance-note{color:#b5570f}
.cta{background:#1d1d1d;color:#eee;border-left:8px solid #f47b20}
.cta b{color:#f47b20}
footer{background:#1d1d1d;color:#aaa;border-top:6px solid #f47b20}
footer h4{color:#f47b20;text-transform:uppercase;letter-spacing:1px}
@media (max-width:900px){.layout{grid-template-columns:1fr}}
`,
  },
  bayshore: {
    stock: 'BSM',
    art: {
      body: '#13979a', trim: '#0d2f52', dark: '#0b2440', glass: '#d6eef4', metal: '#5c6670',
      ground: '#c9d6cf', groundLine: '#9db3a8',
      scene: '<path d="M0 124V112Q30 104 60 112T120 110T180 108T240 110V124Z" fill="#bfe1e3" opacity=".85"/><path d="M0 108Q40 92 86 102Q120 88 160 98Q200 86 240 96V112Q180 104 120 110Q60 104 0 114Z" fill="#d7e9ea"/>',
    },
    logo: '<svg viewBox="0 0 64 64" width="62" height="62" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#18a7a0"/><circle cx="32" cy="32" r="26" fill="none" stroke="#fff" stroke-width="1.5" opacity=".6"/><path d="M19 15H33Q43 15 43 23Q43 28 38 30Q45 32 45 39Q45 47 35 47H19Z" fill="#0b2a4a"/><path d="M25 21V28H32Q36 28 36 24.5Q36 21 32 21ZM25 33V41H33Q38 41 38 37Q38 33 33 33Z" fill="#18a7a0"/><path d="M8 47Q16 42 24 47T40 47T56 47V52Q48 47 40 52T24 52T8 52Z" fill="#fff"/></svg>',
    promo: 'Rent it. Buy it. Rent-to-own on select units &mdash; <b>Delivery throughout the Delta &amp; Bay Area.</b>',
    intro: 'Compact equipment, telehandlers and aerial lifts for contractors, landscapers and rental customers. Ask about rental rates, rent-to-own and certified ex-rental fleet units.',
    footerExtra: 'Prices exclude tax, delivery and doc fees. Rental fleet units sold as-is with inspection report. Bayshore Machinery is an independent dealer.',
    css: `
body{background:#e6eef2;font:14px/1.5 "Trebuchet MS",Carlito,Tahoma,"DejaVu Sans",sans-serif;color:#1d2b38}
.topbar{background:#08203a;color:#9fc3d6;font-size:12px}
.topbar a{color:#5fd6cd}
.masthead{background:linear-gradient(120deg,#0b2a4a 0%,#123f6a 70%,#16507a 100%);color:#cfe3ef;position:relative}
.masthead:after{content:"";display:block;height:14px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 14'%3E%3Cpath d='M0 7Q15 0 30 7T60 7T90 7T120 7V14H0Z' fill='%2318a7a0'/%3E%3C/svg%3E") repeat-x;background-size:120px 14px}
.brand{font:bold 32px/1.05 "Trebuchet MS",Carlito,sans-serif;color:#fff;letter-spacing:.3px}
.tagline{color:#6fd8cf;font-size:14px}
.contact{text-align:right;font-size:12px;color:#a9c7d8}
.contact .phone{display:inline-block;background:#18a7a0;color:#fff;font:bold 19px "Trebuchet MS",Carlito,sans-serif;padding:6px 16px;border-radius:20px;margin-bottom:4px;box-shadow:0 2px 0 #0e7c77}
.mainnav{background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.12)}
.mainnav a{color:#0b2a4a;font-weight:bold;font-size:14px;padding:13px 17px;border-bottom:3px solid transparent}
.mainnav a:hover{color:#18a7a0}
.mainnav a.active{color:#13979a;border-bottom-color:#18a7a0}
.promo{background:#d6f1ef;color:#0b4a4a;font-size:13px;border-bottom:1px solid #b5e2de}
main{background:transparent}
.crumbs{color:#6a7f8d}.crumbs a{color:#13979a}
h1{font:bold 28px "Trebuchet MS",Carlito,sans-serif;color:#0b2a4a}
.filters{background:#fff;border:1px solid #cddbe3;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.filters select,.filters input{border:1px solid #b9cbd6;border-radius:6px}
.filters button{background:#0b2a4a;color:#fff;border:0;border-radius:6px}
.unit{border:0;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(11,42,74,.14)}
.ph{background:linear-gradient(#eef9fa,#d3eaee)}
.title{font:bold 17px/1.25 "Trebuchet MS",Carlito,sans-serif;color:#0b2a4a}
.cat{color:#13979a;font-weight:bold}
.specs li{border-bottom:1px solid #e4edf1}
.price{font:bold 23px "Trebuchet MS",Carlito,sans-serif;color:#0b2a4a}
.btn{background:#18a7a0;color:#fff;border:0;border-radius:16px}
.btn.alt{background:#fff;color:#0b2a4a;border:1px solid #0b2a4a}
.tag{background:#0b2a4a;color:#fff;border-radius:3px}
.finance-note{color:#13979a}
.cta{background:#0b2a4a;color:#dcebf3;border-radius:10px}
.cta b{color:#5fd6cd}
footer{background:#0b2a4a;color:#a9c3d3}
footer h4{color:#5fd6cd}
`,
  },
};

const BASE_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0}
a{color:inherit}
.wrap{max-width:1220px;margin:0 auto;padding:0 16px}
.topbar .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 16px;padding-top:6px;padding-bottom:6px}
.masthead .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;padding-top:16px;padding-bottom:16px}
.logo{display:flex;align-items:center;gap:14px;text-decoration:none;min-width:0}
.logo svg{flex:none;display:block}
.brandtext{display:flex;flex-direction:column;min-width:0}
.mainnav ul{list-style:none;margin:0 auto;padding:0 16px;display:flex;flex-wrap:wrap;max-width:1220px}
.mainnav a{display:block;text-decoration:none}
.promo{text-align:center;padding:8px 16px}
main.wrap{padding-top:14px;padding-bottom:30px}
.crumbs{font-size:12px;margin-bottom:6px}
h1{margin:4px 0 8px}
.intro{margin:0 0 14px;max-width:820px}
.filters{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;padding:11px 13px;margin:0 0 12px}
.filters label{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.4px}
.filters select,.filters input{font:inherit;font-size:13px;padding:6px 7px;min-width:170px;max-width:100%;color:#222}
.filters .grow{flex:1 1 200px}.filters .grow input{width:100%}
.filters button{font:inherit;font-size:13px;font-weight:bold;padding:7px 18px;cursor:pointer}
.resultbar{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;font-size:12px;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px}
.unit{position:relative;background:#fff;display:flex;flex-direction:column;min-width:0}
.ph{position:relative;aspect-ratio:12/7;overflow:hidden}
.ph svg.eq{display:block;width:100%;height:100%}
.unit[data-status="SOLD"] .ph svg.eq{filter:grayscale(.75) opacity(.7)}
.tag{position:absolute;top:8px;right:8px;font-size:11px;font-weight:bold;padding:2px 7px;letter-spacing:.3px}
.stock{position:absolute;left:8px;bottom:6px;font-size:10px;color:rgba(0,0,0,.45)}
.sold-ribbon{position:absolute;left:-25%;right:-25%;top:50%;transform:translateY(-50%) rotate(-17deg);background:#d0191f;color:#fff;text-align:center;font:900 40px/1.35 Impact,"Arial Black","Liberation Sans",Arial,sans-serif;letter-spacing:10px;text-indent:10px;border-top:3px solid #fff;border-bottom:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,.35);text-shadow:0 2px 0 rgba(0,0,0,.25)}
.pending-badge{position:absolute;top:10px;left:10px;background:#f5a300;color:#231a00;font:900 13px/1 Arial,"Liberation Sans",sans-serif;letter-spacing:.8px;padding:7px 10px;border:2px solid #fff;border-radius:3px;box-shadow:0 2px 6px rgba(0,0,0,.3)}
.info{padding:11px 13px 13px;display:flex;flex-direction:column;flex:1}
.title{margin:0 0 3px}
.cat{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px}
.specs{list-style:none;margin:0 0 10px;padding:0;font-size:12.5px}
.specs li{padding:3px 0;overflow-wrap:anywhere}
.serial{font-family:"Courier New","Liberation Mono","DejaVu Sans Mono",monospace;font-size:12.5px;font-weight:bold;color:#111;background:#f1f1ec;padding:0 4px;border-radius:2px;letter-spacing:.2px}
.pricebox{margin-top:auto}
.price{margin:2px 0 2px}
.price.sold{color:#d0191f;letter-spacing:1px}
.pending-note{font-size:12px;font-weight:bold;color:#a86b00;margin-bottom:2px}
.finance-note{font-size:11.5px;margin-bottom:9px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-block;font-size:12px;padding:6px 12px;text-decoration:none;cursor:pointer}
.cta{margin-top:26px;padding:16px 20px;font-size:14px}
footer{font-size:12.5px;padding:24px 0 14px}
footer .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px 28px}
footer h4{margin:0 0 8px;font-size:14px}
footer p{margin:0 0 6px}
footer .legal{margin-top:18px;padding-top:12px;border-top:1px solid rgba(255,255,255,.15);font-size:11.5px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px}
@media (max-width:640px){.contact{text-align:left!important}.mainnav a{padding:9px 11px!important;font-size:12px!important}.brand{font-size:24px!important}h1{font-size:21px!important}.filters select,.filters input{min-width:0;width:100%}.filters label{flex:1 1 100%}}
`;

// ------------------------------------------------------------- render -----

function renderCard(u, theme) {
  const status = u.status;
  const priceAttr = status === 'SOLD' ? '' : String(u.price);
  const name = `${u.year} ${u.make} ${u.model}`;
  const stock = `${theme.stock}${(hash('stock:' + u.serial) % 9000) + 1000}`;
  const overlay =
    status === 'SOLD'
      ? `<div class="sold-ribbon" aria-label="Sold">SOLD</div>`
      : status === 'SALE_PENDING'
        ? `<span class="pending-badge">SALE PENDING</span>`
        : '';
  let priceHtml;
  if (status === 'SOLD') {
    priceHtml = `<div class="price sold">${esc(u.sold_label || 'SOLD')}</div><div class="finance-note">This unit has been sold. Call us for similar units.</div>`;
  } else {
    priceHtml =
      (status === 'SALE_PENDING' ? `<div class="pending-note">Sale pending &mdash; backup offers welcome</div>` : '') +
      `<div class="price">${money(u.price)}</div>` +
      `<div class="finance-note">${u.condition === 'New' ? 'Financing available O.A.C.' : 'Call for quote &amp; trade-in value'}</div>`;
  }
  return `<article class="unit" id="unit-${esc(u.serial)}" data-serial="${esc(u.serial)}" data-status="${status}" data-year="${u.year}" data-make="${esc(u.make)}" data-model="${esc(u.model)}" data-price="${priceAttr}">
<div class="ph"><svg class="eq" viewBox="0 0 240 140" role="img" aria-label="${esc(name)}"><use href="#gnd"/><use href="#eq-${esc(u.category)}"/></svg><span class="tag">${esc(u.condition)}</span><span class="stock">Stock #${stock}</span>${overlay}</div>
<div class="info"><h3 class="title">${esc(name)}</h3><div class="cat">${esc(catLabel(u.category))}</div>
<ul class="specs"><li>Serial/PIN: <span class="serial">${esc(u.serial)}</span></li><li>Hours: ${u.hours}</li><li>Condition: ${esc(u.condition)}</li></ul>
<div class="pricebox">${priceHtml}<div class="actions"><a class="btn" href="#">Call for Quote</a><a class="btn alt" href="#">Details</a></div></div></div>
</article>`;
}

function renderPage(dealer, site, listings) {
  const theme = THEMES[dealer.id];
  if (!theme) throw new Error(`No theme for dealer ${dealer.id}`);
  const n = listings.length;
  const cats = [...new Set(listings.map((u) => u.category))].sort();
  const makes = [...new Set(listings.map((u) => u.make))].sort();
  const brand = esc(site.brand);
  const navHtml = NAV.map((l) => `<li><a href="#"${l === 'New Equipment' ? ' class="active"' : ''}>${l}</a></li>`).join('');
  const cards = listings.map((u) => renderCard(u, theme)).join('\n');
  const filters = `<form class="filters" action="#" method="get">
<label>Category<select name="category"><option>All Categories</option>${cats.map((c) => `<option>${esc(catLabel(c))}</option>`).join('')}</select></label>
<label>Make<select name="make"><option>All Makes</option>${makes.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
<label>Condition<select name="condition"><option>Any</option><option>New</option><option>Used</option></select></label>
<label class="grow">Search<input type="search" name="q" placeholder="Keyword, model or stock #"></label>
<button type="button">Search</button>
</form>`;
  const gridBlock = `<div class="resultbar"><span>${n} units found</span><span>Sort by: <b>Featured</b></span></div>
<section class="grid" aria-label="Inventory">
${cards}
</section>`;
  const content = theme.sidebar ? `<div class="layout"><div>${gridBlock}</div>${theme.sidebar}</div>` : gridBlock;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brand} | Equipment Inventory</title>
<meta name="description" content="${brand} - ${esc(site.tagline)}. New and used equipment inventory.">
<style>${BASE_CSS}${theme.css}</style>
</head>
<body class="dealer-${dealer.id}">
<svg width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${equipmentSymbols(theme.art)}</svg>
${theme.css.includes('.hazard') ? '<div class="hazard"></div>' : ''}
<div class="topbar"><div class="wrap"><span>${esc(site.address)}</span><span>Hours: ${esc(site.hours)} &nbsp;|&nbsp; Call <a href="#">${esc(site.phone)}</a></span></div></div>
<header class="masthead"><div class="wrap">
<a class="logo" href="#">${theme.logo}<span class="brandtext"><span class="brand">${brand}</span><span class="tagline">${esc(site.tagline)}</span></span></a>
<div class="contact"><span class="phone">${esc(site.phone)}</span><br>${esc(site.address)}<br>${esc(site.hours)}</div>
</div></header>
<nav class="mainnav"><ul>${navHtml}</ul></nav>
<div class="promo">${theme.promo}</div>
<main class="wrap">
<div class="crumbs"><a href="#">Home</a> &rsaquo; <a href="#">Inventory</a> &rsaquo; All Equipment</div>
<h1>Equipment Inventory (${n} units)</h1>
<p class="intro">${theme.intro}</p>
${filters}
${content}
<div class="cta"><b>Financing available.</b> Flexible terms for farms, contractors and small businesses &mdash; call ${esc(site.phone)} or stop by ${esc(site.address)}.</div>
</main>
<footer><div class="wrap">
<div class="cols">
<div><h4>${brand}</h4><p>${esc(site.address)}</p><p>Phone: ${esc(site.phone)}</p></div>
<div><h4>Store Hours</h4><p>${esc(site.hours)}</p><p>Closed Sundays &amp; major holidays</p></div>
<div><h4>Departments</h4><p>Sales &middot; Parts &middot; Service &middot; Financing</p><p>${theme.footerExtra}</p></div>
</div>
<div class="legal"><span>&copy; 2026 ${brand}. All rights reserved.</span><span>${esc(site.address)}</span></div>
</div></footer>
</body>
</html>
`;
}

// --------------------------------------------------------------- main -----

export function loadFixtures(root = ROOT) {
  const portfolio = JSON.parse(readFileSync(path.join(root, 'fixtures/portfolio.json'), 'utf8'));
  const sites = JSON.parse(readFileSync(path.join(root, 'fixtures/dealer-sites.json'), 'utf8'));
  return { portfolio, sites };
}

function main() {
  const { portfolio, sites } = loadFixtures();
  const listings = buildListings(portfolio, sites);
  for (const dealer of portfolio.dealers) {
    const rows = listings[dealer.id];
    if (!rows) continue;
    const html = renderPage(dealer, sites[dealer.id], rows);
    const dir = path.join(ROOT, 'public/dealers', dealer.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), html);
    const by = (s) => rows.filter((r) => r.status === s).length;
    console.log(
      `${dealer.id}: ${rows.length} listed (${rows.filter((r) => r.financed).length} ledger, ${rows.filter((r) => !r.financed).length} extras; ` +
        `SOLD ${by('SOLD')}, SALE_PENDING ${by('SALE_PENDING')}) -> public/dealers/${dealer.id}/index.html (${(html.length / 1024).toFixed(1)} KB)`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
