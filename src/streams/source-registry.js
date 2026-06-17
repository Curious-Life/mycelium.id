// src/streams/source-registry.js — the ONE server-side source-of-truth that
// classifies every ingest provenance tag (messages.source / documents.source_type
// / health_daily.source / synthetic 'task') into a stable kind + a canonical key.
//
// Why this exists: the vault ingests ~16 sources, all tagged in a plaintext
// `source` column, but the UI only ever knew 4 (hardcoded in timeline/utils.ts).
// New/unknown sources must self-place to a sensible default (kind 'other') rather
// than vanish. Presentation (icon/color/label) lives client-side
// (portal-app/src/lib/streams/sources.ts); the *kind* and *canonicalisation* are
// decided here so spectrum grouping is identical everywhere it's computed.
//
// Pure + dependency-free so the verify gate can exercise it directly.

/** Stable kind buckets shown as faint groups in the spectrum. */
export const STREAM_KINDS = ['messaging', 'connector', 'knowledge', 'agent', 'device', 'portal', 'task', 'other'];

// Exact-match source → kind. Variants (telegram-group, discord-thread,
// inference:chat) are folded to their canonical key FIRST (see canonicalSource),
// so this table is keyed by canonical sources only.
const KIND_BY_SOURCE = {
  // messaging
  telegram: 'messaging', whatsapp: 'messaging', discord: 'messaging',
  // connectors (adapter ids == the message source tag)
  gmail: 'connector', linear: 'connector',
  // knowledge / imports
  obsidian: 'knowledge', 'claude-import': 'knowledge', 'chatgpt-import': 'knowledge', import: 'knowledge',
  // agents (opt-in capture) + raw MCP captures
  'claude-code': 'agent', gateway: 'agent', opencode: 'agent', openclaw: 'agent', hermes: 'agent', bridge: 'agent', mcp: 'agent',
  // devices / native
  apple: 'device', apple_health: 'device',
  // portal / direct
  portal: 'portal', api: 'portal',
  // synthetic
  task: 'task',
};

// Prefix → kind, checked after exact match. Covers #10's generic connector
// instance ids (http-poll:<uuid>, webhook:<uuid>) and any future namespaced ids.
const KIND_BY_PREFIX = [
  ['http-poll:', 'connector'],
  ['webhook:', 'connector'],
  ['connector:', 'connector'],
];

// Raw source → canonical source (collapse per-platform variants so the spectrum
// shows ONE chip per platform, not one per thread/group flavour).
const CANONICAL = {
  'telegram-group': 'telegram',
  'discord-thread': 'discord',
  'inference:chat': 'portal',
};

// Platform sources carry a per-conversation id suffix (telegram_<chatId>,
// telegram-group_<id>, discord_<channelId>). Strip it so the spectrum shows ONE
// chip per platform, not one per chat. Only the known platform heads are folded
// (gmail / agent ids etc. have no id suffix and must pass through untouched).
const SUFFIXED_HEADS = new Set(['telegram', 'telegram-group', 'discord', 'discord-thread']);

/** Collapse a raw provenance tag to its canonical spectrum key. */
export function canonicalSource(raw) {
  const s = (raw == null || raw === '') ? 'unknown' : String(raw).trim();
  let base = s;
  const us = s.indexOf('_');
  if (us > 0 && SUFFIXED_HEADS.has(s.slice(0, us))) base = s.slice(0, us);
  return CANONICAL[base] || base;
}

/** Classify a RAW source tag → { canonical, kind }. Unknown ⇒ kind 'other'. */
export function classifySource(raw) {
  const canonical = canonicalSource(raw);
  let kind = KIND_BY_SOURCE[canonical];
  if (!kind) {
    for (const [prefix, k] of KIND_BY_PREFIX) {
      if (canonical.startsWith(prefix)) { kind = k; break; }
    }
  }
  return { canonical, kind: kind || 'other' };
}

/** A document `source_type` is a small closed set — fold it onto a source tag. */
export function sourceForDocumentType(sourceType) {
  switch (sourceType) {
    case 'obsidian': return 'obsidian';
    case 'agent': return 'claude-code';
    case 'portal': return 'portal';
    default: return sourceType || 'portal';
  }
}
