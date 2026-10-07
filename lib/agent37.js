// Agent37 Cloud: hosting API (instances, crons, ports) + the instance's own agent API (responses, files).
const HOST = 'https://api.agent37.com/v1';

export class Agent37 {
  constructor({ key, instanceId }) {
    this.key = key;
    this.instanceId = instanceId;
  }
  get configured() {
    return Boolean(this.key && this.instanceId);
  }
  get instanceUrl() {
    return `https://${this.instanceId}.agent37.app`;
  }

  async host(method, p, body) {
    const r = await fetch(`${HOST}${p}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!r.ok) throw Object.assign(new Error(`Agent37 ${method} ${p} -> ${r.status}: ${text.slice(0, 300)}`), { status: r.status, body: json });
    return json;
  }

  agentFetch(p, init = {}) {
    return fetch(`${this.instanceUrl}${p}`, {
      ...init,
      headers: { 'X-Agent37-Key': this.key, ...(init.headers || {}) },
    });
  }

  async health() {
    const r = await this.agentFetch('/v1/health');
    return r.ok ? r.json() : { ok: false, status: r.status };
  }

  // Streams one agent turn. onEvent(name, data) is called for every SSE frame.
  async streamResponse({ input, sessionId, signal, onEvent }) {
    const r = await this.agentFetch('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ input, stream: true, ...(sessionId ? { session_id: sessionId } : {}) }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`Agent37 /v1/responses -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buf = '';
    let terminal = null;
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!frame.trim() || frame.startsWith(':')) continue;
        const name = frame.match(/^event: (.+)$/m)?.[1];
        const dataLines = [...frame.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n');
        let data = {};
        try { data = JSON.parse(dataLines); } catch { data = { raw: dataLines }; }
        if (!name) continue;
        onEvent?.(name, data);
        if (name === 'response.completed' || name === 'response.failed') terminal = { name, data };
      }
    }
    return terminal;
  }

  async cancel(responseId) {
    try { await this.agentFetch(`/v1/responses/${responseId}/cancel`, { method: 'POST' }); } catch {}
  }

  async readFile(path) {
    const r = await this.agentFetch(`/v1/files/content?path=${encodeURIComponent(path)}`);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }

  async writeFile(path, content) {
    const r = await this.agentFetch(`/v1/files/content?path=${encodeURIComponent(path)}`, { method: 'PUT', body: content });
    if (!r.ok) throw new Error(`write ${path} -> ${r.status}`);
    return r.json();
  }

  async listDir(path) {
    const r = await this.agentFetch(`/v1/files?path=${encodeURIComponent(path)}`);
    if (!r.ok) return null;
    return r.json();
  }

  exec(command, user) {
    return this.host('POST', `/instances/${this.instanceId}/exec`, { command, ...(user ? { user } : {}) });
  }

  listCrons() {
    return this.host('GET', `/instances/${this.instanceId}/crons`);
  }
  createCron(body) {
    return this.host('POST', `/instances/${this.instanceId}/crons`, body);
  }
  usage() {
    return this.host('GET', `/instances/${this.instanceId}/usage`);
  }
}
