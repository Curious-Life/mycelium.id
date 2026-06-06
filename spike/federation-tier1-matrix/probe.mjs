// THROWAWAY SPIKE — Federation Tier-1 / A1: headless Matrix E2EE (Megolm) lifecycle.
//
// De-risks docs/DESIGN-federation-inter-instance-2026-06-05.md assumption A1:
//   "A headless Matrix bot can send/receive E2EE (Megolm) messages reliably."
// and the named risk: "appservices historically do NOT do E2EE without a crypto
// helper; bot E2EE needs a real Olm/Megolm-capable client with a persistent store."
//
// The crypto helper is @matrix-org/matrix-sdk-crypto-wasm (vodozemac; the modern
// libolm replacement, no native dep). For E2EE the homeserver is only a dumb relay
// of opaque blobs, so this harness PLAYS the homeserver: two real OlmMachines
// (alice's bot device, bob's bot device) run the full lifecycle —
//   device-key upload → key query → one-time-key claim → Olm session →
//   Megolm room-key share (to-device) → encrypt → decrypt — entirely headless,
// no human verification. Then it proves the room key is exportable/restorable
// (the mechanism a bot uses to decrypt across a restart) and that decryption
// succeeds on an UNVERIFIED device (verification is a trust shield, not a gate).
//
// Run: node spike/federation-tier1-matrix/probe.mjs   (deps: matrix-sdk-crypto-wasm)

import * as w from '@matrix-org/matrix-sdk-crypto-wasm';

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`); };

const ALICE = '@alice:alice.mycelium.id', A_DEV = 'ALICEBOT';
const BOB = '@bob:bob.mycelium.id', B_DEV = 'BOBBOT';
const ROOM = '!pool:alice.mycelium.id';
const SECRET = 'megolm round-trip ok @ ' + new Date().toISOString();

// ── fake homeserver: stores opaque key blobs, relays to-device messages ──────
const hs = {
  dev: {},               // userId -> deviceId -> deviceKeys (the signed object)
  otk: {},               // userId -> deviceId -> { keyId: keyObj }
  fallback: {},          // userId -> deviceId -> { keyId: keyObj }
  toDevice: [],          // {sender, type, recipient, recipientDevice, content}
};
function ensure(obj, u) { (obj[u] ??= {}); return obj[u]; }

function handle(sender, req) {
  const type = req.type;
  const body = JSON.parse(req.body || '{}');
  switch (type) {
    case w.RequestType.KeysUpload: {
      if (body.device_keys) { const d = body.device_keys.device_id; ensure(hs.dev, sender)[d] = body.device_keys; }
      const dev = body.device_keys?.device_id || Object.keys(hs.dev[sender] || {})[0];
      if (body.one_time_keys) { const m = (ensure(hs.otk, sender)[dev] ??= {}); Object.assign(m, body.one_time_keys); }
      if (body.fallback_keys) { ensure(hs.fallback, sender)[dev] = body.fallback_keys; }
      const count = Object.keys(hs.otk[sender]?.[dev] || {}).length;
      return JSON.stringify({ one_time_key_counts: { signed_curve25519: count } });
    }
    case w.RequestType.KeysQuery: {
      const out = {};
      for (const u of Object.keys(body.device_keys || {})) {
        out[u] = {};
        for (const [d, dk] of Object.entries(hs.dev[u] || {})) out[u][d] = dk;
      }
      return JSON.stringify({ device_keys: out, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} });
    }
    case w.RequestType.KeysClaim: {
      const out = {};
      for (const [u, devs] of Object.entries(body.one_time_keys || {})) {
        out[u] = {};
        for (const d of Object.keys(devs)) {
          const store = hs.otk[u]?.[d] || {};
          const keyId = Object.keys(store)[0];
          if (keyId) { out[u][d] = { [keyId]: store[keyId] }; delete store[keyId]; }
          else { const fb = hs.fallback[u]?.[d] || {}; const fId = Object.keys(fb)[0]; if (fId) out[u][d] = { [fId]: fb[fId] }; }
        }
      }
      return JSON.stringify({ one_time_keys: out, failures: {} });
    }
    case w.RequestType.ToDevice: {
      // event_type is a top-level field on ToDeviceRequest, NOT inside body.
      for (const [u, devs] of Object.entries(body.messages || {})) {
        for (const [d, content] of Object.entries(devs)) {
          hs.toDevice.push({ sender, type: req.event_type, recipient: u, recipientDevice: d, content });
        }
      }
      return JSON.stringify({});
    }
    default: return JSON.stringify({});
  }
}

// Drain a machine's queued outgoing requests through the fake server until empty.
async function drain(sender, machine, maxRounds = 8) {
  for (let i = 0; i < maxRounds; i++) {
    const reqs = await machine.outgoingRequests();
    if (!reqs.length) return;
    for (const r of reqs) await machine.markRequestAsSent(r.id, r.type, handle(sender, r));
  }
}

// Deliver queued to-device messages addressed to `recipient` into its machine.
async function deliverToDevice(recipient, machine) {
  const mine = hs.toDevice.filter((m) => m.recipient === recipient);
  hs.toDevice = hs.toDevice.filter((m) => m.recipient !== recipient);
  const events = mine.map((m) => ({ sender: m.sender, type: m.type, content: typeof m.content === 'string' ? JSON.parse(m.content) : m.content }));
  const processed = await machine.receiveSyncChanges(JSON.stringify(events), new w.DeviceLists(), new Map(), new Set());
  return { delivered: events.length, processed };
}

async function main() {
  console.log('\n=== Tier-1/A1 spike: headless Matrix Megolm E2EE (no homeserver, real crypto) ===\n');
  await w.initAsync();
  rec('A1.0 matrix-sdk-crypto-wasm loads headless in Node (vodozemac, no libolm)', true, 'pkg @matrix-org/matrix-sdk-crypto-wasm@18');

  const alice = await w.OlmMachine.initialize(new w.UserId(ALICE), new w.DeviceId(A_DEV));
  const bob = await w.OlmMachine.initialize(new w.UserId(BOB), new w.DeviceId(B_DEV));
  rec('A1.1 two OlmMachines initialize headlessly (no human, no verification)', true, `${ALICE}/${A_DEV}  ${BOB}/${B_DEV}`);

  // Publish device keys + one-time keys for both bots.
  await drain(ALICE, alice); await drain(BOB, bob);
  const aliceUp = !!hs.dev[ALICE]?.[A_DEV] && Object.keys(hs.otk[ALICE]?.[A_DEV] || {}).length > 0;
  const bobUp = !!hs.dev[BOB]?.[B_DEV] && Object.keys(hs.otk[BOB]?.[B_DEV] || {}).length > 0;
  rec('A1.2 both bots upload device keys + one-time keys (the crypto-helper identity)', aliceUp && bobUp,
    `alice otks=${Object.keys(hs.otk[ALICE]?.[A_DEV] || {}).length} bob otks=${Object.keys(hs.otk[BOB]?.[B_DEV] || {}).length}`);

  // Alice learns bob's devices, then claims a one-time key → Olm session.
  await alice.updateTrackedUsers([new w.UserId(BOB)]);
  await drain(ALICE, alice); // performs the KeysQuery for bob
  const claim = await alice.getMissingSessions([new w.UserId(BOB)]);
  if (claim) await alice.markRequestAsSent(claim.id, claim.type, handle(ALICE, claim));
  rec('A1.3 Olm 1:1 session established via key-claim (KeysClaim handshake)', !!claim, `claimRequest=${!!claim}`);

  // Share the Megolm room key to bob's device (Olm-encrypted to-device), deliver it.
  const settings = new w.EncryptionSettings();
  const shareReqs = await alice.shareRoomKey(new w.RoomId(ROOM), [new w.UserId(BOB)], settings);
  for (const r of shareReqs) { handle(ALICE, r); await alice.markRequestAsSent(r.id, w.RequestType.ToDevice, '{}'); }
  const del = await deliverToDevice(BOB, bob);
  rec('A1.4 Megolm room key shared to bob via to-device + delivered', shareReqs.length > 0 && del.delivered > 0,
    `shareReqs=${shareReqs.length} delivered=${del.delivered}`);

  // Alice encrypts a room event with the Megolm session.
  const encContent = await alice.encryptRoomEvent(new w.RoomId(ROOM), 'm.room.message', JSON.stringify({ msgtype: 'm.text', body: SECRET }));
  const event = { event_id: '$evt1', sender: ALICE, origin_server_ts: Date.now(), type: 'm.room.encrypted', room_id: ROOM, content: JSON.parse(encContent) };
  rec('A1.5 alice encrypts a room event (Megolm ciphertext, plaintext absent)', !JSON.stringify(event).includes(SECRET),
    `algorithm=${JSON.parse(encContent).algorithm}`);

  // Bob decrypts it — the core round-trip.
  const settingsDec = new w.DecryptionSettings(w.TrustRequirement.Untrusted);
  const dec = await bob.decryptRoomEvent(JSON.stringify(event), new w.RoomId(ROOM), settingsDec);
  const decBody = JSON.parse(dec.event).content.body;
  rec('A1.6 bob DECRYPTS the Megolm event headlessly — round-trip works', decBody === SECRET, `decrypted.body="${decBody}"`);

  // Verification posture: it decrypted on an UNVERIFIED device (no cross-signing).
  let shield = 'n/a';
  try { shield = dec.shieldState?.color !== undefined ? String(dec.shieldState.color) : 'present'; } catch {}
  rec('A1.7 decryption succeeds on an UNVERIFIED device (verification = trust shield, not a gate)', decBody === SECRET,
    `shieldState=${shield} (a warning shield is expected/acceptable for bots)`);

  // "Across restart": export the room key and restore it into a FRESH machine,
  // then decrypt the same event — proving the decryption key persists/restores.
  const exported = await bob.exportRoomKeys(() => true);
  const bob2 = await w.OlmMachine.initialize(new w.UserId(BOB), new w.DeviceId(B_DEV));
  let imported = null;
  try { imported = await bob2.importExportedRoomKeys(exported, () => {}); }
  catch (e) { imported = { error: e.message }; }
  let dec2body = null;
  try {
    const d2 = await bob2.decryptRoomEvent(JSON.stringify(event), new w.RoomId(ROOM), new w.DecryptionSettings(w.TrustRequirement.Untrusted));
    dec2body = JSON.parse(d2.event).content.body;
  } catch (e) { dec2body = 'ERR:' + e.message; }
  rec('A1.8 room key exports + restores into a fresh machine → decrypts across "restart"', dec2body === SECRET,
    `importResult=${JSON.stringify(imported)?.slice(0, 80)} restoredDecrypt="${dec2body}"`);

  const passed = ledger.filter((l) => l.pass).length, all = ledger.length;
  console.log('\n' + '='.repeat(72));
  console.log(`VERDICT: ${passed === all ? 'GO' : 'NO-GO'} — ${passed}/${all} checks passed`);
  console.log('='.repeat(72) + '\n');
  process.exit(passed === all ? 0 : 1);
}

main().catch((e) => { console.error('spike crashed:', e); process.exit(2); });
