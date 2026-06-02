// relay-hook.js — the FRP server plugin (NewProxy/Login auth-hook). frps calls
// this on every tunnel registration; we authorize against the registry DB so a
// tenant can bind ONLY its own <handle>.mycelium.id. This is the per-tenant
// isolation gate — frps has no add-proxy API or hot-reload, so the hook IS the
// dynamic authorization path. It reads the registry LOCALLY, so reconnections do
// not depend on the provisioning API being up (availability decoupling).
//
// NewProxy content: { user:{ user, metas, run_id }, proxy_type, custom_domains,
// subdomain, ... }. Login content: { user, metas, ... }. We return frps's plugin
// response: { reject, reject_reason } | { unchange:true } | { unchange:false, content }.

/** Login: the per-tenant token (frpc metadatas.token) must map to a known handle. */
export function authorizeLogin(registry, content) {
  const token = content?.metas?.token || content?.metadatas?.token;
  if (!token) return { reject: true, reject_reason: 'missing tenant token' };
  if (!registry.getByToken(token)) return { reject: true, reject_reason: 'unknown tenant token' };
  return { unchange: true };
}

/** NewProxy: allow ONLY if the requested host(s)/subdomain == the tenant's handle. */
export function authorizeNewProxy(registry, content, { zone = 'mycelium.id', bandwidthLimit = '2MB' } = {}) {
  const token = content?.user?.metas?.token;
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

  // Allow + clamp bandwidth server-side (the tenant cannot raise its own cap).
  return { unchange: false, content: { ...content, bandwidth_limit: bandwidthLimit, bandwidth_limit_mode: 'server' } };
}

export function createRelayHook(registry, opts = {}) {
  return function relayHookHandler(req, res) {
    const body = req.body || {};
    const op = body.op || req.query?.op;
    const content = body.content || {};
    try {
      if (op === 'Login') return res.json(authorizeLogin(registry, content));
      if (op === 'NewProxy') return res.json(authorizeNewProxy(registry, content, opts));
      return res.json({ unchange: true }); // Ping/NewWorkConn/NewUserConn/CloseProxy: allow
    } catch {
      return res.json({ reject: true, reject_reason: 'hook error' });
    }
  };
}
