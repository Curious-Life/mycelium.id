// Connector runner + in-process sync scheduler.
//
// The runner owns the connect/callback/sync/disconnect/status logic and is
// shared by the HTTP routes (manual actions) and the scheduler (periodic pull).
// The scheduler is a setInterval timer modelled on the enrichment drainer
// (src/enrich/drainer.js) — started in completeBoot, gated to the real app.
//
// All pulled items flow through captureMessage (the one path to the mindscape):
// deterministic per-item ids ⇒ idempotent re-sync. A cursor in the connector
// state drives incremental pulls.

import { captureMessage } from '../ingest/capture.js';
import { getAdapter, listAdapters } from './registry.js';
import { createConnectorStore } from './store.js';
import { createPkce, createState, buildAuthUrl, exchangeCode } from './oauth.js';

const MAX_ITEMS_PER_SYNC = 500;
const MAX_RECENT_RUNS = 10;   // per-connector run log kept in :state (audit-lite)
const MAX_BACKOFF_SHIFT = 4;  // a persistently-idle connector backs off to base × 2^4 = 16×
const DEFAULT_DAILY_ITEM_LIMIT = 2000; // cost backstop per connector per UTC day (beyond the per-pass cap)
const nowIso = () => new Date().toISOString();
const todayUtc = () => nowIso().slice(0, 10);

/** Per-connection daily item budget (env-overridable; non-positive/invalid → default). */
export function dailyItemLimit() {
  const n = Number(process.env.MYCELIUM_CONNECTOR_DAILY_ITEMS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_ITEM_LIMIT;
}

/**
 * When a connector is next due for a periodic sync. A connector whose recent
 * pulls came back empty (idleStreak) backs off from the base interval up to 16×
 * so the scheduler stops hammering sources that never have anything new. Pure +
 * exported for the verify. idleStreak 0 ⇒ due at base cadence.
 */
export function connectorDueAt(state, baseMs) {
  const last = state?.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
  const shift = Math.min(Math.max(Number(state?.idleStreak) || 0, 0), MAX_BACKOFF_SHIFT);
  return last + baseMs * (2 ** shift);
}

export function createConnectorRunner({ db, userId, enqueueEnrichment }) {
  const store = createConnectorStore({ db, userId });
  const running = new Set(); // single-flight per connector id

  /** Public, leak-safe status for every registered adapter. */
  async function status() {
    const out = [];
    for (const a of listAdapters()) {
      const st = (await store.getState(a.id)) || {};
      out.push({
        id: a.id, label: a.label, provider: a.provider, oauth: Boolean(a.oauth),
        status: st.status || 'disconnected',
        connectedAt: st.connectedAt || null,
        lastSyncAt: st.lastSyncAt || null,
        lastOkAt: st.lastOkAt || null,
        lastError: st.lastError || null,
        lastErrorAt: st.lastErrorAt || null,
        itemsLastSync: st.itemsLastSync ?? null,
        itemsCreated: st.itemsCreated ?? null,
        itemsUpdated: st.itemsUpdated ?? null,
        itemsDeduped: st.itemsDeduped ?? null,
        idleStreak: st.idleStreak ?? 0,
        budgetDate: st.budgetDate || null,
        itemsToday: st.budgetDate === todayUtc() ? (st.itemsToday ?? 0) : 0,
        dailyItemLimit: dailyItemLimit(),
        lastRun: st.lastRun || null,
        recentRuns: Array.isArray(st.recentRuns) ? st.recentRuns : [],
      });
    }
    return out;
  }

  /** Start a connection. OAuth adapters return { authUrl }; others connect now. */
  async function connect(id, body = {}) {
    const adapter = getAdapter(id);
    if (!adapter) return { ok: false, error: 'unknown_adapter' };

    if (!adapter.oauth) {
      // Non-OAuth (mock/local): store a token directly and mark connected.
      const token = typeof body.token === 'string' && body.token ? body.token : `local-${id}`;
      await store.setTokens(id, { access_token: token, refresh_token: null, token_type: 'Bearer', scope: null, expires_at: null });
      await store.setState(id, { status: 'connected', cursor: null, connectedAt: nowIso(), lastSyncAt: null, lastError: null });
      return { ok: true, status: 'connected' };
    }

    const cfg = adapter.resolveOAuthConfig ? await adapter.resolveOAuthConfig({ db, userId }) : adapter.oauth;
    if (!cfg?.clientId) return { ok: false, error: 'oauth_not_configured' };
    const pkce = cfg.usePKCE === false ? null : createPkce();
    const oauthState = createState();
    // pkceVerifier + oauthState live in the encrypted state, never surfaced.
    await store.setState(id, { status: 'connecting', cursor: null, oauthState, pkceVerifier: pkce?.verifier || null, lastError: null });
    const authUrl = buildAuthUrl({
      authUrl: cfg.authUrl, clientId: cfg.clientId, redirectUri: cfg.redirectUri,
      scopes: cfg.scopes, state: oauthState, codeChallenge: pkce?.challenge,
      extraParams: cfg.extraAuthParams || {},
    });
    return { ok: true, status: 'connecting', authUrl };
  }

  /** OAuth redirect handler: exchange code → store tokens → connected. */
  async function handleCallback(id, { code, state } = {}) {
    const adapter = getAdapter(id);
    if (!adapter?.oauth) return { ok: false, error: 'not_oauth' };
    if (!code) return { ok: false, error: 'missing_code' };
    const st = await store.getState(id);
    if (!st || !st.oauthState || st.oauthState !== state) return { ok: false, error: 'state_mismatch' };
    const cfg = adapter.resolveOAuthConfig ? await adapter.resolveOAuthConfig({ db, userId }) : adapter.oauth;
    const tokens = await exchangeCode({
      tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri, code, codeVerifier: st.pkceVerifier || undefined,
    });
    await store.setTokens(id, tokens);
    await store.setState(id, { status: 'connected', cursor: null, connectedAt: nowIso(), lastSyncAt: null, lastError: null });
    return { ok: true, status: 'connected' };
  }

  /** Tear down: best-effort revoke, then delete tokens + state. */
  async function disconnect(id) {
    const adapter = getAdapter(id);
    if (adapter?.revoke) {
      try { const t = await store.getTokens(id); if (t) await adapter.revoke(t); } catch { /* best-effort */ }
    }
    await store.remove(id);
    return { ok: true, status: 'disconnected' };
  }

  /** One sync pass for a connector: refresh → pull → captureMessage → cursor. */
  async function runSync(id, { force = false } = {}) {
    const adapter = getAdapter(id);
    if (!adapter) return { ok: false, error: 'unknown_adapter' };
    const state = await store.getState(id);
    if (!state || state.status === 'disconnected') return { ok: false, error: 'not_connected' };
    // Single-flight is UNCONDITIONAL — even a manual/force sync must not run a
    // second concurrent pass for the same connector (it would race the cursor and
    // clobber state via patchState's read-merge-write). `force` only means
    // "ignore idle-backoff", which is a cycle() concern, not a runSync one.
    void force;
    if (running.has(id)) return { ok: false, error: 'already_running' };

    running.add(id);
    const startedMs = Date.now();
    try {
      // Daily-budget rollover + gate — a cost backstop for big backfills, on top
      // of the per-pass MAX_ITEMS_PER_SYNC. itemsToday resets on a UTC date change.
      const today = todayUtc();
      const limit = dailyItemLimit();
      let itemsToday = state.budgetDate === today ? (Number(state.itemsToday) || 0) : 0;
      if (itemsToday >= limit) {
        // Spent for today → skip the pull entirely and back off; resume tomorrow.
        const at = nowIso();
        const run = { at, ok: true, skipped: 'daily_budget', pulled: 0, durationMs: Date.now() - startedMs };
        const recentRuns = [run, ...(Array.isArray(state.recentRuns) ? state.recentRuns : [])].slice(0, MAX_RECENT_RUNS);
        await store.patchState(id, {
          status: 'connected', lastError: null, budgetDate: today, itemsToday,
          idleStreak: (Number(state.idleStreak) || 0) + 1, lastRun: run, recentRuns,
        });
        return { ok: true, pulled: 0, created: 0, updated: 0, deduped: 0, skipped: 'daily_budget' };
      }

      await store.patchState(id, { status: 'syncing', lastError: null });
      let tokens = await store.getTokens(id);
      if (adapter.ensureFreshToken && tokens) {
        const fresh = await adapter.ensureFreshToken(tokens, { db, userId });
        if (fresh && fresh.access_token !== tokens.access_token) { await store.setTokens(id, fresh); tokens = fresh; }
      }
      const { items = [], nextCursor } = await adapter.pull({ db, userId, tokens, store }, { cursor: state.cursor });
      let created = 0; let updated = 0; let deduped = 0;
      for (const item of items.slice(0, MAX_ITEMS_PER_SYNC)) {
        const r = await captureMessage(db, { userId, role: 'user', ...item }, enqueueEnrichment);
        if (r.updated) updated += 1; else if (r.deduped) deduped += 1; else created += 1;
      }
      if (items.length > MAX_ITEMS_PER_SYNC) {
        console.warn(`[connectors] ${id}: pulled ${items.length} items, capped at ${MAX_ITEMS_PER_SYNC} this pass`);
      }
      itemsToday += items.length; // count toward today's budget (provider-fetch cost)
      const finishedAt = nowIso();
      const run = { at: finishedAt, ok: true, pulled: items.length, created, updated, deduped, durationMs: Date.now() - startedMs };
      const recentRuns = [run, ...(Array.isArray(state.recentRuns) ? state.recentRuns : [])].slice(0, MAX_RECENT_RUNS);
      // Idle-backoff input: back off when a pull yields NO NET-NEW info (empty OR
      // all-deduped) — many adapters re-return the same recent window every pull,
      // so keying on items.length would never back off. A real create/update
      // resets the streak. See connectorDueAt.
      const idle = created === 0 && updated === 0;
      const idleStreak = idle ? (Number(state.idleStreak) || 0) + 1 : 0;
      const patch = {
        status: 'connected', lastSyncAt: finishedAt, lastOkAt: finishedAt, lastError: null, lastErrorAt: null,
        cursor: nextCursor ?? state.cursor,
        itemsLastSync: items.length, itemsCreated: created, itemsUpdated: updated, itemsDeduped: deduped,
        budgetDate: today, itemsToday,
        idleStreak, lastRun: run, recentRuns,
      };
      await store.patchState(id, patch);
      return { ok: true, pulled: items.length, created, updated, deduped, cursor: patch.cursor };
    } catch (e) {
      const message = String(e?.message || e).slice(0, 200);
      const at = nowIso();
      const cur = (await store.getState(id)) || {};
      const run = { at, ok: false, error: message, durationMs: Date.now() - startedMs };
      const recentRuns = [run, ...(Array.isArray(cur.recentRuns) ? cur.recentRuns : [])].slice(0, MAX_RECENT_RUNS);
      await store.patchState(id, { status: 'error', lastError: message, lastErrorAt: at, lastRun: run, recentRuns });
      return { ok: false, error: message };
    } finally {
      running.delete(id);
    }
  }

  return { status, connect, handleCallback, disconnect, runSync, store };
}

/**
 * Periodic scheduler — drains every connected connector on an interval. Mirrors
 * the enrichment drainer's lifecycle. Pass an existing runner so the HTTP routes
 * and the timer share single-flight state.
 */
export function startConnectorScheduler({ runner, intervalMs = 5 * 60 * 1000 }) {
  if (!runner) throw new TypeError('startConnectorScheduler: runner required');
  let timer = null;
  let stopped = false;

  async function cycle() {
    if (stopped) return;
    try {
      const ids = await runner.store.listIds();
      for (const id of ids) {
        const st = await runner.store.getState(id);
        if (!st || st.status === 'disconnected' || st.status === 'connecting') continue;
        // Idle-backoff: skip a connector whose recent pulls were empty until its
        // widened interval elapses. idleStreak 0 ⇒ always due (base cadence);
        // errored connectors are always retried.
        if (st.status === 'connected' && (Number(st.idleStreak) || 0) >= 1 && Date.now() < connectorDueAt(st, intervalMs)) continue;
        await runner.runSync(id).catch(() => { /* runSync already records lastError */ });
      }
    } catch { /* never throw out of the timer */ }
  }

  // First tick after an interval (don't hammer providers on every boot).
  timer = setInterval(cycle, intervalMs);
  if (timer.unref) timer.unref();

  return { runner, cycle, stop() { stopped = true; if (timer) clearInterval(timer); } };
}
