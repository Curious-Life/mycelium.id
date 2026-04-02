#!/usr/bin/env node

/**
 * Backfill Message Embeddings → Vectorize
 *
 * Finds messages in D1 that have no corresponding Vectorize entry
 * and generates + upserts embeddings for them.
 *
 * Usage:
 *   node scripts/backfill-embeddings.js                    # all unembedded messages
 *   node scripts/backfill-embeddings.js --agent company-agent  # specific agent only
 *   node scripts/backfill-embeddings.js --dry-run          # count only
 *
 * Env vars required:
 *   MYA_WORKER_URL, MYA_WORKER_SECRET
 */

import 'dotenv/config';

const WORKER_URL = process.env.MYA_WORKER_URL;
const WORKER_SECRET = process.env.MYA_WORKER_SECRET;

if (!WORKER_URL || !WORKER_SECRET) {
  console.error('Missing MYA_WORKER_URL or MYA_WORKER_SECRET');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const agentIdx = args.indexOf('--agent');
const agentFilter = agentIdx >= 0 ? args[agentIdx + 1] : null;

const BATCH = 20; // Embed 20 at a time (rate limiting)

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_SECRET}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`D1 query failed (${res.status})`);
  return res.json();
}

async function embed(text) {
  const res = await fetch(`${WORKER_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_SECRET}` },
    body: JSON.stringify({ text: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const data = await res.json();
  return data.embedding;
}

async function vectorUpsert(vectors) {
  const res = await fetch(`${WORKER_URL}/api/vectors/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WORKER_SECRET}` },
    body: JSON.stringify({ index: 'search', vectors }),
  });
  if (!res.ok) throw new Error(`Vectorize upsert failed: ${res.status}`);
  return res.json();
}

async function vectorQuery(ids) {
  // Check which IDs already exist in Vectorize by querying each
  // Vectorize doesn't have a "get by ID" — we check via the DB approach
  // Instead, we'll just embed everything (upsert is idempotent)
  return new Set(); // Empty = assume none exist
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Backfill Message Embeddings → Vectorize     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Worker:   ${WORKER_URL}`);
  console.log(`  Dry run:  ${dryRun}`);
  if (agentFilter) console.log(`  Agent:    ${agentFilter}`);

  // Count messages to process
  let countSql = `SELECT COUNT(*) as count FROM messages WHERE content IS NOT NULL AND LENGTH(content) > 10`;
  const countParams = [];
  if (agentFilter) {
    countSql += ` AND agent_id = ?`;
    countParams.push(agentFilter);
  }
  const { results } = await d1Query(countSql, countParams);
  const total = results[0].count;
  console.log(`\n  Total messages to embed: ${total}`);

  if (dryRun) {
    // Show per-agent breakdown
    const breakdown = await d1Query(
      `SELECT agent_id, COUNT(*) as count FROM messages WHERE content IS NOT NULL AND LENGTH(content) > 10 GROUP BY agent_id ORDER BY count DESC`
    );
    console.log('\n  Per-agent breakdown:');
    for (const row of breakdown.results) {
      console.log(`    ${row.agent_id || '(null)'}: ${row.count}`);
    }
    return;
  }

  // Process in batches
  let embedded = 0;
  let failed = 0;

  for (let offset = 0; offset < total; offset += BATCH) {
    let sql = `SELECT id, content, user_id, agent_id FROM messages WHERE content IS NOT NULL AND LENGTH(content) > 10`;
    const params = [];
    if (agentFilter) {
      sql += ` AND agent_id = ?`;
      params.push(agentFilter);
    }
    sql += ` ORDER BY created_at ASC LIMIT ? OFFSET ?`;
    params.push(BATCH, offset);

    const { results: messages } = await d1Query(sql, params);
    if (!messages?.length) break;

    const vectors = [];
    for (const msg of messages) {
      try {
        const embedding = await embed(msg.content);
        if (embedding) {
          vectors.push({
            id: msg.id,
            values: embedding,
            metadata: {
              type: 'message',
              userId: msg.user_id || '',
              agentId: msg.agent_id || '',
            },
          });
        }
      } catch (err) {
        failed++;
        if (failed <= 5) console.error(`  Embed error: ${err.message}`);
      }
    }

    if (vectors.length > 0) {
      try {
        await vectorUpsert(vectors);
        embedded += vectors.length;
      } catch (err) {
        console.error(`  Vectorize upsert failed: ${err.message}`);
        failed += vectors.length;
      }
    }

    process.stdout.write(`\r  Progress: ${Math.min(offset + BATCH, total)}/${total} (embedded: ${embedded}, failed: ${failed})`);
  }

  console.log(`\n\n  Done! Embedded: ${embedded}, Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
