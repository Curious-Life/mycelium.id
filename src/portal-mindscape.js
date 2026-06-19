import express from 'express';
import { startClusteringJob, startMeasurementJob, startBackfillJob, getJob, cancelJob,
  startNarrationWalkJob, pauseNarration, resumeNarration, cancelNarration, getNarrationStatus } from './jobs.js';
import { makeNarrationRunner } from './agent/narration-runner.js';
import { getEmbedderHealth } from './embed/supervisor.js';
import { getMindscapeCached, getMindscapePointsCached } from './mindscape-cache.js';
import { isTrustedLoopback } from './http/loopback.js';

// SQLCipher-collapse backfill: the body may ONLY request these NAMED targets — never
// an arbitrary {table,column}. Fail-closed: an unknown name → 400. The engine also
// refuses `secrets` and validates identifiers; this allowlist is the outer guard.
// Extended per the collapse follow-on (embedding_768 / anchor_vector, then content).
const BACKFILL_TARGETS = {
  'clustering_points.nomic_embedding': { table: 'clustering_points', column: 'nomic_embedding', codec: { kind: 'vector', dim: 256 } },
  // Stage A 768-d vectors — every column whose writer is now flipped to raw
  // (enrich/service.js for messages; full-export-import.js vectorPass for the 4
  // profile/realm/theme tables). Readers dual-read raw + legacy envelope.
  'messages.embedding_768': { table: 'messages', column: 'embedding_768', codec: { kind: 'vector', dim: 768 } },
  'documents.embedding_768': { table: 'documents', column: 'embedding_768', codec: { kind: 'vector', dim: 768 } },
  'territory_profiles.embedding_768': { table: 'territory_profiles', column: 'embedding_768', codec: { kind: 'vector', dim: 768 } },
  'realms.embedding_768': { table: 'realms', column: 'embedding_768', codec: { kind: 'vector', dim: 768 } },
  'semantic_themes.embedding_768': { table: 'semantic_themes', column: 'embedding_768', codec: { kind: 'vector', dim: 768 } },
  // anchor_vector — compute-anchors.py now writes raw via the bridge blob param.
  // cognitive_anchor_vectors has a COMPOSITE primary key (construct, anchor_version)
  // and no `id` column, so the backfill paginates on the implicit `rowid`.
  'cognitive_anchor_vectors.anchor_vector': { table: 'cognitive_anchor_vectors', column: 'anchor_vector', codec: { kind: 'vector', dim: 768 }, pk: 'rowid' },
  // NOTE: person_claims.embedding_768 is intentionally OMITTED — its writer is
  // caller-supplied and the column is reserved/NULL today (src/claims/discovery.js);
  // migrating it without a flipped writer or active consumer adds risk for no gain.
};

/**
 * portalMindscapeRouter — the V1 read surface for the canonical portal's
 * Mindscape screen. Mounted under `/api/v1/portal` (alongside portalCompatRouter)
 * so the UI's `/portal/mindscape*` calls (rewritten by api.ts) resolve here.
 *
 * Ported faithfully from reference/server-routes/portal-mindscape-reads.js: the
 * aggregator (`GET /mindscape` → { nodes, themes, territories, realms,
 * semanticThemes, meta }) drives the 3D scene; the per-panel reads
 * (/territories, /realms, /noise-stats, /activations) drive the side panels.
 * Surfaces with NO V1 data source (fingerprint, complexity, exploration jobs,
 * phase-history, cofire, time-chronicles, social) return a graceful, benign
 * empty shape — the screen renders its empty state, never throws. Generate
 * (explore jobs) is Phase G; narrative population is Phase C.
 *
 * Backed by db.mindscape (clustering_points + *_profiles) + db.territoryDocs +
 * db.fisher — all read-only here. Same security posture as portalCompatRouter:
 * localhost-only, no auth yet (Phase 4), errors never leak internals/plaintext.
 *
 * @param {object} deps
 * @param {object} deps.db      wired db (mindscape, territoryDocs, fisher, messages…)
 * @param {string} deps.userId  the single V1 owner
 * @returns {import('express').Router}
 */
export function portalMindscapeRouter({ db, userId, dbPath }) {
  if (!db) throw new Error('portalMindscapeRouter: db required');
  const router = express.Router();
  router.use(express.json({ limit: '8mb' }));

  const fail = (res, code = 500, error = 'request failed') => res.status(code).json({ error });

  // ── JSON coercion helpers (ported verbatim from the reference aggregator) ──
  const parseArr = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
    return [];
  };
  const mapEntities = (raw) => parseArr(raw).map((e) =>
    typeof e === 'string' ? { name: e } : { name: e.text || e.name || String(e), type: e.type, count: e.count });
  const activityArray = (map) => Object.entries(map || {})
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // ── Point-derived bundle (the EXPENSIVE, DURABLY-CACHED half) ───────────────
  // Everything that comes from the 70k-row clustering_points scan: the slim 3D
  // `nodes`, the per-cluster activity maps + centroids the text panels decorate
  // themselves with, and `meta` (counts/noise/partition-confidence). Pure: depends
  // only on (points, diag), so two callers (GET /mindscape and GET
  // /mindscape/points) share ONE cached result keyed by userId. This is what stays
  // warm across narrative busts (see src/mindscape-cache.js) — points only change
  // when clustering re-runs or a point is deleted, NOT when chronicle text changes.
  function buildPointsBundle(points, diag) {
    // Slim per-point projection (F2a). Caller-audited the frontend consumers —
    // the 3D render loop (Mindscape3D.svelte:1505-1620), the click/pick handler
    // (:2135-2153), and MindscapeRealmNav (:30) read ONLY position3d, cluster3d,
    // clusterId, themeId, timestamp, and data.type. The old per-point `id` string,
    // top-level `type`, and `data.atomId` were never read → dropped to shrink the
    // ~70k-point payload (the single biggest portal response, ~17 MB). themeId IS
    // used for click-to-drill and data.type feeds the hover tooltip
    // (Mindscape3D.svelte:2084 → :2871) — both kept. The deeper 93% win is the
    // typed-array shape (F2b), which needs the render-loop refactor + a live pass.
    const nodes = points.map((p) => ({
      data: {
        type: p.source_type || 'message',
        clusterId: p.realm_id,
        cluster3d: p.territory_id,
        themeId: p.theme_id,
        position3d: { x: p.landscape_x, y: p.landscape_y, z: p.landscape_z },
        timestamp: p.created_at,
      },
    }));

    const themeActivity = {}, territoryActivity = {}, realmActivity = {};
    const territoryCentroids = {};
    const realmCounts = {}, territoryCounts = {}, realmTerritoryIds = {};
    let noiseRealm = 0, noiseTerritory = 0;
    // ONE pass over points: counts/noise run for every point; the month-bucketed
    // activity + centroids only when created_at yields a month (mirrors the prior
    // two-loop logic exactly, gated on `month` for the activity half).
    for (const p of points) {
      if (p.realm_id == null || p.realm_id === -1) noiseRealm++;
      else {
        realmCounts[p.realm_id] = (realmCounts[p.realm_id] || 0) + 1;
        if (p.territory_id != null && p.territory_id !== -1) {
          (realmTerritoryIds[p.realm_id] ||= new Set()).add(p.territory_id);
        }
      }
      if (p.territory_id == null || p.territory_id === -1) noiseTerritory++;
      else territoryCounts[p.territory_id] = (territoryCounts[p.territory_id] || 0) + 1;

      const month = p.created_at?.slice(0, 7);
      if (!month) continue;
      if (p.territory_id != null && p.theme_id != null) {
        const key = `${p.territory_id}-${p.theme_id}`;
        (themeActivity[key] ||= {})[month] = (themeActivity[key][month] || 0) + 1;
      }
      if (p.realm_id != null && p.realm_id !== -1) {
        (realmActivity[p.realm_id] ||= {})[month] = (realmActivity[p.realm_id][month] || 0) + 1;
      }
      if (p.territory_id != null && p.territory_id !== -1) {
        (territoryActivity[p.territory_id] ||= {})[month] = (territoryActivity[p.territory_id][month] || 0) + 1;
        const c = (territoryCentroids[p.territory_id] ||= { x: 0, y: 0, z: 0, count: 0 });
        c.x += p.landscape_x; c.y += p.landscape_y; c.z += p.landscape_z; c.count++;
      }
    }

    const total = points.length;
    const meta = {
      total,
      noise10d: noiseRealm, noise10dPercent: total > 0 ? (noiseRealm / total * 100).toFixed(1) : 0,
      noise3d: noiseTerritory, noise3dPercent: total > 0 ? (noiseTerritory / total * 100).toFixed(1) : 0,
      clusterCounts: realmCounts, cluster3dCounts: territoryCounts,
      // Clustering-validity confidence (METRICS-AUDIT S5). The cluster COUNTS
      // above are deterministic √n targets, not discovered — this surfaces a
      // low-confidence flag when the shipped partition is degenerate (one realm
      // >50% of points) or unstable (bootstrap ARI <0.6), rather than presenting
      // an unvalidated partition as a measurement. null until the first run that
      // computed diagnostics (pipeline/cluster.py write_clustering_diagnostics).
      partitionConfidence: diag ? {
        lowConfidence: !!diag.low_confidence,
        note: diag.confidence_note || null,
        realmMaxShare: diag.realm_max_share ?? null,
        realmCount: diag.realm_count ?? null,
        territoryValidity: diag.territory_validity ?? null,
        bootstrapAriMean: diag.bootstrap_ari_mean ?? null,
        bootstrapAriRuns: diag.bootstrap_ari_runs ?? 0,
        clusterVersion: diag.cluster_version || null,
      } : null,
    };

    return { nodes, meta, themeActivity, territoryActivity, realmActivity,
             territoryCentroids, realmCounts, realmTerritoryIds };
  }

  // Durable points cache loader — one cached bundle per user, shared by the full
  // aggregate and the points-only endpoint.
  const loadPointsBundle = () => getMindscapePointsCached(userId, async () => {
    const [pr, dr] = await Promise.allSettled([
      db.mindscape.getPoints(userId),
      db.mindscape.getClusteringDiagnostics(userId),
    ]);
    return buildPointsBundle(
      pr.status === 'fulfilled' ? pr.value : [],
      dr.status === 'fulfilled' ? dr.value : null,
    );
  });

  // ── Points-only payload (the 3D geometry) ──────────────────────────────────
  // Served from the DURABLE points cache so it stays warm across the
  // narrative/chronicle busts that constantly invalidate the full aggregate. The
  // frontend renders this FIRST (instant visuals), then loads the full /mindscape
  // for the text panels. §7: nodes/meta are plaintext (landscape coords + cluster
  // ids) — zero ciphertext, like the full aggregate's points half.
  router.get('/mindscape/points', async (_req, res) => {
    try {
      const pd = await loadPointsBundle();
      res.json({ nodes: pd.nodes, meta: pd.meta });
    } catch { fail(res, 500, 'failed to load mindscape points'); }
  });

  // ── Aggregator: the whole 3D scene in one shape ────────────────────────────
  // GET /mindscape → { nodes, themes, territories, realms, semanticThemes, meta }
  router.get('/mindscape', async (_req, res) => {
    try {
      // SWR-cached: this aggregate is a multi-second decrypting scan of the whole
      // clustering-point corpus, recomputed only when the source data changes
      // (jobs / chronicle / clustering_points deletes all bust it). See
      // src/mindscape-cache.js.
      const payload = await getMindscapeCached(userId, async () => {
      // Reuse the DURABLE points bundle (nodes + activity maps + centroids + counts
      // + meta) — the expensive 70k-row half. It survives narrative busts, so after
      // a chronicle rewrite this recompute only re-reads the cheap text profiles
      // below and re-decorates them; the geometry is served from the warm cache.
      const pd = await loadPointsBundle();
      const { nodes, meta, themeActivity, territoryActivity, realmActivity,
              territoryCentroids, realmCounts, realmTerritoryIds } = pd;
      const semanticThemeActivity = {};

      const settled = await Promise.allSettled([
        db.mindscape.getThemeCards(userId),
        db.mindscape.getTerritoryProfiles(userId),
        db.mindscape.getRealms(userId),
        db.mindscape.getSemanticThemes(userId),
      ]);
      const val = (r) => (r.status === 'fulfilled' ? r.value : []);
      const themeCards = val(settled[0]);
      const territoryProfiles = val(settled[1]);
      const realmProfiles = val(settled[2]);
      const semanticThemeProfiles = val(settled[3]);

      const themes = {};
      for (const tc of themeCards) {
        (themes[tc.territory_id] ||= {})[tc.theme_id] = {
          title: tc.title, essence: tc.essence,
          count: tc.message_count || 0, exploredCount: tc.explored_count || 0,
          exploredPercent: tc.explored_percent || 0, topEntities: mapEntities(tc.top_entities),
          storyBirth: tc.story_birth, storyArc: tc.story_arc,
          storyPeakMoments: parseArr(tc.story_peak_moments), storyCurrentChapter: tc.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(tc.uncertainty_open_questions), uncertaintyEdges: tc.uncertainty_edges,
          activity: activityArray(themeActivity[`${tc.territory_id}-${tc.theme_id}`]),
        };
      }

      const territories = {};
      for (const tp of territoryProfiles) {
        const c = territoryCentroids[tp.territory_id];
        const centroid = c && c.count > 0 ? { x: c.x / c.count, y: c.y / c.count, z: c.z / c.count } : null;
        territories[tp.territory_id] = {
          name: tp.name, essence: tp.essence,
          archetypeType: tp.archetype_type, archetypeCharacter: tp.archetype_character,
          realmId: tp.realm_id, semanticThemeId: tp.semantic_theme_id,
          count: tp.message_count || 0, exploredCount: tp.explored_count || 0, exploredPercent: tp.explored_percent || 0,
          topEntities: mapEntities(tp.top_entities), signaturePatterns: parseArr(tp.signature_patterns),
          storyBirth: tp.story_birth, storyArc: tp.story_arc,
          storyPeakMoments: parseArr(tp.story_peak_moments), storyCurrentChapter: tp.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(tp.uncertainty_open_questions), uncertaintyEdges: tp.uncertainty_edges,
          chronicle: tp.chronicle || null,
          agentExpertise: tp.agent_expertise, agentCuriousAbout: tp.agent_curious_about,
          agentCanHelpWith: parseArr(tp.agent_can_help_with), agentWouldConsult: parseArr(tp.agent_would_consult),
          activity: activityArray(territoryActivity[tp.territory_id]), centroid,
          visibility: tp.visibility || 'private', temporalSaliency: tp.temporal_saliency ?? null,
          firstActive: tp.first_active || null, lastActive: tp.last_active || null, daysActive: tp.days_active || null,
          currentVitality: tp.current_vitality ?? null, currentPhase: tp.current_phase || null,
          isAnchored: tp.is_anchored || 0,
          predecessorIds: parseArr(tp.predecessor_ids), evolvedFromCount: tp.evolved_from_count || 0,
        };
      }

      // (realmCounts / territoryCounts / realmTerritoryIds / noise now come from the
      // durable points bundle above — see buildPointsBundle.)
      const realmProfileMap = {};
      for (const rp of realmProfiles) realmProfileMap[rp.realm_id] = rp;
      const realms = {};
      // Points are the source of truth so clustering output shows even when
      // descriptions lag (mirrors the reference aggregator).
      for (const [realmId, count] of Object.entries(realmCounts)) {
        const rp = realmProfileMap[realmId] || {};
        realms[realmId] = {
          name: rp.name || null, essence: rp.essence || null,
          archetypeType: rp.archetype_type || null, archetypeCharacter: rp.archetype_character || null,
          territoryCount: (realmTerritoryIds[realmId]?.size) || rp.territory_count || 0, pointCount: count,
          topEntities: mapEntities(rp.top_entities), signaturePatterns: parseArr(rp.signature_patterns),
          storyBirth: rp.story_birth || null, storyArc: rp.story_arc || null,
          storyPeakMoments: parseArr(rp.story_peak_moments), storyCurrentChapter: rp.story_current_chapter || null,
          uncertaintyOpenQuestions: parseArr(rp.uncertainty_open_questions), uncertaintyEdges: rp.uncertainty_edges || null,
          agentExpertise: rp.agent_expertise || null, agentCuriousAbout: rp.agent_curious_about || null,
          agentCanHelpWith: parseArr(rp.agent_can_help_with), activity: activityArray(realmActivity[realmId]),
        };
      }

      for (const tp of territoryProfiles) {
        if (tp.semantic_theme_id != null && tp.realm_id != null) {
          const stKey = `${tp.realm_id}-${tp.semantic_theme_id}`;
          for (const [month, count] of Object.entries(territoryActivity[tp.territory_id] || {})) {
            (semanticThemeActivity[stKey] ||= {})[month] = (semanticThemeActivity[stKey][month] || 0) + count;
          }
        }
      }

      const semanticThemes = {};
      for (const st of semanticThemeProfiles) {
        const key = `${st.realm_id}-${st.semantic_theme_id}`;
        semanticThemes[key] = {
          realmId: st.realm_id, semanticThemeId: st.semantic_theme_id,
          name: st.name, essence: st.essence,
          territoryCount: st.territory_count || 0, messageCount: st.message_count || 0,
          territoryIds: parseArr(st.territory_ids),
          includedTerritoryCount: st.included_territory_count || st.territory_count || 0,
          coveragePercent: st.coverage_percent ?? 100.0,
          topEntities: mapEntities(st.top_entities), signaturePatterns: parseArr(st.signature_patterns),
          storyBirth: st.story_birth, storyArc: st.story_arc, storyCurrentChapter: st.story_current_chapter,
          uncertaintyOpenQuestions: parseArr(st.uncertainty_open_questions),
          activity: activityArray(semanticThemeActivity[key]),
        };
      }

      // `meta` (total / noise / clusterCounts / partitionConfidence) is part of the
      // durable points bundle — point-derived, so it travels with the geometry.
      return { nodes, themes, territories, realms, semanticThemes, meta };
      });
      res.json(payload);
    } catch { fail(res, 500, 'failed to load mindscape data'); }
  });

  // ── Per-panel reads ────────────────────────────────────────────────────────
  router.get('/mindscape/territories', async (_req, res) => {
    try { res.json({ territories: await db.mindscape.getTerritoryProfiles(userId) }); }
    catch { fail(res); }
  });

  router.get('/mindscape/realms', async (_req, res) => {
    try { res.json({ realms: await db.mindscape.getRealms(userId) }); }
    catch { fail(res); }
  });

  router.get('/mindscape/noise-stats', async (_req, res) => {
    try { res.json(await db.mindscape.getNoiseStats(userId)); }
    catch { fail(res); }
  });

  // Today's activations (which territories fired, vs. baseline). Real read.
  router.get('/mindscape/activations', async (_req, res) => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      res.json(await db.territoryDocs.getDailyActivations(userId, date));
    } catch { res.json({ active: [], silent: [], date: new Date().toISOString().slice(0, 10), total_messages: 0 }); }
  });

  // Trajectory summary — real read off db.fisher (the latest realm weekly_step).
  router.get('/trajectory/summary', async (_req, res) => {
    try {
      const row = await db.fisher.getCurrentPhase(userId, { level: 'realm' });
      res.json({ summary: row ? { phase: row.phase, exploration_ratio: row.exploration_ratio } : null });
    } catch { res.json({ summary: null }); }
  });

  // ── Graceful-empty: surfaces with NO V1 data source yet ─────────────────────
  // These are computed by Tier-2 pipeline stages (fingerprint, complexity),
  // built in later phases (explore jobs = Phase G), or belong to deferred
  // verticals (social, cofire, time-chronicles). They return benign shapes so
  // the screen renders cleanly instead of erroring. Never throw.
  router.get('/mindscape/fingerprint', (_req, res) => res.json({ fingerprint: null }));
  router.get('/mindscape/complexity', (_req, res) =>
    res.json({ global_complexity: null, globalHistory: [], territories: [], realms: [] }));
  router.get('/mindscape/exploration-status', async (_req, res) => {
    let totalTerritories = 0;
    try { totalTerritories = (await db.mindscape.getTerritoryProfiles(userId)).length; } catch { /* 0 */ }
    res.json({
      globalExploredPercent: 0, territoriesWithChronicles: 0, totalTerritories,
      totalMessages: 0, messagesAnalyzed: 0, lastRunAt: null,
      explorationRunning: false, explorationJobId: null,
    });
  });
  router.get('/mindscape/phase-history', (_req, res) => res.json({ territories: [] }));
  router.get('/mindscape/cofire', (_req, res) => res.json({ connections: [] }));
  router.get('/mindscape/time-chronicles', (_req, res) => res.json({ chronicles: [], coverage: [] }));
  router.get('/mindscape/social', (_req, res) => res.json({ contacts: [], tiers: [] }));
  // /health/summary now served by portalHealthRouter (src/portal-health.js) from
  // the real health_daily table — the empty stub that used to live here is removed.

  // Embedding progress — drives the "N of M ready" UI + the Generate preflight.
  router.get('/mycelium/processing-status', async (_req, res) => {
    // `embedder` lets the UI distinguish "still embedding" from "embedder broken,
    // here's how to fix it" — without it, a dead embedder reads as an endless
    // "Processing 0/N" spinner. Health is best-effort; never let it 500 the count.
    let embedder = { status: 'unknown', message: '', detail: null };
    try { embedder = getEmbedderHealth(); } catch { /* supervisor not running */ }
    try {
      // Single source of truth — embeddable-only counts so pending reaches 0 (PIPELINE-INTEGRITY §P1.2).
      // Polled by the UI → cached (SWR) so the multi-second at-rest scan never piles up. The Generate
      // PREFLIGHT below deliberately uses the PURE embedBacklog (a fresh count gates the run).
      const { embedded, total, pending } = await db.messages.embedBacklogCached(userId);
      res.json({ embedded, total, pending, embedder });
    } catch { res.json({ embedded: 0, total: 0, pending: 0, embedder }); }
  });

  // ── Generate the mindscape (Phase G) — spawn the clustering pipeline ────────
  // POST /mycelium/generate → { jobId, status }. Single-flight; keys re-resolved
  // at spawn into the child env (never logged/args). The real run needs the
  // Tier-2 Python stack on the host; the job lifecycle works regardless.
  router.post('/mycelium/generate', async (_req, res) => {
    try {
      // PREFLIGHT: clustering needs EMBEDDED messages (embedding_768). Without
      // them the pipeline dies cryptically — cluster.py can't resolve a user from
      // empty clustering_points and sys.exit(1)s. Count embedded vs total and
      // refuse with a clear, actionable reason instead of spawning a doomed run.
      const MIN_EMBEDDED = 5;
      let embedded = 0, total = 0;
      try {
        // Embeddable-only counts (PIPELINE-INTEGRITY §P1.2).
        ({ embedded, total } = await db.messages.embedBacklog(userId));
      } catch { /* count failed — don't block generation on a counting error */ }

      if (total === 0) {
        return res.status(409).json({
          error: 'Import some conversations first — there is nothing to map yet.',
          reason: 'no_messages', embedded: 0, total: 0,
        });
      }
      if (embedded < MIN_EMBEDDED) {
        const error = embedded === 0
          ? `Your ${total} conversations are still being processed — none are ready to map yet. This runs automatically after import; check back in a moment.`
          : `Only ${embedded} of ${total} conversations are ready to map — a few more are needed. Try again shortly.`;
        return res.status(409).json({ error, reason: 'not_embedded', embedded, total });
      }

      const r = startClusteringJob({ dbPath, userId, db });
      res.json(r);
    } catch {
      // resolveKeys/spawn unavailable — fail closed, no internals leaked.
      fail(res, 503, 'mindscape generation is unavailable (key source or pipeline not ready)');
    }
  });

  // POST /mycelium/measure → { jobId, status }. Refresh the analysis/measurement layer
  // on the EXISTING mindscape (no re-cluster, no narration) — runs even while Generate
  // is kill-switched. Same single-flight lane as generate; progress polls the same
  // /mycelium/generate/status/:id endpoint (shared job registry).
  router.post('/mycelium/measure', async (_req, res) => {
    try {
      const r = startMeasurementJob({ dbPath, userId, db });
      res.json(r);
    } catch {
      fail(res, 503, 'analysis refresh is unavailable (key source or pipeline not ready)');
    }
  });

  // POST /mycelium/backfill → { jobId, status }. SQLCipher-collapse migration: convert
  // a column's encrypted envelopes to raw/plaintext in-app. DESTRUCTIVE (rewrites vault
  // data) → gated to genuine same-host owner only (isTrustedLoopback rejects anything
  // proxied/remote, even with a valid owner Bearer — stricter than the measure surface),
  // requires confirm:true, and accepts ONLY allowlisted target names. Same single-flight
  // lane + status polling as Generate. Body: { targets: string[], confirm: true }.
  router.post('/mycelium/backfill', (req, res) => {
    if (!isTrustedLoopback(req)) return fail(res, 403, 'backfill is local-only');
    if (req.body?.confirm !== true) return fail(res, 400, 'confirm:true required');
    const names = Array.isArray(req.body?.targets) ? req.body.targets : [];
    const columns = names.map((n) => BACKFILL_TARGETS[n]).filter(Boolean);
    if (!columns.length || columns.length !== names.length) return fail(res, 400, 'unknown or empty targets');
    try {
      res.json(startBackfillJob({ db, dbPath, columns }));
    } catch {
      fail(res, 503, 'backfill is unavailable (key source not ready)');
    }
  });

  // ── Narration walk (Phase 3): UI-controlled, pausable agent narration ────────
  // Start/pause/resume/cancel + status. The walk runner is assembled per-call from
  // the keyed db (real agent runtime). The walk only does real work when a narration
  // provider is configured (else each turn no-ops, no-model) — the lifecycle works
  // regardless. content-free progress; provider is surfaced so the UI can flag cloud.
  const njson = express.json({ limit: '16kb' });

  router.post('/mycelium/narrate', njson, async (req, res) => {
    try {
      const scope = req.body?.scope ?? 'all';
      const provider = typeof req.body?.provider === 'string' ? req.body.provider : null;
      const runWalk = makeNarrationRunner({ db, userId });
      const r = await startNarrationWalkJob({ db, userId, scope, provider, runWalk });
      res.json(r);
    } catch {
      fail(res, 503, 'narration is unavailable (agent runtime or key source not ready)');
    }
  });

  router.post('/mycelium/narrate/pause', njson, async (req, res) => {
    const r = await pauseNarration({ db, runId: String(req.body?.runId || '') }).catch(() => ({ ok: false }));
    res.status(r.ok ? 200 : 409).json(r);
  });

  router.post('/mycelium/narrate/resume', njson, async (req, res) => {
    try {
      const runWalk = makeNarrationRunner({ db, userId });
      const r = await resumeNarration({ db, userId, runId: String(req.body?.runId || ''), runWalk });
      res.status(r.ok ? 200 : 409).json(r);
    } catch { fail(res, 503, 'narration runtime unavailable'); }
  });

  router.post('/mycelium/narrate/cancel', njson, async (req, res) => {
    const r = await cancelNarration({ db, runId: String(req.body?.runId || '') }).catch(() => ({ ok: false }));
    res.status(r.ok ? 200 : 409).json(r);
  });

  router.get('/mycelium/narrate/status', async (req, res) => {
    const row = await getNarrationStatus({ db, userId, runId: req.query.runId ? String(req.query.runId) : null }).catch(() => null);
    res.json({ run: row });
  });

  // GET /mycelium/generate/status/:id → progress for the polling UI.
  router.get('/mycelium/generate/status/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return fail(res, 404, 'no such job');
    res.json(job);
  });

  // POST /mycelium/generate/cancel/:id → stop a running run. Lets the user escape
  // a slow/wedged run instead of waiting out the 45-min single-flight lockout.
  router.post('/mycelium/generate/cancel/:id', (req, res) => {
    const ok = cancelJob(req.params.id);
    res.json({ canceled: ok });
  });

  return router;
}

export default portalMindscapeRouter;
