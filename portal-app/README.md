# Mycelium portal (canonical SvelteKit UI) — V1 port

This is the **canonical** portal — the real, "exquisite" Mycelium UI (SvelteKit 5
+ Tailwind, mindscape/library/timeline/wealth/intel/…), ported from the
production app to run against the **local** V1 server. It replaces the old
single-file `portal/index.html` (kept only as a fallback).

## Build & run

```bash
# from the repo root
npm run portal:install     # one-time: install portal deps (SvelteKit, three, leaflet…)
npm run portal:build       # produces portal-app/build/ (a static SPA)
npm run portal             # node src/server-rest.js — serves the built SPA at :8787
```

The Node REST server (`src/server-rest.js`) **auto-detects** `portal-app/build/`
and serves it (with SPA fallback to `200.html`) when present; otherwise it falls
back to the single-file `portal/`. The Tauri Mac app spawns the same server, so
`cargo tauri dev` shows this UI once it's been built.

Iterate on the UI live (hot reload, no Node server needed for layout work):

```bash
npm run portal:dev         # vite dev on :5173
```

## Status

**M1 — DONE (verified by `npm run verify:portal-serve`):** the canonical app
builds in this repo and is served by the local server. Tailwind/PostCSS configs
were reconstructed (`tailwind.config.js` maps the semantic utilities —
`text-primary`, `bg-surface`, `text-aurum`… — onto the design tokens in
`src/lib/styles/tokens.css`). The encrypted-WS channel is **off** (no
`VITE_VPS_NOISE_PUB`), so `src/lib/api.ts` uses plain same-origin `fetch`.

**M2 — TODO (needs the Mac / visual iteration):** wire each screen's data. The
app calls ~150 cloud `/portal/*` endpoints; V1 exposes `POST /api/v1/:toolName`
(+ `/api/v1/upload`, `/ingest/*`). The single seam to retarget is
`src/lib/api.ts` (and a per-screen path→tool translation). Plan:

1. **Local auth bypass** — `src/routes/(app)/+layout` currently redirects to
   `/login` (Telegram/passkey cloud ceremony). For single-user local, treat the
   session as always-authenticated (or a trivial local unlock) so the app opens
   straight to the home screen.
2. **Light up V1-backed screens first** — library/documents, search, mindscape,
   import, settings, profile, chat — translating their `/portal/*` calls to the
   matching `/api/v1/:tool` (e.g. list/get/upsert documents, search, capture).
3. **Graceful-empty** the rest (wealth, intel, fleet, connections, spaces…) —
   no local backend yet; render their empty state instead of throwing.

Do M2 where the UI can be **seen** — this environment has no browser.
