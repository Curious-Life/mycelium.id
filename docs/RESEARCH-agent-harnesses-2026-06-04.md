# Research — Agentic Coding/Assistant Harnesses (the Claude Code field, mid-2026)

**Date:** 2026-06-04
**Status:** Research report (deep-research: 5 search angles + adversarial verification of the shakiest claims).
**Why:** Informs the bring-your-own-agent story in [`DESIGN-ai-interface-layer-2026-06-04.md`](DESIGN-ai-interface-layer-2026-06-04.md) (Part 5). The thesis there — *a harness just points at Mycelium's MCP URL* — is validated below, and the research independently confirms two of that design's calls (the **opt-in static bearer** for North; the **OpenAI-compatible gateway** as the deferred South extension).
**Confidence:** Identity/structure claims well-corroborated across primary sources. **Flagged as approximate:** GitHub star counts (point-in-time, the 2026 agent ecosystem has implausibly high counts), model version numbers (GPT-5.5 / Opus 4.7-4.8), and a few OAuth-config specifics where vendor docs 403'd on fetch.

---

## TL;DR

1. **The four you named are two different species** — this is the load-bearing insight:
   - **opencode** (SST) is the one true **Claude Code coding-harness mirror**.
   - **openclaw** and **hermes-agent** are **personal-assistant harnesses** (memory + skills + 20-ish chat channels) — i.e. they live in **Mycelium's own product category**, not Claude Code's. Study them as *prior art / competitors*, not just integration targets.
   - **odysseus** (PewDiePie) is a self-hosted **web workspace** that *wraps* an opencode-style agent — a GUI shell, not a CLI peer.
2. **"hermes" disambiguated:** `NousResearch/hermes-agent` — a self-hosted, self-improving personal agent (MIT, MCP-native, model-agnostic), launched ~Feb 2026. **Not** the Hermes *LLM* family.
3. **"Improving on Claude Code" in 2026 = flexibility, not raw skill.** Open harnesses match/beat Claude Code on model-agnostic routing, LSP feedback, parallel multi-agent, cost, local/offline, and session sharing. Where Claude Code still leads (reliability, long-horizon polish, `/rewind`) is **model-bound, not harness-bound** — a ~100-line agent loop (`mini-SWE-agent`) scores >74%; the scaffold adds only ~5–15 points.
4. **The ToS shift is the real tailwind for "bring your own agent."** Anthropic blocked subscription-OAuth tokens in third-party tools (server-side blocks ~Jan 9 2026; opencode stripped Pro/Max support under legal request). This pushes everyone toward BYO-key/BYO-model harnesses + their own context — exactly Mycelium's thesis.
5. **Best bring-your-own-agent fits for a personal MCP vault (ranked):** **① opencode · ② OpenAI Codex CLI · ③ Goose** — all OSS/local, all do remote MCP with a clean **bearer** path, all let you repoint the model at a local/OpenAI-compatible gateway. Honorable mentions: Cline / Continue / Kilo (strong, but VS-Code-bound), OpenHands (most autonomous, self-hostable). **Weakest fits:** Cursor / Windsurf (closed, cloud-tied) and **Aider** (great BYO-model but **not an MCP client** — can't consume the vault).

---

## 1. The four you named — identified & disambiguated

| Tool | Canonical repo | Maker | Species | License | Stars (≈, point-in-time) |
|---|---|---|---|---|---|
| **opencode** | `sst/opencode` (opencode.ai) | **SST** (Dax/Adam) | Terminal **coding agent** — the Claude Code mirror | MIT | ~160k |
| **odysseus** | `pewdiepie-archdaemon/odysseus` | **PewDiePie** (launched ~2026-05-31) | Self-hosted **web workspace** wrapping an opencode agent | MIT | ~45k |
| **openclaw** ⚠️ | `openclaw/openclaw` (openclaw.ai) | **Peter Steinberger** (ex-PSPDFKit) | **Omni-channel personal assistant** | MIT | ~347k (reported most-starred repo on GitHub, Apr 2026) |
| **hermes-agent** | `NousResearch/hermes-agent` | **Nous Research** (launched ~2026-02-25) | **Self-improving personal agent** | MIT | ~140k |

**Disambiguation notes:**
- **opencode lineage is confusing on purpose.** The *archived* `opencode-ai/opencode` (Kujtim Hoxha) was acquired by **Charm** and rebranded **Crush** (`charmbracelet/crush`); the original brand continued under **SST** (`sst/opencode`). The user's "opencode" = the **SST** one (live, MIT).
- **⚠️ openclaw scam ecosystem (explicit warning):** heavily impersonated — fake Windows installers dropping infostealers (typosquat repos), fake `$CLAW`/`$CLAWD` tokens + wallet-drainers, hijacked handles. Steinberger's rule: *"I will never do a coin… OpenClaw never asks you to connect a crypto wallet."* **Trust only `openclaw/openclaw` + `openclaw.ai`.** (Malwarebytes, CoinDesk, CSO.)
- **hermes = the agent, not the model.** `NousResearch/hermes-agent` ("the agent that grows with you"): self-improving skill loop, persistent SQLite-FTS memory, TUI+CLI, 16+ channel gateway, 40+ tools, 6 terminal backends (local/Docker/SSH/Daytona/Singularity/Modal), MCP out-of-the-box, model-agnostic. **Verified real** (GitHub + official docs + multiple writeups). Distinct from Nous's Hermes LLMs.

---

## 2. Full comparison matrix — the Claude Code coding lineage

OSS = open license · SA = source-available · Prop = proprietary. "Remote MCP" = Streamable HTTP (beyond stdio). "Base-URL" = can repoint the model at an OpenAI-compatible/local gateway.

| Harness | Maker / License | Interface | Autonomy | BYO-model / local | Remote MCP + auth | Base-URL | vs Claude Code |
|---|---|---|---|---|---|---|---|
| **opencode** | SST / **MIT** | TUI + desktop + IDE | build/plan agents, subagents, `/share` | 75+ models; **Ollama/LM Studio** | **Yes** — auto-OAuth (DCR) + bearer `headers` (`oauth:false`) | **Yes** (AI-SDK custom provider) | Near feature-parity; **improves**: model-agnostic, LSP, session-share |
| **OpenAI Codex CLI** | OpenAI / **Apache-2.0** | Terminal | to-do list, multi-agent tools | OpenAI-centric; OSS via OpenAI-compat | **Yes** — `oauth` + `bearer_token_env_var` + `codex mcp login` | **Yes** (`openai_base_url`) | Mirrors loop; strong remote-MCP; default model OpenAI |
| **Goose** | Block → Linux Foundation / **Apache-2.0** | CLI + desktop | recipes (YAML), subagent-ish; **also an MCP *server*** | 15+ providers; **Ollama, Docker Model Runner** | **Yes** — OAuth 2.0/device + bearer headers | **Yes** (OpenAI-compat) | Agent-first, vendor-neutral; **improves**: recipes, cost/offline |
| **Cline** | Cline Bot / **Apache-2.0** | VS Code/JetBrains + CLI 2.0 | **Plan/Act**, checkpoints/undo, Kanban parallel | 30+ providers; **Ollama/LM Studio** | **Yes** — OAuth 2.1/PKCE + bearer | **Yes** (OpenAI-compat) | **Improves**: GUI checkpoints, MCP marketplace |
| **Continue** | Continue / **Apache-2.0** | VS Code/JetBrains | Agent mode (lighter) | **Ollama, llama.cpp, LM Studio, vLLM** | **Yes** — `streamable-http` + OAuth 2.1 | **Yes** (`apiBase`) | Most hackable/local; lighter autonomy |
| **Kilo Code** | Kilo Org / **MIT** | VS Code/JetBrains/CLI/Slack | Plan/Act + multi-mode + marketplace | 500+ models; local inherited | **Yes** — SHTTP→SSE + OAuth 2.0 + bearer | **Yes** | Consolidates Cline+Roo; CLI on OpenCode server |
| **OpenHands** (ex-OpenDevin) | OpenHands / **MIT** core | CLI + web GUI + SDK | **Most autonomous**: sandboxed Docker + **browser**, planning beta | any LLM (LiteLLM → Ollama/vLLM) | **Yes** — `--transport http` + bearer header | **Yes** (`LLM_BASE_URL`) | **Improves**: full sandbox, browser, K8s self-host |
| **Aider** | Paul Gauthier / **Apache-2.0** | Terminal pair-prog | single loop (no subagents) | 100+ models; **Ollama, LM Studio** | **❌ not an MCP client** (only 3rd-party "aider-as-server") | Yes (`OPENAI_API_BASE`) | Mirrors edit loop; **can't consume an MCP vault** |
| **Crush** | Charm / **SA (FSL-1.1-MIT)** | TUI | sessions (no plan-mode) | 7+ providers; **Ollama/LM Studio** | **Yes** — OAuth 2.0/PKCE/DCR + bearer | **Yes** (`openai-compat`) | Capable; **license caveat** (delayed-OSS) for an AGPL project |
| **Qwen Code** | Alibaba / **Apache-2.0** | Terminal (Gemini-CLI fork) | inherits subagents | OpenAI/Anthropic/Gemini + open weights | **Yes** — OAuth 2.0 + bearer | **Yes** (OpenAI-compat) | Now the surviving open fork of the Gemini-CLI codebase |
| **Gemini CLI** | Google / Apache-2.0 — **being retired 2026-06-18** | Terminal | subagents (`.md`) | **Gemini-only** | Yes (`httpUrl`) | Partial | Migrating to **closed Antigravity CLI** — avoid for new work |
| **Roo Code** | Roo / Apache-2.0 — **archived 2026-05-15** | VS Code | multi-mode (pioneered) | broad; local | Yes; native OAuth was in-progress | Yes | Legacy → use **Cline/Kilo** |

**Commercial / closed (for completeness):** **Cursor** (Anysphere) — agent + background cloud agents + `cursor-agent` CLI, native MCP, but **custom base-URL crippled for the agent** (stays on Cursor's backend). **Windsurf** (Cognition) — Cascade, proprietary SWE-1.5 model, cloud-mediated. **Augment** — enterprise context-engine (~200K-token), spec-driven multi-agent "Intent". **Trae** (ByteDance) — SOLO mode, free, VS-Code-based (its separate `trae-agent` CLI *is* Apache-2.0). **Zed** — OSS editor (Rust) with parallel agents + the open **Agent Client Protocol (ACP)** that hosts Claude/Codex/Gemini/opencode *inside* Zed; BYO via those external agents.

**Personal-assistant species (Mycelium's neighbors, not coding mirrors):** **openclaw** (remote MCP via `transport:"streamable-http"`, OpenAI/Anthropic-compatible `models.providers`), **hermes-agent** (MCP-native, model-agnostic, self-improving), **odysseus** (a *server/workspace* that exposes itself over MCP; built on opencode; vLLM/llama.cpp/Ollama/OpenAI).

---

## 3. How they compare to Claude Code

**What Claude Code defines (the category):** terminal-native autonomous loop (read/edit/bash), **subagents** (isolated contexts), **plan mode**, **hooks**, **MCP** (Anthropic-authored), **slash commands**, **CLAUDE.md** memory, **checkpoints/`/rewind`**. ~4% of public GitHub commits early 2026 — the harness others copy.

**Where the open field MIRRORS it:** all of opencode/Goose/Cline/Codex/Continue/Kilo/OpenHands/Crush/Qwen do agentic edit/bash loops + MCP + plan-style modes + memory files.

**Where they genuinely IMPROVE on it:**
- **Model-agnostic routing** (the headline) — opencode 75+ models incl. local; Goose/Cline/Continue provider-neutral. Claude Code is Anthropic-only.
- **LSP integration** — opencode auto-spawns language servers (real type/def feedback); Claude Code has no native equivalent.
- **Parallel multi-agent / orchestration** — Goose YAML recipes (shareable, CI-runnable); opencode/Zed parallel agents; Amp's "Oracle" advisor.
- **Cost / local-offline** — free on local models; air-gappable.
- **Session sharing** — opencode `/share` public links.
- **GUI/IDE-native + checkpoints** — Cline GUI checkpoints/undo, marketplaces.
- **Safety** — Plandex quarantines changes in a cumulative-diff sandbox until approved.

**Where Claude Code still LEADS:** out-of-box polish, ecosystem depth, `/rewind` (prompt-level restore of code **and** conversation > opencode's one-step `/undo`), and raw long-horizon reliability — **but the reliability edge is the model (Claude Opus/Sonnet), not the scaffold.** `mini-SWE-agent` (~100-line ReAct loop) scores >74%; frameworks add only ~5–15 points.

**Benchmarks (read skeptically):** OpenAI **stopped reporting SWE-bench Verified on 2026-02-23** — every frontier model could reproduce gold patches from the task ID (contamination). Credible evals now: **Terminal-Bench 2.0 / SWE-bench Pro**. Reported (approximate): Terminal-Bench 2.0 — **Codex CLI + GPT-5.x ≈82% (#1)**; OpenHands cloud ≈72% SWE-bench Verified. Near-frontier combos: **Codex CLI + GPT-5.x**, **opencode/OpenHands + Claude Opus or Gemini 3**.

---

## 4. The 2026 landscape shifts that matter

- **Anthropic ToS clampdown** (the big one) — OAuth "intended exclusively" for native apps; **API key required even for the Agent SDK**; subscription credentials in third-party tools prohibited, enforceable "without prior notice." Server-side blocks ~Jan 9 2026; **opencode stripped Pro/Max support** citing "anthropic legal requests"; from **Jun 15 2026** Agent-SDK-on-subscription draws a metered credit pool. → accelerates BYO-key/BYO-model adoption.
- **Gemini CLI is being retired (2026-06-18)** → closed **Antigravity CLI**. Widely read as a bait-and-switch; **Qwen Code** is now the surviving open fork of that codebase.
- **Roo Code shut down (2026-05-15)** → redirects to **Cline / Kilo**.
- **opencode brand split** → SST keeps `opencode`; Charm's fork is **Crush** (source-available FSL license).

---

## 5. Best "bring your own agent" fits for a personal MCP vault — ranked

Decisive axis: clean **remote MCP + bearer/OAuth** to an external server **and** model **base-URL override** (so the user keeps Mycelium as memory *and* can route models locally), plus OSS + active.

1. **opencode (SST) — strongest.** Remote MCP is first-class: auto-detects 401 → OAuth with Dynamic Client Registration, *and* a plain bearer/`headers` path with `oauth:false` for the simple static-token case. Fully model-agnostic via AI-SDK custom providers (`options.baseURL` → your gateway). MIT, local, very active. The exact "BYO-model + clean remote MCP + bearer" target.
2. **OpenAI Codex CLI.** Explicit Streamable-HTTP MCP with `bearer_token_env_var` (perfect for a static vault token) + full `oauth`/`codex mcp login`; `openai_base_url` repoints the model. Apache-2.0, local. Caveat: defaults to OpenAI — set the base URL deliberately.
3. **Goose (Block).** Agent-first (not an IDE bolt-on), Apache-2.0, local. Native `streamable_http` + OAuth 2.0 + bearer headers + OpenAI-compatible providers; *also exposes itself as an MCP server*. Closest "agent-first, MCP-first, vendor-neutral" peer to opencode.

**Honorable mentions:** **Cline / Continue / Kilo** — same capability set, but VS-Code-bound. **OpenHands** — most autonomous + self-hostable (Docker/K8s), great if you want an unattended agent.

**Weakest fits:** **Cursor / Windsurf** — closed, cloud-tied; Cursor only honors a custom model base-URL in the chat panel (the *agent* stays on its backend), defeating BYO-model. **Aider** — excellent BYO-model but **not an MCP client**, so it cannot consume the vault. **Crush** — capable, but FSL source-available license is a caveat for an AGPL project. **Roo / Gemini CLI** — legacy/sunsetting.

---

## 6. Integration notes for Mycelium (the payoff)

- **The integration is one line of config:** every viable coding harness (opencode, Codex, Goose, Cline, Continue, Kilo, OpenHands, Qwen, Crush) is an MCP client → *"add Mycelium's MCP server (stdio command locally, or remote URL + token)."* They then get `getContext` / `searchMindscape` / `captureMessage` / `remember` — **the vault becomes the harness's long-term memory.** No per-harness code.
- **This validates the AI-interface design's North decisions.** The harnesses' **bearer fallback** paths (opencode `oauth:false`+headers, Codex `bearer_token_env_var`, Goose/Cline/Continue/OpenHands `Authorization` header) are exactly what the design's **opt-in static-bearer mode (S4)** serves — a copy-pasteable token is the lowest-friction connect for these tools, no OAuth dance required.
- **It also validates the deferred South gateway.** opencode, Codex (`openai_base_url`), Goose, Cline, Continue, OpenHands (`LLM_BASE_URL`) all let you repoint the model at an OpenAI-compatible base URL → if Mycelium later exposes `POST /v1/chat/completions` fronting its local-first router, these harnesses could route **both** memory (MCP) **and** model calls through Mycelium.
- **Strategic read on the personal-assistant species.** openclaw (~347k★), hermes-agent (~140k★), and odysseus already *do* memory + skills + channels — they overlap Mycelium's surface. Mycelium's differentiator is the **encrypted cognitive vault + topology/Mindscape**, not the channel layer. The defensible position: **be the sovereign memory/context layer these harnesses (and Claude/ChatGPT/Gemini) plug into**, rather than out-building openclaw's omni-channel assistant.

---

## 7. Uncertainty & verification flags

- **Star counts** are point-in-time and the 2026 agent ecosystem is anomalously high; openclaw's "~347k / most-starred" is corroborated (DigitalOcean, Wikipedia, TheNextWeb) but some openclaw sources are SEO/scam-adjacent. Treat all counts as ballpark.
- **Model versions** (GPT-5.5, Opus 4.7/4.8, Gemini 3) and exact benchmark % come from secondary aggregators — approximate.
- **OAuth-for-remote-MCP specifics** verified per-harness in angle 5, but several vendor doc pages 403'd on direct fetch (opencode `options.baseURL` nesting, openclaw OAuth depth, Gemini-CLI OpenAI-compat) — **verify exact config keys against current docs before wiring.**
- **hermes-agent** identity is verified real; its self-improving-loop claims are vendor-stated, not independently benchmarked.

---

## Sources

**Named four:** github.com/sst/opencode · opencode.ai/docs · github.com/opencode-ai/opencode · github.com/charmbracelet/crush · github.com/pewdiepie-archdaemon/odysseus · gizmodo.com (PewDiePie/Odysseus) · github.com/openclaw/openclaw · en.wikipedia.org/wiki/OpenClaw · malwarebytes.com (fake OpenClaw installers) · coindesk.com (OpenClaw phishing) · csoonline.com (fake $CLAW tokens) · github.com/nousresearch/hermes-agent · hermes-agent.nousresearch.com/docs

**Terminal tier:** github.com/block/goose + goose-docs.ai · github.com/Aider-AI/aider + aider.chat · github.com/openai/codex + developers.openai.com/codex · github.com/google-gemini/gemini-cli + developersblog (Antigravity transition) · theregister.com (Gemini CLI sunset) · github.com/QwenLM/qwen-code · ampcode.com/manual · github.com/plandex-ai/plandex · github.com/antinomyhq/forge · cline.bot/cli

**IDE tier:** github.com/cline/cline · github.com/RooCodeInc/Roo-Code + docs.roocode.com · github.com/kilo-org/kilocode · docs.continue.dev · github.com/OpenHands/OpenHands + docs.openhands.dev · zed.dev/ai + zed.dev/acp · cursor.com/docs/cli · docs.windsurf.com · augmentcode.com · github.com/bytedance/trae-agent

**Capability + benchmarks + ToS:** code.claude.com/docs/en/legal-and-compliance · code.claude.com/docs/en/checkpointing · theregister.com (third-party Claude access) · venturebeat.com (subscription cutoff; Goose-vs-Claude cost) · simonwillison.net (SWE-bench contamination) · epoch.ai/benchmarks/terminal-bench · github.com/SWE-agent/mini-swe-agent · openai.com (GPT-5.2-Codex) · thenewstack.io (Roo shutdown) · mindstudio.ai (open-source agentic coding 2026)

**MCP/fit matrix:** opencode.ai/docs/mcp-servers · developers.openai.com/codex/mcp · block.github.io/goose · docs.cline.bot/mcp · docs.continue.dev/customize/deep-dives/mcp · kilo.ai/docs/automate/mcp · docs.roocode.com/features/mcp · qwenlm.github.io/qwen-code-docs · github.com/charmbracelet/crush · docs.openhands.dev · github.com/disler/aider-mcp-server · truefoundry.com (Cursor MCP auth) · mcpbundles.com (state of MCP clients) · docs.openclaw.ai/cli/mcp
