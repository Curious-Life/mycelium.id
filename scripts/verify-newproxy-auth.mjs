// verify:newproxy-auth — the frps Login/NewProxy/CloseProxy/Ping auth-hook.
//   NA1 valid tenant binds own host → allow (+ bandwidth clamped)
//   NA2 tenant binding ANOTHER tenant's host → reject
//   NA3 unknown / missing token → reject
//   NA4 non-https proxy type → reject
//   NA5 subdomain mismatch → reject; matching subdomain → allow
//   NA6 Login: known token allow, unknown reject
//   NA7 single-active: a SECOND concurrent run_id for the same handle → reject
//   NA8 clean reconnect: CloseProxy(run A) clears → NewProxy(run B) allowed
//   NA9 crash: a stale active slot past the TTL → NewProxy(run B) allowed
//   NA10 stale CloseProxy(run A) does NOT clear the active run B (compare-and-clear)
// Pure functions over a fake registry; controllable clock; no network.
import { authorizeNewProxy, authorizeLogin, authorizeCloseProxy } from '../mycelium-managed/src/relay-hook.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const ZONE = 'mycelium.id';
let active = {}; // handle → { runId, at }
const reg = {
  _rows: { 't-alice': { handle: 'alice' }, 't-bob': { handle: 'bob' } },
  _ent: { alice: null, bob: null }, // handle → paid_until (ms) | null
  getByToken(t) { return this._rows[t]; },
  getActiveProxy(h) { return active[h] || { runId: null, at: 0 }; },
  setActiveProxy(h, runId, at) { active[h] = { runId, at }; },
  refreshActiveProxy(h, runId, at) { if (active[h]?.runId === runId) active[h].at = at; },
  clearActiveProxyIf(h, runId) { if (active[h]?.runId === runId) delete active[h]; },
  // Mirrors registry.isEntitled: fail-closed (no paid_until → false); grace added.
  isEntitled(h, now, graceMs = 0) { const p = this._ent[h]; return p != null && now < Number(p) + graceMs; },
};
const np = (token, { domains = [], subdomain = '', type = 'https', runId = 'rA' } = {}) =>
  ({ user: { metas: { token }, run_id: runId }, proxy_type: type, custom_domains: domains, subdomain });
const NOW = 1_000_000;
const opts = (ms) => ({ now: () => ms, zone: ZONE, bandwidthLimit: '2MB', activeTtlMs: 300000 });

// ── NA1–6: host binding (all run_id 'rA') ──
const r1 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'] }), opts(NOW));
rec('NA1. valid tenant binds own host → allow + bandwidth clamped',
  r1.reject !== true && r1.content?.bandwidth_limit === '2MB' && r1.content?.bandwidth_limit_mode === 'server', '');
const r2 = authorizeNewProxy(reg, np('t-alice', { domains: ['bob.mycelium.id'] }), opts(NOW));
rec('NA2. tenant binding another tenant host → reject', r2.reject === true, r2.reject_reason);
const r3 = authorizeNewProxy(reg, np('t-nope', { domains: ['alice.mycelium.id'] }), opts(NOW));
const r3b = authorizeNewProxy(reg, np(undefined, { domains: ['alice.mycelium.id'] }), opts(NOW));
rec('NA3. unknown / missing token → reject', r3.reject === true && r3b.reject === true, `${r3.reject_reason} | ${r3b.reject_reason}`);
const r4 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], type: 'tcp' }), opts(NOW));
rec('NA4. non-https proxy type → reject', r4.reject === true, r4.reject_reason);
const r5a = authorizeNewProxy(reg, np('t-alice', { subdomain: 'bob' }), opts(NOW));
const r5b = authorizeNewProxy(reg, np('t-alice', { subdomain: 'alice' }), opts(NOW));
rec('NA5. subdomain mismatch → reject; matching subdomain → allow', r5a.reject === true && r5b.reject !== true, `mismatch=${r5a.reject} match=${r5b.reject !== true}`);
rec('NA6. Login: known token allow, unknown reject',
  authorizeLogin(reg, { metas: { token: 't-alice' } }).unchange === true && authorizeLogin(reg, { metas: { token: 't-nope' } }).reject === true, '');

// ── NA7–10: single-active-proxy (fresh slate each) ──
active = {};
authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], runId: 'rA' }), opts(NOW));
const na7 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], runId: 'rB' }), opts(NOW + 1000));
rec('NA7. second concurrent run_id for the same handle → reject', na7.reject === true, na7.reject_reason);

active = {};
authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], runId: 'rA' }), opts(NOW));
authorizeCloseProxy(reg, np('t-alice', { runId: 'rA' }));
const na8 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], runId: 'rB' }), opts(NOW + 2000));
rec('NA8. clean reconnect (CloseProxy clears) → new run allowed', na8.reject !== true && active.alice?.runId === 'rB', `active=${active.alice?.runId}`);

active = { alice: { runId: 'rA', at: NOW } };
const na9 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'], runId: 'rB' }), opts(NOW + 400000)); // > 300s TTL
rec('NA9. crash (stale slot past TTL) → new run allowed', na9.reject !== true && active.alice?.runId === 'rB', `active=${active.alice?.runId}`);

active = { alice: { runId: 'rB', at: NOW } };
authorizeCloseProxy(reg, np('t-alice', { runId: 'rA' })); // stale close
rec('NA10. stale CloseProxy(run A) does NOT clear the active run B', active.alice?.runId === 'rB', `active=${active.alice?.runId}`);

// ── NA11–14: lapsed-subscription gate (O6) ──
// Entitlement is enforced ONLY when requireEntitlement is set (billing on).
const optsEnt = (ms, graceMs = 0) => ({ now: () => ms, zone: ZONE, bandwidthLimit: '2MB', activeTtlMs: 300000, requireEntitlement: true, graceMs });
active = {}; reg._ent.alice = null;
// NA11 — billing OFF (default opts): an unentitled handle is still allowed (free self-host).
const na11 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'] }), opts(NOW));
rec('NA11. requireEntitlement off → unentitled handle still allowed (free self-host)', na11.reject !== true, '');

// NA12 — billing ON + paid (paid_until in the future) → allow.
active = {}; reg._ent.alice = NOW + 100000;
const na12 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'] }), optsEnt(NOW));
rec('NA12. requireEntitlement on + paid → allow', na12.reject !== true, na12.reject_reason || 'allowed');

// NA13 — billing ON + lapsed past grace → reject 'subscription required'.
active = {}; reg._ent.alice = NOW - 100000;
const na13 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'] }), optsEnt(NOW, 0));
rec('NA13. requireEntitlement on + lapsed (past grace) → reject subscription required',
  na13.reject === true && na13.reject_reason === 'subscription required', na13.reject_reason);

// NA14 — billing ON + lapsed but WITHIN grace → allow (absorbs Stripe dunning).
active = {}; reg._ent.alice = NOW - 1000;
const na14 = authorizeNewProxy(reg, np('t-alice', { domains: ['alice.mycelium.id'] }), optsEnt(NOW, 5000));
rec('NA14. requireEntitlement on + lapsed but within grace → allow', na14.reject !== true, na14.reject_reason || 'allowed');

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — host binding + single-active-proxy + lapsed-subscription gate enforced' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
