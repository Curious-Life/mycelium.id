# Security hardening design — egress provenance · SSRF pinning · import bounds (2026-06-15)

⚠️ Internal (strip pre-public). Sweep-first design for the three fixes from the
2026-06-15 adversarial pass. Three independent, well-scoped PRs.

## Threat model (local-primary)
Primary deployment is the user's own machine ([[deployment-local-primary]]). Two
of these cross a real trust boundary even under same-user-trust: (A) a local
process impersonating the *agent* to the *user* over a trusted channel (Telegram/
Discord); (C) the user being tricked into importing a malicious archive. (B) SSRF
is pre-enablement (federation is OFF live) but lands the documented live-env item.

---

## PR-A — Egress provenance gate (F1/F2/F3)

**Sweep (verified by reading the code):**
- `checkAuthority` is called only `if (!trustedReq)` and receives just `{kind, id:target}` — no provenance (send-handler.js:134-135). `isAgentExplicit` is already computed at send-handler.js:114-116 (`x-egress-provenance: agent-explicit` + strict-loopback).
- The two short-circuits live *inside* checkAuthority: owner-bootstrap (index.js:105), reply-to-inbound (index.js:151) — so neither sees provenance today.
- Legit agent replies POST with `x-egress-provenance: agent-explicit` (reply.js:121); command replies use the trusted token (index.js:120,165 → bypass authority entirely).
- `GET /internal/inbound-context/current` returns the full ActiveTurnContext, no auth (server.js:36-40); only `reply.js` consumes it, and only `{channelId, source, channelKind, inboundMessageId}` (reply.js:161-176).

**Design:** thread `isAgentExplicit` into the authority callback.
- send-handler.js:135 → `checkAuthority({ kind, id: target, isAgentExplicit })`.
- index.js checkTelegramAuthority: `if (isAgentExplicit && id===ownerId) return owner-bootstrap` else fall through to `vault.checkChannelAuthority` (fail-closed for unbound).
- index.js checkDiscordAuthority: `reply-to-inbound` requires `isAgentExplicit`.
- F3: server.js context endpoint → require strict-loopback + `x-egress-provenance: agent-explicit`; return only `{source, channelKind, channelId, inboundMessageId, voiceMode, taskId}` (drop `username/userId/channel`). reply.js fetchActiveTurn sends the header.

**Why this preserves function:** the reply tool (agent-explicit) still gets both short-circuits; the trusted-token path is untouched (already bypasses authority); a bare curl to the owner's chat / live channel now falls through to the registry → 403.

**Tests (extend verify-channel-egress-e2e.mjs + verify-channel-egress.mjs):** E: bare (no-provenance) send to owner → 403 + audited denied; agent-explicit send to owner → 200. Discord: reply-to-inbound without provenance → 403; with → 200. Context endpoint: no header → 401/403; trimmed fields present, PII fields absent.

**LOC ≈ 55** (send-handler.js, index.js ×2, server.js, reply.js) + ~45 gate.

---

## PR-B — SSRF safeFetch + fail-closed (per SECURITY-FOLLOWUP-LIVE-ENV §1)

**Sweep (verified):** `assertResolvesPublic` fail-opens on resolve failure (ssrf.js:114 `catch{return}`); `isPrivateAddress` parser is complete (ssrf.js:93). 4 sinks: did.js resolveDidKey:177 / resolveMatrixService:128 (take `{fetch,lookup}`, validate then raw-fetch — no pin), connections.js resolveFederationEndpoint:119 (no `lookup` threaded) + signedFederationPost:142 (subdomain guard at :131-136 but **no IP re-resolution**). handlers.js:33 threads `fetch` not `lookup`; verify-federation.mjs uses `shimFetch` (hostname→loopback port) + already injects `lookup` into the direct assertResolvesPublic test (:100). **undici is NOT installed** (verified `require`/`import` MODULE_NOT_FOUND) → must add dependency.

**Design:** add `undici` dep. In ssrf.js:
- Flip the fail-open `catch{return}` → `throw new Error('refusing to fetch an unresolvable host')`.
- `safeFetch(url, { lookup, fetch, ...init })`: resolve host once via `lookup` (fail-closed); validate **every** address with `isPrivateAddress` (throw on any private/empty). If an injected `fetch` is provided (test shim), call it after validation. Else build `new undici.Agent({ connect: { lookup: pinned } })` where `pinned` returns ONLY the validated address and re-runs `isPrivateAddress` in the hook (defeats TOCTOU), and `fetch(url, { ...init, dispatcher })`.
- Route did.js (both) + connections.js (resolveFederationEndpoint WebFinger + signedFederationPost) through safeFetch. Thread `lookup` through createFederationHandlers deps → resolveDidKey, and createConnectionsNamespace deps → resolveFederationEndpoint/assertResolvesPublic.

**Testability decision:** layer-1 (resolve+validate-all, fail-closed) is unit-testable via injected `lookup`; layer-2 (the undici connect-pin) defends the TOCTOU and is NOT hermetically testable (needs a real public IP + controlled rebind). So the gate injects `lookup` (alice/bob→public literal so validation passes) + keeps `shimFetch` for the actual call, and adds: unresolvable→throws, lookup-returns-private→throws, lookup-returns-[public,private]→throws. The live rebind test stays deferred (federation OFF + needs controlled DNS).

**Tests (verify-federation.mjs + verify-spaces.mjs):** inject `lookup`; assert the three fail-closed cases; assert the happy federation flow still GO with the injected lookup; confirm `:spaces` GO.

**LOC ≈ 110** (ssrf.js, did.js, connections.js, handlers.js, package.json) + ~40 gate.

---

## PR-C — Import bounds (entry-count cap · backup containment · JSON cap)

**Sweep (verified):** entry-count is **never** capped after `JSZip.loadAsync` (portal-uploads.js:106, vault-import.js:458, import-parsers.js detectExportType:93) — millions of tiny entries OOM independent of byte caps. backup.js restore (202-211) uses a substring `rel.includes('..')` guard + `path.join` (not containment) + plain `writeFileSync`. MAX_JSON_BYTES=400MB (import-parsers.js:17) vs IMPORT_LIMIT=8GB. Per-entry streaming caps already exist and are correct; blob paths are server-UUIDs (blob-store.js:44); obsidian guards `..`+symlinks (obsidian-import.js:75,202,317). #158 deliberately raised byte limits for multi-GB vaults — **do not lower IMPORT_LIMIT** (would regress #158).

**Design:**
- New `assertEntryCount(zip, max=200_000)` in import-parsers.js (env `MYCELIUM_IMPORT_MAX_ENTRIES`); call after each loadAsync (portal-uploads processArchive, vault-import, backup restore).
- backup.js restore: replace substring guard with `const dest = path.resolve(uploadsRoot, rel); if (dest !== uploadsRoot && !dest.startsWith(uploadsRoot + path.sep)) skip;` + cap entries.
- Lower MAX_JSON_BYTES default 400MB→128MB (env-overridable).
- `allocUnsafe(fileSize)`: left as-is (bounded by IMPORT_LIMIT + MAX_TOTAL_INFLIGHT + MAX_CONCURRENT; lowering conflicts with #158). Documented as accepted.

**Tests:** verify-import-security.mjs — a high-entry-count zip → rejected (no OOM, fast). verify-backup.mjs — a `.myvault` with a `../escape` entry → contained (no write outside uploadsRoot), legit entries still restore.

**LOC ≈ 40** (import-parsers.js, portal-uploads.js, vault-import.js, backup.js) + ~30 gate.

---

## Verification table (every load-bearing assumption, read by me)
| Assumption | Verified at |
|---|---|
| checkAuthority called only when !trustedReq, gets {kind,id} | send-handler.js:134-135 |
| isAgentExplicit computed before that call | send-handler.js:114-116 |
| owner-bootstrap / reply-to-inbound are inside checkAuthority | index.js:105, 151 |
| reply tool sends x-egress-provenance: agent-explicit on send | reply.js:121 (sweep) |
| reply tool consumes only channelId/source/channelKind/inboundMessageId | reply.js:161-176 |
| context endpoint unauth, full turn returned | server.js:36-40 |
| assertResolvesPublic fail-open | ssrf.js:114 |
| did sinks take {fetch,lookup}, validate-then-rawfetch | did.js:177,128 |
| connections sinks lack lookup; POST lacks IP re-resolve | connections.js:119,142 (subdomain guard :131-136) |
| undici NOT installed | `require('undici')` → MODULE_NOT_FOUND |
| handlers thread fetch not lookup | handlers.js:33,79 |
| verify-federation uses shimFetch + injects lookup into direct test | verify-federation.mjs:41-54,100 |
| no entry-count cap after loadAsync | portal-uploads.js:106; vault-import.js:458; import-parsers.js:93 |
| backup restore uses substring ..-guard + path.join | backup.js:202-211 |
| blob paths are server UUIDs (entry name never picks disk path) | blob-store.js:44 |
| MAX_JSON_BYTES=400MB; IMPORT_LIMIT=8GB | import-parsers.js:17; portal-uploads.js:40 |

## Implementation order (independent PRs)
1. **PR-A egress** (most exploitable today, smallest) → verify:channel-egress(+e2e), channel-presence.
2. **PR-C import** (cheap, high-value) → verify:import-security, backup.
3. **PR-B SSRF** (biggest, adds dep) → verify:federation, spaces.

## Risks
| Risk | Mitigation |
|---|---|
| PR-A breaks legit owner replies | reply tool is agent-explicit → still gets short-circuit; e2e test asserts both |
| PR-B undici dep / API drift | pin version; gate exercises layer-1; layer-2 pin documented as live-deferred |
| PR-C entry cap rejects a legit huge vault | 200k default + env override; #158 byte limits untouched |
| F3 field trim breaks a hidden consumer | swept callers — only reply.js; keep taskId for audit |
