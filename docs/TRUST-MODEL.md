# Mycelium Trust Model

**Date**: 2026-04-07

---

## What Mycelium encrypts

All user content is encrypted with AES-256-GCM using per-scope keys derived from a master key. The master key exists **only** on the VPS — it never leaves the server, is never transmitted over HTTP, and is never stored in Cloudflare infrastructure.

**Encrypted fields** (invisible to infrastructure providers):
- Message content, thinking, entity summaries
- Document content
- Attachment metadata
- Contact names, emails, companies, positions, LinkedIn URLs
- Clustering point embeddings (nomic_embedding blobs)
- Territory essences, chronicles, story arcs, entity lists, patterns
- Secret values (API keys, tokens)
- User display names, signatures (in user_profiles)

## What Mycelium does NOT encrypt

Operational metadata remains unencrypted for query functionality:

- **Account existence**: user IDs, handles, email addresses (for login)
- **Timestamps**: message created_at, updated_at, connection dates
- **Structural data**: territory IDs, realm IDs, cluster assignments, territory names (for public profiles)
- **Activity patterns**: message counts, territory counts, NLP processing flags
- **Connection graph**: who is connected to whom (connection IDs, status)
- **Federation logs**: which instances communicated, when, what actions
- **Agent metadata**: which agent processed a message, agent IDs

## Who can see what

### Managed hosting (Cloudflare D1 + Workers)

| Actor | Can see | Cannot see |
|-------|---------|------------|
| **You** (instance owner) | Everything — master key is yours | — |
| **Cloudflare** | Unencrypted D1 columns (timestamps, handles, counts, connection graph, territory names for public profiles) | Any AES-256-GCM encrypted field (content, embeddings, entities, chronicles, secrets) |
| **Connected users** | Your public territory names + essences, cognitive stats, handle, signature | Your messages, contacts, encrypted fields, private territories, embeddings |
| **Federation peers** (remote instances) | Your public profile, territory labels you chose to share, overlap scores | Everything else — same boundary as connected users |
| **mycelium.id registry** (if opted in) | Your instance URL, public key, user count | Nothing about your data — the registry stores instance metadata only |

### Self-hosted (your own VPS + your own Cloudflare account)

| Actor | Can see | Cannot see |
|-------|---------|------------|
| **You** | Everything | — |
| **Cloudflare** (your account) | Same D1 metadata as above | Encrypted fields |
| **Your VPS provider** | Disk contents (but encrypted fields are ciphertext) | Decrypted content (master key is in memory only, not on disk in plaintext) |

### Fully self-hosted (no Cloudflare)

If you run your own database and Workers-compatible runtime, Cloudflare sees nothing. The encryption layer works identically — the trust boundary moves to your own infrastructure.

## Honest summary

> Your content is encrypted and invisible to infrastructure providers. Metadata — account existence, activity timestamps, connection graph structure, and territory names you've set to public — is visible to Cloudflare (managed hosting) or your own infrastructure (self-hosted).

Self-hosted instances eliminate the Cloudflare dependency entirely.

## Future improvements

- **Encrypt territory labels at rest**: Currently territory names in `territory_profiles` are unencrypted (needed for public profile queries). A future migration could encrypt all labels and maintain a separate `public_labels` table for explicitly public ones.
- **Encrypted metadata search**: Techniques like searchable encryption or encrypted indexes could reduce the metadata footprint.
- **HSM integration**: Store the master key in a hardware security module instead of VPS memory.
