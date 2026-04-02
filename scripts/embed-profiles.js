#!/usr/bin/env node
/**
 * Embed territory profiles into Vectorize search index.
 * This enables semantic territory search (searchMindscape scope=territories).
 *
 * For each territory profile, generates a BGE-M3 1024D embedding from
 * name + essence + top_entities, then upserts into the search index
 * with type=territory_profile metadata.
 *
 * Usage: cd ~/mycelium && node scripts/embed-profiles.js
 */

import 'dotenv/config';

const URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.AGENT_TOKEN_MYA || process.env.ADMIN_SECRET;
const USER_ID = process.env.MYA_USER_ID;

if (!URL || !TOKEN || !USER_ID) {
  console.error('Missing: MYA_WORKER_URL, AGENT_TOKEN_MYA/ADMIN_SECRET, MYA_USER_ID');
  process.exit(1);
}

const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };

async function query(sql, params = []) {
  const r = await fetch(`${URL}/api/db/query`, { method: 'POST', headers: h, body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Query failed: ${r.status}`);
  return (await r.json()).results || [];
}

async function embed(text) {
  const r = await fetch(`${URL}/api/embed`, { method: 'POST', headers: h, body: JSON.stringify({ text }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Embed failed: ${r.status}`);
  return (await r.json()).embedding;
}

async function vectorUpsert(vectors) {
  const r = await fetch(`${URL}/api/vectors/upsert`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ index: 'search', vectors }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Vector upsert failed: ${r.status}`);
  return r.json();
}

async function run() {
  const profiles = await query(
    `SELECT id, territory_id, name, essence, top_entities, message_count, realm_id
     FROM territory_profiles WHERE user_id = ? ORDER BY message_count DESC`,
    [USER_ID]
  );

  console.log(`[embed-profiles] ${profiles.length} profiles to embed`);

  let embedded = 0, failed = 0;
  const BATCH = 3; // Small batches to respect Workers AI rate limits

  for (let i = 0; i < profiles.length; i += BATCH) {
    // Rate limit: pause between batches
    if (i > 0) await new Promise(r => setTimeout(r, 500));
    const batch = profiles.slice(i, i + BATCH);
    const vectors = [];

    for (const p of batch) {
      try {
        // Build text for embedding: name + essence + entities
        if (!p.name) { failed++; continue; } // Skip empty profiles
        const parts = [p.name];
        if (p.essence) parts.push(p.essence);
        if (p.top_entities) parts.push(p.top_entities);
        const text = parts.join('. ').slice(0, 2000);

        const embedding = await embed(text);
        if (!embedding?.length) { failed++; continue; }

        vectors.push({
          id: p.id,
          values: embedding,
          metadata: {
            type: 'territory_profile',
            userId: USER_ID,
            territoryId: p.territory_id,
            realmId: p.realm_id,
            name: p.name,
          },
        });
        embedded++;
      } catch (err) {
        console.error(`  Failed T${p.territory_id}: ${err.message}`);
        failed++;
      }
    }

    if (vectors.length > 0) {
      try {
        await vectorUpsert(vectors);
      } catch (err) {
        console.error(`  Batch upsert failed at ${i}: ${err.message}`);
        failed += vectors.length;
        embedded -= vectors.length;
      }
    }

    if ((i + BATCH) % 50 === 0 || i + BATCH >= profiles.length) {
      console.log(`[embed-profiles] ${embedded}/${profiles.length} embedded, ${failed} failed`);
    }
  }

  console.log(`[embed-profiles] Done: ${embedded} embedded, ${failed} failed`);
}

run().catch(err => { console.error('[embed-profiles] Fatal:', err); process.exit(1); });
