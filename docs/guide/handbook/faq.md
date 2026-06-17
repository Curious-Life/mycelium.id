# FAQ

Quick answers to the questions people ask most. These mirror the questions on
[mycelium.id](https://mycelium.id).

## How it works

Mycelium is a private vault for your memory that runs on your own computer. You feed it
your conversations, notes, and files; it encrypts everything with keys only you hold,
organizes it, and serves it back to any AI you connect — without ever handing your data
to that AI or to anyone else. It's not a chatbot and not a cloud service. It's the
memory that sits *behind* whatever AI you choose to use.

→ [What is Mycelium?](what-is-mycelium.md)

## How do I connect my AI?

If you use Claude (Desktop or Code), add Mycelium as an MCP server — the app gives you
the exact snippet under **Settings → Connect AI**. Restart Claude and Mycelium's tools
appear. Other AI tools that support MCP connect the same way, and many agent tools can
point their model endpoint at Mycelium to weave memory in automatically.

→ [Connect your AI](connect-your-ai.md) · [full per-tool recipes](../reference/connect.md)

## How do I talk to it?

You don't talk to Mycelium directly — you talk to your AI like normal, and it draws on
your vault automatically. Ask *"what was I working on last week?"* and it answers from
your real history. Say *"remember that I prefer concise replies"* and it sticks across
every future conversation, with any model. You can also browse your vault yourself in
the app's portal.

## What can it hold?

Conversations (import your full Claude or ChatGPT history), notes and documents, files
and images, voice notes (transcribed locally), messages from connected channels like
Telegram and Discord, and health data from Apple Health. It all becomes encrypted,
searchable memory — and, over time, a map of how you think.

→ [Data Streams](data-streams.md) · [The Resonance Engine](resonance-engine.md)

## How is my data protected?

Everything sensitive is encrypted at rest with AES-256-GCM using keys generated on your
machine that never leave it — including your search index and AI embeddings. There's no
Mycelium server holding your plaintext, so there's nothing to breach or subpoena. The
app fails closed: a wrong key means it won't even start. In short: zero-knowledge by
design, not by promise.

→ [The Vault](the-vault.md)

## Is it free?

Yes — free and open source under the AGPL-3.0 license. Download it, run it, read every
line, fork it. If it's useful to you, you can support its development, but you never
have to. No ads, no data sold, no strings.

## What if I lose my key?

Your recovery key is the only thing that can open your vault, and it can't be reset —
that's what makes the vault truly private. So save it somewhere safe (a password
manager is ideal) and make an encrypted backup once you have data worth keeping. With
your key and a backup, stored separately, you're protected against losing your machine.
Without them, a lost key means an unrecoverable vault — the unavoidable trade-off of
real zero-knowledge encryption.

→ [Keys & recovery](keys-and-recovery.md)

## Do I need to be technical?

No. Download the Mac app, create your vault, save your recovery key, import your
history, and connect your AI — all through the app. The [Reference track](../reference/)
exists for developers and agent builders, but you never need it to *use* Mycelium.

## Does an AI run on its own in the background?

No. Mycelium is a *tool server*, not an autonomous agent. It does nothing on its own —
it only responds when an AI you've connected asks it to. Nothing acts, watches, or
decides without you.

## Can other people see my vault?

No. Your vault is yours alone. The forthcoming [Shared Spaces](shared-spaces.md) will
let you *choose* to connect with others through privacy-preserving matching, but that's
always opt-in and granular — never a default, never a leak.

---

Still stuck? Open an issue on
[GitHub](https://github.com/Curious-Life/mycelium.id) or read **[How it
works](what-is-mycelium.md)**.
