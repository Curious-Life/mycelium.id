# Keys & recovery

Your vault is protected by encryption that only *you* can undo. This page explains the
recovery key, how it survives app updates and new machines, and how to make sure you
never lose your data.

> **The one rule:** save your recovery key somewhere safe, and make a backup once you
> have data worth keeping. Do those two things and you're covered for life.

## The recovery key

When you first create your vault, Mycelium generates **one recovery key** — a
64-character code — and shows it to you once.

- It's stored in your **macOS Keychain**, so day to day the app just opens and you
  never think about it.
- It is the **only** thing that can open your vault on another computer. It cannot be
  reset, and no one — not even the people who built Mycelium — can recover it for you.

> Behind the scenes the vault uses two internal keys, but the second is derived
> mathematically from the first. So there is exactly **one secret you ever need to
> save**: your recovery key.

**Where to keep it:** a password manager is ideal. A printed copy in a safe drawer is
a great backup. Don't keep your only copy on the same Mac as the vault — that defeats
the purpose.

**Re-view it any time:** Settings → Recovery Key → Show recovery key. You can copy or
re-download it whenever you want.

## How it survives app updates

Two things live *outside* the app:

- Your **vault** sits in your system's app-data folder, not inside the app bundle.
- Your **key** lives in the macOS Keychain, not inside the app bundle.

So updating, reinstalling, or even deleting and re-downloading the Mycelium app
**never touches your data or your key**. The app is just a window onto a vault that
lives independently.

## Recovering on a new (or wiped) machine

There are two distinct situations, and they need different things:

### Same data, new key access

If your vault files are present but the Keychain was cleared (you migrated accounts,
say), just open Mycelium → **Restore** → paste your recovery key. If a vault is
there, Mycelium verifies the key against it before opening — a wrong key is rejected
before anything is touched.

### New machine, no data

This is the important one. **Your recovery key only decrypts data that already exists
on the machine** — it is *not* a cloud download. If your Mac is lost or wiped and you
have no backup, the key alone cannot bring your vault back, because the encrypted data
is gone with the disk.

That's why backups matter. 👇

## Backups — your real safety net

Make an encrypted backup once you have data worth keeping:

**Settings → Security → Vault Backup → Back up now.**

This produces a `mycelium-vault-<date>.myvault` file — a complete, consistent snapshot
of your encrypted database and files. It's **ciphertext**: useless to anyone without
your recovery key. Keep it on an external drive or in your own cloud storage.

**To restore on a new device:** on the first-run screen, choose **Restore from a
backup**, pick your `.myvault` file, then paste your recovery key. The key is verified
against the restored vault before anything opens.

> **Keep the two things separately.** A backup file *and* your recovery key together
> are the complete recovery path. The backup without the key is unreadable; the key
> without the backup (on a wiped machine) has nothing to decrypt. Store them in
> different places and you're safe against any single loss.

## Optional: lock the app with a passphrase

By default the vault opens automatically using the key in your Keychain — no prompt.
If you want a second factor — so that even someone at your unlocked, logged-in Mac
can't open Mycelium — turn on an **app passphrase** in Settings → App Passphrase.

When enabled:

- Your key leaves the Keychain and is **sealed behind your passphrase** instead. At
  rest, the key exists only inside that sealed file.
- The app asks for your passphrase on every launch.
- **Forgot the passphrase?** Your recovery key still works — choose "Use your recovery
  key" on the unlock screen. The passphrase is a *lock*, not a second secret to lose;
  losing it never loses your vault.

A passphrase is brute-forceable if someone steals the sealed file off your disk, so
pick a strong one (longer is better), and keep your disk encrypted with FileVault as
your first line of defense.

## What happens if I lose my key?

Plainly: if you lose your recovery key **and** have no backup that you can still
decrypt, your vault is unrecoverable. This isn't a gap we can patch — it's the direct
consequence of true zero-knowledge encryption. No one holds a copy of your key, so no
one can let you back in.

This is the deal sovereignty makes, and it's why the app nudges you to save your key
and make a backup right at the start. Do both, store them separately, and you have
nothing to fear.

---

→ Back to **[The Vault](the-vault.md)** · or the quick answers in the **[FAQ](faq.md)**.
