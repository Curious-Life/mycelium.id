// verify:release-handle — best-effort managed-handle release for destroy/disconnect
// (src/remote/release-handle.js). NEVER throws; only acts on a managed handle.
//   L1 non-managed / unconfigured → {released:false}, no fetch
//   L2 managed + challenge ok → posts a signed 'release' claim to /v1/release → released
//   L3 challenge fails → {released:false}, no release POST
//   L4 network throw → caught, {released:false}
import { releaseManagedHandle } from '../src/remote/release-handle.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const MASTER = 'a'.repeat(64);
const managedEnv = { MYCELIUM_CONTROL_PLANE: 'https://cp.example', ENCRYPTION_MASTER_KEY: MASTER, MYCELIUM_REMOTE_MODE: 'managed', MYCELIUM_PUBLIC_HOST: 'alice.mycelium.id' };

// L1 not managed → no network, released:false
{
  let calls = 0;
  const r = await releaseManagedHandle({ env: { ...managedEnv, MYCELIUM_REMOTE_MODE: 'off' }, fetch: async () => { calls++; return { ok: true }; } });
  rec('L1 non-managed → no fetch, not released', r.released === false && calls === 0, `reason=${r.reason}`);
}

// L2 managed happy path → challenge then release POST
{
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push({ url, method: opts?.method || 'GET' });
    if (url.endsWith('/v1/challenge')) return { ok: true, json: async () => ({ nonce: 'nonce-abc123' }) };
    if (url.endsWith('/v1/release')) return { ok: true };
    return { ok: false };
  };
  const r = await releaseManagedHandle({ env: managedEnv, fetch });
  const postedRelease = seen.some((s) => s.url.endsWith('/v1/release') && s.method === 'POST');
  rec('L2 managed → challenge + signed release POST → released', r.released === true && postedRelease, JSON.stringify(seen));
}

// L3 challenge fails → no release POST
{
  const seen = [];
  const fetch = async (url) => { seen.push(url); return { ok: false }; };
  const r = await releaseManagedHandle({ env: managedEnv, fetch });
  rec('L3 challenge fails → no release POST, not released',
    r.released === false && !seen.some((u) => u.endsWith('/v1/release')));
}

// L4 network throw → caught
{
  const r = await releaseManagedHandle({ env: managedEnv, fetch: async () => { throw new Error('ECONNREFUSED'); } });
  rec('L4 network throw → caught, not released', r.released === false && typeof r.reason === 'string');
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — best-effort managed-handle release');
