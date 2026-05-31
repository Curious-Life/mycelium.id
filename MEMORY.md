# MEMORY — cross-session index

Quick-reference pointers for Claude Code sessions in this repo. Keep entries terse;
detail lives in the linked docs. Newest-relevant first.

## In Progress

- **V1 build — Wave 1 + Wave 2 DONE.** All 7 subsystems integrated; MCP server serves **29
  tools** over stdio + HTTP/OAuth through the encrypting db (mind-files, mind-search, metrics,
  topology, REST, OAuth, embed-service). Only `reply`/`services` deferred (Phase-6). D1–D7
  locked. Pick up: [`docs/V1-BUILD-HANDOFF-2026-05-30.md`](docs/V1-BUILD-HANDOFF-2026-05-30.md)
  (read the **2026-05-31** section). Branch `claude/repo-overview-mC69M` @ `9dda2a4`.
  Proof: `npm install --legacy-peer-deps && npm run verify` → **9× GO, EXIT 0**. Open: 2 Tier-2
  SKIPs need a networked host (embed ONNX model, topology clustering wheels); D7 enrichment + deploy next.

## Key docs

- Spec: [`docs/V1-BUILD-SPEC.md`](docs/V1-BUILD-SPEC.md) (v1.2, verification table, D1–D7)
- Plan: [`docs/V1-IMPLEMENTATION-PLAN.md`](docs/V1-IMPLEMENTATION-PLAN.md) (6 phases; Steps 1–4 done)
- Verified results: [`docs/FOUNDATION-WAVE1-RESULT.md`](docs/FOUNDATION-WAVE1-RESULT.md)
- Spikes (verified GO): `spike/oauth/RESULT.md` (R1 better-auth), `spike/crypto/RESULT.md` (D3/D4/D6)

## Standing disciplines (see CLAUDE.md)

- Verify every step with running code before building on it; never claim green without
  watching the ledger reach `VERDICT … EXIT=0`.
- Run tasks to completion; fold sweep findings in rather than pausing.
