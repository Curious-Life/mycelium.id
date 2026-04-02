#!/usr/bin/env node
/**
 * Backfill encryption for imported messages.
 *
 * Reads unencrypted imported messages in batches, then UPDATEs each one
 * through the Worker db-proxy (which auto-encrypts content on UPDATE).
 *
 * Usage: MYA_WORKER_URL=... MYA_WORKER_SECRET=... node scripts/backfill-encrypt-imports.js
 */

const WORKER_URL = process.env.MYA_WORKER_URL;
const SECRET = process.env.MYA_WORKER_SECRET || process.env.AGENT_TOKEN;
const BATCH_SIZE = 50;

if (!WORKER_URL || !SECRET) {
  console.error('MYA_WORKER_URL and MYA_WORKER_SECRET required');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${SECRET}`,
};

async function query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status} ${await res.text()}`);
  return (await res.json()).results || [];
}

async function batch(statements) {
  const res = await fetch(`${WORKER_URL}/api/db/batch`, {
    method: 'POST', headers,
    body: JSON.stringify({ statements }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Batch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function run() {
  // Count total to encrypt
  const [{ count }] = await query(
    `SELECT COUNT(*) as count FROM messages WHERE source IN ('import_claude', 'import_chatgpt', 'claude_export')`
  );
  console.log(`Total imported messages: ${count}`);

  let processed = 0;
  let encrypted = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    // Read a batch of messages (proxy auto-decrypts, but these are plaintext)
    const rows = await query(
      `SELECT id, content, metadata FROM messages WHERE source IN ('import_claude', 'import_chatgpt', 'claude_export') LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset]
    );

    if (rows.length === 0) break;

    // Build UPDATE statements — content goes through ? param so proxy encrypts it
    const stmts = [];
    for (const row of rows) {
      if (!row.content) continue;
      stmts.push({
        sql: `UPDATE messages SET content = ?, metadata = ? WHERE id = ?`,
        params: [row.content, row.metadata || null, row.id],
      });
    }

    if (stmts.length > 0) {
      try {
        await batch(stmts);
        encrypted += stmts.length;
      } catch (err) {
        console.error(`Batch at offset ${offset} failed: ${err.message}`);
        // Fallback: one-by-one
        for (const stmt of stmts) {
          try {
            await query(stmt.sql, stmt.params);
            encrypted++;
          } catch (e) {
            errors++;
          }
        }
      }
    }

    processed += rows.length;
    if (processed % 500 === 0 || rows.length < BATCH_SIZE) {
      console.log(`Progress: ${processed}/${count} processed, ${encrypted} encrypted, ${errors} errors`);
    }
    offset += BATCH_SIZE;
  }

  console.log(`Done: ${processed} processed, ${encrypted} encrypted, ${errors} errors`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
