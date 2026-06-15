# Federation live-test runbook — connecting two Mycelium instances

**Date:** 2026-06-15
**Scope:** End-to-end test of a Tier-0 connection between two real Mycelium instances
(this box ↔ a second machine). Pairs with the stuck-pending delivery fix landed on
branch `claude/hungry-merkle-b72539` (re-request now re-delivers; `withdraw` clears a
stranded sent invite).

This is the operational companion to the connection audit. It does **not** require any
new backend schema — both tracks reuse the existing REST + federation surface.

---

## 0. How a connection works (one-paragraph recap)

Each instance is reachable at `https://<handle>.mycelium.id`, publishes a `did:web`
document at `/.well-known/did.json`, and is discoverable via `/.well-known/webfinger`.
A connect request is an Ed25519-signed HTTPS `POST` to the peer's `/federation/connect`;
the peer verifies the signature against the requester's published key, stores it
`pending`, and on accept signs a `connect-response` back. The whole feature is gated on
`readRemoteConfig().publicHost` being set — with no public host the handlers fail closed
(`503 federation not configured`) and `handle = publicHost.split('.')[0]`.

Key code: `src/db/connections.js`, `src/federation/{handlers,router,did,sign,ssrf}.js`,
mounted in `src/server-http.js` on the `:4711` app.

---

## 1. Prerequisites — make BOTH boxes reachable (do this first)

Federation cannot complete unless each box has a public host and is reachable over HTTPS.
A loopback-only / `tauri dev` instance with no `publicHost` will **not** work — the
SSRF guard also blocks private/loopback IPs by design, so you cannot point one local box
at another by LAN IP.

### This box's current state (probed 2026-06-15)

`GET http://127.0.0.1:8787/api/v1/remote/status` returned:

| field | value | meaning |
|---|---|---|
| `passwordSet` | `true` | ✓ operator password is set (the OAuth gate — a prerequisite for going live) |
| `controlPlaneUrl` | `https://connect.mycelium.id` | ✓ managed control plane configured (default) |
| `remoteMode` | `off` | ✗ no address claimed |
| `publicHost` | `""` | ✗ not reachable |
| `httpListening` | `false` | ✗ the `:4711` federation/OAuth host isn't running (the Tauri app starts it) |

So the only missing step on this box is **claiming the address + restarting**. Pick a path:

> **Control-plane port fix (2026-06-15).** The claim UI showed every handle as
> "taken" and Stripe never started because the app's default `controlPlaneUrl` was
> `https://connect.mycelium.id` (:443) — that port is frps SNI-passthrough and serves no
> cert for the name (TLS `unrecognized_name`). The control plane is healthy on **:8443**
> (verified: valid LE cert + `/v1/challenge` + `/v1/handle/:h` return 200). Fixed in
> `src/remote/config.js` (`DEFAULT_CONTROL_PLANE` → `:8443`). The app also now reports
> "address service unreachable" instead of falsely saying "taken".
>
> **To unblock your CURRENTLY-RUNNING app without a rebuild:** add
> `"controlPlaneUrl": "https://connect.mycelium.id:8443"` to
> `~/Library/Application Support/id.mycelium.app/remote.json` (or set
> `MYCELIUM_CONTROL_PLANE=https://connect.mycelium.id:8443`) and restart the app.

### Path A — managed address (CHOSEN 2026-06-15) — exact steps per box

Under the hood the app calls `POST /api/v1/remote/connect-managed { handle, turnstileToken }`
(`src/remote/router.js:166`): Turnstile bot-check → ed25519 handle claim signed with the
in-process master key → provision via `connect.mycelium.id`. **Do it in the app** — a
headless `curl` fails the Turnstile gate, and the claim is permanent + may be billed.

Per box (this Mac, then the second computer after install):

1. **Pre-check** (optional): `curl -s http://127.0.0.1:8787/api/v1/remote/status | jq`
   → confirm `passwordSet: true`. If false, set an operator password first (Settings →
   Remote Access). (This Mac on 2026-06-15: already `true`.)
2. **Claim the address:** Settings → Remote Access → enter a handle (e.g. `alice` here,
   `bob` on the other box) → confirm. Complete the Turnstile check.
3. **If prompted `subscription required`:** a Stripe checkout opens. Pay, then re-run the
   claim (the app re-calls `connect-managed`, now entitled). *Skip if your plan already
   covers it.*
4. **Restart the app** (`restartRequired: true`) so `frpc.toml` + `Caddyfile` materialize
   and the tunnel + Caddy bring `:4711` up behind the relay.
5. **Verify it's live:**
   ```sh
   curl -s http://127.0.0.1:8787/api/v1/remote/status | jq '{remoteMode,publicHost,httpListening}'
   #   → expect remoteMode:"managed", publicHost:"<handle>.mycelium.id", httpListening:true
   curl -s https://<handle>.mycelium.id/.well-known/did.json | jq .id
   #   → expect "did:web:<handle>.mycelium.id"
   ```
   If `httpListening` is still `false`, the `:4711` host didn't start — relaunch the app and
   recheck before moving on.

Once **both** boxes pass step 5, proceed to §2.

### Path B — bring your own domain (free; more setup) — alternative, not chosen

If you'd rather not use the managed relay: front loopback `:4711` with your own TLS reverse
proxy on a domain you control, set `publicHost` to that domain (`MYCELIUM_PUBLIC_HOST` env
or `remote.json`), and serve `/.well-known/{did.json,webfinger}` + `/federation/*` over
HTTPS. `server-http.js` explicitly supports an operator who fronts `:4711` with their own
TLS proxy. The handle is then `publicHost.split('.')[0]`.

### For BOTH boxes
- Do the above on this box **and** on your second computer after install.
- Pick distinct handles, e.g. box A = `alice`, box B = `bob`.
- Confirm `httpListening: true` in `/api/v1/remote/status` after restart, then run §2.

---

## 2. Pre-flight verification (run before any connect)

Replace `<A>` / `<B>` with the two public hosts (e.g. `alice.mycelium.id`).

```sh
# Each box serves its own DID document and WebFinger (run against each public host):
curl -s https://<A>/.well-known/did.json | jq .
#   → expect: { "id": "did:web:<A>", verificationMethod:[{ publicKeyMultibase: "z…" }],
#              service:[{ id:"…#federation", serviceEndpoint:"https://<A>/federation" }] }

curl -s "https://<A>/.well-known/webfinger?resource=acct:alice@<A>" | jq .
#   → expect a links[] entry whose rel includes "federation" → href https://<A>/federation

# Repeat both for <B>. A 404/503 here means publicHost is unset or the relay is down —
# STOP and fix reachability before continuing.

# From box A, confirm it can actually fetch box B's DID (this is what the handshake does):
curl -s https://<B>/.well-known/did.json | jq -e .id
```

Checklist — all must be true on both boxes before proceeding:
- [ ] `did.json` returns a `did:web:<host>` id matching the host
- [ ] `webfinger` returns a `…federation` link to `https://<host>/federation`
- [ ] each box can fetch the *other's* `did.json` over the public internet

---

## 3. The handshake test (A connects to B)

Drive this from box A's portal **Connections** page, or from chat via the MCP tools.

### Via MCP tools (from chat)
1. **A → request:** `requestConnection({ handle: "bob@<B>" })`
   → "Connection request sent to @bob@<B> (id …)".
2. **B → list:** `listConnectionRequests()` → should show `alice@<A>` with an id.
   *(If nothing appears within a few seconds, see §4 recovery.)*
3. **B → accept:** `respondToConnectionRequest({ id: "<id>", action: "accept" })`
   → "Connection accepted." (this fires the signed `connect-response` back to A).
4. **Both → verify accepted:** on each box the connection should now appear as accepted
   (portal Connections list / `db.connections.list`). A then also flips to `accepted`
   when B's `connect-response` lands.

### Via REST (portal endpoints, mounted under `/api/v1/portal`)
```sh
# A: send request
curl -sX POST https://<A>/api/v1/portal/connections/request \
  -H 'content-type: application/json' -d '{"toHandle":"bob@<B>"}'

# B: see it
curl -s https://<B>/api/v1/portal/connections/pending | jq .

# B: accept (id from the pending list)
curl -sX POST https://<B>/api/v1/portal/connections/<id>/accept -d '{}'

# Both: confirm accepted
curl -s https://<A>/api/v1/portal/connections | jq '.connections[].other_handle'
curl -s https://<B>/api/v1/portal/connections | jq '.connections[].other_handle'

# Either side: compute overlap (territory/realm comparison)
curl -s https://<A>/api/v1/portal/connections/<id>/overlap | jq .
```

> Note: portal endpoints are localhost-only on each box (no portal auth yet). Run the
> portal `curl`s **on the box itself** (against `localhost`/`127.0.0.1:8787` or the app),
> not across the internet — only the `/.well-known/*` and `/federation/*` surfaces are
> meant to be public.

### Success criteria
- [ ] B sees A's request as `pending` with A's signature/profile
- [ ] After B accepts, BOTH boxes show the connection as `accepted`
- [ ] `computeOverlap` returns a shape + (when there's enough overlap) a match score
- [ ] No plaintext/embedding fields crossed the wire (the §7 tripwire refuses vectors)

---

## 4. Recovery — if a request doesn't arrive (the fix in this branch)

Before this branch, a failed first delivery left a `pending` row that could not be
retried (`requestConnection` no-op'd; `disconnect` required `accepted`) — the row was
stuck. Now:

- **Re-request to re-deliver:** running `requestConnection({handle:"bob@<B>"})` again
  re-resolves B's endpoint and **re-POSTs** with a fresh nonce. B's inbound is idempotent,
  so this is safe to repeat. Use this if B was briefly unreachable when you first sent.
- **Withdraw to clear:** `POST /api/v1/portal/connections/<id>/withdraw` (or the
  Withdraw action on the redesigned Connections page) deletes a stranded/unwanted sent
  invite so it can be re-sent. Initiator-only, pending-only.

Other gotchas:
- **Clock skew:** requests carry a `ts` validated within ±5 min. If the two machines'
  clocks differ by more than that, the peer rejects with `401 stale or missing timestamp`.
  Ensure NTP is on both.
- **Nonce cache is in-memory:** a peer restart clears seen nonces; the ±5 min window still
  bounds replay. Not an issue for a manual test.
- **`reject` is local-silent:** if B rejects, A is not notified — A's sent invite stays
  `pending` until A withdraws it. (Acceptable for Tier-0b.)

---

## 5. What's verified vs. open

- **Verified (this branch):** `verify:federation` 12/12 GO; `db-connections-federation`
  18/18 (incl. new re-deliver + withdraw cases); 35/35 across federation suites.
- **Security posture (audit, 2026-06-15):** sound — Ed25519 over canonical JSON,
  fail-closed verify, nonce+timestamp replay protection, verified-host binding against
  impersonation, full IPv4/IPv6 SSRF guard (the "IPv6 bypass" claimed by one sweep is
  already fixed in `ssrf.js`), §7 embedding tripwire. Residuals (DNS TOCTOU, in-memory
  nonce, fail-open-on-DNS-failure, no per-resource authz) are MEDIUM/by-design and
  acceptable for the single-user local-primary model.
- **Open / not covered here:** automatic background reconciliation (still none — recovery
  is manual re-request/withdraw); a `verify:federation-live` two-box smoke (this runbook
  is the manual stand-in until both hosts exist).
