// verify:newproxy-auth — the frps NewProxy auth-hook (per-tenant hostname binding).
//   NA1 valid tenant binds own host → allow (+ bandwidth clamped server-side)
//   NA2 tenant binding ANOTHER tenant's host → reject
//   NA3 unknown / missing token → reject
//   NA4 non-https proxy type → reject (passthrough only)
//   NA5 subdomain mismatch → reject; matching subdomain → allow
//   NA6 Login: known token allow, unknown reject
// Pure functions over a fake registry; no network. The multitenancy gate.
import { authorizeNewProxy, authorizeLogin } from '../mycelium-managed/src/relay-hook.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const reg = {
  _rows: { 't-alice': { handle: 'alice' }, 't-bob': { handle: 'bob' } },
  getByToken(t) { return this._rows[t]; },
};
const ZONE = 'mycelium.id';
const np = (token, { domains = [], subdomain = '', type = 'https' } = {}) => ({ user: { metas: { token } }, proxy_type: type, custom_domains: domains, subdomain });

const r1 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'] }), { zone: ZONE, bandwidthLimit: '2MB' });
rec('NA1. valid tenant binds own host → allow + bandwidth clamped server-side',
  r1.reject !== true && r1.content?.bandwidth_limit === '2MB' && r1.content?.bandwidth_limit_mode === 'server', '');

const r2 = authorizeNewProxy(reg, np('t-alice', { domains: ['bob.mycelium.id'] }), { zone: ZONE });
rec('NA2. tenant binding another tenant host → reject', r2.reject === true, r2.reject_reason);

const r3 = authorizeNewProxy(reg, np('t-nope', { domains: ['alice.mycelium.id'] }), { zone: ZONE });
const r3b = authorizeNewProxy(reg, np(undefined, { domains: ['alice.mycelium.id'] }), { zone: ZONE });
rec('NA3. unknown / missing token → reject', r3.reject === true && r3b.reject === true, `${r3.reject_reason} | ${r3b.reject_reason}`);

const r4 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], type: 'tcp' }), { zone: ZONE });
rec('NA4. non-https proxy type → reject', r4.reject === true, r4.reject_reason);

const r5a = authorizeNewProxy(reg, np('t-alice', { subdomain: 'bob' }), { zone: ZONE });
const r5b = authorizeNewProxy(reg, np('t-alice', { subdomain: 'alice' }), { zone: ZONE });
rec('NA5. subdomain mismatch → reject; matching subdomain → allow', r5a.reject === true && r5b.reject !== true, `mismatch=${r5a.reject} match=${r5b.reject !== true}`);

const l1 = authorizeLogin(reg, { metas: { token: 't-alice' } });
const l2 = authorizeLogin(reg, { metas: { token: 't-nope' } });
rec('NA6. Login: known token allow, unknown reject', l1.unchange === true && l2.reject === true, '');

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — per-tenant hostname binding enforced' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
