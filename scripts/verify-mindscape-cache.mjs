// verify:mindscape-cache — the SWR cache that stops `GET /portal/mindscape` from
// re-running a full decrypting scan of the clustering-point corpus on every open.
//   C1 repeat reads within TTL → ONE compute (cached)
//   C2 concurrent reads → ONE compute (single-flight latch)
//   C3 bust(userId) → next read recomputes
//   C4 per-user keying (one user's entry is independent of another's)
//   C5 a bust racing an in-flight compute bars that compute from writing back
//      stale data (generation guard) → next read recomputes
//   C6 wiring: handler reads via getMindscapeCached; bust fires on job
//      completion + chronicle + all three clustering_points delete paths
import { readFileSync } from 'node:fs';
import { getMindscapeCached, bustMindscape } from '../src/mindscape-cache.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── C1: cached within TTL ──
bustMindscape();
let calls = 0;
const compute = async () => { calls += 1; return `v${calls}`; };
const a1 = await getMindscapeCached('u', compute);
const a2 = await getMindscapeCached('u', compute);
rec('C1. repeat reads within TTL → one compute', calls === 1 && a1 === 'v1' && a2 === 'v1', `calls=${calls}`);

// ── C2: single-flight ──
bustMindscape();
calls = 0;
const [x, y] = await Promise.all([getMindscapeCached('u', compute), getMindscapeCached('u', compute)]);
rec('C2. concurrent reads → one compute (single-flight)', calls === 1 && x === y, `calls=${calls}`);

// ── C3: explicit bust recomputes ──
bustMindscape();
calls = 0;
const b1 = await getMindscapeCached('u', compute);
bustMindscape('u');
const b2 = await getMindscapeCached('u', compute);
rec('C3. bust(userId) → recompute', calls === 2 && b1 === 'v1' && b2 === 'v2', `calls=${calls}`);

// ── C4: per-user keying ──
bustMindscape();
calls = 0;
await getMindscapeCached('A', compute);     // calls=1
await getMindscapeCached('B', compute);     // calls=2 (own entry)
await getMindscapeCached('A', compute);     // cached → no recompute
rec('C4. cache is keyed per-user', calls === 2, `calls=${calls}`);

// ── C5: bust racing an in-flight compute bars stale write-back ──
bustMindscape();
let n = 0;
let release;
const gate = new Promise((r) => { release = r; });
const slow = async () => { n += 1; await gate; return `s${n}`; };
const p = getMindscapeCached('u', slow);    // starts compute (n=1), awaits gate
bustMindscape('u');                          // bump generation mid-flight
release();
const first = await p;                        // resolves to s1 but must NOT cache it
const second = await getMindscapeCached('u', slow); // must recompute → n=2
rec('C5. bust during in-flight compute bars stale write-back', n === 2 && first === 's1' && second === 's2', `n=${n}`);

// ── C6: static wiring ──
const ms = readFileSync('src/portal-mindscape.js', 'utf8');
rec('C6a. handler serves via getMindscapeCached', /getMindscapeCached\(userId,/.test(ms));
const jobs = readFileSync('src/jobs.js', 'utf8');
rec('C6b. job completion + chronicle bust the cache', (jobs.match(/bustMindscape\(userId\)/g) || []).length >= 2);
const msgs = readFileSync('src/db/messages.js', 'utf8');
rec('C6c. message forget + edit bust the cache', (msgs.match(/bustMindscape\(userId\)/g) || []).length >= 2);
const docs = readFileSync('src/db/documents.js', 'utf8');
rec('C6d. document delete busts the cache', /bustMindscape\(userId\)/.test(docs));

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — mindscape aggregate is SWR-cached and busts on every source mutation' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
