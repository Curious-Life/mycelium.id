// Import parsers — turn a user's AI-export archive (Claude / ChatGPT) into
// messages funneled through the single captureMessage() choke-point (encrypted
// at rest, deduped on a stable id, enrichment-enqueued).
//
// SECURITY (CLAUDE.md §1, and the import threat model in the complete-UX design):
// these run on attacker-influenceable files. We therefore:
//   • read only entries we RESOLVED from this archive's own listing (a
//     conversations.json / manifest.json at any depth, or the bundle allowlist);
//     an entry name is a lookup key, never a filesystem path, and archive bytes
//     are never written to disk → no zip-slip / path traversal surface here.
//   • cap the decompressed JSON size + the number of messages processed.
//   • JSON.parse in try/catch; on any malformed input we skip, never throw raw.
//   • never include file contents in errors (zero-leakage).
//
// The parsers receive a `capture(msg)` fn (a thin wrapper over captureMessage)
// so all storage goes through the audited, encrypting write path — the parser
// module itself never touches the db or crypto directly.

import {
  findEntryByBasename, findEntriesByBasename, ambiguousEntryError, isBundleEntry,
  isVaultManifest, isRatioBomb,
} from './archive-entries.js';

const MAX_JSON_BYTES = Number(process.env.MYCELIUM_IMPORT_MAX_JSON_BYTES) || 384 * 1024 * 1024;  // cap on conversations.json (bytes)
const MAX_MESSAGES   = Number(process.env.MYCELIUM_IMPORT_MAX_MESSAGES) || 5_000_000;            // bound the work per import
const MAX_ENTRIES    = Number(process.env.MYCELIUM_IMPORT_MAX_ENTRIES) || 500_000;               // archive entry-count cap
// Per-entry inflation cap for the `bundle` kind (a document/photo, not a vault).
export const BUNDLE_MAX_ENTRY_BYTES = Number(process.env.MYCELIUM_IMPORT_BUNDLE_MAX_ENTRY_BYTES) || 100 * 1024 * 1024;

/**
 * Reject an archive with a pathological number of entries BEFORE any per-entry
 * work. JSZip.loadAsync parses the whole central directory into `zip.files`, so a
 * crafted zip with millions of tiny entries is an OOM/CPU bomb that the per-entry
 * byte caps never catch. Throws { code: 'TOO_MANY_ENTRIES' }; callers map to a
 * clean 4xx. Bound is env-overridable for a legitimately huge vault.
 * @param {object} zip  a loaded JSZip
 * @returns {number}    the entry count (when within bound)
 */
export function assertEntryCount(zip, max = MAX_ENTRIES) {
  const n = zip?.files ? Object.keys(zip.files).length : 0;
  if (n > max) {
    const e = new Error(`archive entry count ${n} exceeds the import cap (${max})`);
    e.code = 'TOO_MANY_ENTRIES';
    throw e;
  }
  return n;
}

/**
 * Read a zip text entry (utf8), hard-capping inflated bytes. Two independent layers so
 * a decompression bomb can never exhaust memory:
 *   1) fast reject using the entry's DECLARED uncompressed size (central
 *      directory) before inflating — kills honest bombs for ~free; and
 *   2) a STREAMING byte counter that aborts inflation the instant the output
 *      passes MAX_JSON_BYTES — bounds memory even if the header lies low or a
 *      future jszip drops the internal size field (layer 1 is then a no-op and
 *      layer 2 still holds). Returns null if the entry is absent or oversized.
 */
function readTextEntry(zip, name) {
  return readEntryBytes(zip, name, MAX_JSON_BYTES).then((b) => (b === null || b.length === 0 ? null : b.toString('utf8')));
}

/**
 * Read a zip entry as BYTES under a THREE-layer bomb guard:
 *   layer 0  decompression-RATIO reject on the declared size pair (shared with
 *            the streaming reader — archive-entries.js `isRatioBomb`). The
 *            buffered reader had NO ratio guard at all before QA6 P7's review:
 *            an 8MB honest 1000:1 archive could inflate the whole 8GB budget.
 *   layer 1  fast reject on the DECLARED uncompressed size (free, but a bomb
 *            lies here, so it is a pre-filter — never the guarantee).
 *   layer 2  the OBSERVED-byte counter — the load-bearing one (repo lesson:
 *            "bomb guard: declared-size is masked").
 * `onRead(total)` reports the bytes we ACTUALLY pulled, refused or not, so a
 * caller can charge attempted inflation against its budget (FIX 2) and a gate
 * can OBSERVE each layer independently (an error/`null` cannot: every layer
 * returns the same `null`).
 * Returns null when the entry is absent, unreadable, or exceeds `maxBytes`.
 * @returns {Promise<Buffer|null>}
 */
export function readEntryBytes(zip, name, maxBytes = MAX_JSON_BYTES, { onRead } = {}) {
  const report = (n) => { try { onRead?.(n); } catch { /* accounting must never break an import */ } };
  const entry = zip.file(name);
  if (!entry) { report(0); return Promise.resolve(null); }
  let declared = entry?._data?.uncompressedSize;
  if (typeof declared === 'number' && declared < 0) declared >>>= 0;  // signed u32 -> a >2GiB bomb reads negative
  // layer 0 — ratio
  if (isRatioBomb(declared, entry?._data?.compressedSize)) { report(0); return Promise.resolve(null); }
  // layer 1 — declared size
  if (typeof declared === 'number' && declared > maxBytes) { report(0); return Promise.resolve(null); }
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; report(total); resolve(v); } };
    let stream;
    try { stream = entry.nodeStream('nodebuffer'); } catch { return finish(null); }
    stream.on('data', (chunk) => {
      // LAYER 2 — counts the bytes actually READ, so a header declaring a small
      // size (layer 1's input) cannot buy an unbounded inflation.
      total += chunk.length;
      if (total > maxBytes) { try { stream.destroy(); } catch { /* noop */ } return finish(null); }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)));
    stream.on('error', () => finish(null));
    stream.on('close', () => finish(null)); // aborted/destroyed without 'end'
  });
}

// How many same-basename `manifest.json` candidates we will OPEN to decide
// whether an archive is a nested vault export. A plain bundle can legitimately
// contain many manifest.json files (npm packages, web-app builds), so the probe
// is bounded — bounded work, and the honest-refusal answer only needs ONE hit.
const NESTED_MANIFEST_PROBES = Number(process.env.MYCELIUM_IMPORT_NESTED_MANIFEST_PROBES) || 25;

/**
 * Does any NON-ROOT `manifest.json` in this archive declare a Mycelium vault
 * export? Shared by the buffered (JSZip) and streaming (yauzl) detectors so both
 * refuse a nested vault export identically instead of importing it as a bundle
 * (QA6 P7 review FIX 1 — silent data loss on a RESTORE path).
 * @param {(name:string)=>Promise<string|null>} readText  capped text reader for this archive
 * @param {string[]} names
 */
export async function hasNestedVaultManifest(readText, names) {
  const candidates = findEntriesByBasename(names, 'manifest.json')
    .filter((n) => n !== 'manifest.json')
    .slice(0, NESTED_MANIFEST_PROBES);
  for (const n of candidates) {
    let text = null;
    try { text = await readText(n); } catch { text = null; }
    if (text && isVaultManifest(text)) return true;
  }
  return false;
}

/** Tolerant JSON parse — returns fallback on any malformed input (never throws). */
function safeParse(text, fallback) {
  try { const v = JSON.parse(text); return v ?? fallback; } catch { return fallback; }
}

/**
 * Inspect a loaded JSZip and decide which export it is.
 *
 * Signature files are matched by BASENAME AT ANY DEPTH (archive-entries.js), so
 * a re-zipped or one-folder-deep export (`chatgpt-export-2026-07/conversations.json`)
 * detects exactly like a root-level one — the "auto-detect doesn't work" bug.
 * Several files with the same signature basename = AMBIGUOUS: we return an
 * honest error type, never a guess.
 *
 * @returns {Promise<{ type: 'mycelium'|'mycelium-oversized'|'mycelium-nested'|'claude'|'chatgpt'|'bundle'|'linkedin'|'ambiguous'|'unknown',
 *   conversations?: any[], manifest?: object, entries?: string[], ambiguity?: string }>}
 */
export async function detectExportType(zip) {
  const names = Object.keys(zip?.files || {});

  // Canonical-Mycelium vault export: one manifest.json carrying the whole vault
  // (format marker per the canonical portal route).
  //
  // IMPORTING is DELIBERATELY ROOT-ANCHORED (exact `manifest.json`), NOT
  // basename-at-any-depth like the other kinds: the vault importer resolves the
  // rest of the archive by ROOT-RELATIVE paths — attachment binaries via
  // `zip.file(att.zipPath)` (vault-import.js:339) and agent files via
  // `name.startsWith('agents/')` (:637). Importing a NESTED vault manifest would
  // write the tables but silently DROP every binary.
  //
  // DETECTING it, however, is basename-at-any-depth (see the nested probe below):
  // a nested vault export that fell through to `bundle` returned a success-shaped
  // {type:'bundle', imported:N} — a couple of loose media files — while the entire
  // message/document history was dropped with no error, on a RESTORE path. An
  // honest refusal is the only safe answer (QA6 P7 review FIX 1).
  if (names.includes('manifest.json')) {
    const manifestText = await readTextEntry(zip, 'manifest.json');
    if (manifestText) {
      const man = safeParse(manifestText, null);
      if (man && man.format === 'mycelium-vault-export') return { type: 'mycelium', manifest: man };
      // A manifest.json that isn't ours — fall through to the other detectors,
      // BUT a decoy/unrelated NON-vault root manifest must NOT mask a real vault
      // export nested alongside it. The refusal probe below therefore runs on
      // BOTH paths (no root manifest, AND a non-vault root manifest): guarding it
      // behind `else` let a decoy root `manifest.json` skip the probe and fall
      // through to `bundle` — silently dropping the whole message/document
      // history on a RESTORE path (QA6 P7 review round-2 FIX).
    } else {
      // The entry EXISTS but the capped reader refused it — almost certainly a
      // big vault whose manifest outgrew MAX_JSON_BYTES. Say so, actionably,
      // instead of the misleading generic "unrecognized export".
      return { type: 'mycelium-oversized', limitBytes: MAX_JSON_BYTES };
    }
  }
  // A vault export re-zipped inside its folder (with or without an unrelated
  // root manifest present). Refuse honestly — never bundle.
  if (await hasNestedVaultManifest((n) => readTextEntry(zip, n), names)) {
    return { type: 'mycelium-nested' };
  }
  // Both Claude and ChatGPT ship a conversations.json; the element shape
  // disambiguates: ChatGPT nodes carry a `mapping` tree, Claude `chat_messages`.
  const convHit = findEntryByBasename(names, 'conversations.json');
  if (convHit?.ambiguous) return { type: 'ambiguous', ambiguity: ambiguousEntryError('conversations.json', convHit.count) };
  if (convHit) {
    const convText = await readTextEntry(zip, convHit.name);
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
  }
  if (names.some((n) => /connections\.csv|messages\.csv/i.test(n))) return { type: 'linkedin' };
  // No recognized export manifest → a plain BUNDLE of documents/media (a zip of
  // PDFs, a re-zipped notes folder, a Google Takeout of exported Docs). Each
  // allowlisted entry goes through the loose-file router.
  const entries = names.filter(isBundleEntry);
  if (entries.length) return { type: 'bundle', entries };
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
  // conversations may be: an array (legacy in-memory path), an ASYNC ITERABLE
  // (streaming path — one conversation at a time), or absent (read the entry).
  // `for await` consumes all three; only read the zip entry when nothing was passed.
  let conversations = ctx.conversations;
  if (conversations == null) {
    conversations = safeParse(await readTextEntry(zip, 'conversations.json'), []);
  }
  let imported = 0, skipped = 0, failed = 0, conversationCount = 0, seen = 0;
  for await (const conv of conversations) {
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
          createdAt: m.created_at, // preserve the original message time, not import-time
          metadata: { title: conv.name, original_timestamp: m.created_at },
        });
        if (deduped) skipped += 1; else imported += 1;
      } catch { failed += 1; /* count the loss; never surface contents */ }
    }
  }
  // `failed` is FAIL-LOUD accounting: a swallowed capture error is a dropped
  // message — counted so the caller/UI can report it, not a silent loss.
  return { imported, skipped, failed, stats: { messages: imported, conversations: conversationCount, skipped_duplicates: skipped, failed } };
}

/** Text from a Claude Code transcript message (content: string | content-block[]). */
function claudeCodeText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : (typeof b?.text === 'string' ? b.text : ''))).filter(Boolean).join('\n').trim();
  }
  return '';
}

const CC_WRAPPER_RE = /^(<system-reminder|<command-)/;
const CC_CLEAN_KINDS = new Set(['human', 'agent-text']); // what 'clean' mode keeps

/**
 * Classify ONE Claude Code transcript line into a turn {kind, role, text, type}.
 * The filter: assistant `text` blocks + a real typed `user` prompt are the
 * human↔agent CONVERSATION; tool_use / tool_result / isMeta / <system-reminder> /
 * <command-> are tool/meta NOISE (kept only in 'full' mode). Returns null for
 * non-message lines. (User's recipe — most of a Claude Code log is tool noise.)
 */
function classifyClaudeCodeLine(d) {
  const message = d.message;
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const content = message.content;
  const text = claudeCodeText(message);
  if (role === 'assistant') {
    if (text) return { kind: 'agent-text', role, text, messageType: 'chat' };
    if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_use')) {
      const names = content.filter((b) => b?.type === 'tool_use').map((b) => b.name).filter(Boolean).join(', ');
      return { kind: 'tool-call', role, text: `[tool_use${names ? `: ${names}` : ''}]`, messageType: 'tool-call' };
    }
    return null;
  }
  // user
  if (d.isMeta) return { kind: 'meta', role, text: text || '[meta]', messageType: 'meta' };
  if (Array.isArray(content) && content.length > 0 && content.every((b) => b && b.type === 'tool_result')) {
    return { kind: 'tool-result', role, text: '[tool_result]', messageType: 'tool-result' };
  }
  if (text && !CC_WRAPPER_RE.test(text)) return { kind: 'human', role, text, messageType: 'chat' };
  if (text) return { kind: 'meta', role, text, messageType: 'meta' }; // system-reminder/command wrapper
  return null;
}

/**
 * Parse Claude Code session transcripts (`.jsonl` under ~/.claude/projects/**).
 *
 * mode='clean' (DEFAULT): import only the human↔agent conversation — most of a
 *   Claude Code log is tool noise (tool_use/tool_result/meta), dropped from
 *   MESSAGES so they don't pollute the mindscape. The dropped turns are COUNTED
 *   in `filtered` (fail-loud — we say what we left out).
 * mode='full': import EVERY turn; tool/meta turns are flagged via messageType.
 *
 * EITHER way, each created message keeps its FULL original line in
 * `metadata.raw` — no field is lost even when it doesn't fit our schema, so the
 * data can be re-filtered/cleaned later (a kept text turn thus also retains its
 * accompanying tool_use blocks). Preserves the original `timestamp`, groups by
 * `sessionId`, dedups on stable `uuid`, fail-loud on capture errors.
 *
 * @param {Array<{relPath?:string, content:string}>} entries
 * @param {{ capture: (msg:object)=>Promise<{deduped:boolean}> }} ctx
 * @param {{ mode?: 'clean'|'full' }} [opts]
 */
export async function processClaudeCodeExport(entries, ctx, { mode = 'clean' } = {}) {
  const clean = mode !== 'full';
  let imported = 0, skipped = 0, failed = 0, sessions = 0, seen = 0;
  const filtered = { 'tool-call': 0, 'tool-result': 0, meta: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const text = typeof entry?.content === 'string' ? entry.content : '';
    if (!text.trim()) continue;
    let any = false;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (++seen > MAX_MESSAGES) break;
      let d; try { d = JSON.parse(s); } catch { continue; } // metadata/partial line — not a message
      if (d.type !== 'user' && d.type !== 'assistant') continue;
      const turn = classifyClaudeCodeLine(d);
      if (!turn) continue;
      if (clean && !CC_CLEAN_KINDS.has(turn.kind)) { filtered[turn.kind] = (filtered[turn.kind] || 0) + 1; continue; }
      const id = `claude-code-${d.uuid || `${d.sessionId || 's'}-${seen}`}`;
      try {
        // Source 'import-claude-code' (NOT 'claude-code…') so it does NOT trip the
        // agent-capture consent gate (capture.js isAgentSource /^claude-code\b/),
        // which is for LIVE auto-capture; an import is intentional ingest.
        const { deduped } = await ctx.capture({
          id, content: turn.text, role: turn.role, source: 'import-claude-code',
          messageType: turn.messageType, conversationId: d.sessionId || null,
          createdAt: d.timestamp, // ISO — preserve the original session time
          // FULL original line preserved (LOSSLESS): every field kept even when
          // our schema ignores it, so it can be re-filtered/cleaned later.
          metadata: { sessionId: d.sessionId, cwd: d.cwd, gitBranch: d.gitBranch, kind: turn.kind, original_timestamp: d.timestamp, raw: d },
        });
        if (deduped) skipped += 1; else { imported += 1; any = true; }
      } catch { failed += 1; /* FAIL-LOUD: count the dropped message */ }
    }
    if (any) sessions += 1;
  }
  return { imported, skipped, failed, mode: clean ? 'clean' : 'full', filtered,
    stats: { messages: imported, sessions, skipped_duplicates: skipped, failed, filtered } };
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
  // Accept an array (legacy) OR an async/sync iterable (streaming path); `for await`
  // consumes either. Guard against a non-iterable (e.g. null) → empty.
  const iter = conversations && (conversations[Symbol.asyncIterator] || conversations[Symbol.iterator]) ? conversations : [];
  let imported = 0, skipped = 0, failed = 0, conversationCount = 0, seen = 0;
  for await (const conv of iter) {
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
          createdAt: m.create_time, // epoch seconds → preserve original message time
          metadata: { title: conv.title, original_timestamp: m.create_time },
        });
        if (deduped) skipped += 1; else imported += 1;
      } catch { failed += 1; /* count the loss */ }
    }
  }
  return { imported, skipped, failed, stats: { messages: imported, conversations: conversationCount, skipped_duplicates: skipped, failed } };
}
