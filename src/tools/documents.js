/**
 * Documents domain — MCP tools for reading, updating, editing,
 * creating, listing, and publishing documents in the library.
 *
 * Living-document semantics:
 *   - `saveDocument` (canonical): idempotent upsert at a path.
 *     Same path = revision of an existing doc; new path = new doc.
 *     Replaces the createDocument / editDocumentContent split that
 *     made agents reach for the wrong tool and create duplicates.
 *   - `updateDocument` appends a timestamped entry (observation/shift/
 *     note/wondering) with confidence level. Specialized: keep using
 *     this for incremental in-conversation capture, not for full
 *     content rewrites.
 *   - `editDocumentContent` (DEPRECATED): full-content replace. Use
 *     `saveDocument` instead.
 *   - `createDocument` (DEPRECATED): strict-create that errored on
 *     existing paths. Use `saveDocument` (idempotent) instead.
 *   - `getDocument` + `listDocuments` are pure reads.
 *
 * Publishing surface (new — closes the "agent improvises an HTTP
 * server" failure mode of CLAUDE.md principle #13):
 *   - `publishDocument` makes a doc readable at <handle>.mycelium.id/p/<slug>.
 *   - `getDocumentShareStatus` reads visibility + counts before action.
 *
 * STAGED (foundation only, not yet wired as tools): the unlisted /s/<slug>
 * capability-link surface — minting (setPublicSlug → mintLink) and revocation
 * (unpublish / revokeShareLinks). The crypto + fail-closed public server exist
 * and are verified (src/publish/*, scripts/verify-publish.mjs), but no MCP tool
 * yet produces or revokes an unlisted link — that is the next publishing slice.
 *
 * Four canonical paths (MIND_MIRRORS) are mirrored to local files
 * so future agent sessions can preload them without a D1 round-trip.
 *
 * Factory returns { tools, handlers } — tools are schema objects the
 * MCP server registers, handlers are async (args) => string.
 *
 * @typedef {object} DocumentsDeps
 * @property {object} db — needs documents.{get,upsert,list,publish,unpublish,setPublicSlug,getBySlug}, shareLinks.{create,listByDoc,hasActiveLinks,countRecentByOwner}, publicPresence.countActive, canvases.addDocument
 * @property {string} userId
 * @property {string} agentId — used as the default `created_by` for upserts
 * @property {(filename: string, content: string) => Promise<void>} writeMindFile
 * @property {Record<string,string>} mindMirrors — path → local filename map
 * @property {object} [publicRenderer] — optional, returned by createPublicRenderer({...}). Required for the 4 publishing tools; if absent they surface a clear "publishing not configured" error.
 * @property {() => Promise<string|null>} [getOwnerHandle] — async fetcher for the operator's handle; called once per process and cached. Required when publicRenderer is set.
 * @property {{ searchMindscape: (req: object) => Promise<object> }} [searchClient] — HTTP shim over /internal/v1/search/mindscape. When injected, enables the `findDocuments` tool so agents can check for existing docs before writing new ones (closes the duplicate-creation gap).
 */

import {
  saveDocument,
  resolveAgentScope,
  SaveDocumentError,
} from '../core/document-store.js';
import {
  SearchWarmingError,
  SearchEmbedderError,
  SearchValidationError,
  SearchClientError,
} from './search-client.js';

export function createDocumentsDomain(deps) {
  if (!deps) throw new TypeError('createDocumentsDomain: deps required');
  const {
    db, userId, agentId, writeMindFile, mindMirrors,
    publicRenderer = null, getOwnerHandle = null,
    searchClient = null,
  } = deps;
  if (!db) throw new TypeError('createDocumentsDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createDocumentsDomain: userId required');
  if (typeof agentId !== 'string') throw new TypeError('createDocumentsDomain: agentId required');
  if (typeof writeMindFile !== 'function') throw new TypeError('createDocumentsDomain: writeMindFile required');
  if (!mindMirrors || typeof mindMirrors !== 'object') throw new TypeError('createDocumentsDomain: mindMirrors required');
  if (publicRenderer && typeof getOwnerHandle !== 'function') {
    throw new TypeError('createDocumentsDomain: getOwnerHandle required when publicRenderer is set');
  }
  if (searchClient && typeof searchClient.searchMindscape !== 'function') {
    throw new TypeError('createDocumentsDomain: searchClient.searchMindscape required when searchClient is set');
  }

  // Cache the operator's handle once per process — handles change
  // rarely and the lookup hits the users table. 5-min TTL keeps the
  // cache from going stale across long-running MCP sessions.
  let _handleCache = null; // { handle, expiresAt } | null
  async function ownerHandleCached() {
    if (!getOwnerHandle) return null;
    const now = Date.now();
    if (_handleCache && _handleCache.expiresAt > now) return _handleCache.handle;
    const handle = await getOwnerHandle();
    _handleCache = { handle, expiresAt: now + 5 * 60 * 1000 };
    return handle;
  }

  // Auto-republish hook — when this domain is built with a renderer,
  // wire it once to db.documents so any upsert (from THIS process)
  // that touches a public doc triggers a re-render. Mirrors the hook
  // agent-server.js installs for portal-driven upserts. The renderer's
  // debounce map is module-scoped, so concurrent triggers in this
  // process collapse to one in-flight + one queued.
  //
  // Uses addAfterUpsertHook (list semantics) so this hook coexists
  // with agent-server.js's publishing hook and the live-doc broadcaster
  // — the legacy single-slot setter would silently overwrite both.
  if (publicRenderer && typeof db.documents?.addAfterUpsertHook === 'function') {
    db.documents.addAfterUpsertHook(async (row) => {
      if (!row?.public_slug || row.user_id !== userId) return;
      let isPublic = row.published === 1;
      if (!isPublic && db.shareLinks?.hasActiveLinks) {
        isPublic = await db.shareLinks.hasActiveLinks(row.user_id, row.path);
      }
      if (!isPublic) return;
      const handle = await ownerHandleCached();
      if (!handle) return;
      publicRenderer.maybeRerender({
        userId: row.user_id,
        documentPath: row.path,
        ownerHandle: handle,
        slug: row.public_slug,
      });
    });
  }

  // Slug derivation + collision-suffix loop. Mirrors the route layer's
  // resolvePublishSlug so behaviour is identical whether the caller is
  // the portal or an agent tool.
  async function resolveSlug(docPath, doc, suppliedSlug) {
    if (!publicRenderer) {
      throw new Error('Publishing not configured on this agent');
    }
    if (suppliedSlug) {
      if (!publicRenderer.isValidSlug(suppliedSlug)) {
        throw new Error('Invalid slug — lowercase letters, digits, hyphens only');
      }
      const conflict = await db.documents.getBySlug(userId, suppliedSlug);
      if (conflict && conflict.path !== docPath) {
        throw new Error(`Slug "${suppliedSlug}" already in use by another doc`);
      }
      return suppliedSlug;
    }
    if (doc.public_slug && publicRenderer.isValidSlug(doc.public_slug)) {
      return doc.public_slug;
    }
    const base =
      publicRenderer.deriveSlug(doc.title) ||
      publicRenderer.deriveSlug(docPath.split('/').pop());
    if (!base) throw new Error("Couldn't derive a slug — please supply one explicitly");
    let candidate = base;
    for (let i = 2; i < 1000; i++) {
      const conflict = await db.documents.getBySlug(userId, candidate);
      if (!conflict || conflict.path === docPath) return candidate;
      candidate = `${base}-${i}`;
    }
    throw new Error('Could not find a free slug');
  }

  async function getDocument(docPath) {
    return db.documents.get(userId, docPath);
  }

  /**
   * Internal helper: route every domain write through the canonical
   * saveDocument primitive. Path validation, content_hash, scope
   * enforcement, INSERT-only provenance protection (B1–B5) all flow
   * from here.
   *
   * `doc` is the legacy shape used by the MCP handlers below
   * (path, content, title, summary, folder?, ...). saveDocument's
   * source is pinned to 'agent-mcp' since this is the agent-driven
   * write surface; pathArgs.pathHint passes the agent's chosen path
   * through the agent-mcp strategy (which is path-as-identity).
   *
   * Returns the upserted row (same shape the caller used to get
   * back from db.documents.upsert).
   */
  async function upsertDocument(doc) {
    const result = await saveDocument({ db }, {
      userId,
      source: 'agent-mcp',
      sourceType: 'agent-output',
      scope: resolveAgentScope(),
      createdBy: doc.created_by || agentId,
      path: doc.path,
      content: doc.content,
      title: doc.title,
      summary: doc.summary,
      folderId: doc.folder || doc.folder_id,
    });
    return result.row;
  }

  const tools = [
    {
      name: 'saveDocument',
      description:
        'Save (create or revise) a document at a path. Idempotent: same path = revision, new path = new doc. ' +
        'PATH IS THE DOCUMENT\'S IDENTITY — choose a stable, semantic path the first time and reuse it for revisions ' +
        '(e.g., "people/sarah", "research/ai-2026", "business/project-x"). NEVER pick a different path for the same ' +
        'logical document; that creates duplicates the user has to clean up. ' +
        'PATH EXTENSION DRIVES RENDERING. Markdown is the default — no extension, or `.md`. ' +
        'For HTML pages (generated layouts, dashboards, visualizations, anything with `<html>` / `<body>` / styles / ' +
        'scripts) you MUST include `.html` on the path (e.g., "projects/landing.html", "research/dashboard.html") so ' +
        'the library renders it in a sandboxed iframe. Without the extension the HTML source is shown as plain text ' +
        'and looks like a generic doc — same content, broken UX. For JSON, `.json`. ' +
        'Reserved system prefixes (agent-files/, uploads/, claude/, import/, published/, drafts/, inbound/) are off-limits ' +
        '— those belong to other surfaces. Calling on an existing path replaces content + title + summary; provenance fields ' +
        '(scope, source_type, created_by) are preserved from the original creation. ' +
        'BEFORE writing about a topic that might already be documented, call `findDocuments` first.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Stable semantic path (e.g., 'people/sarah', 'business/project-x' for markdown; 'projects/landing.html' for an HTML page). Extension drives rendering — include '.html' for HTML content. Reuse the same path for revisions." },
          content: { type: 'string', description: 'Full content of the document. Format follows the path extension: markdown (default / .md), HTML (.html — rendered sandboxed in iframe), JSON (.json), etc.' },
          title: { type: 'string', description: 'Human-readable title. Defaults to the last path segment if omitted.' },
          summary: { type: 'string', description: 'Optional short summary; auto-derived from the first 200 chars of content if omitted.' },
          folder: { type: 'string', description: 'Optional folder name (defaults to Inbox).' },
          canvas: { type: 'string', description: 'Optional canvas to add the document to. Best-effort — failures are non-fatal (the document still saves).' },
        },
        required: ['path', 'content'],
      },
    },
    ...(searchClient ? [{
      name: 'findDocuments',
      description:
        'Search the library by topical similarity for existing documents BEFORE writing a new one. ' +
        'Returns the top matches with their paths and titles. If a result describes the same logical ' +
        'document you\'re about to write, call `saveDocument` with THAT path (revision); only pick a new ' +
        'path when no result matches. This is the structural counterpart to "PATH IS IDENTITY" — without ' +
        'discovery, agents reinvent paths and create duplicates. ' +
        'Freshness caveat: the index updates asynchronously (seconds-to-minutes after a write), so a ' +
        'doc you just saved may not appear here yet — that\'s a one-time delay, not a permanent miss.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The topic / concept / person / project you\'re about to write about. Free-form natural language.' },
          limit: { type: 'number', description: 'Max results (default 5, max 20).' },
        },
        required: ['query'],
      },
    }] : []),
    {
      name: 'updateDocument',
      description: 'Append a timestamped entry to a living document (specialized for incremental in-conversation capture: observations, shifts, notes, wonderings). For full content rewrites use `saveDocument` instead.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Document path (e.g., 'states/mental', 'business/mya')" },
          entry: { type: 'string', description: 'The observation to add (timestamped, provisional language)' },
          entryType: { type: 'string', enum: ['observation', 'shift', 'note', 'wondering'], description: 'Type of entry' },
          confidence: { type: 'string', enum: ['low', 'medium', 'provisional'], description: 'Confidence level' },
        },
        required: ['path', 'entry', 'entryType', 'confidence'],
      },
    },
    {
      name: 'getDocument',
      description: 'Retrieve full document content by path. Works for any library document — mindscape docs, transcriptions, notes, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Document path to retrieve' },
        },
        required: ['path'],
      },
    },
    {
      name: 'listDocuments',
      description: 'List all available documents with their paths and summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: "Optional filter (e.g., 'people', 'business', 'states')" },
        },
      },
    },
    {
      name: 'publishDocument',
      description:
        "Make a library document publicly readable on the operator's portal subdomain under the /p/ path: <handle>.mycelium.id/p/<slug>. " +
        'Use this when the operator asks to "publish", "make public", or wants a shareable URL on the open web. ' +
        'NEVER spin up an HTTP server (python -m http.server, npx serve, ngrok, etc.) — that path is forbidden ' +
        '(CLAUDE.md principle #13); this tool is the only way to publish content. Idempotent: calling on an ' +
        'already-published doc returns the existing URL. Edits to the doc reflect on the public URL within ~5s.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Document path (e.g., agent-files/personal-agent/thought-board.html)' },
          slug: {
            type: 'string',
            description:
              'Optional URL slug; auto-derived from filename if omitted. Lowercase letters, digits, and hyphens only.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'getDocumentShareStatus',
      description:
        'Check publish + share state of a document. Returns visibility, public URL (if published), live visit ' +
        'count, concurrent reader count, and active share links. Useful before publishing to confirm what would ' +
        'change, or to see how a published doc is being read.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Document path to check' } },
        required: ['path'],
      },
    },
  ];

  const handlers = {
    ...(searchClient ? {
      findDocuments: async (args) => {
        if (!args || typeof args.query !== 'string' || args.query.trim().length === 0) {
          return 'findDocuments: query is required.';
        }
        const trimmed = args.query.trim();
        // Server hard-cap is 2000 chars (LIMITS.QUERY_MAX_CHARS); fail
        // fast on the client to avoid the round-trip.
        if (trimmed.length > 2000) {
          return 'findDocuments: query exceeds 2000 chars; please shorten.';
        }
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 20);

        let resp;
        try {
          resp = await searchClient.searchMindscape({
            query: trimmed,
            corpora: ['documents'],
            topK: limit,
          });
        } catch (e) {
          // Map the four typed errors to actionable agent-facing
          // messages. NEVER swallow with a fall-back result — the
          // agent must know discovery failed so it doesn't write a
          // duplicate thinking the index was clean.
          if (e instanceof SearchWarmingError) {
            return 'Search index is warming up — retry in a few seconds before writing, so you can dedup against existing docs.';
          }
          if (e instanceof SearchEmbedderError) {
            return 'Embed service is unavailable — similarity search disabled. If you must write now, use a clearly-distinct path; otherwise wait and retry.';
          }
          if (e instanceof SearchValidationError) {
            return `findDocuments: search rejected (${e.detail || 'bad_request'}).`;
          }
          if (e instanceof SearchClientError) {
            return `findDocuments: search unavailable (${e.reason || 'transport'}).`;
          }
          throw e;
        }

        const docs = (resp?.results?.documents) || [];
        if (docs.length === 0) {
          return `No existing documents match "${trimmed}". Free to create one with saveDocument at a fresh semantic path.`;
        }

        const lines = docs.map((d) => {
          const sim = typeof d.similarity === 'number' ? ` (similarity ${d.similarity.toFixed(2)})` : '';
          const summary = d.summary ? ` — ${d.summary}` : (d.title ? ` — ${d.title}` : '');
          return `- **${d.path}**${summary}${sim}`;
        });

        const degraded = Array.isArray(resp?.degraded) && resp.degraded.includes('documents')
          ? '\n\n⚠ Document index is in degraded mode — results may be incomplete; treat absence with caution.'
          : '';

        return [
          `Found ${docs.length} doc${docs.length === 1 ? '' : 's'} that may match "${trimmed}":`,
          ...lines,
          '',
          'If one of these is the same logical document you\'re about to write, call `saveDocument` with THAT path (revision). Otherwise pick a new semantic path.',
        ].join('\n') + degraded;
      },
    } : {}),

    saveDocument: async (args) => {
      // Idempotent upsert at args.path. Routes through the canonical
      // primitive (path validation, content_hash, scope binding,
      // INSERT-only provenance protection per B1–B5).
      const existing = await getDocument(args.path);
      const docData = {
        path: args.path,
        title: args.title || args.path.split('/').pop(),
        content: args.content,
        summary: args.summary || (typeof args.content === 'string' ? args.content.slice(0, 200) : ''),
      };
      if (args.folder) docData.folder = args.folder;

      try {
        await upsertDocument(docData);
      } catch (e) {
        if (e instanceof SaveDocumentError) {
          // Surface validation failures with a clear, actionable
          // message back to the agent. Reserved-prefix violations
          // are the most common — the agent picked a system-owned
          // path scheme by accident.
          return `Could not save document: ${e.message}`;
        }
        throw e;
      }

      const mirrorFile = mindMirrors[args.path];
      if (mirrorFile) {
        try { await writeMindFile(mirrorFile, args.content); } catch { /* non-fatal */ }
      }

      // Optional canvas binding — preserves the only differentiator of
      // the now-retired createDocument tool (its `canvas` parameter).
      // Best-effort: a failure here doesn't undo the save.
      if (args.canvas) {
        try {
          await db.canvases.addDocument(userId, args.canvas, args.path);
        } catch { /* canvas assignment is optional */ }
      }

      return existing
        ? `Updated ${args.path}${args.canvas ? ` (canvas ${args.canvas})` : ''}.`
        : `Created ${args.path}${args.title ? ` (${args.title})` : ''}${args.folder ? ` in folder ${args.folder}` : ''}${args.canvas ? ` on canvas ${args.canvas}` : ''}.`;
    },

    updateDocument: async (args) => {
      const doc = await getDocument(args.path);
      const timestamp = new Date().toISOString().split('T')[0];
      const prefix = `[${timestamp}] [${args.entryType}] [${args.confidence}]`;
      // Strip any leading [YYYY-MM-DD] prefixes from the agent's entry
      // before our own prefix is applied. Same bug class as
      // updateInternalModel — agent habit of adding a date in content
      // produced double-dated entries. See docs/MIND-MODEL-COMPACTION-DESIGN-V3-2026-05-07.md PR-C.
      const cleanedEntry = String(args.entry || '').replace(/^(\[\d{4}-\d{2}-\d{2}\]\s+)+/, '');
      const newEntry = `${prefix} ${cleanedEntry}`;

      let finalContent;
      if (doc) {
        finalContent = doc.content + '\n\n' + newEntry;
        await upsertDocument({ path: args.path, title: doc.title, content: finalContent, summary: doc.summary });
      } else {
        finalContent = newEntry;
        await upsertDocument({
          path: args.path,
          title: args.path.split('/').pop(),
          content: finalContent,
          summary: `Created from ${args.entryType} entry`,
        });
      }

      const mirrorFile = mindMirrors[args.path];
      if (mirrorFile) {
        try { await writeMindFile(mirrorFile, finalContent); } catch { /* non-fatal */ }
      }

      return doc
        ? `Updated ${args.path} with ${args.entryType} entry.`
        : `Created new document ${args.path} with ${args.entryType} entry.`;
    },

    getDocument: async (args) => {
      const doc = await getDocument(args.path);
      if (!doc) return `Document not found: ${args.path}`;
      return `# ${doc.title || args.path}\n\n${doc.content}`;
    },

    listDocuments: async (args) => {
      const docs = await db.documents.list(userId, { category: args.category });
      if (docs.length === 0) return args.category ? `No documents in category: ${args.category}` : 'No documents found.';
      return docs.map(d => {
        const folder = d.folder ? ` (${d.folder})` : '';
        return `- **${d.path}**${folder}: ${d.summary || 'No summary'}`;
      }).join('\n');
    },

    publishDocument: async (args) => {
      if (!publicRenderer) return 'Publishing is not configured on this agent.';
      const doc = await getDocument(args.path);
      if (!doc) return `Document not found: ${args.path}`;
      if (!doc.content) return `Document has no content to publish: ${args.path}`;
      const handle = await ownerHandleCached();
      if (!handle) return "Operator hasn't set a public handle — set one in Settings before publishing.";

      let slug;
      try {
        slug = await resolveSlug(args.path, doc, args.slug);
      } catch (e) {
        return `Cannot publish: ${e.message}`;
      }

      // Set published=1 + slug FIRST so the link-rewriter sees the
      // current doc as published if rendered transitively, then
      // render + upload to R2.
      await db.documents.publish(userId, args.path, slug);
      try {
        await publicRenderer.renderAndUpload({
          userId,
          documentPath: args.path,
          ownerHandle: handle,
          slug,
        });
      } catch (e) {
        // Roll back the flag so we don't leave a "published but not on R2"
        // mismatch — the public route would 404 anyway, but D1 truth
        // should match.
        try { await db.documents.unpublish(userId, args.path); } catch { /* best effort */ }
        return `Render/upload failed (rolled back): ${e.message}`;
      }
      // Audit-log: agentId attribution mirrors the portal route's
      // ip-based attribution. Same action shape so reports unify.
      db.audit?.log?.({
        action: 'document.publish',
        agentId,
        userId,
        resourceType: 'document',
        resourceId: args.path,
      }).catch(() => {});
      const url = publicRenderer.publicUrlFor(handle, slug);
      return `Published: ${url}\nEdits to this doc will reflect on the public URL within ~5s.`;
    },

    getDocumentShareStatus: async (args) => {
      const doc = await getDocument(args.path);
      if (!doc) return `Document not found: ${args.path}`;
      const handle = getOwnerHandle ? await ownerHandleCached() : null;

      const [shareLinks, readingNow] = await Promise.all([
        db.shareLinks?.listByDoc ? db.shareLinks.listByDoc(userId, args.path) : Promise.resolve([]),
        doc.public_slug && db.publicPresence?.countActive
          ? db.publicPresence.countActive(userId, doc.public_slug)
          : Promise.resolve(0),
      ]);

      const lines = [];
      lines.push(`Path: ${args.path}`);
      if (doc.published === 1 && doc.public_slug && handle) {
        const url = publicRenderer
          ? publicRenderer.publicUrlFor(handle, doc.public_slug)
          : `https://${handle}.mycelium.id/p/${doc.public_slug}`;
        lines.push(`Status: PUBLISHED at ${url}`);
        lines.push(`Visits: ${doc.public_visit_count || 0}`);
        lines.push(`Reading now: ${readingNow}`);
      } else {
        lines.push(`Status: ${shareLinks.length > 0 ? 'SHARED (private + tokenised links)' : 'PRIVATE'}`);
        if (doc.public_slug) lines.push(`Slug ready: ${doc.public_slug} (publish would restore this URL)`);
      }
      if (shareLinks.length > 0) {
        lines.push(`Share links (${shareLinks.length}):`);
        for (const sl of shareLinks) {
          const expiresAt = sl.expires_at?.slice(0, 10) || '?';
          const active = Date.parse(sl.expires_at) > Date.now() &&
            (sl.max_views == null || sl.view_count < sl.max_views);
          lines.push(
            `  - ${active ? '●' : '○'} mycelium.id/share/${sl.token.slice(0, 8)}…  ` +
            `${sl.view_count}${sl.max_views ? `/${sl.max_views}` : ''} views, expires ${expiresAt}` +
            `${sl.invited_email ? `, invited ${sl.invited_email}` : ''}`,
          );
        }
      }
      return lines.join('\n');
    },
  };

  return { tools, handlers };
}
