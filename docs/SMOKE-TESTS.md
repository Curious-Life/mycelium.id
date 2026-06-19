# Manual Smoke Tests

Things that can't run in CI — they need a real tunnel, real TLS, and a real phone.
The in-process pieces are covered by `npm run verify:remote-config` (RC1-6) +
`verify:oauth`; this doc is the end-to-end **remote-connect phone test**.

---

## Remote connect — connect Claude (mobile/web) to your vault

**Goal:** call your vault's tools from the Claude app on your phone, over TLS,
gated by your operator password.

**Prereqs**
- A Cloudflare account with your domain added to it.
- `cloudflared` installed: `brew install cloudflared`.
- The app built with remote-connect Phase 1 + 2 (PRs #45 + #46).

### 1. Build + run the app with Phase 1 + 2
Merge #45 then #46 to `main`, then in the checkout you run the app from:
```bash
git pull
npm install
npm run portal:build          # builds the Settings UI (incl. Remote access panel)
cargo tauri dev               # or `cargo tauri build` for a packaged .app
```

### 2. Bring up the tunnel (stable HTTPS, SSE-capable)
```bash
scripts/tunnel.sh mycelium.YOURDOMAIN.com
```
First run opens a browser to authorize cloudflared with your Cloudflare account.
Leave it running. It prints your **Public URL** and the **Connector URL** (`…/mcp`).

### 3. App → Settings → Remote access
1. **Set operator password** (≥12 chars). This is what Claude will ask for.
2. **Public URL** = `https://mycelium.YOURDOMAIN.com` → Save.
3. **Enable remote access** (the toggle).
4. **Quit and reopen the app** (the toggle applies on launch — Phase 2 v4). The
   **"Running :4711"** badge should turn green.

### 4. Add the connector in Claude (web)
- claude.ai → **Settings → Connectors → Add custom connector**.
- URL = `https://mycelium.YOURDOMAIN.com/mcp`.
- It runs OAuth: the sign-in page shows your vault's `@handle` and asks for the
  operator password from step 3 (single-user — no email to enter) → **Approve**.
- The 31 Mycelium tools appear.

### 5. From your phone
- Open the Claude mobile app (a connector added on web/desktop is available there).
- Ask: **"Use mycelium to pull my context."** → `getContext` returns your briefing.
- Try `searchMindscape`, `listDocuments`, `createTask`.

### "Done" looks like
Tools callable from the phone; an app restart preserves the connection (secret +
base URL persisted); toggling remote OFF + restart → the connector 401s.

---

### Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| Can't authorize / blank after sign-in | Confirm the password is set (panel shows **Password set**). `trustedOrigins` already includes `claude.ai`/`claude.com`. |
| **"Not running :4711"** badge | The app didn't spawn `--http`. Confirm Enable is on (`remote.json` `remoteEnabled:true`) and you **restarted** the app. |
| Tunnel 502 | The app/`:4711` isn't up. Start the app (remote enabled) BEFORE the tunnel. |
| Tunnel 524 / stream drops | You used a **quick** tunnel (no SSE). Use `scripts/tunnel.sh` (named tunnel). |
| Connector unreachable | The server must be reachable from Anthropic IPs `160.79.104.0/21`; the Cloudflare tunnel handles this. HTTPS + a public hostname are required (no localhost). |
| Mac sleeps → drops | The local server only answers while the Mac is awake + the app is running. |

### Sovereignty note
Connecting to cloud Claude means Claude sees the **tool results** it pulls (your
data travels to Anthropic to be reasoned over). Storage stays encrypted + local;
the vault key never leaves the Keychain. For "nothing leaves," use a local model
client instead of cloud Claude.
