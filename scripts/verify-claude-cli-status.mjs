#!/usr/bin/env node
// verify:claude-cli-status — QA6 recoverability P1: three actions that silently did
// nothing. This gate asserts they cannot silently do nothing again.
//
// It covers TWO claims the operator reported as dead:
//   (a) an UNINSTALLED / OUTDATED Claude CLI must yield an ACTIONABLE message, and the
//       Engine card must remain CLICKABLE (a `disabled` button eats the click — that
//       was the dead click), with the version facts on screen;
//   (b) an auto-detect FAILURE must surface the MANUAL paste path, not a wall.
//
// METHOD NOTE (memory: "Gates fail on FIXTURES, not assertions"). The behavioural half
// (B*) runs the REAL probeClaudeCli with injected deps — no stubbed module, no grep. The
// render half (R*) has to read the .svelte source, so each assertion is written against
// the PROPERTY that broke (the `disabled` attribute is not bound to eligibility; the
// sign-in URL is rendered UNCONDITIONALLY; the onboarding connect posts the LADDER
// endpoint, not the legacy import) rather than against copy that a refactor can restyle.
//
// VERDICT: GO / exit 0.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  probeClaudeCli, fetchLatestClaudeVersion, claudeVersionGte, parseClaudeVersion,
  CLAUDE_MIN_VERSION, _resetLatestCache,
} from '../src/inference/claude-cli-status.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch { return ''; } };

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const ENGINE = read('portal-app/src/lib/components/settings/EngineSelector.svelte');
const AISET = read('portal-app/src/lib/components/settings/AISettings.svelte');
const ONBOARD = read('portal-app/src/lib/components/onboarding/OnboardingFlow.svelte');
const PROVIDERS = read('src/portal-providers.js');
ok(ENGINE && AISET && ONBOARD && PROVIDERS, 'S0. all four source files readable');

// Deps that make the probe hermetic: no spawn, no network, no host state.
const noNet = async () => null;                       // "latest" unknown (offline)
const netSays = (v) => async () => v;
const notInstalled = () => null;
const installedAt = () => '/opt/homebrew/bin/claude';

// ── A. VERSION ARITHMETIC ────────────────────────────────────────────────────
ok(claudeVersionGte('2.1.198', '2.0.0'), 'A1. 2.1.198 ≥ 2.0.0');
ok(!claudeVersionGte('1.9.9', '2.0.0'), 'A2. 1.9.9 < 2.0.0');
ok(claudeVersionGte('2.0.0', '2.0.0'), 'A3. equal versions satisfy the floor');
ok(!claudeVersionGte('garbage', '2.0.0'), 'A4. unparseable → false (callers decide what that means)');
ok(parseClaudeVersion('v2.1.198 (Claude Code)')?.join('.') === '2.1.198', 'A5. parses a decorated --version line');

// ── B. THE THREE FACTS + AN ACTIONABLE NEXT STEP ─────────────────────────────
// B1 — NOT INSTALLED: terminal, but actionable (a command the user can run).
const b1 = await probeClaudeCli({ findBin: notInstalled, latest: noNet });
ok(b1.installed === false && b1.usable === false && b1.reason === 'not_installed', 'B1a. uninstalled → installed:false, usable:false, reason:not_installed');
ok(typeof b1.action?.message === 'string' && b1.action.message.length > 20 && /install/i.test(b1.action.message),
  'B1b. uninstalled yields an ACTIONABLE message (not a bare boolean)');
ok(/npm i -g @anthropic-ai\/claude-code/.test(b1.action?.command || ''), 'B1c. uninstalled hands back the install COMMAND');
ok(/^https:\/\//.test(b1.action?.docsUrl || ''), 'B1d. uninstalled hands back a docs link');

// B2 — OUTDATED: the version gate itself. Provably-below-floor fails CLOSED for
// selection (unproven confinement), with an update command — never a dead click.
const b2 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => '1.2.0', latest: noNet });
ok(b2.installed === true && b2.version === '1.2.0' && b2.versionOk === false && b2.usable === false && b2.reason === 'outdated',
  'B2a. installed-but-old → usable:false, reason:outdated');
ok(b2.action.message.includes('1.2.0') && b2.action.message.includes(CLAUDE_MIN_VERSION),
  'B2b. the outdated message names BOTH the found version and the required one');
ok(/claude update/.test(b2.action?.command || ''), 'B2c. outdated hands back the update COMMAND');

// B3 — OUTDATED, ONLINE: the "latest" fact appears when we can learn it.
const b3 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => '1.2.0', latest: netSays('2.1.198') });
ok(b3.latestVersion === '2.1.198' && b3.action.message.includes('2.1.198'), 'B3. online → the message also names the LATEST version');

// B4 — CURRENT: usable, and the version is reported so the UI can state it.
const b4 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => '2.1.198', latest: netSays('2.1.198') });
ok(b4.usable === true && b4.versionOk === true && b4.version === '2.1.198' && b4.updateAvailable === false, 'B4. current → usable, updateAvailable:false');

// B5 — UPDATE AVAILABLE but usable: informational ONLY. Must never gate selection.
const b5 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => '2.0.5', latest: netSays('2.1.198') });
ok(b5.usable === true && b5.updateAvailable === true, 'B5. newer published version is informational — still usable');

// B6 — OFFLINE must degrade to "installed, vX", NEVER to a wall.
const b6 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => '2.1.198', latest: noNet });
ok(b6.usable === true && b6.latestVersion === null && b6.updateAvailable === false, 'B6a. offline → latestVersion:null, still usable');
ok(!/error|fail|could ?n[o']t/i.test(b6.action.message) && b6.action.message.includes('2.1.198'), 'B6b. offline message states the installed version, no error language');

// B7 — a THROWING "latest" lookup must not take the probe down with it.
const b7 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => '2.1.198', latest: async () => { throw new Error('DNS'); } });
ok(b7.usable === true && b7.latestVersion === null, 'B7. a throwing latest-lookup degrades to null, never rejects');

// B8 — UNREADABLE version must NOT re-create the dead click: tri-state null = usable.
const b8 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => null, latest: noNet });
ok(b8.installed === true && b8.versionOk === null && b8.usable === true, 'B8. unreadable version → versionOk:null and STILL usable (fail-open on version only)');

// B9 — a throwing binary probe is the same "can't tell", not an outage.
const b9 = await probeClaudeCli({ findBin: installedAt, binaryVersion: async () => { throw new Error('EACCES'); }, latest: noNet });
ok(b9.usable === true && b9.versionOk === null, 'B9. a throwing --version probe → can’t-tell, still usable');

// B10 — SECURITY (§1/§8): the payload crosses to the portal. It must carry NO path.
const shapes = [b1, b2, b3, b4, b5, b6, b7, b8, b9];
const serialized = JSON.stringify(shapes);
ok(!/\/opt\/homebrew\/bin\/claude/.test(serialized) && !/"(path|bin|binary)"\s*:/.test(serialized),
  'B10. the probe result NEVER carries the resolved binary path (it embeds the user’s home dir)');

// B11 — the opt-out actually stops the network call (an air-gapped vault makes none).
let called = 0;
_resetLatestCache();
const off = await fetchLatestClaudeVersion({ env: { MYCELIUM_NO_UPDATE_CHECK: '1' }, fetchImpl: async () => { called++; return { ok: true, json: async () => ({ version: '9.9.9' }) }; }, cache: false });
ok(off === null && called === 0, 'B11. MYCELIUM_NO_UPDATE_CHECK=1 makes ZERO outbound calls');
_resetLatestCache();
const on = await fetchLatestClaudeVersion({ env: {}, fetchImpl: async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }), cache: false });
ok(on === '9.9.9', 'B11b. …and the lookup still works when not opted out');

// ── C. THE SERVER SURFACES IT ────────────────────────────────────────────────
ok(/probeClaudeCli/.test(PROVIDERS) && /\bclaude,/.test(PROVIDERS),
  'C1. GET /providers/harness returns the `claude` status block (probeClaudeCli wired)');
ok(/claudeAvailable:\s*claude\s*\?\s*claude\.usable/.test(PROVIDERS),
  'C2. claudeAvailable is VERSION-AWARE (claude.usable), not a bare existence check');

// ── R. THE RENDER: the dead click is gone ────────────────────────────────────
// R1 is THE assertion for the reported bug. The old markup was
//   disabled={busy !== null || !cliEligible}
// which is what ate the click. Assert the disabled binding does NOT mention
// eligibility — a property, not a phrasing.
// NOTE the lookbehind: `\bdisabled=` also matches `aria-disabled=`, which we WANT to
// keep bound to eligibility (it is the a11y signal, not the click-eater).
const engineDisabled = ENGINE.match(/(?<![-\w])disabled=\{([^}]*)\}/g) || [];
const eligibilityDisables = engineDisabled.some((d) => /cliEligible|claudeAvailable|subscriptionConnected|engineReady/.test(d));
ok(engineDisabled.length > 0 && !eligibilityDisables,
  'R1. the Claude Code card is NEVER `disabled` for ineligibility (the dead click)');
ok(/if\s*\(next === 'cli' && !cliEligible\)\s*\{\s*panelOpen = true;\s*return;\s*\}/.test(ENGINE),
  'R2. an ineligible pick OPENS the explanation panel instead of returning silently');
ok(/ec-panel/.test(ENGINE) && /panelMessage/.test(ENGINE) && /panelCommand/.test(ENGINE),
  'R3. the panel renders the message AND the fix command');
ok(/onclick=\{recheck\}|onclick=\{\(\) => recheck\(\)\}/.test(ENGINE) && /async function recheck/.test(ENGINE),
  'R4. the panel offers a Re-check so an install/update is noticed without a reload');
ok(/claude\?\.version/.test(ENGINE) && /claude\.minVersion/.test(ENGINE) && /claude\.latestVersion/.test(ENGINE),
  'R5. the card states installed version, required minimum, and latest — the three facts');
ok(/mycelium:connect-claude-sub/.test(ENGINE) && /mycelium:connect-claude-sub/.test(AISET),
  'R6. "connect your subscription" is an ACTION (dispatch → AISettings opens + scrolls), not prose');

// R7/R8 — issue #2: "Open Claude sign-in" opened nothing.
ok(!/href=\{subWebUrl\}[^>]*target="_blank"/.test(AISET),
  'R7. the sign-in control is no longer a bare <a target="_blank"> (swallowed in the webview)');
ok(/function openSignIn\(\)/.test(AISET) && /if \(!w\) subOpenFailed = true;/.test(AISET) && /subOpenFailed/.test(AISET),
  'R8a. a blocked window.open FAILS VISIBLY (subOpenFailed)');
// The copyable URL must be rendered UNCONDITIONALLY — a webview can refuse without
// reporting, so it cannot be gated on the failure flag.
const urlBlock = AISET.match(/<div class="signin-url">[\s\S]{0,80}?<\/div>/);
ok(!!urlBlock, 'R8b. the sign-in URL is rendered as copyable text');
// Prove it is OUTSIDE the failure branch by slicing that branch out and checking the
// block is still there. (A substring search from `{#if subOpenFailed}` onward would
// always match, since the failure branch precedes the URL block in source order.)
// ⚠️ MUTATION-PROVEN HOLE (M3): checking only the FIRST `{#if subOpenFailed}` block let a
// mutation that wrapped the URL in a SECOND one pass green. Check EVERY such branch, and
// require the URL block to survive removal of all of them.
const failBranches = [...AISET.matchAll(/\{#if subOpenFailed\}[\s\S]*?\{\/if\}/g)].map((m) => m[0]);
const aisetOutsideFailBranches = failBranches.reduce((s, b) => s.replace(b, ''), AISET);
ok(!!urlBlock && failBranches.length > 0
  && failBranches.every((b) => !b.includes('signin-url'))
  && aisetOutsideFailBranches.includes('class="signin-url"'),
  'R8c. …UNCONDITIONALLY — the URL block survives removing EVERY {#if subOpenFailed} branch');
ok(/copySignInUrl/.test(AISET), 'R8d. …with a Copy control');

// R9 — issue #3: auto-detect failure must surface the MANUAL path.
// Assert the CALL, not the string: the header comment above connectSub names the legacy
// route to explain what was removed, and a prose mention must not fail this.
ok(!/api\(\s*['"][^'"]*auth\/claude\/import/.test(ONBOARD),
  'R9a. onboarding no longer CALLS the legacy /auth/claude/import (whose only failure mode is a wall)');
ok(/auth\/claude\/connect/.test(ONBOARD) && /auth\/claude\/code/.test(ONBOARD),
  'R9b. onboarding runs the LADDER: /connect then /code');
ok(/d\.url/.test(ONBOARD) && /subWebUrl = d\.url/.test(ONBOARD),
  'R9c. a not-connected response carries the user to the web flow automatically');
ok(/sub-code/.test(ONBOARD) && /finishSubWeb/.test(ONBOARD),
  'R9d. the manual paste box + finish action render inline on auto-detect failure');
ok(/subWebReason === 'declined'/.test(ONBOARD) && /wrong_scope/.test(ONBOARD),
  'R9e. …with the REAL reason, not a generic error');
ok(/function openSubSignIn/.test(ONBOARD) && /subOpenFailed = true/.test(ONBOARD) && /sub-url/.test(ONBOARD),
  'R9f. onboarding’s open-browser control also fails visibly + always shows the URL');
// The manual path in Settings must SURVIVE — the brief says keep it, don't replace it.
ok(/finishSubWeb/.test(AISET) && /Paste the code from Claude/.test(AISET),
  'R10. the existing manual entry in Settings is PRESERVED (fallback not removed)');

console.log('');
if (failures) { console.log(`VERDICT: NO-GO — ${failures} failure(s)`); process.exit(1); }
console.log('VERDICT: GO — Claude CLI version gate + engine dead-click + sign-in/manual-paste recoverability verified');
