# Bring your data in

Mycelium grows from what you give it. You can bring your conversations, notes,
documents, photos, and more — and everything is **encrypted on import**, on your
own machine. Nothing leaves your control.

There are three ways data comes in:

- **Upload now** — drop a file or a folder; it imports immediately.
- **Connect** — link a live account (e.g. Telegram, Gmail) that keeps syncing.
- **Coming soon** — planned sources; we show how to prepare in the meantime.

You'll find the same catalog in **onboarding → "Bring your data in"** and under
**Streams → Sources**. Click any source there for the quick how-to; this page has
the full detail.

---

## Upload now

### Claude
Your Claude.ai conversations, projects, and memories.
1. Go to **claude.ai → Settings → Account → Export data**.
2. You'll get a `.zip` by email. Drop it into Mycelium.
Duplicates are skipped automatically; original timestamps are preserved.

### ChatGPT
Your full ChatGPT history.
1. **ChatGPT → Settings → Data controls → Export data**.
2. Download the `.zip` (or just `conversations.json`) and drop it in.
Conversation trees are flattened to a clean timeline, deduplicated.

### Obsidian
Your whole vault — every note becomes a searchable document, and its links and
images come along.
- Choose your **vault folder** (the folder picker opens in the app). No export
  needed; `.md` notes and embedded media import directly.

### Documents
PDFs, Word documents, Markdown, and plain text.
- Drop `.pdf` / `.docx` / `.md` / `.txt` — each becomes a readable, searchable
  document with its original file date.

### Notes
Loose notes and journals.
- Drop `.md` or `.txt` files, or a whole folder of them.

### Photos
Images you want your mind to remember.
- Drop image files; a **local** vision model captions them privately on your
  device (no cloud).

### Audio
Voice notes and recordings.
- Drop `.mp3` / `.m4a` / `.wav` / `.ogg` — stored encrypted and findable.

### Mycelium vault
Bring a whole vault home from another Mycelium.
- Export from the other vault (**Settings → Export**) and drop the `.zip`.
  Everything — messages, documents, media, people, mindscape — is re-encrypted
  under this device's key. You get a full reconciliation report.

---

## Connect (live sync)

### Telegram
Talk to your mind from Telegram, and keep messages flowing in.
- **Settings → Channels** → add a bot token from [@BotFather](https://t.me/BotFather).

### Email (Gmail)
Your inbox, synced into your mind.
- **Settings → Connectors** → connect Gmail (OAuth).

---

## Coming soon

We surface these so you know they're on the way — and how to prepare today.

- **WhatsApp** — chat-export (`.zip`) parsing is coming. Meanwhile, export a chat
  as `.txt` and drop it as a document.
- **Google Drive** — a Drive connector is planned. Meanwhile, download the files
  you want and drop them in.
- **Claude Code** — direct session-transcript import is coming. (Live sessions are
  captured automatically when you enable agent capture.)
- **Grok** — export support is planned. Meanwhile, save a conversation as text and
  drop it.
- **LinkedIn** — export parsing is coming. The export is recognized but not yet
  ingested.

---

## A note on privacy

Every import is encrypted at rest with your vault key. Image captioning and text
extraction run **locally**. If a file can't be read, Mycelium tells you — it never
silently drops your data.
