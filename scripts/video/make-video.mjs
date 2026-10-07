#!/usr/bin/env node
/**
 * make-video.mjs - FloorCheck narrated demo-video pipeline (ElevenLabs TTS + Playwright screencast + ffmpeg).
 *
 * Usage (from the repo root):
 *   node scripts/video/make-video.mjs [--script video/script.json] [--dry-run] [--serve public]
 *                                     [--only intro,run] [--out video/out/x.mp4] [--keep-frames]
 *   --script <path>  script JSON (default video/script.json)
 *   --dry-run        no ElevenLabs call / no key: silent narration, duration = words / 2.6 s
 *   --serve <dir>    start a tiny static server for <dir> on the baseUrl port (test without the app)
 *   --only <ids>     comma-separated segment ids (quick preview -> floorcheck-demo-preview.mp4)
 *   --out <path>     output mp4 (default video/out/floorcheck-demo.mp4; captions go next to it)
 *   --keep-frames    keep video/work/frames/*.jpg after encoding
 * Env: ELEVENLABS_API_KEY (env var or ./.env), optional ELEVENLABS_VOICE_ID (overrides voice choice).
 *
 * Script schema (JSON):
 * {
 *   "baseUrl": "http://localhost:8080",            // relative goto URLs resolve against it
 *   "viewport": {"width":1920,"height":1080},       // output is always 1920x1080 (scaled/padded)
 *   "fps": 30,                                       // output frame rate
 *   "cursor": {"x":1540,"y":880,"visible":true},    // initial fake-cursor state (optional)
 *   "voice": {"id":"<optional voice_id>", "preferNames":["Jessica","Laura","Sarah","Aria","Lily"],
 *             "model":"eleven_multilingual_v2", "stability":0.45, "similarity_boost":0.8,
 *             "style":0.25, "speed":1.0},
 *   "setup": [ ...actions ],                         // optional, runs before t=0 (not recorded)
 *   "segments": [
 *     {"id":"intro", "text":"Narration for this segment ('' = no narration)",
 *      "actions":[ ...actions ], "padAfterMs":350}
 *   ]
 * }
 * Timing: a segment starts, its narration starts at the same instant, its actions run in order, then
 * the recorder holds until start + narration + padAfterMs (default 350). Slow actions just make the
 * segment longer (silence after the narration). t=0 of the video is the first segment's start.
 *
 * Actions. Every action also accepts "atMs": N (don't start before N ms into the segment, to sync a
 * click with a word). A failing action only logs a warning; the recording always continues.
 *   {"type":"goto",     "url":"/video/intro.html", "waitUntil":"load"|"domcontentloaded"|"networkidle"}
 *   {"type":"click",    "selector":"#run-audit", "moveMs":700}   cursor glides to center, ripple, click
 *   {"type":"hover",    "selector":".row", "moveMs":700}         cursor glide + real mouse hover
 *   {"type":"move",     "selector":"css"} | {"type":"move","x":960,"y":540,"moveMs":700}  cursor only
 *   {"type":"wait",     "ms":1000}
 *   {"type":"waitFor",  "selector":"[data-run-state=complete]", "timeout":90000,
 *                       "state":"visible"|"attached"|"hidden"|"detached"}
 *   {"type":"scrollTo", "selector":"#results", "block":"start"|"center"|"end"} | {"type":"scrollTo","y":0}
 *   {"type":"scrollBy", "y":600, "ms":900, "selector":"<optional scroll container>"}
 *   {"type":"eval",     "js":"document.body.classList.add('demo')"}   (expression; promises awaited)
 *   {"type":"type",     "selector":"#search", "text":"CAT 259D3", "delay":45, "clear":true}
 *   {"type":"press",    "key":"Enter"}
 *   {"type":"cursor",   "visible":false} | {"type":"cursor","x":100,"y":100}   show/hide/jump
 *   click/hover/move/type/waitFor also take "timeout" (ms, default 10000 / 30000 for waitFor),
 *   and click/hover/move take "offsetX"/"offsetY" (px from the element center).
 *
 * Outputs: video/out/floorcheck-demo.mp4 (H.264 30fps 1920x1080 + AAC 192k) and video/out/captions.srt.
 * Cache:   video/work/tts/<sha1(text+voiceId+model+settings)>.mp3, so reruns don't re-bill ElevenLabs.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK = path.join(ROOT, 'video', 'work');
const OUT_DIR = path.join(ROOT, 'video', 'out');
const FFMPEG = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : 'ffprobe';
const FALLBACK_VOICE = { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica (built-in fallback id)' };
const DEFAULT_PREFS = ['Jessica', 'Laura', 'Sarah', 'Aria', 'Lily'];
const OUT_W = 1920, OUT_H = 1080;

const log = (...a) => console.log('[video]', ...a);
const warn = (...a) => console.warn('[video] WARN', ...a);
const die = (msg) => { console.error('[video] ERROR', msg); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => Date.now() / 1000;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || String(s);

// ---------------------------------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = { script: 'video/script.json', dryRun: false, serve: null, only: null, out: null, keepFrames: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v;
    if (a.startsWith('--') && a.includes('=')) [a, v] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    const val = () => { if (v !== undefined) return v; const n = argv[++i]; if (n === undefined) die(`${a} needs a value`); return n; };
    if (a === '--script') o.script = val();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--serve') o.serve = val();
    else if (a === '--only') o.only = val();
    else if (a === '--out') o.out = val();
    else if (a === '--keep-frames') o.keepFrames = true;
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else die(`unknown argument: ${a}`);
  }
  return o;
}

function resolveInput(p) {
  const cands = [path.resolve(p), path.resolve(ROOT, p)];
  return cands.find((c) => fs.existsSync(c)) || die(`file not found: ${p}`);
}

function loadDotEnv() {
  for (const f of new Set([path.join(ROOT, '.env'), path.resolve('.env')])) {
    if (!fs.existsSync(f)) continue;
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = raw.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

// --------------------------------------------------------------------------------------- utilities
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 400000) err = err.slice(-200000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} exited with ${code}:\n${err.slice(-4000)}`))));
  });
}

async function probeDuration(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe: no duration for ${file}`);
  return d;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const fetchT = (url, init = {}, ms = 30000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

// --------------------------------------------------------------------------------------------- TTS
async function pickVoice(vc, key) {
  const override = process.env.ELEVENLABS_VOICE_ID || vc.id;
  if (override) return { voice_id: override, name: vc.name || 'override (voice.id / ELEVENLABS_VOICE_ID)' };
  let voices;
  try {
    const r = await fetchT('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } }, 20000);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${firstLine((await r.text()).slice(0, 200))}`);
    voices = (await r.json()).voices || [];
  } catch (e) {
    warn(`could not list voices (${e.message}); using fallback voice id`);
    return FALLBACK_VOICE;
  }
  for (const pref of vc.preferNames || DEFAULT_PREFS) {
    const v = voices.find((x) => (x.name || '').toLowerCase().startsWith(String(pref).toLowerCase()));
    if (v) return v;
  }
  const lab = (x) => x.labels || {};
  return voices.find((x) => /^female$/i.test(lab(x).gender || '') && /young/i.test(lab(x).age || ''))
    || voices.find((x) => /^female$/i.test(lab(x).gender || '')) || FALLBACK_VOICE;
}

function voiceSettings(vc) {
  return {
    stability: vc.stability ?? 0.45,
    similarity_boost: vc.similarity_boost ?? 0.8,
    style: vc.style ?? 0.25,
    use_speaker_boost: true,
    speed: vc.speed ?? 1.0,
  };
}

async function ttsSegment(text, voice, vc, key) {
  const model = vc.model || 'eleven_multilingual_v2';
  const settings = voiceSettings(vc);
  const file = path.join(WORK, 'tts', `${sha1(JSON.stringify([text, voice.voice_id, model, settings]))}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return { file, cached: true };
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=mp3_44100_128`;
  const body = JSON.stringify({ text, model_id: model, voice_settings: settings });
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetchT(url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body }, 120000);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 1000) throw new Error(`suspiciously small audio (${buf.length} bytes)`);
        await fsp.writeFile(`${file}.tmp`, buf);
        await fsp.rename(`${file}.tmp`, file);
        return { file, cached: false };
      }
      const msg = `ElevenLabs HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`;
      if (r.status !== 429 && r.status < 500) throw Object.assign(new Error(msg), { fatal: true });
      lastErr = new Error(msg);
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
    }
    warn(`TTS attempt ${attempt} failed (${firstLine(lastErr.message)}); retrying`);
    await sleep(1500 * attempt * attempt);
  }
  throw lastErr;
}

async function silentClip(seconds) {
  const file = path.join(WORK, 'tts', `dry-${seconds.toFixed(2)}.mp3`);
  if (!fs.existsSync(file)) {
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', seconds.toFixed(2), '-c:a', 'libmp3lame', '-b:a', '128k', file]);
  }
  return file;
}

// ------------------------------------------------------------------------------ static test server
function startStaticServer(dir, port) {
  const root = path.resolve(dir);
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  };
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let f = path.join(root, rel);
      if (f !== root && !f.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      let st = await fsp.stat(f).catch(() => null);
      if (st?.isDirectory()) { f = path.join(f, 'index.html'); st = await fsp.stat(f).catch(() => null); }
      if (!st?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(f).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(f).pipe(res);
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// --------------------------------------------------------------------- in-page cursor + keep-alive
// Runs in every page (context.addInitScript) before page scripts. Exposes window.__cursor.
function cursorInit(init) {
  if (window.top !== window || window.__cursor) return;
  const KEY = '__fc_cursor_state';
  const TIP = 3.1; // px offset of the arrow tip inside the 30px-wide svg box (1.5 units * 30/14.5)
  const st = { x: init.x, y: init.y, visible: init.visible !== false };
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && typeof s.x === 'number') Object.assign(st, s); } catch (e) { /* opaque origin */ }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } };

  const host = document.createElement('fc-cursor-layer');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .c{position:absolute;left:0;top:0;width:30px;height:44.5px;will-change:transform;pointer-events:none;
       filter:drop-shadow(0 3px 5px rgba(0,0,0,.38)) drop-shadow(0 0 1px rgba(0,0,0,.35));transition:opacity .25s ease}
    .c svg{display:block;width:100%;height:100%;transform-origin:${TIP}px ${TIP}px;transition:transform .12s ease}
    .c.down svg{transform:scale(.84)}
    .r{position:absolute;left:0;top:0;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;box-sizing:border-box;
       border:4px solid rgba(125,147,255,.98);background:rgba(61,90,254,.30);box-shadow:0 0 18px rgba(61,90,254,.6);opacity:0;pointer-events:none}
  </style>
  <div class="r-layer"></div>
  <div class="c"><svg viewBox="-1.5 -1.5 14.5 21.5" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 0 L0 16 L3.9 12.4 L6.4 18.2 L8.6 17.3 L6.1 11.6 L11.4 11.6 Z" fill="#fff" stroke="#0B1220"
          stroke-width="1.15" stroke-linejoin="round"/></svg></div>`;
  const cur = shadow.querySelector('.c');
  const ripples = shadow.querySelector('.r-layer');
  const render = () => {
    cur.style.transform = `translate(${st.x - TIP}px, ${st.y - TIP}px)`;
    cur.style.opacity = st.visible ? '1' : '0';
  };
  render();

  // keep-alive pixel: screencast only emits frames on change, so flip an invisible pixel every 500ms
  const ka = document.createElement('fc-keepalive');
  ka.style.cssText = 'all:initial;position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none;z-index:2147483646;background:#808080;opacity:.02;';
  const mount = () => {
    const parent = document.documentElement;
    if (!parent) return;
    if (!host.isConnected) parent.appendChild(host);
    if (!ka.isConnected) parent.appendChild(ka);
  };
  mount();
  document.addEventListener('DOMContentLoaded', mount);
  let flip = false;
  setInterval(() => { flip = !flip; ka.style.opacity = flip ? '.04' : '.02'; mount(); }, 500);

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let active = null;
  window.__cursor = {
    moveTo(x, y, ms = 700) {
      if (active) active();
      const x0 = st.x, y0 = st.y, dx = x - x0, dy = y - y0, dist = Math.hypot(dx, dy);
      if (dist < 0.5 || ms <= 0) { st.x = x; st.y = y; render(); save(); return Promise.resolve(); }
      const bend = Math.min(70, dist * 0.1); // gentle arc, like a hand on a mouse
      const cx = x0 + dx / 2 + (dy / dist) * bend, cy = y0 + dy / 2 - (dx / dist) * bend;
      return new Promise((resolve) => {
        const t0 = performance.now();
        let done = false;
        const finish = () => { if (done) return; done = true; active = null; st.x = x; st.y = y; render(); save(); resolve(); };
        active = finish;
        const step = () => {
          if (done) return;
          const p = Math.min(1, Math.max(0, (performance.now() - t0) / ms)), e = ease(p), u = 1 - e;
          st.x = u * u * x0 + 2 * u * e * cx + e * e * x;
          st.y = u * u * y0 + 2 * u * e * cy + e * e * y;
          render();
          if (p < 1) requestAnimationFrame(step); else finish();
        };
        requestAnimationFrame(step);
        setTimeout(finish, ms + 400); // safety net if rAF is throttled
      });
    },
    click() {
      cur.classList.add('down');
      const r = document.createElement('div');
      r.className = 'r';
      ripples.appendChild(r);
      const tr = `translate(${st.x}px, ${st.y}px)`;
      const anim = r.animate([{ transform: `${tr} scale(.3)`, opacity: 1 }, { transform: `${tr} scale(1)`, opacity: .85, offset: .45 }, { transform: `${tr} scale(1.45)`, opacity: 0 }],
        { duration: 700, easing: "cubic-bezier(.2,.6,.35,1)", fill: "forwards" });
      anim.onfinish = () => r.remove();
      setTimeout(() => cur.classList.remove('down'), 180);
      return new Promise((res) => setTimeout(res, 110));
    },
    set(x, y) { st.x = x; st.y = y; render(); save(); },
    show(v = true) { st.visible = !!v; render(); save(); },
    get() { return { ...st }; },
  };
}

// --------------------------------------------------------------------------------------- actions
async function cursorMove(page, x, y, ms) {
  await page.evaluate(([x, y, ms]) => (window.__cursor ? window.__cursor.moveTo(x, y, ms) : null), [x, y, ms]);
}

async function waitScrollSettled(page, maxMs = 3000) {
  await page.evaluate((maxMs) => new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const on = () => { last = performance.now(); };
    document.addEventListener('scroll', on, { capture: true, passive: true });
    const tick = () => {
      const t = performance.now();
      if (t - last > 200 || t - start > maxMs) { document.removeEventListener('scroll', on, { capture: true }); resolve(); } else setTimeout(tick, 50);
    };
    setTimeout(tick, 120);
  }), maxMs);
}

async function animateScroll(page, { by, to, ms = 900, selector = null }) {
  await page.evaluate(({ by, to, ms, selector }) => new Promise((resolve) => {
    const el = selector ? document.querySelector(selector) : (document.scrollingElement || document.documentElement);
    if (!el) { resolve(false); return; }
    const from = el.scrollTop;
    const target = Math.max(0, Math.min(to != null ? to : from + by, el.scrollHeight - el.clientHeight));
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      el.scrollTop = from + (target - from) * ease(p);
      if (p < 1) requestAnimationFrame(step); else { el.style.scrollBehavior = prev; resolve(true); }
    };
    requestAnimationFrame(step);
  }), { by: by ?? 0, to: to ?? null, ms, selector });
}

async function targetPoint(page, a) {
  if (!a.selector) throw new Error('missing "selector"');
  const loc = page.locator(a.selector).first();
  await loc.waitFor({ state: 'visible', timeout: a.timeout ?? 10000 });
  const inView = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  });
  if (!inView) {
    await loc.evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' }), a.block || 'center');
    await waitScrollSettled(page);
  }
  const center = async () => {
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no bounding box for ${a.selector}`);
    return { x: Math.round(b.x + b.width / 2 + (a.offsetX || 0)), y: Math.round(b.y + b.height / 2 + (a.offsetY || 0)) };
  };
  return { loc, center, ...(await center()) };
}

async function pointerAction(page, a, { click }) {
  const t = await targetPoint(page, a);
  let { x, y } = t;
  await cursorMove(page, x, y, a.moveMs ?? 700);
  const again = await t.center().catch(() => null); // element moved during the glide? follow it
  if (again && Math.hypot(again.x - x, again.y - y) > 3) { ({ x, y } = again); await cursorMove(page, x, y, 160); }
  await page.mouse.move(x, y);
  if (!click) return;
  await sleep(a.preClickMs ?? 80);
  await page.evaluate(() => (window.__cursor ? window.__cursor.click() : null));
  await page.mouse.click(x, y, { delay: 40 });
}

async function runAction(page, a, ctx) {
  switch (a.type) {
    case 'goto':
      await page.goto(new URL(a.url, ctx.baseUrl).href, { waitUntil: a.waitUntil || 'load', timeout: a.timeout ?? 45000 });
      break;
    case 'click':
      await pointerAction(page, a, { click: true });
      break;
    case 'hover':
      await pointerAction(page, a, { click: false });
      break;
    case 'move': {
      if (a.selector) { const t = await targetPoint(page, a); await cursorMove(page, t.x, t.y, a.moveMs ?? 700); } else await cursorMove(page, a.x ?? 960, a.y ?? 540, a.moveMs ?? 700);
      break;
    }
    case 'wait':
      await sleep(a.ms ?? 1000);
      break;
    case 'waitFor':
      await page.locator(a.selector).first().waitFor({ state: a.state || 'visible', timeout: a.timeout ?? 30000 });
      break;
    case 'scrollTo':
      if (a.selector) {
        await page.locator(a.selector).first().evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' }), a.block || 'start');
        await waitScrollSettled(page);
      } else await animateScroll(page, { to: a.y ?? 0, ms: a.ms ?? 900, selector: a.container || null });
      break;
    case 'scrollBy':
      await animateScroll(page, { by: a.y ?? 600, ms: a.ms ?? 900, selector: a.selector || null });
      break;
    case 'eval':
      await page.evaluate(a.js);
      break;
    case 'type':
      if (a.selector) await pointerAction(page, a, { click: true });
      if (a.clear) { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); }
      await page.keyboard.type(String(a.text ?? ''), { delay: a.delay ?? 45 });
      break;
    case 'press':
      await page.keyboard.press(a.key);
      break;
    case 'cursor':
      if (a.visible !== undefined) await page.evaluate((v) => window.__cursor && window.__cursor.show(v), !!a.visible);
      if (a.x !== undefined && a.y !== undefined) await cursorMove(page, a.x, a.y, a.moveMs ?? 0);
      break;
    default:
      throw new Error(`unknown action type "${a.type}"`);
  }
}

async function safeAction(page, a, ctx, label) {
  try {
    if (a.atMs != null && ctx.segStartMs) await sleep(ctx.segStartMs + a.atMs - Date.now());
    if (ctx.segStartMs) log(`    +${((Date.now() - ctx.segStartMs) / 1000).toFixed(2)}s ${a.type} ${a.selector || a.url || a.key || (a.ms != null ? `${a.ms}ms` : '')}`);
    await runAction(page, a, ctx);
  } catch (e) {
    warn(`${label} ${a.type}${a.selector ? ` "${a.selector}"` : a.url ? ` ${a.url}` : ''} failed: ${firstLine(e.message)}`);
  }
}

// External GET assets (Google Fonts, CDNs) are fetched by Node (which knows the proxy/CA) and cached.
async function bridgeRoute(route) {
  const req = route.request();
  if (req.method() !== 'GET' || !['stylesheet', 'font', 'script', 'image'].includes(req.resourceType())) { await route.continue().catch(() => {}); return; }
  const ua = req.headers()['user-agent'] || 'Mozilla/5.0';
  const f = path.join(WORK, 'http-cache', sha1(`${req.url()}|${ua}`));
  try {
    let meta, body;
    if (fs.existsSync(`${f}.json`)) { meta = JSON.parse(fs.readFileSync(`${f}.json`, 'utf8')); body = fs.readFileSync(`${f}.bin`); } else {
      const r = await fetchT(req.url(), { headers: { 'user-agent': ua, accept: req.headers().accept || '*/*' } }, 8000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = Buffer.from(await r.arrayBuffer());
      meta = { ct: r.headers.get('content-type') || 'application/octet-stream' };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.bin`, body);
      fs.writeFileSync(`${f}.json`, JSON.stringify(meta));
    }
    await route.fulfill({ status: 200, headers: { 'content-type': meta.ct, 'access-control-allow-origin': '*' }, body });
  } catch (e) {
    await route.abort().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------- recording
async function record({ segs, script, baseUrl, vp }) {
  const framesDir = path.join(WORK, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
  try {
    const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, ...(script.colorScheme ? { colorScheme: script.colorScheme } : {}) });
    const cur0 = { x: script.cursor?.x ?? Math.round(vp.width * 0.8), y: script.cursor?.y ?? Math.round(vp.height * 0.82), visible: script.cursor?.visible !== false };
    await context.addInitScript(cursorInit, cur0);
    if (script.bridgeExternalAssets !== false) {
      await context.route((u) => /^https?:$/.test(u.protocol) && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname) && u.host !== new URL(baseUrl).host, bridgeRoute);
    }
    const page = await context.newPage();
    page.on('pageerror', (e) => warn('page error:', firstLine(e.message)));
    page.on('dialog', (d) => d.accept().catch(() => {}));
    page.on('requestfailed', (r) => {
      if (['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(r.resourceType())) warn(`request failed: ${r.url()} (${r.failure()?.errorText})`);
    });
    await page.setContent(`<html><body style="margin:0;background:${script.background || '#0B1220'}"></body></html>`);

    const ctx = { baseUrl, segStartMs: 0 };
    for (const [i, a] of (script.setup || []).entries()) await safeAction(page, a, ctx, `setup #${i + 1}`);

    const cdp = await context.newCDPSession(page);
    const frames = [];
    const writes = new Set();
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      const fr = { file: path.join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`), ts: typeof metadata?.timestamp === 'number' ? metadata.timestamp : now(), ok: true };
      frames.push(fr);
      const p = fsp.writeFile(fr.file, Buffer.from(data, 'base64')).catch(() => { fr.ok = false; }).finally(() => writes.delete(p));
      writes.add(p);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
    await sleep(600);

    let t0 = null;
    for (const seg of segs) {
      seg.start = now();
      if (t0 === null) t0 = seg.start;
      ctx.segStartMs = seg.start * 1000;
      log(`> ${seg.id} @ ${(seg.start - t0).toFixed(2)}s (narration ${seg.audioDur.toFixed(2)}s, ${seg.actions.length} actions)`);
      for (const [i, a] of seg.actions.entries()) await safeAction(page, a, ctx, `segment "${seg.id}" action #${i + 1}`);
      const target = seg.start + seg.audioDur + (seg.padAfterMs ?? 350) / 1000;
      if (now() > target + 0.05) log(`  "${seg.id}" actions ran ${(now() - target).toFixed(2)}s past its narration; segment extended`);
      await sleep((target - now()) * 1000);
      seg.end = now();
    }
    const tEnd = segs[segs.length - 1].end;
    await sleep(150);
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(100);
    await Promise.all([...writes]);
    const good = frames.filter((f) => f.ok);
    log(`captured ${good.length} frames over ${(tEnd - t0).toFixed(2)}s (~${(good.length / Math.max(0.001, tEnd - t0)).toFixed(1)} fps avg)`);
    return { frames: good, t0, tEnd };
  } finally {
    await browser.close().catch(() => {});
  }
}

// -------------------------------------------------------------------------------------- encoding
function writeConcat(frames, t0, tEnd, listFile) {
  frames.sort((a, b) => a.ts - b.ts);
  let i0 = 0;
  for (let i = 0; i < frames.length; i++) { if (frames[i].ts <= t0) i0 = i; else break; }
  const sel = [];
  for (let i = i0; i < frames.length && frames[i].ts < tEnd; i++) sel.push({ file: frames[i].file, t: Math.max(0, frames[i].ts - t0) });
  if (!sel.length) throw new Error('no frames were captured inside the recording window');
  sel[0].t = 0; // whatever was on screen at t=0 (or the first frame after it) covers the start
  const total = tEnd - t0;
  const lines = ['ffconcat version 1.0'];
  for (let k = 0; k < sel.length; k++) {
    const d = (k + 1 < sel.length ? sel[k + 1].t : total) - sel[k].t;
    if (d <= 0.0005) continue;
    lines.push(`file '${sel[k].file}'`, `duration ${d.toFixed(6)}`);
  }
  lines.push(`file '${sel[sel.length - 1].file}'`); // concat demuxer ignores the last duration unless repeated
  fs.writeFileSync(listFile, `${lines.join('\n')}\n`);
  return sel.length;
}

async function encode({ frames, t0, tEnd, segs, fps, outFile }) {
  const total = tEnd - t0;
  const listFile = path.join(WORK, 'frames.ffconcat');
  writeConcat(frames, t0, tEnd, listFile);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  const aud = segs.filter((s) => s.audioFile);
  for (const s of aud) args.push('-i', s.audioFile);
  let fc = `[0:v]fps=${fps},scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=0x0B1220,setsar=1,format=yuv420p[v]`;
  if (aud.length) {
    aud.forEach((s, k) => {
      const delay = Math.max(0, Math.round((s.start - t0) * 1000));
      fc += `;[${k + 1}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp,adelay=${delay}:all=1[a${k}]`;
    });
    const ins = aud.map((_, k) => `[a${k}]`).join('');
    fc += aud.length > 1
      ? `;${ins}amix=inputs=${aud.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=${total.toFixed(3)}[a]`
      : `;${ins}apad=whole_dur=${total.toFixed(3)}[a]`;
  } else {
    args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
    fc += ';[1:a]anull[a]';
  }
  args.push('-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-t', total.toFixed(3), outFile);
  await run(FFMPEG, args);
}

// -------------------------------------------------------------------------------------- captions
function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

function captionChunks(text, maxLen = 84) {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [];
  const out = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= maxLen) { out.push(s); continue; }
    const n = Math.ceil(s.length / maxLen), target = s.length / n;
    let cur = '';
    for (const w of s.split(' ')) {
      if (cur && cur.length + 1 + w.length > target && out.length < 1e6 && cur.length >= target * 0.6) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function wrapTwoLines(s, width = 42) {
  if (s.length <= width) return s;
  const mid = s.length / 2;
  let best = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best > 0 ? `${s.slice(0, best)}\n${s.slice(best + 1)}` : s;
}

function writeSrt(segs, t0, file) {
  const cues = [];
  for (const s of segs) {
    if (!s.text.trim() || !s.audioDur) continue;
    const chunks = captionChunks(s.text);
    const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = s.start - t0;
    for (const c of chunks) {
      const d = s.audioDur * (c.length / totalChars);
      cues.push({ a: t, b: t + d, text: wrapTwoLines(c) });
      t += d;
    }
  }
  fs.writeFileSync(file, cues.map((c, i) => `${i + 1}\n${srtTime(c.a)} --> ${srtTime(c.b)}\n${c.text}\n`).join('\n'));
  return cues.length;
}

// ------------------------------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadDotEnv();
  const scriptPath = resolveInput(opts.script);
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  let baseUrl = script.baseUrl || 'http://localhost:8080';
  const vp = { width: script.viewport?.width || 1920, height: script.viewport?.height || 1080 };
  const fps = script.fps || 30;
  let segs = (script.segments || []).map((s, i) => ({ ...s, id: s.id || `seg${i + 1}`, text: String(s.text || ''), actions: s.actions || [] }));
  if (opts.only) {
    const want = opts.only.split(',').map((x) => x.trim()).filter(Boolean);
    for (const w of want) if (!segs.some((s) => s.id === w)) warn(`--only: no segment with id "${w}"`);
    segs = segs.filter((s) => want.includes(s.id));
  }
  if (!segs.length) die('no segments to record');
  const outFile = path.resolve(opts.out || path.join(OUT_DIR, opts.only ? 'floorcheck-demo-preview.mp4' : 'floorcheck-demo.mp4'));
  const srtFile = opts.out ? outFile.replace(/\.[^./]+$/, '') + '.srt' : path.join(OUT_DIR, opts.only ? 'captions-preview.srt' : 'captions.srt');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.mkdirSync(path.join(WORK, 'tts'), { recursive: true });
  log(`script ${path.relative(ROOT, scriptPath)}: ${segs.length} segments${opts.dryRun ? ' (dry run)' : ''}`);

  // 1. narration
  if (opts.dryRun) {
    await mapLimit(segs, 4, async (s) => {
      const words = s.text.trim().split(/\s+/).filter(Boolean).length;
      if (words) s.audioFile = await silentClip(words / 2.6);
    });
  } else {
    const key = (process.env.ELEVENLABS_API_KEY || '').trim();
    if (!key) die('ELEVENLABS_API_KEY is not set (env var or .env in the repo root). Use --dry-run to test without it.');
    const vc = script.voice || {};
    const voice = await pickVoice(vc, key);
    log(`voice: ${voice.name} [${voice.voice_id}] model=${vc.model || 'eleven_multilingual_v2'} settings=${JSON.stringify(voiceSettings(vc))}`);
    let newChars = 0;
    await mapLimit(segs, 2, async (s) => {
      if (!s.text.trim()) return;
      const r = await ttsSegment(s.text.trim(), voice, vc, key);
      s.audioFile = r.file;
      if (!r.cached) newChars += s.text.length;
      log(`  tts ${s.id}: ${r.cached ? 'cached' : 'generated'}`);
    });
    log(`TTS ready (${newChars} new characters billed)`);
  }
  for (const s of segs) s.audioDur = s.audioFile ? await probeDuration(s.audioFile) : 0;
  const est = segs.reduce((n, s) => n + s.audioDur + (s.padAfterMs ?? 350) / 1000, 0);
  log(`narration total ${segs.reduce((n, s) => n + s.audioDur, 0).toFixed(1)}s, expected video >= ${est.toFixed(1)}s`);

  // 2. record
  let server = null;
  if (opts.serve) {
    const u = new URL(baseUrl);
    const port = Number(u.port || 80);
    try { server = await startStaticServer(opts.serve, port); } catch (e) {
      if (e.code !== 'EADDRINUSE') die(`--serve: cannot listen on port ${port} (${e.code || e.message})`);
      server = await startStaticServer(opts.serve, 0); // port busy (app running?): use a free port instead
      u.port = String(server.address().port);
      baseUrl = u.href.replace(/\/$/, '');
      warn(`port ${port} is busy; --serve is using ${baseUrl} for this run instead`);
    }
    log(`serving ${path.resolve(opts.serve)} at ${baseUrl}`);
  } else {
    try { await fetchT(baseUrl, { method: 'HEAD' }, 4000); } catch { warn(`${baseUrl} is not reachable; start the app or use --serve <dir>`); }
  }
  let rec;
  try { rec = await record({ segs, script, baseUrl, vp }); } finally { if (server) server.close(); }

  // 3+4. encode video + narration, captions
  log('encoding...');
  await encode({ frames: rec.frames, t0: rec.t0, tEnd: rec.tEnd, segs, fps, outFile });
  const cues = writeSrt(segs, rec.t0, srtFile);
  if (!opts.keepFrames) fs.rmSync(path.join(WORK, 'frames'), { recursive: true, force: true });

  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', outFile]);
  const info = JSON.parse(out);
  const dur = parseFloat(info.format.duration);
  console.log('\nsegment            start     narration  length');
  for (const s of segs) {
    console.log(`${s.id.padEnd(18).slice(0, 18)} ${(`${(s.start - rec.t0).toFixed(2)}s`).padStart(8)} ${(`${s.audioDur.toFixed(2)}s`).padStart(10)} ${(`${(s.end - s.start).toFixed(2)}s`).padStart(8)}`);
  }
  const streams = info.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}`).join(', ');
  console.log(`\n[video] wrote ${path.relative(process.cwd(), outFile)}: ${dur.toFixed(2)}s (${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}), ${streams}`);
  console.log(`[video] wrote ${path.relative(process.cwd(), srtFile)} (${cues} cues)`);
}

main().catch((e) => { console.error('[video] FAILED:', e?.stack || e); process.exit(1); });
