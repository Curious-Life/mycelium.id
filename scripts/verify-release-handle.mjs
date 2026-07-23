// verify:release-handle — best-effort managed-handle release for destroy/disconnect
// (src/remote/release-handle.js). NEVER throws; only acts on a managed handle.
//   L1 APPLICABILITY IS A PROPERTY OF THE CONFIG, NOT OF OUR ABILITY TO ACT.
//      applicable ⟺ (remoteMode==='managed' AND publicHost set). Only those two
//      say "nothing to release". A MANAGED handle we merely cannot release right
//      now (no master key in env, untrusted control plane) is applicable:TRUE —
//      the name is still squatted and the caller must block on it.
//      This is review F1: the first cut classified `no-master-key` as
//      applicable:false, and THIS GATE ASSERTED THAT — blessing a live bug.
//      ENCRYPTION_MASTER_KEY is set only inside boot() (src/index.js) while the
//      destroy route is mounted pre-boot, so a managed user resetting an unbooted
//      vault (the most likely reset!) silently skipped the release and saw NO
//      warning at all.
//   L1b an explicit masterHex makes the release WORK pre-boot (empty env)
//   L2 managed + challenge ok → posts a signed 'release' claim to /v1/release → released
//   L3 challenge fails → {released:false}, no release POST
//   L4 network throw → caught, {released:false}
//   L5 a FAILED release is applicable:true — the name is still taken, so a caller
//      can distinguish "nothing to release" from "could not release"
//   L6 bounded retry: a transient failure is retried; a success on attempt 2 wins;
//      a not-applicable verdict is NOT retried (no point burning the budget)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseManagedHandle, NOT_APPLICABLE_REASONS } from '../src/remote/release-handle.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const MASTER = 'a'.repeat(64);
const managedEnv = { MYCELIUM_CONTROL_PLANE: 'https://cp.example', ENCRYPTION_MASTER_KEY: MASTER, MYCELIUM_REMOTE_MODE: 'managed', MYCELIUM_PUBLIC_HOST: 'alice.mycelium.id' };
const noRetry = { attempts: 1, retryDelayMs: 0 };

// L1 applicability = "does a managed handle EXIST", never "can we reach it"
{
  let calls = 0;
  const fetch = async () => { calls++; return { ok: true }; };
  // NO managed handle → applicable:false (nothing to release), no network.
  const off = await releaseManagedHandle({ env: { ...managedEnv, MYCELIUM_REMOTE_MODE: 'off' }, fetch, ...noRetry });
  const noHost = await releaseManagedHandle({ env: { ...managedEnv, MYCELIUM_PUBLIC_HOST: undefined }, fetch, ...noRetry });
  const noneOk = [off, noHost].every((r) => r.applicable === false && r.released === false && NOT_APPLICABLE_REASONS.includes(r.reason))
    && off.reason !== noHost.reason;

  // A managed handle EXISTS but we cannot release it → applicable:TRUE (blocking).
  // `no-master-key` is the pre-boot destroy path: env has no ENCRYPTION_MASTER_KEY
  // (boot() sets it) yet readRemoteConfig is file-backed and knows it's managed.
  const preBoot = await releaseManagedHandle({ env: { ...managedEnv, ENCRYPTION_MASTER_KEY: undefined }, fetch, ...noRetry });
  const badCp = await releaseManagedHandle({ env: { ...managedEnv, MYCELIUM_CONTROL_PLANE: 'http://evil.example' }, fetch, ...noRetry });
  const blockingOk = [preBoot, badCp].every((r) => r.applicable === true && r.released === false)
    && preBoot.reason === 'no-master-key' && badCp.reason === 'untrusted-control-plane'
    // …and NEVER classified as "nothing to release"
    && !NOT_APPLICABLE_REASONS.includes(preBoot.reason) && !NOT_APPLICABLE_REASONS.includes(badCp.reason);

  rec('L1 applicable ⟺ a managed handle EXISTS: off/no-host → false; unreleasable-but-EXISTING (no-master-key pre-boot, untrusted CP) → TRUE (blocking)',
    noneOk && blockingOk && calls === 0,
    `off=${off.reason}/${off.applicable} noHost=${noHost.reason}/${noHost.applicable} preBoot=${preBoot.reason}/${preBoot.applicable} badCp=${badCp.reason}/${badCp.applicable} calls=${calls}`);
}

// L1b an explicit masterHex signs the claim even with an EMPTY env (pre-boot)
{
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push(url);
    if (url.endsWith('/v1/challenge')) return { ok: true, json: async () => ({ nonce: 'nonce-abc123' }) };
    return { ok: true, body: opts?.body };
  };
  const envNoKey = { ...managedEnv, ENCRYPTION_MASTER_KEY: undefined };
  const withKey = await releaseManagedHandle({ env: envNoKey, fetch, masterHex: MASTER, ...noRetry });
  const withoutKey = await releaseManagedHandle({ env: envNoKey, fetch, ...noRetry });
  rec('L1b explicit masterHex makes the PRE-BOOT release actually WORK (env has no key); without it, honest no-master-key',
    withKey.released === true && withKey.applicable === true
    && withoutKey.released === false && withoutKey.reason === 'no-master-key',
    `withKey=${JSON.stringify(withKey)} withoutKey=${JSON.stringify(withoutKey)}`);
}

// L2 managed happy path → challenge then release POST
{
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push({ url, method: opts?.method || 'GET' });
    if (url.endsWith('/v1/challenge')) return { ok: true, json: async () => ({ nonce: 'nonce-abc123' }) };
    if (url.endsWith('/v1/release')) return { ok: true };
    return { ok: false };
  };
  const r = await releaseManagedHandle({ env: managedEnv, fetch, ...noRetry });
  const postedRelease = seen.some((s) => s.url.endsWith('/v1/release') && s.method === 'POST');
  rec('L2 managed → challenge + signed release POST → released', r.released === true && r.applicable === true && postedRelease, JSON.stringify(seen));
}

// L3 challenge fails → no release POST
{
  const seen = [];
  const fetch = async (url) => { seen.push(url); return { ok: false }; };
  const r = await releaseManagedHandle({ env: managedEnv, fetch, ...noRetry });
  rec('L3 challenge fails → no release POST, not released',
    r.released === false && !seen.some((u) => u.endsWith('/v1/release')));
}

// L4 network throw → caught
{
  const r = await releaseManagedHandle({ env: managedEnv, fetch: async () => { throw new Error('ECONNREFUSED'); }, ...noRetry });
  rec('L4 network throw → caught, not released', r.released === false && typeof r.reason === 'string');
}

// L5 a FAILED release stays applicable:true — the handle is still squatted
{
  const fetch = async (url) => (url.endsWith('/v1/challenge')
    ? { ok: true, json: async () => ({ nonce: 'nonce-abc123' }) }
    : { ok: false, status: 503 });
  const r = await releaseManagedHandle({ env: managedEnv, fetch, ...noRetry });
  rec('L5 a failed release is applicable:true + reason (distinguishable from "nothing to release")',
    r.applicable === true && r.released === false && r.reason === 'release-503', JSON.stringify(r));
}

// L6 bounded retry
{
  let tries = 0;
  const fetch = async (url) => {
    if (url.endsWith('/v1/challenge')) { tries += 1; return tries === 1 ? { ok: false } : { ok: true, json: async () => ({ nonce: 'nonce-abc123' }) }; }
    return { ok: true };
  };
  const r = await releaseManagedHandle({ env: managedEnv, fetch, attempts: 3, retryDelayMs: 0 });
  let naTries = 0;
  const na = await releaseManagedHandle({
    env: { ...managedEnv, MYCELIUM_REMOTE_MODE: 'off' },
    fetch: async () => { naTries += 1; return { ok: true }; }, attempts: 3, retryDelayMs: 0,
  });
  rec('L6 transient failure is RETRIED (succeeds on attempt 2); a not-applicable verdict is not retried',
    r.released === true && r.attempts === 2 && na.attempts === 1 && naTries === 0,
    `retried=${r.attempts} na=${na.attempts}`);
}

// L7 a BLACKHOLED network cannot hang the destroy (review F2). undici's default
// headers timeout is 300s and the bounded retry runs the pair 3× ⇒ ~15 minutes of
// a hung destroy request with destroyBusy=true and no cancel — on exactly the
// "user is offline" case this whole 409 design exists to serve. Every fetch must
// carry an AbortSignal, and the signal must actually be honoured.
{
  // A fetch that NEVER resolves unless its AbortSignal fires.
  const blackhole = (_url, opts) => new Promise((_resolve, reject) => {
    const sig = opts?.signal;
    if (!sig) return; // no signal ⇒ hangs forever ⇒ the gate times out below (RED)
    if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  });
  const t0 = Date.now();
  const r = await Promise.race([
    releaseManagedHandle({ env: managedEnv, fetch: blackhole, timeoutMs: 150, attempts: 2, retryDelayMs: 0 }),
    new Promise((res) => setTimeout(() => res({ hung: true }), 4000)),
  ]);
  const elapsed = Date.now() - t0;
  rec('L7 blackholed network → every fetch is AbortSignal-bounded; returns a blocking release-timeout, never hangs',
    r.hung !== true && r.applicable === true && r.released === false && r.reason === 'release-timeout' && elapsed < 3000,
    `elapsed=${elapsed}ms r=${JSON.stringify(r)}`);
}

// L7b ISOLATE the release POST's signal (review round-3, LOW: L7's own blackhole
// hangs the CHALLENGE first, so dropping the signal from ONLY the release POST
// keeps L7 green). Here the challenge resolves instantly (carrying its signal) and
// the RELEASE POST is the blackhole — so the timeout can only come from the
// release POST being AbortSignal-bounded, AND we assert the POST received a live
// signal. Drop the signal from the /v1/release fetch and this reds (hangs → RED).
{
  let releasePostSawSignal = null;
  const fetch = (url, opts) => {
    if (url.endsWith('/v1/challenge')) {
      // Instant success — but honour an already-aborted signal so we never race.
      if (opts?.signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      return Promise.resolve({ ok: true, json: async () => ({ nonce: 'nonce-post-iso' }) });
    }
    // /v1/release → blackhole that only settles when ITS OWN signal fires.
    releasePostSawSignal = !!opts?.signal;
    return new Promise((_resolve, reject) => {
      const sig = opts?.signal;
      if (!sig) return; // signal dropped from the release POST ⇒ hangs ⇒ gate times out (RED)
      if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    });
  };
  const t0 = Date.now();
  const r = await Promise.race([
    releaseManagedHandle({ env: managedEnv, fetch, timeoutMs: 150, attempts: 2, retryDelayMs: 0 }),
    new Promise((res) => setTimeout(() => res({ hung: true }), 4000)),
  ]);
  const elapsed = Date.now() - t0;
  rec('L7b the RELEASE POST is independently AbortSignal-bounded (challenge succeeds first, release POST blackholes) → release-timeout, POST saw a signal',
    r.hung !== true && releasePostSawSignal === true && r.reason === 'release-timeout' && r.released === false && elapsed < 3000,
    `elapsed=${elapsed}ms postSawSignal=${releasePostSawSignal} r=${JSON.stringify(r)}`);
}

// L8 FAIL CLOSED on a corrupt remote.json (review round-3, FIX 2). readRemoteConfig
// fails SOFT — a torn/truncated file parses to `{}` → remoteMode:'off' → "not-managed"
// → destroy would proceed with ZERO network calls, leaving a real managed handle
// squatted. A file that EXISTS but does not parse is NOT proof of "no managed
// handle": it must BLOCK (applicable:true), distinct from an ABSENT file (which is
// the legitimate not-managed case). The corrupt verdict is deterministic ⇒ NOT
// retried and makes NO network call.
{
  const dir = mkdtempSync(join(tmpdir(), 'rh-torn-'));
  try {
    const cfgPath = join(dir, 'remote.json');
    // Env carries NO MYCELIUM_REMOTE_MODE / PUBLIC_HOST, so remote.json is the sole
    // authority — exactly the disk-corruption case the fix defends.
    const fileEnv = { MYCELIUM_REMOTE_CONFIG: cfgPath, ENCRYPTION_MASTER_KEY: MASTER, MYCELIUM_CONTROL_PLANE: 'https://cp.example' };
    let calls = 0;
    const fetch = async () => { calls += 1; return { ok: true }; };

    // Torn/truncated JSON — present but unparseable.
    writeFileSync(cfgPath, '{ "remoteMode": "managed", "publicHost": "alice.mycelium.i');
    const torn = await releaseManagedHandle({ env: fileEnv, fetch, attempts: 3, retryDelayMs: 0 });

    // A well-formed managed file at the SAME path DOES attempt a release (proves the
    // block is specific to corruption, not to file-backed config).
    writeFileSync(cfgPath, JSON.stringify({ remoteMode: 'managed', publicHost: 'alice.mycelium.id' }));
    const okFile = await releaseManagedHandle({ env: fileEnv, fetch: async (u) => (u.endsWith('/v1/challenge') ? { ok: true, json: async () => ({ nonce: 'nonce-okfile-1' }) } : { ok: true }), attempts: 1, retryDelayMs: 0 });

    // An ABSENT file → legitimately not-managed (applicable:false), no block.
    const absent = await releaseManagedHandle({ env: { MYCELIUM_REMOTE_CONFIG: join(dir, 'nope.json'), ENCRYPTION_MASTER_KEY: MASTER }, fetch: async () => { calls += 1; return { ok: true }; }, attempts: 1, retryDelayMs: 0 });

    rec('L8 torn remote.json → BLOCKING (applicable:true, remote-config-unreadable, 0 network calls, not retried); a valid file releases; an ABSENT file is not-managed',
      torn.applicable === true && torn.released === false && torn.reason === 'remote-config-unreadable'
      && torn.attempts === 1 && calls === 0
      && okFile.released === true && okFile.applicable === true
      && absent.applicable === false && absent.reason === 'not-managed',
      `torn=${JSON.stringify(torn)} calls=${calls} okFile=${JSON.stringify(okFile)} absent=${JSON.stringify(absent)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — managed-handle release: bounded retry, explicit not-applicable, honest failure');
