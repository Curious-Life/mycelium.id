// verify:enrich-resilience — the enrich drainer's per-row failure handling, the
// fix for the "5,292 stuck / 2,380 wrongly-poisoned / 19 empty pending" backlog.
// Drives createEnrichmentService.drainOnce with a deterministic stub embedder +
// in-memory messages. Asserts each row lands in the RIGHT terminal state:
//   E1 empty/blank content → SKIPPED (nlp_processed=1), never embedded/poisoned/pending
//   E2 transient null vector (service blip) → LEFT PENDING (nlp_processed=0, no error) → retried later
//   E3 genuine wrong-dim array → POISONED (nlp_processed=-1, "expected 768")
//   E4 valid 768 vector → EMBEDDED (nlp_processed=2, embedding768 set)
//   E5 the null/transient row never gets the "object dims, expected 768" string
//      that the drainer self-heal skips forever (the stranded-2,380 bug)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import crypto from 'node:crypto';
import { createEnrichmentService } from '../src/enrich/service.js';
import { loadKey } from '../src/crypto/keys.js';
import { EMBED_DIM } from '../src/embed/client.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const masterKey = await loadKey(crypto.randomBytes(32).toString('hex'));

// In-memory messages namespace.
const store = new Map([
  ['empty',     { id: 'empty',     content: '   ',                                  scope: 'personal', nlp_processed: 0, embedding_768: null, nlp_error: null }],
  ['transient', { id: 'transient', content: 'a transient row about minds',          scope: 'personal', nlp_processed: 0, embedding_768: null, nlp_error: null }],
  ['wrongdim',  { id: 'wrongdim',  content: 'a wrongdim row about minds',           scope: 'personal', nlp_processed: 0, embedding_768: null, nlp_error: null }],
  ['valid',     { id: 'valid',     content: 'a valid row about minds and forests',  scope: 'personal', nlp_processed: 0, embedding_768: null, nlp_error: null }],
]);
const messages = {
  async selectPendingEnrichment() { return [...store.values()].filter((r) => r.nlp_processed === 0); },
  async updateEnrichment(id, _userId, patch) {
    const r = store.get(id); if (!r) return;
    if (patch.nlpProcessed !== undefined) r.nlp_processed = patch.nlpProcessed;
    if (patch.embedding768 !== undefined) r.embedding_768 = patch.embedding768;
    if (patch.nlpError !== undefined) r.nlp_error = patch.nlpError;
  },
  async selectPendingNlp() { return []; },
  async updateNlp() {},
};
// Stub embedder (per-row .embed only → exercises the null/wrong-dim path). No
// embedBatch → drainOnce uses Promise.all(embed()).
const embed = {
  async embed(content) {
    if (!content || !content.trim()) return null;            // empty (skipped before this matters)
    if (/transient/.test(content)) return null;              // transient failure → null vector
    if (/wrongdim/.test(content)) return [1, 2, 3];          // genuine wrong-size array
    return Array.from({ length: EMBED_DIM }, () => 0.01);    // valid 768-vector
  },
};

const svc = createEnrichmentService({ messages, embed, getMasterKey: async () => masterKey });
const res = await svc.drainOnce({ userId: 'u' });

const g = (id) => store.get(id);
rec('E1. empty content → SKIPPED (nlp_processed=1), no embedding, no error',
  g('empty').nlp_processed === 1 && g('empty').embedding_768 === null && g('empty').nlp_error === null,
  `state=${g('empty').nlp_processed}`);
rec('E2. transient null vector → LEFT PENDING (nlp_processed=0), no error → retryable',
  g('transient').nlp_processed === 0 && g('transient').nlp_error === null,
  `state=${g('transient').nlp_processed} err=${g('transient').nlp_error}`);
rec('E3. genuine wrong-dim → POISONED (nlp_processed=-1, "expected 768")',
  g('wrongdim').nlp_processed === -1 && /expected 768/.test(g('wrongdim').nlp_error || ''),
  `state=${g('wrongdim').nlp_processed} err=${(g('wrongdim').nlp_error || '').slice(0, 40)}`);
rec('E4. valid 768 vector → EMBEDDED (nlp_processed=2, embedding768 set)',
  g('valid').nlp_processed === 2 && typeof g('valid').embedding_768 === 'string' && g('valid').embedding_768.length > 0,
  `state=${g('valid').nlp_processed}`);
rec('E5. no transient row carries "object dims" (the string the self-heal skips forever)',
  !/object/.test(g('transient').nlp_error || '') && !/object/.test(g('wrongdim').nlp_error || ''),
  `counts=${JSON.stringify(res)}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — enrich drainer: empty→skip, transient→retry, wrong-dim→poison, valid→embed' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
