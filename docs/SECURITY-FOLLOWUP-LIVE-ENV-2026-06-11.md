# Security follow-up — items requiring a LIVE local environment (2026-06-11)

Pick-up doc for a **local session running on real hardware** (a Mac/VPS with the
vault running, outbound network, and the Tauri toolchain). The 2026-06-11
adversarial review (`docs/SECURITY-REVIEW-2026-06-11.md`) closed 6 HIGH + 6
MEDIUM + 8 LOW on branch `claude/adversarial-security-review-1dzf3r` (merged).
These remaining items were **deliberately not shipped from the cloud session**
because they cannot be safely verified there — they need a real network and/or a
Tauri build. Do them here, with the live verification recipes below.

> Discipline: each item lists the change, the **falsifiable live test**, and the
> rollback. Do not declare done on "it compiles" — run the live test (CLAUDE.md
> §10 / `/deploy-and-verify`).

---

## 1. SSRF: IP-pinning + fail-closed-on-resolution (M-SSRF-TOCTOU, M-SSRF-FAILOPEN)

**Where:** `src/federation/ssrf.js` (+ callers `src/federation/did.js`,
`src/db/connections.js`). The H4 byte-level IPv6 parser already ships and closes
the concrete bypass; these two close the residual rebinding window.

**Current residual behaviour (intentional, documented in the file header):**
- `assertResolvesPublic()` **allows on DNS-resolution failure** (fail-open) — so
  the shim-fetch verify tests (non-resolving hosts) keep working.
- The guard resolves the name, then `fetch()` resolves **again** (TOCTOU) — an
  attacker controlling DNS can return a public IP to the guard and a private IP
  to the fetch (classic DNS rebinding).

**Change to make:**
1. **Plumb an injectable `lookup` through the handlers** so production can fail
   closed while tests inject a resolver. Thread `lookup` from
   `createFederationHandlers(deps)` → `verify()` → `resolveDidKey(did, { fetch, lookup })`
   and into `connections.receiveRemote`'s `assertResolvesPublic(host, { lookup })`.
   Update `scripts/verify-federation.mjs` `startBox(...)` to pass a `lookup` that
   resolves the test hosts (`alice.mycelium.id`, `bob.mycelium.id`) to a public
   literal (e.g. `93.184.216.34`). Then flip `assertResolvesPublic` to **throw on
   resolution failure** (remove the `catch { return; }` allow).
2. **Pin the connection to the validated IP** via an undici dispatcher. Add a
   `safeFetch(url, { lookup })` to `ssrf.js`: resolve once, validate every
   address with `isPrivateAddress` (fail-closed), then build an
   `undici.Agent({ connect: { lookup: pinnedLookup } })` whose `pinnedLookup`
   returns ONLY the pre-validated address AND re-checks `isPrivateAddress` in the
   hook. Pass `{ dispatcher: agent }` to the real `fetch`. Route the two did.js
   fetches and any other user-host fetch through `safeFetch`.

**Live tests (falsifiable):**
- **Rebinding:** stand up a domain whose authoritative DNS returns a public A on
  the first query and `127.0.0.1` on the second (or a short-TTL round-robin
  `[public, 127.0.0.1]`). Point a `did:web` at it and hit
  `POST /federation/connect`. **Expect:** the fetch never reaches loopback (pin
  holds); without the fix it would. Capture with `tcpdump`/a loopback listener.
- **Metadata:** a `did:web` host resolving to `169.254.169.254` → connect refused
  (already covered by the parser, but confirm `safeFetch` path also blocks).
- **Fail-closed:** a `did:web` host that does not resolve → `unresolvable did`
  (no silent allow). Confirm `npm run verify:federation` + `:spaces` still GO with
  the injected `lookup`.

**Rollback:** revert `ssrf.js` + the handler `lookup` plumbing; the parser fix
(shipped) remains.

---

## 2. Tauri webview CSP (TAURI-CSP)

**Where:** `src-tauri/tauri.conf.json` — currently `app.security.csp = null`,
with `withGlobalTauri: true` + `macOSPrivateApi: true`. Capabilities are already
minimal (`core:default` + `core:window:allow-start-dragging` only — no shell/fs/
http), so the blast radius is bounded, but the webview renders vault content and
a CSP is defense-in-depth.

**Change to make:** set a restrictive `csp`. The window loads the local portal
(`http://127.0.0.1:8787`, a *remote* origin per `capabilities/default.json`), so
the policy must permit that origin and whatever the SvelteKit portal actually
needs. Start from:
```
"csp": "default-src 'self' http://127.0.0.1:8787 http://localhost:8787; \
        img-src 'self' http://127.0.0.1:8787 data: blob:; \
        style-src 'self' 'unsafe-inline' http://127.0.0.1:8787; \
        script-src 'self' http://127.0.0.1:8787; \
        connect-src 'self' http://127.0.0.1:8787 http://localhost:8787 ws://127.0.0.1:8787; \
        font-src 'self' http://127.0.0.1:8787 data:"
```
Then **tighten iteratively against the real app** — SvelteKit may need
`'unsafe-inline'` for hydration styles; the public publish page pulls Google
Fonts but that's the *public* server (port 8788), not this webview. Do NOT keep
`'unsafe-eval'` unless a dependency truly requires it (investigate first).

**Live tests (falsifiable):** build + run the desktop app
(`npm run portal:build` then the Tauri build per `mobile/README.md`/build
scripts). **Expect:** (a) the portal loads, navigates, renders markdown/mindscape
with no blank screens; (b) DevTools console shows no CSP violations during normal
use; (c) inject a `<img src=x onerror=alert(1)>` into a rendered doc — the CSP
(plus the H3/M-XSS sanitisation) blocks script execution. If the app breaks,
read the exact CSP violation in the console and widen the one directive named —
never fall back to `csp: null`.

**Rollback:** set `csp` back to `null` (current state) if a release can't wait on
CSP tuning — but file it, don't drop it.

---

## 3. Lower-priority open items (no live env required, but out of the review's scope)

- **PORTAL-ERR** — several portal routers return `String(e.message).slice(0,200)`
  on 500s (`src/portal-settings.js`, `portal-connectors.js`, …). Return a generic
  error to the client; log details server-side. Owner-authed only, so low impact.
- **MANAGED-1** — `mycelium-managed/src/server.js:333` honours
  `MYC_TURNSTILE_MOCK=1` and `MYC_DNS_PROVIDER` defaults to `mock`. Add a startup
  warning/refusal when a mock is set alongside a real secret. **The whole
  `mycelium-managed` (V2) tier wants its own dedicated review before it ships.**

---

## 4. Pre-public-release purge (GEN-1 / GEN-2) — MUST happen before the repo goes public

Tracked in `.claude/memory/feedback_pre_release_purge.md`. Before flipping the
repo public (AGPL), `git rm` + history-scrub (`git filter-repo`):
- `.claude/memory/` (internal notes that disclose deferred weaknesses + topology),
- root `_*.mjs` (operator password-reset / token-decode toolkit + the real
  `0m.mycelium.id` host),
- `docs/SECURITY-REVIEW-2026-06-11.md` + this doc (they enumerate live exploit
  chains) and the `docs/*HANDOFF*` / `REMOTE-CONNECT-*` / `CLAUDE-CONNECTOR-*`
  docs carrying the relay host + operator email.

Verify with: `git ls-files | grep -E '^_|\.claude/memory/|SECURITY-REVIEW|SECURITY-FOLLOWUP'` → empty on the public branch.

---

## Quick reference — what already shipped (merged)
6 HIGH (H1–H6) · 6 MEDIUM (M-XSS, M-FED-RL, M-REST-BIND, M-ZIPBOMB,
M-INJECT-PROMPT + channel default `open`→`allowlist`) · 8 LOW (DB-COL, DB-LIMIT,
LOG-1/2, PUB-1, SCRUB-1/2, CSRF-COOKIE). All verify-gated. See
`docs/SECURITY-REVIEW-2026-06-11.md` for the full findings + file:line evidence.
