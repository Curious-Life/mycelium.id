#!/usr/bin/env node
/**
 * Generate realm + territory names/essences from clustered points.
 *
 * Populates `realms` and `territory_profiles` with human-readable names and
 * essences so the portal/3D view has labels. For each unnamed realm/territory,
 * samples representative member messages and asks the LOCAL Claude CLI to name
 * + summarize them — plaintext never leaves the VPS (the canonical design
 * rejected a cloud-model variant for exactly this reason).
 *
 * V1 single-user port:
 *   - Reads/writes the local encrypted SQLite vault via the in-process db
 *     adapter (no Worker proxy, no MINDSCAPE_OWNER_ID / AGENT_ID scope
 *     plumbing). The single user scope is always 'personal'.
 *   - If the Claude CLI is unavailable, falls back to deterministic
 *     placeholder names so the pipeline still completes (fail-soft on the
 *     describe step; the structural clustering is what matters).
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/describe-clusters.js [--dry-run]
 */

import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { createNarrator } from './lib/narrate-infer.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

/**
 * Name + summarize a cluster with the user's ACTIVE provider (the model selected in
 * Settings → Intelligence). Returns null on any failure so the caller can fall back
 * to a deterministic placeholder (fail-soft: a describe miss never blocks Generate).
 */
async function describe(narrator, kind, samples) {
  const prompt = [
    `You are naming a ${kind} in a personal knowledge graph.`,
    `Below are representative snippets that belong to this ${kind}.`,
    `Reply with EXACTLY one line of minified JSON: {"name": "<2-4 word title>", "essence": "<one sentence>"}.`,
    '',
    ...samples.map((s, i) => `(${i + 1}) ${s.slice(0, 300)}`),
  ].join('\n');
  try {
    const raw = await narrator.infer(prompt, { maxTokens: 300 });
    const m = String(raw).match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
      return { name: parsed.name.trim().slice(0, 80), essence: (parsed.essence || '').slice(0, 500) };
    }
  } catch (err) {
    console.error(`[describe] ${kind} narration failed: ${err?.message || err}`);
  }
  return null;
}

async function run() {
  // The encrypting adapter needs imported HKDF CryptoKeys (not raw hex) — writing
  // an ENCRYPTED_FIELDS column (name/essence) otherwise throws deriveBits.
  const [userKey, systemKey] = await Promise.all([loadKey(USER_MASTER), loadKey(SYSTEM_KEY)]);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });
  const query = (sql, params = []) => db.rawQuery(sql, params).then(r => (Array.isArray(r) ? r : r.results || []));
  const narrator = await createNarrator({ db, userId: USER_ID });
  let namedRealms = 0, namedTerr = 0;

  try {
    console.log(`[describe] Naming realms + territories for user=${USER_ID} via ${narrator.label}${narrator.local ? ' (local)' : ''}${DRY_RUN ? ' (dry-run)' : ''}`);

    // ── Realms ──────────────────────────────────────────────────────
    const realmIds = await query(
      `SELECT DISTINCT realm_id FROM clustering_points
       WHERE user_id = ? AND realm_id IS NOT NULL`,
      [USER_ID],
    );
    console.log(`[describe] ${realmIds.length} realms`);

    for (const { realm_id } of realmIds) {
      const samples = await sampleContent(query, 'realm_id', realm_id);
      const described = samples.length ? await describe(narrator, 'realm', samples) : null;
      if (described) namedRealms += 1;
      const name = described?.name || `Realm ${realm_id}`;
      const essence = described?.essence || '';
      if (DRY_RUN) {
        console.log(`[describe] (dry) realm ${realm_id} → "${name}"`);
        continue;
      }
      await query(
        `INSERT INTO realms (user_id, realm_id, name, essence, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, realm_id) DO UPDATE SET name = excluded.name, essence = excluded.essence, updated_at = datetime('now')`,
        [USER_ID, realm_id, name, essence],
      ).catch(err => console.error(`[describe] realm ${realm_id} write failed:`, err.message));
    }

    // ── Territories ─────────────────────────────────────────────────
    const terrIds = await query(
      `SELECT DISTINCT territory_id, realm_id FROM clustering_points
       WHERE user_id = ? AND territory_id IS NOT NULL`,
      [USER_ID],
    );
    console.log(`[describe] ${terrIds.length} territories`);

    for (const { territory_id, realm_id } of terrIds) {
      const samples = await sampleContent(query, 'territory_id', territory_id);
      const msgCount = samples.length;
      const described = samples.length ? await describe(narrator, 'territory', samples) : null;
      if (described) namedTerr += 1;
      const name = described?.name || `Territory ${territory_id}`;
      const essence = described?.essence || '';
      if (DRY_RUN) {
        console.log(`[describe] (dry) territory ${territory_id} → "${name}"`);
        continue;
      }
      await query(
        `INSERT INTO territory_profiles
           (user_id, territory_id, realm_id, name, essence, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, territory_id) DO UPDATE SET name = excluded.name, essence = excluded.essence,
           realm_id = excluded.realm_id, updated_at = datetime('now')`,
        [USER_ID, territory_id, realm_id, name, essence, msgCount],
      ).catch(err => console.error(`[describe] territory ${territory_id} write failed:`, err.message));
    }

    console.log(`[describe] Done — named ${namedRealms}/${realmIds.length} realms · ${namedTerr}/${terrIds.length} territories via ${narrator.label}`);
    if (namedRealms === 0 && realmIds.length > 0) {
      console.error(`[describe] WARNING: named 0 realms — the model (${narrator.label}) returned nothing usable. Check Settings → Intelligence.`);
    }
  } finally {
    close();
  }
}

/**
 * Pull up to 5 decrypted member snippets for a cluster column (realm_id /
 * territory_id). The adapter transparently decrypts messages.content.
 */
async function sampleContent(query, column, value) {
  const rows = await query(
    `SELECT m.content FROM clustering_points cp
     JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message'
     WHERE cp.user_id = ? AND cp.${column} = ?
     ORDER BY m.created_at DESC LIMIT 5`,
    [USER_ID, value],
  ).catch(() => []);
  return rows.map(r => r.content).filter(Boolean);
}

run().catch(err => { console.error('[describe] Fatal:', err); process.exit(1); });
