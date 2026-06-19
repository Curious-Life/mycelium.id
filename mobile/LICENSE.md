# Mycelium Mobile — license (TO BE FINALIZED before App Store / TestFlight)

⚠️ **Decision required before distribution.** The repository root is **AGPL-3.0**.
Distributing AGPL software on Apple's App Store conflicts with Apple's Terms
(the VLC/GNU precedent). The intended posture (see the repo `MEMORY.md` licensing
entry and `docs/MOBILE-DEVELOPMENT-PLAN-2026-06-05.md` → "Repo & licensing") is:

- The **server + portal stay AGPL-3.0** (open source).
- This **mobile shell ships under a separate, App-Store-compatible license**
  (proprietary or a permissive/dual license) — which is permissible because this
  shell is an arm's-length HTTP client that **bundles no AGPL code** (it loads the
  AGPL portal remotely from the user's box; see `www/pair.js`) and the copyright
  is owned by Curious-Life.

**Conditions that keep this valid** (enforced in spirit by `scripts/check-config.mjs`):
1. The shell must never bundle the AGPL SvelteKit portal (remote-webview only).
2. The shell's own dependencies must be permissive (MIT/Apache/BSD) — pulling an
   (A)GPL library *into* the shell would impose copyleft on it.

**This file is a placeholder.** Replace it with the chosen license text after legal
sign-off. Do **not** submit to the App Store until that is done.
