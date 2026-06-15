#!/usr/bin/env node
// Claude Code Stop hook — the PUSH half (EVERY message, both sides).
//
// The transcript JSONL is the complete record of the conversation, so on each
// Stop we SYNC it: capture every human message + assistant text since the last
// sync (high-water mark per session), with full metadata + real timestamps. Bulk
// /ingest/import is idempotent on each entry's transcript `uuid`, so re-syncing
// never duplicates and nothing is missed (incl. intermediate assistant blocks &
// sub-agent turns). Capture is consent-gated server-side (off until the user opts
// in) — fail-open: any error, or a hook with no transcript, just exits 0.
import { importBatch, readStdin } from '../bridge.mjs';
import { parseTranscript } from './transcript.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

try {
  const payload = JSON.parse((await readStdin()) || '{}');
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const path = payload.transcript_path;
  if (!path) process.exit(0);

  // High-water mark: how many transcript lines we've already synced this session.
  const stateDir = join(homedir(), '.mycelium-bridge');
  const hwmFile = join(stateDir, `cc-${sessionId || 'nosession'}.hwm`);
  let sinceLine = 0;
  try { sinceLine = parseInt(readFileSync(hwmFile, 'utf8'), 10) || 0; } catch { /* first sync */ }

  const { items, lastLine } = parseTranscript(path, { sinceLine });
  if (items.length) await importBatch(items);

  // Advance the mark even if nothing was capturable (so we don't re-scan).
  try { mkdirSync(stateDir, { recursive: true }); writeFileSync(hwmFile, String(lastLine)); } catch { /* non-fatal */ }
} catch {
  // fail-silent — capture must never break the session
}
process.exit(0);
