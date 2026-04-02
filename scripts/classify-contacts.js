#!/usr/bin/env node
/**
 * Classify contacts by engagement tier based on outbound message count.
 *
 * Tiers (based on how many messages YOU sent to them):
 *   inner        — 5+ messages sent (deep relationship)
 *   engaged      — 2-4 messages sent (real conversation)
 *   acknowledged — 1 message sent (you replied)
 *   connected    — 0 messages, connection exists
 *   noise        — recruiter/sales, no messages (preserved from import)
 *
 * Usage: node scripts/classify-contacts.js [--dry-run]
 *
 * Env: MYA_WORKER_URL, ADMIN_SECRET (for full-scope decrypted access)
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
  if (!res.ok) throw new Error(`DB error ${res.status}: ${(await res.text()).substring(0, 200)}`);
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
  console.log(`Classifying contacts by engagement (${DRY_RUN ? 'DRY RUN' : 'LIVE'})\n`);

  // Step 1: Compute outbound message counts per conversation
  const convos = await dbQuery(`
    SELECT conversation_id,
      json_extract(metadata, '$.participants') as participants,
      SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as you_sent
    FROM messages WHERE source = 'linkedin'
    GROUP BY conversation_id
  `);

  // Step 2: Aggregate your outbound messages per participant name
  const nameOutbound = new Map();
  for (const c of convos) {
    if (!c.you_sent || !c.participants) continue;
    let names;
    try { names = JSON.parse(c.participants); } catch { continue; }
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      nameOutbound.set(name, (nameOutbound.get(name) || 0) + c.you_sent);
    }
  }
  console.log(`Outbound message data for ${nameOutbound.size} contacts`);

  // Step 3: Get all contacts (decrypted via ADMIN_SECRET)
  const people = await dbQuery(`SELECT id, name, status FROM people WHERE source = 'linkedin'`);
  console.log(`${people.length} LinkedIn contacts in DB\n`);

  // Step 4: Classify each contact
  const tiers = { inner: 0, engaged: 0, acknowledged: 0, connected: 0, noise: 0 };
  const statements = [];

  for (const p of people) {
    const outbound = nameOutbound.get(p.name) || 0;
    let status;

    if (p.status === 'noise' && outbound === 0) {
      status = 'noise';
    } else if (outbound >= 5) {
      status = 'inner';
    } else if (outbound >= 2) {
      status = 'engaged';
    } else if (outbound >= 1) {
      status = 'acknowledged';
    } else {
      status = 'connected';
    }

    tiers[status]++;

    if (status !== p.status || DRY_RUN) {
      statements.push({
        sql: 'UPDATE people SET status = ? WHERE id = ?',
        params: [status, p.id],
      });
    }
  }

  console.log('Tier distribution:');
  console.log(`  inner (5+ sent):       ${tiers.inner}`);
  console.log(`  engaged (2-4 sent):    ${tiers.engaged}`);
  console.log(`  acknowledged (1 sent): ${tiers.acknowledged}`);
  console.log(`  connected (0 sent):    ${tiers.connected}`);
  console.log(`  noise:                 ${tiers.noise}`);
  console.log(`  total:                 ${people.length}`);

  if (DRY_RUN) {
    console.log(`\n(dry run — ${statements.length} updates would be applied)`);
    return;
  }

  // Step 5: Batch update
  console.log(`\nApplying ${statements.length} updates...`);
  for (let i = 0; i < statements.length; i += 50) {
    await dbBatch(statements.slice(i, i + 50));
    process.stdout.write(`  ${Math.min(i + 50, statements.length)}/${statements.length}\r`);
  }
  console.log(`\nDone.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
