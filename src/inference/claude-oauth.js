// src/inference/claude-oauth.js — import a Claude subscription OAuth token from the
// user's OWN Claude Code login (~/.claude/.credentials.json).
//
// We do NOT mint tokens via Anthropic's OAuth client_id (that would be impersonating
// the first-party Claude Code app). We inherit the token the real `claude` CLI
// already minted when the user signed in with their subscription. The token is then
// stored in ai_providers.credentials (protected at rest by whole-file SQLCipher) and
// sent via the subscription wire (anthropic-wire.js: Bearer + Claude-Code identity
// headers + "You are Claude Code" preamble).
//
// SECURITY: the user:inference scope-guard rejects a `claude setup-token` ADMIN
// credential (which can mint API keys) — we only accept a real subscription login.
// Mirrors the canonical guard at packages/server/routes/portal-auth-claude.js:242.
// @see docs/CLAUDE-SUBSCRIPTION-DRIVER-DESIGN-2026-06-26.md (Phase S).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const REQUIRED_SCOPE = 'user:inference';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// On macOS, Claude Code stores its OAuth credential in the login Keychain (this one
// generic-password item) rather than the file — so on a Mac the file is usually
// absent. We read that single known item as a fallback. Never logs the value; macOS
// may prompt for Keychain access on first read.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const execFileAsync = promisify(execFile);
async function readMacKeychain(impl = execFileAsync) {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await impl('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 5000 });
    const v = String(stdout || '').trim();
    return v || null;
  } catch { return null; } // not found / access declined → treated as "no login"
}

export class ClaudeImportError extends Error {
  constructor(message, code) { super(message); this.name = 'ClaudeImportError'; this.code = code; }
}

/**
 * Read + validate the user's Claude Code OAuth credential. Returns the normalized
 * blob to persist in ai_providers.credentials — never writes anything itself.
 * Tries the credentials file first, then the macOS Keychain (Claude Code's default
 * store on macOS). readImpl/keychainImpl are injectable for tests.
 * @param {{ path?:string, readImpl?:(p:string)=>Promise<string>, keychainImpl?:()=>Promise<string|null> }} [opts]
 * @returns {Promise<{ claudeOAuthToken:string, refreshToken:string|null, expiresAt:number|null, scopes:string[] }>}
 * @throws ClaudeImportError with code: 'not_found' | 'malformed' | 'no_token' | 'missing_scope'
 */
export async function importFromClaudeCli({ path = CLAUDE_CREDENTIALS_PATH, readImpl, keychainImpl } = {}) {
  // 1) the credentials file (headless/Linux, or an explicitly-exported login)
  let raw = null;
  try { raw = readImpl ? await readImpl(path) : await readFile(path, 'utf8'); } catch { raw = null; }
  // 2) macOS Keychain fallback — Claude Code's default credential store on macOS
  if (!raw) { const kc = keychainImpl ? await keychainImpl() : await readMacKeychain(); if (kc) raw = kc; }
  if (!raw) {
    throw new ClaudeImportError(`No Claude Code login found (checked ${path} and the macOS Keychain). Run \`claude\` and sign in with your subscription first.`, 'not_found');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new ClaudeImportError('Claude credentials file is not valid JSON.', 'malformed'); }
  const oauth = parsed?.claudeAiOauth;
  const token = (typeof oauth?.accessToken === 'string' && oauth.accessToken) ? oauth.accessToken : null;
  if (!token) throw new ClaudeImportError('No Claude subscription access token found in the credentials file.', 'no_token');
  const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes.map(String) : [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new ClaudeImportError(`This credential lacks the ${REQUIRED_SCOPE} scope (it may be a setup-token admin credential, not a subscription login).`, 'missing_scope');
  }
  return {
    claudeOAuthToken: token,
    refreshToken: (typeof oauth.refreshToken === 'string' && oauth.refreshToken) ? oauth.refreshToken : null,
    expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    scopes,
  };
}

/** True if the stored token is expired (with a 5-min refresh skew). Unknown expiry
 *  → not expired (let the API decide; the refresh layer lands in a follow-up). */
export function isTokenExpired(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return false;
  return now >= (expiresAt - REFRESH_SKEW_MS);
}
