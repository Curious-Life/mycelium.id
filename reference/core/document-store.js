/**
 * saveDocument — canonical write primitive for the documents table.
 *
 * Sub-primitive of publishArtifact (CLAUDE.md invariant #12; B5 in
 * docs/architecture/LIBRARY-CONSOLIDATION.md). publishArtifact still
 * owns R2 upload, attachments + linked-message inserts, and the
 * artifact-buffer for end-of-turn channel notification — saveDocument
 * owns the documents-table row only.
 *
 * Boundary contracts (B1–B5):
 *   B1 — content_hash = SHA-256(plaintext) at this boundary, before
 *        the encryption shim engages on `content`. Never on
 *        ciphertext; AES-GCM nonces randomize per encrypt and
 *        identical plaintext encrypts to different ciphertexts. The
 *        documents.content_hash column is intentionally excluded
 *        from ENCRYPTED_FIELDS (crypto-local.js:209-228) so dedup
 *        queries can read it.
 *   B2 — validatePath rejects empty / traversal / over-length /
 *        reserved-prefix paths structurally. Source determines
 *        which prefixes are reserved (system surfaces own theirs;
 *        agent-mcp stays free-form within the unreserved space).
 *   B3 — scope is required. Schema default 'org' is a silent
 *        cross-scope leak; saveDocument throws if scope is missing
 *        or not in ALLOWED_SCOPES.
 *   B4 — wasInsert detected via pre-SELECT (D1 has no portable
 *        RETURNING-with-action equivalent). One extra round-trip
 *        per write to a low-throughput table; acceptable.
 *   B5 — agent-egress per-channel `Map` listens to
 *        `artifact.published` ONLY, never to `document.created`.
 *        Portal uploads fire `document.created` but do not advance
 *        the egress buffer. Pinned by contract test in
 *        document-store.test.js.
 *
 * Race condition: the dedup probe is racy. Concurrent writes with
 * same hash but different paths can both succeed. v1 emits
 * `document.duplicate_detected` for audit; v2 will add
 * UNIQUE(user_id, content_hash) or a lock table. See §"Race +
 * observability" in the design doc.
 */

import { createHash } from 'node:crypto';

const PATH_MAX_LEN = 255;

// System-owned path prefixes. agent-mcp (free-form agent paths) cannot
// write under these; they're claimed by specific surfaces. Adding a
// new surface means adding its prefix here AND a PATH_STRATEGIES
// entry below.
//
// Post-Wave-5 (2026-05-05): Worker-side import handlers were amputated
// during the mind-search cleanup. Apple Notes had no VPS equivalent
// so it's gone entirely. The legacy `obsidian/` prefix is replaced by
// `import/` which covers the live VPS-side Obsidian importer at
// `import/obsidian/<name>` (see packages/core/import-parsers.js).
export const PATH_RESERVED_PREFIXES = [
  'agent-files/',
  'uploads/',
  'claude/',
  'import/',
  'published/',
  'drafts/',
  'inbound/',
];

export const ALLOWED_SCOPES = new Set(['personal', 'org', 'wealth', 'moms']);

export const VALID_SOURCES = new Set([
  'agent-mcp',
  'agent-scanner',
  'portal-upload',
  'portal-save',
  'bot-send-file',
  'import-claude',
  'import-obsidian',
  'import-batch',
  'import-vault',
]);

/**
 * Path strategies — one per system source. Returns the canonical
 * path for that surface. agent-mcp is free-form (caller passes the
 * full path via pathArgs.pathHint); validatePath enforces it doesn't
 * collide with reserved system prefixes.
 */
export const PATH_STRATEGIES = {
  'agent-scanner': ({ agentId, repoRelativePath }) => {
    if (!agentId || !repoRelativePath) {
      throw new SaveDocumentError(
        'agent-scanner: agentId + repoRelativePath required',
        'invalid_path_args',
      );
    }
    return `agent-files/${agentId}/${repoRelativePath}`;
  },
  'portal-upload': ({ filename }) => {
    if (!filename) throw new SaveDocumentError('portal-upload: filename required', 'invalid_path_args');
    return `uploads/${filename}`;
  },
  'bot-send-file': ({ filename, channel }) => {
    if (!filename || !channel) {
      throw new SaveDocumentError('bot-send-file: filename + channel required', 'invalid_path_args');
    }
    return `inbound/${channel}/${filename}`;
  },
  'agent-mcp': ({ pathHint }) => {
    if (!pathHint) throw new SaveDocumentError('agent-mcp: pathHint required', 'invalid_path_args');
    return pathHint;
  },
  // VPS-side Obsidian importer at packages/core/import-parsers.js
  // writes to `import/obsidian/<cleanName>` (no vault segment — the
  // ZIP's vault folder is stripped). Wave 5 deleted the legacy
  // worker-side importer that used `obsidian/<vault>/<file>`.
  'import-obsidian': ({ name }) => {
    if (!name) throw new SaveDocumentError('import-obsidian: name required', 'invalid_path_args');
    return `import/obsidian/${name}`;
  },
  // Note: 'import-claude' has no strategy entry. The Claude importer
  // writes to four distinct shapes (claude/projects/<uuid>/prompt,
  // claude/projects/<uuid>/docs/<name>, claude/memories/global,
  // claude/memories/project_<uuid>) that don't share a single
  // template, so callers pass `path:` explicitly. The `claude/`
  // reserved-prefix check in PATH_RESERVED_PREFIXES still fires for
  // agent-mcp callers — that's the security guard, independent of
  // path derivation.
  // 'import-batch' / 'import-vault' / 'portal-save' likewise have no
  // strategy: their callers always supply `path:` from manifest or
  // request body.
};

export class SaveDocumentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SaveDocumentError';
    this.code = code;
  }
}

/**
 * Resolve the agent process's bound scope from AGENT_SCOPES env. The
 * env var is a JSON array (e.g., `["personal"]`) per crypto-local.js
 * convention; the first element is the agent's primary scope.
 *
 * Falls back to 'org' when:
 *   - AGENT_SCOPES is unset (admin / backfill mode — `org` is a
 *     valid permissive scope, schema default)
 *   - AGENT_SCOPES is malformed JSON (corruption — fail safe)
 *   - first element is not a known scope (config drift — fail safe)
 *
 * Used by storeAttachmentRecord (publishArtifact chain) and the
 * MCP documents domain. Centralised here so a future change to the
 * env-var format (or scope inference) lands in one place.
 */
export function resolveAgentScope() {
  const raw = process.env.AGENT_SCOPES;
  if (!raw) return 'org';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (typeof first === 'string' && ALLOWED_SCOPES.has(first)) return first;
    }
  } catch { /* malformed env — fall through to 'org' */ }
  return 'org';
}

/**
 * Validate a document path. Throws SaveDocumentError on rejection.
 *
 * Source determines reserved-prefix enforcement:
 *   - agent-mcp paths are free-form but cannot start with a reserved
 *     prefix (those belong to system surfaces).
 *   - System sources use PATH_STRATEGIES which produce paths under
 *     their own reserved prefix; validatePath doesn't second-guess.
 */
export function validatePath(path, source) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SaveDocumentError('path is required and must be a non-empty string', 'invalid_path_empty');
  }
  if (path.length > PATH_MAX_LEN) {
    throw new SaveDocumentError(`path exceeds ${PATH_MAX_LEN} chars`, 'invalid_path_length');
  }
  if (path.startsWith('/') || path.endsWith('/')) {
    throw new SaveDocumentError('path cannot have leading/trailing slash', 'invalid_path_slash');
  }
  if (path.includes('//')) {
    throw new SaveDocumentError('path cannot contain `//`', 'invalid_path_double_slash');
  }
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new SaveDocumentError('path cannot contain `..` or `.` segments (traversal)', 'invalid_path_traversal');
  }
  if (path.includes('\0')) {
    throw new SaveDocumentError('path cannot contain null bytes', 'invalid_path_null');
  }

  if (source === 'agent-mcp') {
    for (const reserved of PATH_RESERVED_PREFIXES) {
      if (path.startsWith(reserved)) {
        throw new SaveDocumentError(
          `agent-mcp may not write under reserved prefix "${reserved}"; ` +
          `use a topic-style path like "people/sarah" or "business/project-x" instead`,
          'invalid_path_reserved_prefix',
        );
      }
    }
  }
}

/**
 * SHA-256(plaintext content), hex-encoded. Returns null when content
 * is null/undefined (no probe possible — caller should still write
 * the row, just without content_hash).
 */
export function computeContentHash(content) {
  if (content == null) return null;
  const text = typeof content === 'string' ? content : String(content);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @typedef {object} SaveDocumentDeps
 * @property {object} db — { documents: { get, upsert }, rawQuery? }
 * @property {(event: string, payload: object) => void} [emitEvent]
 *   Optional event emitter for `document.created` / `document.updated`
 *   / `document.duplicate_detected`. The live broadcaster + audit log
 *   subscribe here. agent-egress does NOT — it listens to
 *   `artifact.published` only (B5).
 */

/**
 * @typedef {object} SaveDocumentInput
 * @property {string} userId
 * @property {string} source — one of VALID_SOURCES
 * @property {string} scope — REQUIRED; one of ALLOWED_SCOPES
 * @property {string} createdBy — agent_id or 'user'; required
 * @property {string} [path] — explicit canonical path
 * @property {object} [pathArgs] — args for PATH_STRATEGIES[source] when path is omitted
 * @property {string} [content]
 * @property {string} [title]
 * @property {string} [summary]
 * @property {string} [sourcePath]
 * @property {string} [folderId]
 * @property {boolean} [isPinned]
 * @property {boolean} [isInternal]
 * @property {object|string} [metadata]
 * @property {string} [createdAt] — ISO-8601; preserves file mtime on backfill / scanner writes. Omit to use schema default (now()).
 * @property {string} [updatedAt] — ISO-8601; same. On UPDATE branch this overwrites the existing row's updated_at, which is what scanner reruns want.
 * @property {string} [sourceType] — value written to `documents.source_type` column. Defaults to `source`. Adopters that need legacy values for UI display (library list source pill maps `'upload'`, `'import_claude'`, `'import_obsidian'`, `'agent-output'`, `'agent-send-file'`) should pass them explicitly.
 */

/**
 * @typedef {object} SaveDocumentResult
 * @property {object} row — upserted documents row
 * @property {'created'|'created_with_duplicate'|'updated'} action
 * @property {boolean} wasInsert
 * @property {string|null} contentHash
 * @property {string[]} duplicatePaths — other paths sharing this content_hash (informational)
 */

/**
 * @param {SaveDocumentDeps} deps
 * @param {SaveDocumentInput} input
 * @returns {Promise<SaveDocumentResult>}
 */
export async function saveDocument(deps, input) {
  if (!deps?.db?.documents?.upsert || typeof deps.db.documents.upsert !== 'function') {
    throw new TypeError('saveDocument: deps.db.documents.upsert required');
  }
  if (!deps?.db?.documents?.get || typeof deps.db.documents.get !== 'function') {
    throw new TypeError('saveDocument: deps.db.documents.get required');
  }

  const {
    userId,
    source,
    scope,
    createdBy,
    path: explicitPath,
    pathArgs = {},
    content,
    title,
    summary,
    sourcePath,
    folderId,
    isPinned,
    isInternal,
    metadata,
    createdAt,
    updatedAt,
    sourceType,
  } = input ?? {};

  if (typeof userId !== 'string' || userId.length === 0) {
    throw new SaveDocumentError('userId is required', 'invalid_user_id');
  }
  if (typeof createdBy !== 'string' || createdBy.length === 0) {
    throw new SaveDocumentError('createdBy is required', 'invalid_created_by');
  }
  if (!VALID_SOURCES.has(source)) {
    throw new SaveDocumentError(
      `source must be one of ${[...VALID_SOURCES].join(', ')} (got: ${source})`,
      'invalid_source',
    );
  }
  if (typeof scope !== 'string' || !ALLOWED_SCOPES.has(scope)) {
    throw new SaveDocumentError(
      `scope is required; must be one of ${[...ALLOWED_SCOPES].join(', ')} (got: ${scope})`,
      'invalid_scope',
    );
  }

  let resolvedPath = explicitPath;
  if (!resolvedPath) {
    const strategy = PATH_STRATEGIES[source];
    if (!strategy) {
      throw new SaveDocumentError(
        `no path supplied and no PATH_STRATEGIES entry for source "${source}"`,
        'no_path_strategy',
      );
    }
    resolvedPath = strategy(pathArgs);
  }

  validatePath(resolvedPath, source);

  const contentHash = computeContentHash(content);

  const existing = await deps.db.documents.get(userId, resolvedPath);
  const wasInsert = !existing;

  let duplicatePaths = [];
  if (contentHash) {
    duplicatePaths = await findDuplicatesByHash(deps.db, userId, contentHash, resolvedPath);
    if (duplicatePaths.length > 0) {
      deps.emitEvent?.('document.duplicate_detected', {
        userId, scope, path: resolvedPath, contentHash, duplicatePaths,
      });
    }
  }

  const doc = {
    user_id: userId,
    path: resolvedPath,
  };
  // INSERT-only fields. The documents.upsert helper builds an
  // ON CONFLICT DO UPDATE SET clause from every column present in
  // `doc`, so anything we put here gets overwritten on update.
  // scope, created_by, and source_type are provenance fields that
  // belong to the row's first creation:
  //   - scope: changing it post-creation is a cross-scope migration
  //     (security-sensitive; should not happen as a side effect of
  //     editing). Existing scope is the source of truth.
  //   - created_by: identifies the original author. Last-editor info
  //     belongs in metadata or audit_log, not this column.
  //   - source_type: drives the library list UI's source pill (e.g.
  //     "via Obsidian"). Editing an Obsidian-imported doc through the
  //     portal must NOT clobber 'import_obsidian' to 'portal-save'.
  // Including them only when wasInsert=true makes UPDATE SET skip
  // them entirely, so the existing column values are preserved.
  if (wasInsert) {
    doc.scope = scope;
    doc.created_by = createdBy;
    // source_type is the legacy column the library list UI reads
    // for source pills (e.g. 'upload', 'import_claude'). Caller can
    // pass an explicit `sourceType` to preserve those values; default
    // is the canonical `source` enum so new adopters at least get a
    // consistent value (UI falls through to null for unknown
    // sourceTypes — same as omitted).
    doc.source_type = typeof sourceType === 'string' ? sourceType : source;
  }
  if (content !== undefined)    doc.content = content;
  if (title !== undefined)      doc.title = title;
  if (summary !== undefined)    doc.summary = summary;
  if (sourcePath !== undefined) doc.source_path = sourcePath;
  if (folderId !== undefined)   doc.folder_id = folderId;
  if (isPinned !== undefined)   doc.is_pinned = isPinned ? 1 : 0;
  if (isInternal !== undefined) doc.is_internal = isInternal ? 1 : 0;
  if (metadata !== undefined) {
    doc.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  }
  if (contentHash !== null) doc.content_hash = contentHash;
  // Timestamp pass-through: scanner + backfill writes preserve the
  // file's mtime so library sort order reflects when the agent
  // actually wrote the file, not when the chat turn ran. On the
  // INSERT branch this overrides the schema default; on the UPDATE
  // branch it overwrites the existing row's updated_at (intentional
  // — a scanner re-run on a changed file should bump updated_at to
  // the new mtime).
  if (createdAt !== undefined) doc.created_at = createdAt;
  if (updatedAt !== undefined) doc.updated_at = updatedAt;

  const row = await deps.db.documents.upsert(doc);

  const eventName = wasInsert ? 'document.created' : 'document.updated';
  deps.emitEvent?.(eventName, {
    userId, scope, path: resolvedPath, source, contentHash, wasInsert, row,
  });

  return {
    row,
    action: wasInsert
      ? (duplicatePaths.length > 0 ? 'created_with_duplicate' : 'created')
      : 'updated',
    wasInsert,
    contentHash,
    duplicatePaths,
  };
}

/**
 * Probe for other paths sharing this content_hash. Informational
 * only — never blocks the write. The probe is racy (concurrent
 * writes can both pass before either commits); v1 accepts this.
 */
async function findDuplicatesByHash(db, userId, contentHash, currentPath) {
  if (typeof db.rawQuery !== 'function') return [];
  try {
    const rows = await db.rawQuery(
      `SELECT path FROM documents
        WHERE user_id = ? AND content_hash = ? AND path != ?
        LIMIT 5`,
      [userId, contentHash, currentPath],
    );
    return Array.isArray(rows) ? rows.map((r) => r.path).filter(Boolean) : [];
  } catch {
    return [];
  }
}
