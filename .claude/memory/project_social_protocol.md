---
name: Social Protocol Design (2026-04-23)
description: Mycelium identity/bonds/relationships architecture — spec at docs/architecture/SOCIAL-PROTOCOL.md, key decisions resolved
type: project
originSessionId: a7a35582-f1b8-43ff-b05b-1b8414960964
---
Full spec: `docs/architecture/SOCIAL-PROTOCOL.md` (977 lines). Sits alongside FEDERATION-SPEC + TRUST-MODEL.

**Why**: Mycelium needed an identity layer tying together DIDs, the existing social layer (people/contact_territories), spaces, and federation. Without it, bonds are locked to the platform and relationship recognition is just another column in a DB.

**How to apply**: When designing features that touch identity, relationships, or cross-platform presence, read SOCIAL-PROTOCOL.md first. It defines the primitives (did:plc+did:web, bonds as VCs, relationship engine, spaces as scope).

### Key architectural decisions (resolved)

1. **Recognition ≠ capability** — a bond is recognition; space access is capability. Bond gates space invite but never derives access automatically. One-directional gate.
2. **Emergence, then declaration** — no fixed taxonomy (no Fire/Air/Water/Earth). Sigil is free text; grouping is post-hoc and computed.
3. **did:plc primary + did:web companion** — PLC Directory for portability, did:web as hedge against PLC going dark. Bidirectional `alsoKnownAs`.
4. **Bonds are VCs first, chain later** — W3C VC 2.0 with eddsa-jcs-2022 DataIntegrityProof + StatusList2021 gives 90% of the value with zero chain dependency. Solana is Phase 8, post-audit, only when scale demands tamper-evidence.
5. **Envelope v3 for custody** — extends existing v2 pattern with distinct HKDF info `"mycelium:custody:<userId>:v1"` so content-key compromise doesn't yield custody material. Signing + rotation keys in Phase 1; Solana entropy lazy (Phase 8).
6. **Relationship engine as separate package** — `@mycelium/relations`, runs on cron like clustering. Reads signals, suggests sigils grounded in user's OWN prior sigils via analog-bond nearest-neighbour (never LLM freeform invention).
7. **Passkey step-up for permanent actions** — agent tokens can NEVER mint/deepen/revoke bonds. Fresh WebAuthn assertion ≤60s for tier-3.

### Seven resolved open questions

1. did:plc creation: **lazy on first bond mint** (keeps PLC off signup path)
2. Rotation key: **custodial with explicit export in Phase 1**
3. Solana fees: **sponsor model rate-limited** (moot until Phase 8)
4. Multi-seal: **one seal per user in MVP**
5. Holder notification: **default-on** (bond being named IS the point)
6. Sigil edits: **24h grace window** for typos, then epoch-advance
7. ATProto mirroring: **opt-in** (bonds too intimate for default-public)

### Sequencing (critical)

Phase 0–1 (did:web foundations + custody envelope v3 + passkey step-up) can ship **now** in parallel with product work — zero user-facing surface until used. ~1 week.

**Status update 2026-05-02:** did:web foundations for `mycelium.id` (owner) shipped via Phase 0b of [docs/architecture/CROSS-VPS-SPACES-PLAN.md](docs/architecture/CROSS-VPS-SPACES-PLAN.md). Master keypair generated, sub-key on Worker, DID document live, multi-resolver TXT cross-check, security probes running every 5min. Step-up auth service stub (3 tiers, 27 tests) in `packages/server/services/auth-step-up.js` but NOT YET wired to high-risk endpoints. did:plc and bonds are still future tracks. Customer VPS federation keys are Phase 0c (designed in CROSS-VPS-SPACES-PLAN, model b chosen — VPS-resident with operator-recoverable encrypted backup).

**Everything from Phase 2 onwards waits** until core product is smooth: monorepo refactor done, clustering-cron stable at 21K+ messages, group-chat ingestion persisting, at least one paying customer using portal daily without friction. Phase 3 (relationship engine) additionally gates on clustering-cron being stable for 4+ weeks.

### PLC Directory named risk

PLC operated by Bluesky PBC; Swiss non-profit transition announced but not complete. Mitigations in spec: every did:plc user also has did:web, rotation keys exportable from Phase 1, did_cache supports 7-day degraded mode, monitor PLC availability.
