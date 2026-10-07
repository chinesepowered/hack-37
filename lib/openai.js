// OpenAI: structured outputs (strict JSON schema) for repairing agent output, plus memo / letter drafting.
const BASE = 'https://api.openai.com/v1';
const PREFERRED = ['gpt-5-mini', 'gpt-5.1-mini', 'gpt-5.2-mini', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5', 'gpt-4.1', 'gpt-4o'];

export class OpenAIClient {
  constructor({ key, model }) {
    this.key = key;
    this.model = model;
  }
  get configured() {
    return Boolean(this.key);
  }

  async pickModel() {
    if (this.model) return this.model;
    try {
      const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${this.key}` } });
      const ids = new Set(((await r.json()).data || []).map((m) => m.id));
      this.model = PREFERRED.find((m) => ids.has(m)) || [...ids].find((id) => /^gpt-/.test(id)) || 'gpt-4o-mini';
    } catch {
      this.model = 'gpt-4o-mini';
    }
    return this.model;
  }

  async chat(body) {
    const model = await this.pickModel();
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return { content: json.choices?.[0]?.message?.content || '', usage: json.usage, model };
  }

  async json({ system, user, name, schema }) {
    const { content, model } = await this.chat({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    });
    return { data: JSON.parse(content), model };
  }

  async text({ system, user }) {
    const { content, model } = await this.chat({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    return { text: content, model };
  }
}

// Strict schema for listings extracted by the agent.
export const LISTINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dealers'],
  properties: {
    dealers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dealer_id', 'units'],
        properties: {
          dealer_id: { type: 'string' },
          units: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['serial', 'year', 'make', 'model', 'price', 'status'],
              properties: {
                serial: { type: 'string' },
                year: { type: ['integer', 'null'] },
                make: { type: ['string', 'null'] },
                model: { type: ['string', 'null'] },
                price: { type: ['number', 'null'] },
                status: { type: 'string', enum: ['AVAILABLE', 'SOLD', 'SALE_PENDING'] },
              },
            },
          },
        },
      },
    },
  },
};
