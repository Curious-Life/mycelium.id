# Database Architecture

## Overview

Mycelium uses **Cloudflare D1** (SQLite) for structured data and **Cloudflare Vectorize** for semantic search. Both are accessed via the MYA Worker proxy since the agents run on a Hetzner VPS, not on Cloudflare Workers.

```
VPS (mycelium agents)  ──HTTP──>  MYA Worker (Cloudflare)  ──binding──>  D1 + Vectorize
```

All embeddings use **BGE-M3** (1024D) via Cloudflare Workers AI.

## Abstraction Layer

Database access is centralized in two files:

| File | Purpose |
|------|---------|
| `lib/db.js` | Interface + initialization (`initDb()` / `getDb()`) |
| `lib/db-d1.js` | D1 + Vectorize implementation (calls Worker proxy) |

### Usage

```js
import { initDb, getDb } from './lib/db.js';

await initDb();             // call once at startup
const db = getDb();         // get singleton

await db.messages.insert([{ role: 'user', content: '...' }]);
const recent = await db.messages.selectRecent(userId, { limit: 50 });
const results = await db.messages.hybridSearch({ query, embedding, agentId });
```

### Interface Groups

```
db.messages          — insert, selectRecent, selectPaginated, selectByAgent, selectTimeline,
                       selectAll, countByUser, listAgentIds, hybridSearch, matchMessages,
                       matchDocuments
db.events            — insert (fire-and-forget event logging)
db.agentTasks        — create, getPending, getInProgress, start, complete, fail,
                       getToReport, markReported
db.attachments       — insert, getById, getByIds, listByUser, countByUser, update, delete
db.users             — count, create, getTimezone
db.userIdentities    — lookupByDiscord, list, unlink, link
db.sessions          — getByToken, create, delete, getUserByToken
db.passkeys          — listByUser, getByCredentialId, create, updateCounter
db.registrationTokens — create, validate, delete
db.oauthStates       — insert, validate, delete
db.documents         — get, upsert, list, pin, unpin
db.tasks             — create
db.folders           — list
db.canvases          — list, addDocument
db.mindscape         — getPoints, getThemeCards, getTerritoryProfiles, getRealms,
                       getSemanticThemes, lookupTerritoryByName
db.search            — matchTerritories, matchRealms, matchThemes
db.topology          — getCoFiring, getOrphans, getBridges, getGaps, getCluster
```

## D1 Schema

Schema lives in `migrations/d1-schema.sql`. Tables organized into groups:

- **Core content**: messages, clustering_points, documents, document_versions
- **Mindscape hierarchy**: realms, semantic_themes, territory_profiles, theme_cards, internal_model_items
- **Co-firing & spatial**: territory_cofire, territory_neighbors, realm_neighbors
- **Knowledge**: reflections, cycle_metrics
- **Canvas**: canvas_workspaces, canvas_nodes, canvas_edges, canvas_collaborators
- **Entities**: people, note_links
- **Access control**: access_grants
- **Auth**: users, sessions, registration_tokens, passkey_credentials, share_links
- **Agent-specific**: agent_events, agent_tasks, user_identities, oauth_states
- **Jobs**: batch_jobs, import_jobs, scheduled_events, tasks, folders, attachments

D1 is SQLite, so:
- No `vector()` type — embeddings live in Vectorize, not D1
- No `jsonb` — use `TEXT` with `JSON.parse()`/`JSON.stringify()`
- No `uuid` — use `TEXT` with `lower(hex(randomblob(16)))`
- No `timestamptz` — use `TEXT` (ISO 8601)

### Applying Schema Changes

```bash
npx wrangler d1 execute mycelium --remote --file=migrations/d1-schema.sql
```

## Vectorize Indexes

Two indexes with different embedding models:

| Index | Binding | Dimensions | Model | Purpose |
|-------|---------|-----------|-------|---------|
| `mycelium-search` | `VECTORS_1024` | 1024 | BGE-M3 | Semantic search (messages, documents, territories, realms, themes) |
| `mycelium-cluster` | `VECTORS_256` | 256 | Nomic v1.5 | HDBSCAN clustering substrate |

### Metadata

Search index vectors include: `{ type, userId, agentId }`
Cluster index vectors include: `{ type, userId, sourceType, sourceId }`

## Worker Proxy Endpoints

All endpoints require `Authorization: Bearer <MYA_WORKER_SECRET>`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/db/query` | POST | Execute single SQL on D1 |
| `/api/db/batch` | POST | Batch SQL statements |
| `/api/vectors/upsert` | POST | Upsert to Vectorize index |
| `/api/vectors/query` | POST | Similarity search |
| `/api/search/hybrid` | POST | Keyword (FTS5) + semantic search, merged with RRF |
| `/api/embed` | POST | Generate BGE-M3 embedding via Workers AI |
| `/attachments/:key` | GET/DELETE | Serve or delete R2 objects |
| `/stream-token/:uid` | GET | Generate signed Cloudflare Stream playback token |
| `/stream-delete/:uid` | DELETE | Delete Cloudflare Stream video |

### Security

The proxy (`MYA-0.2/src/handlers/db-proxy.ts`) enforces:

- **Timing-safe auth** via `crypto.subtle.timingSafeEqual`
- **CORS** restricted to portal domain (configured in `worker/src/utils/cors.ts`)
- **DDL blocklist** — DROP, ALTER, CREATE, ATTACH, DETACH, REINDEX, VACUUM all blocked
- **Input limits** — max SQL length (50KB), max params (500), max batch (100 statements), max vector batch (1000), max topK (100)
- **Sanitized errors** — internal details never leaked to clients

## Embeddings

`lib/embed.js` provides `generateEmbedding(text)` — calls MYA Worker's `/api/embed` endpoint to generate a 1024D BGE-M3 vector. Text is truncated to 8000 chars.

```js
import { generateEmbedding } from './lib/embed.js';
const vector = await generateEmbedding('some text to embed');
// vector: number[1024]
```

## Migration (historical)

The migration from Supabase to D1 is complete. The migration script (`scripts/migrate-to-d1.js`) was used for the one-time data transfer and is kept for reference only.
