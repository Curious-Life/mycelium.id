// The import-source REGISTRY — one entry per source, the single source of truth
// the detector, the generic route, and (via the API) the frontend read from.
// Design: the unified-import architecture.
//
// Before this, adding an import source meant editing ~8 places (detector +
// allowlist + importer + route + two TS unions + a dispatch switch + a UI
// catalog). A registry entry with a `run` is now reachable through the ONE
// generic async route (POST /import/run) — so a NEW source is a single entry.
//
// FAMILIES (see the design): `restore` = re-land an export verbatim (id +
// created_at + source preserved, dedup by id, no consent gate) via restore-core;
// `capture` = ingest new notes/agent data via captureMessage (consent-gated,
// normalized, auto-enriched). The 7 legacy importers are catalogued here with
// their `legacyRoute`; the restore-family ones also expose a generic `run`. The
// capture-family importers keep their existing routes until Increment 2 migrates
// them (their per-source path/mode handling is richer) — so nothing regresses.

import os from 'node:os';
import { assertImportPathAllowed } from './detect-sources.js';
import { importRecentExport } from './recent-export-import.js';
import { importFullExport } from './full-export-import.js';

/**
 * @typedef {object} ImportSource
 * @property {string} key
 * @property {string} label
 * @property {string} unit
 * @property {'restore'|'capture'} family
 * @property {string} action           the frontend DetectedAction id
 * @property {boolean} [supportsMode]   clean/full toggle (agent transcript sources)
 * @property {string} [legacyRoute]     the existing per-source route (back-compat)
 * @property {(db:object, ctx:object) => Promise<object>} [run]
 *           generic runner: ctx = { userId, enqueueEnrichment, onProgress, shouldCancel, body }.
 *           Present ⇒ reachable via POST /import/run. Absent ⇒ use legacyRoute.
 */

/** @type {ImportSource[]} */
export const IMPORT_SOURCES = [
  {
    key: 'recent-export', label: 'Mycelium recent export', unit: 'items', family: 'restore',
    action: 'import-recent-export',
    run: async (db, { userId, enqueueEnrichment, onProgress, shouldCancel, body = {} }) => {
      if (typeof body.dirPath !== 'string' || !body.dirPath) { const e = new Error('dirPath required'); e.code = 'bad_request'; throw e; }
      const dirPath = assertImportPathAllowed(body.dirPath); // realpath + allowlist, fail-closed
      return importRecentExport(db, { userId, dirPath, enqueueEnrichment, onProgress, shouldCancel });
    },
  },
  {
    key: 'full-export', label: 'Mycelium full export', unit: 'items', family: 'restore',
    action: 'import-full-export', legacyRoute: '/import/full-export',
    run: async (db, { userId, enqueueEnrichment, body = {} }) => {
      if (typeof body.dirPath !== 'string' || !body.dirPath) { const e = new Error('dirPath required'); e.code = 'bad_request'; throw e; }
      const dirPath = assertImportPathAllowed(body.dirPath);
      return importFullExport({ db, userId, dirPath, enqueueEnrichment });
    },
  },
  // ── Capture-family — catalogued; served by their existing routes until the
  //    Increment-2 migration moves their bodies into `run`. ──────────────────────
  { key: 'obsidian', label: 'Obsidian', unit: 'notes', family: 'capture', action: 'import-folder', legacyRoute: '/import/obsidian' },
  { key: 'claude-code', label: 'Claude Code', unit: 'sessions', family: 'capture', action: 'import-claude-code', supportsMode: true, legacyRoute: '/import/claude-code' },
  { key: 'hermes', label: 'Hermes', unit: 'messages', family: 'capture', action: 'import-hermes', supportsMode: true, legacyRoute: '/import/hermes' },
  { key: 'openclaw', label: 'OpenClaw', unit: 'sessions', family: 'capture', action: 'import-openclaw', supportsMode: true, legacyRoute: '/import/openclaw' },
  { key: 'local-files', label: 'This Mac', unit: 'files', family: 'capture', action: 'import-local-files', legacyRoute: '/import/local-files' },
];

const BY_KEY = new Map(IMPORT_SOURCES.map((s) => [s.key, s]));
const BY_ACTION = new Map(IMPORT_SOURCES.map((s) => [s.action, s]));

export function getImportSource(key) { return BY_KEY.get(key) || null; }
export function getImportSourceByAction(action) { return BY_ACTION.get(action) || null; }
/** Keys reachable through the generic POST /import/run (have a `run`). */
export function runnableKeys() { return IMPORT_SOURCES.filter((s) => typeof s.run === 'function').map((s) => s.key); }
/** Public catalog for the frontend (no functions). */
export function importCatalog() {
  return IMPORT_SOURCES.map(({ key, label, unit, family, action, supportsMode, legacyRoute, run }) =>
    ({ key, label, unit, family, action, supportsMode: !!supportsMode, generic: typeof run === 'function', legacyRoute: legacyRoute || null }));
}

export { os };
