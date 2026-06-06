# Onboarding + Paid Managed Relay (O1–O11) — Handoff Doc

**Date:** 2026-06-06
**Companions:** plan/design = [`docs/DESIGN-onboarding-and-relay-billing-2026-06-05.md`](DESIGN-onboarding-and-relay-billing-2026-06-05.md) (the O1–O11 gap list, threat model, test strategy — updated with as-built status this session); architecture = [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (control-plane section).
**Audience:** the next Claude Code instance picking up the managed-relay billing/onboarding work.

---

## TL;DR — current state

The **entire onboarding + paid managed-relay roadmap (O1–O11) is built**, on branch `claude/confident-knuth-Ad88w`, PR **#105** (draft). Everything is **opt-in / off by default** — with no `MYC_STRIPE_SECRET` / `MYC_TURNSTILE_SECRET` set, nothing changes vs. before. ~12 verify gates green. **Merged to main** this session at the user's request so they can build the Mac app locally.

| Item | What | Status | Gate |
|---|---|---|---|
| O1 | wire ManagedConnectSection into Settings | ✅ (pre-session, #99) | — |
| O3 | `entitlements` table keyed by `public_key` | ✅ (pre-session, #99) | `verify:entitlement` E1–E7 |
| O2 backend | Turnstile bot-gate on `/v1/challenge` | ✅ (pre-session, #99) | `verify:turnstile` T1–T11 |
| **O2 widget** | **sandboxed cross-origin iframe** (`GET /turnstile`) | ✅ this session | `verify:turnstile` T12–T17 |
| **O4** | Stripe checkout + webhook (`billing.js`, no SDK) | ✅ this session | `verify:billing` B1–B10 |
| **O5** | reserve-then-pay: `402 {checkoutUrl}` gate | ✅ this session | `verify:provision` P14–P17 |
| **O6** | relay-hook denies lapsed tenant at NewProxy | ✅ this session | `verify:newproxy-auth` NA11–NA14 |
| **O7** | billing portal (action-bound `billing` claim) | ✅ this session | `verify:provision` P18–P21 |
| **O9** | own-relay UI (`controlPlaneUrl`+`relayAddr`) | ✅ this session (visual pending) | `remote-config`/`loopback` GO |
| **O10** | lapse/release lifecycle copy | ✅ this session (copy) | — |
| **O11** | sovereignty disclosure copy | ✅ this session | — |
| **O8** | first-run wizard step + QR | 🟡 **partial** — three-way story is in Settings → Connection; dedicated wizard deferred | — |
| — | Settings page reorg (Apple-style category panes) | ✅ this session (visual pending) | build + svelte-check clean |

**Three gates remain, all requiring a real machine/browser (cannot run in the cloud container):**
1. **Stripe test-mode** end-to-end (€1 test card → webhook → `paid_until` → entitled re-provision; cancel → relay denies; "Manage billing" opens portal).
2. **WebKit widget smoke** (enable Turnstile, solve, confirm Connect provisions).
3. **Visual review** of the Settings reorg + the Connection-pane copy/own-relay UI.

---

## 2026-06-06 session summary — start here when picking up

### What shipped (branch `claude/confident-knuth-Ad88w`, merged to main)

| Commit | Scope | Description |
|---|---|---|
| `f2b7234` | O2 | control-plane `GET /v1/config` exposes the public sitekey; loopback `GET /managed/turnstile` proxies it |
| `2d6bfde` | O2 widget | control-plane `GET /turnstile` page (CF script runs in **its** origin) + cross-origin iframe in ManagedConnectSection + dev CSP `frame-src` |
| `fc97684` | O4/O5 | `billing.js` (Stripe via fetch+crypto), `/v1/stripe/webhook` (raw body), `/v1/provision` 402 gate, `router.js` 402 surfacing |
| `d4a4e91` | O6 | `relay-hook.js authorizeNewProxy` lapsed-tenant gate (gated on `requireEntitlement`) |
| `4a61ba8` | O7 | `billing` claim action, `/v1/billing/portal` + `/v1/billing/nonce`, `router.js /managed/billing-portal`, "Manage billing" button |
| `28375c2` | settings | SettingsView → 7 category panes behind a sticky pill nav (`activeTab`) |
| `b9cb3cc` | O9/O10/O11 | own-relay fields in RemoteAccessSection, `/status` returns `controlPlaneUrl`/`relayAddr`, sovereignty + lifecycle copy |
| (this) | handoff | this doc + MEMORY.md pointer |

### What was learned / the load-bearing design calls (most important lines)

- **O2 widget — sandboxed iframe over direct script (operator decision).** The portal renders the user's most intimate data; loading Cloudflare's script into that origin would give third-party JS access to the DOM + the JS-readable CSRF cookie. Instead the control-plane serves `GET /turnstile`; CF's script runs in the **control-plane origin** and `postMessage`s only the token to the parent, which accepts it **only** from the control-plane origin (`event.origin` check). The token is single-use + useless without the master-key provision flow, so `frame-ancestors` is intentionally **not** locked yet (harden once the live parent origin is confirmed in a browser). **Vault CSP barely changes** because Tauri runs `csp:null` and the static server sets no CSP — only the SvelteKit **dev** CSP needed `frame-src https://connect.mycelium.id`.
- **O4 billing — no Stripe SDK.** Implemented over `fetch` + `node:crypto` (mirrors `turnstile.js`). Two wins: dependency-light control plane, and webhook signature verification is a **pure local HMAC** → fully hermetic to test. `verifyWebhook` is fail-closed (bad/stale/forged → `null`, never throws), with timestamp tolerance + constant-time compare + secret-rotation (multiple `v1`).
- **O5 — entitlement gate placement.** The gate sits **after** the atomic `registry.claim()` + name-exists check but **before** any acme-dns/DNS/cert side-effect or daily-cap spend. Unentitled → `setHold` + `402 {checkoutUrl}`. This *is* the bot/abuse defense ("no free side-effects").
- **O6 — must be gated on `requireEntitlement = billing.enabled`.** `registry.isEntitled` is **fail-closed** (no entitlement row → false), so an *un*gated check would reject every proxy on a free self-hosted relay (which has no entitlements). Wired `requireEntitlement: pay.enabled`. Entitlement is read **locally** from the registry → a Stripe outage never drops live tunnels.
- **O7 — billing nonce decoupling (subtle but important).** `/v1/challenge` is Turnstile-gated, so billing/release can't reuse it without forcing a bot-check. Solution: billing has its **own in-memory nonce store** via `GET /v1/billing/nonce` (ungated — billing is signature-gated, and an unentitled key just 404s). Crucially, a billing nonce is **rejected by `/v1/provision`** (separate store) so the ungated path **cannot** bypass the provision bot-gate. Verified P21. (Release still best-effort under Turnstile — pre-existing, see gotchas.)
- **Settings reorg — wrapped in place, no reordering.** 7 contiguous category panes (`{#if activeTab===…}`) around the existing sections, inserted by line number bottom-to-top. No section internals changed. Tailwind `space-y-6` still spaces siblings because Svelte `{#if}` adds no DOM node.

### Operator's directional calls this session

- "Merge #99, then I smoke locally" → #99 (O1/O2-backend/O3) merged to main.
- Chose **sandboxed iframe** for the Turnstile widget (vs. direct script) — security over simplicity.
- "do it [O4–O7], and clean up settings — think apple and claude" → built O4–O7 + the category-pane reorg.
- "lets continue" → O9/O10/O11 + O8 partial.
- "save it as a handoff and in memory, and merge to main so i can build and test the app locally" → this doc + merge.

### Failed approaches / dead ends avoided

- Considered **moving the Turnstile gate from `/v1/challenge` to `/v1/provision`** to unblock billing/release nonces. Rejected as too much churn on already-committed (browser-unvalidated) O2; the **dedicated billing nonce store** achieves the same decoupling with far less blast radius.
- Considered a **timestamp-freshness** billing claim (no nonce) — rejected: a captured claim could be replayed within the window to open the victim's portal. The dedicated nonce store gives full replay protection.
- Hit a real bug while writing `server.js`: used **literal U+2028/U+2029** chars inside a regex literal in the `/turnstile` HTML escaper → "Invalid regular expression: missing /" at module load. Fixed to ` `/` ` escapes. (Watch for this if editing that escaper.)

---

## Files created / significantly modified

**Control plane (`mycelium-managed/src/`)**
- `billing.js` **(new)** — Stripe wrapper (checkout / webhook verify / portal), opt-in + fail-closed.
- `turnstile.js` (pre-session) — bot-gate verifier; unchanged this session.
- `server.js` — `/v1/config`, `/turnstile` HTML, billing into `createControlPlane({billing,turnstileSitekey})`, `/v1/stripe/webhook` (raw, before `express.json`), `/v1/provision` 402 gate, `/v1/billing/{nonce,portal}`, relay-hook `requireEntitlement`. Constants `HOLD_TTL_MS`/`GRACE_MS`/`PROVISIONAL_MS`.
- `registry.js` — `getEntitlementByCustomer` (customer→publicKey reverse lookup).
- `relay-hook.js` — `authorizeNewProxy` lapsed-tenant gate (`requireEntitlement`,`graceMs`).

**Client (`src/remote/`)**
- `managed-claim.js` — `'billing'` added to `CLAIM_ACTIONS`.
- `router.js` — `/managed/turnstile` (sitekey+origin), 402 surfacing in `/connect-managed`, `/managed/billing-portal`, `controlPlaneUrl`/`relayAddr` in `/status`.

**Portal (`portal-app/src/`)**
- `lib/components/settings/ManagedConnectSection.svelte` — iframe widget + token gating + 402 "Pay €1/mo" + "Manage billing" + sovereignty/lifecycle copy.
- `lib/components/settings/RemoteAccessSection.svelte` — own-relay advanced fields + sovereignty copy.
- `lib/views/SettingsView.svelte` — category-pane nav (`activeTab`, `TABS`).
- `src/hooks.server.ts` — dev CSP `frame-src`.

**Tests (`scripts/`)** — `verify-billing.mjs` **(new)**; `verify-turnstile.mjs`, `verify-provision.mjs`, `verify-newproxy-auth.mjs` extended. `package.json` registers `verify:billing` + `verify:turnstile` in the chain.

---

## Env vars (operator must set to turn the paid path ON — all OFF by default)

| Var | Where | Purpose |
|---|---|---|
| `MYC_TURNSTILE_SECRET` | control-plane env | Turnstile siteverify secret (enables the bot-gate) |
| `MYC_TURNSTILE_SITEKEY` | control-plane env | public sitekey served via `/v1/config` (enables the widget) |
| `MYC_TURNSTILE_MOCK=1` | control-plane env | hermetic/staging bypass (token `mock-pass`) |
| `MYC_STRIPE_SECRET` | control-plane env | Stripe API key (enables billing → the 402 paywall + relay gate) |
| `MYC_STRIPE_WEBHOOK_SECRET` | control-plane env | `whsec_…` — webhook signature verification |
| `MYC_STRIPE_PRICE_MONTHLY` / `_ANNUAL` | control-plane env | the two Stripe Price IDs |
| `MYC_APP_RETURN_URL` | control-plane env | deep-link base for Checkout success/cancel |
| `MYC_HOLD_TTL_MS` / `MYC_GRACE_MS` | control-plane env | reservation TTL (30 min) / lapse grace (3 days) — design decision #4 numbers |

**⚠️ Do NOT set `MYC_TURNSTILE_SECRET` on the live control-plane until the widget passes its WebKit smoke** — the app sends no token until the widget renders, so an enabled gate would 403 the in-app Connect.

---

## Production state

- **main** = (after this session's merge) contains O1–O11. Verify: `git log --oneline -1 origin/main` should show the merge commit for PR #105's branch.
- **No live infra changed.** The control-plane relay/DNS/acme-dns/LE stack standing-up is still the operator's deploy (unchanged). Distribution (Tauri/npm) is unshipped; the Mac app is built on the Mac (`src-tauri/BUILD-MAC.md`).
- Re-confirm the gates locally:
  ```
  npm run verify:turnstile && npm run verify:billing && npm run verify:provision \
    && npm run verify:newproxy-auth && npm run verify:entitlement \
    && npm run verify:managed-claim && npm run verify:remote-config
  # each prints VERDICT: GO
  (cd portal-app && npm run build)   # adapter-static; must end "✔ done"
  ```

---

## Gotchas + lessons (dated 2026-06-06)

- **Tauri runs `csp: null`** (`src-tauri/tauri.conf.json`) and the static server sets no CSP — so the strict CSP in `portal-app/src/hooks.server.ts` only applies in `npm run dev`. The iframe widget works in the app/local-server without CSP changes; only dev needed `frame-src`.
- **`registry.isEntitled` is fail-closed** — any new entitlement check MUST be gated on billing being enabled, or free self-hosters get rejected.
- **`/v1/stripe/webhook` must be registered before `express.json`** to receive raw bytes (the HMAC is over the exact bytes). It's wired before the global `app.use(express.json())`.
- **Release is still best-effort under Turnstile** — `/disconnect` calls the Turnstile-gated `/v1/challenge` for its nonce; when Turnstile is on it 403s and the remote release is skipped (local disconnect still succeeds). Pre-existing; billing fixed its own version via the dedicated nonce store. If this matters, give release the same dedicated-nonce treatment.
- **Never put literal U+2028/U+2029 in a JS regex literal** (broke `server.js` module load once this session).
- **The GitHub MCP by-number PR endpoints (`/pulls/{n}`) flaked with 404s** repeatedly this session while `list`/`actions` worked — both #99 and #105 merges were completed via **local git merge + push to main** (the user authorized the merge each time). `update_pull_request` eventually recovered.

---

## Open decisions for the operator

1. **Two smokes before enabling live keys** (design §11 gates): Stripe **test-mode** €1 sub drives `paid_until`; then the **WebKit** widget smoke. Recommendation: run both before setting any live secret.
2. **Exact annual price** (design decision #5) — wire is done (two Price IDs); the number is a config value.
3. **`GRACE_MS` / `HOLD_TTL` / `RELEASE_GRACE` numbers** (design decision #4) — currently 3 days / 30 min; confirm. (`RELEASE_GRACE` sweep of lapsed handles is **not yet wired** — `sweepExpiredHolds` exists for unpaid placeholders, but a 30-day-lapsed-handle sweeper is a TODO.)
4. **O8 first-run wizard + QR** — the only remaining build item. Recommendation: build with eyes on the screen (it's a net-new onboarding flow).
5. **`frame-ancestors` hardening** on the control-plane `/turnstile` page — defer until the live parent origin (Tauri webview origin) is confirmed in a browser.

---

## Pickup protocol (execute in order)

1. Read this handoff cold, then the **as-built O-rows** in `docs/DESIGN-onboarding-and-relay-billing-2026-06-05.md` (§5.1 table) and §6 threat model.
2. Verify main has the work: `git log --oneline -8 origin/main` shows commits `f2b7234`…`b9cb3cc` (or their merge commit).
3. Re-run the gate block under **Production state** → all `VERDICT: GO` + portal build `✔ done`.
4. If continuing the feature: the next build item is **O8** (first-run wizard step + QR) — `portal-app/src/lib/components/OnboardingGuide.svelte` is the existing onboarding component (note: its "AI" step is the *inference provider*, not reachability). Run `/sweep-first-design` first.
5. If wiring the **`RELEASE_GRACE` sweeper** (open decision #3): `registry.sweepExpiredHolds` is the model; add a lapsed-handle sweep + a `ratelimit.js`-style tick.
6. Any change to `server.js` auth/CORS, `auth.js`, discovery, or `/mcp` is **NOT verified** until the MCP Inspector connects in a **real WebKit browser** (CLAUDE.md remote-MCP rule).
7. Run `/deploy-and-verify` after any change; `/handoff-discipline` at session end (append a dated section here).

---

## Skills that fired this session

`/handoff-discipline` (this doc). The verify-ledger-first discipline (`/deploy-and-verify` spirit) governed every commit — each shipped with its `verify:*` GO. No `/pre-deletion-caller-audit` needed (all additive; the only "delete" was the O2 gate-relocation, which was rejected in favor of additive decoupling).
