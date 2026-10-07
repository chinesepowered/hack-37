// FloorCheck dashboard: streams an audit run (Server-Sent Events) and renders it live.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const params = new URLSearchParams(location.search);

const S = {
  config: null,
  pf: null,
  units: {},
  run: null,
  es: null,
  findings: [],
  valuation: {},
  summary: null,
  stepRows: {},
  toolRows: [],
  t0: 0,
  timer: null,
  speedup: 1,
  tools: 0,
  counts: { VERIFIED: 0, SOLD_OUT_OF_TRUST: 0, NOT_FOUND: 0, SALE_PENDING: 0 },
  amounts: { VERIFIED: 0, SOLD_OUT_OF_TRUST: 0, NOT_FOUND: 0, SALE_PENDING: 0 },
};

/* ---------- formatting ---------- */
const fmtMoney = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `$${Math.round(n)}`;
};
const fmtFull = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unitName = (u) => `${u.year} ${u.make} ${u.model}`;

const ICONS = {
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  scroll: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>',
  cpu: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  compare: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V14a4 4 0 0 0 4 4h5.5M18 15.5V10a4 4 0 0 0-4-4H8.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
};
const toolIcon = (tool = '') => {
  if (/vision|snapshot|get_images/.test(tool)) return ICONS.eye;
  if (/scroll/.test(tool)) return ICONS.scroll;
  if (/browser/.test(tool)) return ICONS.globe;
  if (/search/.test(tool)) return ICONS.search;
  if (/write|file|patch/.test(tool)) return ICONS.file;
  if (/terminal|exec|shell|code/.test(tool)) return ICONS.terminal;
  return ICONS.bolt;
};
const STEP_ICON = { agent37: ICONS.cpu, files: ICONS.download, openai: ICONS.sparkle, match: ICONS.compare, monid: ICONS.chart };

/* ---------- init ---------- */
async function init() {
  const [config, pf] = await Promise.all([fetch('/api/config').then((r) => r.json()), fetch('/api/portfolio').then((r) => r.json())]);
  S.config = config;
  S.pf = pf;
  S.units = Object.fromEntries(pf.units.map((u) => [u.id, u]));
  $('#lender-name').textContent = pf.lender.name;
  $('#facility-name').textContent = pf.lender.facility;
  S.mode = params.get('mode') || config.default_mode;
  setModeChip();
  const inst = config.integrations.agent37?.instance_id;
  $('#agent-sub').innerHTML = inst ? `Agent37 Cloud · Hermes · instance <span class="mono">${esc(inst)}</span>` : 'Agent37 Cloud · Hermes · its own computer and browser';
  renderBaseline();
  bind();
  if (params.get('autorun')) startRun();
}

function setModeChip(extra) {
  const chip = $('#mode-chip');
  chip.className = 'mode-chip ' + (S.mode === 'live' ? 'live' : 'replay');
  $('#mode-text').textContent = extra || (S.mode === 'live' ? 'Live · Agent37' : 'Replay mode');
}

function renderBaseline() {
  const exposure = S.pf.units.reduce((a, u) => a + u.advance, 0);
  setKpi('exposure', fmtMoney(exposure));
  $('#kpi-exposure-sub').textContent = `${S.pf.units.length} units · ${S.pf.dealers.length} dealers`;
  $('#ledger-count').textContent = S.pf.units.length;
  $('#dealer-count').textContent = `${S.pf.dealers.length} on floor plan`;
  renderDealers();
  renderLedger();
}

function renderDealers() {
  $('#dealer-list').innerHTML = S.config.dealers
    .map((d) => {
      const units = S.pf.units.filter((u) => u.dealer_id === d.id);
      const exp = units.reduce((a, u) => a + u.advance, 0);
      return `<div class="dealer-card" data-dealer="${d.id}">
        <div class="dealer-top"><div><div class="dealer-name">${esc(d.name)}</div><div class="dealer-city">${esc(d.city)} · ${esc(d.segment)}</div></div><span class="risk none" data-risk>Queued</span></div>
        <div class="dealer-figs"><span><b>${units.length}</b> units</span><span><b>${fmtMoney(exp)}</b> floored</span></div>
        <div class="dealer-state" data-state>Queued for audit</div>
        <a class="dealer-link" href="${esc(d.site_url)}" target="_blank" rel="noopener">Public inventory page ${ICONS.ext}</a>
      </div>`;
    })
    .join('');
}

function renderLedger() {
  const dealers = Object.fromEntries(S.pf.dealers.map((d) => [d.id, d]));
  $('#ledger tbody').innerHTML = S.pf.units
    .map((u) => `<tr id="row-${u.id}"><td class="mono">${u.id.replace('FP-2041-', '#')}</td><td>${esc(dealers[u.dealer_id].name)}</td><td>${esc(unitName(u))}</td><td class="mono">${esc(u.serial)}</td><td class="num">${fmtFull(u.advance)}</td><td class="num" data-mv>—</td><td class="num" data-ltv>—</td><td><span class="pill PENDING" data-pill>Pending</span></td></tr>`)
    .join('');
}

function bind() {
  $('#run-audit').addEventListener('click', startRun);
  $('#btn-schedule').addEventListener('click', schedule);
  $('#btn-memo').addEventListener('click', openMemo);
  $('#btn-demands').addEventListener('click', openDemands);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#modal-close').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal').addEventListener('click', (e) => e.target.id === 'modal' && ($('#modal').hidden = true));
  $('#modal-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText($('#modal-body').innerText).catch(() => {});
    toast('Copied to clipboard');
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      $('#modal').hidden = true;
    }
  });
}

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-body').forEach((b) => (b.hidden = b.dataset.body !== name));
  if (name === 'history') loadHistory();
}

/* ---------- run lifecycle ---------- */
async function startRun() {
  if (document.body.dataset.runState === 'running') return;
  resetRun();
  const body = { mode: S.mode };
  if (params.get('replay_ms')) body.replay_ms = Number(params.get('replay_ms'));
  const r = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
  S.run = r;
  S.mode = r.mode;
  setModeChip();
  document.body.dataset.runState = 'running';
  const btn = $('#run-audit');
  btn.disabled = true;
  btn.classList.add('running');
  btn.querySelector('svg').outerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
  $('#run-text').textContent = 'Auditing…';
  const es = new EventSource(`/api/runs/${r.id}/events`);
  S.es = es;
  const types = ['run.started', 'dealer.status', 'step', 'agent.created', 'agent.reasoning', 'agent.text', 'agent.tool', 'agent.completed', 'agent.failed', 'unit', 'finding', 'valuation', 'summary', 'run.completed', 'run.failed'];
  for (const t of types) es.addEventListener(t, (m) => handle(t, JSON.parse(m.data)));
  es.onerror = () => {
    if (document.body.dataset.runState !== 'running') es.close();
  };
}

function resetRun() {
  S.findings = [];
  S.valuation = {};
  S.summary = null;
  S.stepRows = {};
  S.toolRows = [];
  S.tools = 0;
  S.counts = { VERIFIED: 0, SOLD_OUT_OF_TRUST: 0, NOT_FOUND: 0, SALE_PENDING: 0 };
  S.amounts = { VERIFIED: 0, SOLD_OUT_OF_TRUST: 0, NOT_FOUND: 0, SALE_PENDING: 0 };
  $('#timeline').innerHTML = '';
  $('#findings-list').innerHTML = '';
  $('#findings-count').textContent = '';
  $('#agent-tools').textContent = '0';
  $('#agent-elapsed').textContent = '0:00';
  ['soot', 'notfound', 'verified', 'coverage', 'time'].forEach((k) => setKpi(k, '—'));
  $('#kpi-soot').classList.remove('hot');
  $('#kpi-notfound').classList.remove('hot');
  $('#kpi-coverage').classList.remove('good');
  $('#verified-bar').style.width = '0%';
  $('#kpi-verified-sub').textContent = 'Agent is reading dealer sites…';
  $('#kpi-soot-sub').textContent = 'Sold, advance unpaid';
  $('#kpi-notfound-sub').textContent = 'Missing from dealer sites';
  $('#kpi-coverage-sub').textContent = 'Market value vs advances';
  $('#kpi-run-sub').textContent = 'Agent time · cost';
  $('#btn-memo').disabled = true;
  $('#btn-demands').disabled = true;
  renderDealers();
  renderLedger();
  showTab('activity');
}

function handle(type, ev) {
  const d = ev.data;
  switch (type) {
    case 'run.started': {
      S.t0 = performance.now();
      S.speedup = d.speedup || 1;
      const inst = d.instance_id;
      if (inst) $('#agent-sub').innerHTML = `Agent37 Cloud · Hermes · instance <span class="mono">${esc(inst)}</span>`;
      if (d.mode === 'replay') setModeChip(d.synthetic ? 'Simulated run' : `Replay · live run ${d.replay_of || ''}`.trim());
      setAgentState('working', 'working');
      clearInterval(S.timer);
      S.timer = setInterval(() => ($('#agent-elapsed').textContent = fmtClock((performance.now() - S.t0) * S.speedup)), 250);
      break;
    }
    case 'dealer.status':
      dealerState(d);
      break;
    case 'step':
      addStep(d);
      break;
    case 'agent.tool':
      onTool(d);
      break;
    case 'agent.reasoning':
    case 'agent.text':
      think(d.text);
      break;
    case 'agent.completed':
      clearInterval(S.timer);
      setAgentState('done', 'done');
      $('#thinking').hidden = true;
      closeOpenTools();
      break;
    case 'agent.failed':
      setAgentState('error', '');
      break;
    case 'unit':
      onUnit(d);
      break;
    case 'finding':
      onFinding(d);
      break;
    case 'valuation':
      onValuation(d);
      break;
    case 'summary':
      onSummary(d);
      break;
    case 'run.completed':
      finishRun(true);
      break;
    case 'run.failed':
      toast(`Audit failed: ${d.error}`);
      finishRun(false);
      break;
  }
}

function finishRun(ok) {
  S.es?.close();
  clearInterval(S.timer);
  document.body.dataset.runState = ok ? 'complete' : 'failed';
  const btn = $('#run-audit');
  btn.disabled = false;
  btn.classList.remove('running');
  btn.querySelector('svg').outerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5l11 7-11 7z"/></svg>';
  $('#run-text').textContent = 'Run again';
  if (ok && S.summary) {
    const s = S.summary;
    toast(`Floor check complete · ${s.soot_count} units sold out of trust (${fmtMoney(s.soot_amount)})`, true);
  }
}

function setAgentState(text, cls) {
  const p = $('#agent-state');
  p.textContent = text;
  p.className = 'agent-pill ' + cls;
}

/* ---------- timeline ---------- */
function stepRow({ kind, icon, title, detail, status = 'running' }) {
  $('#timeline-empty')?.remove();
  const el = document.createElement('div');
  el.className = `step k-${kind} s-${status}`;
  const t = fmtClock((performance.now() - S.t0) * S.speedup);
  el.innerHTML = `<div class="step-icon">${icon}</div><div class="step-main"><div class="step-title">${title}</div>${detail ? `<div class="step-detail">${detail}</div>` : ''}</div><div class="step-meta"><span class="t">${t}</span><span class="state">${status === 'running' ? '<span class="spinner"></span>' : status === 'warn' ? `<span style="color:var(--warn)">${ICONS.warn}</span>` : `<span class="ok">${ICONS.check}</span>`}</span></div>`;
  const tl = $('#timeline');
  tl.appendChild(el);
  tl.scrollTop = tl.scrollHeight;
  return el;
}

function setRowDone(el, status = 'done', dur) {
  if (!el) return;
  el.classList.remove('s-running');
  el.classList.add(`s-${status}`);
  const st = el.querySelector('.state');
  st.innerHTML = status === 'warn' ? `<span style="color:var(--warn)">${ICONS.warn}</span>` : `<span class="ok">${ICONS.check}</span>`;
  if (dur != null) {
    const chip = document.createElement('span');
    chip.className = 'dur';
    // Hermes reports tool durations in seconds (float); other harnesses in ms.
    const secs = dur < 100 && !Number.isInteger(dur) ? dur : dur / 1000;
    chip.textContent = secs < 1 ? `${Math.round(secs * 1000)}ms` : `${secs.toFixed(1)}s`;
    st.before(chip);
  }
}

function addStep(d) {
  const prev = S.stepRows[d.kind];
  if (prev && prev.classList.contains('s-running')) {
    // Update the running row in place for its terminal state.
    if (d.status === 'running') {
      setRowDone(prev);
    } else {
      prev.querySelector('.step-title').innerHTML = esc(d.text);
      const det = prev.querySelector('.step-detail');
      if (det) det.textContent = d.detail || '';
      else if (d.detail) prev.querySelector('.step-main').insertAdjacentHTML('beforeend', `<div class="step-detail">${esc(d.detail)}</div>`);
      setRowDone(prev, d.status);
      return;
    }
  }
  S.stepRows[d.kind] = stepRow({ kind: d.kind, icon: STEP_ICON[d.kind] || ICONS.bolt, title: esc(d.text), detail: d.detail ? esc(d.detail) : '', status: d.status });
}

function prettyLabel(d) {
  const url = d.args?.url;
  if (url) {
    const dealer = d.dealer_id && S.config.dealers.find((x) => x.id === d.dealer_id);
    return { title: dealer ? `Opening ${esc(dealer.name)} inventory` : 'Opening page', detail: `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` };
  }
  let label = (d.label || '').replace(/\s+/g, ' ').trim();
  if (label.length > 96) label = label.slice(0, 96) + '…';
  const path = d.args?.path || d.args?.file_path;
  return { title: esc(label || d.tool), detail: path ? `<span class="mono">${esc(path)}</span>` : '' };
}

function onTool(d) {
  if (d.phase === 'started') {
    S.tools++;
    $('#agent-tools').textContent = S.tools;
    const { title, detail } = prettyLabel(d);
    const row = stepRow({ kind: /browser/.test(d.tool) ? 'browser' : 'tool', icon: toolIcon(d.tool), title: `<span class="tool">${esc(d.tool)}</span>${title}`, detail });
    S.toolRows.push({ tool: d.tool, el: row, open: true });
  } else if (d.phase === 'completed' || d.phase === 'failed') {
    const r = [...S.toolRows].reverse().find((x) => x.open && x.tool === d.tool) || [...S.toolRows].reverse().find((x) => x.open);
    if (r) {
      r.open = false;
      setRowDone(r.el, d.phase === 'failed' ? 'warn' : 'done', d.duration_ms);
    }
  }
}

function closeOpenTools() {
  for (const r of S.toolRows) if (r.open) { r.open = false; setRowDone(r.el); }
}

let thinkBuf = '';
function think(text) {
  if (!text) return;
  thinkBuf = (thinkBuf + text).slice(-220);
  $('#thinking').hidden = false;
  $('#thinking-text').textContent = thinkBuf.replace(/\s+/g, ' ').trim();
}

/* ---------- dealers ---------- */
function dealerState(d) {
  const card = $(`.dealer-card[data-dealer="${d.dealer_id}"]`);
  if (!card) return;
  const st = $('[data-state]', card);
  card.classList.remove('visiting');
  st.classList.remove('visiting');
  if (d.state === 'queued') st.textContent = 'Queued for audit';
  if (d.state === 'visiting') {
    card.classList.add('visiting');
    st.classList.add('visiting');
    st.innerHTML = '<span class="spinner"></span>Agent is reading the inventory page…';
  }
  if (d.state === 'read') st.innerHTML = `<span class="ok" style="color:var(--ok)">${ICONS.check}</span>Inventory read`;
  if (d.state === 'matching') st.innerHTML = '<span class="spinner"></span>Matching serials…';
  if (d.state === 'done') {
    const c = d.counts;
    st.innerHTML = `<div class="chips"><span class="chip ok">✓ ${c.VERIFIED} verified</span>${c.SOLD_OUT_OF_TRUST ? `<span class="chip bad">${c.SOLD_OUT_OF_TRUST} sold</span>` : ''}${c.NOT_FOUND ? `<span class="chip warn">${c.NOT_FOUND} missing</span>` : ''}${c.SALE_PENDING ? `<span class="chip watch">${c.SALE_PENDING} pending</span>` : ''}</div>`;
    const risk = c.SOLD_OUT_OF_TRUST ? 'high' : c.NOT_FOUND || c.SALE_PENDING ? 'medium' : 'low';
    card.classList.add(`risk-${risk}`);
    const badge = $('[data-risk]', card);
    badge.className = `risk ${risk}`;
    badge.textContent = { high: 'High risk', medium: 'Review', low: 'Clean' }[risk];
  }
}

/* ---------- units, findings, KPIs ---------- */
const PILL_TEXT = { VERIFIED: 'Verified', SOLD_OUT_OF_TRUST: 'Sold out of trust', NOT_FOUND: 'Not found', SALE_PENDING: 'Sale pending', PENDING: 'Pending' };

function onUnit(d) {
  const u = S.units[d.unit_id];
  S.counts[d.status]++;
  S.amounts[d.status] += u.advance;
  const row = $(`#row-${d.unit_id}`);
  if (row) {
    const pill = $('[data-pill]', row);
    pill.className = `pill ${d.status}`;
    pill.textContent = PILL_TEXT[d.status];
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }
  const done = Object.values(S.counts).reduce((a, b) => a + b, 0);
  setKpi('verified', `${S.counts.VERIFIED}<span style="color:var(--muted-2);font-weight:600;font-size:18px"> / ${S.pf.units.length}</span>`, true);
  $('#verified-bar').style.width = `${(100 * S.counts.VERIFIED) / S.pf.units.length}%`;
  $('#kpi-verified-sub').textContent = `${fmtMoney(S.amounts.VERIFIED)} confirmed · ${done}/${S.pf.units.length} checked`;
}

function onFinding(f) {
  S.findings.push(f);
  $('#findings-empty')?.remove();
  const el = document.createElement('div');
  el.className = `finding ${f.severity}`;
  el.dataset.type = f.type;
  el.dataset.unit = f.unit_id;
  const thumb = f.evidence?.screenshot && f.type !== 'COLLATERAL_SHORTFALL' ? `<div class="f-thumb" style="background-image:url('${esc(f.evidence.screenshot)}')"></div>` : '';
  el.innerHTML = `<div><div class="f-type">${esc(f.title)}</div><div class="f-unit">${esc(unitName(f.unit))}</div><div class="f-meta">${esc(f.dealer.name)} · <span class="mono">${esc(f.unit.serial)}</span></div></div><div class="f-right"><div class="f-amount">${fmtFull(f.amount)}</div>${thumb}</div>`;
  el.addEventListener('click', () => openDrawer(f));
  const list = $('#findings-list');
  const order = { critical: 0, high: 1, watch: 2 };
  const after = $$('.finding', list).find((x) => order[x.className.split(' ')[1]] > order[f.severity]);
  if (after) list.insertBefore(el, after);
  else list.appendChild(el);
  $('#findings-count').textContent = `${S.findings.length} flagged`;

  if (f.type === 'SOLD_OUT_OF_TRUST') {
    setKpi('soot', fmtMoney(S.amounts.SOLD_OUT_OF_TRUST), true);
    $('#kpi-soot-sub').textContent = `${S.counts.SOLD_OUT_OF_TRUST} unit${S.counts.SOLD_OUT_OF_TRUST > 1 ? 's' : ''} sold, advance unpaid`;
    $('#kpi-soot').classList.add('hot');
    flash('#kpi-soot');
  }
  if (f.type === 'NOT_FOUND') {
    setKpi('notfound', fmtMoney(S.amounts.NOT_FOUND), true);
    $('#kpi-notfound-sub').textContent = `${S.counts.NOT_FOUND} unit${S.counts.NOT_FOUND > 1 ? 's' : ''} · spot check needed`;
    $('#kpi-notfound').classList.add('hot');
    flash('#kpi-notfound');
  }
}

function onValuation(v) {
  for (const x of v.units) {
    S.valuation[x.unit_id] = x;
    const row = $(`#row-${x.unit_id}`);
    if (!row) continue;
    $('[data-mv]', row).textContent = fmtFull(x.market_value);
    const ltv = $('[data-ltv]', row);
    ltv.textContent = `${Math.round(x.ltv * 100)}%`;
    ltv.className = 'num' + (x.ltv > 1 ? ' ltv-high' : '');
  }
  if (v.coverage) {
    setKpi('coverage', `${Math.round(v.coverage * 100)}%`, true);
    $('#kpi-coverage').classList.toggle('good', v.coverage >= 1);
    $('#kpi-coverage-sub').textContent = `${fmtMoney(v.market_value_total)} market vs ${fmtMoney(v.advances_valued)} · ${v.live_comps_units ? `${v.live_comps_units} live Monid comps` : 'comps'}`;
  }
}

function onSummary(s) {
  S.summary = s;
  if (!s.soot_count) setKpi('soot', '$0');
  if (!s.notfound_count) setKpi('notfound', '$0');
  const time = s.agent_duration_ms ? fmtDur(s.agent_duration_ms) : '—';
  setKpi('time', time, true);
  const cost = s.agent_cost_usd ? `$${Number(s.agent_cost_usd).toFixed(2)} agent cost` : `${s.agent_tool_calls} agent tool calls`;
  $('#kpi-run-sub').textContent = `${cost}${s.replay_of ? ' · replayed' : ''}`;
  $('#agent-elapsed').textContent = s.agent_duration_ms ? fmtClock(s.agent_duration_ms) : $('#agent-elapsed').textContent;
  $('#btn-memo').disabled = false;
  const dealersWithSoot = s.dealers.filter((d) => d.counts.SOLD_OUT_OF_TRUST);
  $('#btn-demands').disabled = !dealersWithSoot.length;
  $('#demands-text').textContent = dealersWithSoot.length ? `Payoff demands (${dealersWithSoot.length})` : 'Payoff demands';
}

function setKpi(name, html, animate) {
  const el = $(`[data-kpi="${name}"]`);
  if (!el) return;
  el.innerHTML = html;
  if (animate) {
    el.style.transition = 'none';
    el.style.transform = 'scale(1.04)';
    requestAnimationFrame(() => {
      el.style.transition = 'transform .35s ease';
      el.style.transform = 'none';
    });
  }
}

function flash(sel) {
  const el = $(sel);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ---------- evidence drawer ---------- */
function openDrawer(f) {
  const u = f.unit;
  const L = f.evidence?.listing;
  const v = f.evidence?.valuation || S.valuation[f.unit_id];
  $('#drawer-sev').className = `sev ${f.severity}`;
  $('#drawer-sev').textContent = f.title;
  $('#drawer-title').textContent = unitName(u);
  $('#drawer-sub').innerHTML = `${esc(f.dealer.name)} · <span class="mono">${esc(u.serial)}</span> · advance ${fmtFull(u.advance)}`;
  let html = '';
  if (f.type !== 'COLLATERAL_SHORTFALL') {
    const url = f.evidence?.url || '';
    const displayUrl = url.startsWith('/') ? `${location.host}${url}` : url.replace(/^https?:\/\//, '');
    html += `<div class="browser"><div class="browser-bar"><div class="browser-dots"><i></i><i></i><i></i></div><div class="browser-url">${esc(displayUrl)}</div></div><img src="${esc(f.evidence.screenshot)}" alt="Listing capture" /></div>`;
    html += `<div class="capture-meta"><span>${f.type === 'NOT_FOUND' ? 'Inventory page at audit time · serial not present' : 'Listing as published at audit time'}</span><span>${esc(f.evidence.captured_by || '')} · ${new Date(f.evidence.captured_at).toLocaleString()}</span></div>`;
  }
  html += `<div class="callout ${f.severity}">${esc(f.detail)}</div>`;
  const yes = '<td class="mark yes">✓</td>';
  const no = '<td class="mark no">✗</td>';
  if (f.type === 'COLLATERAL_SHORTFALL') {
    html += `<table class="cmp"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>
      <tr><td>Advance</td><td>${fmtFull(u.advance)}</td></tr>
      <tr><td>Market value</td><td>${fmtFull(v?.market_value)}</td></tr>
      <tr><td>Loan-to-value</td><td class="ltv-high">${v ? Math.round(v.ltv * 100) + '%' : '—'}</td></tr>
      <tr><td>Source</td><td>${v?.source === 'monid' ? `Monid · ${esc(v.provider || '')} · ${v.comps_count} comps` : 'Market estimate'}</td></tr></tbody></table>`;
    if (v?.sample?.length) html += `<div class="comps">${v.sample.map((c) => `<div><span>${esc(c.title)}</span><b>${fmtFull(c.price_usd)}</b></div>`).join('')}</div>`;
  } else {
    html += `<table class="cmp"><thead><tr><th>Field</th><th>Ledger (${esc(S.pf.lender.name.split(' ')[0])})</th><th>Dealer site</th><th></th></tr></thead><tbody>
      <tr><td>Serial / PIN</td><td class="mono">${esc(u.serial)}</td><td class="mono">${L ? esc(L.serial) : '— not listed —'}</td>${L ? yes : no}</tr>
      <tr><td>Equipment</td><td>${esc(unitName(u))}</td><td>${L ? esc(`${L.year ?? ''} ${L.make ?? ''} ${L.model ?? ''}`) : '—'}</td>${L ? yes : no}</tr>
      <tr><td>Status</td><td>Floored · advance outstanding</td><td><b>${L ? esc(L.status.replace('_', ' ')) : 'Missing'}</b></td>${no}</tr>
      <tr><td>Advance / price</td><td>${fmtFull(u.advance)}</td><td>${L?.price ? fmtFull(L.price) : '—'}</td><td></td></tr>
      <tr><td>Financed on</td><td>${esc(u.financed_on)}</td><td>—</td><td></td></tr></tbody></table>`;
  }
  if (f.market && f.type !== 'COLLATERAL_SHORTFALL') {
    const m = f.market;
    const gap = u.advance - m.market_value;
    html += `<div class="recovery"><div class="recovery-head"><div><div class="recovery-title">Recovery value · live market comps</div><div class="recovery-sub">Monid · ${esc(m.provider || 'marketplace scrape')} · ${m.comps_count} comparable listings</div></div><div class="recovery-figs"><div><b>${fmtFull(m.market_value)}</b><span>median comp</span></div><div><b class="${gap > 0 ? 'neg' : ''}">${gap > 0 ? '−' + fmtFull(gap) : fmtFull(-gap)}</b><span>${gap > 0 ? 'shortfall vs advance' : 'cushion vs advance'}</span></div></div></div>`;
    html += `<div class="comps">${(m.sample || []).map((c) => `<div><span>${esc(c.title)}</span><b>${fmtFull(c.price_usd)}</b></div>`).join('')}</div></div>`;
  }
  html += '<div class="drawer-actions">';
  if (f.type === 'SOLD_OUT_OF_TRUST') html += `<button class="btn primary" id="drawer-demand">${ICONS.file}Draft payoff demand</button>`;
  if (f.type === 'NOT_FOUND') html += `<button class="btn primary" id="drawer-spot">${ICONS.search}Request spot check</button>`;
  if (f.type === 'SALE_PENDING') html += `<button class="btn primary" id="drawer-remind">${ICONS.check}Track payoff</button>`;
  if (f.evidence?.url) html += `<a class="btn ghost" href="${esc(f.evidence.url)}" target="_blank" rel="noopener">${ICONS.ext}Open listing</a>`;
  html += '</div>';
  $('#drawer-body').innerHTML = html;
  $('#drawer-demand')?.addEventListener('click', () => openDemands(f.dealer_id));
  $('#drawer-spot')?.addEventListener('click', () => toast(`Spot check requested for ${u.serial} at ${f.dealer.name}`, true));
  $('#drawer-remind')?.addEventListener('click', () => toast(`Payoff tracked · we'll re-check ${f.dealer.name} nightly`, true));
  $('#scrim').hidden = false;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}

/* ---------- memo, demands, schedule, history ---------- */
function openModal(title, html, model) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-model').textContent = model || '';
  $('#modal-model').hidden = !model;
  $('#modal').hidden = false;
}

async function openMemo() {
  openModal('Credit memo', '<div class="muted">Drafting memo…</div>');
  const r = await fetch(`/api/runs/${S.run.id}/memo`, { method: 'POST' }).then((x) => x.json());
  openModal('Credit memo', md(r.markdown || ''), r.model === 'template' ? '' : `OpenAI · ${r.model}`);
}

async function openDemands(dealerId) {
  closeDrawer();
  const ids = typeof dealerId === 'string' ? [dealerId] : S.summary.dealers.filter((d) => d.counts.SOLD_OUT_OF_TRUST).map((d) => d.id);
  openModal('Payoff demands', '<div class="muted">Drafting payoff demands…</div>');
  const letters = await Promise.all(ids.map((id) => fetch(`/api/runs/${S.run.id}/demand/${id}`, { method: 'POST' }).then((x) => x.json())));
  const html = letters
    .map((l) => `<div class="email" style="margin-bottom:16px"><div class="email-row"><b>To</b><span>${esc(l.to)}</span></div><div class="email-row"><b>Subject</b><span><strong>${esc(l.subject)}</strong></span></div><div class="email-body">${esc(l.body)}</div></div>`)
    .join('');
  const model = letters[0]?.model;
  openModal(ids.length > 1 ? `Payoff demands (${ids.length})` : 'Payoff demand', html, model === 'template' ? '' : `OpenAI · ${model}`);
}

async function schedule() {
  const btn = $('#btn-schedule');
  btn.disabled = true;
  try {
    const r = await fetch('/api/schedule', { method: 'POST' }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    const next = r.cron?.next_run ? new Date(r.cron.next_run * 1000) : null;
    btn.classList.add('done');
    $('#schedule-text').textContent = 'Nightly · 2:00 AM';
    toast(`Scheduled on Agent37${r.demo ? ' (demo)' : ` · cron ${r.cron.id}`} · next run ${next ? next.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'tonight'}`, true);
  } catch (e) {
    toast(`Could not schedule: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function loadHistory() {
  const r = await fetch('/api/runs').then((x) => x.json());
  const rows = r.data || [];
  $('#history').innerHTML = rows.length
    ? rows
        .map((x) => {
          const s = x.summary || {};
          return `<div class="hist-row"><span class="hist-id">${esc(x.id)}</span><span>${new Date(x.started_at).toLocaleString()} · ${esc(x.mode)}<br/><span class="muted">${s.verified_count ?? '—'} verified · ${s.soot_count ?? 0} sold out of trust · ${s.notfound_count ?? 0} not found</span></span><span class="pill ${s.soot_count ? 'SOLD_OUT_OF_TRUST' : 'VERIFIED'}">${s.soot_count ? fmtMoney(s.soot_amount) + ' at risk' : 'Clean'}</span></div>`;
        })
        .join('')
    : '<div class="empty small"><div class="empty-text">No audits recorded yet.</div></div>';
}

let toastTimer;
function toast(msg, ok) {
  const t = $('#toast');
  t.innerHTML = `${ok ? ICONS.check : ''}<span>${esc(msg)}</span>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}

// Tiny markdown renderer (headings, bold, lists, tables, code).
function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  let out = '';
  let i = 0;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out += '<table>' + body.map((r, k) => `<tr>${cells(r).map((c) => (k ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join('')}</tr>`).join('') + '</table>';
      continue;
    }
    if (/^#{1,6}\s/.test(l)) out += `<h3>${inline(l.replace(/^#+\s*/, ''))}</h3>`;
    else if (/^\s*[-*]\s+/.test(l)) {
      out += '<ul>';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) out += `<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''))}</li>`;
      out += '</ul>';
      continue;
    } else if (/^\s*\d+\.\s+/.test(l)) {
      out += '<ol>';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) out += `<li>${inline(lines[i++].replace(/^\s*\d+\.\s+/, ''))}</li>`;
      out += '</ol>';
      continue;
    } else if (l.trim()) out += `<p>${inline(l)}</p>`;
    i++;
  }
  return out;
}

window.__fc = { startRun, openDrawer, openMemo, openDemands, schedule, showTab, S };
init();
