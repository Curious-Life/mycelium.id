// verify:subscription-validity — "connected" must mean VALID (2026-07-18).
//
// THE BUG THIS GATES AGAINST: the Intelligence surface said "Claude subscription ·
// connected" while the stored OAuth credential had been expired-beyond-refresh for FOUR
// DAYS (every native request 401'd; the proactive refresher logged "unavailable" every
// tick). "Connected" was derived from stored-creds-EXIST. And the inverse lie is real too:
// the same day, chat (the spawned Claude Code engine, its own credential store) WORKED
// while the native wire was dead — so a blanket "dead" would be wrong for chat.
//
// WHAT THIS ASSERTS (identity of the derived state, never call counts):
//   V1  the PURE truth table of deriveSubscriptionValidity — including the tie, which the
//       evidence-recency mutation (> → >=) flips
//   V2  the per-surface projection: refresh evidence feeds 'native' ONLY (the CLI child may
//       ride the machine login), and the chat-alive/channel-dead state derives as a SPLIT
//   V3  GET /portal/auth/claude/status carries `validity` FROM EVIDENCE — a probe that says
//       the credential LOOKS fine does not override newer failure evidence
//   V4  POST /portal/auth/claude/refresh: outcome mirrors the actual refresh result and
//       validity re-derives from it — a route that claims 'refreshed' on a failed refresh
//       reds here
//   V5  ZERO token material on the wire: canary tokens threaded through the stored creds
//       AND through the refresher's return value must not appear in any response body
//
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import express from 'express';
import {
  deriveSubscriptionValidity,
  getSubscriptionAuthValidity,
  recordSubscriptionRefreshOutcome,
  recordSubscriptionTurnOutcome,
  _resetSubscriptionAuthSignalForTests as reset,
} from '../src/inference/subscription-auth-signal.js';
import { portalProvidersRouter } from '../src/portal-providers.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const t = async (n, fn) => { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

// ── V1: the pure truth table ───────────────────────────────────────────────────────────────
await t('V1. ⭐ the derivation truth table — fail-closed at every edge, including the TIE', () => {
  const D = deriveSubscriptionValidity;
  // no creds → not_connected (regardless of stale evidence lying around)
  assert.equal(D({ credsPresent: false }), 'not_connected');
  assert.equal(D({ credsPresent: false, okAt: 100 }), 'not_connected');
  // creds + zero evidence → unknown (cold boot must NOT read as connected)
  assert.equal(D({ credsPresent: true }), 'unknown');
  // ok@T1, fail@T2>T1 → needs_reconnect (the live 4-day case: old refresh ok, newer 401s)
  assert.equal(D({ credsPresent: true, okAt: 100, failAt: 200 }), 'needs_reconnect');
  // fail@T1, ok@T2>T1 → ok (recovered: newer positive evidence wins)
  assert.equal(D({ credsPresent: true, okAt: 200, failAt: 100 }), 'ok');
  // only failures → needs_reconnect; only successes → ok
  assert.equal(D({ credsPresent: true, failAt: 100 }), 'needs_reconnect');
  assert.equal(D({ credsPresent: true, okAt: 100 }), 'ok');
  // ⭐ THE TIE: equal timestamps must NOT claim ok — 'ok' requires evidence STRICTLY newer
  // than the newest failure. Flipping > to >= (the recency mutation) reds exactly here.
  assert.equal(D({ credsPresent: true, okAt: 100, failAt: 100 }), 'needs_reconnect',
    'a tie is not positive evidence that postdates the failure — fail closed');
});

// ── V2: per-surface projection over the real module state ─────────────────────────────────
await t('V2. ⭐ per-surface: refresh evidence feeds NATIVE only; chat-alive/channel-dead derives as a SPLIT', () => {
  reset();
  // The live mismatch, reconstructed: the native store's refresh fails at T1, then a CLI
  // (Claude Code engine) turn succeeds at T2 on ITS OWN login.
  recordSubscriptionRefreshOutcome(false, 1000);
  recordSubscriptionTurnOutcome(true, { surface: 'cli', now: 2000 });
  assert.deepEqual(getSubscriptionAuthValidity({ credsPresent: true }),
    { native: 'needs_reconnect', cli: 'ok' },
    'chat works AND channels are dead — both surfaces must carry their own truth');
  // The CLI success must NOT vouch for the native wire (different credential store)…
  reset();
  recordSubscriptionTurnOutcome(true, { surface: 'cli', now: 1000 });
  assert.equal(getSubscriptionAuthValidity({ credsPresent: true }).native, 'unknown',
    'a CLI success is not native evidence — native stays unknown, never ok');
  // …and refresh outcomes must NOT damn the CLI (it may ride the machine login).
  reset();
  recordSubscriptionRefreshOutcome(false, 1000);
  assert.equal(getSubscriptionAuthValidity({ credsPresent: true }).cli, 'unknown',
    'a failed config-dir refresh says nothing about the CLI child\'s own login');
  // Native recovery: a 401 turn, then a SUCCESSFUL refresh → ok again.
  reset();
  recordSubscriptionTurnOutcome(false, { surface: 'native', now: 1000 });
  recordSubscriptionRefreshOutcome(true, 2000);
  assert.equal(getSubscriptionAuthValidity({ credsPresent: true }).native, 'ok');
  // An unknown surface label is DROPPED, not misfiled.
  reset();
  recordSubscriptionTurnOutcome(true, { surface: 'bogus', now: 1000 });
  assert.deepEqual(getSubscriptionAuthValidity({ credsPresent: true }), { native: 'unknown', cli: 'unknown' });
});

// ── the route harness: real router, stub DAL, injected probe/refresher ────────────────────
const CANARY_STORED = 'sk-ant-oat01-CANARY-STORED-TOKEN-000000000000';
const CANARY_REFRESH = 'sk-ant-oat01-CANARY-REFRESH-TOKEN-1111111111';
const SUB_ROW = { id: 7, provider: 'anthropic', label: 'Claude subscription', auth_type: 'oauth', is_active: 1, model_preference: 'claude-opus-4-8' };
const makeDb = (rows) => ({
  providers: {
    list: async () => rows,
    get: async (id) => (rows.find((r) => r.id === id)
      ? { ...rows.find((r) => r.id === id), credentials: JSON.stringify({ accessToken: CANARY_STORED, refreshToken: CANARY_STORED, account: { email: 'x@example.test' } }) }
      : null),
  },
});
// The probe DELIBERATELY says the credential LOOKS fine — evidence must still win.
const probeFound = async () => ({ status: 'found', expired: false, source: 'config-dir-file', creds: { expiresAt: 1234567890 }, declinedSources: [] });

async function serve(router) {
  const app = express(); app.use(express.json()); app.use('/portal', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}/portal`, close: () => srv.close() };
}

let refreshResult = null;   // what the injected refresher yields next
let refreshCalls = 0;
const router = portalProvidersRouter({
  db: makeDb([SUB_ROW]),
  userId: 'u1',
  probeCredential: probeFound,
  refreshToken: async ({ force } = {}) => { refreshCalls++; assert.equal(force, true, 'the owner click must bypass the cooldown'); return refreshResult; },
});
const { base, close } = await serve(router);

await t('V3. ⭐ /auth/claude/status: `validity` derives from EVIDENCE — a healthy-LOOKING probe does not override newer failures', async () => {
  reset();
  recordSubscriptionRefreshOutcome(true, 1000);
  recordSubscriptionTurnOutcome(false, { surface: 'native', now: 2000 });   // 401 newer than the last good refresh
  const j = await (await fetch(`${base}/auth/claude/status`)).json();
  assert.equal(j.ok, true);
  assert.equal(j.health, 'connected', 'fixture sanity: the probe half still reports what the credential LOOKS like');
  assert.equal(j.validity?.native, 'needs_reconnect',
    'requests are FAILING — validity must say so even while the stored bytes look plausible');
  assert.equal(j.validity?.cli, 'unknown', 'no CLI evidence ⇒ unknown, never a borrowed verdict');
  // Cold module state ⇒ unknown, never connected.
  reset();
  const cold = await (await fetch(`${base}/auth/claude/status`)).json();
  assert.deepEqual(cold.validity, { native: 'unknown', cli: 'unknown' });
});

await t('V4. ⭐ /auth/claude/refresh: outcome mirrors the ACTUAL result; validity re-derives from this attempt', async () => {
  // Success: validity flips to ok (evidence newer than the old failure).
  reset();
  recordSubscriptionTurnOutcome(false, { surface: 'native', now: Date.now() - 60_000 });
  refreshResult = CANARY_REFRESH;
  let j = await (await fetch(`${base}/auth/claude/refresh`, { method: 'POST' })).json();
  assert.equal(j.ok, true);
  assert.equal(j.outcome, 'refreshed');
  assert.equal(j.validity?.native, 'ok', 'a successful refresh is positive evidence — the row may go green again');
  // Failure: outcome 'unavailable' and validity must NOT claim ok — the route-claims-ok
  // mutation (outcome hardcoded / recording inverted) reds on these two lines.
  reset();
  refreshResult = null;
  j = await (await fetch(`${base}/auth/claude/refresh`, { method: 'POST' })).json();
  assert.equal(j.outcome, 'unavailable', 'a failed refresh must never be reported as refreshed');
  assert.equal(j.validity?.native, 'needs_reconnect', 'and the failed attempt itself is negative evidence');
  assert.ok(refreshCalls >= 2, 'the injected refresher actually ran');
});

await t('V5. ⭐ ZERO token material on the wire — canaries in stored creds AND the refresher\'s return never surface', async () => {
  reset();
  refreshResult = CANARY_REFRESH;
  const bodies = [
    await (await fetch(`${base}/auth/claude/status`)).text(),
    await (await fetch(`${base}/auth/claude/refresh`, { method: 'POST' })).text(),
  ];
  for (const b of bodies) {
    assert.ok(!b.includes(CANARY_STORED), 'the stored credential leaked into a response body');
    assert.ok(!b.includes(CANARY_REFRESH), 'the refreshed token leaked into a response body');
    assert.ok(!/sk-ant-|oat01-/.test(b), `token-shaped material in a response: ${b.slice(0, 120)}`);
  }
});

await t('V6. no subscription: status validity is not_connected; refresh is a 404, not a silent no-op', async () => {
  const bare = portalProvidersRouter({ db: makeDb([]), userId: 'u1', probeCredential: probeFound, refreshToken: async () => CANARY_REFRESH });
  const s2 = await serve(bare);
  try {
    const st = await (await fetch(`${s2.base}/auth/claude/status`)).json();
    assert.equal(st.health, 'missing');
    assert.deepEqual(st.validity, { native: 'not_connected', cli: 'not_connected' });
    const rf = await fetch(`${s2.base}/auth/claude/refresh`, { method: 'POST' });
    assert.equal(rf.status, 404, 'nothing to refresh — say so');
  } finally { s2.close(); }
});

close();
reset();   // leave no synthetic evidence behind for anything sharing the process

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — subscription status is evidence-based, per-surface, fail-closed, and token-free on the wire' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
