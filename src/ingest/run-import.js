// src/ingest/run-import.js — the single import spine (Phase 2a).
//
// One orchestrator behind every import transport: normalize input → detect the
// source → dispatch to a registered adapter → return a uniform result. Routes
// (portal-uploads / portal-import / server-http) become thin wrappers; the
// parsers/writers (captureMessage, saveDocument, importMyceliumVault, …) are
// unchanged — we unify the ENTRY, not the writers.
//
// Design: docs/DESIGN-import-unification-phase2-2026-06-19.md §2.1.
// Phase 2a wires the ARCHIVE kind (the dispatch previously inlined in
// portal-uploads.js `processArchive`). Behavior is byte-identical — same
// detection, same parser calls, same { importResult } | { error } shapes —
// so verify:import / verify:vault-import stay GO. Later phases add kinds:
//   'loose-file' (2b → saveDocument/attachment), 'folder' (2c → markdown/obsidian).
//
// The adapter registry is the ONE place a new source lands. Adapters are inline
// here while there are few; they extract to src/ingest/sources/*.js when 2b/2c
// add more (each adapter is already a self-contained {detectType → run} pair).

import JSZip from 'jszip';
import {
  detectExportType, processClaudeExport, processOpenAIExport, assertEntryCount,
} from './import-parsers.js';
import { importMyceliumVault } from './vault-import.js';
import { captureMessage } from './capture.js';

// A capture() bound to this import's context — the message write boundary every
// conversation-export adapter funnels through.
const captureFor = (ctx) => (msg) => captureMessage(ctx.db, { userId: ctx.userId, ...msg }, ctx.enqueueEnrichment);

// Archive source adapters, keyed by detectExportType().type. Each returns the
// parser's report spread under a `type` tag (the exact shape routes returned
// before). Add a key here to support a new archive source.
const ARCHIVE_ADAPTERS = {
  mycelium: async (detected, ctx) =>
    ({ type: 'mycelium', ...(await importMyceliumVault(detected.zip, detected.manifest, { db: ctx.db, userId: ctx.userId, enqueueEnrichment: ctx.enqueueEnrichment })) }),
  claude: async (detected, ctx) =>
    ({ type: 'claude', ...(await processClaudeExport(detected.zip, { capture: captureFor(ctx), conversations: detected.conversations })) }),
  chatgpt: async (detected, ctx) =>
    ({ type: 'chatgpt', ...(await processOpenAIExport(detected.conversations, { capture: captureFor(ctx) })) }),
};

// Detected-but-not-importable archive types → an honest error (NEVER a
// success-shaped {imported:0}). A function so the message can use detection data.
const ARCHIVE_UNSUPPORTED = {
  'mycelium-oversized': (d) => `this Mycelium export's manifest exceeds the inflation cap (${Math.round(d.limitBytes / 1024 / 1024)}MB) — relaunch with MYCELIUM_IMPORT_MAX_JSON_BYTES raised, then retry`,
  obsidian: () => 'Obsidian vaults import via the folder importer (Settings → Import → Obsidian), not as a .zip upload — nothing was imported.',
  linkedin: () => 'LinkedIn export import is not supported yet — nothing was imported.',
};

/**
 * Run an import. The single entry point behind every upload/import transport.
 * @param {{ kind: 'archive', buffer?: Buffer, zip?: object }} input
 * @param {{ db: object, userId: string, enqueueEnrichment?: Function }} ctx
 * @returns {Promise<{ importResult: object } | { error: string }>}
 */
export async function runImport(input, ctx) {
  if (!ctx?.db || !ctx?.userId) throw new Error('runImport: ctx.db and ctx.userId are required');
  switch (input?.kind) {
    case 'archive': return runArchive(input, ctx);
    default: throw new Error(`runImport: unknown input kind ${JSON.stringify(input?.kind)}`);
  }
}

// Transport normalization for archives: bytes → loaded+bomb-guarded zip →
// detect → dispatch. Owns the entry-count/zip-bomb guard (was in portal-uploads).
async function runArchive(input, ctx) {
  let zip = input.zip;
  if (!zip) {
    try { zip = await JSZip.loadAsync(input.buffer); assertEntryCount(zip); }
    catch (e) {
      if (e?.code === 'TOO_MANY_ENTRIES') return { error: 'this archive has too many entries — refusing to import (possible archive bomb)' };
      return { error: 'unrecognized file — upload a Mycelium vault export, or a Claude/ChatGPT export .zip' };
    }
  }
  const detected = await detectExportType(zip);
  detected.zip = zip; // adapters that need the archive (mycelium, claude) read it here
  const adapter = ARCHIVE_ADAPTERS[detected.type];
  if (adapter) return { importResult: await adapter(detected, ctx) };
  const unsupported = ARCHIVE_UNSUPPORTED[detected.type];
  if (unsupported) return { error: unsupported(detected) };
  return { error: 'unrecognized export — expected a Mycelium vault export, or a Claude/ChatGPT conversations.json' };
}
