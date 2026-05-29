#!/usr/bin/env node

/**
 * Generate Cluster Descriptions
 *
 * Uses Workers AI (Llama 4 Scout) to generate names and essences
 * for realms, themes, and territories based on their message content.
 *
 * "Be a librarian, not a poet" — names should be concrete and descriptive.
 *
 * Usage:
 *   node scripts/describe-clusters.js
 *   node scripts/describe-clusters.js --dry-run
 *   node scripts/describe-clusters.js --level realms    # only realms
 *   node scripts/describe-clusters.js --force           # regenerate all
 *
 * Env vars: MYA_WORKER_URL, AGENT_TOKEN_MYA or ADMIN_SECRET
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { initDb, getDb } from '@mycelium/core/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
for (const f of ['.env', '.env.discord', '.env.database', '.env.crypto', '.env.agents', '.env.cloudflare']) {
  config({ path: resolve(root, f) });
}

// Mirror legacy auth fallbacks onto AGENT_TOKEN — see describe-chronicles.js
// for the rationale (canonical authHeaders prefers AGENT_TOKEN; the
// pre-migration code accepted ADMIN_SECRET / AGENT_TOKEN_MYA).
if (!process.env.AGENT_TOKEN) {
  process.env.AGENT_TOKEN = process.env.AGENT_TOKEN_MYA || process.env.ADMIN_SECRET || '';
}

const WORKER_URL = process.env.MYA_WORKER_URL || process.env.WORKER_URL;
const OWNER_ID = process.env.MINDSCAPE_OWNER_ID || process.env.MYA_USER_ID;

if (!WORKER_URL || !process.env.AGENT_TOKEN) {
  console.error('Missing MYA_WORKER_URL or auth token (AGENT_TOKEN / ADMIN_SECRET / AGENT_TOKEN_MYA)');
  process.exit(1);
}
if (!OWNER_ID) {
  console.error('Missing MINDSCAPE_OWNER_ID — set in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const levelIdx = args.indexOf('--level');
const onlyLevel = levelIdx >= 0 ? args[levelIdx + 1] : null;

// Canonical D1 chokepoint — auto-encrypts on write, auto-decrypts on read.
await initDb();
const db = getDb();

const d1Query = (sql, params = []) => db.rawQuery(sql, params);
const d1Run = (sql, params = []) => db.rawQuery(sql, params);

/**
 * Generate a realm/theme/territory description via local Claude CLI.
 *
 * Prior version called the Worker's /api/ai/generate (Cloudflare Workers AI),
 * which would have required sending decrypted plaintext to Cloudflare —
 * incompatible with Swiss Vault's "content stays on-VPS" promise. Using
 * the local Claude CLI keeps the same trust model as describe-chronicles.js:
 * plaintext flows VPS → Anthropic (user's own subscription, TLS-encrypted)
 * and nowhere else.
 */
function generateDescription(prompt, model = 'haiku') {
  return new Promise((resolve, reject) => {
    const claudeBin = process.env.CLAUDE_BIN || '/usr/bin/claude';
    const args = ['-p', '--model', model];
    const child = execFile(claudeBin, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180_000,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude CLI failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 200)}` : ''}`));
      resolve((stdout || '').trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const SYSTEM_PROMPT = `You are a librarian cataloging a knowledge collection. Given sample messages from a cluster of related conversations, generate a short name and essence.

Rules:
- Name: 2-4 words, concrete and descriptive. Like a library section label.
  Good: "Software Engineering", "Family & Parenting", "Financial Planning", "Music Production"
  Bad: "Digital Consciousness", "The Transformation Matrix", "Echoes of Tomorrow"
- Essence: One sentence describing what this cluster is about.

Respond with JSON only:
{"name": "...", "essence": "..."}`;

async function describeCluster(sampleMessages, tags, entities, level) {
  const tagStr = tags.length > 0 ? `\nTop tags: ${tags.join(', ')}` : '';
  const entityStr = entities.length > 0 ? `\nMentioned: ${entities.join(', ')}` : '';

  const prompt = `${SYSTEM_PROMPT}

Level: ${level}
Sample messages (${sampleMessages.length}):
${sampleMessages.map((m, i) => `${i + 1}. ${m.slice(0, 200)}`).join('\n')}
${tagStr}${entityStr}

Respond with JSON:`;

  try {
    const response = await generateDescription(prompt);
    // Try to extract JSON object from response (handles markdown code blocks too)
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : response;
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      parsed._raw_response = response; // Preserve raw LLM output
      return parsed;
    }
  } catch (err) {
    // If AI endpoint doesn't exist yet, generate from tags/entities
    console.warn(`  AI generation failed: ${err.message}`);
  }

  // Fallback: construct from tags
  const name = tags.slice(0, 3).map(t => t.replace(/_/g, ' ')).join(', ') || 'Unnamed';
  const essence = entities.length > 0
    ? `Conversations about ${entities.slice(0, 3).join(', ')}`
    : `Topics: ${tags.slice(0, 5).join(', ')}`;

  return { name, essence };
}

async function getClusterSamples(clusterId, level) {
  const column = `${level}_id`;

  // Pull sample content from all source types so realms/territories made
  // purely of documents or attachments also get named. Content comes from
  // whichever table matches cp.source_type; tags/entities only exist on
  // messages so we LEFT JOIN those.
  const messages = await d1Query(`
    SELECT
      CASE cp.source_type
        WHEN 'message' THEN m.content
        WHEN 'document' THEN d.content
        WHEN 'transcript' THEN a.transcript
        WHEN 'image_description' THEN a.description
      END as content,
      m.tags, m.entities
    FROM clustering_points cp
    LEFT JOIN messages m ON m.id = cp.source_id AND cp.source_type = 'message' AND m.user_id = cp.user_id
    LEFT JOIN documents d ON d.id = cp.source_id AND cp.source_type = 'document' AND d.user_id = cp.user_id
    LEFT JOIN attachments a ON a.id = cp.source_id AND cp.source_type IN ('transcript','image_description') AND a.user_id = cp.user_id
    WHERE cp.${column} = ? AND cp.user_id = ?
    ORDER BY RANDOM()
    LIMIT 20
  `, [clusterId, OWNER_ID]);

  const sampleMessages = messages
    .map(m => m.content || '')
    .filter(c => c.length > 10);

  // Aggregate tags
  const tagCounter = {};
  const entitySet = new Set();

  for (const m of messages) {
    try {
      const tags = typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          tagCounter[t] = (tagCounter[t] || 0) + 1;
        }
      }
    } catch {}

    try {
      const ent = typeof m.entities === 'string' ? JSON.parse(m.entities) : m.entities;
      if (ent && typeof ent === 'object') {
        for (const arr of Object.values(ent)) {
          if (Array.isArray(arr)) {
            for (const e of arr) entitySet.add(e);
          }
        }
      }
    } catch {}
  }

  const topTags = Object.entries(tagCounter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t]) => t);

  return { sampleMessages, topTags, entities: [...entitySet].slice(0, 10) };
}

async function describeRealms() {
  console.log('\n  Describing realms...');

  const realms = await d1Query(`
    SELECT DISTINCT realm_id, COUNT(*) as cnt
    FROM clustering_points
    WHERE realm_id IS NOT NULL AND user_id = ?
    GROUP BY realm_id
    ORDER BY cnt DESC
  `, [OWNER_ID]);

  console.log(`  Found ${realms.length} realms`);

  for (const realm of realms) {
    // Check if already described (unless --force)
    if (!force) {
      const existing = await d1Query(
        `SELECT name FROM realms WHERE realm_id = ? AND user_id = ? AND name IS NOT NULL LIMIT 1`,
        [realm.realm_id, OWNER_ID]
      );
      if (existing.length > 0) {
        console.log(`    Realm ${realm.realm_id}: "${existing[0].name}" (skipped — already named)`);
        continue;
      }
    }

    const { sampleMessages, topTags, entities } = await getClusterSamples(realm.realm_id, 'realm');

    if (sampleMessages.length === 0) {
      console.log(`    Realm ${realm.realm_id}: no messages, skipping`);
      continue;
    }

    const desc = dryRun
      ? { name: `Realm ${realm.realm_id}`, essence: `${realm.cnt} points, tags: ${topTags.slice(0, 5).join(', ')}` }
      : await describeCluster(sampleMessages, topTags, entities, 'realm');

    console.log(`    Realm ${realm.realm_id} (${realm.cnt} pts): "${desc.name}" — ${desc.essence}`);

    if (!dryRun) {
      // Upsert into realms table
      await d1Run(`
        INSERT INTO realms (realm_id, user_id, name, essence, message_count, top_entities, raw_response, generation_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'claude-haiku')
        ON CONFLICT(realm_id, user_id) DO UPDATE SET
          name = excluded.name, essence = excluded.essence,
          message_count = excluded.message_count, top_entities = excluded.top_entities,
          raw_response = excluded.raw_response, generation_model = excluded.generation_model
      `, [realm.realm_id, OWNER_ID, desc.name, desc.essence, realm.cnt,
          JSON.stringify(entities.slice(0, 10)),
          desc._raw_response || JSON.stringify(desc)]);
    }
  }
}

async function describeTerritories() {
  console.log('\n  Describing territories...');

  const territories = await d1Query(`
    SELECT DISTINCT territory_id, realm_id, COUNT(*) as cnt
    FROM clustering_points
    WHERE territory_id IS NOT NULL AND user_id = ?
    GROUP BY territory_id
    ORDER BY cnt DESC
    LIMIT 500
  `, [OWNER_ID]);

  console.log(`  Found ${territories.length} territories`);
  let described = 0;

  for (const terr of territories) {
    if (!force) {
      const existing = await d1Query(
        `SELECT name FROM territory_profiles WHERE territory_id = ? AND user_id = ? AND name IS NOT NULL LIMIT 1`,
        [terr.territory_id, OWNER_ID]
      );
      if (existing.length > 0) {
        continue; // Already named
      }
    }

    if (terr.cnt < 3) continue; // Too small

    const { sampleMessages, topTags, entities } = await getClusterSamples(terr.territory_id, 'territory');

    if (sampleMessages.length === 0) continue;

    const desc = dryRun
      ? { name: `Territory ${terr.territory_id}`, essence: `${terr.cnt} points` }
      : await describeCluster(sampleMessages, topTags, entities, 'territory');

    if (!dryRun) {
      await d1Run(`
        INSERT INTO territory_profiles (territory_id, user_id, name, essence, message_count,
          realm_id, top_entities, raw_response, generation_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claude-haiku')
        ON CONFLICT(territory_id, user_id) DO UPDATE SET
          name = excluded.name, essence = excluded.essence,
          message_count = excluded.message_count,
          realm_id = excluded.realm_id, top_entities = excluded.top_entities,
          raw_response = excluded.raw_response, generation_model = excluded.generation_model
      `, [terr.territory_id, OWNER_ID, desc.name, desc.essence,
          terr.cnt, terr.realm_id, JSON.stringify(entities.slice(0, 10)),
          desc._raw_response || JSON.stringify(desc)]);
    }

    described++;
    if (described % 10 === 0) {
      process.stdout.write(`\r  Described ${described}/${territories.length} territories`);
    }

    // Rate limit AI calls
    if (!dryRun) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n  Described ${described} territories`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Cluster Description Generation              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Force:   ${force}`);

  if (!onlyLevel || onlyLevel === 'realms') await describeRealms();
  if (!onlyLevel || onlyLevel === 'territories') await describeTerritories();

  console.log('\n  Description generation complete.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
