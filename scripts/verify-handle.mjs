// verify:handle — handle validation is UNIFIED on the DNS-safe rule (identity.js
// isValidHandle) so a profile handle is always a valid <handle>.mycelium.id
// subdomain / did:web label. Regression guard for the dash-vs-underscore divergence
// bug: portal-compat.js used to accept underscores (`[a-z0-9_]{2,29}`) that can never
// be a hostname, while identity.js (federation source of truth) requires dashes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isValidHandle } = await import('../src/identity/identity.js');

let pass = 0, fail = 0;
const ok = (c, l, x = '') => {
  if (c) { pass++; console.log(`PASS  ${l}${x ? '  ' + x : ''}`); }
  else { fail++; console.log(`FAIL  ${l}${x ? '  ' + x : ''}`); }
};

// 1. the DNS-safe rule itself
ok(isValidHandle('my-name'), 'dash handle valid (subdomain-safe)');
ok(!isValidHandle('my_name'), 'underscore handle REJECTED (not a valid hostname)');
ok(isValidHandle('ab'), '2-char handle valid');
ok(!isValidHandle('a'), '1-char handle invalid');
ok(isValidHandle('a'.repeat(32)), '32-char handle valid');
ok(!isValidHandle('a'.repeat(33)), '33-char handle invalid (>32)');
ok(!isValidHandle('-ab'), 'leading dash invalid');
ok(!isValidHandle('ab-'), 'trailing dash invalid');
ok(!isValidHandle('Ab'), 'uppercase invalid');
ok(!isValidHandle('a b'), 'space invalid');
ok(isValidHandle('martin'), 'plain alnum handle valid (the current vault handle)');

// 2. convergence — the app layer no longer carries a divergent regex
const compat = readFileSync(path.join(ROOT, 'src/portal-compat.js'), 'utf8');
ok(/isValidHandle/.test(compat), 'portal-compat uses isValidHandle (unified source of truth)');
ok(!/\[a-z0-9_\]\{2,29\}/.test(compat), 'portal-compat no longer carries the underscore handle regex');

// 3. the client mirrors it (no underscore input pattern in ProfileView)
const prof = readFileSync(path.join(ROOT, 'portal-app/src/lib/views/ProfileView.svelte'), 'utf8');
ok(!/pattern="\[a-z0-9\]\[a-z0-9_\]/.test(prof), 'ProfileView input pattern is dash-based, not underscore');

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
