---
name: Universal naming (no agent-specific names in shared infrastructure)
description: Don't bake individual agent names (mya, com, ada, etc.) into module filenames, URL prefixes, env var names, or other shared abstractions. Use neutral/functional names.
type: feedback
originSessionId: d31a0231-7a2f-4b43-8214-ddf8e32b6681
---
Don't use individual agent names (mya, com, ada, rex, noa, rob, apollo) in filenames, URL prefixes, env var names, class names, or other shared abstractions. Pick functional/neutral names that describe what the thing does.

**Why:** Mycelium is a multi-agent platform, not a single-agent product. When a module is named `mya-tools`, `/mya/route`, or similar, it implies single-agent scope when it's actually a shared abstraction any agent can use. Leaks bias into the codebase, confuses new contributors, and constrains future agent additions. The rename of `mya-tools` → `agent-tools` (Phase 13 PR 1) was the first pass of this cleanup.

**How to apply:**
- When extracting a module from agent-scoped code, ask: "does this actually belong to this specific agent, or is it a general-purpose capability this agent happens to use?" If the latter, use a functional name.
- Examples of acceptable → preferred renames:
  - `mya-tools.js` → `agent-tools.js` ✓ (done)
  - `/mya/route` → `/dispatch/route` or similar
  - `MYA_WORKER_URL` (when the endpoint serves all agents) → `WORKER_URL`
- Keep agent names where they ARE agent-specific (e.g. Mya's own system prompt file, `mya-discord-bot` PM2 process name for Mya's bot, agent-specific data paths).
