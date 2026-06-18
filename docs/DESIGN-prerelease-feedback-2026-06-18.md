# Design — pre-release feedback fixes (2026-06-18)

> **Status: BUILDING.** Sweep-first design for the 8 unfixed tester-feedback items
> (#1,2,3,4,6,7,9,11). Companion: `PRERELEASE-FEEDBACK-HANDOFF-2026-06-18.md`
> (full audit + context). Branch `fix/prerelease-feedback` off `origin/main`.

## Sweep findings (file:line)

- **#9 remote.json crash** — `publicBaseUrl` is read **unvalidated** at
  [`src/remote/config.js:84`](../src/remote/config.js) (`clean(file.publicBaseUrl)`,
  no scheme check), assigned to `baseURL` at [`src/auth.js:37`](../src/auth.js),
  and passed to `betterAuth({ baseURL })` at `auth.js:65` — better-auth's
  constructor throws on a scheme-less/invalid URL and crashes boot. Matrix
  homeserver IS validated (config.js:130); `publicBaseUrl` was the gap. `new URL`
  uses elsewhere (auth.js:88, server-http.js:604) are already try/caught.
- **#7 :4711 root** — `src/server-http.js` registers OAuth well-knowns, `/login`,
  `/api/auth/*`, `/mcp`, `/ingest/*`, `/context`, `/v1/*`, and a route-hiding 404
  gate (~line 125) — but **no `GET /`** → Express "Cannot GET /". No CSP on this
  server.
- **#11 WebGL** — `Mindscape3D.svelte` `initThree()` (~line 1371) does
  `new THREE.WebGLRenderer({antialias:true})` with **no try/catch**; `onMount` →
  `initThree()` → `renderLoop()` crashes when `renderer` is undefined.
  `MindscapeBackground.svelte` (~line 40) same. **No WebGL capability check exists
  anywhere.** Svelte-5 runes, no `<svelte:boundary>` in the codebase → use a state
  flag + conditional fallback (matches the existing empty-state at ~line 2504).
- **#1/#2/#3/#4/#6** — install/docs gaps confirmed absent in mycelium.id (see handoff).

## Module shape

| # | Change | File(s) |
|---|---|---|
| 2 | `.nvmrc` = `22` (stops Node 23 silently breaking prebuilt native modules) | `.nvmrc` (new) |
| 1 | README **Troubleshooting** section: conda-active build failure (libtool collision → `conda deactivate` before `npm install`), Node 23 trap (→ `nvm use`), `--legacy-peer-deps` | `README.md` |
| 3 | Correct the "13 verify scripts" claim → the real number / "full suite"; add a fast **`verify:core`** npm script (≈8 high-signal gates) | `package.json`, `README.md` |
| 4 | README prerequisites: Python (≥3.10) needed for embeddings/clustering → point at `docs/SETUP.md`; mention `xcode-select --install` | `README.md` |
| 6 | `npm audit --omit=dev`; if a transitive `hono` (or other) advisory exists, pin via `overrides`; else record "0 prod vulns" | `package.json` (overrides, only if needed) |
| 7 | Minimal `GET /` HTML on :4711 ("Mycelium MCP server — connect an MCP client" + docs link), **before** the route-hiding gate; static, unauthenticated, leaks no routes | `src/server-http.js` |
| 9 | `normalizeBaseUrl(url)` in `readRemoteConfig()`: prepend `https://` if scheme-less, validate with `new URL`, **fail soft to ''** (remote OFF, server boots) — so a malformed `remote.json` can never crash boot | `src/remote/config.js` (+ defensive guard in `src/auth.js`) |
| 11 | `canUseWebGL()` util + guard before each `new THREE.WebGLRenderer`; on failure set a `webglUnavailable` flag → friendly fallback panel (Mindscape3D) / skip (MindscapeBackground) | `portal-app/src/lib/utils/webgl.ts` (new), `Mindscape3D.svelte`, `MindscapeBackground.svelte` |

### `verify:core` proposed set (fast, high-signal)
`foundation · primitives · at-rest · mcp · leak · account · portal · search` —
the boot/crypto/tool/UI sanity subset; full `verify` stays the gate for release.

## Edge cases / decisions
- #9: also handle a value that ALREADY has a scheme but is malformed (`new URL`
  throws) → fail soft. And a value with `http://` (not https) → keep as-is (dev),
  don't force https. Only PREPEND when scheme is absent.
- #7: respond only to exact `GET /` (not a prefix) so it can't shadow `/mcp`,
  `/login`, well-knowns. `text/html`; no inline script (no CSP on :4711, but keep
  it inert).
- #11: capability check must run in the browser only (guard `browser`/`document`).
  Fallback must not break the surrounding layout (absolute-positioned panel).
- #3: don't hardcode a count that rots again — say "the full suite" + let
  `verify:core` be the quick path; if a number is given, compute-document it.

## Test strategy
- #2/#1/#4: read-back; `node -e` parse of `.nvmrc`.
- #3: `npm run verify:core` runs + each prints VERDICT: GO; README no longer says 13.
- #6: `npm audit --omit=dev` → 0 (or overrides pin it).
- #7: boot `node src/index.js --http` (or the server-http test harness) → `curl /`
  → 200 text/html; `curl /mcp` still 401; well-knowns unaffected. Reuse/extend
  `verify:oauth`/`verify:mcp-discovery` if they boot :4711.
- #9: unit — `readRemoteConfig` with a stubbed remote.json `{publicBaseUrl:'myhost.com'}`
  and `{publicBaseUrl:'::::'}` → returns normalized/'' and boot does NOT throw.
  A focused `scripts/verify-remote-config.mjs` assertion if one exists; else a
  small ad-hoc boot test.
- #11: `npm --prefix portal-app run check` (svelte-check) + build; logic review of
  the guard (headless WebGL-absent is hard to simulate, so assert the guard path
  by unit-testing `canUseWebGL` returns false when getContext is stubbed null).

## Implementation order
1. Docs/config: #2 `.nvmrc`, #1/#3/#4 README, #3 `verify:core`. (low risk)
2. #6 `npm audit` → overrides only if needed.
3. #9 remote.json normalize + fail-soft (most important — a crash on bad config).
4. #7 :4711 root handler.
5. #11 WebGL guard + fallback.
6. Verify each; PR.

## Verification table
| Assumption | Verified at |
|---|---|
| publicBaseUrl read unvalidated → betterAuth crash | Sweep #9; src/remote/config.js:84 → src/auth.js:37,65 |
| Matrix homeserver already validated (publicBaseUrl wasn't) | Sweep #9; config.js:130 |
| no `GET /` on :4711, route-hiding gate at ~125 | Sweep #7; src/server-http.js |
| WebGLRenderer created with no guard; no capability check anywhere | Sweep #11; Mindscape3D.svelte ~1371, MindscapeBackground.svelte ~40 |
| no `.nvmrc`; README says 13 (actual 189); no verify:core; no conda docs | direct grep (handoff audit) |
| hono is transitive (@hono/node-server → hono ^4), not direct | package-lock.json:187-196; package.json has no hono |
