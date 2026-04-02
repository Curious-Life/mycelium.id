#!/usr/bin/env node

/**
 * Backfill Message Enrichment (tagging + embedding)
 *
 * Finds messages without tags and sends them to the Worker /api/enrich
 * endpoint in batches. The Worker decrypts, tags (Llama 4 Scout),
 * generates embeddings (BGE-M3), and updates D1 + Vectorize.
 *
 * Usage:
 *   node scripts/backfill-enrich.js                  # process all
 *   node scripts/backfill-enrich.js --dry-run        # count only
 *   node scripts/backfill-enrich.js --batch 20       # custom batch size
 *   node scripts/backfill-enrich.js --delay 8000     # custom delay between batches (ms)
 *
 * Env vars required (loaded from .env files):
 *   MYA_WORKER_URL    — Worker URL
 *   AGENT_TOKEN       — Agent token (from AGENT_REGISTRY) or
 *   ADMIN_SECRET      — Admin secret (fallback)
 */

// Load all env files (same as ecosystem.config.cjs)
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
for (const f of ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']) {
  config({ path: resolve(root, f) });
}

const WORKER_URL = process.env.MYA_WORKER_URL;
// ADMIN_SECRET required for full-scope decryption (personal + org + wealth)
const TOKEN = process.env.ADMIN_SECRET || process.env.AGENT_TOKEN_MYA;

if (!WORKER_URL || !TOKEN) {
  console.error('Missing MYA_WORKER_URL or auth token (AGENT_TOKEN_MYA / ADMIN_SECRET)');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchIdx = args.indexOf('--batch');
const BATCH = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) : 30;
const delayIdx = args.indexOf('--delay');
const DELAY_MS = delayIdx >= 0 ? parseInt(args[delayIdx + 1]) : 6000;

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

async function enrich(messageIds) {
  const res = await fetch(`${WORKER_URL}/api/enrich?sync=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messageIds, sync: true }),
    signal: AbortSignal.timeout(120000), // 2 min timeout for sync processing
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Enrich failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Backfill Message Enrichment (tags + embed)  ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Worker:     ${WORKER_URL}`);
  console.log(`  Batch size: ${BATCH}`);
  console.log(`  Delay:      ${DELAY_MS}ms`);
  console.log(`  Dry run:    ${dryRun}`);

  // Count messages needing enrichment (no tags or empty tags)
  const { results } = await d1Query(
    `SELECT COUNT(*) as count FROM messages
     WHERE content IS NOT NULL AND LENGTH(content) > 10
     AND (nlp_processed = 0 OR nlp_processed IS NULL)`
  );
  const total = results[0].count;
  console.log(`\n  Messages needing enrichment: ${total}`);

  if (dryRun) {
    const breakdown = await d1Query(
      `SELECT agent_id, COUNT(*) as count FROM messages
       WHERE content IS NOT NULL AND LENGTH(content) > 10
       AND (nlp_processed = 0 OR nlp_processed IS NULL)
       GROUP BY agent_id ORDER BY count DESC`
    );
    console.log('\n  Per-agent breakdown:');
    for (const row of breakdown.results) {
      console.log(`    ${row.agent_id || '(null)'}: ${row.count}`);
    }
    return;
  }

  if (total === 0) {
    console.log('  Nothing to do!');
    return;
  }

  let processed = 0;
  let failed = 0;
  const startTime = Date.now();

  // Process ONE message per Worker invocation to stay within Worker CPU limits.
  // Fetch in pages of 100 IDs, then enrich each individually.
  while (processed + failed < total) {
    const { results: messages } = await d1Query(
      `SELECT id FROM messages
       WHERE content IS NOT NULL AND LENGTH(content) > 10
       AND (nlp_processed = 0 OR nlp_processed IS NULL)
       ORDER BY created_at ASC
       LIMIT 100`
    );

    if (!messages?.length) break;

    for (const msg of messages) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await enrich([msg.id]);
          processed++;
          break;
        } catch (err) {
          if (err.message.includes('401')) {
            console.error('\n  Auth failed. Stopping.');
            process.exit(1);
          }
          if (err.message.includes('429')) {
            const backoff = 30000 * Math.pow(2, attempt);
            console.error(`\n  Rate limited — waiting ${backoff / 1000}s`);
            await sleep(backoff);
            continue;
          }
          console.error(`\n  Error on ${msg.id}: ${err.message}`);
          failed++;
          break;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (processed / (elapsed || 1)).toFixed(1);
      const done = processed + failed;
      const eta = rate > 0 ? (((total - done) / rate / 60).toFixed(1)) : '?';
      process.stdout.write(`\r  Progress: ${done}/${total} | OK: ${processed} | Fail: ${failed} | ${rate}/s | ETA: ${eta}m`);

      await sleep(DELAY_MS);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n\n  Done! Queued: ${queued}, Failed: ${failed}, Time: ${elapsed}m`);
  console.log('  Note: Worker processes enrichment in background — tags may take a few minutes to populate.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
