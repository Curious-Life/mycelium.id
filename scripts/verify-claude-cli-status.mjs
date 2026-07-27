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
//
// MUTATION-TESTED: D-010 — the browser sign-in must actually open a browser:
//   - opener command string plugin:opener|open_url → open_BROKEN in open-external.ts → D10b REDs
//   - final `return false;` fallthrough → `return true;` in open-external.ts → D10c REDs
//   - bare window.open(subWebUrl reintroduced in AISettings → D10d REDs
//   - openExternal(subWebUrl) removed from AISettings (const opened=false) → R8a + D10d RED
//   - onboarding openSubSignIn reverted to bare window.open → D10e REDs
//   - tauri-plugin-opener dep name broken in Cargo.toml → D10f REDs
//   - .plugin(tauri_plugin_opener::init()) removed from main.rs → D10g REDs
//   - opener:allow-open-url removed from capabilities/default.json → D10h REDs
//   (D10a is the file-existence precondition: with open-external.ts absent, D10a/b/c all RED.)
// MUTATION-TESTED: D-002 ↻1 — subscription connected ≠ Claude Code engine:
//   - subConnectedButNoCli condition `&& subscriptionConnected` → `&& false` in EngineSelector → D2a REDs
//   - the "different thing from the Claude Code engine" distinction copy removed → D2b REDs
//   - the "the engine stayed on Mycelium" headline copy removed → D2c REDs
// MUTATION-TESTED: D-002 operator reframe — install/update from the app + persistence:
//   - CLAUDE_NATIVE_INSTALL_SH → an evil URL in claude-cli-install.js → I1b REDs
//   - minimalEnv spread `...env` (leaks secrets) → I2 REDs
//   - runToVerdict verdict forced `true ? {ok:true}` (dishonest exit) → I3 REDs
//   - updateClaudeCli `if (!bin) return not-installed` guard removed → I5 REDs
//   - the endpoint `ok: r.ok && usable` → `ok: r.ok` (no re-probe honesty) → EP2 REDs
//   - installCli POST path `harness/cli/install` → broken → UI1 REDs
//   - load() `mode = j.harnessMode…` → `mode = 'native'` (drops persistence) → P1 REDs
//   - card `class:sel={mode === 'cli'}` → `&& cliEligible` (silent downgrade) → P2 REDs
//   - the `ec-blocked-note` remedy banner renamed away → P3 REDs
// MUTATION-TESTED: F1 — code-exec endpoints reject cross-site even on loopback:
//   - the `if (!requireSameOrigin(req)) 403` guard removed from portal-providers → SEC1/2/3 RED
//   - isSameOriginRequest patched to `return true` (guard always passes) → SEC1/SEC2 RED
// MUTATION-TESTED: F7 — installer stderr never leaks in the returned error:
//   - runToVerdict restored to append `': ' + err.slice(-160)` (leaks stderr) → I7 REDs
// All mutations restored; the suite returns GREEN on the restored tree.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { portalProvidersRouter } from '../src/portal-providers.js';
import {
  probeClaudeCli, fetchLatestClaudeVersion, claudeVersionGte, parseClaudeVersion,
  CLAUDE_MIN_VERSION, _resetLatestCache,
} from '../src/inference/claude-cli-status.js';
import {
  installClaudeCli, updateClaudeCli, CLAUDE_NATIVE_INSTALL_SH,
} from '../src/inference/claude-cli-install.js';

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
ok(/function openSignIn\(\)/.test(AISET) && /openExternal\(subWebUrl\)/.test(AISET) && /subOpenFailed = true/.test(AISET),
  'R8a. the sign-in open path tries the native opener (openExternal) and FAILS VISIBLY when it can’t (subOpenFailed)');
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

// ── D-010 (QA7 P3.2): the sign-in must actually OPEN a browser, not just copy-paste ──
// Operator: "why can't the app open a browser?" window.open('_blank') is swallowed by
// the Tauri webview (a remote http origin), so BOTH sign-in surfaces fell straight to
// their copy-paste fallback — the DEGRADED path shown as the only path. The fix routes
// through the native opener plugin FIRST; assert the whole chain, JS through native.
const OPENEXT = read('portal-app/src/lib/open-external.ts');
const CAP = read('src-tauri/capabilities/default.json');
const MAINRS = read('src-tauri/src/main.rs');
const CARGO = read('src-tauri/Cargo.toml');
ok(!!OPENEXT, 'D10a. open-external.ts exists (the shared open-in-browser helper)');
// The REAL fix hinges on the EXACT opener command + arg key — a typo there silently
// reverts to the swallowed window.open, which is the bug.
ok(/plugin:opener\|open_url/.test(OPENEXT) && /invoke\(['"]plugin:opener\|open_url['"],\s*\{\s*url\s*\}/.test(OPENEXT),
  'D10b. openExternal invokes plugin:opener|open_url with { url } (the native browser hand-off)');
ok(/const w = window\.open\(/.test(OPENEXT) && /if \(w\) return true;/.test(OPENEXT) && /return false;\s*\n\}/.test(OPENEXT),
  'D10c. …with window.open as the dev fallback and an honest final `false` when neither opens');
// Both sign-in surfaces route through it — NOT a bare window.open the webview eats.
ok(/openExternal\(subWebUrl\)/.test(AISET) && !/window\.open\(subWebUrl/.test(AISET),
  'D10d. AISettings "Open Claude sign-in" goes through openExternal, not a bare window.open');
ok(/openExternal\(subWebUrl\)/.test(ONBOARD) && !/window\.open\(subWebUrl/.test(ONBOARD),
  'D10e. Onboarding sign-in goes through openExternal, not a bare window.open');
// The NATIVE side must depend on, register, AND grant the opener — miss any one and
// open_url rejects and we silently fall back to the swallowed path.
ok(/tauri-plugin-opener/.test(CARGO), 'D10f. Cargo.toml depends on tauri-plugin-opener');
ok(/tauri_plugin_opener::init\(\)/.test(MAINRS), 'D10g. main.rs registers the opener plugin');
ok(/opener:allow-open-url/.test(CAP) && /opener:allow-default-urls/.test(CAP),
  'D10h. the webview capability grants open_url + its http/https URL scope');

// ── D-002 (operator reframe 2026-07-24): INSTALL + UPDATE the CLI FROM the app ──
// The bar is no longer copy-paste homework: the app must install the `claude` CLI and
// update it. The behavioural half (I*) runs the REAL runner with an injected spawn — no
// real install — and asserts the fixed command, honesty, and that no vault secret rides
// the child env.
function fakeChild(exitCode, { throwOnClose = false, stderrText = '' } = {}) {
  const handlers = {};
  const child = {
    stderr: { on: (ev, cb) => { handlers[`err:${ev}`] = cb; } },
    on: (ev, cb) => { handlers[ev] = cb; return child; },
    kill: () => {},
  };
  // Emit stderr (if any) then fire close on the next tick, like a real child.
  queueMicrotask(() => {
    if (stderrText) handlers['err:data']?.(Buffer.from(stderrText));
    if (throwOnClose) handlers['error']?.({ code: 'BOOM' });
    else handlers['close']?.(exitCode);
  });
  return child;
}
{
  // I1 — install runs the OFFICIAL fixed command, never an interpolated one.
  let seen = null;
  const spy = (cmd, args, opts) => { seen = { cmd, args, opts }; return fakeChild(0); };
  const r1 = await installClaudeCli({ spawnImpl: spy, platform: 'darwin', env: { PATH: '/usr/bin', HOME: '/h' } });
  ok(r1.ok === true, 'I1a. a clean installer exit → ok:true');
  ok(seen && seen.cmd === '/bin/sh' && Array.isArray(seen.args) && seen.args[0] === '-c' && seen.args[1] === CLAUDE_NATIVE_INSTALL_SH
    && /^curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash$/.test(String(seen.args[1] || '')),
    'I1b. install runs the OFFICIAL claude.ai native-installer command verbatim (no interpolation)');
  // I2 — minimal env: a secret placed in the parent env must NOT reach the child.
  let env2 = null;
  const spy2 = (_c, _a, opts) => { env2 = opts.env; return fakeChild(0); };
  await installClaudeCli({ spawnImpl: spy2, platform: 'darwin', env: { PATH: '/p', HOME: '/h', ANTHROPIC_API_KEY: 'sk-SECRET', ENCRYPTION_MASTER_KEY: 'deadbeef' } });
  ok(env2 && env2.PATH === '/p' && env2.HOME === '/h' && !('ANTHROPIC_API_KEY' in env2) && !('ENCRYPTION_MASTER_KEY' in env2),
    'I2. the installer child env carries PATH/HOME only — no vault secret crosses to it (§1)');
  // I3 — a non-zero exit is an honest failure, never a false ok.
  const r3 = await installClaudeCli({ spawnImpl: () => fakeChild(1), platform: 'darwin', env: { PATH: '/p', HOME: '/h' } });
  ok(r3.ok === false && /^exit-1/.test(r3.error || ''), 'I3. a non-zero installer exit → ok:false with a code');
  // I7 (F7) — the child's stderr can embed the user's home dir; it must NEVER appear in
  // the returned error (§1). Emit a home-dir-shaped stderr line and assert the verdict
  // carries ONLY the machine code.
  const r7 = await installClaudeCli({ spawnImpl: () => fakeChild(2, { stderrText: 'error at /Users/alice/.local/bin/claude: EACCES' }), platform: 'darwin', env: { PATH: '/p', HOME: '/h' } });
  ok(r7.ok === false && r7.error === 'exit-2' && !/Users|alice|\.local|EACCES/.test(r7.error || ''),
    'I7. the returned error is the bare code — the installer stderr (a home-dir path) never leaks (§1)');
  // I4 — a spawn that errors never throws across the boundary.
  const r4 = await installClaudeCli({ spawnImpl: () => fakeChild(0, { throwOnClose: true }), platform: 'darwin', env: { PATH: '/p', HOME: '/h' } });
  ok(r4.ok === false && /spawn-failed/.test(r4.error || ''), 'I4. a spawn error is caught → ok:false, never a throw');
  // I5 — UPDATE with no installed binary refuses BEFORE spawning (nothing to update).
  let updateSpawned = 0;
  const r5 = await updateClaudeCli({ spawnImpl: () => { updateSpawned++; return fakeChild(0); }, findBin: () => null, env: { PATH: '/p', HOME: '/h' } });
  ok(r5.ok === false && r5.error === 'not-installed' && updateSpawned === 0, 'I5. update with no CLI → not-installed, and spawns nothing');
  // I6 — UPDATE with a binary runs `<bin> update`.
  let seenU = null;
  await updateClaudeCli({ spawnImpl: (cmd, args) => { seenU = { cmd, args }; return fakeChild(0); }, findBin: () => '/opt/homebrew/bin/claude', env: { PATH: '/p', HOME: '/h' } });
  ok(seenU && seenU.cmd === '/opt/homebrew/bin/claude' && seenU.args?.[0] === 'update', 'I6. update runs `<resolved-bin> update`');
}

// EP — the endpoints wire the runner AND re-probe, so a clean-exit-but-broken install
// is never sold as success (the honesty rule).
ok(/installClaudeCli|updateClaudeCli/.test(PROVIDERS) && /harness\/cli\/install/.test(PROVIDERS) && /harness\/cli\/update/.test(PROVIDERS),
  'EP1. POST /providers/harness/cli/{install,update} are wired to the runner');
ok(/probeClaudeCli\(\)/.test(PROVIDERS) && /r\.ok && usable/.test(PROVIDERS),
  'EP2. the endpoint RE-PROBES and reports ok ONLY when a usable CLI actually appears (no silent success)');

// ── SEC (F1) — the code-exec endpoints REJECT cross-site requests even on loopback ──
// These SPAWN a process. The vault gate bypasses CSRF for any loopback browser, so a
// cross-site page could auto-POST here. This mounts the REAL router (NO vault gate, so
// the request IS trusted-loopback — exactly the exposed condition) with the installer
// SEAMS stubbed (nothing is ever really installed) and drives real HTTP: a cross-site-
// shaped POST must 403 and NEVER reach the installer; a same-origin one must pass.
{
  let installCalls = 0, updateCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/portal', portalProvidersRouter({
    db: { providers: {} }, userId: 'u',
    installCli: async () => { installCalls++; return { ok: true }; },
    updateCli: async () => { updateCalls++; return { ok: true }; },
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;
  const post = (p, headers) => fetch(base + p, { method: 'POST', headers });
  try {
    // Cross-site shape: browser would send Sec-Fetch-Site: cross-site, and a cross-site
    // POST carries no readable CSRF token. Must be refused BEFORE spawning.
    const xsite = await post('/providers/harness/cli/install', { 'sec-fetch-site': 'cross-site' });
    ok(xsite.status === 403, 'SEC1. a cross-site POST to /cli/install is REFUSED (403) even from loopback', `status=${xsite.status}`);
    // A bare POST with no same-origin proof at all — also refused.
    const bare = await post('/providers/harness/cli/install', {});
    ok(bare.status === 403, 'SEC2. a POST with NO same-origin proof is refused (403)');
    // The installer seam was NEVER reached by either refused request.
    ok(installCalls === 0, 'SEC3. …and the installer is NEVER spawned by a refused request (no forced code-exec)');
    // Same-origin (Fetch Metadata) passes the guard and reaches the (stubbed) installer.
    const same = await post('/providers/harness/cli/install', { 'sec-fetch-site': 'same-origin' });
    ok(same.status !== 403 && installCalls === 1, 'SEC4. a genuine same-origin POST passes the guard and runs the action', `status=${same.status} calls=${installCalls}`);
    // A valid double-submit CSRF token (cookie + matching header) also passes.
    const csrf = await post('/providers/harness/cli/install', { cookie: 'mycelium_csrf=tok123', 'x-csrf-token': 'tok123' });
    ok(csrf.status !== 403 && installCalls === 2, 'SEC5. a valid double-submit CSRF token also passes the guard');
    // A cookie present but a WRONG echoed token is refused (no token confusion).
    const badtok = await post('/providers/harness/cli/update', { cookie: 'mycelium_csrf=tok123', 'x-csrf-token': 'WRONG' });
    ok(badtok.status === 403 && updateCalls === 0, 'SEC6. a wrong CSRF token is refused on /cli/update too (both endpoints guarded)');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// UI — the panel offers the real Install/Update ACTIONS, not just a command.
ok(/async function installCli\(/.test(ENGINE) && /harness\/cli\/install/.test(ENGINE),
  'UI1. EngineSelector installs the CLI from the app (installCli → POST install)');
ok(/async function updateCli\(/.test(ENGINE) && /harness\/cli\/update/.test(ENGINE),
  'UI2. …and updates it from the app (updateCli → POST update)');
ok(/onclick=\{installCli\}/.test(ENGINE) && />\{installing \? 'Installing…' : 'Install Claude Code'\}</.test(ENGINE),
  'UI3. an Install Claude Code button is rendered (missing CLI)');
ok(/updateCli\(\)/.test(ENGINE) && /'Update Claude Code'|>Update</.test(ENGINE),
  'UI4. an Update action is rendered (outdated or newer-available)');

// PERSIST — operator req 3: 'cli' survives a restart and is NEVER silently downgraded.
ok(/mode = j\.harnessMode === 'cli' \? 'cli' : 'native'/.test(ENGINE),
  'P1. load() re-reads the stored engine from harnessMode on mount (persists across restart)');
ok(/class:sel=\{mode === 'cli'\}/.test(ENGINE) && !/class:sel=\{mode === 'cli' &&/.test(ENGINE),
  'P2. the Claude Code card shows selected from `mode` ALONE — eligibility never downgrades the shown selection');
ok(/storedCliButBlocked = \$derived\(loaded && mode === 'cli' && !cliEligible\)/.test(ENGINE) && /ec-blocked-note/.test(ENGINE),
  'P3. a stored-but-blocked engine surfaces a click-free remedy banner (selected-but-blocked, not reverted)');

// ── D-002 ↻1 (QA7 P3.1): a connected subscription is NOT the Claude Code engine ──
// Server persistence + the version gate already work; the recurrence is a CONCEPTUAL
// gap. The operator connected a Claude SUBSCRIPTION and "Claude Code" reverted to
// Mycelium with no reconcilable reason. When a subscription IS connected but the local
// `claude` binary is missing, the panel must (a) detect that as its own state, (b) say
// the subscription≠engine distinction out loud, and (c) EXPLAIN the revert.
ok(/subConnectedButNoCli/.test(ENGINE) && /blocker === 'cli' && subscriptionConnected/.test(ENGINE),
  'D2a. the "subscription connected, CLI still missing" case is detected as its own state');
ok(/different thing from the Claude Code engine/.test(ENGINE) && /command-line program/.test(ENGINE) && /subscription stays connected/.test(ENGINE),
  'D2b. …and the panel copy states the subscription≠engine distinction out loud');
ok(/panelHeadline/.test(ENGINE) && /the engine stayed on Mycelium/.test(ENGINE),
  'D2c. the revert is EXPLAINED (a headline names why the engine stayed on Mycelium), never silent');

console.log('');
if (failures) { console.log(`VERDICT: NO-GO — ${failures} failure(s)`); process.exit(1); }
console.log('VERDICT: GO — Claude CLI version gate + engine dead-click + sign-in/manual-paste recoverability verified');
