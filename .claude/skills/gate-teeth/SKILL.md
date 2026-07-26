---
name: gate-teeth
description: >-
  Use whenever you write or modify a verify gate, or before claiming a gate proves
  anything — "the gate is green", "verified", "this is covered". Enforces that a gate
  must be mutation-tested: break the specific thing it claims to catch, confirm it REDs,
  restore, and record the mutation in the script as a `// MUTATION-TESTED:` line. A gate
  that has never failed on the bug it targets is an assertion about a fixture, not
  evidence about the product — and a passing gate actively suppresses suspicion, which
  is how three gates in this repo stayed green for the wrong reason (one inside the very
  PR fixing the previous instance). Gated by `npm run verify:gate-teeth`, which ratchets:
  a new gate cannot land without a record, and the legacy exemption list may only shrink.
---

# Gate teeth

**A gate is not evidence until you have watched it fail.**

## Why

`M-001` in the QA defect ledger. Three gates were found green for the wrong reason in one
session:

| Gate | Why it was green |
|---|---|
| `verify:provider-import` **P13** | asserted `!('taskModels' in settings)` — true only because the import had *destroyed* the vault's own value. It passed by observing the bug it was written to catch. Found **inside the PR fixing the previous instance of this pattern** |
| **C7i** (quarantine byte cap) | only ever exercised the unknown-key path, so a bundle naming the key directly wrote 614 KB unreported while the gate stayed green |
| **ON-3c** | asserted a true property but *measured* it across an `await`, so a background poll tick decided the result. Green or red by timing, not behaviour |

A passing gate suppresses suspicion. That is precisely why these survived multiple reviews.

## The procedure

1. **Name the mutation** — the specific change to *product* code that the gate exists to catch.
   Not "delete the file"; the actual defect. If you cannot construct one, the gate is asserting
   shape rather than behaviour — fix the gate, not the record.
2. **Apply it.** Snapshot first (`cp`), never `git checkout --`.
3. **Run the gate. Confirm it REDs**, and that it reds on the *check you expected*, not incidentally.
4. **Restore, and confirm GREEN** on the restored tree. A mutation you cannot undo cleanly means the
   test wasn't isolated.
5. **Record it** in the gate script:

   ```js
   // MUTATION-TESTED: <what was broken> → <which check REDs>
   ```

   One line per mutation, at least one per gate.

## Rules

- **Write the record only if you ran the mutation.** A fabricated record is the M-001 failure with
  extra steps, and it is worse than no record because it manufactures confidence.
- **Do not trust an existing comment that claims a mutation.** In this repo those claims have been
  wrong more than once, and a comment can even satisfy a gate's own regex.
- **Multi-check gates need a mutation per meaningful check**, not one for the file.
- **Never add a new gate to `scripts/gate-teeth-baseline.json`.** That list is the legacy floor and
  may only shrink. Add teeth instead.
- **Retiring a baseline entry is welcome work** — harden a legacy gate, record the mutation, delete
  its line. Each retirement is permanent.

## Gate

```bash
npm run verify:gate-teeth
```

`T1` a gate outside the baseline with no record · `T2` the ratchet was raised · `T3` an exempt gate
quietly gained a record without leaving the list · `T4` the baseline names a file that no longer
exists.

It **cannot** verify that a recorded mutation was executed, or that it RED for the stated reason.
It forces the claim to be written where a reviewer will see it. The verification is yours.

## Related

`/defect-ledger` — the CLOSED bar requires a gate that fails on the old behaviour, which is this
skill. `/deploy-and-verify` — runs the gates. This skill is what makes their green mean something.
