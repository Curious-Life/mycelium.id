# Spike RESULT — Tier-1 / A1: headless Matrix E2EE (Megolm) lifecycle

**Date:** 2026-06-05
**Verdict:** ✅ **GO (with scoped residuals)** — 9/9 checks pass. The *crypto-lifecycle crux* of A1 is de-risked; the *homeserver-integration* half is named as the next step (not yet proven).
**De-risks:** `docs/DESIGN-federation-inter-instance-2026-06-05.md` assumption **A1** — "a headless Matrix bot can send/receive E2EE (Megolm) messages reliably," and the named risk "appservices historically do NOT do E2EE without a crypto helper."
**Run:** `node spike/federation-tier1-matrix/probe.mjs` (dep: `@matrix-org/matrix-sdk-crypto-wasm@18`, installed from npm — reachable in this env).

## Why this is a faithful test without a homeserver

For E2EE the homeserver is a **dumb relay of opaque blobs** — it never sees plaintext or room keys. `matrix-sdk-crypto-wasm` is built exactly around that: the `OlmMachine` is a no-network-IO state machine that emits "requests to send" and consumes "responses." So the spike's harness **plays the homeserver** and runs the real lifecycle between two `OlmMachine`s (alice's bot device, bob's bot device): device-key upload → key query → one-time-key **claim** → **Olm** 1:1 session → **Megolm** room-key share over to-device → encrypt → decrypt. The cryptography, device/session/key management, and persistence are all real.

## Ledger

| # | Check | Result |
|---|---|---|
| A1.0 | `@matrix-org/matrix-sdk-crypto-wasm` (vodozemac; **no libolm**) loads headless in Node v22 | PASS |
| A1.1 | Two `OlmMachine`s initialize headlessly — no human, no interactive verification | PASS |
| A1.2 | Both bots upload device keys + one-time keys (the "crypto helper" identity) — 50 OTKs each | PASS |
| A1.3 | Olm 1:1 session established via the `KeysClaim` handshake | PASS |
| A1.4 | Megolm room key shared to bob's device over Olm-encrypted to-device + delivered | PASS |
| A1.5 | Alice encrypts a room event; ciphertext is `m.megolm.v1.aes-sha2`, plaintext absent | PASS |
| A1.6 | **Bob decrypts the Megolm event headlessly — the round-trip works** | PASS |
| A1.7 | Decryption succeeds on an **UNVERIFIED** device (verification = trust *shield*, not a gate to message flow) | PASS |
| A1.8 | Room key **exports + restores into a fresh `OlmMachine`** → decrypts the same event ("across restart") | PASS |

## Load-bearing findings (consequence for the build)

1. **A1 crux PASS.** The "appservices need a crypto helper" concern is answered: the crypto helper (`matrix-sdk-crypto`/vodozemac, WASM) **exists, is on npm, installs cleanly, and runs the full Megolm lifecycle headlessly in our exact Node runtime** — no native `libolm`, no human verification, no GUI client. A Mycelium bot can be E2EE-capable.

2. **Verification is not a gate.** Messages decrypt on an unverified device (A1.7). For bots this means we can exchange E2EE messages immediately; cross-signing/verification is a *trust-shield* layer to add later for UX, not a blocker. (Sovereign attribution can ride the box's own ed25519 signature on message bodies — see design §3 Tier-1.)

3. **Restart recovery works via key export/import (A1.8).** The inbound Megolm session is portable and restorable — the same mechanism real clients use for key backup + restart. In Node there is no IndexedDB (the wasm default store), so a production bot needs a **persistent store backend** (the Rust SDK's sqlite store, or `matrix-bot-sdk`'s `RustSdkAppserviceCryptoStorageProvider`). That's a wiring choice, not an unknown.

4. **HOMESERVER CORRECTION — Conduwuit is archived (read-only since 2026-01-19).** The research input's recommended homeserver is unmaintained. Its official community continuation is **Continuwuity** (Rust, lightweight, ~weekly releases, active in 2026) — use it (or Synapse/Dendrite) as the Tier-1 homeserver. Update the design doc's Tier-1 references.

## NOT proven here (scoped residuals → the next spike, before any homeserver bundling)

- **Real homeserver in the loop.** The sync loop (`/sync` long-poll), registration/login of a bot account, and **client-bot vs appservice** choice are untested. Next: run a real **Continuwuity** + a real client SDK (`matrix-js-sdk` with rust-crypto, on npm) and reproduce A1.6 end-to-end over HTTP.
- **Server-to-server federation.** Two Mycelium boxes = two homeservers federating over `:8448` + `.well-known/matrix/server` delegation through the relay — untested (this is the "multiple instances communicate" goal).
- **Persistent store backend** under load + footprint of Continuwuity as a bundled sidecar on a Mac (assumption A2).
- **DID↔MXID binding** (design §3 Tier-1): publishing the bot's MXID in `did.json` and the body-level ed25519 signature — design-level, not exercised here.

## Bottom line

A1's hardest unknown — *can a headless bot do real Megolm E2EE in our runtime without libolm or a human* — is **YES, proven**. Remaining Tier-1 work is integration (homeserver sync + persistent store + S2S federation), which is engineering on a proven crypto core. Do the Continuwuity end-to-end spike before bundling a homeserver into the shipping app.
