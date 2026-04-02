#!/usr/bin/env node
/**
 * Deduplicate people table.
 * Encryption creates different ciphertext per insert, breaking unique constraints.
 * This script reads decrypted names via ADMIN_SECRET, keeps the best row per name,
 * and deletes duplicates.
 *
 * Usage: node scripts/dedup-contacts.js [--dry-run]
 * Env: MYA_WORKER_URL, ADMIN_SECRET
 */

import 'dotenv/config';

const WORKER_URL = process.env.MYA_WORKER_URL;
const SECRET = process.env.ADMIN_SECRET;
const DRY_RUN = process.argv.includes('--dry-run');

if (!WORKER_URL || !SECRET) {
  console.error('Required: MYA_WORKER_URL, ADMIN_SECRET');
  process.exit(1);
}

async function dbQuery(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET}` },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`DB error ${res.status}`);
  return (await res.json()).results || [];
}

async function dbBatch(statements) {
  const res = await fetch(`${WORKER_URL}/api/db/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET}` },
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) throw new Error(`DB batch error ${res.status}`);
}

async function main() {
  console.log(`Deduplicating contacts (${DRY_RUN ? 'DRY RUN' : 'LIVE'})\n`);

  const all = await dbQuery(
    `SELECT id, name, interaction_count, created_at FROM people WHERE source = 'linkedin' ORDER BY name, interaction_count DESC`
  );
  console.log(`Total rows: ${all.length}`);

  // Group by decrypted name — keep the row with highest interaction_count
  const byName = new Map();
  for (const p of all) {
    if (!byName.has(p.name)) {
      byName.set(p.name, p);
    }
  }

  const keepIds = new Set([...byName.values()].map(p => p.id));
  const deleteIds = all.filter(p => !keepIds.has(p.id)).map(p => p.id);

  console.log(`Unique names: ${byName.size}`);
  console.log(`Duplicates: ${deleteIds.length}\n`);

  if (deleteIds.length === 0) {
    console.log('No duplicates found.');
    return;
  }

  if (DRY_RUN) {
    console.log(`(dry run — would delete ${deleteIds.length} duplicate rows)`);
    return;
  }

  // Delete in batches of 50
  const BATCH = 50;
  for (let i = 0; i < deleteIds.length; i += BATCH) {
    const batch = deleteIds.slice(i, i + BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    await dbQuery(`DELETE FROM people WHERE id IN (${placeholders})`, batch);
    process.stdout.write(`  Deleted ${Math.min(i + BATCH, deleteIds.length)}/${deleteIds.length}\r`);
  }

  console.log(`\nDeleted ${deleteIds.length} duplicates. ${byName.size} unique contacts remain.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
