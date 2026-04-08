#!/usr/bin/env node
/**
 * Seed a secret to the centralized Secrets API.
 *
 * SWISS VAULT: Encrypts the value locally before sending to Worker.
 * Worker stores ciphertext only — never sees plaintext.
 *
 * TWO-KEY SEPARATION:
 *   Default → encrypt with SYSTEM_KEY (operator infrastructure secrets)
 *             e.g. MYA_WORKER_SECRET, CLAUDE_API_TOKEN, DISCORD_BOT_TOKEN
 *   --user  → encrypt with USER_MASTER_KEY (customer-owned secrets, future)
 *
 * Usage:
 *   node scripts/seed-secret.js KEY VALUE [SCOPE] [AGENT] [--user]
 *
 * Env required:
 *   MYA_WORKER_URL, ADMIN_SECRET
 *   SYSTEM_KEY env or /run/mycelium/system.key (for system secrets — default)
 *   ENCRYPTION_MASTER_KEY env or /run/mycelium/master.key (for --user secrets)
 *
 * Examples:
 *   node scripts/seed-secret.js MYA_WORKER_SECRET "abc123" org
 *   node scripts/seed-secret.js CDP_API_KEY_SECRET "secret" wealth wealth-agent
 *   node scripts/seed-secret.js MY_PERSONAL_TOKEN "xyz" personal --user
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  importMasterKeyFromTmpfs,
  importSystemKeyFromTmpfs,
  encrypt,
  encryptWithSystemKey,
} from '../lib/crypto-local.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Load env files (same order as ecosystem.config.cjs)
for (const f of ['.env', '.env.crypto', '.env.database', '.env.cloudflare', '.env.agents', '.env.discord']) {
  config({ path: resolve(root, f) });
}

// Parse args — filter out flags, then assign positional args
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter(a => a.startsWith('--')));
const positional = rawArgs.filter(a => !a.startsWith('--'));
const [key, value, scope = 'org', agent] = positional;
const useUserKey = flags.has('--user');

if (!key || !value) {
  console.error('Usage: node scripts/seed-secret.js KEY VALUE [SCOPE] [AGENT] [--user]');
  console.error('  SCOPE: org (default), personal, wealth, moms');
  console.error('  AGENT: optional agent ID (e.g. personal-agent, wealth-agent)');
  console.error('  --user: encrypt with USER_MASTER_KEY (customer-owned secret)');
  console.error('          default: encrypt with SYSTEM_KEY (operator infrastructure)');
  process.exit(1);
}

const WORKER_URL = process.env.MYA_WORKER_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!WORKER_URL) { console.error('Missing MYA_WORKER_URL'); process.exit(1); }
if (!ADMIN_SECRET) { console.error('Missing ADMIN_SECRET'); process.exit(1); }

let encryptedValue;
let keyFamily;

if (useUserKey) {
  keyFamily = 'user';
  const masterKey = await importMasterKeyFromTmpfs();
  if (!masterKey) {
    console.error('Missing USER_MASTER_KEY (tmpfs /run/mycelium/master.key or ENCRYPTION_MASTER_KEY env)');
    process.exit(1);
  }
  encryptedValue = await encrypt(value, scope, masterKey);
} else {
  keyFamily = 'system';
  const systemKey = await importSystemKeyFromTmpfs();
  if (!systemKey) {
    console.error('Missing SYSTEM_KEY (tmpfs /run/mycelium/system.key or SYSTEM_KEY env)');
    console.error('Generate one: openssl rand -hex 32 > /run/mycelium/system.key && chmod 0400 /run/mycelium/system.key');
    process.exit(1);
  }
  encryptedValue = await encryptWithSystemKey(value, scope, systemKey);
}

// PUT to Worker (stores ciphertext as-is, tagged with key_family)
const payload = {
  key,
  value: encryptedValue,
  scope,
  user_id: process.env.MYA_USER_ID || 'system',
  agent: agent || null,
  key_family: keyFamily,
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
  console.log(`OK   ${key} (kf=${keyFamily}, scope=${scope}, agent=${agent || 'null'})`);
} else {
  const body = await res.text().catch(() => '');
  console.error(`FAIL ${key} → HTTP ${res.status}: ${body}`);
  process.exit(1);
}
