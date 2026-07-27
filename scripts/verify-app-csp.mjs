// scripts/verify-app-csp.mjs — the shipping-app CSP / security-header gate.
//
// The Tauri webview loads the REST server as a REMOTE origin (127.0.0.1:8787), so
// Tauri's compile-time CSP can't cover it — the CSP must ride the HTTP response
// (the app-sandbox hardening design, D2). This gate boots a REAL
// vault, serves the canonical built shell, and asserts on EVERY response class
// (SPA shell, SPA fallback, data 404): a CSP with `script-src 'self' 'sha256-…'`
// (≥1 hash, NO 'unsafe-inline'), framing locked, plus the companion headers — and
// that each emitted sha256 byte-matches the shell's inline scripts.
//
// PROVE IT RENDERS BEFORE ASSERTING ITS POLICY. The hash-pinning assertion
// only means something about a response that IS the app shell. When the shell 404s,
// express's finalhandler answers with its own `default-src 'none'` CSP — which
// satisfies every "is a policy present / is framing locked" check and then fails the
// four rendered-class checks. So a BROKEN SHELL was indistinguishable from a CSP
// regression, and this gate spent a session being read as one: the dot-directory
// `res.sendFile` 404 fixed in `#396` took the whole UI down and surfaced HERE as four
// policy failures. The rendered classes now assert 200 + text/html + the built entry
// bundle FIRST, so that failure names itself and stays out of the CSP's column.
// (The serving contract itself is `#396`'s to keep: `verify:serving-perf` S9 serves
// from a dot-named fixture root and S10 blocks a bare `res.sendFile` at either call
// site. Not duplicated here — this gate owns the POLICY, that one owns the SERVING.)
//
// NOTHING HERE IS HARDCODED. The server derives the CSP hashes from the shell at
// boot (server-rest.js buildPortalCsp), and this gate INDEPENDENTLY re-derives them
// from the bytes it was actually served, then proves those bytes are the on-disk
// shell. So the gate validates the RELATIONSHIP (every inline script the webview
// executes is pinned), never a frozen list — a locally built shell is self-consistent
// and green, and a shell whose inline scripts stop being pinned is red.
//
// MUTATION-TESTED: buildPortalCsp's hash loop emptied (hashes never pushed, so the
//   header degrades to plain `script-src 'self'`) → 31/34, RED on `every inline script
//   served in the shell is pinned` (0/2), the same check on the fallback, and `the CSP
//   was built from the shell that was served` (pinned=0). The rendered-class
//   `script-src includes 'self'` checks stayed GREEN — they never covered pinning.
// MUTATION-TESTED: one extra unexplained pin appended in buildPortalCsp
//   (`hashes.push("'sha256-AAA…='")`, i.e. a stale/over-broad extraction that WIDENS
//   the policy) → 33/34, RED only on `the CSP was built from the shell that was
//   served` (served=2 on-disk=2 pinned=3), with both pinning checks still green. So
//   over-pinning and under-pinning red on different checks.
// MUTATION (no-op, recorded so nobody re-runs it): widening the same regex to
//   `<script[^>]*>` (hashing `src`'d tags too) does NOT red — SvelteKit's src'd tags
//   have empty bodies, so the hash set is unchanged. Mutate the pin list, not the regex.
// MUTATION-TESTED: `sendPortalFile` (serving.js, `#396`) reverted to a bare
//   `res.sendFile(absPath)` — the defect that started this — → 21/34, RED on `shell: 200 OK`
//   (status=404) and `shell: body is the built SPA shell` plus both fallback twins and
//   every hash check, while `shell: text/html` stayed GREEN (the finalhandler 404 page
//   is html too, which is exactly why status AND body are asserted, not content-type).
//   This is the record that matters: the gate now leads with the true cause instead of
//   reporting four CSP failures for a serving bug.
// All restored afterwards; the suite returns 34/34 GO on the restored tree.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
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

// Independently recompute the expected inline-script hashes — from the bytes the
// server actually SERVED, so we prove the header carries the RIGHT hashes (not just
// "a hash") for the document the webview really executes. Same extraction the server
// does (server-rest.js buildPortalCsp), written out separately on purpose: a shared
// helper would make the two sides agree by construction and prove nothing.
const inlineHashes = (html) => {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!m[1].trim()) continue;
    out.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return out;
};
// The on-disk shell, used only to prove the served bytes ARE that shell.
const onDiskHashes = haveCanonical ? inlineHashes(readFileSync(SHELL, 'utf8')) : [];

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
  // gets the full hash-pinned policy + companion headers. The SPA fallback route
  // is ONLY registered for the canonical build (legacy portal/ is a single-file
  // SPA with spaFallback=null — server-rest.js:74), so an unknown client route
  // like /library legitimately 404s in legacy mode (finalhandler → default-src
  // 'none', already covered by the data404 class). Assert the fallback-is-shell
  // contract only when the canonical build is present (e.g. CI builds portal-app,
  // or a local build). The shell at / renders in BOTH modes, so it always asserts.
  const renderedClasses = haveCanonical ? [['shell', shell], ['fallback', fallback]] : [['shell', shell]];
  if (!haveCanonical) console.log('[—] canonical build absent — SPA-fallback (/library) checks skipped (legacy has no client-route fallback)');
  for (const [name, r] of renderedClasses) {
    // FIRST: this response must actually BE the app document. A 404 here still
    // carries a CSP (finalhandler's `default-src 'none'`), so without these three
    // checks a dead shell reds as four cryptic policy failures instead of naming
    // itself. Everything below only means something on a real document.
    ok(r.status === 200, `${name}: 200 OK`, `status=${r.status}`);
    ok(/^text\/html/.test(r.headers['content-type'] || ''), `${name}: text/html`, String(r.headers['content-type'] || 'none'));
    ok(haveCanonical
      ? /\/_app\/immutable\/entry\/start\./.test(r.body)   // canonical SvelteKit shell
      : /portal isn't built yet/i.test(r.body),            // inline placeholder (legacy mode)
      `${name}: body is the ${haveCanonical ? 'built SPA shell' : 'placeholder shell'}`, `${r.body.length}B`);
    ok(/(^|;)\s*frame-ancestors 'none'/.test(csp(r)), `${name}: explicit frame-ancestors 'none'`);
    ok(/script-src 'self'/.test(scriptSrc(r)), `${name}: script-src includes 'self'`);
    ok(r.headers['referrer-policy'] === 'strict-origin-when-cross-origin', `${name}: Referrer-Policy`);
    ok(/camera=\(\)/.test(r.headers['permissions-policy'] || ''), `${name}: Permissions-Policy`);
  }

  if (haveCanonical) {
    // THE POINT OF THIS GATE: every inline script in the document the webview
    // executes must be pinned in that document's own script-src. Derived from the
    // served body on both sides of the comparison — never a frozen list — so a
    // freshly built shell is self-consistent, and an inline script that stops being
    // pinned (or a policy that stops pinning) is the ONLY way this reds.
    for (const [name, r] of [['shell', shell], ['fallback', fallback]]) {
      const served = inlineHashes(r.body);
      const ss = scriptSrc(r);
      ok(served.length >= 1, `${name}: has ≥1 inline script to pin`, `n=${served.length}`);
      ok(served.length >= 1 && served.every((h) => ss.includes(h)),
        `every inline script served in the ${name} is pinned in its script-src`,
        `${served.filter((h) => ss.includes(h)).length}/${served.length} pinned`);
    }
    // …and the policy was built from THAT shell, not a stale/other one: the server
    // hashes portal-app/build/200.html at boot, so the served bytes must yield the
    // same hash set, and script-src must pin exactly it (no extra, unexplained hash
    // — an over-broad extraction is drift too, and would silently widen the policy).
    const servedHashes = inlineHashes(shell.body);
    const pinned = (scriptSrc(shell).match(/'sha256-[A-Za-z0-9+/=]+'/g) || []);
    ok(servedHashes.join(' ') === onDiskHashes.join(' ') && pinned.length === onDiskHashes.length,
      `the CSP was built from the shell that was served`,
      `served=${servedHashes.length} on-disk=${onDiskHashes.length} pinned=${pinned.length}`);
  } else {
    console.log('[—] canonical build absent — ran against legacy shell (hash-pinning checks skipped;');
    console.log('    CI builds portal-app before verify — .github/workflows/verify.yml, or `npm run portal:build` locally)');
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
