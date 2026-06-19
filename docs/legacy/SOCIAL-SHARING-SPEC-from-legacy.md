# Social Sharing & Connection Mindscapes — Implementation Spec

**Date**: 2026-04-05
**Status**: Reviewed, ready for implementation

---

## What exists today

- **Single-user mindscape**: 3D Map, Territories view, Growth timeline. Drilldown: Realms → Themes → Territories.
- **Territory profiles**: name, essence, chronicle, story arc, entities, patterns, activity timelines, agent fields.
- **Contact graph**: 2,480 contacts with 5 engagement tiers (inner/engaged/acknowledged/connected/noise). 359 territory links with strength scores.
- **Contact display**: Contacts appear as gold dots in 3D view, linked contacts shown in territory detail panel. Tier filtering in layer controls.
- **No sharing**: All data is user_id scoped. No public profiles, no multi-user access, no visibility controls.

## What we're building

A social layer where users can:
1. See their own cognitive fingerprint (stats about how they think)
2. Control what's visible per territory (Private/Friends/Public)
3. Share a profile card that reveals interests without exposing content
4. Discover other users with overlapping interests
5. See the "shape" of a connection — where two minds overlap and diverge

---

## Phase 1: Profile & Visibility (MVP)

### 1.1 Cognitive Fingerprint (Public Profile)

**What the user sees:**
A new "Profile" card accessible from the portal sidebar or a `/profile` route. Shows:

```
┌─────────────────────────────────────────┐
│  mycelium.id/@person                    │
│                                         │
│  12 territories · 5 realms              │
│  48,231 messages · since Sep 2024       │
│                                         │
│  ── Thinking Style ──────────────────   │
│  Depth       ████████░░  deep-diver     │
│  Breadth     ███████░░░  polymathic     │
│  Coherence   █████████░  integrated     │
│  Exploration ██████░░░░  balanced       │
│                                         │
│  ── Active Realms ───────────────────   │
│  ◉ Technology & Systems                 │
│  ◉ Intelligence & Strategy              │
│  ◉ Inner Work                           │
│                                         │
│  ── Signature ───────────────────────   │
│  "Builds systems, thinks in networks"   │
│                                         │
│  [Share Profile]  [Edit Visibility]     │
└─────────────────────────────────────────┘
```

**What's computed:**
- **Territory count**: from `clustering_points` distinct territory_ids
- **Realm count**: from territory_profiles distinct realm_ids
- **Depth score**: average intra-cluster distance (how deep within topics)
- **Breadth score**: number of territories normalized
- **Coherence**: mean inter-territory cosine similarity (how connected thinking is)
- **Exploration**: entropy of monthly territory transition matrix
- **Signature**: Claude-generated one-liner from realm names + stats (cached, regenerated weekly)

**Data safety**: All of this is statistical/categorical. No embeddings, no centroids, no content. Safe for public display per Ada's research.

**Database:**
```sql
-- Migration: 103_user_profiles.sql
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,                    -- @person
  display_name TEXT,                     -- encrypted
  signature TEXT,                        -- one-line bio, encrypted
  stats_json TEXT,                       -- {depth, breadth, coherence, exploration, territory_count, realm_count, message_count, member_since}
  public_realms_json TEXT,              -- realm names visible publicly
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**API endpoints:**
```
GET  /portal/profile              → own profile + stats
PUT  /portal/profile              → update handle, display_name, signature
GET  /portal/profile/:handle      → public profile (stats + public realms only)
POST /portal/profile/stats/recompute → recompute cognitive fingerprint
```

**Portal UI:**
- New route: `portal/src/routes/(app)/profile/+page.svelte`
- Sidebar link between "Mindscape" and "Wealth"
- Profile card component: `portal/src/lib/components/profile/ProfileCard.svelte`

### 1.2 Per-Territory Visibility

**What the user sees:**
In the Territories view, each territory card gets a small visibility indicator. Clicking it opens a dropdown:

```
Territory: Distributed Systems
Visibility: [🔒 Private ▾]
            ┌──────────────┐
            │ 🔒 Private   │  ← default, only you
            │ 👥 Friends   │  ← approved connections
            │ 🌐 Public    │  ← visible on profile
            └──────────────┘
```

When set to Public, the territory **name and essence** appear on the public profile. NOT the chronicle, NOT the entities, NOT the contact links, NOT any embeddings.

When set to Friends, approved connections can see territory name + essence + activity sparkline.

**Database:**
```sql
-- Migration: 104_territory_visibility.sql
ALTER TABLE territory_profiles ADD COLUMN visibility TEXT DEFAULT 'private';
-- Values: 'private' | 'friends' | 'public'
```

**API:**
```
PUT /portal/mindscape/territory/:id/visibility  body: { visibility: 'public' }
```

**Portal UI:**
- Visibility badge on territory cards in Territories view
- Dropdown selector (3 options)
- Batch visibility: "Set all in realm to..." dropdown on realm cards

### 1.3 Shareable Profile Card

**What the user sees:**
A "Share Profile" button that generates a link: `mycelium.id/@person`

The public page (served from mycelium.id-site, not the portal) shows:
- Handle, signature
- Cognitive fingerprint bars
- Public realm names
- Public territory names + essences
- "Connect on Mycelium" CTA

**Implementation:**
- `mycelium.id/@:handle` route — fetches from Worker API
- Worker endpoint: `GET /api/public/profile/:handle` — returns only public data
- No auth required for viewing
- Profile data cached in KV (5 min TTL)

---

## Phase 2: Connections & Overlap

### 2.1 Connection Requests

**What the user sees:**
On a public profile page, a "Connect" button. Clicking it sends a connection request visible in the portal.

```
┌─────────────────────────────────────────┐
│  Connection Requests                     │
│                                         │
│  @alice wants to connect                │
│  "Builds systems, thinks in networks"   │
│  3 shared realms · Deep match           │
│  [Accept]  [Ignore]                     │
│                                         │
│  @bob wants to connect                  │
│  "Strategy meets execution"             │
│  1 shared realm · Complementary         │
│  [Accept]  [Ignore]                     │
└─────────────────────────────────────────┘
```

**Database:**
```sql
-- Migration: 105_connections.sql
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',        -- pending | accepted | rejected
  overlap_json TEXT,                    -- computed overlap at request time
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  UNIQUE(from_user_id, to_user_id)
);
```

**API:**
```
POST /portal/connections/request      body: { toHandle: '@alice' }
GET  /portal/connections/pending      → incoming requests
POST /portal/connections/:id/accept
POST /portal/connections/:id/reject
GET  /portal/connections              → all accepted connections
```

### 2.2 Connection Mindscape (Overlap Visualization)

**What the user sees:**
After connecting, clicking a connection shows the overlap view:

```
┌─────────────────────────────────────────────────────┐
│  You & @alice                                        │
│  Match: 67%  ·  Shape: Deep Collaborators            │
│                                                      │
│  ┌─────────────────────────────────────────────┐     │
│  │     ╭───╮                                    │     │
│  │    ╱ You ╲    ╭────────────╮                  │     │
│  │   │       │──│  Shared    │──╮               │     │
│  │   │ Inner │  │            │  │   ╭─────╮     │     │
│  │   │ Work  │  │ Dist Sys   │  ├──│ Alice │    │     │
│  │   │       │  │ ML Theory  │  │  │       │    │     │
│  │    ╲     ╱   │ Security   │  │  │ Music │    │     │
│  │     ╰───╯    ╰────────────╯──╯  │ Crypto│    │     │
│  │                                  ╰─────╯     │     │
│  └─────────────────────────────────────────────┘     │
│                                                      │
│  ── Shared Territories ─────────────────────────     │
│  ◉ Distributed Systems    depth: you ████  her ██    │
│  ◉ ML Theory              depth: you ███   her ████  │
│  ◉ Security Engineering   depth: you ██    her ███   │
│                                                      │
│  ── Only You ──────────────────────────              │
│  ◉ Inner Work  ◉ Philosophy  ◉ Parenting             │
│                                                      │
│  ── Only @alice ─────────────────────────            │
│  ◉ Music Production  ◉ Cryptography  ◉ Art           │
│                                                      │
│  Connection shape: Deep Collaborators                │
│  "Strong overlap in technical domains.               │
│   You go deeper in systems, she goes deeper in ML.   │
│   Complementary in non-technical interests."         │
└─────────────────────────────────────────────────────┘
```

**How overlap is computed:**

Overlap is computed **on-demand when viewed**, not at request time. Cached with a 1-hour TTL, invalidated when either user's territory set changes (detected by comparing territory_profiles.updated_at).

1. **Label matching**: Compare territory names at Friends visibility or higher. Exact string matches only in Phase 1. Note: fuzzy matching deferred to Phase 3 (would use Nomic embeddings of label strings — low-risk but keep these ephemeral, never stored cross-user).
2. **Match score** (0-100): `shared_territories / union_territories * 100`, weighted by territory size. **Minimum 3 shared territories** to compute a percentage; below that, show "Early connection — not enough overlap to score yet" instead of a misleading number.
3. **Depth comparison**: For shared territories, compare relative message counts (normalized to each user's max).
4. **Shape classification**:
   - **Deep Collaborators**: high overlap, balanced depth
   - **Broad Kindred Spirits**: many shared territories, varying depth
   - **Complementary Thinkers**: low overlap, unique territories fill gaps
   - **Asymmetric**: one person's interests are a subset
   - **Twin Minds**: very high overlap + similar depth

5. **Connection narrative**: Claude-generated 2-sentence summary from the overlap data (labels + stats only, no content). Cached in overlap_json, regenerated when overlap cache is invalidated.

**Data flow (privacy-preserving):**
- Only territory **names and essences** cross user boundaries (for Friends+ visibility territories)
- No centroids, no embeddings, no content shared between users
- Overlap computed server-side using territory labels only (Phase 1)
- Future: DP-noised centroids for richer "related but differently named" matching (Phase 3)

**API:**
```
GET /portal/connections/:connectionId/overlap → overlap data
```

**Portal UI:**
- New component: `portal/src/lib/components/social/ConnectionOverlap.svelte`
- Venn diagram (CSS/SVG, not 3D)
- Shared/unique territory lists with depth bars
- Shape badge + narrative

### 2.3 Connection List in Portal

**What the user sees:**
New "Connections" section accessible from sidebar:

```
┌─────────────────────────────────────────┐
│  Connections (7)                         │
│                                         │
│  @alice · Deep Collaborators · 67%      │
│  @bob   · Complementary     · 34%      │
│  @carol · Broad Kindred     · 52%      │
│  ...                                    │
│                                         │
│  [Discover People]                      │
└─────────────────────────────────────────┘
```

---

## Phase 3: Context Templates & Granular Access

### 3.1 Context Templates

Instead of configuring visibility per-territory one at a time, users group territories into named contexts that map to different facets of their identity.

**What the user sees:**

In the Profile section, a "Sharing Contexts" tab:

```
┌─────────────────────────────────────────────────┐
│  Sharing Contexts                                │
│                                                  │
│  ── Work Self ──────────────────────────         │
│  Territories: Distributed Systems, ML Infra,     │
│               Team Management, DevOps            │
│  Shared with: @alice, @bob                       │
│  [Edit] [Add territory]                          │
│                                                  │
│  ── Social Self ────────────────────────         │
│  Territories: Philosophy, Cooking, Music         │
│  Shared with: @carol, @dave, @eve               │
│  [Edit] [Add territory]                          │
│                                                  │
│  ── Private Self ───────────────────────         │
│  Territories: Therapy, Health, Relationships     │
│  Always private · Cannot be shared               │
│  [Edit territories]                              │
│                                                  │
│  [+ Create Context]                              │
└─────────────────────────────────────────────────┘
```

**How it works:**
- Each context is a named group of territories + a list of connections who can see them
- A territory can belong to multiple contexts
- Sharing a context with a connection grants Friends-level access to all territories in that context
- "Private Self" is a special context that cannot be shared — territories here are always invisible
- Default contexts created on first profile setup: "Work Self", "Social Self", "Creative Self", "Private Self"
- Users can create custom contexts: "Book Club", "Research Group", etc.
- Max 20 contexts per user

**Visibility resolution order** (checking if user B can see user A's territory):
1. Is territory set to "Public"? → visible to everyone
2. Is territory in any context shared with B? → visible to B
3. Is territory set to "Friends" AND B is a connection? → visible to B
4. Otherwise → not visible

**Database:**
```sql
-- Migration: 106_sharing_contexts.sql
CREATE TABLE IF NOT EXISTS sharing_contexts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_private BOOLEAN DEFAULT FALSE,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS context_territories (
  context_id TEXT NOT NULL,
  territory_id TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, territory_id),
  FOREIGN KEY (context_id) REFERENCES sharing_contexts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS context_grants (
  context_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, connection_id),
  FOREIGN KEY (context_id) REFERENCES sharing_contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX idx_context_grants_conn ON context_grants(connection_id);
```

**API:**
```
GET    /portal/contexts                              → list contexts with territory counts
POST   /portal/contexts                              → create {name, is_private}
PUT    /portal/contexts/:id                          → rename
DELETE /portal/contexts/:id                          → delete (territories revert to Private)
POST   /portal/contexts/:id/territories              → add territory {territory_id}
DELETE /portal/contexts/:id/territories/:territory_id → remove territory
POST   /portal/contexts/:id/grant                    → share with connection {connection_id}
DELETE /portal/contexts/:id/grant/:connection_id      → revoke access
GET    /portal/contexts/:id/connections               → who has access
```

**Edge cases:**
- Territory removed from all contexts → reverts to Phase 1 base visibility
- Connection disconnected → context_grants CASCADE deleted
- Context deleted → territories revert to Private unless in another context

---

## Phase 4: Discovery & Semantic Matching

### 4.1 Discovery Index Architecture

**The problem Phase 2 can't solve:** Two users may have deeply overlapping interests but name their territories differently. "Distributed Computing" vs "Scalable Systems" won't match on labels.

**Three-layer privacy architecture:**

| Layer | Purpose | Storage | Risk |
|-------|---------|---------|------|
| **LSH Hashes** | Fast candidate retrieval | Separate D1 DB | Non-invertible, lossy. k-anonymity enforced (min 5 users/bucket) |
| **DP-Noised Centroids** | Re-ranking after LSH | Separate Vectorize index | CMAG noise ε=3 public, ε=1 sensitive. Similarity scores only — centroids never served |
| **SMPC Precise** | Bilateral deep match | Ephemeral (not stored) | CKKS homomorphic. Neither party sees raw data. Mutual opt-in required |

### 4.2 Discovery Feed

**What the user sees:**

```
┌──────────────────────────────────────────────────────┐
│  Discover People                                      │
│                                                       │
│  ── Strong Matches ──────────────────────────         │
│  @phoenix · 82% similarity · 5 shared realms          │
│  "Designs systems that learn from users"              │
│  Shared: Technology, Intelligence, Inner Work         │
│  [View Profile] [Connect]                             │
│                                                       │
│  ── Style Matches ───────────────────────────         │
│  @atlas · Style: 89% · Topics: 31%                    │
│  "Deep diver, low breadth — intense focus"            │
│  Different topics, similar thinking patterns          │
│  [View Profile] [Connect]                             │
│                                                       │
│  ── Complementary ───────────────────────────         │
│  @nova · Complementary: 78%                           │
│  "Strong where you're curious"                        │
│  [View Profile] [Connect]                             │
│                                                       │
│  [Discovery Settings]                                 │
└──────────────────────────────────────────────────────┘
```

**Three discovery modes:**
1. **Topic match**: High label + centroid overlap. "People who think about similar things."
2. **Style match**: High cognitive fingerprint similarity, potentially different topics. "People who think in similar ways."
3. **Complementary**: Low overlap + territories that fill the other user's gaps. "People who can teach you something new."

**Discovery is NEVER default.** Explicit opt-in via settings:
- Toggle: appear in discovery on/off
- Checkboxes: what's used for matching (labels, stats, DP-noised centroids)
- Who can discover: anyone / people with 2+ shared realms / nobody

### 4.3 Discovery Computation Pipeline

**Step 1: Index build** (background, runs on opt-in or territory change)
- Collect public territory labels → label set
- Collect cognitive fingerprint → 4D vector [depth, breadth, coherence, exploration]
- If centroid sharing enabled: apply CMAG noise (ε=3 normal, ε=1 sensitive), compute LSH hashes (18-bit cross-polytope, L=10 tables)

**Step 2: Candidate retrieval** (on query)
- Query LSH for users sharing ≥2 hash buckets
- Filter: self, existing connections, blocked, dismissed
- k-anonymity check: suppress if label combination unique to <5 users
- Max 100 candidates

**Step 3: Re-ranking** (server-side, no raw data exposed)
- Composite: `0.4 * label_overlap + 0.3 * centroid_similarity + 0.2 * stat_similarity + 0.1 * complementary`
- Classify: Strong Match / Style Match / Complementary
- Min 20% composite to show

### 4.4 Combinatorial Fingerprinting Guard

Before labels enter the discovery index:
1. Hash sorted label set, count users with identical set
2. If count < 5: generalize rarest labels to Theme-level
3. If still unique: generalize to Realm-level
4. If still unique: suppress and notify user
5. Randomized response (p=0.05): each label has 5% chance of random swap within same Theme

### 4.5 Database

```sql
-- Migration: 107_discovery.sql
CREATE TABLE IF NOT EXISTS discovery_profiles (
  user_id TEXT PRIMARY KEY,
  opted_in BOOLEAN DEFAULT FALSE,
  centroid_sharing BOOLEAN DEFAULT FALSE,
  visibility TEXT DEFAULT 'anyone',       -- 'anyone' | 'shared_realms' | 'nobody'
  label_set_json TEXT,
  stats_vector TEXT,                      -- [depth, breadth, coherence, exploration]
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discovery_centroids (
  user_id TEXT NOT NULL,
  territory_id TEXT NOT NULL,
  noised_centroid BLOB,                   -- 256D float32, DP noise applied
  epsilon_used REAL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, territory_id)
);

CREATE TABLE IF NOT EXISTS discovery_lsh (
  user_id TEXT NOT NULL,
  table_idx INTEGER NOT NULL,
  hash_value INTEGER NOT NULL,
  territory_id TEXT NOT NULL,
  PRIMARY KEY (user_id, table_idx, territory_id)
);
CREATE INDEX idx_lsh_lookup ON discovery_lsh(table_idx, hash_value);

CREATE TABLE IF NOT EXISTS discovery_dismissed (
  user_id TEXT NOT NULL,
  dismissed_user_id TEXT NOT NULL,
  dismissed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, dismissed_user_id)
);
```

**Note:** Discovery data stored in a **separate D1 database** — physical isolation from main Mycelium data.

**API:**
```
GET    /portal/discovery                 → feed (paginated, 20/page)
GET    /portal/discovery/settings        → current settings
PUT    /portal/discovery/settings        → update (opt in/out, centroid sharing, visibility)
POST   /portal/discovery/:userId/dismiss → dismiss suggestion
POST   /portal/discovery/reindex         → force reindex (1/day limit)
```

---

## Phase 5: Deep Matching & Shared Spaces

### 5.1 SMPC Precise Matching (Bilateral Consent)

**What this solves:** LSH + DP gives approximate matches. Connected users who want precise overlap — including differently-named but semantically identical territories — can opt into secure bilateral computation.

**What the user sees (on Connection Overlap page):**

```
┌──────────────────────────────────────────────────────┐
│  ── Deep Match (optional) ───────────────────         │
│  Want to discover hidden overlaps?                    │
│  Computes precise semantic similarity without         │
│  either of you seeing the other's raw data.           │
│                                                       │
│  Status: You opted in. Waiting for @alice.            │
│  [Revoke opt-in]                                      │
└──────────────────────────────────────────────────────┘
```

**How it works:**
1. Both users opt in (mutual consent)
2. A's agent encrypts territory centroids (contexts shared with B only) using CKKS (TenSEAL)
3. Encrypted centroids (~10KB/territory) sent to server → forwarded to B's agent
4. B computes `HE_inner_product(encrypted_A, B_centroid)` for all pairs
5. Encrypted similarity scores returned to A for decryption
6. Symmetric: B gets the same matrix
7. Neither party sees raw centroids

**What it reveals beyond Phase 2:**
- Differently-named but semantically identical territories (cosine > 0.7)
- Precise depth comparison at centroid level
- Sub-territory alignment within shared topics

**Computation:** ~5-20ms per pair. 15 territories each = 225 pairs × 20ms ≈ 4.5 seconds.

**Database:** Add to connections table:
```sql
ALTER TABLE connections ADD COLUMN deep_match_a BOOLEAN DEFAULT FALSE;
ALTER TABLE connections ADD COLUMN deep_match_b BOOLEAN DEFAULT FALSE;
ALTER TABLE connections ADD COLUMN deep_overlap_json TEXT;
ALTER TABLE connections ADD COLUMN deep_overlap_computed_at TEXT;
```

### 5.2 Tree-Wasserstein Overlap

Uses the Realm→Theme→Territory hierarchy to measure overlap that respects semantic distance.

- Two users sharing territories in the same Theme are more similar than two sharing across Realms — Jaccard treats both equally
- TWD handles differently-named territories at the same hierarchical position
- Edge weights: Realm→Theme = 0.25, Theme→Territory = 0.5
- Shown in deep overlap view: `Label match: 67% · Semantic match: 81% (TWD)`

### 5.3 Shared Spaces

**What the user sees:**

```
┌──────────────────────────────────────────────────────┐
│  Shared Space: You & @alice                           │
│                                                       │
│  ◉ Distributed Systems                                │
│  ┌─────────────────────────────────────────┐          │
│  │ Your perspective     │ Alice's perspective│         │
│  │ 423 messages         │ 287 messages       │         │
│  │ Essence: "Building   │ Essence: "Consensus│         │
│  │  fault-tolerant      │  algorithms and    │         │
│  │  systems"            │  CAP theorem"      │         │
│  └─────────────────────────────────────────┘          │
│                                                       │
│  ── Conversation Starters ───────────────────         │
│  "You focus on fault tolerance, she focuses on        │
│   consensus. Compare approaches to Byzantine          │
│   failures?"                                          │
│                                                       │
│  [Start Discussion] [Leave Space]                     │
└──────────────────────────────────────────────────────┘
```

**NOT shared:** message content, raw embeddings, atom data, contacts, chronicles, entities.
**Shared:** territory essences, activity sparklines (relative intensity only), depth bars, AI conversation starters.

Both parties must accept. Either can leave. Max 10 shared spaces per user.

```sql
-- Migration: 108_shared_spaces.sql
CREATE TABLE IF NOT EXISTS shared_spaces (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending',          -- pending | active | archived
  settings_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
```

### 5.4 SPARSE Concept-Aware Privacy

Enhancement to Phase 4 centroid noising. When a territory is marked sensitive (or assigned to "Private Self"):
- Train binary mask (~2s CPU, ~150 lines PyTorch) identifying 20-50 dimensions encoding that territory's content
- Apply ε=0.5 to those dimensions, ε=5 to others
- Discovery still matches on non-sensitive aspects; specific content direction maximally protected
- Automatic, no user interaction needed — triggered by sensitivity marking

---

## Database Migration Summary

```sql
-- 103_user_profiles.sql
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,                    -- validated: 3-30 chars, [a-z0-9_] only
  display_name TEXT,                     -- encrypted
  signature TEXT,                        -- encrypted, decrypted server-side for public endpoint
  depth_score REAL,                      -- 0-1, avg intra-cluster distance
  breadth_score REAL,                    -- 0-1, normalized territory count
  coherence_score REAL,                  -- 0-1, mean inter-territory similarity
  exploration_score REAL,                -- 0-1, transition matrix entropy
  territory_count INTEGER DEFAULT 0,
  realm_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  member_since TEXT,
  public_realms_json TEXT,               -- realm names visible publicly
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 104_territory_visibility.sql  
ALTER TABLE territory_profiles ADD COLUMN visibility TEXT DEFAULT 'private';
-- Values: 'private' | 'friends' | 'public'

-- 105_connections.sql
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,                  -- always min(from, to) for canonical order
  user_b TEXT NOT NULL,                  -- always max(from, to)
  initiated_by TEXT NOT NULL,            -- who sent the request
  status TEXT DEFAULT 'pending',         -- pending | accepted | rejected | blocked
  overlap_json TEXT,                     -- cached overlap, TTL-based refresh
  overlap_computed_at TEXT,              -- when overlap was last computed
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  UNIQUE(user_a, user_b)
);
CREATE INDEX idx_connections_a ON connections(user_a, status);
CREATE INDEX idx_connections_b ON connections(user_b, status);
```

**Handle validation rules** (application layer, not migration):
- 3-30 characters
- Lowercase alphanumeric + underscores only: `/^[a-z][a-z0-9_]{2,29}$/`
- Reserved: `admin`, `support`, `api`, `system`, `mycelium`, `vault`, `login`, `signup`, `profile`, `settings`, `help`, `about`

**Connection symmetry**: `user_a` is always `min(from, to)`, `user_b` is always `max(from, to)`. Single row per pair. `initiated_by` tracks who sent the request. Lookup: `WHERE (user_a = ? AND user_b = ?) AND status = 'accepted'` — no OR needed.

## API Summary

| Endpoint | Method | Auth | Phase | Notes |
|----------|--------|------|-------|-------|
| `/portal/profile` | GET | user | 1 | Own profile + stats |
| `/portal/profile` | PUT | user | 1 | Update handle, display_name, signature. Handle validated. |
| `/portal/profile/:handle` | GET | public | 1 | Public-only fields. Signature decrypted server-side. Cached in KV (5min), invalidated on PUT. |
| `/portal/profile/stats/recompute` | POST | user | 1 | Rate limited: 1/hour. |
| `/portal/mindscape/territory/:id/visibility` | PUT | user | 1 | Body: `{visibility}`. Confirmation required for batch (realm-level). |
| `/api/public/profile/:handle` | GET | none | 1 | Worker endpoint. Returns only public data, never encrypted blobs. |
| `/portal/connections/request` | POST | user | 2 | Body: `{toHandle}`. Max 20 pending per user. Blocked users cannot re-request. |
| `/portal/connections/pending` | GET | user | 2 | Incoming requests |
| `/portal/connections/:id/accept` | POST | user | 2 | |
| `/portal/connections/:id/reject` | POST | user | 2 | |
| `/portal/connections/:id/block` | POST | user | 2 | Prevents re-requesting. Sets status='blocked'. |
| `/portal/connections/:id` | DELETE | user | 2 | Disconnect. Removes overlap cache. |
| `/portal/connections` | GET | user | 2 | All accepted connections with cached overlap summary |
| `/portal/connections/:id/overlap` | GET | user | 2 | On-demand computation, cached 1hr, invalidated on territory change |

## Portal UI Changes

| Component | Route/Location | Phase |
|-----------|---------------|-------|
| ProfileCard | `/profile` page | 1 |
| CognitiveFingerprint | Bars showing depth/breadth/coherence/exploration | 1 |
| Visibility dropdown | Territory cards in Territories view | 1 |
| BatchVisibilityConfirm | Modal for realm-level visibility changes | 1 |
| Public profile page | `mycelium.id/@:handle` (static site, fetches from Worker) | 1 |
| ConnectionsList | `/connections` page or sidebar section | 2 |
| ConnectionOverlap | Click connection → Venn + depth bars + narrative | 2 |
| ConnectionRequests | Notification badge on sidebar + pending list | 2 |
| DisconnectConfirm | Confirmation modal for disconnect/block | 2 |

## Edge Cases & Guards

**Disconnect flow**: `DELETE /portal/connections/:id` removes the connection. Both users lose access to overlap data. Overlap cache deleted. Neither user sees the other's Friends-visibility territories anymore.

**Block flow**: `POST /portal/connections/:id/block` sets status to `blocked`. Blocked users cannot send new requests (`/request` checks for existing blocked row). Blocked user sees nothing — no error, no "blocked" message, just "User not found" on profile lookup.

**Profile deactivation**: If a user deletes their profile (removes `user_profiles` row), connected users see "This person is no longer on Mycelium" with the connection retained (for potential reactivation). Handle is released after 30 days.

**Notification delivery**: Phase 2 MVP is portal-only (badge on Connections nav item). Future: push to Telegram/Discord via the user's personal agent ("You have a new connection request from @alice").

**Batch visibility confirmation**: When setting visibility at realm level ("Set all territories in this realm to Public"), show confirmation: "This will make N territories visible to everyone. Continue?" Requires explicit confirm, not a single click.

**Signature on public endpoint**: `GET /api/public/profile/:handle` decrypts the signature field server-side and returns plaintext. If no signature is set, returns `null`. Never returns encrypted blobs on public endpoints.

**Stats recompute**: Debounced to 1/hour per user. Computation reads from clustering_points and territory_profiles — can be expensive for large mindscapes. Runs async, returns immediately with "Recomputing..." status.

**Combinatorial fingerprinting** (Phase 3 guard): Before Phase 3 discovery, add a check: if a user's set of public territory labels is unique enough to fingerprint them (<1000 users with the same label combination), warn them or auto-generalize to theme-level labels for the discovery index.

## What's NOT shared (ever)

- Raw embeddings (256D Nomic vectors)
- Individual atom vectors
- Territory centroids (unnoised)
- Message content
- Contact names or details
- Chronicle text
- Entity lists
- Signature patterns
- Open questions
- Any encrypted field

## What IS shared

| Data | Visibility Level | Shared With |
|------|-----------------|-------------|
| Handle, signature | Always | Public |
| Cognitive stats (depth, breadth, etc.) | Always | Public |
| Realm names | Always | Public |
| Territory count per realm | Always | Public |
| Territory names + essences | Per-territory setting | Public or Friends |
| Activity sparklines | Per-territory setting | Friends only |
| Overlap score + shape | On connection | Mutual connections |
| Depth comparison bars | On connection | Mutual connections |
| Connection narrative | On connection | Mutual connections |

## Implementation Order

### Phase 1: Profile & Visibility
1. **Migration 103**: user_profiles table (stats as columns, not JSON)
2. **Migration 104**: territory_profiles.visibility column
3. **Profile computation**: script to compute cognitive fingerprint from clustering_points + territory_profiles
4. **Profile API**: GET/PUT endpoints in agent-server.js (handle validation, signature decrypt for public)
5. **Profile UI**: ProfileCard + CognitiveFingerprint components, `/profile` route
6. **Visibility UI**: dropdown on territory cards, batch confirm modal
7. **Worker endpoint**: `GET /api/public/profile/:handle` with KV caching
8. **Public profile page**: `mycelium.id/@:handle` route on static site

### Phase 2: Connections
9. **Migration 105**: connections table (canonical user_a/user_b ordering)
10. **Connection API**: request (rate-limited), accept, reject, block, disconnect, list, overlap
11. **Overlap computation**: on-demand label matching, match score (min 3 shared), shape classification, Claude narrative
12. **Connection UI**: ConnectionsList, ConnectionOverlap (Venn + depth bars), notification badge
13. **Disconnect/block flows**: confirmation modals, blocked user handling

### Phase 3: Context Templates
14. **Migration 106**: sharing_contexts + context_territories + context_grants
15. **Context API**: CRUD for contexts, territory assignment, grant management
16. **Context UI**: SharingContexts editor, territory drag-and-drop, connection picker
17. **Visibility resolution**: update all territory visibility checks to honor context grants

### Phase 4: Discovery
18. **Migration 107**: discovery_profiles + discovery_centroids + discovery_lsh + discovery_dismissed (separate D1 DB)
19. **CMAG noise implementation** (~50 lines numpy)
20. **LSH index build** (18-bit cross-polytope, L=10)
21. **k-anonymity label guard** (generalization via Theme/Realm + randomized response)
22. **Discovery settings UI** + opt-in flow
23. **Discovery feed**: candidate retrieval → re-ranking → display (3 modes)
24. **Discovery API**: feed, settings, dismiss, reindex

### Phase 5: Deep Matching & Shared Spaces
25. **TenSEAL CKKS integration** for bilateral cosine (~100 lines)
26. **Deep match opt-in flow** (mutual consent, columns on connections table)
27. **Tree-Wasserstein integration** for hierarchical overlap
28. **SPARSE mask training** for sensitive territories (~150 lines PyTorch)
29. **Migration 108**: shared_spaces table
30. **Shared space API + UI**: side-by-side view, conversation starters

---

## Data Safety Invariant (All Phases)

| Data | Crosses user boundaries? |
|------|--------------------------|
| Raw embeddings (256D) | **NEVER** |
| Individual atom vectors | **NEVER** |
| Unnoised centroids | **NEVER** |
| Message content | **NEVER** |
| Contact names/details | **NEVER** |
| Chronicles, entities, patterns | **NEVER** |
| Any encrypted field | **NEVER** |
| DP-noised centroids (ε=1-5) | Server only (similarity scores exposed, not vectors) |
| LSH hashes | Server only (bucket membership for retrieval) |
| CKKS-encrypted centroids | Ephemeral (computed, never stored) |
| Territory labels + essences | Yes, per visibility settings |
| Cognitive fingerprint stats | Yes, always public |
| Overlap scores + shape | Yes, mutual connections only |
| Territory essences in shared spaces | Yes, mutual opt-in only |
