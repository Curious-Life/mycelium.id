import express from 'express';
import { startClusteringJob, startMeasurementJob, startBackfillJob, getJob, cancelJob,
  startNarrationWalkJob, pauseNarration, resumeNarration, cancelNarration, getNarrationStatus,
  startChronicleNarrationJob, startClusterNamingJob } from './jobs.js';
import { makeNarrationRunner } from './agent/narration-runner.js';
import { getEmbedderHealth } from './embed/supervisor.js';
import { getMindSearch } from './search/registry.js';
import { createReadiness } from './readiness.js';
import { getMindscapeCached, getMindscapePointsCached, bustMindscapePoints } from './mindscape-cache.js';
import { isTrustedLoopback } from './http/loopback.js';
// The naming surface's shared facts: the pipeline's OWN placeholder predicate + per-unit token
// bound (one module, no duplicated predicate/constant — II.2a/II.3), and the narrator authority
// createNarrator itself consumes (the served §4g fact, never re-derived).
import { evaluateFreshness, countMappedPoints } from './mindscape-freshness.js';
// The point-fetch cap — ONE definition, so the aggregate can distinguish "this territory has no
// points" from "the bundle was truncated before reaching it".
import { POINTS_LIMIT } from './db/mindscape.js';
import { isBundleUsable, isRenderableTerritory } from './mindscape-territory-universe.js';
import { readGenerateStats } from './generate-stats.js';
import { isPlaceholderName, perUnitTokenBound } from '../pipeline/lib/naming-facts.js';
import { resolveNarratorAuthority } from '../pipeline/lib/narrate-infer.js';

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

  // ── Stage B/C cut 1: hot-path CONTENT (documents list-cols + mindscape
  // narrative). All stopped in crypto-local.js ENCRYPTED_FIELDS (now plaintext-
  // inside-cipher); these named targets backfill the existing envelope rows so the
  // per-row decrypt disappears. A target may name MULTIPLE `columns` (same codec) —
  // expanded server-side into per-column jobs by expandBackfillTargets(); the NAME
  // still gates (fail-closed), columns are server-defined (never client-supplied).
  'content.documents': { table: 'documents', columns: ['title', 'summary', 'metadata', 'content', 'tags', 'entities', 'relations', 'entity_summary', 'source_path'], codec: { kind: 'content' } },
  'content.territory_profiles_narrative': {
    table: 'territory_profiles',
    columns: ['title', 'essence', 'story_birth', 'story_arc', 'story_peak_moments', 'story_current_chapter',
      'uncertainty_open_questions', 'agent_expertise', 'agent_curious_about', 'name', 'archetype_character',
      'top_entities', 'signature_patterns', 'agent_can_help_with', 'agent_would_consult', 'raw_response',
      'moments_of_interest', 'activity_timeline', 'chronicle', 'chronicle_cursor', 'anchored_reason',
      'description', 'description_version'],
    codec: { kind: 'content' },
  },
  'content.realms': {
    table: 'realms',
    columns: ['name', 'description', 'essence', 'archetype_character', 'top_entities', 'signature_patterns',
      'story_birth', 'story_arc', 'story_peak_moments', 'story_current_chapter', 'uncertainty_open_questions',
      'uncertainty_edges', 'agent_expertise', 'agent_curious_about', 'agent_can_help_with', 'activity_timeline'],
    codec: { kind: 'content' },
  },
  'content.semantic_themes': {
    table: 'semantic_themes',
    columns: ['label', 'keywords', 'description', 'name', 'essence', 'top_entities', 'signature_patterns',
      'story_birth', 'story_arc', 'story_current_chapter', 'uncertainty_open_questions', 'raw_response'],
    codec: { kind: 'content' },
  },
  'content.theme_cards': { table: 'theme_cards', columns: ['title', 'description', 'content', 'metadata'], codec: { kind: 'content' } },

  // ── Stage B/C cut 2: topology metrics (territory_profiles scalars + centroids,
  // territory_cofire / neighbors / vitality). All stopped in ENCRYPTED_FIELDS;
  // backfill to plaintext. Centroids are JSON (read by JS cosine via JSON.parse) →
  // content codec, NOT the raw-bytes vector codec. The topology.js SQL restore
  // lands only AFTER these reach 0 envelopes live (ordering law).
  'content.territory_profiles_scalars': {
    table: 'territory_profiles',
    columns: ['energy', 'coherence', 'velocity', 'current_vitality', 'point_delta', 'centroid_256', 'centroid_3d'],
    codec: { kind: 'content' },
  },
  'content.territory_cofire': { table: 'territory_cofire', columns: ['cofire_immediate', 'cofire_session', 'cofire_daily', 'cofire_weekly'], codec: { kind: 'content' } },
  'content.territory_neighbors': { table: 'territory_neighbors', columns: ['distance', 'shared_entities'], codec: { kind: 'content' } },
  'content.territory_vitality': {
    table: 'territory_vitality',
    columns: ['entropy_diversification', 'connection_growth_rate', 'reach', 'cofire_partner_diversity', 'engagement_depth_normalized', 'vitality'],
    codec: { kind: 'content' },
  },

  // ── Stage B/C cut 3: claims + people. All stopped in ENCRYPTED_FIELDS (JS-adapter-
  // written); backfill the existing envelope rows to plaintext. person_claims.
  // embedding_768 is NOT here (NEVER_AUTO_DECRYPT vector, reserved/NULL). The people
  // UNIQUE(user_id,name) migration + ON CONFLICT restore land after this backfill.
  'content.people': {
    table: 'people',
    columns: ['name', 'aliases', 'description', 'metadata', 'email', 'phone', 'company', 'position', 'linkedin_url', 'notes', 'avatar_url'],
    codec: { kind: 'content' },
  },
  'content.person_claims': { table: 'person_claims', columns: ['claim_type', 'content', 'confidence_logodds', 'decay_class', 'support'], codec: { kind: 'content' } },
  'content.person_claim_snapshots': { table: 'person_claim_snapshots', columns: ['confidence_logodds', 'content', 'evidence_count', 'delta_kind'], codec: { kind: 'content' } },

  // ── Stage B/C cut 4: bulk content (messages + the long tail). All stopped in
  // ENCRYPTED_FIELDS (every table JS-adapter-written, ZERO Python caller-encrypt —
  // verified). messages.content is the LARGEST backfill. Credentials collapse too
  // (ai_providers/connectors/scheduled_tasks): the field DEK is wrapped by the same
  // USER_MASTER that opens the whole file → field-encryption adds zero protection
  // over SQLCipher (only `secrets`, on the separate SYSTEM_KEY, stays encrypted).
  // Column lists mirror the pre-collapse ENCRYPTED_FIELDS entries verbatim.
  'content.messages': { table: 'messages', columns: ['content', 'thinking', 'tags', 'entities', 'entity_summary', 'suggested_new_tag', 'relations', 'metadata', 'nlp_error'], codec: { kind: 'content' } },
  'content.facts': { table: 'facts', columns: ['value'], codec: { kind: 'content' } },
  'content.entities': { table: 'entities', columns: ['name', 'aliases', 'summary'], codec: { kind: 'content' } },
  'content.attachments': { table: 'attachments', columns: ['transcript', 'file_name', 'description', 'metadata'], codec: { kind: 'content' } },
  'content.clustering_points_content': { table: 'clustering_points', columns: ['content'], codec: { kind: 'content' } },
  'content.territory_river_cache': { table: 'territory_river_cache', columns: ['payload'], codec: { kind: 'content' } },
  'content.agent_events': { table: 'agent_events', columns: ['payload'], codec: { kind: 'content' } },
  'content.agent_tasks': { table: 'agent_tasks', columns: ['context', 'result', 'description', 'summary', 'error'], codec: { kind: 'content' } },
  'content.agent_customizations': { table: 'agent_customizations', columns: ['system_prompt', 'settings', 'tools_config'], codec: { kind: 'content' } },
  'content.internal_model_items': { table: 'internal_model_items', columns: ['content', 'metadata'], codec: { kind: 'content' } },
  'content.reflections': { table: 'reflections', columns: ['content', 'trigger', 'metadata'], codec: { kind: 'content' } },
  'content.tasks': { table: 'tasks', columns: ['title', 'description', 'notes', 'metadata'], codec: { kind: 'content' } },
  'content.folders': { table: 'folders', columns: ['name', 'description', 'metadata'], codec: { kind: 'content' } },
  'content.note_links': { table: 'note_links', columns: ['description', 'metadata'], codec: { kind: 'content' } },
  'content.entity_snapshots': { table: 'entity_snapshots', columns: ['payload'], codec: { kind: 'content' } },
  'content.activity_sessions': { table: 'activity_sessions', columns: ['window_title', 'url', 'app_bundle', 'app_name'], codec: { kind: 'content' } },
  'content.health_daily': {
    table: 'health_daily',
    columns: ['sleep_duration_min', 'sleep_in_bed_min', 'sleep_efficiency', 'sleep_deep_min', 'sleep_rem_min',
      'sleep_core_min', 'sleep_awake_min', 'sleep_start', 'sleep_end', 'hrv_avg', 'hrv_sleep_avg', 'resting_hr',
      'steps', 'active_energy_kcal', 'workout_count', 'workout_minutes', 'workout_types', 'mindful_minutes'],
    codec: { kind: 'content' },
  },
  'content.wealth_transactions': { table: 'wealth_transactions', columns: ['notes', 'quantity', 'price_per_unit', 'fees', 'exchange_rate'], codec: { kind: 'content' } },
  'content.wealth_positions': { table: 'wealth_positions', columns: ['total_cost', 'current_value', 'unrealized_pnl', 'avg_cost_basis', 'quantity'], codec: { kind: 'content' } },
  'content.wealth_snapshots': { table: 'wealth_snapshots', columns: ['total_value', 'total_invested', 'total_pnl', 'day_change'], codec: { kind: 'content' } },
  'content.wealth_accounts': { table: 'wealth_accounts', columns: ['name', 'institution', 'account_number_last4', 'notes', 'metadata'], codec: { kind: 'content' } },
  'content.wealth_assets': { table: 'wealth_assets', columns: ['custom_name', 'notes', 'metadata'], codec: { kind: 'content' } },
  'content.wealth_wallets': { table: 'wealth_wallets', columns: ['label', 'address', 'notes', 'metadata'], codec: { kind: 'content' } },
  'content.wealth_watchlist': { table: 'wealth_watchlist', columns: ['notes'], codec: { kind: 'content' } },
  'content.wealth_portfolios': { table: 'wealth_portfolios', columns: ['name', 'description', 'notes', 'metadata'], codec: { kind: 'content' } },
  'content.time_chronicles': { table: 'time_chronicles', columns: ['theme', 'narrative', 'key_moments', 'top_territories', 'top_contacts', 'top_agents', 'cross_references', 'voice_sample', 'raw_response'], codec: { kind: 'content' } },
  'content.current_arc_chronicles': { table: 'current_arc_chronicles', columns: ['theme', 'narrative', 'raw_response'], codec: { kind: 'content' } },
  'content.contact_chronicles': { table: 'contact_chronicles', columns: ['narrative', 'summary', 'metadata'], codec: { kind: 'content' } },
  'content.territory_pass_notes': { table: 'territory_pass_notes', columns: ['note', 'entities_mentioned', 'metadata'], codec: { kind: 'content' } },
  'content.space_rooms': { table: 'space_rooms', columns: ['name', 'essence'], codec: { kind: 'content' } },
  'content.space_knowledge': { table: 'space_knowledge', columns: ['content', 'domain_tags'], codec: { kind: 'content' } },
  'content.share_links': { table: 'share_links', columns: ['invited_email'], codec: { kind: 'content' } },
  'content.user_identities': { table: 'user_identities', columns: ['provider_username', 'provider_id', 'provider_avatar'], codec: { kind: 'content' } },
  'content.provisioning_jobs': { table: 'provisioning_jobs', columns: ['email', 'stripe_customer_id', 'error'], codec: { kind: 'content' } },
  'content.ai_providers': { table: 'ai_providers', columns: ['credentials'], codec: { kind: 'content' } },
  'content.channel_access': { table: 'channel_access', columns: ['allowed_senders_json'], codec: { kind: 'content' } },
  'content.connectors': { table: 'connectors', columns: ['account_label', 'last_error', 'recent_runs'], codec: { kind: 'content' } },
  'content.scheduled_tasks': { table: 'scheduled_tasks', columns: ['prompt'], codec: { kind: 'content' } },
  'content.conversation_summaries': { table: 'conversation_summaries', columns: ['summary'], codec: { kind: 'content' } },
  'content.peer_messages': { table: 'peer_messages', columns: ['content'], codec: { kind: 'content' } },
  'content.sharing_contexts': { table: 'sharing_contexts', columns: ['summary'], codec: { kind: 'content' } },
  'content.inbound_shares': { table: 'inbound_shares', columns: ['name'], codec: { kind: 'content' } },

  // ── Stage B/C cut 6: the *_versions + reflection_records tables (collapsed in the
  // ENCRYPTED_FIELDS finalize) + cognitive_events. These are APPEND-ONLY (version
  // history / emitted events), so existing envelope rows are NOT overwritten by a later
  // write — they need a backfill target to convert. The recomputed metric tables
  // (cognitive_metrics_*, frequency/complexity/topology/embedding_trajectory/fisher_*)
  // self-convert to plaintext on the next measurement run, so they need no target.
  'content.document_versions': { table: 'document_versions', columns: ['title', 'summary', 'content', 'snapshot_json'], codec: { kind: 'content' } },
  'content.fact_versions': { table: 'fact_versions', columns: ['value'], codec: { kind: 'content' } },
  'content.entity_versions': { table: 'entity_versions', columns: ['name', 'aliases', 'summary'], codec: { kind: 'content' } },
  'content.reflection_records': { table: 'reflection_records', columns: ['summary', 'themes', 'day_type', 'body'], codec: { kind: 'content' } },
  'content.cognitive_events': { table: 'cognitive_events', columns: ['magnitude', 'detail', 'headline'], codec: { kind: 'content' } },
};

/**
 * Resolve client-requested backfill target NAMES against the server allowlist,
 * expanding any multi-`columns` entry into per-column job specs. Fail-closed: an
 * unknown name yields `{ ok: false }` and NO columns (the whole request is
 * rejected). Columns are always server-defined (from BACKFILL_TARGETS) — never
 * taken from the request body.
 * @param {string[]} names
 * @param {Record<string, object>} [targets]
 * @returns {{ ok: boolean, columns: Array<{table:string, column:string, codec:object, pk?:string}> }}
 */
export function expandBackfillTargets(names, targets = BACKFILL_TARGETS) {
  if (!Array.isArray(names) || names.length === 0) return { ok: false, columns: [] };
  const columns = [];
  for (const n of names) {
    const t = targets[n];
    if (!t) return { ok: false, columns: [] }; // unknown name → reject the whole request
    const cols = Array.isArray(t.columns) ? t.columns : [t.column];
    for (const column of cols) columns.push({ table: t.table, column, codec: t.codec, ...(t.pk ? { pk: t.pk } : {}) });
  }
  return { ok: columns.length > 0, columns };
}

/**
 * portalMindscapeRouter — the V1 read surface for the canonical portal's
 * Mindscape screen. Mounted under `/api/v1/portal` (alongside portalCompatRouter)
 * so the UI's `/portal/mindscape*` calls (rewritten by api.ts) resolve here.
 *
 * Ported faithfully from the canonical portal route: the
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
export function portalMindscapeRouter({ db, userId, dbPath, readiness: injected }) {
  // The ONE readiness model (src/readiness.js). Injected by server-rest so a single
  // instance (and a single warm cache) serves every consumer; built here as a fallback
  // so tests/verify scripts that mount this router alone still work.
  const readiness = injected || createReadiness({ db, userId, embedderHealth: getEmbedderHealth });
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
  router.get('/mindscape/points', async (req, res) => {
    try {
      // ?refresh=1 → force-recompute (P1-A). The durable points cache can hold an EMPTY bundle
      // (a read that raced clustering, or a pre-generation read on a then-empty vault) for its
      // 5-min TTL, so a plain client retry hit the same stale-empty result and "Try again" looked
      // dead. Busting before the read guarantees a fresh scan — the retry can never be defeated by
      // a stale cache. Owner-only single-user portal, so refresh spam is self-throttled; the bust
      // is idempotent + cheap (it also busts the full aggregate, keeping the two caches coherent).
      if (req.query?.refresh) bustMindscapePoints(userId);
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

      // ── ONE TERRITORY UNIVERSE (QA9: "naming territories still get territory 1089 as the names")
      // Three code paths asked "which territories exist?" and the RENDERER disagreed with the other
      // two:
      //   naming-status (the count)   DISTINCT territory_id FROM clustering_points   :786-792
      //   describe-clusters (writer)  DISTINCT territory_id FROM clustering_points   :214-217
      //   HERE (the renderer)         territory_profiles WHERE dissolved_at IS NULL  — NO join
      // So a profile row that is not dissolved but has no surviving points was RENDERED, never
      // visited by the naming job, and never counted. It showed as "Territory {id}" forever while
      // the naming card truthfully reported "all named" — both statements true, about different
      // sets. (The operator's id, 1089, is far larger than their ~50 areas: an orphan from an
      // earlier clustering generation.)
      //
      // ⚠️ NOT fixed in cluster.py, and that was my first plan. cluster.py ALREADY dissolves
      // point-less territories (:1951-1970) — but it DEFERS the whole prune whenever a re-embed
      // backlog exists (:1946-1950), deliberately, so a re-import window cannot dissolve a
      // territory whose points are transiently absent. On a vault that is importing, that
      // deferral can hold indefinitely. Dissolution is therefore correct AND permanently
      // incomplete; the renderer cannot rely on it.
      //
      // Nor can such a territory be NAMED instead: describe-clusters samples its members from
      // clustering_points, so a territory with no points has nothing to describe. It is not a
      // place on the map — it has no geometry, no members and no content.
      //
      // ⇒ The renderer requires live mapped points, measured from the SAME bundle it is about to
      // render (`territoryCentroids[tid].count`, built from getPoints which is already
      // `landscape_x IS NOT NULL`). No second query, so no cache-coherence gap by construction.
      //
      // TWO GUARDS, both §3.2a — an absent bundle must never DELETE the user's areas:
      //   · empty bundle  → we cannot tell "no map" from "failed read" ⇒ do not filter
      //   · truncated bundle (points hit POINTS_LIMIT) → a territory may be absent only because
      //     the fetch stopped ⇒ do not filter
      // The two predicates live in src/mindscape-territory-universe.js as PURE FUNCTIONS, so the
      // gate can drive them directly. Inlined here they could only be gated by string-matching this
      // file — and a gate that pins a string REDs on a harmless refactor while proving nothing.
      const bundleUsable = isBundleUsable(territoryCentroids, meta?.total, POINTS_LIMIT);
      let orphanedTerritories = 0;

      const territories = {};
      for (const tp of territoryProfiles) {
        const c = territoryCentroids[tp.territory_id];
        if (!isRenderableTerritory(c, bundleUsable)) { orphanedTerritories++; continue; }
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
          gravity: tp.gravity ?? null, gravityShare: tp.gravity_share ?? null,
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
          exploredPercent: rp.explored_percent || 0,
          topEntities: mapEntities(rp.top_entities), signaturePatterns: parseArr(rp.signature_patterns),
          storyBirth: rp.story_birth || null, storyArc: rp.story_arc || null,
          storyPeakMoments: parseArr(rp.story_peak_moments), storyCurrentChapter: rp.story_current_chapter || null,
          uncertaintyOpenQuestions: parseArr(rp.uncertainty_open_questions), uncertaintyEdges: rp.uncertainty_edges || null,
          agentExpertise: rp.agent_expertise || null, agentCuriousAbout: rp.agent_curious_about || null,
          agentCanHelpWith: parseArr(rp.agent_can_help_with), activity: activityArray(realmActivity[realmId]),
          gravity: rp.gravity ?? null, gravityShare: rp.gravity_share ?? null,
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
      // `orphanedTerritories` is DIAGNOSTIC, and it is exposed rather than dropped on purpose:
      // this filter removes rows a user could previously see, so the count of what it removed must
      // be observable. A silent filter is how "0 conversations ready · 1014 on the map" happened.
      return { nodes, themes, territories, realms, semanticThemes,
               meta: { ...meta, orphanedTerritories, territoryUniverseFiltered: bundleUsable } };
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

  // GET /mindscape/coverage → fresh %-described rollup for territories/themes/realms.
  // Computed live from territory_profiles so it never drifts from the cascaded columns.
  router.get('/mindscape/coverage', async (_req, res) => {
    try { res.json(await db.mindscape.coverageSummary(userId)); }
    catch { fail(res, 500, 'failed to compute coverage'); }
  });

  // Noise stats are point-derived (total + territory-noise) and are already
  // computed in the durable points bundle — serve from there instead of a second
  // full COUNT scan of the 70k-row clustering_points corpus on every Mindscape
  // open. db.mindscape.getNoiseStats is kept for the MCP onboarding probe
  // (src/mcp.js), which has no bundle in scope. Shape is identical.
  router.get('/mindscape/noise-stats', async (_req, res) => {
    try {
      const { meta } = await loadPointsBundle();
      res.json({
        total: meta.total,
        noise: meta.noise3d,
        noisePct: meta.total > 0 ? (meta.noise3d / meta.total * 100).toFixed(1) : '0',
      });
    } catch { fail(res); }
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
    // Search-corpus build state (built|building|idle + progress counts). Before
    // this field the multi-minute rebuild was invisible — the app just looked
    // dead. Additive; older clients ignore it. Registry-sourced: no plumbing.
    let searchIndex = null;
    try { searchIndex = getMindSearch()?.buildStatus?.() || null; } catch { /* helpers absent */ }
    try {
      // Delegates to the ONE readiness model. Cached slice — this endpoint is POLLED, and
      // the pure scan is a multi-second SQLCipher decrypt (the /generate preflight below is
      // the only caller allowed to pay it).
      //
      // ⚠️ `unknown` is the whole point of this rewrite. This catch used to return
      // `{ total: 0 }` on a counting failure, and generate.ts turns `total === 0` into
      // "Import some conversations first — there is nothing to map yet." So a SQLITE_BUSY
      // on a 70k-message vault told the owner their vault was EMPTY. Fixing only the
      // preflight left this second copy of the same lie one HTTP hop away — the client
      // ignores the preflight's 409 reason and polls here (independent review, 2026-07-15).
      // A counting error now reports `unknown: true` with the counts OMITTED: a client
      // cannot read a zero that was never measured.
      const { data, canGenerate } = await readiness.get({ slices: ['data'] });
      if (canGenerate.reason === 'unknown') return res.json({ unknown: true, embedder, ...(searchIndex ? { searchIndex } : {}) });
      // `unprocessable`: content-bearing rows neither embedded nor queued (blank-skip /
      // awaiting-L2). A COUNT only — a per-message failure reason is not progress data.
      res.json({ embedded: data.embedded, total: data.total, pending: data.pending, unprocessable: data.unprocessable, embedder, ...(searchIndex ? { searchIndex } : {}) });
    } catch { res.json({ unknown: true, embedder, ...(searchIndex ? { searchIndex } : {}) }); }
  });

  // GET /mycelium/map-status → { embedded, mapped, drift, driftPct, stale, basis, built }
  // POINT-COUNT HONESTY as a FIRST-CLASS STATE (defect D-004, symptom 1: "i have 2510 points
  // byt the mycelium and map that is shown ... only has 369 points"). Before this, the
  // embedded-vs-mapped gap existed nowhere in the product: it could only be inferred by
  // POSTing generate and reading a note buried in a skip response — which the user could
  // neither trigger deliberately nor act on. A number the user can see about their own vault
  // must be a served fact with its own route, not a side effect of trying to start a job.
  //
  // COST: the CACHED readiness slice (never getFresh — this is a mount/poll surface, and the
  // fresh scan is the multi-second SQLCipher decrypt reserved for the /generate preflight)
  // plus ONE indexed COUNT over clustering_points.
  //
  // `unknown` rather than zeros on a counting failure — the §3.2a rule this file already
  // enforces twice above: a failed COUNT must never impersonate an empty vault, or the UI
  // would tell a user with a full map that nothing is mapped and offer them a rebuild.
  router.get('/mycelium/map-status', async (_req, res) => {
    try {
      const { data } = await readiness.get({ slices: ['data'] });
      if (data?.unknown) return res.json({ unknown: true });
      const mapped = await countMappedPoints(db, userId);
      const stats = readGenerateStats();
      res.json({
        ...evaluateFreshness({
          embedded: data.embedded,
          mapped,
          builtAtEmbedded: stats?.lastEmbedded ?? null,
        }),
        builtAt: stats?.at ?? null,
      });
    } catch { res.json({ unknown: true }); }
  });

  // ── Generate the mindscape (Phase G) — spawn the clustering pipeline ────────
  // POST /mycelium/generate → { jobId, status }. Single-flight; keys re-resolved
  // at spawn into the child env (never logged/args). The real run needs the
  // Tier-2 Python stack on the host; the job lifecycle works regardless.
  router.post('/mycelium/generate', async (_req, res) => {
    try {
      // PREFLIGHT: clustering needs EMBEDDED messages (embedding_768). Without
      // them the pipeline dies cryptically — cluster.py can't resolve a user from
      // empty clustering_points and sys.exit(1)s. Refuse with a clear, actionable
      // reason instead of spawning a doomed run.
      //
      // Delegates to the ONE readiness model — the >=5 threshold is encoded there and
      // nowhere else. It used to live here AND be contradicted by every client, which
      // said `messageCount > 0`: the UI thought it was ready and this 409'd it.
      // getFresh() is deliberate — a PURE count gates the run (this is the only caller
      // that may pay the multi-second scan; everything else rides the SWR cache).
      //
      // ⚠️ FIXED HERE: the old code caught the count error and then blocked on the very
      // next line (`if (total === 0)`), so a COUNTING FAILURE told the user their full
      // vault was empty ("Import some conversations first"). Its own comment claimed it
      // did "not block generation on a counting error" — it did. `unknown` now exists so
      // the gate stays fail-closed while the MESSAGE stays honest.
      const { data: rd, canGenerate } = await readiness.getFresh({ slices: ['data'] });
      const embedded = rd.embedded, total = rd.total;

      if (!canGenerate.ok && canGenerate.reason === 'unknown') {
        return res.status(409).json({
          error: "Couldn't check whether your messages are ready to map — try again in a moment.",
          reason: 'unknown', embedded, total,
        });
      }
      if (!canGenerate.ok && canGenerate.reason === 'no_messages') {
        return res.status(409).json({
          error: 'Import some conversations first — there is nothing to map yet.',
          reason: 'no_messages', embedded: 0, total: 0,
        });
      }
      if (!canGenerate.ok && canGenerate.reason === 'not_embedded') {
        const error = embedded === 0
          ? `Your ${total} conversations are still being processed — none are ready to map yet. This runs automatically after import; check back in a moment.`
          : `Only ${embedded} of ${total} conversations are ready to map — a few more are needed. Try again shortly.`;
        return res.status(409).json({ error, reason: 'not_embedded', embedded, total });
      }

      // ── STALENESS-AWARE DEBOUNCE (defect D-004 ↻1) ────────────────────────────────
      // The debounce EXISTS FOR A REAL REASON and is preserved: the mindscape view
      // auto-POSTs generate on every load (MindscapeView.svelte's autoGen effect), so an
      // unconditional rebuild re-clusters the full set on every app launch and blanks the
      // map for minutes (the points cache doesn't recover cleanly mid-run). What it lacked
      // was an UPPER BOUND: the old predicate skipped whenever ANY point row existed, with
      // no staleness condition, so once a map existed it could never catch up. The operator
      // ran 2510 embedded messages against a 369-point map and was told "Map already built;
      // pass ?force=1 to rebuild" — a query parameter no user can type.
      //
      // Now the skip is conditional on the map being FRESH (src/mindscape-freshness.js owns
      // the predicate — one definition, shared with GET /mycelium/map-status and the gate).
      // A STALE map falls through and rebuilds: that IS the auto-rebuild-past-a-drift-
      // threshold requirement, because this route is what the view already calls on load.
      // It self-terminates — the run records a new baseline, drift returns to 0, and every
      // subsequent load skips again exactly as before.
      //
      // ⚠️ The counts are NOT re-queried: `embedded` above came from readiness.getFresh(),
      // a multi-second SQLCipher scan this route is the only caller allowed to pay. Reusing
      // it keeps this fix at ONE extra indexed COUNT (the point count).
      let freshness = null;
      try {
        freshness = evaluateFreshness({
          embedded,
          mapped: await countMappedPoints(db, userId),
          builtAtEmbedded: readGenerateStats()?.lastEmbedded ?? null,
        });
      } catch { /* counting failed — fall through and generate (unchanged fail-open) */ }

      if (!_req.query?.force && freshness?.built && !freshness.stale) {
        // The counts ride the skip response so the client can render the honest state
        // ("2,510 embedded · 2,498 on the map") instead of a bare "already built" note.
        return res.json({
          jobId: null, status: 'skipped', reason: 'topology_fresh',
          note: 'Your map is up to date.',
          map: freshness,
        });
      }

      const r = startClusteringJob({ dbPath, userId, db });
      // Reverse writer-guard (jobs.js): a bulk delete is emptying clustering_points
      // right now, so a run would stabilize ids against a torn membership. Honest,
      // actionable, and content-free.
      if (r?.status === 'delete_running') {
        return res.status(409).json({ jobId: null, status: 'delete_running', note: 'A delete is running — wait for it to finish, then Generate.' });
      }
      res.json(r);
    } catch {
      // resolveKeys/spawn unavailable — fail closed, no internals leaked.
      fail(res, 503, 'mindscape generation is unavailable (key source or pipeline not ready)');
    }
  });

  // POST /mycelium/describe-more  body { territoryId? } → deepen narration coverage WITHOUT
  // re-clustering. Spawns describe-chronicles.js as a CHILD (single-flight via the job's
  // chronicleChildRunning guard) — NEVER the in-process narration-walk (that pegged the
  // event loop + white-screened the app). No body = global pass (all under-covered
  // territories, fold in unseen); { territoryId } = that one territory + its rollup.
  // Progress streams to the unified activity feed (kind 'describe:chronicle'); poll /activity.
  router.post('/mycelium/describe-more', async (req, res) => {
    try {
      const raw = req.body?.territoryId;
      const territoryId = raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
      const r = startChronicleNarrationJob({ dbPath, userId, territoryId });
      if (!r || r.pid == null) return res.json({ status: 'busy', note: 'A describe pass is already running.' });
      res.json({ status: 'running', pid: r.pid, scope: territoryId == null ? 'all' : 'territory', territoryId });
    } catch {
      fail(res, 503, 'describe-more is unavailable (key source or pipeline not ready)');
    }
  });

  // POST /mycelium/name-clusters → { status } — the ONE reachable trigger for cluster NAMING.
  // Spawns startClusterNamingJob → pipeline/describe-clusters.js (the only writer of realm/
  // territory name+essence) in gap-fill mode: name every unnamed/placeholder cluster, preserve
  // real names. This is what makes "Illuminate" stop being a dead button — describe-clusters was
  // reachable only inside Generate's step 3/16, which the /generate debounce skips whenever
  // topology exists, so an unnamed realm on a built map could never be named
  // (DISTILLATION-SURFACE-DESIGN §3/§3a). Single-flight via the job; progress + consent refusals
  // stream to the unified activity feed (kind 'describe:name' → "Naming clusters"); poll /activity.
  // NOT named /mycelium/distil (§3a's placeholder): `distil` is reserved for the full distillation
  // SURFACE (§5.5, blocked by §7 Q1-Q4) whose "Distil more" button posts describe-more — a
  // different act. A dedicated, unambiguous route avoids overloading that word (naming ≠ describing,
  // §1a). Model routing is the pipeline's own §4g-safe createNarrator path — nothing wired here.
  router.post('/mycelium/name-clusters', async (_req, res) => {
    try {
      const r = startClusterNamingJob({ dbPath, userId });
      if (r?.status === 'disk_low') return res.json({ status: 'disk_low', detail: r.detail || null });
      if (!r || r.pid == null) return res.json({ status: 'busy', note: 'A naming pass is already running.' });
      res.json({ status: 'running', pid: r.pid });
    } catch {
      fail(res, 503, 'cluster naming is unavailable (key source or pipeline not ready)');
    }
  });

  // GET /mycelium/naming-status → { areas, forecast, narrator } — the SERVED vault-fact for the
  // Illuminate run surface (INTELLIGENCE-SCREEN-REDESIGN Part II, II.2a/II.4). ONE owner for
  // "percent named": counts computed HERE with the PIPELINE'S OWN placeholder predicate
  // (pipeline/lib/naming-facts.js#isPlaceholderName — shared import, so the route and the job
  // can never disagree about what "unnamed" means; the portal client's realm-only copy is
  // display fallback, never a count). The universe is EXACTLY the set the naming job walks
  // (describe-clusters.js): DISTINCT realm ids + DISTINCT territory ids from clustering_points.
  //
  // forecast: units × the served per-unit token BOUND (capped by construction — II.3). A bound,
  // not a middle estimate; the client renders it "up to ~" and NEVER sums it with spent.
  // narrator: the §4g authority createNarrator itself computes (resolveNarratorAuthority —
  // same file, same computation), so "with X on this Mac — nothing leaves" can't drift from
  // what a run would do. Content-free (§1): counts + identifiers only; never runs the sampler,
  // never reads messages.content. Fetched per mount/gesture — NEVER polled, NEVER a readiness
  // slice (the C1 cost contract: the counts are two indexed aggregates, but the rule is the rule).
  router.get('/mycelium/naming-status', async (_req, res) => {
    try {
      const q = (sql, p = []) => db.rawQuery(sql, p).then((r) => (Array.isArray(r) ? r : r.results || []));
      const realmRows = await q(
        `SELECT DISTINCT cp.realm_id AS id, r.name AS name
           FROM clustering_points cp
           LEFT JOIN realms r ON r.user_id = cp.user_id AND r.realm_id = cp.realm_id
          WHERE cp.user_id = ? AND cp.realm_id IS NOT NULL`,
        [userId],
      );
      const terrRows = await q(
        `SELECT DISTINCT cp.territory_id AS id, tp.name AS name
           FROM clustering_points cp
           LEFT JOIN territory_profiles tp ON tp.user_id = cp.user_id AND tp.territory_id = cp.territory_id
          WHERE cp.user_id = ? AND cp.territory_id IS NOT NULL`,
        [userId],
      );
      const total = realmRows.length + terrRows.length;
      const unnamed = [...realmRows, ...terrRows].filter((row) => isPlaceholderName(row.name)).length;
      const bound = perUnitTokenBound();
      const auth = await resolveNarratorAuthority({ db, userId });
      res.json({
        areas: { total, named: total - unnamed, unnamed },
        forecast: { perUnitTokenBound: bound, expectedTokensBound: unnamed * bound },
        narrator: {
          ready: !auth.blocked,
          label: auth.label,
          model: auth.model,
          local: auth.isLocal,
          jurisdiction: auth.jurisdiction,
        },
      });
    } catch {
      fail(res, 503, 'naming status is unavailable');
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
    const { ok, columns } = expandBackfillTargets(names);
    if (!ok) return fail(res, 400, 'unknown or empty targets');
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
      // ⚠️ NO `provider` FROM THE BODY. It used to store req.body.provider verbatim, and the UI
      // regex-matched that DISPLAY NAME to decide whether to tell the user "content leaves this
      // machine" — so the client named the fact the UI then reported back as sovereignty. It was
      // never a fact about the run either: the walk resolves its provider server-side per turn
      // (run-turn → resolve.js), so the string had no connection to the wire. The run now records
      // where the content ACTUALLY went, observed per turn — see makeDeviceTally in jobs.js.
      const runWalk = makeNarrationRunner({ db, userId });
      const r = await startNarrationWalkJob({ db, userId, scope, runWalk });
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
