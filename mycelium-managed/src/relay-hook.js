// relay-hook.js — the FRP server plugin (Login/NewProxy/CloseProxy/Ping hooks).
// frps calls this on every op; we authorize against the registry so a tenant binds
// ONLY its own <handle>.mycelium.id, AND only ONE tunnel per handle is active at a
// time (a stolen token can't run a concurrent tunnel beside the legit one). It
// reads the registry LOCALLY so reconnections don't depend on the provisioning API.
//
// Per-tenant isolation rests on (a) token→handle binding, (b) host == handle, and
// (c) single-active-proxy via run_id. NewProxy/Login can reject; CloseProxy/Ping are
// notification-only (frps ignores their Reject + fires them async), so CloseProxy
// does a COMPARE-AND-CLEAR on run_id (a stale CloseProxy after a reconnect must not
// free the NEW tunnel's slot), and a TTL (refreshed by Ping) expires a crashed
// frpc's slot so the owner can re-bind.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Login: the per-tenant token (frpc metadatas.token) must map to a known handle. */
export function authorizeLogin(registry, content) {
  const token = content?.metas?.token || content?.metadatas?.token;
  if (!token) return { reject: true, reject_reason: 'missing tenant token' };
  if (!registry.getByToken(token)) return { reject: true, reject_reason: 'unknown tenant token' };
  return { unchange: true };
}

/** NewProxy: allow ONLY the tenant's own host, and only if no OTHER run_id is active. */
export function authorizeNewProxy(registry, content, { zone = 'mycelium.id', bandwidthLimit = '2MB', now = () => Date.now(), activeTtlMs = DEFAULT_TTL_MS } = {}) {
  const token = content?.user?.metas?.token;
  const runId = content?.user?.run_id;
  if (!token) return { reject: true, reject_reason: 'missing tenant token' };
  const row = registry.getByToken(token);
  if (!row) return { reject: true, reject_reason: 'unknown tenant token' };

  if (content.proxy_type && content.proxy_type !== 'https') {
    return { reject: true, reject_reason: 'only https (passthrough) proxies allowed' };
  }
  const allowedHost = `${row.handle}.${zone}`;
  const domains = Array.isArray(content.custom_domains) ? content.custom_domains : [];
  const sub = content.subdomain || '';
  if (sub && sub !== row.handle) return { reject: true, reject_reason: 'subdomain not owned' };
  for (const d of domains) {
    if (String(d).toLowerCase() !== allowedHost) return { reject: true, reject_reason: `domain ${d} not owned` };
  }
  if (!sub && domains.length === 0) return { reject: true, reject_reason: 'no host requested' };

  // Single-active-proxy: reject a SECOND concurrent tunnel (different run_id) while
  // a fresh one holds the slot; a stale slot (crashed frpc, no CloseProxy) expires.
  const t = now();
  const act = registry.getActiveProxy ? registry.getActiveProxy(row.handle) : { runId: null, at: 0 };
  if (act.runId && act.runId !== runId && (t - act.at) < activeTtlMs) {
    return { reject: true, reject_reason: 'another tunnel is already active for this handle' };
  }
  if (registry.setActiveProxy) registry.setActiveProxy(row.handle, runId, t);

  // Allow + clamp bandwidth server-side (the tenant cannot raise its own cap).
  return { unchange: false, content: { ...content, bandwidth_limit: bandwidthLimit, bandwidth_limit_mode: 'server' } };
}

/** CloseProxy (notification-only): COMPARE-AND-CLEAR the active slot on run_id. */
export function authorizeCloseProxy(registry, content) {
  const token = content?.user?.metas?.token;
  const runId = content?.user?.run_id;
  const row = token && registry.getByToken(token);
  if (row && registry.clearActiveProxyIf) registry.clearActiveProxyIf(row.handle, runId);
  return { unchange: true };
}

function refreshPing(registry, content, now) {
  const token = content?.user?.metas?.token;
  const runId = content?.user?.run_id;
  const row = token && registry.getByToken(token);
  if (row && registry.refreshActiveProxy) registry.refreshActiveProxy(row.handle, runId, now());
}

export function createRelayHook(registry, opts = {}) {
  const now = opts.now || (() => Date.now());
  return function relayHookHandler(req, res) {
    const body = req.body || {};
    const op = body.op || req.query?.op;
    const content = body.content || {};
    try {
      if (op === 'Login') return res.json(authorizeLogin(registry, content));
      if (op === 'NewProxy') return res.json(authorizeNewProxy(registry, content, { ...opts, now }));
      if (op === 'CloseProxy') return res.json(authorizeCloseProxy(registry, content));
      if (op === 'Ping') { refreshPing(registry, content, now); return res.json({ unchange: true }); }
      return res.json({ unchange: true }); // NewWorkConn/NewUserConn: allow
    } catch {
      return res.json({ reject: true, reject_reason: 'hook error' });
    }
  };
}
