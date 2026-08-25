/**
 * Mind-search subsystem — public entry point.
 *
 * createSearchHelpers({ db, embedder, userId }) returns the searchHelpers
 * object src/tools/mindscape.js depends on. The load-bearing method is
 * `bulkSearch(args)` (the real mindscape.js contract, verified at
 * src/tools/mindscape.js:29,57):
 *
 *   bulkSearch({ query, limit, agent, scope, includeTopology }) -> {
 *     messages:    string[],
 *     documents:   string[],
 *     territories: { formatted: string[], raw: object[] },
 *     realms:      string[],
 *     themes:      string[],
 *   }
 *
 * Implementation: one in-RAM mind-search index (BM25 + ANN cosine + RRF +
 * temporal) holds all indexable rows (messages + documents + topology profiles;
 * documents are BM25-only — no stored embedding). bulkSearch
 * embeds the query (via the INJECTED embedder — embed-service :8091 is sibling
 * unit R2; absent → BM25-only), runs the tier, then groups the ranked ids back
 * into their source layer by hydrating from the DB via `db.rawQuery`.
 * structure() reads the topology profile tables directly (honest empty shape
 * when empty).
 *
 * Single-user (PORT-PRIORITY): the index is unconditional — no per-user filter
 * wrapper. The legacy user_id column is still passed to SQL for canonical
 * parity but is always the one local user.
 *
 * DB contract (verified against src/db/index.js + src/adapter/d1.js):
 *   db.rawQuery(sql, params) -> { results: [...] }   (adapter auto-decrypts)
 *   db.topology.getCoFiring({ p_user_id, p_territory_id, p_scale, p_limit })
 */

import { createLocalBackend } from './backend/local.js';
import { attachmentLineResolver } from '../agent/attachment-context.js';
import { createSqliteBackend } from './backend/sqlite.js';
import { loadFromDb, ID_PREFIX, stripPrefix } from './d1-loader.js';
import { setMindSearch } from './registry.js';
import { renderRef } from '../core/item-ref.js';
import { startBuildChild } from './build-child.js';
import { SearchWarmingError } from '../tools/search-client.js';

const DEFAULT_USER = 'local-user';

/**
 * Select the search backend. Default = the in-RAM LocalBackend (rebuilt from the
 * whole corpus per boot). Opt-in (Phase 1) = the on-disk SqliteBackend (FTS5 +
 * sqlite-vec inside the vault DB; no rebuild, page-cache memory). The on-disk
 * path stays OFF by default until incremental maintenance owns every write —
 * otherwise the disk index goes stale between Generates. Enable with
 * MYCELIUM_SEARCH_BACKEND=sqlite (requires db._sqlite, the raw handle).
 */
function chooseBackend({ db, embedder, userId, searchBackend }) {
  const want = (searchBackend ?? process.env.MYCELIUM_SEARCH_BACKEND ?? '').toLowerCase();
  // The on-disk index lives in a SEPARATE encrypted sidecar handle (db._sqliteSearch),
  // NOT inside the vault (db._sqlite) — so a corrupt regenerable index is a file-level
  // rm+rebuild, never a fatal/un-DROPpable vault error (the search-sidecar design).
  // If the sidecar is unavailable (open failed, or a context that didn't open one),
  // fall back to the in-RAM local backend — search must never break boot.
  if (want === 'sqlite' && db && db._sqliteSearch) {
    return { backend: createSqliteBackend({ sqliteDb: db._sqliteSearch, embedder, userId }), kind: 'sqlite' };
  }
  return { backend: createLocalBackend({ embedder, userId }), kind: 'local' };
}

export function createSearchHelpers(deps = {}) {
  const { db = null, embedder = null, userId = DEFAULT_USER, getMasterKey = null, searchBackend = null, childBuild = false } = deps;

  const { backend, kind: backendKind } = chooseBackend({ db, embedder, userId, searchBackend });
  let built = false;
  // Single-flight build latch. The first build of a large vault is minutes-long
  // and single-threaded; without this latch, every search that arrives mid-build
  // sees `built === false` (only set AFTER loadFromDb completes) and kicks off
  // ANOTHER full-vault loadFromDb on the SAME shared backend/_index — N concurrent
  // builds thrashing the one JS thread and mutating shared index state. Storing the
  // in-flight promise makes every concurrent caller await the SAME build.
  let buildPromise = null;

  // ── Off-process build (the 2026-08-22 event-loop-starvation fix) ───────────
  // With `childBuild` (real app launches only — threaded down from boot), the
  // full corpus build runs in a SPAWNED CHILD (build-worker.mjs) instead of on
  // this serving thread: in-process it starves the event loop for minutes on a
  // large SQLCipher vault, every request times out, and the connected agent
  // loses its vault tools. While the child runs, searches fail FAST with
  // SearchWarmingError instead of blocking behind the build. Kill switch:
  // MYCELIUM_SEARCH_CHILD_BUILD=0. Design: the 2026-08-22 search-build off-process note.
  let childBuilding = false;      // true for the whole child-path build (incl. wait-on-foreign)
  let childHandle = null;         // { promise, stop } of the live spawned worker
  let buildProgress = null;       // { source, added, at } — counts only, never content
  let pendingForce = false;       // set by rebuild(): skip the corpus_built short-circuit
  const log = (m) => console.error(m); // counts/timings/reasons only (CLAUDE.md §1)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const useChild = () => childBuild && backendKind === 'sqlite'
    && process.env.MYCELIUM_SEARCH_CHILD_BUILD !== '0'
    && typeof backend.getBuildState === 'function'
    && !!(db && typeof db._dbPath === 'string');

  // `build_watermark.at` is refreshed transactionally with every committed batch,
  // so a FRESH watermark = a live builder in some process (REST vs MCP share the
  // sidecar). Fresh → wait instead of duplicating the build; stale → the builder
  // died, and OUR spawn resumes from that watermark.
  const WATERMARK_FRESH_MS = 60_000;
  function foreignBuildFresh() {
    try {
      const st = backend.getBuildState();
      const wm = st && st.build_watermark ? JSON.parse(st.build_watermark) : null;
      return !!(wm && typeof wm.at === 'number' && Date.now() - wm.at < WATERMARK_FRESH_MS);
    } catch { return false; }
  }

  async function childBuildCorpus({ force = false } = {}) {
    childBuilding = true;
    try {
      if (!force && foreignBuildFresh()) {
        log('[search] corpus build already running in another process — waiting for it');
        for (;;) {
          await sleep(5000);
          if (backend.isCorpusBuilt()) return;
          if (!foreignBuildFresh()) break; // builder died — take over below (resume)
        }
      }
      const spawned = startBuildChild({
        dbPath: db._dbPath,
        userId,
        force,
        onProgress: (p) => { buildProgress = { source: p.source, added: p.added, at: Date.now() }; },
      });
      if (!spawned.ok) {
        // No pinned session keys (locked vault, verify context) or no spawn —
        // fall back to the in-process build rather than leaving search empty.
        log(`[search] corpus build child unavailable (${spawned.reason}) — building in-process`);
        await loadFromDb({ backend, db, userId, getMasterKey });
        if (typeof backend.markCorpusBuilt === 'function') backend.markCorpusBuilt();
        return;
      }
      childHandle = spawned;
      log(`[search] corpus build started off-process${force ? ' (forced rebuild)' : ''} — searches answer "warming" until it completes`);
      const res = await spawned.promise;
      if (res.ok) {
        const d = res.result || {};
        log(`[search] corpus build done: ${d.added ?? '?'} docs in ${Math.round((d.tookMs ?? 0) / 1000)}s (vectors ${d.vectorsLoaded ?? '?'} loaded, ${d.vectorsFailed ?? 0} failed)`);
      } else {
        log(`[search] corpus build FAILED (${res.reason}${res.message ? `: ${res.message}` : ''}) — index may be partial; the watermark resumes it next boot/Generate`);
      }
    } finally {
      childBuilding = false;
      childHandle = null;
      buildProgress = null;
    }
  }

  // The actual corpus load. Never throws (errors are swallowed so a failed build
  // still flips `built`, matching the prior fall-through behavior — a partial/empty
  // schema must not wedge every future search retrying forever). Always sets
  // `built = true` on completion.
  async function buildCorpus() {
    const force = pendingForce;
    pendingForce = false;
    if (db && typeof db.rawQuery === 'function') {
      try {
        // On-disk backend persists across boots: populate ONCE (the same
        // loadFromDb path the in-RAM backend uses every boot), tracked by a
        // PERSISTED flag — NOT count()>0, which incremental writes (noteUpsert)
        // would trip before the first query, skipping the full corpus load. The
        // in-RAM backend always (re)builds. `force` (rebuild()) skips the
        // short-circuit — before it, rebuild() on the sqlite backend was a
        // silent NO-OP and the post-Generate refresh never refreshed anything.
        if (!force && backendKind === 'sqlite' && typeof backend.isCorpusBuilt === 'function' && backend.isCorpusBuilt()) {
          // already populated on disk — no rebuild
        } else if (useChild()) {
          await childBuildCorpus({ force });
        } else {
          await loadFromDb({ backend, db, userId, getMasterKey });
          if (backendKind === 'sqlite' && typeof backend.markCorpusBuilt === 'function') backend.markCorpusBuilt();
        }
      } catch { /* fall through */ }
    }
    built = true;
  }

  async function ensureBuilt() {
    if (built) return;
    // Single-flight: the first caller starts the build and stores its promise;
    // concurrent callers await that same promise instead of starting their own.
    // `.finally` clears the latch so rebuild() can trigger a fresh build later.
    if (!buildPromise) buildPromise = buildCorpus().finally(() => { buildPromise = null; });
    await buildPromise;
  }

  // Fail-fast contract for the child-build window: a search arriving while the
  // corpus is being built off-process gets a typed warming error (mapped to an
  // honest "index is rebuilding" message by the tool layer) instead of silently
  // blocking for minutes behind the build promise. In-process builds keep the
  // blocking join — verify gates and small vaults depend on it.
  function throwIfChildWarming() {
    if (!childBuilding) return;
    const p = buildProgress;
    throw new SearchWarmingError(
      `the search index is being rebuilt${p ? ` (${p.added} docs indexed, on ${p.source})` : ''} — retry in a minute`,
    );
  }

  // Kick the corpus build in the BACKGROUND (fire-and-forget) so the first
  // user-facing search does not eat the full cold-start latency. Safe to call at
  // boot (after unlock) and idempotent — it routes through the same single-flight
  // ensureBuilt(), so a concurrent first search joins this build rather than
  // starting a second one. Returns the in-flight promise for callers that want to
  // await it (e.g. tests); rejections are swallowed (build self-heals on next call).
  function warm() {
    const p = ensureBuilt();
    p.catch(() => { /* best-effort: search self-heals on next query/boot */ });
    return p;
  }

  // Introspection for warming UIs / health endpoints: has the corpus finished
  // loading, and is a build currently in flight? (mirrors the mindscape 503+
  // Retry-After "warming" convention — a caller can surface "indexing…" instead
  // of blocking or returning a misleading empty result.)
  const isBuilt = () => built;
  const isWarming = () => !built && buildPromise !== null;

  // Incremental index maintenance (§8). NO-OP unless the on-disk backend is
  // active: the in-RAM backend is rebuilt per boot, so per-write upserts would
  // just grow it unboundedly between Generates. Best-effort everywhere — a
  // maintenance failure NEVER blocks the originating write. Reached from the
  // write paths via getMindSearch() (registry), so capture/enrich keep the
  // on-disk index fresh without a rebuild.
  const incremental = backendKind === 'sqlite';

  // ── Incremental write batching (D-148) ─────────────────────────────────────
  // One captured message used to cost ONE encrypted-WAL transaction (a full
  // delete-then-insert through backend.add) — measured decaying to ~14 docs/min
  // at 67k-corpus scale (spike-index-build-perf strategy A), which turned every
  // ingest burst into HOURS of serving-thread grind (CPU-profiled live
  // 2026-08-22: 88% self-time under add()). Upserts and enrichment vectors now
  // coalesce for ≤25ms (or 128 entries) and commit as ONE transaction through
  // the idempotent bulkAdd/bulkVectors — the same amortization that holds the
  // bulk build at ~6k/s. The promise a writer gets back resolves only AFTER the
  // batch containing its write commits, so awaited callers (capture, the SQ
  // gates) keep read-your-write semantics; fire-and-forget callers lose nothing.
  //
  // DELETES ARE NEVER QUEUED. The forget cascade must evict NOW (fail-closed —
  // verify:forget F7), and a queued upsert must never outlive a delete: a batch
  // flushing after a forget would RESURRECT forgotten content into the index.
  // So every delete first PURGES the pending maps, then hits the backend
  // immediately — including `exposedBackend.delete`, because delete-cascade.js
  // calls helpers.backend.delete directly, bypassing noteDelete.
  const BATCH_MAX = 128;
  const BATCH_WINDOW_MS = 25;
  let pendingUpserts = new Map();
  let pendingVectors = new Map();
  let batchTimer = null;
  let batchSettle = null; // settle handle for the currently open window

  function openWindow() {
    if (!batchSettle) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      batchSettle = { promise, resolve };
    }
    if (!batchTimer) {
      // NOT unref'd, deliberately: an unref'd timer lets a quiet process exit
      // BEFORE the window flushes — awaited writers would hang-then-vanish and
      // short-lived contexts (gates, scripts) would silently lose the batch.
      // Holding the loop open for ≤25ms is the correct price.
      batchTimer = setTimeout(() => { batchTimer = null; flushIncremental(); }, BATCH_WINDOW_MS);
    }
    return batchSettle.promise;
  }

  async function flushIncremental() {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    const settle = batchSettle; batchSettle = null;
    const ups = pendingUpserts; pendingUpserts = new Map();
    const vecs = pendingVectors; pendingVectors = new Map();
    try {
      if (ups.size) {
        if (typeof backend.bulkAdd === 'function') await backend.bulkAdd([...ups.values()]);
        else for (const d of ups.values()) { try { await backend.add(d); } catch { /* skip unindexable row */ } }
      }
      if (vecs.size) {
        if (typeof backend.bulkVectors === 'function') backend.bulkVectors([...vecs.entries()]);
        else for (const [vid, v] of vecs) { try { backend.noteVector?.(vid, v); } catch { /* best-effort */ } }
      }
    } catch { /* best-effort: never block the originating write (unchanged contract) */ }
    settle?.resolve();
  }

  function purgePending(ids) {
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      if (typeof id === 'string' && id) { pendingUpserts.delete(id); pendingVectors.delete(id); }
    }
  }

  async function noteUpsert(doc) {
    if (!incremental || !doc || typeof doc.id !== 'string' || !doc.id) return;
    pendingUpserts.set(doc.id, {
      id: doc.id,
      text: doc.text ?? doc.content ?? '',
      embedding: doc.embedding,
      ts: Number.isFinite(doc.ts) ? doc.ts : Math.floor(Date.now() / 1000),
    });
    const settled = openWindow();
    if (pendingUpserts.size + pendingVectors.size >= BATCH_MAX) await flushIncremental();
    await settled;
  }

  async function noteDelete(ids) {
    if (!incremental) return;
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string' && id);
    purgePending(list);
    try { await backend.delete({ ids: list }); } catch { /* best-effort */ }
  }

  // Vector-ready hook (enrichment): update only this id's vector, preserve
  // ts/fts. Returns the flush promise (callers today ignore it; gates may await).
  function noteVector(id, embedding) {
    if (!incremental || typeof id !== 'string' || !id || !embedding) return undefined;
    pendingVectors.set(id, embedding);
    const settled = openWindow();
    if (pendingUpserts.size + pendingVectors.size >= BATCH_MAX) flushIncremental();
    return settled;
  }

  // The backend object handed out of this module: identical surface, except
  // delete purges the pending batch first (the resurrection guard above).
  const exposedBackend = {
    ...backend,
    delete: async (req = {}) => { purgePending(req.ids || []); return backend.delete(req); },
  };

  // Index a document directly (tests / incremental updates). Marks built so a
  // later ensureBuilt() does not clobber a hand-loaded in-RAM corpus.
  async function indexDocument(doc) {
    await backend.add({
      id: doc.id,
      text: doc.text ?? doc.content ?? '',
      embedding: doc.embedding,
      ts: Number.isFinite(doc.ts) ? doc.ts : Math.floor(Date.now() / 1000),
    });
    built = true;
  }

  // Force a rebuild from the DB. `pendingForce` makes buildCorpus skip the
  // corpus_built short-circuit — without it, rebuild() on the sqlite backend was
  // a silent no-op and the post-Generate refresh (src/jobs.js refreshSearchIndex)
  // never refreshed anything. On the child path the reset+rebuild runs
  // off-process, so a post-Generate refresh can no longer freeze the app.
  async function rebuild() {
    pendingForce = true;
    built = false;
    await ensureBuilt();
    return backend.count();
  }

  // A corrupt on-disk index must degrade to empty, NEVER throw up to the tool: the
  // sidecar self-heals (rm+rebuild) on the next boot (src/search/sqlite/sidecar.js),
  // so a runtime `malformed` is transient. Keeps the index non-fatal at runtime too.
  async function safeBackendQuery(q) {
    try { return await backend.query(q); }
    catch (e) {
      if (e && (e.code === 'SQLITE_CORRUPT' || /malformed|not a database/i.test(e.message || ''))) {
        return { hits: [], degraded: true, tier: 0, takenMs: 0 };
      }
      throw e;
    }
  }

  // Low-level ranked search (id + score) over the whole corpus.
  async function search(query, opts = {}) {
    throwIfChildWarming();
    await ensureBuilt();
    const q = (query ?? '').toString();
    const { hits } = await safeBackendQuery({ text: q, topK: opts.limit ?? 10 });
    return hits;
  }

  // ── DB hydration helpers (group ranked ids back into their layer) ─────────

  async function rawRows(sql, params) {
    if (!db || typeof db.rawQuery !== 'function') return [];
    try {
      const res = await db.rawQuery(sql, params);
      return res?.results || [];
    } catch {
      return [];
    }
  }

  // Message ids are bare UUID strings (no kind prefix).
  //
  // forgotten_at IS NULL is UNCONDITIONAL (defense-in-depth: forget evicts the
  // in-RAM index, but hydration is a second read path — a forgotten row must
  // never surface here even if the index is briefly stale). `excludeSensitive`
  // additionally drops sensitive=1 rows for proactive recall (relatedTo) — §3.6.
  // A hit MUST carry what the message says, not just what its body column holds. The corpus
  // indexes a voice note's transcript alongside its message (d1-loader.js), so a query can
  // now MATCH on spoken words — and hydrating content alone would then return "File: memo.ogg"
  // as the answer to a query it matched only via the transcript. `attachment_id` is selected
  // and run through the ONE derived-text seam (src/agent/attachment-context.js), which brings
  // the four honest states, the aggregate DoS ceiling (so a 40-hit result set can't dump 40
  // full transcripts) and the recency ordering with it, rather than a second implementation.
  // contentLimit 240 matches formatMessage's snippet, so the dedup never suppresses a
  // transcript that the snippet itself cuts off (the T11a lesson).
  async function hydrateMessages(ids, { excludeSensitive = false } = {}) {
    const msgIds = ids.filter((id) => !id.includes(':'));
    if (msgIds.length === 0) return new Map();
    const placeholders = msgIds.map(() => '?').join(',');
    const sensitiveClause = excludeSensitive ? ' AND sensitive = 0' : '';
    const rows = await rawRows(
      `SELECT id, content, agent_id, created_at, attachment_id FROM messages WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL${sensitiveClause}`,
      [userId, ...msgIds],
    );
    // Fail-soft: the resolver never throws, and a db without an attachments namespace yields
    // the honest "could not be loaded" line rather than silently dropping derived text.
    const lineFor = await attachmentLineResolver(rows, { db, userId, contentLimit: 240 });
    return new Map(rows.map((r) => [String(r.id), { ...r, _attachmentLine: lineFor(r) }]));
  }

  // Profile ids in the index are kind-prefixed (`territory:1`); the DB pk is
  // the bare integer. Select only this kind's ids, strip the prefix for the IN
  // clause, then re-key the returned map by the prefixed id so partitioning in
  // bulkSearch matches the ranked hit ids exactly (no cross-table collision).
  async function hydrateProfiles(table, idCol, prefix, ids, extraCols) {
    const mine = ids.filter((id) => id.startsWith(prefix));
    if (mine.length === 0) return new Map();
    const rawIds = mine.map(stripPrefix);
    const placeholders = rawIds.map(() => '?').join(',');
    const cols = `CAST(${idCol} AS TEXT) AS id, name, essence${extraCols}`;
    const rows = await rawRows(
      `SELECT ${cols} FROM ${table} WHERE user_id = ? AND CAST(${idCol} AS TEXT) IN (${placeholders})`,
      [userId, ...rawIds],
    );
    return new Map(rows.map((r) => [prefix + String(r.id), r]));
  }

  // Documents are `document:`-prefixed in the index (bare UUIDs, but prefixed to
  // keep the message id-space clean — see d1-loader ID-namespace note). Strip the
  // prefix for the IN clause, re-key the map by the prefixed id.
  //
  // forgotten_at IS NULL and is_internal = 0 are UNCONDITIONAL (defense in depth:
  // the index may be stale until the next rebuild, but hydration is a second read
  // path — a forgotten or internal-model doc must never surface). excludeSensitive
  // additionally drops sensitive=1 rows for proactive recall (relatedTo), mirroring
  // hydrateMessages.
  async function hydrateDocuments(ids, { excludeSensitive = false } = {}) {
    const mine = ids.filter((id) => id.startsWith(ID_PREFIX.document));
    if (mine.length === 0) return new Map();
    const rawIds = mine.map(stripPrefix);
    const placeholders = rawIds.map(() => '?').join(',');
    const sensitiveClause = excludeSensitive ? ' AND sensitive = 0' : '';
    const rows = await rawRows(
      `SELECT id, path, title, summary FROM documents WHERE user_id = ? AND id IN (${placeholders}) AND forgotten_at IS NULL AND is_internal = 0${sensitiveClause}`,
      [userId, ...rawIds],
    );
    return new Map(rows.map((r) => [ID_PREFIX.document + String(r.id), r]));
  }

  /**
   * The contract method. Runs the fused tier, then partitions ranked hits into
   * the 5 mindscape layers by checking which table owns each id.
   */
  async function bulkSearch(args = {}) {
    const query = (args.query ?? '').toString();
    const limit = args.limit || 5;
    const scope = args.scope || 'all';
    const agent = args.agent || null;
    const includeTopology = !!args.includeTopology;
    const excludeSensitive = !!args.excludeSensitive; // proactive recall (relatedTo)

    const empty = {
      messages: [],
      documents: [],
      territories: { formatted: [], raw: [] },
      realms: [],
      themes: [],
    };
    if (!query.trim()) return empty;

    throwIfChildWarming();
    await ensureBuilt();

    // Over-fetch so each layer can fill up to `limit` after partitioning.
    const { hits } = await safeBackendQuery({ text: query, topK: Math.max(limit * 10, 50) });
    if (hits.length === 0) return empty;

    const ids = hits.map((h) => h.id);
    const want = (layer) => scope === 'all' || scope === layer;

    // Hydrate each layer's matching ids. The id space is shared but each row
    // exists in exactly one table, so these maps are disjoint.
    const [msgMap, docMap, terrMap, realmMap, themeMap] = await Promise.all([
      want('messages') ? hydrateMessages(ids, { excludeSensitive }) : Promise.resolve(new Map()),
      want('documents') ? hydrateDocuments(ids, { excludeSensitive }) : Promise.resolve(new Map()),
      want('territories') ? hydrateProfiles('territory_profiles', 'territory_id', ID_PREFIX.territory, ids, ', message_count') : Promise.resolve(new Map()),
      want('realms') ? hydrateProfiles('realms', 'realm_id', ID_PREFIX.realm, ids, ', message_count') : Promise.resolve(new Map()),
      want('themes') ? hydrateProfiles('semantic_themes', 'semantic_theme_id', ID_PREFIX.theme, ids, ', message_count') : Promise.resolve(new Map()),
    ]);

    const result = {
      messages: [],
      documents: [],
      territories: { formatted: [], raw: [] },
      realms: [],
      themes: [],
    };

    for (const id of ids) {
      if (result.messages.length >= limit && result.documents.length >= limit
        && result.territories.raw.length >= limit
        && result.realms.length >= limit && result.themes.length >= limit) break;

      if (msgMap.has(id)) {
        if (result.messages.length >= limit) continue;
        const m = msgMap.get(id);
        if (agent && m.agent_id && m.agent_id !== agent) continue;
        result.messages.push(formatMessage(m));
      } else if (docMap.has(id)) {
        if (result.documents.length >= limit) continue;
        result.documents.push(formatDocument(docMap.get(id)));
      } else if (terrMap.has(id)) {
        if (result.territories.raw.length >= limit) continue;
        const t = terrMap.get(id);
        result.territories.raw.push(t);
        result.territories.formatted.push(formatProfile(t));
      } else if (realmMap.has(id)) {
        if (result.realms.length >= limit) continue;
        result.realms.push(formatProfile(realmMap.get(id)));
      } else if (themeMap.has(id)) {
        if (result.themes.length >= limit) continue;
        result.themes.push(formatProfile(themeMap.get(id)));
      }
    }

    // Optional topology expansion for matched territories. t.id here is the
    // bare DB pk (hydrateProfiles selected it CAST AS TEXT, unprefixed).
    if (includeTopology && result.territories.raw.length) {
      for (const t of result.territories.raw) {
        t.topology = await coFiringNeighbors(t.id);
      }
    }

    return result;
  }

  // Co-firing neighbors for a territory via db.topology.getCoFiring. Returns
  // [{ name, weight }] for the renderer; best-effort (empty on any failure).
  async function coFiringNeighbors(territoryId) {
    const topo = db && db.topology;
    if (!topo || typeof topo.getCoFiring !== 'function') return [];
    try {
      const rows = await topo.getCoFiring({
        p_user_id: userId,
        p_territory_id: territoryId,
        p_scale: 'weekly',
        p_limit: 5,
      });
      return (Array.isArray(rows) ? rows : []).map((r) => ({
        name: r.name,
        weight: r.cofire_strength,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Read the topology profile tables directly. Returns the three layers plus
   * counts; honest empty shape when the tables are empty.
   */
  async function structure() {
    const territories = await rawRows(
      'SELECT CAST(territory_id AS TEXT) AS id, name, essence, message_count FROM territory_profiles WHERE user_id = ? AND dissolved_at IS NULL ORDER BY message_count DESC LIMIT 100',
      [userId],
    );
    const realms = await rawRows(
      'SELECT CAST(realm_id AS TEXT) AS id, name, essence, message_count FROM realms WHERE user_id = ? ORDER BY message_count DESC LIMIT 100',
      [userId],
    );
    const themes = await rawRows(
      'SELECT CAST(semantic_theme_id AS TEXT) AS id, name, essence, message_count FROM semantic_themes WHERE user_id = ? ORDER BY message_count DESC LIMIT 100',
      [userId],
    );
    return {
      territories, realms, themes,
      counts: { territories: territories.length, realms: realms.length, themes: themes.length },
    };
  }

  const helpers = {
    bulkSearch,
    search,
    structure,
    rebuild,
    warm,
    isBuilt,
    isWarming,
    // status surface for /processing-status: state + progress counts only.
    buildStatus: () => ({
      state: built ? 'built' : (buildPromise ? 'building' : 'idle'),
      backend: backendKind,
      ...(buildProgress ? { progress: { source: buildProgress.source, added: buildProgress.added } } : {}),
    }),
    // shutdown hook: SIGTERM the live build child (watermark makes it resumable).
    stopBuild: () => { try { childHandle?.stop?.(); } catch { /* already gone */ } },
    indexDocument,
    noteUpsert,
    noteDelete,
    noteVector,
    flushIncremental,
    backend: exposedBackend,
    backendKind,
    // expose isScoped for parity with the canonical searchHelpers shape
    isScoped: () => false,
  };

  // Register as the active instance for late-binding db helpers.
  setMindSearch(helpers);
  return helpers;
}

// ── Formatters (plaintext-safe; bounded snippets) ──────────────────────────

function snippet(text, n = 240) {
  return (text ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, n);
}

// D-040 ↻1: this used to SELECT the id (see the messages query above) and then DROP it,
// so a searchMindscape hit was un-addressable — the agent could see a memory it had no way
// to forget/mark/link, and guessing produced a success-shaped miss. The ref is the compact
// form (src/core/item-ref.js) precisely because it rides every rendered row.
//
// The attachment line then rides AFTER the content snippet with its own budget, so the
// 240-char snippet bounds what the HUMAN typed and can never truncate the transcript out of
// the hit (the same split getContext makes — src/tools/context.js). Both properties are
// load-bearing and independent: the ref makes the hit ADDRESSABLE, the line makes it
// TRUTHFUL — a voice note matched via its indexed transcript would otherwise be rendered as
// "File: memo.ogg" with a ref pointing at a message whose body says nothing.
function formatMessage(m) {
  const who = m.agent_id ? `[${m.agent_id}] ` : '';
  const ref = renderRef('message', m.id);
  const head = `${ref ? `${ref} ` : ''}${who}`;
  const body = snippet(m.content);
  const att = m._attachmentLine;
  if (!att) return `${head}${body}`;
  return body ? `${head}${body}\n${att}` : `${head}${att}`;
}

function formatProfile(p) {
  const count = p.message_count != null ? ` (${p.message_count} messages)` : '';
  return `**${p.name}**${count}\n${snippet(p.essence)}`;
}

// The PATH is the id `forget`/`mark` take for a document, so it must always be rendered —
// before D-040 ↻1 a titled document showed only its title and was un-addressable.
function formatDocument(d) {
  const label = d.title || d.path || '(untitled)';
  const ref = renderRef('document', d.path);
  return `**${label}**${ref ? ` ${ref}` : ''}\n${snippet(d.summary)}`;
}

// Re-exports for tests + downstream units.
export { createLocalBackend } from './backend/local.js';
export { createStubEmbedder, assertEmbedder } from './embedder.js';
export { setMindSearch, getMindSearch, clearMindSearch } from './registry.js';
export { rrf, maxRrfScore } from './fusion/rrf.js';
export { temporalBoost, temporalBoostWithProvider } from './fusion/temporal.js';
export { BM25Scorer, score as bm25Score } from './index/bm25.js';
export { InvertedIndex } from './index/inverted.js';
export { cosine, cosineUnit, topKCosine } from './ann/cosine.js';
export { tokenize, tokenizeStrings } from './index/tokenize.js';
export { loadFromDb } from './d1-loader.js';
export default createSearchHelpers;
