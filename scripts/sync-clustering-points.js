#!/usr/bin/env node

/**
 * Sync Enriched Messages → clustering_points
 *
 * Finds messages that have been enriched (tags populated) but don't
 * yet have a corresponding clustering_point, and inserts them.
 * Also syncs documents and attachments with descriptions.
 *
 * Run before each clustering cycle.
 *
 * Usage:
 *   node scripts/sync-clustering-points.js
 *   node scripts/sync-clustering-points.js --dry-run
 *
 * Env vars: MYA_WORKER_URL, AGENT_TOKEN_MYA or ADMIN_SECRET
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
for (const f of ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']) {
  config({ path: resolve(root, f) });
}

const WORKER_URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.ADMIN_SECRET || process.env.AGENT_TOKEN_MYA;
const FALLBACK_USER_ID = process.env.MINDSCAPE_OWNER_ID || 'unknown';

if (!WORKER_URL || !TOKEN) {
  console.error('Missing MYA_WORKER_URL or auth token');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN}`,
};

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 query failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function d1Batch(statements) {
  const res = await fetch(`${WORKER_URL}/api/db/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 batch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

const BATCH = 100;

async function d1BatchChunked(statements) {
  for (let i = 0; i < statements.length; i += BATCH) {
    await d1Batch(statements.slice(i, i + BATCH));
  }
}

async function syncMessages() {
  // Find messages with tags that don't have a clustering_point
  const { results } = await d1Query(`
    SELECT COUNT(*) as cnt FROM messages m
    WHERE m.content IS NOT NULL AND LENGTH(m.content) > 10
    AND m.tags IS NOT NULL AND LENGTH(m.tags) > 2
    AND NOT EXISTS (
      SELECT 1 FROM clustering_points cp
      WHERE cp.source_type = 'message' AND cp.source_id = m.id
    )
  `);
  const total = results[0].cnt;
  console.log(`  Messages to sync: ${total}`);

  if (dryRun || total === 0) return total;

  let synced = 0;
  while (synced < total) {
    const { results: msgs } = await d1Query(`
      SELECT m.id, m.user_id, m.created_at FROM messages m
      WHERE m.content IS NOT NULL AND LENGTH(m.content) > 10
      AND m.tags IS NOT NULL AND LENGTH(m.tags) > 2
      AND NOT EXISTS (
        SELECT 1 FROM clustering_points cp
        WHERE cp.source_type = 'message' AND cp.source_id = m.id
      )
      LIMIT ?
    `, [BATCH]);

    if (!msgs?.length) break;

    const statements = msgs.map(m => ({
      sql: `INSERT OR IGNORE INTO clustering_points (user_id, source_type, source_id, created_at)
            VALUES (?, 'message', ?, ?)`,
      params: [m.user_id || FALLBACK_USER_ID, m.id, m.created_at],
    }));

    await d1BatchChunked(statements);
    synced += msgs.length;
    process.stdout.write(`\r  Synced messages: ${synced}/${total}`);
  }
  console.log();
  return synced;
}

async function syncDocuments() {
  const { results } = await d1Query(`
    SELECT COUNT(*) as cnt FROM documents d
    WHERE d.content IS NOT NULL AND LENGTH(d.content) > 10
    AND NOT EXISTS (
      SELECT 1 FROM clustering_points cp
      WHERE cp.source_type = 'document' AND cp.source_id = d.id
    )
  `);
  const total = results[0].cnt;
  console.log(`  Documents to sync: ${total}`);

  if (dryRun || total === 0) return total;

  const { results: docs } = await d1Query(`
    SELECT d.id, d.user_id, d.created_at FROM documents d
    WHERE d.content IS NOT NULL AND LENGTH(d.content) > 10
    AND NOT EXISTS (
      SELECT 1 FROM clustering_points cp
      WHERE cp.source_type = 'document' AND cp.source_id = d.id
    )
    LIMIT 500
  `);

  if (docs?.length) {
    const statements = docs.map(d => ({
      sql: `INSERT OR IGNORE INTO clustering_points (user_id, source_type, source_id, created_at)
            VALUES (?, 'document', ?, ?)`,
      params: [d.user_id || FALLBACK_USER_ID, d.id, d.created_at],
    }));
    await d1BatchChunked(statements);
  }
  console.log(`  Synced ${docs?.length || 0} documents`);
  return docs?.length || 0;
}

async function syncAttachments() {
  // Sync transcripts
  const { results: tRes } = await d1Query(`
    SELECT COUNT(*) as cnt FROM attachments a
    WHERE a.transcript IS NOT NULL AND LENGTH(a.transcript) > 10
    AND NOT EXISTS (
      SELECT 1 FROM clustering_points cp
      WHERE cp.source_type = 'transcript' AND cp.source_id = a.id
    )
  `);
  console.log(`  Transcripts to sync: ${tRes[0].cnt}`);

  // Sync image descriptions
  const { results: iRes } = await d1Query(`
    SELECT COUNT(*) as cnt FROM attachments a
    WHERE a.description IS NOT NULL AND LENGTH(a.description) > 10
    AND NOT EXISTS (
      SELECT 1 FROM clustering_points cp
      WHERE cp.source_type = 'image_description' AND cp.source_id = a.id
    )
  `);
  console.log(`  Image descriptions to sync: ${iRes[0].cnt}`);

  if (dryRun) return tRes[0].cnt + iRes[0].cnt;

  let synced = 0;

  if (tRes[0].cnt > 0) {
    const { results: transcripts } = await d1Query(`
      SELECT a.id, a.user_id, a.created_at FROM attachments a
      WHERE a.transcript IS NOT NULL AND LENGTH(a.transcript) > 10
      AND NOT EXISTS (
        SELECT 1 FROM clustering_points cp
        WHERE cp.source_type = 'transcript' AND cp.source_id = a.id
      )
      LIMIT 500
    `);
    if (transcripts?.length) {
      await d1BatchChunked(transcripts.map(t => ({
        sql: `INSERT OR IGNORE INTO clustering_points (user_id, source_type, source_id, created_at)
              VALUES (?, 'transcript', ?, ?)`,
        params: [t.user_id || FALLBACK_USER_ID, t.id, t.created_at],
      })));
      synced += transcripts.length;
    }
  }

  if (iRes[0].cnt > 0) {
    const { results: images } = await d1Query(`
      SELECT a.id, a.user_id, a.created_at FROM attachments a
      WHERE a.description IS NOT NULL AND LENGTH(a.description) > 10
      AND NOT EXISTS (
        SELECT 1 FROM clustering_points cp
        WHERE cp.source_type = 'image_description' AND cp.source_id = a.id
      )
      LIMIT 500
    `);
    if (images?.length) {
      await d1BatchChunked(images.map(i => ({
        sql: `INSERT OR IGNORE INTO clustering_points (user_id, source_type, source_id, created_at)
              VALUES (?, 'image_description', ?, ?)`,
        params: [i.user_id || FALLBACK_USER_ID, i.id, i.created_at],
      })));
      synced += images.length;
    }
  }

  console.log(`  Synced ${synced} attachments`);
  return synced;
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Sync Content → clustering_points            ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Dry run: ${dryRun}\n`);

  const msgCount = await syncMessages();
  const docCount = await syncDocuments();
  const attCount = await syncAttachments();

  console.log(`\n  Total synced: ${msgCount + docCount + attCount}`);

  // Show current clustering_points stats
  const { results } = await d1Query(`
    SELECT source_type, COUNT(*) as total,
           SUM(CASE WHEN realm_id IS NOT NULL THEN 1 ELSE 0 END) as clustered
    FROM clustering_points GROUP BY source_type
  `);
  console.log('\n  Current clustering_points:');
  for (const r of results) {
    console.log(`    ${r.source_type}: ${r.total} (${r.clustered} clustered)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
