// verify:catalog-tags — confirm every model in the S6 catalog is a REAL,
// pullable Ollama tag. The catalog is the pull allowlist, so a typo or a
// hallucinated/renamed tag must never ship.
//
// NETWORK GATE (not in the hermetic `npm run verify` chain): run it manually
// when adding/bumping catalog entries, e.g. `npm run verify:catalog-tags`.
//
// Tag-precise check = the Ollama REGISTRY MANIFEST API:
//   https://registry.ollama.ai/v2/<ns>/<model>/manifests/<tag>
//   200 (or 401, which still proves the tag resolves) = exists; 404 = does not.
// A library *page* (ollama.com/library/<model>) only proves the MODEL exists,
// not the specific :tag — so we check the manifest, and use the page as a hint.

import { CATALOG } from '../src/hardware/catalog.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };

async function head(url) {
  try { const r = await fetch(url, { method: 'GET', redirect: 'follow' }); return r.status; }
  catch { return 0; }
}

for (const m of CATALOG) {
  const [left, tag = 'latest'] = m.name.split(':');
  // library/<model> for bare names; <ns>/<model> for namespaced (e.g. vanilj/foo).
  const path = left.includes('/') ? left : `library/${left}`;
  const code = await head(`https://registry.ollama.ai/v2/${path}/manifests/${tag}`);
  const ok = code === 200 || code === 401; // 401 = auth-gated but the tag resolves
  rec(`tag exists: ${m.name}`, ok, `manifest=${code}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? `GO — all ${CATALOG.length} catalog tags resolve on the Ollama registry` : 'NO-GO — a catalog tag does not resolve (fix src/hardware/catalog.js)'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
