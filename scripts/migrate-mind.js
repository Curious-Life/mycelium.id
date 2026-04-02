#!/usr/bin/env node
/**
 * Migrate Mind State from Supabase to Local Files
 *
 * Pulls Mya's internal model, dreams, flagged items, topology notes,
 * and document index from Supabase → writes to personal-agent/mind/
 *
 * Run once during migration from MYA-0.2 Worker to VPS agent.
 *
 * Usage:
 *   node scripts/migrate-mind.js <agentRoot> <userId>
 *
 * Example:
 *   node scripts/migrate-mind.js ~/agents/personal-agent abc-123-def
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const agentRoot = process.argv[2];
const userId = process.argv[3];

if (!agentRoot || !userId) {
  console.error('Usage: node scripts/migrate-mind.js <agentRoot> <userId>');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const mindDir = path.join(agentRoot, 'mind');

async function writeMind(filename, content) {
  if (!content) return false;
  await fs.mkdir(mindDir, { recursive: true });
  await fs.writeFile(path.join(mindDir, filename), content, 'utf-8');
  console.log(`  ✓ ${filename} (${content.length} chars)`);
  return true;
}

async function getDoc(docPath) {
  const { data, error } = await supabase
    .from('documents')
    .select('content, title, path, summary')
    .eq('user_id', userId)
    .eq('path', docPath)
    .single();

  if (error || !data) return null;
  return data;
}

// ── 1. Internal Model ──────────────────────────────────────────────────────

async function migrateInternalModel() {
  console.log('\n[1/7] Internal Model (internal/model)');
  const doc = await getDoc('internal/model');
  if (doc?.content) {
    await writeMind('model.md', doc.content);
  } else {
    console.log('  ⚠ No internal model found — keeping empty template');
  }
}

// ── 2. Flagged Items ───────────────────────────────────────────────────────

async function migrateFlaggedItems() {
  console.log('\n[2/7] Flagged Items (internal/flagged + internal/reflection_log)');

  // Try explicit flagged doc first
  const flagged = await getDoc('internal/flagged');
  if (flagged?.content) {
    await writeMind('flagged.md', flagged.content);
    return;
  }

  // Extract from reflection log (MYA-0.2 stored flags inline)
  const reflectionLog = await getDoc('internal/reflection_log');
  if (reflectionLog?.content) {
    const regex = /\*\*Something I want to bring up:\*\* ([^\n]+)/g;
    const items = [];
    let match;
    while ((match = regex.exec(reflectionLog.content)) !== null) {
      items.push(match[1].trim());
    }
    if (items.length > 0) {
      const content = `# Things to Bring Up\n\n${items.map(i => `- **${i}**`).join('\n')}`;
      await writeMind('flagged.md', content);
    } else {
      console.log('  ⚠ No flagged items found in reflection log');
    }
  } else {
    console.log('  ⚠ No flagged items or reflection log found');
  }
}

// ── 3. Dreams ──────────────────────────────────────────────────────────────

async function migrateDreams() {
  console.log('\n[3/7] Dreams (states/dreams)');
  const doc = await getDoc('states/dreams');
  if (doc?.content) {
    await writeMind('dreams.md', doc.content);
  } else {
    console.log('  ⚠ No dreams document found');
  }
}

// ── 4. Topology Notes ──────────────────────────────────────────────────────

async function migrateTopologyNotes() {
  console.log('\n[4/7] Topology Notes (internal/topology_notes)');
  const doc = await getDoc('internal/topology_notes');
  if (doc?.content) {
    await writeMind('topology-notes.md', doc.content);
  } else {
    console.log('  ⚠ No topology notes found');
  }
}

// ── 5. Reflection Log ──────────────────────────────────────────────────────

async function migrateReflectionLog() {
  console.log('\n[5/7] Reflection Log (internal/reflection_log)');
  const doc = await getDoc('internal/reflection_log');
  if (doc?.content) {
    await writeMind('reflections.md', doc.content);
  } else {
    console.log('  ⚠ No reflection log found');
  }
}

// ── 6. Synchronicities ─────────────────────────────────────────────────────

async function migrateSynchronicities() {
  console.log('\n[6/7] Synchronicities (phenomena/synchronicities)');
  const doc = await getDoc('phenomena/synchronicities');
  if (doc?.content) {
    await writeMind('synchronicities.md', doc.content);
  } else {
    console.log('  ⚠ No synchronicities document found');
  }
}

// ── 7. Document Index ──────────────────────────────────────────────────────

async function migrateDocumentIndex() {
  console.log('\n[7/7] Document Index (all documents)');

  const { data: docs, error } = await supabase
    .from('documents')
    .select('path, title, summary, is_internal, updated_at')
    .eq('user_id', userId)
    .order('path');

  if (error) {
    console.error('  ✗ Failed to load documents:', error.message);
    return;
  }

  if (!docs?.length) {
    console.log('  ⚠ No documents found');
    return;
  }

  // Build a comprehensive index so Mya knows what exists
  const internal = docs.filter(d => d.is_internal);
  const regular = docs.filter(d => !d.is_internal);

  // Group by folder/category
  const byFolder = {};
  for (const doc of regular) {
    const folder = doc.path.split('/')[0] || 'other';
    if (!byFolder[folder]) byFolder[folder] = [];
    byFolder[folder].push(doc);
  }

  let content = `# Document Index\n\nMigrated from Supabase on ${new Date().toISOString().split('T')[0]}.\n`;
  content += `Total: ${docs.length} documents (${internal.length} internal)\n`;

  content += `\n## Documents by Category\n`;
  for (const [folder, folderDocs] of Object.entries(byFolder).sort()) {
    content += `\n### ${folder}\n\n`;
    for (const d of folderDocs) {
      const updated = d.updated_at ? ` (${d.updated_at.split('T')[0]})` : '';
      content += `- **${d.path}**${updated} — ${d.summary || d.title || 'no summary'}\n`;
    }
  }

  if (internal.length > 0) {
    content += `\n## Internal Documents\n\n`;
    for (const d of internal) {
      const updated = d.updated_at ? ` (${d.updated_at.split('T')[0]})` : '';
      content += `- **${d.path}**${updated} — ${d.summary || d.title || 'no summary'}\n`;
    }
  }

  await writeMind('document-index.md', content);
}

// ── Also migrate core docs that were always in context ─────────────────────

async function migrateCoreContextDocs() {
  console.log('\n[bonus] Core context documents');

  const corePaths = ['core/todo', 'core/communication'];
  for (const docPath of corePaths) {
    const doc = await getDoc(docPath);
    if (doc?.content) {
      const filename = docPath.replace('/', '-') + '.md';
      await writeMind(filename, `# ${doc.title || docPath}\n\n${doc.content}`);
    }
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════');
console.log(' Migrating Mind State: Supabase → Local');
console.log(`═══════════════════════════════════════════`);
console.log(`Agent root: ${agentRoot}`);
console.log(`User ID:    ${userId}`);
console.log(`Mind dir:   ${mindDir}`);

try {
  await migrateInternalModel();
  await migrateFlaggedItems();
  await migrateDreams();
  await migrateTopologyNotes();
  await migrateReflectionLog();
  await migrateSynchronicities();
  await migrateDocumentIndex();
  await migrateCoreContextDocs();

  console.log('\n═══════════════════════════════════════════');
  console.log(' Migration complete!');
  console.log('═══════════════════════════════════════════');
  console.log(`\nFiles written to: ${mindDir}`);
  console.log('Run: cd ' + mindDir + ' && git add -A && git commit -m "migrate from Supabase"');
} catch (err) {
  console.error('\n✗ Migration failed:', err.message);
  process.exit(1);
}
