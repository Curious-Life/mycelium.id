# Mind Files Encryption-at-Rest — Design

**Status:** Draft v2 (post-sweep). Pre-implementation. Awaiting operator review.
**Created:** 2026-05-08
**Predecessor:** [docs/MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md](MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md) §"Security follow-up — encryption-at-rest gap"
**Skill discipline:** [/sweep-first-design](.claude/skills/sweep-first-design/SKILL.md). 5 parallel sweeps, file:line citations, 1 documented v1→v2 pivot, verification table at end.

---

## TL;DR

Encrypt `mind/*.md` and `mind/snapshots/**/*.md` at rest using the existing crypto-local AES-256-GCM envelope (same primitive that protects D1 ciphertext, R2 artifacts, and the mind-search index snapshot). Per-host master key, scope='personal' (or 'moms' for moms-agent). Inline ciphertext format with 4-byte magic prefix + base64 envelope, mirroring [packages/core/mind-search/index/persist.js](../packages/core/mind-search/index/persist.js).

**Closes:** [CLAUDE.md §1](../CLAUDE.md) Zero plaintext leakage gap for `mind/*.md` files. Pre-existing gap, not introduced by 2026-05-07 PR1, but PR1's `snapshots/` dir inherited the same plaintext-on-disk shape.

**Net new MCP tools:** +3 (`readMindFile`, `editMindFile`, `writeMindFileWhole`). After PR2 retires 19 cold-tier tools, total agent-tools surface remains well under the deferral budget. Surgical Edit semantics preserved via `editMindFile` — decrypt → unique-match replace → encrypt — so in-conversation one-line changes don't pay the whole-file rewrite cost.

---

## Sweep findings (consolidated)

### Sweep 1 — caller inventory

19 callers across packages/, scripts/, tests/. Two distinct access patterns:

- **Helper-mediated (16 sites):** `agent-tools.js:82` instantiates `createMindFiles` and passes `readMindFile`/`writeMindFile` into MCP domain handlers ([documents.js:462,497,525](../packages/tools/agent-tools/domains/documents.js), [internal.js:97,123,174-187](../packages/tools/agent-tools/domains/internal.js)). Wrapping the helper transparently encrypts these.
- **Direct fs (3 sites — the gap):**
  - [context-assembly.js:130-140](../packages/core/context-assembly.js#L130-L140) — `readFileQuiet(path.join(mindDir, ...))` against 7 mind/* files. Bypass.
  - [scripts/migrate-mind.js:43-48](../scripts/migrate-mind.js) — one-time Supabase→local migration. Already-shipped, non-issue.
  - [scheduler.js:807-844](../packages/core/scheduler.js#L807-L844) — Phase 3.5 cycle prompt instructs the agent to use **Claude Code's built-in Read, Write, and Bash tools** on `mind/model.md`. **This is the structural defect the handoff sketch missed.** See pivot below.

### Sweep 2 — crypto-local API

- **`encrypt(plaintext, scope, masterKey, userId=null)`** at [crypto-local.js:848](../packages/core/crypto-local.js#L848) → returns base64 string of JSON envelope `{v, s, iv, ct, dk, u?}`.
- **`decrypt(encoded, masterKey, allowedScopes=null, opts={})`** at [crypto-local.js:957](../packages/core/crypto-local.js#L957) → returns plaintext string. Throws `ScopeViolationError` on scope mismatch, `Error` on malformed envelope or AES tag failure.
- **Valid scopes:** `'personal' | 'org' | 'wealth' | 'moms'` ([crypto-local.js:814-844](../packages/core/crypto-local.js#L814-L844) — `inferScope`).
- **Master key:** [`getMasterKey()`](../packages/core/crypto-local.js#L1400) pins per-process, reads from `/run/mycelium/master.key` tmpfs. No per-call re-read.
- **`isEncrypted(value)`** at [crypto-local.js:438-449](../packages/core/crypto-local.js#L438-L449) — validates base64→JSON→envelope structure. Cannot false-positive on a markdown file (random `.md` content fails the JSON+structure check).
- **Existing scope inference for mind/ paths:** [crypto-local.js:822-827](../packages/core/crypto-local.js#L822-L827) already maps `mind/`, `internal/`, `transcriptions/`, `states/` paths to `'personal'` (or `'moms'` for moms-agent). **Reuse `inferScope({ path, agent_id })` rather than hardcoding scope strings.**

### Sweep 3 — process boundaries

Three processes touch `mind/*.md`:

| Process | Imports crypto? | Master.key access | Touches mind/ |
|---|---|---|---|
| agent-server | ✅ ([agent-server.js:78](../packages/server/agent-server.js#L78)) | ✅ tmpfs | ✅ via context-assembly preload |
| MCP child (agent-tools) | ❌ today | ✅ same user, tmpfs readable | ✅ via createMindFiles deps |
| Claude Code subprocess (Edit/Write/Read tools) | ❌ no API surface | ✅ same user but no module | ⚠ via cycle-prompt instruction |

**The Claude Code subprocess is the hard problem.** When Phase 3.5 fires, the wake-cycle runner spawns `claude --print` ([runner.js:322](../packages/core/runner.js#L322)) with the cycle prompt, and the prompt tells the agent to use built-in `Read`, `Write`, `Bash wc -l` against `mind/model.md`. Those tools speak raw OS fs. With encryption-at-rest, `Read` returns base64 envelope (incoherent context) and `Write` overwrites ciphertext with plaintext (corrupting format). **The cycle prompt has to be rewritten to route through MCP tools.**

### Sweep 4 — encryption-at-rest precedents

**Exactly one production precedent:** [packages/core/mind-search/index/persist.js](../packages/core/mind-search/index/persist.js) (mind-search inverted index snapshot, 240 lines). The pattern is RFC-validated and shipped.

Layout:
```
bytes 0..3:  magic "MIS1"
bytes 4..n:  base64 envelope from encrypt(serialized, scope, masterKey, userId)
```

Atomic write: `open(path.tmp.${pid}, 0o600) → writeFile(payload) → fsync → close → rename`. Load: read → check magic → strip header → `decrypt()`. Errors typed (`IndexUnavailableError`, `DecryptError`, `ScopeMismatchError`) — caller decides fallback. **Mirror this pattern verbatim** for mind files; only swap the magic ("MIND" instead of "MIS1") and the inner serialization (markdown string passed straight through to `encrypt()`).

Other paths in repo do **not** persist ciphertext locally (R2 stores ciphertext via Worker; bot tokens decrypt to memory at boot via [bootstrap-secrets.js](../packages/core/bootstrap-secrets.js); seed-secret.js encrypts then PUTs to Worker). The mind-search snapshot pattern is the only template.

### Sweep 5 — migration scope + master key topology

- **7 core files per host:** model.md, flagged.md, dreams.md, topology-notes.md, core-todo.md, core-communication.md, vessel-practice.md ([context-assembly.js:132-140](../packages/core/context-assembly.js#L132-L140)).
- **Up to 2 D1-mirrored:** reflections.md, synchronicities.md ([mind-files.js:78-83](../packages/tools/agent-tools/mind-files.js#L78-L83)).
- **Snapshots:** ~7 today (one per active host's first cycle), grows by ~7/day. Indefinite retention by design (handoff §"What's now in production" — "130 MB/year per agent is fine").
- **Weekly reviews:** scheduler.js:957 writes `mind/weekly-reviews/<date>.md` via Claude Code Write tool — **also affected.** Add to the migration scope.
- **Master key per-host:** [provision-customer.sh:407](../scripts/provision-customer.sh#L407) generates `openssl rand -hex 32` independently on each VPS. **Each host's mind/* must be encrypted under that host's own key.** No central encryption possible — migration script must run per-host.
- **Fleet:** the full fleet = 4 hosts.

---

## Pivot — v1 → v2

| Version | Source | Plan |
|---|---|---|
| v1 | [Handoff §Security follow-up](MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md) | 5 steps: move mind-files.js → @mycelium/core, wrap reads/writes, refactor context-assembly.js, one-shot migration, snapshots inherit via byte copy. |
| v2 | This doc, after sweep #1 surfaced [scheduler.js:807-813](../packages/core/scheduler.js#L807-L813). | v1 covered the agent-server read path but missed the **wake-cycle write path**. Phase 3.5's prompt uses Claude Code's built-in `Read`/`Write` tools on `mind/model.md` directly — these bypass the helper and would break under encryption. v2 adds: (a) two new MCP tools (`readMindFile`, `writeMindFileWhole`), (b) Phase 3.5 prompt rewrite to route through MCP, (c) Step 4 wc-l replacement with MCP-friendly verification, (d) similar treatment for weekly-reviews subdir. |
| v2.1 | Operator review (2026-05-08): "is there really no way to edit? rewriting every file seems wasteful." | v2 dropped Edit entirely for mind/ paths, forcing every change through whole-file rewrite. Wasteful for surgical changes (status flips, hypothesis renames, typos). v2.1 adds **`editMindFile`** MCP tool — same exact-string + uniqueness contract as Claude Code's Edit, but performed inside MCP after decrypt and before encrypt. Preserves the surgical-edit primitive that the architecture v3 invariant ("one tool per purpose") explicitly named. Total new tool surface +3 instead of +2. |
| v2.2 | Self-review against best practices (2026-05-08): three concerns surfaced. | (a) **`writeMindFileWhole` is a data-loss footgun outside Phase 3.5** if the agent miscomputes content and there's no pre-edit snapshot. Fix: `writeMindFileWhole` internally calls `snapshotMindFile` as its first step (idempotent first-write-wins, so no new behavior — snapshot trail is structurally guaranteed). Phase 3.5's explicit Step 1 becomes belt-and-suspenders. (b) **Sequencing:** PR2 (tool retirement, 19 cold-tier tools) must land *before* this PR so the deferral budget absorbs +3 against −19 net. (c) **Backwards-compat plaintext-pass needs an end date** — once all 4 hosts are migrated, flip to "no magic + non-empty file = error" via follow-up PR. Removal trigger documented in open questions. |

---

## Threat model

**What's protected after this PR:**
- Shell access (compromised VPS, AppArmor escape, lateral move from another agent) running `cat mind/model.md` sees ciphertext.
- VPS disk image / backup / `tar` snapshot leaks ciphertext, not plaintext.
- World-readable bit accidents — file mode tightened to `0o600` (was 0664).
- Per-agent git history (if repo is git-backed) commits ciphertext.

**What's NOT protected (accepted limits):**
- Process-memory dump of agent-server or MCP child while running — master key in webcrypto CryptoKey, decrypted plaintext in agent context. Same threat surface as D1 ciphertext (always was the case; not a regression).
- AppArmor profile bypass that grants tmpfs read of `/run/mycelium/master.key` — same threat surface as everything else relying on the master key.
- Scope confusion: agent with `AGENT_SCOPES=["personal"]` cannot decrypt a 'moms' envelope. Today only personal-agent and moms-agent have mind/ dirs; they're scope-disjoint. Cross-scope mind-file access not a feature; not breaking anything.

**Defense in depth (existing layers, unchanged):** SSH-CA + UFW + AppArmor + claude-user uid + tmpfs master.key + scope guardian.

---

## Architecture

### File format on disk

```
mind/model.md  (pre)               ASCII text, ~36 KB
                  ↓
mind/model.md  (post)              4-byte "MIND" magic + base64 envelope, ~50 KB
                                   bytes 0..3:  "MIND"
                                   bytes 4..n:  Buffer.from(JSON.stringify({v:1, s:"personal",
                                                iv, ct, dk}), 'utf8').toString('base64')
```

Same structure as [packages/core/mind-search/index/persist.js:33-39](../packages/core/mind-search/index/persist.js#L33-L39); only magic differs. Atomic write: `tmp+fsync+rename`. File mode `0o600`.

### Module placement

- **Move:** `packages/tools/agent-tools/mind-files.js` → `packages/core/mind-files.js`. Collocates with crypto-local.js. Removes circular-dep risk.
- **Update import:** `packages/tools/agent-tools.js:51` and `packages/tools/agent-tools/domains/{documents,internal}.js` import from `@mycelium/core/mind-files.js`.
- **Update import:** `packages/core/context-assembly.js` imports from `@mycelium/core/mind-files.js` instead of using raw `fs.readFile`.

### Encrypt/decrypt wrapping

```js
// packages/core/mind-files.js (post-move, post-wrap)
import { encrypt, decrypt, getMasterKey, inferScope, isEncrypted } from './crypto-local.js';

const MAGIC = Buffer.from('MIND', 'latin1');  // 4 bytes, format v1

export function createMindFiles({ agentRoot, agentId, fs, path }) {
  // ... existing arg validation ...

  async function readMindFile(filename) {
    const dir = getMindDir();
    if (!dir) return null;
    let raw;
    try { raw = await fs.readFile(path.join(dir, filename)); }
    catch { return null; }

    // Backwards compat: plaintext files from before encryption rollout.
    // Detect by magic-bytes absence; return raw text. Migration script
    // will eventually convert these. New writes always use the magic.
    if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      return raw.toString('utf-8');
    }

    const envelope = raw.subarray(MAGIC.length).toString('utf8');
    const masterKey = await getMasterKey();
    const scope = inferScope({ path: `mind/${filename}`, agent_id: agentId });
    try {
      return await decrypt(envelope, masterKey, [scope]);
    } catch (err) {
      // Plaintext-free log line per CLAUDE.md §1.
      console.warn(`[mind-files] decrypt failed for ${filename}: ${err.name}`);
      return null;
    }
  }

  async function writeMindFile(filename, content) {
    const dir = await ensureMindDir();
    if (!dir) throw new Error('AGENT_ROOT not configured');
    const finalPath = path.join(dir, filename);
    const parentDir = path.dirname(finalPath);
    if (parentDir !== dir) await fs.mkdir(parentDir, { recursive: true });

    const masterKey = await getMasterKey();
    const scope = inferScope({ path: `mind/${filename}`, agent_id: agentId });
    const envelope = await encrypt(String(content), scope, masterKey);
    const payload = Buffer.concat([MAGIC, Buffer.from(envelope, 'utf8')]);

    const tmpPath = finalPath + '.tmp';
    const fh = await fs.open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(payload);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, finalPath);
  }

  return { getMindDir, ensureMindDir, readMindFile, writeMindFile };
}
```

`snapshotMindFile` ([internal.js:158-190](../packages/tools/agent-tools/domains/internal.js#L158-L190)) is **unchanged** — it does `readMindFile(source) → writeMindFile(dest, source)`. With the wrapper, that becomes `decrypt(source) → encrypt(plaintext) → write` which produces a valid ciphertext snapshot. **Note: the envelope re-encrypts with a fresh IV**, so the snapshot's bytes won't be byte-identical to the source's bytes — but the plaintext content is preserved. (Optional optimization: a `copyMindFile` helper that does literal byte copy at the ciphertext level. Defer.)

### New MCP tools (added to internal domain)

Three tools, each with a single clear purpose. The agent's mental model becomes:

| Operation | Tool | When |
|---|---|---|
| Capture observation (append) | `updateInternalModel` *(existing)* | Any time, especially during conversations and cycle Phase 3 |
| Surgical change (one-line) | `editMindFile` *(new)* | Status flips, hypothesis renames, typos — when target text is unique |
| Whole-file rewrite | `writeMindFileWhole` *(new)* | Phase 3.5 consolidation, rare otherwise |
| Read fresh state | `readMindFile` *(new)* | Phase 3.5 Step 2, or any time the assembled context is stale |
| Trail snapshot (pre-modification) | `snapshotMindFile` *(existing)* | First action of every cycle that touches mind/ |

```js
// packages/tools/agent-tools/domains/internal.js
{
  name: 'readMindFile',
  description: 'Read the current decrypted content of a mind/ file (e.g., "model.md"). Use this in Phase 3.5 of the integration cycle to fetch the latest state of model.md before consolidating, since your assembled context was loaded at cycle start and may be stale after Phase 3 updates.',
  inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
},
{
  name: 'editMindFile',
  description: 'Surgical edit on a mind/ file — same contract as Claude Code\'s Edit but encryption-aware. Decrypts the file, finds `old_string` (which MUST appear exactly once — uniqueness enforced), replaces with `new_string`, re-encrypts and atomically writes. Use for one-line changes, status updates, hypothesis renames, typos. For appends use `updateInternalModel`; for whole-file rewrites use `writeMindFileWhole`. Errors: "old-string-not-found", "old-string-not-unique" (with count), "file-not-found".',
  inputSchema: {
    type: 'object',
    properties: {
      filename:   { type: 'string', description: 'Mind/ filename (e.g., "model.md").' },
      old_string: { type: 'string', description: 'Exact text to find. Must appear exactly once in the file.' },
      new_string: { type: 'string', description: 'Replacement text. Empty string deletes the old_string.' },
    },
    required: ['filename', 'old_string', 'new_string'],
  },
},
{
  name: 'writeMindFileWhole',
  description: 'Atomically write the full decrypted content of a mind/ file (e.g., "model.md"). Encrypts at rest. **Auto-snapshots** the pre-write state to mind/snapshots/<filename>/<YYYY-MM-DD>.md (idempotent first-write-wins) so the pre-edit version is always recoverable. Use for Phase 3.5 consolidation — replaces the previous Claude Code Write tool path. For surgical edits, use editMindFile instead (cheaper).',
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string' },
      content:  { type: 'string' },
    },
    required: ['filename', 'content'],
  },
},
```

All three apply the same path-traversal validation as `snapshotMindFile` (no `..`, no `/` or `\`, non-empty). All delegate to the wrapped helpers; encryption is transparent. `editMindFile`'s uniqueness check is performed on the decrypted plaintext, not on bytes — semantics match Claude Code's Edit exactly.

**`writeMindFileWhole` auto-snapshot semantic.** Before encrypting and writing, the handler calls the same path that `snapshotMindFile` uses — first-write-wins per day. If today's snapshot already exists, the call is a no-op (the pre-cycle anchor is preserved). If it doesn't, the current pre-write state is captured. The agent can't accidentally skip the snapshot by forgetting to call it — the trail is structurally guaranteed. Phase 3.5's explicit Step 1 (`snapshotMindFile('model.md')`) becomes redundant-but-explicit; we keep it in the prompt for clarity, but the safety doesn't depend on the agent remembering.

```js
// Sketch of writeMindFileWhole handler
writeMindFileWhole: async (args) => {
  const filename = String(args?.filename || '').trim();
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return JSON.stringify({ ok: false, error: 'invalid-filename' });
  }
  // Auto-snapshot first (idempotent — no-op if today's snapshot already exists).
  // Errors here are non-fatal; the snapshot is belt-and-suspenders for an
  // already-explicit Phase 3.5 step. Log + continue.
  try {
    await internalHandlers.snapshotMindFile({ filename });
  } catch (err) {
    console.warn(`[writeMindFileWhole] auto-snapshot failed for ${filename}: ${err.name}`);
  }
  await writeMindFile(filename, String(args.content));
  return JSON.stringify({ ok: true });
},
```

### Phase 3.5 prompt rewrite

[scheduler.js:802-846](../packages/core/scheduler.js#L802-L846) currently:

```
Step 1: snapshotMindFile('model.md')
Step 2: Use Read on /home/claude/agents/personal-agent/mind/model.md
Step 3: Use Write to rewrite model.md
Step 4: Use Bash with wc -l to verify smaller
```

Becomes:

```
Step 1: snapshotMindFile('model.md')             ← unchanged
Step 2: readMindFile('model.md')                  ← MCP tool, returns plaintext
Step 3: writeMindFileWhole('model.md', <new>)     ← MCP tool, encrypts on write
Step 4: (omit wc -l; the next cycle's preload shows the size; or call readMindFile again and report .length)
```

`Tool reminder` block at [scheduler.js:848-853](../packages/core/scheduler.js#L848-L853) updated to replace Claude Code's `Edit` reference with the new `editMindFile` MCP tool. Surgical changes (status flips, single-hypothesis renames, typo fixes) continue to work — they just route through MCP for the encrypt/decrypt path.

### Migration script

`scripts/encrypt-mind-files.js` — runs per-host. For each file in `<agentRoot>/mind/` (recursive into `snapshots/` and `weekly-reviews/`):

1. `fs.readFile` → check first 4 bytes
2. If `"MIND"` magic present → already encrypted, skip
3. Else read full content, encrypt with `inferScope({ path: 'mind/<filename>', agent_id: <agentId> })`, atomic write with magic
4. Log: filename + plaintext-bytes + ciphertext-bytes (no content)

Idempotent. Safe to re-run. After a successful migration:
- Run integration cycle once to verify
- `chmod 600` everything in mind/ (defense in depth)

### Customer fleet rollout

Sequence per [docs/DEPLOYING.md](DEPLOYING.md):
1. Land code on admin (PM2 restart picks up new module)
2. Run `node scripts/encrypt-mind-files.js` on admin
3. Verify post-encryption integration cycle on admin (next 03:00 UTC tick or `/think 'fire integration cycle now'`)
4. After 24h observation, ship to customer fleet via `update-customers.sh --restart`
5. Per-host `node scripts/encrypt-mind-files.js` on [customer-handles]

---

## Edge cases — explicit decisions

| Case | Decision | Why |
|---|---|---|
| Decrypt fails on read | Return `null`, agent loses that section in context | Mirrors today's `readFileQuiet` semantic; cycle continues |
| File missing | Return `null` (today's behavior preserved) | No change |
| Already-encrypted detected during migration | Skip | Idempotency |
| Plaintext file read post-rollout (legacy / unmigrated) | Return as plaintext (no magic → bypass decrypt) | Survives partial migration; warn-and-continue |
| Claude Code's built-in Edit tool used on encrypted mind file | Fails (Read sees base64, edit target not found) | Cycle prompts steer to `editMindFile` MCP tool; built-in Edit reserved for non-encrypted files |
| `editMindFile`'s `old_string` not found | Returns `{ ok: false, error: 'old-string-not-found' }` | Same as Claude Code Edit — agent re-reads and retries with correct context |
| `editMindFile`'s `old_string` appears multiple times | Returns `{ ok: false, error: 'old-string-not-unique', count: N }` | Same as Claude Code Edit — agent provides more surrounding context to disambiguate |
| `editMindFile` on a missing file | Returns `{ ok: false, error: 'file-not-found' }` | Distinct from old-string-not-found so caller can branch |
| `writeMindFileWhole` called with no prior snapshot today | Auto-snapshots before write (idempotent first-write-wins) | Pre-edit state always preserved regardless of whether agent remembered Phase 3.5 Step 1 |
| `writeMindFileWhole` called with snapshot already existing today | Auto-snapshot is no-op; write proceeds | First call's pre-cycle anchor is preserved (matches snapshotMindFile semantic) |
| Auto-snapshot fails (e.g., disk full) inside writeMindFileWhole | Log warning, continue with write | Snapshot is belt-and-suspenders; refusing to write would be worse UX. Logged so operator can investigate. |
| Cross-scope decrypt attempt | Throws ScopeViolationError, caught, returns null | Existing scope guardian behavior |
| Snapshot byte-copy semantic | Re-encrypt with fresh IV (still preserves plaintext) | Simpler than literal-byte-copy variant; envelope verifies; defer the copyMindFile optimization |
| Per-host master.key drift | Each host encrypts under its own key; cross-host comparison meaningless (same as everything else) | Status quo |
| `mind/snapshots/` retention | Encrypted indefinitely | Same growth math (130 MB/year); ciphertext doesn't change the size argument |

---

## Implementation order

**Sequencing prerequisite: PR2 (tool retirement, 19 cold-tier tools) lands BEFORE this PR.** That way the deferral budget absorbs the +3 new tools against −19 retired in a single net move; we never run with both surfaces simultaneously bloating the listing. If PR2 hasn't shipped, this PR waits.

Five steps, each independently shippable + smoke-testable:

1. **Move + wrap (PR1).** Move mind-files.js to @mycelium/core, add encrypt/decrypt wrapping with backwards-compat plaintext-pass-through. Add unit tests (encrypt/decrypt roundtrip, plaintext fallback, magic detection). Existing callers transparently encrypted on next write.
   - Smoke: `npm test --workspace @mycelium/core` and `npm test --workspace @mycelium/tools` pass.

2. **Refactor context-assembly.js (PR2).** Replace raw `fs.readFile` with the wrapped helper. Decrypts on read.
   - Smoke: agent-server boots, `/health/context-assembly` (or a chat turn) loads mind files without warnings.

3. **New MCP tools + Phase 3.5 prompt (PR3).** Add `readMindFile` + `editMindFile` + `writeMindFileWhole` to internal domain. Update Phase 3.5 prompt in scheduler.js. Update Tool reminder block to swap built-in `Edit` → `editMindFile` for mind/ paths.
   - Smoke: `/think 'fire integration cycle now'` runs without "Read tool failed" or "Write tool failed" — agent uses MCP tools and the cycle completes. Independent smoke: ask agent to flip a single status line in model.md → expect `editMindFile` invocation, not `writeMindFileWhole`.

4. **Migration script (PR4).** `scripts/encrypt-mind-files.js`. Idempotent. Logs ciphertext byte counts only (no plaintext leak).
   - Smoke: dry-run on a fresh `mind/` test fixture; verify magic + decrypts cleanly.

5. **Per-host execution (deploy).** Admin first → 24h observe → customer fleet. Per-host `chmod 600`.
   - Smoke per host: `head -c 4 mind/model.md | xxd` shows "MIND". `cat mind/model.md` shows base64.

---

## Test strategy

| File | New tests |
|---|---|
| `packages/core/test/mind-files.test.js` (move from tools) | Roundtrip encrypt/decrypt; plaintext-passthrough for files without magic; magic-bytes detection; file mode 0o600; atomic write survives mid-write crash via .tmp orphan |
| `packages/tools/test/agent-tools/domains/internal.test.js` (existing) | Add tests for `readMindFile` + `editMindFile` + `writeMindFileWhole` MCP handlers. `editMindFile` test matrix: success unique match; error on missing; error on not-found; error on multiple matches with count returned; round-trip through encryption (decrypted → edited → encrypted → re-decrypted matches expected) |
| `packages/server/test/lib/context-assembly.test.js` (existing) | Verify decrypted content reaches the assembled context (mock master key in test) |
| `scripts/test/encrypt-mind-files.test.js` (NEW) | Idempotency; mixed plaintext+ciphertext directory handling; no-op when all already encrypted |

---

## Decision criteria for next phase (rollout gate)

Falsifiable, time-bound:

| Step | Criterion | Query |
|---|---|---|
| 5a (admin) → 5b (customer) | 24h post-admin-migration: zero `[mind-files] decrypt failed` warnings in agent-server stderr | `ssh operator-host "grep -c '\\[mind-files\\] decrypt failed' /var/log/mycelium/personal-agent-out.log /var/log/mycelium/personal-agent-error.log"` → expected 0 |
| 5a → 5b | 24h post-admin: at least one integration cycle fired successfully and produced a valid ciphertext model.md | `ssh operator-host "head -c 4 /home/claude/agents/personal-agent/mind/model.md \| xxd \| grep MIND"` → match |
| 5a → 5b | Phase 3.5 cycle's `writeMindFileWhole` returned ok, no Edit/Write tool invocations on mind/* | Inspect last cycle log; no "Write succeeded" lines for paths starting `mind/` |
| 5b complete | All 4 hosts' `head -c 4 mind/*.md` returns "MIND" | Fleet runner |

If any criterion fails — halt rollout, investigate, do not paper over.

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Decryption fails post-migration → agent loses context for that file | Low | Medium (cycle continues without that section) | Backwards-compat plaintext fallback; alarms on consecutive decrypt failures |
| Phase 3.5 prompt change breaks existing cycle | Medium | High (no consolidation = bloat returns) | Trigger manual `/think` after deploy; verify ciphertext + plaintext-via-readMindFile reflect post-cycle state |
| Migration script corrupts a file (interrupted mid-write) | Low | Medium | Atomic `.tmp+rename`; orphan `.tmp` cleanup at boot; per-file try/catch |
| Master key not loaded in MCP child process | Very low | High (every mind read/write fails) | crypto-local's `getMasterKey()` is called lazily; first call reads tmpfs; tested on first read attempt |
| Customer host master.key missing | Low | High | post-provision-audit.sh:233 already checks; provision flow fails-closed |
| Existing snapshot files (plaintext) remain readable post-migration | Medium | Medium | Migration script encrypts snapshots/ recursively |
| Operator forgets to run migration script after code deploy | Medium | Low (writes go ciphertext immediately; reads tolerate plaintext via fallback) | Post-deploy ledger entry: "ran encrypt-mind-files.js"; checked by deploy-and-verify |
| Agent calls `writeMindFileWhole` with mistakenly-truncated content (data loss class) | Low | High before mitigation, Low after | Auto-snapshot inside `writeMindFileWhole` (first-write-wins per day) preserves pre-edit state. Operator restores from `mind/snapshots/<filename>/<YYYY-MM-DD>.md` |
| PR2 hasn't shipped when this PR lands → tool listing temporarily holds 51+3 = 54 tools | Medium (sequencing slip) | Medium (deferral pressure briefly worse) | Implementation order explicitly gates: this PR waits for PR2. Operator confirms PR2 deployed before merging step 3 |
| Plaintext-passthrough branch silently masks a real encryption-write bug | Low | Medium (bug stays hidden longer) | Time-boxed removal — see open question #6 — flip to "no magic = error" once all hosts migrated and 7 days clean |
| isEncrypted false positive on a markdown file starting with `{"v":1,...` | Effectively zero | Low (decrypt fails, plaintext-pass returns content) | Magic bytes prefix is the actual gate, not isEncrypted |

---

## Open questions

1. **Should `mind/weekly-reviews/<date>.md` files be encrypted?** They're written by Claude Code Write tool at [scheduler.js:957](../packages/core/scheduler.js#L957). **Decision: yes.** Same threat surface; agent can write via writeMindFileWhole equally well; cycle prompt updated.
2. **Should the operator-instructions.md file (PR-G future) be encrypted?** **Decision: yes.** Same scope-key, same threat surface. Future PR-G inherits this design.
3. **Stay on envelope v1, or move to v2 (per-user `userId`)?** Mind/ is per-AGENT, not per-user. v1 (no userId) is the right format. Document this so future encryption work doesn't accidentally bump to v2.
4. **Set up post-deploy alert for `[mind-files] decrypt failed` log lines?** Defer — alarm fatigue risk; the rollout-gate criterion already requires zero in 24h.
5. **Should the `copyMindFile` byte-copy optimization land now or later?** Defer. The fresh-IV re-encrypt path is clean and the snapshot once-per-day pattern won't notice the extra encrypt cost.

6. **When do we delete the plaintext-passthrough branch in `readMindFile`?** Not now (rollout safety). **Removal trigger** — all of:
   - admin host: `find ~/agents/personal-agent/mind -type f -name '*.md' | xargs -I{} sh -c 'head -c 4 "{}" | grep -q "MIND" || echo "PLAINTEXT: {}"'` → empty output
   - same query on [customer-handles] → empty output
   - 7 days of clean operation post-migration on all 4 hosts (no `[mind-files] decrypt failed` warnings)
   When all met, ship a follow-up PR ("PR-cleanup") that flips the helper to `if (no magic && file is non-empty) → log + return null` instead of plaintext-passthrough. This closes the window where a future bug could silently write plaintext and have it accepted on read. Track as `project_mind_files_plaintext_pass_removal` in MEMORY.md after this PR ships.

7. **Key rotation: not designed.** This PR ships under the same key-rotation gap as the rest of the codebase (D1, R2, secrets). When operator wants rotation, design a pass that re-encrypts mind/* envelopes under the new master key alongside the D1/R2 rotation. Out of scope here.

---

## Verification table

Every load-bearing assumption from sweeps + my own reads, with a file:line citation I have personally verified.

| # | Assumption | Verified at |
|---|---|---|
| 1 | Helper-mediated callers wire through agent-tools.js:82 | [packages/tools/agent-tools.js:82](../packages/tools/agent-tools.js#L82) |
| 2 | context-assembly.js bypasses helper with raw fs.readFile | [packages/core/context-assembly.js:130-140](../packages/core/context-assembly.js#L130-L140) |
| 3 | Phase 3.5 prompt instructs Claude Code's Read tool on model.md | [packages/core/scheduler.js:807-811](../packages/core/scheduler.js#L807-L811) |
| 4 | Phase 3.5 prompt instructs Claude Code's Write tool on model.md | [packages/core/scheduler.js:813-816](../packages/core/scheduler.js#L813-L816) |
| 5 | Phase 3.5 prompt instructs Bash wc -l on model.md | [packages/core/scheduler.js:843-846](../packages/core/scheduler.js#L843-L846) |
| 6 | Weekly-review prompt writes mind/weekly-reviews/<date>.md via Write | [packages/core/scheduler.js:957](../packages/core/scheduler.js#L957) |
| 7 | encrypt() takes (plaintext, scope, masterKey, userId=null) | [packages/core/crypto-local.js:848](../packages/core/crypto-local.js#L848) |
| 8 | decrypt() takes (encoded, masterKey, allowedScopes=null, opts={}) | [packages/core/crypto-local.js:957](../packages/core/crypto-local.js#L957) |
| 9 | inferScope already maps mind/ paths to 'personal'/'moms' | [packages/core/crypto-local.js:822-827](../packages/core/crypto-local.js#L822-L827) |
| 10 | getMasterKey pins per-process | [packages/core/crypto-local.js:1400-1459](../packages/core/crypto-local.js#L1400) |
| 11 | isEncrypted validates envelope structure (no false positives on .md) | [packages/core/crypto-local.js:438-449](../packages/core/crypto-local.js#L438-L449) |
| 12 | mind-search persist.js is the file-encryption template (magic + atomic) | [packages/core/mind-search/index/persist.js:88-129](../packages/core/mind-search/index/persist.js#L88-L129) |
| 13 | Magic bytes precedent ("MIS1" 4-byte prefix before envelope) | [packages/core/mind-search/index/persist.js:72](../packages/core/mind-search/index/persist.js#L72) |
| 14 | Atomic write pattern: open tmp 0o600 + writeFile + fsync + close + rename | [packages/core/mind-search/index/persist.js:117-126](../packages/core/mind-search/index/persist.js#L117-L126) |
| 15 | Master key per-host generation (not shared) | [scripts/provision-customer.sh:407](../scripts/provision-customer.sh#L407) |
| 16 | Tmpfs path /run/mycelium/master.key | [packages/core/crypto-local.js:54](../packages/core/crypto-local.js#L54) |
| 17 | MCP child inherits parent env including tmpfs read perms | [packages/core/runner.js:322-330](../packages/core/runner.js#L322-L330) |
| 18 | createMindFiles deps include fs.{readFile,writeFile,mkdir,rename} + path.{join,dirname} | [packages/tools/agent-tools/mind-files.js:18-26](../packages/tools/agent-tools/mind-files.js#L18-L26) |
| 19 | Existing writeMindFile already does atomic .tmp+rename | [packages/tools/agent-tools/mind-files.js:56-67](../packages/tools/agent-tools/mind-files.js#L56-L67) |
| 20 | snapshotMindFile is byte-copy via readMindFile + writeMindFile | [packages/tools/agent-tools/domains/internal.js:174-189](../packages/tools/agent-tools/domains/internal.js#L174-L189) |
| 21 | Helper consumers: domains/documents.js (3 sites) + domains/internal.js (3 sites) | [packages/tools/agent-tools/domains/documents.js:462,497,525](../packages/tools/agent-tools/domains/documents.js); [packages/tools/agent-tools/domains/internal.js:97,123,174](../packages/tools/agent-tools/domains/internal.js) |
| 22 | 7 core mind/ files preloaded by context-assembly | [packages/core/context-assembly.js:132-140](../packages/core/context-assembly.js#L132-L140) |
| 23 | 2 D1-mirrored mind/ files via MIND_MIRRORS | [packages/tools/agent-tools/mind-files.js:78-83](../packages/tools/agent-tools/mind-files.js#L78-L83) |
| 24 | 4 fleet hosts: admin, [customer-handles] | [docs/MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md:67-72](MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md#L67) |
| 25 | scripts/migrate-mind.js is one-time, already-shipped (not a live caller) | [scripts/migrate-mind.js:43-48](../scripts/migrate-mind.js#L43) |
| 26 | post-provision-audit checks 64-byte master.key presence | [scripts/post-provision-audit.sh:233-243](../scripts/post-provision-audit.sh#L233) |
| 27 | bootstrap-secrets only decrypts in memory (no disk write precedent there) | [packages/core/bootstrap-secrets.js:86-150](../packages/core/bootstrap-secrets.js#L86) |

---

## Pickup protocol (for the implementing session)

1. Read this design doc top to bottom.
2. Run `git log --oneline -5` — confirm head matches handoff doc.
3. Confirm sweep findings still hold (re-grep one or two — codebase has been moving fast).
4. Execute Implementation order steps 1–4 in separate commits, each with smoke tests passing.
5. After step 4 lands on admin, run `node scripts/encrypt-mind-files.js` on admin.
6. Watch the 24h decision-criteria queries.
7. Roll out to customer fleet per `docs/DEPLOYING.md`.
8. Update [docs/MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md](MIND-MODEL-COMPACTION-HANDOFF-2026-05-07.md) §Security follow-up: mark RESOLVED with deploy-verify ledger.
9. Update MEMORY.md "In Progress" entry: move from ⚠ flag to "shipped" reference.

---

**End of design v2.**
