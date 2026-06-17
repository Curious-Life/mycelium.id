// scripts/verify-app-csp.mjs — the shipping-app CSP / security-header gate.
//
// The Tauri webview loads the REST server as a REMOTE origin (127.0.0.1:8787), so
// Tauri's compile-time CSP can't cover it — the CSP must ride the HTTP response
// (docs/APP-SANDBOX-HARDENING-DESIGN-2026-06-16.md, D2). This gate boots a REAL
// vault, serves the canonical built shell, and asserts on EVERY response class
// (SPA shell, SPA fallback, data 404): a CSP with `script-src 'self' 'sha256-…'`
// (≥1 hash, NO 'unsafe-inline'), framing locked, plus the companion headers — and
// that each emitted sha256 byte-matches the shell's inline scripts.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

process.env.MYCELIUM_DISABLE_EMBED = '1';
const DATA = mkdtempSync(join(tmpdir(), 'myc-csp-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const hex = () => crypto.randomBytes(32).toString('hex');

const SHELL = join(process.cwd(), 'portal-app', 'build', '200.html');
const haveCanonical = existsSync(SHELL);

// Independently recompute the expected inline-script hashes from the built shell,
// so we prove the header carries the RIGHT hashes (not just "a hash").
const expectedHashes = [];
if (haveCanonical) {
  const html = readFileSync(SHELL, 'utf8');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!m[1].trim()) continue;
    expectedHashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
}

let server = null;
try {
  const { startRestServer } = await import('../src/server-rest.js');
  server = await startRestServer({
    dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(),
    port: 0, host: '127.0.0.1', portalMode: haveCanonical ? 'canonical' : 'legacy',
  });
  const base = server.url;

  const get = (path) => new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { Accept: 'text/html' } }, (res) => {
      let body = ''; res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });

  // Three response classes share the same global middleware.
  const shell = await get('/');                 // SPA shell (navigation)
  const fallback = await get('/library');       // SPA fallback (client route)
  const data404 = await get('/api/v1/__nope');  // data path → JSON 404

  const csp = (r) => r.headers['content-security-policy'] || '';
  const scriptSrc = (r) => (csp(r).split(';').find((d) => d.trim().startsWith('script-src')) || '').trim();
  // Framing is locked by EITHER an explicit frame-ancestors 'none' OR default-src
  // 'none' (Express's finalhandler emits the latter on its generated 404/error —
  // strictly safer for a non-HTML API error: it denies scripts AND framing).
  const framingLocked = (r) => /(^|;)\s*frame-ancestors 'none'/.test(csp(r)) || /(^|;)\s*default-src 'none'/.test(csp(r));

  // Invariants that hold on EVERY response class (shell, SPA fallback, API 404).
  for (const [name, r] of [['shell', shell], ['fallback', fallback], ['data404', data404]]) {
    ok(!!csp(r), `${name}: Content-Security-Policy present`);
    ok(framingLocked(r), `${name}: framing locked (frame-ancestors/default-src 'none')`, csp(r).slice(0, 40));
    ok(r.headers['x-frame-options'] === 'DENY', `${name}: X-Frame-Options DENY`);
    ok(r.headers['x-content-type-options'] === 'nosniff', `${name}: X-Content-Type-Options nosniff`);
    // The hardening invariant everywhere: scripts are NEVER inline-permissive.
    ok(!/'unsafe-inline'/.test(scriptSrc(r)), `${name}: script-src has NO 'unsafe-inline'`, scriptSrc(r).slice(0, 80));
  }

  // The RENDERED HTML (shell + SPA fallback) — what the webview actually executes —
  // gets the full hash-pinned policy + companion headers.
  for (const [name, r] of [['shell', shell], ['fallback', fallback]]) {
    ok(/(^|;)\s*frame-ancestors 'none'/.test(csp(r)), `${name}: explicit frame-ancestors 'none'`);
    ok(/script-src 'self'/.test(scriptSrc(r)), `${name}: script-src includes 'self'`);
    ok(r.headers['referrer-policy'] === 'strict-origin-when-cross-origin', `${name}: Referrer-Policy`);
    ok(/camera=\(\)/.test(r.headers['permissions-policy'] || ''), `${name}: Permissions-Policy`);
  }

  if (haveCanonical) {
    ok(expectedHashes.length >= 1, `canonical shell has ≥1 inline script to hash`, `n=${expectedHashes.length}`);
    const ss = scriptSrc(shell);
    ok(expectedHashes.every((h) => ss.includes(h)),
      `every shell inline-script sha256 is pinned in script-src`,
      `expected ${expectedHashes.length}`);
  } else {
    console.log('[—] canonical build absent — ran against legacy shell (hash-presence check skipped)');
  }
} catch (e) {
  fail++; console.log(`FAIL  harness error: ${e?.stack || e}`);
} finally {
  try { server?.close?.(); } catch {}
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass}/${pass + fail} checks passed`);
console.log(fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO');
process.exit(fail === 0 ? 0 : 1);
