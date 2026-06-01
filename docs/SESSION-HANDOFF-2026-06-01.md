# Session Handoff — 2026-06-01

**Repo:** `Curious-Life/mycelium.id` · **main @ `3857c01`** · 17 verify suites GO
**Audience:** the next Claude Code session (this one grew very large — start fresh from here).
**Companions:** [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (as-built), [`docs/V1-BUILD-SPEC.md`](V1-BUILD-SPEC.md) (plan), [`docs/SETUP.md`](SETUP.md) (install).

---

## TL;DR

The V1 product is **built, verified, and running on the operator's M1 Mac**. This
session shipped 9 PRs to `main` (keys, inference, portal+Tauri app, upload/import,
icon, glass UI). Two things are open: a **BLOCKED security PR (#18)** with a
spec'd fix, and the **big one — porting the real SvelteKit portal UI**. `npm run
verify` = **17 suites GO** on `main`.

**Pull on the server:** `git pull` → browser refresh for glass; `cd src-tauri &&
MYCELIUM_HOME="$(cd .. && pwd)" cargo tauri dev` for the native window.

---

## Shipped to `main` this session (merged, verified)

| PR | What |
|----|------|
| #13 | query embedder wiring (fixed a real `{task}` bug) + verified `docs/SETUP.md` |
| #15 | local portal (single-file SPA) + Tauri Mac-app shell scaffold |
| #14 | master-key source: env / **macOS Keychain** / **1Password** (`npm run set-keys`) |
| #12 | inference router — local Ollama + BYOK cloud (opt-in egress) |
| #16 | portal **file upload** + **high-volume bulk import** (API body limit 1mb→64mb) |
| #17 | re-skin to the Mycelium design tokens (Geist, dark palette) |
| #20 | **real mushroom icon** (operator-provided) + deleted the sumi-e drawing |
| #21 | **glassmorphism + chromatic + see-through Mac mode** (Tauri transparent + vibrancy) |

(Core build #11 landed before this session.) Run modes: `npm start` (stdio MCP),
`npm run start:http`, `npm run rest`/`npm run portal` (UI+REST :8787),
`npm run start:enrich` (:8095), `node src/index.js --public` (:8788, publish surface).

---

## OPEN — top pickup items

### 1. 🔴 PR #18 (publishing foundation) — BLOCKED, fix is spec'd
Branch `claude/publish-foundation`. Adds box identity (ed25519 from master key),
signed capability links, and a fail-closed public server (`src/identity/identity.js`,
`src/publish/{links,public-server}.js`, `scripts/verify-publish.mjs`). A 3-agent
adversarial review found the crypto + server mechanics **sound**, but one **CRITICAL**:

- **Unlisted links cannot be revoked.** `public-server.js` `/s/:slug` serves on a
  valid token + `getBySlug` match **without checking current visibility**, and
  `db.documents.unpublish` *retains* `public_slug` — so a leaked unlisted link
  serves the private doc **forever** (spike-proven 200 after unpublish). Root cause:
  no `visibility`/nonce column — public/unlisted/private is a comment, not state.

**Fix before merge (do this in the fresh session):**
1. Migration `0003`: add `documents.publish_nonce TEXT` (and/or `visibility`).
2. Include `nonce` in the signed token payload (`src/publish/links.js` mint/verify);
   `public-server.js` `/s/` must re-check the doc's current `publish_nonce` matches
   the token AND the doc is still shareable. `unpublish`/make-private **rotates the
   nonce** → instant revocation + `unpublish` actually takes links back.
3. Hardening (MEDIUM, latent): reject non-canonical base64url in `verifyLink`
   (malleability); make slug-binding mandatory (don't let `slug:undefined` skip it).
4. LOW: cap served doc size in `serveDoc` (large-doc memory); `?t` non-string guard.
5. Add the missing tests to `verify-publish.mjs`: **unpublish-then-unlisted-access →
   404** (the CRITICAL regression test), make-private-then-token, query-array token,
   multi-dot token, XSS battery, `--public` env-key boot timing, identity-rotation.

Master-key rotation also silently breaks all links + changes identity (MEDIUM) —
document it. Full agent reports are summarized in the #18 PR comment.

### 2. 🎨 Port the real SvelteKit portal UI (the big one)
The operator wants the **canonical portal** (`reference/portal/`), not the current
single-file re-skin (which has **bad contrast → unusable**, and the icon should read
glass-like). Recon:
- SvelteKit 5 + Tailwind + vite; **25 route screens**, ~50 components; heavy deps
  (three.js, globe.gl, leaflet for 3D/federation).
- Data layer (`reference/portal/src/lib/api.ts`) hits **cloud endpoints** (`/portal/*`,
  `/api/*`) via a noise-encrypted WS channel + cookie auth. **V1 only has `/api/v1/*`
  (the 36 MCP tools) + `/ingest/*`** — so ~15 of the 25 screens have no local backend.

**Chosen approach (operator-aligned):** port the app + its build, **rewire the data
layer to the local REST API** (drop noise/auth — local is same-origin, no cloud),
light up the screens V1 feeds (mindscape, library/documents, import, search, settings,
profile, chat), let the rest render gracefully-empty. Adds a vite/Tailwind build; the
Node server / Tauri then serve the built `dist/` instead of `portal/index.html`.

**Important:** UI quality needs *eyes* — this Claude environment has **no browser** to
render/verify. Do this where it can be seen: the operator's Mac (their Mac Claude Code
session can run `vite dev` and iterate visually), or have this session produce the
buildable port + data rewire and the operator verifies/tunes on the Mac.
Start: branch off `main`, copy `reference/portal` → `portal-app/` (or `packages/portal`),
adapt `svelte.config` (adapter-static), rewire `src/lib/api.ts` → `/api/v1` + `/ingest`,
strip cloud-only modules enough to build, wire live screens, serve built output.

---

## Caveats — unverified on real hardware (no browser/Rust/network in CI sandbox)
- `cargo tauri dev` — first real compile of the transparency/vibrancy Rust (#21,
  `window-vibrancy`, `macOSPrivateApi`). May need a version tweak; see `src-tauri/BUILD-MAC.md`.
- `pipeline/embed-service.py --serve` — first real Nomic model download (needs internet).
- The SvelteKit port build (heavy npm install) — do/verify on the Mac.

## Pickup protocol
1. `git pull` → `npm install` → `npm run verify` (expect **17× VERDICT: GO**).
2. Read this doc, `docs/ARCHITECTURE.md`, and PR #18 (+ its review comment).
3. #18: implement the nonce/revocation fix above, re-run `verify:publish`, then the
   `auto-merge-on-green` gate still needs an explicit human OK (egress surface).
4. Portal: branch off `main`; port `reference/portal` + rewire data layer; iterate visually on the Mac.

## Ledger (this session)
main: …→ `da27548` (#11) → #13 → #15 → #14 → #12 → #16 → #17 → #20(`477e689`) → #21(`3857c01`).
Open: **#18** `claude/publish-foundation` (blocked). Closed: #19 (rejected hand-drawn icon).
