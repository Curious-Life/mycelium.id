#!/usr/bin/env node

/**
 * Supabase → D1 Data Migration Script
 *
 * Exports all data from Supabase and imports it to D1 via the MYA Worker proxy.
 * Also re-embeds content with BGE-M3 and upserts to Vectorize.
 *
 * Usage:
 *   node scripts/migrate-to-d1.js                    # full migration (rows + vectors)
 *   node scripts/migrate-to-d1.js --rows-only         # row migration only (skip vectors)
 *   node scripts/migrate-to-d1.js --embed-only        # vectors only (skip row migration)
 *   node scripts/migrate-to-d1.js --table messages    # single table
 *   node scripts/migrate-to-d1.js --dry-run           # show counts, don't write
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MYA_WORKER_URL, MYA_WORKER_SECRET
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_URL = process.env.MYA_WORKER_URL;
const WORKER_SECRET = process.env.MYA_WORKER_SECRET;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!WORKER_URL || !WORKER_SECRET) {
  console.error('Missing MYA_WORKER_URL or MYA_WORKER_SECRET');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const embedOnly = args.includes('--embed-only');
const rowsOnly = args.includes('--rows-only');
const tableFlag = args.indexOf('--table');
const singleTable = tableFlag >= 0 ? args[tableFlag + 1] : null;

// ── D1 Proxy Helpers ────────────────────────────────────────────────────────

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`D1 query failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function d1Batch(statements) {
  const res = await fetch(`${WORKER_URL}/api/db/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`D1 batch failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function vectorUpsert(index, vectors) {
  const res = await fetch(`${WORKER_URL}/api/vectors/upsert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify({ index, vectors }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vectorize upsert failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function embed(text) {
  const res = await fetch(`${WORKER_URL}/api/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WORKER_SECRET}`,
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const data = await res.json();
  return data.embedding || data.data?.[0]?.embedding;
}

// ── Table Migration ─────────────────────────────────────────────────────────

// Column name → D1 column name mappings (for schema simplifications)
// Most are 1:1 since we kept the same column names

const TABLES = [
  // Core
  'messages',
  'documents',
  'document_versions',
  'clustering_points',
  // Mindscape
  'realms',
  'semantic_themes',
  'territory_profiles',
  'theme_cards',
  // Co-firing
  'territory_cofire',
  'territory_neighbors',
  'realm_neighbors',
  // Knowledge
  'internal_model_items',
  'reflections',
  'cycle_metrics',
  // Canvas
  'canvas_workspaces',
  'canvas_edges',
  'canvas_collaborators',
  // Entities
  'people',
  'note_links',
  // Auth
  'users',
  'sessions',
  'registration_tokens',
  'passkey_credentials',
  'share_links',
  // Agent
  'agent_events',
  'agent_tasks',
  'user_identities',
  'oauth_states',
  // Jobs
  'batch_jobs',
  'import_jobs',
  'scheduled_events',
  'tasks',
  'folders',
  'attachments',
];

// JSON columns that need to be stringified for D1 (TEXT not jsonb)
const JSON_COLUMNS = new Set([
  'tags', 'metadata', 'entities', 'relations', 'context', 'result',
  'settings', 'payload', 'params', 'aliases', 'territory_ids',
  'top_entities', 'signature_patterns', 'uncertainty_open_questions',
  'neighbors', 'agent_can_help_with', 'agent_would_consult',
  'items_created', 'sample_message_ids',
]);

// Cache of D1 table columns (fetched once per table via PRAGMA)
const d1ColumnCache = new Map();

async function getD1Columns(tableName) {
  if (d1ColumnCache.has(tableName)) return d1ColumnCache.get(tableName);
  const { results } = await d1Query(`PRAGMA table_info(${tableName})`);
  const cols = new Set(results.map(r => r.name));
  d1ColumnCache.set(tableName, cols);
  return cols;
}

async function getRowCount(tableName) {
  // Try exact count first, fall back to estimated for large tables
  const { count: exactCount, error: countErr } = await supabase
    .from(tableName)
    .select('*', { count: 'exact', head: true });

  if (countErr && countErr.message) return { count: null, error: countErr.message };
  if (exactCount != null) return { count: exactCount };

  const { count: estCount } = await supabase
    .from(tableName)
    .select('id', { count: 'estimated', head: true });
  if (estCount != null) return { count: estCount, estimated: true };

  // Last resort
  const { data: probe } = await supabase.from(tableName).select('id').limit(1);
  if (!probe || probe.length === 0) return { count: 0 };
  return { count: 100000, unknown: true };
}

async function migrateTable(tableName) {
  console.log(`\n── ${tableName} ──`);

  const { count, error: countError, estimated, unknown } = await getRowCount(tableName);

  if (countError) {
    console.log(`  Supabase error: ${countError} (table may not exist)`);
    return;
  }
  if (estimated) console.log(`  (using estimated count)`);
  if (unknown) console.log(`  Supabase rows: unknown (will fetch until empty)`);
  else console.log(`  Supabase rows: ${count}`);

  if (dryRun || count === 0) return;

  // Get D1 column names for this table — only insert columns D1 knows about
  const d1Cols = await getD1Columns(tableName);
  console.log(`  D1 columns: ${d1Cols.size}`);

  // Fetch all rows in batches
  const BATCH = 500;
  let migrated = 0;

  for (let offset = 0; offset < count; offset += BATCH) {
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .order('id', { ascending: true })
      .range(offset, offset + BATCH - 1);

    if (error) {
      console.error(`  Fetch error at offset ${offset}: ${error.message}`);
      continue;
    }

    if (!data?.length) break;

    // Build batch INSERT statements
    const statements = [];
    for (const row of data) {
      const filtered = {};
      for (const [key, value] of Object.entries(row)) {
        // Only include columns that exist in D1 schema
        if (!d1Cols.has(key)) continue;
        if (value === null || value === undefined) continue;

        // Stringify JSON/object columns for D1
        if (typeof value === 'object') {
          filtered[key] = JSON.stringify(value);
        } else if (typeof value === 'boolean') {
          filtered[key] = value ? 1 : 0;
        } else {
          filtered[key] = value;
        }
      }

      if (Object.keys(filtered).length === 0) continue;

      const cols = Object.keys(filtered).join(', ');
      const placeholders = Object.keys(filtered).map(() => '?').join(', ');
      statements.push({
        sql: `INSERT OR IGNORE INTO ${tableName} (${cols}) VALUES (${placeholders})`,
        params: Object.values(filtered),
      });
    }

    // Execute in sub-batches of 50 (D1 batch limit)
    const D1_BATCH = 50;
    for (let i = 0; i < statements.length; i += D1_BATCH) {
      const batch = statements.slice(i, i + D1_BATCH);
      try {
        await d1Batch(batch);
        migrated += batch.length;
      } catch (err) {
        console.error(`  D1 batch error at ${offset + i}: ${err.message}`);
      }
    }

    process.stdout.write(`  Migrated: ${migrated}/${count}\r`);
  }

  console.log(`  Migrated: ${migrated}/${count} ✓`);
}

// ── Merged Table Migrations ─────────────────────────────────────────────────

/**
 * Migrate canvas_workspace_nodes + canvas_positions + canvas_node_sizes → canvas_nodes
 */
async function migrateCanvasNodes() {
  console.log('\n── canvas_nodes (merged from workspace_nodes + positions + sizes) ──');

  const { data: nodes, count, error } = await supabase
    .from('canvas_workspace_nodes')
    .select('*', { count: 'exact' });

  if (error) {
    console.log(`  Supabase error: ${error.message} (table may not exist)`);
    return;
  }

  console.log(`  Supabase canvas_workspace_nodes: ${count}`);
  if (dryRun || !nodes?.length) return;

  // Fetch positions and sizes for merging (tables may not exist)
  const posResult = await supabase.from('canvas_positions').select('*');
  const positions = posResult.error ? [] : (posResult.data || []);
  const sizeResult = await supabase.from('canvas_node_sizes').select('*');
  const sizes = sizeResult.error ? [] : (sizeResult.data || []);

  const posMap = new Map(positions.map(p => [p.node_id || p.id, p]));
  const sizeMap = new Map(sizes.map(s => [s.node_id || s.id, s]));

  const statements = [];
  for (const node of nodes) {
    const pos = posMap.get(node.id) || {};
    const size = sizeMap.get(node.id) || {};

    const row = {
      id: node.id,
      workspace_id: node.workspace_id,
      user_id: node.user_id,
      node_type: node.node_type,
      ref_id: node.ref_id,
      position_x: pos.position_x ?? pos.x ?? 0,
      position_y: pos.position_y ?? pos.y ?? 0,
      width: size.width ?? null,
      height: size.height ?? null,
      metadata: node.metadata ? JSON.stringify(node.metadata) : null,
      created_at: node.created_at,
    };

    const filtered = Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== null && v !== undefined)
    );
    const cols = Object.keys(filtered).join(', ');
    const placeholders = Object.keys(filtered).map(() => '?').join(', ');
    statements.push({
      sql: `INSERT OR IGNORE INTO canvas_nodes (${cols}) VALUES (${placeholders})`,
      params: Object.values(filtered),
    });
  }

  const D1_BATCH = 50;
  let migrated = 0;
  for (let i = 0; i < statements.length; i += D1_BATCH) {
    const batch = statements.slice(i, i + D1_BATCH);
    try {
      await d1Batch(batch);
      migrated += batch.length;
    } catch (err) {
      console.error(`  D1 batch error: ${err.message}`);
    }
  }
  console.log(`  Migrated: ${migrated}/${count} canvas nodes ✓`);
}

/**
 * Migrate document_access + message_access + attachment_access → access_grants
 */
async function migrateAccessGrants() {
  console.log('\n── access_grants (merged from document_access + message_access + attachment_access) ──');

  const sources = [
    { table: 'document_access', entityType: 'document', entityIdCol: 'document_id' },
    { table: 'message_access', entityType: 'message', entityIdCol: 'message_id' },
    { table: 'attachment_access', entityType: 'attachment', entityIdCol: 'attachment_id' },
  ];

  let totalMigrated = 0;

  for (const { table, entityType, entityIdCol } of sources) {
    const { data, count, error } = await supabase
      .from(table)
      .select('*', { count: 'exact' });

    if (error) {
      console.log(`  ${table}: skip (${error.message})`);
      continue;
    }

    console.log(`  ${table}: ${count} rows`);
    if (dryRun || !data?.length) continue;

    const statements = data.map(row => ({
      sql: `INSERT OR IGNORE INTO access_grants (entity_type, entity_id, user_id, access_level, via_canvas_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        entityType,
        row[entityIdCol] || row.entity_id,
        row.user_id,
        row.access_level || 'view',
        row.via_canvas_id || null,
        row.created_at,
      ],
    }));

    const D1_BATCH = 50;
    for (let i = 0; i < statements.length; i += D1_BATCH) {
      const batch = statements.slice(i, i + D1_BATCH);
      try {
        await d1Batch(batch);
        totalMigrated += batch.length;
      } catch (err) {
        console.error(`  D1 batch error (${table}): ${err.message}`);
      }
    }
  }

  console.log(`  Migrated: ${totalMigrated} access grants ✓`);
}

// ── Vector Migration (extract existing embeddings → Vectorize) ──────────────

/**
 * Parse a Supabase vector column (returned as JSON string "[0.1, 0.2, ...]")
 */
function parseVector(val) {
  if (!val) return null;
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
}

/**
 * Copy existing BGE-M3 1024D embeddings from messages → Vectorize search index.
 * Only copies rows that already have embeddings. Missing ones can be filled later.
 */
async function migrateMessageVectors() {
  console.log('\n── Copying message embeddings → Vectorize (search) ──');

  const { count } = await getRowCount('messages');
  if (!count) { console.log('  No messages'); return; }

  const BATCH = 100;
  let copied = 0;
  let skipped = 0;

  for (let offset = 0; offset < count; offset += BATCH) {
    const { data } = await supabase
      .from('messages')
      .select('id, embedding, user_id, agent_id')
      .not('embedding', 'is', null)
      .range(offset, offset + BATCH - 1);

    if (!data?.length) break;

    const vectors = [];
    for (const msg of data) {
      const values = parseVector(msg.embedding);
      if (!values || values.length !== 1024) { skipped++; continue; }

      vectors.push({
        id: msg.id,
        values,
        metadata: {
          type: 'message',
          userId: msg.user_id || '',
          agentId: msg.agent_id || '',
        },
      });
    }

    if (vectors.length > 0) {
      try {
        await vectorUpsert('search', vectors);
        copied += vectors.length;
      } catch (err) {
        console.error(`  Vectorize upsert failed: ${err.message}`);
      }
    }

    process.stdout.write(`  Copied: ${copied} (skipped ${skipped})\r`);
  }

  console.log(`  Copied: ${copied} message vectors (skipped ${skipped}) ✓`);
}

/**
 * Copy existing document embeddings → Vectorize search index.
 */
async function migrateDocumentVectors() {
  console.log('\n── Copying document embeddings → Vectorize (search) ──');

  const { data, error } = await supabase
    .from('documents')
    .select('id, embedding, user_id')
    .not('embedding', 'is', null);

  if (error || !data?.length) {
    console.log(`  No document embeddings found`);
    return;
  }

  const vectors = [];
  for (const doc of data) {
    const values = parseVector(doc.embedding);
    if (!values || values.length !== 1024) continue;
    vectors.push({
      id: doc.id,
      values,
      metadata: { type: 'document', userId: doc.user_id || '' },
    });
  }

  if (vectors.length > 0) {
    await vectorUpsert('search', vectors);
  }
  console.log(`  Copied: ${vectors.length} document vectors ✓`);
}

/**
 * Generate fresh embeddings for territory_profiles, realms, semantic_themes
 * (these don't have stored embedding columns — only ~300 rows total, fast).
 */
async function embedSmallTables() {
  const tables = [
    { name: 'territory_profiles', type: 'territory_profile', fields: 'id, name, essence, user_id' },
    { name: 'realms', type: 'realm', fields: 'id, name, essence, user_id' },
    { name: 'semantic_themes', type: 'semantic_theme', fields: 'id, name, essence, user_id' },
  ];

  for (const { name, type, fields } of tables) {
    console.log(`\n── Embedding ${name} → Vectorize (search) ──`);

    const { data, count } = await supabase
      .from(name)
      .select(fields, { count: 'exact' });

    console.log(`  Total: ${count}`);
    if (dryRun || !data?.length) continue;

    const vectors = [];
    for (const row of data) {
      const text = [row.name, row.essence].filter(Boolean).join('\n');
      if (text.length < 5) continue;

      try {
        const embedding = await embed(text);
        if (embedding) {
          vectors.push({
            id: row.id,
            values: embedding,
            metadata: { type, userId: row.user_id || '' },
          });
        }
      } catch { /* best effort */ }

      // Rate limit Workers AI
      if (vectors.length % 10 === 0 && vectors.length > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Upsert in batches of 50 (avoid payload size limits)
    const VBATCH = 50;
    let upserted = 0;
    for (let i = 0; i < vectors.length; i += VBATCH) {
      const batch = vectors.slice(i, i + VBATCH);
      try {
        await vectorUpsert('search', batch);
        upserted += batch.length;
      } catch (err) {
        console.error(`  Vectorize batch error: ${err.message}`);
      }
    }
    console.log(`  Embedded: ${upserted}/${vectors.length} ${name} ✓`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Supabase → D1 + Vectorize Migration        ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Worker:   ${WORKER_URL}`);
  console.log(`  Dry run:  ${dryRun}`);
  console.log(`  Mode:     ${embedOnly ? 'vectors only' : rowsOnly ? 'rows only' : 'full'}`);
  if (singleTable) console.log(`  Table:    ${singleTable}`);
  console.log('');

  // Verify D1 is reachable
  try {
    await d1Query('SELECT 1 as ok');
    console.log('  D1 connection: ✓');
  } catch (err) {
    console.error(`  D1 connection failed: ${err.message}`);
    process.exit(1);
  }

  // Phase 1: Row migration
  if (!embedOnly) {
    console.log('\n═══ Phase 1: Row Migration ═══');
    const tablesToMigrate = singleTable ? [singleTable] : TABLES;
    for (const table of tablesToMigrate) {
      await migrateTable(table);
    }

    // Merged tables (special handling for schema simplification)
    if (!singleTable) {
      await migrateCanvasNodes();
      await migrateAccessGrants();
    }
  }

  // Phase 2: Copy existing embeddings → Vectorize
  if (!rowsOnly) {
    console.log('\n═══ Phase 2: Vector Migration → Vectorize ═══');
    await migrateMessageVectors();
    await migrateDocumentVectors();
    await embedSmallTables(); // territory_profiles, realms, semantic_themes (~300 rows)
  }

  console.log('\n✓ Migration complete');
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
