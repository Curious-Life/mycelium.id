# Session Handoff — Native Agent Harness: chat memory + channel writes (2026-06-19)

**START HERE if resuming.** This is the recoverable state of the harness review → build → red-team →
hardening arc. Branch `feat/native-chat-history-agent-identity`, **PR #326**
(https://github.com/Curious-Life/mycelium.id/pull/326). Worktree:
`/Users/altus/Documents/GitHub/mycelium-worktrees/harness-chat-history`.

Living design doc (the authoritative artifact): `docs/HARNESS-REVIEW-AND-DESIGN-SPRINT-2026-06-19.md`
(§4.5 = agent identity model, §5.5 = build plan, §10 = red-team audit + remediation status).

---

## 1. TL;DR

The user reported the agent "doesn't function well." A review + 4 external-reference studies
(openclaw/opencode/hermes) + 4 red teamers found the root causes and we fixed them:

- **W1 — chat was stateless** → threaded per-conversation history + compaction. DONE + gated + pushed.
- **W2 — agent registry** → PIVOTED to nothing: chat already writes by default (`defaultPolicy()` grants
  all domains), so the registry had no consumer. Folded into W3.
- **W3 — channel agent was read-only** (the user's actual complaint: their Telegram bot could only
  `getContext`/`searchMindscape`/`reply`) → owner 1:1 DM can now write the vault; others stay read-only.
- **Native engine is now the channel default** (was the Claude Agent SDK), with honest health.
- **Red team found a CRITICAL + HIGHs** → 6/7 fixed + gated; owner-writes ship **OFF by default**.

**State:** 9 commits, all 17 `verify:harness*` + `verify:chat` + `verify:write-recoverability` GO
locally, PR #326 open. **RT2-H1 (overwrite recoverability) is now BUILT (`d2665f6`) — all 7 red-team
findings fixed.** The only remaining gate before enabling owner-writes is operator: a live owner-DM
smoke + flip `MYCELIUM_CHANNEL_OWNER_WRITE=1`.

---

## 2. Commits (oldest → newest)

| Hash | What |
|---|---|
| `f5b4a69` | feat(chat): W1 — thread conversation history into in-app chat (Path B, behavior-preserving) |
| `59f10a5` | test(chat): C10 gate — multi-turn memory + thread scoping |
| `10c249a` | docs: pivot — W2 premise void (chat already writes by default) |
| `bb3b0bb` | feat(channel): W3 — owner 1:1 DM gets full write grant; others read-only |
| `def08f7` | fix(security): red-team — gate owner-writes OFF, trim set, namespace conversationId |
| `f6bd01e` | fix(security): RT1 CRITICAL — daemon↔server per-boot token gates owner-write |
| `095d0c8` | feat(channel): native engine = default + honest health (B1) + untrusted history (RT3-H2) |
| `b59ad49` | feat(security): RT2-H2 — channel write-audit (hash-only) |
| `d2665f6` | feat(security): RT2-H1 — overwrite recoverability (encrypted version capture + restore) |

(+ handoff commits.)

---

## 3. Core context — how the harness works (as-built)

```
ONE engine: streamTurn (src/agent/harness.js) — single model exchange + inner tool loop (≤8 iters)
  wrapped by: loop.run (src/agent/loop.js) — watchdog (TTFB/IDLE) + retry + provider-fallback. NOT a
              multi-turn/steering loop; agency = streamTurn's inner loop.
  assembled by: runAgentTurn (src/agent/run-turn.js) — provider resolve + getContext + OPTIONAL
              history+compaction + model-budget + autonomyTools grant + in-proc call wrapper.

THREE surfaces:
  • chat      POST /chat/stream → portal-chat.js → loop.run DIRECTLY (W1 added history hydration here,
              Path B — does NOT route through runAgentTurn, which would drop SSE/search/local-heuristics)
  • scheduler setInterval tick → runScheduledTurn → runAgentTurn
  • channel   daemon → POST /internal/agent/channel-turn (loopback) → runAgentTurn   [now NATIVE default]

Grant model (capability follows IDENTITY, not surface):
  • chat        = toolsForDomains(tools, AI-Access policy)  — defaultPolicy() grants ALL domains
  • autonomous  = autonomyTools(tools, enabledNames): SAFE read-set always ∪ gated/write names opt-in
  • channel     = src/agent/resolve-grant.js decides: owner 1:1 DM (+flag +token) → OWNER_CHANNEL_TOOLS;
                  everyone else / groups → ['reply']. Single source = `ownerTrusted`.
State: scheduled_tasks · harness_runs · conversation_summaries · channel_write_audit (migration 0033).
```

**Key files touched this session:**
- `src/portal-chat.js` — W1 history hydration; `conversationId` namespaced `chat:<id>` (RT3).
- `portal-app/src/lib/stores/chat.ts` + `components/chat/ChatFloat.svelte` — per-thread conversationId.
- `src/agent/resolve-grant.js` — NEW. The owner-vs-scoped capability seam (`resolveAgentGrant` analog).
- `src/agent/autonomy-tools.js` — `WRITE_AUTONOMOUS_TOOLS`; autonomyTools grants write tools when named.
- `src/agent/channel-turn.js` — owner-trust branch (token-gated), model-status endpoint, history framing.
- `src/agent/run-turn.js` — `historyUntrusted` + `onWrite` audit in the call wrapper.
- `src/agent/history.js` — untrusted banner in renderBlock.
- `src/channels/supervisor.js` + `src/server-rest.js` — `CHANNEL_TURN_TOKEN` generation + plumbing.
- `packages/channel-daemon/agent/{runtime.js,backends/native.js}` + `index.js` — native default + probeHealth.
- `src/db/harness.js` + `migrations/0033_channel_write_audit.sql` — write-audit DAL + table.

---

## 4. Key decisions & pivots (don't re-litigate)

- **W1 = Path B, not runAgentTurn.** Routing chat through runAgentTurn drops SSE streaming, the
  searchMindscape preamble, local-model heuristics, policy gating, and error mapping. History is
  hydrated INLINE in portal-chat.js mirroring run-turn.js. Summarizer is signal-aware (no SSE stall).
- **W2 dissolved.** `defaultPolicy()` (`tool-domains.js:72-74`) grants all domains → chat already writes.
  Forcing the primary past the user's AI-Access policy would be wrong. The agents registry's real
  consumer is scoped/named agents (future Phase 2), not chat.
- **Owner-writes OFF by default** behind `MYCELIUM_CHANNEL_OWNER_WRITE=1`. Even with it on, owner-write
  needs: senderRole==='owner' (daemon-computed from Telegram fromId) AND !group AND a valid per-boot
  daemon token. Quadruple-gated, fail-closed.
- **Native default flip** done WITH B1 (honest health) — a missing server model reports capture-only,
  never a silent green. SDK/Ollama remain explicit overrides + rollback.
- **C14 caught a real bug** in my own daemon-auth fix (grant re-derived without the token) → grant now
  derives from the single token-gated `ownerTrusted`. The gates earned their keep; keep that discipline.

---

## 5. Security posture (what's safe by default)

- A forged loopback POST with `senderRole:'owner'` → only read+reply (no token → no write). [C14]
- Destructive mind-model tools (`editMindFile`/`writeMindFileWhole`/`updateInternalModel`) + `forget`/
  `publish` are EXCLUDED from the channel write set. [C10]
- Every owner-write is audited hash-only in `channel_write_audit` (tool + conversation + sha256-prefix,
  NO plaintext). [S9]
- Chat can never read a channel conversation (the `chat:` namespace). [verify:chat C11]
- Channel history is framed untrusted in the preamble. [C7]
- Owner DM carries an injection-defense preamble (forwarded content = data). [C10]

---

## 6. RT2-H1 overwrite recoverability — ✅ BUILT (`d2665f6`)

`remember` (`facts.upsert`) and `saveDocument` (`documents.upsert`) overwrote in place with no version
row → a poisoned write was unrecoverable. **Now closed.** Design + evidence:
`docs/DESIGN-RT2-H1-overwrite-recoverability-2026-06-19.md`.

- **migration `0033`** — extend `document_versions` (encrypted prior snapshot
  title/summary/content + user_id/path/trigger) + new `fact_versions` table.
- **`ENCRYPTED_FIELDS`** (crypto-local.js) — `document_versions[title,summary,content]` +
  `fact_versions[value]`; snapshot encrypts at rest under the uniform `'personal'` scope.
- **Capture in the DAL** (`src/db/documents.js`, `src/db/facts.js`) — fires only on a
  content-CHANGING overwrite of an existing, non-forgotten row; create + identical re-write capture
  nothing; bulk importers bypass the DAL (raw inserts) so import is unaffected. Non-fatal + isolated.
- **Recovery** — `listVersions` + `restoreVersion` on both namespaces (restore is itself versioned).
- **Gate** `verify:write-recoverability` (12 assertions GO; encrypted-at-rest proven via rawRead).
  Neighbors re-run GREEN (facts, loose-document, run-import, import, portal-data, forget).

Remaining before `MYCELIUM_CHANNEL_OWNER_WRITE=1`: **operator-only** — a live owner-DM smoke
(write persists + survives reopen; injection/group → zero `channel_write_audit` rows). No code left.

**Follow-up (not blocking):** a portal/MCP surface to browse+restore version history (the DAL methods
ship; the UI does not), and per-surface `trigger` labeling (today defaults `'overwrite'`).

---

## 7. The plan to finish (phases)

**Phase 0 — ship what's built** (gating: human review + your machine):
- PR #326 → human security review (boundary-loosening) → merge. **REBASE on main first** (branch is
  behind; local diffstat showed unrelated files = main advanced).
- Rebuild the app → W1 chat memory + native engine go live (bundled JS, not live until rebuilt).
- Live Telegram native-parity smoke (see PR checklist): DM text/image/voice+TTS, >4096 chunk,
  group addressed-only, no-model → capture-only.

**Phase 1 — finish owner-writes** (✅ code done; operator smoke remains):
- ✅ RT2-H1 recoverability built (§6, `d2665f6`).
- Operator: enable `MYCELIUM_CHANNEL_OWNER_WRITE=1` + owner-DM smoke: write persists + survives reopen;
  injection/group → zero rows in `channel_write_audit`; an overwrite is recoverable via `restoreVersion`.

**Phase 2 — scoped/named agents** (the "create new agents, scoped access" vision, §4.5 deferred):
- `agents` registry table + `db.agents` DAL + generalize `resolve-grant.js` to named agents
  (capability_scope = domains + flags). Owner-vs-other is binary TODAY; named agents are net-new.
- Creation/binding surface (portal); channel-bound personas; outward-facing/federated agents +
  the content-scope axis (reuse publish/share predicate `documents.js:104-118`). ~2-4 days.

**Phase 3 — perceived-quality** (optional, from the review §5 P1/P2): prompt caching / three-tier
prompt, execution-bias + planning-only breaker, importance-aware tool truncation, compaction-as-handoff
schema, memory durability taxonomy (also fixes the 35KB MEMORY.md), deferred tool catalog.

---

## 8. Gotchas (will bite a fresh session)

- **Worktree isolation.** Work in `mycelium-worktrees/harness-chat-history` (or a fresh worktree off
  origin/main). The main tree `mycelium.id` is contested by concurrent sessions.
- **node_modules** is NOT in the worktree — symlink it: `ln -s <main>/node_modules <wt>/node_modules`
  and same for `portal-app/node_modules` (needed for `npm run verify:*` + svelte-check).
- **Migration numbering:** next free was 0031 (used here). origin/main goes to 0030. Re-check at rebase.
- **Gates:** `npm run verify:harness-channel` (C10-C14), `verify:harness-state` (S9), `verify:chat`
  (C10/C11), `verify:harness-channel-native` (N7) are the new-assertion homes. Full family loop:
  `for g in $(node -e "...startsWith('verify:harness')...") verify:chat; do npm run $g; done`.
- **CI = full `npm run verify`** (verify.yml): npm ci + python (measurement gates pass in CI, FAIL in a
  bare worktree — that's expected, run the targeted gates locally) + portal-app build + svelte-check.
- **git commit messages with arrows/parens trip zsh** — use `git commit -F -` with a heredoc, or `-F file`.
- **`timeout` is not on macOS** — don't wrap npm in `timeout`.
- **Don't flip `MYCELIUM_CHANNEL_OWNER_WRITE=1` until RT2-H1 lands** (recoverability) + a live smoke.

---

## 9. Pickup protocol

1. `cd` the worktree (or recreate it off origin/main); symlink node_modules.
2. Read `docs/HARNESS-REVIEW-AND-DESIGN-SPRINT-2026-06-19.md` §10 (red-team status) + §6 decisions.
3. Check PR #326 CI + mergeable state; rebase on main if behind.
4. If continuing the build: **RT2-H1 (§6)** is the next unit — sweep-first, own gate, then it's safe to
   enable owner-writes. Then Phase 2 (scoped agents) is the larger product follow-on.
5. Operator-only blockers (cannot be cleared by the agent): human merge approval, app rebuild, live
   Telegram/Mac smokes.
