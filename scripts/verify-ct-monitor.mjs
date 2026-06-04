// verify:ct-monitor — the CT-monitoring detection logic (mocked crt.sh).
//   CT1 flags wrong-issuer + allowed-CA-but-unknown-serial; legit (LE+known) passes; de-dupes
//   CT2 caaRecords pins LE + dns-01 + accounturi; forbids wildcards; iodef
//   CT3 tolerant of a failing / empty CT source (checked 0, never throws)
// Pure logic over a stubbed fetchImpl; no network.
import { checkHandle, caaRecords } from '../mycelium-managed/src/ct-monitor.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// Mocked crt.sh: legit LE (known serial), rogue issuer, LE-but-unknown-serial, + a dup log entry.
const ctJson = [
  { id: 1, issuer_name: "C=US, O=Let's Encrypt, CN=R3", serial_number: 'AABB', not_before: '2026-06-01' },
  { id: 2, issuer_name: 'C=XX, O=Evil CA', serial_number: 'CCDD', not_before: '2026-06-02' },
  { id: 3, issuer_name: "O=Let's Encrypt", serial_number: 'EEFF', not_before: '2026-06-03' },
  { id: 1, issuer_name: "C=US, O=Let's Encrypt, CN=R3", serial_number: 'AABB', not_before: '2026-06-01' },
];

const r1 = await checkHandle({ handle: 'alice', zone: 'mycelium.id', knownSerials: new Set(['aabb']), fetchImpl: async () => ({ ok: true, json: async () => ctJson }) });
const reasons = r1.rogue.map((x) => x.reason);
rec('CT1. flags wrong-issuer + LE-unknown-serial; legit passes; de-dupes',
  r1.checked === 3 && r1.rogue.length === 2 && reasons.some((x) => /allowlist/.test(x)) && reasons.some((x) => /serial/.test(x)),
  `checked=${r1.checked} rogue=${r1.rogue.length}`);

const caa = caaRecords({ zone: 'mycelium.id', accountUri: 'https://acme-v02.api.letsencrypt.org/acme/acct/123' });
const issue = caa.find((s) => s.includes('issue '));
rec('CT2. caaRecords pins LE + dns-01 + accounturi; forbids wildcards; iodef',
  !!issue && issue.includes('letsencrypt.org') && issue.includes('validationmethods=dns-01') && issue.includes('accounturi=https://acme-v02')
  && caa.some((s) => s.includes('issuewild ";"')) && caa.some((s) => s.includes('iodef')),
  '');

const bad = await checkHandle({ handle: 'bob', fetchImpl: async () => { throw new Error('crt.sh 502'); } });
const empty = await checkHandle({ handle: 'carol', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
rec('CT3. tolerant of a failing / empty CT source (checked 0, no throw)',
  bad.checked === 0 && bad.rogue.length === 0 && empty.checked === 0, `bad=${bad.checked} empty=${empty.checked}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — CT-monitor detects rogue certs; CAA records correct' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
