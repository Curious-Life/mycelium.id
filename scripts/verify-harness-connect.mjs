// verify:harness-connect — the "pick your harness" surface (docs + portal picker).
//   H1 HARNESS-RECIPES.md covers every first-class harness (memory + model doors)
//   H2 openclaw scam-safety note present in the recipes doc
//   H3 local-only / remote-coming-soon banner present (honest reachability)
//   H4 design doc exists and names the two doors
//   H5 HarnessPickerSection.svelte renders every harness + the real endpoints
//   H6 the picker carries the openclaw safety note (UI parity with the doc)
//   H7 SettingsView mounts HarnessPickerSection (imported + placed)
//   H8 CONNECT-YOUR-AI.md links to the recipes doc
// Pure file-content checks; no network; CWD-independent. Never logs a secret.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const has = (s, ...needles) => needles.every((x) => s.includes(x));

let recipes = '', picker = '', settings = '', overview = '';
try {
  recipes = read('docs/HARNESS-RECIPES.md');
  picker = read('portal-app/src/lib/components/settings/HarnessPickerSection.svelte');
  settings = read('portal-app/src/lib/views/SettingsView.svelte');
  overview = read('docs/CONNECT-YOUR-AI.md');
} catch (e) {
  rec('H0. all artifacts readable', false, String(e?.message || e));
}

// ── H1 — every first-class harness covered, both doors named ──────────────────
const HARNESSES = ['Mycelium-native', 'Claude Desktop', 'opencode', 'openclaw', 'hermes-agent', 'Custom'];
rec('H1. recipes doc covers every first-class harness',
  HARNESSES.every((h) => recipes.includes(h)) && has(recipes, '/mcp', '/v1', 'mycelium-auto'),
  `missing: ${HARNESSES.filter((h) => !recipes.includes(h)).join(', ') || 'none'}`);

// ── H2 — openclaw scam-safety note in the doc ────────────────────────────────
rec('H2. openclaw scam-safety note present',
  has(recipes, 'openclaw/openclaw', 'openclaw.ai') && /scam|impersonat/i.test(recipes),
  'must steer to the canonical repo + domain');

// ── H3 — honest local-only / remote-coming-soon banner ───────────────────────
rec('H3. local-only banner present',
  /local-only/i.test(recipes) && /coming soon|not live/i.test(recipes));

// ── H5 — picker renders every harness id + the real endpoints ────────────────
const IDS = ['mycelium', 'claude', 'opencode', 'openclaw', 'hermes', 'custom'];
rec('H5. picker component renders every harness + real endpoints',
  IDS.every((id) => picker.includes(`id: '${id}'`)) &&
    has(picker, 'http://127.0.0.1:4711', '/mcp', '/v1', 'mycelium-auto', 'streamable-http'),
  `missing ids: ${IDS.filter((id) => !picker.includes(`id: '${id}'`)).join(', ') || 'none'}`);

// ── H6 — picker carries the openclaw safety note (UI/doc parity) ──────────────
rec('H6. picker shows the openclaw safety note',
  has(picker, 'openclaw/openclaw', 'openclaw.ai') && /scam|impersonat/i.test(picker));

// ── H7 — SettingsView mounts the picker ──────────────────────────────────────
rec('H7. SettingsView imports + mounts HarnessPickerSection',
  has(settings, "import HarnessPickerSection", '<HarnessPickerSection'));

// ── H8 — overview links to the recipes doc ───────────────────────────────────
rec('H8. CONNECT-YOUR-AI.md links to HARNESS-RECIPES.md',
  overview.includes('HARNESS-RECIPES.md'));

// ── verdict ──────────────────────────────────────────────────────────────────
const pass = ledger.filter(Boolean).length;
console.log(`\n${pass}/${ledger.length} checks passed`);
const go = ledger.length > 0 && ledger.every(Boolean);
console.log(`VERDICT: ${go ? 'GO' : 'NO-GO'}`);
process.exit(go ? 0 : 1);
