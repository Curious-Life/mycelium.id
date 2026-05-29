/**
 * Internal search router — `/internal/v1/search/mindscape`.
 *
 * The agent-server hosts this so MCP-tool subprocesses (which run in
 * separate stdio child processes and therefore cannot see the parent's
 * mind-search RAM index or scan-matcher caches) can recall through the
 * live, hot, decrypted index instead of falling through to the legacy
 * Vectorize path. That fallback path is broken since the BGE shutdown
 * (1024D vs 768D mismatch) and is not coming back.
 *
 * Why this lives in agent-server, not in the MCP process:
 *   The mind-search index holds ~22k–50k decrypted Float32Arrays plus
 *   ANN structures (~150MB resident on admin). Bootstrapping a copy in
 *   every MCP subprocess would double that on each tool session — fatal
 *   on 4GB customer VPSes and wasteful everywhere else.
 *   One process owns the cache; everyone else asks via loopback.
 *
 * Why the HTTP boundary is not a security boundary:
 *   MCP subprocesses inherit ENCRYPTION_MASTER_KEY from their PM2 parent
 *   and have direct D1 access. They could decrypt anything they wanted
 *   in-process; the master key is not what we're hiding here. The
 *   boundary exists for RAM dedup and to absorb future backend swaps
 *   (replace LocalBackend with a sidecar / sharded engine without
 *   changing every caller). Treat the HTTP hop as plumbing, not as
 *   isolation. Auth (loopback / X-Worker-Secret) gates abuse, not
 *   plaintext exposure.
 *
 * What this router deliberately does NOT do:
 *   - Cross-tenant fan-out (deferred until bonds Phase 1; `tenantId`
 *     in the request body is reserved but ignored in v1).
 *   - Graph queries beyond inline territory co-firing expansion. Add
 *     `/internal/v1/search/topology` later if the need surfaces; do
 *     not overload this route.
 *   - Markdown formatting. The MCP-side `searchMindscape` tool owns
 *     formatting; the wire is JSON-only so portal / tests / future
 *     callers don't pay a parse-then-render tax.
 *
 * Logging discipline (per CLAUDE.md §1, §8):
 *   Never log query text. Never log result IDs or content. Log only
 *   counts, latencies, status, request_id. The body parser caps the
 *   request at 4KB so even an attacker who slipped past auth cannot
 *   spray large payloads into our memory.
 *
 * Failure semantics (fail-closed, never silent fallback):
 *   - Warming (mind-search not yet rehydrated, scan-matchers cold)
 *     → 503 + Retry-After: 5. Client retries once.
 *   - Embed-service down → 503. Caller surfaces "search unavailable".
 *   - Per-corpus error mid-fanout → 200 with that corpus in `degraded`.
 *   - Auth fail → 401. Bad body → 400. Anything else → 500 with a
 *     request_id back-reference for the log line.
 */

import { Router } from 'express';
import express from 'express';
import {
  VALID_CORPORA,
  LIMITS,
} from '@mycelium/core/mind-search/result-types.js';
import { makeAgentIdMatcher } from '@mycelium/core/agent-id-aliases.js';

const ROUTE_PREFIX = '/v1/search/mindscape';

/**
 * @typedef {object} CreateInternalSearchRouterDeps
 * @property {(req: any, res: any) => boolean} requireWorkerSecret
 *   Existing middleware: passes loopback OR matches X-Worker-Secret. Same
 *   gate /think and /delegate use. Returns true if auth ok.
 * @property {() => object|null} tryGetDb
 *   Resolves the d1 backend at request time (db is initialized after
 *   createApp() in the boot sequence).
 * @property {() => object|null} getMindSearch
 *   Resolves runtimeState.mindSearch() at request time. Null until
 *   bootstrapMindSearch finishes; used by /ready.
 * @property {(tableName: string) => object|null} getScanMatcher
 *   Resolves a scan-matcher from the registry. Used by /ready and to
 *   decide whether a corpus is warm.
 * @property {{ embed: Function, health: Function }} embedder
 *   Embedder client (createEmbedderClient).
 * @property {object} [logger]
 *   Optional structured logger. Falls back to console.
 */

/**
 * @param {CreateInternalSearchRouterDeps} deps
 * @returns {import('express').Router}
 */
export function createInternalSearchRouter(deps) {
  if (!deps) throw new TypeError('createInternalSearchRouter: deps required');
  const { requireWorkerSecret, tryGetDb, getMindSearch, getScanMatcher, embedder, logger } = deps;

  for (const [name, value] of [
    ['requireWorkerSecret', requireWorkerSecret],
    ['tryGetDb', tryGetDb],
    ['getMindSearch', getMindSearch],
    ['getScanMatcher', getScanMatcher],
    ['embedder', embedder],
  ]) {
    if (!value) throw new TypeError(`createInternalSearchRouter: deps.${name} required`);
  }
  if (typeof embedder.embed !== 'function' || typeof embedder.health !== 'function') {
    throw new TypeError('createInternalSearchRouter: embedder must expose { embed, health }');
  }

  const log = logger || console;
  const router = Router();

  // Body parser scoped to this router only — the global parser allows
  // 10MB for portal uploads; we don't want that surface for an
  // internal-only recall endpoint.
  const bodyParser = express.json({ limit: LIMITS.BODY_BYTES_MAX });

  // ── GET /v1/search/mindscape/ready ───────────────────────────────
  //
  // Liveness probe. Returns ok=true only when all three subsystems are
  // ready to serve a real query. Used by deploy verification and
  // future portal status surfaces. Auth-required so we don't leak
  // internal readiness state to anything that can reach the bind port.
  router.get(`${ROUTE_PREFIX}/ready`, (req, res, next) => {
    if (!requireWorkerSecret(req, res)) return; // mw replies on deny
    const ms = getMindSearch();
    const scanReady = (
      hasLoadedScanMatcher(getScanMatcher, 'territory_profiles') &&
      hasLoadedScanMatcher(getScanMatcher, 'realms') &&
      hasLoadedScanMatcher(getScanMatcher, 'semantic_themes') &&
      hasLoadedScanMatcher(getScanMatcher, 'documents')
    );

    Promise.resolve(embedder.health()).then((healthy) => {
      const components = {
        mindSearch: !!ms,
        scanMatchers: scanReady,
        embedder: !!healthy,
      };
      const ok = components.mindSearch && components.scanMatchers && components.embedder;
      res.status(ok ? 200 : 503).json({ ok, components });
    }).catch(() => {
      res.status(503).json({
        ok: false,
        components: {
          mindSearch: !!ms,
          scanMatchers: scanReady,
          embedder: false,
        },
      });
    });
  });

  // ── POST /v1/search/mindscape ─────────────────────────────────────
  router.post(`${ROUTE_PREFIX}`, bodyParser, async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    const startedAt = Date.now();
    const requestId = req.id || req.headers?.['x-request-id'] || null;

    // ── 1. Body validation ────────────────────────────────────────
    const body = req.body || {};
    const validation = validateBody(body);
    if (!validation.ok) {
      log_safely(log, req, 'warn', 'search_mindscape.bad_request', { reason: validation.detail });
      return res.status(400).json({ ok: false, reason: 'bad_request', detail: validation.detail });
    }
    const { query, corpora, topK, agent, documentScope, expandTopology } = validation.value;

    // ── 2. Warming check ──────────────────────────────────────────
    const warming = checkWarming({ corpora, getMindSearch, getScanMatcher });
    if (warming.length) {
      log_safely(log, req, 'info', 'search_mindscape.warming', { components: warming });
      res.set('Retry-After', '5');
      return res.status(503).json({ ok: false, reason: 'warming', components: warming });
    }

    // ── 3. db hydrate-side resolves ────────────────────────────────
    const db = tryGetDb();
    if (!db) {
      log_safely(log, req, 'error', 'search_mindscape.db_unavailable', {});
      return res.status(503).json({ ok: false, reason: 'warming', components: ['db'] });
    }
    const userId = process.env.MYA_USER_ID || process.env.USER_ID || process.env.AGENT_ID;
    if (!userId) {
      log_safely(log, req, 'error', 'search_mindscape.no_user_id', {});
      return res.status(500).json({ ok: false, reason: 'internal', request_id: requestId });
    }

    // ── 4. Embed the query (server-side; single owner of task prefix) ─
    let embedding;
    let embedMs = 0;
    try {
      const embedStart = Date.now();
      embedding = await embedder.embed(query, { task: 'query' });
      embedMs = Date.now() - embedStart;
    } catch (err) {
      log_safely(log, req, 'warn', 'search_mindscape.embed_unavailable', {
        err: err && err.message ? err.message : 'unknown',
      });
      res.set('Retry-After', '5');
      return res.status(503).json({ ok: false, reason: 'embed_unavailable' });
    }

    // ── 5. Fan out per corpus, allSettled for partial-degrade ────────
    const tasks = corpora.map((corpus) => ({
      corpus,
      promise: runCorpus({ corpus, embedding, db, userId, topK, agent, documentScope }),
    }));
    const settled = await Promise.allSettled(tasks.map((t) => t.promise));

    /** @type {Record<string, any[]>} */
    const results = {};
    /** @type {string[]} */
    const degraded = [];
    for (let i = 0; i < tasks.length; i++) {
      const { corpus } = tasks[i];
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results[corpus] = outcome.value;
      } else {
        degraded.push(corpus);
        log_safely(log, req, 'warn', 'search_mindscape.corpus_failed', {
          corpus,
          err: outcome.reason && outcome.reason.message ? outcome.reason.message : 'unknown',
        });
      }
    }

    // ── 6. Topology expansion (inline; one round-trip not N) ─────────
    if (expandTopology && Array.isArray(results.territories) && results.territories.length > 0) {
      try {
        await expandTerritoriesTopology({ db, userId, territories: results.territories });
      } catch (err) {
        // Topology failure does not fail the whole response; just mark.
        degraded.push('territories.topology');
        log_safely(log, req, 'warn', 'search_mindscape.topology_failed', {
          err: err && err.message ? err.message : 'unknown',
        });
      }
    }

    // ── 7. Respond ────────────────────────────────────────────────
    const elapsedMs = Date.now() - startedAt;
    const counts = countsByCorpus(results);
    log_safely(log, req, 'info', 'search_mindscape.ok', {
      corpora_requested: corpora.length,
      degraded_count: degraded.length,
      elapsed_ms: elapsedMs,
      embed_ms: embedMs,
      counts,
    });

    res.status(200).json({
      ok: true,
      elapsedMs,
      embedStatus: degraded.length === 0 ? 'ok' : 'degraded',
      degraded,
      results,
    });
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * @param {*} body
 * @returns {{ ok: true, value: object } | { ok: false, detail: string }}
 */
function validateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, detail: 'body must be a JSON object' };
  }
  const { query, corpora, topK, agent, documentScope, expandTopology, tenantId } = body;

  if (typeof query !== 'string') {
    return { ok: false, detail: 'query must be a string' };
  }
  if (query.length === 0) {
    return { ok: false, detail: 'query must be non-empty' };
  }
  if (query.length > LIMITS.QUERY_MAX_CHARS) {
    return { ok: false, detail: `query exceeds ${LIMITS.QUERY_MAX_CHARS} chars` };
  }

  let corporaResolved = VALID_CORPORA.slice();
  if (corpora !== undefined) {
    if (!Array.isArray(corpora) || corpora.length === 0) {
      return { ok: false, detail: 'corpora must be a non-empty array' };
    }
    for (const c of corpora) {
      if (!VALID_CORPORA.includes(c)) {
        return { ok: false, detail: 'unknown corpus' };
      }
    }
    corporaResolved = [...new Set(corpora)];
  }

  let topKResolved = LIMITS.TOPK_DEFAULT;
  if (topK !== undefined) {
    if (!Number.isInteger(topK) || topK <= 0 || topK > LIMITS.TOPK_MAX) {
      return { ok: false, detail: `topK must be an integer in [1, ${LIMITS.TOPK_MAX}]` };
    }
    topKResolved = topK;
  }

  if (agent !== undefined && agent !== null && typeof agent !== 'string') {
    return { ok: false, detail: 'agent must be a string or null' };
  }

  let documentScopeResolved = 'all';
  if (documentScope !== undefined) {
    if (!['all', 'documents', 'messages'].includes(documentScope)) {
      return { ok: false, detail: 'documentScope must be one of: all, documents, messages' };
    }
    documentScopeResolved = documentScope;
  }

  const expandTopologyResolved = expandTopology === true;

  // tenantId reserved; v1 ignores. Reject explicit cross-tenant attempts so the
  // future contract is forced through bonds, not silent passthrough.
  if (tenantId !== undefined && tenantId !== null) {
    return { ok: false, detail: 'tenantId not yet supported (reserved for bonds)' };
  }

  return {
    ok: true,
    value: {
      query,
      corpora: corporaResolved,
      topK: topKResolved,
      agent: typeof agent === 'string' ? agent : null,
      documentScope: documentScopeResolved,
      expandTopology: expandTopologyResolved,
    },
  };
}

/**
 * Returns an array of subsystem names that are not warm enough to serve
 * the requested corpora. Empty array means ready.
 */
function checkWarming({ corpora, getMindSearch, getScanMatcher }) {
  const cold = [];
  if (corpora.includes('messages')) {
    if (!getMindSearch()) cold.push('mind_search');
  }
  const corpusToTable = {
    documents: 'documents',
    territories: 'territory_profiles',
    realms: 'realms',
    themes: 'semantic_themes',
  };
  for (const corpus of corpora) {
    const table = corpusToTable[corpus];
    if (!table) continue;
    if (!hasLoadedScanMatcher(getScanMatcher, table)) cold.push(`scan_${table}`);
  }
  return cold;
}

/**
 * Scan-matcher is "loaded" when its internal cache has been populated.
 * The matcher exposes _internal() with { loaded, cacheSize } so we can
 * check without forcing a query.
 */
function hasLoadedScanMatcher(getScanMatcher, tableName) {
  const m = getScanMatcher(tableName);
  if (!m) return false;
  if (typeof m._internal !== 'function') return true; // back-compat
  const state = m._internal();
  return !!state.loaded;
}

/**
 * Per-corpus dispatch. Errors propagate to allSettled; the caller marks
 * the corpus as degraded and returns 200 with partial results.
 */
async function runCorpus({ corpus, embedding, db, userId, topK, agent, documentScope }) {
  switch (corpus) {
    case 'messages': {
      const rows = await db.messages.matchMessages(embedding, userId, topK);
      // Alias-aware filter: 'personal-agent' includes legacy 'mya-personal'
      // (~38k historic ChatGPT/Claude/import rows). Single source of truth
      // in @mycelium/core/agent-id-aliases.js.
      const matcher = makeAgentIdMatcher(agent);
      return rows.filter((r) => matcher(r.agent_id));
    }
    case 'documents': {
      // The legacy searchMindscape passed includeInternal=false unless the
      // caller asked for messages-scope; preserve that behavior.
      const includeInternal = documentScope === 'messages';
      return db.messages.matchDocuments(embedding, userId, topK, includeInternal);
    }
    case 'territories':
      return db.search.matchTerritories(embedding, userId, topK);
    case 'realms':
      return db.search.matchRealms(embedding, userId, topK);
    case 'themes':
      return db.search.matchThemes(embedding, userId, topK);
    default:
      throw new Error(`unknown corpus: ${corpus}`);
  }
}

/**
 * For each top-N matched territory (capped at 3), fetch co-firing
 * neighbors and attach as `topology` on the territory hit. In-place.
 *
 * Single round-trip from MCP, fan-out on server.
 *
 * Threshold (`p_min_strength: 0.1`) is intentionally low: top-K +
 * ORDER BY in the SQL already does the meaningful ranking, so the
 * threshold's job is only to filter pure-noise pairs (~0). The
 * legacy 2.0 cutoff was calibrated for admin's 46k-message corpus
 * where typical pairs land around 4–10; on smaller tenants (puh
 * peaks at ~0.96 in cofire_session) it filtered everything out.
 */
async function expandTerritoriesTopology({ db, userId, territories }) {
  if (!db.topology || typeof db.topology.getCoFiring !== 'function') return;
  const top = territories.slice(0, 3);
  await Promise.all(top.map(async (t) => {
    if (t.territory_id == null) return;
    try {
      const rows = await db.topology.getCoFiring({
        p_user_id: userId,
        p_territory_id: t.territory_id,
        p_scale: 'session',
        p_min_strength: 0.1,
        p_limit: 5,
      });
      t.topology = (rows || []).map((r) => ({
        territory_id: r.territory_id,
        name: r.name,
        weight: r.cofire_strength,
      }));
    } catch {
      // Per-territory failure is silent here; the response includes
      // territory hits without topology rather than failing the whole
      // expansion. The caller decides whether to surface partial state.
      t.topology = [];
    }
  }));
}

function countsByCorpus(results) {
  const out = {};
  for (const k of Object.keys(results)) {
    out[k] = Array.isArray(results[k]) ? results[k].length : 0;
  }
  return out;
}

/**
 * Structured logger that never serializes user input. Always pass
 * fields explicitly; never spread the request body.
 */
function log_safely(logger, req, level, evt, fields) {
  try {
    const child = req && req.log ? req.log : logger;
    const fn = child[level] || child.info;
    if (typeof fn === 'function') {
      fn.call(child, { evt, ...fields });
    }
  } catch {
    /* logging must never throw */
  }
}
