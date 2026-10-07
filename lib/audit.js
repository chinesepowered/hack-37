// Audit runs: dispatch the agent (live on Agent37, or a recorded replay), then read its listings,
// match them against the ledger, value the collateral, and stream every step to the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { portfolio, dealerById, normSerial, groundTruthListings, dealerUrl, root } from './data.js';
import { LISTINGS_SCHEMA } from './openai.js';
import { valueUnits, valueUnit } from './valuation.js';
import { saveRun } from './store.js';

const runs = new Map();
let counter = 1000 + (Math.floor(Date.now() / 1000) % 8000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const DATA_DIR = path.join(root, '.data', 'runs');

export const getRun = (id) => runs.get(id);
export const activeRun = () => [...runs.values()].find((r) => r.state === 'running');

function emit(run, type, data = {}) {
  const ev = { seq: run.events.length, t: Date.now() - run.t0, type, data };
  run.events.push(ev);
  const frame = `id: ${ev.seq}\nevent: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.subs) res.write(frame);
}

export function subscribe(run, res, fromSeq = 0) {
  for (const ev of run.events.slice(fromSeq)) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  if (run.state !== 'running') return res.end();
  run.subs.add(res);
  res.on('close', () => run.subs.delete(res));
}

function finishSubs(run) {
  for (const res of run.subs) res.end();
  run.subs.clear();
}

export function startRun(mode, ctx) {
  const id = `A-${++counter}`;
  const run = { id, mode, t0: Date.now(), state: 'running', events: [], subs: new Set(), agent: {}, result: null };
  runs.set(id, run);
  (async () => {
    try {
      const agentResult = mode === 'live' ? await runLive(run, ctx) : await runReplay(run, ctx);
      await finishPipeline(run, ctx, agentResult);
      run.state = 'complete';
      emit(run, 'run.completed', { summary: run.result.summary });
      await saveRun(run);
    } catch (e) {
      console.error('[run] failed', e);
      run.state = 'failed';
      emit(run, 'run.failed', { error: e.message });
    } finally {
      finishSubs(run);
    }
  })();
  return run;
}

/* ---------------- agent event translation (shared by live + replay) ---------------- */

function dealerFromText(text) {
  for (const d of portfolio.dealers) if (text.includes(`/${d.id}/`) || text.includes(`/${d.id}`)) return d.id;
  return null;
}

function translate(run, name, data) {
  const st = run._agentState || (run._agentState = { tools: 0, visiting: null, done: new Set() });
  switch (name) {
    case 'response.created':
      run.agent.response_id = data.id;
      run.agent.session_id = data.session_id;
      emit(run, 'agent.created', { response_id: data.id, session_id: data.session_id });
      break;
    case 'response.reasoning.delta':
      emit(run, 'agent.reasoning', { text: data.text || '' });
      break;
    case 'response.output_text.delta':
      emit(run, 'agent.text', { text: data.text || '' });
      break;
    case 'response.tool_call.generating':
      emit(run, 'agent.tool', { phase: 'generating', tool: data.tool });
      break;
    case 'response.tool_call.started': {
      st.tools++;
      const text = `${data.label || ''} ${JSON.stringify(data.arguments || {})}`;
      const dealer = dealerFromText(text);
      if (dealer && dealer !== st.visiting) {
        if (st.visiting) {
          st.done.add(st.visiting);
          emit(run, 'dealer.status', { dealer_id: st.visiting, state: 'read' });
        }
        st.visiting = dealer;
        emit(run, 'dealer.status', { dealer_id: dealer, state: 'visiting' });
      }
      emit(run, 'agent.tool', { phase: 'started', tool: data.tool, label: data.label || '', args: data.arguments || null, dealer_id: dealer });
      break;
    }
    case 'response.tool_call.completed':
      emit(run, 'agent.tool', { phase: 'completed', tool: data.tool, duration_ms: data.duration_ms ?? null });
      break;
    case 'response.tool_call.failed':
      emit(run, 'agent.tool', { phase: 'failed', tool: data.tool, error: String(data.error || '').slice(0, 200) });
      break;
    case 'response.completed':
      if (st.visiting) emit(run, 'dealer.status', { dealer_id: st.visiting, state: 'read' });
      emit(run, 'agent.completed', { usage: data.usage || null, tool_calls: st.tools });
      break;
    case 'response.failed':
      emit(run, 'agent.failed', { error: data.error || data });
      break;
  }
}

/* ---------------- live: Agent37 ---------------- */

function auditPrompt(run, urls) {
  const lines = portfolio.dealers.map((d, i) => `${i + 1}. ${d.id} | ${d.name} (${d.city}) | ${urls[d.id]}`).join('\n');
  return `You are FloorCheck, the field auditor for ${portfolio.lender.name}, a floor-plan lender that finances dealers' equipment inventory. This is audit run ${run.id}.

Each dealer below publishes its whole inventory on one web page. Visit every page with your browser: browser_navigate to it, then browser_snapshot (and browser_scroll if needed) until you have read every listing on the page. Do not use curl, wget or scripts to fetch the pages.

Dealers:
${lines}

For every equipment unit listed on a page, record:
- serial: exactly as printed after "Serial/PIN:"
- year, make, model
- price: number in USD, or null if not shown
- status: AVAILABLE, SOLD or SALE_PENDING (a SOLD ribbon or label means SOLD; a "Sale Pending" badge means SALE_PENDING)

When all pages are done, write ONE file /home/node/audit/${run.id}/listings.json with exactly this shape:
{"dealers":[{"dealer_id":"valley-ag","url":"<page url>","units":[{"serial":"...","year":2024,"make":"...","model":"...","price":123400,"status":"AVAILABLE"}]}]}

Rules: copy serials exactly, never invent or skip units, do not contact anyone or submit any forms.
Finish your reply with one line per dealer: "<dealer_id>: <n> units, <k> sold, <p> pending".`;
}

async function runLive(run, ctx) {
  const { agent37 } = ctx;
  const urls = Object.fromEntries(portfolio.dealers.map((d) => [d.id, dealerUrl(d.id, ctx.dealerSitesBase)]));
  emit(run, 'run.started', { mode: 'live', instance_id: agent37.instanceId, harness: 'hermes', dealers: urls, units: portfolio.units.length });
  for (const d of portfolio.dealers) emit(run, 'dealer.status', { dealer_id: d.id, state: 'queued' });
  emit(run, 'step', { kind: 'agent37', status: 'running', text: `Dispatching audit to Agent37 instance ${agent37.instanceId}`, detail: 'Hermes agent · own browser · always-on' });

  const raw = [];
  const tStart = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ctx.liveTimeoutMs || 9 * 60 * 1000);
  let terminal = null;
  try {
    terminal = await agent37.streamResponse({
      input: auditPrompt(run, urls),
      signal: ac.signal,
      onEvent: (name, data) => {
        raw.push({ t: Date.now() - tStart, name, data });
        translate(run, name, data);
      },
    });
  } catch (e) {
    emit(run, 'step', { kind: 'agent37', status: 'warn', text: 'Agent stream interrupted', detail: e.message });
    if (run.agent.response_id) await agent37.cancel(run.agent.response_id);
  } finally {
    clearTimeout(timer);
  }
  const duration = Date.now() - tStart;
  const out = terminal?.name === 'response.completed' ? terminal.data : null;
  run.agent = { ...run.agent, instance_id: agent37.instanceId, duration_ms: duration, usage: out?.usage || null, cost_usd: out?.usage?.cost_usd ?? null, output_text: out?.output_text || '' };
  emit(run, 'step', { kind: 'agent37', status: out ? 'done' : 'warn', text: out ? `Agent finished in ${fmtDur(duration)}` : 'Agent did not finish cleanly', detail: out ? `${run._agentState?.tools || 0} tool calls · ${out.usage?.output_tokens ?? '?'} output tokens` : '' });

  // Pull the agent's results file off its computer.
  const filePath = `/home/node/audit/${run.id}/listings.json`;
  emit(run, 'step', { kind: 'files', status: 'running', text: `Reading ${filePath} from the agent's computer`, detail: 'Agent37 Files API' });
  let listings = null;
  let source = 'agent-file';
  const buf = await agent37.readFile(filePath).catch(() => null);
  if (buf) {
    try { listings = normalizeListings(JSON.parse(buf.toString('utf8'))); } catch {}
  }
  if (!listings && run.agent.output_text && ctx.openai?.configured) {
    emit(run, 'step', { kind: 'openai', status: 'running', text: 'Repairing agent output with OpenAI structured outputs', detail: '' });
    try {
      const { data, model } = await ctx.openai.json({
        name: 'dealer_listings',
        schema: LISTINGS_SCHEMA,
        system: 'Extract equipment listings from an auditor agent transcript. Copy serials exactly. Never invent units.',
        user: run.agent.output_text,
      });
      listings = normalizeListings(data);
      source = 'openai-repair';
      emit(run, 'step', { kind: 'openai', status: 'done', text: `Structured with ${model}`, detail: '' });
    } catch (e) {
      emit(run, 'step', { kind: 'openai', status: 'warn', text: 'OpenAI repair failed', detail: e.message });
    }
  }
  if (!listings) {
    source = 'direct-fetch';
    emit(run, 'step', { kind: 'files', status: 'warn', text: 'No usable agent file; verifying pages directly', detail: 'fallback: fetch + parse dealer pages' });
    listings = await directFetch(urls).catch(() => null);
  }
  if (!listings) throw new Error('Could not obtain dealer listings');

  // Save a replayable recording of this live run.
  try {
    fs.mkdirSync(path.join(DATA_DIR, run.id), { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, run.id, 'replay.json'),
      JSON.stringify({ run_id: run.id, recorded_at: new Date(run.t0).toISOString(), instance_id: agent37.instanceId, duration_ms: duration, usage: run.agent.usage, output_text: run.agent.output_text, urls, listings_source: source, listings, events: raw }, null, 1),
    );
  } catch (e) {
    console.warn('could not save replay', e.message);
  }
  return { listings, source, urls };
}

async function directFetch(urls) {
  const out = {};
  for (const [id, url] of Object.entries(urls)) {
    const html = await (await fetch(url)).text();
    out[id] = [...html.matchAll(/<article[^>]*class="unit"[^>]*>/g)].map((m) => {
      const a = (k) => m[0].match(new RegExp(`data-${k}="([^"]*)"`))?.[1] ?? null;
      return { serial: a('serial'), year: Number(a('year')) || null, make: a('make'), model: a('model'), price: Number(a('price')) || null, status: a('status') || 'AVAILABLE' };
    });
  }
  return out;
}

function normalizeListings(data) {
  const out = {};
  const arr = Array.isArray(data?.dealers) ? data.dealers : [];
  for (const d of arr) {
    const id = String(d.dealer_id || '').trim();
    if (!dealerById[id]) continue;
    out[id] = (d.units || []).filter((u) => u && u.serial).map((u) => ({
      serial: String(u.serial).trim(),
      year: u.year ?? null,
      make: u.make ?? null,
      model: u.model ?? null,
      price: typeof u.price === 'number' ? u.price : Number(String(u.price || '').replace(/[^0-9.]/g, '')) || null,
      status: /sold/i.test(u.status) ? 'SOLD' : /pend/i.test(u.status) ? 'SALE_PENDING' : 'AVAILABLE',
    }));
  }
  return Object.keys(out).length ? out : null;
}

/* ---------------- replay: a recorded live run (or a simulated one before any recording exists) ---------------- */

function loadRecording() {
  for (const p of [path.join(root, 'fixtures', 'replay.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return null;
}

async function synthesize(ctx) {
  const truth = await groundTruthListings();
  const events = [];
  let t = 0;
  const push = (dt, name, data) => events.push({ t: (t += dt), name, data });
  push(200, 'response.created', { id: 'sim', session_id: 'sim' });
  push(600, 'response.reasoning.delta', { text: 'Three dealer inventory pages to audit. I will read each page fully, then write listings.json.' });
  const listings = {};
  for (const d of portfolio.dealers) {
    const url = dealerUrl(d.id, ctx.dealerSitesBase || 'https://dealers.floorcheck.demo');
    push(500, 'response.tool_call.started', { tool: 'browser_navigate', label: `Navigate to ${url}`, arguments: { url } });
    push(2200, 'response.tool_call.completed', { tool: 'browser_navigate', duration_ms: 2100 });
    push(300, 'response.tool_call.started', { tool: 'browser_snapshot', label: 'Read page snapshot', arguments: {} });
    push(1600, 'response.tool_call.completed', { tool: 'browser_snapshot', duration_ms: 1500 });
    push(300, 'response.tool_call.started', { tool: 'browser_scroll', label: 'Scroll down', arguments: { direction: 'down' } });
    push(900, 'response.tool_call.completed', { tool: 'browser_scroll', duration_ms: 800 });
    const rows = truth[d.id];
    const sold = rows.filter((r) => r.status === 'SOLD').length;
    push(400, 'response.reasoning.delta', { text: `${d.name}: ${rows.length} listings read${sold ? `, ${sold} marked SOLD` : ''}.` });
    listings[d.id] = rows.map((r) => ({ serial: r.serial, year: r.year, make: r.make, model: r.model, price: r.price ?? null, status: r.status }));
  }
  push(500, 'response.tool_call.started', { tool: 'write_file', label: 'Write /home/node/audit/listings.json', arguments: { path: '/home/node/audit/listings.json' } });
  push(700, 'response.tool_call.completed', { tool: 'write_file', duration_ms: 600 });
  push(300, 'response.output_text.delta', { text: portfolio.dealers.map((d) => `${d.id}: ${listings[d.id].length} units`).join('\n') });
  push(200, 'response.completed', { output_text: '', usage: null });
  return { synthetic: true, instance_id: ctx.agent37?.instanceId || 'demo', duration_ms: t, usage: null, events, listings, urls: {} };
}

async function runReplay(run, ctx) {
  const rec = loadRecording() || (await synthesize(ctx));
  run.agent = { instance_id: rec.instance_id, duration_ms: rec.duration_ms, usage: rec.usage || null, cost_usd: rec.usage?.cost_usd ?? null, recorded_at: rec.recorded_at || null, replay_of: rec.run_id || null, synthetic: !!rec.synthetic };

  // Compress the recording's timeline into ~targetMs so a multi-minute run replays watchably.
  const target = ctx.replayTargetMs || 24000;
  const maxGap = 1800;
  const gaps = rec.events.map((e, i) => Math.min(maxGap, Math.max(0, e.t - (i ? rec.events[i - 1].t : 0))));
  const total = gaps.reduce((a, b) => a + b, 0) || 1;
  const scale = Math.min(1, target / total);
  run.agent.speedup = Math.max(1, (rec.duration_ms || total) / (total * scale));

  emit(run, 'run.started', { mode: 'replay', synthetic: !!rec.synthetic, replay_of: rec.run_id || null, recorded_at: rec.recorded_at || null, instance_id: rec.instance_id, harness: 'hermes', dealers: rec.urls || {}, units: portfolio.units.length, speedup: run.agent.speedup });
  for (const d of portfolio.dealers) emit(run, 'dealer.status', { dealer_id: d.id, state: 'queued' });
  emit(run, 'step', { kind: 'agent37', status: 'running', text: `Dispatching audit to Agent37 instance ${rec.instance_id}`, detail: 'Hermes agent · own browser · always-on' });
  for (let i = 0; i < rec.events.length; i++) {
    const g = gaps[i] * scale;
    if (g > 4) await sleep(g);
    translate(run, rec.events[i].name, rec.events[i].data);
  }
  emit(run, 'step', { kind: 'agent37', status: 'done', text: `Agent finished in ${fmtDur(rec.duration_ms || 0)}`, detail: `${run._agentState?.tools || 0} tool calls${rec.synthetic ? ' · simulated' : ' · recorded live run, replayed'}` });
  emit(run, 'step', { kind: 'files', status: 'running', text: `Reading /home/node/audit/${rec.run_id || run.id}/listings.json from the agent's computer`, detail: 'Agent37 Files API' });
  await sleep(700);
  return { listings: rec.listings, source: rec.listings_source || 'agent-file', urls: rec.urls || {} };
}

/* ---------------- shared pipeline: match -> value -> summarize ---------------- */

async function finishPipeline(run, ctx, { listings, source, urls }) {
  const count = Object.values(listings).reduce((a, l) => a + l.length, 0);
  emit(run, 'step', { kind: 'files', status: 'done', text: `Got ${count} listings from ${Object.keys(listings).length} dealer sites`, detail: source === 'agent-file' ? 'written by the agent' : source });

  emit(run, 'step', { kind: 'match', status: 'running', text: `Matching ${portfolio.units.length} financed serials against ${count} listings`, detail: 'deterministic serial match' });
  const bySerial = new Map();
  for (const [dealerId, rows] of Object.entries(listings)) for (const r of rows) bySerial.set(normSerial(r.serial), { ...r, dealer_id: dealerId });

  const results = [];
  const findings = [];
  const fast = ctx.fastMatch;
  for (const d of portfolio.dealers) {
    emit(run, 'dealer.status', { dealer_id: d.id, state: 'matching' });
    for (const u of portfolio.units.filter((x) => x.dealer_id === d.id)) {
      const hit = bySerial.get(normSerial(u.serial));
      let status = 'VERIFIED';
      if (!hit) status = 'NOT_FOUND';
      else if (hit.status === 'SOLD') status = 'SOLD_OUT_OF_TRUST';
      else if (hit.status === 'SALE_PENDING') status = 'SALE_PENDING';
      const listingUrl = (urls[d.id] || d.path) + `#unit-${u.serial}`;
      const row = { unit_id: u.id, dealer_id: d.id, status, listing: hit ? { ...hit, url: listingUrl } : null };
      results.push(row);
      emit(run, 'unit', row);
      if (status !== 'VERIFIED') {
        const f = makeFinding(run, u, d, status, hit, listingUrl);
        findings.push(f);
        emit(run, 'finding', f);
        await sleep(fast ? 0 : 520);
      } else {
        await sleep(fast ? 0 : 55);
      }
    }
    const mine = results.filter((r) => r.dealer_id === d.id);
    emit(run, 'dealer.status', { dealer_id: d.id, state: 'done', counts: countBy(mine) });
  }
  const unfinanced = count - results.filter((r) => r.listing).length;
  emit(run, 'step', { kind: 'match', status: 'done', text: `${findings.length} exceptions across ${portfolio.dealers.length} dealers`, detail: `${unfinanced} listings are other inventory (not financed by ${portfolio.lender.name})` });

  // Collateral valuation for units still on the lot.
  emit(run, 'step', { kind: 'monid', status: 'running', text: 'Valuing collateral against market comps', detail: ctx.monid?.configured ? 'Monid · mrscraper/scrape/listing' : 'cached comps' });
  if (ctx.monid?.configured && !ctx.skipMonidDiscover) {
    try {
      const found = await ctx.monid.discover('extract listings from a marketplace search results page', 3);
      const top = found[0];
      if (top) emit(run, 'step', { kind: 'monid', status: 'running', text: `Monid discover → ${top.provider}${top.endpoint}`, detail: `${top.price?.type === 'PER_RESULT' ? '$' + top.price.amount.value + ' / result' : '$' + (top.price?.amount?.value ?? '?') + ' / call'}` });
    } catch {}
  }
  const onLot = results.filter((r) => r.status === 'VERIFIED' || r.status === 'SALE_PENDING');
  const valued = valueUnits(onLot.map((r) => portfolio.units.find((u) => u.id === r.unit_id)));
  let mv = 0;
  let adv = 0;
  for (const v of valued) {
    const u = portfolio.units.find((x) => x.id === v.unit_id);
    v.ltv = u.advance / v.market_value;
    mv += v.market_value;
    adv += u.advance;
    if (v.ltv > 1) {
      const d = dealerById[u.dealer_id];
      const f = {
        id: `${run.id}-${u.id}-ltv`, unit_id: u.id, dealer_id: d.id, type: 'COLLATERAL_SHORTFALL', severity: 'watch',
        title: 'Collateral below advance', amount: Math.round(u.advance - v.market_value),
        unit: u, dealer: { id: d.id, name: d.name },
        detail: `${u.year} ${u.make} ${u.model}: market ${money(v.market_value)} vs advance ${money(u.advance)} (LTV ${(v.ltv * 100).toFixed(0)}%)`,
        evidence: { valuation: v },
      };
      findings.push(f);
      emit(run, 'finding', f);
    }
  }
  const liveComps = valued.filter((v) => v.source === 'monid').length;
  emit(run, 'valuation', { units: valued, market_value_total: mv, advances_valued: adv, coverage: adv ? mv / adv : null, live_comps_units: liveComps });
  emit(run, 'step', { kind: 'monid', status: 'done', text: `Collateral coverage ${(100 * mv / adv).toFixed(0)}% on ${valued.length} units on the lot`, detail: liveComps ? `${liveComps} models priced from live Monid comps · others estimated` : 'estimated from cached comps' });

  const summary = summarize(run, results, findings, { mv, adv, unfinanced });
  run.result = { results, findings, valuation: valued, summary };
  emit(run, 'summary', summary);
}

function countBy(rows) {
  const c = { VERIFIED: 0, SOLD_OUT_OF_TRUST: 0, SALE_PENDING: 0, NOT_FOUND: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

const FINDING_TEXT = {
  SOLD_OUT_OF_TRUST: { title: 'Sold out of trust', severity: 'critical' },
  NOT_FOUND: { title: 'Not found on dealer site', severity: 'high' },
  SALE_PENDING: { title: 'Sale pending: payoff due', severity: 'watch' },
};

function makeFinding(run, u, d, status, hit, listingUrl) {
  const meta = FINDING_TEXT[status];
  const shot = status === 'NOT_FOUND' ? `/evidence/site-${d.id}.png` : `/evidence/${u.serial}.png`;
  const detail = {
    SOLD_OUT_OF_TRUST: `Listed as SOLD on ${d.name}'s site while the floor-plan advance of ${money(u.advance)} is still outstanding.`,
    NOT_FOUND: `Serial ${u.serial} does not appear anywhere in ${d.name}'s published inventory. Schedule a physical spot check.`,
    SALE_PENDING: `Marked Sale Pending. Payoff of ${money(u.advance)} becomes due when the sale closes.`,
  }[status];
  return {
    id: `${run.id}-${u.id}`, unit_id: u.id, dealer_id: d.id, type: status, severity: meta.severity, title: meta.title,
    amount: u.advance, unit: u, dealer: { id: d.id, name: d.name, principal: d.principal, email: d.email, phone: d.phone },
    detail,
    evidence: { listing: hit || null, url: listingUrl, screenshot: shot, captured_at: new Date().toISOString(), captured_by: `Agent37 · ${run.agent.instance_id || ''}` },
    // Recovery value from live marketplace comps (Monid), when we have them for this model.
    market: (() => {
      const v = valueUnit(u);
      return v.source === 'monid' ? v : null;
    })(),
  };
}

function summarize(run, results, findings, { mv, adv, unfinanced }) {
  const sum = (st) => results.filter((r) => r.status === st).reduce((a, r) => a + portfolio.units.find((u) => u.id === r.unit_id).advance, 0);
  const cnt = (st) => results.filter((r) => r.status === st).length;
  const dealers = portfolio.dealers.map((d) => {
    const mine = results.filter((r) => r.dealer_id === d.id);
    const c = countBy(mine);
    const exposure = portfolio.units.filter((u) => u.dealer_id === d.id).reduce((a, u) => a + u.advance, 0);
    const atRisk = mine.filter((r) => r.status === 'SOLD_OUT_OF_TRUST').reduce((a, r) => a + portfolio.units.find((u) => u.id === r.unit_id).advance, 0);
    const risk = c.SOLD_OUT_OF_TRUST ? 'high' : c.NOT_FOUND || c.SALE_PENDING ? 'medium' : 'low';
    return { id: d.id, name: d.name, counts: c, exposure, at_risk: atRisk, risk };
  });
  return {
    run_id: run.id,
    mode: run.mode,
    units_total: results.length,
    exposure_total: portfolio.units.reduce((a, u) => a + u.advance, 0),
    verified_count: cnt('VERIFIED'), verified_amount: sum('VERIFIED'),
    soot_count: cnt('SOLD_OUT_OF_TRUST'), soot_amount: sum('SOLD_OUT_OF_TRUST'),
    pending_count: cnt('SALE_PENDING'), pending_amount: sum('SALE_PENDING'),
    notfound_count: cnt('NOT_FOUND'), notfound_amount: sum('NOT_FOUND'),
    findings_count: findings.length,
    unfinanced_listings: unfinanced,
    coverage: adv ? mv / adv : null, market_value_total: mv, advances_valued: adv,
    dealers,
    agent_duration_ms: run.agent.duration_ms ?? null,
    agent_cost_usd: run.agent.cost_usd ?? null,
    agent_tool_calls: run._agentState?.tools ?? 0,
    instance_id: run.agent.instance_id || null,
    replay_of: run.agent.replay_of || null,
    synthetic: !!run.agent.synthetic,
    speedup: run.agent.speedup ? Math.round(run.agent.speedup * 10) / 10 : null,
  };
}

export function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export { auditPrompt, money };
