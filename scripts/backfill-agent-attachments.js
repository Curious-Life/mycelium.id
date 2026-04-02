#!/usr/bin/env node
/**
 * Backfill: Upload agent-sent files to R2 and create document records.
 * Finds attachments with null r2_key that were sent by agents (source: telegram/discord),
 * locates the original files on disk, uploads to R2, and updates records.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const WORKER_URL = process.env.MYA_WORKER_URL;
if (!WORKER_URL) { console.error('MYA_WORKER_URL required'); process.exit(1); }
const WORKER_SECRET = process.env.MYA_WORKER_SECRET;
const AUTH_HEADER = { 'Authorization': `Bearer ${WORKER_SECRET}` };
const USER_ID = process.env.USER_ID;

const AGENT_DIRS = [
  '/home/claude/agents/personal-agent/repo',
  '/home/claude/agents/company-agent/repo',
  '/home/claude/agents/research-agent/repo',
  '/home/claude/agents/commercial-intelligence-agent/repo',
  '/home/claude/agents/publishing-agent/repo',
  '/home/claude/agents/wealth-agent/repo',
  '/home/claude/agents/moms-agent/repo',
  '/home/claude/agents/intel-agent/repo',
];

async function d1Query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) throw new Error(`D1 query failed: ${res.status} ${await res.text()}`);
  return (await res.json()).results || [];
}

async function findFileOnDisk(filename) {
  for (const dir of AGENT_DIRS) {
    try {
      // Search recursively (max 3 levels)
      for (const sub of ['', 'output', 'documents', 'inbox']) {
        const filePath = path.join(dir, sub, filename);
        try {
          await fs.access(filePath);
          return filePath;
        } catch { /* not here */ }
      }
    } catch { /* dir doesn't exist */ }
  }
  return null;
}

async function uploadToR2(filePath, filename) {
  const data = await fs.readFile(filePath);
  const ext = (filename.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
  const textExts = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'log', 'yml', 'yaml'];
  const mimeType = textExts.includes(ext) ? 'text/plain' : 'application/octet-stream';

  const response = await fetch(`${WORKER_URL}/api/store-attachment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
    body: JSON.stringify({
      data: data.toString('base64'),
      userId: USER_ID,
      type: 'file',
      filename,
      mimeType,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`R2 upload failed: ${response.status}`);
  const result = await response.json();
  return { r2Key: result.key, fileSize: data.length, content: textExts.includes(ext) ? data.toString('utf-8') : null };
}

async function main() {
  if (!WORKER_SECRET) { console.error('MYA_WORKER_SECRET required'); process.exit(1); }
  if (!USER_ID) { console.error('USER_ID required'); process.exit(1); }

  // Find agent-sent attachments without R2 keys
  const missing = await d1Query(`
    SELECT a.id, a.file_name, a.metadata
    FROM attachments a
    WHERE a.r2_key IS NULL
      AND a.stream_uid IS NULL
      AND a.file_name IS NOT NULL
      AND json_extract(a.metadata, '$.agent_id') IS NOT NULL
    ORDER BY a.created_at ASC
  `);

  console.log(`Found ${missing.length} agent-sent attachments without R2 keys`);

  let uploaded = 0, docCreated = 0, notFound = 0, errors = 0;

  for (const att of missing) {
    const filename = att.file_name;
    const filePath = await findFileOnDisk(filename);

    if (!filePath) {
      console.log(`  SKIP ${filename} — not found on disk`);
      notFound++;
      continue;
    }

    try {
      const { r2Key, fileSize, content } = await uploadToR2(filePath, filename);

      // Update attachment with R2 key
      await d1Query(
        `UPDATE attachments SET r2_key = ?, file_size = ? WHERE id = ?`,
        [r2Key, fileSize, att.id]
      );
      uploaded++;
      console.log(`  R2  ${filename} → ${r2Key}`);

      // Create document record for text files
      if (content && content.length > 0) {
        const meta = JSON.parse(att.metadata || '{}');
        const agentId = meta.agent_id || 'unknown-agent';
        const docPath = `uploads/${filename}`;
        const docTitle = filename.replace(/\.[^.]+$/, '');

        try {
          await d1Query(
            `INSERT INTO documents (user_id, path, title, content, summary, source_type, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'upload', ?, datetime('now'), datetime('now'))
             ON CONFLICT (user_id, path) DO UPDATE SET content = excluded.content, summary = excluded.summary, created_by = excluded.created_by`,
            [USER_ID, docPath, docTitle, content.substring(0, 50000), content.substring(0, 200), agentId]
          );
          docCreated++;
          console.log(`  DOC ${docPath} (by ${agentId})`);
        } catch (docErr) {
          console.error(`  DOC ERR ${filename}: ${docErr.message}`);
        }
      }
    } catch (err) {
      errors++;
      console.error(`  ERR ${filename}: ${err.message}`);
    }

    // Small delay
    if (uploaded % 5 === 0 && uploaded > 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nDone: ${uploaded} uploaded to R2, ${docCreated} docs created, ${notFound} not found on disk, ${errors} errors`);
}

main().catch(err => { console.error(err); process.exit(1); });
