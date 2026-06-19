// src/mindfiles/sanitize.js — scan-on-write gate for mind files (Context Engine, Phase 1c-A).
//
// Runs at the single writeMindFile chokepoint, BEFORE encrypt, fail-closed: a blocked write
// throws (the harness surfaces it to the agent as a tool error; the content never persists).
// The reflection engine writes persistent state FROM message content, so this closes the
// inject-into-your-own-memory hole (CLAUDE.md §1/§9).
//
// Design (verified, low false-positive — a mind file legitimately discusses security):
//  • BLOCK bidi-control + a couple of zero-width chars — the Trojan-Source / hidden-instruction
//    vector, never legitimate in reflective prose. We intentionally ALLOW ZWNJ/ZWJ
//    (U+200C/U+200D) so emoji-ZWJ sequences and Persian/Indic scripts are not false-positived.
//  • BLOCK high-confidence LIVE credential shapes (reused from ingest/capture.js — "rarely
//    seen in real prose"). Abstract pattern text like "AKIA[0-9A-Z]{16}" does NOT match the
//    real regex, so legitimate security notes pass. The master key is NOT pattern-matched:
//    it's 64-hex (collides with SHA-256/commit hashes) AND is never in the agent's context.
//  • BLOCK a runaway size (a single mind file over ~16k tokens).
//  • SKIP snapshots/ — a snapshot is a copy of already-scanned content.
// Pure, no I/O, and it NEVER returns or logs the scanned content (§1) — only a stable code.
import { estimateTokens } from '../inference/token-budget.js';

// High-confidence live-credential shapes (mirror of ingest/capture.js:78-85).
const CREDENTIAL_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,                                       // Anthropic
  /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/,                                     // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                                      // GitHub
  /\bAKIA[0-9A-Z]{16}\b/,                                                // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                                    // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,   // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,                                 // bearer token
];

// Invisible / bidi-control code points that are a pure injection vector (Trojan Source +
// hidden instructions), never legitimate in reflective prose: zero-width space (200B), word
// joiner (2060), bidi embeddings/overrides (202A-202E), bidi isolates (2066-2069), BOM (FEFF).
// ZWNJ/ZWJ (200C/200D) are deliberately EXCLUDED so emoji-ZWJ + Persian/Indic scripts pass.
// Built from numeric code points so the source carries no literal invisible characters.
const INVISIBLE_CODES = [0x200B, 0x2060, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF];
const INVISIBLE = new RegExp('[' + INVISIBLE_CODES.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('') + ']');

const MAX_TOKENS = 16_000; // runaway-write ceiling for any single mind file

/**
 * @param {string} content
 * @param {string} filename
 * @returns {{ok: true} | {ok: false, code: string}}
 */
export function sanitizeMindWrite(content, filename) {
  if (String(filename || '').startsWith('snapshots/')) return { ok: true }; // already-scanned copy
  const text = String(content ?? '');
  if (INVISIBLE.test(text)) return { ok: false, code: 'invisible-unicode' };
  for (const re of CREDENTIAL_PATTERNS) if (re.test(text)) return { ok: false, code: 'credential-token' };
  if (estimateTokens(text) > MAX_TOKENS) return { ok: false, code: 'oversized' };
  return { ok: true };
}

export default sanitizeMindWrite;
