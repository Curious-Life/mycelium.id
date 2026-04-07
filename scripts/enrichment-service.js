#!/usr/bin/env node
/**
 * Local Enrichment Service — fully VPS-local tagging + embedding.
 *
 * Replaces enrichment-daemon.js (which depended on Cloudflare Workers AI).
 * All inference runs locally on VPS:
 *   - Tagging: Qwen2.5-3B via llama-server (localhost:8090)
 *   - Embedding: BGE-M3 via ONNX (localhost:8091)
 *
 * Architecture (Swiss Vault):
 *   - Decrypts content locally with ENCRYPTION_MASTER_KEY
 *   - Never sends plaintext to Cloudflare
 *   - Writes tags/entities to D1, vectors to Vectorize (via Worker proxy)
 *
 * API:
 *   POST /enrich  { messageIds, userId, agentId } → 202 (queued)
 *   GET  /status  → queue depth, processed count, model health
 *
 * Env: MYA_WORKER_URL, ADMIN_SECRET, ENCRYPTION_MASTER_KEY
 */

// SECURITY: Block --inspect in production.
if (process.execArgv.some(a => a.includes('inspect'))) {
  console.error('FATAL: --inspect detected. Node inspector is not allowed in production.');
  process.exit(1);
}

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
config({ path: resolve(root, '.env') });

// Bootstrap secrets from D1 API
import { bootstrapSecrets } from '../lib/bootstrap-secrets.js';
await bootstrapSecrets();

import { importMasterKeyFromTmpfs, decrypt, isEncrypted } from '../lib/crypto-local.js';
import { tagMessage, generateEmbedding, checkHealth } from '../lib/local-ai-client.js';

const WORKER_URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.ADMIN_SECRET;

const PORT = process.env.ENRICHMENT_PORT || 8095;
const POLL_INTERVAL = 30_000;
const CONCURRENCY = 5;
const PAGE_SIZE = 50;

const missing = [];
if (!WORKER_URL) missing.push('MYA_WORKER_URL');
if (!TOKEN) missing.push('ADMIN_SECRET');
if (missing.length) {
  console.error(`[enrichment] Missing env: ${missing.join(', ')}`);
  process.exit(1);
}

const dbHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };

// ── D1 helpers ──

async function dbQuery(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST', headers: dbHeaders,
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DB query failed: ${res.status}`);
  return (await res.json()).results || [];
}

async function vectorUpsert(vectors) {
  if (!vectors.length) return;
  const res = await fetch(`${WORKER_URL}/api/vectors/upsert`, {
    method: 'POST', headers: dbHeaders,
    body: JSON.stringify({ index: '1024', vectors }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[enrichment] Vector upsert failed (${res.status}): ${body.substring(0, 300)}`);
  }
}

// ── Local decryption (Swiss Vault — master key on VPS only) ──

let masterKey = null;

async function decryptContent(content) {
  if (!masterKey) return content;
  if (!isEncrypted(content)) return content;
  return decrypt(content, masterKey);
}

// ── Queue ──

const queue = [];
let totalProcessed = 0;
let totalFailed = 0;
let processing = false;
const startTime = Date.now();
const recentErrors = [];

function addToQueue(messageIds, userId, agentId) {
  for (const id of messageIds) {
    queue.push({ id, userId, agentId });
  }
}

// ── Enrich a single message ──

async function enrichOne(msg) {
  if (!msg.content || msg.content.length < 5) {
    await dbQuery(
      "UPDATE messages SET nlp_processed = 1, tags = '[]', nlp_processed_at = datetime('now') WHERE id = ?",
      [msg.id],
    );
    return { tagged: false };
  }

  // Tag + embed in parallel (both local services)
  const [tagging, embedding] = await Promise.allSettled([
    tagMessage(msg.content),
    generateEmbedding(msg.content),
  ]);

  const tags = tagging.status === 'fulfilled' ? tagging.value : { tags: [], entities: { people: [], companies: [], projects: [], places: [] } };
  const vector = embedding.status === 'fulfilled' ? embedding.value : null;

  if (embedding.status === 'rejected') {
    console.warn(`[enrichment] Embedding failed for ${msg.id}: ${embedding.reason?.message}`);
  }

  const allEntities = [
    ...tags.entities.people, ...tags.entities.companies,
    ...tags.entities.projects, ...tags.entities.places,
  ];

  // Update D1 with tags (even if embedding failed — partial enrichment is fine)
  await dbQuery(
    `UPDATE messages SET tags = ?, entities = ?, entity_summary = ?,
       nlp_processed = 1, nlp_processed_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(tags.tags), JSON.stringify(tags.entities),
     allEntities.join(', ') || null, msg.id],
  );

  return {
    tagged: tags.tags.length > 0,
    vector: vector ? {
      id: msg.id,
      values: vector,
      metadata: { type: 'message', userId: msg.user_id || '', agentId: msg.agent_id || '' },
    } : null,
  };
}

// ── Process queue ──

async function processQueue() {
  if (processing) return 0;
  processing = true;

  try {
    // Drain explicit queue first
    let batch = queue.splice(0, PAGE_SIZE);

    // If queue empty, poll D1 for unenriched messages
    if (!batch.length) {
      const rows = await dbQuery(
        `SELECT id FROM messages
         WHERE content IS NOT NULL AND LENGTH(content) > 10
         AND (nlp_processed = 0 OR nlp_processed IS NULL)
         ORDER BY created_at DESC LIMIT ?`,
        [PAGE_SIZE],
      );
      if (!rows.length) return 0;
      batch = rows.map(r => ({ id: r.id }));
    }

    // Fetch full content + decrypt
    const ids = batch.map(b => b.id);
    const placeholders = ids.map(() => '?').join(',');
    const rawMessages = await dbQuery(
      `SELECT id, content, user_id, agent_id FROM messages WHERE id IN (${placeholders})`,
      ids,
    );

    const messages = [];
    for (const msg of rawMessages) {
      if (!msg.content) continue;
      try {
        msg.content = await decryptContent(msg.content);
      } catch { continue; }
      if (msg.content && msg.content.length >= 5) messages.push(msg);
    }
    if (!messages.length) return 0;

    // Process in parallel chunks
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
          const errMsg = (err?.message || 'unknown').substring(0, 200);
          recentErrors.push({ id: chunk[j].id, error: errMsg, at: new Date().toISOString() });
          if (recentErrors.length > 20) recentErrors.shift();

          await dbQuery(
            "UPDATE messages SET nlp_processed = -1, nlp_error = ? WHERE id = ?",
            [errMsg, chunk[j].id],
          ).catch(() => {});
        }
      }
    }

    // Batch upsert vectors to Vectorize
    if (vectors.length > 0) {
      try { await vectorUpsert(vectors); } catch { /* logged in vectorUpsert */ }
    }

    return processed;
  } finally {
    processing = false;
  }
}

// ── HTTP Server ──

function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    const uptime = ((Date.now() - startTime) / 1000 / 60).toFixed(0);
    const rate = totalProcessed > 0 ? (totalProcessed / ((Date.now() - startTime) / 1000)).toFixed(2) : '0';

    // Async health check of AI services
    checkHealth().then(health => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        queue: queue.length,
        processing,
        totalProcessed,
        totalFailed,
        rate: `${rate}/s`,
        uptimeMinutes: parseInt(uptime),
        models: health,
        recentErrors: recentErrors.slice(-5),
      }));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queue: queue.length, processing, totalProcessed, totalFailed }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/enrich') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { messageIds, userId, agentId } = JSON.parse(body);
        if (!messageIds?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'messageIds required' }));
          return;
        }
        addToQueue(messageIds, userId, agentId);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: messageIds.length }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── Main ──

async function main() {
  // Load master key from tmpfs (preferred) or env (fallback)
  masterKey = await importMasterKeyFromTmpfs();
  if (masterKey) {
    console.log('[enrichment] Master key loaded (Swiss Vault — local decryption)');
  } else {
    console.warn('[enrichment] No master key (tmpfs nor env) — decryption disabled');
  }

  // Start HTTP server
  const server = createServer(handleRequest);
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[enrichment] Service listening on http://127.0.0.1:${PORT}`);
    console.log(`[enrichment] Concurrency: ${CONCURRENCY} | Poll: ${POLL_INTERVAL / 1000}s`);
  });

  // Background poll loop
  while (true) {
    try {
      const processed = await processQueue();

      if (processed > 0) {
        const uptime = ((Date.now() - startTime) / 1000 / 60).toFixed(0);
        const rate = (totalProcessed / ((Date.now() - startTime) / 1000)).toFixed(1);
        console.log(`[enrichment] Batch: ${processed} | Total: ${totalProcessed} | Failed: ${totalFailed} | ${rate}/s | Uptime: ${uptime}m`);
        continue; // Process next batch immediately
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    } catch (err) {
      console.error(`[enrichment] Poll error: ${err.message}`);
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }
}

main();
