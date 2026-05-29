# Mycelium Memory — committed subset

This is the in-repo, PII-scrubbed baseline of project memory. See [README.md](README.md) for how to seed your machine-local auto-memory from this. The full live machine-local index lives at `~/.claude/projects/-Users-<you>-Documents-GitHub-mycelium/memory/MEMORY.md` and is much larger; this file indexes only what's safe to publish.

## Engineering principles (committed)

- [Security non-negotiables](feedback_security.md) — Swiss Vault standard, zero plaintext leakage, flag vulnerabilities proactively
- [Sweep-first design protocol](feedback_sweep_first_design.md) — three sweep cycles min, file:line citations, pivot when code contradicts plan
- [Handoff discipline](feedback_handoff_discipline.md) — write the artifact that survives compaction; structured TL;DR + verification + pickup protocol
- [Pre-deletion caller audit](feedback_pre_deletion_caller_audit.md) — inventory every caller, prove migration, falsifiable criteria
- [No deprecated fallbacks](feedback_no_deprecated_fallbacks.md) — when a path is deprecated, rip it cleanly
- [Fail-closed ops](feedback_l1_deploy_unlock.md) — L1 lockdown + NOPASSWD helper verbs; never `sudo bash` interactively
- [Secrets bootstrap pattern](feedback_secrets_bootstrap.md) — Worker Secrets API → tmpfs, 5-min refresh, no in-repo secrets
- [Per-agent internal secret](feedback_per_agent_internal_secret.md) — loopback-only HTTP between agent-server and MCP children with shared secret
- [Schema regen after migrations](feedback_schema_gen.md) — run `bash scripts/generate-schema.sh` after every D1 migration
- [Universal naming](feedback_universal_naming.md) — functional names in shared abstractions, no agent names in cross-cutting modules
- [CF DoH POP divergence](feedback_cf_doh_pop_divergence.md) — Cloudflare DoH POP routing surprises that bit deploys

## Technical project context (committed)

- [Mind-search pipeline dependencies](project_mind_search_pipeline_dependencies.md) — boot order, RAM index lifecycle, scan-matcher tier
- [Mind-search wave status](project_mind_search_wave_status.md) — phase rollout, shadow-sample telemetry pattern
- [Identity channels](project_identity_channels.md) — per-channel session UUIDs, scope-aware delivery
- [Local tagging](project_local_tagging.md) — Llama tagging service, lifecycle, integration boundaries
- [Spaces — cross-tenant](project_spaces_cross_tenant.md) — shared-space access model, scope crossings
- [Spaces — scanner wave 2](project_spaces_scanner_wave2.md) — scanner module pattern, multi-source addressing
- [Social protocol](project_social_protocol.md) — federation Phase 0 surface (WebFinger, DID, publish path)
- [Fisher follow-ups](project_fisher_followups_2026-05-07.md) — era-format fix, doc cleanups
- [Clustering migration](clustering_migration.md) — UMAP→FAISS+Leiden pivot rationale
- [Enrichment backfill](enrichment_backfill.md) — per-message tagging backfill strategy

## Cross-cutting

- [Social sharing privacy](social_sharing_privacy.md) — what's safe to expose publicly through publish/share-link paths

## Not committed (lives only machine-local)

User profile (location, philosophy), customer state (per-handle ledgers, deletion follow-ups, signup reliability findings), pricing math, account-deletion incident notes, in-progress handoffs that reference specific people, deploy ledgers, SSH cert / Hetzner / financial details. Add these manually to `~/.claude/projects/.../memory/` on each machine where you need them.
