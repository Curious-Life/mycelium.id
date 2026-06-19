// src/inference/base-url.js — SSRF + exfiltration guard for BYOK provider base_urls (H5).
//
// A provider row's `base_url` is user-supplied and is then fetched server-side
// with the prompt (vault plaintext) + the user's API key in the Authorization
// header. Without validation a malicious/мis-pasted base_url can (a) SSRF
// internal services (http://169.254.169.254/…, http://127.0.0.1:11434) or
// (b) exfiltrate every prompt + the key to an attacker host. We validate on
// WRITE and before every USE (defense in depth, CLAUDE.md §2):
//   - scheme must be http(s); plaintext http only for localhost
//   - reject private/internal IP LITERALS (reuses the federation SSRF matcher)
//   - (write path) reject hostnames that RESOLVE to a private IP
//
// Local providers (Ollama / LM Studio at http://127.0.0.1) stay allowed.

import net from 'node:net';
import { isPrivateAddress, assertResolvesPublic, safeFetch } from '../federation/ssrf.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** Throw if `baseUrl` is unsafe to fetch. Empty → ok (caller uses a known default). */
export function assertSafeBaseUrl(baseUrl) {
  if (baseUrl == null || baseUrl === '') return;
  let u;
  try { u = new URL(String(baseUrl)); }
  catch { throw new Error('base_url is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('base_url must use http or https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loop = LOOPBACK.has(host);
  if (u.protocol === 'http:' && !loop) {
    throw new Error('plaintext http base_url is only allowed for localhost — use https');
  }
  if (!loop && net.isIP(host) && isPrivateAddress(host)) {
    throw new Error('base_url points at a private/internal address');
  }
  return u.href;
}

/**
 * Write-path check: literal validation PLUS a DNS resolution check so a hostname
 * that resolves to a private IP is rejected (catches DNS-based SSRF the literal
 * check can't). `lookup` is injectable for tests.
 */
export async function assertSafeBaseUrlResolved(baseUrl, { lookup } = {}) {
  assertSafeBaseUrl(baseUrl);
  if (baseUrl == null || baseUrl === '') return;
  const host = new URL(String(baseUrl)).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK.has(host) || net.isIP(host)) return; // literal already validated above
  await assertResolvesPublic(host, lookup ? { lookup } : {});
}

/**
 * SSRF-safe fetch for a provider base_url-derived URL (use-time guard, H5).
 * Local providers (Ollama / LM Studio at loopback) and public IP literals fetch
 * directly — there is no hostname to rebind. A real hostname goes through
 * `safeFetch` (resolve + validate-EVERY-address-public + connection pin) so a
 * malicious or DNS-rebinding base_url cannot exfiltrate the prompt + API key to
 * an internal service between the write-time check and the connect. Honors an
 * injected `fetch` (the inference layer's test seam): safeFetch runs its guard,
 * then calls the injected fetch.
 */
export async function fetchProvider(url, { fetch = globalThis.fetch, lookup, ...init } = {}) {
  // An injected (non-global) `fetch` is a test / custom-transport seam that does
  // not open a real socket, so the SSRF guard (which only matters for the real
  // connect) is skipped for it. On the real path `fetch` is always
  // globalThis.fetch (cloudInfer/cloudStream/the gateway default it), so the
  // resolve+pin below always runs in production.
  if (fetch !== globalThis.fetch) return fetch(url, init);
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch { throw new Error('provider url is not a valid URL'); }
  const ipVer = net.isIP(host); // 0 = hostname, 4/6 = IP literal
  if (LOOPBACK.has(host) || (ipVer && !isPrivateAddress(host))) {
    return fetch(url, init); // trusted local provider, or a public IP literal (no DNS → no rebinding)
  }
  if (ipVer && isPrivateAddress(host)) {
    throw new Error('refusing to fetch a private/internal address');
  }
  return safeFetch(url, { ...(lookup ? { lookup } : {}), ...init }); // hostname → resolve-public + connection pin
}
