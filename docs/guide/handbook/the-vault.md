# The Vault

**Your data is gold. The Vault is the safe.**

Everything Mycelium knows about you lives in one place: an encrypted database on your
own device. This page explains where that is, how it's protected, and why "private" in
Mycelium isn't a promise — it's the way the thing is built.

## Where your data lives

On a Mac, your vault sits in the standard app-data location, **outside** the app
itself:

```
~/Library/Application Support/id.mycelium.app/
├── mycelium.db        ← your encrypted vault (messages, notes, people, everything)
├── kcv.json           ← a tiny check that verifies your key on unlock
└── uploads/           ← your encrypted files and attachments
```

Because it lives outside the app bundle, **updating or reinstalling the app never
touches your data**. (On Windows it's `%APPDATA%\id.mycelium.app`; on Linux,
`~/.local/share/id.mycelium.app`.)

## Encrypted, locally, always

Every sensitive thing in your vault is encrypted at rest with **AES-256-GCM** — the
same standard that protects bank transactions and government secrets. The encryption
keys are generated on your machine the first time you launch, and **they never leave
it**: not to a server, not into a log file, not over the network.

What's encrypted:

- ✅ Your message and conversation content
- ✅ Your documents and notes
- ✅ Your files and attachments
- ✅ The metadata around them
- ✅ **Even the search index and AI embeddings** — these are mathematical fingerprints
  of your text, so Mycelium treats them as just as sensitive as the text itself.

If someone copied your hard drive, opened `mycelium.db` in a database tool, and read
every row, they would find **only ciphertext** — random-looking bytes that mean
nothing without your key.

## Zero-knowledge by design

There is no Mycelium cloud holding your plaintext. There is no company server that
could be subpoenaed, breached, or persuaded to hand over your data — because **no such
server exists**. The data is on your machine, the keys are on your machine, and the
decryption happens on your machine.

This is what "zero-knowledge" means: even the people who built Mycelium know nothing
about what's in your vault. That's not a policy we could change later — it's a
consequence of the architecture.

> **The flip side:** because no one else can read your vault, no one else can recover
> it for you either. Your recovery key and your backups are the *only* way back. This
> is the deal sovereignty makes. See **[Keys & recovery](keys-and-recovery.md)**.

## Unlocked once, at startup

Mycelium doesn't ask you to "log in." When the app launches, it reads your key from
the Keychain, verifies it, and unlocks the vault in memory for that session. If the
key is wrong or missing, the app **refuses to start** rather than falling back to
something insecure. There's no browser login because there's nothing for a browser to
unlock — the key lives with the app, never on a web page.

If you want a second layer — so that even someone sitting at your unlocked Mac can't
open Mycelium — you can turn on an **app passphrase** (Settings → App Passphrase).
Then the app asks for your passphrase on every launch, and your keys are sealed behind
it instead of sitting in the Keychain.

## Fail closed, everywhere

The whole system is built to **fail safe rather than fail open**:

- Wrong key → the app won't start.
- Missing encryption key → it refuses to write rather than store plaintext.
- An import file it doesn't recognize → rejected with a safe error, never echoed back.
- Anything sensitive → kept out of logs, error messages, and anywhere it could leak.

The guiding principle, from the project's own rulebook: *"If in doubt, don't log it."*

---

→ Next: **[Data Streams](data-streams.md)** — how your context gets into the vault. ·
Or the deep dive on protection: **[Keys & recovery](keys-and-recovery.md)**.
