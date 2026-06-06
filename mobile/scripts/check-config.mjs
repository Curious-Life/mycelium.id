// mobile/scripts/check-config.mjs — lightweight, toolchain-free sanity + security
// gate for the Capacitor scaffold (runs anywhere; the full iOS/Android build
// needs a macOS runner — see README). Guards the security-relevant invariants of
// the remote-webview shell.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

const cfg = readFileSync(join(ROOT, 'capacitor.config.ts'), 'utf8');
ok(/appId:\s*['"]id\.mycelium\.app['"]/.test(cfg), 'appId is id.mycelium.app');
ok(cfg.includes("'*.mycelium.id'") || cfg.includes('"*.mycelium.id"'), 'allowNavigation scoped to *.mycelium.id');
// SECURITY: the webview must NOT be allowed to navigate anywhere.
ok(!/allowNavigation:\s*\[[^\]]*['"]\*['"]/.test(cfg), 'allowNavigation does NOT contain a bare * wildcard');
ok(!/server:\s*\{[^}]*url:/s.test(cfg), 'no hardcoded server.url (box URL is per-user, set at pairing)');

const pair = readFileSync(join(ROOT, 'www', 'pair.js'), 'utf8');
ok(/HANDLE_RE\s*=\s*\/\^\[a-z0-9\]/.test(pair), 'pair.js validates the handle as a DNS label');
ok(/https:\/\/\$\{handle\}\.mycelium\.id/.test(pair), 'pair.js builds an https box URL from the handle');
// The shell must persist ONLY the handle — never vault data/keys. Assert there is
// exactly one Preferences.set and it writes HANDLE_KEY.
const setCalls = (pair.match(/Preferences\.set\(/g) || []).length;
ok(setCalls === 1 && /Preferences\.set\(\{\s*key:\s*HANDLE_KEY/.test(pair), 'pair.js persists ONLY the handle (single Preferences.set of HANDLE_KEY)');

ok(existsSync(join(ROOT, 'www', 'index.html')), 'www/index.html (pairing landing) present');
ok(existsSync(join(ROOT, 'LICENSE.md')), 'mobile/LICENSE.md present (shell license boundary)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
