// Archive ENTRY-NAME primitives — shared by the buffered (JSZip) and streaming
// (yauzl) archive paths so both agree on what an entry name means.
//
// Why this module exists: detection used to match EXACT names at the archive
// ROOT (`zip.file('conversations.json')` / `names.includes('manifest.json')`),
// so a user who re-zipped their export, or any export nested one folder deep
// (`chatgpt-export-2026-07/conversations.json`), fell through to
// "unrecognized export". Matching by BASENAME at any depth fixes that — but a
// basename can occur many times, so the rule is explicit:
//
//   exactly one candidate ⇒ detect;  many ⇒ an honest AMBIGUOUS error.
//
// We never pick "the shallowest" or "the first" — a silent guess about which of
// two exports the user meant is exactly the failure this replaces.
//
// SECURITY (CLAUDE.md §1/§3 — these names come from an attacker-influenceable
// archive):
//   • ENTRY NAMES ARE NEVER JOINED TO A FILESYSTEM PATH. The one thing a caller
//     may take from an entry name is `safeEntryBasename()` — path separators,
//     traversal segments, control bytes and leading dots are stripped, and the
//     result is length-capped. That keeps the "archive bytes never become a
//     filesystem path" invariant (zip-slip) enforced at the SOURCE rather than
//     trusted at each writer.
//   • The bundle allowlist is an ALLOWLIST (known media/document extensions),
//     not a denylist, so an unknown/odd entry is skipped, never guessed at.

/** Extensions a `bundle` archive imports. Mirrors run-import's EXT_MIME keys —
 *  the set the loose-file router can turn into a document or an attachment. */
export const BUNDLE_EXTS = new Set([
  'md', 'markdown', 'txt', 'pdf', 'docx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif',
]);

/** Last path segment of an archive entry name (handles `/` and `\`). */
export function entryBasename(name) {
  return String(name ?? '').split('/').pop().split('\\').pop();
}

/**
 * The ONLY value a caller may derive from an archive entry name.
 * Basename-only, traversal/control/separator-stripped, length-capped. Returns
 * '' when nothing safe survives (caller must then skip the entry).
 */
export function safeEntryBasename(name) {
  let base = entryBasename(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')   // control bytes (incl. NUL)
    .replace(/[/\\]/g, '')                    // belt-and-braces: no separators
    .replace(/^\.+/, '')                      // no leading dots (`..`, dotfiles)
    .trim();
  if (base === '' || base === '.' || base === '..') return '';
  if (base.length > 120) {                     // cap, keeping the extension
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 && base.length - dot <= 13 ? base.slice(dot) : '';
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/** Lowercase extension of an entry name (no dot), '' when there is none. */
export function entryExt(name) {
  return (entryBasename(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
}

/**
 * Directory entries, macOS resource forks, dotfiles and anything UNDER a hidden
 * directory are never content. The hidden-DIRECTORY rule matters as much as the
 * dotfile one: `.git/config`, `.obsidian/workspace.md`, `.Trash/x.png` are tool
 * state, not the user's documents — importing them is noise the user never asked
 * for (QA6 P7 review, FIX 5b).
 */
export function isNoiseEntry(name) {
  const n = String(name ?? '');
  if (n === '' || n.endsWith('/')) return true;                 // directory entry
  if (/(^|\/)__MACOSX\//.test(n)) return true;                  // resource-fork mirror
  if (/(^|\/)\.[^/]*\//.test(n)) return true;                   // under a hidden dir (.git/, .obsidian/)
  const base = entryBasename(n);
  return base === '' || base.startsWith('.');                   // .DS_Store, .gitignore, …
}

/** Is this entry importable by the `bundle` kind (allowlisted doc/media)? */
export function isBundleEntry(name) {
  return !isNoiseEntry(name) && BUNDLE_EXTS.has(entryExt(name));
}

/**
 * Resolve ONE entry by basename, at any depth.
 *   { name }                  → exactly one candidate (or an exact root match)
 *   null                      → no candidate
 *   { ambiguous: true, count} → several candidates; the caller MUST error, never guess
 *
 * An exact ROOT match always wins: it is unambiguous by construction and keeps
 * every already-working export byte-identical in behavior.
 */
export function findEntryByBasename(names, basename) {
  const list = Array.isArray(names) ? names : [];
  if (list.includes(basename)) return { name: basename };
  const hits = list.filter((n) => !isNoiseEntry(n) && entryBasename(n) === basename);
  if (hits.length === 0) return null;
  if (hits.length === 1) return { name: hits[0] };
  return { ambiguous: true, count: hits.length };
}

/**
 * The honest ambiguity message. CONTENT-FREE BY CONSTRUCTION: it names the
 * ambiguity (which basename, how many) and never echoes archive paths — an
 * import error can reach the activity feed, which is content-free by contract
 * (db/activity-feed.js §SECURITY, verify:import-activity A2).
 */
/**
 * EVERY candidate for a basename, at any depth (noise excluded). Use when the
 * caller must INSPECT each candidate rather than pick one — e.g. deciding
 * whether any `manifest.json` in the archive is a Mycelium vault manifest.
 */
export function findEntriesByBasename(names, basename) {
  return (Array.isArray(names) ? names : [])
    .filter((n) => !isNoiseEntry(n) && entryBasename(n) === basename);
}

/** The format marker of a Mycelium vault export's manifest.json. */
export const VAULT_EXPORT_FORMAT = 'mycelium-vault-export';

/**
 * Does this manifest.json text declare a Mycelium vault export? (never throws)
 * Accepts a bounded PREFIX of a large manifest: a vault manifest can be hundreds
 * of MB, so the streaming detector only reads its head — a parse is attempted
 * first, and a marker match on the raw text is the fallback. Both are decisions
 * about OUR OWN format marker; a false positive costs an honest refusal, never
 * an import.
 */
export function isVaultManifest(text) {
  const s = String(text ?? '');
  try { if (JSON.parse(s)?.format === VAULT_EXPORT_FORMAT) return true; } catch { /* truncated prefix */ }
  return new RegExp(`"format"\\s*:\\s*"${VAULT_EXPORT_FORMAT}"`).test(s);
}

/**
 * The honest refusal for a NESTED Mycelium vault export (QA6 P7 review, FIX 1).
 *
 * Why a refusal and not a rewrite: the vault importer resolves the rest of the
 * archive by ROOT-RELATIVE paths — attachment binaries via `zip.file(att.zipPath)`
 * (vault-import.js:339) and agent files via `name.startsWith('agents/')` (:637).
 * Detecting a nested manifest without rewriting those would import the tables and
 * silently DROP every binary; rewriting them is a second, subtler guess. Falling
 * through to `bundle` is WORSE than either: it reports `{type:'bundle',imported:N}`
 * — success-shaped — while the entire message/document history is dropped, on a
 * RESTORE path where the user believes their backup came back. So: say what is
 * wrong and what to do. CONTENT-FREE (no archive paths — activity-feed contract).
 */
export function nestedVaultExportError() {
  return 'this looks like a Mycelium vault export nested inside a folder — a vault restore must be ' +
    'uploaded from the export folder itself, or its attachments and agent files would be lost. ' +
    'Unzip the archive and upload (or re-zip) the INNER export folder — the one that has manifest.json ' +
    'at its top level. Nothing was imported.';
}

// ── Decompression-bomb RATIO guard (shared by BOTH archive readers) ──
// A real text/media export compresses ~5-20:1; a zip bomb is 1000:1+. The
// absolute byte caps must stay generous (gig-scale exports are legitimate), so
// the ratio is what actually stops a bomb. Env-tunable, applied only above a
// floor so a tiny but highly-compressible legit entry isn't flagged.
// ONE definition, used by the streaming (yauzl) reader AND the buffered (JSZip)
// reader — the buffered one had NO ratio guard at all before QA6 P7's review.
export const MAX_DECOMPRESSION_RATIO = Number(process.env.MYCELIUM_IMPORT_MAX_DECOMPRESSION_RATIO) || 200;
export const RATIO_FLOOR_BYTES = Number(process.env.MYCELIUM_IMPORT_RATIO_FLOOR_BYTES) || 10 * 1024 * 1024;

/**
 * Is this entry's DECLARED size pair a decompression bomb?
 * Declared sizes are attacker-controlled, so this is a cheap PRE-filter only —
 * the load-bearing guard is always the OBSERVED-byte counter in the readers.
 * A >2GiB size read from a signed u32 comes back negative: recover it (`>>> 0`)
 * so a huge bomb can't slip through as a negative number.
 */
export function isRatioBomb(uncompressedSize, compressedSize) {
  if (typeof uncompressedSize !== 'number' || typeof compressedSize !== 'number') return false;
  const unc = uncompressedSize < 0 ? uncompressedSize >>> 0 : uncompressedSize;
  const cmp = compressedSize < 0 ? compressedSize >>> 0 : compressedSize;
  return cmp > 0 && unc > RATIO_FLOOR_BYTES && unc / cmp > MAX_DECOMPRESSION_RATIO;
}

export function ambiguousEntryError(basename, count) {
  return `this archive contains ${count} files named ${basename} in different folders — ` +
    'Mycelium will not guess which export you meant. Unzip it and upload the single export folder ' +
    '(nothing was imported).';
}

export default {
  BUNDLE_EXTS, entryBasename, safeEntryBasename, entryExt, isNoiseEntry,
  isBundleEntry, findEntryByBasename, findEntriesByBasename, ambiguousEntryError,
  isVaultManifest, nestedVaultExportError, VAULT_EXPORT_FORMAT, isRatioBomb,
};
