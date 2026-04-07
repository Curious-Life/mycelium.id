#!/usr/bin/env node
/**
 * Seed a secret to the centralized Secrets API.
 *
 * SWISS VAULT: Encrypts the value locally before sending to Worker.
 * Worker stores ciphertext only — never sees plaintext.
 *
 * Usage:
 *   node scripts/seed-secret.js KEY VALUE [SCOPE] [AGENT]
 *
 * Env required: MYA_WORKER_URL, ADMIN_SECRET, ENCRYPTION_MASTER_KEY
 *
 * Examples:
 *   node scripts/seed-secret.js TELEGRAM_BOT_TOKEN "abc123" personal personal-agent
 *   node scripts/seed-secret.js CLOUDFLARE_ACCOUNT_ID "xyz" org
 *   node scripts/seed-secret.js CDP_API_KEY_SECRET "secret" wealth wealth-agent
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { importMasterKeyFromTmpfs, encrypt } from '../lib/crypto-local.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Load env files (same order as ecosystem.config.cjs)
for (const f of ['.env', '.env.crypto', '.env.database', '.env.cloudflare', '.env.agents', '.env.discord']) {
  config({ path: resolve(root, f) });
}

const [,, key, value, scope = 'org', agent] = process.argv;

if (!key || !value) {
  console.error('Usage: node scripts/seed-secret.js KEY VALUE [SCOPE] [AGENT]');
  console.error('  SCOPE: org (default), personal, wealth, moms');
  console.error('  AGENT: optional agent ID (e.g. personal-agent, wealth-agent)');
  process.exit(1);
}

const WORKER_URL = process.env.MYA_WORKER_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!WORKER_URL) { console.error('Missing MYA_WORKER_URL'); process.exit(1); }
if (!ADMIN_SECRET) { console.error('Missing ADMIN_SECRET'); process.exit(1); }

// Encrypt the value locally — load master key from tmpfs (preferred) or env
const masterKey = await importMasterKeyFromTmpfs();
if (!masterKey) {
  console.error('Missing master key (tmpfs /run/mycelium/master.key or ENCRYPTION_MASTER_KEY env)');
  process.exit(1);
}
const encryptedValue = await encrypt(value, scope, masterKey);

// PUT to Worker (stores ciphertext as-is)
const payload = {
  key,
  value: encryptedValue,
  scope,
  user_id: process.env.MYA_USER_ID || 'system',
  agent: agent || null,
};

const res = await fetch(`${WORKER_URL}/api/secrets`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ADMIN_SECRET}`,
  },
  body: JSON.stringify(payload),
});

if (res.ok) {
  console.log(`OK   ${key} (scope=${scope}, agent=${agent || 'null'})`);
} else {
  const body = await res.text().catch(() => '');
  console.error(`FAIL ${key} → HTTP ${res.status}: ${body}`);
  process.exit(1);
}
