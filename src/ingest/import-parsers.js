// Import parsers — turn a user's AI-export archive (Claude / ChatGPT) into
// messages funneled through the single captureMessage() choke-point (encrypted
// at rest, deduped on a stable id, enrichment-enqueued).
//
// SECURITY (CLAUDE.md §1, and the import threat model in the complete-UX design):
// these run on attacker-influenceable files. We therefore:
//   • read only the known entry (conversations.json); never enumerate-and-write
//     archive paths to disk → no zip-slip / path traversal surface here.
//   • cap the decompressed JSON size + the number of messages processed.
//   • JSON.parse in try/catch; on any malformed input we skip, never throw raw.
//   • never include file contents in errors (zero-leakage).
//
// The parsers receive a `capture(msg)` fn (a thin wrapper over captureMessage)
// so all storage goes through the audited, encrypting write path — the parser
// module itself never touches the db or crypto directly.

const MAX_JSON_CHARS = 400 * 1024 * 1024; // 400M chars — refuse absurd conversations.json
const MAX_MESSAGES   = 1_000_000;          // bound the work per import

/** Read a zip text entry with a size guard. Returns null if absent/oversized. */
async function readTextEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry) return null;
  const text = await entry.async('string');
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_JSON_CHARS) return null;
  return text;
}

/** Tolerant JSON parse — returns fallback on any malformed input (never throws). */
function safeParse(text, fallback) {
  try { const v = JSON.parse(text); return v ?? fallback; } catch { return fallback; }
}

/**
 * Inspect a loaded JSZip and decide which export it is.
 * @returns {Promise<{ type: 'claude'|'chatgpt'|'obsidian'|'linkedin'|'unknown', conversations?: any[] }>}
 */
export async function detectExportType(zip) {
  // Both Claude and ChatGPT ship a top-level conversations.json; the element
  // shape disambiguates: ChatGPT nodes carry a `mapping` tree, Claude carries
  // `chat_messages`.
  const convText = await readTextEntry(zip, 'conversations.json');
  if (convText) {
    const arr = safeParse(convText, null);
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] || {};
      if (first.mapping && typeof first.mapping === 'object') return { type: 'chatgpt', conversations: arr };
      if (Array.isArray(first.chat_messages)) return { type: 'claude', conversations: arr };
    }
    // Present but unrecognizable — treat as unknown rather than guessing.
    return { type: 'unknown' };
  }
  // Markdown vault → Obsidian (deferred); presence of .md files is the signal.
  const names = Object.keys(zip.files || {});
  if (names.some((n) => n.toLowerCase().endsWith('.md'))) return { type: 'obsidian' };
  if (names.some((n) => /connections\.csv|messages\.csv/i.test(n))) return { type: 'linkedin' };
  return { type: 'unknown' };
}

/** Coerce a Claude chat_message into plain text (handles `text` or content parts). */
function claudeText(m) {
  if (typeof m?.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m?.content)) {
    return m.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n').trim();
  }
  return '';
}

/**
 * Parse a Claude export. `conversations` may be passed (from detect) or read.
 * @param {import('jszip')} zip
 * @param {{ capture: (msg:object)=>Promise<{deduped:boolean}>, conversations?: any[] }} ctx
 */
export async function processClaudeExport(zip, ctx) {
  let conversations = ctx.conversations;
  if (!Array.isArray(conversations)) {
    conversations = safeParse(await readTextEntry(zip, 'conversations.json'), []);
  }
  let imported = 0, skipped = 0, conversationCount = 0, seen = 0;
  for (const conv of conversations) {
    const msgs = Array.isArray(conv?.chat_messages) ? conv.chat_messages : [];
    if (!msgs.length) continue;
    conversationCount += 1;
    const convId = conv.uuid || conv.id || null;
    for (let i = 0; i < msgs.length; i++) {
      if (++seen > MAX_MESSAGES) break;
      const m = msgs[i];
      const content = claudeText(m);
      if (!content) continue;
      const role = m.sender === 'assistant' ? 'assistant' : 'user';
      const id = `claude-${m.uuid || `${convId}-${i}`}`;
      try {
        const { deduped } = await ctx.capture({
          id, content, role, source: 'claude-import', conversationId: convId,
          metadata: { title: conv.name, original_timestamp: m.created_at },
        });
        if (deduped) skipped += 1; else imported += 1;
      } catch { /* skip a bad row; never surface contents */ }
    }
  }
  return { imported, skipped, stats: { messages: imported, conversations: conversationCount, skipped_duplicates: skipped } };
}

/** Walk a ChatGPT mapping tree into time-ordered {role, text, id, create_time}. */
function flattenOpenAIMapping(mapping) {
  const out = [];
  for (const nodeId of Object.keys(mapping || {})) {
    const node = mapping[nodeId];
    const msg = node?.message;
    const role = msg?.author?.role;
    if (!msg || (role !== 'user' && role !== 'assistant')) continue;
    const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
    const text = parts.map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : ''))).filter(Boolean).join('\n').trim();
    if (!text) continue;
    out.push({ id: nodeId, role, text, create_time: msg.create_time || 0 });
  }
  out.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
  return out;
}

/**
 * Parse a ChatGPT export (pre-parsed conversations array from detect).
 * @param {any[]} conversations
 * @param {{ capture: (msg:object)=>Promise<{deduped:boolean}> }} ctx
 */
export async function processOpenAIExport(conversations, ctx) {
  let imported = 0, skipped = 0, conversationCount = 0, seen = 0;
  for (const conv of Array.isArray(conversations) ? conversations : []) {
    const ordered = flattenOpenAIMapping(conv?.mapping);
    if (!ordered.length) continue;
    conversationCount += 1;
    const convId = conv.id || conv.conversation_id || null;
    for (const m of ordered) {
      if (++seen > MAX_MESSAGES) break;
      const id = `chatgpt-${m.id}`;
      try {
        const { deduped } = await ctx.capture({
          id, content: m.text, role: m.role, source: 'chatgpt-import', conversationId: convId,
          metadata: { title: conv.title, original_timestamp: m.create_time },
        });
        if (deduped) skipped += 1; else imported += 1;
      } catch { /* skip a bad row */ }
    }
  }
  return { imported, skipped, stats: { messages: imported, conversations: conversationCount, skipped_duplicates: skipped } };
}
