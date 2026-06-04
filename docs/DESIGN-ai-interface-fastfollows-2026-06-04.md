# AI Interface Layer — Fast-Follows Design (S4 remainder · streaming · tools · §4g cascade · /v1/embeddings · S6 recommender)

**Date:** 2026-06-04
**Status:** design locked via `/sweep-first-design` (3 cycles: 5 Explore/web agents + own-eyes reads of 8 files). Implementation staged below.
**Builds on:** S0–S3 + S8 (all merged to `main @ 4fabe1a`). Companions: [`DESIGN-ai-interface-layer-2026-06-04.md`](DESIGN-ai-interface-layer-2026-06-04.md) (Part 8 = S0–S8 status), [`DESIGN-relay-and-gateway-2026-06-04.md`](DESIGN-relay-and-gateway-2026-06-04.md) (Part B = the gateway).
**External pattern source:** [`pewdiepie-archdaemon/odysseus`](https://github.com/pewdiepie-archdaemon/odysseus) — **MIT** (AGPL-3.0-compatible; borrow code/ideas with the MIT notice preserved for any copied source). Python/FastAPI, so the *math and patterns* port; the code is reimplemented in JS. Borrowed specifically for S6 (the `hwfit` "Cookbook").

---

## Part 0 — Headline

Seven named fast-follows, sized by the sweep. **Two collapsed to near-no-ops, one is largely pre-built, three are real but bounded, one (S6) is the headline feature** — and the sweep replaced its weakest piece (a static tier table) with odysseus's computed fit model.

| Item | Sweep verdict | Effort | Slice |
|---|---|---|---|
| **S4a** `MYCELIUM_HTTP_HOST` | **Already loopback** (`server-http.js:402`). Gap is only override *parity*. | ~6 LOC | A |
| **S4b** server `instructions` | 1-key add; SDK 1.29 supports it (`server/index.js:53`). | ~12 LOC | A |
| **`/v1/embeddings`** | Seam pre-built (`embed-service.py` real + `embed/client.js`). Thin local-only adapter. | ~90 LOC | A |
| **§4g cascade** | Resolver returns ONE provider; cascade belongs *above* the router. | ~120 LOC | C |
| **tools pass-through** | Router is prompt-only; needs a transparent-proxy path for OpenAI-compatible providers. | ~90 LOC | C |
| **true streaming** | No stream path anywhere; router/cloud/local/gateway all buffer. Biggest lift. | ~200 LOC | B |
| **S6 recommender** | Fully greenfield. Borrow odysseus `hwfit` (computed fit, not tiers). | ~450 LOC | D |

**Slice order = A (quick wins) → B (streaming) → C (cascade + tools) → D (S6).** Each slice is independently shippable behind its own `verify:*` gate.

---

## Part 1 — Revision history (the pivots the sweep forced)

- **v1 (handoff sketch):** "S4a = make `:4711` default-loopback." **v2 (sweep):** `:4711` *already* hard-binds `'127.0.0.1'` with a security comment (`server-http.js:399-402`). It was never exposed. The real gap is that `server-rest.js`/`public-server.js` have `MYCELIUM_*_HOST` override knobs and `:4711` has none. **Pivot:** S4a is an *override-parity* change (default unchanged), not a security fix. Add a non-loopback **warning** so the knob can't silently expose the OAuth surface.
- **v1:** "S6 = detect RAM/VRAM → static tier table (≥24GB→70B, 8GB→7B…)." **v2 (odysseus):** odysseus's `hwfit` computes `required_gb` per model (`params × bytes-per-param + KV-cache + overhead`) and **ranks by a fit score** — strictly better than a brittle tier table (handles quant levels, context length, MoE active-params). **Pivot:** S6 borrows the *computed* model; the "catalog" is just `{name, paramsB, defaultQuant}` rows, and fit is derived.
- **v1:** "cascade = make the router try multiple providers." **v2 (sweep):** the router is constructed with ONE provider's cfg (`router.js:40-63`) and already does a cloud→local fallback (`router.js:141-148`). Putting a multi-cloud loop *inside* it would entangle the audited single-provider gate. **Pivot:** the cascade is a thin wrapper **above** the router — `resolveProviderChain()` returns an ordered list; the caller builds/【tries a router per provider. The existing router stays single-provider and untouched.
- **v1:** "streaming = unshim the gateway." **v2 (sweep):** the gateway shim is the *easy* 10%; the missing 90% is upstream — `cloud.js`/`local.js` buffer (`await res.text()`), and the router only returns `Promise<string>`. **Pivot:** streaming is a 4-file change (router generator + 2 adapter stream fns + gateway pipe), not a gateway tweak. Egress must still audit **once** on the assembled text.

---

## Part 2 — Consolidated sweep findings (file:line)

**Bind / transport**
- `:4711` binds loopback, no host override: `src/server-http.js:396-407` — `app.listen(port, '127.0.0.1', …)`; port = `opts.port || MYCELIUM_PORT || urlPort(baseURL) || 4711`.
- Override precedent: `src/server-rest.js` (`MYCELIUM_REST_HOST`, default `127.0.0.1`), `src/publish/public-server.js` (`MYCELIUM_PUBLIC_HOST`), `src/enrich/server.js` (`host='127.0.0.1'`).
- No `compression` middleware; only `app.use(express.json())` at `src/server-http.js:133` → SSE is not buffered. Express `^5.2.1`.

**MCP server**
- Constructed at `src/mcp.js:194-197` — `new Server({name:'mycelium',version:'0.1.0'},{capabilities:{tools:{}}})`, **no `instructions`**.
- SDK `1.29.0` supports it: `node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js:53` (`this._instructions = options?.instructions`) + `:282` (emitted in `initialize`); `types.js:588` (`instructions: z.string().optional()`).
- `getContext` (D5 preamble) returns a flat markdown string: `src/tools/context.js:154` (`return sections.join('\n\n')`), registered `src/mcp.js:80`.

**Inference router / adapters**
- `infer({prompt,task,maxTokens,sensitive}) → Promise<string>`, never streams: `src/inference/router.js:122-153`.
- Sensitive US hard-block: `router.js:134-137` — `if (sensitive && /^us/.test(cloudJurisdiction())) { emitEgress(prompt,"denied","sensitive_us_block"); return runLocal(...); }`. `/^us/` covers `us-standard` **and** `us-zdr`.
- Egress fires once per `infer()` on the cloud path only: `router.js:135` (denied) / `:139` (allowed); never for local-only. Sink: `src/inference/egress.js:24-35` (sha256 hash + length, never prompt).
- Cloud→local resilience fallback already exists: `router.js:141-148`.
- Cloud buffers (no `stream` key): `src/inference/cloud.js:69-100` (`postJson` → `await res.text()`), bodies `:106`/`:134`. Response field `data.choices[0].message.content` (`:138`).
- Local buffers `stream:false`: `src/inference/local.js:45-49`, reads `data.response` (`:82`). `/api/generate`.
- Ollama endpoint usage repo-wide: `/api/tags` used at `src/enrich/describe-image.js:50`; `/api/pull`, `/api/embeddings`, `/api/show`, `/api/ps` — **none**.
- Resolver returns ONE provider cfg: `src/inference/resolve.js:37-63` → `{anthropicApiKey?, openaiApiKey?, baseUrl?, cloudModel?, jurisdiction?}`; `{}` when none.
- Jurisdiction tagging: `src/inference/presets.js:42-48` `jurisdictionForBaseUrl()` → `local | eu-zdr | us-standard` (never emits `us-zdr`); `EU_ZDR_HOSTS = ['regolo.ai','scaleway.ai','scaleway.com','exoscale','nebius']`.

**Embeddings**
- `pipeline/embed-service.py` is REAL (not a stub): `POST /embed`+`/batch`+`GET /health` on `127.0.0.1:8091`; Nomic v1.5 (`nomic-ai/nomic-embed-text-v1.5`, int8 ONNX), `OUTPUT_DIM=768`, L2-normalized, task prefixes `search_query:`/`search_document:`. Bind/loopback + no-access-log per §7/§13.
- Node client `src/embed/client.js`: `createEmbedClient()` → `health()`, `embed(text,task='query')`, `embedBatch(texts,task='document')`; `EMBED_DIM=768`, `VALID_TASKS=['query','document']`, `MYCELIUM_EMBED_PORT||8091`.
- Supervisor spawns it: `src/embed/supervisor.js:154`. No `/v1/embeddings` exists anywhere.

**Provider store + UI**
- `ai_providers` schema (no `jurisdiction` col; derived): `migrations/0001_init.sql:119-134`.
- `db.providers.create(userId,{provider,label,authType,credentials,configDir,model,baseUrl}) → last_row_id`: `src/db/providers.js:34-41`. Plus `list/get/getActive/setActive/update/remove`.
- Create path: `POST /providers {provider:'custom', base_url, model_preference, label}` (custom needs no key): `src/portal-providers.js:71-90`.
- UI: `portal-app/src/lib/components/settings/IntelligenceSection.svelte` — presets grouped `eu-zdr|local|us`; `connect()` POSTs `/portal/providers`; insertion point for a recommender panel is between the connected list (`:131`) and the connect form (`:150`). Ollama preset: `presets.js:27` `{id:'ollama', baseUrl:'http://127.0.0.1:11434/v1', jurisdiction:'local'}`.
- **No hardware detection anywhere** (exhaustive grep: `os.totalmem`/`cpus()`/`gpu`/`vram`/`nvidia`/`/proc/meminfo` → 0 hits in source).

**Borrowed from odysseus (MIT) — `hwfit`**
- `estimate_memory_gb(model,quant,ctx) = params_b*bpp + 0.000008*kv_params*ctx + 0.5` (`services/hwfit/models.py`).
- `QUANT_BPP` bytes/param: `F16:2.0, Q8_0:1.05, Q6_K:0.80, Q5_K_M:0.68, Q4_K_M:0.58, Q3_K_M:0.48, Q2_K:0.37, FP8:1.0, AWQ-4bit:0.50`.
- `_fit_score(req,avail)`: `req>avail→0`; `ratio≤0.5→60+ratio/0.5*40`; `≤0.8→100`; `≤0.9→70`; else `50` (`services/hwfit/fit.py`).
- Apple unified-memory budget ladder: `≤16GB→0.67`, `≤64GB→0.75`, else `0.80`.
- HW detection: `nvidia-smi --query-gpu=memory.total,name`, `/proc/meminfo MemTotal`, AMD `/sys/class/drm/…/mem_info_vram_total`, macOS `sysctl -n hw.memsize` (`services/hwfit/hardware.py`).
- Streaming `data: {delta}\n\n` + `data: [DONE]\n\n`, fallback "switch provider only before first token" (`src/llm_core.py`).

---

## Part 3 — Designs

### Slice A1 — S4a: `MYCELIUM_HTTP_HOST` (override parity)

`src/server-http.js` `startHttpServer()`:
```js
const host = opts.host || process.env.MYCELIUM_HTTP_HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
if (!LOOPBACK.has(host)) {
  console.error(`[mycelium] ⚠️ HTTP+OAuth+gateway binding to ${host} (non-loopback) — this exposes the OAuth/MCP/gateway surface beyond localhost. Only do this behind a TLS reverse proxy + firewall; the relay reaches :4711 via loopback and does NOT need this.`);
}
const httpServer = app.listen(port, host, () => { … });
```
**Default unchanged** (loopback). Fail-safe: the warning makes a footgun loud. LOC ≈ 6.

### Slice A2 — S4b: MCP `instructions`

`src/mcp.js`:
```js
export const MYCELIUM_INSTRUCTIONS =
  'Mycelium is the user\'s private cognitive vault — their notes, thoughts, people, ' +
  'tasks and reflections, encrypted on their own machine. Call `getContext` FIRST to ' +
  'orient (current time, what is on their mind, recent activity, health of the system). ' +
  'Prefer recalling from this memory (search/list/getFact tools) before answering from ' +
  'general knowledge, and capture new notes the user shares. Everything here is sensitive ' +
  'and personal; never repeat vault contents outside this conversation.';

const server = new Server(
  { name: 'mycelium', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: MYCELIUM_INSTRUCTIONS },
);
```
Static, short, points at `getContext` (does NOT duplicate its dynamic content). Surfaces in every `initialize` response so a fresh client (Claude Desktop/web) is oriented. LOC ≈ 12.

### Slice A3 — `/v1/embeddings` (local-only)

New `createEmbeddingsHandler({ embed, model })` in `src/gateway/openai-compat.js` (or a sibling `src/gateway/embeddings.js`), mounted `POST /v1/embeddings` on `:4711` behind `requireAuth` (same pattern as chat).
```js
// body: { model?, input: string | string[], encoding_format?: 'float'|'base64' }
// task: default 'document'; honor header X-Mycelium-Embed-Task: query|document
const inputs = Array.isArray(input) ? input : [input];           // validate non-empty strings
const vectors = await embedClient.embedBatch(inputs, task);       // → number[][768]
res.json({
  object: 'list',
  data: vectors.map((embedding, index) => ({ object: 'embedding', index,
    embedding: encoding_format === 'base64' ? floatsToBase64(embedding) : embedding })),
  model: 'nomic-embed-text-v1.5',
  usage: { prompt_tokens: approxTokens(inputs.join('')), total_tokens: approxTokens(inputs.join('')) },
});
```
- **Security (§7):** LOCAL-ONLY. Never routes to a cloud embeddings provider. The vector is a semantic fingerprint but it goes only to the operator's OWN Bearer-authenticated harness over loopback/relay — same trust boundary as the vault owner. **No cloud egress → no egress-audit row** (there is no third-party egress); documented.
- Fail-closed: embed-service down → `503 {error:{type:'embeddings_unavailable'}}` (generic; never leak).
- `GET /v1/models` gains a `nomic-embed-text-v1.5` entry tagged for embeddings.
- LOC ≈ 90 + `verify:embeddings-gateway`.

### Slice B — true token streaming

**Router** (`src/inference/router.js`) — add an async generator alongside `infer`:
```js
async function* inferStream({ prompt, task='complex', maxTokens, sensitive=false }) {
  // same validation + same CLOUD_TASKS/hasCloud gate as infer()
  if (CLOUD_TASKS.includes(task) && hasCloud()) {
    if (sensitive && /^us/.test(cloudJurisdiction())) {           // identical hard-block
      emitEgress(prompt, 'denied', 'sensitive_us_block');
      yield* localStream({ prompt, maxTokens }); return;
    }
    let acc = '', firstToken = true;
    try {
      for await (const delta of cloudStream({ prompt, maxTokens })) {
        if (firstToken) { emitEgress(prompt, 'allowed'); firstToken = false; }
        acc += delta; yield delta;
      }
      return;
    } catch (err) {
      if (firstToken) { yield* localStream({ prompt, maxTokens }); return; } // pre-token fallback only
      throw err;                                                  // post-token → cannot fall back
    }
  }
  yield* localStream({ prompt, maxTokens });
}
```
- **Egress audit fires once**, before the first token, on `prompt` (unchanged contract — the hash is of the input, exactly like `infer`). The "switch provider only before first token" rule is borrowed from odysseus `llm_core.py`.
- **cloud.js**: add `openaiCompatibleStream`/`anthropicStream` reading `res.body` (Web ReadableStream) → parse SSE `data:` lines → yield `choices[0].delta.content` (OpenAI) / `content_block_delta` text (Anthropic). Send `stream:true`. Reuse the same error-categorization (never echo body).
- **local.js**: add `localStream` — `stream:true` on `/api/generate`, parse NDJSON lines, yield `.response`, stop on `.done`.
- **gateway** (`openai-compat.js`): when `stream:true`, replace `sendStreamShim` with a real pipe — for each delta emit `data: {choices:[{delta:{content}}]}`, then a terminal `finish_reason:'stop'` chunk + `data: [DONE]`. On a mid-stream throw after headers sent → emit one `{error}` SSE frame + `[DONE]` then `end()`. Keep the shim as the fallback when `inferStream` is absent (defensive).
- LOC ≈ 200 across 4 files + `verify:gateway-stream`.

### Slice C1 — §4g multi-provider cascade

**resolve.js** — add `resolveProviderChain(db, userId, { sensitive=false } = {})`:
- `db.providers.list(userId)` → for each active/usable row, shape to a router cfg (reuse the existing single-row mapping) + tag `jurisdiction` via `jurisdictionForBaseUrl`.
- Order by priority: **eu-zdr → us-standard (frontier) → local**. When `sensitive`, **drop all `us-*`** entirely (not just block) and keep eu-zdr → local.
- Always append the on-box local (Ollama) as the final fallback element.

**New `src/inference/cascade.js`** — `inferWithCascade({ chain, prompt, task, maxTokens, sensitive, onEgress, fetch })`:
- For each cfg in `chain`: build a router (`createInferenceRouter({...cfg, onEgress, fetch})`), `try { return await router.infer({prompt,task,maxTokens,sensitive}) } catch { continue }`.
- Each attempt audits its own egress (the existing per-router sink). Exhausted → throw the last error.
- The gateway calls `inferWithCascade` instead of a single router **when cascade is enabled** (env `MYCELIUM_INFER_CASCADE=1` or a setting; **default = single active provider** to preserve v1 behavior — see Open Questions).
- LOC ≈ 120 + `verify:cascade`.

### Slice C2 — tools pass-through (OpenAI-compatible transparent proxy)

When a `/v1/chat/completions` request carries `tools`/`tool_choice` **and** the active provider is OpenAI-compatible (`baseUrl` or `openaiApiKey`, not Anthropic/local-only), the gateway takes a **transparent-proxy** path instead of flatten-to-prompt:
- Forward the raw OpenAI body (messages + tools + tool_choice) to the provider's `/v1/chat/completions` with the operator's key; return the provider's raw response (including `tool_calls`). Honors `stream` (pipe SSE through).
- **Egress audit** still fires (hash of the serialized messages) — tools requests are not exempt.
- **Sensitive gate**: if `X-Mycelium-Sensitive` + a `us-*` provider → **refuse** with `400 {type:'sensitive_blocked'}` (we cannot downgrade a structured tool call to local; failing closed is correct).
- Anthropic tool translation + local-Ollama `/api/chat` tools = deferred (named).
- LOC ≈ 90 + `verify:gateway-tools`.

### Slice D — S6 hardware recommender ("Cookbook")

**`src/hardware/detect.js`** — `detectHardware({ execFile, os, fs } = {})` → `{ totalRamGb, availableRamGb, cpuCores, cpuName, arch, platform, hasGpu, gpuName, gpuVramGb, gpuCount, unifiedMemory, backend }`:
- RAM/CPU: `os.totalmem()/freemem()/cpus()/arch()/platform()`.
- NVIDIA: `execFile('nvidia-smi', ['--query-gpu=memory.total,name','--format=csv,noheader,nounits'])` — **no shell**, fail-soft (ENOENT → no GPU).
- AMD: read `/sys/class/drm/card*/device/mem_info_vram_total` (Linux).
- Apple Silicon (`arch==='arm64' && platform==='darwin'`): unified memory → usable VRAM = `totalRamGb × frac` (ladder 0.67/0.75/0.80, borrowed).
- Every probe wrapped — any failure degrades to a safe default (no GPU, RAM-only).

**`src/hardware/fit.js`** (borrowed odysseus math, reimplemented + MIT-attributed):
- `QUANT_BPP` table; `estimateMemoryGb(paramsB, quant, ctx)`; `fitScore(requiredGb, availableGb)`; `fitLevel(requiredGb, vramGb)` → `perfect|good|marginal|too_tight`.
- `availableGb` = GPU VRAM when `hasGpu`, else `totalRamGb × 0.6` (CPU/unified budget).

**`src/hardware/catalog.js`** — a curated, conservative set of Ollama-pullable models:
`{ name:'qwen2.5:3b', paramsB:3.1, defaultQuant:'Q4_K_M', ctx:8192, blurb:'tiny, fast, 8GB-class' }`, `llama3.1:8b` (8.0), `qwen2.5:14b` (14.8), `gemma2:27b` (27.2), `llama3.3:70b` (70.6) — ~6-8 rows. Values are static facts (param counts), not secrets.

**`src/hardware/recommend.js`** — `recommendModels(hardware, { limit=4 } = {})` → catalog ranked by `fitScore`, each `{ name, paramsB, estimatedGb, fitScore, fitLevel, blurb }`, `too_tight` dropped unless nothing fits (then return the smallest with a warning).

**`src/hardware/ollama.js`** — HTTP-only Ollama client (no shell):
- `isUp(baseUrl)`, `listInstalled(baseUrl)` (`GET /api/tags`), `pullModel(baseUrl, name, onProgress)` (`POST /api/pull`, parse NDJSON `{status,completed,total}` → `onProgress`). Model name validated `^[a-z0-9][a-z0-9._:\/-]{0,79}$` (defense even though names come from our catalog).

**Backend routes** (mounted on REST `:8787`, new `src/portal-hardware.js`):
- `GET /portal/hardware` → `detectHardware()`.
- `GET /portal/hardware/recommend` → `recommendModels(detectHardware())`.
- `POST /portal/hardware/pull` `{name}` → SSE proxy of `pullModel` progress (validate name against catalog; reject unknown).
- After a pull completes, the UI calls the **existing** `POST /portal/providers {provider:'custom', label:'Ollama — <name>', base_url:'http://127.0.0.1:11434/v1', model_preference:'<name>'}` — no new write path.

**UI** — `IntelligenceSection.svelte`: a "Recommended for your hardware" panel (detect → show specs → ranked models w/ fit badges → one-click **Pull** w/ progress bar → auto-add provider + setActive). Slots between the connected list (`:131`) and the connect form (`:150`).

LOC ≈ 450 (detect 90 · fit 70 · catalog 40 · recommend 40 · ollama 80 · routes 70 · UI 120 minus reuse) + `verify:hardware`.

---

## Part 4 — Threat model (new surface)

| Surface | Risk | Mitigation |
|---|---|---|
| S4a host override | operator sets `0.0.0.0` → OAuth/gateway on the LAN | default loopback; loud warning on non-loopback; relay never needs it |
| `/v1/embeddings` | semantic-fingerprint vectors leave the box | local-only (never cloud); Bearer-guarded; same trust as vault owner; embed-service stays loopback |
| streaming | partial plaintext mid-stream on cloud error | audit fires pre-first-token; post-token failures end the stream, never fall back silently to a *different* jurisdiction |
| tools pass-through | structured tool call to a US provider when sensitive | fail closed (400 `sensitive_blocked`); cannot downgrade to local, so refuse |
| cascade | sensitive content cascading into a US provider | `resolveProviderChain` **drops** `us-*` when `sensitive`; each attempt re-audits |
| S6 `nvidia-smi`/pull | command injection via model name; shelling out | `execFile` (no shell) everywhere; model name regex-validated + must be in our catalog; pull is HTTP JSON not a shell `ollama pull` |
| S6 detect | leaking host details | hardware specs are non-secret; never logged with vault data; behind the authed portal |

All §1–§13 invariants preserved: zero plaintext in logs/audits (hash-only), fail-closed defaults, loopback-only embed-service, never `--no-verify`.

---

## Part 5 — Test strategy (by gate)

- **`verify:embeddings-gateway`** (Slice A3): `input` string + array → 768-dim envelope; `encoding_format:'base64'` round-trips; embed-service-down → 503 generic; Bearer-guard 401; task header honored; `/v1/models` lists the embed model.
- **`verify:gateway-stream`** (Slice B): mock cloud SSE + mock Ollama NDJSON; assert deltas arrive in order, `[DONE]` terminal, assembled text == buffered `infer`, **one** egress row (allowed) per stream, sensitive→local stream + denied audit, pre-token cloud error → local fallback, post-token error → error frame (no double-jurisdiction).
- **`verify:cascade`** (Slice C1): chain ordering eu→us→local; failover skips a 500 provider; sensitive drops us-*; each attempt audits; exhausted → throws.
- **`verify:gateway-tools`** (Slice C2): tools present + OpenAI provider → raw proxy passes `tool_calls` through; egress audited; sensitive+us → 400; no-tools path unchanged (regression).
- **`verify:hardware`** (Slice D): pure + deterministic with **injected** hardware fixtures — fit math matches odysseus values (table-test `estimateMemoryGb`/`fitScore`), ranking orders by fit, `too_tight` dropped, Apple unified ladder, catalog integrity; ollama client against mock fetch (`/api/tags`, `/api/pull` NDJSON progress); model-name validation rejects injection.

Each gate joins the `npm run verify` chain (alphabetical-ish, near its siblings). Smoke per `/deploy-and-verify`: spawn `--http`, `curl` the new surface.

---

## Part 6 — Implementation order (independently shippable)

1. **Slice A** (S4a + S4b + `/v1/embeddings`) — tiny, zero-risk, immediate harness value. One PR.
2. **Slice D backend** (detect + fit + catalog + recommend + ollama client + `verify:hardware`) — pure/testable, no UI yet. One PR. *(S6 is the headline; ship its de-risked core early.)*
3. **Slice D routes + UI** (portal-hardware + Svelte panel + pull SSE) — depends on D-backend. One PR.
4. **Slice B** (streaming) — biggest; isolated to inference + gateway. One PR.
5. **Slice C1 + C2** (cascade + tools) — routing-policy changes; ship behind flags, default off. One PR.

Slices A, D-backend **and D-routes/UI** are built in **this** session (S6 is end-to-end; see Part 8). Slices B and C are locked + ready.

---

## Part 7 — Verification table (every load-bearing assumption → file:line I READ MYSELF)

| # | Assumption | Verified at (own-eyes read) |
|---|---|---|
| 1 | `:4711` already binds loopback; port resolution chain | `src/server-http.js:396-407` ✓ |
| 2 | Relay reaches `:4711` via localhost (loopback default safe) | `src/server-http.js:399-401` (comment) ✓ |
| 3 | MCP `Server` built with no `instructions` today | `src/mcp.js:194-197` ✓ |
| 4 | SDK 1.29 supports `instructions` end-to-end | sweep: `…/sdk/dist/cjs/server/index.js:53,282`; `package.json:86` (`^1.29.0`) ✓ |
| 5 | cloud.js buffers (`await res.text()`), no `stream` key | `src/inference/cloud.js:86,106,134` ✓ |
| 6 | Ollama `/api/generate` `stream:false`, reads `.response` | `src/inference/local.js:45-49,82` ✓ |
| 7 | router `infer` → `Promise<string>`, no stream path | `src/inference/router.js:122-153` ✓ |
| 8 | gateway shim fakes streaming (proves SSE works) | `src/gateway/openai-compat.js:128-137` ✓ |
| 9 | egress fires once per cloud `infer`, hash+len only | `src/inference/router.js:135,139`; `src/inference/egress.js:24-35` ✓ |
| 10 | router flattens to a prompt; no tool path | `src/inference/cloud.js:134` (messages=[user]) ✓ |
| 11 | resolver returns ONE provider cfg, not a list | `src/inference/resolve.js:37-63` (sweep) ✓ |
| 12 | jurisdiction order; `/^us/` blocks all US | `src/inference/router.js:134`; `presets.js:42-48` ✓ |
| 13 | sensitive falls to local + audits denial | `src/inference/router.js:134-137` ✓ |
| 14 | embed-service real; `embedBatch(texts,task)` 768-dim | `pipeline/embed-service.py:246-265`; `src/embed/client.js:132-146` ✓ |
| 15 | embeddings sensitive / loopback-only | `pipeline/embed-service.py:31-33`; CLAUDE.md §7/§13 ✓ |
| 16 | no hardware detection exists (greenfield) | sweep: exhaustive grep, 0 hits ✓ |
| 17 | fit math source (odysseus, MIT) | research: `services/hwfit/{models,fit,hardware}.py` ✓ |
| 18 | `/api/pull` unused; `/api/tags` used | `src/enrich/describe-image.js:50`; grep ✓ |
| 19 | provider create path reusable for local Ollama row | `src/portal-providers.js:71-90`; `src/db/providers.js:34-41` ✓ |
| 20 | UI insertion point | `IntelligenceSection.svelte:131,150` (sweep) ✓ |
| 21 | no compression middleware → SSE unbuffered | `src/server-http.js:133` (only `express.json()`) ✓ |

## Part 8 — Build status (this session)

- **Slice A** ✅ — S4a (`server-http.js`), S4b (`mcp.js`), `/v1/embeddings` (`src/gateway/embeddings.js`). Gates: `verify:embeddings-gateway` (6) GO.
- **Slice D (S6) — backend + routes + UI** ✅ — `src/hardware/{fit,catalog,detect,recommend,ollama}.js` (`verify:hardware`, 17) + `src/portal-hardware.js` routes mounted in `server-rest.js` (`verify:hardware-routes`, 5) + the "Recommended for your hardware" panel in `IntelligenceSection.svelte` (detect → ranked fit badges → one-click streaming pull → auto-register the local provider). **S6 is end-to-end usable.** Portal build GO.
- **Slice B — true token streaming** ✅ — `inferStream` (async generator) on the router (`router.js`) with the SAME routing + §4g sensitive gate + audit-once semantics as `infer`; `cloudStream` (OpenAI SSE + Anthropic `content_block_delta`) in `cloud.js`; `localStream` (Ollama NDJSON) in `local.js`; the gateway pipes real deltas (`openai-compat.js` `streamCompletion`, shim kept as fallback). Pre-token cloud failure → local fallback; post-token failure → clean SSE close (never echoes err). Gates: `verify:gateway-stream` (7) GO + `verify:gateway` G6 now drives the real path.
- **Slice C — §4g cascade + tools pass-through** ✅ — **C1 cascade:** `resolveProviderChain` (`resolve.js`, eu-zdr→us→local + a guaranteed local floor; drops us-* when sensitive) + `src/inference/cascade.js` (`inferWithCascade`, per-attempt audited); the router gained a `cloudFallbackToLocal` flag so a cloud failure PROPAGATES to the next chain element instead of short-circuiting to local. Gateway uses it behind **`MYCELIUM_INFER_CASCADE`** (default OFF → single active provider, v1 behavior). `verify:cascade` (6) GO. **C2 tools pass-through:** a request carrying `tools` is transparently proxied to an OpenAI-compatible provider (`openai-compat.js` `toolsPassthrough`) so `tool_calls` round-trip; sensitive+US → 400 (can't downgrade a tool call to local), egress audited hash-only, provider errors never forwarded raw, stream piped through. `verify:gateway-tools` (6) GO.
- **ALL SEVEN FAST-FOLLOWS BUILT.** The only operator decision left open: flip cascade default ON (recommend after a 2-provider live smoke). Streaming-for-cascade + Anthropic/local tool translation remain named deferrals.

## Part 9 — Open questions

**Resolved during sweep:**
- *S4a a security fix?* No — already loopback; it's override parity (pivoted).
- *S6 tier table?* No — computed fit (odysseus), strictly better (pivoted).
- *Cascade inside the router?* No — wrapper above; router stays single-provider (pivoted).
- *`/v1/embeddings` cloud option?* No — local-only by §7.
- *Embeddings task default?* `document` (corpus/RAG indexing is the common harness use); `X-Mycelium-Embed-Task: query` to override.

**Deferred (named, for the operator):**
- **Cascade default on/off.** Ship default-OFF (single active provider preserves v1) behind `MYCELIUM_INFER_CASCADE`, or default-ON to honor the locked EU→frontier→local policy? *Recommend: ship off, flip after `verify:cascade` + a smoke with ≥2 providers.*
- **Anthropic + local tool translation** for tools pass-through (v1 covers OpenAI-compatible only).
- **Streaming for the cascade** (B and C1 compose, but the first PR streams the single active provider only).
- **S6 model catalog source** — static curated list (this design) vs. fetching Ollama's library JSON at runtime (network + trust). *Recommend: static, reviewed-in-repo.*
