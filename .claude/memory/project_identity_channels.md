---
name: Identity & Channels architecture (designed 2026-05-02)
description: Multi-channel identity end-state — design + threat model + 9-phase sequencing with per-phase hardening at docs/architecture/IDENTITY-CHANNELS.md
type: project
originSessionId: 67f6bbd4-d89c-4611-ba42-415aa0d3995a
---
Full design: [docs/architecture/IDENTITY-CHANNELS.md](docs/architecture/IDENTITY-CHANNELS.md) (759 lines).

**Why**: Mycelium identity was channel-siloed — Telegram via OWNER_TELEGRAM_ID env-var, WhatsApp via USER_ID env-var, Discord via `user_identities` table (the only one done right), passkey via passkey_credentials, handle duplicated across users + user_profiles, DID stored but unused, bonds designed not built. No clean answer to "prove person X controls handle Y, route to them at handle Z." The end state: **`identity_channels` is the single source of truth for `(channel_kind, channel_value) → user_id?`; verifiers register per protocol; one auth dispatcher; one visitor-session primitive; alsoKnownAs publication is opt-in per channel.**

**Critical sweep finding**: `user_identities` already exists in D1 with the right shape (FK to users, UNIQUE on provider+provider_id) — Discord uses it, Telegram and WhatsApp don't. We're consolidating, not inventing.

**How to apply**: When designing any feature that touches auth, identity binding, channel routing, or federation, read this doc first. The 9-phase plan sequences foundation → channel verifiers (Telegram, email, phone, mycelium-handle, passkey-guest) → linkage UI → aKa publication → bonds. Phases 1–4 can ship in any order after 1; Phase 5 (mycelium-handle, = Phase A from CROSS-VPS-SPACES-PLAN) gates the federated half.

**Key invariants**:
- An identity is anchored by a DID (`did:plc` primary + `did:web:host:u:<handle>` companion).
- A channel proves control OR enables reach. Three independent flags: `auth_enabled` (default 1), `delivery_enabled` (default 0), `aka_published` (default 0).
- Bonds (per SOCIAL-PROTOCOL) ≠ channels. Channels say "I'm reachable here." Bonds say "I recognize you as X."
- Visitor sessions are distinct from full sessions — different cookie name, no `user_id` to leak.
- Step-up Tier 2 required to link/unlink any channel; Tier 3 for transfer between users.

**Per-phase hardening**: each phase ships a feature AND a hardening line item, so the system is strictly improved at every step. Examples: Phase 1 drops `users.handle` duplicate, hard-FKs `user_identities.user_id`, chains step_up_tokens to sessions, wires step-up gates to existing high-risk endpoints. Phase 2 replaces `OWNER_TELEGRAM_ID` env-var hardcoding with identity_channels lookup.

**14 threats modeled (C1–C14)**, **18 guardians** mapped per phase, **12 open decisions** called.

**Where this fits with other docs**:
- Phase 5 of this doc = Phase A of CROSS-VPS-SPACES-PLAN (federated sign-in via mycelium handle)
- Phase 6 = Phase C of CROSS-VPS-SPACES-PLAN (per-space passkey guests)
- Phase 7 = Phase D of CROSS-VPS-SPACES-PLAN (identity linkage)
- Phase 8 operationalizes alsoKnownAs from SOCIAL-PROTOCOL §4.2
- Phase 9 hands off to SOCIAL-PROTOCOL Phases 1+2 (custody envelope v3, bonds-as-VCs)

**Status**: Designed. Phase 0b (federation foundation, owner-only) shipped. Identity-channels Phase 1 (foundation) is the natural next implementation step before any specific channel verifier ships. Phase B (Telegram widget) from the prior plan = Phase 2 in this doc, NOT to be shipped before Phase 1.
