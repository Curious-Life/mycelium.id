# Portal Performance — Consolidated Plan (full serving + loading audit)

**Date:** 2026-06-19
**Author branch:** `feat/portal-serving-perf` (worktree `mycelium-id-worktrees/serving-perf`), stacked on `feat/portal-load-perf` @ `e3d55bc`
**Companion to:** [`PORTAL-LOAD-PERF-DESIGN-2026-06-19.md`](PORTAL-LOAD-PERF-DESIGN-2026-06-19.md) (Mindscape + Library data-layer — Phase 1 already shipped on that branch)
**Method:** 4 parallel read-only audit sweeps (serving, Streams, server event-loop, frontend nav) + own-eyes verification of every Tier-0 claim. Every load-bearing fact carries a `file:line`.

---

## 0. Why this doc exists

The user reports: *"seconds before I could even open a page; Streams and Library took ages."* The existing design doc nailed the **Mindscape** and **Library** data-layer costs and Phase 1 is shipped. But a full audit of the *serving and loading* path found the existing doc has **three blind spots** that explain the "every page is slow" symptom:

1. **The serving layer itself** — the entire JS bundle and every API JSON response are sent **uncompressed**, and hashed assets carry **no cache headers**. This taxes *every* page, cold and warm. Not in the design. **Biggest win, lowest risk, lowest effort.**
2. **Streams** — never analyzed; over-fetches 3,200 encrypted rows to show 100, no virtualization, no cache.
3. **Server event-loop congestion** — synchronous SQLCipher work on the single Node thread makes *unrelated* section clicks wait.

This plan sequences **everything** — what is done, what the other workstream still owns, and the new work — into one order. It does **not** rewrite the existing design doc (that workstream is active); it extends it.

---

## 1. Status of the existing design (Mindscape + Library) — DONE, do not duplicate

Shipped on `feat/portal-load-perf` (verified by reading the commits):

| Item | Commit | Evidence |
|---|---|---|
| **P1a** Mindscape SWR aggregate cache + bust hooks | `2bc81b2` | `src/mindscape-cache.js`, `src/jobs.js`, `src/portal-mindscape.js`; gate `verify:mindscape-cache` |
| **P1b/P2 backend** documents pagination + `POST /portal/documents/previews` snippet endpoint + attachments honor limit + `updated_at` index | `2c4d4a1` | `src/db/documents.js`, `src/portal-compat.js`, `src/portal-attachments.js`, `migrations/0025_*`; gate `verify:library-perf` |
| **P1b frontend** batched snippet previews + defer media | `78c1c4a` | `portal-app/src/lib/stores/docPreviews.ts`, `DocThumbnail.svelte`, `LibraryView.svelte` |

**Still owned by that workstream (do not pick up here):** **P2d** Mindscape payload typed-arrays, **P3** scoped decryption (`autoDecryptResults` single-table scoping — security-sensitive, human approval required).

---

## 2. New root causes (verified) — owned by THIS plan

### Tier 0 — Serving layer (taxes every page; verified by own read)

- **S1 — No compression, anywhere.** No `compression` / `express-static-gzip` / `shrink-ray` in `package.json` (confirmed `NONE`); zero `Content-Encoding` negotiation in [src/server-rest.js](../src/server-rest.js) or [src/server-http.js](../src/server-http.js). Consequences:
  - **Static:** SvelteKit pre-built `.br`/`.gz` siblings (`precompress: true`) **sit unused** — `express.static` ([server-rest.js:721](../src/server-rest.js)) only serves the raw file. The bundle ships **4.2 MB uncompressed** (one chunk is 719 KB → 148 KB brotli). Over Tailscale/LAN to a WKWebView that is the multi-second cold open.
  - **Dynamic:** every `/portal/*` JSON response is uncompressed too — the Mindscape aggregate, the Streams feed, the documents list. These are large, highly-compressible JSON payloads sent raw on every open.
- **S2 — No cache headers on immutable assets.** The `setHeaders` callback ([server-rest.js:722-728](../src/server-rest.js)) sets `no-store` on `.html` only; the content-hashed `_app/immutable/*` chunks get **no `Cache-Control`**. The WebView must revalidate **~100 chunks on every warm load** (a conditional round-trip each over Tailscale) → re-opening the app is sluggish even when nothing changed. (The `no-store`-on-HTML behavior is correct and must be preserved — it's what lets a new build take effect; see the in-code comment.)
- **S3 — Heavy libs loaded up front, not by route.** `three` + `globe.gl` + `leaflet` + `marked` are statically imported and land in the boot chunk, so `/setup`, `/login`, Library, and Streams all pay the 3D/map cost they never use. ([portal-app/package.json](../portal-app/package.json) deps; static `import * as THREE` / `import { marked }` across views.)
- **S4 — `mindscape-data.json` (116 KB) shipped static** and fetched by `MindscapeBackground` even on auth screens; no cache header. Minor next to S1/S2.

### Tier 1 — Streams (new; mirrors Library fixes)

- **ST1 — Over-fetch on search.** `db.streams.feed` scans **800 rows × 4 tables** (messages/documents/health/tasks), decrypts each, merges, caps at 100 ([src/db/streams.js:210-325](../src/db/streams.js), `SEARCH_SCAN=800`). 3,200 decrypts for ~100 results.
- **ST2 — `metadata` decrypted then discarded** on every message row ([src/streams/assemble-messages.js:37](../src/streams/assemble-messages.js); selected at [src/db/messages.js:646](../src/db/messages.js)). Pure waste — drop it from the projection (mirror the `includeEmbedding768` opt-in pattern).
- **ST3 — No virtualization.** Every river item mounts a DOM node + its own `marked` parse; "load older" appends unboundedly ([StreamRiver.svelte:168-184](../portal-app/src/lib/views/StreamRiver.svelte)).
- **ST4 — No cache.** Every Streams open is a cold scan; no SWR (unlike the new Mindscape/Library caches).

### Tier 1 — Server event-loop congestion (makes unrelated clicks wait)

- **EL1 — `autoDecryptResults` probes every string column of every row** (base64-decode + JSON.parse) even on tables with **zero** encrypted columns ([src/crypto/crypto-local.js:1723-1748](../src/crypto/crypto-local.js)). On the 70k-point Mindscape scan that is 100% wasted, synchronous, event-loop-blocking work. **This is exactly the existing design's P3** — already owned there. This plan does **not** duplicate it; it depends on it. Additional, complementary: the decrypt loop is sequential (`for … await`); batching with `Promise.all` over a row page would cut wall-time on genuinely-encrypted reads.
- **EL2 — Correction to a stale lead.** A sweep flagged `embedBacklog` as the #1 culprit "decrypting every row." **False** — [src/db/messages.js:69-84](../src/db/messages.js) is a pure SQL `COUNT(*)`/`SUM(CASE…)` aggregate (no row decrypt), and PR #270 already wrapped it in a single-flight cache (`embedBacklogCached`). **Not counted.** (Honest exclusion so future sessions don't chase it.)
- **EL3 — Background pollers** (activity 2.5s, people-badge 15s) are individually cheap; left as-is unless profiling says otherwise. The on-disk search index now persists (per prior work) so its build is once, not per-boot — de-prioritized.

### Tier 2 — Frontend "instant click" (cross-cutting)

- **FE1 — Every section awaits all fetches before rendering anything** (no skeletons): Library (3), Mindscape (6), Streams (3), Agents (5). Navigation itself is already instant (client-side workspace tabs) — the gap is first-paint blocking. ([LibraryView.svelte:155](../portal-app/src/lib/views/LibraryView.svelte), [MindscapeView.svelte:254-333](../portal-app/src/lib/views/MindscapeView.svelte), [StreamRiver.svelte:41](../portal-app/src/lib/views/StreamRiver.svelte), [AgentsView.svelte:189](../portal-app/src/lib/views/AgentsView.svelte))
- **FE2 — No client query cache.** Re-visiting a section re-fetches from scratch. A small TTL/SWR store (dedup in-flight + serve-stale-revalidate) makes revisits instant. The new `docPreviews.ts` store is the right seed pattern.

---

## 3. Threat model (the parts that touch security)

- **Compression + private transport (S1).** BREACH/CRIME require attacker-controlled input reflected alongside a secret in one TLS response, with size observation. Mycelium serves the **single owner** over **loopback (desktop)** or **Tailscale + Bearer (native app)** — no untrusted cross-origin reflection. Static assets carry no secrets. Mitigations regardless: (1) precompress static from on-disk siblings (no runtime oracle); (2) for dynamic responses use the standard, audited `compression` middleware with `Vary: Accept-Encoding`; (3) **exclude auth/token surfaces** (`/auth/*`, `/recovery-key`, OAuth) from dynamic compression to remove any token-size oracle. Net: safe here, with belt-and-suspenders.
- **Cache headers (S2).** Only `_app/immutable/*` (content-hashed, public, no secrets) gets `immutable`; the HTML shell keeps `no-store`; **no API/data response becomes cacheable.** No vault data enters a cache.
- **No new plaintext at rest / in logs (CLAUDE.md §1).** Nothing here persists or logs decrypted content. Streams `metadata`-drop (ST2) *reduces* decryption surface.
- **Dependency surface.** Adding `compression` (battle-tested, minimal transitive deps) over a hand-rolled streaming gzip is the correct "no half-assed" call; static precompressed serving is zero-dep (read sibling + set header). `npm audit` must stay at 0 (per project memory) — gate it.

---

## 4. Sequenced implementation order (impact × safety × independence)

Each step is independently shippable, smoke-tested, and behind the auto-merge-on-green gate.

| # | Step | Tier | Why this order | Gate |
|---|---|---|---|---|
| **1** | **Serving: precompressed static + immutable cache headers + dynamic `compression`** (excl. auth) | 0 | Biggest perceived win, lowest risk, helps **every** page incl. already-done Library/Mindscape. Pure transport. | `verify:serving-perf` (new): asset served `.br` w/ `Content-Encoding` on `Accept-Encoding: br`; immutable header on hashed chunk; `no-store` preserved on shell; auth route NOT compressed |
| **2** | **Route-split heavy libs** (`three`/`globe.gl`/`leaflet`/`marked` → dynamic import by route) | 0 | Shrinks the boot chunk so first paint is fast on every non-3D route. Build-time only. | bundle-size assertion: boot chunk < target; `three` absent from entry graph |
| **3** | **Streams backend: drop `metadata` projection + cap/short-circuit the search scan + SWR cache** | 1 | Mirrors shipped Library fixes; cuts the dominant Streams cost. | `verify:streams-perf` (new): feed honors result cap without full 4×800 scan; `metadata` not selected; repeat open hits cache |
| **4** | **Streams frontend: virtualize the river + skeleton render** | 1/2 | Bounds DOM + markdown work to the viewport; first paint immediate. | live smoke: scroll 500 items, stable DOM count |
| **5** | **Frontend: skeleton-first render + client TTL/SWR cache layer** (all sections) | 2 | Makes every section click feel instant + revisits free. Generalize `docPreviews.ts`. | live smoke: section shows skeleton < 50 ms; revisit served from cache |
| **6** | *(other workstream)* **P2d Mindscape payload slim + P3 scoped decrypt** | — | Owned by `feat/portal-load-perf`. EL1 resolves with P3. | their `verify:decrypt-scope` |

Steps 1–2 land first and fast. 3–5 are the Streams + responsiveness body. 6 is not ours.

---

## 5. Test strategy

- **`verify:serving-perf`** — boot the REST app against the built `portal-app/build`; assert: (a) `GET /_app/immutable/<chunk>.js` with `Accept-Encoding: br` returns `Content-Encoding: br` + the `.br` bytes + `Cache-Control: …immutable`; (b) same without `Accept-Encoding` returns raw + still cache-immutable; (c) `GET /` (shell) stays `no-store`, never compressed-cached; (d) a `/portal/*` JSON response is gzip-compressed when requested; (e) an auth route is **not** dynamically compressed.
- **`verify:streams-perf`** — feed with a query returns ≤ cap without a 4×800 full scan; `metadata` absent from the row projection; second identical open served from cache.
- **Full `npm run verify` green** + `npm audit` = 0 before any merge (no subset/flaky-CI merges — project memory).
- **Live smoke on the real vault (:8787 / packaged app):** time cold + warm open of Mindscape, Library, Streams before/after; confirm DevTools shows `content-encoding: br/gzip`, hashed chunks `200 (from cache)` on warm load, no `[DECRYPT ERROR]`, no ciphertext in any response. WKWebView verification per the project's webkit-shader/remote-MCP discipline (a real browser, not curl, for the cache/encoding behavior the WebView actually exercises).

---

## 6. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Compression oracle leaks a token size | Low | High | Private single-user transport + exclude auth/token routes from dynamic compression + static is pre-built (no runtime oracle) |
| Immutable header pins a stale chunk | V. low | Med | Only on content-hashed `_app/immutable/*` (hash changes ⇒ new URL); shell stays `no-store` |
| `compression` dep adds CVE surface | Low | Med | Pin + `npm audit`=0 gate; well-audited package; static path stays zero-dep |
| Route-splitting breaks a view that imported a lib transitively | Med | Low | Build + svelte-check + live smoke each split; revert is per-import |
| Streams virtualization regresses scroll/keyboard | Med | Low | Proven svelte virtual-list; keep a non-virtual fallback |
| Brotli CPU cost on dynamic responses | Low | Low | Prefer static precompressed; dynamic gzip at a sane level/threshold; responses are the owner's own |

---

## 7. Verification table (load-bearing facts, read by me)

| Assumption | Verified at |
|---|---|
| No compression/gzip middleware in deps or server | `grep` → `NONE in package.json`; no `Content-Encoding` in server-rest.js/server-http.js (own read) |
| `express.static` serves raw; only `.html` gets `no-store`; no header on immutable | [src/server-rest.js:721-728](../src/server-rest.js) (own read) |
| Bundle 4.2 MB uncompressed; largest chunk 719 KB; `.br`/`.gz` siblings exist | `du`/`ls` on `portal-app/build/_app` (own read) |
| `embedBacklog` is a SQL COUNT aggregate, NOT a row decrypt; already cached (#270) | [src/db/messages.js:69-84](../src/db/messages.js), commit `39777b7` (own read) — corrects a sweep lead |
| `autoDecryptResults` probes every string column, no table scope | [src/crypto/crypto-local.js:1723-1748](../src/crypto/crypto-local.js) (= existing design P3) |
| Streams feed scans 800×4 tables, caps 100 | [src/db/streams.js:210-325](../src/db/streams.js) |
| Streams `metadata` decrypted then dropped | [src/streams/assemble-messages.js:37](../src/streams/assemble-messages.js), [src/db/messages.js:646](../src/db/messages.js) |
| Sections await all fetches before render | LibraryView/MindscapeView/StreamRiver/AgentsView onMount (sweep, file:line in §2) |
| Phase 1 (P1a/P1b/P2a-c) already shipped on feat/portal-load-perf | commits `2bc81b2`,`2c4d4a1`,`78c1c4a` (own read) |

---

## 8. Coordination note (concurrent sessions)

`feat/portal-load-perf` is **actively worked by another session** (it advanced through `2bc81b2 → e3d55bc` during this audit). This plan deliberately takes only the **non-overlapping** surface (serving, Streams, event-loop EL1-as-dependency) on a **separate branch stacked on their HEAD**, so the two streams never edit the same files concurrently. P2d/P3 stay theirs. Rebase on their HEAD before each merge.
