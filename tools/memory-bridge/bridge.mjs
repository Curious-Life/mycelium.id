// Mycelium memory bridge — the tiny client every harness adapter speaks.
//
// "Universal memory layer": on each turn a connected agent (1) PULLS context from
// the vault and (2) PUSHES both the user message and the assistant reply back in.
// This module is the shared client for both halves; per-harness adapters
// (claude-code/, hermes/, …) just wire their lifecycle hooks to capture()/context().
//
// It talks to Mycelium's Bearer-guarded HTTP surface (:4711) — NOT MCP JSON-RPC —
// so a one-line shell hook can use it:
//   • POST /ingest/message   (capture, idempotent)            — src/server-http.js
//   • POST /context          (pull getContext + search slice) — src/server-http.js
//
// Config (env):
//   MYCELIUM_BASE_URL     default http://127.0.0.1:4711
//   MYCELIUM_MCP_BEARER   required — the static bearer the server was started with
//   MYCELIUM_BRIDGE_SOURCE default 'bridge' (provenance tag; adapters override)
//   MYCELIUM_BRIDGE_REDACT '1' → scrub obvious secrets before capture (default off)
//   MYCELIUM_BRIDGE_TIMEOUT_MS default 4000 (UserPromptSubmit has a 30s hook cap)
//
// DESIGN INVARIANT (capture.js dedup is id-keyed, NOT content-keyed): capture only
// the NEW turn, with a DETERMINISTIC id, so a resend is a no-op. Never loop a full
// history into capture() — that would insert every prior turn as a fresh row.
import { createHash } from 'node:crypto';

const env = process.env;
export const BASE_URL = (env.MYCELIUM_BASE_URL || 'http://127.0.0.1:4711').replace(/\/$/, '');
const BEARER = env.MYCELIUM_MCP_BEARER || '';
const SOURCE = env.MYCELIUM_BRIDGE_SOURCE || 'bridge';
const REDACT = /^(1|true|yes)$/i.test(String(env.MYCELIUM_BRIDGE_REDACT || ''));
const TIMEOUT_MS = Number(env.MYCELIUM_BRIDGE_TIMEOUT_MS) > 0 ? Number(env.MYCELIUM_BRIDGE_TIMEOUT_MS) : 8000;

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * Deterministic capture id: same (source, conversation, role, content) ⇒ same id,
 * so a re-send dedups to a no-op (capture.js). Adapters with a stable native id
 * (e.g. a Claude Code transcript `uuid`) should pass that as `id` instead.
 */
export function captureId(source, conversationId, role, content) {
  return 'cap-' + sha256(`${source}|${conversationId || ''}|${role}|${content}`).slice(0, 40);
}

// Best-effort scrub of high-confidence secret shapes so a coding agent's output
// doesn't persist live credentials. Off by default (the user chose "everything,
// both sides"); MYCELIUM_BRIDGE_REDACT=1 turns it on. Conservative on purpose —
// only patterns that are almost never legitimate prose.
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/g,                 // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,                    // Anthropic keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                   // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                             // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                 // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted-secret»');
  return out;
}

async function post(path, body) {
  if (!BEARER) throw new Error('MYCELIUM_MCP_BEARER is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Capture ONE message (the new turn). Fire-and-forget by contract: returns the
 * server result on success, or null on any failure — NEVER throws, so a capture
 * problem can never break the harness's turn.
 * @param {object} m {content, role, conversationId, source?, id?, metadata?, createdAt?}
 */
export async function capture(m = {}) {
  try {
    const content = REDACT ? redactSecrets(m.content) : String(m.content ?? '');
    if (!content.trim()) return null;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const source = m.source || SOURCE;
    const id = m.id || captureId(source, m.conversationId, role, content);
    const { ok, json } = await post('/ingest/message', {
      content, role, source, id,
      conversationId: m.conversationId,
      metadata: m.metadata,
      createdAt: m.createdAt,
    });
    return ok ? json?.result ?? json : null;
  } catch {
    return null;
  }
}

/**
 * Bulk-capture many messages in one call (POST /ingest/import) — idempotent on
 * each item's `id`. Items: {content, id, role, source, conversationId, timestamp,
 * createdAt, metadata}. Returns the server result string or null; never throws.
 */
export async function importBatch(messages) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const { ok, json } = await post('/ingest/import', { messages });
    return ok ? (json?.result ?? json) : null;
  } catch {
    return null;
  }
}

/**
 * Pull vault context for this turn. Returns the context string, or '' on any
 * failure (the caller then proceeds with no injected context — fail-open).
 * @param {object} [opts] {query?, maxChars?}
 */
export async function context(opts = {}) {
  try {
    const { ok, json } = await post('/context', {
      query: typeof opts.query === 'string' ? opts.query : undefined,
      maxChars: opts.maxChars,
    });
    return ok && typeof json?.text === 'string' ? json.text : '';
  } catch {
    return '';
  }
}

/** Read all of stdin as text (hooks deliver their JSON payload on stdin). */
export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export default { capture, context, captureId, redactSecrets, readStdin, BASE_URL };
