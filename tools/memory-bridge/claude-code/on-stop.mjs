#!/usr/bin/env node
// Claude Code Stop hook — the PUSH half (both sides).
//
// Fires when the assistant finishes a turn. The Stop payload does NOT carry the
// reply text, so we read it from the transcript (JSONL at `transcript_path`):
// capture the LAST human `user` message and the LAST `assistant` text of this
// turn, each keyed by its transcript `uuid` so re-runs dedup (capture.js is
// id-keyed). Threaded on `session_id` as the conversationId, source 'claude-code'.
//
// Robustness: skip tool-result `user` entries (they aren't human messages) and
// assistant entries with no text (pure tool_use). Fire-and-forget — capture
// failures never surface. Always exit 0 (Stop cannot block the turn anyway).
import { capture, readStdin } from '../bridge.mjs';
import { readFileSync } from 'node:fs';

const SOURCE = 'claude-code';

// Pull the human-typed text out of a transcript message.content (string | parts[]).
// Returns '' for tool-result-only user entries (not a human message).
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // If ANY part is a tool_result, this is a tool turn, not a human message.
  if (content.some((p) => p && p.type === 'tool_result')) return '';
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
}

// Assistant text = the text parts only (drop thinking / tool_use).
function assistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
}

try {
  const payload = JSON.parse((await readStdin()) || '{}');
  const conversationId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  const path = payload.transcript_path;
  if (!path) process.exit(0);

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) { try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ } }

  // Walk from the end: the last assistant text + the last human user message.
  let lastUser = null, lastAssistant = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const msg = e?.message;
    if (!msg) continue;
    if (!lastAssistant && (e.type === 'assistant' || msg.role === 'assistant')) {
      const t = assistantText(msg.content);
      if (t.trim()) lastAssistant = { id: e.uuid, content: t };
    } else if (!lastUser && (e.type === 'user' || msg.role === 'user')) {
      const t = userText(msg.content);
      if (t.trim()) lastUser = { id: e.uuid, content: t };
    }
    if (lastUser && lastAssistant) break;
  }

  const jobs = [];
  if (lastUser) jobs.push(capture({ content: lastUser.content, role: 'user', conversationId, source: SOURCE, id: lastUser.id }));
  if (lastAssistant) jobs.push(capture({ content: lastAssistant.content, role: 'assistant', conversationId, source: SOURCE, id: lastAssistant.id }));
  await Promise.allSettled(jobs);
} catch {
  // fail silent — capture must never break the session
}
process.exit(0);
