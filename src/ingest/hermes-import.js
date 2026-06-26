// Hermes agent import — bring a local Hermes install's conversation history and
// persona into the vault.
//
// Hermes stores everything in ONE SQLite file, plaintext on disk:
//   ~/.hermes/state.db   sessions(id, title, started_at, system_prompt, …)
//                        messages(id, session_id, role, content, tool_calls,
//                                 tool_name, timestamp REAL, active, …)
//   ~/.hermes/SOUL.md    freeform persona/identity prose (no frontmatter)
// (schema verified live, 2026-06-25; timestamps are Unix EPOCH SECONDS, fractional.)
//
// HOW DATA LANDS: each conversation turn threads through captureMessage (the one
// encrypt-at-rest chokepoint) with source 'import-hermes'. The `import-` prefix
// is deliberate — capture.js's agent-capture consent gate fires on a bare
// `hermes`/`openclaw` source (LIVE auto-capture, may hold secrets); an explicit
// user-initiated import is intentional ingest and must NOT be gated, exactly like
// 'import-claude-code'. SOUL.md lands as a document under agents/hermes/.
//
// mode='clean' (default): only the human↔agent conversation (role user/assistant
//   with real text). Tool turns (role 'tool', or assistant turns that are pure
//   tool_calls with empty content) are NOISE — counted in `filtered`, not stored.
// mode='full': every turn, tool/system included, messageType flags the kind.
// EITHER way the FULL original row is kept in metadata.raw (lossless).
//
// active=1 filter: Hermes marks rewound/edited-away turns active=0 — importing
// them would resurrect retracted text, so the live transcript is active=1 only.

import { promises as fs } from 'node:fs';
import Database from 'better-sqlite3';
import { captureMessage } from './capture.js';
import { saveDocument } from '../core/document-store.js';
import { recordContentFlow } from '../inference/usage.js';

const MAX_MESSAGES = Number(process.env.MYCELIUM_HERMES_IMPORT_MAX) || 200000;
const MAX_SOUL_BYTES = 1 * 1024 * 1024;

/** REAL epoch seconds (possibly fractional) → ISO, or null if unusable. */
function epochSecondsToIso(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Plaintext body of a Hermes message row; tool_calls JSON is NOT body text. */
function hermesText(row) {
  return typeof row?.content === 'string' ? row.content.trim() : '';
}

/**
 * Classify one Hermes message row into a turn, or null for "skip entirely".
 * clean mode keeps only human/agent text; full keeps tool/system too.
 */
function classifyHermesRow(row, clean) {
  const role = row?.role;
  const text = hermesText(row);
  if (role === 'assistant') {
    if (text) return { kind: 'agent-text', role: 'assistant', text, messageType: 'chat' };
    if (row.tool_calls) return { kind: 'tool-call', role: 'assistant', text: `[tool_use${row.tool_name ? `: ${row.tool_name}` : ''}]`, messageType: 'tool-call' };
    return null; // empty assistant turn with nothing in it
  }
  if (role === 'user') {
    if (text) return { kind: 'human', role: 'user', text, messageType: 'chat' };
    return null;
  }
  if (role === 'tool') {
    return { kind: 'tool-result', role: 'user', text: text || `[tool_result${row.tool_name ? `: ${row.tool_name}` : ''}]`, messageType: 'tool-result' };
  }
  if (role === 'system' && text) return { kind: 'meta', role: 'user', text, messageType: 'meta' };
  return null;
}

/**
 * Import a Hermes vault.
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.statePath   path to state.db (default ~/.hermes/state.db, resolved by the route)
 * @param {string} [opts.soulPath]  path to SOUL.md (persona) — imported if present
 * @param {'clean'|'full'} [opts.mode='clean']
 * @param {(id:string)=>void} [opts.enqueueEnrichment]
 * @returns {Promise<{ imported, skipped, failed, sessions, persona, mode, filtered }>}
 */
export async function importHermes(db, { userId, statePath, soulPath, mode = 'clean', enqueueEnrichment } = {}) {
  if (!db?.messages || !db?.documents) throw new TypeError('importHermes: db.messages + db.documents required');
  if (typeof userId !== 'string' || !userId) throw new Error('importHermes: userId required');
  if (typeof statePath !== 'string' || !statePath) throw new Error('importHermes: statePath required');
  const clean = mode !== 'full';
  const summary = { imported: 0, skipped: 0, failed: 0, sessions: 0, persona: 0, mode: clean ? 'clean' : 'full', filtered: { 'tool-call': 0, 'tool-result': 0, meta: 0 } };

  // ── Persona: SOUL.md → a document under agents/hermes/ (idempotent on path) ──
  if (soulPath) {
    try {
      const st = await fs.stat(soulPath).catch(() => null);
      if (st?.isFile() && st.size > 0 && st.size <= MAX_SOUL_BYTES) {
        const soul = await fs.readFile(soulPath, 'utf8');
        if (soul.trim()) {
          await saveDocument({ db }, {
            userId, source: 'import-hermes', sourceType: 'import_hermes', createdBy: 'import', scope: 'personal',
            path: 'import/hermes/SOUL.md', title: 'Hermes — SOUL', content: soul,
            metadata: { tool: 'hermes', kind: 'persona' }, createdAt: st.mtime?.toISOString?.(),
          });
          summary.persona += 1;
        }
      }
    } catch (e) { summary.failed += 1; summary.soulError = String(e?.message || e).slice(0, 160); }
  }

  // ── Conversation history: state.db sessions + messages (readonly) ────────────
  let sdb;
  try { sdb = new Database(statePath, { readonly: true, fileMustExist: true }); }
  catch (e) { throw new Error(`hermes_state_unreadable: ${String(e?.message || e).slice(0, 120)}`); }
  const importedSessions = new Set();
  const contents = [];
  try {
    // Live transcript only (active=1), chronological within a session.
    const rows = sdb.prepare(
      'SELECT id, session_id, role, content, tool_calls, tool_name, timestamp, active FROM messages WHERE active = 1 ORDER BY session_id, timestamp ASC, id ASC',
    ).all();
    let seen = 0;
    for (const row of rows) {
      if (++seen > MAX_MESSAGES) break;
      const turn = classifyHermesRow(row, clean);
      if (!turn) continue;
      if (clean && turn.kind !== 'human' && turn.kind !== 'agent-text') { summary.filtered[turn.kind] = (summary.filtered[turn.kind] || 0) + 1; continue; }
      const id = `hermes-${row.id}`;
      try {
        const { deduped } = await captureMessage(db, {
          userId, id, content: turn.text, role: turn.role, source: 'import-hermes',
          messageType: turn.messageType, conversationId: row.session_id ? `hermes:${row.session_id}` : null,
          createdAt: epochSecondsToIso(row.timestamp),
          metadata: { tool: 'hermes', sessionId: row.session_id, kind: turn.kind, toolName: row.tool_name || undefined, raw: row },
        }, enqueueEnrichment);
        if (deduped) summary.skipped += 1;
        else { summary.imported += 1; if (row.session_id) importedSessions.add(row.session_id); if (turn.text) contents.push(turn.text); }
      } catch { summary.failed += 1; } // FAIL-LOUD: count the dropped turn
    }
  } finally { try { sdb.close(); } catch { /* */ } }
  summary.sessions = importedSessions.size;

  // §12 token-flow: estimate the volume that flowed in (no model touched it).
  if (contents.length) recordContentFlow(db, userId, { source: 'ingest', area: 'import', content: contents });
  return summary;
}
