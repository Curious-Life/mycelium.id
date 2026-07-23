// verify:handle — handle validation is UNIFIED on the DNS-safe rule (identity.js
// isValidHandle) so a profile handle is always a valid <handle>.mycelium.id
// subdomain / did:web label. Regression guard for the dash-vs-underscore divergence
// bug: portal-compat.js used to accept underscores (`[a-z0-9_]{2,29}`) that can never
// be a hostname, while identity.js (federation source of truth) requires dashes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isValidHandle } = await import('../src/identity/identity.js');

let pass = 0, fail = 0;
const ok = (c, l, x = '') => {
  if (c) { pass++; console.log(`PASS  ${l}${x ? '  ' + x : ''}`); }
  else { fail++; console.log(`FAIL  ${l}${x ? '  ' + x : ''}`); }
};

// 1. the DNS-safe rule itself
ok(isValidHandle('my-name'), 'dash handle valid (subdomain-safe)');
ok(!isValidHandle('my_name'), 'underscore handle REJECTED (not a valid hostname)');
ok(isValidHandle('ab'), '2-char handle valid');
ok(!isValidHandle('a'), '1-char handle invalid');
ok(isValidHandle('a'.repeat(32)), '32-char handle valid');
ok(!isValidHandle('a'.repeat(33)), '33-char handle invalid (>32)');
ok(!isValidHandle('-ab'), 'leading dash invalid');
ok(!isValidHandle('ab-'), 'trailing dash invalid');
ok(!isValidHandle('Ab'), 'uppercase invalid');
ok(!isValidHandle('a b'), 'space invalid');
ok(isValidHandle('martin'), 'plain alnum handle valid (the current vault handle)');

// 2. convergence — the app layer no longer carries a divergent regex
const compat = readFileSync(path.join(ROOT, 'src/portal-compat.js'), 'utf8');
ok(/isValidHandle/.test(compat), 'portal-compat uses isValidHandle (unified source of truth)');
ok(!/\[a-z0-9_\]\{2,29\}/.test(compat), 'portal-compat no longer carries the underscore handle regex');

// 3. the client mirrors it (no underscore input pattern in ProfileView)
const prof = readFileSync(path.join(ROOT, 'portal-app/src/lib/views/ProfileView.svelte'), 'utf8');
ok(!/pattern="\[a-z0-9\]\[a-z0-9_\]/.test(prof), 'ProfileView input pattern is dash-based, not underscore');

// ── QA6: ONE WRITER, ONE SOURCE OF TRUTH (publicHost) ─────────────────────────
const hs = await import('../src/identity/handle-service.js');
const { firstLabel, validateHandle, RESERVED_HANDLES, setHandle } = hs;
const conns = await import('../src/db/connections.js');
const router = readFileSync(path.join(ROOT, 'src/remote/router.js'), 'utf8');
const profilesDb = readFileSync(path.join(ROOT, 'src/db/profiles.js'), 'utf8');

// 4. firstLabel is THE derivation of handle-from-host.
ok(firstLabel('lo.mycelium.id') === 'lo', 'firstLabel(host) = handle (the one derivation)');
ok(firstLabel('alice.example.org') === 'alice', 'firstLabel handles custom domains');
ok(firstLabel('') === null && firstLabel(null) === null, 'firstLabel of empty/null = null (fail-closed)');

// 5. validation goes through the SHARED rule + the ONE reserved list.
ok(validateHandle('good-name').ok, 'validateHandle accepts a DNS-safe handle');
ok(!validateHandle('bad_name').ok, 'validateHandle rejects underscores (shared isValidHandle)');
ok(!validateHandle('admin').ok && !validateHandle('settings').ok, 'validateHandle rejects reserved names');
ok(RESERVED_HANDLES.has('www') && RESERVED_HANDLES.has('connections'), 'ONE reserved list is the union of the old two');

// 6. ONE WRITER — both HTTP surfaces converge on setHandle from the service, and
//    NEITHER writes user_profiles.handle directly anymore.
ok(/from '\.\/identity\/handle-service\.js'/.test(compat), 'PUT /portal/profile imports the handle setter (handle-service)');
ok(/setHandle\(/.test(compat), 'PUT /portal/profile delegates to setHandle');
ok(!/sets\.push\('handle/.test(compat) && !/'handle = \?'/.test(compat) && !/SET handle\s*=\s*\?/.test(compat.replace(/\/\/.*$/gm, '')),
  'portal-compat no longer writes user_profiles.handle with a bare UPDATE (cosmetic-handle bug)');
ok(/from '\.\.\/identity\/handle-service\.js'/.test(router) && /setHandle\(/.test(router),
  'connect-managed is a thin wrapper over the SAME setHandle');
ok(typeof setHandle === 'function', 'setHandle is the single exported setter');

// 7. user_profiles.handle is a DERIVED MIRROR — readProfile derives from publicHost,
//    never from the row, and the setter mirrors LAST.
ok(/const handle = currentHandle\(\)/.test(compat), 'readProfile derives handle from currentHandle() (publicHost), not row.handle');
ok(!/handle:\s*row\.handle/.test(compat), 'readProfile no longer reads handle straight off the profile row');

// 8. availability hits the CONTROL PLANE, not the local table.
ok(/checkAvailability\(/.test(compat), 'portal /profile/handle/check delegates to the control-plane availability check');
ok(!/SELECT user_id FROM user_profiles WHERE handle = \? AND user_id != \?/.test(compat),
  'the old vacuous local-table availability query is gone');

// 9. readProfile().handle === firstLabel(readRemoteConfig().publicHost) — the
//    derivation invariant, proven LIVE against a temp remote.json.
{
  const os = await import('node:os'); const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-handle-'));
  const rcPath = path.join(tmp, 'remote.json');
  const env = { ...process.env, MYCELIUM_REMOTE_CONFIG: rcPath, MYCELIUM_DATA_DIR: tmp };
  const cfg = await import('../src/remote/config.js');
  cfg.writeRemoteConfig({ publicHost: 'zoe.mycelium.id' }, { env });
  const derived = hs.currentHandle({ env });
  ok(derived === firstLabel(cfg.readRemoteConfig({ env }).publicHost), 'currentHandle === firstLabel(publicHost) (the invariant)');
  ok(derived === 'zoe', 'derived handle matches the configured publicHost first label');
  // a not-yet-claimed intent is an INTENT, never the identity:
  cfg.writeRemoteConfig({ publicHost: '', desiredHandle: 'pending-name' }, { env });
  ok(hs.currentHandle({ env }) === null, 'no publicHost → currentHandle null (federation fail-closed)');
  ok(hs.pendingHandle({ env }) === 'pending-name', 'a picked-but-unclaimed handle surfaces as pendingHandle, not currentHandle');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

// 10. BARE-HANDLE RESOLUTION — the thing the UI promises, now performed server-side.
ok(typeof conns.expandBareHandle === 'function', 'connections exports bare-handle expansion');
ok(conns.expandBareHandle('lo') === 'lo.mycelium.id', 'bare handle `lo` expands to lo.mycelium.id (UI promise honored)');
const connsSrc = readFileSync(path.join(ROOT, 'src/db/connections.js'), 'utf8');
ok(/requestRemote\(fromUserId, bare, expandBareHandle\(bare\)\)/.test(connsSrc),
  'request() routes an unresolved bare handle through federation via expandBareHandle');
// The registry lookup was a live `fetchImpl(\`${workerUrl()}/api/resolve-handle...`)
// call; assert the CALL is gone (a doc-comment mention of the path is fine).
ok(!/fetchImpl\([^)]*resolve-handle/.test(connsSrc.replace(/\n/g, ' ')) && !/workerUrl\(\)\}\/api\/resolve-handle/.test(connsSrc),
  'the dead cross-tenant Worker registry fetch is removed');

// 11. the leaky from_handle fallback is gone — an unresolvable handle is never shipped.
//
// ⚠️ GATE METHOD (this assertion was REWRITTEN after review). The previous version
// was a FILE-LEVEL regex enumerating the OLD identifiers — `!/selfHandle\(\) \|\|
// (me\.handle|fp\.handle|userId)/` — plus a check that SOME `from_handle:
// requireSelfHandle()` existed somewhere in the file. Both are satisfied by a file
// in which ONE call site still leaks: reverting a single `from_handle:` (line 371
// OR line 569) to `selfHandle() || fromUserId` stayed GREEN here, in
// verify:federation, AND in the unit tests. An enumerating regex only ever catches
// the identifier you already thought of, and an existential check cannot see the
// call site that DOESN'T comply.
// Assert the PROPERTY, PER CALL SITE instead: EVERY `from_handle:` in the file is
// `from_handle: requireSelfHandle()` — counted, so a single divergent site fails.
{
  // strip comments so a doc-comment mentioning `from_handle` can't inflate either side
  const code = connsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // MATCH `from_handle` AS AN OBJECT KEY IN ANY FORM — bare (`from_handle:`), quoted
  // (`'from_handle':`), OR computed (`['from_handle']: userId`). ⚠️ The prior regex
  // `/from_handle\s*:/` only saw the bare form: rewriting a call site to the computed
  // key `['from_handle']: userId` dropped it from BOTH counts EQUALLY (the char after
  // `from_handle` is `'`, not `:` or whitespace) — so a raw-userId egress leak on the
  // ACCEPT path (connections.js:569) shipped GREEN here. The `[ \t'"\]]*` class lets a
  // closing quote/bracket sit between `from_handle` and its colon so the computed/quoted
  // forms are COUNTED (never silently dropped); it excludes newline so a next key on the
  // following line can't be swallowed into this one.
  const KEY = String.raw`from_handle[ \t'"\]]*:`;
  const assigns = code.match(new RegExp(KEY, 'g')) || [];
  // END-ANCHOR the guarded expression. `from_handle: requireSelfHandle()` must be the
  // COMPLETE property value — the assignment ends at the trailing comma / EOL — so a
  // PREFIX like `from_handle: requireSelfHandle() && fromUserId,` (which throws when
  // federation is off, so line-48's test still passes, yet returns the raw userId once
  // configured — a real egress leak) fails to match and drops guarded below assigns.
  // Without the anchor the un-anchored `requireSelfHandle()` matched that prefix and the
  // leak stayed GREEN (proven by reverting line 371). A TERNARY (`… ? requireSelfHandle()
  // : userId`) also fails to match (after `:` comes the condition, not the call) → RED.
  // `[ \t]*` only after the call — never `\s*`, which would swallow the newline and let a
  // next-line `&& x` slip back in.
  const guarded = code.match(new RegExp(String.raw`${KEY}\s*requireSelfHandle\(\)[ \t]*,?[ \t]*$`, 'gm')) || [];
  ok(assigns.length > 0, 'connections.js has outbound from_handle call sites to gate', `(${assigns.length})`);
  ok(assigns.length === guarded.length,
    'EVERY from_handle call site is EXACTLY `requireSelfHandle()` (end-anchored) — no per-site fallback leak',
    `${guarded.length}/${assigns.length} guarded`);
  // ⚠️ CONCAT/COMPUTED-KEY EVASION (QA6 re-review). Both counts above are derived from the LITERAL
  // token `from_handle`, so a computed key that SPLITS the literal — `['from_'+'handle']: userId` —
  // drops out of assigns AND guarded EQUALLY (5→4/4), leaving the balance check GREEN while a
  // raw-userId egress leak ships on the un-backstopped sites (:892/:948/:1168 — proven by rewriting
  // :892). Anchor guarded to a LITERAL expected count the evasion cannot reduce (like T10a's CEILING
  // in verify:transcript-context): a dropped/obfuscated site reds here even when it stays balanced.
  // A NEW legit egress site must carry `from_handle: requireSelfHandle()` AND bump this number after
  // review. The from_handle VALUE on the wire is additionally backstopped behaviourally in
  // verify:federation-outbox (O8: the unsealed/announced from_handle === the federation handle,
  // never the userId) — two guards, neither able to mask the other.
  const EXPECTED_FROM_HANDLE_SITES = 5; // request(:371) · accept(:569) · sendMessage(:892) · federationOutbox(:948) · announceShare(:1168)
  ok(guarded.length === EXPECTED_FROM_HANDLE_SITES,
    `EXACTLY ${EXPECTED_FROM_HANDLE_SITES} guarded from_handle egress sites (literal anchor — a concat/computed key that evades the balance check reds here)`,
    `${guarded.length}/${EXPECTED_FROM_HANDLE_SITES}`);
  ok(/function requireSelfHandle\(\)\s*\{[^}]*throw new Error/.test(code),
    'requireSelfHandle() THROWS when federation is unconfigured (fails loud, never a fallback)');
}

// 11b. BEHAVIOURAL: the pre-expansion isValidHandle guard in connections.js request()
//      actually REJECTS a hostile bare handle — asserted IN connections.js, not
//      inherited from transport.js.
//
// ⚠️ WHY THIS EXISTS: nothing gated `if (!isValidHandle(bare)) throw` at all. Deleting
// it stayed GREEN everywhere, because transport.js's DOMAIN_RE rejects the *worst*
// expansions — two guards masking each other (see the repo memory note of the same
// name). So the probe below is chosen SPECIFICALLY to slip past DOMAIN_RE:
// `a` (1 char, isValidHandle needs ≥2) and a 40-char name (isValidHandle caps at 32)
// both expand to a SYNTACTICALLY VALID domain (`a.mycelium.id`), so with the guard
// removed the request proceeds to persist a phantom pending row + attempt egress.
// The observable is therefore the WRITE, not the error string.
{
  const probes = ['a', 'x'.repeat(40)];
  for (const bare of probes) {
    const sql = [];
    const conn = conns.createConnectionsNamespace({
      d1Query: async (q) => { sql.push(String(q)); return { results: [] }; },
      selfInstance: () => 'me.mycelium.id',
      did: () => 'did:web:me.mycelium.id',
      fetch: async () => { sql.push('FETCH'); throw new Error('no network in gate'); },
      randomUUID: () => 'gate-uuid',
    });
    let err = null;
    try { await conn.request('u-self', bare); } catch (e) { err = e; }
    const wrote = sql.some((q) => /INSERT INTO connections/i.test(q)) || sql.includes('FETCH');
    ok(/User not found/i.test(String(err?.message || '')) && !wrote,
      `connections.request() rejects the hostile bare handle IN connections.js (no row, no egress) [${bare.length === 1 ? "'a'" : '40 chars'}]`,
      wrote ? 'LEAKED past the guard' : '');
  }
}

// 12. the dead second setter/rule/list is removed from db/profiles.js.
ok(!/async setHandle\(userId, handle\)/.test(profilesDb), 'db/profiles.js dead setHandle removed');
ok(!/\[a-z0-9_\]\{2,29\}/.test(profilesDb), 'db/profiles.js divergent underscore HANDLE_RE removed');

// ── 13. setHandle() BEHAVIOUR — the ONE setter, exercised live with a stubbed
//        control plane + an isolated remote.json (no network, no real keychain). ──
{
  const os = await import('node:os'); const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-set-'));
  const rcPath = path.join(tmp, 'remote.json');
  const baseEnv = { MYCELIUM_REMOTE_CONFIG: rcPath, MYCELIUM_DATA_DIR: tmp, MYCELIUM_CONTROL_PLANE: 'https://cp.test' };

  // Control-plane stub: /v1/handle/<h> availability + a full provision response.
  const cpStub = (taken = new Set()) => async (url, opts) => {
    const u = String(url);
    if (/\/v1\/handle\//.test(u)) {
      const h = decodeURIComponent(u.split('/v1/handle/')[1]);
      return { ok: true, status: 200, json: async () => ({ available: !taken.has(h) }) };
    }
    if (/\/v1\/challenge/.test(u)) return { ok: true, status: 200, json: async () => ({ nonce: 'n-1' }) };
    if (/\/v1\/provision/.test(u)) {
      const body = JSON.parse(opts.body); const h = body.handle;
      return { ok: true, status: 200, json: async () => ({
        host: `${h}.mycelium.id`, relayAddr: 'relay.test:7000', relayToken: 'tok-abc',
        acmeDns: { username: 'u', password: 'p', subdomain: 's', serverUrl: 'https://acme.test' },
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // (a) INTENT path — no operator password (canProvision fails), requireProvision:false.
  //     A free name is RECORDED as an intent (claimed:false), never a silent success.
  const env1 = { ...baseEnv };
  const r1 = await setHandle({ handle: 'freename', requireProvision: false, env: env1, fetchImpl: cpStub() });
  ok(r1.claimed === false && r1.ok === true, 'intent path: a free handle with no password is recorded, not claimed');
  ok(firstLabel((await import('../src/remote/config.js')).readRemoteConfig({ env: env1 }).publicHost) === null,
    'intent path: publicHost stays empty (federation still fail-closed)');
  const cfg2 = await import('../src/remote/config.js');
  ok(cfg2.readRemoteConfig({ env: env1 }).desiredHandle === 'freename', 'intent path: the picked name is stored as desiredHandle');

  // (b) INTENT path on a TAKEN name → throws already_claimed (availability is honored).
  let took = false;
  try { await setHandle({ handle: 'takenname', requireProvision: false, env: { ...baseEnv, MYCELIUM_REMOTE_CONFIG: path.join(tmp, 'r2.json') }, fetchImpl: cpStub(new Set(['takenname'])) }); }
  catch (e) { took = e.code === 'already_claimed'; }
  ok(took, 'intent path: a taken handle is refused (control-plane availability honored)');

  // (c) RENAME REFUSAL — once publicHost is set, setting a DIFFERENT handle is
  //     rejected (set-once; a rename would orphan did:web for every connected peer).
  const env3 = { ...baseEnv, MYCELIUM_REMOTE_CONFIG: path.join(tmp, 'r3.json') };
  cfg2.writeRemoteConfig({ publicHost: 'live.mycelium.id' }, { env: env3 });
  let renamed = null;
  try { await setHandle({ handle: 'newname', env: env3, fetchImpl: cpStub() }); }
  catch (e) { renamed = e.code; }
  ok(renamed === 'rename_unsupported', 'set-once: renaming a claimed handle is refused (rename_unsupported)');

  // (d) IDEMPOTENT — setting the handle you ALREADY have is a no-op success, no restart.
  const r4 = await setHandle({ handle: 'live', env: env3, fetchImpl: cpStub() });
  ok(r4.ok && r4.claimed && r4.restartRequired === false, 'idempotent: re-setting your current handle is a no-op success');
  // …and it hands back a USABLE connector URL (the Settings UI renders result.connectorUrl;
  // the unchanged branch used to return none, so a re-set rendered "Address ready: undefined").
  ok(r4.connectorUrl === 'https://live.mycelium.id/mcp' && r4.host === 'live.mycelium.id',
    'idempotent: echoes the ACTUAL configured host + a connectorUrl', String(r4.connectorUrl));

  // (e) ⚠️ SILENT DID ROTATION — set-once must gate on the STORE (publicHost), not on
  //     currentHandle(). An OWN-DOMAIN vault (a.example.com) has a configured host whose
  //     first label ('a') is NOT a valid handle, so currentHandle() is null. Gating on
  //     that let setHandle('attacker') fall through to a LIVE CLAIM that overwrote
  //     publicHost — rotating did:web:a.example.com → did:web:attacker.mycelium.id,
  //     flipping remoteMode to 'managed', orphaning every peer. Reachable from
  //     PUT /portal/profile. This asserts the REFUSAL *and* that the store is untouched.
  for (const host of ['a.example.com', 'My-Box.Example.Org']) {
    const rcp = path.join(tmp, `own-${host}.json`);
    fs.writeFileSync(rcp, JSON.stringify({ v: 1, publicHost: host, remoteMode: 'own-relay' }));
    const envOwn = { ...baseEnv, MYCELIUM_REMOTE_CONFIG: rcp, ENCRYPTION_MASTER_KEY: 'f'.repeat(64) };
    ok(hs.currentHandle({ env: envOwn }) === null,
      `precondition: ${host} yields NO valid federation handle (currentHandle null)`);
    let code = null;
    try { await setHandle({ handle: 'attacker', requireProvision: false, env: envOwn, fetchImpl: cpStub() }); }
    catch (e) { code = e.code; }
    const after = cfg2.readRemoteConfig({ env: envOwn });
    ok(code === 'rename_unsupported', `set-once holds for a configured own-domain host (${host})`, String(code));
    ok(after.publicHost === host && after.remoteMode === 'own-relay',
      `no silent DID rotation: publicHost/remoteMode untouched (${host})`, `${after.publicHost} / ${after.remoteMode}`);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

// ── 14. FAIL-CLOSED case handling: publicHost is canonicalized at its ONE write
//        point, and firstLabel stays LITERAL. A mixed-case host this build never
//        wrote (hand-edited / legacy remote.json) must NOT suddenly derive a valid
//        federation handle — that flips a vault from fail-closed (no signing
//        identity, did.json 404) to serving one. CLAUDE.md §3.
{
  const os = await import('node:os'); const fs = await import('node:fs');
  const cfg = await import('../src/remote/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-case-'));

  ok(firstLabel('Vault.Example.com') === 'Vault',
    'firstLabel does NOT fold case (a non-canonical host stays non-canonical)');

  // (a) a LEGACY mixed-case value in remote.json → still fail-closed.
  const legacy = path.join(tmp, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ v: 1, publicHost: 'Vault.Example.com' }));
  const envL = { MYCELIUM_REMOTE_CONFIG: legacy, MYCELIUM_DATA_DIR: tmp };
  ok(cfg.readRemoteConfig({ env: envL }).publicHost === 'Vault.Example.com', 'legacy value is read verbatim');
  ok(hs.currentHandle({ env: envL }) === null,
    'a non-canonical stored publicHost derives NO handle (fail-closed — was fail-OPEN)');

  // (b) anything WRITTEN through the one writer is canonical, so the normal path works.
  const fresh = path.join(tmp, 'fresh.json');
  const envF = { MYCELIUM_REMOTE_CONFIG: fresh, MYCELIUM_DATA_DIR: tmp };
  cfg.writeRemoteConfig({ publicHost: 'Vault.Example.com' }, { env: envF });
  ok(cfg.readRemoteConfig({ env: envF }).publicHost === 'vault.example.com',
    'writeRemoteConfig canonicalizes publicHost to lowercase (the ONE write point)');
  ok(hs.currentHandle({ env: envF }) === 'vault', 'a canonically-written host derives its handle normally');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

// ── 15. `unreachable` is WIRED, not just emitted. /managed/available now always
//        answers 200 with { available:false, unreachable:true } on a failed check, so
//        the old client tests (res.status >= 500 / data.error === 'control plane
//        unreachable') can NEVER fire — every offline check would render as "taken",
//        telling the user each name they try is gone. Assert each client CONSUMES the
//        flag and carries a distinct state.
{
  const files = {
    'RemoteAccessSection.svelte': 'portal-app/src/lib/components/settings/RemoteAccessSection.svelte',
    'HandleStep.svelte': 'portal-app/src/lib/components/onboarding/wizard/HandleStep.svelte',
    'WelcomeModal.svelte': 'portal-app/src/lib/components/WelcomeModal.svelte',
    // The Profile screen's handle picker is the 4th consumer — it hits the SAME
    // /profile/handle/check, so an offline plane must show its own state here too, not
    // render every name "Not available" (the identical bug the other three fixed).
    'ProfileView.svelte': 'portal-app/src/lib/views/ProfileView.svelte',
  };
  // ⚠️ STRIP COMMENTS FIRST. The first cut of this gate did not, and a mutation that
  // deleted the live `data?.unreachable ||` test stayed GREEN — satisfied by the
  // explanatory COMMENT I had written directly above it. A gate comment can launder
  // the bug it describes; assert against CODE only.
  const strip = (s) => s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
  for (const [name, rel] of Object.entries(files)) {
    const src = strip(readFileSync(path.join(ROOT, rel), 'utf8'));
    ok(/(?:data|d)\s*\??\.\s*unreachable/.test(src),
      `${name} reads the server's \`unreachable\` flag in CODE (not only status/error strings)`);
    ok(/=\s*'unreachable'/.test(src),
      `${name} ASSIGNS a distinct 'unreachable' state (not folded into 'taken')`);
  }
  // The server still SENDS it (the flag the clients now depend on).
  const hsSrc = readFileSync(path.join(ROOT, 'src/identity/handle-service.js'), 'utf8');
  ok(/unreachable:\s*true/.test(hsSrc), 'checkAvailability emits unreachable:true on a failed check');
}

// ── 16. transport.js DOMAIN_RE has its OWN teeth (two-guards discipline). The
//        WebFinger domain gate is backstopped by safeFetch (address-level), so
//        weakening DOMAIN_RE to `/.*/` stayed GREEN everywhere — the classic
//        two-guards-mask hole. Assert DOMAIN_RE SPECIFICALLY: a non-canonical host
//        must be refused by resolveEndpoint BEFORE any network call. The probe
//        (an underscore label) is SYNTACTICALLY resolvable, so with the guard removed
//        it slips past to safeFetch → the injected fetch fires (observable). With the
//        guard present it throws 'Invalid domain' and fetch is never reached.
{
  const { createDirectHttpTransport } = await import('../src/federation/transport.js');
  const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }]; // resolvable → isolates DOMAIN_RE from safeFetch
  let reached = false;
  const t = createDirectHttpTransport({
    lookup: PUBLIC,
    fetch: async () => { reached = true; return { ok: true, status: 200, async json() { return { links: [] }; } }; },
  });
  let err = null;
  try { await t.resolveEndpoint('bad_host.example.com', 'h'); } catch (e) { err = e; }
  ok(/invalid domain/i.test(String(err?.message || '')) && !reached,
    'transport DOMAIN_RE rejects a non-canonical host in transport.js, before any fetch (own guard, not safeFetch\'s)',
    reached ? 'SLIPPED PAST DOMAIN_RE to safeFetch' : String(err?.message || ''));
}

// ── 17. SET-ONCE is enforced at the STORE (the 2nd door), not only in setHandle.
//        writeRemoteConfig() is reachable directly via POST /api/v1/remote/config, so
//        the publicHost → did:web rotation must be refused HERE too. Proven live against
//        isolated remote.json files: first write OK, same-value no-op OK, non-publicHost
//        patch on a claimed store OK, but a rotation to a DIFFERENT non-empty host reds.
{
  const os = await import('node:os'); const fs = await import('node:fs');
  const cfg = await import('../src/remote/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-setonce-'));
  const mk = (name) => ({ MYCELIUM_REMOTE_CONFIG: path.join(tmp, name), MYCELIUM_DATA_DIR: tmp });

  // (a) FIRST provisioning write on an empty store — must succeed (don't break setup).
  const e1 = mk('first.json');
  let firstOk = true;
  try { cfg.writeRemoteConfig({ remoteMode: 'managed', publicHost: 'live.mycelium.id' }, { env: e1 }); } catch { firstOk = false; }
  ok(firstOk && cfg.readRemoteConfig({ env: e1 }).publicHost === 'live.mycelium.id',
    'writeRemoteConfig allows the FIRST publicHost write (provisioning still works)');

  // (b) ROTATION to a different non-empty host — must be REJECTED (the closed door).
  let rotated = false, rotErr = null;
  try { cfg.writeRemoteConfig({ publicHost: 'attacker.mycelium.id' }, { env: e1 }); rotated = true; }
  catch (e) { rotErr = e.message; }
  ok(!rotated && cfg.readRemoteConfig({ env: e1 }).publicHost === 'live.mycelium.id',
    'writeRemoteConfig REFUSES rotating an already-set publicHost (no silent did:web rotation)', String(rotErr));

  // (c) same-value re-write is a no-op success (idempotent provisioning / reconcile).
  let sameOk = true;
  try { cfg.writeRemoteConfig({ publicHost: 'live.mycelium.id' }, { env: e1 }); } catch { sameOk = false; }
  ok(sameOk, 'writeRemoteConfig allows re-writing the SAME publicHost (idempotent)');

  // (d) a NON-publicHost patch on a claimed store still works (only publicHost is gated).
  let patchOk = true;
  try { cfg.writeRemoteConfig({ remoteMode: 'own-relay', desiredHandle: 'later' }, { env: e1 }); } catch { patchOk = false; }
  ok(patchOk && cfg.readRemoteConfig({ env: e1 }).remoteMode === 'own-relay',
    'writeRemoteConfig still accepts non-publicHost patches on a claimed store (remoteMode/desiredHandle)');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

// ── 18. THE DOOR, not just the store — POST /api/v1/remote/config WHITELISTS its body.
//        §17 proves the store refuses a ONE-SHOT rotation, but clearing publicHost to ''
//        is (correctly) allowed at the store, so a TWO-STEP poke against the raw door
//        (publicHost:'' then publicHost:'attacker') would walk PAST the set-once guard:
//        step 1 clears → step 2 sees an empty currentHost and claims the attacker host,
//        silently re-pointing did:web / WebFinger and orphaning every pinned peer. The
//        /config route is loopback-only, but loopback is not a trust boundary here (any
//        same-uid process reaches it with ZERO proof). So the door must DROP the
//        identity-bearing keys entirely. Driven against a REAL ephemeral express mount
//        of remoteRouter over 127.0.0.1 (isTrustedLoopback passes; fetch adds no XFF).
//        Mutation: pass req.body wholesale (remove the whitelist) → the two-step rotates
//        publicHost to 'attacker.mycelium.id' → this reds.
{
  const os = await import('node:os'); const fs = await import('node:fs'); const http = await import('node:http');
  const express = (await import('express')).default;
  const { remoteRouter } = await import('../src/remote/router.js');
  const cfg = await import('../src/remote/config.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-configdoor-'));
  const saved = {
    rc: process.env.MYCELIUM_REMOTE_CONFIG, dd: process.env.MYCELIUM_DATA_DIR, auth: process.env.MYCELIUM_AUTH_DB,
  };
  process.env.MYCELIUM_REMOTE_CONFIG = path.join(tmp, 'remote.json');
  process.env.MYCELIUM_DATA_DIR = tmp;
  process.env.MYCELIUM_AUTH_DB = ':memory:'; // passkeyEnrolled() → false; no auth.db on disk

  // A vault that has ALREADY claimed its managed identity (the state peers pin).
  cfg.writeRemoteConfig({ remoteMode: 'managed', publicHost: 'live.mycelium.id' });

  const app = express();
  app.use('/api/v1/remote', remoteRouter());
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/v1/remote/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }));

  // (a) THE TWO-STEP DID-ROTATION attack at the untrusted door.
  const s1 = await post({ publicHost: '' });                     // step 1: clear
  const s2 = await post({ publicHost: 'attacker.mycelium.id' }); // step 2: claim
  const afterTwoStep = cfg.readRemoteConfig();
  ok(afterTwoStep.publicHost === 'live.mycelium.id',
    '/config door: TWO-STEP publicHost rotation (\'\' then attacker) does NOT rotate the DID',
    `publicHost=${afterTwoStep.publicHost} (steps ${s1.status}/${s2.status})`);

  // (b) desiredHandle is likewise not settable through this door (identity intent).
  await post({ desiredHandle: 'attacker' });
  ok(cfg.readRemoteConfig().desiredHandle === '',
    '/config door: desiredHandle is dropped (not an accepted key)');

  // (c) remoteMode:'managed' — the identity-bearing marker — is ignored; transport-only
  //     modes still apply. Seed own-relay via the store, then try to force managed.
  cfg.writeRemoteConfig({ remoteMode: 'own-relay' });
  await post({ remoteMode: 'managed' });
  ok(cfg.readRemoteConfig().remoteMode === 'own-relay',
    '/config door: remoteMode:\'managed\' is ignored (own-relay preserved)');

  // (d) a LEGIT transport key still round-trips through the whitelist (no regression).
  await post({ remoteMode: 'off', remoteEnabled: true });
  const legit = cfg.readRemoteConfig();
  ok(legit.remoteEnabled === true && legit.remoteMode === 'off',
    '/config door: legit whitelisted keys (remoteEnabled/remoteMode=off) still apply');

  await new Promise((r) => server.close(r));
  if (saved.rc === undefined) delete process.env.MYCELIUM_REMOTE_CONFIG; else process.env.MYCELIUM_REMOTE_CONFIG = saved.rc;
  if (saved.dd === undefined) delete process.env.MYCELIUM_DATA_DIR; else process.env.MYCELIUM_DATA_DIR = saved.dd;
  if (saved.auth === undefined) delete process.env.MYCELIUM_AUTH_DB; else process.env.MYCELIUM_AUTH_DB = saved.auth;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

// ── 19. CONTROL-PLANE HOST-BINDING — the untrusted /v1/provision response is
//        validated (host must be THIS handle's own subdomain) before it touches
//        config/env. handle-service.js:~306 guards `!host.startsWith(`${h}.`)`, but
//        §13's stub always returns a MATCHING host, so a malicious/compromised control
//        plane rebinding the vault to an attacker host during a legit claim was never
//        exercised. Drive the full provision path (real operator user + master key) with
//        a stub that returns a MISMATCHED host and assert the claim is REFUSED.
//        Mutation: drop the `!host.startsWith(`${h}.`)` clause → the mismatched host is
//        accepted (claimed) → (a) reds.
{
  const os = await import('node:os'); const fs = await import('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-hostbind-'));
  const saved = {
    rc: process.env.MYCELIUM_REMOTE_CONFIG, dd: process.env.MYCELIUM_DATA_DIR, auth: process.env.MYCELIUM_AUTH_DB,
    cp: process.env.MYCELIUM_CONTROL_PLANE, mk: process.env.ENCRYPTION_MASTER_KEY, email: process.env.MYCELIUM_USER_EMAIL,
  };
  // canProvision() / operatorUserExists() read process.env (not the passed env), so the
  // operator user + master key must live on process.env for the provision path to open.
  process.env.MYCELIUM_REMOTE_CONFIG = path.join(tmp, 'remote.json');
  process.env.MYCELIUM_DATA_DIR = tmp;
  process.env.MYCELIUM_AUTH_DB = path.join(tmp, 'auth.db');
  process.env.MYCELIUM_CONTROL_PLANE = 'https://cp.test';
  process.env.ENCRYPTION_MASTER_KEY = 'd'.repeat(64);
  delete process.env.MYCELIUM_USER_EMAIL;

  const cfg = await import('../src/remote/config.js');
  await cfg.setOperatorPassword({ email: 'op@mycelium.local', password: 'correct-horse-battery' });

  // Provision stub with a configurable returned host. nonce ≥ 8 chars (buildClaim floor).
  const cpStub = (provisionHost) => async (url) => {
    const u = String(url);
    if (/\/v1\/handle\//.test(u)) return { ok: true, status: 200, json: async () => ({ available: true }) };
    if (/\/v1\/challenge/.test(u)) return { ok: true, status: 200, json: async () => ({ nonce: 'nonce-abcdef' }) };
    if (/\/v1\/provision/.test(u)) return { ok: true, status: 200, json: async () => ({
      host: provisionHost, relayAddr: 'relay.test:7000', relayToken: 'tok-abc',
      acmeDns: { username: 'u', password: 'p', subdomain: 's', serverUrl: 'https://acme.test' },
    }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // (a) A control plane rebinding to a MISMATCHED host is REFUSED (bad_response) — the
  //     vault never persists an attacker-chosen publicHost.
  let mismatchCode = null;
  try { await setHandle({ handle: 'mine', requireProvision: true, env: process.env, fetchImpl: cpStub('attacker.evil.id') }); }
  catch (e) { mismatchCode = e.code; }
  ok(mismatchCode === 'bad_response',
    'control-plane host-binding: a provision host that is NOT <handle>.* is refused (bad_response)', String(mismatchCode));
  ok(cfg.readRemoteConfig().publicHost === '',
    'control-plane host-binding: the mismatched host is NOT persisted (publicHost stays empty)');

  // (b) The MATCHING host still claims (the guard does not false-reject a legit plane).
  const r = await setHandle({ handle: 'mine', requireProvision: true, env: process.env, fetchImpl: cpStub('mine.mycelium.id') });
  ok(r.ok && r.claimed === true && cfg.readRemoteConfig().publicHost === 'mine.mycelium.id',
    'control-plane host-binding: the MATCHING host claims normally (no false reject)');

  for (const [k, v] of Object.entries(saved)) {
    const envKey = { rc: 'MYCELIUM_REMOTE_CONFIG', dd: 'MYCELIUM_DATA_DIR', auth: 'MYCELIUM_AUTH_DB', cp: 'MYCELIUM_CONTROL_PLANE', mk: 'ENCRYPTION_MASTER_KEY', email: 'MYCELIUM_USER_EMAIL' }[k];
    if (v === undefined) delete process.env[envKey]; else process.env[envKey] = v;
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
