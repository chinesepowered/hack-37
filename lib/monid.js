// Monid: discover -> inspect -> run data endpoints from one wallet.
const BASE = 'https://api.monid.ai/v1';

export class Monid {
  constructor({ key }) {
    this.key = key;
  }
  get configured() {
    return Boolean(this.key);
  }
  async call(method, p, body) {
    const r = await fetch(`${BASE}${p}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  }
  async discover(query, limit = 5) {
    const { status, json } = await this.call('POST', '/discover', { query, limit });
    if (status !== 200) throw new Error(`Monid discover ${status}`);
    return json.results || [];
  }
  async balance() {
    const { json } = await this.call('GET', '/wallet/balance');
    return json.balance;
  }
  // Runs an endpoint; polls async (202) runs until terminal or timeout.
  async run(provider, endpoint, input, { timeoutMs = 240000 } = {}) {
    const { status, json } = await this.call('POST', '/run', { provider, endpoint, input });
    if (status !== 202) return json;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 4000));
      const { json: run } = await this.call('GET', `/runs/${json.runId}`);
      if (['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIMED_OUT'].includes(run.status)) return run;
    }
    return { status: 'TIMED_OUT', runId: json.runId };
  }
}
