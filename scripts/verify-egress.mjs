// verify:egress — the §4e/§4g egress boundary on the inference router. Asserts:
//   - sensitive content is HARD-BLOCKED from a US provider (falls back to local),
//     audited as decision 'denied' / reason 'sensitive_us_block';
//   - non-sensitive content to a US provider is 'allowed' + runs cloud;
//   - sensitive content to an EU-sovereign provider is 'allowed' (eu is fine);
//   - every egress event carries a sha256 hash + length, NEVER the prompt;
//   - createEgressAuditSink records through db.audit.log (hash only).
// Pure router/seam test (no vault boot) — mock fetch + mock onEgress. PASS/FAIL.
import crypto from 'node:crypto';
import { createInferenceRouter } from '../src/inference/router.js';
import { createEgressAuditSink } from '../src/inference/egress.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Mock fetch: local Ollama /api/generate → 'local-out'; cloud openai-compat → 'cloud-out'.
const mockFetch = async (url) => {
  if (/\/api\/generate$/.test(url)) return { ok: true, status: 200, async text() { return JSON.stringify({ response: 'local-out' }); } };
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'cloud-out' } }] }); } };
};

function mkRouter(jurisdiction, events) {
  return createInferenceRouter({
    fetch: mockFetch,
    openaiApiKey: 'k', baseUrl: 'https://api.example.com/v1', jurisdiction,
    onEgress: (e) => events.push(e),
    env: {},
  });
}

// 1. sensitive + US → hard-block → local; audited 'denied'
let ev = [];
let out = await mkRouter('us-standard', ev).infer({ prompt: 'secret-payload', task: 'complex', sensitive: true });
const d0 = ev[0] || {};
rec('E1. sensitive + US → falls back to local (cloud DENIED)', out === 'local-out' && d0.decision === 'denied' && d0.reason === 'sensitive_us_block', `out=${out} decision=${d0.decision}`);
rec('E2. denied egress audited with sha256 hash + length, NOT the prompt',
  d0.contentHash === crypto.createHash('sha256').update('secret-payload').digest('hex')
  && d0.contentLength === 'secret-payload'.length
  && !('prompt' in d0) && !JSON.stringify(d0).includes('secret-payload'),
  `hash=${String(d0.contentHash).slice(0, 12)}…`);

// 2. non-sensitive + US → allowed → cloud
ev = [];
out = await mkRouter('us-standard', ev).infer({ prompt: 'public', task: 'complex', sensitive: false });
rec('E3. non-sensitive + US → cloud ALLOWED', out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// 3. sensitive + EU-sovereign → allowed (eu-zdr is privacy-safe)
ev = [];
out = await mkRouter('eu-zdr', ev).infer({ prompt: 'secret', task: 'complex', sensitive: true });
rec('E4. sensitive + EU-sovereign → cloud ALLOWED (eu-zdr is fine)', out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// 4. no onEgress configured → still routes, no throw (audit is optional)
out = await mkRouter('us-standard', []).infer({ prompt: 'x', task: 'summarize' }); // simple → local
rec('E5. router works with no onEgress (audit optional)', out === 'local-out', `out=${out}`);

// 5. createEgressAuditSink → db.audit.log (hash only, no prompt)
const logged = [];
const fakeDb = { audit: { log: (entry) => logged.push(entry) } };
const sink = createEgressAuditSink(fakeDb, 'local-user');
sink({ provider: 'api.example.com', jurisdiction: 'us-standard', model: 'm', contentHash: 'abc123', contentLength: 5, decision: 'allowed' });
const L = logged[0] || {};
rec('E6. createEgressAuditSink → db.audit.log (action inference-egress, hash-only)',
  L.action === 'inference-egress' && L.userId === 'local-user' && L.details?.content_hash === 'abc123'
  && L.details?.decision === 'allowed' && !JSON.stringify(L).includes('prompt'),
  JSON.stringify(L.details));
rec('E7. createEgressAuditSink is undefined when db has no audit namespace', createEgressAuditSink({}, 'u') === undefined);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — egress boundary: sensitive hard-blocked from US providers; every egress audited hash-only (§4e/§4g)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
