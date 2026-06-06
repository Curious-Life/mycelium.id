// THROWAWAY SPIKE — Federation A1b: headless Matrix E2EE against a REAL homeserver.
//
// De-risks docs/DESIGN-federation-inter-instance-2026-06-05.md assumption A1b:
//   "the proven crypto core works end-to-end against a real homeserver (bot
//    login, sync loop, client-vs-appservice)" — the integration half of Tier-1.
//
// Two headless matrix-js-sdk bots (rust-crypto) against a real Synapse on
// :8008: register → login → initRustCrypto → startClient → sync → alice creates
// an ENCRYPTED room, invites bob → bob joins → alice sends → bob receives over
// the wire as m.room.encrypted and DECRYPTS it. No human, no GUI.
//
// Run (Synapse must be up on :8008): node probe.mjs

import { createClient, ClientEvent, RoomEvent, MatrixEventEvent } from 'matrix-js-sdk';
import { webcrypto } from 'node:crypto';

// matrix-rust-sdk-crypto-wasm wants a global crypto; Node 22 has it, ensure it.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const HS = 'http://localhost:8008';
const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`); };
const log = (...a) => console.log('   ·', ...a);

async function register(username) {
  const res = await fetch(`${HS}/_matrix/client/v3/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: `${username}-pw-123`, auth: { type: 'm.login.dummy' }, inhibit_login: false }),
  });
  if (!res.ok) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  return res.json(); // { user_id, access_token, device_id }
}

async function makeBot(username) {
  const u = `${username}_${Math.random().toString(36).slice(2, 8)}`;
  const creds = await register(u);
  const client = createClient({ baseUrl: HS, userId: creds.user_id, accessToken: creds.access_token, deviceId: creds.device_id });
  await client.initRustCrypto({ useIndexedDB: false });
  // Bots have no cross-signing partners; send to unverified devices (the default,
  // but be explicit — this is the "verification is not a gate" point).
  client.getCrypto().globalBlacklistUnverifiedDevices = false;
  const synced = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), 30000);
    client.on(ClientEvent.Sync, (state) => { if (state === 'PREPARED') { clearTimeout(t); resolve(); } });
  });
  await client.startClient({ initialSyncLimit: 10 });
  await synced;
  return { client, userId: creds.user_id, deviceId: creds.device_id };
}

function waitFor(pred, timeout, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false; try { ok = pred(); } catch {}
      if (ok) return resolve();
      if (Date.now() - start > timeout) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function waitForDecryptedMessage(client, roomId, timeout = 40000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('message timeout')), timeout);
    const tryResolve = (event) => {
      if (!event || event.getRoomId() !== roomId) return false;
      if (event.getType() === 'm.room.message') {
        const body = event.getContent?.()?.body;
        if (body) { clearTimeout(t); cleanup(); resolve({ body, wireType: event.getWireType?.() || event.event?.type }); return true; }
      }
      return false;
    };
    const onTimeline = (event) => {
      if (event.getRoomId?.() !== roomId) return;
      if (tryResolve(event)) return;
      if (event.isEncrypted?.()) event.once(MatrixEventEvent.Decrypted, () => tryResolve(event));
    };
    const onDecrypted = (event) => tryResolve(event);
    function cleanup() { client.off(RoomEvent.Timeline, onTimeline); client.off(MatrixEventEvent.Decrypted, onDecrypted); }
    client.on(RoomEvent.Timeline, onTimeline);
    client.on(MatrixEventEvent.Decrypted, onDecrypted);
  });
}

async function main() {
  console.log('\n=== A1b spike: headless Matrix E2EE over a real Synapse homeserver ===\n');
  const SECRET = 'a1b megolm over the wire @ ' + new Date().toISOString();

  const alice = await makeBot('alice'); rec('A1b.1 alice bot: register + initRustCrypto + sync (headless)', true, alice.userId);
  const bob = await makeBot('bob'); rec('A1b.2 bob bot: register + initRustCrypto + sync (headless)', true, bob.userId);

  // alice creates an E2EE room and invites bob
  const { room_id: roomId } = await alice.client.createRoom({
    preset: 'private_chat', invite: [bob.userId],
    initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
  });
  log('room', roomId);
  const encState = await alice.client.getCrypto().isEncryptionEnabledInRoom(roomId);
  rec('A1b.3 alice creates a Megolm-encrypted room + invites bob', !!encState, `encryptionEnabled=${encState}`);

  // bob joins, and alice waits until SHE sees bob joined (so his device is a
  // room member when she shares the Megolm key), then pre-downloads his keys.
  await bob.client.joinRoom(roomId);
  await waitFor(() => { const m = alice.client.getRoom(roomId)?.getMember(bob.userId); return m && m.membership === 'join'; }, 20000, 'alice sees bob joined');
  await alice.client.getCrypto().getUserDeviceInfo([bob.userId], true);
  rec('A1b.4 bob joins; alice sees the membership + has bob’s device keys', true);

  // bob listens, alice sends
  const recv = waitForDecryptedMessage(bob.client, roomId);
  await alice.client.sendTextMessage(roomId, SECRET);
  rec('A1b.5 alice sends an (auto-encrypted) message', true);

  const got = await recv;
  rec('A1b.6 bob RECEIVES it as m.room.encrypted on the wire and DECRYPTS', got.body === SECRET && got.wireType === 'm.room.encrypted',
    `wireType=${got.wireType} body="${got.body?.slice(0, 40)}…"`);

  // prove the homeserver only ever saw ciphertext: fetch the raw event via the API
  const raw = await (await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=10`, {
    headers: { authorization: `Bearer ${bob.client.getAccessToken()}` },
  })).json();
  const rawMsg = (raw.chunk || []).find((e) => e.type === 'm.room.encrypted');
  const leaks = JSON.stringify(raw).includes(SECRET);
  rec('A1b.7 the homeserver stored only ciphertext (plaintext absent server-side)', !!rawMsg && !leaks,
    `rawType=${rawMsg?.type} plaintextLeak=${leaks}`);

  alice.client.stopClient(); bob.client.stopClient();
  const pass = ledger.every(Boolean);
  console.log(`\n${'='.repeat(68)}\nVERDICT: ${pass ? 'GO' : 'NO-GO'} — ${ledger.filter(Boolean).length}/${ledger.length} checks passed\n${'='.repeat(68)}\n`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('A1b spike crashed:', e?.message || e); process.exit(2); });
