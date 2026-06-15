// Shared Claude Code transcript parser — turns a JSONL transcript into capture
// items. Used by on-stop.mjs (per-turn sync) and scripts/backfill-claude-code.mjs
// (one-time history import). The transcript IS the complete record, so mapping it
// = capturing every message; idempotency (id=uuid) makes re-walking safe.
//
// Scope: CONVERSATION TEXT only — human user messages + assistant text. Skips
// tool_result user entries, tool_use-only assistant entries, and the meta entry
// types (attachment / queue-operation / last-prompt / ai-title). Preserves
// source, session, real timestamp, and rich metadata (uuid/parentUuid/cwd/
// gitBranch/model/isSidechain/version/userType).
import { readFileSync } from 'node:fs';

// Human-typed text out of message.content (string | parts[]). '' for a
// tool_result-only entry (not a human message).
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some((p) => p && p.type === 'tool_result')) return '';
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
}

// Assistant text only (drop thinking / tool_use).
function assistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
}

/** Map one transcript entry to a capture item, or null if it isn't a conversation message. */
export function entryToItem(e) {
  const msg = e?.message;
  if (!msg || !e?.uuid) return null;
  // Gate strictly on the entry `type` — only real conversation turns. Meta entry
  // types (ai-title / last-prompt / queue-operation / attachment) can carry a
  // message.role of "assistant", so a role-based check would wrongly capture them.
  if (e.type !== 'user' && e.type !== 'assistant') return null;
  const role = e.type;
  const content = role === 'assistant' ? assistantText(msg.content) : userText(msg.content);
  if (!content.trim()) return null;
  return {
    id: e.uuid,
    role,
    content,
    source: e.isSidechain ? 'claude-code/subagent' : 'claude-code',
    conversationId: e.sessionId,
    timestamp: e.timestamp,   // → metadata.original_timestamp
    createdAt: e.timestamp,   // → created_at column (real occurrence time)
    metadata: {
      uuid: e.uuid,
      parentUuid: e.parentUuid,
      sessionId: e.sessionId,
      cwd: e.cwd,
      gitBranch: e.gitBranch,
      model: msg.model,
      isSidechain: !!e.isSidechain,
      version: e.version,
      userType: e.userType,
    },
  };
}

/**
 * Parse a transcript file into capture items, optionally skipping the first
 * `sinceLine` lines (the high-water mark). Returns { items, lastLine } where
 * lastLine is the new high-water mark to persist.
 */
export function parseTranscript(path, { sinceLine = 0 } = {}) {
  let lines;
  try { lines = readFileSync(path, 'utf8').split('\n'); } catch { return { items: [], lastLine: sinceLine }; }
  const items = [];
  for (let i = Math.max(0, sinceLine); i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const item = entryToItem(e);
    if (item) items.push(item);
  }
  return { items, lastLine: lines.length };
}

export default parseTranscript;
