# Design — Onboarding, Account Creation & Relay Billing (2026-06-05)

> **Status:** DESIGN + IN-BUILD (sweep-first). **3 sweep cycles** + own-eyes
> verification of every load-bearing claim. **Landed so far:** O1 (managed-connect
> UI wired), O3 (entitlement layer), SEC-1 (registry.db at-rest hardening). The
> data-storage & security model is **§15** (the dedicated security sweep).
> **Question it answers:** how does a user create a handle, connect a custom
> domain / their own relay, and *when do we charge* — given that we want to
> **filter bots and charge €1/$1 per month for our managed relay, free if they
> bring their own**?
> **Companions:** [`REMOTE-CONNECT-AUTO-PROVISION-DESIGN-2026-06-02.md`](REMOTE-CONNECT-AUTO-PROVISION-DESIGN-2026-06-02.md)
> (the handle-claim flow), [`REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md`](REMOTE-CONNECT-MANAGED-DESIGN-2026-06-02.md)
> (the control-plane), [`DESIGN-relay-and-gateway-2026-06-04.md`](DESIGN-relay-and-gateway-2026-06-04.md)
> (the as-built FRP/Caddy passthrough relay).

---

## 0. TL;DR

- **Handle creation is already built end-to-end at the API level** but **invisible
  in the app**: `ManagedConnectSection.svelte` (handle input → availability →
  connect) exists and `POST /api/v1/remote/connect-managed` drives the full
  ed25519-signed `/v1/challenge` → `/v1/provision` control-plane flow — but the
  Svelte component **is not imported into `SettingsView.svelte`** (orphaned). The
  first build step is *wiring*, not new infra.
- **The tenant's only identity is its ed25519 public key.** The control-plane
  registry has **no email, account, customer, or payment column**. This is a
  feature (anonymous, sovereign), and it's the whole design constraint for billing.
- **The right model is NOT a new account system.** Keep "publicKey is the
  identity"; add exactly one binding: `publicKey → {stripe_customer_id, paid_until}`
  on the registry row. Stripe holds the card + email + dunning; we hold a date.
- **Charge only the managed relay.** `own-relay` and `direct` (custom-domain)
  modes never touch the control-plane → **free, by construction, with zero new
  code**. The €1/mo gate lives only on the `<handle>.mycelium.id` path.
- **Bots are filtered by two cheap gates, not one:** (1) a **Turnstile** token on
  `/v1/challenge`, and (2) **payment-before-side-effects** — the expensive,
  cert-slot-consuming acme-dns/DNS provisioning only runs for an entitled
  publicKey. A bot can at most burn a swept placeholder claim + a Turnstile
  solve. The €1 card itself is the ultimate human-proof.
- **Charge point = "reserve then pay":** reuse the registry's existing TOCTOU
  placeholder. `claim()` holds the handle for the publicKey; if not entitled,
  `/v1/provision` returns `402` + a Checkout URL and keeps the hold; the Stripe
  webhook flips `paid_until`; provisioning completes on the entitled re-call.

---

## 1. Goal & non-goals

**Goal.** A coherent onboarding that takes a fresh user from vault creation to a
working AI connection, with three clearly-priced reachability choices:
- **`<handle>.mycelium.id` (managed relay)** — one handle field, one card, €1/mo.
- **Your own domain (`direct`)** — public :443 on the user's box, their cert. Free.
- **Your own relay (`own-relay`)** — user runs the open-source control-plane +
  FRP relay themselves. Free.

**Non-goals (this design).**
- A multi-user account system on the control-plane (we bind to publicKey instead).
- Porting the canonical managed-tier billing (`reference/server-routes/portal-billing.js`
  keyed by `user_id`, €15/mo hosting) — that's a *different* product (managed
  *hosting*, not a *relay*). We borrow its Stripe-webhook *shape*, not its schema.
- Our own email/SMTP infrastructure (none exists in V1; Stripe sends receipts +
  dunning). Deferred until there's a need Stripe can't cover.
- Crypto payment (CoinGate) — the reference has it; defer to a fast-follow.
- Metering bandwidth/usage beyond the existing server-side `bandwidth_limit` clamp.

---

## 2. Revision history

- **v1 (this doc).** Pivots forced by the sweep against live code:
  - **Pivot A — "no account system" stays true.** The auto-provision design (§1
    non-goals) already declared "no full mycelium account system… ed25519-signed
    claims, not passwords/OAuth." Billing does **not** overturn this: we add a
    `paid_until`/`stripe_customer_id` *binding to the existing publicKey*, not a
    user table. The reference `subscriptions` table keyed by `user_id`
    (`portal-billing.js:77`) is the **wrong** template here — it's the managed-
    *hosting* tier with real accounts; we are the *relay* tier with anonymous keys.
  - **Pivot B — the bot barrier is payment + Turnstile, not the signature.** The
    sweep confirmed in-code that the ed25519 gate "is free to satisfy with a
    throwaway key, so rate is the real control" (`mycelium-managed/src/ratelimit.js:2-3`).
    So bot-filtering must be a *new* layer; the design adds Turnstile at challenge
    and gates the expensive provisioning side-effects behind entitlement.
  - **SEC-1 (security sweep, cycle 3) — registry.db hardened at rest in code.** The
    control-plane registry.db holds every tenant's `frps_token` (a bearer credential)
    AND the Stripe linkage, but had **no** `chmod` (default 0644), while the Mac's
    equivalent auth.db hardens to 0600. Mirrored `hardenDbPerms` into `openRegistry`
    (0600/0700). Full data-storage & security model in **§15**.
  - **Pivot D — entitlement is a separate table keyed by `public_key`, not columns
    on `handles` (found building O3).** The sketch (§4.3 v1) put `paid_until` on the
    `handles` row, but `release()` deletes that row — losing the sub on
    release+reclaim/rename, which the design explicitly forbids ("keyed by
    publicKey… without losing their sub"). Pivoted to an `entitlements(public_key
    PK …)` table that survives handle release. `verify:entitlement` E4 is the proof.
  - **Pivot C — charge the relay, not provisioning-in-general.** Free modes
    (`own-relay`/`direct`) never reach the control-plane (`src/remote/runtime.js:153`
    only renders frpc for relay modes; `direct` is Caddy-only on public :443), so
    "free if you bring your own" needs **no enforcement code** — it's the absence
    of a control-plane round-trip.

---

## 3. Sweep findings (consolidated, cited)

### 3.1 Handle creation — built, but the UI is orphaned
- `portal-app/src/lib/components/settings/ManagedConnectSection.svelte` implements
  handle entry (regex `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`), debounced availability
  via `GET /api/v1/remote/managed/available?handle=`, and `POST
  /api/v1/remote/connect-managed`. **Verified not imported** anywhere
  (`grep -rn ManagedConnectSection portal-app/src` → no import; `SettingsView.svelte`
  renders only `RemoteAccessSection`). `LocalConnectSection.svelte` (stdio
  `.mcp.json` helper) is likewise orphaned.
- `src/remote/router.js:137-192` `POST /connect-managed`: requires an operator
  password (`operatorUserExists()`), requires the unlocked vault
  (`process.env.ENCRYPTION_MASTER_KEY`), calls the **configured** control-plane
  only (`readRemoteConfig().controlPlaneUrl`, https-enforced), runs
  `GET /v1/challenge` → `buildClaim('provision', …)` → `POST /v1/provision`,
  **validates the untrusted response** (host must start with `${handle}.`, creds
  injection-safe), stores `relayToken`+`acmeDns` via `setRemoteSecret`, writes
  `remoteMode:'managed'`, materializes frpc+Caddy configs, returns
  `{ host, connectorUrl, restartRequired:true }`.
- Control-plane: `mycelium-managed/src/server.js` — `/v1/challenge`, `/v1/handle/:h`,
  `/v1/provision`, `/v1/release`, `/frps/handler`. Provision is TOCTOU-safe:
  `registry.claim()` inserts an atomic placeholder (`registry.js:38-44`) **before**
  any external side-effect, with rollback (`server.js:93-96`).

### 3.2 Identity binding — publicKey only
- `mycelium-managed/src/registry.js:13-21` schema: `handle, public_key, frps_token,
  acme_subdomain, active_run_id, active_at, created_at`. **No email / account /
  customer / payment field.** `server.js:4` ("NEVER sees the master key or any
  vault data — only {action, handle, publicKey, nonce, signature}").
- `src/remote/managed-claim.js`: the claim signs
  `mycelium-handle-claim:v1:<action>:<handle>:<nonce>` with the vault master key's
  ed25519 identity. **The master key is the credential**; possession proves
  ownership for provision *and* release (action-bound).

### 3.3 Free vs paid is already structural
- `src/remote/runtime.js:122-156`: `direct` → Caddyfile only (public :443, no
  relay, no control-plane); `own-relay` → same frpc+Caddy as `managed` but with
  user-supplied `relayAddr`/`controlPlaneUrl` (`src/remote/config.js:36-38`
  defaults overrideable). Only `managed` points at `connect.mycelium.id`.

### 3.4 Bot controls today — thin
- `mycelium-managed/src/ratelimit.js`: per-IP token bucket (20 cap, 20/min,
  bounded 50k-IP map) + a **global** daily new-handle cap (default 40,
  `MYC_MAX_NEW_HANDLES_PER_DAY`) sized to stay under Let's Encrypt's
  50-certs/registered-domain/7-days ceiling (`server.js:8-9`). The ed25519 sig is
  **not** a bot barrier (defeatable with a throwaway key, per the file's own
  comment). `RESERVED` set blocks infra names (`server.js:24`). Nonce is single-use,
  5-min TTL (`nonce.js`). **No captcha / Turnstile / PoW anywhere in the tree.**
- Provisioning's real cost per handle: 1 acme-dns account (`acmedns.js`,
  deregister is a no-op so they orphan), 2 DNS records (`dns.js:47-54`), and most
  scarce: 1 slot against the weekly LE cert ceiling.

### 3.5 Enforcement chokepoints for entitlement
- `mycelium-managed/src/relay-hook.js`: `authorizeLogin` (token→handle exists?) and
  `authorizeNewProxy` (token→row, host==handle, single-active-proxy, server-side
  bandwidth clamp). **`authorizeNewProxy` is the live gate every tunnel passes on
  every (re)connect** — the right place to deny an unpaid/lapsed tenant
  (`reject_reason:'subscription required'`). `/v1/provision` is the right place to
  deny *new* unpaid provisioning.

### 3.6 Precedents we can reuse
- **Outbound third-party API w/ stored secret:** `src/inference/cloud.js` (BYOK
  keys, never logged) — the pattern a Stripe client follows. Control-plane secrets
  today live as env (`MYC_DNS_TOKEN`, etc., `server.js:main()`); a `STRIPE_SECRET`
  fits the same env model (server-side only, never to the client).
- **Webhook-driven entitlement shape:** `reference/server-routes/portal-billing.js`
  (Stripe customer-portal session + webhook → `subscriptions.status/current_period_end`).
  Borrow the *shape* (webhook flips a stored date), not the `user_id` schema.
- **Untrusted-response validation:** `src/remote/router.js:168-177` (already
  validates the control-plane's reply) — extend for a `checkoutUrl`.
- **better-auth** (`src/auth.js`) is strictly the single-operator OAuth gate — **not**
  a customer-account host. Don't try to make it one.

---

## 4. Architecture

### 4.1 The three reachability choices (and who pays)

```
                          ONBOARDING → "Connect an AI" step
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
 <handle>.mycelium.id            Your own domain (direct)        Your own relay (own-relay)
 MANAGED RELAY — €1/mo           public :443 on your box         you run the control-plane
   control-plane round-trip      Caddy-only, your ACME cert        + FRP relay yourself
   Turnstile + Stripe gate       NO control-plane contact         NO mycelium contact
        │                               │                               │
        ▼                               ▼                               ▼
   PAID PATH (§4.2)                 FREE (no code)                  FREE (no code)
```

The two free paths require **no new enforcement** — they never call
`connect.mycelium.id`. "Free if you bring your own" is the *absence* of a round-trip.

### 4.2 The paid managed path — "reserve, then pay"

```
app (Settings → Connect → "Use mycelium.id")
  │ 1. GET /v1/handle/:h  (free availability check — already built)
  │ 2. user solves Turnstile widget (app embeds it)        ◄── NEW bot gate #1
  ▼
control-plane /v1/challenge?cf_turnstile=<token>           ◄── verify Turnstile, issue nonce
  │ 3. app: buildClaim('provision', handle, nonce)  (ed25519, master key)
  ▼
control-plane POST /v1/provision { handle, publicKey, nonce, signature, cf_turnstile }
  │ a. verify Turnstile + nonce + signature (fail-closed, as today)
  │ b. registry.claim() → atomic PLACEHOLDER hold for this publicKey (as today)
  │ c. ENTITLEMENT CHECK on the row's paid_until:                 ◄── NEW gate #2
  │      • entitled  → run acme-dns + DNS + frps token + finalize (as today) → 200
  │      • NOT entitled → create Stripe Checkout Session
  │            (client_reference_id = publicKey, metadata.handle = h,
  │             success/cancel → deep-link back to the app),
  │          KEEP the placeholder (held ≤ HOLD_TTL), return 402 { checkoutUrl }
  ▼
app opens checkoutUrl in the browser → user pays €1/mo
  ▼
Stripe webhook → control-plane POST /v1/stripe/webhook                  ◄── NEW
  │  on checkout.session.completed / invoice.paid:
  │    registry.setEntitlement(publicKey, { stripe_customer_id, paid_until })
  │  on invoice.payment_failed / subscription.deleted:
  │    clear/expire paid_until (lapses → relay-hook denies on next reconnect)
  ▼
app re-calls /v1/provision (now entitled) → side-effects run → 200 { host, relayToken, … }
  ▼
local: write remoteMode='managed', materialize frpc+Caddy, restart → tunnel up
  ▼
relay-hook authorizeNewProxy: token→row, host==handle, AND paid_until>now → ALLOW
                                                         └── NEW: lapsed → reject
```

### 4.3 Schema delta (control-plane registry) — **as built (O3)**

**Pivot from the v1 sketch (see revision history Pivot D):** entitlement is a
**separate `entitlements` table keyed by `public_key`**, NOT columns on `handles`.
`release()` deletes the `handles` row, so storing `paid_until` there would lose the
subscription on release+reclaim/rename — contradicting the "keyed by publicKey,
survives release" requirement. Stripe binds customer→subscription independent of
any name; we mirror that.

```sql
CREATE TABLE entitlements (          -- keyed by the tenant's stable identity
  public_key         TEXT PRIMARY KEY,
  stripe_customer_id TEXT,           -- null until first checkout; retained on lapse
  paid_until         INTEGER,        -- epoch ms; tunnel allowed while now < paid_until (+grace)
  updated_at         TEXT
);
ALTER TABLE handles ADD COLUMN hold_expires_at INTEGER;  -- reservation sweep deadline (handle-scoped)
```

Registry methods (`mycelium-managed/src/registry.js`): `setEntitlement({publicKey,
stripeCustomerId,paidUntil})` (upsert, COALESCEs a null customer id so a webhook
that only moves the date can't wipe it), `getEntitlement(publicKey)`,
`clearEntitlement(publicKey)` (zeros `paid_until`, keeps the customer id for
one-click re-sub), `isEntitled(handle, now, graceMs)` (joins
`handles.public_key → entitlements`, **fail-closed**), `setHold(handle, ts)` (marks
a placeholder only), `sweepExpiredHolds(now)` (deletes expired UNPAID placeholders —
`frps_token=''` — never a live handle). `finalize()` now clears the hold.
Verified: `verify:entitlement` E1–E7 GO.

### 4.4 Where the relay denies a lapsed tenant

`authorizeNewProxy` (`relay-hook.js:24`), right after the `row = getByToken(token)`
lookup, before the allow return:

```js
if (!registry.isEntitled(row.handle, now(), GRACE_MS))
  return { reject: true, reject_reason: 'subscription required' };
```

`Login` stays as-is (token validity only) so a lapsed user still authenticates and
gets a *legible* NewProxy rejection (not a confusing auth failure). A grace window
(e.g. 3 days past `paid_until`) absorbs Stripe retry/dunning before the tunnel drops.

---

## 5. The onboarding sequence (what the user walks through)

Today: vault creation (`portal-app/src/routes/setup/+page.svelte`) is first-run;
remote connect is **Settings-only and not in onboarding** (sweep-confirmed). The
proposed coherent journey:

1. **Create / restore vault** — unchanged (the ONE recovery key ceremony,
   `setup/+page.svelte`). Fail-closed, key saved or restored.
2. **Land in the app** (auth-shim, no login wall). Empty vault → welcome → Import.
3. **Import** your AI history (Claude/ChatGPT zip) — unchanged.
4. **"Connect an AI" card** (NEW onboarding step, also reachable in Settings):
   a. **Set an operator password** (≥12; the *only* authz on `/mcp` —
      `config.js setOperatorPassword`). Required before any remote mode.
   b. **Choose reachability** (the §4.1 three-way):
      - **mycelium.id (recommended, €1/mo)** → handle field (wire
        `ManagedConnectSection`) → Turnstile → Checkout → restart → URL + QR.
      - **My own domain** → enter FQDN, app gets a cert via ACME (`direct` mode).
      - **My own relay** → enter `relayAddr` + `controlPlaneUrl` (advanced).
   c. **Show the connector URL + QR + "Add to Claude" instructions** (the existing
      `connectorUrl` return + a copy/QR affordance).
5. **Manage subscription** (Settings) → "Manage billing" opens the Stripe Customer
   Portal via a **signed** `/v1/billing/portal` claim (cancel, update card, see
   `paid_until`). Lapse → tunnel stops at next reconnect; handle held `RELEASE_GRACE`
   days then swept so the name frees.

### 5.1 Onboarding gaps this surfaces (the work list)

| # | Gap | Size |
|---|-----|------|
| O1 | ✅ **DONE (2026-06-05)** — wired `ManagedConnectSection` into `SettingsView` (above `RemoteAccessSection`). `LocalConnectSection` intentionally **not** wired: `ConnectYourAISection` already covers the local-connect story; a second surface would confuse. `verify:remote-config` + `verify:portal-serve` GO, portal build clean. | S |
| O2 | 🟡 **BACKEND DONE (2026-06-05)** — bot-gate landed + verified. `src/turnstile.js` (new): `createTurnstileVerifier({secret,mock})` → `verify(token,ip)`, **opt-in** (disabled with no secret/mock so self-hosters + hermetic CI don't need Cloudflare) + **fail-closed** (missing/bad/unverifiable token → reject; never throws). `server.js` gates `GET /v1/challenge` on the token (`?cf_turnstile=…`) → 403 `'bot check failed'`, no nonce leaked. **As-built decision: verification is SINGLE-SIDE on `/v1/challenge` only** (not also `/v1/provision`) — the nonce is single-use and carries the human-proof forward to provision, so we never double-verify a single-use token. Secret is env-only (`MYC_TURNSTILE_SECRET`, the `MYC_DNS_TOKEN` pattern; mock via `MYC_TURNSTILE_MOCK=1`). `router.js` `/connect-managed` forwards an optional `turnstileToken` to the gated challenge. `verify:turnstile` GO (T1–T17); `verify:provision`/`entitlement`/`newproxy-auth`/`managed-claim`/`remote-config` regressions GO. **WIDGET BUILT (2026-06-05) — SANDBOXED-IFRAME (user decision)**: rather than load Cloudflare's script into the vault portal origin, the control-plane serves `GET /turnstile` (a tiny page that runs the CF script in **its** origin and `postMessage`s only the token up); `ManagedConnectSection` embeds it in a **cross-origin iframe** and accepts the token only from the control-plane origin (`event.origin` check), gating Connect on it. Sitekey reaches the app via `GET /v1/config` → loopback `GET /managed/turnstile` (`{sitekey,origin}`, fail-open to null = no widget). Vault CSP barely changes (Tauri `csp:null` + static-server no-CSP → unaffected; SvelteKit **dev** CSP gains `frame-src https://connect.mycelium.id` only). Hermetic verify GO + portal builds clean + `svelte-check` clean. **PENDING: WebKit browser smoke** on the Mac (CLAUDE.md remote-MCP discipline) — render the widget, solve it, confirm the token gates Connect + provisions; and confirm the live parent origin (for a future `frame-ancestors` tighten on `/turnstile`). | M |
| O3 | ✅ **DONE (2026-06-05)** — `entitlements` table keyed by `public_key` (Pivot D) + `hold_expires_at` + `setEntitlement`/`getEntitlement`/`clearEntitlement`/`isEntitled`/`setHold`/`sweepExpiredHolds`; `finalize()` clears holds. `verify:entitlement` GO (E1–E7); `verify:provision` + `verify:newproxy-auth` regressions GO. | S–M |
| O4 | ✅ **DONE (2026-06-05, hermetic; Stripe test-mode smoke pending)** — `mycelium-managed/src/billing.js` (new): `createBilling({secret,webhookSecret,priceMonthly,priceAnnual,returnUrl})` — **no SDK**, REST via `fetch` + `node:crypto` (mirrors `turnstile.js`), **opt-in** (off w/o `MYC_STRIPE_SECRET` → free provisioning) + **fail-closed**. `createCheckoutSession({publicKey,handle,plan})` binds the tenant in `client_reference_id` **and** subscription metadata, €1/mo (`automatic_tax` on, Stripe Tax); `verifyWebhook(rawBody,sig)` does the Stripe HMAC-SHA256 over `t.<rawBody>` with timestamp tolerance + constant-time compare + rotation (multiple `v1`) → event|**null**, never throws; `customerPortalSession` for O7. `server.js`: `POST /v1/stripe/webhook` registered **before** `express.json` (raw bytes) → `checkout.session.completed`/`invoice.paid` ⇒ `setEntitlement`, `payment_failed`/`subscription.deleted` ⇒ `clearEntitlement`; tenant recovered via `client_reference_id`/metadata, else `getEntitlementByCustomer` reverse lookup (new registry method). `verify:billing` GO (B1–B10). | M |
| O5 | ✅ **DONE (2026-06-05, hermetic; widget browser-smoke pending)** — "reserve, then pay" gate in `server.js /v1/provision`: after the atomic claim + name check, if billing on **and** `!isEntitled(handle, now, GRACE_MS)` → `setHold(handle, now+HOLD_TTL)` + create Checkout + **402 `{checkoutUrl}`**, **before** any acme-dns/DNS/cert side-effect or daily-cap spend (no free side-effects). Entitled (incl. via webhook) re-provision runs the side-effects → 200; reclaim never re-checkouts (no double-charge). `router.js /connect-managed` surfaces 402 → validates the URL is https → returns `{checkoutUrl}` to the UI; `ManagedConnectSection` shows a **"Pay €1/mo →"** link, then the user re-solves the bot check + Connects (now entitled). `HOLD_TTL`/`GRACE` env-tunable (decision #4). `verify:provision` extended P14–P17 GO (402+held+no-side-effects · signed-webhook→entitled→finalized · entitled-reclaim-no-2nd-checkout · forged-sig→400). Pending: Stripe test-mode end-to-end + the WebKit smoke of the Pay link. | M |
| O6 | **relay-hook entitlement gate** + grace window (§4.4) | S |
| O7 | **`/v1/billing/portal`** signed-claim → Stripe Customer Portal link; Settings "Manage billing" | S–M |
| O8 | **Onboarding "Connect an AI" step** (the three-way chooser + password + URL/QR) | M |
| O9 | **Own-domain (`direct`) + own-relay guided UI** (RemoteAccessSection only does URL+password today) | M |
| O10 | **Lapse/release lifecycle** — grace, tunnel-drop UX, handle hold-then-free, dunning copy | S |
| O11 | **Sovereignty disclosure copy** — what the relay sees (ciphertext only; TLS terminates on the Mac) vs. what the connected AI sees | S |

---

## 6. Threat model

| Surface | Risk | Mitigation |
|---|---|---|
| Free provisioning abuse (bots burning LE cert slots / DNS / acme-dns accounts) | a script claims thousands of handles | **Side-effects gated behind payment** (§4.2c): a bot reaches at most a swept placeholder + a Turnstile solve; the expensive path needs `paid_until`. Daily cap (`ratelimit.js`) stays as a backstop. |
| Throwaway-key signature spam | ed25519 sig is not human-proof | **Turnstile on `/v1/challenge`** raises per-attempt cost; nonce single-use bounds replay. |
| Card testing / payment fraud | bots probing stolen cards via Checkout | Stripe Radar (built-in) + €1 low-value; Checkout is hosted by Stripe (no PAN touches us). |
| Stripe webhook forgery | attacker flips `paid_until` for free | **Verify the Stripe-Signature** (`whsec_…`) on every webhook, fail-closed; bind to `client_reference_id == publicKey` only. |
| PII minimization | we don't want to hold cards/emails | We store **publicKey + stripe_customer_id + paid_until** only. Email/card live at Stripe. Registry still "never sees vault data" (`server.js:4`) — entitlement is metadata, not content. |
| Entitlement ↔ key coupling | losing the master key loses the sub | The sub is bound to publicKey; the **vault recovery key restores the identity**, so a restored vault re-proves ownership and keeps the sub. Document this. |
| Lapsed-but-still-up tunnel | a cancelled user keeps service | relay-hook denies on the **next** NewProxy; an established tunnel is killed by the active-proxy TTL refresh path. Grace window is deliberate, bounded. |
| Control-plane as a new paid SPOF | billing outage blocks tunnels | Entitlement is read **locally from the registry** by the relay-hook (no live Stripe call on the data path) — a Stripe outage doesn't drop tunnels; only new provisioning/webhooks pause. |

**Net sovereignty statement (UI copy, O11):** *Your data stays encrypted on your
Mac; TLS terminates on your Mac, so the relay only ever forwards ciphertext. Paying
€1/mo rents a name + a passthrough pipe — it does not give us your data. Bring your
own domain or relay to pay nothing.*

---

## 7. Module shape & LOC budget

Control-plane (`mycelium-managed/`):
- `src/registry.js` — +3 columns, +4 methods (~+45 LOC).
- `src/billing.js` **(new)** — `createCheckoutSession({publicKey,handle})`,
  `verifyWebhook(rawBody,sig)`, `customerPortalSession(customerId)`; thin Stripe
  wrapper, secret from env (~120 LOC).
- `src/turnstile.js` **(new)** — `verify(token, ip)` → bool (~40 LOC).
- `src/server.js` — Turnstile in `/v1/challenge`+`/v1/provision`; 402+checkoutUrl
  branch; `POST /v1/stripe/webhook` (raw body); `POST /v1/billing/portal`
  (signed-claim, reuse `claimMessage` with a new `'billing'` action) (~+90 LOC).
- `src/relay-hook.js` — entitlement gate + grace (~+8 LOC).
- `src/ratelimit.js` — a hold-sweeper tick (or fold into the nonce sweeper) (~+20 LOC).

Client (`src/` + `portal-app/`):
- `src/remote/managed-claim.js` — add `'billing'` to `CLAIM_ACTIONS` (~+2 LOC).
- `src/remote/router.js` — `/connect-managed` handles 402 (return checkoutUrl to
  the UI); new `GET /managed/billing-portal` (signed claim → portal URL) (~+40 LOC).
- `portal-app` — import + render `ManagedConnectSection`; add Turnstile widget,
  Checkout redirect + return-poll, "Manage billing" button, the three-way chooser,
  own-domain/own-relay forms (~+250 LOC Svelte).
- `src-tauri` — deep-link handler for Stripe success/cancel return (~+30 LOC Rust).

**Total ≈ 640 LOC** (±20%), heaviest in Svelte (UI) and the new `billing.js`.

---

## 8. Edge cases — explicit decisions

- **User pays but local save fails** → handle is provisioned + entitled; the app
  reports "provisioned, restart and retry" (existing pattern, `router.js:188`).
  Re-provision is idempotent (same publicKey reclaims, `registry.claim` reclaimed
  branch) and entitlement persists → no double charge.
- **User pays, never finalizes** → entitled but no DNS/frps. Next `/v1/provision`
  (re-open the app, click Connect) finds entitlement and completes. Placeholder
  hold is moot once entitled.
- **Reserved handle, abandons checkout** → `hold_expires_at` sweep frees the name;
  no Stripe customer created until `checkout.session.completed`.
- **Subscription lapses** → grace window, then relay-hook rejects NewProxy; after
  `RELEASE_GRACE` days the handle is swept (name freed) but `stripe_customer_id`
  retained against publicKey so re-subscribe is one click.
- **User switches managed → own-relay** → `/disconnect` best-effort releases the
  handle (existing `router.js:198`), and we should **cancel the Stripe sub** (call
  portal/cancel) so they stop being charged. Decision: disconnect offers "also
  cancel billing?".
- **Lost master key, restored from recovery key** → same ed25519 identity → same
  publicKey → sub intact. (If the key is lost *without* the recovery key, the vault
  is gone anyway; the sub becomes an orphan Stripe customer the user cancels via
  the Stripe email receipt.)
- **Two boxes, same key** → single-active-proxy already enforces one tunnel
  (`relay-hook.js:45-50`); one sub covers the identity, not the device.
- **`direct`/`own-relay` users** → never charged, never see Turnstile/Stripe.

## 8.1 Product decisions

**LOCKED (user, 2026-06-05):**
1. **Payment provider = Stripe + Stripe Tax.** Stripe Checkout (hosted, Radar
   fraud), Stripe Tax computes EU VAT; mycelium is merchant of record and files.
   Revisit Paddle only if EU VAT filing ops become painful. CoinGate crypto
   deferred (§14).
2. **Price = €1/mo AND a discounted annual.** Always surface the annual at
   Checkout — a €1 monthly charge loses ~25–35% to Stripe's fixed fee, so annual
   is the path to break-even. (Exact annual figure — e.g. €10/yr — TBD with the
   user; the build wires two Stripe Prices regardless.)
3. **Charge model = reserve then pay.** Hold the handle on a placeholder, gate the
   cert-consuming side-effects behind entitlement (402 + Checkout). This *is* the
   bot defense — no free side-effects. (No free trial.)

**STILL OPEN:**
4. **Grace + release windows** — `GRACE_MS` (proposed 3 days past `paid_until`
   before the tunnel drops, to absorb Stripe dunning) and `RELEASE_GRACE`
   (proposed 30 days before a lapsed handle is swept and the name freed). Numbers
   to confirm.
5. **Exact annual price** (decision 2) — wire two Prices; the number is a config
   value, not a structural choice.

---

## 9. Test strategy (by file, each a `verify:*` gate)

- `verify:billing` (new) — `billing.js` with a **mock Stripe**: checkout session
  carries `client_reference_id=publicKey`+`metadata.handle`; webhook signature
  verify is fail-closed (bad sig → no entitlement); `paid`/`failed`/`deleted`
  events flip `paid_until` correctly.
- `verify:turnstile` (new) — `verify()` fail-closed on bad/absent token; bypass via
  `MYC_TURNSTILE_MOCK=1` for hermetic CI (mirror `MYC_ACME_DNS_MOCK`).
- `verify:provision` (extend) — 402+checkoutUrl when unpaid; placeholder held;
  entitled re-call completes; reclaim doesn't double-charge.
- `verify:newproxy-auth` (extend, exists) — lapsed `paid_until` → NewProxy reject
  `'subscription required'`; within grace → allow; `direct`/`own-relay` unaffected.
- `verify:remote-config` (extend) — `/connect-managed` 402 path surfaces
  `checkoutUrl`; `direct`/`own-relay` never call the control-plane.
- Leak gate — extend `verify:providers-leak` technique: scan registry DB (+`-wal`/
  `-shm`) to assert **no card/PAN/email** ever lands there; only `stripe_customer_id`.

## 10. Implementation order (each independently shippable + smoke)

1. **O1 — wire the orphaned components** into Settings (no billing yet; managed
   connect works as a free dev path behind `MYC_TURNSTILE_MOCK`/no-Stripe). Smoke:
   click Connect → handle provisions on a mock control-plane.
2. **O3 — registry entitlement columns + methods + sweeper.** Smoke: `verify:provision`.
3. **O2 — Turnstile** (challenge gate + token forwarding). Smoke: `verify:turnstile` ✅ GO.
   Single-side on `/v1/challenge` (nonce carries the proof to provision). Widget = its
   own browser-verified slice (loads the CF script into the portal — WebKit smoke).
4. **O4/O5 — Stripe Checkout + webhook + 402 branch.** ✅ `verify:billing` (B1–B10) +
   `verify:provision` (P14–P17) GO. Pending: end-to-end on Stripe test mode (€1 test
   card → signed webhook → `paid_until` → entitled re-provision) before live keys.
5. **O6 — relay-hook gate + grace.** ◀ NEXT. Smoke: `verify:newproxy-auth`.
6. **O7 — billing portal + Settings "Manage billing".**
7. **O8/O9/O10/O11 — onboarding step, own-domain/own-relay UI, lifecycle, copy.**

## 11. Decision criteria for proceeding

- After step 1: a real user (the operator) provisions `<handle>.mycelium.id` via
  the in-app UI on the live control-plane (Turnstile/Stripe mocked) and Claude
  connects — proves the orphaned path works before money is added.
- After step 4: a Stripe **test-mode** €1 subscription drives `paid_until`; cancel
  in the test dashboard → relay-hook rejects within grace. Then enable live keys.

## 12. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| €1/mo eaten by Stripe fixed fees | High | Med | Offer annual (decision 8.2); €1 may be a loss-leader by design — accept explicitly. |
| EU VAT compliance on micro-payments | Med | High | Stripe Tax, or Paddle as merchant-of-record (decision 8.1). |
| Webhook spoof → free tunnels | Low | High | Signature verify fail-closed; entitlement read locally so a forged webhook is the only vector, and it's signed. |
| Turnstile adds friction / breaks headless | Med | Low | Mock env for CI/dev; Turnstile is invisible-mode by default. |
| Billing SPOF blocks existing users | Low | High | Relay-hook reads entitlement **locally** — Stripe down ≠ tunnels down. |
| Handle squatting via free reserve | Med | Low | Short `hold_expires_at`; Turnstile-gated; cap per IP/day. |

## 13. Verification table (every load-bearing assumption — read myself)

| Assumption | Verified at |
|---|---|
| `ManagedConnectSection` exists but is NOT imported (orphaned) | `grep -rn ManagedConnectSection portal-app/src` → no import; `portal-app/src/lib/views/SettingsView.svelte` imports only `RemoteAccessSection` |
| `/connect-managed` drives the full ed25519 challenge→provision flow, https-only, validates the untrusted response | `src/remote/router.js:137-192` (read) |
| Tenant identity is publicKey only — no email/account/customer/payment column | `mycelium-managed/src/registry.js:13-21` (read) |
| Provision is TOCTOU-safe via an atomic placeholder `claim()` before side-effects, with rollback | `mycelium-managed/src/registry.js:38-44`; `src/server.js:70,93-96` (read) |
| ed25519 sig is not a bot barrier; per-IP rate + daily new-handle cap are the real controls; cap sized to LE 50/7d ceiling | `mycelium-managed/src/ratelimit.js:1-3,36-51`; `server.js:8-9,34` (read) |
| No captcha/Turnstile/PoW/email/billing anywhere in `mycelium-managed/` | sweep grep (stripe/billing/payment/captcha/turnstile/email) → zero hits |
| `authorizeNewProxy` is the per-(re)connect gate; the place to deny a lapsed tenant | `mycelium-managed/src/relay-hook.js:24-54` (read) |
| Free modes never contact the control-plane: `direct` = Caddy-only, `own-relay`/`managed` add frpc; only `managed` defaults to `connect.mycelium.id` | `src/remote/runtime.js:122-156`; `src/remote/config.js:33-38` (read) |
| Stripe billing exists in the canonical repo keyed by `user_id` (wrong template — managed *hosting*, not relay) | `reference/server-routes/portal-billing.js:61-115` (read) |
| Outbound-third-party-API-with-stored-secret pattern to mirror for Stripe | `src/inference/cloud.js` (sweep, cited) |
| Untrusted control-plane response is already validated client-side (extend for checkoutUrl) | `src/remote/router.js:168-177` (read) |
| Operator password (≥12) is the only authz on `/mcp`; required before connect | `src/remote/router.js:141`; `src/remote/config.js setOperatorPassword` (read/sweep) |
| Setup/first-run does not include remote connect (it's Settings-only today) | `portal-app/src/routes/setup/+page.svelte` (sweep — no remote mention) |
| Registry already does idempotent `ALTER TABLE ADD COLUMN` migrations (template for entitlement cols) | `mycelium-managed/src/registry.js:23-25` (read) |

---

## 14. Open questions deferred (named, not lost)

- **Crypto payment (CoinGate)** — reference has it; defer to a fast-follow once
  Stripe is live.
- **Our own email/dunning** — none in V1; rely on Stripe's emails until a need
  Stripe can't cover appears.
- **Usage metering / fair-use on the relay** — only the server-side `bandwidth_limit`
  clamp exists; a heavy-abuse tier-up is out of scope.
- **HA for the control-plane registry** — in-memory rate-limit + single SQLite is
  single-instance (noted in `ratelimit.js`); shared-store HA is a separate ops task.
- **Multi-device under one sub** — single-active-proxy already enforces one tunnel;
  "team"/multi-handle plans are a future product question.

---

## 15. Data storage & security model (sweep cycle 3 — the data layer)

> Added after a dedicated 3-agent security sweep (storage topology · control-plane
> PII/de-anon · reference-billing patterns). Every claim below was read against
> source. This is the load-bearing security design for everything billing touches.

### 15.1 The storage map — every store the system writes

| Store | Location | Encryption at rest | File perms | What sensitive data | Verified |
|---|---|---|---|---|---|
| **Vault DB** | `<dataDir>/mycelium.db` (Mac) | **AES-256-GCM** envelope per `ENCRYPTED_FIELDS` (two-key) | ⚠️ **default 0644** (file itself unhardened; ciphertext only) | all user content/PII/health/wealth/topology — **encrypted** | `src/paths.js:53`, `src/crypto/crypto-local.js` |
| **auth.db** | `<dataDir>/auth.db` (Mac) | none (plaintext SQLite) | **0600 file / 0700 dir** (`hardenDbPerms`) | better-auth signing secret; **relay frps token + acme-dns creds** | `src/remote/config.js:47-50,128,157` |
| **remote.json** | `<dataDir>/remote.json` (Mac) | none — **non-secret by contract** | 0700 dir (best-effort) | none (publicHost/relayAddr/mode/email only) | `src/remote/config.js:86-112` |
| **macOS Keychain** | OS keystore (Mac) | OS-native | OS-managed | **USER_MASTER + SYSTEM_KEY**; data-loss guard | `src/account/keystore.js`, `key-source.js` |
| **registry.db** | `MYC_REGISTRY_DB` (control-plane VPS) | none (plaintext SQLite) | **0600 file / 0700 dir — NOW hardened (SEC-1)** | every tenant's **frps_token** (bearer cred) + acme_subdomain + **stripe_customer_id + paid_until** | `mycelium-managed/src/registry.js:11-30` |
| **nonces** | registry.db / in-memory | none (ephemeral) | inherits registry.db | single-use challenge values, 5-min TTL | `mycelium-managed/src/nonce.js` |
| **control-plane.env** | `/etc/mycelium/` (VPS) | none | **0600, owner `mycelium`** | `MYC_DNS_TOKEN` (+ future `STRIPE_*`, `TURNSTILE_SECRET`) | `relay/deploy/README.md:83-84,119,135` |
| **Stripe (external)** | Stripe | Stripe-managed | n/a | **email, card/PAN, name, address** — the real identity lives HERE, not with us | — |

**Key invariant:** the *real* customer identity (email, card) lives **only at
Stripe**. We never store, log, or transit it. Confirmed against the reference:
its `subscriptions` table holds `stripe_customer_id`/`status`/`current_period_end`
only — **no PAN** (`reference/server-routes/portal-billing.js:77`), i.e. PCI **SAQ A**
via hosted Checkout.

### 15.2 Secret-handling rules (which secret lives where, never crosses what)

| Secret | Lives in | Never touches |
|---|---|---|
| `USER_MASTER` / `SYSTEM_KEY` (vault) | Mac Keychain, memory after unlock | the wire, env, DB, logs, the control-plane |
| `frps_token`, acme-dns creds (per tenant) | Mac auth.db (0600) + control-plane registry.db (0600) | logs; the browser; remote.json |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TURNSTILE_SECRET` | **control-plane only**, in `control-plane.env` (0600, env-only — the `MYC_DNS_TOKEN` pattern) | **the Mac/app (it only opens a browser checkout URL)**; registry.db; logs |
| Turnstile **sitekey** (public) | the Mac app UI (it's public by design) | — |
| `stripe_customer_id`, `paid_until` | control-plane registry.db (0600) | the Mac (the app caches only a boolean "entitled" for UI, never the customer id) |

**Decision (Stripe placement).** The reference keeps Stripe creds off the
per-tenant box and in a central Worker (`portal-billing.js:134-141` proxies to a
Worker; this repo has **no** Stripe/webhook code). Our relay has no Worker — **the
control-plane *is* the central operator service**, so it is the correct Stripe
holder. The Mac never sees a Stripe secret: it requests provisioning via the signed
flow, gets a `402 + checkoutUrl`, and opens it in the browser. The Stripe secret and
webhook secret stay in `control-plane.env`.

### 15.3 The de-anonymization model (the honest core)

Today managed provisioning is **anonymous**: only `{publicKey, handle, nonce,
signature}` crosses the wire; the IP is used for an **in-memory** rate-bucket and is
**never persisted or logged**; the only `console.log` in the whole control-plane is
the bind address (`server.js` `main()`). Verified: no IP↔handle association in any
store, logging clean across `mycelium-managed/src/**`.

**Payment necessarily ends anonymity for the managed path.** The `entitlements` row
adds exactly one new identity bit — `stripe_customer_id` — which makes
`publicKey → handle → <handle>.mycelium.id (a public URL) → stripe_customer_id`
linkable **inside registry.db**. Via Stripe (breach/subpoena) that chains to a real
person. Design response:
1. **Minimize.** Store only `stripe_customer_id` + `paid_until`. **No email, name,
   card, or address** in registry.db (confirmed: those are the only entitlement
   columns). Stripe holds the rest.
2. **Harden the linkage at rest (SEC-1, shipped).** registry.db is now `0600`/`0700`
   in code (mirrors auth.db). Operator layers: `control-plane.env` 0600, loopback
   bind, **VPS full-disk encryption + split-box** (SEC-2, deploy doc).
3. **Disclose, don't pretend (O11, mandatory).** Onboarding copy must state: *the
   managed relay is a paid, identifiable service; for an anonymous setup, use your
   own domain/relay (free, no control-plane contact).* The free paths never reach
   us — anonymity is preserved there by construction (`src/remote/runtime.js:122-156`).

### 15.4 Webhook security (new public surface — must be fail-closed)

`POST /v1/stripe/webhook` is the **one public, unauthenticated-by-OAuth** billing
endpoint (Stripe POSTs to it). There is **no existing webhook/`constructEvent`/
`whsec` code in this repo** to lean on (verified zero hits) — build it to these rules:
- **Verify the `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET` on the raw body,
  fail-closed** (bad/absent signature → 400, no state change). Mirror the
  fail-closed `try/catch → bool` discipline of `verifyWithPublicKey`
  (`src/identity/identity.js:82-89`).
- **Idempotent on Stripe `event.id`** — a `processed_events(event_id PK, seen_at)`
  table, insert-or-ignore; a replay is a 200 no-op. Mirrors the nonce single-use
  (`DELETE … RETURNING`) + `captureMessage` content-hash dedup precedents.
- **Order-safe** — guard against out-of-order delivery (a stale
  `subscription.deleted` after a fresh `invoice.paid`): only move `paid_until`
  forward from `invoice.paid`/`current_period_end`; honor cancel only when the
  event's period matches/supersedes the stored one.
- **Rate-limit + 16kb body cap** already apply (`express.json({limit:'16kb'})`,
  per-IP bucket). Keep the webhook on the public edge; `/frps/handler` stays
  loopback-only (`relay/deploy/README.md`).
- **No PII in the response or logs** — ack with `{received:true}`; never echo event
  contents.

### 15.5 Hardening ledger

| ID | Item | State |
|---|---|---|
| **SEC-1** | registry.db at-rest perms `0600`/`0700` in code (it holds every tenant's frps_token + the Stripe linkage; default was 0644) | ✅ **DONE (2026-06-05)** — `verify:entitlement` + `verify:provision` GO; tmp registry.db observed `600` |
| **SEC-2** | Deploy doc: require **VPS full-disk encryption** + reaffirm split-box (registry.db is now a PII-linkage store, not just infra metadata) | ⬜ doc edit (O-deploy) |
| **SEC-3** | Webhook: signature verify (fail-closed) + `processed_events` idempotency + order-guard | ⬜ part of O4 |
| **SEC-4** | Turnstile secret → `control-plane.env` (env-only, never Mac/DB/logs); sitekey in app | ✅ secret is `MYC_TURNSTILE_SECRET` env-only, sent in the siteverify POST body (never URL/log), absent from all responses (`verify:turnstile` T12). Public sitekey served from the control-plane (`MYC_TURNSTILE_SITEKEY` → `/v1/config`), never baked into the app build; the widget runs CF's script in a sandboxed iframe (control-plane origin), so CF code never touches the vault origin. |
| **SEC-5** | `processed_events` + entitlement writes confined to the webhook path; `verify:billing` leak-scans registry.db (+`-wal`/`-shm`) for any email/PAN sentinel | ⬜ part of O4 |
| **SEC-6** | *(out of billing scope, flagged)* Vault DB file is default **0644** (ciphertext, single-user Mac → low sev, but DiD says harden) — chmod `mycelium.db` 0600 at open | ⬜ deferred, separate from billing |

### 15.6 Security verification table (read myself)

| Assumption | Verified at |
|---|---|
| registry.db had **no** chmod hardening (default 0644) before SEC-1; auth.db does (`hardenDbPerms` 0600/0700) | `grep chmod mycelium-managed/src` → none (pre-fix); `src/remote/config.js:47-50` |
| registry.db now hardened in code; observed `600` | `mycelium-managed/src/registry.js:11-24` (read); runtime `mode: 600` |
| Control-plane stores only `{public_key, stripe_customer_id, paid_until}` for billing — no email/PAN | `mycelium-managed/src/registry.js` entitlements DDL (read) |
| Provisioning is anonymous; IP never persisted/logged; one benign `console.log` | `mycelium-managed/src/server.js` (challenge/provision/release + `main()`); `ratelimit.js` (in-memory Map) |
| Operator secrets are env-only, file-backed 0600, never DB/logs (the `STRIPE_*` precedent) | `relay/deploy/README.md:83-84,119,135`; `server.js main()` |
| Reference billing stores Stripe ids + status only (no PAN) → PCI SAQ A; proxies Stripe via a Worker (no keys on the box) | `reference/server-routes/portal-billing.js:77,134-141` |
| No Stripe webhook / signature-verify code exists in this repo (build fresh) | repo-wide grep `stripe-signature|constructEvent|whsec` → zero |
| Fail-closed verify precedent to mirror for the webhook | `src/identity/identity.js:82-89` |
| Idempotency precedents (nonce single-use; capture content-hash) | `mycelium-managed/src/nonce.js`; `src/ingest/capture.js` |
| Free paths never contact the control-plane (anonymity preserved there) | `src/remote/runtime.js:122-156` |
