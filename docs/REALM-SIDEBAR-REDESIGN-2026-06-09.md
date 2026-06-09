# Realm sidebar redesign — elegant, described-aware (2026-06-09)

Operator feedback on the realms/territories section (`MindscapeDetail.svelte`, realms level):
1. **Drop the "Mycelium" header** at the realms level — it duplicates the page identity.
2. **Color is too contrasty** — make the realm list much more elegant/subtle.
3. **Undescribed realms** (showing meaningless "Realm 0/1/3") should be **greyed out**; and at the **bottom**:
   - **"Spawn intelligence"** when no AI is connected (connect-AI CTA), and
   - **"Illuminate"** when an AI *is* connected — spawns agents to name & describe the areas.

## The pivot (sweep found the original assumption wrong)

#132 added an `Area N` fallback (`realm.name || \`Area ${i+1}\``) + `realmsNamed` gating, assuming undescribed realms have a **null/empty** name. **They don't.** The backend stores a literal placeholder.

Live ground truth — `GET /api/v1/portal/mindscape/realms` on the running vault:
```
id=0 name='Realm 0' essence='' pts=… terr=…
id=1 name='Realm 1' essence='' …
```
So `realm.name` is truthy ("Realm 0") → the `Area N` fallback never fires, and `realmsNamed` (any non-empty name) is always `true` → the Spawn-intelligence prompt was wrongly suppressed.

**Fix:** detect *described* by content, not mere presence:
```js
isPlaceholderName(name) = !name || /^realm\s+\d+$/i.test(name.trim())
isRealmDescribed(r)     = !isPlaceholderName(r.name) || (r.essence?.trim().length > 0)
```

## Design (single component, zero backend change)

`MindscapeDetail.svelte`, `navLevel === 'realms'`:

- **Breadcrumb hidden at realms root** (`{#if navLevel !== 'realms'}`). When drilled in, a placeholder realm shows **"Area N"** (its index in `sortedRealms`) instead of "Realm N".
- **Realm list, elegant:**
  - *Described* realm → real `name`, full-color but **softened** dot (smaller, lower opacity, soft glow).
  - *Undescribed* realm → greyed row (`opacity .5`), label **"Area N"**, **muted grey** dot.
- **Bottom CTA** (only when `anyUndescribed`):
  - `aiConnected` (`providers.some(p => p.is_active)`, from `GET /portal/providers`) → **Illuminate** button → `generate.start()` (`$lib/generate`), which runs cluster→auto-chronicle and names+describes the realms. Progress shows in the existing floating `MindscapeActivityChip`. Disabled while `$generate.phase` is active.
  - else → **Spawn intelligence** → `goto('/settings?tab=intelligence')`.
- Footer ("N messages · N areas") retained.

## Why reuse `generate.start()` for Illuminate
There is **no narrate-only endpoint** — chronicle narration is auto-started at the tail of `POST /portal/mycelium/generate` (`src/jobs.js:170`, fail-soft if no model). The realms exist but are unnamed because the active provider errored at generation time. Re-running generate with a working AI produces real names+essence. A narrate-only endpoint (cheaper, preserves realm IDs) is a future optimization.

## Verification table
| Assumption | Verified at |
|---|---|
| Realm name is backend placeholder "Realm N", essence "" (not null) | live `GET /api/v1/portal/mindscape/realms` (running vault) |
| Backend passes `rp.name` straight through (nullable col) | `src/portal-mindscape.js:158`, `migrations/0001_init.sql` realms.name |
| `generate.start()` → `POST /portal/mycelium/generate`; self-drives embed-wait→cluster→done | `portal-app/src/lib/generate.ts:166-190` |
| Chronicle narration auto-runs after generate (names/describes realms) | `src/jobs.js:170` (`startChronicleNarrationJob`) |
| AI-connected signal = `providers[].is_active` | live `GET /api/v1/portal/providers` (`is_active:1`) |
| Activity chip already mounted, reads `$generate` | `MindscapeView.svelte` mounts `MindscapeActivityChip` |
| Parent reloads realms when `$generate.phase==='done'` | `MindscapeView.svelte:91` |
| Old `realmsNamed` only used by the to-be-removed top block | `MindscapeDetail.svelte:95,262` |

## Out of scope
Narrate-only (chronicle-only) backend endpoint; territory-level greying (same pattern, later); clustering-skew rebalance.
