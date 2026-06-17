# Connect your AI

Mycelium isn't an AI — it's the memory *behind* your AI. Connecting one is what turns
a clever assistant into one that actually knows you.

> **Bringing your own model?** This page is the friendly overview. For exact,
> copy-paste setup for every client and harness, jump to the Reference track:
> **[Connect an agent](../reference/connect.md)**.

## The idea: one membrane, two doors

Mycelium offers your AI two things through a single connection:

- **Memory** — your AI can read and write your vault (recall a fact, search your past,
  save a new note) over the open **Model Context Protocol (MCP)**.
- **Model** *(optional)* — you can also route the AI's *thinking* through Mycelium, so
  every conversation is private by default, audited, and sent only to providers you
  approve.

Most people start with memory. That alone is the magic moment.

## Connecting Claude

Claude is the smoothest path, because it speaks MCP natively.

- **Claude Desktop / Claude Code** — add Mycelium as an MCP server (the app's
  **Settings → Connect AI** screen gives you the exact snippet to paste). Restart
  Claude, and Mycelium's tools appear. From then on, Claude is oriented by your vault
  automatically at the start of each conversation.
- **Claude on the web / mobile** *(remote)* — connect over a secure tunnel to your own
  machine. See [remote access](../reference/connect.md#reach-your-box-from-the-internet).

You don't have to do anything special after that. Just chat. Claude pulls context when
it helps, and can save things you ask it to remember.

## Connecting ChatGPT and other AIs

Any AI tool that supports MCP can connect the same way. For tools that don't speak MCP
but *do* let you set a custom model endpoint (many coding assistants and agent
"harnesses" — opencode, Cline, Continue, Goose, and others), Mycelium can act as that
endpoint and weave your memory in automatically.

The Reference track has a ready-made recipe for each:
**[Connect an agent](../reference/connect.md)**.

## What your AI can do once connected

With Mycelium connected, your AI can:

- **Orient itself** — at the start of a conversation it knows the date, what's on your
  mind lately, who and what you've been working with, and how you like to be talked to.
- **Recall** — search across everything you've ever fed it, by meaning, not just
  keywords.
- **Remember** — save durable facts ("I'm vegetarian"), people, and projects that
  persist across every future chat, with any model.
- **Work with your documents** — read, write, and revise notes in your library.
- **See your patterns** — once your mindscape is built, ask about your cognitive
  rhythms and the themes running through your thinking.

## What stays private

Connecting an AI **does not** hand it a copy of your vault. The AI asks specific
questions ("search for X", "what facts do you have about Y") and gets specific
answers, the same way you might ask a librarian rather than handing over the whole
library. And anything you mark **sensitive** is kept out of the picture entirely —
never surfaced proactively, never published.

If you route *inference* through Mycelium too, you get extra controls: pick which
providers (and which countries) your thoughts may be sent to, mark a single message as
sensitive to force it onto a local model, and get a tamper-evident log of every
outbound call — recorded as a hash, never the content.

→ Full controls: **[Model gateway & embeddings](../reference/gateway-and-embeddings.md)**.

---

→ Next: **[Data Streams](data-streams.md)** — feed it more · Or
**[The Resonance Engine](resonance-engine.md)** — see what it finds.
