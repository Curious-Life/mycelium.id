// verify:managed-claim — the ACTION-BOUND ed25519 handle claim.
//   MC1 buildClaim(provision) → verifyWithPublicKey accepts (round-trip)
//   MC2 tampered handle/nonce/signature → rejected
//   MC3 a different master key → different publicKey + cross-verify fails
//   MC4 invalid handle / short nonce / unknown action → buildClaim throws
//   MC5 ACTION-CONFUSION blocked: a provision claim does NOT verify as a release
// Pure crypto; no network; CWD-independent. Never logs a secret.
import crypto from 'node:crypto';
import { buildClaim, claimMessage } from '../src/remote/managed-claim.js';
import { verifyWithPublicKey } from '../src/identity/identity.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const master = crypto.randomBytes(32).toString('hex');
const handle = 'alice';
const nonce = 'nonce-abcdef123456';

// MC1 — round-trip (provision)
const c = buildClaim({ action: 'provision', handle, nonce, masterHex: master });
const ok1 = verifyWithPublicKey(c.publicKey, claimMessage('provision', c.handle, c.nonce), c.signature);
rec('MC1. buildClaim(provision) → verifyWithPublicKey accepts', ok1 === true && c.action === 'provision' && c.handle === handle, `pubLen=${c.publicKey.length}`);

// MC2 — tamper
const tH = verifyWithPublicKey(c.publicKey, claimMessage('provision', 'bob', c.nonce), c.signature);
const tN = verifyWithPublicKey(c.publicKey, claimMessage('provision', c.handle, 'other-nonce'), c.signature);
const tS = verifyWithPublicKey(c.publicKey, claimMessage('provision', c.handle, c.nonce), `${c.signature.slice(0, -2)}AA`);
rec('MC2. tampered handle/nonce/signature rejected', tH === false && tN === false && tS === false, `h=${tH} n=${tN} s=${tS}`);

// MC3 — different master key
const c2 = buildClaim({ action: 'provision', handle, nonce, masterHex: crypto.randomBytes(32).toString('hex') });
const diffPub = c2.publicKey !== c.publicKey;
const crossReject = verifyWithPublicKey(c.publicKey, claimMessage('provision', handle, nonce), c2.signature) === false;
rec('MC3. different master key → different pubkey + cross-verify fails', diffPub && crossReject, `diffPub=${diffPub} crossReject=${crossReject}`);

// MC4 — invalid inputs throw
let badHandle = false; let badNonce = false; let badAction = false;
try { buildClaim({ action: 'provision', handle: '-bad', nonce, masterHex: master }); } catch { badHandle = true; }
try { buildClaim({ action: 'provision', handle, nonce: 'short', masterHex: master }); } catch { badNonce = true; }
try { buildClaim({ action: 'frobnicate', handle, nonce, masterHex: master }); } catch { badAction = true; }
rec('MC4. invalid handle / short nonce / unknown action → throws', badHandle && badNonce && badAction, `h=${badHandle} n=${badNonce} a=${badAction}`);

// MC5 — action-confusion blocked (the C1 regression)
const asRelease = verifyWithPublicKey(c.publicKey, claimMessage('release', handle, nonce), c.signature);
rec('MC5. a provision claim does NOT verify as a release (action-bound)', asRelease === false, `asRelease=${asRelease}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — claim signs + verifies, tamper-evident, action-bound' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
