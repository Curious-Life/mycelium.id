/**
 * Portal library router (Phase 10 PR 7B).
 *
 * Owns the user-visible content library — documents, folders, messages,
 * attachments, and chat history. All 17 handlers:
 *
 *   Documents (6):
 *     GET    /portal/documents              — list (category/folder/pinned)
 *     GET    /portal/documents/*path        — load one
 *     POST   /portal/documents              — upsert
 *     POST   /portal/documents/move         — move to folder
 *     POST   /portal/documents/pin          — pin/unpin
 *     DELETE /portal/documents/*path        — delete
 *
 *   Folders (4):
 *     GET    /portal/folders                — list
 *     POST   /portal/folders                — create
 *     PUT    /portal/folders/:id            — rename
 *     DELETE /portal/folders/:id            — delete
 *
 *   Messages + chat (2):
 *     GET    /portal/messages               — timeline, attachment-enriched
 *     GET    /portal/chat/history           — recent messages per agent
 *
 *   Attachments (5):
 *     GET    /portal/attachments            — media gallery
 *     PUT    /portal/attachments/:id        — update description
 *     DELETE /portal/attachments/:id        — delete (DB + R2 + Stream)
 *     GET    /portal/attachment/:id         — authenticated R2 proxy
 *     GET    /portal/stream-token/:id       — Cloudflare Stream playback token
 *
 * All gated by portal session (no worker-secret layer — library reads
 * are the primary portal workload). Ownership is enforced at the row
 * level for every attachment handler before any upstream I/O runs.
 */

import { Router } from 'express';
import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';
import { resolveOwnerName } from '@mycelium/core/owner-name.js';
import { projectTimelineRow } from '../lib/message-projection.js';
import { createPublicRenderer, isValidSlug, deriveSlug } from '@mycelium/core/public-render.js';
import { subscribe as subscribeDocLive, subscribeList as subscribeListLive } from '../lib/doc-broadcaster.js';
import { saveDocument, ALLOWED_SCOPES, SaveDocumentError } from '@mycelium/core/document-store.js';

/**
 * Detect whether a doc is an HTML source (vs the default markdown).
 * Mirrors `isHtmlDoc` in packages/portal/src/routes/(app)/library/+page.svelte
 * — keep the two in lockstep so server-side export rendering matches what
 * the library iframe shows.
 *
 * @param {string|null|undefined} path
 * @param {string|null|undefined} content
 * @returns {boolean}
 */
function isHtmlSource(path, content) {
  if (path && /\.html?$/i.test(path)) return true;
  if (typeof content === 'string' && content) {
    const head = content.trimStart().slice(0, 100).toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
  }
  return false;
}

/**
 * @typedef {object} CreatePortalLibraryRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(req: any) => string|null}          extractSessionToken
 * @property {object} config                      — { LOG_PREFIX, MYA_WORKER_URL }
 * @property {object} [log]
 */

export function createPortalLibraryRouter(deps) {
  if (!deps) throw new TypeError('createPortalLibraryRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    extractSessionToken,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalLibraryRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalLibraryRouter: tryGetDb required');
  }
  if (typeof extractSessionToken !== 'function') {
    throw new TypeError('createPortalLibraryRouter: extractSessionToken required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalLibraryRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX, MYA_WORKER_URL } = config;
  const logger = log || console;
  const router = Router();

  // Public-render chokepoint — used by publish + share routes.
  // Lazy-built so a misconfigured Worker URL doesn't crash router
  // creation; the routes that need it surface a 503 instead.
  let _publicRenderer = null;
  function getPublicRenderer() {
    if (_publicRenderer) return _publicRenderer;
    if (!MYA_WORKER_URL) return null;
    _publicRenderer = createPublicRenderer({
      tryGetDb,
      workerUrl: MYA_WORKER_URL,
      getWorkerToken: () => getWorkerSecret() || process.env.AGENT_TOKEN || '',
      log: logger,
    });
    return _publicRenderer;
  }

  // Derive a unique-per-user slug. If the caller supplied one,
  // validate it and check for conflict; otherwise auto-derive from
  // the doc's title or filename, appending a numeric suffix on
  // collision.
  async function resolvePublishSlug(db, userId, docPath, doc, suppliedSlug) {
    if (suppliedSlug) {
      if (!isValidSlug(suppliedSlug)) {
        throw Object.assign(new Error('Invalid slug — lowercase letters, digits, hyphens only'), { status: 400 });
      }
      const conflict = await db.documents.getBySlug(userId, suppliedSlug);
      if (conflict && conflict.path !== docPath) {
        throw Object.assign(new Error('Slug already in use'), { status: 409 });
      }
      return suppliedSlug;
    }
    // If the doc already has a slug (re-publish or share-link
    // already created), reuse it. Slugs are immutable until rename.
    if (doc.public_slug && isValidSlug(doc.public_slug)) {
      return doc.public_slug;
    }
    // Auto-derive from title, fall back to filename.
    const base = deriveSlug(doc.title) || deriveSlug(docPath.split('/').pop());
    if (!base) {
      throw Object.assign(new Error("Couldn't derive a slug from this doc — please supply one"), { status: 400 });
    }
    // Collision-check: append -2, -3, ... until free.
    let candidate = base;
    for (let i = 2; i < 1000; i++) {
      const conflict = await db.documents.getBySlug(userId, candidate);
      if (!conflict || conflict.path === docPath) return candidate;
      candidate = `${base}-${i}`;
    }
    throw new Error('Could not find a free slug');
  }

  // Resolve the operator's public handle for URL construction.
  //
  // Pre-PR-4: this function did `db.rawQuery('SELECT … FROM
  // handle_reservations …')` against the *tenant* D1 — a real bug for
  // managed customers, since handle_reservations only lives on owner
  // D1. Now routes through `db.handles.mine()` which calls the typed
  // Worker endpoint and authenticates via the agent's bearer token.
  // The userId argument is ignored (kept in the signature so the
  // call sites don't need updating beyond the function body); the
  // Worker derives user_id from the token, and the publish/share
  // routes already verified the caller IS the operator before
  // reaching this point.
  //
  // See docs/architecture/HANDLE-REGISTRY-FIX.md §PR-4.
  async function getOwnerHandle(db, _userId) {
    return await db.handles.mine();
  }

  // Map r2_key path prefix → UI attachment type.
  const inferAttachmentType = (t, r2Key) => {
    if (t === 'image') return 'image';
    if (t === 'voice' || t === 'audio') return 'voice';
    if (t === 'video') return 'video';
    if (t) return 'file';
    if (r2Key?.includes('/voice/')) return 'voice';
    if (r2Key?.includes('/image/')) return 'image';
    if (r2Key?.includes('/video/')) return 'video';
    return 'file';
  };


  // ══════════════════════════════════════════════════════════════════
  // Documents
  // ══════════════════════════════════════════════════════════════════

  // SSE: per-document live update stream. Viewer opens this with the
  // doc's path and receives `doc-updated` / `doc-removed` events as the
  // agent (or any other writer) modifies the doc. Auth is the standard
  // portal session — the broadcaster keys on `(authenticatedUserId,
  // path)` so a client can never receive another tenant's events.
  //
  // Path comes via querystring (encodeURIComponent on client) rather
  // than a glob route: avoids ambiguity with /portal/documents/*path
  // and keeps the path verbatim (slashes intact) without splat
  // re-assembly.
  router.get('/portal/sse/document', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const docPath = typeof req.query.path === 'string' ? req.query.path : null;
      if (!docPath) return res.status(400).json({ error: 'path query param required' });

      const dispose = subscribeDocLive(user.id, docPath, res);
      req.on('close', dispose);
      // Don't `return` — the connection stays open until the client
      // closes it. Express won't time it out because we already sent
      // the response head.
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] [sse/document] ${e.message}`);
      // If headers are already sent the broadcaster owns the response;
      // otherwise surface the error normally.
      if (!res.headersSent) res.status(500).json({ error: 'SSE setup failed' });
    }
  });

  // List-level SSE (PR 5). Subscribers: library list page — one
  // connection per browser tab, opened on mount, closed on unmount.
  // Receives `document-upserted` / `document-removed` events for the
  // authenticated user. Payloads are metadata-only (path + scope +
  // updated_at) per the doc-broadcaster threat model; clients refetch
  // GET /portal/documents/<path> for live row state.
  router.get('/portal/sse/library', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const dispose = subscribeListLive(user.id, res);
      req.on('close', dispose);
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] [sse/library] ${e.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'SSE setup failed' });
    }
  });

  router.get('/portal/documents', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const category = req.query.category || null;
      const folderId = req.query.folder_id || null;
      const pinnedOnly = req.query.pinned === '1';
      const docs = await db.documents.list(user.id, { category, folderId, pinnedOnly });
      res.json({ documents: docs });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Documents list failed:`, e.message);
      res.status(500).json({ error: 'Failed to load documents' });
    }
  });

  // Publishing sub-routes share this URL space (`/portal/documents/<path>/share-status`,
  // `/publish`, `/unpublish`, `/share`). Express 5's `*path` is greedy with no
  // anchor, so without this fall-through the catch-all here would consume those
  // suffixes and 404 with "Document not found". Calling next() lets the more-
  // specific routes registered below match.
  const PUBLISHING_SUFFIXES = ['/share-status', '/publish', '/unpublish', '/share'];

  router.get('/portal/documents/*path', async (req, res, next) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const rawPath = req.params.path || req.params[0];
      const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      // Fall through if this is a publishing sub-route URL (see PUBLISHING_SUFFIXES).
      if (typeof docPath === 'string' && PUBLISHING_SUFFIXES.some((s) => docPath.endsWith(s))) {
        return next();
      }
      const doc = await db.documents.get(user.id, docPath);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      res.json({ document: doc });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Document get error:`, e.message, 'params:', JSON.stringify(req.params));
      res.status(500).json({ error: 'Failed to load document' });
    }
  });

  // ── Document export — pandoc-driven format conversion (PR 5.3) ─────
  // Streams the requested format as a download. Decrypted content
  // never leaves the VPS process (the pandoc child reads it from
  // stdin, writes to stdout, both intra-process). pandoc must be on
  // PATH; missing → 501. Allowed formats are gated to the four we've
  // tested (md/html/pdf/docx). Tests in test/routes/portal-library.test.js.
  router.post('/portal/documents/export', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { path: docPath, format } = req.body || {};
      if (!docPath || typeof docPath !== 'string') {
        return res.status(400).json({ error: 'path required' });
      }
      const allowed = new Set(['md', 'html', 'pdf', 'docx']);
      if (!allowed.has(format)) {
        return res.status(400).json({ error: 'format must be md, html, pdf, or docx' });
      }

      const doc = await db.documents.get(user.id, docPath);
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      const content = doc.content || '';
      const baseTitle = (doc.title || docPath.split('/').pop() || 'document').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${baseTitle}.${format}`;
      const sourceIsHtml = isHtmlSource(docPath, content);

      // Source-format short-circuits — return content as-is when the
      // requested target is the source format. Pandoc round-tripping
      // (e.g. HTML → markdown-parser → HTML) mangles tags, attributes,
      // inline CSS, and `<script>` content; the user's reported "HTML
      // export breaks the HTML code" was exactly this — we used to send
      // every export through `pandoc -f markdown` regardless of source.
      if (format === 'md' && !sourceIsHtml) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }
      if (format === 'html' && sourceIsHtml) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(content);
      }

      // pandoc-driven: spawn child, write content to stdin, stream
      // stdout to client. Buffered for binary formats (PDF/DOCX) so
      // the Content-Length is correct; HTML can stream.
      //
      // `-f` MUST match the source format. The previous hardcoded
      // `-f markdown` silently corrupted every export of HTML-sourced
      // docs (pandoc treated the literal `<` characters as text rather
      // than tags). Source detection mirrors the library page's
      // `isHtmlDoc` — `.html`/`.htm` extension OR a doctype/html-tag
      // sniff on the leading bytes.
      const { spawn } = await import('node:child_process');
      const sourceFormat = sourceIsHtml ? 'html' : 'markdown';
      const pandocArgs = ['-f', sourceFormat, '-t', format];
      // PDF needs a LaTeX engine; we use --pdf-engine=wkhtmltopdf
      // when available for fewer dependencies. Falls back to whatever
      // pandoc finds on PATH (xelatex / pdflatex).
      const child = spawn('pandoc', pandocArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderrBuf = '';
      child.stderr.on('data', (b) => { stderrBuf += b.toString('utf8').slice(0, 2000); });
      child.on('error', (err) => {
        if (res.headersSent) return;
        if (err.code === 'ENOENT') {
          return res.status(501).json({
            error: 'pandoc not installed on this VPS',
            hint: 'Install pandoc to enable PDF/DOCX export (apt install pandoc).',
          });
        }
        return res.status(500).json({ error: `Export failed: ${err.message}` });
      });

      // Buffer the stdout so we can set Content-Length and avoid
      // dribbling a partially-written PDF/DOCX to the client.
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('close', (code) => {
        if (res.headersSent) return;
        if (code !== 0) {
          logger.error?.(`[${LOG_PREFIX}] pandoc exited ${code}: ${stderrBuf.slice(0, 400)}`);
          return res.status(500).json({
            error: `Export conversion failed (pandoc exit ${code})`,
            details: stderrBuf.slice(0, 400),
          });
        }
        const buf = Buffer.concat(chunks);
        const mime = {
          html: 'text/html; charset=utf-8',
          pdf:  'application/pdf',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }[format];
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', String(buf.length));
        res.send(buf);
      });

      child.stdin.end(content, 'utf8');
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] /portal/documents/export error:`, e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to export document' });
    }
  });

  router.post('/portal/documents', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { path, title, content, folder_id, pinned, metadata, created_by, scope } = req.body;
      if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path is required' });
      // Portal saves default to personal scope (the user's primary
      // context). An explicit scope from the body must be valid —
      // we fail closed on invalid input rather than silently defaulting,
      // because cross-scope writes are security-sensitive (B3).
      // Note: saveDocument's UPDATE branch preserves the existing
      // row's scope regardless, so this default only takes effect on
      // first creation of a path.
      if (scope !== undefined && (typeof scope !== 'string' || !ALLOWED_SCOPES.has(scope))) {
        return res.status(400).json({
          error: `invalid scope: must be one of ${[...ALLOWED_SCOPES].join(', ')}`,
        });
      }
      const resolvedScope = scope || 'personal';
      await saveDocument({ db }, {
        userId: user.id,
        source: 'portal-save',
        scope: resolvedScope,
        createdBy: typeof created_by === 'string' && created_by.length > 0 ? created_by : 'user',
        path,
        content,
        title,
        folderId: folder_id,
        isPinned: pinned ? true : (pinned === false ? false : undefined),
        metadata,
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof SaveDocumentError) {
        logger.error?.(`[Portal] saveDocument refused: ${e.code} — ${e.message}`);
        return res.status(400).json({ error: e.message, code: e.code });
      }
      logger.error?.('[Portal] Document upsert error:', e.message);
      res.status(500).json({ error: 'Failed to save document' });
    }
  });

  router.post('/portal/documents/move', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { path, folder_id } = req.body;
      if (!path) return res.status(400).json({ error: 'path is required' });
      await db.documents.moveToFolder(user.id, path, folder_id || null);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to move document' });
    }
  });

  router.post('/portal/documents/pin', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { path, pinned } = req.body;
      if (!path) return res.status(400).json({ error: 'path is required' });
      if (pinned) {
        await db.documents.pin(user.id, path);
      } else {
        await db.documents.unpin(user.id, path);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update pin status' });
    }
  });

  router.delete('/portal/documents/*path', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      // Match GET's normalization: wildcard may arrive as array in Express 5.
      const rawPath = req.params.path || req.params[0];
      const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      if (!docPath) return res.status(400).json({ error: 'path is required' });
      await db.documents.delete(user.id, docPath);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete document' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Publishing — per-doc visibility (private / shared / published)
  // ══════════════════════════════════════════════════════════════════
  //
  // Five endpoints. All require portal session (authenticatePortalRequest).
  // Owner-only — the WHERE clause's user_id is the structural enforcement;
  // cross-tenant attempts can't read or modify another operator's docs.

  // GET share-status — drives the publishing popover in the portal.
  router.get('/portal/documents/*path/share-status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const rawPath = req.params.path || req.params[0];
      const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      if (!docPath) return res.status(400).json({ error: 'path required' });

      const doc = await db.documents.get(user.id, docPath);
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      const handle = await getOwnerHandle(db, user.id);
      const renderer = getPublicRenderer();
      const publicUrl = doc.published === 1 && doc.public_slug && handle && renderer
        ? renderer.publicUrlFor(handle, doc.public_slug)
        : null;

      const [shareLinks, readingNow] = await Promise.all([
        db.shareLinks.listByDoc(user.id, docPath),
        doc.public_slug
          ? db.publicPresence.countActive(user.id, doc.public_slug)
          : Promise.resolve(0),
      ]);

      res.json({
        path: docPath,
        published: doc.published === 1,
        slug: doc.public_slug || null,
        publicUrl,
        visitCount: doc.public_visit_count || 0,
        readingNow,
        shareLinks: shareLinks.map((sl) => ({
          token: sl.token,
          url: `https://mycelium.id/share/${sl.token}`,
          invitedEmail: sl.invitedEmail || null,
          expiresAt: sl.expiresAt,
          maxViews: sl.maxViews,
          viewCount: sl.viewCount,
          createdAt: sl.createdAt,
        })),
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] share-status failed:`, e.message);
      res.status(500).json({ error: 'Failed to load share status' });
    }
  });

  // POST publish — toggles published=1, ensures a slug, renders + uploads to R2.
  router.post('/portal/documents/*path/publish', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const renderer = getPublicRenderer();
      if (!renderer) return res.status(503).json({ error: 'Public renderer not configured' });

      const rawPath = req.params.path || req.params[0];
      const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      if (!docPath) return res.status(400).json({ error: 'path required' });

      const doc = await db.documents.get(user.id, docPath);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!doc.content) return res.status(400).json({ error: 'Document has no content to publish' });

      const handle = await getOwnerHandle(db, user.id);
      if (!handle) return res.status(400).json({ error: 'Set a handle in your profile first — that becomes the subdomain.' });

      let slug;
      try {
        slug = await resolvePublishSlug(db, user.id, docPath, doc, req.body?.slug);
      } catch (e) {
        return res.status(e.status || 400).json({ error: e.message });
      }

      // Set published=1 + slug FIRST so link-rewriter sees the
      // current doc as published if rendered transitively. Then
      // render + upload.
      await db.documents.publish(user.id, docPath, slug);
      await renderer.renderAndUpload({
        userId: user.id,
        documentPath: docPath,
        ownerHandle: handle,
        slug,
      });

      db.audit.log({
        action: 'document.publish',
        userId: user.id,
        ip: req.ip,
        resourceType: 'document',
        resourceId: docPath,
      }).catch(() => {});

      res.json({
        published: true,
        slug,
        publicUrl: renderer.publicUrlFor(handle, slug),
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] publish failed:`, e.message);
      res.status(500).json({ error: 'Publish failed' });
    }
  });

  // POST unpublish — sets published=0. R2 artifact stays if any
  // active share-link exists; otherwise the renderer deletes it.
  router.post('/portal/documents/*path/unpublish', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const renderer = getPublicRenderer();
      if (!renderer) return res.status(503).json({ error: 'Public renderer not configured' });

      const rawPath = req.params.path || req.params[0];
      const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      if (!docPath) return res.status(400).json({ error: 'path required' });

      const doc = await db.documents.get(user.id, docPath);
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      await db.documents.unpublish(user.id, docPath);

      // isPublic state check — keep R2 if any share-link still active.
      const stillShared = await db.shareLinks.hasActiveLinks(user.id, docPath);
      if (!stillShared && doc.public_slug) {
        await renderer.deleteR2Artifact({ userId: user.id, slug: doc.public_slug });
      }

      db.audit.log({
        action: 'document.unpublish',
        userId: user.id,
        ip: req.ip,
        resourceType: 'document',
        resourceId: docPath,
      }).catch(() => {});

      res.json({ published: false });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] unpublish failed:`, e.message);
      res.status(500).json({ error: 'Unpublish failed' });
    }
  });

  // POST share — generate a tokenised share link. Triggers an R2
  // upload if the doc isn't already public (so the universal
  // /share/<token> route can resolve it).
  router.post('/portal/documents/*path/share', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const renderer = getPublicRenderer();
      if (!renderer) return res.status(503).json({ error: 'Public renderer not configured' });

      const rawPath = req.params.path || req.params[0];
      const docPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
      if (!docPath) return res.status(400).json({ error: 'path required' });

      const doc = await db.documents.get(user.id, docPath);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!doc.content) return res.status(400).json({ error: 'Document has no content to share' });

      // Anti-spam — cap link creation per owner.
      const recent = await db.shareLinks.countRecentByOwner(user.id, 1);
      if (recent >= 20) return res.status(429).json({ error: 'Too many share links created in the last hour. Wait or revoke unused ones.' });

      const handle = await getOwnerHandle(db, user.id);
      if (!handle) return res.status(400).json({ error: 'Set a handle in your profile first.' });

      // Ensure a slug exists so the R2 path can be computed. We use
      // setPublicSlug (not publish) so the doc never transiently
      // shows published=1 — share-link-only access stays distinct
      // from the public-on-the-web state.
      let slug = doc.public_slug;
      if (!slug) {
        try {
          slug = await resolvePublishSlug(db, user.id, docPath, doc, null);
        } catch (e) {
          return res.status(e.status || 400).json({ error: e.message });
        }
        await db.documents.setPublicSlug(user.id, docPath, slug);
      }

      const { invitedEmail, expiresInDays, maxViews } = req.body || {};

      // Render to R2 if not already there. Cheap idempotent
      // re-render is acceptable; cost is one R2 PUT.
      await renderer.renderAndUpload({
        userId: user.id,
        documentPath: docPath,
        ownerHandle: handle,
        slug,
      });

      const { token, expiresAt } = await db.shareLinks.create({
        userId: user.id,
        documentPath: docPath,
        invitedEmail: invitedEmail || null,
        expiresInDays: expiresInDays || 30,
        maxViews: typeof maxViews === 'number' ? maxViews : null,
      });

      db.audit.log({
        action: 'document.share',
        userId: user.id,
        ip: req.ip,
        resourceType: 'share_link',
        resourceId: token,
      }).catch(() => {});

      res.json({
        token,
        url: `https://mycelium.id/share/${token}`,
        expiresAt,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] share failed:`, e.message);
      res.status(500).json({ error: 'Share failed' });
    }
  });

  // DELETE share-link — revoke. If this was the last active link
  // AND published=0, deletes the R2 artifact.
  router.delete('/portal/share-links/:token', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const renderer = getPublicRenderer();

      const link = await db.shareLinks.getByToken(req.params.token);
      if (!link) return res.status(404).json({ error: 'Link not found' });
      if (link.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

      await db.shareLinks.revoke(req.params.token, user.id);

      // isPublic state check — clean up R2 if doc is now private.
      const doc = await db.documents.get(user.id, link.document_path);
      const stillShared = await db.shareLinks.hasActiveLinks(user.id, link.document_path);
      if (doc && doc.published !== 1 && !stillShared && doc.public_slug && renderer) {
        await renderer.deleteR2Artifact({ userId: user.id, slug: doc.public_slug });
      }

      db.audit.log({
        action: 'document.share.revoke',
        userId: user.id,
        ip: req.ip,
        resourceType: 'share_link',
        resourceId: req.params.token,
      }).catch(() => {});

      res.json({ ok: true });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] share revoke failed:`, e.message);
      res.status(500).json({ error: 'Revoke failed' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Folders
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/folders', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const folders = await db.folders.list(user.id);
      res.json({ folders });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load folders' });
    }
  });

  router.post('/portal/folders', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { name, parent_id } = req.body;
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
      const folder = await db.folders.create(user.id, name.trim(), parent_id || null);
      res.json({ folder });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create folder' });
    }
  });

  router.put('/portal/folders/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { name } = req.body;
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
      await db.folders.rename(user.id, req.params.id, name.trim());
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to rename folder' });
    }
  });

  router.delete('/portal/folders/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      await db.folders.delete(user.id, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete folder' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Messages + chat history
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/messages', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const before = req.query.before;
      const messages = await db.messages.selectTimeline(user.id, {
        limit,
        before: before ? new Date(before).toISOString() : undefined,
      });

      const attachmentIds = messages
        .filter((m) => m.attachment_id)
        .map((m) => m.attachment_id);
      const attachmentMap = {};
      if (attachmentIds.length > 0) {
        // Pass user.id so Worker's sql-safety guardian accepts the SELECT
        // (attachments is in USER_DATA_TABLES — id alone is rejected).
        const attachments = await db.attachments.getByIds(attachmentIds, user.id);
        for (const a of attachments) {
          attachmentMap[a.id] = {
            id: a.id,
            type: inferAttachmentType(null, a.r2_key),
            url: `/portal/attachment/${a.id}`,
            filename: a.file_name || null,
            fileSize: a.file_size || null,
            transcript: a.transcript || null,
            description: a.description || null,
          };
        }
      }

      const enriched = messages.map((m) => {
        const out = projectTimelineRow(m);
        if (m.attachment_id && attachmentMap[m.attachment_id]) {
          out.attachment = attachmentMap[m.attachment_id];
        }
        return out;
      });

      res.json({ messages: enriched });
    } catch (e) {
      console.error('[portal-library] /portal/messages failed:', e?.message, '\n', e?.stack);
      res.status(500).json({ error: 'Failed to load messages' });
    }
  });

  router.get('/portal/chat/history', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const agentId = req.query.agentId || undefined;
      const messages = await db.messages.selectRecent(user.id, { limit, agentId });

      const attachmentIds = messages.filter((m) => m.attachment_id).map((m) => m.attachment_id);
      const attachmentMap = {};
      if (attachmentIds.length > 0) {
        try {
          // Same A.25-class fix: pass user.id for Worker safety guard.
          const attachments = await db.attachments.getByIds(attachmentIds, user.id);
          for (const a of attachments) {
            const type = a.file_type || inferAttachmentType(null, a.r2_key);
            attachmentMap[a.id] = {
              id: a.id,
              type,
              url: `/portal/attachment/${a.id}`,
              filename: a.file_name || null,
              fileSize: a.file_size || null,
              transcript: a.transcript || null,
              description: a.description || null,
            };
          }
        } catch { /* enrichment optional */ }
      }
      const enriched = messages.map((m) => {
        const mapped = {
          id: String(m.id),
          role: m.role,
          content: m.content,
          timestamp: new Date(m.created_at).getTime(),
          source: m.source,
        };
        if (m.attachment_id && attachmentMap[m.attachment_id]) {
          mapped.attachment = attachmentMap[m.attachment_id];
        }
        return mapped;
      });

      // selectRecent returns DESC (newest first); reverse for chronological display
      res.json({ messages: enriched.reverse() });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load chat history' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Identity — owner platform handles for the timeline UI
  // ══════════════════════════════════════════════════════════════════
  //
  // The timeline shows messages from group chats where the operator,
  // other humans, AND multiple agents all post under role=user/role=
  // assistant. To label "you" correctly the client compares each row's
  // metadata.fromId against the owner's platform IDs.
  //
  // Sources:
  //   ownerName       → resolveOwnerName (D1 users.display_name → handle
  //                     → process.env.OWNER_NAME → 'User')
  //   ownerTelegramId → process.env.OWNER_TELEGRAM_ID
  //                     (loaded by bootstrap-secrets from the encrypted
  //                     `secrets` table at agent boot)
  //   ownerDiscordId  → process.env.OWNER_DISCORD_ID (same pipeline)
  //
  // Authenticated portal endpoint. Returns nulls for missing IDs — never
  // fabricates a guess.
  router.get('/portal/identity', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      let ownerName = null;
      try { ownerName = await resolveOwnerName({ db, fallback: null }); }
      catch { /* resolver has its own fallbacks; null is acceptable */ }
      const tg = process.env.OWNER_TELEGRAM_ID;
      const dc = process.env.OWNER_DISCORD_ID;
      res.json({
        ownerName: ownerName || null,
        ownerTelegramId: tg ? String(tg) : null,
        ownerDiscordId:  dc ? String(dc) : null,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] /portal/identity failed:`, e?.message);
      res.status(500).json({ error: 'Failed to load identity' });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // Attachments
  // ══════════════════════════════════════════════════════════════════

  router.get('/portal/attachments', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const type = req.query.type || null;
      const search = req.query.search || null;
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      // Media gallery: only actual media types; text/document/pdf live in Library.
      const onlyTypes = (!type || type === 'all') ? ['image', 'voice', 'audio', 'video'] : undefined;

      const [attachments, total] = await Promise.all([
        db.attachments.listByUser(user.id, { type: type === 'all' ? null : type, search, limit, offset, onlyTypes }),
        db.attachments.countByUser(user.id, { type: type === 'all' ? null : type, search, onlyTypes }),
      ]);

      const items = attachments.map((a) => ({
        id: a.id,
        type: inferAttachmentType(a.file_type, a.r2_key),
        url: `/portal/attachment/${a.id}`,
        streamUid: a.stream_uid || null,
        filename: a.file_name || null,
        fileSize: a.file_size || null,
        description: a.description || null,
        transcript: a.transcript || null,
        createdAt: a.created_at || null,
      }));

      res.json({ attachments: items, total });
    } catch (e) {
      logger.error?.('[Portal] Error listing attachments:', e);
      res.status(500).json({ error: 'Failed to list attachments' });
    }
  });

  router.put('/portal/attachments/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const attachment = await db.attachments.getById(req.params.id);
      if (!attachment) return res.status(404).json({ error: 'Not found' });
      if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

      const { description } = req.body || {};
      if (typeof description === 'string') {
        await db.attachments.update(req.params.id, { description });
      }

      res.json({ ok: true });
    } catch (e) {
      logger.error?.('[Portal] Error updating attachment:', e);
      res.status(500).json({ error: 'Failed to update attachment' });
    }
  });

  router.delete('/portal/attachments/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const attachment = await db.attachments.getById(req.params.id);
      if (!attachment) return res.status(404).json({ error: 'Not found' });
      if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

      // Best-effort R2 cleanup. Orphaned R2 bytes are better than an
      // orphaned DB record, so we log and continue on failure.
      if (attachment.r2_key && MYA_WORKER_URL && getWorkerSecret()) {
        try {
          await fetch(`${MYA_WORKER_URL}/attachments/${encodeURIComponent(attachment.r2_key)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${getWorkerSecret()}` },
            signal: AbortSignal.timeout(15000),
          });
        } catch (e) {
          logger.error?.(`[Portal] R2 delete failed for ${req.params.id}:`, e.message);
        }
      }

      if (attachment.stream_uid && MYA_WORKER_URL && getWorkerSecret()) {
        try {
          await fetch(`${MYA_WORKER_URL}/stream-delete/${attachment.stream_uid}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${getWorkerSecret()}` },
            signal: AbortSignal.timeout(15000),
          });
        } catch (e) {
          logger.error?.(`[Portal] Stream delete failed for ${req.params.id}:`, e.message);
        }
      }

      await db.attachments.delete(req.params.id, user.id);

      logger.info?.(`[Portal] Attachment deleted: ${req.params.id} (r2=${attachment.r2_key || 'none'}, stream=${attachment.stream_uid || 'none'})`);
      res.json({ ok: true });
    } catch (e) {
      logger.error?.('[Portal] Error deleting attachment:', e);
      res.status(500).json({ error: 'Failed to delete attachment' });
    }
  });

  // Authenticated R2 proxy. Streams R2 bytes through after enforcing
  // attachment ownership. Stream-hosted videos return an embed token
  // envelope instead of proxying bytes.
  router.get('/portal/attachment/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) {
        logger.info?.(`[Portal] Attachment ${req.params.id}: auth failed (token=${extractSessionToken(req) ? 'present' : 'MISSING'}, cookie=${req.headers.cookie ? 'yes' : 'no'})`);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const attachment = await db.attachments.getById(req.params.id);
      if (!attachment) return res.status(404).json({ error: 'Not found' });
      if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

      if (attachment.stream_uid && !attachment.r2_key) {
        try {
          const tokenRes = await fetch(`${MYA_WORKER_URL}/stream-token/${attachment.stream_uid}`, {
            headers: { Authorization: `Bearer ${getWorkerSecret()}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!tokenRes.ok) return res.status(502).json({ error: 'Failed to get stream token' });
          const tokenData = await tokenRes.json();
          return res.json({
            stream: true,
            embedUrl: tokenData.embedUrl,
            hlsUrl: tokenData.hlsUrl,
            thumbnailUrl: tokenData.thumbnailUrl,
          });
        } catch {
          return res.status(502).json({ error: 'Stream token request failed' });
        }
      }

      if (!attachment.r2_key) return res.status(404).json({ error: 'No file' });

      const r2Key = attachment.r2_key;
      const workerUrl = `${MYA_WORKER_URL}/attachments/${encodeURIComponent(r2Key)}`;
      const r2Res = await fetch(workerUrl, {
        headers: { Authorization: `Bearer ${getWorkerSecret()}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!r2Res.ok) {
        const errorBody = await r2Res.text().catch(() => '(no body)');
        logger.error?.(`[Portal] R2 fetch failed for ${r2Key}: ${r2Res.status} ${r2Res.statusText} — body: ${errorBody}`);
        return res.status(502).json({ error: 'Failed to fetch from storage' });
      }

      const contentType = r2Res.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (r2Res.headers.get('content-length')) {
        res.setHeader('Content-Length', r2Res.headers.get('content-length'));
      }

      const reader = r2Res.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(Buffer.from(value));
        }
      };
      await pump();
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to fetch attachment' });
    }
  });

  router.get('/portal/stream-token/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const attachment = await db.attachments.getById(req.params.id);
      if (!attachment) return res.status(404).json({ error: 'Not found' });
      if (attachment.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
      if (!attachment.stream_uid) return res.status(404).json({ error: 'Not a stream video' });

      const tokenRes = await fetch(`${MYA_WORKER_URL}/stream-token/${attachment.stream_uid}`, {
        headers: { Authorization: `Bearer ${getWorkerSecret()}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '');
        logger.error?.(`[Portal] Stream token failed for ${attachment.stream_uid}: ${tokenRes.status} ${body}`);
        return res.status(502).json({ error: 'Failed to get stream token' });
      }
      const tokenData = await tokenRes.json();
      res.json({
        embedUrl: tokenData.embedUrl,
        hlsUrl: tokenData.hlsUrl,
        thumbnailUrl: tokenData.thumbnailUrl,
      });
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Stream token failed' });
    }
  });

  logger.info?.('[portal-library-router] mounted 17 handlers');
  return router;
}
