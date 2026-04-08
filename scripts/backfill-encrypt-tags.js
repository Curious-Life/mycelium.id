#!/usr/bin/env node
/**
 * Backfill: encrypt existing plaintext tags, entities, entity_summary in messages.
 *
 * Reads messages with plaintext tags via ADMIN_SECRET (bypasses scope),
 * encrypts them locally with the master key, writes back.
 * Idempotent — skips already-encrypted rows.
 *
 * Usage: cd ~/mycelium && node scripts/backfill-encrypt-tags.js
 * Requires: ENCRYPTION_MASTER_KEY (via tmpfs), MYA_WORKER_URL, ADMIN_SECRET
 */

import 'dotenv/config';
import { importMasterKeyFromTmpfs } from '../lib/crypto-local.js';

// Dynamic import to get the encrypt function after the module loads
const cryptoMod = await import('../lib/crypto-local.js');
const { encrypt } = cryptoMod;

const WORKER = process.env.MYA_WORKER_URL;
const ADMIN = process.env.ADMIN_SECRET;
const BATCH_SIZE = 50;

if (!WORKER || !ADMIN) {
  console.error('MYA_WORKER_URL and ADMIN_SECRET required');
  process.exit(1);
}

// Initialize master key — returns CryptoKey
let masterKey;
try {
  masterKey = await importMasterKeyFromTmpfs();
  if (!masterKey) throw new Error('No key returned');
  console.log('Master key loaded');
} catch (err) {
  console.error('Failed to load master key:', err.message);
  process.exit(1);
}

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER}/api/db/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN}`,
    },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`D1 query failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function isEncrypted(val) {
  if (!val || typeof val !== 'string' || val.length < 20) return false;
  try {
    const decoded = Buffer.from(val, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return !!(obj.v && obj.iv && obj.ct);
  } catch { return false; }
}

async function main() {
  console.log('Counting messages with tags...');
  const countResult = await d1Query(
    `SELECT COUNT(*) as cnt FROM messages WHERE tags IS NOT NULL OR entities IS NOT NULL OR entity_summary IS NOT NULL`
  );
  const total = countResult.results?.[0]?.cnt || 0;
  console.log(`Found ${total} messages with tag data`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;

  while (true) {
    const batch = await d1Query(
      `SELECT id, tags, entities, entity_summary, user_id, agent_id
       FROM messages
       WHERE tags IS NOT NULL OR entities IS NOT NULL OR entity_summary IS NOT NULL
       ORDER BY id
       LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset]
    );

    const rows = batch.results || [];
    if (rows.length === 0) break;

    for (const row of rows) {
      // Skip if already encrypted
      if (isEncrypted(row.tags) || isEncrypted(row.entities) || isEncrypted(row.entity_summary)) {
        skipped++;
        continue;
      }

      try {
        // Encrypt each field that has a value
        const scope = 'personal'; // tags are derived from personal messages
        const userId = row.user_id || process.env.MYA_USER_ID || null;
        const updates = [];
        const params = [];

        if (row.tags && !isEncrypted(row.tags)) {
          const encrypted = await encrypt(row.tags, scope, masterKey, userId);
          updates.push('tags = ?');
          params.push(encrypted);
        }
        if (row.entities && !isEncrypted(row.entities)) {
          const encrypted = await encrypt(row.entities, scope, masterKey, userId);
          updates.push('entities = ?');
          params.push(encrypted);
        }
        if (row.entity_summary && !isEncrypted(row.entity_summary)) {
          const encrypted = await encrypt(row.entity_summary, scope, masterKey, userId);
          updates.push('entity_summary = ?');
          params.push(encrypted);
        }

        if (updates.length > 0) {
          params.push(row.id);
          await d1Query(
            `UPDATE messages SET ${updates.join(', ')} WHERE id = ?`,
            params
          );
          processed++;
        }
      } catch (err) {
        errors++;
        if (errors <= 5) console.error(`  Error on ${row.id}:`, err.message);
      }
    }

    offset += rows.length;
    if (processed % 200 === 0 && processed > 0) {
      console.log(`  Progress: ${processed} encrypted, ${skipped} skipped, ${errors} errors (${offset}/${total})`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Encrypted: ${processed}`);
  console.log(`  Already encrypted: ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
