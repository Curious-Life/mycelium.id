#!/usr/bin/env node
/**
 * Enrichment Daemon — persistent PM2 process that ensures every message
 * gets tagged + embedded.
 *
 * Architecture (Swiss Vault):
 *   - Fetches unenriched message IDs from D1 (via Worker proxy)
 *   - Decrypts content locally with ENCRYPTION_MASTER_KEY (VPS-only)
 *   - Calls Workers AI REST API directly for tagging + embedding
 *     (no Worker timeout, parallel, fast)
 *   - Writes tags/entities back to D1, upserts vectors to Vectorize
 *
 * Env: MYA_WORKER_URL, ADMIN_SECRET, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN
 */

// SECURITY: Block --inspect in production.
if (process.execArgv.some(a => a.includes('inspect'))) {
  console.error('FATAL: --inspect detected. Node inspector is not allowed in production.');
  process.exit(1);
}

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
config({ path: resolve(root, '.env') });

// Bootstrap secrets from D1 API (replaces scoped .env files)
import { bootstrapSecrets, refreshSecrets } from '../lib/bootstrap-secrets.js';
await bootstrapSecrets();

import { WorkersAIClient } from '../lib/workers-ai-client.js';
import { importMasterKeyFromTmpfs, decrypt, isEncrypted } from '../lib/crypto-local.js';

const WORKER_URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.ADMIN_SECRET;
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_AI_TOKEN = process.env.CLOUDFLARE_AI_TOKEN;

const POLL_INTERVAL = 30_000;
const CONCURRENCY = 5;
const PAGE_SIZE = 50;

const missing = [];
if (!WORKER_URL) missing.push('MYA_WORKER_URL');
if (!TOKEN) missing.push('ADMIN_SECRET');
if (!CF_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
if (!CF_AI_TOKEN) missing.push('CLOUDFLARE_AI_TOKEN');
if (missing.length) {
  console.error(`[enrichment-daemon] Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const dbHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };
const ai = new WorkersAIClient(CF_ACCOUNT_ID, CF_AI_TOKEN);

async function dbQuery(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: dbHeaders,
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  return (await res.json()).results || [];
}

// Local decryption — master key never leaves VPS
let masterKey = null;

async function decryptContent(content) {
  if (!masterKey) return content; // no key = passthrough
  if (!isEncrypted(content)) return content;
  return decrypt(content, masterKey);
}

async function vectorUpsert(vectors) {
  const res = await fetch(`${WORKER_URL}/api/vectors/upsert`, {
    method: 'POST',
    headers: dbHeaders,
    body: JSON.stringify({ index: '1024', vectors }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[enrichment-daemon] Vector upsert failed (${res.status}): ${body.substring(0, 300)}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let totalProcessed = 0;
let totalFailed = 0;
const startTime = Date.now();

async function enrichOne(msg) {
  if (!msg.content || msg.content.length < 5) {
    await dbQuery(
      "UPDATE messages SET nlp_processed = 1, tags = '[]', nlp_processed_at = datetime('now') WHERE id = ?",
      [msg.id],
    );
    return { tagged: false };
  }

  const [tagging, embedding] = await Promise.all([
    ai.tagMessage(msg.content),
    ai.generateEmbedding(msg.content),
  ]);

  const allEntities = [
    ...tagging.entities.people, ...tagging.entities.companies,
    ...tagging.entities.projects, ...tagging.entities.places,
  ];

  await dbQuery(
    `UPDATE messages SET tags = ?, entities = ?, entity_summary = ?,
       nlp_processed = 1, nlp_processed_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(tagging.tags), JSON.stringify(tagging.entities),
     allEntities.join(', ') || null, msg.id],
  );

  return {
    tagged: tagging.tags.length > 0,
    vector: {
      id: msg.id,
      values: embedding,
      metadata: { type: 'message', userId: msg.user_id || '', agentId: msg.agent_id || '' },
    },
  };
}

async function processQueue() {
  // Step 1: Get unenriched message IDs
  const rows = await dbQuery(
    `SELECT id FROM messages
     WHERE content IS NOT NULL AND LENGTH(content) > 10
     AND (nlp_processed = 0 OR nlp_processed IS NULL)
     ORDER BY created_at DESC LIMIT ?`,
    [PAGE_SIZE],
  );
  if (!rows.length) return 0;

  // Step 2: Fetch content + decrypt locally (master key on VPS only)
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const rawMessages = await dbQuery(
    `SELECT id, content, user_id, agent_id FROM messages WHERE id IN (${placeholders})`,
    ids,
  );
  // Decrypt each message locally
  const messages = [];
  for (const msg of rawMessages) {
    if (!msg.content) continue;
    try {
      msg.content = await decryptContent(msg.content);
    } catch { continue; }
    if (msg.content && msg.content.length >= 5) messages.push(msg);
  }
  if (!messages.length) return 0;

  // Step 3: Tag + embed in parallel via direct AI API
  let processed = 0;
  const vectors = [];

  for (let i = 0; i < messages.length; i += CONCURRENCY) {
    const chunk = messages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(msg => enrichOne(msg)));

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        totalProcessed++;
        processed++;
        if (results[j].value.vector) vectors.push(results[j].value.vector);
      } else {
        totalFailed++;
        const err = results[j].reason;
        if (err?.message?.includes('429')) {
          console.warn('[enrichment-daemon] AI rate limited — backing off 60s');
          await sleep(60000);
        } else {
          console.error(`[enrichment-daemon] Failed ${chunk[j].id}: ${err?.message}`);
          await dbQuery(
            "UPDATE messages SET nlp_processed = -1, nlp_error = ? WHERE id = ?",
            [(err?.message || 'unknown').substring(0, 500), chunk[j].id],
          ).catch(() => {});
        }
      }
    }
  }

  // Step 4: Batch upsert vectors
  if (vectors.length > 0) {
    try { await vectorUpsert(vectors); } catch { /* logged in vectorUpsert */ }
  }

  return processed;
}

async function main() {
  // Load master key from tmpfs (preferred) or env (fallback)
  masterKey = await importMasterKeyFromTmpfs();
  if (masterKey) {
    console.log('[enrichment-daemon] Master key loaded (Swiss Vault — local decryption)');
  } else {
    console.warn('[enrichment-daemon] No master key (tmpfs nor env) — decryption disabled');
  }

  console.log('[enrichment-daemon] Started (Swiss Vault — key on VPS only)');
  console.log(`[enrichment-daemon] Concurrency: ${CONCURRENCY} | Poll: ${POLL_INTERVAL / 1000}s`);

  while (true) {
    try {
      const processed = await processQueue();

      if (processed > 0) {
        const uptime = ((Date.now() - startTime) / 1000 / 60).toFixed(0);
        const rate = (totalProcessed / ((Date.now() - startTime) / 1000)).toFixed(1);
        console.log(`[enrichment-daemon] Batch: ${processed} | Total: ${totalProcessed} | Failed: ${totalFailed} | ${rate}/s | Uptime: ${uptime}m`);
        continue;
      }

      await sleep(POLL_INTERVAL);
    } catch (err) {
      console.error(`[enrichment-daemon] Poll error: ${err.message}`);
      await sleep(POLL_INTERVAL);
    }
  }
}

main();
