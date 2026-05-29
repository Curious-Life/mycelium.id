---
name: Per-agent internal secret refactor
description: Replace shared AGENT_INTERNAL_SECRET with per-agent secrets so peer agents can't cross-call /internal/* endpoints
type: feedback
originSessionId: 71b0db27-201e-42f6-b4e5-86cf389aba5e
---
Shared `AGENT_INTERNAL_SECRET` (loaded from `.env` at ecosystem.config.cjs top, same value for all PM2 agents on a VPS) means any agent process can call any other agent's `/internal/*` endpoints — `/think`, `/delegate`, `/spawn-task-async`, and the new `/internal/v1/search/mindscape`. Mya's process can hit Rex's port 5004 with the shared secret and get wealth+org search results.

**Why:** Pre-existing posture — this isn't a regression, but it's the ceiling of "loopback trust" we currently accept. As we ship more `/internal/*` surfaces (recall, future graph queries), the blast radius of one compromised agent grows.

**How to apply:** When tackling this, do all four endpoints in one coordinated change:
- Move from one `AGENT_INTERNAL_SECRET` env to per-agent `AGENT_INTERNAL_SECRET_<NAME>` (MYA, COM, ADA, REX, NOA, ROB, APOLLO, MOMS).
- Each agent-server reads its own secret; each MCP/tool only knows its own agent's secret.
- `/think`, `/delegate`, `/spawn-task-async`, `/internal/v1/search/mindscape` all enforce.
- Better long-term: switch `/internal/*` to a Unix domain socket per agent — same-UID kernel enforcement, no shared filesystem secret at all.

**Status:** deferred. Captured during the search-mindscape endpoint design (May 2026) so it doesn't get lost.
