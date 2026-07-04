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

console.log('\n' + '='.repeat(60));
console.log(fail ? 'VERDICT: NO-GO — updater wiring incomplete' : 'VERDICT: GO — auto-updater wiring intact (real-key + on-Mac smoke = operator)');
console.log('='.repeat(60));
process.exit(fail);
