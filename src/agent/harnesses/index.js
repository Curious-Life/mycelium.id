// src/agent/harnesses/index.js — the harness registry.
//
// A harness is an agent ENGINE: name → factory(deps) → a loop that satisfies the
// `{ run(args) → result }` contract (src/agent/loop.js). This is the seam that makes
// the engine a first-class, flippable choice. Each engine is one additive entry.
//
//   native — today's in-process agent loop (the default; always available).
//   cli    — spawn the installed `claude` (Claude Code) as the engine (C2). Built +
//            unit-tested, but GATED OFF until the live-binary spike confirms the child
//            is confined to the vault tools (see CLI_ENGINE_ENABLED below).
import { createAgentLoop } from '../loop.js';
import { createClaudeCliLoop } from '../loop-claude-cli.js';

// SECURITY GATE (C2). The cli engine spawns `claude` confined to the vault tools with
// `--tools "mcp__mycelium__*"` (restricts the AVAILABLE toolset — the spike PROVED that
// `--allowedTools` ALONE does not confine: the child still had + RAN Bash). Confinement
// + stream-json schema were VERIFIED live by `npm run spike:claude-cli` on 2026-07-02
// (claude 2.1.198): init toolset == mcp__mycelium__* only, mcp_servers==[mycelium],
// Bash never executed. ENABLED 2026-07-02 after the spike went GREEN (S4 authoritative,
// two confinement layers: --strict-mcp-config + --tools) and a human reviewed the raw
// transcript. When true, a user who (a) has a Claude subscription connected and (b) has
// `claude` installed can select the Claude Code engine in Settings → Intelligence; it
// still fails safe to native whenever ineligible. See docs/HARNESS-CLI-DESIGN-2026-07-02.md.
export const CLI_ENGINE_ENABLED = true;

export const HARNESSES = {
  native: (deps) => createAgentLoop({ harness: deps.harness, logger: deps.logger }),
  cli: (deps) => createClaudeCliLoop({ claudeBin: deps.claudeBin, restPort: deps.restPort, model: deps.model, logger: deps.logger }),
};

// Is the Claude Code (cli) engine ready to run? Wired AND spike-confirmed. The UI reads
// this so it never offers a "Ready" engine the resolver would only fall back from — while
// CLI_ENGINE_ENABLED is false the Claude Code option shows as "coming soon", not a lie.
export function isCliEngineReady() {
  return CLI_ENGINE_ENABLED && typeof HARNESSES.cli === 'function';
}
