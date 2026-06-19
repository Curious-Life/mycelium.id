# Scan + Detect Frontend — Design

**Date:** 2026-06-19
**Branch:** `feat/scan-detect-frontend` (worktree off `origin/main` HEAD `70132cd`)
**Companion:** `docs/IMPORT-SYSTEM-HANDOFF-2026-06-19.md` (§ What's next A — this is the greenlit build), `docs/DESIGN-import-unification-next-phase-2026-06-19.md`.
**Skills:** `/sweep-first-design` (2 parallel Explore sweeps + own-eyes reads of every cited line).

## Goal

Surface the **already-shipped** auto-detect backend (#324) in the UI: a "Scan this Mac for data" action in (1) onboarding (`MindscapeInvite` data step) and (2) Streams→Sources (`ImportView`). When local Obsidian vaults / Claude Code sessions are found, show them with counts + date range and a one-click **Import** button. Claude Code gets a **clean (default) / full** toggle. Honest: only show "Found · Import" when the backend says `importable:true`.

Operator scope (locked): clean/full is **Claude-Code-only** (do NOT generalize to ChatGPT/email).

## Backend contract (verified — shipped in #324, NO backend change needed)

| Endpoint | Verb | Body | Response |
|---|---|---|---|
| `/portal/import/detect` | **GET** | — | `{ ok, sources: DetectedSource[] }` |
| `/portal/import/claude-code` | POST | `{ folderPath?, mode? }` (mode default `clean`) | `{ ok, scanned, imported, skipped, failed, mode, filtered, stats }` |
| `/portal/import/obsidian` | POST | `{ folderPath }` (server-side path from detect) | `{ ok, documentsUpserted, skipped, memoriesCreated, ... }` |

`DetectedSource` (from `src/ingest/detect-sources.js`):
```ts
{ source: 'obsidian' | 'claude-code', found: boolean, path: string,
  count: number, unit: 'notes' | 'sessions', importable: boolean,
  action: 'import-folder' | 'import-claude-code',
  dateRange?: [string|null, string|null],            // claude-code
  vaults?: { path, name, count }[] }                 // obsidian
```
The `api()` helper rewrites `/portal/*` → `/api/v1/portal/*` and adds CSRF + 401 redirect. `apiGet`/`apiPost` typed helpers exist (`api.ts:88,95`).

## Design — one component + one handler, used in both surfaces

Keep the static `SourceCatalog` as the reference list ("what you can bring in"). Add a **dynamic** actor beside it — a self-contained `<ScanForData>` panel — so the catalog stays static and honest while the scan panel owns the live "found on this Mac" state. DRY: both onboarding and ImportView render the same component.

### New: `portal-app/src/lib/import/detect.ts`
```ts
export interface DetectedSource { source; found; path; count; unit; importable; action; dateRange?; vaults? }
export async function scanSources(): Promise<DetectedSource[]>            // apiGet('/portal/import/detect') → d.sources ?? []
export interface DetectImportResult { imported; skipped; failed; detail }
export async function importDetected(s: DetectedSource, opts?: { mode?: 'clean'|'full' }): Promise<DetectImportResult>
  // action 'import-claude-code' → apiPost('/portal/import/claude-code', { folderPath: s.path, mode })
  // action 'import-folder'      → apiPost('/portal/import/obsidian',    { folderPath: s.path })
  // normalises the two response shapes into one {imported, skipped, failed, detail}
```

### New: `portal-app/src/lib/components/import/ScanForData.svelte`
Props: `{ compact?: boolean; onImported?: () => void }`.
States (one `$state` machine): `idle → scanning → results | empty | error`; per-source `importing`/`done`.
- Button: **"Scan this Mac for data"** (sub-label "Obsidian & Claude Code, found locally — nothing leaves your device").
- Results: one row per `found && importable` source — logo+name+color pulled from `SOURCE_CATALOG` by id (`obsidian`→`obsidian`, `claude-code`→`claude-code`), `"{count} {unit}"` + date range, **Import** button.
- Claude Code row only: a clean/full segmented toggle (default `clean`), with a one-line "clean = conversations only · full = every tool call".
- After import: row shows `✓ Imported N` (+ skipped), calls `onImported()`.
- Empty: "No Obsidian or Claude Code data found on this Mac." Error: surfaces `error.message`.

### Wiring
- **`MindscapeInvite.svelte`** data step (`:241`): insert `<ScanForData onImported={onImported} />` between the `ImportField` block and the "See everything you can bring in" toggle. (Reuses the existing `onImported` prop + `dataDone` flag.)
- **`ImportView.svelte`** (`:445`): insert `<div class="mb-8"><ScanForData /></div>` directly **above** `<SourceCatalog />`.

### Catalog honesty fix (`catalog.ts:93`)
`claude-code` entry currently `status: 'soon'` + "Direct session-transcript import is coming." — now false (#324 shipped it). Change to `status: 'upload'` and `howto: 'Run "Scan this Mac" below — imports your local sessions (clean conversations, or full with tool calls).'`. (Obsidian already `'upload'`; no change.) No new status enum value — minimal blast radius.

## Threat model / privacy
- Detection runs in the local backend (loopback, `os.homedir()`); returns presence/counts/dates only, never content (verified `detect-sources.js`). The UI shows only those scalars. No new egress.
- Import uses server-side `folderPath` from detect (never a client-supplied path) → no path-injection surface added beyond what #324 already validates.

## Test / verify
- `cd portal-app && npm run check` (svelte-check) + `npm run build` must pass.
- No new `verify:*` gate (frontend-only; the backend gates `verify:import-detect` 5/5 + `verify:claude-code-import` 8/8 already cover the API).
- **Live WKWebView smoke required** (flagged, operator/real-Mac): onboarding renders on empty vault only; "Scan this Mac" finds Obsidian + Claude Code, clean/full toggle imports.

## Verification table

| Assumption | Verified at |
|---|---|
| `/import/detect` is GET returning `{ ok, sources }` | `src/portal-import.js:67` + sweep contract |
| `DetectedSource` fields (source/count/unit/importable/action/dateRange/vaults) | `src/ingest/detect-sources.js:73` |
| claude-code import takes `{folderPath?, mode}`, default clean | `src/portal-import.js:76`, `import-parsers.js:229` |
| obsidian import accepts server-side `{folderPath}` | `src/portal-import.js:30`, `ImportView.svelte:227` |
| `api()` rewrites `/portal/`→`/api/v1/portal/`, CSRF, 401 | `portal-app/src/lib/api.ts:40,62,67` |
| `apiGet`/`apiPost` typed helpers exist | `api.ts:88,95` |
| Catalog ids `obsidian` + `claude-code`; SourceEntry has logo/color/name | `catalog.ts:61,93,11` |
| MindscapeInvite data step + `onImported` prop + `dataDone` | `MindscapeInvite.svelte:241,12,39` |
| ImportView renders `<SourceCatalog/>` at the catalog block | `ImportView.svelte:445` |
| claude-code catalog entry stale `status:'soon'` | `catalog.ts:93` |
