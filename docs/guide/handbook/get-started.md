# Get started

Grow your own mycelium. This takes about five minutes.

## 1. Download the app

Mycelium is a native Mac app — Apple Silicon & Intel.

- **[Download for Mac](https://mycelium.id)** — the `.dmg` from the website.
- **iOS** — your vault in your pocket, available on the App Store.

Open the `.dmg` and drag Mycelium to your Applications folder, then launch it.

> **No Mac?** Mycelium is open source and runs anywhere Node.js does. See
> [Run & configure](../reference/configure.md) in the Reference track to run it from
> source on Linux or Windows.

## 2. Create your vault

The first time you open Mycelium, it sets up your private vault. There's **no account
to create** and **no login** — the vault lives on your machine, so there's nothing for
a website to log into.

You'll be shown **one recovery key**: a 64-character code. This is the single most
important thing in Mycelium.

```
Your recovery key is the only thing that can open your vault.
We cannot reset it. We never see it. Save it somewhere safe.
```

- Mycelium stores it in your **macOS Keychain** so day-to-day you never think about
  it — the app just opens.
- **Save a copy somewhere safe too** — a password manager, a printout in a drawer. If
  your Mac is ever lost or wiped, this key is what brings your vault back.

Click **Download** to save it as `mycelium-recovery-key.txt`, confirm you've stored
it, and you're in.

→ Everything about keys, backups, and recovery: **[Keys & recovery](keys-and-recovery.md)**.

## 3. Bring your data home

A fresh vault is empty. The fastest way to make Mycelium *yours* is to import the
history you already have.

- **Import a chat export.** Export your conversations from Claude or ChatGPT (both
  offer a "download your data" option), then drag the `.zip` onto Mycelium's **Import**
  screen. Mycelium detects the format, decrypts nothing it doesn't need to, encrypts
  everything it stores, and quietly indexes it all in the background.
- **Add documents and notes.** Drop in files — text, Markdown, PDFs, images, even
  voice notes — and they become part of your searchable memory.
- **Connect a channel** *(optional)*. Wire up Telegram, Discord, or WhatsApp so
  messages flow in as you go.

→ More on what flows in and how: **[Data Streams](data-streams.md)**.

## 4. Connect your AI

This is the moment Mycelium comes alive. Point your AI at your vault and it suddenly
has a memory of you — your projects, your people, your past.

The app walks you through it in **Settings → Connect AI**. For the full picture of
every client and harness, see **[Connect your AI](connect-your-ai.md)**.

## 5. Talk to it

Once connected, you don't "use Mycelium" directly — you just talk to your AI like
normal, and it draws on your vault automatically.

- Ask Claude *"what was I working through last week?"* and it pulls from your actual
  history.
- Tell it *"remember that I prefer short replies"* and that sticks — across every
  future conversation, with any model.
- Ask *"who have I mentioned working with on the festival project?"* and it answers
  from your real relationships.

Behind the scenes, your AI calls Mycelium's tools to read and write your vault. You
never have to think about it — you just have an AI that finally remembers.

## 6. Make a backup

Your recovery key decrypts data that's *already on your Mac* — it isn't a cloud
restore. So once you've got data worth keeping, make an encrypted backup:

**Settings → Security → Vault Backup → Back up now.** This saves a `.myvault` file —
useless to anyone without your recovery key — that you can keep on an external drive
or your own cloud storage. Keep it and your recovery key, separately.

---

That's it. You have a private, portable, encrypted memory that any AI can use and no
one else can read.

→ Next: **[Connect your AI](connect-your-ai.md)** · or understand **[The Vault](the-vault.md)**
