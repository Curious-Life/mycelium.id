// verify:transport-chooser — the P3b capability discovery + routing decision.
//   C1  buildDidDocument advertises a #relay-inbox service → resolveRelayInbox round-trips it
//   C2  no relayInbox arg → no #relay-inbox service → resolveRelayInbox returns null
//   C3  planDelivery: inbox + keyAgreement present → { kind:'relay', inbox, keyAgreementPubB64 }
//   C4  planDelivery: inbox but NO keyAgreement → 'direct' (can't seal)
//   C5  planDelivery: no inbox → 'direct'
//   C6  planDelivery: a resolver throws → 'direct' (fail-closed)
//   C7  resolveRelayInbox fail-closed: non-https endpoint → null; doc.id mismatch → null
//   C8  resolveRelayInbox SSRF: a private-host did → null (never even fetched)
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { buildDidDocument, resolveRelayInbox } from '../src/federation/did.js';
import { planDelivery } from '../src/federation/transport-chooser.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// resolveRelayInbox fetches https://<host>/.well-known/did.json via safeFetch. Inject a
// fetch that returns a given doc + a lookup that maps the host to a PUBLIC IP (so the
// SSRF resolve-and-validate guard passes and the injected fetch is used).
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const serve = (doc) => async () => ({ ok: true, async json() { return doc; } });

const PK = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMDE'; // 32-ish bytes b64url (multibase-encodable)
const KA = 'a2V5YWdyZWVtZW50a2V5YWdyZWVtZW50MDE';
const RELAY = 'https://connect.mycelium.id:8443';

try {
  // C1 — advertise + resolve round-trip
  const doc = buildDidDocument('alice.mycelium.id', PK, null, KA, RELAY);
  const hasSvc = (doc.service || []).some((s) => s.id === 'did:web:alice.mycelium.id#relay-inbox' && s.type === 'MyceliumRelayInbox' && s.serviceEndpoint === RELAY);
  const got = await resolveRelayInbox('did:web:alice.mycelium.id', { fetch: serve(doc), lookup: publicLookup });
  rec('C1. buildDidDocument advertises #relay-inbox; resolveRelayInbox round-trips it', hasSvc && got === RELAY, `svc=${hasSvc} resolved=${got}`);

  // C2 — no relayInbox → no service → null
  const docNo = buildDidDocument('bob.mycelium.id', PK, null, KA); // no 5th arg
  const svcNo = (docNo.service || []).some((s) => /#relay-inbox$/.test(s.id));
  const gotNo = await resolveRelayInbox('did:web:bob.mycelium.id', { fetch: serve(docNo), lookup: publicLookup });
  rec('C2. no relayInbox arg → no service; resolveRelayInbox → null', !svcNo && gotNo === null, `svc=${svcNo} resolved=${gotNo}`);

  // C3 — planDelivery relay
  const p3 = await planDelivery('did:web:alice.mycelium.id', { resolveRelayInbox: async () => RELAY, resolveKeyAgreement: async () => KA });
  rec('C3. inbox + keyAgreement → relay', p3.kind === 'relay' && p3.inbox === RELAY && p3.keyAgreementPubB64 === KA, `kind=${p3.kind}`);

  // C4 — inbox but no keyAgreement → direct
  const p4 = await planDelivery('did:web:x', { resolveRelayInbox: async () => RELAY, resolveKeyAgreement: async () => null });
  rec('C4. inbox but no keyAgreement → direct (can\'t seal)', p4.kind === 'direct', `kind=${p4.kind}`);

  // C5 — no inbox → direct
  const p5 = await planDelivery('did:web:x', { resolveRelayInbox: async () => null, resolveKeyAgreement: async () => KA });
  rec('C5. no inbox → direct', p5.kind === 'direct', `kind=${p5.kind}`);

  // C6 — resolver throws → direct (fail-closed)
  const p6 = await planDelivery('did:web:x', { resolveRelayInbox: async () => { throw new Error('boom'); }, resolveKeyAgreement: async () => KA });
  rec('C6. resolver throws → direct (fail-closed)', p6.kind === 'direct', `kind=${p6.kind}`);

  // C7 — resolveRelayInbox fail-closed on a non-https endpoint + on doc.id mismatch
  const badEp = buildDidDocument('c.mycelium.id', PK, null, KA); badEp.service.push({ id: 'did:web:c.mycelium.id#relay-inbox', type: 'MyceliumRelayInbox', serviceEndpoint: 'http://insecure.example' });
  const nonHttps = await resolveRelayInbox('did:web:c.mycelium.id', { fetch: serve(badEp), lookup: publicLookup });
  const confused = await resolveRelayInbox('did:web:d.mycelium.id', { fetch: serve(buildDidDocument('alice.mycelium.id', PK, null, KA, RELAY)), lookup: publicLookup }); // doc.id != requested did
  rec('C7. non-https endpoint → null; doc.id mismatch → null (fail-closed)', nonHttps === null && confused === null, `nonHttps=${nonHttps} confused=${confused}`);

  // C8 — SSRF: a private-host did is never fetched
  let fetched = false;
  const priv = await resolveRelayInbox('did:web:localhost', { fetch: async () => { fetched = true; return { ok: true, json: async () => ({}) }; }, lookup: publicLookup });
  rec('C8. private-host did → null, never fetched (SSRF)', priv === null && !fetched, `resolved=${priv} fetched=${fetched}`);

  // C9 — DEFENSE IN DEPTH: a peer advertising an internal-IP enqueue endpoint → null
  // (the endpoint host is validated, not just the scheme; safeFetch is the second layer).
  for (const badHost of ['https://169.254.169.254/enqueue', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://evil.local/x']) {
    const d = buildDidDocument('e.mycelium.id', PK, null, KA);
    d.service.push({ id: 'did:web:e.mycelium.id#relay-inbox', type: 'MyceliumRelayInbox', serviceEndpoint: badHost });
    const r = await resolveRelayInbox('did:web:e.mycelium.id', { fetch: serve(d), lookup: publicLookup });
    if (r !== null) { rec(`C9. internal/private enqueue endpoint rejected (${badHost})`, false, `resolved=${r}`); break; }
    if (badHost === 'https://evil.local/x') rec('C9. internal/private enqueue endpoints (IP + .local) all rejected → null', true);
  }

  // C10 — chooser shape hardening: a non-https / non-string inbox → direct, never relay
  const p10a = await planDelivery('did:web:x', { resolveRelayInbox: async () => 'ftp://nope', resolveKeyAgreement: async () => KA });
  const p10b = await planDelivery('did:web:x', { resolveRelayInbox: async () => RELAY, resolveKeyAgreement: async () => 12345 });
  rec('C10. non-https inbox or non-string seal key → direct (shape hardening)', p10a.kind === 'direct' && p10b.kind === 'direct', `a=${p10a.kind} b=${p10b.kind}`);
} catch (e) {
  rec('FATAL', false, String(e && e.stack || e));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — capability discovery + chooser: advertise/resolve #relay-inbox, relay-vs-direct decision, fail-closed, SSRF-guarded' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
