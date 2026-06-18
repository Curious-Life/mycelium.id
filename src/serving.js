// Static-asset delivery for the portal SPA: precompressed serving + correct
// cache headers + dynamic response compression. Split out of server-rest.js so
// it is unit-testable (verify:serving-perf) and the security reasoning lives in
// one place.
//
// WHY THIS EXISTS — the SvelteKit build is ~4.2 MB of JS uncompressed. The build
// is configured with `precompress: true`, so a `.br` and `.gz` sibling sits next
// to every asset, but `express.static` never serves them and there is no
// compression middleware — so the WebView downloaded the full 4.2 MB on every
// cold open, and (because hashed chunks carried no Cache-Control) revalidated
// ~100 chunks on every warm open. Over Tailscale/LAN that is the multi-second
// "seconds before a page even opens". See docs/PORTAL-PERF-CONSOLIDATED-PLAN.
//
// SECURITY (CLAUDE.md §1, BREACH/CRIME): Mycelium serves a single owner over
// loopback (desktop) or Tailscale+Bearer (native app) — no untrusted
// cross-origin reflection, so a compression size-oracle is not reachable.
// Belt-and-suspenders anyway: (1) static is served from on-disk precompressed
// files (no runtime oracle); (2) dynamic compression EXCLUDES auth/token
// surfaces; (3) dynamic compression EXCLUDES Server-Sent Events (text/event-
// stream) — compressing those would also buffer/break live streaming.

import compression from 'compression';
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// Content-Encoding candidates, best ratio first. We only serve a sibling that
// (a) the client accepts and (b) actually exists on disk.
const ENCODINGS = [
  { enc: 'br', ext: '.br' },
  { enc: 'gzip', ext: '.gz' },
];

// We serve precompressed siblings ONLY for the content-hashed immutable assets.
// Those are the 4.2 MB bulk, they are safe to mark `immutable` for a year (a new
// build changes the hash → a new URL), and being immutable they never trigger a
// conditional request, so we don't need ETag/Last-Modified on the manual stream.
// Everything else (favicon, mindscape-data.json, _app/version.json, the HTML
// shell) falls through to express.static, which keeps its ETag/304 + the shell's
// no-store. version.json MUST stay revalidatable (SvelteKit polls it), so the
// strict `/_app/immutable/` prefix is deliberate.
const IMMUTABLE_PREFIX = '/_app/immutable/';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

// Explicit type table for the extensions we precompress — we cannot trust the
// `.br`/`.gz` extension of the file we stream, so the Content-Type is derived
// from the ORIGINAL asset extension.
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

// Auth/token/secret surfaces: never dynamically compressed (defence in depth
// against a token-size oracle). Matched on the request path prefix.
const NO_COMPRESS = /^\/(?:auth|oauth|\.well-known|recovery-key|api\/v1\/account|api\/v1\/remote)(?:\/|$)/;

function acceptsEncoding(header, enc) {
  // "br;q=0, gzip" etc. — treat an explicit q=0 as "not accepted".
  return String(header || '')
    .split(',')
    .map((p) => p.trim().split(';'))
    .some(([name, ...params]) => {
      if (name !== enc && name !== '*') return false;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return !q || Number(q.slice(2)) > 0;
    });
}

/**
 * Express middleware: serve the precompressed sibling of an immutable hashed
 * asset when the client accepts it. Falls through (next()) for everything else,
 * so express.static remains the single source of truth for non-immutable files,
 * range requests, and the SPA fallback.
 *
 * @param {string} buildRoot absolute path to portal-app/build
 */
export function precompressedStatic(buildRoot) {
  const root = path.resolve(buildRoot);
  return function precompressed(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let urlPath;
    try { urlPath = decodeURIComponent(req.path); } catch { return next(); }
    if (!urlPath.startsWith(IMMUTABLE_PREFIX)) return next();

    const ext = path.extname(urlPath).toLowerCase();
    const type = TYPES[ext];
    if (!type) return next();

    // Resolve within root and guard against traversal (defence in depth — the
    // immutable prefix already constrains this, but never trust the URL).
    const target = path.resolve(root, '.' + urlPath);
    if (target !== root && !target.startsWith(root + path.sep)) return next();
    if (!existsSync(target)) return next(); // unknown asset → let static 404 it

    const accept = req.headers['accept-encoding'];
    for (const { enc, ext: sx } of ENCODINGS) {
      if (!acceptsEncoding(accept, enc)) continue;
      const encoded = target + sx;
      let st;
      try { st = statSync(encoded); } catch { continue; }
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Encoding', enc);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', IMMUTABLE_CACHE);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(encoded).pipe(res);
      return;
    }
    return next(); // client took no compressed encoding → static serves raw (still immutable, see setStaticHeaders)
  };
}

/**
 * setHeaders callback for express.static. Preserves the existing rule (the SPA
 * shell must NEVER be cached, or a stale shell pins the old bundle) and ADDS the
 * immutable cache header for hashed assets so warm loads skip revalidation.
 */
export function setStaticHeaders(res, filePath) {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }
  // express.static serves from the build root, so the on-disk path contains
  // `/_app/immutable/` for hashed assets regardless of OS separator.
  const norm = filePath.split(path.sep).join('/');
  if (norm.includes(IMMUTABLE_PREFIX)) {
    res.setHeader('Cache-Control', IMMUTABLE_CACHE);
  }
}

/**
 * Express middleware: compress dynamic responses (the large /portal/* JSON
 * payloads — Mindscape aggregate, Streams feed, documents list). Excludes
 * auth/token surfaces and Server-Sent Events. Already-encoded responses (our
 * precompressed static) are skipped by `compression` itself.
 */
export function compressionMiddleware() {
  return compression({
    filter(req, res) {
      if (NO_COMPRESS.test(req.path)) return false;
      // Content-Type is set by the route by the time compression evaluates the
      // filter (on first write). Never compress SSE — it would buffer events.
      const ct = String(res.getHeader('Content-Type') || '');
      if (ct.includes('text/event-stream')) return false;
      return compression.filter(req, res); // default: only compressible types
    },
  });
}
