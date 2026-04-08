#!/usr/bin/env node
/**
 * Backfill: encrypt ALL sensitive fields across ALL tables.
 *
 * Reads rows with plaintext values (not starting with eyJ = base64 envelope),
 * encrypts them with the master key, writes back. Idempotent.
 *
 * Usage: cd ~/mycelium && node scripts/backfill-encrypt-all.js [--table <name>]
 * Requires: ENCRYPTION_MASTER_KEY (via tmpfs), MYA_WORKER_URL, ADMIN_SECRET
 */

import 'dotenv/config';
import { getMasterKeyFromBestSource, encrypt, ENCRYPTED_FIELDS } from '../lib/crypto-local.js';

const WORKER = process.env.MYA_WORKER_URL;
const ADMIN = process.env.ADMIN_SECRET;
const BATCH_SIZE = 50;
const ONLY_TABLE = process.argv.includes('--table') ? process.argv[process.argv.indexOf('--table') + 1] : null;

if (!WORKER || !ADMIN) {
  console.error('MYA_WORKER_URL and ADMIN_SECRET required');
  process.exit(1);
}

let masterKey;
try {
  masterKey = await getMasterKeyFromBestSource();
  if (!masterKey) throw new Error('No key returned');
  console.log('Master key loaded');
} catch (err) {
  console.error('Failed to load master key:', err.message);
  process.exit(1);
}

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER}/api/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN}` },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`D1 ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

function isEncrypted(val) {
  if (!val || typeof val !== 'string') return false;
  if (val.length === 0) return true; // empty string — nothing to encrypt
  try {
    const decoded = Buffer.from(val, 'base64').toString('utf8');
    const obj = JSON.parse(decoded);
    return !!(obj.v && obj.iv && obj.ct);
  } catch { return false; }
}

// Check if table exists in D1
async function tableExists(table) {
  try {
    await d1Query(`SELECT 1 FROM ${table} LIMIT 0`);
    return true;
  } catch { return false; }
}

async function backfillTable(table, fields) {
  const exists = await tableExists(table);
  if (!exists) {
    console.log(`  [${table}] Table does not exist — skipping`);
    return { encrypted: 0, skipped: 0, errors: 0 };
  }

  // Build WHERE clause: any encrypted field is NOT NULL
  const whereOr = fields.map(f => `${f} IS NOT NULL`).join(' OR ');

  // Count total rows with data
  let total;
  try {
    const countResult = await d1Query(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${whereOr}`);
    total = countResult.results?.[0]?.cnt || 0;
  } catch (err) {
    console.log(`  [${table}] Count failed: ${err.message} — skipping`);
    return { encrypted: 0, skipped: 0, errors: 0 };
  }

  if (total === 0) {
    console.log(`  [${table}] No rows with data — skipping`);
    return { encrypted: 0, skipped: 0, errors: 0 };
  }

  console.log(`  [${table}] ${total} rows to check (fields: ${fields.join(', ')})`);

  let encrypted = 0, skipped = 0, errors = 0, offset = 0;

  // Determine primary key column
  let pkCol = 'id';
  // Some tables may use 'rowid' — try id first
  try {
    await d1Query(`SELECT id FROM ${table} LIMIT 1`);
  } catch {
    pkCol = 'rowid';
  }

  while (true) {
    let rows;
    try {
      const selectCols = [pkCol, 'user_id', ...fields].filter((v, i, a) => a.indexOf(v) === i);
      const result = await d1Query(
        `SELECT ${selectCols.join(', ')} FROM ${table} WHERE ${whereOr} ORDER BY ${pkCol} LIMIT ? OFFSET ?`,
        [BATCH_SIZE, offset]
      );
      rows = result.results || [];
    } catch (err) {
      // Some columns might not exist — try without optional ones
      console.log(`  [${table}] Query error at offset ${offset}: ${err.message}`);
      break;
    }

    if (rows.length === 0) break;

    for (const row of rows) {
      let needsUpdate = false;

      // Check if any field needs encryption
      for (const field of fields) {
        const val = row[field];
        if (val && typeof val === 'string' && val.length > 0 && !isEncrypted(val)) {
          needsUpdate = true;
          break;
        }
      }

      if (!needsUpdate) {
        skipped++;
        continue;
      }

      try {
        const scope = 'personal';
        const userId = row.user_id || process.env.MYA_USER_ID || null;
        const updates = [];
        const params = [];

        for (const field of fields) {
          const val = row[field];
          if (val && typeof val === 'string' && val.length > 0 && !isEncrypted(val)) {
            const enc = await encrypt(val, scope, masterKey, userId);
            updates.push(`${field} = ?`);
            params.push(enc);
          }
        }

        if (updates.length > 0) {
          params.push(row[pkCol]);
          await d1Query(`UPDATE ${table} SET ${updates.join(', ')} WHERE ${pkCol} = ?`, params);
          encrypted++;
        }
      } catch (err) {
        errors++;
        if (errors <= 3) console.log(`  [${table}] Error on ${row[pkCol]}: ${err.message}`);
      }
    }

    offset += rows.length;
    if (encrypted > 0 && encrypted % 100 === 0) {
      console.log(`  [${table}] Progress: ${encrypted} encrypted, ${skipped} skipped, ${errors} errors`);
    }
  }

  console.log(`  [${table}] Done: ${encrypted} encrypted, ${skipped} already encrypted, ${errors} errors`);
  return { encrypted, skipped, errors };
}

// ── Main ──

console.log('\n=== Mycelium Full Encryption Backfill ===\n');

const tables = ONLY_TABLE
  ? { [ONLY_TABLE]: ENCRYPTED_FIELDS[ONLY_TABLE] || [] }
  : ENCRYPTED_FIELDS;

let totalEncrypted = 0, totalSkipped = 0, totalErrors = 0;

for (const [table, fields] of Object.entries(tables)) {
  if (fields.length === 0) continue;
  const result = await backfillTable(table, fields);
  totalEncrypted += result.encrypted;
  totalSkipped += result.skipped;
  totalErrors += result.errors;
}

console.log(`\n=== Complete ===`);
console.log(`  Total encrypted: ${totalEncrypted}`);
console.log(`  Already encrypted: ${totalSkipped}`);
console.log(`  Errors: ${totalErrors}`);
