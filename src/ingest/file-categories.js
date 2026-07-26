// Shared file-type taxonomy for the broad "what's on this Mac" sweep — used by
// BOTH the detector (counts per category, no content read) and the importer
// (routes each file: text → document+memory, media → encrypted attachment).
// One source of truth so a category can never drift between count and import.

/** Category → human label + the lowercased extensions (no dot) that belong to it. */
export const FILE_CATEGORIES = {
  document: {
    label: 'Documents & notes',
    exts: new Set(['md', 'markdown', 'txt', 'text', 'rtf', 'pdf', 'doc', 'docx', 'odt', 'pages', 'csv', 'tsv', 'org', 'rst', 'tex', 'epub']),
  },
  image: {
    label: 'Photos & images',
    exts: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'svg', 'avif']),
  },
  audio: {
    label: 'Audio & voice memos',
    exts: new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'aiff', 'aif', 'opus', 'wma']),
  },
  video: {
    label: 'Video',
    exts: new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']),
  },
};

/**
 * The complete, canonical category set — the ONLY place the four keys are
 * enumerated. Callers validate a user's selection against this; nothing may
 * treat "unknown" or "missing" as "all" (D-070: a deselected category was
 * imported anyway when the selection arrived empty).
 */
export const ALL_FILE_CATEGORIES = Object.freeze(Object.keys(FILE_CATEGORIES));

/**
 * Fail-closed normalisation of a user's category selection.
 * Returns ONLY the recognised keys, in canonical order, de-duplicated.
 * A non-array, an empty array, or an array of unknown keys all normalise to
 * `[]` — i.e. IMPORT NOTHING. There is deliberately no widening branch: an
 * ambiguous selection must never become "import everything".
 * @param {unknown} selection
 * @returns {string[]}
 */
export function normalizeCategorySelection(selection) {
  if (!Array.isArray(selection)) return [];
  const picked = new Set(selection.filter((c) => typeof c === 'string'));
  return ALL_FILE_CATEGORIES.filter((c) => picked.has(c));
}

/**
 * ONE walk shape for BOTH the detector (which advertises the counts the user
 * consents to) and the importer (which acts on that consent).
 *
 * They used to disagree: the detector counted at maxDepth 5 and skipped only
 * dotdirs + managed packages, while the importer walked maxDepth 8 and also
 * pruned SKIP_DIRS. So a documents-only import could enrol MORE documents than
 * its own chip advertised (measured on the pre-fix tree: chip said 7, the
 * importer enrolled 9) — and, against an all-category progress denominator,
 * that is indistinguishable from "it imported everything anyway", which is
 * exactly what the user reported (D-070). The number a user agrees to and the
 * number that lands MUST come from the same walk.
 */
export const SWEEP_MAX_DEPTH = 8;
/**
 * Directories neither walk descends: VCS internals, package/dep trees, caches,
 * and ~/Library (never "useful context", and enormous). Kept here rather than in
 * either walker so they cannot drift apart again.
 */
export const SWEEP_SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.Trash', '.trash', '.cache', 'Caches', '.npm', '.obsidian', '.smart-env', 'Library']);
/** True when a directory entry name must not be descended by either walk. */
export function isSkippedSweepDir(name) {
  const n = String(name);
  return n.startsWith('.') || SWEEP_SKIP_DIRS.has(n) || isManagedPackageDir(n);
}

// The subset of `document` extensions whose bytes are UTF-8 text we can read
// directly into a document body + a mindscape memory. The rest (pdf/doc/docx/
// odt/pages/epub) are binary containers — imported as ENCRYPTED attachments,
// preserved verbatim for later extraction, never silently dropped.
export const TEXT_DOC_EXTS = new Set(['md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'org', 'rst', 'tex', 'log']);

// MIME by extension for attachment rows (mirrors obsidian-import's ASSET_MIME,
// widened to the full sweep set). Unknown → application/octet-stream.
export const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  tiff: 'image/tiff', tif: 'image/tiff',
  pdf: 'application/pdf', doc: 'application/msword', odt: 'application/vnd.oasis.opendocument.text',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip', rtf: 'application/rtf', pages: 'application/x-iwork-pages-sffpages',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg',
  flac: 'audio/flac', aiff: 'audio/aiff', aif: 'audio/aiff', opus: 'audio/opus', wma: 'audio/x-ms-wma',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
};

// macOS "library packages" (Photos/Music/iMovie/etc.) present as directories but
// hold a managed DB of tens of thousands of internal files — walking them wholesale
// would pull the entire managed store, not the user's loose, intentional files.
// Skipped by both the sweep and the detector; loose media elsewhere still imports.
const MANAGED_PACKAGE_RE = /\.(photoslibrary|photolibrary|migratedphotolibrary|aplibrary|tvlibrary|theater|musiclibrary|imovielibrary|fcpbundle|logicx|band)$/i;
export function isManagedPackageDir(name) { return MANAGED_PACKAGE_RE.test(String(name)); }

/** Lowercased extension (no dot) of a filename, or '' if none. */
export function extOf(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** Category key for a filename ('document'|'image'|'audio'|'video'), or null if uninteresting. */
export function categoryOf(name) {
  const ext = extOf(name);
  if (!ext) return null;
  for (const [key, def] of Object.entries(FILE_CATEGORIES)) {
    if (def.exts.has(ext)) return key;
  }
  return null;
}
