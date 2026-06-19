# Contributing to Mycelium

Thanks for your interest. Mycelium is a self-hosted, single-user cognitive vault —
a security-critical, local-first application. Contributions are welcome; please
read this first so your change lands smoothly.

## Ground rules

- **Security first.** This codebase stores deeply personal data. Encrypted data
  must never appear in logs, errors, HTTP responses, or unencrypted storage. Code
  fails closed: missing auth rejects, a missing key refuses to write. If a change
  touches encryption, key handling, auth, egress, or the embedding pipeline, say so
  explicitly in your PR. See [SECURITY.md](SECURITY.md).
- **License.** Mycelium is **AGPL-3.0**. By contributing you agree your work is
  licensed under the same terms.
- **Be kind.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Getting set up

You need **Node.js 22+** (see `.nvmrc`) and a native build toolchain
(`better-sqlite3` compiles a native addon). Full, verified steps are in
**[docs/SETUP.md](docs/SETUP.md)** — start there.

```bash
git clone https://github.com/Curious-Life/mycelium.id.git
cd mycelium.id
npm install
npm run init-db
npm run set-keys      # generates + stores your local encryption keys
```

## The verification gate

Every change must keep the verification suite green:

```bash
npm run verify
```

Each suite prints `VERDICT: GO` and exits 0. The Tier-1 suites pass on a clean
machine with no ML stack; the semantic-search / topology suites additionally need
the Python embedding + clustering stack (see docs/SETUP.md §8). **Do not** submit a
PR that leaves `verify` red, and never bypass hooks (`--no-verify`) to get around a
security check.

If you change a specific surface, run its focused gate first — e.g.
`npm run verify:mcp`, `verify:egress`, `verify:at-rest` — then the full suite
before opening the PR.

## Branching, commits, and PRs

- Branch off `main` with a descriptive prefix: `feat/…`, `fix/…`, `chore/…`,
  `docs/…`.
- Write clear, scoped commits. The maintainers append a
  `Co-Authored-By:` trailer to AI-assisted commits — keep that convention if you
  use an assistant.
- Open a PR against `main`. CI runs `npm run verify`; it must be green.
- Keep PRs focused. A bug fix and a refactor are two PRs.
- **Security-sensitive diffs require human review** regardless of CI — flag them.

## Reporting bugs / requesting features

Use the issue templates (bug report / feature request). For **security
vulnerabilities, do not open an issue** — follow [SECURITY.md](SECURITY.md).

## Questions

Open a discussion or a (non-security) issue. We appreciate the help.
