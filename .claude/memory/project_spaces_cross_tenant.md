---
name: Shared Spaces cross-tenant invites gated on two infra items
description: Research resolved 2026-04-24 — cross-tenant invites need dual-D1 routing + agent-token operator-fallback before they can ship
type: project
originSessionId: c95aef73-f7cd-4ee5-afa1-ed95b0f67073
---
Shared Spaces v1 invites are **same-tenant only** (locked in docs/SHARED-SPACES-PLAN.md §10, §11). Cross-tenant is possible *schema*-wise: there is an operator-side `users` table that spans tenants, and `space_access` / `space_invites` / `space_knowledge` all live in the operator D1 only (migration 110). The blocker is the Worker's per-request D1 routing.

**The two scaffolding items that unlock cross-tenant:**

1. **Dual-D1 routing for shared resources.** Today `validateAndResolveTenantId()` in `tenant-d1.ts` routes the whole request to one D1 based on `X-Tenant-ID`. Shared-resource reads (`space_access`, `space_knowledge`, `space_conversations`) need to go to operator D1 regardless of caller's tenant_id, while personal tables stay on the tenant D1. Simplest path: expose a second `dbOperator` binding on the request and have the spaces namespace use it.

2. **Agent-token escape hatch for shared resources.** Today the token is verified against operator D1's `agent_tokens`, then the rest of the request is pinned to the tenant D1. A bonded agent on tenant B reading a space joined cross-tenant needs its subsequent space queries to bypass that pin.

Why: Both changes touch the tenant-isolation contract, so they ship alongside the bond-based auth wave from `SOCIAL-PROTOCOL.md` (where a reviewer can assess them in the cross-tenant threat model). Neither is complex; they're just invasive in the wrong reviewer context if shipped mid-S3.

How to apply: do NOT attempt to enable cross-tenant invites in S3. If a future prompt asks "can we invite a user on another tenant?", the answer is "not in v1 — gated on the two items above and the bond auth wave." Reference this memory + §10 of the plan doc.

**Update 2026-05-02:** Full plan now lives at [docs/architecture/CROSS-VPS-SPACES-PLAN.md](docs/architecture/CROSS-VPS-SPACES-PLAN.md) (732 lines). Includes 11-entry threat model (T1–T11), 10 failure modes, 7 phases (0b foundation through F bond-VC), threat-tagged guardians per phase, 12 open decisions called. The dual-D1-routing + agent-token-operator-fallback scaffolding above is **Phase E** in the new plan.

Phase 0b foundation **shipped 2026-05-02** (federation keypair, Worker routes, DID doc, step-up auth stub, security probes). Phase 0c (customer federation keys, model b: VPS-resident + operator-recoverable encrypted backup) is the next foundation step before any cross-VPS work. Phase B (Telegram login widget) and Phase C (per-space passkey guests) can ship in parallel with 0c — they don't need cross-instance plumbing.
