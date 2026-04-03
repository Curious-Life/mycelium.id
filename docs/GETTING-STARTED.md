# Getting Started with Mycelium

A step-by-step checklist for setting up your own Mycelium instance. No coding experience required — you'll use Claude Code to help you through every step.

---

## What you'll have when done

- A personal AI agent that remembers everything you tell it
- Encrypted knowledge base searchable across all your conversations
- A web portal to chat, browse your library, and explore your mind map
- Optional: Telegram/Discord bots, intelligence briefings, wealth tracking

---

## Prerequisites checklist

### 1. Computer setup

- [ ] A Mac, Windows, or Linux computer
- [ ] A terminal app (Terminal on Mac, PowerShell on Windows, or any Linux terminal)
- [ ] [VS Code](https://code.visualstudio.com/) installed (free — this is your code editor)

### 2. Accounts to create (all free or cheap)

- [ ] **GitHub account** — [github.com/signup](https://github.com/signup)
  - This is where the code lives
  - Free account is fine
  
- [ ] **Claude subscription** — [claude.ai](https://claude.ai)
  - You need Claude Pro ($20/month) or Max ($100/month)
  - This powers your AI agents
  - Sign up, then go to Settings → Billing to subscribe

- [ ] **Cloudflare account** — [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
  - Free account covers everything you need
  - This hosts your database, search engine, and file storage

- [ ] **VPS (Virtual Private Server)** — your agent's home
  - Recommended: [Hetzner](https://www.hetzner.com/cloud/) CX22 (~$5-8/month) or [DigitalOcean](https://www.digitalocean.com/) Basic Droplet ($6/month)
  - Choose: **Ubuntu 24.04**, **4GB RAM**, **2 CPU cores**
  - You'll get an IP address and root password after creation

### 3. Optional accounts (add later)

- [ ] **Domain name** — any registrar (Cloudflare, Namecheap, etc.). ~$10/year. Gives you a nice URL like `agents.yourdomain.com` instead of an IP address.
- [ ] **Telegram** — for chatting with your agent from your phone. Free.
- [ ] **Discord** — for multi-agent team channels. Free.

---

## Setup steps

### Step 1: Install Claude Code

Claude Code is the AI assistant that will help you set up everything.

Open your terminal and run:
```bash
npm install -g @anthropic-ai/claude-code
```

If you don't have npm, install Node.js first: [nodejs.org](https://nodejs.org/) (LTS version).

Then authenticate:
```bash
claude auth login
```

This opens a browser window. Log in with your Claude account.

### Step 2: Clone the repository

```bash
git clone https://github.com/Curious-Life/mycelium.id.git
cd mycelium.id
npm install
```

### Step 3: Let Claude Code guide you

From inside the `mycelium.id` directory, start Claude Code:
```bash
claude
```

Then tell it:
```
I want to set up Mycelium on my VPS. Here's what I have:
- VPS IP: [your IP]
- Cloudflare account: [your email]
- I want a personal agent to start

Help me run the install script and get everything working.
```

Claude Code will walk you through the rest interactively.

### Step 4: Run the install script

If you prefer to do it yourself, SSH into your VPS and run:
```bash
ssh root@[your-vps-ip]
```

Then:
```bash
curl -sL https://raw.githubusercontent.com/Curious-Life/mycelium.id/main/scripts/install.sh | bash
```

The script will:
1. Install all system dependencies (Node.js, PM2, Caddy, Claude CLI)
2. Ask for your Cloudflare API token
3. Create your database, search indexes, and file storage
4. Ask you to authenticate Claude (opens a browser URL)
5. Ask for your domain (optional)
6. Ask about Telegram/Discord (optional)
7. Generate all config files
8. Build the web portal
9. Start your personal agent

### Step 5: Open your portal

After the script finishes, open your browser:
- With domain: `https://agents.yourdomain.com`
- Without domain: `http://[your-vps-ip]:5173`

Register a passkey (passwordless login) on first visit. You're in.

---

## What each service costs

| Service | Cost | What it does |
|---------|------|-------------|
| Claude Pro | $20/month | Powers your AI agents |
| VPS (Hetzner CX22) | $5-8/month | Runs the agent server 24/7 |
| Cloudflare | Free | Database, search, file storage, encryption |
| Domain (optional) | ~$10/year | Nice URL for your portal |
| **Total** | **$25-28/month** | |

---

## After setup

### Talk to your agent

- **Web portal**: Open your portal URL and use the chat widget
- **Telegram** (if configured): Message your bot from your phone
- **Discord** (if configured): Message in your agent's channel

### Add more agents

Create a new config file:
```bash
cp agents/_template.json agents/my-new-agent.json
# Edit the file with your agent's name, role, and port
```

Write a system prompt:
```bash
mkdir -p ~/agents/my-new-agent/prompts
nano ~/agents/my-new-agent/prompts/system.md
```

Start it:
```bash
pm2 start ecosystem.config.cjs --only my-new-agent
```

### Import your data

The portal has an Import page where you can upload:
- ChatGPT conversation exports
- Claude conversation exports  
- Obsidian vaults
- LinkedIn data exports
- Voice recordings and transcriptions

### Update

```bash
cd ~/mycelium
git pull
npm install
pm2 restart all
```

### Troubleshoot

```bash
# Check if agents are running
pm2 ls

# View logs
pm2 logs personal-agent

# Re-authenticate Claude (tokens expire weekly)
claude auth login

# Check agent health
curl http://localhost:3004/health
```

---

## Architecture (what's running)

```
Your VPS
  ├── Personal Agent (port 3004)    — your main AI companion
  ├── Web Portal (port 5173)        — browser interface
  ├── Caddy                         — HTTPS reverse proxy
  └── PM2                           — keeps everything running

Cloudflare (managed for you)
  ├── D1 Database                   — your encrypted messages & documents
  ├── Vectorize                     — semantic search indexes
  ├── R2                            — file storage
  └── Worker                        — API gateway with encryption
```

---

## Native apps (optional)

- **[iOS](https://github.com/Curious-Life/mycelium-ios-app)** — chat with agents, browse library, track health & screen time, transcribe voice
- **[macOS](https://github.com/Curious-Life/mycelium-macos)** — record and transcribe calls, track activity, voice notes, agent chat

Both connect to your Mycelium server. Configure the server URL in the app settings.

---

## Getting help

- Open an issue on [GitHub](https://github.com/Curious-Life/mycelium.id/issues)
- Or ask Claude Code — it knows the entire codebase
