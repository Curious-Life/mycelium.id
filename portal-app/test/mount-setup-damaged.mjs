// Mounts the REAL src/routes/setup/+page.svelte against a stubbed /api/v1/account/status
// and prints which screen a user actually lands on. Run (cwd = portal-app):
//   node --conditions browser test/mount-setup-damaged.mjs <scenario>
// scenario: 'corrupt' (bootError=vault_corrupt) | 'generic' (some other bootError)
//
// ⚠️ WHY A MOUNT AND NOT A GREP. The check this replaces read the .svelte SOURCE and
// asserted an index ordering (the vault_corrupt branch appears before the generic restore
// route) plus a handful of strings inside the damaged block. An independent adversarial
// review defeated it in one character: `if (false && bootError === 'vault_corrupt')`. Every
// index still resolved, every string was still present in the file, and a damaged vault
// fell straight through to mode='restore' — the paste-your-recovery-key screen, which is
// the ENTIRE reported symptom of the 2026-07-26 incident. 16 passed, 0 failed.
//
// Ordering in a source file is not routing. This mounts the component, answers its status
// fetch, and reads the text on screen.
//
// KNOWN LIMIT, stated rather than laundered: textContent sees the DOM, not visibility —
// a block hidden by CSS still counts as present. This catches wrong routing, removal and
// reintroduction; not concealment.
//
// Emits ONE JSON object on stdout; scripts/verify-vault-fail-stop.mjs does the asserting.
import { compile } from 'svelte/compiler';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const scenario = process.argv[2] || 'corrupt';
const GEN = `.gen-mount-setup-${scenario}`;
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// The decorative canvas is the ONLY $lib import and is irrelevant to routing; stub it so
// the harness stays offline. Nothing under test is stubbed — the page's own logic and its
// whole template are compiled for real.
writeFileSync(`${GEN}/canvas-stub.js`, 'export default function MyceliumCanvas() { return {}; }\n');

const out = compile(readFileSync('src/routes/setup/+page.svelte', 'utf8'), {
  generate: 'client', name: 'SetupPage', css: 'injected',
});
writeFileSync(`${GEN}/SetupPage.js`, out.js.code
  .replace(/from ['"]\$lib\/components\/onboarding\/MyceliumCanvas\.svelte['"]/g, `from './canvas-stub.js'`));

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'FormData', 'Blob']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}
// location.assign must not blow up jsdom — the page calls it on the initialized path.
const navigations = [];
try {
  Object.defineProperty(dom.window, 'location', {
    configurable: true,
    value: { ...dom.window.location, assign: (u) => navigations.push(String(u)), href: 'http://localhost/setup' },
  });
} catch { /* jsdom variant without a redefinable location */ }
globalThis.location = dom.window.location;

// The vault is PRESENT and its key is fine; it is structurally damaged. needsRecoveryKey is
// deliberately true — that is what made the generic branch grab it — so the only thing that
// can route this correctly is the vault_corrupt test running FIRST and actually running.
const status = {
  initialized: false,
  locked: false,
  needsRecoveryKey: true,
  keychainAvailable: true,
  bootError: scenario === 'corrupt' ? 'vault_corrupt' : 'boot_failed',
};
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/v1/account/status')) {
    return { ok: true, status: 200, json: async () => status };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const result = { mounted: false, error: null, scenario, text: '', navigations };
try {
  const { mount, flushSync } = await import('svelte');
  const Comp = (await import(pathToFileURL(`${process.cwd()}/${GEN}/SetupPage.js`).href)).default;
  mount(Comp, { target: document.getElementById('app') });
  flushSync();
  await new Promise((r) => setTimeout(r, 60));
  flushSync();
  result.text = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
  result.mounted = true;
} catch (e) {
  result.error = String(e?.stack || e?.message || e);
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
