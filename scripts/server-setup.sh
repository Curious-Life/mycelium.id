#!/usr/bin/env bash
set -euo pipefail

# server-setup.sh — Fresh VPS setup for Mycelium Agent Framework
#
# Run as root on a fresh Ubuntu 24.04 VPS:
#   curl -fsSL https://raw.githubusercontent.com/your-org/mycelium/main/scripts/server-setup.sh | bash
#   — or —
#   bash scripts/server-setup.sh
#
# What this script does:
#   1. Creates 'claude' user with sudo + SSH access
#   2. Installs Node.js 22, PM2, Claude CLI, Caddy
#   3. Configures UFW firewall (SSH + HTTP/S only)
#   4. Sets up log directories
#   5. Clones the repo and installs dependencies

REPO_URL="https://github.com/your-org/mycelium.git"
INSTALL_DIR="/home/claude/mycelium"
LOG_DIR="/var/log/mycelium"
USERNAME="claude"

echo "═══════════════════════════════════════════════════════"
echo "  Mycelium — Server Setup"
echo "═══════════════════════════════════════════════════════"
echo ""

# Must run as root
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root."
  echo "Usage: sudo bash scripts/server-setup.sh"
  exit 1
fi

# ── Phase 1: Create user ────────────────────────────────────

echo "→ Phase 1: Creating '${USERNAME}' user..."

if id "$USERNAME" &>/dev/null; then
  echo "  User '${USERNAME}' already exists, skipping."
else
  adduser --disabled-password --gecos "Mycelium Agent Runner" "$USERNAME"
  usermod -aG sudo "$USERNAME"
  # Allow passwordless sudo for specific service management commands only
  echo "${USERNAME} ALL=(ALL) NOPASSWD: /usr/bin/pm2, /usr/bin/caddy, /bin/systemctl restart caddy, /bin/systemctl reload caddy, /bin/systemctl status caddy" > /etc/sudoers.d/${USERNAME}
  chmod 0440 /etc/sudoers.d/${USERNAME}
  echo "  ✓ User '${USERNAME}' created with sudo access."
fi

# Copy SSH keys from root to claude user
if [[ -f /root/.ssh/authorized_keys ]]; then
  mkdir -p /home/${USERNAME}/.ssh
  cp /root/.ssh/authorized_keys /home/${USERNAME}/.ssh/authorized_keys
  chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.ssh
  chmod 700 /home/${USERNAME}/.ssh
  chmod 600 /home/${USERNAME}/.ssh/authorized_keys
  echo "  ✓ SSH keys copied to '${USERNAME}' user."
fi
echo ""

# ── Phase 1b: tmpfs for master key (RAM-only, lost on reboot) ───
# The master encryption key is stored in /run/mycelium/master.key on tmpfs.
# This means it's never on disk — disk theft, rescue mode, .env leaks all
# fail to find the key. Trade-off: reboots require re-keying.

echo "→ Phase 1b: Setting up tmpfs for master key..."
mkdir -p /run/mycelium
chown claude:claude /run/mycelium 2>/dev/null || true
chmod 700 /run/mycelium

if ! grep -q '/run/mycelium' /etc/fstab; then
  echo 'tmpfs /run/mycelium tmpfs size=1M,mode=0700,uid=claude,gid=claude,noexec,nosuid,nodev 0 0' >> /etc/fstab
fi

# Mount now (idempotent)
if ! mountpoint -q /run/mycelium; then
  mount /run/mycelium 2>/dev/null || mount -t tmpfs -o size=1M,mode=0700,uid=claude,gid=claude,noexec,nosuid,nodev tmpfs /run/mycelium
fi
echo "  ✓ tmpfs mounted at /run/mycelium (1MB, RAM-only)"
echo ""

# ── Phase 1b2: /etc/mycelium for VPS identity public keys ──
echo "→ Phase 1b2: Creating /etc/mycelium for identity public keys..."
mkdir -p /etc/mycelium
chown root:claude /etc/mycelium 2>/dev/null || true
chmod 750 /etc/mycelium
echo "  ✓ /etc/mycelium created (public keys only)"
echo ""

# ── Phase 1c: Encrypted swap (random key per boot) ──────────
# Random key generated at boot from /dev/urandom — never persisted.
# After reboot, swap pages from previous boots become unreadable.

echo "→ Phase 1c: Setting up encrypted swap..."
SWAPFILE="/swapfile"

# Disable any existing swap
swapoff -a 2>/dev/null || true
sed -i '/swap/d' /etc/fstab 2>/dev/null || true

# Create the swap backing file (4GB)
if [ ! -f "$SWAPFILE" ]; then
  fallocate -l 4G "$SWAPFILE"
  chmod 600 "$SWAPFILE"
  echo "  ✓ 4GB swap file created"
fi

# systemd unit to encrypt+enable swap at boot
cat > /etc/systemd/system/encrypted-swap.service <<'SWAPEOF'
[Unit]
Description=Encrypted swap with random per-boot key
After=local-fs.target cryptsetup.target
Before=swap.target
ConditionPathExists=/swapfile

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'cryptsetup open --type plain --key-file /dev/urandom --key-size 256 /swapfile swap_crypt && mkswap /dev/mapper/swap_crypt && swapon /dev/mapper/swap_crypt'
ExecStop=/bin/bash -c 'swapoff /dev/mapper/swap_crypt && cryptsetup close swap_crypt'

[Install]
WantedBy=swap.target
SWAPEOF

systemctl daemon-reload 2>/dev/null || true
systemctl enable encrypted-swap.service 2>/dev/null || true

# Activate now (idempotent — may fail if already active)
systemctl start encrypted-swap.service 2>/dev/null || true

# Tune swappiness — prefer RAM
if ! grep -q 'vm.swappiness' /etc/sysctl.conf 2>/dev/null; then
  echo "vm.swappiness=10" >> /etc/sysctl.conf
fi
sysctl -p 2>/dev/null || true
echo "  ✓ Encrypted swap enabled (random key per boot, swappiness=10)"
echo ""

# ── Phase 1d: Memory protection sysctls ────────────────────
# Disable core dumps, restrict ptrace, prevent suid dumps.

echo "→ Phase 1d: Hardening kernel for memory protection..."

# Per-user limits — no core dumps
if ! grep -q 'hard core 0' /etc/security/limits.conf 2>/dev/null; then
  echo '* hard core 0' >> /etc/security/limits.conf
  echo '* soft core 0' >> /etc/security/limits.conf
fi

# Sysctls
cat > /etc/sysctl.d/99-mycelium-security.conf <<'SYSCTLEOF'
# Mycelium security hardening — prevents memory extraction attacks
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
kernel.yama.ptrace_scope=1
SYSCTLEOF

sysctl -p /etc/sysctl.d/99-mycelium-security.conf 2>/dev/null || true
echo "  ✓ Core dumps disabled, ptrace restricted, suid dumps blocked"
echo ""

# ── Phase 1e: PM2 dump scrub cron ──────────────────────────
# Belt-and-suspenders against PM2 writing secrets to ~/.pm2/dump.pm2

echo "→ Phase 1e: Installing PM2 dump scrub cron..."

cat > /usr/local/bin/scrub-pm2-dump.sh <<'SCRUBEOF'
#!/bin/bash
# Scrub sensitive env vars from PM2 dump file (belt-and-suspenders for filter_env)
DUMP=/home/claude/.pm2/dump.pm2
[ -f "$DUMP" ] || exit 0
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

jq 'walk(if type=="object" and .env then .env |= del(
  .ENCRYPTION_MASTER_KEY, .ADMIN_SECRET, .MYA_WORKER_SECRET,
  .CLOUDFLARE_AI_TOKEN, .CLOUDFLARE_API_TOKEN, .HETZNER_API_TOKEN,
  .CDP_API_KEY_SECRET, .CDP_WALLET_SECRET,
  .GOOGLE_CLIENT_SECRET, .GITHUB_CLIENT_SECRET,
  .POLYMARKET_API_PASSWORD, .STRIPE_SECRET_KEY, .RESEND_API_KEY
) else . end)' "$DUMP" > "$TMP" && mv "$TMP" "$DUMP"
SCRUBEOF
chmod +x /usr/local/bin/scrub-pm2-dump.sh

# Hourly cron with flock to prevent races with PM2 writes
cat > /etc/cron.d/scrub-pm2-dump <<'CRONEOF'
# Hourly scrub of PM2 dump file. flock prevents race when PM2 writes mid-scrub.
0 * * * * claude flock -n /tmp/pm2-scrub.lock /usr/local/bin/scrub-pm2-dump.sh >/dev/null 2>&1
CRONEOF
chmod 644 /etc/cron.d/scrub-pm2-dump

echo "  ✓ PM2 dump scrub cron installed (hourly)"
echo ""

# ── Phase 1c: Local AI Models (tagging + embedding) ────────
# llama-server for message tagging (Qwen2.5-3B)
# BGE-M3 ONNX model downloaded on first use by huggingface_hub

echo "→ Phase 1c: Setting up local AI inference..."
LLAMA_SERVER="/usr/local/bin/llama-server"
MODEL_DIR="/opt/models"
QWEN_MODEL="${MODEL_DIR}/qwen2.5-3b-instruct-q4_k_m.gguf"

if [ ! -f "$LLAMA_SERVER" ]; then
  echo "  Installing llama-server..."
  # Get latest llama.cpp release for linux x64
  LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-server-linux-x64"
  wget -q -O "$LLAMA_SERVER" "$LLAMA_URL" 2>/dev/null || curl -sL "$LLAMA_URL" -o "$LLAMA_SERVER"
  chmod +x "$LLAMA_SERVER"
  echo "  ✓ llama-server installed"
else
  echo "  llama-server already installed"
fi

mkdir -p "$MODEL_DIR"
if [ ! -f "$QWEN_MODEL" ]; then
  echo "  Downloading Qwen2.5-3B-Instruct Q4_K_M (~2.1GB)..."
  QWEN_URL="https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
  wget -q --show-progress -O "$QWEN_MODEL" "$QWEN_URL" 2>/dev/null || curl -L "$QWEN_URL" -o "$QWEN_MODEL"
  echo "  ✓ Qwen model downloaded"
else
  echo "  Qwen model already present"
fi

echo "  ✓ Local AI models ready (BGE-M3 ONNX downloads on first use)"
echo ""

# ── Phase 2: System packages ────────────────────────────────

echo "→ Phase 2: Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  git curl wget build-essential \
  ufw fail2ban \
  unzip jq htop \
  > /dev/null 2>&1
echo "  ✓ System packages installed."
echo ""

# ── Phase 3: Node.js 22 ─────────────────────────────────────

echo "→ Phase 3: Installing Node.js 22..."
if command -v node &>/dev/null && [[ "$(node --version)" == v22* ]]; then
  echo "  Node.js $(node --version) already installed, skipping."
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
  echo "  ✓ Node.js $(node --version) installed."
fi
echo ""

# ── Phase 4: PM2 + Claude CLI ───────────────────────────────

echo "→ Phase 4: Installing global npm packages..."
npm install -g pm2@latest > /dev/null 2>&1
echo "  ✓ PM2 $(pm2 --version) installed."

npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
echo "  ✓ Claude CLI $(claude --version 2>/dev/null || echo 'installed') installed."
echo ""

# ── Phase 5: Caddy (reverse proxy) ──────────────────────────

echo "→ Phase 5: Installing Caddy..."
if command -v caddy &>/dev/null; then
  echo "  Caddy already installed, skipping."
else
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https > /dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq > /dev/null 2>&1
  apt-get install -y -qq caddy > /dev/null 2>&1
  echo "  ✓ Caddy installed."
fi
echo ""

# ── Phase 6: Firewall ───────────────────────────────────────

echo "→ Phase 6: Configuring firewall..."
ufw --force reset > /dev/null 2>&1
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow ssh > /dev/null 2>&1
ufw allow 80/tcp > /dev/null 2>&1
ufw allow 443/tcp > /dev/null 2>&1
ufw --force enable > /dev/null 2>&1
echo "  ✓ UFW enabled: SSH (22), HTTP (80), HTTPS (443) allowed."
echo ""

# ── Phase 7: SSH hardening ──────────────────────────────────

echo "→ Phase 7: Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
# Disable password auth (key-only)
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null
echo "  ✓ SSH hardened: password auth disabled, root login key-only."
echo ""

# ── Phase 8: Log directory ──────────────────────────────────

echo "→ Phase 8: Setting up log directory..."
mkdir -p "$LOG_DIR"
chown ${USERNAME}:${USERNAME} "$LOG_DIR"
echo "  ✓ Log directory created at ${LOG_DIR}"
echo ""

# ── Phase 8b: File Integrity Monitoring (AIDE) ────────────────

echo "→ Phase 8b: Setting up AIDE file integrity monitoring..."
if command -v aide &>/dev/null; then
  echo "  AIDE already installed."
else
  apt-get install -y aide aide-common 2>/dev/null || echo "  AIDE install skipped (not available on this OS)"
fi
if command -v aide &>/dev/null; then
  mkdir -p /etc/aide/aide.conf.d
  cat > /etc/aide/aide.conf.d/mycelium.conf <<'AIDEEOF'
/home/claude/mycelium/agent-server.js Full
/home/claude/mycelium/lib Full
/home/claude/mycelium/ecosystem.config.cjs Full
/home/claude/mycelium/package.json Full
/etc/caddy Full
!/home/claude/mycelium/node_modules
!/home/claude/mycelium/.git
!/home/claude/mycelium/portal/node_modules
AIDEEOF
  echo "  ✓ AIDE configured. Run 'aide --init' after deployment to initialize baseline."
fi
echo ""

# ── Phase 9: Clone repo & install deps ──────────────────────

if [[ "${SKIP_REPO:-0}" = "1" ]]; then
  echo "→ Phase 9: Skipping repo clone (SKIP_REPO=1)"
else
  echo "→ Phase 9: Cloning repository..."
  if [[ -d "$INSTALL_DIR" ]]; then
    echo "  Directory ${INSTALL_DIR} already exists, pulling latest..."
    su - ${USERNAME} -c "cd ${INSTALL_DIR} && git pull --ff-only"
  else
    su - ${USERNAME} -c "git clone ${REPO_URL} ${INSTALL_DIR}"
    echo "  ✓ Repository cloned to ${INSTALL_DIR}"
  fi
  echo ""

  echo "→ Installing npm dependencies..."
  su - ${USERNAME} -c "cd ${INSTALL_DIR} && npm install"
  echo ""

  echo "→ Building portal..."
  su - ${USERNAME} -c "cd ${INSTALL_DIR}/portal && npm install && npm run build"
  echo ""
fi

# ── Phase 10: PM2 startup ───────────────────────────────────

echo "→ Phase 10: Configuring PM2 startup..."
# Generate startup script as claude user, then execute as root
env PATH=$PATH:/usr/bin pm2 startup systemd -u ${USERNAME} --hp /home/${USERNAME} > /dev/null 2>&1
echo "  ✓ PM2 configured to start on boot."
echo ""

# ── Summary ──────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════"
echo "  ✓ Server setup complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Installed:"
echo "    Node.js:    $(node --version)"
echo "    npm:        $(npm --version)"
echo "    PM2:        $(pm2 --version)"
echo "    Claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
echo "    Caddy:      $(caddy version 2>/dev/null || echo 'installed')"
echo ""
echo "  Next steps:"
echo "    1. Switch to claude user:  su - claude"
echo "    2. Configure environment:  cd ~/mycelium && cp .env.example .env && nano .env"
echo "    3. Authenticate Claude:    claude auth login"
echo "    4. Configure Caddy:        sudo nano /etc/caddy/Caddyfile"
echo "    5. Start services:         cd ~/mycelium && pm2 start ecosystem.config.cjs"
echo "    6. Save PM2 state:         pm2 save"
echo ""
