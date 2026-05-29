---
name: Cloudflare DoH (1.1.1.1) PoP cache divergence is real for freshly-changed records
description: Single-shot DNS-over-HTTPS to 1.1.1.1 can return NXDOMAIN even when record exists, because some PoPs cache the prior negative response longer than the new positive
type: feedback
originSessionId: 67f6bbd4-d89c-4611-ba42-415aa0d3995a
---
**Empirically observed 2026-05-02** while wiring the federation-key-health probe's DNS TXT cross-check. After renaming a TXT record from `_mycelium` → `_mycelium-key.mycelium.id`, queries to Cloudflare's 1.1.1.1 DoH endpoint were inconsistent:
- ~50% of requests: status 0 (NOERROR), correct answer returned
- ~50% of requests: status 3 (NXDOMAIN), no answer

This is despite:
- The authoritative nameservers (april/norman.ns.cloudflare.com) returning the correct record consistently
- All three records (old + new at the same FQDN level) being on the same CF zone

**Cause:** Cloudflare 1.1.1.1 has many PoPs/edge servers; some had cached the prior NXDOMAIN response for `_mycelium-key.mycelium.id` (negative caching during the period the record didn't exist) and were serving that until the negative-TTL expired. PoP-routing is geographic + load-based, so consecutive requests hit different cache states.

**Why it matters:** Single-shot DNS lookups against a freshly-changed record are unreliable on the Cloudflare DoH path. Probes / verifiers / cross-checks need multi-resolver redundancy.

**Fix applied** in [packages/server/services/security-probes/federation.js](packages/server/services/security-probes/federation.js): `resolveDnsTxtKey()` queries three resolvers in parallel — 1.1.1.1, 1.0.0.1, and Google's 8.8.8.8 (`/resolve` endpoint, slightly different param shape). ANY positive answer wins. Absence is reported only if all three agree the record is missing. If two return DIFFERENT keys, return the sentinel string `'DIVERGED'` so the probe fails CRITICAL (worse than absence — possible in-flight rotation that hasn't settled, or a poisoned cache).

**Pattern to reuse:** for any DNS verification that runs immediately after a CF DNS change, multi-resolver-parallel-with-tiebreak is the right shape. The latency cost is negligible (sub-second total) compared to single-shot.
