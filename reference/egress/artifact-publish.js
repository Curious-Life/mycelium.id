/**
 * publishArtifact — single chokepoint for "agent created something the
 * user should see in their library + know about in the channel".
 *
 * The April 2026 Ada incident exposed three independent silent-fail
 * paths in the agent-output pipeline:
 *
 *   1. Files written by the scanner went to documents but with a flat
 *      'uploads/<basename>' path that collided across folders, lost
 *      provenance, and never linked to the inbound channel.
 *   2. Files sent via /discord/send-file inlined a near-duplicate doc
 *      upsert in three places (telegram, discord, whatsapp) — drift
 *      and inconsistent metadata.
 *   3. Either path could fail at any of: R2 upload, doc upsert,
 *      attachments insert, linked message — and the user would never
 *      learn anything failed because each `.catch(() => {})` swallowed
 *      the error.
 *
 * publishArtifact replaces all three with one named operation:
 *
 *     publishArtifact({
 *       source, filePath, filename, mimeType, content,
 *       inboundChannel, taskId, metadata, repoRelativePath,
 *     })
 *       → { documentPath, attachmentId, messageId } | null
 *
 *   1. Resolves canonical user_id (operator id, not env coupling).
 *   2. Uploads to R2 (fail-loud — emits artifact.publish_failed).
 *   3. Calls storeAttachmentRecord with rich documentPath + metadata
 *      (single existing primitive does the documents + attachments +
 *      linked message inserts in one place).
 *   4. Records the artifact in the runtimeState per-task buffer so
 *      chat.js's task-end notification logic can summarize it.
 *   5. Emits hookBus events: artifact.published / artifact.publish_failed.
 *
 * Composes with — never bypasses — the existing primitives:
 *   - messages-io.js: storeAttachmentRecord, uploadFileToR2
 *   - state-machine.js: trackExplicitSend (NOT incremented here —
 *     publishing is distinct from explicit channel delivery; the
 *     channel notification uses agent-egress instead)
 *   - runtime-state.js: hookBus, artifactBuffer
 *   - canonical-user-id.js: getCanonicalOperatorId
 *
 * Security: documents.metadata + attachments.metadata are in
 * ENCRYPTED_FIELDS, so the JSON-stringified metadata blob is encrypted
 * at rest by the Swiss Vault layer. inboundChannel + taskId are small
 * structured provenance fields, no PII. R2 storage path is the
 * existing tenant-isolated convention.
 *
 * @typedef {object} PublishArtifactDeps
 * @property {string} agentId
 * @property {string} logPrefix
 * @property {() => any|null} tryGetDb
 * @property {object} fs                                   — fs/promises
 * @property {(filePath: string|null, base64: string|null, filename: string, mimeType: string) => Promise<{r2Key: string, fileSize: number}|null>} uploadFileToR2
 * @property {(args: object) => Promise<{attachmentId: string, documentPath: string|null}|null>} storeAttachmentRecord
 * @property {(db: any, opts?: object) => Promise<string|null>} getCanonicalOperatorId
 * @property {object} runtimeState                         — RuntimeStateService instance (hookBus, artifact buffer)
 * @property {(agentId: string) => string} [getAgentDisplayName] — PR 5.4-B: maps agentId → human folder name
 * @property {object} [env]                                — process.env-shaped test seam
 */

/**
 * Mime-type guess from filename when caller doesn't provide one.
 * Conservative — falls back to 'application/octet-stream' for unknowns
 * so storeAttachmentRecord doesn't accidentally create a doc row for
 * a binary file.
 */
function guessMimeType(filename) {
  if (!filename) return 'application/octet-stream';
  const ext = filename.toLowerCase().match(/\.([^.]+)$/)?.[1];
  switch (ext) {
    case 'md':       return 'text/markdown';
    case 'txt':      return 'text/plain';
    case 'csv':      return 'text/csv';
    case 'json':     return 'application/json';
    case 'xml':      return 'text/xml';
    case 'html':     return 'text/html';
    case 'log':      return 'text/plain';
    case 'yml':
    case 'yaml':     return 'text/yaml';
    case 'toml':     return 'text/plain';
    case 'ini':
    case 'conf':     return 'text/plain';
    case 'sh':       return 'text/x-shellscript';
    case 'py':       return 'text/x-python';
    case 'js':       return 'text/javascript';
    case 'ts':       return 'text/typescript';
    case 'pdf':      return 'application/pdf';
    case 'png':      return 'image/png';
    case 'jpg':
    case 'jpeg':     return 'image/jpeg';
    case 'gif':      return 'image/gif';
    case 'webp':     return 'image/webp';
    case 'mp3':      return 'audio/mpeg';
    case 'ogg':      return 'audio/ogg';
    case 'wav':      return 'audio/wav';
    case 'mp4':      return 'video/mp4';
    case 'webm':     return 'video/webm';
    default:         return 'application/octet-stream';
  }
}

/** Slash-trim a path; leave the rest alone. Used to derive the
 *  documents.path key from a repo-relative file path. */
function normalizeRepoRelativePath(p) {
  if (!p) return null;
  return String(p).replace(/^\/+/, '').replace(/\/+$/, '');
}

export function createArtifactPublisher(deps) {
  if (!deps) throw new TypeError('createArtifactPublisher: deps required');
  const {
    agentId, logPrefix,
    tryGetDb, fs,
    uploadFileToR2, storeAttachmentRecord,
    getCanonicalOperatorId,
    runtimeState,
    getAgentDisplayName,
    env = process.env,
  } = deps;

  if (typeof agentId !== 'string')                    throw new TypeError('createArtifactPublisher: agentId required');
  if (typeof logPrefix !== 'string')                  throw new TypeError('createArtifactPublisher: logPrefix required');
  if (typeof tryGetDb !== 'function')                 throw new TypeError('createArtifactPublisher: tryGetDb required');
  if (!fs?.readFile)                                  throw new TypeError('createArtifactPublisher: fs required');
  if (typeof uploadFileToR2 !== 'function')           throw new TypeError('createArtifactPublisher: uploadFileToR2 required');
  if (typeof storeAttachmentRecord !== 'function')    throw new TypeError('createArtifactPublisher: storeAttachmentRecord required');
  if (typeof getCanonicalOperatorId !== 'function')   throw new TypeError('createArtifactPublisher: getCanonicalOperatorId required');
  if (!runtimeState?.recordArtifact)                  throw new TypeError('createArtifactPublisher: runtimeState.recordArtifact required');

  // PR 5.4-B: per-agent folder caches. One DB hit per (userId, agentId)
  // for the agent root, then one per (userId, rootId, segment) for each
  // sub-folder, for the lifetime of this publisher instance. Map keys
  // are stringified to avoid the object-equality footgun.
  const agentRootFolderCache = new Map();   // `${userId}:${agentId}` → folderId
  const subFolderCache       = new Map();   // `${userId}:${rootId}:${segment}` → folderId

  /**
   * Resolve which folder this artifact lands in. Returns null on any
   * lookup failure or when display-name resolution is unavailable —
   * the publish proceeds with folder_id NULL, which is the legacy
   * unfiled-but-published behaviour. Failure here must never block
   * the publish itself.
   *
   * Sub-folder is derived from the FIRST path segment of repoRel
   * (only). Files at agent root (no slash) skip the sub-folder.
   * Degenerate segments (`.`, `..`, blank) are ignored.
   */
  async function resolveAgentFolderId(userId, repoRel) {
    if (!userId || typeof getAgentDisplayName !== 'function') return null;
    const db = tryGetDb();
    if (!db?.folders?.ensureAgentFolder) return null;

    // Agent root folder.
    const rootKey = `${userId}:${agentId}`;
    let rootId = agentRootFolderCache.get(rootKey) || null;
    if (!rootId) {
      try {
        const displayName = getAgentDisplayName(agentId) || agentId;
        const root = await db.folders.ensureAgentFolder(userId, agentId, displayName);
        rootId = root?.id || null;
        if (rootId) agentRootFolderCache.set(rootKey, rootId);
      } catch (err) {
        console.error(`[${logPrefix}] publishArtifact: ensureAgentFolder failed: ${err.message}`);
        return null;
      }
    }
    if (!rootId) return null;

    // Sub-folder from first path segment, if any.
    const firstSlash = (repoRel || '').indexOf('/');
    if (firstSlash <= 0) return rootId;
    const segment = repoRel.slice(0, firstSlash);
    if (segment === '.' || segment === '..' || !segment.trim()) return rootId;

    const subKey = `${userId}:${rootId}:${segment}`;
    let subId = subFolderCache.get(subKey) || null;
    if (!subId) {
      try {
        if (typeof db.folders.ensureSubFolder !== 'function') return rootId;
        const sub = await db.folders.ensureSubFolder(userId, rootId, segment);
        subId = sub?.id || null;
        if (subId) subFolderCache.set(subKey, subId);
      } catch (err) {
        console.error(`[${logPrefix}] publishArtifact: ensureSubFolder failed for "${segment}": ${err.message}`);
        return rootId;
      }
    }
    return subId || rootId;
  }

  /**
   * Publish an artifact.
   *
   * @param {object} args
   * @param {'scanner'|'send-file'|'agent-tool'|string} args.source
   * @param {string} [args.filePath]              — absolute path; if absent, content must be provided
   * @param {string} [args.filename]              — defaults to basename of filePath
   * @param {string} [args.mimeType]              — auto-detected from filename if absent
   * @param {string} [args.repoRelativePath]      — preferred over basename for documents.path keying
   * @param {{kind: string, id: string}} [args.inboundChannel] — for provenance + channel notification
   * @param {string} [args.taskId]                — correlates with chat handler's task-end logic
   * @param {object} [args.metadata]              — additional structured provenance
   * @returns {Promise<{documentPath: string|null, attachmentId: string|null, messageId: null}|null>}
   */
  async function publishArtifact(args) {
    const {
      source = 'agent-output',
      filePath = null,
      filename: providedFilename = null,
      mimeType: providedMimeType = null,
      repoRelativePath = null,
      inboundChannel = null,
      taskId = null,
      metadata: extraMetadata = null,
    } = args || {};

    const hookBus = runtimeState.hookBus?.() || null;

    if (!filePath) {
      // The scanner + send-file paths both have a real filePath; an
      // in-memory-only artifact path isn't supported yet (would require
      // a base64 fallback through uploadFileToR2). Caller bug.
      console.error(`[${logPrefix}] publishArtifact: filePath required`);
      hookBus?.emit('artifact.publish_failed', { agentId, source, reason: 'no-file-path' });
      return null;
    }

    const filename  = providedFilename || filePath.split('/').pop();
    const mimeType  = providedMimeType || guessMimeType(filename);
    const docRel    = normalizeRepoRelativePath(repoRelativePath || filename);
    const documentPath = `agent-files/${agentId}/${docRel}`;

    // Tenant resolution — never falls back to a hard-coded env unless
    // truly nothing else is available. canonical-user-id.js memoizes.
    let userId = null;
    try {
      const db = tryGetDb();
      userId = await getCanonicalOperatorId(db, { envFallback: env.USER_ID });
    } catch (err) {
      console.error(`[${logPrefix}] publishArtifact: canonical user-id resolution failed: ${err.message}`);
    }
    if (!userId) {
      console.error(`[${logPrefix}] publishArtifact: no userId — skipping (file: ${filename})`);
      hookBus?.emit('artifact.publish_failed', { agentId, source, filename, reason: 'no-user-id' });
      return null;
    }

    // Stat the file once. Don't re-read content here — storeAttachmentRecord
    // pulls content from R2 to avoid double-loading large files. mtimeMs
    // is reused below as the documents.created_at / updated_at value (PR
    // 5.1: preserve original write time instead of "now").
    let fileSize = null;
    let mtimeMs = null;
    try {
      const stats = await fs.stat(filePath);
      fileSize = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch (err) {
      console.error(`[${logPrefix}] publishArtifact: stat failed for ${filePath}: ${err.message}`);
      hookBus?.emit('artifact.publish_failed', {
        agentId, source, filename, reason: 'stat-failed',
        error: err.message,
      });
      return null;
    }

    // 1. R2 upload — fail-loud + hook on failure.
    let r2Key = null;
    let r2FileSize = fileSize;
    try {
      const r2 = await uploadFileToR2(filePath, null, filename, mimeType);
      if (r2 && r2.r2Key) {
        r2Key = r2.r2Key;
        r2FileSize = r2.fileSize ?? fileSize;
      } else {
        console.error(`[${logPrefix}] publishArtifact: R2 upload returned null for ${filename}`);
        hookBus?.emit('artifact.publish_failed', {
          agentId, source, filename, reason: 'r2-upload-null',
        });
        // Continue without r2Key — documents row won't be created (the
        // text-file path in storeAttachmentRecord requires r2Key) but
        // the agent's work is still recorded as an attachment-less
        // message row below. Callers that need the doc row check the
        // returned documentPath.
      }
    } catch (err) {
      console.error(`[${logPrefix}] publishArtifact: R2 upload threw: ${err.message}`);
      hookBus?.emit('artifact.publish_failed', {
        agentId, source, filename, reason: 'r2-upload',
        error: err.message,
      });
      return null;
    }

    // 2. Persist via storeAttachmentRecord — single primitive does
    //    attachments insert + linked messages row + (text files only)
    //    documents upsert at the rich path.
    //
    //    The metadata bundle is encrypted at rest by the Swiss Vault
    //    layer (documents.metadata + messages.metadata are in
    //    ENCRYPTED_FIELDS). inboundChannel + taskId are small structured
    //    provenance, no PII.
    const docMetadata = {
      origin: 'agent-output',
      source,
      ...(inboundChannel ? { inboundChannel } : {}),
      ...(taskId ? { taskId } : {}),
      ...(extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {}),
    };

    // PR 5.1: pass the file's mtime as the document's timestamps so
    // backfilled rows + live-scanner rows preserve the original write
    // time. Without this, library ordering is "when the chat turn ran"
    // not "when the agent wrote the file" — confusing once a backfill
    // has happened.
    const fileTimestamp = mtimeMs
      ? new Date(mtimeMs).toISOString()
      : null;

    // PR 5.4-B: resolve the agent's folder (root + optional sub from
    // first path segment). Best-effort: failure here returns null and
    // the publish proceeds with folder_id NULL — same as legacy.
    const documentFolderId = await resolveAgentFolderId(userId, docRel);

    let attached = null;
    try {
      attached = await storeAttachmentRecord({
        userId,
        filename,
        mimeType,
        source: 'agent-file',
        fileSize: r2FileSize,
        r2Key,
        documentPath,
        documentSourceType: source === 'scanner' ? 'agent-output' : (source === 'send-file' ? 'agent-send-file' : 'agent-output'),
        documentMetadata: docMetadata,
        documentCreatedAt: fileTimestamp,
        documentUpdatedAt: fileTimestamp,
        documentFolderId,
        metadata: { taskId, inboundChannel },
        caption: filename,
      });
    } catch (err) {
      console.error(`[${logPrefix}] publishArtifact: storeAttachmentRecord threw: ${err.message}`);
      hookBus?.emit('artifact.publish_failed', {
        agentId, source, filename, reason: 'attachment-record',
        error: err.message,
      });
      return null;
    }

    if (!attached) {
      hookBus?.emit('artifact.publish_failed', {
        agentId, source, filename, reason: 'attachment-record-null',
      });
      return null;
    }

    // 3. Record in the per-task buffer so chat.js can consolidate at
    //    end-of-turn. Skipped silently if no taskId — non-task paths
    //    (cron, manual triggers) shouldn't produce notifications.
    //
    // Only record artifacts that ACTUALLY made it into the documents
    // table. When R2 fails, attached.documentPath is null and the row
    // doesn't exist — recording it would surface a phantom path to
    // the user in the channel notification.
    const finalDocumentPath = attached.documentPath || null;
    if (taskId && finalDocumentPath) {
      runtimeState.recordArtifact(taskId, {
        path: finalDocumentPath,
        title: filename.replace(/\.[^.]+$/, ''),
        filename,
        mimeType,
        fileSize: r2FileSize,
        source,
        attachmentId: attached.attachmentId,
        documentPath: finalDocumentPath,
      });
    }

    // 4. Success hook — the external webhook bot + activity feed observers.
    hookBus?.emit('artifact.published', {
      agentId, source, filename,
      documentPath: finalDocumentPath,
      attachmentId: attached.attachmentId,
      taskId: taskId || null,
      inboundChannel: inboundChannel || null,
      timestamp: new Date().toISOString(),
    });

    console.log(`[${logPrefix}] artifact.published: ${finalDocumentPath || '(no-doc)'} (${filename}, ${r2FileSize ?? '?'}B, source=${source})`);

    return {
      documentPath: finalDocumentPath,
      attachmentId: attached.attachmentId,
      messageId: null, // storeAttachmentRecord doesn't expose this yet; future enhancement
    };
  }

  return { publishArtifact };
}

// Exported for tests + reuse.
export { guessMimeType, normalizeRepoRelativePath };
