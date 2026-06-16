// D-1 GATE harness (Phase 1 search-index design): measure recall@10 of the two
// candidate-generation methods on the REAL vault's decrypted 768-d embeddings,
// so we can choose 256-d matryoshka vs binary quantization with hard evidence
// instead of the synthetic numbers in spike/sqlite-vec-encrypted/bench2.mjs.
//
// READ-ONLY. Touches ONLY embedding_768 envelopes (never message content / text).
// Pure JS — no native modules. Reuses the app's real decrypt path (decryptVector).
//
// Run (operator, on the machine where the vault + key live):
//   MYCELIUM_DB="$HOME/Library/Application Support/id.mycelium.app/mycelium.db" \
//     node scripts/bench-search-recall.mjs --sample 6000 --queries 120
// Key source: resolveKeys() (Keychain), or set MYCELIUM_USER_HEX=<64-hex> to skip it.
//
// See docs/SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md §4, §9 (D-1), §11.
import Database from 'better-sqlite3';
import { webcrypto } from 'node:crypto';
import { resolveKeys } from '../src/crypto/key-source.js';
import { decryptVector } from '../src/search/ann/decode.js';
import { dbPath } from '../src/paths.js';
import { EMBED_DIM } from '../src/embed/client.js';

const subtle = webcrypto.subtle;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SAMPLE = parseInt(arg('--sample', '6000'), 10);
const NQ = parseInt(arg('--queries', '120'), 10);
const CAND256 = parseInt(arg('--cand256', '200'), 10);
const CANDBIN = parseInt(arg('--candbin', '400'), 10);
const PASS = parseFloat(arg('--pass', '95'));
const DBP = process.env.MYCELIUM_DB || dbPath();

const userHex = process.env.MYCELIUM_USER_HEX || resolveKeys().userHex;
if (!/^[0-9a-fA-F]{64}$/.test(userHex || '')) { console.error('No valid 64-hex master key (resolveKeys/MYCELIUM_USER_HEX).'); process.exit(2); }
const masterKey = await subtle.importKey('raw', Buffer.from(userHex, 'hex'), 'HKDF', false, ['deriveBits', 'deriveKey']);

console.log(`Reading ${SAMPLE} embeddings (read-only) from ${DBP} ...`);
const db = new Database(DBP, { readonly: true, fileMustExist: true });
const rows = db.prepare(
  `SELECT id, embedding_768 FROM messages
   WHERE embedding_768 IS NOT NULL AND content IS NOT NULL AND content != '' AND forgotten_at IS NULL
   LIMIT ?`).all(SAMPLE);
db.close();

const vecs = []; let failed = 0;
for (const r of rows) {
  try { vecs.push(await decryptVector(r.embedding_768, masterKey, null, EMBED_DIM)); } catch { failed++; }
}
const V = vecs.length;
if (V < 300) { console.error(`Only ${V} vectors decrypted (failed ${failed}) — wrong key, or too few embedded messages.`); process.exit(1); }

// unit-normalize 768; matryoshka 256 = first-256 prefix renormalized; binary = sign bits packed (matches sqlite-vec vec_quantize_binary: bit = x > 0)
const l2 = (a, d = a.length) => { let n = 0; for (let i = 0; i < d; i++) n += a[i] * a[i]; return Math.sqrt(n) || 1; };
const full = vecs.map((a) => { const n = l2(a); const b = new Float32Array(768); for (let i = 0; i < 768; i++) b[i] = a[i] / n; return b; });
const t256 = full.map((a) => { const n = l2(a, 256); const b = new Float32Array(256); for (let i = 0; i < 256; i++) b[i] = a[i] / n; return b; });
const bits = full.map((a) => { const u = new Uint8Array(96); for (let i = 0; i < 768; i++) if (a[i] > 0) u[i >> 3] |= (1 << (i & 7)); return u; });

const dot = (a, b, d = a.length) => { let s = 0; for (let i = 0; i < d; i++) s += a[i] * b[i]; return s; };
const POP = new Uint8Array(256); for (let i = 0; i < 256; i++) { let c = 0, x = i; while (x) { c += x & 1; x >>= 1; } POP[i] = c; }
const ham = (a, b) => { let d = 0; for (let i = 0; i < 96; i++) d += POP[a[i] ^ b[i]]; return d; };
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

const qidx = Array.from({ length: Math.min(NQ, V) }, (_, i) => Math.floor(i * V / Math.min(NQ, V)));
// ground truth: full-768 cosine top-10 (exclude self)
const truth = qidx.map((qi) => {
  const q = full[qi]; const s = [];
  for (let j = 0; j < V; j++) { if (j === qi) continue; s.push([j, dot(q, full[j])]); }
  s.sort((a, b) => b[1] - a[1]); return new Set(s.slice(0, 10).map((x) => x[0]));
});

function evalMethod(candFn) {
  let rs = 0; const ts = [];
  for (let t = 0; t < qidx.length; t++) {
    const qi = qidx[t]; const a = now();
    const cand = candFn(qi);
    const q = full[qi];
    const top = cand.filter((j) => j !== qi).map((j) => [j, dot(q, full[j])]).sort((x, y) => y[1] - x[1]).slice(0, 10).map((x) => x[0]);
    ts.push(now() - a);
    rs += top.filter((j) => truth[t].has(j)).length / 10;
  }
  ts.sort((x, y) => x - y);
  return { recall: rs / qidx.length * 100, p95: ts[Math.floor(ts.length * 0.95)] };
}

const m256 = evalMethod((qi) => { const q = t256[qi]; const s = []; for (let j = 0; j < V; j++) { if (j === qi) continue; s.push([j, dot(q, t256[j], 256)]); } s.sort((a, b) => b[1] - a[1]); return s.slice(0, CAND256).map((x) => x[0]); });
const mbin = evalMethod((qi) => { const q = bits[qi]; const s = []; for (let j = 0; j < V; j++) { if (j === qi) continue; s.push([j, ham(q, bits[j])]); } s.sort((a, b) => a[1] - b[1]); return s.slice(0, CANDBIN).map((x) => x[0]); });

console.log(`\nD-1 recall@10 on REAL embeddings — ${V} vectors, ${qidx.length} queries (decrypt-failed ${failed})`);
console.log(`  256-d matryoshka top-${CAND256} → rescore 768 : recall@10=${m256.recall.toFixed(1)}%   (JS p95=${m256.p95.toFixed(1)}ms)`);
console.log(`  binary hamming  top-${CANDBIN} → rescore 768 : recall@10=${mbin.recall.toFixed(1)}%   (JS p95=${mbin.p95.toFixed(1)}ms)`);
console.log(`  (JS latency indicative only; real C-engine latency is in spike/sqlite-vec-encrypted/bench2.mjs)`);
console.log('='.repeat(74));
const pick = mbin.recall >= PASS ? 'BINARY — fastest, recall holds on real data'
  : m256.recall >= PASS ? '256-d MATRYOSHKA — binary recall too low on real data'
  : `NEITHER ≥${PASS}% — raise --cand256/--candbin, or reconsider the approach`;
console.log(`D-1 verdict (≥${PASS}% recall@10):  256d=${m256.recall >= PASS ? 'PASS' : 'fail'}  binary=${mbin.recall >= PASS ? 'PASS' : 'fail'}  →  ${pick}`);
console.log('='.repeat(74));
process.exit(m256.recall >= PASS || mbin.recall >= PASS ? 0 : 1);
