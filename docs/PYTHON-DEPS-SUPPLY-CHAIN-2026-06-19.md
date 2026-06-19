# Python dependency supply-chain — findings + fix (2026-06-19)

Pre-publish supply-chain pass on the bundled Python pipeline (`pip-audit` + pinning review).
npm side was clean (signatures verified, no compromise). Python has **one real CVE finding**
+ a **pinning/reproducibility gap**.

## 🔴 FINDING 1 — `cryptography<45` ships 4 known CVEs and blocks every fix (MUST-FIX before publish)

`pipeline/requirements.txt` has `cryptography>=42,<45`. A fresh build resolves **`cryptography==44.0.3`**,
which `pip-audit` flags with 4 advisories — and **all fixes are above the `<45` cap**, so the
constraint prevents patching:

| Advisory | Impact | Fixed in |
|---|---|---|
| GHSA-537c-gmf6-5ccf | Vulnerable OpenSSL statically linked in the wheel (OpenSSL secadv 2026-06-09). Broadest — affects wheel users regardless of API used. | **48.0.1** |
| CVE-2026-26007 | EC public key not checked for prime-order subgroup → ECDSA forgery / ECDH private-key bit leak (SECT curves). | 46.0.5 |
| PYSEC-2026-35 | DNS name-constraint bypass (uncommon X.509 topology; med-low). | 46.0.6 |

`cryptography` is used in the pipeline to **decrypt vault data** for clustering (the `_dec_float`/
SEC-3 path), so a vulnerable copy in the bundle is in-scope.

**Fix:** change `cryptography>=42,<45` → **`cryptography>=48.0.1`**. The `<45` cap is stale (the dev
venv already runs 48.0.0 fine, so 48.x is compatible — note 48.0.0 itself is vulnerable to
GHSA-537c; require ≥48.0.1). Then re-run the pipeline smoke (`pipeline/run-clustering.sh` /
`verify:cluster-embed`).

> **As-built (shipped):** `cryptography>=48.0.1,<49`. An open floor resolves to **49.0.0**, which
> dropped Intel/universal2 macOS wheels (arm64-only) and would force a Rust/OpenSSL **source build**
> on the x86_64 bundle runner — the exact problem the original `<45` cap was protecting against.
> 48.0.1 still publishes `macosx_10_9_universal2` (cp39-abi3), so **both** the arm64 and x86_64
> bundles install from a wheel, and it clears all four CVEs (pip-audit: 0). The `<49` cap is a
> wheel-availability guard, not a security one — revisit it if the Intel bundle is retired or once
> cryptography republishes universal2/x86_64 wheels.

## 🟠 FINDING 2 — deps are floating + un-hashed → non-reproducible, future-malicious-release risk

`requirements.txt` (17 deps) and `requirements-transcribe.txt` are all `>=` with no hashes;
`requirements-embed.txt` is already pinned `==` (good model). Bundled into the shipped `.app`, this
means non-reproducible builds + a future compromised release could be pulled at build time.

### Fix — pin + hash-lock with pip-tools (keep loose source → compiled lock)

1. Keep the human-edited loose lists as the *source* (the existing `requirements*.txt`, with Finding-1's
   `cryptography>=48.0.1` applied).
2. Generate a fully-pinned, all-transitive, hash-verified lock **on the target build arch**
   (arm64 for the launch; regenerate per-arch when Linux/Windows are added):
   ```bash
   pip install pip-tools
   pip-compile --generate-hashes --strip-extras \
     --output-file pipeline/requirements.lock.txt \
     pipeline/requirements.txt pipeline/requirements-embed.txt
   ```
   (Transcription deps can be a second lock if they ship separately.)
3. Switch the bundle build to install from the lock with hash enforcement —
   `scripts/build-app-bundle.sh`, the `ensure_python` pip step:
   ```diff
   -  "$RT/python/bin/python3" -m pip install --quiet --disable-pip-version-check \
   -     -r "$REPO/pipeline/requirements.txt" -r "$REPO/pipeline/requirements-embed.txt"
   +  "$RT/python/bin/python3" -m pip install --quiet --disable-pip-version-check \
   +     --require-hashes -r "$REPO/pipeline/requirements.lock.txt"
   ```
   `--require-hashes` is all-or-nothing: any missing/mismatched hash fails the build. Update the
   `reqhash` cache key (currently hashes `requirements.txt`+`requirements-embed.txt`) to hash the lock.
4. Commit `pipeline/requirements.lock.txt`. Builds are now byte-reproducible + tamper-verified.

> **As-built (shipped):** lock generated on arm64 / Python 3.12.13 (the launch arch).
> `ensure_python`'s pip step now installs `--require-hashes -r pipeline/requirements.lock.txt`, and
> the `reqhash` cache key hashes the lock file (not the loose lists). Dry-run install passed all hash
> checks (EXIT 0); `pip-audit -r pipeline/requirements.lock.txt --require-hashes` = 0. Note the lock
> is arch/python-specific — regenerate it on the target arch when x86_64/Linux/Windows bundles are
> built (the universal2 cryptography wheel hash is present, so x86_64 installs from a wheel, but other
> deps resolve per-arch).

## 🟢 FINDING 3 — wire `pip-audit` into CI (ongoing)

We ran `pip-audit` by hand here; add it to `verify.yml` (or a scheduled job) so future Python CVEs
surface automatically — the Python equivalent of `npm audit`:
```bash
pip install pip-audit && pip-audit -r pipeline/requirements.lock.txt --require-hashes
```

> **As-built (shipped):** `.github/workflows/verify.yml` now has a standalone **`audit`** job
> (separate from `verify`, so a dep-CVE gives its own red signal) that installs `pip-audit` in an
> isolated venv and runs `pip-audit -r pipeline/requirements.lock.txt --require-hashes` on every
> PR/push. A future advisory against any pinned wheel fails the next build instead of shipping
> silently. The `verify` job's Tier-1 test venv was also bumped `cryptography>=42` → `>=48.0.1,<49`
> to match the shipped floor.

## Sequencing
- **Finding 1 (cryptography bump)** rides the pre-freeze must-fix pass (it's a shipped CVE).
- **Finding 2 (hash-lock)** is the same pass or an immediate fast-follow — it also *enforces* Finding 1.
- **Finding 3 (CI)** is post-launch hygiene.

> Audit method: `pip-audit -r pipeline/requirements.txt --desc on` under a Python 3.12 interpreter
> (the pipeline target). Auditing the dev's *installed* venv (drifted to cryptography 48.0.0) is
> misleading — audit what a fresh build *resolves* from the spec.
