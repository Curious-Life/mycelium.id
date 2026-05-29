# Shared Claude Code memory — committed subset

This directory holds a **curated, PII-scrubbed subset** of the per-machine auto-memory that Claude Code uses on this project. Committed so the same engineering principles, conventions, and architectural memories are available across machines and fresh sessions without manual re-discovery.

This subset was originally curated in the canonical `Curious-Life/mycelium` repo (where most of these memories were first written during 9 months of operating the dedicated-tier production system) and copied here so V1 / V2 sessions in this repo inherit the same engineering discipline.

## What's here

22 entries covering:
- **Engineering principles** (`feedback_*.md`) — sweep-first-design, fail-closed ops, security non-negotiables, no-deprecated-fallbacks, secrets bootstrap pattern, schema-regen discipline, etc.
- **Pure-technical project context** (`project_*.md`) — mind-search architecture, identity/channels semantics, spaces scanner, social protocol, Fisher follow-ups (some of these reference the canonical D1 architecture; treat them as background context that informs V1's design even though V1's implementation is different)
- **Cross-cutting context** — clustering migration, enrichment backfill, social sharing privacy

## What's NOT here (lives only in machine-local auto-memory)

- Anything mentioning specific customer handles, the operator by name, locations, IP addresses, financial figures, or named collaborators
- In-progress handoff state (commit SHAs + customer-impact narratives)
- Account-deletion ledgers, signup-reliability findings, pricing
- Anything tied to a specific incident or person

If you're tempted to lift something from machine-local memory into this dir, **run an explicit PII scrub first** (`grep -Ei 'Riga|Latvia|Björn|customer-handle-pattern|@gmail|...'`) and skip files that don't come out clean. This repo is AGPL-3.0 (eventually public) — assume anything here will be world-readable.

## How to use on a fresh machine

After cloning the repo:

```bash
# One-time seed: copy committed memory into Claude's per-machine auto-memory path
mkdir -p ~/.claude/projects/-Users-$(whoami)-Documents-GitHub-mycelium.id/memory
cp .claude/memory/*.md ~/.claude/projects/-Users-$(whoami)-Documents-GitHub-mycelium.id/memory/
```

(The actual auto-memory path depends on where you clone the repo. The slug encodes the absolute path with `-` instead of `/` — note the `.id` in the slug for this repo.)

After seeding, Claude Code will load these as context on every session in this repo. Machine-local memories you add afterward stay machine-local; if any of them are genuinely shareable + PII-clean, lift them into this dir manually.

## Why not just symlink

A symlink would mean Claude Code's auto-memory writes (new feedback / project memories) land directly in the repo's working tree. That risks:
1. Accidentally committing PII the next time someone runs `git add`.
2. Drift between the curated subset and the full live memory.

Keep them separate. The committed subset is a deliberate baseline; the live machine-local memory is the working copy.

## Updating

When a memory in here drifts (the live version evolves), copy the updated live version on top — but **re-run the PII scrub** before staging the change for commit.

```bash
# Show diff vs live before copying
diff -u .claude/memory/feedback_security.md \
  ~/.claude/projects/-Users-$(whoami)-Documents-GitHub-mycelium.id/memory/feedback_security.md
```

## Note on canonical-architecture memories

Some `project_*.md` files (e.g., `project_mind_search_pipeline_dependencies.md`, `project_identity_channels.md`) describe the canonical Cloudflare D1 + per-VPS architecture. They are kept here because the **concepts** (RAM index, scope semantics, channel context isolation) inform V1's design even though the **implementation** in this repo will be different (better-sqlite3 + D1 adapter, single-process). Read with that translation in mind.
