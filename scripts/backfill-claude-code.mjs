#!/usr/bin/env node
// One-time backfill of existing Claude Code transcripts into the vault.
//
// Scans ~/.claude/projects/**/*.jsonl, parses each (conversation text only), and
// bulk-imports via the memory bridge — idempotent on each entry's transcript uuid,
// so it's safe to re-run. Capture is consent-gated server-side: if "Memory
// capture" is disabled, imports are a no-op (reported, with a hint to enable).
//
// Usage:
//   MYCELIUM_BASE_URL=http://127.0.0.1:4711 MYCELIUM_MCP_BEARER=<token> \
//     node scripts/backfill-claude-code.mjs [pathSubstringFilter]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseTranscript } from '../tools/memory-bridge/claude-code/transcript.mjs';
import { importBatch, BASE_URL } from '../tools/memory-bridge/bridge.mjs';

if (!process.env.MYCELIUM_MCP_BEARER) {
  console.error('MYCELIUM_MCP_BEARER is not set — start :4711 with a bearer and export it. Aborting.');
  process.exit(1);
}

const root = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const filter = process.argv[2] || '';

// Pacing — a large history (10k+ msgs) imported back-to-back can overwhelm the
// running app (each capture encrypts + inserts + enqueues enrichment). Small
// batches + a delay between them + retry-with-backoff on a failed batch keep it
// gentle and resumable. All env-tunable.
const BATCH = Math.max(1, Number(process.env.MYCELIUM_BACKFILL_BATCH) || 50);
const DELAY_MS = Number.isFinite(Number(process.env.MYCELIUM_BACKFILL_DELAY_MS)) ? Number(process.env.MYCELIUM_BACKFILL_DELAY_MS) : 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findJsonl(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'memory') findJsonl(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

let files = findJsonl(root);
if (filter) files = files.filter((f) => f.includes(filter));
console.log(`Backfill: ${files.length} transcript(s) under ${root}${filter ? ` (filter: "${filter}")` : ''} → ${BASE_URL}`);

console.log(`Pacing: batch=${BATCH}, delay=${DELAY_MS}ms between batches (env MYCELIUM_BACKFILL_BATCH / _DELAY_MS).`);
let transcripts = 0, totalItems = 0, totalNew = 0, totalDup = 0, totalFailed = 0, batches = 0;
for (const f of files) {
  const { items } = parseTranscript(f);
  if (!items.length) continue;
  transcripts += 1;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    totalItems += chunk.length;
    // importBatch returns null on a non-2xx / network error (e.g. the app busy or
    // briefly down). Retry once after a longer back-off before giving up on the
    // batch — a failed batch is just skipped (re-run later; it's idempotent).
    let result = String((await importBatch(chunk)) || '');
    if (!/(\d+) new, (\d+) duplicates/.test(result)) {
      await sleep(2000);
      result = String((await importBatch(chunk)) || '');
    }
    const m = /(\d+) new, (\d+) duplicates/.exec(result);
    if (m) { totalNew += Number(m[1]); totalDup += Number(m[2]); }
    else { totalFailed += chunk.length; process.stdout.write('x'); }
    batches += 1;
    if (batches % 20 === 0) process.stdout.write(` [${totalNew}new/${totalDup}dup/${totalFailed}fail] `);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  process.stdout.write('.');
}
console.log(`\nDone: ${transcripts} transcript(s), ${totalItems} messages → ${totalNew} new, ${totalDup} already present${totalFailed ? `, ${totalFailed} FAILED (app busy/down — re-run to retry, idempotent)` : ''}.`);
if (totalItems > 0 && totalNew === 0 && totalFailed === 0) {
  console.log('\nNote: 0 new captured (and none failed). "Memory capture" is likely DISABLED. Enable it, then re-run:');
  console.log(`  curl -X PUT ${BASE_URL}/portal/agent-capture -H "Authorization: Bearer $MYCELIUM_MCP_BEARER" -H 'content-type: application/json' -d '{"enabled":true}'`);
}
