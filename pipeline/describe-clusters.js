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

import { execFile } from 'child_process';
import { promisify } from 'util';

import { getDb } from '../src/db/index.js';

const execFileAsync = promisify(execFile);

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DRY_RUN = process.argv.includes('--dry-run');

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

/**
 * Ask the local Claude CLI to produce a short name + essence for a cluster,
 * given a few representative member snippets. Returns null on any failure so
 * the caller can fall back to a deterministic placeholder.
 */
async function describeWithClaude(kind, samples) {
  const prompt = [
    `You are naming a ${kind} in a personal knowledge graph.`,
    `Below are representative snippets that belong to this ${kind}.`,
    `Reply with EXACTLY one line of JSON: {"name": "<2-4 word title>", "essence": "<one sentence>"}.`,
    '',
    ...samples.map((s, i) => `(${i + 1}) ${s.slice(0, 300)}`),
  ].join('\n');

  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ['-p', prompt], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed.name === 'string') {
      return { name: parsed.name.slice(0, 80), essence: (parsed.essence || '').slice(0, 500) };
    }
  } catch {
    // fall through to placeholder
  }
  return null;
}

async function run() {
  const { db, close } = getDb({ dbPath: DB_PATH, userKey: USER_MASTER, systemKey: SYSTEM_KEY, scope: 'personal' });
  const query = (sql, params = []) => db.rawQuery(sql, params).then(r => (Array.isArray(r) ? r : r.results || []));

  try {
    console.log(`[describe] Naming realms + territories for user=${USER_ID}${DRY_RUN ? ' (dry-run)' : ''}`);

    // ── Realms ──────────────────────────────────────────────────────
    const realmIds = await query(
      `SELECT DISTINCT realm_id FROM clustering_points
       WHERE user_id = ? AND realm_id IS NOT NULL`,
      [USER_ID],
    );
    console.log(`[describe] ${realmIds.length} realms`);

    for (const { realm_id } of realmIds) {
      const samples = await sampleContent(query, 'realm_id', realm_id);
      const described = samples.length ? await describeWithClaude('realm', samples) : null;
      const name = described?.name || `Realm ${realm_id}`;
      const essence = described?.essence || '';
      if (DRY_RUN) {
        console.log(`[describe] (dry) realm ${realm_id} → "${name}"`);
        continue;
      }
      await query(
        `INSERT INTO realms (id, user_id, realm_index, name, essence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, essence = excluded.essence, updated_at = datetime('now')`,
        [`${USER_ID}:realm:${realm_id}`, USER_ID, realm_id, name, essence],
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
      const described = samples.length ? await describeWithClaude('territory', samples) : null;
      const name = described?.name || `Territory ${territory_id}`;
      const essence = described?.essence || '';
      if (DRY_RUN) {
        console.log(`[describe] (dry) territory ${territory_id} → "${name}"`);
        continue;
      }
      await query(
        `INSERT INTO territory_profiles
           (id, user_id, territory_id, realm_id, name, essence, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, essence = excluded.essence,
           realm_id = excluded.realm_id, updated_at = datetime('now')`,
        [`${USER_ID}:territory:${territory_id}`, USER_ID, territory_id, realm_id, name, essence, msgCount],
      ).catch(err => console.error(`[describe] territory ${territory_id} write failed:`, err.message));
    }

    console.log('[describe] Done');
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
