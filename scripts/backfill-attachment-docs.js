#!/usr/bin/env node
/**
 * Backfill: Create document records for text attachments that are missing them.
 * Fetches content from R2 and inserts into documents table.
 */

const WORKER_URL = process.env.MYA_WORKER_URL;
if (!WORKER_URL) { console.error('MYA_WORKER_URL required'); process.exit(1); }
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const WORKER_SECRET = process.env.MYA_WORKER_SECRET;

const AUTH_HEADER = AGENT_TOKEN
  ? { 'Authorization': `Bearer ${AGENT_TOKEN}` }
  : { 'Authorization': `Bearer ${WORKER_SECRET}` };

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`D1 query failed: ${res.status} ${await res.text()}`);
  return (await res.json()).results || [];
}

async function fetchR2(r2Key) {
  const res = await fetch(`${WORKER_URL}/attachments/${encodeURIComponent(r2Key)}`, {
    headers: { 'Authorization': `Bearer ${WORKER_SECRET}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return res.text();
}

async function main() {
  // Find text attachments without matching documents
  const missing = await d1Query(`
    SELECT a.id, a.file_name, a.file_type, a.r2_key, a.user_id, a.created_at
    FROM attachments a
    WHERE a.r2_key IS NOT NULL
      AND (a.file_type IN ('text', 'file')
           OR a.file_name LIKE '%.txt'
           OR a.file_name LIKE '%.md'
           OR a.file_name LIKE '%.csv'
           OR a.file_name LIKE '%.json'
           OR a.file_name LIKE '%.log'
           OR a.file_name LIKE '%.xml'
           OR a.file_name LIKE '%.html'
           OR a.file_name LIKE '%.py'
           OR a.file_name LIKE '%.js'
           OR a.file_name LIKE '%.ts'
           OR a.file_name LIKE '%.yml'
           OR a.file_name LIKE '%.yaml')
      AND NOT EXISTS (
        SELECT 1 FROM documents d
        WHERE d.path = 'uploads/' || a.file_name
          AND d.user_id = a.user_id
      )
    ORDER BY a.created_at ASC
  `);

  console.log(`Found ${missing.length} text attachments without document records`);

  let created = 0, skipped = 0, errors = 0;

  for (const att of missing) {
    const filename = att.file_name || 'untitled';
    const docPath = `uploads/${filename}`;
    const docTitle = filename.replace(/\.[^.]+$/, '');

    try {
      // Fetch content from R2
      const content = await fetchR2(att.r2_key);
      if (!content || content.length < 1) {
        console.log(`  SKIP ${filename} — empty or fetch failed`);
        skipped++;
        continue;
      }

      // Check for duplicates with same path (different attachment same filename)
      const existing = await d1Query(
        `SELECT id FROM documents WHERE path = ? AND user_id = ?`,
        [docPath, att.user_id]
      );

      let finalPath = docPath;
      if (existing.length > 0) {
        // Add timestamp to deduplicate
        const ts = att.created_at.slice(0, 10);
        finalPath = `uploads/${ts}_${filename}`;
      }

      await d1Query(
        `INSERT INTO documents (user_id, path, title, content, summary, source_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'upload', ?, datetime('now'))`,
        [att.user_id, finalPath, docTitle, content.substring(0, 50000), content.substring(0, 200), att.created_at]
      );

      created++;
      console.log(`  OK ${finalPath} (${content.length} chars)`);
    } catch (err) {
      errors++;
      console.error(`  ERR ${filename}: ${err.message}`);
    }

    // Small delay to avoid hammering
    if (created % 10 === 0 && created > 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped, ${errors} errors`);
}

main().catch(err => { console.error(err); process.exit(1); });
