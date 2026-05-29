/**
 * Environment-variable resolvers with deprecation-friendly fallback.
 *
 * Phase 14C of the Mycelium refactor is renaming agent-specific env var
 * names that leaked into shared abstractions (see universal-naming
 * feedback). The new names are the preferred form; old names work as
 * fallbacks until every VPS has migrated its `.env`.
 *
 *   WORKER_URL      ← preferred   (was: MYA_WORKER_URL)
 *   WORKER_SECRET   ← preferred   (was: MYA_WORKER_SECRET)
 *   AGENTS_ROOT     ← preferred   (was: MYA_AGENTS_ROOT; paths.js already
 *                                  has this fallback — keeping it parallel
 *                                  here for completeness)
 *
 * Usage:
 *   import { getWorkerUrl, getWorkerSecret } from '@mycelium/core/env.js';
 *   const url = getWorkerUrl();         // '' if unset
 *   const url2 = getWorkerUrl(true);    // throws if unset (required)
 *
 * Read-at-call-time (not cached) so test suites that mutate
 * process.env.WORKER_URL between tests continue to work.
 */

/** @returns {string} — '' when neither new nor legacy is set */
export function getWorkerUrl(required = false) {
  const url = process.env.WORKER_URL || process.env.MYA_WORKER_URL || '';
  if (required && !url) {
    throw new Error('WORKER_URL (or legacy MYA_WORKER_URL) env var required');
  }
  return url;
}

/** @returns {string} — '' when neither new nor legacy is set */
export function getWorkerSecret(required = false) {
  const secret = process.env.WORKER_SECRET || process.env.MYA_WORKER_SECRET || '';
  if (required && !secret) {
    throw new Error('WORKER_SECRET (or legacy MYA_WORKER_SECRET) env var required');
  }
  return secret;
}

/** True when either form of WORKER_URL is configured. */
export function hasWorkerUrl() {
  return Boolean(process.env.WORKER_URL || process.env.MYA_WORKER_URL);
}

/** True when either form of WORKER_SECRET is configured. */
export function hasWorkerSecret() {
  return Boolean(process.env.WORKER_SECRET || process.env.MYA_WORKER_SECRET);
}
