// verify:onboarding-structure — QA7 U9 (D-031 onboarding structure + D-016 first
// message). A STATIC source check (no portal build / no browser — matching this
// env's constraints). Proves the two operator asks are wired, and — the load-bearing
// one — that the wizard's channel step renders the SAME settings component, not a fork.
//
//   O1  wizard is a 5-step flow          STEPS=[1..5], TOTAL=5, renders <AgentStep>
//   O2  the misplaced prompt is GONE      IntelligenceStep no longer asks "how will you call it"
//   O3  step 5 asks the reworded prompt   AgentStep: "How will you call your personal agent?"
//   O4  ANTI-FORK: same settings component AgentStep imports the SAME ChannelsSection
//                                          module SettingsView imports, and renders it —
//                                          and does NOT hand-roll its own channel connect
//   O5  first-message server (D-016)       POST /onboarding/greeting composes+persists a
//                                          greeting with an HONEST-EMPTY branch
//   O6  first-message client (D-016)       OnboardingFlow calls it + auto-opens chat
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
//
// MUTATION-TESTED: 2026-07-24 — pointed AgentStep's ChannelsSection import at a forked
//   copy path (…/onboarding/wizard/ChannelsSection.svelte instead of the settings one)
//   → O4 REDs ("AgentStep must import the SAME settings ChannelsSection as SettingsView").
//   Restored the settings-path import → O4 GREEN. This is the anti-fork guard: a divergent
//   channel-connect copy is the exact D-031 failure the check exists to catch.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.join(HERE, "..", "portal-app", "src", ...p);
const S = (...p) => path.join(HERE, "..", "src", ...p);
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

const ledger = [];
const rec = (n, pass, d = "") => { ledger.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d}` : ""}`); };

const wizardDir = ["lib", "components", "onboarding", "wizard"];
const wizard = read(P(...wizardDir, "OnboardingWizard.svelte"));
const agentStep = read(P(...wizardDir, "AgentStep.svelte"));
const intelStep = read(P(...wizardDir, "IntelligenceStep.svelte"));
const settingsView = read(P("lib", "views", "SettingsView.svelte"));
const onboardingFlow = read(P("lib", "components", "onboarding", "OnboardingFlow.svelte"));
const portalChat = read(S("portal-chat.js"));

// ── O1 — the wizard is a 5-step flow that renders the new AgentStep ─────────────
const stepsFive = /const\s+STEPS\s*=\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]/.test(wizard);
const totalFive = /const\s+TOTAL\s*=\s*5\b/.test(wizard);
const rendersAgentStep = /<AgentStep\b/.test(wizard) && /import\s+AgentStep\s+from\s+['"]\.\/AgentStep\.svelte['"]/.test(wizard);
rec("O1 wizard is a 5-step flow rendering <AgentStep>", stepsFive && totalFive && rendersAgentStep,
  `STEPS5=${stepsFive} TOTAL5=${totalFive} rendersAgentStep=${rendersAgentStep}`);

// ── O2 — the misplaced name prompt is GONE from Step 3 ─────────────────────────
// The operator's D-031: it was mis-worded AND misplaced. Assert IntelligenceStep no
// longer RENDERS the name field (it moved to Step 5). We check the interactive
// markers (the input id + the state binding), not free text — a history comment
// naming the old prompt must not trip this, but re-adding the field must.
const intelRendersName = /wiz-agent-name/.test(intelStep) || /bind:value=\{agentName\}/.test(intelStep);
rec("O2 IntelligenceStep no longer renders the name field", !intelRendersName,
  `intelStep still renders name field = ${intelRendersName}`);

// ── O3 — Step 5 asks the REWORDED prompt (operator's exact wording) ─────────────
const rewordedPrompt = /How will you call your personal agent\?/.test(agentStep);
rec("O3 AgentStep asks 'How will you call your personal agent?'", rewordedPrompt);

// ── O4 — ANTI-FORK: the wizard channel step is the SAME settings component ──────
// The load-bearing check. SettingsView imports ChannelsSection from the settings
// module; AgentStep MUST import the SAME module and render it — not a second copy.
const SETTINGS_IMPORT = /import\s+ChannelsSection\s+from\s+['"]\$lib\/components\/settings\/ChannelsSection\.svelte['"]/;
const settingsUsesIt = SETTINGS_IMPORT.test(settingsView);
const agentImportsSame = SETTINGS_IMPORT.test(agentStep);
const agentRendersIt = /<ChannelsSection\b/.test(agentStep);
// And it must NOT hand-roll a rival connect flow (the drift D-031 warns about):
// no forked Telegram/Discord token plumbing of its own inside the wizard step.
const agentForks = /TelegramConnect|formDiscordToken|connectDiscord\s*\(/.test(agentStep);
rec("O4 wizard channel step reuses the SAME settings ChannelsSection (no fork)",
  settingsUsesIt && agentImportsSame && agentRendersIt && !agentForks,
  `settingsUsesIt=${settingsUsesIt} agentImportsSame=${agentImportsSame} agentRendersIt=${agentRendersIt} agentForks=${agentForks}`);

// ── O5 — first-message SERVER (D-016): honest greeting, persisted once ──────────
const greetRoute = /router\.post\(\s*['"]\/onboarding\/greeting['"]/.test(portalChat);
const composer = /function\s+composeOnboardingGreeting/.test(portalChat);
// HONEST-EMPTY branch must exist (never invent counts for an empty vault).
const honestEmpty = /composeOnboardingGreeting[\s\S]*?empty/i.test(portalChat);
// Generated ONCE — durable stamp guards a re-greet.
const onceGuard = /onboardingGreetingAt/.test(portalChat);
// Persisted as a chat assistant turn so a reload keeps it.
const persists = /captureMessage\([\s\S]*?role:\s*['"]assistant['"][\s\S]*?CHAT_SOURCE/.test(portalChat);
rec("O5 greeting server: honest, once-only, persisted", greetRoute && composer && honestEmpty && onceGuard && persists,
  `route=${greetRoute} composer=${composer} honestEmpty=${honestEmpty} once=${onceGuard} persists=${persists}`);

// ── O6 — first-message CLIENT (D-016): OnboardingFlow greets + auto-opens chat ──
const callsGreeting = /\/portal\/onboarding\/greeting/.test(onboardingFlow);
const opensChat = /setChatOpen\(\s*true\s*\)/.test(onboardingFlow);
const loadsHistory = /loadHistory\(\s*true\s*\)/.test(onboardingFlow);
rec("O6 OnboardingFlow calls greeting + auto-opens chat", callsGreeting && opensChat && loadsHistory,
  `callsGreeting=${callsGreeting} opensChat=${opensChat} loadsHistory=${loadsHistory}`);

const pass = ledger.every(Boolean);
console.log(`\nVERDICT: ${pass ? "GO" : "NO-GO"} — ${ledger.filter(Boolean).length}/${ledger.length} checks`);
process.exit(pass ? 0 : 1);
