# Mycelium — Claude Code Notes

Mycelium is a **self-hosted, single-user MCP cognitive vault**: a local server + web
portal that ingests your conversations, notes, and reflections, encrypts them at rest
on your own machine, embeds them semantically, and builds a living topology (the
"mindscape") of your thinking — exposed to any AI model through the Model Context
Protocol.

## Start here

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the as-built system. Read this first.
- **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** — narrative walkthrough.
- **[docs/SETUP.md](docs/SETUP.md)** — stand it up locally (Node 22, keys, verify, Claude Desktop).
- **[docs/guide/](docs/guide/)** — the Handbook (concepts) + Reference (MCP tools, connect, ingest, gateway, security model).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the verify gate, branch/PR conventions.
- The locked technical decisions (D1–D7) are summarized in the [README](README.md).

## ⚠️ Security first — non-negotiable

Mycelium stores the most intimate data a person produces: thoughts, reflections,
relationships, finances, meaning-making. Every line is written as if an attacker is
reading it. This is not a web app — it is a cognitive vault.

1. **Zero plaintext leakage** — encrypted data must NEVER appear in logs, error messages, HTTP responses, or unencrypted storage. If in doubt, don't log it.
2. **Defense in depth** — every security boundary has at least two independent enforcement layers.
3. **Fail closed** — missing auth → reject. Missing encryption key → refuse to write. Never fall back to a permissive default.
4. **Key discipline** — the recovery key (`USER_MASTER`) is the one secret; `SYSTEM_KEY` and the at-rest SQLCipher key are **HKDF-derived** from it. Keys live in the OS keychain / session memory — never in HTTP headers, env dumps, the DB, or logs. A lost key is unrecoverable by design.
5. **No security shortcuts** — never `--no-verify`, `--force`, or skip hooks to bypass a security check.
6. **Embedding vectors are sensitive** — Nomic v1.5 embeddings are semantic fingerprints of plaintext. Treat them with the same paranoia as plaintext; embedding-inversion attacks are real.
7. **Explicit-send only** — agent free-form output is never auto-delivered. Every agent → channel path goes through one of the egress chokepoints.
8. **Audit + validate** — every cross-boundary call is traceable; every operation verifies its own success. Never log PII; never "log a warning and continue."
9. **Flag vulnerabilities proactively** — if you notice a potential vulnerability while working on something else, stop and flag it. See [SECURITY.md](SECURITY.md).

## Working conventions

The **verification suite is the gate**: `npm run verify` (full) / `npm run verify:core`
(fast Tier-1 sanity). A change isn't done until its gate prints `VERDICT: GO`. Never
merge on a partial or flaky run. Docs land in the **same commit** as the code that
changed what the system *is*.

Skills in `.claude/skills/` encode the disciplines — invoke the relevant one **before**
the work, not after:

- **sweep-first-design** — before any structural change: inventory the load-bearing assumptions, verify each against live code with file:line citations, and pivot when the code contradicts the plan.
- **pre-deletion-caller-audit** — before deleting/renaming code, schema, config, an endpoint, or a tool: inventory every caller, prove migration with evidence, define falsifiable criteria first.
- **deploy-and-verify** — run the `verify:*` gate(s) for the changed surface (and the full suite before "done"), then smoke the real process the user runs.
- **living-docs** — after any change to what the system *is*, keep `docs/ARCHITECTURE.md` + the guide current, as-built, with file-path evidence.
- **handoff-discipline** — at the end of a session that produced commits or decisions, write a structured handoff so the next session picks up cleanly.
- **auto-merge-on-green** — fail-closed merge gate: merge only when every check **and** review passes and the PR is mergeable; security-sensitive diffs always need a human approval.

## Repo layout

```
src/                  the V1 server (adapter · crypto · db · ingest · search · tools · http)
portal-app/           SvelteKit web UI (built + served at :8787)
pipeline/             Python ML — embed-service, clustering, information harmonics
src-tauri/            Tauri desktop app shell (macOS)
packages/channel-daemon/   Telegram / Discord bridge (supervised by src/channels)
tools/memory-bridge/  harness adapters (Claude Code, opencode, openclaw, hermes)
migrations/           SQL schema + migrations
scripts/              verify-*.mjs gates + build / db tooling
tests/ · docs/ · assets/
```

## Working style

Keep going until the task is actually complete; don't hand back early. Optimize for the
**best decision at each step** — stress-test load-bearing choices against live code
before building on them. A spike or adversarial read that surfaces a flaw early is a
success, not a detour.
