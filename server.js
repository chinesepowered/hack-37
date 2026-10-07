// FloorCheck: an AI floor-plan auditor. Express server + audit pipeline.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, cfg } from './lib/env.js';
import { portfolio, dealerById, dealerUrl } from './lib/data.js';
import { Agent37 } from './lib/agent37.js';
import { OpenAIClient } from './lib/openai.js';
import { Monid } from './lib/monid.js';
import { initStore, listRuns, storeKind } from './lib/store.js';
import { startRun, getRun, subscribe, activeRun, auditPrompt, money } from './lib/audit.js';

loadEnv();
const C = cfg();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const agent37 = new Agent37({ key: C.agent37Key, instanceId: C.agent37Instance });
const openai = new OpenAIClient({ key: C.openaiKey, model: C.openaiModel });
const monid = new Monid({ key: C.monidKey });
await initStore(C.databaseUrl);

// Where the auditor agent browses the dealer sites. Must be publicly reachable for live runs.
const dealerSitesBase = C.dealerSitesBase || (C.publicUrl ? `${C.publicUrl}/dealers` : '');
const liveCapable = agent37.configured && Boolean(dealerSitesBase);
const ctx = { agent37, openai, monid, dealerSitesBase };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/config', (_req, res) => {
  res.json({
    lender: portfolio.lender,
    dealers: portfolio.dealers.map((d) => ({ ...d, site_url: dealerSitesBase ? dealerUrl(d.id, dealerSitesBase) : d.path })),
    integrations: {
      agent37: agent37.configured ? { instance_id: agent37.instanceId } : null,
      openai: openai.configured,
      monid: monid.configured,
      store: storeKind(),
    },
    live_capable: liveCapable,
    default_mode: C.defaultMode || (liveCapable ? 'live' : 'replay'),
  });
});

app.get('/api/portfolio', (_req, res) => res.json(portfolio));

app.post('/api/runs', (req, res) => {
  const running = activeRun();
  if (running) return res.json({ id: running.id, mode: running.mode, reused: true });
  let mode = req.body?.mode || C.defaultMode || (liveCapable ? 'live' : 'replay');
  if (mode === 'live' && !liveCapable) mode = 'replay';
  const run = startRun(mode, {
    ...ctx,
    replayTargetMs: Number(req.body?.replay_ms) || 24000,
    fastMatch: Boolean(req.body?.fast),
    skipMonidDiscover: mode === 'replay',
  });
  res.json({ id: run.id, mode: run.mode });
});

app.get('/api/runs', async (_req, res) => res.json({ data: await listRuns() }));

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not_found' });
  res.json({ id: run.id, mode: run.mode, state: run.state, result: run.result, agent: run.agent });
});

app.get('/api/runs/:id/events', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  subscribe(run, res, Number(req.headers['last-event-id'] ?? -1) + 1 || 0);
});

// Nightly audit: an Agent37 platform cron wakes the agent at 2am even if the instance sleeps.
app.post('/api/schedule', async (_req, res) => {
  const body = {
    name: 'FloorCheck nightly floor check',
    schedule: '0 2 * * *',
    timezone: 'America/Los_Angeles',
    prompt: auditPrompt({ id: 'nightly' }, Object.fromEntries(portfolio.dealers.map((d) => [d.id, dealerUrl(d.id, dealerSitesBase || 'https://dealers.floorcheck.demo')]))),
  };
  if (!agent37.configured) return res.json({ demo: true, cron: { id: 'demo', ...body, next_run: nextTwoAm() } });
  try {
    const existing = (await agent37.listCrons()).data?.find((c) => c.name === body.name);
    const cron = existing || (await agent37.createCron(body));
    res.json({ demo: false, cron: { ...cron, prompt: undefined } });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function nextTwoAm() {
  const d = new Date();
  d.setHours(26, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Credit-committee memo for a finished run.
app.post('/api/runs/:id/memo', async (req, res) => {
  const run = getRun(req.params.id);
  if (!run?.result) return res.status(404).json({ error: 'run_not_ready' });
  const s = run.result.summary;
  const facts = {
    lender: portfolio.lender,
    summary: { ...s, dealers: s.dealers },
    findings: run.result.findings.map((f) => ({ type: f.type, dealer: f.dealer.name, unit: `${f.unit.year} ${f.unit.make} ${f.unit.model}`, serial: f.unit.serial, advance: f.unit.advance, detail: f.detail })),
  };
  if (openai.configured) {
    try {
      const { text, model } = await openai.text({
        system: 'You write crisp credit-committee memos for a floor-plan lender. Markdown. Sections: Summary (3 bullets), Exceptions (table: Dealer | Unit | Serial | Advance | Finding), Dealer risk, Recommended actions (numbered, specific: payoff demands with deadlines, spot checks, credit line holds). Use only the facts given. Under 300 words.',
        user: JSON.stringify(facts),
      });
      return res.json({ markdown: text, model });
    } catch (e) {
      console.warn('memo via OpenAI failed', e.message);
    }
  }
  res.json({ markdown: templateMemo(run), model: 'template' });
});

// Payoff demand letter for one dealer's sold-out-of-trust units.
app.post('/api/runs/:id/demand/:dealerId', async (req, res) => {
  const run = getRun(req.params.id);
  const d = dealerById[req.params.dealerId];
  if (!run?.result || !d) return res.status(404).json({ error: 'not_found' });
  const units = run.result.findings.filter((f) => f.dealer_id === d.id && f.type === 'SOLD_OUT_OF_TRUST');
  if (!units.length) return res.status(400).json({ error: 'no_sold_out_of_trust_units' });
  const total = units.reduce((a, f) => a + f.unit.advance, 0);
  const facts = { lender: portfolio.lender.name, dealer: d, units: units.map((f) => ({ unit: `${f.unit.year} ${f.unit.make} ${f.unit.model}`, serial: f.unit.serial, advance: f.unit.advance, evidence_url: f.evidence.url })), total };
  if (openai.configured) {
    try {
      const { data, model } = await openai.json({
        name: 'payoff_demand',
        schema: { type: 'object', additionalProperties: false, required: ['subject', 'body'], properties: { subject: { type: 'string' }, body: { type: 'string' } } },
        system: 'Draft a firm, professional payoff demand email from a floor-plan lender to an equipment dealer whose financed units appear sold while the advances remain unpaid. Cite each serial and amount, request payoff within 2 business days, reference the floor-plan agreement generally (no invented clause numbers), offer a call. Plain text body, under 220 words, signed "Portfolio Operations, ' + portfolio.lender.name + '".',
        user: JSON.stringify(facts),
      });
      return res.json({ to: d.email, ...data, model });
    } catch (e) {
      console.warn('demand via OpenAI failed', e.message);
    }
  }
  res.json({ to: d.email, subject: `Payoff required: ${units.length} unit${units.length > 1 ? 's' : ''} reported sold (${money(total)})`, body: templateDemand(d, units, total), model: 'template' });
});

function templateMemo(run) {
  const s = run.result.summary;
  const rows = run.result.findings.filter((f) => f.type !== 'COLLATERAL_SHORTFALL').map((f) => `| ${f.dealer.name} | ${f.unit.year} ${f.unit.make} ${f.unit.model} | \`${f.unit.serial}\` | ${money(f.unit.advance)} | ${f.title} |`).join('\n');
  return `### Floor check ${s.run_id}: ${portfolio.lender.facility}

**Summary**
- ${s.verified_count} of ${s.units_total} financed units verified on dealer sites (${money(s.verified_amount)} of ${money(s.exposure_total)}).
- **${s.soot_count} units appear sold out of trust: ${money(s.soot_amount)} at risk.**
- ${s.notfound_count} units not found (${money(s.notfound_amount)}); ${s.pending_count} sale pending. Collateral coverage ${(s.coverage * 100).toFixed(0)}%.

**Exceptions**

| Dealer | Unit | Serial | Advance | Finding |
|---|---|---|---|---|
${rows}

**Recommended actions**
1. Issue payoff demands for sold units, due within 2 business days.
2. Physical spot check of not-found units this week.
3. Hold new advances to dealers with sold-out-of-trust units until cured.`;
}

function templateDemand(d, units, total) {
  const lines = units.map((f) => `  - ${f.unit.year} ${f.unit.make} ${f.unit.model}, serial ${f.unit.serial}: ${money(f.unit.advance)}`).join('\n');
  return `Hi ${d.principal.split(' ')[0]},

Our nightly floor check found the following financed units listed as sold on ${d.name}'s website, while the floor-plan advances remain outstanding:

${lines}

Total due: ${money(total)}.

Under the floor-plan agreement, sale proceeds for financed units must be remitted at the time of sale. Please remit payoff within 2 business days, or reply with the sale details if this is in error. Happy to get on a call today.

Portfolio Operations, ${portfolio.lender.name}`;
}

app.listen(C.port, () => {
  console.log(`FloorCheck on http://localhost:${C.port}`);
  console.log(`  agent37: ${agent37.configured ? agent37.instanceId : 'not configured'} · dealer sites: ${dealerSitesBase || '(local only)'} · live: ${liveCapable}`);
  console.log(`  openai: ${openai.configured} · monid: ${monid.configured} · store: ${storeKind()}`);
});
