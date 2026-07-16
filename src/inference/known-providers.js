// src/inference/known-providers.js — the closed vocabulary for `ai_providers.provider`.
//
// There is no CHECK constraint on the column (migrations/0001_init.sql:119-134), so
// this Set IS the constraint. It lives here (not in portal-providers.js) because two
// independent surfaces must agree on it and drift between them is a security bug:
//   - the WRITE path  — src/portal-providers.js POST /providers rejects an unknown
//     provider with a 400 before a row is ever created;
//   - the IMPORT path — src/ingest/vault-import.js restoreTable() refuses a bundle
//     row whose provider is outside the vocabulary.
// If the write path can never create it, a restore must never resurrect it.
//
// The live writers are exactly two (both via db.providers.create): the BYOK key form
// (portal-providers.js:349, provider ∈ this set) and persistSubscription
// (portal-providers.js:504, always 'anthropic'). Adding a value here widens what an
// import will accept — do it only alongside a real write path for it.
export const KNOWN_PROVIDERS = new Set(['openai', 'anthropic', 'claude', 'custom']);
