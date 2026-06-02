# Design — Fresh-user pipeline provisioning + honest, actionable Generate failure (2026-06-02)

Built with the **sweep-first-design** protocol (`.claude/skills/sweep-first-design/SKILL.md`).
Three parallel Explore sweeps + my own reads of every cited line. The sweep moved
the design off its v1 sketch (see Revision history) — the naive "make `setup.sh`
install both requirements files" is necessary but **insufficient** and **mis-scoped**.

---

## Problem

A brand-new user who follows the documented setup gets a `pipeline/.venv` that can
**embed** but **cannot cluster**, so the very first **Generate** dies. Today on this
machine Generate only works because the clustering deps were `pip install`-ed by hand
mid-session — a fresh user has no such luck, and the failure they'd see is opaque.

Root facts (all verified by direct read — see Verification table):
- `pipeline/setup.sh` installs **only** `requirements-embed.txt` (4 pkgs). It never
  installs `requirements.txt` (the heavy topology stack: faiss, igraph, leidenalg,
  scipy, scikit-learn, umap, ripser, **python-dotenv**, cryptography…).
- Stage 2 (`cluster.py`) hard-imports `python-dotenv` at **module level**
  (`cluster.py:37`) → the first `ModuleNotFoundError` is `dotenv`, *before* faiss.
- The Generate preflight (`portal-mindscape.js:278-313`) checks only embedded-message
  count — never Python deps. A deps-missing run spawns, churns, and dies async; the
  user sees `ModuleNotFoundError: No module named 'dotenv' (exit 1)` with **no hint**.

## Scope decision (the sweep's biggest finding)

There are **two tiers** of provisioning gap. This change deliberately addresses only
Tier A and **explicitly defers** Tier B (named so it can't ambush a later phase).

- **Tier A — dev / local-checkout provisioning (IN SCOPE).** The supported way to run
  today is a git checkout with `MYCELIUM_HOME=<repo>` (the `cargo tauri dev` recipe).
  Here `pipeline/` and `pipeline/.venv` exist; the only gap is that `setup.sh` under-
  provisions them and the failure is unhelpful. Fixable now, fully verifiable here.

- **Tier B — packaged `.app` Python provisioning (DEFERRED).** `tauri.conf.json`
  bundles **no** `pipeline/` (`bundle` has only `active/targets/category/icon`; no
  `resources`, `externalBin`, or `beforeBuildCommand`), and `main.rs` resolves the
  interpreter from `mycelium_home()` = `MYCELIUM_HOME` → `resource_dir()/app` → `"."`
  (`main.rs:48-56,94-99`). So a distributed `.app` has neither `pipeline/` nor a venv —
  Generate (and the embed service) can't run there at all, regardless of `setup.sh`.
  Closing this means shipping Python (bundle `pipeline/` as a resource + a relocatable
  venv, or PyInstaller/`uv`, or a first-run installer) — a separate, large effort.
  **Out of scope here; tracked in "Deferred".** Fixing `setup.sh` does not pretend to
  solve it.

## Design (v2)

Three coordinated changes — provision at the source, fail honestly if still missing,
and make the docs true.

### 1. `pipeline/setup.sh` — install both sets; clustering is NON-FATAL
After the (required, fatal) embed install, also `pip install -r requirements.txt`, but
**non-fatally**: `requirements.txt`'s own header warns these are heavy native wheels
that "may fail on constrained/sandboxed hosts." A failure there must NOT abort embed
provisioning (the critical path) — it warns and continues. Opt out entirely with
`PIPELINE_SKIP_CLUSTER_DEPS=1` (mirrors the existing `EMBED_SKIP_WARMUP` flag). The
`if … then` guard keeps a failed install from tripping `set -e`.

### 2. `pipeline/run-clustering.sh` — fast deps preflight before Stage 1
Right after `$PYTHON` is chosen (`:45-48`) and before Step 1 (`:56`), probe the
pipeline's hard imports in one shot (Stage-2 clustering libs **plus** Stage-5
`cryptography`):
```sh
"$PYTHON" -c "import numpy,dotenv,cryptography,faiss,igraph,leidenalg,scipy,sklearn,umap" 2>/dev/null
```
On failure, print **one actionable line to stderr** and `exit 3`. Because `jobs.js`
surfaces the **last** stderr line verbatim (`jobs.js:107,117-122`), that line becomes the
user-facing error — `Generate needs the clustering deps: run  bash pipeline/setup.sh
(or pipeline/.venv/bin/python3 -m pip install -r pipeline/requirements.txt)` — instead
of an opaque `No module named 'dotenv' (exit 1)`, and it fails in ~1s rather than after
a doomed multi-minute run.

Also add a **`$PYTHON` override seam**: only auto-select the venv when `$PYTHON` is
unset, so an explicit `PYTHON=/usr/bin/python3` (deps-less) makes the negative path
testable and gives operators a manual override. (Safe: `jobs.js`'s child-env allowlist
does not pass `PYTHON`, so this affects only manual/test runs, never the app.)

Why here and not the node preflight: `run-clustering.sh` already owns `$PYTHON` and is
the single choke-point before all 5 stages. Putting the probe in `portal-mindscape.js`
would duplicate interpreter resolution + the dep list and add a python spawn to the
request path. The node preflight stays as-is (it owns the embed-count case well).

### 3. Docs + verify hints — make them true
- `docs/SETUP.md`: add a short "Generate (topology map)" provisioning note next to the
  existing embed step — `bash pipeline/setup.sh` now provisions it (or the explicit
  `pip install -r pipeline/requirements.txt`); flag it as heavy/optional and
  dev/local-checkout only (point at Tier B).
- `docs/EMBED-SERVICE-NOTES.md:18`: the Files table says `requirements.txt` contains
  `(numpy, onnxruntime, tokenizers, huggingface-hub)` — **stale/wrong** (that's
  `requirements-embed.txt`). Correct it + add a `requirements-embed.txt` row.
- `scripts/verify-topology.mjs:180`: upgrade the skip hint to the exact install command.
  (`verify-embed.mjs:175`'s "run pipeline/setup.sh" is correct for embed — leave it.)

## Module shape / LOC budget (±20%)
| File | Change | ~LOC |
|---|---|---|
| `pipeline/setup.sh` | non-fatal clustering install + flag + header/usage | +22 |
| `pipeline/run-clustering.sh` | `$PYTHON` override seam + deps probe + actionable exit | +12 |
| `docs/SETUP.md` | Generate-provisioning subsection | +10 |
| `docs/EMBED-SERVICE-NOTES.md` | fix stale row + add embed row | +3 |
| `scripts/verify-topology.mjs` | exact-command hint | +1 |
| **Total** | 5 files, mostly comments/docs + 2 small shell blocks | **~48** |

No source/`src/` runtime code changes. No new deps. No crypto/auth/egress surface.

## Edge cases — explicit decisions
- **Heavy wheels fail to build on a host** → embed still provisions (non-fatal); probe
  later emits the actionable line; Generate fails soft. Chosen over fatal install.
- **`persim` declared-but-unimported; `httpx` NOT imported anywhere** (verified by
  repo-wide grep: the only module-level third-party imports across `pipeline/*.py` are
  numpy/dotenv/cryptography; `d1_client.py:29` uses stdlib `sqlite3`) → probe checks
  only real hard deps; leave `requirements.txt` as-is.
- **`cryptography` is hard, not optional** → `crypto_local.py:37-40` imports it
  module-level unguarded, and Stage 5 (`compute_information_harmonics.py:56-60`)
  imports `crypto_local` module-level unguarded. Without it Stages 1-4 can succeed and
  Stage 5 hard-crashes — so the probe MUST include `cryptography` (it failed-late, the
  worst kind). `cluster.py:491-494` guards `crypto_local`, so Stage 2 alone wouldn't
  prove it; Stage 5 does.
- **`ripser`/`psutil` missing** → both guarded (Stage 5 H0 degrades to NULL via
  `harmonics.py`; `psutil` is `try/except ImportError: pass` at `cluster.py:324-329`) →
  probe does NOT include them (don't block Generate on an optional metric / memory log).
- **Re-running `setup.sh` on a provisioned venv** → pip no-ops; idempotent.
- **`set -e` + probe** → use `if ! "$PYTHON" -c …; then …; exit 3; fi` (condition
  context is exempt from `-e`); actionable line printed last so jobs.js surfaces it.

## Test strategy
- `bash -n` on both shell scripts (syntax).
- **Probe negative** (no full venv needed): `PYTHON=/usr/bin/python3 USER_MASTER=<hex>
  SYSTEM_KEY=<hex> MYCELIUM_DB=/tmp/x.db bash pipeline/run-clustering.sh` → expect the
  actionable stderr line + `exit 3`, before any DB access. Confirms jobs.js would
  surface it.
- **Probe positive / happy path**: the provisioned venv on this machine passes the probe
  and the full run still produces the mindscape (already 132 nodes) — re-run on the test
  vault to confirm the probe doesn't regress the happy path.
- `npm run verify:topology` + `verify:generate` + `verify:embed` stay green (none run
  `setup.sh`; topology probes deps and runs since they're present here).
- `setup.sh` exercise: `EMBED_SKIP_WARMUP=1 bash pipeline/setup.sh` → both installs run
  (no-ops here), flag logic parses, non-fatal wrapper holds.

## Risks + mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Clustering wheels fail on a fresh host | Med | Med (no Generate) | Non-fatal install + actionable probe + docs; embed still works |
| Probe dep list drifts from cluster.py imports | Low | Low | Probe mirrors the Stage-2 hard imports; comment links the two |
| `PYTHON` override seam misused in app | Very low | Low | jobs.js allowlist never passes `PYTHON`; affects manual runs only |
| Doc says "works" but packaged app still can't | Med | Med | SETUP.md note scopes it to dev/local-checkout + points at Tier B |

## Open questions resolved during the sweep
- *Is the first failure `faiss`?* No — `python-dotenv` (module-level, `cluster.py:37`).
- *Is fixing `setup.sh` enough?* For dev/local-checkout, yes; for a packaged `.app`,
  no (Tier B — `pipeline/` isn't bundled).
- *Where should the actionable error live?* `run-clustering.sh` (owns `$PYTHON`, single
  choke-point; jobs.js already surfaces the last stderr line).

## Deferred (named, out of scope)
- **Tier B: packaged-app Python provisioning** — bundle `pipeline/` + a relocatable
  venv (or PyInstaller/`uv`/first-run installer) so a distributed `.app` can embed +
  cluster. Large; its own design.
- **In-app first-run readiness UI** ("clustering not provisioned — [Install]") — nice,
  but depends on Tier B's delivery mechanism.
- Auto-`pip install` from the app at runtime — rejected (slow, network at click-time,
  surprises the user; provisioning belongs in setup, not the request path).

## Verification table
| Assumption (load-bearing) | Verified at (read myself) |
|---|---|
| `setup.sh` installs only `requirements-embed.txt` | `pipeline/setup.sh:35` |
| `requirements.txt` = heavy topology stack incl. dotenv/cryptography | `pipeline/requirements.txt:15-43` |
| `cluster.py` imports `dotenv` at module level (first failure) | `pipeline/cluster.py:36-37` |
| `cluster.py` `run_clustering` imports `scipy`+`umap` unguarded (main path) | `pipeline/cluster.py:794-795` |
| `crypto_local` imports `cryptography` module-level, unguarded | `pipeline/crypto_local.py:37-40` |
| Stage 5 imports `crypto_local` module-level (→ `cryptography` is a hard dep) | `pipeline/compute_information_harmonics.py:56-60` |
| Repo-wide, the only module-level 3rd-party imports = numpy/dotenv/cryptography; `httpx` absent | grep `^(import\|from)` over `pipeline/*.py`; `d1_client.py:29`=sqlite3 |
| `run-clustering.sh`: `set -e`, cd repo root, `$PYTHON` select, Stage 2/5 python | `pipeline/run-clustering.sh:26-27,45-48,61,75` |
| `jobs.js` surfaces the **last** stderr line as `state.error` | `src/jobs.js:104-107,117-122` |
| Generate preflight checks embed-count only, never deps; 503 catch is sync-only | `src/portal-mindscape.js:278-313` |
| `tauri.conf.json` bundles no `pipeline/` (no resources/externalBin/beforeBuild) | `src-tauri/tauri.conf.json:1-27` |
| `main.rs` resolves interpreter/cwd from `mycelium_home()`; embed py = `home/pipeline/.venv` | `src-tauri/src/main.rs:48-56,65-67,94-99` |

## Implementation order (each independently shippable)
1. `run-clustering.sh` probe + `$PYTHON` seam → `bash -n` + negative/positive probe test.
2. `setup.sh` both-installs (non-fatal) + flag → `bash -n` + `EMBED_SKIP_WARMUP=1` run.
3. Docs (`SETUP.md`, `EMBED-SERVICE-NOTES.md`) + `verify-topology.mjs` hint.
4. `verify:topology`/`generate`/`embed` green; commit on a branch → PR (squash, like #36/#40).

## Revision history
- **v1 (pre-sweep sketch):** "Make `pipeline/setup.sh` install both requirements files."
- **v2 (post-sweep):** PIVOT. (a) The first missing dep is `python-dotenv`, not faiss →
  probe the whole Stage-2 set. (b) Add a fail-fast **actionable** deps probe in
  `run-clustering.sh` (the existing failure is honest but unhelpful + slow). (c) **Scope
  split** — a packaged `.app` bundles no `pipeline/`, so `setup.sh` alone can never make
  the shipped app work; that's Tier B, explicitly deferred, not silently implied fixed.
  (d) Docs (`SETUP.md` silent on Generate provisioning; `EMBED-SERVICE-NOTES.md:18`
  stale) folded in for consistency.
- **v3 (comprehensive import audit — per "verify all assumptions"):** enumerated EVERY
  module-level third-party import across `pipeline/*.py` instead of trusting the sweep.
  Result: added **`cryptography`** to the probe (Stage 5's `crypto_local` import is
  module-level + unguarded → omitting it = probe passes, Stage 5 still crashes — the
  precise bug we're preventing). Confirmed `umap`+`scipy` are unguarded in
  `run_clustering` (keep). Confirmed `httpx` is **not imported anywhere** (`d1_client`
  uses stdlib `sqlite3`) and `ripser`/`psutil` are guarded → all excluded. Final probe
  = `numpy, dotenv, cryptography, faiss, igraph, leidenalg, scipy, sklearn, umap` (9).
