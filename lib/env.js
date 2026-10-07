// Minimal .env loader (no dependency). Real environment variables win over .env values.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
  }
}

export const cfg = () => ({
  port: Number(process.env.PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  dealerSitesBase: (process.env.DEALER_SITES_BASE || '').replace(/\/$/, ''),
  agent37Key: process.env.AGENT37_API_KEY || '',
  agent37Instance: process.env.AGENT37_INSTANCE_ID || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || '',
  monidKey: process.env.MONID_API_KEY || '',
  databaseUrl: process.env.DATABASE_URL || '',
  defaultMode: process.env.DEFAULT_MODE || '',
});
