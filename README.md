<p align="center">
  <img src="assets/mycelium-sumi-e.svg" alt="Mycelium" width="240">
</p>

<h1 align="center">Mycelium</h1>

<p align="center"><i>The data layer for your digital life.</i></p>

<p align="center">A self-sovereign personal intelligence system. You own the keys, the data, and the intelligence.</p>

---

## Status

**Pre-launch.** This repository is the **redesigned multi-tenant (managed-light) Mycelium codebase**, currently in design + planning. No production code lives here yet; ports begin once the design is locked.

The full living spec is in [`docs/REDESIGN-LIVING-SPEC.md`](docs/REDESIGN-LIVING-SPEC.md). It captures three rounds of sweeps against the current single-tenant production system, a verification table, a transfer/rebuild/discard matrix, a threat-model pressure test of the proposed multi-tenant model, an in-flight design-doc reconciliation, an MYA-0.2 abandonment-lessons section, and 18 operator decisions that gate Phase 1 code.

Until launch this repository is **private**. License is AGPL-3.0 (see [`LICENSE`](LICENSE)) — public release is planned to coincide with the first external users.

## Where things live

| Repo | Role | Status |
|---|---|---|
| **[mycelium](https://github.com/Curious-Life/mycelium)** (private) | Canonical production code — single-tenant, per-VPS, dedicated-tier customers (0mm, puh, marti, admin) | Active, live |
| **mycelium.id** (this repo, private) | Redesigned multi-tenant managed-light tier | Pre-launch, design phase |
| **mycelium-managed** (planned, private) | Operational scripts, fleet ops, ops-only secrets | Not yet created |

The dedicated-tier code in `mycelium` continues to serve existing customers. The managed-light Tier B will run from this repo when ready.

## Legacy state

This repo had a prior life as a stale open-source mirror (Feb–April 2026). That state is preserved at two immutable git tags:

- `legacy-2026-04-mirror` — what the `main` branch held before the v2 redesign wipe
- `legacy-energy-spores-2026-04` — the `energy-and-spores` branch (energy ledger + spore framework experiment)

Documents harvested from those branches for v2 reference live under [`docs/legacy/`](docs/legacy/):

- `ARCHITECTURE-from-legacy.md` — the biological-model framing (mycelium / forest / spores / strain)
- `SOCIAL-SHARING-SPEC-from-legacy.md` — Phase 1–5 federation + connection-mindscape + discovery + SMPC design
- `ENERGY-from-legacy.md` — token-budget metabolic-state cost-router design (becomes the basis for Tier B's cost router)
- `MINDSCAPE_DESIGN-from-legacy.md` — topology UI design
- `SPORES-FRAMEWORK-from-legacy.md` — plugin architecture (deferred until post-launch use case)

## Build sequence

Phasing in [`docs/REDESIGN-LIVING-SPEC.md` § Part 10](docs/REDESIGN-LIVING-SPEC.md):

| Phase | What | Estimated |
|---|---|---|
| 0 | Pre-redesign cleanup (20 ship-before docs in canonical repo) | 3–5 wk |
| 1 | Tier B foundation: Postgres + RLS + connection middleware + key-wrap + agent runtime | 6–9 wk |
| 2 | Tier 2 launch: 2–5 hand-picked users | 2–3 wk |
| 3 | Scale to 20 users | 4–8 wk |
| 4 | Federation Phase 1 + native app | post-launch |

Realistic Tier 2 launch: Aug–Sep 2026.

## License

[AGPL-3.0](LICENSE). The intent is for the full Mycelium core to be open at launch; until then, this repo is private to avoid signaling a half-finished design.
