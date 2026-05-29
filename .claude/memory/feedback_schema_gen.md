---
name: Regenerate schema after migrations
description: After adding any D1 migration, run generate-schema.sh to keep the fresh-install schema current
type: feedback
---

After adding or modifying any database migration, regenerate the complete schema file.

**Why:** `migrations/d1-schema-generated.sql` is the single-file schema for fresh installs (instead of running 100+ individual migrations). It's dumped from production D1 and must stay in sync.

**How to apply:** After deploying a new migration to production, run:
```bash
bash scripts/generate-schema.sh
```
This dumps the live schema from `mycelium-v2` D1 → `migrations/d1-schema-generated.sql`, then validates it against local SQLite.
