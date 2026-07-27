#!/usr/bin/env node
// verify:updater — static contract for the Tauri auto-updater. The real
// download/verify/swap/relaunch needs an on-Mac vN→vN+1 smoke (operator); this
// gate asserts the WIRING so a refactor can't silently break it:
//   • config: endpoint → the PUBLIC releases latest.json; a pubkey is present;
//   • deps + plugin registration (updater/process/dialog);
//   • the check is PRODUCTION-only + REAL-pubkey-gated + signature-verified + restarts;
//   • the release workflow builds + signs + publishes latest.json, fail-closed.
// Passes in dev even with the placeholder pubkey (loud WARNING), so CI stays green
// until the operator provisions the signing key — the workflow enforces the rest.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };
const PLACEHOLDER = 'REPLACE_WITH_MINISIGN_PUBLIC_KEY';

let fail = 0;
const rec = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); if (!ok) fail = 1; };
const warn = (m) => console.log(`WARN  ${m}`);

const conf = JSON.parse(read('src-tauri/tauri.conf.json') || '{}');
const up = conf.plugins?.updater || {};
const cargo = read('src-tauri/Cargo.toml');
const mainrs = read('src-tauri/src/main.rs');
const wf = read('.github/workflows/desktop-release.yml');
const mk = read('scripts/make-updater-artifact.sh');

// U1 — endpoint points at the PUBLIC repo's rolling latest.json
const ep = Array.isArray(up.endpoints) ? up.endpoints[0] : '';
rec('U1. updater endpoint → public releases latest.json',
  typeof ep === 'string' && ep.startsWith('https://') &&
  ep.includes('Curious-Life/mycelium.id/releases/latest/download/latest.json'),
  ep || '(none)');

// U2 — a pubkey is present (placeholder tolerated in dev, but WARN loudly)
const pk = typeof up.pubkey === 'string' ? up.pubkey.trim() : '';
rec('U2. updater pubkey present', pk.length > 0, pk === PLACEHOLDER ? 'placeholder' : 'set');
if (pk === PLACEHOLDER) warn('updater pubkey is a PLACEHOLDER — operator must set the real minisign key before the public release (the app stays dormant until then).');

// U3 — deps
rec('U3. Cargo deps (updater + process + dialog)',
  /tauri-plugin-updater\s*=/.test(cargo) && /tauri-plugin-process\s*=/.test(cargo) && /tauri-plugin-dialog\s*=/.test(cargo));

// U4 — plugins registered in the Builder
rec('U4. plugins registered in main.rs',
  /\.plugin\(tauri_plugin_updater::/.test(mainrs) && /\.plugin\(tauri_plugin_process::/.test(mainrs) && /\.plugin\(tauri_plugin_dialog::/.test(mainrs));

// U5 — the check is production-only + real-pubkey-gated + verified + relaunches
rec('U5. check is production-only (!is_dev) + gated on a real pubkey',
  /if\s+!is_dev\s*\{[\s\S]{0,120}maybe_check_for_update/.test(mainrs) && /updater_pubkey_is_real/.test(mainrs));
rec('U5b. install verifies + relaunches',
  /download_and_install\(/.test(mainrs) && /\.restart\(\)/.test(mainrs));

// U6 — workflow builds + publishes the manifest
rec('U6. release workflow builds + attaches the updater manifest',
  /make-updater-artifact\.sh/.test(wf) && /dist\/latest\.json/.test(wf) && /Mycelium\.app\.tar\.gz/.test(wf));

// U7 — the signing step is fail-closed (refuse real-pubkey-without-key) + tars the notarized app
rec('U7. updater artifact script is fail-closed + uses the notarized app',
  /TAURI_SIGNING_PRIVATE_KEY/.test(mk) && /stapler validate/.test(mk) && /cargo tauri signer sign/.test(mk) && /PLACEHOLDER/.test(mk));

// ── Manual Settings → General "Check for updates" wiring (wraps the same signed updater) ──
// Isolate each command body so a gate assertion can't be satisfied by a sibling command.
const bodyOf = (name, asyncFn = false) => {
  const kw = asyncFn ? 'async fn' : 'fn';
  const m = mainrs.match(new RegExp(`${kw}\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`));
  return m ? m[0] : '';
};
const checkBody = bodyOf('check_for_update', true);
const installBody = bodyOf('install_update', true);

// U8 — app_version returns the RUNTIME version (package_info), not the config string
rec('U8. app_version command returns the runtime version',
  /#\[tauri::command\]\s*fn\s+app_version/.test(mainrs) && /package_info\(\)\s*\.\s*version/.test(bodyOf('app_version')));

// U9 — the three commands the Settings pane invokes are all registered in the handler
const handler = (mainrs.match(/generate_handler!\[[\s\S]*?\]/) || [''])[0];
rec('U9. app_version + check_for_update + install_update registered in generate_handler!',
  /\bapp_version\b/.test(handler) && /\bcheck_for_update\b/.test(handler) && /\binstall_update\b/.test(handler));

// U10 — check_for_update is production-gated (debug/.dev ⇒ unsupported) + real-pubkey-gated,
//        and mirrors the SAME signature-verified check() the auto-updater uses.
rec('U10. check_for_update is production + real-pubkey gated',
  checkBody.length > 0 &&
  /debug_assertions/.test(checkBody) && /IsDevBuild/.test(checkBody) &&
  /updater_pubkey_is_real\s*\(\s*&?app\s*\)/.test(checkBody) &&
  /"state"\s*:\s*"unsupported"/.test(checkBody) &&
  /\.updater\(\)/.test(checkBody) && /\.check\(\)/.test(checkBody));

// U10b — the SHAPE of the short-circuit, not just the tokens. The guard MUST be the OR
//        form (dev-build OR not-real-pubkey ⇒ unsupported). A `||`→`&&` slip would let a
//        dev build WITH a real pubkey reach the live updater while every token above still
//        passes — so assert the combinator itself, and that no AND joins the two clauses.
//        (Repo lesson: gates assert SHAPE, never just the property.)
const guard = (checkBody.match(/if\s+is_dev_build[\s\S]*?\{/) || [''])[0];
rec('U10b. the production/pubkey guard is the OR short-circuit (not AND)',
  /is_dev_build\s*\|\|\s*!\s*updater_pubkey_is_real\s*\(\s*&?app\s*\)/.test(guard) &&
  !/is_dev_build\s*&&/.test(guard),
  guard.replace(/\s+/g, ' ').trim() || '(guard not found)');

// U11 — install goes through the plugin's verified download+relaunch, with NO signature bypass.
//        (Tauri exposes no bypass flag; assert the verified path + guard against a future one.)
rec('U11. install_update uses the plugin verified download+restart, no signature bypass',
  installBody.length > 0 &&
  /download_and_install\(/.test(installBody) && /\.restart\(\)/.test(installBody) &&
  !/(insecure|skip[_-]?sign|no[_-]?verify|dangerous)/i.test(installBody));

// U12 — D-022 regression guard: check_for_update must never yield a MESSAGE-LESS rejection
//        (the operator saw a bare "check failed" = the client fallback for an empty reason).
//        Its error branches must be STAGE-LABELLED + EMPTY-GUARDED so a down endpoint or a
//        missing plugin surfaces an actual reason, and the shared-state lock must be
//        POISON-TOLERANT — a `.lock().unwrap()` panic would turn a *successful* check into
//        exactly that message-less rejection. Assert the shape, not just the tokens.
// MUTATION-TESTED: reverted the check() Err arm to `e.to_string()` (dropped the "update check
//   failed:" label + empty-guard) → U12 REDs; reintroduced `.lock().unwrap()` → U12 REDs.
//   Both restored; the suite returns GREEN on the restored tree.
rec('U12. check_for_update error branches are labelled + non-empty, state lock is poison-tolerant',
  checkBody.length > 0 &&
  /is_empty\(\)/.test(checkBody) &&
  /updater unavailable:/.test(checkBody) &&
  /update check failed:/.test(checkBody) &&
  /\.lock\(\)\.unwrap_or_else\(/.test(checkBody) &&
  !/\.lock\(\)\.unwrap\(\)/.test(checkBody),
  'error strings stage-labelled + guarded against empty; no panicking lock');

// U13 — D-022 root cause: registering the command is NOT enough. The window loads a REMOTE
//        origin, so Tauri v2 rejects every custom command that no capability permits
//        ("Command check_for_update not allowed by ACL", tauri-2.11.2
//        crates/tauri/src/webview/mod.rs) — which is exactly what the operator saw on v0.1.13
//        once #359 stopped swallowing the reason. The three updater commands the UI invokes
//        must therefore be BOTH declared in build.rs (so an allow-* permission exists at all)
//        AND granted in the capability set. verify:tauri-acl derives this for every command;
//        this is the updater-specific guard so a D-022 regression REDs here too.
// MUTATION-TESTED: dropped "allow-check-for-update" from capabilities/default.json (the exact
//   D-022 defect) → U13 REDs; restored → GREEN.
// MUTATION-TESTED: reverted build.rs to a bare `tauri_build::build()` → U13 REDs; restored → GREEN.
const buildrs = read('src-tauri/build.rs').replace(/\/\/[^\n]*/g, '');
const capPerms = (() => {
  try { return JSON.parse(read('src-tauri/capabilities/default.json')).permissions || []; } catch { return []; }
})();
const aclGap = ['app_version', 'check_for_update', 'install_update'].filter(
  (c) => !capPerms.includes(`allow-${c.replace(/_/g, '-')}`) || !new RegExp(`"${c}"`).test(buildrs));
rec('U13. the invoked updater commands are ACL-permitted (declared in build.rs + granted in the capability)',
  aclGap.length === 0,
  aclGap.length ? `would be rejected with "Command <cmd> not allowed by ACL": ${aclGap.join(', ')}` : 'app_version + check_for_update + install_update permitted');

console.log('\n' + '='.repeat(60));
console.log(fail ? 'VERDICT: NO-GO — updater wiring incomplete' : 'VERDICT: GO — auto-updater wiring intact (real-key + on-Mac smoke = operator)');
console.log('='.repeat(60));
process.exit(fail);
