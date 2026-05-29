/**
 * Portal encrypted-channel router.
 *
 * Builds the route tables consumed by `setupSecureChannel` (from
 * `@mycelium/core/portal-channel.js`). The secure-channel lib owns
 * transport + Noise handshake + session auth; this factory owns the
 * *behavior* of each message type:
 *
 *   - `routes` — request/response handlers: `async (data, user) => result`.
 *     Most are thin DB pass-throughs (`requireDb()` → `db.<ns>.<method>`).
 *
 *   - `streamRoutes` — streaming handlers: `async (data, user, emit) => void`.
 *     Today only `chat` lives here; it either proxies to a sibling agent's
 *     `/chat/stream` or spawns Claude locally and forwards stream-json
 *     events through `emit`.
 *
 *   - `authenticateSession(token)` — resolves a session token to the
 *     authenticated user (delegates to PORTAL_APP_TOKEN equality check,
 *     else to passkey session validation).
 *
 * Every side-effecting dep (db, runner, context, queue, session store,
 * bot proxy fetch, spawn) is injected so tests can drive any branch
 * without touching disk or network.
 *
 * @typedef {object} PortalWsDeps
 * @property {string} agentId
 * @property {string} logPrefix
 * @property {object} agentRegistry — map agentId → { port, ... }
 * @property {{ root: string, repo: string, knowledge: { context: string } }} paths
 * @property {() => any} tryGetDb
 * @property {typeof import('fs/promises')} fs
 * @property {typeof import('path')} path
 * @property {typeof import('child_process').spawn} spawn
 * @property {string} claudeBin
 * @property {number} maxTurns
 * @property {() => Promise<string>} loadSystemPrompt
 * @property {() => Promise<string>} buildTeamDirectory
 * @property {() => string} getWarRoomContext
 * @property {() => string} getIntelContext
 * @property {(root: string, userId: string, opts: object) => Promise<string>} assembleContext
 * @property {(laneId: string, task: () => Promise<any>) => Promise<any>} enqueue
 * @property {(root: string, thread: string) => Promise<string|null>} getSessionForThread
 * @property {(root: string, thread: string) => Promise<string|null>} getContextSummary
 * @property {(root: string, thread: string, sid: string, meta: object) => Promise<void>} updateSessionMapping
 * @property {(userId: string, src: string, prompt: string, resp: string, ts: Date) => Promise<any>} storeMessages
 * @property {(runtime: any, taskType: string) => string} getModelForTask
 * @property {{ runtime: () => any }} runtimeState
 * @property {(taskType: string) => number} getTimeout
 * @property {() => void} incrementActiveTask
 * @property {() => void} decrementActiveTask
 * @property {(a: string, b: string) => boolean} safeCompare
 * @property {() => Promise<any>} getAuthModule
 * @property {string|undefined} portalAppToken
 * @property {(url: string, init?: any) => Promise<any>} [fetch] defaults to globalThis.fetch
 */

import { projectTimelineRow } from '../lib/message-projection.js';
import { saveDocument, SaveDocumentError } from '@mycelium/core/document-store.js';
import { spawnEnvOverride } from '@mycelium/core/claude-config.js';

export function createPortalWsRouter(deps) {
  if (!deps) throw new TypeError('createPortalWsRouter: deps required');
  const {
    agentId, logPrefix, agentRegistry, paths,
    tryGetDb, fs, path, spawn, claudeBin, maxTurns,
    loadSystemPrompt, buildTeamDirectory, getWarRoomContext, getIntelContext,
    assembleContext, enqueue,
    getSessionForThread, getContextSummary, updateSessionMapping, storeMessages,
    getModelForTask, runtimeState, getTimeout,
    incrementActiveTask, decrementActiveTask,
    safeCompare, getAuthModule, portalAppToken,
    fetch: fetchImpl = globalThis.fetch,
  } = deps;

  if (typeof agentId !== 'string')           throw new TypeError('createPortalWsRouter: agentId required');
  if (typeof logPrefix !== 'string')         throw new TypeError('createPortalWsRouter: logPrefix required');
  if (!agentRegistry || typeof agentRegistry !== 'object') throw new TypeError('createPortalWsRouter: agentRegistry required');
  if (!paths?.root || !paths?.repo)          throw new TypeError('createPortalWsRouter: paths.{root,repo} required');
  if (typeof tryGetDb !== 'function')        throw new TypeError('createPortalWsRouter: tryGetDb required');
  if (!fs?.readFile)                          throw new TypeError('createPortalWsRouter: fs required');
  if (!path?.join)                            throw new TypeError('createPortalWsRouter: path required');
  if (typeof spawn !== 'function')           throw new TypeError('createPortalWsRouter: spawn required');
  if (typeof claudeBin !== 'string')         throw new TypeError('createPortalWsRouter: claudeBin required');
  if (typeof maxTurns !== 'number')          throw new TypeError('createPortalWsRouter: maxTurns required');
  if (typeof loadSystemPrompt !== 'function')   throw new TypeError('createPortalWsRouter: loadSystemPrompt required');
  if (typeof buildTeamDirectory !== 'function') throw new TypeError('createPortalWsRouter: buildTeamDirectory required');
  if (typeof getWarRoomContext !== 'function')  throw new TypeError('createPortalWsRouter: getWarRoomContext required');
  if (typeof getIntelContext !== 'function')    throw new TypeError('createPortalWsRouter: getIntelContext required');
  if (typeof assembleContext !== 'function')    throw new TypeError('createPortalWsRouter: assembleContext required');
  if (typeof enqueue !== 'function')            throw new TypeError('createPortalWsRouter: enqueue required');
  if (typeof getSessionForThread !== 'function') throw new TypeError('createPortalWsRouter: getSessionForThread required');
  if (typeof getContextSummary !== 'function')   throw new TypeError('createPortalWsRouter: getContextSummary required');
  if (typeof updateSessionMapping !== 'function') throw new TypeError('createPortalWsRouter: updateSessionMapping required');
  if (typeof storeMessages !== 'function')       throw new TypeError('createPortalWsRouter: storeMessages required');
  if (typeof getModelForTask !== 'function')     throw new TypeError('createPortalWsRouter: getModelForTask required');
  if (!runtimeState?.runtime)                    throw new TypeError('createPortalWsRouter: runtimeState.runtime required');
  if (typeof getTimeout !== 'function')          throw new TypeError('createPortalWsRouter: getTimeout required');
  if (typeof incrementActiveTask !== 'function') throw new TypeError('createPortalWsRouter: incrementActiveTask required');
  if (typeof decrementActiveTask !== 'function') throw new TypeError('createPortalWsRouter: decrementActiveTask required');
  if (typeof safeCompare !== 'function')         throw new TypeError('createPortalWsRouter: safeCompare required');
  if (typeof getAuthModule !== 'function')       throw new TypeError('createPortalWsRouter: getAuthModule required');
  if (typeof fetchImpl !== 'function')           throw new TypeError('createPortalWsRouter: fetch required');

  function requireDb() {
    const db = tryGetDb();
    if (!db) throw Object.assign(new Error('Database not available'), { status: 503 });
    return db;
  }

  // ── Loopback proxy ────────────────────────────────────────────────
  // Routes a WS channel call through to the agent-server's local
  // HTTPS handler via 127.0.0.1. Used for PR1a handlers (secrets,
  // passkeys, master-key/restore, delete-account, etc.) so they
  // inherit the existing Express logic (auth, encryption, audit, PM2
  // restart) instead of duplicating it. Auth is delegated to the
  // portalAppToken bypass — the same single-user-VPS pattern already
  // used by authenticateSession at the WS handshake. Single-user VPS
  // assumption holds (each customer has their own VPS).
  //
  // Security: the request never leaves the box (127.0.0.1) and
  // PORTAL_APP_TOKEN never crosses Cloudflare. authenticatePortalRequest
  // (packages/server/lib/auth-helpers.js:147) honors Bearer tokens
  // matching PORTAL_APP_TOKEN.
  async function proxyToLoopback({ method, path: targetPath, body, headers: extraHeaders }) {
    if (!portalAppToken) {
      throw Object.assign(
        new Error('PORTAL_APP_TOKEN required for loopback proxy'),
        { status: 503 },
      );
    }
    const port = process.env.AGENT_PORT
      || agentRegistry[agentId]?.port
      || 3004;
    const url = `http://127.0.0.1:${port}${targetPath}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${portalAppToken}`,
      ...(extraHeaders || {}),
    };
    const init = { method, headers };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      let errMsg = `Request failed (${res.status})`;
      try {
        const j = await res.json();
        errMsg = j.error || errMsg;
      } catch { /* response may not be JSON */ }
      throw Object.assign(new Error(errMsg), { status: res.status });
    }
    // Some endpoints return empty 204; default to {} so handlers always
    // resolve with a serializable object.
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: true };
    return await res.json();
  }

  // Build a query string from data, used by GET handlers that proxy.
  function buildQuery(data) {
    if (!data || typeof data !== 'object') return '';
    const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0) return '';
    const sp = new URLSearchParams();
    for (const [k, v] of entries) sp.set(k, String(v));
    return '?' + sp.toString();
  }

  async function enrichMessagesWithAttachments(db, messages, userId) {
    const ids = messages.filter(m => m.attachment_id).map(m => m.attachment_id);
    if (ids.length === 0) return messages;
    const map = {};
    try {
      // Pass userId so Worker's sql-safety guardian accepts the SELECT
      // (attachments is in USER_DATA_TABLES; id alone is rejected).
      const attachments = await db.attachments.getByIds(ids, userId);
      for (const a of attachments) {
        const type = a.file_type || (a.r2_key?.includes('/voice/') ? 'voice'
          : a.r2_key?.includes('/image/') ? 'image'
          : a.r2_key?.includes('/video/') ? 'video' : 'file');
        map[a.id] = { id: a.id, type, url: `/portal/attachment/${a.id}`,
          filename: a.file_name || null, fileSize: a.file_size || null,
          transcript: a.transcript || null, description: a.description || null };
      }
    } catch { /* attachment enrichment is optional */ }
    return messages.map(m => m.attachment_id && map[m.attachment_id]
      ? { ...m, attachment: map[m.attachment_id] } : m);
  }

  // ── Route map: channel message type → async (data, user) → result ──
  const routes = {
    // Messages
    'messages': async (data, user) => {
      const db = requireDb();
      const limit = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 50));
      const messages = await db.messages.selectTimeline(user.id, { limit, before: data.before });
      // Project encrypted metadata into the UI-safe flat shape (channel,
      // senderName, senderId, replyTo) and drop the raw JSON. Mirrors
      // /portal/messages so HTTP and WS clients see the same fields.
      const enriched = await enrichMessagesWithAttachments(db, messages, user.id);
      return { messages: enriched.map(projectTimelineRow) };
    },
    'chat-history': async (data, user) => {
      const db = requireDb();
      const limit = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 50));
      const agentFilter = data.agentId || undefined;
      const messages = await db.messages.selectRecent(user.id, { limit, agentId: agentFilter });
      const enriched = await enrichMessagesWithAttachments(db, messages, user.id);
      return { messages: enriched.map(m => ({
        id: String(m.id), role: m.role, content: m.content,
        timestamp: new Date(m.created_at).getTime(), source: m.source,
        ...(m.attachment ? { attachment: m.attachment } : {}),
      })).reverse() };
    },

    // Documents
    'documents-list': async (data, user) => {
      const db = requireDb();
      const docs = await db.documents.list(user.id, {
        category: data.category || null, folderId: data.folder_id || null,
        pinnedOnly: data.pinned === '1',
      });
      return { documents: docs };
    },
    'document-detail': async (data, user) => {
      const db = requireDb();
      const doc = await db.documents.get(user.id, data.documentId || data.path);
      if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
      return { document: doc };
    },
    'documents-create': async (data, user) => {
      const db = requireDb();
      const { path: docPath, content, title, folder_id, created_by } = data;
      if (!docPath) throw Object.assign(new Error('Path required'), { status: 400 });
      // PR 8a: full saveDocument adoption. Mirrors the HTTP POST
      // /portal/documents handler at portal-library.js so cross-transport
      // saves are byte-identical for the same user action.
      // - source 'portal-save': drives source_type pill in library list
      //   when this is the FIRST writer to docPath; INSERT-only invariant
      //   preserves it on subsequent edits even if the user re-saves
      //   through the HTTP transport.
      // - createdBy defaults to 'user' (HTTP POST mirror); accepts a
      //   caller-supplied value when present so future portal flows can
      //   thread agent attribution explicitly.
      // - The pre-PR-8a handler also passed `category: 'general'` —
      //   removed because `category` is not a documents column. Real D1
      //   was rejecting every save with "no such column: category"; the
      //   secure-channel transport silently 500'd and the portal client's
      //   optimistic local update masked the error. This adoption fixes
      //   the prod data-loss bug as a side effect.
      try {
        await saveDocument({ db }, {
          userId: user.id,
          source: 'portal-save',
          scope: 'personal',
          createdBy: typeof created_by === 'string' && created_by.length > 0 ? created_by : 'user',
          path: docPath,
          content: content || '',
          title: title || docPath.split('/').pop(),
          folderId: folder_id || null,
        });
        return { document: { path: docPath } };
      } catch (e) {
        if (e instanceof SaveDocumentError) {
          throw Object.assign(new Error(e.message), { status: 400, code: e.code });
        }
        throw e;
      }
    },
    'document-update': async (data, user) => {
      const db = requireDb();
      // documents are path-keyed; secure-fetch.extractParams writes the
      // URL segment into `data.documentId`, but the value is a path.
      // Sibling document-detail / document-delete handlers do the same.
      const docPath = data.documentId || data.path;
      if (!docPath) throw Object.assign(new Error('Document path required'), { status: 400 });
      // 404-on-missing is preserved with an explicit pre-check.
      // saveDocument's UPDATE branch would otherwise silently INSERT a
      // new row (which is the canonical idempotent behaviour but breaks
      // this handler's documented contract). Cost: one extra round-trip
      // beyond saveDocument's own pre-SELECT. Acceptable for low-rate
      // user-edits.
      const existing = await db.documents.get(user.id, docPath);
      if (!existing) throw Object.assign(new Error('Document not found'), { status: 404 });
      try {
        await saveDocument({ db }, {
          userId: user.id,
          source: 'portal-save',
          // On the UPDATE branch, INSERT-only invariant (B5) ensures
          // scope/createdBy/source_type are NOT written — existing values
          // are preserved. Passing them here is a B3 satisfaction
          // (saveDocument requires scope on every call) without
          // changing on-disk state.
          scope: existing.scope || 'personal',
          createdBy: 'user',
          path: docPath,
          ...(data.content !== undefined ? { content: data.content } : {}),
          ...(data.title !== undefined ? { title: data.title } : {}),
        });
        return { ok: true };
      } catch (e) {
        if (e instanceof SaveDocumentError) {
          throw Object.assign(new Error(e.message), { status: 400, code: e.code });
        }
        throw e;
      }
    },

    // Folders
    'folders': async (_data, user) => {
      const db = requireDb();
      return { folders: await db.documents.listFolders(user.id) };
    },

    // Profile
    'profile': async (_data, user) => {
      const db = requireDb();
      const profile = await db.users.getById(user.id);
      return profile || {};
    },
    'profile-update': async (data, user) => {
      const db = requireDb();
      const { display_name, timezone, settings } = data;
      await db.users.update(user.id, { display_name, timezone, settings });
      return { ok: true };
    },

    // Activity
    'activity-today': async (_data, user) => {
      const db = requireDb();
      return { activities: await db.activity.getToday(user.id) };
    },
    'activity-summary': async (data, user) => {
      const db = requireDb();
      const days = Math.min(90, Math.max(1, parseInt(data.days, 10) || 7));
      return { summary: await db.activity.getSummary(user.id, days) };
    },
    'activity-range': async (data, user) => {
      const db = requireDb();
      return { activities: await db.activity.getRange(user.id, data.start, data.end) };
    },

    // Mindscape
    'mindscape': async (_data, user) => {
      const db = requireDb();
      const [points, territories, realms] = await Promise.all([
        db.clusteringPoints.getAll(user.id),
        db.clusteringPoints.getTerritories(user.id),
        db.clusteringPoints.getRealms(user.id),
      ]);
      return { points, territories, realms };
    },
    'mindscape-social': async (data, user) => {
      const db = requireDb();
      const tier = data.tier || null;
      const contacts = await db.people.list(user.id, { tier });
      return { contacts };
    },
    'mindscape-social-detail': async (data, user) => {
      const db = requireDb();
      const contact = await db.people.getById(user.id, data.contactId);
      if (!contact) throw Object.assign(new Error('Contact not found'), { status: 404 });
      const messages = await db.people.getMessages(user.id, data.contactId, { limit: 50 });
      return { contact, messages };
    },
    'mindscape-growth': async (data, user) => {
      const db = requireDb();
      const events = await db.clusterEvents.getRecent(user.id, parseInt(data.limit, 10) || 100);
      return { events };
    },
    'mindscape-growth-summary': async (_data, user) => {
      const db = requireDb();
      return { summary: await db.clusterEvents.getSummary(user.id) };
    },
    'mindscape-realms': async (_data, user) => {
      const db = requireDb();
      return { realms: await db.clusteringPoints.getRealms(user.id) };
    },
    'mindscape-territories': async (_data, user) => {
      const db = requireDb();
      const territories = await db.territoryDocs.getAllWithDynamics(user.id);
      return { territories };
    },
    'mindscape-activations': async (data, user) => {
      const db = requireDb();
      const date = data.date || new Date().toISOString().split('T')[0];
      const activations = await db.territoryDocs.getDailyActivations(user.id, date);
      return activations;
    },
    'mindscape-noise-stats': async (_data, user) => {
      const db = requireDb();
      return await db.mindscape.getNoiseStats(user.id);
    },

    // Wealth — method names match lib/db-d1.js wealth namespace
    'wealth-portfolios': async (_data, user) => {
      const db = requireDb();
      return { portfolios: await db.wealth.listPortfolios(user.id) };
    },
    'wealth-create-portfolio': async (data, user) => {
      const db = requireDb();
      const { name, baseCurrency, type } = data;
      if (!name) throw Object.assign(new Error('Portfolio name required'), { status: 400 });
      const portfolio = await db.wealth.createPortfolio(user.id, name, baseCurrency || 'EUR', type || 'personal');
      return { portfolio };
    },
    'wealth-portfolio-detail': async (data, user) => {
      const db = requireDb();
      const p = await db.wealth.getPortfolio(data.portfolioId, user.id);
      if (!p) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
      return { portfolio: p };
    },
    'wealth-positions': async (data, user) => {
      const db = requireDb();
      const portfolio = await db.wealth.getPortfolio(data.portfolioId, user.id);
      if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
      return { positions: await db.wealth.getPositions(data.portfolioId) };
    },
    'wealth-transactions': async (data, user) => {
      const db = requireDb();
      const portfolio = await db.wealth.getPortfolio(data.portfolioId, user.id);
      if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
      return { transactions: await db.wealth.listTransactions(data.portfolioId, {
        limit: parseInt(data.limit, 10) || 100,
      }) };
    },
    'wealth-performance': async (data, user) => {
      const db = requireDb();
      const portfolio = await db.wealth.getPortfolio(data.portfolioId, user.id);
      if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
      const snapshots = await db.wealth.getSnapshots(data.portfolioId, {
        from: data.from, to: data.to,
      });
      return { performance: snapshots };
    },
    'wealth-watchlist': async (_data, user) => {
      const db = requireDb();
      return { watchlist: await db.wealth.getWatchlist(user.id) };
    },
    'wealth-assets': async (data, _user) => {
      const db = requireDb();
      if (data.query) {
        return { assets: await db.wealth.findAssets(data.query) };
      }
      return { assets: [] };
    },

    // Connections
    'connections': async (_data, user) => {
      const db = requireDb();
      return { connections: await db.connections.list(user.id) };
    },
    'connections-count': async (_data, user) => {
      const db = requireDb();
      return await db.connections.count(user.id);
    },
    'connections-pending': async (_data, user) => {
      const db = requireDb();
      return { pending: await db.connections.pending(user.id) };
    },
    'connection-request': async (data, user) => {
      const db = requireDb();
      const handle = (data.toHandle || '').replace(/^@/, '').trim();
      if (!handle) throw Object.assign(new Error('Handle required'), { status: 400 });
      return await db.connections.request(user.id, handle);
    },
    'connection-accept': async (data, user) => {
      const db = requireDb();
      return await db.connections.accept(user.id, data.connectionId);
    },
    'connection-reject': async (data, user) => {
      const db = requireDb();
      return await db.connections.reject(user.id, data.connectionId);
    },
    'connection-block': async (data, user) => {
      const db = requireDb();
      return await db.connections.block(user.id, data.connectionId);
    },
    'connection-delete': async (data, user) => {
      const db = requireDb();
      return await db.connections.disconnect(user.id, data.connectionId);
    },
    'connection-overlap': async (data, user) => {
      const db = requireDb();
      return await db.connections.getOverlap(user.id, data.connectionId);
    },

    // Contexts
    'contexts': async (_data, user) => {
      const db = requireDb();
      return { contexts: await db.contexts.list(user.id) };
    },
    'context-create': async (data, user) => {
      const db = requireDb();
      if (!data.name) throw Object.assign(new Error('Name required'), { status: 400 });
      return await db.contexts.create(user.id, { name: data.name, is_private: data.is_private });
    },
    'context-update': async (data, user) => {
      const db = requireDb();
      return await db.contexts.rename(user.id, data.contextId, data.name);
    },
    'context-delete': async (data, user) => {
      const db = requireDb();
      return await db.contexts.remove(user.id, data.contextId);
    },
    'context-add-territory': async (data, _user) => {
      const db = requireDb();
      return await db.contexts.addTerritory(data.contextId, parseInt(data.territoryId));
    },
    'context-remove-territory': async (data, _user) => {
      const db = requireDb();
      return await db.contexts.removeTerritory(data.contextId, parseInt(data.territoryId));
    },
    'context-grant-access': async (data, _user) => {
      const db = requireDb();
      return await db.contexts.grant(data.contextId, data.connectionId);
    },
    'context-revoke-access': async (data, _user) => {
      const db = requireDb();
      return await db.contexts.revoke(data.contextId, data.connectionId);
    },
    'context-territories': async (data, _user) => {
      const db = requireDb();
      return { territories: await db.contexts.getTerritories(data.contextId) };
    },
    'context-connections': async (data, _user) => {
      const db = requireDb();
      return { connections: await db.contexts.getConnections(data.contextId) };
    },

    // Documents — write operations
    'documents-move': async (data, user) => {
      const db = requireDb();
      await db.documents.moveToFolder(user.id, data.path, data.folder_id || null);
      return { ok: true };
    },
    'documents-pin': async (data, user) => {
      const db = requireDb();
      if (data.pinned) await db.documents.pin(user.id, data.path);
      else await db.documents.unpin(user.id, data.path);
      return { ok: true };
    },
    'document-delete': async (data, user) => {
      const db = requireDb();
      await db.documents.delete(user.id, data.documentId || data.path);
      return { ok: true };
    },

    // Folders — write operations
    'folder-create': async (data, user) => {
      const db = requireDb();
      if (!data.name?.trim()) throw Object.assign(new Error('Name required'), { status: 400 });
      return await db.folders.create(user.id, data.name.trim(), data.parent_id || null);
    },
    'folder-update': async (data, user) => {
      const db = requireDb();
      if (!data.name?.trim()) throw Object.assign(new Error('Name required'), { status: 400 });
      return await db.folders.rename(user.id, data.folderId, data.name.trim());
    },
    'folder-delete': async (data, user) => {
      const db = requireDb();
      return await db.folders.delete(user.id, data.folderId);
    },

    // Attachments
    'attachments': async (data, user) => {
      const db = requireDb();
      const limit = Math.min(200, Math.max(1, parseInt(data.limit, 10) || 50));
      const type = data.type || null;
      return { attachments: await db.attachments.list(user.id, { limit, type }) };
    },
    'attachment-update': async (data, user) => {
      const db = requireDb();
      const att = await db.attachments.get(data.attachmentId);
      if (!att || att.user_id !== user.id) throw Object.assign(new Error('Not found'), { status: 404 });
      await db.attachments.update(data.attachmentId, { description: data.description });
      return { ok: true };
    },
    'attachment-delete': async (data, user) => {
      const db = requireDb();
      await db.attachments.delete(data.attachmentId, user.id);
      return { ok: true };
    },

    // Wealth — write operations
    'wealth-delete-portfolio': async (data, user) => {
      const db = requireDb();
      await db.wealth.deletePortfolio(data.portfolioId, user.id);
      return { ok: true };
    },
    'wealth-add-transaction': async (data, user) => {
      const db = requireDb();
      const p = await db.wealth.getPortfolio(data.portfolioId, user.id);
      if (!p) throw Object.assign(new Error('Portfolio not found'), { status: 404 });
      const asset = await db.wealth.upsertAsset({
        symbol: data.symbol, name: data.assetName, type: data.assetType,
        currency: data.currency,
      });
      const tx = await db.wealth.addTransaction({
        portfolio_id: data.portfolioId, asset_id: asset.id,
        type: data.type, quantity: data.quantity,
        price_per_unit: data.pricePerUnit, date: data.date,
        exchange_rate: data.exchangeRate, fees: data.fees, notes: data.notes,
      });
      await db.wealth.recalculatePosition(data.portfolioId, asset.id);
      return { transaction: tx };
    },
    'wealth-delete-transaction': async (data, user) => {
      const db = requireDb();
      const tx = await db.wealth.getTransaction(data.transactionId);
      if (!tx) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      const p = await db.wealth.getPortfolio(tx.portfolio_id, user.id);
      if (!p) throw Object.assign(new Error('Not authorized'), { status: 403 });
      await db.wealth.deleteTransaction(data.transactionId);
      await db.wealth.recalculatePosition(tx.portfolio_id, tx.asset_id);
      return { ok: true };
    },

    // Mindscape write
    'mindscape-territory-visibility': async (data, user) => {
      const db = requireDb();
      await db.clusteringPoints.setTerritoryVisibility(user.id, data.territoryId, data.visibility);
      return { ok: true };
    },

    // Profile
    'profile-recompute': async (_data, user) => {
      const db = requireDb();
      await db.profiles.computeFingerprint(user.id);
      return { ok: true };
    },

    // Settings
    'settings': async (_data, user) => {
      const db = requireDb();
      const u = await db.users.getById(user.id);
      return { settings: u?.settings ? JSON.parse(u.settings) : {}, timezone: u?.timezone };
    },
    'settings-update': async (data, user) => {
      const db = requireDb();
      if (data.timezone) await db.users.updateTimezone(user.id, data.timezone);
      if (data.vault_name !== undefined) {
        const u = await db.users.getById(user.id);
        const current = u?.settings ? JSON.parse(u.settings) : {};
        current.vault_name = String(data.vault_name).trim().substring(0, 60);
        await db.users.updateSettings(user.id, current);
      }
      return { ok: true };
    },

    // Health
    'health-today': async (_data, user) => {
      const db = requireDb();
      return await db.health.getToday(user.id);
    },
    'health-range': async (data, user) => {
      const db = requireDb();
      return await db.health.getRange(user.id, data.start, data.end);
    },
    'health-summary': async (data, user) => {
      const db = requireDb();
      return await db.health.getSummary(user.id, parseInt(data.days, 10) || 7);
    },
    'health-sync': async (data, user) => {
      const db = requireDb();
      if (!Array.isArray(data.days)) throw Object.assign(new Error('days array required'), { status: 400 });
      return await db.health.syncDays(user.id, data.days);
    },
    'vitality-snapshot': async (_data, user) => {
      const db = requireDb();
      const [fpRows, psychRows, complexityRows, eventsResult, sentimentRows] = await Promise.allSettled([
        db.rawQuery('SELECT * FROM user_profiles WHERE user_id = ?', [user.id]),
        db.rawQuery('SELECT * FROM psychological_measurements WHERE user_id = ? ORDER BY measurement_at DESC LIMIT 10', [user.id]),
        db.rawQuery('SELECT * FROM complexity_snapshots WHERE user_id = ? ORDER BY computed_at DESC LIMIT 30', [user.id]),
        db.clusterEvents.getRecent(user.id, 50),
        db.rawQuery(`SELECT date(created_at) as day, AVG(sentiment_valence) as avg_valence, AVG(sentiment_arousal) as avg_arousal, COUNT(*) as msg_count FROM messages WHERE user_id = ? AND sentiment_valence IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30`, [user.id]),
      ]);
      const extract = (r, fb) => r.status === 'fulfilled' ? (r.value?.results || r.value || fb) : fb;
      return { fingerprint: extract(fpRows, [])?.[0] || null, measurements: extract(psychRows, []), complexity: extract(complexityRows, []), growthEvents: extract(eventsResult, []), sentiment: extract(sentimentRows, []) };
    },

    // ── PR1a: critical-leak handlers via loopback proxy ──────────────
    // These proxy to existing Express handlers on 127.0.0.1 so the
    // WS channel inherits the full auth + encryption + audit chain
    // without duplicating it. See proxyToLoopback above.

    // /portal/settings/secret*
    'settings-secrets-list': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/settings/secrets' }),
    'settings-secret-set': async (data) =>
      proxyToLoopback({ method: 'PUT', path: '/portal/settings/secret', body: data }),
    'settings-secret-delete': async (data) =>
      proxyToLoopback({ method: 'DELETE', path: '/portal/settings/secret', body: data }),

    // /portal/passkeys
    'passkeys-list': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/passkeys' }),
    'passkey-register-options': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/passkeys/register/options', body: data }),
    'passkey-register-verify': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/passkeys/register/verify', body: data }),
    'passkey-rename': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/passkeys/rename', body: data }),
    'passkey-delete': async (data) => {
      const id = data?.id;
      if (!id) throw Object.assign(new Error('id required'), { status: 400 });
      return proxyToLoopback({ method: 'DELETE', path: `/portal/passkeys/${encodeURIComponent(id)}` });
    },

    // /portal/master-key/restore — rotate is SSE, stays on plain HTTPS until PR1c
    'master-key-restore': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/master-key/restore', body: data }),

    // /portal/delete-account
    'delete-account-auth': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/delete-account/auth', body: data }),
    'delete-account-verify': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/delete-account/verify', body: data }),
    'delete-account': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/delete-account', body: data }),

    // /portal/auth/{claude,openai} — post-session OAuth linking
    'auth-openai': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/auth/openai', body: data }),
    'auth-openai-status': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/auth/openai/status' }),
    'auth-openai-disconnect': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/auth/openai/disconnect', body: data }),

    // /portal/audit, /portal/energy, /portal/onboarding, /portal/metric-freshness,
    // /portal/pipeline, /portal/integrations, /portal/telegram
    'audit-log': async (data) =>
      proxyToLoopback({ method: 'GET', path: '/portal/audit/log' + buildQuery(data) }),
    'energy': async (data) =>
      proxyToLoopback({ method: 'GET', path: '/portal/energy' + buildQuery(data) }),
    'energy-summary': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/energy/summary' }),
    'energy-live': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/energy/live' }),
    'onboarding-status': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/onboarding/status' }),
    'onboarding-welcome-seen': async () =>
      proxyToLoopback({ method: 'POST', path: '/portal/onboarding/welcome-seen' }),
    'onboarding-dismiss': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/onboarding/dismiss', body: data }),
    'onboarding-reset': async () =>
      proxyToLoopback({ method: 'POST', path: '/portal/onboarding/reset' }),
    'metric-freshness': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/metric-freshness' }),
    'pipeline-status': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/pipeline/status' }),
    'integrations-linear-get': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/integrations/linear' }),
    'integrations-linear-connect': async (data) =>
      proxyToLoopback({ method: 'POST', path: '/portal/integrations/linear', body: data }),
    'integrations-linear-disconnect': async () =>
      proxyToLoopback({ method: 'DELETE', path: '/portal/integrations/linear' }),
    'telegram-groups-list': async () =>
      proxyToLoopback({ method: 'GET', path: '/portal/telegram/groups' }),
    'telegram-groups-delete': async (data) => {
      const id = data?.id;
      if (!id) throw Object.assign(new Error('id required'), { status: 400 });
      return proxyToLoopback({ method: 'DELETE', path: `/portal/telegram/groups/${encodeURIComponent(id)}` });
    },
  };

  // ── Streaming routes: type → async (data, user, emit) → void ──
  const streamRoutes = {
    'chat': async (data, user, emit) => {
      const { message, enableThinking, agentId: targetAgentId, attachmentContext } = data;
      if (!message) throw Object.assign(new Error('Message required'), { status: 400 });

      // If targeting a different agent, proxy to that agent's /chat/stream
      if (targetAgentId && targetAgentId !== agentId && agentRegistry[targetAgentId]) {
        const target = agentRegistry[targetAgentId];
        const proxyBody = { message, userId: user.id, username: user.displayName || user.id,
          source: 'portal', enableThinking, attachmentContext };
        const proxyRes = await fetchImpl(`http://localhost:${target.port}/chat/stream`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(proxyBody), signal: AbortSignal.timeout(300_000),
        });
        const reader = proxyRes.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try { emit(JSON.parse(line.slice(6))); } catch {}
            }
          }
        }
        return;
      }

      // Local agent — build prompt and stream via Claude CLI
      const requestTime = new Date();
      const rawPrompt = message;
      const prompt = attachmentContext ? `${attachmentContext}\n\n${rawPrompt}` : rawPrompt;
      const taskType = data.taskType || 'chat';

      emit({ type: 'stream_start', streamIndex: 0 });

      let systemPrompt = '', context = '', heartbeat = '';
      try {
        systemPrompt = await loadSystemPrompt();
        context = await fs.readFile(paths.knowledge.context, 'utf-8').catch(() => '');
        heartbeat = await fs.readFile(path.join(paths.repo, 'HEARTBEAT.md'), 'utf-8').catch(() => '');
      } catch {}

      let assembledContext = '';
      try {
        assembledContext = await assembleContext(paths.root, user.id, {
          scope: process.env.MEMORY_SCOPE || 'company', source: 'portal', agentId,
        });
      } catch {}

      const teamDirectory = await buildTeamDirectory();
      const fullPrompt = `${systemPrompt}\n\n---\n# Team Directory\n${teamDirectory}\n\n---\n# Your Current State (from autonomous work)\n${heartbeat || 'No heartbeat file found.'}\n\n---\n# Company Context\n${context}${assembledContext ? `\n${assembledContext}` : ''}\n${getWarRoomContext()}${getIntelContext()}\n---\n# Current Message\nFrom: ${user.displayName || 'Portal user'} (user ID: ${user.id}) in #portal\nMessage: ${prompt}\n\n## Important: Your response IS sent directly to the user.\n\nRespond naturally and conversationally.`;

      const laneId = `agent:${agentId}`;
      await enqueue(laneId, async () => {
        incrementActiveTask();
        try {
          const threadKey = `portal_${user.id}`;
          let existingSessionId = await getSessionForThread(paths.root, threadKey);
          let promptWithContext = fullPrompt;
          if (!existingSessionId) {
            const ctxSummary = await getContextSummary(paths.root, threadKey);
            if (ctxSummary) promptWithContext = `${fullPrompt}\n\n---\n# Previous Session Context\n${ctxSummary}\n---`;
          }

          await new Promise((resolve, reject) => {
            const args = ['--print', '--output-format', 'stream-json', '--verbose',
              '--include-partial-messages', '--model', getModelForTask(runtimeState.runtime(), taskType),
              '--max-turns', String(maxTurns)];
            if (existingSessionId) args.push('--resume', existingSessionId);
            args.push('--dangerously-skip-permissions');

            // Per-agent CLAUDE_CONFIG_DIR resolution — see
            // packages/core/claude-config.js. Cache-empty falls through to
            // process.env (PR 1 behavior); PR 2b populates the cache.
            const claude = spawn(claudeBin, args, {
              cwd: paths.repo,
              env: {
                ...process.env,
                HOME: process.env.HOME || '/home/claude',
                ...spawnEnvOverride(agentId),
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            claude.stdin.on('error', () => {});
            claude.stdin.write(promptWithContext);
            claude.stdin.end();

            let sessionId = null, fullOutput = '', buffer = '';
            let currentBlockType = null, currentToolName = null;
            let inputTokens = 0, outputTokens = 0;
            const toolsUsed = [];

            const keepaliveTimer = setInterval(() => emit({ type: 'keepalive' }), 15000);
            const timeout = getTimeout('chat');
            const timeoutTimer = setTimeout(() => { claude.kill('SIGINT'); emit({ type: 'error', message: 'Request timed out' }); }, timeout);

            claude.stdout.on('data', (chunk) => {
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const d = JSON.parse(line);
                  if (d.session_id) sessionId = d.session_id;
                  if (d.type === 'stream_event' && d.event) {
                    const ev = d.event;
                    if (ev.type === 'content_block_start') {
                      if (ev.content_block?.type === 'thinking') { currentBlockType = 'thinking'; emit({ type: 'thinking_start' }); }
                      else if (ev.content_block?.type === 'tool_use') { currentBlockType = 'tool_use'; currentToolName = ev.content_block.name; toolsUsed.push(currentToolName); emit({ type: 'tool_start', name: currentToolName, input: {} }); }
                      else currentBlockType = 'text';
                    } else if (ev.type === 'content_block_delta') {
                      if (ev.delta?.type === 'text_delta') { fullOutput += ev.delta.text; emit({ type: 'text_delta', content: ev.delta.text }); }
                      else if (ev.delta?.type === 'thinking_delta') emit({ type: 'thinking_delta', content: ev.delta.thinking });
                    } else if (ev.type === 'content_block_stop') {
                      if (currentBlockType === 'thinking') emit({ type: 'thinking_end', signature: '' });
                      else if (currentBlockType === 'tool_use') emit({ type: 'tool_complete', name: currentToolName || 'unknown' });
                      currentBlockType = null; currentToolName = null;
                    } else if (ev.type === 'message_delta' && ev.usage) {
                      inputTokens = ev.usage.input_tokens || inputTokens;
                      outputTokens = ev.usage.output_tokens || outputTokens;
                    }
                  } else if (d.type === 'result') {
                    sessionId = d.session_id || sessionId;
                    if (!fullOutput && d.result) fullOutput = d.result;
                  }
                } catch {}
              }
            });

            claude.stderr.on('data', (d) => console.error(`[${logPrefix}] WS stream stderr: ${d.toString().slice(0, 200)}`));

            claude.on('close', async (code) => {
              clearInterval(keepaliveTimer); clearTimeout(timeoutTimer);
              if (code !== 0 && fullOutput.length < 50) emit({ type: 'error', message: fullOutput.trim() || 'Claude exited with error' });
              if (sessionId) {
                await updateSessionMapping(paths.root, threadKey, sessionId, {
                  channelName: 'portal', addTokens: Math.ceil((promptWithContext.length + fullOutput.length) / 4),
                }).catch(() => {});
              }
              if (user.id && fullOutput.trim() && code === 0) {
                // Persistence contract — same metadata shape as /chat so
                // Timeline can render WS-originated messages identically.
                const wsMd = {
                  origin: 'natural-reply',
                  channel: 'portal-ws',
                  threadKey,
                  delivery: 'sent',
                  extra: { transport: 'ws-stream', provider: 'claude' },
                };
                storeMessages(user.id, 'portal', rawPrompt, fullOutput.trim(), requestTime, wsMd).catch(err => {
                  console.error(`[${logPrefix}] WS chat storeMessages failed: ${err.message}`);
                });
              }
              if (inputTokens || outputTokens) emit({ type: 'usage', inputTokens, outputTokens, thinkingTokens: 0 });
              emit({ type: 'done', toolsUsed, thinkingEnabled: false });
              resolve({ sessionId });
            });

            claude.on('error', (err) => { clearInterval(keepaliveTimer); clearTimeout(timeoutTimer); emit({ type: 'error', message: err.message }); reject(err); });
          });
        } finally { decrementActiveTask(); }
      });
    },
  };

  async function authenticateSession(token) {
    if (!token) return null;
    if (portalAppToken && safeCompare(token, portalAppToken)) {
      const db = tryGetDb();
      if (!db) return null;
      const raw = await db.users.getFirst();
      return raw ? { id: raw.id, displayName: raw.display_name, timezone: raw.timezone } : null;
    }
    const auth = await getAuthModule();
    return auth.validateSession(token);
  }

  return {
    routes,
    streamRoutes,
    authenticateSession,
    enrichMessagesWithAttachments,
    requireDb,
  };
}
