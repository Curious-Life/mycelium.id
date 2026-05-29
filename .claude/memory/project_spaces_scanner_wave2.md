---
name: Spaces scanner search-client migration (Wave 2)
description: packages/core/spaces/scanners/* still call db.messages.matchMessages directly — broken in MCP context for the same reason searchMindscape was; needs the same /internal/v1/search/mindscape rewire
type: project
originSessionId: 71b0db27-201e-42f6-b4e5-86cf389aba5e
---
**Fact:** The spaces scanners (`packages/core/spaces/scanners/{messages,documents,territories}.js`) still take an `embedding` and call `db.messages.matchMessages(embedding, …)` / `db.search.matchTerritories(embedding, …)` directly. In the MCP-tool subprocess these registries are empty → fall through to Vectorize → broken since BGE shutdown. They have an FTS5 fallback path but FTS5 is also broken for encrypted rows.

**Why:** The Wave-1 search-mindscape work (May 2026) intentionally scoped to the user-facing `searchMindscape` tool + `topology.js` resolver. Spaces' `space_scan` tool is also degraded but was already broken before; fixing it is structurally identical (HTTP via `searchClient.searchMindscape`) but warrants its own focused PR + tests so the curation flow gets verified end-to-end.

**How to apply:** When tackling this:
1. Add optional `searchClient` dep to scanners (matches Wave-1 topology.js pattern). When present, route through `/internal/v1/search/mindscape` with `corpora: ['messages']` / `['documents']` / `['territories']`. When absent (in-process callers from agent-server), keep existing `db.search.*` path.
2. Thread `searchClient` from `agent-tools.js` (already created at startup as part of Wave 1) through `createSpacesDomain` → `scanCorpus({ ..., searchClient })`.
3. Drop the FTS5 fallback path in scanners — it never works on encrypted rows. Replace with a clear "search unavailable" surface in space_scan output when both mind-search and FTS are down.
4. Update space-scanner tests to mock `searchClient.searchMindscape` instead of `db.messages.matchMessages`.

**Touchpoints:** `packages/core/spaces/scanners/messages.js`, `documents.js`, `territories.js`, `index.js`; `packages/tools/agent-tools/domains/spaces.js`; `packages/tools/agent-tools.js` (one-line dep wiring).
