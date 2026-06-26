// verify:rest-realboot — boots startRestServer through the REAL (non-injected-keys)
// path and asserts the vault opens. This is the gate the injected-keys verify:rest
// CANNOT be: that gate passes userHex/systemHex as args (keysInjectedAtStart=true),
// which SKIPS the whole real-app block in completeBoot (drainer, schedulers,
// closeHandle). A scope bug in that block — e.g. `hwOllamaDaemon is not defined`,
// which broke every real boot on 2026-06-21 while verify:rest stayed green — is
// invisible to an injected-keys boot. Here keys come from env (MYCELIUM_KEY_SOURCE
// =env), so keysInjectedAtStart=false and the real block runs.
//   R1 real boot (env keys) → vault open, bootError null (no completeBoot throw)
//   R2 closeHandle runs clean (exercises the drainer/daemon .stop() teardown refs)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

process.env.MYCELIUM_KEY_SOURCE = 'env';
process.env.USER_MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.SYSTEM_KEY = crypto.randomBytes(32).toString('hex');
process.env.MYCELIUM_DISABLE_EMBED = '1';      // no :8091 dependency for a boot test
process.env.MYCELIUM_DISABLE_GENERATE = '1';   // no clustering child

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const DATA = mkdtempSync(join(tmpdir(), 'myc-realboot-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const cleanup = () => { try { rmSync(DATA, { recursive: true, force: true }); } catch {} };

const { startRestServer } = await import(new URL('../src/server-rest.js', import.meta.url));

let s = null, closeThrew = null;
try {
  // NO userHex/systemHex args → keysInjectedAtStart=false → the REAL completeBoot
  // block runs (drainer + schedulers + closeHandle wiring). This is the path that
  // injected-keys gates skip.
  s = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  const st = await fetch(`${s.url}/api/v1/account/status`).then((r) => r.json()).catch(() => ({}));
  rec('R1. real (env-keys) boot → vault open, no boot_failed',
    st.open === true && st.bootError == null,
    `open=${st.open} bootError=${st.bootError}`);
  const tools = await fetch(`${s.url}/api/v1/tools`).then((r) => r.status).catch(() => 0);
  rec('R1b. /api/v1/tools → 200 (vault truly serving)', tools === 200, `status=${tools}`);
} catch (e) {
  rec('R1. real (env-keys) boot did not throw', false, `threw: ${e.message}`);
} finally {
  try { await s?.close(); } catch (e) { closeThrew = e; }
}
rec('R2. closeHandle/teardown ran without throwing (daemon.stop etc. in scope)', closeThrew == null, closeThrew ? `threw: ${closeThrew.message}` : '');
cleanup();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — startRestServer boots the REAL non-injected path: vault opens, completeBoot wiring in scope, clean teardown' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
