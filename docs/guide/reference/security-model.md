# Security model

Mycelium stores the most intimate data a person produces — thoughts, relationships,
finances, meaning-making. The security posture *is* the product. If you're integrating
with Mycelium, these are the guarantees you can build on and the boundaries you must
respect.

## The thirteen principles

The codebase is written to a strict rulebook. The ones that matter to integrators:

1. **Zero plaintext leakage.** Encrypted data never appears in logs, error messages,
   HTTP responses, or unencrypted storage. Tool errors return fixed safe strings.
2. **Defense in depth.** Every boundary has at least two independent enforcement
   layers.
3. **Fail closed.** Missing auth → reject. Missing key → refuse to write. Unknown input
   → deny. Never a permissive default.
4. **Master-key discipline.** The key is never in HTTP headers, env that's logged, the
   DB, or logs. It's read at boot and held in memory only.
5. **Embedding vectors are sensitive.** Nomic embeddings are semantic fingerprints of
   plaintext and are encrypted and guarded like plaintext. Embedding-inversion attacks
   are real.
6. **Audit everything, log nothing private.** Every cross-boundary call is traceable;
   PII is never logged. Egress is recorded as a hash, never content.
7. **Explicit-send only.** Agent free-form output is never auto-delivered to a channel;
   all egress goes through one chokepoint (`reply`).

## Encryption

- **At rest:** AES-256-GCM on every sensitive column — message content, metadata,
  documents, attachments (encrypted blob store), **and embedding vectors**. The DB file
  holds only ciphertext.
- **Keys:** generated on-device, never transmitted. Two internal keys (`USER_MASTER` +
  `SYSTEM_KEY`), with `SYSTEM_KEY` derivable from the one recovery key. A per-key Key
  Check Value catches a wrong key before any data is touched.
- **Unlock:** at boot, from keychain / env / 1Password. Wrong or missing key → the
  process **exits**. There is no runtime "unlock the vault over HTTP" path.

## The auth boundary

| Surface | Auth |
|---|---|
| **stdio MCP** | No network. Security is the keys — the vault won't open without them. |
| **HTTP MCP (`/mcp`)** | OAuth 2.1 + PKCE *or* static bearer. No/invalid token → `401` + RFC 9728 `WWW-Authenticate`. |
| **Model gateway (`/v1/*`)** | Same bearer/OAuth. Never runs unauthenticated. |
| **REST (`:8787`)** | **None — loopback only.** The machine is the boundary. Never expose it. |
| **Public publish (`:8788`)** | Serves only explicitly-published documents. Fail-closed. |

> **OAuth note.** Dynamic Client Registration is open (anyone reachable can *register* a
> client), but `authorize` still requires your password — that's the real gate. Only
> run `--http` behind Tailscale / Cloudflare Tunnel with a strong
> `MYCELIUM_USER_PASSWORD`.

## Untrusted input

Imports run on attacker-influenceable files, so the parser:

- reads only the known entry — no archive-path writes (**no zip-slip**),
- caps decompressed size with a streaming abort (**no decompression bombs**),
- bounds in-memory chunk assembly (**no memory-exhaustion DoS**),
- never echoes file contents in errors,
- confines local-folder imports to an allowlist — a supplied `folderPath`/`dirPath` is
  `realpath`-resolved and must sit inside your Obsidian vaults, `~/.claude/projects`, or
  an explicit `MYCELIUM_IMPORT_ALLOWED_ROOTS` grant (**no reading arbitrary paths or
  symlink-escaping out of the allowed roots**).

Proven by `npm run verify:import-security` and `npm run verify:import-confinement`.

## Inference egress

If you route inference through the [gateway](gateway-and-embeddings.md):

- **Jurisdiction gating** — pick which providers/countries are allowed.
- **`X-Mycelium-Sensitive: true`** — hard-blocks a request from US providers, forces
  the local model.
- **Local embeddings** — `/v1/embeddings` never leaves the box.
- **Hash-only audit** — every outbound call logged as sha256 + length, never content.

## Sensitive & forget — honoring user intent

Two user controls that your integration must respect, because the vault enforces them:

- **`sensitive`** items are excluded from `getContext` and `relatedTo` proactive
  recall, and can never be published. They surface only on explicit search.
- **`forget`** destroys content *and* embedding fingerprints, evicts from search and
  clustering, and tombstones for audit. There is no undo. If a user forgets something,
  it's gone — don't cache it.

## What you should *not* do

- Don't log or cache plaintext you pull via `/context`, `getContext`, or
  `searchMindscape`. The vault hands you decrypted text on the assumption you'll treat
  it with the same care it does.
- Don't expose `:8787` or `:4711` to a network without auth + TLS in front.
- Don't deliver agent output to a channel except through the `reply` chokepoint.
- Don't store the user's key. You never need it — the server holds it; you hold a bearer
  at most.

## Verifying the guarantees

The security posture isn't aspirational — it's gated. Relevant verifiers:

```
verify:account          key unlock, KCV, fail-closed boot
verify:passphrase-lock  the optional app passphrase seal
verify:oauth            full OAuth 2.1 + PKCE dance
verify:import-security  zip-slip / bomb / DoS adversarial suite
verify:backup           zero-knowledge archive + no-empty-vault guard
verify:agent-capture    consent gate for agent-source capture
```

---

The discipline, in one line: **never claim something is secure without a verifier that
reached `VERDICT … EXIT=0`.** Your keys, your box, your rules — Mycelium is the
membrane, and it doesn't keep a copy.
