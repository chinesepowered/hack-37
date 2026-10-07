// Audit history: InstaCloud Postgres when DATABASE_URL is set, otherwise an in-memory list.
import pg from 'pg';

const memory = [];
let pool = null;
let ready = null;

export function initStore(databaseUrl) {
  if (!databaseUrl) return Promise.resolve(false);
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 10000, ssl: /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined });
  ready = pool
    .query(`
      create table if not exists audit_runs (
        id text primary key,
        mode text not null,
        started_at timestamptz not null,
        finished_at timestamptz,
        summary jsonb,
        agent jsonb
      );
      create table if not exists audit_findings (
        run_id text references audit_runs(id) on delete cascade,
        unit_id text not null,
        dealer_id text not null,
        type text not null,
        severity text not null,
        amount numeric,
        evidence jsonb,
        primary key (run_id, unit_id)
      );`)
    .then(() => true)
    .catch((e) => {
      console.warn('[store] Postgres unavailable, using memory:', e.message);
      pool = null;
      return false;
    });
  return ready;
}

export const storeKind = () => (pool ? 'postgres' : 'memory');

export async function saveRun(run) {
  const row = {
    id: run.id,
    mode: run.mode,
    started_at: new Date(run.t0).toISOString(),
    finished_at: new Date().toISOString(),
    summary: run.result?.summary || null,
    agent: run.agent || null,
  };
  memory.unshift(row);
  if (memory.length > 50) memory.pop();
  if (!pool) return;
  try {
    await ready;
    await pool.query(
      'insert into audit_runs (id, mode, started_at, finished_at, summary, agent) values ($1,$2,$3,$4,$5,$6) on conflict (id) do update set finished_at = excluded.finished_at, summary = excluded.summary, agent = excluded.agent',
      [row.id, row.mode, row.started_at, row.finished_at, row.summary, row.agent],
    );
    for (const f of run.result?.findings || []) {
      await pool.query(
        'insert into audit_findings (run_id, unit_id, dealer_id, type, severity, amount, evidence) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing',
        [run.id, f.unit_id, f.dealer_id, f.type, f.severity, f.amount, f.evidence],
      );
    }
  } catch (e) {
    console.warn('[store] save failed:', e.message);
  }
}

export async function listRuns() {
  if (!pool) return memory;
  try {
    await ready;
    const { rows } = await pool.query('select id, mode, started_at, finished_at, summary, agent from audit_runs order by started_at desc limit 20');
    return rows;
  } catch {
    return memory;
  }
}
