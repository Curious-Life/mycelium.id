// src/remote/runtime.js — render the on-disk configs the bundled sidecars consume.
//
// The remote transport (docs/REMOTE-CONNECT-TRANSPORT-DESIGN) terminates TLS on
// THIS Mac (Caddy) and reaches the relay via a passthrough reverse tunnel (frpc),
// so the relay only ever forwards ciphertext. This module renders:
//   - frpc.toml  : FRP v1 client config (reverse tunnel, type=https passthrough)
//   - Caddyfile  : terminate TLS for publicHost via ACME DNS-01 (acme-dns), proxy :4711
// Both are written 0600 (they carry the relay token + acme-dns creds). The Tauri
// shell launches `frpc -c frpc.toml` and `caddy run --config Caddyfile` (Phase F).
//
// Identical for managed and own-relay — only relayAddr/publicHost/creds differ
// (from the control-plane for managed, or the user for own-relay). Never logs.
import { writeFileSync, chmodSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_HTTP = '127.0.0.1:4711';            // the loopback --http OAuth/MCP server
const CADDY_LOCAL_PORT = 8443;                  // relay-mode local TLS listener port

/** Parse "host:port", a bare host, "[ipv6]:port", or a bare IPv6 → { host, port }. */
export function parseRelayAddr(addr, defPort = 7000) {
  const s = String(addr || '').trim();
  if (s.startsWith('[')) { // [ipv6] or [ipv6]:port
    const end = s.indexOf(']');
    if (end > 0) {
      const host = s.slice(1, end);
      const rest = s.slice(end + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : defPort;
      return { host, port: Number.isFinite(port) ? port : defPort };
    }
  }
  const colons = (s.match(/:/g) || []).length;
  if (colons !== 1) return { host: s, port: defPort }; // bare host (0) or bare IPv6 (>1)
  const i = s.indexOf(':');
  const port = Number(s.slice(i + 1));
  return { host: s.slice(0, i), port: Number.isFinite(port) ? port : defPort };
}

/**
 * FRP v1 client config (frpc.toml). type=https → frps routes by SNI and does NOT
 * terminate TLS; the local Caddy (localPort) terminates. The per-tenant token
 * rides in `metadatas.token` ONLY — the relay's Login/NewProxy plugin validates it
 * against the registry → handle. We set NO built-in `auth.token`: the relay
 * configures no fixed shared token, delegating authorization entirely to the
 * plugin (a fixed token would reject per-tenant tokens AND be a shared secret).
 */
export function renderFrpcToml({ relayAddr, publicHost, token, localPort = CADDY_LOCAL_PORT, proxyName }) {
  const { host, port } = parseRelayAddr(relayAddr);
  const name = proxyName || `mycelium-${publicHost}`;
  return [
    `serverAddr = "${host}"`,
    `serverPort = ${port}`,
    `metadatas.token = "${token}"`,
    `loginFailExit = false`,
    ``,
    `[[proxies]]`,
    `name = "${name}"`,
    `type = "https"`,
    `customDomains = ["${publicHost}"]`,
    `localIP = "127.0.0.1"`,
    `localPort = ${localPort}`,
    ``,
  ].join('\n');
}

/**
 * Caddyfile: terminate TLS for publicHost via ACME DNS-01 (caddy-dns/acmedns),
 * reverse-proxy to the loopback --http server. Relay mode listens on
 * 127.0.0.1:<localPort> (frpc forwards here); direct mode listens on public :443.
 */
export function renderCaddyfile({ publicHost, dataDir, acmeDns, mode = 'managed', localPort = CADDY_LOCAL_PORT, upstream = LOCAL_HTTP }) {
  const caddyData = join(dataDir, 'caddy');
  const direct = mode === 'direct';
  const site = direct ? publicHost : `https://${publicHost}:${localPort}`;
  const a = acmeDns || {};
  const lines = [
    `{`,
    `\tstorage file_system "${caddyData}"`,
    // No HTTP→HTTPS redirect vhost. Caddy otherwise binds http_port (:80) for
    // redirects, which the non-root Tauri app cannot — Caddy would fail to start
    // and remote-connect would silently break. We issue via DNS-01 (no :80/:443
    // ACME challenge listener needed) and the relay forwards only the HTTPS
    // stream, so a :80 redirect is dead weight here regardless.
    `\tauto_https disable_redirects`,
    `}`,
    ``,
    `${site} {`,
  ];
  if (!direct) lines.push(`\tbind 127.0.0.1`);
  lines.push(
    // Access log → stderr (captured in the app log) so a Claude connect attempt
    // is traceable at the EDGE — we can see what reaches the Mac vs only what
    // reaches the Node app, distinguishing an edge drop from an app-level result.
    `\tlog {`,
    `\t\toutput stderr`,
    `\t\tformat console`,
    `\t}`,
    `\treverse_proxy ${upstream}`,
    `\ttls {`,
    `\t\tdns acmedns {`,
    `\t\t\tusername ${a.username || ''}`,
    `\t\t\tpassword ${a.password || ''}`,
    `\t\t\tsubdomain ${a.subdomain || ''}`,
    `\t\t\tserver_url ${a.serverUrl || a.server_url || ''}`,
    `\t\t}`,
    `\t\tresolvers 1.1.1.1 8.8.8.8`,
    `\t}`,
    `}`,
    ``,
  );
  return lines.join('\n');
}

function write0600(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600); // ensure 0600 even if the file pre-existed with looser perms
  return path;
}

/**
 * Render + write the sidecar configs for the current remoteMode. Secrets are
 * passed in (the caller reads them from getRemoteSecret). Returns paths written.
 *   off       → nothing (removes stale)
 *   direct    → Caddyfile only (public :443, no relay)
 *   managed   → frpc.toml + Caddyfile (relay passthrough + local TLS)
 *   own-relay → same as managed (different relayAddr/publicHost)
 */
export function materializeRemoteConfigs({ dataDir, config, relayToken, acmeDns, localPort = CADDY_LOCAL_PORT }) {
  const wrote = [];
  const mode = config?.remoteMode || 'off';
  const frpcPath = join(dataDir, 'frpc.toml');
  const caddyPath = join(dataDir, 'Caddyfile');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  if (mode === 'off') {
    for (const p of [frpcPath, caddyPath]) { try { rmSync(p, { force: true }); } catch { /* */ } }
    return { wrote, frpcPath: null, caddyPath: null };
  }

  // Defense-in-depth: these values flow into TOML/Caddyfile grammar. Reject any
  // that could break out of a string/block (the router validates the control-plane
  // response first; this also guards against a tampered secret store).
  const UNSAFE = /[\n\r"'`{}\\]/;
  const guard = (label, v) => { if (typeof v === 'string' && UNSAFE.test(v)) throw new Error(`unsafe ${label} for config render`); };
  guard('publicHost', config.publicHost);
  guard('relayAddr', config.relayAddr);
  if (acmeDns) for (const k of ['username', 'password', 'subdomain', 'serverUrl', 'server_url']) guard(`acmeDns.${k}`, acmeDns[k]);

  // Caddy terminates TLS in every non-off mode.
  write0600(caddyPath, renderCaddyfile({ publicHost: config.publicHost, dataDir, acmeDns, mode, localPort }));
  wrote.push(caddyPath);

  // frpc only for relay modes (direct has no tunnel).
  if (mode === 'managed' || mode === 'own-relay') {
    write0600(frpcPath, renderFrpcToml({ relayAddr: config.relayAddr, publicHost: config.publicHost, token: relayToken, localPort }));
    wrote.push(frpcPath);
    return { wrote, frpcPath, caddyPath };
  }
  try { rmSync(frpcPath, { force: true }); } catch { /* */ }
  return { wrote, frpcPath: null, caddyPath };
}
