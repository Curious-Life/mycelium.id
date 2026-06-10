# Illuminate → AI describe/name pipeline — fix design (2026-06-10)

Operator: "clicking Illuminate triggers the analysis pipeline but not AI describing the
territories — realms stay 'Realm N', territories unnamed. Needs a proper sweep-first design."

## Root causes (sweep + live pressure-tests)

### RC1 — the naming step shells out to the Claude CLI, not the user's provider (THE bug)
`pipeline/describe-clusters.js` is the step that **names** realms + territories (Step 3, inline in
`run-clustering.sh`). Its `describeWithClaude()` (describe-clusters.js:49-72) does:
```js
const { stdout } = await execFileAsync(CLAUDE_BIN, ['-p', prompt], { timeout: 60000, … });
```
It invokes the **`claude` CLI binary** — NOT `resolveInferenceConfig`/the inference router. On a
machine with no authed Claude CLI (the operator runs gemma/Regolo via the provider store),
`execFileAsync` throws → caught → `return null` → `name = described?.name || \`Realm ${realm_id}\``
(describe-clusters.js:95,121). So **every** realm/territory falls back to the placeholder. This is
why nothing is ever named, regardless of which provider is connected.

`pipeline/describe-chronicles.js` (the deeper *narrative* pass) DOES use the router
(`createInferenceRouter(resolveInferenceConfig(...))`, describe-chronicles.js:170-180) — but
`parseChronicle` keeps `name: t.name` (describe-chronicles.js:~99), so it never fixes the name; it
only fills story/archetype fields and inherits the broken "Realm N".

### RC2 — local Ollama providers are mis-routed to the slow `/v1` reasoning path
`createInferenceRouter` routes a `narrate` task to cloud when `hasCloud()` is true, and
`hasCloud = anthropicApiKey || openaiApiKey || baseUrl` (router.js:68,147). A **local** gemma
provider carries `baseUrl=http://127.0.0.1:11434/v1`, so it routes to `cloud.js` (`/v1/chat/completions`)
— **not** `local.js` (native `/api/generate`, which supports `format:'json'`). Measured live on
gemma4:12b:
| path | time | reasoning | JSON |
|---|---|---|---|
| `/v1` (cloud.js) default | **36s** | 906 chars | clean in `content` |
| `/v1` + `think:false` | 35s | still 847 chars (NOT honored) | clean |
| `/v1` + `response_format:json_object` | 36s | still 831 chars (NOT honored) | clean |
| **native `/api/chat` + `think:false`** | **4.0s** | **0** | clean |

So reasoning models pay a ~9× latency tax on `/v1`, and **only the native endpoint can disable it**.
With describe-clusters' 60s per-call timeout (describe-clusters.js:60), a cold 35s call risks
timing out, and N+M sequential calls (e.g. 5 realms + 30 territories × 35s ≈ 20 min) is unusable.

### RC3 — silent fail-soft hides all of this
Both passes catch errors and continue with the old name (describe-clusters.js:71 `catch`,
describe-chronicles.js:139 `catch { failed++ }`) with **no surfaced status**. The operator sees
"Realm N" and can't tell describe ran-and-failed vs never-ran.

## Design

### Fix 1 — name via the active provider (kills RC1)
Replace `describeWithClaude` (Claude CLI) in `describe-clusters.js` with the SAME inference path
`describe-chronicles.js` already uses: `resolveInferenceConfig(db, userId)` →
`createInferenceRouter(...)` → `router.infer({ task:'narrate', prompt, maxTokens, format:'json' })`.
Now naming uses whatever the operator connected (gemma/Regolo/Anthropic/…).

### Fix 2 — fast, think-free local describe (kills RC2)
A small shared helper `pipeline/lib/narrate-infer.js` `createNarrator(cfg)`:
- **Local Ollama** (`cfg.baseUrl` host is 127.0.0.1/localhost, or jurisdiction 'local'): call Ollama
  **native `/api/chat`** with `{ think:false, format:'json', stream:false, model: cfg.cloudModel }` →
  ~4s, no reasoning, constrained JSON. (cloudModel carries the provider's model_preference, e.g.
  gemma4:12b.)
- **Cloud** (anthropic / remote openai-compat): use the existing `router.infer` with
  `response_format`/`format:'json'`. Cloud reasoning models are server-side fast; accept as-is.
Both passes (clusters + chronicles) use this narrator so behavior is identical.

### Fix 3 — observability (kills RC3)
- describe-clusters + chronicles log `[describe] named X/Y realms · Z/W territories (provider=<label>)`
  to stderr (captured by `startChronicleNarrationJob`'s stderr handler + the clustering job).
- The generate job records a `describe` summary so the UI's activity chip / Illuminate can show
  "named 5 areas" or "describe failed — check Settings → Intelligence" instead of silent "Realm N".
  (Minimal: write counts to the job state; surfacing in UI is a follow-up if scope grows.)

## Module shape (LOC ≈ 120)
- `pipeline/lib/narrate-infer.js` (NEW, ~55 LOC): `createNarrator({ db, userId })` → `{ infer, label }`.
  Resolves config once; picks native-local vs router-cloud; returns an `infer(prompt, {maxTokens})`
  that always returns a string (throws on hard failure for the caller to fail-soft + count).
- `pipeline/describe-clusters.js` (~ -20/+15): drop `describeWithClaude`/`CLAUDE_BIN`; use the
  narrator; count + log named vs fallback.
- `pipeline/describe-chronicles.js` (~ +10): use the narrator (so local is fast + think-free) instead
  of the raw router; keep its JSON parsing.

## Edge cases — explicit decisions
- **No provider configured at all** → narrator falls back to local Ollama default model; if Ollama is
  down, infer throws → caller fail-soft (placeholder) + logs "no model". (Unchanged contract, now
  surfaced.)
- **Cloud reasoning model (Regolo qwen3.6) that 4xx's** → infer throws → fail-soft + log the status.
  (The operator already gets the actionable chat error; describe logs the same class.)
- **Re-run of Generate** → clustering never writes names (cluster.py updates `clustering_points` only,
  verified); describe upserts via `ON CONFLICT DO UPDATE`, so a successful re-describe overwrites
  "Realm N" with the real name. No clobber risk.
- **think:false unsupported by a future local model** → native /api/chat ignores the flag and still
  returns JSON (format:'json' constrains it); slower but correct.
- **Encryption** → name/essence go through the same `getDb({userKey,systemKey})` adapter
  (encrypted-at-rest) as today; the narrator only changes WHO generates the text, not how it's stored.

## Test strategy
- `pipeline/lib/narrate-infer.js`: unit — local cfg → hits `/api/chat` with `think:false` (mock fetch
  asserts body); cloud cfg → uses router. (new tiny test or fold into verify:generate.)
- `verify:generate` / a describe smoke: run describe-clusters against a stub Ollama returning JSON →
  realms get real names (not "Realm N"); against a throwing model → fail-soft placeholder + non-zero
  `failed` count logged.
- Live smoke: Illuminate on the real vault with gemma active → realms named within ~1-2 min, stderr
  shows `named 5/5 realms`.

## Implementation order
1. `pipeline/lib/narrate-infer.js` + a unit assertion (native think:false body).
2. `describe-clusters.js` → narrator (the core fix). Smoke: names appear.
3. `describe-chronicles.js` → narrator (speed parity).
4. Counts/logging + (if cheap) job-state summary for the UI.
5. `npm run verify:generate` + describe smoke green; live Illuminate.

## Verification table
| Assumption | Verified at |
|---|---|
| Naming uses the Claude CLI, not the provider (root cause) | `pipeline/describe-clusters.js:49-72` (`execFileAsync(CLAUDE_BIN, ['-p', …])`) |
| Placeholder written when describe fails | `describe-clusters.js:95,121` (`name = described?.name \|\| \`Realm ${id}\``) |
| describe-chronicles uses the router but keeps the old name | `describe-chronicles.js:170-180`, parseChronicle `name: t.name` |
| Local baseUrl routes to cloud.js `/v1`, not local.js native | `router.js:68,147`; `hasCloud = …\|\| baseUrl` |
| local.js native `/api/generate` supports `format` | `src/inference/local.js:47,61` |
| cloud.js `/v1` ignores think/response_format for gemma (live) | live curl: 36s + reasoning with both |
| native `/api/chat` think:false = 4s, no reasoning (live) | live curl: 4.0s, thinking=0 |
| clustering never writes names (no re-run clobber) | `pipeline/cluster.py` updates `clustering_points` only |
| describe upserts ON CONFLICT (re-describe overwrites placeholder) | `describe-clusters.js:102-106`, `src/db/territory-docs.js:138-181` |
| name/essence encrypted-at-rest via the adapter | `getDb({userKey,systemKey})` in both describe scripts |

## Out of scope
Generalizing the router's local-baseUrl→native routing for ALL inference (chat uses harness.js
separately; the gateway is a bigger blast radius) — the narrator helper contains the native path to
the describe pipeline only. Batching N realms into one call (further speedup) — deferred; think:false
already gets ~4s/item.
