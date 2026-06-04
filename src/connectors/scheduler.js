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
const nowIso = () => new Date().toISOString();

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
        lastError: st.lastError || null,
        itemsLastSync: st.itemsLastSync ?? null,
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
    if (running.has(id) && !force) return { ok: false, error: 'already_running' };

    running.add(id);
    try {
      await store.patchState(id, { status: 'syncing', lastError: null });
      let tokens = await store.getTokens(id);
      if (adapter.ensureFreshToken && tokens) {
        const fresh = await adapter.ensureFreshToken(tokens, { db, userId });
        if (fresh && fresh.access_token !== tokens.access_token) { await store.setTokens(id, fresh); tokens = fresh; }
      }
      const { items = [], nextCursor } = await adapter.pull({ db, userId, tokens, store }, { cursor: state.cursor });
      let created = 0; let deduped = 0;
      for (const item of items.slice(0, MAX_ITEMS_PER_SYNC)) {
        const { deduped: d } = await captureMessage(db, { userId, role: 'user', ...item }, enqueueEnrichment);
        if (d) deduped += 1; else created += 1;
      }
      if (items.length > MAX_ITEMS_PER_SYNC) {
        console.warn(`[connectors] ${id}: pulled ${items.length} items, capped at ${MAX_ITEMS_PER_SYNC} this pass`);
      }
      const patch = {
        status: 'connected', lastSyncAt: nowIso(), lastError: null,
        cursor: nextCursor ?? state.cursor, itemsLastSync: items.length,
      };
      await store.patchState(id, patch);
      return { ok: true, pulled: items.length, created, deduped, cursor: patch.cursor };
    } catch (e) {
      await store.patchState(id, { status: 'error', lastError: String(e?.message || e).slice(0, 200) });
      return { ok: false, error: String(e?.message || e) };
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
        await runner.runSync(id).catch(() => { /* runSync already records lastError */ });
      }
    } catch { /* never throw out of the timer */ }
  }

  // First tick after an interval (don't hammer providers on every boot).
  timer = setInterval(cycle, intervalMs);
  if (timer.unref) timer.unref();

  return { runner, cycle, stop() { stopped = true; if (timer) clearInterval(timer); } };
}
