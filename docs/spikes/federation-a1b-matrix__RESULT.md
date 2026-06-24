# Spike RESULT — A1b: headless Matrix E2EE against a REAL homeserver

**Date:** 2026-06-06
**Verdict:** ✅ **GO (with scoped residuals)** — 7/7. The integration half of Tier-1 is proven: headless bots do real Megolm E2EE over a real homeserver. Remaining: S2S federation between two servers + a persistent crypto store + the Continuwuity binary.
**De-risks:** `docs/DESIGN-federation-inter-instance-2026-06-05.md` assumption **A1b** — "the proven crypto core works end-to-end against a real homeserver (bot login, sync loop, client-vs-appservice)."
**Run:** Synapse up on `:8008`, then `RUST_LOG=error node spike/federation-a1b-matrix/probe.mjs`. Deps: `matrix-js-sdk@41` (npm), `matrix-synapse@1.154` (pip).

## Homeserver note (why Synapse, not Continuwuity)

The design's Tier-1 homeserver is **Continuwuity** (D-FED-7). In this sandbox it was **not obtainable**: its binaries live on `forgejo.ellis.link` (blocked by the network policy), `api.github.com` is blocked (only the `github.com` web host is allowlisted, and the mirror's release assets point back at forgejo), and the **Docker daemon is down**. So this spike used **Synapse** (the reference homeserver, pip-installable). **The result transfers:** E2EE is entirely client-side (Megolm) — the homeserver only relays opaque `m.room.encrypted` blobs — so the homeserver brand does not affect the crypto/integration proof. Continuwuity remains the footprint/deployment target (verify the binary + RAM on a real host = assumption A2).

## What it exercises (the real thing)

Two headless `matrix-js-sdk` bots (rust-crypto, `useIndexedDB:false`) against a real Synapse: register → login → `initRustCrypto` → `startClient` + sync loop → create a Megolm-encrypted room → invite → join → auto-encrypted send → receive + decrypt. No human, no GUI, no hand-rolled relay (unlike the Tier-1 spike, which mocked the server).

## Ledger

| # | Check | Result |
|---|---|---|
| A1b.1 | alice bot: register + `initRustCrypto` + sync, headless, in Node | PASS |
| A1b.2 | bob bot: same | PASS |
| A1b.3 | alice creates a Megolm-encrypted room (`isEncryptionEnabledInRoom`) + invites bob | PASS |
| A1b.4 | bob joins; alice sees the membership + pre-downloads bob's device keys | PASS |
| A1b.5 | alice sends — `matrix-js-sdk` auto-encrypts (logs: ensureSessions → shareRoomKey → "Encrypted event successfully") | PASS |
| A1b.6 | bob **receives it as `m.room.encrypted` on the wire and DECRYPTS** (body matches) | PASS |
| A1b.7 | the homeserver stored **only ciphertext** — raw `/messages` event is `m.room.encrypted`, plaintext absent server-side | PASS |

## Findings (consequence for the build)

1. **A1b crux PASS.** A headless Mycelium bot can drive a real homeserver's sync loop and do Megolm E2EE end-to-end in our Node runtime. Combined with the Tier-1 spike (crypto lifecycle GO 9/9), the "appservices need a crypto helper" concern is fully retired: `matrix-js-sdk` + rust-crypto *is* the working headless client.
2. **Key-sharing timing is the one gotcha.** A first message can be undecryptable (UTD) if the sender hasn't seen the recipient *joined* and downloaded their device keys. The fix (proven here): before sending, wait until the room shows the peer `join` and call `getCrypto().getUserDeviceInfo([peer], true)`. The build's send path must do this (or accept first-message UTD + retry).
3. **Verification is not a gate** (confirmed again): bots send/receive with `globalBlacklistUnverifiedDevices = false`; no cross-signing required for message flow.

## NOT proven here (scoped residuals → before Phase B ships)

- **S2S federation between two homeservers.** This used one Synapse with two users. Two Mycelium boxes = two federating homeservers (`:8448` + `.well-known/matrix/server` delegation + TLS). The Megolm crypto is identical regardless of server topology (it never leaves the clients), so the residual is purely the standard **server-server transport** — well-trodden Matrix, but untested here (needs two server names + TLS, heavy in a sandbox).
- **Persistent crypto store.** Used `useIndexedDB:false` (in-memory) — a restart loses device/session state. Production needs a persistent store backend (the Rust SDK sqlite store / a Node IndexedDB shim). Tier-1 proved key export/import works; this is a store-wiring choice.
- **Continuwuity footprint (A2).** Confirm the actual binary + RAM/CPU as a bundled Mac sidecar on a real host.

## Bottom line

A1b's hardest unknown — *can a headless bot do real Megolm E2EE against a real homeserver, sync loop and all* — is **YES, proven 7/7**. Phase B (shared spaces ⇄ Megolm rooms) now rests on proven crypto **and** proven homeserver integration. Remaining Tier-1 work is S2S federation + a persistent store + picking up the Continuwuity binary on a real host — engineering, not unknowns.
