// Encrypted blob-store verifier (uploads Step 3, in isolation — no HTTP yet).
//   BL1 round-trip — putBlob then getBlob returns the EXACT original bytes
//   BL2 ciphertext-at-rest — the on-disk file is a magic-prefixed envelope,
//       and the raw plaintext bytes do NOT appear in it
//   BL3 binary-safe — a non-UTF8 byte buffer survives the round-trip
//   BL4 fail-closed — with no master key, putBlob refuses (no plaintext written)
import { rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const ROOT = 'data/verify-blob';
const ledger = [];
const rec = (n, pass, d) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

try { rmSync(ROOT, { recursive: true }); } catch {}
mkdirSync(ROOT, { recursive: true });

// Pin a master key the way boot() does (ENCRYPTION_MASTER_KEY → getMasterKey()).
const hex = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_MASTER_KEY = hex;
// import dynamically so the env var is set before the module pins the key
const { putBlob, getBlob } = await import('../src/ingest/blob-store.js');

// BL1 + BL2: text payload round-trip + ciphertext-at-rest
const secret = Buffer.from('TOP-SECRET upload payload — must never sit in plaintext on disk');
const { path } = await putBlob(secret, { userId: 'local-user', ext: '.txt', root: ROOT });
const back = await getBlob(path, { root: ROOT });
rec('BL1. putBlob → getBlob returns the exact original bytes', Buffer.compare(secret, back) === 0,
  `roundtrip=${Buffer.compare(secret, back) === 0} size=${back.length}`);

{
  const onDisk = readFileSync(`${ROOT}/${path}`);
  const magicOk = onDisk.subarray(0, 4).toString('latin1') === 'MYCB';
  const leaks = onDisk.includes(secret); // raw plaintext bytes present?
  rec('BL2. ciphertext-at-rest (magic-prefixed envelope, no plaintext on disk)',
    magicOk && !leaks, `magic=${magicOk} leaksPlaintext=${leaks}`);
}

// BL3: binary-safe (bytes that aren't valid UTF-8)
const bin = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80, 0x7f, 0x00, 0xc3, 0x28]);
const { path: binPath } = await putBlob(bin, { userId: 'local-user', ext: '.bin', root: ROOT });
const binBack = await getBlob(binPath, { root: ROOT });
rec('BL3. binary-safe round-trip (non-UTF8 bytes preserved)', Buffer.compare(bin, binBack) === 0,
  `roundtrip=${Buffer.compare(bin, binBack) === 0}`);

// BL4: fail-closed — no key ⇒ refuse, and nothing written
{
  // reset the module's pinned key by clearing + re-importing in a child-like way:
  // simplest honest check — call with the key cleared via resetMasterKey if available.
  const mod = await import('../src/crypto/crypto-local.js');
  const before = countFiles(ROOT);
  let err = null;
  if (typeof mod.resetMasterKey === 'function' && typeof mod._resetMasterKeyForTesting === 'function') {
    mod._resetMasterKeyForTesting();
    delete process.env.ENCRYPTION_MASTER_KEY;
    err = await threw(() => putBlob(Buffer.from('should-refuse'), { userId: 'local-user', root: ROOT }));
    // restore for cleanliness
    process.env.ENCRYPTION_MASTER_KEY = hex;
  }
  const after = countFiles(ROOT);
  const refused = err !== null;
  rec('BL4. fail-closed — no key ⇒ putBlob refuses, no file written',
    refused && after === before,
    refused ? `threw: ${err.message.slice(0, 50)}; files unchanged=${after === before}` : 'DID NOT REFUSE (BAD) — or reset helper unavailable');
}

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(`${dir}/${e.name}`);
    else n += 1;
  }
  return n;
}

void importMasterKey; void existsSync;
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — encrypted blob store round-trips, encrypts at rest, fails closed' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
