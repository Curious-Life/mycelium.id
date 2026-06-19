# Security Policy

Mycelium stores the most intimate data a person produces — thoughts, reflections,
relationships, finances, meaning-making — encrypted on the user's own machine. We
treat every report with the seriousness that implies.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via **GitHub Private Vulnerability Reporting** — on this
repository, go to the **Security** tab → **Report a vulnerability**. This opens a
private advisory only you and the maintainers can see.

Please include: a description, the affected component (e.g. encryption-at-rest,
key handling, the MCP/OAuth surface, egress, the embedding pipeline), reproduction
steps or a proof-of-concept, and the impact you foresee.

We aim to acknowledge within **72 hours** and to provide a remediation timeline
after triage. We will credit reporters who wish to be named once a fix ships.

## Scope

In scope — anything that could expose vault data or break a security boundary:

- **Encryption** — the AES-256-GCM envelope, the whole-database at-rest
  (SQLCipher) layer, key derivation, and the Key Check Value (KCV) interlock.
- **Key handling** — the recovery key / master-key lifecycle, Keychain storage,
  and any path where a key could leak (logs, errors, responses, env).
- **Auth & transport** — OAuth 2.1 / PKCE, the local REST + portal surface, and
  the remote (Tailscale/Tunnel) surface.
- **Egress** — the explicit-send chokepoints; any path that delivers agent output
  without going through them.
- **Embeddings** — the vectors are semantic fingerprints of plaintext; inversion
  or leakage of embedding data is in scope.

Out of scope — issues that require an attacker who already has full local control
of the user's machine and logged-in OS session (Mycelium is a single-user,
local-first vault; same-user OS trust is assumed), and findings in third-party
dependencies that are already publicly tracked upstream.

## Our principles

Mycelium is built fail-closed: missing auth rejects, a missing key refuses to
write, and encrypted data must never appear in logs, errors, responses, or
unencrypted storage. If you find a place where that is not true, that is a
vulnerability — please tell us.

## Supported versions

Mycelium is pre-1.0 and ships from the latest release. Security fixes target the
most recent release; please test against it before reporting.
