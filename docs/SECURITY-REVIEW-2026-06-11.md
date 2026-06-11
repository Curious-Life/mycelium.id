# Adversarial Security Review — Public-Release Readiness (2026-06-11)

> **Handling note:** this document enumerates concrete, currently-exploitable
> weaknesses and their exploit chains. It must **NOT** ship in the public
> (AGPL) release. Keep it internal (exclude from the published artifact, same
> as `.claude/memory/` — see GEN-1) until the HIGHs are closed, then archive
> privately.

> **STATUS — 2026-06-11:** all six HIGH items are **FIXED** on
> `claude/adversarial-security-review-1dzf3r` (H1 crypto fail-closed, H2 egress
> `trusted` token-gate, H3 default-deny tool surface, H4 SSRF IPv6 parser, H5
> BYOK base_url validation, H6 login CSRF + scoped CORS), each with a verify
> gate. GEN-1/GEN-2 (purge `.claude/memory/` + root `_*.mjs` pre-release) are
> tracked in `.claude/memory/feedback_pre_release_purge.md` (left in for now per
> operator decision). MEDIUM/LOW items remain open. H1 additionally surfaced two
> latent plaintext test-seeds (now bound) — proof the guard works.


Scope: full `src/` (~34k LOC), `packages/channel-daemon/`, `pipeline/`,
`mycelium-managed/`, `portal-app/`, `src-tauri/`, root scripts, CI, git
hygiene. Method: 7 parallel adversarial domain audits + a hand audit of the
crypto core, repo/secret hygiene, and the desktop/managed shells. Every claim
below is cited to `file:line` against live code.

**Bottom line:** the codebase is genuinely security-conscious — the envelope
crypto is sound, the public publish server is fail-closed, SQL is
parameterised, secret-logging discipline is good, and most classic attack
classes are correctly closed. The release-blocking issues are concentrated in
**five HIGH items** plus two cross-cutting anti-patterns (fail-OPEN where the
spec demands fail-closed; loopback-trust as a single enforcement layer). No
confirmed Critical.

---

## Cross-cutting themes (read these first)

1. **Fail-OPEN where the threat model says fail-CLOSED.** Two of the most
   load-bearing controls degrade to *permit* on an unexpected input:
   the encryption-at-write SQL parser (H1) and the SSRF DNS guard (H4/M-SSRF).
   CLAUDE.md §3 is explicit: "Missing encryption key → refuse to write …
   Never fall back to a permissive default." These violate it.
2. **Loopback = the only auth layer on several privileged surfaces.** The
   channel-daemon egress endpoints (H2), `/internal/*` (the team's own
   `.claude/memory/feedback_per_agent_internal_secret.md` documents the
   shared-secret cross-call gap), and the REST plane all lean on "same machine
   ⇒ trusted." That breaks CLAUDE.md §2 ("two independent enforcement layers")
   and turns any local SSRF / co-tenant / `0.0.0.0` misconfig into full access.
3. **Untrusted input selects the privileged code path.** A body boolean
   (`trusted:true`, H2) and an empty allowlist (full MCP tool surface, H3)
   both let attacker-influenced data choose the high-privilege branch — classic
   confused-deputy.

---

## HIGH — fix before public release

### H1 — Encryption-at-write is FAIL-OPEN: a SQL-parser miss persists plaintext in "encrypted" columns
**`src/crypto/crypto-local.js:1406-1598` (`parseWriteSQL`/`autoEncryptParams`), `src/adapter/d1.js:42-44`.**
Column-level encryption is applied by **regex-parsing the SQL string** at the
adapter boundary to find which `?` params map to encrypted columns. If the
regex fails to match the write shape, `parseWriteSQL` returns `null`,
`autoEncryptParams` returns the SQL untouched, and `d1.js` binds the **raw
plaintext** into the encrypted column. There is no post-write assertion that
the value landed as an envelope. This is the single biggest confidentiality
risk in the system, and it has **already fired in production**: the code
comment at `:1431-1438` records a live leak where a multi-line `UPDATE` of an
entity `summary` was written in plaintext until `/s` (dotall) was added.
Unhandled shapes that still slip through today include `INSERT … SELECT`,
CTEs, unusual whitespace/formatting, and any write the regexes don't model.
- **Impact:** intimate vault content (the entire threat model) silently stored
  unencrypted; an at-rest DB capture or backup then exposes it.
- **Fix:** make the boundary fail-CLOSED. Options, best first: (a) drive
  encryption from a structured query builder / explicit column map instead of
  re-parsing SQL strings; (b) failing that, add a **write-back invariant** — for
  any table with `ENCRYPTED_FIELDS`, assert every listed column in the bound
  params is `isEncrypted(...)` before `stmt.run`, and throw otherwise; (c) a
  `verify:` gate that fuzzes write shapes per encrypted table and asserts
  ciphertext at rest.

### H2 — Channel-daemon egress: body-supplied `trusted:true` bypasses the authority gate **and** rate limiter on a no-auth loopback endpoint
**`packages/channel-daemon/egress/send-handler.js:71,91,108-133`; routes `server.js:43-44`.**
`POST /telegram/send` and `/discord/send` have **no auth** (loopback-bound by
design). The handler reads `trusted` straight from the request body; when set
it skips the per-channel allowlist (`if (!trusted) checkAuthority…`) and skips
rate-limiting, stamping provenance `system-template`. Any local process, local
user, co-located SSRF, or a `CHANNEL_DAEMON_HOST=0.0.0.0` misconfig can POST
`{"chatId":"<any>","text":"…","trusted":true}` and deliver to any chat the bot
can reach — defeating the explicit-send authority model (CLAUDE.md §11) with an
attacker-suppliable boolean, and mislabelling the audit row.
- **Fix:** never derive `trusted` from the body. Gate it on an out-of-band
  signal the model/caller can't forge — strict-loopback provenance header **plus**
  a per-boot secret the in-process `sendReply` closures inject — or mint
  command-ack sends via an in-process call rather than re-entering the public
  HTTP endpoint.

### H3 — Channel-daemon agent: local/OpenAI-compat backends hand attacker-influenced turns the **full MCP tool surface** (incl. a write tool)
**`packages/channel-daemon/agent/backends/ollama.js:39-49`, `openai-compat.js:64-71`; default tool set `config.js:58`.**
`runOllamaTurn` falls back to the **unfiltered** `mcpTools` when `allowTools`
is empty, and the openai-compat backend calls it with no allowlist at all. The
default channel tool set includes `remember` (a **write**). The cloud
`claude-sdk.js:84-88` backend correctly hard-codes a 3-tool read-only allowlist
"no write tools on an autonomous reply turn" — that discipline is missing from
the other two backends. In an `open`-mode or group channel, a **non-owner**
message becomes the agent's prompt → prompt-injection can drive
`searchMindscape` over the owner's private vault and exfiltrate it back through
the legitimate `reply` tool (the egress chokepoint can't help — delivery to the
inbound channel is authorised), and `remember` enables memory-poisoning.
- **Fix:** enforce the default-deny read-only allowlist in `runOllamaTurn` and
  the openai-compat backend; drop `remember` from channel turns (or gate write
  tools to owner-DM turns only).

### H4 — SSRF guard misses IPv6 internal-address forms → DNS-rebinding bypass on the **pre-auth** federation surface
**`src/federation/ssrf.js:16-34` (`isPrivateAddress`).**
Confirmed by execution: `::ffff:7f00:1` (hex-grouped IPv4-mapped loopback) →
**allowed**; bracketed `[::1]` → allowed; and whole IPv6 internal ranges are
unhandled (IPv4-compat `::a.b.c.d`, NAT64 `64:ff9b::`, 6to4 `2002::`, Teredo
`2001::`). This is the only **unauthenticated** SSRF surface
(`POST /federation/connect`, `did:web` resolution at `did.js:182`). An attacker
publishes an AAAA record pointing at a missed form (or, via the TOCTOU below, a
public A on the guard's lookup and an internal target on `fetch`'s lookup) →
server fetches loopback / `169.254.169.254` cloud metadata.
- **Fix:** replace the ad-hoc string parsing with `node:net`/`ipaddr.js`,
  normalise to numeric, and reject `::ffff:0:0/96` (any grouping), `::/96`,
  `64:ff9b::/96`, `2002::/16`, `2001::/32`, `::`, plus the existing v4 ranges.
  Pair with IP-pinning (below) and fail-closed-on-resolve-failure to fully
  close rebinding.

### H5 — BYOK provider `base_url` is never SSRF-validated → SSRF to internal services **and** plaintext+key exfiltration to an attacker endpoint
**`src/inference/cloud.js:120-145`, `probe.js:26-50`, `gateway/openai-compat.js:255`, `portal-providers.js:92-161`.**
No SSRF guard is imported by any inference/gateway file. A provider row's
`base_url` is accepted with no scheme/host validation and used verbatim to
POST **the prompt (vault plaintext)** plus `Authorization: Bearer <user key>`.
`base_url: https://attacker/v1` silently exfiltrates every prompt and the BYOK
key; `http://127.0.0.1:11434` / `http://169.254.169.254/…` gives blind internal
SSRF (status/timing leak liveness). Requires owner-level config write, so it's
HIGH not Critical — but a social-engineered "EU-sovereign provider" URL, or any
settings-UI CSRF/XSS (see M-XSS), turns it into full plaintext exfiltration with
zero defense-in-depth.
- **Fix:** validate `base_url` on write and before every use (require `https:`;
  allow `http://127.0.0.1|localhost` only for `local` jurisdiction; reject
  private-range IP literals; run through the fixed SSRF guard + IP-pinning).
  Also fix the substring-based jurisdiction classifier (`presets.js:42-48`,
  `https://regolo.ai.attacker.com` is mis-classified `eu-zdr`, downgrading the
  §4g sensitive-egress hard block) to exact-suffix host matching, fail-safe to
  `us-standard`.

### H6 — Login CSRF / session fixation on `POST /login`; blanket credentialed CORS reflection on `/api/auth/*`
**`src/server-http.js:196-210` (login) and `:148-156,165-175` (CORS).**
`POST /login` calls `auth.api.signInEmail` server-side, **deliberately bypassing
better-auth's Origin/CSRF check** (comment `:187-188`), with no CSRF token and no
Origin allowlist — a cross-origin auto-submitted form can drive login /
fixation and, because it bounces to `/api/auth/mcp/authorize?<qs>`, be chained
into completing an OAuth grant for an attacker-registered DCR client. Separately,
the OPTIONS handler reflects **any** Origin with `Allow-Credentials: true` for
all `/api/auth/*`; today the *actual* better-auth responses don't emit ACAO so
session JSON isn't cross-origin-readable, but the blanket credentialed preflight
on the OAuth/session authority is a latent footgun (one future cookie-authed
`/api/auth/*` route that emits ACAO completes the attack).
- **Fix:** add a double-submit CSRF token + Origin allowlist to `/login` (reuse
  `require-vault-auth.js`'s `csrfCookieMiddleware`/`timingEqual`); scope the
  credentialed CORS reflection to exactly `/mcp/register` + `/mcp/token` with an
  explicit origin allowlist, not all of `/api/auth/*`.

---

## MEDIUM

- **M-SSRF-TOCTOU — SSRF guard re-resolves; connection not IP-pinned.**
  `src/federation/ssrf.js:40-47`. Guard `lookup`s, then `fetch` resolves again —
  DNS rebinding works even with a correct parser. Fix: resolve once, validate,
  connect to the literal IP with original Host/SNI via a custom undici agent.
- **M-SSRF-FAILOPEN — guard allows on DNS-resolution failure.**
  `ssrf.js:42-43` returns (permits) on `lookup` throw. Fail closed; move the
  test-only accommodation behind the injected `lookup` seam.
- **M-REST-BIND — `MYCELIUM_REST_HOST` opt-out has no warning; XFF-absence ==
  full trust.** `src/server-rest.js:462-466` binds an operator-supplied host and
  still prints "localhost-only, no auth"; the whole loopback-trust model
  (account-key minting, recovery key at `/api/v1/account/recovery-key`,
  operator-password setter) assumes the listener is loopback-bound and that any
  front proxy injects XFF. A proxy that forgets `X-Forwarded-For` makes every
  request read as trusted-local. Fix: warn/refuse on non-loopback bind without
  an explicit `MYCELIUM_ALLOW_NETWORK_REST=1`; document the XFF requirement.
- **M-FED-RL — federation rate-limit keyed on spoofable `X-Forwarded-For`.**
  `src/federation/handlers.js:36-42`. Rotate XFF → unlimited buckets → unauth
  DoS on DID resolution. Key on `req.socket.remoteAddress` / verified DID; add a
  global backstop.
- **M-XSS — intel page uses a bespoke markdown renderer that bypasses
  DOMPurify.** `portal-app/src/routes/(app)/intel/+page.svelte:1488-1529`
  (sink `:2155`). Escapes `&<>` but not `"`, builds `href="$2"` with no protocol
  allowlist, over **LLM-generated** report text that ingests externally-sourced
  vault data → stored XSS in the authenticated portal (reachable once exposed via
  the relay). Every other `{@html}` sink uses `marked`+`DOMPurify`; make this one
  match.
- **M-ZIPBOMB — `vault-import.js` inflates whole entries before the size check.**
  `src/ingest/vault-import.js:104-113,366-385` use `entry.async('nodebuffer')`
  with only a declared-size precheck (fragile JSZip private field) and a post-hoc
  length check — no streaming backstop, unlike the sibling `import-parsers.js:30-51`.
  A malicious export with a false-low declared size OOMs the process. Route both
  reads through the streaming byte-counter.
- **M-INJECT-PROMPT — inbound + media-derived text reaches the agent with no
  trust-boundary marker.** `packages/channel-daemon/inbound.js:67-141,95`,
  `media.js:36-52`, `agent/prompt.js`. Wrap channel/file content in explicit
  untrusted-data delimiters; default channels to `owner`/`allowlist`, not `open`.
- **GEN-1 — `.claude/memory/feedback_*.md` ship internal known-weakness
  disclosures for a public OSS release.** e.g.
  `feedback_per_agent_internal_secret.md` documents the unfixed shared-secret
  `/internal/*` cross-call weakness plus internal ports (5004) and agent
  topology; `_oauth-probe.mjs`/docs leak the real relay host `0m.mycelium.id`
  and `operator@mycelium.local`. Exclude `.claude/memory/` from the published
  artifact.
- **GEN-2 — root `_*.mjs` debug scripts ship publicly.**
  `_setpw.mjs`, `_reset-operator.mjs`, `_clean-oauth*.mjs`, `_decode-token.mjs`,
  `_email.mjs`, `_oauth-probe.mjs`. No hardcoded secrets, but a turnkey
  operator-password-reset / token-decode / email-dump toolkit + the
  `0m.mycelium.id` host. Move to an ignored `scratch/` or add to a package
  `files` allowlist so they never reach the published tarball.

---

## LOW / hardening

- **DB-COL — latent identifier injection via `Object.keys()` column names.**
  `src/db/{messages,documents,profiles,attachments,tasks,agent-tasks,events,oauth-states}.js`
  interpolate caller-object keys as SQL identifiers with no allowlist. Not
  reachable today (all call sites pass fixed-key objects), but a future
  `insert(req.body)` yields identifier injection **and** could flip an encrypted
  column to plaintext (it drives `parseWriteSQL`). Add per-table column
  allowlists (the `vault-import.js:91` schema-intersection is the model).
- **DB-LIMIT — unbounded caller `LIMIT` on several reads** (`wealth.*`,
  `messages.selectRecent`, etc.) → memory DoS. Clamp like `tasks.list` does.
  `assignments.js:56` interpolates a *clamped* `LIMIT ${lim}` — safe but convert
  to a bound `?`.
- **LOG-1 — 12-char plaintext message preview logged** on dropped/blocked paths:
  `channel-daemon/inbound.js:77`, `discord-inbound.js:57`, `send-handler.js:84`.
  Log length+hash only.
- **LOG-2 — auth-header fragment logged.** `src/server-http.js:258` logs the
  first 14 chars of `Authorization` (7 token chars for `Bearer …`). Log
  scheme-present/absent only.
- **SCRUB-1 — guardian `shortHash` is a 24-bit reversible tenant fingerprint**
  (`crypto/guardians/scrubbers.js:107-114`) advertised as redaction; matters in
  V2 multi-tenant. Use keyed HMAC ≥12 hex. **SCRUB-2** — scrubbers are an
  allowlist with no content-pattern second layer; add a final redaction pass for
  `[0-9a-f]{32,}` / `eyJ…` / `sk-` / `Bearer ` over emitted strings.
- **PUB-1 — `/s/:slug?t=<token>` unlisted responses have no `Cache-Control`**
  and carry the capability token in the querystring; the page loads
  `fonts.googleapis.com`, so a `Referer` can leak the token.
  `src/publish/public-server.js:120-133,47`. Add `Cache-Control: private,
  no-store` + `Referrer-Policy: no-referrer`; self-host the font.
- **PORTAL-ERR — authenticated portal 500s echo `e.message`** (`portal-settings.js`,
  `portal-connectors.js`, etc.) — can surface paths/SQL fragments to an
  owner-authed (relay-exposed) client. Return generic errors; log server-side.
- **TAURI-CSP — `src-tauri/tauri.conf.json` sets `"csp": null`** with
  `withGlobalTauri:true` + `macOSPrivateApi:true`. Risk is bounded (capabilities
  grant only `core:default` + window-drag — no shell/fs/http), but set a
  restrictive CSP as defense-in-depth since the webview renders vault content.
- **CSRF-COOKIE — `mycelium_csrf` lacks `Secure`** (`require-vault-auth.js:107-119`);
  set it when the request arrived over https (relay), keep flagless on loopback http.
- **MANAGED-1 — `MYC_TURNSTILE_MOCK=1` disables the bot-gate in production**
  (`mycelium-managed/src/server.js:333`, `turnstile.js:29`); `MYC_DNS_PROVIDER`
  defaults to `mock`. Operator footguns — fail-safe / warn when mock is set with
  a real secret present. (Managed tier is V2; review it fully before that ships.)

---

## Verified SAFE (checked, no action)

- **Envelope crypto** (`crypto-local.js`): AES-256-GCM, fresh per-message DEK,
  random 12-byte IV, AES-KW DEK wrap, HKDF scope/user derivation. No IV reuse
  (DEK is single-use). Master key memory/tmpfs-only, sodium-mlock'd, pinned per
  process, drift-checked, never logged (only a one-way SHA-256/16 fingerprint).
  All-zero HKDF salt is acceptable for a high-entropy 256-bit IKM.
- **Public publish server** (`src/publish/*`): separate app/port, only `/p` + `/s`,
  parameterised `getBySlug` scoped `user_id AND public_slug AND NOT forgotten`,
  ed25519 capability tokens (canonical base64url enforced), unpublish nulls the
  nonce atomically (no IDOR), HTML-escape-before-markdown (no XSS), generic 404s
  (no stack traces), 1 MiB render cap. Strong.
- **SQL**: no injection found anywhere; all values bound; search is in-RAM
  BM25/cosine with no SQL from query terms; no `eval`/`Function`/proto-pollution
  surface in `src`.
- **Secret/repo hygiene**: no secrets in 200-commit history; `.gitignore` covers
  `.env*`/`*.db`/`*.key`/`kcv.json`/`auth.db`; managed deploy configs use
  RFC-5737 IPs and empty tokens; no real PII (only `alice/bob/eve` fixtures).
  `security@mycelium.id` is a usable disclosure contact.
- **Auth core**: `/mcp` fail-closed Bearer + independent expiry check; static
  bearer constant-time + length-floored; sign-up blocked over the relay; operator
  session pinned to owner email; OAuth requires PKCE and drops `openid` (no
  unverifiable id_token); sign-in throttles are global (header-spoof-proof).
- **Federation signing**: canonicalised payload, ±5min ts window, nonce replay
  cache, `from_did` binding to the *verified* signer (not claimed instance).
- **Egress audit / local inference**: logs sha256+length only, never plaintext;
  embeddings never leave the box (loopback-only); API keys redacted in config
  snapshots and error paths.
- **ffmpeg/TTS**: `execFile`/`spawn` arg-arrays, temp paths only — no command
  injection.

---

## Recommended pre-release sequence

1. **H1** (fail-open encryption) — highest confidentiality impact; make the
   write boundary fail-closed + add a ciphertext-at-rest verify gate.
2. **H2 + H3** (channel-daemon authority bypass + broad tools) — active
   exfiltration/impersonation paths.
3. **H4 + M-SSRF-*** (rebuild `ssrf.js` on `node:net`/`ipaddr.js`, IP-pin,
   fail-closed) — the only pre-auth network surface.
4. **H5** (BYOK base_url validation + jurisdiction exact-match).
5. **H6** (login CSRF + scope the credentialed CORS).
6. **GEN-1 / GEN-2** — exclude `.claude/memory/` and `_*.mjs` from the published
   artifact (and keep THIS file internal).
7. MEDIUM/LOW hardening as capacity allows; schedule a dedicated review of the
   `mycelium-managed` V2 tier before it ships.
